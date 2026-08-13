# 可信多模态研究系统 设计文档

- 日期：2026-08-14
- 状态：已批准，待实施
- 归属：用研 AI 专项 · Current 可信研究主链
- 前置方案：`docs/plans/2026-08-11-current-trusted-research-flow.md`

## 1. 背景

Current 主链已经完成 Planning、Workflow、Lease、Model Receipt、Tool Provenance、Artifact Seal、Evidence Manifest、Finding Graph、Deliverable 和 Web/Markdown 展示，能够在模型漂移、Receipt 缺失、Evidence 不足、Artifact 篡改或 Lease 失效时 fail-closed。

当前剩余问题不在“是否能执行”，而在以下五个产品能力没有形成闭环：

1. 用户澄清答案没有反哺 `ResearchTask` 和候选计划。
2. Planning 产出的是线性能力步骤，不是可追踪、可验收的研究子问题图。
3. Skill/Tool 主要依赖 LLM 从全量 Active Registry 中选择，缺少依赖、输入输出和可用性编译。
4. 最终 Deliverable 只消费 Tool Evidence；Skill、LLM、Reviewer 正文没有进入最终 synthesis。
5. 最终报告虽然有 F/A/S/C 和 Evidence，但仍以文本列表为主，没有图表、截图、热力图、标注图、专业排版和稳定 PDF 交付。

本设计在不推翻 Current 可信执行底座的前提下，补齐“理解 → 拆解 → 编排 → 执行 → 融合 → 审查 → 多模态报告”的完整闭环。

## 2. 目标

### 2.1 核心目标

系统必须能够：

1. 多轮收敛用户需求，并把澄清答案写回结构化需求。
2. 把需求拆成有稳定 ID、证据要求和验收标准的研究子问题。
3. 按任务类型、意图、输入、依赖、风险、成本和能力可用性筛选 Skill/Tool。
4. 编译出服务端可验证的执行图，而不是直接信任 LLM 给出的步骤。
5. 在 Lease 保护下执行，并复用仍有效的断点产物。
6. 让最终 synthesis 真正消费 Skill、Tool、LLM、Reviewer 的安全输出。
7. 为不同任务类型选择对应 Deliverable Schema、Prompt、Evidence Policy 和 Review Rubric。
8. 产出专业、完整、有体系、可追溯的多模态研究报告。
9. 默认交付交互式 Web 报告和可打印 PDF；Markdown/JSON/资产包作为辅助交付。

### 2.2 成功标准

- 每条 `successCriterion` 至少被一个研究子问题覆盖。
- 每个必答子问题至少有一个执行步骤和一个验收条件。
- 每个事实 Finding 100% 绑定有效 Evidence。
- 每个 Summary 绑定研究子问题和 Finding/Analysis 根。
- 每个 Conclusion 和 Recommendation 绑定 Summary 根。
- Skill、LLM、Reviewer 输出变化能够影响最终报告。
- 每张截图、图表、热力图和标注图都绑定 SEALED Artifact 与 Evidence/Analysis。
- 图表中的每个数值都能解析回 Dataset/Tool Evidence。
- 澄清答案变化会生成新的 Requirement Version 和服务端 Plan Version。
- Retry 不重复执行仍满足计划、Schema、Manifest 和配置哈希的成功步骤。
- 任何模型漂移、Receipt 缺失、Lease 失效、Artifact 篡改或 Evidence 不足都不得生成有效终态报告。

## 3. 非目标

- 不引入 Temporal、LangGraph 或新的工作流运行时。
- 不建设未经治理的自由 Tool 市场。
- 不允许客户端提交完整 Current Plan 或 Plan Hash。
- 不允许无限反思、无限重规划或无限报告修订。
- 不允许 LLM 生成的虚构截图或虚构图表作为事实证据。
- 不把 Optional Tool 作为关键结论的唯一证据来源。
- 不重新启用 Legacy 写链路；Legacy 历史继续只读。
- 不在本轮建设协同编辑、评论系统或 PPT 编辑器。
- 不在服务端引入独立 PDF 渲染集群；PDF 使用同源 Web Print Renderer。

## 4. 设计原则

### 4.1 Current 唯一新写主链

所有新任务、Requirement Version、Plan Version、Attempt、Artifact、Evidence 和 Deliverable 只写 Current。Legacy 只负责历史读取。

### 4.2 LLM 提议，确定性模块裁决

LLM 可以提出结构化需求、研究问题、能力组合、报告内容和图表建议；以下不变量必须由确定性代码验证：

