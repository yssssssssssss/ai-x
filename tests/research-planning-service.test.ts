import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CurrentExecutionPlan,
  EvidenceRequirement,
} from '../packages/api-contract/research-deliverable.ts';
import type {
  GuidanceRef,
  PlanCandidate,
  ResearchTaskData,
} from '../packages/api-contract/plan.ts';
import type {
  DecisionStateRec,
  PlanProvenance,
} from '../apps/orchestrator-runtime/src/planners/plan-strategy.ts';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  getConfigRoot,
  setConfigRoot,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

interface ResearchPlanningResult {
  task: ResearchTaskData;
  activatedNodes: string[];
  decisionStates: DecisionStateRec[];
  candidates: PlanCandidate[];
  guidanceSources: GuidanceRef[];
  provenance: PlanProvenance;
}

interface ResearchPlanningServiceLike {
  plan(input: { originalInput: string }): Promise<ResearchPlanningResult>;
}

type ResearchPlanningServiceConstructor = new (dependencies: {
  llm: MockLLMClient;
  skillLoader: SkillLoader;
  validator: SchemaValidator;
}) => ResearchPlanningServiceLike;

type ResolveEvidenceRequirements = (
  taskType: string,
  deliverableType: CurrentExecutionPlan['deliverable_type'],
) => EvidenceRequirement[];

interface ResearchPlanningModule {
  ResearchPlanningService: ResearchPlanningServiceConstructor;
  resolveEvidenceRequirements: ResolveEvidenceRequirements;
}

const planningModulePath: string =
  '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';

const planningModuleFile = new URL(planningModulePath, import.meta.url);
async function loadResearchPlanningModule(): Promise<ResearchPlanningModule> {
  assert.equal(
    existsSync(planningModuleFile),
    true,
    'ResearchPlanningService module must exist',
  );
  // Test-boundary exception: the planned module does not exist yet, so keep the dynamic
  // import path non-literal and narrow its exports explicitly until the RED is implemented.
  const moduleExports = await import(planningModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.ResearchPlanningService, 'function');
  assert.equal(typeof moduleExports.resolveEvidenceRequirements, 'function');
  return moduleExports as unknown as ResearchPlanningModule;
}

function createService(
  ResearchPlanningService: ResearchPlanningServiceConstructor,
): ResearchPlanningServiceLike {
  return new ResearchPlanningService({
    llm: new MockLLMClient(),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
  });
}

function toCurrentExecutionPlan(
  taskId: string,
  candidate: PlanCandidate,
  evidenceRequirements: EvidenceRequirement[],
): CurrentExecutionPlan {
  return {
    task_id: taskId,
    deliverable_type: 'research_plan',
    evidence_requirements: evidenceRequirements,
    steps: candidate.steps,
  };
}

const publicSourcePolicy: EvidenceRequirement[] = [{
  id: 'public-market-evidence',
  acceptedClasses: ['public_source'],
  minimumCount: 1,
  required: true,
}];

test('plans a competitive query into two candidates with ResearchTask provenance and guidance', async () => {
  const planningModule = await loadResearchPlanningModule();
  const validator = new SchemaValidator();
  const service = createService(planningModule.ResearchPlanningService);

  const result = await service.plan({
    originalInput: '请对直播场域数字人竞品做公开资料横向研究，比较能力与体验差异。',
  });

  assert.equal(result.task.task_type, 'competitive_research');
  assert.doesNotThrow(() => validator.validateOrThrow('research-task', result.task));
  assert.ok(result.activatedNodes.includes('D5_competitive'));
  assert.ok(result.decisionStates.length > 0);
  assert.ok(result.decisionStates.every((state) => result.activatedNodes.includes(state.node_key)));
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['depth', 'speed']);
  assert.ok(result.guidanceSources.length > 0);
  const samplingAssociations = result.guidanceSources.filter(
    (source) => source.id === 'standard_need_discovery_sampling',
  );
  assert.ok(
    samplingAssociations.some((source, index, all) =>
      all.some((candidate, candidateIndex) =>
        candidateIndex !== index &&
        candidate.node !== source.node &&
        candidate.id === source.id &&
        candidate.content_hash === source.content_hash
      )
    ),
    'guidanceSources must preserve each node association for the same guidance ref/hash',
  );
  assert.match(result.provenance.modelName, /\S/);
  assert.match(result.provenance.modelVersion, /\S/);
  assert.match(result.provenance.promptHash, /^sha256:/);
  assert.match(result.provenance.traceId, /^trace_/);

  const evidenceRequirements = planningModule.resolveEvidenceRequirements(
    result.task.task_type,
    'research_plan',
  );
  for (const candidate of result.candidates) {
    const plan = toCurrentExecutionPlan(
      '00000000-0000-0000-0000-000000000001',
      candidate,
      evidenceRequirements,
    );
    assert.equal(plan.deliverable_type, 'research_plan');
    assert.deepEqual(plan.evidence_requirements, publicSourcePolicy);
    assert.ok(plan.steps.length > 0);
  }
});

