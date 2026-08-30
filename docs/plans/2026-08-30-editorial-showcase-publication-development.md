# Editorial Showcase 最终 HTML 发布流程开发方案

> 状态：Phase 1、Phase 2 已在当前工作树实现；Phase 3 的三类固定 canary 和真实 Gateway Intent v2 验收已通过，测试环境三开关发布 canary 待执行
>
> 日期：2026-08-30
>
> 目标仓库：`/Users/heyunshen/work/PROJECT/jdc/ai-x-answer-reports`
>
> 目标分支：`feat/research-answer-dynamic-reports`
>
> 当前基线：`617cf1adc9335a4a78a5dfe4865d32f8037e7985` 加当前工作树中的编辑型报告 Phase 1 改动
>
> 上游决策：`docs/adr/0008-adopt-reusable-editorial-report-pipeline.md`
>
> 关联方案：`docs/plans/2026-08-27-universal-editorial-report-foundation-development.md`

## 实施状态（2026-08-30）

当前工作树已完成以下内容，尚未提交：

- 新增 `ReportEditorialIntentV2`、`EditorialPresentationSpecV1`、对应 Schema 和 `editorial-showcase-v1` Profile。
- 新增内容驱动的 Showcase Compiler。模型选择只负责章节和组件组合，Compiler 负责 exactly-once ownership、状态、置信度、Evidence 和确定性附件。
- 新增无图片、无脚本、无外部资源的 desktop-only Renderer，以及独立 CLI。
- 将 Showcase 合并进现有一次 Report Editorial Planner 调用，普通 provider、Schema 或预算失败会同时生成 Canonical Report fallback 和确定性 Showcase fallback。
- 新增独立 Publication 补偿、`ReportPackageV3`、V1/V2/V3 读取兼容、最终根恢复、Zero 根校验、owner-bound HTML 路由和 Stage 4 下载入口。
- 新增 1440 × 900 离线 Chromium 与 A4 print 验收；生产代码和普通 CI 不读取 GPT-5.6 样例或 `run-workspaces`。
- 使用已审京东众筹材料执行了一次不写回历史 Attempt 的本地 deterministic composition：152 个 presentation unit、168 个 leaf 被编译为 9 个章节、10 个组件，HTML 95,481 bytes；224 个可显示 Canonical 值全部保留，1440px 无横向溢出，DOM ID 无重复，无图片、外部请求或浏览器错误。
- 独立复核补齐了 Summary 组件内容保真、多个 Matrix unit、Chart 表格替代、负责人字段、Spec provenance、outline signature、必答内容自动提升、附件折叠和 Zero 对 Package V3 的兼容测试。
- 已完成一次真实 Gateway `ReportEditorialIntentV2` composition-only 验收：单次 structured call、单份 succeeded Receipt、无模型漂移；152 个 unit、168 个 leaf 与 64 条审计记录均与 deterministic projection 等价。模型生成 8 个章节、11 个组件，Showcase HTML 98,283 bytes，228 个可显示 Material 值无缺失，1440px 无横向溢出、无图片、无外部请求或浏览器错误，A4 打印 27 页。
- 三类固定 canary 已完成：京东众筹、宠物食品和纯叙述报告生成 3 个不同 `showcaseOutlineSignature`；1440px 均无横向溢出、无重复 DOM ID、无图片或外部请求，A4 输出分别为 24、20 和 3 页。验证材料位于 `run-workspaces/editorial-acceptance/editorial-showcase-v1-three-shape-canary-2026-08-30/`。
- 独立合并门禁复核发现的 5 个 P1 已全部关闭：Source Register 不再扩展未绑定 Evidence；封存 Spec 绑定 Evidence Manifest Artifact ID、内容 hash 与 semantic hash；缺失置信度按 unknown 传播并展示解释；Showcase unavailable 进入 `completed_with_gaps`；数据库恢复、失效和重试路径覆盖两个新 Artifact kind。复核结论为 `OK with notes`。
- 当前全量离线测试为 2,098 通过、0 失败、15 跳过；TypeScript、Registry、Knowledge 和 diff check 均通过。

当前剩余发布工作是在测试环境同时开启三个报告开关完成发布 canary；它不阻塞默认关闭状态下合并代码。

## 1. 结论

在现有研究流程末端增加一个独立的 `Editorial Showcase Publication` 模块，将 GPT-5.6 样例中验证有效的视觉语言和信息组织原则提炼为确定性展示能力。`editorial-showcase-v1` 是可迁移的设计系统与组合语法，不是固定页面模板，也不依赖该样例文件。不同课题必须根据 Canonical 的语义结构生成不同的章节数量、顺序、组件组合、重点层级和版面节奏。

该模块不属于 Research Skill，也不参与前期研究、证据收集、Contributor 分析、Synthesis 或 Review。它只在 Final Review 通过后读取 Reviewed Canonical、Evidence、Trace 和审计信息，生成一份离线桌面 HTML。

模型不直接输出 HTML、CSS 或 JavaScript。模型只返回受约束的展示意图，确定性 Compiler 负责来源绑定、状态与置信度派生、完整性补全，确定性 Renderer 负责最终 HTML。这一做法遵守 ADR-0008，不引入第二份事实源。

