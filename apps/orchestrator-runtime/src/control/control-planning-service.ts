import type {
  ControlPlanCandidatesResponse,
  ControlTaskResponse,
  PlanControlTaskRequest,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  CurrentExecutionPlan,
  PendingInput,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  PlanCandidate,
  PlanProgress,
} from '../../../../packages/api-contract/plan.ts';
import {
  resolveEvidenceRequirements,
  type ResearchPlanningResult,
} from '../planners/research-planning-service.ts';
import { sanitizeCandidateToPlan } from '../planners/plan-sanitizer.ts';

type ProvisionalExecutionPlan = Omit<CurrentExecutionPlan, 'task_id'> & {
  task_id?: '';
};

// Current plan step 白名单清洗:复用 legacy sanitizeCandidateToPlan 的 step 规整
// (step_no 用索引、step_name 缺省取 actor_id、非对象 input 丢弃、丢弃 step_id/schema_escape 等漂移字段)。
// 在调用 repository 持久化前执行,拒绝空 steps 与未知 actor_type。
const ALLOWED_ACTOR_TYPES = new Set(['skill', 'tool', 'llm', 'reviewer']);

function sanitizeCurrentSteps(steps: PlanCandidate['steps']): CurrentExecutionPlan['steps'] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Current plan steps 不能为空');
  }
  for (const step of steps) {
    if (!ALLOWED_ACTOR_TYPES.has((step as { actor_type?: string }).actor_type ?? '')) {
      throw new Error(`未知 actor_type: ${(step as { actor_type?: unknown }).actor_type}`);
    }
  }
  return sanitizeCandidateToPlan({ steps } as PlanCandidate, '', '').steps;
}

interface PersistedPlanVersion {
  id: string;
  taskId: string;
  version: number;
  candidateId: PlanCandidate['id'];
  plan: CurrentExecutionPlan;
  planHash: string;
  pendingInputs: PendingInput[];
}

export interface ControlPlanningDependencies {
  planning: {
    plan(
      input: { originalInput: string },
      onProgress?: (event: PlanProgress) => void,
    ): Promise<ResearchPlanningResult>;
  };
  repository: {
    createTaskWithCandidates(input: {
      conversationId: string;
      ownerUserId: string;
      originalInput: string;
      taskType: string | null;
      structuredTask: unknown;
      candidates: Array<{
        candidateId: PlanCandidate['id'];
        plan: ProvisionalExecutionPlan;
        pendingInputs: PendingInput[];
      }>;
    }): Promise<{
      task: ControlTaskResponse;
      candidates: PersistedPlanVersion[];
    }>;
    persistExistingTaskWithCandidates?(input: {
      taskId: string;
      conversationId: string;
      ownerUserId: string;
      expectedStateVersion: number;
      taskType: string | null;
      structuredTask: unknown;
      candidates: Array<{
        candidateId: PlanCandidate['id'];
        plan: ProvisionalExecutionPlan;
        pendingInputs: PendingInput[];
      }>;
    }): Promise<{
      task: ControlTaskResponse;
      candidates: PersistedPlanVersion[];
    }>;
  };
  conversations: {
    create(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
    requireOwned(input: {
      conversationId: string;
      ownerUserId: string;
    }): Promise<{ id: string }>;
  };
}

export class ControlPlanningService {
  constructor(private readonly dependencies: ControlPlanningDependencies) {}

  private prepareCandidates(planningResult: ResearchPlanningResult): Array<{
    candidateId: PlanCandidate['id'];
    plan: ProvisionalExecutionPlan;
    pendingInputs: PendingInput[];
  }> {
    const evidenceRequirements = resolveEvidenceRequirements(
      planningResult.task.task_type,
      'research_plan',
    );
    return planningResult.candidates.map((candidate) => ({
      candidateId: candidate.id,
      plan: {
        task_id: '',
        deliverable_type: 'research_plan',
        evidence_requirements: evidenceRequirements,
        steps: sanitizeCurrentSteps(candidate.steps),
      },
      pendingInputs: [],
    }));
  }

  private responseFromPersisted(
    conversationId: string,
    planningResult: ResearchPlanningResult,
    persisted: { task: ControlTaskResponse; candidates: PersistedPlanVersion[] },
  ): ControlPlanCandidatesResponse {
    const persistedByCandidateId = new Map(
      persisted.candidates.map((candidate) => [candidate.candidateId, candidate]),
    );
    const candidates = planningResult.candidates.map((candidate) => {
      const stored = persistedByCandidateId.get(candidate.id);
      if (!stored) throw new Error(`repository did not return candidate ${candidate.id}`);
      return {
        planVersionId: stored.id,
        candidateId: candidate.id,
        title: candidate.title,
        rationale: candidate.rationale,
        tradeoffs: candidate.tradeoffs,
        planHash: stored.planHash,
        plan: stored.plan,
        pendingInputs: stored.pendingInputs,
      };
    });
    return {
      kind: 'current',
      conversationId,
      task: persisted.task,
      structuredTask: planningResult.task,
      activatedNodes: planningResult.activatedNodes,
      candidates,
    };
  }

  async plan(
    input: PlanControlTaskRequest & { ownerUserId: string },
    onProgress?: (event: PlanProgress) => void,
    onConversation?: (conversationId: string) => void,
  ): Promise<ControlPlanCandidatesResponse> {
    const conversation = input.conversationId
      ? await this.dependencies.conversations.requireOwned({
          conversationId: input.conversationId,
          ownerUserId: input.ownerUserId,
        })
      : await this.dependencies.conversations.create({
          ownerUserId: input.ownerUserId,
          title: input.originalInput.slice(0, 40),
        });
    if (!input.conversationId) onConversation?.(conversation.id);

    const planningResult = await this.dependencies.planning.plan(
      { originalInput: input.originalInput },
      onProgress,
    );
    const persisted = await this.dependencies.repository.createTaskWithCandidates({
      conversationId: conversation.id,
      ownerUserId: input.ownerUserId,
      originalInput: input.originalInput,
      taskType: planningResult.task.task_type,
      structuredTask: planningResult.task,
      candidates: this.prepareCandidates(planningResult),
    });
    return this.responseFromPersisted(conversation.id, planningResult, persisted);
  }

  async planExistingTask(
    input: {
      taskId: string;
      conversationId: string;
      ownerUserId: string;
      expectedStateVersion: number;
      originalInput: string;
    },
    planningResult: ResearchPlanningResult,
  ): Promise<ControlPlanCandidatesResponse> {
    const conversation = await this.dependencies.conversations.requireOwned({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    const persist = this.dependencies.repository.persistExistingTaskWithCandidates;
    if (!persist) throw new Error('existing-task planning persistence is unavailable');
    const persisted = await persist({
      taskId: input.taskId,
      conversationId: conversation.id,
      ownerUserId: input.ownerUserId,
      expectedStateVersion: input.expectedStateVersion,
      taskType: planningResult.task.task_type,
      structuredTask: planningResult.task,
      candidates: this.prepareCandidates(planningResult),
    });
    return this.responseFromPersisted(conversation.id, planningResult, persisted);
  }
}
