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
const DYNAMIC_POLICY = { candidate_generation_mode: 'dynamic', gate_3_activation_required: true } as const;
const DYNAMIC_OPTIONS = { policy: DYNAMIC_POLICY };

interface DatasetTask {
  task_type: ResearchTaskV2['task_type'];
  research_goal: string;
  target_audience: string[];
  scope: string[];
  expected_deliverables: string[];
}

interface DatasetExample {
  id: string;
  stratum?: 'single_scenario' | 'multi_scenario' | 'clarification' | 'bypass_or_no_match';
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
    evidence_paths: [input.methodFamily ?? 'knowledge_method'],
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
  assert.ok(holdout.examples.every((example) => /^h-[a-f0-9]{16}$/u.test(example.id)));
  assert.ok(holdout.examples.every((example) => (
    example.stratum === undefined && example.polarity === undefined && example.probe_scenario_id === undefined
  )));
  const normalizedCalibrationInputs = new Set(calibration.examples.map(({ raw_input }) => raw_input.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()));
  assert.ok(holdout.examples.every(({ raw_input }) => !normalizedCalibrationInputs.has(raw_input.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim())));

  const all = [...calibration.examples, ...holdout.examples];
  assert.equal(new Set(all.map(({ id }) => id)).size, 90);
  assert.deepEqual(countBy(calibration.examples.map(({ stratum }) => stratum!)), {
    single_scenario: 45,
    multi_scenario: 8,
    clarification: 5,
    bypass_or_no_match: 2,
  });
  assert.deepEqual(countBy(calibration.examples
    .filter(({ stratum }) => stratum === 'single_scenario')
    .map(({ polarity }) => polarity!)), { positive: 20, negative: 25 });
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
    assert.deepEqual(result.profiles.map(({ id }) => id), example.direct_skill_id ? ['depth', 'speed'] : []);
    if (example.direct_skill_id) {
      assert.equal(result.profiles.filter(({ recommended }) => recommended).at(0)?.id, 'depth');
      assert.equal(result.planning_provenance.classification_method, 'direct_skill_bypass');
    } else {
      assert.equal(result.clarification?.reason_code, example.expected?.clarification_reason);
    }
  }
});

test('zero Scenario signals ask the user to select a research direction without calling the classifier', async () => {
  let classifierCalls = 0;
  const rawInput = '创建一个调研任务，核心解决“宠物心智的设计表达策略全景，包含：全链路业务品牌心智、品类特色心智、场域心智策略”';
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: rawInput,
    task: task({
      task_type: 'user_research_planning',
      research_goal: rawInput,
      target_audience: ['产品团队'],
      scope: ['宠物心智设计表达'],
      expected_deliverables: ['research_plan'],
    }),
  }), {
    classifier: async () => {
      classifierCalls += 1;
      throw new Error('zero-signal direction selection must not call the classifier');
    },
  });

  assert.equal(result.status, 'clarification');
  assert.equal(result.clarification?.reason_code, 'scenario_selection_required');
  assert.deepEqual(result.clarification?.candidate_scenarios, [
    { id: 'user-material-synthesis', label: '已有用户资料归纳' },
    { id: 'user-segmentation', label: '用户分层' },
    { id: 'user-journey-insight', label: '用户旅程与需求洞察' },
    { id: 'root-cause-analysis', label: '问题根因拆解' },
    { id: 'metrics-validation', label: '指标与验证计划' },
  ]);
  assert.equal(classifierCalls, 0);
  assert.equal(result.planning_provenance.classifier_call_count, 0);
  assert.equal(result.planning_provenance.classification_method, 'clarification');
});

