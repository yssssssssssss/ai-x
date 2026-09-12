# Industry Market Analysis 第七 Deliverable 开发方案

> 状态：方案已确认，待实施
> 日期：2026-09-03
> 基线分支：`fix/single-skill-v2-gap-reconciliation`
> 基线提交：`748f134`
> 适用范围：新建 Current Task、`single_skill`／`multi_skill`、双报告集、用户 CSV 与竞品／京东截图、Joyspace 只读知识
> 原型参考：`tmp/industry-market-analysis-demos/`
> 方法来源：`wiki/user-research/00-source-sync/jd-design-system-md-v16/horizontal/user-research/skills/industry-market-analysis/`

## 1. 决策摘要

将 Industry Market Analysis 作为第七种正式 Deliverable：

```text
industry_market_analysis_report
```

它不是新的编排模式。最终同时支持：

```text
single_skill + industry_market_analysis_report
multi_skill  + industry_market_analysis_report
```

两种模式共享一个 Industry Market Canonical 内容合同，但继续使用各自冻结的执行引擎：

- `single_skill`：CurrentExecutionPlan v2，恰好一个 `industry-market-analysis` Skill Invocation；一个 Skill 可以展开 Knowledge、Tool、LLM 和 Reviewer Stage，但不得隐藏调用第二个 Skill。
- `multi_skill`：CurrentExecutionPlan v3，由市场、竞品、Persona、指标、设计诊断和优先级 Contributor 与唯一 Industry Synthesizer 组成。
- Task 创建后，模式、Task Type 和 Deliverable 全部冻结；Clarification、Revision、Retry、Resume 和 Report 必须继承，不允许跨模式或跨 Deliverable fallback。

Industry Task 先询问用户的目标、范围和资料可用性，再生成与现有材料一致的计划。用户能提供的资料成为 Pending Input；用户明确无法提供的资料不会继续作为当前 Plan 的必填项，而是触发 Plan Revision，并形成可见的 Data／Capability Gap。

最终链路：

```text
用户需求与资料
→ Industry Requirement
→ CurrentExecutionPlan v2 / v3
→ Skill / Tool / Contribution
→ Industry Content Draft
→ Deterministic Canonical Assembler
→ Final Review
→ Reviewed Industry Canonical
├── Canonical Detail Report
└── Editorial Summary Report
```

## 2. 当前证据与 Prototype 结论

### 2.1 当前正式能力

当前项目已经具备：

- Task 级 `single_skill`／`multi_skill` 模式选择和冻结。
- CurrentExecutionPlan v2／v3。
- Compiled Skill、Legacy Invocation、Portfolio、Contribution、Ledger 和 Synthesizer。
- `value`／`visual` Pending Input、Visual Artifact、Evidence Manifest、Final Review。
- Canonical Detail 与 Editorial Summary 双报告集。
- 6 种 active Deliverable。
- `generate-persona`、`competitive-analysis`、`build-experience-metrics`、`run-heuristic-evaluation`、`issue-prioritization` 等可复用专业 Skill。
- 本机真实可用的 o2 0.0.8 与 `webcli:joyspace`；`search` 和 `view` 均已只读验证成功。

### 2.2 当前缺口

当前尚不存在：

```text
industry_market_analysis task type
industry_market_analysis_report deliverable
Industry Market Canonical Payload
active industry-market-analysis Runtime Skill
CSV Dataset Pending Input
Joyspace search/view Runtime Tool
Industry Strategy Chain 合同
Industry Category Asset 合同
Industry Detail Projector
```

`industry-market-analysis` 上游 Skill 仍标记为 `draft（待审）`；Source Sync 文件和 Joyspace Cache 的存在不代表 Runtime 已接入。

### 2.3 宠物食品 Demo 的真实逻辑

`tmp/industry-market-analysis-demos/pet-food-industry-experience-demo.html` 基于已封存的 Competitive Analysis Canonical：

```text
Task：5d5fb8f8-7fb7-400f-bde6-18e7c42f7aa5
Attempt：dad1f8aa-9442-415c-862b-6d026f322033
Source：deliverables/final-r0.json + evidence/manifest.json + review-r0.json
```

它保留 10 个样本、30 个维度单元、Finding Graph、差异、影响、行动、Roadmap、埋点和用户测试，再按 Industry Market Analysis 的 10 维底座与五个内容域重组。新推导的品类资产、体验诊断和策略均标记为“分析推断／策略建议”，缺少的市场、用户和京东内部数据标记为“待复核”。

该 Demo 证明“Reviewed Canonical → Industry 结构化映射 → 显式 Gap → 丰富报告”可行，但当前映射由一次性 Python 脚本完成，尚未证明 Runtime 自动闭环。

## 3. 目标

### 3.1 产品目标

- 用户提出完整品类／行业分析需求时，系统稳定选择 Industry Deliverable。
- 用户可以在现有澄清和计划确认交互中声明、上传或拒绝提供材料。
- 资料不足不会诱导模型补造事实；系统在确认前展示可回答和不可回答范围。
- 非图书品类能够生成与宠物食品 Demo 接近的内容结构、信息密度和视觉质量。
- 完整报告的事实深度由真实 Evidence 决定，而不是由 HTML 丰富度伪装。
- 单／多 Skill 最终写入相同 Industry Canonical 语义合同。
- Detail 保留完整内容和审计；Summary 提供内容驱动的决策叙事。

### 3.2 工程目标

- 新增一个 Task Type、一个 Deliverable、一个 Runtime Skill、一个 CSV Dataset 输入类型和一个 Joyspace 只读 Tool。
- 复用现有 Scheduler、Lease、Artifact、Evidence、Review、Report Package 和 Summary Store。
- 不新增第二套调度器、数据库体系或报告引擎。
- 不改变已有 6 种 Deliverable 的写入和读取行为。
- 不修改历史 SEALED Task、Plan、Artifact 或 Report。

## 4. 非目标

V1 不包含：

- 京东内部经营数据直连 Tool；内部经营资料由用户提交 CSV。
- Joyspace 创建、编辑、上传、删除、移动、分享或评论能力。
- XLSX、PDF、DOCX 通用文件平台。
- 海量真实用户逐个打标签的 User Profile 数据工程。
- 通用机器学习聚类平台。
- 复制 Industry Source Skill 的固定 5 Tab HTML、CSS、Hero 或 DOM。
- 将宠物食品或图书 Demo 作为生产模板或事实源。
- 跨模式 fallback。
- `multi_skill + $industry-market-analysis`。
- 历史任务回填。
- 一次性迁移全部 Legacy Skill。
- 自动补造市场规模、内部 KPI、用户比例、销量、份额、转化、复购或 AB 结果。