- Schema
- 状态机
- Plan Hash
- 能力存在性和依赖
- DAG 无环
- 输入输出绑定
- Evidence 计数和引用
- Artifact/Lease 绑定
- 图表数据引用
- 报告引用完整性

### 4.3 事实、分析、推断、审查分层

- Tool/Dataset/Screenshot Evidence 可以支撑事实。
- Skill/LLM Output 只能形成 Analysis 或 Inference。
- Reviewer Output 只能形成审查意见，不能成为事实。
- LLM 生成的图表说明不能改变图表数值。

### 4.4 业务真相和表现层分离

`ResearchDeliverableEnvelope` 保存业务交付和证据图；`ReportDocument` 保存章节和内容块；`VisualAssetManifest` 保存视觉资产；Renderer 只负责展示。

### 4.5 默认拒绝不可信完成

信息不足时进入澄清；能力不可用时不生成假计划；Evidence 不足时暂停；报告审查不通过时最多自动修订一次，第二次仍失败则暂停。

## 5. 总体架构

```text
User Input / Conversation History
              │
              ▼
RequirementRefinementService
              │ ResearchTaskV2 / Clarification
              ▼
ProblemGraphPlanner
              │ ProblemGraph
              ▼
CapabilityResolver ─── CapabilityHealth
              │ Shortlist + rejection reasons
              ▼
PlanCompiler
              │ Compiled Current Plan / Pending Inputs
              ▼
TaskWorkflowService
              │ Lease
              ▼
LeaseExecutionEngine
  ├─ Tool Runner
  ├─ Skill Runner
  ├─ LLM Runner
  └─ Reviewer Runner
              │ SEALED Step Artifacts
              ▼
SynthesisMaterializer
              │ verified/redacted materials
              ▼
DeliverableComposer
              │ Deliverable Draft
              ▼
ReportEvidenceValidator
              │
              ▼
ReportReviewService ── revise once / pass / block
              │
              ├─ ReportDocumentComposer
              ├─ VisualAssetService
              └─ ChartRenderer
              │
              ▼
Report Package
  ├─ Deliverable
  ├─ Evidence Manifest
  ├─ Report Document
  ├─ Visual Asset Manifest
  └─ Report Review Artifact
              │
              ▼
Web Report / Print PDF / Markdown+Assets / JSON
```

## 6. 领域模型

### 6.1 ResearchTaskV2

Current 使用新的 `research-task-v2` Schema；Legacy ResearchTask 保持只读兼容。

```ts
interface ResearchTaskV2 {
  version: 'research-task-v2';
  task_type: 'competitive_research' | 'user_research_planning' | 'voc_diagnosis' | 'design_audit' | 'a11y_audit';
  business_domain: string;
  research_goal: string;
  target_audience: string[];
  scope: string[];
  constraints: Array<{ id: string; statement: string; source: 'user' | 'policy' }>;
  success_criteria: Array<{ id: string; statement: string }>;
  expected_deliverables: string[];
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
  ambiguities: Array<{ id: string; statement: string; blocking: boolean }>;
  clarification_questions: Array<{ key: string; question: string; rationale: string }>;
  blocking_issues: Array<{ key: string; reason: string; kind: string }>;
  sensitivity: 'public' | 'internal' | 'confidential';
  pii_detected: boolean;
}
```

澄清问题和治理确认必须分离：

- Clarification 会改变 ResearchTask 和 Plan。
- Confirmation 只接受已经冻结的 Plan 和治理条件。

### 6.2 Requirement Version

新增 `control_requirement_versions`：

- `id uuid primary key`
- `task_id uuid not null`
- `version integer not null`
- `raw_input_hash text not null`
- `clarification_json jsonb not null`
- `structured_task_json jsonb not null`
- `model_call_id uuid`
- `created_at timestamptz not null`
- `unique(task_id, version)`

`control_tasks` 新增 `active_requirement_version_id`。新状态 `awaiting_clarification` 加入状态约束。

### 6.3 Problem Graph

```ts
interface ResearchQuestion {
  id: string;
  statement: string;
  rationale: string;
  priority: 'required' | 'optional';
  success_criterion_ids: string[];
  evidence_requirements: EvidenceRequirement[];
  acceptance_criteria: string[];
  depends_on: string[];
}

interface ProblemGraph {
  version: 'problem-graph-v1';
  questions: ResearchQuestion[];
}
```

硬约束：

