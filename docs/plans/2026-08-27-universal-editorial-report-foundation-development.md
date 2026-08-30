# 通用编辑型报告基础能力开发方案

> 状态：Phase 1 已在当前工作树完成实现与本地验证，尚未提交；Phase 2、Phase 3 待实施
>
> 日期：2026-08-27
>
> 目标仓库：`/Users/heyunshen/work/PROJECT/jdc/ai-x-answer-reports`
>
> 目标分支：`feat/research-answer-dynamic-reports`
>
> 核实基线：`617cf1adc9335a4a78a5dfe4865d32f8037e7985` 加当前工作树中已完成的 A-core、A-model、A-experience 改动
>
> 上游决策：ADR-0004、ADR-0005、ADR-0006、ADR-0007、ADR-0008
>
> 本文定位：在现有编辑型报告流水线上继续开发，不重做研究链，不复制案例模板

## 实施状态（2026-08-28）

Phase 1 已在当前工作树完成：

- `ReportEditorialIntentV1`、共享 placement policy 与 Intent Compiler 已接入 `ReportEditorialPlanner`。
- Compiler 保留合法的模型章节和 Block 相对顺序，按 unit 拆分混合 placement，并将未选内容确定性补入 supporting/appendix。
- mandatory body、关键语义最小覆盖、system supporting、空主报告兜底和 exactly-once coverage 已由后置条件与测试锁定。
- Copy ordinal 会按编译后的 section/block ownership 重映射；目标不唯一时仅拒绝对应 fragment。
- soft-required Copy 缺失或 fragment 被拒绝时合并产生一条 `copy_fallback` Notice；appendix 标题不计入缺失。
- Digest 仅允许用于 supporting 或 collapsible Block；`supported / provisional / unanswered` 已加入保护词检查。
- Intent 路径的 provider、预算、Schema 或编译失败使用同一 placement-policy-aware deterministic fallback，仍只进行一次模型语义调用。
- Phase 1 定向测试、TypeScript、Registry、Knowledge、diff check 和全量离线测试已通过。

当前实现尚未提交。Phase 2 的策略 records 聚合、已验证媒体接线、富结构默认启用与 Renderer 层级修复，以及 Phase 3 的固定 fixture、ordered outline 和真实 Gateway Intent 验收仍待实施；旧 A-experience 验收结果不能替代 Phase 3 证据。

## 1. 结论

最终效果可以在“内容整理、结构编排、样式可视化”三个方面明显接近旧 Demo，同时保持为可复用基础能力。正确做法不是复制旧 Demo，也不是让 LLM 直接生成 HTML，而是在当前 `Material → Blueprint → ReportDocument → Renderer` 之间增加一层：

```text
部分选择式 Editorial Intent
            ↓
确定性 Intent Compiler
            ↓
完整且严格的 Blueprint
```

LLM 负责判断主报告应该讲什么、先讲什么、使用哪种合格组件，以及生成受控标题、摘要、导语和过渡文案；Compiler 负责补齐 mandatory body、把未选择的全部素材归入“完整分析附件”、校验组件资格，并继续产出当前严格的 `ReportEditorialBlueprintV1`。

这样可以同时获得两种能力：

- 主报告是经过取舍和编排的阅读产品，不再把所有分析单元平铺出来。
- 全部受审分析结果仍保留在同一份 ReportDocument 的附件区，leaf、Trace、Evidence 和审计覆盖不丢失。

这是报告层内的中等规模改造。三期合计预计涉及约 18–24 个报告层、Renderer 与配置文件及对应测试；不新增服务、不增加数据库迁移、不修改搜索、研究、Synthesis、Evidence 或 Final Review 流程。

## 2. 背景与现状证据

### 2.1 旧 Demo 与当前正式报告的差距

旧众筹 Demo 与当前新报告来自同一 Task/Attempt，但不是同一套输入和生成机制：

- 旧 Demo 读取了 Final、Steps 1–10、Evidence、Review 和诊断材料，并进行了案例级人工重排、聚合和视觉设计。
- 当前正式流水线只允许受审 Canonical Deliverable、Review、Evidence 和受控附件进入报告，不允许从未审 Step 补写正文。
- 旧 Demo 把 49 条局限、24 个待解决问题和 59 条风险压缩为少数重点；当前报告为了满足 exactly-once coverage，把这些单元全部铺入正文或一级折叠区。
- 旧 Demo 的旅程、漏斗、圆环、路线图等是案例专用 HTML/CSS，不是可复用的图片或通用数据组件。

因此，旧 Demo 是目标体验参考，不是可以直接产品化的模板。新能力必须学习它的编辑原则，但不能继承它对未审中间材料和案例专用结构的依赖。

### 2.2 当前流水线已经具备的能力

当前实现并非从零开始，以下能力应直接复用：

| 能力 | 当前实现 |
|---|---|
| 无损素材层 | `ReportEditorialMaterialV1` 保存 presentation unit、leaf、Trace 和允许的 presentation |
| 严格布局层 | `ReportEditorialBlueprintV1` 表达 style、density、section、prominence、block 和 visibility |
| 单次 LLM 编排 | `ReportEditorialPlanner` 可一次返回 Blueprint 与 Copy fragments |
| 局部 Copy 回退 | 单个 Copy fragment 校验失败时可以单独剔除 |
| 类型化报告 | `ReportDocumentV4` 已支持 Copy provenance、Card Grid、Stage Flow 和 v3 全部 Block |
| 通用可视化 | 已有 Narrative/List、Table、Graph、Priority Board、Card Grid、Stage Flow |
| 已验证媒体 | 合同和 Renderer 已支持 Image、Image Comparison 和 Chart |
| 多端输出 | Web、Standalone HTML、Markdown、Zero 共享 ReportDocument 和 Semantic Manifest |
| 折叠容器 | block `visibility` 和非 primary section 已有 Disclosure 行为 |
| 表现预设 | style、density、prominence 和 graph variant 已被 Web/Standalone Renderer 消费 |
| 完整性 | Blueprint 与 ReportDocument 都要求全量 unit/leaf coverage 和可追溯性 |

关键实现位置：

- `packages/api-contract/report-editorial.ts`
- `packages/api-contract/report-document.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-planner.ts`
- `packages/report-rendering/report-editorial-validation.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-projector.ts`
- `packages/report-rendering/report-document-visitor.ts`
- `apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts`
- `apps/web/src/reporting/ReportDocumentView.tsx`
- `apps/orchestrator-runtime/src/report/standalone-html-report-package.ts`
- `apps/agent-api/src/integrations/zero/zero-report-renderer.ts`

### 2.3 当前真正的瓶颈

当前 `report-editorial-plan-v2` 要求模型返回完整 Blueprint，Prompt 与 Validator 都要求每个 presentation unit 恰好出现一次。因此模型没有“只选择主报告内容”的权限，只能把全部材料重新分组。

这会产生四个直接后果：

1. 内容整理只能换顺序，不能形成“主结论 + 完整附件”的编辑层级。
2. 风险、局限、待解决问题和审计信息数量很大时，主报告仍然臃肿。
3. Copy 在当前 Prompt 中是可空增强；众筹真实验收虽然模型调用成功，最终仍为 `copyMode=fallback`、接受 0 个 Copy fragment。
4. Table、Graph、Priority Board 的合同已经存在，但运行时仍默认关闭；Image/Chart 虽然已被读取和验证，却没有传入 Material Builder，导致编辑流水线实际无法选用。

