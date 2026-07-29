import { create } from 'zustand';
import * as THREE from 'three';
import { useEffect, useState } from 'react';
import { renderThumbnail } from '../importer/thumbnail';
import type { Asset, Transform, Vec3 } from '../kernel/types';
import { runPrintCheck } from '../check/check-state';
import { dispatch, doc, geometryRegistry, sendCam, thumbRegistry, useUi } from '../state/store';
import { worldBBoxOfInstance } from '../viewport/gizmo-math';
import {
  copyFacePaintCutInput,
  resetFacePaintSession,
  useFacePaint,
} from './face-paint-state';
import { closePlaneCutPreview } from './plane-cut-state';
import type { PlaneEquation, PlaneSplitPart, PlaneSplitResult } from './plane-split-core';
import { PlaneSplitRunner, type PlaneSplitWorkerLike } from './plane-split-runner';
import type {
  SurfaceCutPart,
  SurfaceCutPreference,
  SurfaceCutResult,
} from './surface-cut-core';
import { SurfaceCutRunner, type SurfaceCutWorkerLike } from './surface-cut-runner';

export type ManualPlaneMode = 'translate' | 'rotate' | 'scale';
export type ManualPlaneAxis = 'x' | 'y' | 'z' | 'custom';
export type ManualSplitKind = 'plane' | 'surface';
export type SurfaceCutReadyResult = Extract<SurfaceCutResult, { status: 'ready' }>;

export interface ManualPlaneSplitState {
  phase: 'idle' | 'editing' | 'previewing' | 'previewReady' | 'running' | 'error';
  cutKind: ManualSplitKind;
  instanceId: string | null;
  sourceAssetId: string | null;
  sourceEditVersion: number;
  position: Vec3;
  rotation: Vec3;
  size: [number, number];
  sizeLinked: boolean;
  bounds: { min: Vec3; max: Vec3 } | null;
  mode: ManualPlaneMode;
  axis: ManualPlaneAxis;
  progress: string;
  error: string | null;
  errorCode: string | null;
  durationMs: number | null;
  surfaceBandMm: number;
  surfacePreference: SurfaceCutPreference;
  surfaceGuidePoints: Vec3[];
  surfaceGuideClosed: boolean;
  surfaceResult: SurfaceCutReadyResult | null;
}

const initialState: ManualPlaneSplitState = {
  phase: 'idle',
  cutKind: 'plane',
  instanceId: null,
  sourceAssetId: null,
  sourceEditVersion: -1,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [100, 100],
  sizeLinked: true,
  bounds: null,
  mode: 'translate',
  axis: 'z',
  progress: '',
  error: null,
  errorCode: null,
  durationMs: null,
  surfaceBandMm: 12,
  surfacePreference: 'balanced',
  surfaceGuidePoints: [],
  surfaceGuideClosed: false,
  surfaceResult: null,
};

export const useManualPlaneSplit = create<ManualPlaneSplitState>()(() => initialState);

/** SSR 与客户端首帧都读取当前工具态，便于属性栏测试与恢复中的切割会话显示。 */
export function useManualPlaneSplitSnapshot(): ManualPlaneSplitState {
  const [state, setState] = useState(() => useManualPlaneSplit.getState());
  useEffect(() => {
    setState(useManualPlaneSplit.getState());
    return useManualPlaneSplit.subscribe(setState);
  }, []);
  return state;
}

let runner: PlaneSplitRunner | null = null;
let surfaceRunner: SurfaceCutRunner | null = null;

