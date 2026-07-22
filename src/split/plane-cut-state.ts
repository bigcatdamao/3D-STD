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
import { rankSeamRecommendations, type SeamRecommendation, type SeamScanSample } from './seam-recommendation-core';
import { SeamScanRunner } from './seam-scan-runner';
import type { SeamScanCut, SeamScanResult } from './seam-scan-protocol';
import { SurfaceCutRunner } from './surface-cut-runner';
import type { SurfaceCutResult } from './surface-cut-core';

export type SurfaceCutReadyResult = Extract<SurfaceCutResult, { status: 'ready' }>;

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
  recommendationPhase: 'idle' | 'scanning' | 'ready' | 'failed';
  recommendationProgress: { done: number; total: number };
  recommendations: SeamRecommendation[];
  recommendationError: string | null;
  surfaceCutPhase: 'idle' | 'running' | 'ready' | 'failed';
  surfaceCutPhaseText: string;
  surfaceCutBandRatio: number;
  surfaceCutResult: SurfaceCutReadyResult | null;
  surfaceCutError: string | null;
  surfaceCutErrorCode: string | null;
  surfaceCutDurationMs: number | null;
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
  recommendationPhase: 'idle',
  recommendationProgress: { done: 0, total: 27 },
  recommendations: [],
  recommendationError: null,
  surfaceCutPhase: 'idle',
  surfaceCutPhaseText: '',
  surfaceCutBandRatio: 0.12,
  surfaceCutResult: null,
  surfaceCutError: null,
  surfaceCutErrorCode: null,
  surfaceCutDurationMs: null,
};

export const usePlaneCutPreview = create<PlaneCutPreviewState>()(() => initialState);
const sectionTimers = new Map<number, ReturnType<typeof setTimeout>>();
let seamScanRunner: SeamScanRunner | null = null;
let surfaceCutRunner: SurfaceCutRunner | null = null;

