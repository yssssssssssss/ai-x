import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import {
  resolvePlanningGuidance,
  type CandidateProfileId,
  type PlanningGuidanceCapability,
  type PlanningGuidanceRequest,
  type ScenarioClassifierResult,
  type ScenarioId,
} from '../apps/orchestrator-runtime/src/planners/planning-guidance.ts';

const ROOT = process.cwd();
const CALIBRATION_PATH = join(ROOT, 'tests/fixtures/planning-guidance-calibration.json');
const HOLDOUT_PATH = join(ROOT, 'tests/fixtures/planning-guidance-holdout.json');
const MANIFEST_PATH = join(ROOT, 'tests/fixtures/planning-guidance-dataset-manifest.json');

interface DatasetTask {
  task_type: ResearchTaskV2['task_type'];
  research_goal: string;
  target_audience: string[];
  scope: string[];
  expected_deliverables: string[];
}

interface DatasetExample {
  id: string;
  stratum: 'single_scenario' | 'multi_scenario' | 'clarification' | 'bypass_or_no_match';
  polarity?: 'positive' | 'negative';
  probe_scenario_id?: ScenarioId;
  raw_input: string;
  direct_skill_id?: string;
  task: DatasetTask;
  available_material_roles: string[];
  classifier_response?: ScenarioClassifierResult;
  expected?: {
    status: 'resolved' | 'clarification' | 'bypassed';
    primary_scenario_id?: ScenarioId;
    secondary_scenario_ids?: ScenarioId[];
    clarification_reason?: string;
    classifier_call_count: number;
  };
}

interface DatasetFile {
  version: string;
  split: 'calibration' | 'holdout';
  frozen: boolean;
  labels?: string;
  examples: DatasetExample[];
}

interface DatasetManifest {
  total_count: number;
  splits: {
    calibration: { count: number; file: string; sha256: string };
    holdout: {
      count: number;
      file: string;
      sha256: string;
      expected_labels: string;
      expected_labels_commitment_sha256: string;
    };
  };
  composition: Record<string, Record<string, number>>;
  split_assignment_sha256: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function hashBytes(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, child]) => [key, canonical(child)]));
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function task(input: DatasetTask, overrides: Partial<ResearchTaskV2> = {}): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: input.task_type,
    business_domain: 'planning-guidance-test',
    research_goal: input.research_goal,
    target_audience: input.target_audience,
    scope: input.scope,
    constraints: [],
    success_criteria: [{ id: 'criterion-1', statement: '交付覆盖研究目标' }],
    expected_deliverables: input.expected_deliverables,
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
    ...overrides,
  };
}

function requestFor(
  example: DatasetExample,
  overrides: Partial<PlanningGuidanceRequest> = {},
): PlanningGuidanceRequest {
  return {
    raw_input: example.raw_input,
    task: task(example.task),
    available_material_roles: example.available_material_roles,
    direct_skill_id: example.direct_skill_id,
    baseline_readiness: { speed: true, depth: true },
    capabilities: [],
    ...overrides,
  };
}

function baseRequest(overrides: Partial<PlanningGuidanceRequest> = {}): PlanningGuidanceRequest {
  const input: DatasetTask = {
    task_type: 'competitive_research',
    research_goal: '开展竞品研究',
    target_audience: ['消费者'],
    scope: ['购物助手'],
    expected_deliverables: ['竞品分析'],
  };
  return {
    raw_input: '开展竞品研究',
    task: task(input),
    available_material_roles: [],
    baseline_readiness: { speed: true, depth: true },
    capabilities: [],
    ...overrides,
  };
}

