import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualPlaneSplitPanel } from '../src/split/ManualPlaneSplitPanel';
import {
  cancelManualPlaneSplit,
  useManualPlaneSplit,
} from '../src/split/manual-plane-split-state';
import { useFacePaint } from '../src/split/face-paint-state';
import {
  resetSurfaceWorkflowMode,
  setSurfaceWorkflowMode,
} from '../src/split/surface-workflow-state';

afterEach(() => {
  cancelManualPlaneSplit();
  resetSurfaceWorkflowMode();
});

describe('ManualPlaneSplitPanel SSR', () => {
  it('uses viewport XYZ handles for movement and keeps rotation plus linked size in the sidebar', () => {
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'plane',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [10, 20, 30],
      rotation: [0, 0, 0],
      size: [120, 140],
      sizeLinked: true,
      bounds: { min: [0, 0, 0], max: [40, 50, 60] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
      surfaceBandMm: 12,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [],
      surfaceGuideClosed: false,
      surfaceResult: null,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('真实几何操作');
    expect(html).toContain('平面切割');
    expect(html).toContain('源模型保持不变');
    expect(html).toContain('切割轴');
    expect(html).toContain('按住画布箭头即可移动');
    expect(html).toContain('箭头使用加大命中区');
    expect(html).toContain('X 左右');
    expect(html).toContain('Y 前后');
    expect(html).toContain('Z 上下');
    expect(html).toContain('宽高联动');
    expect(html).toContain('切割框大小');
    expect(html).toContain('实际切割按无限平面计算');
    expect(html).toContain('确认切割');
    expect(html).toContain('W');
    expect(html).toContain('E');
    expect(html).toContain('R');
  });

  it('uses the hybrid click-and-draw surface stroke as the default M1.12b workflow', () => {
    setSurfaceWorkflowMode('stroke');
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [100, 100],
      sizeLinked: true,
      bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
      surfaceBandMm: 12,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [
        [-20, 0, 10],
        [0, 18, 12],
        [20, 0, 10],
      ],
      surfaceGuideClosed: false,
      surfaceResult: null,
    }, true);

    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);
    expect(html).toContain('M1.12b · 多视角切割笔');
    expect(html).toContain('画一段，转一下，继续画');
    expect(html).toContain('单击放点，按住拖动自由画');
    expect(html).toContain('松手只暂停，不会自动闭合');
    expect(html).toContain('最后点击黄色起点闭合');
    expect(html).toContain('开放笔迹');
    expect(html).toContain('切割笔');
    expect(html).toContain('面组实验');
    expect(html).toContain('M1.11g');
    expect(html).toContain('等待闭合切口');
    expect(html).toContain('撤销上一段');
    expect(html).not.toContain('涂出要拆下的部分');
  });

  it('enables real A/B preview only after the M1.12b guide is explicitly closed', () => {
    setSurfaceWorkflowMode('stroke');
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [100, 100],
      sizeLinked: true,
      bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
      surfaceBandMm: 12,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [
        [-20, 0, 10],
        [0, 18, 12],
        [20, 0, 10],
      ],
      surfaceGuideClosed: true,
      surfaceResult: null,
    }, true);

    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);
    expect(html).toContain('闭环已完成，可以生成预览');
    expect(html).toContain('生成 A/B 预览');
    expect(html).toContain('继续编辑切口');
    expect(html).not.toContain('等待闭合切口');
  });

  it('uses a Blender-like face-set painting workflow instead of point and plane controls', () => {
    setSurfaceWorkflowMode('facePaint');
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [10, 20, 30],
      rotation: [0, 90, 0],
      size: [120, 120],
      sizeLinked: true,
      bounds: { min: [-60, -60, -60], max: [60, 60, 60] },
      mode: 'translate',
      axis: 'x',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
      surfaceBandMm: 15,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [
        [-20, 0, 10],
        [0, 20, 10],
        [20, 0, 10],
      ],
      surfaceGuideClosed: false,
      surfaceResult: null,
    }, true);
    useFacePaint.setState({
      active: true,
      instanceId: 'missing',
      assetId: 'missing',
      mode: 'add',
      brushRadiusMm: 18,
      paintedFaceCount: 230,
      totalFaceCount: 1000,
      strokeCount: 3,
      boundarySegmentCount: 42,
      boundaryStatus: 'ready',
      seamStatus: 'idle',
      seamResult: null,
      seamProgress: '',
      seamError: null,
      seamDurationMs: null,
      seamAnchorPlacement: false,
      seamAnchorLocal: null,
      seamChoices: [],
      seamChoiceIndex: 0,
      maskRevision: 1,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('M1.11g');
    expect(html).toContain('涂出要拆下的部分');
    expect(html).toContain('添加到面组');
    expect(html).toContain('擦除');
    expect(html).toContain('画笔大小');
    expect(html).toContain('230');
    expect(html).toContain('撤销上一笔');
    expect(html).toContain('生成接缝预览');
    expect(html).toContain('先生成只读接缝并检查风险');
    expect(html).not.toContain('左键添加点');
    expect(html).not.toContain('闭合并生成预览');
    expect(html).not.toContain('高级：贴线半径');
    expect(html).not.toContain('切割轴');
    expect(html).not.toContain('XYZ 欧拉角');
    expect(html).not.toContain('切割框大小');
    expect(html).not.toContain('W/E/R');
  });

  it('reports high-poly smooth mode without presenting a fake real-cut action', () => {
    setSurfaceWorkflowMode('facePaint');
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [10, 20, 30],
      rotation: [0, 90, 0],
      size: [120, 120],
      sizeLinked: true,
      bounds: { min: [-60, -60, -60], max: [60, 60, 60] },
      mode: 'translate',
      axis: 'x',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: 18,
      surfaceBandMm: 16,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [
        [-20, 0, 10],
        [0, 20, 10],
        [20, 0, 10],
        [0, -20, 10],
      ],
      surfaceGuideClosed: false,
      surfaceResult: null,
    }, true);
    useFacePaint.setState({
      active: true,
      instanceId: 'missing',
      assetId: 'missing',
      mode: 'erase',
      brushRadiusMm: 9,
      paintedFaceCount: 120_000,
      totalFaceCount: 500_000,
      strokeCount: 8,
      boundarySegmentCount: 0,
      boundaryStatus: 'budget',
      seamStatus: 'idle',
      seamResult: null,
      seamProgress: '',
      seamError: null,
      seamDurationMs: null,
      seamAnchorPlacement: false,
      seamAnchorLocal: [12, 4, 8],
      seamChoices: [],
      seamChoiceIndex: 0,
      maskRevision: 2,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('高面数 · 多壳体关节模式');
    expect(html).toContain('模型总面');
    expect(html).toContain('局部接缝');
    expect(html).toContain('第 2 步 · 指定切口位置');
    expect(html).toContain('青色定位点已设置');
    expect(html).toContain('生成候选接缝');
    expect(html).not.toContain('确认拆分为 A / B');
  });

  it('shows the verified seam metrics and exposes the real A/B preview action', () => {
    setSurfaceWorkflowMode('facePaint');
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [100, 100],
      sizeLinked: true,
      bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
      surfaceBandMm: 12,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [],
      surfaceGuideClosed: false,
      surfaceResult: null,
    }, true);
    useFacePaint.setState({
      active: true,
      instanceId: 'missing',
      assetId: 'missing',
      mode: 'add',
      brushRadiusMm: 10,
      paintedFaceCount: 20,
      totalFaceCount: 100,
      strokeCount: 2,
      boundarySegmentCount: 12,
      boundaryStatus: 'ready',
      seamStatus: 'ready',
      seamResult: {
        status: 'ready',
        loopPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        issues: [],
        warnings: [],
        metrics: {
          paintedFaces: 20,
          remainingFaces: 80,
          paintedRatio: 0.2,
          boundaryVertices: 12,
          seamLengthMm: 45.2,
          maxPlanarityDeviationMm: 0.08,
          selectionMinDimensionMm: 8,
          selectionMaxDimensionMm: 30,
          componentCount: 1,
        },
      },
      seamProgress: '',
      seamError: null,
      seamDurationMs: 12,
      completionSummary: {
        candidateCount: 4,
        branchPoints: 6,
        roughFaces: 20,
        completedFaces: 28,
        addedFaces: 8,
        removedFaces: 0,
        matchPercent: 92,
        seamEdges: 12,
        seamLengthLocal: 45.2,
        searchMode: 'seed_growth',
        growthRings: 32,
        splitMode: 'hybrid',
        sourceShellCount: 6,
        selectedShellCount: 4,
        fullShellFaces: 12_000,
        bridgeShellFaces: 16,
        anchorDistanceMm: 2.4,
      },
      seamAnchorPlacement: false,
      seamAnchorLocal: [12, 4, 8],
      seamChoices: [],
      seamChoiceIndex: 0,
      maskRevision: 3,
    }, true);
    const readyPaint = useFacePaint.getState();
    useFacePaint.setState({
      seamChoices: [
        {
          result: readyPaint.seamResult!,
          faceLabels: new Uint8Array(100),
          completion: readyPaint.completionSummary!,
        },
        {
          result: readyPaint.seamResult!,
          faceLabels: new Uint8Array(100),
          completion: {
            ...readyPaint.completionSummary!,
            anchorDistanceMm: 4.8,
            optionIndex: 1,
            optionCount: 2,
          },
        },
      ],
      seamChoiceIndex: 1,
    });

    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);
    expect(html).toContain('接缝预览');
    expect(html).toContain('完整壳体与关节接缝已合并');
    expect(html).toContain('4 壳体 + 1 接缝');
    expect(html).toContain('完整壳体直接分组，桥接壳体生长 32 层并选择关节环');
    expect(html).toContain('新增隐藏面 8');
    expect(html).toContain('匹配度 92%');
    expect(html).toContain('距定位点 2.4 mm');
    expect(html).toContain('选择接缝方案');
    expect(html).toContain('方案 1');
    expect(html).toContain('方案 2');
    expect(html).toContain('距定位点 4.8 mm');
    expect(html).toContain('12');
    expect(html).toContain('45.2');
    expect(html).toContain('0.08');
    expect(html).toContain('返回修改面组');
    expect(html).toContain('生成真实 A/B 预览');
    expect(html).toContain('拆下件（紫）/ 保留件（绿）');
    expect(html).toContain('此时没有修改模型');
  });

  it('explains shell-only grouping without pretending that a green seam exists', () => {
    setSurfaceWorkflowMode('facePaint');
    useManualPlaneSplit.setState({
      phase: 'editing',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [100, 100],
      sizeLinked: true,
      bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
      surfaceBandMm: 12,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [],
      surfaceGuideClosed: false,
      surfaceResult: null,
    }, true);
    useFacePaint.setState({
      active: true,
      instanceId: 'missing',
      assetId: 'missing',
      mode: 'add',
      brushRadiusMm: 10,
      paintedFaceCount: 12_000,
      totalFaceCount: 100_000,
      strokeCount: 2,
      boundarySegmentCount: 0,
      boundaryStatus: 'budget',
      seamStatus: 'ready',
      seamResult: {
        status: 'ready',
        loopPositions: new Float32Array(0),
        issues: [],
        warnings: [],
        metrics: {
          paintedFaces: 12_000,
          remainingFaces: 88_000,
          paintedRatio: 0.12,
          boundaryVertices: 0,
          seamLengthMm: 0,
          maxPlanarityDeviationMm: 0,
          selectionMinDimensionMm: 0,
          selectionMaxDimensionMm: 0,
          componentCount: 4,
        },
      },
      seamProgress: '',
      seamError: null,
      seamDurationMs: 12,
      completionSummary: {
        candidateCount: 0,
        branchPoints: 0,
        roughFaces: 2_400,
        completedFaces: 12_000,
        addedFaces: 9_600,
        removedFaces: 0,
        matchPercent: 100,
        seamEdges: 0,
        seamLengthLocal: 0,
        searchMode: 'rough_boundary',
        growthRings: 0,
        splitMode: 'shells',
        sourceShellCount: 9,
        selectedShellCount: 4,
        fullShellFaces: 12_000,
        bridgeShellFaces: 0,
      },
      seamAnchorPlacement: false,
      seamAnchorLocal: [0, 0, 0],
      seamChoices: [],
      seamChoiceIndex: 0,
      maskRevision: 3,
    }, true);

    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);
    expect(html).toContain('独立壳体预览');
    expect(html).toContain('4 个壳体');
    expect(html).toContain('无需切割即可拆件');
    expect(html).toContain('只做 A/B 分组，不新增切口或封口');
    expect(html).toContain('9');
    expect(html).toContain('12,000');
    expect(html).toContain('只读壳体分组');
    expect(html).not.toContain('绿色粗线');
  });

  it('shows explicit purple-detached and green-kept semantics before final confirmation', () => {
    setSurfaceWorkflowMode('facePaint');
    useManualPlaneSplit.setState({
      phase: 'previewReady',
      cutKind: 'surface',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [100, 100],
      sizeLinked: true,
      bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: 23,
      surfaceBandMm: 12,
      surfacePreference: 'balanced',
      surfaceGuidePoints: [],
      surfaceGuideClosed: true,
      surfaceResult: {
        status: 'ready',
        partA: {
          positions: new Float32Array(9),
          sourceFaceCount: 20,
          capFaceCount: 10,
          boundaryEdges: 0,
          dimensionsMm: [20, 30, 40],
        },
        partB: {
          positions: new Float32Array(9),
          sourceFaceCount: 80,
          capFaceCount: 10,
          boundaryEdges: 0,
          dimensionsMm: [60, 70, 80],
        },
        seamPositions: new Float32Array(6),
        metrics: {
          sourceFaces: 100,
          partAFaces: 30,
          partBFaces: 90,
          boundaryVertices: 12,
          seamLengthMm: 45,
          guideOffsetMm: 0,
          adaptiveSpanMm: 0,
          meanCreaseDeg: 20,
          searchHalfWidthMm: 0.1,
          maxCapDeviationMm: 0.08,
          capWarpRatio: 0.01,
          preference: 'balanced',
        },
        warnings: [],
      },
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);
    expect(html).toContain('真实 A/B 已生成');
    expect(html).toContain('拆下件 A · 紫色');
    expect(html).toContain('保留件 B · 绿色');
    expect(html).toContain('确认创建两个模型');
    expect(html).toContain('确认前源模型仍保留');
  });
});
