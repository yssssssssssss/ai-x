# 用研 AI 专项 · 完整开发方案

## 一、项目目标

建设一套「用研 Agent Harness + Skill Orchestrator」。

它的完整职责是：

```text
用户输入一句用研需求
  -> 系统理解任务
  -> 检索知识库 / 历史案例 / Skill 能力
  -> 动态判断该走哪些决策节点
  -> 选择并组合 Skill / Tool
  -> 执行或生成半自动执行计划
  -> 汇总结果为研究方案 / 报告 / Wiki 沉淀
  -> 全链路入库，支持复盘和持续优化
```

它不是单个聊天机器人，也不是简单 prompt，而是一套可扩展的用研任务编排底座。

## 二、系统边界

### 2.1 要做什么

```text
1. 用户需求结构化
2. 用研 7 问决策图
3. Skill / Tool 注册表
4. 动态路由与能力组合
5. Skill 执行与 Tool 调用适配
6. 结果综合与报告生成
7. 数据库沉淀
8. 反馈与 Skill 迭代机制
9. 后续入口接入能力
```

### 2.2 第一版不做，但架构预留

```text
1. 完整自动化 Tool 调用
2. 多 Agent 自主协作
3. 可视化工作流编辑器
4. 复杂权限平台
5. 全量 Web Portal
```

这些不是不要，而是不能第一天就做。否则复杂度会失控。

## 三、总体架构

```text
入口层 Entry Layer
- AgentWiki
- Web API
- 咚咚 Bot
- Joyspace 插件
- 设计 Wiki 输入框

编排核心 Research Core
- Task Understanding
- Context Retrieval
- Decision Graph Evaluator
- Skill / Tool Router
- Execution Planner

能力运行层 Capability Runtime
- Skill Loader
- Tool Adapter
- Input / Output Validator
- Execution Step Runner
- Human Review Gate

结果综合层 Result Synthesizer
- 去重
- 冲突处理
- 置信度标注
- 来源标注
- 报告生成
- Wiki 沉淀生成

记忆层 Research Memory
- PostgreSQL
- pgvector
- 对象存储 / 内部文档系统
```

核心原则：入口可以多个，但决策逻辑只能有一个。否则不同入口会给出不同答案，后续维护成本会失控。

## 四、完整运行流程

```text
1. 用户提交需求
   例：我要为直播场域做一次用户体验研究

2. 生成 ResearchTask
   识别任务类型、业务场景、研究目标、用户人群、已有材料、缺失字段

3. 检索上下文
   查 Wiki 方法论、历史案例、反模式、人群标签、已有 Skill、可用 Tool

4. 评估决策图
   D1 研究目标是否清晰
   D2 用户人群是否定义清楚
   D3 研究方法是否需要推荐
   D4 用户体验现状是否清楚
   D5 是否需要竞品参照
   D6 采集分析工具是否到位
   D7 产出物是否符合标准

5. 路由能力
   规则过滤 -> 语义召回 -> LLM 评分 -> 输出推荐 Skill / Tool

6. 生成执行计划
   不是线性流程，而是 DAG

7. 执行 Skill / Tool
   llm_only 直接执行
   tool_required 调用 Tool 或生成调用建议
   human_review 进入人工确认

8. 结果综合
   合并多个 Skill 结果，处理重复和冲突

9. 生成产物
   研究方案、研究报告、Owner 建议、风险清单、Wiki 沉淀内容

10. 入库
    保存任务、决策、执行步骤、产物、反馈

11. 返回用户
    给出可执行研究方案和下一步动作
```

## 五、决策图设计

7 个问题不要写死在代码里，要配置化：

```yaml
nodes:
  - key: D1_research_goal
    question: 研究目标是否清晰
    related_tags: [research-kickoff, goal-definition]
    required_fields: [research_goal, business_domain]
    risk_level: medium

  - key: D2_audience
    question: 用户人群是否定义清楚
    related_tags: [audience-tagging, user-segmentation]

  - key: D3_method
    question: 研究方法是否需要推荐
    related_tags: [method-selection, sample-design]

  - key: D4_experience_status
    question: 用户体验现状是否清楚
    related_tags: [design-audit, voc-monitoring, eye-tracking-audit]

  - key: D5_competitive
    question: 是否需要竞品参照
    related_tags: [ui-competitive, business-competitive, digital-human-competitive]

  - key: D6_data_analysis
    question: 采集与分析工具是否到位
    related_tags: [data-collection, analysis-clustering]

  - key: D7_output_standard
    question: 产出物是否符合标准
    related_tags: [report-generation, wiki-sedimentation]
```

