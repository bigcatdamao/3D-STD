import { analyzePlaneSection, summarizePlaneSection } from './plane-section-core';
import type { SeamScanReply, SeamScanRequest, SeamScanResult } from './seam-scan-protocol';

interface CachedGeometry {
  positions: Float32Array;
  index: Uint32Array | null;
}

const cache = new Map<string, CachedGeometry>();
const post = (reply: SeamScanReply) => (self as unknown as Worker).postMessage(reply);

self.onmessage = async (event: MessageEvent<SeamScanRequest>) => {
  const request = event.data;
  if (request.t !== 'scan') return;
  const startedAt = performance.now();
  if (request.positions) {
    cache.set(request.assetId, {
      positions: new Float32Array(request.positions),
      index: request.index ? new Uint32Array(request.index) : null,
    });
  }
  const geometry = cache.get(request.assetId);
  if (!geometry) {
    post({
      t: 'failed',
      requestId: request.requestId,
      message: 'Worker 中没有可用的资产几何，请重新扫描',
    });
    return;
  }

  try {
    const results: SeamScanResult[] = [];
    post({ t: 'progress', requestId: request.requestId, done: 0, total: request.cuts.length });
    for (let index = 0; index < request.cuts.length; index += 1) {
      const cut = request.cuts[index];
      const analysis = analyzePlaneSection({
        positions: geometry.positions,
        index: geometry.index,
        transform: request.transform,
        axisIndex: cut.axisIndex,
        positionMm: cut.positionMm,
      });
      results.push({ cut, section: summarizePlaneSection(analysis) });
      post({ t: 'progress', requestId: request.requestId, done: index + 1, total: request.cuts.length });
      // 每个截面后让出一次事件循环，保证进度可见；取消由主线程 terminate 立即收口。
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    post({
      t: 'done',
      requestId: request.requestId,
      results,
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    post({
      t: 'failed',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : '几何截面扫描失败',
    });
  }
};