test('an explicit Scenario selection resumes guidance without classifier inference', async () => {
  let classifierCalls = 0;
  const rawInput = '创建一个调研任务，核心解决“宠物心智的设计表达策略全景”';
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: rawInput,
    task: task({
      task_type: 'user_research_planning',
      research_goal: rawInput,
      target_audience: ['产品团队'],
      scope: ['宠物心智设计表达'],
      expected_deliverables: ['research_plan'],
    }),
    selected_scenario_id: 'user-journey-insight',
  }), {
    classifier: async () => {
      classifierCalls += 1;
      throw new Error('an explicit user selection must not call the classifier');
    },
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.scenario.primary_scenario_id, 'user-journey-insight');
  assert.equal(result.scenario.confidence, 'high');
  assert.equal(result.planning_provenance.classification_method, 'clarification');
  assert.equal(result.planning_provenance.classifier_call_count, 0);
  assert.equal(classifierCalls, 0);
});

test('an explicit Scenario selection cannot cross the task-type boundary', async () => {
  const rawInput = '创建一个用户研究任务';
  await assert.rejects(
    () => resolvePlanningGuidance(baseRequest({
      raw_input: rawInput,
      task: task({
        task_type: 'user_research_planning',
        research_goal: rawInput,
        target_audience: ['产品团队'],
        scope: ['宠物心智设计表达'],
        expected_deliverables: ['research_plan'],
      }),
      selected_scenario_id: 'competitor-benchmark-research',
    })),
    /not allowed for task type user_research_planning/u,
  );
});

test('automatic Scenario signals cannot cross the finalized task-type boundary', async () => {
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '用户旅程与需求洞察',
    task: task({
      task_type: 'competitive_research',
      research_goal: '用户旅程与需求洞察',
      target_audience: ['消费者'],
      scope: ['购物助手'],
      expected_deliverables: ['研究报告'],
    }),
  }), DYNAMIC_OPTIONS);

  assert.equal(result.status, 'clarification');
  assert.equal(result.clarification?.reason_code, 'scenario_selection_required');
  assert.equal(result.scenario.primary_scenario_id, null);
});

test('medium confidence always requires clarification even when Profile sets match', async () => {
  const input = baseRequest({
    raw_input: '反馈问题聚类与策略提炼的主次需要判断',
    task: task({
      task_type: 'voc_diagnosis',
      research_goal: '反馈问题聚类与策略提炼的主次需要判断',
      target_audience: ['运营团队'],
      scope: ['反馈'],
      expected_deliverables: ['问题簇与策略'],
    }),
  });
  const result = await resolvePlanningGuidance(input, {
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
  assert.equal(result.status, 'clarification');
  assert.equal(result.clarification?.reason_code, 'medium_confidence_profile_conflict');
  assert.equal(result.planning_provenance.classifier_call_count, 1);
});

test('negated or hypothetical Scenario mentions never take the zero-call high-confidence path', async () => {
  for (const rawInput of ['不要做竞品研究，只整理现有约束', '如果后续需要竞品研究再另行评估']) {
    const result = await resolvePlanningGuidance(baseRequest({
      raw_input: rawInput,
      task: task({
        task_type: 'competitive_research',
        research_goal: rawInput,
        target_audience: ['消费者'],
        scope: ['购物助手'],
        expected_deliverables: ['约束清单'],
      }),
    }));
    assert.equal(result.status, 'clarification', rawInput);
    assert.equal(result.scenario.primary_scenario_id, null, rawInput);
  }
});

test('classifier evidence must support every selected Scenario', async () => {
  const input = baseRequest({
    raw_input: '竞品研究与机会方向判断',
    task: task({
      task_type: 'competitive_research',
      research_goal: '竞品研究与机会方向判断',
      target_audience: ['消费者'],
      scope: ['购物助手'],
      expected_deliverables: ['竞品结论与机会判断'],
    }),
  });
  const result = await resolvePlanningGuidance(input, {
    classifier: async () => ({
      primary_scenario_id: 'competitor-benchmark-research',
      secondary_scenarios: [],
      confidence: 'high',
      signals: [{ signal_id: 'scenario.opportunity-direction', source_path: 'raw_input' }],
      rationale_codes: ['semantic_disambiguation'],
    }),
  });
  assert.equal(result.status, 'clarification');
  assert.equal(result.clarification?.reason_code, 'classifier_invalid');
});

test('conflicting Profile keywords do not hide cards and only choose the recommendation', async () => {
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '竞品研究既要速度优先又要深度研究',
    task: task({
      task_type: 'competitive_research',
      research_goal: '竞品研究既要速度优先又要深度研究',
      target_audience: ['消费者'],
      scope: ['购物助手'],
      expected_deliverables: ['竞品分析'],
    }),
  }));
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth']);
  assert.equal(result.profiles.find(({ recommended }) => recommended)?.id, 'speed');
});

