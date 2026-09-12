import type {
  CapabilityDemandGraphV1,
  CandidateProfile,
  ContributionType,
  EvidenceClass,
  PlanningProvenance,
  RequestedArtifact,
  SkillCompositionContract,
} from './plan.ts';

export type { EvidenceClass } from './plan.ts';

export type EvidenceKind = 'tool_output' | 'knowledge_excerpt' | 'user_constraint' | 'screenshot' | 'dataset';

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
  optional?: boolean;
  include_artifact_identity?: boolean;
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

export interface CurrentSkillResourceGap {
  query_id: string;
  min_items: number;
  selected_items: number;
  failure_policy: 'gap';
  reason: string;
}

export interface CurrentSkillInvocationV2Base {
  invocation_id: string;
  skill_id: string;
  step_nos: number[];
}

export interface CurrentCompiledSkillInvocationV2 extends CurrentSkillInvocationV2Base {
  execution_mode: 'compiled';
  contract_version: 'skill-execution-contract-v1';
  contract_hash: string;
  degraded_policy: 'block' | 'gap';
  skill_reference_hashes: Array<{ path: string; hash: string }>;
  knowledge_references: CurrentKnowledgeReference[];
  resource_gaps: CurrentSkillResourceGap[];
}

export interface CurrentLegacySkillInvocationV2 extends CurrentSkillInvocationV2Base {
  execution_mode: 'legacy_single_call';
  contract_version?: never;
  contract_hash?: never;
  degraded_policy?: never;
  skill_reference_hashes?: never;
  knowledge_references?: never;
  resource_gaps?: never;
}

export type CurrentSkillInvocation =
  | CurrentCompiledSkillInvocationV2
  | CurrentLegacySkillInvocationV2;

export interface CurrentSkillInvocationV3Base {
  invocation_id: string;
  skill_id: string;
  role: 'contributor' | 'synthesizer';
  /** Frozen Demand ownership. Optional only when reading early Plan v3 records. */
  demand_ids?: string[];
  contribution_types: ContributionType[];
  question_ids: string[];
  requested_artifact_types: RequestedArtifact[];
  depends_on_invocation_ids: string[];
  output_contract: string;
  required: boolean;
  failure_policy: 'block' | 'gap';
  step_nos: number[];
}

export interface CurrentCompiledSkillInvocationV3 extends CurrentSkillInvocationV3Base {
  execution_mode: 'compiled';
  contract_version: 'skill-execution-contract-v1';
  contract_hash: string;
  degraded_policy: 'block' | 'gap';
  skill_reference_hashes: Array<{ path: string; hash: string }>;
  knowledge_references: CurrentKnowledgeReference[];
  resource_gaps: CurrentSkillResourceGap[];
}

export interface CurrentLegacySkillInvocationV3 extends CurrentSkillInvocationV3Base {
  execution_mode: 'legacy_single_call';
  contract_version?: never;
  contract_hash?: never;
  degraded_policy?: never;
  skill_reference_hashes?: never;
  knowledge_references?: never;
  resource_gaps?: never;
}

export type CurrentSkillInvocationV3 =
  | CurrentCompiledSkillInvocationV3
  | CurrentLegacySkillInvocationV3;

export interface PlanPortfolioSummary {
  profile_id: CandidateProfile;
  selected: Array<{
    invocation_id: string;
    skill_id: string;
    role: 'contributor' | 'synthesizer';
    reason_codes: string[];
    estimated_steps: number;
  }>;
  rejected: Array<{
    skill_id: string;
    reason_code: string;
    related_ids: string[];
  }>;
  shared_prerequisites: Array<{
    capability_type: 'tool' | 'knowledge';
    capability_id: string;
    consumer_skill_ids: string[];
  }>;
  estimated_budget: {
    max_steps: number;
    estimated_steps: number;
    selected_contributor_count: number;
    selected_skill_count: number;
    required_demand_count: number;
    optional_demand_count: number;
    expanded_step_count: number;
    expanded_step_limit: number;
  };
}

export interface PlanContributionRequirement {
  id: string;
  demand_type: ContributionType;
  question_ids: string[];
  requested_artifact_types: RequestedArtifact[];
  owner_invocation_id: string;
  corroborator_invocation_ids: string[];
  required: boolean;
}

