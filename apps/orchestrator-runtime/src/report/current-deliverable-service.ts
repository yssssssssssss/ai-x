import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  EvidenceEntry,
  CurrentExecutionPlan,
  ResearchDeliverableEnvelope,
  ProblemGraph,
  ResearchStrategyReportPayload,
  ResearchStrategyReportPayloadV2,
  ResearchStrategyContentDraftV2,
  ResearchStrategyContentPatchOperationV1,
  ResearchStrategyContentPatchV1,
  ResearchStrategyRiskDisclosure,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type {
  EvidenceArtifactResolver,
  EvidenceManifest,
  EvidenceService,
} from '../evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../evidence/report-evidence-validator.ts';
import {
  type MaterializeStepOutput,
  type SynthesisMaterial,
  type SynthesisMaterializerLike,
} from './synthesis-materializer.ts';
import { redactSensitiveValue, redactString } from '../runtime/redaction.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';
import {
  assertValidReportReviewArtifact,
  type ReportReviewArtifact,
} from './report-review-service.ts';
import {
  resolveDeliverableContractById,
  resolveExecutionDeliverableContract,
} from './deliverable-registry.ts';
import { sameBrowserSourceUrl } from '../runtime/public-web-access-policy.ts';
import type { VerifiedVisualAnnotationBinding } from './report-composition-service.ts';
import type { VerifiedVisualAsset } from './visual-asset-service.ts';
import {
  assembleResearchStrategyDeliverable,
  extractResearchStrategyContentDraft,
  isResearchStrategyPayloadV2,
  researchStrategyContentDraftFromPayload,
  ResearchStrategyAssemblyError,
} from './research-strategy-deliverable-assembler.ts';
import { createDeliverableValidationDiagnostic } from './deliverable-validation-diagnostic.ts';
import { createContentFidelityDiagnostic } from './content-fidelity-diagnostic.ts';
import {
  assertSemanticRevisionFidelity,
  assertStructuralRepairFidelity,
  canonicalResearchStrategyDraftForFidelity,
  compareResearchStrategyContentFidelity,
  ResearchStrategyContentFidelityError,
  type ResearchStrategyContentFidelityResult,
} from './research-strategy-content-fidelity.ts';
import { applyResearchStrategyContentPatch } from './research-strategy-content-patch.ts';
import {
  canonicalizeRequestedArtifactBindings,
  validateResearchStrategyAnswer,
} from './answer-quality-validator.ts';
function researchStrategyPatchSchema(): object {
  return JSON.parse(readFileSync(
    join(getConfigRoot(), 'schemas/skills/research-strategy-content-patch-v1.schema.json'),
    'utf8',
  )) as object;
}

function patchOperationAudit(operation: ResearchStrategyContentPatchOperationV1): string {
  const target = operation.op === 'replace_direct_answer_binding' ? operation.questionId
    : operation.op === 'replace_support' ? JSON.stringify(operation.target)
      : operation.op === 'replace_semantic_text' ? JSON.stringify(operation.target)
        : operation.op === 'append_block_item' ? operation.blockKey
          : operation.op === 'append_content_block' ? operation.block.key
            : operation.op === 'append_direct_answer' ? operation.answer.questionId
              : operation.op === 'append_limitation' ? 'limitations'
                : 'openQuestions';
  const reviewIssueId = 'reviewIssueId' in operation && operation.reviewIssueId
    ? `:${operation.reviewIssueId}`
    : '';
  const reason = 'reason' in operation && operation.reason
    ? `:${redactString(operation.reason).slice(0, 160)}`
    : '';
  return `${operation.op}:${target}${reviewIssueId}${reason}`;
}

function createDeliverableDraftSchema(payloadSchema: object, strictContract: boolean) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'methodSummary',
      'findingGraph',
      'payload',
      'recommendations',
      ...(strictContract ? ['coverage'] : []),
    ],
  properties: {
    methodSummary: { type: 'string', minLength: 1 },
    findingGraph: {
      type: 'object',
      additionalProperties: false,
      required: ['findings', 'analyses', 'subQuestionSummaries', 'overallConclusions'],
      properties: {
        findings: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [{
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'evidenceIds', 'statement'],
              properties: {
                id: { type: 'string', minLength: 1 },
                kind: { const: 'fact' },
                evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 } },
                statement: { type: 'string', minLength: 1 },
              },
            }, {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'findingIds', 'statement'],
              properties: {
                id: { type: 'string', minLength: 1 },
                kind: { const: 'inference' },
                findingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
                statement: { type: 'string', minLength: 1 },
              },
            }],
          },
        },
        analyses: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'findingIds', 'statement'],
            properties: {
              id: { type: 'string', minLength: 1 },
              findingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
              statement: { type: 'string', minLength: 1 },
            },
          },
        },
        subQuestionSummaries: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'findingIds', 'analysisIds', 'summary'],
            properties: {
              id: { type: 'string', minLength: 1 },
              findingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
              analysisIds: { type: 'array', items: { type: 'string', minLength: 1 } },
              summary: { type: 'string', minLength: 1 },
            },
          },
        },
        overallConclusions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'summaryIds', 'statement'],
            properties: {
              id: { type: 'string', minLength: 1 },
              summaryIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
              statement: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
    payload: strictContract ? payloadSchema : {},
    recommendations: {
      minItems: 1,
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'summaryIds', 'statement'],
        properties: {
          id: { type: 'string', minLength: 1 },
          summaryIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          statement: { type: 'string', minLength: 1 },
        },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['questionBindings', 'successCriterionBindings'],
      properties: {
        questionBindings: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['questionId', 'summaryIds'],
            properties: {
              questionId: { type: 'string', minLength: 1 },
              summaryIds: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        successCriterionBindings: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['successCriterionId', 'conclusionIds', 'recommendationIds'],
            properties: {
              successCriterionId: { type: 'string', minLength: 1 },
              conclusionIds: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
              },
              recommendationIds: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
    risksAndOpenIssues: { type: 'array', items: { type: 'string' } },
  },
  } as const;
}

type DeliverableEnvelope = ResearchDeliverableEnvelope<unknown>;
type DeliverableDraft = Pick<
  DeliverableEnvelope,
  | 'methodSummary'
  | 'findingGraph'
  | 'payload'
  | 'recommendations'
  | 'coverage'
> & {
  risksAndOpenIssues?: string[];
};

interface StructuredLlm {
  generateStructured<T>(input: {
    prompt: string;
    schema: object;
    schemaName: string;
    context?: object;
    receipt: {
      stage: string;
      attemptId?: string;
      stepNo?: number;
      expectedModel?: string;
    };
  }): Promise<{ data: T }>;
}

interface PayloadValidator {
  validateFileOrThrow(path: string, value: unknown): void;
  validateSchemaOrThrow(schema: object, value: unknown, label: string): void;
}

interface ArtifactWriter {
  writeJson(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    kind: string;
    relativePath: string;
    value: unknown;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
    activeLease?: ControlExecutionLease;
  }): Promise<{ id: string }>;
}

interface SealedEvidenceManifest {
  artifact: {
    id: string;
    contentSha256: string;
    state: 'SEALED';
  };
  value: EvidenceManifest;
}

export interface ReviewedStrategyDraftPreviewV1 {
  version: 'reviewed-strategy-draft-preview-v1';
  canonical: false;
  exportAllowed: false;
  title: string;
  executiveAnswer: string;
  directAnswers: Array<{
    questionId: string;
    question: string;
    answer: string;
    answerStatus: string;
  }>;
  contentBlocks: Array<{
    key: string;
    kind: string;
    title: string;
    itemCount: number;
  }>;
  evidenceFindingCount: number;
  limitationCount: number;
  openQuestionCount: number;
}

function boundedPreviewText(value: string, maxLength: number): string {
  return redactString(value).replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

function reviewedDraftPreview(draft: ResearchStrategyContentDraftV2): ReviewedStrategyDraftPreviewV1 {
  const itemCount = (block: ResearchStrategyContentDraftV2['contentBlocks'][number]): number => {
    if (block.kind === 'narrative') return 1;
    if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') return block.cells.length;
    if (block.kind === 'mind_model') return block.nodes.length + block.edges.length;
    if ('items' in block) return block.items.length;
    return 0;
  };
  return {
    version: 'reviewed-strategy-draft-preview-v1',
    canonical: false,
    exportAllowed: false,
    title: boundedPreviewText(draft.title, 240),
    executiveAnswer: boundedPreviewText(draft.executiveAnswer, 1_200),
    directAnswers: draft.directAnswers.map((answer) => ({
      questionId: answer.questionId,
      question: boundedPreviewText(answer.question, 300),
      answer: boundedPreviewText(answer.answer, 1_200),
      answerStatus: answer.answerStatus,
    })),
    contentBlocks: draft.contentBlocks.map((block) => ({
      key: block.key,
      kind: block.kind,
      title: boundedPreviewText(block.title, 240),
      itemCount: itemCount(block),
    })),
    evidenceFindingCount: draft.evidenceFindings.length,
    limitationCount: draft.limitations.length,
    openQuestionCount: draft.openQuestions.length,
  };
}

export class ResearchStrategyDeliverableValidationError extends Error {
  readonly draftPreview: ReviewedStrategyDraftPreviewV1;

  constructor(error: unknown, draft: ResearchStrategyContentDraftV2) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'ResearchStrategyDeliverableValidationError';
    this.draftPreview = reviewedDraftPreview(draft);
  }
}

