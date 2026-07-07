// 解析管线核心(T10)—— 纯计算层,parse.worker 与单元测试共用,不触碰 DOM。
// 覆盖:格式检测(IMP-01 白名单先行)、三 loader 解码、多网格合并、glTF 坐标烘焙(IMP-06/C3)、
//       顶点焊接 + 水密/退化预检(IMP-07)、网格统计。
// 失败一律 throw ParseFailure(code) —— IMP-08 分类文案的唯一权威源在 FAILURE_COPY。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// ---------- 格式与失败分类 ----------

export type Format = 'stl' | 'obj' | 'glb' | 'gltf';

export type FailCode =
  | 'oversize'
  | 'rejected-fbx'
  | 'rejected-step'
  | '3mf-p1'
  | 'unknown-ext'
  | 'corrupt'
  | 'empty'
  | 'external-ref'
  | 'compressed'
  | 'internal';

/** IMP-08 失败分类文案;IMP-01 的 FBX/STEP 拒绝 + 替代建议也在此(入口即分类,不静默消失) */
export const FAILURE_COPY: Record<FailCode, string> = {
  oversize: '文件超过 100MB 上限',
  'rejected-fbx': '暂不支持 FBX,请从建模软件导出为 GLB 或 STL',
  'rejected-step': '暂不支持 STEP/IGES 等 CAD 格式,请导出为 STL 网格',
  '3mf-p1': '3MF 计划于 P1 支持,请先使用 STL 或 GLB',
  'unknown-ext': '不支持的文件类型(支持 GLB/glTF、STL、OBJ)',
  corrupt: '无法解析为有效的模型文件',
  empty: '文件不包含有效几何',
  'external-ref': '.gltf 引用外部资源,请从建模软件打包导出为 .glb',
  compressed: '包含 Draco/压缩网格数据,M1 暂不支持,请导出未压缩 GLB',
  internal: '解析失败(内部错误)',
};

/** 可重试性:格式类拒绝换文件才有意义,重试按钮不给;解析中断类给重试 */
export const RETRYABLE: Record<FailCode, boolean> = {
  oversize: false,
  'rejected-fbx': false,
  'rejected-step': false,
  '3mf-p1': false,
  'unknown-ext': false,
  corrupt: true,
  empty: false,
  'external-ref': false,
  compressed: false,
  internal: true,
};

export class ParseFailure extends Error {
  constructor(
    public code: FailCode,
    detail?: string,
  ) {
    super(detail ?? FAILURE_COPY[code]);
  }
}

/** 扩展名 → 格式;不在白名单的直接抛分类失败(IMP-01) */
export function detectFormat(fileName: string): Format {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === 'glb') return 'glb';
  if (ext === 'gltf') return 'gltf';
  if (ext === 'fbx') throw new ParseFailure('rejected-fbx');
  if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs')
    throw new ParseFailure('rejected-step');
  if (ext === '3mf') throw new ParseFailure('3mf-p1');
  throw new ParseFailure('unknown-ext');
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // IMP-03(T11 正式验收,入口先行拦截)
export const FACE_WARN_LIMIT = 2_000_000; // IMP-03:超面数警告不拒绝

// ---------- glTF 预处理:材质剥离 + 外部引用/压缩预检 ----------
// 打印工作台只取几何;剥掉 materials/textures/images 后 GLTFLoader 不再触碰任何
// 图像解码路径 —— worker 里既快又免去 ImageBitmap 兼容与外链纹理失败整包报废的问题。

interface GltfJson {
  buffers?: { uri?: string }[];
  meshes?: { primitives?: { material?: number; extensions?: Record<string, unknown> }[] }[];
  materials?: unknown;
  textures?: unknown;
  images?: unknown;
  samplers?: unknown;
  extensionsRequired?: string[];
}

function stripGltfJson(json: GltfJson, external: 'check' | 'ignore'): GltfJson {
  if (json.extensionsRequired?.some((e) => e.includes('draco') || e.includes('quantization')))
    throw new ParseFailure('compressed');
  for (const m of json.meshes ?? [])
    for (const p of m.primitives ?? []) {
      if (p.extensions && 'KHR_draco_mesh_compression' in p.extensions)
        throw new ParseFailure('compressed');
      delete p.material;
    }
  if (external === 'check')
    for (const b of json.buffers ?? [])
      if (b.uri && !b.uri.startsWith('data:')) throw new ParseFailure('external-ref');
  delete json.materials;
  delete json.textures;
  delete json.images;
  delete json.samplers;
  return json;
}

