# User Research Hub 受控接入与动态方案卡片方案

> 日期：2026-08-21
> 状态：已完成科学性与工程可行性修订，待批准
> 版本：v3（受控内容接入、可审计 Planning Guidance 与分步动态方案卡片）
> 来源目录：`wiki/user-research/`
> 接入目标：在不破坏 Current 可信研究闭环的前提下，尽量完整保留并吸收其中的方法、设计策略、Skill、模板和案例经验，并让 Task/Scenario 受控影响前台候选方案。
> 审核原则：只在 3 个里程碑做人工审核；开发中的 lint、单测和自检不算审核，也不触发人工复核。

## 1. 结论

采用“完整保留来源、按语义合并、候选隔离、批量晋级”的接入方式，不整体复制 Hub 六区结构，不直接启用其中任何 Registry、Tool 或 draft Skill。Task/Scenario 通过内部 Planning Guidance 接入现有 Planner，并由受控 Candidate Profile Resolver 生成 2–4 张有实质取舍的方案卡片。

第一版接入不新增服务、数据库表、HTTP endpoint、环境变量、第三方依赖或新的 `task_type`，也不提高网页图片获取优先级；但新增一个受版本控制的内部 Planning Policy，用于在 `fixed` 与 `dynamic` 候选生成间安全切换。现有 `ResearchTaskV2`、Decision Graph、Evidence Policy、Deliverable Registry 和报告证据边界保持不变。现有候选方案响应仍使用同一 endpoint 和数组结构，但候选合同从固定两张 `depth/speed` 扩展为 2–4 张受控 Profile；选择仍以 `planVersionId` 为稳定标识。

核心收益来自四部分：

1. 保留 5 类 Task、15 个 Scenario 的任务语义，并将其转化为当前方法库中的场景指南、现有 Skill 的触发/完成规则和动态方案卡片的选择依据。
2. 将“证据 → 现象 → 问题归因 → 洞察 → 策略 → 设计动作 → 优先级 → 验证指标”接入现有 Skill、报告生成 Prompt 和评审 Rubric。
3. 将新增方法、模板和高质量案例经验纳入当前 Knowledge Base，同时避免重复召回、错误来源和 draft 能力误入生产。
4. 常规 routed task 固定保留 `speed/depth` 两张基线卡；复杂任务增加 1 张专项卡，只有用户明确要求比较多种方法或路径时才允许增加到 4 张。每个 Profile 是一份完整策略合同，必须明确范围、证据路径、方法组合、复核强度和输出侧重点；LLM 只在受控范围内识别 Scenario、填充指定 Profile 的步骤，不决定卡片数量、ID、排序或推荐项。

## 2. 当前事实基线

### 2.1 来源规模

- 总文件：8,491 个，约 401MiB。
- `00-source-sync/`：7,683 个文件，约 274MiB，属于原始镜像。
- 整理层文件：约 800 个，其中 Task 34、Skill 140、Knowledge 574、Mechanism 20、Registry 7、Tools 6。
- Registry：25 个 Skill、184 条 Knowledge、29 个 Task、29 个 Case、8 个 Domain，全部为 `draft`。

以上数量是 2026-08-21 工作树快照；阶段 A 的 `inventory` 输出才是冻结真相源，若与本节不同必须更新本节并重新计算 source manifest hash，禁止继续沿用手写数字。

### 2.2 与当前项目重合

- 当前项目有 22 个 active Skill；Hub 的 25 个 Registry Skill 中，18 个与当前 Knowledge Base Skill 重合。
- 当前知识索引有 104 条；按标题归一化后，这 104 条全部能在 Hub 中找到对应项。
- Hub 相对当前项目约新增 80 条 Registry Knowledge：24 条方法、33 条机制/检查清单、14 条模板、9 条商详场域知识。

### 2.3 已知质量问题

- 排除 `00-source-sync/` 后，731 个 Markdown 中有 169 个无法被当前 `parseFrontmatter` 解析；全部包含未加引号的 `[LOCAL_HOME]/...`。
- 8 个 Domain Pack 的 64 个标准模块中，36 个为“待整理”，28 个为“暂无”。
- 9 个证据、质量、治理、降级机制文件只有标题不同，正文相同。
- `06-tools-工具/` 只有 README 占位，没有可执行工具。
- “真实 E2E”材料缺少可复现的 Provider、模型、命令和真实运行收据，且自身记录完整闭环仅 7/36。
- 整理层的 `research-screenshot-analyzer` 错收为安全说明；真正的 DesignPeek Skill 位于 `00-source-sync/`。
- 部分案例 frontmatter 与正文评级冲突，并存在空的触点、问题类型、策略方向和验证字段。

### 2.4 现有金标场景漂移

`CONTEXT.md` 将首个 P0 金标场景固定为“直播场域数字人竞品研究”，但当前 `gold-run.ts` 按文件顺序选择第一条 `competitive_research + clear + piiDetected=false` fixture；当前实际会选中 `competitive-pet-food`。`.env.example` 中的 `CURRENT_SMOKE_SCENARIO=competitive-ai-shopping-assistant` 只控制普通 Current Smoke，不能修正 Gold 的隐式选择。

本方案不重新定义金标口径。阶段 C 必须把 Gold 改为按专用 Scenario ID 精确选择“直播场域数字人竞品研究”，并增加防顺序漂移测试；如果产品负责人要更换金标场景，应先单独修改 `CONTEXT.md` 和 ADR，本方案不得靠调整 fixture 顺序偷偷改变标准。

该修复只改变 Scenario 选择，不改变 `docs/adr/0001-gold-run-auto-confirm-gate.md` 的“自动确认前断言无 `requires_approval`”规则，也不改变 `docs/adr/0002-gold-run-full-real-boundary.md` 的真实 Gateway + 真实 Tool 边界。

### 2.5 当前候选方案合同限制

- `schemas/current-plan-candidates.schema.json` 和 `routed-planner.ts` 将候选数量写死为 2，ID 写死为 `depth` 与 `speed`。
- `ROUTED_STEP_LIMITS`、PlanCompiler、control planning service、task workflow、revision 路径和 API TypeScript 类型也依赖这两个 ID。
- `database/control-plane.ts` 虽然把 `candidate_id` 存为 `TEXT`、无需数据库迁移，但读取、排序、连续版本校验和 clarification replacement 都强制“恰好 depth/speed”。
- 前端 Embla 轮播已经按数组渲染、支持任意数量的滑动、箭头、圆点和键盘导航；但标签逻辑把所有非 `depth` 的卡片都显示成“速度优先”。
- 前端选择实际使用 `planVersionId`，因此扩展 `candidateId` 不需要改变选择接口或数据库主键。

### 2.6 开发运行时前置

根 `package.json` 要求 Node `>=22` 并固定 `pnpm@9.12.1`；本次复核终端实际为 Node `v22.22.1`、pnpm `9.12.1`，前置已满足。阶段 A 仍必须以 `node -v` / `pnpm -v` 记录执行环境，任何 Node 20 结果不得作为 Gate 证据。本方案不另增 Node 版本管理工具。

## 3. 目标与成功标准

### 3.1 目标

- 整理层的每个文件均归属于一个语义实体、附件或孤儿项，并获得明确处置，不因 Registry 遗漏或目录重构而丢失。
- 当前已有知识和 Skill 不生成第二份重复真相源。
- 设计策略方法能够改善报告推导、建议优先级和验证闭环。
- Task/Scenario 能稳定影响候选方案的输入检查、能力组合、串并行关系、完成标准和降级路径。
- 每次 Scenario/Profile 决策都以最小 Planning Provenance 随 plan version 持久化，可反查规则、映射版本、输入字段依据和降级原因。
- 候选数量和 Profile 由规则决定，LLM 只生成指定 Profile 的具体步骤。
- 新内容在通过审定前不能改变生产路由或报告行为。
- 所有生产可用内容均能反查 Hub 来源路径、来源哈希和接入处置。
- 以后同步 Hub 时复用同一套清单和校验流程，不进行人工全目录复制。

### 3.2 完成标准

- 184 条 Knowledge、25 个 Skill、29 个 Task、29 个 Case、8 个 Domain 均有最终处置记录；整理层全部文件还必须关联到上述实体、附件分组或带理由的孤儿项，不得存在 `unreviewed`、未归属文件或空结论。
- `00-source-sync/` 通过已有 manifest 和整体哈希完整保留，但不进入 Runtime、构建产物或部署包。
- 所有进入 `knowledge-base/` 的 Markdown 可被当前解析器解析，ID 唯一，来源路径有效，内容哈希一致。
- 104 条重合知识不产生重复索引项；18 个重合 Skill 不产生重复 active Skill。
- 15 个 Scenario 的触发、输入、输出、完成条件均被保留，并各自具有经过审定的 `candidate_profiles` 映射和完整 ProfileSpec 约束。
- 第一版新增 active Skill 数量为 0；新 Skill 仅允许保持 `draft`，或将独有逻辑合并到现有 Skill。
- Knowledge candidate 在 Gate 3 前始终保持 `candidate`，不得在 Gate 2 后转为当前 Runtime 可搜索的 `draft`；Gate 3 通过后只晋级为 `approved`。
- 现有 5 个 `task_type`、Deliverable Schema、endpoint 和选择协议不扩张；唯一候选合同变化是数组允许 2–4 项、`candidateId` 使用受控 Profile，并兼容旧 `depth/speed` 历史计划。
- 常规 routed 新计划始终包含 `speed/depth` 基线，只在用户任务信号与 active capability 同时满足时增加 0–2 张专项卡；新计划恰有一张 `recommended` 卡片。
- 候选 ID 唯一，所有候选可独立编译、覆盖同一组 required questions、required evidence 与用户要求的 deliverables，且任意两张必须在 ProfileSpec 规定的范围、方法、证据、复核或输出侧重点上形成实质差异。
- 动态候选只允许一次合并纠错调用；纠错后若专项卡仍失败但本轮 `speed/depth` 已验证通过，则直接丢弃专项卡并降为两张，不再调用模型。任一基线失败则 fail closed。
- 90 条冻结 Scenario 数据集在调整规则或 Prompt 前按 `60 calibration / 30 holdout` 分层锁定；Gate 3 只用 holdout 作路由结论，并满足预先定义的准确率、clarification 和候选合法性阈值。
- 固定真实任务连续运行三次，至少两次获独立研究员“可用”结论，且不得发生来源伪造、敏感信息泄漏或确认闸门绕过。