现有 Canonical ReportDocument 和 Standalone HTML 继续保留。Showcase 作为新的首选阅读版本进入 Report Package，原 HTML 作为审计与回滚版本保留。

## 2. 已确认范围

### 2.1 本期交付

- 将 GPT-5.6 样例中验证有效的视觉与信息组织原则提炼为可迁移 Profile，Profile ID 为 `editorial-showcase-v1`。
- 支持 `research_strategy_report`。
- 在 Final Review 通过后自动生成 Showcase。
- 输出完全离线的桌面 HTML。
- 保留 A4 打印能力，打印属于同一文档的导出形式，不作为另一终端适配。
- 支持跨 Canonical unit 的编辑聚合，例如用户原型、JTBD 矩阵、Journey、信任障碍图和行动路线图。
- 章节数量、章节顺序、组件组合、组件 variant、宽度占位与重点层级由内容结构和 Showcase Intent 决定，不使用固定页面骨架。
- 相同视觉 Profile 下，不同报告可以共享排版语言，但不得退化为只替换标题和正文的同构页面。
- 每个主要展示组件绑定 Canonical leaf、Evidence、状态和置信度。
- 未进入主叙事的 Canonical 内容进入完整分析附件，不允许丢失。
- 保留现有正式 HTML，Showcase 失败时仍可交付原报告。

### 2.2 明确不做

- 不让模型直接生成 HTML、CSS、JavaScript、SVG 或 Markdown 页面。
- 不读取未通过 Final Review 的 Skill 输出补写正文。
- 不将 omitted 或 conflicted Contribution 重新写入正文。
- 不把 Simulation Evidence 当作事实或策略依据。
- 不生成用户占比、转化率、流量、漏斗或预测数字。
- 不使用图片、外部字体、CDN、外部脚本、Canvas 或运行时网络资源。
- 不适配手机、平板、Zero、Markdown 或其他终端的 Showcase 视觉。
- 不复制京东众筹案例的章节或文案作为运行时模板。
- 不增加第二 Reviewer、模型修文循环或自动重试。
- 不修改已封存的 Canonical、Evidence、Review 或历史 Report Package。

### 2.3 长期实体变化

`Entity delta: +7 / -0`。

| 新实体 | 类型 | 用途 |
|---|---|---|
| `ReportEditorialIntentV2` | 内部模型输出合同 | 在现有 Report Intent 上增加 Showcase 意图，保持一次模型调用 |
| `EditorialPresentationSpecV1` | 封存合同 | 保存编译后的完整展示结构与来源绑定 |
| `editorial-showcase-v1` | Renderer Profile | 固化已选中的视觉规范，不绑定具体运行模型或案例文件 |
| `report_editorial_showcase_spec` | Artifact kind | 保存完整 Showcase Spec |
| `editorial_showcase_html` | Artifact kind | 保存最终离线 HTML |
| `ReportPackageV3.showcase` | 对外读取字段 | 同时暴露 Canonical HTML 与 Showcase HTML |
| `REPORT_EDITORIAL_SHOWCASE_V1_ENABLED` | Feature Flag | 独立启停和回滚 Showcase |

不增加数据库表、外部服务、图片资源或模型专用配置。

## 3. 当前状态与缺口

当前生产链已经具备以下基础：

1. `ReportEditorialMaterialV1` 保存全量 presentation unit、leaf、Trace 和可用展示形式。
2. `ReportEditorialPlanner` 通过一次结构化模型调用生成部分 Intent 和受控 Copy。
3. `ReportEditorialIntentCompiler` 将模型选择补全为完整 `ReportEditorialBlueprintV1`。
4. `ReportEditorialProjector` 生成 `ReportDocumentV4`。
5. `standalone-html-report-renderer.ts` 从 ReportDocument 确定性生成离线 HTML。
6. `ReportPackageV2` 封存 ReportDocument、Blueprint、HTML 和审计引用。

当前缺口不在 HTML 是否可生成，而在展示层的表达深度：

- `ReportEditorialIntentV1` 主要负责选择、排序和已有 presentation 分配，不能自由组织跨 unit 的编辑组合。
- `ReportDocumentV4` 的通用 Block 足以保证内容完整，但不能直接表达 Evidence Boundary、Persona Grid、JTBD Matrix、Trust Map 等组合结构。
- Standalone Renderer 只能忠实渲染 ReportDocument，无法产生 GPT-5.6 Showcase 的章节节奏和视觉层级。
- 直接让模型输出 HTML 虽然可以快速得到单个案例效果，但会绕过 Schema、Trace、HTML 转义和确定性回退，也与 ADR-0008 冲突。

因此，本方案新增一个独立的 Showcase 编译分支，不替换当前 Canonical 编译链。

## 4. 目标架构

