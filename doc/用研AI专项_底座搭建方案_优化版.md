# 用研 AI 专项 · Agent Harness + Skill Orchestrator 搭建方案(优化版)

## Context

用研专项要解决三个痛点:每次用研从 0 起、各团队能力是孤岛、新人不知道找谁。目标是把散落在 10+ 团队的用研能力(数字人竞品/人群审查/眼动 review/用户之声等)聚合成一个"懂用研的资深同事"——用户输入一句话,系统输出"找谁 + 用什么方法 + 参考什么"。

需求文档(`doc/用户研究 AI 专项 · 交付管理文档.md`)已定义四层结构;一份 AI 生成的搭建方案(`doc/用研AI专项_AgentHarness与SkillOrchestrator底座搭建方案.md`)给出了 8 层架构 + 16 张表的实现。**本方案是对该 AI 方案的优化**:它的判断力(Skill/Tool 分离、决策节点状态机、可追溯、schema 化)是对的,但按"从零自建分布式后端"来画,导致层数、表数翻倍,还把"动态判断"硬编码进了引擎——与它自己"要动态"的诉求自相矛盾。

**当前状态:** 仓库 greenfield(仅 `doc/` 两份文档);各团队 skill 已建好但在别处(设计 wiki / 各团队),不在本仓库。

**已确认约束(2026-07-06):** ① 运行载体 = 独立 Web 门户 + 咚咚 Bot(需薄后端);② 有专门工程团队长期维护;③ DB 兼顾"调度复盘"与"案例检索/看板"。

**预期结果:** 一套可扩展的"用研任务操作系统"骨架——skill/tool 可持续增加、决策由 LLM 依需求与能力动态调整、运行全程可追溯入库。工作量压到 AI 方案的约 1/3。

---

## 一条主原则(全案的地基)

> **判断放 LLM,配置放 git/YAML,运行时数据放 DB,后端只做"容器"不做"大脑"。**

推论:决策逻辑一旦落进编译代码或 DB 表就"死"了,无法动态。因此 7 个决策问题、skill 路由规则,必须以 YAML + prompt 形态待在 skill 层交给 LLM 读,**绝不做成独立的"决策引擎"或 `skill_versions` 表**。

**识别层边界(避免误解):** 任务理解(一句话 → ResearchTask)由 **LLM** 承担,是"判断放 LLM"的一部分。`demo/orchestrator-demo.html` 里的关键词匹配只是**前端原型示意**,不代表真实识别逻辑——真实系统靠 LLM 结构化理解,demo 仅用于敲定交互形态。

---

## 一、架构:8 层 → 3 个真实组件

AI 方案的 8 层里,5 层其实是"一次 LLM 调用内的思考步骤",不该各成后端模块:

| AI 方案的层 | 真相 | 落在哪 |
|---|---|---|
| 需求理解层 | 一次 LLM 调用 | orchestrator skill 的 prompt |
| 上下文检索层 | 一次检索 | 读 registry +(二期)pgvector |
| 动态决策层 | 一次 LLM 调用 | decision-graph.yaml + prompt |
| 能力路由层 | 一次 LLM 调用 | 同上,读 registry 打分 |
| 执行层 | 子 agent 并行 | Agent SDK,不自建 DAG 引擎 |
| 结果综合层 | 一次 LLM 调用 | synthesis prompt |

真正要工程团队写的只有 **3 个组件**:

1. **agent-api(入口适配层)** — 门户 / 咚咚 Bot 的统一后端:收需求、鉴权、开会话、返回结果、写库。**所有入口共用**,避免门户与 Bot 各写一套。
2. **Orchestrator(编排容器)** — 封装 Claude Agent SDK 的薄壳:装载 orchestrator skill → LLM 结构化任务 → 读 registry + decision-graph 选 skill → 派子 agent 执行 → 按 report schema 汇总。判断全在 skill,壳不含业务 if-else。
3. **Research Memory DB** — 只存运行时数据(见第三节)。

