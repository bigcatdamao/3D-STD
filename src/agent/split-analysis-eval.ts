import type { SplitAnalysisApiOutput } from './split-analysis-api-types';

export type GoldCategory =
  | 'fits_whole'
  | 'exceeds_build_volume'
  | 'mesh_blocking'
  | 'support_sensitive'
  | 'pre_split_assembly'
  | 'surface_sensitive';

export interface SplitAnalysisGoldCase {
  caseId: string;
  title: string;
  category: GoldCategory;
  expected: {
    acceptableNeedsSplit: SplitAnalysisApiOutput['needsSplit'][];
    requiredReasonCodes: string[];
    allowedEvidenceRefs: string[];
    preferredPartCount: { min: number; max: number };
    requiredLimitationTerms: string[];
  };
}

export interface SplitAnalysisManualReview {
  schemeUsefulness: 1 | 2 | 3 | 4 | 5;
  actionability: 1 | 2 | 3 | 4 | 5;
  surfaceRiskHonesty: 1 | 2 | 3 | 4 | 5;
  assemblyClarity: 1 | 2 | 3 | 4 | 5;
  hallucinationFound: boolean;
}

export interface SplitAnalysisEvalRun {
  gold: SplitAnalysisGoldCase;
  output: SplitAnalysisApiOutput;
  latencyMs: number;
  totalTokens: number | null;
  manual?: SplitAnalysisManualReview;
}

export interface SplitAnalysisCaseScore {
  caseId: string;
  score: number;
  passed: boolean;
  decisionMatch: boolean;
  reasonCoverage: number;
  invalidEvidenceRefs: string[];
  partCountMatch: boolean;
  limitationCoverage: number;
  schemeCountValid: boolean;
}

export interface SplitAnalysisEvalSummary {
  cases: number;
  automatedPassRate: number;
  decisionAccuracy: number;
  evidenceIntegrityRate: number;
  averageScore: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  averageTotalTokens: number | null;
  manualUsefulRate: number | null;
  hallucinationRate: number | null;
}

function boundedRatio(hit: number, total: number): number {
  return total === 0 ? 1 : Math.max(0, Math.min(1, hit / total));
}

function rate(hit: number, total: number): number {
  return total === 0 ? 0 : Math.max(0, Math.min(1, hit / total));
}

function allEvidenceRefs(output: SplitAnalysisApiOutput): string[] {
  return [
    ...output.reasons.flatMap((reason) => reason.evidenceRefs),
    ...output.recommendedRegions.flatMap((region) => region.evidenceRefs),
    ...output.risks.flatMap((risk) => risk.evidenceRefs),
  ];
}

/** M1.6.3 自动评分只处理可确定事实；主观方案质量仍由人工 rubric 评分。 */
export function scoreSplitAnalysisCase(run: SplitAnalysisEvalRun): SplitAnalysisCaseScore {
  const { gold, output } = run;
  const decisionMatch = gold.expected.acceptableNeedsSplit.includes(output.needsSplit);
  const reasonCodes = new Set(output.reasons.map((reason) => reason.code));
  const reasonHits = gold.expected.requiredReasonCodes.filter((code) => reasonCodes.has(code)).length;
  const reasonCoverage = boundedRatio(reasonHits, gold.expected.requiredReasonCodes.length);

  const allowedRefs = new Set(gold.expected.allowedEvidenceRefs);
  const invalidEvidenceRefs = [...new Set(allEvidenceRefs(output).filter((ref) => !allowedRefs.has(ref)))].sort();
  const preferred = output.recommendedPartCount.preferred;
  const partCountMatch = preferred >= gold.expected.preferredPartCount.min && preferred <= gold.expected.preferredPartCount.max;

  const limitationText = [
    ...output.limitations.missingInputs,
    ...output.limitations.unavailableCapabilities,
    ...output.limitations.assumptions,
  ].join('\n').toLowerCase();
  const limitationHits = gold.expected.requiredLimitationTerms.filter((term) => limitationText.includes(term.toLowerCase())).length;
  const limitationCoverage = boundedRatio(limitationHits, gold.expected.requiredLimitationTerms.length);
  const schemeCountValid = output.schemes.length >= 2 && output.schemes.length <= 3;

  const score = Math.round(
    (decisionMatch ? 35 : 0)
      + reasonCoverage * 20
      + (invalidEvidenceRefs.length === 0 ? 20 : 0)
      + (partCountMatch ? 10 : 0)
      + limitationCoverage * 10
      + (schemeCountValid ? 5 : 0),
  );
  return {
    caseId: gold.caseId,
    score,
    passed: score >= 80 && decisionMatch && invalidEvidenceRefs.length === 0,
    decisionMatch,
    reasonCoverage,
    invalidEvidenceRefs,
    partCountMatch,
    limitationCoverage,
    schemeCountValid,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function summarizeSplitAnalysisEval(runs: SplitAnalysisEvalRun[]): SplitAnalysisEvalSummary {
  const scores = runs.map(scoreSplitAnalysisCase);
  const tokenValues = runs.flatMap((run) => run.totalTokens == null ? [] : [run.totalTokens]);
  const manual = runs.flatMap((run) => run.manual ? [run.manual] : []);
  const manualUseful = manual.filter((review) => review.schemeUsefulness >= 4 && review.actionability >= 4).length;
  return {
    cases: runs.length,
    automatedPassRate: rate(scores.filter((score) => score.passed).length, scores.length),
    decisionAccuracy: rate(scores.filter((score) => score.decisionMatch).length, scores.length),
    evidenceIntegrityRate: rate(scores.filter((score) => score.invalidEvidenceRefs.length === 0).length, scores.length),
    averageScore: mean(scores.map((score) => score.score)),
    averageLatencyMs: mean(runs.map((run) => run.latencyMs)),
    p95LatencyMs: percentile95(runs.map((run) => run.latencyMs)),
    averageTotalTokens: tokenValues.length ? mean(tokenValues) : null,
    manualUsefulRate: manual.length ? manualUseful / manual.length : null,
    hallucinationRate: manual.length ? manual.filter((review) => review.hallucinationFound).length / manual.length : null,
  };
}
