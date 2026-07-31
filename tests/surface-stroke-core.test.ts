import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/kernel/types';
import {
  simplifySurfaceStroke,
  surfaceStrokeClosureGap,
  surfaceStrokeLength,
} from '../src/split/surface-stroke-core';

describe('surface stroke core', () => {
  it('measures an open stroke and its automatic closure segment', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [3, 0, 0],
      [3, 4, 0],
    ];
    expect(surfaceStrokeLength(points)).toBe(7);
    expect(surfaceStrokeClosureGap(points)).toBe(5);
    expect(surfaceStrokeLength(points, true)).toBe(12);
  });

  it('simplifies dense straight samples while preserving both endpoints', () => {
    const points = Array.from({ length: 101 }, (_, index) => [index, 0, 0] as Vec3);
    const simplified = simplifySurfaceStroke(points, 0.1, 64);
    expect(simplified).toEqual([
      [0, 0, 0],
      [100, 0, 0],
    ]);
  });

  it('honors the point budget for a detailed stroke', () => {
    const points = Array.from(
      { length: 120 },
      (_, index) => [index, index % 2 ? 1 : -1, Math.sin(index)] as Vec3,
    );
    const simplified = simplifySurfaceStroke(points, 0, 16);
    expect(simplified).toHaveLength(16);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified.at(-1)).toEqual(points.at(-1));
  });

  it('drops non-finite input samples before simplification', () => {
    const simplified = simplifySurfaceStroke([
      [0, 0, 0],
      [Number.NaN, 1, 2],
      [5, 0, 0],
    ], 0.1);
    expect(simplified).toEqual([
      [0, 0, 0],
      [5, 0, 0],
    ]);
  });
});
