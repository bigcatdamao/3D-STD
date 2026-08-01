import type {
  CreationAgentApiOutput,
  CreationAgentApiRequest,
  CreationAgentApiSuccess,
} from './creation-agent-api-types';
import { apiHeaders } from '../net/visitor';

export class CreationAgentApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function requestCreationAgent(
  request: CreationAgentApiRequest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ result: CreationAgentApiOutput; meta: CreationAgentApiSuccess['meta'] }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 55_000);
  try {
    const response = await (options.fetchImpl ?? fetch)('/api/agent/creation', {
      method: 'POST',
      // 创作 Agent 只使用服务端 Secret；浏览器临时保存的 3D 引擎 key 不应随本请求上行。
      headers: { ...apiHeaders({ includeEngineKey: false }), 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CreationAgentApiError('bad_response', '创作 Agent 返回了无法解析的响应。');
    }
    if (!response.ok || !body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      const error = body as { error?: unknown; message?: unknown };
      throw new CreationAgentApiError(
        typeof error.error === 'string' ? error.error : 'request_failed',
        typeof error.message === 'string' ? error.message : '创作 Agent 暂时不可用。',
      );
    }
    const success = body as CreationAgentApiSuccess;
    return { result: success.result, meta: success.meta };
  } catch (error) {
    if (error instanceof CreationAgentApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new CreationAgentApiError('timeout', '创作 Agent 响应超时。');
    }
    throw new CreationAgentApiError('network', '无法连接创作 Agent。');
  } finally {
    window.clearTimeout(timer);
  }
}
