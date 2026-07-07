// HistoryManager —— PRD C1 / HIST-01/02/03/06 的实现。
// Command 模式:每条记录持有 apply/revert 闭包(内部为受影响节点的 before/after 快照),不做场景全量快照。

import type { OpKind } from './history-labels.js';

export interface HistoryEntry {
  label: string; // 显示文案:基础词取自 HIST-07 命名表(history-labels),调用点追加上下文
  op: OpKind; // HIST-07 操作类型:历史面板据此取图标与归类
  targetIds: string[];
  targetNames: string[]; // 入栈时刻的目标名快照:删除类操作撤销前节点已不在文档,面板无法活查(HIST-04 目标名列)
  apply: () => void;
  revert: () => void;
  selectionBefore: string[]; // HIST-06:撤销恢复操作前选中态
  selectionAfter: string[];
  mergeKey?: string; // C1 合并入栈:同 key 且窗口内合并
  at: number;
}

export interface HistoryOptions {
  cap?: number; // HIST-01 默认 50,可配置(PRD §9 待校准)
  mergeWindowMs?: number; // C1 默认 800ms
  now?: () => number; // 测试可注入时钟
}

export class HistoryManager {
  private entries: HistoryEntry[] = [];
  private cursor = 0; // 指向「下一个 redo 位置」;已应用条目数
  private frozen = false; // 预览态冻结(HIST 边界 1)
  private overflowed = false; // 栈满丢弃发生过 →「更早的记录已合并」占位(HIST 边界 5)
  readonly cap: number;
  readonly mergeWindowMs: number;
  private readonly now: () => number;
  private applySelection: (ids: string[]) => void = () => {};

  constructor(opts: HistoryOptions = {}) {
    this.cap = opts.cap ?? 50;
    this.mergeWindowMs = opts.mergeWindowMs ?? 800;
    this.now = opts.now ?? Date.now;
  }

  bindSelection(fn: (ids: string[]) => void) {
    this.applySelection = fn;
  }

  setFrozen(v: boolean) {
    this.frozen = v;
  }
  get isFrozen() {
    return this.frozen;
  }
  get hasOverflowed() {
    return this.overflowed;
  }

  get length() {
    return this.entries.length;
  }
  get position() {
    return this.cursor;
  }
  get canUndo() {
    return !this.frozen && this.cursor > 0;
  }
  get canRedo() {
    return !this.frozen && this.cursor < this.entries.length;
  }
  list(): ReadonlyArray<Pick<HistoryEntry, 'label' | 'op' | 'targetIds' | 'targetNames' | 'at'>> {
    return this.entries.map(({ label, op, targetIds, targetNames, at }) => ({
      label,
      op,
      targetIds,
      targetNames,
      at,
    }));
  }

  /** 入栈。条目在此前必须已被执行(commit 流程负责)。 */
  push(entry: Omit<HistoryEntry, 'at'>) {
    if (this.frozen) throw new Error('预览态下历史栈冻结,不接受新操作(HIST 边界 1)');
    const at = this.now();
    // redo 分支静默截断(HIST-01)
    this.entries.length = this.cursor;

    // C1 合并入栈:同 mergeKey 且在窗口内 → 折叠为一条(保留最早的 before/selectionBefore,替换 after 侧)
    const top = this.entries[this.entries.length - 1];
    if (
      entry.mergeKey &&
      top &&
      top.mergeKey === entry.mergeKey &&
      at - top.at <= this.mergeWindowMs
    ) {
      top.apply = entry.apply;
      top.selectionAfter = entry.selectionAfter;
      top.label = entry.label;
      top.op = entry.op;
      top.targetNames = entry.targetNames;
      top.at = at;
      // revert 保持 top 原有(回到最早 before);cursor 不变
      return;
    }

    this.entries.push({ ...entry, at });
    this.cursor = this.entries.length;

    if (this.entries.length > this.cap) {
      this.entries.shift(); // 满丢最老,不提示(HIST 边界 5)
      this.cursor -= 1;
      this.overflowed = true;
    }
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const e = this.entries[this.cursor - 1];
    e.revert();
    this.applySelection(e.selectionBefore); // HIST-06
    this.cursor -= 1;
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const e = this.entries[this.cursor];
    e.apply();
    this.applySelection(e.selectionAfter);
    this.cursor += 1;
    return true;
  }

  /** HIST-04:点击历史面板任意条目跳转 = 批量撤销/重做 */
  jumpTo(position: number) {
    if (this.frozen) return;
    const target = Math.max(0, Math.min(position, this.entries.length));
    while (this.cursor > target) this.undo();
    while (this.cursor < target) this.redo();
  }
}