export interface CurrentDeliverableGenerateInput {
  task: { id: string };
  plan: {
    id: string;
    plan: Pick<CurrentExecutionPlan, 'deliverable_type'> & {
      steps?: unknown[];
      capability_decisions?: unknown;
      capability_gaps?: unknown;
    };
  };
  attempt: { id: string };
  researchGoal: string;
  finalizedRequirement: unknown;
  problemGraph: unknown;
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
  outputs: unknown[];
  gaps: string[];
  gapRefs?: ReadonlyArray<{ key: string; stepNo: number }>;
  expectedModel: string;
  stepNo?: number;
  revisionInstruction?: string;
  revisionRound?: 0 | 1;
  activeLease?: ControlExecutionLease;
  visualAssets?: readonly VerifiedVisualAsset[];
  visualAnnotationBindings?: readonly VerifiedVisualAnnotationBinding[];
  strategyDraftOverride?: ResearchStrategyContentDraftV2;
  strategyFidelity?: {
    mode: 'structural_repair' | 'semantic_revision';
    sourceDraft: ResearchStrategyContentDraftV2;
    result: ResearchStrategyContentFidelityResult;
    repairOperations: string[];
  };
}

export interface CurrentDeliverableGenerateResult {
  deliverable: DeliverableEnvelope;
  deliverableArtifactId: string;
}

export interface CurrentDeliverableRevisionInput extends CurrentDeliverableGenerateInput {
  review: ReportReviewArtifact;
  reviewArtifactId: string;
  currentDeliverable?: ResearchDeliverableEnvelope<unknown>;
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const PLAYWRIGHT_CAPTURE_TOOL_ID = 'playwright-page-capture';
const PLAYWRIGHT_PAGE_FAILURE_CODES = new Set([
  'login_required',
  'captcha_required',
  'paywall',
  'robots_or_terms_blocked',
  'navigation_timeout',
  'no_capture_target',
  'unsupported_content',
]);
const OPTIONAL_TOOL_GAP_FAILURE_KINDS = new Set([
  'capacity',
  'rate_limit',
  'server',
  'timeout',
  'network',
  'quota',
  'authentication',
  'configuration',
  'capability',
  'unknown',
]);

interface FrozenPlaywrightDecision {
  status: 'available' | 'unavailable';
  reasonCode?: string;
}

function isPlaywrightExecutionGapKey(key: unknown, stepNo: number): boolean {
  if (typeof key !== 'string') return false;
  const [scope, encodedStepNo, target, code, ...extra] = key.split(':');
  if (
    extra.length > 0
    || scope !== 'step'
    || encodedStepNo !== String(stepNo)
    || typeof code !== 'string'
  ) return false;
  if (target === 'step') return OPTIONAL_TOOL_GAP_FAILURE_KINDS.has(code);
  const sourceResultIndex = Number(target);
  return Number.isSafeInteger(sourceResultIndex)
    && sourceResultIndex >= 0
    && target === String(sourceResultIndex)
    && PLAYWRIGHT_PAGE_FAILURE_CODES.has(code);
}

function frozenPlaywrightDecision(
  plan: CurrentDeliverableGenerateInput['plan']['plan'],
): FrozenPlaywrightDecision | undefined {
  const decisions = unknownRecord(plan.capability_decisions);
  if (!decisions) return undefined;
  if (!Array.isArray(decisions.eligible)) {
    throw new Error('frozen capability decisions are malformed');
  }
  const matches: FrozenPlaywrightDecision[] = [];
  for (const candidate of decisions.eligible) {
    const decision = unknownRecord(candidate);
    if (!decision) throw new Error('frozen capability decision is malformed');
    const optionalDecisions = decision.optional_tool_decisions;
    if (optionalDecisions === undefined) continue;
    if (!Array.isArray(optionalDecisions)) {
      throw new Error('frozen optional Tool decisions are malformed');
    }
    for (const optionalCandidate of optionalDecisions) {
      const optionalDecision = unknownRecord(optionalCandidate);
      if (optionalDecision?.tool_id !== PLAYWRIGHT_CAPTURE_TOOL_ID) continue;
      if (optionalDecision.status !== 'available' && optionalDecision.status !== 'unavailable') {
        throw new Error('frozen Playwright decision has an invalid status');
      }
      const reasonCode = optionalDecision.reason_code;
      if (
        optionalDecision.status === 'unavailable'
        && (typeof reasonCode !== 'string' || !reasonCode.trim())
      ) {
        throw new Error('frozen unavailable Playwright decision has no reason code');
      }
      matches.push({
        status: optionalDecision.status,
        ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
      });
    }
  }
  if (matches.length > 1) throw new Error('frozen Playwright decision is duplicated');
  return matches[0];
}

function hasFrozenPlaywrightGap(
  plan: CurrentDeliverableGenerateInput['plan']['plan'],
  gapRefs: CurrentDeliverableGenerateInput['gapRefs'],
  decision: FrozenPlaywrightDecision,
): boolean {
  const refs = gapRefs ?? [];
  if (decision.status === 'unavailable') {
    return refs.some(({ key, stepNo }) => (
      stepNo === 0
      && key === `capability:${PLAYWRIGHT_CAPTURE_TOOL_ID}:${decision.reasonCode}`
    ));
  }
  const playwrightStepNos = new Set((plan.steps ?? []).flatMap((candidate) => {
    const step = unknownRecord(candidate);
    return step?.actor_id === PLAYWRIGHT_CAPTURE_TOOL_ID
      && typeof step.step_no === 'number'
      && Number.isInteger(step.step_no)
      ? [step.step_no]
      : [];
  }));
  return refs.some(({ key, stepNo }) => (
    playwrightStepNos.has(stepNo)
    && isPlaywrightExecutionGapKey(key, stepNo)
  ));
}

function assertCompetitiveVisualAvailability(
  deliverableId: string,
  plan: CurrentDeliverableGenerateInput['plan']['plan'],
  gapRefs: CurrentDeliverableGenerateInput['gapRefs'],
  inventory: VerifiedVisualInventory | undefined,
  displayableInventory: readonly DisplayableVisualInventoryItem[],
): void {
  if (deliverableId !== 'competitive_analysis_report') return;
  const displayableAssetIds = new Set(
    displayableInventory.map(({ asset }) => asset.artifact.id),
  );
  const unboundBrowserAsset = inventory?.assets.find((asset) => (
    inventory.roles.get(asset.artifact.id) === 'original'
    && asset.manifest.source.kind === 'browser_capture'
    && !displayableAssetIds.has(asset.artifact.id)
  ));
  if (unboundBrowserAsset) {
    throw new Error(
      `competitive browser Asset ${unboundBrowserAsset.artifact.id} requires screenshot and matching public-source Evidence`,
    );
  }
  if (displayableInventory.length > 0) return;
  const decision = frozenPlaywrightDecision(plan);
  if (!decision) return;
  if (!hasFrozenPlaywrightGap(plan, gapRefs, decision)) {
    throw new Error('frozen Playwright execution produced no displayable visual and no structured visual gap');
  }
}

function projectPayloadToSchema(payload: unknown, schema: object): unknown {
  const value = unknownRecord(payload);
  const schemaProperties = unknownRecord(unknownRecord(schema)?.properties);
  if (!value || !schemaProperties) return payload;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => Object.hasOwn(schemaProperties, key)),
  );
}

const REQUIRED_DRAFT_KEYS = ['methodSummary', 'findingGraph', 'payload', 'recommendations', 'coverage'] as const;
const MAX_DRAFT_UNWRAP_DEPTH = 8;
const MAX_DRAFT_UNWRAP_NODES = 256;
const MAX_DRAFT_JSON_LENGTH = 1_000_000;

