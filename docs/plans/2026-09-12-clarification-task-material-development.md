# 问询阶段 Task Material 与 Design Audit 执行闭环开发方案

> 日期：2026-09-12
> 状态：Phase 1 已实现并通过真实单图闭环验收；Phase 2 为独立后续增量
> 范围：问询阶段图片材料提交、Plan 继承、Design Audit 计划约束与 Visual Suite Annotation 适配
> 原则：只新增 Task-bound Material 一项基础能力，不增加数据库表、任务状态、Reviewer、Plan 版本或 Gate 版本

## 1. 背景

当前问询阶段支持：

```text
预设选项
自由文本
假设编辑
研究方向选择
```

但不支持：

```text
图片提交
CSV 提交
文件状态显示
已提交材料继承
```

项目已有上传能力位于 Plan 确认阶段：

```text
Stage 2 Plan
→ PendingInput
→ VisualInputGateStore / DatasetInputGateStore
→ Plan-bound SEALED Artifact
```

问询阶段还没有 Plan，因此不能直接复用当前 Plan-bound Gate。

## 2. 真实故障证据

### 2.1 问询合同没有材料字段

当前 `ClarifyControlTaskRequest` 只有：

```text
expectedVersion
clarificationAnswers
assumptionEdits
selectedScenarioId
idempotencyKey
```

当前组件：

```text
apps/web/src/components/stages/CurrentStage1Clarify.tsx
```

只渲染 radio、button 和 text input。

### 2.2 最新 Design Audit Plan 没有图片输入

真实任务：

```text
Task:    d0cb8200-c22b-4cf1-9b1d-5128ffd69f1f
Attempt: 1c8c3f92-a38e-4f54-abed-452645a00185
Type:    design_audit
State:   paused
```

冻结 Plan：

```text
deliverable: design_audit_report
candidate: focused
selected Skill: accessibility-review
pending_inputs: []
input gates: []
visual artifacts: []
```

执行预检失败：

```text
kind: authenticity
message: design audit requires exactly one materialized original
         and a finding-bound annotation producer
```

失败发生在：

```text
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
```

所有 Tool、Skill 和 LLM 均未执行。

### 2.3 当前合同互相矛盾

| 层级 | 当前合同 |
|---|---|
| Requirement | 可以只声明公开资料 |
| Planner | 允许无图片的 Design Audit Plan |
| Evidence Policy | public_source 可以满足最低证据 |
| Pending Input | 可以为空 |
| Execution Preflight | 强制恰好一张原始图片 |
| Design Audit Schema | `annotatedScreenshots` 至少一项 |

因此这不是偶发错误，而是确定性的合同断裂。

## 3. 目标

完成以下主链：

```text
问询发现材料需求
→ 用户在问询阶段提交图片
→ 图片成为 Task-bound SEALED Artifact
→ Clarification 只提交 Material ID
→ Planner 读取可信 Material Inventory
→ Plan 自动继承已有材料
→ Stage 2 显示“已提供”
→ 确认 Plan
→ Plan-bound Gate 引用同一份图片
→ Visual Analysis
→ Annotation
→ Design Audit Report
```

用户无法提供材料时：

```text
留在问询阶段
→ 改选不强制截图的 Deliverable
→ 再冻结 Task Type 与 Deliverable
```

## 4. 非目标

本方案不建设：

- 任意文件上传平台。
- PDF、PPT、视频或音频解析。
- Material 搜索和资料库。
- 跨 Task Material 复用。
- 文件版本树。
- 新 Reviewer。
- 新审核工作流。
- 新任务状态。
- 新编排模式。
- 旧任务迁移或自动补数据。
- Design Audit 多主图标注。
- CSV 问询上传首版。

匿名 CSV 继续使用现有 Stage 2 Dataset Gate。问询阶段 CSV 可在图片闭环稳定后作为独立增量，不与本次图片修复混合。

## 5. 设计规模检查

该改动会触及超过 5 个文件，因为它跨越：

```text
Requirement
Artifact
Clarification API
Planning
Stage 1 UI
Stage 2 UI
Execution
```

但只新增一个长期概念：

```text
Task-bound Material
```

明确不新增：

```text
TaskMaterial 数据库表
PlanMaterialBinding 数据库表
TaskMaterialRequest v1/v2 版本族
CurrentExecutionPlan v4
VisualInputGate v2
Material Reviewer
```

## 6. 核心设计决策

### 6.1 问题与材料分离

保留现有：

```text
clarification_questions
```

新增并列字段：

```text
material_requests
```

不采用：

```text
answer_type: visual_upload
```

