# ai-x（用研 AI 专项）项目说明报告

> **报告口径**：本报告描述仓库当前已经存在的产品能力与技术实现。结论优先依据根目录 `CONTEXT.md`、Accepted ADR、当前代码、active Registry 与数据库迁移；计划稿、草案能力和默认关闭的实验开关不等同于已启用的生产能力。

## 0. 项目快照

| 项目 | 当前快照 |
|---|---|
| 仓库 / 包名 | `ai-x` / `user-research-ai` |
| 版本 | `0.0.1` |
| 分支 | `fix/single-skill-v2-gap-reconciliation` |
| 基线提交 | `ff97f5c`（2026-09-04，`feat: complete industry market analysis workflows`） |
| 报告生成时间 | 2026-09-10（CST） |
| 主要语言与运行时 | TypeScript、Node.js 22+、ESM |
| 当前核心路径 | `TaskWorkflowService + LeaseExecutionEngine` |
| 规模参考 | 25 个 active Skill、8 个 active Tool、7 类 active Deliverable、62 份 JSON Schema、15 个数据库迁移、216 个测试文件 |

> 以上数量是仓库快照指标，用于说明项目体量，不代表单项能力都已在当前环境启用或完成真实业务验收。

## 1. 执行摘要

ai-x 是一套面向用户研究工作的 **AI 任务编排与可信交付平台**。它并非只把问题发送给大模型并返回一段文本，而是把自然语言研究需求转换为可审计的任务合同，经过需求澄清、方案选择、人工确认、Skill／Tool 执行、证据归档、报告审校和多形态发布，最终形成可追溯的研究交付物。

项目的核心判断是：**“技术运行成功”不等于“研究结果可用”**。因此，系统围绕以下闭环建设：

1. 用户明确研究方向、交付目标与编排模式；
2. 系统形成结构化 Requirement、必答问题和 Evidence 约束；
3. 用户比较并确认执行方案，而不是让系统静默执行；
4. 所有真实 LLM、Tool、Knowledge 和 Skill 调用进入冻结计划与审计链；
5. 事实、推断、模拟与缺口在报告中保持可区分；
6. Final Review 通过后的 Reviewed Canonical Deliverable 是唯一正式事实源；
7. 完整报告与编辑摘要从同一事实源派生，摘要失败不影响正式交付。

从当前代码看，项目已经形成从 Web 产品、API、控制平面、规划器、执行引擎、证据系统到报告发布的完整纵向架构，并为单 Skill 与多 Skill 两种任务级模式提供独立而可审计的执行合同。

## 2. 项目定位与目标

### 2.1 业务定位

项目服务于以下典型用研工作：

- 规划一次用户研究：明确目标、方法、样本、排期、采集模板和验收标准；
- 基于现有证据直接回答研究问题，并输出策略与优先行动；
- 进行竞品研究、行业市场分析、VOC 诊断、设计走查和无障碍审计；
- 组合内部方法知识、公开检索、数据集、截图和专业分析工具；
- 为研究员、产品、设计、运营和决策者分别提供完整底稿与编辑摘要；
- 对计划、调用、证据、审校和发布全过程留痕，以便复核和恢复。

### 2.2 非目标与边界

当前系统不是：

- 一个允许模型任意选择工具、任意循环或隐藏执行步骤的通用 Agent；
- 一个把 LLM 记忆或虚拟用户输出直接当作竞品事实的自动结论机；
- 一个用漂亮页面替代 Evidence、Review 和 Canonical 交付合同的展示工具；
- 一个仅凭接口成功或 Schema 通过就宣称研究可用的自动验收系统。

真实能力闭环仍要求真实 LLM、真实 Tool、可复查来源，以及独立研究员对报告可用性的专业判断。

## 3. 核心能力

### 3.1 需求理解与多轮澄清

系统先把用户输入整理为 `ResearchTaskV2`，显式记录：

- 任务类型、业务领域与研究目标；
- `plan`（研究规划）或 `answer`（直接研究回答）结果模式；
- 请求交付物、成功标准、范围和约束；
- 可安全采用的假设、仍待澄清的歧义和阻塞问题；
- 数据敏感级别、PII 状态和可用材料；
- 行业任务所需的品类、对象、时间窗口和材料角色。

