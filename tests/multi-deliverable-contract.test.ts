import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { CurrentDeliverableService, type CurrentDeliverableGenerateInput } from '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
import {
  resolveDeliverable,
  resolveDeliverableContract,
} from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import { ResearchPlanningService } from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import {
  getConfigRoot,
  loadEvidencePolicy,
  loadReportTemplate,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import type { StructuredLLMCallOptions } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import type { EvidenceManifest, EvidenceService } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import { lintRegistries } from '../harness/linters/registry-linter.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { EvidenceRequirement } from '../packages/api-contract/research-deliverable.ts';

interface JsonSchema {
  type?: string;
  additionalProperties?: boolean;
  required?: unknown;
  properties?: Record<string, JsonSchema>;
}

interface RegistryEntryFixture {
  id?: unknown;
  status?: unknown;
  task_types?: unknown;
  aliases?: unknown;
  payload_schema?: unknown;
  synthesis_prompt?: unknown;
  review_rubric?: unknown;
  evidence_policy?: unknown;
  report_template?: unknown;
}

interface DeliverableContractFixture {
  taskType: ResearchTaskV2['task_type'];
  deliverableId: string;
  alias: string;
  schemaPath: string;
  promptPath: string;
  rubricPath: string;
  templateId: string;
  criticalArrays: readonly string[];
  payload: Record<string, unknown>;
}

const ROOT = getConfigRoot();
const REGISTRY_PATH = join(ROOT, 'orchestrator/deliverable-registry.yaml');

const RESEARCH_PLAN_PAYLOAD = {
  title: 'User interview research plan',
  researchGoal: 'Understand the onboarding barriers for first-time users',
  scope: {
    market: 'Current customers',
    subjects: ['First-time users'],
    timeWindow: 'Current quarter',
  },
  competitorSampling: {
    strategy: 'Not applicable; recruit verified first-time users',
    targetCount: 1,
    inclusionCriteria: ['Completed onboarding in the current quarter'],
    exclusionCriteria: ['Internal employees'],
  },
  researchQuestions: ['Which onboarding steps create avoidable friction?'],
  comparisonDimensions: [{
    id: 'onboarding-friction',
    name: 'Onboarding friction',
    purpose: 'Locate preventable barriers',
    collectionFields: ['step', 'barrier'],
  }],
  sourcePlan: [{
    evidenceClass: 'user_input',
    sourceTypes: ['moderated interview'],
    purpose: 'Collect first-hand experience',
  }],
  executionPlan: [{
    phase: 'Interviews',
    activities: ['Interview participants'],
    duration: 'One week',
    outputs: ['Interview notes'],
  }],
  collectionTemplate: [{
    field: 'barrier',
    description: 'Observed onboarding barrier',
    evidenceRequired: true,
  }],
  analysisMethods: ['Thematic analysis'],
  deliverables: ['Research plan'],
  qualityChecks: ['Every research question has a collection method'],
};

const CONTRACTS: readonly DeliverableContractFixture[] = [{
  taskType: 'user_research_planning',
  deliverableId: 'research_plan',
  alias: 'research plan',
  schemaPath: 'schemas/deliverables/research-plan.schema.json',
  promptPath: 'orchestrator/prompts/deliverables/research-plan.md',
  rubricPath: 'orchestrator/report-rubrics/research-plan.yaml',
  templateId: 'research-plan',
  criticalArrays: [
    'researchQuestions',
    'comparisonDimensions',
    'sourcePlan',
    'executionPlan',
    'collectionTemplate',
    'analysisMethods',
    'deliverables',
    'qualityChecks',
  ],
  payload: RESEARCH_PLAN_PAYLOAD,
}, {
  taskType: 'competitive_research',
  deliverableId: 'competitive_analysis_report',
  alias: 'competitive analysis report',
  schemaPath: 'schemas/deliverables/competitive-analysis-report.schema.json',
  promptPath: 'orchestrator/prompts/deliverables/competitive-analysis-report.md',
  rubricPath: 'orchestrator/report-rubrics/competitive-analysis-report.yaml',
  templateId: 'competitive-analysis-report',
  criticalArrays: [
    'competitorSamples',
    'dimensionMatrix',
    'differences',
    'impacts',
    'actionRecommendations',
    'screenshotComparisons',
  ],
  payload: {
    competitorSamples: [{
      id: 'sample-a',
      name: 'Product A',
      rationale: 'Primary market comparator',
      evidenceIds: ['E1'],
    }],
    dimensionMatrix: [{
      dimension: 'onboarding',
      values: [{ sampleId: 'sample-a', value: 'Guided setup', evidenceIds: ['E1'] }],
    }],
    differences: [{
      id: 'difference-1',
      dimension: 'onboarding',
      statement: 'Product A provides guided setup',
      evidenceIds: ['E1'],
    }],
    impacts: [{
      differenceId: 'difference-1',
      audience: 'First-time users',
      statement: 'Guidance reduces setup uncertainty',
    }],
    actionRecommendations: [{
      id: 'action-1',
      differenceIds: ['difference-1'],
      priority: 'P1',
      statement: 'Prototype a guided setup path',
    }],
    screenshotComparisons: [{
      id: 'screenshot-1',
      dimension: 'onboarding',
      sampleIds: ['sample-a'],
      assetIds: ['asset-screenshot-a'],
      caption: 'Guided setup entry point',
    }],
  },
}, {
  taskType: 'voc_diagnosis',
  deliverableId: 'voc_diagnosis_report',
  alias: 'voc diagnosis report',
  schemaPath: 'schemas/deliverables/voc-diagnosis-report.schema.json',
  promptPath: 'orchestrator/prompts/deliverables/voc-diagnosis-report.md',
  rubricPath: 'orchestrator/report-rubrics/voc-diagnosis-report.yaml',
  templateId: 'voc-diagnosis-report',
  criticalArrays: [
    'datasets',
    'themes',
    'frequencies',
    'sentiments',
    'representativeQuotes',
    'severities',
    'priorities',
  ],
  payload: {
    datasets: [{ id: 'dataset-1', name: 'Support feedback', source: 'ticket export', recordCount: 120 }],
    themes: [{ id: 'theme-1', label: 'Slow setup', datasetIds: ['dataset-1'], evidenceIds: ['E1'] }],
    frequencies: [{ themeId: 'theme-1', count: 38, share: 0.3167 }],
    sentiments: [{ themeId: 'theme-1', label: 'negative', score: -0.7 }],
    representativeQuotes: [{ themeId: 'theme-1', quote: 'Setup takes too long', evidenceId: 'E1' }],
    severities: [{ themeId: 'theme-1', level: 'high', rationale: 'Blocks activation' }],
    priorities: [{ themeId: 'theme-1', level: 'P1', rationale: 'High frequency and severity' }],
  },
}, {
  taskType: 'design_audit',
  deliverableId: 'design_audit_report',
  alias: 'design audit report',
  schemaPath: 'schemas/deliverables/design-audit-report.schema.json',
  promptPath: 'orchestrator/prompts/deliverables/design-audit-report.md',
  rubricPath: 'orchestrator/report-rubrics/design-audit-report.yaml',
  templateId: 'design-audit-report',
  criticalArrays: [
    'pages',
    'issues',
    'principles',
    'severities',
    'annotatedScreenshots',
    'remediations',
    'retests',
  ],
  payload: {
    pages: [{ id: 'page-1', name: 'Checkout', state: 'default' }],
    issues: [{ id: 'issue-1', pageId: 'page-1', statement: 'Primary action lacks visual hierarchy' }],
    principles: [{ issueId: 'issue-1', principle: 'clear visual hierarchy', rationale: 'Users need one primary action' }],
    severities: [{ issueId: 'issue-1', level: 'major', rationale: 'May delay task completion' }],
    annotatedScreenshots: [{ issueId: 'issue-1', assetId: 'asset-checkout-annotation', annotation: 'Competing actions' }],
    remediations: [{ issueId: 'issue-1', action: 'Establish one primary action', acceptanceCriteria: ['Primary action is visually dominant'] }],
    retests: [{ issueId: 'issue-1', method: 'Expert review', expectedResult: 'Primary action is found first' }],
  },
}, {
  taskType: 'a11y_audit',
  deliverableId: 'accessibility_audit_report',
  alias: 'accessibility audit report',
  schemaPath: 'schemas/deliverables/accessibility-audit-report.schema.json',
  promptPath: 'orchestrator/prompts/deliverables/accessibility-audit-report.md',
  rubricPath: 'orchestrator/report-rubrics/accessibility-audit-report.yaml',
  templateId: 'accessibility-audit-report',
  criticalArrays: [
    'platforms',
    'pourPrinciples',
    'components',
    'conformanceLevels',
    'priorities',
    'screenReaderBehavior',
    'remediations',
    'verification',
  ],
  payload: {
    platforms: [{ name: 'Web', assistiveTechnology: 'VoiceOver', browser: 'Safari' }],
    pourPrinciples: [{ issueId: 'issue-1', principle: 'Operable', rationale: 'Control is not keyboard reachable' }],
    components: [{ issueId: 'issue-1', component: 'Checkout button', selector: '#checkout' }],
    conformanceLevels: [
      { issueId: 'issue-1', level: 'A', criterion: '2.1.1 Keyboard' },
      { issueId: 'issue-2', level: 'B', criterion: 'Professional audit classification B' },
      { issueId: 'issue-3', level: 'C', criterion: 'Professional audit classification C' },
    ],
    priorities: [
      { issueId: 'issue-1', level: 'P0', rationale: 'Blocks keyboard users' },
      { issueId: 'issue-2', level: 'P1', rationale: 'Major assistive-technology barrier' },
      { issueId: 'issue-3', level: 'P2', rationale: 'Material usability degradation' },
      { issueId: 'issue-4', level: 'P3', rationale: 'Minor accessibility improvement' },
    ],
    screenReaderBehavior: [{ issueId: 'issue-1', observed: 'Button purpose is not announced', expected: 'Name and role are announced' }],
    remediations: [{ issueId: 'issue-1', action: 'Use a native button with an accessible name' }],
    verification: [{ issueId: 'issue-1', method: 'Keyboard and VoiceOver retest', expectedResult: 'Control is reachable and announced' }],
  },
}];

const PROFESSIONAL_CONTRACTS = CONTRACTS.filter(
  (contract) => contract.deliverableId !== 'research_plan',
);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function productionRegistryEntries(): RegistryEntryFixture[] {
  const registry = asRecord(parseYaml(readFileSync(REGISTRY_PATH, 'utf8')), 'Deliverable Registry');
  assert.equal(registry.version, 2);
  assert.ok(Array.isArray(registry.deliverables), 'Deliverable Registry deliverables must be an array');
  return registry.deliverables as RegistryEntryFixture[];
}

function requirementFor(contract: DeliverableContractFixture): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: contract.taskType,
    business_domain: 'product',
    research_goal: `Produce ${contract.alias}`,
    target_audience: ['Product team'],
    scope: ['Verified evidence'],
    constraints: [],
    success_criteria: [{ id: 'SC1', statement: 'The result is evidence-backed and actionable' }],
    expected_deliverables: [contract.alias],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
}