原因是回答和材料具有不同的生命周期与可信边界。

### 6.2 复用 Control Artifact

数据库已经允许：

```text
control_artifacts.plan_version_id = NULL
control_artifacts.attempt_id = NULL
```

因此不新增数据库表。

图片仍使用现有 Artifact 合同：

```text
kind: visual_input_image
schemaVersion: visual-input-image-v1
```

区别仅在绑定范围：

```text
问询阶段：Task-bound
Plan 确认后：由 Plan-bound Gate 引用
```

### 6.3 不复制图片字节

一个图片只保存一次：

```text
Task-bound visual_input_image
```

Plan 创建：

```text
visual_input_gate
→ 引用 Task-bound image Artifact ID + Hash
```

不复制为第二份 Plan 图片。

### 6.4 不升级现有版本

采用可选字段扩展：

```text
ResearchTaskV2 + optional material_requests
ClarifyControlTaskRequest + optional materialBindings
CurrentPlanCandidate + optional providedMaterials
```

不新增 V3/V4。

### 6.5 Task Type 冻结时点保持不变

当前控制面在候选 Plan 持久化时写入最终：

```text
task_type
structured_task
```

因此材料可用性可以在问询阶段先确定，再生成候选 Plan，不破坏冻结规则。

## 7. Requirement 合同

### 7.1 Material Request

在 `ResearchTaskV2` 增加可选字段：

```ts
interface TaskMaterialRequest {
  id: string;
  role: string;
  kind: 'visual';
  label: string;
  required: boolean;
  multiple: boolean;
  reason: string;
}

interface ResearchTaskV2 {
  material_requests?: TaskMaterialRequest[];
}
```

首版仅允许：

```text
kind = visual
```

示例：

```json
{
  "id": "target-design",
  "role": "designImage",
  "kind": "visual",
  "label": "目标页面截图",
  "required": true,
  "multiple": false,
  "reason": "Design Audit 必须基于实际页面截图并生成问题标注"
}
```

### 7.2 Requirement 生成规则

出现以下意图时，Requirement 必须生成 Material Request：

```text
设计走查
设计审计
页面体验分析
视觉分析
基于截图判断问题
```

如果用户明确无法提供图片：

- 不生成可执行的 `design_audit_report`。
- 继续问询 Deliverable 选择。
- 可以改为 `research_strategy_report` 或 `research_plan`。

不得只把“请上传截图”写入：

```text
ambiguities
blocking_issues
assumptions
```

而不生成 Material Request。

## 8. Task-bound Artifact

### 8.1 ArtifactStore 最小扩展

将：

```ts
planVersionId: string
```

调整为：

```ts
planVersionId?: string
```

路径规则：

```text
Task-bound:
run-workspaces/current-control/tasks/<taskId>/materials/

Plan-bound:
run-workspaces/current-control/tasks/<taskId>/plans/<planVersionId>/

Attempt-bound:
run-workspaces/current-control/tasks/<taskId>/attempts/<attemptId>/
```

### 8.2 允许的 Task-bound 类型

只允许：

```text
visual_input_image
```

避免把 ArtifactStore 变成任意文件平台。

### 8.3 上传校验

只在上传边界执行一次：

- Owner 与 Task 绑定。
- Task 必须处于 `awaiting_clarification`。
- Material Request ID 和 Role 必须存在。
- PNG、JPEG、WebP。
- 10 MiB 上限。
- 20 MP 上限。
- 完整解码。
- MIME 与内容一致。
- SHA-256。
- PII／敏感信息策略。

完成后返回：

```ts
interface TaskMaterialResponse {
  materialId: string;
  requestId: string;
  role: string;
  fileName: string;
  mediaType: string;
  contentSha256: string;
  byteSize: number;
  state: 'SEALED';
}
```

## 9. 上传 API

新增：

```text
POST /api/control-tasks/:taskId/materials/visual
Content-Type: multipart/form-data
Idempotency-Key: <uuid>
```

字段：

```text
file
requestId
role
```

不接受：

- 远程任意 URL。
- Base64 JSON。
- 未声明 Role。
- 外部 Task 的 Request ID。
- `confidential` Material 进入当前模型路径。

读取接口：

```text
GET /api/control-tasks/:taskId/materials
```

只返回元数据，不返回图片 Base64。

## 10. Clarification 提交

扩展现有请求：

```ts
interface ClarifyControlTaskRequest {
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
  selectedScenarioId?: string;
  materialBindings?: Array<{
    requestId: string;
    materialIds: string[];
  }>;
  idempotencyKey: string;
}
```

服务端验证：

