import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ResearchTaskV2,
} from '../packages/api-contract/plan.ts';
import type {
  CurrentPlanStep,
  ProblemGraph,
} from '../packages/api-contract/research-deliverable.ts';
import type {
  SkillPortfolioDecision,
} from '../apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts';
import {
  PlanCompiler,
  type CurrentPlanCandidateProposal,
} from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import {
  ResearchPlanningService,
  resolvePlanningDeliverableSelection,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import { loadPlanningPolicy } from '../apps/orchestrator-runtime/src/planners/planning-guidance-adapter.ts';
import type {
  LLMClient,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { ToolRouter, type ToolAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const requirement: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'research_synthesis',
  outcome_mode: 'answer',
  requested_artifacts: [
    'strategy_map',
    'mind_model',
    'design_principles',
    'opportunity_backlog',
    'prioritized_actions',
  ],
  business_domain: 'jd_crowdfunding',
  research_goal: '直接回答京东众筹的市场与竞品格局、Persona、JTBD/支持动机、核心体验指标与虚拟用户模拟假设，并形成增长策略',
  target_audience: ['产品团队'],
  scope: ['从发现、理解、信任、支持到履约跟踪', '仅使用公开资料'],
  constraints: [{
    id: 'simulation-boundary',
    statement: '虚拟用户输出只作为 simulation Evidence 和 provisional 假设',
    source: 'user',
  }],
  success_criteria: [{
    id: 'criterion-direct-answer',
    statement: '所有必答问题均给出可追溯证据、置信度、业务含义、行动与待验证边界',
  }],
  expected_deliverables: ['research_strategy_report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

const evidenceRequirement = {
  id: 'research-strategy-report',
  acceptedClasses: ['public_source', 'knowledge', 'user_input', 'dataset'] as const,
  minimumCount: 1,
  required: true,
};

const problemGraph: ProblemGraph = {
  version: 'problem-graph-v1',
  questions: [
    ['question-market', '京东众筹的市场与竞品格局是什么？'],
    ['question-persona', '京东众筹的核心用户 Persona 与用户分型是什么？'],
    ['question-jtbd', '用户从发现到履约跟踪的 JTBD 与支持动机是什么？'],
    ['question-metrics', '京东众筹的核心体验指标应如何定义、测量和验证？'],
  ].map(([id, statement]) => ({
    id: id!,
    statement: statement!,
    rationale: '形成证据约束的直接答案。',
    priority: 'required' as const,
    success_criterion_ids: ['criterion-direct-answer'],
    evidence_requirements: [{
      ...evidenceRequirement,
      acceptedClasses: [...evidenceRequirement.acceptedClasses],
    }],
    acceptance_criteria: [
      '给出直接答案、证据或 provisional 状态、置信度、业务含义与推荐行动。',
    ],
    depends_on: [],
  })),
};

interface CandidateContext {
  profile_specs: Array<{ id: CurrentPlanCandidateProposal['id']; max_steps: number }>;
  portfolios_by_profile: Partial<Record<string, SkillPortfolioDecision>>;
  skills: Array<{ id: string; required_tools: string[] }>;
}

function toolStep(
  stepNo: number,
  actorId: 'tavily-web-search' | 'virtual-user-lab',
  questionIds: string[],
): CurrentPlanStep {
  return {
    step_no: stepNo,
    step_name: actorId === 'tavily-web-search' ? '检索共享公开证据' : '生成虚拟用户模拟假设',
    actor_type: 'tool',
    actor_id: actorId,
    question_ids: questionIds,
    depends_on: [],
    input: actorId === 'tavily-web-search'
      ? { query: requirement.research_goal }
      : { scenario: requirement.research_goal },
    input_bindings: [],
    expected_outputs: [{
      pointer: actorId === 'tavily-web-search' ? '/results' : '/result',
      description: `${actorId} output`,
    }],
    acceptance_criteria: ['输出可审计结果'],
    requires_approval: false,
    fallback_actor_ids: [],
  };
}

function candidateFor(
  profile: CandidateContext['profile_specs'][number],
  context: CandidateContext,
): Omit<CurrentPlanCandidateProposal, 'activated_nodes'> {
  const portfolio = context.portfolios_by_profile[profile.id];
  if (!portfolio) throw new Error(`fixture has no Portfolio for ${profile.id}`);
  const skillsById = new Map(context.skills.map((skill) => [skill.id, skill]));
  const sharedToolIds = portfolio.sharedPrerequisites.flatMap((prerequisite) => (
    prerequisite.capabilityType === 'tool' ? [prerequisite.capabilityId] : []
  ));
  const requiredToolIds = portfolio.invocations.flatMap((invocation) => (
    skillsById.get(invocation.skillId)?.required_tools ?? []
  ));
  const toolIds = [...new Set([...sharedToolIds, ...requiredToolIds])];
  const toolSteps = toolIds.map((toolId, index) => {
    if (toolId !== 'tavily-web-search' && toolId !== 'virtual-user-lab') {
      throw new Error(`unexpected fixture Tool ${toolId}`);
    }
    const ownerSkillIds = toolId === 'tavily-web-search'
      ? portfolio.sharedPrerequisites.find((prerequisite) => (
          prerequisite.capabilityType === 'tool' && prerequisite.capabilityId === toolId
        ))?.consumerSkillIds ?? []
      : portfolio.invocations
          .filter((invocation) => skillsById.get(invocation.skillId)?.required_tools.includes(toolId))
          .map(({ skillId }) => skillId);
    const questionIds = portfolio.invocations
      .filter(({ skillId }) => ownerSkillIds.includes(skillId))
      .flatMap(({ questionIds: ids }) => ids);
    return toolStep(index + 1, toolId, [...new Set(questionIds)]);
  });
  const skillSteps = portfolio.invocations.map((invocation, index): CurrentPlanStep => ({
    step_no: toolSteps.length + index + 1,
    step_name: invocation.role === 'synthesizer'
      ? '统一综合研究策略'
      : `${invocation.skillId} 研究贡献`,
    actor_type: 'skill',
    actor_id: invocation.skillId,
    question_ids: [...invocation.questionIds],
    depends_on: [],
    input: { research_goal: requirement.research_goal },
    input_bindings: [],
    expected_outputs: [{ pointer: '/payload', description: `${invocation.skillId} output` }],
    acceptance_criteria: ['覆盖冻结的能力需求'],
    requires_approval: false,
    fallback_actor_ids: [],
  }));
  return {
    id: profile.id,
    title: `${profile.id} 多 Skill 方案`,
    rationale: '覆盖全部 Required Demand。',
    tradeoffs: '执行多个专业贡献并统一综合。',
    steps: [...toolSteps, ...skillSteps],
    assumptions: [],
  };
}

class RoutedPlanningFixtureLLM implements LLMClient {
  readonly identity = {
    provider: 'offline-routed-planning-fixture',
    endpointHost: 'fixture.invalid',
    requestedModel: 'offline-routed-planning-model',
    mode: 'mock' as const,
    eligibleAsReal: false,
  };

  readonly calls: StructuredLLMCallOptions[] = [];

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    let data: unknown;
    if (options.schemaName === 'decision-states') {
      data = [];
    } else if (options.schemaName === 'problem-graph') {
      data = structuredClone(problemGraph);
    } else if (options.schemaName === 'current-plan-candidates') {
      const context = options.context as CandidateContext;
      data = {
        candidates: context.profile_specs.map((profile) => candidateFor(profile, context)),
      };
    } else {
      throw new Error(`unexpected offline LLM call ${options.schemaName}`);
    }
    return {
      data: data as T,
      promptHash: `sha256:${options.schemaName}`,
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-v1',
      traceId: `trace-${options.schemaName}`,
      ...(options.schemaName === 'problem-graph'
        ? { receiptId: '11111111-1111-4111-8111-111111111188' }
        : {}),
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('text generation is not used during offline routed planning');
  }
}

function planningHarness(multiSkillPortfolioMode: 'inactive' | 'active' = 'active') {
  const llm = new RoutedPlanningFixtureLLM();
  const tools = new ToolRouter();
  let toolInvocationCount = 0;
  const adapter = (
    adapterType: ToolAdapter['adapterType'],
    executionMode: ToolAdapter['executionMode'],
  ): ToolAdapter => ({
    adapterType,
    implementationId: `planning-only-${adapterType}`,
    executionMode,
    endpointHost: () => 'fixture.invalid',
    async invoke() {
      toolInvocationCount += 1;
      throw new Error('planning must not invoke Tools');
    },
  });
  tools.register(adapter('tavily', 'real'));
  tools.register(adapter('rest_json', 'fake'));
  const skillLoader = new SkillLoader();
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader,
    tools,
    approvalAuthorities: ['owner'],
    multiSkillPortfolioMode,
    planningPolicy: loadPlanningPolicy(),
  });
  return { llm, planning, skillLoader, toolInvocationCount: () => toolInvocationCount };
}

test('current planning rejects a missing mode instead of deriving it from writer availability', async () => {
  const { llm, planning } = planningHarness('active');

  await assert.rejects(
    () => planning.planCurrentFromRequirementOutcome(
      requirement,
      requirement.research_goal,
      undefined,
      {} as never,
    ),
    /orchestration mode is required for current planning/u,
  );
  assert.equal(llm.calls.length, 0);
});

test('explicit multi_skill mode fails instead of falling back when the writer is inactive', async () => {
  const { llm, planning } = planningHarness('inactive');

  await assert.rejects(
    () => planning.planCurrentFromRequirementOutcome(
      requirement,
      requirement.research_goal,
      undefined,
      {
        selectedScenarioId: 'strategy-synthesis',
        orchestrationMode: 'multi_skill',
      },
    ),
    /multi_skill mode is not available/u,
  );
  assert.equal(llm.calls.length, 0);
});

test('routed multi-Skill planning keeps required coverage, budgets, and evidence ownership deterministic offline', async () => {
  const { llm, planning, skillLoader, toolInvocationCount } = planningHarness();
  const result = await planning.planCurrentFromRequirementOutcome(
    requirement,
    requirement.research_goal,
    undefined,
    {
      selectedScenarioId: 'strategy-synthesis',
      orchestrationMode: 'multi_skill',
    },
  );

  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  assert.equal(result.orchestrationMode, 'multi_skill');
  assert.equal(toolInvocationCount(), 0);
  assert.deepEqual(result.candidates.map(({ id }) => id), ['speed', 'depth']);
  assert.deepEqual(result.planningProvenance.selected_profile_ids, ['speed', 'depth']);
  assert.equal(result.portfolios?.decision, undefined);

  for (const profileId of ['speed', 'depth'] as const) {
    const portfolio: SkillPortfolioDecision | undefined = result.portfolios?.[profileId];
    assert.ok(portfolio);
    assert.equal(portfolio.estimatedBudget.maxSteps, 8);
    assert.equal(portfolio.estimatedBudget.estimatedSteps, 8);
    assert.equal(portfolio.estimatedBudget.selectedContributorCount, 5);
    assert.equal(portfolio.estimatedBudget.selectedSkillCount, 6);
    assert.deepEqual(
      portfolio.invocations.map(({ skillId, role }) => ({ skillId, role })),
      [
        { skillId: 'competitive-web-research', role: 'contributor' },
        { skillId: 'generate-persona', role: 'contributor' },
        { skillId: 'jobs-to-be-done', role: 'contributor' },
        { skillId: 'build-experience-metrics', role: 'contributor' },
        { skillId: 'virtual-user-research', role: 'contributor' },
        { skillId: 'research-strategy-synthesis', role: 'synthesizer' },
      ],
    );
    const sharedTavily: SkillPortfolioDecision['sharedPrerequisites'][number] | undefined =
      portfolio.sharedPrerequisites.find((prerequisite) => (
        prerequisite.capabilityType === 'tool'
        && prerequisite.capabilityId === 'tavily-web-search'
      ));
    assert.ok(sharedTavily);
    assert.deepEqual(sharedTavily.consumerSkillIds, [
      'build-experience-metrics',
      'competitive-web-research',
      'generate-persona',
      'jobs-to-be-done',
      'research-strategy-synthesis',
    ]);
    assert.equal(sharedTavily.consumerSkillIds.includes('virtual-user-research'), false);

    const candidate: CurrentPlanCandidateProposal | undefined = result.candidates.find(
      ({ id }) => id === profileId,
    );
    assert.ok(candidate);
    assert.equal(candidate.steps.length, 8);
    const compiled = new PlanCompiler().compilePortfolio({
      candidate,
      task: result.structuredTask,
      deliverable_selection: resolvePlanningDeliverableSelection(result.structuredTask),
      problem_graph: result.problemGraph,
      problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: resolvePlanningDeliverableSelection(result.structuredTask).evidenceRequirements,
      capability_demand_graph: result.capabilityDemandGraph!,
      portfolio,
      activated_nodes: result.activatedNodes,
      planning_provenance: result.planningProvenance,
      requireCompetitiveWeightContract: true,
      skillLoader,
    });
    assert.equal(compiled.plan.steps.length, 8);
    const sharedTavilyStep = compiled.plan.steps.find(({ actor_type, actor_id }) => (
      actor_type === 'tool' && actor_id === 'tavily-web-search'
    ));
    assert.ok(sharedTavilyStep);
    const virtualUserOutput = compiled.plan.steps.find((step) => (
      step.skill_invocation_id === 'invocation:virtual-user-research'
      && step.actor_type === 'skill'
    ));
    assert.ok(virtualUserOutput);
  }

  const candidateCall = llm.calls.find(({ schemaName }) => schemaName === 'current-plan-candidates');
  assert.ok(candidateCall);
  assert.deepEqual(
    (candidateCall.context as CandidateContext).profile_specs.map(({ id, max_steps }) => ({ id, max_steps })),
    [{ id: 'speed', max_steps: 8 }, { id: 'depth', max_steps: 8 }],
  );
  assert.match(candidateCall.prompt, /步骤预算为 speed\(max 8\), depth\(max 8\)/u);
  assert.match(candidateCall.prompt, /depth 总步数不得超过 8，speed 总步数不得超过 8/u);
  assert.doesNotMatch(candidateCall.prompt, /speed(?:\(max | 总步数不得超过 )4/u);
});