### 3.3 可证伪假设

本方案把两项价值判断拆开验证，任一失败都不以另一项成功掩盖：

- **H1 内容增强假设**：在固定 `speed/depth` 规划下，Hub 方法、Skill reference、Prompt 和 Rubric 增强能提高或至少不降低报告可用性、策略链完整度与 grounding。若内容增强 only 组低于当前基线，C1 不得进入生产。
- **H2 动态候选假设**：在内容版本固定时，Scenario Guidance 能稳定生成 2–4 张有实质差异、全部可执行的候选，并使独立研究员认为推荐项合理。若 holdout 指标或候选盲评未达阈值，C2 保持 `fixed`。
- **安全非劣假设**：H1/H2 均不得降低 required evidence、审批、隐私、来源真实性或历史计划可读性；任一 P0 硬失败直接否决对应 activation。

四组对照中的模型、Tool fixture、输入、报告合同和 Rubric 必须冻结；只允许改变被测变量。Gold 的三次全真运行是发布安全门禁，不承担证明全部 15 个 Scenario 普遍有效的统计结论。

## 4. 非目标

- 不建设新的网页图片搜索、下载或截图能力。
- 不激活 Playwright 网页视觉取证，也不接入 DesignPeek Runtime。
- 不建立第二套 Hub Runtime、知识图谱、向量数据库或 MCP Server。
- 不把 5×15 Task/Scenario 变成新的数据库状态机。
- 不增加新的报告类型或公开 Deliverable Schema。
- 不把 15 个 Scenario 变成 15 张卡片，不把“一个 Scenario”与“一张候选方案”做一一映射。
- 不新增 Candidate Agent、Profile Registry、Planner 服务或专用数据库表。
- 不允许 LLM 自由决定候选数量、发明 Profile，或用不同标题包装相同步骤。
- 不把来源真实性、隐私、安全、确认闸门或强制证据要求设计成可选卡片差异。
- 动态卡片只接入常规 routed planning；用户直呼某个 Skill 时继续使用现有“含复核/不含复核”两张方案，不为凑数量引入无关 Skill。
- 不把内部业务事实、研究原始材料或项目报告无条件并入方法知识库。
- 不将 Hub 的 E2E 报告当作当前项目的验收证据。
- 不因“尽量保留”而保留重复文件、占位内容、错误 Registry 或不安全代码的生产资格。

## 5. 架构

本方案涉及来源归档、接入清单、Knowledge Base、Skill Registry、评测和报告生成，超过 3 个组件，关系固定如下：

```text
wiki/user-research/（只读来源，完整保留）
        │
        ├── 00-source-sync manifest + 整体哈希 ──► source_only
        │
        ▼
受控盘点器 ──► knowledge-base/.sources/user-research-hub-2026-08-21.yaml
        │                    │
        │                    ├── file / entity / attachment / orphan
        │                    ├── map_existing
        │                    ├── merge_into_existing
        │                    ├── import_candidate
        │                    ├── source_only
        │                    └── reject_runtime
        ▼
确定性归一器
        │
        ├── methods / scenarios / assets / skills(draft)
        ├── frontmatter / source hash / controlled tags
        └── candidate 隔离
        ▼
kb:build ──► knowledge index + derived Skill Registry
        │
        ▼
KB-aware Eval + 固定任务回归
        │
        ▼
批量晋级 approved / 合并现有 active Skill 文本
        │
        ▼
现有 Planner / Skill / Report Prompt / Rubric
```

不存在反向写回：Runtime 不修改 Hub 来源，Hub Registry 也不覆盖当前 Registry。

常规规划运行时增加的仅是一个内部深模块，不新增服务或持久化状态：

```text
用户原始输入 + finalized ResearchTaskV2 + 当前材料/约束
                         │
                         ▼
Planning Policy（versioned，默认 fixed，Gate 3 后可切 dynamic）
                         │
                         ▼
Planning Guidance
  ├── 规则高置信且唯一时直接确定 Scenario，不增加模型调用
  ├── 仅在候选 Scenario/关系仍有歧义时，受约束 LLM 判主/次 Scenario 与置信度
  └── 校验输入缺口与 human confirmation，不以能力反推用户意图
                         │
                         ▼
现有 Decision Graph / Guidance / Problem Graph / Capability Resolver
                         │
                         ▼
Candidate Profile Resolver
  ├── 保留 speed/depth 基线，再按 Scenario、问题图和 eligible active capability 增加 0–2 个完整 ProfileSpec
  ├── 恰好标记 1 个 recommended
  └── 固定数量、步骤上限、差异维度和全部必需交付覆盖
                         │
                         ▼
现有 RoutedPlanner 只填充指定 ProfileSpec 的步骤
                         │
                         ▼
PlanCompiler 逐张校验 ──► planVersion + planning_provenance ──► 前端 Embla 轮播
```

Planning Guidance 通过单一深模块接口返回 Scenario 判定、ProfileSpec 集合和最小 `planning_provenance`。Provenance 作为现有 plan JSON 的可选字段随 plan version 持久化，不新增数据库列或 endpoint；它只记录主/次 Scenario ID、置信度、受控 signal ID、来源字段路径、Resolver/Mapping 版本哈希、最终 Profile 集合和降级原因，不复制完整用户原文。既有 LLM receipt 继续记录模型与 prompt/context hash，两者共同构成审计链。

## 6. 内容生命周期与处置类型

### 6.1 唯一处置枚举

| 处置 | 含义 | 是否进入生产索引 |
|---|---|---:|
| `map_existing` | 当前已有等价正典，仅记录映射和差异 | 使用当前条目 |
| `merge_into_existing` | 来源有独有价值，合并到当前正典，不保留第二份 | 使用合并后的当前条目 |
| `import_candidate` | 新内容进入 canonical tree，但处于候选隔离状态 | 否 |
| `source_only` | 完整保留在 Hub 来源，仅作为审计或原始材料 | 否 |
| `reject_runtime` | 明确禁止进入 Runtime、Registry、构建和部署 | 否 |

`reject_runtime` 不是删除来源；它表示保留审计价值，但拒绝生产资格。

### 6.2 Candidate 状态

新增 Knowledge 状态 `candidate`：

- `kb:build` 可以把 candidate 写入独立的 evaluation index，便于快照、哈希和评测追踪。
- 生产 `loadRuntimeKnowledgeIndex()` 在加载阶段物理排除 `candidate` 与 `deprecated`，其接口不提供 visibility 开关；评测使用单独的 `loadEvaluationKnowledgeIndex()`。
- Knowledge candidate 在 Gate 2 后仍保持 `candidate`；只有 Gate 3 通过后才可批量晋级为当前正典状态 `approved`。不得使用当前 Runtime 仍可搜索的 `draft` 作为隔离态。
- Skill candidate/draft 均派生为 Registry `draft`，不会进入 `listSkills()` 的 active 集合；本版本没有新 Skill 晋级 active。
- promotion set、content hash 和 reviewer 结论一并冻结，重复构建必须得到相同结果。

该状态解决“完整保存”和“不得提前影响生产”之间的冲突，不增加环境开关或业务分支。Knowledge 与 Skill 使用不同的晋级语义：Knowledge 为 `candidate → approved`，Skill 为 `candidate → draft`，禁止混用。

## 7. 分区处置方案

### 7.1 `00-source-sync/`

处置：`source_only`。

- 保留现有目录、`source-sync-manifest.json` 和整体内容哈希。
- 不复制到 `knowledge-base/`，不逐文件人工审核，不进入部署包。
- 后续若仓库需要减重，只允许在内容哈希、可恢复归档和恢复演练都通过后迁出；本次不迁移、不删除。
- CI 必须对实际部署/发布产物做负向清单检查，确认 `wiki/user-research/00-source-sync/`、完整 Case 原文和 `source_only/reject_runtime` 内容均未被打包；仅在 Runtime 代码中不引用这些路径不足以证明排除。

所有 `import_candidate` 和 `merge_into_existing` 条目必须额外记录 `sensitivity`、`distribution_scope`、`owner`、`retention` 和 `source_rights`。盘点器对全部拟进入 canonical tree 的正文执行密钥、PII、本机路径和内部业务事实扫描；任一字段缺失或扫描命中未处置时保持 `source_only`，不得进入 candidate。

### 7.2 Task 与 Scenario

处置：15 个 Scenario 为 `import_candidate`；5 个一级 Task 和历史 Task 导航文件统一为 `source_only`。manifest 可额外记录它们指向 Scenario 正典的导航关系，但“导航关系”不是第六种处置值。

目标位置：`knowledge-base/methods/scenarios/product-experience/design-orchestration/`。

保留字段：

- 触发语句和不适用条件；
- 必需/可选输入；
- 输出；
- 完成标准；
- 默认/按需 Skill；
- fallback；
- human confirmation 条件。

