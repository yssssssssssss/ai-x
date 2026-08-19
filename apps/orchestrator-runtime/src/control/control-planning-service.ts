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
  resolvePlanningDeliverableSelection,
  type CurrentResearchPlanningResult,
} from '../planners/research-planning-service.ts';
import { PlanCompiler } from '../planners/plan-compiler.ts';
import type { ClarificationRecoveryContext } from './requirement-refinement-service.ts';

type ProvisionalExecutionPlan = Omit<CurrentExecutionPlan, 'task_id'> & {
  task_id?: '';
};

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
    ): Promise<CurrentResearchPlanningResult>;
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
    persistClarificationCandidatesAndCompleteCommand?(input: {
      taskId: string;
      conversationId: string;
      ownerUserId: string;
      expectedStateVersion: number;
      taskType: string;
      structuredTask: CurrentResearchPlanningResult['structuredTask'];
      activatedNodes: string[];
      clarificationRecovery?: ClarificationRecoveryContext;
      candidates: Array<{
        candidateId: PlanCandidate['id'];
        title: string;
        rationale: string;
        tradeoffs: string;
        plan: ProvisionalExecutionPlan;
        pendingInputs: PendingInput[];
      }>;
      command: ClarificationCommandReservation;
    }): Promise<ControlPlanCandidatesResponse>;
  };
  conversations: {
    create(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
    requireOwned(input: {
      conversationId: string;
      ownerUserId: string;
    }): Promise<{ id: string }>;
  };
}

export interface ClarificationCommandReservation {
  commandType: 'clarification';
  idempotencyKey: string;
  requestHash: string;
  expectedVersion: number;
  reservationToken: string;
  actorUserId: string;
}

export class ControlPlanningService {
  private readonly compiler = new PlanCompiler();

  constructor(private readonly dependencies: ControlPlanningDependencies) {}

  private prepareCandidates(planningResult: CurrentResearchPlanningResult): Array<{
    candidateId: PlanCandidate['id'];
    plan: ProvisionalExecutionPlan;
    pendingInputs: PendingInput[];
  }> {
    const candidateIds = planningResult.candidates.map((candidate) => candidate.id);
    if (
      candidateIds.length !== 2
      || new Set(candidateIds).size !== 2
      || !candidateIds.includes('depth')
      || !candidateIds.includes('speed')
    ) {
      throw new Error('Current planning requires exactly depth and speed candidates');
    }
    const deliverableSelection = resolvePlanningDeliverableSelection(
      planningResult.structuredTask,
    );
    return planningResult.candidates.map((candidate) => {
      const compiled = this.compiler.compile({
        candidate,
        task: planningResult.structuredTask,
        deliverable_selection: deliverableSelection,
        problem_graph: planningResult.problemGraph,
        problem_graph_provenance: planningResult.problemGraphProvenance,
        capability_resolution: planningResult.capabilityResolution,
        evidence_requirements: deliverableSelection.evidenceRequirements,
        activated_nodes: planningResult.activatedNodes,
        requireCompetitiveWeightContract: true,
      });
      return {
        candidateId: candidate.id,
        plan: compiled.plan,
        pendingInputs: compiled.pending_inputs,
      };
    });
  }

  private responseFromPersisted(
    conversationId: string,
    planningResult: CurrentResearchPlanningResult,
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
      structuredTask: planningResult.structuredTask ?? planningResult.task,
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
      structuredTask: planningResult.structuredTask ?? planningResult.task,
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
      commandReservation?: ClarificationCommandReservation;
      clarificationRecovery?: ClarificationRecoveryContext;
    },
    planningResult: CurrentResearchPlanningResult,
  ): Promise<ControlPlanCandidatesResponse> {
    const conversation = await this.dependencies.conversations.requireOwned({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    const preparedCandidates = this.prepareCandidates(planningResult);
    if (input.commandReservation) {
      if (!this.dependencies.repository.persistClarificationCandidatesAndCompleteCommand) {
        throw new Error('atomic clarification planning persistence is unavailable');
      }
      const structuredTask = planningResult.structuredTask;
      if (!structuredTask) throw new Error('clarification planning requires ResearchTaskV2');
      const preparedById = new Map(preparedCandidates.map((candidate) => [candidate.candidateId, candidate]));
      return this.dependencies.repository.persistClarificationCandidatesAndCompleteCommand({
        taskId: input.taskId,
        conversationId: conversation.id,
        ownerUserId: input.ownerUserId,
        expectedStateVersion: input.expectedStateVersion,
        taskType: planningResult.task.task_type,
        structuredTask,
        activatedNodes: planningResult.activatedNodes,
        clarificationRecovery: input.clarificationRecovery,
        candidates: planningResult.candidates.map((candidate) => {
          const prepared = preparedById.get(candidate.id);
          if (!prepared) throw new Error(`prepared candidate ${candidate.id} is missing`);
          return {
            candidateId: candidate.id,
            title: candidate.title,
            rationale: candidate.rationale,
            tradeoffs: candidate.tradeoffs,
            plan: prepared.plan,
            pendingInputs: prepared.pendingInputs,
          };
        }),
        command: input.commandReservation,
      });
    }
    if (!this.dependencies.repository.persistExistingTaskWithCandidates) {
      throw new Error('existing-task planning persistence is unavailable');
    }
    const persisted = await this.dependencies.repository.persistExistingTaskWithCandidates({
      taskId: input.taskId,
      conversationId: conversation.id,
      ownerUserId: input.ownerUserId,
      expectedStateVersion: input.expectedStateVersion,
      taskType: planningResult.task.task_type,
      structuredTask: planningResult.structuredTask ?? planningResult.task,
      candidates: preparedCandidates,
    });
    return this.responseFromPersisted(conversation.id, planningResult, persisted);
  }
}
