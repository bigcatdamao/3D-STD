import { describe, expect, it } from 'vitest';
import { prepareAutoSplitParts } from '../src/split/auto-split-result-core';

const triangle = (offset: number) => new Float32Array([
  offset, 0, 0,
  offset + 1, 0, 0,
  offset, 1, 0,
]);

describe('M1.13b 自动拆件结果归一', () => {
  it('保留多个独立零件并对齐源资产局部包围盒', () => {
    const result = prepareAutoSplitParts([
      { name: 'arm', positions: triangle(0), normals: null },
      { name: 'body', positions: triangle(1), normals: null },
    ], { min: [-10, -5, 0], max: [10, 5, 10] });

    expect(result).toHaveLength(2);
    const all = result.flatMap((part) => [...part.positions]);
    const xs = all.filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-10);
    expect(Math.max(...xs)).toBeCloseTo(10);
    expect(result.every((part) => part.faces === 1)).toBe(true);
  });

  it('结果不足两个零件时失败关闭', () => {
    expect(() => prepareAutoSplitParts([
      { name: 'only', positions: triangle(0), normals: null },
    ], { min: [0, 0, 0], max: [10, 10, 10] })).toThrow('至少两个');
  });
});