function parsedJsonContainer(value: string): object | null {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_DRAFT_JSON_LENGTH) return null;
  const looksLikeContainer = (
    (candidate.startsWith('{') && candidate.endsWith('}'))
    || (candidate.startsWith('[') && candidate.endsWith(']'))
  );
  if (!looksLikeContainer) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function deliverableDraftRecord(value: unknown): Record<string, unknown> | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  for (let index = 0; index < queue.length && index < MAX_DRAFT_UNWRAP_NODES; index += 1) {
    const current = queue[index]!;
    const candidate = typeof current.value === 'string'
      ? parsedJsonContainer(current.value)
      : current.value;
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    const record = unknownRecord(candidate);
    if (record && REQUIRED_DRAFT_KEYS.every((key) => Object.hasOwn(record, key))) return record;
    if (current.depth >= MAX_DRAFT_UNWRAP_DEPTH) continue;
    const children = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (const child of children) {
      if (queue.length >= MAX_DRAFT_UNWRAP_NODES) break;
      queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return null;
}
function deliverableSelection(
  finalizedRequirement: unknown,
  persistedDeliverableId: string,
): {
  taskType: string;
  expectedDeliverables: string[];
} | null {
  const requirement = unknownRecord(finalizedRequirement);
  if (requirement?.version !== 'research-task-v2') {
    const taskType = requirement?.task_type;
    return typeof taskType === 'string' && taskType.trim()
      ? { taskType, expectedDeliverables: [persistedDeliverableId] }
      : null;
  }
  const taskType = requirement.task_type;
  const expectedDeliverables = requirement.expected_deliverables;
  if (typeof taskType !== 'string' || !taskType.trim()) {
    throw new Error('finalized requirement task_type is required for deliverable resolution');
  }
  if (
    !Array.isArray(expectedDeliverables)
    || !expectedDeliverables.every(
      (deliverable) => typeof deliverable === 'string' && deliverable.trim().length > 0,
    )
  ) {
    throw new Error('finalized requirement expected_deliverables are required for deliverable resolution');
  }
  return {
    taskType,
    expectedDeliverables: [...expectedDeliverables] as string[],
  };
}
type VisualAssetRole = 'original' | 'annotation';
interface VerifiedVisualInventory {
  assets: readonly VerifiedVisualAsset[];
  ids: readonly string[];
  roles: ReadonlyMap<string, VisualAssetRole>;
  annotationBindings: ReadonlyMap<string, VerifiedVisualAnnotationBinding>;
}

interface DisplayableVisualInventoryItem {
  asset: VerifiedVisualAsset;
  screenshotEvidenceIds: readonly string[];
  publicSourceEvidenceIds: readonly string[];
}

interface CompetitiveMatrixContract {
  sampleIds: readonly string[];
  dimensions: readonly string[];
}

function competitiveMatrixContract(
  materials: readonly SynthesisMaterial[],
  plan: CurrentDeliverableGenerateInput['plan']['plan'],
): CompetitiveMatrixContract | undefined {
  let best: CompetitiveMatrixContract | undefined;
  for (const material of materials) {
    const root = unknownRecord(material.value);
    const payload = unknownRecord(root?.payload) ?? root;
    const cases = Array.isArray(payload?.case_universe) ? payload.case_universe : [];
    const sampleIds = cases.flatMap((candidate) => {
      const value = unknownRecord(candidate)?.case_id;
      return typeof value === 'string' && value.trim().length > 0 ? [value] : [];
    });
    const scoringSystem = unknownRecord(payload?.scoring_system);
    const weights = Array.isArray(scoringSystem?.weights_ordered)
      ? scoringSystem.weights_ordered
      : [];
    const dimensions = weights.flatMap((candidate) => {
      const value = unknownRecord(candidate)?.dimension;
      return typeof value === 'string' && value.trim().length > 0 ? [value] : [];
    });
    if (sampleIds.length > 0 && dimensions.length > 0) {
      const candidate = {
        sampleIds: [...new Set(sampleIds)],
        dimensions: [...new Set(dimensions)],
      };
      if (!best || candidate.sampleIds.length > best.sampleIds.length) best = candidate;
    }
  }

  const planDimensions = (plan.steps ?? []).flatMap((candidate) => {
    const step = unknownRecord(candidate);
    const weights = step && unknownRecord(step.input)?.scoring_weights;
    return Array.isArray(weights)
      ? weights.flatMap((weight) => {
          const dimension = unknownRecord(weight)?.dimension;
          return typeof dimension === 'string' && dimension.trim().length > 0 ? [dimension] : [];
        })
      : [];
  });
  if (planDimensions.length > 0) {
    const dimensions = [...new Set(planDimensions)];
    best = best
      ? { ...best, dimensions: [...new Set([...best.dimensions, ...dimensions])] }
      : { sampleIds: [], dimensions };
  }
  return best;
}

function sameVisualReference(
  reference: VerifiedVisualAsset['manifest']['derivedFrom'],
  original: VerifiedVisualAsset,
): boolean {
  return reference !== null
    && reference !== undefined
    && reference.assetId === original.artifact.id
    && reference.manifestArtifactId === original.manifestArtifact.id
    && reference.contentSha256 === original.manifest.contentSha256
    && reference.manifestHash === original.manifest.manifestHash;
}

function classifyVisualAsset(asset: VerifiedVisualAsset): VisualAssetRole {
  const { manifest } = asset;
  if (
    manifest.derivedFrom === null
    && manifest.derivation === null
    && (
      manifest.source.kind === 'user_upload'
      || manifest.source.kind === 'tool_artifact'
      || manifest.source.kind === 'browser_capture'
    )
  ) return 'original';
  if (
    manifest.source.kind === 'derived'
    && manifest.derivation?.kind === 'annotation'
    && manifest.derivedFrom !== null
  ) return 'annotation';
  throw new Error(`visual Asset ${asset.artifact.id} has an unsupported visual source or role`);
}

function verifiedVisualInventory(input: CurrentDeliverableGenerateInput): VerifiedVisualInventory | undefined {
  if (input.visualAssets === undefined) return undefined;
  const roles = new Map<string, VisualAssetRole>();
  const annotationBindings = new Map<string, VerifiedVisualAnnotationBinding>();
  for (const binding of input.visualAnnotationBindings ?? []) {
    if (
      !binding.assetId.trim()
      || !binding.originalAssetId.trim()
      || !binding.overlayArtifactId.trim()
      || binding.findingIds.length === 0
      || binding.findingIds.some((findingId) => !findingId.trim())
      || new Set(binding.findingIds).size !== binding.findingIds.length
      || annotationBindings.has(binding.assetId)
    ) {
      throw new Error('verified visual annotation binding is malformed or duplicated');
    }
    annotationBindings.set(binding.assetId, structuredClone(binding));
  }
  for (const asset of input.visualAssets) {
    const bindingMatches = asset.artifact.taskId === input.task.id
      && asset.artifact.planVersionId === input.plan.id
      && asset.artifact.attemptId === input.attempt.id
      && asset.manifestArtifact.taskId === input.task.id
      && asset.manifestArtifact.planVersionId === input.plan.id
      && asset.manifestArtifact.attemptId === input.attempt.id
      && asset.manifest.taskId === input.task.id
      && asset.manifest.planVersionId === input.plan.id
      && asset.manifest.attemptId === input.attempt.id;
    if (!bindingMatches) {
      throw new Error(`visual Asset ${asset.artifact.id} binding is foreign to the Task, Plan, or Attempt`);
    }
    if (
      asset.artifact.state !== 'SEALED'
      || asset.manifestArtifact.state !== 'SEALED'
      || asset.artifact.kind !== 'visual_asset'
      || asset.manifestArtifact.kind !== 'visual_asset_manifest'
      || (
        asset.manifestArtifact.schemaVersion !== 'visual-asset-manifest-v1'
        && asset.manifestArtifact.schemaVersion !== 'visual-asset-manifest-v2'
      )
      || asset.manifestArtifact.schemaVersion !== asset.manifest.version
      || asset.artifact.id !== asset.manifest.assetId
      || (asset.manifest.exportPolicy !== 'allow' && asset.manifest.exportPolicy !== 'mask')
    ) {
      throw new Error(`visual Asset ${asset.artifact.id} is not an exact sealed exportable verified inventory item`);
    }
    if (roles.has(asset.artifact.id)) {
      throw new Error(`verified visual Asset inventory contains duplicate id ${asset.artifact.id}`);
    }
    roles.set(asset.artifact.id, classifyVisualAsset(asset));
  }
  const assets = [...input.visualAssets];
  const originals = assets.filter((asset) => roles.get(asset.artifact.id) === 'original');
  for (const annotation of assets.filter((asset) => roles.get(asset.artifact.id) === 'annotation')) {
    const original = originals.find((candidate) => sameVisualReference(annotation.manifest.derivedFrom, candidate));
    const binding = annotationBindings.get(annotation.artifact.id);
    if (!original) {
      throw new Error(`visual Asset ${annotation.artifact.id} annotation lineage does not reference an exact verified original`);
    }
    if (binding && binding.originalAssetId !== original.artifact.id) {
      throw new Error(`visual Asset ${annotation.artifact.id} finding binding references a foreign original`);
    }
  }
  for (const binding of annotationBindings.values()) {
    if (roles.get(binding.assetId) !== 'annotation') {
      throw new Error(`visual annotation binding ${binding.assetId} does not reference an annotation Asset`);
    }
  }
  return {
    assets,
    ids: assets.map((asset) => asset.artifact.id).sort((left, right) => left.localeCompare(right)),
    roles,
    annotationBindings,
  };
}

function displayableVisualInventory(
  inventory: VerifiedVisualInventory | undefined,
  evidenceEntries: readonly EvidenceEntry[],
): DisplayableVisualInventoryItem[] {
  if (!inventory) return [];
  return inventory.assets.flatMap((asset) => {
    const source = asset.manifest.source;
    if (
      inventory.roles.get(asset.artifact.id) !== 'original'
      || source.kind !== 'browser_capture'
    ) return [];
    const screenshotEvidenceIds = evidenceEntries.flatMap((entry) => (
      entry.kind === 'screenshot'
      && entry.evidenceClass === 'screenshot'
      && entry.artifactId === asset.manifestArtifact.id
      && entry.artifactContentSha256 === asset.manifestArtifact.contentSha256
      && entry.jsonPointer === '/assetId'
      && entry.sourceUrl === source.sourcePageUrl
        ? [entry.id]
        : []
    ));
    const publicSourceEvidenceIds = evidenceEntries.flatMap((entry) => (
      entry.evidenceClass === 'public_source'
      && typeof entry.sourceUrl === 'string'
      && sameBrowserSourceUrl(entry.sourceUrl, source.sourcePageUrl)
        ? [entry.id]
        : []
    ));
    return screenshotEvidenceIds.length > 0 && publicSourceEvidenceIds.length > 0
      ? [{ asset, screenshotEvidenceIds, publicSourceEvidenceIds }]
      : [];
  });
}

function assertVisualPreflight(
  deliverableId: string,
  inventory: VerifiedVisualInventory | undefined,
): void {
  if (deliverableId !== 'competitive_analysis_report' && deliverableId !== 'design_audit_report') return;
  if (!inventory || inventory.assets.length === 0) {
    if (deliverableId === 'competitive_analysis_report') return;
    throw new Error(`${deliverableId} requires a non-empty verified visual inventory before synthesis`);
  }
  if (deliverableId === 'competitive_analysis_report') return;
  const originals = inventory.assets.filter((asset) => inventory.roles.get(asset.artifact.id) === 'original');
  const annotations = inventory.assets.filter((asset) => inventory.roles.get(asset.artifact.id) === 'annotation');
  const hasPair = annotations.some((annotation) => originals.some(
    (original) => sameVisualReference(annotation.manifest.derivedFrom, original),
  ));
  if (!hasPair) {
    throw new Error(`${deliverableId} requires a verified original and annotation lineage pair`);
  }
  if (
    deliverableId === 'design_audit_report'
    && !annotations.some((annotation) => inventory.annotationBindings.has(annotation.artifact.id))
  ) {
    throw new Error('design_audit_report requires a verified finding-bound annotation');
  }
}

function assertPayloadVisualReferences(
  deliverableId: string,
  payload: unknown,
  inventory: VerifiedVisualInventory | undefined,
  displayableInventory: readonly DisplayableVisualInventoryItem[],
  matrixContract?: CompetitiveMatrixContract,
): void {
  if (deliverableId !== 'competitive_analysis_report' && deliverableId !== 'design_audit_report') return;
  const value = unknownRecord(payload);
  if (!value) throw new Error('deliverable payload must be an object');
  if (deliverableId === 'competitive_analysis_report') {
    const samples = Array.isArray(value.competitorSamples) ? value.competitorSamples : [];
    const sampleIds = new Set(samples.flatMap((candidate) => {
      const sample = unknownRecord(candidate);
      return typeof sample?.id === 'string' ? [sample.id] : [];
    }));
    const matrix = Array.isArray(value.dimensionMatrix) ? value.dimensionMatrix : [];
    const dimensionNames = matrix.flatMap((candidate) => {
      const row = unknownRecord(candidate);
      return typeof row?.dimension === 'string' ? [row.dimension] : [];
    });
    if (dimensionNames.length !== matrix.length || new Set(dimensionNames).size !== dimensionNames.length) {
      throw new Error('competitive dimensionMatrix dimensions must be unique');
    }
    const dimensions = new Set(dimensionNames);
    if (matrixContract) {
      if (samples.length === 0 || sampleIds.size !== samples.length) {
        throw new Error('competitive competitorSamples must contain unique sample ids');
      }
      if (matrixContract.sampleIds.length > 0) {
        const expectedSampleIds = new Set(matrixContract.sampleIds);
        if (
          expectedSampleIds.size !== sampleIds.size
          || [...expectedSampleIds].some((sampleId) => !sampleIds.has(sampleId))
        ) {
          throw new Error(
            `competitive competitorSamples must preserve the canonical case ids: ${matrixContract.sampleIds.join(', ')}`,
          );
        }
      }
      const expectedSampleIds = matrixContract.sampleIds.length
        ? new Set(matrixContract.sampleIds)
        : sampleIds;
      for (const candidate of matrix) {
        const row = unknownRecord(candidate);
        const values = Array.isArray(row?.values) ? row.values : [];
        const seenValueIds = new Set<string>();
        if (values.length !== expectedSampleIds.size) {
          throw new Error('competitive dimensionMatrix must cover every sampled competitor exactly once');
        }
        for (const value of values) {
          const cell = unknownRecord(value);
          const sampleId = cell?.sampleId;
          if (
            typeof sampleId !== 'string'
            || !expectedSampleIds.has(sampleId)
            || seenValueIds.has(sampleId)
            || typeof cell?.score !== 'number'
            || !Number.isFinite(cell?.score)
            || cell.score < 1
            || cell.score > 5
          ) {
            throw new Error(
              'competitive dimensionMatrix must contain one numeric score from 1 to 5 for every sample',
            );
          }
          seenValueIds.add(sampleId);
        }
        if (seenValueIds.size !== expectedSampleIds.size) {
          throw new Error('competitive dimensionMatrix must cover every sampled competitor exactly once');
        }
        if (
          matrixContract.dimensions.length > 0
          && !matrixContract.dimensions.includes(String(row?.dimension ?? ''))
        ) {
          throw new Error(
            `competitive dimensionMatrix must preserve canonical scoring dimensions: ${matrixContract.dimensions.join(', ')}`,
          );
        }
      }
      const expectedDimensions = new Set(matrixContract.dimensions);
      if (
        expectedDimensions.size !== dimensions.size
        || [...expectedDimensions].some((dimension) => !dimensions.has(dimension))
      ) {
        throw new Error(
          `competitive dimensionMatrix must preserve canonical scoring dimensions: ${matrixContract.dimensions.join(', ')}`,
        );
      }
    }
    const visualEvidence = value.visualEvidence;
    if (!Array.isArray(visualEvidence)) {
      throw new Error('competitive visualEvidence must be an explicit array for a newly generated report');
    }
    if (displayableInventory.length > 0 && visualEvidence.length === 0) {
      throw new Error('competitive visualEvidence must select at least one displayable browser capture');
    }
    if (displayableInventory.length === 0 && visualEvidence.length > 0) {
      throw new Error('competitive visualEvidence requires screenshot and matching public-source Evidence');
    }
    const displayableById = new Map(
      displayableInventory.map((item) => [item.asset.artifact.id, item]),
    );
    const usedAssetIds = new Set<string>();
    const usedVisualEvidenceIds = new Set<string>();
    for (const candidate of visualEvidence) {
      const item = unknownRecord(candidate);
      const id = item?.id;
      const assetId = item?.assetId;
      const referencedSampleIds = item?.sampleIds;
      const dimension = item?.dimension;
      const evidenceIds = item?.evidenceIds;
      if (
        typeof id !== 'string'
        || !id.trim()
        || usedVisualEvidenceIds.has(id)
        || typeof assetId !== 'string'
        || !Array.isArray(referencedSampleIds)
        || referencedSampleIds.length === 0
        || referencedSampleIds.some((sampleId) => typeof sampleId !== 'string' || !sampleIds.has(sampleId))
        || new Set(referencedSampleIds).size !== referencedSampleIds.length
        || typeof dimension !== 'string'
        || !dimensions.has(dimension)
        || !Array.isArray(evidenceIds)
        || evidenceIds.some((evidenceId) => typeof evidenceId !== 'string')
        || new Set(evidenceIds).size !== evidenceIds.length
      ) {
        throw new Error('competitive visualEvidence has an invalid sample, dimension, Asset, or Evidence reference');
      }
      const displayable = displayableById.get(assetId);
      const allowedEvidenceIds = new Set([
        ...(displayable?.screenshotEvidenceIds ?? []),
        ...(displayable?.publicSourceEvidenceIds ?? []),
      ]);
      if (
        !displayable
        || usedAssetIds.has(assetId)
        || !displayable.screenshotEvidenceIds.some((evidenceId) => evidenceIds.includes(evidenceId))
        || !displayable.publicSourceEvidenceIds.some((evidenceId) => evidenceIds.includes(evidenceId))
        || evidenceIds.some((evidenceId) => !allowedEvidenceIds.has(evidenceId))
      ) {
        throw new Error('competitive visualEvidence must bind each Asset once to its screenshot and matching public-source Evidence');
      }
      usedVisualEvidenceIds.add(id);
      usedAssetIds.add(assetId);
    }
    const comparisons = value.screenshotComparisons;
    if (!Array.isArray(comparisons)) {
      throw new Error('competitive screenshot comparisons require a verified visual inventory');
    }
    if (comparisons.length === 0) {
      return;
    }
    if (!inventory || inventory.assets.length === 0) {
      throw new Error('competitive screenshot comparisons require a verified visual inventory');
    }
    const byId = new Map(inventory.assets.map((asset) => [asset.artifact.id, asset]));
    for (const candidate of comparisons) {
      const comparison = unknownRecord(candidate);
      const ids = comparison?.assetIds;
      if (!Array.isArray(ids) || ids.length !== 2 || ids.some((id) => typeof id !== 'string')) {
        throw new Error('competitive screenshot comparison requires an original and annotation pair');
      }
      const original = byId.get(ids[0] as string);
      const annotation = byId.get(ids[1] as string);
      if (
        !original || !annotation
        || inventory.roles.get(original.artifact.id) !== 'original'
        || inventory.roles.get(annotation.artifact.id) !== 'annotation'
        || !sameVisualReference(annotation.manifest.derivedFrom, original)
      ) {
        throw new Error('competitive screenshot comparison has invalid original/annotation lineage');
      }
    }
    return;
  }
  if (!inventory) throw new Error(`${deliverableId} requires a verified visual inventory`);
  const byId = new Map(inventory.assets.map((asset) => [asset.artifact.id, asset]));
  const screenshots = value.annotatedScreenshots;
  const issues = Array.isArray(value.issues) ? value.issues : [];
  const issueIds = new Set(issues.flatMap((candidate) => {
    const issue = unknownRecord(candidate);
    return typeof issue?.id === 'string' ? [issue.id] : [];
  }));
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    throw new Error('design annotatedScreenshots require a verified annotation');
  }
  for (const candidate of screenshots) {
    const screenshot = unknownRecord(candidate);
    const annotationId = screenshot?.assetId;
    const issueId = screenshot?.issueId;
    const annotation = typeof annotationId === 'string' ? byId.get(annotationId) : undefined;
    const findingBinding = typeof annotationId === 'string'
      ? inventory.annotationBindings.get(annotationId)
      : undefined;
    if (
      !annotation
      || inventory.roles.get(annotation.artifact.id) !== 'annotation'
      || !inventory.assets.some((original) => inventory.roles.get(original.artifact.id) === 'original'
        && sameVisualReference(annotation.manifest.derivedFrom, original))
      || typeof issueId !== 'string'
      || !issueIds.has(issueId)
      || !findingBinding?.findingIds.includes(issueId)
    ) {
      throw new Error('design annotatedScreenshot does not reference an exact finding-bound annotation lineage');
    }
  }
}


