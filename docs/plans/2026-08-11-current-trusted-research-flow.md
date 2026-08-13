# Current 可信研究闭环实施计划

> 状态：待用户确认后进入开发。确认后，本文件是 Milestone 1 的唯一计划真相源；聊天记录、旧汇报材料和旧 Superpowers 计划不得覆盖本文。
>
> 实施方式：测试先行；每个任务先写失败测试，再做最小实现。共享合同变更必须先修改本文，再修改代码。

## 1. 目标

将当前分裂的 Legacy Planner、Current Control Plane、Lease Execution、Evidence、Deliverable 和 Web 交付接成一条可复用主链：

```text
用户 Query
  -> Current Planning
  -> 服务端候选计划版本
  -> Select / Confirm / Approve
  -> LeaseExecutionEngine
  -> sealed Tool / Skill artifacts
  -> Evidence Manifest
  -> Research Deliverable
  -> Evidence / Schema validation
  -> owner-scoped API
  -> Web / Markdown
```

第一条真实验收场景：

```text
输入：针对宠物辅食做一个竞品研究方案
任务类型：competitive_research
交付物类型：research_plan
必需证据：public_source >= 1
核心能力：tavily-web-search + competitive-web-research + generate-research-plan
```

该案例只是 Smoke Fixture。业务代码不得出现 `pet_food`、`宠物辅食` 或同义特判。

## 2. 非目标

Milestone 1 不包含：

- 恢复 Legacy execute/resume。
- 新增 Tool、Skill 或 MCP 管理层。
- 恢复真实 O2。
- 多模型 fallback。
- 验证全部 22 个 Skill。
- 实现全部交付物 payload。
- Gold 三跑与开启 trusted Gold。
- 新建数据库表或修改数据库 schema。
- 删除 Legacy 历史数据。

## 3. 项目级控制合同

### Primary Setpoint

宠物辅食案例能从 Web 完成 Query -> Planning -> Select -> Confirm -> Real Execute -> Evidence -> Research Plan Deliverable -> Markdown，并且所有事实可反查 sealed Artifact。

### Acceptance

- `pnpm quality` 通过。
- `executionDisabled=false`。
- Tavily receipt 为 `executionMode=real`、`status=ok`。
- Tool、Skill、LLM、Reviewer 均有 execution step。
- 至少一个 sealed Tool Artifact。
- Evidence pointer 可解析到 sealed Artifact。
- Deliverable 通过 payload schema 和 Evidence graph 校验。
- Current API 能按 owner 返回 Deliverable。
- Web 能展示和导出 Markdown。
- 跨用户访问 conversation/task/artifact/deliverable 返回 404。
- 真实宠物辅食 Smoke 通过。

### Guardrails

- Fake Tool 不得作为真实执行成功。
- 模型漂移、Evidence 漂移、checksum 漂移必须 fail closed。
- 未脱敏 Tool 输出、完整 prompt、密钥、Bearer token 不得进入长期 Artifact。
- optional Tool 缺失不得阻断核心交付。
- Legacy 只读；Milestone 1 不产生新的 Legacy task。
- Gold 保持 `trusted_gold_enabled: false`。

### Rollback

- Milestone 1 不修改数据库 schema；应用版本回滚即可恢复 disabled execution。
- 已产生的 Current task、plan、attempt 和 sealed Artifact 保留审计，不做破坏性清理。
- Legacy 历史读取保持可用。
- 任何真实性门禁失败时停止推进，不回退 Fake。

## 4. 冻结架构

### 4.1 唯一写模型

新任务只写：

- `control_tasks`
- `control_plan_versions`
- `control_gate_records`
- `control_commands`
- `control_execution_attempts`
- `control_execution_steps`
- `control_model_calls`
- `control_artifacts`

Legacy `research_tasks`、Legacy workspace 和 Legacy artifacts 仅用于历史读取。

### 4.2 Module 与 Seam

