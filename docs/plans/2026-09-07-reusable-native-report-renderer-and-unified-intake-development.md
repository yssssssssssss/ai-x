# 可复用统一问询、材料输入与确定性报告 Renderer 开发方案

> 状态：In Progress，已按“最小设计、避免重复审核与校验”收敛
> 日期：2026-09-07
> 首条纵切：`industry-market-analysis` 中档、独立 5 Tab HTML 报告
> 适用范围：新建 Task 与用户主动 Replan；`single_skill`、`multi_skill`
> 基础架构：ADR-0013 原版 Skill Package Runtime
> 历史策略：不迁移、不回填、不建立兼容 Adapter；本分支未发布的 Native 合同允许直接调整

## 1. 决策摘要

采用：

```text
共享平台能力
├── 全中文用户交互
├── 一次性聚合问询
├── Markdown/TXT/CSV/图片 Artifact
├── NativeReportDocument
├── 确定性 HTML Renderer
├── 在线 Asset URL
└── ZIP 离线报告

Skill 自有能力
├── 专业方法和结论
├── 需要哪些材料
├── Tab、章节和内容语义
└── 缺失材料时的 Gap
```

`industry-market-analysis` 是第一条纵切，但 Renderer 不包含 Skill ID 特判。Industry 输出当前五个 Tab：

```text
行业洞察
品类差异资产
竞品分析
体验诊断
设计策略
```

报告无 JavaScript 和动画。在线报告使用 owner-bound Asset URL；离线报告使用 `index.html + assets/` ZIP。本阶段不做单文件 Base64 HTML。

### 1.1 设计规模检查

本需求确实新增一个共享 Renderer 抽象，并横跨输入、API、Web 和报告链。为避免平台化，首版只做：

1. 一种新文档输入 `document`；
2. 复用已有 CSV 和 Visual Artifact；
3. 一个小型 `NativeReportDocument`；
4. 一个共享 Renderer；
5. 一个 Industry 纵切；
6. 一个第二 Skill 复用证明。

不做模板 DSL、插件、页面编辑器、主题系统、PDF、JavaScript 或多套运行模式。

## 2. 已确认需求

1. 使用当前五 Tab，不复刻旧六 Tab；
2. 不使用 JavaScript 动效；
3. 图片长期保存为 Binary Artifact，不保存 Base64；
4. 浏览器上传改为 multipart；
5. Gateway 仍可在单次请求内临时使用 data URL，不持久化；
6. 在线 HTML 使用受权 Asset URL；
7. 离线下载使用 ZIP 相对资源；
8. 不接受本地绝对路径；
9. Skill Package 不包含真实内部材料，统一问询时向用户收集；
10. 支持 Markdown、TXT、CSV 和图片；
11. 不支持 PDF 和 Office 文件；
12. 所有用户可见名称、问题、状态、错误和下载名使用中文；
13. 补充信息尽量一次提交，不分 Skill、多阶段反复询问；
14. Demo 只提供视觉框架，真实报告只填本次真实数据；
15. 整体能力可复用于其他 Skill，不做 Industry 补丁。

## 3. 当前基础与真实缺口

### 3.1 已有能力

- `industry-market-analysis` 为 `ready`、`active`；
- Package 有 28 个文件；
- 中档请求可选中 16 份 Reference；
- 当前 ReportPolicy 可识别为 `skill_defined / html`；
- Tavily 已绑定；
- Joyspace 已绑定；
- 图片会以 Binary Artifact 保存；
- CSV 已有 Dataset Store、列概览和行级 Evidence；
- Native Result / FinalReport、Single/Multi、恢复和 owner-bound API 已存在。

### 3.2 仍缺

