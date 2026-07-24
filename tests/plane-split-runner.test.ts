import { describe, expect, it, vi } from 'vitest';
import type { PlaneSplitReply, PlaneSplitRequest } from '../src/split/plane-split-protocol';
import { PlaneSplitRunner, type PlaneSplitWorkerLike } from '../src/split/plane-split-runner';

class FakeWorker implements PlaneSplitWorkerLike {
  onmessage: ((event: MessageEvent<PlaneSplitReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  posted: PlaneSplitRequest | null = null;
  terminated = false;

  postMessage(message: PlaneSplitRequest) {
    this.posted = message;
  }

  terminate() {
    this.terminated = true;
  }

  emit(reply: PlaneSplitReply) {
    this.onmessage?.({ data: reply } as MessageEvent<PlaneSplitReply>);
  }
}

describe('PlaneSplitRunner', () => {
  it('transfers geometry, reports progress, and disposes the worker after a result', () => {
    const worker = new FakeWorker();
    const progress = vi.fn();
    const result = vi.fn();
    const runner = new PlaneSplitRunner(() => worker, 1000);
    const positions = new Float32Array(9).buffer;

    expect(runner.run(
      { normal: [0, 0, 1], constant: 0 },
      { positions, index: null },
      {
        onProgress: progress,
        onResult: result,
        onError: vi.fn(),
        onCancelled: vi.fn(),
      },
    )).toBe(true);
    expect(progress).toHaveBeenCalledWith('准备源网格');
    const requestId = worker.posted!.requestId;
    worker.emit({ t: 'progress', requestId, phase: '裁剪两侧网格' });
    expect(progress).toHaveBeenLastCalledWith('裁剪两侧网格');
    worker.emit({
      t: 'result',
      requestId,
      result: { status: 'blocked', code: 'no_intersection', message: '未相交' },
      durationMs: 2,
    });
    expect(result).toHaveBeenCalledWith(
      { status: 'blocked', code: 'no_intersection', message: '未相交' },
      2,
    );
    expect(worker.terminated).toBe(true);
    expect(runner.running).toBe(false);
  });

  it('cancels one active request without producing a result', () => {
    const worker = new FakeWorker();
    const cancelled = vi.fn();
    const runner = new PlaneSplitRunner(() => worker, 1000);
    runner.run(
      { normal: [1, 0, 0], constant: 0 },
      { positions: new Float32Array(9).buffer, index: null },
      {
        onProgress: vi.fn(),
        onResult: vi.fn(),
        onError: vi.fn(),
        onCancelled: cancelled,
      },
    );
    expect(runner.cancel()).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);
  });
});
