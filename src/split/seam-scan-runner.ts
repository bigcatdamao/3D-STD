import {
  SEAM_SCAN_TIMEOUT_MS,
  type SeamScanCut,
  type SeamScanReply,
  type SeamScanRequest,
  type SeamScanResult,
} from './seam-scan-protocol';
import type { Transform } from '../kernel/types';

export interface SeamScanWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: SeamScanReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SpawnSeamScanWorker = () => SeamScanWorkerLike;
export type SeamGeometrySource = () => { positions: ArrayBuffer; index: ArrayBuffer | null } | null;

export interface SeamScanEvents {
  onProgress: (done: number, total: number) => void;
  onDone: (results: SeamScanResult[], durationMs: number) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
}

let scanSequence = 0;

export class SeamScanRunner {
  private worker: SeamScanWorkerLike | null = null;
  private sentAssets = new Set<string>();
  private active: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
    events: SeamScanEvents;
  } | null = null;

  constructor(
    private spawn: SpawnSeamScanWorker,
    private timeoutMs = SEAM_SCAN_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  run(
    assetId: string,
    transform: Transform,
    cuts: SeamScanCut[],
    geometryOf: SeamGeometrySource,
    events: SeamScanEvents,
  ): boolean {
    if (this.active || !cuts.length) return false;
    if (!this.worker) this.createWorker();
    let positions: ArrayBuffer | null = null;
    let index: ArrayBuffer | null = null;
    const transfer: Transferable[] = [];
    if (!this.sentAssets.has(assetId)) {
      const geometry = geometryOf();
      if (!geometry) return false;
      positions = geometry.positions;
      index = geometry.index;
      transfer.push(positions);
      if (index) transfer.push(index);
    }
    const requestId = `seam_${(++scanSequence).toString(36)}`;
    this.active = {
      requestId,
      events,
      timer: setTimeout(() => this.fail('扫描超时，已停止 Worker；可稍后重试'), this.timeoutMs),
    };
    this.sentAssets.add(assetId);
    this.worker!.postMessage({
      t: 'scan',
      requestId,
      assetId,
      positions,
      index,
      transform: structuredClone(transform),
      cuts,
    } satisfies SeamScanRequest, transfer);
    events.onProgress(0, cuts.length);
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
    this.worker.onerror = () => this.fail('截面扫描 Worker 异常，已安全停止');
  }

  private onReply(reply: SeamScanReply): void {
    const active = this.active;
    if (!active || reply.requestId !== active.requestId) return;
    if (reply.t === 'progress') {
      active.events.onProgress(reply.done, reply.total);
      return;
    }
    if (reply.t === 'failed') {
      this.fail(reply.message);
      return;
    }
    clearTimeout(active.timer);
    this.active = null;
    active.events.onDone(reply.results, reply.durationMs);
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