- 用户 Markdown/TXT 没有一等输入；
- Web 图片仍先转 data URL 再放入 JSON；
- Task 澄清、方向和材料可能多轮出现；
- UI 仍可能展示英文 ID 或内部术语；
- Native HTML 由模型直接输出，DOM/CSS 不稳定；
- 图片 Artifact 不会确定性地进入报告章节；
- 模型若回写完整 HTML + Base64，容易超长；
- JavaScript 被清理后，模型生成的 Tab 可能失效；
- `o2-ge-search` 尚未绑定；
- 当前 CSV UI 仍有匿名化确认，不符合已确认的业务内容直出规则。

### 3.3 参考 HTML 仅作视觉基准

参考文件约 1.41 MB，其中约 1.21 MB 为 9 张 Base64 图片；包含 28 个章节、27 张表、6 个旧 Tab 和一段 Tab JavaScript。新实现不提交或读取该 Downloads 路径，不复制其业务内容，只用合成 Fixture 覆盖同类组件。

## 4. 简化原则

### 4.1 不新增 v2 双轨

当前 Native 能力仍在本开发分支，尚未形成需要兼容的外部发布合同。本阶段直接调整现有：

```text
native-skill-execution-plan-v1
native-skill-result-v1
native-final-report-v1
```

增加 `document` 和 `report_document` 形态，不新建 Plan/Result/FinalReport v2，不写迁移器，不保留两条新任务路径。

### 4.2 只校验一次

| 边界 | 唯一校验 |
|---|---|
| 文件上传 | owner、冻结 role、扩展名/MIME、大小、UTF-8 或 CSV 语法 |
| Artifact 读取 | Task/Plan 绑定、Hash、SEALED |
| ReportDocument | 结构、Source ID、Asset ID |
| Renderer | 信任已解析 ReportDocument，只做转义和输出 |
| API 下载 | owner 校验 |

禁止在 Planner、Engine、Renderer、API 各重复一遍同类校验。

### 4.3 不增加审核链

- 不新增 Report Reviewer；
- 不新增模型自评；
- 不新增多轮全文 Repair；
- 不要求每个 Phase 做独立人工评审；
- Renderer 失败只重渲染；
- 最终只做一次 Industry 真实路径和一次第二路径 Smoke。

### 4.4 Skill Package 保持只读

不向 Package 写平台 Manifest、Layout JSON 或执行代码。Skill 的 Tab/章节语义来自本次冻结的原版说明和模板；平台只定义通用 ReportDocument 与 Renderer。

## 5. 目标流程

```text
用户原始需求
    ↓
任务理解 + 暂定 Skill 匹配
    ↓
聚合任务问题、Skill 输入、材料和输出偏好
    ↓
一次中文补充表单
    ├── 普通字段
    ├── Markdown/TXT
    ├── CSV
    └── 图片
    ↓
Artifact + ResolvedPlanInputs
    ↓
最终 Plan 与用户确认
    ↓
Tool / Knowledge / Skill
    ↓
NativeSkillResult
    ├── Markdown，或
    └── NativeReportDocument
    ↓
共享 Renderer（无 LLM）
    ├── Online HTML
    └── ZIP
    ↓
NativeFinalReport
```

## 6. 最小合同调整

### 6.1 输入类型

在现有合同中直接增加：

```ts
type SkillInputKind = 'value' | 'document' | 'visual' | 'dataset';
```

映射：

```text
.md / text/markdown → document
.txt / text/plain   → document
.csv / text/csv     → dataset
image/*             → visual
普通表单值          → value
```

### 6.2 Document Artifact

每个文件只保存一份 Raw Text Artifact，不再保存第二份 Model View Artifact；多文件输入另有一个轻量 Manifest 只保存引用。模型视图在执行时从 Raw Artifact 确定性生成：

```ts
interface DocumentInputManifestV1 {
  version: 'document-input-manifest-v1';
  taskId: string;
  planVersionId: string;
  ownerUserId: string;
  gateKey: string;
  multiple: boolean;
  documents: Array<{
    artifactId: string;
    fileName: string;
    mediaType: 'text/markdown; charset=utf-8' | 'text/plain; charset=utf-8';
    byteSize: number;
    contentSha256: string;
  }>;
}
```

