# Skill-first 轻量编排与报告开发方案

> 状态：架构方向已确认，待实施
> 日期：2026-09-04
> 适用范围：需求理解、方案匹配、单／多 Skill 执行、报告生成、现有 Web 工作台
> 变更性质：破坏性收敛；不新增兼容模式

## 1. 决策摘要

项目收敛为一套 Skill-first 主链：

```text
需求输入
→ 任务级澄清与方案匹配
→ 汇总方案内全部 Skill 的输入需求
→ 从用户已提供内容、上传和有权限的数据库资料中解析输入
→ 对仍未满足的 Skill 输入进行完整问询
→ 子需求与 Skill DAG
→ 执行 1..N 个 Skill
→ 最终报告结果
→ 确定性 HTML Renderer
```

核心决策：

1. 一个 Skill 同时定义自己的处理方法和面向用户的报告内容结构。
2. 单 Skill 任务直接使用该 Skill 的最终结果生成报告，不增加报告 LLM、Final Review 或第二次内容改写。
3. 多 Skill 任务由方案指定一个“最终报告 Skill”；其他 Skill 的结果作为输入，最终报告 Skill 通过一次 LLM 综合生成一份报告结果。
4. 所有 Skill 使用同一个最小报告外层合同，但自行决定章节名称、顺序和专业内容。
5. HTML 只由确定性 Renderer 生成。LLM 不生成 HTML、CSS 或 JavaScript。
6. 保留当前 Web 工作台、完整问询、方案选择、执行进度、历史任务和下载体验；替换其背后的双引擎、审批和报告流水线。
7. `single_skill` 与 `multi_skill` 可以继续作为用户选择，但只约束 Skill 数量；后台不再使用两套执行引擎或两种 Plan 版本。
8. Skill 和方案定义对新任务支持热更新；已确认或正在执行的任务冻结当时使用的定义，不被后续更新静默改变。

## 2. 目标与非目标

### 2.1 目标

- 让项目实现与产品认知一致：方案决定 Skill，Skill 决定报告内容。
- 普通报告样式修改不触碰研究执行、Evidence、Review 或 Schema 版本链。
- 单 Skill 不再经过额外综合；多 Skill 最多增加一次最终综合调用。
- 资料不足时输出可用的部分报告，并明确缺失项。
- 问询覆盖当前方案内全部 Skill 的真实输入需求；用户已提供或数据库已有且有权使用的内容不得重复询问。
- 新增 Skill 时只定义输入、执行方法和报告章节，不复制 Deliverable、Review、Projector 和 Package 合同。
- 继续使用用户已经熟悉的 Web 界面和交互流程。

### 2.2 非目标

- 不建立新的“轻量模式”与旧模式长期并存。
- 不保留 CurrentExecutionPlan v2/v3 双引擎语义。
- 不继续维护 ReportDocument v1～v4、Report Package v1～v3 的新写入路径。
- 不让 LLM 直接输出生产 HTML。
- 不为普通内部只读任务保留 Legal／Security 审批流程。
- 不要求运行时证明每个 Skill 内容单元 exactly-once 进入报告。
- 不把执行日志、模型 Receipt、Artifact Hash 或内部审校结果放进用户报告。

## 3. 保留的 Web 产品体验

本方案是内核收敛，不是重新设计前端。

### 3.1 保留

- Workbench 整体布局、导航和现有视觉语言。
- 用户输入框及 `single_skill`／`multi_skill` 选择。
- Requirement Refinement 与 Plan/Skill 输入问询流程。
- 2～4 个方案卡片、推荐方案和用户选择。
- 计划预览、用户资料上传与一次确认。
- 执行进度、当前步骤、失败重试和取消。
- 历史任务列表和任务恢复。
- 报告页面、打印、HTML／Markdown 下载。
- Zero 发布入口；它作为可选发布 Adapter，失败不影响报告完成。

### 3.2 简化或移除

