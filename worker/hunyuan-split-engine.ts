import type { EngineTask } from './api-types';
import type { TaskMapStore } from './engine';
import { HunyuanEngine, type HunyuanFile3D, type HunyuanQueryData } from './hunyuan-engine';
import { TencentCloudApiError, TencentCloudClient } from './tencent-cloud-client';

export const HUNYUAN_SPLIT_SUBMIT_ACTION = 'SubmitHunyuan3DPartJob';
export const HUNYUAN_SPLIT_QUERY_ACTION = 'QueryHunyuan3DPartJob';
const TASK_PREFIX = 'hypart_';

export interface HunyuanSplitEngineOptions {
  secretId?: string;
  secretKey?: string;
  region?: string;
  model?: string;
  taskMap?: TaskMapStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface HunyuanSplitQueryData extends HunyuanQueryData {
  PartSegmentationInfo?: string;
}

const rawTaskId = (taskId: string): string => taskId.startsWith(TASK_PREFIX) ? taskId.slice(TASK_PREFIX.length) : taskId;
const publicTaskId = (taskId: string): string => taskId.startsWith(TASK_PREFIX) ? taskId : `${TASK_PREFIX}${taskId}`;
export const isHunyuanSplitTask = (taskId: string): boolean => taskId.startsWith(TASK_PREFIX);

export function mapHunyuanSplitTask(data: HunyuanSplitQueryData, taskId: string): EngineTask {
  const requestId = data.RequestId;
  if (data.Status === 'WAIT') return { taskId, status: 'queued', progress: 5, ...(requestId ? { requestId } : {}) };
  if (data.Status === 'RUN') return { taskId, status: 'running', progress: 50, ...(requestId ? { requestId } : {}) };
  if (data.Status === 'DONE') {
    return {
      taskId,
      status: 'success',
      progress: 100,
      resultUrl: `/api/split/${encodeURIComponent(taskId)}/result`,
      ...(requestId ? { requestId } : {}),
    };
  }
  if (data.Status === 'FAIL') {
    return {
      taskId,
      status: 'failed',
      progress: 0,
      failReason: 'service',
      ...(data.ErrorCode ? { providerCode: data.ErrorCode } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
  return { taskId, status: 'failed', progress: 0, failReason: 'timeout', ...(requestId ? { requestId } : {}) };
}

export class HunyuanSplitEngine {
  readonly name = 'hunyuan';
  private readonly client: TencentCloudClient;
  private readonly generation: HunyuanEngine;

  constructor(private readonly options: HunyuanSplitEngineOptions) {
    this.client = new TencentCloudClient(options);
    this.generation = new HunyuanEngine(options);
  }

  async submitFromGeneration(sourceTaskId: string, serviceTaskId: string): Promise<EngineTask> {
    if (!sourceTaskId.startsWith('hy3d_')) throw new Error('hunyuan_source_task_invalid');
    const fbx = await this.generation.sourceFbx(sourceTaskId);
    if (!fbx?.url) throw new Error('hunyuan_source_fbx_unavailable');
    const result = await this.client.call<{ JobId?: string; RequestId?: string }>(HUNYUAN_SPLIT_SUBMIT_ACTION, {
      File: { Type: 'FBX', Url: fbx.url },
      Model: this.options.model || '1.5',
    });
    if (!result.JobId) throw new Error('hunyuan_split_missing_job_id');
    const taskId = publicTaskId(result.JobId);
    if (this.options.taskMap) await this.options.taskMap.put(taskId, serviceTaskId);
    return { taskId, status: 'queued', progress: 0, ...(result.RequestId ? { requestId: result.RequestId } : {}) };
  }

  async query(taskId: string): Promise<EngineTask> {
    return mapHunyuanSplitTask(await this.queryData(taskId), taskId);
  }

  async billingIdOf(taskId: string): Promise<string | null> {
    return this.options.taskMap ? this.options.taskMap.get(taskId) : null;
  }

  async resultAssets(taskId: string): Promise<Array<{ name: string; url: string }>> {
    const data = await this.queryData(taskId);
    if (data.Status !== 'DONE') return [];
    return (data.ResultFile3Ds ?? [])
      .filter((file: HunyuanFile3D) => file.Type?.toUpperCase() === 'GLB' && file.Url)
      .map((file, index) => ({ name: `part_${index + 1}.glb`, url: file.Url! }));
  }

  private async queryData(taskId: string): Promise<HunyuanSplitQueryData> {
    try {
      return await this.client.call<HunyuanSplitQueryData>(HUNYUAN_SPLIT_QUERY_ACTION, { JobId: rawTaskId(taskId) });
    } catch (error) {
      if (error instanceof TencentCloudApiError && error.code === 'FailedOperation.JobNotExist') {
        return { Status: 'FAIL', ErrorCode: error.code, RequestId: error.requestId ?? undefined };
      }
      throw error;
    }
  }
}
