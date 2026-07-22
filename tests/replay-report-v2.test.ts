import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReportComparison } from '../scripts/replay-report-v2.ts';

test('历史报告对比稳定统计 V1/V2 的证据与完整性字段', () => {
  const comparison = buildReportComparison({
    taskId: 'task-1',
    v1: { findings: [{ statement: '旧结论', source: 'tool_result' }] },
    v2: {
      findings: [
        { statement: '证据结论', source: 'tool_result' },
        { statement: '推断结论', source: 'llm_inference' },
      ],
      executive_summary: 'V2 已经形成完整的证据驱动执行摘要。',
      core_issues: [{ title: '问题' }],
      dimension_analyses: [{ dimension: '能力' }],
      recommendations: [{ priority: 'P0' }],
      report_metadata: { generation_mode: 'production' },
      evidence_summary: { cited_evidence_count: 3 },
    },
    ledger: {
      version: 1,
      sources: [{ ref: 'tool:1:search', step_no: 1, capability_id: 'search', status: 'succeeded', entry_ids: ['evidence:1:search:summary'], omitted_entry_count: 0, limitations: [] }],
      entries: [{ id: 'evidence:1:search:summary', source_ref: 'tool:1:search', source_type: 'tool_result', step_no: 1, capability_id: 'search', kind: 'summary', statement: '检索到一条可回链结论。', dimensions: [], limitations: [] }],
      limitations: [],
    },
  }) as { changes: Record<string, unknown>; v2: Record<string, unknown> };

  assert.equal(comparison.changes.executive_summary_added, true);
  assert.equal(comparison.changes.evidence_ledger_added, true);
  assert.equal(comparison.v2.tool_result_findings, 1);
  assert.equal(comparison.v2.inference_findings, 1);
  assert.equal(comparison.v2.cited_evidence, 3);
  assert.equal(comparison.v2.factual_evidence_sources, 1);
});