- 不减少 Skill 所需的问询。系统必须汇总所选方案中全部 Skill 声明的输入需求，先解析已有内容，再询问所有仍未满足且需要用户补充的项目。
- 多个 Skill 需要同一项输入时只问一次，并把同一份结果绑定到对应的多个 Skill。
- 用户无法提供时，按方案声明选择阻断、替换 Skill 或以可见 Gap 降级，不能静默伪造输入。
- 移除通用 Legal／Security 审批阶段；只有外部写入、付费或不可逆操作需要 owner 确认。
- `single_skill`／`multi_skill` 不再决定不同 Plan、不同恢复逻辑或不同报告链路。
- 报告页不再默认请求独立 Editorial Summary。
- 移除“编辑摘要／完整报告”双事实表现；改为一份 HTML，顶部摘要、下方完整正文。
- 移除面向用户的 Evidence 等级、Review 维度、Contribution Ledger 和技术审计附件。

### 3.3 用户流程

```text
输入需求
→ 在无法形成候选方案时完成任务级澄清
→ 用户查看并选择方案
→ 系统汇总该方案内所有 Skill 的输入要求
→ 依次检查当前对话、用户上传和有权限的数据库资料
→ 系统集中询问仍未满足的输入
→ 用户确认 Skill 列表、顺序、输入绑定和缺口处理
→ 系统执行并显示进度
→ 系统展示一份最终 HTML 报告
```

用户选择 `single_skill` 时，方案只能包含一个最终 Skill；选择 `multi_skill` 时，方案可以包含多个 Skill，但仍生成同一种 Execution Plan 和同一种最终报告结果。

问询解析顺序固定为：

1. 当前消息及同一任务历史对话中用户已经明确提供的内容；
2. 当前任务上传并绑定的文本、图片和数据集；
3. 当前用户或项目有权限读取、且适用于本任务的数据库资料；
4. 方案允许自动获取的 Knowledge 或 Tool 结果；
5. 仍未满足的项目才生成用户问询。

前台每个问题都要说明缺少什么、哪些 Skill 需要、为什么需要、可接受的形式，以及用户无法提供时的处理方式。数据库匹配必须检查归属和权限，不能因字段同名而跨用户或跨项目复用。

## 4. 最小领域对象

新主链只保留四个核心对象：

| 对象 | 职责 |
|---|---|
| Requirement | 用户目标、范围、已解析输入、可见假设和仍缺失材料 |
| SolutionPlan | Skill 列表、依赖关系、最终报告 Skill、输入绑定和缺口处理 |
| SkillResult | 单个 Skill 的报告内容、来源和缺失项 |
| ReportResult | 最终供 Renderer 使用的一份报告结果 |

`ReportResult` 只包含：

- 标题；
- 摘要；
- 有序章节；
- 来源；
- 缺失项；
- `complete`、`partial` 或 `failed` 状态。

章节只支持四种基础内容：

- 文字；
- 列表；
- 表格；
- 图片。

每个内容块可以携带来源 ID。来源不存在时不显示来源标记，不因此阻断报告。

## 5. 方案与 Skill 的职责

### 5.1 方案负责

- 选择需要执行的 Skill。
- 定义 Skill 依赖顺序。
- 指定最终报告 Skill。
- 汇总全部 Skill 声明的必需输入和可选输入。
- 对重复输入去重，并把用户内容、上传或有权限的数据库资料绑定到对应 Skill。
- 声明某个 Skill 失败后是停止还是以 Gap 继续。

方案不定义另一套报告 Schema，也不复制 Skill 的专业方法。

### 5.2 Skill 负责

- 定义何时使用。
- 定义需要的 Knowledge、Wiki、Tool 和 LLM 步骤。
- 定义自己的输入要求、可接受来源、面向用户的问题和缺失后的处理方式。
- 定义报告章节、顺序和内容要求。
- 输出符合最小报告合同的 `SkillResult`。
- 保留真实来源和明确缺失项。

Skill 不生成 HTML，不决定 Web 样式，也不操作其他 Skill 的内部步骤。

### 5.3 Renderer 负责