第一版不新增 `scenario_id` 到 ResearchTask、数据库或 HTTP。Scenario 作为方法库中的二级语义指南，并将独有的触发/完成规则合并到现有 Skill 的 `when_to_use`、输入要求和质量检查中。

#### 7.2.1 Task/Scenario 识别

识别发生在 finalized `ResearchTaskV2` 之后、Problem Graph 和能力路由之前。输入固定为用户原始表达、`ResearchTaskV2`、当前会话已提供的材料角色和约束；不得根据当前是否存在某个 Skill 或 Tool 反推用户意图。

识别顺序：

1. 规则层根据现有 `task_type`、明确动词、目标交付物、输入材料和约束，将范围缩小到 15 个 approved Scenario，并产出可反查的受控 signal。
2. 若规则层得到唯一 high-confidence Scenario，直接使用规则结果，不增加模型调用；只有剩余候选多于 1 个、主次关系不明确或关系类型有歧义时，受 Schema 约束的 LLM 才能从白名单中返回 1 个主 Scenario、0–2 个次 Scenario、`serial/parallel/conditional` 关系、`high/medium/low` 置信度、命中的字段路径和理由。每次 routed planning 最多增加一次该调用，不反复重试分类。
3. 确定性校验器拒绝未知 Scenario、没有输入依据的理由，以及违反现有 Evidence Policy 或审批边界的结果；Scenario 引用的 planned/draft 能力只标记为待解析，不改变意图识别。
4. `high` 直接进入 Profile 选择；`medium` 且候选 Scenario 在已冻结映射中具有相同的允许 ProfileSpec 集合时保留 alternative 后继续；`medium` 且会改变执行方法、或 `low` 时进入现有 clarification 流程，不新增状态。这里比较的是 Scenario 内容合同，不读取或猜测当前 Skill/Tool 可用性。
5. 用户直呼 Skill 的支路跳过 Scenario 识别，保持当前确定性两方案行为。

识别结果是内部 Planning Guidance，不是新的用户任务。它向现有 Guidance/Problem Graph 和候选生成上下文提供 Task/Scenario 引用、输入缺口、默认/按需能力引用、依赖关系、完成标准、fallback 和 human confirmation 条件；真实可执行性仍由后续 Capability Resolver 独立判断。

这里有两类职责不同的模型调用：Scenario 识别调用只能从规则层给出的白名单中分类；RoutedPlanner 调用只能为 Resolver 已确定的 Profile 填充步骤。卡片数量、Profile ID、输出顺序和 `recommended` 全部由确定性代码决定，两类模型调用都无权修改。

#### 7.2.2 受控 Candidate Profile

第一版只允许以下 7 个 Profile；它们是完整执行策略而不是互斥维度标签。不建立独立 Registry，`current-plan-candidates.schema.json` 是 ID 枚举正典，`planning-guidance.ts` 中的 ProfileSpec 常量和 TypeScript union 必须通过合同测试与其保持完全一致：

| Profile | 用户可见语义 | 范围策略 | 方法与证据策略 | 复核与输出侧重点 | 最大步骤数 |
|---|---|---|---|---|---:|
| `speed` | 快速判断 | 覆盖全部必需问题的最小充分范围 | 每个 required question 选择最短 eligible 证据路径，不省略 required evidence | 只保留强制复核，完整交付并显式列缺口 | 4 |
| `depth` | 深度研究 | 平衡覆盖全部对象和问题 | 增加交叉来源、反证和复核路径 | 强化证据一致性、风险和替代解释 | 8 |
| `breadth` | 广度扫描 | 扩大对象、人群、场景或触点覆盖 | 每个对象保持最低充分证据，降低单点深挖 | 强化覆盖矩阵、共性与差异，不减少必需交付 | 8 |
| `focused` | 聚焦关键链路 | 收窄到用户明确指定的人群、触点、链路或问题 | 对关键范围提高证据密度，非关键范围只保留必需覆盖 | 强化关键问题归因和可执行动作 | 6 |
| `mixed_method` | 混合方法 | 保持必需范围 | 至少两类独立方法或证据路径形成三角验证 | 强化方法一致性、冲突解释和局限 | 8 |
| `decision` | 决策收敛 | 围绕已要求的方案取舍和实施边界组织范围 | 证据链必须支持比较、风险和优先级 | 强化取舍依据、路线图、指标和验证计划；不独占任何必需交付 | 7 |
| `remediation` | 整改复测 | 聚焦已识别问题及受影响链路 | 保留问题基线、整改动作和复测证据 | 强化问题—动作—复测闭环和验收阈值 | 7 |

每个 ProfileSpec 还必须声明 `required_difference_dimensions`，值只能来自 `scope/method/evidence/review/output_emphasis`。任意专项卡至少命中其中一项，并且所有卡片都必须覆盖相同的 required questions、required evidence 和用户明确要求的 deliverables。

所有 Profile 共享相同的来源真实性、敏感信息、确认闸门、Problem Graph 覆盖和 Evidence Policy；`speed` 也不得跳过 required evidence。

#### 7.2.3 Scenario 到 Profile 的允许映射

映射写入归一后的 Scenario frontmatter `candidate_profiles`。Gate 1 只冻结 `speed/depth` 基线、2–4 数量上限和确定性控制边界；Gate 2 一次性审定并冻结 7 个完整 ProfileSpec、15 个 Scenario 的语义映射及默认顺序，LLM 无权越界：

| Scenario | 允许 Profile |
|---|---|
| 趋势与变化识别 | `speed`, `depth`, `breadth` |
| 竞品与标杆研究 | `speed`, `depth`, `breadth`, `decision` |
| 机会方向判断 | `speed`, `depth`, `focused`, `decision` |
| 已有用户资料归纳 | `speed`, `depth`, `focused` |
| 用户分层与重点人群识别 | `speed`, `depth`, `focused`, `breadth`, `mixed_method` |
| 用户旅程与需求洞察 | `speed`, `depth`, `focused`, `mixed_method` |
| 页面与链路体验走查 | `speed`, `depth`, `remediation`, `focused`, `breadth` |
| 用户反馈问题聚类 | `speed`, `depth`, `decision` |
| 数据与行为异常诊断 | `speed`, `depth`, `focused`, `mixed_method`, `decision` |
| 问题根因拆解 | `speed`, `depth`, `focused`, `mixed_method` |
| 解决方案生成 | `speed`, `depth`, `breadth`, `decision` |
| 方案比较与风险评估 | `speed`, `depth`, `decision`, `focused` |
| 结论整合与策略提炼 | `speed`, `depth`, `decision` |
| 优先级与实施路径 | `speed`, `depth`, `decision`, `focused` |
| 指标与验证计划 | `speed`, `depth`, `mixed_method`, `decision`, `focused` |

每个映射的前两项固定为 `speed/depth`，后续顺序是该 Scenario 的专项 Profile 默认优先级。主 Scenario 提供基础集合；次 Scenario 只能增加其允许且与用户最终交付目标直接相关的专项 Profile。Profile 所需 Skill 或 Tool 不在 eligible active capability 中时必须删除该专项 Profile，不能以 planned 能力补位。

#### 7.2.4 动态数量、推荐与差异规则

- `speed/depth` 是所有常规 routed task 的稳定基线，不要求各自绑定一项专用 Skill；它们只改变范围、复核和步骤预算，仍必须覆盖同一组 required questions、required evidence 和用户要求的全部 deliverables。若连这两张都无法独立编译，规划直接 fail closed。
- 在基线之外，专项 Profile 只按下表的明确信号加入；“当前有某个 Skill”只能证明可执行，不能代替用户意图信号。

| 专项 Profile | 用户任务信号 | 能力通过条件 |
|---|---|---|
| `breadth` | 明确要求覆盖多个竞品、人群、场景、触点或趋势范围 | 扩大覆盖后仍能在 8 步内满足全部 required evidence |
| `focused` | 明确指定关键人群、触点、链路或问题，需要收窄范围 | 收窄后仍覆盖全部 required questions，不得删掉强制问题 |
| `mixed_method` | 明确要求定性+定量/行为等多方法，或问题图需要两类独立证据路径 | eligible capability 中至少存在两类独立方法/证据路径 |
| `decision` | 交付目标明确要求比较、取舍、优先级、风险或实施路径 | expected deliverables 含决策输出，且其依据所需证据可达 |
| `remediation` | 明确要求走查/诊断后的整改动作与复测 | eligible capability 同时覆盖问题识别与验证/复测 |

Profile 信号提取不增加模型调用：只读取用户原始表达，以及 finalized `ResearchTaskV2` 的 `research_goal`、`target_audience`、`scope`、`constraints`、`success_criteria` 和 `expected_deliverables`。每个命中必须记录受控词表命中的字段路径和 signal ID；没有可反查输入依据时该信号为 false。信号提取同时区分“任务内容命中”和“用户明确要求某种执行取舍”，后者只有在用户表达快速、深入、广泛、聚焦、多方法、决策收敛或整改复测偏好时才为 true，不能因研究对象很多就推断用户偏好广度。受控词表、字段规则和正反例在 Gate 2 使用 60 条 calibration 样本调整并冻结，30 条 holdout 标签在 Gate 3 前不得用于调整。

