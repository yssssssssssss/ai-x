import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANDIDATE_PROFILES,
  type PlanCandidate,
  type ResearchTaskData,
} from '../packages/api-contract/plan.ts';
import { RoutedPlanner } from '../apps/orchestrator-runtime/src/planners/routed-planner.ts';
import {
  defaultFixtures,
  MockLLMClient,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import type { LegacyStructuredLLMCallOptions } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  loadSchemaText,
  resolveSchema,
} from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

type CandidatePayload = Omit<PlanCandidate, 'activated_nodes'>;

function candidate(id: PlanCandidate['id']): CandidatePayload {
  return {
    id,
    title: `${id} 方案`,
    rationale: `${id} 执行策略`,
    tradeoffs: `${id} 取舍`,
    steps: [{
      step_no: 1,
      step_name: `${id} 分析`,
      actor_type: 'llm',
      actor_id: `${id} 分析器`,
      input: { focus: id },
    }],
    assumptions: [{ key: 'scope', value: '公开资料', editable: true }],
  };
}

function payload(): { candidates: CandidatePayload[] } {
  return { candidates: [candidate('depth'), candidate('speed')] };
}

function errorsFor(value: unknown): string[] {
  return new SchemaValidator().validate('current-plan-candidates', value);
}

class RecordingPlanningLLM extends MockLLMClient {
  readonly structuredCalls: LegacyStructuredLLMCallOptions[] = [];

  override async generateStructured<T>(options: LegacyStructuredLLMCallOptions) {
    this.structuredCalls.push(options);
    return super.generateStructured<T>(options);
  }
}

test('current-plan-candidates schema is registered and accepts the strict baseline', () => {
  const spec = resolveSchema('current-plan-candidates');
  assert.equal(spec.file, 'current-plan-candidates.schema.json');
  assert.match(loadSchemaText(spec) ?? '', /current-plan-candidates/);
  assert.deepEqual(errorsFor(payload()), []);
});

test('candidate profile type and candidate schema share the same controlled IDs', () => {
  const schema = JSON.parse(
    loadSchemaText(resolveSchema('current-plan-candidates')) ?? '{}',
  ) as { $defs?: { candidateProfile?: { enum?: unknown } } };
  assert.deepEqual(schema.$defs?.candidateProfile?.enum, [...CANDIDATE_PROFILES]);
});

test('Current candidates accept two to four homogeneous controlled profiles in persisted order', () => {
  for (const ids of [
    ['speed', 'depth'],
    ['depth', 'speed'],
    ['speed', 'depth', 'breadth'],
    ['speed', 'depth', 'focused', 'decision'],
  ] as const) {
    const value = { candidates: ids.map(candidate) };
    value.candidates.at(-1)!.recommended = true;
    assert.deepEqual(errorsFor(value), [], ids.join(','));
  }
});

test('Current candidates reject counts outside 2-4, unknown IDs, and identical duplicates', () => {
  const cases = [
    { candidates: [candidate('depth')] },
    { candidates: [
      candidate('speed'),
      candidate('depth'),
      candidate('breadth'),
      candidate('focused'),
      candidate('decision'),
    ] },
    { candidates: [candidate('depth'), candidate('speed'), candidate('speed')] },
    { candidates: [candidate('depth'), { ...candidate('speed'), id: 'invented' }] },
  ];

  for (const value of cases) {
    assert.ok(errorsFor(value).length > 0, JSON.stringify(value));
  }
});

test('Current candidates reject empty rationale, tradeoffs, and steps', () => {
  for (const field of ['rationale', 'tradeoffs'] as const) {
    const value = payload();
    value.candidates[0][field] = '';
    assert.ok(errorsFor(value).length > 0, field);
  }

  const withoutSteps = payload();
  withoutSteps.candidates[0].steps = [];
  assert.ok(errorsFor(withoutSteps).length > 0, 'steps');
});

