import { useEffect, useState } from 'react';
import { HistoryPanel } from './history/HistoryPanel';
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

export function App() {
  const [health, setHealth] = useState<'检测中' | '在线' | '离线'>('检测中');
  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? setHealth('在线') : setHealth('离线')))
      .catch(() => setHealth('离线'));
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
        <span>项目 · 导入 · 编辑/预览 · 检查 · 导出(T17/T18 落位)</span>
        <span>
          服务层:
          <b style={{ color: health === '在线' ? '#5dcaa5' : health === '离线' ? '#f09595' : '#8b8b93' }}>
            {' '}{health}
          </b>
        </span>
      </header>
      <aside style={{ minHeight: 0 }}>
        <TreePanel />
      </aside>
      <main style={{ ...zone, padding: 0, overflow: 'hidden' }}>
        <Viewport />
      </main>
      <aside style={{ minHeight: 0 }}>
        <ParamPanel />
      </aside>
      <footer style={{ gridColumn: '1 / 4', display: 'flex', gap: 8, minHeight: 0 }}>
        <div style={{ ...zone, flex: '0 0 300px' }}>AI 指令条(T12)</div>
        <HistoryPanel />
      </footer>
      <ToastLayer />
    </div>
  );
}
