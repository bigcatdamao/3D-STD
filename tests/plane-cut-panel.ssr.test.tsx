import * as THREE from 'three';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckPanel } from '../src/check/CheckPanel';
import { useCheck } from '../src/check/check-state';
import type { CheckIssue } from '../src/check/check-core';
import { dispatch, doc, useUi } from '../src/state/store';
import { findPlaneCutCandidates } from '../src/split/plane-cut-core';
import { closePlaneCutPreview, usePlaneCutPreview } from '../src/split/plane-cut-state';
import { analyzePlaneSection } from '../src/split/plane-section-core';

const strip = (html: string) => html.replace(/<!-- -->/g, '');

describe('M1.7.6 真实截面证据卡片 SSR', () => {
  const asset = dispatch((scene) => scene.addAsset({
    name: '300mm 单壳',
    source: 'import',
    state: 'ready',
    meta: {
      faces: 12,
      bbox: { min: [-150, -40, 0], max: [150, 40, 80] },
      unitChoice: 'mm',
      watertight: true,
      degenerate: false,
    },
  }));
  const instance = dispatch((scene) => scene.placeInstance(asset.id));
  const world = { min: [-150, -40, 0] as [number, number, number], max: [150, 40, 80] as [number, number, number] };
  const sectionGeometry = new THREE.BoxGeometry(300, 80, 80).translate(0, 0, 40);
  const section = analyzePlaneSection({
    positions: sectionGeometry.getAttribute('position').array,
    index: sectionGeometry.index?.array ?? null,
    transform: instance.transform,
    axisIndex: 0,
    positionMm: 0,
  });
  sectionGeometry.dispose();
  const issues: CheckIssue[] = [
    {
      key: `out_of_bed:${instance.id}`,
      level: 'error',
      code: 'out_of_bed',
      instanceId: instance.id,
      instanceName: '300mm 单壳',
      assetId: asset.id,
      message: '超出打印体积',
      world,
    },
    {
      key: `dims:${instance.id}`,
      level: 'info',
      code: 'dims',
      instanceId: instance.id,
      instanceName: '300mm 单壳',
      assetId: asset.id,
      message: '300.0 × 80.0 × 80.0 mm · 12 面',
      world,
    },
  ];
  useCheck.setState({
    panelOpen: true,
    phase: 'done',
    issues,
    assetMetas: [],
    summary: { instances: 1, errors: 1, warnings: 0, totalFaces: 12, assetsAnalyzed: 1, assetsCached: 0, durationMs: 1 },
    unfinished: [],
    timedOut: false,
    fixedKeys: [],
    runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
  });

  it('单壳超床对象显示 3 个本地候选入口与只读边界', () => {
    closePlaneCutPreview();
    const html = strip(renderToString(<CheckPanel embedded />));
    expect(html).toContain('平面切割候选');
    expect(html).toContain('本地确定性 · 3 个');
    expect(html).toContain('查看 3 个候选');
    expect(html).toContain('只读预览');
  });

  it('预览态显示 A/B 尺寸、床适配和不生成零件说明', () => {
    usePlaneCutPreview.setState({
      phase: 'ready',
      issueKey: `dims:${instance.id}`,
      instanceId: instance.id,
      candidates: findPlaneCutCandidates(world, useUi.getState().bed),
      sections: [section, null, null],
      activeIndex: 0,
      sourceEditVersion: doc.editVersion,
      sourceBed: { ...useUi.getState().bed },
      sourceBounds: world,
    });
    const html = strip(renderToString(<CheckPanel embedded />));
    expect(html).toContain('type="range"');
    expect(html).toContain('value="50"');
    expect(html).toContain('15%');
    expect(html).toContain('85%');
    expect(html).toContain('X 中线');
    expect(html).toContain('150.0 × 80.0 × 80.0 mm');
    expect(html.match(/class="fits">可放入/g)?.length).toBe(2);
    expect(html).toContain('真实截面证据');
    expect(html).toContain('6400 mm²');
    expect(html).toContain('1 个闭合环');
    expect(html).toContain('当前仍不封口、不生成零件');
    closePlaneCutPreview();
  });
});
