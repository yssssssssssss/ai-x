# 答案型研究闭环与动态报告开发文档

> 状态：Phase 1–6 已实现并提交；自动化、Web build、浏览器四流程与独立 Gate 8 源码审查通过；真实 Tavily 单独验证通过；修正后的完整 Gateway/数据库闭环与 live Zero 发布仍待外部验收。
>
> 基线分支：`feat/skill-runtime-report-fidelity@b1e5c7aafd22177ad224a8f62e367da6533fdf0f`
>
> 集成分支：`feat/research-answer-dynamic-reports`
>
> 架构决策：`docs/adr/0004-separate-research-planning-from-answer-delivery.md`
>
> 执行清单：`docs/plans/2026-08-23-answer-oriented-research-dynamic-report-todolist.md`
>
> 上游设计真相源：`docs/plans/2026-08-22-skill-runtime-report-fidelity-development.md` 与 `docs/adr/0003-compile-skills-into-frozen-execution-dag.md`
>
> 本文是“研究规划与直接研究回答分离、答案型 Deliverable、动态报告结构和一次性集成发布”的设计真相源。

## 1. 背景

最新完成任务 `e16880e3-21c2-4541-9e38-fc750185ee4b` 技术流程成功，但用户认为结论简单，报告中的大量模块只是在分析问题，而不是直接回答问题。

已验证事实：

- 任务被识别为 `user_research_planning`。
- Deliverable 被强制规范化为 `research_plan`。
- 用户明确要求“研究报告、策略地图、心智模型、设计原则、机会点清单”，最终只在 `deliverables: string[]` 中列出名称。
- ProblemGraph 主要问题是“如何构建研究框架”，不是“当前策略答案是什么”。
- 选中 `focused` 方案，真实执行 1 Tool、3 Skill、1 LLM、1 Reviewer。
- 中间整合步骤生成约 10,983 字，已包含策略地图、心智模型、设计原则和机会点。
- Canonical Deliverable Schema 没有上述一等字段，无法完整承接。
- ReportDocument v1 再次压缩为约 3,503 字正文，并保留空的 Visual Evidence、Comparison、Risks 章节。
- 用户确认“一线城市、宠物主粮、电商平台 App、淘宝/京东/抖音”后，最终 Scope 仍显示未澄清。
- `journey-map` 和 `generate-interview-guide` 输出为 degraded，旧 Runtime 仍将任务标记为普通 completed。
- 当前运行环境仍是 `main@fa27873`，未使用已完成的 Skill Runtime 分支。

根因不是单一页面问题，而是三层叠加：

```text
运行环境仍是旧 main
        +
任务意图被建模为 research_plan
        +
固定 Deliverable/Report 结构无法保存和展示直接答案
```

## 2. 统一修复原则

### 2.1 不进行分片上线

不得先单独合并 Skill Runtime，再单独上线答案型任务，最后再改报告。所有改动在统一集成分支完成，只有最终 Gate 全部通过后，才一次性合并到 `main` 并重启服务。

### 2.2 任务语义先于报告展示

必须先区分“如何研究”和“直接回答”，再选择 ProblemGraph、Skill、Deliverable 和报告结构。不能靠报告模板在最后一层修正错误任务语义。

### 2.3 Canonical Deliverable 是唯一真相源

动态报告只能消费经过 Review 的 Canonical Deliverable；不得直接拼接未经 Review 的中间 Step Artifact 文本。

### 2.4 动态不等于无约束

报告采用“固定答案骨架 + 动态专题章节 + 类型化 Block”。章节主题和顺序可动态，证据、来源指针、置信度、请求产物和必答问题必须通过确定性合同校验。

## 3. 目标

### 3.1 Primary Setpoint

用户创建研究任务时，系统先明确其需要“研究计划”还是“直接研究答案”；答案型任务必须基于当前可用证据逐问题给出直接结论、置信度、业务含义和行动建议，并将用户要求的策略地图、心智模型、设计原则和机会点真正实体化。报告以直接答案为首屏，动态展示实际分析内容，不再被固定通用章节压缩。

### 3.2 Acceptance

