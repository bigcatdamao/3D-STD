// T13a:Tripo 适配器单元测试。上游不可达也要能证明协议正确 —— 全部经注入 fetch 桩,
// 覆盖:8→4 状态映射表、超时合成、@mock 指令剥离、2000/5xx 退避重试、账务映射的写入边界、
// 成功输出择取次序、取消 no-op、billingIdOf 的命中/脱靶。真实联调只需验证「上游长什么样」
// 与桩一致(README T13a 验收),协议逻辑本身在此定案。
import { describe, expect, it, vi } from 'vitest';
import type { TaskMapStore } from '../worker/engine';
import { getEngine } from '../worker/engine';
import {
  TRIPO_BASE,
  TripoEngine,
  isSubmitRetryable,
  mapTripoTask,
  pickModelUrl,
  stripDrillDirectives,
  type TripoTaskData,
} from '../worker/tripo-engine';

const memMap = (): TaskMapStore & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    put: async (e, b) => void store.set(e, b),
    get: async (e) => store.get(e) ?? null,
  };
};

const jsonRes = (body: unknown, status = 200): Response => Response.json(body, { status });

const baseOpts = (over: Partial<ConstructorParameters<typeof TripoEngine>[0]> = {}) => ({
  serviceKey: 'sk-service',
  modelVersion: 'v2.5-20250123',
  timeoutMs: 600_000,
  sleep: async () => {},
  ...over,
});

