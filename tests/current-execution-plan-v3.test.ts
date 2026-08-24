import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentExecutionPlanV3 } from '../packages/api-contract/research-deliverable.ts';
import {
  CurrentExecutionPlanV3ValidationError,
  validateCurrentExecutionPlanV3,
} from '../apps/orchestrator-runtime/src/planners/current-execution-plan-v3.ts';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const hash = `sha256:${'a'.repeat(64)}`;

function validPlan(): CurrentExecutionPlanV3 {
  return {
    task_id: 'task-1',
    execution_contract_version: 'current-execution-plan-v3',
    deliverable_type: 'research_strategy_report',
    evidence_requirements: [{
      id: 'evidence-public',
      acceptedClasses: ['public_source'],
      minimumCount: 1,
      required: true,
    }],
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'question-market',
        statement: '市场差异是什么？',
        rationale: '回答核心决策问题。',
        priority: 'required',
        success_criterion_ids: ['criterion-market'],
        evidence_requirements: [{
          id: 'evidence-public',
          acceptedClasses: ['public_source'],
          minimumCount: 1,
          required: true,
        }],
        acceptance_criteria: ['给出有来源的直接答案'],
        depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'planner',
      modelVersion: '2026-08-24',
      promptHash: hash,
      traceId: 'trace-1',
    },
    capability_demand_graph: {
      version: 'capability-demand-graph-v1',
      demands: [{
        id: 'demand-market',
        type: 'market_landscape',
        questionIds: ['question-market'],
        requestedArtifactTypes: ['strategy_map'],
        requiredEvidenceClasses: ['public_source'],
        requiredInputRoles: [],
        priority: 'required',
      }],
    },
    capability_decisions: { eligible: [], rejected: [] },
    skill_invocations: [
      {
        invocation_id: 'invocation-market',
        skill_id: 'competitive-web-research',
        role: 'contributor',
        contribution_types: ['market_landscape'],
        question_ids: ['question-market'],
        requested_artifact_types: ['strategy_map'],
        depends_on_invocation_ids: [],
        output_contract: 'research-contribution-v1',
        required: true,
        failure_policy: 'block',
        execution_mode: 'legacy_single_call',
        step_nos: [1],
      },
      {
        invocation_id: 'invocation-synthesis',
        skill_id: 'research-strategy-synthesis',
        role: 'synthesizer',
        contribution_types: ['strategy'],
        question_ids: ['question-market'],
        requested_artifact_types: ['strategy_map'],
        depends_on_invocation_ids: ['invocation-market'],
        output_contract: 'research-strategy-content-v2',
        required: true,
        failure_policy: 'block',
        execution_mode: 'legacy_single_call',
        step_nos: [2],
      },
    ],
    contribution_requirements: [{
      id: 'demand-market',
      demand_type: 'market_landscape',
      question_ids: ['question-market'],
      requested_artifact_types: ['strategy_map'],
      owner_invocation_id: 'invocation-market',
      corroborator_invocation_ids: [],
      required: true,
    }],
    steps: [
      {
        step_no: 1,
        step_name: '市场贡献',
        actor_type: 'skill',
        actor_id: 'competitive-web-research',
        question_ids: ['question-market'],
        depends_on: [],
        input: {},
        input_bindings: [],
        expected_outputs: [{ pointer: '/units', description: '标准研究贡献' }],
        acceptance_criteria: ['输出可追溯贡献'],
        requires_approval: false,
        fallback_actor_ids: [],
        skill_invocation_id: 'invocation-market',
        skill_stage_id: 'contribute',
      },
      {
        step_no: 2,
        step_name: '组合研究答案',
        actor_type: 'skill',
        actor_id: 'research-strategy-synthesis',
        question_ids: ['question-market'],
        depends_on: [1],
        input: {},
        input_bindings: [{
          target_pointer: '/contributions/0',
          source_step_no: 1,
          source_pointer: '/units',
        }],
        expected_outputs: [{ pointer: '/contentBlocks', description: '已组合语义草稿' }],
        acceptance_criteria: ['覆盖必答问题'],
        requires_approval: false,
        fallback_actor_ids: [],
        skill_invocation_id: 'invocation-synthesis',
        skill_stage_id: 'synthesize',
      },
    ],
    candidate_metadata: {
      title: '深度组合研究',
      rationale: '由市场 Contributor 与统一 Synthesizer 完成。',
      tradeoffs: '成本较高但覆盖完整。',
      recommended: true,
    },
    activated_nodes: ['skill:competitive-web-research', 'skill:research-strategy-synthesis'],
  };
}

