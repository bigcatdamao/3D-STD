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
  });

  it('两片不相邻三角形互相穿过：报告确定自交', () => {
    const positions = new Float32Array([
      -2, -2, 0, 2, -2, 0, 0, 2, 0,
      0, -1, -1, 0, 1, -1, 0, 0, 1,
    ]);
    const result = analyzeMeshHealth(positions, null);
    expect(result.selfIntersectionPairs).toBe(1);
    expect(result.selfIntersectionComplete).toBe(true);
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
  });
});
