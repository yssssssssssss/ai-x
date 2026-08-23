import type { ControlArtifact } from '../../../../database/control-plane.ts';
import type { EvidenceEntry } from '../../../../packages/api-contract/research-deliverable.ts';
import { EvidenceService } from '../evidence/evidence-service.ts';
import { containsBlockedSensitiveData, redactSensitiveValue } from '../runtime/redaction.ts';

export type SynthesisSemanticRole = 'fact_source' | 'knowledge' | 'analysis' | 'inference' | 'review';
export type SynthesisActorType = 'knowledge' | 'tool' | 'skill' | 'llm' | 'reviewer';

export interface SynthesisMaterial {
  stepNo: number;
  actorType: SynthesisActorType;
  actorId: string;
  questionIds: string[];
  artifactId: string;
  artifactContentSha256: string;
  value: unknown;
  semanticRole: SynthesisSemanticRole;
}

export interface SynthesisMaterializerLike {
  materialize(input: MaterializeInput): Promise<SynthesisMaterial[]>;
}

export interface SynthesisArtifactReader {
  readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }>;
}

export interface SynthesisArtifactValidator {
  validateArtifact?(value: unknown, artifact: ControlArtifact): void | Promise<void>;
}

export interface MaterializeStepOutput {
  stepNo: number;
  actorType: SynthesisActorType;
  actorId: string;
  questionIds?: string[];
  kind: string;
  state: 'succeeded' | 'failed' | 'skipped';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  artifact: {
    id: string;
    contentSha256: string | null;
    state: string;
  };
}

export interface MaterializeInput {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  outputs: readonly MaterializeStepOutput[];
  evidenceEntries?: readonly EvidenceEntry[];
  validator?: SynthesisArtifactValidator;
}

export type SynthesisMaterializationErrorCode =
  | 'invalid_step_output'
  | 'artifact_not_sealed'
  | 'artifact_mismatch'
  | 'artifact_schema_mismatch'
  | 'artifact_sensitive'
  | 'artifact_blocked';

export class SynthesisMaterializationError extends Error {
  constructor(
    readonly code: SynthesisMaterializationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SynthesisMaterializationError';
  }
}

const KIND_BY_ACTOR: Record<SynthesisActorType, string> = {
  knowledge: 'knowledge_output',
  tool: 'tool_output',
  skill: 'skill_output',
  llm: 'llm_output',
  reviewer: 'review_output',
};

const SCHEMAS_BY_KIND: Record<string, readonly string[]> = {
  knowledge_output: ['knowledge-bundle-v1'],
  tool_output: ['tool-output-v1'],
  skill_output: ['skill-output-v1', 'skill-output-v2'],
  llm_output: ['llm-output-v1'],
  review_output: ['review-output-v1'],
};
const EVIDENCE_SERVICE = new EvidenceService();

function isRealToolEvidence(entry: EvidenceEntry): boolean {
  return entry.kind === 'tool_output'
    && entry.evidenceClass !== 'derived'
    && entry.sensitivity !== 'sensitive'
    && entry.redaction !== 'blocked'
    && entry.toolProof?.executionMode === 'real'
    && entry.toolProof.implementationId !== 'unknown'
    && entry.toolProof.redactedOutputHash.startsWith('sha256:');
}

function roleFor(
  output: MaterializeStepOutput,
  selectedToolEvidence: readonly EvidenceEntry[],
): SynthesisSemanticRole | null {
  if (output.actorType === 'tool') return selectedToolEvidence.length > 0 ? 'fact_source' : null;
  if (output.actorType === 'knowledge') return 'knowledge';
  if (output.actorType === 'skill') return 'analysis';
  if (output.actorType === 'llm') return 'inference';
  return 'review';
}

function redactMaterialValue(value: unknown, key = ''): unknown {
  if (/^(?:prompt|fullPrompt|systemPrompt)$/iu.test(key)) return '[REDACTED_PROMPT]';
  if (Array.isArray(value)) return value.map((item) => redactMaterialValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactMaterialValue(child, childKey),
      ]),
    );
  }
  return redactSensitiveValue(value, { pii: 'mask' }, key);
}

