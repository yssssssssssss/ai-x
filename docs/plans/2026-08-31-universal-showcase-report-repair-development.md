# 全交付物 Universal Showcase 报告修复方案

> 状态：已实现，等待最终人工代码评审与合并授权
> 日期：2026-08-31
> 目标分支：`feat/dual-orchestration-mode`
> 目标工作区：`/Users/heyunshen/work/PROJECT/jdc/ai-x-dual-orchestration`
> 基线：`origin/main@dbe2e474e976b144756d2a7f637227634767b4b0` 加当前双引擎未提交改动
> 验收视口：仅 1440×900

## 1. 修复目标

所有新创建的研究任务，无论使用单 Skill 还是多 Skill，也无论生成哪一种正式 Deliverable，都必须使用同一套新版报告逻辑、结构和视觉格式。

统一流程：

```text
Reviewed Canonical Deliverable
→ Verified ReportDocument / Evidence
→ Universal Showcase Adapter
→ Structured Showcase Intent
→ Deterministic Compiler
→ Deterministic Renderer
→ Static Validator
→ Immutable Publication
→ Web 查看与 HTML 下载
```

单 Skill 与多 Skill 的差异只保留在规划、执行和 Canonical 内容来源。进入 Reviewed Canonical 之后，两种模式不再拥有不同的报告 Renderer、CSS 或 Web 展示结构。

## 2. 当前问题证据

### 2.1 问题任务

```text
Task: 1b4f546b-f4e2-4087-a7b4-14d9b7905265
Attempt: d90e2b6a-af6a-4b15-95d8-b184aebbdba2
Original input: 京东众筹项目的用户心智与增长策略
Mode: single_skill
Plan Contract: current-execution-plan-v2
Skill Invocation: 1
Deliverable: research_strategy_report
State: completed_with_gaps
```

任务模式分派正确，确实是单 Skill，不是误走多 Skill。

### 2.2 英文内容来源

最终 `research-strategy-synthesis` Skill Output 从标题、摘要、Direct Answer、Finding 到 Action 都以英文生成。

字符统计：

```text
Skill Output:
CJK 字符：0
拉丁字母：16197

ReportDocument:
CJK 字符：1732
拉丁字母：35443
```

Canonical 标题为：

```text
JD Crowdfunding conversion growth strategy — evidence-bounded draft
```

因此英文问题发生在 Skill 内容生成边界，不是 Renderer 翻译或样式问题。

### 2.3 Showcase 未被使用

当前 Single Skill Showcase Pipeline 在：

```text
apps/orchestrator-runtime/src/report/editorial-showcase-pipeline.ts
```

存在硬限制：

```ts
if (materialization.material.deliverableType !== 'research_plan') {
  return fromFallback(await this.dependencies.fallback.generate(input));
}
```

因此 `research_strategy_report`、竞品、VOC、设计和无障碍报告都会回退到旧报告路径。

### 2.4 Web 使用了旧报告视图

问题任务实际封存：

```text
report-document-v2
report-package-v1
```

前台 `CurrentStage4Report` 选择 `ReportDocumentView`，没有使用已确认的 Showcase HTML。

当前运行环境中以下开关也处于关闭状态：

```text
REPORT_V3_WRITER_ENABLED=false
REPORT_EDITORIAL_PLANNER_V1_ENABLED=false
REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED=false
REPORT_EDITORIAL_SHOWCASE_V1_ENABLED=false
STANDALONE_HTML_BUNDLE_V1_ENABLED=false
```

仅打开这些开关不能解决问题，因为它们对应主线另一套 Report Editorial Showcase，不是当前已确认的新版格式。

## 3. 必须覆盖的正式交付物

当前 Deliverable Registry 有 6 种 active Deliverable：

| Task Type | Deliverable |
|---|---|
| `user_research_planning` | `research_plan` |
| `research_synthesis` | `research_strategy_report` |
| `competitive_research` | `competitive_analysis_report` |
| `voc_diagnosis` | `voc_diagnosis_report` |
| `design_audit` | `design_audit_report` |
| `a11y_audit` | `accessibility_audit_report` |