export interface SharedPlanStepMetadata {
  shared_stage_key: string;
  shared_by_invocation_ids: string[];
  share_fingerprint: string;
}

export type CurrentPlanStepV3 = CurrentPlanStep & Partial<SharedPlanStepMetadata>;

export interface CurrentKnowledgeReference {
  resourceId: string;
  resourceType: string;
  sourcePath: string;
  status: 'approved' | 'draft';
  contentHash: string;
  required: boolean;
  failurePolicy: 'block' | 'gap';
  queryId?: string;
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
  composition?: SkillCompositionContract;
}

export type CurrentCapabilityReasonCode =
  | 'skill_inactive'
  | 'task_type_mismatch'
  | 'outcome_mismatch'
  | 'deliverable_mismatch'
  | 'composition_mode_mismatch'
  | 'contribution_type_mismatch'
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
  kind: 'value' | 'visual' | 'dataset';
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

export interface CurrentExecutionPlanV3 extends Omit<
  CurrentExecutionPlan,
  'execution_contract_version' | 'skill_invocations' | 'steps'
> {
  execution_contract_version: 'current-execution-plan-v3';
  capability_demand_graph: CapabilityDemandGraphV1;
  portfolio_summary: PlanPortfolioSummary;
  skill_invocations: CurrentSkillInvocationV3[];
  contribution_requirements: PlanContributionRequirement[];
  steps: CurrentPlanStepV3[];
}

export type ReadableCurrentExecutionPlan = CurrentExecutionPlan | CurrentExecutionPlanV3;

export const CONTRIBUTION_UNIT_KINDS = [
  'observation',
  'finding',
  'insight',
  'hypothesis',
  'persona',
  'job',
  'journey_stage',
  'metric',
  'method',
  'priority',
  'recommendation',
  'action',
  'artifact_item',
] as const;

export type ContributionUnitKind = typeof CONTRIBUTION_UNIT_KINDS[number];

export interface ResearchContributionSupport {
  questionIds: string[];
  evidenceIds: string[];
  status: 'supported' | 'provisional';
  confidence: number;
  validationNeeded: string;
}

export interface ResearchContributionUnit {
  key: string;
  kind: ContributionUnitKind;
  title: string;
  statement: string;
  businessImplication?: string;
  recommendedAction?: string;
  requestedArtifactTypes: RequestedArtifact[];
  support: ResearchContributionSupport;
}

export interface ResearchContributionV1 {
  version: 'research-contribution-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  invocationId: string;
  skillId: string;
  contributionTypes: ContributionType[];
  units: ResearchContributionUnit[];
  limitations: string[];
  openQuestions: string[];
}

export interface ContributionSourceUnitMapping {
  sourceUnitKey: string;
  targetUnitKey: string;
  sourceJsonPointer: string;
  sourceSemanticHash: string;
}

export interface ResearchContributionArtifactV1 {
  version: 'research-contribution-artifact-v1';
  contribution: ResearchContributionV1;
  source: {
    artifactId: string;
    artifactContentSha256: string;
    schemaVersion: string;
    adapterId: string;
    adapterVersion: string;
    adapterHash: string;
    unitMappings: ContributionSourceUnitMapping[];
    diagnosticFields: string[];
  };
}

export interface ResearchContributionBundleEntry {
  invocationId: string;
  skillId: string;
  artifactId: string;
  artifactContentSha256: string;
  contribution: ResearchContributionV1;
}

export interface ResearchContributionBundleGap {
  invocationId: string;
  skillId: string;
  reason: string;
}

export interface ResearchContributionBundleV1 {
  version: 'research-contribution-bundle-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  orderedInvocationIds: string[];
  entries: ResearchContributionBundleEntry[];
  gaps: ResearchContributionBundleGap[];
}

export const CROSS_SKILL_REVIEW_ISSUE_TYPES = [
  'coverage',
  'conflict',
  'unsupported_claim',
  'duplicate',
  'method_mismatch',
  'provisional_promoted',
  'scope_mismatch',
  'synthetic_overclaim',
  'unauthorized_source_rewrite',
  'missing_artifact',
  'priority_without_basis',
] as const;

export type CrossSkillReviewIssueType = typeof CROSS_SKILL_REVIEW_ISSUE_TYPES[number];

