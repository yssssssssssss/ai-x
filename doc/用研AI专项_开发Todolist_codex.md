# 用研 AI 专项 · 开发 TODO List(Codex)

本文档从《用研AI专项_底座搭建方案_优化版_codex.md》拆解而来,目标是把方案转成可进入开发排期的工程任务。拆分原则:每个任务尽量是一个可独立验收的纵向切片,完成后能演示一条具体能力,而不是只交付一层孤立基础设施。

## 0. 开发入口判断

**结论:** 可以进入 Phase 1 骨架开发,但不能直接全量开发所有用研能力。

本 TODO 的定位要说清楚:它不是整个项目的全部任务,而是**完整路线图下的 MVP 详细任务清单**。完整项目分为 5 个版本阶段推进,MVP 只是第一条可验证主链路。

```text
V0 技术验证版
  → 验证 runtime / DB / schema / registry / seed skill 是否成立

V1 MVP 试点版
  → 单入口 Web 会话 + 1 个 task_type + 1 个 skill + 1 个 tool + 最小知识库 + 可复盘

V1.5 多能力试点版
  → 接入 3-5 个高频 skill/tool,跑 2-3 类 task_type,形成 skill 迁移模板

V2 生产推广版
  → 门户 + 咚咚 Bot + 飞书看板 + 审批流增强 + 多团队能力接入 + 监控告警

V3 规模化运营版
  → pgvector 语义检索 + skill 质量评估 + 成本看板 + 文档园丁/规则园丁 + 可控多 Agent
```

**防止 MVP 和后续版本对不上的原则:**

- 数据模型按终态主干设计:MVP 就使用 `users / conversations / messages / research_tasks / task_decision_states / execution_log / artifacts / user_feedback`,后续只加表,不推翻主表。
- Runtime 按可替换设计:MVP 可以先用 OpenAI Agents SDK,但业务代码只能依赖 `agent-runtime / llm-client / tool-adapter`。
- Skill/Tool 按正式协议接入:MVP 只接 1 个 skill/tool,但必须使用 manifest + schema + examples + evals,不能写死在代码里。
- 知识库按可迁移设计:MVP 用 `knowledge-index.json` + BM25/关键词召回,后续 pgvector 读取同一套 metadata 和 source hash。
- 审批按扩展点设计:MVP 用 `approval_state + execution_log`,后续高频后再拆 `approval_requests`,不改变执行状态模型。
- 前台按四段流设计:MVP 就保留"任务理解 → 计划确认 → 执行 → 交付",后续只是扩展能力卡片和审批卡片。

Phase 1 的目标不是"完整上线",而是验证这套底座能不能稳定跑通:

```text
用户注册/登录
  → 新建会话
  → 输入一句用研需求
  → 结构化 ResearchTask
  → 激活决策节点子集
  → 生成待确认计划
  → 用户确认
  → 调用 1 个 skill + 1 个 tool
  → 生成报告
  → 写入 DB / artifact / execution_log
  → 可从历史任务回看与复盘
```

**MVP 开发前硬门槛:**

- P0-01 技术底座 spike 通过。
- P0-02 数据库 schema 能建表并跑通最小读写。
- P0-03 schema / manifest / registry 的文件协议确定。
- P0-04 确定首个端到端 task_type 与种子 skill/tool。

如果这 4 项没有过,继续做完整前台或大规模迁移 skill 都是在堆风险。

---

## 1. 任务优先级说明

| 优先级 | 含义 | 是否阻塞后续 |
|---|---|---|
| P0 | 架构成立所必需,不完成不能进入主开发 | 是 |
| P1 | MVP 必须交付,完成后能端到端演示 | 是 |
| P2 | MVP 后增强,可延期 | 否 |

| 类型 | 含义 |
|---|---|
| HITL | 需要产品/技术负责人确认,或需要人工验收 |
| AFK | 工程团队可按文档直接实现 |

---

## 2. Phase 1: 技术底座与最小闭环

### P0-01 技术底座 Spike:验证 OpenAI Agents SDK 是否适合作为主 runtime