- ID 唯一。
- 所有 `depends_on` 存在且无环。
- 每个 Required Question 至少绑定一个 Success Criterion。
- 每个 Success Criterion 至少被一个 Question 覆盖。
- 每个 Required Question 至少有一个 Required Evidence Requirement。

### 6.4 CurrentPlanStep

不修改 Legacy `PlanStep`；Current 新增独立类型：

```ts
interface CurrentPlanStep {
  step_no: number;
  step_name: string;
  actor_type: 'tool' | 'skill' | 'llm' | 'reviewer';
  actor_id: string;
  question_ids: string[];
  depends_on: number[];
  input: Record<string, unknown>;
  input_bindings: Array<{
    target_pointer: string;
    source_step_no: number;
    source_pointer: string;
  }>;
  expected_outputs: Array<{ pointer: string; description: string }>;
  acceptance_criteria: string[];
  requires_approval: boolean;
  approval_role?: 'owner' | 'legal' | 'security';
  fallback_actor_ids: string[];
}
```

第一阶段按拓扑顺序串行执行；只有完成断点恢复后，才并行执行互不依赖的步骤。

### 6.5 Capability Decision

```ts
interface CapabilityDecision {
  actor_type: 'tool' | 'skill';
  actor_id: string;
  eligible: boolean;
  selected: boolean;
  reasons: string[];
  rejected_reasons: string[];
  required_actor_ids: string[];
  health: 'available' | 'degraded' | 'unavailable';
}
```

每次 Planning 将 Capability Decisions 写入 Plan Artifact，绑定 Task、Requirement Version 和 Plan Version。

### 6.6 Synthesis Material

```ts
interface SynthesisMaterial {
  stepNo: number;
  actorType: 'tool' | 'skill' | 'llm' | 'reviewer';
  actorId: string;
  questionIds: string[];
  artifactId: string;
  artifactContentSha256: string;
  value: unknown;
  semanticRole: 'fact_source' | 'analysis' | 'inference' | 'review';
}
```

Materializer 只解析 SEALED、哈希一致、Task/Plan/Attempt 一致且通过 Schema/Redaction 的 Artifact。

### 6.7 Report Package

Report Package 由独立 SEALED Artifacts 组成：

```ts
interface ReportPackage {
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  reportDocumentArtifactId: string;
  visualAssetManifestArtifactId: string;
  reportReviewArtifactId: string;
}
```

`ResearchDeliverableEnvelope` v1 保持不变，避免把表现层字段塞入业务 Envelope。

### 6.8 Report Document

```ts
type ReportBlock =
  | HeadingBlock
  | ParagraphBlock
  | MetricBlock
  | TableBlock
  | ChartBlock
  | ImageBlock
  | ImageComparisonBlock
  | EvidenceBlock
  | RecommendationBlock
  | RiskBlock;

interface ReportDocument {
  version: 'report-document-v1';
  title: string;
  subtitle?: string;
  executiveSummary: string;
  sections: Array<{
    id: string;
    title: string;
    questionIds: string[];
    blocks: ReportBlock[];
  }>;
}
```

每个业务 Deliverable Template 提供自己的 Section Policy；Renderer 不理解业务，只渲染合法 Block。

### 6.9 Visual Asset Manifest

```ts
interface VisualAssetEntry {
  id: string;
  kind: 'screenshot' | 'annotated_screenshot' | 'heatmap' | 'chart_svg' | 'chart_png' | 'thumbnail';
  artifactId: string;
  artifactContentSha256: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  width: number;
  height: number;
  caption: string;
  altText: string;
  evidenceIds: string[];
  findingIds: string[];
  sourceAssetId?: string;
  sensitivity: 'public' | 'internal' | 'sensitive';
  exportPolicy: 'allow' | 'mask' | 'block';
}

interface VisualAssetManifest {
  version: 'visual-asset-manifest-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  assets: VisualAssetEntry[];
  manifestHash: string;
}
```

### 6.10 Chart Spec

允许的首批图表：`bar`、`stacked_bar`、`line`、`heatmap`、`funnel`。

```ts
interface ChartSpec {
  version: 'chart-spec-v1';
  id: string;
  type: 'bar' | 'stacked_bar' | 'line' | 'heatmap' | 'funnel';
  title: string;
  subtitle?: string;
  xAxis?: { label: string; unit?: string };
  yAxis?: { label: string; unit?: string; zeroBaseline: boolean };
  categories: string[];
  series: Array<{
    name: string;
    values: Array<number | null>;
    evidenceIds: string[];
  }>;
  questionIds: string[];
  findingIds: string[];
  caption: string;
  altText: string;
}
```

