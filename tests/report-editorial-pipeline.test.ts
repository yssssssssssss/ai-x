import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ControlArtifact } from '../database/control-plane.ts';
import {
  REPORT_REVIEW_V2_DIMENSION_IDS,
  type PassedReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import type {
  ReportAuditAppendixMaterialV1,
  ReportEditorialSemanticKindV1,
} from '../packages/api-contract/report-editorial.ts';
import type {
  ResearchDeliverableEnvelope,
  ResearchStrategyReportPayloadV2,
} from '../packages/api-contract/research-deliverable.ts';
import {
  assertReportEditorialBlueprintIntegrity,
  assertReportEditorialMaterialIntegrity,
} from '../packages/report-rendering/report-editorial-validation.ts';
import { collectReportDocumentV3Semantics } from '../packages/report-rendering/report-document-visitor.ts';
import { createDeterministicReportEditorialBlueprintV1 } from '../apps/orchestrator-runtime/src/report/report-editorial-blueprint.ts';
import {
  buildReportAuditAppendixMaterialV1,
  buildResearchStrategyEditorialMaterialV1,
} from '../apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts';
import { projectReportEditorialDocumentV3 } from '../apps/orchestrator-runtime/src/report/report-editorial-projector.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  researchStrategyCoverageV2,
  researchStrategyFindingGraphV2,
  researchStrategyPayloadV2,
} from './fixtures/research-strategy-v2.ts';

const DELIVERABLE_SHA = `sha256:${'d'.repeat(64)}`;
const REVIEW_SHA = `sha256:${'e'.repeat(64)}`;

function artifact(input: {
  id: string;
  kind: string;
  schemaVersion: string;
  contentSha256: string;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    kind: input.kind,
    state: 'SEALED',
    storageUri: `/fixtures/${input.id}.json`,
    contentSha256: input.contentSha256,
    byteSize: 1024,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
  };
}

function input(payload: ResearchStrategyReportPayloadV2 = richPayload()) {
  const deliverable: ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2> = {
    version: 'research-deliverable-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    deliverableType: 'research_strategy_report',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    methodSummary: 'Reviewed synthesis.',
    findingGraph: researchStrategyFindingGraphV2(),
    payload,
    recommendations: [{ id: 'recommendation-Q1', summaryIds: ['summary-Q1'], statement: 'Ship a trust card.' }],
    coverage: researchStrategyCoverageV2(),
    risksAndOpenIssues: [],
    capabilityProvenance: [],
  };
  const review: PassedReportReviewArtifact = {
    version: 'report-review-v2',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    deliverableArtifactId: 'deliverable-1',
    verdict: 'pass',
    dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
  };
  return {
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    requiredQuestionIds: ['Q1'],
    deliverable: {
      artifact: artifact({
        id: 'deliverable-1',
        kind: 'deliverable',
        schemaVersion: 'research-deliverable-v1-review-gated',
        contentSha256: DELIVERABLE_SHA,
      }),
      value: deliverable,
    },
    review: {
      artifact: artifact({
        id: 'review-1',
        kind: 'report_review',
        schemaVersion: review.version,
        contentSha256: REVIEW_SHA,
      }),
      value: review,
    },
  };
}

function richPayload(): ResearchStrategyReportPayloadV2 {
  const payload = researchStrategyPayloadV2();
  payload.contentBlocks.splice(1, 0, {
    id: 'content-block-mind',
    kind: 'mind_model',
    title: 'Trust path',
    nodes: [{
      id: 'mind-node-1',
      label: 'Evidence',
      description: 'Show verifiable evidence.',
      support: {
        questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.8,
        status: 'supported', validationNeeded: '',
      },
    }, {
      id: 'mind-node-2',
      label: 'Trust',
      description: 'Reduce uncertainty.',
      support: {
        questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.7,
        status: 'provisional', validationNeeded: 'Validate causality.',
      },
    }],
    edges: [{ from: 'mind-node-1', to: 'mind-node-2', relationship: 'supports' }],
  });
  payload.requestedArtifactBindings.push({
    artifactType: 'mind_model',
    sourceField: '/contentBlocks',
    blockIds: ['content-block-mind'],
    questionIds: ['Q1'],
    evidenceIds: ['E1'],
    status: 'complete',
  });
  payload.limitations = ['The evidence is directional.'];
  payload.openQuestions = ['Will the effect persist?'];
  payload.riskDisclosures = [{
    id: 'risk-1',
    sourceType: 'answer_uncertainty',
    sourceId: 'Q1',
    statement: 'The effect may vary by category.',
    disposition: 'open_question',
  }];
  return payload;
}

