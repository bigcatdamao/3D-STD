import { create } from 'zustand';
import * as THREE from 'three';
import { useEffect, useState } from 'react';
import { renderThumbnail } from '../importer/thumbnail';
import type { Asset, Transform, Vec3 } from '../kernel/types';
import { runPrintCheck } from '../check/check-state';
import { dispatch, doc, geometryRegistry, sendCam, thumbRegistry, useUi } from '../state/store';
import { worldBBoxOfInstance } from '../viewport/gizmo-math';
import { closePlaneCutPreview } from './plane-cut-state';
import type { PlaneEquation, PlaneSplitPart, PlaneSplitResult } from './plane-split-core';
import { PlaneSplitRunner, type PlaneSplitWorkerLike } from './plane-split-runner';

export type ManualPlaneMode = 'translate' | 'rotate' | 'scale';
export type ManualPlaneAxis = 'x' | 'y' | 'z' | 'custom';

export interface ManualPlaneSplitState {
  phase: 'idle' | 'editing' | 'running' | 'error';
  instanceId: string | null;
  sourceAssetId: string | null;
  sourceEditVersion: number;
  position: Vec3;
  rotation: Vec3;
  size: [number, number];
  bounds: { min: Vec3; max: Vec3 } | null;
  mode: ManualPlaneMode;
  axis: ManualPlaneAxis;
  progress: string;
  error: string | null;
  errorCode: string | null;
  durationMs: number | null;
}

const initialState: ManualPlaneSplitState = {
  phase: 'idle',
  instanceId: null,
  sourceAssetId: null,
  sourceEditVersion: -1,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [100, 100],
  bounds: null,
  mode: 'translate',
  axis: 'z',
  progress: '',
  error: null,
  errorCode: null,
  durationMs: null,
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

function getRunner(): PlaneSplitRunner | null {
  if (runner) return runner;
  if (typeof Worker === 'undefined') return null;
  runner = new PlaneSplitRunner(() => new Worker(
    new URL('./plane-split.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as PlaneSplitWorkerLike);
  return runner;
}

export function _injectPlaneSplitRunner(next: PlaneSplitRunner | null): void {
  runner?.cancel();
  runner = next;
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

export function startManualPlaneSplit(instanceId: string): boolean {
  const instance = doc.nodes.get(instanceId);
  if (
    !instance
    || instance.kind !== 'instance'
    || doc.effectiveLocked(instanceId)
    || !geometryRegistry.has(instance.assetId)
  ) return false;
  runner?.cancel();
  closePlaneCutPreview();
  const world = worldBBoxOfInstance(instance.transform, doc.assets.get(instance.assetId)!.meta.bbox);
  const center = world.getCenter(new THREE.Vector3());
  const dimensions = world.getSize(new THREE.Vector3());
  const visualSize = Math.max(dimensions.x, dimensions.y, dimensions.z, 20) * 1.3;
  useManualPlaneSplit.setState({
    ...initialState,
    phase: 'editing',
    instanceId,
    sourceAssetId: instance.assetId,
    sourceEditVersion: doc.editVersion,
    position: [center.x, center.y, center.z],
    rotation: [0, 0, 0],
    size: [visualSize, visualSize],
    bounds: {
      min: [world.min.x, world.min.y, world.min.z],
      max: [world.max.x, world.max.y, world.max.z],
    },
    mode: 'translate',
    axis: 'z',
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
  useManualPlaneSplit.setState(initialState, true);
}

export function setManualPlaneMode(mode: ManualPlaneMode): void {
  const state = useManualPlaneSplit.getState();
  if (state.phase === 'editing' || state.phase === 'error') {
    useManualPlaneSplit.setState({ mode, phase: 'editing', error: null, errorCode: null });
  }
}

export function setManualPlanePosition(position: Vec3): void {
  const state = useManualPlaneSplit.getState();
  if (state.phase !== 'editing' && state.phase !== 'error') return;
  useManualPlaneSplit.setState({
    position: cloneVec3(position),
    phase: 'editing',
    axis: state.axis,
    error: null,
    errorCode: null,
  });
}

export function setManualPlaneRotation(rotation: Vec3, axis: ManualPlaneAxis = 'custom'): void {
  const state = useManualPlaneSplit.getState();
  if (state.phase !== 'editing' && state.phase !== 'error') return;
  useManualPlaneSplit.setState({
    rotation: rotation.map(normalizedDeg) as Vec3,
    phase: 'editing',
    axis,
    error: null,
    errorCode: null,
  });
}

export function setManualPlaneSize(size: [number, number]): void {
  const state = useManualPlaneSplit.getState();
  if (state.phase !== 'editing' && state.phase !== 'error') return;
  useManualPlaneSplit.setState({
    size: [Math.max(10, size[0]), Math.max(10, size[1])],
    phase: 'editing',
    error: null,
    errorCode: null,
  });
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

function resultStillCurrent(
  instanceId: string,
  sourceAssetId: string,
  sourceEditVersion: number,
): boolean {
  const state = useManualPlaneSplit.getState();
  return state.phase === 'running'
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

export function confirmManualPlaneSplit(): boolean {
  const state = useManualPlaneSplit.getState();
  if (
    (state.phase !== 'editing' && state.phase !== 'error')
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
