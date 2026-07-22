import type { Transform } from '../kernel/types';
import type { CutAxis } from './plane-cut-core';
import type { PlaneSectionSummary } from './plane-section-core';

export const SEAM_SCAN_TIMEOUT_MS = 45_000;

export interface SeamScanCut {
  id: string;
  axis: CutAxis;
  axisIndex: 0 | 1 | 2;
  normalizedPosition: number;
  positionMm: number;
}

export interface SeamScanResult {
  cut: SeamScanCut;
  section: PlaneSectionSummary;
}

export interface SeamScanRequest {
  t: 'scan';
  requestId: string;
  assetId: string;
  positions: ArrayBuffer | null;
  index: ArrayBuffer | null;
  transform: Transform;
  cuts: SeamScanCut[];
}

export type SeamScanReply =
  | { t: 'progress'; requestId: string; done: number; total: number }
  | { t: 'done'; requestId: string; results: SeamScanResult[]; durationMs: number }
  | { t: 'failed'; requestId: string; message: string };

