// T13a:真实引擎在 HTTP 边界上的集成测试。fetch 桩按 URL 分流(Turnstile / Tripo 上游 / 结果 CDN),
// QuotaDO 用真实类 + 内存存储 —— 与 worker-router.test.ts 同一套基建口径。
// 覆盖:提交扣减 + 映射入档、queued/running/success 全程、结果代理流式转发、
// banned/failed 的分类返还与账务净零、取消返还(自带 key 与服务 key 两个通道)、
// prompt 上限 1024 的校验前移、key 缺位的 AI-07 返还、mock 结果代理的 404 分支。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, CancelResponse, GenerateResponse, HealthResponse, QuotaResponse, TaskResponse } from '../worker/api-types';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';
import { TRIPO_BASE } from '../worker/tripo-engine';

// —— 可编程的 Tripo 上游桩 ——

interface UpstreamTask {
  status: string;
  progress?: number;
  create_time?: number;
  queuing_num?: number;
  consumed_credit?: number;
  output?: { model?: string; pbr_model?: string };
}

function makeWorld() {
  const mem = new Map<string, unknown>();
  const state: DurableState = {
    storage: {
      get: async <T,>(k: string) => mem.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void mem.set(k, v),
    },
  };
  const instance = new QuotaDO(state);

  const upstream = {
    tasks: new Map<string, UpstreamTask>(),
    nextId: 'tp_1',
    submitCount: 0,
    lastSubmitBody: null as unknown,
    lastAuth: '',
    modelBytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer, // "glTF"
  };

  const fetchImpl: typeof fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('challenges.cloudflare.com')) return Response.json({ success: true });
    if (url === `${TRIPO_BASE}/task` && init?.method === 'POST') {
      upstream.submitCount++;
      upstream.lastSubmitBody = JSON.parse(String(init.body));
      upstream.lastAuth = (init.headers as Record<string, string>).authorization;
      const id = upstream.nextId;
      upstream.tasks.set(id, { status: 'queued', queuing_num: 3, create_time: Date.now() / 1000 });
      return Response.json({ code: 0, data: { task_id: id } });
    }
    const m = new RegExp(`^${TRIPO_BASE}/task/([^/]+)$`).exec(url);
    if (m) {
      const t = upstream.tasks.get(decodeURIComponent(m[1]));
      if (!t) return Response.json({ code: 2010, message: 'task not found' }, { status: 400 });
      return Response.json({ code: 0, data: { task_id: m[1], ...t } });
    }
    if (url === 'https://cdn.tripo.example/model.glb') {
      return new Response(upstream.modelBytes, { headers: { 'content-type': 'model/gltf-binary' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const env: WorkerEnv = {
    ASSETS: { fetch: async () => new Response('spa') },
    QUOTA_DO: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: (u: string, i?: RequestInit) => instance.fetch(new Request(u, i)) }),
    },
    TURNSTILE_SECRET_KEY: 'test-secret',
    ENGINE_MODE: 'tripo',
    TRIPO_API_KEY: 'sk-service',
  };

  const call = (path: string, init?: RequestInit) =>
    handleRequest(new Request(`https://x.dev${path}`, init), env, { fetchImpl });

  const gen = (prompt: string, headers: Record<string, string> = {}) =>
    call('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'c1', ...headers },
      body: JSON.stringify({ type: 'text', prompt, turnstileToken: 'tok' }),
    });

  const remaining = async (): Promise<number> => {
    const r = await call('/api/quota', { headers: { 'x-client-id': 'c1' } });
    return ((await r.json()) as QuotaResponse).visitor.remaining;
  };

  return { env, call, gen, remaining, upstream };
}

