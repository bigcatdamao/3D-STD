import { useEffect, useState } from 'react';
import { CreationAgentPanel } from './agent/CreationAgentPanel';
import { GenPanel } from './ai/GenPanel';
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
  bootstrapConnectorQaScene,
  bootstrapDemoScene,
  bootstrapHunyuanAutoSplitQaScene,
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
import { ConnectorPanel } from './connector/ConnectorPanel';
import {
  applyConnector,
  chooseConnectorCandidate,
  connectorIsActive,
  generateConnectorPreview,
  startConnector,
  useConnector,
} from './connector/connector-state';

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
  const autoSplitProvider = useAutoSplit((state) => state.sourceProvider);
  const connectorPhase = useConnector((state) => state.phase);
  if (connectorPhase !== 'idle') {
    return (
      <div className="inspector-shell">
        <div className="inspector-tabs" role="tablist" aria-label="连接工具">
          <button className="inspector-tab is-active" role="tab" aria-selected="true">添加连接</button>
          <span className="inspector-mode-note">圆柱插销</span>
        </div>
        <div className="inspector-content"><ConnectorPanel /></div>
      </div>
    );
  }
  if (autoSplitPhase !== 'idle') {
    return (
      <div className="inspector-shell">
        <div className="inspector-tabs" role="tablist" aria-label="自动拆件">
          <button className="inspector-tab is-active" role="tab" aria-selected="true">自动拆件</button>
          <span className="inspector-mode-note">{autoSplitProvider === 'hunyuan' ? '混元' : 'Hi3D'}</span>
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

type CreationRoute = 'agent' | 'image';

export function CreationPanel({
  dismissible,
  onClose,
  initialRoute = 'agent',
}: {
  dismissible: boolean;
  onClose: () => void;
  initialRoute?: CreationRoute;
}) {
  const [route, setRoute] = useState<CreationRoute>(initialRoute);
  const openExample = () => {
    if (bootstrapDemoScene()) {
      onClose();
      useUi.getState().setToast('示例场景已打开：可直接体验编辑、打印检查与导出');
      window.setTimeout(() => sendCam({ kind: 'home' }), 0);
    }
  };

  return (
    <div className="creation-overlay">
      <section className="creation-panel creation-panel--agent" aria-label="3D 创作 Agent 工作台">
        <header className="creation-panel__header">
          <div>
            <div className="creation-panel__eyebrow">3D 创作工作台 · M1.17a.2</div>
            <h2>{route === 'agent' ? '从想法与参考图，推进到可打印模型' : '已有图片，直接生成 3D 模型'}</h2>
            <p>{route === 'agent'
              ? 'Agent 帮你澄清需求、生成效果图，再把已确认图片提交给混元 3D。'
              : '跳过需求对话和效果图生成，上传现有效果图或多视图，直接提交混元 3D。'}</p>
          </div>
          <div className="creation-panel__header-actions">
            <ImportButton target="viewport" label="导入本地模型" className="creation-panel__secondary" />
            <button className="creation-panel__tertiary" onClick={openExample}>打开示例场景</button>
            {dismissible && (
            <button className="creation-panel__close" onClick={onClose} aria-label="关闭 AI 创作面板" title="关闭">
              ×
            </button>
            )}
          </div>
        </header>
        <div className="creation-panel__workspace">
          <nav className="creation-panel__routes" role="tablist" aria-label="3D 创作起点">
            <button
              type="button"
              role="tab"
              aria-selected={route === 'agent'}
              className={route === 'agent' ? 'is-active' : ''}
              onClick={() => setRoute('agent')}
            >
              <span><strong>✦ 3D 创作 Agent</strong><small>从模糊想法开始</small></span>
              <small>对话规划 → 效果图 → 3D</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={route === 'image'}
              className={route === 'image' ? 'is-active' : ''}
              onClick={() => setRoute('image')}
            >
              <span><strong>▧ 已有图片成模</strong><small>跳过 Agent 与生图</small></span>
              <small>单图 / 多视图 → 3D</small>
            </button>
          </nav>
          {route === 'agent' ? (
            <CreationAgentPanel onComplete={onClose} />
          ) : (
            <section className="creation-direct" aria-label="已有图片直接成模">
              <aside className="creation-direct__guide">
                <span className="creation-direct__badge">快速路径</span>
                <h3>用已经确认的图片直接成模</h3>
                <p>适合已经有角色效果图、产品图或三视图的用户，不再重复进行需求问答与视觉生成。</p>
                <ol>
                  <li><b>1</b><span><strong>添加主体图片</strong><small>正面清晰、主体完整、背景简洁</small></span></li>
                  <li><b>2</b><span><strong>可选补充左右视图</strong><small>同一对象、角度一致，提升结构稳定性</small></span></li>
                  <li><b>3</b><span><strong>确认后提交混元 3D</strong><small>生成完成后接受模型，自动进入场景</small></span></li>
                </ol>
                <div className="creation-direct__boundary">
                  <strong>生成后还能做什么？</strong>
                  <span>编辑摆盘 → 混元自动拆件 → 榫卯连接 → 打印检查 → STL 导出</span>
                </div>
              </aside>
              <div className="creation-model-stage creation-direct__stage">
                <header>
                  <div>
                    <strong>提交图片生成 3D</strong>
                    <span>选择单图或多图；付费任务只有点击“生成模型”后才会提交。</span>
                  </div>
                </header>
                <GenPanel allowedTypes={['image', 'multiview']} onAccepted={onClose} />
              </div>
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function initialLayout(): WorkspaceLayout {
  if (typeof window === 'undefined') return { ...DEFAULT_WORKSPACE_LAYOUT };
  const saved = window.localStorage.getItem(WORKSPACE_LAYOUT_KEY);
  return saved ? parseWorkspaceLayout(saved) : defaultWorkspaceLayoutForWidth(window.innerWidth);
}

function initialCreationRoute(): CreationRoute {
  if (typeof window === 'undefined') return 'agent';
  return new URLSearchParams(window.location.search).get('qa') === 'image-to-3d' ? 'image' : 'agent';
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
    const connectorQa = qa === 'connector' || qa?.startsWith('connector-');
    const bootstrapped = qa === 'self-intersection'
      ? bootstrapSelfIntersectionQaScene()
      : qa === 'component-preview'
        ? bootstrapComponentPreviewQaScene()
        : qa === 'hunyuan-auto-split'
          ? bootstrapHunyuanAutoSplitQaScene()
        : qa === 'plane-cut-preview'
          ? bootstrapPlaneCutPreviewQaScene()
          : qa === 'surface-cut-preview' || qa === 'manual-split-entry' || qa === 'manual-surface-cut'
            ? bootstrapSurfaceCutPreviewQaScene()
            : connectorQa
              ? bootstrapConnectorQaScene()
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
      if (qa === 'hunyuan-auto-split') {
        const instance = [...doc.nodes.values()].find((node) => node.kind === 'instance');
        if (instance?.kind === 'instance') {
          dispatch((scene) => scene.select([instance.id]));
          startAutoSplit(instance.id);
          setLayout((current) => ({
            ...current,
            inspectorOpen: true,
            inspectorTab: 'properties',
            creationOpen: false,
          }));
        }
        return;
      }
      if (connectorQa) {
        const instance = doc.nodes.get('ins_qa_connector_a');
        if (instance?.kind === 'instance') {
          dispatch((scene) => scene.select([instance.id]));
          setLayout((current) => ({
            ...current,
            inspectorOpen: true,
            inspectorTab: 'properties',
            creationOpen: false,
          }));
          sendCam({ kind: 'home' });
          if (qa === 'connector-entry') return;
          startConnector(instance.id);
          if (qa === 'connector-configure' || qa === 'connector-preview' || qa === 'connector-result') {
            chooseConnectorCandidate({
              instanceId: 'ins_qa_connector_a',
              point: [-4, 0, 22],
              normal: [1, 0, 0],
              faceIndex: 0,
              faceAreaMm2: 1936,
              estimatedDepthMm: 44,
              recommendedMaxDiameterMm: 12.3,
              rating: 'good',
              message: '两侧接缝已对齐，可进入尺寸设置',
            });
            chooseConnectorCandidate({
              instanceId: 'ins_qa_connector_b',
              point: [4, 0, 22],
              normal: [-1, 0, 0],
              faceIndex: 0,
              faceAreaMm2: 1936,
              estimatedDepthMm: 44,
              recommendedMaxDiameterMm: 12.3,
              rating: 'good',
              message: '两侧接缝相距 8.0 mm；预览时请确认插销与圆孔同轴',
            });
            if (qa === 'connector-preview' || qa === 'connector-result') {
              void generateConnectorPreview().then((ready) => {
                if (ready && qa === 'connector-result') applyConnector();
              });
            }
          }
        }
        return;
      }
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
    if (connectorIsActive()) {
      useUi.getState().setToast('请先退出当前连接工具，再启动手动拆件。');
      return;
    }
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
    if (connectorIsActive()) {
      useUi.getState().setToast('请先退出当前连接工具，再启动自动拆件。');
      return;
    }
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
      return;
    }
    useUi.getState().setToast('混元组件生成已准备：确认费用后开始自动拆件');
  };
  const openConnectorWorkbench = () => {
    patchLayout({ inspectorOpen: true, inspectorTab: 'properties', creationOpen: false });
    if (connectorIsActive()) return;
    if (manualPlaneSplitIsActive() || autoSplitIsActive()) {
      useUi.getState().setToast('请先退出当前拆件工具，再添加零件连接');
      return;
    }
    const targets = expandToInstances(doc.selection);
    if (targets.length !== 1) {
      useUi.getState().setToast(targets.length === 0
        ? '先选中第一个零件，“添加连接”按钮才会亮起'
        : `连接定位从一个零件开始；当前选中 ${targets.length} 个对象`);
      return;
    }
    if (!startConnector(targets[0].id)) return;
    useUi.getState().setToast('连接工具已开启：先在所选零件表面点击第一个连接中心');
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
      data-creation-workspace={creationVisible}
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
            className={`app-icon-button app-workspace-toggle${layout.leftOpen ? ' is-active' : ''}`}
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
            className={`app-icon-button app-workspace-toggle${layout.inspectorOpen ? ' is-active' : ''}`}
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
        <Viewport
          onOpenSplit={openSplitWorkbench}
          onOpenAutoSplit={openAutoSplitWorkbench}
          onOpenConnector={openConnectorWorkbench}
        />
        {creationVisible && (
          <CreationPanel
            dismissible={hasInstance}
            onClose={() => patchLayout({ creationOpen: false })}
            initialRoute={initialCreationRoute()}
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