- 生成 2 张：默认只生成 `speed/depth`。
- 生成 3 张：主/次 Scenario 对执行方法产生实质差异，任务同时要求研究结论与决策建议，或存在两类可用证据路径，并且至少 1 个专项 Profile 同时通过信号与能力条件。
- 生成 4 张：用户明确要求比较多种研究方法或执行路径，且至少 2 个专项 Profile 同时通过信号与能力条件；否则最多 3 张。
- 专项 Profile 按确定性元组排序：是否命中用户明确的执行取舍、是否直接满足 `expected_deliverables`、命中的主/次 Scenario 数量（降序）、主 Scenario 映射下标、所有次 Scenario 中的最小映射下标、7.2.2 表格下标；布尔命中优先，缺失下标视为无穷大，按顺序取所需数量。最终输出再按 7.2.2 表格顺序稳定排序，避免相同输入只因模型措辞变化而换位。
- 硬上限为 4；专项 Profile 不足时保留 2 张基线，不得因前端可滑动而凑数。
- 新计划恰好一张 `recommended: true`。用户明确表达时效或方法偏好时推荐对应 Profile；否则依次匹配 `remediation`、`decision`、`mixed_method`、`breadth`、`focused` 的任务信号；都未命中则推荐 `depth`。推荐只影响初始聚焦与标识，不自动替用户选择。
- Candidate Profile Resolver 先给出精确 Profile 列表和唯一推荐项，LLM 再按列表逐张填充步骤；LLM 返回的数量、ID、顺序不一致，或自行返回与 Resolver 冲突的推荐标记时即拒绝，最终推荐元数据由 Resolver 结果覆盖并冻结。
- Candidate Profile Resolver 只在 Problem Graph 和 Capability Resolver 完成后运行，以 Planning Guidance、问题覆盖、eligible active capability 和用户约束为输入；它不能回写或改判 Scenario。
- `orchestrator/planning-policy.yaml` 的 `candidate_generation_mode` 默认是 `fixed`。`fixed` 只生成 `speed/depth`；Gate 3 批准后才可切为 `dynamic`。关闭动态生成不影响历史 2–4 卡读取。
- 候选 ID 必须唯一；差异指纹必须覆盖 ordered actor sequence、问题/交付覆盖、证据路径，以及 ProfileSpec 的 `scope/method/evidence/review/output_emphasis`。两张候选未在各自 `required_difference_dimensions` 上形成差异，或仅标题、rationale、tradeoffs 不同时视为重复。
- 每张候选独立通过 Schema、Capability Resolver 结果约束和 PlanCompiler。初次校验后保留所有已通过候选，只把全部失败候选 ID 与合并错误清单放进一次纠错调用，不重新生成已通过卡片。合并纠错结果后再做一次跨卡差异校验；仍失败的专项卡直接丢弃并记录降级原因，不再发起生成调用，任一基线失败则 fail closed。

### 7.3 104 条重合 Knowledge

处置：默认 `map_existing`，仅存在实质新增内容时使用 `merge_into_existing`。

规则：

1. 以当前 `knowledge-base/` 路径、ID 和 frontmatter 为正典。
2. 逐节比较“适用场景、步骤、判断规则、误用、示例、输出格式”，只合并缺失的语义段落。
3. 不覆盖当前 `guide_tags`、`source_path`、`content_hash` 和受控元数据。
4. 不把标题变化、重复 H1、迁移说明或本地路径视为有效增量。
5. 每个合并项在 disposition 中记录来源路径、目标路径和被吸收的章节名。

### 7.4 24 条新增设计策略/体验方法

处置：原则上全部 `import_candidate`，但不把长短重复版本同时作为可召回条目。

目标位置：`knowledge-base/methods/toolbox/analysis/design-strategy/`。

归一规则：

- 模块卡片作为可检索正典；
- 同主题长文作为该卡片的 source reference 或保留在来源目录，不生成第二个召回项；
- 每个方法必须具备目标、适用条件、输入、步骤、输出、误用、证据边界和验证方式；
- “策略推导模型类”等长文中的独有模型必须拆到对应正典卡片，不整篇塞进 Prompt；
- 未经团队案例验证的通用方法保持 `candidate` 或 `draft`，不得称为京东标准。

优先接入的完整链路为：

`证据盘点 → 问题归因 → 策略分层 → 设计动作 → 优先级 → 验证计划`。

### 7.5 14 条模板

处置：全部 `import_candidate`。

目标位置沿用现有结构：

- 问卷题库：`knowledge-base/assets/question-bank/survey/`；
- 访谈话术：`knowledge-base/assets/question-bank/interview/`；
- 量表：`knowledge-base/assets/scales/`；
- 画布和案例卡：`knowledge-base/assets/templates/`；
- 经验打法：`knowledge-base/assets/playbooks/`。

Assets 继续不进入通用 Knowledge Index，只由明确引用它们的 Skill 加载，避免一次生成任务注入整个题库。

### 7.6 33 条机制与检查清单

分三类处置：

1. Skill 专属检查清单：`merge_into_existing`，进入对应 Skill 的 `references/quality-checklist.md`。
2. 与当前 Evidence Policy、Decision Graph、Report Rubric 一致且更具体的规则：合并到现有真相源，并增加测试。
3. 9 个正文相同的治理/证据/质量/降级文件：`reject_runtime`，不建立 9 个伪机制。

禁止建立第二套 Mechanism Registry。当前 `decision-graph.yaml`、`evidence-policy.yaml`、Deliverable Rubric 和代码校验器继续是生产规则真相源。

### 7.7 18 个重合 Skill

处置：`merge_into_existing`，绝不覆盖当前 active Skill 合同。

合并单位只允许是：

- 更清楚的触发和不适用条件；
- 缺失的执行步骤；
- 输出结构；
- 质量检查；
- fallback 与 human confirmation；
- 有效的知识引用。

以下字段始终以当前项目为准：

- Skill ID 和路径；
- `task_types`；
- inputs/outputs；
- required/optional tools；
- input/output/payload schema；
- active/draft 状态；
- 风险等级和审批边界。

每个 Skill 只做一次完整语义差异合并，不按章节反复审核。

### 7.8 7 个新增 Skill

第一版新增 active Skill 数量固定为 0。

| Hub Skill | 处置 |
|---|---|
| `competitor-strategy-analysis` | 合并独有策略判断到现有 `competitive-analysis` / `competitive-web-research`，拒绝重复激活 |
| `user-insight-synthesis` | 合并到 `synthesize-qualitative-insights`，拒绝重复激活 |
| `experience-walkthrough` | 合并到 `run-heuristic-evaluation` / `design-experience-review`，拒绝重复激活 |
| `trend-change-scan` | 合并触发和趋势扫描步骤到 `competitive-web-research`，拒绝重复激活 |
| `strategy-map-generation` | 保留为 draft Skill，并把策略地图方法接入现有报告链路；本版不激活 |
| `solution-generation` | 保留为 draft Skill；当前没有独立 Deliverable 合同，本版不激活 |
| `research-screenshot-analyzer` | `reject_runtime`；只保留文档来源，不接入 DesignPeek |

`experience-strategy-designer` 不作为第八个新 Skill 激活。它是覆盖用户、竞品、业务、数据、策略、汇报和工具 UI 的“大 Skill”，与现有深模块职责重叠。其方法、模板、质量规则和案例结构分别吸收到方法卡、现有 Skill reference、报告 Prompt 和 playbook；HTML、Node Server、`.command` 文件和工具原型全部 `reject_runtime`。

### 7.9 29 个 Case

完整案例正文保留在 Hub 来源，不直接作为方法正典或竞品事实来源。

- 29 个案例全部进入 disposition，并执行来源、评级、字段完整性和敏感级自动检查。
- 具备可核验来源且元数据一致的案例，可抽象为 `knowledge-base/assets/playbooks/` 下的案例卡。
- 案例卡只保留可迁移结构：背景、证据、问题、归因、策略、动作、取舍、验证、不可照搬边界。
- 原始业务数据、不可复查结论、本地绝对路径和一次性项目规则不进入案例卡。
- frontmatter 与正文评级冲突、来源不存在或验证结果为空的案例保持 `source_only`，不得为追求数量晋级。

### 7.10 9 条商详场域知识与 8 个 Domain Pack

现有 `knowledge-base/README.md` 明确不收业务背景和项目报告。该边界继续保留。

- 8 个空壳 Domain Pack：`reject_runtime`。
- 9 条商详知识：完整来源保持 `source_only`；可跨项目复用的页面结构、规则表达、指标口径和约束模式，抽象后进入 `assets/playbooks/product-detail/`。
- 涉及价格、库存、履约、交易、促销规则的内容必须带来源日期和适用范围，只能作为待确认上下文，不能成为永久事实。

### 7.11 Registry、Tools 与迁移记录

- Hub Registry：`reject_runtime`。当前 Registry 继续由当前 indexer 和手工原生能力合并生成。
- `06-tools-工具/`：`reject_runtime`，因为只有占位 README。
- DesignPeek V0.1 代码和压缩包：`reject_runtime`，不引入 Python Runtime、无鉴权服务或本地 JSON 并发存储。
- 迁移记录和 Hub E2E：`source_only`，只作历史参考，不作为测试收据或验收结果。

## 8. 规划、报告与运行时接入

### 8.1 不新增报告 Schema

现有 Competitive Analysis Schema 已有 `dimensionMatrix → differences → impacts → actionRecommendations → roadmap(metric/validationMethod)`；Design Audit Schema 已有 `issues → principles/severities → remediations → retests`。

因此第一版只调整：

- 相关 active Skill 的执行步骤和质量清单；
- `competitive-analysis-report.md`、`design-audit-report.md` 等现有生成 Prompt；
- 对应 Report Rubric 的 reasoning、recommendation 和 risk criterion；
- 报告内容组织，不修改公开 payload 字段。

候选方案 Schema 的扩展属于规划合同，不改变任何 Deliverable payload。

### 8.2 策略链强约束

报告中每项建议必须满足：

