import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import {
  getConfigRoot,
  setConfigRoot,
  type ToolManifest,
  type ToolRegistryEntry,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  resolveCapabilities,
  type CapabilityApproval,
  type CapabilityResolveInput,
  type CapabilitySkillRegistryEntry,
  type CapabilityToolState,
} from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

const task: ResearchTaskV2 = {
  version: 'research-task-v2',
  task_type: 'competitive_research',
  business_domain: 'live_commerce',
  research_goal: '比较直播数字人竞品',
  target_audience: ['产品团队'],
  scope: ['公开资料'],
  constraints: [],
  success_criteria: [{ id: 'criterion-1', statement: '形成有来源的竞品结论' }],
  expected_deliverables: ['research_report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};

function skill(overrides: Partial<CapabilitySkillRegistryEntry> = {}): CapabilitySkillRegistryEntry {
  return {
    id: 'competitive-web-research',
    name: '竞品分析·Web搜索',
    path: 'skills/competitive-analysis/web-research/SKILL.md',
    when_to_use: '公开资料竞品分析',
    owner: '竞品分析组',
    status: 'active',
    task_types: ['competitive_research'],
    inputs: ['research_goal'],
    outputs: ['competitive_analysis'],
    required_tools: ['tavily-web-search'],
    optional_tools: [],
    risk_level: 'low',
    ...overrides,
  };
}

function tool(overrides: Partial<ToolRegistryEntry> = {}): ToolRegistryEntry {
  return {
    id: 'tavily-web-search',
    name: 'Tavily 网页检索',
    path: 'tools/tavily-web-search/manifest.yaml',
    adapter_type: 'tavily',
    auth_required: true,
    risk_level: 'low',
    status: 'active',
    tier: 'core',
    ...overrides,
  };
}

function toolManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id: 'tavily-web-search',
    name: 'Tavily 网页检索',
    adapter_type: 'tavily',
    auth_required: true,
    risk_level: 'low',
    approver_rule: 'none',
    input_schema: 'tools/tavily-web-search/input.schema.json',
    output_schema: 'tools/tavily-web-search/output.schema.json',
    ...overrides,
  };
}

function toolState(overrides: Partial<CapabilityToolState> = {}): CapabilityToolState {
  return {
    tool_id: 'tavily-web-search',
    health: 'healthy',
    real_adapter_qualified: true,
    ...overrides,
  };
}

function input(overrides: Partial<CapabilityResolveInput> = {}): CapabilityResolveInput {
  return {
    task,
    available_input_roles: ['research_goal'],
    skills: [skill()],
    tools: [tool()],
    tool_states: [toolState()],
    tool_manifests: [toolManifest()],
    approval_capabilities: [],
    ...overrides,
  };
}

function reasonCodes(decision: { reasons: Array<{ code: string }> }): string[] {
  return decision.reasons.map((reason) => reason.code);
}

test('rejects inactive skills and task type mismatches with explicit reasons', () => {
  const resolution = resolveCapabilities(input({
    skills: [
      skill({ id: 'inactive', status: 'draft' }),
      skill({ id: 'wrong-task', task_types: ['design_audit'] }),
    ],
  }));

  assert.deepEqual(resolution.eligible, []);
  assert.deepEqual(resolution.rejected.map((decision) => decision.skill.id), ['inactive', 'wrong-task']);
  assert.deepEqual(reasonCodes(resolution.rejected[0]!), ['skill_inactive']);
  assert.deepEqual(reasonCodes(resolution.rejected[1]!), ['task_type_mismatch']);
});

