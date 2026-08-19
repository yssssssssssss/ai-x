import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  EvidenceEntry,
  CurrentExecutionPlan,
  ResearchDeliverableEnvelope,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  EvidenceArtifactResolver,
  EvidenceManifest,
  EvidenceService,
} from '../evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../evidence/report-evidence-validator.ts';
import {
  type MaterializeStepOutput,
  type SynthesisMaterializerLike,
} from './synthesis-materializer.ts';
import { redactSensitiveValue, redactString } from '../runtime/redaction.ts';
import type { ReportReviewArtifact } from './report-review-service.ts';
import {
  resolveDeliverableContractById,
  resolveExecutionDeliverableContract,
} from './deliverable-registry.ts';
import type { VerifiedVisualAnnotationBinding } from './report-composition-service.ts';
import type { VerifiedVisualAsset } from './visual-asset-service.ts';
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

export interface CurrentDeliverableGenerateInput {
  task: { id: string };
  plan: {
    id: string;
    plan: Pick<CurrentExecutionPlan, 'deliverable_type'> & { steps?: unknown[] };
  };
  attempt: { id: string };
  researchGoal: string;
  finalizedRequirement: unknown;
  problemGraph: unknown;
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
  outputs: unknown[];
  gaps: string[];
  expectedModel: string;
  stepNo?: number;
  revisionInstruction?: string;
  revisionRound?: 0 | 1;
  activeLease?: ControlExecutionLease;
  visualAssets?: readonly VerifiedVisualAsset[];
  visualAnnotationBindings?: readonly VerifiedVisualAnnotationBinding[];
}

export interface CurrentDeliverableGenerateResult {
  deliverable: DeliverableEnvelope;
  deliverableArtifactId: string;
}
export interface CurrentDeliverableRevisionInput extends CurrentDeliverableGenerateInput {
  review: ReportReviewArtifact;
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function deliverableDraftRecord(value: unknown): Record<string, unknown> | null {
  const root = unknownRecord(value);
  if (!root) return null;
  const queue: Record<string, unknown>[] = [root];
  const seen = new Set<Record<string, unknown>>();
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (REQUIRED_DRAFT_KEYS.every((key) => Object.hasOwn(candidate, key))) return candidate;
    for (const child of Object.values(candidate)) {
      const nested = unknownRecord(child);
      if (nested) queue.push(nested);
    }
  }
  return root;
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
    && manifest.source.kind === 'user_upload'
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
      || asset.manifestArtifact.schemaVersion !== 'visual-asset-manifest-v1'
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

function assertVisualPreflight(
  deliverableId: string,
  inventory: VerifiedVisualInventory | undefined,
): void {
  if (deliverableId !== 'competitive_analysis_report' && deliverableId !== 'design_audit_report') return;
  if (!inventory || inventory.assets.length === 0) {
    if (deliverableId === 'competitive_analysis_report') return;
    throw new Error(`${deliverableId} requires a non-empty verified visual inventory before synthesis`);
  }
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
): void {
  if (deliverableId !== 'competitive_analysis_report' && deliverableId !== 'design_audit_report') return;
  const value = unknownRecord(payload);
  if (!value) throw new Error('deliverable payload must be an object');
  if (deliverableId === 'competitive_analysis_report') {
    const comparisons = value.screenshotComparisons;
    if (!Array.isArray(comparisons)) {
      throw new Error('competitive screenshot comparisons require a verified visual inventory');
    }
    if (comparisons.length === 0) {
      if (inventory && inventory.assets.length > 0) {
        throw new Error('competitive screenshot comparisons are required for a verified visual inventory');
      }
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
    const producerVisualInventory = visualInventory?.assets.map((asset) => ({
      assetId: asset.artifact.id,
      role: visualInventory?.roles.get(asset.artifact.id),
      ...(asset.manifest.derivedFrom === null ? {} : { derivedFromAssetId: asset.manifest.derivedFrom?.assetId }),
      ...(visualInventory?.annotationBindings.get(asset.artifact.id)
        ? { findingIds: visualInventory.annotationBindings.get(asset.artifact.id)!.findingIds }
        : {}),
    }));
    const context = {
      researchGoal: redactString(input.researchGoal),
      finalizedRequirement: redactSensitiveValue(input.finalizedRequirement),
      problemGraph: redactSensitiveValue(input.problemGraph),
      ...(requiredCoverage === undefined ? {} : { coverageRequirements: requiredCoverage }),
      ...(input.revisionInstruction === undefined ? {} : { revisionInstruction: redactString(input.revisionInstruction) }),
      ...(visualInventory === undefined ? {} : {
        verifiedVisualAssetIds: visualInventory.ids,
        verifiedVisualInventory: producerVisualInventory,
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
          + '\nEvery evidenceIds entry must reference only context.verifiedEvidence[].evidenceId. Never place a Visual Asset id in evidenceIds; Visual Asset ids are allowed only in typed visual fields such as screenshotComparisons.assetIds.'
          + '\nFor findingGraph findings with kind "fact", every evidenceIds entry must have evidenceClass public_source, screenshot, or dataset. user_input, knowledge, simulation, and derived evidence cannot root a fact.'
          + (contract.entry.id === 'competitive_analysis_report'
            && (!visualInventory || visualInventory.assets.length === 0)
            ? '\nNo verified visual Asset inventory exists. Return an empty screenshotComparisons array and never invent an Asset id.'
            : visualInventory === undefined
              ? ''
              : '\nVerified visual Asset inventory: reference only typed Asset ids in context.verifiedVisualAssetIds; never invent or reuse any other Asset id.'
                + (contract.entry.id === 'design_audit_report'
                  ? ' For each annotatedScreenshots entry, use one annotation assetId and one issueId from that same annotation item\'s findingIds in context.verifiedVisualInventory; payload.issues must contain the same issueId.'
                  : ''))
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
        : generated.data;
    };
    let validationFeedback: string[] = [];
    let deliverable: DeliverableEnvelope | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const generatedDraft = await generateDraft(validationFeedback);
      const generatedRecord = unknownRecord(generatedDraft);
      const contentDraft = generatedRecord
        ? { ...generatedRecord, payload: projectPayloadToSchema(generatedRecord.payload, contract.payloadSchema) }
        : generatedDraft;
      try {
        this.dependencies.validator.validateSchemaOrThrow(draftSchema, contentDraft, schemaName);
        const draft = contentDraft as DeliverableDraft;
        if (strictV2) assertPayloadVisualReferences(contract.entry.id, draft.payload, visualInventory);
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
    const revisionInstruction = input.review.dimensions
      .flatMap((dimension) => dimension.issues)
      .join('; ');
    return this.generate({
      ...input,
      revisionInstruction,
      revisionRound: 1,
    });
  }
}
