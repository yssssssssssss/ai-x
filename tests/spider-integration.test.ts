import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../database/db.ts';
import { HttpApiAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { join } from 'node:path';

// 可选集成测:默认 skip(不依赖 ai-spider-app 后端在跑)。
// 真机验证:先启动 ai-spider-app(:8000)、.env 填好 SPIDER_USERNAME/PASSWORD,再:
//   SPIDER_TEST=1 npx tsx --test tests/spider-integration.test.ts
loadEnv();
const skip = !process.env.SPIDER_TEST;

test('HttpApiAdapter 能登录并检索 ai-spider-app 竞品库', { skip }, async () => {
  const adapter = new HttpApiAdapter();
  const manifest = loadToolManifest('tools/ai-spider-search/manifest.yaml');
  const res = await adapter.invoke({
    toolId: 'ai-spider-search',
    input: { query: '直播 数字人', limit: 3 },
    manifest,
  });

  // 输出过 output.schema.json
  const v = new SchemaValidator();
  const errors = v.validateFile(
    join(process.cwd(), 'tools/ai-spider-search/output.schema.json'),
    res.output,
  );
  assert.deepEqual(errors, [], `检索结果应过 schema,实际: ${errors.join('; ')}`);
  const out = res.output as { results: unknown[] };
  console.log(`  检索命中 ${out.results.length} 条,耗时 ${res.latencyMs}ms`);
  // 库里有数据时应 >0;库空则为 0(仍算通过,只提示)
  if (out.results.length === 0) console.log('  ⚠️ 检索为空,确认 competitor_db 有已采集数据');
});
