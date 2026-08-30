# 可复用编辑型 HTML 报告生成开发文档

> 状态：Milestone A-core、A-model 与 A-experience 编辑体验纵切片均已实现并通过范围内验收，相关 Writer/模型开关默认仍关闭；Milestone B–F 尚未开始
>
> 方案范围：Milestone A-core（A1–A3）是已完成的基础平台，A-model 是已实现但默认关闭的结构编排增强；当前不再按原 B→C→D→E 顺序推进，而是先完成 A-experience 编辑体验纵切片。B、F 延后，原 C/D/E 仅保留为长期能力清单，其与 A-experience 冲突的合同和顺序不再作为当前实现依据。
>
> 核实日期：2026-08-26
>
> A-core 实施日期：2026-08-27
>
> A-model 实施及单案例验收日期：2026-08-27
>
> A-experience 实施及 `research_plan` 同素材验收日期：2026-08-27
>
> 核实分支：`feat/research-answer-dynamic-reports`
>
> 核实提交：`617cf1adc9335a4a78a5dfe4865d32f8037e7985`
>
> 说明：核实时工作树已有未提交改动；本文描述的是该工作树的实际行为，不把这些既有改动归入本方案。
>
> 核心约束：`docs/adr/0005-model-directed-typed-report-layout.md`、`docs/adr/0006-lossless-canonical-deliverable-compilation.md`、`docs/adr/0007-universal-multi-skill-orchestration.md`、`docs/adr/0008-adopt-reusable-editorial-report-pipeline.md`
>
> 验证案例：`run-workspaces/current-control/tasks/055a2658-8b6c-4bd7-9078-43636feb9df7/attempts/105dbbe2-1e92-47a0-8062-0e2da78fea4e/reports/crowdfunding-editorial-report-demo.html`
>
> A-model 验收产物：`run-workspaces/editorial-acceptance/pet-food-ecommerce-a-model-2026-08-27/`
>
> A-experience 验收产物：`run-workspaces/editorial-acceptance/pet-food-ecommerce-a-experience-2026-08-27/`

## 0. 实施状态（2026-08-27）

Milestone A-core 已完成：ReportDocument v3、确定性 Material → Blueprint → Projector、四端 Reader/Renderer、Standalone HTML Bundle、Report Package v2、固定根读取、Lease/Recovery 补偿和 owner-bound 下载均已接入生产链。`REPORT_V3_WRITER_ENABLED` 与 `STANDALONE_HTML_BUNDLE_V1_ENABLED` 默认关闭；Canonical inventory 完成前，`record-table`、`graph`、`priority-board` 三种富结构 Writer 继续关闭并使用无损线性化。

A-model 已完成代码实现：`ReportEditorialPlanner` 使用 Planner-safe Material 进行一次结构化模型调用，模型 Blueprint 与 deterministic Blueprint 共用 coverage/fidelity gate、Projector、ReportDocument v3 和 Renderer；普通 Provider/Schema 失败使用确定性 fallback，模型漂移或 Receipt 丢失 fail closed。`REPORT_EDITORIAL_PLANNER_V1_ENABLED` 已接入但默认仍关闭，Milestone B–F 尚未开始。

2026-08-27 使用“宠物食品在电商应该怎么做推广的调研”历史 Attempt 做了一次隔离的 composition-only 真实模型验收。验收只读取既有 Deliverable、Review、Evidence 与 Contribution Ledger，没有重跑研究执行、Synthesis 或 Review，也没有改写历史 Attempt；生成后复核的 24 个输入文件 manifest hash 仍为 `sha256:954b09dbfd0b2734357ffe023e5da57227276616f5c1d5333a6887bbbda691fb`，前后不变。Task、Plan、Attempt 分别为 `84afc74f-3ef6-4dd6-94df-4ebc8c6e8e5f`、`f8c447f0-f89c-4911-89f5-599cb2624d1e`、`45c68955-a136-417f-a8f1-78daa9eab382`。

该次验收结果为 `model` 模式：一次 structured call、一个 Receipt；输入包含 86 个 presentation unit、127 个 leaf 和 27 条 audit record。模型版与 deterministic 版在 presentation unit、leaf、audit record、Trace、Evidence、状态、置信度和 Action priority 上完全一致；HTML 实际呈现 1 个 Table、1 个 Graph、1 个 Priority Board，浏览器检查无横向溢出。Planner 时延约 18.4 秒，prompt/completion token 为 32,029/1,181。配置目标为 GPT-5.5，经 Gateway 路由后 Receipt 记录的实际模型为 `gpt-5.4-2026-03-05`。

展示层修复可以复用已验收的 `selected-blueprint.json` 做隔离重投影，不需要再次调用真实模型。验收脚本将这种运行显式标记为 `runKind=fixture_reprojection`、`modelAcceptanceEligible=false`，其 Summary、Blueprint 来源和 CLI 输出均不得冒充新的真实模型验收证据。

以上只证明 A-model 的实现与一个真实案例的 composition-only 可行性，不等于三个固定 Golden、轻量盲评或首批 50-task canary 已完成，也没有补齐 Package v1 独立开关组合的追溯缺口。因此 A-model 尚不满足默认开启条件，继续默认关闭；B–F 也不得据此视为已开始或已完成。

2026-08-27 A-experience 已完成代码接入。运行时通过 `REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED` 控制；启用后复用同一次 `ReportEditorialPlanner` structured call，以 `report-editorial-plan-v2` 包装既有 Blueprint v1 与 Copy fragments，再确定性投影为 ReportDocument v4。该实现没有修改已发布的 Blueprint v1 合同，也没有增加第二 Reviewer 模型或人工审批状态。Report Package v2、Web、Standalone HTML、Markdown 与 Zero 均可读取 v4；关闭体验开关时，`research_strategy_report` 稳定回到 v3，`research_plan` 回到原报告路径。

同日使用原“宠物食品心智设计表达策略研究计划”历史 `research_plan` Attempt 完成真实 composition-only 验收。Task、Plan、Attempt 分别为 `e16880e3-21c2-4541-9e38-fc750185ee4b`、`e3f6de06-f908-4796-a949-86f7affad0c7`、`70bac736-5ad5-4224-b46e-fc3b5273d99e`；16 个历史输入文件的 manifest hash 在生成前后均为 `sha256:292b05f3c6fb7b31b3bdf4def5c0d10652988068a3be6bd4907a74f174126d49`。验收只调用一次真实模型，输入 30 个 presentation unit、87 个 leaf；模型版与 deterministic 版的 presentation、leaf、Trace、Evidence、状态、置信度和行动优先级完全一致。最终 v4 使用 31 个 Copy fragment、5 个 `card-grid`、1 个 `stage-flow`，桌面与 390px 浏览器检查均无横向溢出。

A-core 定向测试、类型检查、Registry/Knowledge linter 和 diff 检查均通过。2026-08-27 全仓测试为 1982 项：1964 通过、3 失败、15 跳过；3 项失败均位于既有 `tests/control-api-integration.test.ts` planning 链（Scenario guidance、model drift 错误映射、正常 planning 500），不经过本次报告生成路径，未在 A-core 中顺手扩范围修改。

### 0.1 当前执行优先级：A-experience 编辑体验纵切片

2026-08-27 根据旧宠物食品编辑原型与 A-model 验收件的同屏对比，确认 A-model 只证明了“内容无损、结构可编排、HTML 可输出”，尚未达到“标题、摘要、导语、视觉层级和复杂信息表达经过编辑整理”的产品目标。当前执行顺序因此调整为：

```text
A-core / A-model（既有能力，保留）
        ↓
A-experience（当前唯一 P0）
        ├─ Renderer 真正消费 style / density / prominence / graph variant
        ├─ 一次 LLM：结构 + 标题/摘要/导语/过渡文案
        ├─ 两个通用结构：card-grid + stage-flow
        ├─ research_plan 基础 Adapter
        └─ 同一历史素材 composition-only 对比验收
        ↓
再根据真实缺口决定后续 C/D/E；B 与 F 延后
```

本节是当前实施顺序和合同的最高优先级说明。第 19 节中原 B–F 路线仍保留，用于记录此前完整能力设想和未来 backlog；凡涉及“结构 Planner 禁止生成文案”“另起 Copy Writer + 第二 Reviewer 模型”“research_plan 必须等待完整高级 Canonical”或“先开发 B/C 再改善阅读体验”的内容，均由 A-experience 的下列决策取代：

1. `ReportEditorialPlanner` 升级为一次结构化调用，同时输出结构选择和受控 Editorial Copy；不再串联第二个 Copy Writer 或 Reviewer 模型。
2. Copy 只允许覆盖报告标题、执行摘要、章节标题、章节导语和相邻章节过渡；每个 fragment 必须声明非空 `sourceLeafIds`，不得修改 Canonical 正文、数值、Evidence、状态、置信度或行动优先级。
3. 运行时只做必要的确定性检查：Schema、引用范围、非空来源、长度，以及新增数字/日期/金额/比例、优先级、Evidence ID、URL 和状态强化等可机械判断的漂移。单个 fragment 不通过时只回退该 fragment；结构引用或 coverage 不通过时才回退整份 Blueprint。
4. 不增加第二 Reviewer 模型，不增加逐份人工审批，不因主观文风差异阻断报告。模型/局部文案失败通过稳定 Notice 说明，完整 Canonical 结构报告继续交付。
5. Renderer 是 P0：先让既有 `style`、`density`、`section.prominence` 和 `graph.variant` 产生真实视觉差异，并将风险、局限和待解决问题的决策摘要默认展开，Evidence、provenance 和完整审计默认折叠。
6. 首个纵切片只新增 `card-grid` 与 `stage-flow` 两种通用结构。`card-grid` 承载机会、风险、原则和状态；`stage-flow` 承载旅程、时间线、逻辑链和阶段计划。没有明确结构字段时线性降级，不从散文猜关系。
7. 增加最小 `research_plan` Adapter，只消费其已审 Final 与可追溯 Canonical/ReportDocument 材料；历史 Step 只能作为内部诊断来源，不能绕过 Final Review 进入报告。缺少 stage 时使用正文/列表，不伪造时间线。
8. 验收只复用同一历史 Attempt 的既有材料重新执行 composition，不重跑检索、研究、Synthesis 或 Review。先比较旧宠物食品原型与新流程的阅读体验，再用一个非同构案例做最小回归；不以 50-task canary、全 Deliverable 迁移或全库零失败作为本纵切片完成条件。

A-experience 只加工已经生成并审校的素材，不改变原研究执行、搜索、取证、Evidence 或 Canonical 生成流程；仅 `research_plan` Adapter 负责把已有受审结果适配成统一 Material。关闭 A-experience 开关后，系统回到已存在的 deterministic v3/A-model 路径，历史 Artifact 不迁移、不重写。

## 1. 决策摘要

本节及第 2–4 节中的“当前”均指 2026-08-26 的实施前基线；实施后的真实状态以第 0 节为准。

当前项目**没有**使用众筹 Demo 所代表的 HTML 生成流程。对本次重点核实的 `research_strategy_report` Content v2 路径，研究内容先被编译成 Reviewed Canonical Deliverable；随后一次布局 LLM 只读取内容索引，决定 Canonical Content Block 的章节分组和顺序；系统再确定性生成 `ReportDocument v2`，由 Web、Markdown ZIP 和 Zero 分别消费。其他 Deliverable 并不全部走这条 v2/Layout 路径，见第 3.1 节。

当前 Layout LLM：

- 不读取正文；
- 不整理或改写全部分析素材；
- 不选择表格、流程图、结构图或路线图；
- 不输出 HTML；
- 失败时退回“一块一节”的确定性布局。

众筹 Demo 是案例专用的独立静态 HTML。仓库没有生成日志足以证明它由哪种方式制作；但其正文、相对链接和附件说明表明，它使用了 Canonical 之外的 Step 级中间材料，并修正了三处 Evidence 编号。它证明了目标阅读体验，但不能直接复制为生产模板：否则会绕过 Canonical 真相源和 Review 边界。

本方案的决定是：

1. 保留已经完成的 A-core 与 A-model，不回退其无损 Material、引用式 Blueprint、Projector、ReportDocument v3、Package 和四端 Renderer 基础。
2. 当前先做 A-experience，不按原 B→C→D→E 顺序推进。目标是用一个可独立合并的纵切片，把已有工程验收件提升为真正可读的编辑型报告。
3. LLM 读取 Planner-safe Canonical Material，一次调用同时决定章节结构、兼容展示形式，并生成报告标题、执行摘要、章节标题、导语和过渡 fragment。它仍不能输出 HTML/CSS/JavaScript、创建事实或修改任何 Canonical leaf。
4. 每个生成 fragment 必须绑定允许范围内的 `sourceLeafIds`。确定性校验只检查可机械验证的漂移和引用边界；单 fragment 失败只回退该 fragment，不丢弃整批文案，也不重新调用模型。
5. 不引入第二 Reviewer 模型或逐报告人工门禁。事实源/不可变绑定损坏、越权、安全问题和 coverage 缺失仍 fail closed；文案、样式或可选视觉失败均自动降级并继续交付。
6. Renderer 表现层是 A-experience 的第一优先级：必须真正消费 `style`、`density`、`prominence` 与 `graph.variant`，并统一 Web、Standalone HTML、Markdown 和 Zero 的信息层级；不要求像素一致。
7. A-experience 只新增 `card-grid` 和 `stage-flow`。只有源材料具有明确字段或顺序时才使用；纯文本自然降级为正文/列表，不为视觉丰富度推断事实关系。
8. 增加一个最小 `research_plan` Adapter，用同一 Material/Blueprint/Projector/Renderer 流程处理已有受审方案结果。它不读取未审 Step 补写正文，也不要求先完成原 Milestone C 的全部 Canonical 扩展。
9. Standalone HTML 仍是 ReportDocument 的确定性末端 Renderer并封存为 SEALED Artifact；不同出口不得各自发明事实或结构，成功出口继续用 Semantic Manifest 验证内容集合等价。
10. 表格、图、卡片和流程不是固定模板，均由真实 source shape 决定。案例替换后，页面结构与风格可以不同，但来源、状态、优先级和 Evidence 含义不能变化。
11. 同素材验收采用 composition-only：锁定历史 Attempt 的输入 hash，只重新执行报告 Material→LLM→Projector→Renderer，不重跑研究主链。验收关注阅读层级、结构适配、来源覆盖、移动端和打印，不做像素复刻。
12. 已验证图片/Chart 的消费（B）和主动视觉生产（F）延后；它们不是当前新旧报告差距的主因。原 C/D/E 中未被 A-experience 覆盖的高级 Canonical 与其他 Deliverable 迁移仍作为 backlog 保留，按实际需求再立项。

改造规模仍属于**报告栈内的中等改造**，但当前工作面被收敛为一个纵切片：Renderer、单次 Editorial Planner 输出合同、两个通用 Block、`research_plan` Adapter 与 composition-only 验收。它只加工已经生成并审校的素材，不改变搜索、研究、Synthesis、Evidence 或 Canonical 生成；关闭开关即可回到既有 v3 报告。当前众筹或其他 Demo 中未进入受审素材的 Persona、Journey、双链路和完整指标框架，仍不能由报告末端补写。

## 2. 核实范围与方法

### 2.1 已核实的生产代码

| 层 | 关键文件 | 当前职责 |
|---|---|---|
| Canonical 合同 | `packages/api-contract/research-deliverable.ts` | 定义 Content v2、Direct Answer、Content Block、Evidence 与 Blueprint |
| Layout LLM | `apps/orchestrator-runtime/src/report/report-layout-planner.ts` | 生成 `report-layout-blueprint-v1` |
| 报告投影 | `apps/orchestrator-runtime/src/report/research-strategy-report-projector.ts` | Canonical → `ReportDocument v2` |
| 报告编排 | `apps/orchestrator-runtime/src/report/report-composition-service.ts` | 读取已验证材料、调用 Layout、封存报告 Artifact |
| 报告合同与校验 | `apps/orchestrator-runtime/src/report/report-document-composer.ts` | 定义并校验 ReportDocument 与已有 Block |
| Web 报告 | `apps/web/src/reporting/ReportDocumentView.tsx` | React 渲染、折叠交互与打印处理 |
| 报告页面 | `apps/web/src/components/stages/CurrentStage4Report.tsx` | 五类内容视图、ZIP 和 Zero 操作 |
| Markdown ZIP | `apps/web/src/reporting/report-bundle.ts` | 生成 Markdown、JSON 与媒体资源 ZIP |
| Zero HTML | `apps/agent-api/src/integrations/zero/zero-report-renderer.ts` | 用户确认发布后生成 Zero 导入 HTML |
| Zero 发布 | `apps/agent-api/src/integrations/zero/zero-publication-service.ts` | 创建、填充、验证并封存 Zero 发布 |
| Report Package | `apps/orchestrator-runtime/src/report/report-package-artifact.ts` | 封存报告组成部分及其绑定 |

### 2.2 已核实的设计约束

- ADR-0005：内容只生成一次；布局模型只引用 Canonical；布局失败降级；各出口共享 ReportDocument。
- ADR-0006：Canonical 是无损编译和真实性门禁；中间产物不得直接进入正式报告；Canonical 到 ReportDocument 必须校验语义单元覆盖。
- ADR-0007：Reviewed Canonical Deliverable 是唯一正式报告真相源；Contributor Artifact 和未 Review 内容不得直接发布。

### 2.3 已运行的定向回归

```bash
pnpm exec tsx --test \
  tests/report-layout-planner.test.ts \
  tests/research-strategy-report-projector.test.ts \
  tests/report-document.test.ts \
  tests/report-bundle.test.ts \
  tests/zero-report-renderer.test.ts
```

结果：68/68 通过。该结果只代表 2026-08-26 实施前基线的报告相关定向测试，不代表当时新方案已经实现。

## 3. 当前真实流程

### 3.1 端到端调用链

```text
Requirement / Confirmed Plan
        ↓
Tool、Knowledge、Contributor Skill 执行
        ↓
research-strategy-synthesis
        ↓
Reviewed Semantic Content Draft
        ↓
Evidence Manifest + Visual Asset / Chart 发现与验证
        ↓
Step 10：无损 Canonical 编译 + typed patch + 内容保真校验
        ↓
Canonical Deliverable（唯一正式事实源）
        ↓
Final Report Review
        ↓
ReportCompositionService
        ├─ 复用先前已验证的 Visual Asset / Chart
        └─ ReportLayoutPlanner（仅 strategy v2；一次 LLM，可失败降级）
               ↓
        Report Layout Blueprint v1
               ↓
ResearchStrategyReportProjector（确定性）
        ↓
ReportDocument v2
        ├─ Web React 视图
        ├─ Markdown ZIP
        └─ 用户确认“发送到 Zero”后：Zero HTML → Zero 页面
```

严格调用顺序上，`discoverAttemptMaterials()` 发生在 Canonical Deliverable 生成和 Final Review 之前；Composition 复用这批已验证材料，不在 Review 之后重新发现。

这里有六个容易混淆的事实：

1. `ReportLayoutPlanner` 发生在 Canonical 和最终 Review 之后，不是研究内容生成步骤。
2. Zero Renderer 确实会生成 HTML，但只用于用户确认后的 Zero 发布，不会生成 Demo 那种 standalone 报告，也不是 Web 当前报告的输入。
3. 浏览器里的报告直接渲染 `ReportDocument`，不是加载某个已生成的 HTML 文件。
4. Layout LLM 和动态 `ReportDocument v2` projector 只适用于 `research_strategy_report` Content v2；普通报告主要生成 v1，`research_plan` 在没有 Visual/Chart 时使用 `current_text`，不生成 ReportDocument。
5. Layout 失败会安全降级，但 ReportDocument composition 自身失败不会降级成 `current_text`；它会进入统一失败处理并暂停任务。`current_text` 是预先选择的报告模式，不是 composition 的错误兜底。
6. Zero 只接受 `multimodal` Report Package，且发布还要求本机集成已启用、Zero 已认证并存在当前设计页面；它不是每份报告都会自动执行的出口。

### 3.2 当前 Layout LLM 的真实输入与输出

当前输入只有：

```ts
{
  title,
  requestedArtifacts: [{ artifactType, blockIds }],
  contentIndex: [{ id, kind, title, questionIds }],
}
```

当前输出只有：

```ts
interface ReportLayoutBlueprintV1 {
  version: 'report-layout-blueprint-v1';
  sections: Array<{
    title: string;
    purpose: string;
    prominence: 'primary' | 'supporting' | 'appendix';
    blockRefs: string[];
  }>;
}
```

因此模型可以决定“哪些 Canonical Block 放在同一章节、章节叫什么、顺序是什么”，但看不到正文，无法根据实际内容决定“这组数据应该是表格还是流程图”。所谓“模型编排”目前只是目录编排，不是编辑型报告生成。

### 3.3 当前确定性投影造成的结构损失

`ResearchStrategyReportProjector` 会保住语义单元身份，但会把结构压平成 Answer Card：

| Canonical 内容 | 当前 `ReportDocument v2` 投影 |
|---|---|
| `comparison_matrix` / `strategy_map` | `row × column：statement` 字符串列表 |
| `mind_model.nodes` | 用分号拼成一段文字 |
| `mind_model.edges` | `from → to：relationship` 字符串列表 |
| `opportunity_backlog` | 每项一个 Answer Card |
| `prioritized_actions` / `action_plan` | 每项一个 Answer Card |
| `channel_strategies` | 每个渠道一个 Answer Card |
| limitations / open questions / risk disclosures | 聚合为一个 Answer Card 的长 `items` 列表 |

这解释了为什么当前最终页面像“卡片化的分析结果浏览器”，而不像经过编辑整理的正式报告：系统保住了内容覆盖，却没有保住适合阅读的关系结构。

### 3.4 当前最多五个策略报告 Web 视图是什么

`CurrentStage4Report.tsx` 按 Section ID 和 Answer Kind 推断五个页签：

| 视图 | 实际含义 | 当前底层来源 |
|---|---|---|
| 答案概览 | Required Questions 的直接回答 | `directAnswers` |
| 策略框架 | 策略地图、心智模型、对比、设计原则 | Content Block 的 kind 或 `model-section-*` |
| 机会与行动 | 机会、优先级和行动计划 | opportunity / priority / action kind |
| 证据与局限 | Evidence、风险、局限和附录 | 固定 Section ID 或 risk kind |
| 分析底稿 | Evidence Finding 等分析性内容 | evidence_finding kind |

这些不是五份报告，而是同一 `ReportDocument` 的最多五个过滤视图；空分类会被隐藏。分类目前依赖 ID/Kind 猜测，新增结构类型后容易误分；目标合同应在 Section 上直接保存 `view`，让所有 Renderer 使用同一语义分类。`research_plan` 不使用这五个策略页签，它走正文路径，并在有 ReportDocument 时提供“完整方案 / 管理摘要”双视图。

### 3.5 “展开详细要点”的真实行为

当前 Web 对每个 Answer Block 的所有 `items` 一律放入 `<details>`，显示为“展开详细要点”。这不是模型决定，也不是对“引导思考”和“真实结果”的区分。

`items` 中混有：

- 业务含义；
- 建议行动；
- 仍需验证；
- 影响；
- Owner；
- 验证方式；
- 矩阵单元；
- 心智模型边；
- 风险和证据索引。

所以这些内容大多是正式分析结果，不只是给用户的思考提示。统一折叠是一个展示层捷径，会把应当首屏可见的行动和风险也隐藏起来。打印前当前代码会自动展开全部 `<details>`，打印后恢复。

### 3.6 当前图片与图表能力

项目底层已经支持：

- `image`；
- `image-comparison`；
- `chart`；
- Visual Asset Manifest、来源绑定、导出策略和完整性验证；
- Web、ZIP、Zero 对已验证媒体的读取和展示。

但当前 `research_strategy_report` 的 v2 projector 没有把已发现的 `visualAssets` 和 `charts` 参数投影进报告；众筹 Attempt 本身也没有任何 Visual Asset 或 Chart Artifact。因此该案例没有图片，不是浏览器底层完全没有能力，而是两个条件同时存在：

1. 上游任务没有产生图片/截图/Chart Artifact；
2. 当前策略报告 projector 没有消费这类已验证材料。

本方案只解决第二点和“已有结构如何可视化”。若希望系统主动搜索、截取或生成图片，仍需在研究计划和 Skill/Tool 阶段显式启用相应能力；报告 Renderer 不应自行联网取图或生成未经审校的视觉证据。

## 4. 众筹 Demo 审计

### 4.1 文件性质

Demo 文件头明确写明：

```text
Independent HTML demo. No production code is imported or modified.
```

代码库中没有任何生产模块引用它。它是一次案例专用的静态验证稿，不是可复用流水线的输出；仅凭仓库内容不能断言它是人工手写还是借助模型生成。

### 4.2 结构清点

该文件约 67 KB，包含：

- 11 个 `<section>`；
- 4 个 `<table>`；
- 6 个 `<details>`；
- Persona/分群卡、定位图、心智路径、Journey、策略泳道、Roadmap、验证矩阵；
- 0 个 `<img>`、0 个 `<svg>`、0 个 `<canvas>`。

其中所谓“图”全部是 HTML DOM/CSS 结构，不是图片素材，也没有使用现有通用图表 Artifact。

### 4.3 Demo 做了超出安全末端排版的工作

Demo 中的正文、附件链接与引用说明表明，制作时至少参考了：

- `deliverables/final-r0.json`；
- `reports/report-document.json`；
- `steps/3-llm_output.json`、`steps/5-review_output.json`、`steps/6-llm_output.json`、`steps/7-llm_output.json` 等中间材料；
- Evidence Manifest 和布局诊断。

它还标出了三处 Canonical Evidence 错位，并在可见正文中改用了原始检索结果对应的编号：

| 原绑定 | Demo 使用 | 含义 |
|---|---|---|
| E1-6 | RAW E1-7 | 众筹档位、达成回报和未达成退款 |
| E1-8 | RAW E1-10 | 盲筹、平台/团队信任与理念支持 |
| E1-11 | RAW E1-12 | 标签、频控、投放、效果分析与 A/B 能力 |

这已经是“证据审计 + 内容修订”，不是单纯格式转换。正式系统不能在 Renderer 中做同样的静默修正。正确行为是输出诊断，让 Canonical Patch/Review 修复后再生成报告。上述结论来自文件内容与引用关系，不代表仓库保存了 Demo 的完整生成日志。

### 4.4 当前案例的 Layout fallback 缺陷

该 Attempt 的诊断为：

```text
layout blueprint references unknown Block answer-q1
```

原因是 Planner context 的 `requestedArtifacts` 暴露了 `executive_answers` 对应的 `answer-q*`，但 Blueprint validator 只允许 `content-block-*`。模型使用了输入中看似合法、实际不可选的 ID，随后整份 Blueprint 回退。

这不是模型随机失败，而是输入合同自相矛盾。该缺陷在启用 A-model 前修复：把固定 Direct Answer 与可编排 Content Block 分开声明，并增加真实组合回归测试；它不阻塞完全不调用 Planner 的 A-core。

