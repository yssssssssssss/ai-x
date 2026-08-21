import { createHash } from 'node:crypto';

import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';

export type ScenarioId =
  | 'trend-change-identification'
  | 'competitor-benchmark-research'
  | 'opportunity-direction-evaluation'
  | 'user-material-synthesis'
  | 'user-segmentation'
  | 'user-journey-insight'
  | 'experience-walkthrough'
  | 'feedback-issue-clustering'
  | 'data-behavior-diagnosis'
  | 'root-cause-analysis'
  | 'solution-generation'
  | 'solution-comparison'
  | 'strategy-synthesis'
  | 'priority-roadmap'
  | 'metrics-validation';

export type CandidateProfileId =
  | 'speed'
  | 'depth'
  | 'breadth'
  | 'focused'
  | 'mixed_method'
  | 'decision'
  | 'remediation';

export type GuidanceSourcePath =
  | 'raw_input'
  | 'task.task_type'
  | 'task.research_goal'
  | 'task.target_audience'
  | 'task.scope'
  | 'task.constraints'
  | 'task.success_criteria'
  | 'task.expected_deliverables'
  | 'available_material_roles';

export type ScenarioRelationship = 'serial' | 'parallel' | 'conditional';
export type GuidanceConfidence = 'high' | 'medium' | 'low';
export type CandidateGenerationMode = 'fixed' | 'dynamic';
export type DifferenceDimension = 'scope' | 'method' | 'evidence' | 'review' | 'output_emphasis';

export interface ControlledSignalRef {
  signal_id: string;
  source_path: GuidanceSourcePath;
}

export interface ScenarioClassifierResult {
  primary_scenario_id: ScenarioId;
  secondary_scenarios: Array<{
    scenario_id: ScenarioId;
    relationship: ScenarioRelationship;
  }>;
  confidence: GuidanceConfidence;
  signals: ControlledSignalRef[];
  rationale_codes: Array<
    | 'explicit_goal_match'
    | 'deliverable_match'
    | 'material_match'
    | 'scope_match'
    | 'task_type_context'
    | 'semantic_disambiguation'
  >;
}

export interface ScenarioClassifierRequest {
  schema_name: 'scenario-guidance';
  allowed_scenario_ids: ScenarioId[];
  observed_signals: ControlledSignalRef[];
  raw_input: string;
  task: Pick<
    ResearchTaskV2,
    | 'task_type'
    | 'research_goal'
    | 'target_audience'
    | 'scope'
    | 'constraints'
    | 'success_criteria'
    | 'expected_deliverables'
  >;
  available_material_roles: string[];
}

export interface PlanningGuidanceCapability {
  id: string;
  lifecycle_status: 'active' | 'draft' | 'planned' | 'deprecated';
  resolution_status: 'eligible' | 'rejected';
  profile_support: CandidateProfileId[];
  roles: Array<
    | 'scope_expansion'
    | 'focused_analysis'
    | 'independent_method'
    | 'decision_support'
    | 'issue_identification'
    | 'retest'
  >;
  method_family?: string;
}

export interface PlanningGuidanceRequest {
  raw_input: string;
  task: ResearchTaskV2;
  available_material_roles: string[];
  candidate_generation_mode?: CandidateGenerationMode;
  direct_skill_id?: string;
  baseline_readiness: {
    speed: boolean;
    depth: boolean;
  };
  capabilities: PlanningGuidanceCapability[];
}

export interface PlanningGuidanceOptions {
  classifier?: (request: ScenarioClassifierRequest) => Promise<unknown>;
}

export interface ResolvedProfileSpec {
  id: CandidateProfileId;
  ordinal: number;
  kind: 'baseline' | 'specialty';
  display_name: string;
  max_steps: number;
  dimensions: {
    scope: string;
    method: string;
    evidence: string;
    review: string;
    output_emphasis: string[];
  };
  required_difference_dimensions: DifferenceDimension[];
  coverage_invariant_ids: string[];
  recommended: boolean;
}

export type GuidanceDegradationCode =
  | 'direct_skill_bypass'
  | 'task_blocking_ambiguity'
  | 'classifier_unavailable'
  | 'classifier_failed'
  | 'classifier_invalid'
  | 'low_confidence_classification'
  | 'medium_confidence_profile_conflict'
  | 'dynamic_generation_disabled'
  | 'specialty_capability_unavailable'
  | 'baseline_not_ready';

export interface PlanningGuidanceDegradation {
  code: GuidanceDegradationCode;
  profile_id?: CandidateProfileId;
}

export interface PlanningGuidanceProvenance {
  version: 'planning-guidance-provenance-v1';
  resolver_version: 'candidate-profile-resolver-v1';
  scenario_catalog_hash: string;
  signal_catalog_hash: string;
  profile_spec_hash: string;
  scenario_mapping_hash: string;
  classification_method: 'rule' | 'classifier' | 'clarification' | 'direct_skill_bypass';
  classifier_call_count: 0 | 1;
  primary_scenario_id: ScenarioId | null;
  secondary_scenario_ids: ScenarioId[];
  confidence: GuidanceConfidence | null;
  signals: ControlledSignalRef[];
  selected_profile_ids: CandidateProfileId[];
  degradations: PlanningGuidanceDegradation[];
}

export interface PlanningGuidanceResult {
  status: 'resolved' | 'clarification' | 'bypassed' | 'blocked';
  scenario: {
    primary_scenario_id: ScenarioId | null;
    secondary_scenarios: Array<{
      scenario_id: ScenarioId;
      relationship: ScenarioRelationship;
    }>;
    confidence: GuidanceConfidence | null;
    signals: ControlledSignalRef[];
    rationale_codes: ScenarioClassifierResult['rationale_codes'];
  };
  profiles: ResolvedProfileSpec[];
  clarification: null | {
    reason_code:
      | 'task_blocking_ambiguity'
      | 'classifier_unavailable'
      | 'classifier_failed'
      | 'classifier_invalid'
      | 'low_confidence_classification'
      | 'medium_confidence_profile_conflict';
    candidate_scenario_ids: ScenarioId[];
  };
  planning_provenance: PlanningGuidanceProvenance;
}

