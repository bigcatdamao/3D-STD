// 检查状态桥(T14)—— CheckRunner 与 React 之间的唯一通道,兼浏览器侧装配。
// 结果面板、场景树黄标、视口高亮、顶栏按钮都订阅本 store;
// 过期判定(CHK-03)= doc.editVersion 或床配置相对检查时刻发生变化,只灰显提示,不自动重跑。

import { useEffect as useReactEffect, useState as useReactState } from 'react';
import { create } from 'zustand';
import { dispatch, doc, geometryRegistry, sendCam, useUi, type BedConfig } from '../state/store';
import type { InstanceNode, Transform, Vec3 } from '../kernel/types';
import {
  composeTRS,
  isReportStale,
  type AssetAnalysisMeta,
  type CheckIssue,
  type CheckSummary,
  type InstanceInput,
  type RunMeta,
} from './check-core';
import { CheckRunner, type SpawnCheckWorker } from './check-runner';
import type { ConnectedComponentEvidence, SelfIntersectionEvidence } from './mesh-health-core';

// ---------- 描红线段注册表(非序列化资源,与 geometryRegistry 同居内核之外) ----------
/** 资产 id → 边界边线段端点(局部坐标)。Worker 首次分析回传,跨轮常驻主线程 */
export const edgeRegistry = new Map<string, Float32Array>();

// ---------- store ----------

export type CheckPhase = 'idle' | 'running' | 'done';

interface CheckState {
  phase: CheckPhase;
  pct: number;
  phaseText: string;
  issues: CheckIssue[];
  summary: CheckSummary | null;
  assetMetas: AssetAnalysisMeta[];
  unfinished: { id: string; name: string }[];
  timedOut: boolean;
  runMeta: RunMeta | null; // 检查发起时刻的 editVersion + 床(过期判定基准)
  activeKey: string | null; // 当前聚焦的条目(视口高亮定位)
  activeEvidenceIndex: number; // 自交命中对/连通壳浏览位置；只读 UI 状态，不进入场景历史
  fixedKeys: string[]; // 本报告内已执行修复的条目(标记「已修复」;新一轮清空)
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  setActiveKey: (k: string | null) => void;
  setActiveEvidenceIndex: (index: number) => void;
}

export const useCheck = create<CheckState>()((set) => ({
  phase: 'idle',
  pct: 0,
  phaseText: '',
  issues: [],
  summary: null,
  assetMetas: [],
  unfinished: [],
  timedOut: false,
  runMeta: null,
  activeKey: null,
  activeEvidenceIndex: 0,
  fixedKeys: [],
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setActiveKey: (activeKey) => set({ activeKey }),
  setActiveEvidenceIndex: (activeEvidenceIndex) => set({ activeEvidenceIndex }),
}));

/** SSR 安全的全量订阅:zustand v5 的 useSyncExternalStore 服务端快照取 getInitialState,
 *  裸用 useCheck() 在 renderToString 下读不到运行时 setState。用 useState 初始化器读 getState 规避,
 *  与 ParamPanel 的 useUi 订阅同 idiom(组件真实反应 + SSR 冒烟可断言)。 */
export function useCheckSnapshot(): CheckState {
  const [s, setS] = useReactState(() => useCheck.getState());
  useReactEffect(() => {
    setS(useCheck.getState());
    return useCheck.subscribe(setS);
  }, []);
  return s;
}

/** 过期判定(CHK-03):组件在渲染时以当前 editVersion/床对照检查时刻。选中/相机不触发 */
export function reportIsStale(): boolean {
  const s = useCheck.getState();
  if (!s.runMeta) return false;
  return isReportStale(s.runMeta, doc.editVersion, useUi.getState().bed);
}

/** 存活过滤(CHK 边界 2):检查中/后被删除的对象,其条目随对象失效移除 —— 渲染时按文档现状过滤 */
export function liveIssues(): CheckIssue[] {
  return useCheck.getState().issues.filter((i) => doc.nodes.has(i.instanceId));
}

// ---------- 运行器装配(真实 Worker 仅浏览器侧;测试注入假 Worker) ----------

