# 用研 AI 专项 · Agent Harness 与 Skill Orchestrator 底座搭建方案

## 0. 方案结论

当前项目缺的不是单个 Skill，而是一套「用研 Agent Orchestrator / 用研智能调度底座」。

文档中已经明确了四层结构：

1. Wiki 知识底座
2. Skill 能力库
3. 调度中心 / 决策树
4. 反馈机制

其中，调度中心承担“决定用哪些能力”的判断力。由于未来 Skill 和 Tool 会持续增加，调度逻辑不能写死成固定流程，而应该搭建成一套可以根据用户需求、项目上下文和当前能力注册表动态调整的编排系统。

推荐整体方向：

> 建立一个可扩展的「用研任务操作系统」：用户输入需求后，系统先结构化理解任务，再通过动态决策图选择 Skill / Tool，执行后汇总成标准报告，并把每次判断、调用、产出和反馈全部入库，反过来优化下一次调度。

---

## 1. 系统定位

这个系统应该被定义成：

> 面向用研任务的动态能力编排系统。

它的核心职责包括：

### 1.1 理解用户需求

用户可能只输入一句话，例如：

> 我要为直播场域做一次用户体验研究。

系统需要判断这是：

- 新产品研究
- 体验问题诊断
- 竞品分析
- 上线前可用性测试
- 上线后 AB 分析
- 混合型任务

### 1.2 判断任务所需能力

基于文档中的 7 个决策问题，同时判断：

1. 研究目标是否清晰
2. 用户人群是否定义清楚
3. 用什么研究方法
4. 用户体验现状是否清楚
5. 是否需要竞品参照
6. 采集与分析工具是否到位
7. 产出物是否符合标准

### 1.3 动态选择 Skill 和 Tool

未来 Skill 和 Tool 会持续增加，所以调度逻辑不能写死成 if-else。

需要让 LLM 结合以下信息动态组合：

- 用户需求
- 项目上下文
- 当前能力注册表
- 历史案例
- Skill 输入输出要求
- Tool 可用状态
- 成本和置信度

### 1.4 执行并汇总结果

每个 Skill / Tool 的输出都要结构化，最终由总结层合成为：

- 研究方案
- 研究报告
- 任务建议
- Wiki 沉淀内容
- Owner 协作建议
- 下一步行动计划

### 1.5 沉淀过程与结果

数据库不仅存最终报告，也要存：

- 为什么选择这些 Skill
- 调用了哪些 Tool
- 中间结果是什么
- 哪些内容被用户采纳
- 是否进入案例库
- 哪些 Skill 需要迭代

---

## 2. 整体系统架构

推荐系统拆成 8 层：

```text
用户入口层
  ↓
需求理解层 Task Understanding
  ↓
上下文检索层 Context Retrieval
  ↓
动态决策层 Decision Orchestrator
  ↓
能力路由层 Skill / Tool Router
  ↓
执行层 Skill / Tool Executor
  ↓
结果综合层 Result Synthesizer
  ↓
数据沉淀层 Database / Knowledge Store / Feedback
```

---

## 3. 用户入口层

用户入口可以包括：

- AgentWiki
- 内部 Web Portal
- 咚咚 Bot
- Joyspace 插件
- 设计 Wiki 页面中的 AI 输入框

入口层只做三件事：

1. 收集用户原始需求
2. 收集上下文材料
3. 返回最终结果

上下文材料可以包括：

- 项目名称
- 业务场景
- 设计稿
- 历史报告
- 竞品链接
- 用户反馈
- 业务指标
- 时间周期
- 预期产出格式

入口层不要承担复杂决策逻辑，避免多个入口之间逻辑不一致。

---

## 4. 需求理解层 Task Understanding

这一层负责把用户的一句话转成结构化任务对象。

### 4.1 示例

用户输入：

```text
我要为直播场域做一次用户体验研究
```

系统应该转成：

```json
{
  "task_type": "user_research_planning",
  "business_domain": "直播场域",
  "research_stage": "未知",
  "goal": "用户体验研究",
  "known_inputs": {
    "scenario": "直播",
    "intent": "制定用研方案"
  },
  "missing_inputs": [
    "具体业务目标",
    "目标用户人群",
    "当前是否已有设计稿或线上页面",
    "是否需要竞品参照",
    "期望产出形式"
  ],
  "urgency": "unknown",
  "confidence": 0.72
}
```

### 4.2 ResearchTask Schema

建议建立统一的 `ResearchTask` schema：

