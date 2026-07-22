import splitAnalysisOutputSchema from '../docs/contracts/split-analysis-output.schema.json';
import type {
  SplitAnalysisApiOutput,
  SplitAnalysisApiRequest,
} from '../src/agent/split-analysis-api-types';

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 600 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_OBJECTS = 40;
const MAX_ISSUES = 160;

export class SplitAnalysisInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class SplitAnalysisUpstreamError extends Error {
  constructor(
    readonly code: 'timeout' | 'refusal' | 'incomplete' | 'bad_output' | 'upstream',
    message: string,
  ) {
    super(message);
  }
}

function approximateBase64Bytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = url.slice(comma + 1).replace(/\s/g, '');
  return Math.floor(payload.length * 0.75) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
}

export async function parseSplitAnalysisRequest(req: Request): Promise<SplitAnalysisApiRequest> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new SplitAnalysisInputError('request_too_large', '分析证据总量超过 3MB，请减少对象或截图后重试。');
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    throw new SplitAnalysisInputError('bad_json', '分析请求无法解析。');
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new SplitAnalysisInputError('request_too_large', '分析证据总量超过 3MB，请减少对象或截图后重试。');
  }
  let body: SplitAnalysisApiRequest;
  try {
    body = JSON.parse(rawBody) as SplitAnalysisApiRequest;
  } catch {
    throw new SplitAnalysisInputError('bad_json', '分析请求无法解析。');
  }
  if (!body || typeof body !== 'object' || !body.input || !Array.isArray(body.images)) {
    throw new SplitAnalysisInputError('bad_request', '分析请求缺少场景快照或视觉证据。');
  }
  const input = body.input;
  if (input.schemaVersion !== 'split-analysis-input.v1') {
    throw new SplitAnalysisInputError('bad_schema_version', '不支持的拆件分析输入版本。');
  }
  if (!input.requestId || input.requestId.length > 128) {
    throw new SplitAnalysisInputError('bad_request_id', '分析请求 ID 无效。');
  }
  if (!input.goal?.description?.trim() || input.goal.description.length > 1000) {
    throw new SplitAnalysisInputError('bad_goal', '拆件目标不能为空且不能超过 1000 字。');
  }
  if (!Array.isArray(input.objects) || input.objects.length < 1 || input.objects.length > MAX_OBJECTS) {
    throw new SplitAnalysisInputError('bad_objects', `本阶段每次支持分析 1–${MAX_OBJECTS} 个可见对象。`);
  }
  if (!Array.isArray(input.diagnostics?.issues) || input.diagnostics.issues.length > MAX_ISSUES) {
    throw new SplitAnalysisInputError('too_many_issues', `打印检查证据最多保留 ${MAX_ISSUES} 条。`);
  }
  if (!Array.isArray(input.views) || input.views.length > 4 || body.images.length > 4) {
    throw new SplitAnalysisInputError('too_many_views', '多视角证据最多支持 4 张。');
  }
  const descriptors = new Set(input.views.map((view) => view.viewId));
  let totalImageBytes = 0;
  for (const image of body.images) {
    if (!descriptors.has(image.viewId)) {
      throw new SplitAnalysisInputError('unknown_view', '截图与视角描述不匹配。');
    }
    if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(image.imageUrl)) {
      throw new SplitAnalysisInputError('bad_image', '视觉证据必须是 PNG、JPEG 或 WebP data URL。');
    }
    const bytes = approximateBase64Bytes(image.imageUrl);
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) {
      throw new SplitAnalysisInputError('image_too_large', '单张分析截图不能超过 600KB。');
    }
    totalImageBytes += bytes;
  }
  if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new SplitAnalysisInputError('images_too_large', '分析截图总量不能超过 2MB。');
  }
  return body;
}

