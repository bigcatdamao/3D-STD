import type { ResultSeverity, SplitPriority } from './split-analysis-types';

export type CapabilityState = 'available' | 'unavailable' | 'not_run' | 'stale' | 'partial';
export type ViewLabel = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

export interface SplitAnalysisViewDescriptor {
  viewId: string;
  fieldName: string;
  label: ViewLabel;
  scope: 'selected' | 'visible' | 'all';
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  detailHint: 'low' | 'high';
}

export interface SplitAnalysisApiInput {
  schemaVersion: 'split-analysis-input.v1';
  requestId: string;
  locale: 'zh-CN' | 'en-US';
  goal: {
    description: string;
    priorities: Array<SplitPriority | 'preserve_surface' | 'easy_printing'>;
  };
  printing: {
    process: 'fdm' | 'sla' | 'sls' | 'other' | 'unknown';
    bedMm: { x: number; y: number; z: number };
    material: string | null;
    nozzleMm: number | null;
    layerHeightMm: number | null;
    assemblyClearanceMm: number | null;
  };
  scene: {
    editVersion: number;
    selectionScope: 'selected' | 'visible' | 'all';
    objectCount: number;
    selectedObjectIds: string[];
    currentPartCount: number;
    splitState: 'untouched' | 'grouped_only' | 'preview_exists' | 'derived_parts_exist';
  };
  objects: Array<{
    objectId: string;
    assetId: string;
    name: string;
    source: 'import' | 'ai';
    visible: boolean;
    locked: boolean;
    transform: {
      positionMm: [number, number, number];
      rotationDeg: [number, number, number];
      scale: [number, number, number];
    };
    localBoundsMm: { min: [number, number, number]; max: [number, number, number] };
    worldBoundsMm: { min: [number, number, number]; max: [number, number, number] };
    dimensionsMm: [number, number, number];
    faces: number;
    vertices: number | null;
  }>;
  diagnostics: {
    status: 'unavailable' | 'not_run' | 'running' | 'fresh' | 'stale' | 'partial' | 'timeout';
    reportEditVersion: number | null;
    summary: {
      instances: number;
      errors: number;
      warnings: number;
      totalFaces: number;
      timedOut: boolean;
    } | null;
    topology: Array<{
      assetId: string;
      watertight: boolean;
      degenerateFaces: number;
      boundaryEdges: number;
      nonManifoldEdges: number;
      connectedComponents: number;
      isolatedFragments: number;
      internalShells: number;
      selfIntersectionPairs: number;
      selfIntersectionComplete: boolean;
    }>;
    issues: Array<{
      issueId: string;
      objectId: string;
      code: 'non_watertight' | 'degenerate' | 'self_intersection' | 'internal_shell'
        | 'isolated_fragment' | 'deep_check_partial' | 'out_of_bed' | 'floating' | 'tiny' | 'dims';
      level: 'error' | 'warning' | 'info';
      message: string;
      worldBoundsMm: { min: [number, number, number]; max: [number, number, number] } | null;
    }>;
    thinWall: { status: CapabilityState; threshold: number | null; regions: [] };
    surfaceOverhang: { status: CapabilityState; threshold: number | null; regions: [] };
  };
  currentParts: Array<{
    partId: string;
    name: string;
    kind: 'original' | 'group' | 'split_preview' | 'derived';
    sourceObjectIds: string[];
    parentPartId: string | null;
    operationId: string | null;
    state: 'current' | 'preview' | 'archived';
  }>;
  views: SplitAnalysisViewDescriptor[];
  capabilities: {
    topology: CapabilityState;
    thinWall: CapabilityState;
    surfaceOverhang: CapabilityState;
    cutCandidates: CapabilityState;
    multiviewCapture: CapabilityState;
    assemblyValidation: CapabilityState;
  };
}

export interface SplitAnalysisImageEvidence {
  viewId: string;
  imageUrl: string;
}

export interface SplitAnalysisApiRequest {
  input: SplitAnalysisApiInput;
  images: SplitAnalysisImageEvidence[];
}

export interface SplitAnalysisApiOutput {
  schemaVersion: 'split-analysis-output.v1';
  needsSplit: 'yes' | 'no' | 'uncertain';
  confidence: number;
  summary: string;
  reasons: Array<{
    reasonId: string;
    code: string;
    severity: ResultSeverity;
    description: string;
    evidenceRefs: string[];
  }>;
  recommendedPartCount: {
    minimum: number;
    preferred: number;
    maximum: number;
    rationale: string;
  };
  recommendedRegions: Array<{
    regionId: string;
    objectIds: string[];
    label: string;
    description: string;
    candidateType: 'plane' | 'multi_plane' | 'component_separation' | 'natural_seam' | 'unknown';
    location: {
      kind: 'natural_seam' | 'axis_band' | 'between_components' | 'flat_zone' | 'visual_only';
      axis: 'x' | 'y' | 'z' | 'unknown';
      normalizedPosition: number | null;
      landmarks: string[];
    };
    rationale: string;
    confidence: number;
    evidenceRefs: string[];
  }>;
  schemes: Array<{
    schemeId: string;
    title: string;
    summary: string;
    partCount: number;
    regionIds: string[];
    cutSequence: Array<{
      order: number;
      regionId: string | null;
      instruction: string;
      previewRequired: true;
    }>;
    pros: string[];
    cons: string[];
    impact: Record<'bedFit' | 'support' | 'strength' | 'surface' | 'assembly', 'improved' | 'neutral' | 'worse' | 'unknown'>;
    assemblyApproach: 'none' | 'flat_joint' | 'alignment_pin' | 'socket' | 'adhesive' | 'screw' | 'unknown';
    riskIds: string[];
    confidence: number;
  }>;
  risks: Array<{
    riskId: string;
    severity: ResultSeverity;
    title: string;
    description: string;
    mitigation: string;
    evidenceRefs: string[];
  }>;
  nextSteps: Array<{
    order: number;
    action: string;
    description: string;
    requiresUserConfirmation: boolean;
    suggestedTool: string | null;
  }>;
  limitations: {
    missingInputs: string[];
    unavailableCapabilities: string[];
    assumptions: string[];
    visualUncertainty: 'low' | 'medium' | 'high';
  };
}

export interface SplitAnalysisApiSuccess {
  ok: true;
  result: SplitAnalysisApiOutput;
  meta: {
    provider: 'openai' | 'aihubmix';
    model: string;
    requestId: string;
    evidenceViews: number;
    latencyMs: number;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    };
  };
}
