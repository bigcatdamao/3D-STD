import { doc } from '../state/store';
import type { Vec3 } from '../kernel/types';
import {
  cancelManualPlaneSplit,
  confirmManualPlaneSplit,
  confirmManualSurfaceSplit,
  manualPlaneSplitIsStale,
  previewManualSurfaceSplit,
  returnManualSurfaceSplitToGuide,
  setManualPlaneAxis,
  setManualPlaneMode,
  setManualPlaneRotation,
  setManualPlaneSize,
  setManualPlaneSizeLinked,
  setManualSurfaceBandMm,
  setManualSurfacePreference,
  useManualPlaneSplitSnapshot,
  type ManualPlaneMode,
} from './manual-plane-split-state';

const AXES = ['X', 'Y', 'Z'] as const;

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
  const surfaceRangeMax = Math.max(10, Math.min(diagonal * 0.45, 200));
  const running = state.phase === 'running' || state.phase === 'previewing';
  const isSurface = state.cutKind === 'surface';
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
  const primaryText = isSurface
    ? state.phase === 'previewing'
      ? '正在生成表面闭环…'
      : state.phase === 'error'
        ? '调整定位后重新生成'
        : '生成表面闭合接缝'
    : state.phase === 'running'
      ? '切割中…'
      : state.phase === 'error'
        ? '调整后重试'
        : '确认切割';
  const runPrimary = () => {
    if (!isSurface) {
      confirmManualPlaneSplit();
    } else {
      previewManualSurfaceSplit();
    }
  };

  if (isSurface && state.phase === 'previewReady' && state.surfaceResult) {
    return (
      <section
        className="manual-plane-panel manual-plane-panel--surface-review"
        data-testid="manual-plane-split-panel"
      >
        <header>
          <div>
            <span className="manual-plane-panel__eyebrow">第 2 步 · 表面接缝</span>
            <h3>曲面接缝预览</h3>
            <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>
          </div>
          <em>2 / 2</em>
        </header>

        <div className="manual-plane-panel__notice">
          <strong>平面定位已经结束</strong>
          <span>画布黄色闭环才是实际切口。蓝色与紫色分别预览切割后的 A/B 两件。</span>
        </div>

        <div className="manual-plane-panel__surface-legend" aria-label="曲面切割预览图例">
          <span className="is-a"><i />A 件</span>
          <span className="is-seam"><i />表面闭合接缝</span>
          <span className="is-b"><i />B 件</span>
        </div>

        <div className="manual-plane-panel__surface-result" role="status">
          <strong>接缝与双侧封口验证通过</strong>
          <div>
            <span><b>{state.surfaceResult.metrics.boundaryVertices}</b> 个接缝点</span>
            <span><b>{state.surfaceResult.metrics.seamLengthMm.toFixed(1)}</b> mm 接缝长度</span>
            <span><b>{state.surfaceResult.metrics.maxCapDeviationMm.toFixed(2)}</b> mm 封口偏差</span>
            <span><b>{state.durationMs?.toFixed(0) ?? '—'}</b> ms 计算耗时</span>
          </div>
          <small>
            A/B 开放边：
            {state.surfaceResult.partA.boundaryEdges}/{state.surfaceResult.partB.boundaryEdges}
          </small>
        </div>

        <div className="manual-plane-panel__surface-boundary">
          <strong>当前可以做什么</strong>
          <span>接缝不合适：返回重新定位后再次生成。</span>
          <span>接缝合适：确认后生成两个独立对象，并可一步撤销。</span>
          <small>M1.10a 暂不提供接缝控制点；整圈沿面移动与局部弯曲将在下一阶段加入。</small>
        </div>

        {stale && (
          <div className="manual-plane-panel__error" role="alert">
            <strong>切割会话已失效</strong>
            <span>场景在预览期间发生变化，请取消后重新开始。</span>
          </div>
        )}

        <footer>
          <button
            type="button"
            disabled={stale}
            onClick={returnManualSurfaceSplitToGuide}
          >
            返回重新定位
          </button>
          <button
            className="primary"
            type="button"
            disabled={stale}
            onClick={confirmManualSurfaceSplit}
          >
            确认曲面切割
          </button>
        </footer>
        <small className="manual-plane-panel__hint">
          黄色闭环是实际切口 · 此阶段不再使用 W/E/R 平面手柄
        </small>
      </section>
    );
  }

  return (
    <section className="manual-plane-panel" data-testid="manual-plane-split-panel">
      <header>
        <div>
          <span className="manual-plane-panel__eyebrow">
            {isSurface ? '第 1 步 · 粗定位' : '真实几何操作'}
          </span>
          <h3>{isSurface ? '曲面切割定位' : '平面切割'}</h3>
          {!isSurface && <p title={node?.name}>{node?.name ?? '源对象已失效'}</p>}
        </div>
        <em>{isSurface ? '1 / 2' : '1 → 2'}</em>
      </header>

      {!isSurface && (
        <div className="manual-plane-panel__notice">
          <strong>源模型保持不变</strong>
          <span>确认后生成 A / B 两个独立派生模型，可在历史记录中一步撤销。</span>
        </div>
      )}

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

      {!isSurface && (
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
      )}

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
        <p className="manual-plane-panel__scope">{isSurface
          ? '框只表示起始位置与方向；生成后会隐藏，并切换为模型表面的真实闭环。'
          : '框大小只控制视口显示；实际切割按无限平面计算，避免模型边缘漏切。'}</p>
      </details>

      {running && (
        <div className="manual-plane-panel__running" role="status">
          <i />
          <div>
            <strong>{state.phase === 'previewing' ? '正在搜索曲面闭环' : '正在执行真实切割'}</strong>
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
          onClick={runPrimary}
        >
          {primaryText}
        </button>
      </footer>
      <small className="manual-plane-panel__hint">
        {isSurface
          ? '第 1 步：W/E/R 调整粗定位 · 生成后进入独立表面接缝预览'
          : '视口：W/E/R 切换手柄 · 拖动 XYZ · 右键旋转视角 · Esc 取消'}
      </small>

      {isSurface && (
        <details className="manual-plane-panel__surface-advanced">
          <summary>高级：自动寻缝范围 <small>通常无需修改</small></summary>
          <p>
            范围越宽，接缝越可能离开当前平面，沿附近收腰或折痕弯曲。
            这不是切口厚度，也不会删除材料。
          </p>
          <div className="manual-plane-panel__range-presets" aria-label="接缝搜索宽度预设">
            {([
              [5, '紧贴', '±5mm'],
              [15, '标准', '±15mm'],
              [30, '宽松', '±30mm'],
            ] as const).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                disabled={value > surfaceRangeMax}
                aria-pressed={Math.abs(state.surfaceBandMm - value) < 0.5}
                onClick={() => setManualSurfaceBandMm(value)}
                title={`${label}：${hint}`}
              >
                <strong>{label}</strong>
                <span>{hint}</span>
              </button>
            ))}
          </div>
          <div className="manual-plane-panel__preference-label">
            <strong>自动接缝偏好</strong>
            <span>不识别角色语义</span>
          </div>
          <div className="manual-plane-panel__preferences" aria-label="接缝偏好">
            {([
              ['balanced', '均衡', '兼顾距离、长度与折角'],
              ['shortest', '最短', '优先更短的闭环'],
              ['crease', '贴折痕', '更愿意沿明显转折边'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={state.surfacePreference === value}
                onClick={() => setManualSurfacePreference(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="manual-plane-panel__preference-help">
            {state.surfacePreference === 'shortest'
              ? '最短：更容易选中附近较细的闭环，但可能避开你想保留的造型线。'
              : state.surfacePreference === 'crease'
                ? '贴折痕：更愿意沿网格转折明显的位置走，适合装甲边或衣物折线。'
                : '均衡：同时考虑离引导面的距离、接缝长度和折角，建议第一次先用它。'}
          </p>
        </details>
      )}
    </section>
  );
}
