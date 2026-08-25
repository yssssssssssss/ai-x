import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CapabilityDemandGraphV1,
  ContributionType,
  ResearchTaskV2,
} from '../packages/api-contract/plan.ts';
import type {
  CurrentPlanStep,
  ProblemGraph,
} from '../packages/api-contract/research-deliverable.ts';
import { CapabilityPortfolioResolver } from '../apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts';
import { PlanCompiler } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import type { CapabilityResolution } from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import { resolveDeliverableCompositionPolicy } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import { SkillLoader, type CapabilitySkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

const CASES: Array<{
  taskType: ResearchTaskV2['task_type'];
  deliverableId: string;
  simpleType: ContributionType;
  complexType: ContributionType;
  contributorId: string;
}> = [
  { taskType: 'user_research_planning', deliverableId: 'research_plan', simpleType: 'research_method', complexType: 'metrics', contributorId: 'build-experience-metrics' },
  { taskType: 'research_synthesis', deliverableId: 'research_strategy_report', simpleType: 'qualitative_insight', complexType: 'persona', contributorId: 'generate-persona' },
  { taskType: 'competitive_research', deliverableId: 'competitive_analysis_report', simpleType: 'competitive_analysis', complexType: 'market_landscape', contributorId: 'competitive-web-research' },
  { taskType: 'design_audit', deliverableId: 'design_audit_report', simpleType: 'design_audit', complexType: 'accessibility', contributorId: 'accessibility-review' },
  { taskType: 'a11y_audit', deliverableId: 'accessibility_audit_report', simpleType: 'accessibility', complexType: 'design_audit', contributorId: 'run-heuristic-evaluation' },
  { taskType: 'voc_diagnosis', deliverableId: 'voc_diagnosis_report', simpleType: 'voc', complexType: 'satisfaction', contributorId: 'analyze-satisfaction' },
];

function task(taskType: ResearchTaskV2['task_type'], deliverableId: string): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: taskType,
    outcome_mode: taskType === 'user_research_planning' ? 'plan' : 'answer',
    requested_artifacts: [],
    business_domain: 'test-domain',
    research_goal: '完成受控研究任务',
    target_audience: ['team'],
    scope: ['fixture'],
    constraints: [],
    success_criteria: [{ id: 'criterion-1', statement: '完成覆盖' }],
    expected_deliverables: [deliverableId],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
}

function graph(types: ContributionType[]): { problemGraph: ProblemGraph; demandGraph: CapabilityDemandGraphV1 } {
  const questions = types.map((type, index) => ({
    id: `question-${index + 1}`,
    statement: `${type} question`,
    rationale: 'fixture',
    priority: 'required' as const,
    success_criterion_ids: ['criterion-1'],
    evidence_requirements: [{ id: 'fixture-evidence', acceptedClasses: ['public_source' as const], minimumCount: 1, required: true }],
    acceptance_criteria: ['covered'],
    depends_on: [],
  }));
  return {
    problemGraph: { version: 'problem-graph-v1', questions },
    demandGraph: {
      version: 'capability-demand-graph-v1',
      demands: types.map((type, index) => ({
        id: `demand-${index + 1}`,
        type,
        questionIds: [`question-${index + 1}`],
        requestedArtifactTypes: [],
        requiredEvidenceClasses: ['public_source'],
        requiredInputRoles: ['research_goal'],
        priority: 'required',
      })),
    },
  };
}

function matrixSkill(
  skill: Extract<CapabilitySkillRegistryEntry, { status: 'active' }>,
): Extract<CapabilitySkillRegistryEntry, { status: 'active' }> {
  return {
    ...structuredClone(skill),
    required_tools: [],
    optional_tools: [],
    composition: skill.composition
      ? { ...structuredClone(skill.composition), shareable_prerequisites: [] }
      : undefined,
  } as Extract<CapabilitySkillRegistryEntry, { status: 'active' }>;
}

class MatrixSkillLoader extends SkillLoader {
  constructor(private readonly skills: CapabilitySkillRegistryEntry[]) { super(); }
  override getSkill(id: string): ReturnType<SkillLoader['getSkill']> {
    return (this.skills.find((skill) => skill.id === id && skill.status === 'active') ?? null) as ReturnType<SkillLoader['getSkill']>;
  }
  override loadSkillExecution(): null { return null; }
}

function candidateSteps(portfolio: ReturnType<CapabilityPortfolioResolver['resolve']>): CurrentPlanStep[] {
  const contributors = portfolio.invocations.filter(({ role }) => role === 'contributor');
  return portfolio.invocations.map((invocation, index) => ({
    step_no: index + 1,
    step_name: `${invocation.role}:${invocation.skillId}`,
    actor_type: 'skill',
    actor_id: invocation.skillId,
    question_ids: [...invocation.questionIds],
    depends_on: invocation.role === 'synthesizer'
      ? contributors.map((_contributor, contributorIndex) => contributorIndex + 1)
      : [],
    input: { research_goal: '完成受控研究任务' },
    input_bindings: [],
    expected_outputs: [{ pointer: '/payload', description: `${invocation.skillId} output` }],
    acceptance_criteria: ['contract valid'],
    requires_approval: false,
    fallback_actor_ids: [],
  }));
}