```text
ResearchTask
- task_id
- user_query
- task_type
- business_domain
- project_stage
- research_goal
- target_audience
- available_materials
- expected_output
- constraints
- missing_fields
- confidence
```

这一层的核心不是直接回答，而是形成后续决策可用的标准对象。

---

## 5. 上下文检索层 Context Retrieval

这一层负责检索三类内容。

### 5.1 知识底座

包括：

- 用研方法论
- 用户人群标签
- 正例库
- 反例库
- 反模式库
- 术语表
- 历史项目档案

作用是让新项目起步时，可以先查是否有类似项目、类似场景、类似方法。

### 5.2 Skill 注册表

系统要知道当前有哪些 Skill，以及每个 Skill 的：

- 能解决什么问题
- 需要什么输入
- 输出什么结果
- 适合什么场景
- Owner 是谁
- 成本高低
- 是否需要人工校准
- 当前是否可用

### 5.3 历史执行结果

例如过去直播、内容场、搜索、推荐、商详、客服等项目：

- 做过哪些研究
- 用了哪些方法
- 调用了哪些 Skill
- 最终产出质量如何
- 是否被业务采纳

### 5.4 推荐存储方式

建议采用：

```text
PostgreSQL：存结构化任务、Skill、Tool、项目、结果
pgvector / 向量库：存 Wiki、案例、报告、Skill 说明的语义索引
对象存储：存原始附件、报告文件、录音转写、设计稿截图
```

如果要先低成本落地，推荐：

```text
PostgreSQL + pgvector + 对象存储
```

---

## 6. 动态决策层 Decision Orchestrator

文档里的 7 个问题很好，但它现在更像“业务决策框架”。

真正落地时，建议把它改造成一个「可计算的决策图」。

推荐命名：

> Research Decision Graph / 用研决策图

原因是这 7 个问题并不是固定线性流程，而是可以同时评估、按需触发、持续扩展的判断网络。

### 6.1 7 个核心决策节点

```text
D1 研究目标是否清晰
D2 用户人群是否定义清楚
D3 研究方法是否需要推荐
D4 用户体验现状是否清楚
D5 是否需要竞品参照
D6 采集与分析工具是否到位
D7 产出物是否符合标准
```

### 6.2 每个节点的标准输出

每个决策节点都应该输出结构化判断：

```json
{
  "node": "D3_method_selection",
  "status": "need_execute",
  "reason": "用户只提出要做体验研究，尚未说明研究阶段和方法",
  "required_skills": ["method-selection"],
  "optional_skills": ["research-kickoff", "audience-tagging"],
  "required_tools": [],
  "missing_inputs": ["研究阶段", "样本规模", "时间周期"],
  "confidence": 0.81
}
```

### 6.3 决策节点状态

每个节点不要只有“是 / 否”，建议使用 5 种状态：

```text
satisfied          已满足，不需要触发能力
need_clarify       需要追问用户
need_execute       需要触发 Skill / Tool
need_human_review  需要 Owner 或专家校准
skipped            当前任务无关，跳过
```

示例：

```text
D1 研究目标是否清晰 → need_clarify
D2 用户人群是否定义清楚 → need_execute
D3 研究方法是否需要推荐 → need_execute
D4 用户体验现状是否清楚 → need_execute
D5 是否需要竞品参照 → need_execute
D6 采集与分析工具是否到位 → skipped
D7 产出物是否符合标准 → need_execute
```

这样系统就可以动态生成执行计划，而不是每次强制走完整 7 步。

---

## 7. Skill 和 Tool 的关系定义

项目中需要强制区分 Skill 和 Tool。

```text
Skill = 能力包
Tool = 可执行工具 / API / 外部系统能力
```

### 7.1 示例

```text
Skill: ui-competitive
说明：指导如何做 UI 竞品分析，包括分析维度、输出模板、判断标准、正反例。

Tool: competitor-screenshot-crawler
说明：抓取竞品页面截图。

Tool: visual-diff-analyzer
说明：对多个页面进行视觉结构分析。

Tool: report-generator
说明：将结构化分析结果转成报告。
```

也就是说：

- Skill 决定“怎么做”
- Tool 执行“具体动作”

一个 Skill 可以调用多个 Tool。  
一个 Tool 也可以被多个 Skill 复用。

### 7.2 调用关系示例