test('rejects an unconfigured task_type and deliverable_type Evidence Policy pair', async () => {
  const { resolveEvidenceRequirements } = await loadResearchPlanningModule();

  assert.throws(
    () => resolveEvidenceRequirements('unconfigured_research', 'research_plan'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Evidence Policy/i);
      assert.match(error.message, /task_type=unconfigured_research/);
      assert.match(error.message, /deliverable_type=research_plan/);
      return true;
    },
  );
});

const malformedPolicies = [
    {
      name: 'unknown accepted class',
      field: /accepted_classes/,
      yaml: `version: 1
policies:
  - task_type: competitive_research
    deliverable_type: research_plan
    requirements:
      - id: public-market-evidence
        accepted_classes: [unknown]
        minimum_count: 1
        required: true
`,
    },
    {
      name: 'negative minimum count',
      field: /minimum_count/,
      yaml: `version: 1
policies:
  - task_type: competitive_research
    deliverable_type: research_plan
    requirements:
      - id: public-market-evidence
        accepted_classes: [public_source]
        minimum_count: -1
        required: true
`,
    },
    {
      name: 'non-integer minimum count',
      field: /minimum_count/,
      yaml: `version: 1
policies:
  - task_type: competitive_research
    deliverable_type: research_plan
    requirements:
      - id: public-market-evidence
        accepted_classes: [public_source]
        minimum_count: 1.5
        required: true
`,
    },
    {
      name: 'duplicate task and deliverable pair',
      field: /task_type.*deliverable_type|deliverable_type.*task_type/,
      yaml: `version: 1
policies:
  - task_type: competitive_research
    deliverable_type: research_plan
    requirements:
      - id: first-evidence
        accepted_classes: [public_source]
        minimum_count: 1
        required: true
  - task_type: competitive_research
    deliverable_type: research_plan
    requirements:
      - id: duplicate-evidence
        accepted_classes: [public_source]
        minimum_count: 1
        required: true
`,
    },
    {
      name: 'missing requirements',
      field: /requirements/,
      yaml: `version: 1
policies:
  - task_type: competitive_research
    deliverable_type: research_plan
`,
    },
] as const;

for (const malformed of malformedPolicies) {
  test(`rejects malformed Evidence Policy: ${malformed.name}`, async () => {
    const { resolveEvidenceRequirements } = await loadResearchPlanningModule();
    const originalConfigRoot = getConfigRoot();
    const configRoot = mkdtempSync(join(tmpdir(), 'malformed-evidence-policy-'));
    const orchestratorRoot = join(configRoot, 'orchestrator');
    mkdirSync(orchestratorRoot, { recursive: true });

    try {
      setConfigRoot(configRoot);
      writeFileSync(join(orchestratorRoot, 'evidence-policy.yaml'), malformed.yaml);
      assert.throws(
        () => resolveEvidenceRequirements('competitive_research', 'research_plan'),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${malformed.name} must throw an Error`);
          assert.equal(
            error instanceof TypeError,
            false,
            `${malformed.name} must not leak a TypeError`,
          );
          assert.match(error.message, /Evidence Policy/i);
          assert.match(error.message, malformed.field);
          return true;
        },
        malformed.name,
      );
    } finally {
      setConfigRoot(originalConfigRoot);
      rmSync(configRoot, { recursive: true, force: true });
    }
  });
}
