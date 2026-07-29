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

export type FacePaintBoundaryStatus = 'idle' | 'ready' | 'budget';
export type FaceSeamStatus = 'idle' | 'ready' | 'invalid';

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
  session = null;
  useFacePaint.setState({
    ...initialUiState,
    maskRevision: useFacePaint.getState().maskRevision + 1,
  }, true);
}

export function setFacePaintMode(mode: FacePaintMode): void {
  useFacePaint.setState({ mode });
}

export function setFacePaintBrushRadius(radiusMm: number): void {
  if (!Number.isFinite(radiusMm)) return;
  useFacePaint.setState({ brushRadiusMm: Math.max(0.5, Math.min(500, radiusMm)) });
}

export function adjustFacePaintBrushRadius(factor: number): void {
  setFacePaintBrushRadius(useFacePaint.getState().brushRadiusMm * factor);
}

export function beginFacePaintStroke(): boolean {
  if (!session || session.currentChanges || useFacePaint.getState().seamStatus === 'ready') return false;
  session.currentChanges = new Map();
  session.lastChangedFaces = [];
  if (useFacePaint.getState().seamStatus !== 'idle') {
    useFacePaint.setState({ seamStatus: 'idle', seamResult: null });
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
  session.lastChangedFaces = changedFaces;
  useFacePaint.setState((state) => ({
    paintedFaceCount: session!.paintedCount,
    strokeCount: session!.history.length,
    seamStatus: 'idle',
    seamResult: null,
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

export function generateFacePaintSeamPreview(
  worldMatrix = new THREE.Matrix4(),
): FaceSeamPreviewResult | null {
  if (!session) return null;
  if (session.topology === undefined) {
    session.topology = session.geometry ? buildFacePaintTopology(session.geometry) : null;
  }
  const result = createFaceSeamPreview(session.topology ?? null, session.mask, worldMatrix);
  useFacePaint.setState({
    seamStatus: result.status,
    seamResult: result,
  });
  return result;
}

export function returnFacePaintToEditing(): void {
  useFacePaint.setState({ seamStatus: 'idle', seamResult: null });
}

export function setFacePaintBoundaryInfo(
  boundaryStatus: FacePaintBoundaryStatus,
  boundarySegmentCount: number,
): void {
  useFacePaint.setState({ boundaryStatus, boundarySegmentCount });
}
