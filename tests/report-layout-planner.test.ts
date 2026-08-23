import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LLMResult, StructuredLLMCallOptions } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ReportLayoutPlanner } from '../apps/orchestrator-runtime/src/report/report-layout-planner.ts';
import { researchStrategyLayoutV1, researchStrategyPayloadV2 } from './fixtures/research-strategy-v2.ts';

class LayoutLlm {
  readonly calls: StructuredLLMCallOptions[] = [];

  constructor(private readonly result: unknown | Error) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    if (this.result instanceof Error) throw this.result;
    return {
      data: this.result as T,
      promptHash: `sha256:${'1'.repeat(64)}`,
      modelName: 'layout-model',
      modelVersion: 'fixture-v1',
      traceId: 'trace-layout',
    };
  }
}

test('model layout can choose section titles, grouping, and order without writing report content', async () => {
  const llm = new LayoutLlm(researchStrategyLayoutV1());
  const result = await new ReportLayoutPlanner({ llm }).plan({
    payload: researchStrategyPayloadV2(),
    attemptId: 'attempt-1',
    stepNo: 12,
    expectedModel: 'layout-model',
  });

  assert.equal(result.mode, 'model');
  assert.deepEqual(result.blueprint.sections.map(({ title }) => title), ['Act first', 'Why it works']);
  assert.deepEqual(result.blueprint.sections.flatMap(({ blockRefs }) => blockRefs), [
    'content-block-002',
    'content-block-001',
  ]);
  assert.ok(Object.keys(llm.calls[0]?.schema ?? {}).length > 0);
  assert.deepEqual(Object.keys((llm.calls[0]?.context as Record<string, unknown>) ?? {}).sort(), [
    'contentIndex',
    'requestedArtifacts',
    'title',
  ]);
  assert.equal(JSON.stringify(llm.calls[0]?.context).includes('Lead with verifiable trust signals.'), false);
});

test('invalid model layout falls back to every canonical block in original order', async () => {
  const invalid = researchStrategyLayoutV1();
  invalid.sections[0]!.blockRefs = ['unknown-block'];
  const result = await new ReportLayoutPlanner({ llm: new LayoutLlm(invalid) }).plan({
    payload: researchStrategyPayloadV2(),
    attemptId: 'attempt-1',
    stepNo: 12,
    expectedModel: 'layout-model',
  });

  assert.equal(result.mode, 'fallback');
  assert.deepEqual(result.blueprint.sections.flatMap(({ blockRefs }) => blockRefs), [
    'content-block-001',
    'content-block-002',
  ]);
  assert.match(result.warnings[0] ?? '', /unknown Block/);
});

test('layout provider failure is non-blocking and uses deterministic fallback', async () => {
  const result = await new ReportLayoutPlanner({ llm: new LayoutLlm(new Error('gateway unavailable')) }).plan({
    payload: researchStrategyPayloadV2(),
    attemptId: 'attempt-1',
    stepNo: 12,
    expectedModel: 'layout-model',
  });

  assert.equal(result.mode, 'fallback');
  assert.match(result.warnings[0] ?? '', /gateway unavailable/);
  assert.equal(result.blueprint.sections.length, 2);
});
