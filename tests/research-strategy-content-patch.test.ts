import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ProblemGraph,
  ResearchStrategyContentPatchV1,
} from '../packages/api-contract/research-deliverable.ts';
import type { RequestedArtifact } from '../packages/api-contract/plan.ts';
import { researchStrategyContentDraftFromPayload } from '../apps/orchestrator-runtime/src/report/research-strategy-deliverable-assembler.ts';
import {
  applyResearchStrategyContentPatch,
  ResearchStrategyContentPatchError,
} from '../apps/orchestrator-runtime/src/report/research-strategy-content-patch.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import type { EvidenceManifest } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import { researchStrategyPayloadV2 } from './fixtures/research-strategy-v2.ts';

const problemGraph: ProblemGraph = {
  version: 'problem-graph-v1',
  questions: [{
    id: 'Q1',
    statement: 'What should change?',
    rationale: 'Decision support',
    priority: 'required',
    success_criterion_ids: ['SC1'],
    evidence_requirements: [],
    acceptance_criteria: ['Direct answer'],
    depends_on: [],
  }],
};

const manifest: EvidenceManifest = {
  version: 'evidence-v1',
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  collectedAt: '2026-08-24T00:00:00.000Z',
  manifestHash: `sha256:${'1'.repeat(64)}`,
  entries: [{
    id: 'E1',
    kind: 'tool_output',
    evidenceClass: 'public_source',
    artifactId: 'artifact-1',
    artifactContentSha256: `sha256:${'2'.repeat(64)}`,
    jsonPointer: '/results/0',
    sourceUrl: 'https://example.test/source',
    stepNo: 1,
    toolProof: {
      implementationId: 'tavily',
      executionMode: 'real',
      redactedOutputHash: `sha256:${'3'.repeat(64)}`,
    },
    sensitivity: 'public',
    redaction: 'masked',
  }],
};

function sourceDraft() {
  return researchStrategyContentDraftFromPayload(
    researchStrategyPayloadV2(),
    'Synthesized verified evidence.',
  );
}

function apply(
  patch: ResearchStrategyContentPatchV1,
  requestedArtifacts: readonly RequestedArtifact[] = ['executive_answers', 'strategy_map', 'prioritized_actions'],
) {
  return applyResearchStrategyContentPatch({
    source: sourceDraft(),
    patch,
    mode: patch.mode,
    problemGraph,
    evidenceManifest: manifest,
    requestedArtifacts: [...requestedArtifacts],
  });
}

test('patch schema accepts a bounded structural support repair', () => {
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_direct_answer_binding',
      questionId: 'Q1',
      answerStatus: 'provisional',
      evidenceIds: ['E1'],
      confidence: 0.6,
      validationNeeded: 'Validate the interpretation.',
    }],
  };

  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    'schemas/skills/research-strategy-content-patch-v1.schema.json',
    patch,
  ));
  const result = apply(patch);
  assert.equal(result.draft.directAnswers[0]?.answerStatus, 'provisional');
  assert.equal(result.fidelity.changedSemanticUnitKeys.length, 0);
});

test('structural patch cannot rewrite semantic text or increase confidence', () => {
  const semanticOperation: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_semantic_text',
      target: { entity: 'direct_answer', key: 'Q1', field: 'answer' },
      value: 'Compressed answer.',
    }],
  };
  assert.throws(
    () => apply(semanticOperation),
    (error: unknown) => error instanceof ResearchStrategyContentPatchError
      && /cannot replace semantic text/u.test(error.message),
  );

  const confidenceIncrease: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_direct_answer_binding',
      questionId: 'Q1',
      answerStatus: 'supported',
      evidenceIds: ['E1'],
      confidence: 1,
      validationNeeded: '',
    }],
  };
  assert.throws(() => apply(confidenceIncrease), /cannot increase Direct Answer confidence/u);
});

test('semantic patch changes only its explicit target and preserves every other unit', () => {
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'semantic_revision',
    operations: [{
      op: 'replace_semantic_text',
      target: { entity: 'direct_answer', key: 'Q1', field: 'answer' },
      value: 'Lead with qualified, verifiable trust signals.',
    }],
  };

  const result = apply(patch);

  assert.equal(result.draft.directAnswers[0]?.answer, 'Lead with qualified, verifiable trust signals.');
  assert.deepEqual(result.changedSemanticUnitKeys, ['direct-answer:001']);
  assert.deepEqual(result.fidelity.removedUnitKeys, []);
});

test('structural patch can append only a missing requested content Block', () => {
  const block = {
    key: 'mind-model-added',
    kind: 'mind_model' as const,
    title: 'Added mind model',
    nodes: [{
      key: 'trust',
      label: 'Trust',
      description: 'Verified trust reduces uncertainty.',
      support: {
        questionIds: ['Q1'],
        evidenceIds: ['E1'],
        confidence: 0.7,
        status: 'provisional' as const,
        validationNeeded: 'Validate the causal interpretation.',
      },
    }],
    edges: [],
  };
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{ op: 'append_content_block', block }],
  };

  const result = apply(patch, ['executive_answers', 'strategy_map', 'prioritized_actions', 'mind_model']);
  assert.equal(result.draft.contentBlocks.at(-1)?.kind, 'mind_model');
  assert.ok(result.fidelity.addedUnitKeys.some((key) => key === 'content-block:mind-model-added'));
  assert.throws(
    () => apply(patch),
    (error: unknown) => error instanceof ResearchStrategyContentPatchError
      && /was not requested/u.test(error.message),
  );
});

test('patch rejects unknown Evidence and unsafe Question aliases', () => {
  const unknownEvidence: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_direct_answer_binding',
      questionId: 'Q1',
      answerStatus: 'supported',
      evidenceIds: ['E9-9'],
      confidence: 0.7,
      validationNeeded: '',
    }],
  };
  assert.throws(() => apply(unknownEvidence), /unknown Evidence E9-9/u);

  const unrelatedQuestion: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_support',
      target: { entity: 'evidence_finding', key: 'evidence-finding-001' },
      support: {
        questionIds: ['Q2_unrelated_topic'],
        evidenceIds: ['E1'],
        confidence: 0.7,
        status: 'provisional',
        validationNeeded: 'Validate.',
      },
    }],
  };
  assert.throws(() => apply(unrelatedQuestion), /unknown Question Q2_unrelated_topic/u);
});
