import * as THREE from 'three';
import { create } from 'zustand';
import { runPrintCheck } from '../check/check-state';
import { renderThumbnail } from '../importer/thumbnail';
import type { Asset } from '../kernel/types';
import { dispatch, doc, geometryRegistry, thumbRegistry, useUi } from '../state/store';
import {
  assessConnectorPairCandidate,
  buildConnectorPair,
  faceCountOf,
  type ConnectorCandidate,
  type ConnectorParameters,
  type ConnectorRole,
} from './connector-geometry';

export type ConnectorPhase =
  | 'idle'
  | 'pickFirst'
  | 'pickSecond'
  | 'configure'
  | 'previewing'
  | 'previewReady'
  | 'applying'
  | 'error';

interface ConnectorState {
  phase: ConnectorPhase;
  sourceEditVersion: number;
  firstInstanceId: string | null;
  secondInstanceId: string | null;
  first: ConnectorCandidate | null;
  second: ConnectorCandidate | null;
  hover: ConnectorCandidate | null;
  firstRole: ConnectorRole;
  parameters: ConnectorParameters;
  error: string | null;
}

const defaults: ConnectorState = {
  phase: 'idle',
  sourceEditVersion: -1,
  firstInstanceId: null,
  secondInstanceId: null,
  first: null,
  second: null,
  hover: null,
  firstRole: 'male',
  parameters: { diameterMm: 4, depthMm: 7, clearanceMm: 0.25 },
  error: null,
};

export const useConnector = create<ConnectorState>()(() => defaults);

let previewFirst: THREE.BufferGeometry | null = null;
let previewSecond: THREE.BufferGeometry | null = null;

function disposePreview() {
  previewFirst?.dispose();
  previewSecond?.dispose();
  previewFirst = null;
  previewSecond = null;
}

export function connectorIsActive(): boolean {
  return useConnector.getState().phase !== 'idle';
}

export function connectorIsStale(): boolean {
  const state = useConnector.getState();
  return state.phase !== 'idle' && state.sourceEditVersion !== doc.editVersion;
}

export function startConnector(firstInstanceId: string): boolean {
  const node = doc.nodes.get(firstInstanceId);
  if (!node || node.kind !== 'instance' || doc.effectiveLocked(firstInstanceId)) {
    useUi.getState().setToast('请先选择一个未锁定零件');
    return false;
  }
  if (!geometryRegistry.has(node.assetId)) {
    useUi.getState().setToast('当前零件的网格不可读取');
    return false;
  }
  disposePreview();
  useConnector.setState({
    ...defaults,
    phase: 'pickFirst',
    sourceEditVersion: doc.editVersion,
    firstInstanceId,
  }, true);
  return true;
}

export function cancelConnector() {
  disposePreview();
  useConnector.setState(defaults, true);
}

export function setConnectorHover(candidate: ConnectorCandidate | null) {
  const state = useConnector.getState();
  if (state.phase !== 'pickFirst' && state.phase !== 'pickSecond') return;
  useConnector.setState({ hover: candidate });
}

export function chooseConnectorCandidate(candidate: ConnectorCandidate): boolean {
  const state = useConnector.getState();
  const resolved = state.phase === 'pickSecond' && state.first
    ? assessConnectorPairCandidate(state.first, candidate, state.parameters)
    : candidate;
  if (resolved.rating === 'invalid') {
    useUi.getState().setToast(resolved.message);
    return false;
  }
  if (state.phase === 'pickFirst' && resolved.instanceId === state.firstInstanceId) {
    useConnector.setState({ first: resolved, hover: null, phase: 'pickSecond', error: null });
    return true;
  }
  if (state.phase === 'pickSecond' && resolved.instanceId !== state.firstInstanceId) {
    useConnector.setState({
      second: resolved,
      secondInstanceId: resolved.instanceId,
      hover: null,
      phase: 'configure',
      error: null,
    });
    return true;
  }
  return false;
}

export function setConnectorFirstRole(firstRole: ConnectorRole) {
  const phase = useConnector.getState().phase;
  if (phase === 'pickSecond' || phase === 'configure' || phase === 'error') {
    useConnector.setState({ firstRole, error: null, phase: phase === 'error' ? 'configure' : phase });
  }
}

export function setConnectorParameter<K extends keyof ConnectorParameters>(key: K, value: number) {
  const state = useConnector.getState();
  if (state.phase !== 'configure' && state.phase !== 'error') return;
  const ranges: Record<keyof ConnectorParameters, [number, number]> = {
    diameterMm: [1.5, 16],
    depthMm: [2, 24],
    clearanceMm: [0.05, 1.2],
  };
  const [min, max] = ranges[key];
  useConnector.setState({
    parameters: { ...state.parameters, [key]: THREE.MathUtils.clamp(value, min, max) },
    error: null,
    phase: 'configure',
  });
}

export function backConnectorStep() {
  const state = useConnector.getState();
  disposePreview();
  if (state.phase === 'previewReady' || state.phase === 'error') {
    useConnector.setState({ phase: state.second ? 'configure' : 'pickSecond', error: null });
  } else if (state.phase === 'configure') {
    useConnector.setState({ phase: 'pickSecond', second: null, secondInstanceId: null, hover: null, error: null });
  } else if (state.phase === 'pickSecond') {
    useConnector.setState({ phase: 'pickFirst', first: null, hover: null, error: null });
  }
}

