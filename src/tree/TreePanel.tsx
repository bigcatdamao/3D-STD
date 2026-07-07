// 场景树面板(T7)—— TREE-01~05 全部 P0 + 边界 1/3/6。
// 双页签壳:场景树 | 资产(T11 落位)。选中集与视口共享单一事实源(doc.selection,TREE-03);
// 树内允许选中与重命名锁定对象(TREE 验收样例 2)——锁定只约束视口拾取与变换,不约束树内管理(C7)。
//
// 交互约定:
//   单击 = 选中;Ctrl 加减选;Shift 范围选(按可见行序);双击 = 视口聚焦(TREE-04)
//   按住拖 ≥4px = 拖拽排序/入组;上 30% 插前、下 30% 插后、组的中段 = 拖入;Esc 取消
//   ✎ / F2 = 重命名(Enter 提交、Esc 还原;允许重名,TREE-05)
//   👁 / 🔒 = 显隐与锁定各自独立开关(C7 三状态正交);组状态对成员继承叠加,行内灰显提示

import { useEffect, useMemo, useRef, useState } from 'react';
import { SceneNode } from '../kernel/types';
import { dispatch, doc, sendCam, useUi } from '../state/store';
import { DEPTH_SOFT_CAP, DropRef, FlatRow, flattenVisible, resolveDrop, subtreeHeight } from './tree-logic';

const AMBER = '#ffb454';
const PANEL_BG = '#1b1b20';
const BORDER = '#2b2b31';

const btn: React.CSSProperties = {
  background: '#26262e',
  color: '#c9c9d1',
  border: '1px solid #34343e',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
};

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// ---------- 拖拽会话(组件外可变引用:pointermove 高频,避免每帧 setState 之外的开销) ----------
interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  pressedId: string;
  wasSelected: boolean; // 按下前是否已选中(决定抬起时是否收拢多选)
  active: boolean;
}

interface DragView {
  count: number;
  x: number;
  y: number;
  ref: DropRef | null;
  ok: boolean;
  reason: string | null;
}

