import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FINAL_REPORT_VERSION,
  LIGHTWEIGHT_EXECUTION_PLAN_VERSION,
  SKILL_REPORT_VERSION,
  parseFinalReport,
  parseLightweightExecutionPlanV1,
  parseResolvedPlanInputs,
  parseSkillInputRequirements,
  parseSkillReport,
  type LightweightSkillInvocation,
  type SkillInputRequirement,
  type SkillReport,
  type SourceReference,
} from '../packages/api-contract/lightweight-orchestration.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import {
  PlanInputResolutionError,
  resolvePlanInputs,
} from '../apps/orchestrator-runtime/src/input-resolution/resolved-plan-inputs.ts';
import {
  LightweightReportError,
  finalizeMultiReport,
  finalizeSingleReport,
  renderFinalReportHtml,
} from '../apps/orchestrator-runtime/src/report/lightweight-reporting.ts';

const HASH = `sha256:${'0'.repeat(64)}`;

function requirement(overrides: Partial<SkillInputRequirement> = {}): SkillInputRequirement {
  return {
    key: 'research_goal',
    kind: 'value',
    label: '研究目标',
    description: '本次研究需要回答的问题',
    required: true,
    multiple: false,
    acceptedSources: ['conversation'],
    question: '本次研究需要回答什么问题？',
    ...overrides,
  };
}

function invocation(
  invocationId: string,
  skillId: string,
  inputRequirements: SkillInputRequirement[],
): LightweightSkillInvocation {
  return {
    invocation_id: invocationId,
    skill_id: skillId,
    depends_on_invocation_ids: [],
    step_nos: [1],
    required: true,
    failure_policy: 'block',
    snapshot: {
      skill_id: skillId,
      body: `# ${skillId}`,
      body_hash: HASH,
      input_requirements: inputRequirements,
      input_requirements_hash: HASH,
      output_schema_hash: HASH,
      report_template: `# ${skillId} 报告`,
      report_template_hash: HASH,
    },
  };
}

const SOURCE: SourceReference = {
  id: 'S-1',
  title: '公开来源',
  type: 'tool_result',
  url: 'https://example.com/source',
};

function skillReport(overrides: Partial<SkillReport> = {}): SkillReport {
  return {
    version: SKILL_REPORT_VERSION,
    skillId: 'competitive-analysis',
    invocationId: 'inv-competitive',
    title: '竞品分析',
    status: 'completed',
    markdown: '# 竞品分析\n\n结论来自 [S-1]。',
    sources: [SOURCE],
    gaps: [],
    ...overrides,
  };
}

test('freezes strict lightweight input, SkillReport, and FinalReport contracts', () => {
  assert.deepEqual(parseSkillInputRequirements([requirement()]), [requirement()]);
  assert.deepEqual(parseResolvedPlanInputs({
    resolved: [{
      key: 'research_goal',
      valueRef: 'requirement:/research_goal',
      source: 'conversation',
      targetInvocationIds: ['inv-competitive'],
    }],
    pending: [],
    waived: [],
  }).pending, []);
  assert.equal(parseSkillReport(skillReport()).version, SKILL_REPORT_VERSION);
  assert.equal(parseFinalReport({
    version: FINAL_REPORT_VERSION,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    mode: 'single_skill',
    title: '竞品分析',
    markdown: '# 竞品分析',
    sources: [SOURCE],
    gaps: [],
    skillReports: [{
      skillId: 'competitive-analysis',
      invocationId: 'inv-competitive',
      status: 'completed',
      path: 'skill-results/inv-competitive.json',
    }],
  }).planVersionId, 'plan-1');

  assert.throws(
    () => parseSkillInputRequirements([{ ...requirement(), unknown: true }]),
    /unknown/u,
  );
  assert.throws(
    () => parseSkillReport({ ...skillReport(), status: 'needs_input' }),
    /missingInputKeys/u,
  );
  assert.throws(
    () => parseFinalReport({
      version: FINAL_REPORT_VERSION,
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      mode: 'single_skill',
      title: 'bad',
      markdown: '# bad',
      sources: [],
      gaps: [],
      skillReports: [{
        skillId: 'competitive-analysis',
        invocationId: 'inv-competitive',
        status: 'completed',
        path: '../outside.json',
      }],
    }),
    /path/u,
  );
});

