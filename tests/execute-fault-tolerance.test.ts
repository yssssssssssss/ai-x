import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrchestrator, AllStepsFailedError } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import { Orchestrator } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { MockLLMClient, defaultFixtures } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { FakeO2Adapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { createUser, createConversation, listExecutionLog, listArtifacts, getResearchTask } from '../database/repository.ts';
import { closePool } from '../database/db.ts';

// 执行链路容错(方案 §2.5①·补):失败停步 paused → resume(skip)续跑 / abort 终止;缺口进报告。
// Mock LLM 确定性;用 FakeO2Adapter({failOnToolIds}) 构造 tool 步失败。
process.env.LLM_PROVIDER = 'mock';

let userId: string;
let convId: string;
const cleanupDirs: string[] = [];

// 走完 plan→select(depth),返回 taskId;depth 候选 steps = [tool tavily-web-search, skill, reviewer]。
async function planAndSelectDepth(orch: Orchestrator): Promise<string> {
  const plan = await orch.planPhase({
    originalInput: '我要为直播场域做数字人竞品研究',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(plan.workspaceUri);
  await orch.selectPlan({ taskId: plan.taskId, candidateId: 'depth' });
  return plan.taskId;
}

// 注入指定 tool 失败的 orchestrator(其余走默认 mock)。
function orchFailingTool(toolIds: string[]): Orchestrator {
  const rt = buildRuntime({ toolAdapter: new FakeO2Adapter({ failOnToolIds: toolIds }) });
  return new Orchestrator(rt);
}

before(async () => {
  const u = await createUser({ email: `ftol-${Date.now()}@test.local`, displayName: 'ftol', passwordHash: 'x' });
  userId = u.id;
  const c = await createConversation({ ownerUserId: userId, title: 'ftol-conv' });
  convId = c.id;
});

after(async () => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  await closePool();
});

// A · 全成功回归:三步全成功 → completed,gapCount=0,有 report。
test('全成功 → completed(回归)', async () => {
  const orch = buildOrchestrator();   // FakeO2Adapter 无 failOnToolIds
  const taskId = await planAndSelectDepth(orch);
  const r = await orch.executePhase({ taskId, conversationId: convId });

  assert.equal(r.status, 'completed');
  assert.equal(r.gapCount, 0);
  assert.ok(r.reportArtifactId, '应产出 report');
  const arts = await listArtifacts(taskId);
  assert.ok(arts.some((a) => a.artifact_type === 'report'));
  const workspace = cleanupDirs[cleanupDirs.length - 1];
  const ledger = JSON.parse(readFileSync(join(workspace, 'artifacts', 'evidence-ledger.json'), 'utf8')) as { sources: unknown[]; entries: unknown[] };
  assert.ok(ledger.sources.length >= 2, '每个成功 tool/skill 步都应进入证据台账');
  assert.ok(ledger.entries.length >= 1, '证据台账应提供可引用条目');
  const report = JSON.parse(readFileSync(join(workspace, 'artifacts', 'report.json'), 'utf8')) as {
    report_metadata?: { generation_mode?: string };
    evidence_summary?: { ledger_entry_count?: number };
  };
  assert.equal(report.report_metadata?.generation_mode, 'mock_demo');
  assert.equal(report.evidence_summary?.ledger_entry_count, ledger.entries.length);
});

// B · tool 步失败 → paused,停在该步,后续步未执行,落 run_state。
test('tool 步失败 → paused、后续步未执行、落 run_state', async () => {
  const orch = orchFailingTool(['tavily-web-search']);
  const taskId = await planAndSelectDepth(orch);
  const r = await orch.executePhase({ taskId, conversationId: convId });

  assert.equal(r.status, 'paused');
  assert.equal(r.failedStepNo, 1, '停在失败的第 1 步');

  const log = await listExecutionLog(taskId);
  assert.equal(log.find((l) => l.step_no === 1)?.status, 'failed');
  assert.equal(log.find((l) => l.step_no === 2), undefined, '后续步不应执行');

  const task = await getResearchTask(taskId);
  assert.equal(task?.status, 'paused');

  const wsDir = cleanupDirs[cleanupDirs.length - 1];
  assert.ok(existsSync(join(wsDir, 'run_state.json')), '应落 run_state.json 断点');
});

// C · resume(skip) → 失败步 skipped、后续步续跑、completed_with_gaps、缺口进 risks。
test('resume(skip) → 续跑、失败步 skipped、completed_with_gaps、缺口进报告', async () => {
  const orch = orchFailingTool(['tavily-web-search']);
  const taskId = await planAndSelectDepth(orch);
  await orch.executePhase({ taskId, conversationId: convId });   // → paused

  const r = await orch.resumePhase({ taskId, conversationId: convId, action: 'skip' });

  assert.equal(r.status, 'completed_with_gaps');
  assert.ok((r.gapCount ?? 0) >= 1, '应记录缺口步数');
  assert.ok(r.reportArtifactId, '应产出 report');

  const log = await listExecutionLog(taskId);
  assert.equal(log.find((l) => l.step_no === 1)?.status, 'skipped', '失败步应变 skipped');
  assert.equal(log.find((l) => l.step_no === 2)?.status, 'succeeded', '后续 skill 步应续跑成功');
  assert.equal(log.find((l) => l.step_no === 3)?.status, 'succeeded', 'reviewer 步应续跑成功');

  const report = JSON.parse(
    readFileSync(join(cleanupDirs[cleanupDirs.length - 1], 'artifacts', 'report.json'), 'utf8'),
  ) as { risks_and_open_issues?: string[]; evidence_summary?: { source_count?: number } };
  assert.ok(Array.isArray(report.risks_and_open_issues) && report.risks_and_open_issues.length > 0, '缺口应进 risks_and_open_issues');
  assert.equal(report.evidence_summary?.source_count, 1, '跳过的工具步骤不得伪装为报告证据来源');
});

// D · resume(abort) → failed,不再产新 report。
test('resume(abort) → failed', async () => {
  const orch = orchFailingTool(['tavily-web-search']);
  const taskId = await planAndSelectDepth(orch);
  await orch.executePhase({ taskId, conversationId: convId });   // → paused

  const r = await orch.resumePhase({ taskId, conversationId: convId, action: 'abort' });

  assert.equal(r.status, 'failed');
  const task = await getResearchTask(taskId);
  assert.equal(task?.status, 'failed');
  const arts = await listArtifacts(taskId);
  assert.equal(arts.filter((a) => a.artifact_type === 'report').length, 0, 'abort 不应有 report');
});

// E · 无任何成功产出(产出步全失败/跳过)→ 数据闸门抛 AllStepsFailedError + failed。
// 自定义 fixture:候选 depth 只有 [tool, reviewer],tool 失败跳过后 reviewer 不产出 → toolOutputs 空。
test('全产出步失败/跳过 → AllStepsFailedError + failed', async () => {
  const fixtures = structuredClone(defaultFixtures) as Record<string, unknown>;
  (fixtures['execution-plan-candidates'] as { candidates: Array<{ id: string; steps: unknown[] }> }).candidates[0] = {
    id: 'depth',
    title: '仅检索+复核',
    rationale: 'r',
    tradeoffs: 't',
    steps: [
      { step_no: 1, step_name: '检索', actor_type: 'tool', actor_id: 'tavily-web-search', purpose: 'p', requires_approval: false },
      { step_no: 2, step_name: '复核', actor_type: 'reviewer', actor_id: '复核', purpose: 'p', requires_approval: false },
    ],
    assumptions: [{ key: 'competitors', value: '头部 3 家', editable: true }],
  } as never;

  const rt = buildRuntime({
    llm: new MockLLMClient(fixtures),
    toolAdapter: new FakeO2Adapter({ failOnToolIds: ['tavily-web-search'] }),
  });
  const orch = new Orchestrator(rt);
  const taskId = await planAndSelectDepth(orch);
  await orch.executePhase({ taskId, conversationId: convId });   // step1 失败 → paused

  await assert.rejects(
    () => orch.resumePhase({ taskId, conversationId: convId, action: 'skip' }),
    AllStepsFailedError,
    'reviewer 不产出、tool 跳过后 toolOutputs 空,应被数据闸门拦下',
  );
  const task = await getResearchTask(taskId);
  assert.equal(task?.status, 'failed');
});

// F · 执行进度回调:前端 SSE 需要真实 step 级进度,不能只等最终 executionLog。
test('execute/resume 通过 onProgress 推送 step、synthesis 与暂停进度', async () => {
  const successEvents: Array<{ type: string; stepNo?: number; status?: string }> = [];
  const okTaskId = await planAndSelectDepth(buildOrchestrator());

  await buildOrchestrator().executePhase(
    { taskId: okTaskId, conversationId: convId },
    (ev) => successEvents.push(ev),
  );

  assert.deepEqual(
    successEvents.map((e) => `${e.type}:${e.stepNo ?? ''}:${e.status ?? ''}`),
    [
      'step_started:1:running',
      'step_succeeded:1:succeeded',
      'step_started:2:running',
      'step_succeeded:2:succeeded',
      'step_started:3:running',
      'step_succeeded:3:succeeded',
      'synthesis_started::running',
      'completed::completed',
    ],
  );

  const failing = orchFailingTool(['tavily-web-search']);
  const failTaskId = await planAndSelectDepth(failing);
  const failEvents: Array<{ type: string; stepNo?: number; status?: string }> = [];
  await failing.executePhase({ taskId: failTaskId, conversationId: convId }, (ev) => failEvents.push(ev));

  assert.deepEqual(
    failEvents.map((e) => `${e.type}:${e.stepNo ?? ''}:${e.status ?? ''}`),
    ['step_started:1:running', 'step_failed:1:failed', 'paused:1:paused'],
  );

  const resumeEvents: Array<{ type: string; stepNo?: number; status?: string }> = [];
  await failing.resumePhase(
    { taskId: failTaskId, conversationId: convId, action: 'skip' },
    (ev) => resumeEvents.push(ev),
  );

  assert.deepEqual(
    resumeEvents.map((e) => `${e.type}:${e.stepNo ?? ''}:${e.status ?? ''}`),
    [
      'step_skipped:1:skipped',
      'step_started:2:running',
      'step_succeeded:2:succeeded',
      'step_started:3:running',
      'step_succeeded:3:succeeded',
      'synthesis_started::running',
      'completed::completed_with_gaps',
    ],
  );
});