test('decision Profile eligibility comes from the selected direction, not option keywords', async () => {
  const base = baseRequest({
    raw_input: '开展竞品研究',
    selected_scenario_id: 'competitor-benchmark-research',
    task: task({
      task_type: 'competitive_research',
      research_goal: '开展竞品研究',
      target_audience: ['消费者'],
      scope: ['单一方案'],
      expected_deliverables: ['竞品分析'],
    }),
    capabilities: [capability({ id: 'decision-support', profile: 'decision', roles: ['decision_support'] })],
  });
  const oneOption = await resolvePlanningGuidance(base, DYNAMIC_OPTIONS);
  assert.deepEqual(oneOption.profiles.map(({ id }) => id), ['speed', 'depth', 'decision']);
  const twoOptions = await resolvePlanningGuidance({
    ...base,
    task: { ...base.task, scope: ['方案 A', '方案 B'] },
  }, DYNAMIC_OPTIONS);
  assert.deepEqual(twoOptions.profiles.map(({ id }) => id), ['speed', 'depth', 'decision']);
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

  const dynamic = await resolvePlanningGuidance(input, DYNAMIC_OPTIONS);
  assert.deepEqual(dynamic.profiles.map(({ id }) => id), ['speed', 'depth', 'breadth', 'decision']);
  assert.equal(dynamic.profiles.filter(({ recommended }) => recommended).at(0)?.id, 'decision');
  assert.ok(dynamic.profiles.every(({ coverage_invariant_ids }) => (
    coverage_invariant_ids.includes('all_required_questions')
    && coverage_invariant_ids.includes('all_required_evidence')
    && coverage_invariant_ids.includes('all_requested_deliverables')
  )));

  const withoutPathComparison = await resolvePlanningGuidance({
    ...input,
    task: {
      ...input.task,
      expected_deliverables: ['多个竞品覆盖矩阵', '决策建议'],
    },
  }, DYNAMIC_OPTIONS);
  assert.deepEqual(withoutPathComparison.profiles.map(({ id }) => id), ['speed', 'depth', 'breadth', 'decision']);
});

test('an explicit direction exposes supported cards even without Profile keywords', async () => {
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '评估当前机会',
    selected_scenario_id: 'opportunity-direction-evaluation',
    task: task({
      task_type: 'competitive_research',
      research_goal: '评估当前机会',
      target_audience: ['消费者'],
      scope: ['重点机会'],
      expected_deliverables: ['机会判断'],
    }),
    capabilities: [
      capability({ id: 'focused-analysis', profile: 'focused', roles: ['focused_analysis'] }),
      capability({ id: 'decision-analysis', profile: 'decision', roles: ['decision_support'] }),
    ],
  }), DYNAMIC_OPTIONS);

  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth', 'focused', 'decision']);
  assert.equal(result.profiles.find(({ recommended }) => recommended)?.id, 'depth');
  assert.equal(result.planning_provenance.resolver_version, 'candidate-profile-resolver-v2');
});

