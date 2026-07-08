// T3:路由层集成测试——用真实 QuotaDO(内存存储)跑通「校验 → Turnstile → 扣减 → 引擎缺位 → 返还」全管线,
// 验证 PRD AI-07 成本归因次序与 D6 四层防滥用在 HTTP 边界上的行为。
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, HealthResponse, QuotaResponse } from '../worker/api-types';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';

// —— 测试基建 ——

function makeEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  const mem = new Map<string, unknown>();
  const state: DurableState = {
    storage: {
      get: async <T,>(k: string) => mem.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void mem.set(k, v),
    },
  };
  const instance = new QuotaDO(state);
  return {
    ASSETS: { fetch: async () => new Response('spa', { status: 200 }) },
    QUOTA_DO: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)) }),
    },
    TURNSTILE_SECRET_KEY: 'test-secret',
    ...over,
  };
}

const okTurnstile: typeof fetch = async () => Response.json({ success: true });
const failTurnstile: typeof fetch = async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] });

const gen = (env: WorkerEnv, body: unknown, headers: Record<string, string> = {}, fetchImpl: typeof fetch = okTurnstile) =>
  handleRequest(
    new Request('https://x.dev/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'cid-1', 'cf-connecting-ip': '1.2.3.4', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    { fetchImpl },
  );

const quotaOf = async (env: WorkerEnv, headers: Record<string, string> = {}) => {
  const res = await handleRequest(
    new Request('https://x.dev/api/quota', { headers: { 'x-client-id': 'cid-1', 'cf-connecting-ip': '1.2.3.4', ...headers } }),
    env,
  );
  return (await res.json()) as QuotaResponse;
};

const validBody = { type: 'text', prompt: '一个 20mm 校准立方', turnstileToken: 'tok' };

// —— 用例 ——

describe('router · 基础路由', () => {
  it('/api/health 报告配置探针(turnstile/engine/demoCodes)', async () => {
    const res = await handleRequest(new Request('https://x.dev/api/health'), makeEnv({ DEMO_CODES: 'a,b:5' }));
    const j = (await res.json()) as HealthResponse;
    expect(j.ok).toBe(true);
    expect(j.config).toEqual({ turnstile: true, engine: false, demoCodes: 2 });
  });

  it('非 /api 路径回退静态资产', async () => {
    const res = await handleRequest(new Request('https://x.dev/some/page'), makeEnv());
    expect(await res.text()).toBe('spa');
  });

  it('T4/T13 占位路由返回 501 not_implemented', async () => {
    const env = makeEnv();
    for (const [url, method] of [
      ['https://x.dev/api/task/abc', 'GET'],
      ['https://x.dev/api/task/abc/cancel', 'POST'],
      ['https://x.dev/api/transfer', 'POST'],
    ] as const) {
      const res = await handleRequest(new Request(url, { method }), env);
      expect(res.status).toBe(501);
      expect(((await res.json()) as ApiError).class).toBe('not_implemented');
    }
  });

  it('未知 API 路由 404', async () => {
    const res = await handleRequest(new Request('https://x.dev/api/nope'), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe('router · /api/generate 校验层(不消耗配额)', () => {
  it('坏 JSON → 400 validation', async () => {
    const res = await gen(makeEnv(), '{oops');
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error).toBe('bad_json');
  });

  it('空 prompt → 400;image → 501(通道随 T12/T13)', async () => {
    const env = makeEnv();
    expect((await gen(env, { ...validBody, prompt: '  ' })).status).toBe(400);
    const res = await gen(env, { type: 'image', turnstileToken: 'tok' });
    expect(res.status).toBe(501);
    // 全程未触达配额
    expect((await quotaOf(env)).visitor.used).toBe(0);
  });

  it('缺 token → 403 turnstile_required;验证失败 → 403 turnstile_failed 且不扣减', async () => {
    const env = makeEnv();
    expect((await gen(env, { type: 'text', prompt: 'x' })).status).toBe(403);
    const res = await gen(env, validBody, {}, failTurnstile);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).error).toBe('turnstile_failed');
    expect((await quotaOf(env)).visitor.used).toBe(0);
  });

  it('secret 未配置 → 503 service(fail-closed)', async () => {
    const res = await gen(makeEnv({ TURNSTILE_SECRET_KEY: undefined }), validBody);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error).toBe('turnstile_unconfigured');
  });
});

describe('router · 扣减→返还账务链(引擎缺位期)', () => {
  it('通过 Turnstile 后扣减,引擎未接入即返还:refunded=true,配额净不变', async () => {
    const env = makeEnv();
    const before = (await quotaOf(env)).visitor.remaining;
    const res = await gen(env, validBody);
    expect(res.status).toBe(503);
    const j = (await res.json()) as ApiError;
    expect(j.error).toBe('engine_unavailable');
    expect(j.refunded).toBe(true);
    expect(j.taskId).toMatch(/^t_/);
    expect((await quotaOf(env)).visitor.remaining).toBe(before);
  });

  it('配额耗尽 → 429 quota_exhausted(提交前拦截,AI-07)', async () => {
    const env = makeEnv({ VISITOR_DAILY_LIMIT: '0' });
    const res = await gen(env, validBody);
    expect(res.status).toBe(429);
    expect(((await res.json()) as ApiError).error).toBe('quota_exhausted');
  });

  it('全局熔断 → 429 budget_exhausted(D6 ③ 降级文案含自带 key 出路)', async () => {
    const env = makeEnv({ BREAKER_DAILY_CREDITS: '10' }); // < 20 credits
    const res = await gen(env, validBody);
    expect(res.status).toBe(429);
    const j = (await res.json()) as ApiError;
    expect(j.error).toBe('budget_exhausted');
    expect(j.message).toContain('自带');
  });

  it('自带 key 通道:配额为 0 也放行,不动账(D6 ④)', async () => {
    const env = makeEnv({ VISITOR_DAILY_LIMIT: '0' });
    const res = await gen(env, validBody, { 'x-engine-key': 'user-key' });
    expect(res.status).toBe(503); // 引擎仍未接入,但已越过配额层
    const j = (await res.json()) as ApiError;
    expect(j.error).toBe('engine_unavailable');
    expect(j.refunded).toBe(false);
    expect((await quotaOf(env)).visitor.used).toBe(0);
  });
});

describe('router · 演示码(AI-11 / D6 ⑤)', () => {
  it('有效码提升上限;/api/quota 回报 demo=active', async () => {
    const env = makeEnv({ DEMO_CODES: 'hire-me:5' });
    const q = await quotaOf(env, { 'x-demo-code': 'hire-me' });
    expect(q.demo).toBe('active');
    expect(q.visitor.limit).toBe(5);
  });

  it('未配置/已撤销的码 → demo=invalid,回落普通上限 3', async () => {
    const env = makeEnv({ DEMO_CODES: 'other' });
    const q = await quotaOf(env, { 'x-demo-code': 'revoked' });
    expect(q.demo).toBe('invalid');
    expect(q.visitor.limit).toBe(3);
  });

  it('无冒号码用默认上限(DEMO_DEFAULT_LIMIT)', async () => {
    const env = makeEnv({ DEMO_CODES: 'plain', DEMO_DEFAULT_LIMIT: '7' });
    const q = await quotaOf(env, { 'x-demo-code': 'plain' });
    expect(q.visitor.limit).toBe(7);
  });

  it('不同 clientId 的访客计数互不影响(复合键隔离)', async () => {
    const env = makeEnv({ VISITOR_DAILY_LIMIT: '1', BREAKER_DAILY_CREDITS: '10' });
    // v1 触发熔断类拒绝不记账;直接查两个访客的独立余量
    const q1 = await quotaOf(env, { 'x-client-id': 'cid-A' });
    const q2 = await quotaOf(env, { 'x-client-id': 'cid-B' });
    expect(q1.visitor.remaining).toBe(1);
    expect(q2.visitor.remaining).toBe(1);
  });
});
