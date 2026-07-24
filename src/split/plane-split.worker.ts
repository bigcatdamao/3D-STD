import { splitMeshByPlane } from './plane-split-core';
import type { PlaneSplitReply, PlaneSplitRequest } from './plane-split-protocol';

const post = (reply: PlaneSplitReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (event: MessageEvent<PlaneSplitRequest>) => {
  const request = event.data;
  if (request.t !== 'split') return;
  const startedAt = performance.now();
  try {
    post({ t: 'progress', requestId: request.requestId, phase: '裁剪两侧网格' });
    const result = splitMeshByPlane({
      positions: new Float32Array(request.positions),
      index: request.index ? new Uint32Array(request.index) : null,
      plane: request.plane,
    });
    const transfer: Transferable[] = [];
    if (result.status === 'ready') {
      transfer.push(
        result.partA.positions.buffer as ArrayBuffer,
        result.partB.positions.buffer as ArrayBuffer,
      );
    }
    post({
      t: 'result',
      requestId: request.requestId,
      result,
      durationMs: performance.now() - startedAt,
    }, transfer);
  } catch (error) {
    post({
      t: 'failed',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : '平面切割 Worker 执行失败',
    });
  }
};
