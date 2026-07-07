// 状态桥 —— 内核(SceneDocument,非响应式)与 React 之间的唯一通道。
// 规则:一切场景变更经 dispatch() 走内核 command,随后 bump() 通知订阅者;
//       禁止组件直接改 doc 后不 bump,也禁止把场景数据复制进 zustand(单一事实源在内核,C2)。

import * as THREE from 'three';
import { create } from 'zustand';
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
      if (p && p.kind === 'instance' && !p.locked) out.set(p.id, p);
    }
  }
  return [...out.values()];
}

// ---------- 示例场景(T5 演示与验收用;T10 解析管线就位后由真实导入替代) ----------

function bboxOf(g: THREE.BufferGeometry): Asset['meta']['bbox'] {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}

function demoAsset(id: string, name: string, g: THREE.BufferGeometry, faces: number): Asset {
  geometryRegistry.set(id, g);
  return {
    id,
    name,
    source: 'import',
    state: 'ready',
    meta: { faces, bbox: bboxOf(g), unitChoice: 'mm', watertight: true, degenerate: false },
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

let booted = false;
export function bootstrapDemoScene() {
  if (booted) return;
  booted = true;

  const box = new THREE.BoxGeometry(30, 30, 30);
  const cyl = new THREE.CylinderGeometry(14, 14, 44, 48).rotateX(Math.PI / 2); // 圆柱轴对齐 Z(C3)
  const knot = new THREE.TorusKnotGeometry(12, 3.6, 128, 24);
  const plate = new THREE.BoxGeometry(60, 40, 6);

  const assets = [
    demoAsset('ast_demo_box', '立方体 30mm', box, 12),
    demoAsset('ast_demo_cyl', '圆柱 Ø28×44', cyl, 96),
    demoAsset('ast_demo_knot', '扭结样件', knot, 6144),
    demoAsset('ast_demo_plate', '校准板 60×40', plate, 12),
  ];
  const nodes = [
    demoInstance('ins_demo_box', 'ast_demo_box', '立方体 30mm', [-60, 40, 15]),
    demoInstance('ins_demo_cyl', 'ast_demo_cyl', '圆柱 Ø28×44', [0, -50, 22]),
    demoInstance('ins_demo_knot', 'ast_demo_knot', '扭结样件', [55, 30, 16]),
    // 锁定示例:VIEW-04 验收用 —— 点选/框选/全选都应跳过它
    demoInstance('ins_demo_plate', 'ast_demo_plate', '已锁定 · 校准板', [-70, -70, 3], true),
  ];

  doc.hydrate(assets, nodes);
}
