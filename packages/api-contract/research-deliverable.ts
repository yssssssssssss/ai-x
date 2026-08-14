
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

export interface ResearchQuestion {
  id: string;
  statement: string;
  rationale: string;
  priority: 'required' | 'optional';
  success_criterion_ids: string[];
  evidence_requirements: EvidenceRequirement[];
  acceptance_criteria: string[];
  depends_on: string[];
}

export interface ProblemGraph {
  version: 'problem-graph-v1';
  questions: ResearchQuestion[];
}

export interface ProblemGraphProvenance {
  receiptId: string;
  modelName: string;
  modelVersion: string;
  promptHash: string;
  traceId: string;
}

export interface CurrentPlanInputBinding {
  target_pointer: string;
  source_step_no: number;
  source_pointer: string;
}

export interface CurrentPlanExpectedOutput {
  pointer: string;
  description: string;
}

export interface CurrentPlanStep {
  step_no: number;
  step_name: string;
  actor_type: 'tool' | 'skill' | 'llm' | 'reviewer';
  actor_id: string;
  question_ids: string[];
  depends_on: number[];
  input: Record<string, unknown>;
  input_bindings: CurrentPlanInputBinding[];
  expected_outputs: CurrentPlanExpectedOutput[];
  acceptance_criteria: string[];
  requires_approval: boolean;
  approval_role?: 'owner' | 'legal' | 'security';
  fallback_actor_ids: string[];
}

export interface CurrentCapabilitySkill {
  id?: string;
  name?: string;
  path?: string;
  when_to_use?: string;
  owner?: string;
  status: 'draft' | 'active' | 'deprecated';
  task_types: string[];
  intent_tags?: string[];
  inputs: string[];
  outputs: string[];
  input_schema?: string;
  output_schema?: string;
  entry?: string;
  required_tools: string[];
  cost_level?: string;
  risk_level?: 'low' | 'medium' | 'high';
}

export type CurrentCapabilityReasonCode =
  | 'skill_inactive'
  | 'task_type_mismatch'
  | 'required_tool_missing'
  | 'required_tool_inactive'
  | 'required_tool_health_unknown'
  | 'required_tool_unhealthy'
  | 'core_tool_real_adapter_unavailable'
  | 'approval_unavailable'
  | 'pending_input_required'
  | 'eligible';

export interface CurrentCapabilityDecisionReason {
  code: CurrentCapabilityReasonCode;
  message: string;
  related_id?: string;
}

export interface CurrentCapabilityPendingInput {
  role: string;
  label: string;
  multiple: boolean;
  capability_id: string;
}

export interface CurrentCapabilityApproval {
  capability_type: 'skill' | 'tool';
  capability_id: string;
  authority: 'owner' | 'legal' | 'security';
}

export interface CurrentCapabilityDecision {
  skill: CurrentCapabilitySkill;
  required_approvals: CurrentCapabilityApproval[];
  reasons: CurrentCapabilityDecisionReason[];
  pending_inputs: CurrentCapabilityPendingInput[];
}

export interface CurrentCapabilityDecisions {
  eligible: CurrentCapabilityDecision[];
  rejected: CurrentCapabilityDecision[];
}

export interface CurrentExecutionPlan {
  task_id: string;
  deliverable_type: DeliverableType;
  evidence_requirements: EvidenceRequirement[];
  problem_graph: ProblemGraph;
  problem_graph_provenance: ProblemGraphProvenance;
  capability_decisions: CurrentCapabilityDecisions;
  steps: CurrentPlanStep[];
  candidate_metadata: {
    title: string;
    rationale: string;
    tradeoffs: string;
  };
  activated_nodes: string[];
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
