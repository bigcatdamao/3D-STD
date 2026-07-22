import { useUi } from '../state/store';
import {
  applyMeshRepair,
  cancelMeshRepairPreview,
  meshRepairPreviewIsStale,
  setMeshRepairPreviewMode,
  useMeshRepairSnapshot,
} from './mesh-repair-state';

const fmt = (value: number) => value.toLocaleString();

export function MeshRepairPanel() {
  useUi((state) => state.rev);
  const state = useMeshRepairSnapshot();
  if (state.phase === 'idle') return null;
  const stale = meshRepairPreviewIsStale();
  const after = state.stats?.after;

  return (
    <section className="mesh-repair-card" data-testid="mesh-repair-preview">
      <header>
        <div>
          <strong>网格修复预览</strong>
          <span>{state.sourceName || '当前模型'}</span>
        </div>
        <em>原模型不变</em>
      </header>

      {state.phase === 'preparing' && (
        <div className="mesh-repair-card__working">
          <i />
          <span>正在后台分析拓扑并验证修复结果…</span>
        </div>
      )}

      {state.phase !== 'preparing' && state.stats && (
        <div className="mesh-repair-card__metrics">
          <div><span>面片</span><b>{fmt(state.stats.before.faces)}</b><i>→</i><b>{fmt(after?.faces ?? state.stats.before.faces)}</b></div>
          <div><span>开放边</span><b>{fmt(state.stats.before.boundaryEdges)}</b><i>→</i><b>{fmt(after?.boundaryEdges ?? state.stats.before.boundaryEdges)}</b></div>
          <div><span>退化面</span><b>{fmt(state.stats.before.degenerateCount)}</b><i>→</i><b>{fmt(after?.degenerateCount ?? state.stats.before.degenerateCount)}</b></div>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          <div className="mesh-repair-card__view-switch" aria-label="修复差异显示方式">
            <button
              type="button"
              aria-pressed={state.previewMode === 'overlay'}
              onClick={() => setMeshRepairPreviewMode('overlay')}
            >
              修复后叠加
            </button>
            <button
              type="button"
              aria-pressed={state.previewMode === 'changes'}
              onClick={() => setMeshRepairPreviewMode('changes')}
            >
              仅看变化
            </button>
          </div>
          <div className="mesh-repair-card__legend">
            <span><i className="added" />绿色：新增面</span>
            <span><i className="removed" />红色：删除面</span>
          </div>
          <ul>{state.actions.map((action) => <li key={action}>✓ {action}</li>)}</ul>
          {state.warnings.map((warning) => <p className="mesh-repair-card__warning" key={warning}>⚠ {warning}</p>)}
          <p className="mesh-repair-card__scope">仅执行可验证的焊点、退化/重复面清理与简单平面封口；不自动重写非流形拓扑。</p>
        </>
      )}

      {(state.phase === 'unsupported' || state.phase === 'not_needed' || state.phase === 'failed') && (
        <p className="mesh-repair-card__blocked">{state.reason}</p>
      )}
      {stale && <p className="mesh-repair-card__blocked">场景已发生变化，本预览已失效，请取消后重新检查。</p>}

      <footer>
        <button type="button" onClick={cancelMeshRepairPreview}>取消预览</button>
        {state.phase === 'ready' && (
          <button type="button" className="primary" disabled={stale} onClick={applyMeshRepair}>
            生成修复副本
          </button>
        )}
      </footer>
    </section>
  );
}
