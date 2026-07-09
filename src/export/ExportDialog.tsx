// 导出对话框(T15/CHK-07/08)。三阶段:
//   options  范围(全部可见/仅选中)+ 方式(合并单 STL / 逐对象 zip)+ 文件名 + 丢色说明;
//   checking 导出前自动检查进度(CHK-02,与结果面板同一轮);
//   confirm  错误级/未检/排除项如实列明,确认后放行(CHK-08/C4)。
// 顶栏「导出 STL」是出口区主 CTA(PROJ-06);空场景/全隐藏置灰+提示(CHK 边界 3)。

import { useCheckSnapshot } from '../check/check-state';
import { useUi } from '../state/store';
import {
  beginExport,
  cancelGate,
  closeExport,
  confirmProceed,
  exportableVisible,
  openExport,
  resolveSelectedScope,
  useExport,
  useExportSnapshot,
} from './export-state';

const AMBER = '#ffb454';
const RED = '#f09595';
const GREY = '#8b8b93';
const FG = '#e8e8ea';

const btn: React.CSSProperties = {
  background: '#26262e',
  color: '#c9c9d1',
  border: '1px solid #34343e',
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: AMBER,
  color: '#1b1b20',
  border: `1px solid ${AMBER}`,
  fontWeight: 700,
};