- 模糊任务在生成候选计划前强制选择 plan 或 answer。
- `user_research_planning` 只生成 `research_plan`。
- 新增 `research_synthesis`，只生成 `research_strategy_report`。
- `canonicalizeExpectedDeliverables()` 不再覆盖用户已确认的交付意图。
- 答案型 Required Question 全部有直接答案。
- 直接答案必须带 Evidence 或显式 provisional 状态。
- 策略地图、心智模型、设计原则、机会点和优先行动是结构化对象，不是字符串名称。
- 动态报告默认先展示答案，再展示证据、分析、行动和局限。
- 不生成无内容章节。
- Reviewer 的条件通过、Skill degraded、Requirement ambiguity 必须进入 limitations/openQuestions。
- 任务卡明确显示“研究方案已生成”或“研究答案已完成”，不混用“任务完成”。
- 现有 Plan v1、Current Plan v2、ReportDocument v1/v2 和 historical tasks 继续可读。
- 已完成的 Skill Runtime、安全、Knowledge、Tool、Gap 和报告保真能力不得回归。
- 最终真实 Gateway/Tavily 任务、浏览器验收、全量测试和独立审查全部通过后才允许合并。

## 4. 非目标

本次不包含：

- 用完全自由 Markdown 取代结构化 Deliverable。
- 允许报告生成器直接消费未 Review 的 Step Artifact。
- 在答案证据不足时编造确定性结论。
- 一次任务同时生成多个独立顶层 Deliverable。
- 自动执行真实访谈、问卷招募或内部数据分析而没有对应输入。
- 一次性迁移所有 Legacy Skill 到 compiled 模式。
- 单独上线任一中间 Phase。
- 重写历史 SEALED Artifact。

## 5. 分支与发布策略

```text
main@fa27873
  └── feat/skill-runtime-report-fidelity@b1e5c7a
        └── feat/research-answer-dynamic-reports
              ├── 任务意图
              ├── 答案型Deliverable
              ├── 答案型执行计划
              ├── 动态报告
              ├── Answer Review
              └── 最终一次性合并到main
```

规则：

- `feat/skill-runtime-report-fidelity` 保持冻结，不再直接合入 `main`。
- 所有新增修复只进入 `feat/research-answer-dynamic-reports`。
- 每个 Phase 独立 commit、可构建、可测试。
- 新 Task Type 和 Deliverable 在最终 Activation commit 前保持 inactive，不影响既有生产路径。
- 最终只提交一个集成 PR 或执行一次本地合并。
- 合并后必须重启 Agent API 和 Web，并运行版本验收。

## 6. 领域模型

### 6.1 Research Planning

Canonical term：**研究规划任务**。

回答：

- 应该如何研究；
- 用什么方法；
- 招募谁；
- 收集什么；
- 如何排期与验收。

映射：

```text
task_type: user_research_planning
deliverable: research_plan
```

### 6.2 Research Synthesis

Canonical term：**研究回答任务**。

回答：

- 当前证据支持什么结论；
- 业务应该如何行动；
- 哪些策略优先；
- 哪些结论仍需验证。

映射：

```text
task_type: research_synthesis
deliverable: research_strategy_report
```

### 6.3 Direct Answer

每个用户 Required Question 的直接回答，必须包含结论、Evidence、置信度、业务含义、建议行动和待验证内容。

### 6.4 Requested Artifact

用户明确要求本次实际生成的内容对象，例如 strategy map、mind model、design principles、opportunity backlog。仅在“交付物清单”中出现名称不算完成。

### 6.5 Dynamic Report

由 Canonical Deliverable 的真实内容生成的类型化章节集合。章节主题可动态，必答问题、请求产物、Evidence 和风险覆盖不可动态省略。

实施时同步更新根 `CONTEXT.md`，只记录上述业务术语，不写实现细节。

## 7. 运行能力识别

新增只读接口：

```text
GET /api/system/capabilities
```

响应包含：

```text
applicationVersion
planContractVersions
reportDocumentVersions
activeTaskTypes
activeDeliverables
compiledSkills
knowledgeIndexHash
toolRegistryHash
```

Web 开发信息区展示：

```text
Plan: current-v2
Report: report-document-v2
Task Types: user_research_planning, research_synthesis
Deliverables: research_plan, research_strategy_report
Compiled Skills: generate-research-plan
```