当前两次真实 composition-only 验收也说明了这个边界：

| 案例 | Material | 当前结果 | 说明 |
|---|---:|---|---|
| 京东众筹策略报告 | 161 units / 178 leaves | 6 sections，Copy fallback | 全量保真，但大量风险与局限仍进入阅读层 |
| 宠物食品 research_plan | 30 units / 87 leaves | 6 sections，31 个 Copy，5 Card Grid，1 Stage Flow | 编辑表达改善，但仍是完整 unit 铺排 |

### 2.4 不把“分析附件”和“审计附件”混为一谈

当前 `ReportAuditAppendixMaterialV1` 只记录 contribution 的 included、merged、conflicted、omitted 等处理台账。它不是完整分析内容。

本方案新增的“完整分析附件”使用普通 Blueprint appendix sections 承载未进入主报告的 Canonical units；现有 `auditAppendix` 继续作为独立的技术审计台账。二者不得合并。

## 3. 目标

### 3.1 产品目标

在不改变受审事实和来源的前提下，把报告生成从“全量内容排版”升级为“主报告编辑 + 完整分析附件”：

- 主报告先回答问题，再呈现关键分析、机会和行动。
- LLM 可以从全部受审素材中选择主叙事，但不能删除正式交付内容。
- 未进入主叙事的素材由系统自动归入完整分析附件。
- 有明确数据结构时优先使用表格、图、卡片、阶段流或优先级看板；没有结构时使用正文或列表。
- 标题、摘要、导语和过渡由 LLM 生成；缺失或校验失败时局部回退，不阻断报告。
- 同一 ReportDocument 在 Web、Standalone HTML、Markdown 和 Zero 中保持语义集合等价。

### 3.2 工程目标

- 保留 `ReportEditorialPlanner.plan()` 当前对下游返回 `Blueprint + editorialCopy` 的接口形状。
- 新增一个纯函数 Intent Compiler，成为“模型建议”与“严格发布合同”之间的唯一接缝。
- 继续使用 `ReportEditorialBlueprintV1` 和 `ReportDocumentV4`，首期不升级 v5。
- 继续保持 100% presentation unit 和 leaf coverage。
- 只调用一次 LLM，不增加 Reviewer、repair loop 或自动重试。
- 复用现有 Feature Flag 和 Renderer，不增加新服务、数据库表或第三方依赖。

### 3.3 成功标准

1. 当 Material 同时包含核心内容和大量辅助内容时，模型可以只把部分 units 放入主报告。
2. Compiler 输出的最终 Blueprint 仍恰好拥有全部 required presentation units 一次。
3. mandatory body units 一定进入 primary section；LLM 遗漏时由 Compiler 自动补入。
4. 其余未选择 units 全部进入 supporting 或 appendix section，顺序稳定且无重复。
5. 关键 Copy 槽位缺失或单片段失败时，报告仍生成，并显示稳定的 `copy_fallback` 提示。
6. 同一模型调用同时完成结构意图和 Copy，不发生二次模型审核或自动重写。
7. 六类通用原语按素材资格选择，不设置“至少出现 N 类组件”的硬门槛。
8. 三类案例的 composition-only 验收通过，且不修改历史 Attempt 输入。
9. Placement policy 由一个共享纯函数确定性派生，并由 Compiler 后置条件验证，而不是依赖 Prompt 约定。
10. 高密度案例能观测到主报告收缩和非空完整分析附件；该指标按固定案例判断，不设全局比例门禁。
11. 四端除内容 ID 集合外，还能复验章节顺序、层级、可见性、unit 归属和 Copy 来源。

## 4. 非目标

本方案明确不做以下事项：

- 不让 LLM 输出 HTML、CSS、JavaScript、SVG 或任意 Markdown 页面。
- 不复制旧 Demo 的章节、色彩、组件或文案作为固定模板。
- 不新增 PersonaCard、CrowdfundingFunnel、PetFoodJourney 等案例组件。
- 不读取未通过 Final Review 的 Step Artifact 补写正文。
- 不让报告层生成新的研究结论、数字、Evidence、优先级或因果关系。
- 不新增第二 Reviewer、自动修文循环、逐报告人工审批或组件数量门禁。
- 不在本次开发中增加图片搜索、网页截图或 AI 生图能力。
- 不重跑研究、搜索、Contributor、Synthesis 或 Review 链路完成验收。
- 不承诺所有案例都出现表格或图；展示形式由真实 source shape 决定。
- 不承诺无 Adapter 的任意 JSON Deliverable 自动获得高质量报告。

## 5. 术语与边界

| 术语 | 含义 |
|---|---|
| Reviewed Canonical | 已通过 Final Review 的正式 Deliverable，是唯一分析事实源 |
| Editorial Material | Canonical 的无损、类型化、可追溯展示素材 |
| Editorial Intent | LLM 对主报告内容、顺序、组件和 Copy 的部分选择建议 |
| Intent Compiler | 将部分 Intent 补全为全量严格 Blueprint 的确定性模块 |
| Main Report | `prominence=primary` 的默认展开阅读主体 |
| Supporting | 非核心但应保留在正文附近的折叠区，例如交付绑定或质量说明 |
| Full Analysis Appendix | 未进入主报告的全部 Canonical units，使用普通 appendix sections 表达 |
| Audit Appendix | Contribution Ledger 的处理审计，与 Full Analysis Appendix 分离 |
| Copy Fragment | 带 `sourceLeafIds` 的派生标题、摘要、导语、过渡或 Block 摘要 |
| Primitive | 由确定性 Renderer 实现的通用信息表达形式 |
| Container | 不创造事实，只改变强调或展开方式的 Semantic Callout / Disclosure |

“适用于任何案例”的准确边界是：同一个报告流水线适用于任何已经有正式 Deliverable Adapter 的案例，不需要按案例写 HTML。新增 Deliverable 类型仍需增加显式 Adapter；不使用猜测式通用 JSON 转换器。

## 6. 目标架构

```text
Reviewed Final / Canonical + Review + Evidence + verified Assets
                              │
                              ▼
                 Deliverable-specific Material Adapter
                              │
                              ▼
                 ReportEditorialMaterialV1（全量）
                              │
                 planner-safe projection + placement policy
                              │
                              ▼
                   一次 LLM structured call
                              │
                              ▼
                  ReportEditorialIntentV1（部分）
                              │
                              ▼
             Deterministic Intent Compiler（唯一补全点）
                 ├─ 补入 mandatory body units
                 ├─ 未选内容进入 supporting / appendix
                 ├─ 不合格组件降级为 Narrative/List
                 └─ 生成完整 Blueprint + Copy selection
                              │
                              ▼
               ReportEditorialBlueprintV1（全量严格）
                              │
                              ▼
                 现有 Projector → ReportDocumentV4
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
             Web        Standalone HTML   Markdown / Zero
```

数据流没有回边，也没有第二次 LLM 调用。所有下游仍只信任编译后的 Blueprint 和 ReportDocument。

## 7. 核心合同：`ReportEditorialIntentV1`

### 7.1 类型定义

新增到 `packages/api-contract/report-editorial.ts`：

