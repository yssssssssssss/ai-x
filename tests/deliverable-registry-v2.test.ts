import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import type { ControlArtifact, ControlExecutionLease, ControlPlaneRepository } from '../database/control-plane.ts';
import { EvidenceService, type EvidenceManifest } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  CurrentDeliverableService,
  type CurrentDeliverableGenerateInput,
} from '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
import { LeaseExecutionEngine } from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import { ReportEvidenceValidator } from '../apps/orchestrator-runtime/src/evidence/report-evidence-validator.ts';
import {
  PlanCompiler,
  type FrozenDeliverableSelection,
  type PlanCompileInput,
} from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import { ResearchPlanningService } from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import { ReportReviewService, type ReportReviewArtifact } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import { ReportCompositionService } from '../apps/orchestrator-runtime/src/report/report-composition-service.ts';
import { composeReportDocument } from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { getConfigRoot, setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { ToolRouter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { lintRegistries } from '../harness/linters/registry-linter.ts';
import type { VerifiedVisualAsset } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { EvidenceRequirement } from '../packages/api-contract/research-deliverable.ts';
interface DeliverableRegistryEntry {
  id: string;
  status: 'active' | 'inactive';
  task_types: string[];
  envelope_version: string;
  payload_schema: string;
  read_payload_schemas?: string[];
  synthesis_mode?: 'model_synthesis' | 'reviewed_skill_assembly';
  synthesis_prompt: string;
  review_rubric: string;
  evidence_policy: string;
  report_template: string;
  aliases?: string[];
}

interface DeliverableRegistryModule {
  resolveDeliverable(taskType: string, expectedDeliverables: readonly string[]): DeliverableRegistryEntry;
  resolveExecutionDeliverable(
    taskType: string,
    expectedDeliverables: readonly string[],
    declaredDeliverableId: string,
  ): DeliverableRegistryEntry;
  resolveDeliverableContractById(deliverableId: string): {
    entry: DeliverableRegistryEntry;
    readablePayloadSchemas: Array<{ path: string; schema: object }>;
  };
  selectReadablePayloadSchema(
    contract: { entry: DeliverableRegistryEntry; readablePayloadSchemas: Array<{ path: string; schema: object }> },
    payload: unknown,
  ): { path: string; schema: object };
}

const registryModulePath: string = '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
const registryModuleFile = new URL(registryModulePath, import.meta.url);
const originalConfigRoot = getConfigRoot();
const fixtureRoots: string[] = [];

const RESEARCH_PLAN_ENTRY: DeliverableRegistryEntry = {
  id: 'research_plan',
  status: 'active',
  task_types: ['user_research_planning'],
  envelope_version: 'research-deliverable-v1',
  payload_schema: 'schemas/deliverables/research-plan.schema.json',
  synthesis_prompt: 'orchestrator/prompts/deliverables/research-plan.md',
  review_rubric: 'orchestrator/report-rubrics/research-plan.yaml',
  evidence_policy: 'research-plan',
  report_template: 'research-plan',
};

const REPORT_TEMPLATE = {
  version: 1,
  id: 'research-plan',
  subtitle: 'Professional research plan',
  sections: [
    'cover',
    'executive-summary',
    'background',
    'scope-method',
    'key-metrics',
    'findings',
    'question-analysis',
    'visual-evidence',
    'comparison',
    'conclusion',
    'recommendations',
    'risks',
    'appendix',
  ].map((id) => ({ id, title: id })),
};

afterEach(() => {
  setConfigRoot(originalConfigRoot);
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadRegistryModule(): Promise<DeliverableRegistryModule> {
  assert.equal(
    existsSync(registryModuleFile),
    true,
    'Deliverable Registry v2 runtime module must exist',
  );
  const exports = await import(registryModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof exports.resolveDeliverable, 'function');
  assert.equal(typeof exports.resolveDeliverableContractById, 'function');
  assert.equal(typeof exports.selectReadablePayloadSchema, 'function');
  return exports as unknown as DeliverableRegistryModule;
}

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function registryFixture(
  entries: DeliverableRegistryEntry[] = [RESEARCH_PLAN_ENTRY],
): string {
  const root = mkdtempSync(join(tmpdir(), 'deliverable-registry-v2-'));
  fixtureRoots.push(root);
  writeFixtureFile(root, 'orchestrator/deliverable-registry.yaml', stringifyYaml({
    version: 2,
    deliverables: entries,
  }));
  writeFixtureFile(root, 'orchestrator/decision-graph.yaml', stringifyYaml({ version: 1, nodes: [] }));
  writeFixtureFile(root, 'orchestrator/skill-registry.yaml', stringifyYaml({ version: 1, skills: [] }));
  writeFixtureFile(root, 'orchestrator/tool-registry.yaml', stringifyYaml({ version: 1, tools: [] }));
  for (const entry of entries) {
    if (!isAbsolute(entry.payload_schema) && !entry.payload_schema.split(/[\\/]/u).includes('..')) {
      writeFixtureFile(root, entry.payload_schema, JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: true,
      }));
    }
    writeFixtureFile(root, entry.synthesis_prompt, `SYNTHESIS PROMPT FOR ${entry.id}\n`);
    writeFixtureFile(root, entry.review_rubric, stringifyYaml({
      version: 1,
      id: entry.review_rubric.split('/').at(-1)?.replace(/\.yaml$/u, ''),
      dimensions: [{ id: 'evidence', required: true }],
    }));
    writeFixtureFile(root, `orchestrator/report-templates/${entry.report_template}.yaml`, stringifyYaml({
      ...REPORT_TEMPLATE,
      id: entry.report_template,
    }));
  }
  writeFixtureFile(root, 'orchestrator/evidence-policy.yaml', stringifyYaml({
    version: 1,
    policies: entries.map((entry) => ({
      task_type: entry.task_types[0],
      deliverable_type: entry.id,
      requirements: [{
        id: entry.evidence_policy,
        accepted_classes: ['user_input'],
        minimum_count: 1,
        required: true,
      }],
    })),
  }));
  setConfigRoot(root);
  return root;
}

async function assertMissingResourceRejected(
  relativePath: string,
  expectedMessage: RegExp,
): Promise<void> {
  const root = registryFixture();
  rmSync(join(root, relativePath), { recursive: true, force: true });
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('user_research_planning', ['research plan']),
    expectedMessage,
  );
}

test('rejects an active deliverable whose payload schema is missing', async () => {
  await assertMissingResourceRejected(
    RESEARCH_PLAN_ENTRY.payload_schema,
    /payload_schema|schema.*(?:missing|exist|found)/iu,
  );
});

test('rejects an active deliverable whose synthesis prompt is missing', async () => {
  await assertMissingResourceRejected(
    RESEARCH_PLAN_ENTRY.synthesis_prompt,
    /synthesis_prompt|prompt.*(?:missing|exist|found)/iu,
  );
});

test('rejects an active deliverable whose review rubric is missing', async () => {
  await assertMissingResourceRejected(
    RESEARCH_PLAN_ENTRY.review_rubric,
    /review_rubric|rubric.*(?:missing|exist|found)/iu,
  );
});

test('rejects an active deliverable whose evidence policy is missing', async () => {
  await assertMissingResourceRejected(
    'orchestrator/evidence-policy.yaml',
    /evidence_policy|evidence policy|policy.*(?:missing|exist|found)/iu,
  );
});

test('rejects an active deliverable whose report template is missing', async () => {
  await assertMissingResourceRejected(
    `orchestrator/report-templates/${RESEARCH_PLAN_ENTRY.report_template}.yaml`,
    /report_template|report template|template.*(?:missing|exist|found)/iu,
  );
});

for (const field of [
  'payload_schema',
  'synthesis_prompt',
  'review_rubric',
  'evidence_policy',
  'report_template',
] as const) {
  test(`rejects an active deliverable missing the ${field} declaration`, async () => {
    const root = registryFixture();
    const malformed = { ...RESEARCH_PLAN_ENTRY } as Partial<DeliverableRegistryEntry>;
    delete malformed[field];
    writeFixtureFile(root, 'orchestrator/deliverable-registry.yaml', stringifyYaml({
      version: 2,
      deliverables: [malformed],
    }));
    const { resolveDeliverable } = await loadRegistryModule();
    assert.throws(
      () => resolveDeliverable('user_research_planning', ['research plan']),
      new RegExp(`${field}|registry.*invalid|missing`, 'iu'),
    );
  });
}

test('Registry linter reports a missing active Deliverable resource', () => {
  const root = registryFixture();
  rmSync(join(root, RESEARCH_PLAN_ENTRY.payload_schema));
  const issues = lintRegistries();
  assert.ok(issues.some((issue) => (
    issue.target.includes('research_plan')
    && /payload_schema|schema.*(?:missing|exist|found)/iu.test(issue.message)
  )));
});

test('rejects duplicate active task type mappings instead of choosing by registry order', async () => {
  registryFixture([
    RESEARCH_PLAN_ENTRY,
    {
      ...RESEARCH_PLAN_ENTRY,
      id: 'research_plan_duplicate',
      synthesis_prompt: 'orchestrator/prompts/deliverables/research-plan-duplicate.md',
      review_rubric: 'orchestrator/report-rubrics/research-plan-duplicate.yaml',
    },
  ]);
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('user_research_planning', ['research plan']),
    /duplicate.*task|task.*multiple|ambiguous.*task/iu,
  );
});

