# Skill 原生直连编排开发方案

> 状态：方案已确认，尚未开始生产代码开发
>
> 日期：2026-09-04
>
> 开发分支：`refactor/skill-native-direct-delivery`
>
> 独立 Worktree：`/Users/heyunshen/work/PROJECT/jdc/ai-x-skill-native-direct`
>
> 基线提交：`ff97f5c`
>
> 变更性质：破坏性收敛，不建立兼容模式

## 1. 文档定位

本文档只记录本次 Session 确认的“Skill 原生直连”方案。它是独立方案，不继承、不覆盖，也不依赖以下内容：

- 原项目工作区 `/Users/heyunshen/work/PROJECT/jdc/ai-x`；
- 已存在的 `ai-x-lightweight` Worktree；
- 其他轻量化开发文档、分支或未跟踪草案。

后续实现、测试和代码删除全部发生在本 Worktree。原 `ai-x` 项目保留为可运行参考，不在其中开发本方案。

## 2. 现状判断

用户对业务主流程的理解是正确的：

```text
需求输入
→ 方案匹配
→ 子需求拆解
→ 调用对应 Skill
→ 逐步执行
→ 汇总报告
```

当前项目修改缓慢，不是因为该业务流程天然复杂，而是实现层额外承担了大量并非当前需求必需的责任：

- 报告内容同时受 Deliverable、Review、ReportDocument、ReportPackage、Projector 等多层合同约束；
- 多代 Plan、Report 和执行协议共同维护，形成过大的兼容矩阵；
- 编排、数据库和报告职责集中在大文件中；
- Legal、Security、完整性、可信度和视觉审校被实现为运行时阻断流程；
- Single Skill 与 Multi Skill 使用不同执行和报告路径；
- 修改报告章节或样式时，会连带触发 Schema、审校、投影、存储和兼容测试。

当前规模也说明这不是普通页面调整：

| 模块 | 当前规模 |
|---|---:|
| `lease-execution-engine.ts` | 5,552 行 |
| `database/control-plane.ts` | 5,628 行 |
| `editorial-report-contract.ts` | 4,007 行 |
| `report/` TypeScript 文件 | 70 个 |
| Active Skill | 25 个 |

本方案不继续修补这些层，而是在独立分支上收敛为一条直接主链。

## 3. 目标架构

```text
用户输入
   ↓
任务级理解与候选方案匹配
   ↓
用户选择方案
   ↓
汇总方案内全部 Skill 的输入要求
   ↓
输入解析：对话 / 上传 / 权限内数据库 / Knowledge / Tool
   ↓
仅向用户询问仍未满足的输入
   ↓
用户确认 Plan、输入绑定和缺口处理
   ↓
按依赖执行 1..N 个 Skill
   ↓
Single：Skill 结果直接成为最终报告
Multi：最终报告 Skill 对全部结果进行一次综合
   ↓
ReportResult
   ↓
确定性 HTML Renderer
```

系统只保留一套 1..N Skill 执行模型。`single_skill` 与 `multi_skill` 仍是用户可选模式，但不再对应两套执行引擎、两种恢复逻辑或两条报告流水线。

## 4. 目标与非目标

### 4.1 目标

- 方案决定调用哪些 Skill、依赖顺序和最终报告 Skill。
- Skill 决定自己的输入、执行方式、知识和工具，以及报告内容结构。
- 用户问询完整覆盖当前 Plan 内所有 Skill 的真实输入需求。
- 用户已经提供或权限内数据库已经存在的信息不重复询问。
- Single Skill 不增加第二次报告 LLM 调用。
- Multi Skill 只增加一次最终综合调用。
- Web 页面和现有交互体验继续保留。
- Skill 和方案定义可以更新，并对新任务即时生效。
- 报告样式修改只影响 Renderer，不重新执行研究任务。
- 普通内部只读任务不被通用合规或内容审校门禁阻断。

### 4.2 非目标

- 不在旧架构旁增加 `simple`、`lite` 或第三套模式。
- 不维护旧 Plan／Report Schema 的新写入兼容。
- 不回填或迁移原项目历史报告。
- 不建设微服务、消息队列、配置中心、插件市场或通用工作流 DSL。
- 不让 LLM 直接生成 HTML、CSS 或 JavaScript。
- 不保留多轮 Reviewer／Repair／Projector 流水线。
- 不要求每句话都通过 Evidence 等级或完整性矩阵。
- 不在本方案中重做 Web 视觉设计。

## 5. 保留的 Web 产品体验

保留：

