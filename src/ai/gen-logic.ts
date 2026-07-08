// T12 · AI 生成前端纯逻辑(不含 React / fetch / DOM,全部可单测)。
// 覆盖:AI-01 前端即时校验(失败不消耗配额:根本不发请求)、AI-03 状态机、
//       AI-04 轮询分频(排队 5s / 生成 2s)、AI-05 三分类三出路(文案权威源在 worker/api-types)、
//       AI-08 调整回填的完整上下文、AI 边界 1 刷新恢复(活动任务票据)。
// 服务端协议见 worker/api-types.ts(D4 统一任务协议)——本文件只消费,不复制定义。

import type { EngineFailReason, EngineTask, GenerateResponse } from '../../worker/api-types';
import { FAIL_REASON_COPY } from '../../worker/api-types';

// ---------- 上下文(AI-08:调整 = 完整回填,仅改差异) ----------

export interface GenContext {
  type: 'text' | 'image';
  prompt: string;
  // options 槽位:M1 文生无附加参数;图生参数随 T13 引擎通道一并落位(协议已留 options)。
}

// ---------- 状态机(AI-03) ----------

export type GenPhase =
  | 'idle' // 输入中(含校验失败提示、配额拦截提示)
  | 'submitting' // 已发 /api/generate,未得 taskId(不可取消:尚无可取消对象)
  | 'queued' // 排队(位置反馈,5s 轮询,可取消)
  | 'running' // 生成中(进度,2s 轮询,可取消)
  | 'success' // 预览确认:接受 / 调整 / 丢弃
  | 'failed' // 三分类三出路
  | 'canceled'; // 用户取消(配额已返还,AI-07)

export interface GenState {
  phase: GenPhase;
  context: GenContext;
  taskId?: string;
  engine?: string; // 诊断展示用;逻辑不得依赖具体引擎(AI-10)
  progress: number; // 0–100
  queuePosition?: number;
  resultUrl?: string;
  failReason?: EngineFailReason;
  refunded?: boolean; // 取消/失败路径上服务层报告的返还标记(权威判断仍看配额复查)
  notice?: string; // idle 态的一次性提示(提交失败原因、丢弃说明等)
  startedAt?: number;
}

export const emptyContext = (): GenContext => ({ type: 'text', prompt: '' });

export const idleState = (context: GenContext = emptyContext(), notice?: string): GenState => ({
  phase: 'idle',
  context,
  progress: 0,
  ...(notice ? { notice } : {}),
});

// ---------- 前端即时校验(AI-01,失败不发请求 = 不消耗配额) ----------

export const PROMPT_MAX_CHARS = 2000; // 与服务侧上限一致(worker/router.ts)

export type Validation = { ok: true } | { ok: false; code: string; message: string };

export function validateText(prompt: string): Validation {
  const p = prompt.trim();
  if (!p) return { ok: false, code: 'empty_prompt', message: '请输入描述后再提交。' };
  if (p.length > PROMPT_MAX_CHARS) {
    return { ok: false, code: 'prompt_too_long', message: `描述超长(${p.length}/${PROMPT_MAX_CHARS} 字符)。` };
  }
  return { ok: true };
}

// 图生入口的格式/大小校验(AI-01)。引擎通道随 T13 接线,校验规则先行入档并受测,
// 届时 UI 只需解禁入口——规则与文案零改动。
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp'] as const;

export function validateImageFile(name: string, sizeBytes: number): Validation {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (!(IMAGE_FORMATS as readonly string[]).includes(ext)) {
    return { ok: false, code: 'bad_image_format', message: `仅支持 ${IMAGE_FORMATS.join('/')} 图片。` };
  }
  if (sizeBytes > IMAGE_MAX_BYTES) {
    return { ok: false, code: 'image_too_large', message: '图片超过 10MB 上限。' };
  }
  return { ok: true };
}

// ---------- 轮询分频(AI-04) ----------

export function pollDelayOf(phase: 'queued' | 'running'): number {
  return phase === 'queued' ? 5000 : 2000;
}

// ---------- 状态迁移 ----------

/** /api/generate 成功响应 → 进入任务生命周期(mock 提交瞬间即可能已是 running) */
export function onSubmitted(context: GenContext, resp: GenerateResponse, now: number): GenState {
  const base: GenState = {
    phase: resp.task.status === 'running' ? 'running' : 'queued',
    context,
    taskId: resp.task.taskId,
    engine: resp.engine,
    progress: resp.task.progress ?? 0,
    queuePosition: resp.task.queuePosition,
    startedAt: now,
  };
  return applyTask(base, resp.task);
}