test('rejects an unsupported task type', async () => {
  registryFixture();
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('unsupported_research_task', ['research plan']),
    /unsupported.*task|no active deliverable|not mapped/iu,
  );
});

test('rejects a task mapped only to an inactive deliverable', async () => {
  registryFixture([{ ...RESEARCH_PLAN_ENTRY, status: 'inactive' }]);
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('user_research_planning', ['research plan']),
    /inactive|no active deliverable|unsupported.*task/iu,
  );
});

test('rejects a legacy version 1 Deliverable Registry', async () => {
  const root = registryFixture();
  writeFixtureFile(root, 'orchestrator/deliverable-registry.yaml', stringifyYaml({
    version: 1,
    deliverables: [RESEARCH_PLAN_ENTRY],
  }));
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('user_research_planning', ['research plan']),
    /version.*2|registry.*version/iu,
  );
});

test('rejects malformed registry entries before resolution', async () => {
  const root = registryFixture();
  writeFixtureFile(root, 'orchestrator/deliverable-registry.yaml', [
    'version: 2',
    'deliverables:',
    '  - id: research_plan',
    '    status: active',
    '    task_types: user_research_planning',
    '    envelope_version: research-deliverable-v1',
    `    payload_schema: ${RESEARCH_PLAN_ENTRY.payload_schema}`,
    `    synthesis_prompt: ${RESEARCH_PLAN_ENTRY.synthesis_prompt}`,
    `    review_rubric: ${RESEARCH_PLAN_ENTRY.review_rubric}`,
    '    evidence_policy: research-plan',
    '    report_template: research-plan',
  ].join('\n'));
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('user_research_planning', ['research plan']),
    /task_types.*array|malformed.*task_types|registry.*invalid/iu,
  );
});

