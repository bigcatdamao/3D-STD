import { describe, expect, it } from 'vitest';
import { createSurfaceAdaptiveCut } from '../src/split/surface-cut-core';
import type { Transform } from '../src/kernel/types';

const transform: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

function makeWaistPrism() {
  const xs = [-120, -80, -40, 20, 60, 100, 140];
  const radii = [45, 45, 40, 16, 40, 45, 45];
  const sides = 16;
  const positions: number[] = [];
  for (let ring = 0; ring < xs.length; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const angle = (side / sides) * Math.PI * 2;
      positions.push(xs[ring], Math.cos(angle) * radii[ring], Math.sin(angle) * radii[ring]);
    }
  }
  const leftCenter = positions.length / 3;
  positions.push(xs[0], 0, 0);
  const rightCenter = positions.length / 3;
  positions.push(xs[xs.length - 1], 0, 0);
  const indices: number[] = [];
  for (let ring = 0; ring < xs.length - 1; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides;
      const a = ring * sides + side;
      const d = ring * sides + next;
      const b = (ring + 1) * sides + side;
      const c = (ring + 1) * sides + next;
      indices.push(a, d, b, d, c, b);
    }
  }
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    indices.push(leftCenter, next, side);
    const base = (xs.length - 1) * sides;
    indices.push(rightCenter, base + side, base + next);
  }
  return {
    positions: new Float32Array(positions),
    index: new Uint32Array(indices),
  };
}

function makeDenseJointPrism(rings = 52, sides = 1024) {
  const positions: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const x = -120 + (240 * ring) / (rings - 1);
    const radius = 36 + Math.sin((ring / (rings - 1)) * Math.PI) * 4;
    for (let side = 0; side < sides; side += 1) {
      const angle = (side / sides) * Math.PI * 2;
      positions.push(x, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
  }
  const leftCenter = positions.length / 3;
  positions.push(-120, 0, 0);
  const rightCenter = positions.length / 3;
  positions.push(120, 0, 0);
  const indices: number[] = [];
  for (let ring = 0; ring < rings - 1; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides;
      const a = ring * sides + side;
      const d = ring * sides + next;
      const b = (ring + 1) * sides + side;
      const c = (ring + 1) * sides + next;
      indices.push(a, d, b, d, c, b);
    }
  }
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    indices.push(leftCenter, next, side);
    const base = (rings - 1) * sides;
    indices.push(rightCenter, base + side, base + next);
  }
  return {
    positions: new Float32Array(positions),
    index: new Uint32Array(indices),
    rings,
    sides,
  };
}