/** GLB 容器手术:替换 JSON chunk 为剥离版,BIN chunk 原样保留(4 字节对齐按规范补空格) */
export function stripGlb(buffer: ArrayBuffer): ArrayBuffer {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67 /* 'glTF' */)
    throw new ParseFailure('corrupt', '无法解析为有效的 GLB 文件');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a /* 'JSON' */ || 20 + jsonLen > buffer.byteLength)
    throw new ParseFailure('corrupt', '无法解析为有效的 GLB 文件');
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  } catch {
    throw new ParseFailure('corrupt', '无法解析为有效的 GLB 文件');
  }
  // GLB 的 BIN chunk 无 uri,内嵌于容器 —— 外部引用检查仅对带 uri 的 buffer 生效
  stripGltfJson(json, 'check');
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const rest = new Uint8Array(buffer, 20 + jsonLen); // BIN chunk(含头)整段搬运
  const total = 12 + 8 + jsonBytes.length + pad + rest.byteLength;
  const out = new ArrayBuffer(total);
  const w = new DataView(out);
  const u8 = new Uint8Array(out);
  w.setUint32(0, 0x46546c67, true);
  w.setUint32(4, 2, true);
  w.setUint32(8, total, true);
  w.setUint32(12, jsonBytes.length + pad, true);
  w.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  for (let i = 0; i < pad; i++) u8[20 + jsonBytes.length + i] = 0x20;
  u8.set(rest, 20 + jsonBytes.length + pad);
  return out;
}

// ---------- 解码:三 loader → 单几何合并 ----------

export interface DecodedMesh {
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array | null; // 单网格且非交错时保留索引(渲染内存友好);多网格合并为非索引
  materialMissing: boolean; // OBJ 引用 mtllib 但本管线不加载材质(IMP-07 降级标记)
  gltfBaked: boolean; // 已完成 Y-up 米 → Z-up 毫米烘焙(IMP-05/06)
}

const gltfLoader = new GLTFLoader();

function gltfParse(data: ArrayBuffer | string): Promise<{ scene: THREE.Group }> {
  return new Promise((resolve, reject) => {
    try {
      gltfLoader.parse(data as ArrayBuffer, '', resolve, (e) =>
        reject(e instanceof ParseFailure ? e : new ParseFailure('corrupt', '无法解析为有效的 glTF 文件')),
      );
    } catch {
      reject(new ParseFailure('corrupt', '无法解析为有效的 glTF 文件'));
    }
  });
}

/** glTF Y-up · 米 → 世界 Z-up · 毫米,导入时一次烘焙进顶点(C3/IMP-06),normal 由 applyMatrix4 一并修正 */
const GLTF_BAKE = new THREE.Matrix4()
  .makeRotationX(Math.PI / 2)
  .premultiply(new THREE.Matrix4().makeScale(1000, 1000, 1000));

function collectMeshGeometries(root: THREE.Object3D): THREE.BufferGeometry[] {
  root.updateMatrixWorld(true);
  const out: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const src = mesh.geometry as THREE.BufferGeometry;
    if (!src.getAttribute('position') || src.getAttribute('position').count === 0) return;
    const g = src.index ? src.toNonIndexed() : src.clone(); // 合并统一为非索引(交错属性同时展平)
    g.applyMatrix4(mesh.matrixWorld); // 节点树世界变换烘焙进顶点
    out.push(g);
  });
  return out;
}

function mergeToArrays(geos: THREE.BufferGeometry[]): {
  positions: Float32Array;
  normals: Float32Array | null;
} {
  let total = 0;
  for (const g of geos) total += g.getAttribute('position').count;
  const positions = new Float32Array(total * 3);
  const allHaveNormal = geos.every((g) => !!g.getAttribute('normal'));
  const normals = allHaveNormal ? new Float32Array(total * 3) : null;
  let off = 0;
  for (const g of geos) {
    const p = g.getAttribute('position');
    positions.set(new Float32Array(p.array.buffer, p.array.byteOffset, p.count * 3), off);
    if (normals) {
      const n = g.getAttribute('normal');
      normals.set(new Float32Array(n.array.buffer, n.array.byteOffset, n.count * 3), off);
    }
    off += p.count * 3;
  }
  return { positions, normals };
}

/** 属性转独立 Float32Array(应对 GLB 交错缓冲,保证 Transferable 干净切割) */
function attrToF32(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || !(a.array instanceof Float32Array)) {
    const out = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) {
      out[i * 3] = a.getX(i);
      out[i * 3 + 1] = a.getY(i);
      out[i * 3 + 2] = a.getZ(i);
    }
    return out;
  }
  const src = a.array as Float32Array;
  return new Float32Array(src.buffer, src.byteOffset, a.count * 3).slice(); // 紧凑拷贝,Transferable 干净切割
}