test('builds strict Material from sealed Deliverable and Review bindings without diagnostic data', () => {
  const material = buildResearchStrategyEditorialMaterialV1(input());
  assert.doesNotThrow(() => assertReportEditorialMaterialIntegrity(material));
  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    'schemas/report-editorial-material-v1.schema.json',
    material,
  ));
  assert.equal(material.binding.deliverableContentSha256, DELIVERABLE_SHA);
  assert.equal(JSON.stringify(material).includes('diagnostic'), false);
  assert.ok(material.presentationUnits.some(({ semanticKind }) => semanticKind === 'requested_artifact_binding'));
  assert.ok(Object.values(material.leafTraceIndex).every(({ origins }) => origins[0]?.jsonPointer.startsWith('/payload/')));

  const leaked = { ...material, diagnosticReference: { secret: true } };
  assert.throws(() => new SchemaValidator().validateFileOrThrow(
    'schemas/report-editorial-material-v1.schema.json',
    leaked,
  ), /additional properties/u);

  const broken = input();
  broken.review.value.deliverableArtifactId = 'another-deliverable';
  assert.throws(
    () => buildResearchStrategyEditorialMaterialV1(broken),
    /final pass Review bound to the Deliverable/u,
  );
});

test('provisional evidence findings reference only canonical Finding Graph roots', () => {
  const fixture = input();
  fixture.deliverable.value.payload.evidenceFindings.push({
    id: 'evidence-finding-002',
    statement: 'A provisional interpretation still needs validation.',
    support: {
      questionIds: ['Q1'],
      evidenceIds: ['E1'],
      confidence: 0.6,
      status: 'provisional',
      validationNeeded: 'Validate the interpretation with primary research.',
    },
  });
  fixture.deliverable.value.findingGraph.analyses.push({
    id: 'analysis-evidence-finding-002',
    findingIds: ['evidence-finding-001'],
    statement: 'A provisional interpretation still needs validation.',
  });

  const material = buildResearchStrategyEditorialMaterialV1(fixture);
  const canonicalFindingIds = new Set(
    fixture.deliverable.value.findingGraph.findings.map(({ id }) => id),
  );
  for (const trace of Object.values(material.leafTraceIndex)) {
    for (const findingId of trace.support.findingIds) {
      assert.equal(canonicalFindingIds.has(findingId), true, findingId);
    }
  }
  assert.deepEqual(
    material.leafTraceIndex['leaf:evidence-finding:evidence-finding-002']?.support.findingIds,
    ['evidence-finding-001'],
  );
});

test('deterministically projects matrix, mind graph, and actions to typed v3 blocks', () => {
  const material = buildResearchStrategyEditorialMaterialV1(input());
  const blueprint = createDeterministicReportEditorialBlueprintV1(material);
  const document = projectReportEditorialDocumentV3({ material, blueprint });
  const types = document.sections.flatMap(({ blocks }) => blocks.map(({ type }) => type));
  assert.ok(types.includes('record-table'));
  assert.ok(types.includes('graph'));
  assert.ok(types.includes('priority-board'));

  const matrix = document.sections.flatMap(({ blocks }) => blocks)
    .find((block) => block.type === 'record-table' && block.unitRefs.includes('content:content-block-001'));
  assert.equal(matrix?.type, 'record-table');
  if (matrix?.type === 'record-table') {
    assert.deepEqual(matrix.columns, [{ key: 'column-001', label: 'Purchase' }]);
    assert.equal(matrix.rows[0]?.label, 'Trust');
    assert.equal(matrix.rows[0]?.cells[0]?.value, 'Expose source evidence before value claims.');
  }

  const graph = document.sections.flatMap(({ blocks }) => blocks).find((block) => block.type === 'graph');
  assert.equal(graph?.type, 'graph');
  if (graph?.type === 'graph') {
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(graph.edges.map(({ from, to }) => [from, to]), [['mind-node-1', 'mind-node-2']]);
  }

  const board = document.sections.flatMap(({ blocks }) => blocks).find((block) => block.type === 'priority-board');
  assert.equal(board?.type, 'priority-board');
  if (board?.type === 'priority-board') {
    assert.equal(board.groups[0]?.priority, 'P0');
    assert.equal(board.groups[0]?.items[0]?.owner, 'product');
  }
  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    'schemas/report-editorial-blueprint-v1.schema.json',
    blueprint,
  ));
  const leakedBlueprint = structuredClone(blueprint) as unknown as {
    sections: Array<{ blocks: Array<Record<string, unknown>> }>;
  };
  leakedBlueprint.sections[0]!.blocks[0]!.content = 'Blueprint must not carry prose.';
  assert.throws(() => new SchemaValidator().validateFileOrThrow(
    'schemas/report-editorial-blueprint-v1.schema.json',
    leakedBlueprint,
  ), /additional properties/u);
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-document', document));
});

