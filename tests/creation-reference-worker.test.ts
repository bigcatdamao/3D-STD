import { describe, expect, it, vi } from 'vitest';
import type { CreationReferenceApiOutput, CreationReferenceApiRequest } from '../src/agent/creation-reference-api-types';
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
    instance = new QuotaDO(state); instances.set(name, instance); return instance;
  };
  return {
    ASSETS: { fetch: async () => new Response('spa') },
    QUOTA_DO: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: (url: string, init?: RequestInit) => instanceOf(String(id)).fetch(new Request(url, init)) }) },
    AIHUBMIX_API_KEY: 'reference-secret', CREATION_AGENT_PROVIDER: 'aihubmix', ...over,
  };
}

const output: CreationReferenceApiOutput = {
  schemaVersion: 'creation-reference-output.v1', summary: '一只圆润的蘑菇冒险家角色。', subject: '蘑菇冒险家', style: '圆润卡通',
  silhouette: '大菌盖、小身体', colorPalette: ['绿色', '米白'], materials: ['布料', '皮革'], distinctiveFeatures: ['菌盖圆点', '斜挎包'], pose: '站立',
  viewCoverage: 'single_view', risks: ['背面结构不可见'], briefPatch: { subject: '蘑菇冒险家', projectType: 'character', style: '圆润卡通', pose: '站立', notes: ['保留菌盖圆点'] },
  confidence: 0.84, nextAction: 'review_brief',
};

const requestBody = (): CreationReferenceApiRequest => ({
  schemaVersion: 'creation-reference-input.v1', requestId: 'reference-1', locale: 'zh-CN', brief: emptyCreationBrief(),
  images: [{ imageId: 'reference_1', imageUrl: 'data:image/jpeg;base64,/9j/' }],
});

const post = (env: WorkerEnv, fetchImpl?: typeof fetch) => handleRequest(new Request('https://x.dev/api/agent/creation/reference-analysis', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'reference-client' }, body: JSON.stringify(requestBody()),
}), env, { fetchImpl });

const successFetch = (inspect?: (url: string, body: Record<string, unknown>, init?: RequestInit) => void): typeof fetch => async (url, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>; inspect?.(String(url), body, init);
  return Response.json({ status: 'completed', usage: { total_tokens: 420 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
};

describe('M1.15a 参考图 VLM Worker', () => {
  it('以低细节图片和 strict schema 调用独立 VLM', async () => {
    const response = await post(makeEnv(), successFetch((url, body, init) => {
      expect(url).toBe('https://api.aihubmix.com/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer reference-secret');
      expect(body.model).toBe('gemini-2.5-flash');
      expect(JSON.stringify(body)).toContain('input_image');
      expect(JSON.stringify(body)).toContain('creation_reference_output');
      expect(JSON.stringify(body)).not.toContain('reference-secret');
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { subject: '蘑菇冒险家' }, meta: { evidenceImages: 1 } });
  });

  it('失败后返还独立参考图额度', async () => {
    const env = makeEnv({ CREATION_REFERENCE_DAILY_LIMIT: '1' });
    const failed = await post(env, async () => Response.json({ error: { code: 'busy' } }, { status: 429 }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ refunded: true });
    expect((await post(env, successFetch())).status).toBe(200);
    expect((await post(env, successFetch())).status).toBe(429);
  });

  it('兼容 Gemini 将 nullable null 返回为空对象', async () => {
    const quirky = structuredClone(output) as unknown as { briefPatch: Record<string, unknown> };
    quirky.briefPatch.subject = {};
    quirky.briefPatch.style = {};
    quirky.briefPatch.pose = {};
    const response = await post(makeEnv(), async () => Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(quirky) }] }],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { briefPatch: { subject: null, style: null, pose: null } } });
  });

  it('在上游调用前拒绝超过三张图', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const bad = requestBody(); bad.images = [1, 2, 3, 4].map((n) => ({ imageId: `r${n}`, imageUrl: 'data:image/jpeg;base64,/9j/' }));
    const response = await handleRequest(new Request('https://x.dev/api/agent/creation/reference-analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) }), makeEnv(), { fetchImpl });
    expect(response.status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