短文本与少量 Markdown 内容继续使用现有 `value` 输入。V1 新增的受控文件输入只支持 CSV。

## 5. 领域边界与术语

### 5.1 Industry Deliverable

`industry_market_analysis_report` 是交付物类型，定义最终结果的 Payload Schema、Evidence Policy、Review Rubric、Composition Policy 和报告投影。它不是第三种 Orchestration Mode。

### 5.2 Industry Market Canonical Schema

Schema 是正式行业结果的数据合同；它不搜索、不分析、不调用 Skill、不渲染 HTML。通过 Schema、Evidence 和 Final Review 的具体 Deliverable 才是 Reviewed Industry Canonical。

### 5.3 资料可用性

用户在澄清阶段声明哪些材料可提供；该声明只用于规划。真正文件在 Plan 确认前进入 Pending Input Gate。

### 5.4 降级

降级只降低同一 Industry Task 的证据覆盖和结论等级，不修改 Task 的模式或 Deliverable。降级必须由用户明确选择或由真实 Tool 失败触发，并写入 Gap；不得静默发生。

### 5.5 Persona 三种身份

```text
dataset_derived    基于真实用户 CSV
qualitative_draft  基于有限访谈／定性材料
simulation         基于预设 Persona 或 virtual-user-lab
```

三者必须在 Canonical、Evidence 和报告中保持可辨识，simulation 不得成为真实用户事实。

## 6. 总体架构

```text
┌───────────────────────────────────────────────────────────────┐
│ 用户输入                                                       │
│ 品类/目标 · 京东截图 · 竞品平台+截图 · 用户CSV · 经营CSV       │
└──────────────────────────────┬────────────────────────────────┘
                               ↓
┌───────────────────────────────────────────────────────────────┐
│ Requirement Refinement                                        │
│ Industry Intent · 范围/档位/聚焦 · 资料可用性                  │
└──────────────────────────────┬────────────────────────────────┘
                               ↓
                 ┌─────────────┴─────────────┐
                 ↓                           ↓
        single_skill / Plan v2      multi_skill / Plan v3
        Industry Skill × 1          Contributor Portfolio
                 │                  Persona / Competitor /
                 │                  Metrics / Design Audit
                 └─────────────┬─────────────┘
                               ↓
┌───────────────────────────────────────────────────────────────┐
│ Industry Content Draft                                        │
│ 市场 · 用户 · 供给 · 竞品 · 京东内诊 · Gap · 策略 · 品类资产  │
└──────────────────────────────┬────────────────────────────────┘
                               ↓
┌───────────────────────────────────────────────────────────────┐
│ Industry Canonical Assembler                                  │
│ Evidence · Coverage · Status · Gap · Lineage · Hash            │
└──────────────────────────────┬────────────────────────────────┘
                               ↓
                       Final Review
                               ↓
                    Reviewed Canonical
                      ↙              ↘
          Canonical Detail      Editorial Summary
```

## 7. 公共合同变更

### 7.1 新 Task Type

新增：

```text
industry_market_analysis
```

修改：

```text
packages/api-contract/plan.ts
schemas/research-task-v2.schema.json
```

Industry Task 还必须持久化经过用户确认的领域范围：

```text
industry_scope:
  category
  subcategories
  exclusions
  analysis_depth
  primary_focus
  secondary_focuses
  decision_audience
  decision_goal
  time_window
```

`industry_scope`、`available_material_roles` 和 `unavailable_material_roles` 只在 `task_type=industry_market_analysis` 时由 JSON Schema 条件设为必填；其他 6 类 Task 的既有合同不增加兼容默认值，也不做历史回填。这样 Canonical Assembler 可以确定性核对最终 `scope`，而不是从自由文本猜测。

数据库 `task_type` 当前为 TEXT，不新增 Migration。

### 7.2 新 Deliverable

新增：

```text
industry_market_analysis_report
```

Registry Entry 必须声明：

- `task_types: [industry_market_analysis]`
- Payload Schema
- Synthesis Prompt
- Review Rubric
- Evidence Policy
- Report Template
- Phase A 使用 `standalone_compat`
- Phase C 升级为 `portfolio`，唯一 Synthesizer 为 `industry-market-analysis`

### 7.3 新 Material Availability

在 `ResearchTaskV2` 中增加：

```text
available_material_roles: string[]
unavailable_material_roles: string[]
```

这两个字段仅对新的 Industry Task 条件必填，不修改历史非 Industry Requirement。

标准角色：

```text
jd_screenshots
competitor_screenshots
competitor_platform_names
user_research_dataset
internal_metrics_dataset
```

两组不得包含重复角色；用户新的显式回答覆盖同一角色的旧状态，其他累计回答继续保留。

资料“可提供”不等于资料“已经提交”。现有 `available_input_roles` 继续只表示已经存在的输入，不得塞入 `available_material_roles`，否则 Stage 2 会错误地不再要求上传。Industry Planning Policy 独立计算：

```text
当前范围实际需要的角色 ∩ available_material_roles
→ Pending Input

当前范围实际需要的角色 ∩ unavailable_material_roles
→ Data / Capability Gap

当前范围实际需要但尚未表态的角色
→ Clarification
```

“当前范围实际需要的角色”只由已确认的 `industry_scope`、目标问题和档位推导，避免把资料可用性误当成分析相关性。

### 7.4 新 Pending Input Kind

扩展：

```text
PendingInput.kind = value | visual | dataset
```

`dataset` V1 只接受一个 UTF-8 CSV 文件；每个业务角色一个文件。

Skill Registry 增加唯一的新输入元数据：

```text
dataset_inputs: string[]
```

它必须是 `inputs` 的子集，与 `visual_inputs` 不相交。Capability Resolver 按 `dataset → visual → value` 的优先级生成 Pending Input；V1 拒绝 `dataset + multiple=true`，不引入通用 file 类型或别名系统。

### 7.5 新 Evidence Kind

EvidenceClass 已包含 `dataset`。新增可解析的 Dataset Evidence Kind，使 Evidence 可以指向标准化 Dataset Artifact 的稳定 JSON Pointer，而不是引用临时文件位置。