**类型:** HITL  
**依赖:** 无  
**目标:** 用 3-5 天验证 OpenAI Agents SDK 是否能支撑本项目的 skill 加载、结构化输出、tool 调用、会话持久化、审批和追踪。

**任务:**

- [ ] 建一个最小 `apps/orchestrator-runtime` spike 工程。
- [ ] 封装 `agent-runtime / llm-client / tool-adapter` 三个接口,业务代码不直接调用 SDK。
- [ ] 加载一个本地 `SKILL.md`,读取 frontmatter 与正文。
- [ ] 让 LLM 输出 `ResearchTask / Plan / DecisionState / Report` 四类 JSON,并过 schema 校验。
- [ ] 接一个 fake tool adapter,模拟 o2 tool 的输入、输出、失败。
- [ ] 把一次运行的 messages、task、execution_log、artifact 写入临时 DB 或本地 JSON。
- [ ] 验证 human-in-the-loop:tool 调用前能暂停等待确认。
- [ ] 验证 tracing:记录 trace_id、model、prompt hash、manifest hash。
- [ ] 写 spike 结论:继续 OpenAI / 切 Claude / 评估 Pi。

**验收标准:**

- [ ] 能用一条固定输入生成结构化计划。
- [ ] 确认前不会执行 tool。
- [ ] 确认后能调用 fake tool 并写执行日志。
- [ ] schema 不合规时能失败并给出错误。
- [ ] 输出一页 spike 结论,说明是否采用 OpenAI Agents SDK。

---

### P0-02 建立数据库 migration 与最小数据访问层

**类型:** AFK  
**依赖:** 无  
**目标:** 建好 8 张核心表,让用户、会话、消息、任务、执行日志、产物和反馈有稳定存储。

**任务:**

- [ ] 创建 `database/migrations/001_init_core_tables.sql`。
- [ ] 建表: `users / conversations / messages / research_tasks / task_decision_states / execution_log / artifacts / user_feedback`。
- [ ] 建索引: owner 最近会话、会话消息时间、owner 最近任务、task 状态、execution status、artifact type。
- [ ] 写 seed:1 个测试用户、1 个会话、1 个 task、1 条 execution_log、1 个 artifact。
- [ ] 建最小 DAO/repository,覆盖创建用户、创建会话、写消息、建任务、写执行日志、查历史任务。
- [ ] 明确大对象只存 `storage_uri`,不进 PG。

**验收标准:**

- [ ] 本地能一键建库。
- [ ] seed 后能查到用户、会话、任务和 artifact。
- [ ] 能按 `owner_user_id` 查最近任务和最近会话。
- [ ] 能按 `task_id` 查 execution_log 和 decision_state。
- [ ] migration 可重复在空库执行。

---

### P0-03 建立 schema / manifest / registry 文件协议

**类型:** AFK  
**依赖:** 无  
**目标:** 让 ResearchTask、Skill、Tool、Plan、Report 都有可机器校验的结构。

**任务:**

- [ ] 创建 `schemas/research-task.schema.json`。
- [ ] 创建 `schemas/decision-state.schema.json`。
- [ ] 创建 `schemas/execution-plan.schema.json`。
- [ ] 创建 `schemas/skill-manifest.schema.json`。
- [ ] 创建 `schemas/tool-manifest.schema.json`。
- [ ] 创建 `schemas/research-report.schema.json`。
- [ ] 创建 `orchestrator/skill-registry.yaml` 样例。
- [ ] 创建 `orchestrator/tool-registry.yaml` 样例。
- [ ] 创建 `orchestrator/decision-graph.yaml` 样例。
- [ ] 写一个 schema 校验脚本,能校验上述 JSON/YAML。

**验收标准:**

- [ ] 所有样例文件能通过校验。
- [ ] 缺少 `owner/status/input_schema/output_schema` 的 skill 无法进入 active。
- [ ] 缺少 `risk_level/adapter_type/input_schema/output_schema` 的 tool 无法进入 active。
- [ ] 高风险 tool 没有 `approver_rule` 时无法进入 active。
- [ ] `decision-graph.yaml` 中节点必须包含 `key/applies_to/tier`。

---

### P0-04 确定首个端到端 task_type 与种子能力

