import { useEffect, useState } from 'react';
import { GenPanel } from './ai/GenPanel';
import { CreationAgentPanel } from './agent/CreationAgentPanel';
import { initPersistence } from './assets/persist';
import { CheckPanel } from './check/CheckPanel';
import { focusIssue, reportIsStale, runPrintCheck, useCheck } from './check/check-state';
import { ExportDialog, HeaderExportButton } from './export/ExportDialog';
import { HistoryPanel } from './history/HistoryPanel';
import { ImportButton } from './importer/ImportUI';
import { ServiceStatus } from './net/ServiceStatus';
import { ParamPanel } from './panel/ParamPanel';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  defaultWorkspaceLayoutForWidth,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_KEY,
  type InspectorTab,
  type WorkspaceLayout,
} from './product/workspace-layout';
import {
  bootstrapComponentPreviewQaScene,
  bootstrapDemoScene,
  bootstrapPlaneCutPreviewQaScene,
  bootstrapSurfaceCutPreviewQaScene,
  bootstrapSelfIntersectionQaScene,
  dispatch,
  doc,
  expandToInstances,
  sendCam,
  useUi,
} from './state/store';
import { startPlaneCutPreview, startSurfaceAdaptiveCutPreview } from './split/plane-cut-state';
import {
  manualPlaneSplitIsActive,
  setManualPlaneAxis,
  setManualSplitKind,
  startManualPlaneSplit,
  useManualPlaneSplit,
} from './split/manual-plane-split-state';
import { ManualPlaneSplitPanel } from './split/ManualPlaneSplitPanel';
import { AutoSplitPanel } from './split/AutoSplitPanel';
import { autoSplitIsActive, startAutoSplit, useAutoSplit } from './split/auto-split-state';
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
  useUi((s) => s.rev);
  const checkPhase = useCheck((s) => s.phase);
  const hasInstance = [...doc.nodes.values()].some((node) => node.kind === 'instance');
  const activeStep = !hasInstance ? 1 : checkPhase === 'done' && !reportIsStale() ? 3 : 2;
  const steps = [
    [1, '生成 / 导入'],
    [2, '编辑摆盘'],
    [3, '打印检查'],
    [4, '导出'],
  ] as const;
  return (
    <nav className="workflow-strip" aria-label="核心工作流">
      {steps.map(([step, label], index) => (
        <span className="workflow-strip__item" key={step}>
          {index > 0 && <span className="workflow-divider">›</span>}
          <span className={`workflow-step${activeStep === step ? ' is-active' : ''}`} data-step={step}>
            {label}
          </span>
        </span>
      ))}
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
  useUi((s) => s.rev);
  const splitPhase = useManualPlaneSplit((state) => state.phase);
  const splitKind = useManualPlaneSplit((state) => state.cutKind);
  const issues = useCheck((s) => s.issues);
  const issueCount = issues.filter((issue) => issue.level !== 'info').length;
  const history = doc.history;
  const autoSplitPhase = useAutoSplit((state) => state.phase);
  if (autoSplitPhase !== 'idle') {
    return (
      <div className="inspector-shell">
        <div className="inspector-tabs" role="tablist" aria-label="自动拆件">
          <button className="inspector-tab is-active" role="tab" aria-selected="true">自动拆件</button>
          <span className="inspector-mode-note">Hi3D</span>
        </div>
        <div className="inspector-content"><AutoSplitPanel /></div>
      </div>
    );
  }
  if (splitPhase !== 'idle') {
    return (
      <div className="inspector-shell">
        <div className="inspector-tabs" role="tablist" aria-label="拆件方式">
          <button
            className={`inspector-tab${splitKind === 'surface' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={splitKind === 'surface'}
            disabled={splitPhase === 'running' || splitPhase === 'previewing'}
            onClick={() => setManualSplitKind('surface')}
          >
            绘制面组
          </button>
          <button
            className={`inspector-tab${splitKind === 'plane' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={splitKind === 'plane'}
            disabled={splitPhase === 'running' || splitPhase === 'previewing'}
            onClick={() => setManualSplitKind('plane')}
          >
            平面切割
          </button>
          <span className="inspector-mode-note">Esc 取消</span>
        </div>
        <div className="inspector-content"><ManualPlaneSplitPanel /></div>
      </div>
    );
  }
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
        <button
          className={`inspector-tab${tab === 'history' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'history'}
          onClick={() => onTab('history')}
        >
          历史
          <span className="inspector-tab__meta">{history.position}/{history.length}</span>
        </button>
      </div>
      <div className="inspector-content">
        {tab === 'properties'
          ? <ParamPanel />
          : tab === 'check'
            ? <CheckPanel embedded />
            : <HistoryPanel />}
      </div>
    </div>
  );
}

function CreationPanel({ dismissible, onClose }: { dismissible: boolean; onClose: () => void }) {
  const [route, setRoute] = useState<'agent' | 'image'>('agent');
  const openExample = () => {
    if (bootstrapDemoScene()) {
      onClose();
      useUi.getState().setToast('示例场景已打开：可直接体验编辑、打印检查与导出');
      window.setTimeout(() => sendCam({ kind: 'home' }), 0);
    }
  };

  return (
    <div
      className={`creation-overlay${dismissible ? ' is-dismissible' : ''}`}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <section className={`creation-panel${route === 'agent' ? ' creation-panel--agent' : ''}`} aria-label="3D 创作 Agent">
        <header className="creation-panel__header">
          <div>
            <div className="creation-panel__eyebrow">3D 创作 Agent · M1.14b.1</div>
            <h2>{route === 'agent' ? '从模糊想法，到可确认的创作需求' : '用参考图快速生成模型'}</h2>
            <p>{route === 'agent' ? '像聊天一样说出想法；Agent 会在合适时机追问，并整理成可编辑的 Brief。' : '添加一至三张本地图片，直接进入现有图生 3D 流程。'}</p>
          </div>
          {dismissible && (
            <button className="creation-panel__close" onClick={onClose} aria-label="关闭 AI 创作面板" title="关闭">
              ×
            </button>
          )}
        </header>
        <div className="creation-panel__routes" role="tablist" aria-label="3D 创作方式">
          <button type="button" role="tab" aria-selected={route === 'agent'} className={route === 'agent' ? 'is-active' : ''} onClick={() => setRoute('agent')}>
            <strong>✦ 3D 创作 Agent</strong><small>对话澄清需求</small>
          </button>
          <button type="button" role="tab" aria-selected={route === 'image'} className={route === 'image' ? 'is-active' : ''} onClick={() => setRoute('image')}>
            <strong>快速图生模型</strong><small>已有清晰参考图</small>
          </button>
        </div>
        {route === 'agent' ? <CreationAgentPanel /> : <GenPanel allowedTypes={['image', 'multiview']} />}
        {!dismissible && (
          <footer className="creation-panel__footer">
            <span>或者</span>
            <ImportButton target="viewport" label="导入本地模型" className="creation-panel__secondary" />
            <button className="creation-panel__tertiary" onClick={openExample}>打开示例场景</button>
            <small>支持 GLB、glTF、STL、OBJ，也可直接拖入视口</small>
          </footer>
        )}
      </section>
    </div>
  );
}

function initialLayout(): WorkspaceLayout {
  if (typeof window === 'undefined') return { ...DEFAULT_WORKSPACE_LAYOUT };
  const saved = window.localStorage.getItem(WORKSPACE_LAYOUT_KEY);
  return saved ? parseWorkspaceLayout(saved) : defaultWorkspaceLayoutForWidth(window.innerWidth);
}

export function App() {
  const [layout, setLayout] = useState<WorkspaceLayout>(initialLayout);
  useUi((s) => s.rev);
  const hasInstance = [...doc.nodes.values()].some((node) => node.kind === 'instance');

  useEffect(() => {
    void initPersistence();
  }, []);

  useEffect(() => {
    const qa = new URLSearchParams(window.location.search).get('qa');
    const bootstrapped = qa === 'self-intersection'
      ? bootstrapSelfIntersectionQaScene()
      : qa === 'component-preview'
        ? bootstrapComponentPreviewQaScene()
        : qa === 'plane-cut-preview'
          ? bootstrapPlaneCutPreviewQaScene()
          : qa === 'surface-cut-preview' || qa === 'manual-split-entry' || qa === 'manual-surface-cut'
            ? bootstrapSurfaceCutPreviewQaScene()
            : false;
    if (!bootstrapped) return;
    setLayout((current) => ({
      ...current,
      leftOpen: true,
      inspectorOpen: true,
      creationOpen: false,
      inspectorTab: 'check',
    }));
    let previewTimer: number | undefined;
    const timer = window.setTimeout(() => {
      sendCam({ kind: 'focus' });
      if (qa === 'manual-surface-cut') {
        const instance = [...doc.nodes.values()].find((node) => node.kind === 'instance');
        if (instance?.kind === 'instance') {
          dispatch((scene) => scene.select([instance.id]));
          startManualPlaneSplit(instance.id, 'surface');
          setManualPlaneAxis('x');
          setLayout((current) => ({
            ...current,
            inspectorOpen: true,
            inspectorTab: 'properties',
            creationOpen: false,
          }));
        }
        return;
      }
      runPrintCheck();
      if (qa === 'component-preview' || qa === 'plane-cut-preview' || qa === 'surface-cut-preview') {
        let attempts = 0;
        previewTimer = window.setInterval(() => {
          const issue = useCheck.getState().issues.find((candidate) => candidate.code === 'dims');
          if (issue) {
            if (qa === 'plane-cut-preview' || qa === 'surface-cut-preview') {
              startPlaneCutPreview(issue);
              if (qa === 'surface-cut-preview') window.setTimeout(startSurfaceAdaptiveCutPreview, 80);
            } else focusIssue(issue);
            window.clearInterval(previewTimer);
          } else if (++attempts >= 40) {
            window.clearInterval(previewTimer);
          }
        }, 50);
      }
    }, 120);
    return () => {
      window.clearTimeout(timer);
      if (previewTimer !== undefined) window.clearInterval(previewTimer);
    };
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
      if (hasInstance) setLayout((current) => ({ ...current, creationOpen: true }));
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('[data-testid="gen-panel"] textarea')?.focus();
      }, 220);
    };
    window.addEventListener('3dstd:open-ai', openAi);
    return () => window.removeEventListener('3dstd:open-ai', openAi);
  }, [hasInstance]);

  const patchLayout = (patch: Partial<WorkspaceLayout>) => setLayout((current) => ({ ...current, ...patch }));
  const openCheck = () => patchLayout({ inspectorOpen: true, inspectorTab: 'check' });
  const openSplitWorkbench = () => {
    patchLayout({ inspectorOpen: true, inspectorTab: 'properties', creationOpen: false });
    if (manualPlaneSplitIsActive()) {
      const isSurface = useManualPlaneSplit.getState().cutKind === 'surface';
      useUi.getState().setToast(isSurface
        ? '绘制面组已打开：左键连续涂画，Ctrl+左键擦除，右键旋转视角'
        : '平面切割工具已打开：移动请直接拖动画布 XYZ 手柄');
      return;
    }
    const targets = expandToInstances(doc.selection);
    if (targets.length === 0) {
      useUi.getState().setToast('先在画布或场景树选中 1 个未锁定对象，再点击「拆件」');
      return;
    }
    if (targets.length > 1) {
      useUi.getState().setToast(`当前选中了 ${targets.length} 个对象；拆件工具一次只处理 1 个对象`);
      return;
    }
    if (!startManualPlaneSplit(targets[0].id, 'surface')) {
      useUi.getState().setToast('该对象无法开始拆件，请确认模型几何可读取且对象未锁定');
      return;
    }
    useUi.getState().setToast('绘制面组已开启：左键涂出要拆下的部分；Ctrl+左键擦除，右侧可切换平面切割');
  };
  const openAutoSplitWorkbench = () => {
    patchLayout({ inspectorOpen: true, inspectorTab: 'properties', creationOpen: false });
    if (autoSplitIsActive()) return;
    if (manualPlaneSplitIsActive()) {
      useUi.getState().setToast('请先退出当前手动拆件，再启动自动拆件');
      return;
    }
    const targets = expandToInstances(doc.selection);
    if (targets.length !== 1) {
      useUi.getState().setToast(targets.length === 0
        ? '先选中 1 个未锁定对象，再点击「自动拆件」'
        : `自动拆件一次只处理 1 个对象；当前选中 ${targets.length} 个`);
      return;
    }
    if (!startAutoSplit(targets[0].id)) {
      useUi.getState().setToast('该对象无法启动自动拆件，请确认几何可读取且对象未锁定');
      return;
    }
    useUi.getState().setToast('自动拆件已准备：选择粒度并确认上传后开始');
  };
  const toggleCreation = () => {
    if (!hasInstance) {
      document.querySelector<HTMLTextAreaElement>('[data-testid="gen-panel"] textarea')?.focus();
      return;
    }
    patchLayout({ creationOpen: !layout.creationOpen });
  };
  const creationVisible = !hasInstance || layout.creationOpen;

  return (
    <div
      className="app-shell"
      data-left-open={layout.leftOpen}
      data-inspector-open={layout.inspectorOpen}
      data-creation-open={creationVisible}
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
            className={`app-icon-button${creationVisible ? ' is-active' : ''}`}
            onClick={toggleCreation}
            title={hasInstance && layout.creationOpen ? '关闭 AI 创作' : '打开 AI 创作'}
            aria-label={hasInstance && layout.creationOpen ? '关闭 AI 创作' : '打开 AI 创作'}
          >
            ✦
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

      <aside className="workspace-panel workspace-panel--left" aria-label="场景与资产">
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
        <Viewport onOpenSplit={openSplitWorkbench} onOpenAutoSplit={openAutoSplitWorkbench} />
        {creationVisible && (
          <CreationPanel
            dismissible={hasInstance}
            onClose={() => patchLayout({ creationOpen: false })}
          />
        )}
      </main>

      <aside className="workspace-panel workspace-panel--inspector" aria-label="属性、打印检查与历史">
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
        ) : <CollapsedRail label="属性、检查与历史" onOpen={() => patchLayout({ inspectorOpen: true })} />}
      </aside>

      <ToastLayer />
      <ExportDialog />
    </div>
  );
}
