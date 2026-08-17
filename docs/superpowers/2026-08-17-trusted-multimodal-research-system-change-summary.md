# 可信多模态研究系统修改总结

- 日期：2026-08-17
- 分支：`feat/current-trusted-research-flow`
- 状态：30 项任务全部完成
- 最终审查：APPROVE

## 1. 总体结果

本轮完成了从需求理解、计划编译、可信执行、证据融合，到多模态报告、失败恢复和发布门禁的完整链路。

最终状态：

- 任务：30/30 完成，0 open
- 工作树：干净
- 全量质量门禁：884 tests，873 passed，0 failed，11 real-provider skips
- TypeScript：通过
- Registry lint：通过
- Knowledge lint：通过
- 最终全分支审查：APPROVE

## 2. 完整修改任务清单

### 一、Current 基线与完整性加固

#### 1. 提交 Current 基线实现

具体修改：

- 固化 Current 为唯一新写主链。
- Legacy 保持历史只读，全部 Legacy 写接口返回 `410`。
- Current Task、Conversation、Plan、Attempt、Artifact、Evidence 与 Deliverable 使用独立数据模型。

体验收益：

新任务不会继续写入旧链路，历史数据仍可查看，升级过程不会破坏已有用户记录。

#### 2. 更新冻结 Current 决策文档

具体修改：

- 明确 Current 与 Legacy 边界、状态机、Owner 隔离、失败策略和发布条件。
- 固化模型 pin、Receipt、Lease、Evidence、Report Review 等不变量。

体验收益：

产品规则和失败行为更稳定，后续迭代不容易因实现差异产生行为漂移。

#### 3. 增加 Current 候选严格 Schema

具体修改：

- 新增严格 Candidate Schema。
- 拒绝未知字段、非法 `actor_type`、空步骤、错误编号和 Schema escape。
- 服务端重新生成可信 `step_no`、`step_id` 和 `step_name`。

体验收益：

候选方案结构更稳定，不会出现重复步骤、编号错乱或无法执行的计划。

#### 4. 服务端拥有 Plan Revision Hash

具体修改：

- Plan Hash 改由服务端根据规范化内容生成。
- 使用 Canonical JSON，字段顺序不再影响 Hash。
- Revision 强制重新编译并校验全部绑定关系。

体验收益：

修改方案后不会出现客户端 Hash 漂移、执行旧版本或计划内容与版本不一致的问题。

#### 5. 全部 Step Artifact 使用 Lease Fence

具体修改：

- Tool、Skill、LLM、Reviewer、Evidence、Deliverable、Review、ReportDocument 写入都要求有效 Lease。
- Lease 过期后禁止继续封存 Artifact。
- 增加执行、Review 和报告合成阶段的 Lease 恢复。

体验收益：

旧 Worker 或超时进程不会继续写入过期结果，减少重复交付和报告内容错乱。

### 二、需求澄清闭环

#### 6. 添加 Migration 004 和 ResearchTaskV2

具体修改：

- 新增 Requirement Version。
- 结构化保存研究目标、范围、约束、成功标准、假设、歧义和澄清问题。
- 增加 Artifact 媒体字段。

体验收益：

自然语言需求会沉淀成可版本化、可追踪的研究任务，不再只是聊天文本。

#### 7. 实现 RequirementRefinementService

具体修改：

- 使用会话历史多轮收敛需求。
- 澄清答案生成新 Requirement Version。
- 模型调用使用 actual-model pin 和 Receipt。
- 对话历史按 Owner 隔离。

体验收益：

系统会先理解和收敛需求再做计划，减少答非所问和研究范围失控。

#### 8. 实现 Clarify API、SSE 和 Web

具体修改：

- 增加澄清接口、SSE 进度和前端澄清页面。
- 新会话先发送 Conversation，再持续发送规划进度。
- 页面支持填写必答问题和编辑系统假设。

体验收益：

用户可以看到系统当前理解和缺失信息，并在规划前纠正假设。

#### 9. 修复 Phase 2 澄清完整性阻断

具体修改：

- 增加 durable command reservation。
- 澄清答案、Requirement 激活、候选计划和 Command 完成使用事务和 token fence。
- 支持提交失败重试、响应丢失恢复和浏览器刷新恢复。
- 防止重复点击产生多个 Requirement Version。

