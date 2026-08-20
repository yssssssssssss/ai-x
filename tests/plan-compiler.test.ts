import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join } from 'node:path';
import type { PlanCandidate, ResearchTaskData, ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type {
  CurrentExecutionPlan,
  EvidenceRequirement,
  PendingInput,
} from '../packages/api-contract/research-deliverable.ts';
import type { CapabilityResolution } from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import type { ProblemGraph } from '../apps/orchestrator-runtime/src/planners/problem-graph-planner.ts';
import {
  PlanCompiler,
  PlanCompilerValidationError,
  validateCurrentPlanRevision,
  type CurrentPlanCandidateProposal,
  type PlanCompileInput,
} from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import { ControlPlanningService } from '../apps/orchestrator-runtime/src/control/control-planning-service.ts';
import {
  ResearchPlanningService,
  resolvePlanningDeliverableSelection,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { ToolRouter, type ToolAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import {
  getConfigRoot,
  loadToolManifest,
  setConfigRoot,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import type {
  LLMClient,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

const comparisonDimensions = [
  '需求理解',
  '推荐可解释性',
  '商品参数与价格对比',
  '内容可信度',
  '购买转化闭环',
] as const;

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'competitive_research',
  business_domain: 'live_commerce',
  research_goal: '比较直播数字人方案并形成可执行建议',
  comparison_dimensions: [...comparisonDimensions],
  target_audience: ['产品团队'],
  scope: ['公开资料'],
  constraints: [{ id: 'public-only', statement: '仅使用公开资料', source: 'user' }],
  success_criteria: [
    { id: 'criterion-source', statement: '结论均有公开来源' },
    { id: 'criterion-action', statement: '形成可执行建议' },
  ],
  expected_deliverables: ['competitive analysis report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

const evidencePolicy: EvidenceRequirement[] = [{
  id: 'public-source',
  acceptedClasses: ['public_source'],
  minimumCount: 2,
  required: true,
}];

const problemGraphProvenance = {
  receiptId: '11111111-1111-4111-8111-111111111122',
  modelName: 'problem-graph-model',
  modelVersion: '2026-08-14',
  promptHash: 'sha256:problem-graph',
  traceId: 'trace-problem-graph',
};

function graph(): ProblemGraph {
  return {
    version: 'problem-graph-v1',
    questions: [
      {
        id: 'question-source',
        statement: '主要方案的公开事实是什么？',
        rationale: '建立可追溯事实基础。',
        priority: 'required',
        success_criterion_ids: ['criterion-source'],
        evidence_requirements: structuredClone(evidencePolicy),
        acceptance_criteria: ['至少两个独立公开来源'],
        depends_on: [],
      },
      {
        id: 'question-action',
        statement: '团队应该如何选择？',
        rationale: '把事实转成行动。',
        priority: 'required',
        success_criterion_ids: ['criterion-action'],
        evidence_requirements: structuredClone(evidencePolicy),
        acceptance_criteria: ['建议说明条件与取舍'],
        depends_on: ['question-source'],
      },
    ],
  };
}

const eligibleSkill = {
  id: 'competitive-web-research',
  name: '竞品分析·Web搜索',
  path: 'skills/competitive-analysis/web-research/SKILL.md',
  when_to_use: '公开资料竞品分析',
  owner: '竞品分析组',
  status: 'active' as const,
  task_types: ['competitive_research'],
  inputs: ['research_goal', 'competitor_screenshots'],
  visual_inputs: ['competitor_screenshots'],
  outputs: ['competitive_analysis'],
  required_tools: ['tavily-web-search'],
  optional_tools: [],
  risk_level: 'low' as const,
};

function capabilityResolution(): CapabilityResolution {
  return {
    eligible: [{
      skill: structuredClone(eligibleSkill),
      required_approvals: [],
      reasons: [
        { code: 'pending_input_required', message: 'skill requires one pending input' },
        { code: 'eligible', message: 'skill passed all capability filters' },
      ],
      pending_inputs: [{
        kind: 'visual',
        role: 'competitor_screenshots',
        label: '竞品截图',
        multiple: true,
        capability_id: eligibleSkill.id,
      }],
      optional_tool_decisions: [],
    }],
    rejected: [{
      skill: { ...structuredClone(eligibleSkill), id: 'rejected-skill', status: 'draft' as const },
      required_approvals: [],
      reasons: [{ code: 'skill_inactive', message: 'skill is not active' }],
      pending_inputs: [],
      optional_tool_decisions: [],
    }],
  };
}

const playwrightToolId = 'playwright-page-capture';

function optionalCapabilityResolution(
  status: 'available' | 'unavailable',
): CapabilityResolution {
  const resolution = capabilityResolution();
  resolution.eligible[0]!.skill.optional_tools = [playwrightToolId];
  resolution.eligible[0]!.optional_tool_decisions = status === 'available'
    ? [{ tool_id: playwrightToolId, status }]
    : [{
        tool_id: playwrightToolId,
        status,
        reason_code: 'optional_tool_real_adapter_unavailable',
        message: 'optional tool has no qualified real adapter',
      }];
  return resolution;
}

function step(overrides: Record<string, unknown> = {}): CurrentPlanCandidateProposal['steps'][number] {
  return {
    step_no: 99,
    step_name: '公开来源检索',
    actor_type: 'tool',
    actor_id: 'tavily-web-search',
    question_ids: ['question-source'],
    depends_on: [],
    input: { query: task.research_goal },
    input_bindings: [],
    expected_outputs: [{ pointer: '/results', description: '公开来源结果' }],
    acceptance_criteria: ['至少返回两个可访问来源'],
    requires_approval: false,
    fallback_actor_ids: [],
    ...overrides,
  } as CurrentPlanCandidateProposal['steps'][number];
}

function validCandidate(id: 'depth' | 'speed' = 'depth'): CurrentPlanCandidateProposal {
  return {
    id,
    title: id === 'depth' ? '深度研究' : '快速研究',
    rationale: id === 'depth' ? '覆盖全部问题' : '优先核心证据',
    tradeoffs: id === 'depth' ? '耗时更长' : '复核较少',
    assumptions: [],
    activated_nodes: ['D5_competitive'],
    steps: [
      step(),
      step({
        step_name: '竞品综合分析',
        actor_type: 'skill',
        actor_id: eligibleSkill.id,
        question_ids: ['question-source', 'question-action'],
        depends_on: [1],
        input: {
          research_goal: task.research_goal,
          dimensions: [...comparisonDimensions],
          scoring_weights: Object.fromEntries(
            comparisonDimensions.map((dimension) => [dimension, 0.2]),
          ),
          sources: null,
          competitor_screenshots: [],
        },
        input_bindings: [{
          target_pointer: '/sources',
          source_step_no: 1,
          source_pointer: '/results',
        }],
        expected_outputs: [{ pointer: '/payload/analysis', description: '证据化竞品分析' }],
        acceptance_criteria: ['结论覆盖两个研究问题'],
      }),
    ],
  };
}

function candidateWithBrowserCapture(id: 'depth' | 'speed' = 'depth'): CurrentPlanCandidateProposal {
  const candidate = validCandidate(id);
  candidate.steps.splice(1, 0, step({
    step_name: '采集网页视觉证据',
    actor_type: 'tool',
    actor_id: playwrightToolId,
    depends_on: [1],
    input: { pages: [], capture: { mode: 'auto', max_pages: 6 } },
    input_bindings: [{
      target_pointer: '/pages',
      source_step_no: 1,
      source_pointer: '/results',
    }],
    expected_outputs: [{ pointer: '/captures', description: '网页截图元数据' }],
  }));
  candidate.steps[2]!.depends_on = [1, 2];
  return candidate;
}

function input(candidate: CurrentPlanCandidateProposal = validCandidate()): PlanCompileInput {
  return {
    candidate,
    task,
    problem_graph: graph(),
    problem_graph_provenance: structuredClone(problemGraphProvenance),
    capability_resolution: capabilityResolution(),
    evidence_requirements: structuredClone(evidencePolicy),
    activated_nodes: ['D5_competitive'],
    requireCompetitiveWeightContract: true,
  };
}

function expectCompileError(
  mutate: (value: PlanCompileInput) => void,
  kind: string,
  issue: string,
): void {
  const value = input();
  mutate(value);
  assert.throws(
    () => new PlanCompiler().compile(value),
    (error: unknown) => {
      assert.ok(error instanceof PlanCompilerValidationError);
      assert.equal(error.kind, kind);
      assert.match(error.message, new RegExp(issue));
      return true;
    },
  );
}

test('rejects pending input roles missing from the frozen Skill step input', () => {
  const value = input();
  delete (value.candidate.steps[1]!.input as Record<string, unknown>).competitor_screenshots;
  assert.throws(
    () => new PlanCompiler().compile(value),
    (error: unknown) => {
      assert.ok(error instanceof PlanCompilerValidationError);
      assert.equal(error.kind, 'pending_input_schema_invalid');
      assert.match(error.message, /competitor_screenshots/);
      return true;
    },
  );
});

test('rejects a step dependency cycle', () => {
  expectCompileError((value) => {
    value.candidate.steps = [
      step({ actor_type: 'llm', actor_id: 'source-synthesis', depends_on: [2] }),
      step({
        actor_type: 'reviewer',
        actor_id: 'source-reviewer',
        question_ids: ['question-action'],
        depends_on: [1],
      }),
    ];
  }, 'dependency_cycle', '1');
});

test('rejects an orphan required question', () => {
  expectCompileError((value) => {
    value.candidate.steps = [step()];
  }, 'orphan_required_question', 'question-action');
});

test('rejects a selected skill when its required tool is missing', () => {
  expectCompileError((value) => {
    value.candidate.steps = [step({
      actor_type: 'skill',
      actor_id: eligibleSkill.id,
      question_ids: ['question-source', 'question-action'],
    })];
  }, 'required_tool_missing', 'tavily-web-search');
});

test('rejects a selected skill when its required tool runs after the skill', () => {
  expectCompileError((value) => {
    value.candidate.steps = [
      step({
        actor_type: 'skill',
        actor_id: eligibleSkill.id,
        question_ids: ['question-source', 'question-action'],
      }),
      step(),
    ];
  }, 'required_tool_late', 'tavily-web-search');
});

test('freezes available optional Playwright with the exact Tavily results binding', () => {
  const value = input(candidateWithBrowserCapture());
  value.capability_resolution = optionalCapabilityResolution('available');
  const compiled = new PlanCompiler().compile(value);

  assert.deepEqual(compiled.plan.steps.map(({ actor_id }) => actor_id), [
    'tavily-web-search',
    playwrightToolId,
    eligibleSkill.id,
  ]);
  assert.deepEqual(compiled.plan.steps[1]?.input_bindings, [{
    target_pointer: '/pages',
    source_step_no: 1,
    source_pointer: '/results',
  }]);
  assert.deepEqual(compiled.plan.capability_gaps, []);
  assert.deepEqual(
    compiled.plan.capability_decisions.eligible[0]?.optional_tool_decisions,
    [{ tool_id: playwrightToolId, status: 'available' }],
  );
});

test('turns unavailable optional Playwright into one frozen capability gap without a step', () => {
  const value = input();
  value.capability_resolution = optionalCapabilityResolution('unavailable');
  const compiled = new PlanCompiler().compile(value);

  assert.deepEqual(compiled.plan.steps.map(({ actor_id }) => actor_id), [
    'tavily-web-search',
    eligibleSkill.id,
  ]);
  assert.deepEqual(compiled.plan.capability_gaps, [{
    capability_type: 'tool',
    capability_id: playwrightToolId,
    code: 'optional_tool_real_adapter_unavailable',
    message: 'optional tool has no qualified real adapter',
  }]);
});

test('rejects missing, late, handwritten, or wrongly bound available Playwright steps', () => {
  expectCompileError((value) => {
    value.capability_resolution = optionalCapabilityResolution('available');
  }, 'optional_tool_missing', playwrightToolId);

  for (const mutate of [
    (value: PlanCompileInput) => { value.candidate.steps[1]!.input.pages = [{ url: 'https://example.test' }]; },
    (value: PlanCompileInput) => { value.candidate.steps[1]!.input_bindings[0]!.target_pointer = '/capture'; },
    (value: PlanCompileInput) => { value.candidate.steps[1]!.input_bindings[0]!.source_pointer = '/answer'; },
    (value: PlanCompileInput) => { value.candidate.steps[1]!.depends_on = []; },
  ]) {
    const value = input(candidateWithBrowserCapture());
    value.capability_resolution = optionalCapabilityResolution('available');
    mutate(value);
    assert.throws(
      () => new PlanCompiler().compile(value),
      (error: unknown) => {
        assert.ok(error instanceof PlanCompilerValidationError);
        assert.ok(
          error.kind === 'optional_tool_binding_invalid'
          || error.kind === 'optional_tool_late',
        );
        return true;
      },
    );
  }
});

test('rejects input bindings that point to a future step', () => {
  expectCompileError((value) => {
    value.candidate.steps[0]!.input = { source: null };
    value.candidate.steps[0]!.input_bindings = [{
      target_pointer: '/source',
      source_step_no: 2,
      source_pointer: '/analysis',
    }];
  }, 'future_binding_source', '2');
});

test('rejects input bindings whose source output pointer is not declared', () => {
  expectCompileError((value) => {
    value.candidate.steps[1]!.input_bindings[0]!.source_pointer = '/missing';
  }, 'unknown_binding_pointer', '/missing');
});

test('rejects Skill output pointers outside the unified payload root', () => {
  expectCompileError(
    (value) => {
      value.candidate.steps[1]!.expected_outputs = [{ pointer: '/analysis', description: 'legacy output' }];
    },
    'invalid_skill_output_pointer',
    '/analysis',
  );
});

test('rejects output pointers that the LLM and reviewer runtimes cannot produce', () => {
  for (const [actorType, actorId, pointer] of [
    ['llm', 'research-planner-llm', '/boundary_definition'],
    ['reviewer', 'research-quality-reviewer', '/coverage_checklist'],
  ] as const) {
    expectCompileError((value) => {
      value.candidate.steps[1] = {
        ...value.candidate.steps[1]!,
        actor_type: actorType,
        actor_id: actorId,
        expected_outputs: [{ pointer, description: 'invented runtime output' }],
      };
    }, 'invalid_actor_output_pointer', pointer);
  }
});

test('requires exactly one fixed runtime output for LLM and reviewer steps', () => {
  for (const [actorType, actorId, runtimePointer] of [
    ['llm', 'research-planner-llm', '/text'],
    ['reviewer', 'research-quality-reviewer', '/review'],
  ] as const) {
    expectCompileError((value) => {
      value.candidate.steps[1] = {
        ...value.candidate.steps[1]!,
        actor_type: actorType,
        actor_id: actorId,
        expected_outputs: [
          { pointer: runtimePointer, description: 'real runtime output' },
          { pointer: '/invented-extra', description: 'invented runtime output' },
        ],
      };
    }, 'invalid_actor_output_pointer', '/invented-extra');
  }
});

test('rejects unknown question references', () => {
  expectCompileError((value) => {
    value.candidate.steps[0]!.question_ids = ['question-missing'];
  }, 'unknown_question', 'question-missing');
});

test('rejects a graph that omits a required Core Evidence policy requirement', () => {
  expectCompileError((value) => {
    for (const question of value.problem_graph.questions) {
      question.evidence_requirements = [{
        id: 'dataset-only',
        acceptedClasses: ['dataset'],
        minimumCount: 1,
        required: true,
      }];
    }
  }, 'missing_core_evidence', 'public-source');
});

test('rejects an actor rejected by CapabilityResolver', () => {
  expectCompileError((value) => {
    value.candidate.steps[1]!.actor_id = 'rejected-skill';
  }, 'rejected_capability', 'rejected-skill');
});

test('rejects binding targets that traverse arrays before execution', () => {
  expectCompileError((value) => {
    value.candidate.steps[1]!.input = { sources: [null] };
    value.candidate.steps[1]!.input_bindings = [{
      target_pointer: '/sources/0',
      source_step_no: 1,
      source_pointer: '/results',
    }];
  }, 'invalid_binding_target', '/sources/0');
});

test('rejects binding targets containing prototype segments before execution', () => {
  expectCompileError((value) => {
    value.candidate.steps[1]!.input = { safe: { prototype: { value: null } } };
    value.candidate.steps[1]!.input_bindings = [{
      target_pointer: '/safe/prototype/value',
      source_step_no: 1,
      source_pointer: '/results',
    }];
  }, 'invalid_binding_target', '/safe/prototype/value');
});

test('rejects duplicate decoded binding targets before execution', () => {
  expectCompileError((value) => {
    value.candidate.steps[1]!.input = { sources: null };
    value.candidate.steps[1]!.input_bindings = [
      { target_pointer: '/sources', source_step_no: 1, source_pointer: '/results' },
      { target_pointer: '/sources', source_step_no: 1, source_pointer: '/results' },
    ];
  }, 'invalid_binding_target', '/sources');
});

test('rejects input bindings sourced from a registry-optional Tool', () => {
  expectCompileError((value) => {
    const optionalToolId = 'aesthetic-quant-lab';
    value.capability_resolution.eligible[0]!.skill.required_tools = [optionalToolId];
    value.candidate.steps[0]!.actor_id = optionalToolId;
  }, 'optional_binding_source', 'aesthetic-quant-lab');
});

test('rejects non-empty fallback actors until execution can dispatch them', () => {
  expectCompileError((value) => {
    value.candidate.steps[0]!.fallback_actor_ids = [eligibleSkill.id];
  }, 'invalid_fallback', eligibleSkill.id);
});

function approvalResolution(): CapabilityResolution {
  const resolution = capabilityResolution();
  return {
    ...resolution,
    eligible: [{
      ...resolution.eligible[0]!,
      skill: { ...resolution.eligible[0]!.skill, risk_level: 'high' },
      required_approvals: [
        { capability_type: 'skill', capability_id: eligibleSkill.id, authority: 'security' },
        { capability_type: 'tool', capability_id: 'tavily-web-search', authority: 'legal' },
      ],
    }],
  } as CapabilityResolution;
}

test('requires approval gates for every frozen high-risk Skill and Tool authority', () => {
  expectCompileError((value) => {
    value.capability_resolution = approvalResolution();
  }, 'approval_required', 'tavily-web-search');
});

test('rejects an approval role that differs from the frozen capability authority', () => {
  expectCompileError((value) => {
    value.capability_resolution = approvalResolution();
    value.candidate.steps[0]!.requires_approval = true;
    value.candidate.steps[0]!.approval_role = 'legal';
    value.candidate.steps[1]!.requires_approval = true;
    value.candidate.steps[1]!.approval_role = 'owner';
  }, 'approval_role_mismatch', eligibleSkill.id);
});

test('preserves exact approval roles when every frozen authority is satisfied', () => {
  const value = input();
  value.capability_resolution = approvalResolution();
  value.candidate.steps[0]!.requires_approval = true;
  value.candidate.steps[0]!.approval_role = 'legal';
  value.candidate.steps[1]!.requires_approval = true;
  value.candidate.steps[1]!.approval_role = 'security';

  const compiled = new PlanCompiler().compile(value);
  assert.deepEqual(compiled.plan.steps.map((item) => [item.actor_id, item.approval_role]), [
    ['tavily-web-search', 'legal'],
    [eligibleSkill.id, 'security'],
  ]);
});

test('requires one visible, ordered scoring-weight contract for competitive Web research', () => {
  const compiled = new PlanCompiler().compile(input());
  const skillInput = compiled.plan.steps.find(
    (item) => item.actor_type === 'skill' && item.actor_id === eligibleSkill.id,
  )?.input;
  assert.deepEqual(skillInput?.dimensions, comparisonDimensions);
  assert.deepEqual(skillInput?.scoring_weights, Object.fromEntries(
    comparisonDimensions.map((dimension) => [dimension, 0.2]),
  ));

  expectCompileError((value) => {
    delete value.candidate.steps[1]!.input.scoring_weights;
  }, 'competitive_weight_contract_invalid', 'chart_weights_missing');
  expectCompileError((value) => {
    value.candidate.steps[1]!.input.scoring_weights = {
      ...value.candidate.steps[1]!.input.scoring_weights as Record<string, number>,
      [comparisonDimensions[0]]: 0.4,
    };
  }, 'competitive_weight_contract_invalid', 'chart_weights_invalid');
  expectCompileError((value) => {
    value.candidate.steps[1]!.input.dimensions = [...comparisonDimensions].reverse();
  }, 'competitive_weight_contract_invalid', 'dimensions_mismatch');
  expectCompileError((value) => {
    const weights = value.candidate.steps[1]!.input.scoring_weights as Record<string, number>;
    value.candidate.steps[1]!.input.scoring_weights = Object.fromEntries(
      Object.entries(weights).reverse(),
    );
  }, 'competitive_weight_contract_invalid', 'scoring_weight_keys_mismatch');
  expectCompileError((value) => {
    value.candidate.steps.push({
      ...structuredClone(value.candidate.steps[1]!),
      step_no: 3,
    });
  }, 'competitive_weight_contract_invalid', 'chart_weights_step_ambiguous');
});

test('compiles exact depth and speed candidates, rebuilds numbering, freezes graph and decisions, and derives pending inputs', () => {
  const compiler = new PlanCompiler();
  const depth = compiler.compile(input(validCandidate('depth')));
  const speed = compiler.compile(input(validCandidate('speed')));

  for (const compiled of [depth, speed]) {
    assert.deepEqual(compiled.plan.steps.map((item) => item.step_no), [1, 2]);
    assert.deepEqual(compiled.plan.problem_graph, graph());
    assert.deepEqual(compiled.plan.capability_decisions, capabilityResolution());
    assert.deepEqual(compiled.plan.problem_graph_provenance, problemGraphProvenance);
    assert.deepEqual(compiled.plan.evidence_requirements, evidencePolicy);
    assert.deepEqual(compiled.plan.activated_nodes, ['D5_competitive']);
    assert.deepEqual(compiled.plan.capability_gaps, []);
    assert.deepEqual(
      compiled.plan.steps[1]?.input.scoring_weights,
      Object.fromEntries(comparisonDimensions.map((dimension) => [dimension, 0.2])),
    );
    assert.deepEqual(compiled.pending_inputs, [{
      kind: 'visual',
      role: 'competitor_screenshots',
      label: '竞品截图',
      multiple: true,
      targets: [{
        step_no: 2,
        tool_id: eligibleSkill.id,
        field: 'competitor_screenshots',
        multiple: true,
      }],
    }]);
  }
  assert.equal(depth.plan.candidate_metadata.title, '深度研究');
  assert.equal(speed.plan.candidate_metadata.title, '快速研究');
  assert.notDeepEqual(depth.plan.candidate_metadata, speed.plan.candidate_metadata);
  assert.equal('purpose' in depth.plan.steps[0]!, false);
});

test('revision recompilation preserves ProblemGraph receipt provenance in frozen equality', () => {
  const compiled = new PlanCompiler().compile(input());
  const plan = {
    ...compiled.plan,
    task_id: 'task-1',
    problem_graph_provenance: structuredClone(problemGraphProvenance),
  };

  const validated = validateCurrentPlanRevision({
    plan,
    task,
    pending_inputs: compiled.pending_inputs,
    task_id: 'task-1',
    candidate_id: 'depth',
  });
  assert.deepEqual(validated, plan);
});

test('revision normalization upgrades historical plans missing optional fields to empty arrays', () => {
  const compiled = new PlanCompiler().compile(input());
  const historicalPlan: CurrentExecutionPlan = {
    ...structuredClone(compiled.plan),
    task_id: 'task-legacy',
  };
  delete historicalPlan.capability_gaps;
  for (const bucket of [
    historicalPlan.capability_decisions.eligible,
    historicalPlan.capability_decisions.rejected,
  ]) {
    for (const decision of bucket) {
      delete decision.skill.optional_tools;
      delete decision.optional_tool_decisions;
    }
  }

  const normalized = validateCurrentPlanRevision({
    plan: historicalPlan,
    task,
    pending_inputs: compiled.pending_inputs,
    task_id: 'task-legacy',
    candidate_id: 'depth',
  });
  assert.deepEqual(normalized.capability_gaps, []);
  for (const decision of [
    ...normalized.capability_decisions.eligible,
    ...normalized.capability_decisions.rejected,
  ]) {
    assert.deepEqual(decision.skill.optional_tools, []);
    assert.deepEqual(decision.optional_tool_decisions, []);
  }
});

test('keeps Legacy PlanStep unchanged while Current steps use the strict independent contract', () => {
  const legacy: PlanCandidate = {
    id: 'depth',
    title: 'legacy',
    rationale: 'legacy',
    tradeoffs: 'legacy',
    assumptions: [],
    activated_nodes: [],
    steps: [{
      step_no: 1,
      step_name: 'legacy step',
      actor_type: 'llm',
      actor_id: 'legacy-llm',
      purpose: 'legacy purpose remains legal',
    }],
  };
  assert.equal(legacy.steps[0]?.purpose, 'legacy purpose remains legal');
});

interface CurrentResearchPlanningFixture {
  task: ResearchTaskData;
  structuredTask: ResearchTaskV2;
  activatedNodes: string[];
  decisionStates: [];
  candidates: CurrentPlanCandidateProposal[];
  guidanceSources: [];
  provenance: {
    modelName: string;
    modelVersion: string;
    promptHash: string;
    traceId: string;
  };
  problemGraph: ProblemGraph;
  problemGraphProvenance: {
    receiptId: string;
    modelName: string;
    modelVersion: string;
    promptHash: string;
    traceId: string;
  };
  capabilityResolution: CapabilityResolution;
}

interface PreparedCandidate {
  candidateId: 'depth' | 'speed';
  plan: Omit<CurrentExecutionPlan, 'task_id'> & { task_id?: '' };
  pendingInputs: PendingInput[];
}

function currentPlanningResult(candidate = validCandidate('depth')): CurrentResearchPlanningFixture {
  const problemGraph = graph();
  for (const question of problemGraph.questions) {
    question.evidence_requirements = [{
      id: 'competitive-analysis-report',
      acceptedClasses: ['public_source', 'screenshot'],
      minimumCount: 1,
      required: true,
    }];
  }
  return {
    task: {
      task_type: task.task_type,
      business_domain: task.business_domain,
      research_goal: task.research_goal,
      assumptions: task.assumptions,
      confirmations: task.clarification_questions,
      blocking_issues: task.blocking_issues,
      sensitivity: task.sensitivity,
      pii_detected: task.pii_detected,
    },
    structuredTask: task,
    activatedNodes: ['D5_competitive'],
    decisionStates: [],
    candidates: [candidate, validCandidate('speed')],
    guidanceSources: [],
    provenance: {
      modelName: 'fixture-model',
      modelVersion: '1',
      promptHash: 'sha256:fixture',
      traceId: 'trace-fixture',
    },
    problemGraph,
    problemGraphProvenance: structuredClone(problemGraphProvenance),
    capabilityResolution: capabilityResolution(),
  };
}

function planningServiceHarness(result: CurrentResearchPlanningFixture) {
  let repositoryCalls = 0;
  let persistedCandidates: PreparedCandidate[] = [];
  const service = new ControlPlanningService({
    planning: {
      async plan() { return result as never; },
    },
    conversations: {
      async create() { return { id: 'conversation-1' }; },
      async requireOwned(input) { return { id: input.conversationId }; },
    },
    repository: {
      async createTaskWithCandidates() { throw new Error('not used'); },
      async persistExistingTaskWithCandidates(input) {
        repositoryCalls += 1;
        persistedCandidates = structuredClone(input.candidates);
        return {
          task: {
            id: input.taskId,
            state: 'awaiting_selection' as const,
            stateVersion: 2,
            activePlanVersionId: null,
            currentAttemptId: null,
          },
          candidates: input.candidates.map((candidate, index) => ({
            id: `plan-${index + 1}`,
            taskId: input.taskId,
            version: index + 1,
            candidateId: candidate.candidateId,
            plan: { ...candidate.plan, task_id: input.taskId } as CurrentExecutionPlan,
            planHash: `sha256:${String(index + 1).repeat(64)}`,
            pendingInputs: candidate.pendingInputs,
          })),
        };
      },
    },
  });
  return {
    service,
    repositoryCalls: () => repositoryCalls,
    persistedCandidates: () => persistedCandidates,
  };
}

test('Current planning persists only compiled graph, capability decisions, exact steps, and pending inputs', async () => {
  const result = currentPlanningResult();
  const harness = planningServiceHarness(result);
  await harness.service.planExistingTask({
    taskId: 'task-1',
    conversationId: 'conversation-1',
    ownerUserId: 'owner-1',
    expectedStateVersion: 1,
    originalInput: task.research_goal,
  }, result as never);

  assert.equal(harness.repositoryCalls(), 1);
  for (const candidate of harness.persistedCandidates()) {
    assert.deepEqual(candidate.plan.problem_graph, result.problemGraph);
    assert.deepEqual(candidate.plan.problem_graph_provenance, result.problemGraphProvenance);
    assert.deepEqual(candidate.plan.capability_decisions, result.capabilityResolution);
    assert.deepEqual(candidate.plan.steps.map((item) => item.step_no), [1, 2]);
    assert.deepEqual(candidate.pendingInputs[0]?.targets, [{
      step_no: 2,
      tool_id: eligibleSkill.id,
      field: 'competitor_screenshots',
      multiple: true,
    }]);
  }
});

test('malformed LLM Current candidate never reaches the repository', async () => {
  const malformed = validCandidate('depth');
  malformed.steps[0]!.question_ids = ['question-hallucinated'];
  const result = currentPlanningResult(malformed);
  const harness = planningServiceHarness(result);

  await assert.rejects(() => harness.service.planExistingTask({
    taskId: 'task-1',
    conversationId: 'conversation-1',
    ownerUserId: 'owner-1',
    expectedStateVersion: 1,
    originalInput: task.research_goal,
  }, result as never), /question-hallucinated/);
  assert.equal(harness.repositoryCalls(), 0);
});

type CurrentCandidateFixtureMode =
  | 'missing-weights'
  | 'missing-tool'
  | 'unknown-binding'
  | 'input-prefixed-binding'
  | 'pseudo-step-zero'
  | 'invalid-actor-output'
  | 'object-assumptions'
  | 'string-assumptions'
  | 'over-limit-once'
  | 'over-limit-always'
  | 'orphan-question-twice'
  | 'exact-limit'
  | null;

class CurrentPlanningLLM implements LLMClient {
  readonly identity = {
    provider: 'current-planning-fixture',
    endpointHost: 'fixture.test',
    requestedModel: 'current-planning-model',
    mode: 'real' as const,
    eligibleAsReal: true,
  };
  readonly calls: StructuredLLMCallOptions[] = [];
  private candidateCalls = 0;

  constructor(private readonly candidateFixtureMode: CurrentCandidateFixtureMode = null) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    let data: unknown;
    if (options.schemaName === 'problem-graph') {
      const problemGraph = currentPlanningResult().problemGraph;
      const evidencePolicy = (options.context as { evidencePolicy?: unknown } | undefined)?.evidencePolicy;
      if (Array.isArray(evidencePolicy)) {
        for (const question of problemGraph.questions) {
          question.evidence_requirements = structuredClone(evidencePolicy) as EvidenceRequirement[];
        }
      }
      data = problemGraph;
    } else if (options.schemaName === 'decision-states') {
      data = [];
    } else if (options.schemaName === 'current-plan-candidates') {
      const validationFeedback = JSON.stringify(options.context);
      const resolution = (options.context as { capability_resolution?: CapabilityResolution } | undefined)
        ?.capability_resolution;
      const hasAvailablePlaywright = resolution?.eligible.some((decision) => (
        decision.optional_tool_decisions.some((optionalTool) => (
          optionalTool.tool_id === playwrightToolId && optionalTool.status === 'available'
        ))
      )) ?? false;
      const inputPrefixedBindingNeedsRepair = this.candidateFixtureMode === 'input-prefixed-binding'
        && (
          this.candidateCalls === 0
          || !/target_pointer is relative to step\.input.*use \/sources instead of \/input\/sources/u
            .test(validationFeedback)
        );
      const invalidActorOutputNeedsRepair = this.candidateFixtureMode === 'invalid-actor-output'
        && (
          this.candidateCalls === 0
          || !/invalid_actor_output_pointer.*llm.*\/boundary_definition.*\/text/u
            .test(validationFeedback)
        );
      const orphanQuestionNeedsRepair = this.candidateFixtureMode === 'orphan-question-twice'
        && this.candidateCalls < 2;
      const defect = this.candidateFixtureMode === 'over-limit-always'
        ? 'over-limit'
        : inputPrefixedBindingNeedsRepair
          ? 'input-prefixed-binding'
          : invalidActorOutputNeedsRepair
            ? 'invalid-actor-output'
            : orphanQuestionNeedsRepair
              ? 'orphan-question'
              : this.candidateCalls === 0
                ? this.candidateFixtureMode
                : null;
      this.candidateCalls += 1;
      const proposal = (id: 'depth' | 'speed') => {
        const { activated_nodes: _nodes, ...candidate } = hasAvailablePlaywright
          ? candidateWithBrowserCapture(id)
          : validCandidate(id);
        if (defect === 'missing-weights') {
          delete candidate.steps.find((candidateStep) => (
            candidateStep.actor_type === 'skill'
            && candidateStep.actor_id === eligibleSkill.id
          ))?.input.scoring_weights;
        }
        if (defect === 'missing-tool') {
          return {
            ...candidate,
            steps: candidate.steps
              .filter((step) => step.actor_type !== 'tool')
              .map((step) => ({ ...step, depends_on: [], input_bindings: [] })),
          };
        }
        if (defect === 'unknown-binding') {
          return {
            ...candidate,
            steps: candidate.steps.map((step) => step.actor_type === 'skill'
              ? { ...step, input_bindings: [{ ...step.input_bindings[0]!, target_pointer: '/missing' }] }
              : step),
          };
        }
        if (defect === 'input-prefixed-binding') {
          return {
            ...candidate,
            steps: candidate.steps.map((step) => step.actor_type === 'skill'
              ? {
                ...step,
                input_bindings: [{
                  ...step.input_bindings[0]!,
                  target_pointer: `/input${step.input_bindings[0]!.target_pointer}`,
                }],
              }
              : step),
          };
        }
        if (defect === 'pseudo-step-zero') {
          return {
            ...candidate,
            steps: candidate.steps.map((candidateStep) => candidateStep.actor_type === 'skill'
              ? {
                ...candidateStep,
                input_bindings: [
                  ...candidateStep.input_bindings,
                  {
                    target_pointer: '/research_goal',
                    source_step_no: 0,
                    source_pointer: '/planning_input',
                  },
                ],
              }
              : candidateStep),
          };
        }
        if (defect === 'invalid-actor-output') {
          return {
            ...candidate,
            steps: candidate.steps.map((candidateStep) => candidateStep.actor_type === 'skill'
              ? {
                ...candidateStep,
                actor_type: 'llm' as const,
                actor_id: 'current-planning-model',
                expected_outputs: [{
                  pointer: '/boundary_definition',
                  description: 'invented structured LLM output',
                }],
              }
              : candidateStep),
          };
        }
        if (defect === 'orphan-question') {
          return {
            ...candidate,
            steps: candidate.steps.map((candidateStep) => ({
              ...candidateStep,
              question_ids: candidateStep.question_ids.filter((questionId) => questionId !== 'question-action'),
            })),
          };
        }
        if (defect === 'object-assumptions' || defect === 'string-assumptions') {
          return {
            ...candidate,
            assumptions: defect === 'object-assumptions'
              ? { scope: 'must not be coerced' }
              : 'must not be coerced',
          };
        }
        if (defect === 'over-limit' || defect === 'over-limit-once' || defect === 'exact-limit') {
          const targetLengths = defect === 'exact-limit'
            ? { depth: 8, speed: 4 }
            : { depth: 9, speed: 5 };
          const targetLength = targetLengths[id];
          while (candidate.steps.length < targetLength) {
            const stepNo = candidate.steps.length + 1;
            candidate.steps.push(step({
              step_no: stepNo,
              step_name: `补充分析 ${stepNo}`,
              actor_type: 'llm',
              actor_id: 'current-planning-model',
              question_ids: ['question-action'],
              depends_on: [stepNo - 1],
              input: {},
              input_bindings: [],
              expected_outputs: [{ pointer: '/text', description: '补充分析' }],
              acceptance_criteria: ['形成补充分析'],
            }));
          }
        }
        return candidate;
      };
      data = { candidates: [proposal('depth'), proposal('speed')] };
    } else {
      throw new Error(`unexpected schema ${options.schemaName}`);
    }
    return {
      data: data as T,
      promptHash: `sha256:${options.schemaName}`,
      modelName: this.identity.requestedModel,
      modelVersion: '1',
      ...(options.schemaName === 'problem-graph'
        ? { receiptId: problemGraphProvenance.receiptId }
        : {}),
      traceId: `trace-${options.schemaName}`,
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('not used');
  }
}

function routedPlanningHarness(candidateFixtureMode: CurrentCandidateFixtureMode) {
  const llm = new CurrentPlanningLLM(candidateFixtureMode);
  const tools = new ToolRouter();
  tools.register({
    adapterType: 'tavily',
    implementationId: 'qualified-real-tavily',
    executionMode: 'real',
    endpointHost: () => 'tavily.fixture.test',
    async invoke() { throw new Error('not used during planning'); },
  });
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    tools,
    approvalAuthorities: ['owner'],
  } as never);
  return { llm, planning };
}

test('Current planning assembles Task8 graph and Task9 real-adapter capability shortlist before candidate generation', async () => {
  const llm = new CurrentPlanningLLM();
  const tools = new ToolRouter();
  const realTavily: ToolAdapter = {
    adapterType: 'tavily',
    implementationId: 'qualified-real-tavily',
    executionMode: 'real',
    endpointHost: () => 'tavily.fixture.test',
    async invoke() { throw new Error('not used during planning'); },
  };
  tools.register(realTavily);
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    tools,
    approvalAuthorities: ['owner'],
  } as never);

  const result = await (planning as ResearchPlanningService & {
    planCurrentFromRequirement(
      requirement: ResearchTaskV2,
      originalInput: string,
    ): Promise<CurrentResearchPlanningFixture>;
  }).planCurrentFromRequirement(task, task.research_goal);

  assert.equal(llm.calls[0]?.schemaName, 'decision-states');
  assert.ok(llm.calls.some((call) => call.schemaName === 'problem-graph'));
  const candidateCall = llm.calls.find((call) => call.schemaName === 'current-plan-candidates');
  assert.ok(candidateCall);
  assert.match(candidateCall.prompt, /fallback_actor_ids 必须为空数组/);
  assert.match(candidateCall.prompt, /统一输出根 \/payload/);
  assert.match(candidateCall.prompt, /目标槽必须预先存在于 step\.input/);
  assert.match(candidateCall.prompt, /optional Tool.*不得作为 input_bindings.*prior_outputs/);
  assert.match(candidateCall.prompt, /source_step_no.*必须 >= 1.*禁止把 planning_input 虚构成第 0 步/);
  assert.match(candidateCall.prompt, /每个 question\.id 必须至少出现在一个 step\.question_ids/);
  assert.match(candidateCall.prompt, /LLM step 的唯一运行时输出指针是 \/text.*reviewer step.*\/review/);
  assert.match(candidateCall.prompt, /depth 总步数不得超过 8，speed 总步数不得超过 4/);
  assert.match(candidateCall.prompt, /competitive-web-research.*scoring_weights/);
  const candidateContext = candidateCall.context as {
    problem_graph: ProblemGraph;
    capability_resolution: CapabilityResolution;
    skills: Array<{ id: string; output_root: string }>;
    planning_input: string;
  };
  assert.deepEqual(candidateContext.problem_graph, result.problemGraph);
  assert.deepEqual(candidateContext.capability_resolution, result.capabilityResolution);
  assert.equal(candidateContext.planning_input, task.research_goal);
  assert.ok(candidateContext.skills.some((skill) => skill.id === eligibleSkill.id));
  assert.ok(candidateContext.skills.every((skill) => skill.output_root === '/payload'));
  assert.ok(result.capabilityResolution.eligible.some((decision) => decision.skill.id === eligibleSkill.id));
  assert.ok(result.capabilityResolution.rejected.every((decision) =>
    result.candidates.every((candidate) =>
      candidate.steps.every((item) => item.actor_id !== decision.skill.id)
    )
  ));
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['depth', 'speed']);
  for (const candidate of result.candidates) {
    assert.deepEqual(
      candidate.steps.find((candidateStep) => candidateStep.actor_id === eligibleSkill.id)
        ?.input.scoring_weights,
      Object.fromEntries(comparisonDimensions.map((dimension) => [dimension, 0.2])),
    );
  }
});

test('Current routed planning freezes equal weights from explicit dimensions before validation', async () => {
  const { llm, planning } = routedPlanningHarness('missing-weights');

  const result = await planning.planCurrentFromRequirement(task, task.research_goal);

  assert.equal(llm.calls.filter((call) => call.schemaName === 'current-plan-candidates').length, 1);
  for (const candidate of result.candidates) {
    const skillInput = candidate.steps.find((candidateStep) => (
      candidateStep.actor_type === 'skill' && candidateStep.actor_id === eligibleSkill.id
    ))?.input;
    assert.deepEqual(skillInput?.dimensions, comparisonDimensions);
    assert.deepEqual(
      skillInput?.scoring_weights,
      Object.fromEntries(comparisonDimensions.map((dimension) => [dimension, 0.2])),
    );
  }
});

test('Current routed planning exposes the revision instruction to candidate generation', async () => {
  const { llm, planning } = routedPlanningHarness(null);
  const revisionInstruction = '将内容可信度权重提高到 30%，其余维度重新等比例分配';

  await planning.planCurrentFromRequirement(task, revisionInstruction);

  const candidateCall = llm.calls.find((call) => call.schemaName === 'current-plan-candidates');
  assert.equal(
    (candidateCall?.context as { planning_input?: unknown } | undefined)?.planning_input,
    revisionInstruction,
  );
});

test('Current planning retries once with complete Compiler feedback before returning candidates', async () => {
  for (const scenario of [
    { defect: 'missing-tool' as const, expectedFeedback: /(required_tool_missing|requires earlier tool).*tavily-web-search/ },
    { defect: 'unknown-binding' as const, expectedFeedback: /unknown_binding_target.*missing/ },
    {
      defect: 'input-prefixed-binding' as const,
      expectedFeedback: /target_pointer is relative to step\.input.*use \/sources instead of \/input\/sources/,
    },
    {
      defect: 'pseudo-step-zero' as const,
      expectedFeedback: /source_step_no must reference a real earlier step \(>= 1\).*planning_input.*pseudo step 0/,
    },
    {
      defect: 'invalid-actor-output' as const,
      expectedFeedback: /invalid_actor_output_pointer.*llm.*\/boundary_definition.*\/text/,
    },
  ]) {
    const llm = new CurrentPlanningLLM(scenario.defect);
    const tools = new ToolRouter();
    tools.register({
      adapterType: 'tavily',
      implementationId: 'qualified-real-tavily',
      executionMode: 'real',
      endpointHost: () => 'tavily.fixture.test',
      async invoke() { throw new Error('not used during planning'); },
    });
    const planning = new ResearchPlanningService({
      llm,
      validator: new SchemaValidator(),
      skillLoader: new SkillLoader(),
      tools,
      approvalAuthorities: ['owner'],
    } as never);

    const result = await planning.planCurrentFromRequirement(task, task.research_goal);
    const candidateCalls = llm.calls.filter((call) => call.schemaName === 'current-plan-candidates');
    assert.equal(candidateCalls.length, 2);
    assert.match(JSON.stringify(candidateCalls[1]?.context), scenario.expectedFeedback);
    const compiler = new PlanCompiler();
    for (const candidate of result.candidates) {
      assert.doesNotThrow(() => compiler.compile({
        candidate,
        task,
        problem_graph: result.problemGraph,
        problem_graph_provenance: result.problemGraphProvenance,
        capability_resolution: result.capabilityResolution,
        evidence_requirements: currentPlanningResult().problemGraph.questions[0]!.evidence_requirements,
        activated_nodes: result.activatedNodes,
        requireCompetitiveWeightContract: true,
      }));
    }
  }
});

test('Current routed planning repairs candidates that exceed the depth/speed step limits', async () => {
  const { llm, planning } = routedPlanningHarness('over-limit-once');

  const result = await planning.planCurrentFromRequirement(task, task.research_goal);
  const candidateCalls = llm.calls.filter((call) => call.schemaName === 'current-plan-candidates');
  assert.equal(candidateCalls.length, 2);
  assert.match(JSON.stringify(candidateCalls[1]?.context), /depth: routed_step_limit_exceeded: actual=9, max=8/);
  assert.match(JSON.stringify(candidateCalls[1]?.context), /speed: routed_step_limit_exceeded: actual=5, max=4/);
  assert.deepEqual(result.candidates.map((candidate) => candidate.steps.length), [2, 2]);
});

test('Current routed planning allows one extra targeted repair for orphaned required questions', async () => {
  const { llm, planning } = routedPlanningHarness('orphan-question-twice');

  const result = await planning.planCurrentFromRequirement(task, task.research_goal);
  const candidateCalls = llm.calls.filter((call) => call.schemaName === 'current-plan-candidates');
  assert.equal(candidateCalls.length, 3);
  assert.match(JSON.stringify(candidateCalls[1]?.context), /orphan_required_question.*question-action/);
  assert.match(JSON.stringify(candidateCalls[2]?.context), /orphan_required_question.*question-action/);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['depth', 'speed']);
});