```ts
export interface ReportEditorialIntentV1 {
  version: 'report-editorial-intent-v1';
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  mainSections: Array<{
    headingMode: 'view_label' | 'first_source_title';
    view: ReportViewIdV1;
    prominence: 'primary' | 'supporting';
    blocks: ReportEditorialBlueprintBlockV1[];
  }>;
  copyFragments: ReportEditorialCopyFragmentV2[];
}
```

该类型刻意复用现有 Block 和 Copy 合同，不引入第二套组件模型。

### 7.2 字段语义

| 字段 | 责任方 | 规则 |
|---|---|---|
| `version` | 系统/模型 | 固定为 `report-editorial-intent-v1` |
| `style` | LLM | 从现有三种样式中选择 |
| `density` | LLM | 从 comfortable / compact 中选择 |
| `mainSections` | LLM | 只描述主报告和必要 supporting；允许只引用 Material 的一部分 |
| `headingMode` | LLM | Copy 失败时的确定性章节标题策略 |
| `view` | LLM | 继续服从 unit 的 required view，不新增视图体系 |
| `prominence` | LLM | 只允许 primary / supporting；appendix 由 Compiler 生成 |
| `blocks` | LLM | 只引用已存在 unit ID，并从 allowed presentations 中选择组件 |
| `copyFragments` | LLM | 与结构在同一次调用中返回；内容受 source scope 与漂移检查约束 |

### 7.3 为什么 Intent 必须是“部分合同”

`ReportEditorialBlueprintV1` 的价值是全量、严格和可验证，不应放宽它的 exactly-once invariant。Intent 的价值则是表达编辑取舍。二者必须分开：

- Intent 可以省略 unit，省略代表“不进入主报告”，不代表删除。
- Blueprint 不允许省略 unit，Compiler 必须补全全部内容。
- Intent 不声明 appendix units；Compiler 直接计算 Material 与主报告选择的差集，避免模型同时维护两份清单。
- Intent 不生成 section/block ID；Projector 继续确定性生成 ID。
- Intent 不包含新事实字段，Copy 仍是唯一允许的派生自然语言。

### 7.4 Planner-safe 输入增量

在现有 `ReportEditorialPlannerInputV1` 的模型安全投影基础上，为 Intent 调用增加确定性 placement policy。该 policy 只存在于模型输入和 Compiler 内部，不写回 Canonical：

| 字段 | 含义 |
|---|---|
| `mandatoryBodyUnitIds` | 必须出现在 primary section 的 unit |
| `mainCoverageGroups` | 每个关键语义组至少选择一个 unit，例如 Evidence 信号和风险信号 |
| `systemSupportingUnitIds` | 不进入 primary、也不允许被当作分析内容丢弃的技术性 supporting units |
| `allowedPresentations` | 每个 unit 当前可用的通用组件 |
| `requiredView` | unit 的稳定视图归属 |
| `requiredVisibility` | unit 在所在容器内的可见性下限 |

Planner-safe projection 与 Compiler 必须调用同一个纯函数 `deriveEditorialPlacementPolicy(material)`；不得分别维护两套判断逻辑。模型只能读取该函数的结果，不能覆盖它。

### 7.5 Placement policy 的唯一派生规则

`deriveEditorialPlacementPolicy(material)` 只读取以下现有字段：

- `material.document.deliverableType`。
- `material.document.requestedArtifactTypes`。
- 每个 unit 的 `semanticKind`、`requiredView`、`requiredVisibility` 和原始顺序。

函数返回 `mandatoryBodyUnitIds`、`mainCoverageGroups`、`systemSupportingUnitIds` 和可选的 `fallbackPrimaryUnitId`。其中 mandatory 与 system supporting 必须互斥；若未来 Adapter 产生交集，视为程序错误并进入全量 deterministic fallback。

最终 placement 按以下固定优先级解析：

1. mandatory body 和关键语义最小覆盖进入 primary。
2. system supporting 固定进入 supporting，模型不能把它提升为 primary。
3. 其余合法模型选择按模型指定的 primary / supporting 放置。
4. 未选择 unit 进入 appendix。
5. 如果前四步没有产生任何 primary，而 Material 存在非 system unit，则把 Canonical 顺序中的首个非 system unit 设为 `fallbackPrimaryUnitId`。

Compiler 完成后调用内部 `assertEditorialPlacementPolicy(blueprint, policy)`，验证 mandatory、最小覆盖、system supporting、至少一个可用 primary 和附件差集。它是 Compiler 的普通后置条件，不是新增 Reviewer 或审批环节。

## 8. 主报告、Supporting 与附件规则

### 8.1 mandatory body

以下内容确定性进入 primary，不依赖 LLM 是否选择：

- 所有 `direct_answer`。
- 所有 `prioritized_action` 和 `action_plan`。
- `research_plan` 的 overview、questions、methods、execution 和 deliverables。
- 用户明确请求的策略产物按下表映射到对应 `semanticKind`。

| `requestedArtifactType` | mandatory `semanticKind` |
|---|---|
| `executive_answers` | `direct_answer` |
| `research_report` | 不额外扩大 mandatory；报告整体和 direct answer 已满足该容器型交付要求 |
| `strategy_map` | `strategy_map` |
| `mind_model` | `mind_model` |
| `design_principles` | `design_principle` |
| `opportunity_backlog` | `opportunity` |
| `prioritized_actions` | `prioritized_action` |
| `channel_strategies` | `channel_strategy` |
| `action_plan` | `action_plan` |

用户请求产物的“实际内容”必须在 primary；技术性的 `requested_artifact_binding` 不等于实际内容，不强制占据主阅读区。

### 8.2 关键语义最小覆盖

如果 Material 中存在以下语义组，模型应在 primary 中至少选择一个 unit：

- Evidence 信号：`evidence_finding`、`verified_chart` 或已验证 visual asset。
- 风险信号：`risk`、`limitation` 或 `open_question`。

模型遗漏时不阻断、不重试。Compiler 按 Canonical 顺序补入该组首个 unit，并把其余内容放入附件。这个确定性选择只是安全下限；正常模型结果仍应选择更有决策价值的内容。

### 8.3 system supporting

以下内容默认进入 supporting disclosure：

- `requested_artifact_binding`。
- `research_plan_quality`。

它们不占据首屏，但仍位于正式报告中，并保持可打印、可导出。

生成说明和兼容性提示属于 `ReportNoticeV1`，不属于 Material unit，也不得写入 `systemSupportingUnitIds`。

### 8.4 完整分析附件

设 Material 全量 unit 集为 `U`，主报告和 supporting 已归属集合为 `S`，则附件集合固定为：

```text
A = U - S
```

Compiler 对 `A` 执行以下规则：

1. 按 Material 原始顺序稳定排序。
2. 先按 `requiredView`，再按 `semanticKind` 分组。
3. 使用现有 deterministic presentation 选择；不合格结构降级为 Narrative/List。
4. 生成 `prominence=appendix` 的普通 Blueprint sections。
5. section 外层默认折叠；内部 block 继续遵守 required visibility。
6. 打印、Markdown full report 和导出必须包含全部附件内容。
7. 与现有 Audit Appendix 分开呈现，命名为“完整分析附件”，不得叫“审计记录”。

最终 Blueprint 的 unit 集必须仍与 `requiredPresentationUnitIds` 完全相等，且每个 unit 恰好一次。

### 8.5 Copy 的展示规则

