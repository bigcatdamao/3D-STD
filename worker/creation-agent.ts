import creationAgentOutputSchema from '../docs/contracts/creation-agent-output.schema.json';
import type {
  CreationAgentApiOutput,
  CreationAgentApiRequest,
  CreationAgentBrief,
  CreationAgentQuestion,
} from '../src/agent/creation-agent-api-types';
import type { ResponsesConfig, ResponsesUsage } from './split-analysis';
import { providerFailureOf } from './provider-error';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_ITEMS = 16;

export class CreationAgentInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class CreationAgentUpstreamError extends Error {
  constructor(
    readonly code: 'timeout' | 'refusal' | 'incomplete' | 'bad_output' | 'upstream',
    message: string,
    readonly upstreamStatus: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(message);
  }
}

const projectTypes = new Set(['character', 'mecha', 'prop', 'product', 'scene', 'other', 'unknown']);
const purposes = new Set(['resin_print', 'fdm_print', 'display', 'prototype', 'unknown']);
const nextActions = new Set(['ask_questions', 'review_brief', 'request_reference', 'ready_for_concept']);

export function validCreationBrief(value: unknown): value is CreationAgentBrief {
  if (!value || typeof value !== 'object') return false;
  const brief = value as Partial<CreationAgentBrief>;
  const partCount = brief.preferredPartCount;
  return (brief.subject === null || (typeof brief.subject === 'string' && brief.subject.length <= 500))
    && typeof brief.projectType === 'string'
    && projectTypes.has(brief.projectType)
    && typeof brief.purpose === 'string'
    && purposes.has(brief.purpose)
    && (brief.style === null || (typeof brief.style === 'string' && brief.style.length <= 500))
    && (brief.targetHeightMm === null || (typeof brief.targetHeightMm === 'number' && brief.targetHeightMm > 0 && brief.targetHeightMm <= 5_000))
    && (brief.pose === null || (typeof brief.pose === 'string' && brief.pose.length <= 500))
    && (partCount === null || (
      !!partCount
      && Number.isInteger(partCount.minimum)
      && Number.isInteger(partCount.preferred)
      && Number.isInteger(partCount.maximum)
      && partCount.minimum >= 1
      && partCount.minimum <= partCount.preferred
      && partCount.preferred <= partCount.maximum
      && partCount.maximum <= 100
    ))
    && Array.isArray(brief.notes)
    && brief.notes.length <= 20
    && brief.notes.every((note) => typeof note === 'string' && note.length <= 240);
}

function validQuestion(value: unknown): value is CreationAgentQuestion {
  if (!value || typeof value !== 'object') return false;
  const question = value as Partial<CreationAgentQuestion>;
  if (typeof question.questionId !== 'string' || typeof question.question !== 'string' || question.allowFreeText !== true) return false;
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return false;
  let recommendations = 0;
  const validOptions = question.options.every((option) => {
    if (!option || typeof option !== 'object') return false;
    if (option.recommended === true) recommendations += 1;
    return typeof option.value === 'string'
      && option.value.length > 0
      && typeof option.label === 'string'
      && option.label.length > 0
      && typeof option.description === 'string'
      && typeof option.recommended === 'boolean';
  });
  return validOptions && recommendations <= 1;
}

function validOutput(value: unknown): value is CreationAgentApiOutput {
  if (!value || typeof value !== 'object') return false;
  const output = value as Partial<CreationAgentApiOutput>;
  return output.schemaVersion === 'creation-agent-output.v1'
    && typeof output.message === 'string'
    && output.message.length > 0
    && validCreationBrief(output.brief)
    && Array.isArray(output.questions)
    && output.questions.length <= 3
    && output.questions.every(validQuestion)
    && typeof output.nextAction === 'string'
    && nextActions.has(output.nextAction)
    && (output.nextAction !== 'ask_questions' || output.questions.length > 0)
    && (output.nextAction !== 'review_brief' || output.questions.length === 0)
    && !!output.readiness
    && typeof output.readiness.score === 'number'
    && output.readiness.score >= 0
    && output.readiness.score <= 1
    && Array.isArray(output.readiness.missingFields)
    && output.readiness.missingFields.every((field) => typeof field === 'string')
    && Array.isArray(output.assumptions)
    && output.assumptions.every((assumption) => typeof assumption === 'string');
}

