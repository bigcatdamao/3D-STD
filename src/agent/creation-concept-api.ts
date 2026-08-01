import { apiHeaders } from '../net/visitor';
import type {
  CreationConceptApiRequest,
  CreationConceptApiSuccess,
  CreationConceptApiOutput,
} from './creation-concept-api-types';
import { isJsonApiResponse, serviceVersionMismatchMessage } from './api-response';

export class CreationConceptApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function requestCreationConcepts(
  request: CreationConceptApiRequest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ result: CreationConceptApiOutput; meta: CreationConceptApiSuccess['meta'] }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 70_000);
  try {
    const response = await (options.fetchImpl ?? fetch)('/api/agent/creation/concepts', {
      method: 'POST',
      headers: { ...apiHeaders({ includeEngineKey: false }), 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!isJsonApiResponse(response)) {
      throw new CreationConceptApiError(
        'service_version_mismatch',
        serviceVersionMismatchMessage('视觉方案服务'),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CreationConceptApiError('bad_response', '视觉方案服务返回了无法解析的响应。');
    }
    if (!response.ok || !body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      const error = body as { error?: unknown; message?: unknown };
      throw new CreationConceptApiError(
        typeof error.error === 'string' ? error.error : 'request_failed',
        typeof error.message === 'string' ? error.message : '视觉方案暂时不可用。',
      );
    }
    const success = body as CreationConceptApiSuccess;
    return { result: success.result, meta: success.meta };
  } catch (error) {
    if (error instanceof CreationConceptApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new CreationConceptApiError('timeout', '视觉方案规划超时。');
    throw new CreationConceptApiError('network', '无法连接视觉方案服务。');
  } finally {
    window.clearTimeout(timer);
  }
}
