### Task 23: Checkpoint Resume 和 Retry Lineage

**用户收益：** 重试只从失败步骤继续，已成功的检索、分析和图片资产不会全部重跑。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/checkpoint-resolver.ts`
- Modify: `database/control-plane.ts`
- Modify: `apps/orchestrator-runtime/src/control/task-workflow.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/checkpoint-resume.test.ts`

**Interfaces:**
- Produces: `retry_of`、`ReusableCheckpoint[]`。

- [ ] **Step 1: 写失败测试**

覆盖：复用成功前序、input hash 变化重跑、manifest/schema/config hash 变化重跑、tampered artifact 重跑、下游依赖重跑、retry_of lineage。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/checkpoint-resume.test.ts`

Expected: FAIL。

- [ ] **Step 3: 修改 claimExecution**

Retry command 创建新 Attempt 时写 `retry_of=previousAttemptId`，不再把 retry 仅变回 ready 且丢失 lineage。

- [ ] **Step 4: 实现 Checkpoint Resolver**

仅复用 Plan/Step/Input/Manifest/Schema/Config Hash 全部一致且 Artifact SEALED 的步骤；把 reusable outputs 注入执行上下文，从第一个失效节点开始执行。

- [ ] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/checkpoint-resume.test.ts tests/task-workflow.test.ts tests/lease-execution-engine.test.ts`

```bash
git add apps/orchestrator-runtime/src/control/checkpoint-resolver.ts \
  database/control-plane.ts \
  apps/orchestrator-runtime/src/control/task-workflow.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/checkpoint-resume.test.ts
git commit -m "feat: resume current execution from checkpoints"
```

