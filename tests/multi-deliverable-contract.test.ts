import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { EvidenceService, type EvidenceManifest } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type { VerifiedVisualAsset } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
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
  emptyAllowedArrays?: readonly string[];
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
  emptyAllowedArrays: ['screenshotComparisons'],
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
      assetIds: ['asset-screenshot-original', 'asset-screenshot-a'],
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
      const emptyAllowed = contract.emptyAllowedArrays?.includes(dimension) ?? false;
      assert.ok(schema.required.includes(dimension), `${dimension} must be required`);
      const property: JsonSchema | undefined = schema.properties[dimension];
      assert.ok(property, `${dimension} must have a schema`);
      assert.equal(property.type, 'array', `${dimension} must be an array`);
      assert.equal(
        (property as { minItems?: unknown }).minItems,
        emptyAllowed ? undefined : 1,
        emptyAllowed ? `${dimension} may be empty` : `${dimension} must be non-empty`,
      );
    }

    const validator = new SchemaValidator();
    assert.doesNotThrow(() => validator.validateFileOrThrow(schemaPath, contract.payload));
    assert.ok(
      validator.validateFile(schemaPath, { ...contract.payload, unexpected: true }).length > 0,
      `${contract.deliverableId} must reject an undeclared root property`,
    );
    for (const dimension of contract.criticalArrays) {
      const emptyAllowed = contract.emptyAllowedArrays?.includes(dimension) ?? false;
      assert.equal(
        validator.validateFile(schemaPath, { ...contract.payload, [dimension]: [] }).length === 0,
        emptyAllowed,
        `${contract.deliverableId} empty ${dimension} contract drifted`,
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

test('competitive synthesis and review contracts permit an evidence-backed report without visual inputs', () => {
  const contract = CONTRACTS.find(({ deliverableId }) => deliverableId === 'competitive_analysis_report');
  assert.ok(contract);
  const prompt = readFileSync(join(ROOT, contract.promptPath), 'utf8');
  assert.match(prompt, /without verified visual assets.*empty screenshotComparisons/iu);
  assert.match(prompt, /exactly two unique assetIds.*original.*annotation.*exact original/iu);
  assert.match(prompt, /input-provenance boundary.*does not locate, prove, or substantiate.*research finding/iu);

  const rubric = asRecord(
    parseYaml(readFileSync(join(ROOT, contract.rubricPath), 'utf8')),
    'competitive review rubric',
  );
  assert.ok(Array.isArray(rubric.dimensions));
  const visualQuality = rubric.dimensions
    .map((dimension) => asRecord(dimension, 'competitive review dimension'))
    .find((dimension) => dimension.id === 'visual_quality');
  assert.ok(visualQuality);
  assert.match(String(visualQuality.criterion), /without verified visual assets.*empty screenshotComparisons/iu);
  assert.match(String(visualQuality.criterion), /exactly two unique Asset ids.*original-to-annotation.*exact lineage/iu);
  assert.match(String(visualQuality.criterion), /input-provenance boundary.*does not locate or substantiate.*research finding/iu);

  const schemaPath = join(ROOT, contract.schemaPath);
  const validator = new SchemaValidator();
  for (const assetIds of [
    ['asset-original'],
    ['asset-original', 'asset-original'],
    ['asset-original', 'asset-annotation', 'asset-extra'],
  ]) {
    const payload = structuredClone(contract.payload);
    const comparison = (payload.screenshotComparisons as Array<Record<string, unknown>>)[0];
    assert.ok(comparison);
    comparison.assetIds = assetIds;
    assert.ok(
      validator.validateFile(schemaPath, payload).length > 0,
      `competitive assetIds must reject ${JSON.stringify(assetIds)}`,
    );
  }
});

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
    let writes = 0;
    const service = generationServiceFor(contract, llm, () => { writes += 1; });
    const visualAssets = contract.deliverableId === 'competitive_analysis_report'
      ? verifiedVisualPair(contract, 'asset-screenshot-original', 'asset-screenshot-a')
      : contract.deliverableId === 'design_audit_report'
        ? verifiedVisualPair(contract, 'asset-checkout-original', 'asset-checkout-annotation')
        : [];

    const result = await service.generate(Object.assign(generationInput(contract), { visualAssets }));

    assert.equal(result.deliverable.deliverableType, contract.deliverableId);
    assert.deepEqual(result.deliverable.payload, contract.payload);
    assert.equal(result.deliverableArtifactId, `artifact-${contract.deliverableId}-phase6`);
    assert.equal(writes, 1);
    assert.equal(llm.calls.length, 1);
    assert.equal(
      llm.calls[0]?.schemaName,
      `${contract.deliverableId.replace(/_/gu, '-')}-deliverable-content`,
    );
    assert.match(llm.calls[0]?.prompt ?? '', /\S/u);
  });
}