test('rejects registry resource paths that escape the configured root', async () => {
  registryFixture([{
    ...RESEARCH_PLAN_ENTRY,
    payload_schema: '../outside.schema.json',
  }]);
  const { resolveDeliverable } = await loadRegistryModule();
  assert.throws(
    () => resolveDeliverable('user_research_planning', ['research plan']),
    /path.*(?:escape|unsafe|outside)|containment|traversal/iu,
  );
});

test('resolves the production research_plan contract for user research planning', async () => {
  setConfigRoot(originalConfigRoot);
  const { resolveDeliverable } = await loadRegistryModule();
  const resolved = resolveDeliverable('user_research_planning', ['research plan']);
  assert.deepEqual({
    id: resolved.id,
    status: resolved.status,
    task_types: resolved.task_types,
    envelope_version: resolved.envelope_version,
    payload_schema: resolved.payload_schema,
    synthesis_prompt: resolved.synthesis_prompt,
    review_rubric: resolved.review_rubric,
    evidence_policy: resolved.evidence_policy,
    report_template: resolved.report_template,
  }, RESEARCH_PLAN_ENTRY);
});

test('selects the exact readable research strategy schema from the payload version', async () => {
  setConfigRoot(originalConfigRoot);
  const { resolveDeliverableContractById, selectReadablePayloadSchema } = await loadRegistryModule();
  const contract = resolveDeliverableContractById('research_strategy_report');
  assert.equal(contract.entry.synthesis_mode, 'reviewed_skill_assembly');
  assert.match(selectReadablePayloadSchema(contract, {}).path, /research-strategy-report\.schema\.json$/u);
  assert.match(
    selectReadablePayloadSchema(contract, { schemaVersion: 'research-strategy-content-v2' }).path,
    /research-strategy-report-v2\.schema\.json$/u,
  );
  assert.throws(
    () => selectReadablePayloadSchema(contract, { schemaVersion: 'unknown-v9' }),
    /does not support payload schema version unknown-v9/,
  );
});

test('resolveDeliverable is deterministic and does not mutate expected deliverables', async () => {
  registryFixture();
  const { resolveDeliverable } = await loadRegistryModule();
  const expectedDeliverables = Object.freeze(['research plan', 'appendix']);
  const first = resolveDeliverable('user_research_planning', expectedDeliverables);
  const second = resolveDeliverable('user_research_planning', expectedDeliverables);
  assert.deepEqual(second, first);
  assert.deepEqual(expectedDeliverables, ['research plan', 'appendix']);
});

class RegistryIntegrationLLM {
  readonly calls: StructuredLLMCallOptions[] = [];