interface ProfileSpecDefinition extends Omit<ResolvedProfileSpec, 'recommended' | 'coverage_invariant_ids'> {}

interface ScenarioDefinition {
  id: ScenarioId;
  parent_task_id: 'find-direction' | 'understand-users' | 'find-problems' | 'solve-problems' | 'define-strategy';
  candidate_profiles: readonly CandidateProfileId[];
}

interface SignalDefinition {
  id: string;
  scenario_id?: ScenarioId;
  task_type?: ResearchTaskV2['task_type'];
  profile_id?: CandidateProfileId;
  kind: 'scenario' | 'task_type' | 'profile_content' | 'profile_preference' | 'execution_preference';
  source_paths: readonly GuidanceSourcePath[];
  terms: readonly string[];
}

const PROFILE_SPEC_VERSION = 'profile-spec-gate-2-candidate-v1';
const SCENARIO_MAPPING_VERSION = 'scenario-profile-mapping-gate-2-candidate-v1';
const SIGNAL_CATALOG_VERSION = 'planning-signal-gate-2-candidate-v1';
const COVERAGE_INVARIANT_IDS = [
  'all_required_questions',
  'all_required_evidence',
  'all_requested_deliverables',
  'evidence_policy_unchanged',
  'approval_and_privacy_policy_unchanged',
] as const;

// This is the normalized, reviewable Phase-B contract. Runtime code deliberately does not
// import the hidden Phase-A source draft or any Hub source paths/hashes.
const PROFILE_SPECS: readonly ProfileSpecDefinition[] = [
  {
    id: 'speed', ordinal: 0, kind: 'baseline', display_name: '快速判断', max_steps: 4,
    dimensions: {
      scope: 'minimum_sufficient_full_coverage',
      method: 'shortest_eligible_path_per_required_question',
      evidence: 'minimum_required_no_waiver',
      review: 'mandatory_only',
      output_emphasis: ['complete_requested_deliverables', 'explicit_gaps'],
    },
    required_difference_dimensions: ['scope', 'method', 'evidence', 'review'],
  },
  {
    id: 'depth', ordinal: 1, kind: 'baseline', display_name: '深度研究', max_steps: 8,
    dimensions: {
      scope: 'balanced_full_object_and_question_coverage',
      method: 'cross_source_and_counterevidence',
      evidence: 'triangulated_with_counterevidence',
      review: 'enhanced_consistency_and_alternatives',
      output_emphasis: ['evidence_consistency', 'risks', 'alternative_explanations'],
    },
    required_difference_dimensions: ['scope', 'evidence', 'review'],
  },
  {
    id: 'breadth', ordinal: 2, kind: 'specialty', display_name: '广度扫描', max_steps: 8,
    dimensions: {
      scope: 'expanded_scope_units_including_solution_option',
      method: 'repeat_minimum_sufficient_path_per_scope_unit',
      evidence: 'minimum_required_per_scope_unit',
      review: 'coverage_matrix_consistency',
      output_emphasis: ['coverage_matrix', 'cross_unit_commonalities', 'cross_unit_differences'],
    },
    required_difference_dimensions: ['scope', 'evidence', 'output_emphasis'],
  },
  {
    id: 'focused', ordinal: 3, kind: 'specialty', display_name: '聚焦关键链路', max_steps: 6,
    dimensions: {
      scope: 'user_named_focus_with_global_required_floor',
      method: 'focused_deep_dive',
      evidence: 'higher_density_in_focus_required_elsewhere',
      review: 'focus_attribution',
      output_emphasis: ['focused_root_cause', 'focused_actions'],
    },
    required_difference_dimensions: ['scope', 'evidence', 'output_emphasis'],
  },
  {
    id: 'mixed_method', ordinal: 4, kind: 'specialty', display_name: '混合方法', max_steps: 8,
    dimensions: {
      scope: 'required_scope',
      method: 'two_or_more_independent_method_families',
      evidence: 'triangulated_independent_paths',
      review: 'conflict_and_limitation_review',
      output_emphasis: ['convergence', 'conflicts', 'limitations'],
    },
    required_difference_dimensions: ['method', 'evidence', 'review'],
  },
  {
    id: 'decision', ordinal: 5, kind: 'specialty', display_name: '决策收敛', max_steps: 7,
    dimensions: {
      scope: 'decision_options_and_implementation_bounds',
      method: 'comparative_tradeoff_prioritization',
      evidence: 'option_comparison_risk_priority',
      review: 'decision_risk_review',
      output_emphasis: ['tradeoffs', 'roadmap', 'metrics', 'validation_plan'],
    },
    required_difference_dimensions: ['method', 'evidence', 'output_emphasis'],
  },
  {
    id: 'remediation', ordinal: 6, kind: 'specialty', display_name: '整改复测', max_steps: 7,
    dimensions: {
      scope: 'identified_issues_and_affected_flow',
      method: 'diagnose_remediate_retest',
      evidence: 'baseline_action_retest_or_retest_plan',
      review: 'acceptance_threshold_review',
      output_emphasis: ['issue_action_retest_trace', 'acceptance_thresholds'],
    },
    required_difference_dimensions: ['scope', 'method', 'evidence', 'output_emphasis'],
  },
];