每个节点只允许输出 5 种状态：

```text
satisfied
need_clarify
need_execute
need_human_review
skipped
```

状态必须收敛。状态不收敛，后续就无法稳定执行、记录和复盘。

## 六、Skill / Tool 体系

定义必须清楚：

```text
Skill = 能力包，负责方法、判断标准、流程和输出要求
Tool = 可执行工具，负责查询、抓取、分析、生成等动作
```

### 6.1 Skill Manifest

每个 Skill 必须有 manifest：

```yaml
id: method-selection
type: skill
name: 研究方法选择
version: 1.0.0
owner:
  name: 翟又仪
  team: 用研 Wiki
intent_tags:
  - 方法选择
  - 研究设计
  - 样本设计
input_schema:
  required: [research_goal, business_domain]
  optional: [target_audience, project_stage, timeline, sample_size]
output_schema:
  type: research_method_recommendation
dependencies:
  skills: [research-kickoff, audience-tagging]
  tools: []
quality_gates:
  - 必须说明推荐方法
  - 必须说明不推荐方法及原因
  - 必须给出样本建议
execution_mode: llm_only
risk_level: low
status: active
```

### 6.2 Tool Manifest

Tool 也要 manifest：

```yaml
id: voc-query
type: tool
name: 用户之声查询
adapter: o2
input_schema:
  required: [business_domain, time_range]
output_schema:
  type: voc_dataset
auth_required: true
risk_level: medium
status: active
```

内部工具调用优先级：

```text
1. o2
2. 已有 MCP / 内部 API
3. 脚本适配器
4. 人工操作链接
```

## 七、动态路由机制

路由不能靠 if-else，也不能完全交给 LLM。采用三段式：

```text
第一段：规则过滤
- 排除状态 inactive 的能力
- 排除输入明显不足的 Tool
- 高风险能力要求 human_review
- 根据 task_type / material_type / business_domain 初筛

第二段：语义召回
- 用户需求 embedding
- Skill manifest embedding
- 历史案例 embedding
- Wiki 内容 embedding

第三段：LLM 评分
- intent_match
- input_readiness
- output_value
- dependency_fit
- cost_fit
- risk_level
- historical_success
```

最终输出：

```json
{
  "selected_capabilities": [
    {
      "id": "research-kickoff",
      "priority": 1,
      "reason": "用户目标较泛，需要先收敛研究目标"
    }
  ],
  "need_clarification": true,
  "clarification_questions": [
    "这次研究更偏新方向探索、现有体验诊断，还是上线前验证？"
  ]
}
```

## 八、数据库设计

采用 PostgreSQL + pgvector + 对象存储。

MVP 到终态都能承载的表：

```text
projects
- id, name, business_domain, owner, status, created_at, updated_at

research_tasks
- id, project_id, user_query, task_type, business_domain
- project_stage, research_goal, target_audience
- available_materials_json, expected_output
- constraints_json, missing_fields_json, confidence
- status, created_by, created_at, updated_at

capabilities
- id, capability_key, type, name, category
- description, owner_name, owner_team
- status, current_version, created_at, updated_at

capability_versions
- id, capability_id, version
- manifest_json, input_schema_json, output_schema_json
- trigger_conditions_json, quality_gates_json
- execution_mode, risk_level, created_at

decision_states
- id, task_id, node_key, state
- reason, confidence
- selected_capability_ids_json
- missing_inputs_json, evidence_refs_json
- created_at

execution_runs
- id, task_id, status, mode
- started_at, finished_at, total_cost
- error_message

execution_steps
- id, run_id, step_order
- capability_id, input_json, output_json
- status, confidence, error_message
- started_at, finished_at

artifacts
- id, task_id, run_id
- artifact_type, title
- content_markdown, content_json
- file_url, source_refs_json
- schema_version, created_by, created_at

knowledge_items
- id, source_type, source_id
- title, content, category, tags_json
- owner, updated_at

knowledge_embeddings
- id, knowledge_item_id
- embedding, chunk_index, chunk_text, metadata_json

user_feedback
- id, task_id, artifact_id
- rating, feedback_text, accepted
- created_at
```