```text
ResearchPlanningService
  Interface：Query -> structured task + candidates + provenance
  不负责数据库或文件写入

ControlPlaneRepository
  Interface：原子创建 Current task/candidates、状态转换、lease、artifact 元数据

TaskWorkflowService
  Interface：select / confirm / approve / revise / execute / resume
  不创建具体 Tool/LLM adapter

LeaseExecutionEngine
  Interface：有效 lease + 已冻结 plan -> execution result
  负责逐步执行、receipt、gap、Evidence 收集

CurrentDeliverableService
  Interface：execution outputs + Evidence -> validated sealed Deliverable

ControlArtifactStore
  Interface：write sealed JSON / read verified JSON / reconcile staging
```

HTTP route 只负责认证、请求解析和状态码映射，不承载业务判断。

## 5. 冻结 Interface

### 5.1 Evidence 类型

```ts
export type EvidenceClass =
  | 'public_source'
  | 'screenshot'
  | 'user_input'
  | 'knowledge'
  | 'dataset'
  | 'simulation'
  | 'derived';

export interface EvidenceRequirement {
  id: string;
  acceptedClasses: EvidenceClass[];
  minimumCount: number;
  required: boolean;
}
```

`acceptedClasses` 支持替代证据，例如设计走查可接受 screenshot 或 user_input 描述。

### 5.2 Execution Plan

```ts
export interface CurrentExecutionPlan {
  task_id: string;
  deliverable_type: DeliverableType;
  evidence_requirements: EvidenceRequirement[];
  steps: PlanStep[];
}
```

Milestone 1 的 `DeliverableType`：

```ts
export type DeliverableType = 'research_plan';
```

后续类型只能通过扩展 Registry 和 payload schema 增加，不得改写 Envelope。

### 5.3 Planning Interface

```ts
export interface ResearchPlanningInput {
  originalInput: string;
  directSkillId?: string;
}

export interface ResearchPlanningResult {
  task: ResearchTaskData;
  activatedNodes: string[];
  decisionStates: DecisionStateRec[];
  candidates: PlanCandidate[];
  guidanceSources: GuidanceRef[];
  provenance: PlanProvenance;
}

export interface ResearchPlanningService {
  plan(
    input: ResearchPlanningInput,
    onProgress?: (event: PlanProgress) => void,
  ): Promise<ResearchPlanningResult>;
}
```

Planning Module 不写数据库、不创建 Legacy workspace。

### 5.4 Candidate Interface

```ts
export interface CurrentPlanCandidate {
  planVersionId: string;
  candidateId: 'depth' | 'speed';
  title: string;
  rationale: string;
  tradeoffs: string;
  planHash: string;
  plan: CurrentExecutionPlan;
  pendingInputs: PendingInput[];
}

export interface SelectControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  idempotencyKey: string;
}
```

客户端禁止提交 plan、planHash 或 pendingInputs。服务端持久化并激活已有候选。

### 5.5 Evidence Entry

```ts
export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  evidenceClass: EvidenceClass;
  toolId?: string;
  toolTier?: 'core' | 'optional';
  artifactId: string;
  artifactContentSha256: string;
  jsonPointer: string;
  sourceUrl?: string;
  stepNo?: number;
  toolProof?: {
    implementationId: string;
    executionMode: 'real';
    redactedOutputHash: string;
  };
  sensitivity: 'public' | 'internal' | 'sensitive';
  redaction: 'none' | 'masked' | 'blocked';
}
```

`artifactContentSha256` 必须等于 sealed Artifact 文件字节 hash。Evidence 指向脱敏后持久化的对象。

Tavily result 的 pointer：

```text
/output/results/<originalIndex>
```

不得在过滤 URL 后重新编号。

### 5.6 Deliverable Envelope

```ts
export interface ResearchDeliverableEnvelope<TPayload> {
  version: 'research-deliverable-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableType: DeliverableType;
  evidenceManifestArtifactId: string;
  methodSummary: string;
  findingGraph: FindingGraph;
  payload: TPayload;
  recommendations: CurrentRecommendation[];
  risksAndOpenIssues: string[];
  capabilityProvenance: CapabilityProvenance[];
}
```

