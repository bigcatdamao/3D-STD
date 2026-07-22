import type { ApiError } from '../../worker/api-types';
import { apiHeaders } from '../net/visitor';
import type { SplitAnalysisApiRequest, SplitAnalysisApiSuccess, SplitAnalysisApiOutput } from './split-analysis-api-types';
import type { SplitAnalysisResult, SplitScheme } from './split-analysis-types';

const CLIENT_TIMEOUT_MS = 50_000;

const ASSEMBLY_LABEL: Record<SplitAnalysisApiOutput['schemes'][number]['assemblyApproach'], SplitScheme['assembly']> = {
  none: '无需装配',
  flat_joint: '平面对接',
  alignment_pin: '定位销（阶段三）',
  socket: '定位销（阶段三）',
  adhesive: '粘接',
  screw: '定位销（阶段三）',
  unknown: '平面对接',
};

function riskLabel(output: SplitAnalysisApiOutput, ids: string[]): SplitScheme['risk'] {
  const levels = output.risks.filter((risk) => ids.includes(risk.riskId)).map((risk) => risk.severity);
  return levels.includes('blocking') ? '高' : levels.includes('warning') ? '中' : '低';
}

export function adaptSplitAnalysisOutput(output: SplitAnalysisApiOutput): SplitAnalysisResult {
  return {
    schemaVersion: output.schemaVersion,
    needsSplit: output.needsSplit,
    confidence: output.confidence,
    summary: output.summary,
    reasons: output.reasons.map((reason) => ({
      code: reason.code,
      severity: reason.severity,
      description: reason.description,
      evidence: reason.evidenceRefs.length ? `证据：${reason.evidenceRefs.join('、')}` : '模型未引用具体证据项',
    })),
    recommendedPartCount: output.recommendedPartCount,
    recommendedRegions: output.recommendedRegions.map((region) => ({
      id: region.regionId,
      label: region.label,
      description: region.description,
      candidateType: region.candidateType === 'component_separation' ? 'natural_seam' : region.candidateType,
      confidence: region.confidence,
    })),
    schemes: output.schemes.map((scheme, index) => ({
      id: scheme.schemeId,
      title: scheme.title,
      summary: scheme.summary,
      partCount: scheme.partCount,
      recommended: index === 0,
      pros: scheme.pros,
      cons: scheme.cons,
      assembly: ASSEMBLY_LABEL[scheme.assemblyApproach],
      risk: riskLabel(output, scheme.riskIds),
      confidence: scheme.confidence,
    })),
    risks: output.risks.map((risk) => ({
      severity: risk.severity,
      title: risk.title,
      description: risk.description,
      mitigation: risk.mitigation,
    })),
    nextSteps: [...output.nextSteps].sort((a, b) => a.order - b.order).map((step) => ({ ...step })),
    limitations: output.limitations,
  };
}

export async function requestSplitAnalysis(
  request: SplitAnalysisApiRequest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ result: SplitAnalysisResult; meta: SplitAnalysisApiSuccess['meta'] }> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? CLIENT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)('/api/agent/split-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiHeaders({ includeEngineKey: false }) },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let body: SplitAnalysisApiSuccess | ApiError;
    try {
      body = await response.json() as SplitAnalysisApiSuccess | ApiError;
    } catch {
      throw new Error('AI 分析服务暂时不可用，当前显示本地降级建议。');
    }
    if (!response.ok || !body.ok) {
      throw new Error('message' in body ? body.message : `分析服务返回 ${response.status}`);
    }
    return { result: adaptSplitAnalysisOutput(body.result), meta: body.meta };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('AI 分析超过 50 秒，已切换到本地降级建议。');
    }
    if (error instanceof Error) throw error;
    throw new Error('AI 分析暂时不可用，已切换到本地降级建议。');
  } finally {
    globalThis.clearTimeout(timer);
  }
}