### 4.5 Demo 中可以复用与不可复用的部分

可以产品化：

- 答案先行的叙事顺序；
- 根据受审结构选择表格、流程和优先级看板；泳道与 Roadmap 作为后续类型扩展；
- 正文与审计附件分层；
- 屏幕折叠、打印全部展开；
- 响应式版式、目录、状态和证据标识；
- 无外部依赖的 standalone HTML。

不能直接产品化：

- 众筹专用章节、措辞和 CSS class；
- 从未 Review Step 中挑内容写入正文；
- 在末端静默修正 Canonical Evidence；
- 从长文本猜测节点、连线、数字或优先级；
- 让 LLM 输出任意 HTML/CSS/JavaScript。

## 5. 需求解释

本次需求不是“以后所有报告都长得与 Demo 一模一样”，而是把 Demo 背后的编辑原则做成通用机制：

```text
相同的事实约束
    +
相同的类型化报告合同
    +
根据素材结构选择不同表达
    +
统一的安全 Renderer
```

因此：

- 替换案例后，不保证仍有四张表；有矩阵、记录集或对比维度才生成表格。
- 有明确 nodes/edges 才生成结构图或流程图。
- 只有明确 priority 时生成 Priority Board；phase/time 在首期作为 Table/List 字段保留，不生成 Roadmap。
- 有可验证数值、维度和单位时复用现有 Chart/metric；首期不新增 Metric Group。
- 只有文本时使用正文、列表和卡片；不得为了“看起来丰富”编造结构。
- 视觉主题可以在受控 preset 中变化，但信息架构和真实性规则不变。

原始预期与交付阶段的关系如下。后移不等于取消，未到对应阶段时系统必须诚实降级：

| 原始预期 | 交付阶段 | 未交付前的行为 |
|---|---|---|
| Table、Graph、Priority Board | A-core（已实现） | 使用 Answer/List 无损降级 |
| 可下载的编辑型 HTML | A-core（已实现） | Web/Markdown 继续可用 |
| LLM 根据素材选择结构、标题和编辑文案 | A-experience | 使用确定性 typed fallback 和系统标题 |
| Card Grid、Journey/Timeline/Logic/Stage Flow | A-experience | 使用 Table/List/Graph，不猜测关系 |
| `research_plan` 复用同一流程 | A-experience | 继续使用当前报告路径 |
| 当前 Attempt 已有图片、标注图和 Chart 进入报告 | B（延后） | 无素材时正常生成无图片区报告 |
| Roadmap、Swimlane、Persona、Metric Group 等更强类型 | 后续按真实需求立项 | 先以当前合同能承载的结构呈现，不恢复未入 Canonical 的内容 |
| 其他 Deliverable 全量迁移 | 后续按类型立项 | 继续使用其当前报告路径 |
| 自动从网页取得可审计图片或主动生产通用 Chart | F（延后） | 只消费当前已存在并通过验证的素材 |

## 6. 目标与非目标

### 6.1 Primary Setpoint

在不改变已审校事实、Evidence 绑定、状态和置信度的前提下，系统根据报告目标和素材结构生成可读性高、结构明确、可追溯的正式报告；同一 `ReportDocument` 能稳定输出 Web、Standalone HTML、Markdown ZIP 和 Zero，并在内容适合时使用表格、结构图、优先级看板、卡片组和阶段流。A-experience 允许模型生成受控标题、摘要、导语和过渡文案，但每个 fragment 必须绑定 source leaf 并可独立回退。

### 6.2 成功标准

- 报告栈改造本身不改变搜索、取证和 Contributor 执行；任何 Canonical 内容扩展必须作为显式上游变更单独评审和测试。
- 每个 Planner presentation unit 在最终 ReportDocument 中有且只有一个主归属；每个 Canonical leaf unit 只能归属于一个主 Block，必须被至少一个真实展示字段引用，并可反查原 Artifact/Pointer/Node。
- 每个进入 Planner Material 的可导出 Asset/Chart 有且只有一个主归属；允许在目录或附件中出现非内容型引用，但不得重复拥有语义内容。
- Editorial Planner 不能新增事实、Evidence、数字、关系、行动或结论，也不能修改任何 presentation/leaf unit；它可以在系统预先授权的 Copy Slot 生成标题、摘要、导语和过渡 fragment，且每个 fragment 必须绑定允许范围内的 source leaf。
- 表格、Graph 和 Priority Board 的每个最小展示项都通过 leaf ID 解析到直接、继承或缺失的明确 Trace 状态；父级 Trace 不重复持久化。
- Planner 失败时仍能生成完整、类型化的确定性报告。
- Planner 默认关闭；A-experience 完成同素材 composition-only 验收且数据策略、context 预算和稳定 fallback 可用后，才按 Deliverable 小范围开启。首个纵切片不要求先完成 50-task canary 或逐份人工审批。
- 离线 HTML Bundle 解压后不依赖服务端运行即可打开；无 Asset 报告的单个 `report.html` 可独立打开；所有文本被安全转义。
- 对实际执行成功的 Web、HTML、Markdown 和 Zero Renderer，其 Render Manifest 在 presentation unit、leaf、Asset、Audit record 和报告 Notice 五个集合上完全一致，允许表现形式不同。HTML 状态写入 Package，Zero 状态写入 Publication Artifact；同步 Web/Markdown 失败由其 API/UI 返回稳定错误。任何出口都不能用空 Manifest 冒充成功。
- HTML 组件失败时 Web/Markdown 仍可交付；Package 必须显式记录 HTML `ready | unavailable`，不得用缺失字段冒充成功。
- 非核心增强失败必须优先降级而不是暂停整项任务。用户可见说明只使用系统维护的枚举文案，说明“哪项增强未使用、采用了什么替代形式、正文是否完整”；不得暴露内部异常、供应商或安全策略细节。
- 核心结论、行动和风险默认可见；只有来源、审计和扩展解释默认折叠。
- 打印/PDF 和导出版本不丢失折叠内容。
- 无图片素材的任务仍能生成完整报告；有已验证图片/Chart 时能正确进入报告。
- 众筹案例在未补齐 Canonical 前，不得把 Persona、双链路、Journey 或完整指标框架标为已交付；补齐后必须重新经过 Step 10 与 Final Report Review。

### 6.3 全期非目标与首期边界

全期均不做：

- 把所有 Step 的原始 Token、模型推理过程或重复草稿塞进正文；
- 允许末端 LLM 修复 Canonical 内容或 Evidence；
- 让 LLM 输出任意 HTML、CSS、JavaScript 或 URL；
- 从文本猜测虚构的数值图表；
- 为众筹案例建立专用 Renderer 或专用 Schema；
- 修改历史 SEALED Artifact；
- 将图片搜索/截图/生成偷偷放进报告渲染阶段；
- 一次性强制迁移所有 Deliverable 类型。

当前 A-experience 的明确边界：

- 不修改搜索、联网采集、Evidence 生成或研究分析算法；
- 只生成已授权的标题、摘要、导语和过渡 fragment，不改写 Canonical 正文；
- 只新增 `card-grid` 与 `stage-flow`，不同时引入 Roadmap、Swimlane、Metric Group、Persona 等完整专用合同；
- 不把“报告支持图片”描述成“所有任务都会主动取得图片”。

B、F 继续延后；需要扩展 Canonical、Tool/Skill 或 Evidence 主链的能力必须另立开发项，不能作为 A-experience 的顺手改动。原 C/D/E 的完整高级合同仍是历史设计资料，不是当前纵切片的前置条件。

## 7. 架构约束与新增决策

### 7.1 保持 Canonical 单一真相源

正文和内容型附件可引用的所有分析内容，都必须来自通过 Final Report Review 的 Canonical Deliverable。不能用“放到附件”绕过 Review。材料分为三个互不混用的通道：

| 通道 | 进入 Planner | 进入正文/内容附件 | 进入审计附件 |
|---|---:|---:|---:|
| `canonical_content` | 是 | 是 | 可引用 |
| `editorial_copy_fragment` | Planner 输出 | 是，仅通过确定性 fragment 检查后 | 记录 source leaf、校验结果与 fallback reason |
| `audit_metadata` | 否 | 否 | 是 |
| `diagnostic_reference` | 否 | 否 | 否，仅内部诊断 |

`editorial_copy_fragment` 不是新的事实源：它只能整理授权 leaf 的表达，不能拥有或改变 Canonical leaf、Evidence、状态、置信度和优先级。`audit_metadata` 只允许包含 Artifact ID/hash、Contribution disposition、Canonical node 映射、reason code 和 Review issue ID，不允许携带未进入 Canonical 的 Contribution 标题、statement 或分析正文。失败布局输出、证据冲突和未审校 Step 只保留为 `diagnostic_reference`，既不发送给 Planner，也不进入任何用户可见 Section。

### 7.2 “保留全部分析结果”的可执行定义

必须保留：

- Canonical 中全部 Direct Answer；
- 全部 Evidence Finding；
- 全部 Content Block 及每个 cell/node/edge/item；
- 全部 limitation、open question 和 risk disclosure；
- requested artifact bindings；
- Contribution 的 disposition、来源映射和未纳入理由等审计元数据；
- 已验证 Visual Asset/Chart 的引用与导出策略。

不要求放进正文、但要可追溯：

- 重复分析；
- 被 Reviewer 否决或标记 conflicted/omitted 的内容；
- 纯过程日志；
- 未审校草稿；
- 模型内部推理。

“全部保留”是完整保留可审计语义单元及其 disposition，不是把所有中间 JSON 原文拼成一篇报告。

### 7.3 结构编排与可见文案由一次受控调用完成

A-experience 只有一次 `ReportEditorialPlanner` 调用。旧 `ReportLayoutPlanner` 停止用于新写入；不再串联第二个 Copy Writer 或 Reviewer 模型，避免额外时延、合同漂移和复杂失败状态。

同一结构化输出同时包含：

- Section 顺序、分组、`prominence`、受控 `style/density` 和兼容 presentation；
- 报告标题、执行摘要、章节标题、章节导语和相邻章节过渡 fragment；
- 每个 fragment 的 `sourceLeafIds`。

结构部分仍执行 exactly-once presentation/leaf coverage；失败时整份结构回到 deterministic Blueprint。Copy 部分按 fragment 独立校验；某个 fragment 失败时使用系统标题、Canonical 摘要或直接省略该导语/过渡，其余已通过 fragment 和结构仍可使用。模型只调用一次且不做自动修订循环。

### 7.4 ReportDocument v3 需要新的 ADR

ADR-0005 曾基于“Answer Block 足够表达动态报告”的前提决定保留 v2。当前 v2 没有删除 Canonical 单元：矩阵和图关系仍被字符串化保存，`sourceNodeIds` 也保留了投影覆盖身份；真正丢失的是机器可读的表格/拓扑/行动字段语义，以及每个 leaf 的局部 Trace。新需求需要跨 Renderer 复用这些结构，因此该前提已经不再成立。

实施前必须新增 ADR，明确以 `ReportDocument v3` 补充类型化结构，并保留 v1/v2 reader。不要在仍标记为 v2 的对象里偷偷加入旧消费者无法识别的新 Block。

### 7.5 当前众筹案例存在明确的 Canonical 前置缺口

这不是风险猜测，而是当前 Artifact 已证实的事实：`steps/10-review_output.json` 的 c3/c4 指出 Persona/人群画像不足，c6/c7/c9 指出动机、决策链路和人群到策略映射未闭合，c11/c12 指出完整指标框架缺失。当前 Canonical 只有 5 个 Direct Answer、6 个 Evidence Finding，以及 narrative、mind_model、opportunity、prioritized_actions、action_plan 六类 Content Block；没有 Persona、Journey、UV/转化 lanes 或 measurement framework 的独立类型化对象。

因此要区分两个验收目标：

1. **通用报告栈验收**：只对现有 Canonical 做无损类型化呈现，不触碰上游内容生成。
2. **众筹 Demo 内容等价验收**：按 Milestone C 新增 `research-strategy-content-draft-v3`、Canonical v3、typed Contribution Adapter、Assembler/Step 10 和 Review，使 Persona、Journey/lanes 与指标框架成为受审 Canonical 内容；之后由 `ReportDocument v4` 承载对应展示类型。Renderer 不得从 Steps 3–9 补回这些内容，也不得把这些类型塞入首期 v3。

### 7.6 高级结构必须先进入 Canonical

Roadmap、Swimlane、Metric Group、Persona 和 Journey 都表达新的事实关系，不是 CSS 形态。Milestone C 使用 versioned typed Contribution、Canonical v3 和 ReportDocument v4；不修改已封存版本，不从 Markdown、HTML、`statement`、`ownerType` 或自然语言时间词恢复结构。每个 nested item 都必须有独立 source pointer、support 和 leaf Trace。

### 7.7 多 Deliverable 使用显式 Adapter，不使用通用映射 DSL

不同 Deliverable 的字段、枚举和审计粒度并不相同。Milestone D 以小型 `DeliverableEditorialAdapter` 将一种已验证 Payload 转为共享 Material，再由通用 Projector/Renderer 处理。Registry 只声明版本、Adapter ID、视图和 feature flag；不能执行任意 JSONPath，也不能用配置猜语义。

### 7.8 Editorial Copy 是带来源的派生表达

章节导语、过渡段和综合摘要不是 Canonical 事实，也不能回写 Canonical。A-experience 将它们放进一次 Planner 的受控 Copy Slot；每个 fragment 绑定允许范围内的 Canonical leaf，并经过确定性检查。失败粒度是单 fragment，不是整批报告。为保存新 Copy 字段及其来源必须使用下一未发布的严格合同版本，不能静默修改已产生 Artifact 的 v3/Package v2。

### 7.9 主动视觉生产不属于 Renderer

Milestone B 只消费已验证 Asset/Chart。主动网页截图和通用 Chart 生产属于 Milestone F，必须经过计划、Tool/Skill、Evidence、Manifest 和安全门禁。Renderer 永不自行联网、调用图片模型、抓页面或把自然语言转换成数值序列。

## 8. 分版本目标流程

A-experience 的目标流程如下：

```text
研究执行与内容生成
        ↓
Reviewed Canonical Deliverable
        ↓
ReportEditorialMaterialBuilder（确定性）
        ├─ Canonical leaf + Verified Visual/Chart → Planner-safe Material v1
        ├─ Contribution disposition / mapping → system-owned Audit Appendix
        └─ Step / conflict / failure → internal Diagnostic only
                                      ↓
                        ReportEditorialPlanner（一次结构化 LLM）
                        ├─ 引用式结构
                        └─ 带 sourceLeafIds 的受控 Copy fragments
        ↓
ReportEditorialBlueprint v2
        │  结构无效、超时、超长或不可解析
        └──────────────────────────→ deterministic typed Blueprint
        │  单 Copy fragment 校验失败
        └──────────────────────────→ 仅该 fragment 使用系统文案/省略
        │  用户取消 / lease lost
        └──────────────────────────→ 中止，不写新 Artifact
        ↓
ReportEditorialProjector（确定性、覆盖校验）
        ↓
ReportDocument 下一严格版本（唯一展示真相源）
        ├─ React Renderer
        ├─ HTML Bundle Renderer → ready: sealed report.html + Asset snapshot
        │                         unavailable: reason code，核心报告保持可用
        ├─ Markdown Renderer → Markdown ZIP
        └─ Zero Adapter → Zero publication
```

重要边界：LLM 的工作结束于包含结构与 Copy fragment 的 Blueprint，其后全部为确定性代码；Audit Appendix 由系统追加，不受 Planner 决定。没有第二个 Reviewer 模型、没有逐报告人工审批、没有自动改写重试。若 Demo 的某项内容未进入受审材料，该内容不属于 A-experience 验收范围，报告末端不得从历史 Step 补回。

后续阶段不是在 Renderer 内“顺手补内容”，而是从各自合法来源进入同一 Material Builder。下图保留为长期方向，不是 A-experience 的当前开发顺序：

```text
Milestone C：Typed Contribution v2 → Content Draft / Canonical v3 → Final Review ─┐
Milestone F1：Search → Browser Capture → Evidence / Visual Asset Manifest ────────┤
Milestone F2：Typed Numeric Series → Canonical + Evidence → Chart Data/Spec/SVG ─┤
                                                                                ↓
                                           ReportEditorialMaterialBuilder
                                                                                ↓
                                     Blueprint → Projector → 四端 Renderer

A-experience：Reviewed Canonical → 一次 Planner（结构 + Copy）→ fragment checks ─┘
              （单 fragment 失败局部回退，Canonical 与结构型报告保持可交付）
```

版本组合必须成套发布，不能任意混搭：

| Milestone | Canonical / Deliverable | Material | Blueprint | ReportDocument | Report Package |
|---|---|---|---|---|---|
| A–B | strategy content v2 | editorial material v1 | editorial blueprint v1 | v3 | v2 |
| A-experience | strategy content v2 或 `research_plan` 已审 Payload | editorial material v1 + Adapter 输出 | editorial blueprint v2（结构 + Copy） | 下一严格版本 | Package 下一严格版本 |
| 后续高级 Canonical | versioned typed payload | 对应新 Material | 对应新 Blueprint | 独立升版 | Reader 白名单扩展 |
| 后续 Deliverable | Adapter 声明的受审 Payload | Profile 指定版本 | Profile 指定版本 | Profile 指定版本 | 对应严格版本 |
| F | 新 Evidence/Asset 或 numeric Canonical | 由 B/C 合法纳入 | 不新增版本 | 不单独升版 | 不单独升版 |

## 9. `ReportEditorialMaterial v1` 内部合同

该合同是 Projector 使用的完整、已验证引用视图，不是新的事实源，也不等于所有已保存的运行 Artifact。Material Builder 同时确定性生成 `ReportEditorialPlannerInputV1`：保留 Canonical 正文与结构，但把 Asset 缩减为来源摘要，把 Chart 缩减为标题、类型、点数、Evidence/Canonical 绑定和允许展示类型；二进制、SVG 正文、内部存储路径、完整 Manifest 与 table alternative 不进入 LLM。Projector 始终使用完整 `ReportEditorialMaterialV1`，不得从 Planner 摘要恢复对象。

```ts
interface ReportEditorialMaterialV1 {
  version: 'report-editorial-material-v1';
  binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    deliverableArtifactId: string;
    deliverableContentSha256: string;
    reportReviewArtifactId: string;
  };
  document: {
    title: string;
    decisionContext?: string;
    executiveAnswer?: string;
    deliverableType: string;
    requestedArtifactTypes: string[];
  };
  presentationUnits: ReportEditorialPresentationUnitV1[];
  leafTraceIndex: Record<string, EditorialLeafTrace>;
  constraints: {
    requiredQuestionIds: string[];
    requiredPresentationUnitIds: string[];
    requiredLeafUnitIds: string[];
    allowedViews: ReportViewIdV1[];
    projectionProfilesByUnitId: Record<string, ReportPresentationV1[]>;
  };
}

interface EditorialPresentationUnitBase {
  id: string;                         // Planner 的稳定主归属单位
  semanticKind: ReportEditorialSemanticKindV1;
  title?: string;
  leafIds: string[];                  // 本 unit 拥有的全部最小语义单元
}

interface EditorialLeafTrace {
  supportMode: 'direct' | 'inherited' | 'none' | 'system_derived';
  origins: Array<{
    artifactId: string;
    contentSha256: string;
    schemaVersion: string;
    jsonPointer: string;
    sourceNodeIds: string[];
    reviewState: 'passed' | 'passed_with_conditions';
  }>;
  support: {
    questionIds: string[];
    evidenceIds: string[];
    findingIds: string[];
    summaryIds: string[];
    status?: 'supported' | 'provisional' | 'unanswered';
    confidence?: number;
  };
}

type ReportEditorialSemanticKindV1 =
  | 'direct_answer'
  | 'narrative'
  | 'comparison_matrix'
  | 'strategy_map'
  | 'mind_model'
  | 'design_principle'
  | 'opportunity'
  | 'prioritized_action'
  | 'action_plan'
  | 'channel_strategy'
  | 'evidence_finding'
  | 'limitation'
  | 'open_question'
  | 'risk'
  | 'requested_artifact_binding'
  | 'visual_asset'
  | 'visual_comparison'
  | 'verified_chart';

type EditorialScalar = string | number | boolean | null;

interface EditorialAssetReference {
  assetId: string;
  manifestArtifactId: string;
  contentSha256: string;
  manifestHash: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  exportPolicy: 'allow' | 'mask';
}

type EditorialAssetSourceSummary =
  | { kind: 'browser_capture'; pageTitle: string; domain: string; capturedAt: string }
  | { kind: 'user_upload'; fileName: string; role: string }
  | { kind: 'tool_artifact' | 'derived'; role: string };

type ReportEditorialPresentationUnitV1 =
  | (EditorialPresentationUnitBase & {
      shape: 'text';
      leafId: string;
      text: string;
    })
  | (EditorialPresentationUnitBase & {
      shape: 'record';
      leafId: string;
      fields: Array<{ key: string; label: string; value: EditorialScalar }>;
    })
  | (EditorialPresentationUnitBase & {
      shape: 'matrix';
      rows: string[];
      columns: string[];
      cells: Array<{
        leafId: string;
        row: string;
        column: string;
        value: EditorialScalar;
      }>;
    })
  | (EditorialPresentationUnitBase & {
      shape: 'graph';
      nodes: Array<{
        id: string;
        leafId: string;
        label: string;
        description: string;
      }>;
      edges: Array<{
        id: string;
        leafId: string;
        from: string;
        to: string;
        label: string;
      }>;
    })
  | (EditorialPresentationUnitBase & {
      shape: 'actions';
      actions: Array<{
        leafId: string;
        priority?: 'P0' | 'P1' | 'P2';
        action: string;
        owner?: string;
        rationale?: string;
        validationMethod?: string;
      }>;
    })
  | (EditorialPresentationUnitBase & {
      shape: 'asset';
      leafId: string;
      assetRef: EditorialAssetReference;
      sourceSummary: EditorialAssetSourceSummary;
      canonicalBindingIds: string[];
    })
  | (EditorialPresentationUnitBase & {
      shape: 'asset_pair';
      original: {
        leafId: string;
        assetRef: EditorialAssetReference;
        sourceSummary: EditorialAssetSourceSummary;
      };
      annotation: {
        leafId: string;
        assetRef: EditorialAssetReference;
        overlayArtifactId: string;
      };
      findingIds: string[];
      canonicalBindingIds: string[];
    })
  | (EditorialPresentationUnitBase & {
      shape: 'chart';
      leafId: string;
      chartRef: {
        chartId: string;
        chartSpecArtifactId: string;
        chartSpecArtifactContentSha256: string;
        assetId: string;
        manifestArtifactId: string;
      };
      specHash: string;
      spec: ChartSpec;
      table: ReportChartTableAlternativeV3;
      dataArtifactRef?: {
        artifactId: string;
        contentSha256: string;
        schemaVersion: string;
      };
      evidenceIds: string[];
      canonicalBindingIds: string[];
    });

interface ReportAuditAppendixMaterialV1 {
  version: 'report-audit-appendix-material-v1';
  binding: ReportEditorialMaterialV1['binding'];
  records: Array<{
    id: string;
    contributionArtifactId: string;
    sourceUnitKey: string;
    sourceSemanticHash: string;
    disposition: 'included' | 'merged' | 'conflicted' | 'omitted';
    canonicalNodeIds: string[];
    reasonCode?: string;
    reviewIssueIds: string[];
  }>;
}
```

构建规则：

1. 只读取同一 Task/Plan/Attempt 且通过 hash、state、schema 和 Task/Plan/Attempt binding 校验的 SEALED Artifact；owner 授权属于 API 读取边界，不伪装成 Artifact 字段。
2. Presentation unit 是 Planner 可以分组和排序的主归属单位；cell、node、edge、action、text、record row 与 Asset/Chart 分别成为 leaf unit。两者不得共用同一套“unit ID”含义。
3. 每个 unit 的 `leafIds` 必须与其 shape 内 `leafId` 字段的稳定去重集合完全相等；`leafTraceIndex` 的 key 又必须与全部 `presentationUnits[].leafIds` 的稳定去重并集完全相等。不允许 orphan leaf、重复 leaf owner 或父级 Trace 代替 leaf Trace。每个 leaf（包括 `system_derived`）至少有一个完整 source origin，多来源按 Artifact ID/hash/pointer 稳定排序去重；系统派生值的计算规则由受版本控制的 Builder 决定，不能用空来源掩盖普通内容。
4. 每个 `presentationUnit` 必须被 Blueprint 的一个主 Block 恰好引用一次；Projector 必须让该 unit 的全部 leaf 只归属于这个 Block，并被至少一个实际展示字段引用。同一 Block 内多个字段可以复用一个 leaf 的 Trace；目录、交叉索引可以重复引用 ID，但不拥有或复制正文。
5. Planner 只接收由完整 Material 确定性裁剪出的 `ReportEditorialPlannerInputV1`；`ReportAuditAppendixMaterialV1` 由系统确定性渲染。Diagnostic reference 只进入内部诊断 Artifact，任何情况下都不得进入 `ReportDocument`、Render Manifest 或导出包。
6. Contribution 审计记录不得复制 Contributor 原始单元的标题或正文，避免未进入 Canonical 的分析通过附件发布。
7. 可展示的 Visual Asset/Chart 与 Canonical 内容使用同一套 presentation ownership 规则；完整 Material 保存已验证的 Artifact/hash/Manifest、ChartSpec、完整 table alternative、Evidence 和 Canonical binding，Planner 只看到安全摘要。二进制从不进入 LLM context。
8. 当前 `mask` 只表示 Manifest 已允许导出该受控字节，不授权 Renderer 动态涂抹或改写图片。若产品要求生成物理脱敏图，必须由上游生成新的 Derived Asset 并重新封存；Renderer 不承担脱敏。普通 `asset/asset_pair` 只接受 PNG/JPEG/WebP；SVG 仅允许来自受信 `chart_render` 链并通过现有 trusted-SVG 校验。用户上传或网页 SVG 只有在上游已经封存了栅格 Derived Asset 时才能进入报告；本里程碑不新增现场 SVG 净化/转换服务，optional 源无法满足时省略该图并写 `optional_visual_omitted`，不得阻断正文。
9. 不静默截断。Material 的确定性预算校验不通过时直接使用 typed fallback，并写 reason code；报告生成本身不中断。
10. Planner-safe Material 默认只在内存构建，不再复制封存一份完整敏感素材。Blueprint/诊断记录 Material Builder 版本、输入 Artifact ID/hash、presentation/leaf/Asset 数量和预算结果，即可复现输入；审计附件材料可单独封存。
11. 需要分片时只能由 Material Builder 在 Blueprint 前生成多个稳定 chunk presentation unit；每个 chunk ID 含 ordinal，leaf 集互斥且并集等于原 source unit。Projector 不得把一个 unit 拆到多个 Block。无法无损分片的 Graph 整体降级为同一 Block 内的线性列表；若仍超过全局文档上限则 composition fail closed，不截断。

