import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PlanCompiler,
  validateCurrentPlanRevision,
} from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { getConfigRoot, setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  loadSkillReferenceDocuments,
  prepareSkillExecution,
  SkillRuntimeDriftError,
} from '../apps/orchestrator-runtime/src/skills/skill-runtime.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  assertCompiledSkillPlan,
  assertFrozenKnowledgeQueryMembership,
  compileSkillSteps,
  selectFrozenKnowledgeReferences,
} from '../apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts';
import { loadSkillExecutionContract } from '../apps/orchestrator-runtime/src/skills/skill-execution-contract.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { CurrentPlanStep } from '../packages/api-contract/research-deliverable.ts';

test('compiled generate-research-plan loads one validated acyclic execution contract', () => {
  const loaded = new SkillLoader().loadSkillExecution('generate-research-plan');
  assert.ok(loaded);
  assert.equal(loaded.contract.skill_id, 'generate-research-plan');
  assert.equal(loaded.contract.version, 'skill-execution-contract-v1');
  assert.match(loaded.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.contract.stages.map(({ stage_id }) => stage_id), [
    'load-standards',
    'external-context',
    'align-brief',
    'select-methods',
    'design-sampling-and-schedule',
    'compose-plan',
    'self-review',
  ]);
  assert.equal(loaded.contract.output_stage_id, 'compose-plan');
  assert.deepEqual(loaded.contract.skill_references, [
    'references/brief-skeleton.md',
    'references/plan-skeleton.md',
    'references/run-notes-template.md',
  ]);
  assert.deepEqual(
    (loaded.contract.resource_queries ?? []).map(({ query_id, min_items, max_items, failure_policy }) => ({
      query_id, min_items, max_items, failure_policy,
    })),
    [
      { query_id: 'scenario-guides', min_items: 1, max_items: 2, failure_policy: 'block' },
      { query_id: 'collection-methods', min_items: 2, max_items: 3, failure_policy: 'block' },
      { query_id: 'analysis-methods', min_items: 3, max_items: 5, failure_policy: 'block' },
      { query_id: 'theory-model', min_items: 0, max_items: 1, failure_policy: 'gap' },
    ],
  );
});

test('execution contract rejects a mismatched Skill identity and absolute paths', () => {
  assert.throws(
    () => loadSkillExecutionContract(
      'orchestrator/skill-executions/generate-research-plan.yaml',
      'another-skill',
    ),
    /does not match/u,
  );
  assert.throws(
    () => loadSkillExecutionContract('/tmp/contract.yaml', 'generate-research-plan'),
    /normalized relative path/u,
  );
});

test('execution contract rejects missing output stages and dependency cycles', () => {
  const originalRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'skill-contract-graph-'));
  const contractDir = join(root, 'orchestrator/skill-executions');
  mkdirSync(contractDir, { recursive: true });
  const source = readFileSync(
    join(originalRoot, 'orchestrator/skill-executions/generate-research-plan.yaml'),
    'utf8',
  );
  const path = 'orchestrator/skill-executions/generate-research-plan.yaml';
  setConfigRoot(root);
  try {
    writeFileSync(join(root, path), source.replace(
      'output_stage_id: compose-plan',
      'output_stage_id: missing-stage',
    ), 'utf8');
    assert.throws(() => loadSkillExecutionContract(path, 'generate-research-plan'), /does not exist/u);

    writeFileSync(join(root, path), source.replace(
      '    depends_on: []',
      '    depends_on: [load-standards]',
    ), 'utf8');
    assert.throws(() => loadSkillExecutionContract(path, 'generate-research-plan'), /cycle/u);
  } finally {
    setConfigRoot(originalRoot);
  }
});

test('execution contract loader rejects symlink components and non-regular files', () => {
  const originalRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'skill-contract-containment-'));
  mkdirSync(join(root, 'orchestrator/skill-executions'), { recursive: true });
  symlinkSync(
    join(originalRoot, 'orchestrator/skill-executions/generate-research-plan.yaml'),
    join(root, 'orchestrator/skill-executions/link.yaml'),
  );
  symlinkSync(
    join(originalRoot, 'orchestrator'),
    join(root, 'linked-orchestrator'),
  );
  mkdirSync(join(root, 'orchestrator/skill-executions/directory.yaml'));
  setConfigRoot(root);
  try {
    assert.throws(
      () => loadSkillExecutionContract('orchestrator/skill-executions/link.yaml', 'generate-research-plan'),
      /symbolic link/u,
    );
    assert.throws(
      () => loadSkillExecutionContract('linked-orchestrator/skill-executions/generate-research-plan.yaml', 'generate-research-plan'),
      /symbolic link/u,
    );
    assert.throws(
      () => loadSkillExecutionContract('orchestrator/skill-executions/directory.yaml', 'generate-research-plan'),
      /not a regular file/u,
    );
  } finally {
    setConfigRoot(originalRoot);
  }
});