体验收益：

网络抖动、重复点击和页面刷新不会重复创建任务或丢失已提交答案。

### 三、问题图和能力编译

#### 10. 实现 ProblemGraph Schema Planner

具体修改：

- 将研究目标拆成具有稳定 ID 的问题图。
- 每个问题绑定优先级、Evidence 要求、成功标准和依赖。
- 校验覆盖率、DAG 无环和模型 Receipt。

体验收益：

复杂研究会明确展示要回答的问题、依赖关系和证据要求，而不是只给出线性步骤列表。

#### 11. 实现 CapabilityResolver

具体修改：

- 按 Task Type、Tool 健康状态、Skill 依赖、输入准备度、风险和审批权限筛选能力。
- 保留 selected 和 rejected 的明确原因。
- Core Tool 必须使用真实合格适配器。

体验收益：

系统不会选中不可用或不适合当前任务的能力，失败会更早暴露且原因更明确。

#### 12. 实现 PlanCompiler 和 CurrentPlanStep

具体修改：

- 将 ProblemGraph 和 CapabilityDecision 编译成严格执行计划。
- 服务端生成 Tool、Skill、LLM、Reviewer 步骤。
- 自动生成 Pending Input、Approval Gate、Evidence Gate 和输出绑定。

体验收益：

用户确认的研究方案可以被执行器直接运行，不再出现“方案合理但执行不了”的情况。

#### 13. 实现 Input Binding 与 Skill Provenance

具体修改：

- 使用 RFC6901 JSON Pointer 绑定步骤输入输出。
- 只读取 SEALED、Hash 正确且 Task、Plan、Attempt 匹配的 Artifact。
- Skill 成功和失败都保留 Receipt 与 Provenance。
- 用户输入通过临时 Overlay 进入执行，不修改冻结计划。

体验收益：

每一步数据来源都能追踪，重试和复盘时可以确认真实输入、输出和能力版本。

#### 14. 修复 Phase 3 编译执行阻断

具体修改：

- 增加通用 Core Tool preflight。
- 修复 Skip 步骤后的编号、依赖和 Pending Input 重映射。
- Revision 重新编译并保留 ProblemGraph 和 Capability Provenance。
- 拒绝未来步骤绑定、数组穿越和原型链路径。

体验收益：

跳过、修订或恢复任务时不容易出现步骤错位、依赖断裂和输入串线。

### 四、结果融合与报告审查

#### 15. 实现 SynthesisMaterializer

具体修改：

- 将 Tool、Skill、LLM、Reviewer 的真实正文统一转成 Synthesis 材料。
- 重新验证 Artifact 绑定和 Hash。
- 对凭证、PII、Prompt 等内容统一脱敏。
- 区分事实、分析、推断和 Reviewer 意见。

体验收益：

最终报告会真正吸收 Skill 分析和 Reviewer 结论，而不是只使用搜索结果。

#### 16. 实现 ReportReviewService 修订循环

具体修改：

- 报告先做 Requirement、问题、Evidence、FindingGraph 等确定性检查。
- 再执行语义 Reviewer。
- 最多允许一次 Revision。
- Model drift、Receipt 失败和未 SEALED Review 都 fail-closed。

体验收益：

报告生成后会经过自动质检和一次有限修订，不会直接交付未经检查的草稿。

#### 17. 实现 Report Package 读取重验

具体修改：

- 读取报告时重新验证 Deliverable、Evidence Manifest、Evidence Artifact、FindingGraph 和 Review。
- Review 必须为最终轮、`pass`，并绑定最终 Deliverable。
- 历史报告使用明确的 `legacy_text` 分支。

体验收益：

即使文件被篡改或引用失效，系统也不会把不可信报告展示给用户。

#### 18. 修复 Phase 4 报告融合审查阻断

具体修改：

- 增加显式 Question 和 Success Criterion Coverage。
- 固定 Revision Artifact 路径和最终 ID。
- 修复 Command-loss replay、Review verdict、failedStepNo 和 Lease 恢复。
- Terminal CAS 失败时统一失效 Manifest、Deliverable、Review 和 ReportDocument。

体验收益：

用户获得的是最终审查版本，不会误拿草稿、旧 Manifest 或孤儿 Artifact。