- Workbench 布局、导航和当前视觉语言；
- 用户需求输入框；
- `single_skill`／`multi_skill` 选择；
- 需求澄清和资料问询界面；
- 候选方案卡片、推荐提示和用户选择；
- Skill 列表、依赖关系、资料绑定与执行前确认；
- 执行进度、当前节点、重试和取消；
- 历史任务、任务恢复；
- 报告查看、打印、HTML／Markdown 下载；
- Zero 发布入口，作为不影响报告完成状态的可选出口。

改变：

- 问询内容改为由所选 Plan 中的 Skill 输入声明驱动；
- Single／Multi 共用同一个任务状态和执行内核；
- 报告页只把一份最终 HTML 作为正式报告；
- 不再自动生成另一份 Editorial Summary；
- 不再向普通用户展示 Evidence 等级、Contribution Ledger、Review 账本或技术审计附件；
- 通用 Legal／Security 审批入口从普通只读任务中移除。

## 6. 完整的 Skill 驱动问询

问询不能简化成几个固定通用问题，也不能由前端硬编码。它分成两层：

### 6.1 任务级澄清

只有在系统无法可靠形成候选方案时，才询问目标、范围、对象、交付物或 `single_skill`／`multi_skill` 选择。

### 6.2 Plan／Skill 输入问询

用户选择方案后，系统汇总该方案中全部 Skill 声明的输入需求，并按以下顺序解析：

1. 当前消息和同一任务历史对话；
2. 当前任务已上传的文本、图片和数据集；
3. 当前用户或项目有权限读取、且适用于本任务的数据库资料；
4. 当前 Plan 允许读取的 Knowledge；
5. 当前 Plan 允许自动调用的只读 Tool；
6. 仍未满足的项目才生成用户问询。

问询规则：

- 每个问题必须对应当前 Plan 中至少一个真实 Skill 输入；
- 多个 Skill 需要同一资料时只问一次，并绑定到所有相关 Skill；
- 数据库命中必须检查用户归属、项目范围和资料有效性；
- 已自动绑定的信息在确认页可见并允许用户纠正，但不重复询问；
- 问题说明缺少什么、哪些 Skill 需要、为什么需要、接受什么形式；
- 用户无法提供时，按方案明确选择停止、替换 Skill 或形成 Gap；
- 不允许用模型猜测替代缺失的必需输入。

问询不是质量审校门禁。资料收集完成或缺口处理得到确认后，任务直接进入执行。

## 7. 最小领域合同

只保留四个核心概念：

| 概念 | 职责 |
|---|---|
| RequirementContext | 用户目标、范围、已解析输入、明确假设和缺口 |
| SkillDefinition | Skill 的使用条件、输入、执行方法和报告结构 |
| SolutionPlan | Skill DAG、输入绑定、最终报告 Skill 和失败处理 |
| ReportResult | Skill 结果和最终报告共用的内容合同 |

`ReportResult` 只包含：

- 标题；
- 摘要；
- 有序章节；
- 来源；
- 信息缺口；
- `complete`、`partial` 或 `failed` 状态。

章节只支持四种基础内容块：文字、列表、表格和图片。不要增加图表 DSL、内容组件注册中心或行业专用 ReportDocument 版本。

来源 ID 可以附着到内容块。来源真实存在时展示；没有来源时不显示引用，不因缺少引用自动阻断整个报告。

## 8. Skill 定义

一个 Skill 是处理方法和报告定义的唯一事实源。最小目录为：

```text
skills/<skill-id>/
  SKILL.md
  references/   # 可选
  scripts/      # 可选
```

`SKILL.md` 的 Frontmatter 和正文共同声明：

- Skill ID、用途和匹配条件；
- 输入项、是否必需、可接受来源、用户问题和缺失处理；
- 需要的 Knowledge、Wiki、LLM 和 Tool；
- 执行步骤；
- 报告标题规则、章节名称、章节顺序和内容要求；
- 允许的降级结果。

不再另外维护一份手写 Skill Registry 作为第二事实源。运行时目录索引从 Skill 定义派生。

Skill 不生成 HTML，不控制 Web 样式，也不读取其他 Skill 的内部文件。

## 9. 方案与 Plan

可复用方案定义只描述：

- 适用需求；
- 需要调用的 Skill；
- Skill 依赖关系；
- 最终报告 Skill；
- 输入映射；
- Skill 失败时停止、替换或以 Gap 继续。

方案不复制 Skill 的执行步骤或报告章节。

