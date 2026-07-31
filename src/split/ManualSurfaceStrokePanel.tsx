import { doc } from '../state/store';
import {
  cancelManualPlaneSplit,
  clearManualSurfaceGuidePoints,
  confirmManualSurfaceSplit,
  manualPlaneSplitIsStale,
  previewManualSurfaceSplit,
  reopenManualSurfaceGuidePoints,
  returnManualSurfaceSplitToGuide,
  setManualSurfaceWorkflowMode,
  undoManualSurfaceStrokeSegment,
  useManualPlaneSplitSnapshot,
} from './manual-plane-split-state';
import { SURFACE_CUT_FACE_BUDGET } from './surface-cut-core';
import {
  surfaceStrokeClosureGap,
  surfaceStrokeLength,
} from './surface-stroke-core';
import { useSurfaceWorkflowSnapshot } from './surface-workflow-state';

export function SurfaceWorkflowSwitch() {
  const { mode } = useSurfaceWorkflowSnapshot();
  return (
    <div className="surface-workflow-switch" aria-label="曲面切割输入方式">
      <button
        type="button"
        aria-pressed={mode === 'stroke'}
        onClick={() => setManualSurfaceWorkflowMode('stroke')}
      >
        切割笔
        <small>推荐</small>
      </button>
      <button
        type="button"
        aria-pressed={mode === 'facePaint'}
        onClick={() => setManualSurfaceWorkflowMode('facePaint')}
      >
        面组实验
        <small>M1.11g</small>
      </button>
    </div>
  );
}

