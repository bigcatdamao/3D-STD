import { create } from 'zustand';
import * as THREE from 'three';
import { useEffect, useState } from 'react';
import type {
  ApiError,
  SplitLevel,
  SplitResultManifestResponse,
  SplitSubmitResponse,
  SplitTaskResponse,
} from '../../worker/api-types';
import { runPrintCheck } from '../check/check-state';
import { extractGeometry, sanitizeName, writeBinarySTL } from '../export/export-core';
import type { Asset, Vec3 } from '../kernel/types';
import { defaultTransform } from '../kernel/types';
import { renderThumbnail } from '../importer/thumbnail';
import { apiHeaders } from '../net/visitor';
import { dispatch, doc, geometryRegistry, thumbRegistry, useUi } from '../state/store';
import type { AutoSplitWorkerReply } from './auto-split-result.worker';

export type AutoSplitPhase = 'idle' | 'ready' | 'submitting' | 'queued' | 'running' | 'importing' | 'done' | 'error';

export interface AutoSplitState {
  phase: AutoSplitPhase;
  instanceId: string | null;
  sourceAssetId: string | null;
  sourceEditVersion: number;
  sourceName: string;
  sourceFaces: number;
  uploadBytes: number;
  level: SplitLevel;
  taskId: string | null;
  progress: number;
  statusText: string;
  error: string | null;
  partCount: number;
  sourceMode: 'upload-stl' | 'provider-fbx';
  sourceProvider: 'hi3d' | 'hunyuan';
  sourceProviderTaskId: string | null;
}

const initialState: AutoSplitState = {
  phase: 'idle',
  instanceId: null,
  sourceAssetId: null,
  sourceEditVersion: -1,
  sourceName: '',
  sourceFaces: 0,
  uploadBytes: 0,
  level: 'medium',
  taskId: null,
  progress: 0,
  statusText: '',
  error: null,
  partCount: 0,
  sourceMode: 'upload-stl',
  sourceProvider: 'hi3d',
  sourceProviderTaskId: null,
};

export const useAutoSplit = create<AutoSplitState>()(() => initialState);

export function hunyuanSplitTaskIdOf(asset: Pick<Asset, 'genParams'>): string | null {
  const taskId = asset.genParams?.engine === 'hunyuan' && typeof asset.genParams.taskId === 'string'
    ? asset.genParams.taskId
    : null;
  return taskId?.startsWith('hy3d_') ? taskId : null;
}

/** SSR 与客户端首帧都读取当前会话，便于右侧面板测试与热更新恢复。 */
export function useAutoSplitSnapshot(): AutoSplitState {
  const [state, setState] = useState(() => useAutoSplit.getState());
  useEffect(() => {
    setState(useAutoSplit.getState());
    return useAutoSplit.subscribe(setState);
  }, []);
  return state;
}

const activePhases = new Set<AutoSplitPhase>(['submitting', 'queued', 'running', 'importing']);
export const autoSplitIsActive = () => useAutoSplit.getState().phase !== 'idle';
export const autoSplitIsBusy = () => activePhases.has(useAutoSplit.getState().phase);

function sourceFile(instanceId: string): File {
  const instance = doc.instance(instanceId);
  const geometry = extractGeometry(geometryRegistry.get(instance.assetId));
  if (!geometry) throw new Error('源模型几何不可读取');
  const buffer = writeBinarySTL([{ ...geometry, transform: defaultTransform() }]);
  const asset = doc.assets.get(instance.assetId);
  return new File([buffer], `${sanitizeName(asset?.name || instance.name) || 'model'}.stl`, { type: 'model/stl' });
}

