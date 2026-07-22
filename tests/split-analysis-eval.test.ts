import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SplitAnalysisApiOutput } from '../src/agent/split-analysis-api-types';
import {
  scoreSplitAnalysisCase,
  summarizeSplitAnalysisEval,
  type SplitAnalysisEvalRun,
  type SplitAnalysisGoldCase,
} from '../src/agent/split-analysis-eval';

const gold: SplitAnalysisGoldCase = {
  caseId: 'gold-oversized-01',
  title: '超长单体支架',
  category: 'exceeds_build_volume',
  expected: {
    acceptableNeedsSplit: ['yes'],
    requiredReasonCodes: ['exceeds_build_volume'],
    allowedEvidenceRefs: ['object-1', 'issue-1', 'view-front'],
    preferredPartCount: { min: 2, max: 3 },
    requiredLimitationTerms: ['薄壁', '候选切面'],
  },
};

const output: SplitAnalysisApiOutput = {
  schemaVersion: 'split-analysis-output.v1', needsSplit: 'yes', confidence: 0.86, summary: 'X 轴超限，建议拆件。',
  reasons: [{ reasonId: 'reason-1', code: 'exceeds_build_volume', severity: 'blocking', description: 'X 轴超限', evidenceRefs: ['object-1', 'issue-1'] }],
  recommendedPartCount: { minimum: 2, preferred: 2, maximum: 3, rationale: '两件可放入打印空间。' },
  recommendedRegions: [{ regionId: 'region-1', objectIds: ['object-1'], label: '中部结构带', description: '语义候选区域', candidateType: 'plane', location: { kind: 'axis_band', axis: 'x', normalizedPosition: 0.5, landmarks: [] }, rationale: '缩短 X 尺寸', confidence: 0.7, evidenceRefs: ['view-front'] }],
  schemes: [
    { schemeId: 'scheme-1', title: '两段式', summary: '分两段', partCount: 2, regionIds: ['region-1'], cutSequence: [], pros: ['可放入'], cons: ['有接缝'], impact: { bedFit: 'improved', support: 'unknown', strength: 'unknown', surface: 'neutral', assembly: 'worse' }, assemblyApproach: 'flat_joint', riskIds: ['risk-1'], confidence: 0.8 },
    { schemeId: 'scheme-2', title: '三段式', summary: '分三段', partCount: 3, regionIds: ['region-1'], cutSequence: [], pros: ['更小'], cons: ['装配复杂'], impact: { bedFit: 'improved', support: 'unknown', strength: 'worse', surface: 'worse', assembly: 'worse' }, assemblyApproach: 'alignment_pin', riskIds: ['risk-1'], confidence: 0.65 },
  ],
  risks: [{ riskId: 'risk-1', severity: 'warning', title: '未验证切面', description: '尚无真实切割', mitigation: '先预览', evidenceRefs: [] }],
  nextSteps: [{ order: 1, action: 'preview_split', description: '先生成预览', requiresUserConfirmation: true, suggestedTool: 'preview_plane_cut' }],
  limitations: { missingInputs: ['薄壁检测'], unavailableCapabilities: ['候选切面搜索'], assumptions: ['单位为毫米'], visualUncertainty: 'medium' },
};

const run = (over: Partial<SplitAnalysisEvalRun> = {}): SplitAnalysisEvalRun => ({ gold, output, latencyMs: 18000, totalTokens: 1200, ...over });

describe('M1.6.3 拆件 Gold Set 自动评分', () => {
  it('种子清单固定 24 个目标并覆盖六类中的首批五类', () => {
    const seeded = JSON.parse(readFileSync(new URL('../docs/evals/split-analysis-gold-v0.1.json', import.meta.url), 'utf8')) as {
      schemaVersion: string; targetCaseCount: number; cases: Array<{ caseId: string; category: string }>;
    };
    expect(seeded.schemaVersion).toBe('split-analysis-gold.v1');
    expect(seeded.targetCaseCount).toBe(24);
    expect(seeded.cases).toHaveLength(5);
    expect(new Set(seeded.cases.map((item) => item.caseId)).size).toBe(5);
    expect(new Set(seeded.cases.map((item) => item.category)).size).toBe(5);
  });

  it('正确结论、合法证据、件数和限制全部满足时满分通过', () => {
    expect(scoreSplitAnalysisCase(run())).toEqual({
      caseId: 'gold-oversized-01', score: 100, passed: true, decisionMatch: true, reasonCoverage: 1,
      invalidEvidenceRefs: [], partCountMatch: true, limitationCoverage: 1, schemeCountValid: true,
    });
  });

  it('伪造证据引用即使总分尚高也不能通过', () => {
    const badOutput = structuredClone(output);
    badOutput.reasons[0].evidenceRefs.push('imagined-object');
    const score = scoreSplitAnalysisCase(run({ output: badOutput }));
    expect(score.invalidEvidenceRefs).toEqual(['imagined-object']);
    expect(score.passed).toBe(false);
  });

  it('汇总准确率、p95、token 和人工可用率', () => {
    const manual = { schemeUsefulness: 4, actionability: 5, surfaceRiskHonesty: 4, assemblyClarity: 4, hallucinationFound: false } as const;
    const secondOutput = structuredClone(output);
    secondOutput.needsSplit = 'no';
    const summary = summarizeSplitAnalysisEval([
      run({ latencyMs: 10000, totalTokens: 1000, manual }),
      run({ output: secondOutput, latencyMs: 30000, totalTokens: 2000, manual: { ...manual, hallucinationFound: true } }),
    ]);
    expect(summary).toMatchObject({ cases: 2, decisionAccuracy: 0.5, evidenceIntegrityRate: 1, p95LatencyMs: 30000, averageTotalTokens: 1500, manualUsefulRate: 1, hallucinationRate: 0.5 });
  });
});