两种编排模式都必须覆盖：

```text
6 种 Deliverable × 2 种 Orchestration Mode = 12 条内容生成路径
```

实现上不能复制 12 套报告代码。12 条内容路径必须汇聚到一个 Universal Showcase。

## 4. 范围和非范围

### 4.1 本次范围

- 6 种 active Deliverable。
- `single_skill` 和 `multi_skill`。
- 中文输入生成简体中文 Canonical 和报告。
- 英文输入继续生成英文报告。
- 同一个 Showcase Profile、Compiler、Renderer 和 Validator。
- Web 使用与下载 HTML 相同的已验证字节。
- 标准 ReportDocument 保留为 Canonical 派生和审计来源。
- 1440×900 桌面验收。

### 4.2 非范围

- 不回填历史 Task。
- 不重写历史 SEALED Artifact。
- 不开发 6 套独立 Renderer。
- 不开发单 Skill 和多 Skill 两套 Showcase。
- 不在 Renderer 中翻译英文内容。
- 不新增数据库表或模式字段。
- 不新增报告 Feature Flag。
- 不增加移动端验收。
- 不增加 A4 或视觉模型自动评分。
- 不允许模型直接生成 HTML、CSS、JavaScript、SVG 或 Canvas。

## 5. 核心决策

### 5.1 统一报告，保留双引擎

```text
Single Skill Plan v2 ─┐
                      ├→ Reviewed Canonical → Universal Showcase
Multi Skill Plan v3 ──┘
```

规划和执行继续独立：

- 单 Skill 使用一个 Skill 和 Plan v2。
- 多 Skill 使用 Portfolio、Contribution、Ledger 和 Plan v3。

报告呈现统一：

- 同一个 Universal Adapter。
- 同一个 Structured Intent。
- 同一个 Compiler。
- 同一个 Profile。
- 同一个 Renderer。
- 同一个 Store 和 HTML 读取入口。

### 5.2 Reviewed Canonical Package 作为通用接缝

Universal Showcase 从已封存的当前 Report Package 读取：

```text
Reviewed Canonical Deliverable
Evidence Manifest
Passed Report Review
ReportDocument v1/v2/v3/v4（如存在）
Visual Manifest metadata（如存在）
```

`EditorialReportMaterializer` 为 6 种 active Deliverable 提供显式、类型化投影，并统一生成通用 Unit、Group、Relation 和 Evidence 绑定。ReportDocument 只补充已封存的标题与视觉引用，不成为新的事实源。这样可以保留每种 Canonical Payload 的语义结构，同时避免在 Renderer 中判断业务类型。

Universal Showcase 必须保留 Question、Evidence、Finding、Summary 和 Source Pointer 绑定。

### 5.3 新报告成为必需发布物

对于新 Task：

- Canonical Deliverable 和 ReportDocument 成功后，必须生成 Universal Showcase。
- Showcase 失败时，不得在主报告区域静默显示旧版格式。
- Task 的 Canonical 仍然保留，不因展示失败丢失。
- Web 显示明确的“新版报告生成失败”，标准 ReportDocument 仅作为次级审计入口。

### 5.4 不使用 Feature Flag 决定报告格式

用户已经要求所有新任务使用新版格式，因此 Universal Showcase 不再由以下可选开关决定：

```text
REPORT_EDITORIAL_SHOWCASE_V1_ENABLED
REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED
```

这些开关可以继续控制历史实验能力，但不能控制新任务的主报告格式。

## 6. 统一语言合同

### 6.1 语言决定点

语言在 Skill／Synthesizer 调用前确定，不能在 Renderer 中翻译。

统一规则：

> User-facing semantic content must use the same primary language as `research_goal`. When the research goal is Chinese, write titles, summaries, answers, findings, recommendations, risks and validation text in Simplified Chinese. Keep English only for proper nouns, standard abbreviations, code identifiers and quoted source text.

### 6.2 接入位置

修改唯一 Skill 调用接缝：

```text
apps/orchestrator-runtime/src/skills/skill-runtime.ts
```

