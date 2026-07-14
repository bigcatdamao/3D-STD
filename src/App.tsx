import { useEffect, useState } from 'react';
import { GenPanel } from './ai/GenPanel';
import { initPersistence } from './assets/persist';
import { CheckPanel } from './check/CheckPanel';
import { runPrintCheck, useCheck } from './check/check-state';
import { ExportDialog, HeaderExportButton } from './export/ExportDialog';
import { HistoryPanel } from './history/HistoryPanel';
import { ServiceStatus } from './net/ServiceStatus';
import { ParamPanel } from './panel/ParamPanel';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_KEY,
  type InspectorTab,
  type WorkspaceLayout,
} from './product/workspace-layout';
import { ToastLayer, TreePanel } from './tree/TreePanel';
import { Viewport } from './viewport/Viewport';

function HeaderCheckButton({ onOpen }: { onOpen: () => void }) {
  const phase = useCheck((s) => s.phase);
  const running = phase === 'running';
  return (
    <button
      className="app-secondary-button"
      disabled={running}
      onClick={() => {
        onOpen();
        void runPrintCheck();
      }}
      title="检查水密性、退化几何、床内位置、悬空与微小件"
    >
      {running ? '检查中…' : '打印检查'}
    </button>
  );
}

function WorkflowStrip() {
  return (
    <nav className="workflow-strip" aria-label="核心工作流">
      <span className="workflow-step" data-step="1">生成 / 导入</span>
      <span className="workflow-divider">›</span>
      <span className="workflow-step is-active" data-step="2">编辑摆盘</span>
      <span className="workflow-divider">›</span>
      <span className="workflow-step" data-step="3">打印检查</span>
      <span className="workflow-divider">›</span>
      <span className="workflow-step" data-step="4">导出</span>
    </nav>
  );
}

function CollapsedRail({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <div className="workspace-panel__rail">
      <button className="app-icon-button" onClick={onOpen} title={`展开${label}`} aria-label={`展开${label}`}>
        ＋
      </button>
      <span className="workspace-panel__rail-label">{label}</span>
    </div>
  );
}

