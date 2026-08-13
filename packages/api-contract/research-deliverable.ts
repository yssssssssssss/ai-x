import type { PlanStep } from './plan.ts';

export type EvidenceClass =
  | 'public_source'
  | 'screenshot'
  | 'user_input'
  | 'knowledge'
  | 'dataset'
  | 'simulation'
  | 'derived';

export type EvidenceKind = 'tool_output' | 'knowledge_excerpt' | 'user_constraint' | 'screenshot';

export interface EvidenceRequirement {
  id: string;
  acceptedClasses: EvidenceClass[];
  minimumCount: number;
  required: boolean;
}

export type DeliverableType = 'research_plan';

export interface CurrentExecutionPlan {
  task_id: string;
  deliverable_type: DeliverableType;
  evidence_requirements: EvidenceRequirement[];
  steps: PlanStep[];
}

export interface PendingInput {
  role: string;
  label: string;
  multiple: boolean;
  targets: Array<{
    step_no: number;
    tool_id: string;
    field: string;
    multiple: boolean;
  }>;
}

export interface FactFinding {
  id: string;
  kind: 'fact';
  evidenceIds: string[];
  statement: string;
}

export interface InferenceFinding {
  id: string;
  kind: 'inference';
  findingIds: string[];
  statement: string;
}

export interface AnalysisNode {
  id: string;
  findingIds: string[];
  statement: string;
}

export interface SummaryNode {
  id: string;
  findingIds: string[];
  analysisIds: string[];
  summary: string;
}

export interface ConclusionNode {
  id: string;
  summaryIds: string[];
  statement: string;
}

export interface FindingGraph {
  findings: Array<FactFinding | InferenceFinding>;
  analyses: AnalysisNode[];
  subQuestionSummaries: SummaryNode[];
  overallConclusions: ConclusionNode[];
}

export interface CurrentRecommendation {
  id: string;
  summaryIds: string[];
  statement: string;
}

export interface CapabilityProvenance {
  id: string;
  type: string;
}

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  evidenceClass: EvidenceClass;
  toolId?: string;
  toolTier?: 'core' | 'optional';
  artifactId: string;
  artifactContentSha256: string;
  jsonPointer: string;
  sourceUrl?: string;
  stepNo?: number;
  toolProof?: {
    implementationId: string;
    executionMode: 'real';
    redactedOutputHash: string;
  };
  sensitivity: 'public' | 'internal' | 'sensitive';
  redaction: 'none' | 'masked' | 'blocked';
}

export interface ResearchDeliverableEnvelope<TPayload> {
  version: 'research-deliverable-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableType: DeliverableType;
  evidenceManifestArtifactId: string;
  methodSummary: string;
  findingGraph: FindingGraph;
  payload: TPayload;
  recommendations: CurrentRecommendation[];
  risksAndOpenIssues: string[];
  capabilityProvenance: CapabilityProvenance[];
}

export interface ResearchPlanPayload {
  title: string;
  researchGoal: string;
  scope: {
    market: string;
    subjects: string[];
    timeWindow: string;
  };
  competitorSampling: {
    strategy: string;
    targetCount: number;
    inclusionCriteria: string[];
    exclusionCriteria: string[];
  };
  researchQuestions: string[];
  comparisonDimensions: Array<{
    id: string;
    name: string;
    purpose: string;
    collectionFields: string[];
  }>;
  sourcePlan: Array<{
    evidenceClass: EvidenceClass;
    sourceTypes: string[];
    purpose: string;
  }>;
  executionPlan: Array<{
    phase: string;
    activities: string[];
    duration: string;
    outputs: string[];
  }>;
  collectionTemplate: Array<{
    field: string;
    description: string;
    evidenceRequired: boolean;
  }>;
  analysisMethods: string[];
  deliverables: string[];
  qualityChecks: string[];
}