系统不能安全推断的关键内容会进入 `awaiting_clarification`，用户回答后生成新的 Requirement Version。只有 Requirement 达到可规划状态，才会继续构建问题图和候选计划。

### 3.2 研究规划与方案选择

规划阶段将研究需求转化为：

- `ProblemGraph`：必答问题、优先级、验收条件和 Evidence 要求；
- `Capability Demand Graph`：问题、交付物、证据与输入所需要的能力责任；
- Capability Resolution：可用／拒绝的 Skill、Tool 与原因；
- 2～4 张受控执行方案卡片，基线至少包括 `speed` 与 `depth`；
- 恰好一个推荐方案，但推荐不代替用户选择；
- 每个候选对应一份带 hash 的冻结执行计划和 Pending Inputs。

用户选择候选后，系统进入确认阶段。上传数据、截图、审批和其他输入都必须绑定当前 Task、Plan Version 与角色，不能在执行时由模型临时补充未展示的步骤。

### 3.3 单 Skill 与多 Skill 双编排

| 模式 | 执行合同 | 适用方式 | 核心约束 |
|---|---|---|---|
| `single_skill` | `CurrentExecutionPlan v2` | 一个 Skill 完成主要任务 | 恰好一个 Skill Invocation；可以是 `compiled` 或 `legacy_single_call` |
| `multi_skill` | `CurrentExecutionPlan v3` | 多个专业 Skill 分工并综合 | Portfolio、Contribution Owner、唯一 Synthesizer、跨 Skill Review、Contribution Ledger |

两种模式由用户在创建 Task 前显式选择并冻结。Clarification、Revision、Retry、Resume 和 Report 都继承该模式；系统不允许执行失败后跨模式静默降级。

多 Skill 并不以“数量多”为目标。系统先从必答问题、请求交付物、Evidence 和方法义务推导 Capability Demand，再选择最小可覆盖 Portfolio。每个 `Question + Contribution Type` 只有一个主责 Contributor；最终直接答案由唯一 Synthesizer 负责。

### 3.4 Skill 编排与可见执行 DAG

Skill 采用两层定义：

- `SKILL.md`：面向人的方法、边界和质量说明；
- Skill Execution Contract：面向机器的执行真相源。

Compiled Skill 会在确认前展开为普通 DAG 步骤，包括 Knowledge、Tool、LLM、Skill 与 Reviewer 阶段。计划冻结：

- 阶段拓扑、依赖和输入绑定；
- Tool ID、调用次数和允许覆盖的字段；
- Knowledge ID、路径、状态与内容 hash；
- Skill Contract、Reference 与资源 hash；
- 审批、失败策略和预期输出。

当前 Registry 共 26 个 Skill，其中 25 个为 active；active Skill 中 6 个是 compiled、19 个仍是 `legacy_single_call`。Legacy Skill 可以运行，但不具备 compiled 模式的阶段展开、Knowledge 冻结和阶段级 Retry／Resume 保证。

### 3.5 Tool 与 Knowledge 能力

当前 Tool Registry 共 10 个 Tool：8 个 active、2 个 draft。

- **Core Tool**：`tavily-web-search`，承担公开事实证据的主检索路径；
- **Optional Tool**：`joyspace-read`、`ai-spider-search`，以及美学量化、注意力分析、体验模型、虚拟用户、视觉品牌五类实验室；
- **Draft Tool**：`o2-web-search`、`playwright-page-capture`，默认不进入生产选择。

所有 Tool 调用统一经过 Registry、输入／输出 Schema、Adapter、超时、重试、调用回执和脱敏。Optional Tool 缺失通常形成可见缺口，不伪造结果；只有 Requirement 明确把其独有产出设为 Required Demand 时，才会阻断付费执行前的流程。

