// 打印检查结果面板(T14/CHK-05)。右栏下部常驻:折叠态只留头行(状态一目了然),
// 展开呈分级列表(错误/警告/信息)。条目点击 → 视口聚焦 + 问题高亮;可修复条目带一键修复。
// 过期(CHK-03)= 整面灰显 + 「重新检查」;超时(CHK-02)= 保留部分结果 + 「重试未完成」。

import { doc, useUi } from '../state/store';
import {
  applyFix,
  connectedComponentEvidenceForIssue,
  fixDisabledReason,
  focusConnectedComponent,
  focusSelfIntersectionEvidence,
  focusIssue,
  liveIssues,
  reportIsStale,
  runPrintCheck,
  selfIntersectionEvidenceForIssue,
  startConnectedComponentPreview,
  useCheck,
  useCheckSnapshot,
} from './check-state';
import type { CheckIssue, IssueLevel } from './check-core';
import { MeshRepairPanel } from '../repair/MeshRepairPanel';
import {
  meshRepairDisabledReason,
  prepareMeshRepair,
  useMeshRepair,
} from '../repair/mesh-repair-state';
import {
  cancelSeamRecommendationScan,
  closePlaneCutPreview,
  planeCutPreviewIsStale,
  previewSeamRecommendation,
  selectPlaneCutCandidate,
  setPlaneCutPosition,
  startSeamRecommendationScan,
  startPlaneCutPreview,
  usePlaneCutPreviewSnapshot,
} from '../split/plane-cut-state';

const AMBER = '#ffb454';
const RED = '#f09595';
const GREEN = '#5dcaa5';
const GREY = '#8b8b93';

const LEVEL_META: Record<IssueLevel, { icon: string; name: string; color: string }> = {
  error: { icon: '⛔', name: '错误', color: RED },
  warning: { icon: '⚠️', name: '警告', color: AMBER },
  info: { icon: 'ℹ️', name: '信息', color: GREY },
};