test('rejects missing and inactive required tools without silently dropping either skill', () => {
  const resolution = resolveCapabilities(input({
    skills: [
      skill({ id: 'missing-tool-skill', required_tools: ['missing-tool'] }),
      skill({ id: 'inactive-tool-skill', required_tools: ['inactive-tool'] }),
    ],
    tools: [tool({ id: 'inactive-tool', status: 'draft', tier: 'optional' })],
    tool_states: [],
  }));

  assert.deepEqual(resolution.rejected.map((decision) => decision.skill.id), [
    'missing-tool-skill',
    'inactive-tool-skill',
  ]);
  assert.deepEqual(reasonCodes(resolution.rejected[0]!), ['required_tool_missing']);
  assert.deepEqual(reasonCodes(resolution.rejected[1]!), ['required_tool_inactive']);
});

test('rejects unhealthy required tools and core tools without a qualified real adapter', () => {
  const resolution = resolveCapabilities(input({
    skills: [
      skill({ id: 'unhealthy-tool-skill', required_tools: ['unhealthy-tool'] }),
      skill({ id: 'fake-core-skill', required_tools: ['fake-core-tool'] }),
    ],
    tools: [
      tool({ id: 'unhealthy-tool', tier: 'optional' }),
      tool({ id: 'fake-core-tool', tier: 'core' }),
    ],
    tool_states: [
      toolState({ tool_id: 'unhealthy-tool', health: 'unhealthy' }),
      toolState({ tool_id: 'fake-core-tool', real_adapter_qualified: false }),
    ],
  }));

  assert.deepEqual(reasonCodes(resolution.rejected[0]!), ['required_tool_unhealthy']);
  assert.deepEqual(reasonCodes(resolution.rejected[1]!), ['core_tool_real_adapter_unavailable']);
});

test('ignores draft optional tools and freezes active optional availability without rejecting the skill', () => {
  const optionalTool = tool({
    id: 'playwright-page-capture',
    status: 'draft',
    tier: 'optional',
  });
  const draft = resolveCapabilities(input({
    skills: [skill({ optional_tools: [optionalTool.id] })],
    tools: [tool(), optionalTool],
  }));
  assert.equal(draft.rejected.length, 0);
  assert.deepEqual(draft.eligible[0]?.optional_tool_decisions, []);

  const activeTool = { ...optionalTool, status: 'active' as const };
  const available = resolveCapabilities(input({
    skills: [skill({ optional_tools: [activeTool.id] })],
    tools: [tool(), activeTool],
    tool_states: [toolState(), toolState({
      tool_id: activeTool.id,
      real_adapter_qualified: true,
    })],
  }));
  assert.equal(available.rejected.length, 0);
  assert.deepEqual(available.eligible[0]?.optional_tool_decisions, [{
    tool_id: activeTool.id,
    status: 'available',
  }]);
});

test('records one sanitized unavailable decision for each active optional tool failure mode', () => {
  const optionalTool = tool({
    id: 'playwright-page-capture',
    status: 'active',
    tier: 'optional',
  });
  const cases = [
    {
      states: [toolState()],
      code: 'optional_tool_health_unknown',
    },
    {
      states: [toolState(), toolState({ tool_id: optionalTool.id, health: 'unhealthy' })],
      code: 'optional_tool_unhealthy',
    },
    {
      states: [toolState(), toolState({ tool_id: optionalTool.id, real_adapter_qualified: false })],
      code: 'optional_tool_real_adapter_unavailable',
    },
  ] as const;

  for (const failureCase of cases) {
    const resolution = resolveCapabilities(input({
      skills: [skill({ optional_tools: [optionalTool.id] })],
      tools: [tool(), optionalTool],
      tool_states: failureCase.states,
    }));
    assert.equal(resolution.rejected.length, 0);
    const [decision] = resolution.eligible[0]?.optional_tool_decisions ?? [];
    assert.equal(decision?.tool_id, optionalTool.id);
    assert.equal(decision?.status, 'unavailable');
    assert.equal(decision?.reason_code, failureCase.code);
    assert.ok(decision?.message);
  }
});

