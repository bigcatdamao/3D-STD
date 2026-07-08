// T4:生成 mock 引擎的「生成结果」样例 GLB(public/mock/*.glb,构建时随静态资产发布)。
// 运行:node scripts/gen-mock-glb.mjs(产物已入库,仅在需要改样例时重跑)。
// 约定:glTF 规范 = Y-up · 米;导入管线(T10)烘焙为 Z-up · 毫米,故 0.02m 立方 = 20mm 校准立方。
// 三件均为水密闭合网格(flat 法线、重复顶点由解析管线的顶点焊接归并),让 T12/T14 联调时
// mock 结果也能通过真实的导入 → 预检 → 落床全流程。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mock');
mkdirSync(outDir, { recursive: true });

// ---------- 几何构造(flat shading:每面独立顶点) ----------

/** 收集器:push 一个三角形(9 个坐标),法线按面计算 */
function makeSink() {
  const pos = [];
  const nrm = [];
  return {
    tri(a, b, c) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const p of [a, b, c]) { pos.push(...p); nrm.push(nx, ny, nz); }
    },
    done() { return { positions: new Float32Array(pos), normals: new Float32Array(nrm) }; },
  };
}

/** 20mm 校准立方(0.02m,几何中心在原点) */
function cube() {
  const s = 0.01;
  const sink = makeSink();
  const q = (a, b, c, d) => { sink.tri(a, b, c); sink.tri(a, c, d); };
  const v = (x, y, z) => [x * s, y * s, z * s];
  q(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1));     // +Z
  q(v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1)); // -Z
  q(v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1));     // +X
  q(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)); // -X
  q(v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1));     // +Y
  q(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)); // -Y
  return sink.done();
}

/** 直径 25mm 正二十面体(circumradius 0.0125m) */
function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const r = 0.0125;
  const verts = raw.map((p) => {
    const len = Math.hypot(...p);
    return p.map((x) => (x / len) * r);
  });
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const sink = makeSink();
  for (const [a, b, c] of faces) sink.tri(verts[a], verts[b], verts[c]);
  return sink.done();
}

/** 直径 20mm · 高 30mm 十二棱柱(圆柱低模,Y 轴向) */
function cylinder() {
  const R = 0.01, H = 0.015, N = 12;
  const sink = makeSink();
  const ring = (y) =>
    Array.from({ length: N }, (_, i) => {
      const a = (i / N) * Math.PI * 2;
      return [Math.cos(a) * R, y, Math.sin(a) * R];
    });
  const top = ring(H), bot = ring(-H);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    // 侧面(外法线朝外:注意绕向)
    sink.tri(bot[i], bot[j], top[j]);
    sink.tri(bot[i], top[j], top[i]);
    // 顶/底盖(扇形)
    sink.tri([0, H, 0], top[j], top[i]);
    sink.tri([0, -H, 0], bot[i], bot[j]);
  }
  return sink.done();
}

// ---------- GLB 封装(glTF 2.0 二进制容器) ----------

function toGlb({ positions, normals }, name) {
  const binLen = positions.byteLength + normals.byteLength;
  const binPadded = Math.ceil(binLen / 4) * 4;
  const count = positions.length / 3;
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      bb.min[a] = Math.min(bb.min[a], positions[i + a]);
      bb.max[a] = Math.max(bb.max[a], positions[i + a]);
    }
  const json = JSON.stringify({
    asset: { version: '2.0', generator: '3d-std mock (T4)' },
    buffers: [{ byteLength: binPadded }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min: bb.min, max: bb.max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
    ],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    nodes: [{ mesh: 0, name }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = Math.ceil(jsonBytes.length / 4) * 4;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0x46546c67, 0); // 'glTF'
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  buf.writeUInt32LE(jsonPadded, 12);
  buf.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  buf.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonPadded; i++) buf[20 + i] = 0x20; // 空格补齐
  const binOff = 20 + jsonPadded;
  buf.writeUInt32LE(binPadded, binOff);
  buf.writeUInt32LE(0x004e4942, binOff + 4); // 'BIN\0'
  buf.set(Buffer.from(positions.buffer), binOff + 8);
  buf.set(Buffer.from(normals.buffer), binOff + 8 + positions.byteLength);
  return buf;
}

for (const [file, geo, label] of [
  ['cube.glb', cube(), '校准立方 20mm'],
  ['ico.glb', icosahedron(), '正二十面体 Ø25mm'],
  ['cyl.glb', cylinder(), '棱柱 Ø20×30mm'],
]) {
  const glb = toGlb(geo, label);
  writeFileSync(join(outDir, file), glb);
  console.log(`${file}\t${glb.length} bytes\t${label}`);
}