const SCENARIOS: readonly ScenarioDefinition[] = [
  { id: 'trend-change-identification', parent_task_id: 'find-direction', candidate_profiles: ['speed', 'depth', 'breadth'] },
  { id: 'competitor-benchmark-research', parent_task_id: 'find-direction', candidate_profiles: ['speed', 'depth', 'breadth', 'decision'] },
  { id: 'opportunity-direction-evaluation', parent_task_id: 'find-direction', candidate_profiles: ['speed', 'depth', 'focused', 'decision'] },
  { id: 'user-material-synthesis', parent_task_id: 'understand-users', candidate_profiles: ['speed', 'depth', 'focused'] },
  { id: 'user-segmentation', parent_task_id: 'understand-users', candidate_profiles: ['speed', 'depth', 'focused', 'breadth', 'mixed_method'] },
  { id: 'user-journey-insight', parent_task_id: 'understand-users', candidate_profiles: ['speed', 'depth', 'focused', 'mixed_method'] },
  { id: 'experience-walkthrough', parent_task_id: 'find-problems', candidate_profiles: ['speed', 'depth', 'remediation', 'focused', 'breadth'] },
  { id: 'feedback-issue-clustering', parent_task_id: 'find-problems', candidate_profiles: ['speed', 'depth', 'decision'] },
  { id: 'data-behavior-diagnosis', parent_task_id: 'find-problems', candidate_profiles: ['speed', 'depth', 'focused', 'mixed_method', 'decision'] },
  { id: 'root-cause-analysis', parent_task_id: 'solve-problems', candidate_profiles: ['speed', 'depth', 'focused', 'mixed_method'] },
  { id: 'solution-generation', parent_task_id: 'solve-problems', candidate_profiles: ['speed', 'depth', 'breadth', 'decision'] },
  { id: 'solution-comparison', parent_task_id: 'solve-problems', candidate_profiles: ['speed', 'depth', 'decision', 'focused'] },
  { id: 'strategy-synthesis', parent_task_id: 'define-strategy', candidate_profiles: ['speed', 'depth', 'decision'] },
  { id: 'priority-roadmap', parent_task_id: 'define-strategy', candidate_profiles: ['speed', 'depth', 'decision', 'focused'] },
  { id: 'metrics-validation', parent_task_id: 'define-strategy', candidate_profiles: ['speed', 'depth', 'mixed_method', 'decision', 'focused'] },
];

const SCENARIO_SIGNAL_PATHS = [
  'raw_input',
  'task.research_goal',
  'task.scope',
  'task.success_criteria',
  'task.expected_deliverables',
] as const satisfies readonly GuidanceSourcePath[];
const PROFILE_SIGNAL_PATHS = [
  'raw_input',
  'task.research_goal',
  'task.target_audience',
  'task.scope',
  'task.constraints',
  'task.success_criteria',
  'task.expected_deliverables',
] as const satisfies readonly GuidanceSourcePath[];