test('keeps a skill eligible when missing inputs can become PendingInput records', () => {
  const resolution = resolveCapabilities(input({
    available_input_roles: ['research_goal'],
    skills: [skill({ inputs: ['research_goal', 'competitor_screenshots'] })],
  }));

  assert.equal(resolution.rejected.length, 0);
  assert.equal(resolution.eligible.length, 1);
  assert.deepEqual(resolution.eligible[0]?.pending_inputs, [{
    kind: 'value',
    role: 'competitor_screenshots',
    label: 'competitor_screenshots',
    multiple: false,
    capability_id: 'competitive-web-research',
  }]);
  assert.deepEqual(reasonCodes(resolution.eligible[0]!), ['pending_input_required', 'eligible']);
});

test('preserves explicitly plural visual input cardinality', () => {
  const resolution = resolveCapabilities(input({
    available_input_roles: ['research_goal'],
    skills: [skill({
      inputs: ['research_goal', 'competitor_screenshots'],
      visual_inputs: ['competitor_screenshots'],
      multiple_visual_inputs: ['competitor_screenshots'],
    })],
  }));

  assert.deepEqual(resolution.eligible[0]?.pending_inputs, [{
    kind: 'visual',
    role: 'competitor_screenshots',
    label: 'competitor_screenshots',
    multiple: true,
    capability_id: 'competitive-web-research',
  }]);
});

test('preserves a single-file dataset PendingInput kind', () => {
  const resolution = resolveCapabilities(input({
    available_input_roles: ['research_goal'],
    skills: [skill({
      inputs: ['research_goal', 'user_research_dataset'],
      dataset_inputs: ['user_research_dataset'],
    })],
  }));

  assert.deepEqual(resolution.eligible[0]?.pending_inputs, [{
    kind: 'dataset',
    role: 'user_research_dataset',
    label: 'user_research_dataset',
    multiple: false,
    capability_id: 'competitive-web-research',
  }]);
});

test('Industry material declarations create pending inputs only for available optional roles', () => {
  const resolution = resolveCapabilities(input({
    task: {
      ...task,
      task_type: 'industry_market_analysis',
      expected_deliverables: ['industry_market_analysis_report'],
      industry_scope: {
        category: '宠物食品', subcategories: [], exclusions: [], analysis_depth: 'medium',
        primary_focus: '用户洞察', secondary_focuses: [], decision_audience: ['产品团队'],
        decision_goal: '形成用户策略', time_window: '最近十二个月',
      },
      available_material_roles: ['user_research_dataset'],
      unavailable_material_roles: ['internal_metrics_dataset'],
    },
    skills: [skill({
      id: 'industry-market-analysis',
      task_types: ['industry_market_analysis'],
      inputs: ['research_goal'],
      dataset_inputs: ['user_research_dataset', 'internal_metrics_dataset'],
      composition: {
        modes: ['standalone'],
        supported_outcomes: ['answer'],
        compatible_deliverables: ['industry_market_analysis_report'],
        required_input_roles: ['research_goal'],
        optional_input_roles: ['user_research_dataset', 'internal_metrics_dataset'],
        standalone_reason: 'single Skill release',
      },
    })],
  }));

  assert.deepEqual(resolution.eligible[0]?.pending_inputs, [{
    kind: 'dataset', role: 'user_research_dataset', label: 'user_research_dataset',
    multiple: false, capability_id: 'industry-market-analysis',
  }]);
});

test('rejects high-risk skills when no matching approval capability exists', () => {
  const denied = resolveCapabilities(input({
    skills: [skill({ risk_level: 'high' })],
  }));
  assert.deepEqual(reasonCodes(denied.rejected[0]!), ['approval_unavailable']);

  const approval: CapabilityApproval = {
    capability_type: 'skill',
    capability_id: 'competitive-web-research',
    authority: 'security',
  };
  const allowed = resolveCapabilities(input({
    skills: [skill({ risk_level: 'high' })],
    approval_capabilities: [approval],
  }));
  assert.deepEqual(reasonCodes(allowed.eligible[0]!), ['eligible']);
});