### 9.1 Visual Asset / Chart 的确定性归属

`ReportEditorialMaterialV1` 在 Milestone A 先具备读取能力，但 `report_visual_assets_v1` 默认关闭。开关关闭时，可选媒体继续保留在现有 sidecar/Artifact 中，不进入 Material 的 required presentation/leaf 集；显式 requested media 仍遵守当前 requested-artifact 合同，不能因关闭新投影而伪装完成。Milestone B 开启后，Material Builder 才构造本节的 eligible visual set，以下 exactly-once 规则只约束已选入该集合的资源。

Material Builder 只允许以下优先级的唯一匹配，命中后停止；禁止按标题、文件名或语义相似度猜正文位置：

1. Canonical 中的显式 Asset/Chart binding ID 唯一匹配某个 presentation unit；
2. Annotation 的 Finding ID 集与某个 leaf trace 唯一匹配；
3. Screenshot Evidence ID 与某个 leaf 的 Evidence 集唯一匹配；
4. Chart 的 Evidence ID 集与某个 leaf 唯一匹配；
5. 没有匹配或出现多个候选时，固定进入“媒体附件”，并记录 `unbound | ambiguous_binding`，不阻断无损正文。

原图及其 annotation 必须合并为一个 `asset_pair` presentation unit，拥有两个 Asset leaf；它们不得再分别作为普通图片或附件重复出现。Chart 是一个 unit、普通图片是一个 unit。Milestone B 开启后，eligible set 中所有 `allow/mask` Asset 在最终文档中 exactly once；`block` Asset 在 Material、ReportDocument、Package snapshot 与所有 Renderer Manifest 中均为零。

Caption 与 alt text 由 Projector 确定性生成，不交给 LLM：Browser capture 使用 page title、domain、capturedAt；Upload 使用文件角色和文件名且不得产生研究判断；Comparison 固定为“原图与标注图对比”；Chart 直接使用 `spec.title`。缺失必要来源字段时进入媒体附件并使用中性资源编号，不猜内容。

## 10. `ReportEditorialBlueprint` 受控合同

### 10.1 v1：已实现的结构-only 合同

Blueprint 只描述“如何展示已有 presentation unit”。建议合同：

```ts
type ReportViewIdV1 = 'answers' | 'topics' | 'actions' | 'evidence' | 'analysis';
type ReportPresentationV1 =
  | 'answer'
  | 'paragraph'
  | 'fact'
  | 'list'
  | 'record-table'
  | 'graph'
  | 'priority-board'
  | 'image'
  | 'image-comparison'
  | 'chart';

interface ReportEditorialBlueprintV1 {
  version: 'report-editorial-blueprint-v1';
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  sections: Array<{
    headingMode: 'view_label' | 'first_source_title';
    view: ReportViewIdV1;
    prominence: 'primary' | 'supporting' | 'appendix';
    blocks: Array<{
      presentation: ReportPresentationV1;
      unitRefs: string[];
      visibility: 'always' | 'collapsible';
      variant?: 'linear' | 'hub_spoke' | 'two_sided';
    }>;
  }>;
}
```

可见 Section 标题由 Projector 根据 `headingMode`、受控 view label 和 Canonical source title 生成。`first_source_title` 遇到缺失、空白或重复标题时确定性回退到 `view_label`，同一 view 的后续 Section 追加稳定序号。模型不能提供标题、字段标签或 DOM ID。Audit Appendix 由系统根据 `ReportAuditAppendixMaterialV1` 固定追加，不进入 Blueprint。

明确禁止：

- Blueprint 携带正文、数值、Evidence ID 或任意 HTML；
- 引用不存在或不允许的 presentation unit；
- 引用非 Canonical 或非允许导出的 Asset unit；
- 漏掉、重复拥有或拆散不可拆的 presentation unit；
- 将 requested artifact 放入 appendix；
- 对没有关系数据的文本选择 Graph；
- 对没有已验证 numeric series 与 table alternative 的内容选择 Chart。

Validator 应执行：

1. Schema 校验；
2. Projector 按顺序和 unitRef 确定性生成 Section/Block DOM ID，模型无权提供 ID；
3. unitRef 存在性、Canonical/Asset 身份与 Asset export policy；
4. 所有 `requiredPresentationUnitIds` 主归属 exactly once，包含可导出的 Asset/Chart unit；
5. required question / requested artifact coverage；
6. presentation 与 source shape 兼容性；
7. source kind 到 allowed view 的映射与折叠策略：Direct Answer、行动和风险必须为 `always`；
8. Blueprint 完全不接触 Audit/Diagnostic 材料。
9. Projector 完成后，`requiredLeafUnitIds` 与实际投影 leaf ID 集合完全相等；任何遗漏、重复或未知 leaf 都使 composition fail closed，而不是退回另一份猜测结果。

兼容性不能只看名称：`priority-board` 要求所有 source action 有明确且属于当前合同的 priority；Graph 要求源数据本身存在 nodes/edges；Chart 要求已验证的 numeric series、完整 ChartSpec 和 table alternative；`image-comparison` 必须恰好引用一个已经由 Material Builder 验证 lineage 的 `asset_pair` unit。无法满足时 Blueprint 整体 fallback，不由 Projector 猜字段。

在 v1 中任一校验失败，整份 Blueprint 使用 deterministic typed fallback。这是已经完成的 A-model 历史行为。

### 10.2 v2：A-experience 的一次调用合同

v2 保留 v1 的引用式结构和 exactly-once coverage，同时允许同一次模型调用输出受控 Copy fragment，并新增两个 presentation：

```ts
type ReportPresentationV2 =
  | ReportPresentationV1
  | 'card-grid'
  | 'stage-flow';

interface ReportEditorialCopyFragmentV1 {
  text: string;
  sourceLeafIds: string[];
}

interface ReportEditorialBlueprintV2 {
  version: 'report-editorial-blueprint-v2';
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  reportCopy: {
    title?: ReportEditorialCopyFragmentV1;
    executiveSummary?: ReportEditorialCopyFragmentV1;
  };
  sections: Array<{
    view: ReportViewIdV1;
    prominence: 'primary' | 'supporting' | 'appendix';
    copy: {
      title?: ReportEditorialCopyFragmentV1;
      lead?: ReportEditorialCopyFragmentV1;
      transitionToNext?: ReportEditorialCopyFragmentV1;
    };
    blocks: Array<{
      presentation: ReportPresentationV2;
      unitRefs: string[];
      visibility: 'always' | 'collapsible';
      variant?: 'linear' | 'hub_spoke' | 'two_sided';
    }>;
  }>;
}
```

模型仍不生成 `slotId`、Section/Block/DOM ID。Projector 在结构通过校验后，使用 Blueprint hash、Section ordinal 和 Copy role 确定性生成 Copy Slot ID。`reportCopy.title/executiveSummary` 只能引用允许进入 primary 摘要范围的 leaf；Section title/lead 只能引用该 Section 拥有的 leaf；transition 只能引用当前与紧邻下一 Section 的 leaf，末节不得带 transition。

检查分为两级：

1. **结构级**：Schema、unitRef、presentation 兼容性、required coverage、exactly-once ownership、安全边界或绑定失败，整份结构使用 deterministic Blueprint；Copy 同时回到系统文案。
2. **fragment 级**：source leaf 越界/为空、超长，或出现来源未包含的新数字、日期、金额、比例、优先级、Evidence ID、URL、否定/状态强化时，只丢弃该 fragment。标题使用系统 view/source title，执行摘要使用 Canonical executive answer，lead/transition 直接省略；其余通过的 fragment 保留。

首版不做语义相似度评分、模型互审、自动改写循环或人工逐份审批。无法机械判断的文风差异不阻断报告；必要时用 `copy_fragment_fallback` Notice 说明局部采用原文表达。

`card-grid` 只接受 Material Builder 已识别的同构 record/action/risk/principle/status 项；`stage-flow` 只接受包含明确顺序、stage/phase、时间或已审节点边关系的 unit。缺少这些字段时，Planner 的选择不兼容，结构级回退到 Table/List/Graph；Projector 与 Renderer 不从自然语言猜测阶段或因果。

## 11. `ReportDocument v3` 类型化 Block

v3 在 v2 的基础上保留 `paragraph`、`fact`、`metric`、`list`、`answer`、`image`、`image-comparison`、`chart`，首期只新增三个当前数据可驱动的通用类型：

```text
record-table
graph: linear | hub_spoke | two_sided
priority-board
```

同时新增规范化来源合同。Trace 只在文档顶层保存一次；Block 和最小展示项只保存 unit/leaf 引用，避免在 block、row、cell、node、edge 间复制多组来源数组：

```ts
interface ReportTraceOriginV1 {
  artifactId: string;
  contentSha256: string;
  schemaVersion: string;
  jsonPointer: string;
  sourceNodeIds: string[];
  reviewState: 'passed' | 'passed_with_conditions';
}

interface ReportTrace {
  supportMode: 'direct' | 'inherited' | 'none' | 'system_derived';
  origins: ReportTraceOriginV1[];
  questionIds: string[];
  evidenceIds: string[];
  findingIds: string[];
  summaryIds: string[];
  status?: 'supported' | 'provisional' | 'unanswered';
  confidence?: number;
}

interface ReportBlockBase {
  id: string;                         // Projector 生成，不来自模型
  title?: string;
  visibility: 'always' | 'collapsible';
  unitRefs: string[];                 // 本 Block 拥有的 presentation unit
  leafRefs: string[];                 // 本 Block 拥有的 leaf 稳定去重并集
}

type ReportCellValue = string | number | boolean | null;

interface ReportChartTableAlternativeV3 {
  caption: string;
  columns: string[];
  rows: Array<{
    key: string;
    label: string;
    cells: Array<number | null>;
    evidenceIds: string[][];
  }>;
}

interface ReportListItemV3 {
  id: string;
  leafRef: string;
  label?: string;
  text: string;
}

type ReportLegacyShapeBlockV3 =
  | (ReportBlockBase & { type: 'paragraph'; leafRef: string; text: string })
  | (ReportBlockBase & { type: 'fact'; leafRef: string; text: string })
  | (ReportBlockBase & { type: 'metric'; leafRef: string; label: string; value: number; unit?: string })
  | (ReportBlockBase & { type: 'list'; ordered: boolean; items: ReportListItemV3[] })
  | (ReportBlockBase & {
      type: 'answer';
      kind: 'direct_answer' | 'evidence_finding' | 'strategy_map' | 'mind_model'
        | 'comparison_matrix' | 'design_principle' | 'opportunity'
        | 'priority_matrix' | 'action_plan' | 'channel_strategy'
        | 'limitation' | 'open_question' | 'risk';
      textLeafRef: string;
      text: string;
      items: ReportListItemV3[];
      answerStatus?: 'supported' | 'provisional' | 'unanswered';
    })
  | (ReportBlockBase & {
      type: 'image';
      leafRef: string;
      assetRef: { assetId: string; manifestArtifactId: string };
      caption: string;
      altText: string;
    })
  | (ReportBlockBase & {
      type: 'image-comparison';
      beforeLeafRef: string;
      afterLeafRef: string;
      beforeAssetRef: { assetId: string; manifestArtifactId: string };
      afterAssetRef: { assetId: string; manifestArtifactId: string };
      caption: string;
      altText: string;
    })
  | (ReportBlockBase & {
      type: 'chart';
      leafRef: string;
      chartRef: { chartId: string; assetId: string; manifestArtifactId: string };
      specHash: string;
      spec: ChartSpec;
      table: ReportChartTableAlternativeV3;
      caption: string;
      altText: string;
    });

interface ReportRecordTableBlock extends ReportBlockBase {
  type: 'record-table';
  columns: Array<{ key: string; label: string }>;
  rows: Array<{
    id: string;
    label?: string;
    cells: Array<{
      leafRef: string;
      columnKey: string;
      value: ReportCellValue;
    }>;
  }>;
}

interface ReportGraphBlock extends ReportBlockBase {
  type: 'graph';
  variant: 'linear' | 'hub_spoke' | 'two_sided';
  nodes: Array<{
    id: string;
    leafRef: string;
    label: string;
    description?: string;
  }>;
  edges: Array<{
    id: string;
    leafRef: string;
    from: string;
    to: string;
    label?: string;
  }>;
}

interface ReportPriorityBoardBlock extends ReportBlockBase {
  type: 'priority-board';
  groups: Array<{
    priority: 'P0' | 'P1' | 'P2';
    items: Array<{
      id: string;
      leafRef: string;
      action: string;
      owner?: string;
      rationale?: string;
      validationMethod?: string;
    }>;
  }>;
}

type ReportBlockV3 =
  | ReportLegacyShapeBlockV3
  | ReportRecordTableBlock
  | ReportGraphBlock
  | ReportPriorityBoardBlock;

interface ReportSectionV3 {
  id: string;                         // Projector 生成
  title: string;
  view: ReportViewIdV1;
  prominence: 'primary' | 'supporting' | 'appendix';
  blocks: ReportBlockV3[];
}

interface ReportAuditAppendixV1 {
  version: 'report-audit-appendix-v1';
  visibility: 'collapsible';
  sourceArtifactIds: string[];
  records: Array<{
    id: string;
    contributionArtifactId: string;
    sourceUnitKey: string;
    sourceSemanticHash: string;
    disposition: 'included' | 'merged' | 'conflicted' | 'omitted';
    canonicalNodeIds: string[];
    reasonCode?: string;
    reviewIssueIds: string[];
  }>;
}

interface ReportSemanticManifestV1 {
  version: 'report-semantic-manifest-v1';
  presentationUnitIds: string[];
  leafUnitIds: string[];
  assetIds: string[];
  auditRecordIds: string[];
  noticeIds: string[];
}

type ReportNoticeCodeV1 =
  | 'layout_fallback'
  | 'copy_fallback'
  | 'data_policy_fallback'
  | 'editorial_adapter_fallback'
  | 'optional_visual_omitted'
  | 'requested_artifact_unfulfilled'
  | 'visualization_linearized'
  | 'export_attachment_omitted'
  | 'renderer_compatibility_fallback'
  | 'html_unavailable'
  | 'zero_unavailable'
  | 'legacy_trace_incomplete';

interface ReportNoticeV1 {
  id: string;
  code: ReportNoticeCodeV1;
  severity: 'info' | 'warning' | 'action_required';
  scope: 'report' | 'section' | 'block' | 'export';
  relatedUnitIds: string[];
}

interface ReportDocumentV3 {
  version: 'report-document-v3';
  title: string;
  subtitle: string;
  executiveSummary: string;
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  sections: ReportSectionV3[];
  sourceDeliverableArtifactId: string;
  sourceDeliverableContentSha256: string;
  projectionMode: 'full';
  layoutMode: 'model' | 'fallback';
  traceIndex: Record<string, ReportTrace>;
  semanticManifest: ReportSemanticManifestV1;
  auditAppendix?: ReportAuditAppendixV1;
  notices: ReportNoticeV1[];
}
```

`layoutMode` 只记录结构 Blueprint 的来源，不能命名为 `editorialMode`。v3 不预留未实现的 Copy 字段；A-experience 按第 11.3 节使用严格的 `ReportDocument v4`。

要求：

- Answer、paragraph、list item、table cell、graph node/edge、priority action、metric 和 Asset 的 `leafRef` 必须存在于 `traceIndex`；不允许父级替 leaf 猜来源。
- Projector 必须把 Material leaf 的非空 `origins[]` 原样复制为 Report Trace。一个 leaf 依赖多个 Artifact 时逐项保留绑定，不能把 pointer 与 Artifact 身份拆成两组无关联数组。
- 每个 presentation unit 只能出现在一个 Block 的 `unitRefs`；每个 leaf 只能属于一个 Block 的 `leafRefs`。展示同一 leaf 的多个字段可以在该 Block 内复用相同 `leafRef`，但不得跨 Block 复制正文。
- Block 内所有 item/cell/node/edge/Asset 的 leafRef 必须属于该 Block 的 `leafRefs`，而 `leafRefs` 中的每个 ID 又必须至少被一个实际展示项引用；禁止只在 Manifest 中声明、正文却未投影的“幽灵覆盖”。
- Block/row/group 的聚合 Trace 在运行时由其 leafRefs 稳定去重计算，不写回 Artifact；聚合 confidence 采用最低值，不做平均。
- `semanticManifest.presentationUnitIds` 必须等于全部 Block `unitRefs` 的稳定去重集合；`leafUnitIds` 必须等于全部 Block `leafRefs` 的稳定去重集合；两者都必须与 Material 的 required 集合完全相等。
- `semanticManifest.assetIds` 是实际展示的不可变 Asset ID 集，不是 presentation unit ID 或 leaf ID；它必须等于全部普通图片、原图/标注图和 Chart 渲染 Asset 引用的稳定去重集合，并与 Package snapshot 中被报告引用的 Asset 集合完全相等。
- `semanticManifest.noticeIds` 必须等于 Document 中系统生成的 Notice ID 集；四端都显示同一组报告级说明。HTML/Zero/下载等后置出口状态由各自 Package/Publication/Bundle Manifest 追加，不能回写已 SEALED 的 ReportDocument。
- `record-table` 上限为 12 列、200 行；`graph` 上限为 50 节点、100 条边；`priority-board` 最多 3 组、每组 50 项。超限 source 必须在 Material Builder 阶段形成 leaf 互斥的稳定 chunk units，或作为一个 unit 在一个 Block 内线性降级；Projector 不得拆 unit、复制 unitRef 或丢 leaf。
- Graph edge 的 `from/to` 必须引用同 Block 内节点；若 Canonical edge 没有独立 support，其 Trace 只保留 edge 自身的 source pointer/node ID，不从相邻节点虚构 Evidence。
- Table 的 `columnKey` 必须来自该 source shape 的系统字段映射；模型不能指定任意对象路径。
- `auditAppendix` 只能来自 `ReportAuditAppendixMaterialV1`，不使用 Canonical Trace；其 ID 集合单独进入 `auditRecordIds`。Diagnostic reference 没有任何 v3 字段，因此无法被 Renderer 发布。
- 当前位于 runtime 的 `ChartTableAlternative` 需迁入共享 API contract（或由共享的 `ReportChartTableAlternativeV3` 取代），避免 Web/Agent API 继续跨层导入 runtime 类型。
- Section 显式保存 `view`，Web 不再根据 ID 和 kind 猜视图。
- `view` 和 `visibility` 受 source-kind 白名单约束，不由模型任意决定。`visibility` 是语义化显示策略，不由 React 对所有 `items` 一刀切。
- `style` 只能选择受控 preset；不接受模型 CSS。
- `notices` 只保存系统枚举和关联 ID，Renderer 用本地文案表生成简短“生成说明”；模型不能写 Notice 文本。说明不得替代安全校验，也不得包含内部异常、供应商名称或敏感策略细节。未请求且没有媒体、模型本来就处于关闭状态等正常情况不生成 Notice，避免提醒泛滥。
- v1/v2 继续可读；新 writer 只对启用的 Deliverable 生成 v3。

### 11.1 Canonical 到展示类型的默认映射

| Canonical source shape | 首选展示 | 确定性降级 |
|---|---|---|
| Direct Answer | answer / fact | paragraph |
| narrative | paragraph / fact | paragraph |
| comparison matrix | record-table | 分组列表 |
| strategy map matrix | record-table | 分组列表 |
| mind model nodes + edges | graph: linear/hub_spoke | 节点列表 + 关系列表 |
| design principles | Answer 卡片组 | 列表 |
| opportunity backlog | record-table | Answer 卡片组 |
| prioritized actions | priority-board | 按 P0/P1/P2 分组列表 |
| action plan | record-table；已有 phase/time 只作为受审字段展示 | 有序列表 |
| channel strategies | record-table | 渠道分组列表 |
| evidence findings | record-table / fact list | 列表 |
| limitations/open questions/risk | fact + 列表 | 列表 |
| verified numeric series | chart + table alternative | record-table |
| 已存在的 system-derived count | 单个 metric，明确标记“报告统计” | list |
| verified image asset | image / image-comparison | 媒体附件中的同一 Asset leaf；校验失败不得用占位符冒充 |

图示选择必须由源结构决定。Planner 可以在兼容选项中选择，但不能把 narrative 变成它没有声明的因果关系。

### 11.2 为什么需要 v3，而不是继续堆 Answer Card

Answer Card 的 `text + string[]` 无法可靠区分：

- 表格的行、列和单元格；
- 图的节点与边；
- Priority Board 的优先级、Owner 和验证方法；
- 每个最小展示项自己的 Evidence 与 confidence；
- 主体信息与审计信息的显示策略。

继续靠字符串前缀解析（例如 `Owner：`、`验证：`）只会把数据合同藏进文案，难以校验、多语言化和跨 Renderer 复用。

### 11.3 A-experience 的最小 v4 增量

`ReportDocument v3` 已经产生真实 Artifact，不能原地增加 Copy provenance、`card-grid` 或 `stage-flow`。A-experience 因此使用下一未发布的 `report-document-v4`；原 Milestone C 中曾预留给完整高级 Canonical 的 v4 只是未实现草案，其版本编号由本节取代。后续高级 Canonical 必须再使用新的严格版本，不能与本节混用。

v4 只增加以下能力，其他字段和 Block 继承 v3：

```ts
interface ReportEditorialCopyValueV1 {
  slotId: string; // Projector 确定性生成
  role: 'report_title' | 'executive_summary' | 'section_title'
    | 'section_lead' | 'section_transition';
  text: string;
  sourceLeafIds: string[];
}

interface ReportCardGridBlockV4 extends ReportBlockBase {
  type: 'card-grid';
  cards: Array<{
    id: string;
    title: string;
    body?: string;
    status?: string;
    leafRefs: string[];
  }>;
}

interface ReportStageFlowBlockV4 extends ReportBlockBase {
  type: 'stage-flow';
  stages: Array<{
    id: string;
    label: string;
    description?: string;
    timeLabel?: string;
    leafRefs: string[];
  }>;
}

interface ReportSectionV4 extends ReportSectionV3 {
  titleCopySlotId?: string;
  leadCopySlotId?: string;
  transitionToNextCopySlotId?: string;
}

interface ReportDocumentV4 extends Omit<ReportDocumentV3, 'version' | 'sections'> {
  version: 'report-document-v4';
  copyMode: 'model' | 'mixed' | 'fallback';
  titleCopySlotId?: string;
  executiveSummaryCopySlotId?: string;
  sections: ReportSectionV4[];
  editorialCopy: { fragments: ReportEditorialCopyValueV1[] };
}
```

已有 `title`、`executiveSummary` 和 Section `title` 保存最终可见字符串；对应 `*CopySlotId` 存在时，字符串必须逐字等于该 Slot 的 `text`。lead 与 transition 只通过 Slot 呈现。fallback 字段不创建假 Slot；`copyMode='mixed'` 表示至少一个模型 fragment 通过且至少一个请求的 fragment 局部回退。

`card-grid` 与 `stage-flow` 的每个 leaf 仍遵守 v3 exactly-once ownership。Markdown/Zero 无法保持卡片或横向流布局时可以线性化，但必须保留顺序、文字、leaf 和 Notice 集合。新增 Manifest 只需把实际使用的 Copy Slot ID 纳入语义集合；不为纯 CSS preset 升版本。

## 12. LLM 编排 Prompt

用户提出的原始意图应保留，但生产 Prompt 必须补足真实性和输出权限边界。

建议 System Prompt：

```text
你是一名专业的报告编辑与信息架构师。

你的任务是把系统提供的、已经审校的 Canonical 报告材料组织成更易读、逻辑更清楚、结构更明确的报告。你可以根据材料性质和分析目标选择章节顺序、分组、信息层级、受控风格，以及系统允许的表格、结构图、优先级看板、卡片组、阶段流或正文形式；同时可以为系统授权的位置生成报告标题、执行摘要、章节标题、章节导语和相邻章节过渡。

在不修改原资料内容和意思的前提下整理表达。你不得创建或修改任何 ID，只能把输入提供的 presentation-unit ID 原样写入 unitRefs；不得补全或创造事实，不得新增数字、日期、金额、比例、因果、优先级、结论、行动、证据、来源或 URL，不得把 provisional/unanswered 强化为确定结论，也不得修正看似错误的 Evidence 绑定。每个生成的文案 fragment 必须列出实际支持它的非空 sourceLeafIds，且只能引用该位置授权的 leaf。

每个 presentation unit 必须恰好有一个主归属。核心结论、关键行动和关键风险必须默认可见；Evidence、provenance 与方法信息可以折叠。没有明确结构或数据时使用正文或列表，不得为了视觉效果猜测表格字段、流程关系、阶段或图表数值。只有明确 priority 时才能使用优先级看板；只有明确的记录集合或阶段顺序时才能使用 card-grid 或 stage-flow。

只返回符合 report-editorial-blueprint-v2 Schema 的 JSON，不要返回 HTML、Markdown、CSS、JavaScript 或额外说明。
```

Planner 的 user/context 输入由 Material Builder 从完整 `ReportEditorialMaterialV1` 确定性裁剪。A-experience 使用 `ReportEditorialPlannerInputV2`，在 v1 安全内容索引上增加各 Copy role 的允许 leaf scope 与字符上限；Canonical 正文和结构完整保留，Asset/Chart 只暴露第 9 节定义的安全摘要，不包含二进制、SVG 正文、内部路径、网页全文、未授权 Step 内容或隐藏推理。Projector 仍只读取完整 Material，绝不从 Planner 摘要恢复数据。

### 12.1 模型运行与发布合同

- 只复用当前任务已经配置并通过数据策略批准的 LLM Gateway 与 `expectedModel`，不新增供应商、账号或凭证；Receipt 必须记录 provider、model、版本、prompt/completion tokens、时延与退出原因。
- Material Builder 在调用前执行与原研究链相同的数据分级和供应商授权检查。当前 provider 不允许接收的敏感内容不做内容替换，直接使用 deterministic fallback；不得为了让 Planner 可用而改变 Canonical 文本。
- 首期硬预算：序列化 Material 不超过 512 KiB、presentation unit 不超过 500、leaf unit 不超过 5,000、单次 prompt tokens 不超过 64,000、Blueprint 输出不超过 64 KiB。任一上限不满足即 fallback，不截断、不分片。
- Planner 只调用一次，不在 Planner 层重试；沿用 Gateway 的 30 秒默认超时。provider timeout、网络错误、限流、非法输出和 context 超限进入 fallback。
- 用户取消、lease lost 或上层 AbortSignal 中止必须原样向上抛出，不得生成 fallback Blueprint 或新的 Report Artifact；“取消”不是模型失败。
- 模型模式默认关闭。A-experience 首次开启只要求：同素材 composition-only 验收通过、结构/leaf coverage 差异为 0、确定性 fragment 检查与 fallback 可用、无安全错误。先按 Deliverable 小范围启用；不把三案例盲评或 50-task canary设为开发完成门槛。
- 若后续扩大为全量默认开启，再根据真实运行量补充抽样和回退率/时延观察；这些运营检查不进入单份报告生成链，也不阻断 deterministic 报告交付。
- 日志只记录计数、hash、reason code 和 token usage，不记录完整 Material、Prompt 或 Evidence 正文。供应商的数据保留与训练策略必须沿用当前已批准配置；配置无法确认时不得开启模型模式。

