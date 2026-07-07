// Gizmo 纯数学层(T6)—— 与 T5 的 math.ts 同责:交互中一切可测的数学收敛到纯函数。
//
// 记录在案的决策(PRD 注释层素材):
// 1. 旋转 gizmo 直接编辑欧拉分量,与参数面板(T8)是同一条数据通道。C6 规定欧拉角为源数据、
//    禁止从矩阵反解回写,因此「绕世界轴旋转再分解」不可用;分量旋转是欧拉源数据下唯一
//    无损通道,且对新导入对象(零旋转,占绝对多数的摆盘场景)与世界轴旋转严格等价。
//    绕公共中心的编队旋转记 M2 债。
// 2. 缩放吸附取 5%:PRD 只规定 1mm/5°,缩放对齐同一粒度感,禁负(PANEL-05 镜像须显式操作)。
// 3. 把手禁用是通用退化判定而非只在正交生效:轴与视线近平行、交互平面近侧对时一律禁用,
//    正交预设视图(VIEW 边界 5)是其必然特例,透视下极端角度同样受保护。

import * as THREE from 'three';
import type { Transform, Vec3 } from '../kernel/types';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type HandleKind = 'axis' | 'plane' | 'ring' | 'uniform';

export interface GizmoPart {
  mode: GizmoMode;
  kind: HandleKind;
  axis: 0 | 1 | 2; // uniform 忽略此值
}

export const partKey = (p: GizmoPart) => `${p.mode}:${p.kind}:${p.axis}`;

// ---------- 吸附与钳制(VIEW-05 / PANEL-05) ----------

export const TRANSLATE_SNAP_MM = 1;
export const ROTATE_SNAP_DEG = 5;
export const SCALE_SNAP = 0.05;
export const MIN_SCALE = 0.001; // clamp ≥0.1%、禁负

