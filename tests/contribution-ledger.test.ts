import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ContributionLedgerV1,
  ResearchContributionV1,
} from '../packages/api-contract/research-deliverable.ts';
import {
  ContributionLedgerValidationError,
  researchContributionUnitSemanticHash,
  validateContributionLedger,
} from '../apps/orchestrator-runtime/src/report/contribution-ledger.ts';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

function contribution(): ResearchContributionV1 {
  return {
    version: 'research-contribution-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    invocationId: 'invocation-market',
    skillId: 'competitive-web-research',
    contributionTypes: ['market_landscape'],
    units: [
      {
        key: 'market.finding.1',
        kind: 'finding',
        title: '新品验证',
        statement: '众筹频道主要承接新品验证。',
        requestedArtifactTypes: ['strategy_map'],
        support: {
          questionIds: ['question-market'],
          evidenceIds: ['evidence-public'],
          status: 'supported',
          confidence: 0.8,
          validationNeeded: '',
        },
      },
      {
        key: 'market.hypothesis.1',
        kind: 'hypothesis',
        title: '信任线索',
        statement: '强化项目背书可能提升访问后的继续探索。',
        requestedArtifactTypes: [],
        support: {
          questionIds: ['question-market'],
          evidenceIds: [],
          status: 'provisional',
          confidence: 0.5,
          validationNeeded: '通过真实访谈和行为数据验证。',
        },
      },
    ],
    limitations: [],
    openQuestions: [],
  };
}

function validLedger(source = contribution()): ContributionLedgerV1 {
  return {
    version: 'contribution-ledger-v1',
    taskId: source.taskId,
    planVersionId: source.planVersionId,
    attemptId: source.attemptId,
    entries: source.units.map((unit, index) => ({
      contributionArtifactId: 'artifact-contribution-market',
      invocationId: source.invocationId,
      sourceUnitKey: unit.key,
      sourceSemanticHash: researchContributionUnitSemanticHash(unit),
      disposition: 'included',
      canonicalNodeIds: [`canonical-${index + 1}`],
      reviewIssueIds: [],
    })),
  };
}

function validate(ledger: ContributionLedgerV1, source = contribution()): void {
  validateContributionLedger({
    ledger,
    sources: [{
      contributionArtifactId: 'artifact-contribution-market',
      contribution: source,
    }],
    canonicalNodeIds: ['canonical-1', 'canonical-2', 'canonical-conflict'],
    reviewIssueIds: ['review-merge', 'review-conflict', 'review-omit'],
  });
}

function expectLedgerError(
  ledger: ContributionLedgerV1,
  kind: ContributionLedgerValidationError['kind'],
  issueIds: string[],
): void {
  assert.throws(
    () => validate(ledger),
    (error: unknown) => {
      assert.ok(error instanceof ContributionLedgerValidationError);
      assert.equal(error.kind, kind);
      for (const issueId of issueIds) assert.ok(error.issueIds.includes(issueId));
      return true;
    },
  );
}

test('contribution ledger schema is registered and accepts exact-once included entries', () => {
  const spec = resolveSchema('contribution-ledger-v1');
  assert.equal(spec.file, 'contribution-ledger-v1.schema.json');
  assert.ok(loadSchemaText(spec)?.includes('contribution-ledger-v1'));
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow(
    'contribution-ledger-v1',
    validLedger(),
  ));
  assert.doesNotThrow(() => validate(validLedger()));
});

test('contribution ledger schema rejects incomplete dispositions', () => {
  const validator = new SchemaValidator();

  const includedWithoutTarget = validLedger();
  includedWithoutTarget.entries[0]!.canonicalNodeIds = [];
  assert.throws(
    () => validator.validateOrThrow('contribution-ledger-v1', includedWithoutTarget),
    SchemaValidationError,
  );

  for (const disposition of ['merged', 'conflicted', 'omitted'] as const) {
    const noReview = validLedger();
    noReview.entries[0] = {
      ...noReview.entries[0]!,
      disposition,
      canonicalNodeIds: disposition === 'omitted' ? [] : ['canonical-conflict'],
      reason: 'Reviewer disposition required.',
      reviewIssueIds: [],
    };
    assert.throws(
      () => validator.validateOrThrow('contribution-ledger-v1', noReview),
      SchemaValidationError,
      disposition,
    );
  }
});

test('contribution ledger rejects duplicate and missing source units', () => {
  const duplicate = validLedger();
  duplicate.entries.push(structuredClone(duplicate.entries[0]!));
  expectLedgerError(duplicate, 'duplicate_source_unit', [
    'artifact-contribution-market',
    'market.finding.1',
  ]);

  const missing = validLedger();
  missing.entries.pop();
  expectLedgerError(missing, 'missing_source_unit', [
    'artifact-contribution-market',
    'market.hypothesis.1',
  ]);
});

test('contribution ledger rejects unknown source units and changed source hashes', () => {
  const unknown = validLedger();
  unknown.entries[0]!.sourceUnitKey = 'market.unknown';
  expectLedgerError(unknown, 'unknown_source_unit', ['market.unknown']);

  const changed = validLedger();
  changed.entries[0]!.sourceSemanticHash = `sha256:${'0'.repeat(64)}`;
  expectLedgerError(changed, 'source_semantic_hash_mismatch', ['market.finding.1']);
});

test('contribution ledger validates canonical and reviewer references', () => {
  const unknownCanonical = validLedger();
  unknownCanonical.entries[0]!.canonicalNodeIds = ['canonical-missing'];
  expectLedgerError(unknownCanonical, 'unknown_canonical_node', ['canonical-missing']);

  const unknownReview = validLedger();
  unknownReview.entries[0] = {
    ...unknownReview.entries[0]!,
    disposition: 'omitted',
    canonicalNodeIds: [],
    reason: 'Not material to the final decision.',
    reviewIssueIds: ['review-missing'],
  };
  expectLedgerError(unknownReview, 'unknown_review_issue', ['review-missing']);
});

test('contribution ledger rejects lineage mismatch', () => {
  const ledger = validLedger();
  ledger.attemptId = 'attempt-other';
  expectLedgerError(ledger, 'source_lineage_mismatch', ['attempt-other']);
});