### 五、专业多模态报告

#### 19. 实现 Binary Artifact Store

具体修改：

- 项目和 CI 升级到 Node 22。
- 使用 `@openclaw/fs-safe` native root 进行安全文件操作。
- 使用 `sharp` 完整解码 PNG、JPEG、WebP。
- 限制 10 MiB、20 MP，拒绝 SVG、APNG、截断、多页和动画内容。
- 增加固定长度读取、Hash 重验、并发路径所有权和 no-clobber。

体验收益：

报告图片不再依赖易失效远程链接，异常、伪造或超大图片不会拖垮页面和服务。

#### 20. 实现 VisualAssetService 和安全图片

具体修改：

- 远程图片下载增加 SSRF 防护、DNS pin 和逐跳重定向检查。
- URL 必须来自已验证 Tool Artifact JSON Pointer。
- 新增 VisualAsset Manifest、原图、标注图和热力图派生关系。
- Asset 接口统一 Owner 404，blocked 内容不可导出。

体验收益：

截图可以稳定加载、放大和追溯来源，内部或敏感图片不会被外部用户读取。

#### 21. 实现可信 Chart SVG Renderer

具体修改：

- ChartSpec 严格校验类型、数据长度、Evidence 绑定和零基线。
- 图表每个数值必须与 Evidence 真实值一致。
- 服务端使用 ECharts SSR 生成并封存 SVG。
- Web 使用懒加载 SVG renderer，并提供表格型文本替代。

体验收益：

用户可以快速阅读对比和趋势，同时每个图表数字都能追溯到真实证据。

#### 22. 实现 ReportDocument 专业模板

具体修改：

- 新增严格 ReportDocument Schema。
- 固定封面、执行摘要、核心指标、发现、问题分析、视觉证据、对比、建议、风险和附录等章节。
- 只消费已验证 Deliverable、Evidence、Asset、Chart 和 Review。
- 没有视觉数据时不生成假占位。

体验收益：

报告从字段列表升级为完整专业文档，更接近真实研究和咨询交付物。

#### 23. 实现 Web、Print PDF 和 Markdown Bundle

具体修改：

- 新增 ReportDocumentView、图片、对比图和 Chart 组件。
- 支持 sticky 章节导航、Evidence 展开、原图和标注图切换、图片缩放。
- 新增 A4 打印样式、页眉页脚、表格重复表头和 SEALED SVG 打印。
- ZIP 包含 Markdown、图片、Manifest、Review 和 ReportDocument，blocked 资产自动排除。

体验收益：

同一份报告可在线交互阅读、打印成 PDF，也能下载 Markdown 和图片继续编辑。

#### 24. 修复澄清完成后的候选规划恢复

具体修改：

- 修复 Requirement 已无歧义，但刷新后仍停在 `awaiting_clarification` 的状态。
- 最新版本和 fresh key 可复用已完成 Requirement，不再重复调用 LLM 或创建新版本。
- 保留旧版本加一、同 key 恢复和 stale fence。

体验收益：

多轮澄清后刷新页面可以继续进入方案选择，不会陷入无限澄清循环。

### 六、多任务 Deliverable

#### 25. 实现 Deliverable Registry v2

具体修改：

- Registry 统一声明 Task Type、Schema、Prompt、Rubric、Evidence Policy 和 Template。
- Planning 阶段冻结选中的 Deliverable 合同。
- Engine、生成、Review、Composition 使用同一 Registry 合同。
- 移除固定 `research_plan` 路径和字符串特判。
- 保留历史持久化计划兼容。

体验收益：

系统可以根据任务类型自动选择正确报告，不再把所有需求都输出成同一种研究计划。

#### 26. 增加四类专业报告模板

具体修改：

新增以下专业报告：

- 竞品分析报告。
- VOC 诊断报告。
- 设计走查报告。
- 无障碍审查报告。

每类报告都有独立 Payload Schema、Synthesis Prompt、Review Rubric、Report Template 和 Evidence Policy。

体验收益：

不同研究任务得到适合业务场景的报告结构，而不是同一个通用模板只替换标题。

### 七、恢复、并行与发布门禁

#### 27. 实现 Tool Retry Policy

具体修改：

