// T14 运行器单测 —— 假 Worker 驱动(与 import-queue 测试同构)。
// 覆盖:CHK-04 资产几何只传一次(跨轮缓存)、验收样例「1 非水密资产 × 6 实例 → 6 错误 · 分析 1 次」、
// CHK-02 超时按未完成呈现 + 边界 5 分对象重试、Worker 崩溃同路径收口。

import { describe, expect, it, vi } from 'vitest';
import { CheckRunner, type CheckWorkerLike } from '../src/check/check-runner';
import {
  checkInstance,
  type CheckIssue,
  type CheckReply,
  type CheckRunMsg,
  type InstanceInput,
} from '../src/check/check-core';

const BED = { x: 256, y: 256, z: 256 };

/** 假 Worker:同步收消息,受控异步回消息;记录收到的 run 载荷供断言 */
class FakeWorker implements CheckWorkerLike {
  onmessage: ((ev: { data: CheckReply }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  received: CheckRunMsg[] = [];
  terminated = false;
  /** 行为脚本:收到 run 后如何回消息;默认全量正常完成 */
  script: (msg: CheckRunMsg, reply: (m: CheckReply) => void) => void = defaultScript;

  postMessage(msg: unknown) {
    const m = msg as CheckRunMsg;
    this.received.push(m);
    queueMicrotask(() => this.script(m, (r) => this.onmessage?.({ data: r })));
  }
  terminate() {
    this.terminated = true;
  }
}

/** 默认脚本:资产逐个上报(positions 有值 = 分析,null = 缓存命中),实例全部流回,最后 done */
function defaultScript(m: CheckRunMsg, reply: (r: CheckReply) => void) {
  let analyzed = 0;
  let cached = 0;
  for (const a of m.assets) {
    const fresh = a.positions !== null;
    if (fresh) analyzed++;
    else cached++;
    reply({
      t: 'asset',
      runId: m.runId,
      meta: {
        assetId: a.assetId,
        faces: 10,
        weldedVertices: 8,
        degenerateCount: 0,
        boundaryEdges: 4,
        nonManifoldEdges: 0,
        watertight: false,
        analysisMs: 1,
        cached: !fresh,
      },
      boundarySegments: fresh ? new ArrayBuffer(24) : null,
    });
  }
  let errors = 0;
  for (const inst of m.instances) {
    const issues = checkInstance(
      inst,
      { faces: 10, watertight: false, boundaryEdges: 4, nonManifoldEdges: 0, degenerateCount: 0 },
      { min: [-10, -10, 0], max: [10, 10, 16] },
      m.bed,
    );
    errors += issues.filter((i) => i.level === 'error').length;
    reply({ t: 'instance', runId: m.runId, issues });
  }
  reply({
    t: 'done',
    runId: m.runId,
    summary: {
      instances: m.instances.length,
      errors,
      warnings: 0,
      totalFaces: 10 * m.instances.length,
      assetsAnalyzed: analyzed,
      assetsCached: cached,
      durationMs: 5,
    },
  });
}

const inst = (id: string, assetId = 'a1'): InstanceInput => ({
  id,
  name: `件${id}`,
  assetId,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
});

const geom = () => ({ positions: new Float32Array(30).buffer as ArrayBuffer, index: null });

function collect() {
  const issues: CheckIssue[] = [];
  const assets: { assetId: string; cached: boolean }[] = [];
  let done: { unfinished: { id: string; name: string }[]; timedOut: boolean; summary: unknown } | null = null;
  return {
    issues,
    assets,
    getDone: () => done,
    events: {
      onProgress: () => {},
      onAsset: (m: { assetId: string; cached: boolean }) => {
        assets.push({ assetId: m.assetId, cached: m.cached });
      },
      onIssues: (list: CheckIssue[]) => {
        issues.push(...list);
      },
      onDone: (r: { summary: unknown; unfinished: { id: string; name: string }[]; timedOut: boolean }) => {
        done = r;
      },
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('CheckRunner 状态机', () => {
  it('验收样例:1 个非水密资产 × 6 实例 → 6 条错误,几何分析仅 1 次', async () => {
    const w = new FakeWorker();
    const runner = new CheckRunner(() => w, 1000);
    const c = collect();
    const six = Array.from({ length: 6 }, (_, i) => inst(`i${i}`));
    expect(runner.run(BED, six, () => geom(), c.events)).toBe(true);
    await flush();

    // 6 个实例各报 1 条非水密错误(资产级结论逐实例呈现)
    expect(c.issues.filter((i) => i.code === 'non_watertight')).toHaveLength(6);
    // 载荷断言:同资产的几何只随消息传输 1 份
    expect(w.received[0].assets).toHaveLength(1);
    expect(w.received[0].assets[0].positions).not.toBeNull();
    const d = c.getDone()!;
    expect(d.timedOut).toBe(false);
    expect((d.summary as { assetsAnalyzed: number }).assetsAnalyzed).toBe(1);
  });

  it('跨轮缓存(CHK-04):第二轮同资产 positions=null,Worker 报缓存命中', async () => {
    const w = new FakeWorker();
    const runner = new CheckRunner(() => w, 1000);
    const c1 = collect();
    runner.run(BED, [inst('i1')], () => geom(), c1.events);
    await flush();
    const c2 = collect();
    runner.run(BED, [inst('i2')], () => geom(), c2.events);
    await flush();

    expect(w.received[1].assets[0].positions).toBeNull(); // 第二轮不再传几何
    expect(c2.assets[0].cached).toBe(true);
  });

  it('运行中重复触发被拒绝;完成后可再跑', async () => {
    const w = new FakeWorker();
    w.script = () => {}; // 永不回消息,保持 running
    const runner = new CheckRunner(() => w, 1000);
    expect(runner.run(BED, [inst('i1')], () => geom(), collect().events)).toBe(true);
    expect(runner.run(BED, [inst('i2')], () => geom(), collect().events)).toBe(false);
  });

  it('超时(CHK-02):保留已流回的部分结果,余者列入 unfinished;Worker 被处决', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    w.script = (m, reply) => {
      // 只完成第一件就沉默(模拟卡死)
      reply({ t: 'instance', runId: m.runId, issues: [{ key: `dims:${m.instances[0].id}`, level: 'info', code: 'dims', instanceId: m.instances[0].id, instanceName: m.instances[0].name, assetId: 'a1', message: 'x' }] });
    };
    const runner = new CheckRunner(() => w, 30_000);
    const c = collect();
    runner.run(BED, [inst('i1'), inst('i2'), inst('i3')], () => geom(), c.events);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(c.getDone()).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    vi.useRealTimers();

    const d = c.getDone()!;
    expect(d.timedOut).toBe(true);
    expect(d.unfinished.map((u) => u.id)).toEqual(['i2', 'i3']); // 已完成的 i1 不在列
    expect(c.issues).toHaveLength(1); // 部分结果保留,不假装成功也不丢弃
    expect(w.terminated).toBe(true);
  });

  it('分对象重试(边界 5):超时后重跑子集,新 Worker 重传所需几何', async () => {
    let spawned = 0;
    const workers: FakeWorker[] = [];
    const spawn = () => {
      const w = new FakeWorker();
      if (spawned === 0) w.script = () => {}; // 第一只:卡死
      spawned++;
      workers.push(w);
      return w;
    };
    const runner = new CheckRunner(spawn, 10);
    const c1 = collect();
    runner.run(BED, [inst('i1'), inst('i2')], () => geom(), c1.events);
    await new Promise((r) => setTimeout(r, 25)); // 盖过 10ms 超时
    expect(c1.getDone()!.timedOut).toBe(true);

    const c2 = collect();
    runner.run(BED, c1.getDone()!.unfinished.map((u) => inst(u.id)), () => geom(), c2.events);
    await flush();

    expect(spawned).toBe(2); // 超时处决后重生
    expect(workers[1].received[0].assets[0].positions).not.toBeNull(); // 缓存随旧 Worker 陪葬 → 重传
    expect(c2.getDone()!.timedOut).toBe(false);
    expect(c2.issues.some((i) => i.instanceId === 'i1')).toBe(true);
  });

  it('几何缺失的资产:其实例整体跳出本轮(不假装成功)', async () => {
    const w = new FakeWorker();
    const runner = new CheckRunner(() => w, 1000);
    const c = collect();
    runner.run(BED, [inst('i1', 'a1'), inst('i2', 'gone')], (id) => (id === 'a1' ? geom() : null), c.events);
    await flush();
    expect(w.received[0].instances.map((i) => i.id)).toEqual(['i1']);
  });

  it('空场景轮:立即完成、零对象汇总(边界 3 的检查侧)', async () => {
    const w = new FakeWorker();
    const runner = new CheckRunner(() => w, 1000);
    const c = collect();
    runner.run(BED, [], () => null, c.events);
    expect((c.getDone()!.summary as { instances: number }).instances).toBe(0);
  });

  it('Worker 崩溃(onerror):按超时同路径收口,部分结果保留', async () => {
    const w = new FakeWorker();
    w.script = (m, reply) => {
      reply({ t: 'instance', runId: m.runId, issues: [{ key: `dims:${m.instances[0].id}`, level: 'info', code: 'dims', instanceId: m.instances[0].id, instanceName: 'x', assetId: 'a1', message: 'x' }] });
      w.onerror?.(new Error('boom'));
    };
    const runner = new CheckRunner(() => w, 1000);
    const c = collect();
    runner.run(BED, [inst('i1'), inst('i2')], () => geom(), c.events);
    await flush();
    const d = c.getDone()!;
    expect(d.timedOut).toBe(true);
    expect(d.unfinished.map((u) => u.id)).toEqual(['i2']);
  });
});
