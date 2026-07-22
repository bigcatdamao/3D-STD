import { useEffect as useReactEffect, useState as useReactState } from 'react';
import * as THREE from 'three';
import { create } from 'zustand';
import { renderThumbnail } from '../importer/thumbnail';
import type { CheckIssue } from '../check/check-core';
import { focusIssue, reportIsStale, runPrintCheck, useCheck } from '../check/check-state';
import { dispatch, doc, geometryRegistry, thumbRegistry, useUi } from '../state/store';
import { planMeshRepair, type MeshRepairPlan, type MeshRepairStats } from './mesh-repair-core';
import type { MeshRepairWorkerReply, MeshRepairWorkerRequest } from './mesh-repair.worker';

export type MeshRepairPhase = 'idle' | 'preparing' | 'ready' | 'unsupported' | 'not_needed' | 'failed';
export type MeshRepairPreviewMode = 'overlay' | 'changes';

interface MeshRepairState {
  phase: MeshRepairPhase;
  requestId: string | null;
  issueKey: string | null;
  instanceId: string | null;
  sourceAssetId: string | null;
  sourceName: string;
  baseEditVersion: number | null;
  durationMs: number | null;
  reason: string | null;
  warnings: string[];
  actions: string[];
  stats: MeshRepairStats | null;
  previewMode: MeshRepairPreviewMode;
}

const initialState: MeshRepairState = {
  phase: 'idle',
  requestId: null,
  issueKey: null,
  instanceId: null,
  sourceAssetId: null,
  sourceName: '',
  baseEditVersion: null,
  durationMs: null,
  reason: null,
  warnings: [],
  actions: [],
  stats: null,
  previewMode: 'overlay',
};

export const useMeshRepair = create<MeshRepairState>()(() => initialState);

export function useMeshRepairSnapshot(): MeshRepairState {
  const [state, setState] = useReactState(() => useMeshRepair.getState());
  useReactEffect(() => {
    setState(useMeshRepair.getState());
    return useMeshRepair.subscribe(setState);
  }, []);
  return state;
}

let requestSequence = 0;
let activeWorker: Worker | null = null;
let activeTimer: ReturnType<typeof setTimeout> | null = null;
let repairedGeometry: THREE.BufferGeometry | null = null;
let addedGeometry: THREE.BufferGeometry | null = null;
let removedGeometry: THREE.BufferGeometry | null = null;

function disposePreviewGeometry(keepRepaired = false) {
  if (!keepRepaired) repairedGeometry?.dispose();
  addedGeometry?.dispose();
  removedGeometry?.dispose();
  repairedGeometry = null;
  addedGeometry = null;
  removedGeometry = null;
}

function stopWorker() {
  activeWorker?.terminate();
  activeWorker = null;
  if (activeTimer) clearTimeout(activeTimer);
  activeTimer = null;
}

function geometryArrays(assetId: string): { positions: Float32Array; index: Uint32Array | null } | null {
  const geometry = geometryRegistry.get(assetId);
  const attribute = geometry?.getAttribute('position');
  if (!geometry || !attribute) return null;
  const positions = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    positions[i * 3] = attribute.getX(i);
    positions[i * 3 + 1] = attribute.getY(i);
    positions[i * 3 + 2] = attribute.getZ(i);
  }
  return {
    positions,
    index: geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : null,
  };
}

function makeGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function meshRepairPreviewIsStale(): boolean {
  const state = useMeshRepair.getState();
  if (state.baseEditVersion === null || !state.instanceId || !state.sourceAssetId) return false;
  const node = doc.nodes.get(state.instanceId);
  return doc.editVersion !== state.baseEditVersion
    || node?.kind !== 'instance'
    || node.assetId !== state.sourceAssetId;
}

export function meshRepairDisabledReason(issue: CheckIssue): string | null {
  if (issue.code !== 'non_watertight' && issue.code !== 'degenerate') return '该问题不属于网格修复范围';
  if (useCheck.getState().phase !== 'done') return '请等待打印检查完成';
  if (!doc.nodes.has(issue.instanceId)) return '对象已删除';
  if (reportIsStale()) return '结果已过期，请重新检查后修复';
  if (doc.effectiveLocked(issue.instanceId)) return '对象已锁定，解锁后可修复';
  const node = doc.nodes.get(issue.instanceId);
  if (!node || node.kind !== 'instance') return '对象不是可修复实例';
  if (doc.assets.get(node.assetId)?.state !== 'ready') return '资产尚未就绪';
  if (!geometryRegistry.has(node.assetId)) return '几何数据不可用';
  return null;
}

function finishPlan(requestId: string, plan: MeshRepairPlan, durationMs: number) {
  if (useMeshRepair.getState().requestId !== requestId) return;
  stopWorker();
  disposePreviewGeometry();
  if (plan.status === 'ready' && plan.repairedPositions) {
    repairedGeometry = makeGeometry(plan.repairedPositions);
    if (plan.addedPositions.length) addedGeometry = makeGeometry(plan.addedPositions);
    if (plan.removedPositions.length) removedGeometry = makeGeometry(plan.removedPositions);
  }
  useMeshRepair.setState({
    phase: plan.status,
    durationMs,
    reason: plan.reason,
    warnings: plan.warnings,
    actions: plan.actions,
    stats: plan.stats,
  });
}

function failPlan(requestId: string, message: string) {
  if (useMeshRepair.getState().requestId !== requestId) return;
  stopWorker();
  disposePreviewGeometry();
  useMeshRepair.setState({ phase: 'failed', reason: message, durationMs: null });
}

