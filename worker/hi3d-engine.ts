import type { EngineTask, GenerateRequest, ImageView } from './api-types';
import type { Engine, TaskMapStore } from './engine';
import { HI3D_BASE, Hi3DClient, hi3dCodeOk, type Hi3DEnvelope } from './hi3d-client';

export const HI3D_GENERATE_ENDPOINT = `${HI3D_BASE}/submit-task`;
export const HI3D_GENERATE_QUERY_ENDPOINT = `${HI3D_BASE}/query-task`;

export interface Hi3DGenerateTaskData {
  task_id: string;
  state: string;
  id?: string;
  url?: string;
  cover_url?: string;
  progress?: number;
}

export interface Hi3DEngineOptions {
  accessKey?: string;
  secretKey?: string;
  model: string;
  resolution: string;
  faceCount: number;
  timeoutMs: number;
  taskMap?: TaskMapStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const clamp = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(100, Math.max(0, n));
};

export function mapHi3DGenerateTask(data: Hi3DGenerateTaskData, taskId: string): EngineTask {
  switch (data.state) {
    case 'created':
    case 'queueing':
      return { taskId, status: 'queued', progress: clamp(data.progress, 0) };
    case 'processing':
      return { taskId, status: 'running', progress: clamp(data.progress, 45) };
    case 'success':
      return { taskId, status: 'success', progress: 100, resultUrl: `/api/task/${encodeURIComponent(taskId)}/result` };
    case 'failed':
      return { taskId, status: 'failed', progress: clamp(data.progress, 0), failReason: 'service' };
    default:
      return { taskId, status: 'failed', progress: 0, failReason: 'timeout' };
  }
}

function orderedImages(req: GenerateRequest) {
  const byView = new Map((req.images ?? []).map((image) => [image.view, image] as const));
  const order: ImageView[] = ['front', 'back', 'left', 'right'];
  return order.map((view) => byView.get(view)).filter((image): image is NonNullable<typeof image> => Boolean(image));
}

function multiviewBit(req: GenerateRequest): string {
  const views = new Set((req.images ?? []).map((image) => image.view));
  return (['front', 'back', 'left', 'right'] as ImageView[]).map((view) => (views.has(view) ? '1' : '0')).join('');
}

export class Hi3DEngine implements Engine {
  readonly name = 'hi3d';
  readonly supportedTypes = ['image', 'multiview'] as const;
  readonly acceptsOwnKey = false;
  readonly promptMaxLength = 0;
  private readonly client: Hi3DClient;

  constructor(private readonly options: Hi3DEngineOptions) {
    this.client = new Hi3DClient(options);
  }

  async submit(req: GenerateRequest, serviceTaskId: string): Promise<EngineTask> {
    if (req.type === 'text') throw new Error('hi3d_text_not_supported');
    const images = orderedImages(req);
    if (!images.length) throw new Error('hi3d_images_missing');

    const form = new FormData();
    form.set('request_type', '3');
    form.set('model', this.options.model);
    form.set('resolution', this.options.resolution);
    form.set('face', String(this.options.faceCount));
    form.set('pbr', '1');
    form.set('format', '2');
    if (req.type === 'image') {
      form.set('images', images[0].file, images[0].file.name);
    } else {
      for (const image of images) form.append('multi_images', image.file, image.file.name);
      form.set('multi_images_bit', multiviewBit(req));
    }

    const response = await this.client.authorizedFetch(HI3D_GENERATE_ENDPOINT, { method: 'POST', body: form });
    let body: Hi3DEnvelope<{ task_id: string }> | null = null;
    try {
      body = (await response.json()) as Hi3DEnvelope<{ task_id: string }>;
    } catch {
      body = null;
    }
    const taskId = body?.data?.task_id;
    if (!response.ok || !body || !hi3dCodeOk(body.code) || !taskId) {
      throw new Error(`hi3d_submit_failed http=${response.status} code=${body?.code ?? 'n/a'}`);
    }
    if (this.options.taskMap) await this.options.taskMap.put(taskId, serviceTaskId);
    return { taskId, status: 'queued', progress: 0 };
  }

  async query(taskId: string): Promise<EngineTask> {
    const data = await this.fetchTask(taskId);
    return data ? mapHi3DGenerateTask(data, taskId) : { taskId, status: 'failed', progress: 0, failReason: 'timeout' };
  }

  async cancel(): Promise<void> {
    // The public Hi3D API does not currently expose a cancel endpoint.
  }

  async billingIdOf(taskId: string): Promise<string | null> {
    return this.options.taskMap ? this.options.taskMap.get(taskId) : null;
  }

  async resultAsset(taskId: string): Promise<{ url: string } | null> {
    const data = await this.fetchTask(taskId);
    return data?.state === 'success' && data.url ? { url: data.url } : null;
  }

  private async fetchTask(taskId: string): Promise<Hi3DGenerateTaskData | null> {
    const endpoint = `${HI3D_GENERATE_QUERY_ENDPOINT}?task_id=${encodeURIComponent(taskId)}`;
    const response = await this.client.authorizedFetch(endpoint);
    if (response.status >= 500) throw new Error(`hi3d_query_failed http=${response.status}`);
    let body: Hi3DEnvelope<Hi3DGenerateTaskData> | null = null;
    try {
      body = (await response.json()) as Hi3DEnvelope<Hi3DGenerateTaskData>;
    } catch {
      body = null;
    }
    if (!response.ok || !body || !hi3dCodeOk(body.code) || !body.data) return null;
    return body.data;
  }
}