const SIGNALS: readonly SignalDefinition[] = [
  { id: 'scenario.trend-change', scenario_id: 'trend-change-identification', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['趋势与变化识别', '趋势变化', '趋势扫描', '市场趋势', '变化识别', 'trend scan'] },
  { id: 'scenario.competitor-benchmark', scenario_id: 'competitor-benchmark-research', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['竞品与标杆研究', '竞品研究', '竞品分析', '标杆研究', 'competitive research', 'benchmark research'] },
  { id: 'scenario.opportunity-direction', scenario_id: 'opportunity-direction-evaluation', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['机会方向判断', '机会方向评估', '机会评估', '方向判断', '机会点判断'] },
  { id: 'scenario.user-material', scenario_id: 'user-material-synthesis', kind: 'scenario', source_paths: [...SCENARIO_SIGNAL_PATHS, 'available_material_roles'], terms: ['已有用户资料归纳', '用户资料归纳', '整理访谈资料', '归纳已有资料', '访谈记录归纳', 'interview transcript synthesis'] },
  { id: 'scenario.user-segmentation', scenario_id: 'user-segmentation', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['用户分层', '重点人群识别', '人群分层', '用户分群', '细分人群'] },
  { id: 'scenario.user-journey', scenario_id: 'user-journey-insight', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['用户旅程与需求洞察', '用户旅程', '旅程洞察', '需求洞察'] },
  { id: 'scenario.experience-walkthrough', scenario_id: 'experience-walkthrough', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['页面与链路体验走查', '体验走查', '页面走查', '链路走查', 'experience walkthrough'] },
  { id: 'scenario.feedback-clustering', scenario_id: 'feedback-issue-clustering', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['用户反馈问题聚类', '反馈问题聚类', '反馈聚类', '工单聚类', '评论聚类'] },
  { id: 'scenario.data-diagnosis', scenario_id: 'data-behavior-diagnosis', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['数据与行为异常诊断', '行为异常诊断', '数据异常诊断', '漏斗异常', '行为数据诊断'] },
  { id: 'scenario.root-cause', scenario_id: 'root-cause-analysis', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['问题根因拆解', '根因拆解', '根因分析', '原因拆解', 'root cause'] },
  { id: 'scenario.solution-generation', scenario_id: 'solution-generation', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['解决方案生成', '方案生成', '生成解决方案', '设计方案创意'] },
  { id: 'scenario.solution-comparison', scenario_id: 'solution-comparison', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['方案比较与风险评估', '方案比较', '方案对比', '方案风险评估'] },
  { id: 'scenario.strategy-synthesis', scenario_id: 'strategy-synthesis', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['结论整合与策略提炼', '策略提炼', '结论整合', '洞察整合'] },
  { id: 'scenario.priority-roadmap', scenario_id: 'priority-roadmap', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['优先级与实施路径', '实施路径', '产品优先级', '下一季度优先级', '优先级建议', '实施路线图'] },
  { id: 'scenario.metrics-validation', scenario_id: 'metrics-validation', kind: 'scenario', source_paths: SCENARIO_SIGNAL_PATHS, terms: ['指标与验证计划', '验证计划', '验证指标', '成功指标', '指标设计'] },
  { id: 'task-type.competitive-research', task_type: 'competitive_research', kind: 'task_type', source_paths: ['task.task_type'], terms: ['competitive_research'] },
  { id: 'task-type.user-research-planning', task_type: 'user_research_planning', kind: 'task_type', source_paths: ['task.task_type'], terms: ['user_research_planning'] },
  { id: 'task-type.voc-diagnosis', task_type: 'voc_diagnosis', kind: 'task_type', source_paths: ['task.task_type'], terms: ['voc_diagnosis'] },
  { id: 'task-type.design-audit', task_type: 'design_audit', kind: 'task_type', source_paths: ['task.task_type'], terms: ['design_audit'] },
  { id: 'task-type.a11y-audit', task_type: 'a11y_audit', kind: 'task_type', source_paths: ['task.task_type'], terms: ['a11y_audit'] },
  { id: 'profile.speed.explicit', profile_id: 'speed', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['快速判断', '速度优先', '尽快给出', '快速方案', 'time-boxed'] },
  { id: 'profile.depth.explicit', profile_id: 'depth', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['深度研究', '深入研究', '深挖方案', '证据深度优先'] },
  { id: 'profile.breadth.scope-units', profile_id: 'breadth', kind: 'profile_content', source_paths: PROFILE_SIGNAL_PATHS, terms: ['多个竞品', '多个人群', '多个场景', '多个触点', '全部平台', '覆盖矩阵'] },
  { id: 'profile.breadth.explicit', profile_id: 'breadth', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['广度优先', '广度扫描', '全景扫描', '扩大覆盖'] },
  { id: 'profile.focused.named-focus', profile_id: 'focused', kind: 'profile_content', source_paths: PROFILE_SIGNAL_PATHS, terms: ['关键人群', '关键触点', '关键链路', '关键问题', '重点人群'] },
  { id: 'profile.focused.explicit', profile_id: 'focused', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['聚焦研究', '聚焦方案', '收窄范围', '聚焦关键'] },
  { id: 'profile.mixed-method.explicit', profile_id: 'mixed_method', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['混合方法', '定性+定量', '定性与定量', '多方法验证', '两类独立证据'] },
  { id: 'profile.decision.deliverable', profile_id: 'decision', kind: 'profile_content', source_paths: PROFILE_SIGNAL_PATHS, terms: ['比较取舍', '决策建议', '产品优先级', '优先级建议', '实施路径', '路线图'] },
  { id: 'profile.decision.explicit', profile_id: 'decision', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['决策收敛', '决策优先', '以决策为主'] },
  { id: 'profile.remediation.closed-loop', profile_id: 'remediation', kind: 'profile_content', source_paths: PROFILE_SIGNAL_PATHS, terms: ['整改动作', '整改复测', '修复后复测', '验收阈值', '问题修复'] },
  { id: 'profile.remediation.explicit', profile_id: 'remediation', kind: 'profile_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['整改复测方案', '复测优先'] },
  { id: 'execution.compare-paths.explicit', kind: 'execution_preference', source_paths: PROFILE_SIGNAL_PATHS, terms: ['比较多种研究方法', '比较多种执行路径', '对比研究方法', '多套研究路径', '比较研究路径'] },
];

const TASK_TYPE_SCENARIOS: Readonly<Record<ResearchTaskV2['task_type'], readonly ScenarioId[]>> = {
  competitive_research: [
    'trend-change-identification',
    'competitor-benchmark-research',
    'opportunity-direction-evaluation',
    'strategy-synthesis',
    'priority-roadmap',
    'metrics-validation',
  ],
  user_research_planning: [
    'user-material-synthesis',
    'user-segmentation',
    'user-journey-insight',
    'root-cause-analysis',
    'metrics-validation',
  ],
  voc_diagnosis: [
    'user-material-synthesis',
    'user-segmentation',
    'feedback-issue-clustering',
    'data-behavior-diagnosis',
    'root-cause-analysis',
    'strategy-synthesis',
    'priority-roadmap',
  ],
  design_audit: [
    'experience-walkthrough',
    'root-cause-analysis',
    'solution-generation',
    'solution-comparison',
    'priority-roadmap',
    'metrics-validation',
  ],
  a11y_audit: [
    'experience-walkthrough',
    'root-cause-analysis',
    'solution-generation',
    'priority-roadmap',
    'metrics-validation',
  ],
};

const RATIONALE_CODES = new Set<ScenarioClassifierResult['rationale_codes'][number]>([
  'explicit_goal_match',
  'deliverable_match',
  'material_match',
  'scope_match',
  'task_type_context',
  'semantic_disambiguation',
]);
const RELATIONSHIPS = new Set<ScenarioRelationship>(['serial', 'parallel', 'conditional']);
const CONFIDENCES = new Set<GuidanceConfidence>(['high', 'medium', 'low']);
const SCENARIO_BY_ID = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));
const SIGNAL_BY_ID = new Map(SIGNALS.map((signal) => [signal.id, signal]));
const PROFILE_BY_ID = new Map(PROFILE_SPECS.map((profile) => [profile.id, profile]));

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, child]) => [key, canonicalValue(child)]));
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')}`;
}