function capability(input: {
  id: string;
  profile: CandidateProfileId;
  roles: PlanningGuidanceCapability['roles'];
  lifecycle?: PlanningGuidanceCapability['lifecycle_status'];
  resolution?: PlanningGuidanceCapability['resolution_status'];
  methodFamily?: string;
}): PlanningGuidanceCapability {
  return {
    id: input.id,
    lifecycle_status: input.lifecycle ?? 'active',
    resolution_status: input.resolution ?? 'eligible',
    profile_support: [input.profile],
    roles: input.roles,
    ...(input.methodFamily ? { method_family: input.methodFamily } : {}),
  };
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

test('the frozen 90-example corpus preserves its 60/30 split, strata, and holdout seal', () => {
  const calibration = readJson<DatasetFile>(CALIBRATION_PATH);
  const holdout = readJson<DatasetFile>(HOLDOUT_PATH);
  const manifest = readJson<DatasetManifest>(MANIFEST_PATH);

  assert.equal(calibration.frozen, true);
  assert.equal(holdout.frozen, true);
  assert.equal(calibration.examples.length, 60);
  assert.equal(holdout.examples.length, 30);
  assert.equal(manifest.total_count, 90);
  assert.equal(hashBytes(CALIBRATION_PATH), manifest.splits.calibration.sha256);
  assert.equal(hashBytes(HOLDOUT_PATH), manifest.splits.holdout.sha256);
  assert.match(manifest.splits.holdout.expected_labels_commitment_sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(manifest.splits.holdout.expected_labels, 'withheld_until_gate_3');
  assert.equal(holdout.labels, 'withheld_until_gate_3');
  assert.ok(holdout.examples.every((example) => example.expected === undefined));
  assert.ok(holdout.examples.every((example) => example.classifier_response === undefined));

  const all = [...calibration.examples, ...holdout.examples];
  assert.equal(new Set(all.map(({ id }) => id)).size, 90);
  assert.deepEqual(countBy(all.map(({ stratum }) => stratum)), {
    single_scenario: 60,
    multi_scenario: 15,
    clarification: 10,
    bypass_or_no_match: 5,
  });
  assert.deepEqual(countBy(calibration.examples
    .filter(({ stratum }) => stratum === 'single_scenario')
    .map(({ polarity }) => polarity!)), { positive: 20, negative: 25 });
  assert.deepEqual(countBy(holdout.examples
    .filter(({ stratum }) => stratum === 'single_scenario')
    .map(({ polarity }) => polarity!)), { positive: 10, negative: 5 });
  assert.ok(holdout.examples
    .filter(({ stratum }) => stratum === 'single_scenario')
    .every(({ probe_scenario_id }) => probe_scenario_id === undefined));
  assert.deepEqual(manifest.composition.single_scenario, {
    total: 60,
    calibration: 45,
    holdout: 15,
    positive: { total: 30, calibration: 20, holdout: 10 },
    negative: { total: 30, calibration: 25, holdout: 5 },
  });

  const assignment = [
    ...calibration.examples.map(({ id }) => ({ id, split: 'calibration' })),
    ...holdout.examples.map(({ id }) => ({ id, split: 'holdout' })),
  ];
  assert.equal(canonicalHash(assignment), manifest.split_assignment_sha256);
});

test('scenario-guidance schema accepts only controlled Scenario, relationship, signal, and path values', () => {
  const schema = readJson<object>(join(ROOT, 'schemas/scenario-guidance.schema.json'));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const valid: ScenarioClassifierResult = {
    primary_scenario_id: 'competitor-benchmark-research',
    secondary_scenarios: [{ scenario_id: 'priority-roadmap', relationship: 'serial' }],
    confidence: 'high',
    signals: [
      { signal_id: 'scenario.competitor-benchmark', source_path: 'raw_input' },
      { signal_id: 'scenario.priority-roadmap', source_path: 'task.expected_deliverables' },
    ],
    rationale_codes: ['explicit_goal_match', 'deliverable_match'],
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  for (const mutate of [
    (value: Record<string, unknown>) => { value.copied_user_input = 'must not be accepted'; },
    (value: Record<string, unknown>) => { value.primary_scenario_id = 'invented-scenario'; },
    (value: Record<string, unknown>) => {
      (value.signals as Array<Record<string, unknown>>)[0]!.source_path = 'task.private_raw_text';
    },
    (value: Record<string, unknown>) => {
      (value.signals as Array<Record<string, unknown>>)[0]!.signal_id = 'free-form-signal';
    },
  ]) {
    const invalid = structuredClone(valid) as unknown as Record<string, unknown>;
    mutate(invalid);
    assert.equal(validate(invalid), false);
  }
});

test('all 45 labeled single-Scenario calibration examples route by unique rules with zero classifier calls', async () => {
  const calibration = readJson<DatasetFile>(CALIBRATION_PATH);
  const examples = calibration.examples.filter(({ stratum }) => stratum === 'single_scenario');
  assert.equal(examples.length, 45);

  for (const example of examples) {
    let calls = 0;
    const result = await resolvePlanningGuidance(requestFor(example), {
      classifier: async () => {
        calls += 1;
        throw new Error('a unique high-confidence rule must not call the classifier');
      },
    });
    assert.equal(result.status, example.expected?.status, example.id);
    assert.equal(result.scenario.primary_scenario_id, example.expected?.primary_scenario_id, example.id);
    assert.equal(result.planning_provenance.classifier_call_count, 0, example.id);
    assert.equal(result.planning_provenance.classification_method, 'rule', example.id);
    assert.equal(calls, 0, example.id);
  }
});

test('multi-Scenario and clarification calibration examples use exactly one classifier call without retry', async () => {
  const calibration = readJson<DatasetFile>(CALIBRATION_PATH);
  const examples = calibration.examples.filter(({ stratum }) => (
    stratum === 'multi_scenario' || stratum === 'clarification'
  ));
  assert.equal(examples.length, 13);

  for (const example of examples) {
    let calls = 0;
    const result = await resolvePlanningGuidance(requestFor(example), {
      classifier: async () => {
        calls += 1;
        return structuredClone(example.classifier_response);
      },
    });
    assert.equal(calls, 1, example.id);
    assert.equal(result.status, example.expected?.status, example.id);
    assert.equal(result.planning_provenance.classifier_call_count, 1, example.id);
    if (example.expected?.primary_scenario_id) {
      assert.equal(result.scenario.primary_scenario_id, example.expected.primary_scenario_id, example.id);
      assert.deepEqual(
        result.scenario.secondary_scenarios.map(({ scenario_id }) => scenario_id),
        example.expected.secondary_scenario_ids,
        example.id,
      );
    } else {
      assert.equal(result.clarification?.reason_code, example.expected?.clarification_reason, example.id);
    }
  }
});

test('direct-Skill bypass and no-match calibration examples degrade deterministically', async () => {
  const calibration = readJson<DatasetFile>(CALIBRATION_PATH);
  const examples = calibration.examples.filter(({ stratum }) => stratum === 'bypass_or_no_match');
  assert.equal(examples.length, 2);

  for (const example of examples) {
    const result = await resolvePlanningGuidance(requestFor(example));
    assert.equal(result.status, example.expected?.status, example.id);
    assert.equal(result.planning_provenance.classifier_call_count, 0, example.id);
    assert.deepEqual(result.profiles.map(({ id }) => id), example.direct_skill_id ? ['speed', 'depth'] : []);
    if (example.direct_skill_id) {
      assert.equal(result.profiles.filter(({ recommended }) => recommended).at(0)?.id, 'depth');
      assert.equal(result.planning_provenance.classification_method, 'direct_skill_bypass');
    } else {
      assert.equal(result.clarification?.reason_code, 'classifier_unavailable');
    }
  }
});

test('medium confidence continues only when every remaining Scenario has the same Profile set', async () => {
  const sameMapping = baseRequest({
    raw_input: '反馈问题聚类与策略提炼的主次需要判断',
    task: task({
      task_type: 'voc_diagnosis',
      research_goal: '反馈问题聚类与策略提炼的主次需要判断',
      target_audience: ['运营团队'],
      scope: ['反馈'],
      expected_deliverables: ['问题簇与策略'],
    }),
  });
  const continued = await resolvePlanningGuidance(sameMapping, {
    classifier: async () => ({
      primary_scenario_id: 'feedback-issue-clustering',
      secondary_scenarios: [{ scenario_id: 'strategy-synthesis', relationship: 'serial' }],
      confidence: 'medium',
      signals: [
        { signal_id: 'scenario.feedback-clustering', source_path: 'raw_input' },
        { signal_id: 'scenario.strategy-synthesis', source_path: 'raw_input' },
      ],
      rationale_codes: ['semantic_disambiguation'],
    }),
  });
  assert.equal(continued.status, 'resolved');
  assert.equal(continued.planning_provenance.classifier_call_count, 1);

  const conflictingMapping = baseRequest({
    raw_input: '竞品研究与机会方向判断的主次需要判断',
    task: task({
      task_type: 'competitive_research',
      research_goal: '竞品研究与机会方向判断的主次需要判断',
      target_audience: ['消费者'],
      scope: ['市场'],
      expected_deliverables: ['竞品结论与机会判断'],
    }),
  });
  const clarified = await resolvePlanningGuidance(conflictingMapping, {
    classifier: async () => ({
      primary_scenario_id: 'competitor-benchmark-research',
      secondary_scenarios: [{ scenario_id: 'opportunity-direction-evaluation', relationship: 'conditional' }],
      confidence: 'medium',
      signals: [
        { signal_id: 'scenario.competitor-benchmark', source_path: 'raw_input' },
        { signal_id: 'scenario.opportunity-direction', source_path: 'raw_input' },
      ],
      rationale_codes: ['semantic_disambiguation'],
    }),
  });
  assert.equal(clarified.status, 'clarification');
  assert.equal(clarified.clarification?.reason_code, 'medium_confidence_profile_conflict');
  assert.deepEqual(clarified.profiles, []);
});

test('invalid or failed classifiers are never retried and cannot invent input evidence', async () => {
  const ambiguous = baseRequest({
    raw_input: '竞品研究与机会方向判断的主次需要判断',
    task: task({
      task_type: 'competitive_research',
      research_goal: '竞品研究与机会方向判断的主次需要判断',
      target_audience: ['消费者'],
      scope: ['市场'],
      expected_deliverables: ['研究结论'],
    }),
  });
  let invalidCalls = 0;
  const invalid = await resolvePlanningGuidance(ambiguous, {
    classifier: async () => {
      invalidCalls += 1;
      return {
        primary_scenario_id: 'competitor-benchmark-research',
        secondary_scenarios: [],
        confidence: 'high',
        signals: [{ signal_id: 'scenario.competitor-benchmark', source_path: 'task.scope' }],
        rationale_codes: ['semantic_disambiguation'],
      };
    },
  });
  assert.equal(invalidCalls, 1);
  assert.equal(invalid.status, 'clarification');
  assert.equal(invalid.clarification?.reason_code, 'classifier_invalid');

  let failedCalls = 0;
  const failed = await resolvePlanningGuidance(ambiguous, {
    classifier: async () => {
      failedCalls += 1;
      throw new Error('provider unavailable');
    },
  });
  assert.equal(failedCalls, 1);
  assert.equal(failed.clarification?.reason_code, 'classifier_failed');
  assert.equal(failed.planning_provenance.classifier_call_count, 1);
});

test('fixed mode stays at the two baselines while dynamic mode selects deterministic supported specialties', async () => {
  const capabilities = [
    capability({ id: 'coverage-scan', profile: 'breadth', roles: ['scope_expansion'] }),
    capability({ id: 'decision-analysis', profile: 'decision', roles: ['decision_support'] }),
  ];
  const input = baseRequest({
    raw_input: '开展竞品研究',
    task: task({
      task_type: 'competitive_research',
      research_goal: '开展竞品研究',
      target_audience: ['消费者'],
      scope: ['多个竞品'],
      expected_deliverables: ['多个竞品覆盖矩阵', '决策建议', '比较多种执行路径'],
    }),
    capabilities,
  });

  const fixed = await resolvePlanningGuidance(input);
  assert.deepEqual(fixed.profiles.map(({ id }) => id), ['speed', 'depth']);
  assert.equal(fixed.profiles.filter(({ recommended }) => recommended).length, 1);
  assert.equal(fixed.planning_provenance.degradations.at(0)?.code, 'dynamic_generation_disabled');

  const dynamic = await resolvePlanningGuidance({ ...input, candidate_generation_mode: 'dynamic' });
  assert.deepEqual(dynamic.profiles.map(({ id }) => id), ['speed', 'depth', 'breadth', 'decision']);
  assert.equal(dynamic.profiles.filter(({ recommended }) => recommended).at(0)?.id, 'decision');
  assert.ok(dynamic.profiles.every(({ coverage_invariant_ids }) => (
    coverage_invariant_ids.includes('all_required_questions')
    && coverage_invariant_ids.includes('all_required_evidence')
    && coverage_invariant_ids.includes('all_requested_deliverables')
  )));

  const withoutPathComparison = await resolvePlanningGuidance({
    ...input,
    candidate_generation_mode: 'dynamic',
    task: {
      ...input.task,
      expected_deliverables: ['多个竞品覆盖矩阵', '决策建议'],
    },
  });
  assert.deepEqual(withoutPathComparison.profiles.map(({ id }) => id), ['speed', 'depth', 'breadth']);
});

test('focused ProfileSpec is selected only with a traceable focus signal and active support', async () => {
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '完成机会方向判断，并采用聚焦方案研究关键人群',
    task: task({
      task_type: 'competitive_research',
      research_goal: '完成机会方向判断，并采用聚焦方案研究关键人群',
      target_audience: ['关键人群'],
      scope: ['重点机会'],
      expected_deliverables: ['机会判断'],
    }),
    candidate_generation_mode: 'dynamic',
    capabilities: [
      capability({ id: 'focused-analysis', profile: 'focused', roles: ['focused_analysis'] }),
    ],
  }));

  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth', 'focused']);
  const focused = result.profiles.find(({ id }) => id === 'focused');
  assert.equal(focused?.max_steps, 6);
  assert.deepEqual(focused?.required_difference_dimensions, ['scope', 'evidence', 'output_emphasis']);
  assert.equal(focused?.recommended, true);
});