数据流:
```
门户 / 咚咚Bot / AgentWiki
        ↓
    agent-api(统一入口:鉴权/会话/写库)
        ↓
    Orchestrator(Claude Agent SDK 薄壳)
        ├─ 装载 research-orchestrator SKILL.md
        ├─ 读 skill-registry.yaml + decision-graph.yaml
        ├─ 派子 agent 并行执行选中的 skill/tool
        └─ 按 research-report.schema 汇总
        ↓
    Research Memory DB(任务/决策/执行/产物/反馈)
```

---

## 二、决策图 + 路由:数据化,不做引擎

### 2.1 决策图 = 决策节点池,不是"人人过 7 关"

**关键定位(演进后):** 7 个决策问题**不是流程/控制流**,而是资深用研老师沉淀的**完备性护栏(必检清单)**——属于领域知识。它是与 `skill-registry` 平行的**"决策节点池"**,不是一条所有任务都必走的七格轨道。

- **task_type 先分流,只激活相关子集**:竞品研究任务根本不出现"D2 用户人群 / D4 体验现状"(不是"评估后 skipped",而是压根不进入评估);用户之声诊断不出现"D5 竞品"。
- **节点分级防漏项**:`tier: core`(如 D1 研究目标 / D7 产出标准,几乎所有 task_type 都激活,漏了就翻车)vs `tier: optional`(如 D4/D5,场景相关按需激活)。
- **加节点不改逻辑**:未来加"无障碍审查"任务,只需引入 D8 节点声明 `applies_to: [a11y_audit]`,不碰其他任务。

**decision-graph.yaml** — 每节点声明:

```yaml
- key: D5_competitive
  question: 是否需要竞品参照
  applies_to: [user_research_planning, competitive_research]  # 不相关 task_type 直接不激活
  tier: optional          # core | optional
  trigger_conditions: [用户提到竞品/对标, 探索性研究]
  related_tags: [ui-competitive, business-competitive]
```

节点状态收敛为(见 §五 四段流中的用法):`satisfied / need_clarify / need_execute / need_annotate`。加新节点 = 改 YAML,判断仍交 LLM,不改代码。

### 2.2 能力路由:数据化,不做引擎

- **skill-registry.yaml** — 每个 skill 一份 manifest(`id / owner / intent_tags / input_schema / output_schema / trigger_conditions / cost_level / status`)。`owner` 语义是**维护方/团队**(如"竞品分析组"),不是"调用时要找的人"——命中的能力由系统直接调用,而非导流找人(见 §五)。registry 是**路由的唯一真相源**,新增 skill = 加文件夹 + manifest,注册即用。
- **三段式路由**(规则粗筛 → 语义召回 → LLM 精选)——方向对,但 **MVP 只做"规则粗筛 + LLM 精选"**。skill 仅数十个时,LLM 一次读完整个 registry 直接选;等 skill 上百再引 pgvector 语义召回。
- **能力选择不必都过决策节点**:部分 skill/tool 由需求语义直接命中(规则粗筛+召回);决策节点主要管两件事——完备性把关(该问的有没有问)+ 标注需人工确认的产出。

---

## 三、数据库:16 张 → MVP 5 张

AI 方案最严重的错误:**把配置塞进了 DB**。`skills / skill_versions / tools / skill_tool_bindings / decision_nodes` 这 5 张全是配置,应放 git+YAML(可 review / diff / 回滚),入 DB 反丢版本管理。

DB 只存**运行时数据**(这一次任务发生了什么):

| MVP 必做(5 张) | 存什么 | 服务目的 |
|---|---|---|
| `research_tasks` | 用户原话 + 结构化理解结果 + 飞书行 ID 引用 | 复盘 |
| `task_decision_states` | 本次激活的决策节点各判成什么状态、为什么(reason/confidence) | **调度复盘核心** |
| `execution_log` | 每步调了哪个 skill/tool、输入输出、耗时、来源标注 | 复盘 |
| `artifacts` | 最终报告/方案(report 是 artifact 的一种,**不单开 research_reports**) | 沉淀 |
| `user_feedback` | 是否采纳 + 评分 + 文本 | 优化下次调度 |

