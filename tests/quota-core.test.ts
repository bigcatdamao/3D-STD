// T3:配额账务内核单测——PRD AI-07(提交扣、失败还、返还幂等)与 D6 ②③(强一致计数 + 熔断)的口径对账。
import { describe, expect, it } from 'vitest';
import { dayOf, deduct, emptyState, refund, status, type QuotaState } from '../worker/quota-core';

const NOW = Date.parse('2026-07-07T10:00:00Z');
const base = (): QuotaState => emptyState(dayOf(NOW));
const args = (over: Partial<Parameters<typeof deduct>[1]> = {}) => ({
  visitorKey: 'v1',
  taskId: 'task-1',
  credits: 20,
  limitTimes: 3,
  breakerLimitCredits: 3000,
  now: NOW,
  ...over,
});

describe('quota-core · 扣减', () => {
  it('正常扣减:次数 +1、熔断 credits 累加、账目 charged', () => {
    const { state, result } = deduct(base(), args());
    expect(result).toMatchObject({ ok: true, remaining: 2, breakerOpen: false });
    expect(state.usedTimes.v1).toBe(1);
    expect(state.breakerCredits).toBe(20);
    expect(state.ledger['task-1'].state).toBe('charged');
  });

  it('达到日上限后拒绝:quota_exhausted,不动账', () => {
    let s = base();
    for (let i = 0; i < 3; i++) s = deduct(s, args({ taskId: `t${i}` })).state;
    const { state, result } = deduct(s, args({ taskId: 't3' }));
    expect(result).toMatchObject({ ok: false, error: 'quota_exhausted', remaining: 0 });
    expect(state.usedTimes.v1).toBe(3);
    expect(state.ledger.t3).toBeUndefined();
  });

  it('同 taskId 重复扣减幂等:不二次记账', () => {
    let s = deduct(base(), args()).state;
    const { state, result } = deduct(s, args());
    expect(result.ok).toBe(true);
    expect(state.usedTimes.v1).toBe(1);
    expect(state.breakerCredits).toBe(20);
  });

  it('多访客计数隔离', () => {
    let s = deduct(base(), args()).state;
    s = deduct(s, args({ visitorKey: 'v2', taskId: 't-v2' })).state;
    expect(s.usedTimes.v1).toBe(1);
    expect(s.usedTimes.v2).toBe(1);
  });

  it('演示码提升的上限由调用方传入(limitTimes=20)', () => {
    let s = base();
    for (let i = 0; i < 5; i++) {
      const r = deduct(s, args({ taskId: `d${i}`, limitTimes: 20, demoCode: 'hire-me' }));
      expect(r.result.ok).toBe(true);
      s = r.state;
    }
    expect(s.usedTimes.v1).toBe(5);
    expect(s.ledger.d0.demoCode).toBe('hire-me');
  });
});

describe('quota-core · 返还(AI-07)', () => {
  it('返还:次数回退、熔断 credits 回退、账目转 refunded', () => {
    const s1 = deduct(base(), args()).state;
    const { state, result } = refund(s1, 'task-1', NOW);
    expect(result).toEqual({ ok: true, refunded: true });
    expect(state.usedTimes.v1).toBe(0);
    expect(state.breakerCredits).toBe(0);
    expect(state.ledger['task-1'].state).toBe('refunded');
  });

  it('重复返还幂等:第二次 refunded=false 且不再回退', () => {
    let s = deduct(base(), args()).state;
    s = refund(s, 'task-1', NOW).state;
    const { state, result } = refund(s, 'task-1', NOW);
    expect(result).toEqual({ ok: true, refunded: false });
    expect(state.usedTimes.v1).toBe(0);
    expect(state.breakerCredits).toBe(0);
  });

  it('未知 taskId 返还:视为成功但 refunded=false(跨日账本清空后的安全语义)', () => {
    const { result } = refund(base(), 'ghost', NOW);
    expect(result).toEqual({ ok: true, refunded: false });
  });

  it('返还后配额恢复,可再次扣减', () => {
    let s = base();
    for (let i = 0; i < 3; i++) s = deduct(s, args({ taskId: `t${i}` })).state;
    s = refund(s, 't1', NOW).state;
    const r = deduct(s, args({ taskId: 't-new' }));
    expect(r.result.ok).toBe(true);
  });
});

describe('quota-core · 熔断(D6 ③)', () => {
  it('全局预算不足时拒绝:budget_exhausted,个人余量无关', () => {
    const { result } = deduct(base(), args({ breakerLimitCredits: 10 }));
    expect(result).toMatchObject({ ok: false, error: 'budget_exhausted', breakerOpen: true });
  });

  it('熔断先于个人配额判定(个人已满但报 budget)', () => {
    let s = base();
    s = deduct(s, args({ taskId: 'a', breakerLimitCredits: 40 })).state; // 20
    s = deduct(s, args({ taskId: 'b', breakerLimitCredits: 40 })).state; // 40
    const r = deduct(s, args({ taskId: 'c', breakerLimitCredits: 40 }));
    expect(r.result.error).toBe('budget_exhausted');
  });

  it('返还释放熔断额度', () => {
    let s = deduct(base(), args({ taskId: 'a', breakerLimitCredits: 20 })).state;
    expect(deduct(s, args({ visitorKey: 'v2', taskId: 'b', breakerLimitCredits: 20 })).result.error).toBe('budget_exhausted');
    s = refund(s, 'a', NOW).state;
    expect(deduct(s, args({ visitorKey: 'v2', taskId: 'b', breakerLimitCredits: 20 })).result.ok).toBe(true);
  });

  it('status 报告 breakerOpen', () => {
    const s = deduct(base(), args({ credits: 3000 , limitTimes: 5, breakerLimitCredits: 3000 })).state;
    const { result } = status(s, 'v1', 5, 3000, NOW);
    expect(result.breakerOpen).toBe(true);
    expect(result.breakerCredits).toBe(3000);
  });
});

describe('quota-core · 日界翻转(UTC)', () => {
  it('跨日后计数与账本整体清零', () => {
    let s = base();
    for (let i = 0; i < 3; i++) s = deduct(s, args({ taskId: `t${i}` })).state;
    const tomorrow = NOW + 24 * 3600 * 1000;
    const { result } = status(s, 'v1', 3, 3000, tomorrow);
    expect(result.used).toBe(0);
    expect(result.remaining).toBe(3);
    expect(result.day).toBe(dayOf(tomorrow));
    // 昨日账目跨日返还落空但幂等安全
    const r = refund(s, 't0', tomorrow);
    expect(r.result).toEqual({ ok: true, refunded: false });
  });

  it('同日多次操作不翻转', () => {
    let s = deduct(base(), args()).state;
    const later = NOW + 3600 * 1000;
    const { result } = status(s, 'v1', 3, 3000, later);
    expect(result.used).toBe(1);
  });
});