将语言要求加入 `SKILL_EXECUTION_PROMPT_PREFIX`，覆盖全部 active Synthesizer Skill，不分别修改 24 个 Skill。

同时在以下通用 LLM／Reviewer Prompt 中加入同一要求：

```text
apps/orchestrator-runtime/src/runners/llm-runner.ts
apps/orchestrator-runtime/src/runners/reviewer-runner.ts
```

Reviewer 只检查语言一致性，不负责翻译正文。

### 6.3 语言验收

- 中文研究目标的 Canonical 标题、摘要和 Direct Answer 以中文为主。
- 英文专有名词和缩写可以保留。
- 英文研究目标仍输出英文。
- 不新增语言规则引擎或封闭词表。
- 不对历史 Artifact 做翻译或回填。

## 7. Universal Showcase Adapter

### 7.1 输入

Adapter 输入必须是已验证、同 Task／Plan／Attempt 绑定的：

```ts
{
  frozenReportPackage: ReportPackageV1 | ReportPackageV2;
  deliverable: ResearchDeliverableEnvelope<unknown>;
  evidenceManifest: EvidenceManifest;
  review: PassedReportReviewArtifact;
  reportDocument?: ReadableReportDocument;
  verifiedVisualAssets: VerifiedVisualAsset[];
}
```

### 7.2 输出

Adapter 输出内部 `UniversalShowcaseProjectionV1`。它不是新的事实合同，只是 Compiler 的只读投影：

```text
标题
摘要
章节顺序
通用 Block
Question 绑定
Evidence 绑定
Finding 绑定
Status／Confidence
Source Pointer
Visual metadata
```

不增加数据库 Schema，不独立持久化该投影。

### 7.3 Block 映射

| Canonical 语义 | Showcase 组件 |
|---|---|
| Direct Answer | `answer-chain` |
| Executive Summary | `editorial-hero` |
| Evidence Boundary | `evidence-boundary` |
| Finding / Record | `record-grid` |
| Table / Comparison | `record-table` 或 `matrix` |
| Metric | `metric-cards`，仅真实 Metric |
| Journey / Timeline | `stage-flow` |
| Strategy Map / Relation | `relation-map` 或 `matrix` |
| Mind Model | `relation-map` |
| Principle | `narrative-list` |
| Opportunity / Priority | `priority-lanes` |
| Action Plan | `stage-flow` 或 `priority-lanes` |
| Validation | `validation-list` |
| Risk / Limitation | `risk-register` |
| Evidence Inventory | `source-register` |
| Full Canonical Detail | `analysis-appendix` |

Adapter 只根据 typed Block 和 trace 选择组件，不读取宠物、众筹、京东、VOC、设计等业务关键词。

### 7.4 Visual Asset

本期沿用已确认的离线安全要求：

- HTML 不加载远程图片。
- 不产生运行时网络请求。
- Visual Asset 只在附件中记录可验证的 Asset／Manifest 元数据。
- 不把图片 Base64 写入 HTML。

后续如果需要在设计审计报告中显示图片，单独设计 package-relative sealed Asset 方案，不在本修复中扩展。

## 8. Structured Intent

模型仍只允许一次调用，且只能决定：

- 章节顺序。
- 章节角色。
- 受控标题。
- 完整组件 ID 排序。

模型不能修改：

- Canonical 文本。
- Unit Ownership。
- Evidence。
- Finding。
- Status。
- Confidence。
- Priority。
- 数字和日期。
- HTML、CSS 或 DOM。

模型失败、Schema 失败或身份漂移时，Compiler 使用 deterministic Intent。不得进行第二次 Repair 调用。

## 9. Compiler 和 Renderer

### 9.1 Profile

新增统一 Profile：

```text
universal-editorial-showcase-v1
```

它继承已确认的：

- 1440px 桌面层级。
- 左侧目录。
- Editorial Hero。
- 非卡片墙。
- 不同组件使用不同 DOM 和视觉语言。
- 状态颜色只表示 epistemic status。
- 完整附件与来源表。

不保留：

```text
single-skill-editorial-showcase-v1
```

作为新任务的主 Profile。旧 Profile 只保留用于历史 Golden 对照。

### 9.2 Compiler 不变量