用户确认后生成不可变的任务 Plan。Plan 保存本次使用的 Skill ID、内容快照或可恢复快照、hash、输入绑定和执行顺序。后续定义更新不能静默改变该任务。

## 10. Single Skill 执行与报告

```text
RequirementContext
→ SolutionPlan（一个 Skill）
→ Skill 执行
→ ReportResult
→ HTML Renderer
```

Single Skill 的最终报告严格采用该 Skill 定义的：

- 报告标题和摘要要求；
- 章节名称；
- 章节顺序；
- 表格、列表和图片要求；
- 来源和 Gap 展示要求。

Skill 是报告内容结构的唯一事实源。共享 Renderer 只决定字体、颜色、间距、目录、打印和安全转义，不得改变章节或补写事实。

Single Skill 不执行额外综合 LLM，不执行 Final Review，不生成第二份摘要报告。

`industry-market-analysis` 的用户报告保持以下专业结构：

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

A～J 分析方法可以保留为 Skill 内部工作方法，但不是 Runtime 报告门禁。

## 11. Multi Skill 执行与报告

一个 Multi Skill 方案包含若干支持 Skill 和一个最终报告 Skill：

```text
支持 Skill A ─┐
支持 Skill B ─┼→ 最终报告 Skill → ReportResult → HTML
支持 Skill C ─┘
```

执行规则：

1. 支持 Skill 独立完成限定子问题并输出 `ReportResult`；
2. 最终报告 Skill 接收用户需求、全部可用 Skill 结果、来源和 Gap；
3. 只调用一次综合 LLM；
4. 按最终报告 Skill 定义的章节结构组织内容；
5. 合并重复结论，不把多份完整报告首尾拼接；
6. 不增加输入中不存在的数字、URL、事实或来源；
7. 不静默裁决 Skill 冲突，将其放入“差异与待确认”；
8. 独立专项产物无法融入正文时，放入“专项补充”；
9. 支持 Skill 失败时继续使用其他结果，并将最终状态标记为 `partial`。

最终 HTML 是一份围绕用户需求组织的综合报告：

```text
报告标题与状态
执行摘要
任务范围
综合核心发现
最终报告 Skill 定义的专业章节
跨 Skill 差异与待确认（存在冲突时）
机会与建议
优先行动
专项补充（确有独立产物时）
信息缺口
来源
```

支持 Skill 的原始结果保留为内部 Artifact，供诊断或单独下载，不作为第二份正式报告。

如果最终综合失败，Renderer 按 Skill 执行顺序确定性分组已有结果、合并真实来源、列出失败项，并输出 `partial` 报告；不进入无限重试或多轮修复。

## 12. HTML 输出

Web 查看、下载和打印使用同一份确定性 HTML：

- 单栏研究报告，正文宽度约 900～1000px；
- 顶部显示标题、摘要和状态；
- 正文严格使用 `ReportResult.sections` 的顺序；
- 桌面端侧边目录，移动端顶部目录；
- 表格允许横向滚动，打印时自动适配；
- 图片使用已保存的本地 Artifact，不进行运行时远程加载；
- 真实来源使用脚注或来源标签；
- 没有来源的内容不显示来源标记；
- `partial` 报告显示简短缺口提示；
- 支持 A4 打印；
- 不包含 JavaScript、内联事件、远程字体或运行时网络请求。

LLM 只生成 `ReportResult` 内容，不直接接触 HTML。

## 13. 最小门禁

### 13.1 输入门禁

仅阻止确实无法执行的必需输入缺失。可降级输入按用户确认的方案形成 Gap。

### 13.2 来源

- 只展示能够解析到本次用户材料、Knowledge 或 Tool 输出的来源；
- 未知来源 ID 被丢弃并记录内部 Warning；
- 没有来源时不标来源，也不标“高可信”或“已验证”；
- 来源缺失本身不触发人工审批。

### 13.3 完整性

只保留三种结果状态：

```text
complete：明确要求均已有结果
partial：已有可用结果，但存在缺口或失败 Skill
failed：没有形成可用报告
```

`partial` 可以正常展示和下载，不暂停在 Review。

### 13.4 合规与安全

普通内部只读研究不经过通用 Legal／Security 审批。

只保留真实安全边界：

- 用户、项目和任务数据隔离；
- Tool 的文件、网络和命令权限限制；
- 密钥与敏感字段脱敏；
- 请求大小、超时、取消和失败隔离；
- HTML 转义和无脚本输出；
- 外部写入、付费和不可逆操作的 owner 确认。

文案质量、证据强弱、视觉质量和 Reviewer 不同意见只形成 Warning，不阻断任务。

