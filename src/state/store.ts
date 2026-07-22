// 状态桥 —— 内核(SceneDocument,非响应式)与 React 之间的唯一通道。
// 规则:一切场景变更经 dispatch() 走内核 command,随后 bump() 通知订阅者;
//       禁止组件直接改 doc 后不 bump,也禁止把场景数据复制进 zustand(单一事实源在内核,C2)。

import * as THREE from 'three';
import { create } from 'zustand';
import { renderThumbnail } from '../importer/thumbnail';
import { SceneDocument } from '../kernel/scene';
import { Asset, InstanceNode } from '../kernel/types';
import type { GizmoMode } from '../viewport/gizmo-math';

export const doc = new SceneDocument();

// ---------- UI store(仅 UI 态,不含场景数据) ----------

export interface BedConfig {
  x: number; // mm
  y: number;
  z: number;
}

/** VIEW-01:床尺寸预设 + 自定义 */
export const BED_PRESETS: { label: string; bed: BedConfig }[] = [
  { label: '256 × 256 × 256', bed: { x: 256, y: 256, z: 256 } },
  { label: '180 × 180 × 180', bed: { x: 180, y: 180, z: 180 } },
  { label: '350 × 350 × 350', bed: { x: 350, y: 350, z: 350 } },
];

export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

/** 导入状态条的视图行(队列内核状态的只读投影,见 importer/import-queue) */
export interface ImportJobView {
  id: string;
  name: string;
  phase: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  pct: number;
  phaseText: string;
  error?: { code: string; message: string; retryable: boolean };
  thumb?: string | null;
}

/** IMP-05 单位确认:对话框打开期间对象以「幽灵预览」形态在床上实时换算,未入库未入栈 */
export interface UnitAskState {
  jobId: string;
  name: string;
  bboxRaw: { min: [number, number, number]; max: [number, number, number] };
  unit: 'mm' | 'cm' | 'inch' | 'm';
  recommended: 'mm' | 'cm' | 'inch' | 'm';
  slotX: number;
}

/** 持久层状态(T11)。mode:idb = 正常;session = IndexedDB 不可用,纯内存会话(AST 边界 1);
 *  init = 首次装载未完成。unsavedIds:超容量拒写、仅存活于本会话的资产(AST-04) */
export interface StorageState {
  mode: 'init' | 'idb' | 'session';
  usedBytes: number;
  capBytes: number;
  unsavedIds: string[];
}

interface UiState {
  rev: number; // 场景文档版本号:每次 command 后 +1,驱动订阅组件重渲染
  bump: () => void;
  ortho: boolean; // VIEW-03 透视/正交
  setOrtho: (v: boolean) => void;
  bed: BedConfig;
  setBed: (b: BedConfig) => void;
  marquee: Marquee | null; // 框选橡皮筋(屏幕像素坐标)
  setMarquee: (m: Marquee | null) => void;
  gizmoMode: GizmoMode; // VIEW-05:W/E/R 三模式
  setGizmoMode: (m: GizmoMode) => void;
  hud: { text: string; x: number; y: number } | null; // VIEW-05 增量浮标(视口局部像素坐标)
  setHud: (h: { text: string; x: number; y: number } | null) => void;
  toast: { text: string; id: number; action?: ToastAction } | null; // 全局轻提示;action 为可选跟随按钮(IMP-05「可撤 toast」)
  setToast: (text: string, action?: ToastAction) => void;
  importJobs: ImportJobView[]; // T10 导入状态条(IMP-08:占位可见、失败不静默消失)
  upsertImportJob: (j: ImportJobView) => void;
  dropImportJob: (id: string) => void;
  dragImport: false | 'files' | 'asset'; // 视口拖放高亮(文件导入 / 资产建实例两种来源,文案不同)
  setDragImport: (v: false | 'files' | 'asset') => void;
  storage: StorageState; // T11 持久层状态(C5/AST-04):会话模式常驻提示与容量条的数据源
  setStorage: (s: StorageState) => void;
  unitAsk: UnitAskState | null; // IMP-05 单位确认对话框(一次一件,余者排队)
  setUnitAsk: (u: UnitAskState | null) => void;
  histHover: string[] | null; // HIST-08:hover 历史条目 → 视口高亮受影响实例(低频,入 zustand 无性能顾虑)
  setHistHover: (ids: string[] | null) => void;
}

