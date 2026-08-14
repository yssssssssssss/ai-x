import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  EvidenceEntry,
  CurrentExecutionPlan,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
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
const researchPlanSchemaPath = join(
  process.cwd(),
  'schemas/deliverables/research-plan.schema.json',
);
const researchPlanPayloadSchema = JSON.parse(
  readFileSync(researchPlanSchemaPath, 'utf8'),
) as object;

const deliverableDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'methodSummary',
    'findingGraph',
    'payload',
    'recommendations',
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
    payload: researchPlanPayloadSchema,
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
    risksAndOpenIssues: { type: 'array', items: { type: 'string' } },
  },
} as const;

type DeliverableEnvelope = ResearchDeliverableEnvelope<ResearchPlanPayload>;
type DeliverableDraft = Pick<
  DeliverableEnvelope,
  | 'methodSummary'
  | 'findingGraph'
  | 'payload'
  | 'recommendations'
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
  finalizedRequirement?: unknown;
  problemGraph?: unknown;
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
  outputs: unknown[];
  gaps: string[];
  expectedModel: string;
  stepNo?: number;
  revisionInstruction?: string;
  activeLease?: ControlExecutionLease;
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
    const context = {
      researchGoal: redactString(input.researchGoal),
      ...(input.finalizedRequirement === undefined
        ? {}
        : { finalizedRequirement: redactSensitiveValue(input.finalizedRequirement) }),
      ...(input.problemGraph === undefined ? {} : { problemGraph: redactSensitiveValue(input.problemGraph) }),
      ...(input.revisionInstruction === undefined ? {} : { revisionInstruction: redactString(input.revisionInstruction) }),
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
      prompt:
        'Generate only the content fields for a research plan deliverable. '
        + 'Do not generate version, task, plan, attempt, deliverable type, evidence manifest identifiers, or capability provenance.'
        + (input.revisionInstruction ? ' Address the review issues in the revision instruction.' : ''),
      schema: deliverableDraftSchema,
      schemaName: 'research-plan-deliverable-content',
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
      deliverableDraftSchema,
      contentDraft,
      'research-plan-deliverable-content',
    );

    const draft = contentDraft as DeliverableDraft;
    const risksAndOpenIssues = [...(draft.risksAndOpenIssues ?? [])];
    const observedRisks = new Set(risksAndOpenIssues);
    for (const gap of sanitizedGaps) {
      if (observedRisks.has(gap)) continue;
      observedRisks.add(gap);
      risksAndOpenIssues.push(gap);
    }
    const deliverable: DeliverableEnvelope = {
      version: 'research-deliverable-v1',
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      deliverableType: input.plan.plan.deliverable_type,
      evidenceManifestArtifactId: input.evidenceManifest.artifact.id,
      methodSummary: draft.methodSummary,
      findingGraph: draft.findingGraph,
      payload: draft.payload,
      recommendations: draft.recommendations,
      risksAndOpenIssues,
      capabilityProvenance: outputData.provenance,
    };

    this.dependencies.validator.validateFileOrThrow(researchPlanSchemaPath, deliverable.payload);
    this.reportValidator.validate({
      manifest: evidenceManifest,
      report: deliverable,
      resolver: input.evidenceResolver,
    });

    const artifact = await this.dependencies.artifacts.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'deliverable',
      relativePath: 'deliverables/final.json',
      schemaVersion: 'research-deliverable-v1-review-gated',
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
    const revisionInstruction = input.review.dimensions
      .flatMap((dimension) => dimension.issues)
      .join('; ');
    return this.generate({
      ...input,
      revisionInstruction,
    });
  }
}
