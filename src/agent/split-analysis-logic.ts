import * as THREE from 'three';
import type { CheckIssue, CheckSummary } from '../check/check-core';
import type { SceneDocument } from '../kernel/scene';
import type { BedConfig } from '../state/store';
import { worldBBoxOfInstance } from '../viewport/gizmo-math';
import type {
  AnalysisCheckStatus,
  PrintProcess,
  SplitAnalysisContext,
  SplitAnalysisResult,
  SplitPriority,
  SplitScheme,
} from './split-analysis-types';

export interface CheckEvidence {
  phase: 'idle' | 'running' | 'done';
  stale: boolean;
  timedOut: boolean;
  unfinishedCount: number;
  issues: CheckIssue[];
  summary: CheckSummary | null;
}
export interface BuildContextOptions {
  goal: string;
  priorities: SplitPriority[];
  process: PrintProcess;
  bed: BedConfig;
  check: CheckEvidence;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function checkStatusOf(check: CheckEvidence): AnalysisCheckStatus {
  if (check.phase === 'idle') return 'not_run';
  if (check.phase === 'running') return 'running';
  if (check.stale) return 'stale';
  if (check.timedOut) return 'timeout';
  if (check.unfinishedCount > 0) return 'partial';
  return 'fresh';
}

export function buildSplitAnalysisContext(
  scene: SceneDocument,
  options: BuildContextOptions,
): SplitAnalysisContext {
  const objects: SplitAnalysisContext['objects'] = [];
  const combined = new THREE.Box3();
  let hasBounds = false;

  for (const node of scene.nodes.values()) {
    if (node.kind !== 'instance' || !scene.effectiveVisible(node.id)) continue;
    const asset = scene.assets.get(node.assetId);
    if (!asset || asset.state !== 'ready') continue;
    const world = worldBBoxOfInstance(node.transform, asset.meta.bbox);
    const size = world.getSize(new THREE.Vector3());
    combined.union(world);
    hasBounds = true;
    objects.push({
      id: node.id,
      name: node.name,
      dimensionsMm: [round1(size.x), round1(size.y), round1(size.z)],
      faces: asset.meta.faces,
      locked: scene.effectiveLocked(node.id),
    });
  }

  const combinedSize = hasBounds ? combined.getSize(new THREE.Vector3()) : null;
  const combinedDimensionsMm: [number, number, number] | null = combinedSize
    ? [round1(combinedSize.x), round1(combinedSize.y), round1(combinedSize.z)]
    : null;
  const overflowAxes: Array<'X' | 'Y' | 'Z'> = [];
  const bedSize = [options.bed.x, options.bed.y, options.bed.z];
  for (const object of objects) {
    object.dimensionsMm.forEach((dimension, axis) => {
      if (dimension > bedSize[axis] && !overflowAxes.includes((['X', 'Y', 'Z'] as const)[axis])) {
        overflowAxes.push((['X', 'Y', 'Z'] as const)[axis]);
      }
    });
  }

  const checkStatus = checkStatusOf(options.check);
  const liveIssueIds = new Set(objects.map((object) => object.id));
  const issues = options.check.issues.filter((issue) => liveIssueIds.has(issue.instanceId));

  return {
    sceneEditVersion: scene.editVersion,
    goal: options.goal,
    priorities: [...options.priorities],
    process: options.process,
    bed: { ...options.bed },
    objectCount: objects.length,
    selectedObjectCount: [...scene.selection].filter((id) => liveIssueIds.has(id)).length,
    currentPartCount: objects.length,
    combinedDimensionsMm,
    totalFaces: objects.reduce((sum, object) => sum + object.faces, 0),
    checkStatus,
    checkErrors: issues.filter((issue) => issue.level === 'error').length,
    checkWarnings: issues.filter((issue) => issue.level === 'warning').length,
    issueCodes: [...new Set(issues.map((issue) => issue.code))],
    issueMessages: issues.filter((issue) => issue.level !== 'info').map((issue) => issue.message),
    objects,
    exceedsBuildVolume: overflowAxes.length > 0,
    overflowAxes,
    capabilities: {
      topology: checkStatus === 'fresh' ? 'available' : checkStatus === 'stale' ? 'stale' : checkStatus === 'partial' || checkStatus === 'timeout' ? 'partial' : 'not_run',
      thinWall: 'unavailable',
      surfaceOverhang: 'unavailable',
      cutCandidates: 'unavailable',
      multiviewCapture: 'not_run',
    },
  };
}

function processLabel(process: PrintProcess): string {
  return process === 'fdm' ? 'FDM' : process === 'sla' ? '光固化' : 'SLS';
}

function scheme(
  id: string,
  title: string,
  summary: string,
  partCount: number,
  recommended: boolean,
  pros: string[],
  cons: string[],
  assembly: SplitScheme['assembly'],
  risk: SplitScheme['risk'],
  confidence: number,
): SplitScheme {
  return { id, title, summary, partCount, recommended, pros, cons, assembly, risk, confidence };
}

export function buildMockSplitAnalysis(context: SplitAnalysisContext): SplitAnalysisResult {
  const meshBlocking = context.issueCodes.includes('non_watertight') || context.issueCodes.includes('degenerate');
  const evidenceIncomplete = context.checkStatus !== 'fresh';
  const maxRatio = context.objects.reduce((largest, object) => Math.max(
    largest,
    object.dimensionsMm[0] / context.bed.x,
    object.dimensionsMm[1] / context.bed.y,
    object.dimensionsMm[2] / context.bed.z,
  ), 0);
  const preferredParts = context.exceedsBuildVolume ? clamp(Math.ceil(maxRatio), 2, 4) : 1;

  let needsSplit: SplitAnalysisResult['needsSplit'];
  let confidence: number;
  let summary: string;
  if (meshBlocking) {
    needsSplit = 'uncertain';
    confidence = 0.54;
    summary = '网格质量问题会影响拆件区域判断，建议先修复网格，再决定是否拆件。';
  } else if (context.exceedsBuildVolume) {
    needsSplit = 'yes';
    confidence = evidenceIncomplete ? 0.72 : 0.86;
    summary = `至少一个对象超过当前 ${context.bed.x} × ${context.bed.y} × ${context.bed.z} mm 打印空间，建议优先评估拆件。`;
  } else if (evidenceIncomplete) {
    needsSplit = 'uncertain';
    confidence = 0.48;
    summary = '当前尺寸可放入打印空间，但打印检查证据不完整，暂不能可靠判断支撑和网格风险。';
  } else {
    needsSplit = 'no';
    confidence = 0.68;
    summary = `当前对象尺寸可放入打印空间，现有证据下优先保持整体打印，并保留两件式备选。`;
  }

  const axisText = context.overflowAxes.length ? context.overflowAxes.join(' / ') : '主要尺寸轴';
  const process = processLabel(context.process);
  const reasons: SplitAnalysisResult['reasons'] = [];
  if (context.exceedsBuildVolume) {
    reasons.push({
      code: 'exceeds_build_volume',
      severity: 'blocking',
      description: `对象在 ${axisText} 方向超过当前打印空间。`,
      evidence: context.objects.map((object) => `${object.name} ${object.dimensionsMm.join(' × ')} mm`).join('；'),
    });
  }
  if (meshBlocking) {
    reasons.push({
      code: 'mesh_quality',
      severity: 'blocking',
      description: '现有检查包含非水密或退化几何，切割前需要先修复。',
      evidence: context.issueMessages.slice(0, 2).join('；'),
    });
  }
  if (context.objectCount > 1) {
    reasons.push({
      code: 'existing_components',
      severity: 'info',
      description: '场景中已经存在多个独立对象，需要先确认它们是否已是预期零件。',
      evidence: `${context.objectCount} 个可见对象`,
    });
  }
  if (evidenceIncomplete) {
    reasons.push({
      code: 'insufficient_evidence',
      severity: 'warning',
      description: '打印检查未完成或已过期，薄壁与局部过悬能力也尚未提供。',
      evidence: `检查状态：${context.checkStatus}`,
    });
  }
  if (!reasons.length) {
    reasons.push({
      code: 'fit_build_volume',
      severity: 'info',
      description: '尺寸与现有打印检查均未给出必须拆件的证据。',
      evidence: `打印空间 ${context.bed.x} × ${context.bed.y} × ${context.bed.z} mm`,
    });
  }

  const schemes = meshBlocking
    ? [
        scheme('repair-first', '先修复，再重新分析', '保留原模型结构，先处理非水密或退化几何。', 1, true,
          ['避免把坏拓扑带入切割', '后续方案可信度更高'], ['暂时不能得到切割预览'], '无需装配', '低', 0.82),
        scheme('component-review', '按现有对象逐件复核', '把当前独立对象视为候选零件，逐件确认是否需要进一步拆分。', context.objectCount,
          false, ['不新增几何修改', '便于定位问题对象'], ['不能替代真正的连通域分析'], '无需装配', '中', 0.58),
      ]
    : needsSplit === 'yes'
      ? [
          scheme('axis-split', `沿 ${axisText} 分段`, `沿超限方向把主体划分为 ${preferredParts} 件，优先解决打印空间约束。`, preferredParts, true,
            ['直接改善床体积适配', '方案容易理解和装配'], ['切面可能穿过外观细节', '必须先做切割预览'], '平面对接', '中', 0.82),
          scheme('natural-seam', '沿结构分界拆分', '优先寻找连接处、装甲缝或截面较小区域，减少可见切痕。', Math.min(preferredParts + 1, 4), false,
            ['更利于保护主要外观面', '装配定位更直观'], ['需要几何候选搜索才能确认', '零件数可能增加'], '定位销（阶段三）', '中', 0.69),
          scheme('orientation-first', '先换朝向，再最少拆分', `先评估 ${process} 打印方向，只在仍超限时做最少数量切割。`, Math.max(2, preferredParts - 1), false,
            ['可能减少零件数', '减少不必要接缝'], ['可能增加支撑', '当前缺少局部过悬数据'], '粘接', '中', 0.61),
        ]
      : [
          scheme('keep-whole', '保持整体打印', `维持当前模型完整性，先以 ${process} 方向和支撑设置优化。`, 1, true,
            ['没有装配误差', '表面连续性最好'], ['复杂悬空仍可能需要较多支撑'], '无需装配', '低', 0.76),
          scheme('two-part-backup', '两件式保守备选', '仅在底部或背面选择低可见度区域做单次分割。', 2, false,
            ['可降低单件高度或支撑压力', '装配复杂度仍较低'], ['增加一道接缝', '需要预览确认切面'], '平面对接', '中', 0.59),
          scheme('orientation-review', '先调整方向再复核', '不立即拆件，先比较主要朝向后重新运行打印检查。', 1, false,
            ['不会产生新零件', '适合先验证支撑风险'], ['当前版本没有方向分析工具'], '无需装配', '低', 0.52),
        ];

  const missingInputs: string[] = [];
  if (context.checkStatus !== 'fresh') missingInputs.push('新鲜的打印检查结果');
  if (context.capabilities.multiviewCapture !== 'available') missingInputs.push('模型多视角截图');

  return {
    schemaVersion: 'split-analysis-output.v1',
    needsSplit,
    confidence,
    summary,
    reasons,
    recommendedPartCount: {
      minimum: needsSplit === 'yes' ? 2 : 1,
      preferred: meshBlocking ? 1 : preferredParts,
      maximum: needsSplit === 'yes' ? Math.min(preferredParts + 1, 5) : 2,
      rationale: meshBlocking
        ? '先保持原件并修复网格，避免过早生成派生零件。'
        : needsSplit === 'yes'
          ? `按最大超限比例估算 ${preferredParts} 件；精确数量需阶段二候选切面验证。`
          : '当前没有必须拆件的尺寸证据，整体打印优先。',
    },
    recommendedRegions: [{
      id: 'region-primary',
      label: context.exceedsBuildVolume ? `${axisText} 方向中部带` : '低可见度结构带',
      description: context.exceedsBuildVolume
        ? '仅描述候选区域，不代表已计算出精确切割平面。'
        : '优先考虑底部、背部或已有结构分界；需阶段二工具确认。',
      candidateType: context.exceedsBuildVolume ? 'plane' : 'unknown',
      confidence: context.exceedsBuildVolume ? 0.64 : 0.42,
    }],
    schemes,
    risks: [
      {
        severity: meshBlocking ? 'blocking' : 'warning',
        title: meshBlocking ? '网格需要先修复' : '切面位置尚未经过几何验证',
        description: meshBlocking
          ? '非水密或退化几何可能造成切割失败、封口异常或导出问题。'
          : '本批只根据尺寸、检查摘要和用户目标生成建议，没有运行真实切割。',
        mitigation: meshBlocking ? '先在网格修复工具中处理，再重新检查和分析。' : '进入阶段二后必须先生成预览，再由用户确认。',
      },
      {
        severity: 'warning',
        title: '薄壁与局部过悬未检测',
        description: '现有“悬空”只表示整个对象离开打印床，不等于局部过悬角分析。',
        mitigation: '当前结果把相关影响标为未知，不据此承诺减少支撑。',
      },
    ],
    nextSteps: meshBlocking
      ? ['先修复非水密或退化几何', '重新运行打印检查', '再生成拆件建议']
      : ['审阅并选择一套候选方案', '阶段二生成只读切割预览', '确认打印方向和装配方式'],
    limitations: {
      missingInputs,
      unavailableCapabilities: ['薄壁分析', '局部过悬分析', '自动切面候选搜索', '装配验证'],
      assumptions: ['当前所有尺寸单位为毫米', '只分析可见且资产就绪的对象', '结果不会修改场景或网格'],
      visualUncertainty: context.capabilities.multiviewCapture === 'not_run' ? 'high' : 'medium',
    },
  };
}