部署验收必须验证新任务持久化：

```text
execution_contract_version = current-execution-plan-v2
skill_invocations 非空
答案型任务 deliverableType = research_strategy_report
动态报告 version = report-document-v2
```

## 8. Requirement 与任务意图

### 8.1 新增 Outcome Mode

Requirement 增加：

```ts
outcome_mode: 'plan' | 'answer';
requested_artifacts: RequestedArtifact[];
```

`RequestedArtifact` 允许：

```text
executive_answers
research_report
strategy_map
mind_model
design_principles
opportunity_backlog
prioritized_actions
channel_strategies
action_plan
```

### 8.2 明确路由

规划意图信号：

- 制定研究方案；
- 规划怎么研究；
- 设计访谈、问卷、样本、排期；
- 输出研究计划。

答案意图信号：

- 完成研究；
- 直接给结论；
- 提出策略与优先级；
- 输出心智模型、策略地图、设计原则和机会点；
- 告诉我应该怎么做。

### 8.3 模糊请求闸门

同时出现“创建调研任务”和“给出策略答案”时，返回：

```text
请选择本次最终结果：
A. 研究方案：告诉你后续如何开展研究
B. 策略答案：基于当前资料直接完成分析并给出结论
```

未选择时：

- 保持 `awaiting_clarification`；
- 不生成 ProblemGraph；
- 不生成候选 Plan；
- 不消耗真实 Tool。

### 8.4 Deliverable 选择

- Requirement LLM 输出 canonical `outcome_mode` 和 `requested_artifacts`。
- `outcome_mode=plan` 强制 `research_plan`。
- `outcome_mode=answer` 强制 `research_strategy_report`。
- `canonicalizeExpectedDeliverables()` 只校验兼容性，不再将任意用户要求静默覆盖为 task type 默认值。
- 一个任务只允许一个 Primary Deliverable；requested artifacts 作为该 Deliverable 内部必交付内容。

## 9. 新 Task Type：research_synthesis

需要更新：

- ResearchTaskV2 task_type enum。
- Research Task Schema。
- Decision Graph applies_to。
- Planning Guidance 场景和 Profile 映射。
- Capability Crosswalk。
- Evidence Policy。
- Deliverable Registry。
- Requirement prompt和测试fixture。
- Sidebar/History状态标签。

答案型任务至少激活：

- research goal；
- decision use；
- evidence sufficiency；
- source authority；
- strategy actionability；
- sensitivity；
- output standard。

## 10. 新 Deliverable：research_strategy_report

新增 Registry：

```text
id: research_strategy_report
status: draft（最终Activation commit改为active）
task_types: [research_synthesis]
payload_schema: schemas/deliverables/research-strategy-report.schema.json
synthesis_prompt: orchestrator/prompts/deliverables/research-strategy-report.md
review_rubric: orchestrator/report-rubrics/research-strategy-report.yaml
evidence_policy: research-strategy-report
report_template: dynamic-research-strategy
```

### 10.1 Payload

```text
title
decisionContext
executiveAnswer
directAnswers
evidenceBackedFindings
dynamicSections
strategyMap
mindModel
designPrinciples
opportunities
prioritizedActions
channelStrategies
recommendations
limitations
openQuestions
requestedArtifactBindings
```

### 10.2 Direct Answer

```text
questionId
question
answer
answerStatus
evidenceIds
confidence
businessImplication
recommendedAction
validationNeeded
```

`answerStatus`：

- `supported`：有足够 Evidence。
- `provisional`：当前最佳答案，但仍需验证。
- `unanswered`：证据不足，Required Question 不允许普通 completed。

### 10.3 Requested Artifact Binding

```text
artifactType
sourceField
blockIds
questionIds
evidenceIds
status
```

规则：

- 请求 strategy_map 必须有非空 StrategyMap。
- 请求 mind_model 必须有非空 MindModel。
- 请求 design_principles 至少一条有依据的 Principle。
- 请求 opportunity_backlog 至少一个带Evidence/置信度的 Opportunity。
- 请求 prioritized_actions 至少一个带 P0/P1/P2、Owner类型、行动和验证方式的 Action。

## 11. 答案型 ProblemGraph