```text
Research Task
    ↓
Plan → Skill / Tool → Research Contributions
    ↓
Synthesis → Cross-skill Review
    ↓
Reviewed Canonical + Final Review PASS
    ↓
ReportEditorialMaterialV1
    ↓
一次 Report Editorial Planner 结构化调用
    ├─ 现有 Report Intent
    └─ Showcase Intent
          ↓
Deterministic Showcase Compiler
    ├─ 校验 leaf 与 Evidence
    ├─ 派生 status 与 confidence
    ├─ 约束跨 unit 聚合
    ├─ 补齐未选 Canonical 内容
    └─ 生成 EditorialPresentationSpecV1
          ↓
Deterministic Showcase Renderer
    ├─ editorial-showcase-v1 视觉 Profile
    ├─ HTML/CSS-only 信息图组件
    ├─ CSP 与文本转义
    └─ desktop + print
          ↓
Showcase Validation
          ↓
SEALED Showcase Spec + Showcase HTML
          ↓
Report Package v3
```

数据流没有回边。Showcase 不影响研究结论，也不向 Synthesis 或 Review 回写内容。

## 5. 模块与接缝

### 5.1 外部接缝

新增深模块 `EditorialShowcasePublication`。调用方只需要提供已校验的报告绑定、`ReportEditorialMaterialV1`、通过的 Final Review、Evidence Manifest、可选 Contribution Ledger、模型身份和 Active Lease。

模块返回：

- 已封存的 Showcase Spec Artifact。
- 已封存的 Showcase HTML Artifact。
- 生成模式：`model` 或 `fallback`。
- Renderer 版本和视觉 Profile ID。
- 稳定 Notice 与诊断摘要。

调用方不需要了解 Prompt、组件选择、状态聚合、HTML 转义、CSS、CSP 或浏览器校验细节。

### 5.2 内部模块

| 模块 | 责任 |
|---|---|
| `EditorialShowcasePlanner` | 从 planner-safe Material 生成部分 Showcase Intent，与现有 Report Intent 共用一次模型调用 |
| `EditorialShowcaseCompiler` | 校验引用、补全内容、派生状态与置信度，生成完整 Presentation Spec |
| `EditorialShowcaseRenderer` | 使用固定视觉 Profile 将 Spec 渲染为无网络 HTML |
| `EditorialShowcaseValidator` | 校验来源、DOM、CSP、桌面布局和打印完整性 |
| `EditorialShowcasePublication` | 组织 Artifact 封存、Lease 校验、失败补偿和返回结果 |

删除上述模块时，复杂度会重新散落到 Planner、Execution Engine、Renderer 和 Package Reader，因此该模块具有足够深度。

## 6. 数据合同

### 6.1 `ReportEditorialIntentV2`

模型调用从 `ReportEditorialIntentV1` 升级为 V2。V2 保留现有 `style`、`density`、`mainSections` 和 `copyFragments`，并增加一个可选 `showcase` 对象。Showcase 关闭时继续使用 V1，现有路径不受影响。

`showcase` 包含：

- 固定 `profileId: "editorial-showcase-v1"`。
- 主报告章节顺序和每节承担的叙事任务。
- 每个章节的布局节奏，例如单列结论、左右对置、非对称网格、全宽矩阵或阶段流。
- 每个组件的 kind、variant、emphasis 和 span。
- 每个组件引用的 `sourceLeafIds`。
- 组件内部的分组与排序建议。

V2 顶层继续保留现有 `copyFragments`，用于正式 ReportDocument 的标题、摘要、导语和过渡。Showcase V1 不增加第二套模型文案：报告标题来自 Canonical，章节标题由 purpose 映射，组件标题来自 unit title 或稳定系统标签。

Intent 不允许包含：

- HTML、CSS、JavaScript 或 Markdown。
- 新的 Evidence ID、URL、状态、置信度、优先级或数字。
- 原 Canonical 中不存在的实体、用户结论或因果关系。
- Appendix 内容清单。
- Artifact 存储路径、内部 Prompt 或未脱敏诊断。

模型只决定结构如何组织，不决定什么是真的，也不直接生成 Showcase 可见文案。组件正文使用 Canonical 原文或确定性序列化；现有 Report Copy 继续只服务正式 ReportDocument。

### 6.2 `EditorialPresentationSpecV1`

Compiler 输出并封存完整 Spec。顶层字段包括：

| 字段 | 含义 |
|---|---|
| `version` | 固定为 `editorial-presentation-spec-v1` |
| `binding` | Task、Plan、Attempt、Deliverable、Review 和 Evidence 的 Artifact ID 与 hash |
| `profileId` | 固定为 `editorial-showcase-v1` |
| `generationMode` | `model` 或 `fallback` |
| `sections` | 完整主报告、Supporting 和 Appendix 结构 |
| `ownedLeafIds` | 每个组件实际承载的 Canonical leaf |
| `sourceLeafIds` | 标题、摘要和聚合判断的来源 leaf，可跨组件重复引用 |
| `sourceContributionUnitIds` | 只允许 Ledger 中 included 或 merged 的单元 |
| `evidenceIds` | 由 leaf Trace 确定性合并 |
| `status` | 由来源状态确定性派生 |
| `confidence` | 由来源置信度确定性派生，可为空 |
| `notices` | fallback、数据边界和审计提示 |

`ownedLeafIds` 与 `sourceLeafIds` 分开：

- 每个 Canonical leaf 必须恰好由一个正文或附件组件拥有。
- Hero、章节导语和聚合标题可以重复引用来源 leaf，但不能重复承载正文。
- 未被模型选择的 leaf 由 Compiler 自动放入完整分析附件。
- 最终 `ownedLeafIds` 集合必须与 Material 的 required leaf 集合完全一致。

