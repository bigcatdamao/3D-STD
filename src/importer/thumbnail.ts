// 离屏缩略图(IMP-07)。设计裁决:缩略图在主线程而非解析 Worker 内渲染 ——
// 「主线程零阻塞」(IMP-04)约束的是解析计算;单网格 144px 一帧渲染为毫秒级一次性开销,
// 换来免去 worker 内 OffscreenCanvas+WebGL 上下文的兼容负担。渲染器全局复用一只。

import * as THREE from 'three';

export const THUMB_SIZE = 144;

let renderer: THREE.WebGLRenderer | null | 'unavailable' = null;

function getRenderer(): THREE.WebGLRenderer | null {
  if (renderer === 'unavailable') return null;
  if (renderer) return renderer;
  if (typeof document === 'undefined') {
    renderer = 'unavailable';
    return null;
  }
  try {
    const canvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(THUMB_SIZE, THUMB_SIZE);
    renderer.setPixelRatio(1);
    return renderer;
  } catch {
    renderer = 'unavailable'; // 无 WebGL 环境(测试/受限浏览器):缩略图缺省,不阻断导入
    return null;
  }
}

/** 渲染资产缩略图为 dataURL;失败返回 null(资产照常入库,面板以字形占位) */
export function renderThumbnail(geometry: THREE.BufferGeometry): string | null {
  const r = getRenderer();
  if (!r) return null;
  try {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: '#8fa8c8', roughness: 0.55, metalness: 0.05 }),
    );
    scene.add(mesh);
    scene.add(new THREE.HemisphereLight('#ffffff', '#30303a', 1.15));
    const dir = new THREE.DirectionalLight('#ffffff', 1.6);
    dir.position.set(1, -1.2, 1.6);
    scene.add(dir);

    geometry.computeBoundingSphere();
    const bs = geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
    const radius = Math.max(bs.radius, 1e-3);
    const cam = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 20);
    // 轴测视角与视口 iso 预设同族:Z-up 世界,斜上前方观察
    const d = radius * 3.1;
    cam.up.set(0, 0, 1);
    cam.position.set(bs.center.x + d * 0.62, bs.center.y - d * 0.62, bs.center.z + d * 0.48);
    cam.lookAt(bs.center);

    r.render(scene, cam);
    const url = (r.domElement as HTMLCanvasElement).toDataURL('image/png');
    scene.remove(mesh); // geometry 归资产注册表所有,此处不 dispose
    return url;
  } catch {
    return null;
  }
}
