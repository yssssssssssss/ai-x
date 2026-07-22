import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceContext } from '../apps/orchestrator-runtime/src/runtime/context-builder.ts';

test('证据投影遵守硬预算并剔除媒体与未知大字段', () => {
  const result = buildEvidenceContext({
    callId: 'test-call',
    budgetChars: 900,
    base: { research_goal: '检查视觉稿', raw_input: 'x'.repeat(2_000) },
    toolOutputs: [{
      toolId: 'attention-analysis-lab',
      stepNo: 1,
      outputRef: '/tmp/step1.json',
      output: {
        status: 'available',
        engine: 'vlm',
        summary: '注意力集中',
        distractionRiskScore: 0.4,
        heatmapImage: `data:image/png;base64,${'a'.repeat(5_000)}`,
        raw: 'x'.repeat(5_000),
      },
    }],
  });

  const encoded = JSON.stringify(result.context);
  assert.ok(encoded.length <= 900);
  assert.ok(!encoded.includes('data:image'));
  assert.ok(!encoded.includes('heatmapImage'));
  assert.equal(result.manifest.sources[0].outputRef, '/tmp/step1.json');
  assert.ok(result.manifest.sources[0].omitted.some((item) => item.field === 'heatmapImage'));
});

test('通用工具只暴露证据白名单', () => {
  const result = buildEvidenceContext({
    callId: 'generic',
    base: {},
    toolOutputs: [{ toolId: 'unknown-tool', output: { status: 'ok', summary: 's', secretBlob: 'hidden' } }],
  });
  assert.ok(!JSON.stringify(result.context).includes('secretBlob'));
  assert.ok(result.manifest.sources[0].omitted.some((item) => item.field === 'secretBlob' && item.reason === 'not_projected'));
});

test('检索工具保留结果证据但限制数量与正文长度', () => {
  const result = buildEvidenceContext({
    callId: 'search',
    base: {},
    toolOutputs: [{
      toolId: 'tavily-web-search',
      output: { results: Array.from({ length: 20 }, (_, i) => ({ title: `r${i}`, content: 'x'.repeat(3_000) })) },
    }],
  });
  const output = (result.context.tool_outputs as Array<{ output: { results: unknown[] } }>)[0].output;
  assert.equal(output.results.length, 8);
  assert.ok(JSON.stringify(output).length < 15_000);
});
