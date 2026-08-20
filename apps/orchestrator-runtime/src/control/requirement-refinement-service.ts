import type {
  ControlPlaneRepository,
  ControlTaskDetail,
} from '../../../../database/control-plane.ts';
import { ControlPlaneConflictError } from '../../../../database/control-plane.ts';
import type { ControlRequirementVersion } from '../../../../packages/api-contract/control-workflow.ts';
import type { PlanProgress, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import { canonicalizeExpectedDeliverables } from '../report/deliverable-registry.ts';
import type { CurrentResearchPlanningResult } from '../planners/research-planning-service.ts';
import type { LLMClient } from '../runtime/llm-client.ts';
import { hashPrompt } from '../runtime/llm-client.ts';
import { SchemaValidator } from '../schema/validator.ts';

export interface ConversationMessage {
  role: string;
  content: string;
}

export interface ConversationAdapter {
  create?(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
  requireOwned(input: { conversationId: string; ownerUserId: string }): Promise<{ id: string }>;
  listMessages(input: {
    conversationId: string;
    ownerUserId: string;
  }): Promise<ConversationMessage[]>;
  appendMessage(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    idempotencyKey?: string;
  }): Promise<void>;
}

export interface RequirementPlanner {
  plan(input: {
    originalInput: string;
    requirement: ResearchTaskV2;
  }, onProgress?: (event: PlanProgress) => void): Promise<unknown>;
}

export interface UnderstandInput {
  taskId: string;
  conversationId: string;
  ownerUserId: string;
  originalInput: string;
  expectedVersion?: number;
  expectedStateVersion?: number;
}

export interface ClarifyInput {
  taskId: string;
  conversationId: string;
  ownerUserId: string;
  answers: Record<string, unknown>;
  expectedVersion?: number;
  expectedStateVersion?: number;
}
export interface ClarificationRecoveryContext {
  mode: 'latest_finalized_requirement';
  activeRequirementVersionId: string;
}

export type RequirementRefinementResult =
  | { status: 'clarification_required'; taskId: string; requirement: ResearchTaskV2 }
  | {
    status: 'ready_to_plan';
    taskId: string;
    requirement: ResearchTaskV2;
    planningResult?: CurrentResearchPlanningResult;
    clarificationRecovery?: ClarificationRecoveryContext;
  };

interface RequirementRepository {
  createAndActivateRequirementVersion(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: ResearchTaskV2;
    modelCallId?: string | null;
  }): Promise<{ version: ControlRequirementVersion; task: ControlTaskDetail }>;
  getActiveRequirementVersion(taskId: string): Promise<ControlRequirementVersion | null>;
  getTaskDetail?(taskId: string): Promise<ControlTaskDetail | null>;
}

export interface RequirementRefinementDependencies {
  llm: LLMClient;
  validator: SchemaValidator;
  repository: RequirementRepository | ControlPlaneRepository;
  conversations: ConversationAdapter;
  planner?: RequirementPlanner;
  expectedActualModel?: string;
}

const REQUIREMENT_PROMPT = `把会话整理为 ResearchTaskV2。必须忠实保留用户目标、范围、成功标准和约束；竞品任务若明确列出对比维度，必须按原顺序写入 comparison_dimensions，未明确时不得自行补写；可安全推断的信息写入 assumptions；无法安全推断的信息写入 ambiguities 与 clarification_questions；敏感、授权或合规风险写入 blocking_issues。`;

const SCORING_MATRIX_MARKER = /(?:矩阵\s*采用[^。；;\n]{0,40}(?:分制|权重)|(?:评分|评价)(?:维度|矩阵)?\s*(?:及|与|和)?\s*权重|(?:评分|评价)?矩阵(?:维度)?\s*(?:及|与|和)?\s*权重|\b(?:scoring|evaluation)\s+(?:matrix|dimensions?)\b)/iu;
const PERCENTAGE_ITEM = /(?:^|[、,，;；\n])\s*([^、,，;；\n]*?\S)\s*(\d+(?:\.\d+)?)\s*[%％]\s*[)）]?/gu;

function cleanWeightedDimension(value: string): string {
  let dimension = value.trim();
  const labelSeparator = Math.max(dimension.lastIndexOf('：'), dimension.lastIndexOf(':'));
  if (labelSeparator >= 0) dimension = dimension.slice(labelSeparator + 1);
  return dimension
    .replace(/^(?:第?\s*\d+\s*[.)、）]\s*|[-*]\s*)/u, '')
    .replace(/[（(]\s*$/u, '')
    .replace(/\s*(?:权重|weight(?:ing)?)\s*(?:为|[:：=])?\s*$/iu, '')
    .replace(/\s*(?:为|[:：=])\s*$/u, '')
    .trim();
}

