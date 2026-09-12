# AI-X 可靠性修复、架构收敛与报告质量提升开发方案

> 日期：2026-09-12
> 状态：开发设计文档，待实施；不代表代码已经修复或发布验收已经通过。
> 代码基线：`ff97f5ce4927235ceb39c05710813eb60c005dd4`，分支 `fix/single-skill-v2-gap-reconciliation`，包含审查时工作区中的未提交修改。
> 授权范围：本次仅生成本文档；实施、真实模型调用、提交、发布和部署需另行明确授权。
> 适用对象：后端、前端、研究能力维护者、测试与独立研究员。

## 阅读索引

- [1. 目标、范围与约束](#scope)
- [2. 已有能力、问题与设计决策](#decisions)
- [3. 目标架构与模块责任](#architecture)
- [4. 数据与接口合同](#contracts)
- [5. 正确性与安全修复](#repairs)
- [6. 研究与报告能力优化](#quality)
- [7. 评测基线与科学验证](#evaluation)
- [8. 六批实施计划](#delivery)
- [9. 自动化测试与执行命令](#testing)
- [10. 依赖、配置与诊断](#dependencies)
- [11. 发布、失败处理与回退](#release)
- [12. 完成标准与交接清单](#acceptance)
- [13. 依据与参考](#references)

<a id="scope"></a>
## 1. 目标、范围与约束

### 1.1 目标

本方案同时处理三类问题，但分别验证，避免把一次大重构误当作质量提升的证据。

| 方向 | 目标 | 成功证据 |
|---|---|---|
| 正确性 | 权限、状态、回执、并发、来源和缺口保持一致 | 可复现的缺陷回归与故障注入通过 |
| 架构 | 一个当前 Plan 合同、一套执行基础设施、一份正式报告事实源 | 生产版本分支和重复解释链删除，既有有效场景仍可用 |
| 研究质量 | 答案有依据、方法适用、建议可执行、局限不隐藏 | 固定任务对照、独立研究员评审与人工修改量记录 |

代码量、模型调用次数和完成率是辅助指标，不能替代研究可用性。不得通过放宽证据要求、删除必答内容或把失败改为成功来制造提升。

### 1.2 范围

- API 与工作流：审批归属、命令幂等、状态原子性、报告读取与摘要生成。
- 执行与数据：Plan 冻结、Lease/Fencing、Artifact、视觉来源映射、Gap 传播。
- 架构：规划入口、执行职责、正式报告投影、依赖方向与退休路径。
- 研究能力：Plan、证据准备、三个核心 Skill、综合、审校、摘要与完整报告。
- 质量工程：多案例评测、确定性回归、真实 smoke、Gold 与独立研究员验收。

### 1.3 不做的事情

- 不新建通用工作流 DSL、第二套调度器、事件溯源平台、配置中心或评测平台。
- 不新增运行时自由选 Tool/Skill、隐藏嵌套 Agent 或无上限的模型修订循环。
- 不批量重写全部 Skill，不为所有单次 Skill 伪造 Execution Contract。
- 不引入新的 ReportResult 与 Reviewed Canonical 并列保存同一事实。
- 不建设历史兼容层、双写、迁移垫片或回填历史 Task/Plan/Artifact。
- 不重做全部 UI，不复制某份优秀报告为所有任务的固定模板。
- 不自动提交、创建 PR、调用外部发布接口或部署。

### 1.4 实施约束与规模检查

遵守 [AGENTS.md](../../AGENTS.md)：KISS、YAGNI、可信边界校验一次、不机械化研究判断。遵守 [真实 LLM 开发流程](../agents/real-llm-development-workflow.md)：先固定本地合同、测试与诊断，再做真实单路径和第二路径校准。

本方案跨越超过 8 个现有文件，按六批交付。最小版本是先完成批次 1、2，项目即可获得安全和验证收益；批次 3—6逐步完成架构与质量目标，不是首批修复的前置条件。新增服务为零。必要的新增面仅包括一个摘要 POST、替代旧版本的当前 Plan 合同、多案例评测身份，以及 HTML/CSS 解析依赖；不增加公共配置开关。

当前工作区已有大量用户修改。实施者必须重新读取工作区状态，保留全部无关修改；不得以清理基线为由 reset、stash 或删除未跟踪文件。

<a id="decisions"></a>
## 2. 已有能力、问题与设计决策

### 2.1 不是从零建设研究能力

当前系统已经具备需求澄清、问题图、冻结执行阶段、证据绑定、直接答案、反证、策略对象、行动优先级、最终审校、Canonical 与双报告能力。研究策略链的阶段定义见 [research-strategy-synthesis.yaml](../../orchestrator/skill-executions/research-strategy-synthesis.yaml)。

本次应优化这些能力的输入、责任与有效性，而不是重复建设。证据盘点和审校步骤存在，不等于实际报告质量已经达标。

### 2.2 修复与实验分开

| 类别 | 当前依据 | 本次处理 |
|---|---|---|
| 正确性缺陷 | owner 角色与实际归属混用；状态与回执分开提交；摘要锁与 GET 副作用；视觉引用过宽；前端异步与假设提交问题 | 按第 5 节修复，添加失败先行的回归 |
| 架构债务 | Plan、报告多版本与多重 Writer/Reader，执行模块承担报告职责，反向依赖 | 按批次 3 收敛，不增加第三套长期生产路径 |
| 已有能力 | 知识注入、证据盘点、反证、审校、摘要与详情 | 保留有效职责，去除重复实现 |
| 待验证假设 | 逐字搬运贡献可能妨碍归纳；多次中间加工可能损失信息；部分 Skill 指令与运行环境不符 | 固定输入做对照，不预先宣称报告必然改善 |

本文的代码依据来自前序审查及文档编写时的源码核对；没有在本文编写过程中重新执行全量测试或真实模型验收。历史审查结果不得被当作实施后的通过证明。

### 2.3 对原轻量化方案的修正

相对 [2026-09-11 轻量化总结](2026-09-11-architecture-simplification-summary.md)，采用以下决定：

1. 统一的是 Plan 和执行基础设施，不取消 Contributor、最终答案负责者及依赖语义。
2. 保留 Reviewed Canonical，不新增重叠的正式事实容器。
3. Single 结果只有满足当前任务的交付合同才能直接成为终稿；允许确定性组装，不强制额外模型综合。
4. 默认一次主体综合；允许基于明确审校意见的一次局部修订，不允许无限全文重写。
5. 可以删除独立 Ledger/Review 的重复实现，但来源追溯、关键贡献处置、冲突与遗漏审校不能删除。
6. 措辞和布局问题可非阻断；影响核心结论的方法错误、无依据事实和缺失的必需交付不得统一降为 Warning。
7. “校验一次”指一次可信边界内不重复解释；请求授权、重新读取不可信存储、发布当前绑定仍各有必要边界。
8. 保留同源详情和编辑摘要。摘要显式生成，失败不影响正式详情。

### 2.4 ADR 调整

批次 3 新增一份取代性 ADR，明确替代范围；本文本身不自动修改既有 Accepted 决策。

| 决策 | 保留 | 需要取代的内容 |
|---|---|---|
| ADR-0003 | 冻结可见执行、真实 Knowledge/Tool、诚实降级 | 多版本兼容与历史 Runner 保留要求 |
| ADR-0004 | plan/answer 区分、直接答案、请求交付物实体化 | 不改变其研究目标 |
| ADR-0006 | 结构修复无权全文改写、明确目标的语义修订、失败草稿边界 | Step 编号与旧 ReportDocument 投影形式不作为永久架构 |
| ADR-0007 | 专业分工、唯一最终答案责任、来源与冲突处置 | 独立账本及多个侧车重复记账、旧版本 Reader |
| ADR-0008 | 内容结构、无损展示、派生表达不新增事实 | 多代 ReportDocument/Package 和生产 Showcase 链 |
| ADR-0009/0010/0011 | 用户选择并冻结模式、禁止跨模式隐式回退、摘要与详情同源 | v2/v3 双合同分派及相关兼容要求 |

同步更新 CONTEXT.md 中的实现性定义，但不降低研究员验收、证据边界和内容失败的语义要求。

<a id="architecture"></a>
## 3. 目标架构与模块责任

```text
Web / HTTP
    │ 用户身份、明确的读取或命令
    ▼
Requirement + Planning
    │ 问题、交付物、输入、责任、预算、审批
    ▼
统一 Frozen Plan
    ▼
Execution Engine ──► Knowledge / Tool / Skill
    │                真实执行、Receipt、来源
    ▼
Skill 结果 + Evidence + Gap
    ▼
最终内容负责者：综合与审校
    ▼
无损 Canonical 编译与封存
    ▼
Reviewed Canonical（唯一正式事实源）
    ├──► 确定性完整报告 / 打印 / 下载
    └──► 显式编辑摘要生成 ──► 安全、保真检查 ──► 派生摘要
```

以上是逻辑责任，不要求每个框增加目录、服务或抽象基类。

| 模块 | 保留责任 | 不再承担 |
|---|---|---|
| Requirement/Planner | 明确任务结果、形成能力责任、冻结可执行计划 | 用 Skill 数量或关键词替代需求判断 |
| Input Resolution | 一次解析和验证输入归属、资料权限及绑定 | 为每层重复构造同一套输入 |
| Execution Engine | 调度、Lease、Retry、Actor、Artifact 提交与恢复 | 报告版本路由、编辑表达、HTML 生成 |
| 最终内容模块 | 消费真实结果，形成可审校终稿，执行局部修订 | 再次执行 Contributor 已负责的整段研究 |
| Canonical/报告模块 | 无损编译、绑定验证、读取聚合、确定性展示 | 在展示阶段重新研究或改变结论 |
| Summary Pipeline | 基于已审事实编辑摘要、显式发布 | GET 自动生成、补充新事实、修改正式报告状态 |
| Repository | 事务、状态版本、幂等、查询、持久化约束 | 导入 Planner 或重新解释完整研究语义 |

ControlRuntime 仅装配实际依赖。公共类型放在 packages/api-contract；Web 不导入服务端报告实现。复用现有 Artifact Publication Group 的提交与补偿能力，不重新设计一套 Saga。

<a id="contracts"></a>
## 4. 数据与接口合同

### 4.1 当前 Plan

采用一个替代 v2/v3 的当前合同，版本标记为 `current-execution-plan-v4`；不是同时保留四套生产 Reader。现有公共类型名称收敛为 CurrentExecutionPlan。更新现有 current-execution-plan.schema.json 并删除退休版本 Schema 与分派。

必须保留的信息：

| 信息 | 约束 |
|---|---|
| Task、Requirement、Plan 身份 | 绑定当前任务、已确认需求和 PlanVersion，不能跨任务复用 |
| 模式 | 来源于用户已冻结选择；Single 恰好一个 Invocation；Multi 按责任需要选择，不以数量评质量 |
| 问题与请求交付物 | 每个必需责任有明确负责者；不只保存章节名称 |
| Invocation | Skill 身份、角色、负责问题、输出合同、依赖、必需性、失败策略、实际 Step 绑定 |
| 执行方式 | 保留 compiled 与既有 legacy_single_call 判别；后者只是当前单次调用方式，不保留旧引擎 |
| compiled 冻结内容 | Execution Contract、Knowledge、references 及必要 hash；单次调用不得伪造这些字段 |
| Steps | Tool/Knowledge/LLM/Reviewer 等真实可见步骤、输入绑定与调用预算 |
| Gap 与来源 | 冻结时已知缺口、规划来源与后续诊断可追溯 |

不新建第三份问题图。沿用现有 ProblemGraph 和能力需求表达，删除可以从同一数据确定性推导的重复记录。Skill 内阶段仍可多步；统一 Plan 不等于把所有 Skill 改为一次模型调用。

冻结边界完整校验结构、权限和绑定；执行前检查当前 Plan、关键合同与资源身份是否漂移。执行中不得新增未授权的 Tool。修订产生新 PlanVersion 并重新确认，不修改已封存计划。

### 4.2 正式内容与派生展示

Reviewed Canonical 指封存的 Canonical 及其绑定的 Evidence、Review 的可信读取聚合，不复制成新的事实 Artifact。保留当前各类 Deliverable 的专业 Payload；统一的是外层生命周期和来源约束。

- 正式内容保留答案、发现、请求产物、行动、证据、置信边界、限制与开放问题。
- 原始 Skill 结果继续封存，供诊断与引用，不是第二份正式报告。
- 删除旧 ReportDocument/ReportPackage 的生产版本链。展示可使用内部类型化投影，不再让每个投影产生独立事实 Schema。
- 完整 HTML、Markdown 与下载包由同一可信内容确定性派生；GET 可在内存中渲染或打包，但不调用模型、不持久化文件。
- 摘要来源由 Canonical、Evidence、Review、需求、语言及生成身份共同确定；停止把旧 Package 链当作事实根。
- 摘要 Manifest 发生来源字段变化时使用单一新版本替换旧 Reader，不原地偷改旧版本语义。
- 发布、回读、下载使用同一安全边界；读取并验证后传递同一份字节，避免验证后重新打开另一份文件。

删除 Package 链时，必须同步修改 Gold、smoke、Zero Publication 和下载路径对 Package 的引用，使其绑定当前 Canonical 身份；不得为了让旧消费者继续工作而伪造 Package ID。

### 4.3 摘要 API

复用现有鉴权和 API 前缀，新增一个命令接口，不增加通用 Job 服务。

| 方法与路径 | 行为 |
|---|---|
| POST /control-tasks/:id/reports/:attemptId/editorial-summary | 显式请求生成当前已审内容的摘要；命中相同生成身份时复用结果 |
| GET /control-tasks/:id/reports/:attemptId/editorial-summary.html | 只读取已封存摘要；不存在时明确未生成 |
| GET /control-tasks/:id/reports/:attemptId/html-bundle | 只提供同源完整报告下载，不隐式生成摘要 |

POST 请求不接收客户端提供的正文、来源清单或 RequestKey；这些由服务端可信输入生成。响应沿用共享 HTTP 合同，返回 taskId、attemptId、requestKey、publicationId、reportUrl 和是否命中缓存。

| 情况 | HTTP 处理 |
|---|---|
| 本次生成并发布成功 | 201，返回产物定位 |
| 相同身份已有结果 | 200，返回同一产物 |
| 未登录 | 401 |
| 非任务所有者或任务不存在 | 404，不泄露任务存在性 |
| Attempt 过期、尚未满足正式交付、同请求生成中 | 409，返回脱敏原因 |
| GET 尚无摘要 | 409，明确未生成，不补生成 |
| 模型服务暂不可用 | 503，保留详情 |
| 生成或保真失败 | 返回失败，保留详情；不冒充生成成功 |
| Artifact 完整性失败 | 拒绝读取，不重新生成掩盖损坏 |

RequestKey 包含任务/Attempt、正式来源 hash、Prompt 语义版本与模型路由身份。实际模型身份仍由 Receipt 记录。变化后产生新身份，不能复用旧缓存。前端只在用户点击生成时 POST；挂载、刷新、切换任务和下载都只能 GET。

<a id="repairs"></a>
## 5. 正确性与安全修复

### R1：审批实际归属

涉及 [审批路由](../../apps/agent-api/src/routes/control-tasks.ts)、[工作流](../../apps/orchestrator-runtime/src/control/task-workflow.ts)、[Repository](../../database/control-plane.ts)。

- owner 闸门同时校验 Task 与 Conversation 的实际所有者，不接受“角色为 owner”替代归属。
- legal/security 继续按既有 Authority 规则授权，不扩张为任意任务控制权限。
- Gold 专用身份和服务限制保持；不能借普通 owner 流程绕过。
- 在命令提交的可信边界校验当前 Task、Plan、Gate 和 actor；幂等回放不能成为越权入口。
- 列表、详情和动作权限使用同一业务规则，避免只修 POST 却继续泄露审批任务。

回归：两个普通用户、合法专业审批者、过期 Plan、错误 Gate、相同请求重放与伪造角色；非所有者请求不得新增 Gate 或 Command 记录。

### R2：工作流状态与命令回执原子化

- approval 的 Gate、状态变更和 Command 回执在一个短事务中提交。
- revision 的新 Plan、当前 Plan 指针、状态版本和回执在一个短事务中提交。
- resume 的 Attempt/Step 恢复、Task 状态和回执在一个短事务中提交。
- 复用现有 control_commands 的唯一性、请求 hash 与占位身份，不建设通用命令框架。
- 模型和网络调用不进入数据库事务。需要先生成 Plan 的命令先占位，完成后以状态版本和占位身份提交；失去占位的旧执行者不能覆盖新结果。
- 删除依靠最终状态“猜测并补写成功回执”的恢复捷径；没有同一命令的提交证据就不能声称已执行。

回归：在每个写入点注入异常，数据库恢复到完整旧状态或完整新状态；并发同键得到一致结果，同键不同 hash 冲突；旧版本不得越过 CAS。

### R3：HTML/CSS 安全边界

涉及 [摘要生成器](../../apps/orchestrator-runtime/src/report/editorial-summary-generator.ts)、[摘要存储](../../apps/orchestrator-runtime/src/report/editorial-summary-store.ts) 和 Web 摘要挂载。

采用 parse5 处理 HTML，css-tree 处理 CSS。二者是解析工具，不是自动安全保证；项目仍需对解析结果应用当前静态报告允许范围。

- 在解码后的元素、属性、命名空间和 URL 上判断，覆盖无引号属性和实体编码。
- 禁止 script、事件属性、表单、iframe、object/embed、base、自动跳转及其他主动内容。
- 禁止外部资源加载、CSS 导入及危险 URL；允许的 SVG 内部片段引用必须指向本文件合法节点。
- SVG 仅接受静态展示范围，不接受 foreignObject 或能加载主动内容的嵌套。
- CSS 的转义标识、函数与 URL 通过解析后的节点处理；含不能安全解释的 Raw 节点或未知主动语义时拒绝，而不是忽略。
- 来源链接只允许已验证来源的安全链接；本轮不新增任意外链或图片抓取。
- 保留 CSP 和宿主隔离作为纵深防御，但不能用 HTTP CSP 替代下载文件的内容安全。
- 安全检查不删除正文或改写研究结论；不能通过“洗掉引用”把失败内容变为合格报告。

回归：事件属性无引号/大小写、协议实体编码、协议相对地址、CSS 转义及导入、SVG 引用、畸形 HTML、超大文件；Web 与下载使用相同校验后的字节。

### R4：摘要 GET 纯读与互斥

- 按 4.3 拆分显式生成和读取，删除 GET 调用 generate 的链路。
- 复用现有 EditorialSummaryLockStore 接口，用 PostgreSQL session advisory lock 替换目录锁与 PID 回收。
- 锁键由带命名域的 Task/Attempt/RequestKey 稳定派生；使用 try-lock，不排队等待同一个请求。
- 锁持有期使用独立于业务查询池的受限会话，避免多个摘要占满业务池后，来源复核无法取得连接。最小实现为每 API 实例一个摘要锁连接、容量占用时立即返回生成繁忙；不新增用户配置面。
- 生成上下文监听会话失联并取消后续工作；每次模型调用与发布前复核当前来源。释放仅作用于本会话，不删除其他执行者的文件锁。
- 保留现有不可变目标槽、临时目录和原子发布：同 RequestKey 的最终可读产物不能相互覆盖。
- 锁只负责减少重复工作，不代替来源/归属校验。网络故障下不承诺模型恰好调用一次；承诺不覆写已封存结果、不把候选文件当正式交付。
- 进程退出释放会话；临时产物按既有精确目标补偿，禁止递归清理整个工作区。

回归：并发同键、不同键容量耗尽、建立锁时中断、模型途中断连、发布竞争、重复释放、进程退出恢复、GET 连续请求零模型调用/零文件写入。

### R5：视觉证据身份与 Gap

涉及 [视觉输入物化](../../apps/orchestrator-runtime/src/report/visual-input-materializer.ts)、[视觉套件 Adapter](../../apps/orchestrator-runtime/src/runtime/visual-analysis-suite-adapter.ts)、[贡献 Adapter](../../apps/orchestrator-runtime/src/skills/contribution-adapter-registry.ts)。

- 物化时保留 gateKey、输入图身份、原图 Artifact 与 Evidence 的确定映射；不要由全局图片顺序反推业务归属。
- 当前任务调用 Tool 时传递稳定图像 ID，使 sourceImageId 可以对应实际原图，而不是仅靠 data URL hash 猜测。
- 单图观察只引用该 sample 的原图；批次观察引用实际输入的 batch，并说明批次范围；比较结论引用真正参与比较的 sample 集合。
- 缺少映射时产生缺口，不回退为“引用全部截图”。
- 来源 Tool 结果按冻结依赖和 input binding 解析；不能仅取 outputs 中最近一个同名 Tool 的结果。共享前置结果必须由计划明确声明。
- partial/unavailable、warnings 和边界说明进入现有 Gap 与最终完成状态；算法观察始终保持适当的 provisional 边界。
- 用户输入边界标注仅用于来源，不计作已经发现的设计问题。

回归：A/B 两图独立观察、跨图比较、多批次、重复图片、输入换序、共享前置、工具部分失败和全部不可用；无来源或缺口丢失均不得得到完整成功。

### R6：前端异步与假设提交

涉及 [useTaskFlow](../../apps/web/src/hooks/useTaskFlow.ts)、[Workbench](../../apps/web/src/pages/Workbench.tsx)、[Stage2Plan](../../apps/web/src/components/stages/Stage2Plan.tsx)。

- 将已有请求代次保护统一覆盖任务恢复、执行完成、步骤刷新、报告加载及命令回调。
- 每个异步结果应用前校验目标 Task 和请求代次；任务切换/重置使旧请求失效，能够取消的读取同时取消。
- 服务端 stateVersion/PlanVersion 继续负责命令一致性，前端代次不能替代服务端 CAS。
- 计划阶段的假设不再仅本地修改。展示已冻结假设；修改统一通过现有“修订方案”入口，生成新 PlanVersion 后再次确认。
- 不在 confirm payload 中新增另一份与 Plan 竞争的假设来源；不让旧编辑状态渗入新任务。

回归：A 慢/B 快、执行完成前切任务、卸载后响应、重复确认、修订后确认旧 Plan；最终页面内容、持久化计划和实际执行输入一致。

<a id="quality"></a>
## 6. 研究与报告能力优化

### Q1：问题驱动的 Plan

复用 Requirement、ProblemGraph 与能力需求表达，明确业务决策、问题范围、时间/地域/人群、请求交付物及证据条件。

每个关键问题需要说明“回答什么、需要什么证据、采用什么方法、谁负责交付”。研究规划回答如何研究；研究回答必须产出当前可支持的直接答案，不得用后续研究建议替代全部答案。

冻结前确认必需输入和必需工具可用。可选工具缺失按合同保留 Gap；已承诺其独有交付时不能静默省略。执行中需要新增证据获取动作而原 Plan 未授权时，通过现有修订/确认流程处理，不增加隐式自主循环。

### Q2：证据与计算

- 关键事实读取可复查的原文、截图或数据行；搜索结果是发现入口，不直接等同于事实证据。
- 记录来源时间、适用范围、关键摘录或数据行定位，核对时间、人群和统计口径。
- 方法知识库只支撑方法，不补充缺失业务事实；模拟、视觉算法和 LLM 记忆不升级为真实用户或经营结论。
- 定量结论需要真实数据、计算过程和口径。没有数据时保留假设或缺口，不编造增长比例。
- 重要结论遇到冲突时检查原始来源与替代解释；多篇转载同一来源不算独立佐证。
- 综合与审校能回看关键依据，不能只接收经过多轮压缩的结论文本。
- 材料过长时按问题选择必要片段并保留出处；被裁剪部分可能影响结论时显式披露，不默默截断。

### Q3：首批核心 Skill

首批只优化三个能力；其他 Skill 维持既有合同并参加回归，不批量改造。

| Skill | 改动 | 质量样本 |
|---|---|---|
| industry-market-analysis | 区分事实/观察/推断；围绕问题组织行业分析；贡献允许忠实归纳；重要策略写清依据、优先级与验证 | 证据充分、证据冲突、缺用户/经营数据 |
| research-strategy-synthesis | 强化问题级答案、反证、替代方案、行动排序；保留请求产物与重要局限；去除无增益重复综合 | 请求策略地图、多个专业贡献冲突、重要问题未回答 |
| generate-persona | 以注入 Knowledge Bundle 为方法来源；清理不适用的运行时 Glob/Read 指令；区分数据拟合与假设画像 | 定性材料、定量材料、无用户数据 |

同时更新相应 SKILL.md、必要的 Execution Contract、knowledge mapping 与案例。必须真实发生的检索、读取或计算由实际阶段承担，不能只在提示词里要求“已经完成”。

每个核心 Skill 加入少量好/坏案例，覆盖方法不适用、无来源细节、空泛建议与正确的局限表达。案例用于展示判断，不做新的硬编码规则引擎。

### Q4：综合、审校与定向修订

1. 按问题整理已支持结论、冲突、未回答内容和请求交付物。
2. 由唯一最终内容负责者综合，比较替代解释和行动，不重复完整执行 Contributor 研究。
3. 保留贡献原文与来源身份；终稿可以去重、归纳和重新组织，但不能提高证据强度。
4. 审校重点为高影响结论的支持关系、方法适用性、遗漏、冲突与风险，而不是只看格式齐全。
5. 原有结构修复只改元数据和绑定，不得重写语义；语义修订必须定位明确内容单元。
6. 默认一次主体综合；复用现有有边界的审校/修订机制，最多一次针对性语义修订并复核受影响内容。再次失败保留草稿，不循环生成。
7. 相关调用和预算在冻结计划或既有明确修订合同中可见，不因合并模块新增隐藏 Tool/Skill。

删除独立 Ledger 后，在现有 support 和 Review 记录中保留关键贡献的采用、合并、冲突或未采用理由；未审中间内容不得直接拼进正式报告。只保留必要可追溯信息，不机械记录所有重复文本的多份处置账本。

### Q5：报告与摘要

完整报告让读者找到：直接答案、证据、分析、行动、限制与开放问题。结构可随主题改变，不制造空章节。

编辑摘要让决策者快速理解：重要结论、建议动作、关键理由及风险。摘要可以省略次要细节，但不能省略会改变决策的重要限制，也不能新增事实、数字、来源、日期或优先级。

图表仅在已有真实数据或明确结构能支持时生成；没有数据时用清楚的文字或表格，不画暗示已量化的装饰图。完整内容、摘要、打印和下载均保持原任务主要语言。

保留内容专属的编辑能力，不新建 Showcase，不把某个案例样式固化为全项目模板。详情确定性渲染；摘要失败不影响详情，也不把详情冒充摘要。

### Q6：质量处置边界

| 情况 | 处理 |
|---|---|
| 越权、来源伪造、敏感泄漏、Artifact 损坏、危险 HTML | 阻止正式发布 |
| 无依据的核心事实、关键方法错误、必需产物缺失、未披露重大风险 | 修订或撤回结论；不满足合同则只保留草稿 |
| 证据较弱或非关键资料缺失 | 限定结论、显式 Gap；满足已确认合同才可带缺口交付 |
| 问题暂时无答案 | 明确 unanswered；若合同要求实证答案，则不能标称已完成该责任 |
| 标题、措辞、非关键布局不足 | 不阻断可信内容，可后续改善 |

上述边界使用专业审校与既有客观约束，不新增综合评分阈值来机械判定研究正确性。引用存在性可以由代码检查，引用是否真正支持结论仍需要内容审查。

<a id="evaluation"></a>
## 7. 评测基线与科学验证

### 7.1 同一 Skill 支持多个案例

修改现有 [case-loader](../../evaluations/skills/case-loader.ts)、[types](../../evaluations/skills/types.ts)、[runner](../../evaluations/skills/run.ts)、[report-writer](../../evaluations/skills/report-writer.ts) 和对应测试，不新建评测平台。

- 每个案例增加唯一 case_id，skill_id 只表示所属 Skill；文件名与 case_id 对齐。
- Map、恢复记录和输出目录按 case_id 标识；同一 Skill 的不同案例不能覆盖结果。
- 既有 Skill 选择参数继续使用，选中后执行该 Skill 的全部选定案例，不新增生产配置项。
- active Skill 覆盖要求为每个 Skill 至少一个案例；重复 case_id、未知 skill_id 与缺失覆盖继续拒绝。
- 缓存/恢复身份包含 case hash、Skill/Prompt/Knowledge 身份和模型身份；案例改变不能继承旧结果。
- 同步更新 content overlay 的固定案例引用、汇总统计与已有 Fixture；区分案例数和 Skill 数。
- 既有测试案例做一次明确格式更新；历史评测产物原样保留，不用自动兼容或回填让旧结果混入新批次。

### 7.2 固定代表任务

优先复用 evaluations/skills/cases 和 tests/fixtures 中的素材；合成材料始终标明合成，不用于声称真实业务效果。

| 样本 | 任务条件 | 必须观察的结果 |
|---|---|---|
| E1 公开竞品分析 | 证据充分、来源可复查 | 事实正确，建议与观察关联，来源无伪造 |
| E2 行业与 Persona | 多专业贡献、有匿名用户材料 | 分工清晰，画像有材料依据，综合不重复搬运 |
| E3 策略直接回答 | 明确请求策略地图与优先行动 | 不用研究计划替代答案，交付物实际存在 |
| E4 用户证据不足 | 无访谈/问卷/行为 Dataset | 不编语录、分群占比或“已验证用户画像” |
| E5 冲突证据 | 时间、人群或统计口径不一致 | 解释差异、保留不确定性，不静默选边 |
| E6 部分工具失败 | 可选工具 unavailable 或 partial | Gap 与完成状态一致，已承诺的必需责任不被隐藏 |
| E7 长报告与摘要 | 多问题、多限制、长证据链 | 重要答案、行动和限制不在综合/摘要时丢失 |

本地合同回归覆盖当前七类 active Deliverable 的适用编排组合，同时包含 compiled 和单次调用。不为凑完整矩阵制造当前不支持的 Skill/交付物组合；不支持组合应明确拒绝。

### 7.3 两组对照实验

**架构对照：**冻结需求、证据包、知识版本、Skill Prompt 与模型配置，只改变架构。比较关键内容保留、绑定正确性、故障率、耗时和模型消耗。固定证据实验不是全真联网 Gold，应独立标识。

**研究能力对照：**保持架构与输入不变，分别调整 Plan、核心 Skill 或综合/摘要。每轮记录唯一主要变量；不要一次改完所有提示词再宣称知道收益来源。

由研究员对匿名化、打乱顺序的报告进行对照评审。小样本用于工程决策和发现回归，不给出未经统计验证的普遍提升百分比。

| 指标 | 记录方式 | 验收取向 |
|---|---|---|
| 关键事实正确性 | 逐条打开关键来源，核对内容、时间和口径 | 不接受新增伪造或影响决策的错误 |
| 问题与交付物覆盖 | 对照已确认需求逐项检查 | 必需责任不静默遗漏 |
| 方法适用性 | 研究员检查输入是否支持所用方法 | 不用无数据统计、模拟或截图替代实证 |
| 建议可执行性 | 检查动作、对象、依据、优先级和验证办法 | 能支撑下一步研究或决策 |
| 重要限制保留 | 比较正文、摘要和来源范围 | 不夸大确定性，不隐藏反例 |
| 人工修改负担 | 记录重大/轻微修改及实际编辑时间 | 架构切换不劣于基线，质量优化应有实际改善 |
| 成本与稳定性 | Receipt、Token、端到端耗时、重试与失败原因 | 质量相当时优先成本更低、故障更少的实现 |

当前生成与自动评分使用同一 LLM 实例，自动分数只作辅助诊断，不能替代独立研究员验收，也不能通过修改权重掩盖失败。

### 7.4 Gold 与历史基线

当前 Gold 入口钉住 `competitive-jd-crowdfunding-channel-gold`，位于 [current-semantic-gold.json](../../tests/fixtures/current-semantic-gold.json)，通过 competitive_research 交付京东众筹频道问题。其场景、Profile、Schema、Rubric 与输入 hash 是一组身份，不能把其他行业或策略案例的成功混入该批次。

遵守 CONTEXT.md：同一金标场景三次独立真实运行，真实 Gateway 和至少一个真实 Tool，独立研究员评审，至少两次可用；任何一次来源伪造、敏感信息泄漏或确认绕过均为硬失败。三次通过不等于所有场景得到统计保证。

- smoke 证明路径真实性，Gold 证明特定场景的研究可用性，两者不能互相替代。
- 模型/工具基础设施失败与内容质量失败分开记录；报告已产出但质量差不能归为 infra 后反复抽样。
- 记录全部样本与失败，不挑选成功报告补数。
- 新代码、来源、Prompt 或合同影响批次身份时建立新批次，不覆盖历史证据。
- planning-policy 与 C1 基线不一致时，确认业务变化后更新对应基线身份；不能只改 hash 让测试变绿。
- 普通 CI 的 Hub 文件测试使用受控 Fixture；真实本地快照核验单独报告输入漂移，不删除用户文件或伪改历史快照。

<a id="delivery"></a>
## 8. 六批实施计划

### 8.1 顺序与独立交付

| 批次 | 交付内容 | 依赖与完成条件 | 独立价值 |
|---|---|---|---|
| B1 正确性修复 | R1—R6、对应回归、摘要显式 API | 在现有架构完成，安全与故障注入通过 | 即使不继续重构，也消除真实缺陷 |
| B2 测试与评测基线 | 多案例身份、E1—E7、C1/Hub 基线处理、评审表 | B1 后冻结可用基线；旧缺陷输出不能作质量合格基线 | 建立可重复的工程与研究验证 |
| B3 架构收敛 | 当前 Plan、执行职责、Canonical 读取、报告派生、旧链删除、取代性 ADR | B2 的合同/内容回归通过；入口与消费者一次完整切换 | 降低生产复杂度，不等待新提示词 |
| B4 研究能力优化 | Q1—Q4、三个核心 Skill、证据输入与对照结果 | B3 稳定；每轮主要变量清晰 | 在现有报告上改善分析质量 |
| B5 摘要与表达 | Q5/Q6、重要内容保真、打印/下载一致性 | 不改正式事实；摘要失败不影响详情 | 提高阅读和决策效率 |
| B6 发布验收与 CI | 真实 Single/Multi、Gold、CI 分层、切换说明 | 正确性、架构、研究质量分别达到标准 | 给出可审计的发布判断 |

每批完成后系统保持可用。B3 内可分开发提交，但不能把“只有新 Reader”或“部分 Deliverable 已切换”的半套生产架构单独发布；切换包必须覆盖当前全部有效生产消费者。不使用长期 Feature Flag 维持双轨。

### 8.2 文件级实施地图

| 工作包 | 主要修改位置 | 交付检查 |
|---|---|---|
| B1 授权与事务 | apps/agent-api/src/routes/control-tasks.ts；apps/orchestrator-runtime/src/control/task-workflow.ts；database/control-plane.ts | API、领域命令、事务提交与回放一致 |
| B1 摘要生成与锁 | apps/orchestrator-runtime/src/report/editorial-summary-generator.ts、editorial-summary-pipeline.ts、editorial-summary-store.ts；editorial-summary-runtime.ts；apps/agent-api/src/control-runtime.ts | POST/GET 分离；锁连接有明确生命周期；缓存和封存不变质 |
| B1 视觉与前端 | visual-input-materializer.ts；visual-analysis-suite-adapter.ts；contribution-adapter-registry.ts；useTaskFlow.ts；Workbench.tsx；Stage2Plan.tsx | 身份映射、Gap、任务切换与实际输入一致 |
| B2 多案例评测 | evaluations/skills/case-loader.ts、types.ts、run.ts、report-writer.ts、content-overlay.ts；对应 cases 与 tests | case_id 贯穿执行、恢复、结果与统计 |
| B3 统一 Plan | packages/api-contract/research-deliverable.ts、control-workflow.ts、http.ts；schemas/current-execution-plan.schema.json；planners/plan-compiler.ts、routed-planner.ts；skills/portfolio-skill-plan-compiler.ts | 一个当前合同；模式、责任与冻结语义保留 |
| B3 执行与报告 | lease-execution-engine.ts；control-runtime.ts；report/ 当前内容与展示入口；database/control-plane.ts | Repository 不依赖 Planner；执行不拥有展示业务；一个当前读取聚合 |
| B3 消费者 | Web API/报告组件；scripts/current-real-smoke.ts；gold-run.ts 与 Gold store/service；Zero Publication；下载入口 | 不再依赖旧 Package/Plan 分派；不伪造旧合同身份 |
| B4 核心能力 | skills/industry-market-analysis/SKILL.md；skills/research-strategy-synthesis/SKILL.md；knowledge-base/skills/generate-persona/SKILL.md；对应 orchestrator/skill-executions | 方法与实际执行一致；同材料对照可解释 |
| B5 展示 | report/ 正式 Renderer、摘要 Source/Generator、Web CurrentStage4Report 及打印/下载 | 摘要不新增事实；完整内容与关键限制不丢失 |
| B6 工程与文档 | .github/workflows/ci.yml；现有 smoke/Gold 脚本；CONTEXT.md；docs/adr；真实运行说明 | 跳过不算通过；实现、文档和发布标准一致 |

本表路径以目录上下文指明现有文件，不要求创建同名新架构层。必要的新锁实现使用现有锁接口；安全检查集中在当前报告边界。若单批新增超过约 5 个文件或新增公共配置，先给出删减后的最小版本再进入编码。

### 8.3 删除与保留清单

**保留：**当前有效的研究方法、专业 Payload、Frozen Plan 语义、Receipt、Lease/Fencing、Artifact 原子性、原始贡献来源、必要 Review、详情与摘要、现有发布 Adapter。

**删除：**退休 Plan Reader/Writer、旧 ReportDocument/Package 版本分派、生产 Showcase、旧 Runner/被封禁执行入口的残留调用链、仅维持旧链的 Flag/Schema、重复来源解释与对账代码。

删除前按“生产入口→调用方→数据消费者→测试”确认目标。同步替换仍在运行的行为测试，只删除实现细节断言。不能把测试减少当作覆盖减少的理由；仍有真实消费者的代码不能仅因名称含 legacy 就删除。

不改写历史 Artifact，不把独立归档 Adapter 偷渡进当前范围；历史在线可读性按第 11 节的破坏性切换边界处理。

<a id="testing"></a>
## 9. 自动化测试与执行命令

### 9.1 核心验收矩阵

| 编号 | 验证面 | 正例 | 反例/故障 | 通过条件 |
|---|---|---|---|---|
| T01 | 权限 | 所有者和合法专业审批 | 跨用户、伪造角色、错误 Gate | 非授权不读内容、不产生业务写入 |
| T02 | 原子性 | 一次命令完整提交 | 每个写点异常、重复并发、旧 CAS | 只有完整旧/新状态；回执可准确重放 |
| T03 | 摘要读取 | 已发布摘要读取 | 缺摘要、过期 Attempt、损坏产物 | GET 零模型调用、零文件写入 |
| T04 | 摘要互斥 | 一次生成和缓存复用 | 同键竞争、失联、退出、容量耗尽 | 结果不覆盖、无跨请求解锁、查询池不饥饿 |
| T05 | HTML 安全 | 静态 HTML/CSS/SVG | 编码、无引号、外部请求、主动内容 | 服务端、Web、下载边界一致 |
| T06 | 视觉来源 | 单图、批次、对比 | 换序、重复、缺映射、错误前置 | 仅引用真实参与证据；缺失明确 Gap |
| T07 | 前端一致性 | 正常恢复与确认 | 响应乱序、切任务、旧编辑 | 页面、计划、执行输入一致 |
| T08 | Plan | 当前有效模式/调用方式 | 漂移、未授权 Tool、缺责任 | 一套合同且冻结边界保持 |
| T09 | 内容编译 | 审校后内容完整派生 | 修复单点时修改其他正文 | 非目标语义不变；必需内容无遗漏 |
| T10 | 评测身份 | 同 Skill 多个 case | 重复 ID、错 Skill、旧 hash 恢复 | 案例互不覆盖，统计单位准确 |
| T11 | 研究质量 | E1/E2/E3 | E4/E5/E6 | 无捏造、方法适用、建议有依据 |
| T12 | 摘要保真 | E7 正文与摘要 | 删除重大限制、提高确定性 | 保留决策关键条件，失败不损伤详情 |

并发测试使用可控同步点和故障注入，不能只依赖随机 sleep。HTML 测试必须断言危险行为不能发生，不能只断言某段源码包含正则。必要的 Chromium 契约测试沿用项目现有测试环境；本文编写不启动浏览器。

### 9.2 现有定向测试入口

在隔离测试数据库已准备、依赖已安装的环境执行；不得使用生产数据库运行迁移或测试。以下命令是实施后的验收步骤，本次文档编写没有执行它们。

```bash
pnpm exec tsx --test tests/auth-isolation.test.ts tests/task-workflow.test.ts tests/control-plane.test.ts
pnpm exec tsx --test tests/editorial-summary-generator.test.ts tests/editorial-summary-store.test.ts tests/editorial-summary-pipeline.test.ts
pnpm exec tsx --test tests/visual-input-materializer.test.ts tests/contribution-adapter-registry.test.ts tests/current-flow-state.test.ts tests/stage2-plan.test.ts
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts
pnpm exec tsx --test tests/gold-run.test.ts tests/gold-batch-service.test.ts tests/gold-batch-store.test.ts
```

每个缺陷先加入能在原行为上失败的回归，再修实现。测试最终调用公共接口/真实事务边界，不把私有函数形状写成合同。

### 9.3 全量确定性验证

确认 DATABASE_URL 指向独立测试库后执行迁移，再执行质量门禁。

```bash
pnpm db:migrate
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm test
pnpm --dir apps/web build
```

根目录 pnpm quality 等价包含类型、Registry、Knowledge 和测试，可用于最后一次统一检查；不必在每次提示词小改后重复跑整仓。

### 9.4 真实验证入口

```bash
pnpm smoke:current:real
pnpm gold:run collect
```

smoke 使用现有 CURRENT_REAL_SMOKE_FIXTURE、CURRENT_SMOKE_PROFILE、CURRENT_SMOKE_SCENARIO 选择输入。修订脚本时，将 orchestrationMode 放进明确的测试输入/调用参数，移除以 MULTI_SKILL_PORTFOLIO_WRITER_ENABLED 推导测试模式的行为；不增加生产模式开关。

先运行一次真实 Single，依据诊断集中修正，再运行一次真实 Multi。记录唯一验证假设、与上次相比的变更、失败时的后续动作；不因“再试一次可能更好”连续抽样。

Gold 的 review 和 decide 继续使用现有子命令，由具备权限的独立研究员提交实际判断。AI 不代填研究员结论。通过真实模型只说明已观察样本，不把离线 Fixture 或自动评分写成真实验收。

### 9.5 人工验收

- 研究员：逐条核验关键事实、方法、问题覆盖、行动和重要限制。
- 前端验收：任务快速切换不串数据；摘要未生成时不自动付费；正文/摘要职责清晰。
- 阅读验收：1440×900 下无横向溢出；长标题、长表格、中文正文、打印分页可读。
- 下载验收：离线文件不依赖运行时网络，无脚本；来源与正式报告一致。
- 安全验收：原始敏感材料、密钥、完整 Prompt 与未脱敏上游错误不进入公开报告或审计日志。

<a id="dependencies"></a>
## 10. 依赖、配置与诊断

### 10.1 必要依赖

| 依赖 | 用途 | 缺失处理 |
|---|---|---|
| Node.js 22+、pnpm 9.12.1 | 与当前 package.json 一致的本地构建/测试 | 修复开发环境，不据此判定业务缺陷 |
| 现有 PostgreSQL | 事务、状态、幂等、摘要互斥 | 停止涉及持久化的动作，不降为内存假成功 |
| parse5、css-tree | HTML/CSS 结构化安全检查 | 实施时加入 lockfile 并通过回归；不在本次文档阶段安装 |
| LLM Gateway | 真实规划、研究和摘要校准 | 明确 infra 失败；不降低内容门槛 |
| Tavily | 当前核心公开检索 | 核心证据获取失败按项目既有 infra 规则处理 |
| 视觉等增强后端 | 仅对应样本的可选增强 | 默认保留 Gap；已承诺独有必需交付时执行前停止 |
| 独立研究员 | Gold 与报告可用性判断 | 研究验收保持未完成，不能用模型自评替代 |

复用现有 DATABASE_URL、JWT_SECRET、LLM_GATEWAY_BASE_URL、LLM_GATEWAY_API_KEY、LLM_MODEL_NAME、LLM_EXPECTED_ACTUAL_MODEL、LLM_MODEL_ROUTES、TAVILY_API_KEY；Gold 人工提交使用现有 GOLD_REVIEWER_JWT 授权。仅在涉及对应场景时使用现有增强 Tool 凭据。

不新增服务账号、MCP、外部平台或生产配置面。不得在文档、命令输出或评测包中写出凭据值。本文未探测真实业务服务可用性；真实验收启动前由实施者确认就绪，缺凭据不能记为通过。

### 10.2 最小诊断记录

复用现有 Receipt/Artifact 元数据，记录 Task、Plan、Attempt、Step/Invocation、来源身份、模型实际身份、耗时、Token、失败阶段及安全裁剪后的原因。

一次错误记录应足以区分：输入/权限、冻结漂移、模型/网络、结构合同、来源绑定、内容覆盖、安全、存储及当前版本冲突。不为此新建封闭错误码平台，不记录完整用户材料或未脱敏上游响应。

### 10.3 CI 分层

- PR/push 的常规门禁：类型、lint、Fixture、数据库集成、Web 构建和 HTML 安全契约。
- nightly/手动：真实 Single/Multi smoke，使用现有脚本。
- release：当前改动所需真实路径与独立研究员质量验收。
- 缺少凭据、步骤跳过、前置启动失败必须分别显示；没有执行断言的绿色 Job 不算通过。
- 全量测试中的当前有效能力回归保留；删除旧实现时不能删除对应的行为保障。

<a id="release"></a>
## 11. 发布、失败处理与回退

### 11.1 发布前条件

1. B1 安全修复已形成可独立发布的基线，不依赖后续大重构。
2. 当前批次的代码、公共合同、Fixture、消费者与文档同步。
3. 确定性门禁通过；涉及研究/报告语义的批次有对应质量对照记录。
4. 真实验收不是仅检查 HTTP 成功；确认真实模型/Tool Receipt、真实报告和来源。
5. 发布说明明确哪些旧合同退出、哪些历史记录不再由新服务解释。
6. 发布、数据库操作及外部写入已获得相应授权；本文不自动授予这些权限。

### 11.2 架构切换步骤

1. 暂停新任务创建，等待正在执行的旧任务自然结束；不擅自取消用户任务。
2. 将未执行的旧 Plan 明确标记为需要重新规划，不能原地改写冻结内容或自动跨模式执行。
3. 同一切换发布中启用统一合同与所有当前消费者，并删除旧 Writer/Reader 分支。
4. 执行确定性冒烟及受控真实路径，检查权限、来源、状态、GET 纯读和当前报告读取。
5. 验收通过后恢复新任务创建；不以完成率上涨替代质量判断。

历史 Task、Plan、Artifact 原样保存，不迁移、不回填、不删除。没有兼容层意味着新服务不承诺继续在线解释旧合同；如业务要求旧报告持续在线可读，需要单独批准归档读取范围，不能在本轮默默加入兼容系统。

### 11.3 回退边界

| 时点/失败 | 处理 |
|---|---|
| B1/B2 独立修复失败 | 回退本批变更或前向修复，不撤销其他已验证修复 |
| 新合同尚未写入 | 可以回到包含安全修复的旧应用版本 |
| 新合同已写入 | 优先前向修复；必要时停止新任务并保留新数据，不能声称旧版本可无损接管 |
| 摘要失败 | 摘要标记不可用，完整报告继续可读；不重跑研究链 |
| Artifact 被篡改 | 拒绝读取并保留诊断，不自动覆盖/重生成掩盖问题 |
| 模型/工具暂时故障 | 使用既有有边界重试；不能放宽证据、审批或保真要求 |

禁止通过恢复旧数据库覆盖新任务，禁止删除新 Artifact 以实现“干净回滚”。回退目标不能重新引入已修复的权限或安全缺陷。

### 11.4 主要风险

| 风险 | 控制措施 |
|---|---|
| 删除旧链时遗漏消费者 | B3 同步覆盖 Web、下载、Gold、smoke、Zero 与当前有效 Deliverable；不分开上线半条链 |
| 架构变化与提示词变化混杂 | B3 固定研究输入和 Prompt；B4/B5 单独对照 |
| 摘要长调用耗尽数据库连接 | 独立受限锁会话、繁忙立即失败、详情与业务查询池隔离；测试高于平时并发的压力场景 |
| 大材料导致上下文溢出或证据丢失 | 按问题选择材料、保留来源、披露裁剪限制，不增加无限上下文或自动摘要层 |
| 来源不足导致无法得出结论 | 限定结论、显式 unanswered/Gap，按合同决定是否可交付 |
| 自动评分偏好自己的输出 | 独立研究员盲评和实际修改量，不只看模型评分 |
| 工作区存在用户 WIP | 每批前后检查状态，保护无关修改，不能整目录清理 |

最脆弱的前提是“可用材料足以支撑用户请求的结论”。前提不成立时，系统必须诚实缩小结论范围或停止正式交付，不能靠更多 Skill、更多总结或更漂亮的图表补出事实。

<a id="acceptance"></a>
## 12. 完成标准与交接清单

### 12.1 实施完成清单

- [ ] R1：跨用户审批、读取与回放回归通过。
- [ ] R2：approval/revision/resume 的状态和回执原子提交，故障注入通过。
- [ ] R3：HTML/CSS 使用解析后的安全检查，攻击样本与下载边界通过。
- [ ] R4：摘要 POST/GET 分离、互斥与断连恢复通过，GET 无副作用。
- [ ] R5：视觉来源精确映射，Tool 来源按冻结依赖解析，Gap 端到端传播。
- [ ] R6：前端请求乱序不串任务，假设修改实际进入修订 Plan。
- [ ] B2：同 Skill 多案例、恢复身份、基线与统计正确。
- [ ] B3：一个当前 Plan、一套执行基础设施、一份正式事实源；旧生产链及对应重复配置删除。
- [ ] B3：公共合同、Web、下载、Gold、smoke、Zero 等消费者同步。
- [ ] B4：三个核心 Skill 的方法、实际输入和执行合同一致，对照评审有可解释结果。
- [ ] B5：综合与摘要不丢关键内容、不提高确定性，修订有界，详情独立可用。
- [ ] B6：确定性门禁、真实 Single/Multi、Gold 与独立研究员判定分别留有证据。
- [ ] 发布说明、取代性 ADR、CONTEXT 与真实实现一致，无未声明的历史兼容假设。

这些复选框表示实施后的检查项，本次生成文档不会将其勾选为已完成。

### 12.2 最终判定

必须同时满足：

1. **正确性合格：**权限、事务、并发、Artifact、来源和状态传播无已知阻断缺陷。
2. **架构收敛：**当前生产路径唯一，重复版本与循环依赖减少，不以新增平台替代旧复杂度。
3. **研究可用：**关键结论可核验、问题得到回答、方法适用、建议能行动、局限未隐藏；人工修改负担不高于固定基线。
4. **证据完整：**所有通过声明对应实际执行结果；未运行、被跳过和外部阻塞如实记录。

收益报告同时展示质量、耗时、Token、失败与人工修改，不预先承诺固定百分比的提升。

### 12.3 排期与责任

粗估 20—30 个工程人日，另需 3—5 个研究员人日；不含真实数据采集、业务协调和外部服务等待。它是排期参考，不是工期承诺。

| 角色 | 责任 |
|---|---|
| 后端维护者 | R1—R5、合同与执行收敛、Artifact、摘要生命周期 |
| 前端维护者 | R6、显式摘要操作、当前合同消费、阅读与下载体验 |
| 研究能力维护者 | Plan/Skill 方法、案例、证据条件与综合改进 |
| 测试维护者 | 故障注入、并发、安全、模式/交付物矩阵与 CI |
| 独立研究员 | 原始来源核验、盲评、可用性与 Gold 结论；不能由能力 owner 单独自验 |
| 发布负责人 | 外部依赖就绪、授权、切换窗口、回退边界和发布证据 |

同一工程师可以承担多个工程角色，但不能因此将独立研究员验收替换为自动自评。首次实施从 B1 开始；没有进入后续批次时，不应宣称整个方案已经落地。

<a id="references"></a>
## 13. 依据与参考

### 项目规则与设计

- [项目规则](../../AGENTS.md)
- [业务上下文与验收定义](../../CONTEXT.md)
- [真实 LLM 开发与校准流程](../agents/real-llm-development-workflow.md)
- [原轻量化方案](2026-09-11-architecture-simplification-summary.md)
- [ADR-0003：冻结执行 DAG](../adr/0003-compile-skills-into-frozen-execution-dag.md)
- [ADR-0004：研究规划与直接回答](../adr/0004-separate-research-planning-from-answer-delivery.md)
- [ADR-0006：无损 Canonical 编译](../adr/0006-lossless-canonical-deliverable-compilation.md)
- [ADR-0007：专业贡献与组合编排](../adr/0007-universal-multi-skill-orchestration.md)
- [ADR-0008：编辑型报告](../adr/0008-adopt-reusable-editorial-report-pipeline.md)
- [ADR-0009：现行双模式](../adr/0009-adopt-task-scoped-dual-orchestration-modes.md)
- [ADR-0010：摘要与完整报告](../adr/0010-adopt-editorial-summary-and-canonical-detail-report-set.md)
- [ADR-0011：单次 Skill Invocation](../adr/0011-support-legacy-invocations-in-single-skill-plan-v2.md)

### 能力、验收与官方解析器

- [行业分析 Skill](../../skills/industry-market-analysis/SKILL.md)
- [研究策略 Skill](../../skills/research-strategy-synthesis/SKILL.md)
- [Persona Skill](../../knowledge-base/skills/generate-persona/SKILL.md)
- [Persona 执行合同](../../orchestrator/skill-executions/generate-persona.yaml)
- [Gold 审计说明](../../audit/gold-runs/README.md)
- [当前 Gold 入口](../../apps/orchestrator-runtime/src/gold-run.ts)
- [当前 CI](../../.github/workflows/ci.yml)
- [parse5 官方项目](https://github.com/inikulin/parse5)
- [css-tree 官方项目](https://github.com/csstree/csstree)

解析器官方说明在前序方案选型时已查阅；该事实不代表依赖已安装或安全集成已验收。本文与历史审计快照都不是当前代码通过全部测试的替代证据。