export const useUi = create<UiState>()((set) => ({
  rev: 0,
  bump: () => set((s) => ({ rev: s.rev + 1 })),
  ortho: false,
  setOrtho: (ortho) => set({ ortho }),
  bed: BED_PRESETS[0].bed,
  setBed: (bed) => set({ bed }),
  marquee: null,
  setMarquee: (marquee) => set({ marquee }),
  gizmoMode: 'translate',
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  hud: null,
  setHud: (hud) => set({ hud }),
  toast: null,
  setToast: (text, action) => set({ toast: { text, id: Date.now(), action } }),
  importJobs: [],
  upsertImportJob: (j) =>
    set((s) => {
      const i = s.importJobs.findIndex((x) => x.id === j.id);
      const next = [...s.importJobs];
      if (i >= 0) next[i] = { ...next[i], ...j };
      else next.push(j);
      return { importJobs: next };
    }),
  dropImportJob: (id) => set((s) => ({ importJobs: s.importJobs.filter((x) => x.id !== id) })),
  dragImport: false,
  setDragImport: (dragImport) => set({ dragImport }),
  storage: { mode: 'init', usedBytes: 0, capBytes: 500 * 1024 * 1024, unsavedIds: [] },
  setStorage: (storage) => set({ storage }),
  unitAsk: null,
  setUnitAsk: (unitAsk) => set({ unitAsk }),
  histHover: null,
  setHistHover: (histHover) => set({ histHover }),
}));

/** 命令派发:执行内核操作并通知 React。所有写操作必须走这里。 */
export function dispatch<T>(fn: (d: SceneDocument) => T): T {
  const r = fn(doc);
  useUi.getState().bump();
  return r;
}

// ---------- 相机命令总线(工具栏/快捷键 → Canvas 内 CameraRig;相机操作不入栈,C1/VIEW-03) ----------

export type ViewPreset = 'top' | 'front' | 'side' | 'iso';
export type CamCmd =
  | { kind: 'preset'; view: ViewPreset }
  | { kind: 'focus' }
  | { kind: 'focusBounds'; min: [number, number, number]; max: [number, number, number] }
  | { kind: 'home' };

const camListeners = new Set<(c: CamCmd) => void>();
export function onCam(fn: (c: CamCmd) => void): () => void {
  camListeners.add(fn);
  return () => camListeners.delete(fn);
}
export function sendCam(c: CamCmd) {
  camListeners.forEach((f) => f(c));
}

// ---------- 几何注册表(非序列化资源,活在内核之外) ----------

export const geometryRegistry = new Map<string, THREE.BufferGeometry>();
/** 资产缩略图 dataURL(IMP-07)。留在内核之外:撤销快照 structuredClone 资产时不背图片字节 */
export const thumbRegistry = new Map<string, string>();
/** 实例 id → 视口 mesh,供聚焦包围盒与框选投影使用 */
export const meshRegistry = new Map<string, THREE.Object3D>();
/** Gizmo 把手网格注册表(T6):交互层的拾取候选;Gizmo 组件挂载/卸载时增删 */
export const gizmoHandles = new Set<THREE.Object3D>();
/** Gizmo 高亮态(hover/拖拽中)。每帧被 Gizmo 读取着色;
 *  不入 zustand —— 拖拽期每次 pointermove 触发 React 重渲染得不偿失 */
export const gizmoUiState = {
  hoverKey: null as string | null,
  activeKey: null as string | null,
};

/** 选中集展开为可变换的实例集合(组 → 其全部后代实例;锁定成员剔除)。
 *  视口拖拽、gizmo、沉底按钮共用同一展开语义(VIEW-04/06)。 */
