# 分离研究规划与直接研究回答，并采用答案优先的动态报告

## 背景

Current 工作流目前将 `user_research_planning` 唯一映射为 `research_plan`。当用户同时表达“创建调研任务”和“输出研究报告、策略地图、心智模型、设计原则、机会点”时，Requirement 会把需求规范化为研究规划，ProblemGraph 询问“如何研究”，Skill 生成研究方案、旅程模板和访谈提纲，最终 Review 只检查研究问题覆盖和方法完整性。

最新任务验证了这一缺陷：中间整合步骤已经生成具体策略地图、心智模型、设计原则和机会点，但 `research_plan` Payload 没有对应字段，内容被压缩为少量结论和建议；旧 ReportDocument 固定章节又进一步压缩并生成空章节。技术流程完成，却没有交付用户理解的“直接答案”。

同时，已完成的 Skill Runtime 与报告保真改造尚未合入 `main`。如果只先合并该分支，执行与展示会更真实，但仍可能用完整而可信的方式回答错误任务类型。

## 决策

### 1. 研究规划与研究回答是两个不同任务

定义：

```text
user_research_planning → research_plan
research_synthesis     → research_strategy_report
```

研究规划回答“如何研究”；研究回答基于当前可用Evidence回答“当前结论是什么、业务应该怎么做”。

### 2. 模糊请求必须显式选择Outcome Mode

Requirement 增加：

```text
outcome_mode: plan | answer
```

同时包含规划和答案信号时，任务停在澄清阶段，让用户选择研究方案或直接策略答案。未选择前不生成ProblemGraph、候选计划或真实Tool调用。

### 3. 用户请求产物必须实体化

Requirement 增加 `requested_artifacts`。策略地图、心智模型、设计原则、机会点和优先行动必须作为Canonical Deliverable中的结构化对象存在，仅在交付清单中出现名称不算完成。

### 4. 新增答案型Canonical Deliverable

新增 `research_strategy_report`，至少包含：

- Direct Answers；
- Evidence-backed Findings；
- Strategy Map；
- Mind Model；
- Design Principles；
- Opportunities；
- Prioritized Actions；
- Channel Strategies；
- Limitations与Open Questions；
- Requested Artifact Bindings。

每个Required Question必须有直接答案、Evidence或provisional状态、置信度、业务含义、建议行动和待验证内容。

### 5. 答案型ProblemGraph必须以答案为目标

答案型问题使用“是什么、为什么、怎么做、优先级是什么”，不以“如何构建研究框架”为主要问题。Acceptance要求Direct Answer、Evidence、业务含义和行动，禁止只返回“建议进一步研究”。

### 6. 报告采用固定最小骨架加动态专题章节

固定最小骨架：

1. Executive Answers；
2. Priority Actions；
3. Evidence and Confidence；
4. Limitations and Open Questions；
5. Evidence Appendix。

动态章节由真实答案、请求产物和领域主题决定。章节可动态，但Block必须使用受控类型，并携带Question、Finding、Evidence、Source Pointer和Confidence。

### 7. 报告必须答案优先

顺序固定为：

```text
直接回答 → 证据 → 分析 → 行动 → 局限
```

ProblemGraph、方法说明、访谈提纲和中间推理进入分析底稿，不占据报告首屏。

### 8. Canonical Deliverable仍是真相源

Dynamic Report Composer只能对Review通过的Deliverable做无损结构转换，不能直接读取并拼接未经Review的Step Artifact文本。

### 9. 一次性集成发布

以 `feat/skill-runtime-report-fidelity@b1e5c7a` 为基线，在 `feat/research-answer-dynamic-reports` 完成全部改造。Skill Runtime分支不单独合并；任务语义、Deliverable、执行DAG、动态报告和Review全部通过后，一次性合并到main并重启服务。

## 权衡

### 收益