LLM 可以提出 Chart Spec，但 Chart Validator 必须逐个验证数值、单位、Evidence 和缺失值；Renderer 不接受任意 HTML、JavaScript 或 LLM 生成 SVG。

### 6.11 Report Review Artifact

```ts
interface ReportReviewArtifact {
  version: 'report-review-v1';
  verdict: 'pass' | 'revise' | 'block';
  dimensions: Array<{
    id: 'requirement_coverage' | 'question_coverage' | 'evidence_coverage' | 'reasoning_quality' | 'recommendation_quality' | 'visual_quality' | 'risk_disclosure';
    passed: boolean;
    issues: string[];
  }>;
  revisionRound: 0 | 1;
}
```

自动修订最多一次。修订后仍未通过时任务进入 `paused`，不 seal 最终 Report Package。

## 7. 深模块与接口

### 7.1 RequirementRefinementService

接口：

```ts
understand(input: UnderstandInput): Promise<UnderstandResult>
clarify(input: ClarifyInput): Promise<ClarifyResult>
```

职责：

- 读取属于当前 owner 的会话消息。
- 生成并校验 ResearchTaskV2。
- 判断是否需要澄清。
- 持久化 Requirement Version。
- 信息充分后调用 Planning；不直接持久化客户端计划。

### 7.2 ProblemGraphPlanner

接口：

```ts
build(task: ResearchTaskV2): Promise<ProblemGraphResult>
```

职责：

- 基于 Requirement Version 和 Guidance 生成 Problem Graph。
- 验证 Success Criteria 覆盖和 DAG。
- 记录模型 Receipt 和 Prompt Hash。

### 7.3 CapabilityResolver

接口：

```ts
resolve(input: CapabilityResolveInput): Promise<CapabilityResolution>
```

硬过滤：

- Active 状态。
- `task_types` 匹配。
- 必需 Tool Active。
- 输入已具备或能形成 Pending Input。
- 风险审批路径存在。
- Core Tool 有真实 Adapter。

过滤后由 LLM 在短名单内排序；Resolver 保存入选和淘汰理由。

### 7.4 PlanCompiler

接口：

```ts
compile(input: PlanCompileInput): CompiledPlan
```

职责：

- 严格校验 Current Candidate Schema。
- 校验 Skill required Tool、执行顺序和输入输出绑定。
- 校验 DAG、Fallback、Evidence Requirement 和审批。
- 服务端重建 stepNo 和 canonical plan hash。
- 产出只读 Current Plan Version。

### 7.5 SynthesisMaterializer

接口：

```ts
materialize(input: MaterializeInput): Promise<SynthesisMaterial[]>
```

职责：

- 从 Artifact Store 读取验证后的步骤内容。
- 校验 Task/Plan/Attempt、Hash、Schema 和 Lease。
- 统一脱敏。
- 标注事实、分析、推断、审查角色。
- 按 Question ID 分组。

### 7.6 DeliverableComposer

接口：

```ts
compose(input: DeliverableComposeInput): Promise<DeliverableDraft>
revise(input: DeliverableRevisionInput): Promise<DeliverableDraft>
```

职责：

- 从 Deliverable Registry 选择 Schema、Prompt 和 Quality Policy。
- 生成业务 Deliverable、Finding Graph 和 Recommendation。
- 不接收未验证原始 Tool/用户材料。

### 7.7 ReportReviewService

接口：

```ts
review(input: ReportReviewInput): Promise<ReportReviewArtifact>
```

执行顺序：

1. 确定性结构和引用校验。
2. 模型语义审查。
3. `pass` 进入 Report Composition。
4. `revise` 触发一次修订和完整复验。
5. `block` 或第二次失败进入 paused。

### 7.8 VisualAssetService

接口：

```ts
ingest(input: VisualAssetIngestInput): Promise<VisualAssetEntry>
derive(input: VisualAssetDeriveInput): Promise<VisualAssetEntry>
readVerified(assetId: string, ownerUserId: string): Promise<VerifiedVisualAsset>
```

输入来源仅允许：

- 用户上传并经过 Owner 校验的图片。
- SEALED Tool Artifact 中的 HTTPS 图片 URL。
- 系统自己的 Chart/Annotation Renderer。

约束：