- 每个必需 Canonical Block 恰好一次 owned。
- 每个 Direct Answer 恰好一次进入正文。
- 未进入正文的合法内容进入 Appendix。
- Evidence、Finding 和 Source Pointer 不悬空。
- Metric 只能来自明确的 Metric Block。
- Priority 只能来自 Canonical Priority。
- 不用数量、覆盖率或装饰百分比冒充业务指标。
- 不按 Deliverable 类型写标题分支。

### 9.3 Renderer 安全

Universal Renderer 禁止：

- JavaScript。
- iframe。
- 表单。
- 远程字体。
- 远程样式。
- SVG 和 Canvas。
- event handler。
- `@import` 和 `url()`。
- 运行时网络请求。

## 10. Publication 和 Store

### 10.1 统一 Publication

所有新任务发布：

```text
Universal Presentation Spec
Universal Render Manifest
Universal Validation
Universal Showcase HTML
Universal Publication Manifest
```

Manifest 必须绑定：

- Task ID。
- Plan Version ID。
- Attempt ID。
- Orchestration Mode。
- Deliverable Type。
- Canonical Deliverable Artifact／hash。
- ReportDocument Artifact／hash。
- Evidence Manifest Artifact／hash。
- Review Artifact／hash。
- Profile、Compiler 和 Renderer 版本。

### 10.2 Immutable Showcase Store

生产 Web 与 manual CLI 共用同一个 `EditorialShowcaseStore` 合同。Store 使用请求级锁、暂存目录原子重命名、`0700／0600` 权限以及读取时全量重编译、重渲染和 hash 比较，目录统一位于 `universal-editorial-reports`，不再按单 Skill／多 Skill 分叉。

Canonical Report Package 继续保存在 Control Artifact Store 中；Universal Showcase 作为绑定该 Package 的不可变派生 Sidecar 保存，不写回或替代 Canonical。

### 10.3 读取

Owner-only HTML API 只读取已封存 Universal Showcase Artifact。不得按 `single_skill`／`multi_skill` 选择不同 Store。

## 11. Web 主报告

### 11.1 主视图

任务完成后，Report 页面默认展示 Universal Showcase，不再默认展示旧 `ReportDocumentView`。

为保证 Web 和下载使用同一份已验证 HTML，Web 读取同一 Artifact，并通过隔离的 Shadow DOM 挂载其中的静态 Style 和 Body 节点。不得使用 iframe，不得创建第二套 React Renderer，也不得在浏览器修改 Canonical 内容。

### 11.2 下载

下载文件与 Web 查看使用同一 Artifact 和同一 hash，不重新编译。

### 11.3 状态

- `ready`：展示新版报告。
- `failed`：显示明确失败信息和重试入口。
- 不把旧版报告静默伪装成新版报告。

## 12. 实施阶段

每个阶段可以独立合并，后续阶段未完成时不破坏 Canonical 和现有任务读取。

### Phase 1：语言一致性

修改：

```text
skill-runtime.ts
llm-runner.ts
reviewer-runner.ts
相关测试
```

完成条件：

- 中文 Goal 的 6 种 Synthesizer Prompt 都包含中文输出约束。
- 英文 Goal 不被强制翻译。
- 重跑问题任务时 Skill Output 以中文为主。

### Phase 2：Universal Adapter

新增一个 Universal Adapter，读取 `ReadableReportDocument` 和 trace，不读取业务关键词。

完成条件：

- ReportDocument v2/v3/v4 均可投影。
- 6 种 Deliverable fixture 均能生成完整 Projection。
- 单／多 Skill 对相同 Canonical 得到相同 Projection Shape。

### Phase 3：统一 Compiler 和 Renderer

将已确认 Showcase 组件迁移到统一 Profile，并补齐 ReportDocument typed Block 映射。

完成条件：

- 6 种 Deliverable 均生成有效 HTML。
- 12 条模式／交付路径使用同一个 Renderer Version。
- 无卡片墙、无网络、无脚本。

### Phase 4：统一不可变 Publication