若产品负责人需要决定是否向全部任务默认开启，可在发布后另做轻量盲评；它不是开发门禁，也不新增审批服务。A-experience 的当前人工检查仅是同一素材的新旧报告对比，用于确认阅读层级和视觉表达达到目标。

`data_policy_denied` 不是任务失败或人工审批状态。四端用 `data_policy_fallback` 的 `info` Notice 显示“当前数据策略未启用模型编排，已自动使用确定性排版；报告内容与来源覆盖不受影响”，Package/日志保留原 reason code 供诊断。

### 12.2 历史 Copy Writer / Reviewer 草案（已由 A-experience 取代）

本节保留此前多模型方案的合同记录，不再进入当前实施。A-experience 不创建独立 Copy Writer、Reviewer Receipt 或逐 fragment 模型判定；使用第 10.2 节的一次 Planner 输出、确定性检查和局部 fallback。下列内容不得作为当前代码前置或发布门禁。

用户提出的“专业报告整理员”角色用于 Copy Writer，而不是扩大结构 Planner 权限。生产 Prompt 至少包含：

```text
你是一名专业的报告编辑。你只能为系统给定的 Copy Slot 写作，并且只能使用该 Slot 授权的 source leaf。

在不改变事实、数字、状态、范围、因果、优先级和证据含义的前提下，提高表达的可读性、连贯性和结构感。不得增加建议、结论、数据、来源、URL 或未在素材中明确表达的关系。每个输出 fragment 必须返回非空 sourceLeafIds。

只返回符合 report-editorial-copy-draft-v1 Schema 的 JSON；不要输出 HTML、Markdown、CSS、JavaScript 或额外说明。
```

Reviewer 使用独立调用，任务仅是逐 fragment 判断是否被引用 leaf 蕴含，不负责润色或修订；任何 `uncertain` 都按失败处理。Writer 与 Reviewer 都沿用第 12.1 节的数据策略、Receipt、取消传播和日志限制，但拥有各自独立的预算与 feature flag。首版上限为 200 个 Slot、序列化请求 512 KiB、单次输出 64 KiB、单次调用 30 秒且不在 Copy 层重试；每个 Slot 还受合同中的字符上限约束，任一预算超限即整批 fallback。

## 13. 固定阅读与折叠策略

折叠不应再由 `AnswerBlock.items.length > 0` 自动决定。

### 13.1 屏幕默认展开

- Executive Answer；
- Required Question 的直接结论；
- 业务含义；
- 建议行动；
- P0/P1 行动；
- 风险、局限和 `provisional/unanswered` 状态；
- 表格、Graph、Priority Board 的主体结构。

### 13.2 屏幕可折叠

- Evidence ID 明细；
- Finding/Summary/Source Pointer；
- 方法说明；
- 完整来源表；
- Contribution Ledger 与 disposition；
- 重复的扩展解释；
- Audit Appendix 的 disposition 与映射元数据。

Diagnostic reference 永不进入屏幕、打印、Markdown、Zero 或任何下载包；它不是“可折叠附件”。

### 13.3 打印与导出

- Web React 视图可在 `beforeprint` 展开全部可见附件，并在 `afterprint` 恢复交互状态；
- Standalone HTML 不使用 JavaScript：print CSS 必须显示 `<details>` 全部内容；目标引擎验证不通过时直接采用“附件始终展开”的保守模板，不做运行时浏览器探测；
- Markdown、Zero 和 ZIP 不允许因为 Web 默认折叠而丢内容；
- 折叠控件必须具备键盘可操作性、焦点样式和明确的 `aria` 标签。

### 13.4 生成说明（Notice）

Notice 用于解释一次安全降级，不作为新的审核层：

- `info` 在执行摘要下方以一行“生成说明”展示，例如模型因数据策略未启用而使用确定性排版；
- `warning` 放在受影响的 Section/Block 前，例如可选图片被省略或复杂结构改用 Table；
- `action_required` 只用于用户明确要求但未完成的产物，报告正文仍可阅读，但任务/UI 不得把该需求标为已满足；
- Notice ID 由 code、scope 和排序后的 related unit 确定性生成；同组 Notice 必须合并，四端使用本地固定文案并随打印/导出保留；内部异常、provider、重试与安全规则只进诊断日志。

正常降级不提示：用户未请求图片且没有媒体、模型能力默认关闭、历史报告不具备新交互，都不应产生 Notice。

## 14. Standalone HTML Renderer

新增纯函数 Renderer：

```ts
renderStandaloneReport({
  document,
  assetManifest,
  assetPathById,
}): { html: string; renderManifest: ReportRenderManifestV1 }
```

### 14.1 A-experience P0 与输出要求

A-experience 必须先消除当前 Renderer 对合同字段“读而不用”的问题：

- `style` 至少影响字体层级、色彩 token、Section 分隔和数据组件外观；三个 preset 共享结构，不复制整套模板；
- `density` 统一控制 Section/Block 间距、表格 cell padding 和卡片留白；
- `prominence='primary'` 使用更强标题与更宽内容层级，`supporting` 使用标准层级，`appendix` 使用弱化样式并可折叠；
- `graph.variant` 的 `linear`、`hub_spoke`、`two_sided` 必须有不同布局，空间不足时使用带标签的可访问线性表示；
- `card-grid` 与 `stage-flow` 使用同一 design token，移动端自动单列/纵向，打印时不裁切内容；
- 风险、局限和待解决问题先显示简短决策摘要；Evidence、provenance、完整来源和 Audit Appendix 默认折叠；
- 二维矩阵保持行列语义，不得为了复用列表组件摊平成难以比较的三列文本。

完成这些消费行为后才调整装饰细节；不得为每个案例增加专用 CSS 分支。

- 生成完整 `<!doctype html>` 文档；
- UTF-8、移动端 viewport、屏幕和打印样式；
- 左侧/顶部目录根据 Section 自动生成；
- 支持 v3 全部 Block以及 A-experience v4 的 `card-grid`、`stage-flow` 和 Editorial Copy；
- 图片使用 HTML Bundle ZIP 内的受控相对路径；“standalone”表示解压后不依赖服务器，不表示所有图片都内嵌进单个 HTML；
- Chart 同时提供可访问表格；
- Graph/Priority Board/Card Grid/Stage Flow 使用语义 HTML/CSS，打印时稳定；
- 无外部字体、CDN 或运行时依赖；
- 无网络请求；
- 第一版不使用 JavaScript：目录使用锚点，折叠优先使用原生 `<details>`。A-core 只把 Chromium 的断网打开、键盘/ARIA 和打印 smoke 作为阻断性兼容检查；Firefox、WebKit 与真实 Safari 作为上线后的兼容信号和发布清单抽查，不因单个非主引擎的折叠样式差异阻断核心报告。任一引擎的关闭态 `<details>` 无法在打印中完整展开时，该出口使用“附件默认展开且不可折叠”的保守模板，并在生成说明中提示表现降级。

### 14.2 安全要求

- 所有用户、模型和 Artifact 文本按 text、attribute、URL、CSS 各自的上下文编码，不以一个通用字符串替换函数冒充完整防护；
- 不允许 `dangerouslySetInnerHTML` 或把模型字符串拼入 `<style>` / `<script>`；
- 模型不生成 DOM ID；Section/Block ID 由 Projector 按 ordinal/unitRef 确定性生成并经过属性编码；
- URL 只来自已验证 Asset path 或已净化的公开来源，拒绝 `javascript:`、`data:text/html` 等危险 scheme；
- Asset path 只能由系统生成并匹配 `assets/[A-Za-z0-9._-]+`，同时检测净化后重名和目录穿越；
- Bundle 中的 SVG 只能是 `renderAndSealChartSvg()` 产生、绑定当前 `chart_render/chart_svg` 链并通过 trusted-SVG 校验的系统产物；普通上传/抓取 SVG 不得原样进入 ZIP，只有上游已生成并封存的 PNG/JPEG/WebP Derived Asset 可以替代。本方案不新增 SVG 转换服务；optional 源无安全替代时省略并生成 Notice，用户明确要求的 SVG 产物则标记未完成，但不阻断不依赖它的文本报告；
- HTML 内写入 meta CSP，至少为 `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'`；下载响应同时设置 `X-Content-Type-Options: nosniff`；
- 限制 Section、Block、HTML 字节数和 Graph 节点数，超限确定性降级；
- 纯 Renderer 返回 `ReportRenderManifestV1`；Report Package Builder 负责校验其中 Asset ID 与已验证 Manifest、Package Asset snapshot、实际 ZIP entry 的集合完全相等；
- HTML Artifact 与 Task/Plan/Attempt/ReportDocument hash 绑定并 SEALED。

### 14.3 与 Zero Renderer 的关系

Standalone HTML 和 Zero 不能维护两套不同的内容映射。应共享：

- `packages/report-rendering/report-document-visitor.ts` 中的 v3 Block visitor 与 Render Manifest 收集器；
- 文本 escape；
- table/graph/priority-board 的语义遍历；
- Asset 引用检查；
- 打印/静态降级规则。

Zero Adapter 只保留 Zero 特有的占位节点、图片写入和发布事务。不能直接拿 Standalone HTML 原样写 Zero，也不能让 Zero 继续只认识旧 Block。

当前 `zero-publication-service.ts` 会在 Zero 发布前临时追加 Multi-Skill 贡献摘要，而 Web 把它另行渲染、ZIP 则写 sidecar。v3 必须把允许用户查看的 Contribution disposition 统一写入 `auditAppendix`；删除 Zero 的结构性增补。Adapter 只负责表现，不能再改变报告的信息集合。Diagnostic reference 不进入共享 visitor。

### 14.4 跨 Renderer 语义 Manifest

```ts
interface ReportRenderManifestV1 {
  version: 'report-render-manifest-v1';
  renderer: 'react' | 'standalone_html' | 'markdown' | 'zero';
  rendererVersion: string;
  sourceReportDocumentContentSha256: string;
  semantics: ReportSemanticManifestV1;
  outputNotices: ReportNoticeV1[];
}
```

每个 Renderer 必须从实际遍历到的 Block、leaf、Asset、Audit record 与报告 Notice 生成 Manifest，不得直接复制 `document.semanticManifest`。渲染成功的必要条件是五个 ID 集合分别与 `ReportDocument.semanticManifest` 完全相等；Markdown/Zero 可以线性降级 Graph 或 Table，但不能丢失 ID 或 Notice。`outputNotices` 只记录该出口额外发生的安全或兼容性降级，例如 Bundle 省略一个可选审计 sidecar，或打印改用始终展开模板；它不参与跨 Renderer 语义等价比较。未执行或失败的 Renderer 不生成空 Manifest：HTML 把状态/reason 写入 Package，Zero 写入 Publication Artifact，同步 Web/Markdown 由 API/UI 返回稳定错误。测试比较排序后的语义集合，不比较文案、DOM 顺序或像素。

## 15. 图片、Chart 与结构图策略

### 15.1 不同“视觉”来源必须区分

| 类型 | 来源 | 是否需要图片 Skill | 是否属于本方案 |
|---|---|---:|---:|
| Table/Graph/Priority Board | Canonical 结构化关系 | 否 | A-core |
| Card Grid/Stage Flow | 已审记录集、阶段、顺序或关系 | 否 | A-experience |
| 已存在的数据 Chart | 已验证数值与 Chart Artifact | 否 | Milestone B 只消费 |
| 已存在的截图/照片/标注图 | Visual Asset Artifact | 否 | Milestone B 只消费 |
| 主动网页截图 | Search + Browser Capture | 需要 Tool/Skill 规划 | Milestone F1 才生产 |
| 通用数据 Chart | Typed numeric Canonical + Chart producer | 不需要图片 Skill | Milestone F2 才生产 |
| AI 装饰插图 | 非证据型生成素材 | 需要独立生成能力 | 不在当前全期范围 |

当前代码并非“完全没有图片能力”：`ReportCompositionService` 已发现并严格校验同 Attempt 的 Visual Asset、annotation lineage 与 ChartSpec；Web、Markdown ZIP 和 Zero 已支持 `image`、`image-comparison`、`chart`。缺口是 `research_strategy_report` v2 projector 没有消费这些参数，且当前 Chart producer 只实现了竞品评分权重特例。`playwright-page-capture` 虽已有真实 Adapter 与计划绑定校验，但 Registry 仍为 `draft`，在 egress、non-root 和 sandbox 生产证据完成前不得改为 active。

### 15.2 不得为了“尽量展示图表”降低真实性

执行优先级：

1. 有数值、维度、单位和 Evidence → Chart；
2. 有 rows/columns/cells → Table；
3. 有 nodes/edges → Graph；
4. 有明确 priority/action → Priority Board；
5. 只有有序项或 phase/time 字段 → Record Table / List；
6. 只有叙述 → Paragraph / Answer。

禁止从“增长很快”“优先级较高”等自然语言虚构坐标、百分比、连线或时间轴。

Demo 顶部的“证据数、结论数”等数量卡属于 `system_derived` 报告统计，不是业务指标。首期若保留，只使用现有单个 `metric` Block，由系统从 Artifact 重算并显式标记；不能附会业务 Evidence，也不能与转化率、增长率等 KPI 混排。

### 15.3 两个视觉里程碑不能合并承诺

1. **已验证素材接入（Milestone B）**只解决“当前 Attempt 已经有合法 Asset/Chart，但策略报告没有展示”的问题。没有素材是正常状态，报告不得出现空图片区或“生成失败”措辞。
2. **主动视觉生产（Milestone F）**解决“如何让任务产生截图或通用 Chart”。它需要调整 Capability Demand、冻结 Plan、Tool/Skill、Evidence 和 Canonical numeric contract，属于研究执行主链变化。

因此首个视觉里程碑的产品表述只能是“有已验证素材时可跨四端展示”，不能写成“所有报告会自动配图”。

## 16. Report Package、API 与兼容

### 16.1 Artifact

建议新增：

```text
kind: report_editorial_blueprint
schemaVersion: report-editorial-blueprint-v1

kind: standalone_html_report
schemaVersion: standalone-html-report-v1
relativePath: reports/report.html
```

Blueprint 为 `internal`；Standalone HTML 的读取权限与当前 owner-only Report/Asset API 相同。Material 默认不封存，只在 Blueprint/诊断中记录输入 Artifact ID/hash、Builder 版本和单元计数。

当前 `ControlArtifactStore` 只有 JSON 写入和受限图片二进制写入，不能安全封存原始 UTF-8 HTML。实现必须新增窄接口：

```ts
writeText(input: ArtifactWriteBase & {
  content: string;
  mediaType: 'text/html; charset=utf-8';
  maxByteSize: number;
}): Promise<ControlArtifact>;

readVerifiedBoundText(artifactId: string): Promise<{
  artifact: ControlArtifact;
  content: string;
}>;
```

该接口只接受无 NUL 的有效 UTF-8、固定 media type、显式最大字节数和安全相对路径；继续复用现有原子写入、hash、byteSize、SEALED 与 binding 校验。不得用 `writeJson()` 写 HTML，也不得放宽 `writeBinary()` 的图片白名单。

### 16.2 Report Package

采用 `report-package-v2`，但 HTML 不是 Package 成功的必选组件。合同必须显式表达状态，禁止用可空字符串或缺失字段表示失败：

```ts
type LayoutFallbackReasonCode =
  | 'planner_disabled'
  | 'data_policy_denied'
  | 'material_budget_exceeded'
  | 'provider_failure'
  | 'invalid_blueprint'
  | 'incompatible_presentation';

type HtmlUnavailableReasonCode =
  | 'unsupported_block'
  | 'unsafe_output'
  | 'render_manifest_mismatch'
  | 'size_limit_exceeded'
  | 'artifact_write_failed';

interface ReportPackageV2 {
  version: 'report-package-v2';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPublicationId: string;
  presentationMode: 'multimodal';
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  reportReviewArtifactId: string;
  sourceReportDocumentArtifactId: string;
  sourceReportDocumentContentSha256: string;
  crossSkillReviewArtifactId?: string;
  contributionLedgerArtifactId?: string;
  contributionSummaryArtifactId?: string;
  layout:
    | { mode: 'model'; blueprintArtifactId: string }
    | { mode: 'fallback'; blueprintArtifactId: string; reasonCode: LayoutFallbackReasonCode };
  assetSnapshot: {
    assets: Array<{
      assetId: string;
      manifestArtifactId: string;
      contentSha256: string;
      manifestHash: string;
      relativePath: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
      sourceKind: 'visual_asset' | 'chart_svg';
      exportPolicy: 'allow' | 'mask';
      leafIds: string[];
    }>;
    charts: Array<{
      chartId: string;
      chartSpecArtifactId: string;
      chartSpecArtifactContentSha256: string;
      specHash: string;
      assetId: string;
      dataArtifactRef?: { artifactId: string; contentSha256: string; schemaVersion: string };
      leafIds: string[];
    }>;
  };
  standaloneHtml:
    | {
        status: 'ready';
        artifactId: string;
        rendererVersion: string;
      }
    | { status: 'unavailable'; reasonCode: HtmlUnavailableReasonCode };
  notices: ReportNoticeV1[];
}
```

v1/v2 reader 并存；先部署 reader，后开启 v2 writer。不要在 v1 中静默改变组件集合。模型与 fallback 都必须封存最终实际使用的 Blueprint，保证 Projector 输入可复现；A-experience 的 Blueprint v2 同时保存 Copy fragment 与 source leaf。`assetSnapshot` 是整个 Report Package 的不可变媒体快照，不从属于 HTML 是否成功；Web、HTML、Markdown、Zero 都只能消费该集合。下载或重试发布时不得从“最新 Manifest”重新选择资源。`block` 资源不能出现在 snapshot。每个 `charts[].assetId` 必须唯一引用同一 snapshot 的 `assets[]` 项，SVG 的 hash、Manifest、media type 与相对路径只以该项为准；`sourceKind='chart_svg'` 仅接受已验证的 `chart_render/chart_svg` 链，普通视觉资源不得借此携带 SVG。Chart 的 Spec Artifact、可选 Data Artifact 和该 Asset 必须形成同一条冻结引用链。Package `notices` 至少包含 Document Notice 的原样集合，并可追加封存前已知的组件状态（如 `html_unavailable`）；下载时才发现的 sidecar/读取问题只进入该次 Bundle Manifest/API 响应，不回写已封存 Package。

当前 Package verifier 只用 `readVerifiedBoundJson()` 读取组件。v2 必须逐项校验 `assetSnapshot`；在 `standaloneHtml.status='ready'` 时再用 `readVerifiedBoundText()` 校验 HTML identity/hash/binding/media type，它不把 HTML 当 JSON parse。`unavailable` Package 仍是合法、可读取的核心报告 Package，但 HTML Bundle 下载不可用。

报告层复用现有 `ArtifactPublicationGroup`，不新增服务或数据库状态机。每次 composition 使用由 Task/Plan/Attempt、Deliverable/Review hash、目标 ReportDocument 版本和 Builder 版本确定性生成的 `reportPublicationId`，Package 使用 Attempt 下固定且唯一的相对路径；只跟踪本轮新写入的 Blueprint、Copy Artifact（若有）、ReportDocument、HTML 和 Package，不把既有 Deliverable、Evidence、Review 或 Asset 纳入补偿范围。Package 最后写入并 read-back 校验；Publication Group 保持 open，现有 `completeExecution` 扩展为接收明确的 `reportPackageArtifactId`，并在其现有事务内校验该固定路径只有这一份 SEALED、binding/publication ID 匹配的 Package 后完成 Attempt。完成失败时补偿本轮新 Artifact；完成成功后才调用内存态 `publicationGroup.commit()`。若进程恰在完成事务成功后、内存 commit 前退出，Recovery 以已完成 Attempt 为准，不失效已由完成事务验证的 Package。这个顺序不新增表或人工审批。Reader 只从已完成 Attempt 的固定路径读取这份 Package，不再按创建时间扫描“最新”松散 Artifact；“已完成 Attempt + 固定 Package 路径”共同构成 v2+ 唯一公开根。相同 publication ID 与相同输入重试返回该固定 Package；同一 ID 出现不同输入/hash 时只拒绝该次新提交，既有已提交报告保持可读。取消、lease lost、worker-loss 或写入异常由现有 Publication Group/`ExecutionRecoveryService` 将该 ID 下未提交 Artifact 失效或隔离，并把新增 Blueprint/HTML kind 纳入恢复测试；不回滚已经通过 Review 的 Canonical、Evidence 和历史 Package。HTML 为 optional component，`unavailable` 状态仍可正常完成核心 Package。

### 16.3 下载接口

离线交付单位是 `report.html + assets/*` 的 HTML Bundle ZIP，不是一个脱离资源目录的孤立文件。建议提供 owner-bound 下载：

```text
GET /api/control-tasks/:taskId/reports/:attemptId/html-bundle
```

接口必须：

- 从 Report Package 解析 HTML Artifact 和允许导出的 Asset，不接受任意文件路径；
- 校验 task owner、Task/Plan/Attempt binding、SEALED state 和 hash；
- 返回 `application/zip`，强制 `Content-Disposition: attachment` 和 `X-Content-Type-Options: nosniff`；
- ZIP 解压后 `report.html` 通过相对路径读取 `assets/*`，断网可用；
- 不暴露 internal Material/Blueprint。
- `standaloneHtml.status='unavailable'` 时返回稳定的 `409 html_bundle_unavailable`，不读取 Asset、不创建半成品 ZIP。
- ZIP entry 按路径稳定排序，使用固定 mtime 和固定压缩配置；`render-manifest.json` 记录 Renderer/Bundle Builder 版本。可复现性以 Package 中的 HTML/Asset hash 集合为准，不承诺不同压缩库版本产生相同 ZIP 字节。

ZIP 增加：

```text
report.html
assets/*
report-document.json
deliverable.json
evidence-manifest.json
report-review.json
full-report.md
render-manifest.json
```

上述 JSON 文件名表示**导出视图**，不是把内部 Artifact 原始字节直接装入 ZIP。Bundle Builder 复用并集中现有 `safeDeliverable()`、`safeEvidenceManifest()`、`safeReview()`、`safeReportDocument()` 的 allowlist 投影，经过共享 Validator 后再写入；投影不得包含 Diagnostic reference、内部存储路径、模型 Receipt、隐藏 Prompt、被 `block` 的资源或未授权原文。`report.html`、安全投影后的 `report-document.json`、`full-report.md` 和实际引用的 Asset 属于核心 Bundle；任一核心项无法安全投影或 hash 不一致时只把该 Bundle 置为 `unavailable`，Web/既有 Markdown 报告继续可用。Deliverable/Evidence/Review 等审计 sidecar 无法安全投影时省略该 sidecar，在 `render-manifest.json` 和下载 UI 写 `export_attachment_omitted` Notice，不用整包失败来惩罚无关正文。不得通过 Notice 放行危险内容。

最小 allowlist 沿用当前安全投影：Deliverable 只含公开的版本/binding、方法摘要、经 Deliverable-specific public projection 允许发布的 payload/finding/recommendation/coverage/risk/capability provenance；Evidence 只含 ID、kind、class、sensitivity 和 redaction 状态；Review 只含版本/binding、verdict、dimension 的 ID/pass/已脱敏 issue 与 revision round；ReportDocument 只含实际可见结构、Trace、Notice 和可导出 Asset ID。新增内部字段默认不导出，只有显式加入共享投影并通过负向测试后才可进入 Bundle。

### 16.4 Reader / Writer 兼容

- 历史 Payload v1/v2 不改；
- ReportDocument v1/v2 reader 保留；
- 新增独立 `parseReportPackageV2()`，严格拒绝未知字段和不完整 component union；不改变当前 v1 parser 的兼容行为，也不让 v1 parser 读取 v2；
- v3 reader/Renderer 先发布，v3 writer 后通过 Deliverable 级开关仅为 `research_strategy_report` 启用；不做长期 v2/v3 双写；
- A-experience 扩展 Package v2 Reader 对 ReportDocument v4 与 Blueprint v2 的严格白名单；Copy provenance 已在二者中完整保存，不增加独立 Copy Request/Review 组件，也不需要 Package v3；
- 后续高级 Canonical 若需要新 Package 字段，再使用新的严格 Package 版本，不复用历史草案版本号；
- Web 遇到未知 ReportDocument version 必须显示“客户端需刷新/升级”，不能静默空白；
- 历史 SEALED Artifact 不重写；
- 通用 Artifact 表足以承载新增 kind，预计不需要数据库迁移；实施前需用当前 repository parser 验证。

## 17. 确定性 Fallback

失败处理不采用“任何异常都暂停任务”的统一门禁，而是按影响范围分三级。Notice 是交付说明，不是放松真实性的借口：

| 级别 | 适用情况 | 系统行为 |
|---|---|---|
| 硬保护线 | 核心 Canonical/Final Review 无效；Task/Plan/Attempt/owner/hash 不可信；危险内容无法隔离；用户明确要求的必交付缺失；deterministic fallback 仍会丢 required leaf；取消或 lease lost | 只阻断最小受影响的提交边界，不发布一份自称完整的新结果；已有已提交报告保持可读 |
| 降级并提示 | Planner/Copy/可选媒体/富结构/数据策略/单个 Renderer 失败，且安全的确定性文本、Table 或既有出口仍完整 | 继续交付，写入受控 `ReportNoticeV1` 或对应 Package/Publication Notice，明确采用的替代形式 |
| 仅内部诊断 | 未请求且没有媒体、默认关闭的增强能力、重试次数、provider 时延等不改变用户所得内容的事件 | 不打扰用户，只记录枚举 reason code、计数和 Receipt |

安全问题若可通过隔离一个 optional Asset 或禁用一个出口完全消除，就只隔离该组件；不得因此撤销无关的 Canonical 文本报告。反之，Notice 不能替代授权、不可变绑定、Review 或 required leaf 覆盖。

Fallback 必须继续交付完整报告，而不是退回当前“一块一节 + 全部 Answer Card”。下列规则描述结构 fallback；A-experience 的单 Copy fragment 失败不触发整份结构 fallback：

1. 使用 `style='analytical'`、`density='comfortable'`；
2. 固定答案先行；
3. 按 Canonical `kind` 使用第 11.1 节默认映射；
4. requested artifact 保持 primary/supporting；
5. 风险和局限紧随行动之后；
6. Evidence 与 provenance 放入 appendix；
7. Section view 由 kind 确定性映射；
8. 所有 presentation unit 主归属 exactly once，所有 leaf unit 在对应主归属内完整覆盖；
9. 已验证图片/Chart 按绑定位置加入；没有绑定则进入媒体附件，不猜正文位置。
10. Copy fragment 不通过时，标题使用确定性 source/view label、执行摘要使用 Canonical executive answer，lead/transition 省略，并合并同类 `copy_fragment_fallback` Notice。

