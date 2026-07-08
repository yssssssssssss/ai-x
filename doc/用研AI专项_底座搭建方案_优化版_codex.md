# 用研 AI 专项 · Agent Harness + Skill Orchestrator 搭建方案(优化版 Codex)

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

**"薄"指不含业务判断,不是工作量小。** `orchestrator-runtime` 仍是全项目最重的工程件:装载 skill、调 LLM、接 tool adapter、做 schema 校验、重试、审计、状态流转、生成 `context_manifest`、沉淀 `failures.jsonl`。本方案砍掉的是虚层、配置表和重型 DAG 引擎,没有砍掉 runtime 与 adapter 集成的真实工作量。MVP 阶段 adapter **只实现 o2 一类**,内部 API / MCP / script 先保留协议与 manifest 字段,二期按真实需求接入。

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

### 1.1 技术底座选型:推荐 OpenAI Agents SDK,但协议不绑死

在 Claude / OpenAI / Pi 三个方向里,**MVP 推荐用 OpenAI Agents SDK 作为 Orchestrator Runtime 的第一实现**。理由不是"模型更强"这种空话,而是它更像一个产品型 agent 后端底座:官方能力覆盖 agents、tools、skills、tool search、sessions、context management、guardrails、human-in-the-loop、MCP、tracing 和 strict schema,与本项目需要的"结构化输出 + 计划确认 + 工具审批 + 会话恢复 + 审计追踪"贴合度最高。

**Claude Agent SDK 作为强备选。** Claude 的优势是 `SKILL.md`、agent loop、tool、上下文管理与 Claude Code 生态贴得很近。如果现有 skill 包已经完全按 Claude Code / Claude Agent SDK 形态建设,或团队后续主要在 Claude 生态里维护,Claude 可以作为第一实现。但对独立 Web 产品来说,仍然要先验证 session、schema、审批、tracing 与自有 DB 的集成成本。

**Pi 不建议作为生产默认底座。** Pi 的优点是开源、轻量、多 provider、支持 skills 和 compaction,很适合工程试验或内部二次开发。但对这个项目来说,核心风险不是"能不能跑 agent loop",而是长期维护、权限治理、审计、团队上手、稳定发布和企业支持。除非团队已经明确要走自研/开源可控路线,否则 Pi 放在 PoC 或二期替代底座评估里,不要压到主链路上。

最终落地方式:

```text
apps/orchestrator-runtime
├── runtime/
│   ├── agent-runtime.ts        # 封装 Claude/OpenAI/Pi 差异
│   ├── llm-client.ts           # 模型通道统一接口
│   ├── skill-loader.ts         # 读取 SKILL.md / manifest / registry
│   ├── tool-adapter.ts         # o2 / API / MCP / script 统一调用
│   └── checkpoint-store.ts     # 会话与步骤状态写 DB
```

**硬约束:** 业务代码不能直接调用 Claude / OpenAI / Pi SDK。只能依赖 `agent-runtime / llm-client / tool-adapter` 三个本项目接口。这样第一版用 OpenAI,后续因合规、成本或效果切 Claude / Pi / 内部模型,不会重写 skill、DB、前台页面和执行日志。

进开发前必须做 1 个 3-5 天 spike,只验证 6 件事:

1. 能否加载本项目 `SKILL.md` 并按需读取相关资源。
2. 能否稳定输出 `ResearchTask / Plan / DecisionState / Report` JSON schema。
3. 能否接入一个 `o2` tool adapter 并记录输入输出。
4. 能否把每轮消息、计划、步骤状态和 artifact 写入 DB。
5. 能否在 tool 调用前执行 context linter 与 approval gate。
6. 能否记录 model version、prompt hash、manifest hash 和 trace id。

如果 OpenAI 在这 6 项里有任何一项需要大量绕路,切 Claude Agent SDK;如果团队明确要求开源可控和多 provider,再评估 Pi。不要三套同时接,那是制造维护债。

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

### 2.2 能力路由:渐进加载,不做规则引擎

- **核心原则:** Skill 采用渐进式加载,Tool 采用结构化 manifest。`SKILL.md` 承载能力逻辑,Tool manifest 承载执行边界,Orchestrator 只负责加载、校验、调用、留痕。不能把 `skill-registry.yaml` 写成巨大的用研规则库,否则只是把复杂性从代码搬到 YAML。
- **Skill 选择优先靠语义,不是字段匹配:** MVP 阶段只读取每个 `SKILL.md` frontmatter 的 `name / description / when_to_use` 做发现,由 LLM 判断是否相关。命中后再加载完整 `SKILL.md`,执行期再加载 schema、examples、templates、知识条目和 tool adapter。
- **skill-registry.yaml 是发现索引 + 治理索引:** 每个 skill 只登记 `id / name / path / when_to_use / status / owner / input_schema / output_schema / required_tools / risk_level` 等机器需要校验的字段。`task_types / intent_tags` 可以作为运营辅助,但不能写成硬路由规则、权重表或领域 if-else。复杂流程、详细 prompt、判断标准、失败降级和示例都留在对应 `SKILL.md` 及其引用文件里。`owner` 语义是**能力维护方/团队**(如"竞品分析组"),不是"调用时要找的人"。命中的能力默认由系统调用,不是导流找人。但真实任务仍需要区分三种人:
  - `owner`:能力维护方,负责 skill/tool 质量和升级。
  - `reviewer`:本次任务的业务/用研确认人,负责目标、样本、人群等判断校准。
  - `approver`:高风险工具、敏感数据或对外发布产物的审批人。