- 用户上传仅允许 PNG、JPEG、WebP。
- 单文件最大 10 MiB。
- 解码后最大 20 Megapixels。
- 用户 SVG 禁止进入系统。
- 远程图片必须下载、校验、封存；报告不得直接依赖远程 URL。
- 原图永不覆盖；标注图、热力图、缩略图是 Derived Artifact。

### 7.9 ChartRenderer

Web 使用 `echarts` SVG Renderer；图表的源真相是 Chart Spec，渲染结果保存为 SEALED SVG Artifact。用于离线包时再生成 PNG Snapshot。

职责：

- 只接受通过 Schema 和 Evidence 校验的 Chart Spec。
- 使用稳定的竞品颜色映射。
- 缺失值保持 `null`，不得自动变为 0。
- Bar/Line 默认从 0 基线；非 0 基线必须由 Quality Policy 明确允许。
- 生成 SVG、PNG、Caption 和 Alt Text。

### 7.10 ReportRenderer

支持三种 Adapter：

1. `WebReportRenderer`：交互式章节、证据侧栏、图片查看、图表提示。
2. `PrintReportRenderer`：A4 Print CSS、封面、目录、页码、页眉页脚、SVG 图表。
3. `MarkdownBundleRenderer`：Markdown + assets + manifests ZIP。

Web 增加 `echarts`；离线 ZIP 使用 `fflate`。服务端图片尺寸校验使用 `image-size`。不新增远程 CDN 或第三方账号。

### 7.11 ExecutionRecoveryService

接口：

```ts
recover(now: Date): Promise<RecoverySummary>
```

职责：

- 过期 Lease → `paused/worker_lost`。
- STAGING Artifact → quarantine + failed。
- Terminal Artifact Lease 绑定重验。
- 记录恢复审计。
- 启动时执行一次，随后按现有进程内定时器周期执行。

## 8. API 设计

### 8.1 Planning Response

`POST /api/control-tasks/plan` 和 SSE result 返回联合类型：

- `clarification_required`
- `current_candidates`

`clarification_required` 包含：

- conversation ID
- task ID
- state/stateVersion
- ResearchTaskV2
- clarification questions
- assumptions

### 8.2 Clarify Command

`POST /api/control-tasks/:id/clarify`

请求：

```ts
interface ClarifyControlTaskRequest {
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
  idempotencyKey: string;
}
```

响应为新的 `current_candidates`。服务端创建 Requirement Version 和 Plan Versions；客户端不能传 Plan。

### 8.3 Revise Command

现有 `/revise` 不再接受客户端 `plan` 和 `planHash`。改为接受：

- `revisionInstruction`
- `expectedVersion`
- `idempotencyKey`

服务端重新运行 ProblemGraph/CapabilityResolver/PlanCompiler，并重新计算 canonical hash。

### 8.4 Report Package Read

`GET /api/control-tasks/:id/deliverable` 返回：

```ts
interface CurrentReportPackageResponse {
  deliverable: ResearchDeliverableEnvelope<unknown>;
  evidenceManifest: EvidenceManifest;
  reportDocument: ReportDocument;
  visualAssetManifest: VisualAssetManifest;
  reportReview: ReportReviewArtifact;
}
```

读取时重新验证所有 Artifact、Manifest、Evidence、Finding Graph、Chart Spec 和 Asset 引用。

### 8.5 Asset Read

`GET /api/control-tasks/:taskId/assets/:assetId`

- 统一 owner 校验。
- foreign/missing 统一 404。
- 根据 Manifest 设置 Content-Type、Cache-Control 和 Content-Disposition。
- `exportPolicy=block` 不返回资产。
- 不向客户端暴露本地 storage URI。

### 8.6 Report Routes

- `/reports/:taskId`：交互式 Web 报告。
- `/reports/:taskId/print`：Print Renderer，用户浏览器导出 PDF。
- `GET /api/control-tasks/:id/report-bundle`：生成 Markdown+Assets ZIP。

## 9. 状态机

新增状态后的正常路径：

```text
planning
  → awaiting_clarification
  → awaiting_selection
  → awaiting_confirmation
  → awaiting_approval
  → ready
  → executing
  → reviewing
  → composing_report
  → completed / completed_with_gaps
```

失败路径：

- Planning Schema/Model Receipt 失败：请求失败，不持久化不完整候选。
- Clarification 不完整：保持 awaiting_clarification。
- Core Tool/Skill/LLM 失败：paused。
- Optional Tool 非 safety/integrity 失败：gap，继续执行。
- Evidence 不足：paused。
- Report Review 第二次仍失败：paused。
- Lease/Artifact integrity 失败：rethrow + paused，不允许 terminal Artifact。