- Soft-required：report title、executive summary、最终所有非 appendix section 的 section title；Compiler 自动生成的 appendix 标题不计入缺失。
- Recommended：primary section lead。
- Optional：section transition、supporting block digest。
- 缺失或单 fragment 被拒绝时，分别使用 Canonical 标题、Canonical executive answer、`headingMode` 标题或省略可选文案。
- 任一 Copy fallback 都不触发模型重试；soft-required 缺失或 fragment 被拒绝时，整份报告最多合并成一条 `copy_fallback` info notice。
- Digest 只在 supporting/collapsible block 中承担“可见摘要 + 展开完整内容”的作用；primary 的 Table、Graph、Priority Board、Card Grid、Stage Flow 不用 digest 替换主体。
- Copy 不创建 leaf，不进入 Canonical trace；它只进入 `copyFragmentIds`，并通过 `sourceLeafIds` 追溯。
- Copy 校验是机械防线，不宣称能够证明完整语义等价。除现有数字、日期、金额、比例、优先级、Evidence ID 和 URL 外，增加 `supported / provisional / unanswered` 等有限状态词保护；其他语义漂移作为残余风险，通过局部 Canonical fallback 和 Notice 处理。

Copy target 继续使用现有 ordinal 合同，但 ordinal 只表示 Intent 中的位置。Compiler 在拆分或补入 section/block 时维护临时的 `intent ordinal → compiled ordinal` 映射：

- report title 和 executive summary 不需要重映射。
- section title/lead 只在其 `sourceLeafIds` 能唯一落入一个编译后 section 时重映射。
- block digest 只在其来源 leaf 能唯一落入一个编译后 block，且该 block 为 supporting 或 collapsible 时保留。
- transition 只有在来源的相邻 Intent sections 编译后仍保持可判定的相邻关系时保留。
- 目标不唯一或关系失效时仅拒绝该 fragment，不回退整份 Intent、不重试模型。

## 9. Intent Compiler 行为

新增 `apps/orchestrator-runtime/src/report/report-editorial-intent-compiler.ts`，保持为无 I/O 的纯模块。

### 9.1 输入

- 完整 `ReportEditorialMaterialV1`。
- 模型返回的 `ReportEditorialIntentV1`。
- 当前 `DeterministicEditorialBlueprintOptions`。

### 9.2 输出

- 完整 `ReportEditorialBlueprintV1`。
- 已接受和已拒绝的 `ReportEditorialCopySelectionV2`。
- 内部 diagnostics：total/primary/supporting/appendix unit 数、`primaryUnitRatio`、mandatory/coverage 自动补入数、组件降级数，以及 Copy soft-required/accepted/rejected/missing 数。

不新增持久化 Intent Artifact。生产链继续只封存编译后的 Blueprint 和 ReportDocument，避免扩大 Artifact kind、Package 和 Recovery 合同。真实验收目录可以额外保存 `selected-intent.json` 作为测试证据，但它不是正式发布根。

### 9.3 编译顺序

1. 校验 Material 完整性。
2. 使用新 JSON Schema 校验 Intent 基本形状。
3. 调用共享的 `deriveEditorialPlacementPolicy(material)`；检查 unitRef 是否存在、是否跨 Block 重复、view 是否匹配。
4. 先按 unit 解析最终 placement。一个模型 Block 同时包含 primary、supporting 或 appendix unit 时，按 placement 分桶拆分，保持原 unit 顺序；拆分后不再合格的 presentation 使用确定性首选组件。
5. 保留仍然合法的模型章节相对顺序。mandatory unit 即使被模型放入 supporting 也只提升该 unit，不提升同节的其他 supporting 内容。
6. 将完全缺失的 mandatory body units 放入匹配 view 的 deterministic primary section；将缺失的关键语义最小覆盖按 Canonical 顺序补入 primary。
7. 将 system supporting units 放入 supporting sections；模型将其放入 primary 时也以 policy 为准。
8. 如果仍没有 primary，应用 `fallbackPrimaryUnitId`；随后计算剩余差集并生成 appendix sections。
9. 为保留的模型 Copy 重映射 ordinal；目标不唯一、scope 越界或内容不合格时仅剔除该 fragment。
10. 运行现有 `assertReportEditorialBlueprintIntegrity()`，再运行 `assertEditorialPlacementPolicy()`。
11. 如果编译后的 Blueprint 仍不合法，使用现有全量 deterministic Blueprint；只有 deterministic Blueprint 自身也失败才硬阻断。

### 9.4 模型错误处理

| 情况 | 行为 |
|---|---|
| Provider 超时或失败 | 一次调用后直接 deterministic fallback |
| Schema 非法 | deterministic fallback |
| 未知或重复 unitRef | 放弃该 Intent，deterministic fallback |
| Block 混合多个 placement | 确定性拆分并保持 unit 顺序 |
| 组件不兼容 | 局部降级为合格组件，保留其余结构 |
| mandatory unit 遗漏 | Compiler 自动补入 primary |
| optional unit 遗漏 | 自动进入 appendix |
| Copy 缺失、重映射不唯一或越界 | 仅该槽位 fallback，并合并产生一条 info Notice |
| 最终 Blueprint coverage 异常 | 先全量 deterministic fallback；仍异常才硬阻断 |

这套策略的重点是“模型失败不影响正式内容交付”，而不是增加审核环节。

## 10. 通用组件体系

### 10.1 六类内容原语

| 原语 | 现有 Block | 使用资格 | 不满足时 |
|---|---|---|---|
| Narrative/List | paragraph、fact、answer、list | 文本或无法安全结构化的内容 | 默认兜底 |
| Table | record-table | matrix、同构 record、actions 或 chart table；沿用 12 列/200 行上限 | List |
| Card Grid | card-grid | 单个 records unit，最多 50 records | List |
| Stage Flow | stage-flow | 单个 stages unit，具有显式顺序，最多 50 stages | List |
| Graph | graph | 显式 nodes/edges，边引用有效节点 | List |
| Priority Board | priority-board | actions 具有明确 P0/P1/P2，每组最多 50 项 | Table 或 List |

现有 Image、Image Comparison 和 Chart 作为“已验证媒体原语”继续保留，但不计入必须出现的六类基础组件，也不由 LLM 从散文生成。

### 10.2 两个通用容器

| 容器 | 实现方式 | 用途 |
|---|---|---|
| Semantic Callout | 复用 answer kind、answer status、标题和现有 Block 样式 | 强调直接回答、风险、局限、provisional/unanswered，不新增 Schema 类型 |
| Disclosure | 复用 block visibility 和 section prominence | 展开 supporting、完整分析附件和审计内容 |

首期不增加任何案例专用组件。Persona、旅程、漏斗、路线图、Gate 等表达只有在其数据能映射到上述通用原语时才呈现。

### 10.3 Material Adapter 改造

当前 `research_strategy_report` 中 design principles、opportunities 和 channel strategies 会被拆成多个单 record unit，无法直接使用 Card Grid。第二期改为按原 Content Block 聚合成一个 records unit，每个 item 仍保留独立 leaf 和 Trace。

这项改造需要对 Material v1 做向后兼容扩展：`design_principle`、`opportunity`、`channel_strategy` 同时允许旧 `record` 和新 `records` shape。版本号保持 v1，旧输入继续合法；Schema、运行时完整性校验和 Adapter 必须在同一提交中更新。聚合允许 presentation unit 数减少，但 leaf ID、leaf 顺序、字段内容以及每个 leaf 的 `jsonPointer`、`sourceNodeIds`、support/Evidence 必须与聚合前完全一致。

