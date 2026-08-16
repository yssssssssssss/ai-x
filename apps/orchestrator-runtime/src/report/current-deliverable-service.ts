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
import type { VerifiedVisualAsset } from './visual-asset-service.ts';
function createDeliverableDraftSchema(payloadSchema: object) {

  return {
  type: 'object',
  additionalProperties: false,
  required: [
    'methodSummary',
    'findingGraph',
    'payload',
    'recommendations',
    'coverage',
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
    payload: payloadSchema,
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
function deliverableSelection(finalizedRequirement: unknown): {
  taskType: string;
  expectedDeliverables: string[];
} | null {
  const requirement = unknownRecord(finalizedRequirement);
  const taskType = requirement?.task_type;
  const expectedDeliverables = requirement?.expected_deliverables;
  const hasTaskType = typeof taskType === 'string' && taskType.trim().length > 0;
  const hasExpectedDeliverables = Array.isArray(expectedDeliverables);
  if (!hasTaskType && !hasExpectedDeliverables) return null;
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
function verifiedVisualAssetIds(input: CurrentDeliverableGenerateInput): string[] | undefined {
  if (input.visualAssets === undefined) return undefined;
  const ids = new Set<string>();
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
      || asset.artifact.id !== asset.manifest.assetId
      || (asset.manifest.exportPolicy !== 'allow' && asset.manifest.exportPolicy !== 'mask')
    ) {
      throw new Error(`visual Asset ${asset.artifact.id} is not an exact sealed exportable verified inventory item`);
    }
    if (ids.has(asset.artifact.id)) {
      throw new Error(`verified visual Asset inventory contains duplicate id ${asset.artifact.id}`);
    }
    ids.add(asset.artifact.id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function visualPayloadReferences(deliverableId: string, payload: unknown): string[] {
  const value = unknownRecord(payload);
  if (!value) return [];
  if (deliverableId === 'competitive_analysis_report') {
    return Array.isArray(value.screenshotComparisons)
      ? value.screenshotComparisons.flatMap((candidate) => {
          const comparison = unknownRecord(candidate);
          return Array.isArray(comparison?.assetIds)
            ? comparison.assetIds.filter((assetId): assetId is string => typeof assetId === 'string')
            : [];
        })
      : [];
  }
  if (deliverableId === 'design_audit_report') {
    return Array.isArray(value.annotatedScreenshots)
      ? value.annotatedScreenshots.flatMap((candidate) => {
          const screenshot = unknownRecord(candidate);
          return typeof screenshot?.assetId === 'string' ? [screenshot.assetId] : [];
        })
      : [];
  }
  return [];
}

function assertPayloadVisualReferences(
  deliverableId: string,
  payload: unknown,
  verifiedIds: readonly string[] | undefined,
): void {
  if (verifiedIds === undefined) return;
  const verified = new Set(verifiedIds);
  for (const assetId of visualPayloadReferences(deliverableId, payload)) {
    if (!verified.has(assetId)) {
      throw new Error(`unverified Asset ${assetId} is absent from the verified visual Asset inventory`);
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
    const selection = deliverableSelection(input.finalizedRequirement);
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
    const draftSchema = createDeliverableDraftSchema(contract.payloadSchema);
    const schemaName = `${contract.entry.id.replace(/_/gu, '-')}-deliverable-content`;
    const verifiedVisualIds = verifiedVisualAssetIds(input);
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
      ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
      value: redactSensitiveValue(
        this.dependencies.evidence.resolveEvidenceValue(entry, input.evidenceResolver),
      ),
    }));
    const requiredCoverage = coverageRequirements(input.finalizedRequirement, input.problemGraph);
    const context = {
      researchGoal: redactString(input.researchGoal),
      finalizedRequirement: redactSensitiveValue(input.finalizedRequirement),
      problemGraph: redactSensitiveValue(input.problemGraph),
      coverageRequirements: requiredCoverage,
      ...(input.revisionInstruction === undefined ? {} : { revisionInstruction: redactString(input.revisionInstruction) }),
      ...(verifiedVisualIds === undefined ? {} : { verifiedVisualAssetIds: verifiedVisualIds }),
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
    const generated = await this.dependencies.llm.generateStructured<DeliverableDraft & {
      capabilityProvenance?: unknown;
    }>({
      prompt: contract.synthesisPrompt
        + (verifiedVisualIds === undefined
          ? ''
          : '\nVerified visual Asset inventory: reference only Asset ids in context.verifiedVisualAssetIds; never invent or reuse any other Asset id.')
        + (input.revisionInstruction ? '\nAddress the review issues in the revision instruction.' : ''),
      schema: draftSchema,
      schemaName,
      context,
      receipt: {
        stage: 'deliverable',
        attemptId: input.attempt.id,
        stepNo,
        expectedModel: input.expectedModel,
      },
    });
    const generatedRecord = unknownRecord(generated.data);
    const contentDraft: unknown = generatedRecord
      ? Object.fromEntries(
          Object.entries(generatedRecord).filter(([key]) => key !== 'capabilityProvenance'),
        )
      : generated.data;
    this.dependencies.validator.validateSchemaOrThrow(
      draftSchema,
      contentDraft,
      schemaName,
    );

    const draft = contentDraft as DeliverableDraft;
    assertPayloadVisualReferences(contract.entry.id, draft.payload, verifiedVisualIds);
    const risksAndOpenIssues = [...(draft.risksAndOpenIssues ?? [])];
    const observedRisks = new Set(risksAndOpenIssues);
    for (const gap of sanitizedGaps) {
      if (observedRisks.has(gap)) continue;
      observedRisks.add(gap);
      risksAndOpenIssues.push(gap);
    }
    const deliverable: DeliverableEnvelope = {
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

    this.dependencies.validator.validateFileOrThrow(contract.payloadSchemaPath, deliverable.payload);
    this.reportValidator.validate({
      manifest: evidenceManifest,
      report: deliverable,
      resolver: input.evidenceResolver,
      requireCoverage: true,
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