答案型问题不得使用“如何构建研究框架”作为主要问题。

本场景示例：

```text
Q1 当前宠物食品用户心智的核心结构是什么？
Q2 认知、种草、搜索、购买各阶段的核心任务与断点是什么？
Q3 猫粮和狗粮的品类心智有哪些共性和差异？
Q4 App、淘宝、京东、抖音分别应承担什么场域角色？
Q5 哪些设计表达原则已有证据支持？
Q6 哪些机会点应进入P0/P1/P2？
Q7 哪些内容仍只是待验证假设？
```

每个 Required Question 的 Acceptance：

- 一段直接答案；
- Evidence 或 provisional 标签；
- 业务含义；
- 建议行动；
- 置信度；
- 禁止只返回“建议进一步研究”。

## 12. 答案型执行编排

首版编排：

```text
1 Requirement和决策问题冻结
2 Knowledge与领域方法读取
3 多Query公开资料检索
4 官方来源/品牌页面取证
5 用户材料读取（如提供）
6 证据聚类、冲突和缺口检查
7 逐Required Question直接回答
8 生成策略地图和心智模型
9 生成设计原则和机会点优先级
10 独立Reviewer反证
11 合成research_strategy_report
12 Answer Quality Review
13 Dynamic Report生成
```

规则：

- `generate-research-plan` 只能用于 plan 模式。
- `generate-interview-guide` 只能在用户明确请求研究工具时作为附加产物。
- `journey-map` 无用户材料时只能生成 provisional framework，不得冒充用户洞察。
- 答案模式优先使用证据采集、研究综合、竞品/场域分析和策略综合能力。
- 无一手数据时仍给出当前最佳答案，但必须标记 Evidence范围、置信度和待验证内容。

建议新增 compiled Skill：

```text
research-strategy-synthesis
```

阶段：

- evidence inventory；
- direct answer synthesis；
- conflict review；
- strategy materialization；
- action prioritization；
- self review。

## 13. 动态报告结构

现有 ReportDocument v2 尚未进入 main，因此在集成分支直接完善最终 v2，不引入中间 v3。

### 13.1 固定最小骨架

答案型报告必须包含：

1. Executive Answers
2. Priority Actions
3. Evidence and Confidence
4. Limitations and Open Questions
5. Evidence Appendix

### 13.2 动态专题章节

由 Direct Answers、requested artifacts 和真实内容决定，例如：

```text
宠物食品心智模型
认知链路策略
种草链路策略
搜索链路策略
购买链路策略
猫粮与狗粮差异
App/淘宝/京东/抖音场域策略
设计原则
机会点优先级
实施路线图
```

规则：

- 无内容章节不生成，也不进入目录。
- `Question Analysis` 仅在分析底稿中展示。
- 用户请求的产物必须进入主报告。
- 章节标题、顺序和数量可动态。

### 13.3 类型化 Block

```text
direct_answer
evidence_finding
strategy_map
mind_model
comparison_matrix
design_principle
opportunity
priority_matrix
action_plan
metric
risk
image
chart
evidence_appendix
```

每个 Block 必须携带：

- question IDs；
- source pointers；
- Finding/Summary IDs；
- Evidence IDs；
- confidence；
- answer/provisional状态。

### 13.4 Answer-first 顺序

```text
先直接回答
→ 再展示证据
→ 再解释分析
→ 再给行动
→ 最后披露局限
```

ProblemGraph、方法、访谈提纲等进入“分析底稿”，不占据报告首屏。

## 14. 动态报告生成

新增 `DynamicReportComposer` Module：

| Interface | 责任 |
|---|---|
| Deliverable + requested artifacts -> ReportDocument v2 | 生成章节Blueprint与Block |
| Payload Schema + Report coverage -> pass/fail | 验证必答与产物覆盖 |
| Dynamic section list -> Web/Markdown/Zero | 一次生成，多端共享 |

Report Composer 不生成新研究结论，只做无损结构转换。

## 15. Answer Quality Review

新增确定性维度：

```text
direct_answer_coverage
requested_artifact_presence
answer_evidence_strength
decision_usefulness
hypothesis_conclusion_clarity
risk_consistency
```

阻断条件：

