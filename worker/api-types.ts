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
    engine: boolean; // 生成引擎是否接入(T4 起 ENGINE_MODE='mock' 为 true,T13 Tripo 同)
    engineName: string | null; // 接入的引擎名('mock' / 'tripo'),未接入为 null
    promptMax: number; // 当前引擎的 prompt 字符上限(T13a-fix1:前端计数器与校验以此为准)
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

// 引擎抽象层的统一任务协议(技术方案 D4;T4 起由 mock 引擎实现,T13 换 Tripo 时前端零改动)。
export type EngineTaskStatus = 'queued' | 'running' | 'success' | 'failed';
export type EngineFailReason = 'timeout' | 'moderation' | 'service';

export interface EngineTask {
  taskId: string;
  status: EngineTaskStatus;
  progress: number; // 0–100
  resultUrl?: string;
  failReason?: EngineFailReason;
  queuePosition?: number; // 排队位置反馈(PRD AI-03;技术方案 v1.3 协议补充,引擎可选供给)
}

// AI-05 失败三分类三出路(前后端共用文案权威源;T12 状态机按 outlet 渲染出路按钮)。
// service 类不暴露账务/引擎细节,仅示「服务暂时不可用」并触发运营告警(worker 侧 console 记录,M1 简化)。
export const FAIL_REASON_COPY: Record<EngineFailReason, { label: string; outlet: string; message: string }> = {
  timeout: { label: '超时', outlet: '重试', message: '生成超时,请重试。' },
  moderation: { label: '审核未通过', outlet: '修改输入', message: '输入未通过内容审核,请修改后重新提交。' },
  service: { label: '服务异常', outlet: '稍后再试', message: '服务暂时不可用,请稍后再试。' },
};

// —— T4 起的成功响应封套 ——

export interface GenerateResponse {
  ok: true;
  engine: string; // 引擎名(诊断用;前端逻辑不得依赖具体引擎,AI-10)
  task: EngineTask;
}

export interface TaskResponse {
  ok: true;
  task: EngineTask;
  // 本次查询是否执行了失败返还(AI-05/07:三类失败均返还)。幂等:首个观察到失败的
  // 轮询为 true,后续为 false —— 客户端判断「已返还」应看配额复查而非此瞬时标记。
  refunded?: boolean;
}

export interface CancelResponse {
  ok: true;
  canceled: true;
  refunded: boolean; // 本次取消是否执行了返还(AI-07「取消还」;重复取消幂等为 false)
}

// Tripo credit 价(技术方案 D2,核实于 2026-07):文生 $0.20 = 20 credits,图生带纹理 $0.30 = 30 credits。
export const CREDITS_BY_TYPE: Record<GenerateRequest['type'], number> = { text: 20, image: 30 };
