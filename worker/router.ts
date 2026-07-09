// T3/T4/T13a 服务层路由(技术方案 §4)。管线次序即成本归因次序(PRD AI-07):
//   校验(不扣)→ Turnstile(不扣)→ 配额扣减(DO 强一致)→ 引擎提交 → 提交失败即返还;
//   任务失败(AI-05 三分类)与取消(AI-06)在 /api/task 路由观察到时执行幂等返还。
// 自带 key 通道(D6 ④):携 x-engine-key 的请求跳过配额与熔断(成本归用户),Turnstile 仍验。

import type {
  ApiError,
  ApiErrorClass,
  CancelResponse,
  EngineTask,
  GenerateRequest,
  GenerateResponse,
  HealthResponse,
  QuotaResponse,
  TaskResponse,
} from './api-types';
import { CREDITS_BY_TYPE } from './api-types';
import { getEngine, type Engine, type TaskMapStore } from './engine';
import { parseDemoCodes, verifyTurnstile, visitorKeyOf } from './guards';
import type { DeductResult, RefundResult, StatusResult } from './quota-core';
import type { QuotaOp } from './quota-do';

// —— 环境与依赖(最小手声类型,避免引入 workers-types 与 DOM lib 冲突)——

interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface WorkerEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  QUOTA_DO: DurableObjectNamespaceLike;
  // Secrets(dashboard 设置):
  TURNSTILE_SECRET_KEY?: string;
  DEMO_CODES?: string; // `code[:每日次数]`,逗号分隔;删码即撤销
  TRIPO_API_KEY?: string; // T13a(Workers Secret)
  TRIPO_MODEL_VERSION?: string; // T13a,默认 v2.5-20250123
  TRIPO_TIMEOUT_MS?: string; // T13a,默认 600000
  // Vars(wrangler.jsonc,可覆盖):
  VISITOR_DAILY_LIMIT?: string; // 默认 3(PRD AI-11 / §9)
  DEMO_DEFAULT_LIMIT?: string; // 默认 20
  BREAKER_DAILY_CREDITS?: string; // 默认 3000(= $30/日,技术方案 §6)
  ENGINE_MODE?: string; // T4:'mock' 启用 mock 引擎(wrangler.jsonc 已默认;T13 切真实引擎)
  MOCK_QUEUE_MS?: string; // mock 排队时长,默认 4000
  MOCK_RUN_MS?: string; // mock 生成时长,默认 10000
  MOCK_FAIL_RATE?: string; // mock 随机失败率 0–1,默认 0
}

export interface RouterDeps {
  fetchImpl?: typeof fetch; // Turnstile 上游,可注入
  now?: () => number;
}

// —— 小工具 ——

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const err = (status: number, error: string, cls: ApiErrorClass, message: string, extra?: Partial<ApiError>): Response =>
  Response.json({ ok: false, error, class: cls, message, ...extra } satisfies ApiError, { status });

const quotaStub = (env: WorkerEnv): DurableObjectStub => env.QUOTA_DO.get(env.QUOTA_DO.idFromName('global'));

async function quotaCall<T>(env: WorkerEnv, op: QuotaOp): Promise<T> {
  const res = await quotaStub(env).fetch('https://quota.do/', { method: 'POST', body: JSON.stringify(op) });
  return (await res.json()) as T;
}

// T13a:任务映射后端 —— 复用配额 DO(mapPut/mapGet),自带 key 任务不经此(无账务)
function taskMapOf(env: WorkerEnv): TaskMapStore {
  return {
    put: async (engineId, billingId) => {
      await quotaCall(env, { op: 'mapPut', engineId, billingId });
    },
    get: async (engineId) => (await quotaCall<{ billingId: string | null }>(env, { op: 'mapGet', engineId })).billingId,
  };
}

function engineOf(env: WorkerEnv, deps: RouterDeps): Engine | null {
  return getEngine(env, { now: deps.now, fetchImpl: deps.fetchImpl, taskMap: taskMapOf(env) });
}

interface VisitorCtx {
  visitorKey: string;
  limitTimes: number;
  demo: 'none' | 'active' | 'invalid';
  demoCode?: string;
}