- 把 `ReportResult` 转为 HTML、Web View 或 Markdown。
- 处理字体、颜色、目录、表格、图片和打印布局。
- 转义所有文本，禁止脚本和运行时网络请求。
- 展示真实来源与 `partial` 缺失提示。

Renderer 不总结、不重写、不补充事实。

## 6. 单 Skill 执行

单 Skill 路径：

```text
Requirement
→ SolutionPlan（一个 Skill）
→ Skill 执行
→ SkillResult = ReportResult
→ HTML Renderer
```

以 `industry-market-analysis` 为例：

```text
industry-market-analysis
→ 行业市场分析 ReportResult
→ 行业市场分析 HTML
```

Skill 的 A～J 方法、公开资料、用户材料、竞品、京东诊断、机会和策略分析都在 Skill 内完成。Runtime 不再复制一份 Industry Deliverable Schema，不再通过第二个 LLM 重写，也不再通过 Final Review 修改内容。

Single Skill 的最终 HTML 必须遵循该 Skill 定义的标题、摘要、章节名称、章节顺序和内容块要求。Skill 是报告内容结构的唯一事实源；共享 Renderer 只负责把这些结构渲染成一致的 HTML 视觉样式，不得改写章节或补充事实。Skill 不直接维护 HTML、CSS 或 JavaScript。

## 7. 多 Skill 执行

### 7.1 角色

一个多 Skill 方案包含：

- 若干支持 Skill：独立回答限定子问题；
- 一个最终报告 Skill：吸收所有结果并输出最终报告。

例如：

```text
competitive-web-research ─┐
generate-persona ─────────┼→ industry-market-analysis
jobs-to-be-done ──────────┘              ↓
                                      ReportResult
                                           ↓
                                          HTML
```

`industry-market-analysis` 决定最终报告格式；其他 Skill 的完整报告结果作为标明 Skill ID、来源和 Gap 的输入材料。

### 7.2 综合规则

最终报告 Skill 只调用一次综合 LLM，并遵守以下规则：

1. 按自己的报告章节格式组织结果。
2. 合并重复结论，不重复粘贴多个 Skill 报告。
3. 不新增任何输入中不存在的数字、事实、URL 或来源。
4. 对不同 Skill 的冲突不静默裁决，放入“差异与待确认”内容。
5. 无法放入主章节但用户明确要求的专项产物，放入“专项补充”。
6. 支持 Skill 失败时继续使用其他结果，最终状态为 `partial`。
7. 只输出 `ReportResult`，不输出 HTML。

不再使用 Contributor／Synthesizer 双合同、Contribution Ledger、跨 Skill Review 和多版本 Canonical 编译。

### 7.3 多 Skill 最终 HTML

多 Skill 最终只输出一份综合报告：

```text
┌──────────────────────────────────────┐
│ 报告标题                              │
│ 一句话结论 · complete / partial       │
├──────────────────────────────────────┤
│ 执行摘要                              │
│ 综合所有 Skill 的 3～5 条核心结论       │
├──────────────────────────────────────┤
│ 1. 任务范围与问题                      │
│ 2. 综合核心发现                        │
│ 3. 最终报告 Skill 定义的专业章节         │
│ 4. 跨 Skill 差异与待确认（仅有冲突时）   │
│ 5. 机会与建议                          │
│ 6. 优先行动                            │
│ 7. 专项补充（仅有独立产物时）            │
│ 8. 信息缺口                            │
├──────────────────────────────────────┤
│ 来源                                  │
└──────────────────────────────────────┘
```

正文不按 Skill 分成多份完整子报告。Skill 身份只用于综合上下文和内部日志；用户主要看到围绕需求组织的一份报告。

如果用户需要查看原始 Skill 结果，可以从开发诊断或单独下载中读取，但不默认进入主报告，也不成为另一份事实源。

### 7.4 综合失败降级

最终综合 LLM 失败时不重试循环：

- 系统按 Skill 执行顺序把已有 `SkillResult` 放入“专项结果”章节；
- 合并所有真实来源；
- 列出失败 Skill 和未完成内容；
- 输出 `partial` HTML。

