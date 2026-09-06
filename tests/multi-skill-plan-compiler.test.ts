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

test('portfolio compiler drops a declared unavailable optional Tool from a generated candidate', () => {
  const resolution = capabilityResolution();
  const market = resolution.eligible.find(({ skill }) => skill.id === 'competitive-analysis');
  assert.ok(market);
  market.skill.optional_tools = ['playwright-page-capture'];
  market.optional_tool_decisions = [{
    tool_id: 'playwright-page-capture',
    status: 'unavailable',
    reason_code: 'optional_tool_real_adapter_unavailable',
    message: 'optional tool has no qualified real adapter',
  }];
  const loader = {
    getSkill(id: string) {
      const skill = legacySkillLoader.getSkill(id)!;
      return id === 'competitive-analysis'
        ? { ...skill, optional_tools: ['playwright-page-capture'] }
        : skill;
    },
    loadSkillExecution() { return null; },
  } as unknown as SkillLoader;
  const optionalStep: CurrentPlanStep = {
    step_no: 5,
    step_name: '可选页面抓取',
    actor_type: 'tool',
    actor_id: 'playwright-page-capture',
    question_ids: ['question-market'],
    depends_on: [1],
    input: { urls: [] },
    input_bindings: [],
    expected_outputs: [{ pointer: '/pages', description: '可选页面' }],
    acceptance_criteria: ['可用时补充页面证据'],
    requires_approval: false,
    fallback_actor_ids: [],
  };

  const compiled = compilePortfolioSkillSteps({
    steps: [...highLevelSteps(), optionalStep],
    task,
    portfolio,
    capabilityResolution: resolution,
    skillLoader: loader,
  });

  assert.equal(compiled.steps.some(({ actor_id }) => actor_id === 'playwright-page-capture'), false);
});