## 8. Industry Canonical Payload

新增：

```text
schemas/deliverables/industry-market-analysis-report.schema.json
```

建议顶层结构：

```text
scope
coverageLedger
marketLandscape
audienceSegments
supplyLandscape
competitorAnalysis
jdDiagnosis
validatedFindings
gapMatrix
positioning
opportunities
strategyChains
designLanguage
categoryAssets
measurementPlan
dataGaps
```

### 8.1 Scope

必须记录：

```text
category
subcategories
exclusions
analysisDepth: light | medium | heavy
primaryFocus
secondaryFocuses
decisionAudience
decisionGoal
timeWindow
```

### 8.2 Coverage Ledger

固定覆盖：

```text
A 宏观背景
B 用户洞察
C 供给侧分析
D 竞品与参考
E 京东内部诊断
F 机会与策略
G 设计落地
H 可衡量指标
I 方法与来源
J 商业与经营逻辑
```

每个维度必须声明：

```text
status: supported | partial | unavailable
summary
evidenceIds
gapIds
```

完整报告指 10 个维度都有明确状态，不代表每个维度都必须伪造确定结论。

### 8.3 Audience Segments

保存：

```text
basisType: dataset_derived | qualitative_draft | simulation
coreVariables
supportingVariables
sampleCoverage
segments
personas
differences
designImplications
evidenceIds
limitations
validationNeeded
```

不得将 Persona、互斥用户分层和单用户 User Profile 混为一体。

### 8.4 Competitor Analysis

复用现有 Competitive Analysis 的主要结构：

```text
competitorSamples
dimensionMatrix
differences
impacts
visualEvidence
screenshotComparisons
```

用户对每个竞品的最低必填输入为：

```text
平台名 + 一张或多张图片
```

页面类型、模块和样本理由由系统推断；无法确认的字段保持 unknown。没有 URL 时 Evidence 只能声明 screenshot，不能声称在线可复查。

### 8.5 Strategy Chain

每条 P0 或重点短期机会包含：

```text
id
priority
opportunityId
title
goal
currentProblem
currentEvidenceIds
currentScreenshotAssetIds
competitorReference
competitorEvidenceIds
designAction
categoryAssetRefs
ownerType
measurement
validationMethod
wireframeAssetId
status
confidence
validationNeeded
```

`priority` 必须存在，供 P0 Coverage 与 Summary 门禁使用；`opportunityId` 必须引用同一 Canonical 中的机会，形成“机会 → 策略链”闭包。

KPI 基线、提升数字、人日和 AB 结果只能来自用户数据或可验证 Evidence。

### 8.6 Category Assets

核心资产家族：

```text
mental_anchor
visual_gene
copy_voice
interaction_play
motion_character
```

允许追加真正由品类证据产生的专属资产，但不得用固定枚举机械限制所有品类。每条资产记录：

```text
fitness: recommended | optional | unsuitable
rationale
benchmarkEvidenceIds
collectedAt
reviewStatus
platformInheritance
categoryDelta
```

## 9. 用户问询与资料交互

### 9.1 Stage 1：Requirement Clarification

Industry Intent 命中后，集中确认：

```text
品类与子类
排除范围
轻/中/重档
主/次聚焦
目标读者
业务决策
时间窗口
可提供哪些资料
明确无法提供哪些资料
```

不在此阶段传大文件。

### 9.2 Stage 2：Plan Confirmation

Planner 只为用户声明可提供、且当前分析确实需要的材料生成 Pending Input：

| Role | Kind | 用途 |
|---|---|---|
| `jd_screenshots` | visual | 京东频道内诊 |
| `competitor_screenshots` | visual | 竞品与视觉证据 |
| `competitor_platform_names` | value | 竞品样本身份 |
| `user_research_dataset` | dataset | 用户分层和 Persona |
| `internal_metrics_dataset` | dataset | KPI、经营和验证 |

不相关资料不询问。例如仅做市场／竞品分析时，不强制用户提交用户 CSV。

### 9.3 无法提供与 Plan Revision

当前 Pending Input 仍保持“当前 Plan 必填”的严格语义，不新增“可跳过必填项”。

用户在 Stage 2 点击“无法提供”时：

```text
更新 unavailable_material_roles
→ 触发现有 Plan Revision
→ 移除对应 Pending Input
→ 重新计算 Capability Demand / Evidence Requirement
→ 写入 Data Gap
→ 展示新的可回答/不可回答范围
→ 用户重新确认
```

该 Revision 不得改变 `orchestration_mode`、`task_type` 或 `deliverable_type`。

### 9.4 确认前影响预览

Plan 页面必须显示：

```text
基于当前资料可以完成什么
当前无法完成什么
将调用哪些 Skill / Tool
哪些结论只能是 provisional
预计产生哪些 Data Gap
```

禁止资料缺失后静默改用预设 Persona 并继续声称真实用户结论。

## 10. CSV Dataset 输入

### 10.1 传输与上传接口

新增 owner-bound、plan-bound Endpoint：

```text
POST /api/control-tasks/:taskId/plans/:planVersionId/inputs/:role/dataset
Content-Type: multipart/form-data
```

约束：

- Task 必须属于当前 Owner。
- Task 必须处于 `awaiting_confirmation`。
- `role` 必须是当前 Plan 的 dataset Pending Input。
- V1 仅接收 `.csv`／`text/csv`。
- UTF-8。
- 单文件最大 10 MiB。
- 单角色一个文件。
- 使用流式或严格限额的 multipart 解析，不把文件写入任意临时目录。

返回：

```text
datasetInputId
fileName
contentSha256
byteSize
rowCount
columns
```

Endpoint 必须支持 `Idempotency-Key`；同一 Owner／Task／Plan／Role／Request Key 重放返回同一结果，内容不同则冲突，避免响应丢失后形成重复 SEALED Artifact。

Plan Confirmation 的 `inputValues[role]` 只提交 `datasetInputId`，不提交原始 CSV 或 Base64。

### 10.2 DatasetInputGateStore

新增：

```text
apps/orchestrator-runtime/src/control/dataset-input-gate-store.ts
```

职责：

