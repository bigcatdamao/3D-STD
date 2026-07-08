// 引擎抽象层(技术方案 D4 / PRD AI-10):前端与路由只面向统一协议,不感知具体引擎。
// T3 立接口;T4 定稿接口并接入 mock 实现(可配延迟/失败注入);T13 增 Tripo 实现。
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

export interface Engine {
  readonly name: string;
  /** 提交任务;serviceTaskId = 路由层账务键;ownKey 存在时透传用户自带 key(服务层不落盘,D6 ④)。 */
  submit(req: GenerateRequest, serviceTaskId: string, ownKey?: string): Promise<EngineTask>;
  /** 查询任务(客户端驱动轮询的代理,架构 §1)。未知/过期任务按 timeout 类失败返回(§4 失败语义)。 */
  query(taskId: string, ownKey?: string): Promise<EngineTask>;
  /** 取消任务(PRD AI-06)。只管引擎侧资源;账务返还由路由层做。 */
  cancel(taskId: string, ownKey?: string): Promise<void>;
  /** 引擎侧 taskId → 服务层账务键;无法识别(垃圾 id / 非本引擎)返回 null。 */
  billingIdOf(taskId: string): Promise<string | null>;
}

export interface EngineEnv {
  ENGINE_MODE?: string; // 'mock' 启用 mock 引擎(wrangler.jsonc vars,T4 起默认开)
  TRIPO_API_KEY?: string; // T13:真实引擎密钥(Workers Secrets)
  MOCK_QUEUE_MS?: string; // mock 默认排队时长(dashboard 可覆盖)
  MOCK_RUN_MS?: string; // mock 默认生成时长
  MOCK_FAIL_RATE?: string; // mock 随机失败率 0–1(演示混沌注入;prompt 指令优先)
}

const numOr = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * 引擎选取。T4:ENGINE_MODE==='mock' → MockEngine;
 * T13:TRIPO_API_KEY 存在且 ENGINE_MODE!=='mock' → TripoEngine(mock 保留为演示/降级通道);
 * 都没有 → null,/api/generate 走「扣减 → 立即返还」的 T3 账务验收路径。
 */
export function getEngine(env: EngineEnv, now?: () => number): Engine | null {
  if (env.ENGINE_MODE === 'mock') {
    return new MockEngine({
      queueMs: numOr(env.MOCK_QUEUE_MS, 4000),
      runMs: numOr(env.MOCK_RUN_MS, 10000),
      failRate: numOr(env.MOCK_FAIL_RATE, 0),
      now,
    });
  }
  return null;
}