```text
digital-human-competitive Skill
  ├── 调用竞品素材检索 Tool
  ├── 调用截图分析 Tool
  ├── 调用表格生成 Tool
  └── 输出数字人竞品分析报告

voc-monitoring Skill
  ├── 调用用户之声数据查询 Tool
  ├── 调用情绪分类 Tool
  ├── 调用主题聚类 Tool
  └── 输出 VoC 分析报告
```

---

## 8. Skill 注册表设计

未来 Skill 会增加，所以不能把 Skill 写死在 Prompt 里。

每个 Skill 都需要一个 `skill.yaml` 或 `research-bundle.yaml`。

### 8.1 Skill Manifest 示例

```yaml
id: method-selection
name: 研究方法选择
version: 1.0.0
owner:
  name: 翟又仪
  team: 用研 Wiki
domain:
  - user-research
  - research-planning
intent_tags:
  - 方法选择
  - 研究设计
  - 样本设计
trigger_conditions:
  - 用户提出要做用研但没有明确方法
  - 用户需要判断访谈、焦点小组、问卷、日记研究、可用性测试的适用性
input_schema:
  required:
    - research_goal
    - business_domain
  optional:
    - target_audience
    - project_stage
    - timeline
    - sample_size
output_schema:
  type: research_method_recommendation
  fields:
    - recommended_methods
    - reason
    - sample_suggestion
    - risk
    - next_steps
dependencies:
  skills:
    - research-kickoff
    - audience-tagging
  tools: []
quality_gates:
  - 必须说明为什么选择该方法
  - 必须说明不推荐的方法及原因
  - 必须给出样本量建议
cost_level: low
execution_mode: llm_only
status: active
```

### 8.2 Skill 注册表的作用

Skill 注册表是动态调度的核心。  
LLM 每次决策时读取 Skill Registry，而不是依赖模型记忆。

它需要支持：

- Skill 发现
- Skill 匹配
- Skill 版本管理
- Skill 输入输出校验
- Skill 执行状态追踪
- Skill 质量评估
- Skill 下线 / 灰度 / 替换

---

## 9. 动态路由机制

推荐用「规则过滤 + 语义召回 + LLM 评分」三段式路由。

---

### 9.1 第一段：规则过滤

用硬规则先排除明显不相关的 Skill。

示例：

```text
如果 task_type = competitive_research
优先进入 competitive-analysis 类 Skill

如果 available_materials 包含 design_screenshot
允许触发 design-audit / eye-tracking-audit

如果 user_query 包含 用户之声 / 投诉 / 反馈 / 评论
允许触发 voc-monitoring
```

作用：

- 降低误召回
- 控制成本
- 保证高风险任务进入人工校准
- 防止不适合的 Skill 被误调用

---

### 9.2 第二段：语义召回

把用户需求、任务对象、历史案例和 Skill 描述做向量匹配。

输出 Top N 候选 Skill：

```text
research-kickoff        0.86
method-selection        0.83
audience-tagging        0.78
design-audit            0.71
ui-competitive          0.69
```

作用：

- 支持自然语言需求
- 支持新 Skill 被动态发现
- 支持非固定关键词匹配
- 支持相似历史案例召回

---

### 9.3 第三段：LLM 评分决策

让 LLM 对候选 Skill 打分，形成最终组合。

评分维度建议包括：

```text
intent_match：是否匹配用户意图
input_readiness：当前输入是否足够执行
output_value：输出对用户是否有价值
dependency_fit：是否依赖其他 Skill
cost_fit：成本是否合理
risk_level：是否需要专家校准
historical_success：历史使用效果
```

最终输出示例：

```json
{
  "selected_skills": [
    {
      "skill_id": "research-kickoff",
      "priority": 1,
      "reason": "用户目标较泛，需要先定义研究目标和问题边界"
    },
    {
      "skill_id": "audience-tagging",
      "priority": 2,
      "reason": "直播场域用户分层会影响研究方法和样本设计"
    },
    {
      "skill_id": "method-selection",
      "priority": 3,
      "reason": "需要推荐可执行的研究方法组合"
    },
    {
      "skill_id": "ui-competitive",
      "priority": 4,
      "reason": "直播体验研究通常需要参照抖音、快手、淘宝直播等竞品"
    },
    {
      "skill_id": "report-generation",
      "priority": 5,
      "reason": "需要将前序结果汇总为标准用研方案"
    }
  ],
  "need_clarification": true,
  "clarification_questions": [
    "这次研究更偏新方向探索、现有体验诊断，还是上线前验证？",
    "是否已有目标用户人群或业务指标？"
  ]
}
```

