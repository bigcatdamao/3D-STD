import { doc } from '../state/store';
import type { Vec3 } from '../kernel/types';
import {
  cancelManualPlaneSplit,
  confirmManualPlaneSplit,
  manualPlaneSplitIsStale,
  setManualPlaneAxis,
  setManualPlaneMode,
  setManualPlanePosition,
  setManualPlaneRotation,
  setManualPlaneSize,
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
  const padding = Math.max(diagonal * 0.35, 20);
  const sizeMax = Math.max(diagonal * 3, 100);
  const running = state.phase === 'running';

  const setPositionAxis = (axis: number, value: number) => {
    const position = [...state.position] as Vec3;
    position[axis] = value;
    setManualPlanePosition(position);
  };
  const setRotationAxis = (axis: number, value: number) => {
    const rotation = [...state.rotation] as Vec3;
    rotation[axis] = value;
    setManualPlaneRotation(rotation);
  };

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

      <details open>
        <summary>位置 <small>mm</small></summary>
        <div className="manual-plane-panel__fields">
          {AXES.map((axis, index) => (
            <FieldRow
              key={axis}
              axis={axis}
              value={state.position[index]}
              min={bounds.min[index] - padding}
              max={bounds.max[index] + padding}
              step={0.5}
              unit="mm"
              onChange={(value) => setPositionAxis(index, value)}
            />
          ))}
        </div>
      </details>

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
        <summary>切割框大小 <small>显示范围</small></summary>
        <div className="manual-plane-panel__fields">
          <FieldRow
            axis="宽"
            value={state.size[0]}
            min={10}
            max={sizeMax}
            step={1}
            unit="mm"
            onChange={(value) => setManualPlaneSize([value, state.size[1]])}
          />
          <FieldRow
            axis="高"
            value={state.size[1]}
            min={10}
            max={sizeMax}
            step={1}
            unit="mm"
            onChange={(value) => setManualPlaneSize([state.size[0], value])}
          />
        </div>
        <p className="manual-plane-panel__scope">框大小只控制视口显示；实际切割按无限平面计算，避免模型边缘漏切。</p>
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
          {running ? '切割中…' : state.phase === 'error' ? '调整后重试' : '确认切割'}
        </button>
      </footer>
      <small className="manual-plane-panel__hint">视口：拖动三轴控件 · 右键旋转视角 · 中键平移 · Esc 取消切割</small>
    </section>
  );
}
