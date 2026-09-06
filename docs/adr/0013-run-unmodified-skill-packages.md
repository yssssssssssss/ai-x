# ADR-0013：直接运行未改写的 Skill 包

- 状态：Accepted
- 日期：2026-09-06
- 实施方案：`docs/plans/2026-09-06-unmodified-skill-package-runtime-development.md`
- 取代：ADR-0012 中的 Skill 发现、输入、执行和报告合同

## 背景

ADR-0012 虽然删除了多代报告流水线，但仍要求 Skill 增加平台私有的
`native_delivery`、固定输入声明和 `ReportResult`。已有 Skill 因而必须先被
裁剪或改写才能接入，包内 references、scripts、assets 和报告模板也不能作为
一个整体运行。这既降低能力，也让每次接入都产生第二份需要维护的 Skill。

## 决策

1. `skill-packages/<package>/` 是唯一运行包根目录。包只需在根目录提供含
   `name` 和 `description` 的 `SKILL.md`；未知 Frontmatter 原样保留。
2. 计划确认时冻结完整目录、执行位、逐文件 hash 和 package hash。运行与恢复
   只读取冻结快照，不回读源目录。
3. 需求分析、候选匹配、Single/Multi 选择和用户确认继续存在，但不再把
   `SKILL.md` 编译成平台私有输入 Schema。Skill 特有问题由执行中的 Agent Loop
   动态提出。
4. Single 与串行 Multi 共用一个可暂停、可恢复的 Agent Loop。运行时只解释
   `tool`、`ask_user` 和 `finish` 三种内部控制动作；它们不是 Skill 输出合同。
5. 包内文件通过 PackageStore 读取。包外目录必须显式配置只读挂载，并在任务
   首次访问时冻结。Tool、MCP 和脚本统一经 Capability Broker；脚本只能在
   无网络、非 root、资源受限的一次性 OCI 容器中执行。
6. Artifact 是结果事实源。Skill 自带模板、样式、脚本或格式时，其产物直接
   成为主报告；只有 Skill 未规定报告形式时，平台才用自由结构 Markdown Prompt
   生成默认报告。
7. 新任务不读取旧 Skill Registry、Solution、Skill Execution Contract、固定
   输出 Schema 或 `ReportResult`，也不存在 legacy fallback、双写或双读。
8. 缺失 Tool、MCP、运行时或外部知识时，返回明确缺失能力，不修改 Skill 包，
   不伪造成功。Zero MCP 保持关闭，除非部署方以后显式配置并启用发布能力。

## 结果

- 已有 Skill 可以整包复制后直接被发现，作者不必维护平台分叉。
- 包内知识、模板和脚本与 `SKILL.md` 一起版本化并可追溯。
- 平台接口更小：规划、安全能力代理、可恢复执行和 Artifact 交付。
- 运行成功仍取决于部署环境是否提供 Skill 实际需要的能力。
- 旧 Skill-native 数据合同不迁移；执行迁移前必须备份非开发数据库。

## 保留的既有决定

- Single 与 Multi 共用一套执行内核。
- 已确认任务使用冻结快照，源包更新只影响新任务或显式 Replan。
- 可选外部发布失败不改变已经完成的报告状态。

## 被拒绝的方案

### 继续自动生成精简版 Skill

拒绝。它会丢失方法、知识、模板和脚本，并永久制造两份事实源。

### 为原版 Skill 增加适配字段

拒绝。平台应适配通用 Skill 包，而不是要求每个作者理解平台私有合同。

### 保留旧 Runtime 作为 fallback

拒绝。双轨会扩大状态、恢复、报告和测试矩阵，并让错误落到不可预测路径。

### 建立报告结构 DSL

拒绝。Skill 已规定格式时直接遵循；未规定时由默认 Prompt 根据素材组织报告。

## 回滚

代码以切换前提交为回滚点，不设置运行时开关。迁移 018 是破坏性的，数据库
回滚依赖迁移前备份；开发数据库直接重建。已生成 Artifact 可按 hash 独立保留。