function coverageRequirements(finalizedRequirement: unknown, problemGraph: unknown): {
  requiredQuestionIds: string[];
  successCriterionIds: string[];
} {
  const requirement = unknownRecord(finalizedRequirement);
  const criteria = requirement?.success_criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error('finalized requirement success criteria are required for deliverable coverage');
  }
  const successCriterionIds = criteria.map((candidate) => {
    const criterion = unknownRecord(candidate);
    if (!criterion || typeof criterion.id !== 'string' || criterion.id.trim().length === 0) {
      throw new Error('finalized requirement success criterion id is invalid');
    }
    return criterion.id;
  });
  if (new Set(successCriterionIds).size !== successCriterionIds.length) {
    throw new Error('finalized requirement success criterion ids must be unique');
  }

  const graph = unknownRecord(problemGraph);
  const questions = graph?.questions;
  if (!Array.isArray(questions)) throw new Error('ProblemGraph questions are required for deliverable coverage');
  const requiredQuestionIds = questions.flatMap((candidate) => {
    const question = unknownRecord(candidate);
    if (
      !question
      || typeof question.id !== 'string'
      || question.id.trim().length === 0
      || (question.priority !== 'required' && question.priority !== 'optional')
    ) {
      throw new Error('ProblemGraph question is invalid');
    }
    return question.priority === 'required' ? [question.id] : [];
  });
  if (requiredQuestionIds.length === 0) {
    throw new Error('at least one required ProblemGraph question is required for deliverable coverage');
  }
  if (new Set(requiredQuestionIds).size !== requiredQuestionIds.length) {
    throw new Error('required ProblemGraph question ids must be unique');
  }
  return { requiredQuestionIds, successCriterionIds };
}