暂时不要拆 `research_reports`。报告就是 artifact。以后报表查询复杂了再拆，不提前制造表结构负担。

## 九、API 设计

```text
POST /research/tasks
创建用研任务

GET /research/tasks/:id
查看任务结构化结果和状态

POST /research/tasks/:id/plan
生成决策状态、推荐能力和执行计划

POST /research/tasks/:id/run
执行可自动执行的 Skill / Tool

GET /research/tasks/:id/runs/:runId
查看执行过程

GET /research/tasks/:id/artifacts
查看研究方案、报告、Wiki 沉淀内容

POST /research/tasks/:id/feedback
提交采纳、评分和反馈

GET /capabilities
查看 Skill / Tool 注册表

POST /capabilities/sync
从本地 Skill 文件夹同步 manifest
```

## 十、工程结构

```text
apps/
  agent-api/
    src/
      routes/
      services/
      workers/

packages/
  schemas/
  research-core/
  capability-runtime/
  result-synthesizer/
  memory-store/
  tool-adapters/

orchestrator/
  decision-graph.yaml
  router-policy.yaml
  prompts/
    task-understanding.md
    decision-evaluator.md
    skill-router.md
    execution-planner.md
    result-synthesizer.md

skills/
  research-flow/
  competitive-analysis/
  user-voice/
  design-audit/
  design-analytics/

database/
  migrations/
  seed/

docs/
  architecture.md
  skill-onboarding.md
  tool-adapter.md
  evaluation.md
```

技术栈建议按现有团队熟悉度选。没有现成项目约束时，建议：

```text
Backend: Node.js / TypeScript
DB: PostgreSQL + pgvector
Schema: JSON Schema / Zod
Queue: 先不用，后续接 BullMQ 或内部任务系统
Storage: 内部对象存储 / Joyspace 附件 / 文件系统适配
LLM: 通过统一 llm-client 封装
Tool: o2 adapter 优先
```

## 十一、分阶段交付

完整方案分 6 个阶段，每阶段都能独立验收。

### Phase 1：基础协议与注册表

```text
交付：
- ResearchTask schema
- DecisionState schema
- CapabilityManifest schema
- Artifact schema
- decision-graph.yaml
- capability sync 脚本
- 初始 capabilities 表

验收：
- 现有 Skill 能被扫描入库
- 新增 Skill 只加 manifest，不改核心代码
```

### Phase 2：Research Core

```text
交付：
- task-understanding
- context retrieval
- decision evaluator
- skill router
- execution planner

验收：
- 输入一句话能输出 ResearchTask
- D1-D7 节点状态稳定
- 能推荐 Skill / Tool / 追问项
```

### Phase 3：Capability Runtime

```text
交付：
- Skill loader
- Tool adapter interface
- o2 adapter
- execution step runner
- human review gate

验收：
- llm_only Skill 可自动执行
- tool_required Skill 可生成 Tool 调用计划
- human_review 节点不会被误自动执行
```

### Phase 4：Result Synthesizer

```text
交付：
- 多 Skill 输出合并
- 冲突处理
- 来源标注
- 置信度标注
- research-plan artifact
- research-report artifact

验收：
- 输出完整研究方案
- 说明每个结论来自哪里
- 明确待确认项和风险
```

### Phase 5：Research Memory

```text
交付：
- PostgreSQL migrations
- pgvector 知识检索
- execution history
- artifact storage
- feedback storage

验收：
- 能复盘为什么选某个 Skill
- 能查询历史相似项目
- 用户反馈能回流到能力评估
```

### Phase 6：入口与试点

```text
交付：
- 一个正式入口
- 两个端到端标杆案例
- 使用手册
- Skill onboarding 手册
- 质量评估集

验收：
- 直播场域用研跑通
- 另一个真实业务场景跑通
- 业务方可独立发起任务
```

