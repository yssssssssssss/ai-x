import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentExecutionPlanV3 } from '../packages/api-contract/research-deliverable.ts';
import {
  CurrentExecutionPlanV3ValidationError,
  validateCurrentExecutionPlanV3,
} from '../apps/orchestrator-runtime/src/planners/current-execution-plan-v3.ts';
import { planShareFingerprint } from '../apps/orchestrator-runtime/src/skills/portfolio-skill-plan-compiler.ts';
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
    portfolio_summary: {
      profile_id: 'depth',
      selected: [
        {
          invocation_id: 'invocation-market',
          skill_id: 'competitive-web-research',
          role: 'contributor',
          reason_codes: ['required_demand_coverage'],
          estimated_steps: 1,
        },
        {
          invocation_id: 'invocation-synthesis',
          skill_id: 'research-strategy-synthesis',
          role: 'synthesizer',
          reason_codes: ['deliverable_policy_owner'],
          estimated_steps: 1,
        },
      ],
      rejected: [],
      shared_prerequisites: [],
      estimated_budget: {
        max_steps: 8,
        estimated_steps: 2,
        selected_contributor_count: 1,
        selected_skill_count: 2,
        required_demand_count: 1,
        optional_demand_count: 0,
        expanded_step_count: 2,
        expanded_step_limit: 8,
      },
    },
    capability_decisions: { eligible: [], rejected: [] },
    skill_invocations: [
      {
        invocation_id: 'invocation-market',
        skill_id: 'competitive-web-research',
        role: 'contributor',
        demand_ids: ['demand-market'],
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
        demand_ids: [],
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

function validSharedPlan(): CurrentExecutionPlanV3 {
  const plan = validPlan();
  const market = plan.steps[0]!;
  const synthesis = plan.steps[1]!;
  const shared = {
    step_no: 1,
    step_name: '共享公开证据',
    actor_type: 'tool' as const,
    actor_id: 'tavily-web-search',
    question_ids: ['question-market'],
    depends_on: [],
    input: { query: 'market evidence' },
    input_bindings: [],
    expected_outputs: [{ pointer: '/results', description: '公开资料' }],
    acceptance_criteria: ['来源可追溯'],
    requires_approval: false,
    fallback_actor_ids: [],
    shared_stage_key: 'shared:tool:tavily-web-search',
    shared_by_invocation_ids: ['invocation-market', 'invocation-synthesis'],
    share_fingerprint: '',
  };
  shared.share_fingerprint = planShareFingerprint(shared);
  plan.steps = [
    shared,
    { ...market, step_no: 2, depends_on: [1] },
    {
      ...synthesis,
      step_no: 3,
      depends_on: [1, 2],
      input_bindings: synthesis.input_bindings.map((binding) => ({
        ...binding,
        source_step_no: 2,
      })),
    },
  ];
  plan.skill_invocations[0]!.step_nos = [1, 2];
  plan.skill_invocations[1]!.step_nos = [1, 3];
  plan.portfolio_summary.shared_prerequisites = [{
    capability_type: 'tool',
    capability_id: 'tavily-web-search',
    consumer_skill_ids: ['competitive-web-research', 'research-strategy-synthesis'],
  }];
  plan.portfolio_summary.estimated_budget.expanded_step_count = 3;
  return plan;
}

function directAnswerPlan(): CurrentExecutionPlanV3 {
  const plan = validPlan();
  const synthesizer = plan.skill_invocations[1]!;
  synthesizer.demand_ids = ['demand-market'];
  synthesizer.contribution_types = ['market_landscape'];
  synthesizer.depends_on_invocation_ids = [];
  synthesizer.step_nos = [1];
  plan.skill_invocations = [synthesizer];
  plan.portfolio_summary.selected = [plan.portfolio_summary.selected[1]!];
  plan.portfolio_summary.estimated_budget.estimated_steps = 1;
  plan.portfolio_summary.estimated_budget.selected_contributor_count = 0;
  plan.portfolio_summary.estimated_budget.selected_skill_count = 1;
  plan.portfolio_summary.estimated_budget.expanded_step_count = 1;
  plan.contribution_requirements = [];
  const synthesisStep = plan.steps[1]!;
  synthesisStep.step_no = 1;
  synthesisStep.depends_on = [];
  synthesisStep.input_bindings = [];
  plan.steps = [synthesisStep];
  return plan;
}

function validCompiledSharedPlan(): CurrentExecutionPlanV3 {
  const plan = validSharedPlan();
  const marketOutput = plan.steps[1]!;
  const synthesis = plan.steps[2]!;
  plan.steps = [
    plan.steps[0]!,
    {
      step_no: 2,
      step_name: '分析共享公开证据',
      actor_type: 'llm',
      actor_id: 'evidence-analyst',
      question_ids: ['question-market'],
      depends_on: [1],
      input: {},
      input_bindings: [],
      expected_outputs: [{ pointer: '/analysis', description: '证据分析' }],
      acceptance_criteria: ['仅使用共享公开证据'],
      requires_approval: false,
      fallback_actor_ids: [],
      skill_invocation_id: 'invocation-market',
      skill_stage_id: 'analyze',
    },
    { ...marketOutput, step_no: 3, depends_on: [2] },
    {
      ...synthesis,
      step_no: 4,
      depends_on: [1, 3],
      input_bindings: synthesis.input_bindings.map((binding) => ({
        ...binding,
        source_step_no: 3,
      })),
    },
  ];
  plan.skill_invocations[0] = {
    ...plan.skill_invocations[0]!,
    execution_mode: 'compiled',
    contract_version: 'skill-execution-contract-v1',
    contract_hash: hash,
    degraded_policy: 'block',
    skill_reference_hashes: [],
    knowledge_references: [],
    resource_gaps: [],
    step_nos: [1, 2, 3],
  };
  plan.skill_invocations[1]!.step_nos = [1, 4];
  plan.portfolio_summary.estimated_budget.expanded_step_count = 4;
  return plan;
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
  const noInvocations = structuredClone(validPlan()) as unknown as Record<string, unknown>;
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

test('CurrentExecutionPlan v3 accepts a required Demand answered directly by its Synthesizer', () => {
  assert.doesNotThrow(() => validateCurrentExecutionPlanV3(directAnswerPlan()));
});

test('CurrentExecutionPlan v3 rejects Synthesizer-owned Contribution requirements', () => {
  const plan = directAnswerPlan();
  plan.contribution_requirements = [{
    id: 'demand-market',
    demand_type: 'market_landscape',
    question_ids: ['question-market'],
    requested_artifact_types: ['strategy_map'],
    owner_invocation_id: 'invocation-synthesis',
    corroborator_invocation_ids: [],
    required: true,
  }];
  expectPlanError(plan, 'contribution_owner_not_contributor', [
    'demand-market',
    'invocation-synthesis',
  ]);
});

test('CurrentExecutionPlan v3 rejects one Demand frozen onto two invocations', () => {
  const plan = validPlan();
  plan.skill_invocations[1]!.demand_ids = ['demand-market'];
  plan.skill_invocations[1]!.contribution_types.push('market_landscape');
  expectPlanError(plan, 'multiple_demand_owners', [
    'demand-market',
    'invocation-market',
    'invocation-synthesis',
  ]);
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

test('CurrentExecutionPlan v3 rejects unknown and cyclic invocation dependencies', () => {
  const unknown = validPlan();
  unknown.skill_invocations[0]!.depends_on_invocation_ids = ['invocation-missing'];
  expectPlanError(unknown, 'unknown_invocation_dependency', [
    'invocation-market',
    'invocation-missing',
  ]);

  const cyclic = validPlan();
  cyclic.skill_invocations[0]!.depends_on_invocation_ids = ['invocation-synthesis'];
  expectPlanError(cyclic, 'invocation_dependency_cycle', [
    'invocation-market',
    'invocation-synthesis',
  ]);
});

test('CurrentExecutionPlan v3 requires Synthesizer dependency on every required Contributor', () => {
  const plan = validPlan();
  plan.skill_invocations[1]!.depends_on_invocation_ids = [];
  expectPlanError(plan, 'missing_required_contributor_dependency', [
    'invocation-synthesis',
    'invocation-market',
  ]);
});

test('CurrentExecutionPlan v3 rejects binding, step ownership, and topology drift', () => {
  const binding = validPlan();
  binding.steps[1]!.depends_on = [];
  expectPlanError(binding, 'invalid_binding_dependency', ['2', '1']);

  const ownership = validPlan();
  ownership.skill_invocations[0]!.step_nos = [2];
  expectPlanError(ownership, 'invalid_invocation_step', ['invocation-market', '2']);

  const topology = validPlan();
  topology.steps[0]!.depends_on = [2];
  expectPlanError(topology, 'invalid_step_topology', ['1']);
});

test('CurrentExecutionPlan v3 rejects forged shared-stage consumers and fingerprints', () => {
  const plan = validPlan();
  plan.steps[0]!.shared_stage_key = 'shared:tool:evidence';
  plan.steps[0]!.shared_by_invocation_ids = ['invocation-market', 'invocation-synthesis'];
  plan.steps[0]!.share_fingerprint = `sha256:${'0'.repeat(64)}`;
  plan.skill_invocations[1]!.step_nos.push(1);
  expectPlanError(plan, 'invalid_shared_stage', ['shared:tool:evidence', '1']);
});

test('CurrentExecutionPlan v3 rejects a shared stage that a legacy consumer does not directly consume', () => {
  const plan = validSharedPlan();
  plan.steps[1]!.depends_on = [];

  expectPlanError(plan, 'invalid_shared_stage', [
    'shared:tool:tavily-web-search',
    'invocation-market',
  ]);
});

test('CurrentExecutionPlan v3 accepts a binding from a shared stage with multiple authorized consumers', () => {
  const plan = validSharedPlan();
  plan.steps[1]!.input = { public_evidence: null };
  plan.steps[1]!.input_bindings = [{
    target_pointer: '/public_evidence',
    source_step_no: 1,
    source_pointer: '/results',
  }];

  assert.doesNotThrow(() => validateCurrentExecutionPlanV3(plan));
});

test('CurrentExecutionPlan v3 does not treat a legacy consumer side step as shared-stage consumption', () => {
  const plan = validSharedPlan();
  const marketOutput = plan.steps[1]!;
  const synthesis = plan.steps[2]!;
  plan.steps = [
    plan.steps[0]!,
    {
      step_no: 2,
      step_name: '无效旁路',
      actor_type: 'llm',
      actor_id: 'decoy',
      question_ids: ['question-market'],
      depends_on: [1],
      input: {},
      input_bindings: [],
      expected_outputs: [{ pointer: '/analysis', description: '旁路输出' }],
      acceptance_criteria: ['不属于 legacy 输出'],
      requires_approval: false,
      fallback_actor_ids: [],
      skill_invocation_id: 'invocation-market',
      skill_stage_id: 'decoy',
    },
    { ...marketOutput, step_no: 3, depends_on: [] },
    {
      ...synthesis,
      step_no: 4,
      depends_on: [1, 3],
      input_bindings: synthesis.input_bindings.map((binding) => ({
        ...binding,
        source_step_no: 3,
      })),
    },
  ];
  plan.skill_invocations[0]!.step_nos = [1, 2, 3];
  plan.skill_invocations[1]!.step_nos = [1, 4];
  plan.portfolio_summary.estimated_budget.expanded_step_count = 4;

  expectPlanError(plan, 'invalid_shared_stage', [
    'shared:tool:tavily-web-search',
    'invocation-market',
  ]);
});

test('CurrentExecutionPlan v3 rejects a shared stage with no path to a compiled consumer output', () => {
  const plan = validCompiledSharedPlan();
  plan.steps[1]!.depends_on = [];

  expectPlanError(plan, 'invalid_shared_stage', [
    'shared:tool:tavily-web-search',
    'invocation-market',
  ]);
});

test('CurrentExecutionPlan v3 does not accept an intermediate Skill stage as the compiled output consumer', () => {
  const plan = validCompiledSharedPlan();
  plan.steps[1]!.actor_type = 'skill';
  plan.steps[1]!.actor_id = 'competitive-web-research';
  plan.steps[2]!.depends_on = [];

  expectPlanError(plan, 'invalid_shared_stage', [
    'shared:tool:tavily-web-search',
    'invocation-market',
  ]);
});

test('CurrentExecutionPlan v3 rejects a shared prerequisite summary without its matching stage', () => {
  const plan = validSharedPlan();
  plan.portfolio_summary.shared_prerequisites[0]!.capability_id = 'other-search';

  expectPlanError(plan, 'invalid_shared_stage', ['shared:tool:other-search']);
});

test('CurrentExecutionPlan v3 rejects a shared stage omitted from the Portfolio summary', () => {
  const plan = validSharedPlan();
  plan.portfolio_summary.shared_prerequisites = [];

  expectPlanError(plan, 'invalid_shared_stage', ['shared:tool:tavily-web-search']);
});

test('CurrentExecutionPlan v3 rejects disagreement between shared summary Skills and stage consumers', () => {
  const plan = validSharedPlan();
  plan.portfolio_summary.shared_prerequisites[0]!.consumer_skill_ids[1] = 'unselected-skill';

  expectPlanError(plan, 'invalid_shared_stage', [
    'shared:tool:tavily-web-search',
    'unselected-skill',
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
  delete legacy.portfolio_summary;
  assert.deepEqual(validator.validate('current-execution-plan', legacy), []);
});