async function visitorCtxOf(req: Request, env: WorkerEnv): Promise<VisitorCtx> {
  const clientId = req.headers.get('x-client-id') ?? 'anon';
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const visitorKey = await visitorKeyOf(clientId, ip);
  const demoHeader = req.headers.get('x-demo-code')?.trim();
  const baseLimit = num(env.VISITOR_DAILY_LIMIT, 3);
  if (!demoHeader) return { visitorKey, limitTimes: baseLimit, demo: 'none' };
  const codes = parseDemoCodes(env.DEMO_CODES, num(env.DEMO_DEFAULT_LIMIT, 20));
  const demoLimit = codes.get(demoHeader);
  if (demoLimit === undefined) return { visitorKey, limitTimes: baseLimit, demo: 'invalid' };
  return { visitorKey, limitTimes: demoLimit, demo: 'active', demoCode: demoHeader };
}

// —— 各端点 ——

function health(env: WorkerEnv, deps: RouterDeps): Response {
  const engine = engineOf(env, deps);
  const body: HealthResponse = {
    ok: true,
    service: '3d-std worker',
    at: new Date().toISOString(),
    config: {
      turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
      engine: engine !== null,
      engineName: engine?.name ?? null,
      promptMax: engine?.promptMaxLength ?? 2000,
      demoCodes: parseDemoCodes(env.DEMO_CODES, num(env.DEMO_DEFAULT_LIMIT, 20)).size,
    },
  };
  return Response.json(body);
}

async function quota(req: Request, env: WorkerEnv): Promise<Response> {
  const ctx = await visitorCtxOf(req, env);
  const breakerLimit = num(env.BREAKER_DAILY_CREDITS, 3000);
  const s = await quotaCall<StatusResult>(env, {
    op: 'status',
    visitorKey: ctx.visitorKey,
    limitTimes: ctx.limitTimes,
    breakerLimitCredits: breakerLimit,
  });
  const body: QuotaResponse = {
    ok: true,
    day: s.day,
    visitor: { used: s.used, limit: ctx.limitTimes, remaining: s.remaining },
    breaker: { usedCredits: s.breakerCredits, limitCredits: breakerLimit, open: s.breakerOpen },
    demo: ctx.demo,
  };
  return Response.json(body);
}

