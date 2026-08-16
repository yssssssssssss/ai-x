### Task 20: Deliverable Registry v2 Runtime

**用户收益：** 系统能按任务选择正确报告，不再把所有需求塞进 research_plan。

**Files:**
- Modify: `orchestrator/deliverable-registry.yaml`
- Create: `apps/orchestrator-runtime/src/report/deliverable-registry.ts`
- Modify: `harness/linters/registry-linter.ts`
- Modify: `apps/orchestrator-runtime/src/report/current-deliverable-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/deliverable-registry-v2.test.ts`

**Interfaces:**
- Produces: `resolveDeliverable(taskType, expectedDeliverables)`。

- [x] **Step 1: 写失败测试**

覆盖缺 schema/prompt/rubric/policy/template、重复 task mapping、unsupported task type、inactive deliverable、research_plan happy path。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/deliverable-registry-v2.test.ts`

Expected: FAIL。

- [x] **Step 3: 实现 Registry Loader**

Runtime 解析并验证 v2 Registry；DeliverableService 不再直接引用固定 research-plan schema path；Engine 不再硬编码 `deliverable_type === research_plan`。

Review-blocker implementation fact (2026-08-17): Planning resolves and passes an explicit Registry-selected id/policy; Compiler freezes it without global lookup and preserves legacy calls; the direct RED helper supplies the same `FrozenDeliverableSelection`; the report pipeline consumes selected schema/prompt/rubric/template; aliases are exact and explicit; Engine governs resources by canonical id without rebinding legacy plan evidence. Task 21 mappings now close this pipeline for all five task types. Main observed the final joint eight-file suite at 202 total / 201 pass / 1 existing provider skip / 0 fail; `pnpm typecheck`, `registry-linter`, and `knowledge-linter` passed. This worker ran no command and created no commit.

- [ ] **Step 4: 运行测试和提交**

Run: `pnpm exec tsx --test tests/deliverable-registry-v2.test.ts tests/current-deliverable-service.test.ts`

```bash
git add orchestrator/deliverable-registry.yaml \
  apps/orchestrator-runtime/src/report/deliverable-registry.ts \
  harness/linters/registry-linter.ts \
  apps/orchestrator-runtime/src/report/current-deliverable-service.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/deliverable-registry-v2.test.ts
git commit -m "feat: resolve current deliverables from registry"
```