export function startAutoSplit(instanceId: string): boolean {
  if (autoSplitIsBusy()) return true;
  const node = doc.nodes.get(instanceId);
  if (!node || node.kind !== 'instance') {
    useUi.getState().setToast('没有找到可拆件对象，请重新选择模型');
    return false;
  }
  if (doc.effectiveLocked(instanceId)) {
    useUi.getState().setToast('对象已锁定，解锁后才能自动拆件');
    return false;
  }
  const asset = doc.assets.get(node.assetId);
  if (!asset || !geometryRegistry.has(asset.id)) {
    useUi.getState().setToast('源模型几何不可读取，暂时不能自动拆件');
    return false;
  }
  try {
    const sourceProviderTaskId = hunyuanSplitTaskIdOf(asset);
    if (!sourceProviderTaskId) {
      throw new Error('当前模型缺少混元生成阶段的 FBX 来源，请使用「手动拆件」；本地模型自动转换已列入后续商业化选型');
    }
    const sourceMode = 'provider-fbx' as const;
    useAutoSplit.setState({
      ...initialState,
      phase: 'ready',
      instanceId,
      sourceAssetId: asset.id,
      sourceEditVersion: doc.editVersion,
      sourceName: node.name,
      sourceFaces: asset.meta.faces,
      uploadBytes: 0,
      sourceMode,
      sourceProvider: 'hunyuan',
      sourceProviderTaskId,
    }, true);
    return true;
  } catch (error) {
    useUi.getState().setToast(error instanceof Error ? error.message : '无法准备自动拆件');
    return false;
  }
}

export function setAutoSplitLevel(level: SplitLevel): void {
  if (!autoSplitIsBusy()) useAutoSplit.setState({ level });
}

export function closeAutoSplit(): boolean {
  if (autoSplitIsBusy()) {
    useUi.getState().setToast('拆件任务正在处理，请等待完成后再退出');
    return false;
  }
  useAutoSplit.setState(initialState, true);
  return true;
}

function apiError(value: unknown, fallback: string): string {
  const error = value as Partial<ApiError> | null;
  return error?.message?.trim() || fallback;
}