以下情况触发 fallback，但不使任务失败：

- LLM 超时、限流、网络错误或其他非取消调用错误；
- 非法 JSON/Schema；
- 未知、重复或遗漏 unitRef；
- usage policy 越权；
- presentation 与 source shape 不兼容；
- context 超限；
- 请求图示但结构不足。

以下情况使核心 ReportDocument composition fail closed：

- Canonical、Final Review 或其他必需事实源的 hash、Task/Plan/Attempt binding 不一致；
- 已经进入待提交 ReportDocument 的 Asset/Manifest/ChartSpec 无法在同一 publication 内验证，且不能先安全移除该 optional unit 并重新做完整 coverage；
- Report Review 未通过；
- Canonical 必答问题、明确标记为 required 的 requested artifact 或 Evidence 合同失败；
- deterministic linear fallback 后 Canonical 到 ReportDocument 的 required presentation/leaf 语义覆盖仍失败；
- Projector 产生未知 Block 或非法 Trace 引用。

以下情况只使 `standaloneHtml.status='unavailable'`，不撤销已经 SEALED 的核心 ReportDocument/Web/Markdown：

- HTML Renderer 不支持当前启用的 ReportDocument 版本中的已知 Block；
- HTML Renderer 产生危险 URL、非法 Bundle path 或 Render Manifest 不等价；
- HTML 超过字节上限或封存失败。

Package 已封存后，Bundle API 若重新读取时发现 HTML/Asset hash 或 snapshot 不一致，只让该次下载 fail closed，并返回稳定的 `409 html_bundle_integrity_error`；不得修改既有 Package 状态，也不得返回缺文件的半包。

用户取消、lease lost 或上层 AbortSignal 中止必须传播原状态并停止写入，不进入 fallback，也不把 Package 写成 `unavailable`。API owner 授权失败只拒绝当前读取/下载请求，不改变任务或 Package 状态。

状态矩阵：

| 失败点 | 核心报告 | HTML 组件 | Package / API 行为 |
|---|---|---|---|
| Planner provider/Schema/context/data policy | 成功，使用 typed fallback + Notice | 继续尝试 | Package 记录 `layout.mode=fallback` |
| 单 Copy fragment source/机械漂移检查失败 | 成功，只回退该 fragment | 继续尝试 | Document 记录 `copyMode=mixed|fallback` 与合并 Notice |
| optional 媒体候选在 Material 冻结前不合法 | 成功，隔离候选并使用文本/Table + Notice | 继续尝试 | snapshot 不包含该候选 |
| Canonical/Review/required Asset 完整性，或 fallback 后 required coverage 失败（封存前） | 失败 | 不生成 | compensate 当前 publication，不写新 Package |
| HTML render/writeText | 保持成功 | `unavailable` | v2 Package 合法；下载返回 `409 html_bundle_unavailable` |
| 已封存 Bundle 再读取时 hash/snapshot 不一致 | 不变 | 不改写 | 本次下载返回 `409 html_bundle_integrity_error` |
| 用户取消或 lease lost | 取消/中止 | 不生成 | 不写新 Artifact/Package |
| 未授权下载 | 不变 | 不变 | 仅拒绝请求 |

媒体链再补充五条原子性规则：

- optional Asset/Manifest、annotation lineage、ChartSpec、Data Artifact 或 binding 在进入 Material 前不完整时，隔离该候选，使用文本/Table 继续并写 `optional_visual_omitted`；只有明确 required 的资源缺失，或资源已经进入待提交/已提交 snapshot 后发生不一致，才阻断该 publication 或该次下载。
- Attempt 没有任何媒体素材时正常成功，`assetSnapshot` 为空，不生成空“媒体附件”章节。
- 主动 Chart producer 的 Renderer 不可用时记录 gap，保留 Canonical Table/文本并继续报告；已经 SEALED 的 Chart 链损坏则按上一条 fail closed。
- Markdown/HTML Bundle 在读取 snapshot 中任一 Asset 失败时本次下载原子失败，不产生缺文件的半包；已封存核心 ReportDocument 不受影响。
- Zero 发布失败只影响该次发布，可基于同一 Package 重试，不回滚 ReportDocument、HTML 或其他出口。

## 18. Milestone A–B 文件改造范围

以下是基础平台和“消费既有视觉素材”的建议落点。它明确涉及超过 8 个文件和 Web/Runtime/Agent API 三个消费者，但不新增服务、数据库表、语言或运行时；复杂度来自共享合同迁移而不是新基础设施。最终实现可以合并小文件，但不得把合同、Planner 和 Renderer 混成一个巨型模块。Milestone C–F 的额外改动在第 19 节各自列出。

### 18.1 新增

```text
packages/api-contract/report-editorial.ts
packages/api-contract/report-document.ts
packages/report-rendering/report-document-visitor.ts
packages/report-rendering/report-render-manifest.ts
packages/report-rendering/report-export-projection.ts
schemas/report-editorial-material-v1.schema.json
schemas/report-editorial-blueprint-v1.schema.json
schemas/report-document-v3.schema.json
apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts
apps/orchestrator-runtime/src/report/report-editorial-planner.ts
apps/orchestrator-runtime/src/report/report-editorial-projector.ts
apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts
apps/orchestrator-runtime/src/report/standalone-html-report-package.ts
tests/report-editorial-material.test.ts
tests/report-editorial-planner.test.ts
tests/report-editorial-projector.test.ts
tests/standalone-html-report-renderer.test.ts
tests/report-render-manifest.test.ts
tests/report-export-projection.test.ts
```

### 18.2 修改

```text
packages/api-contract/control-workflow.ts
packages/api-contract/system-capabilities.ts
database/control-plane.ts
apps/orchestrator-runtime/src/control/artifact-store.ts
apps/orchestrator-runtime/src/control/artifact-publication-group.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/orchestrator-runtime/src/control/execution-recovery-service.ts
apps/orchestrator-runtime/src/control/task-workflow.ts
apps/orchestrator-runtime/src/report/report-composition-service.ts
apps/orchestrator-runtime/src/report/report-document-composer.ts
apps/orchestrator-runtime/src/report/report-projection.ts
apps/orchestrator-runtime/src/report/chart-renderer.ts
apps/orchestrator-runtime/src/report/report-package-artifact.ts
apps/orchestrator-runtime/src/report/current-report-package-reader.ts
apps/web/src/reporting/ReportDocumentView.tsx
apps/web/src/reporting/report-document-view-model.ts
apps/web/src/reporting/report-print.css
apps/web/src/reporting/report-bundle.ts
apps/web/src/report-package-response.ts
apps/web/src/components/stages/CurrentStage4Report.tsx
apps/web/src/api/client.ts
apps/agent-api/src/control-runtime.ts
apps/agent-api/src/routes/control-tasks.ts
apps/agent-api/src/routes/system-capabilities.ts
apps/agent-api/src/integrations/zero/zero-report-renderer.ts
apps/agent-api/src/integrations/zero/zero-publication-service.ts
orchestrator/deliverable-registry.yaml
package.json
```

### 18.3 A–B 不修改

```text
Tool / Knowledge 采集合同
Contributor Skill 执行合同
research-strategy-synthesis 的内容职责
Step 10 Canonical 无损编译规则
Evidence Manifest 的真实性边界
历史 Artifact
```

## 19. 完整开发路线（Milestone A–F）

每个 Milestone 必须独立可合并、可运行、可观测、可回滚；前一里程碑不能依赖后一里程碑才具备用户价值。Reader 必须先于 Writer 发布；不得长期双写，也不得产生没有消费者的新 Artifact。

| Milestone | 解决的问题 | 主要输入 | 主要输出 | 是否改变研究素材生成 |
|---|---|---|---|---:|
| A-core：基础报告平台 | 确定性类型化结构与 HTML Bundle | Reviewed Canonical v2 | ReportDocument v3、Package v2 | 否 |
| A-model：结构编排增强 | 在同一无损合同内优化章节与展示选择 | A-core Material | 引用式 Blueprint v1 | 否 |
| A-experience：编辑体验纵切片 | 标题/摘要/导语、视觉层级、通用卡片/阶段流及 Research Plan 复用 | 已审历史素材 | Blueprint v2、ReportDocument v4、可读 HTML | 否，只做末端加工 |
| B：已验证视觉素材 | 让既有图片、标注图、Chart 真正进入策略报告 | 已验证 Visual/Chart Artifact | v3 image/comparison/chart | 否，只消费 |
| C：高级结构报告 | Roadmap、Swimlane、Metric Group、Persona、Journey | Typed Skill/Contribution + Canonical v3 | ReportDocument v4 | 是，显式扩展 Canonical/Review |
| D：全 Deliverable 复用 | 将固定流程覆盖其他正式 Deliverable | 各 Deliverable 的受审 Payload | 显式 Adapter/Profile | 否，逐类型投影 |
| E：受审 Editorial Copy（历史草案） | 已由 A-experience 覆盖 | — | 不实施独立 Writer/Reviewer/v5 | — |
| F：主动视觉生产 | 主动截图、从通用数值材料生产 Chart | 受控 Tool/Skill + Evidence | 新 Visual/Chart Artifact | 是，扩展采集/Evidence 主链 |

依赖、开关和独立交付边界固定如下；表中的依赖是代码/合同依赖，不代表必须把所有前序能力同时面向用户开启：

| 交付包 | 必需前置 | 写入/模型开关 | 关闭后的稳定行为 |
|---|---|---|---|
| A-core | 无；先保留历史 Reader | `report_v3_writer`、`standalone_html_bundle_v1` | 原 v2/当前报告路径继续可读 |
| A-model | A-core | `report_editorial_planner_v1` | 继续使用 deterministic typed Blueprint，不影响报告交付 |
| A-experience | A-core；复用 A-model Material/Projector 边界 | `report_editorial_experience_v1` | 回到既有 Blueprint v1 / ReportDocument v3；不重写历史 Artifact |
| B | A-core 的 v3 Reader/Writer 与 Package v2 Reader | `report_visual_assets_v1` | 生成无媒体但内容完整的 v3 报告 |
| C | A-core；B 只在 Persona 图片等 Asset 被选入时需要 | `canonical_v3_writer`、`report_v4_writer`、五个独立 Block writer | 旧 Canonical/ReportDocument Reader 保留；未开启的高级结构使用同版本无损线性表示 |
| D1–D4 | A-core；Visual 能力按 Deliverable 可选依赖 B | `editorial_report_competitive_analysis_writer`、`editorial_report_design_audit_writer`、`editorial_report_voc_diagnosis_writer`、`editorial_report_accessibility_audit_writer` | 该 Deliverable 回到原报告路径，其他类型不受影响 |
| D5 | C 的 v2 pipeline 与 v4 Reader/Writer | `editorial_report_research_plan_writer` | `research_plan` 继续原报告路径 |
| E（历史草案） | 已由 A-experience 取代 | 不创建旧 `report_v5_writer` / `editorial_copy_model` | 使用 A-experience 单一开关或既有 v3 fallback |
| F1 | 已完成的网页视觉证据链代码；报告展示依赖 B | Registry `playwright-page-capture=active` 且 `PLAYWRIGHT_CAPTURE_ENABLED=1` | 新计划不产生截图步骤；历史 V2 Asset Reader 保留 |
| F2 | B 的 Chart/Asset Reader 与一种合格 typed numeric source | `generic_chart_producer_v1` | 保留 Table/文本和历史 Chart Reader |

这些开关都是 System Capabilities 中的封闭枚举，不允许运行时拼接未知名称；Registry linter 校验每个开关只绑定一个 Profile。当前只推进 A-experience；B、F 延后，原 C/D/E 作为历史 backlog 保留。A-model 或 A-experience 的模型条件未满足时只保持关闭，不能阻塞既有确定性路径。

A1 Reader 和 fixture 可以先行，不因 inventory 尚未完成而阻塞。A2 默认开启 `record-table/graph/priority-board` Writer 前，新 ADR 至少附上三个真实 Canonical inventory：现有众筹案例、一个定量案例和一个纯叙述案例，并记录 Deliverable/Review hash，逐项列出 matrix、node/edge、priority/action、Asset/Chart 和纯文本结构。inventory 未完成时继续使用 paragraph/list 的无损线性投影并写 `visualization_linearized`，A-model 保持关闭；不能因为单个案例内容丰富就把 C 的高级 Block 偷塞回 v3。

### 19.1 Milestone A：基础报告平台与可选模型增强

目标：仅使用当前已经通过 Review 的 Canonical v2，把 `research_strategy_report` 从 Answer Card 浏览器升级为可审计、可离线交付的类型化报告。A1–A3 构成可独立发布的 A-core；Layout selectable ID 修复与 A4 共同属于不阻塞 A-core 的 A-model。即使 A-model 与 B–F 永远不开启，系统也必须稳定可用。

#### A-model 前置：修复现有 Layout selectable ID 缺陷

该修复只在启用新 Editorial Planner 前完成，不是 A-core 的发布前置。

- Planner context 明确区分 `fixedDirectAnswers` 与 `selectableContentBlocks`；
- `executive_answers` 的 `answer-q*` 不再伪装成可选 Content Block；
- Validator 与 Prompt 使用同一 selectable ID 集；
- 增加包含 `executive_answers` requested binding 的真实回归。

验收：众筹 fixture 不再因 `answer-q1` 触发 fallback；未知、重复和越权 ID 仍整份回退。

#### A1：先发布 ReportDocument v3 Reader 与既有 Renderer

- 新增共享 v3 合同、Schema、Trace Index、Semantic/Render Manifest 与 Audit Appendix；
- 新增 `record-table`、`graph`、`priority-board`；
- React、Markdown、Zero 先使用共享 visitor；Standalone HTML 在 A3 复用同一 visitor；
- Section 显式保存 `view`，Block 显式保存 `visibility`；
- System Capabilities 宣告 v3 reader 可用，但 writer 保持关闭。

验收：v1/v2 回归不变；fixture v3 可被三个既有出口读取；每端从实际 traversal 生成等价 Manifest；生产仍不写 v3。

#### A2：启用确定性 v3 Writer

- 上线 Material Builder、Blueprint Schema/Validator/Artifact、coverage gate 和完整 deterministic typed Blueprint；这些基础合同不依赖模型；
- 迁移 `research_strategy_report` 的 deterministic projector；
- paragraph/list 无损线性投影随 A2 默认开启；三种富结构 Writer 仅在第 22.1 节 inventory 已完成且对应 source shape 已被真实案例证明后分别开启；
- 一次性纳入用户可见 Audit Appendix，并证明 diagnostic reference 无写入路径；
- 通过 Deliverable 级开关启用 v3 writer；
- Planner 保持关闭，先证明无模型路径完整可用。

验收：不依赖 inventory 即可生成 leaf 完整的 paragraph/list v3，三个既有出口语义集合一致，Zero 不再临时增加报告内容。已完成 inventory 并开启对应富结构 Writer 时，众筹案例已有 mind model、opportunity、prioritized action 再分别稳定生成 Graph/Table/Priority Board；未开启时用 `visualization_linearized` Notice 说明展示降级，不阻断 A-core。

#### A3：生成并封存 Standalone HTML Bundle

- 实现安全纯函数 Renderer 与受限 `writeText/readVerifiedBoundText`；
- 封存 `reports/report.html`，绑定 ReportDocument hash；
- Report Package v2 按 reader-first/writer-later 发布；
- HTML 组件采用 `ready | unavailable`，Asset 使用不可变 snapshot；
- 提供 owner-bound HTML Bundle ZIP 下载；
- CI 使用 Chromium 自动验证断网打开、主要移动端、键盘/ARIA 与打印 smoke；Firefox/WebKit 放入非阻断兼容任务，真实 Safari 放入抽样发布清单。兼容性差异优先切换为“附件始终展开”的保守模板并提示，不增加逐报告人工验收。

验收：ZIP 解压后断网可打开；恶意文本、URL 和路径不能注入；四端 Manifest 集合一致；HTML 构建失败时核心报告仍可读取，Package 写明确 reason code，下载稳定返回 409。

#### A4：用 Editorial Planner 替换旧 Layout Planner

实施状态（2026-08-27）：Planner、输入裁剪、Prompt、Schema、诊断、fallback 与运行时边界已经实现，并通过一个真实历史案例的 composition-only 模型验收；默认启用所需的三个固定 Golden、轻量盲评、50-task canary 和 Package v1 追溯补齐仍未完成。

- 在 A-core 的 Material/Blueprint 合同之上增加 Planner-safe 输入裁剪、Prompt、模型调用和诊断；
- 完整 Material 仍只在内存构建，模型只接收安全裁剪视图；
- 一次 LLM 只选择章节、视图、受控样式和兼容 presentation；
- 旧 Layout Planner 停止为新 Attempt 写入；
- deterministic typed fallback 与模型路径都封存最终 Blueprint，并通过同一 coverage gate；
- 执行 512 KiB、64k token、30 秒、供应商策略和取消传播等运行时边界；
- 默认开启前再执行 canary 和自动关闭门禁。

验收：至少三个非同构 Golden 的 model/fallback fidelity 差异为 0，模型结构质量不低于 fallback 后才允许 canary；达到第 12.1 节阈值后才允许按 Deliverable 默认开启。

#### A-core 发布条件

- A1–A3 全部完成；
- v1/v2 Reader 和历史 Package 回归通过；
- 关闭 Planner 后仍能生成完整 v3、HTML Bundle 和 Markdown；
- `research_strategy_report` 不再依赖案例专用 HTML；
- B–F 的开关全部关闭时，A 的功能和测试仍完整通过。

达到以上条件即可发布 A-core。A4 按独立 A-model 开关上线：模型输出与 fallback 的 fidelity 差异为 0、轻量盲评达到第 12.1 节标准并通过 canary 后才默认开启；不满足时继续使用 deterministic Blueprint，不影响 A-core 的完成状态。

### 19.A A-experience：编辑体验纵切片（当前 P0）

目标：在不重跑研究链、不增加第二 Reviewer 模型的前提下，用同一批已审素材生成接近旧编辑原型的信息层级、编辑感和视觉表达。以下五个工作包按顺序实施，每个完成后都保持既有报告可用。

#### AX1：让 Renderer 合同字段真正生效

- Standalone HTML 与 React 共享 `style/density/prominence/graph.variant` 的语义 token；Markdown/Zero 保留对应层级与线性替代；
- 修复二维矩阵比较布局，风险/局限/待解决摘要默认展开，Evidence/provenance/Audit 默认折叠；
- 不增加案例名称、任务 ID 或 Deliverable 专用 CSS 分支。

验收：同一个 v3 fixture 切换 style/density/graph variant 时 DOM class 与关键布局实际变化；390px 无页面级横向溢出；打印不丢内容。只运行报告 Renderer 的定向测试和一次 Chromium smoke，不做全浏览器矩阵。

#### AX2：增加两个通用 Block

- `card-grid` 用于同构的机会、风险、原则、状态或行动记录；
- `stage-flow` 用于存在明确顺序、stage/phase/time 或线性节点边的旅程、时间线、逻辑链与阶段计划；
- Material/Projector 保存 leaf exactly-once 与 Trace；不兼容或超限时线性降级；
- 四端共享 visitor。Markdown/Zero 可以线性表示，不要求复刻 HTML 布局。

验收：每种 Block 各一个正向 fixture、一个缺少结构字段的负向 fixture；正向四端 leaf 集合一致，负向不得从文本猜 structure。

#### AX3：一次 LLM 同时生成结构和 Editorial Copy

- 新增 Planner Input/Blueprint v2 Reader 与 Schema，v1 历史 Reader 保留；
- 一次 structured call 返回结构、受控 presentation，以及 title/summary/section title/lead/transition fragment；
- Projector 对结构执行 v1 同等级 coverage/ownership 校验，对每个 fragment 执行第 10.2 节的轻量确定性检查；
- 单 fragment 失败只回退该位置，结构失败才整体 fallback；不重试、不调用第二模型、不创建人工审批状态；
- ReportDocument v4 与对应 Package 严格版本保存最终 Copy、source leaf 和 `model|mixed|fallback` 状态。

验收：一个完整 model fixture、一个单 fragment 含新增数字的局部 fallback fixture、一个结构漏 unit 的整份 fallback fixture、一个 provider 失败 fixture；所有路径都能继续生成内容完整报告，取消/lease lost 仍向上传播。

#### AX4：最小 `research_plan` Adapter

- 只读取当前正式路径已经审校的 Final/Payload、Evidence 和 Review binding；
- 显式映射目标、研究问题、方法、样本、执行步骤、交付物、风险和时间字段到共享 Material；
- 有明确 stage/phase/order 时允许 `stage-flow`，没有时使用 paragraph/list/card-grid；
- 不读取 Steps 1–6 的未审正文补写最终报告，不为单个宠物食品案例增加映射分支。

验收：目标历史宠物食品 `research_plan` 可 composition-only 生成 v4/HTML；素材输入 manifest hash 前后不变；删除明确 stage 字段后稳定降级且不丢正文。

#### AX5：同素材 composition-only 验收

锁定旧原型对应历史 Attempt 的 Deliverable、Review、Evidence 和 Package 输入 hash，只运行：

```text
existing reviewed artifacts
→ Material / research_plan Adapter
→ 一次 Editorial Planner
→ deterministic validation + fragment fallback
→ Projector
→ Web / Standalone HTML / Markdown / Zero render
```

通过条件：

- 不重跑 Search、Contributor、Synthesis、Step 10 或 Final Review，输入 Artifact hash 不变；
- Canonical presentation/leaf、Evidence、status、confidence 和 action priority 覆盖无差异；
- 报告包含可识别的执行摘要、编辑型章节标题/导语，以及素材支持时的 Table/Graph/Priority Board/Card Grid/Stage Flow；
- 主报告优先呈现决策信息，完整来源和审计仍可查；
- 390px、桌面和打印 smoke 通过，无脚本、无外部资源依赖；
- 与旧原型做人工并排检查，确认结构层级、信息查找和视觉表达明显改善。该检查只用于验收产品效果，不是每份报告的发布门禁。

不要求：像素复刻旧原型、补写原素材不存在的 Persona/Journey/指标、引入真实图片、完成三个 Golden 盲评、50-task canary、全 Deliverable Adapter 或全仓历史失败清零。

主要文件面限定在既有报告栈：Planner/Schema、Material/Projector、ReportDocument/Package、共享 visitor、四端 Renderer、`research_plan` Adapter 及定向测试。若实现发现需要修改搜索、Evidence、Synthesis 或 Canonical 生成，停止扩范围并记录为后续上游任务。

### 19.2 Milestone B：接入已验证 Visual Asset / Chart

状态：延后。A-experience 验收前不以图片接入扩大当前工作面。

目标：只消费当前 Attempt 已经产生并验证的 Visual Asset、Annotation 与 Chart，不在报告阶段联网、截图、生成插图或编造数值。

#### B1：冻结资源归属合同

- Material 保存完整的 Asset/Manifest/hash、ChartSpec、table alternative、Evidence 和 Canonical binding；Planner 只看到安全摘要；
- 使用第 9.1 节的唯一匹配优先级，禁止按标题、文件名或语义相似度猜位置；
- 原图与标注图组成一个 `asset_pair` unit，不得再分别拥有正文位置；
- `allow/mask` 进入候选集合，`block` 在 Material、Document、Package 和 Manifest 中均为零；
- 歧义或无绑定资源进入固定“媒体附件”，不阻断正文。

#### B2：策略报告确定性投影

- `research_strategy_report` projector 消费 Composition 已发现的 `visualAssets`、`charts` 和 annotation binding；
- 生成 v3 `image`、`image-comparison`、`chart`；
- caption/alt text 由系统从受控来源字段生成，不能由 Planner 自由写作；
- Chart 必须同时保留完整 table alternative；
- 无素材时不生成空 Section、空占位或“建议补图”假内容。

#### B3：四端、Package 与发布

- React、HTML、Markdown、Zero 共享资源 visitor 和引用校验；
- Package v2 固定 Asset snapshot，下载时不得重新选择“最新”资源；
- Render Manifest 从实际访问到的 Asset leaf 生成；
- 对 `mask` 只导出已经由上游生成并封存的受控字节，Renderer 不现场脱敏。

主要改动集中在 `report-composition-service.ts`、`report-editorial-material-builder.ts`、`report-editorial-projector.ts`、共享 visitor、四个 Renderer、Package reader/writer 与相关测试；不修改搜索和 Contributor Skill。

失败与回滚：Attempt 没有可选媒体是正常状态，正文继续且不创建空章节。optional 候选的 hash、Manifest、binding 或安全校验失败时，在 Material 冻结前隔离该资源，回到文本/Table 并写 `optional_visual_omitted`；未请求且没有媒体不提示。明确 required 的资源缺失，或资源已经进入待提交/已提交 snapshot 后发生不一致，才阻断对应 publication/下载，不能静默删图后声称同一 Package 完整。单个 Renderer/下载读取失败只影响该出口。关闭 `report_visual_assets_v1` 即回到无媒体的完整结构报告，历史 Asset Reader 保留。

Milestone B DoD：

- `allow/mask` Asset exactly once，`block` 为零；
- annotation pair 不重复出现；
- Chart 数值、Evidence、table alternative 完全一致；
- 无素材案例不出现空媒体区；
- 四端 presentation/leaf/Asset/Audit/Notice 集合一致；
- 一个无媒体、一个图片、一个 annotation pair、一个 Chart Golden 全部通过。

### 19.3 Milestone C：高级结构化报告

状态：历史 backlog，当前不实施。A-experience 已使用下一未发布的 Blueprint/ReportDocument 版本，因此本节示例中的 v2/v4/v5 编号不再有效；若未来重新立项，必须从当时最新严格版本继续编号。本节保留的是 Persona、专用 Journey、Swimlane、Metric Group 等更强 Canonical 语义的需求清单，不能覆盖第 10.2、11.3 和 19.A 节的当前合同。

目标：补齐 Roadmap、Swimlane、Metric Group、Persona Set 和 Journey Map。该阶段先改上游受审结构，再改报告；不能只新增前端组件。

当前缺口已经由生产合同确认：`RequestedArtifact` 尚未包含这些正式产物；`research-contribution-v1` 的 Persona/Journey/Metric 只有 `title/statement/support`；通用 Adapter 会压平复杂 Payload；Content v2 没有相应 Block；`action_plan` 也没有 phase、lane、order 或 dependency。

#### C1：版本化合同

当前 `RequestedArtifact` 闭集同时固化在 `research-task-v2`、`capability-demand-graph-v1`、`current-execution-plan-v3` 和 `research-contribution-v1`。因此 C1 先做显式控制面版本迁移，不能在这些旧版本中直接追加枚举：

```text
research-task-v3
capability-demand-graph-v2
current-execution-plan-v4
research-contribution-v2
research-contribution-bundle-v2
research-strategy-content-draft-v3
research-strategy-content-patch-v2
research-strategy-content-v3
report-editorial-material-v2
report-editorial-blueprint-v2
report-document-v4
```

