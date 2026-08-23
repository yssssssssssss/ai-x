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
