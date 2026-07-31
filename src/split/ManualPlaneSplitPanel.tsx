import * as THREE from 'three';
import { doc } from '../state/store';
import type { Vec3 } from '../kernel/types';
import {
  beginFacePaintSeamAnchorPlacement,
  cancelFacePaintSeamAnchorPlacement,
  clearFacePaintMask,
  clearFacePaintSeamAnchor,
  generateFacePaintSeamPreview,
  returnFacePaintToEditing,
  selectFacePaintSeamChoice,
  setFacePaintBrushRadius,
  setFacePaintMode,
  undoFacePaintStroke,
  useFacePaintSnapshot,
} from './face-paint-state';
import {
  cancelManualPlaneSplit,
  confirmManualPlaneSplit,
  confirmManualSurfaceSplit,
  manualPlaneSplitIsStale,
  previewFacePaintSurfaceSplit,
  returnFacePaintSurfaceSplitToSeam,
  setManualPlaneAxis,
  setManualPlaneMode,
  setManualPlaneRotation,
  setManualPlaneSize,
  setManualPlaneSizeLinked,
  useManualPlaneSplitSnapshot,
  type ManualPlaneMode,
} from './manual-plane-split-state';
import {
  ManualSurfaceStrokePanel,
  SurfaceWorkflowSwitch,
} from './ManualSurfaceStrokePanel';
import { useSurfaceWorkflowSnapshot } from './surface-workflow-state';

const AXES = ['X', 'Y', 'Z'] as const;

function matrixOfTransform(transform: {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
} | undefined): THREE.Matrix4 {
  if (!transform) return new THREE.Matrix4();
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(transform.rotation[0]),
    THREE.MathUtils.degToRad(transform.rotation[1]),
    THREE.MathUtils.degToRad(transform.rotation[2]),
    'XYZ',
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(...transform.scale),
  );
}

