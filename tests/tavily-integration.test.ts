import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadEnv } from '../database/db.ts';
import { TavilyAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

// 可选集成测:默认 skip(不依赖 Tavily 网络和配额)。
// 真机验证:.env 填好 TAVILY_API_KEY,再:
//   TAVILY_TEST=1 npx tsx --test tests/tavily-integration.test.ts
loadEnv();
const skip = !process.env.TAVILY_TEST;

test('TavilyAdapter 能检索公开网页并返回 schema 合法结果', { skip }, async () => {
  const adapter = new TavilyAdapter();
  const manifest = loadToolManifest('tools/tavily-web-search/manifest.yaml');
  const res = await adapter.invoke({
    toolId: 'tavily-web-search',
    input: { query: '直播 数字人 竞品', max_results: 3 },
    manifest,
  });

  const validator = new SchemaValidator();
  const errors = validator.validateFile(
    join(process.cwd(), 'tools/tavily-web-search/output.schema.json'),
    res.output,
  );
  assert.deepEqual(errors, [], `Tavily 结果应过 schema,实际: ${errors.join('; ')}`);
  const out = res.output as { results: unknown[] };
  console.log(`  Tavily 命中 ${out.results.length} 条,耗时 ${res.latencyMs}ms`);
  if (out.results.length === 0) console.log('  ⚠️ Tavily 返回为空,确认配额、网络或查询词');
});
