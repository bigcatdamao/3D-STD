import { reportIsStale, runPrintCheck, useCheckSnapshot } from '../check/check-state';
import { doc, useUi } from '../state/store';
import {
  runSplitAnalysis,
  splitAnalysisIsStale,
  useSplitAnalysisSnapshot,
} from './split-analysis-state';
import type { NeedsSplit, PrintProcess, SplitPriority, SplitScheme } from './split-analysis-types';

const PROCESS_OPTIONS: Array<{ value: PrintProcess; label: string }> = [
  { value: 'fdm', label: 'FDM' },
  { value: 'sla', label: '光固化' },
  { value: 'sls', label: 'SLS' },
];

const PRIORITY_OPTIONS: Array<{ value: SplitPriority; label: string }> = [
  { value: 'fit_build_volume', label: '适配空间' },
  { value: 'reduce_support', label: '减少支撑' },
  { value: 'preserve_strength', label: '保持强度' },
  { value: 'easy_assembly', label: '易于装配' },
];

function statusLabel(needsSplit: NeedsSplit): string {
  return needsSplit === 'yes' ? '建议拆件' : needsSplit === 'no' ? '优先整体打印' : '需要补充证据';
}
function checkLabel(phase: ReturnType<typeof useCheckSnapshot>['phase'], stale: boolean): string {
  if (phase === 'idle') return '打印检查：未运行';
  if (phase === 'running') return '打印检查：进行中';
  if (stale) return '打印检查：已过期';
  return '打印检查：已完成';
}

