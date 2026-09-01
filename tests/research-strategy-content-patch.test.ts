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
  overrides: {
    evidenceManifest?: EvidenceManifest;
    problemGraph?: ProblemGraph;
    allowedReviewIssueTargets?: ReadonlyMap<string, ReadonlySet<string>>;
  } = {},
) {
  const allowedReviewIssueTargets = overrides.allowedReviewIssueTargets
    ?? (patch.mode === 'semantic_revision'
      ? new Map([['reasoning_quality:1', new Set(['Q1', 'content-block-001', 'content-block-002', 'limitations', 'openQuestions'])]])
      : undefined);
  return applyResearchStrategyContentPatch({
    source: sourceDraft(),
    patch,
    mode: patch.mode,
    problemGraph: overrides.problemGraph ?? problemGraph,
    evidenceManifest: overrides.evidenceManifest ?? manifest,
    requestedArtifacts: [...requestedArtifacts],
    ...(allowedReviewIssueTargets ? { allowedReviewIssueTargets } : {}),
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

test('structural support repair downgrades non-factual content items instead of rejecting the patch', () => {
  const knowledgeManifest: EvidenceManifest = {
    ...manifest,
    entries: [...manifest.entries, {
      id: 'K1',
      kind: 'knowledge_excerpt',
      evidenceClass: 'knowledge',
      artifactId: 'knowledge-1',
      artifactContentSha256: `sha256:${'4'.repeat(64)}`,
      jsonPointer: '/entries/0',
      stepNo: 2,
      sensitivity: 'internal',
      redaction: 'masked',
    }],
  };
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_support',
      target: {
        entity: 'content_item',
        blockKey: 'content-block-002',
        key: 'content-block-002-item-001',
      },
      support: {
        questionIds: ['Q1'],
        evidenceIds: ['K1'],
        confidence: 0.8,
        status: 'supported',
        validationNeeded: '',
      },
    }],
  };

  const result = apply(patch, undefined, { evidenceManifest: knowledgeManifest });
  const block = result.draft.contentBlocks.find(({ key }) => key === 'content-block-002');
  assert.ok(block && block.kind === 'prioritized_actions');
  assert.equal(block.items[0]?.support.status, 'provisional');
  assert.match(block.items[0]?.support.validationNeeded ?? '', /factual validation/u);
});

test('structural append downgrades non-factual support instead of rejecting a required block', () => {
  const knowledgeManifest: EvidenceManifest = {
    ...manifest,
    entries: [...manifest.entries, {
      id: 'K1',
      kind: 'knowledge_excerpt',
      evidenceClass: 'knowledge',
      artifactId: 'knowledge-1',
      artifactContentSha256: `sha256:${'4'.repeat(64)}`,
      jsonPointer: '/entries/0',
      stepNo: 2,
      sensitivity: 'internal',
      redaction: 'masked',
    }],
  };
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'append_content_block',
      block: {
        key: 'action-plan',
        kind: 'action_plan',
        title: 'Validation plan',
        items: [{
          key: 'action-plan-item',
          priority: 'P0',
          action: 'Validate the strategy.',
          ownerType: 'research',
          rationale: 'Method evidence defines the validation approach.',
          validationMethod: 'Run a moderated study.',
          support: {
            questionIds: ['Q1'],
            evidenceIds: ['K1'],
            confidence: 0.8,
            status: 'supported',
            validationNeeded: '',
          },
        }],
      },
    }],
  };

  const result = apply(
    patch,
    ['executive_answers', 'strategy_map', 'prioritized_actions', 'action_plan'],
    { evidenceManifest: knowledgeManifest },
  );
  const block = result.draft.contentBlocks.find(({ key }) => key === 'action-plan');
  assert.ok(block && block.kind === 'action_plan');
  assert.equal(block.items[0]?.support.status, 'provisional');
  assert.match(block.items[0]?.support.validationNeeded ?? '', /factual validation/u);
});

test('structural patch cannot rewrite semantic text or increase confidence', () => {
  const semanticOperation: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_semantic_text',
      reviewIssueId: 'reasoning_quality:1',
      reason: 'This must be rejected in structural mode.',
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
      reviewIssueId: 'reasoning_quality:1',
      reason: 'Weaken the answer identified by the Review.',
      target: { entity: 'direct_answer', key: 'Q1', field: 'answer' },
      value: 'Lead with qualified, verifiable trust signals.',
    }],
  };

  const result = apply(patch);

  assert.equal(result.draft.directAnswers[0]?.answer, 'Lead with qualified, verifiable trust signals.');
  assert.deepEqual(result.changedSemanticUnitKeys, ['direct-answer:001']);
  assert.deepEqual(result.fidelity.removedUnitKeys, []);
});

