import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuidanceRef, ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { EvidenceRequirement } from '../packages/api-contract/research-deliverable.ts';
import {
  hashPrompt,
  type LLMClient,
  type LLMProviderIdentity,
  type LLMResult,
  type ModelCallRecordInput,
  type StructuredLLMCallOptions,
  type TextLLMCallOptions,
  type TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ReceiptLLMClient } from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  ProblemGraphPlanner,
  ProblemGraphValidationError,
  validateProblemGraphCoverage,
  validateProblemGraphEvidenceCoverage,
  type ProblemGraph,
} from '../apps/orchestrator-runtime/src/planners/problem-graph-planner.ts';

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'competitive_research',
  business_domain: 'live_commerce',
  research_goal: '比较直播数字人方案并形成可执行建议',
  target_audience: ['产品团队', '研究团队'],
  scope: ['公开市场信息', '近十二个月'],
  constraints: [{ id: 'constraint-public', statement: '只使用公开信息', source: 'user' }],
  success_criteria: [
    { id: 'criterion-market', statement: '说明主要方案的市场差异' },
    { id: 'criterion-action', statement: '形成可执行的选择建议' },
  ],
  expected_deliverables: ['竞品研究计划'],
  assumptions: [{ key: 'sample', value: '头部三家', editable: true }],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

const guidance: GuidanceRef[] = [{
  node: 'D5_competitive',
  id: 'guide-competitive',
  title: '竞品分析方法',
  summary: '先建立比较维度，再形成证据化判断。',
  source_path: 'knowledge/guides/competitive.md',
  content_hash: 'sha256:guide',
}];

const evidencePolicy: EvidenceRequirement[] = [{
  id: 'public-source',
  acceptedClasses: ['public_source'],
  minimumCount: 2,
  required: true,
}];

function validGraph(): ProblemGraph {
  return {
    version: 'problem-graph-v1',
    questions: [
      {
        id: 'question-market',
        statement: '主要方案有什么市场差异？',
        rationale: '回答核心比较目标。',
        priority: 'required',
        success_criterion_ids: ['criterion-market'],
        evidence_requirements: structuredClone(evidencePolicy),
        acceptance_criteria: ['至少比较三个方案并逐项给出公开来源'],
        depends_on: [],
      },
      {
        id: 'question-action',
        statement: '产品团队应如何选择？',
        rationale: '把事实比较转化为行动建议。',
        priority: 'required',
        success_criterion_ids: ['criterion-action'],
        evidence_requirements: structuredClone(evidencePolicy),
        acceptance_criteria: ['建议明确说明适用条件和取舍'],
        depends_on: ['question-market'],
      },
    ],
  };
}

function expectGraphError(
  graph: ProblemGraph,
  kind: ProblemGraphValidationError['kind'],
  ids: string[],
): void {
  assert.throws(
    () => validateProblemGraphCoverage(task, graph),
    (error: unknown) => {
      assert.ok(error instanceof ProblemGraphValidationError);
      assert.equal(error.kind, kind);
      for (const id of ids) {
        assert.ok(error.issueIds.includes(id), `typed error must include ${id}`);
        assert.match(error.message, new RegExp(id));
      }
      return true;
    },
  );
}

test('problem-graph schema is registered and strictly rejects malformed questions', () => {
  const spec = resolveSchema('problem-graph');
  const schemaText = loadSchemaText(spec);
  assert.equal(spec.file, 'problem-graph.schema.json');
  assert.ok(schemaText);

  const malformed = validGraph() as ProblemGraph & { unexpected: boolean };
  malformed.unexpected = true;
  malformed.questions[0].statement = '';
  assert.throws(
    () => new SchemaValidator().validateOrThrow('problem-graph', malformed),
    SchemaValidationError,
  );
});

test('pure validator accepts a covered acyclic problem graph', () => {
  assert.doesNotThrow(() => validateProblemGraphCoverage(task, validGraph()));
});

test('pure validator rejects duplicate question IDs', () => {
  const graph = validGraph();
  graph.questions[1].id = 'question-market';
  graph.questions[1].depends_on = [];
  expectGraphError(graph, 'duplicate_question_id', ['question-market']);
});

test('pure validator rejects dependencies that do not exist', () => {
  const graph = validGraph();
  graph.questions[1].depends_on = ['question-missing'];
  expectGraphError(graph, 'unknown_dependency', ['question-action', 'question-missing']);
});

