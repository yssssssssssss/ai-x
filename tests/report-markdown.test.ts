import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportToMarkdown } from '../apps/web/src/report-markdown.ts';
import type { Report } from '../packages/api-contract/http.ts';

const report: Report = {
  research_goal: '了解直播数字人竞品能力差异',
  method_summary: '公开检索 + 竞品分析',
  findings: [
    { id: 'F1', statement: '实时互动是短板', source: 'tool_result', source_ref: 'https://example.com/a' },
    { id: 'F2', statement: '需区分事实与推断', source: 'knowledge_base', source_ref: 'kb/method' },
    { id: 'F3', statement: '低延迟是差异化方向', source: 'llm_inference' },
  ],
  sub_questions: [
    {
      question: '竞品实时互动水平如何?',
      finding_ids: ['F1'],
      analysis: [{ statement: '实时性普遍不足', based_on: ['F1', 'F3'] }],
      summary: '实时互动待突破',
    },
  ],
  overall_conclusion: ['优先补齐实时互动', '以垂直模板差异化'],
  timeline: [{ phase: 'W1', activity: '界定范围' }],
  deliverables: ['研究报告'],
  capability_orchestration: [{ capability_id: 'tavily-web-search', capability_type: 'tool', purpose: '检索' }],
  risks_and_open_issues: ['部分能力为推断,需人工确认'],
};

test('reportToMarkdown 含研究目标与研究方法节', () => {
  const md = reportToMarkdown(report);
  assert.match(md, /了解直播数字人竞品能力差异/);
  assert.match(md, /公开检索 \+ 竞品分析/);
  assert.match(md, /研究方法|研究背景/);
});

test('reportToMarkdown 子问题下发现带证据编号 [F1]、分析引用 [F1][F3]', () => {
  const md = reportToMarkdown(report);
  assert.match(md, /竞品实时互动水平如何?/);
  assert.match(md, /\[F1\]/, '发现应带证据编号 F1');
  assert.match(md, /\[F1\]\[F3\]/, '分析应引用 [F1][F3]');
  assert.match(md, /实时性普遍不足/);
});

test('reportToMarkdown 来源类型渲染为中文标签,source_ref 作链接', () => {
  const md = reportToMarkdown(report);
  assert.match(md, /Tool 结果/);
  assert.match(md, /知识库/);
  assert.match(md, /LLM 推断/);
  assert.match(md, /https:\/\/example\.com\/a/);
});

test('reportToMarkdown 含总体结论与风险节', () => {
  const md = reportToMarkdown(report);
  assert.match(md, /优先补齐实时互动/);
  assert.match(md, /部分能力为推断,需人工确认/);
});

test('reportToMarkdown 历史降级:旧报告缺 sub_questions/method_summary/overall_conclusion(字段不存在)不崩溃', () => {
  // 升级前入库的报告根本没有这些键,也没有 finding id;导出不得抛异常。
  const legacy = {
    research_goal: '旧任务研究目标',
    findings: [{ statement: '实时互动是短板', source: 'tool_result', source_ref: 'run/x' }],
    timeline: [{ phase: 'W1', activity: '界定范围' }],
    deliverables: ['旧报告'],
    capability_orchestration: [],
    risks_and_open_issues: [],
  } as unknown as Report;
  const md = reportToMarkdown(legacy);
  assert.match(md, /实时互动是短板/, '旧结构仍应列出扁平发现');
  assert.match(md, /旧任务研究目标/);
  assert.doesNotMatch(md, /## 总体结论与建议/, '缺 overall_conclusion 时整节略过');
});
