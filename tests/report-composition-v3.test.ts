import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { ControlArtifact, ControlExecutionLease } from '../database/control-plane.ts';
import {
  REPORT_REVIEW_V2_DIMENSION_IDS,
  type PassedReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import type {
  ContributionLedgerV1,
  ResearchDeliverableEnvelope,
  ResearchStrategyReportPayloadV2,
} from '../packages/api-contract/research-deliverable.ts';
import type { ArtifactWriteInput } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import { ReportCompositionService } from '../apps/orchestrator-runtime/src/report/report-composition-service.ts';
import { createDeterministicReportEditorialBlueprintV1 } from '../apps/orchestrator-runtime/src/report/report-editorial-blueprint.ts';
import { createDeterministicEditorialShowcaseSpec } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import type { EditorialShowcasePublicationService } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-publication.ts';
import type {
  ReportEditorialPlanInput,
  ReportEditorialPlanResult,
} from '../apps/orchestrator-runtime/src/report/report-editorial-planner.ts';
import { deterministicReportLayout } from '../apps/orchestrator-runtime/src/report/report-layout-planner.ts';
import {
  researchStrategyCoverageV2,
  researchStrategyFindingGraphV2,
  researchStrategyPayloadV2,
} from './fixtures/research-strategy-v2.ts';

const binding = {
  taskId: 'task-editorial-composition',
  planVersionId: 'plan-editorial-composition',
  attemptId: 'attempt-editorial-composition',
};

function jsonDigest(value: unknown): { contentSha256: string; byteSize: number } {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  return {
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteSize: bytes.byteLength,
  };
}

function sealedJsonArtifact(input: {
  id: string;
  kind: string;
  schemaVersion: string;
  value: unknown;
}): ControlArtifact {
  return {
    id: input.id,
    ...binding,
    kind: input.kind,
    state: 'SEALED',
    storageUri: `/private/${input.id}.json`,
    ...jsonDigest(input.value),
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: null,
    metadata: null,
  };
}

class CompositionArtifactStore {
  readonly writes: Array<{ input: ArtifactWriteInput; artifact: ControlArtifact }> = [];
  readonly values = new Map<string, { artifact: ControlArtifact; value: unknown }>();
  failWriteKind?: string;

  add(artifact: ControlArtifact, value: unknown): void {
    this.values.set(artifact.id, { artifact, value });
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    const stored = this.values.get(artifactId);
    if (!stored) throw new Error(`missing fixture Artifact ${artifactId}`);
    return stored as { artifact: ControlArtifact; value: T };
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    if (input.kind === this.failWriteKind) throw new Error(`fixture failed ${input.kind} write`);
    const artifact = sealedJsonArtifact({
      id: `${input.kind}-${this.writes.length + 1}`,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      value: input.value,
    });
    this.writes.push({ input, artifact });
    this.add(artifact, input.value);
    return artifact;
  }
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
  return payload;
}

function compositionFixture(store: CompositionArtifactStore) {
  const evidenceSource = {
    artifact: {
      id: 'evidence-source-1',
      contentSha256: `sha256:${'e'.repeat(64)}`,
    },
    value: { result: 'verified' },
  };
  const evidenceArtifactResolver: EvidenceArtifactResolver = {
    resolveArtifact: (artifactId) => artifactId === evidenceSource.artifact.id
      ? evidenceSource
      : null,
  };
  const evidenceManifest: EvidenceManifest = new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-27T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: evidenceSource.artifact.id,
      artifactContentSha256: evidenceSource.artifact.contentSha256,
      jsonPointer: '/result',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  }, evidenceArtifactResolver);
  const payload = richPayload();
  const deliverable: ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2> = {
    version: 'research-deliverable-v1',
    ...binding,
    deliverableType: 'research_strategy_report',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    methodSummary: 'Reviewed strategy synthesis.',
    findingGraph: researchStrategyFindingGraphV2(),
    payload,
    recommendations: [{
      id: 'recommendation-Q1',
      statement: 'Ship a source-backed trust card.',
      summaryIds: ['summary-Q1'],
    }],
    coverage: researchStrategyCoverageV2(),
    risksAndOpenIssues: [],
    capabilityProvenance: [],
  };
  const review: PassedReportReviewArtifact = {
    version: 'report-review-v2',
    ...binding,
    deliverableArtifactId: 'deliverable-1',
    verdict: 'pass',
    dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
  };
  const contributionLedger: ContributionLedgerV1 = {
    version: 'contribution-ledger-v1',
    ...binding,
    entries: [{
      contributionArtifactId: 'contribution-1',
      invocationId: 'invocation-1',
      sourceUnitKey: 'source-unit-1',
      sourceSemanticHash: `sha256:${'f'.repeat(64)}`,
      disposition: 'conflicted',
      canonicalNodeIds: ['content-block-001'],
      reason: 'SECRET contributor prose must never enter the report',
      reviewIssueIds: ['review-issue-1'],
    }],
  };
  const ledgerArtifact = sealedJsonArtifact({
    id: 'contribution-ledger-1',
    kind: 'contribution_ledger',
    schemaVersion: 'contribution-ledger-v1',
    value: contributionLedger,
  });
  store.add(ledgerArtifact, contributionLedger);
  const activeLease: ControlExecutionLease = {
    ...binding,
    leaseOwner: 'editorial-composition-worker',
    leaseToken: 'editorial-composition-token',
  };
  return {
    ...binding,
    requiredQuestionIds: ['Q1'],
    deliverable: {
      artifact: sealedJsonArtifact({
        id: 'deliverable-1',
        kind: 'deliverable',
        schemaVersion: 'research-deliverable-v1-review-gated',
        value: deliverable,
      }),
      value: deliverable,
    },
    evidenceManifest: {
      artifact: sealedJsonArtifact({
        id: 'evidence-manifest-1',
        kind: 'evidence_manifest',
        schemaVersion: 'evidence-v1',
        value: evidenceManifest,
      }),
      value: evidenceManifest,
    },
    evidenceArtifactResolver,
    review: {
      artifact: sealedJsonArtifact({
        id: 'review-1',
        kind: 'report_review',
        schemaVersion: 'report-review-v2',
        value: review,
      }),
      value: review,
    },
    visualAssets: [],
    charts: [],
    activeLease,
    contributionLedgerArtifactId: ledgerArtifact.id,
  };
}