当前 `research_plan` 已能输出 records、stages、text 和 actions，应保留其显式结构。其他规则如下：

- matrix 继续映射 Table。
- mind model 继续映射 Graph。
- prioritized actions 继续映射 Priority Board。
- execution plan 继续映射 Stage Flow。
- 同构记录集合映射 Card Grid 或 Table。
- 纯叙述保持 Narrative/List，不从文案推断阶段、边、指标或优先级。
- verified Assets/Charts 由 Composition 传入 Builder 后才创建对应 Material units。

不同 Deliverable 通过显式 Adapter 进入同一 Material 合同，不引入配置 DSL，也不按案例名称分支。

### 10.4 跨 Renderer 的结构等价

生产 `ReportSemanticManifestV2` 继续保持现状，不为验收扩展持久化 Schema。验收工具额外生成只读的 ordered outline，逐端比较：

- section 的顺序、view 和 prominence。
- block 的顺序、visibility、unitRefs 和 leafRefs。
- Copy 的 ID、provenance 和 sourceLeafIds。
- Full Analysis Appendix 与 Audit Appendix 的归属。

Web 与 Standalone HTML 使用交互式 Disclosure；Markdown 与 Zero 可以静态展开，但必须明确标识 supporting/appendix 层级，不能把附件伪装成 primary。ID 集合等价继续保留，但不再作为结构等价的唯一证据。

## 11. 完整运行流程

1. `ReportCompositionService` 只接受通过 Review 的 Deliverable 和匹配的 Evidence/Asset binding。
2. 对应 Deliverable Adapter 生成全量 `ReportEditorialMaterialV1`。
3. Material 完整性校验确认 unit、leaf、Trace 和 binding 正确。
4. Planner-safe projection 移除 Artifact 地址、二进制内容和不需要的内部字段。
5. 现有 data policy 决定是否允许调用真实模型。
6. `ReportEditorialPlanner` 最多调用一次 LLM，读取全部 planner-safe Material 并返回 Intent+Copy。
7. Intent Compiler 生成全量严格 Blueprint；未选内容自动归入 supporting/appendix。
8. 现有 Projector 把 Material+Blueprint+Copy 投影为 `ReportDocumentV4`。
9. 现有 Document integrity 和 coverage 检查确认全部 leaf/Trace 未丢失。
10. Web、Standalone HTML、Markdown 和 Zero 各自渲染，并比较 Semantic Manifest。
11. Report Package v2 继续记录 Blueprint、Document、Asset snapshot、HTML 状态和 Notice。

整个流程是报告生成的最后加工层。它不会改变原始素材生成，也不会修改历史 Canonical Artifact。

### 11.1 模型预算与“一次调用”的边界

复用当前 Planner 限制，不新增压缩链或分片调用：

| 项目 | 上限 | 超限行为 |
|---|---:|---|
| planner-safe JSON | 524,288 bytes | 调用前直接 deterministic fallback |
| presentation units | 500 | 调用前直接 deterministic fallback |
| leaf refs | 5,000 | 调用前直接 deterministic fallback |
| 估算或实际 prompt | 64,000 tokens | 预检超限不调用；实际超限则丢弃结果并 fallback |
| 序列化模型输出 | 65,536 bytes | 丢弃结果并 fallback |

所有超限都使用稳定 `material_budget_exceeded` diagnostic，不截断 Canonical、不压缩后重试。本文“一次 LLM 调用”专指一次 Planner 语义请求；共享 Gateway 为 429/网络故障执行的底层传输重试不属于报告修文或第二次语义审核。

## 12. 分期开发计划

三期均可独立合并和回滚。Phase 1 即可产生主报告/附件分层；Phase 2 增强语义化与视觉表达；Phase 3 完成跨案例验收和测试环境启用。

### Phase 1：编辑意图与确定性补全

#### 交付内容

1. 新增 `ReportEditorialIntentV1` 与 JSON Schema。
2. 把 A-experience 的模型输出从完整 `report-editorial-plan-v2` 切换为部分选择式 Intent。
3. 新增共享纯函数 `deriveEditorialPlacementPolicy()` 和纯 `Intent Compiler`，输出当前严格 Blueprint。
4. 实现 mandatory body、关键语义最小覆盖、system supporting、混合 Block 拆分、空主报告兜底和完整分析附件，并用 `assertEditorialPlacementPolicy()` 锁定后置条件。
5. 把 Copy 从“可以为空”改为“关键槽位 soft-required”，实现 ordinal 重映射、Digest 资格校验、缺失/拒绝合并 Notice 和局部 fallback。
6. 保持一次模型调用、无自动重试、无第二 Reviewer。
7. 保持 Projector、ReportDocument v4、Package 和四端 Renderer 接口不变。

#### 文件范围

新增：

- `schemas/report-editorial-intent-v1.schema.json`
- `apps/orchestrator-runtime/src/report/report-editorial-placement-policy.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-intent-compiler.ts`
- `tests/report-editorial-intent-compiler.test.ts`

修改：

- `packages/api-contract/report-editorial.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-planner.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-blueprint.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-copy-validator.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-projector.ts`
- `packages/report-rendering/report-editorial-validation.ts`
- `tests/report-editorial-planner.test.ts`
- `tests/report-editorial-plan-v2.test.ts`
- `tests/report-editorial-pipeline.test.ts`
- `tests/report-composition-v3.test.ts`
- `docs/adr/0008-adopt-reusable-editorial-report-pipeline.md`

`report-editorial-plan-v2.schema.json` 不再作为 A-experience 的活动模型输出合同；其 Copy fragment 类型和校验逻辑继续复用。由于 Plan v2 从未作为正式发布 Artifact，切换不需要历史数据迁移。

#### Phase 1 验收

- Intent 只选择一半 optional units 时，最终 Blueprint 仍全量覆盖。
- mandatory body unit 被模型遗漏时，Compiler 自动放回 primary。
- 未选 optional units 全部进入 appendix，无重复、无丢失。
- requested artifact binding 进入 supporting，不触发当前“不得进入 appendix”约束。
- mixed Block 被按 placement 拆分，mandatory 与 system supporting 不会互相“搭便车”。
- 无 mandatory、无 coverage 且 Intent 为空的纯叙述素材仍至少产生一个 primary section。
- section/block 被拆分或补入后，Copy ordinal 要么准确重映射，要么仅该 fragment 回退。
- 缺少全部 Copy 时，调用次数仍为 1，报告生成且 `copyMode=fallback`，并且最多显示一条 `copy_fallback` Notice。
- 单个 Copy 非法时，其余 Copy 保留，报告为 `mixed`。
- appendix 标题不计入 soft-required 缺失；不合格 Digest 被局部剔除。
- 无模型、模型超时、Schema 非法时，仍可生成完整 deterministic 报告。

#### 独立回滚

关闭 `REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED` 即退出 Intent 路径。`REPORT_V3_WRITER_ENABLED` 开启时回到 v3；两者都关闭时回到原报告路径。历史 SEALED Artifact 不修改。

### Phase 2：语义素材与可视化接线

#### 交付内容