function assertRequiredCoverage(
  coverage: DeliverableDraft['coverage'],
  requirements: ReturnType<typeof coverageRequirements>,
): void {
  const coveredQuestions = new Set(coverage.questionBindings.map((binding) => binding.questionId));
  const coveredCriteria = new Set(
    coverage.successCriterionBindings.map((binding) => binding.successCriterionId),
  );
  const issues = [
    ...requirements.requiredQuestionIds
      .filter((questionId) => !coveredQuestions.has(questionId))
      .map((questionId) => `missing required question ${questionId}`),
    ...requirements.successCriterionIds
      .filter((criterionId) => !coveredCriteria.has(criterionId))
      .map((criterionId) => `missing success criterion ${criterionId}`),
  ];
  if (issues.length > 0) throw new Error(`deliverable coverage ${issues.join('; ')}`);
}

const CAPABILITY_TYPE_BY_OUTPUT_KIND: Record<string, string> = {
  tool_output: 'tool',
  skill_output: 'skill',
  llm_output: 'llm',
  review_output: 'reviewer',
};

function sealedOutputData(outputs: unknown[]): {
  references: Array<Record<string, unknown>>;
  provenance: DeliverableEnvelope['capabilityProvenance'];
} {
  const references: Array<Record<string, unknown>> = [];
  const provenance: DeliverableEnvelope['capabilityProvenance'] = [];
  const seenCapabilities = new Set<string>();
  for (const candidate of outputs) {
    const output = unknownRecord(candidate);
    const artifact = unknownRecord(output?.artifact);
    if (!output || !artifact || artifact.state !== 'SEALED' || typeof artifact.id !== 'string') continue;
    const reference: Record<string, unknown> = { artifactId: artifact.id };
    if (typeof artifact.contentSha256 === 'string') reference.contentSha256 = artifact.contentSha256;
    if (typeof output.actorId === 'string') reference.actorId = output.actorId;
    if (typeof output.kind === 'string') reference.kind = output.kind;
    if (typeof output.stepNo === 'number') reference.stepNo = output.stepNo;
    references.push(reference);

    const type = typeof output.kind === 'string'
      ? CAPABILITY_TYPE_BY_OUTPUT_KIND[output.kind]
      : undefined;
    if (!type || typeof output.actorId !== 'string') continue;
    const capabilityKey = `${type}:${output.actorId}`;
    if (seenCapabilities.has(capabilityKey)) continue;
    seenCapabilities.add(capabilityKey);
    provenance.push({ id: output.actorId, type });
  }
  return { references, provenance };
}

function riskKey(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC').trim()).digest('hex').slice(0, 16);
}

function reviewerConditionStatements(materials: readonly SynthesisMaterial[]): Array<{
  sourceId: string;
  conditionId: string;
  statement: string;
  disposition: 'limitation' | 'open_question';
}> {
  const result: Array<{
    sourceId: string;
    conditionId: string;
    statement: string;
    disposition: 'limitation' | 'open_question';
  }> = [];
  for (const material of materials.filter(({ semanticRole }) => semanticRole === 'review')) {
    const review = unknownRecord(material.value);
    if (review?.version !== 'reviewer-step-output-v1') continue;
    if (!Array.isArray(review.conditions)) {
      throw new Error(`structured reviewer Artifact ${material.artifactId} has no conditions array`);
    }
    for (const value of review.conditions) {
      const condition = unknownRecord(value);
      if (
        !condition
        || typeof condition.id !== 'string'
        || !condition.id.trim()
        || typeof condition.statement !== 'string'
        || !condition.statement.trim()
        || (condition.disposition !== 'limitation' && condition.disposition !== 'open_question')
      ) {
        throw new Error(`structured reviewer Artifact ${material.artifactId} has a malformed condition`);
      }
      result.push({
        sourceId: material.artifactId,
        conditionId: condition.id,
        statement: condition.statement.trim(),
        disposition: condition.disposition,
      });
    }
  }
  return result;
}

export function collectRequiredRiskDisclosures(input: {
  requirement: ResearchTaskV2;
  gaps: readonly string[];
  materials: readonly SynthesisMaterial[];
  envelopeRisks: readonly string[];
  revisionInstruction?: string;
}): ResearchStrategyRiskDisclosure[] {
  const disclosures: ResearchStrategyRiskDisclosure[] = [];
  for (const ambiguity of input.requirement.ambiguities) {
    disclosures.push({
      id: `risk-requirement-${ambiguity.id}`,
      sourceType: 'requirement_ambiguity',
      sourceId: ambiguity.id,
      statement: ambiguity.statement,
      disposition: ambiguity.blocking ? 'open_question' : 'limitation',
    });
  }
  for (const gap of input.gaps) {
    const sourceId = riskKey(gap);
    disclosures.push({ id: `risk-gap-${sourceId}`, sourceType: 'skill_degraded_gap', sourceId, statement: gap, disposition: 'limitation' });
  }
  for (const condition of reviewerConditionStatements(input.materials)) {
    disclosures.push({
      id: `risk-reviewer-${riskKey(`${condition.sourceId}:${condition.conditionId}:${condition.statement}`)}`,
      sourceType: 'reviewer_condition',
      sourceId: `${condition.sourceId}:${condition.conditionId}`,
      statement: condition.statement,
      disposition: condition.disposition,
    });
  }
  if (input.revisionInstruction?.trim()) {
    const statement = input.revisionInstruction.trim();
    const sourceId = riskKey(statement);
    disclosures.push({ id: `risk-review-${sourceId}`, sourceType: 'reviewer_condition', sourceId, statement, disposition: 'limitation' });
  }
  for (const risk of input.envelopeRisks) {
    const sourceId = riskKey(risk);
    disclosures.push({ id: `risk-envelope-${sourceId}`, sourceType: 'envelope_risk', sourceId, statement: risk, disposition: 'limitation' });
  }
  const unique = new Map(disclosures.map((item) => [`${item.sourceType}:${item.sourceId}`, item]));
  return [...unique.values()];
}

export class CurrentDeliverableService {
  private readonly reportValidator: ReportEvidenceValidator;

  constructor(private readonly dependencies: {
    llm: StructuredLlm;
    validator: PayloadValidator;
    evidence: Pick<EvidenceService, 'validateManifest' | 'resolveEvidenceValue' | 'validateFindingGraph'>;
    artifacts: ArtifactWriter;
    materializer?: SynthesisMaterializerLike;
  }) {
    this.reportValidator = new ReportEvidenceValidator(dependencies.evidence);
  }

