import {
  FACE_SEAM_TIMEOUT_MS,
  type FaceSeamReply,
  type FaceSeamRequest,
} from './face-seam-protocol';
import type { FaceSeamPreviewResult } from './face-seam-preview-core';
import type { FaceSetCompletionSummary } from './face-set-completion-core';

export interface FaceSeamWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: FaceSeamReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface FaceSeamRunInput {
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
  faceLabels: Uint8Array;
  worldMatrix: number[];
  viewPositionLocal: number[] | null;
  seamAnchorLocal: number[] | null;
}

export interface FaceSeamRunAlternative {
  result: FaceSeamPreviewResult;
  completedFaceLabels: Uint8Array;
  completion: FaceSetCompletionSummary;
}

export interface FaceSeamRunEvents {
  onProgress: (phase: string) => void;
  onResult: (
    result: FaceSeamPreviewResult,
    durationMs: number,
    completedFaceLabels?: Uint8Array,
    completion?: FaceSetCompletionSummary,
    alternatives?: FaceSeamRunAlternative[],
  ) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
}

export type SpawnFaceSeamWorker = () => FaceSeamWorkerLike;

let requestSequence = 0;

export class FaceSeamRunner {
  private worker: FaceSeamWorkerLike | null = null;
  private active: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
    events: FaceSeamRunEvents;
  } | null = null;

  constructor(
    private spawn: SpawnFaceSeamWorker,
    private timeoutMs = FACE_SEAM_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  run(input: FaceSeamRunInput, events: FaceSeamRunEvents): boolean {
    if (this.active) return false;
    if (!this.worker) this.createWorker();
    const requestId = `face_seam_${(++requestSequence).toString(36)}`;
    this.active = {
      requestId,
      events,
      timer: setTimeout(() => this.fail('局部接缝分析超过 60 秒，已安全停止'), this.timeoutMs),
    };
    const faceLabels = input.faceLabels.slice().buffer;
    const transfer: Transferable[] = [input.positions, faceLabels];
    if (input.index) transfer.push(input.index);
    this.worker!.postMessage({
      t: 'analyze',
      requestId,
      positions: input.positions,
      index: input.index,
      faceLabels,
      worldMatrix: [...input.worldMatrix],
      viewPositionLocal: input.viewPositionLocal
        ? [...input.viewPositionLocal]
        : null,
      seamAnchorLocal: input.seamAnchorLocal
        ? [...input.seamAnchorLocal]
        : null,
    } satisfies FaceSeamRequest, transfer);
    events.onProgress('准备局部接缝数据');
    return true;
  }

  cancel(): boolean {
    const active = this.active;
    if (!active) return false;
    clearTimeout(active.timer);
    this.active = null;
    this.resetWorker();
    active.events.onCancelled();
    return true;
  }

  private createWorker(): void {
    this.worker = this.spawn();
    this.worker.onmessage = (event) => this.onReply(event.data);
    this.worker.onerror = () => this.fail('局部接缝 Worker 异常，源模型保持不变');
  }

  private onReply(reply: FaceSeamReply): void {
    const active = this.active;
    if (!active || active.requestId !== reply.requestId) return;
    if (reply.t === 'progress') {
      active.events.onProgress(reply.phase);
      return;
    }
    if (reply.t === 'failed') {
      this.fail(reply.message);
      return;
    }
    clearTimeout(active.timer);
    this.active = null;
    active.events.onResult(
      reply.result,
      reply.durationMs,
      reply.completedFaceLabels ? new Uint8Array(reply.completedFaceLabels) : undefined,
      reply.completion,
      reply.alternatives?.map((alternative) => ({
        result: alternative.result,
        completedFaceLabels: new Uint8Array(alternative.completedFaceLabels),
        completion: alternative.completion,
      })),
    );
  }

  private fail(message: string): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer);
    this.active = null;
    this.resetWorker();
    active.events.onError(message);
  }

  private resetWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