function service(input: {
  store: CompositionArtifactStore;
  enabled?: boolean;
  editorialExperienceV1Enabled?: boolean;
  layoutPlan?: () => void;
  editorialPlan?: (input: ReportEditorialPlanInput) => Promise<ReportEditorialPlanResult>;
  showcasePublish?: (
    input: Parameters<EditorialShowcasePublicationService['publish']>[0],
  ) => ReturnType<EditorialShowcasePublicationService['publish']>;
}): ReportCompositionService {
  return new ReportCompositionService({
    artifacts: input.store,
    visualAssets: {
      async readVerified(): Promise<never> {
        throw new Error('fixture has no visual Assets');
      },
    },
    repository: {
      async listArtifactsForAttempt(): Promise<[]> { return []; },
    },
    layoutPlanner: {
      async plan(planInput) {
        input.layoutPlan?.();
        return deterministicReportLayout(planInput.payload);
      },
    },
    ...(input.editorialPlan
      ? { editorialPlanner: { plan: input.editorialPlan } }
      : {}),
    ...(input.showcasePublish
      ? { showcasePublisher: { publish: input.showcasePublish } }
      : {}),
    ...(input.enabled === undefined
      ? {}
      : {
          reportV3Writer: {
            enabled: input.enabled,
            editorialExperienceV1Enabled: input.editorialExperienceV1Enabled ?? false,
          },
        }),
  });
}

test('ReportCompositionService keeps the legacy v2 path unchanged while the v3 writer is disabled', async () => {
  const store = new CompositionArtifactStore();
  let layoutCalls = 0;
  const result = await service({ store, layoutPlan: () => { layoutCalls += 1; } })
    .composeAndStore({
      ...compositionFixture(store),
      expectedModel: 'pinned-model',
    });

  assert.equal(result.document.version, 'report-document-v2');
  assert.equal(result.editorialBlueprintArtifactId, undefined);
  assert.equal(layoutCalls, 1);
  assert.deepEqual(store.writes.map(({ input }) => input.kind), [
    'report_layout_blueprint',
    'report_document',
  ]);
});

