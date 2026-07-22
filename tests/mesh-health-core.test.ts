import { describe, expect, it } from 'vitest';
import { analyzeMeshHealth } from '../src/check/mesh-health-core';

type Point = [number, number, number];
type Quad = [Point, Point, Point, Point];

function cube(size: number, center: Point = [0, 0, 0]): number[] {
  const h = size / 2;
  const v = (x: number, y: number, z: number): Point => [center[0] + x * h, center[1] + y * h, center[2] + z * h];
  const quads: Quad[] = [
    [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)],
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
    [v(1, 1, -1), v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1)],
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)],
    [v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return out;
}

describe('M1.7.1 深度网格只读检测', () => {
  it('单一封闭立方体：1 个闭合壳，无自交、内部壳或孤立碎片', () => {
    const result = analyzeMeshHealth(new Float32Array(cube(20)), null);
    expect(result).toMatchObject({
      connectedComponents: 1,
      closedComponents: 1,
      isolatedFragments: 0,
      internalShells: 0,
      selfIntersectionPairs: 0,
      selfIntersectionComplete: true,
    });
  });

  it('嵌套封闭立方体：识别 1 个疑似内部壳，但不存在表面相交', () => {
    const result = analyzeMeshHealth(new Float32Array([...cube(20), ...cube(5)]), null);
    expect(result.connectedComponents).toBe(2);
    expect(result.closedComponents).toBe(2);
    expect(result.internalShells).toBe(1);
    expect(result.isolatedFragments).toBe(0);
    expect(result.selfIntersectionPairs).toBe(0);
  });

  it('主体外单独三角片：识别小型孤立碎片及其面数', () => {
    const fragment = [40, 0, 0, 41, 0, 0, 40, 1, 0];
    const result = analyzeMeshHealth(new Float32Array([...cube(20), ...fragment]), null);
    expect(result.connectedComponents).toBe(2);
    expect(result.isolatedFragments).toBe(1);
    expect(result.isolatedFragmentFaces).toBe(1);
    expect(result.internalShells).toBe(0);
  });

  it('两个同等大小的分离实体：报告两个连通壳，但不误判为孤立碎片', () => {
    const result = analyzeMeshHealth(new Float32Array([
      ...cube(20, [-15, 0, 0]),
      ...cube(20, [15, 0, 0]),
    ]), null);
    expect(result.connectedComponents).toBe(2);
    expect(result.internalShells).toBe(0);
    expect(result.isolatedFragments).toBe(0);
    expect(result.selfIntersectionPairs).toBe(0);
    expect(result.componentEvidence).toHaveLength(2);
    expect(result.componentEvidence[0]).toMatchObject({
      componentIndex: 1,
      faceCount: 12,
      closed: true,
      kind: 'primary',
      previewComplete: true,
    });
    expect(result.componentEvidence[1]).toMatchObject({ componentIndex: 2, kind: 'separate' });
    expect(result.componentEvidenceComplete).toBe(true);
  });

  it('逐壳预览面数受独立预算保护，壳数量与完整诊断保持准确', () => {
    const result = analyzeMeshHealth(new Float32Array([
      ...cube(20, [-15, 0, 0]),
      ...cube(20, [15, 0, 0]),
    ]), null, { maxComponentPreviewFaces: 2 });
    expect(result.connectedComponents).toBe(2);
    expect(result.componentAnalysisComplete).toBe(true);
    expect(result.componentEvidence).toHaveLength(2);
    expect(result.componentEvidence.map((item) => item.sourceFaceIndices.length)).toEqual([1, 1]);
    expect(result.componentEvidence.every((item) => !item.previewComplete)).toBe(true);
    expect(result.componentEvidenceComplete).toBe(false);
  });

  it('两片不相邻三角形互相穿过：报告确定自交', () => {
    const positions = new Float32Array([
      -2, -2, 0, 2, -2, 0, 0, 2, 0,
      0, -1, -1, 0, 1, -1, 0, 0, 1,
    ]);
    const result = analyzeMeshHealth(positions, null);
    expect(result.selfIntersectionPairs).toBe(1);
    expect(result.selfIntersectionComplete).toBe(true);
    expect(result.selfIntersectionEvidence).toHaveLength(1);
    expect(result.selfIntersectionEvidence[0]).toMatchObject({ faceA: 1, faceB: 2 });
    expect(result.selfIntersectionEvidence[0].triangleA).toEqual([
      [-2, -2, 0], [2, -2, 0], [0, 2, 0],
    ]);
  });

  it('命中数量可继续统计，但传回主线程的局部证据受独立预算保护', () => {
    const positions = new Float32Array([
      -2, -2, 0, 2, -2, 0, 0, 2, 0,
      0, -1, -1, 0, 1, -1, 0, 0, 1,
      -1, 0, -1, 1, 0, -1, 0, 0, 1,
    ]);
    const result = analyzeMeshHealth(positions, null, { maxSelfIntersectionEvidence: 1 });
    expect(result.selfIntersectionPairs).toBeGreaterThan(1);
    expect(result.selfIntersectionEvidence).toHaveLength(1);
  });

  it('超过扫描预算时明确标记为部分检测，不把零命中表述为完整通过', () => {
    const result = analyzeMeshHealth(new Float32Array(cube(20)), null, {
      maxSelfIntersectionTriangles: 4,
      maxComponentAnalysisTriangles: 4,
    });
    expect(result.selfIntersectionTrianglesScanned).toBe(4);
    expect(result.selfIntersectionComplete).toBe(false);
    expect(result.componentAnalysisComplete).toBe(false);
    expect(result.connectedComponents).toBe(0);
    expect(result.selfIntersectionEvidence).toEqual([]);
  });
});
