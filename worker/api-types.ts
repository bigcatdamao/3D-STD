// T3 服务层 · API 封套约定(前后端共用,worker 与 src 同仓引用)。
// 错误分类(class)与 PRD AI-05 的失败三分类对齐,并补服务层自身的三类:
//   validation      输入不合法(不消耗配额,PRD AI-01 服务侧镜像)
//   turnstile       人机验证未过/未配置(D6 ①)
//   quota           访客配额耗尽 / 全局熔断(PRD AI-07/AI-11、D6 ②③)
//   service         服务侧异常(引擎未接入、上游故障)——按 AI-07 成本归因,已扣配额一律返还
//   not_implemented 路由已立、能力随后续任务接线(T4 mock 引擎 / T12 前端 / T13 Tripo)

export type ApiErrorClass = 'validation' | 'turnstile' | 'quota' | 'service' | 'not_implemented';

export interface ApiError {
  ok: false;
  error: string; // 机器可读码,如 quota_exhausted / turnstile_failed / engine_unavailable
  class: ApiErrorClass;
  message: string; // 人类可读(中文),前端可直接展示
  refunded?: boolean; // 若本次请求曾扣减配额,是否已返还(AI-07)
  taskId?: string;
  codes?: string[]; // turnstile 上游 error-codes 透传(诊断用)
}

export interface HealthResponse {
  ok: true;
  service: string;
  at: string;
  config: {
    turnstile: boolean; // TURNSTILE_SECRET_KEY 是否已配置
    engine: boolean; // 生成引擎是否接入(T3 恒 false,T4 mock / T13 Tripo 后为 true)
    demoCodes: number; // 已配置演示码数量(不泄露码本身)
  };
}

export interface QuotaResponse {
  ok: true;
  day: string; // UTC 日界(配额按日翻转)
  visitor: { used: number; limit: number; remaining: number };
  breaker: { usedCredits: number; limitCredits: number; open: boolean };
  demo: 'none' | 'active' | 'invalid'; // 演示码状态(invalid = 未配置或已撤销)
}

export interface GenerateRequest {
  type: 'text' | 'image';
  prompt?: string;
  turnstileToken?: string;
}

// 引擎抽象层的统一任务协议(技术方案 D4)。T3 只定型,T4 才有实现。
export type EngineTaskStatus = 'queued' | 'running' | 'success' | 'failed';
export type EngineFailReason = 'timeout' | 'moderation' | 'service';

export interface EngineTask {
  taskId: string;
  status: EngineTaskStatus;
  progress: number; // 0–100
  resultUrl?: string;
  failReason?: EngineFailReason;
}

// Tripo credit 价(技术方案 D2,核实于 2026-07):文生 $0.20 = 20 credits,图生带纹理 $0.30 = 30 credits。
export const CREDITS_BY_TYPE: Record<GenerateRequest['type'], number> = { text: 20, image: 30 };
