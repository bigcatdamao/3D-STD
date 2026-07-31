import { describe, expect, it, vi } from 'vitest';
import { FaceSeamRunner, type FaceSeamWorkerLike } from '../src/split/face-seam-runner';
import type { FaceSeamReply, FaceSeamRequest } from '../src/split/face-seam-protocol';
import type { FaceSeamPreviewResult } from '../src/split/face-seam-preview-core';

const result: FaceSeamPreviewResult = {
  status: 'ready',
  loopPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
  issues: [],
  warnings: [],
  metrics: {
    paintedFaces: 10,
    remainingFaces: 90,
    paintedRatio: 0.1,
    boundaryVertices: 3,
    seamLengthMm: 3.4,
    maxPlanarityDeviationMm: 0,
    selectionMinDimensionMm: 2,
    selectionMaxDimensionMm: 10,
    componentCount: 1,
  },
};

class FakeWorker implements FaceSeamWorkerLike {
  onmessage: ((event: { data: FaceSeamReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  received: FaceSeamRequest[] = [];
  terminated = false;
  reply = true;

  postMessage(message: unknown): void {
    const request = message as FaceSeamRequest;
    this.received.push(request);
    if (!this.reply) return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: { t: 'progress', requestId: request.requestId, phase: '扫描关节局部面组' },
      });
      this.onmessage?.({
        data: {
          t: 'result',
          requestId: request.requestId,
          result,
          durationMs: 18,
          completedFaceLabels: new Uint8Array([1, 1, 1, 0]).buffer,
          completion: {
            candidateCount: 2,
            branchPoints: 0,
            roughFaces: 2,
            completedFaces: 3,
            addedFaces: 1,
            removedFaces: 0,
            matchPercent: 90,
            seamEdges: 3,
            seamLengthLocal: 3.4,
            searchMode: 'rough_boundary',
            growthRings: 0,
            splitMode: 'surface',
            sourceShellCount: 1,
            selectedShellCount: 0,
            fullShellFaces: 0,
            bridgeShellFaces: 3,
          },
        },
      });
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const input = () => ({
  positions: new Float32Array(36).buffer,
  index: new Uint32Array(12).buffer,
  faceLabels: new Uint8Array([1, 1, 0, 0]),
  worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  viewPositionLocal: [0, 0, 100],
  seamAnchorLocal: [1, 2, 3],
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('M1.11d 高面数局部接缝 Worker 运行器', () => {
  it('复制面组标签并返回后台进度与闭环结果', async () => {
    const worker = new FakeWorker();
    const runner = new FaceSeamRunner(() => worker, 1000);
    const source = input();
    const phases: string[] = [];
    let received: FaceSeamPreviewResult | null = null;
    let completed: Uint8Array | undefined;
    expect(runner.run(source, {
      onProgress: (phase) => phases.push(phase),
      onResult: (next, _duration, labels) => {
        received = next;
        completed = labels;
      },
      onError: () => {},
      onCancelled: () => {},
    })).toBe(true);
    await flush();
    expect(phases).toContain('扫描关节局部面组');
    expect(received).toEqual(result);
    expect([...completed!]).toEqual([1, 1, 1, 0]);
    expect([...source.faceLabels]).toEqual([1, 1, 0, 0]);
    expect([...new Uint8Array(worker.received[0].faceLabels)]).toEqual([1, 1, 0, 0]);
    expect(worker.received[0].viewPositionLocal).toEqual([0, 0, 100]);
    expect(worker.received[0].seamAnchorLocal).toEqual([1, 2, 3]);
  });

  it('允许取消并在超时时终止 Worker', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    worker.reply = false;
    const runner = new FaceSeamRunner(() => worker, 100);
    let error = '';
    expect(runner.run(input(), {
      onProgress: () => {},
      onResult: () => {},
      onError: (message) => { error = message; },
      onCancelled: () => {},
    })).toBe(true);
    await vi.advanceTimersByTimeAsync(101);
    vi.useRealTimers();
    expect(worker.terminated).toBe(true);
    expect(error).toContain('超过 60 秒');
    expect(runner.running).toBe(false);
  });
});