test('ReportCompositionService emits a schema-valid linear v3 report and safe Ledger audit when enabled', async () => {
  const store = new CompositionArtifactStore();
  const sealedArtifacts: ControlArtifact[] = [];
  const result = await service({
    store,
    enabled: true,
    editorialExperienceV1Enabled: false,
    layoutPlan: () => { throw new Error('legacy Layout Planner must not run for v3'); },
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
    onArtifactSealed: (artifact) => { sealedArtifacts.push(artifact); },
  });

  assert.equal(result.document.version, 'report-document-v3');
  assert.ok(result.editorialBlueprintArtifactId);
  assert.deepEqual(result.editorialLayout, {
    mode: 'fallback',
    blueprintArtifactId: result.editorialBlueprintArtifactId,
    reasonCode: 'planner_disabled',
  });
  assert.equal(result.layoutBlueprintArtifactId, undefined);
  assert.deepEqual(store.writes.map(({ input }) => [input.kind, input.schemaVersion]), [
    ['report_editorial_blueprint', 'report-editorial-blueprint-v1'],
    ['report_document', 'report-document-v3'],
  ]);
  assert.deepEqual(sealedArtifacts.map(({ id }) => id), store.writes.map(({ artifact }) => artifact.id));

  if (result.document.version !== 'report-document-v3') assert.fail('expected report-document-v3');
  const blockTypes = result.document.sections.flatMap(({ blocks }) => blocks.map(({ type }) => type));
  assert.equal(blockTypes.includes('record-table'), false);
  assert.equal(blockTypes.includes('graph'), false);
  assert.equal(blockTypes.includes('priority-board'), false);
  assert.ok(result.document.notices.some(({ code }) => code === 'visualization_linearized'));
  assert.deepEqual(result.document.auditAppendix?.records, [{
    id: 'audit-record-001',
    contributionArtifactId: 'contribution-1',
    sourceUnitKey: 'source-unit-1',
    sourceSemanticHash: `sha256:${'f'.repeat(64)}`,
    disposition: 'conflicted',
    canonicalNodeIds: ['content-block-001'],
    reasonCode: 'ledger_conflicted',
    reviewIssueIds: ['review-issue-1'],
  }]);
  assert.equal(JSON.stringify(result.document).includes('SECRET contributor prose'), false);
  assert.equal(JSON.stringify(result.document).includes('diagnostic'), false);
});

test('ReportCompositionService uses policy-aware fallback when the v4 Planner is unavailable', async () => {
  const store = new CompositionArtifactStore();
  const result = await service({
    store,
    enabled: true,
    editorialExperienceV1Enabled: true,
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
  });

  assert.equal(result.document.version, 'report-document-v4');
  if (result.document.version !== 'report-document-v4') assert.fail('expected report-document-v4');
  const requestedBindingSection = result.document.sections.find((section) =>
    section.blocks.some((block) => block.unitRefs.some((id) => id.startsWith('requested-artifact'))));
  assert.equal(requestedBindingSection?.prominence, 'supporting');
  assert.ok(result.document.sections.some(({ prominence }) => prominence === 'appendix'));
  assert.equal(result.document.copyMode, 'fallback');
  assert.equal(result.document.notices.filter(({ code }) => code === 'copy_fallback').length, 1);
});

test('ReportCompositionService uses the Editorial Planner for v3 and preserves its model layout binding', async () => {
  const store = new CompositionArtifactStore();
  let editorialCalls = 0;
  let receivedDataClassification: ReportEditorialPlanInput['dataClassification'];
  const editorialPlannerDataClassification = {
    taskSensitivity: 'internal' as const,
    piiDetected: false,
    hasSensitiveOrBlockedEvidence: false,
  };
  const result = await service({
    store,
    enabled: true,
    layoutPlan: () => { throw new Error('legacy Layout Planner must not run for v3'); },
    editorialPlan: async ({ material, presentationOptions, dataClassification }) => {
      editorialCalls += 1;
      receivedDataClassification = dataClassification;
      const blueprint = createDeterministicReportEditorialBlueprintV1(material, presentationOptions);
      blueprint.style = 'editorial';
      blueprint.density = 'compact';
      blueprint.sections.reverse();
      return {
        blueprint,
        mode: 'model',
        warnings: [],
        diagnostics: {
          plannerInputSha256: `sha256:${'9'.repeat(64)}`,
          serializedInputBytes: 1_000,
          presentationUnitCount: material.presentationUnits.length,
          leafUnitCount: material.constraints.requiredLeafUnitIds.length,
          estimatedPromptTokens: 1_000,
          outputBytes: 500,
          latencyMs: 12,
        },
      };
    },
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
    editorialPlannerDataClassification,
  });

  assert.equal(editorialCalls, 1);
  assert.deepEqual(receivedDataClassification, editorialPlannerDataClassification);
  assert.equal(result.document.version, 'report-document-v3');
  if (result.document.version !== 'report-document-v3') assert.fail('expected report-document-v3');
  assert.equal(result.document.layoutMode, 'model');
  assert.equal(result.document.style, 'editorial');
  assert.equal(result.document.density, 'compact');
  assert.deepEqual(result.editorialLayout, {
    mode: 'model',
    blueprintArtifactId: result.editorialBlueprintArtifactId,
  });
  assert.equal(result.document.notices.some(({ code }) => code === 'layout_fallback'), false);
});

