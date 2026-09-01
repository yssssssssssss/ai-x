# ADR-0008：采用可复用编辑型报告流水线

- 状态：Accepted（2026-08-28 通用编辑基础 Phase 1 补充；生产摘要相关条款由 ADR-0010 取代）
- 日期：2026-08-27
- 上游决策：ADR-0005、ADR-0006、ADR-0007
- 实施方案：
  - `docs/plans/2026-08-26-reusable-editorial-html-report-development.md`
  - `docs/plans/2026-08-27-universal-editorial-report-foundation-development.md`
  - `docs/plans/2026-08-30-editorial-showcase-publication-development.md`

## 背景

当前 `research_strategy_report` 会把已经审校的矩阵、关系和行动字段压平成
`AnswerBlock.text + items[]`。Canonical 内容没有被删除，但表格单元格、图节点与边、
优先级及行动字段失去机器可读的展示语义。Web、Markdown 和 Zero 因而只能各自从
扁平字符串中恢复阅读结构，且 Web 会把所有 `items` 统一放进“展开详细要点”。

ADR-0005 当时决定继续使用 ReportDocument v2；新的离线 HTML、跨 Renderer 等价性和
最小语义单元溯源要求已经超出 v2 的表达能力。继续向 v2 偷加字段会破坏严格 Reader，
继续解析字符串前缀则会把数据合同藏进文案。

项目随后已经完成 v3、确定性 Material → Blueprint → Projector、Standalone HTML 与
A-model 的一次真实历史案例 composition-only 验收。该验收证明了内容无损和引用式结构
可行，也暴露了新的差距：Planner 被禁止生成标题、摘要、导语和过渡，Renderer 没有真正
消费 `style`、`density`、`prominence` 与 `graph.variant`，产物仍是工程验收件而不是旧 Demo
所代表的编辑型阅读体验。因此本 ADR 增加 A-experience 修订；已实施的 v3 基线继续保留。

## 决策

1. 保留已经完成的 `ReportDocument v3` 与 v1/v2 Reader。v3 的 `record-table`、`graph`、
   `priority-board`、Section `view`、Block `visibility` 及既有 Artifact 不迁移、不重写。
2. Reviewed Canonical Deliverable 仍是唯一分析事实源。Material Builder 把 Canonical 转为
   presentation unit 与 leaf trace；Projector 继续验证 exactly-once ownership、完整 coverage
   与 Trace，模型不得修改 Canonical、Evidence、状态、置信度或行动优先级。
3. 当前不按原 B→C→D→E 顺序推进，先完成 A-experience：Renderer 表现修复、两个通用
   Block、一次 LLM 的结构+文案、最小 `research_plan` Adapter 和同素材 composition-only 验收。
   已验证图片/Chart 消费与主动视觉生产延后。
4. `ReportEditorialPlanner` 在 A-experience 路径中使用一次 structured call，同时输出部分选择式
   `ReportEditorialIntentV1` 与受控的报告标题、执行摘要、章节标题、导语、相邻章节过渡和 Block
   摘要。Intent 只描述 primary/supporting 主报告；确定性 Intent Compiler 补齐 mandatory body、
   system supporting 和完整 appendix，并继续输出严格的 `ReportEditorialBlueprintV1`。
5. 不增加独立 Copy Writer、第二 Reviewer 模型、自动改写循环或逐报告人工审批。Intent Schema、
   unit 引用或编译后 coverage 失败时整份回到遵守同一 placement policy 的 deterministic Blueprint；
   单个 fragment 的 source scope、ordinal 重映射、长度或机械漂移检查失败时只回退该 fragment，
   其余报告继续生成。
6. A-experience 使用下一严格 ReportDocument 版本保存 Copy provenance，并只新增
   `card-grid` 与 `stage-flow`。前者承载已有同构记录，后者只承载已有明确顺序、stage/phase/time
   或线性关系；缺少结构时确定性降级，不从自然语言猜测。
