import { describe, expect, it, vi } from 'vitest';
import type { SplitAnalysisApiOutput, SplitAnalysisApiRequest } from '../src/agent/split-analysis-api-types';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';

function makeEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  const instances = new Map<string, QuotaDO>();
  const instanceOf = (name: string) => {
    let instance = instances.get(name);
    if (instance) return instance;
    const memory = new Map<string, unknown>();
    const state: DurableState = {
      storage: {
        get: async <T,>(key: string) => memory.get(key) as T | undefined,
        put: async (key: string, value: unknown) => void memory.set(key, value),
      },
    };
    instance = new QuotaDO(state);
    instances.set(name, instance);
    return instance;
  };
  return {
    ASSETS: { fetch: async () => new Response('spa') },
    QUOTA_DO: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (url: string, init?: RequestInit) => instanceOf(String(id)).fetch(new Request(url, init)),
      }),
    },
    OPENAI_API_KEY: 'server-secret',
    ...over,
  };
}

const output: SplitAnalysisApiOutput = {
  schemaVersion: 'split-analysis-output.v1',
  needsSplit: 'yes',
  confidence: 0.84,
  summary: '模型高度超过打印空间，建议分为两件。',
  reasons: [{ reasonId: 'reason-1', code: 'exceeds_build_volume', severity: 'blocking', description: 'Z 轴超限', evidenceRefs: ['object-1'] }],
  recommendedPartCount: { minimum: 2, preferred: 2, maximum: 3, rationale: '两件可适配打印空间。' },
  recommendedRegions: [{
    regionId: 'region-1', objectIds: ['object-1'], label: '腰部结构带', description: '语义候选区域', candidateType: 'natural_seam',
    location: { kind: 'natural_seam', axis: 'z', normalizedPosition: 0.52, landmarks: ['腰部'] },
    rationale: '接缝较隐蔽', confidence: 0.7, evidenceRefs: ['view-front'],
  }],
  schemes: [
    {
      schemeId: 'scheme-1', title: '腰部分件', summary: '沿腰部结构带分为两件', partCount: 2, regionIds: ['region-1'],
      cutSequence: [{ order: 1, regionId: 'region-1', instruction: '先生成平面切割预览', previewRequired: true }],
      pros: ['适配打印空间'], cons: ['增加接缝'],
      impact: { bedFit: 'improved', support: 'unknown', strength: 'unknown', surface: 'neutral', assembly: 'worse' },
      assemblyApproach: 'flat_joint', riskIds: ['risk-1'], confidence: 0.79,
    },
    {
      schemeId: 'scheme-2', title: '三段分件', summary: '按上下结构分为三件', partCount: 3, regionIds: ['region-1'], cutSequence: [],
      pros: ['单件更小'], cons: ['装配更复杂'],
      impact: { bedFit: 'improved', support: 'unknown', strength: 'worse', surface: 'worse', assembly: 'worse' },
      assemblyApproach: 'alignment_pin', riskIds: ['risk-1'], confidence: 0.61,
    },
  ],
  risks: [{ riskId: 'risk-1', severity: 'warning', title: '切面未验证', description: '尚未运行真实几何切割', mitigation: '阶段二先预览', evidenceRefs: [] }],
  nextSteps: [{ order: 1, action: 'review_scheme', description: '审阅候选方案', requiresUserConfirmation: true, suggestedTool: null }],
  limitations: { missingInputs: ['薄壁检测'], unavailableCapabilities: ['preview_plane_cut'], assumptions: ['单位为毫米'], visualUncertainty: 'medium' },
};

function requestBody(): SplitAnalysisApiRequest {
  return {
    input: {
      schemaVersion: 'split-analysis-input.v1', requestId: 'request-1', locale: 'zh-CN',
      goal: { description: '适配打印空间', priorities: ['fit_build_volume'] },
      printing: { process: 'fdm', bedMm: { x: 256, y: 256, z: 256 }, material: null, nozzleMm: 0.4, layerHeightMm: 0.2, assemblyClearanceMm: 0.2 },
      scene: { editVersion: 1, selectionScope: 'visible', objectCount: 1, selectedObjectIds: [], currentPartCount: 1, splitState: 'untouched' },
      objects: [{
        objectId: 'object-1', assetId: 'asset-1', name: '机器人', source: 'import', visible: true, locked: false,
        transform: { positionMm: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
        localBoundsMm: { min: [0, 0, 0], max: [100, 100, 500] }, worldBoundsMm: { min: [0, 0, 0], max: [100, 100, 500] },
        dimensionsMm: [100, 100, 500], faces: 1000, vertices: 600,
      }],
      diagnostics: {
        status: 'not_run', reportEditVersion: null, summary: null, topology: [], issues: [],
        thinWall: { status: 'unavailable', threshold: null, regions: [] },
        surfaceOverhang: { status: 'unavailable', threshold: null, regions: [] },
      },
      currentParts: [{ partId: 'object-1', name: '机器人', kind: 'original', sourceObjectIds: ['object-1'], parentPartId: null, operationId: null, state: 'current' }],
      views: [{ viewId: 'view-front', fieldName: 'view_front', label: 'front', scope: 'visible', width: 16, height: 16, mime: 'image/jpeg', detailHint: 'low' }],
      capabilities: { topology: 'not_run', thinWall: 'unavailable', surfaceOverhang: 'unavailable', cutCandidates: 'unavailable', multiviewCapture: 'available', assemblyValidation: 'unavailable' },
    },
    images: [{ viewId: 'view-front', imageUrl: `data:image/jpeg;base64,${btoa('small-image')}` }],
  };
}

const post = (env: WorkerEnv, body: unknown, fetchImpl?: typeof fetch) => handleRequest(new Request('https://x.dev/api/agent/split-analysis', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-client-id': 'client-1', 'cf-connecting-ip': '1.2.3.4' },
  body: JSON.stringify(body),
}), env, { fetchImpl });