const SCENARIO_CATALOG_HASH = canonicalHash({
  version: SCENARIO_MAPPING_VERSION,
  scenarios: SCENARIOS.map(({ id, parent_task_id }) => ({ id, parent_task_id })),
});
const SIGNAL_CATALOG_HASH = canonicalHash({ version: SIGNAL_CATALOG_VERSION, signals: SIGNALS });
const PROFILE_SPEC_HASH = canonicalHash({ version: PROFILE_SPEC_VERSION, profiles: PROFILE_SPECS });
const SCENARIO_MAPPING_HASH = canonicalHash({
  version: SCENARIO_MAPPING_VERSION,
  mappings: SCENARIOS.map(({ id, candidate_profiles }) => ({ scenario_id: id, candidate_profiles })),
});

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function sourceValues(request: PlanningGuidanceRequest): ReadonlyMap<GuidanceSourcePath, readonly string[]> {
  return new Map<GuidanceSourcePath, readonly string[]>([
    ['raw_input', [request.raw_input]],
    ['task.task_type', [request.task.task_type]],
    ['task.research_goal', [request.task.research_goal]],
    ['task.target_audience', request.task.target_audience],
    ['task.scope', request.task.scope],
    ['task.constraints', request.task.constraints.filter(({ source }) => source === 'user').map(({ statement }) => statement)],
    ['task.success_criteria', request.task.success_criteria.map(({ statement }) => statement)],
    ['task.expected_deliverables', request.task.expected_deliverables],
    ['available_material_roles', request.available_material_roles],
  ]);
}

function recognizeSignals(request: PlanningGuidanceRequest): ControlledSignalRef[] {
  const values = sourceValues(request);
  const hits: ControlledSignalRef[] = [];
  for (const signal of SIGNALS) {
    for (const sourcePath of signal.source_paths) {
      const normalizedValues = (values.get(sourcePath) ?? []).map(normalized);
      if (!signal.terms.some((term) => normalizedValues.some((value) => value.includes(normalized(term))))) continue;
      hits.push({ signal_id: signal.id, source_path: sourcePath });
    }
  }
  return hits.sort((left, right) => (
    left.signal_id.localeCompare(right.signal_id, 'en')
    || left.source_path.localeCompare(right.source_path, 'en')
  ));
}

function scenarioCandidatesFromSignals(signals: readonly ControlledSignalRef[]): ScenarioId[] {
  const found = new Set<ScenarioId>();
  for (const { signal_id } of signals) {
    const scenarioId = SIGNAL_BY_ID.get(signal_id)?.scenario_id;
    if (scenarioId) found.add(scenarioId);
  }
  return SCENARIOS.map(({ id }) => id).filter((id) => found.has(id));
}

function relevantScenarioSignals(
  signals: readonly ControlledSignalRef[],
  scenarioIds: readonly ScenarioId[],
): ControlledSignalRef[] {
  const allowed = new Set(scenarioIds);
  return signals.filter(({ signal_id }) => {
    const signal = SIGNAL_BY_ID.get(signal_id);
    return signal?.kind === 'task_type' || (signal?.scenario_id !== undefined && allowed.has(signal.scenario_id));
  });
}

function sameProfileSet(scenarioIds: readonly ScenarioId[]): boolean {
  const signatures = scenarioIds.map((scenarioId) => {
    const profiles = SCENARIO_BY_ID.get(scenarioId)?.candidate_profiles ?? [];
    return [...profiles].sort().join('|');
  });
  return new Set(signatures).size <= 1;
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function asClassifierResult(value: unknown): ScenarioClassifierResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!hasExactKeys(value, [
    'primary_scenario_id',
    'secondary_scenarios',
    'confidence',
    'signals',
    'rationale_codes',
  ])) return null;
  const candidate = value as Partial<ScenarioClassifierResult>;
  if (
    typeof candidate.primary_scenario_id !== 'string'
    || !SCENARIO_BY_ID.has(candidate.primary_scenario_id as ScenarioId)
    || !Array.isArray(candidate.secondary_scenarios)
    || !CONFIDENCES.has(candidate.confidence as GuidanceConfidence)
    || !Array.isArray(candidate.signals)
    || candidate.signals.length < 1
    || !Array.isArray(candidate.rationale_codes)
    || candidate.rationale_codes.length < 1
  ) return null;
  const secondaryIds = new Set<string>();
  for (const secondary of candidate.secondary_scenarios) {
    if (
      !secondary
      || typeof secondary !== 'object'
      || !hasExactKeys(secondary, ['scenario_id', 'relationship'])
      || typeof secondary.scenario_id !== 'string'
      || !SCENARIO_BY_ID.has(secondary.scenario_id as ScenarioId)
      || secondary.scenario_id === candidate.primary_scenario_id
      || secondaryIds.has(secondary.scenario_id)
      || !RELATIONSHIPS.has(secondary.relationship as ScenarioRelationship)
    ) return null;
    secondaryIds.add(secondary.scenario_id);
  }
  if (secondaryIds.size > 2) return null;
  const signalRefs = new Set<string>();
  for (const signal of candidate.signals) {
    if (
      !signal
      || typeof signal !== 'object'
      || !hasExactKeys(signal, ['signal_id', 'source_path'])
      || typeof signal.signal_id !== 'string'
      || !SIGNAL_BY_ID.has(signal.signal_id)
      || typeof signal.source_path !== 'string'
      || signalRefs.has(`${signal.signal_id}\u0000${signal.source_path}`)
    ) return null;
    signalRefs.add(`${signal.signal_id}\u0000${signal.source_path}`);
  }
  if (
    !candidate.rationale_codes.every((code) => RATIONALE_CODES.has(code))
    || new Set(candidate.rationale_codes).size !== candidate.rationale_codes.length
  ) return null;
  return candidate as ScenarioClassifierResult;
}

function validateClassifierResult(
  result: ScenarioClassifierResult,
  allowedScenarioIds: readonly ScenarioId[],
  observedSignals: readonly ControlledSignalRef[],
): boolean {
  const allowed = new Set(allowedScenarioIds);
  if (!allowed.has(result.primary_scenario_id)) return false;
  if (result.secondary_scenarios.some(({ scenario_id }) => !allowed.has(scenario_id))) return false;
  const observed = new Set(observedSignals.map(({ signal_id, source_path }) => `${signal_id}\u0000${source_path}`));
  return result.signals.every(({ signal_id, source_path }) => {
    const definition = SIGNAL_BY_ID.get(signal_id);
    return definition?.source_paths.includes(source_path) === true
      && observed.has(`${signal_id}\u0000${source_path}`);
  });
}

