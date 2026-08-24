# 通用多 Skill 组合编排采用 Portfolio、单一 Synthesizer 与贡献账本

- 状态：Accepted
- 日期：2026-08-24
- 上游决策：ADR-0003、ADR-0004、ADR-0005、ADR-0006

## 背景

现有 Compiled Skill 能把一个 Skill 的内部阶段展开为确认前可见、执行时冻结的 DAG，但答案型研究任务仍会把整个任务硬编码到一个 umbrella Skill。复杂需求即使同时包含市场、Persona、JTBD、指标和虚拟用户等独立能力义务，也无法证明对应 Specialist Skill 被选择和执行；最终报告也没有逐项说明各 Skill 贡献如何进入 Canonical Deliverable。

## 决策

1. 所有 Task Type 共用一套 1..N Skill Portfolio 编排能力。简单任务可以只有一个 Skill；复杂任务必须覆盖全部 Required Question、Requested Artifact、Evidence 和方法义务，不以“多 Skill”数量本身作为目标。
2. 保留 ProblemGraph v1，并在规划层新增 Capability Demand Graph。Demand 表达待覆盖的问题、产物、证据和输入义务；Skill 是满足 Demand 的候选能力，两者不得混为同一概念。
3. 每个 Required Question 恰好一个 Analysis Owner，并可有至多一个 Corroborator。每个顶层 Deliverable 恰好一个由 Deliverable Registry 指定的 Synthesizer，LLM 不得临时替换该 owner。
4. Contributor 独立生成可封存、可追溯的 Research Contribution；Synthesizer 只消费受控 Contribution Bundle，并由跨 Skill Reviewer 处理覆盖、冲突、遗漏和证据边界。
5. 每个 Contribution Unit 必须在 Contribution Ledger 中恰好一次标记为 included、merged、conflicted 或 omitted。静默删除、无来源新增事实和未经授权的语义改写均失败关闭。
6. Reviewed Canonical Deliverable 继续是唯一正式报告真相源。Step 10 仍只执行无损 Canonical 编译；Contributor Artifact 和未 Review 的内容不得直接进入正式报告或发布。
7. Portfolio 及每个 Compiled Skill 的内部阶段共同展开为一个确认前可见的冻结 DAG，并复用现有 Scheduler、Lease、Artifact、Tool 与审批机制。不得创建隐藏嵌套 Agent、第二套调度器或执行时新增步骤。
8. 新写入使用 CurrentExecutionPlan v3；v1/v2 Reader 与冻结语义继续保留。未声明 composition 合同或无法确定性适配 Contribution 的 Skill 保持 standalone。
9. 默认 writer 在完成合同、执行、报告、UI、全 Task Type fixture 和代表性真实链路验收前保持 inactive；回滚只停止新 v3 写入，不修改历史 SEALED Artifact。

## 结果

### 收益

- 专业能力的选择、执行、证据和最终映射可以独立审计。
- Skill 内多 LLM 方法与 Skill 间组合同时保留，而不引入隐藏执行层。
- Contributor 可并行、单独重试或按 required/optional policy 降级。
- Canonical 与报告保真门禁可以检测跨 Skill 的遗漏、冲突和伪造。

### 成本

- Registry、Plan、Contribution、Ledger、Reviewer、报告和 UI 都需要新增兼容合同。
- 首批 Specialist Skill 必须逐个证明能原生输出或确定性适配标准 Contribution。
- 复杂任务的调用、Artifact、Token 和可见步骤会增加，需要复用现有 Profile 与 Usage/Tool Budget 约束。

## 被拒绝的方案

- **只给所有 Skill 增加 `research_synthesis` task type**：无法证明输入、证据和输出合同兼容。
- **继续扩充单个 umbrella Skill**：不能证明 Specialist Skill 独立执行，也无法形成贡献级审计。
- **让模型自由选择 Synthesizer 或运行未冻结 Skill/Tool**：破坏 Registry、审批、预算和计划冻结。
- **每个 Skill 各自产出完整报告**：产生多个真相源、重复内容和不可控冲突。
- **隐藏嵌套 Agent/Skill**：使计划卡片与真实执行再次不一致。

## Premise Collapse

本决策假设首批 Specialist Skill 能原生输出或被确定性 Adapter 转换为标准 Research Contribution。若某个 Skill 无法保留 Question、Evidence、Confidence 和来源映射，它必须保持 standalone 或修改自身输出合同；不得使用猜测性 Adapter，也不得退回由 umbrella Skill 静默代做全部分析。

## 关联文档

- 开发方案：`docs/plans/2026-08-24-universal-multi-skill-orchestration-development.md`
- 执行清单：`docs/plans/2026-08-24-universal-multi-skill-orchestration-todolist.md`
