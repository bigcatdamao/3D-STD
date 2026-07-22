import { afterAll, describe, expect, it, vi } from 'vitest';
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
  setPlaneCutPosition,
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

describe('M1.7.6 真实截面证据只读状态', () => {
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
    expect(usePlaneCutPreview.getState().sections[0]?.status).toBe('closed');
    expect(usePlaneCutPreview.getState().sections[0]?.areaMm2).toBeCloseTo(6_400, 4);
    expect(selectPlaneCutCandidate(1)).toBe(true);
    expect(usePlaneCutPreview.getState().activeIndex).toBe(1);
    expect(selectPlaneCutCandidate(0)).toBe(true);
    expect(setPlaneCutPosition(0.25)).toBe(true);
    expect(usePlaneCutPreview.getState().candidates[0].normalizedPosition).toBe(0.25);
    expect(usePlaneCutPreview.getState().candidates[0].parts.map((part) => part.dimensionsMm[0])).toEqual([75, 225]);
    expect(usePlaneCutPreview.getState().sections[0]?.areaMm2).toBeCloseTo(6_400, 4);
    expect(selectPlaneCutCandidate(1)).toBe(true);
    expect(setPlaneCutPosition(0.75)).toBe(true);
    expect(selectPlaneCutCandidate(0)).toBe(true);
    expect(usePlaneCutPreview.getState().candidates[0].normalizedPosition).toBe(0.25);
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

  it('滑杆先更新切面与尺寸，停止后再计算真实截面', () => {
    vi.useFakeTimers();
    try {
      expect(startPlaneCutPreview(issue)).toBe(true);
      const beforeHistory = doc.history.length;
      expect(setPlaneCutPosition(0.3, true)).toBe(true);
      expect(usePlaneCutPreview.getState().candidates[0].normalizedPosition).toBe(0.3);
      expect(usePlaneCutPreview.getState().sections[0]).toBeNull();
      expect(usePlaneCutPreview.getState().sectionPending[0]).toBe(true);
      vi.advanceTimersByTime(90);
      expect(usePlaneCutPreview.getState().sectionPending[0]).toBe(false);
      expect(usePlaneCutPreview.getState().sections[0]?.status).toBe('closed');
      expect(usePlaneCutPreview.getState().sections[0]?.areaMm2).toBeCloseTo(6_400, 4);
      expect(doc.history.length).toBe(beforeHistory);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterAll(() => closePlaneCutPreview());
