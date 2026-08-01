import creationAgentOutputSchema from '../docs/contracts/creation-agent-output.schema.json';
import type {
  CreationAgentApiOutput,
  CreationAgentApiRequest,
  CreationAgentBrief,
  CreationAgentQuestion,
  CreationQuestionTarget,
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
const questionTargets = new Set<CreationQuestionTarget>([
  'subject', 'project_type', 'purpose', 'style', 'target_height', 'pose', 'preferred_part_count', 'notes',
]);

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
  if (
    typeof question.questionId !== 'string'
    || typeof question.targetField !== 'string'
    || !questionTargets.has(question.targetField as CreationQuestionTarget)
    || typeof question.question !== 'string'
    || question.allowFreeText !== true
  ) return false;
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
    && output.questions.length <= 1
    && output.questions.every(validQuestion)
    && typeof output.nextAction === 'string'
    && nextActions.has(output.nextAction)
    && (output.nextAction !== 'ask_questions' || output.questions.length === 1)
    && (output.nextAction === 'ask_questions' || output.questions.length === 0)
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

const INSTRUCTIONS = `你是 3D-STD 的“3D 创作 Agent”，通过自然对话把用户模糊的想法整理成可编辑、可继续生成视觉方案的 Brief。

对话原则：
1. 先理解，再追问。必须提取本轮消息和历史中已经明确的信息，绝不重复询问已经确认的内容。
2. 每轮最多追问 1 个真正会改变造型结果的关键问题。用户可以不选快捷选项而自由回答。
3. 若用户说“你决定”“都可以”或把某项交给 Agent，请做合理、保守、可编辑的专业假设，写入 brief 和 assumptions，不要继续追问该项。
4. 创作对象、模型类型、用途和视觉风格足以开始视觉探索时，questions 必须为空，nextAction 必须为 ready_for_concept。高度、姿态、拆件数量通常不是阻塞项。
5. 只有用户明确要求复刻某个特定对象且文字不足时才使用 request_reference；参考图不是一般创作的必填项。
6. 你只理解需求和整理 Brief。不得声称已经生成图片、三视图、3D 模型、拆件或修改几何，也不得自动触发付费服务。

字段约束：
- projectType 只能是 character、mecha、prop、product、scene、other、unknown。
- purpose 只能是 resin_print、fdm_print、display、prototype、unknown。
- question.targetField 只能是 subject、project_type、purpose、style、target_height、pose、preferred_part_count、notes。
- readiness.missingFields 只列阻塞视觉探索的 subject、projectType、purpose、style；不要把高度、姿态、拆件数量列为缺失阻塞项。
- 提问必须直接对应一个缺失字段，targetField 必须与问题一致；不要用 notes 提笼统的“还有什么要求”。
- 如果提问，提供 2–4 个简洁的快捷建议，最多 1 个 recommended=true；allowFreeText 必须为 true。
- 所有面向用户的文本使用简体中文。严格只输出 JSON，不输出 Markdown。`;

function requestContextOf(request: CreationAgentApiRequest): Record<string, unknown> {
  return {
    task: '合并已有 Brief、最近对话和本轮消息，返回更新后的完整 Brief。不要丢失已有字段。',
    currentBrief: request.brief,
    recentHistory: request.history.slice(-12),
    message: request.message,
    referenceImageCount: request.referenceImageCount,
  };
}

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

function chatTextOf(response: Record<string, unknown>): string | null {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const finishReason = (first as { finish_reason?: unknown }).finish_reason;
  if (finishReason === 'length') throw new CreationAgentUpstreamError('incomplete', '创作 Agent 输出达到长度上限。');
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const typed = message as { content?: unknown; refusal?: unknown };
  if (typeof typed.refusal === 'string' && typed.refusal) throw new CreationAgentUpstreamError('refusal', '模型拒绝了本次创作需求整理。');
  return typeof typed.content === 'string' ? typed.content : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function usageOf(raw: Record<string, unknown>): ResponsesUsage {
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  return {
    inputTokens: tokenCount(inputTokens),
    outputTokens: tokenCount(outputTokens),
    totalTokens: tokenCount(usage.total_tokens),
  };
}

function parseStructuredOutput(text: string): CreationAgentApiOutput {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let output: unknown;
  try {
    output = JSON.parse(cleaned);
  } catch {
    throw new CreationAgentUpstreamError('bad_output', '创作 Agent 的结构化结果无法解析。');
  }
  if (!validOutput(output)) throw new CreationAgentUpstreamError('bad_output', '创作 Agent 的结果不符合数据契约。');
  return output;
}

async function providerRequest(
  config: ResponsesConfig,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
    throw new CreationAgentUpstreamError('upstream', `模型服务返回 HTTP ${failure.status}。`, failure.status, failure.code);
  }
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new CreationAgentUpstreamError('bad_output', '创作 Agent 返回了无法解析的结果。');
  }
}

export async function callCreationAgentResponses(
  request: CreationAgentApiRequest,
  config: ResponsesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ output: CreationAgentApiOutput; usage: ResponsesUsage }> {
  const raw = await providerRequest(config, {
    model: config.model,
    store: false,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(requestContextOf(request)) }] }],
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
  }, fetchImpl);
  if (raw.status === 'incomplete') throw new CreationAgentUpstreamError('incomplete', '创作 Agent 未完成结构化输出。');
  const text = outputTextOf(raw);
  if (!text) throw new CreationAgentUpstreamError('bad_output', '创作 Agent 未返回结构化文本。');
  return { output: parseStructuredOutput(text), usage: usageOf(raw) };
}

/** DeepSeek V4 在 AIHubMix 使用 OpenAI Chat Completions + JSON Object，服务端继续做严格契约校验。 */
export async function callCreationAgentChatCompletions(
  request: CreationAgentApiRequest,
  config: ResponsesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ output: CreationAgentApiOutput; usage: ResponsesUsage }> {
  const schema = JSON.stringify(creationAgentOutputSchema);
  const raw = await providerRequest(config, {
    model: config.model,
    stream: false,
    thinking: { type: 'disabled' },
    temperature: 0.2,
    max_tokens: config.maxOutputTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${INSTRUCTIONS}\n\n输出 JSON 必须匹配以下契约：${schema}` },
      { role: 'user', content: JSON.stringify(requestContextOf(request)) },
    ],
  }, fetchImpl);
  const text = chatTextOf(raw);
  if (!text) throw new CreationAgentUpstreamError('bad_output', '创作 Agent 未返回 JSON 文本。');
  return { output: parseStructuredOutput(text), usage: usageOf(raw) };
}
