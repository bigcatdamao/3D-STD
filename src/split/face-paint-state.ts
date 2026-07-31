import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { create } from 'zustand';
import {
  applyFacePaintSample,
  buildFacePaintTopology,
  paintedFaceCount,
  type FacePaintChange,
  type FacePaintMode,
  type FacePaintTopology,
} from './face-paint-core';
import {
  createFaceSeamPreview,
  type FaceSeamPreviewResult,
} from './face-seam-preview-core';
import {
  FaceSeamRunner,
  type FaceSeamWorkerLike,
} from './face-seam-runner';
import type { FaceSetCompletionSummary } from './face-set-completion-core';

export type FacePaintBoundaryStatus = 'idle' | 'ready' | 'budget';
export type FaceSeamStatus = 'idle' | 'running' | 'ready' | 'invalid';

export interface FaceSeamChoice {
  result: FaceSeamPreviewResult;
  faceLabels: Uint8Array;
  completion: FaceSetCompletionSummary;
}

export interface FacePaintUiState {
  active: boolean;
  instanceId: string | null;
  assetId: string | null;
  mode: FacePaintMode;
  brushRadiusMm: number;
  paintedFaceCount: number;
  totalFaceCount: number;
  strokeCount: number;
  boundarySegmentCount: number;
  boundaryStatus: FacePaintBoundaryStatus;
  seamStatus: FaceSeamStatus;
  seamResult: FaceSeamPreviewResult | null;
  seamProgress: string;
  seamError: string | null;
  seamDurationMs: number | null;
  completionSummary?: FaceSetCompletionSummary | null;
  seamAnchorPlacement: boolean;
  seamAnchorLocal: [number, number, number] | null;
  seamChoices: FaceSeamChoice[];
  seamChoiceIndex: number;
  maskRevision: number;
}

interface FacePaintStroke {
  changes: FacePaintChange[];
}

interface FacePaintSession {
  instanceId: string;
  assetId: string;
  mask: Uint8Array;
  history: FacePaintStroke[];
  currentChanges: Map<number, 0 | 1> | null;
  paintedCount: number;
  lastChangedFaces: number[];
  geometry: THREE.BufferGeometry | null;
  topology: FacePaintTopology | null | undefined;
  viewPositionLocal: [number, number, number] | null;
  seamAnchorLocal: [number, number, number] | null;
  roughMaskBeforeSeam: Uint8Array | null;
}

const initialUiState: FacePaintUiState = {
  active: false,
  instanceId: null,
  assetId: null,
  mode: 'add',
  brushRadiusMm: 12,
  paintedFaceCount: 0,
  totalFaceCount: 0,
  strokeCount: 0,
  boundarySegmentCount: 0,
  boundaryStatus: 'idle',
  seamStatus: 'idle',
  seamResult: null,
  seamProgress: '',
  seamError: null,
  seamDurationMs: null,
  completionSummary: null,
  seamAnchorPlacement: false,
  seamAnchorLocal: null,
  seamChoices: [],
  seamChoiceIndex: 0,
  maskRevision: 0,
};

export const useFacePaint = create<FacePaintUiState>()(() => initialUiState);

export function useFacePaintSnapshot(): FacePaintUiState {
  const [state, setState] = useState(() => useFacePaint.getState());
  useEffect(() => {
    setState(useFacePaint.getState());
    return useFacePaint.subscribe(setState);
  }, []);
  return state;
}

let session: FacePaintSession | null = null;
let seamRunner: FaceSeamRunner | null = null;

