import { create } from 'zustand';
import { useEffect, useState } from 'react';
import type { CheckIssue } from '../check/check-core';
import { useCheck } from '../check/check-state';
import { dispatch, doc, geometryRegistry, sendCam, useUi, type BedConfig } from '../state/store';
import {
  evaluatePlaneCutCandidate,
  findPlaneCutCandidates,
  type PlaneCutCandidate,
  type WorldBounds,
} from './plane-cut-core';

interface PlaneCutPreviewState {
  phase: 'idle' | 'ready';
  issueKey: string | null;
  instanceId: string | null;
  candidates: PlaneCutCandidate[];
  activeIndex: number;
  sourceEditVersion: number;
  sourceBed: BedConfig | null;
  sourceBounds: WorldBounds | null;
}

const initialState: PlaneCutPreviewState = {
  phase: 'idle',
  issueKey: null,
  instanceId: null,
  candidates: [],
  activeIndex: 0,
  sourceEditVersion: -1,
  sourceBed: null,
  sourceBounds: null,
};

export const usePlaneCutPreview = create<PlaneCutPreviewState>()(() => initialState);

/** 与打印检查状态相同的 SSR 安全快照，便于产品卡片和服务端冒烟读取运行时预览态。 */
export function usePlaneCutPreviewSnapshot(): PlaneCutPreviewState {
  const [state, setState] = useState(() => usePlaneCutPreview.getState());
  useEffect(() => {
    setState(usePlaneCutPreview.getState());
    return usePlaneCutPreview.subscribe(setState);
  }, []);
  return state;
}

function sameBed(a: BedConfig | null, b: BedConfig): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.z === b.z;
}

export function planeCutPreviewIsStale(): boolean {
  const state = usePlaneCutPreview.getState();
  return state.phase === 'ready' && (
    state.sourceEditVersion !== doc.editVersion
    || !sameBed(state.sourceBed, useUi.getState().bed)
    || !state.instanceId
    || !doc.nodes.has(state.instanceId)
  );
}

export function startPlaneCutPreview(issue: CheckIssue): boolean {
  const instance = doc.nodes.get(issue.instanceId);
  if (issue.code !== 'dims' || !issue.world || !instance || instance.kind !== 'instance') return false;
  if (!geometryRegistry.has(instance.assetId)) return false;
  const bed = { ...useUi.getState().bed };
  const candidates = findPlaneCutCandidates(issue.world, bed);
  if (!candidates.length) return false;
  usePlaneCutPreview.setState({
    phase: 'ready',
    issueKey: issue.key,
    instanceId: issue.instanceId,
    candidates,
    activeIndex: 0,
    sourceEditVersion: doc.editVersion,
    sourceBed: bed,
    sourceBounds: {
      min: [...issue.world.min] as [number, number, number],
      max: [...issue.world.max] as [number, number, number],
    },
  });
  useCheck.setState({ activeKey: issue.key, activeEvidenceIndex: 0 });
  if (!doc.effectiveLocked(issue.instanceId)) dispatch((d) => d.select([issue.instanceId]));
  sendCam({ kind: 'focusBounds', min: issue.world.min, max: issue.world.max });
  return true;
}

/** 调整当前轴切面位置；只替换临时候选，不改场景、不写历史。 */
export function setPlaneCutPosition(requestedPosition: number): boolean {
  const state = usePlaneCutPreview.getState();
  if (
    state.phase !== 'ready'
    || !state.sourceBounds
    || !state.sourceBed
    || planeCutPreviewIsStale()
  ) return false;
  const active = state.candidates[state.activeIndex];
  if (!active) return false;
  const next = evaluatePlaneCutCandidate(state.sourceBounds, state.sourceBed, active.axis, requestedPosition);
  const candidates = [...state.candidates];
  candidates[state.activeIndex] = next;
  usePlaneCutPreview.setState({ candidates });
  return true;
}

export function selectPlaneCutCandidate(requestedIndex: number): boolean {
  const state = usePlaneCutPreview.getState();
  if (state.phase !== 'ready' || !state.candidates.length || planeCutPreviewIsStale()) return false;
  const activeIndex = ((requestedIndex % state.candidates.length) + state.candidates.length) % state.candidates.length;
  usePlaneCutPreview.setState({ activeIndex });
  const candidate = state.candidates[activeIndex];
  const min = [...candidate.parts[0].bounds.min] as [number, number, number];
  const max = [...candidate.parts[1].bounds.max] as [number, number, number];
  const pad = Math.max(...max.map((value, axis) => value - min[axis]), 1) * 0.08;
  sendCam({
    kind: 'focusBounds',
    min: [min[0] - pad, min[1] - pad, Math.max(0, min[2] - pad)],
    max: [max[0] + pad, max[1] + pad, max[2] + pad],
  });
  return true;
}

export function closePlaneCutPreview(): void {
  usePlaneCutPreview.setState(initialState);
}
