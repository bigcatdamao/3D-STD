import { apiHeaders } from '../net/visitor';
import type { CreationReferenceApiRequest, CreationReferenceApiSuccess } from './creation-reference-api-types';

export class CreationReferenceApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function requestCreationReferenceAnalysis(
  request: CreationReferenceApiRequest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CreationReferenceApiSuccess> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 75_000);
  try {
    const response = await (options.fetchImpl ?? fetch)('/api/agent/creation/reference-analysis', {
      method: 'POST',
      headers: { ...apiHeaders({ includeEngineKey: false }), 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch { throw new CreationReferenceApiError('bad_response', '参考图分析服务返回了无法解析的响应。'); }
    if (!response.ok || !body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      const error = body as { error?: unknown; message?: unknown };
      throw new CreationReferenceApiError(
        typeof error.error === 'string' ? error.error : 'request_failed',
        typeof error.message === 'string' ? error.message : '参考图分析暂时不可用。',
      );
    }
    return body as CreationReferenceApiSuccess;
  } catch (error) {
    if (error instanceof CreationReferenceApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new CreationReferenceApiError('timeout', '参考图分析超时。');
    throw new CreationReferenceApiError('network', '无法连接参考图分析服务。');
  } finally {
    window.clearTimeout(timer);
  }
}
