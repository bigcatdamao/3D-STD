// 历史面板纯逻辑(HIST-04/08)—— 与 React 解耦,直接以内核查询结果为输入,单测覆盖。

import type { HistoryManager } from '../kernel/history';
import { OP_TABLE, OpKind } from '../kernel/history-labels';
import type { SceneDocument } from '../kernel/scene';

export interface HistRow {
  /** 点击跳转的目标位置:应用完本条后的 cursor 值(jumpTo 参数,1-based) */
  position: number;
  icon: string;
  label: string;
  /** 目标名摘要(入栈时刻快照,删除类撤销前也能显示,HIST-04) */
  names: string;
  namesFull: string; // tooltip 用全量
  targetIds: string[];
  op: OpKind;
  applied: boolean; // cursor 左侧(已应用)
  current: boolean; // 恰为当前位置(HIST-04 当前位置指示)
}

/** HIST-04 目标名列:1 个显示名字,2 个并列,更多折叠为「首名 等 N 项」 */
export function nameSummary(names: string[]): string {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}、${names[1]}`;
  return `${names[0]} 等 ${names.length} 项`;
}

/** 把内核历史清单派生为面板行模型;条目顺序 = 时间顺序(左旧右新) */
export function buildRows(
  entries: ReturnType<HistoryManager['list']>,
  position: number,
): HistRow[] {
  return entries.map((e, i) => ({
    position: i + 1,
    icon: OP_TABLE[e.op].icon,
    label: e.label,
    names: nameSummary(e.targetNames),
    namesFull: e.targetNames.join('、'),
    targetIds: e.targetIds,
    op: e.op,
    applied: i + 1 <= position,
    current: i + 1 === position,
  }));
}

/** HIST-08 hover 高亮:条目目标展开为当前文档中仍存在的实例集合。
 *  组 → 其全部后代实例;已删除/不存在的 id 静默跳过;锁定不剔除(高亮是只读呈现,
 *  与 expandToInstances 的「可变换集合」语义不同,后者服务于编辑通道)。 */
export function expandHighlightIds(doc: SceneDocument, targetIds: string[]): string[] {
  const out = new Set<string>();
  for (const id of targetIds) {
    const n = doc.nodes.get(id);
    if (!n) continue;
    if (n.kind === 'instance') {
      out.add(id);
    } else {
      for (const d of doc.descendants(id)) {
        if (doc.nodes.get(d)?.kind === 'instance') out.add(d);
      }
    }
  }
  return [...out];
}