test('pure validator rejects dependency cycles and reports every question in the cycle', () => {
  const graph = validGraph();
  graph.questions[0].depends_on = ['question-action'];
  expectGraphError(graph, 'dependency_cycle', ['question-market', 'question-action']);
});

test('pure validator rejects an uncovered success criterion', () => {
  const graph = validGraph();
  graph.questions[1].success_criterion_ids = ['criterion-market'];
  expectGraphError(graph, 'uncovered_success_criterion', ['criterion-action']);
});

test('pure validator rejects a success criterion covered only by an optional question', () => {
  const graph = validGraph();
  graph.questions[1]!.priority = 'optional';
  expectGraphError(graph, 'uncovered_success_criterion', ['criterion-action']);
});

test('pure validator rejects a required question without a success criterion', () => {
  const graph = validGraph();
  graph.questions[0].success_criterion_ids = [];
  expectGraphError(graph, 'required_question_without_success_criterion', ['question-market']);
});

test('pure validator rejects a question that references an unknown success criterion', () => {
  const graph = validGraph();
  graph.questions[0].success_criterion_ids = ['criterion-missing'];
  expectGraphError(graph, 'unknown_success_criterion', ['question-market', 'criterion-missing']);
});

test('pure validator rejects a required question without required evidence', () => {
  const graph = validGraph();
  graph.questions[0].evidence_requirements[0].required = false;
  expectGraphError(graph, 'required_question_without_required_evidence', ['question-market']);
});

test('pure validator rejects a graph that omits a configured evidence requirement', () => {
  const graph = validGraph();
  for (const question of graph.questions) question.evidence_requirements = [];
  assert.throws(
    () => validateProblemGraphEvidenceCoverage(graph, evidencePolicy),
    (error: unknown) => error instanceof ProblemGraphValidationError
      && error.kind === 'missing_required_evidence'
      && error.issueIds.includes('public-source'),
  );
});

class MemoryRecorder {
  readonly calls: ModelCallRecordInput[] = [];

  async recordModelCall(input: ModelCallRecordInput): Promise<string> {
    this.calls.push(input);
    return '11111111-1111-4111-8111-111111111122';
  }
}

class GraphProvider implements LLMClient {
  readonly calls: StructuredLLMCallOptions[] = [];
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway',
    endpointHost: 'llm.test',
    requestedModel: 'routing-alias',
    mode: 'real',
    eligibleAsReal: true,
  };

  constructor(
    private readonly fixture: unknown | ((callNumber: number) => unknown),
    private readonly actualModel = 'problem-graph-model',
  ) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    const fixture = typeof this.fixture === 'function'
      ? this.fixture(this.calls.length - 1)
      : this.fixture;
    return {
      data: structuredClone(fixture) as T,
      promptHash: hashPrompt(options.prompt, options.context, options.schemaName),
      modelName: this.actualModel,
      modelVersion: '2026-08-14',
      traceId: 'trace-problem-graph',
      tokens: { prompt: 10, completion: 20, total: 30 },
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('unused');
  }
}

function buildPlanner(fixture: unknown) {
  const provider = new GraphProvider(fixture);
  const recorder = new MemoryRecorder();
  const planner = new ProblemGraphPlanner({
    llm: new ReceiptLLMClient(provider, recorder),
    validator: new SchemaValidator(),
    guidance,
    evidenceRequirements: evidencePolicy,
    expectedActualModel: 'problem-graph-model',
  });
  return { provider, recorder, planner };
}

test('planner loads the registered schema, hashes only finalized inputs, and records the actual model pin', async () => {
  const { provider, recorder, planner } = buildPlanner(validGraph());
  const result = await planner.build(task);
  const call = provider.calls[0];
  const expectedContext = { task, guidance, evidencePolicy };
  const registeredSchema = JSON.parse(loadSchemaText(resolveSchema('problem-graph')) ?? 'null');

  assert.deepEqual(result.graph, validGraph());
  assert.deepEqual(result.provenance, {
    receiptId: '11111111-1111-4111-8111-111111111122',
    modelName: 'problem-graph-model',
    modelVersion: '2026-08-14',
    promptHash: call ? hashPrompt(call.prompt, expectedContext, 'problem-graph') : '',
    traceId: 'trace-problem-graph',
  });
  assert.equal(provider.calls.length, 1);
  assert.equal(call.schemaName, 'problem-graph');
  assert.deepEqual(call.schema, registeredSchema);
  assert.deepEqual(call.context, expectedContext);
  assert.deepEqual(Object.keys(call.context ?? {}).sort(), ['evidencePolicy', 'guidance', 'task']);
  assert.deepEqual(call.receipt, {
    stage: 'problem_graph',
    contextManifestHash: hashPrompt('', expectedContext),
    expectedModel: 'problem-graph-model',
  });

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].stage, 'problem_graph');
  assert.equal(recorder.calls[0].requestedModel, 'routing-alias');
  assert.equal(recorder.calls[0].actualModel, 'problem-graph-model');
  assert.equal(recorder.calls[0].contextManifestHash, hashPrompt('', expectedContext));
  assert.equal(recorder.calls[0].status, 'succeeded');
});