test('dynamic mode never treats draft, planned, deprecated, or rejected capabilities as eligible', async () => {
  const input = baseRequest({
    raw_input: '开展竞品研究',
    task: task({
      task_type: 'competitive_research',
      research_goal: '开展竞品研究',
      target_audience: ['消费者'],
      scope: ['多个竞品'],
      expected_deliverables: ['多个竞品覆盖矩阵', '决策建议', '比较多种执行路径'],
    }),
    candidate_generation_mode: 'dynamic',
    capabilities: [
      capability({ id: 'active-breadth', profile: 'breadth', roles: ['scope_expansion'] }),
      capability({ id: 'draft-decision', profile: 'decision', roles: ['decision_support'], lifecycle: 'draft' }),
      capability({ id: 'planned-decision', profile: 'decision', roles: ['decision_support'], lifecycle: 'planned' }),
      capability({ id: 'deprecated-decision', profile: 'decision', roles: ['decision_support'], lifecycle: 'deprecated' }),
      capability({ id: 'rejected-decision', profile: 'decision', roles: ['decision_support'], resolution: 'rejected' }),
    ],
  });

  const result = await resolvePlanningGuidance(input);
  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth', 'breadth']);
  assert.deepEqual(result.planning_provenance.degradations, [
    { code: 'specialty_capability_unavailable', profile_id: 'decision' },
  ]);
});