export interface CrossSkillReviewIssue {
  id: string;
  type: CrossSkillReviewIssueType;
  sourceUnitIds: string[];
  targetNodeIds: string[];
  message: string;
  disposition: 'included' | 'merged' | 'conflicted' | 'omitted';
}

export interface CrossSkillReviewV1 {
  version: 'cross-skill-review-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  synthesisArtifactId: string;
  verdict: 'pass' | 'pass_with_conditions' | 'block';
  issues: CrossSkillReviewIssue[];
}

export interface ContributionSummaryV1 {
  version: 'contribution-summary-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  contributors: Array<{
    invocationId: string;
    skillId: string;
    contributionTypes: ContributionType[];
    unitCount: number;
    limitations: string[];
    units: Array<{
      sourceArtifactId: string;
      sourceUnitKey: string;
      kind: ResearchContributionUnit['kind'];
      title: string;
      statement: string;
      questionIds: string[];
      evidenceIds: string[];
      status: ResearchContributionSupport['status'];
      confidence: number;
      disposition: ContributionDisposition;
      canonicalNodeIds: string[];
    }>;
    dispositions: Array<{
      sourceUnitKey: string;
      disposition: ContributionDisposition;
      canonicalNodeIds: string[];
    }>;
  }>;
}

export type ContributionDisposition = 'included' | 'merged' | 'conflicted' | 'omitted';

export interface ContributionLedgerEntry {
  contributionArtifactId: string;
  invocationId: string;
  sourceUnitKey: string;
  sourceSemanticHash: string;
  disposition: ContributionDisposition;
  canonicalNodeIds: string[];
  reason?: string;
  reviewIssueIds: string[];
}

export interface ContributionLedgerV1 {
  version: 'contribution-ledger-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  entries: ContributionLedgerEntry[];
}