function getRunner(): PlaneSplitRunner | null {
  if (runner) return runner;
  if (typeof Worker === 'undefined') return null;
  runner = new PlaneSplitRunner(() => new Worker(
    new URL('./plane-split.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as PlaneSplitWorkerLike);
  return runner;
}

function getSurfaceRunner(): SurfaceCutRunner | null {
  if (surfaceRunner) return surfaceRunner;
  if (typeof Worker === 'undefined') return null;
  surfaceRunner = new SurfaceCutRunner(() => new Worker(
    new URL('./surface-cut.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as SurfaceCutWorkerLike);
  return surfaceRunner;
}

export function _injectPlaneSplitRunner(next: PlaneSplitRunner | null): void {
  runner?.cancel();
  runner = next;
}

export function _injectSurfaceCutRunner(next: SurfaceCutRunner | null): void {
  surfaceRunner?.cancel();
  surfaceRunner = next;
}

function normalizedDeg(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Math.abs(normalized) < 1e-9 ? 0 : normalized;
}

function cloneVec3(value: Vec3): Vec3 {
  return [...value] as Vec3;
}

export function manualPlaneSplitIsActive(): boolean {
  return useManualPlaneSplit.getState().phase !== 'idle';
}

export function manualPlaneSplitIsStale(): boolean {
  const state = useManualPlaneSplit.getState();
  return state.phase !== 'idle' && (
    state.sourceEditVersion !== doc.editVersion
    || !state.instanceId
    || !state.sourceAssetId
    || doc.nodes.get(state.instanceId)?.kind !== 'instance'
    || doc.instance(state.instanceId).assetId !== state.sourceAssetId
  );
}

export function startManualPlaneSplit(instanceId: string, cutKind: ManualSplitKind = 'plane'): boolean {
  const instance = doc.nodes.get(instanceId);
  if (
    !instance
    || instance.kind !== 'instance'
    || doc.effectiveLocked(instanceId)
    || !geometryRegistry.has(instance.assetId)
  ) return false;
  runner?.cancel();
  surfaceRunner?.cancel();
  resetFacePaintSession();
  closePlaneCutPreview();
  const world = worldBBoxOfInstance(instance.transform, doc.assets.get(instance.assetId)!.meta.bbox);
  const center = world.getCenter(new THREE.Vector3());
  const dimensions = world.getSize(new THREE.Vector3());
  const visualSize = Math.max(dimensions.x, dimensions.y, dimensions.z, 20) * 1.3;
  useManualPlaneSplit.setState({
    ...initialState,
    phase: 'editing',
    cutKind,
    instanceId,
    sourceAssetId: instance.assetId,
    sourceEditVersion: doc.editVersion,
    position: [center.x, center.y, center.z],
    rotation: [0, 0, 0],
    size: [visualSize, visualSize],
    sizeLinked: true,
    bounds: {
      min: [world.min.x, world.min.y, world.min.z],
      max: [world.max.x, world.max.y, world.max.z],
    },
    mode: 'translate',
    axis: 'z',
    surfaceBandMm: Math.max(2, Math.min(20, visualSize * 0.05)),
  }, true);
  dispatch((scene) => scene.select([instanceId]));
  const pad = visualSize * 0.08;
  sendCam({
    kind: 'focusBounds',
    min: [world.min.x - pad, world.min.y - pad, world.min.z - pad],
    max: [world.max.x + pad, world.max.y + pad, world.max.z + pad],
  });
  return true;
}

export function cancelManualPlaneSplit(): void {
  runner?.cancel();
  surfaceRunner?.cancel();
  resetFacePaintSession();
  useManualPlaneSplit.setState(initialState, true);
}

function canEdit(state: ManualPlaneSplitState): boolean {
  return state.phase === 'editing' || state.phase === 'error' || state.phase === 'previewReady';
}

function editablePatch(patch: Partial<ManualPlaneSplitState>): void {
  useManualPlaneSplit.setState({
    ...patch,
    phase: 'editing',
    progress: '',
    error: null,
    errorCode: null,
    durationMs: null,
    surfaceResult: null,
  });
}

export function setManualSplitKind(cutKind: ManualSplitKind): void {
  const state = useManualPlaneSplit.getState();
  if (state.phase === 'idle' || state.phase === 'running' || state.phase === 'previewing') return;
  runner?.cancel();
  surfaceRunner?.cancel();
  editablePatch({ cutKind, mode: 'translate' });
}

export function setManualPlaneMode(mode: ManualPlaneMode): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  useManualPlaneSplit.setState({
    mode,
    ...(state.phase === 'error'
      ? { phase: 'editing' as const, error: null, errorCode: null }
      : {}),
  });
}

export function setManualPlanePosition(position: Vec3): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  editablePatch({
    position: cloneVec3(position),
    axis: state.axis,
  });
}

export function setManualPlaneRotation(rotation: Vec3, axis: ManualPlaneAxis = 'custom'): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  editablePatch({
    rotation: rotation.map(normalizedDeg) as Vec3,
    axis,
  });
}

export function setManualPlaneSize(size: [number, number]): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  editablePatch({
    size: [Math.max(10, size[0]), Math.max(10, size[1])],
  });
}

export function setManualPlaneSizeLinked(sizeLinked: boolean): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  useManualPlaneSplit.setState({ sizeLinked });
}

export function setManualSurfaceBandMm(surfaceBandMm: number): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  editablePatch({ surfaceBandMm: Math.max(1, Math.min(200, surfaceBandMm)) });
}