- 用户可以明确选择研究方案或直接答案。
- 系统不再用研究问题分析替代业务答案。
- 请求的策略产物成为可验证的真实交付。
- 报告结构适配实际内容，不再强制空章节。
- 保持Evidence、Review、打印、Markdown和Zero发布能力。
- 避免先上线半套语义导致再次返工。

### 成本

- 新增Task Type、Deliverable Schema、ProblemGraph、执行编排和Review维度。
- ReportDocument v2在首次发布前需要扩展为动态Block合同。
- 前端需要区分规划型和答案型信息架构。
- 首个真实答案型任务需要消耗Gateway和Tavily配额做发布验收。
- 集成分支范围较大，必须分Phase提交和独立审查。

## 被拒绝的方案

### 只合并Skill Runtime分支

会修复执行真实性和显示保真，但任务仍可能被规范为research_plan，不能解决“需要答案却生成方案”。

### 只修改ReportDocument模板

报告模板无法恢复Canonical Deliverable中不存在的策略地图、心智模型和机会点；会把未经合同和Review的中间文本直接暴露给用户。

### 完全自由生成Markdown

会失去Schema、Evidence绑定、自动Review、前端稳定渲染、打印和Zero发布能力。

### 一个Task Type支持模糊的多种交付语义

会继续让Planner、Skill和Review依赖隐式Prompt判断，无法建立稳定验收边界。

### 分阶段分别合入main

会在main上形成“新Runtime+旧任务语义”或“新Deliverable+旧报告”的中间状态，重复当前问题，不予采用。

## 兼容与回滚

- Historical `user_research_planning/research_plan`保持不变。
- Plan v1、Current Plan v2、ReportDocument v1/v2继续读取。
- `research_synthesis`和`research_strategy_report`在最终Activation前保持draft。
- Activation后可通过改回draft关闭答案模式，不回滚Skill Runtime安全修复。
- 不修改历史SEALED Artifact。
- 不需要数据库Migration。
- 回滚后新任务暂时只允许plan模式，并返回明确提示。

## Premise Collapse

本决策假设产品允许在只有公开资料、Knowledge和有限用户材料时给出“最佳可用答案”，并通过supported/provisional/unanswered区分确定性。

如果产品要求“没有一手用户研究绝不提供策略结论”，则 `research_synthesis` 必须改名为 Desk Research / Hypothesis Report，所有非事实策略只能为provisional，页面和历史状态不得使用“研究答案已完成”。Activation前默认采用“允许最佳可用答案，但严格标注Evidence与置信度”。

## 实施状态（2026-08-23）

本决策已在`feat/research-answer-dynamic-reports`实现并完成Activation：

- `research_synthesis`、`research_strategy_report`与`research-strategy-synthesis`已进入active Registry。
- Requirement持久化`outcome_mode`与`requested_artifacts`；混合意图在ProblemGraph和Tool调用前进入显式澄清。
- 答案型ProblemGraph、compiled Skill合同、Answer Quality Validator与ReportDocument v2 answer blocks均已落地。
- Dynamic Report只投影Review通过的Canonical Deliverable；Web、Markdown bundle与Zero renderer共享同一ReportDocument。
- Plan v1、Current Plan v2、ReportDocument v1/v2及历史`research_plan`读取回归通过。
- 自动化全量质量门禁和Playwright浏览器fixture已通过；真实Tavily单独调用通过。
- 真实Gateway全链路和真实Zero发布因当前环境缺少Gateway/数据库配置及Zero桌面端而未执行；独立审查仍由父级review gate完成。
- 未push、未创建PR、未合并、未部署。

## 关联文档

- 开发方案：`docs/plans/2026-08-23-answer-oriented-research-dynamic-report-development.md`
- TodoList：`docs/plans/2026-08-23-answer-oriented-research-dynamic-report-todolist.md`
- 上游ADR：`docs/adr/0003-compile-skills-into-frozen-execution-dag.md`