`research-task-v3`、Demand Graph v2、Execution Plan v4 和 Contribution v2 使用同一闭集，新增 `persona_set`、`journey_map`、`metric_framework`、`sequenced_plan`；缺一处都禁止开启 C Writer。迁移顺序固定为：所有 API/Web/Worker/Recovery Reader 接受新旧版本 → System Capabilities 宣告新版本 → Planner 只为新 Attempt 写 v3/v2/v4 → Contributor 写 v2 → Canonical v3 Writer。旧 Worker 不得领取新版本 Plan，旧 Artifact 不迁移、不重写；需要新结构时生成新 Attempt。Report Package v2 只将允许的 ReportDocument version 作为严格白名单扩展，不因 Block 增加而自动升版。

高级 presentation 必须属于 v2 union，不能原地扩大 v1：

```ts
type AdvancedReportPresentationV2 =
  | 'roadmap'
  | 'swimlane'
  | 'metric-group'
  | 'persona-set'
  | 'journey-map';

type ReportPresentationV2 = ReportPresentationV1 | AdvancedReportPresentationV2;
type ReportViewIdV2 =
  | ReportViewIdV1
  | 'plan'
  | 'findings'
  | 'comparison';
type ReportDisplayPresetIdV1 = 'full_report' | 'management_summary';
type ReportPresentationVariantV2 =
  | 'linear'
  | 'hub_spoke'
  | 'two_sided'
  | 'timeline'
  | 'lane_grid'
  | 'cards'
  | 'stage_grid';

type AdvancedEditorialSemanticKindV2 =
  | 'sequenced_plan'
  | 'metric_framework'
  | 'persona_set'
  | 'journey_map';

interface AdvancedEditorialPresentationUnitBaseV2
  extends Omit<EditorialPresentationUnitBase, 'semanticKind'> {
  semanticKind: AdvancedEditorialSemanticKindV2;
}

type AdvancedEditorialPresentationUnitV2 =
  | (AdvancedEditorialPresentationUnitBaseV2 & {
      shape: 'sequenced_plan';
      stages: Array<{ id: string; leafId: string; label: string; timebox?: string }>;
      lanes: Array<{ id: string; leafId: string; label: string }>;
      items: Array<{
        id: string;
        leafId: string;
        stageId: string;
        laneId?: string;
        title: string;
        description?: string;
        owner?: string;
      }>;
    })
  | (AdvancedEditorialPresentationUnitBaseV2 & {
      shape: 'metric_framework';
      groups: Array<{
        id: string;
        leafId: string;
        label: string;
        metrics: Array<{
          id: string;
          leafId: string;
          label: string;
          role: 'north_star' | 'core' | 'guardrail' | 'diagnostic';
          definition: string;
          direction?: 'increase' | 'decrease' | 'maintain' | 'informational';
          unit?: string;
          collectionMethod?: string;
          cadence?: string;
          owner?: string;
          baseline?: { value: number; leafId: string };
          target?: { value: number; leafId: string };
        }>;
      }>;
    })
  | (AdvancedEditorialPresentationUnitBaseV2 & {
      shape: 'persona_set';
      personas: Array<{
        id: string;
        name: { leafId: string; text: string };
        summary: { leafId: string; text: string };
        values: Array<{
          id: string;
          leafId: string;
          kind: 'tag' | 'behavior' | 'need' | 'pain_point' | 'recommendation' | 'quote';
          text: string;
          quoteMode?: 'synthesized';
        }>;
      }>;
    })
  | (AdvancedEditorialPresentationUnitBaseV2 & {
      shape: 'journey_map';
      scenarios: Array<{ id: string; leafId: string; label: string }>;
      stages: Array<{ id: string; leafId: string; label: string }>;
      dimensions: Array<{ id: string; leafId: string; label: string }>;
      cells: Array<{
        id: string;
        leafId: string;
        scenarioId: string;
        stageId: string;
        dimensionId: string;
        text: string;
      }>;
      emotions: Array<{
        id: string;
        leafId: string;
        scenarioId: string;
        stageId: string;
        level: 1 | 2 | 3 | 4 | 5 | null;
        note?: string;
      }>;
    });

type ReportEditorialPresentationUnitV2 =
  | ReportEditorialPresentationUnitV1
  | AdvancedEditorialPresentationUnitV2;

interface ReportEditorialMaterialV2
  extends Omit<ReportEditorialMaterialV1, 'version' | 'presentationUnits' | 'constraints'> {
  version: 'report-editorial-material-v2';
  presentationUnits: ReportEditorialPresentationUnitV2[];
  constraints: Omit<
    ReportEditorialMaterialV1['constraints'],
    'allowedViews' | 'projectionProfilesByUnitId'
  > & {
    allowedViews: ReportViewIdV2[];
    projectionProfilesByUnitId: Record<string, ReportPresentationV2[]>;
  };
}

interface ReportEditorialBlueprintV2 {
  version: 'report-editorial-blueprint-v2';
  style: ReportEditorialBlueprintV1['style'];
  density: ReportEditorialBlueprintV1['density'];
  sections: Array<{
    headingMode: 'view_label' | 'first_source_title';
    view: ReportViewIdV2;
    prominence: 'primary' | 'supporting' | 'appendix';
    blocks: Array<{
      presentation: ReportPresentationV2;
      unitRefs: string[];
      visibility: 'always' | 'collapsible';
      variant?: ReportPresentationVariantV2;
    }>;
  }>;
}
```

`variant` 必须按 presentation 校验合法组合；生产 Schema 为每个 presentation 使用 discriminated union，不能让任意 variant 穿透。

#### C2：Canonical v3 类型

新增四个 discriminated block，不允许用开放 JSON 或带前缀字符串代替：

```ts
type AdvancedContentBlock =
  | SequencedPlanBlock
  | MetricFrameworkBlock
  | PersonaSetBlock
  | JourneyMapBlock;

interface SequencedPlanBlock {
  kind: 'sequenced_plan';
  stages: Array<{
    key: string;
    label: string;
    timebox?: string;
    support: ResearchStrategySupportBindingV2;
  }>;
  lanes?: Array<{
    key: string;
    label: string;
    support: ResearchStrategySupportBindingV2;
  }>;
  items: Array<{
    key: string;
    stageKey: string;
    laneKey?: string;
    title: string;
    description?: string;
    ownerType?: string;
    support: ResearchStrategySupportBindingV2;
  }>;
}

interface MetricFrameworkBlock {
  kind: 'metric_framework';
  groups: Array<{
    key: string;
    label: string;
    support: ResearchStrategySupportBindingV2;
    metrics: Array<{
      key: string;
      label: string;
      role: 'north_star' | 'core' | 'guardrail' | 'diagnostic';
      definition: string;
      direction?: 'increase' | 'decrease' | 'maintain' | 'informational';
      unit?: string;
      collectionMethod?: string;
      cadence?: string;
      ownerType?: string;
      baseline?: { value: number; support: ResearchStrategySupportBindingV2 };
      target?: { value: number; support: ResearchStrategySupportBindingV2 };
      support: ResearchStrategySupportBindingV2;
    }>;
  }>;
}

interface SupportedTextValueV3 {
  key: string;
  text: string;
  support: ResearchStrategySupportBindingV2;
}

interface PersonaSetBlock {
  kind: 'persona_set';
  personas: Array<{
    key: string;
    name: SupportedTextValueV3;
    summary: SupportedTextValueV3;
    tags: SupportedTextValueV3[];
    behaviors: SupportedTextValueV3[];
    needs: SupportedTextValueV3[];
    painPoints: SupportedTextValueV3[];
    recommendations: SupportedTextValueV3[];
    quotes: Array<SupportedTextValueV3 & { mode: 'synthesized' }>;
  }>;
}

interface JourneyMapBlock {
  kind: 'journey_map';
  scenarios: Array<{ key: string; label: string; support: ResearchStrategySupportBindingV2 }>;
  stages: Array<{ key: string; label: string; support: ResearchStrategySupportBindingV2 }>;
  dimensions: Array<{ key: string; label: string; support: ResearchStrategySupportBindingV2 }>;
  cells: Array<{
    key: string;
    scenarioKey: string;
    stageKey: string;
    dimensionKey: string;
    text: string;
    support: ResearchStrategySupportBindingV2;
  }>;
  emotions: Array<{
    key: string;
    scenarioKey: string;
    stageKey: string;
    level: 1 | 2 | 3 | 4 | 5 | null;
    note?: string;
    support: ResearchStrategySupportBindingV2;
  }>;
}
```

Persona quote 在 Canonical v3 首版只允许 `synthesized`，并必须保留该标记；`verbatim` 需要独立、机器可验证且与发布范围绑定的授权合同，未定义该合同时 Schema 直接拒绝，不能只凭 Evidence/support 推定可发布。Canonical v3 首版不承载人口属性或 Persona 照片：批准的照片继续走 Milestone B 的 Asset binding，其他敏感属性另行版本化，避免在没有授权合同的情况下扩大 Schema。Journey emotion 无证据时必须 `level=null` 并保留 provisional support/validationNeeded，不能补画连续曲线。

Stage、lane、metric group、Persona 字段、Journey stage/dimension/cell/emotion 等所有可见 nested unit 都必须拥有独立 support 和 leaf；不能只给父 Block 一个 support 后让子项继承。只有纯编号、排序索引和由数组位置确定的布局值可以标记为 `system_derived`。

规则：

- `research_plan.executionPlan` 已有 phase/duration，可生成顺序型 Roadmap；策略报告必须先有 `sequenced_plan`；
- Swimlane 必须同时存在显式 `stageKey + laneKey + item`，不得只根据 `ownerType` 分 lane；
- 时间文本只原样显示，不解析成日期或甘特坐标；
- Metric Group 表达指标定义体系；无观测值时可以展示口径，不能生成数值 metric/chart；
- baseline、target、series 只有存在类型化数值和 Evidence 时才能显示；
- Journey Skill 当前自带 HTML 不是正式输入，只接受通过 Schema、Adapter、Step 10 和 Review 的结构数据。

#### C3：ReportDocument v4

新增 `roadmap`、`swimlane`、`metric-group`、`persona-set`、`journey-map`。合同骨架如下；所有可见 nested value 都必须有 leafRef：

```ts
interface ReportRoadmapBlockV4 extends ReportBlockBase {
  type: 'roadmap';
  stages: Array<{
    id: string;
    leafRef: string;
    label: string;
    timebox?: string;
    items: Array<{ id: string; leafRef: string; title: string; description?: string; owner?: string }>;
  }>;
}

interface ReportSwimlaneBlockV4 extends ReportBlockBase {
  type: 'swimlane';
  stages: Array<{ id: string; leafRef: string; label: string; timebox?: string }>;
  lanes: Array<{ id: string; leafRef: string; label: string }>;
  items: Array<{
    id: string;
    leafRef: string;
    stageId: string;
    laneId: string;
    title: string;
    description?: string;
    owner?: string;
  }>;
}

interface ReportMetricGroupBlockV4 extends ReportBlockBase {
  type: 'metric-group';
  groups: Array<{
    id: string;
    leafRef: string;
    label: string;
    metrics: Array<{
      id: string;
      leafRef: string;
      label: string;
      role: 'north_star' | 'core' | 'guardrail' | 'diagnostic';
      definition: string;
      direction?: 'increase' | 'decrease' | 'maintain' | 'informational';
      unit?: string;
      collectionMethod?: string;
      cadence?: string;
      owner?: string;
      baseline?: { value: number; leafRef: string };
      target?: { value: number; leafRef: string };
    }>;
  }>;
}

interface ReportPersonaSetBlockV4 extends ReportBlockBase {
  type: 'persona-set';
  personas: Array<{
    id: string;
    name: { leafRef: string; text: string };
    summary: { leafRef: string; text: string };
    values: Array<{
      id: string;
      leafRef: string;
      kind: 'tag' | 'behavior' | 'need' | 'pain_point' | 'recommendation' | 'quote';
      text: string;
      quoteMode?: 'synthesized';
    }>;
  }>;
}

interface ReportJourneyMapBlockV4 extends ReportBlockBase {
  type: 'journey-map';
  scenarios: Array<{ id: string; leafRef: string; label: string }>;
  stages: Array<{ id: string; leafRef: string; label: string }>;
  dimensions: Array<{ id: string; leafRef: string; label: string }>;
  cells: Array<{
    id: string;
    leafRef: string;
    scenarioId: string;
    stageId: string;
    dimensionId: string;
    text: string;
  }>;
  emotions: Array<{
    id: string;
    leafRef: string;
    scenarioId: string;
    stageId: string;
    level: 1 | 2 | 3 | 4 | 5 | null;
    note?: string;
  }>;
}

type ReportBlockV4 =
  | ReportBlockV3
  | ReportRoadmapBlockV4
  | ReportSwimlaneBlockV4
  | ReportMetricGroupBlockV4
  | ReportPersonaSetBlockV4
  | ReportJourneyMapBlockV4;

interface ReportSectionV4 extends Omit<ReportSectionV3, 'view' | 'blocks'> {
  view: ReportViewIdV2;
  blocks: ReportBlockV4[];
}

interface ReportDocumentV4 extends Omit<ReportDocumentV3, 'version' | 'sections'> {
  version: 'report-document-v4';
  displayPresets: ReportDisplayPresetIdV1[];
  sections: ReportSectionV4[];
}
```

`ReportViewIdV2` 仍是 Section 的唯一拥有型分类；`full_report` 和 `management_summary` 是文档级、非拥有型显示 preset，不能进入 Blueprint 的 `section.view`。`full_report` 显示全部 Section；`management_summary` 只显示 `prominence='primary'` 的 Section，但不创建、复制或重新归属任何 Block/leaf。Projector/Validator 必须保证 risk、limitation 以及 `provisional/unanswered` 单元所在 Section 为 `primary`；否则禁止发布 `management_summary` preset，避免摘要视图隐藏决策边界。Standalone HTML 和 Web 可提供 preset 切换，Markdown/Zero/打印默认导出 `full_report`；所有语义 Manifest 始终按完整 Document 计算，不能因当前屏幕 preset 隐藏内容而缩小。

同一 metric 的 definition、baseline、target 可以有不同 leafRef；不能用定义的 Evidence 替数值背书。含非空 lanes 的 `sequenced_plan` 只允许投影为 Swimlane 或保留 lane 列的 record-table，不允许选择会丢 lane membership 的 Roadmap；无 lanes 的 source 才允许 Roadmap。Swimlane 首版不支持依赖箭头；若以后新增 connector，每条 connector 必须有独立 leaf/support 并再次升级合同。

关键字段必须逐层原样传递，不能由 Renderer 重建或从相邻字段推断：

| Canonical v3 | Material v2 | ReportDocument v4 | 无损约束 |
|---|---|---|---|
| `stage.timebox` | `stage.timebox` | Roadmap/Swimlane `stage.timebox` | 保留原字符串；缺失与空值按 Schema 区分，不解析日期 |
| `item.laneKey` | `item.laneId` | Swimlane `item.laneId` 或 record-table lane 列 | 必须解析到同一 unit 内已声明 lane；有 lane 时不得投影为 Roadmap |
| `item.ownerType` | `item.owner` | Roadmap/Swimlane `item.owner` | 只做字段名映射，值逐字相等；不能用 owner 推断 lane |
| `metric.baseline/target.value + support` | `baseline/target.value + leafId` | `baseline/target.value + leafRef` | 数值、单位和各自 Evidence 分开验证，不得复用 definition leaf |
| Persona quote `mode='synthesized'` | `quoteMode='synthesized'` | `quoteMode='synthesized'` | quote 项必须带 mode，非 quote 项禁止带；`verbatim` 在本版本 fail closed |
| Journey emotion `level` | `level` | `level` | `null` 是显式“无证据值”，不得省略、插值或改成中性分数 |

Material Builder、Projector、线性降级和四端 visitor 都必须覆盖这张映射表；任何字段缺失、非法重命名或值变化都使 composition fail closed。字段所属 nested record 的 leaf 必须指向包含该字段的精确 source pointer；baseline/target 继续使用各自独立 leaf。

| v4 Block | 资格条件 | 确定性线性降级 |
|---|---|---|
| roadmap | 显式有序 stage 与 item placement | 按 stage 分组的 record-table |
| swimlane | 显式 stage、lane 和 item membership | stage/lane 两列的 record-table |
| metric-group | 显式 group 与 metric definition | 按 group 分节的 record-table |
| persona-set | 通过 Review 的结构化 Persona | Persona record-table/cards |
| journey-map | 显式 scenario/stage/dimension/cell | 每个 scenario 的阶段×维度表；emotion 单列 |

降级仍生成 v4 并保留全部 leaf；不能退回会忽略新 Canonical 单元的 v3。

#### C4：实现顺序

1. 盘点真实 Persona、Journey、Metric 与 Action Plan Payload，新增 ADR 并冻结 typed schemas；
2. 先发布 ResearchTask v3、Demand Graph v2、Execution Plan v4、Contribution v2、Canonical v3、Material/Blueprint v2 和 ReportDocument v4 Readers，Writer 全关；
3. 按 `ResearchTask → Demand Graph → Execution Plan → Contribution` 顺序开启新控制面 Writer，再上线 typed Contribution Adapter、Cross-Skill Fidelity、Canonical v3 assembler/patch/review；
4. 上线确定性 v4 Projector、共享 visitor 和五种 Block 的四端 Renderer；
5. 最后允许 Planner v2 在兼容 presentation 中选择；失败仍使用完整 deterministic v4；
6. 按 Block canary：Roadmap/Metric Group → Persona/Journey → Swimlane。

新增重点文件：

```text
schemas/research-task-v3.schema.json
schemas/capability-demand-graph-v2.schema.json
schemas/current-execution-plan-v4.schema.json
schemas/research-contribution-v2.schema.json
schemas/research-contribution-bundle-v2.schema.json
schemas/skills/persona-contribution-v1.schema.json
schemas/skills/journey-map-contribution-v1.schema.json
schemas/skills/experience-metrics-contribution-v1.schema.json
schemas/skills/research-strategy-content-draft-v3.schema.json
schemas/skills/research-strategy-content-patch-v2.schema.json
schemas/deliverables/research-strategy-report-v3.schema.json
schemas/report-document-v4.schema.json
apps/orchestrator-runtime/src/skills/typed-research-contribution-adapters.ts
```

主要修改范围：`packages/api-contract/plan.ts`、`research-deliverable.ts`、Skill/Deliverable Registry、三个相关 Skill execution contract、Synthesis、Contribution Adapter、coverage/fidelity/patch/assembler/final review、Material/Planner/Projector、共享 visitor、四个 Renderer 和 Package Reader。

失败与回滚：required typed output/Adapter 失败则阻断 Canonical，optional 则记 gap；不允许退回字符串猜结构。Canonical v3 或 Final Review 失败时不生成 ReportDocument；Blueprint 失败时使用 deterministic v4；单个 Renderer 失败只影响该出口，并在其所属 Package、Publication Artifact 或同步 API/UI 边界返回状态。回滚分别关闭 `canonical_v3_writer`、`report_v4_writer` 或单 Block 开关，Reader 永久保留，不 downcast 已封存 Artifact。

Milestone C DoD：

- 只有明确 stage 才生成 Roadmap；自然语言中的“第一阶段/Q3/下周”不会触发；
- 只有明确 lane membership 才生成 Swimlane；`ownerType` 单独存在不会触发；
- proposed metric 不会被显示成 observed value 或 Chart；
- Persona 合成语录有明确标记，未经授权的照片/人口属性不进入报告；
- Journey 每个 cell/emotion point 可回溯，无证据不补情绪值；
- nested unit 的 patch、review target、ledger、fidelity 和 coverage 全覆盖；
- 五种 Block 四端 Manifest 等价，移动端、打印和无障碍线性表示完整；
- ResearchTask v2、Demand Graph v1、Execution Plan v2/v3、Contribution v1、Canonical v1/v2 与 ReportDocument v1/v2/v3 回归不变；
- Roadmap、明确 lane、指标体系、Persona、Journey 各至少一个真实 Golden，并有自然语言误提升的负向 Golden。

### 19.4 Milestone D：全 Deliverable 复用

状态：历史 backlog，当前只执行 19.A 的最小 `research_plan` Adapter；其余 Deliverable 不在本轮范围。下列完整迁移设计不构成 A-experience 前置。

目标：让同一报告平台覆盖所有正式 Deliverable，但不设计可执行任意 JSON 路径的映射 DSL，也不为案例写 Renderer 分支。

新增小型显式接口：

```ts
type DeliverableEditorialPipeline = 'v1' | 'v2';

type MaterialByPipeline = {
  v1: ReportEditorialMaterialV1;
  v2: ReportEditorialMaterialV2;
};

interface VerifiedArtifactValue<TValue> {
  artifactId: string;
  schemaVersion: string;
  contentSha256: string;
  value: TValue;
}

type VerifiedDeliverableInput<
  TPayloadByVersion extends Record<string, unknown>,
> = {
  [TVersion in Extract<keyof TPayloadByVersion, string>]: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    deliverableId: string;
    payloadVersion: TVersion;
    deliverable: VerifiedArtifactValue<TPayloadByVersion[TVersion]>;
    reportReview: VerifiedArtifactValue<PassedReportReviewArtifact>;
  };
}[Extract<keyof TPayloadByVersion, string>];

type NonMediaPresentationUnit<TUnit> = TUnit extends {
  shape: 'asset' | 'asset_pair' | 'chart';
} ? never : TUnit;

type AdapterMaterialSliceByPipeline = {
  [TPipeline in keyof MaterialByPipeline]: {
    document: MaterialByPipeline[TPipeline]['document'];
    presentationUnits: Array<NonMediaPresentationUnit<
      MaterialByPipeline[TPipeline]['presentationUnits'][number]
    >>;
    leafTraceIndex: MaterialByPipeline[TPipeline]['leafTraceIndex'];
    requiredQuestionIds: string[];
  };
};

interface DeliverableEditorialAdapterV1<
  TPipeline extends DeliverableEditorialPipeline,
  TPayloadByVersion extends Record<string, unknown>,
> {
  readonly adapterId: string;
  readonly pipeline: TPipeline;
  readonly deliverableId: string;
  readonly supportedPayloadVersions: readonly Extract<keyof TPayloadByVersion, string>[];
  extract(
    input: VerifiedDeliverableInput<TPayloadByVersion>,
  ): AdapterMaterialSliceByPipeline[TPipeline];
}

type DeliverableEditorialProfileV1 =
  | {
      pipeline: 'v1';
      deliverableId: string;
      adapterId: string;
      materialVersion: 'report-editorial-material-v1';
      blueprintVersion: 'report-editorial-blueprint-v1';
      reportDocumentVersion: 'report-document-v3';
      allowedViews: readonly ReportViewIdV1[];
      allowedPresentations: readonly ReportPresentationV1[];
      writerEnabled: boolean;
    }
  | {
      pipeline: 'v2';
      deliverableId: string;
      adapterId: string;
      materialVersion: 'report-editorial-material-v2';
      blueprintVersion: 'report-editorial-blueprint-v2';
      reportDocumentVersion: 'report-document-v4';
      allowedViews: readonly ReportViewIdV2[];
      allowedDisplayPresets: readonly ReportDisplayPresetIdV1[];
      allowedPresentations: readonly ReportPresentationV2[];
      writerEnabled: boolean;
    };
```

`TPayloadByVersion` 由每个 Deliverable 的已注册 Payload Schema 显式声明，`VerifiedDeliverableInput` 只能由统一的 Artifact/hash/binding/Schema/Final Review 门禁构造，Adapter 不接收未验证 `unknown` Payload。Adapter 是无 I/O 的 Deliverable-specific extractor，只返回 `AdapterMaterialSliceByPipeline[TPipeline]` 中的正文、presentation unit、leaf trace 和必答问题；它不能读取或构造 Asset/Chart，也不能自行拼装 Material binding/constraints。中央 `ReportEditorialMaterialBuilder` 校验 Review 与 Deliverable 的 Task/Plan/Attempt/Artifact/hash 绑定，解析 Evidence/Visual/Chart，注入 Profile 的 view/presentation 约束并最终返回 `MaterialByPipeline[TPipeline]`。这样既保持 pipeline 的编译期绑定，又不会让每个 Adapter 复制媒体、Evidence 和安全门禁。

Registry 只声明版本、Adapter ID、视图和能力开关；字段读取、Trace 粒度与覆盖规则留在有类型和测试的 Adapter 代码中。启动时的 Registry linter 必须验证：`adapterId` 全局唯一、每个启用的 `deliverableId` 只有一个 Writer Profile、Profile 引用的 Adapter 存在且 `deliverableId/pipeline` 相同、`supportedPayloadVersions` 无重复且全部存在已注册 Schema、pipeline 对应的 Material/Blueprint/ReportDocument 版本元组完全匹配、`allowedViews/allowedPresentations/allowedDisplayPresets` 均属于该 pipeline 的封闭 union。任一不满足时拒绝启动该 Profile，不做字符串兜底。支持同一 Deliverable 的新案例无需增加 Adapter；新增 Deliverable 类型需要新增一个显式 Adapter，不能声称只改 Registry。

垂直迁移顺序：

| 子阶段 | Deliverable | Pipeline | 首选结构与特殊门禁 |
|---|---|---|---|
| D1 | `competitive_analysis_report` | v1 | matrix、Chart、视觉证据；出现 P3 时用 Table，不强塞 P0–P2 Board |
| D2 | `design_audit_report` | v1 | 按 issueId 连接问题、严重度、整改和 annotation pair |
| D3 | `voc_diagnosis_report` | v1 | 按 themeId 连接频率、情感、严重度、优先级和已有发布授权的引语 |
| D4 | `accessibility_audit_report` | v1 | 按 issueId 连接组件、准则、优先级、整改与验证 |
| D5 | `research_plan` | v2 | Section 只使用 `plan | findings` 等 v2 view；启用 `full_report | management_summary` 文档 preset；executionPlan 可投影 Roadmap，无明确 stage 时降级为 Table |

D1–D4 只依赖 Milestone A/B，可在高级结构 Writer 未开启时独立迁移；D5 明确依赖 Milestone C 的 v2 Reader 与 Roadmap 合同。不能为了让 D5 提前上线而把 `full_report/management_summary` 塞进 `ReportViewIdV1`，也不能用任意字符串绕开视图校验。

D3 的逐字引语只有在受审 Payload 同时提供 `publicationAuthorizationArtifactId`、`publicationAuthorizationContentSha256` 和 `publicationScope='report_publication'`，且中央 Builder 验证授权 Artifact 与当前 owner/Task/Attempt 绑定后才可成为可见 leaf；缺失、过期或范围不符时只保留不含原话的受审主题结论，不把 Evidence/support 当作发布授权。