## 十二、质量与测试

必须有 4 类测试。否则这个系统会“看起来聪明，实际不可控”。

```text
1. Schema 测试
- manifest 是否合法
- task 是否合法
- decision output 是否合法
- artifact 是否合法

2. 路由评测
- 准备 10-20 个典型用研需求
- 检查推荐 Skill 是否合理
- 检查不相关 Skill 是否被排除

3. 端到端测试
- 直播场域用户体验研究
- 竞品分析任务
- 用户之声分析任务
- 设计走查任务

4. 回归测试
- 新增 Skill 后，旧任务推荐结果不能大幅漂移
```

质量门禁：

```text
- 所有 LLM 输出必须过 schema validation
- 高风险 Tool 必须 human_review
- 没有 evidence_refs 的关键结论要标记为 inference
- 缺少必要输入时，不得假装已完成
- 报告必须包含风险、假设、下一步
```

## 十三、权限与安全

第一版不做复杂权限系统，但底线要有：

```text
- Tool manifest 声明 auth_required
- 高风险 Tool 不自动执行
- execution_steps 不存敏感明文 token
- artifact 标记 source_refs
- 用户反馈和历史案例可追溯创建人
```

后续扩展：

```text
- team-level capability visibility
- tool-level permission
- artifact access control
- audit log
```

## 十四、运维与观测

至少记录：

```text
- task 创建数量
- plan 成功率
- run 成功率
- 每个 Skill 调用次数
- 每个 Skill 平均评分
- schema validation 失败次数
- human_review 挂起数量
- 用户采纳率
```

这些指标直接决定后续优化方向。不要只看模型回答好不好，要看业务是否采纳。

## 十五、典型端到端样例

输入：

```text
我要为直播场域做一次用户体验研究
```

系统输出：

```text
任务理解：
- task_type: user_research_planning
- business_domain: 直播场域
- missing_fields: 研究阶段、目标用户、已有材料、期望产出

决策节点：
- D1 need_clarify
- D2 need_execute
- D3 need_execute
- D4 need_execute
- D5 need_execute
- D6 skipped / need_execute
- D7 need_execute

推荐能力：
- research-kickoff
- audience-tagging
- method-selection
- design-audit
- ui-competitive
- report-generation

追问：
- 这次研究更偏新方向探索、现有体验诊断，还是上线前验证？
- 是否已有设计稿、线上页面或用户反馈？

产物：
- 研究方案初稿
- Owner 协作建议
- 执行计划
- 风险与待确认项
```

## 十六、主要风险与处理

```text
风险 1：Skill 质量不稳定
处理：所有 Skill 必须 manifest 化、schema 化、带正反例和 quality_gates

风险 2：LLM 决策不可复盘
处理：decision_states 必须保存 reason、confidence、evidence_refs

风险 3：系统过度自动化
处理：第一版采用半自动，Tool 调用不成熟时只生成调用计划

风险 4：能力越来越多后路由混乱
处理：规则过滤 + 语义召回 + LLM 评分，不能只靠 prompt

风险 5：知识库污染
处理：knowledge_items 标记 source、owner、updated_at，低质量内容不能直接进高置信结论
```

## 十七、最终交付物

完整项目最终应交付：

```text
1. 用研 Agent API
2. ResearchTask / DecisionState / CapabilityManifest / Artifact schema
3. Decision Graph v1
4. Skill / Tool Registry
5. Capability Runtime
6. o2 Tool Adapter
7. Result Synthesizer
8. Research Memory DB
9. pgvector 知识检索
10. 标准研究方案模板
11. 标准研究报告模板
12. Skill 接入手册
13. Tool 接入手册
14. 质量评估集
15. 两个端到端标杆案例
16. 使用说明文档
```

## 十八、一句话定案

完整方案不是“先做 MVP 就结束”，而是：终态上建设一个可扩展的用研任务编排系统；落地上先用 6 个阶段把核心闭环跑通，再逐步增强 Tool 自动化、多入口、多 Agent 和可视化能力。

核心必须保持简单：配置驱动、schema 约束、全链路可追溯，别让平台复杂度压过用研价值。