export function TreePanel() {
  const [tab, setTab] = useState<'tree' | 'assets'>('tree');
  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '7px 0',
    fontSize: 12,
    textAlign: 'center',
    cursor: 'pointer',
    color: active ? '#e8e8ea' : '#8b8b93',
    borderBottom: `2px solid ${active ? AMBER : 'transparent'}`,
    userSelect: 'none',
  });
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}`, flex: 'none' }}>
        <div style={tabBtn(tab === 'tree')} onClick={() => setTab('tree')}>场景树</div>
        <div style={tabBtn(tab === 'assets')} onClick={() => setTab('assets')}>资产</div>
      </div>
      {tab === 'tree' ? (
        <TreeTab />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <span style={{ color: '#8b8b93', fontSize: 12, textAlign: 'center', lineHeight: 1.7 }}>
            资产面板 · T11 落位
            <br />
            导入 / AI 资产库与 IndexedDB 持久化将在此呈现
          </span>
        </div>
      )}
    </div>
  );
}

function TreeTab() {
  const rev = useUi((s) => s.rev); // 订阅文档版本:任何 command 后重派生
  const setToast = useUi((s) => s.setToast);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const anchorRef = useRef<string | null>(null); // Shift 范围选锚点 / F2 目标
  const session = useRef<DragSession | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => flattenVisible(doc, collapsed), [rev, collapsed]);
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);

  // 选中变化(单选)→ 滚动入视(与视口点选联动的可见性)
  const selSig = [...doc.selection].join(',');
  useEffect(() => {
    if (doc.selection.size === 1) {
      const id = [...doc.selection][0];
      rowEls.current.get(id)?.scrollIntoView({ block: 'nearest' });
    }
  }, [selSig]);

  // F2 重命名(TREE-04);拖拽中的 Esc 取消在 window 捕获
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && session.current?.active) {
        session.current = null;
        setDrag(null);
        document.body.style.cursor = '';
        return;
      }
      if (isTyping(e)) return;
      if (e.key === 'F2') {
        const target =
          anchorRef.current && doc.nodes.has(anchorRef.current)
            ? anchorRef.current
            : doc.selection.size === 1
              ? [...doc.selection][0]
              : null;
        if (target) {
          e.preventDefault();
          setRenaming(target);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- 拖拽:落点解析(null = 面板外,落下即取消) ----------
  const dropRefAt = (clientX: number, clientY: number): DropRef | null => {
    const list = listRef.current;
    if (!list) return null;
    const lr = list.getBoundingClientRect();
    if (clientX < lr.left - 20 || clientX > lr.right + 20) return null; // 横向离开面板 = 无效落点
    for (const row of rows) {
      const el = rowEls.current.get(row.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top || clientY >= r.bottom) continue;
      const t = (clientY - r.top) / r.height;
      if (row.kind === 'group') {
        if (t < 0.3) return { targetId: row.id, zone: 'before' };
        if (t > 0.7) return { targetId: row.id, zone: 'after' };
        return { targetId: row.id, zone: 'into' };
      }
      return { targetId: row.id, zone: t < 0.5 ? 'before' : 'after' };
    }
    // 首行之上 = 插到最前;其余行外空白 = 移至根层级末尾
    if (rows.length) {
      const first = rowEls.current.get(rows[0].id)?.getBoundingClientRect();
      if (first && clientY < first.top) return { targetId: rows[0].id, zone: 'before' };
    }
    return { targetId: null, zone: 'root-end' };
  };

  const onRowPointerDown = (e: React.PointerEvent, row: FlatRow) => {
    if (e.button !== 0 || renaming) return;
    const id = row.id;
    if (e.shiftKey) {
      // TREE-03 Shift 范围选:锚点 → 当前行(可见行序)
      const a = anchorRef.current && rowIndex.has(anchorRef.current) ? rowIndex.get(anchorRef.current)! : rowIndex.get(id)!;
      const b = rowIndex.get(id)!;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      dispatch((d) => d.select(rows.slice(lo, hi + 1).map((r) => r.id)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // TREE-03 Ctrl 加减选
      anchorRef.current = id;
      dispatch((d) => {
        const next = new Set(d.selection);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        d.select([...next]);
      });
      return;
    }
    const wasSelected = doc.selection.has(id);
    anchorRef.current = id;
    if (!wasSelected) dispatch((d) => d.select([id]));
    session.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, pressedId: id, wasSelected, active: false };

    const onMove = (ev: PointerEvent) => {
      const s = session.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      if (!s.active) {
        if (Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) < 4) return;
        s.active = true;
      }
      const ids = doc.topMost(doc.selection);
      const ref = dropRefAt(ev.clientX, ev.clientY);
      const plan = ref ? resolveDrop(doc, ids, ref) : null;
      const blocked = !!plan && !plan.ok && (plan.reason === 'locked' || plan.reason === 'cycle');
      document.body.style.cursor = blocked ? 'not-allowed' : 'grabbing';
      setDrag({
        count: ids.length,
        x: ev.clientX,
        y: ev.clientY,
        ref,
        ok: !!plan?.ok,
        reason: plan && !plan.ok ? plan.reason : null,
      });
    };
    const onUp = (ev: PointerEvent) => {
      const s = session.current;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      session.current = null;
      setDrag(null);
      if (!s || ev.pointerId !== s.pointerId) return;
      if (s.active) {
        const ref = dropRefAt(ev.clientX, ev.clientY);
        const plan = ref ? resolveDrop(doc, doc.topMost(doc.selection), ref) : null;
        if (plan?.ok) {
          dispatch((d) => d.moveNodes(plan.ids, plan.parentId, plan.beforeId));
          if (plan.depthWarning) setToast(`已超过建议层级深度 ${DEPTH_SOFT_CAP}(仅提示,不限制)`);
        }
        return;
      }
      // 未成拖 = 点击:按下前已在多选中 → 收拢为单选(标准树语义)
      if (s.wasSelected && doc.selection.size > 1) dispatch((d) => d.select([s.pressedId]));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ---------- 工具栏动作 ----------
  const sel = doc.selection;
  const selectedGroups = [...sel].filter((id) => doc.nodes.get(id)?.kind === 'group');
  const onGroup = () => {
    if (!sel.size) return;
    const g = dispatch((d) => d.group(d.topMost(d.selection)));
    if (doc.depthOf(g.id) + subtreeHeight(doc, g.id) - 1 > DEPTH_SOFT_CAP) {
      setToast(`已超过建议层级深度 ${DEPTH_SOFT_CAP}(仅提示,不限制)`);
    }
  };
  const onUngroup = () => {
    if (selectedGroups.length) dispatch((d) => d.ungroupMany(selectedGroups));
  };
  const onDelete = () => {
    if (sel.size) dispatch((d) => d.removeNodes(d.topMost(d.selection)));
  };

  const instCount = [...doc.nodes.values()].filter((n) => n.kind === 'instance').length;
  const groupCount = doc.nodes.size - instCount;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 5, padding: '7px 8px', borderBottom: `1px solid ${BORDER}`, flex: 'none' }}>
        <button style={{ ...btn, ...(sel.size ? {} : DISABLED) }} disabled={!sel.size} onClick={onGroup} title="选中对象合为一组(TREE-04);默认命名「组 N」">
          成组
        </button>
        <button
          style={{ ...btn, ...(selectedGroups.length ? {} : DISABLED) }}
          disabled={!selectedGroups.length}
          onClick={onUngroup}
          title="解散选中的组,成员回填原位;撤销可完整还原(TREE 边界 2)"
        >
          解组
        </button>
        <button
          style={{ ...btn, marginLeft: 'auto', ...(sel.size ? { color: '#f09595' } : DISABLED) }}
          disabled={!sel.size}
          onClick={onDelete}
          title="删除所选;组 = 删除组及内容,一步入栈(TREE 边界 1)。快捷键 Del"
        >
          删除
        </button>
      </div>

      <div
        ref={listRef}
        style={{ flex: 1, overflowY: 'auto', padding: '4px 0', position: 'relative' }}
        onPointerDown={(e) => {
          // 列表空白处按下 = 清空选中(与视口空白点击语义一致)
          if (e.target === listRef.current && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            anchorRef.current = null;
            dispatch((d) => d.select([]));
          }
        }}
      >
        {rows.length === 0 && (
          <div style={{ padding: '28px 14px', color: '#8b8b93', fontSize: 12, textAlign: 'center', lineHeight: 1.8 }}>
            场景为空
            <br />
            导入与 AI 生成入口随 T11 / T12 落位
          </div>
        )}
        {rows.map((row) => (
          <TreeRow
            key={row.id}
            row={row}
            drag={drag}
            renaming={renaming === row.id}
            registerEl={(el) => {
              if (el) rowEls.current.set(row.id, el);
              else rowEls.current.delete(row.id);
            }}
            onPointerDown={(e) => onRowPointerDown(e, row)}
            onToggleCollapse={() => {
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(row.id)) next.delete(row.id);
                else next.add(row.id);
                return next;
              });
            }}
            onStartRename={() => setRenaming(row.id)}
            onEndRename={(commit, value) => {
              setRenaming(null);
              if (commit) dispatch((d) => d.rename(row.id, value)); // 空名/未变更由内核拒绝
            }}
            onFocusInViewport={() => {
              if (!doc.selection.has(row.id)) dispatch((d) => d.select([row.id]));
              sendCam({ kind: 'focus' }); // TREE-04 双击聚焦;组 = 聚焦其内容包围盒
            }}
          />
        ))}
      </div>

      <div style={{ flex: 'none', padding: '5px 10px', borderTop: `1px solid ${BORDER}`, color: '#8b8b93', fontSize: 11 }}>
        实例 {instCount} · 组 {groupCount} · 选中 {sel.size}
      </div>

      {drag && (
        <div
          style={{
            position: 'fixed',
            left: drag.x + 14,
            top: drag.y + 12,
            zIndex: 30,
            background: drag.reason === 'locked' || drag.reason === 'cycle' ? '#f09595' : AMBER,
            color: '#1b1b20',
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 5,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {drag.reason === 'locked' ? '锁定的组不接受拖入' : drag.reason === 'cycle' ? '不能拖入自身内部' : `移动 ${drag.count} 项`}
        </div>
      )}
    </div>
  );
}

const DISABLED: React.CSSProperties = { opacity: 0.4, cursor: 'default' };

function TreeRow({
  row,
  drag,
  renaming,
  registerEl,
  onPointerDown,
  onToggleCollapse,
  onStartRename,
  onEndRename,
  onFocusInViewport,
}: {
  row: FlatRow;
  drag: DragView | null;
  renaming: boolean;
  registerEl: (el: HTMLDivElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onToggleCollapse: () => void;
  onStartRename: () => void;
  onEndRename: (commit: boolean, value: string) => void;
  onFocusInViewport: () => void;
}) {
  const node = doc.nodes.get(row.id) as SceneNode | undefined;
  if (!node) return null;
  const selected = doc.selection.has(row.id);
  const effVisible = doc.effectiveVisible(row.id);
  const effLocked = doc.effectiveLocked(row.id);
  const inheritedHidden = effVisible === false && node.visible; // 自身可见但随组隐藏(C7 叠加)
  const inheritedLocked = effLocked && !node.locked;

  const isDropTarget = drag?.ref && drag.ref.targetId === row.id;
  const zone = isDropTarget && drag!.ref!.targetId ? drag!.ref!.zone : null;
  const blocked = isDropTarget && !drag!.ok && (drag!.reason === 'locked' || drag!.reason === 'cycle');

  const iconBtn = (on: boolean, extra?: React.CSSProperties): React.CSSProperties => ({
    width: 20,
    flex: 'none',
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'center',
    opacity: on ? 0.92 : 0.25,
    ...extra,
  });

  return (
    <div
      ref={registerEl}
      onPointerDown={onPointerDown}
      onDoubleClick={onFocusInViewport}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        height: 26,
        paddingLeft: 6 + (row.depth - 1) * 14,
        paddingRight: 6,
        fontSize: 12,
        userSelect: 'none',
        cursor: 'default',
        background:
          zone === 'into' && !blocked
            ? 'rgba(255,180,84,0.14)'
            : blocked
              ? 'rgba(240,149,149,0.12)'
              : selected
                ? 'rgba(255,180,84,0.12)'
                : 'transparent',
        boxShadow: selected ? `inset 2px 0 0 ${AMBER}` : zone === 'into' && !blocked ? `inset 0 0 0 1px ${AMBER}` : 'none',
      }}
      title={row.depth > DEPTH_SOFT_CAP ? `超出建议层级深度 ${DEPTH_SOFT_CAP}` : undefined}
    >
      {zone === 'before' && !blocked && <DropLine top />}
      {zone === 'after' && !blocked && <DropLine />}

      {/* 折叠箭头(仅组;空组保留空态可见,TREE 边界 6) */}
      {row.kind === 'group' ? (
        <button
          style={iconBtn(true, { color: '#8b8b93', opacity: row.hasChildren ? 0.9 : 0.35 })}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleCollapse}
          title={row.collapsed ? '展开' : '折叠'}
        >
          {row.collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span style={{ width: 20, flex: 'none' }} />
      )}

      {/* 名称 / 重命名输入(允许重名;Enter 提交、Esc 还原,TREE-05) */}
      {renaming ? (
        <RenameInput initial={node.name} onEnd={onEndRename} />
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: effLocked ? '#8b8b93' : row.kind === 'group' ? '#e8e8ea' : '#d2d2d8',
            opacity: effVisible ? 1 : 0.42,
            fontWeight: row.kind === 'group' ? 600 : 400,
          }}
          title={[node.name, inheritedHidden ? '随组隐藏' : '', inheritedLocked ? '随组锁定' : ''].filter(Boolean).join(' · ')}
        >
          {node.name}
          {row.kind === 'group' && !row.hasChildren && <span style={{ color: '#8b8b93', fontWeight: 400 }}>(空)</span>}
        </span>
      )}

      {!renaming && (
        <>
          <button
            style={iconBtn(false, { opacity: 0.35 })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onStartRename}
            title="重命名(F2)"
          >
            ✎
          </button>
          {/* C7 三状态图标列:显隐 / 锁定各自独立,图标反映自身标记;继承态经行灰显 + title 提示 */}
          <button
            style={iconBtn(node.visible)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => dispatch((d) => d.setVisible([row.id], !node.visible))}
            title={node.visible ? '隐藏(不渲染 · 不检查 · 不导出,C7)' : '显示'}
          >
            👁
          </button>
          <button
            style={iconBtn(node.locked)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => dispatch((d) => d.setLocked([row.id], !node.locked))}
            title={
              node.locked
                ? '解锁'
                : inheritedLocked
                  ? '随组锁定中 · 点击将其自身也锁定'
                  : '锁定(视口不可选不可变换;树内仍可管理,C7)'
            }
          >
            {node.locked ? '🔒' : '🔓'}
          </button>
        </>
      )}
    </div>
  );
}

function DropLine({ top = false }: { top?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 4,
        right: 4,
        height: 2,
        background: AMBER,
        borderRadius: 1,
        ...(top ? { top: -1 } : { bottom: -1 }),
        pointerEvents: 'none',
      }}
    />
  );
}

function RenameInput({ initial, onEnd }: { initial: string; onEnd: (commit: boolean, value: string) => void }) {
  const [value, setValue] = useState(initial);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          onEnd(true, value);
        } else if (e.key === 'Escape') {
          cancelled.current = true;
          onEnd(false, initial);
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onEnd(true, value);
      }}
      style={{
        flex: 1,
        minWidth: 0,
        background: '#141417',
        color: '#e8e8ea',
        border: `1px solid ${AMBER}`,
        borderRadius: 4,
        fontSize: 12,
        padding: '2px 5px',
        outline: 'none',
      }}
    />
  );
}

/** 全局轻提示层(App 挂载):TREE-01 深度软上限等「提示不禁止」类反馈。
 *  T10 起支持可选动作按钮(IMP-05「可撤 toast」——重选单位);带动作时停留加长、开启点击。 */
export function ToastLayer() {
  const toast = useUi((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), toast.action ? 6500 : 2800);
    return () => clearTimeout(t);
  }, [toast?.id]);
  if (!toast || !visible) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 112,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#26262e',
        border: `1px solid ${AMBER}`,
        color: '#e8e8ea',
        fontSize: 12,
        padding: '6px 14px',
        borderRadius: 7,
        zIndex: 40,
        pointerEvents: toast.action ? 'auto' : 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span>{toast.text}</span>
      {toast.action && (
        <button
          style={{
            background: 'transparent',
            border: 'none',
            color: AMBER,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            padding: 0,
          }}
          onClick={() => {
            toast.action!.run();
            setVisible(false);
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
