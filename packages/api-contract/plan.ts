// 前后端共享契约 —— orchestrator 领域类型(计划/执行)。
// 中立 seam:不属于任何一方的运行时目录,前端(client.ts)、后端(plan-types.ts
// re-export)、agent-api 都从这里 import type。零运行时依赖,纯 import type。
// 生产者是 orchestrator,故这些类型以后端历史定义为准。

export const CANDIDATE_PROFILES = [
  'speed',
  'depth',
  'breadth',
  'focused',
  'mixed_method',
  'decision',
  'remediation',
] as const;

export type CandidateProfile = typeof CANDIDATE_PROFILES[number];

export function isCandidateProfile(value: unknown): value is CandidateProfile {
  return typeof value === 'string'
    && (CANDIDATE_PROFILES as readonly string[]).includes(value);
}

export type PlanningSignalSourcePath =
  | 'raw_input'
  | 'task.task_type'
  | 'task.research_goal'
  | 'task.target_audience'
  | 'task.scope'
  | 'task.constraints'
  | 'task.success_criteria'
  | 'task.expected_deliverables'
  | 'problem_graph.evidence_requirements'
  | 'available_material_roles';

export interface PlanningProvenance {
  version: 'planning-guidance-provenance-v1';
  resolver_version: 'candidate-profile-resolver-v1' | 'candidate-profile-resolver-v2';
  scenario_catalog_hash: string;
  signal_catalog_hash: string;
  profile_spec_hash: string;
  scenario_mapping_hash: string;
  classification_method: 'rule' | 'classifier' | 'clarification' | 'direct_skill_bypass' | 'fixed_policy';
  classifier_call_count: 0 | 1;
  primary_scenario_id: string | null;
  secondary_scenario_ids: string[];
  confidence: 'high' | 'medium' | 'low' | null;
  signals: Array<{ signal_id: string; source_path: PlanningSignalSourcePath }>;
  selected_profile_ids: CandidateProfile[];
  degradations: Array<{ code: string; profile_id?: CandidateProfile }>;
}

export interface GuidanceRef {
  node: string;
  id: string;
  title: string;
  summary: string;
  source_path: string;
  content_hash: string;
}

export interface Assumption {
  key: string;
  value: string;
  editable: boolean;
}

export interface ResearchTaskData {
  task_type: string;
  business_domain: string;
  research_goal: string;
  assumptions: Assumption[];
  confirmations: unknown[];
  blocking_issues: unknown[];
  sensitivity: string;
  pii_detected: boolean;
}

export interface ResearchTaskV2Constraint {
  id: string;
  statement: string;
  source: 'user' | 'policy';
}

export interface ResearchTaskV2SuccessCriterion {
  id: string;
  statement: string;
}

export interface ResearchTaskV2Ambiguity {
  id: string;
  statement: string;
  blocking: boolean;
}

export interface ResearchTaskV2ClarificationQuestion {
  key: string;
  question: string;
  rationale: string;
}

export interface ResearchTaskV2BlockingIssue {
  key: string;
  reason: string;
  kind: string;
}

export const REQUESTED_ARTIFACTS = [
  'executive_answers',
  'research_report',
  'strategy_map',
  'mind_model',
  'design_principles',
  'opportunity_backlog',
  'prioritized_actions',
  'channel_strategies',
  'action_plan',
] as const;
export type RequestedArtifact = typeof REQUESTED_ARTIFACTS[number];
export type ResearchOutcomeMode = 'plan' | 'answer';

export type EvidenceClass =
  | 'public_source'
  | 'screenshot'
  | 'user_input'
  | 'knowledge'
  | 'dataset'
  | 'simulation'
  | 'derived';

export const CONTRIBUTION_TYPES = [
  'market_landscape',
  'competitive_analysis',
  'persona',
  'jobs_to_be_done',
  'journey',
  'qualitative_insight',
  'voc',
  'satisfaction',
  'metrics',
  'funnel',
  'feature_adoption',
  'design_audit',
  'accessibility',
  'research_method',
  'prioritization',
  'strategy',
  'action_plan',
  'virtual_user_hypothesis',
] as const;

export type ContributionType = typeof CONTRIBUTION_TYPES[number];

export type SkillCompositionMode = 'standalone' | 'contributor' | 'synthesizer';

export interface SkillCompositionContract {
  modes: SkillCompositionMode[];
  supported_outcomes: ResearchOutcomeMode[];
  compatible_deliverables: string[];
  contribution_types?: ContributionType[];
  contribution_schema?: string;
  required_input_roles: string[];
  optional_input_roles: string[];
  standalone_reason?: string;
}

export interface CapabilityDemand {
  id: string;
  type: ContributionType;
  questionIds: string[];
  requestedArtifactTypes: RequestedArtifact[];
  requiredEvidenceClasses: EvidenceClass[];
  requiredInputRoles: string[];
  priority: 'required' | 'optional';
}

export interface CapabilityDemandGraphV1 {
  version: 'capability-demand-graph-v1';
  demands: CapabilityDemand[];
}

export interface ResearchTaskV2 {
  version: 'research-task-v2';
  task_type: 'competitive_research' | 'user_research_planning' | 'research_synthesis' | 'voc_diagnosis' | 'design_audit' | 'a11y_audit';
  outcome_mode?: ResearchOutcomeMode;
  requested_artifacts?: RequestedArtifact[];
  business_domain: string;
  research_goal: string;
  comparison_dimensions?: string[];
  target_audience: string[];
  scope: string[];
  constraints: ResearchTaskV2Constraint[];
  success_criteria: ResearchTaskV2SuccessCriterion[];
  expected_deliverables: string[];
  assumptions: Assumption[];
  ambiguities: ResearchTaskV2Ambiguity[];
  clarification_questions: ResearchTaskV2ClarificationQuestion[];
  blocking_issues: ResearchTaskV2BlockingIssue[];
  sensitivity: 'public' | 'internal' | 'confidential';
  pii_detected: boolean;
}

export interface PendingUpload {
  kind?: 'value' | 'visual';
  role: string;
  label: string;
  multiple: boolean;
  targets: Array<{ step_no: number; tool_id: string; field: string; multiple: boolean }>;
}

export interface PlanStep {
  step_no: number;
  step_name: string;
  actor_type: 'skill' | 'tool' | 'llm' | 'reviewer';
  actor_id: string;
  purpose?: string;
  input?: Record<string, unknown>;
  requires_approval?: boolean;
}

export interface PlanCandidate {
  id: CandidateProfile;
  title: string;
  rationale: string;
  tradeoffs: string;
  recommended?: boolean;
  steps: PlanStep[];
  assumptions: Assumption[];
  activated_nodes: string[];
}

export interface PlanResult {
  taskId: string;
  task: ResearchTaskData;
  activatedNodes: string[];
  candidates: PlanCandidate[];
  workspaceUri: string;
}

export type PlanPhaseKey = 'understand' | 'activate' | 'guidance' | 'states' | 'candidates' | 'persist';

export interface PlanProgress {
  phase: PlanPhaseKey;
  status: 'start' | 'done';
  label: string;
  detail?: string;
}

export interface SelectResult {
  taskId: string;
  candidateId: PlanCandidate['id'];
  plan: unknown;
  pendingUploads: PendingUpload[];
}

// executePhase / resumePhase 的返回:paused=停在失败步待用户决策;completed_with_gaps=有缺口但已合成。
export interface ExecuteResult {
  status: 'completed' | 'completed_with_gaps' | 'paused' | 'failed';
  reportArtifactId?: string;
  failedStepNo?: number;
  failedStepName?: string;
  gapCount?: number;
}