test('Current routed planning rejects non-array assumptions instead of coercing provider output', async () => {
  for (const fixtureMode of ['object-assumptions', 'string-assumptions'] as const) {
    const { llm, planning } = routedPlanningHarness(fixtureMode);

    await assert.rejects(
      () => planning.planCurrentFromRequirement(task, task.research_goal),
      /assumptions.*array|array.*assumptions/iu,
    );
    assert.equal(llm.calls.filter((call) => call.schemaName === 'current-plan-candidates').length, 1);
  }
});

test('Current routed planning fails closed when repaired candidates still exceed step limits', async () => {
  const { llm, planning } = routedPlanningHarness('over-limit-always');

  await assert.rejects(
    () => planning.planCurrentFromRequirement(task, task.research_goal),
    /failed candidate validation repair: depth: routed_step_limit_exceeded: actual=9, max=8; speed: routed_step_limit_exceeded: actual=5, max=4/,
  );
  assert.equal(llm.calls.filter((call) => call.schemaName === 'current-plan-candidates').length, 2);
});

test('Current routed planning accepts candidates exactly at the depth/speed step limits', async () => {
  const { llm, planning } = routedPlanningHarness('exact-limit');

  const result = await planning.planCurrentFromRequirement(task, task.research_goal);
  assert.equal(llm.calls.filter((call) => call.schemaName === 'current-plan-candidates').length, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.steps.length), [8, 4]);
});

