import { describe, expect, it, vi } from 'vitest';
import type { CreationConceptApiOutput, CreationConceptApiRequest, CreationConceptScheme } from '../src/agent/creation-concept-api-types';
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
    AIHUBMIX_API_KEY: 'concept-secret', CREATION_AGENT_PROVIDER: 'aihubmix', ...over,
  };
}

const scheme = (id: string, score: number): CreationConceptScheme => ({
  schemeId: id, title: `方向 ${id}`, tagline: '清晰轮廓与结构层次', description: '保留主题，同时调整轮廓、材质和姿态构图。',
  visualKeywords: ['完整主体', '清晰轮廓', '结构分层'], silhouetteStrategy: '使用大中小三级轮廓。', colorMaterialStrategy: '主辅色清楚，材质不过度碎片化。',
  poseComposition: '三分之四视角完整展示。', printableStrategy: '减少悬空细杆并加厚承力结构。', strengths: ['识别度高'], tradeoffs: ['细节有所收敛'],
  scores: { briefFit: score, distinctiveness: score - 2, printability: score - 4 },
  imagePrompt: 'single full-body 3D character concept, clean background', negativePrompt: 'text, watermark, cropped body, multiple characters',
});

const output: CreationConceptApiOutput = {
  schemaVersion: 'creation-concept-output.v1', summary: '三套方案分别强调亲和、动势与结构。',
  schemes: [scheme('a', 92), scheme('b', 86), scheme('c', 80)], recommendedSchemeId: 'a', recommendationReason: '最均衡。', nextAction: 'select_scheme',
};

const requestBody = (): CreationConceptApiRequest => ({
  schemaVersion: 'creation-concept-input.v1', requestId: 'concept-1', locale: 'zh-CN', desiredSchemeCount: 3,
  brief: { ...emptyCreationBrief(), subject: '蘑菇冒险家', projectType: 'character', purpose: 'resin_print', style: '可爱卡通' },
});

const post = (env: WorkerEnv, body: unknown, fetchImpl?: typeof fetch) => handleRequest(new Request('https://x.dev/api/agent/creation/concepts', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'concept-client' }, body: JSON.stringify(body),
}), env, { fetchImpl });

const successFetch = (inspect?: (url: string, body: Record<string, unknown>, init?: RequestInit) => void): typeof fetch => async (url, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  inspect?.(String(url), body, init);
  return Response.json({ status: 'completed', usage: { input_tokens: 240, output_tokens: 720, total_tokens: 960 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
};

describe('M1.14b 视觉方案 Worker', () => {
  it('只调用 Responses API 规划文字方案，并使用 strict schema 与 no-store', async () => {
    const response = await post(makeEnv(), requestBody(), successFetch((url, body, init) => {
      expect(url).toBe('https://aihubmix.com/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer concept-secret');
      expect(body.store).toBe(false);
      expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true, name: 'creation_concept_output' } });
      expect(JSON.stringify(body)).not.toContain('concept-secret');
      expect(JSON.stringify(body)).not.toContain('/api/generate');
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, result: { recommendedSchemeId: 'a' }, meta: { provider: 'aihubmix', usage: { totalTokens: 960 } } });
    expect(body.result.schemes).toHaveLength(3);
    expect(body.result.schemes[0]).toMatchObject({ schemeId: 'a' });
  });

  it('Brief 不完整时在扣减和上游调用前拒绝', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const bad = requestBody();
    bad.brief.style = null;
    const response = await post(makeEnv(), bad, fetchImpl);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'brief_not_confirmable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('上游失败返还独立视觉规划额度', async () => {
    const env = makeEnv({ CREATION_CONCEPT_DAILY_LIMIT: '1' });
    const failed = await post(env, requestBody(), async () => new Response('bad', { status: 500 }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'creation_concept_failed', refunded: true });
    expect((await post(env, requestBody(), successFetch())).status).toBe(200);
    expect((await post(env, requestBody(), successFetch())).status).toBe(429);
  });
});
