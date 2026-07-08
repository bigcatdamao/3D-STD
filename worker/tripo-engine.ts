// T13a:Tripo 真实引擎 —— 统一任务协议(技术方案 D4 / PRD AI-10)的第二个实现。
// 上游:https://api.tripo3d.ai/v2/openapi(封套 { code, data };code=0 为成功)。
// 事实核实(2026-07,依据官方 Python SDK v0.4.2 与 OpenAPI schema):
//   - 任务状态共 8 个:queued|running|success|failed|cancelled|unknown|banned|expired;
//   - 公开 API **没有取消端点** —— 原 T4 注释「真实引擎在此调上游取消」的假设不成立。
//     取消语义由路由层承接(账务返还 + 客户端停轮询);上游任务会跑完并消耗 credit,
//     该笔属产品承诺(AI-06「取消还」)与真实成本的既知差异,计入 consumed_credit 对账口径;
//   - 任务对象带 queuing_num(→ queuePosition)、create_time(epoch 秒)、consumed_credit、
//     error_code/error_msg;成功输出取 pbr_model → model → base_model 的第一个存在者。
//
// 状态映射表(8 → 协议 4;PRD AI-05 失败三分类):
//   queued     → queued(queuePosition = queuing_num)
//   running    → running(progress 透传)
//   success    → success(resultUrl 指向服务层结果代理,见下)
//   banned     → failed / moderation(内容审核拦截,出路「修改输入」)
//   failed     → failed / service(引擎侧异常,出路「稍后再试」;error_code/msg 入日志)
//   cancelled | unknown | expired → failed / timeout(接口契约:未知/过期按 timeout;出路「重试」)
//   排队/生成中超过 TRIPO_TIMEOUT_MS(默认 10 分钟,create_time 计龄)→ failed / timeout(合成)
//
// 结果代理(技术方案 D3:上游 CORS 姿态不可控,服务层代理为 AI-02 硬需求):
//   success 的 resultUrl 一律指向 /api/task/:id/result(同源)——前端 fetch 与 T10 导入管线零改动;
//   代理路由现查上游取新鲜预签名地址(预签名会过期,不落盘,T13b R2 转存演示范围外)。
//
// 任务映射(tripoId → 服务层账务键):存 QuotaDO(mapPut/mapGet),**偏离原存储分工表的 KV**。
// 论证:① 零新增绑定/零 dashboard 步骤,Git 集成一键部署链不动;② M1 量级(≤ 数百条/日)
// 远低于单 DO 吞吐;③ 服务端权威映射防「伪造 taskId 配对骗返还」——mock 把账务键编码进
// taskId 是零成本下的正当简化,真实计费下客户端可控的配对即攻击面。自带 key 任务无账务,
// 不写映射(billingIdOf → null,返还链自然短路)。
//
// 提交重试(技术方案 D4:错误码 2000 = 超并发):请求内指数退避重试(默认 2 次补发,
// 0.8s/1.6s),对用户不可见,不占用失败三分类;HTTP 5xx 同策略。其余错误码不重试即抛,
// 路由层按 AI-07 返还。@mock: 演练指令在提交前剥离(与 resultFileName 同一约定)。

import type { EngineTask, GenerateRequest } from './api-types';
import type { Engine, TaskMapStore } from './engine';

export const TRIPO_BASE = 'https://api.tripo3d.ai/v2/openapi';
export const TRIPO_PROMPT_MAX = 1024; // 上游硬限(官方文档);路由层校验取引擎上报值
const RETRYABLE_CODE = 2000; // 超并发(技术方案 D4)
const RETRY_DELAYS_MS = [800, 1600];

// ---------- 纯函数(全部可单测) ----------