- Material 属于当前 Owner。
- Material 属于当前 Task。
- Artifact 为 SEALED。
- Role 与 Material Request 相同。
- 数量满足 `required` 和 `multiple`。
- Hash 与存储记录一致。

缺少必需材料时返回：

```text
422 required clarification materials are missing
```

不进入 Planning。

Material IDs 写入现有 Requirement Version 的 `clarification` JSON，不新增数据库字段。

## 11. Planner Material Inventory

Planning 输入增加只读派生数据：

```ts
interface VerifiedTaskMaterial {
  materialId: string;
  requestId: string;
  role: string;
  mediaType: string;
  contentSha256: string;
}
```

Planner 只能使用服务端验证后的 Inventory。

Capability Resolver 依据 Inventory 判断：

```text
designImage 已存在
→ design-experience-review 可执行

缺少 designImage
→ 不能生成 design_audit_report 候选
```

不把 `designImage` 塞进 Industry 专用的：

```text
IndustryMaterialRole
available_material_roles
```

## 12. Plan 继承材料

`CurrentPlanCandidate` 增加可选派生视图：

```ts
providedMaterials?: Array<{
  role: string;
  materialIds: string[];
  fileNames: string[];
}>;
```

它不是新的持久化 Binding 实体。

Plan 选定后创建现有：

```text
visual_input_gate
```

Gate Manifest 保持 v1，并引用：

```text
Task Material Artifact ID
contentSha256
mediaType
byteSize
```

`VisualInputGateStore.resolve` 调整为允许：

```text
Gate Artifact: Plan-bound
Image Artifact: 同 Task 的 Task-bound SEALED Artifact
```

仍拒绝：

- 外部 Task Artifact。
- Hash 不一致。
- FAILED／STAGING Artifact。
- 未列入 Gate Manifest 的图片。

## 13. Stage 1 UI

`CurrentStage1Clarify` 在普通问题之后渲染：

```text
所需材料
```

每项显示：

```text
目标页面截图                      必需
为什么需要：用于页面走查和问题标注
[选择图片]
```

上传状态：

```text
等待上传
上传中
已提供
上传失败
```

支持：

```text
查看文件名
替换
删除后重传
```

提交按钮条件：

```text
所有必答问题已回答
所有 required Material Request 已满足
研究方向已选择
```

不在前端自行判断文件可信度，服务端响应为准。

## 14. Stage 2 UI

已有材料不重复上传。

显示：

```text
目标页面截图
已在问询阶段提供：product-page.png
```

首版不允许在 Stage 2 替换 Task Material。需要更换时返回问询并重新生成候选 Plan，避免材料变化后 Plan 继续引用旧 Hash。

确认 Plan 时，客户端不重新发送 Base64；服务端从 Task Material 生成 Plan-bound Gate。

## 15. Design Audit Plan 一致性

在候选 Plan 校验阶段增加一个直接合同：

```text
if deliverable_type === design_audit_report:
  必须存在 designImage Material
  必须有 visual PendingInput 或 provided Material
  必须由可生成视觉发现的 Skill 消费
```

当前首版只允许能完成图片分析的 Design Audit 主 Skill。

以下 Plan 必须拒绝：

```text
accessibility-review 独立拥有 design_audit_report
pending_inputs = []
没有 visual-analysis 或 annotation source
```

拒绝发生在候选展示前，不进入 Confirmation，更不能进入 Execution。

不增加新的规则引擎或 Capability Flag 系统；只实现当前 Design Audit 的单一边界检查。

## 16. Annotation Producer 适配

当前 Annotation 只读取：

```text
attention-analysis-lab.hotspots
```

增加对现有 Suite Result 的读取：

```text
visual-analysis-suite.samples[0].attention.hotspots
```

Design Audit 首版要求一张主图，因此只允许：

```text
samples.length = 1
```

每个 Hotspot 转换为现有：

```text
FindingBoundVisualAnnotation
```

不新增 Annotation Schema。

Industry 多图只生成 Visual Contribution，不走 Design Audit 单图 Annotation 约束。

## 17. 验证边界

### 17.1 上传边界

执行：

```text
MIME
大小
解码
像素
Hash
Owner / Task
```

### 17.2 Plan 边界

执行：

```text
Role
数量
Skill 消费关系
Deliverable 一致性
```

不重新解码或重复 Hash。

### 17.3 Execution 边界

执行：

```text
SEALED 状态
Task / Plan Gate 绑定
Hash 未漂移
```

不重新做上传检查或模型审核。

## 18. 失败处理

### 上传失败

```text
保持 awaiting_clarification
显示单项错误
允许替换
不创建 Plan
```

### 必需材料缺失

