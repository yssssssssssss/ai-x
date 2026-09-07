import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { getConfigRoot, loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

// P0-03 验收:样例过校验;非法结构被拒。
const v = new SchemaValidator();

test('ResearchTask 合法样例通过校验', () => {
  const valid = {
    task_type: 'competitive_research',
    business_domain: 'live_commerce',
    research_goal: '了解直播场域数字人竞品的能力与体验差异',
    assumptions: [{ key: 'competitors', value: '默认头部 3 家', editable: true }],
    confirmations: [{ key: 'sample_size', question: '样本规模?', suggestion: '5-8 家' }],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  assert.deepEqual(v.validate('research-task', valid), []);
});

test('ResearchTask 非法 task_type 被拒', () => {
  const bad = {
    task_type: 'not_a_real_type',
    business_domain: 'x',
    research_goal: 'y',
    assumptions: [], confirmations: [], blocking_issues: [],
    sensitivity: 'internal', pii_detected: false,
  };
  assert.ok(v.validate('research-task', bad).length > 0);
});

test('DecisionState 6 态枚举生效', () => {
  const ok = { node_key: 'D5_competitive', state: 'need_execute', reason: '用户提到竞品', final_state: 'need_execute' };
  assert.deepEqual(v.validate('decision-state', ok), []);
  const bad = { ...ok, state: 'unknown_state' };
  assert.ok(v.validate('decision-state', bad).length > 0);
});

test('ExecutionPlan 至少一步且步骤字段完整', () => {
  const ok = {
    task_id: 't1', task_type: 'competitive_research',
    steps: [{ step_no: 1, step_name: '竞品检索', actor_type: 'tool', actor_id: 'o2-web-search' }],
    activated_nodes: ['D1_research_goal'],
    assumptions: [],
  };
  assert.deepEqual(v.validate('execution-plan', ok), []);
  const noSteps = { ...ok, steps: [] };
  assert.ok(v.validate('execution-plan', noSteps).length > 0);
});

test('ResearchReport 新结构:子问题 + 带 id 发现 + based_on 分析通过校验', () => {
  const ok = {
    task_id: 't1', research_goal: 'g', method_summary: '通过公开检索 + 竞品分析方法综合',
    findings: [
      { id: 'F1', statement: '结论A', source: 'tool_result', source_ref: 'run/x' },
      { id: 'F2', statement: '结论B', source: 'knowledge_base', source_ref: 'kb/y' },
    ],
    sub_questions: [
      {
        question: '竞品实时互动能力如何?',
        finding_ids: ['F1'],
        analysis: [{ statement: '实时性普遍是短板', based_on: ['F1', 'F2'] }],
        summary: '实时互动待突破',
      },
    ],
    overall_conclusion: ['建议优先补齐实时互动'],
    timeline: [{ phase: 'W28', activity: '竞品检索' }],
    deliverables: ['研究报告'],
    capability_orchestration: [{ capability_id: 'o2-web-search', capability_type: 'tool', purpose: '检索' }],
  };
  assert.deepEqual(v.validate('research-report', ok), []);
  // 缺 source 的 finding 被拒(回归)
  const badSource = { ...ok, findings: [{ id: 'F1', statement: '无来源结论' }] };
  assert.ok(v.validate('research-report', badSource).length > 0);
  // 缺 id 的 finding 被拒
  const badNoId = { ...ok, findings: [{ statement: '无 id 结论', source: 'tool_result' }] };
  assert.ok(v.validate('research-report', badNoId).length > 0);
});

test('ResearchReport based_on 引用不存在的发现 id 被拒(引用完整性)', () => {
  const bad = {
    task_id: 't1', research_goal: 'g', method_summary: 'm',
    findings: [{ id: 'F1', statement: '结论A', source: 'tool_result' }],
    sub_questions: [
      { question: 'q', finding_ids: ['F1'], analysis: [{ statement: 'a', based_on: ['F9'] }], summary: 's' },
    ],
    overall_conclusion: ['c'],
    timeline: [{ phase: 'W28', activity: '检索' }],
    deliverables: ['报告'],
    capability_orchestration: [{ capability_id: 't', capability_type: 'tool', purpose: 'p' }],
  };
  const errs = v.validate('research-report', bad);
  assert.ok(errs.some((e) => e.includes('F9')), `应报告 F9 引用不存在,实得: ${errs.join('; ')}`);
});

test('ResearchReport finding_ids 引用不存在的发现 id 被拒(引用完整性)', () => {
  const bad = {
    task_id: 't1', research_goal: 'g', method_summary: 'm',
    findings: [{ id: 'F1', statement: '结论A', source: 'tool_result' }],
    sub_questions: [
      { question: 'q', finding_ids: ['F2'], analysis: [{ statement: 'a', based_on: ['F1'] }], summary: 's' },
    ],
    overall_conclusion: ['c'],
    timeline: [{ phase: 'W28', activity: '检索' }],
    deliverables: ['报告'],
    capability_orchestration: [{ capability_id: 't', capability_type: 'tool', purpose: 'p' }],
  };
  assert.ok(v.validate('research-report', bad).some((e) => e.includes('F2')));
});

test('validateOrThrow 不合规时抛 SchemaValidationError', () => {
  assert.throws(() => v.validateOrThrow('research-task', {}), /validation failed/);
});

test('ResearchTaskV2 要求成功标准、歧义和澄清问题', () => {
  const errors = v.validate('research-task-v2', {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '宠物消费',
    research_goal: '分析宠物辅食竞品',
    comparison_dimensions: ['成分透明度', '适口性', '价格与规格'],
  });
  assert.ok(errors.length > 0);
  assert.ok(errors.some((error) => error.includes('success_criteria')));
});

test('ResearchTaskV2 Industry 任务要求结构化范围和资料可用性', () => {
  const industry = {
    version: 'research-task-v2',
    task_type: 'industry_market_analysis',
    outcome_mode: 'answer',
    business_domain: 'pet-food',
    research_goal: '形成宠物食品行业与京东频道策略报告',
    target_audience: ['频道产品与设计团队'],
    scope: ['中国大陆线上宠物食品'],
    constraints: [],
    success_criteria: [{ id: 'sc1', statement: '输出可追溯的行业结论与策略' }],
    expected_deliverables: ['industry_market_analysis_report'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
    industry_scope: {
      category: '宠物食品',
      subcategories: ['猫用冻干'],
      exclusions: ['线下渠道'],
      analysis_depth: 'medium',
      primary_focus: '竞品与设计策略',
      secondary_focuses: ['用户洞察'],
      decision_audience: ['频道产品与设计团队'],
      decision_goal: '确定频道改版优先级',
      time_window: '最近十二个月',
    },
    available_material_roles: ['competitor_screenshots'],
    unavailable_material_roles: ['internal_metrics_dataset'],
  };

  assert.deepEqual(v.validate('research-task-v2', industry), []);
  assert.ok(v.validate('research-task-v2', {
    ...industry,
    industry_scope: undefined,
  }).length > 0);
  assert.ok(v.validate('research-task-v2', {
    ...industry,
    available_material_roles: ['competitor_screenshots', 'competitor_screenshots'],
  }).length > 0);
  assert.ok(v.validate('research-task-v2', {
    ...industry,
    available_material_roles: ['公开可追溯行业报告'],
  }).some((error) => error.includes('available_material_roles')));
});

test('ResearchTaskV2 合法 fixture 通过校验并保持 snake_case 字段', () => {
  const valid = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '宠物消费',
    research_goal: '分析宠物辅食竞品',
    target_audience: ['一线城市宠物主'],
    scope: ['国内电商渠道'],
    constraints: [{ id: 'c1', statement: '仅使用公开来源', source: 'user' }],
    success_criteria: [{ id: 'sc1', statement: '输出可验证的竞品能力对比' }],
    expected_deliverables: ['research_report'],
    assumptions: [{ key: 'sample', value: '头部品牌', editable: true }],
    ambiguities: [{ id: 'a1', statement: '是否包含线下渠道', blocking: true }],
    clarification_questions: [{
      key: 'channel',
      ambiguity_id: 'a1',
      question: '是否包含线下渠道？',
      rationale: '决定样本范围',
      suggestion: '暂不包含线下渠道',
      options: ['仅线上', '线上和线下'],
    }],
    blocking_issues: [{ key: 'channel', reason: '渠道范围未确认', kind: 'scope' }],
    sensitivity: 'internal',
    pii_detected: false,
  };
  assert.deepEqual(v.validate('research-task-v2', valid), []);
});

test('ResearchTaskV2 对比维度可选，但存在时必须至少两项、非空且唯一', () => {
  const valid = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '电商',
    research_goal: '比较 AI 购物助手',
    target_audience: ['消费者'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [{ id: 'sc1', statement: '完成对比' }],
    expected_deliverables: ['competitive_analysis_report'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  } as const;
  assert.deepEqual(v.validate('research-task-v2', valid), []);
  assert.deepEqual(v.validate('research-task-v2', {
    ...valid,
    comparison_dimensions: ['需求理解', '内容可信度'],
  }), []);
  for (const comparison_dimensions of [
    ['需求理解'],
    ['需求理解', '需求理解'],
    ['需求理解', '   '],
  ]) {
    assert.ok(v.validate('research-task-v2', { ...valid, comparison_dimensions }).length > 0);
  }
});

test('ResearchTaskV2 澄清快捷项限制为 2-4 个唯一非空字符串', () => {
  const valid = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '电商',
    research_goal: '比较购物助手',
    target_audience: [],
    scope: [],
    constraints: [],
    success_criteria: [{ id: 'sc1', statement: '完成对比' }],
    expected_deliverables: ['competitive_analysis_report'],
    assumptions: [],
    ambiguities: [{ id: 'audience', statement: '受众未确定', blocking: true }],
    clarification_questions: [{
      key: 'audience',
      ambiguity_id: 'audience',
      question: '目标受众是谁？',
      rationale: '影响研究方法',
      suggestion: '消费者',
      options: ['消费者', '产品团队'],
    }],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
  assert.deepEqual(v.validate('research-task-v2', valid), []);
  for (const options of [
    ['消费者'],
    ['消费者', '消费者'],
    ['消费者', '产品团队', '运营团队', '设计团队', '管理层'],
    ['消费者', '   '],
  ]) {
    assert.ok(v.validate('research-task-v2', {
      ...valid,
      clarification_questions: [{ ...valid.clarification_questions[0], options }],
    }).length > 0);
  }
});

test('ResearchTaskV2 拒绝旧版或 camelCase 字段', () => {
  const errors = v.validate('research-task-v2', {
    version: 'research-task-v2',
    taskType: 'competitive_research',
    businessDomain: '宠物消费',
    researchGoal: '分析宠物辅食竞品',
  });
  assert.ok(errors.length > 0);
});

test('ResearchTaskV2 通过现有 schema registry 注册并可加载', () => {
  const spec = resolveSchema('research-task-v2');
  assert.equal(spec.file, 'research-task-v2.schema.json');
  assert.ok(loadSchemaText(spec)?.includes('research-task-v2'));
});

test('tool manifest schema covers every implemented adapter including Playwright', () => {
  for (const path of [
    'tools/tavily-web-search/manifest.yaml',
    'tools/experience-model-lab/manifest.yaml',
    'tools/playwright-page-capture/manifest.yaml',
  ]) {
    const manifest = loadToolManifest(path);
    assert.deepEqual(v.validate('tool-manifest', manifest), [], path);
  }
});

test('Playwright capture schemas accept the metadata-only example and reject media bytes in JSON', () => {
  const root = getConfigRoot();
  const manifest = loadToolManifest('tools/playwright-page-capture/manifest.yaml');
  const example = JSON.parse(readFileSync(
    join(root, 'tools/playwright-page-capture/examples/example-01.json'),
    'utf8',
  )) as { input: unknown; output: Record<string, unknown> };

  assert.deepEqual(v.validateFile(join(root, manifest.input_schema), example.input), []);
  assert.deepEqual(v.validateFile(join(root, manifest.input_schema), {
    pages: [{
      title: 'Provider row with deferred URL validation',
      url: 'not-yet-normalized',
      snippet: 'The Adapter records invalid rows as per-page failures.',
      score: null,
      published_date: '2026-08-19T08:00:00.000Z',
    }],
  }), []);
  assert.deepEqual(v.validateFile(join(root, manifest.output_schema), example.output), []);
  assert.ok(v.validateFile(join(root, manifest.output_schema), {
    ...example.output,
    bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  }).length > 0);
});