const spawnReal: SpawnCheckWorker = () =>
  new Worker(new URL('./check.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as import('./check-runner').CheckWorkerLike;

let runner = new CheckRunner(spawnReal);

/** 测试钩:注入假 Worker 运行器 */
export function _injectRunner(r: CheckRunner) {
  runner = r;
}

/** 主线程几何取数:从渲染几何拷贝顶点(不能转移走渲染在用的缓冲);索引统一升为 Uint32。
 *  交错缓冲(GLB 可能出现)逐顶点抽取,普通属性紧凑拷贝 —— 与 parse-core.attrToF32 同思路 */
function geometryOf(assetId: string): { positions: ArrayBuffer; index: ArrayBuffer | null } | null {
  const g = geometryRegistry.get(assetId);
  const attr = g?.getAttribute('position');
  if (!g || !attr) return null;
  let positions: Float32Array;
  if (!('isInterleavedBufferAttribute' in attr && attr.isInterleavedBufferAttribute) && attr.array instanceof Float32Array) {
    positions = attr.array.slice(0, attr.count * 3);
  } else {
    positions = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      positions[i * 3] = attr.getX(i);
      positions[i * 3 + 1] = attr.getY(i);
      positions[i * 3 + 2] = attr.getZ(i);
    }
  }
  const idx = g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : null;
  return { positions: positions.buffer as ArrayBuffer, index: idx ? (idx.buffer as ArrayBuffer) : null };
}

/** 检查范围收集:可见实例(隐藏不参与,C7),资产须就绪。onlyIds = 分对象重试子集 */
function collectInstances(onlyIds?: Set<string>): InstanceInput[] {
  const out: InstanceInput[] = [];
  for (const n of doc.nodes.values()) {
    if (n.kind !== 'instance') continue;
    if (onlyIds && !onlyIds.has(n.id)) continue;
    if (!doc.effectiveVisible(n.id)) continue;
    if (doc.assets.get(n.assetId)?.state !== 'ready') continue;
    out.push({
      id: n.id,
      name: n.name,
      assetId: n.assetId,
      transform: structuredClone(n.transform),
    });
  }
  return out;
}

/** 发起打印检查(CHK-02 手动触发;T15 导出前自动检查复用本入口)。
 *  onlyIds:超时后「重试未完成」的分对象子集(CHK 边界 5)。 */
export function runPrintCheck(opts: { onlyIds?: string[] } = {}): boolean {
  if (runner.running) return false;
  const bed = { ...useUi.getState().bed };
  const retrying = !!opts.onlyIds;
  const instances = collectInstances(opts.onlyIds ? new Set(opts.onlyIds) : undefined);
  const prev = useCheck.getState();

  const runMeta: RunMeta = { editVersion: doc.editVersion, bed };
  useCheck.setState({
    phase: 'running',
    pct: 0,
    phaseText: '准备检查',
    panelOpen: true,
    activeKey: null,
    activeEvidenceIndex: 0,
    // 重试轮:保留上一轮的存量结果,只补未完成部分;全量轮:清空重来
    issues: retrying ? prev.issues : [],
    assetMetas: retrying ? prev.assetMetas : [],
    summary: retrying ? prev.summary : null,
    unfinished: [],
    timedOut: false,
    fixedKeys: retrying ? prev.fixedKeys : [],
    runMeta: retrying ? (prev.runMeta ?? runMeta) : runMeta,
  });

  const t0 = performance.now();
  return runner.run(bed, instances, geometryOf, {
    onProgress: (done, total, phase) =>
      useCheck.setState({
        pct: total ? Math.round((done / total) * 100) : 100,
        phaseText: phase,
      }),
    onAsset: (meta, segs) => {
      if (segs) edgeRegistry.set(meta.assetId, new Float32Array(segs));
      // 耗时日志(CHK 验收样例:1 资产 × 6 实例 → 分析仅 1 次,由此可证)
      console.log(
        `[check] 资产 ${meta.assetId} ${meta.cached ? '缓存复用' : `拓扑分析 ${meta.analysisMs.toFixed(1)}ms`}` +
          `(${meta.faces} 面 · ${meta.watertight ? '水密' : `非水密 ${meta.boundaryEdges} 边界边`})`,
      );
      useCheck.setState((s) => {
        const rest = s.assetMetas.filter((m) => m.assetId !== meta.assetId);
        return { assetMetas: [...rest, meta] };
      });
    },
    onIssues: (issues) =>
      useCheck.setState((s) => {
        // 重试轮覆盖同实例旧条目(全量轮 issues 从空开始,filter 为空转)
        const id = issues[0]?.instanceId;
        const rest = id ? s.issues.filter((i) => i.instanceId !== id) : s.issues;
        return { issues: [...rest, ...issues] };
      }),
    onDone: ({ summary, unfinished, timedOut }) => {
      console.log(
        `[check] 完成:${summary ? `分析 ${summary.assetsAnalyzed} 次 · 缓存 ${summary.assetsCached} 次 · ${summary.durationMs.toFixed(0)}ms` : `超时(${((performance.now() - t0) / 1000).toFixed(0)}s)`}` +
          (unfinished.length ? ` · 未完成 ${unfinished.length} 件` : ''),
      );
      useCheck.setState((s) => ({
        phase: 'done',
        pct: 100,
        phaseText: timedOut ? '超时,按未完成呈现' : '完成',
        summary: summary ?? s.summary,
        unfinished,
        timedOut,
      }));
    },
  });
}

// ---------- 条目交互(CHK-05:点击 → 聚焦 + 高亮;树黄标由 flaggedIds 派生) ----------

/** 点击条目:选中(锁定对象只聚焦不选中,C7)+ 相机聚焦 + 激活视口高亮 */
export function focusIssue(issue: CheckIssue) {
  if (issue.code === 'self_intersection' && selfIntersectionEvidenceForIssue(issue).length) {
    focusSelfIntersectionEvidence(issue, 0);
    return;
  }
  if (issue.code === 'dims' && connectedComponentEvidenceForIssue(issue).length > 1) {
    startConnectedComponentPreview(issue);
    return;
  }
  useCheck.setState({ activeKey: issue.key, activeEvidenceIndex: 0 });
  if (!doc.nodes.has(issue.instanceId)) return;
  if (!doc.effectiveLocked(issue.instanceId)) {
    dispatch((d) => d.select([issue.instanceId]));
  }
  sendCam({ kind: 'focus' });
}

/** 资产级自交命中证据只保存于本地检查状态，不进入 Agent 请求，避免无价值的坐标 token。 */
export function selfIntersectionEvidenceForIssue(issue: CheckIssue): SelfIntersectionEvidence[] {
  if (issue.code !== 'self_intersection') return [];
  return useCheck.getState().assetMetas.find((meta) => meta.assetId === issue.assetId)
    ?.health.selfIntersectionEvidence ?? [];
}

/** 连通壳预览只挂在尺寸信息条目，避免内部壳、碎片警告重复出现同一套入口。 */
export function connectedComponentEvidenceForIssue(issue: CheckIssue): ConnectedComponentEvidence[] {
  if (issue.code !== 'dims') return [];
  return useCheck.getState().assetMetas.find((meta) => meta.assetId === issue.assetId)
    ?.health.componentEvidence ?? [];
}

/** 将资产局部连通壳包围盒按实例 TRS 变换为世界 AABB。 */
export function connectedComponentWorldBounds(
  component: ConnectedComponentEvidence,
  transform: Transform,
): { min: Vec3; max: Vec3 } {
  const matrix = composeTRS(transform);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [component.bounds.min[0], component.bounds.max[0]]) {
    for (const y of [component.bounds.min[1], component.bounds.max[1]]) {
      for (const z of [component.bounds.min[2], component.bounds.max[2]]) {
        const point: Vec3 = [
          matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
          matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
          matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        ];
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
    }
  }
  return { min, max };
}

/** 首次进入预览先展示整个对象的分色关系，随后上一件/下一件才做局部聚焦。 */
export function startConnectedComponentPreview(issue: CheckIssue): boolean {
  const components = connectedComponentEvidenceForIssue(issue);
  const inst = doc.nodes.get(issue.instanceId);
  if (components.length <= 1 || !inst || inst.kind !== 'instance') return false;
  useCheck.setState({ activeKey: issue.key, activeEvidenceIndex: 0 });
  if (!doc.effectiveLocked(issue.instanceId)) dispatch((d) => d.select([issue.instanceId]));
  sendCam({ kind: 'focus' });
  return true;
}

function padComponentFocusBounds(bounds: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 } {
  const min = [...bounds.min] as Vec3;
  const max = [...bounds.max] as Vec3;
  for (let axis = 0; axis < 3; axis++) {
    const center = (bounds.min[axis] + bounds.max[axis]) / 2;
    const half = Math.max((bounds.max[axis] - bounds.min[axis]) / 2, 0.5) * 1.6;
    min[axis] = center - half;
    max[axis] = center + half;
  }
  return { min, max };
}

/** 开启逐壳只读预览并聚焦指定壳；不会创建零件、修改几何或写入历史。 */
export function focusConnectedComponent(issue: CheckIssue, requestedIndex: number): boolean {
  const components = connectedComponentEvidenceForIssue(issue);
  const inst = doc.nodes.get(issue.instanceId);
  if (components.length <= 1 || !inst || inst.kind !== 'instance') return false;
  const index = ((requestedIndex % components.length) + components.length) % components.length;
  useCheck.setState({ activeKey: issue.key, activeEvidenceIndex: index });
  if (!doc.effectiveLocked(issue.instanceId)) dispatch((d) => d.select([issue.instanceId]));
  sendCam({
    kind: 'focusBounds',
    ...padComponentFocusBounds(connectedComponentWorldBounds(components[index], inst.transform)),
  });
  return true;
}

/** 将一组资产局部自交三角形变换到实例世界空间，供相机精准聚焦。 */
export function selfIntersectionEvidenceWorldBounds(
  evidence: SelfIntersectionEvidence,
  transform: Transform,
): { min: Vec3; max: Vec3 } {
  const matrix = composeTRS(transform);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of [...evidence.triangleA, ...evidence.triangleB]) {
    const point: Vec3 = [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max };
}

/** 选择并聚焦一组自交证据。索引循环，切换只改变检查 UI，不写历史、不改模型。 */
export function focusSelfIntersectionEvidence(issue: CheckIssue, requestedIndex: number): boolean {
  const evidence = selfIntersectionEvidenceForIssue(issue);
  const inst = doc.nodes.get(issue.instanceId);
  if (!evidence.length || !inst || inst.kind !== 'instance') return false;
  const index = ((requestedIndex % evidence.length) + evidence.length) % evidence.length;
  useCheck.setState({ activeKey: issue.key, activeEvidenceIndex: index });
  if (!doc.effectiveLocked(issue.instanceId)) dispatch((d) => d.select([issue.instanceId]));
  const bounds = selfIntersectionEvidenceWorldBounds(evidence[index], inst.transform);
  sendCam({ kind: 'focusBounds', ...bounds });
  return true;
}

/** 场景树黄标数据源(CHK-05):新鲜报告中带错误/警告的实例 id 及其祖先链(组随成员亮标)。
 *  过期报告不亮标 —— 黄标承诺的是「当前场景确有此问题」,过期后承诺失效。 */
export function flaggedIds(): Set<string> {
  const out = new Set<string>();
  if (useCheck.getState().phase !== 'done' || reportIsStale()) return out;
  for (const i of liveIssues()) {
    if (i.level === 'info') continue;
    out.add(i.instanceId);
    let p = doc.nodes.get(i.instanceId)?.parentId;
    while (p) {
      out.add(p);
      p = doc.nodes.get(p)?.parentId ?? null;
    }
  }
  return out;
}

// ---------- CHK-06 位置类确定性修复(网格修复预览与派生副本见 repair/) ----------

/** 修复可用性:报告新鲜、对象存活且未随组锁定(修复 = 变换,锁定对象不可变换) */
export function fixDisabledReason(issue: CheckIssue): string | null {
  if (!doc.nodes.has(issue.instanceId)) return '对象已删除';
  if (reportIsStale()) return '结果已过期,请重新检查后修复';
  if (doc.effectiveLocked(issue.instanceId)) return '对象已锁定(C7),解锁后可修复';
  if (issue.fix?.kind === 'clamp' && !issue.fix.fullyFixable) return '对象尺寸超过打印体积,平移无法修复,请先缩小';
  return null;
}

/** 执行修复。悬空 → 沉底(检查 Worker 的几何精确 zMin);超床 → 平移增量移回最近合法位。
 *  修复本身是一次编辑 → editVersion 递增 → 整份报告随之过期(CHK-03 同规则),
 *  条目额外标「已修复」承接验收样例「修复后警告消除」的可读性。 */
export function applyFix(issue: CheckIssue): boolean {
  if (!issue.fix || fixDisabledReason(issue)) return false;
  if (issue.fix.kind === 'drop') {
    const zMin = issue.fix.zMin;
    dispatch((d) => d.dropToBed([issue.instanceId], () => zMin, `沉底 · 修复悬空`));
  } else {
    const delta = issue.fix.delta;
    dispatch((d) => d.nudgeInstances([{ id: issue.instanceId, delta }], '移回床内'));
  }
  useCheck.setState((s) => ({ fixedKeys: [...s.fixedKeys, issue.key] }));
  return true;
}
