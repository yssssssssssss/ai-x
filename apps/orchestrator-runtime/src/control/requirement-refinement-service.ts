import type {
  ControlPlaneRepository,
  ControlTaskDetail,
} from '../../../../database/control-plane.ts';
import type { ControlRequirementVersion } from '../../../../packages/api-contract/control-workflow.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { ResearchPlanningResult } from '../planners/research-planning-service.ts';
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
  }): Promise<void>;
}

export interface RequirementPlanner {
  plan(input: {
    originalInput: string;
    requirement: ResearchTaskV2;
  }): Promise<unknown>;
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
export type RequirementRefinementResult =
  | { status: 'clarification_required'; taskId: string; requirement: ResearchTaskV2 }
  | { status: 'ready_to_plan'; taskId: string; requirement: ResearchTaskV2; planningResult?: ResearchPlanningResult };

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

const REQUIREMENT_PROMPT = `把会话整理为 ResearchTaskV2。必须忠实保留用户目标、范围、成功标准和约束；可安全推断的信息写入 assumptions；无法安全推断的信息写入 ambiguities 与 clarification_questions；敏感、授权或合规风险写入 blocking_issues。`;

function hasBlockingAmbiguity(requirement: ResearchTaskV2): boolean {
  return requirement.ambiguities.some((ambiguity) => ambiguity.blocking)
    || requirement.blocking_issues.length > 0;
}


function needsClarification(requirement: ResearchTaskV2): boolean {
  return hasBlockingAmbiguity(requirement) || requirement.clarification_questions.length > 0;
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

  async understand(input: UnderstandInput): Promise<RequirementRefinementResult> {
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
    });
  }

  async clarify(input: ClarifyInput): Promise<RequirementRefinementResult> {
    await this.dependencies.conversations.requireOwned({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    const task = await this.dependencies.repository.getTaskDetail?.(input.taskId);
    if (!task) throw new Error(`task ${input.taskId} does not exist`);
    const active = await this.dependencies.repository.getActiveRequirementVersion(input.taskId);
    if (!active) throw new Error(`task ${input.taskId} has no active requirement version to clarify`);
    return this.refine({
      taskId: input.taskId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      originalInput: task.originalInput,
      clarification: input.answers,
      expectedVersion: input.expectedVersion,
      expectedStateVersion: input.expectedStateVersion,
    });
  }

  private async refine(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    clarification: unknown;
    expectedVersion?: number;
    expectedStateVersion?: number;
  }): Promise<RequirementRefinementResult> {
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
    const requirement = generated.data;
    const task = await this.dependencies.repository.getTaskDetail?.(input.taskId);
    const expectedVersion = input.expectedVersion
      ?? input.expectedStateVersion
      ?? task?.stateVersion
      ?? 0;
    const stored = await this.dependencies.repository.createAndActivateRequirementVersion({
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      expectedVersion,
      rawInputHash: hashPrompt(input.originalInput, context, 'research-task-v2'),
      clarification: input.clarification,
      structuredTask: requirement,
      modelCallId: null,
    });
    const status = needsClarification(requirement)
      ? 'clarification_required'
      : 'ready_to_plan';
    const planningResult = status === 'ready_to_plan' && this.dependencies.planner
      ? await this.dependencies.planner.plan({
          originalInput: input.originalInput,
          requirement,
        }) as ResearchPlanningResult
      : undefined;
    await this.appendMessage({
      conversationId: input.conversationId,
      role: 'assistant',
      content: JSON.stringify({ status, requirement }),
    });
    return planningResult
      ? { status, taskId: input.taskId, requirement, planningResult }
      : { status, taskId: input.taskId, requirement };
  }
}
