import type { Transform } from '../kernel/types';
import type { SurfaceCutResult } from './surface-cut-core';

export const SURFACE_CUT_TIMEOUT_MS = 60_000;

export interface SurfaceCutRequest {
  t: 'cut';
  requestId: string;
  assetId: string;
  positions: ArrayBuffer | null;
  index: ArrayBuffer | null;
  transform: Transform;
  axisIndex: 0 | 1 | 2;
  guidePositionMm: number;
  searchHalfWidthMm: number;
}

export type SurfaceCutReply =
  | { t: 'progress'; requestId: string; phase: string }
  | { t: 'result'; requestId: string; result: SurfaceCutResult; durationMs: number }
  | { t: 'failed'; requestId: string; message: string };