async function generate(req: Request, env: WorkerEnv, deps: RouterDeps): Promise<Response> {
  // 1. 校验(validation 类,不进入扣减——PRD AI-07「配额不足属提交前拦截」同理,校验失败更在其前)
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return err(400, 'bad_json', 'validation', '请求体不是合法 JSON。');
  }
  if (body.type !== 'text' && body.type !== 'image') {
    return err(400, 'bad_type', 'validation', 'type 须为 text 或 image。');
  }
  if (body.type === 'image') {
    // 图生的上传通道随 T12(前端)/T13(引擎)接线;此前直接拦截,零配额消耗。
    return err(501, 'image_not_wired', 'not_implemented', '图生通道随 T12/T13 接线,当前仅路由占位。');
  }
  const prompt = body.prompt?.trim() ?? '';
  if (!prompt) return err(400, 'empty_prompt', 'validation', 'prompt 不能为空。');
  // T13a:上限取引擎上报值(Tripo 上游硬限 1024 < 服务层默认 2000)——在校验层如实拦截,
  // 而非提交后由上游打回(那会走「扣减 → 返还」白绕一圈,且报错含糊)
  const engine = engineOf(env, deps);
  const promptMax = engine?.promptMaxLength ?? 2000;
  if (prompt.length > promptMax) {
    return err(400, 'prompt_too_long', 'validation', `prompt 超长(上限 ${promptMax} 字符)。`);
  }

  // 2. Turnstile(D6 ①):secret 未配置按 service 类失败关闭入口(fail-closed),不静默放行
  const token = body.turnstileToken?.trim();
  if (!token) return err(403, 'turnstile_required', 'turnstile', '缺少人机验证 token。');
  if (!env.TURNSTILE_SECRET_KEY) {
    return err(503, 'turnstile_unconfigured', 'service', 'TURNSTILE_SECRET_KEY 未配置——按 README T3 步骤在 Workers 设置里添加(可先用测试 secret)。');
  }
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const verdict = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip, deps.fetchImpl ?? fetch);
  if (!verdict.ok) {
    return err(403, 'turnstile_failed', 'turnstile', '人机验证未通过。', { codes: verdict.codes });
  }

  // 3. 配额扣减(自带 key 跳过;PRD AI-11「自带 API key 解锁通道」)
  const ownKey = req.headers.get('x-engine-key')?.trim() || undefined;
  const ctx = await visitorCtxOf(req, env);
  const credits = CREDITS_BY_TYPE[body.type];
  const taskId = `t_${crypto.randomUUID()}`;
  let charged = false;

  if (!ownKey) {
    const breakerLimit = num(env.BREAKER_DAILY_CREDITS, 3000);
    const d = await quotaCall<DeductResult>(env, {
      op: 'deduct',
      visitorKey: ctx.visitorKey,
      taskId,
      credits,
      limitTimes: ctx.limitTimes,
      breakerLimitCredits: breakerLimit,
      demoCode: ctx.demoCode,
    });
    if (!d.ok) {
      if (d.error === 'budget_exhausted') {
        // D6 ③:全局熔断降级文案——今日额度已用完 + 自带 key
        return err(429, 'budget_exhausted', 'quota', '今日站点生成额度已用完,请明日再来或使用自带 API key。');
      }
      return err(429, 'quota_exhausted', 'quota', '今日生成配额已用完(明日再来,或使用自带 API key)。');
    }
    charged = true;
  }

  // 4. 引擎提交(引擎缺位 → 立即返还,保留 T3 账务验收路径;ENGINE_MODE 置空即可回到此分支)
  if (!engine) {
    let refunded = false;
    if (charged) {
      const r = await quotaCall<RefundResult>(env, { op: 'refund', taskId });
      refunded = r.refunded;
    }
    return err(503, 'engine_unavailable', 'service', '生成引擎未接入(ENGINE_MODE 未配);本次扣减已按 AI-07 返还。', {
      refunded,
      taskId,
    });
  }

  try {
    const task = await engine.submit(body, taskId, ownKey);
    return Response.json({ ok: true, engine: engine.name, task } satisfies GenerateResponse);
  } catch (e) {
    // 提交即失败 = 服务侧问题,不让用户买单(AI-07)
    let refunded = false;
    if (charged) {
      const r = await quotaCall<RefundResult>(env, { op: 'refund', taskId });
      refunded = r.refunded;
    }
    // T13a-fix1:原因必须可诊断——日志记全文,响应带脱敏摘要(自造的错误串只含状态码/错误码,无密钥)。
    const reason = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    console.error(`[submit-fail] engine=${engine.name} task=${taskId} reason=${reason}`);
    const hint = reason.includes('tripo_key_missing')
      ? '服务端未配置 TRIPO_API_KEY(检查 Secret 名与是否重新部署)'
      : /http=40[13]/.test(reason)
        ? '引擎鉴权失败:API key 无效、过期或复制时混入空白字符'
        : reason;
    return err(502, 'engine_submit_failed', 'service', `任务提交到引擎失败;本次扣减已按 AI-07 返还。(${hint})`, { refunded, taskId });
  }
}

// —— /api/task/:id(T4:轮询代理 + 失败返还;T13 换真实引擎时本函数零改动)——

async function taskQuery(env: WorkerEnv, deps: RouterDeps, id: string, ownKey?: string): Promise<Response> {
  const engine = engineOf(env, deps);
  if (!engine) return err(501, 'task_query_not_wired', 'not_implemented', '生成引擎未接入(ENGINE_MODE 未配)。');
  let task: EngineTask;
  try {
    task = await engine.query(id, ownKey);
  } catch {
    return err(502, 'engine_query_failed', 'service', '引擎查询失败,请稍后重试。');
  }
  let refunded: boolean | undefined;
  if (task.status === 'failed') {
    // AI-05:三类失败均返还(幂等:重复轮询只有首个观察者真正执行);service 类留运营告警痕迹
    if (task.failReason === 'service') console.error(`[alert] engine service failure task=${id}`);
    const billingId = await engine.billingIdOf(id);
    if (billingId) {
      const r = await quotaCall<RefundResult>(env, { op: 'refund', taskId: billingId });
      refunded = r.refunded;
    }
  }
  return Response.json({ ok: true, task, ...(refunded === undefined ? {} : { refunded }) } satisfies TaskResponse);
}