describe('默认 fetch 的 this 绑定(fix2 生产回归)', () => {
  it('未注入 fetchImpl 时,全局 fetch 不以引擎实例为 this 调用', async () => {
    const orig = globalThis.fetch;
    let seenThis: unknown = 'unset';
    globalThis.fetch = function (this: unknown) {
      seenThis = this; // workerd 里 this 为引擎实例即抛 Illegal invocation;这里捕获验证
      return Promise.resolve(Response.json({ code: 0, data: { task_id: 'tp_this' } }));
    } as unknown as typeof fetch;
    try {
      const map = { store: new Map<string, string>(), async put(k: string, v: string) { this.store.set(k, v); }, async get(k: string) { return this.store.get(k) ?? null; } };
      const eng = new TripoEngine(baseOpts({ taskMap: map }));
      const t = await eng.submit({ type: 'text', prompt: 'x' }, 'bill-this', undefined);
      expect(t.taskId).toBe('tp_this');
      expect(seenThis === undefined || seenThis === globalThis).toBe(true); // 绝不能是引擎实例
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('stripDrillDirectives(@mock 指令剥离)', () => {
  it('剥掉指令并收敛空白', () => {
    expect(stripDrillDirectives('一个球 @mock:run=30s')).toBe('一个球');
    expect(stripDrillDirectives('一个杯子 @mock:queue=8s @mock:run=20ms 蓝色')).toBe('一个杯子 蓝色');
  });
  it('纯指令 prompt 剥成空串(路由层 empty_prompt 校验在前,引擎不再兜底)', () => {
    expect(stripDrillDirectives('@mock:fail=timeout')).toBe('');
  });
  it('无指令原样保留', () => {
    expect(stripDrillDirectives('a small cat')).toBe('a small cat');
  });
});

describe('mapTripoTask(8 态 → 协议 4 态)', () => {
  const now = 1_000_000_000_000;
  const fresh = { create_time: now / 1000 - 10 }; // 10 秒前提交
  const d = (over: Partial<TripoTaskData>): TripoTaskData => ({ task_id: 'tp1', status: 'queued', ...fresh, ...over });

  it('queued:透传队列位', () => {
    const t = mapTripoTask(d({ status: 'queued', queuing_num: 7 }), 'tp1', now, 600_000);
    expect(t).toMatchObject({ status: 'queued', progress: 0, queuePosition: 7 });
  });
  it('queued:queuing_num 缺位则不带 queuePosition', () => {
    const t = mapTripoTask(d({ status: 'queued' }), 'tp1', now, 600_000);
    expect(t.status).toBe('queued');
    expect('queuePosition' in t).toBe(false);
  });
  it('running:progress 透传并夹在 0–99', () => {
    expect(mapTripoTask(d({ status: 'running', progress: 42 }), 'tp1', now, 600_000)).toMatchObject({
      status: 'running',
      progress: 42,
    });
    expect(mapTripoTask(d({ status: 'running', progress: 100 }), 'tp1', now, 600_000).progress).toBe(99);
  });
  it('success:resultUrl 指向服务层结果代理(同源,AI-02)', () => {
    const t = mapTripoTask(d({ status: 'success' }), 'tp a', now, 600_000);
    expect(t).toMatchObject({ status: 'success', progress: 100, resultUrl: '/api/task/tp%20a/result' });
  });
  it('banned → moderation(AI-05 出路「修改输入」)', () => {
    expect(mapTripoTask(d({ status: 'banned' }), 'tp1', now, 600_000).failReason).toBe('moderation');
  });
  it('failed → service(引擎侧异常)', () => {
    expect(mapTripoTask(d({ status: 'failed' }), 'tp1', now, 600_000).failReason).toBe('service');
  });
  it.each(['cancelled', 'unknown', 'expired', 'some_future_status'])('%s → timeout(契约:未知/过期按 timeout)', (st) => {
    const t = mapTripoTask(d({ status: st }), 'tp1', now, 600_000);
    expect(t).toMatchObject({ status: 'failed', failReason: 'timeout' });
  });
  it('排队/生成中超过阈值 → 合成 timeout;终态不受阈值影响', () => {
    const old = { create_time: now / 1000 - 700 }; // 700s 前,阈值 600s
    expect(mapTripoTask(d({ status: 'queued', ...old }), 'tp1', now, 600_000).failReason).toBe('timeout');
    expect(mapTripoTask(d({ status: 'running', ...old, progress: 80 }), 'tp1', now, 600_000).failReason).toBe('timeout');
    expect(mapTripoTask(d({ status: 'success', ...old }), 'tp1', now, 600_000).status).toBe('success');
  });
  it('create_time 缺位不做超时合成(数据不全时宁可续轮询)', () => {
    const noTime: TripoTaskData = { task_id: 'tp1', status: 'queued' };
    expect(mapTripoTask(noTime, 'tp1', now, 1).status).toBe('queued');
  });
});

describe('pickModelUrl(成功输出择取:pbr → model → base)', () => {
  it('按优先序取第一个存在者', () => {
    expect(pickModelUrl({ pbr_model: 'p', model: 'm', base_model: 'b' })).toBe('p');
    expect(pickModelUrl({ model: 'm', base_model: 'b' })).toBe('m');
    expect(pickModelUrl({ base_model: 'b' })).toBe('b');
    expect(pickModelUrl({})).toBeNull();
    expect(pickModelUrl(undefined)).toBeNull();
  });
});

describe('isSubmitRetryable(2000 超并发 / 5xx)', () => {
  it('2000 与 5xx 可重试;2002 等业务错不重试', () => {
    expect(isSubmitRetryable(200, 2000)).toBe(true);
    expect(isSubmitRetryable(503, undefined)).toBe(true);
    expect(isSubmitRetryable(400, 2002)).toBe(false);
    expect(isSubmitRetryable(200, 0)).toBe(false);
  });
});

describe('TripoEngine.submit', () => {
  it('载荷正确:剥指令后的 prompt、model_version、Bearer 服务 key;成功后写账务映射', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return jsonRes({ code: 0, data: { task_id: 'tp_777' } });
    }) as typeof fetch;
    const map = memMap();
    const eng = new TripoEngine(baseOpts({ fetchImpl, taskMap: map }));
    const task = await eng.submit({ type: 'text', prompt: '一只狐狸 @mock:run=5s' }, 't_bill1');
    expect(task).toMatchObject({ taskId: 'tp_777', status: 'queued', progress: 0 });
    expect(calls[0].url).toBe(`${TRIPO_BASE}/task`);
    const hdr = calls[0].init?.headers as Record<string, string>;
    expect(hdr.authorization).toBe('Bearer sk-service');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      type: 'text_to_model',
      prompt: '一只狐狸',
      model_version: 'v2.5-20250123',
    });
    expect(map.store.get('tp_777')).toBe('t_bill1');
  });

  it('自带 key:Bearer 用 ownKey 且不写映射(无账务,billingIdOf 自然脱靶)', async () => {
    let auth = '';
    const fetchImpl = (async (_u: any, init?: any) => {
      auth = (init?.headers as Record<string, string>).authorization;
      return jsonRes({ code: 0, data: { task_id: 'tp_own' } });
    }) as typeof fetch;
    const map = memMap();
    const eng = new TripoEngine(baseOpts({ fetchImpl, taskMap: map }));
    await eng.submit({ type: 'text', prompt: 'x' }, 't_bill2', 'sk-user');
    expect(auth).toBe('Bearer sk-user');
    expect(map.store.size).toBe(0);
    expect(await eng.billingIdOf('tp_own')).toBeNull();
  });

  it('2000 超并发:退避重试后成功,重试对调用方不可见(D4)', async () => {
    let n = 0;
    const slept: number[] = [];
    const fetchImpl = (async () => {
      n++;
      return n < 3 ? jsonRes({ code: 2000, message: 'concurrency' }) : jsonRes({ code: 0, data: { task_id: 'tp_r' } });
    }) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl, sleep: async (ms) => void slept.push(ms) }));
    const task = await eng.submit({ type: 'text', prompt: 'x' }, 't_b');
    expect(task.taskId).toBe('tp_r');
    expect(n).toBe(3);
    expect(slept).toEqual([800, 1600]); // 指数退避序列
  });

  it('重试耗尽(持续 5xx)→ 抛错(路由层按 AI-07 返还)', async () => {
    const fetchImpl = (async () => jsonRes({}, 503)) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    await expect(eng.submit({ type: 'text', prompt: 'x' }, 't_b')).rejects.toThrow(/tripo_submit_failed/);
  });

  it('业务错误码(2002)不重试即抛', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return jsonRes({ code: 2002, message: 'bad type' }, 400);
    }) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    await expect(eng.submit({ type: 'text', prompt: 'x' }, 't_b')).rejects.toThrow();
    expect(n).toBe(1);
  });

  it('无服务 key 且无自带 key → 抛 key 缺位(健康面板仍可见引擎在线,提交路径如实失败)', async () => {
    const eng = new TripoEngine(baseOpts({ serviceKey: undefined }));
    await expect(eng.submit({ type: 'text', prompt: 'x' }, 't_b')).rejects.toThrow(/tripo_key_missing/);
  });
});