`reviewing` 和 `composing_report` 为可观察状态；执行 Attempt 仍由同一个 Lease 保护。

## 10. Deliverable Registry

Registry 升级为：

```yaml
version: 2
deliverables:
  - id: research_plan
    status: active
    task_types: [user_research_planning]
    envelope_version: research-deliverable-v1
    payload_schema: schemas/deliverables/research-plan.schema.json
    synthesis_prompt: orchestrator/prompts/deliverables/research-plan.md
    review_rubric: orchestrator/report-rubrics/research-plan.yaml
    evidence_policy: research-plan
    report_template: research-plan
```

后续按顺序增加：

1. `research_plan`
2. `competitive_analysis_report`
3. `voc_diagnosis_report`
4. `design_audit_report`
5. `accessibility_audit_report`

每个 Active Deliverable 必须同时存在 Payload Schema、Prompt、Rubric、Evidence Policy 和 Report Template；Registry Linter 缺一即失败。

## 11. 专业报告模板

默认报告章节：

1. 封面
2. 执行摘要
3. 研究背景和目标
4. 范围、样本和方法
5. 核心指标概览
6. 关键发现
7. 分问题分析
8. 截图和视觉证据
9. 横向比较
10. 总体结论
11. 行动建议
12. 风险和限制
13. Evidence/Method/Capability 附录

模板规则：

- 图表数量由数据决定，不强制堆图。
- 没有结构化数据时不得生成数值图表。
- Screenshot 必须有 Caption、Alt Text、Evidence 和原始 Asset。
- 同一竞品在整份报告中使用稳定颜色。
- Fact、Inference、Risk 使用不同视觉语义。
- 图表和正文中的数字必须一致。
- 用户可点击结论查看 Evidence，可点击图片查看原图和标注来源。

## 12. 多模态资产安全

### 12.1 Binary Artifact

`ControlArtifactStore` 增加：

```ts
writeBinary(input: BinaryArtifactWriteInput): Promise<ControlArtifact>
readVerifiedBinary(artifactId: string): Promise<{ artifact: ControlArtifact; bytes: Buffer }>
```

Binary 和 JSON 使用同一 STAGING → fsync → link → hash → lease-fenced seal 流程。

Migration `004_requirement_and_media.sql`：

- 新建 `control_requirement_versions`。
- `control_tasks` 增加 `active_requirement_version_id`。
- 状态约束增加 `awaiting_clarification`、`reviewing`、`composing_report`。
- `control_artifacts` 增加 `media_type text` 和 `metadata_json jsonb`。

### 12.2 SSRF 和远程图片

远程图片下载必须满足：

- URL 来自真实 Tool Artifact 的已验证 JSON Pointer。
- HTTPS。
- DNS/IP 解析后拒绝 loopback、link-local、private network 和 metadata address。
- 最多一次受限重定向，重定向目标重复校验。
- Content-Type 和文件签名一致。
- 最大 10 MiB。
- 超时后失败，不使用部分文件。

### 12.3 敏感图片

- `public`：允许 Web/PDF/Bundle。
- `internal`：允许 Owner Web/PDF；Bundle 显示内部标记。
- `sensitive`：默认 `exportPolicy=block`；只有经过脱敏产生的 Derived Asset 可导出。
- 图片 OCR/人脸/联系方式脱敏不在第一批自动实现；无法确认时 fail-closed 为 block，不假装已经脱敏。

## 13. 报告质量门禁

### 13.1 确定性门禁

- Success Criterion 覆盖率 100%。
- Required Question Summary 覆盖率 100%。
- Fact Evidence 覆盖率 100%。
- Conclusion Summary Root 覆盖率 100%。
- Recommendation Summary Root 覆盖率 100%。
- 无悬空 Artifact/Evidence/Finding/Analysis/Summary/Asset 引用。
- Chart 每个 Series 至少一个 Evidence ID。
- Screenshot/Chart/Heatmap 必须有 Caption 和 Alt Text。
- Visual Asset Manifest identity 与 Task/Plan/Attempt 一致。

### 13.2 语义审查

Reviewer 检查：

- 是否真正回答 Research Goal。
- 是否遗漏 Required Question。
- 是否把推断写成事实。
- 是否存在相互冲突而未说明的证据。
- 建议是否能够从结论推出。
- 风险和限制是否充分。
- 图表是否误导。
- 视觉资产是否支持相邻结论，而非装饰。