function explicitWeightedMatrixDimensions(requirement: ResearchTaskV2): string[] | undefined {
  const candidates = requirement.constraints.flatMap((constraint) => {
    if (constraint.source !== 'user' || !SCORING_MATRIX_MARKER.test(constraint.statement)) {
      return [];
    }
    const items = [...constraint.statement.matchAll(PERCENTAGE_ITEM)].map((match) => ({
      dimension: cleanWeightedDimension(match[1] ?? ''),
      percentage: Number(match[2]),
    }));
    const total = items.reduce((sum, item) => sum + item.percentage, 0);
    if (
      items.length < 2
      || items.some((item) => !item.dimension
        || !Number.isFinite(item.percentage)
        || item.percentage <= 0
        || item.percentage > 100)
      || new Set(items.map((item) => item.dimension)).size !== items.length
      || Math.abs(total - 100) > 0.001
    ) return [];
    return [items.map((item) => item.dimension)];
  });
  const unique = new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function normalizeExplicitWeightedMatrix(requirement: ResearchTaskV2): ResearchTaskV2 {
  const dimensions = explicitWeightedMatrixDimensions(requirement);
  return dimensions ? { ...requirement, comparison_dimensions: dimensions } : requirement;
}

function hasBlockingAmbiguity(requirement: ResearchTaskV2): boolean {
  return requirement.ambiguities.some((ambiguity) => ambiguity.blocking);
}


function needsClarification(requirement: ResearchTaskV2): boolean {
  return hasBlockingAmbiguity(requirement);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function sameStoredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function hasNoClarificationChanges(
  answers: Record<string, unknown>,
  requirement: ResearchTaskV2,
): boolean {
  return Object.entries(answers).every(([key, value]) =>
    key === 'assumption_edits'
    && value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>).every(([assumptionKey, editedValue]) =>
      requirement.assumptions.some((assumption) =>
        assumption.editable
        && assumption.key === assumptionKey
        && sameStoredValue(assumption.value, editedValue)))
  );
}

export class RequirementRefinementService {
  private readonly dependencies: RequirementRefinementDependencies;

  constructor(dependencies: RequirementRefinementDependencies) {
    this.dependencies = dependencies;
  }
  private async appendMessage(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    idempotencyKey?: string;
  }): Promise<void> {
    const append = this.dependencies.conversations.appendMessage;
    if (!append) throw new Error('requirement refinement requires conversation append support');
    await append(input);
  }

  private async listMessages(input: {
    conversationId: string;
    ownerUserId: string;
  }): Promise<ConversationMessage[]> {
    const list = this.dependencies.conversations.listMessages;
    if (!list) throw new Error('requirement refinement requires conversation history support');
    return list(input);
  }

  async understand(
    input: UnderstandInput,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<RequirementRefinementResult> {
    await this.dependencies.conversations.requireOwned({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    return this.refine({
      taskId: input.taskId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      originalInput: input.originalInput,
      clarification: null,
      expectedVersion: input.expectedVersion,
      expectedStateVersion: input.expectedStateVersion,
    }, onProgress);
  }

  async clarify(
    input: ClarifyInput,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<RequirementRefinementResult> {
    await this.dependencies.conversations.requireOwned({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    const task = await this.dependencies.repository.getTaskDetail?.(input.taskId);
    if (!task) throw new Error(`task ${input.taskId} does not exist`);
    const active = await this.dependencies.repository.getActiveRequirementVersion(input.taskId);
    if (!active) throw new Error(`task ${input.taskId} has no active requirement version to clarify`);
    const expectedVersion = input.expectedVersion ?? input.expectedStateVersion;
    const matchesActiveRequirement = task.state === 'awaiting_clarification'
      && task.activeRequirementVersionId === active.id
      && active.taskId === task.id
      && sameStoredValue(active.structuredTask, task.structuredTask);
    const unchangedClarification = hasNoClarificationChanges(
      input.answers,
      active.structuredTask,
    );
    if (
      expectedVersion !== undefined
      && task.stateVersion === expectedVersion
      && matchesActiveRequirement
      && !needsClarification(active.structuredTask)
      && unchangedClarification
    ) {
      return this.finishRefinement({
        taskId: input.taskId,
        conversationId: input.conversationId,
        originalInput: task.originalInput,
        requirement: active.structuredTask,
        requirementVersionId: active.id,
        clarificationRecovery: {
          mode: 'latest_finalized_requirement',
          activeRequirementVersionId: active.id,
        },
      }, onProgress);
    }
    if (expectedVersion !== undefined && task.stateVersion !== expectedVersion) {
      const resumesActivatedRequirement = matchesActiveRequirement
        && task.stateVersion === expectedVersion + 1
        && sameStoredValue(active.clarification, input.answers);
      if (!resumesActivatedRequirement) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} has no matching activated clarification at version ${expectedVersion + 1}`,
        );
      }
      return this.finishRefinement({
        taskId: input.taskId,
        conversationId: input.conversationId,
        originalInput: task.originalInput,
        requirement: active.structuredTask,
        requirementVersionId: active.id,
      }, onProgress);
    }
    return this.refine({
      taskId: input.taskId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      originalInput: task.originalInput,
      clarification: input.answers,
      expectedVersion: input.expectedVersion,
      expectedStateVersion: input.expectedStateVersion,
    }, onProgress);
  }

  private async finishRefinement(input: {
    taskId: string;
    conversationId: string;
    originalInput: string;
    requirement: ResearchTaskV2;
    requirementVersionId: string;
    clarificationRecovery?: ClarificationRecoveryContext;
  }, onProgress?: (event: PlanProgress) => void): Promise<RequirementRefinementResult> {
    const status = needsClarification(input.requirement)
      ? 'clarification_required'
      : 'ready_to_plan';
    await this.appendMessage({
      conversationId: input.conversationId,
      role: 'assistant',
      content: JSON.stringify({ status, requirement: input.requirement }),
      idempotencyKey: `requirement:${input.requirementVersionId}:assistant`,
    });
    const planningResult = status === 'ready_to_plan' && this.dependencies.planner
      ? await this.dependencies.planner.plan({
          originalInput: input.originalInput,
          requirement: input.requirement,
        }, onProgress) as CurrentResearchPlanningResult
      : undefined;
    if (status === 'ready_to_plan') {
      return {
        status,
        taskId: input.taskId,
        requirement: input.requirement,
        ...(planningResult ? { planningResult } : {}),
        ...(input.clarificationRecovery
          ? { clarificationRecovery: input.clarificationRecovery }
          : {}),
      };
    }
    return { status, taskId: input.taskId, requirement: input.requirement };
  }

  private async refine(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    clarification: unknown;
    expectedVersion?: number;
    expectedStateVersion?: number;
  }, onProgress?: (event: PlanProgress) => void): Promise<RequirementRefinementResult> {
    const messages = await this.listMessages({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    const context = {
      messages,
      original_input: input.originalInput,
      clarification: input.clarification,
    };
    const generated = await this.dependencies.llm.generateStructured<ResearchTaskV2>({
      prompt: `${REQUIREMENT_PROMPT}\n用户当前输入:${input.originalInput}`,
      schema: {},
      schemaName: 'research-task-v2',
      context,
      receipt: {
        stage: input.clarification === null ? 'requirement_understanding' : 'requirement_clarification',
        contextManifestHash: hashPrompt('', context),
        expectedModel: this.dependencies.expectedActualModel
          ?? this.dependencies.llm.identity.requestedModel,
      },
    });
    this.dependencies.validator.validateOrThrow('research-task-v2', generated.data);
    const requirement = normalizeExplicitWeightedMatrix(
      canonicalizeExpectedDeliverables(generated.data),
    );
    const task = await this.dependencies.repository.getTaskDetail?.(input.taskId);
    const expectedVersion = input.expectedVersion
      ?? input.expectedStateVersion
      ?? task?.stateVersion
      ?? 0;
    const activated = await this.dependencies.repository.createAndActivateRequirementVersion({
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      expectedVersion,
      rawInputHash: hashPrompt(input.originalInput, context, 'research-task-v2'),
      clarification: input.clarification,
      structuredTask: requirement,
      modelCallId: null,
    });
    return this.finishRefinement({
      taskId: input.taskId,
      conversationId: input.conversationId,
      originalInput: input.originalInput,
      requirement,
      requirementVersionId: activated.version.id,
    }, onProgress);
  }
}
