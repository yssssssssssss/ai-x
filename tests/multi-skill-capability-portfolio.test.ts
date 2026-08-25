import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CapabilityDemandGraphV1, ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type {
  CurrentPlanStep,
  ProblemGraph,
} from '../packages/api-contract/research-deliverable.ts';
import type { DeliverableCompositionPolicy } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import {
  resolveCapabilities,
  type ActiveCapabilitySkillRegistryEntry,
  type CapabilityResolution,
  type EligibleCapabilityDecision,
} from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import {
  CapabilityPortfolioResolutionError,
  CapabilityPortfolioResolver,
  portfolioActorValidationIssues,
} from '../apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts';

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'research_synthesis',
  outcome_mode: 'answer',
  requested_artifacts: ['strategy_map'],
  business_domain: 'crowdfunding',
  research_goal: '综合市场、Persona 与 JTBD 形成策略',
  target_audience: ['产品团队'],
  scope: ['公开资料'],
  constraints: [],
  success_criteria: [{ id: 'criterion-1', statement: '形成可执行策略' }],
  expected_deliverables: ['research_strategy_report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

const demands: CapabilityDemandGraphV1 = {
  version: 'capability-demand-graph-v1',
  demands: [
    {
      id: 'demand-market',
      type: 'market_landscape',
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
      requiredEvidenceClasses: ['user_input'],
      requiredInputRoles: ['research_goal'],
      priority: 'required',
    },
    {
      id: 'demand-jtbd',
      type: 'jobs_to_be_done',
      questionIds: ['question-jtbd'],
      requestedArtifactTypes: [],
      requiredEvidenceClasses: ['user_input'],
      requiredInputRoles: ['research_goal'],
      priority: 'required',
    },
  ],
};

const problemGraph: ProblemGraph = {
  version: 'problem-graph-v1',
  questions: [
    ['question-market', '众筹市场与竞品格局是什么？', ['public_source']],
    ['question-persona', '核心用户 Persona 有哪些？', ['user_input']],
    ['question-jtbd', '用户访问众筹的核心动机与 JTBD 是什么？', ['user_input']],
  ].map(([id, statement, acceptedClasses]) => ({
    id: id as string,
    statement: statement as string,
    rationale: '覆盖必答问题。',
    priority: 'required' as const,
    success_criterion_ids: ['criterion-1'],
    evidence_requirements: [{
      id: `evidence-${String(id)}`,
      acceptedClasses: acceptedClasses as Array<'public_source' | 'user_input'>,
      minimumCount: 1,
      required: true,
    }],
    acceptance_criteria: ['直接回答并给出证据'],
    depends_on: [],
  })),
};

const policy: DeliverableCompositionPolicy = {
  mode: 'portfolio',
  synthesizer_skill_id: 'research-strategy-synthesis',
  accepted_contribution_types: [
    'market_landscape',
    'persona',
    'jobs_to_be_done',
    'strategy',
  ],
  contribution_schema: 'schemas/research-contribution-v1.schema.json',
};

function skill(
  id: string,
  modes: Array<'standalone' | 'contributor' | 'synthesizer'>,
  contributionTypes: CapabilityDemandGraphV1['demands'][number]['type'][],
  whenToUse: string,
  requiredTools: string[] = [],
): ActiveCapabilitySkillRegistryEntry {
  return {
    id,
    name: id,
    path: `skills/${id}/SKILL.md`,
    when_to_use: whenToUse,
    owner: 'test',
    status: 'active',
    task_types: id === 'research-strategy-synthesis' ? ['research_synthesis'] : ['user_research_planning'],
    inputs: [],
    outputs: [],
    required_tools: requiredTools,
    optional_tools: [],
    output_schema: 'schemas/skill-result-envelope.schema.json',
    risk_level: 'low',
    composition: {
      modes,
      supported_outcomes: ['answer'],
      compatible_deliverables: ['research_strategy_report'],
      ...(contributionTypes.length > 0 ? { contribution_types: contributionTypes } : {}),
      contribution_schema: 'schemas/research-contribution-v1.schema.json',
      contribution_adapter: modes.includes('contributor')
        ? 'skill-envelope-provisional-v1'
        : undefined,
      required_input_roles: ['research_goal'],
      optional_input_roles: [],
      ...(requiredTools.length > 0 ? { shareable_prerequisites: [...requiredTools] } : {}),
    },
  };
}

function decision(
  entry: ActiveCapabilitySkillRegistryEntry,
  pendingInputs: string[] = [],
): EligibleCapabilityDecision {
  return {
    skill: entry,
    required_approvals: [],
    reasons: [{ code: 'eligible', message: 'eligible' }],
    pending_inputs: pendingInputs.map((role) => ({
      kind: 'value', role, label: role, multiple: false, capability_id: entry.id,
    })),
    optional_tool_decisions: [],
  };
}

function resolution(overrides: { pendingPersona?: boolean; rejectMarket?: boolean } = {}): CapabilityResolution {
  const entries = [
    skill('competitive-web-research', ['standalone', 'contributor'], ['market_landscape'], '市场 竞品 众筹', ['tavily-web-search']),
    skill('market-generic', ['standalone', 'contributor'], ['market_landscape'], '通用分析'),
    skill('generate-persona', ['standalone', 'contributor'], ['persona'], '用户 Persona 分型'),
    skill('jobs-to-be-done', ['standalone', 'contributor'], ['jobs_to_be_done'], '访问动机 JTBD'),
    skill('research-strategy-synthesis', ['standalone', 'synthesizer'], ['strategy'], '策略综合'),
  ];
  const eligible = entries
    .filter(({ id }) => !(overrides.rejectMarket && id === 'competitive-web-research'))
    .map((entry) => decision(
      entry,
      overrides.pendingPersona && entry.id === 'generate-persona' ? ['user_materials'] : [],
    ));
  const rejected = overrides.rejectMarket
    ? [{
        ...decision(entries[0]!),
        reasons: [{ code: 'required_tool_unhealthy' as const, message: 'tool unhealthy' }],
      }]
    : [];
  return { eligible, rejected };
}

function resolve(input: {
  graph?: CapabilityDemandGraphV1;
  capabilityResolution?: CapabilityResolution;
  maxSteps?: number;
  stepEstimates?: Record<string, number>;
  shareableKnowledgeBySkill?: Record<string, string[]>;
} = {}) {
  return new CapabilityPortfolioResolver().resolve({
    task,
    problemGraph,
    capabilityDemandGraph: input.graph ?? demands,
    deliverableId: 'research_strategy_report',
    compositionPolicy: policy,
    capabilityResolution: input.capabilityResolution ?? resolution(),
    profile: { id: 'depth', max_steps: input.maxSteps ?? 8 },
    availableInputRoles: ['research_goal'],
    stepEstimates: input.stepEstimates ?? {
      'competitive-web-research': 2,
      'market-generic': 1,
      'generate-persona': 1,
      'jobs-to-be-done': 1,
      'research-strategy-synthesis': 2,
    },
    shareableKnowledgeBySkill: input.shareableKnowledgeBySkill,
  });
}

test('Capability Resolver recalls composition-compatible Specialists across legacy task-type boundaries', () => {
  const specialist = skill(
    'generate-persona',
    ['standalone', 'contributor'],
    ['persona'],
    '用户 Persona 分型',
  );
  const incompatible = skill(
    'accessibility-review',
    ['standalone', 'contributor'],
    ['accessibility'],
    '无障碍走查',
  );
  if (incompatible.composition) {
    incompatible.composition.compatible_deliverables = ['accessibility_audit_report'];
  }
  const synthesizer = skill(
    'research-strategy-synthesis',
    ['standalone', 'synthesizer'],
    ['strategy'],
    '策略综合',
  );
  const result = resolveCapabilities({
    task,
    available_input_roles: ['research_goal'],
    skills: [specialist, incompatible, synthesizer],
    tools: [],
    tool_states: [],
    tool_manifests: [],
    approval_capabilities: [],
    portfolio_context: {
      outcome: 'answer',
      deliverable_id: 'research_strategy_report',
      demand_types: ['persona'],
      synthesizer_skill_id: 'research-strategy-synthesis',
    },
  });

  assert.deepEqual(result.eligible.map(({ skill: entry }) => entry.id), [
    'generate-persona',
    'research-strategy-synthesis',
  ]);
  const rejected = result.rejected.find(({ skill: entry }) => entry.id === 'accessibility-review');
  assert.ok(rejected?.reasons.some(({ code }) => code === 'deliverable_mismatch'));
  assert.equal(result.eligible.some(({ reasons }) => reasons.some(({ code }) => code === 'task_type_mismatch')), false);
});

test('Portfolio Resolver selects the minimum deterministic Specialist set plus the policy Synthesizer', () => {
  const portfolio = resolve();
  assert.deepEqual(portfolio.invocations.map(({ skillId, role }) => ({ skillId, role })), [
    { skillId: 'competitive-web-research', role: 'contributor' },
    { skillId: 'generate-persona', role: 'contributor' },
    { skillId: 'jobs-to-be-done', role: 'contributor' },
    { skillId: 'research-strategy-synthesis', role: 'synthesizer' },
  ]);
  assert.deepEqual(portfolio.demandCoverage.map(({ demandId, ownerSkillId }) => ({ demandId, ownerSkillId })), [
    { demandId: 'demand-market', ownerSkillId: 'competitive-web-research' },
    { demandId: 'demand-persona', ownerSkillId: 'generate-persona' },
    { demandId: 'demand-jtbd', ownerSkillId: 'jobs-to-be-done' },
  ]);
  assert.equal(portfolio.estimatedBudget.estimatedSteps, 6);
  assert.equal(portfolio.estimatedBudget.maxSteps, 8);
  assert.deepEqual(portfolio.sharedPrerequisites, []);
  assert.ok(portfolio.rejected.some(({ skillId, reasonCode }) => (
    skillId === 'market-generic' && reasonCode === 'overlap_not_selected'
  )));
});

test('Candidate validation consumes only the frozen Portfolio and keeps Synthesizer last', () => {
  const portfolio = resolve();
  const steps: CurrentPlanStep[] = portfolio.invocations.map((invocation, index) => ({
    step_no: index + 1,
    step_name: invocation.skillId,
    actor_type: 'skill',
    actor_id: invocation.skillId,
    question_ids: ['question-market'],
    depends_on: [],
    input: {},
    input_bindings: [],
    expected_outputs: [{ pointer: '/payload', description: 'output' }],
    acceptance_criteria: ['valid'],
    requires_approval: false,
    fallback_actor_ids: [],
  }));
  assert.deepEqual(portfolioActorValidationIssues(steps, portfolio), []);
  assert.deepEqual(
    portfolioActorValidationIssues([
      steps.at(-1)!,
      ...steps.slice(1, -1),
      { ...steps[0]!, actor_id: 'unselected-skill' },
    ], portfolio),
    [
      'unknown=unselected-skill',
      'missing=competitive-web-research',
      'synthesizer_order=research-strategy-synthesis',
    ],
  );
});

test('Portfolio Resolver uses semantic recall to break equal-coverage ties', () => {
  const portfolio = resolve({
    stepEstimates: {
      'competitive-web-research': 1,
      'market-generic': 1,
      'generate-persona': 1,
      'jobs-to-be-done': 1,
      'research-strategy-synthesis': 1,
    },
  });
  assert.equal(portfolio.demandCoverage[0]!.ownerSkillId, 'competitive-web-research');
});

test('Portfolio Resolver permits one Synthesizer Skill to own a simple demand it natively covers', () => {
  const planningTask: ResearchTaskV2 = {
    ...task,
    task_type: 'user_research_planning',
    outcome_mode: 'plan',
    requested_artifacts: [],
    expected_deliverables: ['research_plan'],
  };
  const graph: CapabilityDemandGraphV1 = {
    version: 'capability-demand-graph-v1',
    demands: [{
      id: 'demand-method',
      type: 'research_method',
      questionIds: ['question-market'],
      requestedArtifactTypes: [],
      requiredEvidenceClasses: ['public_source'],
      requiredInputRoles: ['research_goal'],
      priority: 'required',
    }],
  };
  const synthesizer = skill(
    'generate-research-plan',
    ['standalone', 'synthesizer'],
    ['research_method'],
    '研究方案 方法',
  );
  synthesizer.composition = {
    ...synthesizer.composition!,
    supported_outcomes: ['plan'],
    compatible_deliverables: ['research_plan'],
  };
  const portfolio = new CapabilityPortfolioResolver().resolve({
    task: planningTask,
    problemGraph,
    capabilityDemandGraph: graph,
    deliverableId: 'research_plan',
    compositionPolicy: {
      mode: 'portfolio',
      synthesizer_skill_id: 'generate-research-plan',
      accepted_contribution_types: ['research_method'],
      contribution_schema: 'schemas/research-contribution-v1.schema.json',
    },
    capabilityResolution: { eligible: [decision(synthesizer)], rejected: [] },
    profile: { id: 'speed', max_steps: 4 },
    availableInputRoles: ['research_goal'],
  });
  assert.deepEqual(portfolio.invocations.map(({ skillId, role }) => ({ skillId, role })), [{
    skillId: 'generate-research-plan',
    role: 'synthesizer',
  }]);
  assert.equal(portfolio.demandCoverage[0]!.ownerSkillId, 'generate-research-plan');
});

test('Portfolio Resolver permits a simple one-Contributor portfolio', () => {
  const graph: CapabilityDemandGraphV1 = {
    version: 'capability-demand-graph-v1',
    demands: [structuredClone(demands.demands[0]!)],
  };
  const portfolio = resolve({ graph, maxSteps: 4 });
  assert.deepEqual(portfolio.invocations.map(({ skillId }) => skillId), [
    'competitive-web-research',
    'research-strategy-synthesis',
  ]);
});

test('Portfolio Resolver fails required coverage instead of selecting pending-input or rejected actors', () => {
  const pending = resolution({ pendingPersona: true });
  assert.throws(
    () => resolve({ capabilityResolution: pending }),
    (error: unknown) => error instanceof CapabilityPortfolioResolutionError
      && error.kind === 'required_demand_uncovered'
      && error.issueIds.includes('demand-persona'),
  );

  const rejectedMarket = resolution({ rejectMarket: true });
  const portfolio = resolve({ capabilityResolution: rejectedMarket });
  assert.equal(portfolio.demandCoverage[0]!.ownerSkillId, 'market-generic');
  assert.equal(portfolio.invocations.some(({ skillId }) => skillId === 'competitive-web-research'), false);
});

test('Portfolio Resolver fails when required coverage exceeds the exact ProfileSpec step budget', () => {
  assert.throws(
    () => resolve({ maxSteps: 5 }),
    (error: unknown) => error instanceof CapabilityPortfolioResolutionError
      && error.kind === 'profile_budget_exceeded'
      && error.issueIds.includes('depth'),
  );
});

test('Portfolio Resolver discovers explicitly shareable Knowledge stages across compiled Skills', () => {
  const portfolio = resolve({
    shareableKnowledgeBySkill: {
      'competitive-web-research': ['research-wiki'],
      'generate-persona': ['research-wiki'],
      'research-strategy-synthesis': ['research-wiki'],
    },
  });
  assert.ok(portfolio.sharedPrerequisites.some((item) => (
    item.capabilityType === 'knowledge'
    && item.capabilityId === 'research-wiki'
    && item.consumerSkillIds.length >= 2
  )));
});

test('Portfolio Resolver deduplicates shared required Tool prerequisites', () => {
  const withSharedTool = resolution();
  const persona = withSharedTool.eligible.find(({ skill: entry }) => entry.id === 'generate-persona');
  assert.ok(persona);
  persona.skill.required_tools = ['tavily-web-search'];
  persona.skill.composition!.shareable_prerequisites = ['tavily-web-search'];
  const portfolio = resolve({ capabilityResolution: withSharedTool });
  assert.deepEqual(portfolio.sharedPrerequisites, [{
    capabilityType: 'tool',
    capabilityId: 'tavily-web-search',
    consumerSkillIds: ['competitive-web-research', 'generate-persona'],
  }]);
});
