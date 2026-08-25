import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CapabilityDemandGraphV1,
  ResearchTaskV2,
} from '../packages/api-contract/plan.ts';
import type { CurrentPlanStep } from '../packages/api-contract/research-deliverable.ts';
import { ExecutionScheduler } from '../apps/orchestrator-runtime/src/control/execution-scheduler.ts';
import { parseExecutionPlan } from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import { resolveDeliverableContractById } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import {
  PlanCompiler,
  PlanCompilerValidationError,
} from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import type { CapabilityResolution } from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import type { SkillPortfolioDecision } from '../apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts';
import {
  compilePortfolioSkillSteps,
  planShareFingerprint,
} from '../apps/orchestrator-runtime/src/skills/portfolio-skill-plan-compiler.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

const legacySkillLoader = {
  getSkill(id: string) {
    return {
      id,
      required_tools: ['tavily-web-search'],
      composition: {
        modes: id === 'research-strategy-synthesis' ? ['synthesizer'] : ['contributor'],
        supported_outcomes: ['answer'],
        compatible_deliverables: ['research_strategy_report'],
        contribution_types: ['qualitative_insight'],
        contribution_schema: 'schemas/research-contribution-v1.schema.json',
        contribution_adapter: 'skill-envelope-provisional-v1',
        required_input_roles: [],
        optional_input_roles: [],
        shareable_prerequisites: ['tavily-web-search'],
      },
    };
  },
  loadSkillExecution() { return null; },
} as unknown as SkillLoader;

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'research_synthesis',
  outcome_mode: 'answer',
  requested_artifacts: ['strategy_map'],
  business_domain: 'crowdfunding',
  research_goal: '综合市场与 Persona 形成策略',
  target_audience: ['产品团队'],
  scope: ['公开资料'],
  constraints: [],
  success_criteria: [{ id: 'criterion-1', statement: '形成有证据的策略' }],
  expected_deliverables: ['research_strategy_report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

function highLevelSteps(): CurrentPlanStep[] {
  return [
    {
      step_no: 1,
      step_name: '共享公开证据',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      question_ids: ['question-market', 'question-persona'],
      depends_on: [],
      input: { query: 'crowdfunding market personas', max_results: 8 },
      input_bindings: [],
      expected_outputs: [{ pointer: '/results', description: '公开证据' }],
      acceptance_criteria: ['来源可追溯'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 2,
      step_name: '市场贡献',
      actor_type: 'skill',
      actor_id: 'competitive-analysis',
      question_ids: ['question-market'],
      depends_on: [1],
      input: { research_goal: task.research_goal },
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload', description: '市场贡献' }],
      acceptance_criteria: ['输出 Research Contribution'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 3,
      step_name: 'Persona 贡献',
      actor_type: 'skill',
      actor_id: 'generate-persona',
      question_ids: ['question-persona'],
      depends_on: [1],
      input: { research_goal: task.research_goal },
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload', description: 'Persona 贡献' }],
      acceptance_criteria: ['输出 Research Contribution'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 4,
      step_name: '策略综合',
      actor_type: 'skill',
      actor_id: 'research-strategy-synthesis',
      question_ids: ['question-market', 'question-persona'],
      depends_on: [2],
      input: { research_goal: task.research_goal },
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload', description: '综合草稿' }],
      acceptance_criteria: ['覆盖全部必答问题'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
  ];
}

const portfolio: SkillPortfolioDecision = {
  invocations: [
    {
      invocationId: 'invocation:market',
      skillId: 'competitive-analysis',
      role: 'contributor',
      demandIds: ['demand-market'],
      contributionTypes: ['competitive_analysis'],
      questionIds: ['question-market'],
      requestedArtifactTypes: ['strategy_map'],
      required: true,
      failurePolicy: 'block',
      estimatedSteps: 1,
      reasonCodes: ['required_demand_coverage'],
    },
    {
      invocationId: 'invocation:persona',
      skillId: 'generate-persona',
      role: 'contributor',
      demandIds: ['demand-persona'],
      contributionTypes: ['persona'],
      questionIds: ['question-persona'],
      requestedArtifactTypes: [],
      required: false,
      failurePolicy: 'gap',
      estimatedSteps: 1,
      reasonCodes: ['optional_demand_coverage'],
    },
    {
      invocationId: 'invocation:synthesis',
      skillId: 'research-strategy-synthesis',
      role: 'synthesizer',
      demandIds: [],
      contributionTypes: ['strategy'],
      questionIds: ['question-market', 'question-persona'],
      requestedArtifactTypes: ['strategy_map'],
      required: true,
      failurePolicy: 'block',
      estimatedSteps: 2,
      reasonCodes: ['deliverable_policy_owner'],
    },
  ],
  demandCoverage: [
    {
      demandId: 'demand-market',
      demandType: 'competitive_analysis',
      ownerSkillId: 'competitive-analysis',
      corroboratorSkillIds: [],
      questionIds: ['question-market'],
      requestedArtifactTypes: ['strategy_map'],
      required: true,
    },
    {
      demandId: 'demand-persona',
      demandType: 'persona',
      ownerSkillId: 'generate-persona',
      corroboratorSkillIds: [],
      questionIds: ['question-persona'],
      requestedArtifactTypes: [],
      required: false,
    },
  ],
  rejected: [],
  sharedPrerequisites: [{
    capabilityType: 'tool',
    capabilityId: 'tavily-web-search',
    consumerSkillIds: ['competitive-analysis', 'generate-persona'],
  }],
  estimatedBudget: {
    profileId: 'depth',
    maxSteps: 8,
    estimatedSteps: 4,
    selectedContributorCount: 2,
    selectedSkillCount: 3,
    requiredDemandCount: 1,
    optionalDemandCount: 1,
  },
};

const capabilityDemandGraph: CapabilityDemandGraphV1 = {
  version: 'capability-demand-graph-v1',
  demands: [
    {
      id: 'demand-market',
      type: 'competitive_analysis',
      questionIds: ['question-market'],
      requestedArtifactTypes: ['strategy_map'],
      requiredEvidenceClasses: ['public_source'],
      requiredInputRoles: ['research_goal'],
      priority: 'required',
    },
    {
      id: 'demand-persona',
      type: 'persona',
      questionIds: ['question-persona'],
      requestedArtifactTypes: [],
      requiredEvidenceClasses: ['public_source'],
      requiredInputRoles: ['research_goal'],
      priority: 'optional',
    },
  ],
};

const problemGraph = {
  version: 'problem-graph-v1' as const,
  questions: [
    {
      id: 'question-market', statement: '市场与竞品格局是什么？', rationale: '市场判断', priority: 'required' as const,
      success_criterion_ids: ['criterion-1'], evidence_requirements: [{ id: 'public-evidence', acceptedClasses: ['public_source' as const], minimumCount: 1, required: true }],
      acceptance_criteria: ['给出公开来源'], depends_on: [],
    },
    {
      id: 'question-persona', statement: '可能的 Persona 是什么？', rationale: '用户假设', priority: 'optional' as const,
      success_criterion_ids: ['criterion-1'], evidence_requirements: [{ id: 'public-evidence', acceptedClasses: ['public_source' as const], minimumCount: 1, required: true }],
      acceptance_criteria: ['明确 provisional'], depends_on: [],
    },
  ],
};

function capabilityResolution(): CapabilityResolution {
  const skills = [
    ['competitive-analysis', 'competitive_analysis'],
    ['generate-persona', 'persona'],
    ['research-strategy-synthesis', 'strategy'],
  ] as const;
  return {
    eligible: skills.map(([id, output]) => ({
      skill: {
        id,
        name: id,
        path: `skills/${id}/SKILL.md`,
        when_to_use: id,
        owner: 'test',
        status: 'active' as const,
        task_types: ['research_synthesis'],
        inputs: ['research_goal'],
        outputs: [output],
        required_tools: id === 'competitive-analysis' ? ['tavily-web-search'] : [],
        optional_tools: [],
        output_schema: 'schemas/skill-result-envelope.schema.json',
        risk_level: 'low' as const,
        composition: {
          modes: id === 'research-strategy-synthesis'
            ? ['synthesizer' as const]
            : ['contributor' as const],
          supported_outcomes: ['answer' as const],
          compatible_deliverables: ['research_strategy_report'],
          contribution_types: [output],
          contribution_schema: 'schemas/research-contribution-v1.schema.json',
          ...(id === 'research-strategy-synthesis'
            ? {}
            : { contribution_adapter: 'skill-envelope-provisional-v1' }),
          required_input_roles: ['research_goal'],
          optional_input_roles: [],
        },
      },
      required_approvals: [],
      reasons: [{ code: 'eligible' as const, message: 'eligible' }],
      pending_inputs: [],
      optional_tool_decisions: [],
    })),
    rejected: [],
  };
}

test('portfolio compiler preserves Contributor parallelism and makes Synthesizer wait for all Contributor outputs', () => {
  const compiled = compilePortfolioSkillSteps({
    steps: highLevelSteps(),
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });

  assert.equal(compiled.invocations.length, 3);
  assert.deepEqual(compiled.invocations.map(({ invocation_id, role, failure_policy }) => ({
    invocation_id, role,failure_policy,
  })), [
    { invocation_id: 'invocation:market', role: 'contributor', failure_policy: 'block' },
    { invocation_id: 'invocation:persona', role: 'contributor', failure_policy: 'gap' },
    { invocation_id: 'invocation:synthesis', role: 'synthesizer', failure_policy: 'block' },
  ]);

  const market = compiled.steps.find(({ skill_invocation_id }) => skill_invocation_id === 'invocation:market');
  const persona = compiled.steps.find(({ skill_invocation_id }) => skill_invocation_id === 'invocation:persona');
  const synthesis = compiled.steps.find(({ skill_invocation_id, actor_type }) => (
    skill_invocation_id === 'invocation:synthesis' && actor_type === 'skill'
  ));
  assert.ok(market && persona && synthesis);
  assert.deepEqual(market.depends_on, [1]);
  assert.deepEqual(persona.depends_on, [1]);
  assert.ok(synthesis.depends_on.includes(market.step_no));
  assert.ok(synthesis.depends_on.includes(persona.step_no));
  assert.deepEqual(synthesis.input.contribution_order, [
    'invocation:market',
    'invocation:persona',
  ]);
  assert.deepEqual(Object.keys(synthesis.input.contribution_bundle as object), [
    'invocation:market',
    'invocation:persona',
  ]);
  assert.deepEqual(synthesis.input_bindings.map(({ source_step_no, source_pointer, include_artifact_identity }) => ({
    source_step_no, source_pointer, include_artifact_identity,
  })), [
    { source_step_no: market.step_no, source_pointer: '/contribution', include_artifact_identity: true },
    { source_step_no: persona.step_no, source_pointer: '/contribution', include_artifact_identity: true },
  ]);
});

test('portfolio compiler marks one shared Tool stage with a stable fingerprint and every consumer invocation', () => {
  const first = compilePortfolioSkillSteps({
    steps: highLevelSteps(),
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });
  const shared = first.steps[0]!;
  assert.equal(shared.shared_stage_key, 'shared:tool:tavily-web-search');
  assert.deepEqual(shared.shared_by_invocation_ids, [
    'invocation:market',
    'invocation:persona',
  ]);
  assert.match(shared.share_fingerprint ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.equal(shared.share_fingerprint, planShareFingerprint(shared));
  const reordered = highLevelSteps()[0]!;
  reordered.input = { max_results: 8, query: 'crowdfunding market personas' };
  assert.equal(planShareFingerprint(reordered), shared.share_fingerprint);

  const changed = highLevelSteps();
  changed[0]!.input.max_results = 9;
  const changedCompiled = compilePortfolioSkillSteps({
    steps: changed,
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });
  assert.notEqual(changedCompiled.steps[0]!.share_fingerprint, shared.share_fingerprint);
});

test('portfolio compiler deduplicates exact declared shared Tool steps and rejects fingerprint drift', () => {
  const duplicate = highLevelSteps();
  duplicate.splice(1, 0, { ...structuredClone(duplicate[0]!), step_no: 2 });
  duplicate[2] = { ...duplicate[2]!, step_no: 3, depends_on: [1] };
  duplicate[3] = { ...duplicate[3]!, step_no: 4, depends_on: [2] };
  duplicate[4] = { ...duplicate[4]!, step_no: 5, depends_on: [3] };

  const deduplicated = compilePortfolioSkillSteps({
    steps: duplicate,
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });
  assert.equal(deduplicated.steps.filter(({ actor_id }) => actor_id === 'tavily-web-search').length, 1);
  assert.equal(deduplicated.steps[0]!.shared_stage_key, 'shared:tool:tavily-web-search');

  const different = structuredClone(duplicate);
  different[1]!.input.max_results = 9;
  assert.throws(
    () => compilePortfolioSkillSteps({
      steps: different,
      task,
      portfolio,
      skillLoader: legacySkillLoader,
    }),
    /non-identical execution contracts/u,
  );

  const differentlyBound = structuredClone(duplicate);
  differentlyBound[1]!.input_bindings = [{
    target_pointer: '/query',
    source_step_no: 1,
    source_pointer: '/results/0/title',
  }];
  assert.throws(
    () => compilePortfolioSkillSteps({
      steps: differentlyBound,
      task,
      portfolio,
      skillLoader: legacySkillLoader,
    }),
    /non-identical execution contracts/u,
  );
});

test('portfolio compiler emits Contribution Requirements with one owner and at most one Corroborator', () => {
  const compiled = compilePortfolioSkillSteps({
    steps: highLevelSteps(),
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });
  assert.deepEqual(compiled.contributionRequirements, [
    {
      id: 'demand-market',
      demand_type: 'competitive_analysis',
      question_ids: ['question-market'],
      requested_artifact_types: ['strategy_map'],
      owner_invocation_id: 'invocation:market',
      corroborator_invocation_ids: [],
      required: true,
    },
    {
      id: 'demand-persona',
      demand_type: 'persona',
      question_ids: ['question-persona'],
      requested_artifact_types: [],
      owner_invocation_id: 'invocation:persona',
      corroborator_invocation_ids: [],
      required: false,
    },
  ]);
  assert.deepEqual(compiled.steps.map(({ step_no }) => step_no), [1, 2, 3, 4]);
});

test('compiled portfolio schedules independent Contributors in one parallel wave', async () => {
  const compiled = compilePortfolioSkillSteps({
    steps: highLevelSteps(),
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });
  const scheduler = new ExecutionScheduler({
    async execute(step) { return step.key; },
  });
  const result = await scheduler.schedule({
    steps: compiled.steps.map((step) => ({
      key: String(step.step_no),
      dependsOn: step.depends_on.map(String),
    })),
  }, {});
  assert.deepEqual(result.waves, [['1'], ['2', '3'], ['4']]);
});

test('production portfolio compilation reuses only a contract-authorized shared Tool stage', () => {
  const skillLoader = new SkillLoader();
  const web = skillLoader.listCapabilitySkills().find(({ id }) => id === 'competitive-web-research');
  const synthesis = skillLoader.listCapabilitySkills().find(({ id }) => id === 'research-strategy-synthesis');
  const synthesisContract = skillLoader.loadSkillExecution('research-strategy-synthesis');
  assert.ok(web && web.status === 'active');
  assert.ok(synthesis && synthesis.status === 'active');
  assert.ok(synthesisContract);
  const sharedStage = synthesisContract.contract.stages.find(({ stage_id }) => (
    stage_id === 'collect-public-evidence'
  ));
  assert.ok(sharedStage && sharedStage.share_scope === 'plan');

  const realPortfolio: SkillPortfolioDecision = {
    invocations: [
      {
        invocationId: 'invocation:web',
        skillId: web.id,
        role: 'contributor',
        demandIds: ['demand-market'],
        contributionTypes: ['competitive_analysis'],
        questionIds: ['question-market'],
        requestedArtifactTypes: ['strategy_map'],
        required: true,
        failurePolicy: 'block',
        estimatedSteps: 1,
        reasonCodes: ['required_demand_coverage'],
      },
      {
        invocationId: 'invocation:synthesis',
        skillId: synthesis.id,
        role: 'synthesizer',
        demandIds: [],
        contributionTypes: ['strategy'],
        questionIds: ['question-market'],
        requestedArtifactTypes: ['strategy_map'],
        required: true,
        failurePolicy: 'block',
        estimatedSteps: synthesisContract.contract.stages.length,
        reasonCodes: ['deliverable_synthesizer'],
      },
    ],
    demandCoverage: [{
      demandId: 'demand-market',
      demandType: 'competitive_analysis',
      ownerSkillId: web.id,
      corroboratorSkillIds: [],
      questionIds: ['question-market'],
      requestedArtifactTypes: ['strategy_map'],
      required: true,
    }],
    rejected: [],
    sharedPrerequisites: [{
      capabilityType: 'tool',
      capabilityId: 'tavily-web-search',
      consumerSkillIds: [web.id, synthesis.id],
    }],
    estimatedBudget: {
      profileId: 'depth',
      maxSteps: 16,
      selectedSkillCount: 2,
      selectedContributorCount: 1,
      estimatedSteps: synthesisContract.contract.stages.length + 2,
      requiredDemandCount: 1,
      optionalDemandCount: 0,
    },
  };
  const eligible = [web, synthesis].map((skill) => ({
    skill,
    required_approvals: [],
    reasons: [{ code: 'eligible' as const, message: 'fixture eligible' }],
    pending_inputs: [],
    optional_tool_decisions: [],
  }));
  const realResolution: CapabilityResolution = { eligible, rejected: [] };
  const candidateSteps: CurrentPlanStep[] = [
    {
      step_no: 1,
      step_name: sharedStage.title,
      actor_type: sharedStage.actor_type,
      actor_id: sharedStage.actor_id,
      question_ids: ['question-market'],
      depends_on: [],
      input: structuredClone(sharedStage.input),
      input_bindings: [],
      expected_outputs: structuredClone(sharedStage.expected_outputs),
      acceptance_criteria: [...sharedStage.acceptance_criteria],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 2,
      step_name: '竞品公开资料贡献',
      actor_type: 'skill',
      actor_id: web.id,
      question_ids: ['question-market'],
      depends_on: [1],
      input: { research_goal: task.research_goal },
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload', description: '竞品贡献' }],
      acceptance_criteria: ['形成可追溯竞品贡献'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 3,
      step_name: '策略综合',
      actor_type: 'skill',
      actor_id: synthesis.id,
      question_ids: ['question-market'],
      depends_on: [2],
      input: { research_goal: task.research_goal },
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload', description: '综合草稿' }],
      acceptance_criteria: ['覆盖全部必答问题'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
  ];
  const graph = {
    version: 'problem-graph-v1' as const,
    questions: [problemGraph.questions[0]!],
  };
  const demands: CapabilityDemandGraphV1 = {
    version: 'capability-demand-graph-v1',
    demands: [capabilityDemandGraph.demands[0]!],
  };
  const result = new PlanCompiler().compilePortfolio({
    candidate: {
      id: 'depth',
      title: '生产合同组合',
      rationale: '验证共享阶段合同。',
      tradeoffs: '步骤更多。',
      steps: candidateSteps,
      assumptions: [],
      activated_nodes: [],
    },
    task,
    deliverable_selection: {
      deliverableId: 'research_strategy_report',
      evidenceRequirements: [{
        id: 'public-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
      }],
    },
    problem_graph: graph,
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'fixture-planner', modelVersion: 'v1', promptHash: 'sha256:fixture', traceId: 'trace-fixture',
    },
    capability_resolution: realResolution,
    evidence_requirements: [{
      id: 'public-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
    }],
    capability_demand_graph: demands,
    portfolio: realPortfolio,
    activated_nodes: [],
    skillLoader,
  });

  const shared = result.plan.steps.find(({ shared_stage_key }) => Boolean(shared_stage_key));
  assert.ok(shared);
  assert.deepEqual(shared.shared_by_invocation_ids, ['invocation:web', 'invocation:synthesis']);
  assert.equal(
    result.plan.steps.filter(({ actor_id }) => actor_id === 'tavily-web-search').length,
    1,
  );
  assert.equal(
    result.plan.portfolio_summary.estimated_budget.expanded_step_count,
    result.plan.steps.length,
  );
});

test('PlanCompiler rejects a Portfolio whose expanded DAG exceeds the frozen Profile budget', () => {
  const constrained = structuredClone(portfolio);
  constrained.estimatedBudget.maxSteps = 3;
  assert.throws(() => new PlanCompiler().compilePortfolio({
    candidate: {
      id: 'depth', title: '超预算组合', rationale: '验证编译后预算。', tradeoffs: '不可执行。',
      steps: highLevelSteps(), assumptions: [], activated_nodes: [],
    },
    task,
    deliverable_selection: {
      deliverableId: 'research_strategy_report',
      evidenceRequirements: [{
        id: 'public-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
      }],
    },
    problem_graph: problemGraph,
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'fixture-planner', modelVersion: 'v1', promptHash: 'sha256:fixture', traceId: 'trace-fixture',
    },
    capability_resolution: capabilityResolution(),
    evidence_requirements: [{
      id: 'public-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
    }],
    capability_demand_graph: capabilityDemandGraph,
    portfolio: constrained,
    activated_nodes: [],
    skillLoader: legacySkillLoader,
  }), (error: unknown) => error instanceof PlanCompilerValidationError
    && error.kind === 'portfolio_step_limit_exceeded');
});

test('PlanCompiler emits a schema-valid inactive CurrentExecutionPlan v3 from a frozen Portfolio', () => {
  const result = new PlanCompiler().compilePortfolio({
    candidate: {
      id: 'depth',
      title: '多 Skill 深度方案',
      rationale: '独立贡献后统一综合。',
      tradeoffs: '步骤更多。',
      steps: highLevelSteps(),
      assumptions: [],
      activated_nodes: [],
    },
    task,
    deliverable_selection: {
      deliverableId: 'research_strategy_report',
      evidenceRequirements: [{
        id: 'public-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
      }],
    },
    problem_graph: problemGraph,
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'fixture-planner', modelVersion: 'v1', promptHash: 'sha256:fixture', traceId: 'trace-fixture',
    },
    capability_resolution: capabilityResolution(),
    evidence_requirements: [{
      id: 'public-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
    }],
    capability_demand_graph: capabilityDemandGraph,
    portfolio,
    activated_nodes: [],
    skillLoader: legacySkillLoader,
  });

  assert.equal(result.plan.execution_contract_version, 'current-execution-plan-v3');
  assert.equal(result.plan.skill_invocations.length, 3);
  assert.equal(result.plan.contribution_requirements.length, 2);
  assert.equal(result.plan.steps[0]!.shared_stage_key, 'shared:tool:tavily-web-search');

  const parsed = parseExecutionPlan(
    'task-runtime',
    { ...result.plan, task_id: 'task-runtime' },
    resolveDeliverableContractById('research_strategy_report'),
  );
  const persona = result.plan.skill_invocations.find(({ invocation_id }) => (
    invocation_id === 'invocation:persona'
  ));
  const market = result.plan.skill_invocations.find(({ invocation_id }) => (
    invocation_id === 'invocation:market'
  ));
  assert.ok(persona && market);
  const personaOwnedStepNos = result.plan.steps
    .filter(({ skill_invocation_id }) => skill_invocation_id === 'invocation:persona')
    .map(({ step_no }) => step_no);
  assert.ok(personaOwnedStepNos.every((stepNo) => parsed.optionalInvocationStepNos.has(stepNo)));
  assert.ok(market.step_nos.every((stepNo) => !parsed.optionalInvocationStepNos.has(stepNo)));
  assert.equal(parsed.optionalInvocationStepNos.has(result.plan.steps[0]!.step_no), false);
});
