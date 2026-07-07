// T6 gizmo 纯数学层测试:轴参数、环角度、吸附/钳制、把手禁用、世界包围盒。
// 验收口径对应 PRD VIEW-05/06 与边界 5(正交沿视线轴把手禁用)。

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AXIS_UNIT,
  angleOnPlaneDeg,
  axisHandleDisabled,
  axisScaleFactor,
  clampScaleFactor,
  closestParamOnAxis,
  fmtSigned,
  gizmoWorldScale,
  planeHandleDisabled,
  selectionBBox,
  shortestDeltaDeg,
  snapValue,
  uniformScaleFactor,
  worldBBoxOfInstance,
} from '../src/viewport/gizmo-math';
import type { Transform } from '../src/kernel/types';

const ray = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) =>
  new THREE.Ray(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz).normalize());

const T = (
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): Transform => ({ position, rotation, scale });

const UNIT_BBOX = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };

describe('T6 轴参数与环角度', () => {
  it('射线垂直掠过轴:最近点参数 = 命中横坐标', () => {
    // X 轴过原点;射线从 (5,-10,0) 沿 +Y —— 与轴最近处在 (5,0,0)
    const s = closestParamOnAxis(ray(5, -10, 0, 0, 1, 0), new THREE.Vector3(), AXIS_UNIT[0]);
    expect(s).toBeCloseTo(5, 6);
  });

  it('射线与轴平行:无解返回 null(把手此时应处禁用态)', () => {
    expect(closestParamOnAxis(ray(0, 5, 0, 1, 0, 0), new THREE.Vector3(), AXIS_UNIT[0])).toBeNull();
  });

  it('绕 Z 环:+X 方向 0°、+Y 方向 90°(右手系,沿 +Z 逆时针增)', () => {
    const pivot = new THREE.Vector3();
    expect(angleOnPlaneDeg(ray(1, 0, 10, 0, 0, -1), pivot, 2)).toBeCloseTo(0, 6);
    expect(angleOnPlaneDeg(ray(0, 1, 10, 0, 0, -1), pivot, 2)).toBeCloseTo(90, 6);
  });

  it('绕 X 环:+Z 方向 90°', () => {
    expect(angleOnPlaneDeg(ray(10, 0, 1, -1, 0, 0), new THREE.Vector3(), 0)).toBeCloseTo(90, 6);
  });

  it('射线与环平面平行:返回 null', () => {
    // 绕 Z 环的平面 z=0;射线在 z=5 水平飞行,永不相交
    expect(angleOnPlaneDeg(ray(0, -10, 5, 0, 1, 0), new THREE.Vector3(), 2)).toBeNull();
  });
});

describe('T6 吸附与钳制(VIEW-05 · Ctrl 1mm/5° · PANEL-05 禁负)', () => {
  it('平移 1mm 步进', () => {
    expect(snapValue(12.3, 1)).toBe(12);
    expect(snapValue(-2.6, 1)).toBe(-3);
  });

  it('旋转 5° 步进', () => {
    expect(snapValue(7.4, 5)).toBe(5);
    expect(snapValue(-12.6, 5)).toBe(-15);
  });

  it('最短有向角差:跨 ±180 取短弧', () => {
    expect(shortestDeltaDeg(350, 10)).toBe(20);
    expect(shortestDeltaDeg(10, 350)).toBe(-20);
    expect(shortestDeltaDeg(170, -170)).toBe(20);
  });

  it('缩放禁负、钳制下限 0.1%', () => {
    expect(clampScaleFactor(-1)).toBe(0.001);
    expect(clampScaleFactor(0)).toBe(0.001);
    expect(axisScaleFactor(1, -0.4, false)).toBe(0.001); // 反向拖过枢轴不产生镜像
  });

  it('轴向缩放系数 = 参数比;吸附取 5% 步进', () => {
    expect(axisScaleFactor(2, 5, false)).toBeCloseTo(2.5, 9);
    expect(axisScaleFactor(1, 1.13, true)).toBeCloseTo(1.15, 9);
    expect(axisScaleFactor(0, 5, false)).toBe(1); // 起点退化保护
  });

  it('整体缩放系数 = 屏幕距离比', () => {
    expect(uniformScaleFactor(50, 100, false)).toBeCloseTo(2, 9);
    expect(uniformScaleFactor(50, 61, true)).toBeCloseTo(1.2, 9);
  });

  it('浮标格式:恒显符号', () => {
    expect(fmtSigned(3)).toBe('+3.0');
    expect(fmtSigned(-2.5)).toBe('-2.5');
    expect(fmtSigned(0)).toBe('+0.0');
  });
});