test('every direction deterministically exposes up to two supported specialty cards', async () => {
  const allCapabilities: PlanningGuidanceCapability[] = [
    capability({ id: 'breadth', profile: 'breadth', roles: ['scope_expansion'] }),
    capability({ id: 'focused', profile: 'focused', roles: ['focused_analysis'] }),
    capability({ id: 'decision', profile: 'decision', roles: ['decision_support'] }),
    capability({
      id: 'mixed-qualitative',
      profile: 'mixed_method',
      roles: ['independent_method'],
      methodFamily: 'qualitative',
    }),
    capability({
      id: 'mixed-quantitative',
      profile: 'mixed_method',
      roles: ['independent_method'],
      methodFamily: 'quantitative',
    }),
    capability({
      id: 'remediation',
      profile: 'remediation',
      roles: ['issue_identification', 'retest'],
    }),
  ];
  const cases: Array<{
    scenarioId: ScenarioId;
    taskType: ResearchTaskV2['task_type'];
    profiles: CandidateProfileId[];
  }> = [
    { scenarioId: 'trend-change-identification', taskType: 'competitive_research', profiles: ['speed', 'depth', 'breadth'] },
    { scenarioId: 'competitor-benchmark-research', taskType: 'competitive_research', profiles: ['speed', 'depth', 'breadth', 'decision'] },
    { scenarioId: 'opportunity-direction-evaluation', taskType: 'competitive_research', profiles: ['speed', 'depth', 'focused', 'decision'] },
    { scenarioId: 'user-material-synthesis', taskType: 'user_research_planning', profiles: ['speed', 'depth', 'focused'] },
    { scenarioId: 'user-segmentation', taskType: 'user_research_planning', profiles: ['speed', 'depth', 'focused', 'breadth'] },
    { scenarioId: 'user-journey-insight', taskType: 'user_research_planning', profiles: ['speed', 'depth', 'focused', 'mixed_method'] },
    { scenarioId: 'experience-walkthrough', taskType: 'design_audit', profiles: ['speed', 'depth', 'remediation', 'focused'] },
    { scenarioId: 'feedback-issue-clustering', taskType: 'voc_diagnosis', profiles: ['speed', 'depth', 'decision'] },
    { scenarioId: 'data-behavior-diagnosis', taskType: 'voc_diagnosis', profiles: ['speed', 'depth', 'focused', 'mixed_method'] },
    { scenarioId: 'root-cause-analysis', taskType: 'voc_diagnosis', profiles: ['speed', 'depth', 'focused', 'mixed_method'] },
    { scenarioId: 'solution-generation', taskType: 'design_audit', profiles: ['speed', 'depth', 'breadth'] },
    { scenarioId: 'solution-comparison', taskType: 'design_audit', profiles: ['speed', 'depth', 'focused'] },
    { scenarioId: 'strategy-synthesis', taskType: 'competitive_research', profiles: ['speed', 'depth', 'decision'] },
    { scenarioId: 'priority-roadmap', taskType: 'competitive_research', profiles: ['speed', 'depth', 'focused'] },
    { scenarioId: 'metrics-validation', taskType: 'competitive_research', profiles: ['speed', 'depth', 'mixed_method', 'decision'] },
  ];
  const exposed = new Set<CandidateProfileId>();

  for (const item of cases) {
    const inputTask = task({
      task_type: item.taskType,
      research_goal: '普通任务描述',
      target_audience: ['用户'],
      scope: ['单一范围'],
      expected_deliverables: ['研究报告'],
    });
    const result = await resolvePlanningGuidance(baseRequest({
      raw_input: '普通任务描述',
      task: inputTask,
      selected_scenario_id: item.scenarioId,
      capabilities: allCapabilities,
    }), DYNAMIC_OPTIONS);

    assert.deepEqual(result.profiles.map(({ id }) => id), item.profiles, item.scenarioId);
    assert.ok(result.profiles.length >= 2 && result.profiles.length <= 4, item.scenarioId);
    result.profiles.forEach(({ id }) => exposed.add(id));
  }

  assert.deepEqual([...exposed].sort(), [
    'breadth',
    'decision',
    'depth',
    'focused',
    'mixed_method',
    'remediation',
    'speed',
  ]);
});

