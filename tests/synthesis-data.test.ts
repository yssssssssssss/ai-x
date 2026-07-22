import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

// 验证"证据台账喂给 synthesis"链路:MockLLMClient 生成 research-report 时，
// 若 context 带可回链工具证据,应在 findings 注入一条 source=tool_result 的结论。

test('synthesis 带 evidence_ledger 时,report 注入 tool_result 结论', async () => {
  const llm = new MockLLMClient();
  const r = await llm.generateStructured<{ findings: Array<{ statement: string; source: string }> }>({
    prompt: '基于真实执行结果生成报告',
    schema: {},
    schemaName: 'research-report',
    context: {
      task_id: 't1',
      research_goal: '直播数字人竞品研究',
      evidence_ledger: {
        version: 1,
        sources: [{ ref: 'tool:1:ai-spider-search', step_no: 1, capability_id: 'ai-spider-search', status: 'succeeded', entry_ids: ['evidence:1:ai-spider-search:summary'], omitted_entry_count: 0, limitations: [] }],
        entries: [{ id: 'evidence:1:ai-spider-search:summary', source_ref: 'tool:1:ai-spider-search', source_type: 'tool_result', step_no: 1, capability_id: 'ai-spider-search', kind: 'summary', statement: '淘宝使用暖色调突出促销感。', dimensions: ['体验'], limitations: [] }],
        limitations: [],
      },
    },
  });
  const toolFindings = r.data.findings.filter((f) => f.source === 'tool_result');
  assert.ok(toolFindings.length >= 1, '应至少注入一条 tool_result 结论');
  assert.ok(toolFindings[0].statement.includes('淘宝'), 'tool_result 结论应引用台账中的竞品证据(淘宝)');
});

test('synthesis 无 evidence_ledger 时,report 不注入 tool_result(保持原 fixture)', async () => {
  const llm = new MockLLMClient();
  const r = await llm.generateStructured<{ findings: Array<{ statement: string; source: string }> }>({
    prompt: '生成报告',
    schema: {},
    schemaName: 'research-report',
    context: { task_id: 't1' },
  });
  // 原 fixture 的 findings 里没有引用"淘宝"的注入结论
  assert.ok(!r.data.findings.some((f) => f.statement.includes('淘宝')));
});
