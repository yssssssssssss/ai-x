import type {
  ControlPlanCandidatesResponse,
  ControlTaskResponse,
  OrchestrationModeV1,
  PlanControlTaskRequest,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  LightweightExecutionPlanV1,
  ReadableExecutionPlan,
} from '../../../../packages/api-contract/lightweight-orchestration.ts';
import { isLightweightExecutionPlanV1 } from '../../../../packages/api-contract/lightweight-orchestration.ts';
import type {
  CurrentExecutionPlan,
  CurrentExecutionPlanV3,
  PendingInput,
} from '../../../../packages/api-contract/research-deliverable.ts';
import {
  isCandidateProfile,
  type PlanCandidate,
  type PlanProgress,
} from '../../../../packages/api-contract/plan.ts';
import {
  resolvePlanningDeliverableSelection,
  type CurrentResearchPlanningResult,
} from '../planners/research-planning-service.ts';
import {
  assertSingleSkillExecutionPlan,
  compileLightweightExecutionPlan,
  PlanCompiler,
} from '../planners/plan-compiler.ts';
import type { ClarificationRecoveryContext } from './requirement-refinement-service.ts';

type ProvisionalExecutionPlan =
  | (Omit<CurrentExecutionPlan, 'task_id'> & { task_id?: string })
  | (Omit<CurrentExecutionPlanV3, 'task_id'> & { task_id?: string })
  | (Omit<LightweightExecutionPlanV1, 'task_id'> & { task_id?: string });

interface PersistedPlanVersion {
  id: string;
  taskId: string;
  version: number;
  candidateId: PlanCandidate['id'];
  plan: ReadableExecutionPlan;
  planHash: string;
  pendingInputs: PendingInput[];
}

export interface ControlPlanningDependencies {
  planning: {
    plan(
      input: { originalInput: string; orchestrationMode: OrchestrationModeV1 },
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
      orchestrationMode?: OrchestrationModeV1;
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
      orchestrationMode: OrchestrationModeV1;
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

  private prepareCandidates(
    planningResult: CurrentResearchPlanningResult,
    orchestrationMode: OrchestrationModeV1,
  ): Array<{
    candidateId: PlanCandidate['id'];
    plan: ProvisionalExecutionPlan;
    pendingInputs: PendingInput[];
  }> {
    const candidateIds = planningResult.candidates.map((candidate) => candidate.id);
    const recommendedCount = planningResult.candidates.filter(
      (candidate) => candidate.recommended === true,
    ).length;
    if (
      candidateIds.length < 2
      || candidateIds.length > 4
      || new Set(candidateIds).size !== candidateIds.length
      || candidateIds.some((candidateId) => !isCandidateProfile(candidateId))
      || !candidateIds.includes('speed')
      || !candidateIds.includes('depth')
      || (
        candidateIds.length > 2
        && (candidateIds[0] !== 'speed' || candidateIds[1] !== 'depth')
      )
      || recommendedCount !== 1
      || planningResult.planningProvenance.selected_profile_ids.length !== candidateIds.length
      || planningResult.planningProvenance.selected_profile_ids.some((candidateId, index) => (
        candidateId !== candidateIds[index]
      ))
    ) {
      throw new Error(
        'Current planning requires 2-4 unique controlled candidates in baseline-first order, exactly one recommendation, and matching provenance',
      );
    }
    const deliverableSelection = resolvePlanningDeliverableSelection(
      planningResult.structuredTask,
    );
    return planningResult.candidates.map((candidate) => {
      const portfolio = planningResult.portfolios?.[candidate.id];
      const compiled = planningResult.capabilityDemandGraph && portfolio
        ? this.compiler.compilePortfolio({
            candidate,
            task: planningResult.structuredTask,
            deliverable_selection: deliverableSelection,
            problem_graph: planningResult.problemGraph,
            problem_graph_provenance: planningResult.problemGraphProvenance,
            capability_resolution: planningResult.capabilityResolution,
            evidence_requirements: deliverableSelection.evidenceRequirements,
            capability_demand_graph: planningResult.capabilityDemandGraph,
            portfolio,
            activated_nodes: planningResult.activatedNodes,
            planning_provenance: planningResult.planningProvenance,
            requireCompetitiveWeightContract: true,
          })
        : this.compiler.compile({
            candidate,
            task: planningResult.structuredTask,
            deliverable_selection: deliverableSelection,
            problem_graph: planningResult.problemGraph,
            problem_graph_provenance: planningResult.problemGraphProvenance,
            capability_resolution: planningResult.capabilityResolution,
            evidence_requirements: deliverableSelection.evidenceRequirements,
            activated_nodes: planningResult.activatedNodes,
            planning_provenance: planningResult.planningProvenance,
            requireCompetitiveWeightContract: true,
          });
      if (orchestrationMode === 'single_skill') {
        assertSingleSkillExecutionPlan(compiled.plan);
      }
      const lightweight = compileLightweightExecutionPlan({
        plan: compiled.plan,
        mode: orchestrationMode,
        task: planningResult.structuredTask,
      });
      return {
        candidateId: candidate.id,
        plan: { ...lightweight.plan, task_id: '' },
        pendingInputs: lightweight.pendingInputs,
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
        ...(isLightweightExecutionPlanV1(stored.plan)
          ? { resolvedInputs: stored.plan.resolved_inputs }
          : {}),
      };
    });
    return {
      kind: 'current',
      conversationId,
      task: {
        ...persisted.task,
        orchestrationMode: planningResult.orchestrationMode ?? persisted.task.orchestrationMode ?? null,
      },
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
      { originalInput: input.originalInput, orchestrationMode: input.orchestrationMode },
      onProgress,
    );
    const boundPlanningResult: CurrentResearchPlanningResult = {
      ...planningResult,
      orchestrationMode: input.orchestrationMode,
    };
    const persisted = await this.dependencies.repository.createTaskWithCandidates({
      conversationId: conversation.id,
      ownerUserId: input.ownerUserId,
      originalInput: input.originalInput,
      taskType: boundPlanningResult.task.task_type,
      structuredTask: boundPlanningResult.structuredTask ?? boundPlanningResult.task,
      orchestrationMode: input.orchestrationMode,
      candidates: this.prepareCandidates(boundPlanningResult, input.orchestrationMode),
    });
    return this.responseFromPersisted(conversation.id, boundPlanningResult, persisted);
  }

  async planExistingTask(
    input: {
      taskId: string;
      conversationId: string;
      ownerUserId: string;
      expectedStateVersion: number;
      originalInput: string;
      orchestrationMode?: OrchestrationModeV1;
      commandReservation?: ClarificationCommandReservation;
      clarificationRecovery?: ClarificationRecoveryContext;
    },
    planningResult: CurrentResearchPlanningResult,
  ): Promise<ControlPlanCandidatesResponse> {
    const orchestrationMode = planningResult.orchestrationMode
      ?? input.orchestrationMode
      ?? 'single_skill';
    if (
      input.orchestrationMode !== undefined
      && planningResult.orchestrationMode !== undefined
      && input.orchestrationMode !== planningResult.orchestrationMode
    ) {
      throw new Error('Task orchestration mode does not match the planned execution contract');
    }
    const conversation = await this.dependencies.conversations.requireOwned({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    const preparedCandidates = this.prepareCandidates(planningResult, orchestrationMode);
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
        orchestrationMode,
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
    return this.responseFromPersisted(
      conversation.id,
      { ...planningResult, orchestrationMode },
      persisted,
    );
  }
}
