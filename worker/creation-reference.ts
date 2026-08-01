import creationReferenceOutputSchema from '../docs/contracts/creation-reference-output.schema.json';
import type {
  CreationReferenceApiOutput,
  CreationReferenceApiRequest,
} from '../src/agent/creation-reference-api-types';
import { validCreationBrief } from './creation-agent';
import { providerFailureOf } from './provider-error';
import type { ResponsesConfig, ResponsesUsage } from './split-analysis';

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 700 * 1024;

export class CreationReferenceInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class CreationReferenceUpstreamError extends Error {
  constructor(
    readonly code: 'timeout' | 'refusal' | 'incomplete' | 'bad_output' | 'upstream',
    message: string,
    readonly upstreamStatus: number | null = null,
    readonly providerCode: string | null = null,
  ) { super(message); }
}

function approximateBase64Bytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = url.slice(comma + 1).replace(/\s/g, '');
  return Math.floor(payload.length * 0.75) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
}

export async function parseCreationReferenceRequest(req: Request): Promise<CreationReferenceApiRequest> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new CreationReferenceInputError('request_too_large', '参考图总量超过 3MB。');
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new CreationReferenceInputError('request_too_large', '参考图总量超过 3MB。');
  let body: CreationReferenceApiRequest;
  try { body = JSON.parse(raw) as CreationReferenceApiRequest; } catch { throw new CreationReferenceInputError('bad_json', '参考图请求无法解析。'); }
  if (!body || body.schemaVersion !== 'creation-reference-input.v1') throw new CreationReferenceInputError('bad_schema_version', '不支持的参考图输入版本。');
  if (!body.requestId || body.requestId.length > 128 || body.locale !== 'zh-CN') throw new CreationReferenceInputError('bad_request', '参考图请求标识或语言设置无效。');
  if (!validCreationBrief(body.brief)) throw new CreationReferenceInputError('bad_brief', '当前 Brief 不符合数据契约。');
  if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 3) throw new CreationReferenceInputError('bad_image_count', '每次请添加 1–3 张参考图。');
  const ids = new Set<string>();
  let total = 0;
  for (const image of body.images) {
    if (!image || !image.imageId || image.imageId.length > 80 || ids.has(image.imageId)) throw new CreationReferenceInputError('bad_image_id', '参考图标识无效。');
    ids.add(image.imageId);
    if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(image.imageUrl)) throw new CreationReferenceInputError('bad_image', '仅支持 PNG、JPEG 或 WebP 参考图。');
    const bytes = approximateBase64Bytes(image.imageUrl);
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) throw new CreationReferenceInputError('image_too_large', '单张参考图压缩后不能超过 700KB。');
    total += bytes;
  }
  if (total > 2 * 1024 * 1024) throw new CreationReferenceInputError('images_too_large', '参考图压缩后总量不能超过 2MB。');
  return body;
}

const projectTypes = new Set(['character', 'mecha', 'prop', 'product', 'scene', 'other', 'unknown']);
const listOfStrings = (value: unknown, minimum: number, maximum: number): value is string[] => Array.isArray(value)
  && value.length >= minimum && value.length <= maximum && value.every((item) => typeof item === 'string' && item.length > 0);

function validOutput(value: unknown): value is CreationReferenceApiOutput {
  if (!value || typeof value !== 'object') return false;
  const output = value as Partial<CreationReferenceApiOutput>;
  const patch = output.briefPatch;
  return output.schemaVersion === 'creation-reference-output.v1'
    && typeof output.summary === 'string' && output.summary.length > 0
    && typeof output.subject === 'string' && typeof output.style === 'string' && typeof output.silhouette === 'string'
    && listOfStrings(output.colorPalette, 1, 8) && listOfStrings(output.materials, 1, 8)
    && listOfStrings(output.distinctiveFeatures, 1, 10) && typeof output.pose === 'string'
    && (output.viewCoverage === 'single_view' || output.viewCoverage === 'partial_multiview' || output.viewCoverage === 'usable_multiview')
    && listOfStrings(output.risks, 0, 8)
    && !!patch && (patch.subject === null || typeof patch.subject === 'string')
    && typeof patch.projectType === 'string' && projectTypes.has(patch.projectType)
    && (patch.style === null || typeof patch.style === 'string') && (patch.pose === null || typeof patch.pose === 'string')
    && listOfStrings(patch.notes, 0, 8)
    && typeof output.confidence === 'number' && output.confidence >= 0 && output.confidence <= 1
    && (output.nextAction === 'continue_dialogue' || output.nextAction === 'review_brief');
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
      if (typed.type === 'refusal') throw new CreationReferenceUpstreamError('refusal', '模型拒绝分析参考图。');
      if (typed.type === 'output_text' && typeof typed.text === 'string') return typed.text;
    }
  }
  return null;
}

const token = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
function usageOf(raw: Record<string, unknown>): ResponsesUsage {
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : {};
  return { inputTokens: token(usage.input_tokens), outputTokens: token(usage.output_tokens), totalTokens: token(usage.total_tokens) };
}

const INSTRUCTIONS = `你是 3D-STD 的参考图理解助手。观察用户上传的 1–3 张图片，为后续 3D 概念设计提取可验证的主体、风格、轮廓、颜色、材质、姿态和关键特征。
不要猜测图片背面或不可见结构；不要把 UI 截图、商品页或拼贴误当成干净的三视图。briefPatch 只提供从图片中有证据支持的字段，notes 保留可操作特征。
输出简体中文，严格遵守 JSON Schema。`;

export async function callCreationReferenceResponses(
  request: CreationReferenceApiRequest,
  config: ResponsesConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ output: CreationReferenceApiOutput; usage: ResponsesUsage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: JSON.stringify({ currentBrief: request.brief, imageCount: request.images.length }) }];
  request.images.forEach((image, index) => {
    content.push({ type: 'input_text', text: `参考图 ${index + 1}（${image.imageId}）` });
    content.push({ type: 'input_image', image_url: image.imageUrl, detail: 'low' });
  });
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model, store: false, instructions: INSTRUCTIONS,
        input: [{ role: 'user', content }],
        max_output_tokens: config.maxOutputTokens,
        text: { format: { type: 'json_schema', name: 'creation_reference_output', strict: true, schema: creationReferenceOutputSchema } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new CreationReferenceUpstreamError('timeout', '参考图分析超时。');
    throw new CreationReferenceUpstreamError('upstream', '参考图分析服务暂时无法连接。');
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const failure = await providerFailureOf(response);
    throw new CreationReferenceUpstreamError('upstream', `Responses API 返回 HTTP ${failure.status}。`, failure.status, failure.code);
  }
  let raw: Record<string, unknown>;
  try { raw = await response.json() as Record<string, unknown>; } catch { throw new CreationReferenceUpstreamError('bad_output', '参考图分析返回了无法解析的结果。'); }
  if (raw.status === 'incomplete') throw new CreationReferenceUpstreamError('incomplete', '参考图分析未完成结构化输出。');
  const text = outputTextOf(raw);
  if (!text) throw new CreationReferenceUpstreamError('bad_output', '参考图分析未返回结构化文本。');
  let output: unknown;
  try { output = JSON.parse(text); } catch { throw new CreationReferenceUpstreamError('bad_output', '参考图结构化结果无法解析。'); }
  if (!validOutput(output)) throw new CreationReferenceUpstreamError('bad_output', '参考图结果不符合数据契约。');
  return { output, usage: usageOf(raw) };
}
