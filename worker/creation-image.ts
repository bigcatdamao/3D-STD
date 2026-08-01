import type { CreationImageApiRequest, CreationImageMode } from '../src/agent/creation-image-api-types';
import { validCreationBrief } from './creation-agent';
import { providerFailureOf } from './provider-error';

const MAX_BODY_BYTES = 64 * 1024;

export class CreationImageInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class CreationImageUpstreamError extends Error {
  constructor(
    readonly code: 'timeout' | 'bad_output' | 'upstream',
    message: string,
    readonly upstreamStatus: number | null = null,
    readonly providerCode: string | null = null,
  ) { super(message); }
}

export interface CreationImageConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  size: string;
  quality: string;
}

export async function parseCreationImageRequest(req: Request): Promise<CreationImageApiRequest> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new CreationImageInputError('request_too_large', '效果图请求内容过长。');
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new CreationImageInputError('request_too_large', '效果图请求内容过长。');
  let body: CreationImageApiRequest;
  try { body = JSON.parse(raw) as CreationImageApiRequest; } catch { throw new CreationImageInputError('bad_json', '效果图请求无法解析。'); }
  if (!body || body.schemaVersion !== 'creation-image-input.v1') throw new CreationImageInputError('bad_schema_version', '不支持的效果图输入版本。');
  if (!body.requestId || body.requestId.length > 128 || body.locale !== 'zh-CN') throw new CreationImageInputError('bad_request', '效果图请求标识或语言设置无效。');
  if (body.mode !== 'concept' && body.mode !== 'turntable_sheet') throw new CreationImageInputError('bad_mode', '不支持的效果图模式。');
  if (!validCreationBrief(body.brief)) throw new CreationImageInputError('bad_brief', '创作 Brief 不符合数据契约。');
  if (!body.scheme || !body.scheme.schemeId || !body.scheme.title || !body.scheme.imagePrompt || !body.scheme.negativePrompt) throw new CreationImageInputError('bad_scheme', '请先确认一套视觉方案。');
  if (body.referenceSummary !== null && (typeof body.referenceSummary !== 'string' || body.referenceSummary.length > 2_000)) throw new CreationImageInputError('bad_reference_summary', '参考图摘要过长。');
  return body;
}

function promptOf(request: CreationImageApiRequest): string {
  const brief = request.brief;
  const scheme = request.scheme;
  const base = [
    `Create a polished 3D design concept for: ${brief.subject}.`,
    `Project type: ${brief.projectType}. Intended use: ${brief.purpose}. Target style: ${brief.style}.`,
    brief.pose ? `Pose: ${brief.pose}.` : '',
    brief.targetHeightMm ? `The final printable object is intended to be about ${brief.targetHeightMm} mm tall.` : '',
    `Chosen art direction: ${scheme.title}. ${scheme.description}`,
    `Visual direction: ${scheme.imagePrompt}`,
    request.referenceSummary ? `Reference-image observations: ${request.referenceSummary}` : '',
    `Design for a coherent printable object: clear silhouette, readable major forms, connected load-bearing details, no text or watermark.`,
    `Avoid: ${scheme.negativePrompt}`,
  ].filter(Boolean).join('\n');
  if (request.mode === 'turntable_sheet') {
    return `${base}\nCreate one landscape reference sheet divided into exactly three equal vertical panels. Show the exact same object at the exact same scale and materials: FRONT view in the left panel, LEFT SIDE view in the center panel, RIGHT SIDE view in the right panel. Neutral light-gray background, orthographic-like camera, full object visible in every panel, no perspective dramatization, no labels, no borders, no extra objects.`;
  }
  return `${base}\nSingle full-object three-quarter hero view on a neutral studio background. Keep the complete silhouette visible and make geometry easy to interpret for image-to-3D generation.`;
}

export async function callCreationImage(
  request: CreationImageApiRequest,
  config: CreationImageConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ imageBase64: string; revisedPrompt: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt: promptOf(request),
        n: 1,
        size: config.size,
        quality: config.quality,
        response_format: 'b64_json',
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new CreationImageUpstreamError('timeout', '效果图生成超时。');
    throw new CreationImageUpstreamError('upstream', '效果图服务暂时无法连接。');
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const failure = await providerFailureOf(response);
    throw new CreationImageUpstreamError('upstream', `Images API 返回 HTTP ${failure.status}。`, failure.status, failure.code);
  }
  let raw: Record<string, unknown>;
  try { raw = await response.json() as Record<string, unknown>; } catch { throw new CreationImageUpstreamError('bad_output', '效果图服务返回了无法解析的响应。'); }
  const first = Array.isArray(raw.data) ? raw.data[0] as Record<string, unknown> | undefined : undefined;
  const imageBase64 = typeof first?.b64_json === 'string' ? first.b64_json : null;
  if (!imageBase64 || imageBase64.length < 100 || imageBase64.length > 24 * 1024 * 1024) throw new CreationImageUpstreamError('bad_output', '效果图服务未返回有效图片。');
  return { imageBase64, revisedPrompt: typeof first?.revised_prompt === 'string' ? first.revised_prompt : null };
}

export function imageWarning(mode: CreationImageMode): string {
  return mode === 'turntable_sheet'
    ? '三视图由生成模型保持视觉一致性，不等同于工程正投影；进入 3D 后仍需检查比例、背面与连接关系。'
    : '效果图用于确认视觉方向和图生 3D，不代表最终网格质量或可打印性。';
}