function profileSignalRefs(
  signals: readonly ControlledSignalRef[],
  profileId: CandidateProfileId,
): ControlledSignalRef[] {
  return signals.filter(({ signal_id }) => SIGNAL_BY_ID.get(signal_id)?.profile_id === profileId);
}

function activeEligibleCapabilities(
  capabilities: readonly PlanningGuidanceCapability[],
): PlanningGuidanceCapability[] {
  return capabilities.filter((capability) => (
    capability.lifecycle_status === 'active' && capability.resolution_status === 'eligible'
  ));
}

function capabilitySupportsProfile(
  profileId: Exclude<CandidateProfileId, 'speed' | 'depth'>,
  capabilities: readonly PlanningGuidanceCapability[],
): boolean {
  const supporting = capabilities.filter(({ profile_support }) => profile_support.includes(profileId));
  if (profileId === 'breadth') return supporting.some(({ roles }) => roles.includes('scope_expansion'));
  if (profileId === 'focused') return supporting.some(({ roles }) => roles.includes('focused_analysis'));
  if (profileId === 'decision') return supporting.some(({ roles }) => roles.includes('decision_support'));
  if (profileId === 'mixed_method') {
    const methodFamilies = new Set(supporting
      .filter(({ roles }) => roles.includes('independent_method'))
      .map(({ method_family }) => method_family)
      .filter((family): family is string => typeof family === 'string' && family.length > 0));
    return methodFamilies.size >= 2;
  }
  const roles = new Set(supporting.flatMap((capability) => capability.roles));
  return roles.has('issue_identification') && roles.has('retest');
}

function specialtyMapped(
  profileId: CandidateProfileId,
  primaryScenarioId: ScenarioId,
  secondaryScenarioIds: readonly ScenarioId[],
  signals: readonly ControlledSignalRef[],
): boolean {
  const primaryMapping = SCENARIO_BY_ID.get(primaryScenarioId)?.candidate_profiles ?? [];
  if (primaryMapping.includes(profileId)) return true;
  const directlyRequestedDeliverable = profileSignalRefs(signals, profileId)
    .some(({ source_path }) => source_path === 'task.expected_deliverables');
  return directlyRequestedDeliverable && secondaryScenarioIds.some((scenarioId) => (
    SCENARIO_BY_ID.get(scenarioId)?.candidate_profiles.includes(profileId) === true
  ));
}

interface SpecialtyRank {
  id: Exclude<CandidateProfileId, 'speed' | 'depth'>;
  explicitPreference: boolean;
  directDeliverable: boolean;
  scenarioCount: number;
  primaryIndex: number;
  secondaryIndex: number;
  ordinal: number;
}

function specialtyRank(
  profileId: SpecialtyRank['id'],
  primaryScenarioId: ScenarioId,
  secondaryScenarioIds: readonly ScenarioId[],
  signals: readonly ControlledSignalRef[],
): SpecialtyRank {
  const refs = profileSignalRefs(signals, profileId);
  const primaryProfiles = SCENARIO_BY_ID.get(primaryScenarioId)?.candidate_profiles ?? [];
  const secondaryIndexes = secondaryScenarioIds
    .map((scenarioId) => SCENARIO_BY_ID.get(scenarioId)?.candidate_profiles.indexOf(profileId) ?? -1)
    .filter((index) => index >= 0);
  return {
    id: profileId,
    explicitPreference: refs.some(({ signal_id }) => SIGNAL_BY_ID.get(signal_id)?.kind === 'profile_preference'),
    directDeliverable: refs.some(({ source_path }) => source_path === 'task.expected_deliverables'),
    scenarioCount: Number(primaryProfiles.includes(profileId)) + secondaryIndexes.length,
    primaryIndex: primaryProfiles.includes(profileId)
      ? primaryProfiles.indexOf(profileId)
      : Number.POSITIVE_INFINITY,
    secondaryIndex: secondaryIndexes.length > 0 ? Math.min(...secondaryIndexes) : Number.POSITIVE_INFINITY,
    ordinal: PROFILE_BY_ID.get(profileId)?.ordinal ?? Number.POSITIVE_INFINITY,
  };
}

function compareSpecialtyRank(left: SpecialtyRank, right: SpecialtyRank): number {
  return Number(right.explicitPreference) - Number(left.explicitPreference)
    || Number(right.directDeliverable) - Number(left.directDeliverable)
    || right.scenarioCount - left.scenarioCount
    || left.primaryIndex - right.primaryIndex
    || left.secondaryIndex - right.secondaryIndex
    || left.ordinal - right.ordinal;
}

function recommendedProfile(
  selected: readonly CandidateProfileId[],
  signals: readonly ControlledSignalRef[],
): CandidateProfileId {
  const explicitOrder: CandidateProfileId[] = [
    'speed', 'depth', 'remediation', 'decision', 'mixed_method', 'breadth', 'focused',
  ];
  for (const profileId of explicitOrder) {
    if (
      selected.includes(profileId)
      && profileSignalRefs(signals, profileId).some(({ signal_id }) => (
        SIGNAL_BY_ID.get(signal_id)?.kind === 'profile_preference'
      ))
    ) return profileId;
  }
  for (const profileId of ['remediation', 'decision', 'mixed_method', 'breadth', 'focused'] as const) {
    if (selected.includes(profileId) && profileSignalRefs(signals, profileId).length > 0) return profileId;
  }
  return 'depth';
}