test('finalized Current direct skill builds deterministic strict depth/speed proposals without candidate LLM routing', async () => {
  const llm = new CurrentPlanningLLM();
  const tools = new ToolRouter();
  tools.register({
    adapterType: 'tavily',
    implementationId: 'qualified-real-tavily',
    executionMode: 'real',
    endpointHost: () => 'tavily.fixture.test',
    async invoke() { throw new Error('not used during planning'); },
  });
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    tools,
    approvalAuthorities: ['owner'],
  });

  const result = await planning.planCurrentFromRequirement(
    task,
    `$competitive-web-research ${task.research_goal}`,
  );

  assert.equal(llm.calls.some((call) => call.schemaName === 'current-plan-candidates'), false);
  assert.deepEqual(
    result.candidates.find((candidate) => candidate.id === 'speed')?.steps.map((item) => item.actor_type),
    ['tool', 'skill'],
  );
  assert.deepEqual(
    result.candidates.find((candidate) => candidate.id === 'depth')?.steps.map((item) => item.actor_type),
    ['tool', 'skill', 'reviewer'],
  );
  for (const candidate of result.candidates) {
    const skillInput = candidate.steps.find((item) => item.actor_id === eligibleSkill.id)?.input;
    assert.deepEqual(skillInput?.dimensions, comparisonDimensions);
    assert.deepEqual(
      skillInput?.scoring_weights,
      Object.fromEntries(comparisonDimensions.map((dimension) => [dimension, 0.2])),
    );
  }
  const compiler = new PlanCompiler();
  for (const candidate of result.candidates) {
    assert.doesNotThrow(() => compiler.compile({
      candidate,
      task,
      problem_graph: result.problemGraph,
      problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: currentPlanningResult().problemGraph.questions[0]!.evidence_requirements,
      activated_nodes: result.activatedNodes,
      requireCompetitiveWeightContract: true,
    }));
  }
});