export function expandToInstances(ids: Iterable<string>): InstanceNode[] {
  const out = new Map<string, InstanceNode>();
  for (const id of ids) {
    const n = doc.nodes.get(id);
    if (!n) continue;
    const pool = n.kind === 'instance' ? [n.id] : doc.descendants(n.id);
    for (const pid of pool) {
      const p = doc.nodes.get(pid);
      if (p && p.kind === 'instance' && !doc.effectiveLocked(pid)) out.set(p.id, p);
    }
  }
  return [...out.values()];
}

// ---------- 示例场景(T5–T9 验收回归夹具)。T10/T11 真实导入与持久化就位后仍保留:
// 夹具每次启动重建、不落库(persist.isDemoAsset 过滤),是回归点测的稳定基准;T17 欢迎页后再撤 ----------

function bboxOf(g: THREE.BufferGeometry): Asset['meta']['bbox'] {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}

function demoAsset(
  id: string,
  name: string,
  g: THREE.BufferGeometry,
  faces: number,
  metaOverride: Partial<Asset['meta']> = {},
): Asset {
  geometryRegistry.set(id, g);
  const thumb = renderThumbnail(g); // 资产面板网格视图用;无 WebGL 环境返回 null,字形占位
  if (thumb) thumbRegistry.set(id, thumb);
  return {
    id,
    name,
    source: 'import',
    state: 'ready',
    meta: { faces, bbox: bboxOf(g), unitChoice: 'mm', watertight: true, degenerate: false, ...metaOverride },
  };
}

function demoInstance(
  id: string,
  assetId: string,
  name: string,
  position: [number, number, number],
  locked = false,
): InstanceNode {
  return {
    kind: 'instance',
    id,
    name,
    assetId,
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked,
  };
}

export function bootstrapDemoScene(): boolean {
  const demoInstanceIds = [
    'ins_demo_box',
    'ins_demo_cyl',
    'ins_demo_knot',
    'ins_demo_plate',
    'ins_demo_open',
  ];
  if (demoInstanceIds.some((id) => doc.nodes.has(id))) return false;

  const box = new THREE.BoxGeometry(30, 30, 30);
  const cyl = new THREE.CylinderGeometry(14, 14, 44, 48).rotateX(Math.PI / 2); // 圆柱轴对齐 Z(C3)
  const knot = new THREE.TorusKnotGeometry(12, 3.6, 128, 24);
  const plate = new THREE.BoxGeometry(60, 40, 6);
  const openBox = makeOpenBox(24, 24, 16); // T14 夹具:顶面缺失 → 非水密(4 条边界边)

  const assets = [
    demoAsset('ast_demo_box', '立方体 30mm', box, 12),
    demoAsset('ast_demo_cyl', '圆柱 Ø28×44', cyl, 96),
    demoAsset('ast_demo_knot', '扭结样件', knot, 6144),
    demoAsset('ast_demo_plate', '校准板 60×40', plate, 12),
    demoAsset('ast_demo_open', '开口盒 · 非水密样例', openBox, 10, { watertight: false }),
  ];
  const nodes = [
    demoInstance('ins_demo_box', 'ast_demo_box', '立方体 30mm', [-60, 40, 15]),
    demoInstance('ins_demo_cyl', 'ast_demo_cyl', '圆柱 Ø28×44', [0, -50, 22]),
    demoInstance('ins_demo_knot', 'ast_demo_knot', '扭结样件', [55, 30, 16]),
    // 锁定示例:VIEW-04 验收用 —— 点选/框选/全选都应跳过它
    demoInstance('ins_demo_plate', 'ast_demo_plate', '已锁定 · 校准板', [-70, -70, 3], true),
    // T14 验收示例:落位即悬空 6mm(底面 z = 14 − 8),检查应报「非水密(错误)+ 悬空(警告)」
    demoInstance('ins_demo_open', 'ast_demo_open', '开口盒 · 非水密样例', [70, -60, 14]),
  ];

  doc.hydrate(assets, nodes);
  useUi.getState().bump();
  return true;
}