export async function decode(format: Format, buffer: ArrayBuffer): Promise<DecodedMesh> {
  if (buffer.byteLength === 0) throw new ParseFailure('empty');

  if (format === 'stl') {
    let g: THREE.BufferGeometry;
    try {
      g = new STLLoader().parse(buffer);
    } catch {
      throw new ParseFailure('corrupt', '无法解析为有效的 STL 文件');
    }
    const pos = g.getAttribute('position');
    if (!pos || pos.count === 0) throw new ParseFailure('empty');
    return {
      positions: attrToF32(pos as THREE.BufferAttribute),
      normals: g.getAttribute('normal') ? attrToF32(g.getAttribute('normal') as THREE.BufferAttribute) : null,
      index: null, // STL 按定义逐三角形独立存储顶点(IMP-07 注),天然非索引
      materialMissing: false,
      gltfBaked: false,
    };
  }

  if (format === 'obj') {
    const text = new TextDecoder().decode(buffer);
    let group: THREE.Group;
    try {
      group = new OBJLoader().parse(text);
    } catch {
      throw new ParseFailure('corrupt', '无法解析为有效的 OBJ 文件');
    }
    const geos = collectMeshGeometries(group);
    if (geos.length === 0) throw new ParseFailure('empty');
    const { positions, normals } = mergeToArrays(geos);
    return {
      positions,
      normals,
      index: null,
      materialMissing: /^[ \t]*mtllib\b/m.test(text), // 引用了 MTL 但不加载 → 默认材质 + 标记
      gltfBaked: false,
    };
  }

  // glb / gltf
  let data: ArrayBuffer | string;
  if (format === 'glb') {
    data = stripGlb(buffer);
  } else {
    let json: GltfJson;
    try {
      json = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      throw new ParseFailure('corrupt', '无法解析为有效的 glTF 文件');
    }
    data = JSON.stringify(stripGltfJson(json, 'check'));
  }
  const gltf = await gltfParse(data);
  const geos = collectMeshGeometries(gltf.scene);
  if (geos.length === 0) throw new ParseFailure('empty');
  for (const g of geos) g.applyMatrix4(GLTF_BAKE);

  // 统一走非索引合并通道(交错缓冲/多网格一并展平);索引化收益留待 M1 后按需评估
  const { positions, normals } = mergeToArrays(geos);
  return { positions, normals, index: null, materialMissing: false, gltfBaked: true };
}

// ---------- 顶点焊接 + 拓扑分析(IMP-07) ----------
// STL 逐三角形独立存储顶点,不焊接做邻接分析会把所有边都判成边界 → 全量误报非水密。
// 焊接按距离 ε 网格量化(ε 取包围盒对角线相对值);量化网格在边界附近可能少并一对点,
// 属 ε-近似的既定取舍,阈值本身即约定俗成的工程参数。

export interface Topology {
  faces: number;
  weldedVertices: number;
  degenerateCount: number; // 面积 < ε 或顶点塌缩的三角形数
  boundaryEdges: number; // 邻面数 = 1
  nonManifoldEdges: number; // 邻面数 > 2
  watertight: boolean;
}

export function bboxOfPositions(p: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = p[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  return { min, max };
}

export function weldAndAnalyze(positions: Float32Array, index: Uint32Array | null): Topology {
  const triCount = (index ? index.length : positions.length / 3) / 3 | 0;
  const bb = bboxOfPositions(positions);
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
  const eps = Math.max(1e-6, diag * 1e-5);
  const areaEps = diag * diag * 1e-10; // 退化面按面积 < ε 判定(技术方案 §55)

  // 焊接:量化坐标 → 唯一顶点编号
  const weldMap = new Map<string, number>();
  const vertexCount = positions.length / 3;
  const remap = new Uint32Array(vertexCount);
  let unique = 0;
  for (let v = 0; v < vertexCount; v++) {
    const key = `${Math.round(positions[v * 3] / eps)},${Math.round(positions[v * 3 + 1] / eps)},${Math.round(positions[v * 3 + 2] / eps)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = unique++;
      weldMap.set(key, id);
    }
    remap[v] = id;
  }

  // 邻接统计:边 key 打包为单个数值(unique < 2^26 时 a*2^26+b 在 2^53 安全范围内)
  const PACK = 1 << 26;
  const usePacked = unique < PACK;
  const edges = new Map<number | string, number>();
  const edgeKey = (a: number, b: number): number | string => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return usePacked ? lo * PACK + hi : `${lo}_${hi}`;
  };

  let degenerate = 0;
  const triIdx = (t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);
  for (let t = 0; t < triCount; t++) {
    const a = remap[triIdx(t, 0)];
    const b = remap[triIdx(t, 1)];
    const c = remap[triIdx(t, 2)];
    if (a === b || b === c || a === c) {
      degenerate++; // 顶点塌缩:不参与边统计(其"边"没有面语义)
      continue;
    }
    // 面积检查(叉积模长的一半)
    const i0 = triIdx(t, 0) * 3;
    const i1 = triIdx(t, 1) * 3;
    const i2 = triIdx(t, 2) * 3;
    const ux = positions[i1] - positions[i0];
    const uy = positions[i1 + 1] - positions[i0 + 1];
    const uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0];
    const vy = positions[i2 + 1] - positions[i0 + 1];
    const vz = positions[i2 + 2] - positions[i0 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (0.5 * Math.hypot(cx, cy, cz) < areaEps) degenerate++; // 狭长面:计退化,但保留拓扑参与
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = edgeKey(x, y);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }

  let boundary = 0;
  let nonManifold = 0;
  for (const n of edges.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }

  return {
    faces: triCount,
    weldedVertices: unique,
    degenerateCount: degenerate,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    watertight: triCount > 0 && boundary === 0 && nonManifold === 0,
  };
}