test('Skill reference loading rejects traversal and symlink escapes before hashing', () => {
  const originalRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'skill-reference-containment-'));
  const skillRoot = join(root, 'knowledge-base/skills/test-skill');
  mkdirSync(join(skillRoot, 'references'), { recursive: true });
  writeFileSync(join(skillRoot, 'SKILL.md'), '# Skill', 'utf8');
  const outside = join(root, 'outside.md');
  writeFileSync(outside, 'outside', 'utf8');
  symlinkSync(outside, join(skillRoot, 'references/link.md'));
  const loader = (referencePath: string) => ({
    loadSkillExecution: () => ({ contract: { skill_references: [referencePath] } }),
    loadSkillBody: () => ({ path: 'knowledge-base/skills/test-skill/SKILL.md', body: '# Skill', hash: 'hash' }),
  }) as unknown as SkillLoader;
  setConfigRoot(root);
  try {
    assert.throws(
      () => loadSkillReferenceDocuments({ skillId: 'test-skill', skillLoader: loader('../outside.md') }),
      /normalized relative path/u,
    );
    assert.throws(
      () => loadSkillReferenceDocuments({ skillId: 'test-skill', skillLoader: loader('references/link.md') }),
      /symlink/u,
    );
  } finally {
    setConfigRoot(originalRoot);
  }
});

