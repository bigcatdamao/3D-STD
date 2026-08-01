import type { CreationAgentBrief } from './creation-agent-api-types';
import type { CreationConceptScheme } from './creation-concept-api-types';

export type CreationImageMode = 'concept' | 'turntable_sheet';

export interface CreationImageApiRequest {
  schemaVersion: 'creation-image-input.v1';
  requestId: string;
  locale: 'zh-CN';
  mode: CreationImageMode;
  brief: CreationAgentBrief;
  scheme: CreationConceptScheme;
  referenceSummary: string | null;
}

export interface CreationImageApiSuccess {
  ok: true;
  result: {
    schemaVersion: 'creation-image-output.v1';
    mode: CreationImageMode;
    mimeType: 'image/png';
    imageBase64: string;
    revisedPrompt: string | null;
    warning: string;
  };
  meta: {
    provider: 'aihubmix';
    model: string;
    requestId: string;
    latencyMs: number;
  };
}
