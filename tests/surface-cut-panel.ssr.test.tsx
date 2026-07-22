import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckPanel } from '../src/check/CheckPanel';
import { useCheck } from '../src/check/check-state';
import type { CheckIssue } from '../src/check/check-core';
import { dispatch, doc, useUi } from '../src/state/store';
import { findPlaneCutCandidates } from '../src/split/plane-cut-core';
import { closePlaneCutPreview, usePlaneCutPreview } from '../src/split/plane-cut-state';

const strip = (html: string) => html.replace(/<!-- -->/g, '');

describe('M1.7.8 表面自适应真实切割卡片 SSR', () => {
  const asset = dispatch((scene) => scene.addAsset({
    name: '260mm 表面收腰件',
    source: 'import',
    state: 'ready',
    meta: {
      faces: 224,
      bbox: { min: [-120, -45, 0], max: [140, 45, 90] },
      unitChoice: 'mm',
      watertight: true,
      degenerate: false,
    },
  }));
  const instance = dispatch((scene) => scene.placeInstance(asset.id));
  const world = {
    min: [-120, -45, 0] as [number, number, number],
    max: [140, 45, 90] as [number, number, number],
  };
  const outOfBedIssue: CheckIssue = {
    key: `out_of_bed:${instance.id}`,
    level: 'error',
    code: 'out_of_bed',
    instanceId: instance.id,
    instanceName: '260mm 表面收腰件',
    assetId: asset.id,
    message: '超出打印体积',
    world,
  };
  const issue: CheckIssue = {
    key: `dims:${instance.id}`,
    level: 'info',
    code: 'dims',
    instanceId: instance.id,
    instanceName: '260mm 表面收腰件',
    assetId: asset.id,
    message: '260.0 × 90.0 × 90.0 mm · 224 面',
    world,
  };

  useCheck.setState({
    panelOpen: true,
    phase: 'done',
    issues: [outOfBedIssue, issue],
    assetMetas: [],
    summary: { instances: 1, errors: 1, warnings: 0, totalFaces: 224, assetsAnalyzed: 1, assetsCached: 0, durationMs: 1 },
    unfinished: [],
    timedOut: false,
    fixedKeys: [],
    runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
  });

  afterEach(() => closePlaneCutPreview());

  it('成功态明确显示表面偏移、已封口 A/B 和零开放边，并隐藏平面包围盒代理', () => {
    usePlaneCutPreview.setState({
      phase: 'ready',
      issueKey: issue.key,
      instanceId: instance.id,
      candidates: findPlaneCutCandidates(world, useUi.getState().bed),
      sections: [null, null, null],
      activeIndex: 0,
      sourceEditVersion: doc.editVersion,
      sourceBed: { ...useUi.getState().bed },
      sourceBounds: world,
      surfaceCutPhase: 'ready',
      surfaceCutBandRatio: 0.12,
      surfaceCutDurationMs: 37,
      surfaceCutResult: {
        status: 'ready',
        partA: {
          positions: new Float32Array(0),
          sourceFaceCount: 96,
          capFaceCount: 16,
          boundaryEdges: 0,
          dimensionsMm: [140, 90, 90],
        },
        partB: {
          positions: new Float32Array(0),
          sourceFaceCount: 128,
          capFaceCount: 16,
          boundaryEdges: 0,
          dimensionsMm: [120, 90, 90],
        },
        seamPositions: new Float32Array(0),
        metrics: {
          sourceFaces: 224,
          partAFaces: 112,
          partBFaces: 144,
          boundaryVertices: 16,
          seamLengthMm: 100.5,
          guideOffsetMm: 10,
          adaptiveSpanMm: 0,
          meanCreaseDeg: 28,
          searchHalfWidthMm: 31.2,
        },
        warnings: [],
      },
    });
    const html = strip(renderToString(<CheckPanel embedded />));
    expect(html).toContain('真实表面自适应切割');
    expect(html).toContain('A/B 已封口 · 临时预览');
    expect(html).toContain('X 轴引导中心');
    expect(html).toContain('相对引导偏移');
    expect(html).toContain('+10.0mm');
    expect(html).toContain('16 点');
    expect(html.match(/开放边 0/g)?.length).toBe(2);
    expect(html).toContain('水密单一流形、单闭合接缝、≤80,000 面');
    expect(html).not.toContain('包围盒切面代理');
  });

  it('失败态保留源模型并给出拒绝原因', () => {
    usePlaneCutPreview.setState({
      phase: 'ready',
      issueKey: issue.key,
      instanceId: instance.id,
      candidates: findPlaneCutCandidates(world, useUi.getState().bed),
      sections: [null, null, null],
      activeIndex: 0,
      sourceEditVersion: doc.editVersion,
      sourceBed: { ...useUi.getState().bed },
      sourceBounds: world,
      surfaceCutPhase: 'failed',
      surfaceCutResult: null,
      surfaceCutErrorCode: 'multiple_seams',
      surfaceCutError: '候选边界形成多个闭合环，首版拒绝生成临时零件',
    });
    const html = strip(renderToString(<CheckPanel embedded />));
    expect(html).toContain('本次拒绝生成');
    expect(html).toContain('候选边界形成多个闭合环');
    expect(html).toContain('调整后重试');
  });
});
