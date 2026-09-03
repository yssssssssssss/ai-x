import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { CurrentPlanStep, ProblemGraph } from '../packages/api-contract/research-deliverable.ts';
import type { SkillPortfolioDecision } from '../apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts';
import type { CurrentPlanCandidateProposal } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import {
  ResearchPlanningService,
  resolvePlanningDeliverableSelection,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import { PlanCompiler } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
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

const task: ResearchTaskV2 = {
  version: 'research-task-v2', task_type: 'industry_market_analysis', outcome_mode: 'answer',
  business_domain: 'pet-food',
  research_goal: '分析猫用冻干市场、竞品、用户画像和体验指标，并形成行业策略纵深链',
  target_audience: ['频道产品与设计团队'], scope: ['中国大陆线上宠物食品'], constraints: [],
  success_criteria: [{ id: 'industry-decision', statement: '形成可追溯的行业判断与行动策略' }],
  expected_deliverables: ['industry_market_analysis_report'], assumptions: [], ambiguities: [],
  clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
  industry_scope: {
    category: '宠物食品', subcategories: ['猫用冻干'], exclusions: ['线下渠道'],
    analysis_depth: 'medium', primary_focus: '行业策略', secondary_focuses: ['用户画像', '体验指标'],
    decision_audience: ['频道产品与设计团队'], decision_goal: '确定下一季度优先级',
    time_window: '最近十二个月',
  },
  available_material_roles: ['user_research_dataset'],
  unavailable_material_roles: [
    'jd_screenshots', 'competitor_screenshots', 'competitor_platform_names', 'internal_metrics_dataset',
  ],
};

const evidenceRequirement = {
  id: 'industry-market-analysis-report',
  acceptedClasses: ['public_source', 'knowledge', 'dataset'] as const,
  minimumCount: 1,
  required: true,
};

const graph: ProblemGraph = {
  version: 'problem-graph-v1',
  questions: [
    ['q-market', '猫用冻干的行业市场格局是什么？'],
    ['q-competitive', '主要竞品的差异是什么？'],
    ['q-persona', '真实用户画像和用户分层是什么？'],
    ['q-metrics', '体验指标应如何定义和验证？'],
  ].map(([id, statement]) => ({
    id: id!, statement: statement!, rationale: '支撑行业决策', priority: 'required' as const,
    success_criterion_ids: ['industry-decision'],
    evidence_requirements: [{ ...evidenceRequirement, acceptedClasses: [...evidenceRequirement.acceptedClasses] }],
    acceptance_criteria: ['结论保留证据状态与验证路径'], depends_on: [],
  })),
};

interface CandidateContext {
  profile_specs: Array<{ id: CurrentPlanCandidateProposal['id'] }>;
  portfolios_by_profile: Partial<Record<string, SkillPortfolioDecision>>;
  skills: Array<{
    id: string;
    required_tools: string[];
    optional_tools: Array<{ tool_id: string; status: 'available' | 'unavailable' }>;
  }>;
}

function toolStep(stepNo: number, toolId: string): CurrentPlanStep {
  if (toolId === 'tavily-web-search') {
    return {
      step_no: stepNo, step_name: '共享公开证据', actor_type: 'tool', actor_id: toolId,
      question_ids: graph.questions.map(({ id }) => id), depends_on: [],
      input: { query: task.research_goal }, input_bindings: [],
      expected_outputs: [{ pointer: '/results', description: 'public evidence' }],
      acceptance_criteria: ['公开来源可追溯'], requires_approval: false, fallback_actor_ids: [],
    };
  }
  if (toolId === 'joyspace-read') {
    return {
      step_no: stepNo, step_name: '只读内部知识', actor_type: 'tool', actor_id: toolId,
      question_ids: graph.questions.map(({ id }) => id), depends_on: [],
      input: { operation: 'search', target: '用户研究 行业分析', limit: 5, scope: 'auto', viewTopResult: true },
      input_bindings: [], expected_outputs: [{ pointer: '/documents', description: 'internal knowledge' }],
      acceptance_criteria: ['只读并生成可追溯 Snapshot'], requires_approval: false, fallback_actor_ids: [],
    };
  }
  if (toolId === 'virtual-user-lab') {
    return {
      step_no: stepNo, step_name: '生成虚拟用户假设', actor_type: 'tool', actor_id: toolId,
      question_ids: graph.questions.map(({ id }) => id), depends_on: [],
      input: { scenario: task.research_goal }, input_bindings: [],
      expected_outputs: [{ pointer: '/reviews', description: 'simulation hypotheses' }],
      acceptance_criteria: ['结果保持 simulation 标记'], requires_approval: false, fallback_actor_ids: [],
    };
  }
  throw new Error(`unexpected tool ${toolId}`);
}

function candidateFor(profile: CandidateContext['profile_specs'][number], context: CandidateContext) {
  const portfolio = context.portfolios_by_profile[profile.id];
  if (!portfolio) throw new Error(`missing portfolio ${profile.id}`);
  const skillById = new Map(context.skills.map((skill) => [skill.id, skill]));
  const toolIds = [...new Set(portfolio.invocations.flatMap(({ skillId }) => {
    const skill = skillById.get(skillId);
    return [
      ...(skill?.required_tools ?? []),
      ...(skill?.optional_tools ?? []).flatMap((tool) => tool.status === 'available' ? [tool.tool_id] : []),
    ];
  }))];
  const toolSteps = toolIds.map((toolId, index) => toolStep(index + 1, toolId));
  const skillSteps = portfolio.invocations.map((invocation, index): CurrentPlanStep => ({
    step_no: toolSteps.length + index + 1,
    step_name: invocation.role === 'synthesizer' ? '统一行业综合' : `${invocation.skillId} 研究贡献`,
    actor_type: 'skill', actor_id: invocation.skillId, question_ids: [...invocation.questionIds],
    depends_on: [], input: {
      research_goal: task.research_goal,
      profile_contract: profile.id,
      ...(invocation.skillId === 'run-heuristic-evaluation' ? { jd_screenshots: null } : {}),
    }, input_bindings: [],
    expected_outputs: [{ pointer: '/payload', description: `${invocation.skillId} output` }],
    acceptance_criteria: ['覆盖冻结需求'], requires_approval: false, fallback_actor_ids: [],
  }));
  return {
    id: profile.id, title: `${profile.id} Industry Portfolio`, rationale: '覆盖全部需求',
    tradeoffs: '多个专业贡献后统一综合', steps: [...toolSteps, ...skillSteps], assumptions: [],
  };
}

class IndustryPortfolioLlm implements LLMClient {
  readonly identity = {
    provider: 'industry-portfolio-fixture', endpointHost: 'fixture.invalid',
    requestedModel: 'industry-portfolio-model', mode: 'mock' as const, eligibleAsReal: false,
  };
  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    let data: unknown;
    if (options.schemaName === 'decision-states') data = [];
    else if (options.schemaName === 'problem-graph') {
      const value = structuredClone(graph);
      const evidencePolicy = (options.context as { evidencePolicy?: unknown } | undefined)?.evidencePolicy;
      if (Array.isArray(evidencePolicy)) {
        for (const question of value.questions) {
          question.evidence_requirements = structuredClone(evidencePolicy) as typeof question.evidence_requirements;
        }
      }
      data = value;
    }
    else if (options.schemaName === 'current-plan-candidates') {
      const context = options.context as CandidateContext;
      data = { candidates: context.profile_specs.map((profile) => candidateFor(profile, context)) };
    } else throw new Error(`unexpected LLM call ${options.schemaName}`);
    return {
      data: data as T, promptHash: `sha256:${options.schemaName}`,
      modelName: this.identity.requestedModel, modelVersion: 'fixture-v1',
      traceId: `trace-${options.schemaName}`,
      ...(options.schemaName === 'problem-graph'
        ? { receiptId: '11111111-1111-4111-8111-111111111199' }
        : {}),
    };
  }
  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('text generation is not used');
  }
}

