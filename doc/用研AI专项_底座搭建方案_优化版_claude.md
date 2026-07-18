# 用研 AI 专项 · Agent Harness + Skill Orchestrator 搭建方案(优化版)

## Context

用研专项要解决三个痛点:每次用研从 0 起、各团队能力是孤岛、新人不知道找谁。目标是把散落在 10+ 团队的用研能力(数字人竞品/人群审查/眼动 review/用户之声等)聚合成一个"懂用研的资深同事"——用户输入一句话,系统输出"找谁 + 用什么方法 + 参考什么"。

需求文档(`doc/用户研究 AI 专项 · 交付管理文档.md`)已定义四层结构;一份 AI 生成的搭建方案(`doc/用研AI专项_AgentHarness与SkillOrchestrator底座搭建方案.md`)给出了 8 层架构 + 16 张表的实现。**本方案是对该 AI 方案的优化**:它的判断力(Skill/Tool 分离、决策节点状态机、可追溯、schema 化)是对的,但按"从零自建分布式后端"来画,导致层数、表数翻倍,还把"动态判断"硬编码进了引擎——与它自己"要动态"的诉求自相矛盾。

**当前状态:** 仓库 greenfield(仅 `doc/` 两份文档);各团队 skill 已建好但在别处(设计 wiki / 各团队),不在本仓库。

**已确认约束(2026-07-06):** ① 运行载体 = 独立 Web 门户 + 咚咚 Bot(需薄后端);② 有专门工程团队长期维护;③ DB 兼顾"调度复盘"与"案例检索/看板"。

**预期结果:** 一套可扩展的"用研任务操作系统"骨架——skill/tool 可持续增加、决策由 LLM 依需求与能力动态调整、运行全程可追溯入库。工作量压到 AI 方案的约 1/3。

---

## 一条主原则(全案的地基)

> **业务判断交给 LLM + 配置,配置放 Git/YAML,执行边界和质量门禁交给后端,运行时数据放 DB。**

推论:决策逻辑一旦落进编译代码或运行时配置表就容易变"死",无法动态演进。因此决策节点、skill 路由规则、tool 调用边界,优先以 YAML + prompt + schema 的形态放在配置层,交给 LLM 读取和判断。后端不承载领域判断,但必须承载硬约束: schema 校验、权限、风险拦截、重试、审计、状态流转和版本追溯。

**后端的硬边界(防止业务逻辑回流):** "执行边界和质量门禁交给后端"指的是**格式校验与安全闸门**(schema / 权限 / 风控 / 审计 / 状态流转 / 版本追溯),**不是业务规则**。后端可以读取 `task_type` 做日志、统计、配置索引和权限策略匹配,但不能把它写成领域分支,例如 `if task_type == competitive_research then call xxx`。判断"这个任务该不该做竞品分析""这个人群要不要拆分",必须来自 LLM + YAML 配置层。一旦后端开始沉淀领域 if-else,就是架构跑偏的信号。

**配置不进运行时 DB,但执行必须可复盘:** MVP 不单独建设 `skill_versions` 配置表,但每次执行必须记录当次使用的 manifest Git commit、文件 hash 或 manifest snapshot。否则 skill 更新后,无法解释历史任务为什么选了某个能力、为什么给出某个结论。

**识别层边界(避免误解):** 任务理解(一句话 → ResearchTask)由 **LLM** 承担,是"判断放 LLM"的一部分。[用研AI专项_前台页面demo.html](/Users/heyunshen/work/PROJECT/jdc/ai-x/doc/用研AI专项_前台页面demo.html) 里的关键词匹配只是**前端原型示意**,不代表真实识别逻辑——真实系统靠 LLM 结构化理解,demo 仅用于敲定交互形态。

---

## 一、架构:8 层 → 3 个真实组件

AI 方案的 8 层里,5 层其实是"一次 LLM 调用内的思考步骤",不该各成后端模块:

| AI 方案的层 | 真相 | 落在哪 |
|---|---|---|
| 需求理解层 | 一次 LLM 调用 | orchestrator skill 的 prompt |
| 上下文检索层 | 一次检索 | 读 registry +(二期)pgvector |
| 动态决策层 | 一次 LLM 调用 | decision-graph.yaml + prompt |
| 能力路由层 | 一次 LLM 调用 | 同上,读 registry 打分 |
| 执行层 | 运行时调度 | orchestrator-runtime,不自建复杂 DAG 引擎 |
| 结果综合层 | 一次 LLM 调用 | synthesis prompt |

真正要工程团队写的只有 **3 个组件**:

1. **agent-api(入口适配层)** — 门户 / 咚咚 Bot 的统一后端:收需求、鉴权、开会话、返回结果、写库。**所有入口共用**,避免门户与 Bot 各写一套。
2. **Orchestrator(编排容器)** — 封装统一 `llm-client` 与 `tool-adapter` 的薄壳:装载 orchestrator skill → LLM 结构化任务 → 读 registry + decision-graph 选 skill → 执行 skill/tool → 按 report schema 汇总。判断全在 skill 和配置,壳不含业务 if-else。底层可接内部模型网关、Claude、OpenAI 或其他 Agent Runtime,不要硬绑单一 SDK。
3. **Research Memory DB** — 只存运行时数据(见第三节)。