test('loads immutable lightweight metadata for the three vertical-slice Skills', () => {
  const loader = new SkillLoader();
  for (const skillId of ['competitive-analysis', 'generate-persona', 'jobs-to-be-done']) {
    const snapshot = loader.loadLightweightSnapshot(skillId);
    assert.equal(snapshot.skill_id, skillId);
    assert.match(snapshot.body_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(snapshot.report_template_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(snapshot.input_requirements.some(({ key }) => key === 'research_goal'));
    assert.ok(snapshot.report_template.startsWith('#'));
  }
});

test('accepts only the explicit lightweight Plan discriminator', () => {
  const plan = parseLightweightExecutionPlanV1({
    task_id: 'task-1',
    execution_contract_version: LIGHTWEIGHT_EXECUTION_PLAN_VERSION,
    mode: 'single_skill',
    deliverable_type: 'research_strategy_report',
    evidence_requirements: [],
    problem_graph: {},
    problem_graph_provenance: {},
    capability_decisions: {},
    steps: [{ step_no: 1 }],
    candidate_metadata: {},
    activated_nodes: [],
    skill_invocations: [invocation('inv-competitive', 'competitive-analysis', [requirement()])],
    resolved_inputs: {
      resolved: [{
        key: 'research_goal',
        valueRef: 'requirement:/research_goal',
        source: 'conversation',
        targetInvocationIds: ['inv-competitive'],
      }],
      pending: [],
      waived: [],
    },
  });
  assert.equal(plan.execution_contract_version, LIGHTWEIGHT_EXECUTION_PLAN_VERSION);
  assert.throws(
    () => parseLightweightExecutionPlanV1({ ...plan, execution_contract_version: 'current-execution-plan-v3' }),
    /execution_contract_version/u,
  );
});

test('deduplicates shared inputs, honors source priority, and binds every invocation', () => {
  const invocations = [
    invocation('inv-competitive', 'competitive-analysis', [
      requirement(),
      requirement({
        key: 'user_materials',
        label: '用户材料',
        description: '已有研究材料',
        required: false,
        multiple: true,
        acceptedSources: ['conversation', 'upload', 'database'],
        question: '是否有已有研究材料？',
      }),
    ]),
    invocation('inv-persona', 'generate-persona', [
      requirement(),
      requirement({
        key: 'user_materials',
        label: '用户材料',
        description: '已有研究材料',
        required: false,
        multiple: true,
        acceptedSources: ['conversation', 'upload', 'database'],
        question: '是否有已有研究材料？',
      }),
    ]),
  ];
  const result = resolvePlanInputs({
    invocations,
    available: [{
      key: 'research_goal',
      kind: 'value',
      valueRef: 'upload:/goal.txt',
      source: 'upload',
      authorized: true,
    }, {
      key: 'research_goal',
      kind: 'value',
      valueRef: 'requirement:/research_goal',
      source: 'conversation',
      authorized: true,
    }],
  });
  assert.deepEqual(result.resolved, [{
    key: 'research_goal',
    valueRef: 'requirement:/research_goal',
    source: 'conversation',
    targetInvocationIds: ['inv-competitive', 'inv-persona'],
  }]);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0]?.requirement.key, 'user_materials');
  assert.deepEqual(result.pending[0]?.targetInvocationIds, ['inv-competitive', 'inv-persona']);
});

