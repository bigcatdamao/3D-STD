import type { CreationAgentBrief } from './creation-agent-api-types';

export interface CreationReferenceImage {
  imageId: string;
  imageUrl: string;
}

export interface CreationReferenceApiRequest {
  schemaVersion: 'creation-reference-input.v1';
  requestId: string;
  locale: 'zh-CN';
  brief: CreationAgentBrief;
  images: CreationReferenceImage[];
}

export interface CreationReferenceApiOutput {
  schemaVersion: 'creation-reference-output.v1';
  summary: string;
  subject: string;
  style: string;
  silhouette: string;
  colorPalette: string[];
  materials: string[];
  distinctiveFeatures: string[];
  pose: string;
  viewCoverage: 'single_view' | 'partial_multiview' | 'usable_multiview';
  risks: string[];
  briefPatch: {
    subject: string | null;
    projectType: CreationAgentBrief['projectType'];
    style: string | null;
    pose: string | null;
    notes: string[];
  };
  confidence: number;
  nextAction: 'continue_dialogue' | 'review_brief';
}

export interface CreationReferenceApiSuccess {
  ok: true;
  result: CreationReferenceApiOutput;
  meta: {
    provider: 'openai' | 'aihubmix';
    model: string;
    requestId: string;
    evidenceImages: number;
    latencyMs: number;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    };
  };
}