1. 校验 Task、Plan、Role、Owner 和文件身份。
2. 使用成熟 CSV Parser 解析引号、嵌入换行和空字段。
3. 为逻辑记录与位置列生成稳定索引；带换行的引号字段不得按物理行号定位。
4. 写入两个 plan-bound、attempt-null Artifact：
   - `dataset_input_csv`／`dataset-input-csv-v1`：原始 UTF-8 CSV；
   - `dataset_input_profile`／`dataset-input-profile-v1`：标准化、可由 JSON Pointer 解析的 Dataset Profile。
5. Profile 记录原始 Artifact ID／Hash／大小、角色、文件名、行含义、时间范围、字段说明、单位、抽样说明、列目录、规范化行和确定性统计。
6. 记录 SHA-256、敏感级别和 PII 声明。
7. 在确认 Plan 时只把 Profile Artifact ID 绑定为 Gate `evidenceRef`；Dataset 不加入 Visual Publication。
8. 任一后续 Artifact 写入失败时，使已经 SEALED 的前置 Artifact 失效，避免半发布。
9. Plan Revision 或取消后使未使用的上传失效，不删除历史记录；已经被历史 Gate 引用的 Artifact 保持可读。
10. 读取时重新验证 Profile、Raw CSV、Hash、Task、Plan、Role 和媒体类型。

`ControlArtifactStore` 新增窄的安全 CSV 写入／读取方法，不放宽图片 Binary 校验，也不把 CSV 伪装成 HTML 或 JSON Base64。

`ControlPlaneRepository.completeConfirmationCommand()` 必须按 Artifact Kind 分流：Visual Reference 继续要求合法 Visual Publication；Dataset Reference 要求 SEALED `dataset_input_profile`、同一 Task／Plan、attempt 为空且 metadata role 等于 Gate Key。混合 value／visual／dataset 的一次确认必须原子完成。

不重构现有 `VisualInputGateStore`；两个 Gate 共享 Artifact Store，但职责独立。

### 10.3 LLM 与程序分工

程序负责：

```text
CSV 解析
记录数和数值计算
字段目录和单位
Hash 与 Artifact
PII/Sensitivity Gate
Evidence Pointer
```

LLM 负责：

```text
目标/行为/观点提取
主题编码
候选分层
Persona 初稿
业务解释
策略推导
```

LLM 不负责重新计算总数、占比、均值或其他可确定计算。

10 MiB 是传输与原始 Artifact 上限，不是模型上下文承诺。Dataset Gate 在上传时生成有界 Model View，并按当前 LLM Input Compactor 的实际预算校验；超过预算时明确返回 `dataset_too_large_for_analysis`，要求用户缩小或聚合 CSV。V1 不做静默抽样、截断或“大文件自动分片平台”。

### 10.4 隐私边界

V1 只接受已匿名化的用户 CSV：

- `pii_detected=true` 时阻断模型处理。
- `confidential` 数据不进入当前模型出境路径。
- CSV 上传时要求用户说明“一行代表什么”、时间范围、字段含义、单位和是否抽样。
- 报告只输出聚合数据、匿名引用和 Evidence 指针。
- 原始 CSV 默认不进入报告下载包。

## 11. Single Skill 设计

新增：

```text
skills/industry-market-analysis/SKILL.md
orchestrator/skill-executions/industry-market-analysis.yaml
```

上游 Source Skill 作为设计输入，先完成方法评审；Runtime 不直接激活 Source Sync 中的 draft 文件。V1 将必要方法收敛为一个受 Review 的 Runtime 方法资源，不复制全部 28 个上游文件。

### 11.1 Single Skill DAG

```text
1. load-industry-methods
   加载 10 维、8 阶段、反幻觉规则与平台基线

2. inventory-inputs-and-evidence
   盘点用户输入、Dataset、截图、Knowledge 和 Gap

3. collect-public-market-evidence
   调用真实公开检索；每个结果保留 URL 和 Tool Proof

4. analyze-market-users-and-supply
   分析市场、供给、用户数据；无真实用户数据时只输出假设

5. diagnose-jd-and-competitors
   分析京东与竞品截图、内部指标和体验问题

6. cross-validate-findings
   区分 supported / provisional / unavailable，处理冲突

7. synthesize-opportunities-and-assets
   生成 Gap、定位、机会、设计语言、品类资产和策略纵深链

8. compose-industry-content-draft
   输出 typed Industry Content Draft

9. self-review
   Reviewer 检查覆盖、证据、品类特异性、行动可用性和风险
```

一个 compiled Skill 可以包含以上 Stage；仍只有一个 Skill Invocation，不允许内部执行 `generate-persona`。

现有 compiled-contract 校验还不足以阻止“同一 invocation 下出现另一个 `actor_type=skill`”。Release A 必须在 Skill Execution Contract／Plan 编译边界增加不变量：除输出 Stage 外，不得出现 Skill Actor；输出 Stage 的 `actor_id` 必须等于外层 `contract.skill_id`。该规则适用于所有 compiled Skill，不只针对 Industry。

Single 模式的用户分析使用相同 Persona Knowledge 和数据方法，但由 Industry Skill 自身的 Stage 负责。

## 12. Multi Skill 设计

Release C 将 Industry Deliverable Composition 从 `standalone_compat` 升级为 Portfolio：

```text
synthesizer_skill_id: industry-market-analysis
```

候选 Contributor：

```text
competitive-web-research
competitive-analysis
generate-persona
build-experience-metrics
run-heuristic-evaluation
issue-prioritization
jobs-to-be-done
journey-map
virtual-user-research（simulation only）
```

### 12.1 Contribution 映射

| Contribution Type | Industry Canonical |
|---|---|
| `market_landscape` | `marketLandscape` |
| `competitive_analysis` | `competitorAnalysis` |
| `persona` | `audienceSegments` |
| `jobs_to_be_done` | 用户任务与决策链 |
| `journey` | 用户路径与体验断点 |
| `metrics` | `measurementPlan` |
| `design_audit` | `jdDiagnosis` |
| `prioritization` | `opportunities` |
| `action_plan` | `strategyChains` |
| `virtual_user_hypothesis` | provisional 用户假设 |

### 12.2 Persona Dataset Binding

当 Capability Demand 要求真实 Persona 且用户声明可提供数据时：

```text
user_research_dataset Pending Input
→ generate-persona Contributor
→ Research Contribution
→ Industry Synthesizer
→ audienceSegments
```