**类型:** HITL  
**依赖:** P0-03  
**目标:** 选一个最小真实场景,避免一开始把所有用研能力都接进来。

**推荐默认值:**

- 首个 task_type: `competitive_research`
- 种子 skill:数字人/直播/竞品分析相关 skill,若当前已有 B8 design-audit 更成熟,则用 B8 作为第一种子。
- 种子 tool:一个低风险 o2 查询/页面抓取 tool,或 fake o2 adapter 先占位。

**任务:**

- [ ] 选择首个 task_type。
- [ ] 确定 1 个种子 skill 的维护方 owner。
- [ ] 补齐该 skill 的 `SKILL.md / manifest.yaml / input.schema.json / output.schema.json / examples / evals`。
- [ ] 确定 1 个种子 tool 的调用方式。
- [ ] 补齐该 tool 的 `manifest.yaml / adapter.md / input.schema.json / output.schema.json / examples`。

**验收标准:**

- [ ] 种子 skill 状态可从 draft 升为 active。
- [ ] 种子 tool 状态可从 draft 升为 active。
- [ ] 用一条真实需求能命中该 skill/tool。
- [ ] 维护方明确,但执行流程不依赖找人线下完成。

---

## 3. Phase 2: 产品最小主链路

### P1-01 用户注册、登录与用户归属

**类型:** AFK  
**依赖:** P0-02  
**目标:** 用独立注册体系管理用户,不接 ERP。

**任务:**

- [ ] 实现注册接口:邮箱、显示名、密码。
- [ ] 实现登录接口:邮箱 + 密码。
- [ ] 实现当前用户接口。
- [ ] 密码只存 hash,不存明文。
- [ ] 所有会话和任务写入 `owner_user_id`。
- [ ] 历史任务只能默认看自己的。

**验收标准:**

- [ ] 未登录不能创建任务。
- [ ] 用户 A 看不到用户 B 的历史任务。
- [ ] 注册邮箱唯一。
- [ ] `users.id` 是业务主键,不是邮箱。

---

### P1-02 ChatGPT 式会话工作台骨架

**类型:** AFK  
**依赖:** P0-02, P1-01  
**目标:** 前台具备新建任务、历史任务、主对话输入和消息回放。

**任务:**

- [ ] 左侧栏:新建任务、历史任务、能力库入口、案例库入口。
- [ ] 主区域:欢迎态、消息列表、底部输入框。
- [ ] 无输入时不展示任务类型、决策策略或分析结论。
- [ ] 用户提交后创建 conversation 和 message。
- [ ] 历史任务点击后恢复 conversation/messages。
- [ ] 消息支持 `text / plan / execution_update / report / error` 类型。

**验收标准:**

- [ ] 刷新页面后历史会话仍可恢复。
- [ ] 新建任务会创建新的 conversation。
- [ ] 没有输入时页面只展示欢迎态和建议问题。
- [ ] 移动端和桌面端文本不溢出。

---

### P1-03 一句话需求转 ResearchTask

**类型:** AFK  
**依赖:** P0-01, P0-03, P1-02  
**目标:** 用户输入一句话后,系统生成结构化任务,并写入 DB。

**任务:**

- [ ] 调用 orchestrator runtime 生成 ResearchTask。
- [ ] 输出字段至少包含 `task_type / business_domain / research_goal / assumptions / confirmations / blocking_issues / sensitivity / pii_detected`。
- [ ] ResearchTask 通过 schema 校验。
- [ ] 写入 `research_tasks.structured_task`。
- [ ] 将识别结果以消息卡片展示。

**验收标准:**

- [ ] 普通竞品需求能识别为 `competitive_research`。
- [ ] 缺少研究目标时进入 `confirmations`。
- [ ] 可默认的信息进入 `assumptions`。
- [ ] schema 不合规时自动重试一次;仍失败则返回错误消息。

---

### P1-04 决策节点激活与状态记录

**类型:** AFK  
**依赖:** P0-03, P1-03  
**目标:** 不是固定 7 步,而是按 task_type 激活相关决策节点子集。

**任务:**