export interface PendingInput {
  kind: 'value' | 'visual' | 'dataset';
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

export interface IndustryMarketSupportV1 {
  questionIds: string[];
  evidenceIds: string[];
  status: 'supported' | 'provisional' | 'unavailable';
  confidence: number;
  validationNeeded: string;
  sourceContributionUnitIds?: string[];
}

export interface IndustryMarketClaimV1 {
  id: string;
  title: string;
  statement: string;
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketSectionV1 {
  status: IndustryMarketSupportV1['status'];
  summary: string;
  items: IndustryMarketClaimV1[];
}

export interface IndustryMarketScopeV1 {
  category: string;
  subcategories: string[];
  exclusions: string[];
  analysisDepth: 'light' | 'medium' | 'heavy';
  primaryFocus: string;
  secondaryFocuses: string[];
  decisionAudience: string[];
  decisionGoal: string;
  timeWindow: string;
}

export interface IndustryMarketCoverageEntryV1 {
  dimension: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';
  status: 'supported' | 'partial' | 'unavailable';
  summary: string;
  evidenceIds: string[];
  gapIds: string[];
}

export interface IndustryMarketAudienceV1 extends IndustryMarketSectionV1 {
  basisType: 'dataset_derived' | 'qualitative_draft' | 'simulation';
  coreVariables: string[];
  supportingVariables: string[];
  sampleCoverage: string;
  segments: IndustryMarketClaimV1[];
  personas: IndustryMarketClaimV1[];
  differences: IndustryMarketClaimV1[];
  designImplications: IndustryMarketClaimV1[];
}

export interface IndustryMarketCompetitorSampleV1 {
  id: string;
  name: string;
  rationale: string;
  evidenceIds: string[];
}

export interface IndustryMarketCompetitorAnalysisV1 extends IndustryMarketSectionV1 {
  competitorSamples: IndustryMarketCompetitorSampleV1[];
  dimensionMatrix: Array<{
    dimension: string;
    values: Array<{ sampleId: string; value: string; evidenceIds: string[] }>;
  }>;
  differences: Array<{
    id: string;
    dimension: string;
    statement: string;
    support: IndustryMarketSupportV1;
  }>;
  impacts: Array<{
    differenceId: string;
    audience: string;
    statement: string;
    support: IndustryMarketSupportV1;
  }>;
  visualEvidence: Array<{
    id: string;
    sampleIds: string[];
    dimension: string;
    assetId: string;
    evidenceIds: string[];
    caption: string;
  }>;
  screenshotComparisons: Array<{
    id: string;
    dimension: string;
    sampleIds: string[];
    assetIds: [string, string];
    caption: string;
  }>;
}

export interface IndustryMarketFindingV1 {
  id: string;
  statement: string;
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketGapMatrixItemV1 {
  id: string;
  userNeed: string;
  jdState: string;
  competitorSupply: string;
  gapLevel: 'low' | 'medium' | 'high';
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketOpportunityV1 {
  id: string;
  title: string;
  statement: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketStrategyChainV1 {
  id: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  opportunityId: string;
  title: string;
  goal: string;
  currentProblem: string;
  currentEvidenceIds: string[];
  currentScreenshotAssetIds: string[];
  competitorReference: string;
  competitorEvidenceIds: string[];
  designAction: string;
  categoryAssetRefs: string[];
  ownerType: string;
  measurement: string;
  validationMethod: string;
  wireframeAssetId: string | null;
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketCategoryAssetV1 {
  id: string;
  family: string;
  name: string;
  fitness: 'recommended' | 'optional' | 'unsuitable';
  rationale: string;
  benchmarkEvidenceIds: string[];
  collectedAt: string;
  reviewStatus: 'current' | 'pending_review' | 'outdated';
  platformInheritance: string;
  categoryDelta: string;
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketMeasurementV1 {
  id: string;
  name: string;
  definition: string;
  baseline: string | number | null;
  target: string | number | null;
  validationMethod: string;
  support: IndustryMarketSupportV1;
}

export interface IndustryMarketDataGapV1 {
  id: string;
  dimensionIds: IndustryMarketCoverageEntryV1['dimension'][];
  statement: string;
  impact: string;
  resolutionPath: string;
}

interface IndustryMarketPayloadBaseV1 {
  title: string;
  scope: IndustryMarketScopeV1;
  coverageLedger: IndustryMarketCoverageEntryV1[];
  marketLandscape: IndustryMarketSectionV1;
  audienceSegments: IndustryMarketAudienceV1;
  supplyLandscape: IndustryMarketSectionV1;
  competitorAnalysis: IndustryMarketCompetitorAnalysisV1;
  jdDiagnosis: IndustryMarketSectionV1;
  validatedFindings: IndustryMarketFindingV1[];
  gapMatrix: IndustryMarketGapMatrixItemV1[];
  positioning: {
    statement: string;
    exclusions: string[];
    support: IndustryMarketSupportV1;
  };
  opportunities: IndustryMarketOpportunityV1[];
  strategyChains: IndustryMarketStrategyChainV1[];
  designLanguage: IndustryMarketSectionV1;
  categoryAssets: IndustryMarketCategoryAssetV1[];
  measurementPlan: IndustryMarketMeasurementV1[];
  dataGaps: IndustryMarketDataGapV1[];
}

export interface IndustryMarketContentDraftV1 extends IndustryMarketPayloadBaseV1 {
  schemaVersion: 'industry-market-content-draft-v1';
  contributionExclusions?: Array<{
    unitId: string;
    reason: string;
  }>;
}

export interface IndustryMarketAnalysisPayloadV1 extends IndustryMarketPayloadBaseV1 {
  schemaVersion: 'industry-market-analysis-v1';
}

export type IndustryMarketPatchableTextField =
  | 'title'
  | 'statement'
  | 'userNeed'
  | 'jdState'
  | 'competitorSupply'
  | 'opportunity'
  | 'name'
  | 'rationale'
  | 'goal'
  | 'currentProblem'
  | 'competitorReference'
  | 'designAction'
  | 'ownerType'
  | 'measurement'
  | 'validationMethod'
  | 'platformInheritance'
  | 'categoryDelta'
  | 'definition'
  | 'baseline'
  | 'target'
  | 'impact'
  | 'resolutionPath';

export interface IndustryMarketReplaceTextPatchV1 {
  op: 'replace_text';
  reviewIssueId: string;
  targetNodeId: string;
  field: IndustryMarketPatchableTextField;
  value: string;
  reason: string;
}

export interface IndustryMarketReplaceSupportPatchV1 {
  op: 'replace_support';
  reviewIssueId: string;
  targetNodeId: string;
  value: IndustryMarketSupportV1;
  reason: string;
}

export interface IndustryMarketContentPatchV1 {
  version: 'industry-market-content-patch-v1';
  operations: Array<IndustryMarketReplaceTextPatchV1 | IndustryMarketReplaceSupportPatchV1>;
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

export type ResearchAnswerStatus = 'supported' | 'provisional' | 'unanswered';
export type RequestedResearchArtifact =
  | 'executive_answers' | 'research_report' | 'strategy_map' | 'mind_model'
  | 'design_principles' | 'opportunity_backlog' | 'prioritized_actions'
  | 'channel_strategies' | 'action_plan';

export interface ResearchStrategyDirectAnswer {
  questionId: string;
  question: string;
  answer: string;
  answerStatus: ResearchAnswerStatus;
  evidenceIds: string[];
  confidence: number;
  businessImplication: string;
  recommendedAction: string;
  validationNeeded: string;
  sourceContributionUnitIds?: string[];
}

export interface ResearchStrategyRiskDisclosure {
  id: string;
  sourceType: 'requirement_ambiguity' | 'skill_degraded_gap' | 'reviewer_condition' | 'envelope_risk' | 'answer_uncertainty';
  sourceId: string;
  statement: string;
  disposition: 'limitation' | 'open_question';
}

export interface ResearchStrategyReportPayload {
  title: string;
  decisionContext: string;
  executiveAnswer: string;
  directAnswers: ResearchStrategyDirectAnswer[];
  evidenceBackedFindings: Array<{ id: string; statement: string; evidenceIds: string[]; confidence: number }>;
  dynamicSections: Array<{
    id: string;
    title: string;
    purpose: string;
    blocks: Array<{
      id: string;
      type: 'narrative' | 'comparison_matrix' | 'strategy_map' | 'mind_model' | 'design_principles' | 'opportunity_backlog' | 'priority_matrix' | 'action_plan';
      title: string;
      content: string;
      questionIds: string[];
      evidenceIds: string[];
      confidence: number;
    }>;
  }>;
  strategyMap: {
    title: string;
    rows: string[];
    columns: string[];
    cells: Array<{ id: string; row: string; column: string; statement: string; evidenceIds: string[]; confidence: number }>;
  };
  mindModel: {
    title: string;
    confidence: number;
    nodes: Array<{ id: string; label: string; description: string; evidenceIds: string[] }>;
    edges: Array<{ from: string; to: string; relationship: string }>;
  };
  designPrinciples: Array<{ id: string; title: string; statement: string; evidenceIds: string[]; confidence: number }>;
  opportunities: Array<{ id: string; title: string; statement: string; evidenceIds: string[]; confidence: number; impact: string }>;
  prioritizedActions: Array<{ id: string; priority: 'P0' | 'P1' | 'P2'; action: string; ownerType: string; rationale: string; evidenceIds: string[]; confidence: number; validationMethod: string }>;
  channelStrategies: Array<{ id: string; channel: string; role: string; strategies: string[]; evidenceIds: string[]; confidence: number }>;
  recommendations: string[];
  limitations: string[];
  openQuestions: string[];
  riskDisclosures: ResearchStrategyRiskDisclosure[];
  requestedArtifactBindings: Array<{
    artifactType: RequestedResearchArtifact;
    sourceField: string;
    blockIds: string[];
    questionIds: string[];
    evidenceIds: string[];
    status: 'complete' | 'partial';
  }>;
}

export type ResearchStrategySupportStatus = 'supported' | 'provisional';

export interface ResearchStrategySupportBindingV2 {
  questionIds: string[];
  evidenceIds: string[];
  confidence: number;
  status: ResearchStrategySupportStatus;
  validationNeeded: string;
  sourceContributionUnitIds?: string[];
}

export interface ResearchStrategyEvidenceFindingDraftV2 {
  key: string;
  statement: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyEvidenceFindingV2 {
  id: string;
  statement: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyNarrativeBlockDraftV2 {
  key: string;
  kind: 'narrative';
  title: string;
  content: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyMatrixCellDraftV2 {
  key: string;
  row: string;
  column: string;
  statement: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyMatrixBlockDraftV2 {
  key: string;
  kind: 'comparison_matrix' | 'strategy_map';
  title: string;
  rows: string[];
  columns: string[];
  cells: ResearchStrategyMatrixCellDraftV2[];
}

export interface ResearchStrategyMindNodeDraftV2 {
  key: string;
  label: string;
  description: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyMindModelBlockDraftV2 {
  key: string;
  kind: 'mind_model';
  title: string;
  nodes: ResearchStrategyMindNodeDraftV2[];
  edges: Array<{ from: string; to: string; relationship: string }>;
}

export interface ResearchStrategyPrincipleDraftV2 {
  key: string;
  title: string;
  statement: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyPrinciplesBlockDraftV2 {
  key: string;
  kind: 'design_principles';
  title: string;
  items: ResearchStrategyPrincipleDraftV2[];
}

export interface ResearchStrategyOpportunityDraftV2 {
  key: string;
  title: string;
  statement: string;
  impact: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyOpportunityBlockDraftV2 {
  key: string;
  kind: 'opportunity_backlog';
  title: string;
  items: ResearchStrategyOpportunityDraftV2[];
}

export interface ResearchStrategyActionDraftV2 {
  key: string;
  priority: 'P0' | 'P1' | 'P2';
  action: string;
  ownerType: string;
  rationale: string;
  validationMethod: string;
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyActionBlockDraftV2 {
  key: string;
  kind: 'prioritized_actions' | 'action_plan';
  title: string;
  items: ResearchStrategyActionDraftV2[];
}

export interface ResearchStrategyChannelDraftV2 {
  key: string;
  channel: string;
  role: string;
  strategies: string[];
  support: ResearchStrategySupportBindingV2;
}

export interface ResearchStrategyChannelBlockDraftV2 {
  key: string;
  kind: 'channel_strategies';
  title: string;
  items: ResearchStrategyChannelDraftV2[];
}

export type ResearchStrategyContentBlockDraftV2 =
  | ResearchStrategyNarrativeBlockDraftV2
  | ResearchStrategyMatrixBlockDraftV2
  | ResearchStrategyMindModelBlockDraftV2
  | ResearchStrategyPrinciplesBlockDraftV2
  | ResearchStrategyOpportunityBlockDraftV2
  | ResearchStrategyActionBlockDraftV2
  | ResearchStrategyChannelBlockDraftV2;

export interface ResearchStrategyContentDraftV2 {
  schemaVersion: 'research-strategy-content-draft-v2';
  title: string;
  decisionContext: string;
  executiveAnswer: string;
  methodSummary: string;
  directAnswers: ResearchStrategyDirectAnswer[];
  evidenceFindings: ResearchStrategyEvidenceFindingDraftV2[];
  contentBlocks: ResearchStrategyContentBlockDraftV2[];
  limitations: string[];
  openQuestions: string[];
}

export type ResearchStrategySupportPatchTarget =
  | { entity: 'evidence_finding'; key: string }
  | { entity: 'content_block'; key: string }
  | { entity: 'content_item'; blockKey: string; key: string };

export interface ResearchStrategyDirectAnswerBindingPatch {
  op: 'replace_direct_answer_binding';
  questionId: string;
  answerStatus: ResearchAnswerStatus;
  evidenceIds: string[];
  confidence: number;
  validationNeeded: string;
  reviewIssueId?: string;
  reason?: string;
}

export interface ResearchStrategySupportPatch {
  op: 'replace_support';
  target: ResearchStrategySupportPatchTarget;
  support: ResearchStrategySupportBindingV2;
  reviewIssueId?: string;
  reason?: string;
}

export interface ResearchStrategyAppendDirectAnswerPatch {
  op: 'append_direct_answer';
  answer: ResearchStrategyDirectAnswer;
}

export interface ResearchStrategyAppendContentBlockPatch {
  op: 'append_content_block';
  block: ResearchStrategyContentBlockDraftV2;
}

export type ResearchStrategyBlockItemDraftV2 =
  | ResearchStrategyMatrixCellDraftV2
  | ResearchStrategyMindNodeDraftV2
  | ResearchStrategyPrincipleDraftV2
  | ResearchStrategyOpportunityDraftV2
  | ResearchStrategyActionDraftV2
  | ResearchStrategyChannelDraftV2;

export interface ResearchStrategyAppendBlockItemPatch {
  op: 'append_block_item';
  blockKey: string;
  item: ResearchStrategyBlockItemDraftV2;
  reviewIssueId: string;
  reason: string;
}

export interface ResearchStrategyAppendLimitationPatch {
  op: 'append_limitation';
  value: string;
  reviewIssueId?: string;
  reason?: string;
}

export interface ResearchStrategyAppendOpenQuestionPatch {
  op: 'append_open_question';
  value: string;
  reviewIssueId?: string;
  reason?: string;
}

export interface ResearchStrategySemanticTextPatch {
  op: 'replace_semantic_text';
  reviewIssueId: string;
  reason: string;
  target: {
    entity: 'draft' | 'direct_answer' | 'evidence_finding' | 'content_block' | 'content_item';
    key: string;
    parentKey?: string;
    field: string;
  };
  value: string | string[];
}

export type ResearchStrategyContentPatchOperationV1 =
  | ResearchStrategyDirectAnswerBindingPatch
  | ResearchStrategySupportPatch
  | ResearchStrategyAppendDirectAnswerPatch
  | ResearchStrategyAppendContentBlockPatch
  | ResearchStrategyAppendBlockItemPatch
  | ResearchStrategyAppendLimitationPatch
  | ResearchStrategyAppendOpenQuestionPatch
  | ResearchStrategySemanticTextPatch;

export interface ResearchStrategyContentPatchV1 {
  version: 'research-strategy-content-patch-v1';
  mode: 'structural_repair' | 'semantic_revision';
  operations: ResearchStrategyContentPatchOperationV1[];
}

export type ResearchStrategyContentBlockV2 =
  | (Omit<ResearchStrategyNarrativeBlockDraftV2, 'key'> & { id: string })
  | (Omit<ResearchStrategyMatrixBlockDraftV2, 'key' | 'cells'> & {
      id: string;
      cells: Array<Omit<ResearchStrategyMatrixCellDraftV2, 'key'> & { id: string }>;
    })
  | (Omit<ResearchStrategyMindModelBlockDraftV2, 'key' | 'nodes'> & {
      id: string;
      nodes: Array<Omit<ResearchStrategyMindNodeDraftV2, 'key'> & { id: string }>;
    })
  | (Omit<ResearchStrategyPrinciplesBlockDraftV2, 'key' | 'items'> & {
      id: string;
      items: Array<Omit<ResearchStrategyPrincipleDraftV2, 'key'> & { id: string }>;
    })
  | (Omit<ResearchStrategyOpportunityBlockDraftV2, 'key' | 'items'> & {
      id: string;
      items: Array<Omit<ResearchStrategyOpportunityDraftV2, 'key'> & { id: string }>;
    })
  | (Omit<ResearchStrategyActionBlockDraftV2, 'key' | 'items'> & {
      id: string;
      items: Array<Omit<ResearchStrategyActionDraftV2, 'key'> & { id: string }>;
    })
  | (Omit<ResearchStrategyChannelBlockDraftV2, 'key' | 'items'> & {
      id: string;
      items: Array<Omit<ResearchStrategyChannelDraftV2, 'key'> & { id: string }>;
    });

export interface ResearchStrategyReportPayloadV2 {
  schemaVersion: 'research-strategy-content-v2';
  title: string;
  decisionContext: string;
  executiveAnswer: string;
  directAnswers: ResearchStrategyDirectAnswer[];
  evidenceFindings: ResearchStrategyEvidenceFindingV2[];
  contentBlocks: ResearchStrategyContentBlockV2[];
  limitations: string[];
  openQuestions: string[];
  riskDisclosures: ResearchStrategyRiskDisclosure[];
  requestedArtifactBindings: Array<{
    artifactType: RequestedResearchArtifact;
    sourceField: '/directAnswers' | '/contentBlocks';
    blockIds: string[];
    questionIds: string[];
    evidenceIds: string[];
    status: 'complete';
  }>;
}

export type AnyResearchStrategyReportPayload =
  | ResearchStrategyReportPayload
  | ResearchStrategyReportPayloadV2;

export interface ReportLayoutBlueprintV1 {
  version: 'report-layout-blueprint-v1';
  sections: Array<{
    title: string;
    purpose: string;
    prominence: 'primary' | 'supporting' | 'appendix';
    blockRefs: string[];
  }>;
}