/** M1.7.2 隐藏 QA 场景：`?qa=self-intersection` 使用三片三角形形成两组确定命中，
 *  让本地与线上都能稳定验收“检测 → 命中对浏览 → 局部聚焦”，不污染常规五对象示例与 Agent Gold Set。 */
export function bootstrapSelfIntersectionQaScene(): boolean {
  const instanceId = 'ins_qa_self_intersection';
  if (doc.nodes.has(instanceId)) return false;
  const assetId = 'ast_qa_self_intersection';
  const geometry = makeSelfIntersectionPair();
  const asset = demoAsset(assetId, '自交定位样件', geometry, 3, { watertight: false });
  const instance = demoInstance(instanceId, assetId, '自交定位样件 · 只读证据', [0, 0, 12]);
  doc.hydrate([asset], [instance]);
  useUi.getState().bump();
  return true;
}

/** M1.7.3 隐藏 QA 场景：单一资产内含三个彼此分离的封闭壳，稳定验收逐壳分色与只读定位。 */
export function bootstrapComponentPreviewQaScene(): boolean {
  const instanceId = 'ins_qa_component_preview';
  if (doc.nodes.has(instanceId)) return false;
  const assetId = 'ast_qa_component_preview';
  const geometry = makeComponentPreviewQaGeometry();
  const asset = demoAsset(assetId, '三连通壳拆件样件', geometry, 36);
  const instance = demoInstance(instanceId, assetId, '三连通壳 · 只读拆件预览', [0, 0, 0]);
  doc.hydrate([asset], [instance]);
  useUi.getState().bump();
  return true;
}

function makeComponentPreviewQaGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(28, 28, 28).toNonIndexed().translate(-34, 0, 14),
    new THREE.BoxGeometry(20, 20, 20).toNonIndexed().translate(0, 0, 10),
    new THREE.BoxGeometry(14, 14, 14).toNonIndexed().translate(25, 0, 7),
  ];
  const counts = parts.map((part) => part.getAttribute('position').array.length);
  const positions = new Float32Array(counts.reduce((sum, count) => sum + count, 0));
  let offset = 0;
  for (const part of parts) {
    const array = part.getAttribute('position').array as Float32Array;
    positions.set(array, offset);
    offset += array.length;
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeSelfIntersectionPair(): THREE.BufferGeometry {
  const positions = new Float32Array([
    -20, -20, 0, 20, -20, 0, 0, 20, 0,
    -6, -10, -12, -6, 10, -12, -6, 0, 12,
    6, -10, -12, 6, 10, -12, 6, 0, 12,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 顶面缺失的开口盒(w×d×h,几何中心在原点):非水密(顶缘 4 条边界边)、面片朝外的手工三角网格。
 *  T14 检查器的常驻演示件 —— 描红高亮、悬空修复、资产级缓存(拖多个实例)都能在它身上点验 */
function makeOpenBox(w: number, d: number, h: number): THREE.BufferGeometry {
  const x = w / 2;
  const y = d / 2;
  const z = h / 2;
  // 8 角点:下面 a b c d(逆时针俯视),上面 e f g h 对应正上方
  const a = [-x, -y, -z], b = [x, -y, -z], c = [x, y, -z], dd = [-x, y, -z];
  const e = [-x, -y, z], f = [x, -y, z], g = [x, y, z], hh = [-x, y, z];
  // 每面 2 三角,外向绕序;顶面(e f g hh)刻意缺失
  const tris = [
    [a, dd, c], [a, c, b], // 底(-Z)
    [a, b, f], [a, f, e], // 前(-Y)
    [b, c, g], [b, g, f], // 右(+X)
    [c, dd, hh], [c, hh, g], // 后(+Y)
    [dd, a, e], [dd, e, hh], // 左(-X)
  ];
  const pos = new Float32Array(tris.length * 9);
  tris.flat().forEach((p, i) => pos.set(p, i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