沿用现有边界：Raw 最大 10 MiB，模型视图最大 512 KiB。超出模型视图时形成一个 Gap，不新增审批或修复流程。

### 6.3 复用现有输入引用

不新增通用 `MaterialReference` 总账。继续使用现有 Gate、Artifact ID 和 `ResolvedPlanInputs.valueRef`：

```text
artifact:<artifact-id>
```

visual / dataset / document 仅在各自 Store 中解释。

### 6.4 NativeReportDocument

```ts
interface NativeReportDocumentV1 {
  version: 'native-report-document-v1';
  title: string;
  subtitle?: string;
  summary?: {
    conclusion: string;
    findings: string[];
    actions: string[];
  };
  tabs: NativeReportTab[];
  assetIds: string[];
}

interface NativeReportTab {
  id: string;
  title: string;
  sections: NativeReportSection[];
}

interface NativeReportSection {
  id: string;
  title: string;
  blocks: NativeReportBlock[];
}
```

首版 Block 收敛为 7 类：

```text
markdown       段落、列表、说明块
table          对比、清单、口径
metric-group   指标卡
image          图片和说明
quadrant       象限
timeline       时间线和优先级
wireframe      灰阶页面结构
```

不单独建 `callout`、`list`、`priority-list`；分别由 Markdown 和 Timeline 表达。

### 6.5 NativeResult / FinalReport

现有 `NativeSkillResult` 增加可选的 `reportDocument` 与对应 Hash；`primary` 保存确定性渲染后的 HTML，Markdown Skill 保持现状。新任务不再让模型直接返回完整 HTML。

现有 `NativeFinalReport` 保存同一 ReportDocument 和 Hash；最终 HTML 继续封存为 Artifact，ZIP 在下载时由已封存的 ReportDocument 与图片确定性生成，不再持久化一份重复 Bundle。

## 7. 一次性中文问询

### 7.1 用户只看到一次补充表单

内部顺序：

```text
理解需求
→ 暂定方向和候选 Skill
→ 读取候选输入要求
→ 去重
→ 一次展示
→ 用户一次提交
→ 最终规划
```

需求足够完整时零问询。若暂定 Skill 在最终规划中变化，只有新增的必需字段可定点补问；可选字段直接形成 Gap，不开启第二轮完整表单。

### 7.2 表单中文分组

```text
分析范围
京东与竞品材料
内部业务材料
数据文件
输出要求
可选材料处理
```

Industry 中档表单一次展示：

- 品类、子类、排除项；
- 档位、主聚焦、次聚焦；
- 竞品名称；
- 京东截图；
- 竞品截图；
- 内部 Markdown/TXT；
- 内部指标 CSV；
- 用户研究 CSV；
- 在线 HTML + ZIP；
- 每项“暂不提供，继续生成”。

### 7.3 中文展示

内部 ID 不改。展示名按：中文 frontmatter `title` → 中文 H1 → 中文 description 首句 → “专业分析能力”。API ViewModel 和 Web 直接输出/显示中文，不建立手写 Skill 别名表。

用户边界不得出现：`needs_binding`、`Contributor`、`Artifact ID`、`JSON Pointer`、`Tool Binding`、内部路径或 Provider 原始错误。

## 8. 文件与图片处理

### 8.1 统一上传

前端一个“确认并继续”动作完成所有文件上传和 Plan 确认。网络层复用三条已有语义明确的 multipart 路由，不再额外增加一个需要二次分派的通用材料协议：

```text
POST /api/control-tasks/:taskId/plans/:planVersionId/inputs/:role/document
POST /api/control-tasks/:taskId/plans/:planVersionId/inputs/:role/dataset
POST /api/control-tasks/:taskId/plans/:planVersionId/inputs/:role/visual
```

服务端根据冻结 PendingInput 校验 route 对应的输入类型，客户端不能自行提升用途。

### 8.2 Markdown/TXT

