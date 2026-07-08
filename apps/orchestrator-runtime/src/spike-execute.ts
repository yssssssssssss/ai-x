import { buildOrchestrator } from './orchestrator.ts';
import { getResearchTask, listExecutionLog, listArtifacts } from '../../../database/repository.ts';
import { closePool } from '../../../database/db.ts';

// spike:execute —— 段3+段4,读已确认的 plan.json 执行,写 execution_log,产出报告。
// 用法: pnpm spike:execute <task_id> [conversation_id]
// HITL:本命令与 spike:plan 物理隔离——只有先 plan 生成 plan.json,execute 才能读到并执行。

async function main(): Promise<void> {
  const taskId = process.argv[2]?.trim();
  if (!taskId) {
    console.error('用法: pnpm spike:execute <task_id> [conversation_id]');
    process.exit(1);
  }

  const task = await getResearchTask(taskId);
  if (!task) {
    console.error(`task 不存在: ${taskId}`);
    process.exit(1);
  }
  const conversationId = process.argv[3]?.trim() || task.conversation_id;

  const orch = buildOrchestrator();
  console.log(`\n===== 段3 · 执行(task ${taskId})=====`);
  const { reportArtifactId } = await orch.executePhase({ taskId, conversationId });

  const log = await listExecutionLog(taskId);
  for (const s of log) {
    console.log(`  step ${s.step_no} [${s.actor_type.toUpperCase()}] ${s.actor_id} → ${s.status}`);
  }

  console.log('\n===== 段4 · 交付 =====');
  const artifacts = await listArtifacts(taskId);
  for (const a of artifacts) {
    console.log(`  [${a.artifact_type}] ${a.title} → ${a.storage_uri}`);
  }
  console.log(`\n报告 artifact_id: ${reportArtifactId}`);
  console.log('全链路留痕已入库(execution_log / artifacts / decision_states)。');
}

main()
  .catch((err) => {
    console.error('spike:execute 失败:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