| 二期加 | 触发条件 |
|---|---|
| `knowledge_items` + `knowledge_embeddings`(pgvector) | 要"案例语义检索"时,MVP 跑通后再上 |
| `skill_evaluations` | MVP 先用 `user_feedback` 覆盖,后期拆细 |

**项目进度看板**:需求文档明说接飞书多维表格(`doc/用户研究 AI 专项 · 交付管理文档.md:84,233`)。**飞书是看板真相源**,不在 PG 重复造;PG `research_tasks` 存飞书行 ID 引用即可。

**存储选型**:PostgreSQL(结构化)MVP 足够;pgvector 二期开启;对象存储放报告附件/录音转写/设计稿截图。

---

## 四、目录结构(建议)

配置 + 内容 = 一个 git 仓库;后端代码可同仓 `apps/` 或独立仓,按工程团队习惯。

```
用研专项/
├── knowledge-base/          # 第1层:纯文件,方法论/人群标签/正反例/术语表/历史档案
├── skills/                  # 第2层:各团队交付的 skill 文件夹(SKILL.md + manifest + 6件套)
│   ├── shared/              #   共用模板 + research-report-schema
│   ├── research-flow/       #   research-kickoff / method-selection / data-collection / report-generation ...
│   ├── competitive-analysis/# ui / function / business / digital-human competitive
│   ├── user-voice/          #   voc-monitoring ...
│   ├── design-audit/        #   ui-audit / audience-audit / eye-tracking-audit
│   └── design-analytics/    #   用户旅程 / 可用性 / AB
├── orchestrator/            # 第3层:调度中心
│   ├── research-orchestrator/SKILL.md   # 决策树的"活"载体
│   ├── decision-graph.yaml              # 7 节点 + 5 状态 + 触发规则
│   ├── skill-registry.yaml              # 所有 skill manifest 索引(路由唯一真相源)
│   └── prompts/{planner,router,synthesis}.md
├── schemas/                 # 三件套:research-task / skill-manifest / research-report(+ decision-state / tool-manifest)
├── database/                # migrations + seed(仅 5 张运行时表)
├── apps/                    # 第3组件后端
│   ├── agent-api/           #   统一入口(门户 + 咚咚Bot)
│   └── orchestrator-runtime/#   Claude Agent SDK 薄壳
└── feedback/                # 第4层:飞书同步脚本 + skill 迭代记录约定
```

---

## 五、一次完整运行流程 · 计划-确认-执行(四段协作流)

**范式(演进后):** 系统不是"单向摊开思考过程一路跑到底",而是与用户协作——**先出计划,用户确认,再自动执行,最后交付可落地方案**。计划确认是一道**硬闸门**:未确认不执行。

```
0  用户在门户/咚咚 输入一句话 → agent-api 建 research_task,开会话

【段1 · 任务理解】
1  Orchestrator 装载 orchestrator skill → LLM 把一句话转成 ResearchTask
   （结构化:task_type / business_domain / research_goal;缺失处不追问,转为段2的"假设"）
   ※ 识别层由 LLM 承担(见 §一说明);demo 的关键词匹配仅前端原型示意

【段2 · 待执行计划】← 核心闸门
2  按 task_type 从决策节点池激活相关子集(略过无关节点,不做"7 节点逐一打状态")
3  读 skill-registry,规则粗筛 + LLM 精选出计划步骤(每步绑定要调用的 skill/tool)
4  向用户呈现人话计划:编号步骤 + 每步调用的能力 + 系统假设(缺失信息代填,可点击改)
5  ⏸ 等待用户【确认计划】——未确认不进入执行

【段3 · 执行】(用户确认后)
6  按计划逐步执行:命中的 skill/tool 由系统【直接自动调用】
   （tool 在系统中配置好即调用,不"找负责人";无线下人工环节)
   每步写 execution_log;需人工确认的产出标 need_annotate,不阻塞执行

【段4 · 交付】
7  synthesis 汇总为可落地方案:研究目标 / 执行流程+时间线 / 产出物清单 / 能力编排
   （结论带来源标注:用户输入 / 历史案例 / Tool 结果 / LLM 推断 / 待人工确认）
8  校验产出符合 research-report.schema;存 artifacts
9  返回方案 + 采纳/导出/沉淀 Wiki 入口;开放 user_feedback
```

