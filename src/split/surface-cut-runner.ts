import type { Transform } from '../kernel/types';
import {
  SURFACE_CUT_TIMEOUT_MS,
  type SurfaceCutReply,
  type SurfaceCutRequest,
} from './surface-cut-protocol';
import type { SurfaceCutResult } from './surface-cut-core';

export interface SurfaceCutWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: SurfaceCutReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SurfaceCutRunInput {
  assetId: string;
  transform: Transform;
  axisIndex: 0 | 1 | 2;
  guidePositionMm: number;
  searchHalfWidthMm: number;
}

export interface SurfaceCutRunEvents {
  onProgress: (phase: string) => void;
  onResult: (result: SurfaceCutResult, durationMs: number) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
}

export type SurfaceCutGeometrySource = () => { positions: ArrayBuffer; index: ArrayBuffer | null } | null;
export type SpawnSurfaceCutWorker = () => SurfaceCutWorkerLike;

let requestSequence = 0;

export class SurfaceCutRunner {
  private worker: SurfaceCutWorkerLike | null = null;
  private sentAssets = new Set<string>();
  private active: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
    events: SurfaceCutRunEvents;
  } | null = null;

  constructor(
    private spawn: SpawnSurfaceCutWorker,
    private timeoutMs = SURFACE_CUT_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  run(input: SurfaceCutRunInput, geometryOf: SurfaceCutGeometrySource, events: SurfaceCutRunEvents): boolean {
    if (this.active) return false;
    if (!this.worker) this.createWorker();
    let positions: ArrayBuffer | null = null;
    let index: ArrayBuffer | null = null;
    const transfer: Transferable[] = [];
    if (!this.sentAssets.has(input.assetId)) {
      const geometry = geometryOf();
      if (!geometry) return false;
      positions = geometry.positions;
      index = geometry.index;
      transfer.push(positions);
      if (index) transfer.push(index);
    }
    const requestId = `surface_cut_${(++requestSequence).toString(36)}`;
    this.active = {
      requestId,
      events,
      timer: setTimeout(() => this.fail('真实切割预览超过 60 秒，已停止 Worker'), this.timeoutMs),
    };
    this.sentAssets.add(input.assetId);
    this.worker!.postMessage({
      t: 'cut',
      requestId,
      assetId: input.assetId,
      positions,
      index,
      transform: structuredClone(input.transform),
      axisIndex: input.axisIndex,
      guidePositionMm: input.guidePositionMm,
      searchHalfWidthMm: input.searchHalfWidthMm,
    } satisfies SurfaceCutRequest, transfer);
    events.onProgress('准备源网格');
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
    this.sentAssets.clear();
    this.worker.onmessage = (event) => this.onReply(event.data);
    this.worker.onerror = () => this.fail('真实切割 Worker 异常，已安全停止');
  }

  private onReply(reply: SurfaceCutReply): void {
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
    active.events.onResult(reply.result, reply.durationMs);
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
    this.sentAssets.clear();
  }
}