- 严格 UTF-8；
- 保存原始文本 Artifact；
- 不执行 Markdown HTML 或文件内指令；
- 执行时生成有界模型视图；
- 不支持 PDF/Office；
- 用户错误统一中文。

### 8.3 CSV

复用 `DatasetInputGateStore`，不重写 Parser、列概览、行级 Evidence 和模型预算。Stage 2 把 CSV 放入同一材料表单，并移除匿名化强制复选框。

### 8.4 图片

替换当前前端 `FileReader.readAsDataURL → JSON` 为 multipart bytes。后端继续保存 Binary Artifact，Gate 只保存 Artifact 引用。

Gateway 当前需要 `image_url`，执行时允许从 Artifact 临时构造 data URL；请求结束后丢弃，不写入 Plan、Gate、数据库或报告。

### 8.5 报告图片

```text
Online HTML → /api/control-tasks/:taskId/assets/:assetId
ZIP         → assets/<content-hash>.<ext>
```

不支持本地绝对路径，不支持用户远程 URL 冒充上传。本阶段不生成 Base64 单文件 HTML。

## 9. 确定性 Renderer

### 9.1 位置和职责

```text
NativeReportDocument
→ Renderer
→ Online HTML / ZIP
→ Artifact Store
```

Renderer 不调用 LLM，不理解行业知识，不审核内容。它只：

- 渲染通用 Block；
- 转义文本；
- 解析安全 Markdown；
- 把已验证 Asset 放入图片槽；
- 输出 CSS-only Tab；
- 输出打印样式；
- 生成 Online URL 或 ZIP 相对路径。

### 9.2 无重复校验

ReportDocument 在解析边界完成结构和引用校验；Renderer 信任解析后的对象。Renderer 不重复查 Source、Hash、owner 或业务规则。Asset Store 负责唯一的 SEALED/Hash/绑定校验，下载 API 只负责 owner。

### 9.3 CSS-only Tab

使用 radio + label + `:checked`：

- 默认显示首 Tab；
- 键盘可操作；
- 无 JavaScript；
- 无动画；
- 打印时全部展开；
- Tab 名和顺序来自 ReportDocument，不硬编码 Skill。

### 9.4 真实数据填充

Renderer 只按 Block 输入渲染：

- 有指标才生成指标卡；
- 有表格行才生成表格；
- 有轴和点才生成象限；
- 有结构描述才生成线框；
- 有 Artifact 才生成图片；
- 缺失时省略或显示 Skill 已给出的 Gap。

Demo 仅贡献框架和视觉 Token，不提供任何业务内容。

## 10. Industry 首条纵切

### 10.1 调用

```text
single_skill

$industry-market-analysis
请针对京东图书频道生成中档行业市场分析。
主聚焦体验诊断，次聚焦设计策略和品类差异资产。
输出当前 5 Tab 在线 HTML 和离线 ZIP。
```

### 10.2 内部材料

Skill Package 只有方法、阶段和模板，不含运营材料、实时 KPI、用户数据和截图。平台绑定新增：

```text
internal_documents：document，可选，多文件
```

中/重档默认在统一表单展开。用户不提供时形成 Waiver/Gap，不重复问。

`o2-ge-search` 未绑定时，只能使用用户上传、Joyspace 或 Gap，不能模拟站内数字。

### 10.3 输出

同一次 Skill LLM 调用返回 `NativeReportDocumentV1`，Single 不新增报告 LLM。Industry 的真实验收要求五个中文 Tab，但 Renderer 不包含 `industry-market-analysis` 判断。

## 11. 其他 Skill 复用

共享：中文问询、document/dataset/visual Artifact、ReportDocument、Renderer、Asset URL、ZIP、来源、Gap、打印。

不同 Skill 只输出自己的 Tab/Section：

```text
competitive-analysis       结论 / 竞品矩阵 / 象限 / 机会 / 行动
build-experience-metrics   指标总览 / 口径 / 采集 / 风险
journey-map                阶段 / 行为 / 触点 / 情绪 / 机会
generate-persona           人群概览 / Persona / 痛点 / 设计机会
```