该降级不会伪装成已经综合完成的正式结论。

## 8. 最终 HTML 形式

Web 查看与下载使用同一份确定性 HTML：

- 单栏研究报告布局，正文宽度约 900～1000px；
- 顶部标题、摘要和完成状态；
- 桌面端侧边目录，移动端顶部目录；
- 来源使用正文脚注或来源标签；
- 没有来源的内容不显示来源标记；
- `partial` 报告显示简短缺失提示；
- 支持 A4 打印；
- 不含 JavaScript、远程字体、远程图片请求或内联事件；
- Web 宿主可以提供下载、打印、返回任务和 Zero 发布按钮。

## 9. Industry Market Analysis 报告结构

`industry-market-analysis` 的用户报告固定使用以下专业结构：

1. 执行摘要；
2. 分析范围与口径；
3. 市场现状与趋势；
4. 用户需求与分层；
5. 供给与竞争格局；
6. 京东现状与问题；
7. 核心发现与 Gap；
8. 定位、机会与策略；
9. 优先行动与衡量方式；
10. 信息缺口与来源。

A～J 十维方法可以继续用于 Skill 内部分析，但不再作为用户报告的硬性审校门禁，也不要求在 HTML 中展示 Coverage Ledger、Confidence、Evidence Class 或 Contribution ID。

## 10. 最小门禁与安全

### 10.1 运行状态

```text
complete：所有明确请求内容都有结果
partial：已有可用内容，但存在失败 Skill 或缺失项
failed：没有形成可用报告内容
```

`partial` 正常发布，不暂停在 Review。

### 10.2 来源

- Skill 只能引用本次用户材料、Knowledge 或 Tool 返回的来源 ID。
- Renderer 只展示能够解析的来源。
- 未知来源 ID 被移除并记录内部 warning，不阻断报告。
- 没有来源时不展示“已验证”“高可信”等标签。

### 10.3 安全

保留：

- 用户和任务归属隔离；
- Tool 文件、网络和命令访问限制；
- 密钥和敏感字段脱敏；
- 请求大小、超时和取消；
- HTML 文本转义与无脚本输出；
- 外部写入、付费和不可逆操作的 owner 确认。

移除：

- LLM `blocking_issues` 自动映射 Legal／Security 审批；
- 普通公开资料检索的人工审批；
- 报告完整性、视觉质量或文案问题导致任务暂停。

## 11. 现有模块处置

### 11.1 保留并改造

- `apps/web/src/pages/Workbench.tsx`：保留工作台和任务恢复。
- `apps/web/src/components/Composer.tsx`：保留输入和模式选择。
- `apps/web/src/components/stages/CurrentStage1Clarify.tsx`：保留并承载完整的 Skill 驱动问询。
- `apps/web/src/components/stages/Stage2Candidates.tsx`：保留方案卡片。
- `apps/web/src/components/stages/Stage2Plan.tsx`：展示统一 Skill DAG。
- `apps/web/src/components/stages/CurrentStage4Report.tsx`：改为挂载单一 HTML 报告。
- Tool Adapter、Auth、任务归属、超时和取消能力。

### 11.2 收敛

- Plan v2/v3 → 一个 1..N Skill Plan。
- compiled/legacy Invocation → 普通单节点或展开节点，不暴露模式。
- Skill／Deliverable／Report 多重合同 → Skill ReportResult 一个内容合同。
- Summary／Detail 双报告 → 一份顶部摘要、下方正文的 HTML。

### 11.3 删除

- Legacy 可写任务路径；历史数据先静态归档。
- ReportDocument v1～v4 新写入与多版本 Reader。
- Report Package v1～v3 新写入链。
- Editorial Material、Blueprint、Projector、Showcase 和 Fidelity Repair。
- Contribution Ledger、Cross-Skill Review 和运行时 Final Report Review。
- Legal／Security 通用审批状态及对应 Web 入口。

## 12. 实施方式

