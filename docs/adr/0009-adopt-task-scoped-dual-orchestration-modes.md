# ADR-0009：采用任务级单 Skill 与多 Skill 双引擎

- 状态：Accepted（报告派生路径相关条款由 ADR-0010 取代）
- 日期：2026-08-30
- 上游决策：ADR-0007、ADR-0008

## 背景

主线已经包含多 Skill Portfolio 编排，现有 Editorial Showcase 则在单 Skill 路径上完成了独立验收。产品需要同时保留两套完整能力，并允许用户在创建任务前选择。

Git 分支不能充当运行时开关。若两套能力只存在于不同分支，一次部署只能运行其中一套，前台无法按任务选择。

## 决策

1. 单 Skill 与多 Skill 同时进入一个可部署版本。
2. 用户在创建 Task 时提交 `single_skill` 或 `multi_skill`。
3. 模式写入 Task，并在 Clarification、Revision、Execution、Retry、Report 和恢复期间保持不变。
4. 单 Skill 写 CurrentExecutionPlan v2，使用单 Skill Canonical 和独立 Editorial Showcase。
5. 多 Skill 写 CurrentExecutionPlan v3，使用 Portfolio、Contribution、Ledger、Reviewer 和主线 Report Editorial Pipeline。
6. 两套引擎可以共享 Auth、Task、Lease、Artifact、LLM、Tool 和 Web Shell，不得直接消费对方的中间产物或事实源。
7. 两套引擎之间不做运行时 fallback。模式内原有的安全降级继续保留。
8. `MULTI_SKILL_PORTFOLIO_WRITER_ENABLED` 只控制多 Skill 是否可创建，不代替用户选择。

## 结果

### 收益

- 用户能在同一产品中明确选择执行方式。
- 两套能力可以独立演进、测试和回滚。
- Plan Contract 能直接证明任务使用了哪种引擎。
- 单 Skill 报告形式不会被多 Skill 报告实现覆盖。

### 成本

- Task 增加一个模式字段。
- Planning 和 Report 入口各增加一次分派。
- 单 Skill Showcase 需要独立命名，避免与主线 Showcase 合同冲突。
- 发布前必须分别完成两条真实端到端验证。

## 不采用的方案

- **不同 Git 分支分别部署**：前台无法在一次部署中按任务切换。
- **把单 Skill 吸收到 Portfolio**：无法保留已经验收的单 Skill 行为和报告合同。
- **运行失败后跨模式降级**：用户选择与实际执行不一致，审计不可接受。
- **两套完整平台和数据库**：重复 Auth、Task、Artifact 和运维能力，没有当前需求支撑。

## 回滚

关闭 `MULTI_SKILL_PORTFOLIO_WRITER_ENABLED` 后停止创建新的多 Skill Task。单 Skill 继续运行，已经封存的 Plan v3 和 Artifact 保持可读。