test('first-source section headings ignore canonical source IDs', () => {
  const material = buildResearchStrategyEditorialMaterialV1(input());
  const blueprint = createDeterministicReportEditorialBlueprintV1(material);
  const topics = blueprint.sections.find(({ view }) => view === 'topics')!;
  const analysis = blueprint.sections.find(({ view }) => view === 'analysis')!;
  topics.headingMode = 'first_source_title';
  analysis.headingMode = 'first_source_title';

  const document = projectReportEditorialDocumentV3({ material, blueprint });

  assert.equal(
    document.sections.find(({ view }) => view === 'topics')?.title,
    'Trust strategy map',
  );
  assert.equal(
    document.sections.find(({ view }) => view === 'analysis')?.title,
    '分析底稿 / Analysis Notes',
  );
});

test('pure narrative input stays narrative and does not invent a graph or priority board', () => {
  const payload = researchStrategyPayloadV2();
  payload.contentBlocks = [{
    id: 'content-block-narrative',
    kind: 'narrative',
    title: 'What the evidence says',
    content: 'Trust signals reduce uncertainty.',
    support: {
      questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.8,
      status: 'supported', validationNeeded: '',
    },
  }];
  payload.requestedArtifactBindings = [];
  const material = buildResearchStrategyEditorialMaterialV1(input(payload));
  const blueprint = createDeterministicReportEditorialBlueprintV1(material);
  const document = projectReportEditorialDocumentV3({ material, blueprint });
  const types = document.sections.flatMap(({ blocks }) => blocks.map(({ type }) => type));
  assert.ok(types.includes('paragraph'));
  assert.equal(types.includes('graph'), false);
  assert.equal(types.includes('priority-board'), false);
  assert.equal(document.notices.length, 0);
});

test('preserves every current Content v2 block family and boundary collection', () => {
  const payload = richPayload();
  const support = {
    questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.75,
    status: 'supported' as const, validationNeeded: '',
  };
  payload.contentBlocks.push({
    id: 'content-block-narrative', kind: 'narrative', title: 'Narrative',
    content: 'Narrative body.', support,
  }, {
    id: 'content-block-comparison', kind: 'comparison_matrix', title: 'Comparison',
    rows: ['A'], columns: ['B'],
    cells: [{ id: 'comparison-cell-1', row: 'A', column: 'B', statement: 'Cell value.', support }],
  }, {
    id: 'content-block-principles', kind: 'design_principles', title: 'Principles',
    items: [{ id: 'principle-1', title: 'Be clear', statement: 'Show the source.', support }],
  }, {
    id: 'content-block-opportunities', kind: 'opportunity_backlog', title: 'Opportunities',
    items: [{ id: 'opportunity-1', title: 'Reduce doubt', statement: 'Surface proof.', impact: 'Higher confidence.', support }],
  }, {
    id: 'content-block-plan', kind: 'action_plan', title: 'Action plan',
    items: [{
      id: 'plan-1', priority: 'P1', action: 'Measure trust.', ownerType: 'research',
      rationale: 'Close the evidence gap.', validationMethod: 'Interview users.', support,
    }],
  }, {
    id: 'content-block-channels', kind: 'channel_strategies', title: 'Channels',
    items: [{ id: 'channel-1', channel: 'App', role: 'Discovery', strategies: ['Expose evidence', 'Explain risk'], support }],
  });
  const material = buildResearchStrategyEditorialMaterialV1(input(payload));
  const kinds = new Set(material.presentationUnits.map(({ semanticKind }) => semanticKind));
  const expectedKinds = [
    'direct_answer', 'evidence_finding', 'narrative', 'comparison_matrix', 'strategy_map',
    'mind_model', 'design_principle', 'opportunity', 'prioritized_action', 'action_plan',
    'channel_strategy', 'limitation', 'open_question', 'risk', 'requested_artifact_binding',
  ] satisfies ReportEditorialSemanticKindV1[];
  for (const kind of expectedKinds) assert.ok(kinds.has(kind), `missing semantic kind ${kind}`);

  const document = projectReportEditorialDocumentV3({
    material,
    blueprint: createDeterministicReportEditorialBlueprintV1(material),
  });
  const serialized = JSON.stringify(document);
  for (const text of [
    'Narrative body.', 'Cell value.', 'Show the source.', 'Surface proof.',
    'Measure trust.', 'Expose evidence', 'The evidence is directional.',
    'Will the effect persist?', 'The effect may vary by category.',
  ]) assert.ok(serialized.includes(text), `missing projected content: ${text}`);
});