function Inspector({ tab, onTab }: { tab: InspectorTab; onTab: (tab: InspectorTab) => void }) {
  const issues = useCheck((s) => s.issues);
  const issueCount = issues.filter((issue) => issue.level !== 'info').length;
  return (
    <div className="inspector-shell">
      <div className="inspector-tabs" role="tablist" aria-label="右侧检查器">
        <button
          className={`inspector-tab${tab === 'properties' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'properties'}
          onClick={() => onTab('properties')}
        >
          属性
        </button>
        <button
          className={`inspector-tab${tab === 'check' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'check'}
          onClick={() => onTab('check')}
        >
          打印检查
          {issueCount > 0 && <span className="inspector-tab__count">{issueCount}</span>}
        </button>
      </div>
      <div className="inspector-content">
        {tab === 'properties' ? <ParamPanel /> : <CheckPanel embedded />}
      </div>
    </div>
  );
}

function initialLayout(): WorkspaceLayout {
  if (typeof window === 'undefined') return { ...DEFAULT_WORKSPACE_LAYOUT };
  return parseWorkspaceLayout(window.localStorage.getItem(WORKSPACE_LAYOUT_KEY));
}

export function App() {
  const [layout, setLayout] = useState<WorkspaceLayout>(initialLayout);

  useEffect(() => {
    void initPersistence();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, serializeWorkspaceLayout(layout));
    } catch {
      // 私密模式或存储受限时只影响界面偏好，不阻断工作台。
    }
  }, [layout]);

  useEffect(() => {
    const openAi = () => {
      setLayout((current) => ({ ...current, dockOpen: true }));
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('[data-testid="gen-panel"] textarea')?.focus();
      }, 220);
    };
    window.addEventListener('3dstd:open-ai', openAi);
    return () => window.removeEventListener('3dstd:open-ai', openAi);
  }, []);

  const patchLayout = (patch: Partial<WorkspaceLayout>) => setLayout((current) => ({ ...current, ...patch }));
  const openCheck = () => patchLayout({ inspectorOpen: true, inspectorTab: 'check' });

  return (
    <div
      className="app-shell"
      data-left-open={layout.leftOpen}
      data-inspector-open={layout.inspectorOpen}
      data-dock-open={layout.dockOpen}
    >
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">3D</div>
          <div className="brand-copy">
            <div className="brand-name">3D Studio</div>
            <div className="brand-scene">AI 创作到打印就绪 · 当前场景</div>
          </div>
        </div>

        <WorkflowStrip />

        <div className="header-actions">
          <button
            className={`app-icon-button${layout.leftOpen ? ' is-active' : ''}`}
            onClick={() => patchLayout({ leftOpen: !layout.leftOpen })}
            title={layout.leftOpen ? '收起场景与资产' : '展开场景与资产'}
            aria-label={layout.leftOpen ? '收起场景与资产' : '展开场景与资产'}
          >
            ◧
          </button>
          <button
            className={`app-icon-button${layout.dockOpen ? ' is-active' : ''}`}
            onClick={() => patchLayout({ dockOpen: !layout.dockOpen })}
            title={layout.dockOpen ? '收起 AI 与历史' : '展开 AI 与历史'}
            aria-label={layout.dockOpen ? '收起 AI 与历史' : '展开 AI 与历史'}
          >
            ▤
          </button>
          <button
            className={`app-icon-button${layout.inspectorOpen ? ' is-active' : ''}`}
            onClick={() => patchLayout({ inspectorOpen: !layout.inspectorOpen })}
            title={layout.inspectorOpen ? '收起检查器' : '展开检查器'}
            aria-label={layout.inspectorOpen ? '收起检查器' : '展开检查器'}
          >
            ◨
          </button>
          <HeaderCheckButton onOpen={openCheck} />
          <HeaderExportButton />
          <ServiceStatus />
        </div>
      </header>

      <aside className="workspace-panel" aria-label="场景与资产">
        {layout.leftOpen ? (
          <>
            <div className="workspace-panel__body"><TreePanel /></div>
            <button
              className="app-icon-button workspace-panel__collapse"
              onClick={() => patchLayout({ leftOpen: false })}
              title="收起场景与资产"
              aria-label="收起场景与资产"
            >
              ‹
            </button>
          </>
        ) : <CollapsedRail label="场景与资产" onOpen={() => patchLayout({ leftOpen: true })} />}
      </aside>

      <main className="viewport-frame" aria-label="3D 视口">
        <Viewport />
      </main>

      <aside className="workspace-panel" aria-label="属性与打印检查">
        {layout.inspectorOpen ? (
          <>
            <div className="workspace-panel__body">
              <Inspector tab={layout.inspectorTab} onTab={(inspectorTab) => patchLayout({ inspectorTab })} />
            </div>
            <button
              className="app-icon-button workspace-panel__collapse"
              onClick={() => patchLayout({ inspectorOpen: false })}
              title="收起检查器"
              aria-label="收起检查器"
            >
              ›
            </button>
          </>
        ) : <CollapsedRail label="属性与检查" onOpen={() => patchLayout({ inspectorOpen: true })} />}
      </aside>

      <footer className="bottom-dock">
        <div className="bottom-dock__bar">
          <span className="bottom-dock__title">AI 创作与操作历史</span>
          <span>生成结果进入资产库，场景编辑可逐步撤销</span>
          <span className="bottom-dock__hint">Enter 生成 · Ctrl+Z 撤销</span>
          <button
            className="app-icon-button"
            onClick={() => patchLayout({ dockOpen: !layout.dockOpen })}
            title={layout.dockOpen ? '收起底部面板' : '展开底部面板'}
            aria-label={layout.dockOpen ? '收起底部面板' : '展开底部面板'}
          >
            {layout.dockOpen ? '⌄' : '⌃'}
          </button>
        </div>
        <div className="bottom-dock__body">
          <GenPanel />
          <HistoryPanel />
        </div>
      </footer>

      <ToastLayer />
      <ExportDialog />
    </div>
  );
}