test('requires a high-risk tool approval capability to match its manifest authority', () => {
  const highRiskTool = tool({ risk_level: 'high' });
  const legalManifest = toolManifest({ risk_level: 'high', approver_rule: 'legal' });
  const wrongAuthority = resolveCapabilities(input({
    tools: [highRiskTool],
    tool_manifests: [legalManifest],
    approval_capabilities: [{
      capability_type: 'tool',
      capability_id: highRiskTool.id,
      authority: 'owner',
    }],
  }));
  assert.deepEqual(reasonCodes(wrongAuthority.rejected[0]!), ['approval_unavailable']);

  const matchingAuthority = resolveCapabilities(input({
    tools: [highRiskTool],
    tool_manifests: [legalManifest],
    approval_capabilities: [{
      capability_type: 'tool',
      capability_id: highRiskTool.id,
      authority: 'legal',
    }],
  }));
  assert.deepEqual(reasonCodes(matchingAuthority.eligible[0]!), ['eligible']);
});

test('freezes exact high-risk Skill and required Tool approval authorities in the eligible decision', () => {
  const approvals: CapabilityApproval[] = [
    {
      capability_type: 'skill',
      capability_id: 'competitive-web-research',
      authority: 'security',
    },
    {
      capability_type: 'tool',
      capability_id: 'tavily-web-search',
      authority: 'legal',
    },
  ];
  const resolution = resolveCapabilities(input({
    skills: [skill({ risk_level: 'high' })],
    tools: [tool({ risk_level: 'high' })],
    tool_manifests: [toolManifest({ risk_level: 'high', approver_rule: 'legal' })],
    approval_capabilities: approvals,
  }));

  assert.equal(resolution.rejected.length, 0);
  assert.deepEqual(resolution.eligible[0]?.required_approvals, approvals);
});

test('returns explicit eligible and rejected reasons deterministically', () => {
  const resolveInput = input({
    skills: [
      skill({ id: 'eligible-skill' }),
      skill({ id: 'rejected-skill', task_types: ['design_audit'] }),
    ],
  });

  const first = resolveCapabilities(resolveInput);
  const second = resolveCapabilities(resolveInput);

  assert.deepEqual(second, first);
  assert.deepEqual(first.eligible.map((decision) => decision.skill.id), ['eligible-skill']);
  assert.deepEqual(first.rejected.map((decision) => decision.skill.id), ['rejected-skill']);
  for (const decision of [...first.eligible, ...first.rejected]) {
    assert.ok(decision.reasons.length > 0);
    assert.ok(decision.reasons.every((reason) => reason.message.length > 0));
  }
});

test('active capability loader preserves native declarations and normalizes KB arrays without invalidating KB skills', () => {
  const skills = new SkillLoader().listCapabilitySkills();
  const nativeSkill = skills.find((entry) => entry.id === 'competitive-web-research');
  const appScreenshotSkill = skills.find((entry) => entry.id === 'competitive-app-analysis');
  const knowledgeBaseSkill = skills.find((entry) => entry.id === 'competitive-analysis');

  assert.deepEqual(nativeSkill?.inputs, ['research_goal']);
  assert.deepEqual(nativeSkill?.outputs, ['competitive_analysis']);
  assert.deepEqual(nativeSkill?.required_tools, ['tavily-web-search']);
  assert.deepEqual(nativeSkill?.optional_tools, ['playwright-page-capture']);
  assert.deepEqual(appScreenshotSkill?.inputs, ['research_goal', 'competitor_screenshots']);
  assert.deepEqual(appScreenshotSkill?.multiple_visual_inputs, ['competitor_screenshots']);
  assert.deepEqual(appScreenshotSkill?.required_tools, [
    'tavily-web-search',
    'ai-spider-search',
    'aesthetic-quant-lab',
    'attention-analysis-lab',
    'vision-brand-lab',
  ]);
  assert.deepEqual(knowledgeBaseSkill?.inputs, []);
  assert.deepEqual(knowledgeBaseSkill?.outputs, []);
  assert.deepEqual(knowledgeBaseSkill?.required_tools, []);
  assert.deepEqual(knowledgeBaseSkill?.optional_tools, []);
});