**关键特性:**
- **计划确认是硬闸门**:用户可在段2改假设或修改需求,确认后才执行——真正的"人在环",而非事后被动追问。
- **能力自动调用,不导流找人**:段3 命中的能力由系统直接调用;`owner` 只是能力的维护方标注,不出现在给用户的"下一步"里。
- **缺失信息 = 假设可改**,不打断流程去追问(见 Q4 的确认闭环)。
- 决策节点池按需激活,简单任务轻装直达,复杂任务才启动全套护栏。

---

## 六、分阶段落地(对齐 W28–W36 里程碑)

- **试点期(7月)**:交付 `schemas/` 三件套 + `decision-graph.yaml` + `skill-registry.yaml` + `research-orchestrator/SKILL.md` + 5 张核心表 DDL。跑通"一句话 → 方案初稿",半自动、人可干预。用 1 个已建好的 skill(如 B8 design-audit)接入验证。
- **打包期(8月)**:各团队 skill 按 manifest 标准入 registry;子 agent 并行执行落地;`agent-api` + `orchestrator-runtime` 上线。
- **推广期(8月后)**:门户 + 咚咚 Bot 入口;pgvector 案例检索;飞书看板同步;skill 评估闭环。

---

## 七、待工程团队产出的骨架清单(交付物)

MVP 阶段按此清单落地,均为可 review 的文件/配置,非运行时黑盒:

1. `schemas/research-task.schema.json` — 用户需求如何结构化;含 `assumptions[]`(系统对缺失信息的可改假设,区别于纯缺失字段)
2. `schemas/skill-manifest.schema.json` — skill 如何被发现/选择/调用/评估(`owner` = 维护方/团队)
3. `schemas/tool-manifest.schema.json` — tool 如何声明与配置化调用(adapter 优先级:o2 → 内部 API/MCP → 脚本;见 Q2)
4. `schemas/research-report.schema.json` — 标准报告结构(对齐交付物 A2);扩字段 `timeline`(执行流程+周次)/ `deliverables`(产出物清单)/ `capability_orchestration`(能力编排:调用了哪些 skill/tool)
5. `orchestrator/decision-graph.yaml` — 决策节点池,每节点含 `applies_to` + `tier(core/optional)` + 触发规则
6. `orchestrator/skill-registry.yaml` — skill manifest 索引 + 1 个样例 manifest
7. `orchestrator/research-orchestrator/SKILL.md` — 编排主 skill(任务理解 → 计划 → 确认 → 执行 → 交付 的四段 prompt)
8. `database/migrations/*.sql` — 5 张运行时表 DDL + 配置/运行时边界说明
9. `apps/agent-api` + `apps/orchestrator-runtime` — 薄后端(打包期)

---

## 验证方式(MVP 端到端)

1. **schema 校验**:用一条真实需求("我要为直播场域做一次用户体验研究")手工构造 ResearchTask,跑 JSON Schema 校验通过。
2. **决策节点池空跑**:喂该 ResearchTask 给 orchestrator skill(可先在 Claude Code / Agent SDK 里本地跑),检查 task_type 分流后**只激活相关节点子集**(如竞品任务不激活 D2/D4),激活节点的状态 + reason 合理,且能命中 registry 里的 skill。
3. **计划-确认闸门**:确认前不执行;用户改假设后计划相应更新(见 Q4)。
4. **单 skill 接入**:用 B8 design-audit 走通"选中→自动调用→产出符合 report schema"。
5. **入库回看**:确认 `research_tasks / task_decision_states / execution_log / artifacts` 四表有对应记录,能回答"为什么这次选了 X skill、没激活 Y"。
6. **反馈闭环**:提交一条 `user_feedback`,确认可被下次调度读取(MVP 可仅存储,不必自动优化)。