async function taskCancel(env: WorkerEnv, deps: RouterDeps, id: string, ownKey?: string): Promise<Response> {
  const engine = engineOf(env, deps);
  if (!engine) return err(501, 'task_cancel_not_wired', 'not_implemented', '生成引擎未接入(ENGINE_MODE 未配)。');
  try {
    await engine.cancel(id, ownKey);
  } catch {
    // 引擎侧取消失败不阻塞返还:成本归因看用户意图,不看上游配合度(AI-07)
  }
  const billingId = await engine.billingIdOf(id);
  let refunded = false;
  if (billingId) {
    const r = await quotaCall<RefundResult>(env, { op: 'refund', taskId: billingId });
    refunded = r.refunded;
  }
  return Response.json({ ok: true, canceled: true, refunded } satisfies CancelResponse);
}

// —— /api/task/:id/result(T13a:结果代理,技术方案 D3 的 AI-02 硬需求)——
// 上游预签名地址不落盘、不透传给浏览器(CORS 姿态不可控且会过期);
// 每次代理现查上游取新鲜地址并流式转发。自带 key 任务需随请求携 x-engine-key。

async function taskResult(env: WorkerEnv, deps: RouterDeps, id: string, ownKey?: string): Promise<Response> {
  const engine = engineOf(env, deps);
  if (!engine) return err(501, 'result_not_wired', 'not_implemented', '生成引擎未接入(ENGINE_MODE 未配)。');
  if (!engine.resultAsset) {
    // mock 的结果本就同源(/mock-assets/*),不经代理
    return err(404, 'result_proxy_unsupported', 'validation', '当前引擎无结果代理(mock 结果为同源静态资产)。');
  }
  let asset: { url: string } | null;
  try {
    asset = await engine.resultAsset(id, ownKey);
  } catch {
    return err(502, 'engine_query_failed', 'service', '引擎查询失败,请稍后重试。');
  }
  if (!asset) {
    return err(404, 'result_unavailable', 'validation', '结果不存在或已过期(上游保留期有限;「接受」后资产已入本地库,不受影响)。');
  }
  let upstream: Response;
  try {
    upstream = await (deps.fetchImpl ?? fetch)(asset.url);
  } catch {
    return err(502, 'result_fetch_failed', 'service', '结果拉取失败,请稍后重试。');
  }
  if (!upstream.ok || !upstream.body) {
    return err(502, 'result_fetch_failed', 'service', `结果拉取失败(上游 ${upstream.status}),请稍后重试。`);
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'model/gltf-binary',
      'content-disposition': 'inline; filename="model.glb"',
      'cache-control': 'private, no-store', // 预签名会过期,不缓存陈旧地址的产物
    },
  });
}

// —— 总入口 ——

export async function handleRequest(req: Request, env: WorkerEnv, deps: RouterDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

  if (path === '/api/health' && req.method === 'GET') return health(env, deps);
  if (path === '/api/quota' && req.method === 'GET') return quota(req, env);
  if (path === '/api/generate' && req.method === 'POST') return generate(req, env, deps);

  const ownKey = req.headers.get('x-engine-key')?.trim() || undefined;
  const taskResultM = /^\/api\/task\/([^/]+)\/result$/.exec(path);
  if (taskResultM && req.method === 'GET') return taskResult(env, deps, decodeURIComponent(taskResultM[1]), ownKey);
  const taskGet = /^\/api\/task\/([^/]+)$/.exec(path);
  if (taskGet && req.method === 'GET') return taskQuery(env, deps, decodeURIComponent(taskGet[1]), ownKey);
  const taskCancelM = /^\/api\/task\/([^/]+)\/cancel$/.exec(path);
  if (taskCancelM && req.method === 'POST') return taskCancel(env, deps, decodeURIComponent(taskCancelM[1]), ownKey);
  if (path === '/api/transfer' && req.method === 'POST') {
    return err(501, 'transfer_not_wired', 'not_implemented', 'R2 转存随 T13 接线。');
  }
  return err(404, 'not_found', 'validation', '未知 API 路由。');
}