export function ManualSurfaceStrokePanel() {
  const state = useManualPlaneSplitSnapshot();
  const {
    mode,
    strokeSegmentEnds,
    strokeSegmentKinds,
  } = useSurfaceWorkflowSnapshot();
  if (state.cutKind !== 'surface' || mode !== 'stroke' || state.phase === 'idle') return null;
  const node = state.instanceId ? doc.nodes.get(state.instanceId) : null;
  const asset = state.sourceAssetId ? doc.assets.get(state.sourceAssetId) : null;
  const faceCount = asset?.meta.faces ?? 0;
  const highPoly = faceCount > SURFACE_CUT_FACE_BUDGET;
  const stale = manualPlaneSplitIsStale();
  const pointCount = state.surfaceGuidePoints.length;
  const strokeLength = surfaceStrokeLength(state.surfaceGuidePoints);
  const closureGap = surfaceStrokeClosureGap(state.surfaceGuidePoints);
  const segmentCount = strokeSegmentEnds.length;
  const clickCount = strokeSegmentKinds.filter((kind) => kind === 'click').length;
  const drawCount = strokeSegmentKinds.filter((kind) => kind === 'draw').length;
  const closed = state.surfaceGuideClosed;

  if (state.phase === 'previewing') {
    return (
      <section className="manual-plane-panel manual-surface-stroke-panel" data-testid="manual-surface-stroke-panel">
        <header>
          <div>
            <span className="manual-plane-panel__eyebrow">M1.12b · 多视角切割笔</span>
            <h3>正在生成真实 A/B</h3>
            <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
          </div>
          <em>计算中</em>
        </header>
        <div className="face-cut-working" role="status" aria-live="polite">
          <i />
          <div>
            <strong>{state.progress || '沿笔迹搜索闭环'}</strong>
            <span>源模型保持不变；只有预览通过并确认后才会创建两个零件。</span>
          </div>
        </div>
        <footer>
          <button type="button" onClick={returnManualSurfaceSplitToGuide}>停止并返回笔迹</button>
        </footer>
      </section>
    );
  }

  if (state.phase === 'previewReady' && state.surfaceResult) {
    const result = state.surfaceResult;
    return (
      <section
        className="manual-plane-panel manual-surface-stroke-panel manual-plane-panel--cut-review"
        data-testid="manual-surface-stroke-panel"
      >
        <header>
          <div>
            <span className="manual-plane-panel__eyebrow">M1.12b · 真实 A/B 预览</span>
            <h3>切割线已生成</h3>
            <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
          </div>
          <em>{state.durationMs?.toFixed(0) ?? '—'} ms</em>
        </header>

        <div className="face-seam-result is-ready">
          <strong>✓ 两侧已生成并自动封口</strong>
          <span>紫色为 A，绿色为 B，青色粗线是程序最终采用的真实接缝。</span>
        </div>
        <div className="face-seam-metrics" aria-label="切割笔真实结果">
          <span>
            <b>{result.metrics.boundaryVertices.toLocaleString()}</b>
            <small>接缝顶点</small>
          </span>
          <span>
            <b>{result.metrics.seamLengthMm.toFixed(1)}</b>
            <small>长度 mm</small>
          </span>
          <span>
            <b>{(result.metrics.capWarpRatio * 100).toFixed(1)}%</b>
            <small>封口扭曲</small>
          </span>
        </div>
        {result.warnings.length > 0 && (
          <div className="face-seam-messages is-warning">
            <strong>确认前请检查 {result.warnings.length} 项风险</strong>
            {result.warnings.map((warning) => <small key={warning}>{warning}</small>)}
          </div>
        )}
        <div className="manual-plane-panel__notice">
          <strong>此时仍未修改源模型</strong>
          <span>返回可重画；确认后创建 A/B 并写入一条可撤销历史。</span>
        </div>
        <footer>
          <button type="button" onClick={returnManualSurfaceSplitToGuide}>返回重画</button>
          <button
            className="primary"
            type="button"
            disabled={stale}
            onClick={confirmManualSurfaceSplit}
          >
            确认创建两个模型
          </button>
        </footer>
      </section>
    );
  }

  return (
    <section className="manual-plane-panel manual-surface-stroke-panel" data-testid="manual-surface-stroke-panel">
      <header>
        <div>
          <span className="manual-plane-panel__eyebrow">M1.12b · 多视角切割笔</span>
          <h3>画一段，转一下，继续画</h3>
          <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
        </div>
        <em>{closed ? '已闭合' : segmentCount ? `${segmentCount} 段` : '开放路径'}</em>
      </header>

      <SurfaceWorkflowSwitch />

      <div className="surface-stroke-instruction">
        <b>1</b>
        <span>
          <strong>单击放点，按住拖动自由画</strong>
          <small>松手只暂停，不会自动闭合。右键旋转到侧面或背面，再从青色末端继续；最后点击黄色起点闭合。</small>
        </span>
      </div>

      <div className={`surface-stroke-canvas-state${closed ? ' is-ready' : ''}`}>
        <strong>
          {closed
            ? '闭环已完成，可以生成预览'
            : pointCount
              ? `开放笔迹 · 已完成 ${segmentCount || 1} 段`
              : '等待在模型上放点或绘制'}
        </strong>
        <span>
          {closed
            ? `闭环 ${strokeLength.toFixed(1)} mm · ${pointCount} 个采样点`
            : pointCount
              ? `单击 ${clickCount} 段 · 自由绘制 ${drawCount} 段 · 首尾相距 ${closureGap.toFixed(1)} mm`
              : '右键旋转 · 中键平移 · 滚轮缩放 · 左键编辑切口'}
        </span>
      </div>

      {state.error && (
        <div className="manual-plane-panel__error" role="alert">
          <strong>这条笔迹暂时不能生成安全切口</strong>
          <span>{state.error}</span>
          <small>源模型与已画路径均保留，可继续补点、续画或撤销上一段。</small>
        </div>
      )}

      {highPoly && (
        <div className="surface-stroke-limit" role="status">
          <strong>本轮先验证绘制体验</strong>
          <span>
            当前模型 {faceCount.toLocaleString()} 面；第一版真实曲线内核预算为
            {' '}{SURFACE_CUT_FACE_BUDGET.toLocaleString()} 面。笔迹可以测试，但暂不伪装成已支持百万面切割。
          </span>
        </div>
      )}

      {pointCount > 0 && (
        <div className="manual-plane-panel__curve-actions">
          <button
            type="button"
            onClick={closed ? reopenManualSurfaceGuidePoints : undoManualSurfaceStrokeSegment}
          >
            {closed ? '继续编辑切口' : '撤销上一段'}
          </button>
          <button type="button" onClick={clearManualSurfaceGuidePoints}>全部清空</button>
        </div>
      )}

      <footer>
        <button type="button" onClick={cancelManualPlaneSplit}>退出切割笔</button>
        <button
          className="primary"
          type="button"
          disabled={stale || pointCount < 3 || !closed || highPoly}
          onClick={previewManualSurfaceSplit}
          title={
            highPoly
              ? '百万面局部曲线内核尚未接入'
              : !closed
                ? '请继续绘制并点击黄色起点闭合'
                : '生成临时 A/B 并验证双侧封口'
          }
        >
          {highPoly ? '高面数预览待接入' : closed ? '生成 A/B 预览' : '等待闭合切口'}
        </button>
      </footer>
      <small className="manual-plane-panel__hint">
        单击 = 钢笔锚点 · 拖动 = 自由绘制 · 点击黄色起点 = 闭合 · Esc 退出
      </small>
    </section>
  );
}
