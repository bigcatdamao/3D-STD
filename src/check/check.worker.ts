// 检查 Worker(CHK-02)—— 主线程零阻塞的执行体。壳保持极薄:计算全在 check-core(可测),
// 本文件只做消息编解码、资产级缓存(CHK-04)与逐实例流式上报(超时保留部分结果)。
// 缓存生命周期 = Worker 实例生命周期:超时被 terminate 后缓存随之丢失,重试轮会重传所需资产。

import {
  analyzeAssetGeometry,
  checkInstance,
  worldStats,
  type CheckReply,
  type CheckRunMsg,
} from './check-core';

interface CachedAsset {
  positions: Float32Array;
  topo: ReturnType<typeof analyzeAssetGeometry>;
  analysisMs: number;
}

const cache = new Map<string, CachedAsset>();

const post = (m: CheckReply, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

self.onmessage = async (ev: MessageEvent<CheckRunMsg>) => {
  const { runId, bed, assets, instances } = ev.data;
  const t0 = performance.now();
  const toAnalyze = assets.filter((a) => a.positions !== null);
  const total = toAnalyze.length + instances.length;
  let done = 0;
  let analyzed = 0;
  let cachedHits = 0;

  // —— 资产级(CHK-04:一次分析,缓存复用)——
  for (const a of assets) {
    if (a.positions !== null) {
      post({ t: 'progress', runId, done, total, phase: '几何分析' });
      const positions = new Float32Array(a.positions);
      const index = a.index ? new Uint32Array(a.index) : null;
      const ta = performance.now();
      const topo = analyzeAssetGeometry(positions, index);
      const analysisMs = performance.now() - ta;
      cache.set(a.assetId, { positions, topo, analysisMs });
      analyzed++;
      done++;
      const segs = topo.boundarySegments;
      post(
        {
          t: 'asset',
          runId,
          meta: {
            assetId: a.assetId,
            faces: topo.faces,
            weldedVertices: topo.weldedVertices,
            degenerateCount: topo.degenerateCount,
            boundaryEdges: topo.boundaryEdges,
            nonManifoldEdges: topo.nonManifoldEdges,
            watertight: topo.watertight,
            analysisMs,
            cached: false,
          },
          boundarySegments: segs.length ? (segs.buffer.slice(0) as ArrayBuffer) : null,
        },
      );
      await breathe(); // 让出一拍:进度消息先行送达,terminate 落点干净
    } else {
      const c = cache.get(a.assetId);
      if (c) {
        cachedHits++;
        post({
          t: 'asset',
          runId,
          meta: {
            assetId: a.assetId,
            faces: c.topo.faces,
            weldedVertices: c.topo.weldedVertices,
            degenerateCount: c.topo.degenerateCount,
            boundaryEdges: c.topo.boundaryEdges,
            nonManifoldEdges: c.topo.nonManifoldEdges,
            watertight: c.topo.watertight,
            analysisMs: c.analysisMs,
            cached: true,
          },
          boundarySegments: null,
        });
      }
    }
  }

  // —— 实例级(逐顶点精确世界包围盒,随变换重算)——
  let totalFaces = 0;
  let errors = 0;
  let warnings = 0;
  let checked = 0;
  for (const inst of instances) {
    const c = cache.get(inst.assetId);
    if (!c) {
      done++; // 资产缺失(理论不可达:主线程只对 ready 资产发起检查);跳过不假装成功
      continue;
    }
    post({ t: 'progress', runId, done, total, phase: `检查 ${inst.name}` });
    const world = worldStats(c.positions, inst.transform);
    const issues = checkInstance(inst, c.topo, world, bed);
    totalFaces += c.topo.faces;
    for (const i of issues) {
      if (i.level === 'error') errors++;
      else if (i.level === 'warning') warnings++;
    }
    checked++;
    done++;
    post({ t: 'instance', runId, issues });
    if (checked % 4 === 0) await breathe();
  }

  post({
    t: 'done',
    runId,
    summary: {
      instances: checked,
      errors,
      warnings,
      totalFaces,
      assetsAnalyzed: analyzed,
      assetsCached: cachedHits,
      durationMs: performance.now() - t0,
    },
  });
};

function breathe() {
  return new Promise((r) => setTimeout(r, 0));
}