- Required Question无Direct Answer。
- supported答案没有Evidence。
- provisional答案没有validationNeeded。
- 请求产物只有名称，没有结构化对象。
- 推荐没有业务含义、优先级或行动。
- Reviewer条件通过但limitations为空。
- Skill degraded但报告未披露。
- 报告主体仍以“如何研究”为主。

语义Reviewer继续检查：

- 结论是否回应用户；
- Evidence是否足够支持措辞；
- 策略是否有决策价值；
- 不同渠道建议是否区分；
- 机会优先级是否合理。

## 16. Web信息架构

完成页顶部显示：

```text
任务模式：研究方案 / 直接研究回答
交付类型：Research Plan / Strategy Report
证据范围：Public / Knowledge / User Material / Dataset
结论状态：Supported / Provisional / Gaps
```

答案型报告视图：

```text
直接答案（默认）
动态专题
策略产物
证据
分析底稿
```

规划型报告视图：

```text
研究目标
方法与样本
执行计划
采集模板
风险与假设
```

History标签：

- `研究方案已生成`
- `研究答案已完成`
- `研究答案已完成·有缺口`

避免统一显示“已完成”造成业务误解。

## 17. Report Bundle 与 Zero

答案型 ZIP：

```text
deliverable.json
direct-answers.md
full-report.md
analysis-notes.md
report-document.json
report-review.json
evidence-manifest.json
assets/
```

Zero发布：

- 按Dynamic Section顺序渲染。
- 支持StrategyMap、MindModel、Opportunity和PriorityMatrix Block。
- 不生成空视觉章节。
- 分析底稿默认折叠或后置。

## 18. 兼容与迁移

- Plan v1继续读取。
- Current Plan v2继续读取。
- ReportDocument v1继续读取。
- 最终ReportDocument v2兼容当前未发布v2实现，不承诺中间开发快照兼容。
- Historical research_plan继续按规划型视图展示。
- 不自动将历史research_plan转换成strategy report。
- 最新任务可以在最终上线后用相同Requirement创建新的answer模式任务；不修改原Artifact。
- 新Task Type存储在JSON/Text字段中，不需要数据库Migration。

## 19. 文件范围

主要新增：

```text
schemas/deliverables/research-strategy-report.schema.json
orchestrator/prompts/deliverables/research-strategy-report.md
orchestrator/report-rubrics/research-strategy-report.yaml
orchestrator/skill-executions/research-strategy-synthesis.yaml
apps/orchestrator-runtime/src/report/dynamic-report-composer.ts
apps/orchestrator-runtime/src/report/research-strategy-projection.ts
apps/orchestrator-runtime/src/report/answer-quality-validator.ts
tests/research-strategy-contract.test.ts
tests/research-strategy-planning.test.ts
tests/dynamic-report-composer.test.ts
tests/report-review-service.test.ts
```

主要修改：

```text
CONTEXT.md
packages/api-contract/plan.ts
packages/api-contract/research-deliverable.ts
packages/api-contract/control-workflow.ts
schemas/research-task-v2.schema.json
schemas/current-execution-plan.schema.json
schemas/report-document.schema.json
orchestrator/deliverable-registry.yaml
orchestrator/evidence-policy.yaml
orchestrator/decision-graph.yaml
orchestrator/planning-capability-crosswalk.yaml
apps/orchestrator-runtime/src/control/requirement-refinement-service.ts
apps/orchestrator-runtime/src/planners/problem-graph-planner.ts
apps/orchestrator-runtime/src/planners/routed-planner.ts
apps/orchestrator-runtime/src/planners/plan-compiler.ts
apps/orchestrator-runtime/src/report/deliverable-registry.ts
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
apps/orchestrator-runtime/src/report/report-composition-service.ts
apps/orchestrator-runtime/src/report/current-report-package-reader.ts
apps/agent-api/src/routes/control-planning.ts
apps/agent-api/src/routes/control-tasks.ts
apps/agent-api/src/server.ts
apps/web/src/api/client.ts
apps/web/src/hooks/useTaskFlow.ts
apps/web/src/current-flow-state.ts
apps/web/src/components/stages/CurrentStage1Clarify.tsx
apps/web/src/components/stages/Stage2Candidates.tsx
apps/web/src/components/stages/CurrentStage4Report.tsx
apps/web/src/reporting/ReportDocumentView.tsx
apps/web/src/reporting/report-bundle.ts
```

