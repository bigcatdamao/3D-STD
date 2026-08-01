import { describe, expect, it } from 'vitest';
import type { CreationImageApiRequest } from '../src/agent/creation-image-api-types';
import type { CreationConceptScheme } from '../src/agent/creation-concept-api-types';
import { emptyCreationBrief } from '../src/agent/creation-agent-logic';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';

function makeEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  const instances = new Map<string, QuotaDO>();
  const instanceOf = (name: string) => {
    let instance = instances.get(name); if (instance) return instance;
    const memory = new Map<string, unknown>();
    const state: DurableState = { storage: { get: async <T,>(key: string) => memory.get(key) as T | undefined, put: async (key: string, value: unknown) => void memory.set(key, value) } };
    instance = new QuotaDO(state); instances.set(name, instance); return instance;
  };
  return {
    ASSETS: { fetch: async () => new Response('spa') },
    QUOTA_DO: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: (url: string, init?: RequestInit) => instanceOf(String(id)).fetch(new Request(url, init)) }) },
    AIHUBMIX_API_KEY: 'image-secret', ...over,
  };
}

const scheme: CreationConceptScheme = {
  schemeId: 'a', title: '圆润冒险家', tagline: '清晰友好', description: '大菌盖和短小身体。', visualKeywords: ['圆润', '菌盖', '冒险'],
  silhouetteStrategy: '上大下小', colorMaterialStrategy: '绿色和米白', poseComposition: '站立', printableStrategy: '加厚细节', strengths: ['识别度高'], tradeoffs: ['细节收敛'],
  scores: { briefFit: 90, distinctiveness: 88, printability: 86 }, imagePrompt: 'cute mushroom adventurer full body', negativePrompt: 'text, cropped',
};
const requestBody = (mode: CreationImageApiRequest['mode'] = 'concept'): CreationImageApiRequest => ({
  schemaVersion: 'creation-image-input.v1', requestId: 'image-1', locale: 'zh-CN', mode,
  brief: { ...emptyCreationBrief(), subject: '蘑菇冒险家', projectType: 'character', purpose: 'resin_print', style: '圆润卡通' }, scheme, referenceSummary: null,
});
const post = (env: WorkerEnv, fetchImpl: typeof fetch, mode: CreationImageApiRequest['mode'] = 'concept') => handleRequest(new Request('https://x.dev/api/agent/creation/images', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'image-client' }, body: JSON.stringify(requestBody(mode)),
}), env, { fetchImpl });
const pngBase64 = 'A'.repeat(200);

describe('M1.15a 付费效果图 Worker', () => {
  it('只在明确请求后调用已验证的 Images API', async () => {
    const response = await post(makeEnv(), async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(url)).toBe('https://api.aihubmix.com/v1/images/generations');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer image-secret');
      expect(body).toMatchObject({ model: 'gpt-image-2', n: 1, size: '1024x1024', quality: 'low', response_format: 'b64_json' });
      expect(String(body.prompt)).toContain('蘑菇冒险家');
      expect(JSON.stringify(body)).not.toContain('image-secret');
      return Response.json({ data: [{ b64_json: pngBase64 }] });
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { mode: 'concept', mimeType: 'image/png', imageBase64: pngBase64 } });
  });

  it('三视图提示要求同一对象三个等宽视角', async () => {
    const response = await post(makeEnv(), async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      expect(body.prompt).toContain('exactly three equal vertical panels');
      expect(body.prompt).toContain('FRONT view');
      return Response.json({ data: [{ b64_json: pngBase64 }] });
    }, 'turntable_sheet');
    expect(response.status).toBe(200);
  });

  it('上游失败返还独立生图额度', async () => {
    const env = makeEnv({ CREATION_IMAGE_DAILY_LIMIT: '1' });
    const failed = await post(env, async () => Response.json({ error: { code: 'no_available_channel' } }, { status: 400 }));
    expect(failed.status).toBe(502); expect(await failed.json()).toMatchObject({ refunded: true, providerCode: 'no_available_channel' });
    expect((await post(env, async () => Response.json({ data: [{ b64_json: pngBase64 }] }))).status).toBe(200);
    expect((await post(env, async () => Response.json({ data: [{ b64_json: pngBase64 }] }))).status).toBe(429);
  });
});