### 6.3 状态与置信度派生

模型不能写 `status` 和 `confidence`。

Compiler 使用以下规则：

1. 单 leaf 组件直接使用对应 Trace 的状态与置信度。
2. 多 leaf 组件的状态按 `unanswered > provisional > supported` 取最弱值。
3. 多 leaf 组件的置信度默认取最小值，避免平均值掩盖弱证据。
4. 如果来源没有置信度，组件置信度为空，不补零、不猜测。
5. Confidence Bar 只允许展示 Canonical 已存在的数值。
6. 页面必须注明置信度不是用户占比、发生概率或效果预测。

### 6.4 Contribution 与 Simulation

- `included` 和 `merged` Contribution 可以通过 Canonical Trace 进入 `sourceContributionUnitIds`。
- `omitted` 和 `conflicted` Contribution 禁止进入正文或派生 Copy。
- Simulation Evidence 只能进入带 `simulation_quarantine` 角色的审计组件。
- Simulation 不得参与组件状态、置信度、结论或推荐计算。
- 没有 Contribution Ledger 时，`sourceContributionUnitIds` 固定为空，不从 Step Artifact 猜测。

## 7. 通用展示组件

V1 使用以下通用组件，不创建京东众筹专用组件：

| Kind | 使用条件 | 不满足时 |
|---|---|---|
| `editorial-hero` | 有标题、执行摘要和至少一个来源 leaf | 使用 Canonical 标题与摘要 |
| `evidence-boundary` | leaf 可以按 supported、provisional、unanswered 分组 | `narrative-list` |
| `confidence-bars` | 来源含明确数值置信度 | 省略该组件 |
| `timeline` | Canonical 有显式时间或先后关系 | `narrative-list` |
| `profile-grid` | 有多个结构一致的角色、对象或心智节点 | `record-table` 或 `narrative-list` |
| `matrix` | 有显式行、列和单元关系 | `record-table` |
| `stage-flow` | 有显式阶段顺序 | `narrative-list` |
| `tension-map` | 有成对的阻力与响应关系 | 两组 `narrative-list` |
| `principle-list` | 有显式原则记录 | `narrative-list` |
| `priority-lanes` | 行动带明确 P0、P1、P2 | `record-table` |
| `validation-list` | 有 validationNeeded 或开放问题 | `narrative-list` |
| `source-register` | Evidence Manifest 可用 | 按 ID 顺序的文本表 |
| `narrative-list` | 任意无法安全结构化的内容 | 最终兜底 |

这些组件全部由 HTML 和 CSS 绘制。V1 禁止 `<img>`、`<picture>`、`<svg>`、`<canvas>` 和 CSS 外部资源。

## 8. Showcase 视觉 Profile

`editorial-showcase-v1` 提炼自当前已验收的 GPT-5.6 样例，但运行时只依赖代码中的 Token、组件和组合规则，不依赖生成该设计的模型，也不依赖京东众筹案例文件。

### 8.1 视觉 Token

- 页面底色：暖纸色 `oklch(95.5% 0.014 82)`。
- 正文底色：`oklch(98.8% 0.006 78)`。
- 主文字：深墨色 `oklch(20.5% 0.013 54)`。
- 强调色：京东红 `oklch(55% 0.22 28)`。
- 状态色：绿色表示 supported，琥珀色表示 provisional，红色表示 unknown，蓝色表示方法或审计信息。
- 展示标题：系统宋体栈。
- 正文：系统无衬线栈。
- 圆角只使用 `2px`、`8px` 和胶囊状态标签。
- 页面采用连续编辑章节，不使用统一圆角阴影卡片铺满页面。

### 8.2 固定版面边界

- 唯一屏幕验收尺寸为 `1440 × 900`。
- 页面最大宽度为 `1480px`。
- 左侧目录可以出现，但不是每份报告的强制结构；是否使用目录由章节数量决定。
- Hero 必须在首屏内呈现标题和核心判断；Evidence Boundary 只在材料存在状态冲突或重大未知时出现。
- 主章节共享编号、标题、导语和证据状态的视觉语言，但章节数量与顺序不固定。
- 表格允许组件内部横向滚动，但 1440px 下不应触发。
- 不定义移动端断点，不把移动端截图作为发布门禁。
- 保留 A4 打印样式，隐藏目录和操作控件，正文与附件不得丢失。

### 8.3 内容驱动的组合规则

视觉 Profile 固定以下内容：

- 字体、颜色、间距、状态语义、边框和页面宽度。
- 每类组件可使用的 DOM 与 CSS variant。
- Hero、章节标题、来源标记和附件的视觉家族。
- 安全、可访问性和打印规则。

每份报告动态决定以下内容：

- 是否需要 Hero 右侧 Evidence Boundary、结论板或其他首屏结构。
- 主章节数量、名称、顺序和篇幅。
- `profile-grid`、`timeline`、`matrix`、`stage-flow`、`tension-map`、`priority-lanes` 等组件是否出现。
- 同一组件采用的 variant、列宽、强调级别和信息密度。
- 哪些内容进入主叙事、Supporting 或完整分析附件。
- 报告标题使用 Canonical 标题，章节标题由 purpose 映射，组件标题来自 unit title 或稳定系统标签。

