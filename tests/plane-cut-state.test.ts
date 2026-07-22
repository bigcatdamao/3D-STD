import { afterAll, describe, expect, it } from 'vitest';
import type { CheckIssue } from '../src/check/check-core';
import {
  bootstrapPlaneCutPreviewQaScene,
  doc,
  useUi,
} from '../src/state/store';
import {
  closePlaneCutPreview,
  planeCutPreviewIsStale,
  selectPlaneCutCandidate,
  startPlaneCutPreview,
  usePlaneCutPreview,
} from '../src/split/plane-cut-state';

const issue: CheckIssue = {
  key: 'dims:ins_qa_plane_cut_preview',
  level: 'info',
  code: 'dims',
  instanceId: 'ins_qa_plane_cut_preview',
  instanceName: '300mm 单壳 · 平面切割预览',
  assetId: 'ast_qa_plane_cut_preview',
  message: '300.0 × 80.0 × 80.0 mm · 12 面',
  world: { min: [-150, -40, 0], max: [150, 40, 80] },
};

describe('M1.7.4 平面切割只读状态', () => {
  bootstrapPlaneCutPreviewQaScene();

  it('开启和切换候选不改变编辑版本或历史', () => {
    const before = {
      editVersion: doc.editVersion,
      historyPosition: doc.history.position,
      historyLength: doc.history.length,
    };
    expect(startPlaneCutPreview(issue)).toBe(true);
    expect(usePlaneCutPreview.getState().candidates).toHaveLength(3);
    expect(usePlaneCutPreview.getState().activeIndex).toBe(0);
    expect(selectPlaneCutCandidate(1)).toBe(true);
    expect(usePlaneCutPreview.getState().activeIndex).toBe(1);
    expect(doc.editVersion).toBe(before.editVersion);
    expect(doc.history.position).toBe(before.historyPosition);
    expect(doc.history.length).toBe(before.historyLength);
  });

  it('床尺寸改变后预览立即过期，避免展示旧适配结论', () => {
    const oldBed = { ...useUi.getState().bed };
    useUi.getState().setBed({ x: 180, y: 180, z: 180 });
    expect(planeCutPreviewIsStale()).toBe(true);
    useUi.getState().setBed(oldBed);
  });
});

afterAll(() => closePlaneCutPreview());

