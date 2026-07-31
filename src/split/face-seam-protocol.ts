import type { FaceSeamPreviewResult } from './face-seam-preview-core';
import type { FaceSetCompletionSummary } from './face-set-completion-core';

export const FACE_SEAM_TIMEOUT_MS = 60_000;

export interface FaceSeamRequest {
  t: 'analyze';
  requestId: string;
  positions: ArrayBuffer;
  index: ArrayBuffer | null;
  faceLabels: ArrayBuffer;
  worldMatrix: number[];
  viewPositionLocal: number[] | null;
  seamAnchorLocal: number[] | null;
}

export interface FaceSeamAlternativeReply {
  result: FaceSeamPreviewResult;
  completedFaceLabels: ArrayBuffer;
  completion: FaceSetCompletionSummary;
}

export type FaceSeamReply =
  | { t: 'progress'; requestId: string; phase: string }
  | {
    t: 'result';
    requestId: string;
    result: FaceSeamPreviewResult;
    durationMs: number;
    completedFaceLabels?: ArrayBuffer;
    completion?: FaceSetCompletionSummary;
    alternatives?: FaceSeamAlternativeReply[];
  }
  | { t: 'failed'; requestId: string; message: string };
