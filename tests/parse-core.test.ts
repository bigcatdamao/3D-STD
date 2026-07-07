// T10 解析核心:三 loader 解码、顶点焊接 + 水密/退化预检、glTF 坐标烘焙、失败分类。
// 夹具全部在测试内程序化生成(ASCII/二进制 STL、OBJ 文本、手工拼装的最小 GLB),不依赖外部文件。
import { describe, expect, it } from 'vitest';
import {
  FAILURE_COPY,
  ParseFailure,
  bboxOfPositions,
  decode,
  detectFormat,
  weldAndAnalyze,
} from '../src/importer/parse-core';

// ---------- 夹具构造 ----------

type Tri = [number, number, number][]; // 三个顶点

/** 闭合四面体(4 面,每边恰被 2 面共享 → 水密),scale 控制包围盒尺度 */
function tetra(scale = 20): Tri[] {
  const A: [number, number, number] = [0, 0, 0];
  const B: [number, number, number] = [scale, 0, 0];
  const C: [number, number, number] = [0, scale, 0];
  const D: [number, number, number] = [0, 0, scale];
  return [
    [A, B, C],
    [A, B, D],
    [B, C, D],
    [A, C, D],
  ];
}

function asciiStl(tris: Tri[]): ArrayBuffer {
  const body = tris
    .map(
      (t) =>
        `  facet normal 0 0 0\n    outer loop\n${t
          .map((v) => `      vertex ${v[0]} ${v[1]} ${v[2]}`)
          .join('\n')}\n    endloop\n  endfacet`,
    )
    .join('\n');
  return new TextEncoder().encode(`solid fixture\n${body}\nendsolid fixture\n`).buffer;
}

function binaryStl(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12; // 法线置零
    for (const v of t) {
      dv.setFloat32(o, v[0], true);
      dv.setFloat32(o + 4, v[1], true);
      dv.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    o += 2; // attr
  }
  return buf;
}

function objText(tris: Tri[], mtllib: boolean): ArrayBuffer {
  const verts: string[] = [];
  const faces: string[] = [];
  let n = 0;
  for (const t of tris) {
    for (const v of t) verts.push(`v ${v[0]} ${v[1]} ${v[2]}`);
    faces.push(`f ${n + 1} ${n + 2} ${n + 3}`);
    n += 3;
  }
  const text = `${mtllib ? 'mtllib missing.mtl\n' : ''}${verts.join('\n')}\n${faces.join('\n')}\n`;
  return new TextEncoder().encode(text).buffer;
}

/** 最小 GLB:单三角形,glTF 规范坐标(Y-up · 米)。用于验证容器解析 + 烘焙。 */
function minimalGlb(): ArrayBuffer {
  // 顶点(米):(0,0,0) (0.1,0,0) (0,0.2,0) —— Y 向高 0.2m
  const positions = new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.2, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const binLen = positions.byteLength + indices.byteLength; // 36 + 6 = 42 → 补齐 44
  const binPadded = Math.ceil(binLen / 4) * 4;
  const json = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: binPadded }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.1, 0.2, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'will-be-stripped' }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = Math.ceil(jsonBytes.length / 4) * 4;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  u8.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonPadded; i++) u8[20 + i] = 0x20;
  const binStart = 20 + jsonPadded;
  dv.setUint32(binStart, binPadded, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // BIN\0
  u8.set(new Uint8Array(positions.buffer), binStart + 8);
  u8.set(new Uint8Array(indices.buffer), binStart + 8 + positions.byteLength);
  return buf;
}

const failCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof ParseFailure ? e.code : 'not-parse-failure';
  }
};

// ---------- 格式白名单(IMP-01 入口分类) ----------

describe('detectFormat 白名单与拒绝分类', () => {
  it('四种支持格式,扩展名大小写不敏感', () => {
    expect(detectFormat('a.stl')).toBe('stl');
    expect(detectFormat('B.STL')).toBe('stl');
    expect(detectFormat('c.obj')).toBe('obj');
    expect(detectFormat('d.glb')).toBe('glb');
    expect(detectFormat('e.gltf')).toBe('gltf');
  });
  it('FBX/STEP 拒绝并给替代建议,3MF 标注 P1,未知扩展名分类明确', () => {
    expect(() => detectFormat('x.fbx')).toThrowError(FAILURE_COPY['rejected-fbx']);
    expect(() => detectFormat('x.step')).toThrowError(FAILURE_COPY['rejected-step']);
    expect(() => detectFormat('x.stp')).toThrowError(FAILURE_COPY['rejected-step']);
    expect(() => detectFormat('x.3mf')).toThrowError(FAILURE_COPY['3mf-p1']);
    expect(() => detectFormat('x.xyz')).toThrowError(FAILURE_COPY['unknown-ext']);
  });
});

// ---------- 焊接 + 拓扑(IMP-07) ----------