test('production capability registry preserves the valid M1 secondary task routes', () => {
  const skills = new SkillLoader().listCapabilitySkills();
  const expectedRoutes = [
    ['accessibility-review', 'design_audit'],
    ['generate-usability-test', 'user_research_planning'],
    ['journey-map', 'voc_diagnosis'],
  ] as const satisfies ReadonlyArray<readonly [string, ResearchTaskV2['task_type']]>;

  for (const [skillId, taskType] of expectedRoutes) {
    const productionSkill = skills.find((entry) => entry.id === skillId);
    assert.ok(productionSkill, `${skillId} must exist in the production registry`);
    const requiredTools = productionSkill.required_tools.map((toolId) => tool({ id: toolId }));
    const requiredToolStates = productionSkill.required_tools.map((toolId) => toolState({ tool_id: toolId }));
    const requiredToolManifests = productionSkill.required_tools.map(() => toolManifest());

    const resolution = resolveCapabilities(input({
      task: { ...task, task_type: taskType },
      available_input_roles: [],
      skills: [productionSkill],
      tools: requiredTools,
      tool_states: requiredToolStates,
      tool_manifests: requiredToolManifests,
    }));

    assert.deepEqual(resolution.rejected, [], `${skillId} must accept ${taskType}`);
    assert.deepEqual(resolution.eligible.map((decision) => decision.skill.id), [skillId]);
  }

  assert.ok(
    skills.every((entry) => !entry.task_types.includes('cross_cutting')),
    'cross_cutting is not a Current ResearchTaskV2 task type',
  );
});

test('capability loader preserves inactive skills for explicit resolver rejection', () => {
  const realRoot = getConfigRoot();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'capability-loader-'));
  mkdirSync(join(fixtureRoot, 'orchestrator'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'orchestrator', 'skill-registry.yaml'), [
    'version: 1',
    'skills:',
    '  - id: inactive-skill',
    '    name: inactive',
    '    status: draft',
  ].join('\n'));

  try {
    setConfigRoot(fixtureRoot);
    const skills = new SkillLoader().listCapabilitySkills();
    const resolution = resolveCapabilities(input({
      skills,
      tools: [],
      tool_manifests: [],
      tool_states: [],
    }));
    assert.deepEqual(skills[0]?.inputs, []);
    assert.deepEqual(skills[0]?.optional_tools, []);
    assert.deepEqual(reasonCodes(resolution.rejected[0]!), ['skill_inactive']);
  } finally {
    setConfigRoot(realRoot);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('capability loader rejects present non-array metadata on active KB skills', () => {
  const realRoot = getConfigRoot();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'capability-loader-malformed-'));
  mkdirSync(join(fixtureRoot, 'orchestrator'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'orchestrator', 'skill-registry.yaml'), [
    'version: 1',
    'skills:',
    '  - id: malformed-kb-skill',
    '    name: malformed',
    '    path: knowledge-base/skills/malformed-kb-skill',
    '    entry: knowledge-base/skills/malformed-kb-skill/SKILL.md',
    '    when_to_use: never',
    '    owner: test',
    '    status: active',
    '    task_types: [competitive_research]',
    '    inputs: research_goal',
    '    risk_level: low',
  ].join('\n'));

  try {
    setConfigRoot(fixtureRoot);
    assert.throws(
      () => new SkillLoader().listCapabilitySkills(),
      /active skill capability metadata invalid: malformed-kb-skill/,
    );
  } finally {
    setConfigRoot(realRoot);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