export async function parseCreationAgentRequest(req: Request): Promise<CreationAgentApiRequest> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new CreationAgentInputError('request_too_large', '创作会话内容过长，请精简后重试。');
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    throw new CreationAgentInputError('bad_json', '创作请求无法解析。');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new CreationAgentInputError('request_too_large', '创作会话内容过长，请精简后重试。');
  }
  let body: CreationAgentApiRequest;
  try {
    body = JSON.parse(raw) as CreationAgentApiRequest;
  } catch {
    throw new CreationAgentInputError('bad_json', '创作请求无法解析。');
  }
  if (!body || body.schemaVersion !== 'creation-agent-input.v1') {
    throw new CreationAgentInputError('bad_schema_version', '不支持的创作 Agent 输入版本。');
  }
  if (!body.requestId || body.requestId.length > 128 || body.locale !== 'zh-CN') {
    throw new CreationAgentInputError('bad_request', '创作请求标识或语言设置无效。');
  }
  if (!body.message?.trim() || body.message.length > MAX_MESSAGE_CHARS) {
    throw new CreationAgentInputError('bad_message', `本轮消息须为 1–${MAX_MESSAGE_CHARS} 字。`);
  }
  if (!validCreationBrief(body.brief)) {
    throw new CreationAgentInputError('bad_brief', '当前创作需求摘要不符合数据契约。');
  }
  if (!Array.isArray(body.history) || body.history.length > MAX_HISTORY_ITEMS || body.history.some((item) => (
    !item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || item.content.length > MAX_MESSAGE_CHARS
  ))) {
    throw new CreationAgentInputError('bad_history', `最多保留最近 ${MAX_HISTORY_ITEMS} 条有效对话。`);
  }
  if (!Number.isInteger(body.referenceImageCount) || body.referenceImageCount < 0 || body.referenceImageCount > 3) {
    throw new CreationAgentInputError('bad_reference_count', '参考图数量须为 0–3 张。');
  }
  return body;
}

const INSTRUCTIONS = `你是 3D-STD 的“3D 创作 Agent”，负责把用户模糊的 3D 创作想法整理成可确认的创作需求 Brief。
你只能理解需求、追问和整理，不得声称已经生成图片、三视图、3D 模型、拆件或修改几何，也不得自动触发任何付费服务。
先继承 currentBrief 中已经确认的信息，再从本轮 message 和 history 提取新增信息；不要重复询问已经确定的内容。
每轮最多提出 3 个真正影响结果的关键问题。每题提供 2–4 个互斥选项，必要时可留自由输入；推荐项最多一个，并说明简短影响。
当创作对象、模型类型、视觉风格和用途足够明确时，questions 必须为空，nextAction 设为 review_brief；不要为了凑问题继续追问。
如果缺少参考图但不影响先确认 Brief，不要阻塞；只有用户明确要求复刻特定对象且描述不足时才使用 request_reference。
所有内容使用简体中文，严格遵守 JSON Schema。`;

function outputTextOf(response: Record<string, unknown>): string | null {
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === 'refusal') throw new CreationAgentUpstreamError('refusal', '模型拒绝了本次创作需求整理。');
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
  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    totalTokens: tokenCount(usage.total_tokens),
  };
}

export async function callCreationAgentResponses(
  request: CreationAgentApiRequest,
  config: ResponsesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ output: CreationAgentApiOutput; usage: ResponsesUsage }> {
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
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: JSON.stringify({
              currentBrief: request.brief,
              recentHistory: request.history.slice(-12),
              message: request.message,
              referenceImageCount: request.referenceImageCount,
            }),
          }],
        }],
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: config.maxOutputTokens,
        text: {
          format: {
            type: 'json_schema',
            name: 'creation_agent_output',
            strict: true,
            schema: creationAgentOutputSchema,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new CreationAgentUpstreamError('timeout', '创作 Agent 响应超时。');
    }
    throw new CreationAgentUpstreamError('upstream', '创作 Agent 暂时无法连接。');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const failure = await providerFailureOf(response);
    throw new CreationAgentUpstreamError('upstream', `Responses API 返回 HTTP ${failure.status}。`, failure.status, failure.code);
  }
  let raw: Record<string, unknown>;
  try {
    raw = await response.json() as Record<string, unknown>;
  } catch {
    throw new CreationAgentUpstreamError('bad_output', '创作 Agent 返回了无法解析的结果。');
  }
  if (raw.status === 'incomplete') throw new CreationAgentUpstreamError('incomplete', '创作 Agent 未完成结构化输出。');
  const text = outputTextOf(raw);
  if (!text) throw new CreationAgentUpstreamError('bad_output', '创作 Agent 未返回结构化文本。');
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new CreationAgentUpstreamError('bad_output', '创作 Agent 的结构化结果无法解析。');
  }
  if (!validOutput(output)) throw new CreationAgentUpstreamError('bad_output', '创作 Agent 的结果不符合数据契约。');
  return { output, usage: usageOf(raw) };
}
