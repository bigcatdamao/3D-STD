export type CreationProjectType = 'character' | 'mecha' | 'prop' | 'product' | 'scene' | 'other' | 'unknown';
export type CreationPurpose = 'resin_print' | 'fdm_print' | 'display' | 'prototype' | 'unknown';
export type CreationNextAction = 'ask_questions' | 'review_brief' | 'request_reference' | 'ready_for_concept';
export type CreationQuestionTarget = 'subject' | 'project_type' | 'purpose' | 'style' | 'target_height' | 'pose' | 'preferred_part_count' | 'notes';

export interface CreationAgentBrief {
  subject: string | null;
  projectType: CreationProjectType;
  purpose: CreationPurpose;
  style: string | null;
  targetHeightMm: number | null;
  pose: string | null;
  preferredPartCount: {
    minimum: number;
    preferred: number;
    maximum: number;
  } | null;
  notes: string[];
}

export interface CreationAgentQuestionOption {
  value: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface CreationAgentQuestion {
  questionId: string;
  targetField: CreationQuestionTarget;
  question: string;
  options: CreationAgentQuestionOption[];
  allowFreeText: true;
}

export interface CreationAgentHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface CreationAgentApiRequest {
  schemaVersion: 'creation-agent-input.v1';
  requestId: string;
  locale: 'zh-CN';
  message: string;
  brief: CreationAgentBrief;
  history: CreationAgentHistoryItem[];
  referenceImageCount: number;
}

export interface CreationAgentApiOutput {
  schemaVersion: 'creation-agent-output.v1';
  message: string;
  brief: CreationAgentBrief;
  questions: CreationAgentQuestion[];
  nextAction: CreationNextAction;
  readiness: {
    score: number;
    missingFields: string[];
  };
  assumptions: string[];
}

export interface CreationAgentApiSuccess {
  ok: true;
  result: CreationAgentApiOutput;
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