test('Current direct planning freezes explicit user percentages instead of replacing them with equal weights', async () => {
  const percentages = [30, 25, 20, 15, 10];
  const weightedTask: ResearchTaskV2 = {
    ...task,
    constraints: [
      ...task.constraints,
      {
        id: 'explicit-weights',
        source: 'user',
        statement: `评分权重：${comparisonDimensions.map((dimension, index) => (
          `${dimension}${percentages[index]}%`
        )).join('、')}`,
      },
    ],
  };
  const expectedWeights = Object.fromEntries(comparisonDimensions.map((dimension, index) => [
    dimension,
    percentages[index]! / 100,
  ]));
  const { llm, planning } = routedPlanningHarness(null);

  const result = await planning.planCurrentFromRequirement(
    weightedTask,
    `$competitive-web-research ${weightedTask.research_goal}`,
  );

  assert.equal(llm.calls.some((call) => call.schemaName === 'current-plan-candidates'), false);
  for (const candidate of result.candidates) {
    const skillInput = candidate.steps.find((item) => item.actor_id === eligibleSkill.id)?.input;
    assert.deepEqual(skillInput?.scoring_weights, expectedWeights);
  }
});

test('active qualified Playwright is planned as Tavily then capture then Skill in routed and direct Current plans', async () => {
  const realRoot = getConfigRoot();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'active-playwright-planning-'));
  cpSync(join(realRoot, 'orchestrator'), join(fixtureRoot, 'orchestrator'), { recursive: true });
  cpSync(join(realRoot, 'schemas'), join(fixtureRoot, 'schemas'), { recursive: true });
  cpSync(join(realRoot, 'tools'), join(fixtureRoot, 'tools'), { recursive: true });
  const registryPath = join(fixtureRoot, 'orchestrator', 'tool-registry.yaml');
  const draftRegistry = readFileSync(registryPath, 'utf8');
  const activeRegistry = draftRegistry.replace(
    /(  - id: playwright-page-capture[\s\S]*?\n    status:) draft(\n    tier: optional)/u,
    '$1 active$2',
  );
  assert.notEqual(activeRegistry, draftRegistry, 'fixture must activate only Playwright');
  writeFileSync(registryPath, activeRegistry, 'utf8');

  try {
    setConfigRoot(fixtureRoot);
    const llm = new CurrentPlanningLLM();
    const tools = new ToolRouter();
    for (const adapterType of ['tavily', 'playwright'] as const) {
      tools.register({
        adapterType,
        implementationId: `qualified-real-${adapterType}`,
        executionMode: 'real',
        endpointHost: () => `${adapterType}.fixture.test`,
        async invoke() { throw new Error('not used during planning'); },
      });
    }
    const planning = new ResearchPlanningService({
      llm,
      validator: new SchemaValidator(),
      skillLoader: new SkillLoader(),
      tools,
      approvalAuthorities: ['owner'],
    });

    const routed = await planning.planCurrentFromRequirement(task, task.research_goal);
    const direct = await planning.planCurrentFromRequirement(
      task,
      `$competitive-web-research ${task.research_goal}`,
    );

    for (const result of [routed, direct]) {
      const decision = result.capabilityResolution.eligible.find(({ skill }) => (
        skill.id === eligibleSkill.id
      ));
      assert.deepEqual(decision?.optional_tool_decisions, [{
        tool_id: playwrightToolId,
        status: 'available',
      }]);
      for (const candidate of result.candidates) {
        const actorIds = candidate.steps.map(({ actor_id }) => actor_id);
        const tavilyIndex = actorIds.indexOf('tavily-web-search');
        const captureIndex = actorIds.indexOf(playwrightToolId);
        const skillIndex = actorIds.indexOf(eligibleSkill.id);
        assert.ok(tavilyIndex >= 0 && tavilyIndex < captureIndex && captureIndex < skillIndex);
        assert.equal(candidate.steps[tavilyIndex]?.input.max_results, 12);
        assert.deepEqual(candidate.steps[captureIndex]?.input.pages, []);
        assert.deepEqual(candidate.steps[captureIndex]?.input_bindings, [{
          target_pointer: '/pages',
          source_step_no: tavilyIndex + 1,
          source_pointer: '/results',
        }]);
      }
    }

    const routedCall = llm.calls.find((call) => call.schemaName === 'current-plan-candidates');
    assert.match(routedCall?.prompt ?? '', /playwright-page-capture.*禁止手写 URL/u);
    assert.match(routedCall?.prompt ?? '', /max_pages.*两倍.*备用候选/u);
  } finally {
    setConfigRoot(realRoot);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Current direct competitive Web research stays plannable when no comparison dimensions were explicit', async () => {
  const llm = new CurrentPlanningLLM();
  const tools = new ToolRouter();
  tools.register({
    adapterType: 'tavily',
    implementationId: 'qualified-real-tavily',
    executionMode: 'real',
    endpointHost: () => 'tavily.fixture.test',
    async invoke() { throw new Error('not used during planning'); },
  });
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    tools,
    approvalAuthorities: ['owner'],
  });
  const requirement = structuredClone(task);
  delete requirement.comparison_dimensions;

  const result = await planning.planCurrentFromRequirement(
    requirement,
    `$competitive-web-research ${requirement.research_goal}`,
  );

  for (const candidate of result.candidates) {
    const skillInput = candidate.steps.find((item) => item.actor_id === eligibleSkill.id)?.input;
    assert.equal(Object.hasOwn(skillInput ?? {}, 'dimensions'), false);
    assert.equal(Object.hasOwn(skillInput ?? {}, 'scoring_weights'), false);
    assert.doesNotThrow(() => new PlanCompiler().compile({
      candidate,
      task: requirement,
      problem_graph: result.problemGraph,
      problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: currentPlanningResult().problemGraph.questions[0]!.evidence_requirements,
      activated_nodes: result.activatedNodes,
      requireCompetitiveWeightContract: true,
    }));
  }
});