> **"薄"指不含业务判断,不是工作量小。** `orchestrator-runtime` 才是全项目最吃人月的部分,它要实打实承载:装载 skill、调 LLM、**四类 adapter(o2 / 内部 API / MCP / script)的 tool 集成**、schema 校验、重试、审计、状态流转、`context_manifest` 生成、`failures.jsonl` 回放。"压到 AI 方案约 1/3 工作量"砍掉的是虚层和配置表,**runtime + adapter 集成没有被砍**,排期不能按薄壳估。MVP 阶段 adapter **只先做 o2 一类**(对齐 [Q2/Q6](#待明确开放项q1q15--进开发前评审拍板)),内部 API / MCP / script 二期再接。

数据流:
```
门户 / 咚咚Bot / AgentWiki
        ↓
    agent-api(统一入口:鉴权/会话/写库)
        ↓
    Orchestrator(统一编排运行时)
        ├─ 装载 research-orchestrator SKILL.md
        ├─ 读 skill-registry.yaml + tool-registry.yaml + decision-graph.yaml 的轻量索引
        ├─ 执行选中的 skill/tool
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

节点状态收敛为(见 §五 四段流中的用法):

```text
satisfied        已满足,无需触发能力
need_clarify     缺关键输入,需要用户确认或接受系统假设
need_execute     建议执行对应 skill/tool
need_annotate    可继续执行,但结论需标注为待人工确认
need_approval    高风险操作或敏感数据,必须审批后执行
blocked          缺授权/缺数据/工具不可用,当前无法推进
```

加新节点 = 改 YAML,判断仍交 LLM,不改代码。注意 `need_annotate` 和 `need_approval` 必须分开:前者是结论风险标注,不阻塞执行;后者是安全闸门,必须阻塞执行。

### 2.2 能力路由:数据化,不做引擎

- **核心原则:** Registry 只做发现和粗筛,`SKILL.md` 承载能力逻辑,Tool manifest 承载执行边界,Orchestrator 只负责加载、校验、调用、留痕。不能把 `skill-registry.yaml` 写成巨大的用研规则库,否则只是把复杂性从代码搬到 YAML。
- **skill-registry.yaml 是轻量索引卡** — 每个 skill 只登记 `id / name / path / when_to_use / task_types / input_schema / output_schema / required_tools / risk_level / status / owner`(`when_to_use` 已承担"何时用"的语义,不再单列 `intent_tags`,避免与它重复)。复杂流程、详细 prompt、判断标准、失败降级和示例都留在对应 `SKILL.md` 及其引用文件里。`owner` 语义是**能力维护方/团队**(如"竞品分析组"),不是"调用时要找的人"。命中的能力默认由系统调用,不是导流找人。但真实任务仍需要区分三种人:
  - `owner`:能力维护方,负责 skill/tool 质量和升级。
  - `reviewer`:本次任务的业务/用研确认人,负责目标、样本、人群等判断校准。
  - `approver`:高风险工具、敏感数据或对外发布产物的审批人。
- **渐进加载优先**:MVP 不是把所有 skill/tool 的完整 YAML 和说明一次性塞给 LLM,而是先读轻量 registry 做粗筛,再加载少量候选 `SKILL.md`,确认执行时才加载 schema/examples/tool adapter。skill 仅数十个时,LLM 可以一次读完整个轻量 registry;等 skill 上百再引 pgvector 做语义召回。
- **能力选择不必都过决策节点**:部分 skill/tool 由需求语义直接命中(规则粗筛+召回);决策节点主要管两件事——完备性把关(该问的有没有问)+ 标注需人工确认的产出。

### 2.3 Skill / Tool 接入协议(新增能力如何融入系统)

这里必须分清两件事:

- **Skill 是能力说明和工作流**:它告诉系统"这类用研问题怎么做、何时适用、需要什么输入、应该产出什么"。
- **Tool 是可执行动作**:它负责真实调用 `o2`、内部 API、MCP、脚本、数据平台或文件处理能力。

系统调用逻辑不是用户手动挑 skill,也不是后端写死分支,而是:

```text
用户需求
  → LLM 结构化为 ResearchTask
  → 读取 decision-graph / skill-registry / tool-registry 的轻量索引
  → 激活相关决策节点
  → 规则粗筛候选 skill/tool
  → 加载 2-5 个候选 SKILL.md
  → LLM 生成待确认执行计划
  → 用户确认
  → Orchestrator 执行 skill
  → 执行期按需加载 schema / examples / tool adapter
  → skill 通过 tool-adapter 调用 tool
  → 写 execution_log 与 artifacts
```

三层加载边界:

| 层级 | 读取内容 | 目的 |
|---|---|---|
| 第一层:轻量索引 | `skill-registry.yaml`、`tool-registry.yaml`、`decision-graph.yaml` 的摘要字段 | 发现候选能力,避免全量上下文膨胀 |
| 第二层:候选能力 | 被命中的少量 `SKILL.md` | 理解能力边界、执行步骤、输入输出和人机协作点 |
| 第三层:执行期资源 | schema、examples、templates、tool adapter、知识库条目 | 真正执行和生成可校验结果 |

这就是 agent 中常见的渐进性加载方式:先发现,再理解,最后执行。YAML 只负责"找到谁",不负责"怎么做完这件事"。

**新增 Skill 的交付包:**

```text
skills/{domain}/{skill-id}/
├── SKILL.md                 # 能力说明、执行流程、边界和输出要求
├── manifest.yaml            # 能力元数据,registry 只摘录轻量字段
├── input.schema.json        # 输入结构
├── output.schema.json       # 输出结构
├── examples/                # 2-3 个真实或脱敏样例
└── evals/                   # 最小验收用例
```

`skill-registry.yaml` 中只保留轻量索引:

```yaml
id: digital-human-competitive-analysis
name: 数字人竞品分析
path: skills/competitive-analysis/digital-human/SKILL.md
when_to_use: 用户需要分析数字人、虚拟主播、直播竞品时使用
owner: 竞品分析组
status: active              # draft | active | deprecated
task_types: [competitive_research, user_research_planning]
intent_tags: [digital_human, live_commerce, competitive]
input_schema: ./input.schema.json
output_schema: ./output.schema.json
required_tools:
  - o2-web-search
  - competitor-page-capture
cost_level: medium          # low | medium | high
risk_level: low             # low | medium | high
```

`SKILL.md` 才写能力逻辑,例如适用/不适用场景、执行步骤、默认假设、质量门禁、输出要求、失败降级和示例。这样新增 skill 时不会污染主流程,也不会把 registry 写成第二套编排引擎。

**新增 Tool 的交付包:**

```text
tools/{tool-id}/
├── manifest.yaml            # tool 声明
├── adapter.md               # 如何调用: o2 / API / MCP / script
├── input.schema.json
├── output.schema.json
└── examples/
```

`tool-registry.yaml` 也只保留轻量索引:

```yaml
id: competitor-page-capture
name: 竞品页面抓取
path: tools/competitor-page-capture/manifest.yaml
adapter_type: o2
auth_required: true
risk_level: medium
status: active
```

tool 自己的 `manifest.yaml` 再承载执行边界:

```yaml
id: competitor-page-capture
name: 竞品页面抓取
adapter_type: o2            # o2 | internal_api | mcp | script
entrypoint: o2 ...
auth_required: true
risk_level: medium          # low | medium | high
approver_rule: none         # none | owner | security | legal
timeout_seconds: 60
retry_policy:
  max_attempts: 2
  backoff_seconds: 3
input_schema: ./input.schema.json
output_schema: ./output.schema.json
redaction_policy:
  pii: mask
  sensitive_business_data: block
```

注意:Tool manifest 可以描述权限、超时、重试、脱敏和审批,但不写"什么研究任务该调用我"这类业务判断。业务判断仍由 LLM + skill + registry 摘要完成。

**接入流程:**

1. 能力团队提交 skill/tool 包,并补齐 manifest、schema、样例和 eval。
2. 平台侧跑静态校验:manifest 字段完整、schema 可解析、required_tools 存在、risk_level 合法。
3. 用 2-3 条历史需求做空跑,验证能被路由命中,且不会误伤无关任务。
4. 用一个端到端样例执行,验证输出能通过 `research-report.schema.json`。
5. 合并到 Git 后更新 `skill-registry.yaml` / `tool-registry.yaml`。
6. 生产调用时记录 manifest hash、prompt hash、model version、tool adapter version。

**验收门槛:**

- 没有 manifest 的 skill 不进 registry。
- 没有 input/output schema 的 tool 不允许被自动调用。
- `risk_level: high` 的 tool 必须配置 `approver_rule`,否则状态只能是 `draft`。
- 输出没有来源标注的 skill 不允许进入 `active`。
- 被废弃的 skill/tool 只能保留历史复盘,不能被新任务命中。

### 2.4 Agent Harness 工程约束

吸收《Agent Harness 工程实践》里的可迁移原则:少上下文、少 Agent、多 Skill、状态外置、约束可执行、失败可回放。招聘案例里的 "2 Agent" 数量不照搬,但工程约束要吸收。

**Agent 数量控制:** MVP 只保留 1 个 `Research Orchestrator Agent`。竞品分析、人群审查、眼动分析、用户之声、报告生成等能力优先做成 Skill,不要为每个团队能力新建 Agent。只有满足以下条件之一,才允许升级成专才 Agent:

- 长时间运行,需要跨会话接力。
- 需要独立上下文,避免污染主编排。
- 会对外发消息、改业务系统状态或处理敏感数据。
- 工具集稳定且边界清楚,单次任务只需要 3-5 个工具。

**Run Workspace 是任务真相源:** Research Memory DB 负责结构化复盘,每次运行还需要一个逻辑 workspace 保存中间文件。Context Window 只放当前步骤需要的摘要,不要塞完整历史。

```text
run-workspaces/{task_id}/
├── plan.json                 # 用户确认过的执行计划
├── decision_states.json       # 本次激活的决策节点与状态
├── context_manifest.json      # 本次给 LLM 的上下文清单与来源
├── tool_outputs/              # tool 原始输出或脱敏摘要
├── artifacts/                 # 中间产物与最终产物引用
└── failures.jsonl             # 失败记录,用于回放和规则补强
```

**上下文可回放:** 每次 LLM 调用都要能回答"为什么这条信息出现在上下文里"。`context_manifest.json` 至少记录:

```yaml
run_id: task_20260708_001
stage: planning
loaded_sources:
  - type: research_task
    ref: research_tasks.id
  - type: registry
    ref: orchestrator/skill-registry.yaml
    hash: sha256:...
  - type: skill
    ref: skills/competitive-analysis/digital-human/SKILL.md
    hash: sha256:...
  - type: knowledge
    ref: knowledge-base/cases/live_competitive_001.md
    reason: 命中 live_commerce + competitive_research
model_name: xxx
prompt_hash: sha256:...
```

**约束写成校验器:** 文档只负责解释规则,真正的拦截要进 CI 或运行时 guard。MVP 至少做 4 个校验器:

| 校验器 | 触发时机 | 拦截内容 |
|---|---|---|
| registry linter | skill/tool 合并前 | 缺字段、路径不存在、schema 不可解析、状态非法 |
| risk linter | 计划确认前和 tool 调用前 | 高风险 tool 缺 `approver_rule`、敏感数据未授权 |
| report linter | artifacts 入库前 | 无来源结论、输出不符合 `research-report.schema.json` |
| context linter | LLM 调用前 | 上下文超预算、加载无来源文件、加载与 task_type 无关内容、**PII/`confidential` 未按策略脱敏或未获审批放行**(见 §三·补二) |

**失败要能回放:** 每次失败写入 `failures.jsonl`,不要只留在日志里。失败记录至少包含 `task_id / stage / selected_skill / selected_tool / input_ref / output_ref / error_type / retry_count / context_manifest_ref / suggested_rule`。二期可以加一个后台"文档园丁/规则园丁"任务,定期扫描失败记录,提出 registry、prompt、linter 或知识库修正建议。

**独立 Reviewer 只用于高风险:** 不要一开始做一组互审 Agent。MVP 只在两类场景启用独立 reviewer:对外发送内容、敏感数据或高风险 tool 执行。Reviewer 只看结构化输出、来源标注、风险说明和相关规则,不看主 Agent 的完整上下文,避免复制同一个偏差。

### 2.5 运行时稳定性(失败恢复 / LLM 非确定性 / 审批闭环)

前面几节保证"能力能被正确发现和调用",这一节保证"跑起来出岔子时不崩、可解释、可恢复"。三件事都要有**可运行机制**,不能只停在原则。

**① 失败恢复:一步失败不整体崩,可断点续跑。**

- `execution_log` 每步加 `status`:`pending | running | succeeded | failed | skipped`。计划(`plan.json`)是步骤清单,`execution_log` 是各步实际状态,二者合起来即断点。
- 某步 tool/skill 失败时,**只把该步标 `failed` 并停在该步,不回滚已成功步骤、不整体重跑**。已产出的中间结果留在 `run-workspace`。
- MVP 的恢复方式=**人工确认后重试该步**(用户在对话里看到"第 3 步失败,重试/跳过/终止")。自动 saga / 补偿事务列为非目标(见 [§八](#八已知边界与非目标mvp-不做什么--二期触发条件))。
- 单 tool 层的瞬时错误仍由 tool manifest 的 `retry_policy` 兜底(§2.3);编排层只处理"重试耗尽后"的步骤级失败。

**①·补 执行细化(融合·MVP):停步 + 一键跳过 → 缺口透明。**

> 上一版实现把"某步失败"直接 `throw` 成整任务 `failed`,后续步骤全不执行、到不了报告合成。这是与本节"停在该步、不整体崩"原则的**实现缺口**。本补节把原则落成可运行机制,恢复动作 MVP 只做**跳过 / 终止**,重试留二期(理由:编排层失败是 tool `retry_policy` 耗尽后的失败,再重试大概率仍失败)。

- **停步不崩**:执行遇失败步时,`execution_log` 该步标 `failed`,任务置 `paused`(新增运行态,DB `status` 无 CHECK 约束,直接用),记录 `failed_step_no`。已完成步的产出已由 `run-workspace` 逐步 `writeToolOutput` 落盘,**不丢、不回滚**。
- **两个恢复动作**(`resumePhase(taskId, action)`):
  - `skip`:失败步标 `skipped` → **从各步已落盘 output 文件重建 `toolOutputs`**(不重放前序步)→ 从 `failed_step_no + 1` 继续执行。
  - `abort`:任务置 `failed` 收尾,不产报告。
- **缺口透明**:跳过产生的失败/跳过步,其覆盖维度的数据缺口,由段4 synthesis **如实写入 `report.risks_and_open_issues`**(schema 已有该字段,无需改);reviewer 复核意见的未解决项一并沉淀于此。不得静默出"看似完整实则缺数据"的报告。
- **reviewer 回流**:复核步产出收集为 `review_notes` 喂给 synthesis(仍不改写前序结论,只影响报告的风险段)。
- **终态三分**:全步成功 → `completed`;有 `skipped`/`failed` 步但合成成功 → `completed_with_gaps`(前端显式提示"部分完成·N 步缺失");无任何成功产出(`toolOutputs` 空)→ `failed`,不硬合成(受 `research-report.findings` `minItems:1` 约束,空数据合不出合法报告)。
- **不做(YAGNI 边界)**:①不做失败步"重试"(留二期,需重放上下文);②不引入 step `required/optional` 分级(等真出现"可选步"诉求再加);③不改 skill 的 LLM 驱动执行本质。

**② LLM 非确定性治理:把 schema 校验从 tool 层扩到决策层。**

- 非确定性是 agent 稳定性的头号敌人:同一需求两次跑可能激活不同节点、选不同 skill。目前 schema 强校验只覆盖 tool 输入输出,**必须扩到 LLM 的结构化输出**——ResearchTask、决策节点状态、执行计划都要过对应 schema,不合规则**自动重试**(重试仍失败则降级为 `need_clarify` 交人工)。
- `evals/`(每个 skill 交付包已含,§2.3)**进 CI 做回归门禁**:skill 或其 prompt 更新时跑该 skill 的 eval,**退化则拦住合并**。没有 eval gate,skill 一改就可能悄悄劣化,历史无法回归。
- **计划确认硬闸门本身就是对非确定性的人工兜底**——LLM 选错 skill、漏激活节点,用户在段2 就能改,而不是等错误产出后追责。

**③ 审批闭环:把 `need_approval` 从"状态"落成"流程"。**

Q3/Q8 定义了 `need_approval` 状态和 `approver` 角色,这里补执行细节:

- approver 在门户 / 咚咚 Bot 的**审批卡**上操作(通过 / 拒绝 + 理由),不是线下口头确认。
- **超时默认保持 `blocked`、绝不自动放行**——安全闸门宁可卡住也不误放。
- 拒绝 → 对应步骤置 `blocked` 并记 `reason`,任务停在该步等重新规划。
- 每个审批动作(谁、何时、通过/拒绝、理由)写入 `execution_log`,与其它步骤同源可复盘。

---

## 三、数据库:16 张 → MVP 5 张

AI 方案最严重的错误:**把配置塞进了 DB**。`skills / skill_versions / tools / skill_tool_bindings / decision_nodes` 这 5 张全是配置,应放 git+YAML(可 review / diff / 回滚),入 DB 反丢版本管理。

DB 只存**运行时数据**(这一次任务发生了什么):

| MVP 必做(5 张) | 存什么 | 服务目的 |
|---|---|---|
| `research_tasks` | `owner_user_id`(发起人,§三·补三)+ 用户原话 + 结构化理解结果 + 飞书行 ID 引用 + assumptions + approval_state + run_workspace_uri + conversation_id(会话关联,增补 C) | 复盘 |
| `task_decision_states` | 本次激活的决策节点各判成什么状态、为什么(reason/confidence) + 用户修正 + 最终状态 | **调度复盘核心** |
| `execution_log` | 每步调了哪个 skill/tool、输入输出、耗时、来源标注 + 步骤 `status`(§2.5)+ `tokens`(为二期成本核算留数据,见 §八)+ manifest_refs/hash/snapshot + context_manifest_ref | 复盘 |
| `artifacts` | 最终报告/方案(report 是 artifact 的一种,**不单开 research_reports**) | 沉淀 |
| `user_feedback` | 是否采纳 + 评分 + 文本 | 优化下次调度 |

| 二期加 | 触发条件 |
|---|---|
| `knowledge_items` + `knowledge_embeddings`(pgvector) | 要"案例语义检索"时,MVP 跑通后再上 |
| `skill_evaluations` | MVP 先用 `user_feedback` 覆盖,后期拆细 |
| `runtime_snapshots` | 如果审计要求更强,再把每次执行的 manifest/tool/prompt 快照独立成表 |
| `failure_events` | 如果失败分析需要看板化,再把 `failures.jsonl` 同步入库 |

**项目进度看板**:需求文档明说接飞书多维表格(`doc/用户研究 AI 专项 · 交付管理文档.md:84,233`)。**飞书是看板真相源**,不在 PG 重复造;PG `research_tasks` 存飞书行 ID 引用即可。

**存储选型**:PostgreSQL(结构化)MVP 足够;pgvector 二期开启;对象存储放报告附件/录音转写/设计稿截图。

**版本追溯底线:** 即使 MVP 不建 `skill_versions` 配置表,也必须在 `execution_log` 或 `artifacts.source_refs_json` 里记录:

```text
config_git_commit
decision_graph_hash
skill_manifest_hashes
tool_manifest_hashes
prompt_version/hash
model_name / model_version
```

这不是过度设计,这是复盘底线。没有这些字段,历史任务无法解释,也无法做质量回归。

**表间关系与关键索引(不能全推给 DDL 阶段——关系设计错了会返工):**

- **归属主线**:ERP 用户(§三·补三,不自建用户表则以 `owner_user_id` 落地)`1→N` `research_tasks`;`research_tasks` `1→N` `task_decision_states` / `execution_log` / `artifacts`,子表统一挂外键 `task_id`;`user_feedback` `N→1` `research_tasks`;会话表(增补 C)`1→N` `research_tasks`(一次会话可派生多任务)。
- **关键索引(按真实查询建,不多不少)**:
  - `research_tasks(owner_user_id, created_at DESC)` —— 支撑 demo 历史任务侧边栏"我的任务倒序"。
  - `execution_log(task_id, status)` —— 支撑 §2.5 断点续跑"找到失败/未完成的那一步"。
  - `task_decision_states(task_id)` / `artifacts(task_id)` / `user_feedback(task_id)` —— 外键 + 按任务聚合查询。
- **对象存储 vs PG 分工**:大对象(录音转写 / 设计稿截图 / tool 原始输出)进对象存储,PG 只存 `uri` 引用与元数据,**不在 PG 存 blob**;`run_workspace`(§2.4)同理只留 `run_workspace_uri`。

---

## 三·补 · 知识库建设协议

**先厘清"记忆"这个糊词——本项目有三层记忆,别混:**

1. **运行记忆** = Research Memory DB(本次任务流水:决策/执行/产物/反馈),用于**复盘**——已在 §三 设计。
2. **经验记忆** = `knowledge-base/`(可复用的方法/案例/模板,是 RAG 的知识源),用于**任务理解与报告参照**——本节设计。
3. **会话记忆** = 跨轮对话 + 用户历史任务关联,用于**多轮澄清与"接着上次继续"**——**原方案缺失,MVP 要补最小版**(见下方"会话记忆最小设计")。

三者不能混:运行记忆是"这一次发生了什么",经验记忆是"以往沉淀的可复用知识",会话记忆是"这个人和系统聊到哪了"。下表先对比前两层(可复用经验 vs 本次流水):

| 类型 | 存什么 | 更新方式 | 用途 |
|---|---|---|---|
| `knowledge-base/`(经验记忆) | 方法论、历史案例、人群标签、术语表、报告模板、正反例、团队能力说明 | Git review + owner 审核 | 给 LLM 做任务理解、案例参照和报告生成 |
| Research Memory DB(运行记忆) | 用户原话、结构化任务、决策状态、执行日志、产物、反馈 | 运行时自动写入 | 复盘这一次任务发生了什么 |

**会话记忆最小设计(第三层):** MVP 增最小会话持久化——`conversations`(会话 id + `owner_user_id` + 关联的 `research_tasks`)与 `messages`(多轮对话逐条),或简化为 `research_tasks.conversation_id` + 一张 `messages`。`resume` 时读会话表 + `run_workspace`(§2.4)恢复,**不把完整历史塞进 context**(呼应 §2.4 少上下文,只取摘要)。这样 DB 从 MVP 5 张变为 **5 + 1~2 张会话表**;**若 §九 最终选 LangGraph 类框架,其原生 checkpointer 直接充当会话持久化,这 1~2 张表可省**。

**明确不上 mem0 / Letta / MemGPT 这类记忆框架**:它们解决"长期自适应记忆 / agent 自我进化",本项目 MVP 不需要,上了是过度工程(YAGNI)。有"跨任务记住用户偏好、自动积累画像"的真实需求时再评估(记入 §八)。

**MVP 不建重型知识图谱。** 先用 Markdown/YAML 做知识源文件,Git 管版本;等案例检索成为瓶颈后,再把条目同步到 `knowledge_items` + `knowledge_embeddings`(pgvector)。一开始就上图谱、Milvus、复杂标签体系,会拖慢主链路。

**MVP 没有向量,靠什么把知识喂给 LLM?**(不写清这条,"引用历史案例"在 MVP 就是空的。)三招足够,都不需要 embedding:

1. **结构化过滤**:每条知识带 `metadata`(`domain` / `tags` / `type`,见下方),按当前 ResearchTask 的 `task_type` / `business_domain` 直接筛出候选——这是 MVP 主力。
2. **少量全量摘要进 context**:MVP 知识条目本就少(3-5 案例 + 模板 + 术语),命中后可把候选条目摘要**全量**读进上下文,和"数十个 skill 可一次读完"同理。
3. **关键词 / BM25 兜底**:标题、tags、正文关键词匹配,补结构化过滤的漏网。

到"条目上百、结构化过滤召回不准"成为真实瓶颈时,再升 pgvector 语义召回(触发条件已在 §三"二期加")。无论哪招,知识条目进 context 都必须带来源与 hash(呼应 §2.4 context linter 的来源要求),报告里据此标注来源。

建议目录:

```text
knowledge-base/
├── methods/                 # 用研方法论、研究设计流程、判断标准
├── personas/                # 人群标签、用户分层、业务人群定义
├── cases/                   # 历史案例、优秀报告、失败案例
├── templates/               # 研究计划、访谈提纲、报告模板
├── terminology/             # 术语表、业务词典、同义词
├── capability-docs/         # 各团队能力说明,与 skill manifest 互相引用
└── governance/              # 入库、脱敏、审核、废弃规则
```

每条知识必须带 metadata,否则后续无法检索、审计和废弃:

```yaml
id: case_live_competitive_001
type: case                  # method | persona | case | template | term | capability
domain: live_commerce
tags: [competitive_research, user_experience, digital_human]
owner: 用户研究团队
source: feishu/wiki/report
status: approved            # draft | approved | deprecated
sensitivity: internal       # public | internal | confidential
created_at: 2026-07-07
updated_at: 2026-07-07
expires_at: 2027-07-07
```

**知识入库流程:**

```text
历史报告 / Wiki / 飞书 / 会议纪要 / skill 文档
  → 清洗和脱敏
  → 转成标准 Markdown
  → 补 metadata
  → owner 审核
  → 进入 knowledge-base
  → 二期生成 embedding
  → Orchestrator 检索使用
  → 报告中标注来源
```

**运行时使用方式:**

1. 任务理解时,检索术语表、人群标签和方法论,帮助 LLM 正确解释用户输入。
2. 计划生成时,检索历史案例和能力说明,辅助选择 skill/tool。
3. 报告生成时,引用模板、案例和方法论,但必须标注来源。
4. 用户反馈后,高质量产物可以由 reviewer 一键标记为"候选知识",进入审核队列,不能自动进正式知识库。

**MVP 最小知识闭环:**

- 先放 3 类内容:方法模板、3-5 个高质量案例、术语/人群标签。
- 每个首批 skill 至少绑定 1 个方法条目或案例条目。
- 最终报告必须区分来源:用户输入 / 知识库 / Tool 结果 / LLM 推断 / 待人工确认。
- 暂不做自动学习,只做人工审核后沉淀。

---

## 三·补二 · 数据安全与合规基线(MVP 做分级+脱敏,不设出域硬红线)

**为什么这块不能推迟:** 用户之声=真实用户声音,人群标签=真实用户画像,都涉及真实用户数据。需求文档没写安全要求,**不等于可以不做**——数据分级与最小脱敏是全案里"需求没提但仍应在 MVP 落地"的一条基线。深度上只做分级+脱敏+一条 linter,不做完整合规评审平台。**注:模型可走 Claude / OpenAI 等外部 SDK,不设"禁止出域"硬红线**;出域与否按数据分级 + 企业合规通道决定(见③)。

**① 数据分级:** 复用知识库已有的 `sensitivity` 词表(`public | internal | confidential`,见 §三·补),扩展到 `research_task` 与所有 tool 输出;涉及个人身份的字段额外打 `pii: true` 标记。分级是后续所有安全判断的依据。

**② LLM 可见性:原始敏感数据默认不进 prompt(最小化基线,与出域无关都值得做)。** PII 与 `confidential` 业务数据**默认先经** tool adapter 的 `redaction_policy`(§2.3,`pii: mask` / `sensitive_business_data: block`)脱敏,脱敏后的摘要才回编排上下文——即便走内网模型,最小化进入 LLM 的敏感数据也是好实践。业务确有必要用原始数据时,由 `approver` 审批放行(§2.5)。

**③ 出域按分级 + 合规通道(软约束,联动 [Q5](#待明确开放项q1q15--进开发前评审拍板) / [Q14](#待明确开放项q1q15--进开发前评审拍板)):** 模型底座可选外部 SDK(Claude / OpenAI)或内网端点。是否允许某级数据出域,**由企业合规通道 + 数据分级共同决定,不在本方案写死**:走已签约/私有化/合规代理通道时 `internal` 乃至更高数据可依约出域;无合规通道兜底时,`confidential` / `pii` 建议留在内网端点。工程团队按实际签约的通道确认策略(Q5/Q14)。

**④ 落成校验器:** §2.4 的 `context linter` 增加一类检查——上下文中的 PII / `confidential` 数据已按策略脱敏或已获审批放行。仍是 4 个校验器,只是 `context linter` 多担一类安全检查(§2.4 表、§七 第 10 项同步)。能机器拦的规则不靠人自觉。

---

## 三·补三 · 用户与权限系统(MVP 最小集,不可推迟)

**为什么 MVP 就要有:** 运行载体是**门户 + 咚咚 Bot = 多用户系统**,但当前 `research_tasks` 没有任何用户归属字段。缺 `user_id` 是连锁塌方:demo 的"历史任务侧边栏"不知道该显示谁的任务、owner/reviewer/approver 三角色(§2.2)无法映射到真实账号、审批闭环(§2.5)没有具体的人可审、数据隔离无从谈起。这不是"锦上添花的账号功能",是多用户系统跑起来的地基。深度上只做最小集,不做完整 IAM。

**MVP 最小集:**

- **登录接京东 ERP / SSO**:与 o2 等内部体系一致,拿到稳定 `user_id`(ERP 账号)。不自建账号密码体系。
- **`user_id` 贯穿运行时表**:`research_tasks` 加 `owner_user_id`(任务发起人);其余 4 张表通过 `task_id` 间接归属(见 §三 表间关系)。
- **三角色映射真实账号/组**:`owner`(能力维护方)绑到团队/组;`reviewer`(本次确认人)、`approver`(高风险审批人)绑到具体 ERP 账号或组;`approver_rule`(none/owner/security/legal,§2.3)据此解析出"该找谁审批",让 §2.5 的审批卡有明确接收人。
- **数据可见性(最小)**:默认"本人 + 同组可见";`confidential` 任务(§三·补二 分级)限本人 + approver 可见。

**非目标(记入 §八,有需求再上):** 多租户隔离、细粒度 RBAC、组织架构树同步、按字段级权限。MVP 只要"认得出人 + 任务归属 + 三角色能落到账号"即可。

登录与账号体系的具体对接协议(ERP SSO 形态)须工程团队确认——列为 **Q15**。

---

## 四、目录结构(建议)

配置 + 内容 = 一个 git 仓库;后端代码可同仓 `apps/` 或独立仓,按工程团队习惯。

```
用研专项/
├── knowledge-base/          # 第1层:纯文件,可复用经验
│   ├── methods/             #   方法论/研究流程/判断标准
│   ├── personas/            #   人群标签/用户分层
│   ├── cases/               #   历史案例/优秀报告/失败案例
│   ├── templates/           #   研究计划/访谈提纲/报告模板
│   ├── terminology/         #   术语表/业务词典
│   └── capability-docs/     #   团队能力说明
├── skills/                  # 第2层:各团队交付的 skill 文件夹(SKILL.md + manifest + 6件套)
│   ├── shared/              #   共用模板 + research-report-schema
│   ├── research-flow/       #   research-kickoff / method-selection / data-collection / report-generation ...
│   ├── competitive-analysis/# ui / function / business / digital-human competitive
│   ├── user-voice/          #   voc-monitoring ...
│   ├── design-audit/        #   ui-audit / audience-audit / eye-tracking-audit
│   └── design-analytics/    #   用户旅程 / 可用性 / AB
├── tools/                   # 第2层补充:可执行动作,o2/API/MCP/script 适配声明
│   ├── o2-web-search/
│   ├── competitor-page-capture/
│   └── voc-data-query/
├── orchestrator/            # 第3层:调度中心
│   ├── research-orchestrator/SKILL.md   # 决策树的"活"载体
│   ├── decision-graph.yaml              # 决策节点池:节点含 applies_to/tier,状态见 §2.1(6 态)
│   ├── skill-registry.yaml              # 所有 skill 的轻量索引卡
│   ├── tool-registry.yaml               # 所有 tool 的轻量索引卡
│   └── prompts/{planner,router,synthesis}.md
├── harness/                 # Harness 工程约束
│   ├── linters/             #   registry/risk/report/context 校验器
│   ├── context-slots.yaml   #   上下文分槽与预算
│   └── reviewer-rules.md    #   高风险独立 reviewer 规则
├── run-workspaces/          # 运行期工作区模板或本地开发目录;生产可映射到对象存储
├── schemas/                 # 三件套:research-task / skill-manifest / research-report(+ decision-state / tool-manifest)
├── database/                # migrations + seed(5 张运行时表 + 视 §九 选型的会话表,见 §三·补)
├── apps/                    # 第3组件后端
│   ├── agent-api/           #   统一入口(门户 + 咚咚Bot)
│   └── orchestrator-runtime/#   统一编排运行时(封装 llm-client + tool-adapter,不硬绑单一 SDK)
└── feedback/                # 第4层:飞书同步脚本 + skill 迭代记录约定
```

---

## 五、一次完整运行流程 · 计划-确认-执行(四段协作流)

**范式(演进后):** 系统不是"单向摊开思考过程一路跑到底",而是与用户协作——**先出计划,用户确认,再自动执行,最后交付可落地方案**。计划确认是一道**硬闸门**:未确认不执行。

```
0  用户在门户/咚咚 输入一句话 → agent-api 建 research_task,创建 run workspace,开会话

【段1 · 任务理解】
1  Orchestrator 装载 orchestrator skill → LLM 把一句话转成 ResearchTask
   （结构化:task_type / business_domain / research_goal;缺失信息分级处理）
   ※ 识别层由 LLM 承担(见 §一说明);demo 的关键词匹配仅前端原型示意

   缺失信息分三级:
   - 可假设:竞品默认清单、默认报告格式、默认时间窗口。写入 assumptions,允许用户确认或修改。
   - 需确认:研究目标、目标用户、样本规模、研究周期。进入计划确认页,用户必须确认或接受系统建议。
   - 必须阻断:敏感数据授权、高风险 tool、隐私/合规边界、外部发布。进入 need_approval 或 blocked。

   ※ 有限轮多轮澄清(保持 KISS):真实用研需求一句话常说不清。默认仍走"假设可改"的单轮——把"需确认"信息作为可改假设塞进段2 计划,不打断。**仅当关键信息(研究目标 / 目标用户)严重缺失、连合理假设都给不出时,才在段1↔段2 之间发起最多 1-2 轮追问**,不做无限对话。追问轮次写入会话记忆(§三·补 第三层)。

【段2 · 待执行计划】← 核心闸门
2  按 task_type 从决策节点池激活相关子集(略过无关节点,不做"7 节点逐一打状态")
3  读 skill-registry + tool-registry 的轻量索引,规则粗筛候选 skill/tool
4  渐进加载候选 SKILL.md,由 LLM 精选出计划步骤(每步绑定要调用的 skill/tool)
5  向用户呈现人话计划:编号步骤 + 每步调用的能力 + 系统假设(缺失信息代填,可点击改)
6  将待确认计划写入 run-workspaces/{task_id}/plan.json
7  ⏸ 等待用户【确认计划】——未确认不进入执行

【段3 · 执行】(用户确认后)
8  按计划逐步执行:命中的 skill/tool 由系统【直接自动调用】
   （执行期再按需加载 schema/examples/templates/tool adapter,不在计划阶段全量塞入上下文）
   （tool 在系统中配置好且通过权限/风险校验才调用,不把普通能力导流给人)
   每步写 execution_log + context_manifest;need_annotate 写入风险区,不阻塞执行;need_approval 必须审批后执行;blocked 直接停止对应步骤并说明原因
   失败写入 failures.jsonl,可从 context_manifest_ref 回放

【段4 · 交付】
9  synthesis 汇总为可落地方案:研究目标 / 执行流程+时间线 / 产出物清单 / 能力编排
   （结论带来源标注:用户输入 / 历史案例 / Tool 结果 / LLM 推断 / 待人工确认）
10 report linter 校验产出符合 research-report.schema 且来源完整;存 artifacts
11 返回方案 + 采纳/导出/沉淀 Wiki 入口;开放 user_feedback
```

**关键特性:**
- **计划确认是硬闸门**:用户可在段2改假设或修改需求,确认后才执行——真正的"人在环",而非事后被动追问。
- **能力默认自动调用,高风险例外**:段3 命中的普通能力由系统直接调用;高风险 tool、敏感数据、对外发布产物必须走 approver。
- **缺失信息分级处理**:可假设的信息不打断流程;需确认的信息进入确认页;必须阻断的信息不允许执行。
- **跨会话恢复**:用户关掉页面后,可从历史任务侧边栏点回,读会话记忆(§三·补 第三层)+ `run_workspace`(§2.4)恢复到当时的段2/段3 继续——依赖用户系统(§三·补三 归属)与断点续跑(§2.5),不是纯前端状态。
- 决策节点池按需激活,简单任务轻装直达,复杂任务才启动全套护栏。

---

## 五·补 · 前端形态(交互参考基线)

界面参考 [用研AI专项_前台页面demo.html](/Users/heyunshen/work/PROJECT/jdc/ai-x/doc/用研AI专项_前台页面demo.html) 的交互形态,但 demo 是**交互参考基线**,不是代码基线,也不是最终视觉规范。**一句话:一个 ChatGPT 式的对话工作台,把"计划→确认→执行→交付"四段流渲染成可交互的对话回合。**

### 布局(三区)

```
┌────────────┬──────────────────────────────────────┐
│ 左侧栏 264px│  主对话区(max-width 860px 居中)      │
│            │                                       │
│ + 新建任务  │   欢迎态:居中欢迎语 + 3 个建议 chip   │
│            │   ——无输入时不泄露任何任务类型/决策   │
│ 历史任务    │                                       │
│  · 直播…    │   运行后:用户气泡(右) + 系统回答(左)│
│  · 竞品…    │     段1 任务理解(诚实标注)          │
│  · 商详…    │     段2 待执行计划(可改假设+确认钮)  │
│            │     段3 执行进度(能力自动调用)       │
│ 能力库 ▸    │     段4 最终方案(时间线/产出物/编排) │
│ 案例库 ▸    │     └ 全链路留痕 DB(折叠)            │
│ ───────    │                                       │
│ 主原则脚注  │   底部:sticky 输入框                  │
└────────────┴──────────────────────────────────────┘
```

### 视觉基调(不锁死主题)

- **专业可读优先**:正式视觉可由设计团队决定,不把暗色科技风写成硬规则。
- **语义色必须稳定**:决策/执行状态用一套固定语义色——完成、进行、需补充、需审批、阻断要能一眼区分。skill / tool 用不同徽章色区分。
- **来源标注色**:方案里每条结论带来源 tag(用户输入 / 历史案例 / Tool 结果 / LLM 推断 / 待人工确认),颜色对应语义。
- **等宽字体**:能力 id、schema 文件名、DB 表名用等宽字体,强化"这是配置/数据"的观感。

### 交互要点(与四段流对应)

- **渐进披露**:无输入 → 只有欢迎态;识别意图 → 先出"识别中…"过渡;再逐块展开四段。段与段之间**由用户确认驱动**,不是纯定时动画。
- **计划确认是硬闸门**:段2 底部"✓ 确认计划,开始执行"主按钮;假设条目可点击就地编辑;未确认不进入段3。
- **能力自动调用可视**:段3 每步"调用中→完成";tool 步骤标 `TOOL` 徽章、skill 标 `SKILL`;高风险步骤(need_approval)显示审批态。
- **去人名**:界面全程不出现个人姓名;最终方案的"能力编排"列 skill/tool id + 用途,owner 仅在能力库作为"维护方"出现。

### 落地约束

- **跨端复用协议,不强行复用组件**:门户与咚咚 Bot 复用同一套对话消息 schema、计划卡片数据结构、执行状态模型和报告结构;Web 端与 Bot 端各自适配 UI。
- **无障碍基线**:`focus-visible` 焦点环、`aria-live` 播报回答推进、`prefers-reduced-motion` 降级、语义化标签 + 跳转链接。
- **技术栈不限定**:正式实现可用团队熟悉的框架(React/Vue 皆可),但须保持上述布局、四段流、渐进披露与无障碍基线。

---

## 六、分阶段落地(对齐 W28–W36 里程碑)

- **试点期(7月)**:交付 `schemas/` 三件套 + `decision-graph.yaml` + `skill-registry.yaml` + `tool-registry.yaml` + `research-orchestrator/SKILL.md` + `harness/linters` 最小集 + 5 张核心表 DDL + 最小 `knowledge-base/`。跑通"一句话 → 方案初稿",半自动、人可干预。用 1 个已建好的 skill(如 B8 design-audit)和 1 个低风险 tool 接入验证。

- **存量能力迁移(贯穿试点→打包,单列因为它是本项目真正的成本大头)**:项目核心目标是"聚合孤岛",但 10 个团队的 skill 散在设计 wiki / 各团队,**基本都没有 manifest / schema / eval**,不符合 §2.3 接入协议。"聚合"的真实成本主要在**把存量能力改造成合规包**,不在搭骨架——原始能力越多,这块越重。落地策略:
  - **MVP 不要求全迁**:平台方 + 1–2 个种子团队,把 1–2 个存量 skill 手工改造成合规交付包,过程沉淀成**"迁移 checklist + skill 模板"**,让后续团队照着填而不是从零理解协议。
  - **分级登记降低门槛**:存量能力可先以 `status: draft` 占位登记(只填 `name / path / owner`),**补齐 manifest / schema / eval 后才升 `active`、才可被自动调用**。draft 能力对用户不可见、不参与路由,只作迁移待办。
  - 打包期再把迁移铺开到 10 个团队,用试点期沉淀的 checklist + 模板批量推进。

- **打包期(8月)**:各团队 skill/tool 按 manifest 标准入 registry;run workspace + context manifest + failures.jsonl 落地;`agent-api` + `orchestrator-runtime` 上线。
- **推广期(8月后)**:门户 + 咚咚 Bot 入口;pgvector 案例检索;飞书看板同步;skill/tool 评估闭环;后台文档园丁/规则园丁开始扫描失败记录和过期知识。

---

## 七、待工程团队产出的骨架清单(交付物)

MVP 阶段按此清单落地,均为可 review 的文件/配置,非运行时黑盒:

1. `schemas/research-task.schema.json` — 用户需求如何结构化;含 `assumptions[]`(可改假设)、`confirmations[]`(需用户确认)、`blocking_issues[]`(必须阻断)
2. `schemas/skill-manifest.schema.json` — skill 如何被发现/选择/调用/评估(`owner` = 维护方/团队)
3. `schemas/tool-manifest.schema.json` — tool 如何声明与配置化调用(adapter 优先级:o2 → 内部 API/MCP → 脚本;含 auth_required / risk_level / approver_rule)
4. `schemas/research-report.schema.json` — 标准报告结构(对齐交付物 A2);扩字段 `timeline`(执行流程+周次)/ `deliverables`(产出物清单)/ `capability_orchestration`(能力编排:调用了哪些 skill/tool)
5. `orchestrator/decision-graph.yaml` — 决策节点池,每节点含 `applies_to` + `tier(core/optional)` + 触发规则 + `risk_policy`
6. `orchestrator/skill-registry.yaml` — skill 轻量索引卡 + 1 个样例 skill
7. `orchestrator/tool-registry.yaml` — tool 轻量索引卡 + 1 个低风险样例 tool
8. `knowledge-base/` — 最小知识包(methods + templates + 3-5 个脱敏案例 + terminology)
9. `harness/context-slots.yaml` — 上下文分槽、预算和来源要求
10. `harness/linters/*` — registry/risk/report/context 四类校验器(`context linter` 含 §三·补二 的 PII/脱敏安全检查)
11. `run-workspaces/{task_id}/` 模板 — plan/context_manifest/tool_outputs/failures/artifacts 约定
12. `orchestrator/research-orchestrator/SKILL.md` — 编排主 skill(任务理解 → 计划 → 确认 → 执行 → 交付 的四段 prompt)
13. `database/migrations/*.sql` — 5 张运行时表 DDL + 配置/运行时边界说明 + manifest hash / prompt hash / model version 追溯字段
14. `apps/agent-api` + `apps/orchestrator-runtime` — 薄后端(打包期)。注意 `orchestrator-runtime` 只是**不含业务判断**,其工作量并不小:LLM 调用、四类 adapter 集成(MVP 仅 o2)、schema 校验、重试、审计、context_manifest、failures 回放都在这里,是全清单里最重的一项,须单独排期。
15. **存量 skill 迁移 checklist + skill 模板** — 试点期由平台方 + 种子团队改造 1–2 个存量能力时沉淀(见 §六),供后续 10 团队照填接入,是"聚合孤岛"能否铺开的关键交付物。

---

## 验证方式(MVP 端到端)

1. **schema 校验**:用一条真实需求("我要为直播场域做一次用户体验研究")手工构造 ResearchTask,跑 JSON Schema 校验通过。
2. **决策节点池空跑**:喂该 ResearchTask 给 orchestrator skill(可先在 Claude Code / Agent SDK 里本地跑),检查 task_type 分流后**只激活相关节点子集**(如竞品任务不激活 D2/D4),激活节点的状态 + reason 合理,且能命中 registry 里的 skill。
3. **计划-确认闸门**:确认前不执行;用户改假设后计划相应更新(见 Q4)。
4. **缺失信息分级**:同一条需求里同时构造可假设、需确认、必须阻断三类输入,验证状态和 UI 提示不同。
5. **高风险 tool 拦截**:构造一个 auth_required + high risk tool,确认未审批前不执行,审批后才写入 execution_log。
6. **单 skill 接入**:用 B8 design-audit 走通"选中→自动调用→产出符合 report schema"。
7. **Skill/Tool 接入验收**:新增一个 draft skill 和一个 draft tool,确认缺 manifest/schema 时不能进入 active;补齐后能被 registry 读取并参与路由。
8. **知识库引用验证**:放入 3 条脱敏知识条目,确认计划和报告能引用知识库内容,且最终报告标清来源。
9. **Harness linter 验证**:构造 4 类失败样例,缺 registry 字段、高风险 tool 无审批、报告无来源、上下文超预算,确认都能被拦截且错误信息说明正确做法。
10. **失败回放验证**:强制制造一次 tool 失败,确认 `failures.jsonl`、`context_manifest.json`、`execution_log.context_manifest_ref` 能复盘当时加载了什么、选了什么、为什么失败。
11. **入库回看**:确认 `research_tasks / task_decision_states / execution_log / artifacts` 四表有对应记录,能回答"为什么这次选了 X skill、没激活 Y",也能看到 manifest hash / prompt hash / model version。
12. **反馈闭环**:提交一条 `user_feedback`,确认可被下次调度读取(MVP 可仅存储,不必自动优化)。

---

## 八、已知边界与非目标(MVP 不做什么 + 二期触发条件)

诚实声明 MVP 的能力边界,避免把"没做"误读成"做好了"。**这里的性能空白是主动取舍,不是疏漏**——需求文档未给任何量化非功能指标(并发 / 延迟 / SLA 均未提),按 YAGNI 不提前做性能工程;但边界要写明,生产化前必须回来补。

| 维度 | MVP 现状 | 为什么现在不做 | 二期触发条件 |
|---|---|---|---|
| **端到端延迟** | 一次运行 = 多轮串行 LLM + 串行 tool(tool 单次 timeout 60s),中等任务**分钟级**。MVP 只做**段间流式反馈**(执行进度实时可见),不做延迟预算和并行编排 | 需求无延迟/SLA 指标;流式反馈已能消除"卡死"观感,够试点 | 出现延迟投诉,或单任务耗时影响可用 → 做步骤并行、计划级并发 |
| **并发** | 单实例串行处理,无排队/限流模型 | 需求无并发量级;试点用户少 | 用户量上升、出现排队等待 → 做队列 + 限流 + LLM 网关配额管理 |
| **成本** | 不做 token 成本模型;但 `execution_log` 记 `tokens` 字段留数据 | 需求无预算约束;先跑通再谈省钱 | 成本失控或需成本归因 → 基于 `tokens` 做成本看板 |

**其余非目标**(已在前文散落,此处汇总不重复展开):自动 saga / 补偿事务(§2.5,MVP 用人工重试)、skill 自动学习(§三·补,MVP 只人工审核沉淀)、多 Agent 互审(§2.4,MVP 只高风险单 reviewer)、pgvector 语义召回(§三,skill 上百或案例检索成瓶颈才上)、**能力间复杂编排 / 并行 DAG 引擎**(MVP 只支持线性步骤计划,能力依赖靠 LLM 在段2 计划里展开;有真实复杂依赖、或 §九 选了 LangGraph 类框架后,用框架原生图能力,不自建 DAG 引擎)、**长期自适应记忆框架 mem0/Letta/MemGPT**(§三·补,MVP 只做会话持久化)、**多租户 / 细粒度 RBAC / 组织架构同步**(§三·补三,MVP 只做 user_id 归属 + 三角色映射)。

**判断准则:** 上述每一项,只要**没有真实信号**(投诉、量级、预算、审计要求)就不提前做;有信号了再按触发条件启动。这与全案 KISS/YAGNI 主原则一致。

---

## 九、技术底座选型:不要从零手搓 agent 循环(本轮最重要的再评估)

**这是全案最该在开发前想清楚、却最容易被跳过的一步。** 前面 §一 把后端砍成"薄壳 + orchestrator-runtime",但 §2.5 / 补丁已暴露 runtime 要自建的东西很多:LLM 调用循环、tool adapter、schema 校验、重试、状态流转、`context_manifest` 生成、失败回放、subagent 调度、会话持久化。

**关键观察:这些几乎逐条对应成熟 agent 框架的原生能力。** 而本方案的 `SKILL.md` 渐进加载、`1 Agent + N Skill`、hooks 式护栏、permission 闸门,本就是照成熟 agent 框架的范式设计的。若再从零手写一遍,等于**"照着 SDK 的样子,再手搓一个 SDK"**——这是重复造轮子的典型信号,也是最大的隐性工作量与 bug 来源。**结论先行:应优先在成熟框架上搭,而不是自建;自建仅作兜底。**

**候选对比(结论基于官方文档实证):** 可选的成熟底座都是**通用 LLM / agent 开发框架**——`pi`、Claude Agent SDK、OpenAI Agents SDK、LangGraph 类都属此列(`pi` 是 LLM/agent 开发调用框架,不是"编码工具";此前把它归为 coding 运行时是笔者的误判,特此更正)。下表列几个能力与生态成熟、文档可查的代表做对比;`pi` 及其它同类框架同样可纳入评估,判据一致(模型灵活度 / 原生能力 / 自托管)。数据出域不再是硬约束(见 §三·补二),故矩阵按这三项比较:

| 候选 | 模型灵活度 | 原生能力覆盖 | 自托管 | 评价 |
|---|---|---|---|---|
| **Claude Agent SDK** | 绑 Anthropic 系(Claude API / Bedrock / Vertex / Azure 上的 Claude) | 最高:subagents / skills / hooks / MCP / permissions / **sessions(resume+fork)** / context 管理,几乎=本方案全部所需 | 库形态,跑在自己进程 | 范式与本方案最贴合(SKILL/hooks/subagent 一一对应),接入成本最低;代价是模型绑定 Anthropic |
| **OpenAI Agents SDK** | **模型无关**(原生 LiteLLM / Any-LLM adapter,可接非 OpenAI 及内网端点) | 高:agent loop / handoffs / guardrails / **sessions** / tracing / human-in-the-loop / MCP | 库形态,orchestration 本地跑;tracing 可换 processor | 能力全、模型可换;Python 为主(TS 另有生态) |
| **模型无关编排框架(LangGraph 类)** | **模型无关**(接任意内网 / OpenAI 兼容端点) | 高:持久化 / checkpointing、HITL、跨会话 memory、streaming、断点续跑——**正好补本方案缺的稳定性与会话层** | 是(OSS,无强制云依赖) | 最灵活、白送方案缺口能力;代价是接受其状态图心智模型,agent 语义要自己组织 |
| **纯自建 runtime / 网关裸调** | 完全自定 | 全靠自己写 | 是 | 最大可控,但把框架已解决的持久化 / HITL / 会话 / 重试全部重造,工作量与 bug 风险最高 |

**推荐倾向(非最终拍板,须工程团队按实际情况定):** 出域红线取消后,不存在"某框架不可行"的硬判定,选型退回一道**工程权衡题**,主要看一个问题——**愿不愿意把模型绑定单一厂商**:

1. **愿绑 Anthropic、追求最低接入成本 → Claude Agent SDK**:范式与本方案天然对齐,orchestrator-runtime 的大半能力(subagent / skills / hooks / sessions)直接白得,落地最快。
2. **要模型灵活(混用内网自研模型 + 外部模型、或未来要换)→ OpenAI Agents SDK 或 LangGraph 类**:前者 agent 语义现成、后者编排最灵活且原生补齐持久化 / 断点续跑 / 会话记忆(§2.5、§三·补三、增补 C)。
3. **纯自建仅作兜底**:只有当"候选框架都无法接入目标模型端点、或都不满足合规要求"经验证成立时才选,否则就是重复造轮子。

**开发前必须先验证的两件事(判定关键项,列为 [Q14](#待明确开放项q1q15--进开发前评审拍板),与 Q5 联动):** ① 目标框架能否接上要用的模型端点(内网自研模型走 LiteLLM/兼容层能否跑通一次 tool-calling);② 跑通一次 checkpoint / session 恢复。这两点直接决定选型,应排在所有编码工作之前。

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
| 能力调用 | 推荐 Owner / 挂人校准 | 普通能力自动调用,owner 仅维护方;高风险由 approver 审批 | 不导流普通能力,但保留安全闸门 |
| 能力接入 | 描述原则多,接入协议弱 | Skill/Tool 均以 manifest + schema + examples + evals 接入 | 新增能力不改主流程代码 |
| 知识库 | 倾向直接上向量库 | MVP 先 Markdown/YAML + metadata,二期 pgvector | 先沉淀高质量知识,再做检索平台化 |
| Harness | 主要靠 prompt 和日志 | Run workspace + context manifest + linter + failures.jsonl | 状态外置、约束可执行、失败可回放 |
| 最终产物 | 研究报告 | 方案含时间线+产出物清单+能力编排 | 可直接开工,而非半成品 |
| 复盘能力 | 只存运行结果或配置表膨胀 | 运行结果 + manifest/prompt/model 快照引用 | 既不把配置塞 DB,又能解释历史判断 |

---

## 待明确开放项(Q1–Q15 · 进开发前评审拍板)

以下为文档/demo/讨论三层都尚未定死的事项,已附推荐默认值(带理由)。评审时在此基础上确认或推翻。

> **拍板顺序:Q2 / Q5 / Q10 是地基级 P0,必须先于其余开放项定死。** 它们分别决定 tool 接入形态、LLM 运行时(连带延迟/并发/结构化输出/模型灵活度,详见 §九 / Q14)、能力上架门槛——定错会导致大面积返工,其余开放项可在其之上增量调整。

| # | 开放项 | 推荐默认值 | 理由 | 影响的交付物 |
|---|---|---|---|---|
| Q1 | 计划确认粒度:整份确认 vs 逐步骤增删 | MVP 先"整份确认 + 改假设",不做逐步骤增删 | KISS,逐步骤编辑重投入,有真实需求再加 | agent-api plan 接口 |
| Q2 | tool 真实接入形态 | 统一 tool-manifest + 适配器,优先级 o2 → 内部API/MCP → 脚本;tool-gateway 二期建 | 与"配置即真相源"一致,o2 京东内覆盖最广 | tool-manifest.schema、tool-gateway |
| Q3 | 人工确认状态如何拆 | 拆成 `need_annotate` / `need_approval` / `blocked` | 低风险结论可继续执行并标注,高风险操作必须审批,缺授权直接阻断 | decision-graph 状态集、report-schema 风险区、tool-manifest |
| Q4 | 改假设后是否重算计划 | MVP 轻量重算——仅重刷受影响的计划步骤,不整体重跑决策 | 整体重规划成本高、易困惑,轻量刷新够用 | orchestrator skill、agent-api |
| Q5 | LLM/Agent 运行时选型 **【P0 地基项,见 §九 / Q14】** | 抽象 `llm-client` 接口,底层可切内部网关、Claude API、OpenAI 或其他 Agent Runtime,不硬绑单一 SDK | 出域已按合规通道放开(§三·补二),选型退回工程权衡:此项决定端到端延迟、并发额度、结构化输出能力与模型灵活度。是地基不是普通开放项,须工程团队最先确认 | orchestrator-runtime、§九、§三·补二 |
| Q6 | MVP 首个端到端 task_type | 竞品研究优先;design-audit 走查(B8 试点中)第二 | 竞品边界最清(激活节点最少)、tool 依赖明确(o2 抓取),最易验证骨架 | 试点排期、首批 skill/tool |
| Q7 | 版本追溯粒度 | MVP 记录 Git commit + manifest hash + prompt hash + model version;审计加强时再建 runtime_snapshots 表 | 不建配置表也要能复盘历史判断 | execution_log、artifacts.source_refs_json |
| Q8 | 负责人语义 | `owner`=能力维护方,`reviewer`=本次任务确认人,`approver`=高风险审批人 | 防止把所有协作都混成"找负责人",也防止高风险无人兜底 | skill-manifest、tool-manifest、agent-api 审批流 |
| Q9 | 知识库首批内容范围 | 先收 methods、templates、terminology、3-5 个脱敏案例 | 知识质量比数量重要,避免一开始做低质向量垃圾场 | knowledge-base、review 流程 |
| Q10 | skill/tool 上架门槛 | 没有 manifest/schema/examples/evals 不进 active;高风险 tool 必须配置 approver_rule | 保证能力可被机器调用、可验收、可追责 | registry 校验、CI、orchestrator-runtime |
| Q11 | Run Workspace 存储形态 | MVP 本地/对象存储均可,DB 只存 `run_workspace_uri` | 大对象和中间文件不进 PG,但必须可回放 | agent-api、orchestrator-runtime、对象存储 |
| Q12 | Linter 首批范围 | registry/risk/report/context 四类先做最小可用 | 能机器拦截的规则不要只写进文档 | harness/linters、CI、tool 调用前 guard |
| Q13 | 是否新增 Reviewer Agent | MVP 不新增常驻 Reviewer Agent,只在高风险输出/工具调用时启用独立 reviewer | Agent 数量也是上下文成本,先 1 Agent + N Skill | reviewer-rules、risk_policy、审批流 |
| Q14 | 技术底座:自建 runtime vs 成熟框架 **【P0 地基项,联动 Q5】** | 用成熟框架、不自建:愿绑 Anthropic 且求最低接入成本→Claude Agent SDK;要模型灵活→OpenAI Agents SDK 或 LangGraph 类;自建仅兜底。开发前先验证"目标模型端点 × 框架"连通 + 一次 session 恢复 | runtime 要造的能力≈成熟框架原生能力,自建是重复造轮子;框架还白送持久化/断点续跑/会话记忆(见 §九) | orchestrator-runtime、§2.5、§三·补三 |
| Q15 | 用户/账号体系对接 **【P0 地基项】** | 登录接京东 ERP/SSO 拿稳定 `user_id`,`user_id` 贯穿运行时表,三角色映射 ERP 账号/组;不自建账号体系、不做多租户 | 多用户门户+Bot 的地基,无 `user_id` 则历史任务/审批/隔离全落不了地(见 §三·补三) | agent-api 登录、research_tasks 表、审批流 |