/** 轮询结果合并。终态(success/failed)一次到位;queued↔running 只刷新进度与位置。 */
export function applyTask(state: GenState, task: EngineTask, refunded?: boolean): GenState {
  if (task.status === 'success') {
    return { ...state, phase: 'success', progress: 100, resultUrl: task.resultUrl, queuePosition: undefined };
  }
  if (task.status === 'failed') {
    const failReason: EngineFailReason = task.failReason ?? 'timeout'; // 未知/过期按 timeout(技术方案 §4)
    return { ...state, phase: 'failed', failReason, refunded, queuePosition: undefined };
  }
  return {
    ...state,
    phase: task.status, // 'queued' | 'running'
    progress: task.progress ?? state.progress,
    queuePosition: task.queuePosition,
  };
}

/** 失败出路(AI-05)。文案与分类的权威源是 FAIL_REASON_COPY,此处只补前端动作语义。 */
export type FailAction = 'retry' | 'edit' | 'dismiss';

/**
 * 输入区锁定规则:仅「任务在途」(submitting/queued/running)与「预览确认」(success)锁定——
 * 前者防止输入与在途任务的上下文脱钩(AI-08 完整上下文以任务为锚),
 * 后者要求对结果做显式三选(接受/调整/丢弃,涉及配额归因,不允许静默略过)。
 * failed / canceled 不锁:直接编辑即回到输入态,出路按钮之外始终留着「改字重来」这条路
 * (否则 timeout 失败只有「重试」一个出口,想改 prompt 会被锁死)。
 */
export function inputLockedIn(phase: GenPhase): boolean {
  return phase === 'submitting' || phase === 'queued' || phase === 'running' || phase === 'success';
}

export function outletOf(reason: EngineFailReason): { label: string; outlet: string; message: string; action: FailAction } {
  const copy = FAIL_REASON_COPY[reason];
  const action: FailAction = reason === 'timeout' ? 'retry' : reason === 'moderation' ? 'edit' : 'dismiss';
  return { ...copy, action };
}

// ---------- 刷新恢复票据(AI 边界 1) ----------
// 活动任务(queued/running)持久化 {taskId, context, startedAt};装载时若存在即恢复轮询。
// 服务端 mock 引擎为无状态时间表(技术方案 v1.3 ②),未知/过期任务稳定落 failed/timeout 并返还,
// 因此恢复不需要本地兜底超时——直接问服务端即可得到正确终态。

export const ACTIVE_TASK_KEY = '3dstd:ai-active-task';

export interface ActiveTicket {
  taskId: string;
  context: GenContext;
  startedAt: number;
}

/** 仅活动态可序列化;终态与 idle 返回 null(调用方据此清票据)。 */
export function serializeActive(state: GenState): string | null {
  if ((state.phase !== 'queued' && state.phase !== 'running') || !state.taskId) return null;
  const t: ActiveTicket = { taskId: state.taskId, context: state.context, startedAt: state.startedAt ?? 0 };
  return JSON.stringify(t);
}

export function parseActiveTicket(raw: string | null): ActiveTicket | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<ActiveTicket>;
    if (typeof j.taskId !== 'string' || !j.taskId) return null;
    const c = j.context as Partial<GenContext> | undefined;
    if (!c || (c.type !== 'text' && c.type !== 'image') || typeof c.prompt !== 'string') return null;
    return { taskId: j.taskId, context: { type: c.type, prompt: c.prompt }, startedAt: Number(j.startedAt) || 0 };
  } catch {
    return null;
  }
}

/** 票据 → 恢复态:先以 queued/0% 呈现,首个轮询结果立刻校正(含直接落终态)。 */
export function resumeState(ticket: ActiveTicket): GenState {
  return {
    phase: 'queued',
    context: ticket.context,
    taskId: ticket.taskId,
    progress: 0,
    startedAt: ticket.startedAt,
  };
}

// ---------- 结果文件名(接受 → 走 T10 导入管线;完整 AI-09 落入链随 T16) ----------

export function resultFileName(prompt: string): string {
  const slug = prompt
    .replace(/@mock:\S+/g, '') // 演练注入指令不进对象名(真实引擎 prompt 无此段,零影响)
    .trim()
    .slice(0, 40)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'ai-model'}.glb`;
}