describe('TripoEngine.query / resultAsset / cancel', () => {
  it('query:上游 success → 协议 success + 代理 resultUrl;记 consumed_credit 对账日志', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = (async () =>
      jsonRes({
        code: 0,
        data: {
          task_id: 'tp1',
          status: 'success',
          progress: 100,
          create_time: Date.now() / 1000,
          consumed_credit: 20,
          output: { pbr_model: 'https://cdn.example/x.glb' },
        },
      })) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    const t = await eng.query('tp1');
    expect(t).toMatchObject({ status: 'success', resultUrl: '/api/task/tp1/result' });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('consumed_credit=20'))).toBe(true);
    spy.mockRestore();
  });

  it('query:封套非 0 / 4xx(垃圾 id)→ 按 timeout 类失败(契约)', async () => {
    const fetchImpl = (async () => jsonRes({ code: 2010, message: 'not found' }, 400)) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    expect(await eng.query('garbage')).toMatchObject({ status: 'failed', failReason: 'timeout' });
  });

  it('query:上游 5xx(瞬时)→ 抛错(不合成失败,客户端续轮询)', async () => {
    const fetchImpl = (async () => jsonRes({}, 502)) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    await expect(eng.query('tp1')).rejects.toThrow(/tripo_upstream_5xx/);
  });

  it('query:401 鉴权失败 → 抛错(配置问题不该伪装成任务失败去触发返还)', async () => {
    const fetchImpl = (async () => jsonRes({}, 401)) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    await expect(eng.query('tp1')).rejects.toThrow(/tripo_auth_failed/);
  });

  it('resultAsset:success 返回上游地址;非终态/失败返回 null', async () => {
    let status = 'running';
    const fetchImpl = (async () =>
      jsonRes({
        code: 0,
        data: { task_id: 'tp1', status, output: { model: 'https://cdn.example/m.glb' } },
      })) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    expect(await eng.resultAsset('tp1')).toBeNull();
    status = 'success';
    expect(await eng.resultAsset('tp1')).toEqual({ url: 'https://cdn.example/m.glb' });
  });

  it('cancel:no-op 且不触上游(上游无取消端点,取消语义在路由层)', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return jsonRes({ code: 0 });
    }) as typeof fetch;
    const eng = new TripoEngine(baseOpts({ fetchImpl }));
    await expect(eng.cancel('tp1')).resolves.toBeUndefined();
    expect(called).toBe(0);
  });
});

describe('getEngine 选取矩阵(T13a 定稿)', () => {
  it("mock / tripo / 置空 三分支;tripo 上报 promptMaxLength=1024", () => {
    expect(getEngine({ ENGINE_MODE: 'mock' })?.name).toBe('mock');
    const tripo = getEngine({ ENGINE_MODE: 'tripo', TRIPO_API_KEY: 'k' });
    expect(tripo?.name).toBe('tripo');
    expect(tripo?.promptMaxLength).toBe(1024);
    expect(getEngine({})).toBeNull();
    expect(getEngine({ ENGINE_MODE: 'nonsense' })).toBeNull();
  });
});
