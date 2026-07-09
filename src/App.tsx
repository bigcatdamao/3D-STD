import { useEffect } from 'react';
import { GenPanel } from './ai/GenPanel';
import { initPersistence } from './assets/persist';
import { CheckPanel } from './check/CheckPanel';
import { runPrintCheck, useCheck } from './check/check-state';
import { HistoryPanel } from './history/HistoryPanel';
import { ServiceStatus } from './net/ServiceStatus';
import { ParamPanel } from './panel/ParamPanel';
import { ToastLayer, TreePanel } from './tree/TreePanel';
import { Viewport } from './viewport/Viewport';

// T1 冒烟壳:五区布局占位(PRD 6.1 顶栏动线 / 整站 IA)。各区在 T5–T9 陆续替换为真实模块。
const zone: React.CSSProperties = {
  border: '1px solid #2b2b31',
  background: '#1b1b20',
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#8b8b93',
  fontSize: 13,
};

/** 顶栏「出口」区检查按钮:触发全量检查并展开结果面板(CHK-02 手动触发入口之一) */
function HeaderCheckButton() {
  const phase = useCheck((s) => s.phase);
  const running = phase === 'running';
  return (
    <button
      style={{
        background: running ? '#26262e' : 'transparent',
        color: running ? '#8b8b93' : '#ffb454',
        border: '1px solid #ffb45455',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12,
        cursor: running ? 'default' : 'pointer',
        fontWeight: 600,
      }}
      disabled={running}
      onClick={() => runPrintCheck()}
      title="打印前检查:水密性 · 退化几何 · 床内位置 · 悬空 · 微小件(CHK-01)"
    >
      {running ? '检查中…' : '✓ 打印检查'}
    </button>
  );
}

export function App() {
  useEffect(() => {
    void initPersistence(); // T11:装载资产库并启动对账同步(不可用则降级会话模式,不阻断)
  }, []);

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateRows: '48px 1fr 96px',
        gridTemplateColumns: '240px 1fr 280px',
        gap: 8,
        padding: 8,
        boxSizing: 'border-box',
      }}
    >
      <header style={{ ...zone, gridColumn: '1 / 4', justifyContent: 'space-between', padding: '0 14px' }}>
        <span style={{ color: '#e8e8ea', fontWeight: 600 }}>3D STD</span>
        <span>项目 · 导入 · 编辑/预览 · 导出(T15/T17/T18 落位)</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* PROJ-06 顶栏右区「出口」:检查在 T14 落位;导出主 CTA 归 T15 */}
          <HeaderCheckButton />
          <ServiceStatus />
        </span>
      </header>
      <aside style={{ minHeight: 0 }}>
        <TreePanel />
      </aside>
      <main style={{ ...zone, padding: 0, overflow: 'hidden' }}>
        <Viewport />
      </main>
      <aside style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ParamPanel />
        </div>
        <CheckPanel />
      </aside>
      <footer style={{ gridColumn: '1 / 4', display: 'flex', gap: 8, minHeight: 0 }}>
        <GenPanel />
        <HistoryPanel />
      </footer>
      <ToastLayer />
    </div>
  );
}