### 13.3 视觉审查

- A4 Print 不截断图表、表格和图片。
- Web 报告在 1280px 和 1440px 宽度下无横向溢出。
- 图片可放大，原图和标注图关系清楚。
- 所有图表具有文本替代。
- 黑白打印仍可区分 Series；不能只依赖颜色。

## 14. 执行恢复

### 14.1 Tool Retry

只自动重试 `network`、`timeout`、`rate_limit`、`provider_5xx`；使用 Manifest `max_attempts/backoff_seconds`。Schema、Auth、Safety、Integrity 不重试。

### 14.2 Retry Lineage

新 Attempt 写 `retry_of`。复用 Step Artifact 的条件：

- Plan Hash 相同。
- Step 定义相同。
- 输入 Hash 相同。
- Skill/Tool Manifest Hash 相同。
- Input/Output Schema Hash 相同。
- Tool Config Hash 相同。
- Artifact SEALED 且 Hash 有效。

任一不满足则从该步骤及其下游重跑。

### 14.3 Recovery

服务启动时和周期任务执行：

- expire Lease
- pause worker_lost task
- reconcile STAGING Artifact
- invalidate stale terminal Artifact
- 记录 Recovery Summary

## 15. Web 体验

### 15.1 澄清阶段

用户看到：

- 系统当前理解
- 缺失信息
- 澄清问题
- 可编辑假设
- 为什么要问

提交后显示“需求已更新”，再进入候选选择。

### 15.2 计划阶段

每个候选展示：

- 研究子问题
- 每个问题的解决步骤
- Skill/Tool 选择理由
- 所需输入
- Evidence 要求
- Depth/Speed 权衡

### 15.3 执行阶段

展示真实 server step state、Question ID、Artifact/Evidence 数量、Retry/Fallback 结果；不合成虚假成功状态。

### 15.4 报告阶段

- 左侧章节导航。
- 执行摘要和关键指标优先。
- 图表、Screenshot、Heatmap 和对比矩阵内嵌。
- 结论可展开 Evidence。
- 图片支持原图/标注切换。
- 显示 Fact/Inference/Risk。
- 提供 Print PDF、Markdown Bundle 和 JSON 下载。

## 16. 测试策略

### 16.1 Requirement 场景

五个 Task Type 各覆盖：明确、模糊、缺输入、约束冲突、PII，共 25 个固定场景。

### 16.2 状态机

覆盖完整正常路径、澄清缺失、重复命令、版本冲突、foreign owner、并发 clarify/select/execute、审批拒绝和报告审查暂停。

### 16.3 Planning

验证 Success Criterion/Question/Step/Evidence 覆盖、DAG、required Tool、Skill input、Fallback、Depth/Speed 差异和能力淘汰理由。

### 16.4 Execution

验证 Tool retry、checkpoint 复用、retry lineage、worker crash、Lease expiry、Step seal fence、Artifact tamper、Model drift、Receipt failure、Optional gap 和 Core pause。

### 16.5 Synthesis

通过改变 Skill/LLM/Reviewer Artifact 内容，证明 Deliverable 和 Report Document 对应变化；未解析 Artifact ID 不得进入模型上下文。

### 16.6 Visual

验证 Binary Artifact Hash、MIME、尺寸、SSRF、Asset Manifest、Chart 数据引用、Derived Asset lineage、blocked sensitive export、SVG 安全和 ZIP 内容。

### 16.7 Browser

真实浏览器验证：

- 澄清和重规划。
- Question → Step 展示。
- 执行状态。
- 报告章节导航。
- Chart 渲染。
- 图片放大和原图/标注切换。
- Evidence 展开。
- Print Layout。
- Markdown Bundle 下载。
- Deliverable 读取失败独立重试。

### 16.8 真实门禁

每个新增 Deliverable 上线前至少完成一次真实 Gateway + Core Tool Smoke，记录实际模型、Tool Provenance、Evidence、Report Package 和 Review Artifact。无凭证时只能声明本地质量通过。

## 17. 分阶段交付

### 阶段 1：完整性加固

- Step Artifact lease fence。
- Server-side revision/hash。
- Current Candidate Schema。
- Planning provenance 绑定。

用户收益：消除伪 Plan Hash、失效 Lease 封存和候选结构漂移。

### 阶段 2：需求澄清闭环

- ResearchTaskV2。
- Requirement Version。
- awaiting_clarification。
- Clarify API/Web。
- 服务端重规划。

用户收益：回答澄清后，需求和计划真实变化。