统一 `EditorialShowcaseStore` 的生产和 CLI 路径，新任务在首次读取新版报告时按不可变 Request Key 生成并封存 Universal Showcase；后续读取必须复用并重新验证同一 Publication。

完成条件：

- 生产只生成一个主 Showcase Publication。
- Single Skill 和 Multi Skill 不再选择不同报告 Store。
- Publication 失败不会覆盖 Canonical。

### Phase 5：Web 主报告切换

修改 Report 页面，使 Universal Showcase 成为默认视图；旧 ReportDocument 退到次级审计入口。

完成条件：

- Web 查看和 HTML 下载 hash 一致。
- 1440×900 无横向溢出。
- 单 Skill 和多 Skill 页面外观一致。

### Phase 6：12 路径验收

运行：

```text
6 Deliverables × single_skill
6 Deliverables × multi_skill
```

其中至少：

- `research_strategy_report` 使用真实中文任务和真实 Gateway。
- 一条 Multi Skill 路径使用真实 Tool 和 Contribution Ledger。
- 其余路径使用冻结的真实／审校 fixture 做确定性回归。

## 13. 预计修改范围

预计修改 15 至 22 个文件。

核心文件：

```text
apps/orchestrator-runtime/src/skills/skill-runtime.ts
apps/orchestrator-runtime/src/runners/llm-runner.ts
apps/orchestrator-runtime/src/runners/reviewer-runner.ts
apps/orchestrator-runtime/src/report/universal-showcase-source-adapter.ts
apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts
apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts
apps/orchestrator-runtime/src/report/editorial-showcase-validator.ts
apps/orchestrator-runtime/src/report/report-editorial-showcase-publication.ts
apps/orchestrator-runtime/src/report/report-composition-service.ts
apps/agent-api/src/control-runtime.ts
apps/web/src/components/stages/CurrentStage4Report.tsx
packages/api-contract/editorial-showcase.ts
orchestrator/report-presentations/universal-editorial-showcase-v1.yaml
```

测试集中在 4 个聚合文件，不为每种 Deliverable 新建一套测试目录。

## 14. 测试矩阵

### 14.1 语言

- 中文 Goal → 中文 Canonical。
- 英文 Goal → 英文 Canonical。
- 中文内容中的 URL、Evidence ID、JTBD、VOC、P0/P1/P2 保持原样。

### 14.2 Adapter

- 6 种 Deliverable。
- ReportDocument v2/v3/v4。
- current_text 和 multimodal。
- 无 Evidence、部分 provisional、完整 supported。
- 长中文、长 URL 和特殊字符。

### 14.3 Compiler

- exactly-once Block Ownership。
- 未选 Block 进入 Appendix。
- Evidence／Finding／Summary 引用完整。
- 非法 Metric 和 Priority 不进入对应组件。

### 14.4 Renderer

- 组件 DOM 不同。
- 无脚本、iframe、远程资源、SVG 和 Canvas。
- CSP 固定。
- 1440×900 无页面级横向溢出。

### 14.5 Publication

- Task／Plan／Attempt／Mode／Deliverable 绑定。
- 原子发布。
- 篡改、额外文件和 hash 漂移失败。
- Web 与下载读取同一 Artifact。

### 14.6 回归

- Plan v2／v3 执行不受影响。
- Contribution Ledger 不受影响。
- Canonical Deliverable 不受影响。
- 历史 Report Package v1/v2/v3 继续可读。

## 15. 真实验收

### 15.1 必须重跑的问题任务

```text
京东众筹项目的用户心智与增长策略
```

预期：

- `single_skill`。
- Plan v2。
- Canonical 主体为简体中文。
- Universal Showcase ready。
- Web 默认展示 Universal Showcase。
- 下载 HTML 与 Web hash 一致。
- 结构、格式和视觉语言与已确认新版一致。

### 15.2 多 Skill 对照

使用相同研究目标创建 `multi_skill` Task。

预期：

- Plan v3。
- Contribution／Ledger 完整。
- Canonical 内容可以不同。
- Universal Showcase Profile、DOM 语法、CSS 和 Viewer 与单 Skill 相同。

## 16. 失败策略