7. Web 与 Standalone HTML 必须真正消费 `style`、`density`、`prominence` 和 `graph.variant`；
   Markdown/Zero 保留等价层级与线性替代。核心结论、行动、风险、局限和待解决摘要默认可见，
   Evidence、provenance 与完整审计默认折叠；打印和导出不得丢内容。
8. `research_plan` 通过小型显式 Adapter 读取正式已审 Final/Payload、Evidence 和 Review binding，
   不从未审 Step 补写正文。验收锁定历史输入 hash，只重跑报告 composition，不重跑研究链。
9. Web、Standalone HTML、Markdown 和 Zero 继续共享 traversal 与 Semantic Manifest；各端可以
   采用不同视觉形式，但实际访问的 presentation、leaf、Copy Slot、Asset、Audit 和 Notice 集合
   必须等价。Standalone HTML 仍是确定性、无网络、无模型的末端 Renderer。
10. 只有事实源/hash/binding 损坏、越权、安全问题、Final Review 未通过或 required coverage
    缺失才阻断报告。模型、文案、可选媒体或表现增强失败优先降级并可用稳定 Notice 提醒。
11. Final Review 通过后可以生成独立 Editorial Showcase。它是发布模块，不是 Research Skill，
    不读取未审 Step，也不成为新的事实源。
12. Showcase 复用同一次 Report Editorial Planner structured call，通过 `ReportEditorialIntentV2`
    返回受约束的章节与组件选择。模型仍不得输出 HTML、CSS、JavaScript、状态、置信度、
    Evidence 或业务数字。
13. 确定性 Showcase Compiler 输出 `EditorialPresentationSpecV1`，负责 leaf exactly-once ownership、
    Evidence 绑定、状态与置信度派生、Simulation 隔离和完整分析附件。确定性 Renderer 使用
    `editorial-showcase-v1` Profile 生成 desktop-only、无图片、无网络 HTML。
14. `editorial-showcase-v1` 是可迁移的 Token、组件家族和组合语法，不依赖生成参考设计的模型，
    也不依赖任何 `run-workspaces` 案例文件。不同 Material shape 必须产生内容驱动的有序组件组合。
15. `ReportPackageV3` 以一个已完整验证的 Package V2 作为 Canonical 根，并增加 Showcase Spec、
    Showcase HTML 和 preferred HTML。V1/V2 Reader 继续保留，Showcase 失败时使用 Canonical HTML。

## 结果

### 收益

- 结构由受审数据驱动，Renderer 不再解析自然语言前缀猜测表格或关系。
- 相同 ReportDocument 可以稳定生成 Web、离线 HTML、Markdown 和 Zero。
- 一个模型调用完成安全的引用式结构和受控编辑文案，避免多模型链的时延与失败状态。
- 单个文案 fragment 失败不会拖垮整批文案或整份报告。
- 每个最小展示项可以回溯到不可变 Artifact、JSON Pointer、Evidence 和 Review 状态。

### 成本

- 必须同时维护 v1/v2/v3 Reader，并为 v3 增加共享合同、Schema、visitor 和 Renderer。
- Report Package 需要升级以保存 HTML 状态和不可变资源快照。
- 新 Writer 只能按 Deliverable 开关逐步启用，不能一次性迁移全部历史报告。
- A-experience 需要维护 Intent v1、ReportDocument v4 Reader，以及两个新 Block 的四端表示。
- 确定性检查只能发现机械漂移，不能证明自然语言绝对等义；必须保留 source leaf 追溯与必要 Notice。

## 被拒绝的方案

### 继续扩展 ReportDocument v2

拒绝。v2 Reader 无法识别新的结构和 leaf trace；原地扩展会破坏严格版本语义。

### 复制众筹 Demo 作为固定模板

拒绝。案例专用章节和中间 Step 内容会绕过 Canonical 与 Final Review，替换案例后也无法
可靠复用。

### 继续只调整结构-only Planner Prompt

拒绝。它无法生成标题、摘要、导语和过渡，也无法修复 Renderer 不消费现有样式字段的问题。

### 独立 Copy Writer + 第二 Reviewer 模型

拒绝作为当前方案。它增加调用、Artifact/Receipt、整批失败状态和发布门禁，超出测试版本
所需风险控制。source leaf、机械漂移检查和单 fragment fallback 足以支撑当前纵切片。