function resolvedProfiles(
  ids: readonly CandidateProfileId[],
  recommended: CandidateProfileId,
): ResolvedProfileSpec[] {
  const selected = new Set(ids);
  return PROFILE_SPECS
    .filter(({ id }) => selected.has(id))
    .map((profile) => ({
      ...structuredClone(profile),
      coverage_invariant_ids: [...COVERAGE_INVARIANT_IDS],
      recommended: profile.id === recommended,
    }));
}

function resolveProfiles(input: {
  request: PlanningGuidanceRequest;
  primaryScenarioId: ScenarioId;
  secondaryScenarioIds: ScenarioId[];
  signals: ControlledSignalRef[];
}): { profiles: ResolvedProfileSpec[]; degradations: PlanningGuidanceDegradation[] } {
  const mode = input.request.candidate_generation_mode ?? 'fixed';
  if (mode === 'fixed') {
    return {
      profiles: resolvedProfiles(['speed', 'depth'], recommendedProfile(['speed', 'depth'], input.signals)),
      degradations: [{ code: 'dynamic_generation_disabled' }],
    };
  }

  const activeCapabilities = activeEligibleCapabilities(input.request.capabilities);
  const specialtyIds = PROFILE_SPECS
    .filter((profile): profile is ProfileSpecDefinition & { id: SpecialtyRank['id'] } => profile.kind === 'specialty')
    .map(({ id }) => id);
  const qualified: SpecialtyRank[] = [];
  const degradations: PlanningGuidanceDegradation[] = [];
  for (const profileId of specialtyIds) {
    if (!specialtyMapped(
      profileId,
      input.primaryScenarioId,
      input.secondaryScenarioIds,
      input.signals,
    )) continue;
    if (profileSignalRefs(input.signals, profileId).length === 0) continue;
    if (!capabilitySupportsProfile(profileId, activeCapabilities)) {
      degradations.push({ code: 'specialty_capability_unavailable', profile_id: profileId });
      continue;
    }
    qualified.push(specialtyRank(
      profileId,
      input.primaryScenarioId,
      input.secondaryScenarioIds,
      input.signals,
    ));
  }
  qualified.sort(compareSpecialtyRank);
  const comparePaths = input.signals.some(({ signal_id }) => signal_id === 'execution.compare-paths.explicit');
  const specialtyLimit = comparePaths ? 2 : 1;
  const selected = [
    'speed',
    'depth',
    ...qualified.slice(0, specialtyLimit).map(({ id }) => id),
  ] as CandidateProfileId[];
  const recommended = recommendedProfile(selected, input.signals);
  return { profiles: resolvedProfiles(selected, recommended), degradations };
}

function provenance(input: {
  method: PlanningGuidanceProvenance['classification_method'];
  classifierCalls: 0 | 1;
  primaryScenarioId: ScenarioId | null;
  secondaryScenarioIds: ScenarioId[];
  confidence: GuidanceConfidence | null;
  signals: ControlledSignalRef[];
  profiles: ResolvedProfileSpec[];
  degradations: PlanningGuidanceDegradation[];
}): PlanningGuidanceProvenance {
  return {
    version: 'planning-guidance-provenance-v1',
    resolver_version: 'candidate-profile-resolver-v1',
    scenario_catalog_hash: SCENARIO_CATALOG_HASH,
    signal_catalog_hash: SIGNAL_CATALOG_HASH,
    profile_spec_hash: PROFILE_SPEC_HASH,
    scenario_mapping_hash: SCENARIO_MAPPING_HASH,
    classification_method: input.method,
    classifier_call_count: input.classifierCalls,
    primary_scenario_id: input.primaryScenarioId,
    secondary_scenario_ids: [...input.secondaryScenarioIds],
    confidence: input.confidence,
    signals: structuredClone(input.signals),
    selected_profile_ids: input.profiles.map(({ id }) => id),
    degradations: structuredClone(input.degradations),
  };
}

function unresolvedResult(input: {
  reason: NonNullable<PlanningGuidanceResult['clarification']>['reason_code'];
  candidateScenarioIds: ScenarioId[];
  classifierCalls: 0 | 1;
  signals: ControlledSignalRef[];
  degradation: GuidanceDegradationCode;
}): PlanningGuidanceResult {
  const degradations: PlanningGuidanceDegradation[] = [{ code: input.degradation }];
  const scenario = {
    primary_scenario_id: null,
    secondary_scenarios: [],
    confidence: null,
    signals: relevantScenarioSignals(input.signals, input.candidateScenarioIds),
    rationale_codes: [] as ScenarioClassifierResult['rationale_codes'],
  };
  return {
    status: 'clarification',
    scenario,
    profiles: [],
    clarification: {
      reason_code: input.reason,
      candidate_scenario_ids: [...input.candidateScenarioIds],
    },
    planning_provenance: provenance({
      method: 'clarification',
      classifierCalls: input.classifierCalls,
      primaryScenarioId: null,
      secondaryScenarioIds: [],
      confidence: null,
      signals: scenario.signals,
      profiles: [],
      degradations,
    }),
  };
}

/**
 * The sole Planning Guidance entry point. It is intentionally not wired to RoutedPlanner in
 * Phase B. Rules, classifier validation, ProfileSpec resolution, and degradation stay behind
 * this boundary so a later production adapter cannot bypass deterministic controls.
 */