1. 将策略报告中的同构 item 聚合为 records units，解锁 Card Grid/Table；同步向后兼容扩展 Material v1 Schema 与运行时 shape 校验。
2. 保持 research plan 的 records/stages/actions 结构，不把它压回文本。
3. 将已经由 Composition 验证的 Visual Assets 和 Charts 传入 Material Builder。
4. 在体验开关下启用 Table、Graph、Priority Board；不新增组件级 Feature Flag。
5. 以现有 answer kind/status 实现 Semantic Callout；risk、limitation、open question 使用已有语义类型，不靠标题字符串判断。
6. 统一 Web、HTML、Markdown、Zero 对 primary、supporting、appendix 和 digest 的表达；交互端可折叠，静态端展开但必须保留层级标签。
7. 删除“至少出现若干组件”的产品门槛；组件数量只记录诊断，不影响交付。
8. 把全部 appendix sections 放入统一的“完整分析附件”容器；Audit Appendix 继续单独显示。
9. 修复启用富结构前已经确认的表现缺口：Card Grid/Stage Flow 的 compact density、Standalone 非 primary 标题选择器、屏幕/打印副本重复 DOM ID，以及 hub-spoke 图中心节点必须稳定排在首位。

#### 文件范围

修改：

- `apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts`
- `apps/orchestrator-runtime/src/report/report-composition-service.ts`
- `apps/agent-api/src/control-runtime.ts`
- `schemas/report-editorial-material-v1.schema.json`
- `packages/report-rendering/report-editorial-validation.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-projector.ts`
- `apps/orchestrator-runtime/src/report/report-editorial-rich-block-projector.ts`
- `apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts`
- `apps/web/src/reporting/report-document-view-model.ts`
- `apps/web/src/reporting/ReportDocumentView.tsx`
- `apps/web/src/reporting/report-print.css`
- `apps/web/src/reporting/report-bundle.ts`
- `apps/orchestrator-runtime/src/report/standalone-html-report-package.ts`
- `apps/agent-api/src/integrations/zero/zero-report-renderer.ts`
- `tests/report-editorial-research-plan.test.ts`
- `tests/report-editorial-pipeline.test.ts`
- `tests/report-document-v4.test.ts`
- `tests/standalone-html-report-renderer.test.ts`
- `tests/report-document-v3-react.test.ts`
- `tests/report-bundle.test.ts`
- `tests/zero-report-renderer.test.ts`

通常不修改：

- `packages/api-contract/report-document.ts`
- `schemas/report-document-v4.schema.json`
- `packages/report-rendering/report-document-visitor.ts`
- `packages/report-rendering/report-render-manifest.ts`
- Report Package v2 和发布 Artifact 合同

只有开发中证明 `prominence + visibility + digest + 现有 Block` 无法表达主报告与附件语义时才升级 ReportDocument v5。当前设计不满足该触发条件，因此本方案固定复用 v4。

#### Phase 2 验收

- 每个组件都只由合格 source shape 触发。
- 同构 records 可生成 Card Grid 或 Table，item leaf 仍逐项可追溯。
- 没有 nodes/edges、stages、priority 或数值时，报告不伪造 Graph、Stage Flow、Priority Board 或 Chart。
- 已验证 Asset/Chart 能进入 Material、Document 和四端输出；不存在素材时正常生成无图片区报告。
- 组件降级只产生稳定 Notice，不阻断报告。
- 聚合前后允许 presentation unit 数变化，但 leaf ID/顺序、字段内容、Trace、Evidence 和来源指针完全一致；每类聚合 fixture 至少包含两个 item。
- 四端 Semantic Manifest 集合一致，验收 ordered outline 的章节顺序、层级、visibility、unit ownership 和 Copy 来源一致。
- Standalone HTML 中屏幕与打印副本没有重复 DOM ID；v4 Chromium 测试同时覆盖单数和复数 leaf-ref 属性。
- compact density 对 Card Grid 和 Stage Flow 生效；hub-spoke 的视觉中心与计算出的中心节点一致。

#### 独立回滚

关闭体验开关恢复原 v3/旧路径；Standalone HTML 可由 `STANDALONE_HTML_BUNDLE_V1_ENABLED=false` 独立关闭。Material 与 Canonical 不被改写。

### Phase 3：跨案例验收与测试环境开启

#### 固定案例

普通 CI 使用仓内脱敏、只读 fixture，并复用现有临时完整 Attempt factory：

1. 从众筹策略真实 Attempt 裁剪的高密度策略报告 fixture。
2. 从宠物食品真实 Attempt 裁剪的 `research_plan` fixture。
3. 纯叙述 fixture，只包含 text/record 素材，用于证明无图表也能产出清晰报告。

本机真实验收继续使用以下历史输入，但它们不是 CI 前提：

1. 众筹策略报告：
   `run-workspaces/current-control/tasks/055a2658-8b6c-4bd7-9078-43636feb9df7/attempts/105dbbe2-1e92-47a0-8062-0e2da78fea4e`
2. 宠物食品 research_plan：
   `/Users/heyunshen/work/PROJECT/jdc/ai-x/run-workspaces/current-control/tasks/e16880e3-21c2-4541-9e38-fc750185ee4b/attempts/70bac736-5ad5-4224-b46e-fc3b5273d99e`

#### 验收方式

- 三类仓内 fixture 均执行离线 composition-only，使用固定 Intent/Mock LLM，不访问 Gateway，进入普通 CI。
- 两个历史 Attempt 仅通过显式 CLI opt-in 执行真实 composition-only；目录只读，生成前后计算输入 manifest hash，必须一致。
- 每次真实模型验收只发起一次 Planner structured semantic call，并产生一个 Receipt；不进行报告级 repair/retry。
- 输出写入独立的 `run-workspaces/editorial-acceptance/universal-editorial-*` 目录。
- 保存 `selected-intent.json`、compiled Blueprint、ReportDocument、Render Manifest、HTML 和 acceptance summary。
- 自动检查 main/supporting/appendix unit 集、全量 leaf coverage、Trace、Evidence、状态、优先级和四端 ordered outline。
- acceptance summary 记录 `primaryUnitCount`、`supportingUnitCount`、`appendixUnitCount`、`primaryUnitRatio`、自动补入数和 Copy soft-required coverage。
- 不设置全局正文比例硬门禁；高密度众筹 fixture 单独要求 `appendixUnitCount > 0` 且 `primaryUnitCount < totalUnitCount`，其他案例只记录诊断。
- 浏览器检查桌面宽度与 390px 移动宽度，无横向溢出。
- 打印检查所有 Disclosure 展开且附件不丢失。
- 人工并排比较旧 Demo，检查阅读层级，不做像素复刻。

#### 文件范围

- `scripts/report-editorial-acceptance.ts`
- `tests/report-editorial-acceptance.test.ts`
- `tests/fixtures/report-editorial/crowdfunding-strategy-v1.ts`
- `tests/fixtures/report-editorial/research-plan-v1.ts`
- `tests/fixtures/report-editorial/pure-narrative-v1.ts`
- `apps/web/src/components/stages/CurrentStage4Report.tsx`
- `tests/multi-skill-report-ui.test.ts`
- `.env.example` 仅补充现有开关说明，不增加新开关
- `docs/plans/2026-08-27-universal-editorial-report-foundation-development.md` 回填实施结果

#### 测试环境配置

测试版本使用现有开关：

```dotenv
REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED=true
STANDALONE_HTML_BUNDLE_V1_ENABLED=true
```

`REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED=true` 已隐式启用 v3/v4 writer 和 Editorial Planner；不再要求用户逐项授权 Table、Graph 或 Priority Board。正式环境继续默认关闭，直到三类仓内离线验收和两例本机真实验收完成，并由发布负责人显式开启。