/** 顶栏出口区主 CTA。空场景/全隐藏 → 置灰 + 悬停说明(CHK 边界 3:置灰+提示) */
export function HeaderExportButton() {
  useUi((s) => s.rev); // 场景变更 → 可导出性重算
  const n = exportableVisible().length;
  const disabled = n === 0;
  return (
    <button
      style={{
        ...primaryBtn,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      disabled={disabled}
      onClick={openExport}
      title={
        disabled
          ? '无可导出对象:场景为空或全部隐藏(隐藏对象不导出,C7)'
          : `导出 STL:当前 ${n} 个可见对象(CHK-07)`
      }
    >
      ⬇ 导出 STL
    </button>
  );
}

function Radio({
  checked,
  disabled,
  label,
  hint,
  onPick,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint?: string;
  onPick: () => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 12,
        color: disabled ? GREY : FG,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
      title={disabled && hint ? hint : undefined}
    >
      <input type="radio" checked={checked} disabled={disabled} onChange={onPick} readOnly />
      <span>
        {label}
        {hint && !disabled && <span style={{ color: GREY, marginLeft: 6, fontSize: 11 }}>{hint}</span>}
      </span>
    </label>
  );
}

function OptionsStage() {
  useUi((s) => s.rev);
  const s = useExportSnapshot();
  const nVisible = exportableVisible().length;
  const sel = resolveSelectedScope();
  const nSelected = sel.included.length;
  return (
    <>
      <div style={{ fontSize: 12, color: GREY, marginBottom: 6 }}>范围</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        <Radio
          checked={s.scope === 'visible'}
          label={`全部可见对象(${nVisible} 个)`}
          onPick={() => useExport.getState().setScope('visible')}
        />
        <Radio
          checked={s.scope === 'selected'}
          disabled={nSelected === 0}
          label={`仅选中对象(${nSelected} 个)`}
          hint={
            nSelected === 0
              ? '当前无可导出的选中对象(选中为空、全部隐藏或资产未就绪)'
              : sel.excluded.length
                ? `选中含 ${sel.excluded.length} 个隐藏/未就绪对象,将被排除并在确认时注明`
                : undefined
          }
          onPick={() => useExport.getState().setScope('selected')}
        />
      </div>

      <div style={{ fontSize: 12, color: GREY, marginBottom: 6 }}>方式</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        <Radio
          checked={s.mode === 'merged'}
          label="合并为单个 STL(默认)"
          hint="多对象三角面合入一个网格文件"
          onPick={() => useExport.getState().setMode('merged')}
        />
        <Radio
          checked={s.mode === 'perObject'}
          label="逐对象导出(打包 zip)"
          hint="每个对象一个 STL,以对象名命名"
          onPick={() => useExport.getState().setMode('perObject')}
        />
      </div>

      <div style={{ fontSize: 12, color: GREY, marginBottom: 6 }}>文件名</div>
      <input
        value={s.baseName}
        onChange={(e) => useExport.getState().setBaseName(e.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: '#141418',
          color: FG,
          border: '1px solid #34343e',
          borderRadius: 6,
          padding: '6px 8px',
          fontSize: 12,
          marginBottom: 12,
        }}
      />

      <div
        style={{
          fontSize: 11,
          lineHeight: 1.5,
          color: GREY,
          background: '#141418',
          border: '1px solid #26262e',
          borderRadius: 6,
          padding: '7px 9px',
          marginBottom: 14,
        }}
      >
        ℹ️ STL 不保留颜色与材质;需保留对象结构与颜色请用 3MF(M2 路线图,CHK-09)。坐标系:Z-up · mm,与站内标注一致,零转换直写(C3)。
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={closeExport}>
          取消
        </button>
        <button style={primaryBtn} onClick={beginExport}>
          导出
        </button>
      </div>
    </>
  );
}

function CheckingStage() {
  const c = useCheckSnapshot();
  return (
    <>
      <div style={{ fontSize: 12, color: FG, marginBottom: 10 }}>
        导出前自动检查中…(CHK-02,与结果面板同一轮检查)
      </div>
      <div
        style={{
          height: 6,
          background: '#141418',
          borderRadius: 3,
          overflow: 'hidden',
          marginBottom: 6,
        }}
      >
        <div style={{ height: '100%', width: `${c.pct}%`, background: AMBER, transition: 'width .2s' }} />
      </div>
      <div style={{ fontSize: 11, color: GREY, marginBottom: 14 }}>
        {c.phaseText} {c.pct}%
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button style={btn} onClick={cancelGate}>
          返回
        </button>
      </div>
    </>
  );
}

function ConfirmStage() {
  const s = useExportSnapshot();
  const c = s.confirm;
  if (!c) return null;
  const li: React.CSSProperties = { fontSize: 11, lineHeight: 1.5, color: FG, margin: '2px 0' };
  return (
    <>
      <div style={{ fontSize: 12, color: FG, marginBottom: 10 }}>
        导出前请知悉以下事项(确认后照常导出,不做拦截 · C4):
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
        {c.errors.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginBottom: 3 }}>
              ⛔ 错误级问题({c.errors.length})——打印可能失败
            </div>
            {c.errors.map((e) => (
              <div key={e.key} style={li}>
                <span style={{ color: RED }}>{e.instanceName}</span>
                <span style={{ color: GREY }}> — {e.message}</span>
              </div>
            ))}
          </div>
        )}
        {c.unfinished.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: AMBER, fontWeight: 700, marginBottom: 3 }}>
              ⏱ 检查未完成({c.unfinished.length})——超时未检,状态未知
            </div>
            {c.unfinished.map((n) => (
              <div key={n} style={li}>
                {n}
              </div>
            ))}
          </div>
        )}
        {c.excluded.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: GREY, fontWeight: 700, marginBottom: 3 }}>
              🚫 已从导出中排除({c.excluded.length})——CHK 边界 4
            </div>
            {c.excluded.map((x) => (
              <div key={x.name} style={li}>
                <span>{x.name}</span>
                <span style={{ color: GREY }}> — {x.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={cancelGate}>
          返回
        </button>
        <button style={{ ...primaryBtn, background: RED, borderColor: RED }} onClick={confirmProceed}>
          仍要导出
        </button>
      </div>
    </>
  );
}

export function ExportDialog() {
  const s = useExportSnapshot();
  if (!s.open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 70,
      }}
      onClick={closeExport}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: '92vw',
          background: '#1b1b20',
          border: '1px solid #34343e',
          borderRadius: 10,
          padding: '16px 18px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ color: FG, fontWeight: 700, fontSize: 14 }}>导出 STL(二进制)</span>
          <button
            style={{ ...btn, padding: '2px 8px' }}
            onClick={closeExport}
            title="关闭(不导出)"
          >
            ✕
          </button>
        </div>
        {s.stage === 'options' && <OptionsStage />}
        {s.stage === 'checking' && <CheckingStage />}
        {s.stage === 'confirm' && <ConfirmStage />}
      </div>
    </div>
  );
}