每个子阶段遵循 reader → deterministic adapter/projector → 四端 → Planner canary 的顺序，并有独立 feature flag、Golden 和回滚。某个 Adapter 失败只影响该 Deliverable 的新流程：Writer 关闭或 Adapter/新 presentation 在提交前失败时，继续走已验证的原报告路径并显示 `editorial_adapter_fallback` Notice；不能静默声称新格式成功。只有源 Artifact/hash/Final Review 本身无效，或 deterministic 旧路径也无法覆盖必需内容时才硬阻断。

主要文件：新增 `packages/api-contract/deliverable-editorial-profile.ts`、`apps/orchestrator-runtime/src/report/deliverable-editorial-adapter-registry.ts` 及每个 Deliverable 的 Adapter/test；修改 Deliverable Registry、composition、Package Reader、System Capabilities 和四端路由。共享 Renderer 不出现 Deliverable/case 名称分支。

Milestone D DoD：

- 五个 Deliverable 各自有严格 payload version、pointer coverage 和 leaf Trace；
- Adapter 的 pipeline/输出 slice、中央 Builder 返回的 Material 与 Profile 的 Material/Blueprint/ReportDocument 版本元组在编译期和 Registry 启动校验中一致；
- v1/v2 Profile 的 view/presentation 分别只接受 `ReportViewIdV1/ReportPresentationV1` 与 `ReportViewIdV2/ReportPresentationV2`；文档 preset 不能混入 Section view；
- 每个 Adapter 有正向/负向/历史版本 Golden；
- 每个 Deliverable 在 Web、HTML、Markdown、Zero、打印、移动端通过；
- P3、缺失字段、空列表和未知 payload version 不被错误转换；
- 新案例无需改 Renderer/CSS；
- 禁用任一 Deliverable writer 不影响其他类型。

### 19.5 Milestone E：受审 Editorial Copy

状态：已由 A-experience 的一次 Planner + 确定性 fragment 检查取代，不实施本节的独立 Copy Writer、第二 Reviewer 模型、整批回退或人工发布门禁。本节仅保留此前方案记录；不得据此创建当前代码、Schema、开关或验收条件。

目标：在不修改 Canonical、Block 正文、Evidence、数字、状态或优先级的前提下，生成报告标题、执行摘要、章节标题、导语和过渡段。Copy 是新的已审发布内容，不是 Canonical，也不是 Blueprint 字段。

准确流程：

```text
Canonical Deliverable
→ Final Report Review pass
→ Material Builder
→ Editorial Planner / deterministic Blueprint
→ Editorial Copy Request
→ Copy Writer
→ deterministic checks + independent Semantic Fidelity Review
→ pass：Projector 使用整批受审文案
  fail：Projector 使用 Canonical 原文与系统标题
→ ReportDocument
```

允许的 Slot 固定为 `report_title`、`executive_summary`、`section_title`、`section_lead`、`section_transition`。系统预先给出 `slotId`、目标、允许引用的 leafIds 和长度上限；模型不能创建 Slot，也不能修改表格 cell、Graph 节点、行动、风险或审计内容。

Slot scope 由系统确定：`section_title/section_lead` 只能引用本 Section 的 leaf；`section_transition` 只能引用相邻两个 Section 的 leaf；`executive_summary/report_title` 只能引用 primary Section 中允许摘要的 leaf。Slot Builder 和 Projector 共享同一个 deterministic Section ID helper，由已封存 Blueprint 的 ordinal 与 unitRefs 生成 `sectionId`；`slotId` 是不透明标识，任何消费者都不得从字符串或数组顺序反推目标。Risk、limitation、`provisional/unanswered` leaf 不得因摘要而被过滤掉，审计和 diagnostic leaf 永不授权给 Copy。

```ts
interface ReportEditorialCopySourceBindingV1 {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  deliverableContentSha256: string;
  reportReviewArtifactId: string;
  reportReviewContentSha256: string;
  blueprintArtifactId: string;
  blueprintContentSha256: string;
}

type ReportEditorialCopyTargetV1 =
  | { kind: 'report_title' }
  | { kind: 'executive_summary' }
  | { kind: 'section_title'; sectionId: string; sectionOrdinal: number }
  | { kind: 'section_lead'; sectionId: string; sectionOrdinal: number }
  | {
      kind: 'section_transition';
      fromSectionId: string;
      toSectionId: string;
      fromSectionOrdinal: number;
      toSectionOrdinal: number;
    };

interface ReportEditorialCopyRequestV1 {
  version: 'report-editorial-copy-request-v1';
  builderVersion: string;
  binding: ReportEditorialCopySourceBindingV1;
  slots: Array<{
    slotId: string;
    target: ReportEditorialCopyTargetV1;
    allowedLeafIds: string[];
    maxChars: number;
  }>;
}

interface ReportEditorialCopyDraftV1 {
  version: 'report-editorial-copy-draft-v1';
  binding: ReportEditorialCopySourceBindingV1 & {
    requestArtifactId: string;
    requestContentSha256: string;
    requestBuilderVersion: string;
    writerReceiptArtifactId: string;
  };
  slots: Array<{
    slotId: string;
    fragments: Array<{ text: string; sourceLeafIds: string[] }>;
  }>;
}

type ReportEditorialCopyEntailmentV1 =
  | 'entailed'
  | 'not_entailed'
  | 'uncertain';

type ReportEditorialCopyCheckCodeV1 =
  | 'slot_scope'
  | 'known_non_empty_leaf'
  | 'length_limit'
  | 'number_date_amount_ratio'
  | 'priority_and_evidence_id'
  | 'url_and_negation'
  | 'status_strength';

type ReportEditorialCopyReviewReasonCodeV1 =
  | 'fully_entailed'
  | 'source_scope_mismatch'
  | 'unsupported_claim'
  | 'causal_overreach'
  | 'scope_expansion'
  | 'qualifier_omitted'
  | 'status_strengthened';

interface ReportEditorialCopyReviewV1 {
  version: 'report-editorial-copy-review-v1';
  binding: ReportEditorialCopySourceBindingV1 & {
    requestArtifactId: string;
    requestContentSha256: string;
    draftArtifactId: string;
    draftContentSha256: string;
    writerReceiptArtifactId: string;
    reviewerReceiptArtifactId: string;
  };
  deterministicChecks: Array<{
    code: ReportEditorialCopyCheckCodeV1;
    passed: boolean;
    slotId?: string;
    fragmentIndex?: number;
  }>;
  fragmentReviews: Array<{
    slotId: string;
    fragmentIndex: number;
    verdict: ReportEditorialCopyEntailmentV1;
    reviewedSourceLeafIds: string[];
    reasonCodes: ReportEditorialCopyReviewReasonCodeV1[];
  }>;
  verdict: 'pass' | 'fail';
}
```

`ReportEditorialCopyRequestV1` 必须作为 internal SEALED Artifact 保存，确保重试时 Slot scope、长度上限和 Builder 版本不可漂移。`ReportEditorialCopyReviewV1` 同时绑定 Request、Draft、Canonical、Final Review、Blueprint 与两个独立 Receipt；`fragmentReviews` 必须与 Draft 的 `(slotId, fragmentIndex)` 集合完全相等，`reviewedSourceLeafIds` 也必须逐项等于 Draft 声明。系统而不是 Reviewer 模型计算最终 verdict：全部确定性检查为真、每个 fragment 都恰好有一个 `entailed` 结果且所有 ID/hash/binding 相等时才是 `pass`。首版不做自动修订循环，任何 `not_entailed/uncertain` 都丢弃整批 Copy。

确定性检查至少覆盖：source scope、未知/空 leaf、数字、日期、金额、比例、P0/P1/P2/P3、Evidence ID、URL、否定词、状态强度。独立 Reviewer 检查因果、范围、遗漏限定语，以及把 `provisional/unanswered` 强化成确定结论。Writer 与 Reviewer 使用独立调用和 Receipt，不共享 Writer 推理。

Milestone E 使用 `ReportDocument v5`，新增 `copyMode: 'model' | 'fallback'`、Section `lead/transition` 和已使用 Copy Slot。它同时使用新版本 Manifest，不能给既有 v1 对象偷偷加字段：

```ts
interface ReportSemanticManifestV2 extends Omit<ReportSemanticManifestV1, 'version'> {
  version: 'report-semantic-manifest-v2';
  editorialCopySlotIds: string[];
}

interface ReportRenderManifestV2 extends Omit<ReportRenderManifestV1, 'version' | 'semantics'> {
  version: 'report-render-manifest-v2';
  semantics: ReportSemanticManifestV2;
}

interface ReportEditorialCopyValueV1 {
  slotId: string;
  target: ReportEditorialCopyTargetV1;
  text: string;
  sourceLeafIds: string[];
}

interface ReportSectionV5 extends ReportSectionV4 {
  titleCopySlotId?: string;
  leadCopySlotId?: string;
  transitionToNextCopySlotId?: string;
}

interface ReportDocumentV5 extends Omit<ReportDocumentV4, 'version' | 'sections' | 'semanticManifest'> {
  version: 'report-document-v5';
  copyMode: 'model' | 'fallback';
  titleCopySlotId?: string;
  executiveSummaryCopySlotId?: string;
  sections: ReportSectionV5[];
  editorialCopy: { slots: ReportEditorialCopyValueV1[] };
  semanticManifest: ReportSemanticManifestV2;
}
```

v5 的 base 固定为 v2 pipeline 的 `ReportDocument v4`；Registry 只允许 `pipeline='v2'` 的 Deliverable Profile 开启 `report_v5_writer`。仍在 v1/v3 的 D1–D4 Profile 可以继续交付结构报告，但不能启用 Copy；如需 Copy，先将该 Profile reader-first 升到 v2/v4，即使它暂时不使用高级 Block。这样避免一个 v5 合同同时继承两套互不兼容的 Section/Block union。

`copyMode='model'` 时，每个 Copy 字段必须通过对应 `*CopySlotId` 引用 `editorialCopy.slots`，Slot target 的 sectionId/from/to 必须与实际继承的 `ReportSectionV4.id` 完全一致，最终可见文本逐字等于受审 Draft。`section_transition` 固定挂在 `fromSectionId` 对应 Section 的 `transitionToNextCopySlotId`，且 `toSectionId` 必须是紧邻的下一节；末节不得拥有 transition。文档中所有 Copy 字段引用的 Slot ID 集、`editorialCopy.slots[].slotId` 集和 `semanticManifest.editorialCopySlotIds` 集必须完全相等且唯一。`copyMode='fallback'` 时 `editorialCopy.slots=[]`、Manifest Copy 集为空、所有 `*CopySlotId` 均缺失，标题和摘要完全来自确定性字段；若模型原本应执行但失败或被策略拒绝，增加 `copy_fallback` 或 `data_policy_fallback` 的 `info` Notice，明确正文仍为受审原文。Projector 只接受 Draft hash 与 pass Review 完全匹配的组合；四端只渲染 ReportDocument，不自行应用 Overlay，并从实际渲染的 Copy Slot 生成 `ReportRenderManifestV2`。

新增 `report-package-v3`；不能向严格的 Package v2 静默加字段：

```ts
type CopyFallbackReasonCode =
  | 'copy_disabled'
  | 'data_policy_denied'
  | 'copy_budget_exceeded'
  | 'writer_failure'
  | 'invalid_copy_draft'
  | 'fidelity_review_failed';

interface ReportPackageV3 extends Omit<ReportPackageV2, 'version'> {
  version: 'report-package-v3';
  sourceReportDocumentVersion: 'report-document-v5';
  copy:
    | {
        mode: 'model';
        requestArtifactId: string;
        requestContentSha256: string;
        draftArtifactId: string;
        draftContentSha256: string;
        reviewArtifactId: string;
        reviewContentSha256: string;
      }
    | { mode: 'fallback'; reasonCode: CopyFallbackReasonCode };
}
```

只有 `copy.mode='model'` 才发布同一链路上 hash 匹配的 Request/Draft/Review 引用；失败 Draft、拒绝结果和 Receipt 留在 internal 诊断链，不作为可见 Copy 组件发布。

实现顺序：

1. 新 ADR 明确对 ADR-0005“布局模型不得重新总结全文”的窄范围修订，并澄清 ADR-0007：Canonical 仍是唯一分析事实源，Review 通过的 Copy 只是可发布表达层；
2. 发布 Copy Request/Draft/Review、Semantic/Render Manifest v2、ReportDocument v5 和 Package v3 Reader，Writer 关闭；
3. 开启 `report_v5_writer`，在 `editorial_copy_model` 关闭时先验证 v5 deterministic fallback；
4. 上线 Slot Builder、Writer、确定性检查和独立 Fidelity Reviewer；
5. 开启 `editorial_copy_model`，上线 Projector/Package/四端 Manifest，并在三个 Golden 上 canary；
6. 只有事实漂移、安全泄漏和状态强化均为零，且按第 12.1 节轻量协议评定可读性不低于 fallback，才默认开启；平局可进入 canary，不增加逐报告人工审批。

新增重点文件：`packages/api-contract/report-editorial-copy.ts`、Copy Request/Draft/Review 三份 Schema、`schemas/report-document-v5.schema.json`、`schemas/report-semantic-manifest-v2.schema.json`、`schemas/report-render-manifest-v2.schema.json`、`schemas/report-package-v3.schema.json`、`report-editorial-copy-service.ts`、`report-editorial-copy-fidelity.ts` 及测试；修改 composition、ReportDocument/Package、lease/recovery、数据库 Artifact 终态检查、四端 Renderer 和 Manifest。

失败与回滚：模型关闭、预算超限、数据策略拒绝、Writer/Reviewer 失败、非法 Schema、越界引用或 Review 非 pass 均安全降级为 Canonical 标题/`executiveAnswer`、系统 view label，且无 lead/transition；已选 Blueprint 继续有效。用户取消、lease lost 或任一 Artifact/hash/binding 不一致必须中止而非降级。关闭 `editorial_copy_model` 只关闭模型文案并继续写 deterministic v5；若 v5 合同本身故障，再关闭 `report_v5_writer` 回到该 v2 Profile 的 v4。Reader 和历史 Artifact 保留。

Milestone E DoD：

- 100% 模型文案有合法且在 Slot scope 内的 leaf 引用；
- 每个发布 Copy 都能回溯到不可变 Request 的 Builder 版本、Slot scope 和 hash；
- 未通过 Copy Review 的文本进入 ReportDocument 的次数为 0；
- 文案故障 100% 生成完整确定性报告；
- Reader 验证发布文案逐字等于受审 Draft；
- 四端 `editorialCopySlotIds` 完全一致；
- 三个非同构 Golden 中事实漂移、安全泄漏、状态强化均为 0，且盲评可读性不低于 fallback；
- Copy 新 Artifact 纳入取消、worker-loss、重试残留和终态失效测试。

### 19.6 Milestone F：主动视觉生产（独立上游扩展）

状态：延后。它不是当前新旧 HTML 阅读体验差距的主要原因，A-experience 不启动联网取图或通用 Chart Producer。

F 不属于“把已有素材加工成 HTML”的必要条件。只有产品承诺“系统主动找图/产图”时才需要启用；关闭 F 不影响 A–E。

F1 不重新实现浏览器基础设施。`docs/plans/2026-08-19-playwright-visual-evidence-pipeline-development.md` 是网页截图 Tool、sidecar、`visual-asset-manifest-v2`、Screenshot Evidence、发布事务与安全边界的开发真相源；对应 TodoList 已完成代码工作包 A–D，但生产激活门禁和回滚演练尚未完成。本文只负责该能力进入新通用报告链后的 Profile、Material 和 Renderer 接口。实现必须同时满足两份文档；若同一字段或失败语义出现冲突，保持相关 Writer/Tool 关闭，先修改 ADR/方案并重新评审，开发者不得现场猜测优先级。

#### F1：受控网页截图

固定输入/输出合同：

- 输入只能是冻结 Plan 中从已验证 Search Artifact 精确绑定的公开 URL；Planner、Skill 和 Renderer 都不能手写或改写 URL；
- Tool 固定为 `playwright-page-capture-v1`，输出 Tool JSON 与内存 media sidecar；VisualAssetService 将二者原子封存为 Binary Artifact、`visual-asset-manifest-v2` 和 screenshot Evidence；
- 每张图保存 requested/final URL、页面标题、`capturedAt`、viewport、capture mode、字节/content hash 和 Evidence；登录态、Cookie、页面 HTML、请求头与浏览器日志不得进入 Artifact；
- 新通用报告只通过 Milestone B 的 verified Asset inventory 消费截图；F1 不向 ReportDocument、HTML 或 Copy Writer 增加第二条图片读取路径。

开发与激活顺序：

1. 先以 2026-08-19 TodoList 的已完成工作包和当前回归为代码基线，保持 Registry `draft`、`PLAYWRIGHT_CAPTURE_ENABLED` 未设置；
2. 平台负责人提交非 root、Chromium sandbox、IPv4/IPv6 私网与云元数据阻断、受保护 egress 的运行证据；缺任一项时停在 `draft`，不影响 A–E；
3. 在受保护 canary 中同时设置 Registry `playwright-page-capture=active` 与 `PLAYWRIGHT_CAPTURE_ENABLED=1`，重启所有加载 Registry/ToolRouter 的进程；只执行既有 `competitive-ai-shopping-assistant` 真实 Smoke；
4. Smoke、图片支持相邻结论的人工复核和回滚演练通过后，才允许其他 Skill/Profile 逐个声明该 optional Tool；每次扩展都必须新增该 Profile 的 Plan binding、Evidence、gap 和 Golden，不能启用“所有任务自动截图”；
5. 新 Profile 的 Required Demand 只有在用户明确要求视觉证据时才允许冻结；默认始终 optional。optional 失败记录稳定 gap 并继续文本报告，required 失败阻断；未请求且无合格图片时不制造 gap。

新增通用报告接入的文件范围限定为 `orchestrator/skill-registry.yaml`、对应 `knowledge-base/skills/*/SKILL.md` 与 `orchestrator/skill-executions/*.yaml`、`apps/orchestrator-runtime/src/planners/capability-demand-graph.ts`、`capability-portfolio-resolver.ts`、`plan-compiler.ts`、对应 Registry/Plan/Evidence 测试和 `scripts/current-real-smoke.ts` fixture；Browser Adapter、VisualAssetService 或 Manifest 合同若无需新安全语义不得复制或分叉。F1 的回滚固定为 Registry 恢复 `draft`、取消 `PLAYWRIGHT_CAPTURE_ENABLED`、重启相同 runtime；V2 Reader 与历史 Artifact 永久保留。

#### F2：通用 Chart Producer

新增 `generic-chart-data-v1`，不能把当前 `competitive-weight-chart-data-v1` 当成通用合同。首版只支持现有 `ChartSpec v1` 能无歧义表达的 comparison/bar 与 trend/line，不新增双轴、饼图、面积堆叠、预测线或自动聚合。

```ts
interface GenericChartDataV1 {
  version: 'generic-chart-data-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  deliverableContentSha256: string;
  evidenceManifestArtifactId: string;
  evidenceManifestContentSha256: string;
  chartId: string;
  chartType: 'comparison' | 'trend';
  title: string;
  unit: string;
  categories: Array<{ key: string; label: string }>;
  series: Array<{
    key: string;
    label: string;
    valueClass: 'observed' | 'baseline' | 'target';
    points: Array<{
      categoryKey: string;
      value: number | null;
      evidenceIds: string[];
      canonicalLeafIds: string[];
      canonicalJsonPointers: string[];
    }>;
  }>;
}
```

合同不变量：category key 和 series key 各自唯一；每个 series 对每个 category 恰有一个 point 且顺序一致；所有 series 使用同一 `unit`；非空值必须是有限数，并至少绑定一个可解析、值相等的 Evidence、Canonical leaf 和精确 JSON pointer；`null` point 的三个引用数组必须为空。`baseline/target` 必须保留 `valueClass`，不得伪装成 observed；不同单位、无法确定顺序、少于两个非空点或 source pointer 不可验证时不生产 Chart。LLM 不参与取数、聚合、排序、单位转换或 ChartSpec 生成。

实现顺序：

1. 发布 `generic-chart-data-v1` Schema/Reader 和 Artifact type，`generic_chart_producer_v1` 保持关闭；
2. 为每个支持的 Canonical numeric block 编写显式 extractor，将合格数值确定性写入并 read-back 校验 SEALED Chart Data Artifact；不得递归扫描任意 JSON；
3. 由纯函数把 Chart Data 映射到既有 `ChartSpec v1` 和完整 table alternative，复用 `renderAndSealChartSvg()`、`visual-asset-manifest-v2` 的 `chart_render` 与 `ArtifactPublicationGroup`；
4. 将 Chart Data、Evidence、Spec、SVG、Manifest 纳入同一取消、lease、恢复和终态失效边界，再由 Milestone B 的 snapshot/ownership 规则进入四端；
5. 先按单一 Deliverable canary 开启 `generic_chart_producer_v1`；一个真实 comparison、一个真实 trend、混合单位拒绝和缺 Evidence 拒绝全部通过后，才扩展下一个 Profile。

主要新增文件：`schemas/generic-chart-data-v1.schema.json`、`apps/orchestrator-runtime/src/report/generic-chart-data.ts`、`tests/generic-chart-data.test.ts`、`tests/generic-chart-pipeline.test.ts`。主要修改：`packages/api-contract/research-deliverable.ts`、`packages/api-contract/control-workflow.ts`、`database/control-plane.ts`、`apps/orchestrator-runtime/src/control/artifact-store.ts`、`lease-execution-engine.ts`、`execution-recovery-service.ts`、`apps/orchestrator-runtime/src/report/report-composition-service.ts`、`chart-spec-validator.ts`、`chart-renderer.ts`、`report-package-artifact.ts`、`current-report-package-reader.ts`、Capability/Deliverable Registry、对应 Schema Registry 和 `scripts/current-real-smoke.ts`。若既有函数已满足合同，只增加调用与测试，不复制 Renderer。

无合格 numeric series 且未显式请求 Chart 时正常无图；optional 请求失败记录稳定 gap 并保留 Canonical Table/文本；required 请求缺数据或生产失败按 requested-artifact 合同阻断。Renderer 在任何 Chart Artifact 封存前不可用可降级为 Table；任一已纳入发布组或 snapshot 的 Data/Spec/SVG/Manifest/hash/binding 不一致则 fail closed，不能删图后继续声称同一报告完整。关闭 `generic_chart_producer_v1` 只停止新写入，既有 Reader、Milestone B 和历史 Chart 保留。

AI 装饰插图不并入 F。若未来需要，必须定义 `illustrative` 非证据语义、醒目披露和独立导出策略，不能伪装成研究证据。

Milestone F DoD：

- 截图工具通过网络与沙箱安全验收，所有 Asset 可回溯到 URL、Evidence 和不可变字节；
- redirect/private-IP/超限/失败页面不会被封存为有效证据；
- F1 的生产激活、逐 Profile 扩展和 Registry/环境变量回滚均有独立收据，未授权 Profile 不产生截图步骤；
- generic Chart 每个非空数值均有 Evidence，Spec/Table/SVG 三者一致；
- `valueClass`、unit、category 顺序、Canonical leaf/pointer 在 Data → Spec → Table → SVG/Manifest 链中不漂移；
- optional 失败不阻断文本报告，required 失败明确阻断；
- 关闭 capture/chart producer 后，既有 Asset Reader、Milestone B 和历史报告仍可用。

## 20. 测试矩阵

### 20.1 跨版本 Contract 与完整性

- 所有 Schema 严格拒绝未知字段；所有 Artifact 只接受同 Task/Plan/Attempt、SEALED、hash 匹配的输入；
- ReportDocument v1/v2/v3 与 A-experience v4 Reader 按其发布时间加入回归，旧 Reader 的语义不得被新 Writer 改写；历史 backlog 中尚未实现的版本号不进入当前测试矩阵；
- presentation unit exactly once，leaf 无 orphan、多 owner、未知引用或“只进 Manifest 不进正文”的幽灵覆盖；
- 每个 leaf 的 Artifact ID/hash/schema/pointer/node 组合从 Material `origins[]` 到 Report Trace 原样保留，多 Artifact 来源不串接；
- requested artifact、required question、Canonical pointer、Evidence 和 Audit record coverage 完整；
- Diagnostic reference 在所有 ReportDocument、Package、Manifest 和下载包中均不可表示；
- 取消、lease lost、worker-loss、retry 和终态失效不会留下可被当作正式结果读取的半成品 Artifact；
- 在 Blueprint、Copy、ReportDocument、HTML、Package 每个写入点注入崩溃；Recovery 后只有一个已提交 Package 可被 Reader 发现，未提交组被隔离，重试不产生第二个权威根；
- owner、跨 Task、跨 Attempt、交换 hash 和错误 schema version 全部 fail closed。

### 20.2 Milestone A：基础报告平台

- selectable ID 的合法、未知、重复、固定答案混入回归；
- matrix → record-table，cell 数和顺序不变；mind model → graph，node/edge 不丢；action → priority-board，字段不丢；
- 缺关系、缺 priority 时线性降级；超行列/节点上限时只允许 Builder 预分片为 leaf 互斥 chunk，或在单 Block 内线性降级，unit exactly-once 且 leaf 不丢；
- 512 KiB、500 presentation、5,000 leaf、64k token 预算超限 fallback；
- Planner 超时、限流、非法 JSON、越权 presentation 进入 fallback，用户取消/lease lost 向上抛出；
- `<script>`、事件属性、危险 URL、entity、路径穿越、净化后重名、UTF-8/NUL/大小限制；
- Bundle 的 Deliverable/Evidence/Review 使用 allowlist 安全投影；Diagnostic、内部路径、Receipt、blocked Asset 和未授权字段不会进入 ZIP；optional sidecar 被省略时核心 Bundle 可用且有 `export_attachment_omitted` Notice；
- 用户上传/网页 SVG 不直接进入 Material 或 ZIP；只有验证过的 `chart_render/chart_svg` 允许导出，恶意 SVG 不能借直接打开 ZIP entry 执行；
- Chromium 的 responsive、keyboard/focus/aria 和打印 smoke 作为 A-core 检查；Firefox/WebKit 自动化与 macOS Safari 抽查作为非阻断兼容信号，失败时验证保守展开模板和 Notice；
- Standalone 断网打开，CSP 生效，无脚本、无 CDN、无网络请求；
- HTML unavailable 时核心 Web/Markdown 可读，Bundle API 稳定返回 409。

### 20.A A-experience：最小验收矩阵

