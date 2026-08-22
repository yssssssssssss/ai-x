import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PlanCompiler,
  validateCurrentPlanRevision,
} from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { compileSkillSteps } from '../apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts';
import { loadSkillExecutionContract } from '../apps/orchestrator-runtime/src/skills/skill-execution-contract.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { CurrentPlanStep } from '../packages/api-contract/research-deliverable.ts';

test('compiled generate-research-plan loads one validated acyclic execution contract', () => {
  const loaded = new SkillLoader().loadSkillExecution('generate-research-plan');
  assert.ok(loaded);
  assert.equal(loaded.contract.skill_id, 'generate-research-plan');
  assert.equal(loaded.contract.version, 'skill-execution-contract-v1');
  assert.match(loaded.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.contract.stages.map(({ stage_id }) => stage_id), [
    'load-standards',
    'external-context',
    'align-brief',
    'select-methods',
    'design-sampling-and-schedule',
    'compose-plan',
    'self-review',
  ]);
  assert.equal(loaded.contract.output_stage_id, 'compose-plan');
  assert.deepEqual(loaded.contract.skill_references, [
    'references/brief-skeleton.md',
    'references/plan-skeleton.md',
    'references/run-notes-template.md',
  ]);
});

test('execution contract rejects a mismatched Skill identity and absolute paths', () => {
  assert.throws(
    () => loadSkillExecutionContract(
      'orchestrator/skill-executions/generate-research-plan.yaml',
      'another-skill',
    ),
    /does not match/u,
  );
  assert.throws(
    () => loadSkillExecutionContract('/tmp/contract.yaml', 'generate-research-plan'),
    /must be relative/u,
  );
});

test('compiled Skill expands one visible frozen seven-stage DAG', () => {
  const task: ResearchTaskV2 = {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: '宠物用户研究',
    research_goal: '规划用户旅程、深度访谈与问卷分析',
    target_audience: ['平台运营团队'],
    scope: ['手机 App 用户旅程'],
    constraints: [],
    success_criteria: [{ id: 'SC-1', statement: 'plan is executable' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  const common = {
    question_ids: ['Q1'],
    input_bindings: [],
    acceptance_criteria: ['valid'],
    requires_approval: false,
    fallback_actor_ids: [],
  };
  const steps: CurrentPlanStep[] = [
    {
      ...common,
      step_no: 1,
      step_name: 'search',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      depends_on: [],
      input: { query: 'pet brand study' },
      expected_outputs: [{ pointer: '/results', description: 'results' }],
    },
    {
      ...common,
      step_no: 2,
      step_name: 'plan',
      actor_type: 'skill',
      actor_id: 'generate-research-plan',
      depends_on: [1],
      input: {},
      expected_outputs: [{ pointer: '/payload', description: 'plan' }],
    },
    {
      ...common,
      step_no: 3,
      step_name: 'review',
      actor_type: 'reviewer',
      actor_id: 'reviewer.research-lead',
      depends_on: [2],
      input: {},
      expected_outputs: [{ pointer: '/review', description: 'review' }],
    },
  ];

  const compiled = compileSkillSteps(steps, task);
  assert.equal(compiled.invocations.length, 1);
  assert.equal(compiled.steps.length, 7);
  assert.deepEqual(compiled.steps.map(({ skill_stage_id }) => skill_stage_id), [
    'external-context',
    'load-standards',
    'align-brief',
    'select-methods',
    'design-sampling-and-schedule',
    'compose-plan',
    'self-review',
  ]);
  assert.deepEqual(compiled.invocations[0]?.step_nos, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(compiled.steps[1]?.actor_type, 'knowledge');
  const references = compiled.steps[1]?.input.references;
  assert.ok(Array.isArray(references) && references.length > 3, 'task-matched dynamic knowledge must be frozen');
  assert.equal(compiled.steps[5]?.actor_type, 'skill');
  assert.equal(compiled.steps[6]?.depends_on.includes(6), true);
});

test('PlanCompiler persists the compiled Skill invocation and seven visible stages', () => {
  const loader = new SkillLoader();
  const skill = loader.listCapabilitySkills().find((candidate) => candidate.id === 'generate-research-plan');
  assert.ok(skill?.status === 'active');
  const task: ResearchTaskV2 = {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: 'pet services',
    research_goal: 'plan a pet-brand mindshare study',
    target_audience: ['platform operations'],
    scope: ['mobile app'],
    constraints: [],
    success_criteria: [{ id: 'SC-1', statement: 'plan is executable' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  const common = {
    question_ids: ['Q1'], input_bindings: [], acceptance_criteria: ['valid'],
    requires_approval: false, fallback_actor_ids: [],
  };
  const compiled = new PlanCompiler().compile({
    candidate: {
      id: 'depth', title: 'Depth', rationale: 'Compiled Skill', tradeoffs: 'More stages',
      assumptions: [], activated_nodes: [],
      steps: [
        { ...common, step_no: 1, step_name: 'Search', actor_type: 'tool', actor_id: 'tavily-web-search', depends_on: [], input: { query: 'pet research' }, expected_outputs: [{ pointer: '/results', description: 'results' }] },
        { ...common, step_no: 2, step_name: 'Plan', actor_type: 'skill', actor_id: 'generate-research-plan', depends_on: [1], input: {}, expected_outputs: [{ pointer: '/payload', description: 'plan' }] },
        { ...common, step_no: 3, step_name: 'Review', actor_type: 'reviewer', actor_id: 'reviewer.research-lead', depends_on: [2], input: {}, expected_outputs: [{ pointer: '/review', description: 'review' }] },
      ],
    },
    task,
    deliverable_selection: {
      deliverableId: 'research_plan',
      evidenceRequirements: [{ id: 'research-plan', acceptedClasses: ['public_source', 'knowledge'], minimumCount: 1, required: true }],
    },
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'Q1', statement: 'How should the study run?', rationale: 'Decision support', priority: 'required',
        success_criterion_ids: ['SC-1'],
        evidence_requirements: [{ id: 'research-plan', acceptedClasses: ['public_source', 'knowledge'], minimumCount: 1, required: true }],
        acceptance_criteria: ['Executable plan'], depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111', modelName: 'model', modelVersion: 'v1', promptHash: 'sha256:test', traceId: 'trace',
    },
    capability_resolution: {
      eligible: [{ skill, reasons: [{ code: 'eligible', message: 'eligible' }], pending_inputs: [], required_approvals: [], optional_tool_decisions: [] }],
      rejected: [],
    },
    evidence_requirements: [{ id: 'research-plan', acceptedClasses: ['public_source', 'knowledge'], minimumCount: 1, required: true }],
    activated_nodes: [],
  });

  assert.equal(compiled.plan.execution_contract_version, 'current-execution-plan-v2');
  assert.equal(compiled.plan.skill_invocations?.length, 1);
  assert.equal(compiled.plan.steps.length, 7);
  assert.deepEqual(compiled.plan.steps.map(({ skill_stage_id }) => skill_stage_id), [
    'external-context', 'load-standards', 'align-brief', 'select-methods',
    'design-sampling-and-schedule', 'compose-plan', 'self-review',
  ]);
  const frozen = { ...compiled.plan, task_id: 'task-compiled-plan-1' };
  assert.deepEqual(validateCurrentPlanRevision({
    plan: frozen,
    task,
    pending_inputs: compiled.pending_inputs,
    task_id: frozen.task_id,
    candidate_id: 'depth',
  }), frozen);
});

test('legacy Skills do not expose an execution contract', () => {
  assert.equal(new SkillLoader().loadSkillExecution('generate-survey'), null);
});