function planningHarness() {
  const adapter = (adapterType: ToolAdapter['adapterType']): ToolAdapter => ({
    adapterType, implementationId: `real-${adapterType}`, executionMode: 'real',
    endpointHost: () => adapterType === 'o2' ? 'joyspace.jd.com' : 'api.tavily.com',
    async invoke() { throw new Error('planning must not invoke Tools'); },
  });
  return new ResearchPlanningService({
    llm: new IndustryPortfolioLlm(), validator: new SchemaValidator(), skillLoader: new SkillLoader(),
    tools: new ToolRouter().register(adapter('tavily')).register(adapter('o2')).register(adapter('rest_json')),
    approvalAuthorities: ['owner'], multiSkillPortfolioMode: 'active', planningPolicy: loadPlanningPolicy(),
  });
}

test('Industry multi_skill compiles Plan v3 with one Synthesizer and dataset-bound Persona Contributor', async () => {
  const result = await planningHarness().planCurrentFromRequirementOutcome(
    task,
    task.research_goal,
    undefined,
    { selectedScenarioId: 'strategy-synthesis', orchestrationMode: 'multi_skill' },
  );
  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  assert.equal(result.orchestrationMode, 'multi_skill');
  for (const candidate of result.candidates) {
    const portfolio: SkillPortfolioDecision | undefined = result.portfolios?.[candidate.id];
    assert.ok(portfolio);
    assert.deepEqual(
      portfolio.invocations.filter(({ role }) => role === 'synthesizer').map(({ skillId }) => skillId),
      ['industry-market-analysis'],
    );
    assert.deepEqual(
      portfolio.invocations.map(({ skillId, role }) => ({ skillId, role })),
      [
        { skillId: 'competitive-web-research', role: 'contributor' },
        { skillId: 'generate-persona', role: 'contributor' },
        { skillId: 'build-experience-metrics', role: 'contributor' },
        { skillId: 'issue-prioritization', role: 'contributor' },
        { skillId: 'industry-market-analysis', role: 'synthesizer' },
      ],
    );
    assert.deepEqual(
      portfolio.demandCoverage
        .filter(({ demandType }) => demandType === 'persona')
        .map(({ ownerSkillId }) => ownerSkillId),
      ['generate-persona'],
    );
    assert.deepEqual(
      portfolio.demandCoverage
        .filter(({ demandType }) => demandType === 'prioritization')
        .map(({ ownerSkillId }) => ownerSkillId),
      ['issue-prioritization'],
    );
    assert.ok(portfolio.invocations.some(({ skillId, role }) => (
      skillId === 'generate-persona' && role === 'contributor'
    )));
    assert.ok(result.capabilityResolution.eligible.some(({ skill }) => skill.id === 'competitive-analysis'));
    const compiled = new PlanCompiler().compilePortfolio({
      candidate, task: result.structuredTask,
      deliverable_selection: resolvePlanningDeliverableSelection(result.structuredTask),
      problem_graph: result.problemGraph, problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: resolvePlanningDeliverableSelection(result.structuredTask).evidenceRequirements,
      capability_demand_graph: result.capabilityDemandGraph!, portfolio,
      activated_nodes: result.activatedNodes, planning_provenance: result.planningProvenance,
      skillLoader: new SkillLoader(),
    });
    assert.equal(compiled.plan.execution_contract_version, 'current-execution-plan-v3');
    assert.equal(compiled.plan.skill_invocations.filter(({ role }) => role === 'synthesizer').length, 1);
    assert.equal(compiled.plan.skill_invocations.find(({ role }) => role === 'synthesizer')?.skill_id, 'industry-market-analysis');
    const dataset = compiled.pending_inputs.find(({ role }) => role === 'user_research_dataset');
    assert.ok(dataset);
    assert.equal(dataset.kind, 'dataset');
    assert.ok(dataset.targets.some(({ tool_id }) => tool_id === 'generate-persona'));
    assert.ok(dataset.targets.some(({ tool_id }) => tool_id === 'industry-market-analysis'));
  }
});

