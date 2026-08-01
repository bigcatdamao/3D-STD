import type { CreationAgentBrief } from './creation-agent-api-types';

export interface CreationConceptApiRequest {
  schemaVersion: 'creation-concept-input.v1';
  requestId: string;
  locale: 'zh-CN';
  brief: CreationAgentBrief;
  desiredSchemeCount: 2 | 3;
}

export interface CreationConceptScheme {
  schemeId: string;
  title: string;
  tagline: string;
  description: string;
  visualKeywords: string[];
  silhouetteStrategy: string;
  colorMaterialStrategy: string;
  poseComposition: string;
  printableStrategy: string;
  strengths: string[];
  tradeoffs: string[];
  scores: {
    briefFit: number;
    distinctiveness: number;
    printability: number;
  };
  imagePrompt: string;
  negativePrompt: string;
}

export interface CreationConceptApiOutput {
  schemaVersion: 'creation-concept-output.v1';
  summary: string;
  schemes: CreationConceptScheme[];
  recommendedSchemeId: string;
  recommendationReason: string;
  nextAction: 'select_scheme';
}

export interface CreationConceptApiSuccess {
  ok: true;
  result: CreationConceptApiOutput;
  meta: {
    provider: 'openai' | 'aihubmix';
    model: string;
    requestId: string;
    latencyMs: number;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    };
  };
}
