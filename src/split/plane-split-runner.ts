import type { PlaneEquation, PlaneSplitResult } from './plane-split-core';
import type { PlaneSplitReply, PlaneSplitRequest } from './plane-split-protocol';

export const PLANE_SPLIT_TIMEOUT_MS = 60_000;

export interface PlaneSplitWorkerLike {
  onmessage: ((event: MessageEvent<PlaneSplitReply>) => void) | null;
  onerror: ((event: Event) => void) | null;
  postMessage(message: PlaneSplitRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface PlaneSplitGeometrySource {
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
}

export interface PlaneSplitRunEvents {
  onProgress(phase: string): void;
  onResult(result: PlaneSplitResult, durationMs: number): void;
  onError(message: string): void;
  onCancelled(): void;
}

type SpawnPlaneSplitWorker = () => PlaneSplitWorkerLike;

let requestSequence = 0;

export class PlaneSplitRunner {
  private worker: PlaneSplitWorkerLike | null = null;
  private active: {
    requestId: string;
    events: PlaneSplitRunEvents;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private spawn: SpawnPlaneSplitWorker,
    private timeoutMs = PLANE_SPLIT_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  run(plane: PlaneEquation, geometry: PlaneSplitGeometrySource, events: PlaneSplitRunEvents): boolean {
    if (this.active) return false;
    this.worker = this.spawn();
    const requestId = `plane_split_${(++requestSequence).toString(36)}`;
    this.active = {
      requestId,
      events,
      timer: setTimeout(() => this.fail('平面切割超过 60 秒，已安全停止'), this.timeoutMs),
    };
    this.worker.onmessage = (event) => this.onReply(event.data);
    this.worker.onerror = () => this.fail('平面切割 Worker 异常，已安全停止');
    this.worker.postMessage({
      t: 'split',
      requestId,
      positions: geometry.positions,
      index: geometry.index,
      plane: structuredClone(plane),
    }, [
      geometry.positions,
      ...(geometry.index ? [geometry.index] : []),
    ]);
    events.onProgress('准备源网格');
    return true;
  }

  cancel(): boolean {
    const active = this.active;
    if (!active) return false;
    clearTimeout(active.timer);
    this.active = null;
    this.disposeWorker();
    active.events.onCancelled();
    return true;
  }

  private onReply(reply: PlaneSplitReply): void {
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
    this.disposeWorker();
    active.events.onResult(reply.result, reply.durationMs);
  }

  private fail(message: string): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer);
    this.active = null;
    this.disposeWorker();
    active.events.onError(message);
  }

  private disposeWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
