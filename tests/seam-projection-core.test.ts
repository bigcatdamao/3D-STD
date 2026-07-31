import { describe, expect, it } from 'vitest';
import { projectSeamLoop } from '../src/split/seam-projection-core';

describe('M1.11f.1 接缝封口投影', () => {
  it('accepts a non-planar joint loop that only crosses in the old dropped-axis projection', () => {
    const result = projectSeamLoop([
      [0.66273, 0, -1.05502],
      [0.93777, 0.93777, 1.3762],
      [0, 0.9373, 2.21654],
      [-0.76676, 0.76676, 1.58964],
      [-0.85539, 0, -1.54292],
      [-0.67946, -0.67946, -1.81781],
      [0, -0.91714, 2.30907],
      [0.62361, -0.62361, -2.45302],
    ]);

    expect(result.status).toBe('ready');
    expect(result.contour).toHaveLength(8);
    expect(Math.abs(result.signedArea2)).toBeGreaterThan(0);
  });

  it('still rejects a genuinely crossing planar loop', () => {
    const result = projectSeamLoop([
      [-2, -1, 0],
      [2, 2, 0],
      [-1, 1, 0],
      [1, -2, 0],
    ]);

    expect(result.status).toBe('self_intersection');
  });

  it('rejects a loop with no stable projection area', () => {
    const result = projectSeamLoop([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]);

    expect(result.status).toBe('degenerate');
  });
});