Knowledge Base 采用导航式检索：README → 分区 Index → 叶子内容；生产 Loader 物理排除 `candidate` 与 `deprecated` 内容。其内容覆盖研究方法、理论模型、素材和 Skill，当前知识库 README 给出的业务盘点为 182 篇方法／模型／素材文档与 20 个知识库 Skill。

### 3.6 七类正式研究交付

| Task Type | Deliverable | 核心交付内容 | 最低 Evidence 类别 |
|---|---|---|---|
| `user_research_planning` | `research_plan` | 目标、方法、样本、排期、采集模板、质量与验收 | 用户输入、Knowledge 或公开来源 |
| `research_synthesis` | `research_strategy_report` | Direct Answers、Finding、策略地图、心智模型、设计原则、机会与优先行动 | 公开来源、Knowledge、用户输入或数据集 |
| `competitive_research` | `competitive_analysis_report` | 竞品样本、对比维度、事实证据、差异与建议 | 公开来源或截图 |
| `voc_diagnosis` | `voc_diagnosis_report` | 反馈编码、主题、问题诊断与优先级 | 数据集、用户输入或公开来源 |
| `design_audit` | `design_audit_report` | 设计走查、问题定位、视觉证据与整改建议 | 截图、用户输入或公开来源 |
| `a11y_audit` | `accessibility_audit_report` | 无障碍问题、影响与整改建议 | 截图、用户输入或公开来源 |
| `industry_market_analysis` | `industry_market_analysis_report` | 行业、用户、供给、竞品、京东现状、机会、策略与度量 | 公开来源、截图、Knowledge、用户输入或数据集 |

### 3.7 Evidence、Canonical 与报告

系统将证据类型区分为公开来源、截图、用户输入、Knowledge、数据集、模拟和派生结果。每个正式报告都要绑定 Evidence Manifest，并在 Finding、Answer、Recommendation 和展示叶子之间维护可验证引用。

报告链路遵循三层职责：

1. **Reviewed Canonical Deliverable**：唯一正式事实源，保存完整研究语义、证据、风险、Coverage 与能力来源；
2. **Canonical Detail Report**：Canonical 的完整可读投影，承担正式交付与审计；
3. **Editorial Summary Report**：面向决策阅读的派生摘要，可概括但不得新增事实、URL、数字或提升证据等级。

生产编辑摘要允许模型生成内容专属 HTML／CSS／内联 SVG，但禁止 JavaScript、事件属性和运行时网络请求。摘要生成失败时，完整报告仍可使用，系统不会用 Detail 冒充 Summary。

### 3.8 多模态、导出与发布

项目支持：

- 图片、截图和数据集作为计划级 Pending Input；
- 图片格式、尺寸、像素、SVG 外链／脚本和路径安全校验；
- 原图、标注图、Chart SVG、Manifest 与来源 lineage；
- Web 结构化阅读、Markdown、ZIP 报告包和可选独立 HTML；
- 可选 Zero 发布集成，带队列、租约、进度、图片写入、元数据复核和发布回执；
- ReportDocument v1～v4 与 ReportPackage v1～v3 的读取能力。

### 3.9 任务治理与运行控制

系统具备：

- JWT 身份认证与 Task／Conversation owner 隔离；
- Task State Version 乐观并发控制；
- Command Idempotency，重复请求只能重放同一结果；
- 人工确认、审批角色、敏感数据和 PII 闸门；
- Execution Lease、Heartbeat、Fencing 与进程失联恢复；
- 失败暂停、Retry、Replan、Abort、Cancel 和可复用检查点；
- `completed_with_gaps`，避免把降级或跳过伪装成完整成功；
- Gold Batch 三次全真运行与独立研究员评审所需的数据模型和命令入口。

## 4. 技术特点

### 4.1 Contract-first，而非 Prompt-first

系统核心边界由 TypeScript 类型、JSON Schema、YAML Registry 和数据库约束共同定义。LLM 负责需要语义判断的内容，系统负责 ID、引用、Hash、Coverage、状态和授权等机械不变量。这样可以防止 Prompt 漂移直接改变执行或交付合同。

### 4.2 计划先冻结，执行后发生