export async function resolvePlanningGuidance(
  request: PlanningGuidanceRequest,
  options: PlanningGuidanceOptions = {},
): Promise<PlanningGuidanceResult> {
  const signals = recognizeSignals(request);

  if (request.direct_skill_id) {
    const profiles = resolvedProfiles(['speed', 'depth'], 'depth');
    const degradations: PlanningGuidanceDegradation[] = [{ code: 'direct_skill_bypass' }];
    return {
      status: 'bypassed',
      scenario: {
        primary_scenario_id: null,
        secondary_scenarios: [],
        confidence: null,
        signals: [],
        rationale_codes: [],
      },
      profiles,
      clarification: null,
      planning_provenance: provenance({
        method: 'direct_skill_bypass',
        classifierCalls: 0,
        primaryScenarioId: null,
        secondaryScenarioIds: [],
        confidence: null,
        signals: [],
        profiles,
        degradations,
      }),
    };
  }

  if (
    request.task.blocking_issues.length > 0
    || request.task.ambiguities.some(({ blocking }) => blocking)
  ) {
    return unresolvedResult({
      reason: 'task_blocking_ambiguity',
      candidateScenarioIds: [...TASK_TYPE_SCENARIOS[request.task.task_type]],
      classifierCalls: 0,
      signals,
      degradation: 'task_blocking_ambiguity',
    });
  }

  const ruleCandidates = scenarioCandidatesFromSignals(signals);
  let classification: ScenarioClassifierResult;
  let classificationMethod: PlanningGuidanceProvenance['classification_method'] = 'rule';
  let classifierCalls: 0 | 1 = 0;

  if (ruleCandidates.length === 1) {
    classification = {
      primary_scenario_id: ruleCandidates[0]!,
      secondary_scenarios: [],
      confidence: 'high',
      signals: relevantScenarioSignals(signals, ruleCandidates),
      rationale_codes: ['explicit_goal_match'],
    };
  } else {
    const allowedScenarioIds = ruleCandidates.length > 1
      ? ruleCandidates
      : [...TASK_TYPE_SCENARIOS[request.task.task_type]];
    if (!options.classifier) {
      return unresolvedResult({
        reason: 'classifier_unavailable',
        candidateScenarioIds: allowedScenarioIds,
        classifierCalls,
        signals,
        degradation: 'classifier_unavailable',
      });
    }
    classifierCalls = 1;
    classificationMethod = 'classifier';
    let rawClassification: unknown;
    try {
      rawClassification = await options.classifier({
        schema_name: 'scenario-guidance',
        allowed_scenario_ids: [...allowedScenarioIds],
        observed_signals: relevantScenarioSignals(signals, allowedScenarioIds),
        raw_input: request.raw_input,
        task: {
          task_type: request.task.task_type,
          research_goal: request.task.research_goal,
          target_audience: request.task.target_audience,
          scope: request.task.scope,
          constraints: request.task.constraints,
          success_criteria: request.task.success_criteria,
          expected_deliverables: request.task.expected_deliverables,
        },
        available_material_roles: [...request.available_material_roles],
      });
    } catch {
      return unresolvedResult({
        reason: 'classifier_failed',
        candidateScenarioIds: allowedScenarioIds,
        classifierCalls,
        signals,
        degradation: 'classifier_failed',
      });
    }
    const parsed = asClassifierResult(rawClassification);
    if (!parsed || !validateClassifierResult(parsed, allowedScenarioIds, signals)) {
      return unresolvedResult({
        reason: 'classifier_invalid',
        candidateScenarioIds: allowedScenarioIds,
        classifierCalls,
        signals,
        degradation: 'classifier_invalid',
      });
    }
    if (parsed.confidence === 'low') {
      return unresolvedResult({
        reason: 'low_confidence_classification',
        candidateScenarioIds: allowedScenarioIds,
        classifierCalls,
        signals,
        degradation: 'low_confidence_classification',
      });
    }
    if (parsed.confidence === 'medium' && !sameProfileSet(allowedScenarioIds)) {
      return unresolvedResult({
        reason: 'medium_confidence_profile_conflict',
        candidateScenarioIds: allowedScenarioIds,
        classifierCalls,
        signals,
        degradation: 'medium_confidence_profile_conflict',
      });
    }
    classification = parsed;
  }

  const secondaryScenarioIds = classification.secondary_scenarios.map(({ scenario_id }) => scenario_id);
  const baselineFailures = (['speed', 'depth'] as const)
    .filter((profileId) => !request.baseline_readiness[profileId]);
  if (baselineFailures.length > 0) {
    const degradations = baselineFailures.map((profile_id): PlanningGuidanceDegradation => ({
      code: 'baseline_not_ready',
      profile_id,
    }));
    return {
      status: 'blocked',
      scenario: structuredClone(classification),
      profiles: [],
      clarification: null,
      planning_provenance: provenance({
        method: classificationMethod,
        classifierCalls,
        primaryScenarioId: classification.primary_scenario_id,
        secondaryScenarioIds,
        confidence: classification.confidence,
        signals: [...classification.signals, ...signals.filter(({ signal_id }) => SIGNAL_BY_ID.get(signal_id)?.profile_id)],
        profiles: [],
        degradations,
      }),
    };
  }

  const profileResolution = resolveProfiles({
    request,
    primaryScenarioId: classification.primary_scenario_id,
    secondaryScenarioIds,
    signals,
  });
  const provenanceSignals = [...classification.signals];
  for (const signal of signals) {
    if (!SIGNAL_BY_ID.get(signal.signal_id)?.profile_id && signal.signal_id !== 'execution.compare-paths.explicit') continue;
    if (!provenanceSignals.some((candidate) => (
      candidate.signal_id === signal.signal_id && candidate.source_path === signal.source_path
    ))) provenanceSignals.push(signal);
  }
  provenanceSignals.sort((left, right) => (
    left.signal_id.localeCompare(right.signal_id, 'en')
    || left.source_path.localeCompare(right.source_path, 'en')
  ));

  return {
    status: 'resolved',
    scenario: structuredClone(classification),
    profiles: profileResolution.profiles,
    clarification: null,
    planning_provenance: provenance({
      method: classificationMethod,
      classifierCalls,
      primaryScenarioId: classification.primary_scenario_id,
      secondaryScenarioIds,
      confidence: classification.confidence,
      signals: provenanceSignals,
      profiles: profileResolution.profiles,
      degradations: profileResolution.degradations,
    }),
  };
}
