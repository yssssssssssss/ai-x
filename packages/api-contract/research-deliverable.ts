import type { PlanningProvenance } from './plan.ts';

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

export type DeliverableType = string;

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
  actor_type: 'knowledge' | 'tool' | 'skill' | 'llm' | 'reviewer';
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
  skill_invocation_id?: string;
  skill_stage_id?: string;
}

export interface CurrentSkillInvocation {
  invocation_id: string;
  skill_id: string;
  execution_mode: 'compiled';
  contract_version: 'skill-execution-contract-v1';
  contract_hash: string;
  step_nos: number[];
}

export interface CurrentKnowledgeReference {
  resourceId: string;
  sourcePath: string;
  status: 'approved' | 'draft';
  contentHash: string;
  required: boolean;
  failurePolicy: 'block' | 'gap';
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
  visual_inputs?: string[];
  outputs: string[];
  input_schema?: string;
  output_schema?: string;
  payload_schema?: string;
  entry?: string;
  required_tools: string[];
  optional_tools?: string[];
  execution_mode?: 'legacy_single_call' | 'compiled';
  execution_contract?: string;
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
  kind: 'value' | 'visual';
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

export type CurrentOptionalToolReasonCode =
  | 'optional_tool_health_unknown'
  | 'optional_tool_unhealthy'
  | 'optional_tool_real_adapter_unavailable';

export interface CurrentOptionalToolDecision {
  tool_id: string;
  status: 'available' | 'unavailable';
  reason_code?: CurrentOptionalToolReasonCode;
  message?: string;
}

export interface CurrentCapabilityGap {
  capability_type: 'tool';
  capability_id: string;
  code: CurrentOptionalToolReasonCode;
  message: string;
}

export interface CurrentCapabilityDecision {
  skill: CurrentCapabilitySkill;
  required_approvals: CurrentCapabilityApproval[];
  reasons: CurrentCapabilityDecisionReason[];
  pending_inputs: CurrentCapabilityPendingInput[];
  optional_tool_decisions?: CurrentOptionalToolDecision[];
}

export interface CurrentCapabilityDecisions {
  eligible: CurrentCapabilityDecision[];
  rejected: CurrentCapabilityDecision[];
}

export interface CurrentExecutionPlan {
  task_id: string;
  execution_contract_version?: 'current-execution-plan-v2';
  skill_invocations?: CurrentSkillInvocation[];
  deliverable_type: DeliverableType;
  evidence_requirements: EvidenceRequirement[];
  problem_graph: ProblemGraph;
  problem_graph_provenance: ProblemGraphProvenance;
  capability_decisions: CurrentCapabilityDecisions;
  capability_gaps?: CurrentCapabilityGap[];
  steps: CurrentPlanStep[];
  candidate_metadata: {
    title: string;
    rationale: string;
    tradeoffs: string;
    recommended?: boolean;
  };
  planning_provenance?: PlanningProvenance;
  activated_nodes: string[];
}

export interface PendingInput {
  kind: 'value' | 'visual';
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

export interface QuestionCoverageBinding {
  questionId: string;
  summaryIds: string[];
}

export interface SuccessCriterionCoverageBinding {
  successCriterionId: string;
  conclusionIds: string[];
  recommendationIds: string[];
}

export interface ResearchDeliverableCoverage {
  questionBindings: QuestionCoverageBinding[];
  successCriterionBindings: SuccessCriterionCoverageBinding[];
}

export interface CapabilityProvenance {
  id: string;
  type: string;
}

export type VisualAssetExportPolicy = 'allow' | 'mask' | 'block';

export interface VisualAssetReference {
  assetId: string;
  manifestArtifactId: string;
}

export type VisualAssetSource =
  | {
      kind: 'tool_artifact';
      artifactId: string;
      artifactContentSha256: string;
      jsonPointer: string;
      url: string;
    }
  | { kind: 'user_upload'; fileName: string }
  | { kind: 'derived' };

export interface BrowserCaptureSource {
  kind: 'browser_capture';
  artifactId: string;
  artifactContentSha256: string;
  jsonPointer: string;
  attachmentId: string;
  sourcePageUrl: string;
  finalUrl: string;
  pageTitle: string;
  capturedAt: string;
  captureMode: 'extracted_image' | 'element_screenshot' | 'full_page_screenshot';
  selector?: string;
  viewport: { width: number; height: number };
}

export interface ChartRenderSource {
  kind: 'chart_render';
  dataArtifactId: string;
  dataArtifactContentSha256: string;
}

export type VisualAssetSourceV2 = VisualAssetSource | BrowserCaptureSource | ChartRenderSource;

export interface VisualAssetLineage {
  assetId: string;
  manifestArtifactId: string;
  contentSha256: string;
  manifestHash: string;
}

export type ChartType = 'comparison' | 'trend' | 'heatmap';

export interface ChartSeries {
  key: string;
  label: string;
  values: Array<number | null>;
  evidenceIds: string[][];
}

export interface ChartSpec {
  version: 'chart-spec-v1';
  chartId: string;
  type: ChartType;
  title: string;
  categories: string[];
  series: ChartSeries[];
  yAxis?: { min: number };
}

export type VisualAssetDerivation =
  | { kind: 'annotation'; overlayArtifactId: string }
  | { kind: 'heatmap' }
  | { kind: 'chart_svg'; chartId: string; specHash: string };

export interface VisualAssetManifestV1 {
  version: 'visual-asset-manifest-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  assetId: string;
  contentSha256: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  byteSize: number;
  width: number;
  height: number;
  exportPolicy: VisualAssetExportPolicy;
  source: VisualAssetSource;
  derivedFrom: VisualAssetLineage | null;
  derivation: VisualAssetDerivation | null;
  manifestHash: string;
}

export interface VisualAssetManifestV2 {
  version: 'visual-asset-manifest-v2';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  assetId: string;
  contentSha256: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  byteSize: number;
  width: number;
  height: number;
  exportPolicy: VisualAssetExportPolicy;
  source: VisualAssetSourceV2;
  derivedFrom: VisualAssetLineage | null;
  derivation: VisualAssetDerivation | null;
  manifestHash: string;
}

export type VisualAssetManifest = VisualAssetManifestV1 | VisualAssetManifestV2;

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

export interface EvidenceManifest {
  version: 'evidence-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  collectedAt: string;
  manifestHash: string;
  entries: EvidenceEntry[];
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
  coverage: ResearchDeliverableCoverage;
  risksAndOpenIssues: string[];
  capabilityProvenance: CapabilityProvenance[];
}

export type LegacyResearchDeliverableEnvelope<TPayload> =
  Omit<ResearchDeliverableEnvelope<TPayload>, 'coverage'> & {
    coverage?: ResearchDeliverableCoverage;
  };

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