test('Current candidates reject additional properties at every object boundary', () => {
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.unexpected = true; },
    (value) => { ((value.candidates as Array<Record<string, unknown>>)[0]).unexpected = true; },
    (value) => {
      const first = (value.candidates as Array<Record<string, unknown>>)[0];
      ((first.steps as Array<Record<string, unknown>>)[0]).unexpected = true;
    },
    (value) => {
      const first = (value.candidates as Array<Record<string, unknown>>)[0];
      ((first.assumptions as Array<Record<string, unknown>>)[0]).unexpected = true;
    },
  ];

  for (const mutate of mutations) {
    const value = structuredClone(payload()) as unknown as Record<string, unknown>;
    mutate(value);
    assert.ok(errorsFor(value).length > 0);
  }
});

test('Current candidate steps require a supported actor_type and object input', () => {
  for (const invalidActor of ['agent', '', 1]) {
    const value = structuredClone(payload()) as unknown as {
      candidates: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    value.candidates[0].steps[0].actor_type = invalidActor;
    assert.ok(errorsFor(value).length > 0, String(invalidActor));
  }

  for (const invalidInput of ['query', [], null]) {
    const value = structuredClone(payload()) as unknown as {
      candidates: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    value.candidates[0].steps[0].input = invalidInput;
    assert.ok(errorsFor(value).length > 0, JSON.stringify(invalidInput));
  }
});

const planningTask = structuredClone(defaultFixtures['research-task']) as ResearchTaskData;

async function planWith(candidates: unknown[]): Promise<void> {
  const fixtures = structuredClone(defaultFixtures);
  fixtures['current-plan-candidates'] = { candidates };
  const planner = new RoutedPlanner({
    llm: new MockLLMClient(fixtures),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
  });

  await planner.plan({
    task: planningTask,
    direct: null,
    taskProvenance: {
      modelName: 'planning-test',
      modelVersion: '1',
      promptHash: 'sha256:planning-test',
      traceId: 'trace_planning_test',
    },
    emit() {},
  });
}

test('RoutedPlanner rejects three candidates instead of silently truncating them', async () => {
  await assert.rejects(
    () => planWith([candidate('depth'), candidate('speed'), candidate('speed')]),
    /current-plan-candidates|校验失败/,
  );
});

test('RoutedPlanner rejects malformed candidate fields before returning a plan', async () => {
  const malformed = candidate('depth');
  malformed.rationale = '';
  await assert.rejects(
    () => planWith([malformed, candidate('speed')]),
    /current-plan-candidates|校验失败/,
  );
});

test('RoutedPlanner rejects non-array assumptions instead of coercing provider output', async () => {
  for (const assumptions of [{ scope: 'must not be coerced' }, 'must not be coerced']) {
    const malformed = candidate('depth') as unknown as Record<string, unknown>;
    malformed.assumptions = assumptions;
    await assert.rejects(
      () => planWith([malformed, candidate('speed')]),
      /current-plan-candidates|校验失败/,
    );
  }
});

test('RoutedPlanner dispatches the current candidate schema object to the LLM', async () => {
  const fixtures = structuredClone(defaultFixtures);
  const llm = new RecordingPlanningLLM(fixtures);
  const planner = new RoutedPlanner({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
  });

  await planner.plan({
    task: planningTask,
    direct: null,
    taskProvenance: {
      modelName: 'planning-test',
      modelVersion: '1',
      promptHash: 'sha256:planning-test',
      traceId: 'trace_planning_test',
    },
    emit() {},
  });

  const planningCall = llm.structuredCalls.find((call) => call.receipt?.stage === 'planning');
  assert.ok(planningCall);
  assert.equal(planningCall.schemaName, 'current-plan-candidates');
  assert.deepEqual(
    planningCall.schema,
    JSON.parse(loadSchemaText(resolveSchema('current-plan-candidates')) ?? '{}'),
  );
});