test('compiled Skill expands one visible frozen seven-stage DAG', () => {
  const task: ResearchTaskV2 = {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: '宠物用户研究',
    research_goal: '规划用户旅程、深度访谈与问卷分析',
    target_audience: ['平台运营团队'],
    scope: ['手机 App 用户旅程'],
    constraints: [],
    success_criteria: [{ id: 'SC-1', statement: 'plan is executable' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  const common = {
    question_ids: ['Q1'],
    input_bindings: [],
    acceptance_criteria: ['valid'],
    requires_approval: false,
    fallback_actor_ids: [],
  };
  const steps: CurrentPlanStep[] = [
    {
      ...common,
      step_no: 1,
      step_name: 'search',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      depends_on: [],
      input: { query: 'pet brand study', unexpected: 'must not enter compiled Tool input' },
      expected_outputs: [{ pointer: '/results', description: 'results' }],
    },
    {
      ...common,
      step_no: 2,
      step_name: 'plan',
      actor_type: 'skill',
      actor_id: 'generate-research-plan',
      depends_on: [1],
      input: {},
      expected_outputs: [{ pointer: '/payload', description: 'plan' }],
    },
    {
      ...common,
      step_no: 3,
      step_name: 'review',
      actor_type: 'reviewer',
      actor_id: 'reviewer.research-lead',
      depends_on: [2],
      input: {},
      expected_outputs: [{ pointer: '/review', description: 'review' }],
    },
  ];

  const compiled = compileSkillSteps(steps, task);
  assert.equal(compiled.invocations.length, 1);
  assert.equal(compiled.steps.length, 7);
  assert.deepEqual(compiled.steps.map(({ skill_stage_id }) => skill_stage_id), [
    'external-context',
    'load-standards',
    'align-brief',
    'select-methods',
    'design-sampling-and-schedule',
    'compose-plan',
    'self-review',
  ]);
  assert.deepEqual(compiled.invocations[0]?.step_nos, [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(Array.isArray(compiled.invocations[0]?.skill_reference_hashes));
  assert.deepEqual(compiled.invocations[0]?.resource_gaps, []);
  assert.equal(compiled.steps[0]?.input.query, 'pet brand study');
  assert.equal(Object.hasOwn(compiled.steps[0]?.input ?? {}, 'unexpected'), false);
  assert.equal(compiled.steps[1]?.actor_type, 'knowledge');
  const references = compiled.steps[1]?.input.references;
  assert.ok(Array.isArray(references) && references.length > 3, 'task-matched dynamic knowledge must be frozen');
  assert.equal(compiled.steps[5]?.actor_type, 'skill');
  assert.equal(compiled.steps[6]?.depends_on.includes(6), true);

  const contract = new SkillLoader().loadSkillExecution('generate-research-plan')!.contract;
  assert.throws(() => selectFrozenKnowledgeReferences({
    ...contract,
    resources: [{
      resource_id: 'knowledge_does_not_exist', required: true, accepted_statuses: ['approved'],
      purpose: 'negative test', failure_policy: 'block',
    }],
    resource_queries: [],
  }, task), /is unavailable/u);
  assert.throws(() => selectFrozenKnowledgeReferences({
    ...contract,
    resources: [{
      ...contract.resources[0]!,
      accepted_statuses: ['approved'],
    }],
    resource_queries: [],
  }, task), /status is not accepted/u);

  const dynamicStatusContract = {
    ...contract,
    resources: [],
    resource_queries: [{
      query_id: 'approved-methods-only',
      types: ['method'],
      min_items: 1,
      max_items: 2,
      accepted_statuses: ['approved'] as Array<'approved' | 'draft'>,
      purpose: 'reject draft-only dynamic category',
      failure_policy: 'block' as const,
    }],
  };
  assert.throws(
    () => selectFrozenKnowledgeReferences(dynamicStatusContract, task),
    /below min_items/u,
  );

  const withGap = selectFrozenKnowledgeReferences({
    ...contract,
    resources: [],
    resource_queries: [{
      query_id: 'unavailable-kind',
      types: ['not-a-real-type'],
      min_items: 1,
      max_items: 2,
      accepted_statuses: ['approved'],
      purpose: 'exercise cardinality policy',
      failure_policy: 'gap',
    }],
  }, task);
  assert.equal(withGap.resourceGaps[0]?.query_id, 'unavailable-kind');
  assert.throws(() => selectFrozenKnowledgeReferences({
    ...contract,
    resources: [],
    resource_queries: [{
      ...(contract.resource_queries?.[0] ?? {
        query_id: 'fallback', types: ['method'], min_items: 0, max_items: 1,
        accepted_statuses: ['approved'] as Array<'approved' | 'draft'>, purpose: 'fallback', failure_policy: 'gap' as const,
      }),
      query_id: 'unavailable-kind',
      types: ['not-a-real-type'],
      min_items: 1,
      max_items: 2,
      failure_policy: 'block',
    }],
  }, task), /below min_items/u);
});

test('PlanCompiler persists seven stages and rejects frozen actor, dependency, input, binding, output, and acceptance drift', () => {
  const loader = new SkillLoader();
  const skill = loader.listCapabilitySkills().find((candidate) => candidate.id === 'generate-research-plan');
  assert.ok(skill?.status === 'active');
  const task: ResearchTaskV2 = {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: 'pet services',
    research_goal: 'plan a pet-brand mindshare study',
    target_audience: ['platform operations'],
    scope: ['mobile app'],
    constraints: [],
    success_criteria: [{ id: 'SC-1', statement: 'plan is executable' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  const common = {
    question_ids: ['Q1'], input_bindings: [], acceptance_criteria: ['valid'],
    requires_approval: false, fallback_actor_ids: [],
  };
  const compiled = new PlanCompiler().compile({
    candidate: {
      id: 'depth', title: 'Depth', rationale: 'Compiled Skill', tradeoffs: 'More stages',
      assumptions: [], activated_nodes: [],
      steps: [
        { ...common, step_no: 1, step_name: 'Search', actor_type: 'tool', actor_id: 'tavily-web-search', depends_on: [], input: { query: 'pet research' }, expected_outputs: [{ pointer: '/results', description: 'results' }] },
        { ...common, step_no: 2, step_name: 'Plan', actor_type: 'skill', actor_id: 'generate-research-plan', depends_on: [1], input: {}, expected_outputs: [{ pointer: '/payload', description: 'plan' }] },
        { ...common, step_no: 3, step_name: 'Review', actor_type: 'reviewer', actor_id: 'reviewer.research-lead', depends_on: [2], input: {}, expected_outputs: [{ pointer: '/review', description: 'review' }] },
      ],
    },
    task,
    deliverable_selection: {
      deliverableId: 'research_plan',
      evidenceRequirements: [{ id: 'research-plan', acceptedClasses: ['public_source', 'knowledge'], minimumCount: 1, required: true }],
    },
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'Q1', statement: 'How should the study run?', rationale: 'Decision support', priority: 'required',
        success_criterion_ids: ['SC-1'],
        evidence_requirements: [{ id: 'research-plan', acceptedClasses: ['public_source', 'knowledge'], minimumCount: 1, required: true }],
        acceptance_criteria: ['Executable plan'], depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111', modelName: 'model', modelVersion: 'v1', promptHash: 'sha256:test', traceId: 'trace',
    },
    capability_resolution: {
      eligible: [{ skill, reasons: [{ code: 'eligible', message: 'eligible' }], pending_inputs: [], required_approvals: [], optional_tool_decisions: [] }],
      rejected: [],
    },
    evidence_requirements: [{ id: 'research-plan', acceptedClasses: ['public_source', 'knowledge'], minimumCount: 1, required: true }],
    activated_nodes: [],
  });

  assert.equal(compiled.plan.execution_contract_version, 'current-execution-plan-v2');
  assert.equal(compiled.plan.skill_invocations?.length, 1);
  assert.equal(compiled.plan.steps.length, 7);
  assert.deepEqual(compiled.plan.steps.map(({ skill_stage_id }) => skill_stage_id), [
    'external-context', 'load-standards', 'align-brief', 'select-methods',
    'design-sampling-and-schedule', 'compose-plan', 'self-review',
  ]);
  const invocation = compiled.plan.skill_invocations?.[0];
  assert.ok(invocation);
  const prepare = (frozenExecution: {
    contractHash: string;
    referenceHashes: Array<{ path: string; hash: string }>;
    degradedPolicy: 'gap' | 'block';
  }) => prepareSkillExecution({
    skillId: 'generate-research-plan',
    researchGoal: task.research_goal,
    resolvedInput: compiled.plan.steps.find(({ actor_type }) => actor_type === 'skill')?.input ?? {},
    priorOutputs: [],
    skillLoader: loader,
    validator: new SchemaValidator(),
    frozenExecution,
  });
  const binding = {
    contractHash: invocation.contract_hash,
    referenceHashes: invocation.skill_reference_hashes,
    degradedPolicy: invocation.degraded_policy,
  };
  assert.doesNotThrow(() => prepare(binding));
  assert.throws(() => prepare({ ...binding, contractHash: `sha256:${'0'.repeat(64)}` }), SkillRuntimeDriftError);
  assert.throws(() => prepare({
    ...binding,
    referenceHashes: binding.referenceHashes.map((reference, index) => (
      index === 0 ? { ...reference, hash: `sha256:${'0'.repeat(64)}` } : reference
    )),
  }), SkillRuntimeDriftError);
  assert.throws(() => prepare({
    ...binding,
    degradedPolicy: binding.degradedPolicy === 'gap' ? 'block' : 'gap',
  }), SkillRuntimeDriftError);

  const frozen = { ...compiled.plan, task_id: 'task-compiled-plan-1' };
  assert.deepEqual(validateCurrentPlanRevision({
    plan: frozen,
    task,
    pending_inputs: compiled.pending_inputs,
    task_id: frozen.task_id,
    candidate_id: 'depth',
  }), frozen);

  const tamperCases: Array<[string, (plan: typeof frozen) => void]> = [
    ['contract hash drift', (plan) => { plan.skill_invocations![0]!.contract_hash = `sha256:${'0'.repeat(64)}`; }],
    ['reference hash drift', (plan) => { plan.skill_invocations![0]!.skill_reference_hashes[0]!.hash = `sha256:${'0'.repeat(64)}`; }],
    ['Knowledge binding drift', (plan) => { plan.skill_invocations![0]!.knowledge_references.pop(); }],
    ['stage actor drift', (plan) => { plan.steps[0]!.actor_id = 'another-tool'; }],
    ['stage dependency drift', (plan) => { plan.steps[2]!.depends_on = []; }],
    ['stage input binding drift', (plan) => { plan.steps[2]!.input_bindings.reverse(); }],
    ['stage immutable input drift', (plan) => { plan.steps[2]!.input.unexpected = true; }],
    ['stage acceptance drift', (plan) => { plan.steps[2]!.acceptance_criteria[0] = 'changed'; }],
    ['dynamic Knowledge query swap', (plan) => {
      const collection = plan.skill_invocations![0]!.knowledge_references.find(({ queryId }) => queryId === 'collection-methods');
      const analysis = plan.skill_invocations![0]!.knowledge_references.find(({ queryId }) => queryId === 'analysis-methods');
      if (!collection || !analysis) throw new Error('query fixtures missing');
      [collection.queryId, analysis.queryId] = [analysis.queryId, collection.queryId];
      const knowledgeStep = plan.steps.find(({ skill_stage_id }) => skill_stage_id === 'load-standards')!;
      knowledgeStep.input.references = structuredClone(plan.skill_invocations![0]!.knowledge_references);
    }],
    ['stage output drift', (plan) => { plan.steps[2]!.expected_outputs[0]!.pointer = '/other'; }],
    ['Tool ownership drift', (plan) => { plan.capability_decisions.eligible[0]!.skill.required_tools = []; }],
  ];
  for (const [label, mutate] of tamperCases) {
    const tampered = structuredClone(frozen);
    mutate(tampered);
    assert.throws(() => validateCurrentPlanRevision({
      plan: tampered,
      task,
      pending_inputs: compiled.pending_inputs,
      task_id: frozen.task_id,
      candidate_id: 'depth',
    }), label);
  }

  class DisallowedDynamicStatusLoader extends SkillLoader {
    override loadSkillExecution(id: string) {
      const loaded = super.loadSkillExecution(id);
      if (!loaded || id !== 'generate-research-plan') return loaded;
      return {
        ...loaded,
        hash: invocation.contract_hash,
        contract: {
          ...loaded.contract,
          resource_queries: (loaded.contract.resource_queries ?? []).map((query) => (
            query.query_id === 'collection-methods'
              ? { ...query, accepted_statuses: ['approved'] as Array<'approved' | 'draft'> }
              : query
          )),
        },
      };
    }
  }
  assert.throws(
    () => assertCompiledSkillPlan(frozen, new DisallowedDynamicStatusLoader()),
    /invalid query membership/u,
  );
});

test('dynamic Knowledge membership rejects query swaps that bind the wrong resource type', () => {
  const loaded = new SkillLoader().loadSkillExecution('generate-research-plan');
  assert.ok(loaded);
  const task: ResearchTaskV2 = {
    version: 'research-task-v2', task_type: 'user_research_planning', business_domain: 'pet services',
    research_goal: 'plan customer interviews and thematic analysis', target_audience: ['researchers'],
    scope: ['mobile app'], constraints: [], success_criteria: [{ id: 'SC-1', statement: 'usable' }],
    expected_deliverables: ['research_plan'], assumptions: [], ambiguities: [], clarification_questions: [],
    blocking_issues: [], sensitivity: 'internal', pii_detected: false,
  };
  const selected = selectFrozenKnowledgeReferences(loaded.contract, task);
  const swapped = structuredClone(selected.references);
  const collection = swapped.find(({ queryId }) => queryId === 'collection-methods');
  const analysis = swapped.find(({ queryId }) => queryId === 'analysis-methods');
  assert.ok(collection && analysis);
  [collection.queryId, analysis.queryId] = [analysis.queryId, collection.queryId];
  assert.throws(() => assertFrozenKnowledgeQueryMembership(loaded.contract, {
    invocation_id: 'test-invocation', knowledge_references: swapped, resource_gaps: selected.resourceGaps,
  }), /invalid query membership/u);
});

test('dynamic Knowledge membership rejects a status disallowed by its query', () => {
  const loaded = new SkillLoader().loadSkillExecution('generate-research-plan');
  assert.ok(loaded);
  const task: ResearchTaskV2 = {
    version: 'research-task-v2', task_type: 'user_research_planning', business_domain: 'pet services',
    research_goal: 'plan customer interviews and thematic analysis', target_audience: ['researchers'],
    scope: ['mobile app'], constraints: [], success_criteria: [{ id: 'SC-1', statement: 'usable' }],
    expected_deliverables: ['research_plan'], assumptions: [], ambiguities: [], clarification_questions: [],
    blocking_issues: [], sensitivity: 'internal', pii_detected: false,
  };
  const selected = selectFrozenKnowledgeReferences(loaded.contract, task);
  const contract = structuredClone(loaded.contract);
  const collectionQuery = contract.resource_queries?.find(({ query_id }) => query_id === 'collection-methods');
  assert.ok(collectionQuery);
  collectionQuery.accepted_statuses = ['approved'];
  assert.throws(() => assertFrozenKnowledgeQueryMembership(contract, {
    invocation_id: 'test-invocation',
    knowledge_references: selected.references,
    resource_gaps: selected.resourceGaps,
  }), /invalid query membership/u);
});

test('legacy Skills do not expose an execution contract', () => {
  assert.equal(new SkillLoader().loadSkillExecution('generate-survey'), null);
});