第二条验收使用 `competitive-analysis` 或 `build-experience-metrics`，证明无 Skill ID 特判。无 ReportDocument 的 Skill 在同一 Native v1 合同内继续走 Markdown 单页 Renderer。

## 12. API 与 Web

### API

```text
POST /control-tasks/:id/plans/:planVersionId/inputs/:role/document
POST /control-tasks/:id/plans/:planVersionId/inputs/:role/dataset
POST /control-tasks/:id/plans/:planVersionId/inputs/:role/visual
GET  /control-tasks/:id/final-report
GET  /control-tasks/:id/final-report.html
GET  /control-tasks/:id/final-report.zip
GET  /control-tasks/:id/assets/:assetId
```

### Stage 1/2

- Task 与材料问题集中展示；
- 普通字段、MD/TXT、CSV、图片和 Waiver 在一个中文表单；
- 一次“确认并继续”；
- 文件失败只标对应字段；
- 不显示内部 ID；
- 移除匿名化复选框。

### Stage 3

只显示中文业务步骤：检索公开资料、读取内部材料、分析行业和用户、生成报告内容、装配报告。

### Stage 4

默认展示 Online HTML，提供 ZIP 和“查看各专业能力结果”。CSS-only Tab 在隔离容器显示。

## 13. 执行与恢复

- Tool、Knowledge、Skill 先封存；
- ReportDocument 再封存；
- Renderer 最后生成 HTML/ZIP；
- Renderer 失败只重读 ReportDocument 和 Asset；
- 不重跑 Tool、Skill 或 Contributor；
- Single Skill-defined 不增加报告 LLM；
- Multi 只允许一次最终 Writer；
- Multi Writer 输出 ReportDocument，Renderer 不综合内容。

## 14. 安全边界

保留 owner、Task/Plan/Attempt 绑定、Hash、路径防护、Tool 真实性、Source ID、HTTPS 来源、凭据保护、大小和 MIME 校验。

只在可信边界校验一次。业务内容和 PII 原样进入分析和报告；API Key、Authorization、JWT、Token、Secret、密码继续隐藏。Markdown/TXT 视为数据，不能通过文本改变权限或 Plan。

## 15. 文件范围

### 新增文件（2 个实现文件）

1. `apps/orchestrator-runtime/src/control/document-input-gate-store.ts`
2. `apps/orchestrator-runtime/src/report/native-report-renderer.ts`

ReportDocument 类型直接加入现有 API 合同；ZIP 是 Renderer 的第二种输出，不拆独立 Bundle 层。测试只为两个新边界增加聚焦文件，其余测试加入现有测试文件：

- `tests/native-skill-orchestration.test.ts`
- `tests/native-plan-input-resolution.test.ts`
- `tests/control-api-integration.test.ts`
- `tests/multi-skill-report-ui.test.ts`
- `tests/user-facing-language.test.ts`

### 主要修改文件

- `packages/api-contract/native-skill-orchestration.ts`
- `runtime/skill-loader.ts`
- `runtime/installed-skill-catalog.ts`
- `input-resolution/resolved-plan-inputs.ts`
- `control/visual-input-gate-store.ts`
- `control/dataset-input-gate-store.ts`
- `control/lease-execution-engine.ts`
- `report/native-reporting.ts`
- `apps/agent-api/src/control-runtime.ts`
- `apps/agent-api/src/routes/control-tasks.ts`
- `apps/web/src/api/client.ts`
- `CurrentStage1Clarify.tsx`
- `Stage2Plan.tsx`
- `Stage3Execute.tsx`
- `NativeStage4Report.tsx`
- `useTaskFlow.ts`
- `theme.css`
- `orchestrator/skill-bindings.yaml`

只在包外增加 `internal_documents` 绑定，不修改原版 Skill Package。

## 16. 当前实施进度

截至本次首个开发批次：