export function setManualSurfacePreference(surfacePreference: SurfaceCutPreference): void {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state)) return;
  editablePatch({ surfacePreference });
}

export function appendManualSurfaceGuidePoint(point: Vec3): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    !canEdit(state)
    || state.cutKind !== 'surface'
    || state.surfaceGuidePoints.length >= 64
    || !point.every(Number.isFinite)
  ) return false;
  editablePatch({
    surfaceGuidePoints: [...state.surfaceGuidePoints, cloneVec3(point)],
    surfaceGuideClosed: false,
  });
  return true;
}

export function moveManualSurfaceGuidePoint(index: number, point: Vec3): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    !canEdit(state)
    || state.cutKind !== 'surface'
    || index < 0
    || index >= state.surfaceGuidePoints.length
    || !point.every(Number.isFinite)
  ) return false;
  const surfaceGuidePoints = state.surfaceGuidePoints.map((current, pointIndex) => (
    pointIndex === index ? cloneVec3(point) : cloneVec3(current)
  ));
  editablePatch({ surfaceGuidePoints, surfaceGuideClosed: false });
  return true;
}

export function removeLastManualSurfaceGuidePoint(): boolean {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state) || state.cutKind !== 'surface' || !state.surfaceGuidePoints.length) return false;
  editablePatch({
    surfaceGuidePoints: state.surfaceGuidePoints.slice(0, -1).map(cloneVec3),
    surfaceGuideClosed: false,
  });
  return true;
}

export function clearManualSurfaceGuidePoints(): boolean {
  const state = useManualPlaneSplit.getState();
  if (!canEdit(state) || state.cutKind !== 'surface' || !state.surfaceGuidePoints.length) return false;
  editablePatch({ surfaceGuidePoints: [], surfaceGuideClosed: false });
  return true;
}

/** 从贴面控制点拟合分区平面；闭环本身继续作为网格寻缝的主引导。 */
export function manualSurfaceGuideWorld(
  points: Vec3[],
  fallbackPosition: Vec3,
  fallbackRotation: Vec3,
): { origin: Vec3; normal: Vec3 } {
  if (points.length < 3) return manualGuidePlaneWorld(fallbackPosition, fallbackRotation);
  const origin = points.reduce((sum, point) => sum.add(new THREE.Vector3(...point)), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const normal = new THREE.Vector3();
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal.x += (current[1] - next[1]) * (current[2] + next[2]);
    normal.y += (current[2] - next[2]) * (current[0] + next[0]);
    normal.z += (current[0] - next[0]) * (current[1] + next[1]);
  }
  if (normal.lengthSq() <= 1e-10) return manualGuidePlaneWorld(fallbackPosition, fallbackRotation);
  normal.normalize();
  return {
    origin: [origin.x, origin.y, origin.z],
    normal: [normal.x, normal.y, normal.z],
  };
}

/** 从已验证的表面闭环返回控制点编辑，不退出拆件，也不写场景或历史。 */
export function returnManualSurfaceSplitToGuide(): boolean {
  const state = useManualPlaneSplit.getState();
  if (state.cutKind !== 'surface' || state.phase !== 'previewReady') return false;
  surfaceRunner?.cancel();
  useManualPlaneSplit.setState({
    phase: 'editing',
    mode: 'translate',
    progress: '',
    error: null,
    errorCode: null,
    durationMs: null,
    surfaceGuideClosed: false,
    surfaceResult: null,
  });
  return true;
}

