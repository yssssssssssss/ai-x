import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReportSynthesisAgent } from '../apps/orchestrator-runtime/src/report-synthesis-agent.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import type { LLMClient, LLMResult } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

const baseReport = {
  research_goal: '验证报告证据边界',
  executive_summary: '报告以可回链证据组织结论、影响和行动建议。',
  findings: [{ statement: '工具发现一个问题', source: 'tool_result', source_ref: 'tool:1:attention-analysis-lab' }],
  core_issues: [{
    title: '注意力分散', severity: 'major', description: '关键元素竞争注意力。', impact: '可能降低主任务理解效率。',
    evidence_source: 'attention-analysis-lab', evidence_basis: 'evidence', evidence_refs: ['tool:1:attention-analysis-lab'],
  }],
  dimension_analyses: [{ dimension: 'attention', status: 'complete', summary: '发现了需要优先处理的注意力竞争。' }],
  recommendations: [{
    priority: 'P0', action: '减少首屏竞争元素。', expected_impact: '提升主任务聚焦。', validation: '复测注意力分布。',
    evidence_basis: 'evidence', evidence_refs: ['tool:1:attention-analysis-lab'],
  }],
  timeline: [{ phase: 'W1', activity: '分析' }],
  deliverables: ['报告'],
  capability_orchestration: [{ capability_id: 'attention-analysis-lab', capability_type: 'tool', purpose: '注意力分析' }],
  risks_and_open_issues: [],
};

function clientWith(report: Record<string, unknown>, onCall?: (context: object | undefined) => void): LLMClient {
  return {
    async generateStructured<T>(): Promise<LLMResult<T>> {
      onCall?.(undefined);
      return {
        data: structuredClone(report) as T,
        promptHash: 'sha256:test',
        modelName: 'test-model',
        modelVersion: 'test',
        traceId: 'trace-test',
        tokens: { prompt: 1, completion: 1, total: 2 },
      };
    },
    async generateText() {
      return { text: '', promptHash: 'sha256:test', modelName: 'test-model', modelVersion: 'test', traceId: 'trace-test', tokens: { prompt: 0, completion: 0, total: 0 } };
    },
  };
}

test('ReportSynthesisAgent 只接受投影上下文并保留有效工具证据引用', async () => {
  let receivedContext: object | undefined;
  const llm = clientWith(baseReport, () => undefined);
  const original = llm.generateStructured.bind(llm);
  llm.generateStructured = async (opts) => {
    receivedContext = opts.context;
    return original(opts);
  };
  const agent = new ReportSynthesisAgent(llm, new SchemaValidator());
  const result = await agent.synthesize({
    taskId: 'task-1',
    researchGoal: '验证报告证据边界',
    evidenceContext: { tool_outputs: [{ toolId: 'attention-analysis-lab', stepNo: 1, output: { summary: '已投影' } }] },
    evidenceRefs: ['tool:1:attention-analysis-lab'],
    stepFailures: [],
    reviewNotes: [],
  });
  assert.deepEqual(receivedContext, { tool_outputs: [{ toolId: 'attention-analysis-lab', stepNo: 1, output: { summary: '已投影' } }] });
  assert.equal((result.report.findings as Array<{ source: string }>)[0].source, 'tool_result');
  assert.deepEqual(result.integrityIssues, []);
});

test('ReportSynthesisAgent 将无法回链的工具结论降级为推断', async () => {
  const agent = new ReportSynthesisAgent(
    clientWith({ ...baseReport, findings: [{ statement: '无法回链的工具结论', source: 'tool_result', source_ref: 'tool:9:unknown' }] }),
    new SchemaValidator(),
  );
  const result = await agent.synthesize({
    taskId: 'task-2',
    researchGoal: '验证降级',
    evidenceContext: { tool_outputs: [] },
    evidenceRefs: ['tool:1:attention-analysis-lab'],
    stepFailures: [],
    reviewNotes: [],
  });
  assert.equal((result.report.findings as Array<{ source: string }>)[0].source, 'llm_inference');
  assert.ok((result.report.risks_and_open_issues as string[]).some((issue) => issue.includes('缺少有效工具证据引用')));
});