export function getConnectorPreviewGeometries(): readonly [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  return [previewFirst, previewSecond];
}

export function connectorPreviewInstanceIds(): string[] {
  const state = useConnector.getState();
  return state.phase === 'previewReady' && state.firstInstanceId && state.secondInstanceId
    ? [state.firstInstanceId, state.secondInstanceId]
    : [];
}

export async function generateConnectorPreview(): Promise<boolean> {
  const state = useConnector.getState();
  if (!state.first || !state.second || !state.firstInstanceId || !state.secondInstanceId) return false;
  if (connectorIsStale()) {
    useConnector.setState({ phase: 'error', error: '场景已变化，请退出后重新开始' });
    return false;
  }
  const firstNode = doc.nodes.get(state.firstInstanceId);
  const secondNode = doc.nodes.get(state.secondInstanceId);
  if (!firstNode || firstNode.kind !== 'instance' || !secondNode || secondNode.kind !== 'instance') return false;
  const firstGeometry = geometryRegistry.get(firstNode.assetId);
  const secondGeometry = geometryRegistry.get(secondNode.assetId);
  if (!firstGeometry || !secondGeometry) return false;
  useConnector.setState({ phase: 'previewing', error: null, hover: null });
  await new Promise<void>((resolve) => window.setTimeout(resolve, 24));
  try {
    const result = buildConnectorPair({
      first: {
        geometry: firstGeometry,
        transform: firstNode.transform,
        point: state.first.point,
        normal: state.first.normal,
      },
      second: {
        geometry: secondGeometry,
        transform: secondNode.transform,
        point: state.second.point,
        normal: state.second.normal,
      },
      firstRole: state.firstRole,
      parameters: state.parameters,
    });
    disposePreview();
    previewFirst = result.first;
    previewSecond = result.second;
    useConnector.setState({ phase: 'previewReady', error: null });
    return true;
  } catch (error) {
    disposePreview();
    useConnector.setState({
      phase: 'error',
      error: error instanceof Error ? error.message : '连接布尔失败，请调整位置或尺寸',
    });
    return false;
  }
}

function assetFromGeometry(
  source: Asset,
  geometry: THREE.BufferGeometry,
  pairId: string,
  role: ConnectorRole,
  parameters: ConnectorParameters,
): Omit<Asset, 'id'> {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const createdAt = Date.now();
  return {
    name: `${source.name} · ${role === 'male' ? '凸榫' : '凹槽'}`,
    source: source.source,
    state: 'ready',
    meta: {
      ...source.meta,
      faces: faceCountOf(geometry),
      vertices: geometry.getAttribute('position').count,
      bbox: {
        min: [bbox.min.x, bbox.min.y, bbox.min.z],
        max: [bbox.max.x, bbox.max.y, bbox.max.z],
      },
      watertight: null,
      degenerate: null,
      createdAt,
    },
    genParams: {
      ...(source.genParams ?? {}),
      connector: { kind: 'cylindrical_pin', pairId, role, parameters: { ...parameters }, createdAt },
    },
  };
}

export function applyConnector(): boolean {
  const state = useConnector.getState();
  if (
    state.phase !== 'previewReady'
    || !state.firstInstanceId
    || !state.secondInstanceId
    || !previewFirst
    || !previewSecond
    || connectorIsStale()
  ) return false;
  const firstNode = doc.instance(state.firstInstanceId);
  const secondNode = doc.instance(state.secondInstanceId);
  const firstAsset = doc.assets.get(firstNode.assetId);
  const secondAsset = doc.assets.get(secondNode.assetId);
  if (!firstAsset || !secondAsset) return false;
  const pairId = `connector_${Date.now().toString(36)}`;
  const firstRole = state.firstRole;
  const secondRole: ConnectorRole = firstRole === 'male' ? 'female' : 'male';
  useConnector.setState({ phase: 'applying' });
  const result = dispatch((scene) => scene.replaceInstanceAssetsWithDerivedPair(
    [state.firstInstanceId!, state.secondInstanceId!],
    [
      assetFromGeometry(firstAsset, previewFirst!, pairId, firstRole, state.parameters),
      assetFromGeometry(secondAsset, previewSecond!, pairId, secondRole, state.parameters),
    ],
    `添加圆柱连接 · Ø${state.parameters.diameterMm.toFixed(1)} / 间隙 ${state.parameters.clearanceMm.toFixed(2)}mm`,
  ));
  geometryRegistry.set(result[0].id, previewFirst);
  geometryRegistry.set(result[1].id, previewSecond);
  const thumbFirst = renderThumbnail(previewFirst);
  const thumbSecond = renderThumbnail(previewSecond);
  if (thumbFirst) thumbRegistry.set(result[0].id, thumbFirst);
  if (thumbSecond) thumbRegistry.set(result[1].id, thumbSecond);
  previewFirst = null;
  previewSecond = null;
  useConnector.setState(defaults, true);
  useUi.getState().bump();
  useUi.getState().setToast('圆柱连接已生成，两侧保留为独立零件', {
    label: '撤销',
    run: () => dispatch((scene) => scene.history.undo()),
  });
  setTimeout(() => runPrintCheck({ onlyIds: [firstNode.id, secondNode.id] }), 0);
  return true;
}