function getFaceSeamRunner(): FaceSeamRunner | null {
  if (seamRunner) return seamRunner;
  if (typeof Worker === 'undefined') return null;
  seamRunner = new FaceSeamRunner(() => new Worker(
    new URL('./face-seam.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as FaceSeamWorkerLike);
  return seamRunner;
}

export function _injectFaceSeamRunner(next: FaceSeamRunner | null): void {
  seamRunner?.cancel();
  seamRunner = next;
}

export function initializeFacePaintSession(
  instanceId: string,
  assetId: string,
  faceCount: number,
  brushRadiusMm: number,
): void {
  if (
    session
    && session.instanceId === instanceId
    && session.assetId === assetId
    && session.mask.length === faceCount
  ) {
    useFacePaint.setState({ active: true });
    return;
  }
  session = {
    instanceId,
    assetId,
    mask: new Uint8Array(faceCount),
    history: [],
    currentChanges: null,
    paintedCount: 0,
    lastChangedFaces: [],
    geometry: null,
    topology: undefined,
    viewPositionLocal: null,
    seamAnchorLocal: null,
    roughMaskBeforeSeam: null,
  };
  useFacePaint.setState({
    ...initialUiState,
    active: true,
    instanceId,
    assetId,
    totalFaceCount: faceCount,
    brushRadiusMm,
    maskRevision: useFacePaint.getState().maskRevision + 1,
  }, true);
}

export function resetFacePaintSession(): void {
  seamRunner?.cancel();
  session = null;
  useFacePaint.setState({
    ...initialUiState,
    maskRevision: useFacePaint.getState().maskRevision + 1,
  }, true);
}

export function setFacePaintMode(mode: FacePaintMode): void {
  useFacePaint.setState({ mode, seamAnchorPlacement: false });
}

export function beginFacePaintSeamAnchorPlacement(): boolean {
  if (!session || ['running', 'ready'].includes(useFacePaint.getState().seamStatus)) return false;
  useFacePaint.setState({ seamAnchorPlacement: true });
  return true;
}

export function cancelFacePaintSeamAnchorPlacement(): void {
  useFacePaint.setState({ seamAnchorPlacement: false });
}

export function setFacePaintSeamAnchorLocal(
  position: readonly [number, number, number],
): boolean {
  if (!session || position.some((value) => !Number.isFinite(value))) return false;
  session.seamAnchorLocal = [position[0], position[1], position[2]];
  useFacePaint.setState({
    seamAnchorPlacement: false,
    seamAnchorLocal: [...session.seamAnchorLocal],
    seamStatus: 'idle',
    seamResult: null,
    seamProgress: '',
    seamError: null,
    seamDurationMs: null,
    completionSummary: null,
    seamChoices: [],
    seamChoiceIndex: 0,
  });
  return true;
}

export function clearFacePaintSeamAnchor(): void {
  if (session) session.seamAnchorLocal = null;
  useFacePaint.setState({
    seamAnchorPlacement: false,
    seamAnchorLocal: null,
    seamStatus: 'idle',
    seamResult: null,
    seamProgress: '',
    seamError: null,
    seamDurationMs: null,
    completionSummary: null,
    seamChoices: [],
    seamChoiceIndex: 0,
  });
}

export function setFacePaintBrushRadius(radiusMm: number): void {
  if (!Number.isFinite(radiusMm)) return;
  useFacePaint.setState({ brushRadiusMm: Math.max(0.5, Math.min(500, radiusMm)) });
}

export function adjustFacePaintBrushRadius(factor: number): void {
  setFacePaintBrushRadius(useFacePaint.getState().brushRadiusMm * factor);
}

export function beginFacePaintStroke(): boolean {
  if (
    !session
    || session.currentChanges
    || ['running', 'ready'].includes(useFacePaint.getState().seamStatus)
  ) return false;
  session.currentChanges = new Map();
  session.lastChangedFaces = [];
  if (useFacePaint.getState().seamStatus !== 'idle') {
    useFacePaint.setState({
      seamStatus: 'idle',
      seamResult: null,
      seamProgress: '',
      seamError: null,
      seamDurationMs: null,
      completionSummary: null,
      seamChoices: [],
      seamChoiceIndex: 0,
    });
  }
  return true;
}

export function applyFacePaintFaces(
  faceIndices: Iterable<number>,
  mode = useFacePaint.getState().mode,
): number[] {
  if (!session?.currentChanges) return [];
  const changed = applyFacePaintSample(session.mask, faceIndices, mode, session.currentChanges);
  if (changed.length) session.lastChangedFaces.push(...changed);
  return changed;
}

function publishMaskChange(changedFaces: number[]): void {
  if (!session) return;
  session.roughMaskBeforeSeam = null;
  session.lastChangedFaces = changedFaces;
  useFacePaint.setState((state) => ({
    paintedFaceCount: session!.paintedCount,
    strokeCount: session!.history.length,
    seamStatus: 'idle',
    seamResult: null,
    seamProgress: '',
    seamError: null,
    seamDurationMs: null,
    completionSummary: null,
    seamChoices: [],
    seamChoiceIndex: 0,
    maskRevision: state.maskRevision + 1,
  }));
}

export function commitFacePaintStroke(): boolean {
  if (!session?.currentChanges) return false;
  const changes = [...session.currentChanges]
    .filter(([faceIndex, previous]) => session!.mask[faceIndex] !== previous)
    .map(([faceIndex, previous]) => ({ faceIndex, previous }));
  session.currentChanges = null;
  if (!changes.length) return false;
  session.history.push({ changes });
  session.paintedCount = paintedFaceCount(session.mask);
  publishMaskChange(changes.map((change) => change.faceIndex));
  return true;
}

export function cancelFacePaintStroke(): boolean {
  if (!session?.currentChanges) return false;
  const changedFaces: number[] = [];
  for (const [faceIndex, previous] of session.currentChanges) {
    session.mask[faceIndex] = previous;
    changedFaces.push(faceIndex);
  }
  session.currentChanges = null;
  session.paintedCount = paintedFaceCount(session.mask);
  publishMaskChange(changedFaces);
  return true;
}

export function undoFacePaintStroke(): boolean {
  if (!session || session.currentChanges) return false;
  const stroke = session.history.pop();
  if (!stroke) return false;
  for (const change of stroke.changes) session.mask[change.faceIndex] = change.previous;
  session.paintedCount = paintedFaceCount(session.mask);
  publishMaskChange(stroke.changes.map((change) => change.faceIndex));
  return true;
}

export function clearFacePaintMask(): boolean {
  if (!session || session.currentChanges || session.paintedCount === 0) return false;
  const changes: FacePaintChange[] = [];
  for (let faceIndex = 0; faceIndex < session.mask.length; faceIndex += 1) {
    if (!session.mask[faceIndex]) continue;
    changes.push({ faceIndex, previous: 1 });
    session.mask[faceIndex] = 0;
  }
  session.history.push({ changes });
  session.paintedCount = 0;
  publishMaskChange(changes.map((change) => change.faceIndex));
  return true;
}

export function getFacePaintMask(): Uint8Array | null {
  return session?.mask ?? null;
}

/** 复制 BVH 排序后的画笔网格与面组；Worker 传输后不影响当前只读接缝会话。 */
export function copyFacePaintCutInput(): {
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
  faceLabels: Uint8Array;
  viewPositionLocal: [number, number, number] | null;
  seamAnchorLocal: [number, number, number] | null;
} | null {
  if (!session?.geometry || session.mask.length === 0) return null;
  const position = session.geometry.getAttribute('position');
  if (!position || position.itemSize < 3) return null;
  const positions = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    positions[vertex * 3] = position.getX(vertex);
    positions[vertex * 3 + 1] = position.getY(vertex);
    positions[vertex * 3 + 2] = position.getZ(vertex);
  }
  const sourceIndex = session.geometry.getIndex();
  let index: ArrayBuffer | null = null;
  if (sourceIndex) {
    const copiedIndex = new Uint32Array(sourceIndex.count);
    for (let offset = 0; offset < sourceIndex.count; offset += 1) {
      copiedIndex[offset] = sourceIndex.getX(offset);
    }
    index = copiedIndex.buffer;
  }
  return {
    positions: positions.buffer,
    index,
    faceLabels: session.mask.slice(),
    viewPositionLocal: session.viewPositionLocal
      ? [...session.viewPositionLocal] as [number, number, number]
      : null,
    seamAnchorLocal: session.seamAnchorLocal
      ? [...session.seamAnchorLocal] as [number, number, number]
      : null,
  };
}

export function getFacePaintLastChangedFaces(): readonly number[] {
  return session?.lastChangedFaces ?? [];
}

export function registerFacePaintGeometry(
  geometry: THREE.BufferGeometry,
  topology?: FacePaintTopology | null,
): void {
  if (!session) return;
  session.geometry = geometry;
  if (topology !== undefined) session.topology = topology;
}

export function registerFacePaintTopology(topology: FacePaintTopology | null): void {
  if (!session) return;
  session.topology = topology;
}

export function registerFacePaintViewPositionLocal(
  position: readonly [number, number, number],
): void {
  if (!session || position.some((value) => !Number.isFinite(value))) return;
  session.viewPositionLocal = [position[0], position[1], position[2]];
}

function applyFaceSeamChoice(choice: FaceSeamChoice, index: number): boolean {
  if (!session || choice.faceLabels.length !== session.mask.length) return false;
  session.mask = choice.faceLabels;
  session.paintedCount = paintedFaceCount(session.mask);
  session.lastChangedFaces = [];
  useFacePaint.setState((state) => ({
    paintedFaceCount: session!.paintedCount,
    seamStatus: choice.result.status,
    seamResult: choice.result,
    completionSummary: choice.completion,
    seamChoiceIndex: index,
    maskRevision: state.maskRevision + 1,
  }));
  return true;
}

export function selectFacePaintSeamChoice(index: number): boolean {
  const choices = useFacePaint.getState().seamChoices;
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) return false;
  return applyFaceSeamChoice(choices[index], index);
}

export function generateFacePaintSeamPreview(
  worldMatrix = new THREE.Matrix4(),
): FaceSeamPreviewResult | null {
  if (!session) return null;
  if (session.topology === undefined) {
    session.topology = session.geometry ? buildFacePaintTopology(session.geometry) : null;
  }
  if (session.topology) {
    const result = createFaceSeamPreview(session.topology, session.mask, worldMatrix);
    useFacePaint.setState({
      seamStatus: result.status,
      seamResult: result,
      seamProgress: '',
      seamError: null,
      seamDurationMs: 0,
      completionSummary: null,
      seamChoices: [],
      seamChoiceIndex: 0,
    });
    return result;
  }

  const input = copyFacePaintCutInput();
  const activeRunner = getFaceSeamRunner();
  if (!input || !activeRunner) {
    const result = createFaceSeamPreview(null, session.mask, worldMatrix);
    useFacePaint.setState({
      seamStatus: 'invalid',
      seamResult: result,
      seamProgress: '',
      seamError: '当前环境无法启动高面数局部接缝 Worker',
      seamDurationMs: null,
      completionSummary: null,
      seamChoices: [],
      seamChoiceIndex: 0,
    });
    return result;
  }

  useFacePaint.setState({
    seamStatus: 'running',
    seamResult: null,
    seamProgress: '准备局部接缝数据',
    seamError: null,
    seamDurationMs: null,
    completionSummary: null,
    seamChoices: [],
    seamChoiceIndex: 0,
  });
  session.roughMaskBeforeSeam = session.mask.slice();
  const started = activeRunner.run({
    positions: input.positions,
    index: input.index,
    faceLabels: input.faceLabels,
    worldMatrix: worldMatrix.toArray(),
    viewPositionLocal: input.viewPositionLocal,
    seamAnchorLocal: input.seamAnchorLocal,
  }, {
    onProgress: (seamProgress) => {
      useFacePaint.setState({ seamProgress });
    },
    onResult: (
      result,
      seamDurationMs,
      completedFaceLabels,
      completionSummary,
      alternatives,
    ) => {
      const choices: FaceSeamChoice[] = [];
      if (
        result.status === 'ready'
        && completedFaceLabels
        && completionSummary
      ) {
        choices.push({
          result,
          faceLabels: completedFaceLabels,
          completion: completionSummary,
        });
      }
      for (const alternative of alternatives ?? []) {
        if (alternative.result.status !== 'ready') continue;
        choices.push({
          result: alternative.result,
          faceLabels: alternative.completedFaceLabels,
          completion: alternative.completion,
        });
      }
      useFacePaint.setState({
        seamStatus: result.status,
        seamResult: result,
        seamProgress: '',
        seamError: null,
        seamDurationMs,
        completionSummary: completionSummary ?? null,
        seamChoices: choices,
        seamChoiceIndex: 0,
      });
      if (choices.length) applyFaceSeamChoice(choices[0], 0);
    },
    onError: (seamError) => {
      useFacePaint.setState({
        seamStatus: 'invalid',
        seamResult: null,
        seamProgress: '',
        seamError,
        seamDurationMs: null,
        completionSummary: null,
        seamChoices: [],
        seamChoiceIndex: 0,
      });
    },
    onCancelled: () => {
      useFacePaint.setState({
        seamStatus: 'idle',
        seamResult: null,
        seamProgress: '',
        seamError: null,
        seamDurationMs: null,
        completionSummary: null,
        seamChoices: [],
        seamChoiceIndex: 0,
      });
    },
  });
  if (!started) {
    useFacePaint.setState({
      seamStatus: 'invalid',
      seamResult: null,
      seamProgress: '',
      seamError: '局部接缝分析尚未启动，请重试',
      seamDurationMs: null,
      completionSummary: null,
      seamChoices: [],
      seamChoiceIndex: 0,
    });
  }
  return null;
}

export function returnFacePaintToEditing(): void {
  seamRunner?.cancel();
  if (session?.roughMaskBeforeSeam) {
    session.mask = session.roughMaskBeforeSeam;
    session.roughMaskBeforeSeam = null;
    session.paintedCount = paintedFaceCount(session.mask);
    session.lastChangedFaces = [];
  }
  useFacePaint.setState((state) => ({
    paintedFaceCount: session?.paintedCount ?? state.paintedFaceCount,
    seamStatus: 'idle',
    seamResult: null,
    seamProgress: '',
    seamError: null,
    seamDurationMs: null,
    completionSummary: null,
    seamChoices: [],
    seamChoiceIndex: 0,
    maskRevision: state.maskRevision + 1,
  }));
}

export function setFacePaintBoundaryInfo(
  boundaryStatus: FacePaintBoundaryStatus,
  boundarySegmentCount: number,
): void {
  useFacePaint.setState({ boundaryStatus, boundarySegmentCount });
}