- Renderer：`style/density/prominence/graph.variant` 各有一个行为断言；二维矩阵、card-grid、stage-flow 在桌面、390px 和打印 smoke 中不丢内容；
- Blueprint v2：结构 + Copy 的合法输出；未知/重复 unit、错误 presentation 与漏 coverage 整份结构 fallback；
- fragment：source leaf 为空/越界、超长、新数字/日期/金额/比例、优先级、Evidence ID、URL、否定或状态强化均只回退该 fragment；其余 fragment 保留；
- 失败：provider/Schema 失败生成 deterministic v4，取消与 lease lost 不写 Artifact；不测试第二 Reviewer、人工审批或模型重试，因为这些路径不存在；
- `research_plan`：有明确 stage 的正向映射、无 stage 的线性降级、未知版本拒绝并回到旧报告路径；未审 Step 内容不得出现在 Material 或输出；
- composition-only：锁定历史输入 manifest hash，重新生成后 hash 不变；模型版与 deterministic 版的 Canonical leaf、Evidence、状态、置信度和优先级集合一致；
- 浏览器只做 Chromium 桌面/390px/打印三项 smoke；不把 Firefox/WebKit/Safari、50-task canary、全库无失败或像素级截图一致设为本轮阻断条件。
- `data_policy_denied`、Planner 失败和富结构线性化分别生成受控 Notice；未请求且无媒体、模型默认关闭时不生成噪声提示。

### 20.3 Milestone B：视觉素材

- 显式 binding、Annotation Finding、Screenshot Evidence、Chart Evidence、无绑定/歧义五条归属路径；
- image pair 合并且不重复；`allow/mask` exactly once，`block` 为零；
- Asset/Manifest/content hash/relativePath snapshot 交换攻击失败；
- optional 候选完整性失败时被隔离并回到文本/Table；required 或已提交 snapshot 不一致只阻断对应 publication/下载；
- ChartSpec、SVG 和 table alternative 的 category、series、null、Evidence 完全一致；
- 无 Visual、单图、对比图、Chart、混合素材和全 block 六类集成路径；
- 四端从实际 traversal 生成相同 Asset/leaf 集合。

### 20.4 Milestone C：高级结构

- typed Contribution 的 Persona/Journey/Metric/Sequenced Plan Schema 与 source pointer/hash；
- generic Adapter 压平或 context-only 输出不得被误当成 typed source；
- nested unit 的 patch、Final Review target、ledger、fidelity 和 coverage；
- 只有显式 stage 才生成 Roadmap，只有显式 lane membership 才生成 Swimlane；
- `ownerType`、标题或自然语言时间词不会触发 lane/roadmap；
- timebox、lane membership、owner、baseline、target 的正向字段逐项无损，带 lanes 的 source 不允许投影为 Roadmap；
- metric definition 与 observed metric 分离，无数值不生成 Chart；
- Persona `quoteMode='synthesized'` 端到端保留，`verbatim`、敏感属性和未授权图片被 Schema/资格门禁拒绝；
- Journey cell/emotion 独立 Trace，无证据时 emotion 为 null；
- 五种 v4 Block 的四端 Manifest、打印、移动端和无障碍线性降级；
- v4 结构不合格时降级仍覆盖所有 v4 Canonical leaf，v4 Canonical 自身非法时 fail closed。

### 20.5 Milestone D：Deliverable Adapter

- 每个 Adapter 对所有支持的 payload version 做 pointer inventory 和覆盖断言；
- `competitive_analysis_report` 的 P3 不被强制转成 P0–P2 Board；
- Design/Accessibility 的 issueId、VOC 的 themeId、Research Plan 的 phase/duration 不发生串接；
- VOC 逐字引语的授权 Artifact ID/hash/scope/owner/Task/Attempt 正反向测试；无授权时不发布原话但保留主题结论；
- unknown version、空数组、可选字段缺失、重复 ID、非法 priority 的负向测试；
- 每个 Deliverable 关闭 Writer或新 Adapter 投影失败时继续走原路径并 Notice；源 Artifact/Review 无效或旧路径也丢 required 内容时才阻断；
- 共享 Renderer 和 CSS 不包含案例名或 Deliverable 特例分支。

### 20.6 Milestone E：Editorial Copy

- 未知、重复、缺失 Slot 和越界/空 sourceLeafIds；
- 新增或篡改数字、日期、金额、比例、优先级、Evidence ID、URL；
- 删除否定、扩大范围、新增因果、把 provisional/unanswered 强化为确定结论；
- `uncertain/not_entailed`、Writer/Reviewer 超时、非法 JSON 全部整批 fallback；
- 200 Slot、512 KiB request、64 KiB output、单 Slot 字符上限的边界与超限 fallback；
- Copy fallback 不改变已验证 Blueprint；取消/lease lost 不生成 fallback Artifact；
- Request/Draft/Review/Canonical/Blueprint hash 交换攻击 fail closed；
- Package 中 Request/Draft/Review 同链存在，Reader 验证最终文本逐字等于受审 Draft；
- 四端 `editorialCopySlotIds` 完全一致，无 Copy 的历史报告继续可读。

### 20.7 Milestone F：主动视觉生产

- Browser Capture 的 redirect、private IP、DNS rebinding、超时、响应/像素/文件上限、登录和验证码边界；
- 请求 URL、最终 URL、标题、时间、viewport、hash 和 screenshot Evidence 一致；
- `generic-chart-data-v1` 每个非空值都有 numeric value、unit/dimension、Evidence 和 Canonical pointer；
- Spec/Table/SVG 一致，非数字、混合单位、缺 Evidence 不生成 Chart；
- optional 失败只记 gap，required 失败阻断；关闭 Producer 后既有 Reader 不受影响。

### 20.8 真实案例 Golden

最低集合：

1. 京东众筹：Graph/Table/Priority Board，以及 C/E 完成后的 Persona/Journey/Metric Framework/受审文案；
2. 定量资料充分案例：既有 Chart、单个 observed metric、Metric Group 和 table alternative；
3. 纯叙述或证据稀疏案例：证明系统不会强造表、关系、时间线、指标或文案；
4. 带截图的设计审计：原图/标注图、问题绑定和导出策略；
5. 有明确 phase 的 Research Plan Roadmap；
6. 有明确 lane placement 的执行计划；
7. Persona 和 Journey 各一个真实 typed Skill 输出；
8. 五个非策略 Deliverable 各一个迁移 Golden。

所有适用 Golden 同时跑 deterministic 与 model 路径：Canonical/leaf fidelity 差异必须为 0。结构与 Copy 按第 12.1 节的固定样本 hash、两人盲评加争议裁决协议执行；Golden 以合同、来源覆盖、关键 DOM 和可访问线性表示为主，只对代表性 viewport 使用视觉快照。该评估只控制模型默认开关，不进入单份报告的人工审批链。

## 21. 可观测性、发布与回滚

### 21.1 诊断字段

至少记录：

```text
deliverableId / deliverablePayloadVersion
canonicalVersion / reportDocumentVersion / reportPackageVersion
adapterId / adapterVersion
layoutMode: model | fallback
layoutFallbackReasonCode
presentationUnitCount
leafUnitCount
assetCount
auditRecordCount
diagnosticReferenceCount
blueprintSectionCount
presentationCountByType
presentationCoverageCount
leafCoverageCount
standaloneHtmlBytes
referencedAssetCount
rendererVersion
sourceReportDocumentHash
reportPublicationId / reportPublicationStatus
noticeCountByCode
exportAttachmentOmittedCount
plannerProvider
plannerModel
plannerPromptTokens
plannerCompletionTokens
plannerLatencyMs
standaloneHtmlStatus: ready | unavailable
copyMode: model | mixed | fallback
copyFragmentCount / acceptedCopyFragmentCount / fallbackCopyFragmentCount
copyFallbackReasonCodes
advancedBlockCountByType
visualBindingResultCountByReason
captureStatus / chartProducerStatus
```

日志不得记录敏感正文、完整 Prompt、Copy 文本、未脱敏 Evidence 或原始页面内容。只记录稳定 ID、计数、hash、枚举 reason code、模型 Receipt 和时延。

### 21.2 发布顺序

```text
Milestone A-core
  历史 reader → v3/三个既有出口 reader（writer off）→ deterministic v3 writer
  → HTML/Package v2 reader → HTML/Package writer → 正式发布检查点

Milestone A-model
  Planner-safe input/Prompt/validator → Editorial Planner canary

A-experience（当前 P0）
  Renderer contract consumption → card-grid/stage-flow
  → Blueprint v2 + 一次 Planner + fragment checks
  → research_plan Adapter → 同素材 composition-only 验收

Milestone B
  （延后）
  Asset ownership contract → deterministic visual projector
  → 四端/Package snapshot → Deliverable canary

Milestone C
  Contribution/Canonical/Material/Blueprint/v4 reader
  → typed Skill/Adapter + Canonical v3 writer
  → deterministic v4 writer/四端 → Planner v2 → 单 Block canary

Milestone D
  一个 Deliverable Adapter/reader → deterministic writer → 四端
  → 该 Deliverable canary；完成后再迁移下一个

Milestone E
  （历史草案，已由 A-experience 取代，不执行独立 Copy/Reviewer 链）

Milestone F
  （延后）
  Tool/Schema 安全验收 → optional producer → requested-artifact gate
```

任何阶段都遵循 Reader 先于 Writer。后续 Milestone 未完成不得阻塞前序 Milestone 发布，也不得迫使前序版本保留未审半成品分支。

默认启用保护线与失败动作：

| 范围 | 默认开启条件 | 未满足时的行为 |
|---|---|---|
| Planner | 三个固定 Golden fidelity=0；轻量盲评不低于 fallback；canary fallback ≤10%、P95 ≤30s、安全错误=0 | 保持模型关闭或自动关闭，继续 deterministic Blueprint；不阻断报告 |
| A-experience | 同素材 composition-only coverage=0 差异；fragment fallback、Renderer smoke 和安全转义通过 | 保持体验开关关闭，继续 v3；不阻断已有报告 |
| Visual | Asset/leaf exactly-once；四端 Manifest 等价；block 泄漏=0 | optional 资源隔离并 Notice；已提交 snapshot 异常只阻断对应读取/下载 |
| Advanced Block | 对应 typed Canonical/Review/Renderer 全链通过；负向误提升=0 | 使用同版本 Table/List/Paragraph 线性表示并 Notice |
| Deliverable Adapter | 该类型所有支持版本覆盖；未知版本被拒绝；独立 Golden 通过 | 不开启该类型新 Writer，继续原报告路径 |
| Editorial Copy fragment | source scope 与机械漂移检查通过 | 只回退失败 fragment，继续生成其余报告 |
| Capture/Chart Producer | 网络安全和 Evidence 完整性通过；optional/required 语义验证完成 | Producer 保持关闭；optional 使用文本/Table，required 由既有需求合同报告未完成 |

### 21.3 回滚

| 故障范围 | 回滚动作 | 必须保留 |
|---|---|---|
| Planner | 关闭 `report_editorial_planner_v1`，使用 deterministic typed fallback | v3/v4 Reader、Canonical、Blueprint 诊断 |
| A-experience | 关闭 `report_editorial_experience_v1`，回到 Blueprint v1 / ReportDocument v3 | v4 Reader、Canonical、历史已封存 v4 Artifact |
| 单个 Copy fragment | 使用系统标题/Canonical 摘要或省略 lead/transition，并写稳定 reason code | 其余通过 fragment、结构 Blueprint 与全部 Canonical 内容 |
| 未提交 Report Publication Group | compensate/Recovery 只失效当前 `reportPublicationId` 的新 Artifact | Canonical、Evidence、Review、历史已提交 Package |
| Standalone HTML | 标记 `unavailable`，Bundle API 返回 409 | Web/Markdown、已封存 ReportDocument |
| 可选导出 sidecar | 从 Bundle 省略并写 `export_attachment_omitted` | report.html、ReportDocument、正文与安全 Asset |
| ReportDocument v3 Writer | 按 Deliverable 关闭 `report_v3_writer` | v3 Reader、原报告路径、历史 SEALED Artifact |
| ReportDocument v4 Writer | 关闭 `report_v4_writer` 或单个高级 Block writer | v4 Reader、同版本线性降级、历史 SEALED Artifact |
| 历史 Copy v5 草案 | 不实施；A-experience 使用 v4 的一次 Planner 合同 | 已实现 v1/v2/v3 Reader |
| Visual projection | 关闭 `report_visual_assets_v1` | 文本报告、Asset Reader 与历史资源 |
| 单个高级 Block | 关闭该 Block writer，使用同版本线性降级 | Canonical leaf、v4 Reader |
| Deliverable Adapter | 只关闭该 Deliverable 新 Writer | 其他 Deliverable 和原路径 |
| Editorial Copy Model | 关闭 A-experience 开关并继续 deterministic v3 | Canonical、Blueprint v1、v3 结构报告 |
| Browser Capture | Registry 恢复 `draft`、取消 `PLAYWRIGHT_CAPTURE_ENABLED` 并重启 runtime | V2 Asset Reader、Milestone B、历史截图 |
| Generic Chart Producer | 关闭 `generic_chart_producer_v1` | Chart/Asset Reader、Table/文本、历史 Chart |
| Zero | 只禁用 Zero 发布 | ReportDocument、Web、HTML、Markdown |

回滚不得删除、重写、downcast 已 SEALED Artifact，也不得放宽 Canonical、Evidence、Final Review、确定性 fragment 检查或 owner 授权边界。

## 22. 风险、边界与前置条件

### 22.1 最关键风险：Canonical 是否保留足够结构

Renderer 只能展示 Canonical 已有的结构。当前 `research_strategy_report` 有 matrix、mind model 和 action 等类型，可以支撑相当一部分 Demo；但 Persona、Journey、指标关系若在 Synthesis 时已被压成 narrative，末端无法无损还原。

本方案最脆弱的前提是：真实 Canonical 至少能稳定提供 matrix、node/edge 或 priority/action 中的一类结构。若三个 inventory 证明该前提不成立，不增加末端猜测逻辑；v3 仍可用 paragraph/list 无损交付，但“结构化编辑”质量目标不能宣称达成，必须先单独修复上游 Canonical。

Milestone A1 Reader 不依赖 inventory。A2 默认开启三种富结构 Writer 前，ADR 必须附上众筹、定量和纯叙述三个真实 Canonical inventory 及其 Deliverable/Review hash：

- 哪些关系仍是结构化字段；
- 哪些只剩自然语言；
- 哪些 Contributor unit 被合并或 omitted；
- 是否出现首期三种新增 Block 无法无损承载的结构。

若 inventory 尚未完成，A-core 仍可用 paragraph/list 和 `visualization_linearized` Notice 交付；只是三种富结构 Writer 与 A-model 继续关闭，不把研究工作本身卡在前置审查上。

高级结构按 Milestone C 单独扩展 Canonical Schema 和 Review；不能把它伪装成 Renderer 改动，也不能在 v3 Schema 冻结前临时加入 Roadmap、Swimlane、Metric Group、Persona 或 Journey。

### 22.2 LLM 不能保证“原意不变”

Prompt 只是行为引导，不是安全边界。Planner 的结构边界来自引用式输出、白名单 presentation、exactly-once coverage、usage policy 和确定性 Renderer；Copy 的轻量边界来自句段级 source leaf、确定性实体/状态检查、hash 绑定和单 fragment fallback。该机制不能数学证明绝对等义，因此报告保留来源追溯与必要的生成说明；本轮明确不增加第二 Reviewer 模型或逐报告人工门禁。

### 22.3 HTML 与 Zero 不是完全相同的运行环境

两者应共享语义投影，但 Zero 有节点占位和图片填充限制。不要追求像素完全一致；验收标准是信息等价、层级一致、来源不丢。

### 22.4 复杂结构的移动端与打印

Graph、宽表格、Roadmap、Swimlane 和 Journey Map 必须提供线性化替代表示。只做横向滚动会导致打印和无障碍失败；视觉布局可以不同，但 leaf 与 Copy Slot 集合必须相同。

### 22.5 显式 Adapter 与配置膨胀

为每个 Deliverable 写 Adapter 会增加少量代码，但这是有意的复杂度边界：类型、pointer 和降级行为可静态检查。不要用通用 JSONPath/模板 DSL 省掉 Adapter，否则字段语义、P3 等枚举差异和 Trace 粒度会重新变成运行时猜测。控制膨胀的方法是共享 visitor/Block，不是共享无类型映射。

### 22.6 版本数量

v3、v4 和 Copy 后续版本会增加 Reader 数量。每个版本都必须对应真实语义变化，Writer 单向推进且不长期双写；历史 Reader 在其 Artifact 保留期内继续可读，但冻结功能面，只接受安全、解析正确性和历史兼容修复。新字段、新 Block 和新交互只进入新 Reader/Writer，不要求旧版本追平，也不迁移或重写旧 Artifact。不得为纯 CSS 或 Renderer 修复升 Schema 版本；每个历史版本只保留一组最小 Golden，避免组合测试无限膨胀。

### 22.7 主动网页截图扩大安全边界

Milestone F1 会引入外网、重定向、私网探测、恶意页面、超大图片和登录状态风险。它必须作为独立 Tool 能力完成平台安全评审，默认 optional；在此之前，报告系统只能消费已验证 Asset，不能把“浏览器能打开页面”等同于“后台可安全采集”。

### 22.8 方案范围失控

Milestone A-core 是最小可用底座，A-experience 是当前唯一 P0；B、F 延后，原 C/D/E 不作为本轮依赖。任何后续需求都先判断是否需要新的受审语义：纯视觉样式留在 Renderer；A-experience 授权范围内的标题/摘要/导语使用带 source leaf 的 Copy fragment；新增事实或 Canonical 中不存在的关系必须回到上游另立任务，不能扩大 Renderer 权限。

## 23. Definition of Done

完成条件按里程碑独立计算。后续 Milestone 尚未完成，不得阻塞已经满足 DoD 的前序版本上线，也不得把前序版本描述成已经具备后续能力。

### 23.1 Milestone A：固定流程已经成立

#### A-core DoD

- [x] 新 ADR 接受 ReportDocument v3 与确定性 Blueprint 边界；代表性 Canonical inventory 的状态和后续负责人已记录，未完成时只关闭三种富结构 Writer 与 A-model，不阻断 paragraph/list A-core；
- [x] Material/Blueprint/v3 Schema 严格，presentation/leaf ownership、coverage、provenance 通过；
- [x] Audit Appendix 有独立合同，Diagnostic reference 无发布路径；
- [x] 不调用模型也能生成完整 deterministic v3；
- [x] React、Standalone HTML、Markdown、Zero 支持 v3并生成等价 Manifest；
- [x] HTML SEALED、进入 Package、可授权离线下载；HTML 失败不影响核心报告；
- [x] Report layer Publication Group、完成事务验证的固定 Package 根、重试与 worker-loss 补偿通过；
- [x] ZIP JSON 使用 export-safe allowlist 投影，普通 Asset 不接受 SVG；
- [x] 核心信息默认展开，审计信息可折叠，打印/移动端/无障碍通过；
- [x] 众筹和至少两个非同构案例无需专用 Renderer；
- [x] 历史 v1/v2/Package v1 可读；
- [x] 回滚 HTML/Zero 不影响 Canonical 报告读取。

达到以上条件即可宣布“Demo 的 HTML 生成原则已成为 `research_strategy_report` 的可复用固定流程”。这不依赖 A-model，也不代表 B–F 已完成。

#### A-model DoD

- [x] selectable ID 缺陷已修复并有真实组合回归；
- [x] Planner-safe 输入、Prompt、模型输出 Schema 与 deterministic Blueprint 使用同一 coverage gate；
- [x] `REPORT_EDITORIAL_PLANNER_V1_ENABLED` 已接入且默认关闭；关闭或普通 Provider/Schema 失败时继续交付 deterministic typed Blueprint，模型漂移或 Receipt 丢失 fail closed；
- [x] 一个真实宠物食品历史 Attempt 已完成 composition-only 模型验收：未重跑研究、Synthesis 或 Review，历史 Attempt manifest hash 前后不变；一次 structured call/一个 Receipt 覆盖 86 个 presentation unit、127 个 leaf 和 27 条 audit record，模型与 deterministic fidelity 完全一致，HTML 输出 1 个 Table、1 个 Graph、1 个 Priority Board 且无横向溢出；
- [ ] 补齐独立开关组合的追溯性：`REPORT_V3_WRITER_ENABLED=true`、A-model 开启但 `STANDALONE_HTML_BUNDLE_V1_ENABLED=false` 时，当前实现会回写 Package v1，导致最终 Editorial Blueprint Artifact 与精确 fallback reason 不在 Package 根中；修复前发布配置必须让 A-model 与 Standalone HTML Bundle 同时启停。该项是启用 A-model 前待办，不阻塞默认关闭的 A-core。
- [ ] 三个固定 Golden 的 fidelity/security 差异为 0，轻量盲评不低于 fallback；
- [ ] 首批 50-task canary 达到 fallback、P95 时延与安全阈值，自动关闭与 `data_policy_fallback` Notice 通过。

A-model 当前完成的是“实现 + 单案例隔离验收”，不是“默认启用验收”。以上三个未勾选项完成前，Planner 继续默认关闭；这不影响 A-core，也不代表 Milestone B–F 已开始。

### 23.A A-experience：当前开发完成条件

- [x] `style/density/prominence/graph.variant` 在 Standalone HTML 与 Web 中实际生效，Markdown/Zero 保留等价层级；
- [x] `card-grid` 与 `stage-flow` 的共享合同、visitor、四端输出和确定性线性降级完成；
- [x] Plan v2 用一次模型调用同时返回 Blueprint v1 结构与带 source leaf 的标题、摘要、章节标题、导语和过渡 fragment；
- [x] 没有第二 Reviewer 模型、自动改写循环或逐报告人工审批状态；
- [x] 结构校验失败整份 fallback，单 fragment 机械检查失败只局部 fallback，Canonical 全部内容仍可交付；
- [x] 最小 `research_plan` Adapter 不读取未审 Step 补写正文，无明确 stage 时不生成假时间线；
- [x] 同一历史宠物食品素材完成 composition-only 新旧报告对比，输入 hash 不变，Canonical leaf/Evidence/status/confidence/priority 无差异；
- [x] 桌面、390px、打印和断网 HTML smoke 通过，风险/局限/待解决摘要默认可见，完整证据与审计可展开；
- [x] 关闭 `report_editorial_experience_v1` 后稳定回到 v3，历史 Artifact 可读。

以上全部满足即可宣布“编辑体验纵切片完成”。B/F、50-task canary、全 Deliverable 迁移、像素复刻和全仓既有失败清零均不是本轮 DoD。

### 23.2 Milestone B：已有视觉素材完整接入

- [ ] 已验证图片、对比图、Chart 按唯一归属进入 v3；
- [ ] Asset snapshot、导出策略、table alternative 和四端 Manifest 验证通过；
- [ ] 无素材、全部候选被 `block`、optional 候选损坏、单个 Renderer 或下载失败时不撤销已封存文本报告；optional 候选先隔离并 Notice，只有 required 资源或已进入 publication/snapshot 的引用不一致才阻断对应提交或下载。

### 23.3 Milestone C：高级结构完整接入

- [ ] ResearchTask v3、Demand Graph v2、Execution Plan v4、typed Contribution v2、Canonical v3、Material/Blueprint v2 与 ReportDocument v4 reader-first 全链完成；
- [ ] Roadmap、Swimlane、Metric Group、Persona、Journey 的正向资格和负向误提升测试通过；
- [ ] timebox、lane membership、owner、baseline/target、`quoteMode='synthesized'` 和 null emotion 的无损映射与负向测试通过；
- [ ] 五种 Block 的四端、Trace、打印、移动端、无障碍与 Golden 通过。

### 23.4 Milestone D：全 Deliverable 复用

- [ ] 五个 Deliverable Adapter/Profile 逐个上线并可独立回滚；
- [ ] 每个支持版本的 pointer/leaf coverage 和真实 Golden 通过；
- [ ] 新案例无需案例专用 HTML、CSS 或 Renderer 分支。

### 23.5 Milestone E：受审文案完整接入

- [ ] Copy Request/Draft/Review、Semantic/Render Manifest v2、ReportDocument v5 和 Package v3 合同与 Reader 完成；
- [ ] 只有 v2/v4 Profile 能开启 v5 Writer，v1/v3 Profile 被 Registry 拒绝且原结构报告继续可用；
- [ ] 未通过 Fidelity Review 的文案 0 次发布，失败时结构报告 100% 可交付；
- [ ] 四端 Copy Slot 集合一致，三个 Golden 事实漂移/泄漏/状态强化均为 0；
- [ ] 独立盲评证明可读性不低于 deterministic fallback。

### 23.6 Milestone F：主动视觉生产可用

- [ ] F1 完成既有视觉证据方案的生产安全门禁、真实 Smoke、逐 Profile 授权和 Registry/环境变量回滚演练；
- [ ] F2 `generic-chart-data-v1` Reader/Writer、typed extractor、Publication Group 和 Spec/Table/SVG 一致性通过；
- [ ] optional/required 失败语义与关闭 Producer 的回滚演练通过。

23.A 满足后即可交付当前确认的编辑体验目标。23.2–23.6 保留为后续完整能力 backlog，不影响 A-experience 的完成；只有产品未来明确承诺图片消费、完整高级 Canonical、全 Deliverable 或主动视觉生产时，才分别启用相应 DoD。

## 24. 对当前问题的最终回答

1. **项目已实现无损通用报告底座，但尚未达到旧 Demo 的编辑体验。**A-core 已提供确定性 Material → Blueprint → ReportDocument v3 → 多 Renderer/Standalone HTML；A-model 完成的是结构-only 验收。当前下一步是 A-experience，不把工程验收件误称为最终报告产品。
2. **要把 Demo 机制做成通用能力，不能只复制 HTML。**最小可靠改造是“完整受控材料 → 引用式 Editorial Blueprint → 类型化 ReportDocument v3 → 多 Renderer”。
3. **当前不再按 B→C→D→E 顺序推进。**先完成 A-experience：Renderer 表现、一次 LLM 的结构+文案、card-grid/stage-flow、最小 research_plan Adapter 和同素材 composition-only 验收。B/F 延后，原 C/D/E 保留为 backlog。
4. **A-experience 只是已生成素材的最后加工。**它会改报告合同、投影、Package 与 Renderer，但不重跑或改变搜索、研究、Synthesis、Evidence、Step 10 和 Final Review；缺失于受审素材的内容仍不能由末端补写。
5. **未来报告不会固定出现与 Demo 相同的表格。**展示形式由真实 source shape 决定；有矩阵才有表，有关系才有图，有明确优先级才用 Priority Board，有明确 stage/lane 才用 Roadmap/Swimlane。任何阶段都不为视觉效果编造结构。
6. **当前众筹案例没有任何图片 Artifact。**底层具备图片和 Chart 能力，但该任务未产生视觉素材，且策略报告 v2 projector 尚未接入已发现的视觉材料。B 解决“消费已有素材”，F 才解决“主动取得或生产素材”。
7. **“展开详细要点”里的内容多数是真实分析结果。**当前统一折叠是展示策略过粗；目标方案只折叠 Evidence/provenance/审计，核心结论、行动和风险直接显示。
8. **文案不会建立重型审核链。**一次 Planner 同时输出引用式结构与带 source leaf 的文案；必要确定性检查失败时只回退该 fragment。系统不增加第二 Reviewer 模型、自动改写循环或逐报告人工门禁，流程顺畅优先，必要风险通过来源追溯和报告 Notice 提醒。
