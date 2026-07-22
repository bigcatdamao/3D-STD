import type { CutAxis, PlaneCutCandidate } from './plane-cut-core';
import type { PlaneSectionSummary } from './plane-section-core';

export interface SeamScanSample {
  axis: CutAxis;
  axisIndex: 0 | 1 | 2;
  normalizedPosition: number;
  candidate: PlaneCutCandidate;
  section: PlaneSectionSummary;
}

export interface SeamRecommendation {
  id: string;
  axis: CutAxis;
  axisIndex: 0 | 1 | 2;
  normalizedPosition: number;
  positionMm: number;
  score: number;
  areaMm2: number;
  perimeterMm: number;
  loopCount: number;
  fitBothSides: boolean;
  neckScore: number;
  compactnessScore: number;
  detailRisk: number;
  balanceScore: number;
  reasons: string[];
  risks: string[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizedInverse(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(max - min) < 1e-9) return 1;
  return clamp01(1 - (value - min) / (max - min));
}

function neighborNeckScore(sample: SeamScanSample, axisSamples: SeamScanSample[]): number {
  const index = axisSamples.indexOf(sample);
  const previous = axisSamples[index - 1];
  const next = axisSamples[index + 1];
  if (!previous?.section.areaMm2 || !next?.section.areaMm2 || !sample.section.areaMm2) return 0.45;
  const neighborMean = (previous.section.areaMm2 + next.section.areaMm2) / 2;
  if (neighborMean <= 1e-9) return 0.45;
  const relativeNarrowing = (neighborMean - sample.section.areaMm2) / neighborMean;
  return clamp01(0.5 + relativeNarrowing * 2.5);
}

/**
 * 从完整闭合截面中挑选几何低风险位置。这里只排序可解释的几何代理，
 * 不把结果描述为语义部位识别、结构强度或已验证装配方案。
 */
export function rankSeamRecommendations(samples: SeamScanSample[], limit = 3): SeamRecommendation[] {
  const complete = samples.filter((sample) => (
    sample.candidate.fitsBedAfter
    && sample.section.status === 'closed'
    && sample.section.complete
    && sample.section.areaMm2 !== null
    && sample.section.areaMm2 > 0
    && sample.section.loopCount > 0
  ));
  if (!complete.length) return [];
  const areas = complete.map((sample) => sample.section.areaMm2!);
  const densities = complete.map((sample) => sample.section.segmentCount / Math.max(sample.section.perimeterMm, 1));
  const areaMin = Math.min(...areas);
  const areaMax = Math.max(...areas);
  const densityMin = Math.min(...densities);
  const densityMax = Math.max(...densities);

  const ranked = complete.map((sample) => {
    const axisSamples = samples
      .filter((candidate) => candidate.axis === sample.axis)
      .sort((a, b) => a.normalizedPosition - b.normalizedPosition);
    const area = sample.section.areaMm2!;
    const perimeter = sample.section.perimeterMm;
    const neckScore = neighborNeckScore(sample, axisSamples);
    const areaScore = normalizedInverse(area, areaMin, areaMax);
    const compactness = clamp01((4 * Math.PI * area) / Math.max(perimeter * perimeter, 1));
    const loopSimplicity = 1 / Math.max(sample.section.loopCount, 1);
    const compactnessScore = compactness * 0.65 + loopSimplicity * 0.35;
    const density = sample.section.segmentCount / Math.max(perimeter, 1);
    const densityScore = normalizedInverse(density, densityMin, densityMax);
    const detailRisk = 1 - densityScore;
    const balanceScore = clamp01(1 - Math.abs(sample.normalizedPosition - 0.5) * 2);
    const score = Math.round(
      35
      + neckScore * 20
      + areaScore * 16
      + compactnessScore * 14
      + densityScore * 10
      + balanceScore * 5,
    );
    const reasons = ['两侧均可放入打印床'];
    if (neckScore >= 0.62) reasons.push('相邻切片对比显示局部较窄');
    if (areaScore >= 0.65) reasons.push('截面面积较小');
    if (sample.section.loopCount === 1 && compactnessScore >= 0.55) reasons.push('单一闭合轮廓较简单');
    if (densityScore >= 0.65) reasons.push('截线密度较低');
    const risks: string[] = [];
    if (balanceScore < 0.5) risks.push('位置接近模型端部，零件比例不均衡');
    if (detailRisk > 0.65) risks.push('截线密度较高，可能经过细节密集区');
    if (sample.section.loopCount > 1) risks.push(`存在 ${sample.section.loopCount} 个闭合环，封口结构更复杂`);
    risks.push('仅为几何代理，需人工确认设计语义与受力方向');
    return {
      id: `${sample.axis}-${Math.round(sample.normalizedPosition * 100)}`,
      axis: sample.axis,
      axisIndex: sample.axisIndex,
      normalizedPosition: sample.normalizedPosition,
      positionMm: sample.candidate.positionMm,
      score: Math.max(0, Math.min(100, score)),
      areaMm2: area,
      perimeterMm: perimeter,
      loopCount: sample.section.loopCount,
      fitBothSides: sample.candidate.fitsBedAfter,
      neckScore,
      compactnessScore,
      detailRisk,
      balanceScore,
      reasons: reasons.slice(0, 3),
      risks,
    } satisfies SeamRecommendation;
  }).sort((a, b) => b.score - a.score || a.areaMm2 - b.areaMm2 || a.axisIndex - b.axisIndex);

  const selected: SeamRecommendation[] = [];
  for (const recommendation of ranked) {
    const tooClose = selected.some((picked) => (
      picked.axis === recommendation.axis
      && Math.abs(picked.normalizedPosition - recommendation.normalizedPosition) < 0.15
    ));
    if (tooClose) continue;
    selected.push(recommendation);
    if (selected.length >= limit) break;
  }
  return selected;
}