  async generate(input: CurrentDeliverableGenerateInput): Promise<CurrentDeliverableGenerateResult> {
    const requirement = unknownRecord(input.finalizedRequirement);
    const selection = deliverableSelection(input.finalizedRequirement, input.plan.plan.deliverable_type);
    const strictV2 = requirement?.version === 'research-task-v2' && selection !== null;
    const contract = selection
      ? resolveExecutionDeliverableContract(
          selection.taskType,
          selection.expectedDeliverables,
          input.plan.plan.deliverable_type,
        )
      : resolveDeliverableContractById(input.plan.plan.deliverable_type);
    if (input.plan.plan.deliverable_type !== contract.entry.id) {
      throw new Error(
        `plan deliverable type ${input.plan.plan.deliverable_type} does not match Registry selection ${contract.entry.id}`,
      );
    }
    const draftSchema = createDeliverableDraftSchema(contract.payloadSchema, strictV2);
    const schemaName = `${contract.entry.id.replace(/_/gu, '-')}-deliverable-content`;
    const visualInventory = strictV2 ? verifiedVisualInventory(input) : undefined;
    if (strictV2) assertVisualPreflight(contract.entry.id, visualInventory);
    const evidenceManifest = input.evidenceManifest.value;
    this.dependencies.evidence.validateManifest(evidenceManifest, input.evidenceResolver);
    const displayableInventory = strictV2
      ? displayableVisualInventory(visualInventory, evidenceManifest.entries)
      : [];
    if (strictV2) {
      assertCompetitiveVisualAvailability(
        contract.entry.id,
        input.plan.plan,
        input.gapRefs,
        visualInventory,
        displayableInventory,
      );
    }
    const sanitizedGaps = [...new Set(input.gaps.map((gap) => redactString(gap)))];
    const outputData = sealedOutputData(input.outputs);
    const synthesisMaterials = this.dependencies.materializer
      ? await this.dependencies.materializer.materialize({
          taskId: input.task.id,
          planVersionId: input.plan.id,
          attemptId: input.attempt.id,
          outputs: input.outputs as MaterializeStepOutput[],
          evidenceEntries: evidenceManifest.entries,
        })
      : [];
    const strategyRequirement = contract.entry.id === 'research_strategy_report'
      ? input.finalizedRequirement as ResearchTaskV2
      : null;
    const preSynthesisRiskDisclosures = strategyRequirement
      ? collectRequiredRiskDisclosures({
          requirement: strategyRequirement,
          gaps: sanitizedGaps,
          materials: synthesisMaterials,
          envelopeRisks: sanitizedGaps,
          revisionInstruction: input.revisionInstruction,
        })
      : [];
    const matrixContract = strictV2 && contract.entry.id === 'competitive_analysis_report'
      ? competitiveMatrixContract(synthesisMaterials, input.plan.plan)
      : undefined;
    const verifiedEvidence = evidenceManifest.entries.map((entry) => ({
      evidenceId: entry.id,
      evidenceClass: entry.evidenceClass,
      ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
      value: redactSensitiveValue(
        this.dependencies.evidence.resolveEvidenceValue(entry, input.evidenceResolver),
      ),
    }));
    const requiredCoverage = strictV2
      ? coverageRequirements(input.finalizedRequirement, input.problemGraph)
      : undefined;
    const strategySkillStepNo = synthesisMaterials.find(({ actorType, actorId }) => (
      actorType === 'skill' && actorId === 'research-strategy-synthesis'
    ))?.stepNo ?? Number.POSITIVE_INFINITY;
    if (contract.synthesisMode === 'reviewed_skill_assembly') {
      if (!strategyRequirement || !requiredCoverage) {
        throw new Error('reviewed Skill assembly requires a finalized research strategy requirement');
      }
      let deliverable: ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2> | null = null;
      let draftOverride = input.strategyDraftOverride;
      const sourceDraft = draftOverride ?? extractResearchStrategyContentDraft(synthesisMaterials);
      let strategyFidelity: {
        mode: 'none' | 'structural_repair' | 'semantic_revision';
        sourceDraft: ResearchStrategyContentDraftV2;
        result: ResearchStrategyContentFidelityResult;
        repairOperations: string[];
      };
      const assemblyAttempts = draftOverride ? 1 : 2;
      const persistAssemblyDiagnostic = async (
        assemblyRound: number,
        error: unknown,
        fallbackApplied: boolean,
      ): Promise<void> => {
        const round = (input.revisionRound ?? 0) + assemblyRound;
        const diagnostic = createDeliverableValidationDiagnostic({
          taskId: input.task.id,
          planVersionId: input.plan.id,
          attemptId: input.attempt.id,
          stage: 'canonical_assembly',
          round,
          error,
          fallbackApplied,
        });
        this.dependencies.validator.validateFileOrThrow(
          'schemas/deliverable-validation-diagnostic.schema.json',
          diagnostic,
        );
        try {
          await this.dependencies.artifacts.writeJson({
            taskId: input.task.id,
            planVersionId: input.plan.id,
            attemptId: input.attempt.id,
            kind: 'deliverable_validation_diagnostic',
            relativePath: `diagnostics/deliverable-validation-r${round}.json`,
            schemaVersion: diagnostic.version,
            sensitivity: 'internal',
            redactionPolicyVersion: 'v1',
            activeLease: input.activeLease,
            value: diagnostic,
          });
        } catch {
          // Diagnostics are best-effort and must not hide the authoritative validation failure.
        }
      };
      const persistFidelityDiagnostic = async (inputDiagnostic: {
        round: number;
        mode: 'none' | 'structural_repair' | 'semantic_revision';
        result: ResearchStrategyContentFidelityResult;
        repairOperations: readonly string[];
      }): Promise<void> => {
        const diagnostic = createContentFidelityDiagnostic({
          taskId: input.task.id,
          planVersionId: input.plan.id,
          attemptId: input.attempt.id,
          round: inputDiagnostic.round,
          mode: inputDiagnostic.mode,
          result: inputDiagnostic.result,
          normalizationOperations: ['deterministic_reference_and_binding_normalization'],
          repairOperations: inputDiagnostic.repairOperations,
        });
        this.dependencies.validator.validateFileOrThrow(
          'schemas/content-fidelity-diagnostic.schema.json',
          diagnostic,
        );
        await this.dependencies.artifacts.writeJson({
          taskId: input.task.id,
          planVersionId: input.plan.id,
          attemptId: input.attempt.id,
          kind: 'content_fidelity_diagnostic',
          relativePath: `diagnostics/content-fidelity-r${inputDiagnostic.round}.json`,
          schemaVersion: diagnostic.version,
          sensitivity: 'internal',
          redactionPolicyVersion: 'v1',
          activeLease: input.activeLease,
          value: diagnostic,
        });
      };
      try {
        strategyFidelity = input.strategyFidelity ?? {
          mode: 'none',
          sourceDraft,
          result: compareResearchStrategyContentFidelity(sourceDraft, sourceDraft),
          repairOperations: [],
        };
      } catch (fidelityError) {
        if (fidelityError instanceof ResearchStrategyContentFidelityError) {
          await persistAssemblyDiagnostic(0, fidelityError, false);
          await persistFidelityDiagnostic({
            round: input.revisionRound ?? 0,
            mode: input.strategyFidelity?.mode ?? 'none',
            result: fidelityError.result,
            repairOperations: input.strategyFidelity?.repairOperations ?? [],
          });
        }
        throw new ResearchStrategyDeliverableValidationError(fidelityError, sourceDraft);
      }
      for (let assemblyRound = 0; assemblyRound < assemblyAttempts; assemblyRound += 1) {
        try {
          deliverable = assembleResearchStrategyDeliverable({
            taskId: input.task.id,
            planVersionId: input.plan.id,
            attemptId: input.attempt.id,
            evidenceManifestArtifactId: input.evidenceManifest.artifact.id,
            requirement: strategyRequirement,
            problemGraph: input.problemGraph as ProblemGraph,
            evidenceManifest,
            materials: synthesisMaterials,
            ...(draftOverride ? { draftOverride } : {}),
            requiredRiskDisclosures: preSynthesisRiskDisclosures,
            capabilityProvenance: outputData.provenance,
            validator: this.dependencies.validator,
          });
          if (!isResearchStrategyPayloadV2(deliverable.payload)) {
            throw new Error('reviewed Skill assembly did not produce research strategy payload v2');
          }
          assertRequiredCoverage(deliverable.coverage, requiredCoverage);
          this.reportValidator.validate({
            manifest: evidenceManifest,
            report: deliverable,
            resolver: input.evidenceResolver,
            requireCoverage: true,
            validatePayloadSchema: true,
          });
          break;
        } catch (error) {
          const repairable = assemblyRound === 0
            && draftOverride === undefined
            && error instanceof ResearchStrategyAssemblyError
            && !/Reviewer verdict|no final Reviewer/u.test(error.message);
          if (repairable) {
            await persistAssemblyDiagnostic(assemblyRound, error, true);
            const originalDraft = sourceDraft;
            const repaired = await this.dependencies.llm.generateStructured<ResearchStrategyContentPatchV1>({
              prompt: [
                'Return one research-strategy-content-patch-v1 in structural_repair mode.',
                'Repair the reviewed Content Draft without rewriting, deleting, or reordering existing semantic content.',
                'Use replace_direct_answer_binding or replace_support for binding corrections. Use append operations only for genuinely missing required content.',
                'Do not use replace_semantic_text in structural_repair mode.',
                'Use only the exact allowed Question and Evidence IDs supplied in context.',
                'The allowedEvidence list is the authoritative final Evidence inventory. evidenceBindingSources contains upstream question-indexed citations; use it to restore missing bindings instead of claiming that the Evidence Manifest is unavailable.',
                'Every non-unanswered Direct Answer, Evidence Finding, and requested content Block must retain relevant Evidence. Keep interpretive claims provisional even when attaching factual context.',
                `Correct this validation failure: ${redactString(error.message)}`,
              ].join('\n'),
              schema: researchStrategyPatchSchema(),
              schemaName: 'research-strategy-content-patch-v1',
              context: {
                draft: redactSensitiveValue(originalDraft),
                allowedQuestionIds: (input.problemGraph as ProblemGraph).questions.map(({ id }) => id),
                allowedEvidence: evidenceManifest.entries.map(({ id, evidenceClass, sourceUrl }) => ({
                  id,
                  evidenceClass,
                  ...(sourceUrl ? { sourceUrl } : {}),
                })),
                evidenceBindingSources: synthesisMaterials
                  .filter(({ actorType, stepNo }) => actorType === 'llm' && stepNo < strategySkillStepNo)
                  .sort((left, right) => left.stepNo - right.stepNo)
                  .slice(0, 2)
                  .map(({ stepNo, questionIds, value }) => ({
                    stepNo,
                    questionIds,
                    value: redactSensitiveValue(value),
                  })),
                requestedArtifacts: strategyRequirement.requested_artifacts ?? [],
              },
              receipt: {
                stage: 'deliverable_repair',
                attemptId: input.attempt.id,
                stepNo: input.stepNo ?? (input.plan.plan.steps?.length ?? 0) + 1,
                expectedModel: input.expectedModel,
              },
            });
            let applied: ReturnType<typeof applyResearchStrategyContentPatch>;
            try {
              this.dependencies.validator.validateSchemaOrThrow(
                researchStrategyPatchSchema(),
                repaired.data,
                'research-strategy-content-patch-v1',
              );
              applied = applyResearchStrategyContentPatch({
                source: originalDraft,
                patch: repaired.data,
                mode: 'structural_repair',
                problemGraph: input.problemGraph as ProblemGraph,
                evidenceManifest,
                requestedArtifacts: strategyRequirement.requested_artifacts ?? [],
              });
            } catch (patchError) {
              await persistAssemblyDiagnostic(assemblyRound + 1, patchError, false);
              await persistFidelityDiagnostic({
                round: (input.revisionRound ?? 0) + assemblyRound + 1,
                mode: 'structural_repair',
                result: patchError instanceof ResearchStrategyContentFidelityError
                  ? patchError.result
                  : compareResearchStrategyContentFidelity(originalDraft, originalDraft),
                repairOperations: repaired.data.operations.map(patchOperationAudit),
              });
              throw new ResearchStrategyDeliverableValidationError(patchError, originalDraft);
            }
            draftOverride = applied.draft;
            strategyFidelity = {
              mode: 'structural_repair',
              sourceDraft: originalDraft,
              result: applied.fidelity,
              repairOperations: repaired.data.operations.map(patchOperationAudit),
            };
            continue;
          }
          await persistAssemblyDiagnostic(assemblyRound, error, false);
          await persistFidelityDiagnostic({
            round: (input.revisionRound ?? 0) + assemblyRound,
            mode: strategyFidelity.mode,
            result: strategyFidelity.result,
            repairOperations: strategyFidelity.repairOperations,
          });
          throw new ResearchStrategyDeliverableValidationError(error, draftOverride ?? sourceDraft);
        }
      }
      if (!deliverable) throw new Error('research strategy assembly exhausted without a validated result');
      const canonicalDraft = canonicalResearchStrategyDraftForFidelity(
        strategyFidelity.sourceDraft,
        deliverable.payload,
        deliverable.methodSummary,
      );
      let canonicalFidelity: ResearchStrategyContentFidelityResult;
      try {
        canonicalFidelity = strategyFidelity.mode === 'semantic_revision'
          ? assertSemanticRevisionFidelity(
              strategyFidelity.sourceDraft,
              canonicalDraft,
              new Set(strategyFidelity.result.changedSemanticUnitKeys),
            )
          : assertStructuralRepairFidelity(strategyFidelity.sourceDraft, canonicalDraft);
      } catch (fidelityError) {
        if (fidelityError instanceof ResearchStrategyContentFidelityError) {
          await persistAssemblyDiagnostic(0, fidelityError, false);
          await persistFidelityDiagnostic({
            round: input.revisionRound ?? 0,
            mode: strategyFidelity.mode,
            result: fidelityError.result,
            repairOperations: strategyFidelity.repairOperations,
          });
        }
        throw new ResearchStrategyDeliverableValidationError(fidelityError, strategyFidelity.sourceDraft);
      }
      strategyFidelity = { ...strategyFidelity, result: canonicalFidelity };
      await persistFidelityDiagnostic({
        round: input.revisionRound ?? 0,
        mode: strategyFidelity.mode,
        result: strategyFidelity.result,
        repairOperations: strategyFidelity.repairOperations,
      });
      const artifact = await this.dependencies.artifacts.writeJson({
        taskId: input.task.id,
        planVersionId: input.plan.id,
        attemptId: input.attempt.id,
        kind: 'deliverable',
        relativePath: `deliverables/final-r${input.revisionRound ?? 0}.json`,
        schemaVersion: `${contract.entry.envelope_version}-review-gated`,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
        value: deliverable,
      });
      return { deliverable, deliverableArtifactId: artifact.id };
    }
    const producerVisualInventory = visualInventory?.assets.map((asset) => ({
      assetId: asset.artifact.id,
      role: visualInventory?.roles.get(asset.artifact.id),
      ...(asset.manifest.derivedFrom === null ? {} : { derivedFromAssetId: asset.manifest.derivedFrom?.assetId }),
      ...(visualInventory?.annotationBindings.get(asset.artifact.id)
        ? { findingIds: visualInventory.annotationBindings.get(asset.artifact.id)!.findingIds }
        : {}),
    }));
    const producerDisplayableVisualInventory = displayableInventory.map(({ asset, screenshotEvidenceIds, publicSourceEvidenceIds }) => {
      const source = asset.manifest.source;
      if (source.kind !== 'browser_capture') throw new Error('displayable visual inventory source drifted');
      return {
        assetId: asset.artifact.id,
        sourceType: source.kind,
        sourcePageUrl: source.sourcePageUrl,
        finalUrl: source.finalUrl,
        pageTitle: source.pageTitle,
        capturedAt: source.capturedAt,
        captureMode: source.captureMode,
        width: asset.manifest.width,
        height: asset.manifest.height,
        screenshotEvidenceIds: [...screenshotEvidenceIds],
        publicSourceEvidenceIds: [...publicSourceEvidenceIds],
      };
    });
    const context = {
      researchGoal: redactString(input.researchGoal),
      finalizedRequirement: redactSensitiveValue(input.finalizedRequirement),
      problemGraph: redactSensitiveValue(input.problemGraph),
      ...(requiredCoverage === undefined ? {} : { coverageRequirements: requiredCoverage }),
      ...(matrixContract && (matrixContract.sampleIds.length > 0 || matrixContract.dimensions.length > 0)
        ? {
            canonicalCompetitiveMatrix: {
              sampleIds: [...matrixContract.sampleIds],
              dimensions: [...matrixContract.dimensions],
            },
          }
        : {}),
      ...(input.revisionInstruction === undefined ? {} : { revisionInstruction: redactString(input.revisionInstruction) }),
      ...(visualInventory === undefined ? {} : {
        verifiedVisualAssetIds: visualInventory.ids,
        verifiedVisualInventory: producerVisualInventory,
        displayableVisualInventory: producerDisplayableVisualInventory,
      }),
      deliverableContract: {
        id: contract.entry.id,
        reviewRubric: contract.reviewRubric,
        evidencePolicy: contract.evidencePolicy,
        reportTemplate: contract.reportTemplate,
      },
      verifiedEvidence,
      synthesisMaterials,
      gaps: sanitizedGaps,
      requiredRiskDisclosures: preSynthesisRiskDisclosures,
    };
    const lastEvidenceStep = evidenceManifest.entries.reduce(
      (maximum, entry) => Math.max(maximum, entry.stepNo ?? 0),
      0,
    );
    const stepNo = input.stepNo
      ?? (input.plan.plan.steps ? input.plan.plan.steps.length + 1 : lastEvidenceStep + 1);
    const generateDraft = async (validationFeedback: string[] = []): Promise<unknown> => {
      const generated = await this.dependencies.llm.generateStructured<DeliverableDraft & {
        capabilityProvenance?: unknown;
      }>({
        prompt: contract.synthesisPrompt
          + '\nCoverage bindings are exhaustive. Include every context.coverageRequirements.requiredQuestionIds item exactly once in coverage.questionBindings and every context.coverageRequirements.successCriterionIds item exactly once in coverage.successCriterionBindings. Bind an explicit gap conclusion and recommendation when a requirement is not yet satisfied; never omit its id.'
          + '\nEvery evidenceIds entry must reference only context.verifiedEvidence[].evidenceId. Never place a Visual Asset id in evidenceIds; Visual Asset ids are allowed only in typed visual fields such as screenshotComparisons.assetIds.'
          + '\nFor findingGraph findings with kind "fact", every evidenceIds entry must have evidenceClass public_source, screenshot, or dataset. user_input, knowledge, simulation, and derived evidence cannot root a fact.'
          + (matrixContract && (matrixContract.sampleIds.length > 0 || matrixContract.dimensions.length > 0)
            ? '\nFor competitive analysis, preserve context.canonicalCompetitiveMatrix exactly: use every canonical sampleId once, do not split or rename a case, cover every canonical dimension, and put a numeric score from 1 to 5 in every matrix cell.'
            : '')
          + (contract.entry.id === 'competitive_analysis_report'
            && (!visualInventory || visualInventory.assets.length === 0)
            ? '\nNo verified visual Asset inventory exists. Return empty visualEvidence and screenshotComparisons arrays and never invent an Asset id.'
            : visualInventory === undefined
              ? ''
              : '\nVerified visual Asset inventory: reference only typed Asset ids in context.verifiedVisualAssetIds; never invent or reuse any other Asset id.'
                + (contract.entry.id === 'design_audit_report'
                  ? ' For each annotatedScreenshots entry, use one annotation assetId and one issueId from that same annotation item\'s findingIds in context.verifiedVisualInventory; payload.issues must contain the same issueId.'
                  : ' screenshotComparisons is optional and may contain only an exact original-to-annotation lineage pair.'
                    + (displayableInventory.length > 0
                      ? ' Select at least one visualEvidence item from context.displayableVisualInventory. Each item must use existing competitor sample ids, an exact dimensionMatrix dimension, and include both one listed screenshotEvidenceId and one listed publicSourceEvidenceId for that Asset.'
                      : ' No Asset has both exact screenshot and matching public-source Evidence, so return an empty visualEvidence array.')))
          + (input.revisionInstruction ? '\nAddress the review issues in the revision instruction.' : '')
          + (validationFeedback.length > 0
            ? `\nThe previous draft failed schema validation. Correct every issue: ${validationFeedback.join('; ')}`
            : ''),
        schema: draftSchema,
        schemaName,
        context: validationFeedback.length > 0
          ? { ...context, validationFeedback }
          : context,
        receipt: {
          stage: 'deliverable',
          attemptId: input.attempt.id,
          stepNo,
          expectedModel: input.expectedModel,
        },
      });
      const generatedRecord = deliverableDraftRecord(generated.data);
      return generatedRecord
        ? Object.fromEntries(
            Object.entries(generatedRecord).filter(([key]) => key !== 'capabilityProvenance'),
          )
        : null;
    };
    let validationFeedback: string[] = [];
    let deliverable: DeliverableEnvelope | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const generatedDraft = await generateDraft(validationFeedback);
      if (!generatedDraft) {
        const message = `model response did not contain a complete deliverable draft (${REQUIRED_DRAFT_KEYS.join(', ')})`;
        if (attempt === 3) throw new Error(message);
        validationFeedback = [message];
        continue;
      }
      const generatedRecord = unknownRecord(generatedDraft);
      const contentDraft = generatedRecord
        ? { ...generatedRecord, payload: projectPayloadToSchema(generatedRecord.payload, contract.payloadSchema) }
        : generatedDraft;
      try {
        this.dependencies.validator.validateSchemaOrThrow(draftSchema, contentDraft, schemaName);
        const validatedDraft = contentDraft as DeliverableDraft;
        let draft = validatedDraft;
        if (strategyRequirement) {
          draft = {
            ...validatedDraft,
            payload: canonicalizeRequestedArtifactBindings(
              validatedDraft.payload as ResearchStrategyReportPayload,
              strategyRequirement,
            ),
          };
          this.dependencies.validator.validateSchemaOrThrow(draftSchema, draft, schemaName);
        }
        if (strictV2 && requiredCoverage) assertRequiredCoverage(draft.coverage, requiredCoverage);
        if (strictV2) {
          assertPayloadVisualReferences(
            contract.entry.id,
            draft.payload,
            visualInventory,
            displayableInventory,
            matrixContract,
          );
        }
        const risksAndOpenIssues = [...(draft.risksAndOpenIssues ?? [])];
        const observedRisks = new Set(risksAndOpenIssues);
        for (const gap of sanitizedGaps) {
          if (observedRisks.has(gap)) continue;
          observedRisks.add(gap);
          risksAndOpenIssues.push(gap);
        }
        const candidate: DeliverableEnvelope = {
          version: contract.entry.envelope_version as DeliverableEnvelope['version'],
          taskId: input.task.id,
          planVersionId: input.plan.id,
          attemptId: input.attempt.id,
          deliverableType: input.plan.plan.deliverable_type,
          evidenceManifestArtifactId: input.evidenceManifest.artifact.id,
          methodSummary: draft.methodSummary,
          findingGraph: draft.findingGraph,
          payload: draft.payload,
          recommendations: draft.recommendations,
          coverage: draft.coverage,
          risksAndOpenIssues,
          capabilityProvenance: outputData.provenance,
        };
        if (strictV2) this.dependencies.validator.validateFileOrThrow(contract.payloadSchemaPath, candidate.payload);
        if (contract.entry.id === 'research_strategy_report') {
          const expectedRiskDisclosures = collectRequiredRiskDisclosures({
            requirement: input.finalizedRequirement as ResearchTaskV2,
            gaps: sanitizedGaps,
            materials: synthesisMaterials,
            envelopeRisks: risksAndOpenIssues,
            revisionInstruction: input.revisionInstruction,
          });
          validateResearchStrategyAnswer({
            payload: candidate.payload as ResearchStrategyReportPayload,
            requirement: input.finalizedRequirement as ResearchTaskV2,
            problemGraph: input.problemGraph as ProblemGraph,
            evidenceIds: evidenceManifest.entries.map(({ id }) => id),
            risksAndOpenIssues,
            requiredRiskDisclosures: expectedRiskDisclosures,
          });
        }
        this.reportValidator.validate({
          manifest: evidenceManifest,
          report: candidate,
          resolver: input.evidenceResolver,
          requireCoverage: strictV2,
          validatePayloadSchema: strictV2,
        });
        deliverable = candidate;
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        validationFeedback = [error instanceof Error ? error.message : String(error)];
      }
    }
    if (!deliverable) throw new Error('deliverable generation exhausted without a validated result');