function assertValidStep(output: MaterializeStepOutput, input: MaterializeInput): void {
  if (
    output.state !== 'succeeded'
    || output.artifact.state !== 'SEALED'
    || !output.artifact.contentSha256
    || output.taskId !== input.taskId
    || output.planVersionId !== input.planVersionId
    || output.attemptId !== input.attemptId
    || output.artifact.id.length === 0
    || output.kind !== KIND_BY_ACTOR[output.actorType]
  ) {
    throw new SynthesisMaterializationError(
      'invalid_step_output',
      `step ${output.stepNo} is not a valid succeeded sealed output`,
    );
  }
}

function assertArtifact(
  output: MaterializeStepOutput,
  artifact: ControlArtifact,
  input: MaterializeInput,
): void {
  if (
    artifact.id !== output.artifact.id
    || artifact.state !== 'SEALED'
    || artifact.contentSha256 === null
    || artifact.contentSha256 !== output.artifact.contentSha256
    || artifact.taskId !== input.taskId
    || artifact.planVersionId !== input.planVersionId
    || artifact.attemptId !== input.attemptId
    || artifact.kind !== output.kind
  ) {
    throw new SynthesisMaterializationError(
      'artifact_mismatch',
      `verified Artifact ${artifact.id} does not match step ${output.stepNo}`,
    );
  }
  const acceptedSchemas = SCHEMAS_BY_KIND[output.kind];
  if (acceptedSchemas && !acceptedSchemas.includes(artifact.schemaVersion)) {
    throw new SynthesisMaterializationError(
      'artifact_schema_mismatch',
      `Artifact ${artifact.id} has unexpected schema ${artifact.schemaVersion}`,
    );
  }
  if (/^(?:sensitive|confidential|secret|blocked)$/iu.test(artifact.sensitivity)) {
    throw new SynthesisMaterializationError(
      'artifact_sensitive',
      `Artifact ${artifact.id} has blocked sensitivity ${artifact.sensitivity}`,
    );
  }
}

export class SynthesisMaterializer {
  constructor(
    private readonly reader: SynthesisArtifactReader,
    private readonly defaultValidator?: SynthesisArtifactValidator,
  ) {}

  async materialize(input: MaterializeInput): Promise<SynthesisMaterial[]> {
    const evidenceEntries = input.evidenceEntries ?? [];
    const materials: SynthesisMaterial[] = [];
    for (const output of input.outputs) {
      assertValidStep(output, input);
      const selectedToolEvidence = output.actorType === 'tool'
        ? evidenceEntries.filter((entry) => (
            entry.artifactId === output.artifact.id
            && entry.artifactContentSha256 === output.artifact.contentSha256
            && isRealToolEvidence(entry)
          ))
        : [];
      const role = roleFor(output, selectedToolEvidence);
      if (!role) continue;
      const verified = await this.reader.readVerifiedJson<unknown>(output.artifact.id);
      assertArtifact(output, verified.artifact, input);
      const validator = input.validator ?? this.defaultValidator;
      let materialValue: unknown = verified.value;
      if (output.actorType === 'tool') {
        await validator?.validateArtifact?.(verified.value, verified.artifact);
        const evidenceResolver = {
          resolveArtifact: (artifactId: string) => artifactId === verified.artifact.id
            ? {
                artifact: {
                  id: verified.artifact.id,
                  contentSha256: verified.artifact.contentSha256!,
                },
                value: verified.value,
              }
            : null,
        };
        materialValue = {
          evidence: selectedToolEvidence.map((entry) => ({
            evidenceId: entry.id,
            jsonPointer: entry.jsonPointer,
            ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
            value: EVIDENCE_SERVICE.resolveEvidenceValue(entry, evidenceResolver),
          })),
        };
      }
      if (containsBlockedSensitiveData(materialValue)) {
        throw new SynthesisMaterializationError(
          'artifact_blocked',
          `Artifact ${verified.artifact.id} contains blocked sensitive business data`,
        );
      }
      if (output.actorType !== 'tool') {
        await validator?.validateArtifact?.(verified.value, verified.artifact);
      }
      materials.push({
        stepNo: output.stepNo,
        actorType: output.actorType,
        actorId: output.actorId,
        questionIds: [...(output.questionIds ?? [])],
        artifactId: verified.artifact.id,
        artifactContentSha256: verified.artifact.contentSha256!,
        value: structuredClone(redactMaterialValue(materialValue)),
        semanticRole: role,
      });
    }
    return materials;
  }
}