test('ReportCompositionService projects accepted Planner copy to v4 when editorial experience is enabled', async () => {
  const store = new CompositionArtifactStore();
  let editorialCalls = 0;
  let copyEnabled = false;
  const result = await service({
    store,
    enabled: true,
    editorialExperienceV1Enabled: true,
    editorialPlan: async ({ material, presentationOptions, enableEditorialCopy }) => {
      editorialCalls += 1;
      copyEnabled = enableEditorialCopy === true;
      const blueprint = createDeterministicReportEditorialBlueprintV1(material, presentationOptions);
      const firstUnitId = blueprint.sections[0]!.blocks[0]!.unitRefs[0]!;
      const firstLeafId = material.presentationUnits.find(({ id }) => id === firstUnitId)!.leafIds[0]!;
      return {
        blueprint,
        mode: 'model',
        warnings: [],
        editorialCopy: {
          fragments: [{
            target: { kind: 'report_title' },
            text: '以可信信息降低新品决策成本',
            sourceLeafIds: [firstLeafId],
          }],
          rejectedFragments: [],
        },
        diagnostics: {
          plannerInputSha256: `sha256:${'7'.repeat(64)}`,
          serializedInputBytes: 1_000,
          presentationUnitCount: material.presentationUnits.length,
          leafUnitCount: material.constraints.requiredLeafUnitIds.length,
          estimatedPromptTokens: 1_000,
          outputBytes: 500,
          latencyMs: 12,
        },
      };
    },
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
  });

  assert.equal(editorialCalls, 1);
  assert.equal(copyEnabled, true);
  assert.equal(result.document.version, 'report-document-v4');
  if (result.document.version !== 'report-document-v4') assert.fail('expected report-document-v4');
  assert.equal(result.document.title.text, '以可信信息降低新品决策成本');
  assert.equal(result.document.title.provenance, 'model');
  assert.equal(result.document.copyMode, 'mixed');
  assert.equal(result.document.notices.filter(({ code }) => code === 'copy_fallback').length, 1);
  assert.deepEqual(store.writes.map(({ input }) => [input.kind, input.schemaVersion]), [
    ['report_editorial_blueprint', 'report-editorial-blueprint-v1'],
    ['report_document', 'report-document-v4'],
  ]);
});

test('ReportCompositionService keeps accepted v4 copy when one fragment is rejected', async () => {
  const store = new CompositionArtifactStore();
  const result = await service({
    store,
    enabled: true,
    editorialExperienceV1Enabled: true,
    editorialPlan: async ({ material, presentationOptions }) => {
      const blueprint = createDeterministicReportEditorialBlueprintV1(material, presentationOptions);
      const firstUnitId = blueprint.sections[0]!.blocks[0]!.unitRefs[0]!;
      const firstLeafId = material.presentationUnits.find(({ id }) => id === firstUnitId)!.leafIds[0]!;
      return {
        blueprint,
        mode: 'model',
        warnings: [],
        editorialCopy: {
          fragments: [
            {
              target: { kind: 'report_title' },
              text: '保留的模型标题',
              sourceLeafIds: [firstLeafId],
            },
            {
              target: { kind: 'section_lead', sectionIndex: 0 },
              text: '保留的章节导语',
              sourceLeafIds: [firstLeafId],
            },
          ],
          rejectedFragments: [{
            fragmentIndex: 1,
            target: { kind: 'executive_summary' },
            reasonCodes: ['unsupported_protected_token'],
          }],
        },
        diagnostics: {
          plannerInputSha256: `sha256:${'6'.repeat(64)}`,
          serializedInputBytes: 1_000,
          presentationUnitCount: material.presentationUnits.length,
          leafUnitCount: material.constraints.requiredLeafUnitIds.length,
          estimatedPromptTokens: 1_000,
          outputBytes: 500,
          latencyMs: 12,
        },
      };
    },
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
  });

  assert.equal(result.document.version, 'report-document-v4');
  if (result.document.version !== 'report-document-v4') assert.fail('expected report-document-v4');
  assert.equal(result.document.title.text, '保留的模型标题');
  assert.equal(result.document.title.provenance, 'model');
  assert.equal(result.document.sections[0]!.lead?.text, '保留的章节导语');
  assert.equal(result.document.sections[0]!.lead?.provenance, 'model');
  assert.equal(result.document.executiveSummary.provenance, 'canonical');
  assert.equal(result.document.copyMode, 'mixed');
  assert.equal(result.document.notices.filter(({ code }) => code === 'copy_fallback').length, 1);
});