组件选择必须由 Material shape 和语义资格驱动。例如，没有显式时间关系就不能使用 Timeline，没有明确 P0、P1、P2 就不能使用 Priority Lanes，没有平行角色字段就不能使用 Profile Grid。系统不设置固定章节数或“至少出现几种组件”的硬门槛，但只要存在合格结构，就应优先使用对应的丰富组件，而不是全部降级为正文卡片。

Compiler 输出一个 `showcaseOutlineSignature`，由章节 purpose、组件 kind、variant、emphasis、span 以及各组件承载的 unit/leaf 数量组成的有序结构计算。固定案例验收要求不同语义结构的报告生成不同 signature；只有输入语义结构与 ownership cardinality 相同且模型选择相同时，页面骨架才允许一致。

### 8.4 设计来源与可迁移性

当前 GPT-5.6 Showcase 是设计来源和人工比对样例：

`run-workspaces/full-e2e/jd-crowdfunding-users-motivation-2026-08-29-1545-synthesis/editorial-showcase/editorial-showcase.html`

SHA-256：

`06ec4abbfeca7696c8c36d99a125a4e6813dc0b4c414eca7760d6a6f4f73083c`

该文件不是运行依赖，也不是普通 CI 的必需 fixture。实施时只把以下可迁移内容写入源码：

- `editorial-showcase-v1` 的设计 Token。
- 组件 DOM 与 CSS variant。
- 组件适用条件和组合规则。
- 一个不含京东众筹内容的通用结构 fixture。

原案例可以留在原工作区供人工视觉回看，但生产 Renderer、构建、测试和发布不得读取它。迁移项目时即使不携带该案例，Showcase 仍应正常生成；缺少它只会失去历史人工对照样本，不影响运行时和普通 CI。应增加测试，扫描生产代码和测试配置，禁止引用该 `run-workspaces` 路径。

## 9. Planner 与 Compiler 行为

### 9.1 单次模型调用

现有 `ReportEditorialPlanner` 的一次结构化调用升级为组合输出：

- 现有 Report Intent 和 Copy fragments。
- 新增 Showcase Intent。

不增加第二次模型调用。视觉 Profile 与具体模型解耦，运行时继续使用当前任务已经锁定并记录 Receipt 的模型。`editorial-showcase-v1` 记录独立设计系统的版本，不携带模型名，也不要求迁移 GPT-5.6 样例。

### 9.2 Planner-safe 输入

模型只能看到：

- 文档标题、决策语境和执行答案。
- Presentation unit 的 ID、semantic kind、shape、标题和允许的展示形式。
- Leaf ID、受审文本、状态、置信度和 Evidence ID。
- Placement policy。
- Showcase 组件白名单和数量上限。

模型看不到：

- 文件系统路径。
- Artifact 存储地址。
- 原始二进制内容。
- 完整 Prompt、内部错误或敏感字段。
- omitted 或 conflicted Contribution 正文。

### 9.3 Compiler 后置条件

- 所有组件 kind 均在白名单内。
- 所有 non-empty leaf ID 存在于 Material。
- `ownedLeafIds` 无重复且全量覆盖 required leaves。
- `sourceLeafIds` 只能引用当前组件允许范围内的 leaf。
- 所有 Evidence ID 均由 leaf Trace 派生并存在于 Manifest。
- 状态、置信度、优先级和数字与 Canonical 一致。
- Simulation 只进入隔离附件。
- model Copy 未通过现有 Copy Validator 时局部回退。
- 任一结构错误导致整份 Showcase Intent 退回确定性 Showcase Spec，不进行模型修复调用。

## 10. Renderer 合同

`EditorialShowcaseRenderer` 是无 I/O 的纯模块，输入完整 Spec，输出 HTML 字符串与 Render Manifest。

Renderer 必须：

- 对所有文本和属性执行 HTML 上下文转义。
- 输出固定 CSP，禁止外部资源、表单和运行时脚本。
- 不输出图片、SVG、Canvas 或远程字体。
- 不解析标题前缀猜测语义。
- 不根据案例名称选择布局。
- 使用唯一 DOM ID。
- 输出组件级 `data-component-id`、`data-status`、`data-confidence`、`data-source-leaf-ids`、`data-source-contribution-unit-ids` 和 `data-evidence-ids`。
- 在 HTML `<meta>` 中写入 Canonical、Spec 和 Renderer hash。
- 将全部 Supporting 与 Appendix 内容写入同一 DOM，打印时不创建重复副本。
- 不包含需要网络或客户端框架才能工作的交互。

## 11. Artifact 与 Report Package

### 11.1 新增 Artifact

| Kind | Schema | 路径 | 作用 |
|---|---|---|---|
| `report_editorial_showcase_spec` | `editorial-presentation-spec-v1` | `reports/editorial-showcase-spec.json` | 保存编译后的完整展示规格 |
| `editorial_showcase_html` | `editorial-showcase-html-v1` | `reports/editorial-showcase.html` | 保存确定性离线 HTML |

