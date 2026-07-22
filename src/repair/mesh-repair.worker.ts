import { planMeshRepair, type MeshRepairPlan } from './mesh-repair-core';

export interface MeshRepairWorkerRequest {
  t: 'repair';
  requestId: string;
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
}

export type MeshRepairWorkerReply =
  | { t: 'done'; requestId: string; plan: MeshRepairPlan; durationMs: number }
  | { t: 'failed'; requestId: string; message: string };

const post = (message: MeshRepairWorkerReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<MeshRepairWorkerRequest>) => {
  const { requestId, positions, index } = event.data;
  const startedAt = performance.now();
  try {
    const plan = planMeshRepair(
      new Float32Array(positions),
      index ? new Uint32Array(index) : null,
    );
    const transfer: Transferable[] = [];
    if (plan.repairedPositions) transfer.push(plan.repairedPositions.buffer as ArrayBuffer);
    if (plan.addedPositions.byteLength) transfer.push(plan.addedPositions.buffer as ArrayBuffer);
    post({ t: 'done', requestId, plan, durationMs: performance.now() - startedAt }, transfer);
  } catch (error) {
    post({
      t: 'failed',
      requestId,
      message: error instanceof Error ? error.message : '未知网格修复错误',
    });
  }
};
