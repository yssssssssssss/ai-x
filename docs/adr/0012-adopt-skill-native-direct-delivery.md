# ADR-0012：采用 Skill 原生直连交付

- 状态：Superseded by ADR-0013
- 日期：2026-09-04
- 实施方案：`docs/plans/2026-09-04-skill-native-direct-delivery-development.md`
- 取代：ADR-0003、ADR-0005、ADR-0006、ADR-0007、ADR-0008、ADR-0009、ADR-0010、ADR-0011 中关于新任务编排与报告生成的决策

## 背景

当前新任务需要同时经过多代 Plan、Compiled／Legacy Invocation、Canonical Deliverable、Review、ReportDocument、Projector、Report Package 和 Editorial Summary。Single 与 Multi 又使用不同执行和报告路径。一个 Skill 的输入或报告章节变化因此扩散到多个合同、存储和展示层。

这些层没有对应当前产品需求。产品主流程只是：理解需求、选择方案、补齐 Skill 输入、执行一个或多个 Skill、交付一份报告。

## 决策

1. 新任务只使用一套 1..N Skill 执行内核。`single_skill` 与 `multi_skill` 是用户选择，不再映射为两套 Plan 或执行引擎。
2. 运行时直接读取 `SKILL.md`。Skill 的 Frontmatter 和正文是用途、输入、Knowledge、Tool、执行方法、报告结构与降级策略的唯一事实源；不再为新任务读取手写 Skill Registry 或独立 Skill Execution Contract。
3. 规划只生成 `SolutionPlan`。用户确认时冻结 Skill 定义快照、内容 hash、依赖、输入绑定、最终报告 Skill 和失败策略；定义更新只影响新任务或显式 Replan。
4. 问询由 Plan 内全部 Skill 的输入声明驱动。系统依次解析对话、上传、权限内数据库、Knowledge 和允许自动调用的只读 Tool，只询问仍未满足的输入；相同输入只问一次。
5. Skill 输出与正式报告统一为 `ReportResult`。内容仅包含标题、摘要、有序章节、来源、Gap 和 `complete | partial | failed` 状态；章节只允许文字、列表、表格和图片。
6. Single Skill 的结果直接交付，不增加报告 LLM。Multi Skill 只由方案指定的最终报告 Skill做一次综合；综合失败时，系统按执行顺序确定性分组已有结果并输出 `partial`。
7. Web、下载与打印消费同一份由系统确定性生成的静态 HTML。模型不生成 HTML、CSS 或 JavaScript；Renderer 不修改研究内容。
8. 普通内部只读任务不经过通用 Legal／Security、Final Review 或内容修复门禁。只保留数据隔离、Tool 权限、脱敏、大小与超时、取消、HTML 安全和外部写入确认等真实边界。
9. 新任务不写 CurrentExecutionPlan v2/v3、Contribution、Canonical Deliverable、ReportDocument、ReportPackage 或 Editorial Summary。历史 Artifact 不回填、不迁移。
10. 切换不使用 Feature Flag、Legacy fallback 或兼容写入。暂未迁移为原生定义的 Skill 在新 Catalog 中明确不可用。
11. 当前 Agent API 的部署合同是单实例。本地启动恢复会把遗留的 `executing` 任务转为 `paused`；在引入带续租的执行 lease 前，不得把同一数据库接到多个并行 API 实例。

## 结果

### 收益

- Skill 的输入、执行和报告结构在一个定义中修改。
- Single 与 Multi 共享状态、恢复和执行语义。
- 报告只有一个事实源，样式修改不触发研究重跑。
- 缺口和失败直接成为 `partial`，不再卡在通用 Review 流程。
- 新定义在下一次规划生效，已确认任务不漂移。

### 成本

- 所有 Active Skill 需要补齐原生输入与报告声明后才能重新可用。
- 新任务与历史任务使用不同持久化合同；历史数据只读。
- 真实发布前必须各完成一次 Single 与 Multi 全真 Smoke。

## 被拒绝的方案

### 在旧 Runtime 旁增加 lite/simple 模式

拒绝。它会增加第三套分派、恢复、报告和测试矩阵，继续放大当前问题。

### 保留旧写入并增加转换层

拒绝。当前没有历史新写入兼容需求。转换层会让新合同继续受旧 Schema 和门禁约束。

### 让模型直接生成最终 HTML

拒绝。报告内容与展示安全边界必须分离；静态 Renderer 足以满足当前 Web、下载和打印需求。

### 把评审判断机械化为运行时规则

拒绝。研究质量通过离线真实运行和研究员评审校准，不增加封闭错误码、规则引擎或通用审批流。

## 迁移与回滚

- 首条纵切使用 `industry-market-analysis`，Multi 方案增加一个支持 Skill，并以同一 Skill 作为最终报告 Skill。
- 未迁移 Skill 在 Catalog 中返回明确原因，不回退到旧引擎。
- 每个已确认任务持有完整定义快照；进程恢复不重新读取当前定义。
- 删除新任务对旧 Plan、Report、Review、Projector、Package 和审批路径的引用后完成切换。
- 回滚只删除本独立 Worktree 和分支；不修改原工作区或历史数据。

## Premise Collapse

本决策假设主要交付物是供人阅读的研究报告。如果出现已确认的机器消费方，为对应 Skill 增加独立结构化导出；不得重新把 Runtime 或 Renderer 扩张为通用数据平台。
