import { describe, expect, it, vi } from 'vitest';
import type { CreationAgentApiOutput, CreationAgentApiRequest } from '../src/agent/creation-agent-api-types';
import { emptyCreationBrief } from '../src/agent/creation-agent-logic';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';

function makeEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  const instances = new Map<string, QuotaDO>();
  const instanceOf = (name: string) => {
    let instance = instances.get(name);
    if (instance) return instance;
    const memory = new Map<string, unknown>();
    const state: DurableState = { storage: { get: async <T,>(key: string) => memory.get(key) as T | undefined, put: async (key: string, value: unknown) => void memory.set(key, value) } };
    instance = new QuotaDO(state);
    instances.set(name, instance);
    return instance;
  };
  return {
    ASSETS: { fetch: async () => new Response('spa') },
    QUOTA_DO: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: (url: string, init?: RequestInit) => instanceOf(String(id)).fetch(new Request(url, init)) }) },
    AIHUBMIX_API_KEY: 'server-secret',
    CREATION_AGENT_PROVIDER: 'aihubmix',
    ...over,
  };
}

const requestBody = (): CreationAgentApiRequest => ({
  schemaVersion: 'creation-agent-input.v1', requestId: 'creation-1', locale: 'zh-CN',
  message: '我想做一台适合 FDM 打印的科幻机甲', brief: emptyCreationBrief(), history: [], referenceImageCount: 0,
});

const output: CreationAgentApiOutput = {
  schemaVersion: 'creation-agent-output.v1',
  message: '方向已经清楚，请确认创作需求。',
  brief: { ...emptyCreationBrief(), subject: '科幻机甲', projectType: 'mecha', purpose: 'fdm_print', style: '科幻机甲' },
  questions: [], nextAction: 'review_brief', readiness: { score: 1, missingFields: [] }, assumptions: [],
};

const post = (env: WorkerEnv, body: unknown, fetchImpl?: typeof fetch) => handleRequest(new Request('https://x.dev/api/agent/creation', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'client-1' }, body: JSON.stringify(body),
}), env, { fetchImpl });

const successFetch = (inspect?: (url: string, body: Record<string, unknown>, init?: RequestInit) => void): typeof fetch => async (url, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  inspect?.(String(url), body, init);
  return Response.json({ status: 'completed', usage: { input_tokens: 120, output_tokens: 90, total_tokens: 210 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
};

const chatSuccessFetch = (inspect?: (url: string, body: Record<string, unknown>, init?: RequestInit) => void): typeof fetch => async (url, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  inspect?.(String(url), body, init);
  return Response.json({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 130, completion_tokens: 80, total_tokens: 210 },
  });
};

describe('M1.16b 创作 Agent Worker', () => {
  it('仅经服务端 Secret 调用 Responses API，并使用 strict schema 与 no-store', async () => {
    const response = await post(makeEnv(), requestBody(), successFetch((url, body, init) => {
      expect(url).toBe('https://api.aihubmix.com/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer server-secret');
      expect(body.store).toBe(false);
      expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true, name: 'creation_agent_output' } });
      const schemaText = JSON.stringify((body.text as { format: { schema: unknown } }).format.schema);
      expect(schemaText).not.toContain('"$schema"');
      expect(schemaText).not.toContain('"const"');
      expect(JSON.stringify(body)).not.toContain('server-secret');
      expect(JSON.stringify(body)).not.toContain('/api/generate');
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { nextAction: 'review_brief' }, meta: { provider: 'aihubmix', usage: { totalTokens: 210 } } });
  });

  it('DeepSeek V4 自动走 Chat Completions JSON 协议并继续服务端校验', async () => {
    const response = await post(
      makeEnv({ CREATION_AGENT_MODEL: 'deepseek-v4-flash' }),
      requestBody(),
      chatSuccessFetch((url, body, init) => {
        expect(url).toBe('https://api.aihubmix.com/v1/chat/completions');
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer server-secret');
        expect(body.model).toBe('deepseek-v4-flash');
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.response_format).toEqual({ type: 'json_object' });
        expect(body.messages).toBeInstanceOf(Array);
        expect(JSON.stringify(body)).not.toContain('server-secret');
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, meta: { model: 'deepseek-v4-flash', usage: { totalTokens: 210 } } });
  });

  it('无服务端密钥时 fail-closed，前端可明确走本地降级', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await post(makeEnv({ AIHUBMIX_API_KEY: undefined }), requestBody(), fetchImpl);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'creation_agent_unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('上游失败会返还本轮独立配额', async () => {
    const env = makeEnv({ CREATION_AGENT_DAILY_LIMIT: '1' });
    const failed = await post(env, requestBody(), async () => Response.json({ error: { type: 'invalid_request_error', code: 'invalid_schema' } }, { status: 400 }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'creation_agent_request_incompatible', refunded: true, upstreamStatus: 400, providerCode: 'invalid_schema' });
    expect((await post(env, requestBody(), successFetch())).status).toBe(200);
    expect((await post(env, requestBody(), successFetch())).status).toBe(429);
  });
});
