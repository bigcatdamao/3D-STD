// 检查运行器(T14)—— Worker 生命周期与超时的状态机。与 ImportQueue 同构:
// Worker 生成器可注入,纯逻辑接受单元测试;真实 Worker 只在浏览器侧装配(check-state)。
//
// 关键语义:
// · 一次只跑一轮(重复触发 = 忽略;UI 侧按钮在 running 态禁用);
// · Worker 常驻复用 —— 资产几何只在首次需要时传输,之后靠 Worker 侧缓存(CHK-04 跨轮复用);
// · 30s 超时(CHECK_TIMEOUT_MS,可注入):terminate Worker、保留已流回的部分结果,
//   未检实例列入 unfinished,按对象重试(CHK-02「按未完成呈现」/ 边界 5「分对象重试,不假装成功」);
// · 超时后 Worker 缓存随实例销毁 —— sentAssets 同步清空,重试轮自动重传所需几何。

import {
  CHECK_TIMEOUT_MS,
  type AssetAnalysisMeta,
  type CheckIssue,
  type CheckReply,
  type CheckRunMsg,
  type CheckSummary,
  type InstanceInput,
} from './check-core';
import type { BedConfig } from '../state/store';

export interface CheckWorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: CheckReply }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SpawnCheckWorker = () => CheckWorkerLike;

/** 资产几何提供器:仅对 Worker 侧未缓存的资产取数(主线程从 geometryRegistry 拷贝) */
export type AssetGeometrySource = (assetId: string) => {
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
} | null;

export interface RunEvents {
  onProgress: (done: number, total: number, phase: string) => void;
  onAsset: (meta: AssetAnalysisMeta, boundarySegments: ArrayBuffer | null) => void;
  onIssues: (issues: CheckIssue[]) => void; // 逐实例流式(超时保留已完成部分)
  onDone: (r: {
    summary: CheckSummary | null; // null = 超时(无汇总,按部分结果呈现)
    unfinished: { id: string; name: string }[];
    timedOut: boolean;
  }) => void;
}

let runSeq = 0;

export class CheckRunner {
  private worker: CheckWorkerLike | null = null;
  private sentAssets = new Set<string>(); // 当前 Worker 实例已持有几何的资产
  private active: {
    runId: string;
    timer: ReturnType<typeof setTimeout>;
    pending: Map<string, string>; // 尚未流回结果的实例 id → name
    events: RunEvents;
  } | null = null;

  constructor(
    private spawn: SpawnCheckWorker,
    private timeoutMs = CHECK_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  /** 发起一轮检查。instances 为本轮范围(全量或重试子集);返回 false = 已有进行中的轮次 */
  run(
    bed: BedConfig,
    instances: InstanceInput[],
    geometryOf: AssetGeometrySource,
    events: RunEvents,
  ): boolean {
    if (this.active) return false;
    const runId = `chk_${(++runSeq).toString(36)}`;

    if (!this.worker) {
      this.worker = this.spawn();
      this.sentAssets.clear();
      this.worker.onmessage = (ev) => this.onReply(ev.data);
      this.worker.onerror = () => this.finish(null, true); // Worker 崩溃按超时同路径收口:保留部分结果
    }

    // 资产装配:Worker 已缓存 → 只报 id;未缓存 → 附几何(Transferable)
    const assetIds = [...new Set(instances.map((i) => i.assetId))];
    const assets: CheckRunMsg['assets'] = [];
    const transfer: Transferable[] = [];
    const skipped = new Set<string>(); // 几何缺失的资产(失效/失败态):其实例不参与本轮
    for (const id of assetIds) {
      if (this.sentAssets.has(id)) {
        assets.push({ assetId: id, positions: null, index: null });
        continue;
      }
      const g = geometryOf(id);
      if (!g) {
        skipped.add(id);
        continue;
      }
      assets.push({ assetId: id, positions: g.positions, index: g.index });
      transfer.push(g.positions);
      if (g.index) transfer.push(g.index);
      this.sentAssets.add(id);
    }
    const runnable = instances.filter((i) => !skipped.has(i.assetId));

    this.active = {
      runId,
      events,
      pending: new Map(runnable.map((i) => [i.id, i.name])),
      timer: setTimeout(() => this.finish(null, true), this.timeoutMs),
    };

    this.worker.postMessage(
      { t: 'run', runId, bed, assets, instances: runnable } satisfies CheckRunMsg,
      transfer,
    );
    events.onProgress(0, runnable.length, runnable.length ? '准备检查' : '无可检查对象');
    if (!runnable.length) {
      // 空场景/全隐藏:立即完成(导出置灰与提示归 T15;此处结果为空报告)
      this.finish({ instances: 0, errors: 0, warnings: 0, totalFaces: 0, assetsAnalyzed: 0, assetsCached: 0, durationMs: 0 }, false);
    }
    return true;
  }

  private onReply(m: CheckReply) {
    const a = this.active;
    if (!a || m.runId !== a.runId) return; // 迟到消息(上一轮 terminate 前的余波)丢弃
    switch (m.t) {
      case 'progress':
        a.events.onProgress(m.done, m.total, m.phase);
        return;
      case 'asset':
        a.events.onAsset(m.meta, m.boundarySegments);
        return;
      case 'instance':
        if (m.issues.length) a.pending.delete(m.issues[0].instanceId);
        a.events.onIssues(m.issues);
        return;
      case 'done':
        this.finish(m.summary, false);
        return;
    }
  }

  private finish(summary: CheckSummary | null, timedOut: boolean) {
    const a = this.active;
    if (!a) return;
    clearTimeout(a.timer);
    this.active = null;
    if (timedOut && this.worker) {
      // 超时:处决 Worker(计算不可中断,只能整体回收);缓存随之失效
      this.worker.terminate();
      this.worker = null;
      this.sentAssets.clear();
    }
    a.events.onDone({
      summary,
      unfinished: [...a.pending.entries()].map(([id, name]) => ({ id, name })),
      timedOut,
    });
  }
}