### 5.7 Research Plan Payload

```ts
export interface ResearchPlanPayload {
  title: string;
  researchGoal: string;
  scope: {
    market: string;
    subjects: string[];
    timeWindow: string;
  };
  competitorSampling: {
    strategy: string;
    targetCount: number;
    inclusionCriteria: string[];
    exclusionCriteria: string[];
  };
  researchQuestions: string[];
  comparisonDimensions: Array<{
    id: string;
    name: string;
    purpose: string;
    collectionFields: string[];
  }>;
  sourcePlan: Array<{
    evidenceClass: EvidenceClass;
    sourceTypes: string[];
    purpose: string;
  }>;
  executionPlan: Array<{
    phase: string;
    activities: string[];
    duration: string;
    outputs: string[];
  }>;
  collectionTemplate: Array<{
    field: string;
    description: string;
    evidenceRequired: boolean;
  }>;
  analysisMethods: string[];
  deliverables: string[];
  qualityChecks: string[];
}
```

### 5.8 Execution Result

```ts
export interface ControlExecutionResult {
  attemptId: string;
  state: ControlWorkflowState;
  stateVersion: number;
  status: 'completed' | 'completed_with_gaps' | 'paused';
  executionDisabled: false;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  gapCount?: number;
  failedStepNo?: number;
  failure?: Record<string, unknown>;
}
```

## 6. 冻结 Registry 策略

### 6.1 Evidence Policy Registry

创建：

`orchestrator/evidence-policy.yaml`

Milestone 1 内容：

```yaml
version: 1
policies:
  - task_type: competitive_research
    deliverable_type: research_plan
    requirements:
      - id: public-market-evidence
        accepted_classes: [public_source]
        minimum_count: 1
        required: true
```

Lease Engine 不得硬编码 Tavily。Planning 根据 `task_type + deliverable_type` 解析 Evidence requirements，并写入冻结 plan。

### 6.2 Deliverable Registry

创建：

`orchestrator/deliverable-registry.yaml`

```yaml
version: 1
deliverables:
  - id: research_plan
    status: active
    envelope_version: research-deliverable-v1
    payload_schema: schemas/deliverables/research-plan.schema.json
```

新增交付物只添加 Registry 和 payload schema；Envelope、Workflow、Evidence 不变。

## 7. 冻结 HTTP 合同

### 7.1 Current Planning

```text
POST /api/control-tasks/plan
POST /api/control-tasks/plan/stream
```

请求：

```ts
export interface PlanControlTaskRequest {
  originalInput: string;
  conversationId?: string;
}
```

SSE 事件：

```text
conversation
progress
result
error
```

Result：

```ts
export interface ControlPlanCandidatesResponse {
  kind: 'current';
  conversationId: string;
  task: ControlTaskResponse;
  structuredTask: ResearchTaskData;
  activatedNodes: string[];
  candidates: CurrentPlanCandidate[];
}
```

### 7.2 Select

```text
POST /api/control-tasks/:id/select
```

只接收 `SelectControlPlanRequest`。服务端校验 planVersionId 属于该 task，且版本未被激活或修改。

### 7.3 Confirm / Approve / Execute / Resume

```text
POST /api/control-tasks/:id/confirm
POST /api/control-tasks/:id/approve
POST /api/control-tasks/:id/execute
POST /api/control-tasks/:id/resume
```

沿用 Current 的 expectedVersion 和 Idempotency-Key 语义。

### 7.4 Read

```text
GET /api/control-tasks/:id
GET /api/control-tasks/:id/deliverable
```

`GET deliverable`：

- 验证 owner。
- task 必须为 completed 或 completed_with_gaps。
- Artifact 必须 SEALED。
- 返回前复核 checksum。
- 不返回 storageUri、完整 prompt、token 或未脱敏 Tool 输出。