测试版保留现有全部报告视图。当 v4 存在时，默认进入编辑型完整报告；管理摘要、分析底稿和旧兼容视图仍可切换，不删除任何入口。关闭体验开关后恢复当前默认视图行为。

#### 独立回滚

关闭两个现有开关即可停止新体验和 HTML 输出。验收输出是独立目录，可保留作为证据，不参与正式 Report Package 读取。

## 13. 测试矩阵

| 层级 | Happy path | 降级/错误 | 边界 |
|---|---|---|---|
| Intent Schema | 部分 unit、合法 Copy | 非法 JSON、未知字段 | 空 mainSections、上限 |
| Compiler | 主报告选择 + 自动附件 | 重复/未知 ref → 整体 fallback | 全选、只选 mandatory、无 optional、空 Intent |
| Mandatory policy | 核心内容均在 primary | 模型遗漏 → 自动补入 | mixed Block、mandatory/system 冲突、无风险/Evidence 组 |
| Copy | 关键槽位齐全 | 单 fragment 拒绝、全部缺失 | ordinal 重映射、Digest 资格、source scope、状态/数字/日期/URL 漂移 |
| Component | 每种合格 shape 正确呈现 | 不合格结构 → List | 聚合前后 leaf/Trace 不变、12 列/200 行/50 item 上限 |
| Media | verified Asset/Chart 进入报告 | 缺失或不可导出 → Notice | 无媒体任务 |
| Projection | v4 全量覆盖 | compiled Blueprint 异常 → deterministic | primary/supporting/appendix 都存在 |
| Renderer | 四端集合与 ordered outline 等价 | HTML/Zero 单端失败不影响其他端 | 层级标签、390px、打印、长文本、DOM ID 唯一 |
| Source safety | 只读历史 Attempt | hash/binding 不匹配硬阻断 | 无 Contribution Ledger 的 research_plan |
| LLM | 一次 Planner 语义调用 | timeout/schema/data policy → fallback | 五类预算边界、Gateway 真实验收不进入普通 CI |

### 13.1 定向验证命令

```bash
pnpm exec tsx --test \
  tests/report-editorial-intent-compiler.test.ts \
  tests/report-editorial-planner.test.ts \
  tests/report-editorial-plan-v2.test.ts \
  tests/report-editorial-pipeline.test.ts \
  tests/report-editorial-research-plan.test.ts \
  tests/report-composition-v3.test.ts \
  tests/report-document-v4.test.ts \
  tests/standalone-html-report-renderer.test.ts \
  tests/report-document-v3-react.test.ts \
  tests/report-bundle.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/report-editorial-acceptance.test.ts \
  tests/system-capabilities.test.ts

pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
git diff --check
```

上述命令全部是离线验证。真实 Gateway composition-only 只通过显式 CLI 单独运行，不加入 `pnpm test`、`pnpm quality` 或普通 CI，也不因 Copy 质量一般自动重跑。

### 13.2 全量回归解释

最终运行 `pnpm test` 或 `pnpm quality`，但不把与报告链无关的既有失败伪装成本方案回归。当前基线已经记录 `tests/control-api-integration.test.ts` planning 链存在 3 项非报告失败；本方案的合并条件是：

- 上述报告定向测试全部通过。
- TypeScript、Registry、Knowledge 和 diff check 通过。
- 全量测试没有新增失败。

这比要求先修复全仓所有历史问题更符合本次范围，也避免过度门禁。

### 13.3 人工并排验收

每个固定案例只检查以下五点：

1. 首屏能直接说明报告回答了什么。
2. primary sections 构成连贯叙事，不是按数据库字段平铺。
3. 表格、图、看板、卡片和阶段流都能从原始结构解释其来源。
4. 大量 Evidence、风险、局限和分析底稿可以找到，但不阻塞主阅读。
5. 移动端和打印可读，没有内容消失。

不设置组件数量、固定章节数、固定 CSS 或旧 Demo 像素相似度门槛。

## 14. 错误策略

### 14.1 硬阻断

只有以下问题阻断正式报告：

- Artifact hash、Task/Plan/Attempt binding 或来源归属损坏。
- Final Review 既不是 `passed`，也不是 `passed_with_conditions`。
- 安全策略明确禁止处理或导出。
- Compiler 与 deterministic fallback 都无法生成全量 Blueprint。
- 最终 ReportDocument 的 presentation/leaf/Trace coverage 损坏。
- 已验证 Asset/Chart 身份、hash 或绑定不一致且该内容是 required。

### 14.2 降级并继续交付

以下问题不阻断报告：

- LLM 不可用、超时、输出非法或超过预算。
- Copy 缺失、文风不佳或单片段机械校验失败。
- 可选图、图片、卡片、流程或高级结构不适用。
- 某个 Renderer 不可用，但其他出口可正常生成。
- Contribution Ledger 缺失但 Deliverable/Review 合法，尤其是兼容型 research_plan。

用户只看到稳定的生成说明，例如“本次使用标准布局”“部分编辑文案使用原文”“该结构已改用列表”。内部异常、Provider、Prompt 和安全规则不得直接展示。

### 14.3 内部诊断

记录以下非敏感指标即可：

- intent input/output hash。
- model/fallback 模式、调用次数、Receipt ID 和时延。
- total、primary、supporting、appendix unit 数和 `primaryUnitRatio`。
- mandatory 与 coverage 自动补入数。
- presentation 降级数及稳定 reason code。
- Copy soft-required/accepted/rejected/missing 数。
- 四端 Semantic Manifest 集合与 ordered outline 是否一致。

不保存未脱敏 Prompt，不新增人工审批状态，也不因视觉组件数量不足标记任务失败。

## 15. 兼容、版本与发布

### 15.1 版本策略

- `ReportEditorialMaterialV1` 版本号保持不变；Phase 2 仅向后兼容扩展三类策略语义可使用的 `records` shape，旧 `record` 输入继续合法。
- 新增内部模型输出 `ReportEditorialIntentV1`。
- 最终 `ReportEditorialBlueprintV1` 保持不变。
- `ReportDocumentV4` 保持不变。
- `ReportSemanticManifestV2` 保持不变。
- Report Package v2、Standalone HTML v2、Web、Markdown 和 Zero Reader 保持不变。
- v1/v2/v3/v4 历史 ReportDocument Reader 继续保留。

这意味着新能力是 Planner 内部的编译升级，而不是下游协议迁移。

### 15.2 Feature Flag

复用现有：

- `REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED`
- `STANDALONE_HTML_BUNDLE_V1_ENABLED`
- `REPORT_V3_WRITER_ENABLED`
- `REPORT_EDITORIAL_PLANNER_V1_ENABLED`

不新增 Intent、Copy、组件或附件专用开关。体验开关关闭时走现有路径；HTML 开关可以独立关闭。

### 15.3 发布顺序

1. 合并 Phase 1，开关保持默认关闭，运行 Phase 1 离线定向测试。
2. 合并 Phase 2，开关仍默认关闭，完成聚合保真与四端结构测试。
3. 合并 Phase 3 的仓内 fixture 和验收脚本，普通 CI 只运行离线 composition-only。
4. 在测试环境开启体验开关，对两个历史 Attempt 各执行一次显式 opt-in 真实验收。
5. 测试版本保持最大报告能力开启；正式环境由发布负责人根据验收摘要和人工阅读检查显式开启体验和 HTML 开关。