export function setManualPlaneAxis(axis: Exclude<ManualPlaneAxis, 'custom'>): void {
  const rotations: Record<Exclude<ManualPlaneAxis, 'custom'>, Vec3> = {
    x: [0, 90, 0],
    y: [-90, 0, 0],
    z: [0, 0, 0],
  };
  setManualPlaneRotation(rotations[axis], axis);
}

function transformMatrix(transform: Transform): THREE.Matrix4 {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(transform.rotation[0]),
    THREE.MathUtils.degToRad(transform.rotation[1]),
    THREE.MathUtils.degToRad(transform.rotation[2]),
    'XYZ',
  ));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    quaternion,
    new THREE.Vector3(...transform.scale),
  );
}

/** 把世界空间切割平面转换到源资产局部坐标，支持实例的旋转与非等比缩放。 */
export function worldPlaneToAssetPlane(
  instanceTransform: Transform,
  worldPosition: Vec3,
  worldRotation: Vec3,
): PlaneEquation {
  const rotation = new THREE.Euler(
    THREE.MathUtils.degToRad(worldRotation[0]),
    THREE.MathUtils.degToRad(worldRotation[1]),
    THREE.MathUtils.degToRad(worldRotation[2]),
    'XYZ',
  );
  const worldNormal = new THREE.Vector3(0, 0, 1).applyEuler(rotation).normalize();
  const matrix = transformMatrix(instanceTransform);
  const localPoint = new THREE.Vector3(...worldPosition).applyMatrix4(matrix.clone().invert());
  const localNormal = worldNormal.applyMatrix3(
    new THREE.Matrix3().setFromMatrix4(matrix).transpose(),
  ).normalize();
  return {
    normal: [localNormal.x, localNormal.y, localNormal.z],
    constant: -localNormal.dot(localPoint),
  };
}

export function manualGuidePlaneWorld(position: Vec3, rotation: Vec3): {
  origin: Vec3;
  normal: Vec3;
} {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotation[0]),
    THREE.MathUtils.degToRad(rotation[1]),
    THREE.MathUtils.degToRad(rotation[2]),
    'XYZ',
  );
  const normal = new THREE.Vector3(0, 0, 1).applyEuler(euler).normalize();
  return {
    origin: cloneVec3(position),
    normal: [normal.x, normal.y, normal.z],
  };
}

function copyGeometry(assetId: string): { positions: ArrayBuffer; index: ArrayBuffer | null } | null {
  const geometry = geometryRegistry.get(assetId);
  const attribute = geometry?.getAttribute('position');
  if (!geometry || !attribute) return null;
  const positions = new Float32Array(attribute.count * 3);
  for (let index = 0; index < attribute.count; index += 1) {
    positions[index * 3] = attribute.getX(index);
    positions[index * 3 + 1] = attribute.getY(index);
    positions[index * 3 + 2] = attribute.getZ(index);
  }
  const index = geometry.index
    ? Uint32Array.from(geometry.index.array as ArrayLike<number>)
    : null;
  return {
    positions: positions.buffer as ArrayBuffer,
    index: index ? index.buffer as ArrayBuffer : null,
  };
}

function geometryFromPart(part: PlaneSplitPart): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function geometryFromSurfacePart(part: SurfaceCutPart): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function boundsOfPositions(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[offset + axis]);
      max[axis] = Math.max(max[axis], positions[offset + axis]);
    }
  }
  return { min, max };
}

function derivedAsset(
  source: Asset,
  part: PlaneSplitPart,
  suffix: 'A' | 'B',
  createdAt: number,
  plane: PlaneEquation,
): Omit<Asset, 'id'> {
  return {
    name: `${source.name} · ${suffix}`,
    source: source.source,
    state: 'ready',
    meta: {
      faces: part.faceCount,
      vertices: part.vertexCount,
      bbox: {
        min: cloneVec3(part.bounds.min),
        max: cloneVec3(part.bounds.max),
      },
      unitChoice: source.meta.unitChoice,
      watertight: source.meta.watertight,
      degenerate: false,
      createdAt,
    },
    genParams: {
      ...(source.genParams ?? {}),
      split: {
        kind: 'manual_plane_cut',
        fromAssetId: source.id,
        part: suffix,
        createdAt,
        plane,
      },
    },
  };
}

