// 引擎抽象层(技术方案 D4 / PRD AI-10):前端与路由只面向统一协议,不感知具体引擎。
// T3 只立接口与选取逻辑;T4 提供 mock 实现(可配延迟/失败注入),T13 提供 Tripo 实现。

import type { EngineTask, GenerateRequest } from './api-types';

export interface Engine {
  readonly name: string;
  /** 提交任务;ownKey 存在时透传用户自带 key(服务层不落盘,D6 ④)。 */
  submit(req: GenerateRequest, ownKey?: string): Promise<EngineTask>;
  /** 查询任务(客户端驱动轮询的代理,架构 §1)。 */
  query(taskId: string, ownKey?: string): Promise<EngineTask>;
  /** 取消任务(PRD AI-06)。 */
  cancel(taskId: string, ownKey?: string): Promise<void>;
}

export interface EngineEnv {
  ENGINE_MODE?: string; // T4:'mock' 时启用 mock 引擎
  TRIPO_API_KEY?: string; // T13:真实引擎密钥(Workers Secrets)
}

/**
 * 引擎选取:T3 恒返回 null(未接入)——/api/generate 会在扣减后立即走返还路径,
 * 使「扣减 → 返还」账务链在引擎到位前即可在生产环境验收(AI-07 的幂等返还)。
 * T4:ENGINE_MODE==='mock' → MockEngine;T13:TRIPO_API_KEY 存在 → TripoEngine。
 */
export function getEngine(_env: EngineEnv): Engine | null {
  return null;
}