const LOCALIZED_DELIVERABLES: Record<ResearchTaskV2['task_type'], string> = {
  user_research_planning: '用户研究计划',
  competitive_research: '竞品分析报告',
  voc_diagnosis: '用户之声诊断报告',
  design_audit: '设计走查报告',
  a11y_audit: '无障碍审计报告',
};

function routedPlanningResult() {
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
}

for (const contract of CONTRACTS) {
  test(`planning canonicalizes localized ${contract.taskType} expected_deliverables before Registry resolution`, async () => {
    const localized = LOCALIZED_DELIVERABLES[contract.taskType];
    let plannedExpectedDeliverables: string[] | undefined;
    const planning = new ResearchPlanningService({
      llm: { identity: { requestedModel: 'fixture-model' } },
    } as never);
    Reflect.set(planning, 'routedPlanner', {
      async planCurrent(context: { requirement: ResearchTaskV2 }) {
        plannedExpectedDeliverables = [...context.requirement.expected_deliverables];
        return routedPlanningResult();
      },
    });

    const result = await planning.planCurrentFromRequirement({
      ...requirementFor(contract),
      expected_deliverables: [localized],
    });

    assert.deepEqual(result.structuredTask.expected_deliverables, [contract.deliverableId]);
    assert.deepEqual(plannedExpectedDeliverables, [contract.deliverableId]);
  });
}

function collectorManifest(taskType: string, deliverableId: string): EvidenceManifest {
  const artifactId = `artifact-collector-${taskType}-${deliverableId}`;
  const artifactContentSha256 = `sha256:${'b'.repeat(64)}`;
  const sourceUrl = 'https://source.test/phase-6';
  const output = { results: [{ title: 'Verified source', url: sourceUrl }] };
  const redactedOutputHash = `sha256:${createHash('sha256').update(JSON.stringify(output)).digest('hex')}`;
  const resolver = {
    resolveArtifact(candidateId: string) {
      return candidateId === artifactId
        ? {
            artifact: { id: artifactId, contentSha256: artifactContentSha256 },
            value: { output, redactedOutputHash },
          }
        : null;
    },
  };
  return new EvidenceService().createManifest({
    taskId: `task-${taskType}`,
    planVersionId: `plan-${taskType}-${deliverableId}`,
    attemptId: `attempt-${taskType}-${deliverableId}`,
    collectedAt: '2026-08-17T00:00:00.000Z',
    entries: [{
      id: 'E1-1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      toolId: 'tavily-web-search',
      toolTier: 'core',
      artifactId,
      artifactContentSha256,
      jsonPointer: '/output/results/0',
      sourceUrl,
      stepNo: 1,
      toolProof: { implementationId: 'tavily', executionMode: 'real', redactedOutputHash },
      sensitivity: 'public',
      redaction: 'masked',
    }],
  }, resolver);
}

for (const policy of loadEvidencePolicy().policies) {
  test(`${policy.task_type}/${policy.deliverable_type} required Evidence Policy is achievable by a production collector Manifest`, () => {
    const manifest = collectorManifest(policy.task_type, policy.deliverable_type);
    const requiredRequirements = policy.requirements.filter(({ required }) => required);
    assert.ok(requiredRequirements.length > 0, `${policy.task_type}/${policy.deliverable_type} must require Evidence`);
    for (const requirement of requiredRequirements) {
      const actual = manifest.entries.filter((entry) => (
        entry.toolTier === 'core' && requirement.accepted_classes.includes(entry.evidenceClass)
      )).length;
      assert.ok(
        actual >= requirement.minimum_count,
        `${requirement.id} requires ${requirement.accepted_classes.join('|')} but the collector Manifest contains ${manifest.entries.map(({ evidenceClass }) => evidenceClass).join('|')}`,
      );
    }
  });
}