1. 能反查一个或多个已确认差异/问题；
2. 区分观察事实、推断和待验证假设；
3. 说明作用对象、具体触点和设计动作；
4. 给出优先级及其用户影响、业务影响、成本/风险依据；
5. 给出指标和验证方法；
6. 不以单一案例或知识库内容证明当前竞品事实。

### 8.3 Scenario 的运行时边界

- Scenario 不成为新的任务状态，也不写入数据库。
- Scenario 的触发语句同时用于 Planning Guidance 识别、现有 Skill `when_to_use` 和评测 case。
- Scenario 的输入、依赖和默认/按需能力用于 Profile 选择，但最终只能调用 Capability Resolver 判定为 eligible 的 active 能力。
- Scenario 的完成标准用于候选 step acceptance criteria、Skill acceptance criteria 和报告 Rubric。
- `task_type`、Deliverable 和 Evidence Policy 继续决定真实执行边界。

### 8.4 动态候选合同与历史兼容

- `current-plan-candidates.schema.json` 从位置固定的 2 项 tuple 改为 2–4 个同构 candidate；ID 枚举为 7 个受控 Profile，并由代码校验 ID 唯一、数量和 Profile Resolver 输出完全一致。
- `recommended` 在通用 Schema 和 TypeScript 类型中为可选字段，以便旧历史计划继续解析。兼容 reader 永久接受 0 个或恰好 1 个 `recommended: true`；阶段 C 启用后的生产 writer 必须在写入前强制恰好 1 个。
- `current-execution-plan.schema.json` 的 `candidate_metadata` 增加可选 `recommended`，并增加可选顶层 `planning_provenance`；PlanCompiler 将推荐、Scenario/信号引用、Resolver/Mapping 版本哈希和降级原因原样冻结进计划版本，旧计划缺少这些字段仍合法。
- 不给 `CurrentPlanCandidate` 响应新增顶层字段。前端从响应中原有的 `candidate.plan.candidate_metadata.recommended` 读取推荐标记，因此 endpoint、响应 envelope 和选择请求均不变。
- 阶段 B 的 routed/direct 生产 writer 保持原状，继续生成无推荐字段的 `depth/speed`；阶段 C 才统一写入 `depth: recommended=true`、`speed: recommended=false` 或 Resolver 选定的动态推荐项。
- `candidate_id` 数据库列继续使用现有 `TEXT`，不做 migration。Control Plane reader 改为验证 2–4 个唯一受控 ID、连续 plan version，以及“推荐项为 0 或 1 个”的兼容合同，不再假设固定顺序为 depth/speed；阶段 C 的 ControlPlanningService 在调用 repository 前执行“新写入恰好 1 个”的强约束。
- API endpoint、请求体和选择动作不变；响应中的 `candidateId` 类型扩展为受控 Profile，用户选择继续只提交 `planVersionId`。
- 新候选按 Profile Resolver 顺序持久化；前端初始聚焦 `recommended`，用户手动选择仍覆盖初始聚焦。旧计划没有推荐字段时聚焦第一项且不补写历史数据。
- 前端 Profile 标签使用显式映射，未知值显示安全的通用标签并记录合同错误，禁止继续用“非 depth 即 speed”的二分逻辑。
- revision 必须请求保留已选候选的 Profile；新指令使该 Profile 不再 eligible 时，后端返回 HTTP 409 和稳定错误码 `candidate_profile_no_longer_eligible`，前端重新展示候选选择并保留旧计划只读，不静默换 Profile。
- `planning_provenance` 只包含受控 ID、字段路径和版本哈希，不返回完整用户输入；读取旧计划时缺失该字段不补写。
- clarification replacement、历史恢复、重新生成和 revision 均接受 2–4 个候选；直呼 Skill 仍固定生成 `depth/speed`，默认标记含独立复核的 `depth` 为推荐项。

## 9. 接入工具与文件接口

### 9.1 新增文件

- `knowledge-base/.sources/user-research-hub-2026-08-21.yaml`：唯一 disposition 与来源映射真相源；记录文件、语义实体、附件、孤儿项及其分组处置。
- `schemas/user-research-hub-disposition.schema.json`：约束处置枚举、来源/目标路径、哈希、理由、生产状态，以及 `sensitivity/distribution_scope/owner/retention/source_rights`。
- `scripts/user-research-hub-integration.ts`：提供 `inventory`、`check`、`apply` 三个确定性子命令。
- `tests/user-research-hub-integration.test.ts`：覆盖已知坏 YAML、路径转换、重复映射、拒绝项和幂等。
- `tests/user-research-hub-disposition.test.ts`：覆盖来源实体完整性、数据治理字段、部署包负向清单和零未处置项。
- `tests/user-research-hub-package-boundary.test.ts`：构建实际发布文件清单，断言 `00-source-sync`、完整 Case 原文和 source-only/reject_runtime 内容不进入产物。
- `schemas/scenario-guidance.schema.json`：约束主/次 Scenario、关系、置信度、受控 signal 和来源字段路径，只允许 approved Scenario ID。
- `orchestrator/planning-policy.yaml`：内部生产策略，固定 `candidate_generation_mode: fixed | dynamic`、ProfileSpec 版本和映射哈希；默认 `fixed`。
- `apps/orchestrator-runtime/src/planners/planning-guidance.ts`：对外只暴露一个 Planning Guidance 解析接口，内部封装规则识别、必要时的一次 LLM 分类、Candidate Profile 选择与 provenance 生成，不新增 Agent 或服务。
- `tests/planning-guidance.test.ts`：覆盖 90 条数据集拆分、15 个 Scenario、歧义、clarification、ProfileSpec 信号来源、数量、推荐、capability 过滤、provenance 和降级。
- `tests/planning-policy.test.ts`：覆盖默认 fixed、Gate 后 dynamic、关闭新生成但继续读取历史动态计划。

### 9.2 修改文件

- `knowledge-base/README.md`：增加来源、candidate 生命周期、设计策略方法、Scenario `candidate_profiles` 和来源边界。
- `knowledge-base/taxonomy.yaml`：增加 `candidate` 状态和必要的设计策略标签。
- `apps/orchestrator-runtime/src/knowledge/taxonomy.ts`：读取并暴露受控状态词表。
- `apps/orchestrator-runtime/src/knowledge/index.ts`：生产 loader 物理排除 candidate/deprecated，Evaluation 使用独立 loader；不向生产搜索接口暴露 visibility 开关。
- `apps/orchestrator-runtime/src/knowledge/indexer.ts`：保留 candidate 状态并生成可审计索引。
- `harness/linters/knowledge-linter.ts`：校验状态、来源映射、绝对路径、Scenario Profile 引用和 candidate 生产隔离；Profile 合法值从候选 Schema 读取，不另造枚举。
- `apps/orchestrator-runtime/src/runtime/schema-registry.ts` 与 `runtime/llm-client.ts`：注册 Scenario Guidance Schema，并为离线测试提供严格 fixture；不在生产伪造识别结果。
- `schemas/current-plan-candidates.schema.json`：候选数量改为 2–4、扩展受控 Profile，并以可选 `recommended` 兼容旧计划。
- `schemas/current-execution-plan.schema.json`：在 candidate metadata 中保留可选推荐标记，并增加向后兼容的最小 `planning_provenance`。
- `packages/api-contract/plan.ts`、`http.ts`、`control-workflow.ts`：统一 `CandidateProfile` 类型并移除 depth/speed 二值假设，不改变 endpoint。
- `apps/orchestrator-runtime/src/planners/routed-planner.ts`：注入 Planning Guidance、按 Resolver 给定 Profile 生成候选、限制一次纠错并执行差异校验。
- `apps/orchestrator-runtime/src/planners/direct-planner.ts`：保持固定 `depth/speed` 步骤，只补充唯一推荐元数据，不接入 Scenario 或专项 Profile。
- `apps/orchestrator-runtime/src/planners/plan-compiler.ts`：接受受控 Profile 并冻结推荐元数据，保持每张候选独立编译。
- `apps/orchestrator-runtime/src/control/control-planning-service.ts`、`control/task-workflow.ts`：将“恰好 depth/speed”改为 2–4 个唯一受控 Profile 和一个新计划推荐项。
- `database/control-plane.ts`：移除读取、排序、replacement、revision 中的 depth/speed 假设；继续使用现有 `TEXT` 列和 plan version 顺序，无 migration。
- `apps/agent-api/src/control-runtime.ts`：revision 保持当前 Profile，不可用时返回重新选择冲突。
- `apps/orchestrator-runtime/src/spike-plan.ts`：开发 CLI 帮助文本从固定 `<depth|speed>` 改为打印本次真实候选 ID，不扩展其生产职责。
- `apps/web/src/components/stages/Stage2Candidates.tsx`、`current-flow-state.ts`、`theme.css`：动态标签、推荐标识、推荐初始聚焦及 2–4 张历史恢复；保留现有 Embla 交互和无障碍导航。
- `apps/orchestrator-runtime/src/gold-run.ts`：将现有 Gold 从“第一条 clear fixture”改为精确选择新 ID `competitive-digital-human-gold`，并同时断言 profile、variant 与 PII，不改变 Gold 的其他合同。
- `tests/fixtures/current-semantic-gold.json` 与 `tests/gold-run.test.ts`：保留现有 ambiguous `competitive-digital-human`，新增独立 clear fixture `competitive-digital-human-gold`，并验证调整 fixture 顺序不会改变 Gold。
- 对应 Knowledge、Scenario、Asset、Skill reference、Report Prompt 和 Rubric 文件。