真实调用之前，系统先让用户看到并确认最终 DAG。执行期间不得临时增加隐藏 Skill、Tool 或嵌套 Agent。该设计把成本、风险、审批和恢复边界前移到计划阶段。

### 4.3 Evidence-first 与 fail-closed

系统要求 Required Evidence 达标，并要求至少存在有效 Core Tool Evidence。来源身份、Artifact 绑定、Evidence ID、FindingGraph、Question Coverage 或 Final Review 出现实质性问题时阻断交付；布局或可选视觉增强失败则可降级展示，但不能改写研究内容。

### 4.4 不可变 Artifact 与端到端追溯

Artifact 采用 `STAGING → SEALED / FAILED` 生命周期。SEALED 记录绑定 Task、Plan、Attempt、Schema、SHA-256、字节大小、敏感级别和脱敏策略。读取时重新校验身份、hash、Schema 和 lineage，防止错绑、漂移或被替换。

LLM 调用同时记录 provider、endpoint、requested/actual model、prompt hash、context hash、trace、token 和状态；actual model 与预期不一致时按 model drift 失败关闭。

### 4.5 确定性系统与模型分权

- 模型：需求语义、研究问题、分析内容、受控编辑文案；
- 系统：全局 ID、计划拓扑、输入绑定、Evidence 引用、Coverage、状态机、Artifact 与发布；
- Renderer：只展示已审内容，不重新研究；
- Layout：可以改变分组和顺序，不能新增或删除研究事实。

### 4.6 可恢复的并发执行

DAG 先按依赖生成 execution waves，同一 wave 使用 `Promise.allSettled` 并行执行。核心步骤失败会阻断依赖链；可选 Contributor／Tool 可以按策略形成 Gap。Lease 心跳保护长调用，重试时可以在 identity、hash 和 lineage 一致的前提下复用已封存步骤输出。

### 4.7 配置驱动的能力扩展

Task Type、Decision Node、Skill、Tool、Evidence Policy、Deliverable、Report Rubric 和执行合同主要由 Git 中的 YAML／Schema 管理，运行数据进入 PostgreSQL。新增能力通常通过 Registry + Contract + Adapter 扩展，而不是在编排器中增加大量业务 `if/else`。

## 5. 项目架构

### 5.1 总体架构图