test('Industry multi_skill adds Design Audit only when JD screenshots are promised', async () => {
  const withScreenshots: ResearchTaskV2 = {
    ...structuredClone(task),
    research_goal: `${task.research_goal}，并基于京东截图完成设计走查`,
    available_material_roles: ['user_research_dataset', 'jd_screenshots'],
    unavailable_material_roles: [
      'competitor_screenshots', 'competitor_platform_names', 'internal_metrics_dataset',
    ],
  };
  const result = await planningHarness().planCurrentFromRequirementOutcome(
    withScreenshots,
    withScreenshots.research_goal,
    undefined,
    { selectedScenarioId: 'strategy-synthesis', orchestrationMode: 'multi_skill' },
  );
  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  for (const candidate of result.candidates) {
    const portfolio = result.portfolios?.[candidate.id];
    assert.ok(portfolio?.invocations.some(({ skillId }) => skillId === 'run-heuristic-evaluation'));
    const compiled = new PlanCompiler().compilePortfolio({
      candidate, task: result.structuredTask,
      deliverable_selection: resolvePlanningDeliverableSelection(result.structuredTask),
      problem_graph: result.problemGraph, problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: resolvePlanningDeliverableSelection(result.structuredTask).evidenceRequirements,
      capability_demand_graph: result.capabilityDemandGraph!, portfolio: portfolio!,
      activated_nodes: result.activatedNodes, planning_provenance: result.planningProvenance,
      skillLoader: new SkillLoader(),
    });
    const screenshots = compiled.pending_inputs.find(({ role }) => role === 'jd_screenshots');
    assert.ok(screenshots);
    assert.equal(screenshots.kind, 'visual');
    assert.equal(screenshots.multiple, true);
    assert.ok(screenshots.targets.some(({ tool_id }) => tool_id === 'run-heuristic-evaluation'));
    assert.ok(screenshots.targets.some(({ tool_id }) => tool_id === 'industry-market-analysis'));
  }
});