- [ ] 读取 `decision-graph.yaml`。
- [ ] 按 `applies_to / tier` 激活相关节点。
- [ ] 让 LLM 对激活节点生成 `satisfied / need_clarify / need_execute / need_annotate / need_approval / blocked` 状态。
- [ ] 写入 `task_decision_states`。
- [ ] 前台展示"已识别任务意图 + 当前计划依据",不展示无关节点。

**验收标准:**

- [ ] 竞品任务不会激活明显无关的用户访谈/眼动节点。
- [ ] 每个激活节点都有 reason 和 confidence。
- [ ] 用户修改假设后,受影响节点能重新计算。
- [ ] 状态写入 DB 后可复盘。

---

### P1-05 Skill/Tool 候选选择与待确认计划

**类型:** AFK  
**依赖:** P0-03, P0-04, P1-04  
**目标:** 生成一份用户可确认的人话计划,确认前不执行。

**任务:**

- [ ] 读取 `skill-registry.yaml` 与 `tool-registry.yaml` 轻量索引。
- [ ] 由 LLM 基于 `name/description/when_to_use` 选择候选 skill。
- [ ] Tool 先做权限、风险、可用性预筛。
- [ ] 渐进加载候选 `SKILL.md`。
- [ ] 生成 `execution-plan`。
- [ ] 将 plan 写入 run workspace。
- [ ] 前台展示计划卡片:步骤、调用能力、系统假设、需确认项。
- [ ] 用户可修改 assumptions。
- [ ] 用户点击"确认计划,开始执行"后才进入执行。

**验收标准:**

- [ ] 计划确认前没有 tool 调用记录。
- [ ] 每一步都能看到将调用的 skill/tool。
- [ ] 高风险步骤显示 need_approval。
- [ ] 修改 assumptions 后计划能刷新受影响步骤。

---

### P1-06 执行引擎最小实现:1 个 skill + 1 个 tool

**类型:** AFK  
**依赖:** P1-05  
**目标:** 确认计划后,系统能执行种子 skill/tool,写日志并生成中间产物。

**任务:**

- [ ] 实现执行状态: `pending / running / succeeded / failed / skipped`。
- [ ] 执行 skill 前加载必要 schema/examples/templates。
- [ ] 通过 tool-adapter 调用种子 tool。
- [ ] 每一步写 `execution_log`。
- [ ] tool 输出写入 run workspace 或 artifact。
- [ ] 失败写 `failures.jsonl`。
- [ ] 前台展示执行进度。

**验收标准:**

- [ ] 执行成功时每一步都有 `succeeded` 记录。
- [ ] tool 失败时只停在失败步骤,不整体重跑。
- [ ] 能从 `context_manifest_ref` 看到当时加载了什么。
- [ ] 前台能看到"执行中/完成/失败"状态变化。

---

### P1-07 最终报告生成与 artifact 入库

**类型:** AFK  
**依赖:** P1-06  
**目标:** 汇总用户输入、知识库、tool 输出和 LLM 推断,生成可交付报告。

**任务:**

- [ ] 实现 synthesis prompt。
- [ ] 报告结构符合 `research-report.schema.json`。
- [ ] 报告包含研究目标、方法建议、执行时间线、产出物清单、能力编排、风险与待确认。
- [ ] 每条关键结论标注来源:用户输入 / 知识库 / Tool 结果 / LLM 推断 / 待人工确认。
- [ ] 报告作为 artifact 写入 DB。
- [ ] 前台展示最终报告。

**验收标准:**

- [ ] 报告 schema 校验通过。
- [ ] 无来源标注的关键结论不能通过 report linter。
- [ ] artifact 能从历史任务打开。
- [ ] 能看到本次调用的 skill/tool 清单。

---

### P1-08 MVP 知识库检索

**类型:** AFK  
**依赖:** P0-03  
**目标:** 不上 pgvector,先跑通 Markdown/YAML + metadata + BM25/关键词召回 + LLM 小候选重排。

**任务:**

