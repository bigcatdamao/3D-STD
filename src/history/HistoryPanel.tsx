// 历史面板(T9,HIST-04/07/08 + 边界 1/5)。
// 形态:右侧检查器纵向时间线 —— 上旧下新,与属性/打印检查按任务切换，
//   释放原固定底栏高度，同时保留当前位置、跳转、hover 高亮和冻结语义。
// 语义:点击条目 = 跳到「应用完该条」的状态(含点击项);点「起点」= 全部撤销(jumpTo 0)。
//   跳转经 dispatch 走内核 jumpTo(批量撤销/重做),选中态随 HIST-06 逐条恢复。
// 冻结(预览态,边界 1):灰态可见、条目禁点、示角标;解冻自动恢复 —— T18 接 Tab 切换即生效。

import { useEffect, useRef } from 'react';
import { dispatch, doc, useUi } from '../state/store';
import { buildRows, expandHighlightIds, HistRow } from './history-logic';

const C = {
  text: '#e8e8ea',
  dim: '#8b8b93',
  border: '#2b2b31',
  bg: '#1b1b20',
  chip: '#232329',
  chipHover: '#2c2c34',
  accent: '#5dcaa5',
  amber: '#e6b35a',
};

function Chip({
  row,
  frozen,
  chipRef,
}: {
  row: HistRow;
  frozen: boolean;
  chipRef?: React.Ref<HTMLButtonElement>;
}) {
  const setHistHover = useUi((s) => s.setHistHover);
  return (
    <button
      ref={chipRef}
      title={`${row.label}${row.namesFull ? ` · ${row.namesFull}` : ''}(点击跳转到此步)`}
      onClick={() => dispatch((d) => d.history.jumpTo(row.position))}
      onMouseEnter={() => setHistHover(expandHighlightIds(doc, row.targetIds))} // HIST-08
      onMouseLeave={() => setHistHover(null)}
      disabled={frozen}
      style={{
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        padding: '5px 10px 4px',
        borderRadius: 6,
        border: `1px solid ${row.current ? C.accent : C.border}`,
        borderBottom: `2px solid ${row.current ? C.accent : C.border}`,
        background: C.chip,
        color: row.applied ? C.text : C.dim, // redo 侧(未应用)灰显
        opacity: row.applied ? 1 : 0.55,
        cursor: frozen ? 'default' : 'pointer',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.2,
        width: '100%',
        maxWidth: 'none',
        textAlign: 'left',
      }}
    >
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
        {row.icon} {row.label}
      </span>
      <span
        style={{
          fontSize: 11,
          color: C.dim,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
        }}
      >
        {row.names || '—'}
      </span>
    </button>
  );
}

export function HistoryPanel() {
  useUi((s) => s.rev); // 任何 command 后重派生(与树/面板同一订阅口径)
  const h = doc.history;
  const rows = buildRows(h.list(), h.position);
  const frozen = h.isFrozen;
  const currentRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  // 新条目入栈/跳转后,当前位置自动滚入可视区
  useEffect(() => {
    (h.position === 0 ? startRef : currentRef).current?.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: 'smooth',
    });
  });

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${C.border}`,
        background: C.bg,
        borderRadius: 8,
        padding: '4px 8px 6px',
        opacity: frozen ? 0.55 : 1, // 边界 1:冻结 = 灰态可见
      }}
    >
      <div style={{ display: 'grid', gap: 7, fontSize: 12, color: C.dim, padding: '4px 3px 9px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.text, fontWeight: 650 }}>操作时间线</span>
          <span>{h.position}/{h.length}</span>
          {frozen && <span style={{ marginLeft: 'auto', color: C.amber }}>预览态 · 历史冻结</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button style={btn(!frozen && h.canUndo)} disabled={!h.canUndo} title="撤销(Ctrl+Z)"
            onClick={() => dispatch((d) => d.history.undo())}>
            ↶ 撤销
          </button>
          <button style={btn(!frozen && h.canRedo)} disabled={!h.canRedo} title="重做(Ctrl+Shift+Z / Ctrl+Y)"
            onClick={() => dispatch((d) => d.history.redo())}>
            ↷ 重做
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 10 }}>点击跳转 · 悬停定位</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, padding: '0 2px 3px' }}>
        {h.hasOverflowed && (
          // HIST 边界 5:栈满不提示,面板顶部(时间轴最左)示合并占位,不可点击
          <span style={{ ...placeholderChip, alignSelf: 'center' }}>更早的记录已合并</span>
        )}
        <button
          ref={startRef}
          title="回到初始状态(撤销全部)"
          onClick={() => dispatch((d) => d.history.jumpTo(0))}
          disabled={frozen}
          style={{
            flex: '0 0 auto',
            width: '100%',
            padding: '5px 10px',
            borderRadius: 6,
            border: `1px solid ${h.position === 0 ? C.accent : C.border}`,
            borderBottom: `2px solid ${h.position === 0 ? C.accent : C.border}`,
            background: C.chip,
            color: h.position === 0 ? C.text : C.dim,
            cursor: frozen ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 12,
            textAlign: 'left',
          }}
        >
          ◦ 初始
        </button>
        {rows.map((r) => (
          <Chip key={r.position} row={r} frozen={frozen} chipRef={r.current ? currentRef : undefined} />
        ))}
        {!rows.length && (
          <span style={{ ...placeholderChip, border: 'none' }}>暂无历史 —— 拖动、删除、成组等编辑操作会记录在这里</span>
        )}
      </div>
    </div>
  );
}

const placeholderChip: React.CSSProperties = {
  flex: '0 0 auto',
  width: '100%',
  padding: '5px 10px',
  borderRadius: 6,
  border: `1px dashed ${C.border}`,
  color: C.dim,
  fontSize: 12,
  display: 'flex',
  alignItems: 'center',
};

const btn = (enabled: boolean): React.CSSProperties => ({
  font: 'inherit',
  fontSize: 12,
  padding: '1px 8px',
  borderRadius: 5,
  border: `1px solid ${C.border}`,
  background: 'transparent',
  color: enabled ? C.text : C.dim,
  opacity: enabled ? 1 : 0.5,
  cursor: enabled ? 'pointer' : 'default',
});