let w: ReturnType<typeof makeWorld>;
beforeEach(() => {
  w = makeWorld();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('T13a · /api/health', () => {
  it('engineName = tripo(前端诊断面板据此禁用演练)', async () => {
    const j = (await (await w.call('/api/health')).json()) as HealthResponse;
    expect(j.config).toMatchObject({ engine: true, engineName: 'tripo' });
  });
});

describe('T13a · 成功主链:提交 → 排队 → 生成 → success → 结果代理', () => {
  it('全程协议正确,成功计费不返还,结果经代理流式取回', async () => {
    const before = await w.remaining();
    const r = await w.gen('一只章鱼花盆 @mock:run=5s'); // 指令会被剥离后送上游
    const j = (await r.json()) as GenerateResponse;
    expect(j.ok).toBe(true);
    expect(j.engine).toBe('tripo');
    expect(j.task).toMatchObject({ taskId: 'tp_1', status: 'queued' });
    expect(w.upstream.lastSubmitBody).toMatchObject({ type: 'text_to_model', prompt: '一只章鱼花盆' });
    expect(w.upstream.lastAuth).toBe('Bearer sk-service');

    // queued(带队列位)
    let t = (await (await w.call('/api/task/tp_1')).json()) as TaskResponse;
    expect(t.task).toMatchObject({ status: 'queued', queuePosition: 3 });

    // running
    w.upstream.tasks.set('tp_1', { status: 'running', progress: 55, create_time: Date.now() / 1000 });
    t = (await (await w.call('/api/task/tp_1')).json()) as TaskResponse;
    expect(t.task).toMatchObject({ status: 'running', progress: 55 });

    // success:resultUrl 是同源代理路径
    w.upstream.tasks.set('tp_1', {
      status: 'success',
      progress: 100,
      create_time: Date.now() / 1000,
      consumed_credit: 20,
      output: { pbr_model: 'https://cdn.tripo.example/model.glb' },
    });
    t = (await (await w.call('/api/task/tp_1')).json()) as TaskResponse;
    expect(t.task).toMatchObject({ status: 'success', resultUrl: '/api/task/tp_1/result' });
    expect(t.refunded).toBeUndefined();

    // 结果代理:同源取回模型字节
    const res = await w.call('/api/task/tp_1/result');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));

    // 成功计费:净 -1(AI-07)
    expect(await w.remaining()).toBe(before - 1);
  });
});

describe('T13a · 失败分类与账务净零(AI-05/07)', () => {
  it('banned → moderation,返还使配额净零;重复轮询幂等', async () => {
    const before = await w.remaining();
    await w.gen('x');
    w.upstream.tasks.set('tp_1', { status: 'banned', create_time: Date.now() / 1000 });
    const t1 = (await (await w.call('/api/task/tp_1')).json()) as TaskResponse;
    expect(t1.task.failReason).toBe('moderation');
    expect(t1.refunded).toBe(true);
    const t2 = (await (await w.call('/api/task/tp_1')).json()) as TaskResponse;
    expect(t2.refunded).toBe(false); // 幂等:首个观察者已执行
    expect(await w.remaining()).toBe(before);
  });

  it('上游 failed → service 类;expired → timeout 类;均返还', async () => {
    const before = await w.remaining();
    await w.gen('x');
    w.upstream.tasks.set('tp_1', { status: 'failed', create_time: Date.now() / 1000 });
    let t = (await (await w.call('/api/task/tp_1')).json()) as TaskResponse;
    expect(t.task.failReason).toBe('service');
    expect(await w.remaining()).toBe(before);

    w.upstream.nextId = 'tp_2';
    await w.gen('y');
    w.upstream.tasks.set('tp_2', { status: 'expired', create_time: Date.now() / 1000 });
    t = (await (await w.call('/api/task/tp_2')).json()) as TaskResponse;
    expect(t.task.failReason).toBe('timeout');
    expect(await w.remaining()).toBe(before);
  });

  it('垃圾 taskId:按 timeout 失败但映射脱靶 → 无返还可执行(防伪造配对)', async () => {
    const before = await w.remaining();
    await w.gen('x'); // 真实扣了一次
    const t = (await (await w.call('/api/task/tp_forged')).json()) as TaskResponse;
    expect(t.task).toMatchObject({ status: 'failed', failReason: 'timeout' });
    expect(t.refunded).toBeUndefined(); // billingIdOf → null,连返还尝试都没有
    expect(await w.remaining()).toBe(before - 1); // 真任务的扣减不受伪造轮询影响
  });
});