  async generateStructured<T>(input: StructuredLLMCallOptions): Promise<{ data: T }> {
    this.calls.push(input);
    return {
      data: {
        methodSummary: 'registry-selected method',
        findingGraph: {
          findings: [{ id: 'F1', kind: 'fact', evidenceIds: ['E1'], statement: 'fact' }],
          analyses: [{ id: 'A1', findingIds: ['F1'], statement: 'analysis' }],
          subQuestionSummaries: [{ id: 'S1', findingIds: ['F1'], analysisIds: ['A1'], summary: 'summary' }],
          overallConclusions: [{ id: 'C1', summaryIds: ['S1'], statement: 'conclusion' }],
        },
        payload: {
          visualEvidence: [],
          screenshotComparisons: [{
            id: 'comparison-1',
            dimension: 'registry',
            sampleIds: [],
            assetIds: ['asset-registry-original', 'asset-registry-annotation'],
            caption: 'Registry visual pair',
          }],
        },
        recommendations: [{ id: 'R1', summaryIds: ['S1'], statement: 'recommendation' }],
        coverage: {
          questionBindings: [{ questionId: 'Q1', summaryIds: ['S1'] }],
          successCriterionBindings: [{
            successCriterionId: 'SC1',
            conclusionIds: ['C1'],
            recommendationIds: ['R1'],
          }],
        },
        risksAndOpenIssues: [],
      } as T,
    };
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function nonResearchVisualPair(binding: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
} = {
  taskId: 'task-registry-integration',
  planVersionId: 'plan-registry-integration',
  attemptId: 'attempt-registry-integration',
}): VerifiedVisualAsset[] {
  const bytes = Buffer.from([0]);
  const contentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const manifestArtifact = (id: string, manifest: unknown) => {
    const digest = digestJson(manifest);
    return {
      id,
      ...binding,
      kind: 'visual_asset_manifest' as const,
      state: 'SEALED' as const,
      storageUri: `/private/${id}`,
      ...digest,
      schemaVersion: 'visual-asset-manifest-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
    };
  };
  const originalManifestDraft = {
    version: 'visual-asset-manifest-v1' as const,
    ...binding,
    assetId: 'asset-registry-original',
    contentSha256,
    mediaType: 'image/png' as const,
    byteSize: bytes.byteLength,
    width: 1,
    height: 1,
    exportPolicy: 'allow' as const,
    source: { kind: 'user_upload' as const, fileName: 'original.png' },
    derivedFrom: null,
    derivation: null,
  };
  const originalManifest = {
    ...originalManifestDraft,
    manifestHash: canonicalHash(originalManifestDraft),
  };
  const original = {
    artifact: {
      id: originalManifest.assetId,
      ...binding,
      kind: 'visual_asset' as const,
      state: 'SEALED' as const,
      storageUri: '/private/asset-registry-original',
      contentSha256,
      byteSize: bytes.byteLength,
      schemaVersion: 'binary-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
      mediaType: 'image/png' as const,
      metadata: { width: 1, height: 1 },
    },
    bytes,
    metadata: { contentType: 'image/png' as const, byteSize: bytes.byteLength, width: 1, height: 1 },
    manifest: originalManifest,
    manifestArtifact: manifestArtifact('manifest-registry-original', originalManifest),
  } as VerifiedVisualAsset;
  const annotationManifestDraft = {
    ...originalManifest,
    assetId: 'asset-registry-annotation',
    source: { kind: 'derived' as const },
    derivedFrom: {
      assetId: original.artifact.id,
      manifestArtifactId: original.manifestArtifact.id,
      contentSha256: original.manifest.contentSha256,
      manifestHash: original.manifest.manifestHash,
    },
    derivation: { kind: 'annotation' as const, overlayArtifactId: 'overlay-registry' },
  };
  const { manifestHash: _originalHash, ...annotationManifestWithoutHash } = annotationManifestDraft;
  const annotationManifest = {
    ...annotationManifestWithoutHash,
    manifestHash: canonicalHash(annotationManifestWithoutHash),
  };
  const annotation = {
    ...original,
    artifact: {
      ...original.artifact,
      id: annotationManifest.assetId,
      storageUri: '/private/asset-registry-annotation',
    },
    manifest: annotationManifest,
    manifestArtifact: manifestArtifact('manifest-registry-annotation', annotationManifest),
  } as VerifiedVisualAsset;
  return [original, annotation];
}


test('CurrentDeliverableService and ReportEvidenceValidator accept a registry-selected nonresearch contract', async () => {
  const customEntry: DeliverableRegistryEntry = {
    id: 'competitive_analysis_report',
    status: 'active',
    task_types: ['competitive_research'],
    aliases: ['competitive analysis report'],
    envelope_version: 'research-deliverable-v1',
    payload_schema: 'schemas/deliverables/competitive-analysis-report.schema.json',
    synthesis_prompt: 'orchestrator/prompts/deliverables/competitive-analysis-report.md',
    review_rubric: 'orchestrator/report-rubrics/competitive-analysis-report.yaml',
    evidence_policy: 'competitive-analysis-evidence',
    report_template: 'competitive-analysis-report',
  };
  const root = registryFixture([customEntry]);
  writeFixtureFile(root, customEntry.synthesis_prompt, 'REGISTRY_SELECTED_SYNTHESIS_PROMPT\n');
  const validatedFiles: string[] = [];
  const llm = new RegistryIntegrationLLM();
  const evidence = {
    validateManifest(): void {},
    resolveEvidenceValue(): unknown { return null; },
    validateFindingGraph(): void {},
  } as unknown as EvidenceService;
  const service = new CurrentDeliverableService({
    llm,
    validator: {
      validateFileOrThrow(path: string): void { validatedFiles.push(path); },
      validateSchemaOrThrow(): void {},
    },
    evidence,
    artifacts: {
      async writeJson(): Promise<{ id: string }> { return { id: 'deliverable-artifact-1' }; },
    },
  });
  const evidenceManifest: EvidenceManifest = {
    version: 'evidence-v1',
    taskId: 'task-registry-integration',
    planVersionId: 'plan-registry-integration',
    attemptId: 'attempt-registry-integration',
    collectedAt: '2026-08-17T00:00:00.000Z',
    manifestHash: `sha256:${'a'.repeat(64)}`,
    entries: [],
  };
  const input: CurrentDeliverableGenerateInput = {
    task: { id: evidenceManifest.taskId },
    plan: {
      id: evidenceManifest.planVersionId,
      plan: { deliverable_type: customEntry.id },
    },
    attempt: { id: evidenceManifest.attemptId },
    researchGoal: 'Use the selected deliverable contract',
    finalizedRequirement: {
      version: 'research-task-v2',
      task_type: 'competitive_research',
      expected_deliverables: [customEntry.id],
      success_criteria: [{ id: 'SC1', statement: 'covered' }],
    },
    problemGraph: { questions: [{ id: 'Q1', priority: 'required' }] },
    evidenceManifest: {
      artifact: {
        id: 'evidence-manifest-artifact-1',
        contentSha256: evidenceManifest.manifestHash,
        state: 'SEALED',
      },
      value: evidenceManifest,
    },
    evidenceResolver: { resolveArtifact: () => null },
    outputs: [],
    visualAssets: nonResearchVisualPair(),
    gaps: [],
    expectedModel: 'pinned-model',
  };

  const result = await service.generate(input);

  assert.deepEqual(validatedFiles, [join(root, customEntry.payload_schema)]);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0]?.prompt ?? '', /REGISTRY_SELECTED_SYNTHESIS_PROMPT/u);
  assert.equal(result.deliverable.deliverableType, customEntry.id);
});

class NoCallLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway',
    endpointHost: 'llm.test',
    requestedModel: 'fixture-model',
    mode: 'real',
    eligibleAsReal: true,
  };
  calls = 0;

  async generateStructured<T>(_options: StructuredLLMCallOptions): Promise<never> {
    this.calls += 1;
    throw new Error('LLM must not be called by this preflight integration');
  }

  async generateText(_options: TextLLMCallOptions): Promise<never> {
    this.calls += 1;
    throw new Error('LLM must not be called by this preflight integration');
  }
}

test('LeaseExecutionEngine accepts a registry-resolved non-research_plan before evidence execution', async () => {
  const competitiveEntry: DeliverableRegistryEntry = {
    ...RESEARCH_PLAN_ENTRY,
    id: 'competitive_analysis_report',
    task_types: ['competitive_research'],
    aliases: ['competitive analysis report'],
  };
  registryFixture([competitiveEntry]);
  const lease: ControlExecutionLease = {
    taskId: 'task-engine-registry',
    planVersionId: 'plan-engine-registry',
    attemptId: 'attempt-engine-registry',
    leaseOwner: 'registry-test-worker',
    leaseToken: 'registry-test-token',
  };
  const recordedSteps: Array<Record<string, unknown>> = [];
  const repository = {
    async requireActiveLease(): Promise<{ stateVersion: number }> { return { stateVersion: 1 }; },
    async getPlanVersionDetail(): Promise<Record<string, unknown>> {
      return {
        id: lease.planVersionId,
        taskId: lease.taskId,
        pendingInputs: [],
        plan: {
          task_id: lease.taskId,
          deliverable_type: competitiveEntry.id,
          evidence_requirements: [{
            id: 'owner-input',
            acceptedClasses: ['user_input'],
            minimumCount: 0,
            required: true,
          }],
          steps: [],
        },
      };
    },
    async getTaskDetail(): Promise<Record<string, unknown>> {
      return {
        id: lease.taskId,
        ownerUserId: 'owner-engine-registry',
        structuredTask: {
          version: 'research-task-v2',
          task_type: 'competitive_research',
          research_goal: 'compare products',
          expected_deliverables: ['competitive analysis report'],
        },
      };
    },
    async listGateRecords(): Promise<[]> { return []; },
    async listExecutionSteps(): Promise<[]> { return []; },
    async recordExecutionStep(step: Record<string, unknown>): Promise<void> { recordedSteps.push(step); },
    async pauseExecution(): Promise<void> {},
  } as unknown as ControlPlaneRepository;
  const llm = new NoCallLLM();
  const engine = new LeaseExecutionEngine({
    repository,
    artifacts: {} as never,
    tools: new ToolRouter(),
    llm,
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
    deliverables: {
      async generate(): Promise<never> {
        throw new Error('deliverable generation must not be reached without core evidence');
      },
    },
  });

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'fixture-model' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /execution has no valid core Tool evidence/iu);
      assert.doesNotMatch(error.message, /deliverable type is unsupported/iu);
      return true;
    },
  );
  assert.equal(llm.calls, 0);
  assert.equal(recordedSteps.at(-1)?.stepName, 'evidence manifest');
});

const NONRESEARCH_ENTRY: DeliverableRegistryEntry = {
  id: 'competitive_analysis_report',
  status: 'active',
  task_types: ['competitive_research'],
  aliases: ['competitive analysis report'],
  envelope_version: 'research-deliverable-v1',
  payload_schema: 'schemas/deliverables/competitive-analysis-report.schema.json',
  synthesis_prompt: 'orchestrator/prompts/deliverables/competitive-analysis-report.md',
  review_rubric: 'orchestrator/report-rubrics/competitive-analysis-report.yaml',
  evidence_policy: 'competitive-analysis-evidence',
  report_template: 'competitive-analysis-report',
};

function planningRequirement(deliverableId: string): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'product',
    research_goal: 'compare products',
    target_audience: ['product team'],
    scope: ['public evidence'],
    constraints: [],
    success_criteria: [{ id: 'SC1', statement: 'conclusions are traceable' }],
    expected_deliverables: [deliverableId],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
}

function planningCompileInput(
  deliverableSelection: FrozenDeliverableSelection,
  evidenceRequirements: EvidenceRequirement[] = deliverableSelection.evidenceRequirements,
): PlanCompileInput {
  return {
    candidate: {
      id: 'depth',
      title: 'Registry-selected plan',
      rationale: 'Use the selected report contract',
      tradeoffs: 'Thorough over fast',
      assumptions: [],
      activated_nodes: [],
      steps: [{
        step_no: 1,
        step_name: 'Review evidence',
        actor_type: 'reviewer',
        actor_id: 'registry-reviewer',
        question_ids: ['Q1'],
        depends_on: [],
        input: {},
        input_bindings: [],
        expected_outputs: [{ pointer: '/review', description: 'review' }],
        acceptance_criteria: ['evidence is reviewed'],
        requires_approval: false,
        fallback_actor_ids: [],
      }],
    },
    task: planningRequirement(deliverableSelection.deliverableId),
    deliverable_selection: {
      deliverableId: deliverableSelection.deliverableId,
      evidenceRequirements: structuredClone(deliverableSelection.evidenceRequirements),
    },
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'Q1',
        statement: 'What does verified evidence show?',
        rationale: 'Required for the report',
        priority: 'required',
        success_criterion_ids: ['SC1'],
        evidence_requirements: structuredClone(evidenceRequirements),
        acceptance_criteria: ['answer is traceable'],
        depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'fixture-model',
      modelVersion: 'fixture-v1',
      promptHash: 'sha256:fixture',
      traceId: 'trace-fixture',
    },
    capability_resolution: { eligible: [], rejected: [] },
    evidence_requirements: structuredClone(evidenceRequirements),
    activated_nodes: [],
  };
}

