import { describe, expect, it } from 'vitest';
import { adaptSplitAnalysisOutput } from '../src/agent/split-analysis-api';
import type { SplitAnalysisApiOutput } from '../src/agent/split-analysis-api-types';

describe('M1.6.2 API 输出适配', () => {
  it('把正式富 Schema 映射到现有只读方案 UI，第一套方案作为推荐', () => {
    const output = {
      schemaVersion: 'split-analysis-output.v1', needsSplit: 'yes', confidence: 0.8, summary: '需要拆件',
      reasons: [{ reasonId: 'r1', code: 'exceeds_build_volume', severity: 'blocking', description: '超限', evidenceRefs: ['o1'] }],
      recommendedPartCount: { minimum: 2, preferred: 2, maximum: 3, rationale: '适配床' },
      recommendedRegions: [{ regionId: 'z1', objectIds: ['o1'], label: '腰部', description: '候选区域', candidateType: 'component_separation', location: { kind: 'between_components', axis: 'z', normalizedPosition: 0.5, landmarks: [] }, rationale: '结构缝', confidence: 0.7, evidenceRefs: [] }],
      schemes: [
        { schemeId: 's1', title: '两件式', summary: '两件', partCount: 2, regionIds: ['z1'], cutSequence: [], pros: ['简单'], cons: ['接缝'], impact: { bedFit: 'improved', support: 'unknown', strength: 'unknown', surface: 'neutral', assembly: 'worse' }, assemblyApproach: 'flat_joint', riskIds: ['risk1'], confidence: 0.75 },
        { schemeId: 's2', title: '三件式', summary: '三件', partCount: 3, regionIds: [], cutSequence: [], pros: ['更小'], cons: ['复杂'], impact: { bedFit: 'improved', support: 'unknown', strength: 'worse', surface: 'worse', assembly: 'worse' }, assemblyApproach: 'alignment_pin', riskIds: [], confidence: 0.55 },
      ],
      risks: [{ riskId: 'risk1', severity: 'warning', title: '需预览', description: '尚未预览', mitigation: '先预览', evidenceRefs: [] }],
      nextSteps: [{ order: 1, action: 'review_scheme', description: '审阅方案', requiresUserConfirmation: true, suggestedTool: null }],
      limitations: { missingInputs: [], unavailableCapabilities: ['preview'], assumptions: ['mm'], visualUncertainty: 'medium' },
    } satisfies SplitAnalysisApiOutput;
    const result = adaptSplitAnalysisOutput(output);
    expect(result.schemes[0]).toMatchObject({ id: 's1', recommended: true, assembly: '平面对接', risk: '中' });
    expect(result.schemes[1]).toMatchObject({ recommended: false, assembly: '定位销（阶段三）' });
    expect(result.recommendedRegions[0].candidateType).toBe('natural_seam');
    expect(result.nextSteps).toEqual([{
      order: 1,
      action: 'review_scheme',
      description: '审阅方案',
      requiresUserConfirmation: true,
      suggestedTool: null,
    }]);
  });
});