- 已完成 `document` 输入合同、Markdown/TXT Artifact、执行期有界模型视图；
- 已完成图片 multipart 上传路径，Web 新流程不再生成 Base64 确认载荷；
- 已将 Document、CSV、图片集中在 Stage 2 的一次提交中，并移除匿名化强制确认；
- 已完成 `NativeReportDocumentV1`、7 类 Block、CSS-only Tab、在线 HTML 与按需 ZIP Renderer；
- 已接通 Native Single ReportDocument，Multi 的唯一 Writer 可生成 ReportDocument；
- 已接通 owner-bound 原始上传图片读取和浏览器 Blob 展示；
- 已为 Industry 增加 `internal_documents`，并为两个材料型 Skill 增加 Document 输入复用；
- 已完成聚焦测试、全量单测、类型检查、Registry/Knowledge lint 和 Web build；
- 已删除 Web 与 TaskWorkflow 的 inline data URL 路径；图片只通过 multipart Artifact 进入确认；
- 尚待完成：跨 Stage 1/2 的问询进一步合并，以及真实 Provider 双路径验收。

## 17. 实施阶段

### Phase 0：冻结最小合同

- 更新 ADR-0013 的报告/输入决策，或新增简短 ADR-0014；
- 冻结 `document` 与 `NativeReportDocumentV1`；
- 记录参考 HTML 结构统计，不提交其业务内容；
- 冻结 Industry 五 Tab；
- 聚焦测试：合同解析和失败样本。

### Phase 1：统一材料输入

- Document Store；
- Markdown/TXT multipart；
- 图片 multipart；
- 复用 CSV；
- Gate 使用 Artifact 引用；
- 一次中文表单；
- 删除 data URL 确认载荷、独立 Dataset UI 和匿名化复选框。

验收：MD/TXT/CSV/多图均 SEALED，Plan/Gate/DB 无 Base64，owner 隔离。

### Phase 2：ReportDocument 与 Renderer

- Skill Result 支持 ReportDocument；
- 7 类 Block；
- Online + ZIP；
- CSS-only Tab；
- Source/Asset 只在输入边界验证；
- 删除新任务模型直出完整 HTML/CSS/Base64 的路径。

验收：同一输入输出稳定；无 JS；无 Demo 内容；Online/ZIP 内容一致。

### Phase 3：Industry 纵切

- 中档一次问询；
- Tavily / Joyspace / 上传材料；
- 五个中文 Tab；
- 真实数据填表格、指标、象限和图片；
- O2 缺失形成 Gap；
- Renderer 失败恢复不重跑 Skill。

### Phase 4：第二 Skill 复用与全中文

- 第二 Skill 使用相同 Document/Renderer；
- Stage 1–4、Sidebar、错误、下载名全中文；
- 无裸内部 ID；
- 删除重复问询和专属分支。

### Phase 5：真实 Smoke 与清理

按真实 LLM 工作流：

1. Industry Single 一次；
2. 第二 Skill 或 Multi 一次；
3. Ego Lite 人工查看 Online 和 ZIP；
4. 删除残余的模型直出 HTML、inline data URL 和无调用方测试；
5. 完整质量门禁。

不增加每阶段独立评审、三次重复真实运行或模型自评分。

## 18. 最小测试集

只保留能证明边界的测试：

1. Contract：document、ReportDocument、Asset/Source 引用；
2. Material：一次 MD/TXT、一次 CSV、一次多图；
3. UI：一个聚合表单、一个提交、全中文；
4. Renderer：五 Tab、7 类 Block、Online/ZIP、无 JS、确定性；
5. Recovery：Renderer 失败不重跑 Tool/Skill；
6. Reuse：第二 Skill 无特判；
7. Full：`pnpm quality` 和 Web Build；
8. Real：一条 Industry Single、一条第二路径。

不为每个 Block 建多套等价测试，不在 Renderer 重复 Source/Hash/owner 测试，不新增报告 Review Gate。

## 19. 验收标准

### 用户体验