test('planner never returns a graph that fails JSON Schema validation', async () => {
  const malformed = validGraph() as ProblemGraph & { unexpected: boolean };
  malformed.unexpected = true;
  const { planner } = buildPlanner(malformed);
  await assert.rejects(() => planner.build(task), SchemaValidationError);
});

test('planner never returns a structurally valid graph that fails coverage validation', async () => {
  const malformed = validGraph();
  malformed.questions[1].depends_on = ['question-missing'];
  const { planner } = buildPlanner(malformed);
  await assert.rejects(
    () => planner.build(task),
    (error: unknown) => error instanceof ProblemGraphValidationError
      && error.kind === 'unknown_dependency'
      && error.issueIds.includes('question-missing'),
  );
});

test('planner repairs a graph that omits a required success criterion', async () => {
  const uncovered = validGraph();
  uncovered.questions[1].success_criterion_ids = ['criterion-market'];
  const { provider, recorder, planner } = buildPlanner((callNumber: number) => (
    callNumber === 0 ? uncovered : validGraph()
  ));

  const result = await planner.build(task);

  assert.deepEqual(result.graph, validGraph());
  assert.equal(provider.calls.length, 2);
  assert.deepEqual((provider.calls[1]?.context as Record<string, unknown>)?.validation_feedback, [
    'problem graph uncovered_success_criterion: criterion-action',
  ]);
  assert.equal(recorder.calls.length, 2);
});

test('planner repairs a graph that omits a configured evidence requirement', async () => {
  const provider = new GraphProvider((callNumber: number) => {
    if (callNumber === 0) {
      const missingEvidence = validGraph();
      for (const question of missingEvidence.questions) question.evidence_requirements = [];
      return missingEvidence;
    }
    return validGraph();
  });
  const recorder = new MemoryRecorder();
  const planner = new ProblemGraphPlanner({
    llm: new ReceiptLLMClient(provider, recorder),
    validator: new SchemaValidator(),
    guidance,
    evidenceRequirements: evidencePolicy,
    expectedActualModel: 'problem-graph-model',
  });

  const result = await planner.build(task);
  assert.deepEqual(result.graph, validGraph());
  assert.equal(provider.calls.length, 2);
  assert.deepEqual((provider.calls[1]?.context as Record<string, unknown>)?.validation_feedback, [
    'problem graph missing_required_evidence: public-source',
  ]);
  assert.equal(recorder.calls.length, 2);
});

test('planner repairs one required question without required evidence when policy is covered elsewhere', async () => {
  const provider = new GraphProvider((callNumber: number) => {
    if (callNumber === 0) {
      const partiallyCovered = validGraph();
      partiallyCovered.questions[0].evidence_requirements = [];
      return partiallyCovered;
    }
    return validGraph();
  });
  const recorder = new MemoryRecorder();
  const planner = new ProblemGraphPlanner({
    llm: new ReceiptLLMClient(provider, recorder),
    validator: new SchemaValidator(),
    guidance,
    evidenceRequirements: evidencePolicy,
    expectedActualModel: 'problem-graph-model',
  });

  const result = await planner.build(task);
  assert.deepEqual(result.graph, validGraph());
  assert.equal(provider.calls.length, 2);
  assert.deepEqual((provider.calls[1]?.context as Record<string, unknown>)?.validation_feedback, [
    'problem graph required_question_without_required_evidence: question-market',
  ]);
  assert.match(provider.calls[1]?.prompt ?? '', /ProblemGraph 覆盖约束/);
  assert.equal(recorder.calls.length, 2);
});