function expectedEvidenceRequirements(contract: DeliverableContractFixture): EvidenceRequirement[] {
  const policy = loadEvidencePolicy().policies.find((candidate) => (
    candidate.task_type === contract.taskType
    && candidate.deliverable_type === contract.deliverableId
  ));
  assert.ok(policy, `Evidence Policy must map ${contract.taskType} to ${contract.deliverableId}`);
  return policy.requirements.map((requirement) => ({
    id: requirement.id,
    acceptedClasses: [...requirement.accepted_classes],
    minimumCount: requirement.minimum_count,
    required: requirement.required,
  }));
}

for (const contract of CONTRACTS) {
  test(`${contract.taskType} has one active Registry mapping with an explicit accepted alias`, () => {
    const activeMappings = productionRegistryEntries().filter((entry) => (
      entry.status === 'active'
      && Array.isArray(entry.task_types)
      && entry.task_types.includes(contract.taskType)
    ));

    assert.equal(activeMappings.length, 1, `${contract.taskType} must have exactly one active mapping`);
    const entry = activeMappings[0]!;
    assert.equal(entry.id, contract.deliverableId);
    assert.deepEqual(entry.task_types, [contract.taskType]);
    assert.ok(Array.isArray(entry.aliases), `${contract.deliverableId} aliases must be explicit`);
    assert.ok(entry.aliases.includes(contract.alias), `${contract.alias} must be an explicit alias`);
    assert.equal(entry.payload_schema, contract.schemaPath);
    assert.equal(entry.synthesis_prompt, contract.promptPath);
    assert.equal(entry.review_rubric, contract.rubricPath);
    assert.equal(entry.report_template, contract.templateId);

    assert.equal(
      resolveDeliverable(contract.taskType, [contract.alias]).id,
      contract.deliverableId,
    );
    assert.equal(
      resolveDeliverable(contract.taskType, [contract.deliverableId]).id,
      contract.deliverableId,
    );
  });

  test(`${contract.deliverableId} resources load and its payload fixture satisfies a closed schema`, () => {
    const schemaPath = join(ROOT, contract.schemaPath);
    const promptPath = join(ROOT, contract.promptPath);
    const rubricPath = join(ROOT, contract.rubricPath);
    assert.equal(existsSync(schemaPath), true, `${contract.schemaPath} must exist`);
    assert.equal(existsSync(promptPath), true, `${contract.promptPath} must exist`);
    assert.equal(existsSync(rubricPath), true, `${contract.rubricPath} must exist`);

    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${contract.deliverableId} root must reject undeclared fields`);
    assert.ok(Array.isArray(schema.required), `${contract.deliverableId} required must be an array`);
    assert.ok(schema.properties, `${contract.deliverableId} properties must be declared`);
    for (const dimension of contract.criticalArrays) {
      assert.ok(schema.required.includes(dimension), `${dimension} must be required`);
      const property: JsonSchema | undefined = schema.properties[dimension];
      assert.ok(property, `${dimension} must have a schema`);
      assert.equal(property.type, 'array', `${dimension} must be an array`);
      assert.equal((property as { minItems?: unknown }).minItems, 1, `${dimension} must be non-empty`);
    }

    const validator = new SchemaValidator();
    assert.doesNotThrow(() => validator.validateFileOrThrow(schemaPath, contract.payload));
    assert.ok(
      validator.validateFile(schemaPath, { ...contract.payload, unexpected: true }).length > 0,
      `${contract.deliverableId} must reject an undeclared root property`,
    );
    for (const dimension of contract.criticalArrays) {
      assert.ok(
        validator.validateFile(schemaPath, { ...contract.payload, [dimension]: [] }).length > 0,
        `${contract.deliverableId} must reject an empty ${dimension}`,
      );
    }

    assert.match(readFileSync(promptPath, 'utf8'), /\S/u, `${contract.deliverableId} prompt must be non-empty`);
    const rubric = asRecord(parseYaml(readFileSync(rubricPath, 'utf8')), `${contract.deliverableId} rubric`);
    assert.equal(rubric.version, 1);
    assert.ok(Array.isArray(rubric.dimensions) && rubric.dimensions.length > 0);
    assert.equal(loadReportTemplate(contract.templateId).id, contract.templateId);
    assert.ok(expectedEvidenceRequirements(contract).length > 0);
  });

  test(`${contract.taskType} resolves a complete contract through the production loader`, () => {
    const resolved = resolveDeliverableContract(contract.taskType, [contract.alias]);
    assert.equal(resolved.entry.id, contract.deliverableId);
    assert.equal(resolved.entry.status, 'active');
    assert.equal(resolved.entry.payload_schema, contract.schemaPath);
    assert.equal(resolved.entry.synthesis_prompt, contract.promptPath);
    assert.equal(resolved.entry.review_rubric, contract.rubricPath);
    assert.equal(resolved.entry.report_template, contract.templateId);
    assert.match(resolved.synthesisPrompt, /\S/u);
    assert.equal(resolved.reportTemplate.id, contract.templateId);
    assert.ok(resolved.evidencePolicy.requirements.length > 0);
    assert.ok(
      resolved.evidencePolicy.requirements.some(
        (requirement) => requirement.id === resolved.entry.evidence_policy,
      ),
      'Registry evidence_policy must select an exact requirement in the task policy',
    );
  });

  test(`${contract.taskType} planning passes the exact Registry Evidence Policy to the routed planner`, async () => {
    const expectedEvidence = expectedEvidenceRequirements(contract);
    let plannedEvidence: EvidenceRequirement[] | undefined;
    const planning = new ResearchPlanningService({
      llm: { identity: { requestedModel: 'fixture-model' } },
    } as never);
    Reflect.set(planning, 'routedPlanner', {
      async planCurrent(_context: unknown, evidenceRequirements: EvidenceRequirement[]) {
        plannedEvidence = structuredClone(evidenceRequirements);
        return {
          activated: [],
          decisionStates: [],
          candidates: [],
          guidanceSources: [],
          planProvenance: {
            modelName: 'fixture-model',
            modelVersion: 'fixture-v1',
            promptHash: 'sha256:fixture',
            traceId: 'trace-fixture',
          },
          problemGraph: { version: 'problem-graph-v1', questions: [] },
          problemGraphProvenance: {
            receiptId: '11111111-1111-4111-8111-111111111111',
            modelName: 'fixture-model',
            modelVersion: 'fixture-v1',
            promptHash: 'sha256:fixture',
            traceId: 'trace-fixture',
          },
          capabilityResolution: { eligible: [], rejected: [] },
        };
      },
    });

    await planning.planCurrentFromRequirement(requirementFor(contract));

    assert.deepEqual(plannedEvidence, expectedEvidence);
  });
}

test('Registry linter accepts the complete five-task deliverable contract set', () => {
  assert.deepEqual(lintRegistries(), []);
});

class ContractGenerationLLM {
  readonly calls: StructuredLLMCallOptions[] = [];

  constructor(private readonly payload: Record<string, unknown>) {}

  async generateStructured<T>(input: StructuredLLMCallOptions): Promise<{ data: T }> {
    this.calls.push(input);
    return {
      data: {
        methodSummary: 'Synthesized with the task-specific professional contract',
        findingGraph: {
          findings: [{ id: 'F1', kind: 'fact', evidenceIds: ['E1'], statement: 'Verified fact' }],
          analyses: [{ id: 'A1', findingIds: ['F1'], statement: 'Task-specific analysis' }],
          subQuestionSummaries: [{ id: 'S1', findingIds: ['F1'], analysisIds: ['A1'], summary: 'Answer' }],
          overallConclusions: [{ id: 'C1', summaryIds: ['S1'], statement: 'Conclusion' }],
        },
        payload: structuredClone(this.payload),
        recommendations: [{ id: 'R1', summaryIds: ['S1'], statement: 'Act on the verified finding' }],
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

function generationInput(contract: DeliverableContractFixture): CurrentDeliverableGenerateInput {
  const manifest: EvidenceManifest = {
    version: 'evidence-v1',
    taskId: `task-${contract.taskType}`,
    planVersionId: `plan-${contract.taskType}`,
    attemptId: `attempt-${contract.taskType}`,
    collectedAt: '2026-08-17T00:00:00.000Z',
    manifestHash: `sha256:${'a'.repeat(64)}`,
    entries: [],
  };
  return {
    task: { id: manifest.taskId },
    plan: {
      id: manifest.planVersionId,
      plan: { deliverable_type: contract.deliverableId },
    },
    attempt: { id: manifest.attemptId },
    researchGoal: `Generate ${contract.alias}`,
    finalizedRequirement: requirementFor(contract),
    problemGraph: { questions: [{ id: 'Q1', priority: 'required' }] },
    evidenceManifest: {
      artifact: {
        id: `artifact-manifest-${contract.taskType}`,
        contentSha256: manifest.manifestHash,
        state: 'SEALED',
      },
      value: manifest,
    },
    evidenceResolver: { resolveArtifact: () => null },
    outputs: [],
    gaps: [],
    expectedModel: 'fixture-model',
  };
}

for (const contract of PROFESSIONAL_CONTRACTS) {
  test(`CurrentDeliverable generates and validates ${contract.deliverableId} through the generic pipeline`, async () => {
    const llm = new ContractGenerationLLM(contract.payload);
    const evidence = {
      validateManifest(): void {},
      resolveEvidenceValue(): unknown { return null; },
      validateFindingGraph(): void {},
    } as unknown as EvidenceService;
    const service = new CurrentDeliverableService({
      llm,
      validator: new SchemaValidator(),
      evidence,
      artifacts: {
        async writeJson(): Promise<{ id: string }> {
          return { id: `artifact-${contract.deliverableId}` };
        },
      },
    });

    const result = await service.generate(generationInput(contract));

    assert.equal(result.deliverable.deliverableType, contract.deliverableId);
    assert.deepEqual(result.deliverable.payload, contract.payload);
    assert.equal(result.deliverableArtifactId, `artifact-${contract.deliverableId}`);
    assert.equal(llm.calls.length, 1);
    assert.equal(
      llm.calls[0]?.schemaName,
      `${contract.deliverableId.replace(/_/gu, '-')}-deliverable-content`,
    );
    assert.match(llm.calls[0]?.prompt ?? '', /\S/u);
  });
}