## 14. Skill 与方案热插拔

热插拔定义为“对新任务即时生效”，不是修改运行中的任务。

```text
创建任务或 Replan
→ 读取当前 Skill 和方案目录
→ 在边界校验一次
→ 形成 Catalog Snapshot
→ 用户确认 Plan
→ 冻结本次定义和 hash
```

规则：

- 新增、修改或删除 Skill 后，下一次规划立即看到最新目录；
- 新增或修改方案定义后，下一次规划立即生效；
- 已确认 Plan 使用冻结快照，运行和恢复过程不受后续更新影响；
- 用户需要新版定义时执行 Replan 并再次确认；
- 无效定义只从新 Catalog 中排除并返回明确错误，不影响其他 Skill；
- Prompt、输入、Knowledge、报告章节和已有 Tool 组合可以热更新；
- 新增 Runtime 代码、原生依赖或 Tool Adapter 仍需正常开发和发布。

实现不增加文件 Watcher、配置中心、插件市场或多版本兼容 Reader。

## 15. 模块边界

```text
Web Workbench
      ↓
Task API / Control
      ↓
Planning ───────→ Skill / Solution Catalog
      ↓
Input Resolution ← 对话 / 上传 / 权限内数据库 / Knowledge / Tool
      ↓
Frozen Plan
      ↓
Execution
      ↓
ReportResult
      ↓
HTML Renderer
```

依赖只能向下：

- Planning 只读取 Skill 的公开定义；
- Input Resolution 不解释 Skill 内部业务方法；
- Execution 不依赖 Web 或 Renderer；
- Renderer 不依赖 Lease、Tool Router 或 Skill Loader；
- Web 只读取输入状态、任务状态和最终报告；
- Control 不解析或重写报告正文。

## 16. 独立开发环境

本方案使用：

```text
Worktree：/Users/heyunshen/work/PROJECT/jdc/ai-x-skill-native-direct
Branch：refactor/skill-native-direct-delivery
Base：ff97f5c
```

隔离规则：

- 不在原 `ai-x` 或 `ai-x-lightweight` 中修改本方案代码；
- 不复制原工作区未跟踪文件；
- 使用独立开发数据库 `user_research_ai_skill_native`；
- 使用 Worktree 内相对路径 `./run-workspaces`，与其他工作区物理隔离；
- `.env`、JWT 和真实模型密钥不提交；
- 默认测试使用 mock LLM 和 fake Tool；
- 真实调用只在本地合同与诊断冻结后执行一次 Single 和一次 Multi Smoke。

不新增服务、语言或第三方依赖。需要沿用现有 `DATABASE_URL`、`JWT_SECRET`、LLM Gateway 和 Tool Adapter 配置机制。

## 17. 实施策略

这是一次独立分支内的破坏性切换，不把新路径作为 Feature Flag 叠加到旧路径。实现顺序如下：

1. 在本分支更新 `CONTEXT.md`，新增一份取代旧编排和报告决策的 ADR；
2. 定义 Skill 输入声明、唯一 `ReportResult` 和 HTML Renderer；
3. 实现对话、上传、权限内数据库、Knowledge 和 Tool 的输入解析与问询；
4. 使用 `industry-market-analysis` 完成 Single Skill 纵切；
5. 使用支持 Skill 加 `industry-market-analysis` 完成 Multi Skill 纵切；
6. 将现有 Web 问询、方案、进度和报告页面接到新主链；
7. 实现新任务读取最新定义、已确认任务冻结快照；
8. 迁移其余 Active Skill；
9. 删除新任务使用的旧 Plan、Report、Review、Projector、Package 和审批路径；
10. 完成离线测试、真实 Single/Multi Smoke 和 `/check`。

第一条可交付纵切必须已经能独立完成“输入—问询—执行—HTML”，不提交只能依赖下一阶段才能工作的半链路。暂未迁移的 Skill 明确显示不可用，不回退到旧执行引擎。

预计会修改超过 8 个文件，但不新增服务。应优先拆小现有大文件，而不是再增加中央协调器。

## 18. 工期估算

按一名熟悉代码库的开发者配合 AI、全职开发估算：

| 交付范围 | 预计时间 |
|---|---:|
| 技术纵切：1 条 Single + 1 条 Multi，完整问询和 HTML | 5～7 个工作日 |
| 可用版本：迁移 3～5 个代表性 Skill，补齐 Web、恢复与热插拔 | 10～15 个工作日 |
| 完整切换：迁移当前全部 25 个 Active Skill，并删除旧新任务链路 | 15～25 个工作日 |