总变更会超过 8 个文件，并包含数十个内容文件及现有候选合同的跨层兼容修改；但不新增服务、数据库 migration、HTTP endpoint 或外部依赖。内容文件由 disposition 驱动批量生成和核对，禁止手工逐个复制。

## 10. 三个实施阶段

每个阶段完成后都可独立合并；后续阶段停止不会使前一阶段处于不可用状态。

### 阶段 A：来源冻结与处置清单

产出：

- 只读盘点脚本和 disposition schema；
- 完整来源清单、哈希、类型、实体/附件归属和处置；
- 104 条 Knowledge 与 18 个 Skill 的现有映射；
- 7 个 Candidate Profile 的候选语义草案、2–4 数量边界，以及覆盖 15 个 Scenario 的 Profile 可分辨性报告；Profile 枚举和映射在 Gate 2 前不冻结；
- Gold 精确场景修复：新增 `competitive-digital-human-gold` clear fixture，并让 `gold-run.ts` 按 ID/profile/variant/PII 精确选择；
- 所有 reject/source-only 分组；
- 不修改 Runtime 和现有知识内容。

完成条件：

- Registry 实体 100% 有处置；
- 整理层全部文件均关联到实体、附件分组或有理由的孤儿项；
- `00-source-sync` 数量和 manifest/hash 一致；
- 169 个解析错误全部被记录为已知转换规则，不被静默忽略；
- 15 个 Scenario 均有非空的 Profile 映射草案，且只引用候选 Profile 值；可分辨性报告列出每个专项 Profile 相对 `speed/depth` 的 `required_difference_dimensions`；
- Gold 顺序漂移测试通过，且不会改变 ADR 规定的审批和全真边界；
- 无 `unreviewed`、无空目标、无一对多正典冲突。

阶段 A 合并后只增加可追溯盘点能力和独立 Gold 场景选择修复，对产品规划与报告行为零影响。

### 阶段 B：候选内容归一与隔离

产出：

- Candidate 生命周期和 Runtime 隔离；
- 新增方法、Scenario、模板、draft Skill 和通过条件的案例卡；
- 重合知识/Skill 的语义差异报告和候选合并稿；
- 质量清单的候选 reference；
- 未接入生产调用的 Planning Guidance 深模块、Scenario Schema 和 90 条语义路由数据集；数据集在任何规则/Prompt 调整前按场景和难度分层锁定为 `60 calibration / 30 holdout`；
- 7 个完整 ProfileSpec、15 个 Scenario 映射、受控 signal 词表和 `required_difference_dimensions`；
- 向后兼容的 2–4 候选 Schema、最小 `planning_provenance`、API 类型、Control Plane reader 和前端渲染；生产生成器仍只产生原有 depth/speed；
- 默认 `candidate_generation_mode: fixed` 的 Planning Policy；
- Knowledge Index 与 Registry 可重复构建。

完成条件：

- 导入结果幂等；
- 全部目标 Markdown 解析成功；
- 当前 104 条知识和 22 个 active Skill 数量不因重复导入膨胀；
- candidate 不被生产 Knowledge loader 或 `listSkills()` 返回；Gate 2 后 Knowledge 仍保持 candidate；
- Planning Guidance 的 low/冲突结果只进入现有 clarification，不产生候选；唯一 high-confidence 规则结果不增加 LLM 调用；
- 60 条 calibration 可用于调整规则和 Prompt，30 条 holdout 在 Gate 3 前不可读取预期标签；
- 旧 depth/speed 任务仍能规划、选择、revision 和历史恢复；无推荐字段的旧 fixture 与恰有一个推荐项的 2/3/4 张动态 fixture 均可通过 Schema、持久化和前端组件测试；
- 无本机绝对路径、无无效 source ref、无占位 Mechanism/Tool 进入目标树。

阶段 B 不修改现有 active Skill、生产生成 Prompt 或 Rubric。合并后 reader/UI 能向后兼容动态 fixture，新内容可被显式评测，但用户实际规划仍只生成原有 depth/speed。

### 阶段 C：分步生产接入与批量晋级

阶段 C 保持一个人工 Gate，但拆成两个可独立审定、可独立回滚的 release slice。两者在 Gate 3 前只存在于受控 release branch/evaluation overlay，不提前进入生产 `main`；Gate 3 可以批准 C1、拒绝 C2，而不要求再次召开内容审核。

#### C1：内容增强，候选仍固定

产出：

- 从 Gate 2 冻结的候选差异生成 evaluation overlay，包含现有 Skill 的触发、步骤、输出和质量规则增强；
- Gate 2 批准的 Skill 语义差异、质量 reference、报告 Prompt 和 Rubric 只在 evaluation loader 中生效，生产文件保持当前版本；
- Knowledge candidate 保持 candidate，形成待晋级 promotion set；生产仍保持当前内容、`candidate_generation_mode: fixed` 和 `speed/depth` 两张卡；
- 固定任务的“当前基线 / 内容增强 only”对照报告。

C1 完成后，内容增强可以被单独评测和批准，但 Gate 3 前不进入生产。若 C1 通过而 C2 失败，Gate 3 可只批准 C1 的 promotion/Skill/Prompt/Rubric commit，生产继续固定两卡。

#### C2：动态候选激活

产出：

- Planning Guidance 接入常规 RoutedPlanner，Candidate Profile Resolver 决定 2–4 张卡片并传入精确 ProfileSpec；
- routed/direct 生产 writer 在写入前补齐唯一推荐元数据；直呼 Skill 固定推荐 `depth`，常规 routed task 使用 Resolver 结果；
- 重新生成、revision 和 clarification replacement 的生产 writer 使用同一个 Candidate Profile Resolver；
- 计划持久化最小 `planning_provenance`；
- “动态候选 only / 内容增强 + 动态候选”两组对照结果；
- Gate 3 同时决定两个独立 activation：C1 通过时才把 Knowledge promotion set 从 `candidate` 晋级为 `approved` 并合入 Skill/Prompt/Rubric 差异；C2 通过时才将 `candidate_generation_mode` 从 `fixed` 切为 `dynamic`；
- 固定场景测试、KB-aware 对照和真实任务审计包。

完成条件：

- 不新增 active Skill；
- 不改变 5 个 `task_type`、Deliverable Schema、endpoint 或 `planVersionId` 选择协议；
- 常规 RoutedPlanner 按规则产出 2–4 张、恰好一张 recommended，直呼 Skill 仍为两张；
- 所有候选覆盖相同 required questions、required evidence 和必需 deliverables，并在 ProfileSpec 指定维度上形成差异；
- 新旧候选均可读取、选择和 revision，动态生成关闭后历史动态候选仍可查看；
- 不存在 draft/planned 能力、Profile 外 ID 或无 provenance 的新计划；
- 内容增强 only 与动态候选 only 的影响可分别归因，组合结果不掩盖任一单项回退；
- 建议能够形成完整证据—策略—动作—指标链；
- 真实任务满足项目既有 P0 通过批次标准。

阶段 C 只有经 Gate 3 批准的 slice 才可合并到生产 `main`。任何 C2 问题可通过 Planning Policy 恢复固定两卡，而不回滚已单独批准的 C1 内容增强或历史 reader。

## 11. 审核规范：只设 3 个关键审核点

### 11.1 审核与自动检查的区别

- 自动检查：lint、schema、hash、路径、单测、快照和差异报告，可在开发中反复运行，不需要人工确认，不算审核。
- 人工审核：对范围、方法语义或生产结果作批准/拒绝判断，只在以下 3 个 Gate 发生。
- Commit、文件修改、单测修复和文案调整本身不得触发人工审核。

### Gate 1：范围与处置冻结

触发时机：阶段 A 全部完成后。

审核对象：

- 各类内容的处置规则；
- 所有例外项；
- 未被 Registry 登记的附件与孤儿项分组；
- 104/18 重合映射；
- 2–4 数量上限、`speed/depth` 稳定基线和“LLM 不决定数量/ID/顺序”的系统边界；7 个 Profile 与 Scenario 映射在本 Gate 只作为可分辨性草案，不冻结；
- reject/source-only 清单；
- 来源完整性和哈希。

审核方式：

- 机器检查全部实体；
- 人工审核分类规则和异常清单，不逐个阅读 `00-source-sync` 文件；
- 产品/平台维护者确认生产边界，知识负责人确认保留范围。

通过标准：100% 有处置、无未知来源、无错误覆盖当前正典、硬拒绝项完整；来源范围、处置枚举、2–4 数量上限和确定性控制边界无未决项。本 Gate 不批准 Profile 枚举或逐条 Scenario/Profile 语义。

Gate 1 通过后只冻结 source manifest hash、处置枚举、目标正典映射、`speed/depth` 基线和候选数量上限。来源集合、处置规则或数量边界变化才重新打开 Gate 1；ProfileSpec 和 Scenario 映射归 Gate 2。

### Gate 2：内容与合同审定

触发时机：阶段 B 的全部内容和代码一次性完成后，尚未晋级或接入生产前。

审核对象：

- 24 条新增方法；
- 15 个 Scenario；
- 15 个 Scenario 的 `candidate_profiles` 语义映射、专项 Profile 默认顺序和完整 ProfileSpec；
- 7 个 Profile 的范围、方法、证据、复核、输出侧重点、步骤预算和 `required_difference_dimensions`；
- 14 条模板；
- 104 条重合 Knowledge 中所有拟执行的 `merge_into_existing` 语义差异；
- 18 个 Skill 的语义合并差异；
- 7 个新增 Skill 的处置；
- 实际拟晋级的案例卡；
- Planning Guidance Schema、置信度/clarification 规则、受控 signal、最小 provenance、候选差异与一次纠错合同；
- 90 条样本的数据划分、标签和 holdout 封存结果；
- 2–4 候选兼容合同、recommended 语义、revision/profile 保持和旧历史读取；
- candidate 隔离、frontmatter 和来源合同。