- **registry 可以自动生成:** 如果选定的 Agent Runtime 支持原生 skill discovery,`skill-registry.yaml` 可以由扫描 `SKILL.md` 自动生成;如果运行时不支持,平台维护轻量 registry。用户体感仍应是"提交一个合规 skill 文件夹即可接入",平台底层负责校验、索引和启停。
- **三段式路由不是 MVP 默认路径:** skill 仅数十个时,LLM 可以一次读取全部 skill 摘要并直接选择。规则粗筛 → 语义召回 → LLM 精选主要服务两类场景:tool 命中需要权限/风险预筛,或 skill 上百后需要召回优化。不要为了显得专业提前做路由引擎。
- **能力选择不必都过决策节点**:部分 skill/tool 由需求语义、tool 风险预筛或知识召回直接命中;决策节点主要管两件事——完备性把关(该问的有没有问)+ 标注需人工确认的产出。

### 2.3 Skill / Tool 接入协议(新增能力如何融入系统)

这里必须分清两件事:

- **Skill 是能力说明和工作流**:它告诉系统"这类用研问题怎么做、何时适用、需要什么输入、应该产出什么"。
- **Tool 是可执行动作**:它负责真实调用 `o2`、内部 API、MCP、脚本、数据平台或文件处理能力。

系统调用逻辑不是用户手动挑 skill,也不是后端写死分支,而是:

```text
用户需求
  → LLM 结构化为 ResearchTask
  → 读取 decision-graph / skill 摘要 / tool-registry 的轻量索引
  → 激活相关决策节点
  → LLM 基于 name / description / when_to_use 选择候选 skill
  → tool-registry 做权限、风险和可用性预筛
  → 渐进加载 2-5 个候选 SKILL.md
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
| 第一层:轻量索引 | `SKILL.md` frontmatter 或自动生成的 `skill-registry.yaml`、`tool-registry.yaml`、`decision-graph.yaml` 的摘要字段 | 发现候选能力,避免全量上下文膨胀 |
| 第二层:候选能力 | 被命中的少量 `SKILL.md` | 理解能力边界、执行步骤、输入输出和人机协作点 |
| 第三层:执行期资源 | schema、examples、templates、tool adapter、知识库条目 | 真正执行和生成可校验结果 |

这就是 agent 中常见的渐进性加载方式:先发现,再理解,最后执行。YAML 和 registry 只负责发现、治理和校验,不负责"怎么做完这件事"。

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

`skill-registry.yaml` 中只保留轻量索引。若运行时支持原生 discovery,该文件可由 `SKILL.md` 与 `manifest.yaml` 自动生成:

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

`SKILL.md` 才写能力逻辑,例如适用/不适用场景、执行步骤、默认假设、质量门禁、输出要求、失败降级和示例。这样新增 skill 时不会污染主流程,也不会把 registry 写成第二套编排引擎。`intent_tags` 和 `task_types` 只能辅助检索、统计和人工运营,不能变成硬编码路由条件。

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
5. 合并到 Git 后更新或自动生成 `skill-registry.yaml` / `tool-registry.yaml`。
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
| context linter | LLM 调用前 | 上下文超预算、加载无来源文件、加载与 task_type 无关内容、PII / `confidential` 数据未按策略脱敏、审批或留痕 |

**失败要能回放:** 每次失败写入 `failures.jsonl`,不要只留在日志里。失败记录至少包含 `task_id / stage / selected_skill / selected_tool / input_ref / output_ref / error_type / retry_count / context_manifest_ref / suggested_rule`。二期可以加一个后台"文档园丁/规则园丁"任务,定期扫描失败记录,提出 registry、prompt、linter 或知识库修正建议。

**独立 Reviewer 只用于高风险:** 不要一开始做一组互审 Agent。MVP 只在两类场景启用独立 reviewer:对外发送内容、敏感数据或高风险 tool 执行。Reviewer 只看结构化输出、来源标注、风险说明和相关规则,不看主 Agent 的完整上下文,避免复制同一个偏差。

### 2.5 运行时稳定性:失败恢复、结构化校验、审批闭环

**失败恢复:** `execution_log` 每步记录 `status`: `pending | running | succeeded | failed | skipped`。`plan.json` 是用户确认过的步骤清单,`execution_log` 是实际执行状态,两者合起来支持断点恢复。某一步 tool/skill 失败时,只把该步标为 `failed` 并停在该步,不回滚已成功步骤,不整体重跑。MVP 的恢复方式是人工确认后重试、跳过或终止该步;自动 saga 和补偿事务列为非目标。

**LLM 结构化输出也要过 schema:** schema 校验不能只覆盖 tool 输入输出。ResearchTask、决策节点状态、执行计划都必须通过对应 schema。不合规则自动重试一次;仍失败则降级为 `need_clarify`,交给用户或 reviewer 确认。每个 skill 交付包里的 `evals/` 进入 CI 回归门禁,skill 或 prompt 更新时必须跑最小 eval,退化则不合并。

**审批闭环:** `need_approval` 不能只是状态字段。approver 在门户 / 咚咚 Bot 的审批卡上操作,必须记录通过 / 拒绝和理由。审批超时默认保持 `blocked`,不自动放行。拒绝后对应步骤置为 `blocked`,任务停在该步等重新规划。审批动作写入 `execution_log`,与其它执行步骤同源复盘。

---

## 三、数据库:16 张 → MVP 8 张核心表

AI 方案最严重的错误:**把配置塞进了 DB**。`skills / skill_versions / tools / skill_tool_bindings / decision_nodes` 这 5 张全是配置,应放 git+YAML(可 review / diff / 回滚),入 DB 反丢版本管理。

DB 只存**用户、会话与运行时数据**。用户管理采用独立注册体系,**不接 ERP**;后续如要接企业 SSO,只能作为登录方式扩展,不能改变业务主键。

### 3.1 MVP 必做表

| MVP 必做(8 张) | 存什么 | 服务目的 |
|---|---|---|
| `users` | 注册用户、登录标识、角色、状态 | 用户归属、权限、审计 |
| `conversations` | 一次对话会话、标题、摘要、最后消息时间 | 历史任务、会话记忆、断点恢复 |
| `messages` | 用户/助手/系统消息、消息类型、引用 artifact | 对话回放、上下文重建 |
| `research_tasks` | 用户原话 + 结构化理解结果 + `conversation_id` + assumptions + approval_state + run_workspace_uri | 任务真相源 |
| `task_decision_states` | 本次激活的决策节点各判成什么状态、为什么(reason/confidence) + 用户修正 + 最终状态 | **调度复盘核心** |
| `execution_log` | 每步调了哪个 skill/tool、输入输出、耗时、来源标注、步骤 `status`、`tokens`、manifest_refs/hash/snapshot + context_manifest_ref | 执行审计、失败恢复 |
| `artifacts` | 最终报告/方案/附件索引(report 是 artifact 的一种,**不单开 research_reports**) | 交付物沉淀 |
| `user_feedback` | 是否采纳 + 评分 + 文本 | 优化下次调度 |

| 二期加 | 触发条件 |
|---|---|
| `knowledge_items` + `knowledge_embeddings`(pgvector) | 要"案例语义检索"时,MVP 跑通后再上 |
| `skill_evaluations` | MVP 先用 `user_feedback` 覆盖,后期拆细 |
| `runtime_snapshots` | 如果审计要求更强,再把每次执行的 manifest/tool/prompt 快照独立成表 |
| `failure_events` | 如果失败分析需要看板化,再把 `failures.jsonl` 同步入库 |

**项目进度看板**:需求文档明说接飞书多维表格(`doc/用户研究 AI 专项 · 交付管理文档.md:84,233`)。**飞书是看板真相源**,不在 PG 重复造;PG `research_tasks` 存飞书行 ID 引用即可。

**存储选型**:PostgreSQL(结构化)MVP 足够;pgvector 二期开启;对象存储放报告附件/录音转写/设计稿截图。

### 3.2 DDL 级设计(建议稿)

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_type TEXT NOT NULL,          -- user | assistant | system | tool
  message_type TEXT NOT NULL,         -- text | plan | execution_update | report | error
  content JSONB NOT NULL,
  artifact_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE research_tasks (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  original_input TEXT NOT NULL,
  task_type TEXT,
  structured_task JSONB NOT NULL,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmations JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocking_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_state TEXT NOT NULL DEFAULT 'draft',
  status TEXT NOT NULL DEFAULT 'created',
  run_workspace_uri TEXT NOT NULL,
  feishu_record_id TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  pii_detected BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE task_decision_states (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  node_key TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence NUMERIC(4,3),
  user_override JSONB,
  final_state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, node_key)
);

CREATE TABLE execution_log (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  step_no INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  actor_type TEXT NOT NULL,           -- skill | tool | llm | reviewer
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending | running | succeeded | failed | skipped
  input_ref TEXT,
  output_ref TEXT,
  error_json JSONB,
  tokens_json JSONB,
  latency_ms INTEGER,
  context_manifest_ref TEXT,
  config_git_commit TEXT,
  decision_graph_hash TEXT,
  skill_manifest_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_manifest_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_hash TEXT,
  model_name TEXT,
  model_version TEXT,
  trace_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, step_no)
);

CREATE TABLE artifacts (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  artifact_type TEXT NOT NULL,        -- plan | report | file | tool_output | context_manifest
  title TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  content_summary TEXT,
  source_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_feedback (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  user_id UUID NOT NULL REFERENCES users(id),
  rating INTEGER,
  adopted BOOLEAN,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.3 必建索引与边界

```sql
CREATE INDEX idx_conversations_owner_recent
  ON conversations(owner_user_id, updated_at DESC);

