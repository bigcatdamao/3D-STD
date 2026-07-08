// T3 配额 Durable Object:quota-core 的持久化薄封装。
// 单一全局实例(路由层 idFromName('global'))承载全部访客计数 + 账本 + 熔断——
// 单实例串行化让「个人配额 + 全局预算」两笔账天然原子;M1 量级(≤ 数百次/日)远低于单 DO 吞吐。
// 存储后端用 SQLite 类(wrangler.jsonc 的 new_sqlite_classes),免费档可用。
// 类型说明:为避免给整个工程引入 @cloudflare/workers-types(与 DOM lib 冲突),此处手声最小接口。

import type { DeductArgs } from './quota-core';
import { dayOf, deduct, emptyState, refund, status, type QuotaState } from './quota-core';

interface DurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface DurableState {
  storage: DurableStorage;
}

export type QuotaOp =
  | ({ op: 'deduct' } & Omit<DeductArgs, 'now'>)
  | { op: 'refund'; taskId: string }
  | { op: 'status'; visitorKey: string; limitTimes: number; breakerLimitCredits: number };

const STATE_KEY = 'state';

export class QuotaDO {
  constructor(private readonly state: DurableState, _env?: unknown) {}

  async fetch(req: Request): Promise<Response> {
    let op: QuotaOp;
    try {
      op = (await req.json()) as QuotaOp;
    } catch {
      return Response.json({ ok: false, error: 'bad_op' }, { status: 400 });
    }
    const now = Date.now();
    const prev = (await this.state.storage.get<QuotaState>(STATE_KEY)) ?? emptyState(dayOf(now));

    if (op.op === 'deduct') {
      const { state, result } = deduct(prev, { ...op, now });
      await this.state.storage.put(STATE_KEY, state);
      return Response.json(result);
    }
    if (op.op === 'refund') {
      const { state, result } = refund(prev, op.taskId, now);
      await this.state.storage.put(STATE_KEY, state);
      return Response.json(result);
    }
    if (op.op === 'status') {
      const { state, result } = status(prev, op.visitorKey, op.limitTimes, op.breakerLimitCredits, now);
      await this.state.storage.put(STATE_KEY, state);
      return Response.json(result);
    }
    return Response.json({ ok: false, error: 'unknown_op' }, { status: 400 });
  }
}