function getSeamScanRunner(): SeamScanRunner | null {
  if (seamScanRunner) return seamScanRunner;
  if (typeof Worker === 'undefined') return null;
  seamScanRunner = new SeamScanRunner(() => new Worker(
    new URL('./seam-scan.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as import('./seam-scan-runner').SeamScanWorkerLike);
  return seamScanRunner;
}

function getSurfaceCutRunner(): SurfaceCutRunner | null {
  if (surfaceCutRunner) return surfaceCutRunner;
  if (typeof Worker === 'undefined') return null;
  surfaceCutRunner = new SurfaceCutRunner(() => new Worker(
    new URL('./surface-cut.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as import('./surface-cut-runner').SurfaceCutWorkerLike);
  return surfaceCutRunner;
}

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

function copyAssetGeometry(assetId: string): { positions: ArrayBuffer; index: ArrayBuffer | null } | null {
  const geometry = geometryRegistry.get(assetId);
  const attribute = geometry?.getAttribute('position');
  if (!geometry || !attribute) return null;
  let positions: Float32Array;
  if (!('isInterleavedBufferAttribute' in attribute && attribute.isInterleavedBufferAttribute)
    && attribute.array instanceof Float32Array) {
    positions = attribute.array.slice(0, attribute.count * 3);
  } else {
    positions = new Float32Array(attribute.count * 3);
    for (let index = 0; index < attribute.count; index += 1) {
      positions[index * 3] = attribute.getX(index);
      positions[index * 3 + 1] = attribute.getY(index);
      positions[index * 3 + 2] = attribute.getZ(index);
    }
  }
  const meshIndex = geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : null;
  return {
    positions: positions.buffer as ArrayBuffer,
    index: meshIndex ? meshIndex.buffer as ArrayBuffer : null,
  };
}

function makeSeamScanCuts(bounds: WorldBounds): SeamScanCut[] {
  const axes = [
    { axis: 'x' as const, axisIndex: 0 as const },
    { axis: 'y' as const, axisIndex: 1 as const },
    { axis: 'z' as const, axisIndex: 2 as const },
  ];
  return axes.flatMap(({ axis, axisIndex }) => Array.from({ length: 9 }, (_, offset) => {
    const normalizedPosition = (offset + 1) / 10;
    return {
      id: `${axis}-${Math.round(normalizedPosition * 100)}`,
      axis,
      axisIndex,
      normalizedPosition,
      positionMm: bounds.min[axisIndex]
        + (bounds.max[axisIndex] - bounds.min[axisIndex]) * normalizedPosition,
    };
  }));
}

function scanStillCurrent(instanceId: string, sourceEditVersion: number): boolean {
  const current = usePlaneCutPreview.getState();
  return current.phase === 'ready'
    && current.instanceId === instanceId
    && current.sourceEditVersion === sourceEditVersion
    && !planeCutPreviewIsStale();
}

function resetSurfaceCutState(): void {
  surfaceCutRunner?.cancel();
  usePlaneCutPreview.setState({
    surfaceCutPhase: 'idle',
    surfaceCutPhaseText: '',
    surfaceCutResult: null,
    surfaceCutError: null,
    surfaceCutErrorCode: null,
    surfaceCutDurationMs: null,
  });
}

function surfaceCutStillCurrent(
  instanceId: string,
  sourceEditVersion: number,
  axisIndex: 0 | 1 | 2,
  positionMm: number,
  bandRatio: number,
): boolean {
  const current = usePlaneCutPreview.getState();
  const candidate = current.candidates[current.activeIndex];
  return current.phase === 'ready'
    && current.instanceId === instanceId
    && current.sourceEditVersion === sourceEditVersion
    && candidate?.axisIndex === axisIndex
    && Math.abs((candidate?.positionMm ?? Infinity) - positionMm) < 1e-6
    && Math.abs(current.surfaceCutBandRatio - bandRatio) < 1e-6
    && !planeCutPreviewIsStale();
}

export function setSurfaceCutBandRatio(value: number): void {
  surfaceCutRunner?.cancel();
  usePlaneCutPreview.setState({
    surfaceCutBandRatio: Math.max(0.04, Math.min(0.25, value)),
    surfaceCutPhase: 'idle',
    surfaceCutPhaseText: '',
    surfaceCutResult: null,
    surfaceCutError: null,
    surfaceCutErrorCode: null,
    surfaceCutDurationMs: null,
  });
}

export function startSurfaceAdaptiveCutPreview(): boolean {
  const state = usePlaneCutPreview.getState();
  const candidate = state.candidates[state.activeIndex];
  if (
    state.phase !== 'ready'
    || state.surfaceCutPhase === 'running'
    || !state.instanceId
    || !state.sourceBounds
    || !candidate
    || planeCutPreviewIsStale()
  ) return false;
  const instance = doc.nodes.get(state.instanceId);
  const runner = getSurfaceCutRunner();
  if (!instance || instance.kind !== 'instance' || !runner) {
    usePlaneCutPreview.setState({
      surfaceCutPhase: 'failed',
      surfaceCutError: '当前环境无法启动真实切割 Worker',
      surfaceCutErrorCode: 'worker_unavailable',
    });
    return false;
  }
  const axisLengthMm = state.sourceBounds.max[candidate.axisIndex] - state.sourceBounds.min[candidate.axisIndex];
  const bandRatio = state.surfaceCutBandRatio;
  const searchHalfWidthMm = Math.max(0.1, axisLengthMm * bandRatio);
  const instanceId = state.instanceId;
  const sourceEditVersion = state.sourceEditVersion;
  const guidePositionMm = candidate.positionMm;
  const axisIndex = candidate.axisIndex;
  usePlaneCutPreview.setState({
    surfaceCutPhase: 'running',
    surfaceCutPhaseText: '准备源网格',
    surfaceCutResult: null,
    surfaceCutError: null,
    surfaceCutErrorCode: null,
    surfaceCutDurationMs: null,
  });
  const started = runner.run({
    assetId: instance.assetId,
    transform: instance.transform,
    axisIndex,
    guidePositionMm,
    searchHalfWidthMm,
  }, () => copyAssetGeometry(instance.assetId), {
    onProgress: (phase) => {
      if (!surfaceCutStillCurrent(instanceId, sourceEditVersion, axisIndex, guidePositionMm, bandRatio)) {
        runner.cancel();
        return;
      }
      usePlaneCutPreview.setState({ surfaceCutPhaseText: phase });
    },
    onResult: (result, durationMs) => {
      if (!surfaceCutStillCurrent(instanceId, sourceEditVersion, axisIndex, guidePositionMm, bandRatio)) return;
      if (result.status === 'ready') {
        usePlaneCutPreview.setState({
          surfaceCutPhase: 'ready',
          surfaceCutPhaseText: '真实 A/B 临时网格已生成',
          surfaceCutResult: result,
          surfaceCutError: null,
          surfaceCutErrorCode: null,
          surfaceCutDurationMs: durationMs,
        });
      } else {
        usePlaneCutPreview.setState({
          surfaceCutPhase: 'failed',
          surfaceCutPhaseText: '',
          surfaceCutResult: null,
          surfaceCutError: result.message,
          surfaceCutErrorCode: result.code,
          surfaceCutDurationMs: durationMs,
        });
      }
    },
    onError: (message) => {
      if (surfaceCutStillCurrent(instanceId, sourceEditVersion, axisIndex, guidePositionMm, bandRatio)) {
        usePlaneCutPreview.setState({
          surfaceCutPhase: 'failed',
          surfaceCutPhaseText: '',
          surfaceCutResult: null,
          surfaceCutError: message,
          surfaceCutErrorCode: 'worker_failed',
        });
      }
    },
    onCancelled: () => {
      if (surfaceCutStillCurrent(instanceId, sourceEditVersion, axisIndex, guidePositionMm, bandRatio)) {
        usePlaneCutPreview.setState({
          surfaceCutPhase: 'idle',
          surfaceCutPhaseText: '',
          surfaceCutResult: null,
          surfaceCutError: null,
          surfaceCutErrorCode: null,
          surfaceCutDurationMs: null,
        });
      }
    },
  });
  if (!started) {
    usePlaneCutPreview.setState({
      surfaceCutPhase: 'failed',
      surfaceCutError: '无法读取当前模型几何，真实切割预览未启动',
      surfaceCutErrorCode: 'geometry_missing',
    });
  }
  return started;
}

export function cancelSurfaceAdaptiveCutPreview(): boolean {
  return surfaceCutRunner?.cancel() ?? false;
}

export function startSeamRecommendationScan(): boolean {
  const state = usePlaneCutPreview.getState();
  if (
    state.phase !== 'ready'
    || state.recommendationPhase === 'scanning'
    || !state.instanceId
    || !state.sourceBounds
    || !state.sourceBed
    || planeCutPreviewIsStale()
  ) return false;
  const instance = doc.nodes.get(state.instanceId);
  const runner = getSeamScanRunner();
  if (!instance || instance.kind !== 'instance' || !runner) {
    usePlaneCutPreview.setState({
      recommendationPhase: 'failed',
      recommendationError: '当前环境无法启动截面扫描 Worker',
    });
    return false;
  }
  const sourceEditVersion = state.sourceEditVersion;
  const instanceId = state.instanceId;
  const bounds = state.sourceBounds;
  const bed = state.sourceBed;
  const cuts = makeSeamScanCuts(bounds);
  usePlaneCutPreview.setState({
    recommendationPhase: 'scanning',
    recommendationProgress: { done: 0, total: cuts.length },
    recommendations: [],
    recommendationError: null,
  });
  const started = runner.run(
    instance.assetId,
    instance.transform,
    cuts,
    () => copyAssetGeometry(instance.assetId),
    {
      onProgress: (done, total) => {
        if (!scanStillCurrent(instanceId, sourceEditVersion)) {
          runner.cancel();
          return;
        }
        usePlaneCutPreview.setState({ recommendationProgress: { done, total } });
      },
      onDone: (results) => {
        if (!scanStillCurrent(instanceId, sourceEditVersion)) return;
        const samples: SeamScanSample[] = results.map((result: SeamScanResult) => ({
          axis: result.cut.axis,
          axisIndex: result.cut.axisIndex,
          normalizedPosition: result.cut.normalizedPosition,
          candidate: evaluatePlaneCutCandidate(bounds, bed, result.cut.axis, result.cut.normalizedPosition),
          section: result.section,
        }));
        usePlaneCutPreview.setState({
          recommendationPhase: 'ready',
          recommendationProgress: { done: results.length, total: cuts.length },
          recommendations: rankSeamRecommendations(samples, 3),
          recommendationError: null,
        });
      },
      onError: (message) => {
        if (scanStillCurrent(instanceId, sourceEditVersion)) {
          usePlaneCutPreview.setState({ recommendationPhase: 'failed', recommendationError: message });
        }
      },
      onCancelled: () => {
        if (scanStillCurrent(instanceId, sourceEditVersion)) {
          usePlaneCutPreview.setState({
            recommendationPhase: 'idle',
            recommendationProgress: { done: 0, total: cuts.length },
            recommendationError: null,
          });
        }
      },
    },
  );
  if (!started) {
    usePlaneCutPreview.setState({
      recommendationPhase: 'failed',
      recommendationError: '无法读取当前模型几何，扫描未启动',
    });
  }
  return started;
}

export function cancelSeamRecommendationScan(): boolean {
  return seamScanRunner?.cancel() ?? false;
}

export function previewSeamRecommendation(recommendation: SeamRecommendation): boolean {
  const state = usePlaneCutPreview.getState();
  if (state.phase !== 'ready' || planeCutPreviewIsStale()) return false;
  const candidateIndex = state.candidates.findIndex((candidate) => candidate.axis === recommendation.axis);
  if (candidateIndex < 0) return false;
  // 先换轴但不计算该轴默认中线，避免推荐跳转产生一次无用的主线程截面扫描。
  usePlaneCutPreview.setState({ activeIndex: candidateIndex });
  return setPlaneCutPosition(recommendation.normalizedPosition);
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
  seamScanRunner?.cancel();
  surfaceCutRunner?.cancel();
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
    recommendationPhase: 'idle',
    recommendationProgress: { done: 0, total: 27 },
    recommendations: [],
    recommendationError: null,
    surfaceCutPhase: 'idle',
    surfaceCutPhaseText: '',
    surfaceCutBandRatio: 0.12,
    surfaceCutResult: null,
    surfaceCutError: null,
    surfaceCutErrorCode: null,
    surfaceCutDurationMs: null,
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
  resetSurfaceCutState();
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
  resetSurfaceCutState();
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
  seamScanRunner?.cancel();
  surfaceCutRunner?.cancel();
  clearSectionTimers();
  usePlaneCutPreview.setState(initialState);
}
