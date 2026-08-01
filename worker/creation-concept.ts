import creationConceptOutputSchema from '../docs/contracts/creation-concept-output.schema.json';
import type {
  CreationConceptApiOutput,
  CreationConceptApiRequest,
  CreationConceptScheme,
} from '../src/agent/creation-concept-api-types';
import { validCreationBrief } from './creation-agent';
import type { ResponsesConfig, ResponsesUsage } from './split-analysis';

const MAX_BODY_BYTES = 32 * 1024;

export class CreationConceptInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class CreationConceptUpstreamError extends Error {
  constructor(
    readonly code: 'timeout' | 'refusal' | 'incomplete' | 'bad_output' | 'upstream',
    message: string,
  ) {
    super(message);
  }
}

function completeBrief(request: CreationConceptApiRequest): boolean {
  const brief = request.brief;
  return Boolean(brief.subject?.trim() && brief.style?.trim() && brief.projectType !== 'unknown' && brief.purpose !== 'unknown');
}

export async function parseCreationConceptRequest(req: Request): Promise<CreationConceptApiRequest> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new CreationConceptInputError('request_too_large', '创作 Brief 内容过长，请精简后重试。');
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    throw new CreationConceptInputError('bad_json', '视觉方案请求无法解析。');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new CreationConceptInputError('request_too_large', '创作 Brief 内容过长，请精简后重试。');
  }
  let body: CreationConceptApiRequest;
  try {
    body = JSON.parse(raw) as CreationConceptApiRequest;
  } catch {
    throw new CreationConceptInputError('bad_json', '视觉方案请求无法解析。');
  }
  if (!body || body.schemaVersion !== 'creation-concept-input.v1') {
    throw new CreationConceptInputError('bad_schema_version', '不支持的视觉方案输入版本。');
  }
  if (!body.requestId || body.requestId.length > 128 || body.locale !== 'zh-CN') {
    throw new CreationConceptInputError('bad_request', '视觉方案请求标识或语言设置无效。');
  }
  if (!validCreationBrief(body.brief)) {
    throw new CreationConceptInputError('bad_brief', '创作 Brief 不符合数据契约。');
  }
  if (!completeBrief(body)) {
    throw new CreationConceptInputError('brief_not_confirmable', '请先补齐创作对象、模型类型、用途和视觉风格。');
  }
  if (body.desiredSchemeCount !== 2 && body.desiredSchemeCount !== 3) {
    throw new CreationConceptInputError('bad_scheme_count', '每次只能生成 2 或 3 套视觉方案。');
  }
  return body;
}

function stringList(value: unknown, minimum = 1, maximum = 6): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((item) => typeof item === 'string' && item.length > 0);
}

function validScore(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;
}

function validScheme(value: unknown): value is CreationConceptScheme {
  if (!value || typeof value !== 'object') return false;
  const scheme = value as Partial<CreationConceptScheme>;
  return typeof scheme.schemeId === 'string' && scheme.schemeId.length > 0
    && typeof scheme.title === 'string' && scheme.title.length > 0
    && typeof scheme.tagline === 'string' && scheme.tagline.length > 0
    && typeof scheme.description === 'string' && scheme.description.length > 0
    && stringList(scheme.visualKeywords, 3, 8)
    && typeof scheme.silhouetteStrategy === 'string' && scheme.silhouetteStrategy.length > 0
    && typeof scheme.colorMaterialStrategy === 'string' && scheme.colorMaterialStrategy.length > 0
    && typeof scheme.poseComposition === 'string' && scheme.poseComposition.length > 0
    && typeof scheme.printableStrategy === 'string' && scheme.printableStrategy.length > 0
    && stringList(scheme.strengths)
    && stringList(scheme.tradeoffs)
    && !!scheme.scores
    && validScore(scheme.scores.briefFit)
    && validScore(scheme.scores.distinctiveness)
    && validScore(scheme.scores.printability)
    && typeof scheme.imagePrompt === 'string' && scheme.imagePrompt.length > 0
    && typeof scheme.negativePrompt === 'string' && scheme.negativePrompt.length > 0;
}