    const artifact = await this.dependencies.artifacts.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'deliverable',
      relativePath: `deliverables/final-r${input.revisionRound ?? 0}.json`,
      schemaVersion: `${contract.entry.envelope_version}-review-gated`,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
      value: deliverable,
    });
    return {
      deliverable,
      deliverableArtifactId: artifact.id,
    };
  }
  async revise(input: CurrentDeliverableRevisionInput): Promise<CurrentDeliverableGenerateResult> {
    if (input.review.revisionRound !== 0) {
      throw new Error('deliverable revision requires a round 0 Review');
    }
    if (!input.reviewArtifactId.trim()) {
      throw new Error('deliverable revision requires a sealed authorizing Review Artifact');
    }
    assertValidReportReviewArtifact(input.review);
    const revisionInstruction = input.review.dimensions
      .flatMap((dimension) => dimension.issues)
      .join('; ');
    if (input.plan.plan.deliverable_type === 'research_strategy_report') {
      if (!input.currentDeliverable || !isResearchStrategyPayloadV2(input.currentDeliverable.payload)) {
        throw new Error('research strategy revision requires the current v2 Canonical Deliverable');
      }
      const currentDraft = researchStrategyContentDraftFromPayload(
        input.currentDeliverable.payload,
        input.currentDeliverable.methodSummary,
      );
      const reviewIssues = input.review.dimensions.flatMap((dimension) => (
        (dimension.revisionIssues ?? []).map((issue) => ({
          id: issue.id,
          dimensionId: dimension.id,
          issue: redactString(issue.message),
          targetNodeIds: [...issue.targetNodeIds],
        }))
      ));
      if (reviewIssues.length === 0) {
        throw new Error('semantic revision requires sealed Review revisionIssues');
      }
      const allowedReviewIssueTargets = new Map(reviewIssues.map((issue) => (
        [issue.id, new Set(issue.targetNodeIds)] as const
      )));
      const patch = await this.dependencies.llm.generateStructured<ResearchStrategyContentPatchV1>({
        prompt: [
          'Return one research-strategy-content-patch-v1 in semantic_revision mode.',
          'Resolve only the final review issues through explicit patch operations; never return or rewrite the whole Draft.',
          'Use replace_semantic_text only for the exact semantic units that need weaker or more accurate wording.',
          'Use replace_direct_answer_binding or replace_support for Evidence, status, confidence, and validation changes.',
          'Every semantic operation must include reviewIssueId and reason. Its target must be authorized by that exact context.reviewIssues item.',
          'Do not delete or reorder existing Direct Answers, findings, Blocks, or Block items. Preserve every requested typed content Block.',
          'Do not output Canonical IDs, Coverage, FindingGraph, risk identities, source pointers, or requestedArtifactBindings.',
          `Review issues: ${redactString(revisionInstruction)}`,
        ].join('\n'),
        schema: researchStrategyPatchSchema(),
        schemaName: 'research-strategy-content-patch-v1',
        context: {
          mode: 'semantic_revision',
          authorizingReviewArtifactId: input.reviewArtifactId,
          draft: redactSensitiveValue(currentDraft),
          allowedQuestionIds: (input.problemGraph as ProblemGraph).questions.map(({ id }) => id),
          allowedEvidence: input.evidenceManifest.value.entries.map(({ id, evidenceClass, sourceUrl }) => ({
            id,
            evidenceClass,
            ...(sourceUrl ? { sourceUrl } : {}),
          })),
          requestedArtifacts: (input.finalizedRequirement as ResearchTaskV2).requested_artifacts ?? [],
          reviewIssues,
        },
        receipt: {
          stage: 'deliverable_repair',
          attemptId: input.attempt.id,
          stepNo: input.stepNo,
          expectedModel: input.expectedModel,
        },
      });
      this.dependencies.validator.validateSchemaOrThrow(
        researchStrategyPatchSchema(),
        patch.data,
        'research-strategy-content-patch-v1',
      );
      const revised = applyResearchStrategyContentPatch({
        source: currentDraft,
        patch: patch.data,
        mode: 'semantic_revision',
        problemGraph: input.problemGraph as ProblemGraph,
        evidenceManifest: input.evidenceManifest.value,
        requestedArtifacts: (input.finalizedRequirement as ResearchTaskV2).requested_artifacts ?? [],
        allowedReviewIssueTargets,
      });
      return this.generate({
        ...input,
        strategyDraftOverride: revised.draft,
        strategyFidelity: {
          mode: 'semantic_revision',
          sourceDraft: currentDraft,
          result: revised.fidelity,
          repairOperations: patch.data.operations.map(patchOperationAudit),
        },
        revisionInstruction,
        revisionRound: 1,
      });
    }
    return this.generate({
      ...input,
      revisionInstruction,
      revisionRound: 1,
    });
  }
}