同一 Dataset Artifact 可以绑定到多个计划步骤，但只上传和封存一次。Plan 中必须显式列出所有目标步骤。

用户无法提供数据时：

- 不把 simulation 当作 dataset-derived Persona。
- Planner 可以不选择 `generate-persona`，由 Industry 输出待验证的人群假设；或者显式选择 virtual-user simulation，并保留其 Evidence Class。
- 不改变 Task 模式。

## 13. Joyspace 只读接入

### 13.1 Tool

新增：

```text
joyspace-read
```

唯一允许的操作：

```text
search
view
```

底层调用：

```text
o2 launch webcli joyspace search ...
o2 launch webcli joyspace view ...
```

### 13.2 Adapter

新增：

```text
apps/orchestrator-runtime/src/runtime/o2-joyspace-read-adapter.ts
```

要求：

- 使用进程参数数组，不使用 Shell 字符串拼接。
- 严格拒绝 search/view 以外的 operation。
- 固定 `endpointHost=joyspace.jd.com`。
- Receipt 记录 o2/webcli 版本、状态、耗时和重试。
- Search 输出 title、URL、author、updatedAt、preview。
- View 输出 title、body、author、URL。
- View 正文写入只读 Knowledge Snapshot Artifact，并计算内容 Hash。
- 认证、Browser Bridge、超时、网络和权限错误分别归类。
- 日志和错误不得泄露 Cookie、Token 或正文中的敏感值。

### 13.3 失败策略

Joyspace 是增强性 Knowledge 路径：

```text
可用
→ 实时搜索和 View
→ Frozen Knowledge Snapshot

不可用
→ 记录 Knowledge Gap
→ 继续使用用户材料、公开证据和已批准的冻结 Knowledge
```

不得静默把 stale Cache 声称为最新内容。任何冻结 Cache 都必须保留来源日期和 stale 状态。

### 13.4 权限

- Tool 只读。
- 默认 sensitivity 为 `internal`。
- 是否允许内容进入模型继续服从 Task sensitivity 和现有模型出境策略。
- 如果当前模型路径不允许处理该内部文档，Task 保留 Gap，而不是绕过策略。

## 14. Canonical 编译与 Final Review

新增：

```text
apps/orchestrator-runtime/src/report/industry-market-deliverable-assembler.ts
```

当前 `CurrentDeliverableService` 的 `reviewed_skill_assembly` 分支只会调用 Research Strategy Assembler。Release A 必须把它改为显式且封闭的分派：

```text
research_strategy_report
→ assembleResearchStrategyDeliverable

industry_market_analysis_report
→ assembleIndustryMarketDeliverable

其他 reviewed_skill_assembly
→ fail closed
```

Industry 不得落入通用 `generateDraft()`／全文生成路径。Assembler 只负责确定性工作：

```text
Draft 字段映射
稳定 ID
Evidence Binding
Coverage Ledger
Data Gap
Risk
Contribution Ledger Mapping
Artifact Binding
Canonical Hash
```

Step 10 不重新调用 LLM 全文改写。单／多 Skill 使用各自上游产物，但生成同一 Industry Payload；一条模式不得消费另一条模式的中间 Artifact。

### 14.1 Review Contract

新增 `report-review-v3`，仅用于 `industry_market_analysis_report`：

- `packages/api-contract/control-workflow.ts` 增加 Industry Review Dimension IDs 和 v3 Artifact 版本。
- `schemas/report-review.schema.json` 增加 v3 条件分支，要求下列维度恰好一次。
- `ReportReviewService` 按 Deliverable 选择 v3，并同时执行确定性引用检查和语义 Reviewer。
- `report-document-composer.ts`、`current-report-package-reader.ts` 和 `task-workflow.ts` 接受并核验 Industry 的 v3 Review；v1/v2 行为保持不变。

Industry Review 维度：

```text
requirement_coverage
question_coverage
ten_dimension_coverage
evidence_coverage
market_claim_strength
persona_evidence_boundary
competitor_sample_integrity
jd_diagnosis_quality
category_specificity
strategy_chain_actionability
category_asset_provenance
measurement_quality
risk_disclosure
visual_quality
```

Schema 和确定性校验器只检查结构、引用、Hash、状态和 Coverage。品类特异性、策略质量等由 Reviewer 判断，不新增硬编码规则引擎。

Release A 同步实现一次有界的 `industry-market-content-patch-v1`：不得删除／重排已有语义单元，不得更换 Evidence，不得提升确定性，只能修改 Reviewer 明确授权的稳定目标。一次 Patch 后仍不通过则任务暂停／失败，不得落入当前其他 Deliverable 的全文 regenerate 路径。

## 15. 双报告输出

### 15.1 Canonical Detail

新增独立的无损 Projector：

```text
apps/orchestrator-runtime/src/report/industry-market-report-projector.ts
```

它必须设置 Canonical Artifact Binding、`projectionMode: full`、`coveredPointers` 和空 `omittedPointers`，并同时通过顶层 Pointer Coverage 与语义 Unit exactly-once Coverage。用户上传截图可以只凭 Screenshot Evidence 展示，不得伪造 URL；Browser Capture 继续保留现有 URL／Capture 绑定校验。

完整投影 Industry Canonical，保留全部：

```text
10 维覆盖
行业与供给
用户分层
竞品矩阵
京东内诊
Gap 与定位
机会与纵深链
品类资产
指标与验证
Data Gap
Evidence Appendix
```

优先复用现有通用表现能力：

```text
metric-cards
truth-triad
card-grid
flow
strategy-matrix
roadmap
validation-gates
risk-register
visual-gallery
audit-appendix
```

V1 不新增一批领域组件。只有真实 corpus 证明现有组件无法表达时，再增加最小必要组件。

当前 Report Template Parser 固定使用既有 13 个 Section ID。Industry Template 只修改这些 Section 的业务标题，由 Projector 在内部组织 10 维内容；V1 不扩大全局 Section ID 枚举。

### 15.2 Editorial Summary

继续使用现有真实 LLM Full HTML Pipeline：