### 7.5 Legacy HTTP

保留：

```text
GET /api/tasks
GET /api/tasks/:id
```

停止新写：

```text
POST /api/tasks/plan
POST /api/tasks/plan/stream
POST /api/tasks/:id/select
POST /api/tasks/:id/execute
POST /api/tasks/:id/resume
```

Web 新任务不得调用 Legacy HTTP。

## 8. 冻结数据库策略

### 8.1 Milestone 1 不新增 Migration

复用现有 Current 表。`deliverable_type` 与 `evidence_requirements` 存入 `control_plan_versions.plan_json`。

### 8.2 Planning Transaction

新增 Repository 操作：

```ts
createTaskWithCandidates(input: {
  conversationId: string;
  ownerUserId: string;
  originalInput: string;
  taskType: string | null;
  structuredTask: unknown;
  candidates: Array<{
    candidateId: string;
    plan: CurrentExecutionPlan;
    pendingInputs: unknown[];
  }>;
}): Promise<{
  task: ControlTask;
  candidates: ControlPlanVersionDetail[];
}>;
```

同一事务：

1. 验证 conversation owner。
2. Repository 生成唯一 taskId，不由 Planning application 传入。
3. 将生成的 taskId 强制写入每个 `CurrentExecutionPlan.task_id`。
4. Repository 对注入 taskId 后的完整 plan 做稳定 canonicalize，并计算 SHA-256 planHash。
5. 使用该 taskId 创建 `control_tasks(state=awaiting_selection, active_plan_version_id=null)`。
6. 创建 depth/speed 两个 immutable plan version，按输入顺序使用 version 1/2。
7. 任一步失败则 task、plan versions 与 hash 全部回滚。

### 8.3 Select Transaction

同一事务：

1. 锁 task。
2. 校验 state/version。
3. 读取服务端 candidate plan version。
4. 重算 canonical plan hash 并与持久化 hash 对比。
5. 设置 active_plan_version_id。
6. 转 awaiting_confirmation。
7. 记录 idempotent command。

客户端 plan/hash 不进入数据库。

### 8.4 Artifact 路径与 Kind

```text
steps/<stepNo>-tool_output.json
steps/<stepNo>-skill_output.json
steps/<stepNo>-llm_output.json
steps/<stepNo>-review_output.json
evidence/manifest.json
deliverables/final.json
```

Kind：

```text
tool_output
skill_output
llm_output
review_output
evidence_manifest
deliverable
```

Schema version：

```text
tool-output-v1
skill-output-v1
evidence-v1
research-deliverable-v1
```

### 8.5 完成状态

- 全部 required evidence 满足、无 gap：`completed`。
- required evidence 满足、存在 optional gap：`completed_with_gaps`。
- required evidence 不满足：`paused` 或 `failed`，不得生成最终 Deliverable。

## 9. Milestone 1 冻结边界

### 9.1 包含

- JWT fail-closed 与 owner 隔离。
- Current Planning Module。
- Current candidate persistence/select。
- Current HTTP/SSE。
- Web Current planning/select/confirm/execute。
- 真实 LeaseExecutionEngine driver。
- Tavily real Tool。
- `competitive-web-research`。
- `generate-research-plan`。
- LLM 和 Reviewer step。
- sealed artifacts。
- Evidence Manifest。
- `research_plan` Deliverable。
- Deliverable API、Web 和 Markdown。
- 宠物辅食真实 Smoke。

### 9.2 不包含

- 其他 20 个 Skill 的真实验收。
- 其他 Deliverable payload。
- optional Lab 全量接入。
- Gold。
- O2。
- 多模型 fallback。
- Legacy 数据迁移或删除。

### 9.3 完成门禁

```bash
pnpm quality
ALLOW_REAL_PROVIDER=1 TOOL_ADAPTER=real pnpm smoke:current:real
```

浏览器必须完成：