### 阶段 3：问题图和能力编译

- Problem Graph。
- Capability Resolver。
- Plan Compiler。
- Skill input/provenance。
- CurrentPlanStep。

用户收益：看到每个子问题如何解决，执行前发现不可运行方案。

### 阶段 4：结果融合和报告审查

- Synthesis Materializer。
- Skill/LLM/Reviewer 正文进入报告。
- Draft → Review → Revision。

用户收益：每一步分析真实影响最终报告，Reviewer 能修正问题。

### 阶段 5：专业多模态报告

- Binary Artifact。
- Report Document。
- Visual Asset Manifest。
- Chart Spec/Renderer。
- Screenshot/Annotation/Heatmap。
- Web/Print/Bundle Renderer。
- Visual Quality Gate。

用户收益：获得可以直接汇报的 Web/PDF 专业报告，而不是文本列表。

### 阶段 6：多任务 Deliverable

按 `research_plan → competitive_analysis_report → voc_diagnosis_report → design_audit_report → accessibility_audit_report` 顺序上线。

用户收益：不同任务得到真正匹配的方法和报告结构。

### 阶段 7：恢复、并行和 Gold

- Tool retry。
- Checkpoint resume。
- Lease sweeper。
- Staging reconcile。
- DAG 并行。
- 五类 Gold 场景和独立评审。

用户收益：长任务更快，失败后从断点恢复，真实能力有持续门禁。

## 18. 迁移与回滚

- Migration 004 只新增表、列和状态，不删除旧数据。
- 已存在的 `research-deliverable-v1` 继续读取。
- 新 Report Package Artifact 不修改旧 Deliverable JSON。
- 新 Web 先兼容旧 Deliverable：缺 Report Document 时使用现有 CurrentStage4Report。
- 新写任务 clean cutover 到 ResearchTaskV2；不保留双写。
- 如果阶段 2 回滚，处于 `awaiting_clarification` 的任务保持不可执行并提示升级后继续，不能被旧服务错误执行。
- 如果 Visual 模块回滚，业务 Deliverable 和 Evidence 仍有效；报告降级为可信文本视图。
- 如果 Chart Renderer 失败，记录 visual gap；不得伪造图表。关键事实仍由文本和 Evidence 展示。

## 19. 依赖变化

根项目新增：

- `image-size`：服务端验证 PNG/JPEG/WebP 尺寸。
- `echarts`：服务端 SSR 生成并封存可信 SVG 图表。

Web 新增：

- `echarts`：交互式 SVG Chart Renderer；版本与根项目保持一致。
- `fflate`：生成 Markdown+Assets ZIP。

不新增外部服务、账号或 API Key。现有 Gateway、Tavily、AI Spider/Lab 的凭证策略保持不变。

## 20. 关键决策

1. 保留 Current Lease/Evidence/Artifact 主链，不重写工作流引擎。
2. Clarification 与 Confirmation 分离。
3. Current 使用独立 `CurrentPlanStep`，不修改 Legacy PlanStep。
4. LLM 只提议，Plan Compiler 和 Validator 裁决。
5. Deliverable、Report Document、Visual Assets、Review 分 Artifact 保存。
6. 图表由结构化数据和 Evidence 生成，不允许 LLM 编造数值或 SVG。
7. 报告最多自动修订一次。
8. 第一阶段执行仍串行；断点恢复稳定后才开放 DAG 并行。
9. 默认交付是交互式 Web + Print PDF；Markdown Bundle 和 JSON 为辅助。
10. 没有可信视觉数据时宁可少图，不生成装饰性或虚假图表。

## 21. 最终用户体验

完成后，用户流程为：

```text
提出需求
→ 系统解释当前理解并提出必要澄清
→ 用户补充后需求和候选计划自动更新
→ 用户看到研究子问题、能力选择理由和证据要求
→ 系统按可信计划执行并实时显示状态
→ 失败时自动重试或从有效断点恢复
→ 所有步骤结果进入报告融合
→ 报告经过 Evidence 校验、Reviewer 审查和一次修订
→ 用户获得包含图表、Screenshot、Heatmap、对比矩阵和证据附录的 Web/PDF 报告
→ 每条结论和视觉资产都可追溯到问题、步骤、Artifact 和 Evidence
```

核心提升不是“报告更花哨”，而是让视觉表达成为可信分析的一部分：图表帮助快速比较，截图帮助定位问题，Evidence 保证这些视觉结论不是装饰或幻觉。
