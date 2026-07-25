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

  it('separates surface coarse positioning from the automatic on-surface seam step', () => {
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
      surfaceResult: null,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('第 1 步 · 粗定位');
    expect(html).toContain('曲面切割定位');
    expect(html).toContain('平面只负责确定大概位置');
    expect(html).toContain('这里不会沿平面直接切');
    expect(html).toContain('点击生成后会发生什么');
    expect(html).toContain('沿模型表面自动寻找一条闭合接缝');
    expect(html).toContain('高级：自动寻缝范围');
    expect(html).toContain('通常无需修改');
    expect(html).toContain('生成表面闭合接缝');
  });

  it('replaces plane controls with a readable validated seam review after preview succeeds', () => {
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

    expect(html).toContain('第 2 步 · 表面接缝');
    expect(html).toContain('曲面接缝预览');
    expect(html).toContain('平面定位已经结束');
    expect(html).toContain('表面闭合接缝');
    expect(html).toContain('接缝与双侧封口验证通过');
    expect(html).toContain('8');
    expect(html).toContain('88.0');
    expect(html).toContain('返回重新定位');
    expect(html).toContain('确认曲面切割');
    expect(html).toContain('暂不提供接缝控制点');
    expect(html).not.toContain('切割框大小');
    expect(html).not.toContain('高级：自动寻缝范围');
  });
});