- 用户最多填写一个集中补充表单；
- 同一材料不重复上传；
- 所有用户可见文本中文；
- 支持 MD/TXT/CSV/图片；
- 不出现 PDF 入口；
- Waiver 后不再问。

### 报告

- Industry 五 Tab；
- 无 JavaScript；
- 在线 HTML 不含 Base64；
- ZIP 使用相对 assets；
- 无本地绝对路径；
- 数据和图片来自当前 Artifact；
- 无 Demo 结论、数字和截图；
- 缺数据时省略或 Gap；
- Renderer 同输入确定性。

### 复用

- Renderer 无 Skill ID 特判；
- 第二 Skill 使用同一 ReportDocument/Renderer；
- Skill Package 无平台执行代码；
- Markdown Skill 仍可使用共享单页 Renderer。

### 工程门禁

```text
pnpm quality
pnpm --dir apps/web build
git diff --check
```

普通 CI 不调用真实 Provider。真实调用只在命令级 `ALLOW_REAL_PROVIDER=1` 下串行执行。

## 20. 清理清单

新能力通过后删除：

- Stage2 `readAsDataURL` 新任务路径；
- Confirm 中 inline image data URL；
- 独立 Dataset 上传 UI；
- 匿名化复选框；
- 模型直出完整 HTML/CSS/Base64 的新任务分支；
- JavaScript HTML 处理分支；
- 英文用户文案和裸内部 ID；
- Industry 专属 Renderer 判断；
- 仅验证上述旧路径的测试。

保留：历史 Artifact 数据、Markdown Renderer、凭据保护、Source/Hash/owner 校验和通用 Artifact 基础设施。

## 21. 风险与处理

| 风险 | 最小处理 |
|---|---|
| 表单字段多 | 中文分组，折叠可选项，不拆多轮 |
| 暂定 Skill 改变 | 只补新增必需项；可选项转 Gap |
| 文档大 | Raw 保留、模型视图有界、一个 Gap |
| 图片大 | Binary Artifact；模型瞬时 data URL |
| Gateway 不支持 URL | 不增加第二传输模式 |
| HTML 无 JS | CSS-only Tab |
| ReportDocument 过度抽象 | 只保留 7 类 Block |
| Demo 内容泄漏 | 合成 Fixture，不读取 Downloads 文件 |
| 图表编数 | Block 数据必须带 Source ID |
| O2 未绑定 | 上传/Joyspace/Gap，不模拟 |
| Renderer 失败 | 只重渲染 |
| 中文漏网 | 一个用户语言边界测试 + Ego Lite 检查 |

## 22. 提交顺序

```text
1. docs: simplify native report renderer plan
2. feat: add document input and report document contracts
3. refactor: unify material intake
4. feat: add deterministic native renderer
5. feat: render industry reports with five tabs
6. refactor: localize user-facing orchestration copy
7. test: validate renderer reuse and cutover
8. chore: remove superseded input and HTML paths
```

## 23. 完成定义

- 新 Task 使用调整后的单一 Native v1 路径；
- Industry 一个中文表单收齐材料；
- MD/TXT/CSV/图片均走 Artifact；
- Plan/Gate/DB 无 Base64；
- Industry 真实生成五个中文 Tab；
- 报告无 JavaScript；
- Online 使用 owner-bound Asset URL；
- ZIP 使用相对 assets；
- Demo 内容零复制；
- Single 无额外报告 LLM；
- Renderer Retry 不重跑 Tool/Skill；
- 第二 Skill 复用同一 Renderer；
- 旧 inline upload 和模型 HTML 分支已删除；
- 自动化、Web Build、两条真实路径和 Ego Lite 验收通过；
- Worktree 干净。

## 24. 最终架构结论

```text
统一中文问询
+ 共享 Material Artifact
+ 原版 Skill Package
+ NativeReportDocument
+ 共享确定性 Renderer
+ Skill 自有报告语义
```

Renderer 是共享基础设施，Industry 只负责第一条复杂报告纵切。首版不超出当前明确需求，不演变为通用页面平台。