test('ReportCompositionService records an Editorial Planner fallback without failing the report', async () => {
  const store = new CompositionArtifactStore();
  const result = await service({
    store,
    enabled: true,
    editorialPlan: async ({ material, presentationOptions }) => ({
      blueprint: createDeterministicReportEditorialBlueprintV1(material, presentationOptions),
      mode: 'fallback',
      reasonCode: 'provider_failure',
      warnings: ['provider_failure'],
      diagnostics: {
        plannerInputSha256: `sha256:${'8'.repeat(64)}`,
        serializedInputBytes: 1_000,
        presentationUnitCount: material.presentationUnits.length,
        leafUnitCount: material.constraints.requiredLeafUnitIds.length,
        estimatedPromptTokens: 1_000,
        latencyMs: 30_000,
      },
    }),
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
  });

  assert.equal(result.document.version, 'report-document-v3');
  if (result.document.version !== 'report-document-v3') assert.fail('expected report-document-v3');
  assert.equal(result.document.layoutMode, 'fallback');
  assert.deepEqual(result.editorialLayout, {
    mode: 'fallback',
    blueprintArtifactId: result.editorialBlueprintArtifactId,
    reasonCode: 'provider_failure',
  });
  assert.ok(result.document.notices.some(({ code }) => code === 'layout_fallback'));
});

test('ReportCompositionService publishes a Showcase from the same Editorial Planner call', async () => {
  const store = new CompositionArtifactStore();
  let showcaseEnabled = false;
  let publishCalls = 0;
  const specArtifact = sealedJsonArtifact({
    id: 'showcase-spec-1',
    kind: 'report_editorial_showcase_spec',
    schemaVersion: 'editorial-presentation-spec-v1',
    value: {},
  });
  const htmlArtifact: ControlArtifact = {
    ...specArtifact,
    id: 'showcase-html-1',
    kind: 'editorial_showcase_html',
    schemaVersion: 'editorial-showcase-html-v1',
    mediaType: 'text/html; charset=utf-8',
  };
  const result = await service({
    store,
    enabled: true,
    editorialExperienceV1Enabled: true,
    editorialPlan: async ({ material, presentationOptions, enableEditorialShowcase }) => {
      showcaseEnabled = enableEditorialShowcase === true;
      return {
        blueprint: createDeterministicReportEditorialBlueprintV1(material, presentationOptions),
        mode: 'model',
        warnings: [],
        editorialCopy: { fragments: [], rejectedFragments: [] },
        showcaseSpec: createDeterministicEditorialShowcaseSpec(material),
        diagnostics: {
          plannerInputSha256: `sha256:${'5'.repeat(64)}`,
          serializedInputBytes: 1_000,
          presentationUnitCount: material.presentationUnits.length,
          leafUnitCount: material.constraints.requiredLeafUnitIds.length,
          estimatedPromptTokens: 1_000,
          outputBytes: 500,
          latencyMs: 12,
        },
      };
    },
    showcasePublish: async ({ spec }) => {
      publishCalls += 1;
      return {
        specArtifact,
        htmlArtifact,
        showcase: {
          status: 'ready',
          specArtifactId: specArtifact.id,
          htmlArtifactId: htmlArtifact.id,
          rendererVersion: 'editorial-showcase-html-v1',
          profileId: 'editorial-showcase-v1',
          generationMode: spec.generationMode,
          showcaseOutlineSignature: spec.showcaseOutlineSignature,
        },
      };
    },
  }).composeAndStore({
    ...compositionFixture(store),
    expectedModel: 'pinned-model',
  });

  assert.equal(showcaseEnabled, true);
  assert.equal(publishCalls, 1);
  assert.equal(result.editorialShowcase?.showcase.status, 'ready');
  assert.equal(result.editorialShowcase?.showcase.htmlArtifactId, 'showcase-html-1');
});

test('ReportCompositionService reports a sealed Blueprint before a later v3 document write fails', async () => {
  const store = new CompositionArtifactStore();
  store.failWriteKind = 'report_document';
  const sealedArtifactIds: string[] = [];

  await assert.rejects(
    service({ store, enabled: true }).composeAndStore({
      ...compositionFixture(store),
      onArtifactSealed: (artifact) => { sealedArtifactIds.push(artifact.id); },
    }),
    /fixture failed report_document write/u,
  );

  assert.deepEqual(store.writes.map(({ input }) => input.kind), ['report_editorial_blueprint']);
  assert.deepEqual(sealedArtifactIds, [store.writes[0]!.artifact.id]);
});