describe('M1.7.8 表面自适应真实切割核心', () => {
  it('M1.11f 对完整独立壳体只做 A/B 分组，不生成伪切口或封口', () => {
    const first = makeWaistPrism();
    const second = makeWaistPrism();
    const firstVertexCount = first.positions.length / 3;
    const firstFaceCount = first.index.length / 3;
    const secondFaceCount = second.index.length / 3;
    const secondPositions = Array.from(second.positions);
    for (let index = 1; index < secondPositions.length; index += 3) secondPositions[index] += 120;
    const faceLabels = new Uint8Array(firstFaceCount + secondFaceCount);
    faceLabels.fill(1, firstFaceCount);

    const result = createSurfaceAdaptiveCut({
      positions: new Float32Array([...first.positions, ...secondPositions]),
      index: new Uint32Array([
        ...first.index,
        ...Array.from(second.index, (vertex) => vertex + firstVertexCount),
      ]),
      faceLabels,
      transform,
      searchHalfWidthMm: 0.1,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.partA.sourceFaceCount).toBe(secondFaceCount);
    expect(result.partB.sourceFaceCount).toBe(firstFaceCount);
    expect(result.partA.capFaceCount).toBe(0);
    expect(result.partB.capFaceCount).toBe(0);
    expect(result.metrics.boundaryVertices).toBe(0);
    expect(result.seamPositions.length).toBe(0);
    expect(result.warnings[0]).toContain('壳体分组');
    expect(result.warnings[0]).toContain('不新增切口或封口');
  });

  it('M1.11f 合并完整壳体与一个桥接壳体接缝，生成统一 A/B 结果', () => {
    const bridge = makeWaistPrism();
    const accessory = makeWaistPrism();
    const bridgeVertexCount = bridge.positions.length / 3;
    const bridgeFaceCount = bridge.index.length / 3;
    const accessoryFaceCount = accessory.index.length / 3;
    const accessoryPositions = Array.from(accessory.positions);
    for (let index = 1; index < accessoryPositions.length; index += 3) accessoryPositions[index] += 120;
    const faceLabels = new Uint8Array(bridgeFaceCount + accessoryFaceCount);
    faceLabels.fill(1, 0, 16 * 2 * 3);
    const capStart = 16 * 2 * 6;
    for (let side = 0; side < 16; side += 1) faceLabels[capStart + side * 2] = 1;
    faceLabels.fill(1, bridgeFaceCount);

    const result = createSurfaceAdaptiveCut({
      positions: new Float32Array([...bridge.positions, ...accessoryPositions]),
      index: new Uint32Array([
        ...bridge.index,
        ...Array.from(accessory.index, (vertex) => vertex + bridgeVertexCount),
      ]),
      faceLabels,
      transform,
      searchHalfWidthMm: 0.1,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.partA.sourceFaceCount).toBe(112 + accessoryFaceCount);
    expect(result.partB.sourceFaceCount).toBe(bridgeFaceCount - 112);
    expect(result.metrics.boundaryVertices).toBe(16);
    expect(result.partA.capFaceCount).toBe(14);
    expect(result.partB.capFaceCount).toBe(14);
    expect(result.partA.boundaryEdges).toBe(0);
    expect(result.partB.boundaryEdges).toBe(0);
  });

  it('M1.11c 以紫色面组为拆下件 A，并沿唯一闭环为 A/B 生成同一组封口', () => {
    const mesh = makeWaistPrism();
    const faceCount = mesh.index.length / 3;
    const faceLabels = new Uint8Array(faceCount);
    // 选择左端盖与前三段侧壁，边界正好是第 3/4 个环之间的单一闭环。
    faceLabels.fill(1, 0, 16 * 2 * 3);
    const capStart = 16 * 2 * 6;
    for (let side = 0; side < 16; side += 1) faceLabels[capStart + side * 2] = 1;
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      faceLabels,
      transform,
      searchHalfWidthMm: 0.1,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.partA.sourceFaceCount).toBe(112);
    expect(result.partB.sourceFaceCount).toBe(faceCount - 112);
    expect(result.metrics.boundaryVertices).toBe(16);
    expect(result.partA.capFaceCount).toBe(14);
    expect(result.partB.capFaceCount).toBe(14);
    expect(result.partA.boundaryEdges).toBe(0);
    expect(result.partB.boundaryEdges).toBe(0);
    expect(result.metrics.guideOffsetMm).toBe(0);
    expect(result.metrics.adaptiveSpanMm).toBe(0);
    expect(result.warnings[0]).toContain('紫色面组');
  });

  it('M1.11c 面组数量与三角面不一致时 fail-closed', () => {
    const mesh = makeWaistPrism();
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      faceLabels: new Uint8Array(3),
      transform,
      searchHalfWidthMm: 0.1,
    });
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.code).toBe('invalid_geometry');
      expect(result.message).toContain('面数不一致');
    }
  });

  it('M1.11d 面组通道使用独立的局部面数预算，不再受自动寻路 8 万面预算控制', () => {
    const mesh = makeWaistPrism();
    const faceCount = mesh.index.length / 3;
    const faceLabels = new Uint8Array(faceCount);
    faceLabels.fill(1, 0, 16 * 2 * 3);
    const capStart = 16 * 2 * 6;
    for (let side = 0; side < 16; side += 1) faceLabels[capStart + side * 2] = 1;
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      faceLabels,
      transform,
      searchHalfWidthMm: 0.1,
      selectedFaceBudget: 20,
    });
    expect(result.status).toBe('unsupported');
    if (result.status !== 'unsupported') return;
    expect(result.code).toBe('budget');
    expect(result.message).toContain('关节精细拆件');
    expect(result.details?.selectedFaces).toBe(112);
  });

  it('M1.11d 对超过旧版 8 万面限制的模型执行局部关节切割', () => {
    const mesh = makeDenseJointPrism();
    const faceCount = mesh.index.length / 3;
    expect(faceCount).toBeGreaterThan(80_000);
    const faceLabels = new Uint8Array(faceCount);
    const selectedBands = 3;
    faceLabels.fill(1, 0, selectedBands * mesh.sides * 2);
    const capStart = (mesh.rings - 1) * mesh.sides * 2;
    for (let side = 0; side < mesh.sides; side += 1) {
      faceLabels[capStart + side * 2] = 1;
    }
    const result = createSurfaceAdaptiveCut({
      positions: mesh.positions,
      index: mesh.index,
      faceLabels,
      transform,
      searchHalfWidthMm: 0.1,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.metrics.sourceFaces).toBe(faceCount);
    expect(result.metrics.boundaryVertices).toBe(mesh.sides);
    expect(result.partA.sourceFaceCount).toBe(selectedBands * mesh.sides * 2 + mesh.sides);
    expect(result.partA.boundaryEdges).toBe(0);
    expect(result.partB.boundaryEdges).toBe(0);
  });

  it('接缝会离开引导平面，吸附到搜索带内更短的收腰环，并输出两个闭合临时网格', () => {
    const mesh = makeWaistPrism();
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      transform,
      axisIndex: 0,
      guidePositionMm: 0,
      searchHalfWidthMm: 70,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.metrics.guideOffsetMm).toBeGreaterThan(8);
    expect(result.metrics.guideOffsetMm).toBeLessThan(35);
    expect(result.metrics.boundaryVertices).toBe(16);
    expect(result.metrics.seamLengthMm).toBeGreaterThan(90);
    expect(result.metrics.seamLengthMm).toBeLessThan(110);
    expect(result.partA.boundaryEdges).toBe(0);
    expect(result.partB.boundaryEdges).toBe(0);
    expect(result.partA.capFaceCount).toBe(14);
    expect(result.partB.capFaceCount).toBe(14);
    expect(result.metrics.maxCapDeviationMm).toBeCloseTo(0, 5);
    expect(result.metrics.capWarpRatio).toBeCloseTo(0, 5);
    expect(result.partA.positions.length).toBeGreaterThan(0);
    expect(result.partB.positions.length).toBeGreaterThan(0);
  });

  it('任意世界引导平面会随实例旋转，不再限定世界 X/Y/Z 数值入口', () => {
    const mesh = makeWaistPrism();
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      transform: { ...transform, rotation: [0, 0, 90] },
      guideOriginWorld: [0, 0, 0],
      guideNormalWorld: [0, 1, 0],
      searchHalfWidthMm: 70,
      preference: 'crease',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.metrics.preference).toBe('crease');
    expect(result.metrics.guideOffsetMm).toBeGreaterThan(8);
    expect(result.partA.boundaryEdges).toBe(0);
    expect(result.partB.boundaryEdges).toBe(0);
  });

  it('贴面控制点闭环会把实际接缝约束在手绘线附近，而不是自动跳到远处最细腰线', () => {
    const mesh = makeWaistPrism();
    const guidePointsWorld = Array.from({ length: 16 }, (_, side) => {
      const angle = (side / 16) * Math.PI * 2;
      return [-40, Math.cos(angle) * 40, Math.sin(angle) * 40] as [number, number, number];
    });
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      transform,
      guideOriginWorld: [-40, 0, 0],
      guideNormalWorld: [1, 0, 0],
      guidePointsWorld,
      searchHalfWidthMm: 24,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.metrics.guideOffsetMm).toBeLessThan(8);
    expect(result.metrics.boundaryVertices).toBe(16);
    expect(result.partA.boundaryEdges).toBe(0);
    expect(result.partB.boundaryEdges).toBe(0);
  });

  it('开口或非流形源模型直接拒绝，不生成看似成功的零件', () => {
    const result = createSurfaceAdaptiveCut({
      positions: new Float32Array([
        0, 0, 0,
        10, 0, 0,
        0, 10, 0,
      ]),
      index: null,
      transform,
      axisIndex: 0,
      guidePositionMm: 3,
      searchHalfWidthMm: 1,
    });
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.code).toBe('non_manifold_source');
  });

  it('两个彼此独立的水密壳也直接拒绝，不能冒充单一可切割对象', () => {
    const first = makeWaistPrism();
    const second = makeWaistPrism();
    const firstVertexCount = first.positions.length / 3;
    const secondPositions = Array.from(second.positions);
    for (let index = 1; index < secondPositions.length; index += 3) secondPositions[index] += 120;
    const result = createSurfaceAdaptiveCut({
      positions: new Float32Array([...first.positions, ...secondPositions]),
      index: new Uint32Array([
        ...first.index,
        ...Array.from(second.index, (vertex) => vertex + firstVertexCount),
      ]),
      transform,
      axisIndex: 0,
      guidePositionMm: 0,
      searchHalfWidthMm: 70,
    });
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.code).toBe('non_manifold_source');
      expect(result.message).toContain('单一连通');
      expect(result.details?.connectedComponents).toBe(2);
    }
  });

  it('面数预算触顶时 fail-closed，不抽样执行真实切割', () => {
    const mesh = makeWaistPrism();
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      transform,
      axisIndex: 0,
      guidePositionMm: 0,
      searchHalfWidthMm: 70,
      faceBudget: 20,
    });
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.code).toBe('budget');
  });

  it('吸附带吞掉一侧种子时拒绝，并提示减小范围或移动位置', () => {
    const mesh = makeWaistPrism();
    const result = createSurfaceAdaptiveCut({
      ...mesh,
      transform,
      axisIndex: 0,
      guidePositionMm: 120,
      searchHalfWidthMm: 80,
    });
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.code).toBe('missing_seeds');
  });
});