- 输入只能来自 Reviewed Industry Canonical 和冻结 Source Bundle。
- 自由组织叙事、章节、CSS 和内联 SVG。
- 不固定 5 Tab，不复制宠物食品／图书 Demo。
- 禁止 JavaScript、网络请求和未授权 URL。
- Summary Fidelity／Coverage 失败最多一次 Targeted Repair。
- Summary 失败不影响 Detail。
- Industry `strategyChains`、`categoryAssets`、`measurementPlan` 使用稳定的 required group ID；P0 Strategy Chain 必须进入 Summary Coverage。
- 当前 Summary Source 上限仍为 1,000 Units／512 KiB。超过上限时 Summary 显式失败，Detail 保持可用；Release A 不通过静默删减 Canonical 绕过该上限。

### 15.3 样式参考

以下仅作为质量参考：

```text
tmp/industry-market-analysis-demos/pet-food-industry-experience-demo.html
tmp/industry-market-analysis-demos/jd-books-industry-experience-demo.html
/Users/heyunshen/Downloads/京东图书行业分析与资产库-口语化+人群分层26.7.html
```

参考信息密度、层级、组件语言和决策可读性，不复制 HTML、CSS、Hero、固定章节或案例文案。

## 16. 路由与触发

### 16.1 自然语言触发

强信号：

```text
行业分析
市场分析
赛道分析
品类分析
频道年度规划
从行业到设计策略
市场、用户、竞品和京东现状综合分析
```

只有表达行业级范围时才选择 Industry；出现“竞品”一词不能单独触发。

### 16.2 歧义处理

例如：

```text
帮我分析宠物食品竞品
```

应澄清：

```text
竞品专项分析
或
完整行业与频道策略分析
```

前者继续使用 `competitive_analysis_report`，后者使用 `industry_market_analysis_report`。

### 16.3 显式触发

Single Skill 支持：

```text
$industry-market-analysis
```

Multi Skill 通过用户选择 `multi_skill` 和完整 Industry Intent 触发；继续拒绝：

```text
multi_skill + $industry-market-analysis
```

### 16.4 后续升级

如果用户先完成 Competitive Task，后来要求完整 Industry Report：

- 不修改原 Task 或 Deliverable。
- 创建新的 Industry Task。
- 将原 SEALED Competitive Canonical 作为明确绑定的输入 Evidence／Contribution。
- 补充其余市场、用户、京东和策略材料。

## 17. 降级矩阵

| 缺失能力／资料 | 允许继续输出 | 禁止声明 |
|---|---|---|
| 无竞品截图 | 公开资料竞品初步分析 | 截图级体验结论 |
| 无京东截图 | 行业、用户、竞品和策略初稿 | 京东页面问题定位 |
| 无用户 CSV | 用户假设、模拟 Persona、建议分层维度 | 真实用户分层、占比、已验证 Persona |
| 无内部 CSV | 体验诊断、指标建议 | 真实 GMV、CVR、复购和内部经营结论 |
| 无 AB 结果 | 验证计划、指标名称 | 已实现收益 |
| Joyspace 不可用 | 用户材料、公开证据、冻结 Knowledge | 使用最新内部知识 |
| Contributor degraded | 其他受支持内容与显式 Gap | 假装 Contributor 成功 |

报告和执行 Receipt 必须使用同一 Gap 口径。资料不足可以形成 `completed_with_gaps`；必须回答但用户拒绝修改范围时，任务保持 blocked／awaiting input，而不是生成伪结论。

## 18. 分阶段实施

每个 Release 独立可合并和使用；后续 Release 未完成不影响前一阶段价值。

### Release A：Single Skill Industry 闭环

范围：

- 新 Task Type 和第七 Deliverable。
- Industry Intent、澄清和资料可用性。
- CSV Dataset Pending Input 和 owner-bound 上传。
- 用户无法提供后的 Plan Revision。
- Single Industry compiled Skill。
- Industry Canonical、Evidence、Review。
- Canonical Detail 和 Editorial Summary。
- 宠物食品与图书真实闭环。

限制：

- Industry 暂只支持 `single_skill`。
- Joyspace 使用已批准冻结 Knowledge，不做实时搜索。
- 不执行独立 `generate-persona` Skill；用户分析在 Industry Skill 内基于相同 Knowledge 完成。
- Planning Service 必须显式拒绝 `multi_skill + industry_market_analysis_report`；`standalone_compat` 只会关闭 Portfolio 编译，不能单独防止 Plan v2 被错误写入冻结为 multi 的 Task。

验收：

```text
single_skill
CurrentExecutionPlan v2
skill_invocations.length = 1
skill_id = industry-market-analysis
Review = pass
Detail = SEALED
Summary Fidelity = pass 或显式 failed 且 Detail 可用
```

预计：`12–16` 个工程日。

### Release B：Joyspace 只读增强

范围：

- `joyspace-read` Tool、Manifest 和 Schemas。
- O2JoyspaceReadAdapter。
- search/view Receipt、Knowledge Snapshot、Hash 和 sensitivity。
- 认证／Browser Bridge／超时的错误分类。
- 可用和不可用两条真实 Smoke。

Release A 不依赖它；B 失败只减少 Knowledge 新鲜度，不阻断已支持的用户资料与公开证据链。

预计：`3–5` 个工程日。

### Release C：Multi Skill 与 Persona

范围：

- Industry Deliverable Portfolio Policy。
- Industry Synthesizer。
- Relevant Skill 增加 Industry compatibility。
- Dataset Demand 到 `generate-persona` 的明确 Pending Input Binding。
- Competitive、Persona、Metrics、Design Audit、Prioritization Contributions。
- Cross-Skill Review、Ledger 和 Canonical Mapping。
- Single/Multi 模式隔离与等价结果验证。
- 一次真实 Multi Skill Industry Smoke。

验收：

```text
multi_skill
CurrentExecutionPlan v3
Industry Synthesizer exactly one
Required Demand exactly one Owner
Persona dataset-derived 与 simulation 不混淆
Contribution Ledger 完整
Review = pass
```

预计：`5–7` 个工程日。

### Release D：报告校准与人工验收

范围：

- 图书、宠物食品、美妆、数码、家居／母婴至少 5 个初始 canary。
- 最终至少 10 份真实 Industry Report corpus。
- 1440×900 主验收和 390×844 辅助移动验收。
- Summary／Detail 内容职责、Evidence 边界和视觉质量评审。
- 人工代码评审。

预计：`5–7` 个工程日。

## 19. 主要改动面

本方案预计涉及约 `30–45` 个源码、配置、Schema 和测试文件，明显超过 5 文件设计检查线，但属于用户明确要求的新端到端 Deliverable。新增的是两个窄 Module，不新增独立服务：