- [ ] 建 `knowledge-base/methods`。
- [ ] 建 `knowledge-base/templates`。
- [ ] 建 `knowledge-base/terminology`。
- [ ] 建 `knowledge-base/cases`,放 3-5 个脱敏案例。
- [ ] 每条知识补 frontmatter metadata。
- [ ] 写 `knowledge-index.json` 生成脚本。
- [ ] 实现 metadata 过滤。
- [ ] 实现 BM25/关键词召回 top 20。
- [ ] 让 LLM 对 title/summary/source/hash 重排 top 5。
- [ ] 报告引用知识时带 `id/source/content_hash`。

**验收标准:**

- [ ] `status != approved` 的知识默认不进入候选。
- [ ] 超出模型通道允许 sensitivity 的知识不进入候选,或只进入脱敏摘要。
- [ ] 查询"直播竞品研究"能召回相关案例。
- [ ] 最终报告能追溯知识来源。

---

### P1-09 Harness linters 与质量门禁

**类型:** AFK  
**依赖:** P0-03, P1-05, P1-07, P1-08  
**目标:** 把关键约束写成可执行校验器,不要只靠文档。

**任务:**

- [ ] `registry-linter`:校验 skill/tool manifest 必填字段。
- [ ] `risk-linter`:校验高风险 tool 是否有 approval。
- [ ] `report-linter`:校验报告结构与来源标注。
- [ ] `context-linter`:校验上下文预算、task_type 相关性、PII/confidential、模型通道策略。
- [ ] 在 CI 或本地命令中串起四类 linter。

**验收标准:**

- [ ] 缺 manifest 字段会失败。
- [ ] 高风险 tool 无 approver 会失败。
- [ ] 报告缺来源会失败。
- [ ] 含 PII 且无脱敏/审批的上下文会失败。

---

## 4. Phase 3: 打包上线所需能力

### P1-10 失败恢复与任务复盘

**类型:** AFK  
**依赖:** P1-06  
**目标:** 失败后能定位、重试、跳过或终止,不用整体重跑。

**任务:**

- [ ] 前台展示失败步骤。
- [ ] 支持人工选择重试、跳过、终止。
- [ ] 重试时复用原 `plan.json` 与 context_manifest。
- [ ] 跳过时写 `execution_log.status = skipped`。
- [ ] 终止时写 task status。
- [ ] 提供任务复盘视图:选了哪些 skill/tool、为什么选、哪里失败。

**验收标准:**

- [ ] 强制 tool 失败后能从失败步骤重试。
- [ ] 跳过失败步骤后报告中标注缺失来源或风险。
- [ ] 复盘视图能回答"为什么选 X skill、没选 Y skill"。

---

### P1-11 能力库与案例库只读页

**类型:** AFK  
**依赖:** P0-03, P1-08  
**目标:** 左侧能力库和案例库可查看,但不做复杂运营后台。

**任务:**

- [ ] 能力库读取 `skill-registry.yaml`。
- [ ] 展示 skill 名称、when_to_use、owner、status、risk_level、required_tools。
- [ ] 案例库读取 `knowledge-index.json`。
- [ ] 展示案例标题、摘要、tags、source、sensitivity。
- [ ] draft/deprecated 状态明确标识。

**验收标准:**

- [ ] 用户能查看当前系统有哪些 active skill。
- [ ] 用户能查看可引用案例。
- [ ] 不允许普通用户在页面直接修改 registry 或知识库。

---

### P1-12 反馈闭环

**类型:** AFK  
**依赖:** P1-07  
**目标:** 用户能对报告给反馈,系统能沉淀到 DB。

**任务:**

- [ ] 报告页支持评分、是否采纳、文字反馈。
- [ ] 写入 `user_feedback`。
- [ ] 反馈与 task/report 关联。
- [ ] 历史任务页展示是否已反馈。

**验收标准:**

- [ ] 一个 task 可提交反馈。
- [ ] 反馈能被查询。
- [ ] 不自动修改 skill 或知识库。

---

### P1-13 种子 skill 迁移模板与验收流程

**类型:** HITL  
**依赖:** P0-04, P1-06  
**目标:** 让后续 10+ 团队能力接入时不改主流程代码。

**任务:**