/** 剥离 @mock: 演练指令(真实引擎不认识它们,混入 prompt 只会污染生成语义)。 */
export function stripDrillDirectives(prompt: string): string {
  return prompt
    .replace(/@mock:\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 上游任务对象(仅声明本适配器消费的字段)。 */
export interface TripoTaskData {
  task_id: string;
  status: string;
  progress?: number;
  create_time?: number; // epoch 秒
  queuing_num?: number;
  consumed_credit?: number;
  error_code?: number;
  error_msg?: string;
  output?: { model?: string; base_model?: string; pbr_model?: string };
}

export function isSubmitRetryable(httpStatus: number, code: number | undefined): boolean {
  return httpStatus >= 500 || code === RETRYABLE_CODE;
}

/** 成功输出的下载地址择取:pbr_model → model → base_model。 */
export function pickModelUrl(output: TripoTaskData['output']): string | null {
  return output?.pbr_model ?? output?.model ?? output?.base_model ?? null;
}

const clamp = (n: unknown, lo: number, hi: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : lo;
  return Math.min(hi, Math.max(lo, v));
};

/** 8 态 → 协议 4 态映射(含超时合成)。taskId 用于生成结果代理路径。 */
export function mapTripoTask(d: TripoTaskData, taskId: string, nowMs: number, timeoutMs: number): EngineTask {
  const base = { taskId };
  const overdue =
    typeof d.create_time === 'number' && Number.isFinite(d.create_time) && nowMs - d.create_time * 1000 > timeoutMs;

  switch (d.status) {
    case 'queued':
      if (overdue) return { ...base, status: 'failed', progress: 0, failReason: 'timeout' };
      return {
        ...base,
        status: 'queued',
        progress: 0,
        ...(typeof d.queuing_num === 'number' ? { queuePosition: d.queuing_num } : {}),
      };
    case 'running':
      if (overdue) return { ...base, status: 'failed', progress: clamp(d.progress, 0, 99), failReason: 'timeout' };
      return { ...base, status: 'running', progress: clamp(d.progress, 0, 99) };
    case 'success':
      return {
        ...base,
        status: 'success',
        progress: 100,
        resultUrl: `/api/task/${encodeURIComponent(taskId)}/result`,
      };
    case 'banned':
      return { ...base, status: 'failed', progress: clamp(d.progress, 0, 100), failReason: 'moderation' };
    case 'failed':
      return { ...base, status: 'failed', progress: clamp(d.progress, 0, 100), failReason: 'service' };
    // cancelled / unknown / expired / 未来新增值:按接口契约归 timeout(出路「重试」)
    default:
      return { ...base, status: 'failed', progress: clamp(d.progress, 0, 100), failReason: 'timeout' };
  }
}

// ---------- 引擎实现 ----------

export interface TripoEngineOpts {
  serviceKey?: string; // Workers Secret TRIPO_API_KEY;缺位时仅自带 key 可用
  modelVersion: string; // TRIPO_MODEL_VERSION(默认 v2.5-20250123 = 20 credits 档,与 CREDITS_BY_TYPE 对齐)
  timeoutMs: number; // TRIPO_TIMEOUT_MS(默认 600000)
  taskMap?: TaskMapStore; // 账务映射(路由层注入 DO 后端;测试注入内存 Map)
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>; // 测试注入,免真实等待
}

interface TripoEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

export class TripoEngine implements Engine {
  readonly name = 'tripo';
  readonly promptMaxLength = TRIPO_PROMPT_MAX;

  constructor(private readonly o: TripoEngineOpts) {}

  private key(ownKey?: string): string {
    const k = ownKey ?? this.o.serviceKey;
    if (!k) throw new Error('tripo_key_missing'); // 路由层 catch → engine_submit_failed / engine_query_failed
    return k;
  }

  private headers(ownKey?: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.key(ownKey)}` };
  }

  private get fetchImpl(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  async submit(req: GenerateRequest, serviceTaskId: string, ownKey?: string): Promise<EngineTask> {
    const prompt = stripDrillDirectives(req.prompt ?? '');
    const body = JSON.stringify({ type: 'text_to_model', prompt, model_version: this.o.modelVersion });
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${TRIPO_BASE}/task`, { method: 'POST', headers: this.headers(ownKey), body });
      let j: TripoEnvelope<{ task_id: string }> | null = null;
      try {
        j = (await res.json()) as TripoEnvelope<{ task_id: string }>;
      } catch {
        j = null;
      }
      if (res.ok && j && j.code === 0 && j.data?.task_id) {
        const tripoId = j.data.task_id;
        // 自带 key 无账务,不写映射(D6 ④ key 不落盘的同侧:其任务对服务层完全无状态)
        if (!ownKey && this.o.taskMap) await this.o.taskMap.put(tripoId, serviceTaskId);
        return { taskId: tripoId, status: 'queued', progress: 0 };
      }
      const retryable = isSubmitRetryable(res.status, j?.code);
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]); // 2000 超并发:对用户不可见的退避(D4)
        continue;
      }
      throw new Error(`tripo_submit_failed http=${res.status} code=${j?.code ?? 'n/a'}`);
    }
  }

  /** 查上游并映射;附 consumed_credit 对账日志(D4)。 */
  async query(taskId: string, ownKey?: string): Promise<EngineTask> {
    const d = await this.fetchTask(taskId, ownKey);
    if (d === null) {
      // 上游明确说「不是一个可查的任务」(4xx / 封套非 0)→ 契约:按 timeout 类失败(路由层将返还)
      return { taskId, status: 'failed', progress: 0, failReason: 'timeout' };
    }
    const task = mapTripoTask(d, taskId, (this.o.now ?? Date.now)(), this.o.timeoutMs);
    if (task.status === 'success') {
      // 成本对账:上游实耗 vs 本站计费常量(CREDITS_BY_TYPE);差异靠日志暴露(技术方案 §9 风险表)
      console.log(`[reconcile] engine=tripo task=${taskId} consumed_credit=${d.consumed_credit ?? '—'}`);
    }
    if (task.status === 'failed' && d.status === 'failed') {
      console.error(`[alert] tripo task failed task=${taskId} code=${d.error_code ?? '—'} msg=${d.error_msg ?? '—'}`);
    }
    return task;
  }

  /**
   * 取消:上游无取消端点(2026-07 核实),此处为 no-op。
   * 取消语义 = 路由层账务返还 + 客户端停轮询;上游任务将跑完并消耗 credit(对账口径内)。
   */
  async cancel(_taskId: string, _ownKey?: string): Promise<void> {
    /* no upstream cancel API */
  }

  async billingIdOf(taskId: string): Promise<string | null> {
    if (!this.o.taskMap) return null;
    return this.o.taskMap.get(taskId);
  }

  /** 结果代理数据源:现查上游取新鲜预签名地址(预签名过期语义由上游持有)。 */
  async resultAsset(taskId: string, ownKey?: string): Promise<{ url: string } | null> {
    const d = await this.fetchTask(taskId, ownKey);
    if (d === null || d.status !== 'success') return null;
    const url = pickModelUrl(d.output);
    return url ? { url } : null;
  }

  /** GET /task/:id。返回 null = 上游判定「非可查任务」;网络异常/5xx/鉴权失败则抛(交路由层 502)。 */
  private async fetchTask(taskId: string, ownKey?: string): Promise<TripoTaskData | null> {
    const res = await this.fetchImpl(`${TRIPO_BASE}/task/${encodeURIComponent(taskId)}`, {
      headers: this.headers(ownKey),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`tripo_auth_failed http=${res.status}`);
    if (res.status >= 500) throw new Error(`tripo_upstream_5xx http=${res.status}`); // 瞬时故障:不合成失败,客户端续轮询
    let j: TripoEnvelope<TripoTaskData> | null = null;
    try {
      j = (await res.json()) as TripoEnvelope<TripoTaskData>;
    } catch {
      j = null;
    }
    if (!res.ok || !j || j.code !== 0 || !j.data) return null;
    return j.data;
  }
}
