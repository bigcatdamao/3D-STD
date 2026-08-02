import { useEffect, useRef, useState } from 'react';
import { mountTurnstile, type TurnstileHandle } from '../ai/turnstile';
import { closeAutoSplit, resumeAutoSplit, setAutoSplitLevel, submitAutoSplit, useAutoSplitSnapshot } from './auto-split-state';

const formatSize = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function AutoSplitPanel() {
  const state = useAutoSplitSnapshot();
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TurnstileHandle | null>(null);
  const [verified, setVerified] = useState(false);
  const busy = state.phase === 'submitting' || state.phase === 'queued' || state.phase === 'running' || state.phase === 'importing';

  useEffect(() => {
    let disposed = false;
    if (!hostRef.current) return;
    void mountTurnstile(hostRef.current, () => {
      if (!disposed) setVerified(true);
    }, () => {
      if (!disposed) setVerified(false);
    }).then((handle) => {
      if (disposed) handle.destroy();
      else handleRef.current = handle;
    });
    return () => {
      disposed = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  const submit = async () => {
    const token = handleRef.current?.consume() ?? null;
    setVerified(false);
    await submitAutoSplit(token ?? '');
  };

  return (
    <section className="auto-split-panel" data-testid="auto-split-panel">
      <div className="auto-split-panel__version">M1.17a.1 · {state.sourceProvider === 'hunyuan' ? '混元组件生成' : 'Hi3D 自动拆件'}</div>
      <h2>把当前模型拆成独立零件</h2>
      <p className="auto-split-panel__source" title={state.sourceName}>{state.sourceName}</p>

      {state.phase === 'done' ? (
        <div className="auto-split-success">
          <strong>已生成 {state.partCount} 个独立零件</strong>
          <span>零件已进入场景并自动启动打印检查。原始资产仍保留，可通过历史撤销。</span>
        </div>
      ) : (
        <>
          <div className="auto-split-summary">
            <span><b>{state.sourceFaces.toLocaleString()}</b> 面</span>
            <span><b>{state.sourceMode === 'provider-fbx' ? '原始' : formatSize(state.uploadBytes)}</b> {state.sourceMode === 'provider-fbx' ? '混元 FBX' : '临时 STL'}</span>
            <span><b>{state.sourceProvider === 'hunyuan' ? 30 : 20}</b> Credits</span>
          </div>

          {state.sourceProvider === 'hunyuan' ? (
            <div className="auto-split-consent">
              <strong>组件模式 · 混元 1.5 自动识别</strong>
              <span>当前接口不提供拆件粒度参数；会按模型结构生成多个独立 GLB 零件。</span>
            </div>
          ) : (
            <fieldset className="auto-split-level" disabled={busy}>
              <legend>拆件粒度</legend>
              {([
                ['low', '大部件', '零件更少'],
                ['medium', '标准', '推荐'],
                ['high', '细拆', '零件更多'],
              ] as const).map(([value, label, note]) => (
                <button key={value} type="button" className={state.level === value ? 'is-active' : ''} onClick={() => setAutoSplitLevel(value)}>
                  <b>{label}</b><span>{note}</span>
                </button>
              ))}
            </fieldset>
          )}

          <div className="auto-split-consent">
            <strong>提交前确认</strong>
            <span>{state.sourceProvider === 'hunyuan'
              ? '会复用混元生成阶段保留的 FBX，不重复上传浏览器中的网格。结果返回后才建立独立零件，源资产保留。'
              : '模型会上传至 Hi3D 处理；当前场景不在云端修改。结果回来后才替换为独立零件，源资产保留。'}</span>
          </div>

          {busy && (
            <div className="auto-split-progress" role="status">
              <div><strong>{state.statusText}</strong><span>{state.progress}%</span></div>
              <progress max={100} value={state.progress} />
              <small>可以继续旋转视角；为避免结果失效，完成前不要编辑源模型。</small>
            </div>
          )}

          {state.error && <div className="auto-split-error" role="alert">{state.error}</div>}
        </>
      )}

      <div ref={hostRef} className="auto-split-turnstile" aria-label="人机验证" />

      <div className="auto-split-actions">
        <button type="button" className="auto-split-secondary" disabled={busy} onClick={closeAutoSplit}>
          {state.phase === 'done' ? '完成' : '取消'}
        </button>
        {state.phase !== 'done' && (
          state.phase === 'error' && state.taskId
            ? <button type="button" className="auto-split-primary" onClick={resumeAutoSplit}>继续查询</button>
            : <button type="button" className="auto-split-primary" disabled={busy || !verified} onClick={() => void submit()}>
                {busy ? '处理中…' : verified ? '开始自动拆件' : '等待验证'}
              </button>
        )}
      </div>
      <small className="auto-split-footnote">自动拆件只负责得到独立零件；连接件、公差和装配验证将在下一步处理。</small>
    </section>
  );
}