describe('T6 把手禁用(VIEW 边界 5:正交沿视线轴)', () => {
  const topView = new THREE.Vector3(0, 0, -1); // 顶视图:视线沿 -Z

  it('顶视图:Z 轴把手禁用,X/Y 照常', () => {
    expect(axisHandleDisabled(2, topView)).toBe(true);
    expect(axisHandleDisabled(0, topView)).toBe(false);
    expect(axisHandleDisabled(1, topView)).toBe(false);
  });

  it('顶视图:XY 平面块可用,XZ/YZ 侧对禁用;Z 环可用,X/Y 环侧对禁用', () => {
    expect(planeHandleDisabled(2, topView)).toBe(false); // XY 块(法线 Z)迎面
    expect(planeHandleDisabled(0, topView)).toBe(true); // YZ 块(法线 X)侧对
    expect(planeHandleDisabled(1, topView)).toBe(true);
  });

  it('轴测视角:全部把手可用', () => {
    const iso = new THREE.Vector3(-1, 1, -1).normalize();
    for (const a of [0, 1, 2] as const) {
      expect(axisHandleDisabled(a, iso)).toBe(false);
      expect(planeHandleDisabled(a, iso)).toBe(false);
    }
  });
});

describe('T6 世界包围盒与枢轴(沉底 zMin 的数据来源,VIEW-06)', () => {
  it('恒等变换:等于资产 bbox', () => {
    const b = worldBBoxOfInstance(T(), UNIT_BBOX);
    expect(b.min.toArray()).toEqual([-1, -1, -1]);
    expect(b.max.toArray()).toEqual([1, 1, 1]);
  });

  it('平移与缩放:bbox 随 TRS 变化 —— 沉底量 = -min.z', () => {
    const b = worldBBoxOfInstance(T([10, 0, 5], [0, 0, 0], [2, 2, 2]), UNIT_BBOX);
    expect(b.min.toArray()).toEqual([8, -2, 3]);
    expect(b.max.z).toBe(7); // 沉底后 position.z 应减去 min.z=3
  });

  it('绕 Z 旋转 90°:长短边互换(欧拉度数、XYZ 序,C6)', () => {
    const bbox = { min: [-2, -1, -1] as [number, number, number], max: [2, 1, 1] as [number, number, number] };
    const b = worldBBoxOfInstance(T([0, 0, 0], [0, 0, 90]), bbox);
    expect(b.min.x).toBeCloseTo(-1, 6);
    expect(b.max.x).toBeCloseTo(1, 6);
    expect(b.min.y).toBeCloseTo(-2, 6);
    expect(b.max.y).toBeCloseTo(2, 6);
  });

  it('选中集合并包围盒:枢轴取中心;空集返回 null', () => {
    const box = selectionBBox([
      { transform: T([-10, 0, 0]), bbox: UNIT_BBOX },
      { transform: T([10, 0, 0]), bbox: UNIT_BBOX },
    ])!;
    expect(box.min.x).toBe(-11);
    expect(box.max.x).toBe(11);
    expect(box.getCenter(new THREE.Vector3()).toArray()).toEqual([0, 0, 0]);
    expect(selectionBBox([])).toBeNull();
  });
});

describe('T6 屏幕等距', () => {
  it('正交:世界尺寸 = px / zoom', () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1);
    cam.zoom = 2;
    expect(gizmoWorldScale(cam, new THREE.Vector3(), 800, 90)).toBe(45);
  });

  it('透视:随距离线性放大', () => {
    const cam = new THREE.PerspectiveCamera(90, 1, 1, 1000); // tan(45°)=1
    cam.position.set(0, 0, 100);
    const s = gizmoWorldScale(cam, new THREE.Vector3(), 800, 80);
    expect(s).toBeCloseTo((80 * 2 * 100) / 800, 6); // = 20
  });
});