主要变量是逐个 Skill 的输入声明、报告结构和真实模型校准，而不是 HTML Renderer。

## 19. 验收标准

### 19.1 问询

- 问题全部来自已选 Plan 中实际 Skill 的输入声明；
- 用户已经提供的内容不再重复问；
- 权限内数据库资料能够自动绑定并允许用户纠正；
- 多个 Skill 的相同输入只出现一个问题；
- 用户无法提供时执行 Plan 声明的停止、替换或 Gap 策略。

### 19.2 Single Skill

- 报告标题、章节和顺序与 Skill 定义一致；
- Skill 完成后不再调用报告 LLM；
- 修改 CSS 不重新执行 Skill；
- 缺失可降级资料时生成 `partial` 报告。

### 19.3 Multi Skill

- 所有成功 Skill 结果进入唯一一次综合调用；
- 输出遵循最终报告 Skill 的报告结构；
- 重复结论合并，冲突显式展示；
- 支持 Skill 失败或综合失败时仍可确定性输出 `partial`。

### 19.4 Web 与 HTML

- 输入、问询、方案卡片、计划确认、进度、重试、取消和历史恢复可用；
- 页面与下载使用同一份 HTML；
- 桌面、移动和 A4 打印不丢内容；
- HTML 无脚本、无远程运行时资源、文本全部转义；
- Zero 失败不改变报告完成状态。

### 19.5 热插拔与隔离

- 有效 Skill／方案更新无需重启，在下一次规划可见；
- 运行中任务在定义更新后继续使用原快照；
- 无效新定义不影响已有任务；
- 本 Worktree 使用独立数据库和运行目录；
- 原 `ai-x` 和 `ai-x-lightweight` 的代码、任务和报告不被修改。

## 20. 验证

离线验证：

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm test
```

手工验收覆盖：

- Single Skill 正常输入；
- Single Skill 缺失输入；
- Multi Skill 共享输入去重；
- 数据库已有资料不问询；
- 用户无权读取的数据库资料不被绑定；
- 支持 Skill 失败；
- 最终综合失败；
- HTML 注入内容被转义；
- Skill 更新后新任务生效、旧任务不漂移；
- 任务取消、恢复和报告重新渲染。

真实模型验证遵守 `docs/agents/real-llm-development-workflow.md`：先冻结本地合同和诊断，再执行一次真实 Single 和一次真实 Multi Smoke。真实运行需要已有的 LLM Gateway 和对应 Tool 凭据，不引入新账号。

## 21. 失败处理与回滚

- 必需输入缺失：停在问询或按用户确认调整方案；
- 可降级输入缺失：记录 Gap，继续；
- Tool 或支持 Skill 失败：按 Plan 输出 `partial`；
- 最终报告 Skill 失败：使用已有 Skill 结果确定性分组输出 `partial`；
- 所有 Skill 都无可用结果：任务为 `failed`，不生成空报告；
- Renderer 失败：保留 `ReportResult`，重新渲染而不重跑 Skill；
- Skill／方案更新无效：拒绝进入新 Plan，已冻结任务不受影响；
- Zero 发布失败：报告保持完成；
- 方案方向不成立：删除本 Worktree 和分支即可，原项目无需数据回滚。

## 22. 既有决策处理

实施时必须用一份新 ADR 明确取代与以下主题相关的旧决策，而不是添加例外：

- Compiled Skill 与多版本 Plan；
- Skill Portfolio、Contribution Ledger 和 Cross-Skill Review；
- Editorial Material、Blueprint、Projector 和 Showcase；
- Single／Multi 双执行引擎；
- 独立 Editorial Summary；
- Legacy／Compiled Invocation 联合判别。

同时更新 `CONTEXT.md`，移除双报告、双引擎和运行时报告审校术语。

## 23. Premise Collapse

本方案假设项目的主要交付物是供人阅读的研究报告，而不是多个外部系统依赖的稳定行业数据 API。

如果未来出现已经确认的机器消费方，应把该 Skill 的专业结构化数据作为独立导出；不得重新把 HTML、Renderer、Review 或 Runtime 扩张成通用数据平台。

## 24. 最终决策

本方案建设：一条 Skill 原生、完整问询、单合同、可热更新、确定性渲染的直接报告链路。

本方案不建设：旧架构兼容层、第二套轻量模式、复杂插件平台、通用审批系统或新的报告事实矩阵。

实现只在独立 `ai-x-skill-native-direct` Worktree 中进行；原项目与已有轻量化 Worktree 均保持不变。
