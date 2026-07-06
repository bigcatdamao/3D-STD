// T5 可测层:交互数学 + 装载通道。指针事件本身不进单测(验收走线上手测),
// 但 3px 死区、相交判定、拖拽平面、预设位姿这些决定行为正确性的纯函数全部锁死。

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DRAG_DEADZONE_PX,
  exceedsDeadzone,
  fitDistance,
  homePose,
  intersectHorizontalPlane,
  matchOrthoZoom,
  normalizeRect,
  presetPose,
  projectBoxToScreenRect,
  rectsOverlap,
} from '../src/viewport/math';
import { SceneDocument } from '../src/kernel/scene';
import { Asset, InstanceNode } from '../src/kernel/types';

describe('3px 死区(VIEW-02 边界 2)', () => {
  it('2px 位移不越过死区(验收样例:点选、不移动)', () => {
    expect(exceedsDeadzone(100, 100, 101.4, 101.4)).toBe(false); // hypot ≈ 1.98
  });
  it('10px 位移越过死区(验收样例:移动并入栈一步)', () => {
    expect(exceedsDeadzone(100, 100, 110, 100)).toBe(true);
  });
  it('恰好 3px 判拖动(≥ 阈值)', () => {
    expect(exceedsDeadzone(0, 0, DRAG_DEADZONE_PX, 0)).toBe(true);
  });
});

describe('框选相交(VIEW-04)', () => {
  it('任意方向拖出的矩形归一化', () => {
    expect(normalizeRect(50, 60, 10, 20)).toEqual({ minX: 10, minY: 20, maxX: 50, maxY: 60 });
  });
  it('部分相交即命中', () => {
    const rect = normalizeRect(0, 0, 100, 100);
    expect(rectsOverlap(rect, { minX: 90, minY: 90, maxX: 200, maxY: 200 })).toBe(true);
  });
  it('相离不命中', () => {
    const rect = normalizeRect(0, 0, 100, 100);
    expect(rectsOverlap(rect, { minX: 101, minY: 0, maxX: 200, maxY: 100 })).toBe(false);
  });
  it('包含关系命中(框选整包对象)', () => {
    const rect = normalizeRect(0, 0, 300, 300);
    expect(rectsOverlap(rect, { minX: 50, minY: 50, maxX: 60, maxY: 60 })).toBe(true);
  });
});

describe('包围盒屏幕投影', () => {
  it('相机正前方对象投影落在视口中部', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 1, 1000);
    cam.up.set(0, 0, 1);
    cam.position.set(0, -200, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const box = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    const r = projectBoxToScreenRect(box, cam, 800, 600)!;
    expect(r).not.toBeNull();
    expect(r.minX).toBeGreaterThan(300);
    expect(r.maxX).toBeLessThan(500);
    expect(r.minY).toBeGreaterThan(200);
    expect(r.maxY).toBeLessThan(400);
  });
  it('相机正后方对象返回 null(不参与框选)', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 1, 1000);
    cam.position.set(0, -200, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const box = new THREE.Box3(new THREE.Vector3(-5, -405, -5), new THREE.Vector3(5, -395, 5));
    expect(projectBoxToScreenRect(box, cam, 800, 600)).toBeNull();
  });
});

describe('拖拽平面(床面平移,Z 不变)', () => {
  it('垂直向下射线与 z=10 平面交点正确', () => {
    const ray = new THREE.Ray(new THREE.Vector3(30, 40, 100), new THREE.Vector3(0, 0, -1));
    const p = intersectHorizontalPlane(ray, 10)!;
    expect(p.x).toBeCloseTo(30);
    expect(p.y).toBeCloseTo(40);
    expect(p.z).toBeCloseTo(10);
  });
  it('平行射线无交点返回 null', () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, 0, 50), new THREE.Vector3(1, 0, 0));
    expect(intersectHorizontalPlane(ray, 10)).toBeNull();
  });
});