一次性风险分层审核规则：

- 100% 审核所有将影响 active Skill、Prompt、Rubric 的内容；
- 100% 审核新增方法和 Scenario 的目标、步骤、边界、来源及 Profile 映射；
- 100% 审核 14 条模板及所有 `merge_into_existing` 差异；同一内容不因同时被方法、Skill 或 Prompt 引用而重复审核，只复用同一 content hash 的审定结果；
- Case 全量做机器校验，只人工审核拟晋级案例卡；未抽象晋级的完整案例保持 source-only；
- 100% 审核价格、库存、履约、交易、隐私等高风险内容；
- 不审核 `source_only` 原始镜像正文。

责任人：知识负责人批准内容与 Scenario 映射，编排维护者批准 Planning/Candidate 合同；两者在同一 Gate 2 审核包上签结论，不拆成两轮 Gate。

通过标准：eligible 内容无错误来源、无重复正典、无占位、无事实冒充方法；ProfileSpec 能形成可验证的完整方案差异；candidate 隔离、planning provenance、旧历史兼容和动态 fixture 测试通过；Knowledge 仍未晋级 approved，Planning Policy 仍为 fixed。

Gate 2 通过后冻结 canonical content hash、Scenario/Profile mapping hash、ProfileSpec、Candidate contract、Skill delta、90 条数据集划分和 promotion set。普通文字修正不得重新审核全部内容。

### Gate 3：生产激活审定

触发时机：阶段 C 完成、所有离线测试通过后，合并生产行为前。

审核对象：

- 生产 promotion set；
- 现有 Skill/Prompt/Rubric 的最终差异；
- 动态候选的 Profile、推荐项、差异说明和前台选择/历史恢复效果；
- 固定输入的前后对照报告；
- 三次真实任务运行及独立研究员评审。

验证批次：

1. 对封存的 30 条 holdout Scenario 样本执行一次盲测；60 条 calibration 只用于此前规则/Prompt 调整。完整 90 条数据集由 60 条单 Scenario 正反例、15 条多 Scenario/关系样本、10 条应 clarification 的歧义样本和 5 条 direct-Skill bypass/无匹配样本构成。
2. 五类现有 `task_type` 各运行固定 2/3/4 卡 fixture，验证恰好一个 recommended、ProfileSpec 差异、必需交付覆盖、选择、revision、clarification replacement、刷新后历史恢复和旧 depth/speed 兼容；直呼 Skill 仍为两张。
3. 对同一冻结输入、模型、Tool fixture、报告合同和 Rubric 运行四组对照：当前基线、内容增强 only、动态候选 only、内容增强 + 动态候选。使用“主流电商 AI 购物助手消费者决策支持对比与京东下一季度优先级建议”作为固定样本；组合组预期主 Scenario 为竞品与标杆研究、次 Scenario 为优先级与实施路径，按稳定顺序生成 `speed/depth/decision` 三张候选并推荐 `decision`。浏览器图片要求保持关闭。
4. 五类现有 `task_type` 各执行一次真实 Current Smoke，用于验证跨场景基础设施、来源和交付合同；这些样本只证明代表性可运行，不替代 P0 Gold 或宣称覆盖全部 15 个 Scenario。
5. 使用精确 ID `competitive-digital-human-gold` 锁定 P0 金标“直播场域数字人竞品研究”，在自动确认前断言计划不含 `requires_approval`，并通过 `pnpm gold:run collect <batch_id>` 连续完成三次全真运行；不得以普通 Smoke、电商 AI 样本或原 ambiguous fixture 替代。
6. 独立研究员逐次判定三份 Gold 报告是否可用，并核验来源、策略推导、优先级和验证指标；另对 holdout 动态候选集做盲评，判断卡片是否有实质差异、推荐项是否合理，随后执行 Gold batch decide。

责任人：独立研究员只负责三份报告的可用性判定；Gate owner 汇总自动检查、合同结果和研究员结论后批准或拒绝生产激活，任何实现 owner 不得代替独立研究员判定。

通过标准：

- 三次 Gold 至少两次可用，且任一次均无来源伪造、敏感信息泄漏或确认闸门绕过；
- holdout 主 Scenario macro-F1 ≥ 0.85，任一 Scenario recall ≥ 0.70，blocking clarification 漏判为 0；
- 非法 Profile、重复 candidate、缺失 planning provenance、必需交付缺失和 PlanCompiler 失败均为 0；
- 独立研究员认为动态候选“有实质差异”的集合比例 ≥ 80%，推荐项可接受率 ≥ 80%；
- 内容增强 only 不降低固定两卡的研究员可用性；动态候选 only 和组合组不得掩盖内容组回退；
- 需要 LLM 消歧的 routed planning 最多增加一次调用；唯一高置信规则路径新增调用为 0。记录相对基线的 p95 延迟和 token 增量，任一超过 30% 时保持 `fixed` 并重新压缩分类上下文；
- 新旧计划均可选择、revision 和历史恢复，且不存在非 depth 被显示为 speed 的标签错误；
- 每项优先级建议能反查差异/问题及证据，每项路线图建议含指标和验证方法。

Gate 3 通过后才允许把 Knowledge promotion set 晋级为 `approved` 并将 Planning Policy 切到 `dynamic`。任一指标未通过时保持 `candidate` 与 `fixed`，不得部分开放掩盖失败。

### 11.2 失败后的复核规则

- 每个 Gate 只产生一份合并问题清单，问题一次性修复，不按单个修改重新送审。
- 修复期间只运行自动检查；修复批次结束后，人工只复核发生语义变化的条目和其直接依赖。
- 已通过 Gate 不因后续无关修改重新打开。
- 只有 frozen manifest、Schema/合同、promotion set 或真实输出语义发生变化，才重新打开对应 Gate。
- Gate 3 出现项目定义的 P0 硬失败时，必须按现有规则修复并重新执行完整三次真实运行；这是唯一允许强制重开整 Gate 的情况。

## 12. 测试矩阵

| 层级 | 必测内容 |
|---|---|
| Source inventory | 文件数、Registry 实体数、实体/附件/孤儿归属、manifest/hash、来源缺失、路径越界、敏感信息/PII/source rights，以及部署产物不含 source-only/reject_runtime |
| YAML migration | 169 个 `[LOCAL_HOME]` 已知错误、未知 YAML 错误 fail closed、原文不被静默改写 |
| Disposition | Registry 实体与整理层文件 100% 覆盖、合法枚举、唯一目标、reject 不进目标树、map/merge 目标存在 |
| Normalization | 幂等、ID 唯一、source/hash、导航跳过、candidate 保留 |
| Search isolation | 生产 loader 物理排除 candidate/deprecated且无 visibility 参数；Evaluation 独立 loader 显式包含 candidate |
| Registry | 22 个现有 active Skill 不减少、不重复；新 Skill 均非 active |
| Knowledge | 104 条现有条目不重复；新增索引只来自 disposition |
| Skill merge | 现有 schema/tool/task_types/status 不被 Hub 覆盖 |
| Scenario guidance | 90 条冻结数据集的 calibration/holdout 隔离、主/次 Scenario、置信度、受控 signal、字段路径、同 Profile 歧义继续、异 Profile 歧义 clarification、最小 provenance |
| Profile resolver | 15 个有序映射、完整 ProfileSpec、speed/depth 基线、必需交付覆盖、2/3/4 数量、4 卡显式请求约束、active capability 过滤、确定性 recommended、固定顺序、最多一次纠错、唯一规则路径零额外 LLM 调用 |
| Candidate contract | 旧 2 张和新 2–4 张 Schema、ID 唯一、ProfileSpec 差异、planning provenance、逐张 PlanCompiler、连续 plan version、无 DB migration |
| Selection/revision | `planVersionId` 选择不变、revision 保持 Profile、Profile 失效返回稳定 409 并重选、clarification replacement 支持动态集合 |
| Frontend/history | 2/3/4 张轮播、标签、推荐初始聚焦、键盘/圆点/箭头、刷新恢复、旧计划无 recommended 兼容 |
| Report | difference→impact→recommendation→roadmap 和 issue→remediation→retest 链完整 |
| Evidence | 方法/案例不冒充当前事实；外部事实仍依赖真实 Tool Evidence |
| Experiment attribution | 当前基线、内容增强 only、动态候选 only、组合组四组固定输入；同模型、Tool fixture、报告合同和 Rubric |
| Regression | `pnpm quality`、KB-aware evaluation、90 条 Scenario 数据集、五类真实 Smoke、真实金标批次 |

关键命令：

```text
node -v
pnpm -v
pnpm exec tsx scripts/user-research-hub-integration.ts check
pnpm kb:build
pnpm lint:knowledge
pnpm lint:registry
pnpm exec tsx --test tests/user-research-hub-*.test.ts tests/knowledge-*.test.ts tests/kb-*.test.ts
pnpm exec tsx --test tests/planning-guidance.test.ts tests/current-plan-candidate-schema.test.ts tests/control-planning-service.test.ts tests/current-flow-state.test.ts tests/current-revision-integrity.test.ts
pnpm eval:skills:kb
pnpm eval:skills:kb:compare
pnpm quality
CURRENT_SMOKE_PROFILE=competitive_research CURRENT_SMOKE_SCENARIO=competitive-ai-shopping-assistant PLAYWRIGHT_CAPTURE_ENABLED=0 CURRENT_REQUIRE_BROWSER_EVIDENCE=0 ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm smoke:current:real
ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm gold:run collect <batch_id>
pnpm gold:run review <batch_id> <attempt_id> <usable|needs_revision|unusable>
pnpm gold:run decide <batch_id>
```

