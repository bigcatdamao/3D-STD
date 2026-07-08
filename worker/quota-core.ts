// T3 配额账务内核(纯函数,无 I/O)。
// 设计约定:
// - 状态整体为一个 JSON 值,由唯一的全局 Durable Object 串行读写(输入门保证操作原子,技术方案 D6 ②)。
//   KV 无原子读改写、并发下会配额双花,不得用于计数——熔断计数也因此收进本 DO(见技术方案 v1.2 变更记录)。
// - 访客配额按「次」计(PRD AI-11:3 次/日);全局熔断按「credits」计(技术方案 §6:预算保护)。
// - 账务记录 {visitorKey, credits, state} 以 taskId 为键(PRD AI-07 的映射);返还幂等:重复返还无副作用。
// - 日界:UTC 自然日。跨日整体翻转(计数与当日账本一并清零);返还只在任务生命周期内发生(分钟级),
//   跨日返还落空视为可接受损耗,幂等语义不破坏。

export interface LedgerEntry {
  visitorKey: string;
  credits: number;
  state: 'charged' | 'refunded';
  at: number; // epoch ms
  demoCode?: string;
}

export interface QuotaState {
  day: string; // YYYY-MM-DD(UTC)
  usedTimes: Record<string, number>; // visitorKey → 当日已用次数
  breakerCredits: number; // 当日全局已消耗 credits
  ledger: Record<string, LedgerEntry>; // taskId → 账目
}

export const dayOf = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export const emptyState = (day: string): QuotaState => ({
  day,
  usedTimes: {},
  breakerCredits: 0,
  ledger: {},
});

/** 跨日翻转:日期不符则整体重置(计数按日翻转,技术方案 §5)。 */
export const rollover = (s: QuotaState, nowMs: number): QuotaState => {
  const day = dayOf(nowMs);
  return s.day === day ? s : emptyState(day);
};

export interface DeductArgs {
  visitorKey: string;
  taskId: string;
  credits: number;
  limitTimes: number; // 该访客的当日上限(普通 3;演示码提升,由路由层裁决后传入)
  breakerLimitCredits: number;
  demoCode?: string;
  now: number;
}

export interface DeductResult {
  ok: boolean;
  error?: 'quota_exhausted' | 'budget_exhausted';
  remaining: number; // 扣减后剩余次数(失败时为当前剩余)
  breakerOpen: boolean;
}

export function deduct(prev: QuotaState, a: DeductArgs): { state: QuotaState; result: DeductResult } {
  const s = rollover(prev, a.now);
  const used = s.usedTimes[a.visitorKey] ?? 0;
  const breakerOpen = s.breakerCredits >= a.breakerLimitCredits;

  // 幂等:同 taskId 重复扣减不二次记账(网络重试防护)。
  const existing = s.ledger[a.taskId];
  if (existing && existing.state === 'charged') {
    return { state: s, result: { ok: true, remaining: Math.max(0, a.limitTimes - used), breakerOpen } };
  }

  // 熔断先于个人配额:全站预算耗尽时,个人还有余量也拦(D6 ③ 降级为「今日额度已用完 + 自带 key」)。
  if (s.breakerCredits + a.credits > a.breakerLimitCredits) {
    return {
      state: s,
      result: { ok: false, error: 'budget_exhausted', remaining: Math.max(0, a.limitTimes - used), breakerOpen: true },
    };
  }
  if (used + 1 > a.limitTimes) {
    return { state: s, result: { ok: false, error: 'quota_exhausted', remaining: 0, breakerOpen } };
  }

  const next: QuotaState = {
    ...s,
    usedTimes: { ...s.usedTimes, [a.visitorKey]: used + 1 },
    breakerCredits: s.breakerCredits + a.credits,
    ledger: {
      ...s.ledger,
      [a.taskId]: { visitorKey: a.visitorKey, credits: a.credits, state: 'charged', at: a.now, demoCode: a.demoCode },
    },
  };
  return { state: next, result: { ok: true, remaining: Math.max(0, a.limitTimes - used - 1), breakerOpen: false } };
}

export interface RefundResult {
  ok: true;
  refunded: boolean; // false = 账目不存在或已返还(幂等,均视为成功)
}

export function refund(prev: QuotaState, taskId: string, now: number): { state: QuotaState; result: RefundResult } {
  const s = rollover(prev, now);
  const e = s.ledger[taskId];
  if (!e || e.state === 'refunded') {
    return { state: s, result: { ok: true, refunded: false } };
  }
  const used = s.usedTimes[e.visitorKey] ?? 0;
  const next: QuotaState = {
    ...s,
    usedTimes: { ...s.usedTimes, [e.visitorKey]: Math.max(0, used - 1) },
    breakerCredits: Math.max(0, s.breakerCredits - e.credits),
    ledger: { ...s.ledger, [taskId]: { ...e, state: 'refunded' } },
  };
  return { state: next, result: { ok: true, refunded: true } };
}

export interface StatusResult {
  day: string;
  used: number;
  remaining: number;
  breakerCredits: number;
  breakerOpen: boolean;
}

export function status(
  prev: QuotaState,
  visitorKey: string,
  limitTimes: number,
  breakerLimitCredits: number,
  now: number,
): { state: QuotaState; result: StatusResult } {
  const s = rollover(prev, now);
  const used = s.usedTimes[visitorKey] ?? 0;
  return {
    state: s,
    result: {
      day: s.day,
      used,
      remaining: Math.max(0, limitTimes - used),
      breakerCredits: s.breakerCredits,
      breakerOpen: s.breakerCredits >= breakerLimitCredits,
    },
  };
}