function expectPlanError(
  plan: CurrentExecutionPlanV3,
  kind: CurrentExecutionPlanV3ValidationError['kind'],
  issueIds: string[],
): void {
  assert.throws(
    () => validateCurrentExecutionPlanV3(plan),
    (error: unknown) => {
      assert.ok(error instanceof CurrentExecutionPlanV3ValidationError);
      assert.equal(error.kind, kind);
      for (const issueId of issueIds) assert.ok(error.issueIds.includes(issueId));
      return true;
    },
  );
}

test('CurrentExecutionPlan v3 schema is registered and accepted by the version-aware reader', () => {
  const spec = resolveSchema('current-execution-plan-v3');
  assert.equal(spec.file, 'current-execution-plan-v3.schema.json');
  assert.ok(loadSchemaText(spec)?.includes('current-execution-plan-v3'));

  const validator = new SchemaValidator();
  assert.doesNotThrow(() => validator.validateOrThrow('current-execution-plan-v3', validPlan()));
  assert.doesNotThrow(() => validator.validateOrThrow('current-execution-plan', validPlan()));
});

test('CurrentExecutionPlan v3 requires invocations and complete shared-stage metadata', () => {
  const validator = new SchemaValidator();
  const noInvocations = validPlan() as CurrentExecutionPlanV3 & { skill_invocations?: CurrentExecutionPlanV3['skill_invocations'] };
  delete noInvocations.skill_invocations;
  assert.throws(
    () => validator.validateOrThrow('current-execution-plan-v3', noInvocations),
    SchemaValidationError,
  );

  const partialSharedStage = validPlan();
  partialSharedStage.steps[0]!.shared_stage_key = 'shared:evidence';
  assert.throws(
    () => validator.validateOrThrow('current-execution-plan-v3', partialSharedStage),
    SchemaValidationError,
  );
});

test('CurrentExecutionPlan v3 accepts exactly one synthesizer', () => {
  assert.doesNotThrow(() => validateCurrentExecutionPlanV3(validPlan()));

  const noSynthesizer = validPlan();
  noSynthesizer.skill_invocations[1]!.role = 'contributor';
  expectPlanError(noSynthesizer, 'synthesizer_count', []);

  const twoSynthesizers = validPlan();
  twoSynthesizers.skill_invocations[0]!.role = 'synthesizer';
  expectPlanError(twoSynthesizers, 'synthesizer_count', [
    'invocation-market',
    'invocation-synthesis',
  ]);
});

test('CurrentExecutionPlan v3 rejects required demand without an owner', () => {
  const plan = validPlan();
  plan.contribution_requirements = [];
  expectPlanError(plan, 'required_demand_without_owner', ['demand-market']);
});

test('CurrentExecutionPlan v3 rejects unknown or inconsistent owners and duplicate primary ownership', () => {
  const unknownOwner = validPlan();
  unknownOwner.contribution_requirements[0]!.owner_invocation_id = 'invocation-missing';
  expectPlanError(unknownOwner, 'unknown_owner_invocation', ['demand-market', 'invocation-missing']);

  const mismatchedCoverage = validPlan();
  mismatchedCoverage.contribution_requirements[0]!.demand_type = 'persona';
  expectPlanError(mismatchedCoverage, 'demand_coverage_mismatch', ['demand-market']);

  const duplicateOwner = validPlan();
  duplicateOwner.capability_demand_graph.demands.push({
    ...structuredClone(duplicateOwner.capability_demand_graph.demands[0]!),
    id: 'demand-market-secondary',
  });
  duplicateOwner.contribution_requirements.push({
    ...structuredClone(duplicateOwner.contribution_requirements[0]!),
    id: 'demand-market-secondary',
    owner_invocation_id: 'invocation-synthesis',
  });
  expectPlanError(duplicateOwner, 'multiple_primary_owners', [
    'question-market',
    'invocation-market',
    'invocation-synthesis',
  ]);
});

test('CurrentExecutionPlan v3 requires blocking policy for required owners and the synthesizer', () => {
  const optionalOwner = validPlan();
  optionalOwner.skill_invocations[0]!.required = false;
  optionalOwner.skill_invocations[0]!.failure_policy = 'gap';
  expectPlanError(optionalOwner, 'required_owner_may_gap', ['invocation-market', 'demand-market']);

  const optionalSynthesizer = validPlan();
  optionalSynthesizer.skill_invocations[1]!.required = false;
  optionalSynthesizer.skill_invocations[1]!.failure_policy = 'gap';
  expectPlanError(optionalSynthesizer, 'synthesizer_may_gap', ['invocation-synthesis']);
});

test('legacy v1 and compiled v2 plans still use the existing schema', () => {
  const validator = new SchemaValidator();
  const legacy = validPlan() as unknown as Record<string, unknown>;
  delete legacy.execution_contract_version;
  delete legacy.skill_invocations;
  delete legacy.capability_demand_graph;
  delete legacy.contribution_requirements;
  assert.deepEqual(validator.validate('current-execution-plan', legacy), []);
});
