import type { DeliverableType, EvidenceRequirement } from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  GuidanceRef,
  PlanCandidate,
  PlanProgress,
  ResearchTaskData,
  ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import {
  loadEvidencePolicy,
  type EvidencePolicyRequirement,
} from '../runtime/config-loader.ts';
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
import { RoutedPlanner } from './routed-planner.ts';

export interface ResearchPlanningInput {
  originalInput: string;
  directSkillId?: string;
  requirement?: ResearchTaskV2;
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

const TASK_UNDERSTANDING_PROMPT =
  `把用户需求结构化为 ResearchTask。\n` +
  `【task_type 按"用户想做什么"选最贴切的一个,不要默认竞品】:\n` +
  `- design_audit:对已有设计稿/页面/界面做走查·评估·审查(美学/视觉/注意力/品牌一致性/可用性)。信号:"走查/评估设计稿/看这个页面/UI 审查/视觉评估"。\n` +
  `- competitive_research:分析对标竞品、比较各家能力差异。信号:"竞品/对标/各家/横评/差异化"。\n` +
  `- user_research_planning:规划一次用户研究(找谁/用什么方法/问什么)。信号:"规划研究/研究方案/怎么调研/招募"。\n` +
  `- voc_diagnosis:分析用户反馈/评论/舆情。信号:"用户之声/差评/反馈/VOC"。\n` +
  `- a11y_audit:无障碍/可访问性审查。\n` +
  `【硬规则】用户明确说"不做竞品/对设计稿评估"时绝不选 competitive_research;有设计稿评估诉求优先 design_audit。\n` +
  `【缺失信息三级】可假设→assumptions(给默认值);需用户确认→confirmations;涉敏感/合规/授权→blocking_issues。\n`;

export class ResearchPlanningService {
  private readonly dependencies: Readonly<PlannerDeps>;
  private readonly directPlanner: PlanStrategy;
  private readonly routedPlanner: PlanStrategy;

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
      return this.planFromRequirement(input.requirement, input.originalInput, onProgress);
    }
    const { llm, validator } = this.dependencies;
    const emit = onProgress ?? (() => {});
    const direct: DirectInvoke | null = input.directSkillId !== undefined
      ? { skillName: input.directSkillId, rest: input.originalInput }
      : parseDirectInvoke(input.originalInput);
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
    }, emit);
  }

  async planFromRequirement(
    requirement: ResearchTaskV2,
    originalInput = requirement.research_goal,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<ResearchPlanningResult> {
    const task: ResearchTaskData = {
      task_type: requirement.task_type,
      business_domain: requirement.business_domain,
      research_goal: requirement.research_goal,
      assumptions: requirement.assumptions,
      confirmations: requirement.clarification_questions,
      blocking_issues: requirement.blocking_issues,
      sensitivity: requirement.sensitivity,
      pii_detected: requirement.pii_detected,
    };
    const emit = onProgress ?? (() => {});
    const provenance: PlanProvenance = {
      modelName: this.dependencies.llm.identity.requestedModel,
      modelVersion: 'research-task-v2',
      promptHash: hashPrompt(originalInput, requirement, 'research-task-v2'),
      traceId: `trace_requirement_${hashPrompt(originalInput, requirement).slice(-12)}`,
    };
    return this.planTask(task, parseDirectInvoke(originalInput), provenance, emit, requirement);
  }

  private async planTask(
    task: ResearchTaskData,
    direct: DirectInvoke | null,
    taskProvenance: PlanProvenance,
    emit: (event: PlanProgress) => void,
    structuredTask?: ResearchTaskV2,
  ): Promise<ResearchPlanningResult> {
    const strategy = direct ? this.directPlanner : this.routedPlanner;
    const artifacts = await strategy.plan({ task, direct, taskProvenance, emit });
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
