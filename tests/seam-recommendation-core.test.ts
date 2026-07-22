import { describe, expect, it } from 'vitest';
import { evaluatePlaneCutCandidate } from '../src/split/plane-cut-core';
import type { PlaneSectionSummary } from '../src/split/plane-section-core';
import { rankSeamRecommendations, type SeamScanSample } from '../src/split/seam-recommendation-core';

const bounds = {
  min: [-150, -40, 0] as [number, number, number],
  max: [150, 40, 80] as [number, number, number],
};
const bed = { x: 256, y: 256, z: 256 };

function section(overrides: Partial<PlaneSectionSummary> = {}): PlaneSectionSummary {
  return {
    status: 'closed',
    complete: true,
    facesTotal: 100,
    facesTested: 100,
    segmentCount: 20,
    loopCount: 1,
    openChainCount: 0,
    branchPointCount: 0,
    coplanarFaceCount: 0,
    perimeterMm: 100,
    areaMm2: 500,
    warnings: [],
    ...overrides,
  };
}

function sample(position: number, overrides: Partial<PlaneSectionSummary> = {}): SeamScanSample {
  return {
    axis: 'x',
    axisIndex: 0,
    normalizedPosition: position,
    candidate: evaluatePlaneCutCandidate(bounds, bed, 'x', position),
    section: section(overrides),
  };
}

describe('M1.7.7 几何低风险接缝评分', () => {
  it('只接受双侧入床且完整闭合、有正面积的截面', () => {
    const samples = [
      sample(0.2, { status: 'open', areaMm2: null, openChainCount: 1 }),
      sample(0.3, { complete: false, status: 'partial', areaMm2: null }),
      sample(0.5),
      sample(0.9), // 270mm 一侧仍超床
    ];
    const ranked = rankSeamRecommendations(samples);
    expect(ranked.map((item) => item.normalizedPosition)).toEqual([0.5]);
  });

  it('相邻切片之间的局部薄颈优先于同轴宽截面', () => {
    const ranked = rankSeamRecommendations([
      sample(0.4, { areaMm2: 900, perimeterMm: 120 }),
      sample(0.5, { areaMm2: 120, perimeterMm: 48 }),
      sample(0.6, { areaMm2: 900, perimeterMm: 120 }),
    ]);
    expect(ranked[0].normalizedPosition).toBe(0.5);
    expect(ranked[0].neckScore).toBeGreaterThan(0.9);
    expect(ranked[0].reasons).toContain('相邻切片对比显示局部较窄');
  });

  it('较简单、低截线密度的闭合截面得到更高评分', () => {
    const ranked = rankSeamRecommendations([
      sample(0.3, { segmentCount: 16, loopCount: 1, areaMm2: 400, perimeterMm: 90 }),
      sample(0.7, { segmentCount: 180, loopCount: 4, areaMm2: 400, perimeterMm: 90 }),
    ]);
    expect(ranked[0].normalizedPosition).toBe(0.3);
    expect(ranked[0].detailRisk).toBeLessThan(ranked[1].detailRisk);
    expect(ranked[1].risks.some((risk) => risk.includes('闭合环'))).toBe(true);
  });

  it('同一轴的推荐保持至少 15% 间距，避免给出近似重复点', () => {
    const ranked = rankSeamRecommendations([
      sample(0.2), sample(0.3), sample(0.4), sample(0.5), sample(0.6), sample(0.7), sample(0.8),
    ], 3);
    expect(ranked).toHaveLength(3);
    for (let a = 0; a < ranked.length; a += 1) {
      for (let b = a + 1; b < ranked.length; b += 1) {
        expect(Math.abs(ranked[a].normalizedPosition - ranked[b].normalizedPosition)).toBeGreaterThanOrEqual(0.15);
      }
    }
  });
});