test('production planning resolves task type to the Registry Evidence Policy', async () => {
  registryFixture([NONRESEARCH_ENTRY]);
  const expectedEvidence: EvidenceRequirement[] = [{
    id: NONRESEARCH_ENTRY.evidence_policy,
    acceptedClasses: ['user_input'],
    minimumCount: 1,
    required: true,
  }];
  let plannedEvidence: EvidenceRequirement[] | undefined;
  const planning = new ResearchPlanningService({
    llm: { identity: { requestedModel: 'fixture-model' } },
  } as never);
  const compileInput = planningCompileInput({
    deliverableId: NONRESEARCH_ENTRY.id,
    evidenceRequirements: expectedEvidence,
  });
  Reflect.set(planning, 'routedPlanner', {
    async planCurrent(_context: unknown, evidenceRequirements: EvidenceRequirement[]) {
      plannedEvidence = structuredClone(evidenceRequirements);
      return {
        activated: [],
        decisionStates: [],
        candidates: [compileInput.candidate],
        guidanceSources: [],
        planProvenance: compileInput.problem_graph_provenance,
        problemGraph: compileInput.problem_graph,
        problemGraphProvenance: compileInput.problem_graph_provenance,
        capabilityResolution: compileInput.capability_resolution,
      };
    },
  });

  await planning.planCurrentFromRequirement(planningRequirement(NONRESEARCH_ENTRY.id));

  assert.deepEqual(plannedEvidence, expectedEvidence);
});

test('current execution plan schema accepts the exact active Registry deliverable ID', () => {
  registryFixture([NONRESEARCH_ENTRY]);
  const evidenceRequirements: EvidenceRequirement[] = [{
    id: NONRESEARCH_ENTRY.evidence_policy,
    acceptedClasses: ['user_input'],
    minimumCount: 1,
    required: true,
  }];
  const compiled = new PlanCompiler().compile(planningCompileInput({
    deliverableId: NONRESEARCH_ENTRY.id,
    evidenceRequirements,
  }));
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('current-execution-plan', {
    ...compiled.plan,
    deliverable_type: NONRESEARCH_ENTRY.id,
  }));
});

test('PlanCompiler freezes the Registry-selected deliverable and matching Evidence Policy', () => {
  registryFixture([NONRESEARCH_ENTRY]);
  const evidenceRequirements: EvidenceRequirement[] = [{
    id: NONRESEARCH_ENTRY.evidence_policy,
    acceptedClasses: ['user_input'],
    minimumCount: 1,
    required: true,
  }];
  const compiled = new PlanCompiler().compile(planningCompileInput({
    deliverableId: NONRESEARCH_ENTRY.id,
    evidenceRequirements,
  }));
  assert.equal(compiled.plan.deliverable_type, NONRESEARCH_ENTRY.id);
  assert.deepEqual(compiled.plan.evidence_requirements, evidenceRequirements);
});

test('PlanCompiler rejects Evidence Policy requirements that do not match the frozen selection', () => {
  registryFixture([NONRESEARCH_ENTRY]);
  const frozenEvidence: EvidenceRequirement[] = [{
    id: NONRESEARCH_ENTRY.evidence_policy,
    acceptedClasses: ['user_input'],
    minimumCount: 1,
    required: true,
  }];
  const mismatched: EvidenceRequirement[] = [{
    id: 'generic-evidence',
    acceptedClasses: ['user_input'],
    minimumCount: 1,
    required: true,
  }];
  assert.throws(
    () => new PlanCompiler().compile(planningCompileInput(
      {
        deliverableId: NONRESEARCH_ENTRY.id,
        evidenceRequirements: frozenEvidence,
      },
      mismatched,
    )),
    {
      message: `Evidence requirements do not match frozen deliverable selection ${NONRESEARCH_ENTRY.id}`,
    },
  );
});

function nonresearchEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'research-deliverable-v1',
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    deliverableType: NONRESEARCH_ENTRY.id,
    evidenceManifestArtifactId: 'evidence-manifest-nonresearch',
    methodSummary: 'Compare verified evidence',
    findingGraph: {
      findings: [{ id: 'F1', kind: 'fact', evidenceIds: ['E1'], statement: 'Verified fact' }],
      analyses: [{ id: 'A1', findingIds: ['F1'], statement: 'Analysis' }],
      subQuestionSummaries: [{ id: 'S1', findingIds: ['F1'], analysisIds: ['A1'], summary: 'Summary' }],
      overallConclusions: [{ id: 'C1', summaryIds: ['S1'], statement: 'Conclusion' }],
    },
    payload: competitiveAnalysisPayload(),
    recommendations: [{ id: 'R1', summaryIds: ['S1'], statement: 'Act' }],
    coverage: {
      questionBindings: [{ questionId: 'Q1', summaryIds: ['S1'] }],
      successCriterionBindings: [{
        successCriterionId: 'SC1',
        conclusionIds: ['C1'],
        recommendationIds: ['R1'],
      }],
    },
    risksAndOpenIssues: [],
    capabilityProvenance: [],
    ...overrides,
  };
}

