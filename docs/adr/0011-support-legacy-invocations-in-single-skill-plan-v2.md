# ADR-0011：在 Single Skill Plan v2 中表达 Legacy Invocation

- 状态：Accepted
- 日期：2026-09-02
- 关联：ADR-0003、ADR-0009、ADR-0010
- 实施方案：`docs/plans/2026-09-02-single-skill-v2-and-gap-reconciliation-repair.md`

## 背景

ADR-0003 允许没有 Skill Execution Contract 的 Skill 继续使用 `legacy_single_call`；当时只有 compiled Skill 会生成 CurrentExecutionPlan v2。

ADR-0009 和 ADR-0010 后续冻结了 Task 级双编排模式：

```text
single_skill → CurrentExecutionPlan v2
multi_skill  → CurrentExecutionPlan v3
```

当前 24 个 active Skill 中，5 个为 compiled，19 个仍为 `legacy_single_call`。因此新建 `single_skill` Task 选择 Legacy Skill 时可以真实执行，却不会写入 Plan v2 或 `skill_invocations`，与最新模式合同不一致。

## 决策

1. 所有新建或重规划的 `single_skill` Task 一律写 CurrentExecutionPlan v2。
2. CurrentExecutionPlan v2 的 Skill Invocation 是判别联合：

```text
compiled
legacy_single_call
```

3. Compiled Invocation 继续冻结 Execution Contract、Hash、Knowledge、Reference、Resource Gap 和 Stage。
4. Legacy Invocation 只记录真实存在的身份和 Step 绑定：

```text
invocation_id
skill_id
execution_mode = legacy_single_call
step_nos
```

5. Legacy Invocation 不得包含或伪造 compiled-only 字段。
6. `single_skill` 新计划或 Revision 必须恰好包含一个 Skill Invocation；候选中出现多个独立 Skill 时在持久化前拒绝，不自动切换到 `multi_skill`。
7. Legacy Skill 继续按现有单步 Runtime 执行；`degraded` 默认形成 Gap。Resume 跳过前置可选步骤时保留 Invocation ID，只重映射 `step_nos`。
8. `multi_skill` 继续使用 CurrentExecutionPlan v3，不改变 Portfolio、Contribution 和 Ledger 合同。
9. 历史未版本化 Plan 继续只读，不回填、不迁移。

## 结果

### 收益

- Task 编排模式与 Plan Version 一致。
- Legacy Skill 获得明确 Invocation 身份和 Step 所有权。
- `$skill-id` 直呼 Legacy Skill 也能形成 Plan v2。
- 不需要一次性迁移 19 个 Skill Execution Contract。
- Compiled Skill 的强冻结语义保持不变。

### 限制

Legacy Invocation 不具备：

- Contract Hash。
- Stage 展开。
- Knowledge 冻结。
- Reference Hash。
- Stage 级 Retry／Resume。

这些能力仍需该 Skill 后续显式迁移为 compiled 才能获得。

## 被拒绝的方案

### 写空 `skill_invocations`

拒绝。无法表达实际运行 Skill，也不能建立 Step 所有权。

### 为 Legacy Skill 伪造 Execution Contract

拒绝。不存在的 Contract、Stage 和 Hash 会破坏审计可信度。

### 一次性迁移全部 Legacy Skill

拒绝。本次目标是统一 Plan 合同，不是重做全部 Skill 执行拓扑。

### 继续允许 Single Skill 写未版本化 Plan

拒绝。与 ADR-0009／ADR-0010 和已确认产品合同冲突。

## 对既有决策的影响

- ADR-0003 关于 Legacy Skill 可以继续单步执行的决策保持有效。
- ADR-0003 中“Legacy Skill 不生成 Plan v2”的历史实现约束被本 ADR 取代。
- ADR-0009／ADR-0010 的 Task 级模式、Plan v2/v3 分派和禁止跨模式 fallback 保持有效。