describe('T13a · 取消(上游无取消端点,路由层承接)', () => {
  it('取消返还,配额净零;重复取消幂等 false', async () => {
    const before = await w.remaining();
    await w.gen('x');
    const c1 = (await (await w.call('/api/task/tp_1/cancel', { method: 'POST' })).json()) as CancelResponse;
    expect(c1).toMatchObject({ canceled: true, refunded: true });
    expect(await w.remaining()).toBe(before);
    const c2 = (await (await w.call('/api/task/tp_1/cancel', { method: 'POST' })).json()) as CancelResponse;
    expect(c2.refunded).toBe(false);
  });
});

describe('T13a · 自带 key 通道(D6 ④)', () => {
  it('Bearer 用 ownKey、不扣配额、不写映射;取消无账可退', async () => {
    const before = await w.remaining();
    const r = await w.gen('x', { 'x-engine-key': 'sk-user' });
    expect(((await r.json()) as GenerateResponse).ok).toBe(true);
    expect(w.upstream.lastAuth).toBe('Bearer sk-user');
    expect(await w.remaining()).toBe(before); // 未扣
    const c = (await (
      await w.call('/api/task/tp_1/cancel', { method: 'POST', headers: { 'x-engine-key': 'sk-user' } })
    ).json()) as CancelResponse;
    expect(c).toMatchObject({ canceled: true, refunded: false });
  });
});

describe('T13a · 校验与降级', () => {
  it('prompt 上限取引擎上报值 1024(校验前移,零配额消耗)', async () => {
    const before = await w.remaining();
    const r = await w.gen('长'.repeat(1025));
    expect(r.status).toBe(400);
    const e = (await r.json()) as ApiError;
    expect(e.error).toBe('prompt_too_long');
    expect(e.message).toContain('1024');
    expect(await w.remaining()).toBe(before);
  });

  it('1024 以内放行(mock 时代的 2000 上限已按引擎收紧)', async () => {
    const r = await w.gen('长'.repeat(1024));
    expect(((await r.json()) as GenerateResponse).ok).toBe(true);
  });

  it('服务 key 缺位 + 无自带 key:提交抛错 → AI-07 返还,净零', async () => {
    w.env.TRIPO_API_KEY = undefined;
    const before = await w.remaining();
    const r = await w.gen('x');
    expect(r.status).toBe(502);
    const e = (await r.json()) as ApiError;
    expect(e).toMatchObject({ error: 'engine_submit_failed', refunded: true });
    expect(await w.remaining()).toBe(before);
  });

  it('mock 引擎下结果代理如实 404(mock 结果为同源静态资产)', async () => {
    w.env.ENGINE_MODE = 'mock';
    const r = await w.call('/api/task/whatever/result');
    expect(r.status).toBe(404);
    expect(((await r.json()) as ApiError).error).toBe('result_proxy_unsupported');
  });
});

describe('T13a · QuotaDO 映射 op', () => {
  it('mapPut/mapGet 直连:写入命中、未知脱靶', async () => {
    const stub = w.env.QUOTA_DO.get(w.env.QUOTA_DO.idFromName('global'));
    await stub.fetch('https://q.do/', { method: 'POST', body: JSON.stringify({ op: 'mapPut', engineId: 'e1', billingId: 'b1' }) });
    const hit = await (
      await stub.fetch('https://q.do/', { method: 'POST', body: JSON.stringify({ op: 'mapGet', engineId: 'e1' }) })
    ).json();
    expect(hit).toMatchObject({ billingId: 'b1' });
    const miss = await (
      await stub.fetch('https://q.do/', { method: 'POST', body: JSON.stringify({ op: 'mapGet', engineId: 'nope' }) })
    ).json();
    expect(miss).toMatchObject({ billingId: null });
  });
});
