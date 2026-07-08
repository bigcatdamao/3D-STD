// T3/T4:路由层集成测试——用真实 QuotaDO(内存存储)跑通两条管线:
//   T3 引擎缺位:「校验 → Turnstile → 扣减 → 立即返还」(ENGINE_MODE 置空时的降级保底);
//   T4 mock 引擎:「扣减 → 提交 → 轮询 → 成功计费 / 失败返还 / 取消返还」的完整任务生命周期,
// 验证 PRD AI-05/06/07 成本归因与 D6 四层防滥用在 HTTP 边界上的行为。
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  CancelResponse,
  GenerateResponse,
  HealthResponse,
  QuotaResponse,
  TaskResponse,
} from '../worker/api-types';
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

const gen = (
  env: WorkerEnv,
  body: unknown,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = okTurnstile,
  now?: () => number,
) =>
  handleRequest(
    new Request('https://x.dev/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'cid-1', 'cf-connecting-ip': '1.2.3.4', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    { fetchImpl, now },
  );

const taskGet = async (env: WorkerEnv, id: string, now?: () => number, headers: Record<string, string> = {}) => {
  const res = await handleRequest(
    new Request(`https://x.dev/api/task/${encodeURIComponent(id)}`, { headers }),
    env,
    { now },
  );
  return { status: res.status, body: (await res.json()) as TaskResponse | ApiError };
};

const taskCancel = async (env: WorkerEnv, id: string, now?: () => number, headers: Record<string, string> = {}) => {
  const res = await handleRequest(
    new Request(`https://x.dev/api/task/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers }),
    env,
    { now },
  );
  return { status: res.status, body: (await res.json()) as CancelResponse | ApiError };
};

/** T4 试验台:mock 引擎在线(短时间表)+ 可拨时钟 */
const mockRig = (over: Partial<WorkerEnv> = {}) => {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const env = makeEnv({ ENGINE_MODE: 'mock', MOCK_QUEUE_MS: '1000', MOCK_RUN_MS: '2000', ...over });
  return { clock, now, env };
};

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
    expect(j.config).toEqual({ turnstile: true, engine: false, engineName: null, demoCodes: 2 });
  });

  it('非 /api 路径回退静态资产', async () => {
    const res = await handleRequest(new Request('https://x.dev/some/page'), makeEnv());
    expect(await res.text()).toBe('spa');
  });

  it('引擎未接入时任务路由 501;/api/transfer 占位到 T13', async () => {
    const env = makeEnv(); // 无 ENGINE_MODE
    for (const [url, method] of [
      ['https://x.dev/api/task/abc', 'GET'],
      ['https://x.dev/api/task/abc/cancel', 'POST'],
      ['https://x.dev/api/transfer', 'POST'],
    ] as const) {
      const res = await handleRequest(new Request(url, { method }), env);
      expect(res.status).toBe(501);
      expect(((await res.json()) as ApiError).class).toBe('not_implemented');
    }
    // mock 在线后 transfer 仍占位(R2 转存属 T13)
    const res = await handleRequest(new Request('https://x.dev/api/transfer', { method: 'POST' }), makeEnv({ ENGINE_MODE: 'mock' }));
    expect(res.status).toBe(501);
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

// ============================== T4:mock 引擎生命周期 ==============================

describe('router · T4 mock 引擎在线', () => {
  it('/api/health 报告 engine=true + engineName=mock', async () => {
    const { env } = mockRig();
    const res = await handleRequest(new Request('https://x.dev/api/health'), env);
    const j = (await res.json()) as HealthResponse;
    expect(j.config.engine).toBe(true);
    expect(j.config.engineName).toBe('mock');
  });

  it('成功链:提交扣 1 → 排队 → 生成中 → success(resultUrl),成功不返还(AI-07)', async () => {
    const { clock, now, env } = mockRig();
    const res = await gen(env, validBody, {}, okTurnstile, now);
    expect(res.status).toBe(200);
    const j = (await res.json()) as GenerateResponse;
    expect(j.ok).toBe(true);
    expect(j.engine).toBe('mock');
    expect(j.task.status).toBe('queued');
    expect((await quotaOf(env)).visitor.used).toBe(1);

    clock.t += 1500; // 进入生成
    const mid = await taskGet(env, j.task.taskId, now);
    expect((mid.body as TaskResponse).task.status).toBe('running');

    clock.t += 2000; // 越过 runEnd
    const done = await taskGet(env, j.task.taskId, now);
    const dt = (done.body as TaskResponse).task;
    expect(dt.status).toBe('success');
    expect(dt.resultUrl).toMatch(/^\/mock\/(cube|ico|cyl)\.glb$/);
    expect((await quotaOf(env)).visitor.used).toBe(1); // 成功计费,不返还
  });

  it('失败链:@mock:fail=service → 轮询观察到失败即返还,重复轮询幂等(AI-05/07)', async () => {
    const { clock, now, env } = mockRig();
    const res = await gen(env, { ...validBody, prompt: 'x @mock:fail=service' }, {}, okTurnstile, now);
    const j = (await res.json()) as GenerateResponse;
    expect((await quotaOf(env)).visitor.used).toBe(1);

    clock.t += 10_000;
    const p1 = await taskGet(env, j.task.taskId, now);
    const b1 = p1.body as TaskResponse;
    expect(b1.task).toMatchObject({ status: 'failed', failReason: 'service' });
    expect(b1.refunded).toBe(true); // 首个观察者执行返还
    expect((await quotaOf(env)).visitor.used).toBe(0);

    const p2 = await taskGet(env, j.task.taskId, now);
    expect((p2.body as TaskResponse).refunded).toBe(false); // 幂等:二次轮询不再返还
    expect((await quotaOf(env)).visitor.used).toBe(0); // 不会返成负账
  });

  it('取消链:排队/生成中取消均返还,重复取消幂等(AI-06/07)', async () => {
    const { clock, now, env } = mockRig();
    const j = (await (await gen(env, validBody, {}, okTurnstile, now)).json()) as GenerateResponse;
    expect((await quotaOf(env)).visitor.used).toBe(1);

    clock.t += 1500; // 生成中
    const c1 = await taskCancel(env, j.task.taskId, now);
    expect(c1.body).toMatchObject({ ok: true, canceled: true, refunded: true });
    expect((await quotaOf(env)).visitor.used).toBe(0);

    const c2 = await taskCancel(env, j.task.taskId, now);
    expect((c2.body as CancelResponse).refunded).toBe(false);
  });

  it('自带 key:提交不扣减;失败轮询返还为 no-op,账目不受扰(D6 ④)', async () => {
    const { clock, now, env } = mockRig();
    const res = await gen(env, { ...validBody, prompt: 'x @mock:fail=timeout' }, { 'x-engine-key': 'user-key' }, okTurnstile, now);
    expect(res.status).toBe(200);
    expect((await quotaOf(env)).visitor.used).toBe(0);
    const j = (await res.json()) as GenerateResponse;
    clock.t += 10_000;
    const p = await taskGet(env, j.task.taskId, now);
    expect((p.body as TaskResponse).task.failReason).toBe('timeout');
    expect((p.body as TaskResponse).refunded).toBe(false); // ledger 无此账目,幂等 no-op
    expect((await quotaOf(env)).visitor.used).toBe(0);
  });

  it('垃圾 taskId 轮询:按 timeout 类失败返回(§4 失败语义),不炸不返还', async () => {
    const { now, env } = mockRig();
    const p = await taskGet(env, 'not-a-real-task', now);
    expect(p.status).toBe(200);
    const b = p.body as TaskResponse;
    expect(b.task).toMatchObject({ status: 'failed', failReason: 'timeout' });
    expect(b.refunded).toBeUndefined(); // 无账务键,跳过返还
  });

  it('注入指令覆盖时长:@mock:queue=0 直接进入生成', async () => {
    const { now, env } = mockRig();
    const res = await gen(env, { ...validBody, prompt: 'x @mock:queue=0 @mock:run=5s' }, {}, okTurnstile, now);
    const j = (await res.json()) as GenerateResponse;
    expect(j.task.status).toBe('running');
  });

  it('引擎缺位回退:去掉 ENGINE_MODE 即回到 T3「扣减→立即返还」链', async () => {
    const env = makeEnv(); // 无 ENGINE_MODE
    const res = await gen(env, validBody);
    expect(res.status).toBe(503);
    const j = (await res.json()) as ApiError;
    expect(j.error).toBe('engine_unavailable');
    expect(j.refunded).toBe(true);
    expect((await quotaOf(env)).visitor.used).toBe(0);
  });
});