- [ ] 编写 `migration-checklist.md`。
- [ ] 编写 skill 模板目录。
- [ ] 编写 tool 模板目录。
- [ ] 用种子 skill 完成一次迁移演示。
- [ ] 写 2-3 条 eval。
- [ ] 定义 draft → active → deprecated 的状态流转。

**验收标准:**

- [ ] 新 skill 按模板提交后能被 registry 读取。
- [ ] 缺 schema/examples/evals 时不能 active。
- [ ] 种子 skill 的 eval 能在 CI 或本地命令中运行。

---

## 5. Phase 4: 二期增强,不阻塞 MVP

### P2-01 审批流独立建模

**类型:** HITL  
**依赖:** P1-05, P1-06  
**目标:** 当高风险 tool 使用变多后,从 `approval_state + execution_log` 拆出 `approval_requests`。

**暂不做原因:** MVP 高风险场景少,先用简单状态足够。

---

### P2-02 pgvector 语义检索

**类型:** AFK  
**依赖:** P1-08  
**目标:** 当知识规模变大后,把 approved 知识同步到 `knowledge_items / knowledge_embeddings`。

**触发条件:**

- skill 上百。
- 案例库数量明显增长。
- BM25/关键词召回无法满足业务。

---

### P2-03 飞书看板同步

**类型:** AFK  
**依赖:** P1-03, P1-07  
**目标:** 飞书作为项目进度看板真相源,PG 只存 `feishu_record_id`。

**暂不做原因:** 不影响 agent 主链路,可在 MVP 跑通后接入。

---

### P2-04 多 Agent / Reviewer Agent 常驻化

**类型:** HITL  
**依赖:** P1-09  
**目标:** 仅当高风险输出、高风险 tool 或对外发布明显增多时,再引入常驻 reviewer agent。

**暂不做原因:** MVP 先 1 Agent + N Skill,避免上下文成本和维护复杂度失控。

---

## 6. 推荐开发顺序

```text
第 1 批:P0-01 + P0-02 + P0-03
第 2 批:P0-04 + P1-01 + P1-02
第 3 批:P1-03 + P1-04 + P1-05
第 4 批:P1-06 + P1-07 + P1-08 + P1-09
第 5 批:P1-10 + P1-11 + P1-12 + P1-13
二期:P2-01 + P2-02 + P2-03 + P2-04
```

第 1 批结束后必须做一次技术评审:如果 OpenAI Agents SDK spike 不通过,马上切 Claude Agent SDK 复测,不要继续把业务代码写死在未验证 runtime 上。

第 4 批结束后必须做一次 MVP 验收:如果不能跑通"一句话 → 确认计划 → 执行 skill/tool → 报告 → 历史复盘",就不要进入推广和多团队 skill 迁移。

---

## 7. MVP 验收总清单

- [ ] 用户可注册、登录、创建任务。
- [ ] 左侧历史任务可恢复会话。
- [ ] 无输入时页面不展示任务类型和决策策略。
- [ ] 输入一句话后生成 ResearchTask。
- [ ] 决策节点按 task_type 激活,不是固定 7 步。
- [ ] 系统生成待确认计划。
- [ ] 用户确认前不执行 skill/tool。
- [ ] 用户确认后执行 1 个 active skill 和 1 个 active tool。
- [ ] 高风险 tool 未审批时不执行。
- [ ] 每一步写入 execution_log。
- [ ] tool 失败可复盘,可重试/跳过/终止。
- [ ] 知识库通过 metadata + BM25/关键词召回参与计划或报告。
- [ ] 最终报告通过 schema 和 report linter。
- [ ] 报告关键结论带来源标注。
- [ ] artifact 可从历史任务打开。
- [ ] 用户反馈写入 user_feedback。
- [ ] 能回答"为什么这次选了 X skill、没激活 Y 节点"。

---

## 8. 明确不做

- MVP 不做完整权限系统,只做 owner 可见和基本 role。
- MVP 不接 ERP。
- MVP 不上 pgvector。
- MVP 不做复杂 DAG 引擎。
- MVP 不做多 Agent 群。
- MVP 不做自动学习和自动改 registry。
- MVP 不把 skill/tool 配置写进运行时 DB。
- MVP 不把大文件和 tool 原始输出塞进 PostgreSQL。
