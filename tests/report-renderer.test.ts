import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReportHtml } from '../apps/orchestrator-runtime/src/report-renderer.ts';

// 最小合法 report(只有 required 字段,所有新增字段省略)
const minimalReport = {
  task_id: 'test-001',
  research_goal: '测试设计走查',
  findings: [{ statement: '发现了一个问题', source: 'tool_result' as const }],
  timeline: [{ phase: 'W1', activity: '执行走查' }],
  deliverables: ['走查报告'],
  capability_orchestration: [{ capability_id: 'attention-analysis-lab', capability_type: 'tool', purpose: '注意力' }],
};

test('renderReportHtml:最小报告(所有可选字段缺失)生成合法HTML', () => {
  const html = renderReportHtml({ report: minimalReport });
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('charset'));
  assert.ok(html.includes('测试设计走查'));
  assert.ok(html.includes('发现了一个问题'));
});

test('renderReportHtml:包含 executive_summary 时渲染摘要区', () => {
  const html = renderReportHtml({
    report: { ...minimalReport, executive_summary: '这是一个核心摘要,指出了三个关键问题。' },
  });
  assert.ok(html.includes('这是一个核心摘要'));
  assert.ok(html.includes('摘要'));
});

test('renderReportHtml:包含 core_issues 时渲染问题卡', () => {
  const html = renderReportHtml({
    report: {
      ...minimalReport,
      core_issues: [
        { title: '注意力分散', severity: 'critical', description: '首屏多点竞争', evidence_source: 'attention-analysis-lab', recommendation: '减少干扰元素' },
        { title: '品牌偏移', severity: 'major', description: '色彩与规范不一致', evidence_source: 'vision-brand-lab' },
      ],
    },
  });
  assert.ok(html.includes('注意力分散'));
  assert.ok(html.includes('critical'));
  assert.ok(html.includes('品牌偏移'));
  assert.ok(html.includes('减少干扰元素'));
});

test('renderReportHtml:包含 dimension_analyses 时渲染维度区', () => {
  const html = renderReportHtml({
    report: {
      ...minimalReport,
      dimension_analyses: [
        { dimension: 'attention', status: 'complete', summary: '分散风险中等', metrics: { distractionRiskScore: 0.457, focusBalanceScore: 0.504 }, data_source: 'attention-analysis-lab' },
        { dimension: 'aesthetic', status: 'data_incomplete', summary: '缺少量化数据' },
      ],
    },
  });
  assert.ok(html.includes('attention'));
  assert.ok(html.includes('0.457'));
  assert.ok(html.includes('data_incomplete') || html.includes('数据缺失'));
});

test('renderReportHtml:包含 uploads 时嵌入设计稿图片', () => {
  const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const html = renderReportHtml({
    report: minimalReport,
    uploads: [{ role: 'design', dataUrl: fakeDataUrl }],
  });
  assert.ok(html.includes('img'));
  assert.ok(html.includes(fakeDataUrl));
});

test('renderReportHtml:包含 attention hotspots 时渲染热点表格', () => {
  const html = renderReportHtml({
    report: minimalReport,
    toolOutputs: [{
      toolId: 'attention-analysis-lab',
      output: {
        hotspots: [
          { id: 'h1', x: 0.25, y: 0.15, width: 0.1, height: 0.1, score: 1, reason: '显著区域' },
          { id: 'h2', x: 0.5, y: 0.3, width: 0.1, height: 0.1, score: 0.85, reason: '次要区域' },
        ],
        distractionRiskScore: 0.457,
        focusBalanceScore: 0.504,
      },
    }],
  });
  assert.ok(html.includes('heatmap-section'), '应包含热点区');
  assert.ok(html.includes('显著区域'), '应包含热点描述');
  assert.ok(html.includes('0.457'), '应包含分散风险指标');
});

test('renderReportHtml:risks_and_open_issues 渲染风险区', () => {
  const html = renderReportHtml({
    report: { ...minimalReport, risks_and_open_issues: ['启发式估计非真实眼动', '需人工确认'] },
  });
  assert.ok(html.includes('启发式估计'));
  assert.ok(html.includes('需人工确认'));
});

test('renderReportHtml:V2 行动、证据覆盖和演示标记均可见', () => {
  const html = renderReportHtml({
    report: {
      ...minimalReport,
      recommendations: [{
        priority: 'P0', action: '减少首屏竞争元素', expected_impact: '提升主任务聚焦', validation: '复测注意力分布',
        evidence_basis: 'evidence', evidence_refs: ['evidence:1:attention:summary'],
      }],
      report_metadata: { version: '2.0', task_type: 'design_audit', blueprint_id: 'design-audit-v2', generation_mode: 'mock_demo', evidence_ledger_ref: 'artifacts/evidence-ledger.json' },
      evidence_summary: { ledger_entry_count: 4, source_count: 2, cited_evidence_count: 1, limitations: [] },
    },
  });
  assert.ok(html.includes('优先行动'));
  assert.ok(html.includes('减少首屏竞争元素'));
  assert.ok(html.includes('台账条目 4'));
  assert.ok(html.includes('测试/演示报告'));
});