function FieldRow({
  axis,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  axis: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="manual-plane-panel__field">
      <span>{axis}</span>
      <input
        aria-label={`${axis} ${unit}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.max(min, Math.min(max, value))}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <label>
        <input
          type="number"
          step={step}
          value={Number(value.toFixed(step < 1 ? 2 : 1))}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        <small>{unit}</small>
      </label>
    </div>
  );
}

function ModeButton({
  mode,
  active,
  shortcut,
  children,
}: {
  mode: ManualPlaneMode;
  active: boolean;
  shortcut: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => setManualPlaneMode(mode)}
      title={`${shortcut} 快捷键`}
    >
      {children}<kbd>{shortcut}</kbd>
    </button>
  );
}

export function ManualPlaneSplitPanel() {
  const state = useManualPlaneSplitSnapshot();
  const paint = useFacePaintSnapshot();
  const surfaceWorkflowMode = useSurfaceWorkflowSnapshot().mode;
  if (state.phase === 'idle') return null;
  const node = state.instanceId ? doc.nodes.get(state.instanceId) : null;
  const stale = manualPlaneSplitIsStale();
  const bounds = state.bounds ?? { min: [-100, -100, -100] as Vec3, max: [100, 100, 100] as Vec3 };
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  const sizeMax = Math.max(diagonal * 3, 100);
  const running = state.phase === 'running' || state.phase === 'previewing';
  const isSurface = state.cutKind === 'surface';

  if (isSurface && surfaceWorkflowMode === 'stroke') {
    return <ManualSurfaceStrokePanel />;
  }

  if (isSurface) {
    const brushMax = Math.max(8, Math.min(diagonal * 0.28, 160));
    const brushValue = Math.max(0.5, Math.min(brushMax, paint.brushRadiusMm));
    const paintedPercent = paint.totalFaceCount > 0
      ? Math.round((paint.paintedFaceCount / paint.totalFaceCount) * 100)
      : 0;
    const instanceTransform = node?.kind === 'instance' ? node.transform : undefined;
    const seamChoices = paint.seamChoices ?? [];
    const generateSeam = () => {
      generateFacePaintSeamPreview(matrixOfTransform(instanceTransform));
    };

    if (state.phase === 'previewing') {
      return (
        <section
          className="manual-plane-panel manual-plane-panel--face-paint manual-plane-panel--seam-review"
          data-testid="manual-plane-split-panel"
        >
          <header>
            <div>
              <span className="manual-plane-panel__eyebrow">M1.11c · 真实几何</span>
              <h3>正在生成 A/B 预览</h3>
              <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
            </div>
            <em>计算中</em>
          </header>
          <div className="face-cut-working" role="status" aria-live="polite">
            <i />
            <div>
              <strong>{state.progress || '构建封闭零件'}</strong>
              <span>正在复制源网格、沿绿色闭环拆分，并为两侧生成同一组封口。</span>
            </div>
          </div>
          <div className="manual-plane-panel__notice">
            <strong>源模型仍未修改</strong>
            <span>只有确认真实 A/B 预览后，才会写入一条可撤销历史。</span>
          </div>
          <footer>
            <button type="button" onClick={returnFacePaintSurfaceSplitToSeam}>停止并返回接缝</button>
          </footer>
        </section>
      );
    }

    if (state.phase === 'previewReady' && state.surfaceResult) {
      const result = state.surfaceResult;
      const dimensions = (value: Vec3) => value.map((item) => item.toFixed(1)).join(' × ');
      return (
        <section
          className="manual-plane-panel manual-plane-panel--face-paint manual-plane-panel--cut-review"
          data-testid="manual-plane-split-panel"
        >
          <header>
            <div>
              <span className="manual-plane-panel__eyebrow">M1.11c · 确认前预览</span>
              <h3>真实 A/B 已生成</h3>
              <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
            </div>
            <em>{state.durationMs?.toFixed(0) ?? '—'} ms</em>
          </header>

          <div className="face-seam-result is-ready" role="status">
            <strong>✓ 两个零件均已封闭</strong>
            <span>视口中紫色是拆下件 A，绿色是保留件 B，青色线是两侧共享的封口边界。</span>
          </div>

          <div className="face-cut-parts" aria-label="真实切割零件">
            <div className="part-a">
              <strong><i />拆下件 A · 紫色</strong>
              <span>{result.partA.sourceFaceCount.toLocaleString()} 原始面 + {result.partA.capFaceCount.toLocaleString()} 封口面</span>
              <small>{dimensions(result.partA.dimensionsMm)} mm · 开放边 {result.partA.boundaryEdges}</small>
            </div>
            <div className="part-b">
              <strong><i />保留件 B · 绿色</strong>
              <span>{result.partB.sourceFaceCount.toLocaleString()} 原始面 + {result.partB.capFaceCount.toLocaleString()} 封口面</span>
              <small>{dimensions(result.partB.dimensionsMm)} mm · 开放边 {result.partB.boundaryEdges}</small>
            </div>
          </div>

          <div className="face-seam-metrics" aria-label="真实切割指标">
            <span>
              <b>{result.metrics.boundaryVertices.toLocaleString()}</b>
              <small>接缝顶点</small>
            </span>
            <span>
              <b>{result.metrics.maxCapDeviationMm.toFixed(2)}</b>
              <small>封口偏差 mm</small>
            </span>
            <span>
              <b>{(result.metrics.capWarpRatio * 100).toFixed(1)}%</b>
              <small>封口扭曲比</small>
            </span>
          </div>

          <div className="manual-plane-panel__notice">
            <strong>确认前源模型仍保留</strong>
            <span>确认后才用 A/B 替换当前实例，并写入一条历史；撤销会恢复原实例。</span>
          </div>

          <footer>
            <button type="button" onClick={returnFacePaintSurfaceSplitToSeam}>返回接缝</button>
            <button
              className="primary"
              type="button"
              disabled={stale}
              onClick={confirmManualSurfaceSplit}
            >
              确认创建两个模型
            </button>
          </footer>
          <small className="manual-plane-panel__hint">
            紫色＝拆下件 · 绿色＝保留件 · 此时仍可安全返回
          </small>
        </section>
      );
    }

    if (paint.seamStatus === 'ready' && paint.seamResult) {
      const { metrics, warnings } = paint.seamResult;
      const completion = paint.completionSummary;
      const shellOnly = completion?.splitMode === 'shells';
      const hybrid = completion?.splitMode === 'hybrid';
      return (
        <section
          className="manual-plane-panel manual-plane-panel--face-paint manual-plane-panel--seam-review"
          data-testid="manual-plane-split-panel"
        >
          <header>
            <div>
              <span className="manual-plane-panel__eyebrow">M1.11g · 锚点候选拆件</span>
              <h3>{shellOnly ? '独立壳体预览' : '接缝预览'}</h3>
              <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
            </div>
            <em>
              {shellOnly
                ? `${completion?.selectedShellCount ?? 0} 个壳体`
                : hybrid
                  ? `${completion?.selectedShellCount ?? 0} 壳体 + 1 接缝`
                  : `${Math.max(1, seamChoices.length)} 个候选`}
            </em>
          </header>

          <div className="face-seam-result is-ready" role="status">
            <strong>
              {shellOnly
                ? '✓ 无需切割即可拆件'
                : hybrid
                  ? '✓ 完整壳体与关节接缝已合并'
                  : '✓ 接缝拓扑通过'}
            </strong>
            <span>
              {shellOnly
                ? `已识别 ${completion?.selectedShellCount ?? 0} 个与主体分离的完整壳体；确认后只做 A/B 分组，不新增切口或封口。`
                : hybrid
                  ? `${completion?.selectedShellCount ?? 0} 个完整壳体直接归入拆下件，只在仍连接主体的壳体上沿绿色闭环切割。`
                  : '绿色粗线是当前候选接缝。可切换方案比较位置，再生成真实 A/B。'}
            </span>
          </div>

          {completion && (
            <div className="face-seam-result is-clean" role="status">
              <strong>
                {shellOnly
                  ? `已从 ${completion.sourceShellCount} 个源壳体中选出 ${completion.selectedShellCount} 个完整壳体`
                  : hybrid
                    ? `完整壳体直接分组，桥接壳体生长 ${completion.growthRings} 层并选择关节环`
                    : completion.searchMode === 'seed_growth'
                      ? `已向隐藏面生长 ${completion.growthRings} 层并选择关节环`
                      : `已从 ${completion.candidateCount} 个候选中选择主接缝`}
              </strong>
              <span>
                粗涂 {completion.roughFaces.toLocaleString()} 面 →
                自动补全 {completion.completedFaces.toLocaleString()} 面 ·
                新增隐藏面 {completion.addedFaces.toLocaleString()} ·
                匹配度 {completion.matchPercent}%
                {completion.anchorDistanceMm !== undefined
                  ? ` · 距定位点 ${completion.anchorDistanceMm.toFixed(1)} mm`
                  : ''}
              </span>
            </div>
          )}

          {!shellOnly && seamChoices.length > 1 && (
            <div className="face-seam-candidates" aria-label="候选接缝方案">
              <div>
                <strong>选择接缝方案</strong>
                <span>绿色闭环会立即切换；优先选最贴近关节根部的一条。</span>
              </div>
              <nav>
                {seamChoices.slice(0, 3).map((choice, index) => (
                  <button
                    type="button"
                    key={`${index}-${choice.completion.seamEdges}`}
                    aria-pressed={paint.seamChoiceIndex === index}
                    onClick={() => selectFacePaintSeamChoice(index)}
                  >
                    <b>方案 {index + 1}</b>
                    <small>
                      {choice.completion.anchorDistanceMm !== undefined
                        ? `距定位点 ${choice.completion.anchorDistanceMm.toFixed(1)} mm`
                        : `拆下 ${(choice.result.metrics.paintedRatio * 100).toFixed(1)}%`}
                    </small>
                  </button>
                ))}
              </nav>
            </div>
          )}

          {shellOnly && completion ? (
            <div className="face-seam-metrics" aria-label="壳体分组指标">
              <span>
                <b>{completion.sourceShellCount.toLocaleString()}</b>
                <small>源壳体</small>
              </span>
              <span>
                <b>{completion.selectedShellCount.toLocaleString()}</b>
                <small>拆下壳体</small>
              </span>
              <span>
                <b>{completion.fullShellFaces.toLocaleString()}</b>
                <small>完整面数</small>
              </span>
            </div>
          ) : (
            <div className="face-seam-metrics" aria-label="接缝指标">
              <span>
                <b>{metrics.boundaryVertices.toLocaleString()}</b>
                <small>接缝顶点</small>
              </span>
              <span>
                <b>{metrics.seamLengthMm.toFixed(1)}</b>
                <small>长度 mm</small>
              </span>
              <span>
                <b>{metrics.maxPlanarityDeviationMm.toFixed(2)}</b>
                <small>平面偏差 mm</small>
              </span>
            </div>
          )}

          <div className="face-seam-split-ratio">
            <div>
              <strong>拆下件（紫）/ 保留件（绿）</strong>
              <output>
                {(metrics.paintedRatio * 100).toFixed(1)}% / {((1 - metrics.paintedRatio) * 100).toFixed(1)}%
              </output>
            </div>
            <span>
              <i style={{ width: `${Math.max(2, Math.min(98, metrics.paintedRatio * 100))}%` }} />
            </span>
          </div>

          {warnings.length > 0 ? (
            <div className="face-seam-messages is-warning" role="status">
              <strong>切割前仍需处理 {warnings.length} 项风险</strong>
              {warnings.map((warning) => (
                <span key={warning.code}>
                  <b>{warning.title}</b>
                  <small>{warning.detail}</small>
                </span>
              ))}
            </div>
          ) : (
            <div className="face-seam-result is-clean">
              <strong>{shellOnly ? '未新增几何切口' : '未发现明显封口与小件风险'}</strong>
              <span>
                {shellOnly
                  ? '确认前仍会验证 A/B 两组都非空；源模型其余拓扑风险由打印检查继续负责。'
                  : '执行前仍会再次检查真实切割结果。'}
              </span>
            </div>
          )}

          <div className="manual-plane-panel__notice">
            <strong>此时没有修改模型</strong>
            <span>没有创建 A / B、没有写入历史记录，也没有覆盖原始模型。</span>
          </div>

          {state.phase === 'error' && state.error ? (
            <div className="manual-plane-panel__error" role="alert">
              <strong>真实 A/B 预览未生成</strong>
              <span>{state.error}</span>
              <small>接缝和面组仍保留，可直接重试或返回修改。</small>
            </div>
          ) : null}

          <footer>
            <button type="button" onClick={returnFacePaintToEditing}>返回修改面组</button>
            <button
              className="primary"
              type="button"
              disabled={stale}
              onClick={previewFacePaintSurfaceSplit}
              title="先生成临时 A/B 并检查封口，不修改源模型"
            >
              生成真实 A/B 预览
            </button>
          </footer>
          <small className="manual-plane-panel__hint">
            {shellOnly ? '只读壳体分组' : '只读预览'} · 右键旋转 · 中键平移 · 滚轮缩放 · Esc 退出
          </small>
        </section>
      );
    }

    return (
      <section
        className="manual-plane-panel manual-plane-panel--face-paint"
        data-testid="manual-plane-split-panel"
      >
        <header>
          <div>
            <span className="manual-plane-panel__eyebrow">M1.11g · 锚点候选拆件</span>
            <h3>涂出要拆下的部分</h3>
            <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
          </div>
          <em>{paintedPercent}%</em>
        </header>

        <SurfaceWorkflowSwitch />

        <div className="manual-plane-panel__paint-notice">
          <strong>像涂画一样定义一个面组</strong>
          <span>左键连续涂紫色面组；按住 Ctrl 可临时擦除。右键旋转、滚轮缩放不受影响。</span>
        </div>

        <div className="manual-plane-panel__paint-modes" aria-label="面组画笔模式">
          <button
            type="button"
            aria-pressed={paint.mode === 'add'}
            onClick={() => setFacePaintMode('add')}
          >
            <i className="is-add" />
            添加到面组
            <kbd>B</kbd>
          </button>
          <button
            type="button"
            aria-pressed={paint.mode === 'erase'}
            onClick={() => setFacePaintMode('erase')}
          >
            <i className="is-erase" />
            擦除
            <kbd>X</kbd>
          </button>
        </div>

        <div className="manual-plane-panel__brush">
          <div>
            <strong>画笔大小</strong>
            <output>{brushValue.toFixed(1)} mm</output>
          </div>
          <input
            aria-label="画笔大小 mm"
            type="range"
            min={0.5}
            max={brushMax}
            step={0.5}
            value={brushValue}
            onChange={(event) => setFacePaintBrushRadius(Number(event.target.value))}
          />
          <small>[ / ] 调整</small>
        </div>

        <div className="manual-plane-panel__paint-stats" role="status">
          <span>
            <b>{paint.totalFaceCount.toLocaleString()}</b>
            <small>模型总面</small>
          </span>
          <span>
            <b>{paint.paintedFaceCount.toLocaleString()}</b>
            <small>已涂面</small>
          </span>
          <span>
            <b>{paint.boundaryStatus === 'budget' ? '待分析' : paint.boundarySegmentCount.toLocaleString()}</b>
            <small>{paint.boundaryStatus === 'budget' ? '局部接缝' : '边界线段'}</small>
          </span>
        </div>

        <div className="manual-plane-panel__paint-actions">
          <button
            type="button"
            disabled={paint.strokeCount === 0}
            onClick={undoFacePaintStroke}
          >
            撤销上一笔 <kbd>Ctrl Z</kbd>
          </button>
          <button
            type="button"
            disabled={paint.paintedFaceCount === 0}
            onClick={clearFacePaintMask}
          >
            清空面组
          </button>
        </div>

        {paint.boundaryStatus === 'budget' && (
          <div className="manual-plane-panel__paint-performance" role="status">
            <strong>高面数 · 多壳体关节模式</strong>
            <span>粗涂准备拆下的整个零件，再指定它与主体相连的关节位置。</span>
          </div>
        )}
        {paint.boundaryStatus === 'budget' && (
          <div
            className={`manual-plane-panel__paint-anchor${paint.seamAnchorLocal ? ' is-set' : ''}${paint.seamAnchorPlacement ? ' is-placing' : ''}`}
          >
            <div>
              <strong>第 2 步 · 指定切口位置</strong>
              <span>
                {paint.seamAnchorLocal
                  ? '青色定位点已设置，算法只在它附近搜索关节闭环。'
                  : '点击按钮，再在模型关节根部点一下；无需沿接缝描线。'}
              </span>
            </div>
            <nav>
              <button
                type="button"
                aria-pressed={paint.seamAnchorPlacement}
                onClick={() => {
                  if (paint.seamAnchorPlacement) cancelFacePaintSeamAnchorPlacement();
                  else beginFacePaintSeamAnchorPlacement();
                }}
              >
                {paint.seamAnchorPlacement
                  ? '取消定位'
                  : paint.seamAnchorLocal
                    ? '重新定位'
                    : '设置切口位置'}
              </button>
              {paint.seamAnchorLocal && (
                <button type="button" onClick={clearFacePaintSeamAnchor}>清除</button>
              )}
            </nav>
            {paint.seamAnchorPlacement && <small>现在点击模型上希望断开的关节位置</small>}
          </div>
        )}
        {paint.seamStatus === 'running' && (
          <div className="face-cut-working" role="status" aria-live="polite">
            <i />
            <div>
              <strong>{paint.seamProgress || '正在分析局部接缝'}</strong>
              <span>模型保持不变；完成后才显示绿色闭环与风险结果。</span>
            </div>
          </div>
        )}
        {paint.seamError && (
          <div className="manual-plane-panel__error" role="alert">
            <strong>局部接缝分析未完成</strong>
            <span>{paint.seamError}</span>
          </div>
        )}
        {paint.seamStatus === 'invalid' && paint.seamResult && (
          <div className="face-seam-messages is-error" role="alert">
            <strong>暂时不能生成单闭环接缝</strong>
            {paint.seamResult.issues.map((issue) => (
              <span key={issue.code}>
                <b>{issue.title}</b>
                <small>{issue.detail}</small>
              </span>
            ))}
          </div>
        )}
        {stale && (
          <div className="manual-plane-panel__error" role="alert">
            <strong>面组会话已失效</strong>
            <span>场景在涂画期间发生变化，请退出后重新开始。</span>
          </div>
        )}

        <footer>
          <button type="button" onClick={cancelManualPlaneSplit}>退出面组</button>
          <button
            className="primary"
            type="button"
            disabled={
              stale
              || paint.paintedFaceCount === 0
              || paint.seamStatus === 'running'
              || (paint.boundaryStatus === 'budget' && !paint.seamAnchorLocal)
              || (paint.boundaryStatus === 'ready' && paint.boundarySegmentCount === 0)
            }
            title={paint.boundaryStatus === 'budget'
              ? paint.seamAnchorLocal
                ? '在青色定位点附近搜索最多三条候选关节闭环'
                : '请先在模型关节根部设置切口位置'
              : '把黄色边界排序为一条可检查的闭环'}
            onClick={generateSeam}
          >
            {paint.seamStatus === 'running'
              ? '正在分析…'
              : paint.boundaryStatus === 'budget'
                ? paint.seamAnchorLocal
                  ? '生成候选接缝'
                  : '先设置切口位置'
                : '生成接缝预览'}
          </button>
        </footer>

        <small className="manual-plane-panel__hint">
          先生成只读接缝并检查风险，不执行切割 · Esc 退出
        </small>
      </section>
    );
  }

  const setRotationAxis = (axis: number, value: number) => {
    const rotation = [...state.rotation] as Vec3;
    rotation[axis] = value;
    setManualPlaneRotation(rotation);
  };
  const setSizeAxis = (axis: 0 | 1, value: number) => {
    const next = [...state.size] as [number, number];
    if (!state.sizeLinked) {
      next[axis] = value;
    } else {
      const factor = value / Math.max(state.size[axis], 1e-9);
      next[0] = state.size[0] * factor;
      next[1] = state.size[1] * factor;
    }
    setManualPlaneSize(next);
  };
  const primaryText = state.phase === 'running'
    ? '切割中…'
    : state.phase === 'error'
      ? '调整后重试'
      : '确认切割';

  return (
    <section className="manual-plane-panel" data-testid="manual-plane-split-panel">
      <header>
        <div>
          <span className="manual-plane-panel__eyebrow">真实几何操作</span>
          <h3>平面切割</h3>
          <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
        </div>
        <em>1 → 2</em>
      </header>

      <div className="manual-plane-panel__notice">
        <strong>源模型保持不变</strong>
        <span>确认后生成 A / B 两个独立派生模型，可在历史记录中一步撤销。</span>
      </div>

      <div className="manual-plane-panel__axis" aria-label="切割轴预设">
        <span>切割轴</span>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <button
            key={axis}
            type="button"
            aria-pressed={state.axis === axis}
            onClick={() => setManualPlaneAxis(axis)}
          >
            {axis.toUpperCase()}
          </button>
        ))}
        <small>{state.axis === 'custom' ? '自定义角度' : `${state.axis.toUpperCase()} 轴法向`}</small>
      </div>

      <div className="manual-plane-panel__modes">
        <ModeButton mode="translate" active={state.mode === 'translate'} shortcut="W">移动</ModeButton>
        <ModeButton mode="rotate" active={state.mode === 'rotate'} shortcut="E">旋转</ModeButton>
        <ModeButton mode="scale" active={state.mode === 'scale'} shortcut="R">缩放</ModeButton>
      </div>

      <div className="manual-plane-panel__handle-help">
        <strong>按住画布箭头即可移动</strong>
        <span>按 W，把鼠标放到箭头上；光标变成手掌后按住拖动。箭头使用加大命中区，并始终显示在模型前方。</span>
        <div className="manual-plane-panel__axis-legend" aria-label="移动手柄颜色">
          <i className="is-x">X 左右</i>
          <i className="is-y">Y 前后</i>
          <i className="is-z">Z 上下</i>
        </div>
        <output>{state.position.map((value) => value.toFixed(1)).join(' / ')} mm</output>
      </div>

      <details open>
        <summary>旋转 <small>XYZ 欧拉角</small></summary>
        <div className="manual-plane-panel__fields">
          {AXES.map((axis, index) => (
            <FieldRow
              key={axis}
              axis={axis}
              value={state.rotation[index]}
              min={-180}
              max={180}
              step={1}
              unit="°"
              onChange={(value) => setRotationAxis(index, value)}
            />
          ))}
        </div>
      </details>

      <details open>
        <summary>
          切割框大小
          <button
            type="button"
            className="manual-plane-panel__link-size"
            aria-pressed={state.sizeLinked}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setManualPlaneSizeLinked(!state.sizeLinked);
            }}
          >
            {state.sizeLinked ? '🔗 宽高联动' : '⛓ 独立调整'}
          </button>
        </summary>
        <div className="manual-plane-panel__fields">
          <FieldRow
            axis="宽"
            value={state.size[0]}
            min={10}
            max={sizeMax}
            step={1}
            unit="mm"
            onChange={(value) => setSizeAxis(0, value)}
          />
          <FieldRow
            axis="高"
            value={state.size[1]}
            min={10}
            max={sizeMax}
            step={1}
            unit="mm"
            onChange={(value) => setSizeAxis(1, value)}
          />
        </div>
        <p className="manual-plane-panel__scope">
          框大小只控制视口显示；实际切割按无限平面计算，避免模型边缘漏切。
        </p>
      </details>

      {running && (
        <div className="manual-plane-panel__running" role="status">
          <i />
          <div>
            <strong>正在执行真实切割</strong>
            <span>{state.progress || '处理中…'}</span>
          </div>
        </div>
      )}
      {state.phase === 'error' && (
        <div className="manual-plane-panel__error" role="alert">
          <strong>未修改源模型</strong>
          <span>{state.error}</span>
          {state.errorCode && <small>错误码：{state.errorCode}</small>}
        </div>
      )}
      {stale && (
        <div className="manual-plane-panel__error" role="alert">
          <strong>切割会话已失效</strong>
          <span>场景在编辑期间发生变化，请取消后重新开始。</span>
        </div>
      )}

      <footer>
        <button type="button" disabled={running} onClick={cancelManualPlaneSplit}>取消</button>
        <button
          className="primary"
          type="button"
          disabled={running || stale}
          onClick={confirmManualPlaneSplit}
        >
          {primaryText}
        </button>
      </footer>
      <small className="manual-plane-panel__hint">
        视口：W/E/R 切换手柄 · 拖动 XYZ · 右键旋转视角 · Esc 取消
      </small>
    </section>
  );
}
