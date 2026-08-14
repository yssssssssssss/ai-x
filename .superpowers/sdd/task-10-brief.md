### Task 10: PlanCompiler 和 CurrentPlanStep

**用户收益：** Skill 依赖、步骤顺序、输入来源和验收标准在执行前得到验证。

**Files:**
- Modify: `packages/api-contract/research-deliverable.ts`
- Create: `schemas/current-execution-plan.schema.json`
- Create: `apps/orchestrator-runtime/src/planners/plan-compiler.ts`
- Modify: `apps/orchestrator-runtime/src/planners/problem-graph-planner.ts`
- Modify: `apps/orchestrator-runtime/src/planners/plan-strategy.ts`
- Modify: `apps/orchestrator-runtime/src/planners/routed-planner.ts`
- Modify: `apps/orchestrator-runtime/src/planners/research-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/control-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/schema-registry.ts`
- Modify: `apps/agent-api/src/control-runtime.ts`
- Modify: `database/control-plane.ts`
- Modify: `apps/orchestrator-runtime/src/gold-run.ts`
- Test: `tests/plan-compiler.test.ts`
- Test: `tests/control-planning-service.test.ts`
- Test: `tests/control-plane.test.ts`
- Test: `tests/control-api-integration.test.ts`
- Test fixture migration: `tests/auth-isolation.test.ts`, `tests/control-planning.test.ts`, `tests/current-revision-integrity.test.ts`, `tests/research-planning-service.test.ts`
- Report/progress: `.superpowers/sdd/task-10-report.md`, `.superpowers/sdd/progress.md`

**Scope correction:** Current planning assembly and every revision persistence path must invoke Task8/9 and PlanCompiler before repository insertion. The production runtime, requirement-planning seam, canonical repository revision gate, and existing strict-Current fixtures are therefore part of Task 10; Legacy `PlanStep` and Legacy planning remain unchanged.

**Interfaces:**
- Produces: `CurrentPlanStep`、`PlanCompiler.compile()`。

- [ ] **Step 1: 写失败测试**

覆盖：cycle、孤立 required question、Skill required Tool 缺失、Tool 在 Skill 后、input binding 指向未来步骤、unknown pointer、Core Evidence 缺失、合法 depth/speed。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/plan-compiler.test.ts`

Expected: FAIL。

- [ ] **Step 3: 定义 CurrentPlanStep**

使用设计规格中的 snake_case 字段，不修改 Legacy `PlanStep`。`CurrentExecutionPlan.steps` 改用 `CurrentPlanStep[]`，并新增 `problem_graph` 和 `capability_decisions`。

- [ ] **Step 4: 实现 Compiler**

Compiler 必须：

- 服务端重建 step_no。
- 拒绝未知 actor。
- 检查 question_ids。
- 检查 DAG。
- 检查 required_tools 和顺序。
- 检查 input_bindings。
- 检查 Evidence Policy。
- 计算 Pending Inputs。
- 生成 canonical plan object。

- [ ] **Step 5: 接入 Planning**

`ControlPlanningService` 不再只运行 `sanitizeCurrentSteps`；改为调用 Compiler，并把 Problem Graph 和 Capability Decisions 一起写 Plan Version。

- [ ] **Step 6: 运行测试和提交**

Run: `pnpm exec tsx --test tests/plan-compiler.test.ts tests/control-planning-service.test.ts tests/control-plane.test.ts`

```bash
git add packages/api-contract/research-deliverable.ts \
  schemas/current-execution-plan.schema.json \
  apps/orchestrator-runtime/src/planners/plan-compiler.ts \
  apps/orchestrator-runtime/src/control/control-planning-service.ts \
  apps/orchestrator-runtime/src/planners/routed-planner.ts \
  tests/plan-compiler.test.ts
git commit -m "feat: compile current execution plans"
```