async function readApiJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) throw new Error(`${fallback}（HTTP ${response.status}，服务未返回内容）`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${fallback}（HTTP ${response.status}，返回格式异常）`);
  }
}

function sourceIsCurrent(state: AutoSplitState): boolean {
  const node = state.instanceId ? doc.nodes.get(state.instanceId) : null;
  return !!node
    && node.kind === 'instance'
    && node.assetId === state.sourceAssetId
    && doc.editVersion === state.sourceEditVersion;
}

interface ParsedPart {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  faces: number;
  bbox: { min: Vec3; max: Vec3 };
}

function parseResult(files: Blob[], sourceBounds: { min: Vec3; max: Vec3 }): Promise<ParsedPart[]> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('当前浏览器不支持后台解析 Worker'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./auto-split-result.worker.ts', import.meta.url), { type: 'module' });
    const jobId = `as_${Date.now().toString(36)}`;
    worker.onmessage = (event: MessageEvent<AutoSplitWorkerReply>) => {
      const reply = event.data;
      if (reply.jobId !== jobId) return;
      if (reply.t === 'progress') {
        useAutoSplit.setState({ progress: 86 + Math.round(reply.pct * 0.12), statusText: reply.phase });
        return;
      }
      worker.terminate();
      if (reply.t === 'err') {
        reject(new Error(reply.message));
        return;
      }
      resolve(reply.parts.map((part) => ({
        ...part,
        positions: new Float32Array(part.positions),
        normals: part.normals ? new Float32Array(part.normals) : null,
      })));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('拆件结果解析 Worker 异常'));
    };
    worker.postMessage({ jobId, files, sourceBounds });
  });
}

function geometryOf(part: ParsedPart): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  if (part.normals && part.normals.length === part.positions.length) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

async function resultBlobs(response: Response): Promise<Blob[]> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return [await response.blob()];
  const manifest = (await response.json()) as SplitResultManifestResponse | ApiError;
  if (!manifest.ok || !('parts' in manifest) || manifest.parts.length < 2) {
    throw new Error(apiError(manifest, '拆件结果不足两个独立零件'));
  }
  const blobs: Blob[] = [];
  for (const part of manifest.parts) {
    const responsePart = await fetch(part.url, { headers: apiHeaders() });
    if (!responsePart.ok) throw new Error(`零件结果下载失败：${part.name}`);
    blobs.push(await responsePart.blob());
  }
  return blobs;
}

async function importResult(taskId: string, resultUrl?: string): Promise<void> {
  const state = useAutoSplit.getState();
  const source = state.sourceAssetId ? doc.assets.get(state.sourceAssetId) : null;
  if (!source || !state.instanceId) throw new Error('源模型已不存在，未导入拆件结果');
  useAutoSplit.setState({ phase: 'importing', progress: 86, statusText: '下载并解析独立零件' });
  const response = await fetch(resultUrl || `/api/split/${encodeURIComponent(taskId)}/result`, { headers: apiHeaders() });
  if (!response.ok) {
    let body: unknown = null;
    try { body = await response.json(); } catch { /* 非 JSON 上游错误 */ }
    throw new Error(apiError(body, '拆件结果下载失败'));
  }
  const parts = await parseResult(await resultBlobs(response), source.meta.bbox);
  const fresh = useAutoSplit.getState();
  if (!sourceIsCurrent(fresh)) throw new Error('等待期间场景已被编辑。为保护现有工作，结果未自动导入，请重新拆件');
  const createdAt = Date.now();
  const derived = parts.map((part, index): Omit<Asset, 'id'> => ({
    name: `${source.name} · 自动拆件 ${index + 1}`,
    source: source.source,
    state: 'ready',
    meta: {
      faces: part.faces,
      vertices: part.positions.length / 3,
      bbox: part.bbox,
      unitChoice: source.meta.unitChoice,
      watertight: null,
      degenerate: null,
      createdAt,
    },
    genParams: {
      ...(source.genParams ?? {}),
      split: {
        kind: fresh.sourceProvider === 'hunyuan' ? 'hunyuan_component_split' : 'hi3d_semantic_split',
        provider: fresh.sourceProvider,
        fromAssetId: source.id,
        taskId,
        level: fresh.level,
        part: index + 1,
        createdAt,
      },
    },
  }));
  const result = dispatch((scene) => scene.splitInstanceWithDerivedPartsMany(
    fresh.instanceId!,
    derived,
    `自动拆件 · ${source.name} · ${parts.length} 个零件`,
  ));
  result.assets.forEach((asset, index) => {
    const geometry = geometryOf(parts[index]);
    geometryRegistry.set(asset.id, geometry);
    const thumbnail = renderThumbnail(geometry);
    if (thumbnail) thumbRegistry.set(asset.id, thumbnail);
  });
  useUi.getState().bump();
  useAutoSplit.setState({ phase: 'done', progress: 100, statusText: '已导入独立零件', partCount: parts.length, error: null });
  useUi.getState().setToast(`自动拆件完成：${parts.length} 个独立零件，原始资产仍保留在资产库`, {
    label: '撤销',
    run: () => dispatch((scene) => scene.history.undo()),
  });
  window.setTimeout(() => void runPrintCheck(), 0);
}

const POLL_MS = 3000;
const MAX_POLLS = 240;

async function pollTask(taskId: string, attempt = 0): Promise<void> {
  try {
    if (attempt >= MAX_POLLS) throw new Error('拆件等待超过 12 分钟，可稍后点击“继续查询”');
    const response = await fetch(`/api/split/${encodeURIComponent(taskId)}`, { headers: apiHeaders() });
    const body = await readApiJson<SplitTaskResponse | ApiError>(response, '拆件状态查询失败');
    if (!response.ok || !body.ok) throw new Error(apiError(body, '拆件状态查询失败'));
    const task = (body as SplitTaskResponse).task;
    if (task.status === 'failed') {
      const provider = useAutoSplit.getState().sourceProvider === 'hunyuan' ? '混元组件生成' : 'Hi3D 拆件';
      const code = task.providerCode ? `（${task.providerCode}）` : '';
      throw new Error(task.failReason === 'timeout'
        ? `${provider}超时，本次额度已返还${code}`
        : `${provider}失败，本次额度已返还${code}`);
    }
    if (task.status === 'success') {
      await importResult(taskId, task.resultUrl);
      return;
    }
    useAutoSplit.setState({
      phase: task.status === 'queued' ? 'queued' : 'running',
      progress: Math.max(3, Math.min(84, task.progress || (task.status === 'queued' ? 5 : 20))),
      statusText: task.status === 'queued'
        ? `${useAutoSplit.getState().sourceProvider === 'hunyuan' ? '混元' : 'Hi3D'} 排队中`
        : useAutoSplit.getState().sourceProvider === 'hunyuan' ? '混元正在生成独立组件' : 'Hi3D 正在识别语义零件',
    });
    window.setTimeout(() => void pollTask(taskId, attempt + 1), POLL_MS);
  } catch (error) {
    useAutoSplit.setState({ phase: 'error', error: error instanceof Error ? error.message : '自动拆件失败', statusText: '' });
  }
}

export async function submitAutoSplit(turnstileToken: string): Promise<boolean> {
  const state = useAutoSplit.getState();
  if (state.phase !== 'ready' && state.phase !== 'error') return false;
  if (!state.instanceId || !state.sourceAssetId || !sourceIsCurrent(state)) {
    useAutoSplit.setState({ phase: 'error', error: '源模型已变化，请退出后重新选择模型', statusText: '' });
    return false;
  }
  if (!turnstileToken) {
    useAutoSplit.setState({ phase: 'error', error: '人机验证尚未完成，请稍后重试', statusText: '' });
    return false;
  }
  try {
    const headers = new Headers(apiHeaders());
    let body: BodyInit;
    if (state.sourceMode === 'provider-fbx' && state.sourceProviderTaskId) {
      useAutoSplit.setState({ phase: 'submitting', progress: 2, statusText: '复用混元 FBX 并提交组件生成', error: null, taskId: null });
      headers.set('content-type', 'application/json');
      body = JSON.stringify({
        sourceTaskId: state.sourceProviderTaskId,
        level: state.level,
        turnstileToken,
      });
    } else {
      useAutoSplit.setState({ phase: 'submitting', progress: 2, statusText: '导出临时 STL 并上传', error: null, taskId: null });
      const form = new FormData();
      const mesh = sourceFile(state.instanceId);
      form.set('mesh', mesh);
      form.set('seg_level', state.level);
      form.set('format', '2');
      headers.set('x-turnstile-token', turnstileToken);
      headers.set('x-mesh-name', encodeURIComponent(mesh.name));
      headers.set('x-mesh-size', String(mesh.size));
      headers.set('x-split-level', state.level);
      body = form;
    }
    const response = await fetch('/api/split', { method: 'POST', headers, body });
    const result = await readApiJson<SplitSubmitResponse | ApiError>(response, '自动拆件提交失败');
    if (!response.ok || !result.ok) throw new Error(apiError(result, '自动拆件提交失败'));
    const task = (result as SplitSubmitResponse).task;
    useAutoSplit.setState({ taskId: task.taskId, phase: task.status === 'running' ? 'running' : 'queued', progress: task.progress || 5, statusText: '任务已提交' });
    void pollTask(task.taskId);
    return true;
  } catch (error) {
    useAutoSplit.setState({ phase: 'error', error: error instanceof Error ? error.message : '自动拆件提交失败', statusText: '' });
    return false;
  }
}

export function resumeAutoSplit(): void {
  const taskId = useAutoSplit.getState().taskId;
  if (!taskId) return;
  useAutoSplit.setState({ phase: 'queued', error: null, statusText: '继续查询任务' });
  void pollTask(taskId);
}