function responsesSuccess(assertRequest?: (url: string, body: Record<string, unknown>, init?: RequestInit) => void): typeof fetch {
  return async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assertRequest?.(String(url), body, init);
    return Response.json({
      id: 'resp-1', status: 'completed',
      usage: { input_tokens: 840, output_tokens: 360, total_tokens: 1200 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
    });
  };
}

describe('M1.6.2 Responses API 拆件分析端点', () => {
  it('只把服务端 secret 发给 OpenAI，并启用 strict schema、低细节视觉证据和 no-store', async () => {
    const fetchImpl = responsesSuccess((url, body, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer server-secret');
      expect(body.model).toBe('gpt-5.6-sol');
      expect(body.store).toBe(false);
      expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
      expect(JSON.stringify(body)).toContain('"detail":"low"');
      expect(JSON.stringify(body)).not.toContain('server-secret');
    });
    const response = await post(makeEnv(), requestBody(), fetchImpl);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, result: { needsSplit: 'yes' }, meta: { provider: 'openai', model: 'gpt-5.6-sol', evidenceViews: 1 } });
    expect(body.meta.latencyMs).toEqual(expect.any(Number));
    expect(body.meta.usage).toEqual({ inputTokens: 840, outputTokens: 360, totalTokens: 1200 });
    expect(JSON.stringify(body)).not.toContain('server-secret');
  });

  it('AIHubMix 使用独立 secret 和固定端点，并保留 OpenAI secret 作为回滚通道', async () => {
    const fetchImpl = responsesSuccess((url, body, init) => {
      expect(url).toBe('https://aihubmix.com/v1/responses');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer aihubmix-secret');
      expect(JSON.stringify(body)).not.toContain('aihubmix-secret');
      expect(JSON.stringify(body)).not.toContain('server-secret');
    });
    const response = await post(makeEnv({
      SPLIT_ANALYSIS_PROVIDER: 'aihubmix',
      AIHUBMIX_API_KEY: 'aihubmix-secret',
    }), requestBody(), fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      meta: { provider: 'aihubmix', model: 'gpt-5.6-sol', evidenceViews: 1, usage: { totalTokens: 1200 } },
    });
  });

  it('缺少服务端密钥时 fail-closed，且不会调用上游', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await post(makeEnv({ OPENAI_API_KEY: undefined }), requestBody(), fetchImpl);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'split_analysis_unconfigured', class: 'service' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('AIHubMix 缺少自己的 secret 时不会回退或误用 OpenAI secret', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await post(makeEnv({ SPLIT_ANALYSIS_PROVIDER: 'aihubmix' }), requestBody(), fetchImpl);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'split_analysis_unconfigured', class: 'service' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('未知 Provider 会 fail-closed，且不会调用任意上游地址', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await post(makeEnv({ SPLIT_ANALYSIS_PROVIDER: 'custom-proxy' }), requestBody(), fetchImpl);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'split_analysis_provider_invalid', class: 'service' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('非法证据在计费和上游调用前被拒绝', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const bad = requestBody();
    bad.images[0].imageUrl = 'https://example.com/private.png';
    const response = await post(makeEnv(), bad, fetchImpl);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'bad_image', class: 'validation' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('上游失败会退款；同一访客在每日 1 次限制下仍可立即重试', async () => {
    const env = makeEnv({ SPLIT_ANALYSIS_DAILY_LIMIT: '1' });
    const failed = await post(env, requestBody(), async () => new Response('upstream', { status: 500 }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'split_analysis_failed', refunded: true });

    const retry = await post(env, requestBody(), responsesSuccess());
    expect(retry.status).toBe(200);
    const exhausted = await post(env, requestBody(), responsesSuccess());
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ error: 'split_analysis_quota_exhausted' });
  });
});
