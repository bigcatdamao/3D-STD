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
import { analyzePlaneSection, type PlaneSectionAnalysis } from './plane-section-core';

interface PlaneCutPreviewState {
  phase: 'idle' | 'ready';
  issueKey: string | null;
  instanceId: string | null;
  candidates: PlaneCutCandidate[];
  sections: (PlaneSectionAnalysis | null)[];
  sectionPending: boolean[];
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
  sections: [],
  sectionPending: [],
  activeIndex: 0,
  sourceEditVersion: -1,
  sourceBed: null,
  sourceBounds: null,
};

export const usePlaneCutPreview = create<PlaneCutPreviewState>()(() => initialState);
const sectionTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearSectionTimers(): void {
  sectionTimers.forEach((timer) => clearTimeout(timer));
  sectionTimers.clear();
}

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

function analyzeCandidateSection(instanceId: string, candidate: PlaneCutCandidate): PlaneSectionAnalysis | null {
  const instance = doc.nodes.get(instanceId);
  if (!instance || instance.kind !== 'instance') return null;
  const geometry = geometryRegistry.get(instance.assetId);
  const positions = geometry?.getAttribute('position');
  if (!positions) return null;
  return analyzePlaneSection({
    positions: positions.array,
    index: geometry?.index?.array ?? null,
    transform: instance.transform,
    axisIndex: candidate.axisIndex,
    positionMm: candidate.positionMm,
  });
}

export function startPlaneCutPreview(issue: CheckIssue): boolean {
  const instance = doc.nodes.get(issue.instanceId);
  if (issue.code !== 'dims' || !issue.world || !instance || instance.kind !== 'instance') return false;
  if (!geometryRegistry.has(instance.assetId)) return false;
  const bed = { ...useUi.getState().bed };
  const candidates = findPlaneCutCandidates(issue.world, bed);
  if (!candidates.length) return false;
  const sections: (PlaneSectionAnalysis | null)[] = candidates.map(() => null);
  sections[0] = analyzeCandidateSection(issue.instanceId, candidates[0]);
  clearSectionTimers();
  usePlaneCutPreview.setState({
    phase: 'ready',
    issueKey: issue.key,
    instanceId: issue.instanceId,
    candidates,
    sections,
    sectionPending: candidates.map(() => false),
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

/** 调整当前轴切面位置；滑杆可延后截面扫描，AABB 与切面位置始终立即刷新。 */
export function setPlaneCutPosition(requestedPosition: number, deferSection = false): boolean {
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
  const sections = [...state.sections];
  const sectionPending = [...state.sectionPending];
  candidates[state.activeIndex] = next;
  const sectionIndex = state.activeIndex;
  const oldTimer = sectionTimers.get(sectionIndex);
  if (oldTimer) clearTimeout(oldTimer);
  sectionTimers.delete(sectionIndex);
  if (!deferSection) {
    sections[sectionIndex] = analyzeCandidateSection(state.instanceId!, next);
    sectionPending[sectionIndex] = false;
    usePlaneCutPreview.setState({ candidates, sections, sectionPending });
    return true;
  }
  sections[sectionIndex] = null;
  sectionPending[sectionIndex] = true;
  usePlaneCutPreview.setState({ candidates, sections, sectionPending });
  const timer = setTimeout(() => {
    sectionTimers.delete(sectionIndex);
    const latest = usePlaneCutPreview.getState();
    const latestCandidate = latest.candidates[sectionIndex];
    if (
      latest.phase !== 'ready'
      || planeCutPreviewIsStale()
      || !latestCandidate
      || latestCandidate.axis !== next.axis
      || latestCandidate.normalizedPosition !== next.normalizedPosition
      || !latest.instanceId
    ) {
      if (latest.phase === 'ready' && latest.sectionPending[sectionIndex]) {
        const nextPending = [...latest.sectionPending];
        nextPending[sectionIndex] = false;
        usePlaneCutPreview.setState({ sectionPending: nextPending });
      }
      return;
    }
    const nextSections = [...latest.sections];
    const nextPending = [...latest.sectionPending];
    nextSections[sectionIndex] = analyzeCandidateSection(latest.instanceId, latestCandidate);
    nextPending[sectionIndex] = false;
    usePlaneCutPreview.setState({ sections: nextSections, sectionPending: nextPending });
  }, 90);
  sectionTimers.set(sectionIndex, timer);
  return true;
}

export function selectPlaneCutCandidate(requestedIndex: number): boolean {
  const state = usePlaneCutPreview.getState();
  if (state.phase !== 'ready' || !state.candidates.length || planeCutPreviewIsStale()) return false;
  const activeIndex = ((requestedIndex % state.candidates.length) + state.candidates.length) % state.candidates.length;
  const candidate = state.candidates[activeIndex];
  const sections = [...state.sections];
  const sectionPending = [...state.sectionPending];
  if (!sections[activeIndex] && !sectionPending[activeIndex]) {
    sections[activeIndex] = analyzeCandidateSection(state.instanceId!, candidate);
  }
  usePlaneCutPreview.setState({ activeIndex, sections, sectionPending });
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
  clearSectionTimers();
  usePlaneCutPreview.setState(initialState);
}