---

## 与 AI 方案的差异速查(给评审用)

| 维度 | AI 方案 | 本方案 | 理由 |
|---|---|---|---|
| 架构层 | 8 层后端 | 3 组件(api / orchestrator / db) | 5 层实为一次 LLM 调用内的步骤 |
| 决策图 | 可计算引擎 + 2 张表 | YAML + prompt,交 LLM 判断 | 引擎化会杀死"动态" |
| 路由 | 三段式(含向量召回) | MVP 规则+LLM,向量召回二期 | 数十个 skill 无需向量,YAGNI |
| DB | 16 张(含配置表) | MVP 5 张运行时表 | 配置归 git/YAML,可 diff/回滚 |
| 报告 | 单开 research_reports | 归入 artifacts | 报告是 artifact 的一种 |
| 看板 | PG 自建 | 飞书为真相源,PG 存引用 | 需求文档已定接飞书 |
| 决策图 | 7 节点人人过关 | 节点池,task_type 按需激活(applies_to/tier) | 固定 7 步与"动态调度"自相矛盾 |
| 交互 | 系统一路跑到底 | 计划→确认→执行→交付四段,确认是硬闸门 | 人在环、可干预,而非事后追问 |
| 能力调用 | 推荐 Owner / 挂人校准 | 命中能力自动调用,owner 仅维护方标注 | tool 配置化直接调用,不导流找人 |
| 最终产物 | 研究报告 | 方案含时间线+产出物清单+能力编排 | 可直接开工,而非半成品 |

---

## 待明确开放项(Q1–Q6 · 进开发前评审拍板)

以下为文档/demo/讨论三层都尚未定死的事项,已附推荐默认值(带理由)。评审时在此基础上确认或推翻。

| # | 开放项 | 推荐默认值 | 理由 | 影响的交付物 |
|---|---|---|---|---|
| Q1 | 计划确认粒度:整份确认 vs 逐步骤增删 | MVP 先"整份确认 + 改假设",不做逐步骤增删 | KISS,逐步骤编辑重投入,有真实需求再加 | agent-api plan 接口 |
| Q2 | tool 真实接入形态 | 统一 tool-manifest + 适配器,优先级 o2 → 内部API/MCP → 脚本;tool-gateway 二期建 | 与"配置即真相源"一致,o2 京东内覆盖最广 | tool-manifest.schema、tool-gateway |
| Q3 | `need_human_review` 状态去留 | 保留但改语义为 `need_annotate`——标"产出需人工确认"写进风险区,不阻塞执行、不找人 | 护栏价值仍在(防 LLM 越权下结论),又不违背"不找人" | decision-graph 状态集、report-schema 风险区 |
| Q4 | 改假设后是否重算计划 | MVP 轻量重算——仅重刷受影响的计划步骤,不整体重跑决策 | 整体重规划成本高、易困惑,轻量刷新够用 | orchestrator skill、agent-api |
| Q5 | LLM/Agent 运行时选型 | 抽象 `llm-client` 接口,底层可切内部网关或 Claude API,不硬绑 SDK | 京东内多半走内部网关,预留切换点避免返工。**须工程团队确认,推荐值仅占位** | orchestrator-runtime |
| Q6 | MVP 首个端到端 task_type | 竞品研究优先;design-audit 走查(B8 试点中)第二 | 竞品边界最清(激活节点最少)、tool 依赖明确(o2 抓取),最易验证骨架 | 试点排期、首批 skill/tool |