总范围预计超过30个源码/测试文件。实现必须分Phase提交，但最终一次性合并。

## 20. 实施阶段

### Phase 1：集成基线与能力指纹

- 建立统一集成分支。
- 增加system capabilities接口。
- 建立旧main、新Skill Runtime和最终集成版本识别测试。
- 新Task Type和Deliverable保持draft。

### Phase 2：任务意图与Requirement

- 新增outcome mode和requested artifacts。
- 新增research_synthesis。
- 模糊任务强制选择plan/answer。
- 修改Deliverable选择，不再静默覆盖。
- 更新CONTEXT和Requirement测试。

### Phase 3：答案型Deliverable

- 新增Schema、Registry、Prompt、Evidence Policy和Rubric。
- 实现Direct Answer和Requested Artifact合同。
- 实现Answer Quality Validator。
- 保持Deliverable inactive。

### Phase 4：答案型执行计划

- 新增答案型ProblemGraph。
- 更新Capability Crosswalk和Planner。
- 增加research-strategy-synthesis compiled Skill。
- 生成证据收集、直接回答、策略构建和反证步骤。
- 禁止用Research Plan Skill替代最终答案。

### Phase 5：动态报告

- 完善最终ReportDocument v2动态section/block。
- 实现DynamicReportComposer。
- 实现Answer-first Web、Markdown和Zero渲染。
- 删除空章节。
- 增加分析底稿视图。

### Phase 6：集成Review与Activation

- 更新Report Review。
- 增加Direct Answer、Artifact Presence和Risk Consistency门禁。
- 将research_synthesis和research_strategy_report切换为active。
- 更新History和UI标签。

### Phase 7：一次性发布

- 全量测试和独立审查。
- 真实Gateway/Tavily任务。
- 浏览器、Markdown ZIP和Zero验收。
- 验证system capabilities版本。
- 一次性合并到main。
- 重启API/Web。
- 合并后再次运行真实任务。

## 21. 测试矩阵

| Requirement | Test |
|---|---|
| plan/answer分类 | Requirement refinement tests |
| 模糊任务强制澄清 | Control planning integration |
| Deliverable不被覆盖 | Deliverable registry tests |
| Requested artifacts结构化 | Research strategy contract tests |
| Direct Answers完整 | Answer quality tests |
| Evidence/Provisional语义 | Evidence and review tests |
| 答案型ProblemGraph | ProblemGraph tests |
| Planner不使用错误Skill | PlanCompiler integration |
| Dynamic Sections | DynamicReportComposer tests |
| 空章节删除 | Report document tests |
| Answer-first UI | Web render/runtime tests |
| History标签区分 | Current flow tests |
| ZIP包含答案和底稿 | Report bundle tests |
| Zero动态Block | Zero renderer tests |
| v1/v2兼容 | Report package tests |
| Skill Runtime无回归 | Existing full suite |
| 真实任务结果 | Gateway/Tavily/browser smoke |

## 22. 关键端到端验收

使用与最新任务相同的输入。

### 22.1 模糊模式

系统必须询问 plan/answer，不能自动进入research_plan。

### 22.2 选择Plan

- Deliverable为research_plan。
- 状态显示“研究方案已生成”。
- 输出方法、样本、排期和交付计划。

### 22.3 选择Answer

必须输出：

- 宠物食品心智核心结构的一句话答案。
- 认知、种草、搜索、购买四链路直接结论。
- 猫/狗差异。
- App、淘宝、京东、抖音场域策略。
- 至少5条Design Principles。
- 机会点P0/P1/P2。
- Evidence、置信度和待验证假设。
- 非空StrategyMap和MindModel。
- 无空章节。
- 页面默认进入直接答案。

## 23. 质量与发布命令

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm exec tsx --test \
  tests/research-strategy-contract.test.ts \
  tests/research-strategy-planning.test.ts \
  tests/dynamic-report-composer.test.ts \
  tests/report-review-service.test.ts \
  tests/requirement-refinement-service.test.ts \
  tests/plan-compiler.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/report-document.test.ts \
  tests/report-package.test.ts \
  tests/report-bundle.test.ts \
  tests/control-api-integration.test.ts