function validOutput(value: unknown, count: number): value is CreationConceptApiOutput {
  if (!value || typeof value !== 'object') return false;
  const output = value as Partial<CreationConceptApiOutput>;
  if (output.schemaVersion !== 'creation-concept-output.v1'
    || typeof output.summary !== 'string'
    || !Array.isArray(output.schemes)
    || output.schemes.length !== count
    || !output.schemes.every(validScheme)
    || typeof output.recommendedSchemeId !== 'string'
    || typeof output.recommendationReason !== 'string'
    || output.nextAction !== 'select_scheme') return false;
  const ids = output.schemes.map((scheme) => scheme.schemeId);
  return new Set(ids).size === ids.length && ids.includes(output.recommendedSchemeId);
}

const INSTRUCTIONS = `你是 3D-STD 的视觉方向设计 Agent。输入是一份已经由用户确认的 3D 创作 Brief。
你只负责提出可比较的视觉方向，不得声称已经生成效果图、三视图或 3D 模型，也不得触发任何工具或付费生成。
输出指定数量的方案。各方案必须保留同一创作对象和用途，但在轮廓语言、造型重点、配色材质或姿态构图上形成明显差异，不能只是换形容词。
每套方案都要说明打印友好策略，但必须把它表述为设计倾向而非已经完成的工程验证。
三个评分是 0–100 的相对比较：Brief 契合度、辨识度、打印友好度。推荐方案应在创意和实际用途之间取得最佳平衡。
imagePrompt 与 negativePrompt 只是下一阶段可能使用的输入，不代表已调用生图；提示词避免在画面中生成文字、水印、多个角色或裁切主体。
不要模仿在世艺术家，不要主动引入用户未要求的受版权保护角色名称。展示文案使用简体中文，并严格遵守 JSON Schema。`;

function outputTextOf(response: Record<string, unknown>): string | null {
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === 'refusal') throw new CreationConceptUpstreamError('refusal', '模型拒绝了本次视觉方案规划。');
      if (typed.type === 'output_text' && typeof typed.text === 'string') return typed.text;
    }
  }
  return null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function usageOf(raw: Record<string, unknown>): ResponsesUsage {
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : {};
  return { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens), totalTokens: tokenCount(usage.total_tokens) };
}

export async function callCreationConceptResponses(
  request: CreationConceptApiRequest,
  config: ResponsesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ output: CreationConceptApiOutput; usage: ResponsesUsage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        store: false,
        instructions: INSTRUCTIONS,
        input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ confirmedBrief: request.brief, desiredSchemeCount: request.desiredSchemeCount }) }] }],
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: config.maxOutputTokens,
        text: { format: { type: 'json_schema', name: 'creation_concept_output', strict: true, schema: creationConceptOutputSchema } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new CreationConceptUpstreamError('timeout', '视觉方案规划超时。');
    throw new CreationConceptUpstreamError('upstream', '视觉方案服务暂时无法连接。');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new CreationConceptUpstreamError('upstream', `Responses API 返回 HTTP ${response.status}。`);
  let raw: Record<string, unknown>;
  try {
    raw = await response.json() as Record<string, unknown>;
  } catch {
    throw new CreationConceptUpstreamError('bad_output', '视觉方案服务返回了无法解析的结果。');
  }
  if (raw.status === 'incomplete') throw new CreationConceptUpstreamError('incomplete', '视觉方案服务未完成结构化输出。');
  const text = outputTextOf(raw);
  if (!text) throw new CreationConceptUpstreamError('bad_output', '视觉方案服务未返回结构化文本。');
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new CreationConceptUpstreamError('bad_output', '视觉方案结构化结果无法解析。');
  }
  if (!validOutput(output, request.desiredSchemeCount)) throw new CreationConceptUpstreamError('bad_output', '视觉方案结果不符合数据契约。');
  return { output, usage: usageOf(raw) };
}