describe('顶点焊接与水密/退化预检', () => {
  it('STL 式逐三角形独立顶点:焊接后闭合四面体判水密(不焊接会全量误报——本用例即回归锚)', () => {
    const tris = tetra();
    const positions = new Float32Array(tris.flat(2));
    const t = weldAndAnalyze(positions, null);
    expect(t.faces).toBe(4);
    expect(t.weldedVertices).toBe(4); // 12 个存储顶点焊成 4 个
    expect(t.boundaryEdges).toBe(0);
    expect(t.nonManifoldEdges).toBe(0);
    expect(t.watertight).toBe(true);
    expect(t.degenerateCount).toBe(0);
  });

  it('去掉一个面 → 3 条边界边,非水密', () => {
    const tris = tetra().slice(0, 3);
    const t = weldAndAnalyze(new Float32Array(tris.flat(2)), null);
    expect(t.faces).toBe(3);
    expect(t.boundaryEdges).toBe(3);
    expect(t.watertight).toBe(false);
  });

  it('退化面(顶点塌缩/近零面积)计数,且不误伤主体水密判定', () => {
    const tris = tetra();
    tris.push([
      [5, 5, 5],
      [5, 5, 5],
      [5, 5, 5],
    ]); // 塌缩三角形
    const t = weldAndAnalyze(new Float32Array(tris.flat(2)), null);
    expect(t.degenerateCount).toBe(1);
    expect(t.watertight).toBe(true); // 塌缩面不参与边统计,主体四面体仍水密
  });

  it('索引几何走同一分析通道', () => {
    // 两三角形拼的开放方片:对角边共享(2),外圈 4 条边界
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
    const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const t = weldAndAnalyze(positions, index);
    expect(t.faces).toBe(2);
    expect(t.weldedVertices).toBe(4);
    expect(t.boundaryEdges).toBe(4);
    expect(t.watertight).toBe(false);
  });
});

// ---------- 三 loader 解码 ----------

describe('decode:STL(二进制 + ASCII)', () => {
  it('ASCII STL → 非索引顶点流,统计正确', async () => {
    const m = await decode('stl', asciiStl(tetra()));
    expect(m.positions.length).toBe(4 * 3 * 3);
    expect(m.gltfBaked).toBe(false);
    const t = weldAndAnalyze(m.positions, m.index);
    expect(t.watertight).toBe(true);
  });

  it('二进制 STL → 与 ASCII 同构结果;包围盒按原始单位', async () => {
    const m = await decode('stl', binaryStl(tetra(20)));
    const bb = bboxOfPositions(m.positions);
    expect(bb.max).toEqual([20, 20, 20]);
    expect(weldAndAnalyze(m.positions, m.index).faces).toBe(4);
  });

  it('空网格分类为 empty', async () => {
    expect(await failCode(decode('stl', binaryStl([])))).toBe('empty');
    expect(await failCode(decode('stl', new ArrayBuffer(0)))).toBe('empty');
  });
});

describe('decode:OBJ', () => {
  it('解析三角面,mtllib 引用触发缺材质标记(IMP-07 降级不拒绝)', async () => {
    const m = await decode('obj', objText(tetra(), true));
    expect(m.materialMissing).toBe(true);
    expect(weldAndAnalyze(m.positions, m.index).watertight).toBe(true);
  });
  it('无 mtllib 不标记', async () => {
    const m = await decode('obj', objText(tetra(), false));
    expect(m.materialMissing).toBe(false);
  });
  it('无几何 OBJ 分类为 empty', async () => {
    expect(await failCode(decode('obj', new TextEncoder().encode('# empty\n').buffer))).toBe('empty');
  });
});

describe('decode:GLB 与 glTF(坐标烘焙 IMP-06/C3 + 材质剥离)', () => {
  it('Y-up 米 → Z-up 毫米一次烘焙:0.2m 的 Y 向高度变为 200mm 的 Z 向高度', async () => {
    const m = await decode('glb', minimalGlb());
    expect(m.gltfBaked).toBe(true);
    const bb = bboxOfPositions(m.positions);
    expect(bb.max[0]).toBeCloseTo(100, 3); // 0.1m → 100mm
    expect(Math.abs(bb.max[1] - bb.min[1])).toBeLessThan(1e-3); // 原 Z 向(此件为 0)
    expect(bb.max[2]).toBeCloseTo(200, 3); // 原 Y 向高度落到 Z
  });

  it('材质引用被容器手术剥离(含 material 索引的 GLB 无需图像解码即成功)', async () => {
    // minimalGlb 的 primitive 带 material:0 且 materials 非空 —— 能解通过本身即证明剥离生效
    const m = await decode('glb', minimalGlb());
    expect(m.positions.length).toBe(9);
  });

  it('损坏 GLB(魔数不符)分类为 corrupt', async () => {
    expect(await failCode(decode('glb', new Uint8Array(32).fill(7).buffer))).toBe('corrupt');
  });

  it('.gltf 引用外部 buffer → external-ref;声明 Draco 必需扩展 → compressed', async () => {
    const ext = { asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin', byteLength: 4 }] };
    expect(await failCode(decode('gltf', new TextEncoder().encode(JSON.stringify(ext)).buffer))).toBe(
      'external-ref',
    );
    const draco = { asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] };
    expect(await failCode(decode('gltf', new TextEncoder().encode(JSON.stringify(draco)).buffer))).toBe(
      'compressed',
    );
  });
});
