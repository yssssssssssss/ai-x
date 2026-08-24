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
  | 'synthetic_supported';

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
  'user_input',
  'dataset',
]);

export interface ValidateResearchContributionInput {
  contribution: ResearchContributionV1;
  allowedQuestionIds: readonly string[];
  evidenceManifest: EvidenceManifest;
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