function derivedSurfaceAsset(
  source: Asset,
  part: SurfaceCutPart,
  suffix: 'A' | 'B',
  role: '拆下件' | '保留件' | null,
  kind: 'surface_adaptive_cut' | 'face_set_surface_cut',
  createdAt: number,
  interfaceId: string,
  guide: { origin: Vec3; normal: Vec3 },
  guidePointsWorld: Vec3[],
  searchHalfWidthMm: number,
  preference: SurfaceCutPreference,
  metrics: SurfaceCutReadyResult['metrics'],
): Omit<Asset, 'id'> {
  const bounds = boundsOfPositions(part.positions);
  return {
    name: `${source.name} · ${suffix}${role ? ` ${role}` : ''}`,
    source: source.source,
    state: 'ready',
    meta: {
      faces: part.positions.length / 9,
      vertices: part.positions.length / 3,
      bbox: bounds,
      unitChoice: source.meta.unitChoice,
      watertight: part.boundaryEdges === 0,
      degenerate: false,
      createdAt,
    },
    genParams: {
      ...(source.genParams ?? {}),
      split: {
        kind,
        fromAssetId: source.id,
        part: suffix,
        createdAt,
        sharedInterfaceId: interfaceId,
        guide,
        guidePointsWorld: guidePointsWorld.map(cloneVec3),
        searchHalfWidthMm,
        preference,
        boundaryVertices: metrics.boundaryVertices,
        seamLengthMm: metrics.seamLengthMm,
        capFaceCount: part.capFaceCount,
        maxCapDeviationMm: metrics.maxCapDeviationMm,
        capWarpRatio: metrics.capWarpRatio,
      },
    },
  };
}

function resultStillCurrent(
  instanceId: string,
  sourceAssetId: string,
  sourceEditVersion: number,
): boolean {
  const state = useManualPlaneSplit.getState();
  return state.phase === 'running'
    && state.cutKind === 'plane'
    && state.instanceId === instanceId
    && state.sourceAssetId === sourceAssetId
    && state.sourceEditVersion === sourceEditVersion
    && !manualPlaneSplitIsStale();
}

function applySplitResult(
  result: Extract<PlaneSplitResult, { status: 'ready' }>,
  plane: PlaneEquation,
  durationMs: number,
): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    state.phase !== 'running'
    || !state.instanceId
    || !state.sourceAssetId
    || manualPlaneSplitIsStale()
  ) return false;
  const source = doc.assets.get(state.sourceAssetId);
  if (!source) return false;
  const geometryA = geometryFromPart(result.partA);
  const geometryB = geometryFromPart(result.partB);
  const createdAt = Date.now();
  const split = dispatch((scene) => scene.splitInstanceWithDerivedParts(
    state.instanceId!,
    [
      derivedAsset(source, result.partA, 'A', createdAt, plane),
      derivedAsset(source, result.partB, 'B', createdAt, plane),
    ],
    `平面切割 · ${source.name}`,
  ));
  geometryRegistry.set(split.assets[0].id, geometryA);
  geometryRegistry.set(split.assets[1].id, geometryB);
  const thumbnailA = renderThumbnail(geometryA);
  const thumbnailB = renderThumbnail(geometryB);
  if (thumbnailA) thumbRegistry.set(split.assets[0].id, thumbnailA);
  if (thumbnailB) thumbRegistry.set(split.assets[1].id, thumbnailB);
  resetFacePaintSession();
  useManualPlaneSplit.setState(initialState, true);
  useUi.getState().bump();
  useUi.getState().setToast(
    `切割完成：已生成 A/B 两个独立模型 · ${result.loopCount} 条闭合截面 · ${durationMs.toFixed(0)} ms`,
    {
      label: '撤销',
      run: () => dispatch((scene) => scene.history.undo()),
    },
  );
  if (typeof Worker !== 'undefined') setTimeout(() => runPrintCheck(), 0);
  return true;
}

function surfacePreviewStillCurrent(
  instanceId: string,
  sourceAssetId: string,
  sourceEditVersion: number,
): boolean {
  const state = useManualPlaneSplit.getState();
  return state.phase === 'previewing'
    && state.cutKind === 'surface'
    && state.instanceId === instanceId
    && state.sourceAssetId === sourceAssetId
    && state.sourceEditVersion === sourceEditVersion
    && !manualPlaneSplitIsStale();
}