该改造预计明显超过 8 个文件，且同时影响 Plan、Runtime、Report 和 Web。为了避免形成第三套兼容路径，应作为一次协调后的破坏性切换实施，不在生产代码中长期双写或双读。

### 12.1 开发隔离

项目已经具备隔离开发环境，后续直接使用，不再创建重复目录：

```text
原工作区：/Users/heyunshen/work/PROJECT/jdc/ai-x
开发 worktree：/Users/heyunshen/work/PROJECT/jdc/ai-x-lightweight
开发分支：refactor/lightweight-skill-orchestration
当前基线：ff97f5c
```

后续只在 `ai-x-lightweight` 中实施；原 `ai-x` 工作目录只作为现状参考，不改其生产代码。

选择 worktree 而不是复制一套脱离 Git 历史的新项目，原因是它同时满足：

- 工作文件完全隔离，删除旧链路不会影响原工作目录；
- 继续复用当前提交历史、测试和差异审查；
- 可以随时对照原实现，也可以直接删除整个新 worktree 回滚开发环境；
- 不产生两个长期漂移的仓库。

当前检查到两个工作区都没有已跟踪代码改动，仅存在未跟踪的方案文档。若未来要求 Git 元数据和远端也完全独立，再使用本地 clone；这不是当前推荐方案。

### 12.2 Skill 与 Plan 热插拔

支持热插拔，但边界必须明确：

- 每次创建新任务或用户主动 Replan 时，重新读取当前 Skill Catalog 和方案定义；新增、删除或更新后的定义立即对这次规划生效，不要求重启服务。
- Plan 确认时冻结本次使用的 Skill 定义、报告结构和内容 hash；运行中任务、恢复任务及已经生成的历史报告不受后续文件更新影响。
- 已确认 Plan 不能被后台热修改。用户要使用新版本时必须重新规划并再次确认。
- Skill 的 Prompt、输入声明、Knowledge、报告章节和已有 Tool 组合可以热更新；需要新增 Runtime 代码或真实 Tool Adapter 的能力仍需正常开发和发布，不能伪装成配置热插拔。
- 无效的新定义只对新规划返回明确错误，不能破坏已冻结任务。

最小实现不增加配置中心、文件监听器、插件市场或多版本兼容层。新任务在规划边界读取并校验一次，随后使用不可变快照即可。

### 12.3 实施顺序

实施工作顺序：

1. 更新 `CONTEXT.md` 和 ADR，正式替换双编排与双报告决策。
2. 定义唯一 Skill 输入声明、`ReportResult` 合同和确定性 Renderer。
3. 实现当前对话、上传、权限内数据库、Knowledge 和 Tool 的输入解析、去重、绑定与完整问询。
4. 先让 `industry-market-analysis` 按新合同完成单 Skill 和多 Skill 两条纵切片。
5. 将现有 Web 问询和报告页接到新输入解析与 HTML，同时保留其余 Workbench 交互。
6. 实现新任务加载最新 Skill／方案定义、已确认任务冻结快照的热插拔边界。
7. 将其余 active Skill 迁移为相同最小报告合同。
8. 切换统一 Plan 和执行入口。
9. 静态归档旧报告并删除旧 Reader、Writer、Feature Flag、Schema 和测试。
10. 删除旧审批与运行时报告审校路径。

数据库继续使用现有任务、执行和 Artifact 存储，不新增服务、语言、外部账号或第三方依赖。新报告可以作为一个新的 Artifact Schema 写入现有表；旧 Artifact 不重写。

### 12.4 工期估算

这是一个中大型重构。目标架构本身简单，主要工作量来自从当前多版本执行和报告链中切出一条完整纵向链路，同时保留 Web、恢复和真实 LLM 执行。

以下按一名熟悉代码库的开发者配合 AI、全职开发估算：

| 交付范围 | 预计时间 |
|---|---:|
| 技术纵切：1 个 Single Skill + 1 个 Multi Skill，可完成问询、执行和 HTML 输出 | 5～7 个工作日 |
| 可用版本：迁移 3～5 个代表性 Skill，补齐 Web、热插拔、恢复和集成测试 | 10～15 个工作日 |
| 完整切换：迁移当前全部 25 个 active Skill，并删除旧的新任务链路 | 15～25 个工作日 |