test('revision keeps its active specialty inside the two-card specialty cap while eligible', async () => {
  const allCapabilities: PlanningGuidanceCapability[] = [
    capability({
      id: 'remediation',
      profile: 'remediation',
      roles: ['issue_identification', 'retest'],
    }),
    capability({ id: 'focused', profile: 'focused', roles: ['focused_analysis'] }),
    capability({ id: 'breadth', profile: 'breadth', roles: ['scope_expansion'] }),
  ];
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '复核现有体验走查计划',
    selected_scenario_id: 'experience-walkthrough',
    required_profile_id: 'breadth',
    task: task({
      task_type: 'design_audit',
      research_goal: '复核现有体验走查计划',
      target_audience: ['用户'],
      scope: ['页面'],
      expected_deliverables: ['体验走查报告'],
    }),
    capabilities: allCapabilities,
  }), DYNAMIC_OPTIONS);

  assert.deepEqual(result.profiles.map(({ id }) => id), [
    'speed',
    'depth',
    'remediation',
    'breadth',
  ]);
});

test('Profile keywords change only the recommendation, not the direction-owned card set', async () => {
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '完成机会方向判断，并采用聚焦方案研究关键人群',
    task: task({
      task_type: 'competitive_research',
      research_goal: '完成机会方向判断，并采用聚焦方案研究关键人群',
      target_audience: ['关键人群'],
      scope: ['重点机会'],
      expected_deliverables: ['机会判断'],
    }),
    capabilities: [
      capability({ id: 'focused-analysis', profile: 'focused', roles: ['focused_analysis'] }),
    ],
  }), DYNAMIC_OPTIONS);

  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth', 'focused']);
  const focused = result.profiles.find(({ id }) => id === 'focused');
  assert.equal(focused?.max_steps, 6);
  assert.deepEqual(focused?.required_difference_dimensions, ['scope', 'evidence', 'output_emphasis']);
  assert.equal(focused?.recommended, true);
});

test('production direction gate requires an explicit choice even for an obvious Scenario', async () => {
  let classifierCalls = 0;
  const result = await resolvePlanningGuidance(baseRequest({
    raw_input: '开展竞品研究',
  }), {
    ...DYNAMIC_OPTIONS,
    requireExplicitScenarioSelection: true,
    classifier: async () => {
      classifierCalls += 1;
      throw new Error('the explicit direction gate must not call the classifier');
    },
  });

  assert.equal(result.status, 'clarification');
  assert.equal(result.clarification?.reason_code, 'scenario_selection_required');
  assert.deepEqual(result.clarification?.candidate_scenario_ids, [
    'trend-change-identification',
    'competitor-benchmark-research',
    'opportunity-direction-evaluation',
    'strategy-synthesis',
    'priority-roadmap',
    'metrics-validation',
  ]);
  assert.equal(classifierCalls, 0);
});

test('approval-gated blocking issues do not abort scenario selection or profile planning', async () => {
  const originalInput = '宠物食品心智设计表达策略研究，以“认知—种草—搜索—购买”为用户决策主线，连接品牌心智、猫狗品类心智与内容平台／App／电商详情页的场域表达';
  const blockingIssues = [{
    key: 'regulatory_claims',
    kind: 'compliance',
    reason: '宠物食品在广告与电商详情页的功效宣称可能存在合规风险，需法务/监管审核授权。',
  }];
  const request = baseRequest({
    raw_input: originalInput,
    task: task({
      task_type: 'research_synthesis',
      research_goal: originalInput,
      target_audience: ['猫狗宠物主', '品牌与营销团队'],
      scope: ['内容平台', 'App', '电商详情页'],
      expected_deliverables: ['research_strategy_report'],
    }, { blocking_issues: blockingIssues }),
  });

  const direction = await resolvePlanningGuidance(request, {
    ...DYNAMIC_OPTIONS,
    requireExplicitScenarioSelection: true,
  });
  assert.equal(direction.status, 'clarification');
  assert.equal(direction.clarification?.reason_code, 'scenario_selection_required');

  const selected = await resolvePlanningGuidance({
    ...request,
    selected_scenario_id: 'strategy-synthesis',
  }, DYNAMIC_OPTIONS);
  assert.equal(selected.status, 'resolved');
  assert.deepEqual(selected.profiles.map(({ id }) => id), ['speed', 'depth']);
  assert.deepEqual(request.task.blocking_issues, blockingIssues);
});

