import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvidenceLedger, evidenceReferenceIds, factualEvidenceReferenceIds } from '../apps/orchestrator-runtime/src/evidence-ledger.ts';
import { getReportBlueprint } from '../apps/orchestrator-runtime/src/report-blueprint.ts';

test('证据台账为每个完成步骤保留来源，并将结构化 finding 转为可引用条目', () => {
  const ledger = buildEvidenceLedger([
    {
      toolId: 'search', stepNo: 1, outputRef: '/tmp/step1.json',
      output: { summary: '竞品 A 覆盖即时客服。', findings: [{ id: 'F-1', statement: '竞品 A 提供即时客服。', source_type: 'tool_result', dimension: '能力' }] },
    },
    {
      toolId: 'analysis-skill', stepNo: 2, outputRef: '/tmp/step2.json',
      output: { status: 'degraded', summary: '需要补充真实用户材料。', limitations: ['样本不足'] },
    },
  ]);

  assert.equal(ledger.sources.length, 2);
  assert.equal(ledger.sources[1].status, 'degraded');
  assert.ok(ledger.sources[1].limitations.some((item) => item.includes('降级')));
  assert.ok(ledger.entries.some((entry) => entry.id === 'evidence:1:search:F-1'));
  assert.ok(evidenceReferenceIds(ledger).includes('tool:2:analysis-skill'));
});

test('报告蓝图按任务类型提供完整分析维度，并对未知类型回退到通用模板', () => {
  assert.deepEqual(getReportBlueprint('design_audit').requiredDimensions, ['视觉层级', '注意力', '美学质量', '品牌一致性']);
  assert.equal(getReportBlueprint('unknown').id, 'general-research-v2');
});

test('证据台账限制总条目数，来源清单仍保留每个完成步骤', () => {
  const ledger = buildEvidenceLedger(Array.from({ length: 8 }, (_, stepNo) => ({
    toolId: `tool-${stepNo + 1}`,
    stepNo: stepNo + 1,
    output: {
      findings: Array.from({ length: 12 }, (_, index) => ({ id: `F-${index}`, statement: `结论 ${index}`, source_type: 'tool_result' })),
    },
  })));
  assert.equal(ledger.sources.length, 8);
  assert.equal(ledger.entries.length, 40);
  assert.ok(ledger.sources.some((source) => source.omitted_entry_count > 0));
});

test('证据台账兼容旧版竞品 Skill 结论，并保留 LLM 推断来源', () => {
  const ledger = buildEvidenceLedger([
    {
      toolId: 'competitive-web-research', stepNo: 4,
      output: {
        key_findings: { findings: [{ id: 'F1', statement: '平台规则限制完全 AI 驱动互动。' }] },
        opportunities_and_risks: { opportunities: [{ id: 'O1', title: '合规可开播机会', why: '平台规则形成准入约束。' }] },
        limitations: { statement: '行业报告仍需第二来源交叉验证。', items: ['缺少官方规则原文'] },
      },
    },
    { toolId: 'llm', stepNo: 7, sourceType: 'llm_inference', output: { note: '这是一条需要后续验证的归纳。' } },
  ]);

  assert.ok(ledger.entries.some((entry) => entry.statement.includes('平台规则限制')));
  assert.ok(ledger.entries.some((entry) => entry.statement.includes('合规可开播机会')));
  assert.equal(ledger.entries.find((entry) => entry.step_no === 7)?.source_type, 'llm_inference');
  assert.ok(ledger.limitations.some((item) => item.includes('第二来源')));
  assert.ok(!factualEvidenceReferenceIds(ledger).some((id) => id.includes(':llm:')));
});
