// 引擎抽象层(技术方案 D4 / PRD AI-10):前端与路由只面向统一协议,不感知具体引擎。
// T3 立接口;T4 定稿接口并接入 mock 实现(可配延迟/失败注入);T13a 增 Tripo 真实实现。
//
// 接口定稿说明(v1.3):
// - submit 接收路由层生成的 serviceTaskId(账务键)。扣减先于提交(PRD AI-07 成本归因次序),
//   账务键必然先于引擎侧 taskId 存在;引擎负责维护两者映射 —— mock 内嵌进 taskId(零存储),
//   Tripo(T13)经 KV(存储分工表既定)。
// - billingIdOf:由引擎侧 taskId 还原账务键,失败/取消返还(AI-05/07)靠它闭环。
// - cancel:释放引擎侧资源(mock 无资源为 no-op);账务返还统一由路由层执行,
//   保证「返还」只有一个执行点、一套幂等语义(quota-core 的 ledger)。

import type { EngineTask, GenerateRequest } from './api-types';
import { MockEngine } from './mock-engine';
import { TripoEngine } from './tripo-engine';

export interface Engine {
  readonly name: string;
  /** 引擎侧 prompt 上限(字符);缺省 = 路由层默认 2000。Tripo 上游硬限 1024(T13a)。 */
  readonly promptMaxLength?: number;
  /** 提交任务;serviceTaskId = 路由层账务键;ownKey 存在时透传用户自带 key(服务层不落盘,D6 ④)。 */
  submit(req: GenerateRequest, serviceTaskId: string, ownKey?: string): Promise<EngineTask>;
  /** 查询任务(客户端驱动轮询的代理,架构 §1)。未知/过期任务按 timeout 类失败返回(§4 失败语义)。 */
  query(taskId: string, ownKey?: string): Promise<EngineTask>;
  /** 取消任务(PRD AI-06)。只管引擎侧资源;账务返还由路由层做。 */
  cancel(taskId: string, ownKey?: string): Promise<void>;
  /** 引擎侧 taskId → 服务层账务键;无法识别(垃圾 id / 非本引擎)返回 null。 */
  billingIdOf(taskId: string): Promise<string | null>;
  /**
   * 结果代理数据源(T13a,可选):返回可直接抓取的上游模型地址。
   * 服务层结果代理路由 /api/task/:id/result 靠它落地技术方案 D3 的 AI-02 硬需求
   * (上游 CORS 姿态不可控,一律经服务层代理;mock 结果本就同源,无需实现)。
   */
  resultAsset?(taskId: string, ownKey?: string): Promise<{ url: string } | null>;
}

/**
 * 任务映射存储(T13a):引擎侧 taskId → 服务层账务键。
 * 实现在路由层(QuotaDO 后端,mapPut/mapGet);测试注入内存 Map。
 * 存 DO 而非 KV 的论证见 tripo-engine.ts 头注释(零新增绑定 + 防伪造返还)。
 */
export interface TaskMapStore {
  put(engineId: string, billingId: string): Promise<void>;
  get(engineId: string): Promise<string | null>;
}

export interface EngineEnv {
  ENGINE_MODE?: string; // 'mock' 启用 mock 引擎(wrangler.jsonc vars,T4 起默认开)
  TRIPO_API_KEY?: string; // T13a:真实引擎密钥(Workers Secrets;自带 key 通道不依赖它)
  TRIPO_MODEL_VERSION?: string; // T13a:默认 v2.5-20250123(20 credits 档,与 CREDITS_BY_TYPE 对齐)
  TRIPO_TIMEOUT_MS?: string; // T13a:排队+生成的超时合成阈值,默认 600000(10 分钟)
  MOCK_QUEUE_MS?: string; // mock 默认排队时长(dashboard 可覆盖)
  MOCK_RUN_MS?: string; // mock 默认生成时长
  MOCK_FAIL_RATE?: string; // mock 随机失败率 0–1(演示混沌注入;prompt 指令优先)
}

const numOr = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export interface EngineOpts {
  now?: () => number;
  fetchImpl?: typeof fetch; // Tripo 上游,可注入(测试)
  taskMap?: TaskMapStore; // 账务映射后端(路由层注入 DO;自带 key 任务不写)
}

/**
 * 引擎选取(显式配置驱动,T13a 定稿):
 *   ENGINE_MODE==='mock'  → MockEngine(演示/降级通道,@mock 指令可用);
 *   ENGINE_MODE==='tripo' → TripoEngine(TRIPO_API_KEY 缺位时仅自带 key 请求可用,
 *                            服务 key 请求在提交处抛错 → 路由层按 AI-07 返还);
 *   其余/置空 → null,/api/generate 走「扣减 → 立即返还」的 T3 账务验收路径。
 * 显式 mode 优先于「key 存在即切换」:配置意图可读,回退 mock 只改一个 var。
 */
export function getEngine(env: EngineEnv, opts: EngineOpts = {}): Engine | null {
  if (env.ENGINE_MODE === 'mock') {
    return new MockEngine({
      queueMs: numOr(env.MOCK_QUEUE_MS, 4000),
      runMs: numOr(env.MOCK_RUN_MS, 10000),
      failRate: numOr(env.MOCK_FAIL_RATE, 0),
      now: opts.now,
    });
  }
  if (env.ENGINE_MODE === 'tripo') {
    return new TripoEngine({
      serviceKey: env.TRIPO_API_KEY,
      modelVersion: env.TRIPO_MODEL_VERSION || 'v2.5-20250123',
      timeoutMs: numOr(env.TRIPO_TIMEOUT_MS, 600000),
      taskMap: opts.taskMap,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    });
  }
  return null;
}