### 15.4 回滚

- 关闭 `REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED`：停用 Intent、Copy 和 v4 体验路径。
- 关闭 `STANDALONE_HTML_BUNDLE_V1_ENABLED`：仅停止 HTML Bundle，不影响 Web/Markdown。
- 保留 v4 Reader：已生成的历史 Artifact 继续可读。
- 不删除、修改或 downcast 已封存 Artifact。
- 不需要数据库回滚。

## 16. 安全与数据策略

- LLM 只读取 Planner-safe Material；完整 Artifact 路径、二进制和内部审计细节不进入模型输入。
- 只有 public/internal、无 PII、无 blocked evidence 的输入允许真实模型调用；否则 deterministic fallback。
- Canonical 内容在 Prompt 中被声明为数据，不作为指令执行。
- 模型只能引用白名单 unit/leaf ID，不能生成新 ID、Evidence ID、URL、数值或优先级。
- Copy 继续执行纯文本、长度、source scope 和 protected token 检查。
- Standalone HTML 继续使用文本转义、无脚本、无网络依赖和 CSP。
- Image/Chart 只消费已验证 manifest 和安全相对路径。
- 历史 Attempt 在 composition-only 验收中保持只读，并在运行前后复核 hash。

本方案不新增 API key、账号、外部服务或运行时依赖。真实模型验收继续使用项目已有 LLM Gateway 配置。

## 17. 风险与最脆弱假设

### 17.1 最脆弱假设

本方案假设 Reviewed Canonical 中已经保留足够的语义结构和内容质量，使 Adapter 能产生 records、stages、graph、actions 或合格 narrative。

如果该假设不成立，报告层只能诚实地降级为 Narrative/List；它可以改善层级、标题和附件组织，但无法凭空恢复旧 Demo 中不存在于 Canonical 的 Persona、旅程、漏斗、指标或图片。此时应修改上游 Deliverable Schema/Skill 输出，而不是放宽报告层去读取未审 Step。

### 17.2 其他风险

| 风险 | 控制方式 |
|---|---|
| 模型仍选择过多主内容 | 记录 `primaryUnitRatio`；高密度固定案例要求非空附件，但不设置跨案例全局比例门禁 |
| 模型遗漏关键内容 | mandatory policy 自动补入，不阻断、不重试 |
| Copy 改变含义 | source scope + protected token + 有限状态词检查只能降低风险，不能证明语义等价；失败局部回退且 Canonical 主体始终保留 |
| 组件选择不合格 | 使用现有 compatibility 校验并局部线性化 |
| 大 Material 超过模型预算 | 按 11.1 的既有上限直接 deterministic fallback；不截断 Canonical、不压缩重试 |
| 四端内容相同但层级不同 | 保留集合校验，并增加验收专用 ordered outline；不扩展生产 Manifest |
| Appendix 仍然很长 | 默认 Disclosure，打印/导出保持完整 |
| Adapter 按案例膨胀 | 只按 Deliverable Schema 编写显式 Adapter，不按任务标题或案例关键词分支 |
| v5 过早出现 | 当前全部语义用 v4 表达；只有新增不可表达的持久语义才升级 |

## 18. 被拒绝的方案

### 18.1 复制旧 Demo 模板

拒绝。它会把案例章节和视觉结构固化，替换主题后仍出现不合适的表格、漏斗或旅程。

### 18.2 让 LLM 直接生成 HTML/CSS

拒绝。无法稳定保证转义、离线性、跨 Renderer 等价、leaf coverage 和组件兼容性。

### 18.3 放宽 Blueprint 的全量 coverage

拒绝。Blueprint 是发布前最后的严格中间合同，应该继续保证每个 unit 恰好一次。部分选择应存在于 Intent，而不是污染 Blueprint。

### 18.4 单独增加 Copy Writer 和 Reviewer

拒绝。会增加调用、失败状态和时延。当前一次结构化调用加局部 Copy fallback 已足够。

### 18.5 以组件数量作为验收门槛

拒绝。没有合格数据却强制出现五类组件，只会鼓励伪造结构。组件数量保留为诊断，不作为发布门禁。

### 18.6 从历史 Step 恢复旧 Demo 内容

拒绝。未审 Step 可能重复、冲突或被 Final Review 淘汰。缺失的高价值内容应进入 Canonical，而不是由报告层绕过审查。

## 19. Definition of Done

### Phase 1 完成

- 新 Intent Schema、Compiler 和定向测试已合并。
- LLM 可以部分选择主报告，Compiler 自动生成 supporting/appendix。
- 单一 placement policy、混合 Block 拆分、mandatory/system 后置条件、差集归档和 exactly-once coverage 同时成立。
- Copy soft-required、ordinal 重映射、Digest 资格、合并 Notice、局部 fallback、一次调用和无报告级重试已被测试锁定。
- 下游继续消费 Blueprint v1 和 ReportDocument v4。

### Phase 2 完成

- 六类通用原语都由真实 source shape 驱动。
- 策略 records 聚合保持全部 leaf、顺序、Trace、Evidence 和来源指针不变，旧 Material v1 输入继续合法。
- Image/Chart 现有合同已接入 Material Builder。
- Web、HTML、Markdown、Zero 的主次层级、ordered outline 和 Semantic Manifest 集合一致。
- 无专用案例组件、无组件数量门禁、无新 Schema 版本。

### Phase 3 完成

- 众筹策略、宠物食品 research_plan、纯叙述三类仓内离线 fixture 验收通过。
- 两个历史案例输入 hash 前后不变，没有重跑研究链。
- 两个历史案例的真实 Gateway 验收以显式 opt-in 完成，不进入普通 CI；每次只有一次 Planner 语义调用。
- 高密度案例具有非空完整分析附件且 primary unit 少于总 unit；其他案例只记录软诊断。
- 桌面、390px、打印和离线 HTML 检查通过。
- 测试环境用现有开关启用；正式环境保持可控回滚。
- 全量测试没有新增失败，既有非报告失败被单独记录。

## 20. 最终交付形态

完成三期后，每个受支持案例仍由同一固定流程生成，但不会被强迫长成同一种报告：

- 有矩阵时出现 Table。
- 有节点与边时出现 Graph。
- 有明确优先级时出现 Priority Board。
- 有同构记录时出现 Card Grid。
- 有明确阶段时出现 Stage Flow。
- 只有文本时保持清晰的 Narrative/List。
- 有已验证图片或 Chart 时直接消费；没有时不伪造。
- 主报告只保留决策所需内容，全部其余受审分析进入完整分析附件。

因此，最终可复用的是“编辑决策和确定性编译机制”，不是旧 Demo 的固定外观。案例内容变化时，组件数量、章节数和视觉组合可以变化；内容边界、追溯能力、降级规则和安全输出保持一致。

## 21. 执行清单

实施时按以下顺序提交：

1. `Intent contract + compiler + planner integration`。
2. `Material semantics + verified visual wiring + renderer hierarchy`。
3. `cross-case composition-only acceptance + test environment enablement`。

每个提交都必须满足本阶段定向测试、`pnpm typecheck` 和 `git diff --check`，并能通过关闭现有 Feature Flag 独立回滚。本文已闭合实施所需决策；开发过程中不再追加第二 Reviewer、自动修文循环、全局比例门禁或组件数量门禁。
