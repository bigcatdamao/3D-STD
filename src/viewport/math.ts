// 视口纯函数层 —— 不依赖 React/DOM,交互逻辑中一切可测的数学都收敛到这里。

import * as THREE from 'three';
import type { ViewPreset } from '../state/store';

/** VIEW-02 边界 2:3px 死区。按下→抬起位移 < 3px 判点选,≥ 3px 判拖动。 */
export const DRAG_DEADZONE_PX = 3;

export function exceedsDeadzone(x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.hypot(x1 - x0, y1 - y0) >= DRAG_DEADZONE_PX;
}

// ---------- 框选 ----------

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 两角点(任意方向拖出)归一为 min/max 矩形 */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  };
}

/** VIEW-04:框选「相交即选」——矩形重叠判定 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** 世界包围盒 → 屏幕像素 AABB(8 角点投影)。对象在相机后方时返回 null。 */
export function projectBoxToScreenRect(
  box: THREE.Box3,
  camera: THREE.Camera,
  width: number,
  height: number,
): Rect | null {
  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let anyInFront = false;
  for (const c of corners) {
    const v = c.clone().project(camera); // NDC
    if (v.z < 1) anyInFront = true; // 透视下相机后方 z>1
    const px = ((v.x + 1) / 2) * width;
    const py = ((1 - v.y) / 2) * height; // 屏幕 Y 向下
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  if (!anyInFront) return null;
  return { minX, minY, maxX, maxY };
}

// ---------- 拖拽平面 ----------

/** 拖动约束在过起始命中点、法线为 +Z 的水平面上(切片软件语义:床面平移,Z 不变) */
export function intersectHorizontalPlane(
  ray: THREE.Ray,
  planeZ: number,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
  return ray.intersectPlane(plane, out);
}

// ---------- 相机预设(VIEW-03) ----------

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

/** 预设视角。d 由床尺寸推导;顶视图带 0.1% 前倾,规避 up 轴与视线共线的万向锁退化。 */
export function presetPose(view: ViewPreset, bedMax: number): CameraPose {
  const d = bedMax * 1.55;
  const t: [number, number, number] = [0, 0, 0];
  switch (view) {
    case 'top':
      return { position: [0, -d * 0.001, d], target: t };
    case 'front':
      return { position: [0, -d, bedMax * 0.12], target: [0, 0, bedMax * 0.12] };
    case 'side':
      return { position: [d, 0, bedMax * 0.12], target: [0, 0, bedMax * 0.12] };
    case 'iso':
      return { position: [d * 0.72, -d * 0.72, d * 0.58], target: t };
  }
}

/** Home 复位位姿(与 T1 冒烟视角同族,按床缩放) */
export function homePose(bedMax: number): CameraPose {
  const k = bedMax / 256;
  return { position: [280 * k, -280 * k, 220 * k], target: [0, 0, 0] };
}

/** F 聚焦:给定包围球半径与透视 fov,求恰好装下(留 15% 余量)的相机距离 */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const fovV = THREE.MathUtils.degToRad(fovDeg);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
  const fov = Math.min(fovV, fovH);
  return (radius / Math.sin(fov / 2)) * 1.15;
}

/** 正交聚焦:包围球恰好装入视口时的 zoom(px / mm) */
export function fitOrthoZoom(radius: number, widthPx: number, heightPx: number): number {
  return Math.min(widthPx, heightPx) / (radius * 2 * 1.15);
}

/** 透视↔正交切换时保持表观尺寸:由当前距离与 fov 推导等效 zoom */
export function matchOrthoZoom(distance: number, fovDeg: number, heightPx: number): number {
  const visibleH = 2 * distance * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  return heightPx / visibleH;
}
