import type { Transform, Vec3 } from '../kernel/types';
import type { SurfaceCutPreference, SurfaceCutResult } from './surface-cut-core';

export const SURFACE_CUT_TIMEOUT_MS = 60_000;

export interface SurfaceCutRequest {
  t: 'cut';
  requestId: string;
  assetId: string;
  positions: ArrayBuffer | null;
  index: ArrayBuffer | null;
  transform: Transform;
  axisIndex?: 0 | 1 | 2;
  guidePositionMm?: number;
  guideOriginWorld?: Vec3;
  guideNormalWorld?: Vec3;
  searchHalfWidthMm: number;
  preference?: SurfaceCutPreference;
}

export type SurfaceCutReply =
  | { t: 'progress'; requestId: string; phase: string }
  | { t: 'result'; requestId: string; result: SurfaceCutResult; durationMs: number }
  | { t: 'failed'; requestId: string; message: string };