test('Industry multi_skill includes a simulation-only Contributor only when explicitly requested', async () => {
  const simulationTask: ResearchTaskV2 = {
    ...structuredClone(task),
    research_goal: `${task.research_goal}，允许虚拟用户模拟形成待验证假设`,
    available_material_roles: [],
    unavailable_material_roles: [
      'jd_screenshots', 'competitor_screenshots', 'competitor_platform_names',
      'user_research_dataset', 'internal_metrics_dataset',
    ],
  };
  const result = await planningHarness().planCurrentFromRequirementOutcome(
    simulationTask,
    simulationTask.research_goal,
    undefined,
    { selectedScenarioId: 'strategy-synthesis', orchestrationMode: 'multi_skill' },
  );
  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  for (const portfolio of Object.values(result.portfolios ?? {})) {
    assert.ok(portfolio?.invocations.some(({ skillId }) => skillId === 'virtual-user-research'));
    assert.equal(portfolio?.invocations.some(({ skillId }) => skillId === 'generate-persona'), false);
  }
});

test('Industry multi_skill includes Journey contribution when the requested analysis names a user path', async () => {
  const journeyTask: ResearchTaskV2 = {
    ...structuredClone(task),
    research_goal: `${task.research_goal}，并梳理端到端用户路径和触点`,
    available_material_roles: [],
    unavailable_material_roles: [
      'jd_screenshots', 'competitor_screenshots', 'competitor_platform_names',
      'user_research_dataset', 'internal_metrics_dataset',
    ],
  };
  const result = await planningHarness().planCurrentFromRequirementOutcome(
    journeyTask,
    journeyTask.research_goal,
    undefined,
    { selectedScenarioId: 'strategy-synthesis', orchestrationMode: 'multi_skill' },
  );
  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  for (const portfolio of Object.values(result.portfolios ?? {})) {
    assert.ok(portfolio?.invocations.some(({ skillId }) => skillId === 'journey-map'));
  }
});

test('Industry multi_skill includes JTBD contribution when the requested analysis names user jobs', async () => {
  const jobsTask: ResearchTaskV2 = {
    ...structuredClone(task),
    research_goal: `${task.research_goal}，并分析用户任务、访问动机与雇佣目标`,
    available_material_roles: [],
    unavailable_material_roles: [
      'jd_screenshots', 'competitor_screenshots', 'competitor_platform_names',
      'user_research_dataset', 'internal_metrics_dataset',
    ],
  };
  const result = await planningHarness().planCurrentFromRequirementOutcome(
    jobsTask,
    jobsTask.research_goal,
    undefined,
    { selectedScenarioId: 'strategy-synthesis', orchestrationMode: 'multi_skill' },
  );
  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  for (const portfolio of Object.values(result.portfolios ?? {})) {
    assert.ok(portfolio?.invocations.some(({ skillId }) => skillId === 'jobs-to-be-done'));
  }
});

test('Industry multi_skill omits generate-persona when no real user Dataset is promised', async () => {
  const withoutDataset: ResearchTaskV2 = {
    ...structuredClone(task),
    available_material_roles: [],
    unavailable_material_roles: [
      'jd_screenshots', 'competitor_screenshots', 'competitor_platform_names',
      'user_research_dataset', 'internal_metrics_dataset',
    ],
  };
  const result = await planningHarness().planCurrentFromRequirementOutcome(
    withoutDataset,
    withoutDataset.research_goal,
    undefined,
    { selectedScenarioId: 'strategy-synthesis', orchestrationMode: 'multi_skill' },
  );
  assert.equal('kind' in result, false);
  if ('kind' in result) return;
  for (const portfolio of Object.values(result.portfolios ?? {})) {
    assert.equal(portfolio?.invocations.some(({ skillId }) => skillId === 'generate-persona'), false);
  }
});
