import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { ProblemGraph } from '../packages/api-contract/research-deliverable.ts';
import {
  CapabilityDemandGraphValidationError,
  validateCapabilityDemandGraph,
  type CapabilityDemandGraphV1,
} from '../apps/orchestrator-runtime/src/planners/capability-demand-graph.ts';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'research_synthesis',
  outcome_mode: 'answer',
  requested_artifacts: ['strategy_map'],
  business_domain: 'crowdfunding',
  research_goal: '分析众筹市场与访问动机，并输出策略地图',
  target_audience: ['产品团队'],
  scope: ['公开资料'],
  constraints: [],
  success_criteria: [
    { id: 'criterion-market', statement: '说明市场差异' },
    { id: 'criterion-motivation', statement: '解释访问动机' },
  ],
  expected_deliverables: ['research_strategy_report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

const problemGraph: ProblemGraph = {
  version: 'problem-graph-v1',
  questions: [
    {
      id: 'question-market',
      statement: '主要市场与竞品差异是什么？',
      rationale: '形成市场判断。',
      priority: 'required',
      success_criterion_ids: ['criterion-market'],
      evidence_requirements: [{
        id: 'evidence-market',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
      acceptance_criteria: ['给出有公开来源的直接答案'],
      depends_on: [],
    },
    {
      id: 'question-motivation',
      statement: '用户访问众筹频道的核心动机是什么？',
      rationale: '形成用户侧策略。',
      priority: 'required',
      success_criterion_ids: ['criterion-motivation'],
      evidence_requirements: [{
        id: 'evidence-user',
        acceptedClasses: ['user_input', 'simulation'],
        minimumCount: 1,
        required: true,
      }],
      acceptance_criteria: ['区分事实与待验证假设'],
      depends_on: [],
    },
  ],
};

function validGraph(): CapabilityDemandGraphV1 {
  return {
    version: 'capability-demand-graph-v1',
    demands: [
      {
        id: 'demand-market',
        type: 'market_landscape',
        questionIds: ['question-market'],
        requestedArtifactTypes: ['strategy_map'],
        requiredEvidenceClasses: ['public_source'],
        requiredInputRoles: [],
        priority: 'required',
      },
      {
        id: 'demand-motivation',
        type: 'jobs_to_be_done',
        questionIds: ['question-motivation'],
        requestedArtifactTypes: [],
        requiredEvidenceClasses: ['user_input'],
        requiredInputRoles: ['research_goal'],
        priority: 'required',
      },
    ],
  };
}

function expectDemandError(
  graph: CapabilityDemandGraphV1,
  kind: CapabilityDemandGraphValidationError['kind'],
  issueIds: string[],
  inputTask: ResearchTaskV2 = task,
): void {
  assert.throws(
    () => validateCapabilityDemandGraph({ task: inputTask, problemGraph, graph }),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityDemandGraphValidationError);
      assert.equal(error.kind, kind);
      for (const issueId of issueIds) assert.ok(error.issueIds.includes(issueId));
      return true;
    },
  );
}

test('capability demand graph schema is registered and rejects unknown demand types', () => {
  const spec = resolveSchema('capability-demand-graph-v1');
  assert.equal(spec.file, 'capability-demand-graph-v1.schema.json');
  assert.ok(loadSchemaText(spec)?.includes('capability-demand-graph-v1'));

  const malformed = validGraph() as CapabilityDemandGraphV1 & { unexpected?: boolean };
  malformed.unexpected = true;
  malformed.demands[0]!.type = 'unknown' as CapabilityDemandGraphV1['demands'][number]['type'];
  assert.throws(
    () => new SchemaValidator().validateOrThrow('capability-demand-graph-v1', malformed),
    SchemaValidationError,
  );
});

test('capability demand graph accepts complete required question and artifact coverage', () => {
  assert.doesNotThrow(() => validateCapabilityDemandGraph({ task, problemGraph, graph: validGraph() }));
});

test('capability demand graph rejects a required question without a required demand', () => {
  const graph = validGraph();
  graph.demands = graph.demands.filter(({ id }) => id !== 'demand-motivation');
  expectDemandError(graph, 'required_question_without_demand', ['question-motivation']);
});

test('capability demand graph rejects unknown question, artifact, and incompatible evidence references', () => {
  const unknownQuestion = validGraph();
  unknownQuestion.demands[0]!.questionIds = ['question-missing'];
  expectDemandError(unknownQuestion, 'unknown_question', ['demand-market', 'question-missing']);

  const unrequestedArtifact = validGraph();
  unrequestedArtifact.demands[0]!.requestedArtifactTypes = ['mind_model'];
  expectDemandError(unrequestedArtifact, 'unrequested_artifact', ['demand-market', 'mind_model']);

  const incompatibleEvidence = validGraph();
  incompatibleEvidence.demands[0]!.requiredEvidenceClasses = ['dataset'];
  expectDemandError(incompatibleEvidence, 'unsupported_question_evidence', ['demand-market', 'question-market', 'dataset']);
});

test('explicit virtual-user requirements require a virtual-user hypothesis demand', () => {
  const virtualTask: ResearchTaskV2 = {
    ...task,
    research_goal: '使用 AI 虚拟用户调研访问动机并形成策略',
  };
  expectDemandError(validGraph(), 'missing_virtual_user_demand', ['virtual_user_hypothesis'], virtualTask);

  const graph = validGraph();
  graph.demands.push({
    id: 'demand-virtual-user',
    type: 'virtual_user_hypothesis',
    questionIds: ['question-motivation'],
    requestedArtifactTypes: [],
    requiredEvidenceClasses: ['simulation'],
    requiredInputRoles: ['research_goal'],
    priority: 'required',
  });
  assert.doesNotThrow(() => validateCapabilityDemandGraph({
    task: virtualTask,
    problemGraph,
    graph,
  }));
});

test('quantitative fact demands fail without data while measurement demands remain valid', () => {
  const metricTask: ResearchTaskV2 = {
    ...task,
    research_goal: '回答当前 UV 和转化率是多少',
    requested_artifacts: [],
  };
  const metricProblemGraph: ProblemGraph = {
    version: 'problem-graph-v1',
    questions: [{
      ...structuredClone(problemGraph.questions[0]!),
      id: 'question-metric',
      statement: '当前 UV 和转化率是多少？',
      evidence_requirements: [{
        id: 'evidence-metric',
        acceptedClasses: ['dataset'],
        minimumCount: 1,
        required: true,
      }],
    }],
  };
  const graph: CapabilityDemandGraphV1 = {
    version: 'capability-demand-graph-v1',
    demands: [{
      id: 'demand-metric',
      type: 'metrics',
      questionIds: ['question-metric'],
      requestedArtifactTypes: [],
      requiredEvidenceClasses: ['dataset'],
      requiredInputRoles: ['analytics_dataset'],
      priority: 'required',
    }],
  };
  assert.throws(
    () => validateCapabilityDemandGraph({
      task: metricTask,
      problemGraph: metricProblemGraph,
      graph,
      availableInputRoles: [],
    }),
    (error: unknown) => error instanceof CapabilityDemandGraphValidationError
      && error.kind === 'quantitative_fact_without_data',
  );

  metricProblemGraph.questions[0]!.statement = '如何定义 UV 与转化率口径并设计验证方案？';
  assert.doesNotThrow(() => validateCapabilityDemandGraph({
    task: metricTask,
    problemGraph: metricProblemGraph,
    graph,
    availableInputRoles: [],
  }));
});
