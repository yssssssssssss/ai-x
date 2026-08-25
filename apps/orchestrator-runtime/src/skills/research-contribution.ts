import type {
  EvidenceClass,
  EvidenceManifest,
  ResearchContributionV1,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';

export type ResearchContributionValidationKind =
  | 'evidence_lineage_mismatch'
  | 'duplicate_unit_key'
  | 'unknown_question'
  | 'unknown_evidence'
  | 'supported_without_factual_evidence'
  | 'synthetic_supported'
  | 'frozen_identity_mismatch'
  | 'contribution_type_mismatch'
  | 'requested_artifact_mismatch';

export class ResearchContributionValidationError extends Error {
  constructor(
    public readonly kind: ResearchContributionValidationKind,
    public readonly issueIds: string[],
  ) {
    const uniqueIssueIds = [...new Set(issueIds)];
    super(`research contribution ${kind}: ${uniqueIssueIds.join(', ')}`);
    this.name = 'ResearchContributionValidationError';
    this.issueIds = uniqueIssueIds;
  }
}

function contributionError(
  kind: ResearchContributionValidationKind,
  issueIds: string[],
): never {
  throw new ResearchContributionValidationError(kind, issueIds);
}

const FACTUAL_ROOT_CLASSES = new Set<EvidenceClass>([
  'public_source',
  'screenshot',
  'dataset',
]);

export interface ValidateResearchContributionInput {
  contribution: ResearchContributionV1;
  allowedQuestionIds: readonly string[];
  evidenceManifest: EvidenceManifest;
  expected?: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    invocationId: string;
    skillId: string;
    contributionTypes: readonly ResearchContributionV1['contributionTypes'][number][];
    requestedArtifactTypes: readonly ResearchContributionV1['units'][number]['requestedArtifactTypes'][number][];
  };
  validator?: SchemaValidator;
}

/**
 * Validates one sealed-candidate Contributor output at the Contribution seam.
 * Schema validation owns shape; this function owns lineage and Evidence truth.
 */
export function validateResearchContribution(input: ValidateResearchContributionInput): void {
  const { contribution, evidenceManifest } = input;
  (input.validator ?? new SchemaValidator()).validateOrThrow(
    'research-contribution-v1',
    contribution,
  );
  if (input.expected) {
    const expected = input.expected;
    if (
      contribution.taskId !== expected.taskId
      || contribution.planVersionId !== expected.planVersionId
      || contribution.attemptId !== expected.attemptId
      || contribution.invocationId !== expected.invocationId
      || contribution.skillId !== expected.skillId
    ) {
      contributionError('frozen_identity_mismatch', [
        contribution.taskId,
        contribution.planVersionId,
        contribution.attemptId,
        contribution.invocationId,
        contribution.skillId,
      ]);
    }
    if (
      contribution.contributionTypes.length !== expected.contributionTypes.length
      || !contribution.contributionTypes.every((type) => expected.contributionTypes.includes(type))
    ) contributionError('contribution_type_mismatch', contribution.contributionTypes);
    const allowedArtifacts = new Set(expected.requestedArtifactTypes);
    const unknownArtifact = contribution.units
      .flatMap(({ requestedArtifactTypes }) => requestedArtifactTypes)
      .find((artifact) => !allowedArtifacts.has(artifact));
    if (unknownArtifact) contributionError('requested_artifact_mismatch', [unknownArtifact]);
  }

  if (
    contribution.taskId !== evidenceManifest.taskId
    || contribution.planVersionId !== evidenceManifest.planVersionId
    || contribution.attemptId !== evidenceManifest.attemptId
  ) {
    contributionError('evidence_lineage_mismatch', [
      contribution.taskId,
      contribution.planVersionId,
      contribution.attemptId,
      evidenceManifest.taskId,
      evidenceManifest.planVersionId,
      evidenceManifest.attemptId,
    ]);
  }

  const allowedQuestions = new Set(input.allowedQuestionIds);
  const evidenceById = new Map(evidenceManifest.entries.map((entry) => [entry.id, entry]));
  const unitKeys = new Set<string>();
  const virtualUserContribution = contribution.contributionTypes.includes('virtual_user_hypothesis');

  for (const unit of contribution.units) {
    if (unitKeys.has(unit.key)) contributionError('duplicate_unit_key', [unit.key]);
    unitKeys.add(unit.key);

    for (const questionId of unit.support.questionIds) {
      if (!allowedQuestions.has(questionId)) {
        contributionError('unknown_question', [unit.key, questionId]);
      }
    }

    const evidenceEntries = unit.support.evidenceIds.map((evidenceId) => {
      const entry = evidenceById.get(evidenceId);
      if (!entry) contributionError('unknown_evidence', [unit.key, evidenceId]);
      return entry;
    });

    const simulationEvidenceIds = evidenceEntries
      .filter(({ evidenceClass }) => evidenceClass === 'simulation')
      .map(({ id }) => id);
    if (
      unit.support.status === 'supported'
      && (virtualUserContribution || simulationEvidenceIds.length > 0)
    ) {
      contributionError('synthetic_supported', [unit.key, ...simulationEvidenceIds]);
    }

    if (
      unit.support.status === 'supported'
      && !evidenceEntries.some(({ evidenceClass }) => FACTUAL_ROOT_CLASSES.has(evidenceClass))
    ) {
      contributionError('supported_without_factual_evidence', [
        unit.key,
        ...unit.support.evidenceIds,
      ]);
    }
  }
}
