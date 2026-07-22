import { describe, expect, it } from 'vitest';
import { dimensionsOf, findPlaneCutCandidates } from '../src/split/plane-cut-core';

describe('M1.7.4 平面切割候选核心', () => {
  it('300×80×80 单壳优先推荐 X 中切，切后两侧都能进入 256mm 床', () => {
    const candidates = findPlaneCutCandidates(
      { min: [-150, -40, 0], max: [150, 40, 80] },
      { x: 256, y: 256, z: 256 },
    );
    expect(candidates).toHaveLength(3);
    expect(candidates[0].axis).toBe('x');
    expect(candidates[0].positionMm).toBe(0);
    expect(candidates[0].score).toBe(100);
    expect(candidates[0].fitsBedAfter).toBe(true);
    expect(candidates[0].parts.map((part) => part.dimensionsMm)).toEqual([
      [150, 80, 80],
      [150, 80, 80],
    ]);
    expect(candidates[0].parts.every((part) => part.fitsBed)).toBe(true);
    expect(candidates[1].fitsBedAfter).toBe(false);
    expect(candidates[2].fitsBedAfter).toBe(false);
  });

  it('超过床尺寸两倍时，一次中切仍明确标为超床', () => {
    const candidate = findPlaneCutCandidates(
      { min: [-300, -40, 0], max: [300, 40, 80] },
      { x: 256, y: 256, z: 256 },
    )[0];
    expect(candidate.axis).toBe('x');
    expect(candidate.parts[0].dimensionsMm[0]).toBe(300);
    expect(candidate.fitsBedAfter).toBe(false);
    expect(candidate.remainingOverflowAxes).toContain('x');
  });

  it('分割包围盒在候选平面处连续，且不改变另两轴范围', () => {
    const x = findPlaneCutCandidates(
      { min: [-20, -10, 3], max: [80, 30, 23] },
      { x: 60, y: 60, z: 60 },
    ).find((candidate) => candidate.axis === 'x')!;
    expect(x.positionMm).toBe(30);
    expect(x.parts[0].bounds.max[0]).toBe(30);
    expect(x.parts[1].bounds.min[0]).toBe(30);
    expect(dimensionsOf(x.parts[0].bounds)).toEqual([50, 40, 20]);
    expect(dimensionsOf(x.parts[1].bounds)).toEqual([50, 40, 20]);
  });
});