test('direct screenshot Skill exposes missing screenshot roles as pending inputs', async () => {
  const llm = new CurrentPlanningLLM();
  const tools = new ToolRouter();
  for (const adapterType of ['tavily', 'internal_api', 'rest_json'] as const) {
    tools.register({
      adapterType,
      implementationId: `qualified-real-${adapterType}`,
      executionMode: 'real',
      endpointHost: () => `${adapterType}.fixture.test`,
      async invoke() { throw new Error('not used during planning'); },
    });
  }
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    tools,
    approvalAuthorities: ['owner'],
  });

  const result = await planning.planCurrentFromRequirement(
    task,
    `$competitive-app-analysis ${task.research_goal}`,
  );
  const compiler = new PlanCompiler();
  for (const candidate of result.candidates) {
    const compiled = compiler.compile({
      candidate,
      task,
      problem_graph: result.problemGraph,
      problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: currentPlanningResult().problemGraph.questions[0]!.evidence_requirements,
      activated_nodes: result.activatedNodes,
    });
    assert.ok(Object.hasOwn(
      candidate.steps.find((step) => step.actor_id === 'competitive-app-analysis')?.input ?? {},
      'competitor_screenshots',
    ));
    assert.deepEqual(compiled.pending_inputs.map((input) => input.role), ['competitor_screenshots']);
    assert.deepEqual(compiled.pending_inputs.map((input) => input.kind), ['visual']);
    assert.deepEqual(compiled.pending_inputs.map((input) => input.multiple), [true]);
  }
});

