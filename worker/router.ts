// T3 服务层路由(技术方案 §4)。管线次序即成本归因次序(PRD AI-07):
//   校验(不扣)→ Turnstile(不扣)→ 配额扣减(DO 强一致)→ 引擎提交 → 失败即返还。
// 自带 key 通道(D6 ④):携 x-engine-key 的请求跳过配额与熔断(成本归用户),Turnstile 仍验。

import type { ApiError, ApiErrorClass, GenerateRequest, HealthResponse, QuotaResponse } from './api-types';
import { CREDITS_BY_TYPE } from './api-types';
import { getEngine } from './engine';
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
  TRIPO_API_KEY?: string; // T13
  // Vars(wrangler.jsonc,可覆盖):
  VISITOR_DAILY_LIMIT?: string; // 默认 3(PRD AI-11 / §9)
  DEMO_DEFAULT_LIMIT?: string; // 默认 20
  BREAKER_DAILY_CREDITS?: string; // 默认 3000(= $30/日,技术方案 §6)
  ENGINE_MODE?: string; // T4
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

function health(env: WorkerEnv): Response {
  const body: HealthResponse = {
    ok: true,
    service: '3d-std worker',
    at: new Date().toISOString(),
    config: {
      turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
      engine: getEngine(env) !== null,
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
  if (prompt.length > 2000) return err(400, 'prompt_too_long', 'validation', 'prompt 超长(上限 2000 字符)。');

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

  // 4. 引擎提交(T3 未接入 → 立即走返还路径,账务链先行可验收;T4 起此分支被 mock/真实引擎替换)
  const engine = getEngine(env);
  if (!engine) {
    let refunded = false;
    if (charged) {
      const r = await quotaCall<RefundResult>(env, { op: 'refund', taskId });
      refunded = r.refunded;
    }
    return err(503, 'engine_unavailable', 'service', '生成引擎随 T4(mock)/T13(Tripo)接线;本次扣减已按 AI-07 返还。', {
      refunded,
      taskId,
    });
  }

  // (T4 起)const task = await engine.submit(body, ownKey); return Response.json({ ok: true, task });
  return err(500, 'unreachable', 'service', '内部状态异常。');
}

// —— 总入口 ——

export async function handleRequest(req: Request, env: WorkerEnv, deps: RouterDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

  if (path === '/api/health' && req.method === 'GET') return health(env);
  if (path === '/api/quota' && req.method === 'GET') return quota(req, env);
  if (path === '/api/generate' && req.method === 'POST') return generate(req, env, deps);

  // T4/T13 占位:路由已立,能力随任务接线
  if (/^\/api\/task\/[^/]+$/.test(path) && req.method === 'GET') {
    return err(501, 'task_query_not_wired', 'not_implemented', '任务查询随 T4 接线(mock 引擎)。');
  }
  if (/^\/api\/task\/[^/]+\/cancel$/.test(path) && req.method === 'POST') {
    return err(501, 'task_cancel_not_wired', 'not_implemented', '任务取消随 T4 接线。');
  }
  if (path === '/api/transfer' && req.method === 'POST') {
    return err(501, 'transfer_not_wired', 'not_implemented', 'R2 转存随 T13 接线。');
  }
  return err(404, 'not_found', 'validation', '未知 API 路由。');
}
