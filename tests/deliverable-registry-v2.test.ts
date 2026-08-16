import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import type { ControlExecutionLease, ControlPlaneRepository } from '../database/control-plane.ts';
import type { EvidenceManifest, EvidenceService } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  CurrentDeliverableService,
  type CurrentDeliverableGenerateInput,
} from '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
import { LeaseExecutionEngine } from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
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

interface DeliverableRegistryEntry {
  id: string;
  status: 'active' | 'inactive';
  task_types: string[];
  envelope_version: string;
  payload_schema: string;
  synthesis_prompt: string;
  review_rubric: string;
  evidence_policy: string;
  report_template: string;
}

interface DeliverableRegistryModule {
  resolveDeliverable(taskType: string, expectedDeliverables: readonly string[]): DeliverableRegistryEntry;
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
        payload: {},
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

test('CurrentDeliverableService uses the registry-selected schema and synthesis prompt', async () => {
  const customEntry: DeliverableRegistryEntry = {
    ...RESEARCH_PLAN_ENTRY,
    payload_schema: 'schemas/deliverables/registry-selected.schema.json',
    synthesis_prompt: 'orchestrator/prompts/deliverables/registry-selected.md',
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
      plan: { deliverable_type: 'research_plan' },
    },
    attempt: { id: evidenceManifest.attemptId },
    researchGoal: 'Use the selected deliverable contract',
    finalizedRequirement: {
      version: 'research-task-v2',
      task_type: 'user_research_planning',
      expected_deliverables: ['research plan'],
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
    gaps: [],
    expectedModel: 'pinned-model',
  };

  await service.generate(input);

  assert.deepEqual(validatedFiles, [join(root, customEntry.payload_schema)]);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0]?.prompt ?? '', /REGISTRY_SELECTED_SYNTHESIS_PROMPT/u);
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