```text
Clarify 返回 422
不调用 Planner
```

### 用户无法提供材料

```text
回到 Deliverable 选择
在候选 Plan 生成前改为非 Design Audit 交付
```

### Plan 没有消费材料

```text
候选校验失败
仅重新生成失败候选
不进入 Confirmation
```

### Artifact 漂移

```text
Execution Preflight fail closed
要求重新生成 Plan
不使用旧图片或 Cache
```

## 19. 实施步骤

### Phase 1：图片完整闭环（已完成）

该阶段必须整体完成，不能拆成只有 UI 或只有 Guard 的半成品。

1. 扩展 ResearchTaskV2 Material Request。
2. 支持 Task-bound Visual Artifact。
3. 增加问询图片上传／读取 API。
4. Clarify 接收并验证 Material ID。
5. Planner 接收 Verified Material Inventory。
6. Plan 返回 providedMaterials。
7. Stage 1 上传交互。
8. Stage 2 已提供状态。
9. Design Audit 候选一致性约束。
10. Visual Suite Annotation 适配。

完成后，图片型 Design Audit 可以端到端使用。

### Phase 2：匿名 CSV 问询材料（未实施，独立后续增量）

Phase 1 稳定后独立实施：

- 复用现有 CSV 解析、字段元数据、PII Gate 和 Model View。
- 允许 task-bound Dataset Raw/Profile。
- Plan Gate 引用同一 Dataset Artifact。
- 不改变图片合同。

Phase 2 不阻塞 Phase 1 发布。

## 20. 文件影响

预计修改：

```text
packages/api-contract/plan.ts
packages/api-contract/control-workflow.ts
schemas/research-task-v2.schema.json
apps/orchestrator-runtime/src/control/artifact-store.ts
apps/orchestrator-runtime/src/control/visual-input-gate-store.ts
apps/orchestrator-runtime/src/control/requirement-refinement-service.ts
apps/orchestrator-runtime/src/planners/capability-resolver.ts
apps/orchestrator-runtime/src/planners/plan-compiler.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/agent-api/src/control-runtime.ts
apps/agent-api/src/routes/control-tasks.ts
apps/web/src/api/client.ts
apps/web/src/hooks/useTaskFlow.ts
apps/web/src/components/stages/CurrentStage1Clarify.tsx
apps/web/src/components/stages/Stage2Plan.tsx
```

不新增数据库表。

可能新增文件最多 1 个，仅在现有 ArtifactStore 无法保持清晰接口时使用：

```text
apps/orchestrator-runtime/src/control/task-material.ts
```

默认优先修改现有深 Module，不新增该文件。

## 21. 最小测试

只增加四项定向验证：

### 21.1 问询上传

```text
上传一张图片
→ Task-bound SEALED Artifact
→ 无 Plan Version
→ Owner / Task / Role / Hash 正确
```

### 21.2 Plan 继承

```text
Clarify 提交 Material ID
→ Planner 识别 designImage
→ Stage 2 显示已提供
→ 不重复上传字节
```

### 21.3 无材料拒绝

```text
design_audit_report
+ 无 designImage
→ 候选 Plan 校验失败
→ Executor 不启动
```

### 21.4 Annotation

```text
一张真实图片
→ Visual Analysis Suite
→ Attention Hotspot
→ FindingBoundVisualAnnotation
→ annotatedScreenshots
```

不运行：

- 全量 Corpus。
- 多品类 Canary。
- 重复真实 Smoke。
- 新增人工审核。
- 全套视觉发布门禁。

## 22. 验收标准

```text
1. 问询阶段可提交实际图片。
2. 图片成为 Task-bound SEALED Artifact。
3. Clarification 不接收 Base64，只接收 Material ID。
4. 必需图片缺失时不能进入 Planning。
5. 用户上传一次，Stage 2 不要求再次上传。
6. Plan-bound Gate 不复制图片字节。
7. 无图片 Design Audit Plan 不会展示给用户。
8. accessibility-review 不能独立形成无图 Design Audit Plan。
9. Visual Suite Hotspot 可以生成 Annotation。
10. 视觉结果仍保持 provisional。
11. 旧 Task 不迁移、不回填。
12. 不新增 Reviewer、数据库表、任务状态和合同版本。
```

## 23. 回滚

代码回滚：

- 移除 `material_requests` 可选字段。
- 关闭问询图片上传路由。
- 恢复 Stage 1 原界面。
- Plan 继续使用现有 Stage 2 PendingInput。

数据回滚：

- Task-bound Material Artifact 保留为不可消费审计记录。
- 不影响现有 Plan、Attempt、Report 和 Evidence。
- 不需要数据库迁移回滚。

