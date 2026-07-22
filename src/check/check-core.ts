// 打印检查核心(T14)—— CHK-01~06 的纯逻辑层,零 DOM/Worker 依赖,单元测试直接覆盖。
// 分层原则(CHK-04/C2):资产级属性(水密/退化)对几何做一次拓扑分析并缓存;
// 实例级属性(床外/悬空/微小/尺寸)以「逐顶点 × TRS 矩阵」求精确世界包围盒,随变换重算。
// 内核 dropToBed 的 bbox 近似在此升级为几何精确值 —— 旋转后的对象 bbox 角点会外扩,
// 逐顶点变换才能给出真实的 zMin(悬空判定与修复增量都以此为准)。

import * as THREE from 'three';
import { weldAndAnalyze, type Topology } from '../importer/parse-core';
import type { Transform, Vec3 } from '../kernel/types';
import type { BedConfig } from '../state/store';
import { analyzeMeshHealth, type MeshHealthAnalysis } from './mesh-health-core';

// ---------- 阈值(PRD §9 待校准表:上线后对照切片软件默认值调整) ----------
/** 悬空判定:对象世界 zMin > 0.5mm 即报警告(PRD CHK 边界 1,M1 定义;待校准) */
export const FLOATING_MM = 0.5;
/** 微小件判定:世界包围盒最大边长 < 2mm(FDM 单壁极限量级;待校准,对照切片软件) */
export const TINY_MM = 2;
/** 床边界容差:浮点误差与「贴边即合法」的缓冲 */
export const BED_EPS_MM = 0.05;
/** 非水密描红的边界边段数上限(高亮示意足够;防超大破损网格撑爆传输与渲染) */
export const MAX_HIGHLIGHT_SEGMENTS = 4000;
/** CHK-02:检查 30s 超时,按未完成呈现(不假装成功) */
export const CHECK_TIMEOUT_MS = 30_000;

// ---------- 数据模型 ----------

export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueCode =
  | 'non_watertight' // 错误:非水密(CHK-01)
  | 'degenerate' // 错误:退化几何
  | 'self_intersection' // 错误:不相邻面片相交(M1.7.1 只读)
  | 'internal_shell' // 警告:封闭壳体位于另一封闭壳体内部(M1.7.1 只读)
  | 'isolated_fragment' // 警告:小型断开碎片(M1.7.1 只读)
  | 'deep_check_partial' // 警告:深度自交扫描未覆盖完整网格
  | 'out_of_bed' // 错误:超出打印体积
  | 'floating' // 警告:悬空
  | 'tiny' // 警告:微小件
  | 'dims'; // 信息:逐对象尺寸与面数(CHK-01 信息级)

export interface CheckIssue {
  key: string; // `${code}:${instanceId}`(稳定,修复标记/高亮定位用)
  level: IssueLevel;
  code: IssueCode;
  instanceId: string;
  instanceName: string; // 检查时刻快照(对象随后被删时条目随之失效移除,CHK 边界 2)
  assetId: string;
  message: string;
  /** 世界包围盒(悬空投影线、聚焦包围盒用) */
  world?: { min: Vec3; max: Vec3 };
  /** CHK-06 确定性修复参数(由 Worker 算好,主线程一键派发内核命令) */
  fix?:
    | { kind: 'drop'; zMin: number } // 悬空 → 沉底(几何精确 zMin)
    | { kind: 'clamp'; delta: Vec3; fullyFixable: boolean }; // 超床 → 移回最近合法位
}

export interface AssetAnalysisMeta {
  assetId: string;
  faces: number;
  weldedVertices: number;
  degenerateCount: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  watertight: boolean;
  health: MeshHealthAnalysis;
  analysisMs: number; // 耗时日志(验收样例:1 资产 × 6 实例,分析仅 1 次)
  cached: boolean; // 本轮为缓存命中(未执行分析)
}

export interface CheckSummary {
  instances: number; // 实际检查的实例数(隐藏不参与,C7)
  errors: number;
  warnings: number;
  totalFaces: number;
  assetsAnalyzed: number; // 本轮真实执行的拓扑分析次数
  assetsCached: number; // 本轮缓存复用次数
  durationMs: number;
}

export interface CheckReport {
  issues: CheckIssue[];
  summary: CheckSummary;
  assetMetas: AssetAnalysisMeta[];
  unfinished: { id: string; name: string }[]; // 超时未检实例(CHK-02/边界 5:分对象重试)
  timedOut: boolean;
}

// ---------- 世界变换(与视口严格同源:THREE Euler XYZ · 度 → 弧度) ----------

const D2R = Math.PI / 180;

