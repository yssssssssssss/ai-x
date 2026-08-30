import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CapabilityDemandGraphV1, ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { CurrentPlanStep, ProblemGraph } from '../packages/api-contract/research-deliverable.ts';
import { PlanCompiler } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import type { CapabilityResolution } from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import {
  CapabilityPortfolioResolutionError,
  CapabilityPortfolioResolver,
} from '../apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts';
import {
  readVerifiedStepArtifact,
  resolveStepInput,
  type SealedStepOutput,
  type VerifiedArtifactReader,
} from '../apps/orchestrator-runtime/src/control/step-input-resolver.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { prepareSkillExecution } from '../apps/orchestrator-runtime/src/skills/skill-runtime.ts';
import type { ControlArtifact } from '../database/control-plane.ts';

interface ContributorContractFixture {
  skillId: string;
  contractPath: string;
  knowledgeStageId: string;
  outputStageId: string;
  resourceIds: string[];
  skillReferences: string[];
}

const fixtures: ContributorContractFixture[] = [
  {
    skillId: 'generate-persona',
    contractPath: 'orchestrator/skill-executions/generate-persona.yaml',
    knowledgeStageId: 'load-persona-methods',
    outputStageId: 'compose-persona-contribution',
    resourceIds: [
      'toolbox_collection_persona',
      'toolbox_analysis_affinity_diagram',
      'toolbox_analysis_qualitative_insight_frameworks',
      'model_user_insight',
    ],
    skillReferences: ['references/persona-skeleton.md'],
  },
  {
    skillId: 'jobs-to-be-done',
    contractPath: 'orchestrator/skill-executions/jobs-to-be-done.yaml',
    knowledgeStageId: 'load-jtbd-methods',
    outputStageId: 'compose-jtbd-contribution',
    resourceIds: [
      'model_jtbd',
      'model_user_needs',
      'model_user_insight',
    ],
    skillReferences: ['references/jtbd-skeleton.md'],
  },
  {
    skillId: 'build-experience-metrics',
    contractPath: 'orchestrator/skill-executions/build-experience-metrics.yaml',
    knowledgeStageId: 'load-metrics-methods',
    outputStageId: 'compose-metrics-contribution',
    resourceIds: [
      'toolbox_analysis_experience_metrics_heart',
    ],
    skillReferences: ['references/metrics-system-skeleton.md'],
  },
];

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'research_synthesis',
  outcome_mode: 'answer',
  requested_artifacts: [],
  business_domain: 'crowdfunding',
  research_goal: 'Use public evidence to identify target users and their needs.',
  target_audience: ['product team'],
  scope: ['public evidence'],
  constraints: [],
  success_criteria: [{ id: 'SC-1', statement: 'Conclusions remain traceable to evidence.' }],
  expected_deliverables: ['research_strategy_report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

function sourceSteps(
  fixture: ContributorContractFixture,
  loader: SkillLoader,
): CurrentPlanStep[] {
  const synthesis = loader.loadSkillExecution('research-strategy-synthesis');
  assert.ok(synthesis);
  const sharedStage = synthesis.contract.stages.find(({ stage_id }) => (
    stage_id === 'collect-public-evidence'
  ));
  assert.ok(sharedStage);
  return [
    {
      step_no: 1,
      step_name: sharedStage.title,
      actor_type: sharedStage.actor_type,
      actor_id: sharedStage.actor_id,
      question_ids: ['Q1'],
      depends_on: [],
      input: { ...structuredClone(sharedStage.input), query: 'crowdfunding user evidence' },
      input_bindings: [],
      expected_outputs: structuredClone(sharedStage.expected_outputs),
      acceptance_criteria: [...sharedStage.acceptance_criteria],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 2,
      step_name: `${fixture.skillId} contribution`,
      actor_type: 'skill',
      actor_id: fixture.skillId,
      question_ids: ['Q1'],
      depends_on: [1],
      input: {},
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload', description: `${fixture.skillId} payload` }],
      acceptance_criteria: ['Output is evidence-bound.'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
  ];
}

for (const fixture of fixtures) {
  test(`${fixture.skillId} exposes a minimal compiled Contributor contract`, () => {
    const loader = new SkillLoader();
    const registryEntry = loader.getSkill(fixture.skillId);
    assert.ok(registryEntry);
    assert.equal(registryEntry.execution_mode, 'compiled');
    assert.equal(registryEntry.execution_contract, fixture.contractPath);
    assert.deepEqual(registryEntry.required_tools, ['tavily-web-search']);

    const loaded = loader.loadSkillExecution(fixture.skillId);
    assert.ok(loaded);
    assert.deepEqual(loaded.contract.stages.map(({ stage_id }) => stage_id), [
      fixture.knowledgeStageId,
      'collect-public-evidence',
      fixture.outputStageId,
    ]);
    assert.deepEqual(
      loaded.contract.resources.map(({ resource_id }) => resource_id),
      fixture.resourceIds,
    );
    assert.deepEqual(loaded.contract.skill_references, fixture.skillReferences);

    const synthesis = loader.loadSkillExecution('research-strategy-synthesis');
    assert.ok(synthesis);
    assert.deepEqual(
      loaded.contract.stages.find(({ stage_id }) => stage_id === 'collect-public-evidence'),
      synthesis.contract.stages.find(({ stage_id }) => stage_id === 'collect-public-evidence'),
    );

    const output = loaded.contract.stages.find(({ stage_id }) => stage_id === fixture.outputStageId);
    assert.ok(output);
    assert.equal(loaded.contract.output_stage_id, fixture.outputStageId);
    assert.equal(loaded.contract.output_pointer, '/payload');
    assert.deepEqual(output.depends_on, [fixture.knowledgeStageId, 'collect-public-evidence']);
    assert.deepEqual(output.input_bindings, [
      {
        target_pointer: '/knowledge',
        source_stage_id: fixture.knowledgeStageId,
        source_pointer: '/resources',
      },
      {
        target_pointer: '/public_evidence',
        source_stage_id: 'collect-public-evidence',
        source_pointer: '/results',
      },
    ]);
  });

  test(`${fixture.skillId} compiles standalone through PlanCompiler with native payload output`, () => {
    const loader = new SkillLoader();
    const skill = loader.listCapabilitySkills().find(({ id }) => id === fixture.skillId);
    assert.ok(skill && skill.status === 'active');
    const evidenceRequirements: ProblemGraph['questions'][number]['evidence_requirements'] = [{
      id: 'public-evidence',
      acceptedClasses: ['public_source'],
      minimumCount: 1,
      required: true,
    }];
    const problemGraph: ProblemGraph = {
      version: 'problem-graph-v1',
      questions: [{
        id: 'Q1',
        statement: `What is the evidence-bound ${fixture.skillId} answer?`,
        rationale: 'Required specialist analysis.',
        priority: 'required',
        success_criterion_ids: ['SC-1'],
        evidence_requirements: structuredClone(evidenceRequirements),
        acceptance_criteria: ['Provide a direct answer with evidence or an explicit provisional status.'],
        depends_on: [],
      }],
    };
    const compiled = new PlanCompiler().compile({
      candidate: {
        id: 'depth',
        title: `${fixture.skillId} standalone`,
        rationale: 'Compile one specialist against shared public evidence.',
        tradeoffs: 'Uses the complete compiled Skill contract.',
        steps: sourceSteps(fixture, loader),
        assumptions: [],
        activated_nodes: [],
      },
      task,
      deliverable_selection: {
        deliverableId: 'research_strategy_report',
        evidenceRequirements: structuredClone(evidenceRequirements),
      },
      problem_graph: problemGraph,
      problem_graph_provenance: {
        receiptId: '11111111-1111-4111-8111-111111111111',
        modelName: 'fixture-planner',
        modelVersion: 'v1',
        promptHash: 'sha256:fixture',
        traceId: 'trace-fixture',
      },
      capability_resolution: {
        eligible: [{
          skill,
          required_approvals: [],
          reasons: [{ code: 'eligible', message: 'fixture eligible' }],
          pending_inputs: [],
          optional_tool_decisions: [],
        }],
        rejected: [],
      },
      evidence_requirements: structuredClone(evidenceRequirements),
      activated_nodes: [],
    });

    assert.equal(compiled.plan.execution_contract_version, 'current-execution-plan-v2');
    assert.equal(compiled.plan.skill_invocations?.length, 1);
    const invocation = compiled.plan.skill_invocations?.[0];
    assert.ok(invocation);
    assert.equal(invocation.skill_id, fixture.skillId);
    assert.equal(invocation.step_nos.length, 3);
    assert.equal(compiled.plan.steps.length, 3);
    assert.deepEqual(
      invocation.step_nos
        .map((stepNo) => compiled.plan.steps[stepNo - 1]?.skill_stage_id)
        .sort(),
      ['collect-public-evidence', fixture.knowledgeStageId, fixture.outputStageId].sort(),
    );
    assert.equal(
      compiled.plan.steps.filter(({ actor_id }) => actor_id === 'tavily-web-search').length,
      1,
    );

    const knowledge = compiled.plan.steps.find(({ skill_stage_id }) => (
      skill_stage_id === fixture.knowledgeStageId
    ));
    const evidence = compiled.plan.steps.find(({ skill_stage_id }) => (
      skill_stage_id === 'collect-public-evidence'
    ));
    const output = compiled.plan.steps.find(({ skill_stage_id }) => (
      skill_stage_id === fixture.outputStageId
    ));
    assert.ok(knowledge && evidence && output);
    assert.deepEqual(
      (knowledge.input.references as Array<{ resourceId: string }>).map(({ resourceId }) => resourceId),
      fixture.resourceIds,
    );
    assert.deepEqual(output.depends_on, [knowledge.step_no, evidence.step_no].sort((a, b) => a - b));
    assert.deepEqual(output.input_bindings, [
      {
        target_pointer: '/knowledge',
        source_step_no: knowledge.step_no,
        source_pointer: '/resources',
      },
      {
        target_pointer: '/public_evidence',
        source_step_no: evidence.step_no,
        source_pointer: '/results',
      },
    ]);
    assert.deepEqual(output.expected_outputs, [{
      pointer: '/payload',
      description: `${fixture.skillId} payload`,
    }]);
  });
}

test('depth binds one verified Tavily Artifact into every Contributor LLM context', async () => {
  const loader = new SkillLoader();
  const contributorTypes = [
    ['generate-persona', 'persona', 'Q-persona'],
    ['jobs-to-be-done', 'jobs_to_be_done', 'Q-jtbd'],
    ['build-experience-metrics', 'metrics', 'Q-metrics'],
  ] as const;
  const selectedIds = [
    ...contributorTypes.map(([skillId]) => skillId),
    'research-strategy-synthesis',
  ];
  const selectedSkills = selectedIds.map((skillId) => {
    const skill = loader.listCapabilitySkills().find(({ id }) => id === skillId);
    assert.ok(skill && skill.status === 'active');
    return skill;
  });
  const capabilityResolution: CapabilityResolution = {
    eligible: selectedSkills.map((skill) => ({
      skill,
      required_approvals: [],
      reasons: [{ code: 'eligible', message: 'fixture eligible' }],
      pending_inputs: [],
      optional_tool_decisions: [],
    })),
    rejected: [],
  };
  const portfolioTask: ResearchTaskV2 = {
    ...task,
    requested_artifacts: [],
    research_goal: 'Define crowdfunding Personas, Jobs To Be Done, and experience metrics.',
  };
  const problemGraph: ProblemGraph = {
    version: 'problem-graph-v1',
    questions: contributorTypes.map(([, type, questionId]) => ({
      id: questionId,
      statement: `What is the evidence-bound ${type} answer?`,
      rationale: 'Required specialist analysis.',
      priority: 'required',
      success_criterion_ids: ['SC-1'],
      evidence_requirements: [{
        id: 'public-evidence',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
      acceptance_criteria: ['Provide a direct answer with evidence or an explicit provisional status.'],
      depends_on: [],
    })),
  };
  const capabilityDemandGraph: CapabilityDemandGraphV1 = {
    version: 'capability-demand-graph-v1',
    demands: contributorTypes.map(([, type, questionId]) => ({
      id: `demand-${type}`,
      type,
      questionIds: [questionId],
      requestedArtifactTypes: [],
      requiredEvidenceClasses: ['public_source'],
      requiredInputRoles: ['research_goal'],
      priority: 'required',
    })),
  };
  const compositionPolicy = {
    mode: 'portfolio' as const,
    synthesizer_skill_id: 'research-strategy-synthesis',
    accepted_contribution_types: ['persona', 'jobs_to_be_done', 'metrics'] as const,
    contribution_schema: 'schemas/research-contribution-v1.schema.json',
  };
  const stepEstimates = Object.fromEntries(selectedSkills.map((skill) => [
    skill.id,
    1 + skill.required_tools.length,
  ]));
  const resolve = (maxSteps: number) => new CapabilityPortfolioResolver().resolve({
    task: portfolioTask,
    problemGraph,
    capabilityDemandGraph,
    deliverableId: 'research_strategy_report',
    compositionPolicy: {
      ...compositionPolicy,
      accepted_contribution_types: [...compositionPolicy.accepted_contribution_types],
    },
    capabilityResolution,
    profile: { id: maxSteps === 4 ? 'speed' : 'depth', max_steps: maxSteps },
    availableInputRoles: ['research_goal'],
    stepEstimates,
  });

  assert.throws(
    () => resolve(4),
    (error: unknown) => error instanceof CapabilityPortfolioResolutionError
      && error.kind === 'profile_budget_exceeded',
  );
  const portfolio = resolve(8);
  assert.equal(portfolio.estimatedBudget.estimatedSteps, 5);
  assert.equal(portfolio.estimatedBudget.maxSteps, 8);

  const synthesis = loader.loadSkillExecution('research-strategy-synthesis');
  assert.ok(synthesis);
  const sharedStage = synthesis.contract.stages.find(({ stage_id }) => (
    stage_id === 'collect-public-evidence'
  ));
  assert.ok(sharedStage);
  const candidateSteps: CurrentPlanStep[] = [
    {
      step_no: 1,
      step_name: sharedStage.title,
      actor_type: sharedStage.actor_type,
      actor_id: sharedStage.actor_id,
      question_ids: contributorTypes.map(([, , questionId]) => questionId),
      depends_on: [],
      input: { ...structuredClone(sharedStage.input), query: 'crowdfunding user evidence' },
      input_bindings: [],
      expected_outputs: structuredClone(sharedStage.expected_outputs),
      acceptance_criteria: [...sharedStage.acceptance_criteria],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    ...portfolio.invocations.map((invocation, index): CurrentPlanStep => ({
      step_no: index + 2,
      step_name: `${invocation.skillId} output`,
      actor_type: 'skill',
      actor_id: invocation.skillId,
      question_ids: invocation.questionIds,
      depends_on: [],
      input: {},
      input_bindings: [],
      expected_outputs: [{
        pointer: invocation.role === 'contributor' ? '/contribution' : '/payload',
        description: `${invocation.skillId} output`,
      }],
      acceptance_criteria: ['Output satisfies its frozen contract.'],
      requires_approval: false,
      fallback_actor_ids: [],
    })),
  ];
  const compiled = new PlanCompiler().compilePortfolio({
    candidate: {
      id: 'depth',
      title: 'Three specialist contributors',
      rationale: 'Compile specialist evidence paths before synthesis.',
      tradeoffs: 'Uses the depth budget.',
      steps: candidateSteps,
      assumptions: [],
      activated_nodes: [],
    },
    task: portfolioTask,
    deliverable_selection: {
      deliverableId: 'research_strategy_report',
      evidenceRequirements: [{
        id: 'public-evidence',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
    problem_graph: problemGraph,
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'fixture-planner',
      modelVersion: 'v1',
      promptHash: 'sha256:fixture',
      traceId: 'trace-fixture',
    },
    capability_resolution: capabilityResolution,
    evidence_requirements: [{
      id: 'public-evidence',
      acceptedClasses: ['public_source'],
      minimumCount: 1,
      required: true,
    }],
    capability_demand_graph: capabilityDemandGraph,
    portfolio,
    activated_nodes: [],
    skillLoader: loader,
  });

  assert.equal(compiled.plan.steps.filter(({ actor_id }) => actor_id === 'tavily-web-search').length, 1);
  assert.equal(compiled.plan.portfolio_summary.estimated_budget.expanded_step_count, 15);
  assert.equal(compiled.plan.portfolio_summary.estimated_budget.expanded_step_limit, 18);
  const shared = compiled.plan.steps.find(({ shared_stage_key }) => Boolean(shared_stage_key));
  assert.ok(shared);
  assert.deepEqual(
    [...(shared.shared_by_invocation_ids ?? [])].sort(),
    portfolio.invocations.map(({ invocationId }) => invocationId).sort(),
  );
  for (const [skillId] of contributorTypes) {
    const output = compiled.plan.steps.find((step) => (
      step.actor_id === skillId && step.actor_type === 'skill'
    ));
    assert.ok(output);
    assert.deepEqual(output.expected_outputs, [{
      pointer: '/contribution',
      description: `${skillId} Research Contribution`,
    }]);
    assert.ok(output.depends_on.includes(shared.step_no));
    assert.ok(output.input_bindings.some((binding) => (
      binding.source_step_no === shared.step_no
      && binding.target_pointer === '/public_evidence'
      && binding.source_pointer === '/results'
    )));
  }

  const artifactScope = {
    taskId: 'task-shared-evidence',
    planVersionId: 'plan-shared-evidence',
    attemptId: 'attempt-shared-evidence',
  };
  const publicEvidence = [{
    title: 'JD crowdfunding evidence',
    url: 'https://example.test/jd-crowdfunding',
    snippet: 'A verified public-source result shared by every specialist.',
    score: 0.91,
    published_date: null,
  }];
  const artifactValues = new Map<string, { artifact: ControlArtifact; value: unknown }>();
  const sealedOutputs: SealedStepOutput[] = [];
  const seal = (
    step: CurrentPlanStep,
    kind: SealedStepOutput['kind'],
    value: unknown,
  ): SealedStepOutput => {
    const artifactId = `artifact-step-${step.step_no}`;
    const contentSha256 = `sha256:step-${step.step_no}`;
    const artifact: ControlArtifact = {
      id: artifactId,
      ...artifactScope,
      kind,
      state: 'SEALED',
      storageUri: `/verified/${artifactId}.json`,
      contentSha256,
      byteSize: 1,
      schemaVersion: kind === 'tool_output' ? 'tool-output-v1' : 'knowledge-bundle-v1',
      sensitivity: 'public',
      redactionPolicyVersion: 'v1',
      failureReason: null,
    };
    artifactValues.set(artifactId, { artifact, value });
    const output: SealedStepOutput = {
      stepNo: step.step_no,
      actorId: step.actor_id,
      kind,
      state: 'succeeded',
      ...artifactScope,
      artifact: { id: artifactId, state: 'SEALED', contentSha256 },
    };
    sealedOutputs.push(output);
    return output;
  };
  const sharedOutput = seal(shared, 'tool_output', {
    output: { answer: null, response_time: 0.1, results: publicEvidence },
    outputHash: 'sha256:shared-tavily-output',
  });
  for (const step of compiled.plan.steps.filter(({ actor_type }) => actor_type === 'knowledge')) {
    seal(step, 'knowledge_output', {
      resources: [{
        id: `knowledge-${step.step_no}`,
        title: 'Verified method',
        content: 'Apply the frozen specialist method.',
        contentHash: `sha256:knowledge-${step.step_no}`,
      }],
    });
  }
  const artifactReader: VerifiedArtifactReader = {
    async readVerifiedJson<T>(artifactId: string) {
      const stored = artifactValues.get(artifactId);
      if (!stored) throw new Error(`missing fixture Artifact ${artifactId}`);
      return stored as { artifact: ControlArtifact; value: T };
    },
  };
  const verifiedShared = await readVerifiedStepArtifact(sharedOutput, artifactReader);
  const sharedEvidenceIdentity = {
    stepNo: shared.step_no,
    actorId: shared.actor_id,
    kind: sharedOutput.kind,
    output: verifiedShared.output,
    artifact: sharedOutput.artifact,
    evidenceIds: [`E${shared.step_no}-1`],
  };

  for (const [skillId] of contributorTypes) {
    const output = compiled.plan.steps.find((step) => (
      step.actor_id === skillId && step.actor_type === 'skill'
    ));
    assert.ok(output);
    const dependencies = sealedOutputs.filter(({ stepNo }) => output.depends_on.includes(stepNo));
    const resolvedInput = await resolveStepInput(output, dependencies, artifactReader);
    const prepared = prepareSkillExecution({
      skillId,
      researchGoal: portfolioTask.research_goal,
      resolvedInput,
      priorOutputs: [
        sharedEvidenceIdentity,
        ...dependencies
          .filter(({ kind }) => kind === 'knowledge_output')
          .map((dependency) => ({
            stepNo: dependency.stepNo,
            actorId: dependency.actorId,
            kind: dependency.kind,
            artifact: dependency.artifact,
          })),
      ],
      stepContract: {
        question_ids: output.question_ids,
        acceptance_criteria: output.acceptance_criteria,
        expected_outputs: output.expected_outputs,
        actor_type: output.actor_type,
        actor_id: output.actor_id,
      },
      skillLoader: loader,
      validator: new SchemaValidator(),
    });
    const context = prepared.context as {
      input: { public_evidence?: unknown };
      prior_outputs: Array<{
        actorId: string;
        artifact: SealedStepOutput['artifact'];
        evidenceIds?: string[];
      }>;
    };
    assert.deepEqual(context.input.public_evidence, publicEvidence, `${skillId} public evidence`);
    const upstream = context.prior_outputs.find(({ actorId }) => actorId === 'tavily-web-search');
    assert.ok(upstream, `${skillId} shared Tavily provenance`);
    assert.deepEqual(upstream.artifact, sharedOutput.artifact, `${skillId} Artifact identity`);
    assert.deepEqual(upstream.evidenceIds, [`E${shared.step_no}-1`], `${skillId} Evidence identity`);
  }
});
