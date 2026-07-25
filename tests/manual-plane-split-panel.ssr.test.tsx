import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualPlaneSplitPanel } from '../src/split/ManualPlaneSplitPanel';
import {
  cancelManualPlaneSplit,
  useManualPlaneSplit,
} from '../src/split/manual-plane-split-state';

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
      surfaceResult: null,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('真实几何操作');
    expect(html).toContain('平面切割');
    expect(html).toContain('源模型保持不变');
    expect(html).toContain('切割轴');
    expect(html).toContain('移动使用画布手柄');
    expect(html).toContain('红 X、绿 Y、蓝 Z 箭头');
    expect(html).toContain('宽高联动');
    expect(html).toContain('切割框大小');
    expect(html).toContain('实际切割按无限平面计算');
    expect(html).toContain('确认切割');
    expect(html).toContain('W');
    expect(html).toContain('E');
    expect(html).toContain('R');
  });

  it('shows the surface guide band, seam preferences, preview gate, and validated result metrics', () => {
    useManualPlaneSplit.setState({
      phase: 'previewReady',
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
      surfaceResult: {
        status: 'ready',
        partA: {
          positions: new Float32Array(0),
          sourceFaceCount: 20,
          capFaceCount: 6,
          boundaryEdges: 0,
          dimensionsMm: [40, 40, 40],
        },
        partB: {
          positions: new Float32Array(0),
          sourceFaceCount: 22,
          capFaceCount: 6,
          boundaryEdges: 0,
          dimensionsMm: [40, 40, 40],
        },
        seamPositions: new Float32Array(0),
        metrics: {
          sourceFaces: 42,
          partAFaces: 26,
          partBFaces: 28,
          boundaryVertices: 8,
          seamLengthMm: 88,
          guideOffsetMm: 2,
          adaptiveSpanMm: 3,
          meanCreaseDeg: 21,
          searchHalfWidthMm: 16,
          maxCapDeviationMm: 0.4,
          capWarpRatio: 0.02,
          preference: 'balanced',
        },
        warnings: [],
      },
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('曲面切割');
    expect(html).toContain('表面吸附');
    expect(html).toContain('均衡');
    expect(html).toContain('最短');
    expect(html).toContain('贴折痕');
    expect(html).toContain('闭环与双侧封口已通过');
    expect(html).toContain('确认曲面切割');
  });
});