---

## 10. 执行层：采用 DAG，而不是线性流程

Skill 之间有依赖关系，但很多可以并行。  
建议每次生成一个任务 DAG。

### 10.1 DAG 示例

```text
research-kickoff
  ↓
audience-tagging ─┐
                  ├── method-selection
design-audit ─────┤
                  ├── ui-competitive
voc-monitoring ───┘
  ↓
analysis-clustering
  ↓
report-generation
  ↓
wiki-sedimentation
```

### 10.2 Skill 执行类型

系统可以把 Skill 分成三类：

```text
Planning Skill：负责定义问题、方法、方案
Data Skill：负责采集、检索、分析数据
Output Skill：负责生成报告、沉淀 Wiki、输出模板
```

推荐执行顺序：

```text
先运行 Planning Skill
再运行 Data / Analysis Skill
最后运行 Output Skill
```

---

## 11. 结果综合层 Result Synthesizer

结果综合层不要简单拼接各个 Skill 的输出。它要做四件事。

### 11.1 去重

不同 Skill 可能都提到“需要定义用户人群”，最终报告里只保留一次，并合并重复建议。

### 11.2 冲突处理

例如：

- method-selection 推荐焦点小组
- voc-monitoring 结果显示已有大量用户反馈

系统应判断是否可以减少访谈规模，或者先用 VoC 分析缩小问题范围，再补充访谈。

### 11.3 置信度标注

最终报告中需要区分：

- 哪些结论来自用户输入
- 哪些结论来自历史案例
- 哪些结论来自 Tool 结果
- 哪些结论是 LLM 推断
- 哪些结论需要专家确认

### 11.4 生成标准输出

建议最终输出包含：

```text
研究目标
目标用户
推荐研究方法
推荐 Skill / Tool
执行计划
样本建议
协作 Owner
预期产出
风险与待确认事项
沉淀路径
```

### 11.5 Result Schema

```json
{
  "final_answer": "给用户看的总结",
  "research_plan": {},
  "selected_skills": [],
  "selected_tools": [],
  "assumptions": [],
  "risks": [],
  "human_review_needed": [],
  "artifacts": [],
  "storage_refs": []
}
```

---

## 12. 数据库整体设计

项目需要三类存储：

```text
结构化数据库：PostgreSQL
语义检索库：pgvector / Milvus / Qdrant
文件存储：对象存储 / 内部文档系统
```

推荐 MVP 方案：

```text
PostgreSQL + pgvector + 对象存储
```

---

## 13. 核心数据库表设计

### 13.1 项目表 projects

```text
projects
- id
- name
- business_domain
- owner
- status
- created_at
- updated_at
```

作用：存项目维度信息。

---

### 13.2 用研任务表 research_tasks

```text
research_tasks
- id
- project_id
- user_query
- task_type
- business_domain
- project_stage
- research_goal
- target_audience
- expected_output
- constraints_json
- missing_fields_json
- status
- created_by
- created_at
```

作用：存每一次用户发起的用研任务。

---

### 13.3 决策节点表 decision_nodes

```text
decision_nodes
- id
- node_key
- node_name
- description
- default_trigger_rules_json
- related_skill_tags_json
- status
```

作用：定义系统内置的决策节点。

---

### 13.4 任务决策状态表 task_decision_states

```text
task_decision_states
- id
- task_id
- node_key
- state
- reason
- confidence
- selected_skill_ids_json
- selected_tool_ids_json
- missing_inputs_json
- evidence_refs_json
- created_at
```

作用：记录 7 个决策问题每次是如何判断的。

这张表非常重要，后续复盘时可以回答：

```text
为什么这次推荐了 UI 竞品分析？
为什么没有触发眼动 Review？
为什么需要用户之声？
为什么需要专家校准？
```

---

### 13.5 Skill 表 skills

```text
skills
- id
- skill_key
- name
- category
- description
- owner_name
- owner_team
- status
- current_version
- created_at
- updated_at
```

作用：存 Skill 主信息。

---

### 13.6 Skill 版本表 skill_versions

```text
skill_versions
- id
- skill_id
- version
- manifest_json
- input_schema_json
- output_schema_json
- trigger_conditions_json
- examples_json
- quality_gates_json
- cost_level
- execution_mode
- created_at
```

作用：让 Skill 可发现、可路由、可追踪版本。

---

### 13.7 Tool 表 tools