1. 登录。
2. 输入宠物辅食案例。
3. 选择 speed。
4. 确认默认假设。
5. 完成执行。
6. 查看 `completed` 或 `completed_with_gaps`。
7. 打开至少三个公开来源。
8. 导出 Markdown。
9. 刷新后重新打开同一 Current task。
10. 使用另一个用户访问，确认返回 404。

## 10. 任务依赖图

```text
合同与失败测试
  |-- 安全修复
  |-- ResearchPlanningService
  |     `-- Current candidate persistence
  |           `-- Current Planning HTTP/SSE
  |                 `-- Web Current Planning
  `-- Evidence Contract
        `-- Artifact verified reader
              `-- Deliverable schema/validator
                    `-- CurrentDeliverableService
                          `-- Lease Engine integration
                                `-- Production driver
                                      `-- Current Deliverable API
                                            `-- Web Execute/Deliverable
                                                  `-- Real Smoke
```

共享文件单 owner：

- `packages/api-contract/control-workflow.ts`
- `packages/api-contract/research-deliverable.ts`
- `database/control-plane.ts`
- `apps/orchestrator-runtime/src/evidence/evidence-service.ts`
- `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`

## 11. 测试矩阵

| Requirement | Test |
|---|---|
| JWT 缺失时启动失败 | `tests/auth-isolation.test.ts` |
| Conversation owner 隔离 | `tests/auth-isolation.test.ts` |
| Planner 不创建 Legacy task | `tests/control-planning.test.ts` |
| 两候选原子持久化 | `tests/control-planning.test.ts` |
| 客户端不能提交或篡改 plan | `tests/task-workflow.test.ts` |
| Current Planning HTTP/SSE | `tests/control-api-integration.test.ts` |
| Execute 调用真实 driver | `tests/control-api-integration.test.ts` |
| Artifact checksum | `tests/lease-execution-engine.test.ts` |
| Evidence pointer 可解析 | `tests/evidence-service.test.ts` |
| core Evidence requirement | `tests/evidence-service.test.ts` |
| Finding Graph 有根 | `tests/report-evidence-validator.test.ts` |
| Research Plan payload | `tests/research-plan-deliverable.test.ts` |
| optional gap | `tests/lease-execution-engine.test.ts` |
| model drift | `tests/model-receipt.test.ts` |
| lease lost | `tests/lease-execution-engine.test.ts` |
| 浏览器全流程 | 手工浏览器验收 |
| Tavily real | `smoke:current:real` |

## 12. Milestone 1 执行清单

### Contracts and failing tests

- [ ] 创建 `packages/api-contract/research-deliverable.ts`。
- [ ] 创建 `schemas/deliverables/research-plan.schema.json`。
- [ ] 创建 `orchestrator/evidence-policy.yaml`。
- [ ] 创建 `orchestrator/deliverable-registry.yaml`。
- [ ] 更新 `packages/api-contract/control-workflow.ts`。
- [ ] 增加 Current 主链失败测试。
- [ ] 增加 auth/owner 失败测试。
- [ ] 增加 Research Plan payload 测试。

### Security

- [ ] 删除 JWT 默认 secret。
- [ ] 修复 `.env` 加载顺序。
- [ ] 增加 active user 校验。
- [ ] `listMessages` 增加 owner 参数。
- [ ] Planning conversationId 校验 owner。
- [ ] task/artifact/deliverable 统一 owner 404。

### Planning

- [ ] 创建 `ResearchPlanningService`。
- [ ] Legacy Planner 改用该 Module，保持旧测试可读。
- [ ] 实现 Evidence Policy 解析。
- [ ] 生成 `CurrentExecutionPlan`。
- [ ] 实现 Repository taskId 与 canonical plan hash。
- [ ] 实现 `createTaskWithCandidates()` 事务。
- [ ] 将 select 改为只接收 planVersionId。
- [ ] 增加 Current Planning HTTP/SSE。
- [ ] Web 切换 Current Planning/Select。

### Artifact and Evidence

