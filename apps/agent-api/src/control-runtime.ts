import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pool } from '../../../database/db.ts';
import { ControlPlaneAuthorizationError, ControlPlaneRepository } from '../../../database/control-plane.ts';
import { createConversation, getOwnedConversation, listMessages, writeMessage } from '../../../database/repository.ts';
import { ControlArtifactStore } from '../../orchestrator-runtime/src/control/artifact-store.ts';
import { ControlPlanningService } from '../../orchestrator-runtime/src/control/control-planning-service.ts';
import { LeaseExecutionEngine } from '../../orchestrator-runtime/src/control/lease-execution-engine.ts';
import {
  TaskWorkflowService,
  type WorkflowPlanRevisionDriver,
} from '../../orchestrator-runtime/src/control/task-workflow.ts';
import { EvidenceService } from '../../orchestrator-runtime/src/evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../../orchestrator-runtime/src/evidence/report-evidence-validator.ts';
import {
  RequirementRefinementService,
  type ConversationAdapter,
} from '../../orchestrator-runtime/src/control/requirement-refinement-service.ts';
import {
  ResearchPlanningService,
  resolvePlanningDeliverableSelection,
  type CurrentResearchPlanningResult,
  type ResearchPlanningInput,
} from '../../orchestrator-runtime/src/planners/research-planning-service.ts';
import { PlanCompiler } from '../../orchestrator-runtime/src/planners/plan-compiler.ts';
import type { PlanCandidate, PlanProgress, ResearchTaskV2 } from '../../../packages/api-contract/plan.ts';
import type { CurrentReportPackageResponse } from '../../../packages/api-contract/control-workflow.ts';
import type {
  CurrentExecutionPlan,
  EvidenceClass,
  EvidenceRequirement,
  PendingInput,
} from '../../../packages/api-contract/research-deliverable.ts';
import { CurrentDeliverableService } from '../../orchestrator-runtime/src/report/current-deliverable-service.ts';
import { SynthesisMaterializer } from '../../orchestrator-runtime/src/report/synthesis-materializer.ts';
import { ReportReviewService } from '../../orchestrator-runtime/src/report/report-review-service.ts';
import { CurrentReportPackageReader } from '../../orchestrator-runtime/src/report/current-report-package-reader.ts';
import { ReportCompositionService } from '../../orchestrator-runtime/src/report/report-composition-service.ts';
import {
  ImageAnnotationService,
  type ImageAnnotationInput,
  type ImageAnnotationResult,
} from '../../orchestrator-runtime/src/report/image-annotation-service.ts';
import {
  VisualAssetService,
  type VerifiedVisualAsset,
} from '../../orchestrator-runtime/src/report/visual-asset-service.ts';
import { buildRuntime } from '../../orchestrator-runtime/src/runtime/agent-runtime.ts';
import { VisualInputMaterializer } from '../../orchestrator-runtime/src/report/visual-input-materializer.ts';
import type { LLMClient } from '../../orchestrator-runtime/src/runtime/llm-client.ts';
import { ReceiptLLMClient } from '../../orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { SchemaValidator } from '../../orchestrator-runtime/src/schema/validator.ts';
import { SkillLoader } from '../../orchestrator-runtime/src/runtime/skill-loader.ts';
import { ToolRouter } from '../../orchestrator-runtime/src/runtime/tool-adapter.ts';
import { VisualInputGateStore } from '../../orchestrator-runtime/src/control/visual-input-gate-store.ts';
import { parsePendingInputContracts } from '../../orchestrator-runtime/src/control/pending-input-contract.ts';
import { LocalZeroMcpClient } from './integrations/zero/zero-mcp-client.ts';
import {
  ZeroPublicationService,
  type ZeroPublicationMcp,
} from './integrations/zero/zero-publication-service.ts';


const REVISION_ACTOR_TYPES: Record<string, true> = {
  skill: true,
  tool: true,
  llm: true,
  reviewer: true,
};

function revisionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
const REVISION_EVIDENCE_CLASSES: Record<EvidenceClass, true> = {
  public_source: true,
  screenshot: true,
  user_input: true,
  knowledge: true,
  dataset: true,
  simulation: true,
  derived: true,
};

function revisionEvidenceRequirements(value: unknown): value is EvidenceRequirement[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => {
      const record = revisionRecord(item);
      return record !== null
        && typeof record.id === 'string'
        && record.id.trim().length > 0
        && Array.isArray(record.acceptedClasses)
        && record.acceptedClasses.length > 0
        && record.acceptedClasses.every(
          (evidenceClass): evidenceClass is EvidenceClass =>
            typeof evidenceClass === 'string'
            && REVISION_EVIDENCE_CLASSES[evidenceClass as EvidenceClass] === true,
        )
        && typeof record.minimumCount === 'number'
        && Number.isInteger(record.minimumCount)
        && record.minimumCount >= 0
        && typeof record.required === 'boolean';
    });
}

const REVISION_REQUIRED_STEP_KEYS = ['actor_id', 'actor_type', 'step_name', 'step_no'] as const;
const REVISION_STEP_KEYS: Record<string, true> = {
  actor_id: true,
  actor_type: true,
  input: true,
  purpose: true,
  requires_approval: true,
  step_name: true,
  step_no: true,
};

function revisionSteps(value: unknown): value is PlanCandidate['steps'] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => {
      const record = revisionRecord(item);
      return record !== null
        && Object.keys(record).every((key) => REVISION_STEP_KEYS[key] === true)
        && REVISION_REQUIRED_STEP_KEYS.every((key) => Object.hasOwn(record, key))
        && typeof record.step_no === 'number'
        && Number.isInteger(record.step_no)
        && record.step_no >= 1
        && typeof record.step_name === 'string'
        && record.step_name.trim().length > 0
        && typeof record.actor_type === 'string'
        && REVISION_ACTOR_TYPES[record.actor_type] === true
        && typeof record.actor_id === 'string'
        && record.actor_id.trim().length > 0
        && (!Object.hasOwn(record, 'purpose') || typeof record.purpose === 'string')
        && (!Object.hasOwn(record, 'input') || revisionRecord(record.input) !== null)
        && (!Object.hasOwn(record, 'requires_approval') || typeof record.requires_approval === 'boolean');
    });
}

function revisionPendingInputsResolve(pendingInputs: PendingInput[], steps: unknown): boolean {
  if (!revisionSteps(steps)) return false;
  return pendingInputs.every((pendingInput) => pendingInput.targets.every((target) => (
    steps.some((step) => {
      const stepRecord = revisionRecord(step);
      const stepInput = revisionRecord(stepRecord?.input);
      return stepRecord?.step_no === target.step_no
        && stepRecord.actor_id === target.tool_id
        && stepInput !== null
        && Object.hasOwn(stepInput, target.field);
    })
  )));
}

const LEGACY_PENDING_INPUT_KEYS = ['label', 'multiple', 'role', 'targets'] as const;
const LEGACY_PENDING_TARGET_KEYS = ['field', 'multiple', 'step_no', 'tool_id'] as const;
const LEGACY_CAPABILITY_PENDING_INPUT_KEYS = ['capability_id', 'label', 'multiple', 'role'] as const;

function revisionExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function normalizeLegacyRevisionSource(input: {
  plan: unknown;
  pendingInputs: unknown;
}): { plan: Record<string, unknown>; pendingInputs: unknown[] } | null {
  if (!Array.isArray(input.pendingInputs)) return null;
  const pendingInputs = structuredClone(input.pendingInputs);
  let missingKindCount = 0;
  for (const pending of pendingInputs) {
    const record = revisionRecord(pending);
    if (!record || !revisionExactKeys(record, LEGACY_PENDING_INPUT_KEYS)) return null;
    if (
      !Array.isArray(record.targets)
      || record.targets.length === 0
      || !record.targets.every((target) => {
        const targetRecord = revisionRecord(target);
        return targetRecord !== null
          && revisionExactKeys(targetRecord, LEGACY_PENDING_TARGET_KEYS);
      })
    ) return null;
    record.kind = 'value';
    missingKindCount += 1;
  }

  const plan = revisionRecord(structuredClone(input.plan));
  const decisions = revisionRecord(plan?.capability_decisions);
  if (!plan || !decisions) return null;
  for (const bucket of ['eligible', 'rejected'] as const) {
    const values = decisions[bucket];
    if (!Array.isArray(values)) return null;
    for (const value of values) {
      const decision = revisionRecord(value);
      if (!decision || !Array.isArray(decision.pending_inputs)) return null;
      for (const pending of decision.pending_inputs) {
        const record = revisionRecord(pending);
        if (!record || !revisionExactKeys(record, LEGACY_CAPABILITY_PENDING_INPUT_KEYS)) return null;
        record.kind = 'value';
        missingKindCount += 1;
      }
    }
  }
  return missingKindCount > 0 ? { plan, pendingInputs } : null;
}

function assertRevisionSourceContract(input: {
  activePlan: { id: string; plan: unknown; pendingInputs: unknown };
  deliverableSelection: { deliverableId: string; evidenceRequirements: EvidenceRequirement[] };
  validator: SchemaValidator;
}): void {
  let plan = input.activePlan.plan;
  try {
    input.validator.validateOrThrow('current-execution-plan', plan);
    parsePendingInputContracts(input.activePlan.pendingInputs);
  } catch (currentError) {
    const legacy = normalizeLegacyRevisionSource({
      plan,
      pendingInputs: input.activePlan.pendingInputs,
    });
    if (!legacy) throw currentError;
    input.validator.validateOrThrow('current-execution-plan', legacy.plan);
    parsePendingInputContracts(legacy.pendingInputs);
    plan = legacy.plan;
  }

  const planShape = plan as CurrentExecutionPlan;
  if (
    planShape.deliverable_type !== input.deliverableSelection.deliverableId
    || !isDeepStrictEqual(
      planShape.evidence_requirements,
      input.deliverableSelection.evidenceRequirements,
    )
  ) {
    throw new Error(
      `active plan ${input.activePlan.id} does not match the current Deliverable Registry contract`,
    );
  }
}


function revisionCandidate(result: unknown, candidateId: 'depth' | 'speed'): PlanCandidate {
  const record = revisionRecord(result);
  if (!record || !Array.isArray(record.candidates)) {
    throw new Error('revision planning result has no candidates');
  }
  const candidate = record.candidates.find((value) => revisionRecord(value)?.id === candidateId);
  const candidateRecord = revisionRecord(candidate);
  if (
    !candidateRecord
    || !Array.isArray(candidateRecord.steps)
    || candidateRecord.steps.length === 0
    || typeof candidateRecord.title !== 'string'
    || candidateRecord.title.trim() === ''
    || typeof candidateRecord.rationale !== 'string'
    || candidateRecord.rationale.trim() === ''
    || typeof candidateRecord.tradeoffs !== 'string'
    || candidateRecord.tradeoffs.trim() === ''
  ) {
    throw new Error(`revision planning result has malformed ${candidateId} candidate`);
  }
  for (const step of candidateRecord.steps) {
    const actorType = revisionRecord(step)?.actor_type;
    if (typeof actorType !== 'string' || REVISION_ACTOR_TYPES[actorType] !== true) {
      throw new Error(`revision planning result has invalid actor_type: ${String(actorType)}`);
    }
  }
  return candidate as PlanCandidate;
}

