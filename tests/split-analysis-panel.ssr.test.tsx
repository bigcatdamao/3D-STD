import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SplitAnalysisPanel } from '../src/agent/SplitAnalysisPanel';
import { buildMockSplitAnalysis } from '../src/agent/split-analysis-logic';
import { DEFAULT_SPLIT_GOAL, useSplitAnalysis } from '../src/agent/split-analysis-state';
import type { SplitAnalysisContext } from '../src/agent/split-analysis-types';
import { useCheck } from '../src/check/check-state';

const strip = (html: string) => html.replace(/<!-- -->/g, '');

const context: SplitAnalysisContext = {
  sceneEditVersion: 0,
  goal: DEFAULT_SPLIT_GOAL,
  priorities: ['fit_build_volume', 'reduce_support'],
  process: 'fdm',
  bed: { x: 256, y: 256, z: 256 },
  objectCount: 1,
  selectedObjectCount: 0,
  currentPartCount: 1,
  combinedDimensionsMm: [620, 80, 70],
  totalFaces: 120,
  checkStatus: 'fresh',
  checkErrors: 0,
  checkWarnings: 0,
  issueCodes: [],
  issueMessages: [],
  objects: [{ id: 'i1', name: '超长支架', dimensionsMm: [620, 80, 70], faces: 120, locked: false }],
  exceedsBuildVolume: true,
  overflowAxes: ['X'],
  capabilities: {
    topology: 'available',
    thinWall: 'unavailable',
    surfaceOverhang: 'unavailable',
    cutCandidates: 'unavailable',
    multiviewCapture: 'not_run',
  },
};

describe('SplitAnalysisPanel SSR', () => {
  it('空态明确只读、Mock 和缺失证据，不提供修改模型动作', () => {
    useCheck.setState({ phase: 'idle', issues: [], summary: null, runMeta: null });
    useSplitAnalysis.setState({
      phase: 'idle',
      goal: DEFAULT_SPLIT_GOAL,
      context: null,
      result: null,
      selectedSchemeId: null,
      resultSource: null,
      provider: null,
      model: null,
      evidenceViews: 0,
      warning: null,
      runMeta: null,
      error: null,
    });
    const html = strip(renderToString(<SplitAnalysisPanel />));
    expect(html).toContain('AI 拆件分析');
    expect(html).toContain('不会修改模型');
    expect(html).toContain('后台配置的模型服务');
    expect(html).toContain('多视角截图');
    expect(html).toContain('薄壁：未检测');
    expect(html).toContain('局部过悬：未检测');
    expect(html).not.toContain('应用切割');
  });

  it('完成态呈现结论、候选方案、风险和阶段二禁用入口', () => {
    const result = buildMockSplitAnalysis(context);
    useSplitAnalysis.setState({
      phase: 'done',
      context,
      result,
      selectedSchemeId: result.schemes[0].id,
      resultSource: 'api',
      provider: 'aihubmix',
      model: 'gpt-5.6-sol',
      evidenceViews: 4,
      latencyMs: 18400,
      totalTokens: 1234,
      warning: null,
      runMeta: null,
      error: null,
    });
    const html = strip(renderToString(<SplitAnalysisPanel />));
    expect(html).toContain('建议拆件');
    expect(html).toContain('AI 分析 · AIHubMix · gpt-5.6-sol · 4 视角');
    expect(html).toContain('18.4 秒');
    expect(html).toContain('1,234 tokens');
    expect(html).toContain('沿 X 分段');
    expect(html).toContain('候选方案');
    expect(html).toContain('风险与下一步');
    expect(html).toContain('立即可做');
    expect(html).toContain('查看打印检查');
    expect(html).toContain('阶段二生成只读切割预览');
    expect(html).toContain('生成切割预览 · 阶段二');
    expect(html).toContain('disabled');
  });
});