test('structural patch appends a Direct Answer only for a missing required question', () => {
  const q2 = {
    ...problemGraph.questions[0]!,
    id: 'Q2',
    statement: 'What should follow?',
  };
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'append_direct_answer',
      answer: {
        questionId: 'Q2',
        question: 'What should follow?',
        answer: 'Validate the next step.',
        answerStatus: 'supported',
        evidenceIds: ['E1'],
        confidence: 0.7,
        businessImplication: 'Reduce uncertainty.',
        recommendedAction: 'Run the validation.',
        validationNeeded: '',
      },
    }],
  };
  const requiredGraph: ProblemGraph = {
    ...problemGraph,
    questions: [...problemGraph.questions, q2],
  };
  const result = apply(
    patch,
    ['executive_answers', 'strategy_map', 'prioritized_actions'],
    { problemGraph: requiredGraph },
  );
  assert.equal(result.draft.directAnswers.length, 2);

  const optionalGraph: ProblemGraph = {
    ...problemGraph,
    questions: [...problemGraph.questions, { ...q2, priority: 'optional' }],
  };
  assert.throws(
    () => apply(
      patch,
      ['executive_answers', 'strategy_map', 'prioritized_actions'],
      { problemGraph: optionalGraph },
    ),
    /not a missing required question/u,
  );
});

test('semantic patch rejects a target not authorized by its sealed Review issue', () => {
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'semantic_revision',
    operations: [{
      op: 'replace_semantic_text',
      reviewIssueId: 'reasoning_quality:1',
      reason: 'Attempt an unrelated change.',
      target: { entity: 'content_block', key: 'content-block-001', field: 'title' },
      value: 'Unauthorized title',
    }],
  };

  assert.throws(
    () => apply(patch, ['executive_answers', 'strategy_map', 'prioritized_actions'], {
      allowedReviewIssueTargets: new Map([['reasoning_quality:1', new Set(['Q1'])]]),
    }),
    /does not authorize target content-block-001/u,
  );
});

test('semantic patch appends an item only to the Block authorized by the Review issue', () => {
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'semantic_revision',
    operations: [{
      op: 'append_block_item',
      reviewIssueId: 'recommendation_quality:1',
      reason: 'Add the missing reviewed action.',
      blockKey: 'content-block-002',
      item: {
        key: 'action-2',
        priority: 'P1',
        action: 'Add a second trust experiment.',
        ownerType: 'research',
        rationale: 'The Review identified a missing validation action.',
        validationMethod: 'Run a moderated test.',
        support: {
          questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.6,
          status: 'provisional', validationNeeded: 'Validate the experiment outcome.',
        },
      },
    }],
  };

  const result = apply(patch, ['executive_answers', 'strategy_map', 'prioritized_actions'], {
    allowedReviewIssueTargets: new Map([['recommendation_quality:1', new Set(['content-block-002'])]]),
  });
  const actions = result.draft.contentBlocks.find(({ key }) => key === 'content-block-002');
  assert.ok(actions?.kind === 'prioritized_actions');
  assert.equal(actions.items.length, 2);
  assert.ok(result.fidelity.addedUnitKeys.includes('content-block:content-block-002:item:action-2'));
});

test('supported bindings require factual Evidence instead of Knowledge alone', () => {
  const knowledgeManifest = structuredClone(manifest);
  knowledgeManifest.entries.push({
    id: 'K2-1',
    kind: 'knowledge_excerpt',
    evidenceClass: 'knowledge',
    artifactId: 'knowledge-1',
    artifactContentSha256: `sha256:${'4'.repeat(64)}`,
    jsonPointer: '/resources/0/content',
    stepNo: 2,
    sensitivity: 'internal',
    redaction: 'none',
  });
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_direct_answer_binding',
      questionId: 'Q1',
      answerStatus: 'supported',
      evidenceIds: ['K2-1'],
      confidence: 0.7,
      validationNeeded: '',
    }],
  };

  assert.throws(
    () => apply(patch, ['executive_answers', 'strategy_map', 'prioritized_actions'], { evidenceManifest: knowledgeManifest }),
    /requires factual Evidence/u,
  );
});

test('Patch schema excludes arbitrary Evidence Finding append operations', () => {
  const candidate = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'append_evidence_finding',
      finding: {
        key: 'new-claim',
        statement: 'An unrelated claim.',
        support: {
          questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.8,
          status: 'supported', validationNeeded: '',
        },
      },
    }],
  };

  assert.throws(
    () => new SchemaValidator().validateFileOrThrow(
      'schemas/skills/research-strategy-content-patch-v1.schema.json',
      candidate,
    ),
    /validation failed/u,
  );
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
      && /does not satisfy a missing requested artifact/u.test(error.message),
  );
});

test('research_report is already materialized by any existing content Block', () => {
  const patch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'append_content_block',
      block: {
        key: 'redundant-narrative',
        kind: 'narrative',
        title: 'Redundant report',
        content: 'This must not be appended.',
        support: {
          questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.7,
          status: 'provisional', validationNeeded: 'Validate.',
        },
      },
    }],
  };

  assert.throws(
    () => apply(patch, ['research_report']),
    /does not satisfy a missing requested artifact/u,
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
