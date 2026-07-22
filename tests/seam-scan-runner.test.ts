import { describe, expect, it, vi } from 'vitest';
import { SeamScanRunner, type SeamScanWorkerLike } from '../src/split/seam-scan-runner';
import type { SeamScanCut, SeamScanReply, SeamScanRequest, SeamScanResult } from '../src/split/seam-scan-protocol';
import type { Transform } from '../src/kernel/types';

const transform: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const cuts: SeamScanCut[] = [{
  id: 'x-50', axis: 'x', axisIndex: 0, normalizedPosition: 0.5, positionMm: 0,
}];
const result: SeamScanResult = {
  cut: cuts[0],
  section: {
    status: 'closed', complete: true, facesTotal: 12, facesTested: 12, segmentCount: 8,
    loopCount: 1, openChainCount: 0, branchPointCount: 0, coplanarFaceCount: 0,
    perimeterMm: 40, areaMm2: 100, warnings: [],
  },
};

class FakeWorker implements SeamScanWorkerLike {
  onmessage: ((event: { data: SeamScanReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  received: SeamScanRequest[] = [];
  terminated = false;
  script: (request: SeamScanRequest, reply: (message: SeamScanReply) => void) => void = (request, reply) => {
    reply({ t: 'progress', requestId: request.requestId, done: 1, total: 1 });
    reply({ t: 'done', requestId: request.requestId, results: [result], durationMs: 5 });
  };

  postMessage(message: unknown): void {
    const request = message as SeamScanRequest;
    this.received.push(request);
    queueMicrotask(() => this.script(request, (reply) => this.onmessage?.({ data: reply })));
  }

  terminate(): void {
    this.terminated = true;
  }
}

const geometry = () => ({
  positions: new Float32Array(36).buffer as ArrayBuffer,
  index: new Uint32Array(12).buffer as ArrayBuffer,
});

function events() {
  const progress: [number, number][] = [];
  let done: SeamScanResult[] | null = null;
  let error: string | null = null;
  let cancelled = false;
  return {
    progress,
    getDone: () => done,
    getError: () => error,
    getCancelled: () => cancelled,
    handlers: {
      onProgress: (current: number, total: number) => progress.push([current, total]),
      onDone: (results: SeamScanResult[]) => { done = results; },
      onError: (message: string) => { error = message; },
      onCancelled: () => { cancelled = true; },
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('M1.7.7 接缝扫描 Worker 运行器', () => {
  it('首轮传几何，成功后同资产复用 Worker 缓存且流回进度', async () => {
    const worker = new FakeWorker();
    const runner = new SeamScanRunner(() => worker, 1000);
    const first = events();
    expect(runner.run('asset-1', transform, cuts, geometry, first.handlers)).toBe(true);
    await flush();
    expect(first.getDone()).toEqual([result]);
    expect(first.progress).toContainEqual([1, 1]);
    expect(worker.received[0].positions).not.toBeNull();

    const second = events();
    expect(runner.run('asset-1', transform, cuts, geometry, second.handlers)).toBe(true);
    await flush();
    expect(worker.received[1].positions).toBeNull();
    expect(worker.received[1].index).toBeNull();
  });

  it('取消立即终止 Worker、忽略迟到结果，并允许下一轮重建', async () => {
    const workers: FakeWorker[] = [];
    const runner = new SeamScanRunner(() => {
      const worker = new FakeWorker();
      worker.script = () => {};
      workers.push(worker);
      return worker;
    }, 1000);
    const first = events();
    runner.run('asset-1', transform, cuts, geometry, first.handlers);
    expect(runner.cancel()).toBe(true);
    expect(first.getCancelled()).toBe(true);
    expect(workers[0].terminated).toBe(true);
    workers[0].onmessage?.({ data: { t: 'done', requestId: workers[0].received[0].requestId, results: [result], durationMs: 1 } });
    expect(first.getDone()).toBeNull();

    const second = events();
    expect(runner.run('asset-1', transform, cuts, geometry, second.handlers)).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].received[0].positions).not.toBeNull();
    runner.cancel();
  });

  it('超时会终止 Worker、清除缓存并以失败状态收口', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    worker.script = () => {};
    const runner = new SeamScanRunner(() => worker, 100);
    const state = events();
    runner.run('asset-1', transform, cuts, geometry, state.handlers);
    await vi.advanceTimersByTimeAsync(101);
    vi.useRealTimers();
    expect(worker.terminated).toBe(true);
    expect(state.getError()).toContain('扫描超时');
    expect(runner.running).toBe(false);
  });
});