```text
tools
- id
- tool_key
- name
- description
- tool_type
- endpoint
- auth_type
- input_schema_json
- output_schema_json
- status
- owner
- created_at
```

作用：存可调用工具、API、外部系统能力。

---

### 13.8 Skill 与 Tool 绑定表 skill_tool_bindings

```text
skill_tool_bindings
- id
- skill_id
- tool_id
- usage_type
- required
- config_json
```

作用：记录 Skill 可以调用哪些 Tool。

---

### 13.9 执行运行表 execution_runs

```text
execution_runs
- id
- task_id
- run_type
- status
- started_at
- finished_at
- total_cost
- error_message
```

作用：记录每一次整体执行。

---

### 13.10 执行步骤表 execution_steps

```text
execution_steps
- id
- run_id
- step_order
- skill_id
- tool_id
- input_json
- output_json
- status
- confidence
- error_message
- started_at
- finished_at
```

作用：记录每个 Skill / Tool 的执行过程。

---

### 13.11 产物表 artifacts

```text
artifacts
- id
- task_id
- artifact_type
- title
- content_markdown
- content_json
- file_url
- source_refs_json
- created_by
- created_at
```

作用：存最终报告、方案、Wiki 沉淀物、结构化中间产物。

---

### 13.12 研究报告表 research_reports

```text
research_reports
- id
- task_id
- report_title
- report_schema_version
- summary
- goal
- audience
- method
- findings_json
- recommendations_json
- risks_json
- next_steps_json
- markdown_artifact_id
- status
- created_at
```

作用：存标准研究报告。

---

### 13.13 知识条目表 knowledge_items

```text
knowledge_items
- id
- source_type
- source_id
- title
- content
- category
- tags_json
- owner
- updated_at
```

作用：存 Wiki、方法论、案例、反模式、历史项目档案等知识内容。

---

### 13.14 向量索引表 knowledge_embeddings

```text
knowledge_embeddings
- id
- knowledge_item_id
- embedding
- chunk_index
- chunk_text
- metadata_json
```

作用：支持语义检索。

---

### 13.15 用户反馈表 user_feedback

```text
user_feedback
- id
- task_id
- artifact_id
- rating
- feedback_text
- accepted
- created_at
```

作用：记录用户是否采纳，以及对结果质量的反馈。

---

### 13.16 Skill 评估表 skill_evaluations

```text
skill_evaluations
- id
- skill_id
- task_id
- usefulness_score
- accuracy_score
- output_quality_score
- issue_text
- suggested_update
- created_at
```

作用：持续优化 Skill 路由和输出质量。

---

## 14. 数据库必须存的结果内容

至少要存 6 类结果：

```text
1. 用户原始需求
2. 结构化任务理解结果
3. 7 个决策节点的判断结果
4. Skill / Tool 调用过程与输出
5. 最终总结报告
6. 用户反馈与后续沉淀记录
```

不要只存最终报告。

如果只存最终报告，系统无法复盘“为什么这么判断”，后续也很难优化动态调度。

---

## 15. 项目文件结构建议

可以在现有 Wiki 目录基础上，增加一层工程目录。

```text
user-research-agent/
│
├── apps/
│   ├── web-portal/
│   └── agent-api/
│
├── packages/
│   ├── task-understanding/
│   ├── decision-orchestrator/
│   ├── skill-router/
│   ├── tool-gateway/
│   ├── result-synthesizer/
│   └── evaluators/
│
├── schemas/
│   ├── research-task.schema.json
│   ├── decision-state.schema.json
│   ├── skill-manifest.schema.json
│   ├── tool-manifest.schema.json
│   └── research-report.schema.json
│
├── orchestrator/
│   ├── decision-graph.yaml
│   ├── router-policy.md
│   ├── planner-prompt.md
│   ├── executor-prompt.md
│   └── synthesis-prompt.md
│
├── skills/
│   ├── research-flow/
│   ├── competitive-analysis/
│   ├── user-voice/
│   ├── design-audit/
│   └── design-analytics/
│
├── database/
│   ├── migrations/
│   └── seed/
│
└── docs/
    ├── architecture.md
    ├── api.md
    ├── skill-onboarding.md
    └── evaluation.md
```

---

## 16. 一次完整运行流程

