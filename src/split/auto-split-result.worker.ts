import { decodeGlbParts } from '../importer/parse-core';
import type { Vec3 } from '../kernel/types';
import { prepareAutoSplitParts } from './auto-split-result-core';

export interface AutoSplitWorkerJob {
  jobId: string;
  file: Blob;
  sourceBounds: { min: Vec3; max: Vec3 };
}

export type AutoSplitWorkerReply =
  | { t: 'progress'; jobId: string; pct: number; phase: string }
  | {
      t: 'ok';
      jobId: string;
      parts: Array<{
        name: string;
        positions: ArrayBuffer;
        normals: ArrayBuffer | null;
        faces: number;
        bbox: { min: Vec3; max: Vec3 };
      }>;
    }
  | { t: 'err'; jobId: string; message: string };

const post = (message: AutoSplitWorkerReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<AutoSplitWorkerJob>) => {
  const { jobId, file, sourceBounds } = event.data;
  try {
    post({ t: 'progress', jobId, pct: 15, phase: '读取拆件结果' });
    const decoded = await decodeGlbParts(await file.arrayBuffer());
    post({ t: 'progress', jobId, pct: 58, phase: `识别到 ${decoded.length} 个候选零件` });
    const parts = prepareAutoSplitParts(decoded, sourceBounds);
    const transfer: Transferable[] = [];
    const payload = parts.map((part) => {
      transfer.push(part.positions.buffer as ArrayBuffer);
      if (part.normals) transfer.push(part.normals.buffer as ArrayBuffer);
      return {
        name: part.name,
        positions: part.positions.buffer as ArrayBuffer,
        normals: part.normals ? part.normals.buffer as ArrayBuffer : null,
        faces: part.faces,
        bbox: part.bbox,
      };
    });
    post({ t: 'ok', jobId, parts: payload }, transfer);
  } catch (error) {
    post({ t: 'err', jobId, message: error instanceof Error ? error.message : '拆件结果解析失败' });
  }
};
