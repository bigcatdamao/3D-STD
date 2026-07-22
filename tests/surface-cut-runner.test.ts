import { describe, expect, it, vi } from 'vitest';
import { SurfaceCutRunner, type SurfaceCutWorkerLike } from '../src/split/surface-cut-runner';
import type { SurfaceCutReply, SurfaceCutRequest } from '../src/split/surface-cut-protocol';
import type { SurfaceCutResult } from '../src/split/surface-cut-core';
import type { Transform } from '../src/kernel/types';

const transform: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const result: SurfaceCutResult = {
  status: 'unsupported',
  code: 'non_manifold_source',
  message: '源模型不是可安全切割的水密流形',
};

class FakeWorker implements SurfaceCutWorkerLike {
  onmessage: ((event: { data: SurfaceCutReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  received: SurfaceCutRequest[] = [];
  terminated = false;
  script: (request: SurfaceCutRequest, reply: (message: SurfaceCutReply) => void) => void = (request, reply) => {
    reply({ t: 'progress', requestId: request.requestId, phase: '构建表面邻接图' });
    reply({ t: 'result', requestId: request.requestId, result, durationMs: 8 });
  };

  postMessage(message: unknown): void {
    const request = message as SurfaceCutRequest;
    this.received.push(request);
    queueMicrotask(() => this.script(request, (reply) => this.onmessage?.({ data: reply })));
  }

  terminate(): void {
    this.terminated = true;
  }
}

const input = {
  assetId: 'asset-1',
  transform,
  axisIndex: 0 as const,
  guidePositionMm: 0,
  searchHalfWidthMm: 40,
};
const geometry = () => ({
  positions: new Float32Array(36).buffer as ArrayBuffer,
  index: new Uint32Array(12).buffer as ArrayBuffer,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function events() {
  const phases: string[] = [];
  let receivedResult: SurfaceCutResult | null = null;
  let error: string | null = null;
  let cancelled = false;
  return {
    phases,
    getResult: () => receivedResult,
    getError: () => error,
    getCancelled: () => cancelled,
    handlers: {
      onProgress: (phase: string) => phases.push(phase),
      onResult: (next: SurfaceCutResult) => { receivedResult = next; },
      onError: (message: string) => { error = message; },
      onCancelled: () => { cancelled = true; },
    },
  };
}

describe('M1.7.8 真实表面切割 Worker 运行器', () => {
  it('首轮发送源网格，同一资产后续复用 Worker 缓存', async () => {
    const worker = new FakeWorker();
    const runner = new SurfaceCutRunner(() => worker, 1000);
    const first = events();
    expect(runner.run(input, geometry, first.handlers)).toBe(true);
    await flush();
    expect(first.getResult()).toEqual(result);
    expect(first.phases).toContain('构建表面邻接图');
    expect(worker.received[0].positions).not.toBeNull();

    const second = events();
    expect(runner.run(input, geometry, second.handlers)).toBe(true);
    await flush();
    expect(worker.received[1].positions).toBeNull();
    expect(worker.received[1].index).toBeNull();
  });

  it('取消会终止 Worker、忽略迟到结果，并允许下一轮重建', () => {
    const workers: FakeWorker[] = [];
    const runner = new SurfaceCutRunner(() => {
      const worker = new FakeWorker();
      worker.script = () => {};
      workers.push(worker);
      return worker;
    }, 1000);
    const first = events();
    expect(runner.run(input, geometry, first.handlers)).toBe(true);
    expect(runner.cancel()).toBe(true);
    expect(first.getCancelled()).toBe(true);
    expect(workers[0].terminated).toBe(true);
    workers[0].onmessage?.({
      data: { t: 'result', requestId: workers[0].received[0].requestId, result, durationMs: 1 },
    });
    expect(first.getResult()).toBeNull();

    const second = events();
    expect(runner.run(input, geometry, second.handlers)).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].received[0].positions).not.toBeNull();
    runner.cancel();
  });

  it('超时会终止 Worker、清除运行态并返回明确错误', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    worker.script = () => {};
    const runner = new SurfaceCutRunner(() => worker, 100);
    const state = events();
    expect(runner.run(input, geometry, state.handlers)).toBe(true);
    await vi.advanceTimersByTimeAsync(101);
    vi.useRealTimers();
    expect(worker.terminated).toBe(true);
    expect(state.getError()).toContain('超过 60 秒');
    expect(runner.running).toBe(false);
  });
});
