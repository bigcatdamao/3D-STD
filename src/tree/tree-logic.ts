// 场景树纯逻辑(T7)—— 与 React 解耦,可单测:
//   flattenVisible  树 → 行列表(折叠感知),供渲染与 Shift 范围选(TREE-03)
//   resolveDrop     指针落点 → 内核 moveNodes 参数,承担全部拖拽校验(TREE-04 + 边界 3 + TREE-01 软上限)

import { SceneDocument } from '../kernel/scene';

export const DEPTH_SOFT_CAP = 5; // TREE-01:深度软上限,超出提示不禁止

export interface FlatRow {
  id: string;
  depth: number; // 根层级 = 1
  kind: 'instance' | 'group';
  hasChildren: boolean;
  collapsed: boolean; // 仅组有意义
}

/** 树的展平(折叠的组不展开其子级)。行序即 Shift 范围选与拖拽多选的排序依据。 */
export function flattenVisible(doc: SceneDocument, collapsed: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const id of doc.childrenOf(parentId)) {
      const n = doc.nodes.get(id);
      if (!n) continue;
      const kids = n.kind === 'group' ? doc.childrenOf(id) : [];
      const isCollapsed = n.kind === 'group' && collapsed.has(id);
      out.push({ id, depth, kind: n.kind, hasChildren: kids.length > 0, collapsed: isCollapsed });
      if (n.kind === 'group' && !isCollapsed) walk(id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/** 全量展平顺序(无视折叠),用于把点击顺序的多选归一为文档顺序 */
export function docOrderIndex(doc: SceneDocument): Map<string, number> {
  const idx = new Map<string, number>();
  let i = 0;
  const walk = (parentId: string | null) => {
    for (const id of doc.childrenOf(parentId)) {
      idx.set(id, i++);
      if (doc.nodes.get(id)?.kind === 'group') walk(id);
    }
  };
  walk(null);
  return idx;
}

/** 子树高度(自身 = 1),用于预判拖入后的最大深度 */
export function subtreeHeight(doc: SceneDocument, id: string): number {
  const n = doc.nodes.get(id);
  if (!n || n.kind !== 'group') return 1;
  let h = 1;
  for (const c of doc.childrenOf(id)) h = Math.max(h, 1 + subtreeHeight(doc, c));
  return h;
}

export type DropRef =
  | { targetId: string; zone: 'before' | 'after' | 'into' }
  | { targetId: null; zone: 'root-end' };

export type DropPlan =
  | {
      ok: true;
      ids: string[]; // topMost 过滤 + 文档顺序排序后的实际移动集
      parentId: string | null;
      beforeId: string | null;
      depthWarning: boolean; // TREE-01:落点将超软上限 → UI 提示,不拦截
    }
  | { ok: false; reason: 'locked' | 'cycle' | 'self' | 'noop' | 'invalid' };

/** 把拖拽落点解析为 moveNodes 参数;所有非法情形在此拒绝,组件只负责画光标与指示线。 */
export function resolveDrop(doc: SceneDocument, rawIds: Iterable<string>, ref: DropRef): DropPlan {
  const order = docOrderIndex(doc);
  const ids = doc
    .topMost(rawIds)
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)); // 多选拖拽保持文档相对顺序
  if (!ids.length) return { ok: false, reason: 'invalid' };
  const dragged = new Set(ids);

  let parentId: string | null;
  let beforeId: string | null;

  if (ref.zone === 'root-end') {
    parentId = null;
    beforeId = null;
  } else {
    const target = doc.nodes.get(ref.targetId);
    if (!target) return { ok: false, reason: 'invalid' };
    if (dragged.has(ref.targetId)) return { ok: false, reason: 'self' }; // 落在被拖对象自身上 = 无效落点
    // 落点在被拖组的内部(后代行)同样无效 —— 环的行级预判
    for (const id of ids) {
      if (doc.nodes.get(id)?.kind === 'group' && doc.descendants(id).includes(ref.targetId)) {
        return { ok: false, reason: 'cycle' };
      }
    }
    const zone = ref.zone === 'into' && target.kind !== 'group' ? 'after' : ref.zone; // 实例无子级:中区视为 after
    if (zone === 'into') {
      parentId = ref.targetId;
      beforeId = null;
    } else {
      parentId = target.parentId;
      const siblings = doc.childrenOf(target.parentId);
      const at = siblings.indexOf(ref.targetId);
      if (zone === 'before') {
        beforeId = ref.targetId;
      } else {
        // after:取目标之后第一个「未被拖动」的兄弟作为插入参照;没有则追加末尾
        beforeId = siblings.slice(at + 1).find((s) => !dragged.has(s)) ?? null;
      }
    }
  }

  // TREE 边界 3:锁定组(含随组锁定)不接受拖入 —— 目标父级整链校验
  if (parentId && doc.effectiveLocked(parentId)) return { ok: false, reason: 'locked' };
  if (parentId && dragged.has(parentId)) return { ok: false, reason: 'cycle' };

  // 无变化落点:模拟移动后顺序与现状一致 → 不产生历史噪音
  const parentKeySiblings = doc.childrenOf(parentId);
  const allSameParent = ids.every((id) => (doc.nodes.get(id)!.parentId ?? '__r') === (parentId ?? '__r'));
  if (allSameParent) {
    const kept = parentKeySiblings.filter((s) => !dragged.has(s));
    const at = beforeId ? kept.indexOf(beforeId) : kept.length;
    const next = [...kept.slice(0, at), ...ids, ...kept.slice(at)];
    if (next.join('\u0000') === parentKeySiblings.join('\u0000')) return { ok: false, reason: 'noop' };
  }

  // TREE-01 深度软上限:父级深度 + 被拖子树最大高度 > 5 → 提示
  const baseDepth = parentId ? doc.depthOf(parentId) : 0;
  const depthWarning = ids.some((id) => baseDepth + subtreeHeight(doc, id) > DEPTH_SOFT_CAP);

  return { ok: true, ids, parentId, beforeId, depthWarning };
}
