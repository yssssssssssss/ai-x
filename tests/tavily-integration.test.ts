import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, loadEnv } from '../database/db.ts';
import { buildOrchestrator } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { TavilyAdapter, ToolRouter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { createConversation, createUser, listArtifacts, listExecutionLog } from '../database/repository.ts';

// 可选集成测:默认 skip(不依赖 Tavily 网络和配额)。
// 真机验证:.env 填好 TAVILY_API_KEY,再:
//   TAVILY_TEST=1 npx tsx --test tests/tavily-integration.test.ts
loadEnv();
const skip = !process.env.TAVILY_TEST;
const cleanupDirs: string[] = [];

after(async () => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  await closePool();
});

test('TavilyAdapter 能检索公开网页并返回 schema 合法结果', { skip }, async () => {
  const adapter = new TavilyAdapter();
  const manifest = loadToolManifest('tools/tavily-web-search/manifest.yaml');
  const res = await adapter.invoke({
    toolId: 'tavily-web-search',
    input: { query: '直播 数字人 竞品', max_results: 3 },
    manifest,
    context: {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 90_000,
    },
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

test('编排链路能用真实 Tavily 产出 tool_result 报告', { skip }, async () => {
  process.env.LLM_PROVIDER = 'mock';
  process.env.TOOL_ADAPTER = 'real';
  const router = new ToolRouter();
  router.registerAs('tavily', new TavilyAdapter());
  const orch = buildOrchestrator({ toolAdapter: router });
  const user = await createUser({ email: `tavily-e2e-${Date.now()}@test.local`, displayName: 'tavily-e2e', passwordHash: 'x' });
  const conversation = await createConversation({ ownerUserId: user.id, title: 'tavily-e2e' });

  const plan = await orch.planPhase({
    originalInput: '直播数字人竞品研究',
    conversationId: conversation.id,
    ownerUserId: user.id,
  });
  cleanupDirs.push(plan.workspaceUri);
  assert.equal(plan.candidates[0].steps[0]?.actor_id, 'tavily-web-search');

  await orch.selectPlan({ taskId: plan.taskId, candidateId: 'depth' });
  const exec = await orch.executePhase({ taskId: plan.taskId, conversationId: conversation.id });
  assert.equal(exec.status, 'completed');

  const log = await listExecutionLog(plan.taskId);
  assert.equal(log.find((l) => l.actor_id === 'tavily-web-search')?.status, 'succeeded');
  const toolOutputPath = join(plan.workspaceUri, 'tool_outputs', 'step1.json');
  assert.ok(existsSync(toolOutputPath), 'Tavily tool output 应落盘');
  const toolOutput = JSON.parse(readFileSync(toolOutputPath, 'utf8')) as { results?: Array<{ url?: string }> };
  assert.ok((toolOutput.results ?? []).some((r) => r.url?.startsWith('http')), 'Tavily output 应包含可反查 URL');

  const artifacts = await listArtifacts(plan.taskId);
  assert.ok(artifacts.some((a) => a.artifact_type === 'report'), '应产出 report artifact');
  const reportPath = join(plan.workspaceUri, 'artifacts', 'report.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { findings?: Array<{ source?: string; source_ref?: string }> };
  assert.ok(report.findings?.some((f) => f.source === 'tool_result' && f.source_ref), '报告应保留 tool_result 来源');
});