function SchemeCard({
  scheme,
  selected,
  onSelect,
}: {
  scheme: SplitScheme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`split-scheme${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="split-scheme__topline">
        <strong>{scheme.title}</strong>
        {scheme.recommended && <span className="split-scheme__recommended">推荐</span>}
      </span>
      <span className="split-scheme__summary">{scheme.summary}</span>
      <span className="split-scheme__meta">
        <span>{scheme.partCount} 件</span>
        <span>{scheme.assembly}</span>
        <span>风险 {scheme.risk}</span>
      </span>
      {selected && (
        <span className="split-scheme__details">
          <span><b>优点</b>{scheme.pros.join('；')}</span>
          <span><b>注意</b>{scheme.cons.join('；')}</span>
        </span>
      )}
    </button>
  );
}

export function SplitAnalysisPanel() {
  useUi((state) => state.rev);
  const bed = useUi((state) => state.bed);
  const check = useCheckSnapshot();
  const analysis = useSplitAnalysisSnapshot();
  const checkStale = check.phase === 'done' && reportIsStale();
  const resultStale = analysis.phase === 'done' && splitAnalysisIsStale();
  const visibleObjects = [...doc.nodes.values()].filter(
    (node) => node.kind === 'instance' && doc.effectiveVisible(node.id) && doc.assets.get(node.assetId)?.state === 'ready',
  );
  const canAnalyze = visibleObjects.length > 0 && analysis.goal.trim().length > 0 && analysis.phase !== 'running';
  const selectedScheme = analysis.result?.schemes.find((scheme) => scheme.id === analysis.selectedSchemeId) ?? null;

  return (
    <section className="split-analysis" data-testid="split-analysis-panel">
      <header className="split-analysis__header">
        <div>
          <div className="split-analysis__eyebrow">阶段一 · 分析与建议</div>
          <h2>AI 拆件分析</h2>
        </div>
        <span className="split-analysis__readonly">只读</span>
      </header>

      <div className="split-analysis__notice">
        <strong>不会修改模型</strong>
        <span>尺寸、检测结果与多视角截图会发送到后台配置的模型服务；仅分析建议，不修改模型。</span>
      </div>

      <div className="split-evidence" aria-label="当前分析证据">
        <span>{visibleObjects.length} 个对象</span>
        <span>床 {bed.x} × {bed.y} × {bed.z}</span>
        <span className={checkStale || check.phase === 'idle' ? 'is-missing' : 'is-ready'}>
          {checkLabel(check.phase, checkStale)}
        </span>
        <span className="is-missing">薄壁：未检测</span>
        <span className="is-missing">局部过悬：未检测</span>
        <span className={analysis.evidenceViews > 0 ? 'is-ready' : 'is-missing'}>
          多视角：{analysis.evidenceViews > 0 ? `${analysis.evidenceViews} 张` : '待采集'}
        </span>
      </div>

      <div className="split-analysis__form">
        <label>
          <span>拆件目标</span>
          <textarea
            value={analysis.goal}
            maxLength={1000}
            disabled={analysis.phase === 'running'}
            onChange={(event) => analysis.setGoal(event.target.value)}
            placeholder="例如：适配当前打印空间，减少支撑，同时尽量隐藏接缝"
          />
        </label>

        <div className="split-analysis__field">
          <span>打印方式</span>
          <div className="split-choice-row">
            {PROCESS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={analysis.process === option.value ? 'is-selected' : ''}
                aria-pressed={analysis.process === option.value}
                disabled={analysis.phase === 'running'}
                onClick={() => analysis.setProcess(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="split-analysis__field">
          <span>优先目标</span>
          <div className="split-priority-row">
            {PRIORITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={analysis.priorities.includes(option.value) ? 'is-selected' : ''}
                aria-pressed={analysis.priorities.includes(option.value)}
                disabled={analysis.phase === 'running'}
                onClick={() => analysis.togglePriority(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {(check.phase === 'idle' || checkStale) && (
          <div className="split-analysis__missing-evidence">
            <span>建议先获得一份新鲜的打印检查结果；也可以在证据不足状态下体验分析。</span>
            <button type="button" disabled={check.phase === 'running'} onClick={() => runPrintCheck()}>
              {checkStale ? '重新检查' : '运行检查'}
            </button>
          </div>
        )}

        <button
          type="button"
          className="split-analysis__run"
          disabled={!canAnalyze}
          onClick={() => void runSplitAnalysis()}
        >
          {analysis.phase === 'running' ? '正在整理证据与候选方案…' : analysis.result ? '重新生成拆件建议' : '生成拆件建议'}
        </button>
        {!visibleObjects.length && <span className="split-analysis__empty">请先生成、导入或打开一个示例模型。</span>}
        {analysis.error && <span className="split-analysis__error">{analysis.error}</span>}
      </div>

      {analysis.phase === 'running' && (
        <div className="split-analysis__loading" role="status">
          <span />
          <span />
          <span />
          <p>正在汇总尺寸、对象状态与打印检查证据…</p>
        </div>
      )}

      {analysis.phase === 'done' && analysis.result && (
        <div className={`split-result${resultStale ? ' is-stale' : ''}`}>
          <div className={`split-result__source is-${analysis.resultSource ?? 'fallback'}`}>
            {analysis.resultSource === 'api'
              ? `AI 分析 · ${analysis.provider === 'aihubmix' ? 'AIHubMix' : 'OpenAI'} · ${analysis.model ?? 'Responses API'} · ${analysis.evidenceViews} 视角`
              : '本地降级建议 · 未使用大模型'}
          </div>
          {analysis.warning && <div className="split-result__warning">{analysis.warning}</div>}
          {resultStale && (
            <div className="split-result__stale">场景已经改变，以下结果已过期。请重新分析后再做决策。</div>
          )}
          <div className="split-result__summary">
            <span className={`split-result__verdict is-${analysis.result.needsSplit}`}>
              {statusLabel(analysis.result.needsSplit)}
            </span>
            <span>分析置信度 {Math.round(analysis.result.confidence * 100)}%</span>
            <strong>建议 {analysis.result.recommendedPartCount.preferred} 件</strong>
            <p>{analysis.result.summary}</p>
          </div>

          <div className="split-result__section">
            <h3>为什么</h3>
            {analysis.result.reasons.slice(0, 3).map((reason) => (
              <div className={`split-reason is-${reason.severity}`} key={`${reason.code}-${reason.description}`}>
                <strong>{reason.description}</strong>
                <span>{reason.evidence}</span>
              </div>
            ))}
          </div>

          <div className="split-result__section">
            <h3>候选方案</h3>
            <div className="split-schemes">
              {analysis.result.schemes.map((scheme) => (
                <SchemeCard
                  key={scheme.id}
                  scheme={scheme}
                  selected={analysis.selectedSchemeId === scheme.id}
                  onSelect={() => analysis.selectScheme(scheme.id)}
                />
              ))}
            </div>
          </div>

          {selectedScheme && (
            <div className="split-result__selection">
              <div>
                <span>当前选择</span>
                <strong>{selectedScheme.title}</strong>
              </div>
              <button type="button" disabled title="阶段二开放：先生成预览，再等待用户确认">
                生成切割预览 · 阶段二
              </button>
            </div>
          )}

          <div className="split-result__section">
            <h3>风险与下一步</h3>
            <div className="split-risk">
              <strong>{analysis.result.risks[0]?.title}</strong>
              <span>{analysis.result.risks[0]?.mitigation}</span>
            </div>
            <ol className="split-next-steps">
              {analysis.result.nextSteps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>

          <details className="split-result__limitations">
            <summary>查看证据限制</summary>
            <p>尚不可用：{analysis.result.limitations.unavailableCapabilities.join('、')}</p>
            <p>视觉不确定性：{analysis.result.limitations.visualUncertainty === 'high' ? '高' : '中'}</p>
          </details>
        </div>
      )}
    </section>
  );
}