`<batch_id>` 使用 `YYYYMMDD-user-research-hub-gate3-<short-build-id>`；三个 `<attempt_id>` 取自 collect 的真实输出，不人工编造。

本方案不新增凭据，但 Gate 3 必须在开始前一次备齐以下既有条件：

- `DATABASE_URL`：指向受控测试 PostgreSQL，不得使用生产库；
- `JWT_SECRET`：真实 Smoke 的 API 签名密钥；
- `LLM_GATEWAY_BASE_URL`、`LLM_GATEWAY_API_KEY`、`LLM_MODEL_NAME`、`LLM_EXPECTED_ACTUAL_MODEL`：真实 Gateway 地址、访问凭据和模型漂移 pin；
- `TAVILY_API_KEY`：公开网页检索的真实 Tool 凭据；
- `GOLD_REVIEWER_JWT`：只在 review 阶段临时注入，身份必须属于与 Skill/Tool owner、operator、editor 独立的研究员；
- `GOLD_BUILD_ID`：可选、非密钥；未设置时使用当前 Git HEAD，同一 batch 内不得变化；
- 到京东 LLM Gateway、Tavily 和受控 PostgreSQL 的网络连通性；
- `orchestrator/gold-policy.yaml` 的 `trusted_gold_enabled` 当前为 `false`。Gate owner 只能在上述条件和三次独立评审安排就绪后，于 Gate 3 内按现有 Gold 流程开启；这不是第四个审核点，接入代码不得自行绕过或自动开启该开关。

## 13. 回滚与失败处理

### 13.1 阶段回滚

- 阶段 A：撤销 manifest/schema/script commit；无 Runtime 或数据影响。
- 阶段 B：回滚内容与兼容代码 commit，或保留 candidate 后重建 evaluation index；此时 Knowledge 尚未晋级 approved、Planning Policy 仍为 fixed，生产行为不变，无需数据库迁移。
- 阶段 C1：将 promotion set 保持/降回 candidate，回滚 Skill/Prompt/Rubric 内容 commit，动态生成仍为 fixed，不影响阶段 B reader。
- 阶段 C2：先把 `candidate_generation_mode` 切回 `fixed`，停止新动态生成，再按需要回滚 Planning Guidance 接线；现有 22 个 Skill 和 5 个 Deliverable 保持原样。
- 一旦生产已持久化 `recommended`、`planning_provenance` 或动态 Profile，rollback 必须保留扩展后的 Schema reader、Control Plane reader、API 类型和前端标签兼容，只关闭新动态生成；不得回写、删除动态 plan version 或清理推荐/来源字段。
- Gold Scenario pin 只修复既有验收漂移；若该修复需回滚，Gate 3 同时失效，不得回退到“第一条 clear fixture”的隐式选择后继续验收。

### 13.2 来源恢复

- `wiki/user-research/` 不被修改或删除，因此所有语义合并都可反查原文。
- Import manifest 保存来源哈希和目标路径，可检测目标漂移。
- 不使用 destructive move，不以生成后的 Knowledge Base 替代原始来源。

### 13.3 失败降级

- 来源解析失败：记录并停止该条目导入，不影响其他条目。
- 重复正典无法判断：保持 source-only，不猜测合并目标。
- 方法质量不足：保持 candidate，不影响生产。
- Skill 无独立输出合同：保持 draft，不注册 active。
- Scenario LLM 返回非法或无依据结果：若规则层已有 high-confidence 唯一结果则使用规则结果；否则进入现有 clarification，不生成卡片。
- 专项 Profile 的任务信号缺失或所需能力不可用：删除该专项 Profile 并保留 `speed/depth` 基线，不制造替代卡；任一基线无法覆盖 required questions 或通过 PlanCompiler 时 fail closed。
- 动态候选一次纠错后仍不合格：若本轮 `speed/depth` 已分别通过全部校验，丢弃失败专项卡并降为两张，不再调用模型；任一基线不合格则 fail closed。
- revision 时原 Profile 失效：保留旧计划可读，返回重新选择冲突，不静默换卡。
- 真实评测失败：不晋级，现有 Runtime 继续使用原内容。
- Gate 3 为验收临时开启 `trusted_gold_enabled` 时，批次结束或中止后按 gate owner 的既有发布决定恢复；本接入不得把 Gold 开关状态作为生产功能依赖。

## 14. 明确拒绝项

以下内容即使用户要求“尽量完整保留”，也只保留来源，拒绝接入生产：

1. `00-source-sync` 的整目录 Runtime 导入。
2. Hub 手写 Registry 覆盖当前派生 Registry。
3. 25 个 draft Skill 一次性激活。
4. 8 个没有整理内容的 Domain Pack。
5. 9 个正文相同的伪机制文件。
6. `06-tools-工具` 的占位目录。
7. DesignPeek V0.1 服务、压缩包、Python Runtime 和无鉴权 API。
8. `experience-strategy-designer` 的 HTML、Server、`.command` 和重复工具原型。
9. 无效 `[LOCAL_HOME]`、本机绝对路径和不存在的 source reference。
10. Hub E2E 报告作为当前项目上线证明。
11. 把项目案例或知识库内容当作 2025—2026 外部竞品事实。
12. 新增 5×15 状态机、数据库表或新的 `task_type`。
13. 新建 Candidate Agent、Profile Registry、独立 Planner 服务或动态卡片数据库表。
14. LLM 自由生成候选 ID、数量、排序或超过 4 张卡片。
15. 为每个 Scenario 固定生成一张卡，或用相同步骤制造伪差异。
16. 让 `speed` 跳过 required evidence、隐私规则、确认闸门或来源校验。
17. 为生成某个 Profile 激活 draft/planned Skill，或把 unavailable optional Tool 变成关键依赖。

## 15. 实施工作量

| 工作 | 预计人日 |
|---|---:|
| 阶段 A：自动盘点、数据治理、Profile 可分辨性报告、Gold pin、Gate 1 | 3–5 |
| 阶段 B：归一器、candidate 双 loader 隔离、ProfileSpec/Provenance、跨层兼容、内容合并稿、Gate 2 | 8–12 |
| 阶段 C1：内容/Skill/Prompt/Rubric 单变量接入与对照 | 3–5 |
| 阶段 C2：动态生成接线、Planning Policy、90 条评测、真实任务与 Gate 3 | 4–6 |
| 工程合计 | 18–28 |
| 知识负责人/独立研究员审核 | 另计 3–5 人日及真实运行排期 |

工作量的主要来源不是前端轮播，而是 8,491 个来源文件的可追溯盘点、数百个语义处置项，以及现有 Schema、PlanCompiler、Control Plane、revision、clarification replacement、历史恢复和测试中的 depth/speed 假设。Gate 2 的 100% 高风险内容审核和 Gate 3 的真实运行依赖独立人员排期，不能压缩进工程编码人日；人工审核仍集中在 3 个窗口内，不按修改次数重复审核。

## 16. 最脆弱假设

最脆弱假设是：7 个完整 ProfileSpec 能在 15 个 Scenario 上稳定产生有实质差异、由当前 active capability 支撑且仍覆盖全部必需交付的候选路径。Gate 2 的可分辨性报告和 Gate 3 holdout 盲评必须证伪这一假设：若“有实质差异”的候选集合低于 80%，或任一 Profile 无法在其 `required_difference_dimensions` 上稳定成形，Planning Policy 保持 `fixed`，系统继续只生成 `speed/depth`，Scenario 仅用于编排、完成标准和报告方法，不得为维持 3–4 张展示制造伪差异。

第二个来源假设是 `wiki/user-research/` 可以继续作为只读来源保留，并且不会被生产部署打包。如果该目录必须从仓库删除，必须先生成可恢复归档、记录整体哈希并完成一次恢复演练；否则 disposition 只能证明“曾经存在”，无法继续提供可追溯原文。该变化会重新打开 Gate 1，但不会改变后续 Knowledge Base 和 Runtime 设计。

## 17. 备选方案与拒绝理由

### 推荐方案：受控迁移、完整 ProfileSpec/Provenance 与分步动态候选

优点：最大限度保留内容、让 Task 真正影响前台方案、当前架构不分叉、候选数量有硬上限、生产影响可控、可批量审核和回滚。

### 最小方案：只接入设计策略方法和模板

只迁移 24 条方法和 14 条模板，并继续固定 depth/speed，不处理 Task、Scenario、Skill 和 Case。开发量较小，但会丢失任务语义、动态方案价值、质量清单和案例推导结构，不满足已确认需求，因此不推荐。

### 拒绝方案：由 LLM 自由决定卡片

让模型自行决定 1–N 张卡片和任意候选名称，表面灵活，但无法保证数量、差异、历史兼容、revision 或能力真实性；失败时还会诱发反复重试，明确拒绝。

### 拒绝方案：整体镜像 Hub 六区并直接启用 Registry

该方案会制造第二套 Task/Registry/Mechanism/Tool 真相源，引入 169 个解析错误、全部 draft 能力、空壳 Domain 和占位 Tool，并使当前可信执行合同失效，明确拒绝。

## 18. 批准后的执行方式

本文件同时承担架构、处置、实施阶段和审核 Gate 的唯一计划真相源。批准前不另建 TodoList，避免计划、TodoList 和审核记录三处重复维护。进入开发后，只增加一份机器可读 disposition manifest；执行进度按阶段 A/B/C 记录，不把每次文件修改升级为审核节点。
