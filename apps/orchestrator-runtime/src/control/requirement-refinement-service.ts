import type {
  ControlPlaneRepository,
  ControlTaskDetail,
} from '../../../../database/control-plane.ts';
import { ControlPlaneConflictError } from '../../../../database/control-plane.ts';
import type {
  ControlRequirementVersion,
  PlanningGuidanceClarification,
} from '../../../../packages/api-contract/control-workflow.ts';
import type { PlanProgress, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import { canonicalizeExpectedDeliverables } from '../report/deliverable-registry.ts';
import {
  isPlanningGuidanceClarification,
  type CurrentResearchPlanningOutcome,
  type CurrentResearchPlanningResult,
} from '../planners/research-planning-service.ts';
import type {
  ScenarioId,
} from '../planners/planning-guidance.ts';
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
    selectedScenarioId?: ScenarioId;
  }, onProgress?: (event: PlanProgress) => void): Promise<CurrentResearchPlanningOutcome | void>;
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
  selectedScenarioId?: string;
  expectedVersion?: number;
  expectedStateVersion?: number;
}
export interface ClarificationRecoveryContext {
  mode: 'latest_finalized_requirement';
  activeRequirementVersionId: string;
}

export type RequirementRefinementResult =
  | {
    status: 'clarification_required';
    taskId: string;
    requirement: ResearchTaskV2;
    planningGuidance?: PlanningGuidanceClarification;
    activatedNodes?: string[];
  }
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

export class InvalidScenarioSelectionError extends Error {
  readonly code = 'invalid_scenario_selection';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidScenarioSelectionError';
  }
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

export function planningGuidanceFromStored(value: unknown): PlanningGuidanceClarification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const guidance = (value as { planningGuidance?: unknown }).planningGuidance;
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) return null;
  const candidate = guidance as Partial<PlanningGuidanceClarification>;
  if (candidate.reasonCode !== 'scenario_selection_required' || !Array.isArray(candidate.options)) return null;
  const options = candidate.options.flatMap((option) => (
    option
      && typeof option === 'object'
      && !Array.isArray(option)
      && typeof option.id === 'string'
      && option.id.trim().length > 0
      && typeof option.label === 'string'
      && option.label.trim().length > 0
      ? [{ id: option.id, label: option.label }]
      : []
  ));
  if (options.length === 0 || options.length !== candidate.options.length) return null;
  if (new Set(options.map(({ id }) => id)).size !== options.length) return null;
  return { reasonCode: 'scenario_selection_required', options };
}

function selectedScenarioFromStored(value: unknown): ScenarioId | null {
  const guidance = planningGuidanceFromStored(value);
  if (!guidance || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const selectedScenarioId = (value as { selectedScenarioId?: unknown }).selectedScenarioId;
  return typeof selectedScenarioId === 'string'
    && guidance.options.some(({ id }) => id === selectedScenarioId)
    ? selectedScenarioId as ScenarioId
    : null;
}

function withoutScenarioSelection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { selectedScenarioId: _selectedScenarioId, ...rest } = value as Record<string, unknown>;
  return rest;
}