```text
┌──────────────────────────────────────────────────────────────────────┐
│ React Web / Vite                                                    │
│ 登录 · 需求输入 · 澄清 · 方案选择 · 执行进度 · 报告/导出/历史       │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ JWT + REST + SSE / Polling
┌───────────────────────────────▼──────────────────────────────────────┐
│ Express Agent API                                                   │
│ Auth · Control Tasks · Planning · Assets · Reports · Zero           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ Control Runtime                                                     │
│ RequirementRefinement · ControlPlanning · TaskWorkflow              │
│ LeaseExecutionEngine · Evidence · Review · Report Composition       │
└───────────────┬─────────────────────┬──────────────────────┬─────────┘
                │                     │                      │
┌───────────────▼──────────┐ ┌────────▼─────────┐ ┌──────────▼─────────┐
│ Git Contracts & Registry │ │ PostgreSQL       │ │ Artifact Workspace │
│ YAML · Schema · Skill    │ │ Task/Plan/Lease  │ │ SEALED JSON/HTML   │
│ Tool · Knowledge · ADR   │ │ Gate/Receipt     │ │ Image/Chart/Bundle │
└───────────────┬──────────┘ └──────────────────┘ └────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│ External Capability Layer                                           │
│ LLM Gateway · Tavily · Joyspace · AI Spider · Analysis Labs · Zero  │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 分层职责

| 层 | 主要目录 | 责任 |
|---|---|---|
| Web 产品层 | `apps/web/` | 任务工作台、阶段状态机、方案选择、输入上传、执行进度、报告阅读与导出 |
| API 边界层 | `apps/agent-api/` | JWT、owner 鉴权、HTTP／SSE、请求校验、Control Runtime 装配、Zero 接口 |
| 需求与规划层 | `apps/orchestrator-runtime/src/control/`、`planners/` | Requirement Refinement、ProblemGraph、Demand Graph、Capability／Portfolio 选择、Plan 编译 |
| 执行层 | `control/lease-execution-engine.ts`、`runners/`、`skills/` | Lease、DAG wave、Skill／Tool／LLM／Reviewer 执行、重试、Gap、Checkpoint |
| 证据与报告层 | `evidence/`、`report/` | Evidence Manifest、Canonical Deliverable、Review、Layout、HTML、Package、Summary |
| 公共合同层 | `packages/api-contract/`、`schemas/` | API、Plan、Deliverable、Report、Publication 的版本化类型与 Schema |
| 配置与能力层 | `orchestrator/`、`skills/`、`tools/`、`knowledge-base/` | 决策图、Registry、Execution Contract、Prompt、Rubric、方法知识 |
| 持久化层 | `database/`、`run-workspaces/` | PostgreSQL 控制平面、迁移、文件 Artifact、Hash 与恢复数据 |
| 验证与运维层 | `tests/`、`evaluations/`、`scripts/`、`harness/` | 自动测试、Skill 评测、真实 Smoke、Gold Batch、开发栈和 Registry Lint |

### 5.3 控制平面数据模型

```text
Conversation
  └─ ControlTask (state + stateVersion + orchestrationMode)
       ├─ RequirementVersion (多轮澄清后的冻结需求)
       ├─ PlanVersion (候选、planHash、pendingInputs)
       ├─ GateRecord / Command (确认、审批、幂等)
       └─ ExecutionAttempt (lease、retryOf、状态)
            ├─ ExecutionStep
            ├─ ModelCall Receipt
            └─ ControlArtifact (STAGING / SEALED / FAILED)
                 ├─ Evidence Manifest
                 ├─ Research Contribution / Ledger
                 ├─ Canonical Deliverable / Review
                 └─ ReportDocument / HTML / ReportPackage
```

PostgreSQL 保存任务控制事实；体积较大的 JSON、图片、SVG、HTML 和报告包保存在 Artifact Workspace，数据库保存路径、hash、大小和绑定关系。配置与能力定义保留在 Git，不写入业务数据库。

### 5.4 当前路径与 Legacy 路径

仓库仍保留 `apps/orchestrator-runtime/src/orchestrator.ts` 所代表的 Legacy 四段流和历史读取能力，但 Legacy 路径被禁止调用真实 LLM／Tool。当前可信执行主路径是：

```text
Agent API
→ TaskWorkflowService
→ LeaseExecutionEngine
→ SEALED Artifact / Evidence / Review / Report Package
```

这一边界避免旧运行时绕开 Current 控制平面的 Lease、Receipt、Evidence 和 Gate 机制。

## 6. 核心流程

### 6.1 端到端主流程

```text
用户输入 + single_skill / multi_skill
  ↓
创建 Conversation 与 ControlTask
  ↓
Requirement Refinement → ResearchTaskV2
  ├─ 信息不足：awaiting_clarification → 用户补充 → 新 RequirementVersion
  └─ 信息完整：继续规划
  ↓
ProblemGraph + Evidence Policy + Capability Resolution
  ↓
生成 2～4 个方案 → 编译并保存 Plan v2 / v3
  ↓
用户选择方案 → awaiting_confirmation
  ↓
补齐 value / visual / dataset 输入 + 必要审批
  ↓
ready → claim Execution Lease
  ↓
按 DAG wave 执行 Knowledge / Tool / LLM / Skill / Reviewer
  ↓
封存步骤 Artifact、Tool Receipt、Model Receipt、Gap
  ↓
构建并校验 Evidence Manifest
  ↓
生成／无损编译 Canonical Deliverable
  ↓
Final Report Review（必要时一次目标化修订）
  ↓
ReportDocument / Canonical Detail / ReportPackage
  ↓
按需生成无脚本 Editorial Summary
  ↓
Web 阅读、Markdown/ZIP/HTML 下载、可选 Zero 发布
```

### 6.2 任务状态机

```text
awaiting_clarification
        ↓
awaiting_selection
        ↓
