import type { PlaneEquation, PlaneSplitResult } from './plane-split-core';

export interface PlaneSplitRequest {
  t: 'split';
  requestId: string;
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
  plane: PlaneEquation;
}

export type PlaneSplitReply =
  | {
      t: 'progress';
      requestId: string;
      phase: string;
    }
  | {
      t: 'result';
      requestId: string;
      result: PlaneSplitResult;
      durationMs: number;
    }
  | {
      t: 'failed';
      requestId: string;
      message: string;
    };