function storedScenarioSelection(
  planningGuidance: PlanningGuidanceClarification,
  selectedScenarioId: ScenarioId,
  answers?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    planningGuidance,
    selectedScenarioId,
    ...(answers ? { answers } : {}),
  };
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
    const activePlanningGuidance = planningGuidanceFromStored(active.clarification);
    if (activePlanningGuidance) {
      if (!input.selectedScenarioId) {
        throw new InvalidScenarioSelectionError('请选择一个研究方向');
      }
      const selectedScenario = activePlanningGuidance.options.find(
        ({ id }) => id === input.selectedScenarioId,
      );
      if (!selectedScenario) {
        throw new InvalidScenarioSelectionError(
          `研究方向 ${input.selectedScenarioId} 不属于当前任务的可选范围`,
        );
      }
      const selectedScenarioId = input.selectedScenarioId as ScenarioId;
      onProgress?.({
        phase: 'understand',
        status: 'done',
        label: '确认研究方向',
        detail: selectedScenario.label,
      });
      const unchanged = hasNoClarificationChanges(input.answers, active.structuredTask);
      const activeSelectedScenarioId = selectedScenarioFromStored(active.clarification);
      const storedSelection = storedScenarioSelection(
        activePlanningGuidance,
        selectedScenarioId,
        input.answers,
      );
      if (
        expectedVersion !== undefined
        && task.stateVersion === expectedVersion
        && matchesActiveRequirement
        && activeSelectedScenarioId === selectedScenarioId
        && unchanged
      ) {
        return this.finishRefinement({
          taskId: input.taskId,
          conversationId: input.conversationId,
          ownerUserId: input.ownerUserId,
          originalInput: task.originalInput,
          requirement: active.structuredTask,
          requirementVersionId: active.id,
          stateVersion: task.stateVersion,
          rawInputHash: active.rawInputHash,
          selectedScenarioId,
        }, onProgress);
      }
      if (expectedVersion !== undefined && task.stateVersion !== expectedVersion) {
        const resumesActivatedSelection = matchesActiveRequirement
          && task.stateVersion === expectedVersion + 1
          && (
            sameStoredValue(active.clarification, storedSelection)
            || (
              unchanged
              && sameStoredValue(
                active.clarification,
                storedScenarioSelection(activePlanningGuidance, selectedScenarioId),
              )
            )
          );
        if (!resumesActivatedSelection) {
          throw new ControlPlaneConflictError(
            `task ${input.taskId} has no matching activated Scenario selection at version ${expectedVersion + 1}`,
          );
        }
        return this.finishRefinement({
          taskId: input.taskId,
          conversationId: input.conversationId,
          ownerUserId: input.ownerUserId,
          originalInput: task.originalInput,
          requirement: active.structuredTask,
          requirementVersionId: active.id,
          stateVersion: task.stateVersion,
          rawInputHash: active.rawInputHash,
          selectedScenarioId,
        }, onProgress);
      }
      if (unchanged) {
        const activated = await this.dependencies.repository.createAndActivateRequirementVersion({
          taskId: input.taskId,
          ownerUserId: input.ownerUserId,
          expectedVersion: expectedVersion ?? task.stateVersion,
          rawInputHash: active.rawInputHash,
          clarification: storedSelection,
          structuredTask: active.structuredTask,
          modelCallId: null,
        });
        return this.finishRefinement({
          taskId: input.taskId,
          conversationId: input.conversationId,
          ownerUserId: input.ownerUserId,
          originalInput: task.originalInput,
          requirement: active.structuredTask,
          requirementVersionId: activated.version.id,
          stateVersion: activated.task.stateVersion,
          rawInputHash: active.rawInputHash,
          selectedScenarioId,
        }, onProgress);
      }
      return this.refine({
        taskId: input.taskId,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        originalInput: task.originalInput,
        clarification: { ...input.answers, selectedScenarioId },
        persistedClarification: storedSelection,
        selectedScenarioId,
        expectedVersion: input.expectedVersion,
        expectedStateVersion: input.expectedStateVersion,
      }, onProgress);
    }
    if (input.selectedScenarioId !== undefined) {
      throw new InvalidScenarioSelectionError('当前任务不接受研究方向选择');
    }
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
        ownerUserId: input.ownerUserId,
        originalInput: task.originalInput,
        requirement: active.structuredTask,
        requirementVersionId: active.id,
        stateVersion: task.stateVersion,
        rawInputHash: active.rawInputHash,
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
        ownerUserId: input.ownerUserId,
        originalInput: task.originalInput,
        requirement: active.structuredTask,
        requirementVersionId: active.id,
        stateVersion: task.stateVersion,
        rawInputHash: active.rawInputHash,
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
    ownerUserId: string;
    originalInput: string;
    requirement: ResearchTaskV2;
    requirementVersionId: string;
    stateVersion: number;
    rawInputHash: string;
    selectedScenarioId?: ScenarioId;
    clarificationRecovery?: ClarificationRecoveryContext;
  }, onProgress?: (event: PlanProgress) => void): Promise<RequirementRefinementResult> {
    const status = needsClarification(input.requirement)
      ? 'clarification_required'
      : 'ready_to_plan';
    if (status === 'clarification_required') {
      await this.appendMessage({
        conversationId: input.conversationId,
        role: 'assistant',
        content: JSON.stringify({ status, requirement: input.requirement }),
        idempotencyKey: `requirement:${input.requirementVersionId}:assistant`,
      });
      return { status, taskId: input.taskId, requirement: input.requirement };
    }
    const planningOutcome = this.dependencies.planner
      ? await this.dependencies.planner.plan({
          originalInput: input.originalInput,
          requirement: input.requirement,
          ...(input.selectedScenarioId ? { selectedScenarioId: input.selectedScenarioId } : {}),
        }, onProgress)
      : undefined;
    if (isPlanningGuidanceClarification(planningOutcome)) {
      const activated = await this.dependencies.repository.createAndActivateRequirementVersion({
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        expectedVersion: input.stateVersion,
        rawInputHash: input.rawInputHash,
        clarification: { planningGuidance: planningOutcome.planningGuidance },
        structuredTask: input.requirement,
        modelCallId: null,
      });
      await this.appendMessage({
        conversationId: input.conversationId,
        role: 'assistant',
        content: JSON.stringify({
          status: 'clarification_required',
          requirement: input.requirement,
          planningGuidance: planningOutcome.planningGuidance,
        }),
        idempotencyKey: `requirement:${activated.version.id}:assistant`,
      });
      return {
        status: 'clarification_required',
        taskId: input.taskId,
        requirement: input.requirement,
        planningGuidance: planningOutcome.planningGuidance,
        activatedNodes: planningOutcome.activatedNodes,
      };
    }
    await this.appendMessage({
      conversationId: input.conversationId,
      role: 'assistant',
      content: JSON.stringify({ status, requirement: input.requirement }),
      idempotencyKey: `requirement:${input.requirementVersionId}:assistant`,
    });
    return {
      status,
      taskId: input.taskId,
      requirement: input.requirement,
      ...(planningOutcome ? { planningResult: planningOutcome } : {}),
      ...(input.clarificationRecovery
        ? { clarificationRecovery: input.clarificationRecovery }
        : {}),
    };
  }

  private async refine(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    clarification: unknown;
    persistedClarification?: unknown;
    selectedScenarioId?: ScenarioId;
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
    const taskTypeBeforeRefinement = task?.structuredTask
      && typeof task.structuredTask === 'object'
      && 'task_type' in task.structuredTask
      && typeof task.structuredTask.task_type === 'string'
      ? task.structuredTask.task_type
      : null;
    const directionNeedsReselection = Boolean(
      input.selectedScenarioId
      && taskTypeBeforeRefinement
      && taskTypeBeforeRefinement !== requirement.task_type,
    );
    const selectedScenarioId = directionNeedsReselection
      ? undefined
      : input.selectedScenarioId;
    const persistedClarification = directionNeedsReselection
      ? withoutScenarioSelection(input.clarification)
      : input.persistedClarification ?? input.clarification;
    const expectedVersion = input.expectedVersion
      ?? input.expectedStateVersion
      ?? task?.stateVersion
      ?? 0;
    const activated = await this.dependencies.repository.createAndActivateRequirementVersion({
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      expectedVersion,
      rawInputHash: hashPrompt(input.originalInput, context, 'research-task-v2'),
      clarification: persistedClarification,
      structuredTask: requirement,
      modelCallId: null,
    });
    return this.finishRefinement({
      taskId: input.taskId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      originalInput: input.originalInput,
      requirement,
      requirementVersionId: activated.version.id,
      stateVersion: activated.task.stateVersion,
      rawInputHash: activated.version.rawInputHash,
      ...(selectedScenarioId ? { selectedScenarioId } : {}),
    }, onProgress);
  }
}
