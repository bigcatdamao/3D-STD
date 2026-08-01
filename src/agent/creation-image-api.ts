import { apiHeaders } from '../net/visitor';
import type { CreationImageApiRequest, CreationImageApiSuccess } from './creation-image-api-types';

export class CreationImageApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function requestCreationImage(
  request: CreationImageApiRequest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CreationImageApiSuccess> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const response = await (options.fetchImpl ?? fetch)('/api/agent/creation/images', {
      method: 'POST',
      headers: { ...apiHeaders({ includeEngineKey: false }), 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch { throw new CreationImageApiError('bad_response', '生图服务返回了无法解析的响应。'); }
    if (!response.ok || !body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      const error = body as { error?: unknown; message?: unknown };
      throw new CreationImageApiError(
        typeof error.error === 'string' ? error.error : 'request_failed',
        typeof error.message === 'string' ? error.message : '效果图生成暂时不可用。',
      );
    }
    return body as CreationImageApiSuccess;
  } catch (error) {
    if (error instanceof CreationImageApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new CreationImageApiError('timeout', '效果图生成超时。');
    throw new CreationImageApiError('network', '无法连接效果图生成服务。');
  } finally {
    window.clearTimeout(timer);
  }
}