export function previewManualSurfaceSplit(): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    !canEdit(state)
    || state.cutKind !== 'surface'
    || !state.instanceId
    || !state.sourceAssetId
    || manualPlaneSplitIsStale()
  ) return false;
  if (state.surfaceGuidePoints.length < 3) {
    useManualPlaneSplit.setState({
      phase: 'error',
      surfaceGuideClosed: false,
      surfaceResult: null,
      error: '请先在模型表面添加至少 3 个控制点，再生成闭合接缝预览',
      errorCode: 'missing_guide_points',
    });
    return false;
  }
  const instance = doc.nodes.get(state.instanceId);
  const geometry = copyGeometry(state.sourceAssetId);
  const activeRunner = getSurfaceRunner();
  if (!instance || instance.kind !== 'instance' || !geometry || !activeRunner) {
    useManualPlaneSplit.setState({
      phase: 'error',
      surfaceResult: null,
      error: '当前环境无法启动曲面切割 Worker，源模型保持不变',
      errorCode: 'worker_unavailable',
    });
    return false;
  }
  const guidePointsWorld = state.surfaceGuidePoints.map(cloneVec3);
  const guide = manualSurfaceGuideWorld(guidePointsWorld, state.position, state.rotation);
  const instanceId = state.instanceId;
  const sourceAssetId = state.sourceAssetId;
  const sourceEditVersion = state.sourceEditVersion;
  useManualPlaneSplit.setState({
    phase: 'previewing',
    progress: '构建表面邻接图',
    error: null,
    errorCode: null,
    durationMs: null,
    surfaceGuideClosed: true,
    surfaceResult: null,
  });
  const started = activeRunner.run({
    assetId: sourceAssetId,
    transform: instance.transform,
    guideOriginWorld: guide.origin,
    guideNormalWorld: guide.normal,
    guidePointsWorld,
    searchHalfWidthMm: state.surfaceBandMm,
    preference: state.surfacePreference,
  }, () => geometry, {
    onProgress: (progress) => {
      if (surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({ progress });
      }
    },
    onResult: (result, durationMs) => {
      if (!surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) return;
      if (result.status === 'ready') {
        useManualPlaneSplit.setState({
          phase: 'previewReady',
          progress: '',
          surfaceGuideClosed: true,
          surfaceResult: result,
          durationMs,
          error: null,
          errorCode: null,
        });
      } else {
        useManualPlaneSplit.setState({
          phase: 'error',
          progress: '',
          surfaceGuideClosed: false,
          surfaceResult: null,
          durationMs,
          error: result.message,
          errorCode: result.code,
        });
      }
    },
    onError: (message) => {
      if (surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({
          phase: 'error',
          progress: '',
          surfaceGuideClosed: false,
          surfaceResult: null,
          error: message,
          errorCode: 'worker_failed',
        });
      }
    },
    onCancelled: () => {
      if (surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({
          phase: 'editing',
          progress: '',
          surfaceGuideClosed: false,
          surfaceResult: null,
          error: null,
          errorCode: null,
        });
      }
    },
  });
  if (!started) {
    useManualPlaneSplit.setState({
      phase: 'error',
      progress: '',
      surfaceGuideClosed: false,
      surfaceResult: null,
      error: '无法读取当前模型几何，曲面接缝预览未启动',
      errorCode: 'geometry_missing',
    });
  }
  return started;
}

/**
 * M1.11c：使用已验证的紫色面组直接生成真实 A/B 网格。
 * 输入来自 BVH 排序后的画笔网格，保证面标签与三角面索引完全一致。
 */