### 让 LLM 输出 HTML 或不受约束地全文重写

拒绝。模型只能输出严格 JSON 和授权 Copy fragment；HTML/CSS 仍由确定性 Renderer 生成。

## 兼容与回滚

- v1/v2 Reader、历史 SEALED Artifact 和原报告路径保留。
- Reader 先发布，Writer 通过 `report_v3_writer` 按 Deliverable 开启。
- 关闭 Planner 后使用确定性 Blueprint；关闭 v3 Writer 后回到原 v2 路径。
- A-experience Reader 先于 Writer；`REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED` 默认关闭，关闭后回到 Blueprint v1 / ReportDocument v3。
- 单 Copy fragment 失败使用系统标题、Canonical 摘要或省略 lead/transition；不重试、不回滚结构。
- HTML 或 Zero 可独立关闭，不影响 Canonical、ReportDocument、Web 或 Markdown。
- `REPORT_EDITORIAL_SHOWCASE_V1_ENABLED` 默认关闭，并且只有与 Editorial Experience、Standalone HTML Bundle 同时开启时才发布 Showcase。
- 关闭 Showcase 开关后继续生成 ReportPackage V2；已生成的 ReportPackage V3 仍可通过其 Canonical Package V2 根读取。
- 回滚不得修改、删除或 downcast 已封存 Artifact。

## Phase 1 实施状态（2026-08-28）

通用编辑基础方案的 Phase 1 已在当前工作树实现并通过本地离线验证：Planner 已切换为部分
Intent 合同，Compiler 负责 placement 补全、混合 Block 拆分、Copy ordinal 重映射和严格
coverage；Copy 缺失或拒绝使用合并 Notice，deterministic fallback 继续遵守同一 placement
policy。该实现尚未提交，Phase 2 的媒体/富结构接线和 Phase 3 的跨案例验收仍保持待实施。

## Editorial Showcase 实施状态（2026-08-30）

Showcase 合同、Intent v2、Compiler、portable Profile、Renderer、Publication、ReportPackage V3、
读取与恢复、owner-bound 下载入口和 desktop/print 验收已在当前工作树实现。普通模型失败使用
确定性 Spec；Showcase 写入失败会补偿部分 Artifact、记录 execution gap，并在 Package V3 中标记
unavailable，Canonical Package V2 保持可用。封存 Spec 绑定 Evidence Manifest Artifact ID、内容
hash 与 semantic hash，V3 Reader 会重新核验；一次真实 Gateway Intent v2 composition-only 验收
已通过 single-call、Receipt 和模型漂移检查，测试环境三开关发布 canary 仍待执行。

生产代码、普通 CI 和 Renderer 均不读取 GPT-5.6 样例或 `run-workspaces`。固定通用 fixture、
`showcaseOutlineSignature` 与 Chromium 几何检查用于验证内容驱动组合、迁移性和离线输出；
京东众筹、宠物食品和纯叙述三类 canary 已生成不同 signature。

## Canonical inventory 状态

截至 2026-08-27，众筹、定量、纯叙述三类真实 Canonical inventory 尚未全部完成并冻结
Deliverable/Review hash。该工作由报告流水线维护者在开启富结构 Writer 前补齐；它是
`record-table`、`graph`、`priority-board` 默认启用的质量依据，不是 paragraph/list A-core
或 A-experience composition-only 验收的人工审批门禁。

因此当前发布策略固定为：v3 Reader 可用；v3 Writer 与 Standalone HTML Writer 默认关闭；
即使显式开启 v3 Writer，三种富结构 Writer 仍默认关闭，使用无损线性投影并产生
`visualization_linearized` Notice。inventory 完成后只分别开启已有真实 source shape 支撑的
结构，不因单个案例表现良好而整体放开。该状态不阻止锁定同一历史素材验证 Renderer、
Copy fragment、`card-grid`、`stage-flow` 和 `research_plan` Adapter；没有 source shape 时必须
线性降级，不得从未审 Step 恢复内容。
