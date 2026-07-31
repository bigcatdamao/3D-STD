import type { EngineFailReason, EngineTask } from './api-types';
import type { TaskMapStore } from './engine';
import { HI3D_BASE, Hi3DClient, hi3dCodeOk, type Hi3DEnvelope } from './hi3d-client';

export const HI3D_SPLIT_ENDPOINT = `${HI3D_BASE}/segmentation/create-task`;
export const HI3D_SPLIT_QUERY_ENDPOINT = `${HI3D_BASE}/segmentation/query-task`;
export const HI3D_MESH_MAX_BYTES = 200 * 1024 * 1024;
export const HI3D_MESH_EXTENSIONS = ['glb', 'stl', 'obj'] as const;

export type Hi3DSplitLevel = 'low' | 'medium' | 'high';

export interface Hi3DSplitTaskData {
  task_id: string;
  state: string;
  id?: string;
  url?: string;
  progress?: number;
}

export interface Hi3DSplitEngineOptions {
  accessKey?: string;
  secretKey?: string;
  taskMap?: TaskMapStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Hi3DSplitSubmit {
  mesh: File;
  level: Hi3DSplitLevel;
  outputFormat?: 1 | 2 | 3 | 4 | 5;
}

const progressOf = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(100, Math.max(0, n));
};

export function mapHi3DSplitTask(data: Hi3DSplitTaskData, taskId: string): EngineTask {
  let status: EngineTask['status'];
  let fallbackProgress = 0;
  let failReason: EngineFailReason | undefined;
  switch (data.state) {
    case 'created':
    case 'queueing':
      status = 'queued';
      break;
    case 'processing':
      status = 'running';
      fallbackProgress = 45;
      break;
    case 'success':
      status = 'success';
      fallbackProgress = 100;
      break;
    case 'failed':
      status = 'failed';
      failReason = 'service';
      break;
    default:
      status = 'failed';
      failReason = 'timeout';
  }
  return {
    taskId,
    status,
    progress: progressOf(data.progress, fallbackProgress),
    ...(status === 'success' ? { resultUrl: `/api/split/${encodeURIComponent(taskId)}/result` } : {}),
    ...(failReason ? { failReason } : {}),
  };
}

export class Hi3DSplitEngine {
  readonly name = 'hi3d';
  private readonly client: Hi3DClient;

  constructor(private readonly options: Hi3DSplitEngineOptions) {
    this.client = new Hi3DClient(options);
  }

  async submit(input: Hi3DSplitSubmit, serviceTaskId: string): Promise<EngineTask> {
    const form = new FormData();
    form.set('mesh', input.mesh, input.mesh.name);
    form.set('seg_level', input.level);
    form.set('format', String(input.outputFormat ?? 2));
    const response = await this.client.authorizedFetch(HI3D_SPLIT_ENDPOINT, { method: 'POST', body: form }, 'Token');
    let body: Hi3DEnvelope<{ task_id: string }> | null = null;
    try {
      body = (await response.json()) as Hi3DEnvelope<{ task_id: string }>;
    } catch {
      body = null;
    }
    const taskId = body?.data?.task_id;
    if (!response.ok || !body || !hi3dCodeOk(body.code) || !taskId) {
      throw new Error(`hi3d_split_submit_failed http=${response.status} code=${body?.code ?? 'n/a'}`);
    }
    if (this.options.taskMap) await this.options.taskMap.put(taskId, serviceTaskId);
    return { taskId, status: 'queued', progress: 0 };
  }

  /** Forward an already-encoded multipart body without buffering the mesh. */
  async submitMultipart(body: ReadableStream<Uint8Array>, contentType: string, serviceTaskId: string): Promise<EngineTask> {
    const response = await this.client.authorizedFetchStream(HI3D_SPLIT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    }, 'Token');
    let envelope: Hi3DEnvelope<{ task_id: string }> | null = null;
    try {
      envelope = (await response.json()) as Hi3DEnvelope<{ task_id: string }>;
    } catch {
      envelope = null;
    }
    const taskId = envelope?.data?.task_id;
    if (!response.ok || !envelope || !hi3dCodeOk(envelope.code) || !taskId) {
      throw new Error(`hi3d_split_submit_failed http=${response.status} code=${envelope?.code ?? 'n/a'}`);
    }
    if (this.options.taskMap) await this.options.taskMap.put(taskId, serviceTaskId);
    return { taskId, status: 'queued', progress: 0 };
  }

  async query(taskId: string): Promise<EngineTask> {
    const data = await this.fetchTask(taskId);
    return data ? mapHi3DSplitTask(data, taskId) : { taskId, status: 'failed', progress: 0, failReason: 'timeout' };
  }

  async billingIdOf(taskId: string): Promise<string | null> {
    return this.options.taskMap ? this.options.taskMap.get(taskId) : null;
  }

  async resultAsset(taskId: string): Promise<{ url: string } | null> {
    const data = await this.fetchTask(taskId);
    return data?.state === 'success' && data.url ? { url: data.url } : null;
  }

  private async fetchTask(taskId: string): Promise<Hi3DSplitTaskData | null> {
    const endpoint = `${HI3D_SPLIT_QUERY_ENDPOINT}?task_id=${encodeURIComponent(taskId)}`;
    const response = await this.client.authorizedFetch(endpoint, {}, 'Token');
    if (response.status >= 500) throw new Error(`hi3d_split_query_failed http=${response.status}`);
    let body: Hi3DEnvelope<Hi3DSplitTaskData> | null = null;
    try {
      body = (await response.json()) as Hi3DEnvelope<Hi3DSplitTaskData>;
    } catch {
      body = null;
    }
    if (!response.ok || !body || !hi3dCodeOk(body.code) || !body.data) return null;
    return body.data;
  }
}