test('mixed-method and remediation profiles require their complete active capability conditions', async () => {
  const mixedRequest = baseRequest({
    raw_input: '开展用户分层并使用混合方法完成定性与定量验证',
    task: task({
      task_type: 'user_research_planning',
      research_goal: '开展用户分层并使用混合方法完成定性与定量验证',
      target_audience: ['用户'],
      scope: ['重点人群'],
      expected_deliverables: ['用户分层'],
    }),
    candidate_generation_mode: 'dynamic',
    capabilities: [
      capability({ id: 'interview', profile: 'mixed_method', roles: ['independent_method'], methodFamily: 'qualitative' }),
      capability({ id: 'survey', profile: 'mixed_method', roles: ['independent_method'], methodFamily: 'quantitative' }),
    ],
  });
  const mixed = await resolvePlanningGuidance(mixedRequest);
  assert.deepEqual(mixed.profiles.map(({ id }) => id), ['speed', 'depth', 'mixed_method']);

  const incompleteMixed = await resolvePlanningGuidance({
    ...mixedRequest,
    capabilities: [
      mixedRequest.capabilities[0]!,
      { ...mixedRequest.capabilities[1]!, lifecycle_status: 'planned' },
    ],
  });
  assert.deepEqual(incompleteMixed.profiles.map(({ id }) => id), ['speed', 'depth']);

  const remediationRequest = baseRequest({
    raw_input: '执行体验走查并给出整改动作和修复后复测',
    task: task({
      task_type: 'design_audit',
      research_goal: '执行体验走查并形成整改复测闭环',
      target_audience: ['消费者'],
      scope: ['关键链路'],
      expected_deliverables: ['整改动作', '复测计划'],
    }),
    candidate_generation_mode: 'dynamic',
    capabilities: [
      capability({ id: 'audit', profile: 'remediation', roles: ['issue_identification'] }),
      capability({ id: 'retest', profile: 'remediation', roles: ['retest'] }),
    ],
  });
  const remediation = await resolvePlanningGuidance(remediationRequest);
  assert.deepEqual(remediation.profiles.map(({ id }) => id), ['speed', 'depth', 'remediation']);
  assert.equal(remediation.profiles.find(({ id }) => id === 'remediation')?.max_steps, 7);
});