function revisionActivatedNodes(result: unknown): string[] {
  const activatedNodes = revisionRecord(result)?.activatedNodes;
  if (!Array.isArray(activatedNodes) || activatedNodes.some((node) => typeof node !== 'string')) {
    throw new Error('revision planning result has malformed activated nodes');
  }
  return activatedNodes;
}
type RuntimeConversationAdapter = {
  create(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
  requireOwned(input: { conversationId: string; ownerUserId: string }): Promise<{ id: string }>;
  listMessages?: ConversationAdapter['listMessages'];
  appendMessage?: ConversationAdapter['appendMessage'];
};

interface PlanningAdapter {
  plan(
    input: ResearchPlanningInput,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<CurrentResearchPlanningResult>;
}

export interface ControlRuntimeOverrides {
  repository?: ControlPlaneRepository;
  conversations?: RuntimeConversationAdapter;
  planning?: PlanningAdapter;
  tools?: ToolRouter;
  llm?: LLMClient;
  validator?: SchemaValidator;
  skillLoader?: SkillLoader;
  artifacts?: ControlArtifactStore;
  expectedActualModel?: string;
  zeroMcp?: ZeroPublicationMcp;
  zeroPublicationEnabled?: boolean;
}

export type ControlPlanningRuntime = Pick<ControlPlanningService, 'plan' | 'planExistingTask'>;

export interface ControlRuntime {
  controlPlanning: ControlPlanningRuntime;
  conversations: Pick<RuntimeConversationAdapter, 'create' | 'requireOwned'>;
  requirementRefinement: RequirementRefinementService;
  workflow: TaskWorkflowService;
  repository: ControlPlaneRepository;
  artifacts: ControlArtifactStore;
  zeroPublication?: ZeroPublicationService;
  annotateVisualAsset(input: ImageAnnotationInput): Promise<ImageAnnotationResult>;
  getDeliverable(taskId: string, ownerUserId: string): Promise<CurrentReportPackageResponse | null>;
  readVisualAsset(input: {
    taskId: string;
    assetId: string;
    ownerUserId: string;
  }): Promise<VerifiedVisualAsset | null>;
}
function defaultConversations(): RuntimeConversationAdapter {
  return {
    async create(input) {
      return createConversation(input);
    },
    async requireOwned(input) {
      const conversation = await getOwnedConversation(input.conversationId, input.ownerUserId);
      if (!conversation) throw new ControlPlaneAuthorizationError('conversation is not owned by requester');
      return conversation;
    },
    async listMessages(input) {
      const conversation = await getOwnedConversation(input.conversationId, input.ownerUserId);
      if (!conversation) throw new ControlPlaneAuthorizationError('conversation is not owned by requester');
      const messages = await listMessages(input.conversationId, input.ownerUserId);
      return messages.map((message) => ({
        role: message.sender_type,
        content: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
      }));
    },
    async appendMessage(input) {
      await writeMessage({
        conversationId: input.conversationId,
        senderType: input.role,
        messageType: 'text',
        content: input.content,
        idempotencyKey: input.idempotencyKey,
      });
    },
  };
}



export function buildControlRuntime(overrides: ControlRuntimeOverrides = {}): ControlRuntime {
  const agentRuntime = overrides.llm
    && overrides.validator
    && overrides.skillLoader
    && overrides.tools
    ? undefined
    : buildRuntime();
  const repository = overrides.repository ?? new ControlPlaneRepository(pool);
  const llm = overrides.llm ?? agentRuntime!.deps.llm;
  const validator = overrides.validator ?? agentRuntime!.deps.validator;
  const skillLoader = overrides.skillLoader ?? agentRuntime!.deps.skillLoader;
  let tools = overrides.tools;
  if (!tools) {
    const adapter = agentRuntime!.deps.toolAdapter;
    if (!(adapter instanceof ToolRouter)) throw new Error('control runtime requires a ToolRouter');
    tools = adapter;
  }
  const artifacts = overrides.artifacts ?? new ControlArtifactStore({
    root: join(process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces', 'current-control'),
    registry: repository,
  });
  const visualAssets = new VisualAssetService({ artifacts });
  const imageAnnotations = new ImageAnnotationService({ assets: visualAssets, artifacts });
  const expectedActualModel = overrides.expectedActualModel
    ?? (overrides.llm
      ? llm.identity.requestedModel
      : process.env.LLM_EXPECTED_ACTUAL_MODEL?.trim());
  if (!expectedActualModel) {
    throw new Error('LLM_EXPECTED_ACTUAL_MODEL is required for the production control runtime');
  }
  // planning 与 deliverable 的 LLM 都经 ReceiptLLMClient 包装:逐次记录模型调用回执,
  // actual≠expected(drift)或回执写库失败时 fail-closed。planning receipt 锚定 actual model pin。
  const planningService = overrides.planning ? null : new ResearchPlanningService({
    llm: new ReceiptLLMClient(llm, repository),
    validator,
    skillLoader,
    tools,
    approvalAuthorities: ['owner'],
    expectedActualModel,
  });
  const planning: PlanningAdapter = overrides.planning ?? {
    async plan(input, onProgress) {
      if (!input.requirement) {
        throw new Error('Current planning requires finalized ResearchTaskV2');
      }
      return planningService!.planCurrentFromRequirement(
        input.requirement,
        input.originalInput,
        onProgress,
      );
    },
  };
  const conversations = overrides.conversations ?? defaultConversations();
  const refinementConversations: ConversationAdapter = {
    requireOwned: (input) => conversations.requireOwned(input),
    async listMessages(input) {
      if (!conversations.listMessages) {
        throw new Error('requirement refinement requires conversation history support');
      }
      return conversations.listMessages(input);
    },
    async appendMessage(input) {
      if (!conversations.appendMessage) {
        throw new Error('requirement refinement requires conversation append support');
      }
      await conversations.appendMessage(input);
    },
  };
  const requirementRefinement = new RequirementRefinementService({
    llm: new ReceiptLLMClient(llm, repository),
    validator,
    repository,
    conversations: refinementConversations,
    planner: planning,
    expectedActualModel,
  });
  const controlPlanning = new ControlPlanningService({
    planning,
    repository,
    conversations,
  });
  const evidence = new EvidenceService();
  const reportValidator: ReportEvidenceValidator = new ReportEvidenceValidator(evidence);
  const reportComposition = new ReportCompositionService({ artifacts, visualAssets, repository });
  const reportPackageReader = new CurrentReportPackageReader({
    artifacts,
    repository,
    evidence,
    reportValidator,
    schemaValidator: validator,
    visualAssets,
  });
  const deliverables = new CurrentDeliverableService({
    llm: new ReceiptLLMClient(llm, repository),
    validator,
    evidence,
    artifacts,
    materializer: new SynthesisMaterializer(artifacts),
  });
  const reportReview = new ReportReviewService({
    llm: new ReceiptLLMClient(llm, repository),
    artifacts,
  });
  const visualInputGates = new VisualInputGateStore(artifacts);
  const engine = new LeaseExecutionEngine({
    repository,
    artifacts,
    tools,
    llm,
    skillLoader,
    validator,
    heartbeatMs: 30_000,
    deliverables,
    reportReview,
    reportComposition,
    visualInputMaterializer: new VisualInputMaterializer({ visualAssets, imageAnnotations }),
    visualInputGates,
  });
  const planRevisionDriver: WorkflowPlanRevisionDriver = {
    async revise(input) {
      const task = await repository.getTaskDetail(input.taskId);
      if (!task || task.activePlanVersionId !== input.activePlanVersionId) {
        throw new Error(`task ${input.taskId} has no matching active plan`);
      }
      validator.validateOrThrow('research-task-v2', task.structuredTask);
      const structuredTask = task.structuredTask as ResearchTaskV2;
      const researchGoal = structuredTask.research_goal.trim();
      if (!researchGoal) throw new Error(`task ${input.taskId} has no research_goal`);

      const activePlan = await repository.getPlanVersionDetail(input.activePlanVersionId);
      if (!activePlan || activePlan.taskId !== task.id) {
        throw new Error(`active plan ${input.activePlanVersionId} does not belong to task ${task.id}`);
      }
      if (activePlan.candidateId !== 'depth' && activePlan.candidateId !== 'speed') {
        throw new Error(`active plan ${activePlan.id} has no depth/speed candidate`);
      }
      const deliverableSelection = resolvePlanningDeliverableSelection(structuredTask);
      if (!await repository.isPlanPendingInputQuarantined(activePlan.id)) {
        assertRevisionSourceContract({ activePlan, deliverableSelection, validator });
      }

      // The revision instruction comes first so an explicit `$skill` remains a
      // valid direct invocation. The frozen ResearchTask still owns the goal.
      const planningResult = await planning.plan({
        originalInput: `${input.instruction.trim()}\n\nOriginal research goal: ${researchGoal}`,
        requirement: structuredTask,
      });
      const candidate = planningResult.candidates.find((item) => item.id === activePlan.candidateId);
      if (!candidate) {
        throw new Error(`revision planning result has no ${activePlan.candidateId} candidate`);
      }
      const compiled = new PlanCompiler(validator).compile({
        candidate,
        task: structuredTask,
        deliverable_selection: deliverableSelection,
        problem_graph: planningResult.problemGraph,
        problem_graph_provenance: planningResult.problemGraphProvenance,
        capability_resolution: planningResult.capabilityResolution,
        evidence_requirements: deliverableSelection.evidenceRequirements,
        activated_nodes: planningResult.activatedNodes,
        requireCompetitiveWeightContract: true,
      });
      return {
        plan: { ...compiled.plan, task_id: task.id },
        pendingInputs: compiled.pending_inputs,
      };
    },
  };
  const workflow = new TaskWorkflowService(repository, {
    execute: ({ lease }) => engine.execute({
      lease,
      expectedModel: expectedActualModel,
    }),
  }, planRevisionDriver, artifacts, visualInputGates);
  const zeroPublicationEnabled = overrides.zeroPublicationEnabled
    ?? process.env.ZERO_PUBLICATION_ENABLED === 'true';
  const zeroPublication = zeroPublicationEnabled
    ? new ZeroPublicationService({
      store: repository,
      artifacts,
      zero: overrides.zeroMcp ?? new LocalZeroMcpClient({
        url: process.env.ZERO_MCP_URL?.trim() || 'http://127.0.0.1:27618/mcp',
      }),
      reportPackages: reportPackageReader,
      readVisualAsset: (input) => visualAssets.readVerified(input),
    })
    : undefined;

  return {
    controlPlanning,
    conversations,
    requirementRefinement,
    workflow,
    repository,
    artifacts,
    ...(zeroPublication ? { zeroPublication } : {}),
    annotateVisualAsset: (input) => imageAnnotations.annotate(input),
    async getDeliverable(taskId, ownerUserId) {
      const task = await repository.getTaskDetail(taskId);
      if (
        !task
        || task.ownerUserId !== ownerUserId
        || task.conversationOwnerUserId !== ownerUserId
        || (task.state !== 'completed' && task.state !== 'completed_with_gaps')
        || !task.activePlanVersionId
        || !task.currentAttemptId
      ) {
        return null;
      }
      return reportPackageReader.read({
        taskId: task.id,
        planVersionId: task.activePlanVersionId,
        attemptId: task.currentAttemptId,
      });
    },
    async readVisualAsset(input) {
      const task = await repository.getTaskDetail(input.taskId);
      if (
        !task
        || task.ownerUserId !== input.ownerUserId
        || task.conversationOwnerUserId !== input.ownerUserId
      ) {
        return null;
      }
      const asset = await repository.getArtifact(input.assetId);
      if (
        !asset
        || asset.taskId !== input.taskId
        || asset.kind !== 'visual_asset'
        || asset.state !== 'SEALED'
        || !asset.planVersionId
        || !asset.attemptId
        || !asset.storageUri.endsWith('.image')
      ) {
        return null;
      }
      const manifestStorageUri = `${asset.storageUri.slice(0, -'.image'.length)}.manifest.json`;
      const candidates = await repository.listArtifactsByStorageUri(manifestStorageUri);
      const manifest = candidates.find((candidate) =>
        candidate.state === 'SEALED'
        && candidate.kind === 'visual_asset_manifest'
        && candidate.taskId === asset.taskId
        && candidate.planVersionId === asset.planVersionId
        && candidate.attemptId === asset.attemptId,
      );
      if (!manifest) return null;
      return visualAssets.readVerified({ assetId: asset.id, manifestArtifactId: manifest.id });
    },
  };
}