test('requires explicit waiver for optional inputs and rejects unauthorized or required waivers', () => {
  const optional = requirement({
    key: 'user_materials',
    label: '用户材料',
    description: '已有研究材料',
    required: false,
    multiple: true,
    acceptedSources: ['upload', 'database'],
    question: '是否有已有研究材料？',
  });
  const resolved = resolvePlanInputs({
    invocations: [invocation('inv-persona', 'generate-persona', [optional])],
    available: [],
    waived: [{ key: 'user_materials', reason: '用户确认以暂定假设继续' }],
  });
  assert.deepEqual(resolved.waived, [{
    key: 'user_materials',
    targetInvocationIds: ['inv-persona'],
    reason: '用户确认以暂定假设继续',
  }]);
  assert.throws(
    () => resolvePlanInputs({
      invocations: [invocation('inv-persona', 'generate-persona', [requirement()])],
      available: [],
      waived: [{ key: 'research_goal', reason: 'skip' }],
    }),
    PlanInputResolutionError,
  );
  assert.throws(
    () => resolvePlanInputs({
      invocations: [invocation('inv-persona', 'generate-persona', [optional])],
      available: [{
        key: 'user_materials',
        kind: 'value',
        valueRef: 'database:/foreign/material',
        source: 'database',
        authorized: false,
      }],
    }),
    /not authorized/u,
  );
});

test('finalizes Single without rewriting the Skill Markdown body', () => {
  const input = skillReport();
  const result = finalizeSingleReport({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    report: input,
    verifiedSources: [SOURCE],
  });
  assert.equal(result.mode, 'single_skill');
  assert.ok(result.markdown.startsWith(input.markdown));
  assert.match(result.markdown, /## 来源/u);
  assert.deepEqual(result.skillReports, [{
    skillId: 'competitive-analysis',
    invocationId: 'inv-competitive',
    status: 'completed',
    path: 'skill-results/inv-competitive.json',
  }]);
});

test('runs Multi synthesis exactly once and preserves every original report reference', async () => {
  let calls = 0;
  const reports = [
    skillReport(),
    skillReport({
      skillId: 'generate-persona',
      invocationId: 'inv-persona',
      title: 'Persona',
      markdown: '# Persona\n\n暂定用户类型 [S-1]。',
      status: 'completed_with_gaps',
      gaps: ['缺少一手访谈材料'],
    }),
    skillReport({
      skillId: 'jobs-to-be-done',
      invocationId: 'inv-jtbd',
      title: 'JTBD',
      markdown: '# JTBD\n\n核心 Job [S-1]。',
    }),
  ];
  const result = await finalizeMultiReport({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    title: '综合报告',
    requirement: { research_goal: '形成用户与增长策略' },
    reports,
    verifiedSources: [SOURCE],
    synthesizer: {
      async synthesize() {
        calls += 1;
        return '# 综合报告\n\n市场、Persona 与 JTBD 共同支持该结论 [S-1]。';
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.synthesis, 'completed');
  assert.equal(result.report.skillReports.length, 3);
  assert.deepEqual(result.report.gaps, ['缺少一手访谈材料']);
});

test('falls back to grouped original Skill reports without retrying synthesis', async () => {
  let calls = 0;
  const result = await finalizeMultiReport({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    title: '综合报告',
    requirement: {},
    reports: [skillReport()],
    verifiedSources: [SOURCE],
    synthesizer: {
      async synthesize() {
        calls += 1;
        throw new Error('provider unavailable');
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.synthesis, 'fallback');
  assert.match(result.report.markdown, /自动综合未完成/u);
  assert.match(result.report.markdown, /# 竞品分析/u);
});

test('renders self-contained safe HTML and rejects invented sources', () => {
  const report = finalizeSingleReport({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    report: skillReport({
      markdown: '# 结论\n\n<script>alert(1)</script> 来源 [S-1] [打开来源](https://example.com/source)。',
    }),
    verifiedSources: [SOURCE],
  });
  const html = renderFinalReportHtml(report);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script/u);
  assert.doesNotMatch(html, /<iframe|<form|onload=/u);
  assert.match(html, /href="https:\/\/example\.com\/source"/u);

  assert.throws(
    () => finalizeSingleReport({
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      report: skillReport({ markdown: '# 伪造来源\n\n[S-404]' }),
      verifiedSources: [SOURCE],
    }),
    LightweightReportError,
  );
});
