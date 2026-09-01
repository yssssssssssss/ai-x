import type { OrchestrationModeV1 } from '../../../../packages/api-contract/control-workflow.ts';
import type {
  DeliverableType,
  EvidenceRequirement,
  ProblemGraph,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  CandidateProfile,
  CapabilityDemandGraphV1,
  GuidanceRef,
  PlanCandidate,
  PlanProgress,
  PlanningProvenance,
  ResearchTaskData,
  ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import {
  loadEvidencePolicy,
  type EvidencePolicyRequirement,
} from '../runtime/config-loader.ts';
import {
  canonicalizeExpectedDeliverables,
  resolveDeliverable,
} from '../report/deliverable-registry.ts';
import { parseDirectInvoke } from '../runtime/direct-invoke.ts';
import { hashPrompt } from '../runtime/llm-client.ts';
import { DirectPlanner } from './direct-planner.ts';
import type {
  DirectInvoke,
  DecisionStateRec,
  PlannerDeps,
  PlanProvenance,
  PlanStrategy,
} from './plan-strategy.ts';
import {
  RoutedPlanner,
  type CurrentPlanningGuidanceClarification,
} from './routed-planner.ts';
import type { ScenarioId } from './planning-guidance.ts';
import type { CapabilityResolution } from './capability-resolver.ts';
import type { SkillPortfolioDecision } from './capability-portfolio-resolver.ts';
import type { ProblemGraphProvenance } from './problem-graph-planner.ts';
import type {
  CurrentPlanCandidateProposal,
  FrozenDeliverableSelection,
} from './plan-compiler.ts';

export class OrchestrationModePlanningError extends Error {
  readonly name = 'OrchestrationModePlanningError';

  constructor(readonly kind: 'missing' | 'unavailable' | 'direct_skill_conflict') {
    super(kind === 'missing'
      ? 'orchestration mode is required for current planning'
      : kind === 'unavailable'
        ? 'multi_skill mode is not available'
        : 'multi_skill mode cannot be combined with a direct Skill invocation');
  }
}

export interface ResearchPlanningInput {
  originalInput: string;
  directSkillId?: string;
  orchestrationMode?: OrchestrationModeV1;
  requirement?: ResearchTaskV2;
  selectedScenarioId?: ScenarioId;
  requireExplicitScenarioSelection?: boolean;
  requiredProfileId?: CandidateProfile;
}

export interface ResearchPlanningResult {
  task: ResearchTaskData;
  structuredTask?: ResearchTaskV2;
  activatedNodes: string[];
  decisionStates: DecisionStateRec[];
  candidates: PlanCandidate[];
  guidanceSources: GuidanceRef[];
  provenance: PlanProvenance;
}

export interface CurrentResearchPlanningResult extends Omit<ResearchPlanningResult, 'candidates' | 'structuredTask'> {
  orchestrationMode?: OrchestrationModeV1;
  structuredTask: ResearchTaskV2;
  candidates: CurrentPlanCandidateProposal[];
  problemGraph: ProblemGraph;
  capabilityResolution: CapabilityResolution;
  capabilityDemandGraph?: CapabilityDemandGraphV1;
  portfolios?: Partial<Record<string, SkillPortfolioDecision>>;
  problemGraphProvenance: ProblemGraphProvenance;
  planningProvenance: PlanningProvenance;
}

export type CurrentResearchPlanningOutcome =
  | CurrentResearchPlanningResult
  | CurrentPlanningGuidanceClarification;

export interface CurrentResearchPlanningOptions {
  orchestrationMode: OrchestrationModeV1;
  selectedScenarioId?: ScenarioId;
  requireExplicitScenarioSelection?: boolean;
  requiredProfileId?: CandidateProfile;
}

export function isPlanningGuidanceClarification(
  value: unknown,
): value is CurrentPlanningGuidanceClarification {
  return Boolean(
    value
    && typeof value === 'object'
    && 'kind' in value
    && value.kind === 'planning_guidance_clarification',
  );
}

const TASK_UNDERSTANDING_PROMPT =
  `把用户需求结构化为 ResearchTask。\n` +
  `【task_type 按"用户想做什么"选最贴切的一个,不要默认竞品】:\n` +
  `- design_audit:对已有设计稿/页面/界面做走查·评估·审查(美学/视觉/注意力/品牌一致性/可用性)。信号:"走查/评估设计稿/看这个页面/UI 审查/视觉评估"。\n` +
  `- competitive_research:分析对标竞品、比较各家能力差异。信号:"竞品/对标/各家/横评/差异化"。\n` +
  `- user_research_planning:规划一次用户研究(找谁/用什么方法/问什么)。信号:"规划研究/研究方案/怎么调研/招募"。\n` +
  `- research_synthesis:基于当前证据直接回答研究问题并给出策略、优先级和行动。信号:"直接结论/完成研究/策略地图/心智模型/设计原则/机会点"。\n` +
  `- voc_diagnosis:分析用户反馈/评论/舆情。信号:"用户之声/差评/反馈/VOC"。\n` +
  `- a11y_audit:无障碍/可访问性审查。\n` +
  `【硬规则】用户明确说"不做竞品/对设计稿评估"时绝不选 competitive_research;有设计稿评估诉求优先 design_audit。\n` +
  `【缺失信息三级】可假设→assumptions(给默认值);需用户确认→confirmations;涉敏感/合规/授权→blocking_issues。\n`;

export function resolveExplicitDirectInvoke(originalInput: string): DirectInvoke | null {
  return parseDirectInvoke(originalInput);
}

export class ResearchPlanningService {
  private readonly dependencies: Readonly<PlannerDeps>;
  private readonly directPlanner: PlanStrategy;
  private readonly routedPlanner: RoutedPlanner;

  constructor(dependencies: PlannerDeps) {
    this.dependencies = dependencies;
    this.directPlanner = new DirectPlanner(this.dependencies);
    this.routedPlanner = new RoutedPlanner(this.dependencies);
  }

  async plan(
    input: ResearchPlanningInput,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<ResearchPlanningResult> {
    if (input.requirement) {
      return this.planFromRequirement(
        input.requirement,
        input.originalInput,
        onProgress,
        input.orchestrationMode ?? 'single_skill',
      );
    }
    const { llm, validator } = this.dependencies;
    const emit = onProgress ?? (() => {});
    const direct: DirectInvoke | null = input.directSkillId !== undefined
      ? { skillName: input.directSkillId, rest: input.originalInput }
      : parseDirectInvoke(input.originalInput);
    const orchestrationMode = input.orchestrationMode ?? 'single_skill';
    if (orchestrationMode === 'multi_skill' && direct) {
      throw new OrchestrationModePlanningError('direct_skill_conflict');
    }
    if (orchestrationMode === 'multi_skill' && this.dependencies.multiSkillPortfolioMode !== 'active') {
      throw new OrchestrationModePlanningError('unavailable');
    }
    const understandInput = direct
      ? (direct.rest || direct.skillName)
      : input.originalInput;

    emit({ phase: 'understand', status: 'start', label: '理解任务需求' });
    const taskGen = await llm.generateStructured<ResearchTaskData>({
      prompt: `${TASK_UNDERSTANDING_PROMPT}用户需求:${understandInput}`,
      schema: {},
      schemaName: 'research-task',
      context: { input: understandInput },
      receipt: {
        stage: 'task_understanding',
        contextManifestHash: hashPrompt('', { input: understandInput }),
        expectedModel: this.dependencies.expectedActualModel ?? llm.identity.requestedModel,
      },
    });
    validator.validateOrThrow('research-task', taskGen.data);
    const task = taskGen.data;
    emit({
      phase: 'understand',
      status: 'done',
      label: '理解任务需求',
      detail: `${task.task_type} · ${task.business_domain}`,
    });
    return this.planTask(task, direct, {
      modelName: taskGen.modelName,
      modelVersion: taskGen.modelVersion,
      promptHash: taskGen.promptHash,
      traceId: taskGen.traceId,
    }, emit, undefined, orchestrationMode);
  }

  async planFromRequirement(
    requirement: ResearchTaskV2,
    originalInput = requirement.research_goal,
    onProgress?: (event: PlanProgress) => void,
    orchestrationMode: OrchestrationModeV1 = 'single_skill',
  ): Promise<ResearchPlanningResult> {
    const canonicalRequirement = canonicalizeExpectedDeliverables(requirement);
    const task: ResearchTaskData = {
      task_type: canonicalRequirement.task_type,
      business_domain: canonicalRequirement.business_domain,
      research_goal: canonicalRequirement.research_goal,
      assumptions: canonicalRequirement.assumptions,
      confirmations: canonicalRequirement.clarification_questions,
      blocking_issues: canonicalRequirement.blocking_issues,
      sensitivity: canonicalRequirement.sensitivity,
      pii_detected: canonicalRequirement.pii_detected,
    };
    const emit = onProgress ?? (() => {});
    const provenance: PlanProvenance = {
      modelName: this.dependencies.llm.identity.requestedModel,
      modelVersion: 'research-task-v2',
      promptHash: hashPrompt(originalInput, canonicalRequirement, 'research-task-v2'),
      traceId: `trace_requirement_${hashPrompt(originalInput, canonicalRequirement).slice(-12)}`,
    };
    return this.planTask(
      task,
      parseDirectInvoke(originalInput),
      provenance,
      emit,
      canonicalRequirement,
      orchestrationMode,
    );
  }

  async planCurrentFromRequirement(
    requirement: ResearchTaskV2,
    originalInput = requirement.research_goal,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<CurrentResearchPlanningResult> {
    const result = await this.planCurrentFromRequirementOutcome(
      requirement,
      originalInput,
      onProgress,
      { orchestrationMode: 'single_skill' },
    );
    if (isPlanningGuidanceClarification(result)) {
      throw new Error(`Planning Guidance requires clarification: ${result.planningGuidance.reasonCode}`);
    }
    return result;
  }

  async planCurrentFromRequirementOutcome(
    requirement: ResearchTaskV2,
    originalInput = requirement.research_goal,
    onProgress: ((event: PlanProgress) => void) | undefined,
    options: CurrentResearchPlanningOptions,
  ): Promise<CurrentResearchPlanningOutcome> {
    const canonicalRequirement = canonicalizeExpectedDeliverables(requirement);
    const task: ResearchTaskData = {
      task_type: canonicalRequirement.task_type,
      business_domain: canonicalRequirement.business_domain,
      research_goal: canonicalRequirement.research_goal,
      assumptions: canonicalRequirement.assumptions,
      confirmations: canonicalRequirement.clarification_questions,
      blocking_issues: canonicalRequirement.blocking_issues,
      sensitivity: canonicalRequirement.sensitivity,
      pii_detected: canonicalRequirement.pii_detected,
    };
    const emit = onProgress ?? (() => {});
    const orchestrationMode = options.orchestrationMode;
    if (orchestrationMode !== 'single_skill' && orchestrationMode !== 'multi_skill') {
      throw new OrchestrationModePlanningError('missing');
    }
    const direct = resolveExplicitDirectInvoke(originalInput);
    if (orchestrationMode === 'multi_skill' && direct) {
      throw new OrchestrationModePlanningError('direct_skill_conflict');
    }
    if (orchestrationMode === 'multi_skill' && this.dependencies.multiSkillPortfolioMode !== 'active') {
      throw new OrchestrationModePlanningError('unavailable');
    }
    const taskProvenance: PlanProvenance = {
      modelName: this.dependencies.llm.identity.requestedModel,
      modelVersion: 'research-task-v2',
      promptHash: hashPrompt(originalInput, canonicalRequirement, 'research-task-v2'),
      traceId: `trace_requirement_${hashPrompt(originalInput, canonicalRequirement).slice(-12)}`,
    };
    const deliverableSelection = resolvePlanningDeliverableSelection(canonicalRequirement);
    const artifacts = await this.routedPlanner.planCurrent({
      task,
      direct,
      originalInput,
      requirement: canonicalRequirement,
      orchestrationMode,
      guidanceRequirement: requirement,
      ...(options.selectedScenarioId ? { selectedScenarioId: options.selectedScenarioId } : {}),
      ...(options.requireExplicitScenarioSelection
        ? { requireExplicitScenarioSelection: true }
        : {}),
      ...(options.requiredProfileId ? { requiredProfileId: options.requiredProfileId } : {}),
      taskProvenance,
      emit,
    }, deliverableSelection.evidenceRequirements);
    if (isPlanningGuidanceClarification(artifacts)) return artifacts;
    return {
      orchestrationMode,
      task,
      structuredTask: canonicalRequirement,
      activatedNodes: artifacts.activated.map((node) => node.key),
      decisionStates: artifacts.decisionStates,
      candidates: artifacts.candidates,
      guidanceSources: artifacts.guidanceSources,
      provenance: artifacts.planProvenance,
      problemGraph: artifacts.problemGraph,
      problemGraphProvenance: artifacts.problemGraphProvenance,
      capabilityResolution: artifacts.capabilityResolution,
      ...(artifacts.capabilityDemandGraph
        ? { capabilityDemandGraph: artifacts.capabilityDemandGraph }
        : {}),
      ...(artifacts.portfolios ? { portfolios: artifacts.portfolios } : {}),
      planningProvenance: artifacts.planningProvenance,
    };
  }

  private async planTask(
    task: ResearchTaskData,
    direct: DirectInvoke | null,
    taskProvenance: PlanProvenance,
    emit: (event: PlanProgress) => void,
    structuredTask: ResearchTaskV2 | undefined,
    orchestrationMode: OrchestrationModeV1,
  ): Promise<ResearchPlanningResult> {
    const strategy = direct ? this.directPlanner : this.routedPlanner;
    const artifacts = await strategy.plan({
      task,
      direct,
      orchestrationMode,
      taskProvenance,
      emit,
      ...(structuredTask ? { requirement: structuredTask } : {}),
    });
    return {
      task,
      ...(structuredTask ? { structuredTask } : {}),
      activatedNodes: artifacts.activated.map((node) => node.key),
      decisionStates: artifacts.decisionStates,
      candidates: artifacts.candidates,
      guidanceSources: artifacts.guidanceSources,
      provenance: artifacts.planProvenance,
    };
  }
}

export function resolveEvidenceRequirements(
  taskType: string,
  deliverableType: DeliverableType,
): EvidenceRequirement[] {
  const policy = loadEvidencePolicy().policies.find(
    (entry) => entry.task_type === taskType && entry.deliverable_type === deliverableType,
  );
  if (!policy) {
    throw new Error(
      `Evidence Policy Error: no policy for task_type=${taskType}, deliverable_type=${deliverableType}`,
    );
  }

  return policy.requirements.map((requirement: EvidencePolicyRequirement) => ({
    id: requirement.id,
    acceptedClasses: [...requirement.accepted_classes],
    minimumCount: requirement.minimum_count,
    required: requirement.required,
  }));
}

export function resolvePlanningDeliverableSelection(
  task: Pick<ResearchTaskV2, 'task_type' | 'expected_deliverables'>,
): FrozenDeliverableSelection {
  const deliverable = resolveDeliverable(task.task_type, task.expected_deliverables);
  return {
    deliverableId: deliverable.id,
    evidenceRequirements: resolveEvidenceRequirements(task.task_type, deliverable.id),
  };
}