function validateOutput(value: unknown): value is SplitAnalysisApiOutput {
  if (!value || typeof value !== 'object') return false;
  const output = value as Partial<SplitAnalysisApiOutput>;
  const partCount = output.recommendedPartCount;
  const limitations = output.limitations;
  return output.schemaVersion === 'split-analysis-output.v1'
    && (output.needsSplit === 'yes' || output.needsSplit === 'no' || output.needsSplit === 'uncertain')
    && typeof output.confidence === 'number'
    && output.confidence >= 0
    && output.confidence <= 1
    && typeof output.summary === 'string'
    && Array.isArray(output.reasons)
    && output.reasons.every((reason) => !!reason && typeof reason.reasonId === 'string' && typeof reason.description === 'string' && Array.isArray(reason.evidenceRefs))
    && !!partCount
    && Number.isInteger(partCount.minimum)
    && Number.isInteger(partCount.preferred)
    && Number.isInteger(partCount.maximum)
    && partCount.minimum >= 1
    && partCount.minimum <= partCount.preferred
    && partCount.preferred <= partCount.maximum
    && typeof partCount.rationale === 'string'
    && Array.isArray(output.recommendedRegions)
    && output.recommendedRegions.every((region) => !!region && typeof region.regionId === 'string' && Array.isArray(region.objectIds) && typeof region.description === 'string')
    && Array.isArray(output.schemes)
    && output.schemes.length >= 2
    && output.schemes.length <= 3
    && output.schemes.every((scheme) => !!scheme && typeof scheme.schemeId === 'string' && typeof scheme.title === 'string' && Number.isInteger(scheme.partCount) && scheme.partCount >= 1 && Array.isArray(scheme.pros) && Array.isArray(scheme.cons) && Array.isArray(scheme.riskIds))
    && Array.isArray(output.risks)
    && output.risks.every((risk) => !!risk && typeof risk.riskId === 'string' && typeof risk.title === 'string' && typeof risk.mitigation === 'string')
    && Array.isArray(output.nextSteps)
    && output.nextSteps.every((step) => !!step && Number.isInteger(step.order) && typeof step.description === 'string')
    && !!limitations
    && Array.isArray(limitations.missingInputs)
    && Array.isArray(limitations.unavailableCapabilities)
    && Array.isArray(limitations.assumptions)
    && (limitations.visualUncertainty === 'low' || limitations.visualUncertainty === 'medium' || limitations.visualUncertainty === 'high');
}

function outputTextOf(response: Record<string, unknown>): string | null {
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (typed.type === 'refusal') throw new SplitAnalysisUpstreamError('refusal', '模型拒绝了本次分析请求。');
      if (typed.type === 'output_text' && typeof typed.text === 'string') return typed.text;
    }
  }
  return null;
}

const INSTRUCTIONS = `你是 3D-STD 的 3D 打印拆件分析助手。只分析和建议，绝不声称已经切割、修改、修复或验证模型。
以用户目标、打印空间、对象尺寸、诊断结果和多视角截图为证据；缺失的薄壁、局部过悬、候选切面和装配验证必须明确标为未知。
输出 2–3 套候选方案，第一套为综合推荐方案。推荐区域只能是语义候选区域，不得伪造精确平面或几何计算。
evidenceRefs 只能引用请求中真实存在的 objectId、issueId、assetId 或 viewId。输出语言为简体中文，并严格遵守给定 JSON Schema。`;

export interface ResponsesConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface ResponsesUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface SplitAnalysisResponsesResult {
  output: SplitAnalysisApiOutput;
  usage: ResponsesUsage;
}

function finiteTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function usageOf(raw: Record<string, unknown>): ResponsesUsage {
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : {};
  return {
    inputTokens: finiteTokenCount(usage.input_tokens),
    outputTokens: finiteTokenCount(usage.output_tokens),
    totalTokens: finiteTokenCount(usage.total_tokens),
  };
}

export async function callSplitAnalysisResponses(
  request: SplitAnalysisApiRequest,
  config: ResponsesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SplitAnalysisResponsesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const viewLabels = new Map(request.input.views.map((view) => [view.viewId, view.label]));
  const content: Array<Record<string, unknown>> = [{
    type: 'input_text',
    text: `以下是只读场景快照。不要把未运行能力当作已检测结果。\n${JSON.stringify(request.input)}`,
  }];
  for (const image of request.images) {
    content.push({ type: 'input_text', text: `视角证据 ${image.viewId}（${viewLabels.get(image.viewId) ?? 'unknown'}）` });
    content.push({ type: 'input_image', image_url: image.imageUrl, detail: 'low' });
  }

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        store: false,
        instructions: INSTRUCTIONS,
        input: [{ role: 'user', content }],
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: config.maxOutputTokens,
        text: {
          format: {
            type: 'json_schema',
            name: 'split_analysis_output',
            strict: true,
            schema: splitAnalysisOutputSchema,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SplitAnalysisUpstreamError('timeout', 'Responses API 分析超时。');
    }
    throw new SplitAnalysisUpstreamError('upstream', 'Responses API 暂时无法连接。');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new SplitAnalysisUpstreamError('upstream', `Responses API 返回 HTTP ${response.status}。`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = await response.json() as Record<string, unknown>;
  } catch {
    throw new SplitAnalysisUpstreamError('bad_output', 'Responses API 返回了无法解析的结果。');
  }
  if (raw.status === 'incomplete') {
    throw new SplitAnalysisUpstreamError('incomplete', 'Responses API 未完成结构化输出。');
  }
  const text = outputTextOf(raw);
  if (!text) throw new SplitAnalysisUpstreamError('bad_output', 'Responses API 未返回结构化文本。');
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new SplitAnalysisUpstreamError('bad_output', 'Responses API 的结构化结果无法解析。');
  }
  if (!validateOutput(output)) {
    throw new SplitAnalysisUpstreamError('bad_output', 'Responses API 的结构化结果不符合拆件分析契约。');
  }
  return { output, usage: usageOf(raw) };
}
