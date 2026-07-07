// IMP-05 单位推断置信分级:区间判定、推荐单位排序、预览换算。
import { describe, expect, it } from 'vitest';
import { fmtMm, inferUnit, sizeInMm } from '../src/importer/unit-infer';

describe('inferUnit 置信分级', () => {
  it('最大边 ∈ [10,400] → 静默 mm(含边界)', () => {
    expect(inferUnit(10).kind).toBe('silent-mm');
    expect(inferUnit(120).kind).toBe('silent-mm');
    expect(inferUnit(400).kind).toBe('silent-mm');
  });

  it('过小数值 → 询问,推荐能落回打印范围的单位(0.12 → m:120mm)', () => {
    const d = inferUnit(0.12);
    expect(d.kind).toBe('ask');
    if (d.kind === 'ask') expect(d.recommended).toBe('m'); // 0.12m = 120mm ∈ [10,400]
  });

  it('中间量级 → 推荐 cm 或 inch 中能落区间者(3 → cm:30mm)', () => {
    const d = inferUnit(3);
    expect(d.kind === 'ask' && d.recommended).toBe('cm');
  });

  it('过大数值 → 询问且推荐保持 mm(1200:任何换算只会更大)', () => {
    const d = inferUnit(1200);
    expect(d.kind === 'ask' && d.recommended).toBe('mm');
  });

  it('多单位并列可行时按 mm→cm→inch→m 常见度取先(20 英寸件:inch 508 超上限,mm=20 在区间)', () => {
    const d = inferUnit(6); // mm:6(差4) cm:60 ∈区间 → cm
    expect(d.kind === 'ask' && d.recommended).toBe('cm');
  });
});

describe('sizeInMm 预览换算', () => {
  const bbox = { min: [0, 0, 0] as [number, number, number], max: [2, 4, 1] as [number, number, number] };
  it('四单位换算', () => {
    expect(sizeInMm(bbox, 'mm')).toEqual([2, 4, 1]);
    expect(sizeInMm(bbox, 'cm')).toEqual([20, 40, 10]);
    expect(sizeInMm(bbox, 'inch')[1]).toBeCloseTo(101.6);
    expect(sizeInMm(bbox, 'm')).toEqual([2000, 4000, 1000]);
  });
  it('文案格式:量级自适应小数位', () => {
    expect(fmtMm(203.2)).toBe('203');
    expect(fmtMm(25.4)).toBe('25.4');
    expect(fmtMm(0.518)).toBe('0.52');
  });
});
