import { buildOrchestrator } from './orchestrator.ts';
import { createConversation } from '../../../database/repository.ts';
import { closePool } from '../../../database/db.ts';

// spike:plan —— 段1+段2,生成待确认计划后【停】。HITL 硬闸门:本命令永不执行 tool/skill。
// 用法: pnpm spike:plan "我要为直播场域做一次数字人竞品研究"
//
// 用 seed 用户(database/seed/001_seed.sql)作为归属,新建会话承载本次任务。

const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

async function main(): Promise<void> {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('用法: pnpm spike:plan "<一句话用研需求>"');
    process.exit(1);
  }

  const conv = await createConversation({ ownerUserId: SEED_USER_ID, title: input.slice(0, 40) });
  const orch = buildOrchestrator();
  const result = await orch.planPhase({
    originalInput: input,
    conversationId: conv.id,
    ownerUserId: SEED_USER_ID,
  });

  console.log('\n===== 段1 · 任务理解 =====');
  console.log(`task_type      : ${result.task.task_type}`);
  console.log(`business_domain: ${result.task.business_domain}`);
  console.log(`research_goal  : ${result.task.research_goal}`);
  console.log(`assumptions    : ${result.task.assumptions.map((a) => `${a.key}=${a.value}`).join(' | ')}`);

  console.log('\n===== 段2 · 激活的决策节点(按 applies_to 过滤,非固定 7 步)=====');
  console.log(`  ${result.activatedNodes.join(', ')}`);

  console.log('\n===== 段2 · 待选候选计划(HITL 闸门,未执行)=====');
  for (const cand of result.candidates) {
    console.log(`\n[${cand.id.toUpperCase()}] ${cand.title}`);
    console.log(`  理由: ${cand.rationale}`);
    console.log(`  代价: ${cand.tradeoffs}`);
    for (const s of cand.steps) {
      console.log(`  ${s.step_no}. [${s.actor_type.toUpperCase()}] ${s.step_name} → ${s.actor_id}`);
    }
  }

  console.log('\n候选已写入 run workspace,等待用户选一份。');
  console.log(`task_id       : ${result.taskId}`);
  console.log(`conversation  : ${conv.id}`);
  console.log(`workspace     : ${result.workspaceUri}`);
  console.log(`\n选中后执行: pnpm spike:execute ${result.taskId} ${conv.id} <depth|speed>`);
}

main()
  .catch((err) => {
    console.error('spike:plan 失败:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