test('fans one sealed design input out to every declared visual Tool field', async () => {
  const designTask: ResearchTaskV2 = {
    ...structuredClone(task),
    task_type: 'design_audit',
    research_goal: '走查商品详情页设计稿的视觉层级、注意力与品牌一致性',
    expected_deliverables: ['design audit report'],
  };
  const tools = new ToolRouter();
  for (const adapterType of ['tavily', 'rest_json'] as const) {
    tools.register({
      adapterType,
      implementationId: `qualified-real-${adapterType}`,
      executionMode: 'real',
      endpointHost: () => `${adapterType}.fixture.test`,
      async invoke() { throw new Error('not used during planning'); },
    });
  }
  const planning = new ResearchPlanningService({
    llm: new CurrentPlanningLLM(),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    tools,
    approvalAuthorities: ['owner'],
  });
  const result = await planning.planCurrentFromRequirement(
    designTask,
    `$design-experience-review ${designTask.research_goal}`,
  );
  const selection = resolvePlanningDeliverableSelection(designTask);
  result.problemGraph.questions[0]!.evidence_requirements = structuredClone(selection.evidenceRequirements);
  for (const candidate of result.candidates) {
    const compiled = new PlanCompiler().compile({
      candidate,
      task: designTask,
      deliverable_selection: selection,
      problem_graph: result.problemGraph,
      problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: selection.evidenceRequirements,
      activated_nodes: result.activatedNodes,
    });
    const input = compiled.pending_inputs.find(({ role }) => role === 'designImage');
    assert.ok(input);
    assert.equal(input.kind, 'visual');
    assert.deepEqual(
      input.targets.map(({ tool_id, field, multiple }) => ({ tool_id, field, multiple })),
      [
        { tool_id: 'design-experience-review', field: 'designImage', multiple: false },
        { tool_id: 'aesthetic-quant-lab', field: 'designImage', multiple: false },
        { tool_id: 'attention-analysis-lab', field: 'image', multiple: false },
        { tool_id: 'vision-brand-lab', field: 'designImages', multiple: true },
      ],
    );
  }
});

