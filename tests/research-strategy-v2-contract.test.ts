import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ProblemGraph,
  ResearchStrategyContentDraftV2,
} from '../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  assembleResearchStrategyDeliverable,
  ResearchStrategyAssemblyError,
} from '../apps/orchestrator-runtime/src/report/research-strategy-deliverable-assembler.ts';
import { applyResearchStrategyContentPatch } from '../apps/orchestrator-runtime/src/report/research-strategy-content-patch.ts';
import type { SynthesisMaterial } from '../apps/orchestrator-runtime/src/report/synthesis-materializer.ts';
import type { EvidenceManifest } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';

const requirement: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'research_synthesis',
  outcome_mode: 'answer',
  business_domain: 'pet food',
  research_goal: 'answer the product strategy question',
  target_audience: ['product team'],
  scope: ['commerce app'],
  constraints: [],
  success_criteria: [{ id: 'SC1', statement: 'Answer Q1 with an actionable recommendation' }],
  expected_deliverables: ['research_strategy_report'],
  requested_artifacts: ['executive_answers', 'strategy_map', 'prioritized_actions'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

const graph: ProblemGraph = {
  version: 'problem-graph-v1',
  questions: [{
    id: 'Q1',
    statement: 'What should change?',
    rationale: 'Decision support',
    priority: 'required',
    success_criterion_ids: ['SC1'],
    evidence_requirements: [{
      id: 'research-strategy-report',
      acceptedClasses: ['public_source'],
      minimumCount: 1,
      required: true,
    }],
    acceptance_criteria: ['Direct answer', 'Evidence', 'Action'],
    depends_on: [],
  }],
};

const manifest: EvidenceManifest = {
  version: 'evidence-v1',
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  collectedAt: '2026-08-23T00:00:00.000Z',
  manifestHash: `sha256:${'1'.repeat(64)}`,
  entries: [{
    id: 'E1',
    kind: 'tool_output',
    evidenceClass: 'public_source',
    artifactId: 'artifact-e1',
    artifactContentSha256: `sha256:${'2'.repeat(64)}`,
    jsonPointer: '/output/results/0',
    sourceUrl: 'https://example.test/evidence',
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

function graphWithOptionalQ2(): ProblemGraph {
  return {
    ...graph,
    questions: [...graph.questions, {
      id: 'Q2',
      statement: 'Which validation method should be used?',
      rationale: 'Choose a method without promoting it to a factual claim.',
      priority: 'optional',
      success_criterion_ids: [],
      evidence_requirements: [],
      acceptance_criteria: ['Method is evidence-bound and provisional.'],
      depends_on: ['Q1'],
    }],
  };
}

function manifestWithKnowledge(): EvidenceManifest {
  const mixedManifest = structuredClone(manifest);
  mixedManifest.entries.push({
    id: 'K2-1',
    kind: 'knowledge_excerpt',
    evidenceClass: 'knowledge',
    artifactId: 'knowledge-1',
    artifactContentSha256: `sha256:${'6'.repeat(64)}`,
    jsonPointer: '/resources/0/content',
    stepNo: 2,
    sensitivity: 'internal',
    redaction: 'none',
  });
  return mixedManifest;
}

function support() {
  return {
    questionIds: ['Q1'],
    evidenceIds: ['E1'],
    confidence: 0.8,
    status: 'supported' as const,
    validationNeeded: '',
  };
}

function draft(): ResearchStrategyContentDraftV2 {
  return {
    schemaVersion: 'research-strategy-content-draft-v2',
    title: 'Open strategy report',
    decisionContext: 'Choose the next product investment.',
    executiveAnswer: 'Lead with verifiable trust signals.',
    methodSummary: 'Synthesized verified public evidence and reviewed strategy outputs.',
    directAnswers: [{
      questionId: 'Q1',
      question: 'What should change?',
      answer: 'Lead with verifiable trust signals.',
      answerStatus: 'supported',
      evidenceIds: ['E1'],
      confidence: 0.8,
      businessImplication: 'Reduce decision uncertainty.',
      recommendedAction: 'Ship a source-backed trust card.',
      validationNeeded: '',
    }],
    evidenceFindings: [{
      key: 'finding-trust',
      statement: 'Verified source information is a decision signal.',
      support: support(),
    }],
    contentBlocks: [{
      key: 'map',
      kind: 'strategy_map',
      title: 'Trust strategy map',
      rows: ['Trust'],
      columns: ['Purchase'],
      cells: [{
        key: 'cell',
        row: 'Trust',
        column: 'Purchase',
        statement: 'Expose source evidence before value claims.',
        support: support(),
      }],
    }, {
      key: 'actions',
      kind: 'prioritized_actions',
      title: 'Priority actions',
      items: [{
        key: 'action',
        priority: 'P0',
        action: 'Ship a trust card.',
        ownerType: 'product',
        rationale: 'It exposes the strongest evidence early.',
        validationMethod: 'A/B test conversion and evidence-detail opens.',
        support: support(),
      }],
    }],
    limitations: [],
    openQuestions: [],
  };
}

function draftForQuestion(questionId: string): ResearchStrategyContentDraftV2 {
  return JSON.parse(
    JSON.stringify(draft()).replaceAll('"Q1"', JSON.stringify(questionId)),
  ) as ResearchStrategyContentDraftV2;
}

function graphForQuestion(questionId: string): ProblemGraph {
  const value = structuredClone(graph);
  value.questions[0]!.id = questionId;
  return value;
}

function material(value: ResearchStrategyContentDraftV2 = draft()): SynthesisMaterial {
  return {
    stepNo: 8,
    actorType: 'skill',
    actorId: 'research-strategy-synthesis',
    questionIds: ['Q1'],
    artifactId: 'skill-artifact-1',
    artifactContentSha256: `sha256:${'4'.repeat(64)}`,
    value: {
      version: 'skill-output-v2',
      status: 'succeeded',
      summary: 'Complete strategy draft.',
      findings: [],
      assumptions: [],
      limitations: [],
      recommendations: [],
      payload: value,
    },
    semanticRole: 'analysis',
  };
}

function evidenceInventoryMaterial(text: string, questionIds: string[] = ['Q1']): SynthesisMaterial {
  return {
    stepNo: 3,
    actorType: 'llm',
    actorId: 'llm.openai.gpt-4o',
    questionIds,
    artifactId: 'inventory-artifact-1',
    artifactContentSha256: `sha256:${'7'.repeat(64)}`,
    value: { text },
    semanticRole: 'inference',
  };
}

function reviewerMaterial(verdict: 'pass' | 'pass_with_conditions' | 'block' = 'pass'): SynthesisMaterial {
  return {
    stepNo: 9,
    actorType: 'reviewer',
    actorId: 'reviewer.research-lead',
    questionIds: ['Q1'],
    artifactId: 'review-artifact-1',
    artifactContentSha256: `sha256:${'5'.repeat(64)}`,
    value: {
      version: 'reviewer-step-output-v1',
      review: 'Final content review.',
      verdict,
      conditions: [],
    },
    semanticRole: 'review',
  };
}

function materials(value: ResearchStrategyContentDraftV2 = draft()): SynthesisMaterial[] {
  return [material(value), reviewerMaterial()];
}

function assemble(overrides: Partial<Parameters<typeof assembleResearchStrategyDeliverable>[0]> = {}) {
  return assembleResearchStrategyDeliverable({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    evidenceManifestArtifactId: 'manifest-1',
    requirement,
    problemGraph: graph,
    evidenceManifest: manifest,
    materials: materials(),
    requiredRiskDisclosures: [{
      id: 'risk-reviewer-1',
      sourceType: 'reviewer_condition',
      sourceId: 'review-1:C1',
      statement: 'Validate the result with live conversion data.',
      disposition: 'limitation',
    }],
    capabilityProvenance: [{ id: 'research-strategy-synthesis', type: 'skill' }],
    ...overrides,
  });
}

test('content draft v2 accepts open typed blocks and excludes machine-owned fields', () => {
  const validator = new SchemaValidator();
  assert.doesNotThrow(() => validator.validateFileOrThrow(
    'schemas/skills/research-strategy-content-draft-v2.schema.json',
    draft(),
  ));
  assert.throws(() => validator.validateFileOrThrow(
    'schemas/skills/research-strategy-content-draft-v2.schema.json',
    { ...draft(), requestedArtifactBindings: [] },
  ));
});

test('assembler deterministically creates canonical graph, coverage, risks, and requested artifact bindings', () => {
  const result = assemble();
  const payload = result.payload;
  assert.equal(payload.schemaVersion, 'research-strategy-content-v2');
  assert.deepEqual(payload.contentBlocks.map(({ id }) => id), ['content-block-001', 'content-block-002']);
  assert.deepEqual(payload.requestedArtifactBindings, [{
    artifactType: 'executive_answers',
    sourceField: '/directAnswers',
    blockIds: ['answer-Q1'],
    questionIds: ['Q1'],
    evidenceIds: ['E1'],
    status: 'complete',
  }, {
    artifactType: 'strategy_map',
    sourceField: '/contentBlocks',
    blockIds: ['content-block-001'],
    questionIds: ['Q1'],
    evidenceIds: ['E1'],
    status: 'complete',
  }, {
    artifactType: 'prioritized_actions',
    sourceField: '/contentBlocks',
    blockIds: ['content-block-002'],
    questionIds: ['Q1'],
    evidenceIds: ['E1'],
    status: 'complete',
  }]);
  assert.equal(result.findingGraph.findings[0]?.id, 'evidence-finding-001');
  assert.deepEqual(result.coverage.questionBindings, [{ questionId: 'Q1', summaryIds: ['summary-Q1'] }]);
  assert.deepEqual(result.coverage.successCriterionBindings, [{
    successCriterionId: 'SC1',
    conclusionIds: ['conclusion-Q1'],
    recommendationIds: ['recommendation-Q1'],
  }]);
  assert.equal(payload.limitations.at(-1), 'Validate the result with live conversion data.');
  assert.deepEqual(result.risksAndOpenIssues, []);
  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    'schemas/deliverables/research-strategy-report-v2.schema.json',
    payload,
  ));
});

test('assembler canonicalizes documented ordinal Evidence aliases to Manifest IDs', () => {
  const numberedManifest = structuredClone(manifest);
  numberedManifest.entries[0]!.id = 'E1-1';
  const result = assemble({ evidenceManifest: numberedManifest });
  assert.deepEqual(result.payload.directAnswers[0]?.evidenceIds, ['E1-1']);
  assert.deepEqual(result.payload.evidenceFindings[0]?.support.evidenceIds, ['E1-1']);
  assert.ok(result.payload.contentBlocks.every((block) => JSON.stringify(block).includes('E1-1')));
});

test('assembler canonicalizes a uniquely identifiable localized Question ID alias', () => {
  const canonicalQuestionId = 'Q6_design_principles_system';
  const localizedAlias = 'Q6_design_principles系统';
  const value = draftForQuestion(canonicalQuestionId);
  value.directAnswers[0]!.questionId = localizedAlias;
  value.evidenceFindings[0]!.support.questionIds = [localizedAlias];
  const map = value.contentBlocks.find((block) => block.kind === 'strategy_map');
  const actions = value.contentBlocks.find((block) => block.kind === 'prioritized_actions');
  assert.ok(map && map.kind === 'strategy_map');
  assert.ok(actions && actions.kind === 'prioritized_actions');
  map.cells[0]!.support.questionIds = [localizedAlias];
  actions.items[0]!.support.questionIds = [localizedAlias];

  const result = assemble({
    problemGraph: graphForQuestion(canonicalQuestionId),
    materials: materials(value),
  });
  assert.equal(result.payload.directAnswers[0]?.questionId, canonicalQuestionId);
  assert.deepEqual(result.payload.evidenceFindings[0]?.support.questionIds, [canonicalQuestionId]);
  assert.ok(result.payload.contentBlocks.every((block) => JSON.stringify(block).includes(canonicalQuestionId)));
});

test('assembler rejects a Question ID with only a matching ordinal but unrelated semantics', () => {
  const canonicalQuestionId = 'Q6_design_principles_system';
  const value = draftForQuestion(canonicalQuestionId);
  const map = value.contentBlocks.find((block) => block.kind === 'strategy_map');
  assert.ok(map && map.kind === 'strategy_map');
  map.cells[0]!.support.questionIds = ['Q6_unrelated_topic'];

  assert.throws(
    () => assemble({
      problemGraph: graphForQuestion(canonicalQuestionId),
      materials: materials(value),
    }),
    (error: unknown) => error instanceof ResearchStrategyAssemblyError && /unknown question Q6_unrelated_topic/u.test(error.message),
  );
});

test('assembler maps source-step Evidence aliases and downgrades Knowledge-only findings', () => {
  const value = draft();
  value.evidenceFindings.push({
    key: 'method',
    statement: 'The method provides a useful strategy frame.',
    support: { ...support(), evidenceIds: ['E2-1'] },
  });
  const result = assemble({ evidenceManifest: manifestWithKnowledge(), materials: materials(value) });
  const method = result.payload.evidenceFindings[1]!;
  assert.deepEqual(method.support.evidenceIds, ['K2-1']);
  assert.equal(method.support.status, 'provisional');
  assert.match(method.support.validationNeeded, /factual validation/);
});

test('assembler keeps a Knowledge-only method provisional without borrowing an unrelated fact', () => {
  const value = draft();
  value.evidenceFindings.push({
    key: 'method-q2',
    statement: 'The documented method structures validation for Q2.',
    support: {
      ...support(),
      questionIds: ['Q2'],
      evidenceIds: ['K2-1'],
      validationNeeded: 'Confirm the method fits this decision context.',
    },
  });

  const evidenceManifest = manifestWithKnowledge();
  const result = assemble({
    problemGraph: graphWithOptionalQ2(),
    evidenceManifest,
    materials: materials(value),
  });
  const method = result.payload.evidenceFindings[1]!;
  const q2Summary = result.findingGraph.subQuestionSummaries.find(({ id }) => id === 'summary-Q2');

  assert.equal(method.support.status, 'provisional');
  assert.equal(result.findingGraph.findings.some(({ id }) => id === 'evidence-finding-002'), false);
  assert.equal(result.findingGraph.analyses.some(({ id }) => id === 'analysis-evidence-finding-002'), false);
  assert.equal(q2Summary, undefined);
  assert.ok(result.payload.openQuestions.includes('Confirm the method fits this decision context.'));
  assert.ok(result.findingGraph.findings
    .filter(({ kind }) => kind === 'fact')
    .every((finding) => !('evidenceIds' in finding) || !finding.evidenceIds.includes('K2-1')));
});

test('structural repair downgrades a mixed factual and Knowledge finding before canonical assembly', () => {
  const source = draft();
  source.evidenceFindings[0]!.support.evidenceIds = ['K2-1'];
  const evidenceManifest = manifestWithKnowledge();
  const applied = applyResearchStrategyContentPatch({
    source,
    patch: {
      version: 'research-strategy-content-patch-v1',
      mode: 'structural_repair',
      operations: [{
        op: 'replace_support',
        target: { entity: 'evidence_finding', key: 'finding-trust' },
        support: {
          ...support(),
          evidenceIds: ['E1', 'K2-1'],
          validationNeeded: 'Validate the interpretation against primary research.',
        },
      }],
    },
    mode: 'structural_repair',
    problemGraph: graph,
    evidenceManifest,
    requestedArtifacts: requirement.requested_artifacts ?? [],
  });

  assert.equal(applied.draft.evidenceFindings[0]?.support.status, 'provisional');
  assert.deepEqual(applied.draft.evidenceFindings[0]?.support.evidenceIds, ['E1', 'K2-1']);
  assert.equal(
    applied.draft.evidenceFindings[0]?.support.validationNeeded,
    'Validate the interpretation against primary research.',
  );
  const result = assemble({ evidenceManifest, draftOverride: applied.draft });
  assert.equal(result.payload.evidenceFindings[0]?.support.status, 'provisional');
  assert.deepEqual(
    result.findingGraph.analyses.find(({ id }) => id === 'analysis-evidence-finding-001')?.findingIds,
    ['evidence-anchor-E1'],
  );
  assert.ok(result.payload.openQuestions.includes('Validate the interpretation against primary research.'));
  assert.ok(result.findingGraph.findings
    .filter(({ kind }) => kind === 'fact')
    .every((finding) => !('evidenceIds' in finding) || !finding.evidenceIds.includes('K2-1')));
});

test('assembler does not root a Knowledge-only finding in unrelated factual Direct Answer context', () => {
  const value = draft();
  value.directAnswers.push({
    questionId: 'Q2',
    question: 'Which validation method should be used?',
    answer: 'Use a bounded validation method against the verified market context.',
    answerStatus: 'provisional',
    evidenceIds: ['E1'],
    confidence: 0.65,
    businessImplication: 'The method remains an analysis choice rather than a market fact.',
    recommendedAction: 'Validate the recommendation before scaling it.',
    validationNeeded: 'Confirm the method against live behavior data.',
  });
  value.evidenceFindings.push({
    key: 'method-q2',
    statement: 'The method can structure validation for this question.',
    support: { ...support(), questionIds: ['Q2'], evidenceIds: ['E2-1'] },
  });

  const result = assemble({
    problemGraph: graphWithOptionalQ2(),
    evidenceManifest: manifestWithKnowledge(),
    materials: materials(value),
  });
  const method = result.payload.evidenceFindings[1]!;
  const analysis = result.findingGraph.analyses.find(({ id }) => id === 'analysis-evidence-finding-002');
  const summary = result.findingGraph.subQuestionSummaries.find(({ id }) => id === 'summary-Q2');
  assert.equal(method.support.status, 'provisional');
  assert.equal(analysis, undefined);
  assert.equal(summary?.analysisIds.includes('analysis-evidence-finding-002'), false);
});

test('assembler does not let a content Block borrow factual roots from its Question', () => {
  const value = draft();
  const map = value.contentBlocks.find((block) => block.kind === 'strategy_map');
  assert.ok(map && map.kind === 'strategy_map');
  map.cells[0]!.support = {
    ...map.cells[0]!.support,
    status: 'provisional',
    evidenceIds: ['K2-1'],
    validationNeeded: 'Validate this strategy-map statement with factual evidence.',
  };

  assert.throws(
    () => assemble({
      evidenceManifest: manifestWithKnowledge(),
      materials: materials(value),
    }),
    (error: unknown) => error instanceof ResearchStrategyAssemblyError
      && /content block content-block-001 has no related evidence finding/u.test(error.message),
  );
});

test('assembler does not carry factual roots between provisional findings bound to the same question', () => {
  const value = draft();
  value.evidenceFindings.push({
    key: 'q2-context',
    statement: 'The verified source supplies factual context for Q2.',
    support: {
      ...support(),
      questionIds: ['Q2'],
      status: 'provisional',
      validationNeeded: 'Validate how the source context applies to Q2.',
    },
  }, {
    key: 'q2-method',
    statement: 'The method organizes the Q2 validation plan.',
    support: { ...support(), questionIds: ['Q2'], evidenceIds: ['E2-1'] },
  });

  const result = assemble({
    problemGraph: graphWithOptionalQ2(),
    evidenceManifest: manifestWithKnowledge(),
    materials: materials(value),
  });
  const contextAnalysis = result.findingGraph.analyses.find(({ id }) => id === 'analysis-evidence-finding-002');
  const methodAnalysis = result.findingGraph.analyses.find(({ id }) => id === 'analysis-evidence-finding-003');
  assert.deepEqual(contextAnalysis?.findingIds, ['evidence-finding-001']);
  assert.equal(methodAnalysis, undefined);
});

test('assembler restores empty provisional bindings from question-indexed verified Evidence hints', () => {
  const value = draft();
  value.directAnswers[0]!.answerStatus = 'provisional';
  value.directAnswers[0]!.evidenceIds = [];
  value.directAnswers[0]!.validationNeeded = 'Validate the interpretation.';
  value.evidenceFindings[0]!.support.status = 'provisional';
  value.evidenceFindings[0]!.support.evidenceIds = [];
  value.evidenceFindings[0]!.support.validationNeeded = 'Validate the finding.';
  for (const block of value.contentBlocks) {
    const supports = block.kind === 'strategy_map' ? block.cells.map(({ support }) => support)
      : block.kind === 'prioritized_actions' ? block.items.map(({ support }) => support)
        : [];
    assert.ok(supports.length > 0);
    for (const itemSupport of supports) {
      itemSupport.status = 'provisional';
      itemSupport.evidenceIds = [];
      itemSupport.validationNeeded = 'Validate this recommendation.';
    }
  }

  const result = assemble({
    materials: [
      evidenceInventoryMaterial('## Q1｜Evidence inventory\nVerified market context: E1.'),
      ...materials(value),
    ],
  });
  assert.deepEqual(result.payload.directAnswers[0]?.evidenceIds, ['E1']);
  assert.deepEqual(result.payload.evidenceFindings[0]?.support.evidenceIds, ['E1']);
  assert.equal(result.payload.evidenceFindings[0]?.support.status, 'provisional');
  assert.ok(result.payload.contentBlocks.every((block) => JSON.stringify(block).includes('E1')));
});

test('assembler does not hydrate bindings from unknown upstream Evidence references', () => {
  const value = draft();
  value.directAnswers[0]!.answerStatus = 'provisional';
  value.directAnswers[0]!.evidenceIds = [];
  value.directAnswers[0]!.validationNeeded = 'Validate the interpretation.';
  value.evidenceFindings[0]!.support.status = 'provisional';
  value.evidenceFindings[0]!.support.evidenceIds = [];
  value.evidenceFindings[0]!.support.validationNeeded = 'Validate the finding.';
  const map = value.contentBlocks.find((block) => block.kind === 'strategy_map');
  assert.ok(map && map.kind === 'strategy_map');
  map.cells[0]!.support.status = 'provisional';
  map.cells[0]!.support.evidenceIds = [];
  map.cells[0]!.support.validationNeeded = 'Validate the map.';

  assert.throws(
    () => assemble({
      materials: [
        evidenceInventoryMaterial('## Q1｜Evidence inventory\nUnknown source: E9-9.'),
        ...materials(value),
      ],
    }),
    (error: unknown) => error instanceof ResearchStrategyAssemblyError && /strategy_map has no Evidence/u.test(error.message),
  );
});

test('assembler roots provisional findings in verified source-anchor facts without promoting the claim', () => {
  const value = draft();
  value.evidenceFindings[0]!.support.status = 'provisional';
  value.evidenceFindings[0]!.support.validationNeeded = 'Validate the interpretation with primary research.';
  const result = assemble({ materials: materials(value) });
  assert.ok(result.findingGraph.findings.some(({ id, kind }) => id === 'evidence-anchor-E1' && kind === 'fact'));
  assert.ok(result.findingGraph.analyses.some(({ id }) => id === 'analysis-evidence-finding-001'));
});

test('assembler expands matrix axes from canonical cell content instead of rejecting layout drift', () => {
  const value = draft();
  const map = value.contentBlocks.find((block) => block.kind === 'strategy_map');
  assert.ok(map && map.kind === 'strategy_map');
  map.cells[0]!.row = 'Cross journey';
  const result = assemble({ materials: materials(value) });
  const canonical = result.payload.contentBlocks.find((block) => block.kind === 'strategy_map');
  assert.ok(canonical && canonical.kind === 'strategy_map');
  assert.deepEqual(canonical.rows, ['Trust', 'Cross journey']);
});

test('assembler rejects unknown Evidence before creating a canonical deliverable', () => {
  const invalid = draft();
  invalid.contentBlocks[0] = {
    ...invalid.contentBlocks[0]!,
    cells: invalid.contentBlocks[0]!.kind === 'strategy_map'
      ? [{ ...invalid.contentBlocks[0]!.cells[0]!, support: { ...support(), evidenceIds: ['unknown'] } }]
      : [],
  } as ResearchStrategyContentDraftV2['contentBlocks'][number];
  assert.throws(
    () => assemble({ materials: materials(invalid) }),
    (error: unknown) => error instanceof ResearchStrategyAssemblyError && /unknown Evidence/.test(error.message),
  );
});

test('assembler rejects a blocking final Skill review', () => {
  assert.throws(
    () => assemble({ materials: [material(), reviewerMaterial('block')] }),
    (error: unknown) => error instanceof ResearchStrategyAssemblyError && /does not permit assembly/.test(error.message),
  );
});

test('assembler rejects a requested artifact that has no matching content block', () => {
  const invalid = draft();
  invalid.contentBlocks = invalid.contentBlocks.filter(({ kind }) => kind !== 'strategy_map');
  assert.throws(
    () => assemble({ materials: materials(invalid) }),
    (error: unknown) => error instanceof ResearchStrategyAssemblyError && /strategy_map is not materialized/.test(error.message),
  );
});