test('baseline readiness fails closed and provenance contains hashes and controlled references, not full user input', async () => {
  const sentinel = 'FULL-USER-INPUT-MUST-NOT-BE-COPIED-9f5b4ef7';
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: `${sentinel} 竞品研究`,
    baseline_readiness: { speed: false, depth: true },
  }));

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.profiles, []);
  assert.deepEqual(result.planning_provenance.degradations, [
    { code: 'baseline_not_ready', profile_id: 'speed' },
  ]);
  for (const hash of [
    result.planning_provenance.scenario_catalog_hash,
    result.planning_provenance.signal_catalog_hash,
    result.planning_provenance.profile_spec_hash,
    result.planning_provenance.scenario_mapping_hash,
  ]) assert.match(hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.ok(result.planning_provenance.signals.every(({ signal_id, source_path }) => (
    signal_id.length > 0 && source_path.length > 0
  )));
});

test('planning-guidance module exposes one runtime interface and is not connected to RoutedPlanner', async () => {
  const module = await import('../apps/orchestrator-runtime/src/planners/planning-guidance.ts');
  assert.deepEqual(Object.keys(module), ['resolvePlanningGuidance']);
  const routedPlannerSource = readFileSync(
    join(ROOT, 'apps/orchestrator-runtime/src/planners/routed-planner.ts'),
    'utf8',
  );
  assert.equal(routedPlannerSource.includes('planning-guidance'), false);
  assert.equal(routedPlannerSource.includes('resolvePlanningGuidance'), false);
});