两个 Artifact 都必须绑定同一 Task、Plan 和 Attempt，并在 Report Publication Group 中封存。Package 封存失败或 Lease 丢失时，两者参与同组补偿失效。

### 11.2 `ReportPackageV3`

V3 保留 V2 全部字段，并新增：

- `preferredHtml: "showcase" | "canonical"`。
- `showcase.status: "ready" | "unavailable"`。
- Ready 状态包含 Spec Artifact ID、HTML Artifact ID、Renderer 版本、Profile ID、generation mode 和 outline signature；来源 ReportDocument hash 继续由被引用的 Canonical Package V2 提供。
- Unavailable 状态包含稳定 reason code。

历史 `ReportPackageV1/V2` Reader 继续保留。Showcase 开关关闭时继续生成 V2；开启时生成 V3，默认 `preferredHtml="showcase"`，原 `standaloneHtml` 仍保留。

## 12. 运行时接入点

接入位置为 `LeaseExecutionEngine` 中 Final Review `pass` 之后、Report Package 封存之前。

执行顺序：

1. 读取并校验 Deliverable、Evidence Manifest 和 Final Review 的 sealed binding。
2. 由现有 `ReportCompositionService` 构建一次 `ReportEditorialMaterialV1`。
3. 现有 Planner 在一次 structured call 中返回 Report Intent 与 Showcase Intent。
4. 现有 Intent Compiler 生成正式 Blueprint。
5. Showcase Compiler 生成完整 Presentation Spec。
6. 分别生成 `ReportDocumentV4`、Canonical HTML 和 Showcase HTML。
7. 执行 Showcase 静态与 Chromium 校验。
8. 封存 Spec、两份 HTML 和 Report Package V3。
9. 成功后提交 Publication Group，再完成 Attempt。

Showcase 不作为新的执行计划 Step，不占用 Research Skill 的 step number，也不改变 Question Answer Owner 或 Contribution Owner。

## 13. 失败与降级

### 13.1 硬阻断 Showcase

以下情况不允许发布 Showcase：

- Final Review 不是 `pass`。
- Artifact hash 或 Task、Plan、Attempt binding 不一致。
- 引用了未知 Canonical leaf 或 Evidence ID。
- 引用了 omitted 或 conflicted Contribution。
- Simulation 进入事实性组件。
- `ownedLeafIds` 缺失、重复或未全量覆盖。
- Renderer 输出包含未转义内容、外部依赖或不允许的标签。

硬阻断 Showcase 不删除已通过 Review 的 Canonical。原 ReportDocument 和 Canonical HTML 仍可进入 Package，Attempt 状态为 `completed_with_gaps`，Showcase 标记为 unavailable。

### 13.2 确定性降级

以下情况直接使用确定性 Showcase Spec，不重试模型：

- Provider 超时或普通 5xx。
- 模型输出不是合法 JSON。
- Schema 校验失败。
- 组件组合不合法。
- Copy fragment 被拒绝。
- 输入超过模型预算。

确定性版本按固定顺序输出：执行答案、Evidence Boundary、关键框架、行动、验证、完整分析附件和证据附录。

### 13.3 Reason code

新增稳定 reason code：

- `showcase_planner_disabled`
- `showcase_data_policy_denied`
- `showcase_material_budget_exceeded`
- `showcase_provider_failure`
- `showcase_invalid_intent`
- `showcase_invalid_binding`
- `showcase_renderer_failure`
- `showcase_validation_failure`

## 14. Feature Flag 与配置

新增：

```dotenv
REPORT_EDITORIAL_SHOWCASE_V1_ENABLED=false
```

不新增 GPT-5.6 专用模型配置。Showcase 使用当前任务已经 pin 并写入 Receipt 的模型，视觉稳定性由 `editorial-showcase-v1` Profile 保证。

启用条件：

- `REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED=true`
- `STANDALONE_HTML_BUNDLE_V1_ENABLED=true`
- `REPORT_EDITORIAL_SHOWCASE_V1_ENABLED=true`

关闭 Showcase 开关后，系统完整回到当前 ReportDocumentV4 和 ReportPackageV2 路径。

## 15. 分期实施

本方案预计新增或修改 28 至 35 个文件，不新增数据库表和第三方依赖。文件数较多，主要来自新合同、Package V3、Reader 兼容、Recovery 和分层测试；不应把这些改动压进单个提交。

### Phase 1：离线 Showcase Compiler 与 Renderer

新增：

- `packages/api-contract/report-editorial-showcase.ts`
- `schemas/report-editorial-intent-v2.schema.json`
- `schemas/editorial-presentation-spec-v1.schema.json`
- `apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-showcase-renderer.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-showcase-profile.ts`
- `scripts/report-editorial-showcase.ts`
- `tests/report-editorial-showcase-compiler.test.ts`
- `tests/report-editorial-showcase-renderer.test.ts`
- `tests/fixtures/report-editorial/showcase-structure-fixtures.ts`
- `tests/fixtures/report-editorial/showcase-profile-v1-contract.json`

修改：

- `packages/api-contract/report-editorial.ts`
- Schema registry 相关文件。