test('linear fallback keeps every matrix, graph, and action leaf and emits controlled notices', () => {
  const material = buildResearchStrategyEditorialMaterialV1(input());
  const blueprint = createDeterministicReportEditorialBlueprintV1(material, {
    recordTable: false,
    graph: false,
    priorityBoard: false,
  });
  const document = projectReportEditorialDocumentV3({ material, blueprint });
  assert.deepEqual(
    new Set(collectReportDocumentV3Semantics(document).leafUnitIds),
    new Set(material.constraints.requiredLeafUnitIds),
  );
  assert.equal(document.sections.some(({ blocks }) => blocks.some(({ type }) => type === 'graph')), false);
  assert.equal(document.sections.some(({ blocks }) => blocks.some(({ type }) => type === 'priority-board')), false);
  const notices = document.notices.filter(({ code }) => code === 'visualization_linearized');
  assert.deepEqual(notices, [{
    id: 'notice-visualization-linearized-001',
    code: 'visualization_linearized',
    severity: 'info',
    scope: 'report',
    relatedUnitIds: [
      'content:content-block-001',
      'content:content-block-mind',
      'content:content-block-002',
    ],
  }]);
});

test('coverage gates reject orphan leaves and invalid or duplicate Blueprint ownership', () => {
  const material = buildResearchStrategyEditorialMaterialV1(input());
  const orphan = structuredClone(material);
  orphan.leafTraceIndex.orphan = structuredClone(Object.values(orphan.leafTraceIndex)[0]!);
  assert.throws(
    () => assertReportEditorialMaterialIntegrity(orphan),
    /leafTraceIndex keys must exactly equal/u,
  );

  const duplicate = createDeterministicReportEditorialBlueprintV1(material);
  duplicate.sections[0]!.blocks.push(structuredClone(duplicate.sections[0]!.blocks[0]!));
  assert.throws(
    () => assertReportEditorialBlueprintIntegrity(material, duplicate),
    /must be unique/u,
  );

  const omitted = createDeterministicReportEditorialBlueprintV1(material);
  const grouped = omitted.sections.flatMap(({ blocks }) => blocks).find(({ unitRefs }) => unitRefs.length > 1)!;
  grouped.unitRefs.pop();
  assert.throws(
    () => projectReportEditorialDocumentV3({ material, blueprint: omitted }),
    /must own every required presentation unit exactly once/u,
  );

  const wrong = createDeterministicReportEditorialBlueprintV1(material);
  wrong.sections[0]!.blocks[0]!.presentation = 'graph';
  wrong.sections[0]!.blocks[0]!.variant = 'linear';
  assert.throws(
    () => assertReportEditorialBlueprintIntegrity(material, wrong),
    /not allowed/u,
  );
});

test('projects audit metadata without accepting contributor prose or diagnostics', () => {
  const material = buildResearchStrategyEditorialMaterialV1(input());
  const audit: ReportAuditAppendixMaterialV1 = buildReportAuditAppendixMaterialV1({
    material,
    contributionLedger: {
      artifact: artifact({
        id: 'ledger-1',
        kind: 'contribution_ledger',
        schemaVersion: 'contribution-ledger-v1',
        contentSha256: `sha256:${'c'.repeat(64)}`,
      }),
      value: {
        version: 'contribution-ledger-v1',
        taskId: 'task-1',
        planVersionId: 'plan-1',
        attemptId: 'attempt-1',
        entries: [{
          contributionArtifactId: 'contribution-1',
          invocationId: 'invocation-1',
          sourceUnitKey: 'unit-1',
          sourceSemanticHash: `sha256:${'f'.repeat(64)}`,
          disposition: 'included',
          canonicalNodeIds: ['content-block-001'],
          reviewIssueIds: [],
        }],
      },
    },
  });
  const document = projectReportEditorialDocumentV3({
    material,
    blueprint: createDeterministicReportEditorialBlueprintV1(material),
    auditAppendix: audit,
  });
  assert.deepEqual(document.semanticManifest.auditRecordIds, ['audit-record-001']);
  assert.equal(JSON.stringify(document.auditAppendix).includes('statement'), false);
  assert.equal(JSON.stringify(document).includes('diagnostic'), false);
});
