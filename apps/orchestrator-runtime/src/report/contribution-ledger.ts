import { createHash } from 'node:crypto';
import type {
  ContributionLedgerV1,
  ResearchContributionUnit,
  ResearchContributionV1,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';

export type ContributionLedgerValidationKind =
  | 'source_lineage_mismatch'
  | 'duplicate_source_unit'
  | 'unknown_source_unit'
  | 'missing_source_unit'
  | 'source_invocation_mismatch'
  | 'source_semantic_hash_mismatch'
  | 'unknown_canonical_node'
  | 'unknown_review_issue';

export class ContributionLedgerValidationError extends Error {
  constructor(
    public readonly kind: ContributionLedgerValidationKind,
    public readonly issueIds: string[],
  ) {
    const uniqueIssueIds = [...new Set(issueIds)];
    super(`contribution ledger ${kind}: ${uniqueIssueIds.join(', ')}`);
    this.name = 'ContributionLedgerValidationError';
    this.issueIds = uniqueIssueIds;
  }
}

function ledgerError(kind: ContributionLedgerValidationKind, issueIds: string[]): never {
  throw new ContributionLedgerValidationError(kind, issueIds);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/** Stable source identity used by adapters, the Ledger, and later fidelity checks. */
export function researchContributionUnitSemanticHash(unit: ResearchContributionUnit): string {
  const semanticValue = {
    kind: unit.kind,
    title: unit.title,
    statement: unit.statement,
    businessImplication: unit.businessImplication ?? null,
    recommendedAction: unit.recommendedAction ?? null,
    requestedArtifactTypes: sorted(unit.requestedArtifactTypes),
    support: {
      questionIds: sorted(unit.support.questionIds),
      evidenceIds: sorted(unit.support.evidenceIds),
      status: unit.support.status,
      confidence: unit.support.confidence,
      validationNeeded: unit.support.validationNeeded,
    },
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(semanticValue)).digest('hex')}`;
}

export interface ContributionLedgerSource {
  contributionArtifactId: string;
  contribution: ResearchContributionV1;
}

export interface ValidateContributionLedgerInput {
  ledger: ContributionLedgerV1;
  sources: readonly ContributionLedgerSource[];
  canonicalNodeIds?: readonly string[];
  reviewIssueIds?: readonly string[];
  validator?: SchemaValidator;
}

interface ExpectedSourceUnit {
  artifactId: string;
  invocationId: string;
  unit: ResearchContributionUnit;
}

function sourceIdentity(artifactId: string, unitKey: string): string {
  return `${artifactId}\u0000${unitKey}`;
}

/** Validates exact-once source disposition and all externally supplied IDs. */
export function validateContributionLedger(input: ValidateContributionLedgerInput): void {
  const { ledger } = input;
  (input.validator ?? new SchemaValidator()).validateOrThrow('contribution-ledger-v1', ledger);

  const expectedByIdentity = new Map<string, ExpectedSourceUnit>();
  for (const source of input.sources) {
    const contribution = source.contribution;
    if (
      contribution.taskId !== ledger.taskId
      || contribution.planVersionId !== ledger.planVersionId
      || contribution.attemptId !== ledger.attemptId
    ) {
      ledgerError('source_lineage_mismatch', [
        ledger.taskId,
        ledger.planVersionId,
        ledger.attemptId,
        contribution.taskId,
        contribution.planVersionId,
        contribution.attemptId,
      ]);
    }
    for (const unit of contribution.units) {
      const identity = sourceIdentity(source.contributionArtifactId, unit.key);
      if (expectedByIdentity.has(identity)) {
        ledgerError('duplicate_source_unit', [source.contributionArtifactId, unit.key]);
      }
      expectedByIdentity.set(identity, {
        artifactId: source.contributionArtifactId,
        invocationId: contribution.invocationId,
        unit,
      });
    }
  }

  const canonicalNodeIds = input.canonicalNodeIds
    ? new Set(input.canonicalNodeIds)
    : null;
  const reviewIssueIds = input.reviewIssueIds
    ? new Set(input.reviewIssueIds)
    : null;
  const seen = new Set<string>();

  for (const entry of ledger.entries) {
    const identity = sourceIdentity(entry.contributionArtifactId, entry.sourceUnitKey);
    if (seen.has(identity)) {
      ledgerError('duplicate_source_unit', [entry.contributionArtifactId, entry.sourceUnitKey]);
    }
    seen.add(identity);

    const expected = expectedByIdentity.get(identity);
    if (!expected) {
      ledgerError('unknown_source_unit', [entry.contributionArtifactId, entry.sourceUnitKey]);
    }
    if (entry.invocationId !== expected.invocationId) {
      ledgerError('source_invocation_mismatch', [
        entry.sourceUnitKey,
        entry.invocationId,
        expected.invocationId,
      ]);
    }
    if (entry.sourceSemanticHash !== researchContributionUnitSemanticHash(expected.unit)) {
      ledgerError('source_semantic_hash_mismatch', [entry.sourceUnitKey]);
    }

    if (canonicalNodeIds) {
      const unknownCanonicalNode = entry.canonicalNodeIds.find((id) => !canonicalNodeIds.has(id));
      if (unknownCanonicalNode) ledgerError('unknown_canonical_node', [unknownCanonicalNode]);
    }
    if (reviewIssueIds) {
      const unknownReviewIssue = entry.reviewIssueIds.find((id) => !reviewIssueIds.has(id));
      if (unknownReviewIssue) ledgerError('unknown_review_issue', [unknownReviewIssue]);
    }
  }

  for (const [identity, expected] of expectedByIdentity) {
    if (!seen.has(identity)) {
      ledgerError('missing_source_unit', [expected.artifactId, expected.unit.key]);
    }
  }
}
