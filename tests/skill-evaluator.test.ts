import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  hashPrompt,
  type LLMClient,
  type LLMProviderIdentity,
  type LLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import type { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import type { SkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { getConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { SkillEvaluator } from '../evaluations/skills/evaluator.ts';
import type {
  LoadedEvaluationCase,
  SkillScorecard,
} from '../evaluations/skills/types.ts';

type StructuredCall = Parameters<LLMClient['generateStructured']>[0];

function structuredCall(llm: FakeLLM, index: number): StructuredCall {
  const call = llm.calls[index];
  assert.ok(call, `expected structured LLM call ${index + 1}`);
  return call;
}

function callContext(call: StructuredCall): Record<string, unknown> {
  assert.ok(call.context, 'expected structured LLM call context');
  return call.context as Record<string, unknown>;
}

const dimensionWeights = {
  workflow_adherence: 20,
  method_correctness: 20,
  completeness_structure: 20,
  evidence_boundaries: 15,
  actionability: 15,
  risk_boundary_handling: 10,
} as const;

const scorecardSchemaPath = join(
  getConfigRoot(),
  'evaluations/skills/scorecard.schema.json',
);

const skillBody = `# Synthetic Skill

## Workflow
1. Read every input material.
2. Ground each conclusion in tool output.

## Quality gates
- Label unsupported judgments as inference.
- Keep synthetic evidence distinct from real facts.`;

const nativeSkill: SkillRegistryEntry = {
  id: 'native-skill',
  name: 'Native Skill',
  path: 'skills/native/SKILL.md',
  when_to_use: 'evaluation',
  owner: 'test',
  status: 'active',
  output_schema: 'skills/native/output.schema.json',
  risk_level: 'medium',
};

const loadedCase: LoadedEvaluationCase = {
  data: {
    skill_id: nativeSkill.id,
    title: 'Synthetic evaluation',
    research_goal: 'Compare synthetic products',
    input_materials: { brief: 'fixture brief' },
    tool_outputs: [{ title: 'fixture evidence', value: 3 }],
    expected_deliverables: ['Grounded comparison'],
    risk_checks: ['Do not claim synthetic data is real'],
  },
  sourcePath: '/fixtures/native-skill.json',
  caseHash: 'sha256:case',
};

function scorecard(
  scores: Partial<Record<keyof typeof dimensionWeights, number>> = {},
  overrides: Partial<SkillScorecard> = {},
): SkillScorecard {
  return {
    skill_id: nativeSkill.id,
    total_score: 1,
    verdict: 'pass',
    dimensions: Object.entries(dimensionWeights).map(([id, max_score]) => ({
      id,
      score: scores[id as keyof typeof dimensionWeights] ?? max_score,
      max_score,
      evidence: ['output'],
      defects: [],
    })),
    critical_defects: [],
    review_notes: [],
    ...overrides,
  };
}

function result<T>(
  data: T,
  callNumber: number,
  modelName: string,
): LLMResult<T> {
  return {
    data,
    promptHash: `sha256:prompt-${callNumber}`,
    modelName,
    modelVersion: 'v1',
    traceId: `trace-${callNumber}`,
    tokens: { prompt: 10, completion: 5, total: 15 },
  };
}

class FakeLLM implements LLMClient {
  readonly identity: LLMProviderIdentity;

  readonly calls: StructuredCall[] = [];

  constructor(
    private readonly responses: Array<unknown | Error> = [
      { answer: 'grounded output' },
      scorecard(),
    ],
    options: {
      requestedModel?: string;
      actualModels?: readonly string[];
    } = {},
  ) {
    this.identity = {
      provider: 'fake',
      endpointHost: 'fake.test',
      requestedModel: options.requestedModel ?? 'fake-model',
      mode: 'mock',
      eligibleAsReal: false,
    };
    this.actualModels = options.actualModels ?? [];
  }

  private readonly actualModels: readonly string[];

  async generateStructured<T>(opts: StructuredCall): Promise<LLMResult<T>> {
    this.calls.push(opts);
    const response = this.responses[this.calls.length - 1];
    if (response instanceof Error) throw response;
    return result(
      response as T,
      this.calls.length,
      this.actualModels[this.calls.length - 1] ?? this.identity.requestedModel,
    );
  }

  async generateText(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeValidator {
  readonly calls: Array<{ path: string; data: unknown }> = [];

  constructor(
    private readonly rejection?: { path: string; data: unknown },
  ) {}

  validateFileOrThrow(path: string, data: unknown): void {
    this.calls.push({ path, data });
    if (
      this.rejection &&
      path === this.rejection.path &&
      isDeepStrictEqual(data, this.rejection.data)
    ) {
      throw new Error(`invalid schema: ${path}`);
    }
  }

  validateSchemaOrThrow(_schema: object, data: unknown, label: string): void {
    this.validateFileOrThrow(label, data);
  }
}

function fakeSkillLoader(entry: SkillRegistryEntry = nativeSkill): SkillLoader {
  return {
    getSkill: (id: string) => (id === entry.id ? entry : null),
    loadSkillBody: () => ({
      body: skillBody,
      hash: 'sha256:skill',
      path: entry.entry ?? entry.path,
    }),
    loadSkillSchemas: () => ({
      output: entry.output_schema
        ? { type: 'object', required: ['answer'] }
        : undefined,
    }),
  } as unknown as SkillLoader;
}

function makeEvaluator(options: {
  llm?: FakeLLM;
  entry?: SkillRegistryEntry;
  validator?: FakeValidator;
  scorecardSchemaPath?: string;
  expectedActualModel?: string;
} = {}) {
  const llm =
    options.llm ??
    new FakeLLM([
      { answer: 'grounded output' },
      scorecard({}, { skill_id: options.entry?.id ?? nativeSkill.id }),
    ]);
  const validator = options.validator ?? new FakeValidator();
  const evaluator = new SkillEvaluator({
    llm,
    skillLoader: fakeSkillLoader(options.entry),
    validator: validator as unknown as SchemaValidator,
    scorecardSchemaPath: options.scorecardSchemaPath ?? scorecardSchemaPath,
    expectedActualModel: options.expectedActualModel,
  });
  return { evaluator, llm, validator };
}

test('generates from the full Skill and case, validates output, then scores independently', async () => {
  const { evaluator, llm, validator } = makeEvaluator();

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'succeeded');
  assert.deepEqual(record.output, { answer: 'grounded output' });
  assert.equal(record.skillId, nativeSkill.id);
  assert.equal(record.skillHash, 'sha256:skill');
  assert.equal(record.caseHash, loadedCase.caseHash);
  assert.equal(record.generationPromptHash, 'sha256:prompt-1');
  assert.equal(record.scoringPromptHash, 'sha256:prompt-2');

  assert.equal(llm.calls.length, 2);
  const generation = structuredCall(llm, 0);
  assert.ok(generation.prompt.endsWith(`\n\n${skillBody}`));
  assert.match(generation.prompt, /只能基于 input_materials 与 tool_outputs/);
  assert.match(generation.prompt, /不得表述为真实业务事实/);
  assert.match(generation.prompt, /llm_inference|待人工确认/);
  assert.equal(generation.schemaName, `skill:${nativeSkill.id}`);
  assert.deepEqual(generation.context, {
    research_goal: loadedCase.data.research_goal,
    input_materials: loadedCase.data.input_materials,
    tool_outputs: loadedCase.data.tool_outputs,
    expected_deliverables: loadedCase.data.expected_deliverables,
    risk_checks: loadedCase.data.risk_checks,
  });
  assert.deepEqual(generation.receipt, {
    stage: 'skill_evaluation_generation',
    contextManifestHash: hashPrompt('', generation.context),
    expectedModel: llm.identity.requestedModel,
  });

  const scoring = structuredCall(llm, 1);
  assert.equal(scoring.schemaName, 'skill-evaluation-scorecard');
  for (const [id, weight] of Object.entries(dimensionWeights)) {
    assert.match(
      scoring.prompt,
      new RegExp(`(?:：|；)${id} ${weight}(?:；|。)`),
    );
  }
  assert.match(scoring.prompt, /具体.*引用|逐字引用/);
  assert.match(scoring.prompt, /不得.*冗长|不奖励.*冗长/);
  assert.match(scoring.prompt, /合成评测数据.*不得.*真实业务事实/);
  assert.deepEqual(scoring.context, {
    skill_id: nativeSkill.id,
    skill_body: skillBody,
    evaluation_case: loadedCase.data,
    generated_output: { answer: 'grounded output' },
  });
  assert.deepEqual(scoring.receipt, {
    stage: 'skill_evaluation_scoring',
    contextManifestHash: hashPrompt('', scoring.context),
    expectedModel: llm.identity.requestedModel,
  });

  const outputSchemaPath = `skill:${nativeSkill.id}`;
  const outputValidations = validator.calls.filter(
    ({ path }) => path === outputSchemaPath,
  );
  assert.equal(outputValidations.length, 1);
  assert.deepEqual(outputValidations[0].data, { answer: 'grounded output' });
  assert.equal(
    validator.calls.filter(({ path }) => path === scorecardSchemaPath).length,
    1,
  );
  assert.equal(record.scorecard?.total_score, 100);
});

test('validates a KB Skill through the same effective output contract', async () => {
  const kbSkill = {
    ...nativeSkill,
    id: 'kb-skill',
    name: 'KB Skill',
    output_schema: 'schemas/skill-result-envelope.schema.json',
    path: 'skills/kb',
    entry: 'skills/kb/SKILL.md',
  };
  const kbCase = {
    ...loadedCase,
    data: { ...loadedCase.data, skill_id: kbSkill.id },
  };
  const { evaluator, validator } = makeEvaluator({ entry: kbSkill });

  const record = await evaluator.evaluate(kbCase);

  assert.equal(record.status, 'succeeded');
  assert.deepEqual(
    validator.calls.map(({ path }) => path),
    [`skill:${kbSkill.id}`, scorecardSchemaPath],
  );
});

for (const { name, sum, expectedVerdict, expectedStatus } of [
  { name: 'below 60', sum: 59, expectedVerdict: 'fail', expectedStatus: 'succeeded' },
  { name: 'at 60', sum: 60, expectedVerdict: 'needs_review', expectedStatus: 'needs_review' },
  { name: 'at 79', sum: 79, expectedVerdict: 'needs_review', expectedStatus: 'needs_review' },
  { name: 'at 80', sum: 80, expectedVerdict: 'pass', expectedStatus: 'succeeded' },
] as const) {
  test(`recomputes an inconsistent total and normalizes ${name} to ${expectedVerdict}`, async () => {
    let remaining = sum;
    const scores = Object.fromEntries(
      Object.entries(dimensionWeights).map(([id, max]) => {
        const value = Math.min(max, remaining);
        remaining -= value;
        return [id, value];
      }),
    );
    const scored = scorecard(scores, { total_score: 999, verdict: 'fail' });
    const { evaluator } = makeEvaluator({
      llm: new FakeLLM([{ answer: 'output' }, scored]),
    });

    const record = await evaluator.evaluate(loadedCase);

    assert.equal(record.scorecard?.total_score, sum);
    assert.equal(record.scorecard?.verdict, expectedVerdict);
    assert.equal(record.status, expectedStatus);
  });
}

test('keeps a high score at needs_review when requested by the scorer', async () => {
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([
      { answer: 'output' },
      scorecard({}, { verdict: 'needs_review' }),
    ]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.scorecard?.total_score, 100);
  assert.equal(record.scorecard?.verdict, 'needs_review');
  assert.equal(record.status, 'needs_review');
});

test('forces fail when the scorer lists a critical defect', async () => {
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([
      { answer: 'output' },
      scorecard({}, { critical_defects: ['Fabricated a source'] }),
    ]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.scorecard?.total_score, 100);
  assert.equal(record.scorecard?.verdict, 'fail');
  assert.equal(record.status, 'succeeded');
});

test('degrades a scorer exception to a review card and preserves generated output', async () => {
  const { evaluator, llm } = makeEvaluator({
    llm: new FakeLLM([
      { answer: 'preserve me' },
      new Error('scorer unavailable'),
    ]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(llm.calls.length, 2);
  assert.equal(record.status, 'needs_review');
  assert.equal(record.errorStage, 'scoring');
  assert.equal(record.errorMessage, 'scorer unavailable');
  assert.deepEqual(record.output, { answer: 'preserve me' });
  assert.equal(record.scorecard?.skill_id, nativeSkill.id);
  assert.equal(record.scorecard?.total_score, null);
  assert.equal(record.scorecard?.verdict, 'needs_review');
  assert.deepEqual(record.scorecard?.dimensions, []);
  assert.ok(record.scorecard?.review_notes.includes('scorer unavailable'));
});

test('treats scorecard schema rejection as an observable scoring failure', async () => {
  const rejected = scorecard();
  const validator = new FakeValidator({
    path: scorecardSchemaPath,
    data: rejected,
  });
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([{ answer: 'grounded output' }, rejected]),
    validator,
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'needs_review');
  assert.equal(record.errorStage, 'scoring');
  assert.match(record.errorMessage ?? '', /invalid schema/);
  assert.deepEqual(record.output, { answer: 'grounded output' });
  assert.equal(record.scorecard?.total_score, null);
});

test('does not clamp an invalid dimension score and degrades scoring', async () => {
  const invalid = scorecard({ workflow_adherence: 21 });
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([{ answer: 'output' }, invalid]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'needs_review');
  assert.equal(record.errorStage, 'scoring');
  assert.match(record.errorMessage ?? '', /workflow_adherence/);
  assert.equal(record.scorecard?.total_score, null);
  assert.deepEqual(record.output, { answer: 'output' });
});

test('rejects a score within an incorrect fixed maximum instead of accepting it', async () => {
  const valid = scorecard();
  const invalid = scorecard({}, {
    dimensions: valid.dimensions.map((dimension) =>
      dimension.id === 'workflow_adherence'
        ? { ...dimension, score: 21, max_score: 21 }
        : dimension,
    ),
  });
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([{ answer: 'output' }, invalid]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'needs_review');
  assert.equal(record.errorStage, 'scoring');
  assert.match(record.errorMessage ?? '', /workflow_adherence/);
  assert.equal(record.scorecard?.total_score, null);
  assert.deepEqual(record.output, { answer: 'output' });
});

test('rejects missing, duplicate, or unknown scoring dimensions instead of normalizing them', async (t) => {
  const cases: Array<{ name: string; dimensions: SkillScorecard['dimensions'] }> = [
    { name: 'missing', dimensions: scorecard().dimensions.slice(0, 5) },
    {
      name: 'duplicate',
      dimensions: [
        ...scorecard().dimensions.slice(0, 5),
        scorecard().dimensions[0],
      ],
    },
    {
      name: 'unknown',
      dimensions: scorecard().dimensions.map((dimension, index) =>
        index === 0 ? { ...dimension, id: 'unknown' } : dimension,
      ),
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async () => {
      const { evaluator } = makeEvaluator({
        llm: new FakeLLM([
          { answer: 'output' },
          scorecard({}, { dimensions: invalidCase.dimensions }),
        ]),
      });

      const record = await evaluator.evaluate(loadedCase);

      assert.equal(record.status, 'needs_review');
      assert.equal(record.errorStage, 'scoring');
      assert.equal(record.scorecard?.total_score, null);
    });
  }
});
test('degrades a scorecard with empty dimension evidence to needs_review', async () => {
  const invalid = scorecard({}, {
    dimensions: scorecard().dimensions.map((dimension, index) =>
      index === 0 ? { ...dimension, evidence: [] } : dimension,
    ),
  });
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([{ answer: 'output' }, invalid]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'needs_review');
  assert.equal(record.errorStage, 'scoring');
  assert.equal(record.scorecard?.total_score, null);
  assert.deepEqual(record.output, { answer: 'output' });
});

for (const invalidEvidence of [
  { name: 'fabricated quote', value: 'quote absent from generated output' },
  { name: 'blank quote', value: ' \t\n ' },
] as const) {
  test(`does not accept six-dimensional ${invalidEvidence.name} evidence as a passing evaluation`, async () => {
    const invalid = scorecard({}, {
      dimensions: scorecard().dimensions.map((dimension) => ({
        ...dimension,
        evidence: [invalidEvidence.value],
      })),
    });
    const { evaluator } = makeEvaluator({
      llm: new FakeLLM([{ answer: 'grounded output' }, invalid]),
    });

    const record = await evaluator.evaluate(loadedCase);

    assert.notEqual(record.status, 'succeeded');
    assert.notEqual(record.scorecard?.verdict, 'pass');
  });
}

test('accepts non-empty verbatim evidence excerpts from generated output scalars', async () => {
  const generatedOutput = {
    answer: 'grounded output with an exact scalar excerpt',
    detail: { summary: 'nested scalar evidence' },
  };
  const valid = scorecard({}, {
    dimensions: scorecard().dimensions.map((dimension) => ({
      ...dimension,
      evidence: ['exact scalar excerpt', 'nested scalar'],
    })),
  });
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([generatedOutput, valid]),
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'succeeded');
  assert.equal(record.scorecard?.verdict, 'pass');
});

test('accepts a requested routing alias when both evaluator stages return the expected canonical model', async () => {
  const llm = new FakeLLM(
    [{ answer: 'canonical output' }, scorecard()],
    {
      requestedModel: 'gateway-routing-alias',
      actualModels: ['canonical-model-id', 'canonical-model-id'],
    },
  );
  const { evaluator } = makeEvaluator({
    llm,
    expectedActualModel: 'canonical-model-id',
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(record.status, 'succeeded');
  assert.equal(record.modelName, 'canonical-model-id');
  assert.equal(structuredCall(llm, 0).receipt.expectedModel, 'canonical-model-id');
  assert.equal(structuredCall(llm, 1).receipt.expectedModel, 'canonical-model-id');
});

test('fails generation when its actual model drifts from the expected canonical model', async () => {
  const llm = new FakeLLM(
    [{ answer: 'drifted output' }, scorecard()],
    {
      requestedModel: 'gateway-routing-alias',
      actualModels: ['unexpected-generation-model', 'canonical-model-id'],
    },
  );
  const { evaluator } = makeEvaluator({
    llm,
    expectedActualModel: 'canonical-model-id',
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(llm.calls.length, 1);
  assert.equal(record.status, 'failed');
  assert.equal(record.errorStage, 'generation');
});

test('fails rather than requesting review when only the scoring actual model drifts', async () => {
  const llm = new FakeLLM(
    [{ answer: 'canonical output' }, scorecard()],
    {
      requestedModel: 'gateway-routing-alias',
      actualModels: ['canonical-model-id', 'unexpected-scoring-model'],
    },
  );
  const { evaluator } = makeEvaluator({
    llm,
    expectedActualModel: 'canonical-model-id',
  });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(llm.calls.length, 2);
  assert.equal(record.status, 'failed');
  assert.equal(record.errorStage, 'scoring');
});

test('preserves Round 0 prompts and contexts when KB is not provided', async () => {
  const { evaluator, llm } = makeEvaluator();

  await evaluator.evaluate(loadedCase);

  const generationContext = callContext(structuredCall(llm, 0));
  const scoringContext = callContext(structuredCall(llm, 1));
  assert.equal('knowledge_context' in generationContext, false);
  assert.equal('retrieval' in scoringContext, false);
  assert.equal('knowledge_context' in scoringContext, false);
});

test('injects optional KB context into generation and scoring without changing base score', async () => {
  const kb = {
    knowledgeContext: {
      mode: 'gold' as const,
      snapshot_id: 'sha256:snapshot',
      required_source_ids: ['required_id'],
      selected_source_ids: ['required_id'],
      items: [{
        source_id: 'required_id',
        title: 'Required',
        source_path: 'methods/required.md',
        content_hash: 'sha256:required',
        status: 'reviewed',
        role: 'required' as const,
        content: 'required body',
      }],
    },
    retrieval: {
      mode: 'gold' as const,
      snapshot_id: 'sha256:snapshot',
      guide_tags: ['alpha'],
      candidate_source_ids: ['required_id'],
      selected_source_ids: ['required_id'],
      required_source_recall: 1,
      missing_required_source_ids: [],
      unresolved_items: [],
    },
  };
  const { evaluator, llm } = makeEvaluator({
    llm: new FakeLLM([
      { answer: 'grounded output [source: required_id]' },
      scorecard({ workflow_adherence: 10 }),
    ]),
  });

  const record = await evaluator.evaluate(loadedCase, kb);

  assert.equal(record.scorecard?.total_score, 90);
  assert.equal(record.kbAssessment?.kb_grounding_verdict, 'pass');
  assert.deepEqual(record.knowledgeContextRef, {
    mode: 'gold',
    snapshot_id: 'sha256:snapshot',
    required_source_ids: ['required_id'],
    selected_source_ids: ['required_id'],
    retrieval_recall: 1,
  });
  const generation = structuredCall(llm, 0);
  const scoring = structuredCall(llm, 1);
  const generationContext = callContext(generation);
  const scoringContext = callContext(scoring);
  assert.deepEqual(generationContext.knowledge_context, kb.knowledgeContext);
  assert.match(generation.prompt, /source status|source_id|citation/i);
  assert.deepEqual(scoringContext.knowledge_context, kb.knowledgeContext);
  assert.deepEqual(scoringContext.retrieval, kb.retrieval);
  assert.equal(
    generation.receipt.contextManifestHash,
    hashPrompt('', generationContext),
  );
  assert.equal(
    scoring.receipt.contextManifestHash,
    hashPrompt('', scoringContext),
  );
});

test('keeps generated output and KB assessment when scoring fails', async () => {
  const kb = {
    knowledgeContext: {
      mode: 'gold' as const,
      snapshot_id: 'sha256:snapshot',
      required_source_ids: ['required_id'],
      selected_source_ids: ['required_id'],
      items: [{
        source_id: 'required_id',
        title: 'Required',
        source_path: 'methods/required.md',
        content_hash: 'sha256:required',
        status: 'reviewed',
        role: 'required' as const,
        content: 'required body',
      }],
    },
    retrieval: {
      mode: 'gold' as const,
      snapshot_id: 'sha256:snapshot',
      guide_tags: [],
      candidate_source_ids: ['required_id'],
      selected_source_ids: ['required_id'],
      required_source_recall: 1,
      missing_required_source_ids: [],
      unresolved_items: [],
    },
  };
  const { evaluator } = makeEvaluator({
    llm: new FakeLLM([
      { answer: 'grounded output [source: required_id]' },
      new Error('scorer unavailable'),
    ]),
  });

  const record = await evaluator.evaluate(loadedCase, kb);

  assert.equal(record.status, 'needs_review');
  assert.equal(record.errorStage, 'scoring');
  assert.deepEqual(record.output, { answer: 'grounded output [source: required_id]' });
  assert.equal(record.kbAssessment?.kb_grounding_verdict, 'pass');
});


test('adds the C1 prompt and Skill delta only when evaluation content instructions are supplied', async () => {
  const { evaluator, llm } = makeEvaluator();
  await evaluator.evaluate(loadedCase, undefined, {
    overlayId: 'user-research-hub-c1',
    prompt: 'EVALUATION-ONLY STRATEGY CHAIN',
    rubricHash: 'sha256:rubric',
    sourceIds: ['candidate-method'],
    methodSourceIds: ['candidate-method'],
    skillDeltaIds: ['narrow-delta'],
    skillDeltaText: 'NARROW DELTA BODY',
  });

  const generation = structuredCall(llm, 0);
  assert.match(generation.prompt, /EVALUATION-ONLY STRATEGY CHAIN/);
  assert.match(generation.prompt, /NARROW DELTA BODY/);
  assert.deepEqual(callContext(generation).content_evaluation, {
    overlay_id: 'user-research-hub-c1',
    rubric_hash: 'sha256:rubric',
    candidate_source_ids: ['candidate-method'],
    candidate_method_source_ids: ['candidate-method'],
    skill_delta_ids: ['narrow-delta'],
  });
  assert.deepEqual(callContext(structuredCall(llm, 1)).content_evaluation, {
    overlay_id: 'user-research-hub-c1',
    rubric_hash: 'sha256:rubric',
    criteria_are_additive: true,
  });
});

test('returns a generation failure and never scores when generation throws', async () => {
  const llm = new FakeLLM([new Error('generation unavailable')]);
  const { evaluator, validator } = makeEvaluator({ llm });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(llm.calls.length, 1);
  assert.equal(validator.calls.length, 0);
  assert.equal(record.status, 'failed');
  assert.equal(record.errorStage, 'generation');
  assert.equal(record.errorMessage, 'generation unavailable');
  assert.equal(record.output, undefined);
  assert.equal(record.scorecard, undefined);
});

test('returns a schema failure and never scores when generated output is invalid', async () => {
  const outputSchemaPath = `skill:${nativeSkill.id}`;
  const invalidOutput = { answer: 'invalid output' };
  const llm = new FakeLLM([invalidOutput]);
  const validator = new FakeValidator({
    path: outputSchemaPath,
    data: invalidOutput,
  });
  const { evaluator } = makeEvaluator({ llm, validator });

  const record = await evaluator.evaluate(loadedCase);

  assert.equal(llm.calls.length, 1);
  assert.equal(record.status, 'failed');
  assert.equal(record.errorStage, 'schema_validation');
  assert.match(record.errorMessage ?? '', /invalid schema/);
  assert.deepEqual(record.output, invalidOutput);
  assert.equal(record.scorecard, undefined);
});

test('scorecard schema enforces every required field and declared value constraint', () => {
  const validator = new SchemaValidator();
  const schemaPath = join(
    getConfigRoot(),
    'evaluations/skills/scorecard.schema.json',
  );
  const valid = scorecard();

  assert.doesNotThrow(() => validator.validateFileOrThrow(schemaPath, valid));
  assert.doesNotThrow(() =>
    validator.validateFileOrThrow(schemaPath, {
      ...valid,
      total_score: null,
    }),
  );
  assert.throws(() =>
    validator.validateFileOrThrow(schemaPath, {
      ...valid,
      dimensions: [
        { ...valid.dimensions[0], evidence: [] },
        ...valid.dimensions.slice(1),
      ],
    }),
  );
  const requiredFields: Array<keyof SkillScorecard> = [
    'skill_id',
    'total_score',
    'verdict',
    'dimensions',
    'critical_defects',
    'review_notes',
  ];
  for (const field of requiredFields) {
    const missing = { ...valid } as Partial<SkillScorecard>;
    delete missing[field];
    assert.throws(
      () => validator.validateFileOrThrow(schemaPath, missing),
      `missing ${field} must be rejected`,
    );
  }
  assert.throws(() =>
    validator.validateFileOrThrow(schemaPath, {
      ...valid,
      verdict: 'maybe',
    }),
  );
  assert.throws(() =>
    validator.validateFileOrThrow(schemaPath, { ...valid, unexpected: true }),
  );
  assert.throws(() =>
    validator.validateFileOrThrow(schemaPath, {
      ...valid,
      dimensions: [
        { ...valid.dimensions[0], score: -1 },
        ...valid.dimensions.slice(1),
      ],
    }),
  );
  assert.throws(() =>
    validator.validateFileOrThrow(schemaPath, {
      ...valid,
      dimensions: [
        { ...valid.dimensions[0], unexpected: true },
        ...valid.dimensions.slice(1),
      ],
    }),
  );
});
