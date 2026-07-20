import type { BedConfig } from '../state/store';

export type PrintProcess = 'fdm' | 'sla' | 'sls';
export type SplitPriority =
  | 'fit_build_volume'
  | 'reduce_support'
  | 'preserve_strength'
  | 'easy_assembly';

export type AnalysisCheckStatus = 'not_run' | 'running' | 'fresh' | 'stale' | 'partial' | 'timeout';

export interface AnalysisObjectSummary {
  id: string;
  name: string;
  dimensionsMm: [number, number, number];
  faces: number;
  locked: boolean;
}

export interface SplitAnalysisContext {
  sceneEditVersion: number;
  goal: string;
  priorities: SplitPriority[];
  process: PrintProcess;
  bed: BedConfig;
  objectCount: number;
  selectedObjectCount: number;
  currentPartCount: number;
  combinedDimensionsMm: [number, number, number] | null;
  totalFaces: number;
  checkStatus: AnalysisCheckStatus;
  checkErrors: number;
  checkWarnings: number;
  issueCodes: string[];
  issueMessages: string[];
  objects: AnalysisObjectSummary[];
  exceedsBuildVolume: boolean;
  overflowAxes: Array<'X' | 'Y' | 'Z'>;
  capabilities: {
    topology: 'available' | 'not_run' | 'stale' | 'partial';
    thinWall: 'unavailable';
    surfaceOverhang: 'unavailable';
    cutCandidates: 'unavailable';
    multiviewCapture: 'available' | 'not_run';
  };
}

export type NeedsSplit = 'yes' | 'no' | 'uncertain';
export type ResultSeverity = 'info' | 'warning' | 'blocking';

export interface SplitReason {
  code: string;
  severity: ResultSeverity;
  description: string;
  evidence: string;
}

export interface RecommendedRegion {
  id: string;
  label: string;
  description: string;
  candidateType: 'plane' | 'multi_plane' | 'natural_seam' | 'unknown';
  confidence: number;
}

export interface SplitScheme {
  id: string;
  title: string;
  summary: string;
  partCount: number;
  recommended: boolean;
  pros: string[];
  cons: string[];
  assembly: '无需装配' | '平面对接' | '定位销（阶段三）' | '粘接';
  risk: '低' | '中' | '高';
  confidence: number;
}

export interface SplitRisk {
  severity: ResultSeverity;
  title: string;
  description: string;
  mitigation: string;
}

export interface SplitAnalysisResult {
  schemaVersion: 'split-analysis-output.v1';
  needsSplit: NeedsSplit;
  confidence: number;
  summary: string;
  reasons: SplitReason[];
  recommendedPartCount: {
    minimum: number;
    preferred: number;
    maximum: number;
    rationale: string;
  };
  recommendedRegions: RecommendedRegion[];
  schemes: SplitScheme[];
  risks: SplitRisk[];
  nextSteps: string[];
  limitations: {
    missingInputs: string[];
    unavailableCapabilities: string[];
    assumptions: string[];
    visualUncertainty: 'low' | 'medium' | 'high';
  };
}