- [ ] 为 `ControlArtifactStore` 增加 `readVerifiedJson()`。
- [ ] 修改 EvidenceEntry 合同。
- [ ] `sourceRefs()` 保留 originalIndex。
- [ ] pointer 改为 `/output/results/<index>`。
- [ ] Evidence 绑定 artifactId/contentSha256。
- [ ] manifest 创建时强制 resolver。
- [ ] 根据冻结 plan 校验 Evidence requirements。
- [ ] 无 required evidence 时禁止 Deliverable。

### Deliverable

- [ ] 创建 `CurrentDeliverableService`。
- [ ] 创建 Research Plan payload validator。
- [ ] 生成 `ResearchDeliverableEnvelope<ResearchPlanPayload>`。
- [ ] 校验 fact/inference/analysis/summary/recommendation 根关系。
- [ ] sealed 写入 `deliverables/final.json`。
- [ ] gaps 机器注入 `risksAndOpenIssues`。
- [ ] 返回 deliverableArtifactId。

### Execution and composition

- [ ] 扩展 `LeaseExecutionResult`。
- [ ] 删除自由文本 summary 作为最终交付的路径。
- [ ] Lease Engine 调 CurrentDeliverableService。
- [ ] completed/completed_with_gaps 写入数据库。
- [ ] 创建 `apps/agent-api/src/control-runtime.ts`。
- [ ] 统一构造 Repository/Planner/Tool/LLM/Artifact/Deliverable/Engine/Workflow。
- [ ] 生产 TaskWorkflowService 注入真实 driver。
- [ ] 增加 Current Deliverable GET。

### Web

- [ ] 更新 `useTaskFlow` 使用 Current 状态/version。
- [ ] 支持 paused/retry/abort/completed_with_gaps。
- [ ] 创建 Current Research Plan 页面。
- [ ] 创建 Current Research Plan Markdown renderer。
- [ ] Evidence ID 和来源 URL 可见。
- [ ] gaps 与推断独立展示。
- [ ] Legacy history 保持只读展示。

### Verification

- [ ] 创建 `scripts/current-real-smoke.ts`。
- [ ] 增加 `smoke:current:real` script。
- [ ] 运行相关测试。
- [ ] 运行 `pnpm quality`。
- [ ] 运行宠物辅食真实 Smoke。
- [ ] 浏览器完成完整验收。
- [ ] 记录 taskId/planVersionId/attemptId/deliverableArtifactId。
- [ ] 复核至少三个公开来源。
- [ ] 跨用户访问验证 404。

## 13. Milestone 1 后续里程碑

### Milestone 2：通用化

- task_types 预筛。
- required_tools 位置和成功状态校验。
- `$skill` 直呼依赖处理。
- Tool retry_policy。
- optional 自动 gap。
- Skill provenance。
- expired lease sweeper。
- staging reconcile。
- 新增 interview_guide、audit_report、analysis_report payload。
- 增加访谈提纲、设计走查、VOC 三条真实场景。

### Milestone 3：Gold

- Gold runner 使用 Current 主链。
- 修复 Gold store batch/slot/pin/infra retry。
- Audit Package 纳入 deliverable/evidence/receipts。
- 评审身份来自认证用户。
- 三次真实运行和三次独立评审。
- 通过后才开启 trusted Gold。

## 14. 计划变更规则

以下对象已冻结：

- Current 是唯一新写主链。
- ResearchDeliverableEnvelope。
- EvidenceRequirement。
- EvidenceEntry sealed Artifact 绑定。
- Current Planning HTTP。
- Select 只接收 planVersionId。
- Milestone 1 不新增数据库 schema。
- Milestone 1 只交付 research_plan。
- 宠物辅食是 Smoke，不是业务特判。

如实施发现必须修改上述对象：

1. 停止对应代码任务。
2. 先修改本文的 Interface、HTTP、数据库或边界章节。
3. 说明原决策失效证据、影响文件和回滚变化。
4. 获得用户确认后再继续代码。