export function previewFacePaintSurfaceSplit(): boolean {
  const state = useManualPlaneSplit.getState();
  const paint = useFacePaint.getState();
  if (
    !canEdit(state)
    || state.cutKind !== 'surface'
    || paint.seamStatus !== 'ready'
    || !paint.seamResult
    || !state.instanceId
    || !state.sourceAssetId
    || manualPlaneSplitIsStale()
  ) return false;
  const instance = doc.nodes.get(state.instanceId);
  const cutInput = copyFacePaintCutInput();
  const activeRunner = getSurfaceRunner();
  if (!instance || instance.kind !== 'instance' || !cutInput || !activeRunner) {
    useManualPlaneSplit.setState({
      phase: 'error',
      surfaceResult: null,
      error: '无法读取当前面组网格或启动切割 Worker，源模型保持不变',
      errorCode: 'worker_unavailable',
    });
    return false;
  }
  const instanceId = state.instanceId;
  const sourceAssetId = state.sourceAssetId;
  const sourceEditVersion = state.sourceEditVersion;
  const workerAssetId = `${sourceAssetId}:face-set:${paint.maskRevision}`;
  useManualPlaneSplit.setState({
    phase: 'previewing',
    progress: '读取紫色面组',
    error: null,
    errorCode: null,
    durationMs: null,
    surfaceGuideClosed: true,
    surfaceResult: null,
  });
  const started = activeRunner.run({
    assetId: workerAssetId,
    transform: instance.transform,
    faceLabels: cutInput.faceLabels,
    searchHalfWidthMm: 0.1,
    preference: 'balanced',
  }, () => ({
    positions: cutInput.positions,
    index: cutInput.index,
  }), {
    onProgress: (progress) => {
      if (surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({ progress });
      }
    },
    onResult: (result, durationMs) => {
      if (!surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) return;
      if (result.status === 'ready') {
        useManualPlaneSplit.setState({
          phase: 'previewReady',
          progress: '',
          surfaceGuideClosed: true,
          surfaceResult: result,
          durationMs,
          error: null,
          errorCode: null,
        });
      } else {
        useManualPlaneSplit.setState({
          phase: 'error',
          progress: '',
          surfaceGuideClosed: true,
          surfaceResult: null,
          durationMs,
          error: result.message,
          errorCode: result.code,
        });
      }
    },
    onError: (message) => {
      if (surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({
          phase: 'error',
          progress: '',
          surfaceGuideClosed: true,
          surfaceResult: null,
          error: message,
          errorCode: 'worker_failed',
        });
      }
    },
    onCancelled: () => {
      if (surfacePreviewStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({
          phase: 'editing',
          progress: '',
          surfaceGuideClosed: true,
          surfaceResult: null,
          error: null,
          errorCode: null,
        });
      }
    },
  });
  if (!started) {
    useManualPlaneSplit.setState({
      phase: 'error',
      progress: '',
      surfaceGuideClosed: true,
      surfaceResult: null,
      error: '真实 A/B 预览未启动，请返回面组后重试',
      errorCode: 'geometry_missing',
    });
  }
  return started;
}

/** 从真实 A/B 预览或失败态返回已验证接缝；不会清空紫色面组。 */
export function returnFacePaintSurfaceSplitToSeam(): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    state.cutKind !== 'surface'
    || !['previewing', 'previewReady', 'error'].includes(state.phase)
    || useFacePaint.getState().seamStatus !== 'ready'
  ) return false;
  if (state.phase === 'previewing') {
    return surfaceRunner?.cancel() ?? false;
  }
  useManualPlaneSplit.setState({
    phase: 'editing',
    progress: '',
    error: null,
    errorCode: null,
    durationMs: null,
    surfaceGuideClosed: true,
    surfaceResult: null,
  });
  return true;
}