pnpm --dir apps/web build
pnpm quality
git diff --check
```

最终必须执行真实Gateway/Tavily和浏览器验收，不以fixture替代发布门禁。

## 24. 回滚

- Activation前所有新类型保持draft，无生产行为变化。
- Activation后发现问题，可将research_synthesis和research_strategy_report改回draft。
- 旧research_plan继续使用。
- Skill Runtime v2继续保留，不回滚安全修复。
- 不修改历史Artifact。
- 无数据库Migration。
- 回滚后新任务暂时只允许plan模式，答案模式返回明确不可用提示。

## 25. Premise Collapse

本方案假设系统可以基于当前公开资料给出“最佳可用答案”，并诚实标注Evidence和置信度。

如果产品边界决定“没有一手研究就绝不允许给策略答案”，则answer模式不能称为research_synthesis，而应改成“Desk Research / Hypothesis Report”，所有策略必须为provisional。该产品决策必须在Activation前确定；默认采用“允许最佳可用答案，但严格区分supported与provisional”。

## 26. 完成定义

```text
skill runtime baseline included        done
system capabilities visible            done
plan/answer mode explicit               done
research_synthesis active               done
research_strategy_report active         done
direct answer contract                  done
requested artifacts materialized        done
answer-oriented ProblemGraph             done
answer-oriented execution DAG            done
dynamic ReportDocument v2                done
answer-first Web                         done
full/analysis bundle                     done
Answer Quality Review                    done
risk consistency                         done
legacy compatibility                     done
real Gateway/Tavily acceptance           blocked: Gateway/DB credentials unavailable; standalone Tavily passed
browser and Zero acceptance              browser fixture done; real Zero unavailable
full quality gate                        done
independent review READY                 pending parent review
single final merge prepared              done
remote delivery explicitly authorized    withheld
```

## 27. 实施结果（2026-08-23）

实现分为六个独立提交：运行能力指纹、Plan/Answer意图、答案型Deliverable、答案型执行DAG、动态报告、Activation。最终生产配置激活`research_synthesis`、`research_strategy_report`与compiled `research-strategy-synthesis`，并保持历史Plan/Report读取路径不变。

关键落点：

- `GET /api/system/capabilities`从当前Schema、Deliverable Registry、Skill Registry、Knowledge Index与Tool Registry生成运行能力指纹；Web侧只读展示当前合同版本。
- Requirement规范化会识别plan/answer混合信号并生成`outcome_mode`澄清；answer选择冻结`research_synthesis`、`research_strategy_report`与结构化`requested_artifacts`。
- `research_strategy_report`使用关闭的Payload Schema与确定性Answer Quality Validator；Required Question、supported/provisional语义、Evidence、请求产物绑定、优先行动及风险披露均fail closed。
- 答案型ProblemGraph要求直接答案、证据/暂定状态、置信度、业务含义、行动，并确定性检查requested artifact覆盖；compiled Skill冻结Knowledge、Tavily、Synthesis与Reviewer阶段。
- ReportDocument v2增加受控answer block，固定将Executive Answers与Priority Actions置前；动态专题、策略对象、Evidence、局限、分析底稿与附录均从Review通过的Canonical Deliverable投影。
- Web、Markdown bundle与Zero renderer支持answer blocks；策略报告导出`direct-answers.md`与`analysis-notes.md`；历史状态区分“研究方案已生成”和“研究答案已完成”。

验证结果：

- `pnpm quality`：1630 tests，1615 pass，15 skip，0 fail。
- Web production build通过；`git diff --check`通过。
- Playwright Chromium fixture验证12个非空动态章节与14个answer blocks，默认答案页签只显示Executive Answers与Priority Actions。
- 真实Tavily检索通过并返回3条Schema合法结果。
- 当前环境缺少Gateway、数据库和运行开关配置，无法诚实完成真实Gateway全链路；真实Zero桌面端亦不可用。两项保持未验收，不视为fixture替代。
- 尚未获得push、PR、merge或deployment授权，未执行任何远端或部署操作。