```text
DatasetInputGateStore
O2JoyspaceReadAdapter
```

### 19.1 合同与路由

```text
packages/api-contract/plan.ts
packages/api-contract/http.ts
schemas/research-task-v2.schema.json
schemas/current-execution-plan.schema.json
schemas/current-execution-plan-v3.schema.json
apps/orchestrator-runtime/src/control/requirement-refinement-service.ts
apps/orchestrator-runtime/src/planners/planning-guidance.ts
apps/orchestrator-runtime/src/planners/planning-guidance-adapter.ts
apps/orchestrator-runtime/src/planners/capability-demand-graph.ts
apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts
apps/orchestrator-runtime/src/runtime/config-loader.ts
apps/orchestrator-runtime/src/runtime/skill-loader.ts
apps/orchestrator-runtime/src/skills/skill-execution-contract.ts
orchestrator/planning-capability-crosswalk.yaml
orchestrator/planning-policy.yaml
orchestrator/decision-graph.yaml
```

### 19.2 Dataset 输入

```text
apps/orchestrator-runtime/src/control/pending-input-contract.ts
apps/orchestrator-runtime/src/control/task-workflow.ts
apps/orchestrator-runtime/src/control/artifact-store.ts
apps/orchestrator-runtime/src/control/dataset-input-gate-store.ts
apps/orchestrator-runtime/src/evidence/evidence-service.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
database/control-plane.ts
apps/agent-api/src/control-runtime.ts
apps/agent-api/src/routes/control-tasks.ts
apps/web/src/api/client.ts
apps/web/src/components/stages/Stage2Plan.tsx
apps/web/src/hooks/useTaskFlow.ts
```

### 19.3 Industry Skill 与 Deliverable

```text
skills/industry-market-analysis/SKILL.md
skills/industry-market-analysis/references/industry-method.md
orchestrator/skill-executions/industry-market-analysis.yaml
orchestrator/skill-registry.yaml
orchestrator/deliverable-registry.yaml
orchestrator/evidence-policy.yaml
orchestrator/report-rubrics/industry-market-analysis-report.yaml
orchestrator/prompts/deliverables/industry-market-analysis-report.md
orchestrator/report-templates/industry-market-analysis-report.yaml
schemas/skills/industry-market-content-draft-v1.schema.json
schemas/skills/industry-market-content-patch-v1.schema.json
schemas/deliverables/industry-market-analysis-report.schema.json
```

### 19.4 Canonical 与报告

```text
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
apps/orchestrator-runtime/src/report/industry-market-deliverable-assembler.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
packages/api-contract/control-workflow.ts
schemas/report-review.schema.json
apps/orchestrator-runtime/src/report/editorial-report-contract.ts
apps/orchestrator-runtime/src/report/editorial-report-materializer.ts
apps/orchestrator-runtime/src/report/editorial-report-renderer.ts
apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts
apps/orchestrator-runtime/src/report/editorial-summary-source.ts
apps/orchestrator-runtime/src/report/report-document-composer.ts
apps/orchestrator-runtime/src/report/current-report-package-reader.ts
apps/agent-api/src/routes/system-capabilities.ts
```

### 19.5 Joyspace

```text
orchestrator/tool-registry.yaml
tools/joyspace-read/manifest.yaml
tools/joyspace-read/input.schema.json
tools/joyspace-read/output.schema.json
apps/orchestrator-runtime/src/runtime/o2-joyspace-read-adapter.ts
apps/agent-api/src/control-runtime.ts
```

## 20. 测试计划

### 20.1 路由与 Clarification

- 完整行业意图选择 `industry_market_analysis_report`。
- 单项竞品继续选择 `competitive_analysis_report`。
- 单项页面走查继续选择 `design_audit_report`。
- 只做用户分层不被误路由为 Industry。
- 歧义输入只问一次 Deliverable 选择。
- 多轮澄清保留累计资料可用性。
- `$industry-market-analysis` 只允许 Single Skill。
- `multi_skill + $industry-market-analysis` 继续拒绝。

### 20.2 Dataset

- 合法 UTF-8 CSV。
- 引号、逗号、嵌入换行和空字段。
- 非 CSV、超限、空文件、非法 UTF-8 拒绝。
- 跨 Owner／Task／Plan Artifact 拒绝。
- 文件 Hash、行列 Pointer 和读取重验。
- PII／confidential 阻断。
- Plan Revision 后旧 Dataset 不进入新 Plan，未绑定上传被失效，历史已绑定 Artifact 保持可读。
- Dataset Evidence 可以按 Evidence Policy 满足 required dataset class；不得伪装为 core Tool，也不得被全局 core-tool 过滤错误排除。
- Multipart Idempotency-Key 重放稳定，内容冲突失败。

### 20.3 Single Skill

- Plan v2 恰好一个 Industry Invocation。
- 所有内部 Stage 归属于同一 Invocation。
- 编译合同拒绝任何 `actor_type=skill` 且 `actor_id` 不等于外层 Industry Skill 的 Stage。
- 不存在隐藏 `generate-persona` Invocation。
- 缺用户数据输出 provisional／Gap。
- 缺内部数据不生成 KPI 事实。
- Skill degraded 与 Receipt／历史 Gap 一致。

### 20.4 Multi Skill

- Plan v3 唯一 Industry Synthesizer。
- Required Demand 恰好一个 Owner。
- 同一 Dataset 可绑定 Persona 和 Industry Steps，但只封存一次。
- Contribution Ledger 对每个 Unit 恰好一个 disposition。
- Persona、simulation、metrics、design audit 状态不混淆。
- 任意 Contributor 失败不触发跨模式 fallback。

### 20.5 Joyspace

- 只允许 search／view。
- 任意写操作被拒绝。
- 输出 Schema、Receipt、URL、updatedAt 和 Hash 正确。
- 认证、Bridge、超时和无结果状态可区分。
- 内部内容不进入不允许的模型路径。
- Tool 不可用时产生显式 Gap。

### 20.6 Canonical 与报告