export function confirmManualSurfaceSplit(): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    state.phase !== 'previewReady'
    || state.cutKind !== 'surface'
    || !state.surfaceResult
    || !state.instanceId
    || !state.sourceAssetId
    || manualPlaneSplitIsStale()
  ) return false;
  const source = doc.assets.get(state.sourceAssetId);
  if (!source) return false;
  const result = state.surfaceResult;
  const faceSetCut = useFacePaint.getState().seamStatus === 'ready';
  const guide = manualSurfaceGuideWorld(
    state.surfaceGuidePoints,
    state.position,
    state.rotation,
  );
  const createdAt = Date.now();
  const interfaceId = `surface_if_${createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const geometryA = geometryFromSurfacePart(result.partA);
  const geometryB = geometryFromSurfacePart(result.partB);
  const split = dispatch((scene) => scene.splitInstanceWithDerivedParts(
    state.instanceId!,
    [
      derivedSurfaceAsset(
        source,
        result.partA,
        'A',
        faceSetCut ? '拆下件' : null,
        faceSetCut ? 'face_set_surface_cut' : 'surface_adaptive_cut',
        createdAt,
        interfaceId,
        guide,
        state.surfaceGuidePoints,
        state.surfaceBandMm,
        state.surfacePreference,
        result.metrics,
      ),
      derivedSurfaceAsset(
        source,
        result.partB,
        'B',
        faceSetCut ? '保留件' : null,
        faceSetCut ? 'face_set_surface_cut' : 'surface_adaptive_cut',
        createdAt,
        interfaceId,
        guide,
        state.surfaceGuidePoints,
        state.surfaceBandMm,
        state.surfacePreference,
        result.metrics,
      ),
    ],
    `${faceSetCut ? '面组曲面切割' : '曲面切割'} · ${source.name}`,
  ));
  geometryRegistry.set(split.assets[0].id, geometryA);
  geometryRegistry.set(split.assets[1].id, geometryB);
  const thumbnailA = renderThumbnail(geometryA);
  const thumbnailB = renderThumbnail(geometryB);
  if (thumbnailA) thumbRegistry.set(split.assets[0].id, thumbnailA);
  if (thumbnailB) thumbRegistry.set(split.assets[1].id, thumbnailB);
  resetFacePaintSession();
  useManualPlaneSplit.setState(initialState, true);
  useUi.getState().bump();
  useUi.getState().setToast(
    `${faceSetCut ? '面组曲面切割' : '曲面切割'}完成：A/B 已生成 · ${result.metrics.boundaryVertices} 点闭合接缝 · ${state.durationMs?.toFixed(0) ?? '—'} ms`,
    {
      label: '撤销',
      run: () => dispatch((scene) => scene.history.undo()),
    },
  );
  if (typeof Worker !== 'undefined') setTimeout(() => runPrintCheck(), 0);
  return true;
}

export function confirmManualPlaneSplit(): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    (state.phase !== 'editing' && state.phase !== 'error')
    || state.cutKind !== 'plane'
    || !state.instanceId
    || !state.sourceAssetId
    || manualPlaneSplitIsStale()
  ) return false;
  const instance = doc.nodes.get(state.instanceId);
  const geometry = copyGeometry(state.sourceAssetId);
  const activeRunner = getRunner();
  if (!instance || instance.kind !== 'instance' || !geometry || !activeRunner) {
    useManualPlaneSplit.setState({
      phase: 'error',
      error: '当前环境无法启动平面切割 Worker，源模型保持不变',
      errorCode: 'worker_unavailable',
    });
    return false;
  }
  const plane = worldPlaneToAssetPlane(instance.transform, state.position, state.rotation);
  const instanceId = state.instanceId;
  const sourceAssetId = state.sourceAssetId;
  const sourceEditVersion = state.sourceEditVersion;
  useManualPlaneSplit.setState({
    phase: 'running',
    progress: '准备源网格',
    error: null,
    errorCode: null,
    durationMs: null,
  });
  return activeRunner.run(plane, geometry, {
    onProgress: (progress) => {
      if (resultStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({ progress });
      }
    },
    onResult: (result, durationMs) => {
      if (!resultStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) return;
      if (result.status === 'ready') {
        applySplitResult(result, plane, durationMs);
      } else {
        useManualPlaneSplit.setState({
          phase: 'error',
          progress: '',
          error: result.message,
          errorCode: result.code,
          durationMs,
        });
      }
    },
    onError: (message) => {
      if (resultStillCurrent(instanceId, sourceAssetId, sourceEditVersion)) {
        useManualPlaneSplit.setState({
          phase: 'error',
          progress: '',
          error: message,
          errorCode: 'worker_failed',
        });
      }
    },
    onCancelled: () => {
      const current = useManualPlaneSplit.getState();
      if (
        current.phase === 'running'
        && current.instanceId === instanceId
        && current.sourceAssetId === sourceAssetId
      ) {
        useManualPlaneSplit.setState({ phase: 'editing', progress: '' });
      }
    },
  });
}
