// 解析 Worker(IMP-04)—— 主线程零阻塞的执行体。壳保持极薄:全部计算在 parse-core(可测),
// 本文件只做消息编解码与阶段进度上报。几何以 Transferable ArrayBuffer 传回,避免结构化克隆开销。

import {
  FAILURE_COPY,
  Format,
  ParseFailure,
  RETRYABLE,
  bboxOfPositions,
  decode,
  weldAndAnalyze,
} from './parse-core';

export interface WorkerJobMsg {
  jobId: string;
  name: string;
  format: Format;
  file: Blob;
}

export type WorkerReply =
  | { t: 'progress'; jobId: string; pct: number; phase: string }
  | {
      t: 'ok';
      jobId: string;
      positions: ArrayBuffer;
      normals: ArrayBuffer | null;
      meta: {
        faces: number;
        vertices: number; // 焊接后唯一顶点数(IMP-07 网格统计)
        bboxRaw: { min: [number, number, number]; max: [number, number, number] };
        watertight: boolean;
        degenerateCount: number;
        boundaryEdges: number;
        nonManifoldEdges: number;
        materialMissing: boolean;
        gltfBaked: boolean;
      };
    }
  | { t: 'err'; jobId: string; code: string; message: string; retryable: boolean };

const post = (m: WorkerReply, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

self.onmessage = async (ev: MessageEvent<WorkerJobMsg>) => {
  const { jobId, format, file } = ev.data;
  const progress = (pct: number, phase: string) => post({ t: 'progress', jobId, pct, phase });
  try {
    progress(6, '读取文件');
    const buffer = await file.arrayBuffer();
    progress(16, '解析几何');
    const mesh = await decode(format, buffer);
    progress(58, '焊接顶点');
    // 让出一拍事件循环,确保进度消息先行送达(解析与分析间无 await 时消息会攒批)
    await new Promise((r) => setTimeout(r, 0));
    const topo = weldAndAnalyze(mesh.positions, mesh.index);
    progress(90, '生成统计');
    const bboxRaw = bboxOfPositions(mesh.positions);
    const transfer: Transferable[] = [mesh.positions.buffer as ArrayBuffer];
    if (mesh.normals) transfer.push(mesh.normals.buffer as ArrayBuffer);
    post(
      {
        t: 'ok',
        jobId,
        positions: mesh.positions.buffer as ArrayBuffer,
        normals: mesh.normals ? (mesh.normals.buffer as ArrayBuffer) : null,
        meta: {
          faces: topo.faces,
          vertices: topo.weldedVertices,
          bboxRaw,
          watertight: topo.watertight,
          degenerateCount: topo.degenerateCount,
          boundaryEdges: topo.boundaryEdges,
          nonManifoldEdges: topo.nonManifoldEdges,
          materialMissing: mesh.materialMissing,
          gltfBaked: mesh.gltfBaked,
        },
      },
      transfer,
    );
  } catch (e) {
    if (e instanceof ParseFailure) {
      post({ t: 'err', jobId, code: e.code, message: e.message || FAILURE_COPY[e.code], retryable: RETRYABLE[e.code] });
    } else {
      post({
        t: 'err',
        jobId,
        code: 'internal',
        message: `${FAILURE_COPY.internal}:${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      });
    }
  }
};