function resolution(skills: CapabilitySkillRegistryEntry[]): CapabilityResolution {
  return {
    eligible: skills.map((skill) => ({
      skill: skill as Extract<CapabilitySkillRegistryEntry, { status: 'active' }>,
      required_approvals: [],
      reasons: [{ code: 'eligible', message: 'fixture' }],
      pending_inputs: [],
      optional_tool_decisions: [],
    })),
    rejected: [],
  };
}

test('all active Task Types support simple and complex Portfolio fixtures', () => {
  const skills = new SkillLoader().listCapabilitySkills();
  for (const item of CASES) {
    const policy = resolveDeliverableCompositionPolicy(item.deliverableId);
    assert.equal(policy.mode, 'portfolio', item.taskType);
    if (policy.mode !== 'portfolio') continue;
    const rawSynthesizer = skills.find(({ id }) => id === policy.synthesizer_skill_id);
    const rawContributor = skills.find(({ id }) => id === item.contributorId);
    assert.ok(rawSynthesizer?.status === 'active', `${item.taskType} synthesizer`);
    assert.ok(rawContributor?.status === 'active', `${item.taskType} contributor`);
    const synthesizer = matrixSkill(rawSynthesizer);
    const contributor = matrixSkill(rawContributor);
    const currentTask = task(item.taskType, item.deliverableId);

    const simpleGraph = graph([item.simpleType]);
    const simple = new CapabilityPortfolioResolver().resolve({
      task: currentTask,
      problemGraph: simpleGraph.problemGraph,
      capabilityDemandGraph: simpleGraph.demandGraph,
      deliverableId: item.deliverableId,
      compositionPolicy: policy,
      capabilityResolution: resolution([synthesizer]),
      profile: { id: 'speed', max_steps: 4 },
      availableInputRoles: ['research_goal', 'user_materials', 'analytics_dataset'],
    });
    assert.deepEqual(simple.invocations.map(({ role }) => role), ['synthesizer'], item.taskType);

    const complexGraph = graph([item.simpleType, item.complexType]);
    const complex = new CapabilityPortfolioResolver().resolve({
      task: currentTask,
      problemGraph: complexGraph.problemGraph,
      capabilityDemandGraph: complexGraph.demandGraph,
      deliverableId: item.deliverableId,
      compositionPolicy: policy,
      capabilityResolution: resolution([contributor, synthesizer]),
      profile: { id: 'depth', max_steps: 8 },
      availableInputRoles: ['research_goal', 'user_materials', 'analytics_dataset'],
    });
    assert.equal(complex.invocations.filter(({ role }) => role === 'contributor').length, 1, item.taskType);
    assert.equal(complex.invocations.filter(({ role }) => role === 'synthesizer').length, 1, item.taskType);
    assert.equal(complex.demandCoverage.length, 2, item.taskType);

    for (const [label, portfolio, fixture] of [
      ['simple', simple, simpleGraph],
      ['complex', complex, complexGraph],
    ] as const) {
      const capabilityResolution = resolution([contributor, synthesizer]);
      const compiled = new PlanCompiler().compilePortfolio({
        candidate: {
          id: portfolio.estimatedBudget.profileId,
          title: `${item.taskType} ${label}`,
          rationale: 'fixture compilation',
          tradeoffs: 'fixture',
          steps: candidateSteps(portfolio),
          assumptions: [],
          activated_nodes: [],
        },
        task: currentTask,
        deliverable_selection: {
          deliverableId: item.deliverableId,
          evidenceRequirements: [{
            id: 'fixture-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
          }],
        },
        problem_graph: fixture.problemGraph,
        problem_graph_provenance: {
          receiptId: '11111111-1111-4111-8111-111111111111', modelName: 'fixture',
          modelVersion: 'v1', promptHash: 'sha256:fixture', traceId: 'trace-fixture',
        },
        capability_resolution: capabilityResolution,
        evidence_requirements: [{
          id: 'fixture-evidence', acceptedClasses: ['public_source'], minimumCount: 1, required: true,
        }],
        capability_demand_graph: fixture.demandGraph,
        portfolio,
        activated_nodes: [],
        skillLoader: new MatrixSkillLoader([contributor, synthesizer]),
      });
      assert.equal(compiled.plan.execution_contract_version, 'current-execution-plan-v3', `${item.taskType}:${label}`);
      assert.equal(compiled.plan.contribution_requirements.length, fixture.demandGraph.demands.length, `${item.taskType}:${label}`);
    }
  }
});