- 只重试网络、超时、429 和 5xx。
- Schema、认证、安全、完整性错误不重试。
- 每次尝试有独立 Attempt ID 和 Receipt。
- Sleep 前后重新检查 Lease。
- 最终失败保留全部 Attempt Receipt，不泄露 Actor 原始输出。

体验收益：

短暂网络故障可以自动恢复，明确错误不会浪费时间反复执行。

#### 28. 实现 Checkpoint Resume 和 Retry Lineage

具体修改：

- Retry 创建新 Attempt 并写入 `retry_of`。
- 只有 Plan、Step、Input、Manifest、Schema、Config Hash 全部一致且 Artifact 可信时才复用。
- 复用 Artifact 在新 Attempt 下重新封存并保留来源 Lineage。
- 从第一个失效节点继续执行，下游自动重跑。

体验收益：

长任务失败后不必从头重跑，已经成功的检索和分析可以安全复用。

#### 29. 实现 Execution Recovery 和受控 DAG 并行

具体修改：

- Recovery 覆盖 executing、reviewing、composing_report。
- 只清理本次过期 Attempt 的 Artifact，不影响健康任务。
- Recovery 在服务启动前执行，并通过可容错定时器周期运行。
- 独立步骤按 DAG wave 并行执行。
- 依赖失败阻断下游，Core 失败取消未启动步骤。

体验收益：

Worker 崩溃后任务不会永久卡住，互不依赖的步骤可以并行完成，缩短等待时间。

#### 30. 建立五类 Gold 和发布门禁

具体修改：

- 增加 25 个语义场景，覆盖明确、模糊、缺输入、约束冲突和 PII。
- 覆盖五类 Task Type 及其对应 Deliverable。
- Gold 要求真实 Gateway、模型 pin、真实 Core Tool、SEALED Package 和独立认证 Review。
- Receipt 禁止 Secret、Prompt、Authorization 和 Base64 泄漏。
- CI 和 `.env.example` 提供明确的真实 Smoke 入口。

体验收益：

发布不再只依赖代码测试通过，还要证明五类真实业务流程的理解、执行和报告质量。

## 3. 实际浏览器体验收益

本轮已在桌面浏览器验证 1280×800 和 1440×900 两种分辨率。

### 3.1 长任务过程更透明

用户可以看到需求理解、澄清、候选计划和执行状态。页面刷新后能够恢复，不需要重新开始。

### 3.2 报告更容易阅读

报告具有封面、执行摘要、核心指标、关键发现、建议和风险。Sticky 目录可以直接跳转到对比分析等章节。

### 3.3 Evidence 可以展开

Finding 旁边可以查看绑定的 Evidence。浏览器验收中已验证 Evidence 展开并显示 `e1`、`e2`。

### 3.4 视觉内容可交互

- 图片支持缩放，已验证到 125%。
- 支持原图和标注图切换。
- 图表提供交互视图和可访问表格。

### 3.5 打印和下载更实用

- Print 模式隐藏交互按钮，改用 SEALED SVG。
- 表格打印时重复表头。
- ZIP 内包含 Markdown、图片和 Manifest，方便继续编辑。

### 3.6 失败恢复更自然

- 临时网络失败自动重试。
- Worker 崩溃后可以恢复。
- Retry 从失效步骤继续，不重复全部工作。

### 3.7 不同任务获得不同报告

- 竞品研究：维度矩阵、差异、影响和行动建议。
- VOC：主题、频率、情感、代表原话、严重度和优先级。
- 设计走查：页面问题、设计原则、严重度、标注图、整改和复测。
- 无障碍审查：POUR 原则、控件等级、读屏表现、整改和验证。

### 3.8 安全边界更清晰

- 跨用户资源统一返回 404。
- blocked 图片不展示、不导出。
- 报告读取时重新验证 Hash、Artifact 绑定和 Evidence 关系。

## 4. 最终验证边界

最终本地门禁：

- 884 tests。
- 873 passed。
- 0 failed。
- 11 skipped。
- TypeScript、Registry lint、Knowledge lint 全部通过。
- 最终全分支 Review：APPROVE。

11 个跳过项依赖真实 Gateway、Tavily、JWT 等命令级安全凭证。本轮没有伪造真实外部 Smoke 通过。发布环境仍需安全注入凭证，执行五类真实 Smoke 后再确认外部服务门禁。
