import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pool } from '../../../database/db.ts';
import {
  ControlPlaneAuthorizationError,
  ControlPlaneRepository,
  type ControlArtifact,
} from '../../../database/control-plane.ts';
import { createConversation, getOwnedConversation, listMessages, writeMessage } from '../../../database/repository.ts';
import { ControlArtifactStore } from '../../orchestrator-runtime/src/control/artifact-store.ts';
import { ControlPlanningService } from '../../orchestrator-runtime/src/control/control-planning-service.ts';
import { LeaseExecutionEngine } from '../../orchestrator-runtime/src/control/lease-execution-engine.ts';
import {
  CandidateProfileNoLongerEligibleError,
  TaskWorkflowService,
  type WorkflowPlanRevisionDriver,
} from '../../orchestrator-runtime/src/control/task-workflow.ts';
import { EvidenceService } from '../../orchestrator-runtime/src/evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../../orchestrator-runtime/src/evidence/report-evidence-validator.ts';
import {
  RequirementRefinementService,
  type ConversationAdapter,
  type RequirementPlanner,
} from '../../orchestrator-runtime/src/control/requirement-refinement-service.ts';
import {
  isPlanningGuidanceClarification,
  OrchestrationModePlanningError,
  ResearchPlanningService,
  resolvePlanningDeliverableSelection,
  type CurrentResearchPlanningOutcome,
  type ResearchPlanningInput,
} from '../../orchestrator-runtime/src/planners/research-planning-service.ts';
import { PlanCompiler } from '../../orchestrator-runtime/src/planners/plan-compiler.ts';
import {
  isCandidateProfile,
  type CandidateProfile,
  type PlanCandidate,
  type PlanProgress,
  type ResearchTaskV2,
} from '../../../packages/api-contract/plan.ts';
import type {
  CurrentReportPackageResponse,
  OrchestrationModeV1,
} from '../../../packages/api-contract/control-workflow.ts';
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
import { ReportPackageArtifactService } from '../../orchestrator-runtime/src/report/report-package-artifact.ts';
import { ReportPackageV2ArtifactService } from '../../orchestrator-runtime/src/report/report-package-v2-artifact.ts';
import { ReportPackageV3ArtifactService } from '../../orchestrator-runtime/src/report/report-package-v3-artifact.ts';
import { ReportCompositionService } from '../../orchestrator-runtime/src/report/report-composition-service.ts';
import { EditorialShowcasePublicationService } from '../../orchestrator-runtime/src/report/report-editorial-showcase-publication.ts';
import {
  productionReportEditorialPlannerDataPolicy,
  ReportEditorialPlanner,
} from '../../orchestrator-runtime/src/report/report-editorial-planner.ts';
import { ReportLayoutPlanner } from '../../orchestrator-runtime/src/report/report-layout-planner.ts';
import {
  HtmlBundleIntegrityError,
  HtmlBundleUnavailableError,
  StandaloneHtmlReportPackageService,
} from '../../orchestrator-runtime/src/report/standalone-html-report-package.ts';
import {
  ImageAnnotationService,
  type ImageAnnotationInput,
  type ImageAnnotationResult,
} from '../../orchestrator-runtime/src/report/image-annotation-service.ts';
import {
  VisualAssetService,
  type VerifiedVisualAsset,
} from '../../orchestrator-runtime/src/report/visual-asset-service.ts';
import { createEditorialSummaryPipeline } from '../../orchestrator-runtime/src/editorial-summary-runtime.ts';
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


function revisionCandidate(result: unknown, candidateId: CandidateProfile): PlanCandidate {
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
    input: ResearchPlanningInput & { orchestrationMode: OrchestrationModeV1 },
    onProgress?: (event: PlanProgress) => void,
  ): Promise<CurrentResearchPlanningOutcome>;
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
  planningPolicy?: unknown;
  multiSkillPortfolioMode?: 'inactive' | 'active';
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
  readHtmlBundle(input: {
    taskId: string;
    attemptId: string;
    ownerUserId: string;
  }): Promise<Uint8Array | null>;
  readEditorialSummaryHtml(input: {
    taskId: string;
    attemptId: string;
    ownerUserId: string;
  }): Promise<string | null>;
}