test('direct Current depth and speed prepend every required Tool with remapped strict steps', async () => {
  const llm = new CurrentPlanningLLM();
  const skillLoader = new SkillLoader();
  const tools = new ToolRouter();
  for (const adapterType of ['tavily', 'internal_api', 'rest_json'] as const) {
    tools.register({
      adapterType,
      implementationId: `qualified-real-${adapterType}`,
      executionMode: 'real',
      endpointHost: () => `${adapterType}.fixture.test`,
      async invoke() { throw new Error('not used during planning'); },
    });
  }
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader,
    tools,
    approvalAuthorities: ['owner'],
  });

  const result = await planning.planCurrentFromRequirement(
    task,
    `$digital-human-competitive-analysis ${task.research_goal}`,
  );

  assert.equal(llm.calls.some((call) => call.schemaName === 'current-plan-candidates'), false);
  const directSkill = skillLoader.getSkill('digital-human-competitive-analysis');
  assert.ok(directSkill);
  assert.ok(directSkill.input_schema);
  assert.equal(
    result.capabilityResolution.eligible.find((decision) => decision.skill.id === directSkill.id)?.skill.payload_schema,
    directSkill.payload_schema,
  );
  const requiredToolIds = directSkill.required_tools ?? [];
  assert.deepEqual(requiredToolIds, [
    'tavily-web-search',
    'ai-spider-search',
    'experience-model-lab',
    'virtual-user-lab',
  ]);
  assert.equal(result.candidates.find((candidate) => candidate.id === 'depth')?.steps.length, 6);
  assert.equal(result.candidates.find((candidate) => candidate.id === 'speed')?.steps.length, 5);
  const compiler = new PlanCompiler();
  const validator = new SchemaValidator();

  for (const candidateId of ['depth', 'speed'] as const) {
    const candidate = result.candidates.find((item) => item.id === candidateId);
    assert.ok(candidate);
    const compiled = compiler.compile({
      candidate,
      task,
      problem_graph: result.problemGraph,
      problem_graph_provenance: result.problemGraphProvenance,
      capability_resolution: result.capabilityResolution,
      evidence_requirements: result.problemGraph.questions[0]!.evidence_requirements,
      activated_nodes: result.activatedNodes,
    });
    const steps = compiled.plan.steps;
    const skillStepNo = requiredToolIds.length + 1;
    assert.deepEqual(steps.map((item) => item.step_no),
      Array.from({ length: steps.length }, (_, index) => index + 1));
    assert.deepEqual(steps.slice(0, requiredToolIds.length).map((item) => item.actor_id), requiredToolIds);

    for (const toolStep of steps.slice(0, requiredToolIds.length)) {
      assert.equal(toolStep.actor_type, 'tool');
      const tool = skillLoader.getTool(toolStep.actor_id);
      assert.ok(tool);
      const manifest = loadToolManifest(tool.path);
      validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolStep.input);
    }

    const skillStep = steps[skillStepNo - 1];
    assert.ok(skillStep);
    assert.equal(skillStep.actor_type, 'skill');
    assert.equal(skillStep.actor_id, directSkill.id);
    assert.deepEqual(skillStep.expected_outputs.map((output) => output.pointer), ['/payload']);
    assert.deepEqual(skillStep.depends_on, requiredToolIds.map((_, index) => index + 1));
    assert.deepEqual(skillStep.input_bindings, []);
    validator.validateFileOrThrow(join(getConfigRoot(), directSkill.input_schema), skillStep.input);

    const reviewers = steps.filter((item) => item.actor_type === 'reviewer');
    assert.equal(reviewers.length, candidateId === 'depth' ? 1 : 0);
    if (candidateId === 'depth') {
      const reviewer = reviewers[0]!;
      assert.equal(reviewer.step_no, skillStepNo + 1);
      assert.deepEqual(reviewer.depends_on, [skillStepNo]);
      assert.deepEqual(reviewer.input_bindings, []);
      assert.ok(!skillStep.expected_outputs.some((output) => output.pointer === '/result'));
    }
  }
});