最大的时间变量不是 Renderer，而是逐个 Skill 明确输入需求、报告结构，并用真实模型校准输出。估算不包含历史报告迁移，因为本方案明确不做旧合同兼容和数据回填。

## 13. 验收标准

### 13.1 单 Skill

- `industry-market-analysis` 的章节完整映射到一份 HTML。
- HTML 的内容结构和章节顺序来自该 Skill 的报告定义，共享 Renderer 只负责展示。
- 报告生成阶段不产生额外 LLM 调用。
- 修改 CSS 或章节展示不重新执行 Skill。
- 缺少资料时输出 `partial`，并显示缺失项。

### 13.2 多 Skill

- 所有成功 Skill 的结果进入一次最终综合调用。
- 最终输出符合最终报告 Skill 的章节格式。
- 重复结论被合并，冲突被显式展示。
- 支持 Skill 失败时仍能输出 `partial` 报告。
- 综合调用失败时输出按 Skill 分组的确定性降级报告。

### 13.3 Web

- 原有需求输入、问询、方案卡片、计划确认、执行进度和历史恢复保持可用。
- 问询覆盖所选 Plan 中所有 Skill 的输入需求，已有对话、上传或有权限的数据库资料不重复询问。
- 多个 Skill 的相同输入只询问一次，并能在计划确认页看到绑定关系。
- 报告页只显示一份 HTML，不再自动触发 Summary LLM。
- HTML 下载与 Web 正文一致。
- 桌面、移动和打印均无内容丢失。

### 13.4 安全与来源

- 用户不能读取其他用户的任务或报告。
- 报告 HTML 无脚本和远程运行时资源。
- 未知来源不会展示成有效引用。
- 普通只读任务不进入 Legal／Security 审批。

### 13.5 热插拔

- 新增或更新有效的 Skill／方案定义后，下一次创建任务或 Replan 可以直接使用，无需重启服务。
- 更新发生前已经确认的任务继续使用原定义和 hash，恢复执行后结果不漂移。
- 无效定义不会进入新 Plan，也不会影响其他有效定义和已经冻结的任务。

## 14. 失败处理与回滚

- Tool 或支持 Skill 失败：记录 Gap，继续生成 `partial` 报告。
- 最终报告 Skill 失败且存在其他结果：确定性分组输出 `partial` 报告。
- 所有 Skill 均无可用结果：任务为 `failed`，不生成空报告。
- Renderer 失败：保留 `ReportResult`，允许重新渲染，不重跑 Skill。
- Zero 发布失败：报告保持完成，只显示发布失败。
- Skill 或方案定义更新无效：拒绝用于新规划；已经冻结的任务继续使用原快照。
- 切换前保留数据库备份和旧报告静态导出；回滚代码不删除新旧 Artifact。

## 15. 既有决策冲突

本方案明确重开并取代以下既有决策，不在其上增加例外：

- ADR-0003：Compiled Skill、Plan v2 与多版本报告兼容部分；
- ADR-0007：Portfolio、Contribution、Ledger 和跨 Skill Review；
- ADR-0008：Editorial Material／Blueprint／Projector／Showcase；
- ADR-0009：单 Skill／多 Skill 双引擎；
- ADR-0010：独立 Editorial Summary HTML；
- ADR-0011：compiled／legacy Invocation 判别联合。

实施前必须同步修改 `CONTEXT.md` 中的编排模式、Skill Portfolio、Contribution Ledger、跨 Skill 评审和双报告集定义，避免新代码继续被旧领域语言拉回复杂架构。

## 16. Premise Collapse

本方案假设主要交付物是供人阅读的研究报告，而不是供多个下游系统消费的严格行业数据模型。

如果未来确实出现稳定、已确认的机器消费方，应把 Skill 的专业结构化数据作为独立导出保留；不能重新把 HTML、Renderer 或运行时报告门禁扩张成机器数据平台。