awaiting_confirmation
        ├─ 需要审批 → awaiting_approval
        └──────────→ ready
                       ↓
                    executing
                       ↓
                    reviewing
                       ↓
                 composing_report
                       ↓
          completed / completed_with_gaps

任一执行阶段还可能进入 paused / failed / cancelled / rejected。
```

状态变更要求匹配 `stateVersion`，避免并发请求覆盖；重复命令必须使用相同 Idempotency Key 与请求 hash 才能重放。

### 6.3 单 Skill 流程

```text
Requirement
→ Capability Resolver 选择一个 Skill
→ CurrentExecutionPlan v2
→ compiled stages 或 legacy_single_call
→ Evidence Manifest
→ Canonical Deliverable
→ Final Review
→ 双报告集
```

单 Skill 的关键保证不是“步骤少”，而是整个 Task 只能有一个 Skill Invocation，且不能在失败时自动切换到多 Skill。

### 6.4 多 Skill 流程

```text
Requirement + ProblemGraph
→ Capability Demand Graph
→ Portfolio Resolver
→ Contributor Skill Invocations（可并行）
→ Research Contribution Bundle
→ 唯一 Synthesizer
→ Cross-Skill Review
→ Contribution Ledger
→ Reviewed Canonical Deliverable
→ 双报告集
```

Contribution Ledger 对每个内容单元记录 `included / merged / conflicted / omitted`。Required Owner 的 supported 贡献不得被静默省略；Virtual User 只提供 simulation 假设，不能拥有事实结论。

### 6.5 失败、降级与恢复

| 场景 | 系统行为 |
|---|---|
| Requirement 不完整 | 停在澄清，不生成正式计划或调用真实 Tool |
| 审批／输入未完成 | 停在确认或审批，不取得执行 Lease |
| Optional Tool／Contributor 不可用 | 依据合同记录 Gap，可能继续并最终为 `completed_with_gaps` |
| Core Tool 或 Required Evidence 不满足 | 失败关闭，不生成正式报告 |
| Skill／Knowledge／Contract hash 漂移 | 要求 Replan，不静默使用新版本 |
| 可重试外部故障 | 进入 `paused`，保留失败类型与允许动作 |
| Final Review 不通过 | 暂停；只允许受控、目标化修订，不得全文随意重写 |
| Layout／可选展示增强失败 | 使用确定性降级，不改变 Canonical 内容 |
| Lease 丢失或发布未完成 | 停止写入，失效未完成 Artifact，并由恢复逻辑处理 |

## 7. 报告与交付架构

### 7.1 内容生产链

```text
Step Outputs / Contributions
→ Evidence Manifest
→ Semantic Draft
→ Typed Patch（仅在授权目标上修订）
→ Canonical Deliverable
→ Final Review
→ ReportDocument / Detail Renderer
→ ReportPackage
→ Editorial Summary（派生，不是新事实源）
```

### 7.2 报告完整性原则

- 必答问题必须有 Direct Answer 或明确标为未回答；
- supported 事实必须绑定已验证 Evidence；
- Recommendation 必须能回溯到 Finding／Summary；
- 请求交付物必须真正形成结构化内容，不能只列名称；
- ReportDocument 必须覆盖 Canonical 中要求展示的内容叶子；
- Chart、图片和标注必须验证 Asset、Manifest、Spec、Evidence 与 lineage；
- 生产 Summary 与 Web 展示均不执行模型生成的 JavaScript；
- 完整报告负责证据和审计，摘要只负责阅读效率。

## 8. 技术栈

| 领域 | 技术 | 用途 |
|---|---|---|
| 语言与运行时 | TypeScript 5.7、Node.js 22+、ESM | 服务端、编排器、脚本、测试与共享合同 |
| Web | React 18、Vite 6 | 单页工作台、任务阶段与报告渲染 |
| API | Express 5 | REST、SSE、认证、资产与报告接口 |
| 数据库 | PostgreSQL、`pg` | Task、Plan、Gate、Lease、Receipt、Artifact 元数据 |
| Schema | AJV 8、ajv-formats、JSON Schema | LLM 输出、配置、计划、产物和报告校验 |
| LLM | OpenAI-compatible Gateway、原生 `fetch` | 结构化生成、模型路由、超时与回执 |
| Tool | 自研 ToolRouter + HTTP／REST／Tavily／O2／Playwright Adapter | 外部检索、知识读取、页面取证和实验室能力 |
| 文件与图像 | `@openclaw/fs-safe`、Sharp、image-size | 安全 Artifact IO、图像验证、标注与衍生资产 |
| 可视化与导出 | ECharts、fflate | Chart、前端可视化、ZIP 报告包 |
| 安全 | JWT、bcryptjs、owner 校验、脱敏 | 身份、访问隔离与敏感信息保护 |
| 测试 | Node Test Runner + `tsx --test` | 单元、合同、集成、执行与报告回归 |

## 9. 目录导览

| 路径 | 说明 |
|---|---|
| `CONTEXT.md` | 当前领域语言与业务不变量 |
| `docs/adr/` | 架构决策记录 |
| `apps/agent-api/` | HTTP API、认证、Control Runtime 装配与外部发布入口 |
| `apps/orchestrator-runtime/` | 规划、执行、证据、Skill、报告与审计核心 |
| `apps/web/` | React 工作台和报告阅读器 |
| `packages/api-contract/` | 前后端共享的版本化合同 |
| `packages/report-rendering/` | 报告遍历、验证、导出和语义 Manifest |
| `orchestrator/` | Registry、Decision Graph、Policy、Prompt、Rubric、Template、Skill Execution Contract |
| `skills/` | 项目级专业 Skill |
| `tools/` | Tool Manifest、输入／输出 Schema 和 Adapter 说明 |
| `knowledge-base/` | 方法、模型、素材与知识库 Skill |
| `database/` | PostgreSQL Repository、迁移与种子数据 |
| `tests/` | 合同、规划、执行、报告、API 和安全回归 |
| `evaluations/` | Skill／Knowledge 评测 |
| `scripts/` | 开发栈、真实 Smoke、知识导入与集成脚本 |
| `run-workspaces/` | 当前运行产生的 Artifact Workspace |

## 10. 开发、验证与运行

### 10.1 常用命令

```bash
pnpm db:migrate            # 执行数据库迁移
pnpm db:seed               # 初始化开发数据
pnpm dev:stack start       # 迁移后启动 API(3010) 与 Web(5180)
pnpm dev:stack restart
pnpm dev:stack stop
pnpm typecheck
pnpm test
pnpm quality               # typecheck + registry lint + knowledge lint + tests
pnpm smoke:current:real    # Current 真实链路 smoke
pnpm gold:run              # 金标三次全真运行入口
```

### 10.2 关键运行依赖

- PostgreSQL `DATABASE_URL`；
- `JWT_SECRET`；
- 真实执行所需 LLM Gateway 地址、密钥、模型路由和 Expected Actual Model；
- Core Web Search 的真实 Adapter 与密钥；
- 可选的 Joyspace、AI Spider、五类 Lab、Playwright 与 Zero 后端；
- `RUN_WORKSPACE_ROOT` 对应的可写、安全文件系统。

开发栈脚本会先执行数据库迁移，再启动 API 与 Web，并通过端口、健康检查、进程 PID／PGID 和启动时间确认服务身份，避免误杀非托管进程。

## 11. 当前成熟度与边界

### 11.1 已形成的工程基础

- 从需求到交付的 Current 全链路已经具备明确模块和合同；
- 单／多 Skill、Plan v2／v3、Evidence、Review、Canonical 和报告包均有代码实现；
- 控制平面覆盖任务状态、幂等、并发、Lease、Artifact、模型回执和恢复；
- 具备较大的自动化回归面：216 个测试文件、62 份 Schema、11 份 ADR；
- 行业市场分析已进入 active Deliverable 与 compiled Skill；
- Web 已统一新任务和 Current 历史任务的恢复主链。

### 11.2 需要正确理解的边界

1. **功能开关影响可用面**：示例配置中 Multi Skill、Report v3、Editorial Experience、Showcase、Standalone HTML 与 Zero 默认关闭；代码存在不代表部署已开启。
2. **真实闭环依赖外部设施**：真实 Gateway、Tavily、数据库和可选后端缺一不可；`TOOL_ADAPTER=fake` 只适合离线开发，不构成真实研究证据。
3. **Skill 成熟度不一致**：25 个 active Skill 中只有 6 个 compiled，19 个 Legacy Skill 的审计和恢复粒度较弱。
4. **可选 Tool 不保证常在**：实验室与内部 API 缺失时应形成 Gap，不能把未执行结果写成事实。
5. **版本阅读路径较多**：当前同时读取多代 Plan、ReportDocument 和 ReportPackage，保障历史产物可读，但也提高了维护与理解成本。
6. **自动 Review 不是最终业务验收**：真实研究报告是否可用于决策，仍需独立研究员判断；金标通过要求三次真实运行、至少两次可用且没有硬失败。
7. **工作树正在演进**：本报告描述生成时的工作树和 Accepted 合同，不把未落地的计划文档视为当前能力。

## 12. 结论

ai-x 的本质是一套 **以 Evidence 和可审计执行为核心的用户研究生产系统**。它的价值不只在于“生成报告”，而在于把研究任务拆成可确认的需求、可比较的方案、可冻结的执行合同、可追溯的证据和可审校的正式交付。

当前最突出的技术优势是：

- 单／多 Skill 两种路径均有明确合同且不静默切换；
- LLM、Tool、Knowledge、Artifact 和报告之间形成完整 provenance；
- 内容失败与布局降级被清晰分离；
- 完整报告与决策摘要共享同一 Canonical 事实源；
- 通过 State Version、Idempotency、Lease、Hash 和 Schema 支撑长任务的安全恢复。

当前最需要持续关注的不是再增加更多抽象，而是让已经存在的能力在真实环境中稳定闭环：逐步提升 active Skill 的 compiled 比例，明确部署开关，保证 Core Evidence 通道常在，并持续用真实任务与独立研究员评审验证“研究可用性”。

综合判断：该项目已经超出原型式“LLM + Prompt + 页面”的范畴，进入了 **研究任务控制平面、专业能力编排与可信报告基础设施** 的阶段；其成熟度应以真实证据链和研究员可用性衡量，而不应只以接口成功、测试通过或报告页面完整度衡量。

## 13. 主要依据

- [`CONTEXT.md`](../CONTEXT.md)：领域术语、业务不变量与验收口径；
- [`docs/adr/`](adr/)：Skill 编译、答案型报告、多 Skill、双引擎和双报告集决策；
- [`package.json`](../package.json)：运行时、依赖和命令；
- [`apps/agent-api/src/server.ts`](../apps/agent-api/src/server.ts)：API 入口；
- [`apps/agent-api/src/control-runtime.ts`](../apps/agent-api/src/control-runtime.ts)：Current Runtime 装配；
- [`apps/orchestrator-runtime/src/control/task-workflow.ts`](../apps/orchestrator-runtime/src/control/task-workflow.ts)：任务 Gate 与命令流程；
- [`apps/orchestrator-runtime/src/control/lease-execution-engine.ts`](../apps/orchestrator-runtime/src/control/lease-execution-engine.ts)：可信执行主引擎；
- [`orchestrator/skill-registry.yaml`](../orchestrator/skill-registry.yaml)、[`tool-registry.yaml`](../orchestrator/tool-registry.yaml)、[`deliverable-registry.yaml`](../orchestrator/deliverable-registry.yaml)：当前 active 能力；
- [`database/migrations/`](../database/migrations/)：控制平面与发布数据模型；
- [`apps/web/src/hooks/useTaskFlow.ts`](../apps/web/src/hooks/useTaskFlow.ts)：前端 Current 状态机；
- [`apps/web/src/components/stages/CurrentStage4Report.tsx`](../apps/web/src/components/stages/CurrentStage4Report.tsx)：双报告阅读与导出。
