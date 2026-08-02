import type { EngineFailReason, EngineTask, GenerateRequest, GenerateType, ImageView } from './api-types';
import type { TaskMapStore } from './engine';
import { TencentCloudApiError, TencentCloudClient } from './tencent-cloud-client';

export const HUNYUAN_GENERATE_SUBMIT_ACTION = 'SubmitHunyuanTo3DProJob';
export const HUNYUAN_GENERATE_QUERY_ACTION = 'QueryHunyuanTo3DProJob';
const TASK_PREFIX = 'hy3d_';
const MAX_RAW_IMAGE_BYTES = 6 * 1024 * 1024;

export interface HunyuanFile3D {
  Type?: string;
  Url?: string;
  PreviewImageUrl?: string;
}

export interface HunyuanQueryData {
  Status?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  ResultFile3Ds?: HunyuanFile3D[];
  RequestId?: string;
}

export interface HunyuanEngineOptions {
  secretId?: string;
  secretKey?: string;
  region?: string;
  model?: string;
  timeoutMs?: number;
  taskMap?: TaskMapStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const rawTaskId = (taskId: string): string => taskId.startsWith(TASK_PREFIX) ? taskId.slice(TASK_PREFIX.length) : taskId;
const publicTaskId = (taskId: string): string => taskId.startsWith(TASK_PREFIX) ? taskId : `${TASK_PREFIX}${taskId}`;

function failReason(code?: string): EngineFailReason {
  if (/content|moderation|sensitive|audit/i.test(code ?? '')) return 'moderation';
  return 'service';
}

export function mapHunyuanGenerateTask(data: HunyuanQueryData, taskId: string): EngineTask {
  const requestId = data.RequestId;
  switch (data.Status) {
    case 'WAIT':
      return { taskId, status: 'queued', progress: 5, ...(requestId ? { requestId } : {}) };
    case 'RUN':
      return { taskId, status: 'running', progress: 45, ...(requestId ? { requestId } : {}) };
    case 'DONE':
      return {
        taskId,
        status: 'success',
        progress: 100,
        resultUrl: `/api/task/${encodeURIComponent(taskId)}/result`,
        ...(requestId ? { requestId } : {}),
      };
    case 'FAIL':
      return {
        taskId,
        status: 'failed',
        progress: 0,
        failReason: failReason(data.ErrorCode),
        ...(data.ErrorCode ? { providerCode: data.ErrorCode } : {}),
        ...(requestId ? { requestId } : {}),
      };
    default:
      return { taskId, status: 'failed', progress: 0, failReason: 'timeout', ...(requestId ? { requestId } : {}) };
  }
}

function base64Of(buffer: ArrayBuffer): string {
  const data = new Uint8Array(buffer);
  let binary = '';
  const size = 0x8000;
  for (let offset = 0; offset < data.length; offset += size) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + size, data.length)));
  }
  return btoa(binary);
}

const viewTypeOf = (view: ImageView): string | null => view === 'front' ? null : view;

export class HunyuanEngine {
  readonly name = 'hunyuan';
  readonly supportedTypes: readonly GenerateType[] = ['text', 'image', 'multiview'];
  readonly acceptsOwnKey = false;
  readonly promptMaxLength = 1024;
  private readonly client: TencentCloudClient;

  constructor(private readonly options: HunyuanEngineOptions) {
    this.client = new TencentCloudClient(options);
  }

  creditCost(_type: GenerateType): number {
    // M1.17a uses Geometry (15) + FBX result (5), with no PBR/face-count extras.
    return 20;
  }

  async submit(req: GenerateRequest, serviceTaskId: string): Promise<EngineTask> {
    const body: Record<string, unknown> = {
      Model: this.options.model || '3.1',
      GenerateType: 'Geometry',
      ResultFormat: 'FBX',
    };
    if (req.type === 'text') {
      body.Prompt = req.prompt?.trim();
    } else {
      const images = req.images ?? [];
      const totalBytes = images.reduce((sum, image) => sum + image.file.size, 0);
      if (totalBytes > MAX_RAW_IMAGE_BYTES) throw new Error('hunyuan_images_too_large total_raw_gt_6mb');
      const front = images.find((image) => image.view === 'front');
      if (!front) throw new Error('hunyuan_front_image_missing');
      body.ImageBase64 = base64Of(await front.file.arrayBuffer());
      const extra = [];
      for (const image of images) {
        const viewType = viewTypeOf(image.view);
        if (!viewType) continue;
        extra.push({ ViewType: viewType, ViewImageBase64: base64Of(await image.file.arrayBuffer()) });
      }
      if (extra.length) body.MultiViewImages = extra;
    }
    const result = await this.client.call<{ JobId?: string; RequestId?: string }>(HUNYUAN_GENERATE_SUBMIT_ACTION, body);
    if (!result.JobId) throw new Error('hunyuan_submit_missing_job_id');
    const taskId = publicTaskId(result.JobId);
    if (this.options.taskMap) await this.options.taskMap.put(taskId, serviceTaskId);
    return { taskId, status: 'queued', progress: 0, ...(result.RequestId ? { requestId: result.RequestId } : {}) };
  }

  async query(taskId: string): Promise<EngineTask> {
    const data = await this.queryData(taskId);
    return mapHunyuanGenerateTask(data, taskId);
  }

  async cancel(_taskId: string): Promise<void> {
    // Tencent's current ai3d API exposes no cancellation endpoint.
  }

  async billingIdOf(taskId: string): Promise<string | null> {
    return this.options.taskMap ? this.options.taskMap.get(taskId) : null;
  }

  async resultAsset(taskId: string): Promise<{ url: string } | null> {
    const data = await this.queryData(taskId);
    if (data.Status !== 'DONE') return null;
    const file = this.pickFile(data.ResultFile3Ds, 'GLB');
    return file?.Url ? { url: file.Url } : null;
  }

  async sourceFbx(taskId: string): Promise<{ url: string } | null> {
    const data = await this.queryData(taskId);
    if (data.Status !== 'DONE') return null;
    const file = this.pickFile(data.ResultFile3Ds, 'FBX');
    return file?.Url ? { url: file.Url } : null;
  }

  async queryData(taskId: string): Promise<HunyuanQueryData> {
    try {
      return await this.client.call<HunyuanQueryData>(HUNYUAN_GENERATE_QUERY_ACTION, { JobId: rawTaskId(taskId) });
    } catch (error) {
      if (error instanceof TencentCloudApiError && error.code === 'FailedOperation.JobNotExist') {
        return { Status: 'FAIL', ErrorCode: error.code, RequestId: error.requestId ?? undefined };
      }
      throw error;
    }
  }

  private pickFile(files: HunyuanFile3D[] | undefined, type: string): HunyuanFile3D | null {
    return files?.find((file) => file.Type?.toUpperCase() === type && file.Url) ?? null;
  }
}