function competitiveAnalysisPayload(): Record<string, unknown> {
  return {
    competitorSamples: [{
      id: 'sample-1',
      name: 'Product A',
      rationale: 'Primary verified sample',
      evidenceIds: ['E1'],
    }],
    dimensionMatrix: [{
      dimension: 'positioning',
      values: [{ sampleId: 'sample-1', value: 'Verified positioning', evidenceIds: ['E1'] }],
    }],
    differences: [{
      id: 'difference-1',
      dimension: 'positioning',
      statement: 'Differentiated positioning',
      evidenceIds: ['E1'],
    }],
    impacts: [{
      differenceId: 'difference-1',
      audience: 'Product team',
      statement: 'Clarifies product choice',
    }],
    actionRecommendations: [{
      id: 'action-1',
      differenceIds: ['difference-1'],
      priority: 'P1',
      statement: 'Validate positioning',
    }],
    screenshotComparisons: [{
      id: 'screenshot-1',
      dimension: 'positioning',
      sampleIds: ['sample-1'],
      assetIds: ['asset-registry-original', 'asset-registry-annotation'],
      caption: 'Verified screenshot comparison',
    }],
  };
}

test('ReportEvidenceValidator applies generic envelope invariants to a nonresearch deliverable', () => {
  registryFixture([NONRESEARCH_ENTRY]);
  const evidenceManifest: EvidenceManifest = {
    version: 'evidence-v1',
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    collectedAt: '2026-08-17T00:00:00.000Z',
    manifestHash: `sha256:${'a'.repeat(64)}`,
    entries: [],
  };
  const validator = new ReportEvidenceValidator(
    { validateFindingGraph(): void {} } as unknown as EvidenceService,
  );
  assert.doesNotThrow(() => validator.validate({
    manifest: evidenceManifest,
    report: nonresearchEnvelope(),
    resolver: { resolveArtifact: () => null },
    requireCoverage: true,
  }));
  assert.throws(
    () => validator.validate({
      manifest: evidenceManifest,
      report: nonresearchEnvelope({ taskId: 'other-task' }),
      resolver: { resolveArtifact: () => null },
      requireCoverage: true,
    }),
    /taskId.*does not match/iu,
  );
});

const REVIEW_DIMENSION_IDS = [
  'requirement_coverage',
  'question_coverage',
  'evidence_coverage',
  'reasoning_quality',
  'recommendation_quality',
  'visual_quality',
  'risk_disclosure',
] as const;

function passingReview(deliverableArtifactId: string): ReportReviewArtifact {
  return {
    version: 'report-review-v1',
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    deliverableArtifactId,
    verdict: 'pass',
    dimensions: REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
  };
}

test('ReportReviewService selects the nonresearch Registry rubric', async () => {
  const root = registryFixture([NONRESEARCH_ENTRY]);
  writeFixtureFile(root, NONRESEARCH_ENTRY.review_rubric, stringifyYaml({
    version: 1,
    id: 'competitive-analysis-report',
    marker: 'NONRESEARCH_RUBRIC_SENTINEL',
    dimensions: REVIEW_DIMENSION_IDS.map((id) => ({ id, required: true })),
  }));
  const calls: StructuredLLMCallOptions[] = [];
  const deliverableArtifactId = 'deliverable-nonresearch';
  const service = new ReportReviewService({
    llm: {
      async generateStructured<T>(options: StructuredLLMCallOptions) {
        calls.push(options);
        return {
          data: passingReview(deliverableArtifactId) as T,
          promptHash: 'sha256:review',
          modelName: 'fixture-model',
          modelVersion: 'fixture-v1',
          traceId: 'trace-review',
        };
      },
    },
    artifacts: {
      async writeJson() { return { id: 'review-nonresearch', state: 'SEALED' }; },
    },
  });
  const activeLease: ControlExecutionLease = {
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    leaseOwner: 'review-worker',
    leaseToken: 'review-token',
  };
  const result = await service.review({
    task: { id: activeLease.taskId },
    plan: { id: activeLease.planVersionId },
    attempt: { id: activeLease.attemptId },
    deliverableArtifactId,
    deliverable: nonresearchEnvelope(),
    successCriterionIds: ['SC1'],
    questionIds: ['Q1'],
    evidenceIds: ['E1'],
    expectedModel: 'fixture-model',
    activeLease,
  });
  assert.equal(result.verdict, 'pass');
  assert.match(JSON.stringify(calls[0]), /NONRESEARCH_RUBRIC_SENTINEL/u);
});

function digestJson(value: unknown): { contentSha256: string; byteSize: number } {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  return {
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteSize: bytes.byteLength,
  };
}

function sealedJsonArtifact(
  id: string,
  kind: string,
  schemaVersion: string,
  value: unknown,
): ControlArtifact {
  return {
    id,
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    kind,
    state: 'SEALED',
    storageUri: `/private/${id}`,
    ...digestJson(value),
    schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: null,
    metadata: null,
  };
}