```text
Step 1 用户输入需求
「我要为直播场域做一次用户体验研究」

Step 2 需求理解层生成 ResearchTask

Step 3 检索相关知识
查直播相关历史案例、用研方法、反模式、人群标签、已有 Skill

Step 4 决策图评估 7 个节点
判断哪些已满足，哪些需要追问，哪些需要触发 Skill

Step 5 路由器选择 Skill / Tool
生成 selected_skills + selected_tools

Step 6 生成执行 DAG
明确哪些 Skill 先执行，哪些并行执行，哪些后置汇总

Step 7 执行 Skill / Tool
每一步结果写入 execution_steps

Step 8 结果综合
把多个 Skill 输出合并成统一研究方案

Step 9 质量校验
检查是否符合 research-report schema

Step 10 入库沉淀
保存任务、决策、执行结果、报告、反馈入口

Step 11 返回用户
输出方案 + 推荐 Owner + 下一步动作 + 可沉淀路径
```

---

## 17. MVP 落地方式

第一阶段不要追求全自动。  
建议先做「半自动动态调度」。

### 17.1 MVP 目标

用户输入一句话后，系统可以输出：

```text
1. 任务理解
2. 7 个决策节点判断
3. 推荐 Skill 组合
4. 需要调用的 Tool
5. 是否需要追问
6. 研究方案初稿
7. 入库记录
```

### 17.2 MVP 必做模块

```text
1. ResearchTask schema
2. Skill manifest schema
3. DecisionGraph v1
4. Skill Registry
5. Router Prompt
6. Result Synthesizer Prompt
7. PostgreSQL 基础表
8. research-report schema 校验
```

### 17.3 MVP 可以暂缓

```text
1. 全自动 Tool 调用
2. 复杂权限系统
3. 多 Agent 协同
4. 自动更新 Skill
5. 完整可视化工作流编辑器
```

第一阶段的重点是：

> 先让系统能判断正确、推荐正确、沉淀正确，再做自动执行。

---

## 18. 关键工程原则

### 18.1 所有 Skill 都注册化

新增 Skill 时，只需要新增 Skill 文件夹和 manifest，路由器自动读取，不改主流程代码。

### 18.2 决策图数据化

7 个问题写成 YAML / JSON 配置。

未来新增节点时，例如：

- 是否需要生理心理指标
- 是否需要问卷统计显著性
- 是否需要多端体验对比
- 是否需要无障碍体验检查

只加节点，不改核心调度逻辑。

### 18.3 执行过程可追溯

每次回答都要能回看：

- 用户问了什么
- 系统怎么理解
- 为什么选这些 Skill
- 每个 Skill 输出了什么
- 哪些结论来自 Tool
- 哪些结论来自 LLM
- 哪些结论需要人工确认

### 18.4 结果标准化

所有最终产出必须符合 `research-report.schema.json` 或其他 artifact schema。

### 18.5 LLM 负责判断，规则负责约束

LLM 适合负责：

- 需求理解
- 动态规划
- Skill 组合
- 冲突合并
- 总结表达

规则适合负责：

- 权限
- 必填字段
- 输出格式
- 质量门禁
- 成本边界
- 高风险任务拦截

---

## 19. 推荐交付物拆解

建议后续真正推进时，先交付 6 个核心内容。

### 19.1 用研任务 schema

定义用户需求如何结构化。

### 19.2 Skill manifest schema

定义每个 Skill 如何被系统发现、选择、调用、评估。

### 19.3 Decision Graph v1

把文档里的 7 个问题转成可计算节点。

### 19.4 Skill Router

根据用户任务、上下文、能力注册表动态选择 Skill / Tool。

### 19.5 Result Synthesizer

把多个 Skill / Tool 结果合成为统一报告。

### 19.6 Research Memory DB

存任务、决策、执行、报告、反馈、案例沉淀。

---

## 20. 推荐系统命名

可以考虑以下命名：

```text
Research Orchestrator
用研能力调度中心
用研 Agent Harness
Research Skill Hub
用研智能编排底座
```

从当前文档语境看，最贴切的是：

> 用研 Agent Harness + Skill Orchestrator

其中：

```text
Agent Harness：定义任务理解、决策、执行、校验、沉淀的整体流程约束
Skill Orchestrator：负责动态选择和组合 Skill / Tool
Research Memory DB：负责沉淀任务、过程、结果和反馈
```

---

## 21. 一句话总结

这套体系的底座不是再建一批 Skill，而是建立一个可扩展的「用研任务操作系统」。

用户输入需求后，系统先结构化理解任务，再通过动态决策图选择 Skill / Tool，执行后汇总成标准报告，并把每次判断、调用、产出和反馈全部入库，反过来优化下一次调度。