export function visualAssetManifestStorageUri(storageUri: string): string | null {
  for (const suffix of ['.image', '.svg'] as const) {
    if (storageUri.endsWith(suffix)) {
      return `${storageUri.slice(0, -suffix.length)}.manifest.json`;
    }
  }
  return null;
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
  const workspaceRoot = process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';
  const visualAssets = new VisualAssetService({ artifacts });
  const imageAnnotations = new ImageAnnotationService({ assets: visualAssets, artifacts });
  const expectedActualModel = overrides.expectedActualModel
    ?? (overrides.llm
      ? llm.identity.requestedModel
      : process.env.LLM_EXPECTED_ACTUAL_MODEL?.trim());
  if (!expectedActualModel) {
    throw new Error('LLM_EXPECTED_ACTUAL_MODEL is required for the production control runtime');
  }
  const receiptLlm = new ReceiptLLMClient(llm, repository);
  const gatewayBaseUrl = process.env.LLM_GATEWAY_BASE_URL?.trim();
  const endpointUrl = gatewayBaseUrl
    ? `${gatewayBaseUrl.replace(/\/$/u, '')}/chat/completions`
    : undefined;
  const editorialSummary = createEditorialSummaryPipeline({
    repository,
    artifacts,
    workspaceRoot,
    llm: receiptLlm,
    expectedActualModel,
    ...(typeof endpointUrl === 'string' ? { endpointUrl } : {}),
  });
  // planning 与 deliverable 的 LLM 都经 ReceiptLLMClient 包装:逐次记录模型调用回执,
  // actual≠expected(drift)或回执写库失败时 fail-closed。planning receipt 锚定 actual model pin。
  const planningService = overrides.planning ? null : new ResearchPlanningService({
    llm: receiptLlm,
    validator,
    skillLoader,
    tools,
    approvalAuthorities: ['owner'],
    ...(overrides.planningPolicy === undefined ? {} : { planningPolicy: overrides.planningPolicy }),
    multiSkillPortfolioMode: overrides.multiSkillPortfolioMode
      ?? (process.env.MULTI_SKILL_PORTFOLIO_WRITER_ENABLED === 'true' ? 'active' : 'inactive'),
    expectedActualModel,
  });
  const planningSource: PlanningAdapter = overrides.planning ?? {
    async plan(input, onProgress) {
      if (!input.requirement) {
        throw new Error('Current planning requires finalized ResearchTaskV2');
      }
      if (!input.orchestrationMode) {
        throw new OrchestrationModePlanningError('missing');
      }
      return planningService!.planCurrentFromRequirementOutcome(
        input.requirement,
        input.originalInput,
        onProgress,
        {
          orchestrationMode: input.orchestrationMode,
          ...(input.selectedScenarioId
            ? { selectedScenarioId: input.selectedScenarioId }
            : {}),
          ...(input.requireExplicitScenarioSelection
            ? { requireExplicitScenarioSelection: true }
            : {}),
          ...(input.requiredProfileId ? { requiredProfileId: input.requiredProfileId } : {}),
        },
      );
    },
  };
  const planning = {
    async plan(
      input: ResearchPlanningInput & { orchestrationMode: OrchestrationModeV1 },
      onProgress?: (event: PlanProgress) => void,
    ) {
      const result = await planningSource.plan(input, onProgress);
      if (isPlanningGuidanceClarification(result)) {
        throw new Error(`Planning Guidance requires clarification: ${result.planningGuidance.reasonCode}`);
      }
      return result;
    },
  };
  const refinementPlanning: RequirementPlanner = {
    plan(input, onProgress) {
      return planningSource.plan({
        ...input,
        requireExplicitScenarioSelection: true,
      }, onProgress);
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
    planner: refinementPlanning,
    expectedActualModel,
  });
  const controlPlanning = new ControlPlanningService({
    planning,
    repository,
    conversations,
  });
  const evidence = new EvidenceService();
  const reportValidator: ReportEvidenceValidator = new ReportEvidenceValidator(evidence);
  const reportV3WriterEnabled = process.env.REPORT_V3_WRITER_ENABLED === 'true';
  const reportEditorialPlannerV1Enabled = process.env.REPORT_EDITORIAL_PLANNER_V1_ENABLED === 'true';
  const reportEditorialExperienceV1Enabled = process.env.REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED === 'true';
  const reportEditorialShowcaseV1Enabled = process.env.REPORT_EDITORIAL_SHOWCASE_V1_ENABLED === 'true';
  const standaloneHtmlBundleV1Enabled = process.env.STANDALONE_HTML_BUNDLE_V1_ENABLED === 'true';
  const editorialShowcasePublicationEnabled = reportEditorialShowcaseV1Enabled
    && reportEditorialExperienceV1Enabled
    && standaloneHtmlBundleV1Enabled;
  const reportComposition = new ReportCompositionService({
    artifacts,
    visualAssets,
    repository,
    validator,
    layoutPlanner: new ReportLayoutPlanner({
      llm: new ReceiptLLMClient(llm, repository),
      validator,
    }),
    ...(reportEditorialPlannerV1Enabled
      || reportEditorialExperienceV1Enabled
      || editorialShowcasePublicationEnabled
      ? {
          editorialPlanner: new ReportEditorialPlanner({
            llm: new ReceiptLLMClient(llm, repository),
            validator,
            dataPolicy: productionReportEditorialPlannerDataPolicy,
          }),
        }
      : {}),
    ...(editorialShowcasePublicationEnabled
      ? { showcasePublisher: new EditorialShowcasePublicationService({ artifacts, validator }) }
      : {}),
    reportV3Writer: {
      enabled: reportV3WriterEnabled
        || reportEditorialExperienceV1Enabled
        || editorialShowcasePublicationEnabled,
      editorialExperienceV1Enabled: reportEditorialExperienceV1Enabled
        || editorialShowcasePublicationEnabled,
      // The three rich writers stay closed until the required real-case
      // inventory proves their source shapes. A-core still emits lossless v3.
      verifiedPresentations: {
        recordTable: false,
        graph: false,
        priorityBoard: false,
      },
    },
  });
  const reportPackageReader = new CurrentReportPackageReader({
    artifacts,
    repository,
    evidence,
    reportValidator,
    schemaValidator: validator,
    visualAssets,
  });
  const reportPackageArtifacts = new ReportPackageArtifactService(artifacts);
  const reportPackageV2Artifacts = new ReportPackageV2ArtifactService(artifacts);
  const reportPackageV3Artifacts = new ReportPackageV3ArtifactService({
    artifacts,
    canonicalPackages: reportPackageV2Artifacts,
    validator,
  });
  const standaloneHtmlBundles = new StandaloneHtmlReportPackageService({
    artifacts,
    reportPackages: reportPackageV2Artifacts,
  });
  const fixedReportPackageV1Root = async (binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
  }): Promise<ControlArtifact | null> => {
    const candidates = (await repository.listArtifactsForAttempt({
      ...binding,
      kinds: ['report_package'],
    })).filter((artifact) => (
      artifact.state === 'SEALED'
      && artifact.schemaVersion === 'report-package-v1'
      && artifact.storageUri.endsWith('/reports/report-package.json')
    ));
    if (candidates.length > 1) throw new HtmlBundleIntegrityError();
    return candidates[0] ?? null;
  };
  const fixedReportPackageV2Root = async (binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
  }): Promise<ControlArtifact | null> => {
    const candidates = (await repository.listArtifactsForAttempt({
      ...binding,
      kinds: ['report_package'],
    })).filter((artifact) => (
      artifact.state === 'SEALED'
      && artifact.schemaVersion === 'report-package-v2'
      && artifact.storageUri.endsWith('/reports/report-package.json')
    ));
    if (candidates.length > 1) {
      throw new HtmlBundleIntegrityError();
    }
    return candidates[0] ?? null;
  };
  const fixedReportPackageRoot = async (binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
  }): Promise<ControlArtifact | null> => {
    const candidates = (await repository.listArtifactsForAttempt({
      ...binding,
      kinds: ['report_package'],
    })).filter((artifact) => (
      artifact.state === 'SEALED'
      && artifact.schemaVersion === 'report-package-v3'
      && artifact.storageUri.endsWith('/reports/report-package-v3.json')
    ));
    if (candidates.length > 1) throw new HtmlBundleIntegrityError();
    return candidates[0]
      ?? await fixedReportPackageV2Root(binding)
      ?? await fixedReportPackageV1Root(binding);
  };
  const readFrozenReportPackage = async (input: {
    artifact: ControlArtifact;
    taskId: string;
    planVersionId: string;
    attemptId: string;
    expectedContentSha256?: string;
  }): Promise<CurrentReportPackageResponse | null> => {
    const actualHash = input.artifact.contentSha256;
    if (!actualHash || (
      input.expectedContentSha256 !== undefined
      && actualHash !== input.expectedContentSha256
    )) {
      throw new Error('frozen Report Package hash is invalid');
    }
    const binding = {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
    };
    if (input.artifact.schemaVersion === 'report-package-v1') {
      const frozen = await reportPackageArtifacts.verify({
        artifactId: input.artifact.id,
        attemptId: input.attemptId,
      });
      return reportPackageReader.read(binding, frozen.value);
    }
    if (input.artifact.schemaVersion === 'report-package-v2') {
      return reportPackageReader.read(binding, {
        artifactId: input.artifact.id,
        contentSha256: actualHash,
      });
    }
    if (input.artifact.schemaVersion === 'report-package-v3') {
      const frozen = await reportPackageV3Artifacts.verify({
        artifactId: input.artifact.id,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
      });
      const canonical = await reportPackageReader.read(binding, {
        artifactId: frozen.value.canonicalPackageArtifactId,
        contentSha256: frozen.value.canonicalPackageContentSha256,
      });
      if (!canonical || canonical.presentationMode !== 'multimodal') {
        throw new Error('Report Package v3 canonical report is unavailable');
      }
      return {
        ...canonical,
        editorialShowcase: frozen.value,
      };
    }
    throw new Error(`Report Package schema version ${input.artifact.schemaVersion} is unsupported`);
  };
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
    reportEditorialExperienceV1Enabled,
    standaloneHtmlBundleV1Enabled,
    visualInputMaterializer: new VisualInputMaterializer({ visualAssets, imageAnnotations }),
    visualInputGates,
  });
  const planRevisionDriver: WorkflowPlanRevisionDriver = {
    async revise(input) {
      const task = await repository.getTaskDetail(input.taskId);
      if (!task || task.activePlanVersionId !== input.activePlanVersionId) {
        throw new Error(`task ${input.taskId} has no matching active plan`);
      }
      if (!task.orchestrationMode) {
        throw new OrchestrationModePlanningError('missing');
      }
      validator.validateOrThrow('research-task-v2', task.structuredTask);
      const structuredTask = task.structuredTask as ResearchTaskV2;
      const researchGoal = structuredTask.research_goal.trim();
      if (!researchGoal) throw new Error(`task ${input.taskId} has no research_goal`);

      const activePlan = await repository.getPlanVersionDetail(input.activePlanVersionId);
      if (!activePlan || activePlan.taskId !== task.id) {
        throw new Error(`active plan ${input.activePlanVersionId} does not belong to task ${task.id}`);
      }
      if (!isCandidateProfile(activePlan.candidateId)) {
        throw new Error(`active plan ${activePlan.id} has no controlled candidate profile`);
      }
      const deliverableSelection = resolvePlanningDeliverableSelection(structuredTask);
      if (!await repository.isPlanPendingInputQuarantined(activePlan.id)) {
        assertRevisionSourceContract({ activePlan, deliverableSelection, validator });
      }

      // The revision instruction comes first so an explicit `$skill` remains a
      // valid direct invocation. The frozen ResearchTask still owns the goal.
      const frozenPlan = activePlan.plan as {
        planning_provenance?: {
          classification_method?: unknown;
          primary_scenario_id?: unknown;
        };
      };
      const classificationMethod = frozenPlan.planning_provenance?.classification_method;
      const primaryScenarioId = frozenPlan.planning_provenance?.primary_scenario_id;
      const hasConfirmedScenario = classificationMethod === 'clarification'
        || classificationMethod === 'direct_skill_bypass';
      const activeScenarioId = hasConfirmedScenario && typeof primaryScenarioId === 'string'
        ? primaryScenarioId as NonNullable<ResearchPlanningInput['selectedScenarioId']>
        : undefined;
      const planningResult = await planning.plan({
        originalInput: `${input.instruction.trim()}\n\nOriginal research goal: ${researchGoal}`,
        requirement: structuredTask,
        orchestrationMode: task.orchestrationMode,
        ...(activeScenarioId ? { selectedScenarioId: activeScenarioId } : {}),
        requiredProfileId: activePlan.candidateId,
      });
      const candidate = planningResult.candidates.find((item) => item.id === activePlan.candidateId);
      if (!candidate) {
        throw new CandidateProfileNoLongerEligibleError(activePlan.candidateId);
      }
      const portfolio = planningResult.portfolios?.[candidate.id];
      const compiler = new PlanCompiler(validator);
      const compiled = planningResult.capabilityDemandGraph && portfolio
        ? compiler.compilePortfolio({
            candidate,
            task: structuredTask,
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
        : compiler.compile({
            candidate,
            task: structuredTask,
            deliverable_selection: deliverableSelection,
            problem_graph: planningResult.problemGraph,
            problem_graph_provenance: planningResult.problemGraphProvenance,
            capability_resolution: planningResult.capabilityResolution,
            evidence_requirements: deliverableSelection.evidenceRequirements,
            activated_nodes: planningResult.activatedNodes,
            planning_provenance: planningResult.planningProvenance,
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
      reportPackages: {
        async read(input) {
          const packageArtifact = await repository.getArtifact(input.reportPackageArtifactId);
          if (
            !packageArtifact
            || packageArtifact.taskId !== input.taskId
            || packageArtifact.planVersionId !== input.planVersionId
            || packageArtifact.attemptId !== input.attemptId
          ) {
            throw new Error('frozen Report Package identity is invalid');
          }
          return readFrozenReportPackage({
            artifact: packageArtifact,
            taskId: input.taskId,
            planVersionId: input.planVersionId,
            attemptId: input.attemptId,
            expectedContentSha256: input.reportPackageHash,
          });
        },
      },
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
      const binding = {
        taskId: task.id,
        planVersionId: task.activePlanVersionId,
        attemptId: task.currentAttemptId,
      };
      const packageArtifact = await fixedReportPackageRoot(binding);
      if (packageArtifact) {
        return readFrozenReportPackage({
          artifact: packageArtifact,
          taskId: binding.taskId,
          planVersionId: binding.planVersionId,
          attemptId: task.currentAttemptId,
        });
      }
      return reportPackageReader.read(binding);
    },
    async readHtmlBundle(input) {
      const task = await repository.getTaskDetail(input.taskId);
      if (
        !task
        || task.ownerUserId !== input.ownerUserId
        || task.conversationOwnerUserId !== input.ownerUserId
        || (task.state !== 'completed' && task.state !== 'completed_with_gaps')
        || !task.activePlanVersionId
        || task.currentAttemptId !== input.attemptId
      ) {
        return null;
      }
      const packageArtifact = await fixedReportPackageV2Root({
        taskId: task.id,
        planVersionId: task.activePlanVersionId,
        attemptId: input.attemptId,
      });
      if (!packageArtifact) {
        throw new HtmlBundleUnavailableError();
      }
      return standaloneHtmlBundles.create({
        taskId: task.id,
        planVersionId: task.activePlanVersionId,
        attemptId: input.attemptId,
        reportPackageArtifactId: packageArtifact.id,
      });
    },
    async readEditorialSummaryHtml(input) {
      const task = await repository.getTaskDetail(input.taskId);
      if (
        !task
        || task.ownerUserId !== input.ownerUserId
        || task.conversationOwnerUserId !== input.ownerUserId
        || (task.state !== 'completed' && task.state !== 'completed_with_gaps')
        || !task.activePlanVersionId
        || task.currentAttemptId !== input.attemptId
      ) {
        return null;
      }
      const publication = await editorialSummary.generate({ taskId: task.id });
      return readFile(publication.reportPath, 'utf8');
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
      const manifestStorageUri = asset
        ? visualAssetManifestStorageUri(asset.storageUri)
        : null;
      if (
        !asset
        || asset.taskId !== input.taskId
        || asset.kind !== 'visual_asset'
        || asset.state !== 'SEALED'
        || !asset.planVersionId
        || !asset.attemptId
        || manifestStorageUri === null
      ) {
        return null;
      }
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