function compositionFixture() {
  const resolvedEvidence = {
    artifact: {
      id: 'evidence-source-nonresearch',
      contentSha256: `sha256:${'b'.repeat(64)}`,
    },
    value: { claim: 'verified' },
  };
  const evidenceArtifactResolver = {
    resolveArtifact: (artifactId: string) => (
      artifactId === resolvedEvidence.artifact.id ? resolvedEvidence : null
    ),
  };
  const evidenceManifest = new EvidenceService().createManifest({
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    collectedAt: '2026-08-17T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'knowledge_excerpt',
      evidenceClass: 'dataset',
      artifactId: resolvedEvidence.artifact.id,
      artifactContentSha256: resolvedEvidence.artifact.contentSha256,
      jsonPointer: '/claim',
      sensitivity: 'public',
      redaction: 'none',
    }],
  }, evidenceArtifactResolver);
  const deliverable = nonresearchEnvelope() as never;
  const review = passingReview('deliverable-nonresearch');
  return {
    requiredQuestionIds: ['Q1'],
    deliverable: {
      artifact: sealedJsonArtifact(
        'deliverable-nonresearch',
        'deliverable',
        'research-deliverable-v1-review-gated',
        deliverable,
      ),
      value: deliverable,
    },
    evidenceManifest: {
      artifact: sealedJsonArtifact(
        'evidence-manifest-nonresearch',
        'evidence_manifest',
        'evidence-v1',
        evidenceManifest,
      ),
      value: evidenceManifest,
    },
    evidenceArtifactResolver,
    review: {
      artifact: sealedJsonArtifact('review-nonresearch', 'report_review', 'report-review-v1', review),
      value: review,
    },
    visualAssets: nonResearchVisualPair({
      taskId: 'task-nonresearch',
      planVersionId: 'plan-nonresearch',
      attemptId: 'attempt-nonresearch',
    }),
    charts: [],
  };
}

test('Composer validates the nonresearch payload schema and uses its Registry template', () => {
  const root = registryFixture([NONRESEARCH_ENTRY]);
  writeFixtureFile(root, `orchestrator/report-templates/${NONRESEARCH_ENTRY.report_template}.yaml`, stringifyYaml({
    ...REPORT_TEMPLATE,
    id: NONRESEARCH_ENTRY.report_template,
    subtitle: 'NONRESEARCH_TEMPLATE_SENTINEL',
  }));
  const document = composeReportDocument({
    templateId: NONRESEARCH_ENTRY.report_template,
    ...compositionFixture(),
  } as never);
  assert.equal(document.subtitle, 'NONRESEARCH_TEMPLATE_SENTINEL');
});

test('ReportCompositionService selects the nonresearch Registry template', async () => {
  const root = registryFixture([NONRESEARCH_ENTRY]);
  writeFixtureFile(root, `orchestrator/report-templates/${NONRESEARCH_ENTRY.report_template}.yaml`, stringifyYaml({
    ...REPORT_TEMPLATE,
    id: NONRESEARCH_ENTRY.report_template,
    subtitle: 'NONRESEARCH_TEMPLATE_SENTINEL',
  }));
  const fixture = compositionFixture();
  const service = new ReportCompositionService({
    artifacts: {
      async readVerifiedJson(): Promise<never> { throw new Error('not used'); },
      async writeJson(input: { value: unknown }) {
        return sealedJsonArtifact('report-document-nonresearch', 'report_document', 'report-document-v1', input.value);
      },
    },
    visualAssets: {
      async readVerified(input: { assetId: string; manifestArtifactId: string }) {
        const asset = fixture.visualAssets.find((candidate) => (
          candidate.artifact.id === input.assetId
          && candidate.manifestArtifact.id === input.manifestArtifactId
        ));
        if (!asset) throw new Error('missing visual asset');
        return asset;
      },
    },
    repository: {
      async listArtifactsForAttempt(): Promise<[]> { return []; },
    },
  } as never);
  const activeLease: ControlExecutionLease = {
    taskId: 'task-nonresearch',
    planVersionId: 'plan-nonresearch',
    attemptId: 'attempt-nonresearch',
    leaseOwner: 'composition-worker',
    leaseToken: 'composition-token',
  };
  const result = await service.composeAndStore({
    taskId: activeLease.taskId,
    planVersionId: activeLease.planVersionId,
    attemptId: activeLease.attemptId,
    ...fixture,
    activeLease,
  } as never);
  assert.equal(result.document.subtitle, 'NONRESEARCH_TEMPLATE_SENTINEL');
});

test('resolveExecutionDeliverable fallback accepts the exact active Registry ID', async () => {
  registryFixture([NONRESEARCH_ENTRY]);
  const { resolveExecutionDeliverable } = await loadRegistryModule();
  assert.equal(
    resolveExecutionDeliverable('unmapped_task', [NONRESEARCH_ENTRY.id], NONRESEARCH_ENTRY.id).id,
    NONRESEARCH_ENTRY.id,
  );
});

test('resolveExecutionDeliverable fallback accepts an explicit Registry alias', async () => {
  const entry = { ...NONRESEARCH_ENTRY, aliases: ['competition_report'] };
  registryFixture([entry]);
  const { resolveExecutionDeliverable } = await loadRegistryModule();
  assert.equal(
    resolveExecutionDeliverable('unmapped_task', ['competition_report'], 'competition_report').id,
    entry.id,
  );
});

for (const label of ['竞品分析报告', 'analysis', 'competitive analysis']) {
  test(`resolveExecutionDeliverable fallback rejects non-explicit label ${label}`, async () => {
    registryFixture([NONRESEARCH_ENTRY]);
    const { resolveExecutionDeliverable } = await loadRegistryModule();
    assert.throws(
      () => resolveExecutionDeliverable('unmapped_task', [label], NONRESEARCH_ENTRY.id),
      /incompatible|unsupported|alias|exact/iu,
    );
  });
}