/** TRS → 4×4 矩阵元素(THREE 列主序)。与 gizmo-math.worldBBoxOfInstance 同一构造路径,保证口径一致 */
export function composeTRS(t: Transform): Float64Array {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(t.rotation[0] * D2R, t.rotation[1] * D2R, t.rotation[2] * D2R, 'XYZ'),
    ),
    new THREE.Vector3(...t.scale),
  );
  return Float64Array.from(m.elements);
}

/** 逐顶点变换求精确世界包围盒(实例级检查的度量基准)。手写矩阵乘避免百万级 Vector3 分配 */
export function worldStats(
  positions: Float32Array,
  t: Transform,
): { min: Vec3; max: Vec3 } {
  const e = composeTRS(t);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (wx < min[0]) min[0] = wx;
    if (wx > max[0]) max[0] = wx;
    if (wy < min[1]) min[1] = wy;
    if (wy > max[1]) max[1] = wy;
    if (wz < min[2]) min[2] = wz;
    if (wz > max[2]) max[2] = wz;
  }
  return { min, max };
}

// ---------- 资产级分析(CHK-04:一次缓存) ----------

export function analyzeAssetGeometry(
  positions: Float32Array,
  index: Uint32Array | null,
): Topology & { boundarySegments: Float32Array; health: MeshHealthAnalysis } {
  const topo = weldAndAnalyze(positions, index, {
    collectBoundarySegments: MAX_HIGHLIGHT_SEGMENTS,
  });
  const health = analyzeMeshHealth(positions, index);
  return { ...topo, boundarySegments: topo.boundarySegments ?? new Float32Array(0), health };
}

// ---------- 实例级检查(CHK-01 三级 + CHK-06 修复参数) ----------

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

/** 超床 → 移回最近合法位的平移增量(CHK-06)。
 *  各轴独立:尺寸放得下 → clamp 进 [lo, hi];放不下 → 该轴不可修(居中也无意义,报 fullyFixable=false)。
 *  Z 轴合法区间为 [0, bed.z](对象不允许沉入床下)。 */
export function clampIntoBedDelta(
  world: { min: Vec3; max: Vec3 },
  bed: BedConfig,
): { delta: Vec3; fullyFixable: boolean } {
  const lo: Vec3 = [-bed.x / 2, -bed.y / 2, 0];
  const hi: Vec3 = [bed.x / 2, bed.y / 2, bed.z];
  const delta: Vec3 = [0, 0, 0];
  let fullyFixable = true;
  for (let a = 0; a < 3; a++) {
    const size = world.max[a] - world.min[a];
    if (size > hi[a] - lo[a] + BED_EPS_MM) {
      fullyFixable = false; // 对象该轴尺寸超过打印体积,平移无解
      continue;
    }
    if (world.min[a] < lo[a]) delta[a] = lo[a] - world.min[a];
    else if (world.max[a] > hi[a]) delta[a] = hi[a] - world.max[a];
  }
  return { delta, fullyFixable };
}

export interface InstanceInput {
  id: string;
  name: string;
  assetId: string;
  transform: Transform;
}

/** 单实例检查:输入资产级分析 + 精确世界包围盒 + 床配置,产出该实例全部条目。
 *  纯函数 —— Worker 与单测共用同一实现。 */