test('ReportSynthesisAgent 不允许 LLM 中间结论支撑 evidence 区块', async () => {
  const report = structuredClone(baseReport) as typeof baseReport;
  report.findings[0].source_ref = 'evidence:1:llm:summary';
  report.core_issues[0].evidence_refs = ['evidence:1:llm:summary'];
  report.recommendations[0].evidence_refs = ['evidence:1:llm:summary'];
  const agent = new ReportSynthesisAgent(clientWith(report), new SchemaValidator());
  const result = await agent.synthesize({
    taskId: 'task-llm-inference',
    researchGoal: '验证推断不能伪装为事实证据',
    evidenceContext: { evidence_ledger: { sources: [], entries: [] } },
    evidenceRefs: ['evidence:1:llm:summary'],
    evidenceLedger: {
      version: 1,
      sources: [{ ref: 'tool:1:llm', step_no: 1, capability_id: 'llm', status: 'succeeded', entry_ids: ['evidence:1:llm:summary'], omitted_entry_count: 0, limitations: [] }],
      entries: [{ id: 'evidence:1:llm:summary', source_ref: 'tool:1:llm', source_type: 'llm_inference', step_no: 1, capability_id: 'llm', kind: 'summary', statement: '中间归纳', dimensions: [], limitations: [] }],
      limitations: [],
    },
    stepFailures: [],
    reviewNotes: [],
  });
  assert.equal((result.report.findings as Array<{ source: string }>)[0].source, 'llm_inference');
  assert.equal((result.report.core_issues as Array<{ evidence_basis: string }>)[0].evidence_basis, 'inference');
  assert.equal((result.report.recommendations as Array<{ evidence_basis: string }>)[0].evidence_basis, 'inference');
  assert.equal((result.report.evidence_summary as { source_count: number }).source_count, 0);
});

test('ReportSynthesisAgent 以实际执行能力覆盖模型补写，并降级无效论据区块', async () => {
  const report = structuredClone(baseReport) as typeof baseReport;
  report.capability_orchestration = [{ capability_id: 'hallucinated-tool', capability_type: 'tool', purpose: '不应保留' }];
  report.core_issues[0].evidence_refs = ['tool:9:unknown'];
  report.recommendations[0].evidence_refs = ['tool:9:unknown'];
  const agent = new ReportSynthesisAgent(clientWith(report), new SchemaValidator());
  const result = await agent.synthesize({
    taskId: 'task-actual-capabilities',
    taskType: 'design_audit',
    researchGoal: '验证确定性报告字段',
    evidenceContext: { evidence_ledger: { sources: [], entries: [] } },
    evidenceRefs: ['tool:1:attention-analysis-lab'],
    capabilityOrchestration: [{ capability_id: 'attention-analysis-lab', capability_type: 'tool', purpose: '注意力分析' }],
    stepFailures: [],
    reviewNotes: [],
  });
  assert.deepEqual(result.report.capability_orchestration, [{ capability_id: 'attention-analysis-lab', capability_type: 'tool', purpose: '注意力分析' }]);
  assert.equal((result.report.core_issues as Array<{ evidence_basis: string }>)[0].evidence_basis, 'inference');
  assert.equal((result.report.recommendations as Array<{ evidence_basis: string }>)[0].evidence_basis, 'inference');
  assert.equal((result.report.report_metadata as { blueprint_id: string }).blueprint_id, 'design-audit-v2');
});

test('ReportSynthesisAgent 拒绝原始媒体 Data URL', async () => {
  const agent = new ReportSynthesisAgent(clientWith(baseReport), new SchemaValidator());
  await assert.rejects(
    () => agent.synthesize({
      taskId: 'task-3',
      researchGoal: '验证媒体边界',
      evidenceContext: { tool_outputs: [{ output: { image: 'data:image/png;base64,abc' } }] },
      evidenceRefs: [],
      stepFailures: [],
      reviewNotes: [],
    }),
    /禁止传入原始媒体/,
  );
});
