# 原版 Skill 包运行平台

本上下文定义平台如何分析用研需求、选择一个或多个 Skill，并直接运行完整、
未改写的 Skill 包。运行成功不等于研究可用；系统必须忠实暴露材料缺口、能力
缺失和执行失败。

## 规划

**RequirementContext**：任务目标、范围、已有材料、约束、明确假设和仍需澄清的
方向。它只描述任务，不复制各 Skill 的私有输入字段。
_Avoid_: 固定问卷、关键词补造事实、Skill 专用平台 Schema

**Catalog 卡片**：从包根 `SKILL.md` 读取的 `name`、`description` 和可选
`when_to_use`。用于初筛候选，不是第二份 Skill 定义。
_Avoid_: 手写 Skill Registry、同步维护的元数据副本

**候选方案**：供用户选择的 1..N 个 Skill、执行顺序、选择理由、取舍和最终报告
责任方。确认后不得在后台增加隐藏 Skill。
_Avoid_: 固定 Solution YAML、运行中静默换 Skill

**编排模式**：用户选择的 `single_skill` 或 `multi_skill`。两者共用同一运行内核；
Multi 首版只串行执行。
_Avoid_: 双执行引擎、质量等级、自动模式降级

## Skill 包

**SkillPackage**：`skill-packages/` 下的一个直接子目录。根目录的 `SKILL.md` 与
包内 references、scripts、assets、模板和普通文件共同构成唯一运行单元。
_Avoid_: 精简副本、只复制 `SKILL.md`、平台私有 Frontmatter

**SkillPackageDescriptor**：发现阶段读取的轻量卡片与结构状态。未知 Frontmatter
保留但不成为平台门禁。
_Avoid_: 把正文里的 `draft` 当运行开关、猜测依赖

**SkillPackageSnapshot**：计划确认时生成的完整文件清单、执行位、逐文件 hash、
package hash 和任务内快照路径。运行与恢复只读该快照。
_Avoid_: 运行时回读源目录、多版本 Reader、静默漂移

**外部知识快照**：Skill 引用包外路径时，从显式只读挂载首次访问并冻结的目录。
同一任务后续只读冻结副本。
_Avoid_: 任意宿主机路径、相邻目录搜索、自动改写 Skill 路径

## 执行

**Agent Loop**：按冻结 `SKILL.md` 多轮执行一个 Invocation 的运行循环。内部动作
只有 `tool`、`ask_user` 和 `finish`；这些动作只控制运行，不规定业务结果结构。
_Avoid_: 单次固定 Schema 调用、把控制协议当 Skill 输出格式

**Capability Broker**：Package、外部知识、Artifact、授权 Tool/MCP 和脚本沙箱的
唯一入口。不存在的能力返回明确缺失原因。
_Avoid_: Skill 直接访问宿主机、凭据或网络、伪造能力成功

**RuntimeCheckpoint**：活动 Invocation、轮次、工具预算、工作摘要、最近结果、动态
问题和已有回答。`ask_user` 后释放执行资源，回答后从同一快照恢复。
_Avoid_: 用 `paused` 表示等用户、重复已成功的外部调用

**Gap**：材料不足、能力缺失、失败 Skill、冲突或未完成项。Gap 必须进入最终结果，
不得静默删除或用默认内容填充。
_Avoid_: 伪造数据、把 partial 标成 complete

## 结果与报告

**Artifact**：运行结果的事实源，可以是文本或二进制。最小元数据只描述归属、
路径、媒体类型、角色、大小、hash、来源和生成者，不解释文件内部章节。
_Avoid_: 所有 Skill 共用的报告内容 Schema、平行正文副本

**SkillOutcome**：一次 Skill 的状态、摘要、Artifact 引用、Gap 和缺失能力。它不
包含固定章节。
_Avoid_: `ReportResult`、行业专用全局输出合同

**主报告**：任务最终交付引用的一个 Artifact。最终责任 Skill 的模板、样式、脚本
和格式要求优先；已有有效主报告时平台不得再用 LLM 重写。
_Avoid_: 支持 Skill 样式覆盖最终报告、二次套模板

**默认报告**：仅在 Skill 没有规定报告形式时，由模型根据已有 Artifact 生成的自由
结构 Markdown。应结构清晰、描述简洁准确，并在真实数据支持时优先使用图表。
_Avoid_: 固定目录、为可视化编造数字、报告 DSL

**安全预览**：对主 Artifact 的确定性展示。Markdown 经过受限 Renderer；HTML 在
无同源权限、无网络的 sandbox iframe 中展示；不能安全预览的格式提供原文件下载。
_Avoid_: 修改报告事实、远程脚本、第二事实源

## 安全与验收

平台指令高于 Skill 指令。Skill 包、用户材料、外部知识和 Tool 输出均是不可信
内容，不能扩大权限。PackageStore、外部知识、Capability Broker、脚本沙箱和报告
发布各自在唯一可信边界校验一次。

**真实能力闭环**：使用真实输入、真实 LLM 和实际所需能力完成 Single 与 Multi
任务，产物可追溯且由研究员判定可用。缺失 Zero MCP、外部挂载或脚本 Runtime 的
测试必须明确失败，不能为通过验收而修改 Skill。