- 10 维 Coverage Ledger 齐全。
- Canonical `scope` 与用户确认的 `industry_scope` 一致。
- Strategy Chain 的 `priority`／`opportunityId` 闭包完整。
- Evidence／Gap／Risk 引用完整。
- Strategy Chain 不引用不存在的截图、Evidence 或 Category Asset。
- CurrentDeliverableService 对 Industry 使用专用 reviewed-assembly 分支，未知 reviewed-assembly 类型 fail closed。
- Industry Typed Patch 只修改 Reviewer 授权目标，最多一次，且通过语义 Fidelity 检查。
- `report-review-v3` 维度、Reader、Recovery 和 Package 绑定一致。
- Detail 覆盖 Canonical 全量内容。
- Summary 不新增数字、URL、日期或事实。
- Summary 失败不影响 Detail。
- HTML 安全、无远程资源、无脚本。
- 1440×900 无横向溢出；390×844 作为辅助验收。

## 21. 真实验收矩阵

至少完成：

| 场景 | 输入 | 目的 |
|---|---|---|
| 宠物食品 | 既有 Competitive Canonical + 截图 | 复现现有 Demo 内容映射 |
| 图书 | 本地案例 + 京东截图 | 复现案例驱动内诊与策略 |
| 美妆 | 用户 CSV + 竞品截图 | 验证真实用户分层 |
| 数码 | 内部经营 CSV + 京东截图 | 验证数据增强内诊 |
| 公开资料版 | 不提供 CSV | 验证 `completed_with_gaps` |
| Joyspace 正常 | search + view | 验证真实 Receipt 与 Snapshot |
| Joyspace 故障 | 无 Bridge／认证失败 | 验证显式 Gap |
| Multi Skill | Persona + Competitive + Metrics | 验证 Portfolio 和 Ledger |

最终累计至少 10 份真实 Industry 报告，用于内容和视觉校准。

## 22. 自动化门禁

每个 Release 至少运行：

```bash
pnpm quality
pnpm --dir apps/web build
git diff --check
```

真实验收继续使用 `smoke:current:real` 的现有入口和新 Scenario／Fixture，不新增第二套 Smoke 框架。真实运行必须包含：

```text
真实 Gateway
真实 Tavily
真实 Joyspace（Release B）
真实 Artifact / Evidence / Review / Report Store
```

Fixture 只验证本地合同，不能替代真实闭环。

## 23. 开发周期评估

### 23.1 单人预期

| Release | 工程日 |
|---|---:|
| A：Single Skill Industry 闭环 | 12–16 |
| B：Joyspace 只读增强 | 3–5 |
| C：Multi Skill + Persona | 5–7 |
| D：真实报告校准 | 5–7 |
| **总计** | **25–35** |

预计日历周期：

```text
5–7 周
```

### 23.2 两人并行

CSV／Industry 主链与 Joyspace Adapter 可并行；Multi Skill 需要等待 Industry Canonical 和 Single Skill 合同稳定。

预计：

```text
3.5–5 周
```

### 23.3 可用版本节点

```text
2.5–3.5 周：可用 Single Skill Industry 版本
3.5–4.5 周：增加 Joyspace 只读知识
5–7 周：完整 Single/Multi、Persona、报告校准版本
```

### 23.4 可能额外增加 1–2 周的因素

- Joyspace Browser Bridge 或登录在部署环境不稳定。
- Runtime Skill 方法评审延迟。
- 用户 CSV 含 PII，需要重新提供匿名数据。
- 真实 LLM 输出需要多轮 corpus 校准。
- 缺少非图书真实资料。
- 内部 Knowledge 的模型出境策略未获批准。

周期不包含 Push、生产部署、权限审批等待和历史回填。

## 24. 依赖与最脆弱前提

外部依赖：

```text
o2 0.0.8
webcli 1.1.3
Chrome + Browser Bridge
Joyspace 已登录会话
真实 LLM Gateway
Tavily
真实用户／经营 CSV 和截图样本
```

最脆弱前提：

> o2 + webcli 的 Joyspace search/view 能在部署 Runtime 中获得稳定、可审计的登录态。

若该前提不成立：

- Release A 仍正常工作。
- Release B 保持未激活或产生明确 Gap。
- Industry 使用用户材料、公开资料和已批准的冻结 Knowledge。
- 不阻断 Single／Multi Industry 的其他能力。
- 不静默使用 stale Cache。

第二个关键前提：用户 CSV 在 V1 的有界文件规模和模型预算内。10 MiB 只表示原始上传上限；若有界 Model View 仍超过当前 LLM Input Compactor 预算，系统必须在执行前要求用户缩小或聚合数据。若后续需要处理超大行为明细，应另行设计批处理／数据仓库 Adapter，不在本方案中提前平台化。

## 25. 发布与回滚

### 25.1 发布顺序

```text
Release A：只开放 single_skill Industry
Release B：激活 joyspace-read optional Tool
Release C：开放 multi_skill Industry
Release D：完成 corpus 与最终人工验收
```

`MULTI_SKILL_PORTFOLIO_WRITER_ENABLED` 继续只控制多 Skill 能力是否可创建，不替代用户选择。

### 25.2 回滚

- 将 Industry Deliverable 或 Skill 改为 inactive，停止创建新任务。
- 将 Joyspace Tool 退回 draft。
- 已封存 Task、Plan、Dataset、Canonical 和报告不修改、不删除。
- 不把 Industry Task 转换为其他 Deliverable。
- 不 downcast Plan v3 或跨模式重跑。
- Dataset Artifact 按现有 Artifact 保留和失效策略处理。

预计不需要数据库 Migration；若实施时发现 Artifact 状态无法覆盖计划确认前 Dataset，优先复用现有 Publication/Invalidation 语义，不新增平行状态机。

## 26. 实施完成定义

只有同时满足以下条件，才能声明完整完成：

- 第七 Deliverable 进入 active Registry。
- Industry Single Skill 真实闭环通过。
- Industry Multi Skill 真实闭环通过。
- CSV Dataset 上传、Hash、Evidence 和跨 Owner 隔离通过。
- 用户无法提供资料时可显式 Revision 和降级。
- Joyspace search/view 真实调用、Receipt 和 Snapshot 通过。
- Persona dataset-derived 与 simulation 边界通过。
- Strategy Chain、Category Asset 和 10 维 Coverage 通过 Review。
- Detail 全量覆盖 Canonical。
- Summary Fidelity 通过，或失败时 Detail 保持可用。
- 10 份真实报告 corpus 完成人工确认。
- `pnpm quality`、Web Build 和 `git diff --check` 通过。
- 完成最终人工代码评审。
- 未经额外授权，不 Push、不部署。