export function checkInstance(
  inst: Pick<InstanceInput, 'id' | 'name' | 'assetId'>,
  topo: Pick<Topology, 'faces' | 'watertight' | 'boundaryEdges' | 'nonManifoldEdges' | 'degenerateCount'> & {
    health?: MeshHealthAnalysis;
  },
  world: { min: Vec3; max: Vec3 },
  bed: BedConfig,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const base = { instanceId: inst.id, instanceName: inst.name, assetId: inst.assetId, world };
  const push = (code: IssueCode, level: IssueLevel, message: string, fix?: CheckIssue['fix']) =>
    issues.push({ key: `${code}:${inst.id}`, code, level, message, fix, ...base });

  // —— 错误级(CHK-01)——
  if (!topo.watertight) {
    const parts: string[] = [];
    if (topo.boundaryEdges > 0) parts.push(`${topo.boundaryEdges} 条开放边界边`);
    if (topo.nonManifoldEdges > 0) parts.push(`${topo.nonManifoldEdges} 条非流形边`);
    push(
      'non_watertight',
      'error',
      `非水密网格(${parts.join(' · ') || '拓扑不封闭'})。可先生成安全修复预览；复杂破损仍需外部网格工具`,
    );
  }
  if (topo.degenerateCount > 0) {
    push('degenerate', 'error', `含 ${topo.degenerateCount} 个退化面片(零面积/顶点塌缩)`);
  }
  const health = topo.health;
  if (health?.selfIntersectionPairs) {
    push(
      'self_intersection',
      'error',
      `检测到${health.selfIntersectionComplete ? '' : '至少 '}${health.selfIntersectionPairs} 组不相邻面片相交。可逐组定位局部证据；当前只读，不自动改写复杂拓扑`,
    );
  }
  if (health?.internalShells) {
    push(
      'internal_shell',
      'warning',
      `疑似包含 ${health.internalShells} 个内部封闭壳体（共 ${health.connectedComponents} 个连通壳）。可能形成内部空腔或重复壁，请回源确认`,
    );
  }
  if (health?.isolatedFragments) {
    push(
      'isolated_fragment',
      'warning',
      `检测到 ${health.isolatedFragments} 个小型孤立碎片（共 ${health.isolatedFragmentFaces} 面）。可能是布尔残片，也可能是有意分离的小零件`,
    );
  }
  if (health && !health.selfIntersectionComplete) {
    push(
      'deep_check_partial',
      'warning',
      `深度自交检查达到计算预算（面片覆盖 ${health.selfIntersectionTrianglesScanned.toLocaleString()} / ${topo.faces.toLocaleString()} 面，候选对验证 ${health.selfIntersectionPairTests.toLocaleString()} 次）`
        + `${health.componentAnalysisComplete ? '' : '；连通壳、内部壳和碎片未做完整分析'}；未发现不等于不存在`,
    );
  }

  const overX = world.min[0] < -bed.x / 2 - BED_EPS_MM || world.max[0] > bed.x / 2 + BED_EPS_MM;
  const overY = world.min[1] < -bed.y / 2 - BED_EPS_MM || world.max[1] > bed.y / 2 + BED_EPS_MM;
  const belowZ = world.min[2] < -BED_EPS_MM;
  const overZ = world.max[2] > bed.z + BED_EPS_MM;
  if (overX || overY || belowZ || overZ) {
    const where = [
      overX ? 'X' : '',
      overY ? 'Y' : '',
      belowZ ? '床下' : '',
      overZ ? '超高' : '',
    ].filter(Boolean).join('/');
    const clamp = clampIntoBedDelta(world, bed);
    push(
      'out_of_bed',
      'error',
      clamp.fullyFixable
        ? `超出打印体积(${where})`
        : `超出打印体积(${where}),且对象尺寸超过打印空间,平移无法修复`,
      { kind: 'clamp', ...clamp },
    );
  }

  // —— 警告级 ——
  // 悬空:zMin > 阈值(M1 定义,PRD CHK 边界 1;沉入床下的对象归超床错误,不重复报悬空)
  if (!belowZ && world.min[2] > FLOATING_MM) {
    push(
      'floating',
      'warning',
      `悬空 ${fmt(world.min[2])}mm(底面未接触打印床)`,
      { kind: 'drop', zMin: world.min[2] },
    );
  }
  const size: Vec3 = [
    world.max[0] - world.min[0],
    world.max[1] - world.min[1],
    world.max[2] - world.min[2],
  ];
  if (Math.max(...size) < TINY_MM) {
    push('tiny', 'warning', `微小件:最大边长 ${fmt(Math.max(...size))}mm < ${TINY_MM}mm,可能无法成型`);
  }

  // —— 信息级(CHK-01:逐对象尺寸与面数,构成清单)——
  const shells = health && health.connectedComponents > 1 ? ` · ${health.connectedComponents} 个连通壳` : '';
  push('dims', 'info', `${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm · ${topo.faces.toLocaleString()} 面${shells}`);

  return issues;
}

// ---------- 过期判定(CHK-03) ----------

export interface RunMeta {
  editVersion: number; // 检查发起时刻的文档编辑版本
  bed: BedConfig; // 床配置也参与判定:改床尺寸令「床外」结论失真
}

export function isReportStale(meta: RunMeta, editVersion: number, bed: BedConfig): boolean {
  return (
    meta.editVersion !== editVersion ||
    meta.bed.x !== bed.x ||
    meta.bed.y !== bed.y ||
    meta.bed.z !== bed.z
  );
}

// ---------- Worker 消息协议(与 parse.worker 同风格:壳极薄,协议集中定义) ----------

export interface CheckRunMsg {
  t: 'run';
  runId: string;
  bed: BedConfig;
  /** 本轮需要的资产;positions 为 null 表示 Worker 侧已有缓存(CHK-04 跨轮复用) */
  assets: { assetId: string; positions: ArrayBuffer | null; index: ArrayBuffer | null }[];
  instances: InstanceInput[];
}

export type CheckReply =
  | { t: 'progress'; runId: string; done: number; total: number; phase: string }
  | {
      t: 'asset';
      runId: string;
      meta: AssetAnalysisMeta;
      boundarySegments: ArrayBuffer | null; // 首次分析回传描红线段;缓存命中为 null(主线程已有)
    }
  | { t: 'instance'; runId: string; issues: CheckIssue[] } // 逐实例流式返回:超时保留已完成的部分
  | { t: 'done'; runId: string; summary: CheckSummary };