describe('视角预设(VIEW-03)', () => {
  it('顶视图基本垂直向下且带微小前倾(规避万向锁)', () => {
    const p = presetPose('top', 256);
    expect(p.position[2]).toBeGreaterThan(300);
    expect(Math.abs(p.position[0])).toBeLessThan(1);
    expect(Math.abs(p.position[1])).toBeGreaterThan(0); // 非零 = 有微倾
    expect(Math.abs(p.position[1])).toBeLessThan(1);
  });
  it('前视图在 -Y 侧、侧视图在 +X 侧', () => {
    expect(presetPose('front', 256).position[1]).toBeLessThan(0);
    expect(presetPose('side', 256).position[0]).toBeGreaterThan(0);
  });
  it('预设距离随床尺寸缩放', () => {
    const small = presetPose('iso', 180);
    const large = presetPose('iso', 350);
    expect(Math.hypot(...large.position)).toBeGreaterThan(Math.hypot(...small.position));
  });
  it('Home 位姿与 T1 冒烟视角同族', () => {
    expect(homePose(256).position).toEqual([280, -280, 220]);
  });
});

describe('聚焦与投影切换', () => {
  it('fitDistance:半径越大距离越远,且能装下包围球', () => {
    const d1 = fitDistance(50, 45, 16 / 9);
    const d2 = fitDistance(100, 45, 16 / 9);
    expect(d2).toBeGreaterThan(d1);
    // 垂直可视半高 ≥ 半径(留了 15% 余量)
    expect(d1 * Math.tan((45 / 2) * (Math.PI / 180))).toBeGreaterThan(50 * 0.99);
  });
  it('matchOrthoZoom:切换后表观高度一致', () => {
    const dist = 400;
    const zoom = matchOrthoZoom(dist, 45, 600);
    const visibleH = 2 * dist * Math.tan((45 / 2) * (Math.PI / 180));
    expect(600 / zoom).toBeCloseTo(visibleH, 5);
  });
});

describe('装载通道(hydrate)', () => {
  const asset: Asset = {
    id: 'ast_1',
    name: '样件',
    source: 'import',
    state: 'ready',
    meta: { faces: 12, bbox: { min: [0, 0, 0], max: [10, 10, 10] }, unitChoice: 'mm', watertight: true, degenerate: false },
  };
  const inst = (id: string, locked = false): InstanceNode => ({
    kind: 'instance',
    id,
    name: id,
    assetId: 'ast_1',
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked,
  });

  it('装载不产生历史记录(装载不是编辑)', () => {
    const d = new SceneDocument();
    d.hydrate([asset], [inst('a'), inst('b', true)]);
    expect(d.history.length).toBe(0);
    expect(d.nodes.size).toBe(2);
    expect(d.childrenOf(null)).toEqual(['a', 'b']);
  });

  it('装载后全选跳过锁定对象(VIEW-04)', () => {
    const d = new SceneDocument();
    d.hydrate([asset], [inst('a'), inst('b', true)]);
    d.selectAll();
    expect([...d.selection]).toEqual(['a']);
  });

  it('装载后的实例可正常走交互会话:取消归位不入栈、提交入栈一步', () => {
    const d = new SceneDocument();
    d.hydrate([asset], [inst('a')]);
    d.beginInteraction('移动 1 个对象', ['a']);
    d.updateInteraction(() => {
      d.instance('a').transform.position = [10, 0, 0];
    });
    d.cancelInteraction();
    expect(d.instance('a').transform.position).toEqual([0, 0, 0]);
    expect(d.history.length).toBe(0);

    d.beginInteraction('移动 1 个对象', ['a']);
    d.updateInteraction(() => {
      d.instance('a').transform.position = [10, 0, 0];
    });
    d.commitInteraction();
    expect(d.history.length).toBe(1);
    d.history.undo();
    expect(d.instance('a').transform.position).toEqual([0, 0, 0]);
  });
});
