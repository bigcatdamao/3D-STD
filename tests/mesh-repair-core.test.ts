import { describe, expect, it } from 'vitest';
import { planMeshRepair } from '../src/repair/mesh-repair-core';

type Point = [number, number, number];
type Quad = [Point, Point, Point, Point];

const trianglesOf = (quads: Quad[]): Float32Array => {
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return new Float32Array(out);
};

function boxQuads(size = 20): Quad[] {
  const h = size / 2;
  const v = (x: number, y: number, z: number): Point => [x * h, y * h, z * h];
  return [
    [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)],
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
    [v(1, 1, -1), v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1)],
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)],
    [v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)],
  ];
}

describe('M1.7 确定性网格修复', () => {
  it('为开口盒补上一个平面边界环，并产出可验证的水密副本', () => {
    const openBox = trianglesOf(boxQuads().filter((_, index) => index !== 1));
    const plan = planMeshRepair(openBox, null);

    expect(plan.status).toBe('ready');
    expect(plan.stats.before.boundaryEdges).toBe(4);
    expect(plan.stats.filledHoles).toBe(1);
    expect(plan.stats.addedFaces).toBe(2);
    expect(plan.stats.after).toMatchObject({
      faces: 12,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      watertight: true,
    });
    expect(plan.repairedPositions).toHaveLength(12 * 9);
    expect(plan.addedPositions).toHaveLength(2 * 9);
    expect(plan.warnings[0]).toContain('设计意图');
  });

  it('删除封闭立方体中附加的塌缩三角形', () => {
    const cube = trianglesOf(boxQuads());
    const withDegenerate = new Float32Array([...cube, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
    const plan = planMeshRepair(withDegenerate, null);

    expect(plan.status).toBe('ready');
    expect(plan.stats.removedDegenerateFaces).toBe(1);
    expect(plan.stats.filledHoles).toBe(0);
    expect(plan.stats.after?.watertight).toBe(true);
    expect(plan.stats.after?.faces).toBe(12);
    expect(plan.removedPositions).toHaveLength(9);
  });

  it('非流形边直接拒绝，不尝试猜测拓扑', () => {
    const mesh = new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 10, 0,
      10, 0, 0, 0, 0, 0, 0, -10, 0,
      0, 0, 0, 10, 0, 0, 0, 0, 10,
    ]);
    const plan = planMeshRepair(mesh, null);

    expect(plan.status).toBe('unsupported');
    expect(plan.reason).toContain('非流形边');
    expect(plan.repairedPositions).toBeNull();
    expect(plan.removedPositions).toHaveLength(0);
  });

  it('非平面开口直接拒绝，避免自动封口扭曲表面', () => {
    const quads = boxQuads();
    quads.splice(1, 1);
    // 抬高顶缘一个角点；边界仍是闭环，但四点不共面。
    for (const quad of quads) {
      for (const point of quad) {
        if (point[0] === 10 && point[1] === 10 && point[2] === 10) point[2] = 13;
      }
    }
    const plan = planMeshRepair(trianglesOf(quads), null);

    expect(plan.status).toBe('unsupported');
    expect(plan.reason).toContain('不是近似平面');
    expect(plan.repairedPositions).toBeNull();
  });
});