function canonicalFixtureHash(value: unknown): string {
  const canonicalize = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(canonicalize);
    if (child === null || typeof child !== 'object') return child;
    return Object.fromEntries(
      Object.entries(child as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function verifiedInventoryAsset(
  contract: DeliverableContractFixture,
  assetId: string,
  bindingOverrides: Partial<{ taskId: string; planVersionId: string; attemptId: string }> = {},
): VerifiedVisualAsset {
  const binding = {
    taskId: `task-${contract.taskType}`,
    planVersionId: `plan-${contract.taskType}`,
    attemptId: `attempt-${contract.taskType}`,
    ...bindingOverrides,
  };
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const contentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const manifestDraft = {
    version: 'visual-asset-manifest-v1' as const,
    ...binding,
    assetId,
    contentSha256,
    mediaType: 'image/png' as const,
    byteSize: bytes.byteLength,
    width: 1,
    height: 1,
    exportPolicy: 'allow' as const,
    source: { kind: 'user_upload' as const, fileName: `${assetId}.png` },
    derivedFrom: null,
    derivation: null,
  };
  const manifest = { ...manifestDraft, manifestHash: canonicalFixtureHash(manifestDraft) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  return {
    artifact: {
      id: assetId,
      ...binding,
      kind: 'visual_asset',
      state: 'SEALED',
      storageUri: `/private/${assetId}`,
      contentSha256,
      byteSize: bytes.byteLength,
      schemaVersion: 'binary-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
      mediaType: 'image/png',
      metadata: { width: 1, height: 1 },
    },
    bytes,
    metadata: { contentType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1 },
    manifest,
    manifestArtifact: {
      id: `manifest-${assetId}`,
      ...binding,
      kind: 'visual_asset_manifest',
      state: 'SEALED',
      storageUri: `/private/manifest-${assetId}`,
      contentSha256: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
      byteSize: manifestBytes.byteLength,
      schemaVersion: 'visual-asset-manifest-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
    },
  } as VerifiedVisualAsset;
}
function verifiedAnnotationAsset(
  contract: DeliverableContractFixture,
  assetId: string,
  original: VerifiedVisualAsset,
): VerifiedVisualAsset {
  const base = verifiedInventoryAsset(contract, assetId, {
    taskId: original.artifact.taskId,
    planVersionId: original.artifact.planVersionId ?? undefined,
    attemptId: original.artifact.attemptId ?? undefined,
  });
  const manifestDraft = {
    ...base.manifest,
    source: { kind: 'derived' as const },
    derivedFrom: {
      assetId: original.artifact.id,
      manifestArtifactId: original.manifestArtifact.id,
      contentSha256: original.manifest.contentSha256,
      manifestHash: original.manifest.manifestHash,
    },
    derivation: { kind: 'annotation' as const, overlayArtifactId: `overlay-${assetId}` },
  };
  const { manifestHash: _manifestHash, ...manifestWithoutHash } = manifestDraft;
  const manifest = { ...manifestDraft, manifestHash: canonicalFixtureHash(manifestWithoutHash) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  return {
    ...base,
    manifest,
    manifestArtifact: {
      ...base.manifestArtifact,
      contentSha256: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
      byteSize: manifestBytes.byteLength,
    },
  } as VerifiedVisualAsset;
}

function verifiedVisualPair(
  contract: DeliverableContractFixture,
  originalAssetId: string,
  annotationAssetId: string,
  bindingOverrides: Partial<{ taskId: string; planVersionId: string; attemptId: string }> = {},
): VerifiedVisualAsset[] {
  const original = verifiedInventoryAsset(contract, originalAssetId, bindingOverrides);
  return [original, verifiedAnnotationAsset(contract, annotationAssetId, original)];
}


const VISUAL_PAYLOAD_CASES = [{
  deliverableId: 'competitive_analysis_report',
  originalAssetId: 'asset-screenshot-original',
  assetId: 'asset-screenshot-a',
  field: 'screenshotComparisons',
}, {
  deliverableId: 'design_audit_report',
  originalAssetId: 'asset-checkout-original',
  assetId: 'asset-checkout-annotation',
  field: 'annotatedScreenshots',
}] as const;
for (const visualCase of VISUAL_PAYLOAD_CASES) {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === visualCase.deliverableId)!;

  test(`${visualCase.field} rejects an Asset id absent from the supplied verified visual inventory`, async () => {
    const llm = new ContractGenerationLLM(contract.payload);
    let writes = 0;
    const service = new CurrentDeliverableService({
      llm,
      validator: new SchemaValidator(),
      evidence: {
        validateManifest(): void {},
        resolveEvidenceValue(): unknown { return null; },
        validateFindingGraph(): void {},
      } as unknown as EvidenceService,
      artifacts: { async writeJson() { writes += 1; return { id: 'must-not-write' }; } },
    });
    const input = Object.assign(generationInput(contract), {
      visualAssets: verifiedVisualPair(contract, 'asset-unrelated-original', 'asset-unrelated-annotation'),
    });

    await assert.rejects(() => service.generate(input), /lineage|verified visual|asset.*inventory|unverified asset/i);
    assert.equal(writes, 0);
    assert.equal(llm.calls.length, 3, 'invalid payload Asset ids exhaust bounded synthesis repair');
    assert.match(JSON.stringify(llm.calls[1]?.context), /validationFeedback/i);
  });

  test(`${visualCase.field} accepts only the exact same Task/Plan/Attempt Asset and exposes only verified ids to synthesis`, async () => {
    const llm = new ContractGenerationLLM(contract.payload);
    const service = new CurrentDeliverableService({
      llm,
      validator: new SchemaValidator(),
      evidence: {
        validateManifest(): void {},
        resolveEvidenceValue(): unknown { return null; },
        validateFindingGraph(): void {},
      } as unknown as EvidenceService,
      artifacts: { async writeJson() { return { id: `artifact-${contract.deliverableId}` }; } },
    });
    const input = Object.assign(generationInput(contract), {
      visualAssets: verifiedVisualPair(contract, visualCase.originalAssetId, visualCase.assetId),
    });

    await service.generate(input);

    const context = llm.calls[0]?.context as { verifiedVisualAssetIds?: string[] };
    assert.deepEqual(
      context.verifiedVisualAssetIds,
      [visualCase.assetId, visualCase.originalAssetId].sort((left, right) => left.localeCompare(right)),
    );
    assert.match(llm.calls[0]?.prompt ?? '', /verified visual.*asset|asset.*verified inventory/i);
  });

  for (const mismatch of [{
    name: 'Task',
    override: { taskId: 'task-foreign' },
  }, {
    name: 'Plan',
    override: { planVersionId: 'plan-foreign' },
  }, {
    name: 'Attempt',
    override: { attemptId: 'attempt-foreign' },
  }] as const) {
    test(`${visualCase.field} rejects the right Asset id when its ${mismatch.name} binding is foreign`, async () => {
      const llm = new ContractGenerationLLM(contract.payload);
      const service = new CurrentDeliverableService({
        llm,
        validator: new SchemaValidator(),
        evidence: {
          validateManifest(): void {},
          resolveEvidenceValue(): unknown { return null; },
          validateFindingGraph(): void {},
        } as unknown as EvidenceService,
        artifacts: { async writeJson() { return { id: 'must-not-write' }; } },
      });
      const input = Object.assign(generationInput(contract), {
        visualAssets: verifiedVisualPair(
          contract,
          visualCase.originalAssetId,
          visualCase.assetId,
          mismatch.override,
        ),
      });

      await assert.rejects(() => service.generate(input), /visual asset.*(task|plan|attempt)|binding|foreign/i);
      assert.equal(llm.calls.length, 0);
    });
  }
}
test('persisted competitive research_plan execution keeps the declared research_plan Evidence Policy', async () => {
  const contract = CONTRACTS.find(({ deliverableId }) => deliverableId === 'research_plan');
  assert.ok(contract);
  const llm = new ContractGenerationLLM(contract.payload);
  const input = generationInput(contract);
  input.finalizedRequirement = {
    ...requirementFor(contract),
    task_type: 'competitive_research',
    expected_deliverables: ['research_plan'],
  };
  const service = new CurrentDeliverableService({
    llm,
    validator: new SchemaValidator(),
    evidence: {
      validateManifest(): void {},
      resolveEvidenceValue(): unknown { return null; },
      validateFindingGraph(): void {},
    } as unknown as EvidenceService,
    artifacts: { async writeJson() { return { id: 'artifact-persisted-research-plan' }; } },
  });

  const result = await service.generate(input);

  assert.equal(result.deliverable.deliverableType, 'research_plan');
  const context = asRecord(llm.calls[0]?.context, 'synthesis context');
  const selectedContract = asRecord(context.deliverableContract, 'selected deliverable contract');
  const policy = asRecord(selectedContract.evidencePolicy, 'selected Evidence Policy');
  assert.equal(policy.deliverable_type, 'research_plan');
  const requirements = policy.requirements;
  assert.ok(Array.isArray(requirements));
  assert.equal(asRecord(requirements[0], 'research-plan requirement').id, 'public-market-evidence');
});

test('new competitive research planning still resolves competitive_analysis_report', () => {
  const resolved = resolveDeliverable('competitive_research', ['competitive analysis report']);
  assert.equal(resolved.id, 'competitive_analysis_report');
  const policy = loadEvidencePolicy().policies.find((candidate) => (
    candidate.task_type === 'competitive_research'
    && candidate.deliverable_type === resolved.id
  ));
  assert.ok(policy);
  assert.equal(policy.deliverable_type, 'competitive_analysis_report');
  assert.deepEqual(policy.requirements[0]?.accepted_classes, ['public_source', 'screenshot']);
});

function generationServiceFor(
  contract: DeliverableContractFixture,
  llm: ContractGenerationLLM,
  onWrite: () => void,
): CurrentDeliverableService {
  return new CurrentDeliverableService({
    llm,
    validator: new SchemaValidator(),
    evidence: {
      validateManifest(): void {},
      resolveEvidenceValue(): unknown { return null; },
      validateFindingGraph(): void {},
    } as unknown as EvidenceService,
    artifacts: {
      async writeJson() {
        onWrite();
        return { id: `artifact-${contract.deliverableId}-phase6` };
      },
    },
  });
}

function rehashVisualManifest(asset: VerifiedVisualAsset): VerifiedVisualAsset {
  const { manifestHash: _manifestHash, ...draft } = asset.manifest;
  asset.manifest = { ...asset.manifest, manifestHash: canonicalFixtureHash(draft) };
  const manifestBytes = Buffer.from(JSON.stringify(asset.manifest, null, 2));
  asset.manifestArtifact.contentSha256 = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  asset.manifestArtifact.byteSize = manifestBytes.byteLength;
  return asset;
}


function verifiedRawSourceAsset(
  contract: DeliverableContractFixture,
  assetId: string,
): VerifiedVisualAsset {
  const raw = verifiedInventoryAsset(contract, assetId);
  raw.manifest.source = {
    kind: 'tool_artifact',
    artifactId: 'raw-source-artifact',
    artifactContentSha256: `sha256:${'c'.repeat(64)}`,
    jsonPointer: '/output/results/0',
    url: 'https://source.test/raw-screenshot',
  };
  return rehashVisualManifest(raw);
}

test('competitive generation permits an empty screenshot section when no visual inventory exists', async () => {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === 'competitive_analysis_report');
  assert.ok(contract);
  const payload = structuredClone(contract.payload);
  payload.screenshotComparisons = [];
  const llm = new ContractGenerationLLM(payload);
  let writes = 0;
  const service = generationServiceFor(contract, llm, () => { writes += 1; });

  const result = await service.generate(Object.assign(generationInput(contract), { visualAssets: [] }));

  assert.deepEqual(
    (result.deliverable.payload as Record<string, unknown>).screenshotComparisons,
    [],
  );
  assert.equal(llm.calls.length, 1);
  assert.equal(writes, 1);
});

test('competitive generation rejects screenshot references when no visual inventory exists', async () => {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === 'competitive_analysis_report');
  assert.ok(contract);
  const llm = new ContractGenerationLLM(contract.payload);
  let writes = 0;
  const service = generationServiceFor(contract, llm, () => { writes += 1; });

  await assert.rejects(
    () => service.generate(Object.assign(generationInput(contract), { visualAssets: [] })),
    /visual.*(?:required|inventory)|screenshot.*(?:required|inventory)/iu,
  );
  assert.equal(writes, 0);
});

test('competitive screenshot comparisons require an original and its annotation lineage pair', async () => {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === 'competitive_analysis_report');
  assert.ok(contract);
  const original = verifiedInventoryAsset(contract, 'asset-competitive-original');
  const annotation = verifiedAnnotationAsset(contract, 'asset-competitive-annotation', original);
  const invalidCases = [
    { label: 'original only', assetIds: [original.artifact.id], assets: [original] },
    { label: 'annotation only', assetIds: [annotation.artifact.id], assets: [annotation] },
  ];

  for (const invalid of invalidCases) {
    const payload = structuredClone(contract.payload);
    const comparison = (payload.screenshotComparisons as Array<Record<string, unknown>>)[0];
    assert.ok(comparison);
    comparison.assetIds = invalid.assetIds;
    const llm = new ContractGenerationLLM(payload);
    let writes = 0;
    const service = generationServiceFor(contract, llm, () => { writes += 1; });
    await assert.rejects(
      () => service.generate(Object.assign(generationInput(contract), {
        visualAssets: invalid.assets,
      })),
      /original|annotation|lineage|pair|screenshot/i,
      invalid.label,
    );
    assert.equal(writes, 0, invalid.label);
  }
});

test('competitive screenshot comparisons accept the exact original-to-annotation pair', async () => {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === 'competitive_analysis_report');
  assert.ok(contract);
  const original = verifiedInventoryAsset(contract, 'asset-competitive-original-accepted');
  const annotation = verifiedAnnotationAsset(contract, 'asset-competitive-annotation-accepted', original);
  const payload = structuredClone(contract.payload);
  const comparison = (payload.screenshotComparisons as Array<Record<string, unknown>>)[0];
  assert.ok(comparison);
  comparison.assetIds = [original.artifact.id, annotation.artifact.id];
  const llm = new ContractGenerationLLM(payload);
  let writes = 0;
  const service = generationServiceFor(contract, llm, () => { writes += 1; });

  await service.generate(Object.assign(generationInput(contract), {
    visualAssets: [original, annotation],
  }));

  assert.equal(llm.calls.length, 1);
  assert.equal(writes, 1);
});