test('portfolio compiler records Synthesizer-owned Demands as direct answers, not Contributions', () => {
  const directPortfolio = structuredClone(portfolio);
  directPortfolio.invocations = [{
    ...structuredClone(portfolio.invocations[2]!),
    demandIds: ['demand-market'],
    contributionTypes: ['competitive_analysis'],
    questionIds: ['question-market'],
  }];
  directPortfolio.demandCoverage = [{
    ...structuredClone(portfolio.demandCoverage[0]!),
    ownerSkillId: 'research-strategy-synthesis',
  }];
  directPortfolio.sharedPrerequisites = [];
  directPortfolio.estimatedBudget = {
    ...directPortfolio.estimatedBudget,
    estimatedSteps: 2,
    selectedContributorCount: 0,
    selectedSkillCount: 1,
  };
  const sourceSteps = [highLevelSteps()[0]!, highLevelSteps()[3]!].map((step, index) => ({
    ...step,
    step_no: index + 1,
    depends_on: [],
  }));

  const compiled = compilePortfolioSkillSteps({
    steps: sourceSteps,
    task,
    portfolio: directPortfolio,
    skillLoader: legacySkillLoader,
  });

  assert.deepEqual(compiled.invocations[0]?.demand_ids, ['demand-market']);
  assert.deepEqual(compiled.contributionRequirements, []);
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

test('declared shared prerequisites are wired into every consumer root even when the model omits dependencies', () => {
  const source = highLevelSteps();
  source[1]!.depends_on = [];
  source[2]!.depends_on = [];
  const compiled = compilePortfolioSkillSteps({ steps: source, task, portfolio, skillLoader: legacySkillLoader });
  const shared = compiled.steps.find(({ shared_stage_key }) => Boolean(shared_stage_key));
  const market = compiled.steps.find(({ skill_invocation_id }) => skill_invocation_id === 'invocation:market');
  const persona = compiled.steps.find(({ skill_invocation_id }) => skill_invocation_id === 'invocation:persona');
  assert.ok(shared && market && persona);
  assert.ok(market.depends_on.includes(shared.step_no));
  assert.ok(persona.depends_on.includes(shared.step_no));
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

test('portfolio compiler removes model-invented cross-Contributor wiring before applying frozen dependencies', () => {
  const source = highLevelSteps();
  source[0]!.depends_on = [3];
  source[2]!.depends_on = [1, 2];
  source[2]!.input_bindings = [{
    target_pointer: '/prior_contribution', source_step_no: 2, source_pointer: '/payload',
  }];
  source[2]!.input.prior_contribution = null;
  const compiled = compilePortfolioSkillSteps({ steps: source, task, portfolio, skillLoader: legacySkillLoader });
  const persona = compiled.steps.find(({ skill_invocation_id }) => skill_invocation_id === 'invocation:persona');
  const market = compiled.steps.find(({ skill_invocation_id }) => skill_invocation_id === 'invocation:market');
  assert.ok(persona && market);
  assert.deepEqual(compiled.steps[0]!.depends_on, []);
  assert.equal(persona.depends_on.includes(market.step_no), false);
  assert.equal(persona.input_bindings.some(({ source_step_no }) => source_step_no === market.step_no), false);
});

test('portfolio compiler removes model-invented Skill wiring from Tool and Knowledge targets', () => {
  const cases: Array<{
    capabilityType: 'tool' | 'knowledge';
    capabilityId: string;
  }> = [
    { capabilityType: 'tool', capabilityId: 'tavily-web-search' },
    { capabilityType: 'knowledge', capabilityId: 'knowledge.index' },
  ];

  for (const { capabilityType, capabilityId } of cases) {
    const compilerOwnedWiringLoader = {
      getSkill(id: string) {
        const consumesSharedTool = capabilityType === 'tool'
          && id !== 'research-strategy-synthesis';
        return {
          id,
          required_tools: consumesSharedTool ? [capabilityId] : [],
          composition: {
            modes: id === 'research-strategy-synthesis' ? ['synthesizer'] : ['contributor'],
            supported_outcomes: ['answer'],
            compatible_deliverables: ['research_strategy_report'],
            contribution_types: ['qualitative_insight'],
            contribution_schema: 'schemas/research-contribution-v1.schema.json',
            contribution_adapter: 'skill-envelope-provisional-v1',
            required_input_roles: [],
            optional_input_roles: [],
            shareable_prerequisites: consumesSharedTool ? [capabilityId] : [],
          },
        };
      },
      loadSkillExecution() { return null; },
    } as unknown as SkillLoader;
    const original = highLevelSteps();
    const source: CurrentPlanStep[] = [
      { ...structuredClone(original[1]!), step_no: 1, depends_on: [], input_bindings: [] },
      {
        ...structuredClone(original[0]!),
        step_no: 2,
        actor_type: capabilityType,
        actor_id: capabilityId,
        depends_on: [1],
        input_bindings: [{
          target_pointer: '/query',
          source_step_no: 1,
          source_pointer: '/payload',
        }],
      },
      { ...structuredClone(original[2]!), step_no: 3, depends_on: [], input_bindings: [] },
      { ...structuredClone(original[3]!), step_no: 4, depends_on: [], input_bindings: [] },
    ];
    const candidatePortfolio = {
      ...structuredClone(portfolio),
      sharedPrerequisites: [{
        capabilityType,
        capabilityId,
        consumerSkillIds: ['competitive-analysis', 'generate-persona'],
      }],
    };

    const compiled = compilePortfolioSkillSteps({
      steps: source,
      task,
      portfolio: candidatePortfolio,
      skillLoader: compilerOwnedWiringLoader,
    });
    const target = compiled.steps.find((step) => (
      step.actor_type === capabilityType && step.actor_id === capabilityId
    ));
    const skillStepNos = new Set(compiled.steps
      .filter(({ actor_type }) => actor_type === 'skill')
      .map(({ step_no }) => step_no));

    assert.ok(target);
    assert.equal(target.depends_on.some((stepNo) => skillStepNos.has(stepNo)), false);
    assert.equal(
      target.input_bindings.some(({ source_step_no }) => skillStepNos.has(source_step_no)),
      false,
    );
  }
});

test('portfolio compiler replaces model-invented Skill compilation metadata', () => {
  const source = highLevelSteps();
  const metricsLikeLegacyStep = source[2]!;
  metricsLikeLegacyStep.skill_invocation_id = 'model-invented:build-experience-metrics';
  metricsLikeLegacyStep.skill_stage_id = 'model-invented-output';
  Object.assign(metricsLikeLegacyStep, {
    shared_stage_key: 'shared:tool:model-invented',
    shared_by_invocation_ids: ['model-owner-a', 'model-owner-b'],
    share_fingerprint: `sha256:${'f'.repeat(64)}`,
  });

  const compiled = compilePortfolioSkillSteps({
    steps: source,
    task,
    portfolio,
    skillLoader: legacySkillLoader,
  });
  const persona = compiled.steps.find(({ actor_id }) => actor_id === 'generate-persona');

  assert.ok(persona);
  assert.equal(persona.skill_invocation_id, 'invocation:persona');
  assert.equal(persona.skill_stage_id, 'legacy-call');
  assert.equal(persona.shared_stage_key, undefined);
  assert.equal(persona.shared_by_invocation_ids, undefined);
  assert.equal(persona.share_fingerprint, undefined);
  assert.equal(
    compiled.invocations.find(({ skill_id }) => skill_id === 'generate-persona')?.execution_mode,
    'legacy_single_call',
  );
});

test('portfolio compiler rejects a declared shared prerequisite with no source step', () => {
  const source = highLevelSteps().filter(({ actor_id }) => actor_id !== 'tavily-web-search');
  assert.throws(
    () => compilePortfolioSkillSteps({ steps: source, task, portfolio, skillLoader: legacySkillLoader }),
    /Shared prerequisite tool:tavily-web-search has no source step/u,
  );
});

test('portfolio compiler rejects model-invented actors instead of silently dropping them', () => {
  const source = highLevelSteps();
  source.splice(1, 0, {
    ...structuredClone(source[0]!),
    step_no: 2,
    actor_type: 'llm',
    actor_id: 'llm.model-invented',
  });
  for (let index = 2; index < source.length; index += 1) {
    source[index]!.step_no = index + 1;
  }

  assert.throws(
    () => compilePortfolioSkillSteps({ steps: source, task, portfolio, skillLoader: legacySkillLoader }),
    /Portfolio candidate contains unauthorized actor llm:llm\.model-invented/u,
  );
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

test('portfolio compiler wires an unshared required Tool into its legacy Contributor', () => {
  const virtualPortfolio: SkillPortfolioDecision = {
    ...structuredClone(portfolio),
    invocations: [
      {
        ...structuredClone(portfolio.invocations[0]!),
        invocationId: 'invocation:virtual-user',
        skillId: 'virtual-user-research',
        contributionTypes: ['virtual_user_hypothesis'],
      },
      structuredClone(portfolio.invocations[2]!),
    ],
    demandCoverage: [{
      ...structuredClone(portfolio.demandCoverage[0]!),
      ownerSkillId: 'virtual-user-research',
      demandType: 'virtual_user_hypothesis',
    }],
    sharedPrerequisites: [],
  };
  const virtualSkillLoader = {
    getSkill(id: string) {
      return {
        id,
        required_tools: id === 'virtual-user-research' ? ['virtual-user-lab'] : [],
        composition: {
          modes: id === 'research-strategy-synthesis' ? ['synthesizer'] : ['contributor'],
          supported_outcomes: ['answer'],
          compatible_deliverables: ['research_strategy_report'],
          contribution_types: id === 'virtual-user-research'
            ? ['virtual_user_hypothesis']
            : ['strategy'],
          contribution_schema: 'schemas/research-contribution-v1.schema.json',
          contribution_adapter: id === 'virtual-user-research'
            ? 'virtual-user-tool-v1'
            : 'skill-envelope-provisional-v1',
          required_input_roles: [],
          optional_input_roles: [],
        },
      };
    },
    loadSkillExecution() { return null; },
  } as unknown as SkillLoader;
  const steps = highLevelSteps().slice(0, 3);
  steps[0]!.actor_id = 'virtual-user-lab';
  steps[0]!.input = { scenario: 'crowdfunding trust' };
  steps[1]!.actor_id = 'virtual-user-research';
  steps[1]!.depends_on = [];
  steps[2]!.actor_id = 'research-strategy-synthesis';
  steps[2]!.depends_on = [2];

  const compiled = compilePortfolioSkillSteps({
    steps,
    task,
    portfolio: virtualPortfolio,
    skillLoader: virtualSkillLoader,
  });
  const tool = compiled.steps.find(({ actor_id }) => actor_id === 'virtual-user-lab');
  const contributor = compiled.steps.find(({ actor_id }) => actor_id === 'virtual-user-research');
  assert.ok(tool && contributor);
  assert.ok(contributor.depends_on.includes(tool.step_no));
});

test('portfolio compiler allocates unshared required Tool instances exclusively to legacy invocations', () => {
  const contributorIds = ['virtual-user-market', 'virtual-user-persona'] as const;
  const exclusivePortfolio: SkillPortfolioDecision = {
    ...structuredClone(portfolio),
    invocations: [
      {
        ...structuredClone(portfolio.invocations[0]!),
        invocationId: 'invocation:virtual-market',
        skillId: contributorIds[0],
      },
      {
        ...structuredClone(portfolio.invocations[1]!),
        invocationId: 'invocation:virtual-persona',
        skillId: contributorIds[1],
      },
      structuredClone(portfolio.invocations[2]!),
    ],
    demandCoverage: [
      {
        ...structuredClone(portfolio.demandCoverage[0]!),
        ownerSkillId: contributorIds[0],
      },
      {
        ...structuredClone(portfolio.demandCoverage[1]!),
        ownerSkillId: contributorIds[1],
      },
    ],
    sharedPrerequisites: [],
  };
  const exclusiveToolLoader = {
    getSkill(id: string) {
      return {
        id,
        required_tools: contributorIds.includes(id as typeof contributorIds[number])
          ? ['virtual-user-lab']
          : [],
        composition: {
          modes: id === 'research-strategy-synthesis' ? ['synthesizer'] : ['contributor'],
          supported_outcomes: ['answer'],
          compatible_deliverables: ['research_strategy_report'],
          contribution_types: ['virtual_user_hypothesis'],
          contribution_schema: 'schemas/research-contribution-v1.schema.json',
          contribution_adapter: 'skill-envelope-provisional-v1',
          required_input_roles: [],
          optional_input_roles: [],
          shareable_prerequisites: [],
        },
      };
    },
    loadSkillExecution() { return null; },
  } as unknown as SkillLoader;
  const original = highLevelSteps();
  const source: CurrentPlanStep[] = [
    {
      ...structuredClone(original[0]!),
      step_no: 1,
      actor_id: 'virtual-user-lab',
      input: { scenario: 'market' },
    },
    {
      ...structuredClone(original[0]!),
      step_no: 2,
      actor_id: 'virtual-user-lab',
      input: { scenario: 'persona' },
    },
    {
      ...structuredClone(original[1]!),
      step_no: 3,
      actor_id: contributorIds[0],
      depends_on: [],
    },
    {
      ...structuredClone(original[2]!),
      step_no: 4,
      actor_id: contributorIds[1],
      depends_on: [],
    },
    { ...structuredClone(original[3]!), step_no: 5, depends_on: [] },
  ];

  const compiled = compilePortfolioSkillSteps({
    steps: source,
    task,
    portfolio: exclusivePortfolio,
    skillLoader: exclusiveToolLoader,
  });
  const toolStepNos = new Set(compiled.steps
    .filter(({ actor_type, actor_id }) => actor_type === 'tool' && actor_id === 'virtual-user-lab')
    .map(({ step_no }) => step_no));
  const assignedToolStepNos = contributorIds.map((skillId) => {
    const contributor = compiled.steps.find(({ actor_id }) => actor_id === skillId);
    assert.ok(contributor);
    const dependencies = contributor.depends_on.filter((stepNo) => toolStepNos.has(stepNo));
    assert.equal(dependencies.length, 1);
    return dependencies[0]!;
  });
  assert.equal(new Set(assignedToolStepNos).size, contributorIds.length);

  const oneToolOnly = source.slice(1).map((step, index) => ({
    ...structuredClone(step),
    step_no: index + 1,
  }));
  assert.throws(
    () => compilePortfolioSkillSteps({
      steps: oneToolOnly,
      task,
      portfolio: exclusivePortfolio,
      skillLoader: exclusiveToolLoader,
    }),
    /has no unclaimed compiled source step/u,
  );
});