CREATE INDEX idx_messages_conversation_time
  ON messages(conversation_id, created_at ASC);

CREATE INDEX idx_research_tasks_owner_recent
  ON research_tasks(owner_user_id, created_at DESC);

CREATE INDEX idx_research_tasks_conversation
  ON research_tasks(conversation_id, created_at DESC);

CREATE INDEX idx_research_tasks_status
  ON research_tasks(status, updated_at DESC);

CREATE INDEX idx_decision_states_task
  ON task_decision_states(task_id);

CREATE INDEX idx_execution_log_task_status
  ON execution_log(task_id, status);

CREATE INDEX idx_artifacts_task_type
  ON artifacts(task_id, artifact_type);
```

DB 边界:

- 大文件、截图、录音转写、tool 原始输出不进 PostgreSQL,只存 `storage_uri`。
- `content JSONB` 可以存消息正文和结构化卡片,但不能塞完整附件。
- `users.id` 是业务主键;邮箱只是登录标识,未来换登录方式不迁移业务数据。
- 复杂审批流不在 MVP 单独建表;先用 `research_tasks.approval_state` + `execution_log` 记录。审批成为高频后再拆 `approval_requests`。
- `messages` 是会话回放真相源;`execution_log` 是任务执行真相源。两者不能混用。

### 3.4 会话记忆方案

推荐方案: **DB 消息持久化 + 会话摘要 + run workspace/checkpoint**。

```text
用户输入
  → 写 messages
  → 创建/更新 conversations
  → 生成 research_task
  → 每个执行步骤写 execution_log
  → 关键产物写 artifacts
  → 长对话定期刷新 conversations.summary