Phase 1 完成后，可以从一个冻结的已审 Attempt 生成 Showcase HTML，适合本地和验收环境使用。生产执行链不变。

### Phase 2：正式运行与 Package 接入

新增：

- `apps/orchestrator-runtime/src/report/report-editorial-showcase-publication.ts`
- `apps/orchestrator-runtime/src/report/report-package-v3-artifact.ts`
- `schemas/report-package-v3.schema.json`
- `tests/report-editorial-showcase-publication.test.ts`
- `tests/report-package-v3.test.ts`

修改：

- `apps/orchestrator-runtime/src/report/report-editorial-planner.ts`
- `apps/orchestrator-runtime/src/report/report-composition-service.ts`
- `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- `apps/orchestrator-runtime/src/control/execution-recovery-service.ts`
- `apps/orchestrator-runtime/src/report/current-report-package-reader.ts`
- `apps/orchestrator-runtime/src/report/standalone-html-report-package.ts`
- `packages/api-contract/report-package.ts`
- `packages/api-contract/control-workflow.ts`
- `apps/web/src/reporting/report-bundle.ts`
- `apps/agent-api/src/control-runtime.ts`
- `apps/agent-api/src/routes/system-capabilities.ts`
- `.env.example`

Phase 2 完成后，新 Attempt 可以自动生成并下载 Showcase，同时保留 Canonical HTML。

### Phase 3：固定案例验收与启用

新增或修改：

- `scripts/report-editorial-acceptance.ts`
- `tests/report-editorial-showcase-acceptance.test.ts`
- 京东众筹、宠物食品和纯叙述三类脱敏 fixture。
- `docs/adr/0008-adopt-reusable-editorial-report-pipeline.md`
- 本文档的实施状态。

Phase 3 的三类固定 canary、京东众筹 deterministic composition 和真实 Gateway Intent v2 composition-only 验收已通过。真实模型运行只调用一次 Report Editorial Planner，Receipt 为 succeeded，模型身份无漂移；测试环境三开关发布 canary 仍待执行。

## 16. 测试矩阵

| 层级 | Happy path | 错误与降级 | 边界 |
|---|---|---|---|
| Intent Schema | 合法章节、组件和 leaf 分组 | 未知字段、HTML、未知 kind | 空章节、组件上限、Copy 上限 |
| Compiler | 跨 unit 聚合并完整补附件 | 重复 owner、未知 leaf、非法 Evidence | 无结构素材、无置信度、全部 provisional |
| Provenance | leaf、Evidence、Contribution 全部合法 | omitted、conflicted、SIM 越权 | 无 Ledger、无 Evidence 的系统文案 |
| Renderer | 13 类组件正常输出 | 不支持 kind、超出字节预算 | 长中文、长 URL、空值、特殊字符 |
| Security | CSP、HTML 转义、无网络 | script、event handler、外部资源 | 审计超链接不在加载时发请求 |
| Desktop | 1440 × 900 无页面级溢出 | 长表格与长 hash | 首屏、目录、章节定位 |
| Print | A4 全量可打印 | 组件跨页与表头重复 | Appendix、长表格、URL 换行 |
| Publication | Spec、HTML、Package 同组封存 | Lease 丢失、Package 写失败 | Recovery、重复执行、历史 V2 |
| Portability | 在不含原案例和 `run-workspaces` 的临时目录生成报告 | 引用原案例路径时测试失败 | 新仓库根路径、通用 fixture |
| Model | 一次 structured call | timeout、Schema 失败、预算超限 | actual model receipt 与 fallback |

## 17. 验收标准

### 17.1 内容与来源

- Showcase 只在 Final Review `pass` 后生成。
- Canonical、Evidence、Review 和 Package 的输入 hash 前后不变。
- 每个组件的非空 `sourceLeafIds` 都存在于 Material 和 ReportDocument Trace。
- 每个 Evidence ID 都存在于 Evidence Manifest。
- `ownedLeafIds` 对 required leaf 实现恰好一次覆盖。
- omitted 和 conflicted Contribution 不进入任何正文组件。
- Simulation 只进入隔离附件。
- 状态、置信度、优先级、数字、日期、URL 不发生漂移。

### 17.2 HTML

- HTML 不包含图片、SVG、Canvas 或外部运行时依赖。
- HTML 不包含未授权脚本或事件处理器。
- DOM ID 唯一。
- 1440 × 900 下 `scrollWidth === clientWidth`。
- 首屏包含标题、核心判断和 Evidence Boundary。
- 标题层级完整，目录锚点有效。
- Console Error 和 Page Error 为零。
- A4 打印包含正文、Supporting、完整分析附件和审计附件。
- 在不复制 GPT-5.6 案例且不存在 `run-workspaces` 目录的临时工作区中，通用 fixture 仍能生成相同 Profile 的合法 HTML。

### 17.3 视觉

- 使用 `editorial-showcase-v1` Token、组件家族和排版语法。
- 页面可以只靠标题完成快速扫描。
- 每节只承担一个主要任务。
- 状态色只表达证据语义，不作为装饰色滥用。
- 不出现统一圆角阴影卡片铺满页面的模板感。
- 不要求像素级复刻 Golden，但首屏层级、连续章节、非对称信息组织和证据状态表达必须保持。
- 京东众筹、宠物食品和纯叙述 fixture 的 `showcaseOutlineSignature` 不得全部相同。
- 同一 fixture 的确定性 fallback 重复运行必须产生相同 signature 和 HTML hash。
- 人工验收必须确认报告不是固定模板换文案，组件组合能解释该课题独有的 Canonical shape。

## 18. 验证命令

当前定向验证入口：

```bash
pnpm exec tsx --test \
  tests/report-editorial-plan-v2.test.ts \
  tests/report-editorial-showcase-compiler.test.ts \
  tests/report-editorial-showcase-renderer.test.ts \
  tests/report-editorial-showcase-publication.test.ts \
  tests/report-editorial-showcase-cli.test.ts \
  tests/report-editorial-showcase-chromium.test.ts \
  tests/report-package-v3.test.ts \
  tests/report-package-v3-artifact.test.ts \
  tests/report-composition-v3.test.ts

pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
git diff --check
pnpm test
```

真实模型验收通过显式 CLI 运行，不进入普通 CI。每次运行最多产生一次 Report Editorial Planner 语义调用，并保存 Receipt、输入 hash、compiled Spec、HTML 和验证摘要。2026-08-30 的京东众筹验收输出位于 `run-workspaces/editorial-acceptance/editorial-showcase-v1-jd-crowdfunding-real-intent-v2-2026-08-30/`。

```bash
set -a; source .env; set +a
pnpm exec tsx scripts/report-editorial-acceptance.ts \
  --attempt-dir "$PWD/run-workspaces/current-control/tasks/<task-id>/attempts/<attempt-id>" \
  --output-dir "$PWD/run-workspaces/editorial-acceptance/<new-output-dir>" \
  --model "$LLM_MODEL_NAME" \
  --showcase true
```

## 19. 发布与回滚

发布顺序：

1. 合并 Phase 1，保留生产链不变。
2. 使用冻结的京东众筹 Attempt 做一次人工视觉对照，同时确认生产代码和普通 CI 不读取该案例路径。
3. 合并 Phase 2，Reader 先于 Writer 发布。
4. 在测试环境开启 `REPORT_EDITORIAL_SHOWCASE_V1_ENABLED`。
5. 对三类固定案例执行真实 composition-only 验收。
6. 人工确认阅读层级后，再由发布负责人开启正式环境。

回滚方式：

- 关闭 `REPORT_EDITORIAL_SHOWCASE_V1_ENABLED`。
- Package Reader 继续读取历史 V1/V2 和新 V3 中的 Canonical HTML。
- 已封存 Showcase Artifact 保留用于审计，不删除、不覆盖、不 downcast。
- 回滚不需要数据库迁移，也不影响研究、Synthesis、Review 或 Canonical 结果。

## 20. 风险与前提

### 20.1 最脆弱的前提

本方案依赖 Canonical 提供足够明确的 leaf、状态和结构。如果某份报告只有散文，没有角色、阶段、关系、时间或优先级结构，Showcase 必须退化为 Editorial Hero、Narrative List、Validation List 和 Source Register，不能从散文猜测 Persona、Journey、矩阵或数字。

### 20.2 主要风险

| 风险 | 处理 |
|---|---|
| 模型为了视觉完整性补写事实 | 模型只返回 leaf 引用与受控 Copy，业务字段由 Compiler 填充 |
| Showcase 成为第二份事实源 | Canonical 保持唯一事实源，Spec 和 HTML 都记录来源 hash |
| 同一 leaf 被多个组件重复承载 | `ownedLeafIds` exactly-once 校验 |
| 视觉 Profile 逐步漂移 | 固定 Token、DOM 结构断言和 Golden 人工对照 |
| 模型失败导致整次任务失败 | 使用确定性 Showcase Spec，保留 Canonical HTML |
| Package 升级影响历史报告 | Reader 先发布并继续支持 V1/V2 |
| 当前工作树包含其他 WIP | 实施时只修改本文列出的文件，提交前按路径审查 diff |

## 21. 最终 Definition of Done

- 现有 GPT-5.6 Showcase 只保留为可选人工参考；生产代码、构建和普通 CI 在缺少该文件时仍能完整运行。
- `editorial-showcase-v1` 只固定视觉 Token、组件家族和组合语法，不固定章节骨架，也不依赖 GPT-5.6 样例文件。
- Showcase 由结构化 Intent、确定性 Compiler 和确定性 Renderer 生成。
- 不同语义结构的固定案例会生成不同的章节与组件 signature，不是模板换文案。
- 模型不输出 HTML、CSS、JavaScript、状态、置信度、Evidence 或业务数字。
- 前期 Skill、Tool、Synthesis、Cross-skill Review 和 Final Review 流程保持不变。
- Final Review 通过后自动生成 Showcase Spec 与离线 HTML。
- Canonical HTML 与 Showcase HTML 同时存在，Showcase 为默认阅读版本。
- 无图片、无外部资源、无移动端适配要求。
- 1440px 桌面、A4 打印、来源完整性、安全和 Recovery 测试全部通过。
- 关闭单一 Feature Flag 即可完整回退。