| 失败 | 行为 |
|---|---|
| Language instruction 未遵守 | Review 退回修订，不在 Renderer 翻译 |
| Universal Adapter 不支持 Block | Publication 失败并显示具体 Block kind |
| Intent 无效 | 使用 deterministic Intent |
| Renderer／Validator 失败 | 不发布 HTML，Canonical 保留 |
| Web 读取 hash 不一致 | 拒绝展示和下载 |
| 历史 Task 无 Universal Showcase | 保持历史视图，不自动回填 |

## 17. 回滚

回滚 Universal Showcase 主视图时：

- 停止为新 Task 发布 Universal Showcase。
- Canonical、ReportDocument、Report Package 和历史 Artifact 不删除。
- Web 可以临时恢复结构化审计视图。
- 不回滚数据库。
- 不改变单／多 Skill Plan 和执行合同。

正式发布后不保留长期双写。回滚只用于故障恢复，修复后重新启用统一报告。

## 18. Definition of Done

- 6 种 active Deliverable 全部接入 Universal Showcase。
- 单 Skill 和多 Skill 使用同一个 Profile、Compiler、Renderer 和 Viewer。
- 中文输入生成中文 Canonical 和中文报告。
- 问题任务重新生成后不再以英文为主。
- `research_strategy_report` 不再 fallback 到旧版 ReportDocument 主视图。
- Web 查看和下载使用同一 HTML Artifact。
- 12 条路径的自动化矩阵通过。
- 单 Skill 与多 Skill 各完成一条真实任务。
- 1440×900 验收通过。
- `pnpm quality` 通过。
- Web Production Build 通过。
- `git diff --check` 通过。
- 无未授权 commit、merge、push 或部署。

## 19. 推荐实施顺序

1. 先修语言合同并重跑问题任务，确认 Canonical 中文。
2. 实现 Universal Showcase Adapter。
3. 将已确认组件和 Profile 升级为 universal 版本。
4. 统一 Compiler、Renderer 和 Validator。
5. 接入统一不可变 Showcase Publication。
6. Web 切换为新版主报告。
7. 运行 6 种 Deliverable fixture。
8. 运行单／多 Skill 12 路径矩阵。
9. 重跑问题任务和一条真实多 Skill Task。
10. 运行最终质量门禁，等待评审和合并授权。

## 20. 实施结果

截至 2026-08-31，本方案已完成以下实现：

- 统一语言约束已进入 Skill、LLM、Reviewer、Deliverable Composer 和 Final Report Review 边界。
- `EditorialMaterial` 已支持全部 6 种 active Deliverable。
- `research_strategy_report` 已增加显式 Direct Answer、Strategy Matrix、Priority Action、Validation 和 Risk 投影。
- Source Adapter、Compiler、Renderer、Validator 和不可变 Store 已统一为 `universal-editorial-showcase-v1`。
- `single_skill` 与 `multi_skill` 共用同一个 owner-bound HTML 读取入口，不再按模式选择不同 Renderer。
- Stage 4 默认展示 Universal Showcase，旧结构化报告仅作为显式审计视图。
- Universal Source Reader 已支持 Report Package v1 和 v2；v3 通过其 canonical v2 根读取。
- Showcase 失败会显式返回错误，不再静默伪装成旧版报告。

真实验证：

```text
中文单 Skill Task：035aac9f-f375-4392-bf49-13ceb6d45765
Attempt：9f040934-3e3d-4ace-b4d5-64f513813bd7
State：completed
Plan：current-execution-plan-v2
Universal Showcase：ready
HTML：sha256:38e2734c20d46d8b5d9904bf8d58896ffd3c01f0642f563c817de7c39006d4e1
语言：zh-CN
组件：15
正文单元：218
审计单元：20
```

```text
多 Skill Task：355d42d2-8f45-4f9d-9366-715ed9e5c7ad
Plan：current-execution-plan-v3
Universal Showcase：ready
Profile：universal-editorial-showcase-v1
HTML：sha256:66466407dc596340a970977341a973be873fd4d4b3d60fdb2738ec9a32d0a60c
```

最终合并、推送和目标环境部署仍需用户明确授权。