test('the explicit direction gate preserves direct-Skill and fixed-policy behavior', async () => {
  const direct = await resolvePlanningGuidance(baseRequest({
    direct_skill_id: 'competitive-web-research',
    selected_scenario_id: 'competitor-benchmark-research',
  }), {
    ...DYNAMIC_OPTIONS,
    requireExplicitScenarioSelection: true,
  });
  assert.equal(direct.status, 'bypassed');
  assert.deepEqual(direct.profiles.map(({ id }) => id), ['depth', 'speed']);
  assert.equal(direct.scenario.primary_scenario_id, 'competitor-benchmark-research');
  assert.equal(direct.planning_provenance.classification_method, 'direct_skill_bypass');

  const fixed = await resolvePlanningGuidance(baseRequest(), {
    policy: { candidate_generation_mode: 'fixed', gate_3_activation_required: true },
    requireExplicitScenarioSelection: true,
    preserve_legacy_fixed_mode: true,
  });
  assert.equal(fixed.status, 'resolved');
  assert.deepEqual(fixed.profiles.map(({ id }) => id), ['depth', 'speed']);
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
    capabilities: [
      capability({ id: 'active-breadth', profile: 'breadth', roles: ['scope_expansion'] }),
      capability({ id: 'draft-decision', profile: 'decision', roles: ['decision_support'], lifecycle: 'draft' }),
      capability({ id: 'planned-decision', profile: 'decision', roles: ['decision_support'], lifecycle: 'planned' }),
      capability({ id: 'deprecated-decision', profile: 'decision', roles: ['decision_support'], lifecycle: 'deprecated' }),
      capability({ id: 'rejected-decision', profile: 'decision', roles: ['decision_support'], resolution: 'rejected' }),
    ],
  });

  const result = await resolvePlanningGuidance(input, DYNAMIC_OPTIONS);
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
    capabilities: [
      capability({ id: 'interview', profile: 'mixed_method', roles: ['independent_method'], methodFamily: 'qualitative' }),
      capability({ id: 'survey', profile: 'mixed_method', roles: ['independent_method'], methodFamily: 'quantitative' }),
    ],
  });
  const mixed = await resolvePlanningGuidance(mixedRequest, DYNAMIC_OPTIONS);
  assert.deepEqual(mixed.profiles.map(({ id }) => id), ['speed', 'depth', 'mixed_method']);

  const incompleteMixed = await resolvePlanningGuidance({
    ...mixedRequest,
    capabilities: [
      mixedRequest.capabilities[0]!,
      { ...mixedRequest.capabilities[1]!, lifecycle_status: 'planned' },
    ],
  }, DYNAMIC_OPTIONS);
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
    capabilities: [
      capability({ id: 'audit', profile: 'remediation', roles: ['issue_identification'] }),
      capability({ id: 'retest', profile: 'remediation', roles: ['retest'] }),
    ],
  });
  const remediation = await resolvePlanningGuidance(remediationRequest, DYNAMIC_OPTIONS);
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

test('planning-guidance module exposes one deep interface and RoutedPlanner connects only through its adapter', async () => {
  const module = await import('../apps/orchestrator-runtime/src/planners/planning-guidance.ts');
  assert.deepEqual(Object.keys(module), ['resolvePlanningGuidance']);
  const routedPlannerSource = readFileSync(
    join(ROOT, 'apps/orchestrator-runtime/src/planners/routed-planner.ts'),
    'utf8',
  );
  assert.equal(routedPlannerSource.includes("from './planning-guidance.ts'"), false);
  assert.equal(routedPlannerSource.includes('resolvePlanningGuidance'), false);
  assert.equal(routedPlannerSource.includes('resolvePlannerGuidance'), true);
});