```

上下文重建规则:

1. 当前任务只读取当前 `conversation_id` 下最近 N 条消息、`conversations.summary`、当前 `research_task`、相关 artifacts 摘要。
2. 历史任务从 `research_tasks(owner_user_id, created_at DESC)` 与 `conversations(owner_user_id, updated_at DESC)` 回看。
3. 长对话不把全量 messages 塞进 prompt,只塞摘要 + 最近消息 + 当前任务相关 artifact 摘要。
4. Agent Runtime 自带的 session/checkpoint 只能作为加速层,不能作为唯一存储。平台自己的 DB 才是可迁移、可审计、可恢复的真相源。

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

---

## 三·补 · 知识库建设协议

项目必须有知识库,但知识库不能和 Research Memory DB 混在一起。前者是**可复用经验**,后者是**本次任务流水**。

| 类型 | 存什么 | 更新方式 | 用途 |
|---|---|---|---|
| `knowledge-base/` | 方法论、历史案例、人群标签、术语表、报告模板、正反例、团队能力说明 | Git review + owner 审核 | 给 LLM 做任务理解、案例参照和报告生成 |
| Research Memory DB | 用户原话、结构化任务、决策状态、执行日志、产物、反馈 | 运行时自动写入 | 复盘这一次任务发生了什么 |

**MVP 不建重型知识图谱,也不上 pgvector。** 先用 Markdown/YAML 做知识源文件,Git 管版本;在构建期生成轻量 `knowledge-index.json`,运行时用 metadata 过滤 + BM25/关键词检索 + LLM 小候选重排。等案例检索成为瓶颈后,再把条目同步到 `knowledge_items` + `knowledge_embeddings`(pgvector)。一开始就上图谱、Milvus、复杂标签体系,会拖慢主链路。

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

**MVP 知识检索推荐实现:**

```text
knowledge-base/*.md
  → 解析 frontmatter
  → 生成 knowledge-index.json
  → 查询时先按 type/domain/tags/status/sensitivity 过滤
  → BM25/关键词召回 top 20
  → 取 title + summary + source + hash 给 LLM 重排 top 5
  → 只把 top 5 摘要放进上下文
```

`knowledge-index.json` 每条至少包含:

```yaml
id: case_live_competitive_001
path: knowledge-base/cases/case_live_competitive_001.md
title: 直播场域竞品研究案例
summary: 150-300 字摘要
type: case
domain: live_commerce
tags: [competitive_research, user_experience]
status: approved
sensitivity: internal
source: feishu/wiki/report
content_hash: sha256:...
updated_at: 2026-07-07
```

检索硬规则:

- `status != approved` 默认不进候选。
- `sensitivity` 高于当前模型通道允许级别时不进候选,或只进脱敏摘要。
- 给 LLM 的每条候选必须带 `id / source / content_hash`,最终报告必须能反查来源。
- MVP 只检索摘要,需要引用原文时再按 `path` 加载对应片段,不能一次塞完整知识库。

**MVP 最小知识闭环:**

- 先放 3 类内容:方法模板、3-5 个高质量案例、术语/人群标签。
- 每个首批 skill 至少绑定 1 个方法条目或案例条目。
- 最终报告必须区分来源:用户输入 / 知识库 / Tool 结果 / LLM 推断 / 待人工确认。
- 暂不做自动学习,只做人工审核后沉淀。

---

## 三·补二 · 数据安全与合规基线

用研任务天然可能接触用户之声、人群标签、访谈内容和业务敏感材料。这里取消"PII / confidential 默认不出域"的硬限制,改为**数据分级 + 合规通道策略 + 脱敏/审批 + 审计留痕**。MVP 不做完整合规平台,但必须把策略点留出来,否则后续外部模型、内部模型、合规代理和私有化通道没法统一治理。

1. **数据分级:** 复用知识库 metadata 的 `sensitivity: public | internal | confidential`,扩展到 `research_task`、tool 输出和 artifact。涉及个人身份、联系方式、原始访谈内容等字段额外标 `pii: true`。
2. **敏感数据进入 prompt 前先走策略:** PII 和 `confidential` 数据不是一律禁止进入 LLM,而是必须先匹配策略:可脱敏则脱敏,业务确需原文则走 `approver` 审批,审批通过后允许进入指定模型通道。
3. **出域按合规通道决定:** 如果 `llm-client` 底层走 Claude / OpenAI 等外部 API,是否允许携带 PII / `confidential` 数据,由企业合规通道、合同约束、数据分级和审批策略共同决定,不在本方案写死禁止。无合规通道时,系统应降级为脱敏摘要或内部模型。
4. **context linter 落地检查:** `context linter` 在 LLM 调用前检查上下文来源、预算、task_type 相关性、数据分级、脱敏状态、审批记录和目标模型通道。能机器拦的规则不靠人自觉。

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
├── database/                # migrations + seed(8 张核心运行时表)
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

【段2 · 待执行计划】← 核心闸门
2  按 task_type 从决策节点池激活相关子集(略过无关节点,不做"7 节点逐一打状态")
3  读 skill 摘要 + tool-registry 的轻量索引,由 LLM 语义选择候选 skill,tool 先做权限/风险预筛
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

完整路线不是"先做一个临时 MVP,以后推倒重来",而是按同一套协议逐步增量:

| 阶段 | 目标 | 交付边界 | 不能偷懒的终态接口 |
|---|---|---|---|
| V0 技术验证版 | 验证底座成立 | OpenAI Agents SDK spike、8 张核心表、schema/manifest/registry、1 个 fake tool | `agent-runtime / llm-client / tool-adapter` 抽象、execution_log、schema 校验 |
| V1 MVP 试点版 | 跑通第一条真实主链路 | Web 会话入口、1 个 task_type、1 个 seed skill、1 个 seed tool、最小知识库、报告和复盘 | 四段流、计划确认闸门、manifest/hash 追溯、source_refs |
| V1.5 多能力试点版 | 验证可扩展接入 | 3-5 个高频 skill/tool、2-3 类 task_type、skill 迁移模板、能力库/案例库只读页 | skill/tool 上架门禁、evals、registry linter |
| V2 生产推广版 | 面向更多团队使用 | 门户 + 咚咚 Bot、飞书看板同步、审批流增强、监控告警、基础运营后台 | 同一消息协议、同一任务状态、同一 artifact/source 模型 |
| V3 规模化运营版 | 提升检索、评估和治理 | pgvector、skill 质量评估、成本看板、文档园丁/规则园丁、可控多 Agent | 沿用 metadata/source hash、execution_log、feedback 数据 |

**试点期(7月 / V0-V1)**:交付 `schemas/` 三件套 + `decision-graph.yaml` + `skill-registry.yaml` + `tool-registry.yaml` + `research-orchestrator/SKILL.md` + `harness/linters` 最小集 + 8 张核心表 DDL + 最小 `knowledge-base/`。跑通"一句话 → 方案初稿",半自动、人可干预。用 1 个已建好的 skill(如 B8 design-audit)和 1 个低风险 tool 接入验证。

**存量能力迁移(V1.5 贯穿到 V2)**:项目目标是聚合 10+ 团队的能力,真实成本不只在搭骨架,还在把散落于设计 wiki / 各团队的存量 skill 改造成合规交付包。MVP 不要求全迁,先由平台方 + 1-2 个种子团队改造 1-2 个存量 skill,沉淀"迁移 checklist + skill 模板"。存量能力可先以 `status: draft` 占位登记,只填 `name / path / owner`;补齐 manifest / schema / examples / evals 后才能升 `active`,参与自动路由和调用。

**打包期(8月 / V2 起点)**:各团队 skill/tool 按 manifest 标准入 registry;run workspace + context manifest + failures.jsonl 落地;`agent-api` + `orchestrator-runtime` 上线。

**推广期(8月后 / V2-V3)**:门户 + 咚咚 Bot 入口;pgvector 案例检索;飞书看板同步;skill/tool 评估闭环;后台文档园丁/规则园丁开始扫描失败记录和过期知识。

---

## 七、待工程团队产出的骨架清单(交付物)

MVP 阶段按此清单落地,均为可 review 的文件/配置,非运行时黑盒:

1. `schemas/research-task.schema.json` — 用户需求如何结构化;含 `assumptions[]`(可改假设)、`confirmations[]`(需用户确认)、`blocking_issues[]`(必须阻断)
2. `schemas/skill-manifest.schema.json` — skill 如何被发现/选择/调用/评估(`owner` = 维护方/团队)
3. `schemas/tool-manifest.schema.json` — tool 如何声明与配置化调用(adapter 优先级:o2 → 内部 API/MCP → 脚本;含 auth_required / risk_level / approver_rule)
4. `schemas/research-report.schema.json` — 标准报告结构(对齐交付物 A2);扩字段 `timeline`(执行流程+周次)/ `deliverables`(产出物清单)/ `capability_orchestration`(能力编排:调用了哪些 skill/tool)
5. `orchestrator/decision-graph.yaml` — 决策节点池,每节点含 `applies_to` + `tier(core/optional)` + 触发规则 + `risk_policy`
6. `orchestrator/skill-registry.yaml` — skill 发现索引 + 治理索引,可由 `SKILL.md` 自动生成 + 1 个样例 skill
7. `orchestrator/tool-registry.yaml` — tool 轻量索引卡 + 1 个低风险样例 tool
8. `knowledge-base/` — 最小知识包(methods + templates + 3-5 个脱敏案例 + terminology)
9. `harness/context-slots.yaml` — 上下文分槽、预算和来源要求
10. `harness/linters/*` — registry/risk/report/context 四类校验器,其中 context linter 包含 PII / `confidential` 的脱敏、审批和模型通道策略检查
11. `run-workspaces/{task_id}/` 模板 — plan/context_manifest/tool_outputs/failures/artifacts 约定
12. `orchestrator/research-orchestrator/SKILL.md` — 编排主 skill(任务理解 → 计划 → 确认 → 执行 → 交付 的四段 prompt)
13. `database/migrations/*.sql` — 8 张核心表 DDL(`users / conversations / messages / research_tasks / task_decision_states / execution_log / artifacts / user_feedback`) + 配置/运行时边界说明 + manifest hash / prompt hash / model version 追溯字段
14. `apps/agent-api` + `apps/orchestrator-runtime` — 薄后端(打包期)。`orchestrator-runtime` 不含业务判断,但要承载 LLM 调用、MVP o2 adapter、schema 校验、重试、审计、context_manifest、failures 回放,须单独排期。
15. `migration-checklist.md` + skill 模板 — 用 1-2 个种子 skill 改造过程沉淀,供后续团队批量接入。

详细工程任务拆解见: [用研AI专项_开发Todolist_codex.md](/Users/heyunshen/work/PROJECT/jdc/ai-x/doc/用研AI专项_开发Todolist_codex.md)。

---

## 验证方式(MVP 端到端)

1. **schema 校验**:用一条真实需求("我要为直播场域做一次用户体验研究")手工构造 ResearchTask,跑 JSON Schema 校验通过。
2. **决策节点池空跑**:喂该 ResearchTask 给 orchestrator skill(可先在 Claude Code / Agent SDK 里本地跑),检查 task_type 分流后**只激活相关节点子集**(如竞品任务不激活 D2/D4),激活节点的状态 + reason 合理,且能命中 registry 里的 skill。
3. **计划-确认闸门**:确认前不执行;用户改假设后计划相应更新(见 Q4)。
4. **缺失信息分级**:同一条需求里同时构造可假设、需确认、必须阻断三类输入,验证状态和 UI 提示不同。
5. **高风险 tool 拦截**:构造一个 auth_required + high risk tool,确认未审批前不执行,审批后才写入 execution_log。
6. **单 skill 接入**:用 B8 design-audit 走通"选中→自动调用→产出符合 report schema"。
7. **Skill/Tool 接入验收**:新增一个 draft skill 和一个 draft tool,确认缺 manifest/schema 时不能进入 active;补齐后能被 registry 读取并参与路由。
8. **知识库引用验证**:放入 3 条脱敏知识条目,生成 `knowledge-index.json`,确认 metadata 过滤 + BM25/关键词召回 + LLM 小候选重排能返回 top 5,且最终报告标清来源。
9. **Harness linter 验证**:构造 4 类失败样例,缺 registry 字段、高风险 tool 无审批、报告无来源、上下文超预算,确认都能被拦截且错误信息说明正确做法。
10. **LLM 输出 schema 验证**:构造不合规的 ResearchTask / decision_state / plan 输出,确认能自动重试;重试失败后降级为 `need_clarify`。
11. **审批闭环验证**:构造 `need_approval` 步骤,确认审批卡可通过/拒绝并写入 `execution_log`;超时不自动放行。
12. **失败回放验证**:强制制造一次 tool 失败,确认 `execution_log.status = failed`、`failures.jsonl`、`context_manifest.json`、`execution_log.context_manifest_ref` 能复盘当时加载了什么、选了什么、为什么失败。
13. **数据安全验证**:构造含 PII / confidential 的上下文,确认 context linter 能按策略区分三种情况:脱敏后放行、审批后原文放行、无脱敏且无审批时拦截。
14. **入库回看**:确认 `users / conversations / messages / research_tasks / task_decision_states / execution_log / artifacts` 有对应记录,能从历史任务恢复会话,也能回答"为什么这次选了 X skill、没激活 Y",并看到 manifest hash / prompt hash / model version。
15. **反馈闭环**:提交一条 `user_feedback`,确认可被下次调度读取(MVP 可仅存储,不必自动优化)。

---

## 八、已知边界与非目标(MVP 不做什么)

MVP 要跑通动态编排、计划确认、自动调用、可复盘和安全红线,不把生产化能力一次性做满。以下内容不是忘了做,而是等真实信号出现后再做。

| 维度 | MVP 取舍 | 二期触发条件 |
|---|---|---|
| 端到端延迟 | 多轮 LLM + tool 可能是分钟级;MVP 做执行进度反馈,不做并行编排和延迟预算 | 出现延迟投诉,或单任务耗时影响使用 |
| 并发与限流 | 保留任务状态和基本异步执行;不做复杂队列、配额和自动扩缩容 | 用户量上升、出现排队等待、模型网关配额受限 |
| 成本核算 | `execution_log` 先记录 `tokens`;不做成本看板 | 需要部门分摊、预算控制或成本归因 |
| 自动恢复 | 步骤失败后人工重试、跳过或终止;不做自动 saga / 补偿事务 | 长链路任务多、失败恢复成为高频操作 |
| 自动学习 | 高质量产物只进入候选知识,人工审核后入库 | 人工审核量成为瓶颈 |
| 多 Agent 互审 | 只在高风险输出/工具调用时启用 reviewer;不建常驻 reviewer agent 群 | 对外发布、高风险数据任务明显增多 |
| pgvector | MVP 先 Markdown/YAML + metadata + `knowledge-index.json` + BM25/关键词召回;语义检索二期 | skill 上百或案例检索成为瓶颈 |

---

## 与 AI 方案的差异速查(给评审用)

| 维度 | AI 方案 | 本方案 | 理由 |
|---|---|---|---|
| 架构层 | 8 层后端 | 3 组件(api / orchestrator / db) | 5 层实为一次 LLM 调用内的步骤 |
| 决策图 | 可计算引擎 + 2 张表 | YAML + prompt,交 LLM 判断 | 引擎化会杀死"动态" |
| 路由 | 三段式(含向量召回) | MVP 读 skill 摘要 + LLM 语义选择,tool 走 registry 预筛;向量召回二期 | 数十个 skill 无需向量,YAGNI |
| DB | 16 张(含配置表) | MVP 8 张核心运行时表,含用户、会话、任务、执行和产物 | 配置归 git/YAML,可 diff/回滚;用户和会话是产品必需能力 |
| 报告 | 单开 research_reports | 归入 artifacts | 报告是 artifact 的一种 |
| 看板 | PG 自建 | 飞书为真相源,PG 存引用 | 需求文档已定接飞书 |
| 决策图 | 7 节点人人过关 | 节点池,task_type 按需激活(applies_to/tier) | 固定 7 步与"动态调度"自相矛盾 |
| 交互 | 系统一路跑到底 | 计划→确认→执行→交付四段,确认是硬闸门 | 人在环、可干预,而非事后追问 |
| 能力调用 | 推荐 Owner / 挂人校准 | 普通能力自动调用,owner 仅维护方;高风险由 approver 审批 | 不导流普通能力,但保留安全闸门 |
| 能力接入 | 描述原则多,接入协议弱 | Skill/Tool 均以 manifest + schema + examples + evals 接入 | 新增能力不改主流程代码 |
| 知识库 | 倾向直接上向量库 | MVP 先 Markdown/YAML + metadata + BM25/关键词召回,二期 pgvector | 先沉淀高质量知识,再做检索平台化 |
| Runtime 稳定性 | 主要靠 prompt 和日志 | 步骤状态 + schema 校验 + 人工重试/跳过/终止 + failures.jsonl | 失败可定位、可恢复,不整体重跑 |
| 安全合规 | 未形成硬边界 | sensitivity / pii 标记 + 脱敏/审批 + 模型通道策略 + context linter | 用研数据可能涉及真实用户和敏感业务,不能只靠人工判断 |
| Harness | 主要靠 prompt 和日志 | Run workspace + context manifest + linter + failures.jsonl | 状态外置、约束可执行、失败可回放 |
| 最终产物 | 研究报告 | 方案含时间线+产出物清单+能力编排 | 可直接开工,而非半成品 |
| 复盘能力 | 只存运行结果或配置表膨胀 | 运行结果 + manifest/prompt/model 快照引用 | 既不把配置塞 DB,又能解释历史判断 |

---

## 待明确开放项(Q1–Q13 · 进开发前评审拍板)

以下为文档/demo/讨论三层都尚未定死的事项,已附推荐默认值(带理由)。评审时在此基础上确认或推翻。

> **优先拍板:** Q2 / Q5 / Q10 是地基项,分别决定 tool 接入形态、LLM 运行时与模型通道策略、能力上架门槛。Q5 当前推荐已改为 OpenAI Agents SDK 先行 spike,但仍必须以 3-5 天技术验证结果为准。

| # | 开放项 | 推荐默认值 | 理由 | 影响的交付物 |
|---|---|---|---|---|
| Q1 | 计划确认粒度:整份确认 vs 逐步骤增删 | MVP 先"整份确认 + 改假设",不做逐步骤增删 | KISS,逐步骤编辑重投入,有真实需求再加 | agent-api plan 接口 |
| Q2 | tool 真实接入形态【P0】 | 统一 tool-manifest + 适配器;MVP 只实现 o2 adapter,内部 API/MCP/script 保留协议字段,二期按需接 | 与"配置即真相源"一致,o2 京东内覆盖最广,先少接一类 adapter 降低风险 | tool-manifest.schema、tool-gateway |
| Q3 | 人工确认状态如何拆 | 拆成 `need_annotate` / `need_approval` / `blocked` | 低风险结论可继续执行并标注,高风险操作必须审批,缺授权直接阻断 | decision-graph 状态集、report-schema 风险区、tool-manifest |
| Q4 | 改假设后是否重算计划 | MVP 轻量重算——仅重刷受影响的计划步骤,不整体重跑决策 | 整体重规划成本高、易困惑,轻量刷新够用 | orchestrator skill、agent-api |
| Q5 | LLM/Agent 运行时选型【P0】 | MVP 推荐 OpenAI Agents SDK 作为第一实现;Claude Agent SDK 作为强备选;Pi 只做 PoC/二期替代评估。业务代码只依赖 `agent-runtime / llm-client / tool-adapter`,不直接绑任何 SDK | OpenAI Agents SDK 对产品型 agent 所需的 sessions、guardrails、human-in-the-loop、tracing、MCP、skills/tool search 和 schema 化支持更完整;Claude 与 Claude Code/`SKILL.md` 生态贴合;Pi 适合开源可控试验但生产支持和治理风险更高 | orchestrator-runtime、context linter、3-5 天 spike |
| Q6 | MVP 首个端到端 task_type | 竞品研究优先;design-audit 走查(B8 试点中)第二 | 竞品边界最清(激活节点最少)、tool 依赖明确(o2 抓取),最易验证骨架 | 试点排期、首批 skill/tool |
| Q7 | 版本追溯粒度 | MVP 记录 Git commit + manifest hash + prompt hash + model version;审计加强时再建 runtime_snapshots 表 | 不建配置表也要能复盘历史判断 | execution_log、artifacts.source_refs_json |
| Q8 | 负责人语义 | `owner`=能力维护方,`reviewer`=本次任务确认人,`approver`=高风险审批人 | 防止把所有协作都混成"找负责人",也防止高风险无人兜底 | skill-manifest、tool-manifest、agent-api 审批流 |
| Q9 | 知识库首批内容范围 | 先收 methods、templates、terminology、3-5 个脱敏案例 | 知识质量比数量重要,避免一开始做低质向量垃圾场 | knowledge-base、review 流程 |
| Q10 | skill/tool 加载与上架门槛【P0】 | Skill 走渐进式加载:name/description/when_to_use 先发现,命中后读完整 `SKILL.md`;registry 只做发现索引和治理索引。没有 manifest/schema/examples/evals 不进 active;高风险 tool 必须配置 approver_rule | 既保留原生 Skill discovery 的低接入成本,又保证能力可校验、可追责、可停用 | registry 校验、CI、orchestrator-runtime |
| Q11 | Run Workspace 存储形态 | MVP 本地/对象存储均可,DB 只存 `run_workspace_uri` | 大对象和中间文件不进 PG,但必须可回放 | agent-api、orchestrator-runtime、对象存储 |
| Q12 | Linter 首批范围 | registry/risk/report/context 四类先做最小可用;context linter 覆盖 PII / `confidential` 的脱敏、审批和模型通道策略 | 能机器拦截的规则不要只写进文档 | harness/linters、CI、tool 调用前 guard |
| Q13 | 是否新增 Reviewer Agent | MVP 不新增常驻 Reviewer Agent,只在高风险输出/工具调用时启用独立 reviewer | Agent 数量也是上下文成本,先 1 Agent + N Skill | reviewer-rules、risk_policy、审批流 |