export function snapValue(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export function clampScaleFactor(f: number): number {
  return f < MIN_SCALE ? MIN_SCALE : f;
}

/** 轴向缩放系数:抓取点参数 s0 → 当前参数 s1 的比值,吸附后仍钳制下限 */
export function axisScaleFactor(s0: number, s1: number, snap: boolean): number {
  if (Math.abs(s0) < 1e-6) return 1;
  const f = s1 / s0;
  return clampScaleFactor(snap ? snapValue(f, SCALE_SNAP) : f);
}

/** 整体缩放系数:光标到枢轴屏幕距离之比 */
export function uniformScaleFactor(d0: number, d1: number, snap: boolean): number {
  const f = d1 / Math.max(d0, 1e-3);
  return clampScaleFactor(snap ? snapValue(f, SCALE_SNAP) : f);
}

/** 最短有向角差,(-180,180];跨 ±180 的连续拖动由调用方逐帧累加 */
export function shortestDeltaDeg(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** 增量浮标数值格式:恒显符号,定小数位 */
export function fmtSigned(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

// ---------- 拾取与拖拽几何 ----------

export const AXIS_UNIT: readonly THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

/** 射线到「过 origin、方向为单位向量 axis」直线:直线上最近点的参数 s;近平行返回 null */
export function closestParamOnAxis(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  axis: THREE.Vector3,
): number | null {
  const r = origin.clone().sub(ray.origin);
  const b = axis.dot(ray.direction);
  const denom = 1 - b * b;
  if (denom < 1e-9) return null; // 轴与射线平行,参数无解(此时把手也应处于禁用态)
  const e = axis.dot(r);
  const f = ray.direction.dot(r);
  return (b * f - e) / denom;
}

/** 射线与「过 pivot、法线为世界轴 axisIdx」平面的交点 */
export function intersectAxisPlane(
  ray: THREE.Ray,
  pivot: THREE.Vector3,
  axisIdx: 0 | 1 | 2,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  const n = AXIS_UNIT[axisIdx];
  const plane = new THREE.Plane(n.clone(), -n.dot(pivot));
  return ray.intersectPlane(plane, out);
}

/** 环平面基向量(右手系):角度沿 +axis 方向逆时针增 */
const PLANE_BASIS: readonly (readonly [number, number])[] = [
  [1, 2], // 绕 X:u=Y, w=Z
  [2, 0], // 绕 Y:u=Z, w=X
  [0, 1], // 绕 Z:u=X, w=Y
];

/** 环拖拽:交点相对 pivot 在环平面内的方位角(度);射线不与平面相交时返回 null */
export function angleOnPlaneDeg(
  ray: THREE.Ray,
  pivot: THREE.Vector3,
  axisIdx: 0 | 1 | 2,
): number | null {
  const hit = intersectAxisPlane(ray, pivot, axisIdx);
  if (!hit) return null;
  const v = hit.sub(pivot);
  const [ui, wi] = PLANE_BASIS[axisIdx];
  return THREE.MathUtils.radToDeg(Math.atan2(v.dot(AXIS_UNIT[wi]), v.dot(AXIS_UNIT[ui])));
}

// ---------- 把手禁用(VIEW 边界 5 + 数值稳定性) ----------

export const AXIS_ALIGN_COS = 0.99; // 轴与视线夹角 < ~8° 视为沿视线
export const PLANE_EDGE_COS = 0.08; // 平面法线与视线夹角 > ~85° 视为侧对(edge-on)

/** 移动/缩放的轴把手:轴沿视线 → 位移不可感知且求交退化 → 禁用 */
export function axisHandleDisabled(axisIdx: 0 | 1 | 2, viewDir: THREE.Vector3): boolean {
  return Math.abs(AXIS_UNIT[axisIdx].dot(viewDir)) > AXIS_ALIGN_COS;
}

/** 平面拖拽块 / 旋转环:交互平面侧对视线 → 射线求交病态 → 禁用。
 *  (环的交互平面法线即其轴,共用同一判定) */
export function planeHandleDisabled(normalIdx: 0 | 1 | 2, viewDir: THREE.Vector3): boolean {
  return Math.abs(AXIS_UNIT[normalIdx].dot(viewDir)) < PLANE_EDGE_COS;
}

// ---------- 屏幕等距缩放 ----------

/** pivot 处 gizmo 保持约 px 像素视觉尺寸所需的世界尺寸 */
export function gizmoWorldScale(
  camera: THREE.Camera,
  pivot: THREE.Vector3,
  viewportHeightPx: number,
  px: number,
): number {
  const o = camera as THREE.OrthographicCamera;
  if (o.isOrthographicCamera) return px / o.zoom;
  const p = camera as THREE.PerspectiveCamera;
  const d = p.position.distanceTo(pivot);
  return (px * 2 * d * Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) / viewportHeightPx;
}

// ---------- 世界包围盒与选中枢轴 ----------

/** 实例的世界包围盒:资产 bbox 8 角点经 TRS 矩阵变换(欧拉度数、固定 XYZ 序,C6) */
export function worldBBoxOfInstance(
  t: Transform,
  bbox: { min: Vec3; max: Vec3 },
): THREE.Box3 {
  const D2R = THREE.MathUtils.degToRad;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(D2R(t.rotation[0]), D2R(t.rotation[1]), D2R(t.rotation[2]), 'XYZ'),
    ),
    new THREE.Vector3(...t.scale),
  );
  return new THREE.Box3(
    new THREE.Vector3(...bbox.min),
    new THREE.Vector3(...bbox.max),
  ).applyMatrix4(m);
}

/** 选中集合并包围盒;gizmo 枢轴取其中心 */
export function selectionBBox(
  items: { transform: Transform; bbox: { min: Vec3; max: Vec3 } }[],
): THREE.Box3 | null {
  if (!items.length) return null;
  const box = new THREE.Box3();
  for (const it of items) box.union(worldBBoxOfInstance(it.transform, it.bbox));
  return box;
}
