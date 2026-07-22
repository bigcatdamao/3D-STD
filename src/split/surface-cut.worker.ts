import { createSurfaceAdaptiveCut } from './surface-cut-core';
import type { SurfaceCutReply, SurfaceCutRequest } from './surface-cut-protocol';

interface CachedGeometry {
  positions: Float32Array;
  index: Uint32Array | null;
}

const cache = new Map<string, CachedGeometry>();
const post = (reply: SurfaceCutReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (event: MessageEvent<SurfaceCutRequest>) => {
  const request = event.data;
  if (request.t !== 'cut') return;
  const startedAt = performance.now();
  if (request.positions) {
    cache.set(request.assetId, {
      positions: new Float32Array(request.positions),
      index: request.index ? new Uint32Array(request.index) : null,
    });
  }
  const geometry = cache.get(request.assetId);
  if (!geometry) {
    post({ t: 'failed', requestId: request.requestId, message: 'Worker 中没有可用的源网格，请重新生成预览' });
    return;
  }
  try {
    post({ t: 'progress', requestId: request.requestId, phase: '构建表面邻接图' });
    const result = createSurfaceAdaptiveCut({
      positions: geometry.positions,
      index: geometry.index,
      transform: request.transform,
      axisIndex: request.axisIndex,
      guidePositionMm: request.guidePositionMm,
      searchHalfWidthMm: request.searchHalfWidthMm,
    });
    const transfer: Transferable[] = [];
    if (result.status === 'ready') {
      transfer.push(result.partA.positions.buffer, result.partB.positions.buffer, result.seamPositions.buffer);
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
      message: error instanceof Error ? error.message : '表面自适应切割失败',
    });
  }
};