test('design annotatedScreenshots require an annotation whose derivedFrom is the exact original', async () => {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === 'design_audit_report');
  assert.ok(contract);
  const original = verifiedInventoryAsset(contract, 'asset-design-original');
  const annotation = verifiedAnnotationAsset(contract, 'asset-design-annotation', original);
  const invalidPayload = structuredClone(contract.payload);
  const invalidScreenshot = (invalidPayload.annotatedScreenshots as Array<Record<string, unknown>>)[0];
  assert.ok(invalidScreenshot);
  invalidScreenshot.assetId = original.artifact.id;
  const invalidLlm = new ContractGenerationLLM(invalidPayload);
  let invalidWrites = 0;
  const invalidService = generationServiceFor(contract, invalidLlm, () => { invalidWrites += 1; });

  await assert.rejects(
    () => invalidService.generate(Object.assign(generationInput(contract), {
      visualAssets: [original, annotation],
    })),
    /annotation|derivedFrom|lineage|original/i,
  );
  assert.equal(invalidWrites, 0);

  const validPayload = structuredClone(contract.payload);
  const validScreenshot = (validPayload.annotatedScreenshots as Array<Record<string, unknown>>)[0];
  assert.ok(validScreenshot);
  validScreenshot.assetId = annotation.artifact.id;
  const validLlm = new ContractGenerationLLM(validPayload);
  let validWrites = 0;
  const validService = generationServiceFor(contract, validLlm, () => { validWrites += 1; });
  await validService.generate(Object.assign(generationInput(contract), {
    visualAssets: [original, annotation],
  }));
  assert.equal(validLlm.calls.length, 1);
  assert.equal(validWrites, 1);
});

test('raw source visual inventory items fail before deliverable LLM invocation or sealing', async () => {
  const contract = PROFESSIONAL_CONTRACTS.find(({ deliverableId }) => deliverableId === 'competitive_analysis_report');
  assert.ok(contract);
  const rawSource = verifiedRawSourceAsset(contract, 'asset-raw-source');
  const llm = new ContractGenerationLLM(contract.payload);
  let writes = 0;
  const service = generationServiceFor(contract, llm, () => { writes += 1; });

  await assert.rejects(
    () => service.generate(Object.assign(generationInput(contract), { visualAssets: [rawSource] })),
    /raw|source|visual.*role|inventory/i,
  );
  assert.equal(llm.calls.length, 0);
  assert.equal(writes, 0);
});