/** 打印检查条目 → 后台生成只读修复预览。模型和历史此时均不改变。 */
export function prepareMeshRepair(issue: CheckIssue): boolean {
  const disabled = meshRepairDisabledReason(issue);
  if (disabled) return false;
  const node = doc.nodes.get(issue.instanceId);
  if (!node || node.kind !== 'instance') return false;
  const source = doc.assets.get(node.assetId);
  const arrays = geometryArrays(node.assetId);
  if (!source || !arrays) return false;

  stopWorker();
  disposePreviewGeometry();
  const requestId = `repair_${(++requestSequence).toString(36)}`;
  useMeshRepair.setState({
    ...initialState,
    phase: 'preparing',
    requestId,
    issueKey: issue.key,
    instanceId: node.id,
    sourceAssetId: node.assetId,
    sourceName: source.name,
    baseEditVersion: doc.editVersion,
  });
  useCheck.setState({ panelOpen: true });
  focusIssue(issue);
  // 修复预览接管视口证据层：清除旧问题红壳，避免与“红色=删除面”的差异语义冲突。
  useCheck.getState().setActiveKey(null);

  if (typeof Worker === 'undefined') {
    const startedAt = performance.now();
    queueMicrotask(() => {
      try {
        finishPlan(requestId, planMeshRepair(arrays.positions, arrays.index), performance.now() - startedAt);
      } catch (error) {
        failPlan(requestId, error instanceof Error ? error.message : '网格修复计算失败');
      }
    });
    return true;
  }

  const worker = new Worker(new URL('./mesh-repair.worker.ts', import.meta.url), { type: 'module' });
  activeWorker = worker;
  worker.onmessage = (event: MessageEvent<MeshRepairWorkerReply>) => {
    if (event.data.t === 'done') finishPlan(event.data.requestId, event.data.plan, event.data.durationMs);
    else failPlan(event.data.requestId, `修复计算失败：${event.data.message}`);
  };
  worker.onerror = () => failPlan(requestId, '修复计算进程异常，原模型未发生变化');
  activeTimer = setTimeout(() => failPlan(requestId, '修复预览计算超过 45 秒，已停止；原模型未发生变化'), 45_000);
  const message: MeshRepairWorkerRequest = {
    t: 'repair',
    requestId,
    positions: arrays.positions.buffer as ArrayBuffer,
    index: arrays.index ? (arrays.index.buffer as ArrayBuffer) : null,
  };
  const transfer: Transferable[] = [message.positions];
  if (message.index) transfer.push(message.index);
  worker.postMessage(message, transfer);
  return true;
}

export function cancelMeshRepairPreview() {
  stopWorker();
  disposePreviewGeometry();
  useMeshRepair.setState(initialState, true);
}

export function getRepairPreviewGeometry(): THREE.BufferGeometry | null {
  return repairedGeometry;
}

export function getRepairAddedGeometry(): THREE.BufferGeometry | null {
  return addedGeometry;
}

export function getRepairRemovedGeometry(): THREE.BufferGeometry | null {
  return removedGeometry;
}

export function setMeshRepairPreviewMode(previewMode: MeshRepairPreviewMode) {
  if (useMeshRepair.getState().phase !== 'ready') return;
  useMeshRepair.setState({ previewMode });
}

/** 用户确认后才执行：创建派生资产、切换实例引用、入历史栈，并立即重新打印检查。 */
export function applyMeshRepair(): boolean {
  const state = useMeshRepair.getState();
  if (state.phase !== 'ready' || !state.instanceId || !state.sourceAssetId || !state.stats?.after || !repairedGeometry) return false;
  if (meshRepairPreviewIsStale()) return false;
  const source = doc.assets.get(state.sourceAssetId);
  if (!source || doc.effectiveLocked(state.instanceId)) return false;

  const geometry = repairedGeometry;
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const createdAt = Date.now();
  const derived = dispatch((scene) => scene.replaceInstanceAssetWithDerived(
    state.instanceId!,
    {
      name: `${source.name} · 修复版`,
      source: source.source,
      state: 'ready',
      meta: {
        faces: state.stats!.after!.faces,
        vertices: state.stats!.after!.weldedVertices,
        bbox: {
          min: [bbox.min.x, bbox.min.y, bbox.min.z],
          max: [bbox.max.x, bbox.max.y, bbox.max.z],
        },
        unitChoice: source.meta.unitChoice,
        watertight: state.stats!.after!.watertight,
        degenerate: state.stats!.after!.degenerateCount > 0,
        createdAt,
      },
      genParams: {
        ...(source.genParams ?? {}),
        repair: {
          kind: 'safe_mesh_repair',
          fromAssetId: source.id,
          createdAt,
          actions: [...state.actions],
          warnings: [...state.warnings],
        },
      },
    },
    '生成网格修复副本',
  ));

  geometryRegistry.set(derived.id, geometry);
  const thumbnail = renderThumbnail(geometry);
  if (thumbnail) thumbRegistry.set(derived.id, thumbnail);
  repairedGeometry = null; // 所有权已转移给 geometryRegistry，取消预览时不可 dispose。
  addedGeometry?.dispose();
  removedGeometry?.dispose();
  addedGeometry = null;
  removedGeometry = null;
  useMeshRepair.setState(initialState, true);
  useUi.getState().bump();
  useUi.getState().setToast('已生成修复副本并保留原资产', {
    label: '撤销',
    run: () => dispatch((scene) => scene.history.undo()),
  });
  setTimeout(() => runPrintCheck(), 0);
  return true;
}
