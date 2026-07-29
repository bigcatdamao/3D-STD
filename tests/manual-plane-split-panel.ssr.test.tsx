import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualPlaneSplitPanel } from '../src/split/ManualPlaneSplitPanel';
import {
  cancelManualPlaneSplit,
  useManualPlaneSplit,
} from '../src/split/manual-plane-split-state';
import { useFacePaint } from '../src/split/face-paint-state';

afterEach(cancelManualPlaneSplit);

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

  it('uses a Blender-like face-set painting workflow instead of point and plane controls', () => {
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
      maskRevision: 1,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('M1.11b');
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
      maskRevision: 2,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('高面数流畅模式');
    expect(html).toContain('仅显示色块');
    expect(html).toContain('暂不计算黄色边界和闭环接缝');
    expect(html).toContain('生成接缝预览');
    expect(html).not.toContain('确认拆分为 A / B');
  });

  it('shows the verified seam metrics and exposes the real A/B preview action', () => {
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
      maskRevision: 3,
    }, true);

    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);
    expect(html).toContain('接缝预览');
    expect(html).toContain('接缝拓扑通过');
    expect(html).toContain('12');
    expect(html).toContain('45.2');
    expect(html).toContain('0.08');
    expect(html).toContain('返回修改面组');
    expect(html).toContain('生成真实 A/B 预览');
    expect(html).toContain('拆下件（紫）/ 保留件（绿）');
    expect(html).toContain('此时没有修改模型');
  });

  it('shows explicit purple-detached and green-kept semantics before final confirmation', () => {
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