const btn: React.CSSProperties = {
  background: '#26262e',
  color: '#c9c9d1',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#34343e',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

function StatusChip({ stale }: { stale: boolean }) {
  const s = useCheckSnapshot();
  const chip = (text: string, color: string): React.ReactNode => (
    <span style={{ fontSize: 11, color, whiteSpace: 'nowrap' }}>{text}</span>
  );
  if (s.phase === 'idle') return chip('未检查', GREY);
  if (s.phase === 'running') return chip(`${s.phaseText} ${s.pct}%`, AMBER);
  if (stale) return chip('结果已过期', GREY);
  if (s.unfinished.length) return chip(`未完成 ${s.unfinished.length} 件`, RED);
  const sum = s.summary;
  const issues = liveIssues();
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  if (!sum || sum.instances === 0) return chip('无可检查对象', GREY);
  if (errors) return chip(`${errors} 错误 · ${warnings} 警告`, RED);
  if (warnings) return chip(`${warnings} 警告`, AMBER);
  return chip('✓ 通过', GREEN);
}

function IssueRow({
  issue,
  stale,
  fixed,
  activeKey,
  activeEvidenceIndex,
}: {
  issue: CheckIssue;
  stale: boolean;
  fixed: boolean;
  activeKey: string | null;
  activeEvidenceIndex: number;
}) {
  const repairPhase = useMeshRepair((state) => state.phase);
  const repairIssueKey = useMeshRepair((state) => state.issueKey);
  const cutPreview = usePlaneCutPreviewSnapshot();
  const cutPhase = cutPreview.phase;
  const cutIssueKey = cutPreview.issueKey;
  const cutCandidates = cutPreview.candidates;
  const cutSections = cutPreview.sections;
  const cutSectionPending = cutPreview.sectionPending;
  const cutCandidateIndex = cutPreview.activeIndex;
  const active = activeKey === issue.key;
  const meta = LEVEL_META[issue.level];
  const fixReason = issue.fix ? fixDisabledReason(issue) : null;
  const fixLabel = issue.fix?.kind === 'drop' ? '⬇ 沉底' : issue.fix?.kind === 'clamp' ? '↩ 移回床内' : null;
  const canPreviewRepair = issue.code === 'non_watertight' || issue.code === 'degenerate';
  const components = connectedComponentEvidenceForIssue(issue);
  const hasOutOfBedIssue = issue.code === 'dims' && liveIssues().some(
    (candidate) => candidate.instanceId === issue.instanceId && candidate.code === 'out_of_bed',
  );
  const canPreviewPlaneCut = issue.code === 'dims' && !!issue.world && components.length <= 1 && hasOutOfBedIssue;
  const cutActive = canPreviewPlaneCut
    && cutPhase === 'ready'
    && cutIssueKey === issue.key
    && !planeCutPreviewIsStale();
  const cutCandidate = cutActive ? cutCandidates[cutCandidateIndex] : null;
  const cutSection = cutActive ? cutSections[cutCandidateIndex] : null;
  const cutSectionBusy = cutActive && !!cutSectionPending[cutCandidateIndex];
  const seamPhase = cutPreview.recommendationPhase;
  const seamProgress = cutPreview.recommendationProgress;
  const seamRecommendations = cutPreview.recommendations;
  const seamError = cutPreview.recommendationError;
  const axisRecommendations = cutCandidate
    ? seamRecommendations.filter((recommendation) => recommendation.axis === cutCandidate.axis)
    : [];
  const readOnlyDiagnosis = issue.code === 'self_intersection'
    || issue.code === 'internal_shell'
    || issue.code === 'isolated_fragment'
    || issue.code === 'deep_check_partial'
    || components.length > 1
    || canPreviewPlaneCut;
  const repairReason = canPreviewRepair ? meshRepairDisabledReason(issue) : null;
  const repairBusy = repairPhase === 'preparing';
  const evidence = selfIntersectionEvidenceForIssue(issue);
  const evidenceIndex = active && evidence.length
    ? Math.min(activeEvidenceIndex, evidence.length - 1)
    : 0;
  const selectedEvidence = evidence[evidenceIndex];
  const componentIndex = active && components.length
    ? Math.min(activeEvidenceIndex, components.length - 1)
    : 0;
  const selectedComponent = components[componentIndex];
  const componentHealth = components.length
    ? useCheck.getState().assetMetas.find((asset) => asset.assetId === issue.assetId)?.health
    : null;
  const componentKind = selectedComponent?.kind === 'primary'
    ? '主体'
    : selectedComponent?.kind === 'internal'
      ? '内部壳'
      : selectedComponent?.kind === 'fragment' ? '疑似碎片' : '独立壳';

  return (
    <div
      onClick={() => focusIssue(issue)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        padding: '5px 8px',
        fontSize: 11,
        lineHeight: 1.45,
        cursor: 'pointer',
        opacity: stale ? 0.45 : 1, // CHK-03:过期灰显
        background: active ? 'rgba(255,180,84,0.10)' : 'transparent',
        boxShadow: active ? `inset 2px 0 0 ${AMBER}` : 'none',
        borderBottom: '1px solid #232329',
      }}
      title="点击:视口聚焦并高亮问题区域(CHK-05)"
    >
      <span style={{ flex: 'none' }}>{meta.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#d2d2d8', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {issue.instanceName}
          {fixed && <span style={{ color: GREEN, fontWeight: 400 }}> · ✓ 已执行修复</span>}
        </div>
        <div style={{ color: issue.level === 'info' ? GREY : meta.color }}>{issue.message}</div>
        {selectedEvidence && (
          <div
            className="self-intersection-evidence"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="self-intersection-evidence__legend">
              <span><i className="face-a" />红色面 A</span>
              <b>×</b>
              <span><i className="face-b" />蓝色面 B</span>
            </div>
            <div className="self-intersection-evidence__nav">
              <button
                type="button"
                aria-label="上一组自交证据"
                disabled={stale || evidence.length <= 1}
                onClick={() => focusSelfIntersectionEvidence(issue, evidenceIndex - 1)}
              >
                ‹
              </button>
              <span>
                证据 {evidenceIndex + 1}/{evidence.length} · 面 #{selectedEvidence.faceA} × #{selectedEvidence.faceB}
              </span>
              <button
                type="button"
                aria-label="下一组自交证据"
                disabled={stale || evidence.length <= 1}
                onClick={() => focusSelfIntersectionEvidence(issue, evidenceIndex + 1)}
              >
                ›
              </button>
              <button
                type="button"
                className="locate"
                disabled={stale}
                onClick={() => focusSelfIntersectionEvidence(issue, evidenceIndex)}
              >
                定位
              </button>
            </div>
          </div>
        )}
        {components.length > 1 && selectedComponent && (
          <div
            className={`component-preview${active ? ' is-active' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="component-preview__heading">
              <strong>连通壳拆件预览</strong>
              <span>{componentHealth?.connectedComponents ?? components.length} 个候选零件</span>
            </div>
            {active ? (
              <>
                <div className="component-preview__legend">
                  <i className="part-1" /><i className="part-2" /><i className="part-3" /><i className="part-4" />
                  <span>颜色区分现有独立壳，亮框是当前零件</span>
                </div>
                <div className="component-preview__nav">
                  <button
                    type="button"
                    aria-label="上一个连通壳零件"
                    onClick={() => focusConnectedComponent(issue, componentIndex - 1)}
                  >
                    ‹
                  </button>
                  <span>
                    零件 {componentIndex + 1}/{components.length} · {componentKind} · {selectedComponent.faceCount.toLocaleString()} 面
                  </span>
                  <button
                    type="button"
                    aria-label="下一个连通壳零件"
                    onClick={() => focusConnectedComponent(issue, componentIndex + 1)}
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    className="locate"
                    onClick={() => focusConnectedComponent(issue, componentIndex)}
                  >
                    定位
                  </button>
                </div>
                <small>
                  {componentHealth?.componentEvidenceComplete ? '完整预览' : '预算内抽样预览'} · 当前只读，不会创建零件或修改原模型
                </small>
              </>
            ) : (
              <button
                type="button"
                className="component-preview__start"
                disabled={stale}
                onClick={() => startConnectedComponentPreview(issue)}
              >
                预览拆成 {componentHealth?.connectedComponents ?? components.length} 件
              </button>
            )}
          </div>
        )}
        {canPreviewPlaneCut && (
          <div
            className={`plane-cut-card${cutActive ? ' is-active' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="plane-cut-card__heading">
              <strong>平面切割候选</strong>
              <span>本地确定性 · 3 个</span>
            </div>
            {cutCandidate ? (
              <>
                <div className="plane-cut-card__nav">
                  <button
                    type="button"
                    aria-label="上一个平面切割候选"
                    onClick={() => selectPlaneCutCandidate(cutCandidateIndex - 1)}
                  >
                    ‹
                  </button>
                  <span>{cutCandidate.label} · 推荐分 {cutCandidate.score}</span>
                  <button
                    type="button"
                    aria-label="下一个平面切割候选"
                    onClick={() => selectPlaneCutCandidate(cutCandidateIndex + 1)}
                  >
                    ›
                  </button>
                  <button type="button" className="close" onClick={closePlaneCutPreview}>关闭</button>
                </div>
                <div className={`seam-recommendation is-${seamPhase}`}>
                  <div className="seam-recommendation__heading">
                    <strong>几何低风险接缝</strong>
                    <span>27 个轴向样本 · 只读</span>
                  </div>
                  {seamPhase === 'idle' && (
                    <>
                      <p>比较双侧入床、局部薄颈、截面复杂度、截线密度和零件比例。</p>
                      <button type="button" onClick={startSeamRecommendationScan}>扫描推荐位置</button>
                    </>
                  )}
                  {seamPhase === 'scanning' && (
                    <>
                      <div className="seam-recommendation__progress">
                        <i style={{ width: `${seamProgress.total ? (seamProgress.done / seamProgress.total) * 100 : 0}%` }} />
                      </div>
                      <div className="seam-recommendation__status">
                        <span>正在扫描 {seamProgress.done}/{seamProgress.total}</span>
                        <button type="button" onClick={cancelSeamRecommendationScan}>取消</button>
                      </div>
                    </>
                  )}
                  {seamPhase === 'failed' && (
                    <>
                      <p className="error">{seamError ?? '扫描失败，请重试'}</p>
                      <button type="button" onClick={startSeamRecommendationScan}>重新扫描</button>
                    </>
                  )}
                  {seamPhase === 'ready' && seamRecommendations.length === 0 && (
                    <>
                      <p>27 个样本中没有同时满足“双侧入床 + 完整闭合截面”的候选。</p>
                      <button type="button" onClick={startSeamRecommendationScan}>重新扫描</button>
                    </>
                  )}
                  {seamPhase === 'ready' && seamRecommendations.length > 0 && (
                    <div className="seam-recommendation__list">
                      {seamRecommendations.map((recommendation, index) => (
                        <button
                          type="button"
                          key={recommendation.id}
                          className={cutCandidate.axis === recommendation.axis
                            && Math.abs(cutCandidate.normalizedPosition - recommendation.normalizedPosition) < 0.001
                            ? 'is-active' : ''}
                          onClick={() => previewSeamRecommendation(recommendation)}
                        >
                          <span><b>推荐 {index + 1}</b> · {recommendation.axis.toUpperCase()} {Math.round(recommendation.normalizedPosition * 100)}%</span>
                          <strong>{recommendation.score} 分</strong>
                          <small>{recommendation.reasons.join(' · ')}</small>
                          <em>{recommendation.risks[0]}</em>
                        </button>
                      ))}
                    </div>
                  )}
                  <small>评分是几何代理，不识别角色脸部、机械关节、受力或装配语义。</small>
                </div>
                <div className="plane-cut-card__position">
                  <div>
                    <span>{cutCandidate.axis.toUpperCase()} 轴切面位置</span>
                    <strong>{Math.round(cutCandidate.normalizedPosition * 100)}%</strong>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={90}
                    step={1}
                    aria-label="切面位置"
                    value={Math.round(cutCandidate.normalizedPosition * 100)}
                    onChange={(event) => setPlaneCutPosition(Number(event.target.value) / 100, true)}
                  />
                  {axisRecommendations.length > 0 && (
                    <div className="plane-cut-card__markers" aria-label="当前轴推荐位置">
                      {axisRecommendations.map((recommendation) => (
                        <button
                          type="button"
                          key={recommendation.id}
                          aria-label={`${recommendation.axis.toUpperCase()} 轴 ${Math.round(recommendation.normalizedPosition * 100)}% 推荐位置`}
                          title={`几何推荐 ${recommendation.score} 分`}
                          className={Math.abs(cutCandidate.normalizedPosition - recommendation.normalizedPosition) < 0.001 ? 'is-active' : ''}
                          style={{ left: `${recommendation.normalizedPosition * 100}%` }}
                          onClick={() => previewSeamRecommendation(recommendation)}
                        />
                      ))}
                    </div>
                  )}
                  <div className="plane-cut-card__presets">
                    {[25, 50, 75].map((percent) => (
                      <button
                        type="button"
                        key={percent}
                        className={Math.round(cutCandidate.normalizedPosition * 100) === percent ? 'is-active' : ''}
                        onClick={() => setPlaneCutPosition(percent / 100)}
                      >
                        {percent}%
                      </button>
                    ))}
                    <span>
                      距 A 端 {(cutCandidate.parts[0].dimensionsMm[cutCandidate.axisIndex]).toFixed(1)}mm
                    </span>
                  </div>
                  <small className={cutCandidate.feasiblePositionRange ? 'feasible' : 'unavailable'}>
                    {cutCandidate.feasiblePositionRange
                      ? `可放入区间 ${Math.ceil(cutCandidate.feasiblePositionRange[0] * 100)}%–${Math.floor(cutCandidate.feasiblePositionRange[1] * 100)}%`
                      : '当前轴不存在一次切割可使两侧都入床的区间'}
                  </small>
                </div>
                <div className="plane-cut-card__reason">{cutCandidate.rationale}</div>
                {cutSectionBusy && (
                  <div className="plane-cut-card__section is-pending">
                    <div className="plane-cut-card__section-heading">
                      <strong>正在计算真实截面…</strong>
                      <span>切面与尺寸已更新</span>
                    </div>
                  </div>
                )}
                {cutSection && (
                  <div className={`plane-cut-card__section is-${cutSection.status}`}>
                    <div className="plane-cut-card__section-heading">
                      <strong>真实截面证据</strong>
                      <span>{cutSection.complete ? '完整扫描' : '预算内部分扫描'}</span>
                    </div>
                    {cutSection.status === 'closed' && cutSection.areaMm2 !== null ? (
                      <>
                        <div className="plane-cut-card__section-metrics">
                          <b>{cutSection.areaMm2.toFixed(0)} mm²</b>
                          <span>{cutSection.loopCount} 个闭合环</span>
                          <span>{cutSection.segmentCount} 条截线</span>
                          <span>周长 {cutSection.perimeterMm.toFixed(0)} mm</span>
                        </div>
                        <small>亮黄色轮廓来自三角网格真实求交；面积尚未代表封口或可制造性</small>
                      </>
                    ) : (
                      <>
                        <div className="plane-cut-card__section-metrics">
                          <b>{cutSection.segmentCount} 条截线</b>
                          <span>{cutSection.loopCount} 个闭合环</span>
                          {cutSection.openChainCount > 0 && <span>{cutSection.openChainCount} 组开链</span>}
                          {!cutSection.complete && <span>{cutSection.facesTested.toLocaleString()} / {cutSection.facesTotal.toLocaleString()} 面</span>}
                        </div>
                        <small>{cutSection.warnings[0] ?? '截面未形成可验证的闭合轮廓，面积不可用'}</small>
                      </>
                    )}
                  </div>
                )}
                <div className="plane-cut-card__parts">
                  {cutCandidate.parts.map((part) => (
                    <div key={part.label} className={`part part-${part.label.toLowerCase()}`}>
                      <b>{part.label}</b>
                      <span>{part.dimensionsMm.map((value) => value.toFixed(1)).join(' × ')} mm</span>
                      <em className={part.fitsBed ? 'fits' : 'overflow'}>{part.fitsBed ? '可放入' : '仍超床'}</em>
                    </div>
                  ))}
                </div>
                <small>
                  包围盒切面代理 {cutCandidate.cutAreaEstimateMm2.toFixed(0)} mm² · 不等于真实截面；当前仍不封口、不生成零件
                </small>
              </>
            ) : (
              <>
                <p>单一连通壳超出打印床。先比较 X / Y / Z 三个中线，再决定是否进入真实切割。</p>
                <button
                  type="button"
                  className="plane-cut-card__start"
                  disabled={stale}
                  onClick={() => startPlaneCutPreview(issue)}
                >
                  查看 3 个候选
                </button>
              </>
            )}
          </div>
        )}
        {issue.level === 'warning' && issue.code === 'floating' && issue.world && (
          <div style={{ color: GREY }}>投影落点 z=0,距离 {issue.world.min[2].toFixed(1)}mm</div>
        )}
      </div>
      {fixLabel && !fixed && (
        <button
          style={{
            ...btn,
            flex: 'none',
            ...(fixReason ? { opacity: 0.4, cursor: 'default' } : { borderColor: AMBER, color: AMBER }),
          }}
          disabled={!!fixReason}
          title={fixReason ?? '确定性修复,入历史栈可撤销(CHK-06)'}
          onClick={(e) => {
            e.stopPropagation();
            applyFix(issue);
          }}
        >
          {fixLabel}
        </button>
      )}
      {canPreviewRepair && !fixed && (
        <button
          style={{
            ...btn,
            flex: 'none',
            ...((repairReason || repairBusy)
              ? { opacity: 0.4, cursor: 'default' }
              : { borderColor: GREEN, color: GREEN }),
          }}
          disabled={!!repairReason || repairBusy}
          title={repairReason ?? '先生成只读预览；确认后才创建修复副本，原模型不变'}
          onClick={(event) => {
            event.stopPropagation();
            prepareMeshRepair(issue);
          }}
        >
          {repairBusy && repairIssueKey === issue.key ? '分析中…' : '修复预览'}
        </button>
      )}
      {readOnlyDiagnosis && (
        <span
          style={{
            flex: 'none',
            padding: '2px 6px',
            border: '1px solid #3b4148',
            borderRadius: 999,
            color: '#8fa7b7',
            fontSize: 9,
            whiteSpace: 'nowrap',
          }}
          title={components.length > 1
            ? 'M1.7.3 只读拆件预览：只浏览现有连通壳，不创建新零件'
            : canPreviewPlaneCut
              ? 'M1.7.7 几何低风险接缝：批量比较真实截面，只给推荐、不封口、不生成新零件'
              : 'M1.7.2 只读深度诊断：提供局部证据，不自动修改复杂拓扑'}
        >
          {components.length > 1 || canPreviewPlaneCut ? '只读预览' : '只读诊断'}
        </span>
      )}
    </div>
  );
}

export function CheckPanel({ embedded = false, onOpenSplit }: { embedded?: boolean; onOpenSplit?: () => void }) {
  useUi((s) => s.rev); // 文档任何变化 → 重算过期/存活过滤
  useUi((s) => s.bed); // 床配置变化 → 过期
  const s = useCheckSnapshot();
  const stale = s.phase === 'done' && reportIsStale();
  const issues = liveIssues();
  const groups: IssueLevel[] = ['error', 'warning', 'info'];

  return (
    <section
      style={{
        border: '1px solid #2b2b31',
        background: '#1b1b20',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: embedded ? undefined : s.panelOpen ? '52%' : undefined,
        height: embedded ? '100%' : undefined,
        flex: embedded ? 1 : 'none',
      }}
    >
      {/* 头行:折叠态唯一可见区 */}
      <header
        onClick={() => s.setPanelOpen(!s.panelOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ color: '#e8e8ea', fontSize: 12, fontWeight: 600 }}>打印检查</span>
        <StatusChip stale={stale} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            style={{
              ...btn,
              ...(s.phase === 'running'
                ? { opacity: 0.4, cursor: 'default' }
                : { borderColor: AMBER, color: AMBER }),
            }}
            disabled={s.phase === 'running'}
            onClick={(e) => {
              e.stopPropagation();
              runPrintCheck();
            }}
            title="全量打印检查:手动触发;导出前将自动触发(CHK-02,T15)"
          >
            {s.phase === 'done' ? '重新检查' : '检查'}
          </button>
          <span style={{ color: GREY, fontSize: 11, alignSelf: 'center' }}>{s.panelOpen ? '▾' : '▸'}</span>
        </span>
      </header>

      {s.panelOpen && (
        <div style={{ overflowY: 'auto', minHeight: 0, borderTop: '1px solid #232329' }}>
          {/* 运行中:进度条(CHK-02 带进度) */}
          {s.phase === 'running' && (
            <div style={{ padding: '8px 10px' }}>
              <div style={{ height: 4, background: '#26262e', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${s.pct}%`, background: AMBER, transition: 'width .2s' }} />
              </div>
              <div style={{ color: GREY, fontSize: 11, marginTop: 5 }}>{s.phaseText}…</div>
            </div>
          )}

          {/* 过期条(CHK-03:灰显 + 重新检查,不自动重跑) */}
          {stale && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'rgba(139,139,147,0.10)' }}>
              <span style={{ color: GREY, fontSize: 11, flex: 1 }}>场景已编辑,以下结果已过期</span>
              <button style={{ ...btn, borderColor: AMBER, color: AMBER }} onClick={() => runPrintCheck()}>
                重新检查
              </button>
            </div>
          )}

          {/* 超时条(CHK-02 按未完成呈现 / 边界 5 分对象重试,不假装成功) */}
          {s.phase === 'done' && s.unfinished.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'rgba(240,149,149,0.08)' }}>
              <span style={{ color: RED, fontSize: 11, flex: 1 }}>
                检查超时,{s.unfinished.length} 件未完成:{s.unfinished.slice(0, 3).map((u) => u.name).join('、')}
                {s.unfinished.length > 3 ? '…' : ''}
              </span>
              <button
                style={{ ...btn, borderColor: RED, color: RED }}
                onClick={() => runPrintCheck({ onlyIds: s.unfinished.map((u) => u.id) })}
              >
                重试未完成
              </button>
            </div>
          )}

          <MeshRepairPanel />

          {/* 空结果空态 */}
          {s.phase === 'done' && s.summary?.instances === 0 && (
            <div style={{ padding: '12px 10px', color: GREY, fontSize: 11 }}>
              无可检查对象(隐藏对象不参与检查,C7)
            </div>
          )}

          {/* 分级列表(CHK-05) */}
          {s.phase !== 'idle' &&
            groups.map((lv) => {
              const list = issues.filter((i) => i.level === lv);
              if (!list.length) return null;
              return (
                <div key={lv}>
                  <div style={{ padding: '6px 10px 3px', fontSize: 10, color: LEVEL_META[lv].color, fontWeight: 700, letterSpacing: 1 }}>
                    {LEVEL_META[lv].icon} {LEVEL_META[lv].name}({list.length})
                  </div>
                  {list.map((i) => (
                    <IssueRow
                      key={i.key}
                      issue={i}
                      stale={stale}
                      fixed={s.fixedKeys.includes(i.key)}
                      activeKey={s.activeKey}
                      activeEvidenceIndex={s.activeEvidenceIndex}
                    />
                  ))}
                </div>
              );
            })}

          {/* 汇总行(CHK-01 信息级清单 + CHK-04 分层计算的可观测口径) */}
          {s.phase === 'done' && s.summary && s.summary.instances > 0 && (
            <div style={{ padding: '7px 10px', color: GREY, fontSize: 10, borderTop: '1px solid #232329' }}>
              清单:{s.summary.instances} 个对象 · {s.summary.totalFaces.toLocaleString()} 面 ·
              几何分析 {s.summary.assetsAnalyzed} 次 · 缓存复用 {s.summary.assetsCached} 次 ·
              {s.summary.durationMs.toFixed(0)}ms(资产级一次缓存,实例级随变换重算,CHK-04)
            </div>
          )}

          {s.phase === 'idle' && (
            <div style={{ padding: '12px 10px', color: GREY, fontSize: 11 }}>
              尚未检查。点「检查」对全部可见对象执行打印前检查：水密性、退化几何、自交、内部壳、孤立碎片、床内位置、悬空与微小件。
            </div>
          )}

          {onOpenSplit && s.phase === 'done' && (
            <div className="check-agent-cta">
              <div>
                <strong>让 AI 帮你判断是否需要拆件</strong>
                <span>基于本次检查整理 2–3 套候选方案，不会修改模型。</span>
              </div>
              <button type="button" onClick={onOpenSplit}>AI 拆件分析</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