## 24. 当前失败任务处理

任务：

```text
d0cb8200-c22b-4cf1-9b1d-5128ffd69f1f
```

当前 Plan 已冻结且没有 Material Binding，不能通过 Retry 修复。

本方案完成后：

- 该旧任务未迁移或回填。
- 旧任务已通过现有 Abort 路径进入 `cancelled`。
- 新任务已在问询阶段提交图片并完成真实闭环验收。

## 25. 最终架构摘要

```text
Clarification Questions
        +
Material Requests
        ↓
Task-bound SEALED Visual Artifact
        ↓
Verified Material Inventory
        ↓
Current Plan + existing PendingInput
        ↓
Plan-bound Visual Gate Manifest
        ↓
Visual Analysis Suite
        ↓
Finding-bound Annotation
        ↓
Design Audit Canonical
```

新增长期概念：

```text
1 个：Task-bound Material
```

新增持久化版本：

```text
0 个
```

新增审核层：

```text
0 个
```

## 26. 设计自审结论

本方案经过实现前自审，结论为可实施，但必须遵守以下收敛边界：

- `material_requests` 是 Requirement 的可选声明字段，不是独立版本化实体。
- Task Material 继续写入 `control_artifacts`，不新增数据库表。
- `providedMaterials` 只作为 API 派生视图，不单独持久化。
- Plan Gate 直接引用 Task-bound 图片，不复制图片字节。
- Stage 2 首版只显示已提供材料，不允许原地替换；更换材料必须返回问询并重新生成 Plan。
- 不增加 Reviewer、Material Review、Task 状态、Plan 版本或 Gate 版本。
- 上传、Plan、Execution 三处检查分别负责文件可信度、消费关系和运行时漂移，不重复解码、重复 Hash 或重复内容审核。
- 首版只完成图片闭环；匿名 CSV 保持为独立后续阶段。
- Design Audit 当前只支持一张主图；多图 Industry 分析不复用单图 Annotation 约束。

如果实施过程中需要新增数据库表、第二套 Binding、通用文件类型或新的审核层，应停止开发并重新确认范围。

## 27. Phase 1 实施与验收记录

Phase 1 已完成以下主链：

```text
Material Request
→ Task-bound SEALED Artifact
→ Clarification Material Binding
→ Verified Material Inventory
→ Current Plan providedMaterials
→ Plan-bound Visual Gate 引用
→ Visual Analysis Suite
→ Finding-bound Annotation
→ Design Audit Report Package
```

真实单图验收：

```text
Task:       55fc86f7-5436-4f6b-97fb-abe701da8bfc
Plan:       deef396f-ad8d-4beb-b0d1-237207716bea
Attempt:    3b9ca213-9fcf-43d4-bfa6-00de7a421220
Material:   af5752d2-bf7e-4fb3-9893-804c3a9fb04d
Deliverable: f54dd8c8-a0fe-45c3-b7cf-b0e3fe88f81c
Evidence:   1fdb9122-b149-4c66-963b-6b5e58c4ce6f
Report:     ccd98b9f-3ae6-4b58-88c2-fbfa1234c83b
State:      completed_with_gaps
```

验收事实：

- 问询阶段上传的真实 JPEG 被封存为 Task-bound `visual_input_image`。
- Plan Gate 引用原 Material ID 与 Hash，没有创建第二份 Plan-bound 图片。
- Stage 2 通过 `providedMaterials` 显示已提供材料。
- `visual-analysis-suite`、`design-experience-review` 和 Reviewer 均真实执行成功。
- Requirement 规范化会移除已被 Material Request 取代的截图问答与 `missing_material` 阻塞，避免重复问询和虚假 Approval。
- Compacted 图片元数据保持符合 Design Review Skill 输入 Schema，原始 Base64 不进入 Skill LLM 上下文。
- Evidence Manifest 同时包含 `VA1-1` Core Tool Derived Evidence 与 `S1-1` Screenshot Evidence。
- Visual Suite Hotspot 生成 Finding-bound Annotation。
- 最终 `design_audit_report` 包含 5 个问题和 5 个 `annotatedScreenshots` 引用。
- 最终报告保持视觉结论边界，并以 `completed_with_gaps` 合法终态结束。
- `pnpm typecheck`、Task Material／Clarification／Planning／Gate／Annotation 定向测试及生产 API 集成测试均通过。
- 未新增数据库表、Task 状态、Reviewer、Plan 版本或 Gate 版本。

本轮未实施 Phase 2 问询 CSV；现有 Stage 2 Dataset 路径保持不变。
