# 可信多模态研究系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Current 可信执行底座上，补齐多轮需求理解、子问题图、能力编译、完整结果融合、报告审查、专业多模态报告和断点恢复，最终稳定交付可追溯的 Web/PDF 研究报告。

**Architecture:** 保留 `ControlPlanningService → TaskWorkflowService → LeaseExecutionEngine → Evidence → Deliverable` 主链，在干净 seam 上新增 Requirement Refinement、Problem Graph、Capability Resolver、Plan Compiler、Synthesis Materializer、Report Review、Visual Asset 和 Execution Recovery 深模块。业务 Deliverable、Report Document、Visual Assets 和 Review 分别封存为 Artifact；LLM 只提议，Schema、DAG、Evidence、Artifact 和状态机不变量由确定性代码裁决。

**Tech Stack:** TypeScript 5.7、Node.js ≥20 ESM、Express 5、PostgreSQL、AJV、React 18、Vite 6、`node:test`、ECharts SVG Renderer、`image-size`、`fflate`。

## Global Constraints

- 工作目录：`.worktrees/current-trusted-research-flow`；分支：`feat/current-trusted-research-flow`。
- 当前工作树包含大量未提交实现；每个 Task 只精确暂存自己列出的文件，禁止 `git commit -am`。
- Current 是唯一新写主链；Legacy mutation 继续 410，Legacy GET 历史继续可读。
- HTTP 请求字段沿用 camelCase；LLM/Plan/Artifact JSON 沿用现有 snake_case。
- 客户端不得提交完整 Current Plan 或 Plan Hash；服务端生成、清洗、编译并计算 canonical hash。
- 所有 Planning、Skill、LLM、Reviewer、Deliverable、Report Review 调用经过 `ReceiptLLMClient`，actual model drift 和 Receipt 写入失败 fail-closed。
- 所有终态 Artifact 必须在 active Lease 下 seal；读取时重新校验 hash、Task、Plan、Attempt 和引用图。
- Fact 只能由 Tool/Dataset/Screenshot Evidence 支撑；Skill/LLM 只能产生 Analysis/Inference；Reviewer 只能产生 Review。
- Optional Tool 普通失败可以形成 gap；Safety、Integrity、Core Evidence 失败必须暂停。
- 自动报告修订最多一次；第二次未通过则 paused。
- 用户上传只允许 PNG/JPEG/WebP，≤10 MiB，解码后≤20 Megapixels；用户 SVG 禁止。
- 远程图片必须来自真实 Tool Artifact 的已验证 HTTPS 字段，下载后封存；报告不得直接依赖远程 URL。
- 图表只允许 `bar | stacked_bar | line | heatmap | funnel`；数值必须绑定 Evidence。
- 不新增外部服务或新账号；新增 npm 依赖仅 `image-size`、`echarts`、`fflate`。
- 每个 Task 先写失败测试，再做最小实现；Task 完成时运行列出的定向测试。
- 每个阶段结束运行 `pnpm quality`；UI 阶段额外运行 `pnpm --dir apps/web build` 并用真实浏览器验收。
- 实施前先阅读：`docs/superpowers/specs/2026-08-14-trusted-multimodal-research-system-design.md`。

## Token-Efficient Execution Protocol

### 1. Phase 级上下文冻结

- 每个 Phase 开始时，主控只做一次定向 discovery，读取该 Phase 的设计章节、目标接口和文件清单。
- 主控把压缩后的不变量、接口、目标文件、验证命令写入 `local://phase-<N>-context.md`；同 Phase 的所有子代理复用该上下文包，不重复扫描仓库。
- 上游 Task 完成后只追加“新增接口、实际文件、验证结果、已知风险”；下游 Task 通过该上下文包或 agent handle 消费，不重新发现同一调用链。

### 2. 读取预算

- Task 已列出精确文件和符号：直接读取相关 section；禁止先读整文件、整目录或全仓 README。
- 定位符号优先 LSP definition/references；纯文本定位只在已知目录内做一次 targeted grep。
- 达到“能命名确切文件、接口、测试”即停止探索。只有工具失败、文件并发变化或新证据推翻假设时才允许第二轮读取。
- `database/control-plane.ts`、`lease-execution-engine.ts` 等大文件只读目标 range；禁止因修改一个函数读取千行文件。

### 3. Edit 后不重复审计

- `edit` 返回的新 snapshot 是下一步依据；成功 edit 后禁止为了确认而重读整文件。
- 只在 stale tag、意外冲突、formatter 改动目标文件或测试指出未知位置时重读最小 range。
- Formatter 只在 Task 完成后运行一次，不在每个 hunk 后运行。

### 4. Diff 和 Review 频率

- 禁止每次 edit 后运行 `git diff`、全仓 diff 或重复 Review。
- Task 提交前最多做一次 `git diff -- <Task owned files>`；输出过大时只保存 artifact，主控读取变更 hunk，不回显全量内容。
- 普通 Task 只做自检 + 定向测试，不派发双 Reviewer。
- Migration、auth、lease、Artifact、Evidence、安全下载等高风险 Task 才做 Task 级 targeted review。
- 每个 Phase 结束统一做一次 Spec Review + Code Quality/Security Review；最终分支只做一次 whole-scope review。

### 5. 验证频率

- 每个 Task 只运行计划列出的定向测试。
- `pnpm quality` 每个 Phase 结束运行一次；同一 Phase 内失败后只重跑失败的定向命令，修复完成后再跑一次 Phase quality。
- Web Browser 验收只在 Phase 2、Phase 5 和最终门禁执行；非 UI Task 不启动浏览器。
- 真实 Provider Smoke 只在 Task 25 执行；此前不得消耗真实配额。

### 6. 输出压缩

- 子代理只返回：改动文件、接口变化、定向测试结果、风险；禁止粘贴整文件、完整 diff 和完整测试日志。
- 长日志和大 diff 通过 `artifact://` 或 `local://` 传递；主控只读取失败段和必要 hunk。
- Phase Review 共享同一 frozen diff/context；不同 Reviewer 不各自重复做仓库 discovery。

### 7. 安全例外

- LSP references 对 exported symbol、数据库迁移、auth/owner、Lease/Artifact/Evidence 调用链仍为必需；低 token 不能作为跳过安全检查的理由。
- 如果 Task 实际触及计划外文件，立即停止并更新 Phase context；不得靠扩大扫描范围掩盖 scope drift。

---

## Phase 1：完整性加固

### Task 1: 更新被冻结的 Current 决策文档

**用户收益：** 后续工程不会在旧 Milestone 约束和新目标之间摇摆；每个实现者看到同一套边界。

**Files:**
- Modify: `docs/plans/2026-08-11-current-trusted-research-flow.md:753-797`

**Interfaces:**
- Consumes: 已批准设计 `docs/superpowers/specs/2026-08-14-trusted-multimodal-research-system-design.md`。
- Produces: 新的 Milestone 2–7 指针和冻结对象变更说明。

- [ ] **Step 1: 更新后续里程碑**

把旧 Milestone 2/3 替换为：

```markdown
### Milestone 2–7：可信多模态研究系统

实现真源：`docs/superpowers/specs/2026-08-14-trusted-multimodal-research-system-design.md`。

本里程碑获批修改 Current Planning HTTP、Current Plan JSON 和数据库 schema；以下旧约束继续有效：
- Current 是唯一新写主链。
- Legacy mutation 继续 410，Legacy GET 继续只读。
- Select 只接收 planVersionId。
- ResearchDeliverableEnvelope v1 保持不变。
- EvidenceEntry 必须绑定 SEALED Artifact。
- 客户端不得提交 plan 或 planHash。
```

- [ ] **Step 2: 检查无冲突表述**

Run: `grep -n "Milestone 2\|客户端不得提交\|ResearchDeliverableEnvelope" docs/plans/2026-08-11-current-trusted-research-flow.md`

Expected: 只出现新设计允许的表述，不再保留“后续仍只交付 research_plan”的全局限制。

- [ ] **Step 3: 精确提交**

```bash
git add docs/plans/2026-08-11-current-trusted-research-flow.md \
  docs/superpowers/specs/2026-08-14-trusted-multimodal-research-system-design.md \
  docs/superpowers/plans/2026-08-14-trusted-multimodal-research-system.md
git commit -m "docs: design trusted multimodal research flow"
```

### Task 2: 给 Current 候选增加严格 Schema

**用户收益：** 用户不会再看到只有标题、空步骤或结构漂移的假候选；问题在入库前失败。

**Files:**
- Create: `schemas/current-plan-candidates.schema.json`
- Modify: `apps/orchestrator-runtime/src/runtime/schema-registry.ts`
- Modify: `apps/orchestrator-runtime/src/planners/routed-planner.ts:93-152`
- Test: `tests/current-plan-candidate-schema.test.ts`

**Interfaces:**
- Produces: `current-plan-candidates` Schema；`RoutedPlanner` 在清洗前完成结构校验。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const validator = new SchemaValidator();

test('Current 候选必须恰好包含 depth 和 speed', () => {
  const errors = validator.validate('current-plan-candidates', {
    candidates: [{ id: 'depth', title: '深度方案', rationale: '完整', tradeoffs: '耗时', steps: [], assumptions: [] }],
  });
  assert.ok(errors.length > 0);
});

test('Current 候选拒绝空 rationale、tradeoffs 和 steps', () => {
  const errors = validator.validate('current-plan-candidates', {
    candidates: [
      { id: 'depth', title: '深度', rationale: '', tradeoffs: '', steps: [], assumptions: [] },
      { id: 'speed', title: '速度', rationale: '', tradeoffs: '', steps: [], assumptions: [] },
    ],
  });
  assert.ok(errors.length > 0);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/current-plan-candidate-schema.test.ts`

Expected: FAIL，`current-plan-candidates` 尚未注册或错误数组为空。

- [ ] **Step 3: 创建 Schema**

Schema 必须：

- 顶层只允许 `candidates`。
- `minItems=maxItems=2`。
- 第一项 `id=depth`，第二项 `id=speed`。
- title/rationale/tradeoffs `minLength=1`。
- steps `minItems=1`。
- actor_type 枚举为 `tool|skill|llm|reviewer`。
- step input 只能是 object。
- assumptions 使用 `{key,value,editable}`。
- `additionalProperties=false`。

- [ ] **Step 4: 注册并接入 Planner**

`schema-registry.ts` 将名称映射到新文件；`RoutedPlanner` 调用：

```ts
validator.validateOrThrow('current-plan-candidates', planGen.data);
```

删除 `raw.slice(0, 2)` 静默截断；候选不是恰好两项时直接失败。

- [ ] **Step 5: 运行测试**

Run: `pnpm exec tsx --test tests/current-plan-candidate-schema.test.ts tests/research-planning-service.test.ts tests/control-planning-service.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add schemas/current-plan-candidates.schema.json \
  apps/orchestrator-runtime/src/runtime/schema-registry.ts \
  apps/orchestrator-runtime/src/planners/routed-planner.ts \
  tests/current-plan-candidate-schema.test.ts
git commit -m "feat: validate current planning candidates"
```

### Task 3: 服务端拥有 Plan Revision 和 Canonical Hash

**用户收益：** 客户端无法通过伪造 Plan/Hash 绕过审批记录；任何修订都可解释、可重算。

**Files:**
- Modify: `packages/api-contract/control-workflow.ts:79-100`
- Modify: `apps/agent-api/src/routes/control-tasks.ts:199-229`
- Modify: `apps/agent-api/src/control-runtime.ts:99-140`
- Modify: `apps/orchestrator-runtime/src/control/task-workflow.ts:388-450`
- Modify: `database/control-plane.ts:567-612`
- Test: `tests/current-revision-integrity.test.ts`
- Test: `tests/task-workflow.test.ts` (migrate the existing revision caller to the server driver contract)

**Interfaces:**
- Replace client plan revision with `revisionInstruction: string`。
- Produces: server-generated Plan Version and canonical hash。

- [ ] **Step 1: 写失败测试**

```ts
test('revision 不接受客户端 plan 或 planHash', async () => {
  const response = await requestRevision({
    revisionInstruction: '把研究范围限制为国内宠物辅食品牌',
    plan: { steps: [] },
    planHash: 'sha256:forged',
  } as never);
  assert.equal(response.status, 400);
});

test('revision 使用服务端 planner 和 canonical hash', async () => {
  const result = await workflow.revise({
    taskId,
    expectedVersion,
    revisionInstruction: '减少样本数并保留公开来源',
    idempotencyKey: 'revise-1',
    actor: owner,
  });
  const plan = await repository.getPlanVersionDetail(result.planVersionId);
  assert.equal(plan?.planHash, canonicalPlanHash(plan!.plan));
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/current-revision-integrity.test.ts`

Expected: FAIL，当前接口仍接受 plan/planHash。

- [ ] **Step 3: 修改共享契约和路由**

定义：

```ts
export interface ReviseControlPlanRequest {
  expectedVersion: number;
  revisionInstruction: string;
  idempotencyKey: string;
}
```

路由拒绝 `plan` 和 `planHash` 字段。

- [ ] **Step 4: 修改 Workflow**

向 `TaskWorkflowService` 注入 `WorkflowPlanRevisionDriver`：

```ts
export interface WorkflowPlanRevisionDriver {
  revise(input: {
    taskId: string;
    activePlanVersionId: string;
    instruction: string;
  }): Promise<{ plan: unknown; pendingInputs: unknown[] }>;
}
```

Workflow 使用 driver 产物调用 repository；repository 内部调用 `canonicalPlanHash(plan)`，不接受外部 hash。`buildControlRuntime` 注入生产 driver：读取 active task/plan，以 `structuredTask.research_goal + revisionInstruction` 调用现有 `ResearchPlanningService`，保持当前 candidateId 的 depth/speed 取向，复用 active plan 已冻结的 `deliverable_type` 和 `evidence_requirements`，服务端清洗新 steps，保留 active pendingInputs。若 task/plan/candidate 无法解析则 fail-closed，不创建 revision。

- [ ] **Step 5: 运行测试**

Run: `pnpm exec tsx --test tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/api-contract/control-workflow.ts \
  apps/agent-api/src/routes/control-tasks.ts \
  apps/agent-api/src/control-runtime.ts \
  apps/orchestrator-runtime/src/control/task-workflow.ts \
  database/control-plane.ts \
  tests/current-revision-integrity.test.ts \
  tests/task-workflow.test.ts
git commit -m "fix: make current plan revisions server-owned"
```

### Task 4: 所有 Step Artifact 使用 Lease Fence

**用户收益：** Worker 已失去执行权时，迟到的结果不能进入报告或污染后续重试。

**Files:**
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts:451-495`
- Test: `tests/lease-execution-engine.test.ts`

**Interfaces:**
- Step `writeJson` 必须传 `activeLease`。

- [ ] **Step 1: 添加回归测试**

新增测试：Artifact 写入前 Lease 有效，在 seal 前使 Lease 过期，断言 Step Artifact 不得成为 SEALED，Attempt paused。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test --test-name-pattern="step Artifact.*lease" tests/lease-execution-engine.test.ts`

Expected: FAIL，Step Artifact 当前未携带 active lease。

- [ ] **Step 3: 修改写入**

```ts
const artifact = await this.dependencies.artifacts.writeJson({
  taskId: input.lease.taskId,
  planVersionId: input.lease.planVersionId,
  attemptId: input.lease.attemptId,
  kind: result.kind,
  relativePath: `steps/${step.step_no}-${result.kind}.json`,
  value: artifactValue,
  schemaVersion: STEP_ARTIFACT_SCHEMA_VERSIONS[result.kind],
  activeLease: input.lease,
});
```

- [ ] **Step 4: 运行测试**

Run: `pnpm exec tsx --test tests/lease-execution-engine.test.ts tests/control-plane.test.ts`

Expected: PASS。

- [ ] **Step 5: 阶段门禁和提交**

Run: `pnpm quality`

```bash
git add apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/lease-execution-engine.test.ts
git commit -m "fix: fence step artifacts with active leases"
```

---

## Phase 2：需求澄清闭环

### Task 5: Migration 004 和 ResearchTaskV2 契约

**用户收益：** 用户每次补充的信息都有版本记录，不会出现“回答过了但系统忘了”。

**Files:**
- Create: `database/migrations/004_requirement_and_media.sql`
- Create: `schemas/research-task-v2.schema.json`
- Modify: `packages/api-contract/plan.ts`
- Modify: `packages/api-contract/control-workflow.ts`
- Modify: `database/control-plane.ts`
- Test: `tests/requirement-version.test.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `ResearchTaskV2`、`ControlRequirementVersion`、`awaiting_clarification` 状态。

- [ ] **Step 1: 写数据库失败测试**

测试创建 task、写 requirement v1/v2、切换 active version，断言 `(task_id, version)` 唯一且 foreign task 不可写。

- [ ] **Step 2: 写 ResearchTaskV2 Schema 测试**

```ts
test('ResearchTaskV2 要求成功标准、歧义和澄清问题', () => {
  const errors = validator.validate('research-task-v2', {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '宠物消费',
    research_goal: '分析宠物辅食竞品',
  });
  assert.ok(errors.length > 0);
});
```

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/requirement-version.test.ts tests/schema.test.ts`

Expected: FAIL，迁移和 Schema 尚不存在。

- [ ] **Step 4: 创建 Migration**

Migration 必须：

- 新建 `control_requirement_versions`。
- `control_tasks.active_requirement_version_id` 外键。
- 状态约束增加 `awaiting_clarification`、`reviewing`、`composing_report`。
- `control_artifacts` 增加 nullable `media_type`、`metadata_json`。
- 不修改或删除旧行。

- [ ] **Step 5: 增加 Repository 方法**

```ts
createRequirementVersion(input): Promise<ControlRequirementVersion>
getActiveRequirementVersion(taskId): Promise<ControlRequirementVersion | null>
activateRequirementVersion(input): Promise<ControlTaskDetail>
```

全部使用事务和 expected stateVersion。

- [ ] **Step 6: 运行测试**

Run: `pnpm exec tsx --test tests/requirement-version.test.ts tests/schema.test.ts tests/migration-runner.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add database/migrations/004_requirement_and_media.sql \
  schemas/research-task-v2.schema.json \
  packages/api-contract/plan.ts \
  packages/api-contract/control-workflow.ts \
  database/control-plane.ts \
  tests/requirement-version.test.ts \
  tests/schema.test.ts
git commit -m "feat: version current research requirements"
```

### Task 6: RequirementRefinementService

**用户收益：** 系统会先把关键问题问清楚，再给方案；回答会真实改变结构化需求。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`
- Modify: `apps/orchestrator-runtime/src/planners/research-planning-service.ts`
- Modify: `apps/agent-api/src/control-runtime.ts`
- Test: `tests/requirement-refinement-service.test.ts`

**Interfaces:**
- Produces: `understand()` 和 `clarify()`。
- Consumes: conversation messages、Receipt LLM、SchemaValidator、requirement repository。

- [ ] **Step 1: 写场景测试**

覆盖：

1. 明确需求直接 `ready_to_plan`。
2. 模糊需求返回 `clarification_required`。
3. 澄清答案写入 v2 并清空 blocking ambiguity。
4. 会话历史进入 LLM context。
5. model drift 时不激活 requirement version。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/requirement-refinement-service.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现接口**

```ts
export type RequirementRefinementResult =
  | { status: 'clarification_required'; taskId: string; requirement: ResearchTaskV2 }
  | { status: 'ready_to_plan'; taskId: string; requirement: ResearchTaskV2 };

export class RequirementRefinementService {
  async understand(input: UnderstandInput): Promise<RequirementRefinementResult>;
  async clarify(input: ClarifyInput): Promise<RequirementRefinementResult>;
}
```

规则：存在 `blocking=true` ambiguity 或非空 `clarification_questions` 时不得调用 Planner。

- [ ] **Step 4: 接入会话消息**

扩展 `ConversationAdapter`：

```ts
listMessages(input: { conversationId: string; ownerUserId: string }): Promise<Array<{ role: string; content: string }>>
appendMessage(input: { conversationId: string; role: 'user' | 'assistant'; content: string }): Promise<void>
```

只读取属于当前 owner 的会话。

- [ ] **Step 5: 运行测试**

Run: `pnpm exec tsx --test tests/requirement-refinement-service.test.ts tests/research-planning-service.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/orchestrator-runtime/src/control/requirement-refinement-service.ts \
  apps/orchestrator-runtime/src/planners/research-planning-service.ts \
  apps/agent-api/src/control-runtime.ts \
  tests/requirement-refinement-service.test.ts
git commit -m "feat: add current requirement refinement loop"
```

### Task 7: Clarify API、SSE 和 Web 阶段

**用户收益：** 用户能看到系统缺什么、为什么要问；提交后候选方案自动更新。

**Files:**
- Modify: `apps/agent-api/src/routes/control-planning.ts`
- Modify: `apps/agent-api/src/routes/control-tasks.ts`（clarification reservation 的 post-activation failure recovery）
- Modify: `apps/agent-api/src/server.ts`
- Modify: `apps/agent-api/src/control-runtime.ts` (runtime exposure seam; existing `controlPlanning` service)
- Modify: `apps/orchestrator-runtime/src/control/control-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`（匹配 active requirement 的 retry resume）
- Modify: `apps/orchestrator-runtime/src/planners/plan-strategy.ts`
- Modify: `apps/orchestrator-runtime/src/planners/research-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/planners/routed-planner.ts`
- Modify: `apps/orchestrator-runtime/src/planners/direct-planner.ts`
- Modify: `database/control-plane.ts`（token-fenced immediate reclaim）
- Create: `database/migrations/005_clarification_command_reservation.sql`
- Modify: `database/repository.ts`
- Create: `database/migrations/006_message_idempotency.sql`
- Modify: `apps/web/src/api/client.ts`
- Modify: `packages/api-contract/control-workflow.ts`
- Modify: `packages/api-contract/http.ts`
- Create: `apps/web/src/components/stages/CurrentStage1Clarify.tsx`
- Modify: `apps/web/src/hooks/useTaskFlow.ts`（stable logical submission identity / stale request fence）
- Modify: `apps/web/src/current-flow-state.ts`（纯 submission state model）
- Modify: `apps/web/src/pages/Workbench.tsx`（clarificationSubmitting disabled wiring）
- Test: `tests/control-clarification.test.ts`
- Test: `tests/control-api-integration.test.ts`
- Test: `tests/control-planning-service.test.ts`
- Test: `tests/control-plane.test.ts`
- Test: `tests/requirement-refinement-service.test.ts`
- Test: `tests/db-roundtrip.test.ts`
- Test: `tests/current-flow-state.test.ts`

**Interfaces:**
- Produces: planning union response 和 `/api/control-tasks/:id/clarify`。
- Produces: `ControlPlaneRepository.persistExistingTaskWithCandidates()`，保留无 command reservation 的首次 ready planning；clarification ready 改用 `persistClarificationCandidatesAndCompleteCommand()`，单事务锁 task 与 matching pending command，完成 token/hash/actor/version fences 后写 canonical depth/speed、CAS task、构造完整 response 并完成同一 command。
- Produces: `ControlPlanningService.planExistingTask()`，消费 finalized `ResearchPlanningResult`，复用 candidate sanitization/evidence policy，返回原 conversation/task response。
- Consumes: `RequirementRefinementService` ready result 的 finalized planning result；ControlRuntime 通过 `controlPlanning` 暴露该 seam。
- Produces: `ControlPlaneRepository.createAndActivateRequirementVersion()`；同一事务锁 task、校验双 owner/state/version、插入下一 requirement version 并 CAS 激活完整 `ResearchTaskV2`。
- Produces: 数据库 durable clarification command reservation（pending/completed、token fence、expiry/reclaim、reserve/complete/release/wait），且不跨 LLM 持有事务。
- Produces: Current GET 的 `originalInput`/active `structuredTask` 与 Web refresh hydration。
- Produces: `ControlPlaneRepository.recoverCommandAfterFailure()`；task 仍是 expectedVersion 时 token-fenced 删除 pending，恰好由本请求 requirement activation 前进一版时保留 command 并立即过期，允许同 key/hash/旧 expectedVersion reclaim。
- Produces: `RequirementRefinementService.clarify()` 的 post-activation resume；仅 active requirement ID、stored clarification、stored `ResearchTaskV2` 与 expectedVersion+1 全部匹配时跳过 requirement LLM/新版本，并仅重跑下游 planner/persistence；其余 fail closed。
- Produces: Web clarification logical submission state；同 payload 在 in-flight/transport retry 复用 idempotency key，changed payload 换 key，success 清理 identity，request identity fence 忽略 stale settle；`clarificationSubmitting` 禁用提交组件。

**Phase 2 final-review closure（2026-08-14）：**

- supplied conversation 在创建 task 前通过 ControlRuntime 暴露的同一 injected ConversationAdapter 做 owner require；foreign/missing 统一 404 且零 task 写入。
- `PlanContext.requirement` 携带完整 `ResearchTaskV2`；routed decision/candidate context 与 receipt hash、direct step input 均保留 target audience、scope、constraints、success criteria、expected deliverables。
- clarification ready 不跨外部 LLM 持有事务；规划完成后由专用 repository transaction 原子持久化 candidates、task transition 和 completed command response。reclaimed old token 在任何 plan insert 前被拒绝；事务失败全部回滚；commit 后响应传递失败可由 durable response replay。
- Migration 006 为 assistant message 增 nullable partial-unique idempotency key；RequirementRefinementService 以 activated requirement version ID 派生 key，post-append retry 不重复消息。
- RED：7 个定向失败分别命中 pre-create authorization、V2 context、缺失 atomic repository seam、old-token/rollback、缺失 Migration 006、message duplicate 与缺失 requirement-version key。
- GREEN：精确串行 7 文件 suite 66/66；`pnpm typecheck` passed；`pnpm --dir apps/web build` passed（44 modules transformed）。

**Phase 2 planning recovery gate closure（2026-08-14）：**

- Direct invoke clean cutover：installed `$skill` 由 `DirectPlanner` 确定性生成严格 `depth`/`speed`；speed 仅含原 direct skill step，depth 复用同一语义的 direct skill input 并追加 `research-plan-reviewer`。两份计划保留 skill ID、trimmed rest 与完整 `ResearchTaskV2`，hash distinct，且不调用 routed candidate LLM；unknown skill 继续 fail closed。
- Candidate recovery contract：`CurrentExecutionPlan` 的 `candidate_metadata` 与 `activated_nodes` 在 `ControlPlanningService.prepareCandidates()` 写入，覆盖 initial、existing-task 与 atomic clarification 三条持久化路径，并在 repository canonical hash 前进入 plan JSON；不新增 DB column。
- Owner-scoped refresh：repository 在同一 read transaction 校验 task/conversation 双 owner、`awaiting_selection`、exact depth/speed、task binding、canonical hash、非空 metadata、同一 activated nodes；Current GET 返回可信 candidates/activatedNodes。Web 仅从该 payload 重建 `ControlPlanCandidatesResponse`，缺失或畸形数据进入 error，不回退 idle，也不触发 planner/plan write。
- Response-loss recovery：atomic clarification commit 后即使 HTTP response delivery 失败，普通 owner GET 仍恢复与 durable command response 相同的 plan version IDs/hashes；重复 GET 与同 key replay 保持 2 个 plan rows，planner/atomic persistence 不重跑。
- Progress forwarding：`RequirementRefinementService` 的 understand、clarify normal path 与 post-activation resume path 均透传可选 `onProgress`；production `/plan/stream` 经 runtime/refinement 观察到 `conversation → activate/guidance/states/candidates progress → result`。supplied conversation 仅在 owner require 成功后发布。
- TDD：direct/metadata、strict hydration、owner repository recovery、HTTP refresh/response-loss 与 refinement progress 均先出现对应失败，再以最小 seam 修复。
- Gate：用户指定 7 文件串行 suite 64/64 passed；`pnpm typecheck` passed；`pnpm --dir apps/web build` passed（Vite 44 modules transformed）；直调 speed execute smoke 与 control-plane regression 20/20 passed。
- Focused review closure：owner recovery 查询不预过滤 candidate ID，读取 task 全部 plan rows 后拒绝任何额外/未知 candidate；revision driver 与 repository depth/speed revision boundary 均校验并写入 regenerated `candidate_metadata`/`activated_nodes`，避免 revised canonical plan 丢失恢复合同。定向 reviewer regressions 28/28、相邻 workflow 11/11。

- [ ] **Step 1: 写 HTTP 测试**

覆盖：

- plan 返回 `clarification_required`。
- SSE 先发 conversation，再发 clarification result。
- foreign/missing task 统一 404。
- 缺答案保持 awaiting_clarification。
- clarify 成功返回 candidates。
- 重放同一 idempotency key 返回相同结果。
- 同 key/同 hash 跨并发/新 router 等待并重放；不同 hash 冲突。
- failed mutation 释放 pending；expired reservation 可 reclaim，旧 token completion fail closed。
- route/repository 双层 clarification state gate。
- clarification 规划保留原始 task input/direct invoke，并持久化/返回完整 `ResearchTaskV2`。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/control-clarification.test.ts tests/current-flow-state.test.ts`

Expected: FAIL。

- [ ] **Step 3: 修改 API 契约和路由**

路由只接受：

```ts
{
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
  idempotencyKey: string;
}
```

拒绝 plan、planHash、structuredTask。

- [ ] **Step 4: 实现 Web 阶段**

组件必须展示：当前理解、ambiguities、问题 rationale、assumptions。未回答所有 blocking questions 时按钮 disabled；建议值不得自动代替明确回答。

- [ ] **Step 5: 运行测试和 Web Build**

Run:

```bash
pnpm exec tsx --test tests/control-clarification.test.ts tests/current-flow-state.test.ts
pnpm --dir apps/web build
```

Expected: PASS。

- [ ] **Step 6: 浏览器验收**

运行开发栈，使用模糊需求“帮我看看这个产品体验怎么样”，验证：澄清页出现；回答目标用户/范围后出现新的 depth/speed candidates；刷新页面状态可恢复。

- [ ] **Step 7: 提交**

```bash
git add apps/agent-api/src/routes/control-planning.ts \
  apps/agent-api/src/routes/control-tasks.ts \
  apps/agent-api/src/server.ts \
  apps/web/src/api/client.ts \
  apps/web/src/components/stages/CurrentStage1Clarify.tsx \
  apps/web/src/hooks/useTaskFlow.ts \
  apps/web/src/pages/Workbench.tsx \
  tests/control-clarification.test.ts \
  tests/current-flow-state.test.ts
git commit -m "feat: add current clarification experience"
```

---

## Phase 3：问题图和能力编译

### Task 8: ProblemGraph Schema 和 Planner

**用户收益：** 计划按“要回答什么问题”组织，而不是只展示工具调用清单。

**Files:**
- Create: `schemas/problem-graph.schema.json`
- Create: `apps/orchestrator-runtime/src/planners/problem-graph-planner.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/schema-registry.ts`
- Test: `tests/problem-graph.test.ts`

**Interfaces:**
- Produces: `ProblemGraphPlanner.build(task): Promise<ProblemGraphResult>`。

- [ ] **Step 1: 写失败测试**

覆盖 ID 重复、未知 dependency、cycle、success criterion 未覆盖、required question 无 required evidence、happy path。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/problem-graph.test.ts`

Expected: FAIL。

- [ ] **Step 3: 创建 Schema 和纯校验函数**

```ts
export function validateProblemGraphCoverage(task: ResearchTaskV2, graph: ProblemGraph): void
```

错误使用 typed `ProblemGraphValidationError`，消息包含具体 criterion/question ID。

- [ ] **Step 4: 实现 Planner**

Planner context 只包含 finalized ResearchTask、Guidance 和 Evidence Policy；记录 `problem_graph` Receipt。模型输出先过 JSON Schema，再过 coverage/DAG 校验。

- [ ] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/problem-graph.test.ts tests/model-receipt.test.ts`

```bash
git add schemas/problem-graph.schema.json \
  apps/orchestrator-runtime/src/planners/problem-graph-planner.ts \
  apps/orchestrator-runtime/src/runtime/schema-registry.ts \
  tests/problem-graph.test.ts
git commit -m "feat: model current research problem graphs"
```

### Task 9: CapabilityResolver

**用户收益：** 系统在展示方案前就排除不可用或依赖不完整的能力，并解释选择理由。

**Files:**
- Create: `apps/orchestrator-runtime/src/planners/capability-resolver.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/config-loader.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/skill-loader.ts`
- Modify: `harness/linters/registry-linter.ts`
- Test: `tests/capability-resolver.test.ts`
- Test: `tests/registry-linter.test.ts`

**Interfaces:**
- Produces: `resolve(input): CapabilityResolution`。

- [ ] **Step 1: 写失败测试**

覆盖：task type 不匹配、required Tool inactive、Core Adapter unavailable、缺输入转 Pending Input、高风险无审批、eligible shortlist 和 rejection reasons。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/capability-resolver.test.ts tests/registry-linter.test.ts`

Expected: FAIL。

- [ ] **Step 3: 扩展 Registry 类型**

`SkillRegistryEntry` 增加：

```ts
inputs?: string[];
outputs?: string[];
```

Active Skill 的 `task_types`、inputs、outputs、required_tools 必须由 linter 校验为数组；引用的 Tool 必须存在。

- [ ] **Step 4: 实现硬过滤**

Resolver 不调用 LLM；输出 eligible/rejected 两组，保留具体理由。LLM Ranking 只接收 eligible shortlist。

- [ ] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/capability-resolver.test.ts tests/registry-linter.test.ts tests/p0-registry.test.ts`

```bash
git add apps/orchestrator-runtime/src/planners/capability-resolver.ts \
  apps/orchestrator-runtime/src/runtime/config-loader.ts \
  apps/orchestrator-runtime/src/runtime/skill-loader.ts \
  harness/linters/registry-linter.ts \
  tests/capability-resolver.test.ts \
  tests/registry-linter.test.ts
git commit -m "feat: resolve eligible current capabilities"
```

### Task 10: PlanCompiler 和 CurrentPlanStep

**用户收益：** Skill 依赖、步骤顺序、输入来源和验收标准在执行前得到验证。

**Files:**
- Modify: `packages/api-contract/research-deliverable.ts`
- Create: `schemas/current-execution-plan.schema.json`
- Create: `apps/orchestrator-runtime/src/planners/plan-compiler.ts`
- Modify: `apps/orchestrator-runtime/src/planners/problem-graph-planner.ts`
- Modify: `apps/orchestrator-runtime/src/planners/plan-strategy.ts`
- Modify: `apps/orchestrator-runtime/src/planners/routed-planner.ts`
- Modify: `apps/orchestrator-runtime/src/planners/research-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/control-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/schema-registry.ts`
- Modify: `apps/agent-api/src/control-runtime.ts`
- Modify: `database/control-plane.ts`
- Modify: `apps/orchestrator-runtime/src/gold-run.ts`
- Test: `tests/plan-compiler.test.ts`
- Test: `tests/control-planning-service.test.ts`
- Test: `tests/control-plane.test.ts`
- Test: `tests/control-api-integration.test.ts`
- Test fixture migration: `tests/auth-isolation.test.ts`, `tests/control-planning.test.ts`, `tests/current-revision-integrity.test.ts`, `tests/research-planning-service.test.ts`
- Report/progress: `.superpowers/sdd/task-10-report.md`, `.superpowers/sdd/progress.md`

**Scope correction:** Current planning assembly and every revision persistence path must invoke Task8/9 and PlanCompiler before repository insertion. The production runtime, requirement-planning seam, canonical repository revision gate, and existing strict-Current fixtures are therefore part of Task 10; Legacy `PlanStep` and Legacy planning remain unchanged.

**Interfaces:**
- Produces: `CurrentPlanStep`、`PlanCompiler.compile()`。

- [ ] **Step 1: 写失败测试**

覆盖：cycle、孤立 required question、Skill required Tool 缺失、Tool 在 Skill 后、input binding 指向未来步骤、unknown pointer、Core Evidence 缺失、合法 depth/speed。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/plan-compiler.test.ts`

Expected: FAIL。

- [ ] **Step 3: 定义 CurrentPlanStep**

使用设计规格中的 snake_case 字段，不修改 Legacy `PlanStep`。`CurrentExecutionPlan.steps` 改用 `CurrentPlanStep[]`，并新增 `problem_graph` 和 `capability_decisions`。

- [ ] **Step 4: 实现 Compiler**

Compiler 必须：

- 服务端重建 step_no。
- 拒绝未知 actor。
- 检查 question_ids。
- 检查 DAG。
- 检查 required_tools 和顺序。
- 检查 input_bindings。
- 检查 Evidence Policy。
- 计算 Pending Inputs。
- 生成 canonical plan object。

- [ ] **Step 5: 接入 Planning**

`ControlPlanningService` 不再只运行 `sanitizeCurrentSteps`；改为调用 Compiler，并把 Problem Graph 和 Capability Decisions 一起写 Plan Version。

- [ ] **Step 6: 运行测试和提交**

Run: `pnpm exec tsx --test tests/plan-compiler.test.ts tests/control-planning-service.test.ts tests/control-plane.test.ts`

```bash
git add packages/api-contract/research-deliverable.ts \
  schemas/current-execution-plan.schema.json \
  apps/orchestrator-runtime/src/planners/plan-compiler.ts \
  apps/orchestrator-runtime/src/control/control-planning-service.ts \
  apps/orchestrator-runtime/src/planners/routed-planner.ts \
  tests/plan-compiler.test.ts
git commit -m "feat: compile current execution plans"
```

### Task 11: 执行 Input Binding 和 Skill Provenance

**用户收益：** 后续 Skill 真正消费前序结果；不会出现“执行了 Skill，但输入其实没传进去”。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/step-input-resolver.ts`
- Create: `database/migrations/007_skill_provenance.sql`
- Create: `database/migrations/008_model_version.sql`
- Create: `.superpowers/sdd/task-11-report.md`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/llm-client.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts`
- Modify: `database/control-plane.ts`
- Modify: `apps/orchestrator-runtime/src/planners/plan-compiler.ts`, `apps/orchestrator-runtime/src/planners/routed-planner.ts`
- Modify: `apps/orchestrator-runtime/src/control/task-workflow.ts`, `apps/web/src/hooks/useTaskFlow.ts`
- Modify: `.superpowers/sdd/progress.md`
- Test: `tests/current-step-bindings.test.ts`, `tests/lease-execution-engine.test.ts`, `tests/execution-control.test.ts`, `tests/model-receipt.test.ts`, `tests/plan-compiler.test.ts`, `tests/task-workflow.test.ts`, `tests/control-plane.test.ts`, `tests/current-revision-integrity.test.ts`, `tests/control-api-integration.test.ts`, `tests/auth-isolation.test.ts`

**Scope correction:** Input Binding is execution-integrity state, so Task 11 also owns additive Migration 007 and the independent `skill_provenance` repository read/write path. Complete Skill provenance requires the database-generated model-call ID; `ModelCallRecorder` therefore returns the inserted ID and `ReceiptLLMClient` propagates it on successful results. All affected recorder fixtures migrate directly with no compatibility alias. Report/progress files record the expanded approved scope.

**Final-gate closure:** The approved scope includes generic Evidence Policy/Core Tool preflight (no provider ID), schema/registry-derived direct output pointers, complete actor contract context and dependency-scoped verified outputs, frozen pending-input own-field validation, extra input role rejection at API/workflow/Web boundaries, exact failed Skill receipt context recovery, and PostgreSQL receipt tuple validation (including model version) before candidate or revision plan insertion. These constraints are fail-closed and preserve Current safety; no compatibility alias or validation relaxation is permitted.

**Integrated review scope correction:** Task 11 also owns the confirmation-to-execution Pending Input value path, resolver-compatible compiler target validation, optional Tool source/fallback rejection, required-question success coverage, frozen high-risk approval authority, deterministic direct required Tool steps, resume Pending Input remapping, durable ProblemGraph receipt provenance, failed Skill receipt recovery, and shared API/Web `skillProvenance`. These are integrity constraints on the same frozen Current plan and execution boundary, not Phase 4 features. Inline image `dataUrl` remains an internal, 12 MB API-limited actor input only until Phase 5 replaces it with sealed upload Artifacts; it must not enter responses, logs, receipts, or unrelated prompts.

**Interfaces:**
- Produces: `resolveStepInput(step, sealedOutputs, artifactReader)`、`LLMResult.receiptId`、`TextLLMResult.receiptId`。

- [x] **Step 1: 写失败测试**

覆盖 JSON Pointer 解析、未知 source step、dangling pointer、Tool/Skill input schema、Skill body/schema hash provenance、后续步骤消费前序值。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/current-step-bindings.test.ts`

Expected: FAIL。

- [x] **Step 3: 实现 Resolver**

Resolver 只读取已 SEALED 的前序 Step Artifact，复制绑定值到 target pointer；不得读取内存中未 seal 输出。

- [x] **Step 4: 修改 runSkill**

Skill context 包含 resolved input、research goal 和允许的 prior outputs；验证 input/output schema；execution step provenance 写入：skill body hash、input/output schema hash、input/output hash、model receipt ID。

- [x] **Step 5: 运行测试和阶段门禁**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 tests/current-step-bindings.test.ts tests/lease-execution-engine.test.ts tests/execution-control.test.ts tests/model-receipt.test.ts tests/control-plane.test.ts tests/migration-runner.test.ts
pnpm typecheck
```

Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add .superpowers/sdd/task-11-report.md .superpowers/sdd/progress.md \
  docs/superpowers/plans/2026-08-14-trusted-multimodal-research-system.md \
  apps/orchestrator-runtime/src/control/step-input-resolver.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  apps/orchestrator-runtime/src/runtime/llm-client.ts \
  apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts \
  database/migrations/007_skill_provenance.sql database/control-plane.ts \
  tests/current-step-bindings.test.ts tests/lease-execution-engine.test.ts \
  tests/execution-control.test.ts tests/model-receipt.test.ts \
  tests/gateway-llm-receipt.test.ts tests/problem-graph.test.ts \
  tests/requirement-refinement-service.test.ts
git commit -m "feat: bind sealed outputs into current steps"
```

---

## Phase 4：结果融合和报告审查

**Integrated Phase 4 integrity correction:** Tool fact materials are EvidenceEntry/JSON-pointer scoped; deliverable revisions use immutable round-specific paths and terminal Review-bound IDs; review coverage IDs are explicit; the seven semantic dimensions are complete and fail closed; lease recovery covers `executing`/`reviewing`/`composing_report`; paused review writes an abort-only failed step; and terminal recovery invalidates Review, Manifest, and Deliverable together. Real ArtifactStore/PostgreSQL regressions cover these contracts.


### Task 12: SynthesisMaterializer

**用户收益：** Skill、LLM、Reviewer 的真实内容会进入最终报告，而不是只记录“执行过”。

**Files:**
- Create: `apps/orchestrator-runtime/src/report/synthesis-materializer.ts`
- Modify: `apps/orchestrator-runtime/src/report/current-deliverable-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/synthesis-materializer.test.ts`

**Interfaces:**
- Produces: `materialize(input): Promise<SynthesisMaterial[]>`。

- [x] **Step 1: 写失败测试**

覆盖：Tool→fact_source、Skill/LLM→analysis/inference、Reviewer→review、tampered Artifact、foreign attempt、blocked sensitivity、内容脱敏。

- [x] **Step 2: 写报告消费证明测试**

同一 Evidence 下分别改变 Skill 和 Reviewer Artifact，断言传给 Deliverable LLM 的 context 内容变化；Artifact ID/Hash 相同形状但正文不同不能得到相同 context hash。

- [x] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/synthesis-materializer.test.ts`

Expected: FAIL，现有 service 只传 sealed output metadata。

- [x] **Step 4: 实现 Materializer**

使用 `readVerifiedJson`，检查 Task/Plan/Attempt、Schema、Hash 和 sensitivity；返回设计规格中的 `SynthesisMaterial[]`。

- [x] **Step 5: 修改 Deliverable Context**

删除只有 metadata 的 `sealedOutputs`；context 改为：finalized requirement、problem graph、verified evidence、synthesis materials、gaps。

- [x] **Step 6: 运行测试和提交**

Run: `pnpm exec tsx --test tests/synthesis-materializer.test.ts tests/current-deliverable-service.test.ts tests/lease-execution-engine.test.ts`

```bash
git add apps/orchestrator-runtime/src/report/synthesis-materializer.ts \
  apps/orchestrator-runtime/src/report/current-deliverable-service.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/synthesis-materializer.test.ts
git commit -m "feat: synthesize from verified step materials"
```

### Task 13: ReportReviewService 和一次修订循环

**用户收益：** 报告会在交付前检查遗漏、无依据结论和不可执行建议，并自动修正一次。

**Files:**
- Create: `schemas/report-review.schema.json`
- Create: `apps/orchestrator-runtime/src/report/report-review-service.ts`
- Modify: `apps/orchestrator-runtime/src/report/current-deliverable-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Modify: `apps/orchestrator-runtime/src/control/task-workflow.ts`
- Test: `tests/report-review-service.test.ts`

**Interfaces:**
- Produces: `ReportReviewArtifact`、`reviewing` 状态、一次 `revise()`，以及 `ResearchDeliverableCoverage`：问题只绑定真实 Summary，成功标准只绑定真实 Conclusion/Recommendation。

- [x] **Step 1: 写失败测试**

覆盖 pass、revise 后 pass、第二次仍 revise→paused、block→paused、model drift、Receipt failure、review artifact seal。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/report-review-service.test.ts`

Expected: FAIL。

- [x] **Step 3: 实现确定性 Gate**

先严格验证 `coverage.questionBindings` 与 `coverage.successCriterionBindings` 的字段、唯一 ID、非空目标和报告节点引用，再要求每个必答 ProblemGraph 问题与 finalized success criterion 恰好有一个绑定。Review 不递归扫描正文或任意字符串；失败直接返回 block，不消耗 Reviewer LLM。

- [x] **Step 4: 实现语义 Review**

调用 `ReceiptLLMClient`，schemaName=`report-review`，stage=`deliverable_review`；输出严格通过 report-review schema。

- [x] **Step 5: 接入一次修订**

`verdict=revise` 时调用 DeliverableComposer.revise 一次，随后重新执行所有确定性和语义审查；不允许循环。

- [x] **Step 5a: 最终恢复语义收口**

显式 `failedStepNo` 必须命中当前 Attempt 的 failed step，否则立即 gate 且任务保持 paused。Command-loss replay 分别恢复整体 task 状态与 Review 状态：只有已验证 Review `verdict=pass` 才返回 `reviewStatus=completed`。

- [x] **Step 6: 运行测试和提交**

Run: `pnpm exec tsx --test tests/report-review-service.test.ts tests/current-deliverable-service.test.ts tests/model-receipt.test.ts`

```bash
git add schemas/report-review.schema.json \
  apps/orchestrator-runtime/src/report/report-review-service.ts \
  apps/orchestrator-runtime/src/report/current-deliverable-service.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  apps/orchestrator-runtime/src/control/task-workflow.ts \
  tests/report-review-service.test.ts
git commit -m "feat: review and revise current deliverables"
```

### Task 14: Verified Core Report Package 读取重验

**用户收益：** Phase 4 用户拿到经过完整性、身份、Evidence 图和终局 Review 重验的核心报告包；Phase 5 文档与视觉资产未生成时不会返回伪数据。

**Files:**
- Modify: `packages/api-contract/control-workflow.ts`
- Modify: `packages/api-contract/research-deliverable.ts`
- Create: `apps/orchestrator-runtime/src/report/current-report-package-reader.ts`
- Modify: `apps/orchestrator-runtime/src/report/current-deliverable-service.ts`
- Modify: `apps/agent-api/src/control-runtime.ts`
- Modify: `database/control-plane.ts`
- Test: `tests/report-package.test.ts`
- Test: `tests/control-api-integration.test.ts`
- Test: `tests/auth-isolation.test.ts`

**Interfaces:**
- Produces: `CurrentReportPackageResponse`，`presentationMode: 'legacy_text' | 'current_text' | 'multimodal'`。
- Phase 4 `current_text` 返回 verified deliverable、evidenceManifest 和 reportReview；`reportDocument`、`visualAssetManifest` 可选且必须缺席。
- Phase 5 Tasks 16–19 扩展 `multimodal`，届时 document/assets 成为必需。

- [x] **Step 1: 写失败测试**

覆盖 review-gated package happy path；missing/tampered/wrong Task/Plan/Attempt Review；Review 非 pass/非最终轮次；referenced Evidence/Finding Graph 重验；历史 marker fallback；foreign/missing 404。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test --test-concurrency=1 tests/report-package.test.ts`

Expected: FAIL，尚无 Verified Core Package reader。

- [x] **Step 3: 实现核心读取深模块**

所有 JSON Artifact 使用 `readVerifiedJson()`。验证 Deliverable、Evidence Manifest、Review 的 SEALED/schemaVersion/Task/Plan/Attempt；review-gated Deliverable 还必须通过严格 typed coverage 图重验；resolver 逐项重读 Evidence Artifact，再执行 Manifest 与 Finding Graph 验证。Review 必须绑定最终 Deliverable、`verdict=pass` 且 revisionRound 匹配最终 Review Artifact。

- [x] **Step 4: 用 schemaVersion marker 做历史兼容**

Task 13 新交付写 `research-deliverable-v1-review-gated`，缺失/篡改/错误/blocked Review 一律拒绝且不可降级。历史 `research-deliverable-v1` 返回 `legacy_text`；未知 marker 拒绝。Phase 4 不创建伪 `reportDocument` 或 `visualAssetManifest`。

- [x] **Step 5: 运行测试和阶段门禁**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 tests/report-package.test.ts tests/control-api-integration.test.ts tests/auth-isolation.test.ts tests/report-review-service.test.ts
pnpm typecheck
```

- [x] **Step 6: 提交**

```bash
git add packages/api-contract/control-workflow.ts packages/api-contract/research-deliverable.ts \
  apps/orchestrator-runtime/src/report/current-report-package-reader.ts \
  apps/orchestrator-runtime/src/report/current-deliverable-service.ts \
  apps/agent-api/src/control-runtime.ts database/control-plane.ts \
  tests/report-package.test.ts tests/control-api-integration.test.ts tests/auth-isolation.test.ts
git commit -m "feat: serve verified current report packages"
```

#### Task 14 Release-gate recovery report（2026-08-14）

- [x] Command-loss replay 以 verified final Review 绑定的 Deliverable 为事实源，并按 Deliverable 的 `evidenceManifestArtifactId` 精确读取、校验 SEALED/hash/schema/Task/Plan/Attempt；同 attempt 后写 M2 不再覆盖 M1 回放结果。
- [x] paused/completed replay 复用 strict `report-review` schema 与七维 invariant；未知 verdict 即使 Artifact hash 有效也 fail closed。
- [x] `resume` 在 recovered-state shortcut 前解析当前 attempt failed step，校验显式 `failedStepNo` 与 `allowedActions`；同动作/同一步可恢复，伪造步骤或动作拒绝，worker-loss 无显式步骤的 retry 保持可用。
- [x] `current_text`/`multimodal` package 类型收窄为 pass Review；Web API client 在 cast 前校验 `presentationMode` 与 pass verdict；Phase 4 Markdown/Stage4 仅渲染 `legacy_text`/`current_text`，显式拒绝 `multimodal`。
- [x] TDD：上述四项回归均先观察到预期失败，再完成最小修复。
- [x] Gate：指定四文件串行 suite 77/77 passed；`pnpm typecheck` passed。

---

## Phase 5：专业多模态报告

### Task 15: Binary Artifact Store

**用户收益：** 报告中的图片不会依赖会失效的远程链接，并具有与 JSON Evidence 相同的篡改保护。

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/orchestrator-runtime/src/control/artifact-store.ts`
- Modify: `database/control-plane.ts`
- Test: `tests/binary-artifact-store.test.ts`

**Interfaces:**
- Produces: `writeBinary()`、`readVerifiedBinary()`。

- [x] **Step 1: 安装依赖**

Run: `pnpm add image-size sharp @openclaw/fs-safe`

Expected: Node 22 project/CI runtime; `image-size` only performs low-cost header/dimension preflight, `sharp` is the local decode authority, and `fs-safe` native `require` mode owns fd-relative filesystem mutations.

- [x] **Step 2: 写失败测试**

覆盖 PNG/JPEG/WebP、10 MiB 上限、20 Megapixels、禁止 SVG、hash tamper、active lease fence、path traversal。

- [x] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/binary-artifact-store.test.ts`

Expected: FAIL。

- [x] **Step 4: 实现 Binary 方法**

复用 JSON 的 STAGING/hash/seal 过程；文件写入和读取统一通过 native Root capability，禁止复制第二套 seal、pathname cleanup 或 symlink race 逻辑。

- [x] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/binary-artifact-store.test.ts tests/control-plane.test.ts`

```bash
git add package.json pnpm-lock.yaml \
  apps/orchestrator-runtime/src/control/artifact-store.ts \
  database/control-plane.ts \
  tests/binary-artifact-store.test.ts
git commit -m "feat: seal binary current artifacts"
```

#### Task 15 execution note（2026-08-14）

- [x] 项目 engine 与 CI 统一到 Node 22；root package/lock 包含 `image-size`、`sharp` 和 `@openclaw/fs-safe@0.5.5`。native helper 使用 `require`，不可用时 fail closed，不回退到 pathname mutation。
- [x] JSON 与 binary 共用唯一 `writeBytes()`：STAGING claim → native Root no-clobber create/FAILED exact-byte reuse → exact-size positioned read/hash → lease-fenced seal → post-seal inode/hash recheck。success/failure/reconcile 均不执行不安全 pathname cleanup。
- [x] `image-size` 在 decode 前执行签名/尺寸与 10 MiB / 20 MP gate；`sharp` 完整 decode 单页 PNG/JPEG/WebP 到 raw。PNG 仅保留 bounded IDAT envelope 与 indexed sample/PLTE 严格校验，不再维护 JPEG/WebP 手写 bitstream parser。
- [x] verified read 通过 SEALED Task/Plan/Attempt relational binding 和 native nonblocking Root open，固定读取 sealed byte count，重验 inode/size/hash/decode/trusted metadata；symlink、FIFO、增长、篡改与路径替换 fail closed。
- [x] exact `storage_uri` 继续由 PostgreSQL advisory lock 串行化；真实并发双 claim 仅允许一个 live owner。identical FAILED publication 可复用，different bytes、SEALED、STAGING 保持 no-clobber。
- [x] 最终 Node 22 RED 为 33 pass / 2 个无效 hook 预期；按 `fs-safe` 官方 threat model对齐后，唯一有界审查发现 APNG animation chunk gap。APNG回归先失败，PNG envelope拒绝 `acTL`/`fcTL`/`fdAT` 后通过。最终 Binary 34/34、Binary+ControlPlane 73/73、`pnpm typecheck` passed。


### Task 16: VisualAssetService 和安全远程图片

**用户收益：** 截图可稳定展示、可放大、可追溯来源；内部图片不会被意外公开。

**Files:**
- Create: `schemas/visual-asset-manifest.schema.json`
- Create: `schemas/image-annotation.schema.json`
- Create: `apps/orchestrator-runtime/src/report/visual-asset-service.ts`
- Create: `apps/orchestrator-runtime/src/report/image-annotation-service.ts`
- Modify: `packages/api-contract/research-deliverable.ts`
- Modify: `apps/agent-api/src/routes/control-tasks.ts`
- Test: `tests/visual-asset-service.test.ts`
- Test: `tests/image-annotation-service.test.ts`
- Test: `tests/auth-isolation.test.ts`

**Interfaces:**
- Produces: ingest/derive/readVerified、结构化 annotation overlay 和 asset read route。

- [ ] **Step 1: 写安全失败测试**

覆盖 HTTP URL、loopback/private/link-local/metadata IP、重定向私网、MIME 欺骗、超大文件、Tool Artifact 无对应 pointer、foreign owner、blocked export。

- [ ] **Step 2: 写正常测试**

覆盖 ai-spider `oss_url`、用户 PNG、原图→annotated derived lineage、Heatmap derived lineage、Manifest hash；Annotation 测试坐标边界、Finding 引用、原图 Asset 引用和不可变原图。

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/visual-asset-service.test.ts tests/auth-isolation.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现 Ingest**

远程 URL 只能来自已验证 Tool Artifact JSON Pointer；每次 DNS/redirect 后重新验证地址；下载到临时文件，完成 MIME/size/dimension 后再写 Binary Artifact。

- [ ] **Step 5: 实现 Annotation 和 Heatmap Derive**

`image-annotation.schema.json` 只允许矩形、圆点、箭头和编号 callout；每个标注必须包含归一化坐标、findingId、label 和 severity。`ImageAnnotationService` 保存 overlay JSON，并由受控 SVG Renderer 与原图合成新的 Derived Artifact；不得修改原图。

- [ ] **Step 6: 实现 Asset Route**

统一 owner 404；按 Manifest 设置 Content-Type；不返回 storage URI；`exportPolicy=block` 返回 404。

- [ ] **Step 7: 运行测试和提交**

Run: `pnpm exec tsx --test tests/visual-asset-service.test.ts tests/image-annotation-service.test.ts tests/auth-isolation.test.ts tests/evidence-service.test.ts`

```bash
git add schemas/visual-asset-manifest.schema.json \
  schemas/image-annotation.schema.json \
  apps/orchestrator-runtime/src/report/visual-asset-service.ts \
  apps/orchestrator-runtime/src/report/image-annotation-service.ts \
  packages/api-contract/research-deliverable.ts \
  apps/agent-api/src/routes/control-tasks.ts \
  tests/visual-asset-service.test.ts \
  tests/image-annotation-service.test.ts \
  tests/auth-isolation.test.ts
git commit -m "feat: manage verified report visual assets"
```

#### Task 16 execution note（2026-08-16）

- [x] 新增 per-asset Visual Asset Manifest / Image Annotation Schema 与共享类型；Manifest 使用排除自身字段后的 canonical JSON SHA-256，绑定 Task/Plan/Attempt、Binary identity、可信媒体元数据、export policy 和不可变 lineage。
- [x] `VisualAssetService` 仅从 SEALED、kind/hash/binding 匹配的 Tool Artifact RFC 6901 pointer 接受 HTTP(S) URL；逐跳手动 redirect、逐目标 DNS/公网地址校验、实际响应体 10 MiB 限额、MIME/signature 一致后才调用唯一 Binary ArtifactStore。用户上传、derive 和 verified read 同样只经 ArtifactStore。
- [x] `ImageAnnotationService` 仅接受 rectangle/dot/arrow/numbered callout，严格验证 normalized bounds、Finding/label/severity 和 root-original identity；先封存 overlay，再从原图副本渲染并建立 annotation lineage。Heatmap 由通用 derive 建立同等不可变 lineage。
- [x] Asset route 在读 Asset 前执行 Task/Conversation owner 隔离；foreign、missing、blocked 和读取失败统一 generic 404；成功响应仅含 Manifest content type 与 verified bytes，不暴露 storage URI。
- [x] Observed verification: `pnpm exec tsx --test --test-concurrency=1 tests/visual-asset-service.test.ts tests/image-annotation-service.test.ts tests/auth-isolation.test.ts tests/evidence-service.test.ts` => 39/39 pass, 0 fail; `pnpm typecheck` passed. No commit was made.

#### Task 16 reviewer blocker correction（2026-08-16）

- [x] Production remote ingestion now binds every HTTP(S) hop to its validated public IP set with a fresh Node Agent lookup, while the original hostname remains the HTTP Host and HTTPS SNI identity; redirects repeat validation and pinning before transport.
- [x] The complete Visual Asset Manifest schema is enforced before persistence and on read, including Manifest Artifact schemaVersion, strict source shape, and root-versus-derived lineage coupling. The Asset route independently fails closed unless the Manifest is schema-valid and explicitly exportable as `allow` or `mask`.
- [x] The default Image Annotation path now uses a controlled `sharp` SVG composite renderer to create a real PNG Derived Artifact. Production runtime constructs it and exposes `annotateVisualAsset`; injected renderers remain test-only alternatives.
- [x] Final evidence observed by the main agent after the Node Response body type and UUID fixture-array type corrections: Task16 four-file suite 44/44 pass, 0 fail; `pnpm typecheck` passed. DNS pinning, Manifest/schemaVersion/route fail-closed validation, and the default production PNG annotation renderer are closed. No commit was made.

### Task 17: Chart Spec、Evidence 校验和 SVG Renderer

**用户收益：** 报告自动生成可信对比图、趋势图和热力图，所有数字都能点回来源。

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/package.json`
- Modify: `apps/web/pnpm-lock.yaml`
- Create: `schemas/chart-spec.schema.json`
- Create: `apps/orchestrator-runtime/src/report/chart-spec-validator.ts`
- Create: `apps/orchestrator-runtime/src/report/chart-renderer.ts`
- Create: `apps/web/src/reporting/ChartBlock.tsx`
- Test: `tests/chart-spec.test.ts`
- Test: `tests/chart-renderer.test.ts`

**Interfaces:**
- Produces: `validateChartSpec(spec, evidenceResolver)`、服务端 SEALED SVG Artifact 和交互式 ECharts SVG block。

- [x] **Step 1: 安装服务端和 Web 依赖**

Run:

```bash
pnpm add echarts
pnpm --dir apps/web add echarts
```

- [x] **Step 2: 写失败测试**

覆盖 unsupported type、series 长度不匹配、无 Evidence、dangling Evidence、null→0、误导性 non-zero baseline、零基线 comparison/trend 负值裁剪、heatmap 负值保留和 happy path；Renderer 测试 SVG 无 script/foreignObject/remote URL，通过 VisualAssetService seal 为 `chart_svg`，并断言 Evidence mismatch/dangling 在 derive 前拒绝。

- [x] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/chart-spec.test.ts tests/chart-renderer.test.ts`

Expected: FAIL。

- [x] **Step 4: 实现 Schema 和 Validator**

Validator 检查每个 series 的 evidenceIds；数据点必须存在于解析后的 Evidence Value；缺失值保持 null；comparison/trend 的显式零基线拒绝会被裁剪的负非空值，heatmap 负值保持有效。

- [x] **Step 5: 实现服务端和 Web SVG Renderer**

服务端使用 ECharts SSR SVG renderer；`renderAndSealChartSvg` 必须先用调用方提供的 Evidence resolver 执行 `validateChartSpec`，验证通过后才渲染并调用 `VisualAssetService.derive` seal。Web `ChartBlock` 使用 ECharts `renderer: 'svg'` 提供交互视图，颜色从 actor/competitor stable key 派生，组件 unmount 时 dispose，并在旁边提供表格型文本替代。

Cross-task persisted-Chart follow-up: `renderAndSealChartSvg` uses one active lease for SVG binary, Manifest, and a discoverable SEALED `verified-chart-v1` `chart_spec` JSON containing exact binding/spec/specHash/table/Asset reference, returns its Artifact id, and fails closed on an unsealed or misbound result. Chart identity remains in `spec.chartId` without a redundant alias. Main-agent verification observed chart-renderer + lease-execution-engine at 48 total / 47 pass / 1 existing provider skip / 0 fail; `pnpm typecheck` passed. Step 7 remains open.

- [x] **Step 6: 运行测试和 Web Build**

Run:

```bash
pnpm exec tsx --test tests/chart-spec.test.ts tests/chart-renderer.test.ts
pnpm --dir apps/web build
```

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml \
  apps/web/package.json apps/web/pnpm-lock.yaml \
  schemas/chart-spec.schema.json \
  apps/orchestrator-runtime/src/report/chart-spec-validator.ts \
  apps/orchestrator-runtime/src/report/chart-renderer.ts \
  apps/web/src/reporting/ChartBlock.tsx \
  tests/chart-spec.test.ts \
  tests/chart-renderer.test.ts
git commit -m "feat: render evidence-bound report charts"
```

### Task 18: ReportDocument 和专业模板 Composer

**用户收益：** 报告从字段列表升级为有封面、执行摘要、核心指标、分析、视觉证据、建议和附录的完整文档。

**Files:**
- Create: `schemas/report-document.schema.json`
- Create: `apps/orchestrator-runtime/src/report/report-document-composer.ts`
- Create: `orchestrator/report-templates/research-plan.yaml`
- Modify: `apps/orchestrator-runtime/src/runtime/config-loader.ts`
- Test: `tests/report-document.test.ts`

**Interfaces:**
- Produces: `composeReportDocument(input): ReportDocument`。

- [x] **Step 1: 写失败测试**

覆盖缺执行摘要、无 Evidence 的 Fact block、dangling asset、重复 section/block ID、required question 无 section、专业 research-plan happy path。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/report-document.test.ts`

Expected: FAIL。

- [x] **Step 3: 定义模板 YAML**

模板固定章节：cover、executive-summary、background、scope-method、key-metrics、findings、question-analysis、visual-evidence、comparison、conclusion、recommendations、risks、appendix。

- [x] **Step 4: 实现 Composer**

Composer 只接收 verified Deliverable/Manifest/Assets/Charts/Review；按模板生成 blocks。没有视觉数据时省略视觉 block，不生成占位图。

- [ ] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/report-document.test.ts tests/current-report-markdown.test.ts`

Main-agent final evidence after removing the independent Chart resolver and deriving Chart Evidence only from verified Manifest entries plus the sealed Artifact resolver: report-document + chart-spec + chart-renderer + current-report-markdown 44/44 passed; `pnpm typecheck` passed. Final focused Task18 re-review, Task19 renderer consumption, and commit remain pending.

```bash
git add schemas/report-document.schema.json \
  apps/orchestrator-runtime/src/report/report-document-composer.ts \
  orchestrator/report-templates/research-plan.yaml \
  apps/orchestrator-runtime/src/runtime/config-loader.ts \
  tests/report-document.test.ts
git commit -m "feat: compose professional current reports"
```

### Task 19: Web、Print PDF 和 Markdown Bundle Renderer

**用户收益：** 同一份报告可在线交互阅读、打印成 PDF，也可下载 Markdown+图片继续编辑。

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/pnpm-lock.yaml`
- Create: `apps/web/src/reporting/ReportDocumentView.tsx`
- Create: `apps/web/src/reporting/ImageBlock.tsx`
- Create: `apps/web/src/reporting/ImageComparisonBlock.tsx`
- Create: `apps/web/src/reporting/report-print.css`
- Create: `apps/web/src/reporting/report-bundle.ts`
- Modify: `apps/web/src/components/stages/CurrentStage4Report.tsx`
- Modify: `apps/web/src/pages/Workbench.tsx`
- Modify: `apps/web/src/api/client.ts`
- Test: `tests/report-bundle.test.ts`

**Interfaces:**
- Consumes: `CurrentReportPackageResponse`。
- Produces: Web view、Print view、ZIP bundle。

- [x] **Step 1: 安装 ZIP 依赖**（依赖与锁文件已存在；本次未运行安装命令）

Run: `pnpm --dir apps/web add fflate`

- [x] **Step 2: 写 Bundle 失败测试**

验证 ZIP 含 `report.md`、`assets/`、`evidence-manifest.json`、`visual-assets.json`、`report-review.json`；blocked asset 不进入 ZIP；Markdown 使用相对路径。

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/report-bundle.test.ts`

Expected: FAIL。

- [x] **Step 4: 实现 Web Blocks**

支持章节导航、Metric/Table/Chart/Image/Comparison/Evidence/Recommendation/Risk；点击 Finding 展开 Evidence；图片支持原图/标注切换；所有图片有 alt。

- [x] **Step 5: 实现 Print CSS**

A4、封面、目录、页眉页脚、page-break、SVG 不截断、表格重复表头、黑白打印可区分。

- [x] **Step 6: 实现 Bundle**

使用 `fflate.zipSync`，只加入 owner 已读取且 `exportPolicy!=block` 的 assets；Manifest 与 Markdown 一起打包。

Production composition follow-up implemented: after the final pass Review, `LeaseExecutionEngine` enters `composing_report`, re-reads the final verified Artifact set, and invokes an active-lease `ReportCompositionService` that seals `reports/report-document.json`. The production runtime uses the real ArtifactStore/VisualAssetService. Text-only professional documents are multimodal with `visualAssetManifests: []`; image/Chart documents retain exact ordered verified Manifests. No follow-up verification command was run in the worker assignment.

Reviewer-blocker closure implemented: (1) exact sealed attempt Visual Asset/Chart discovery with binding/hash/schema/spec/table/lineage verification and LeaseExecutionEngine handoff; (2) `report_document` terminal invalidation; (3) fail-closed Web VisualAssetManifest presentation-shape, export-policy, referenced-set, and package-binding validation; (4) pure associated Web table shape plus Web/Chart sealed-column and row-width enforcement; (5) Markdown sealed columns with equal header/separator/data widths and no duplicated `Series`.
Task17-to-Task19 persisted Chart cutover complete: the real renderer lease-seals and returns the exact `verified-chart-v1` `chart_spec` material consumed by `discoverAttemptMaterials`, alongside its matching `chart_svg` Asset/Manifest lineage. Main observed chart-renderer + lease-execution-engine at 48 total / 47 pass / 1 existing provider skip / 0 fail and passing `pnpm typecheck`; the Task19 production Chart discovery gate is closed. No commit was created.

- [x] **Step 7: 运行测试和 Build**

Run:

```bash
pnpm exec tsx --test tests/report-bundle.test.ts
pnpm --dir apps/web build
```

Observed by Main after all five reviewer fixes: lease execution, report package, report bundle, and ControlPlane suites 130 total / 129 pass / 1 existing provider skip / 0 fail; `pnpm typecheck` passed; Web build passed with a 246 KB main chunk and lazy ECharts. This documentation sync ran no command and created no commit.

- [x] **Step 8: 浏览器验收**

在 1280×800 和 1440×900 验证：导航、Chart、图片放大、对比、Evidence 展开、Print Preview、ZIP 下载；控制台无错误。

Observed by Main at 1280×800 and 1440×900: report render, `#comparison` navigation, Evidence `e1`/`e2` expansion, 125% zoom, interactive Chart plus one table, and print mode with actions/interactive Chart hidden, sealed SVG visible, and `thead` as `table-header-group`. A separate Gateway clarification defect leaves fresh tasks in `awaiting_clarification` and returns 500 on retry; it precedes Task19 and is not a renderer failure.

#### Phase 5 final integrated correction（2026-08-17）

- Hydrated editable assumption values equal to the active finalized Requirement reuse the existing latest-version recovery path; actual changes continue through ordinary refinement and existing atomic fences.
- Multimodal package replay resolves Chart values from verified Evidence, binds inline Chart identity/digest to the exact verified `chart_svg` Manifest, checks its deterministic sealed table, and executes full ReportDocument semantic validation before return.
- Exact annotation `derivedFrom` lineage now yields the production `image-comparison` view without a duplicate standalone annotation; package replay independently requires the verified after annotation's asset/Manifest/hash lineage tuple to match the verified before Asset/Manifest. Blocked discovery assets remain available only for internal lineage validation and are excluded from composer-visible visual/Chart output.
- Bundle JSON and Markdown rebuild Evidence list entries from verified safe Manifest fields, removing internal Artifact/model/provenance metadata while retaining public Evidence id/class and asset projections.
- Verification observed by Main: the six-file Phase 5 integrated suite completed at 137 total / 136 pass / 1 existing provider skip / 0 fail; after the behavior-preserving pure ReportDocument view-model extraction, the focused report-document + report-bundle suite completed at 32/32 and the Web production build passed; after the additional package comparison-lineage correction, `report-package` completed at 43/43 and `pnpm typecheck` passed. Final Phase 5 re-review remains pending, with no phase-complete/final-approval or commit claim.

- [ ] **Step 9: 阶段门禁和提交**

Run: `pnpm quality`

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml \
  apps/web/src/reporting/ReportDocumentView.tsx \
  apps/web/src/reporting/ImageBlock.tsx \
  apps/web/src/reporting/ImageComparisonBlock.tsx \
  apps/web/src/reporting/report-print.css \
  apps/web/src/reporting/report-bundle.ts \
  apps/web/src/components/stages/CurrentStage4Report.tsx \
  apps/web/src/pages/Workbench.tsx \
  apps/web/src/api/client.ts \
  tests/report-bundle.test.ts
git commit -m "feat: deliver professional multimodal reports"
```

---

## Phase 6：多任务 Deliverable

### Task 20: Deliverable Registry v2 Runtime

**用户收益：** 系统能按任务选择正确报告，不再把所有需求塞进 research_plan。

**Files:**
- Modify: `orchestrator/deliverable-registry.yaml`
- Create: `apps/orchestrator-runtime/src/report/deliverable-registry.ts`
- Modify: `harness/linters/registry-linter.ts`
- Modify: `apps/orchestrator-runtime/src/report/current-deliverable-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/deliverable-registry-v2.test.ts`

**Interfaces:**
- Produces: `resolveDeliverable(taskType, expectedDeliverables)`。

- [x] **Step 1: 写失败测试**

覆盖缺 schema/prompt/rubric/policy/template、重复 task mapping、unsupported task type、inactive deliverable、research_plan happy path。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/deliverable-registry-v2.test.ts`

Expected: FAIL。

- [x] **Step 3: 实现 Registry Loader**

Runtime 解析并验证 v2 Registry；DeliverableService 不再直接引用固定 research-plan schema path；Engine 不再硬编码 `deliverable_type === research_plan`。

Implementation fact (2026-08-17 review-blocker cutover): Planning and direct RED fixtures pass explicit canonical Registry selections into a global-state-free Compiler; report generation, evidence validation, review, and composition consume selected schema/prompt/rubric/template; aliases are strict exact matches; Engine resolves canonical resources without rebinding legacy plan evidence. Task 21 extends the production Registry from the original `user_research_planning -> research_plan` mapping to all five task types, closing the planning/report pipeline gate without changing this runtime contract. Main observed the final joint eight-file suite at 202 total / 201 pass / 1 existing provider skip / 0 fail; `pnpm typecheck`, `registry-linter`, and `knowledge-linter` passed. Step 4 remains unchecked only because commit is pending; this worker ran no command.

- [ ] **Step 4: 运行测试和提交**

Run: `pnpm exec tsx --test tests/deliverable-registry-v2.test.ts tests/current-deliverable-service.test.ts`

```bash
git add orchestrator/deliverable-registry.yaml \
  apps/orchestrator-runtime/src/report/deliverable-registry.ts \
  harness/linters/registry-linter.ts \
  apps/orchestrator-runtime/src/report/current-deliverable-service.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/deliverable-registry-v2.test.ts
git commit -m "feat: resolve current deliverables from registry"
```

### Task 21: 增加四类专业报告模板

**用户收益：** 竞品、VOC、设计走查和无障碍审查分别得到适合自己的专业报告。

**Files:**
- Create: `schemas/deliverables/competitive-analysis-report.schema.json`
- Create: `schemas/deliverables/voc-diagnosis-report.schema.json`
- Create: `schemas/deliverables/design-audit-report.schema.json`
- Create: `schemas/deliverables/accessibility-audit-report.schema.json`
- Create: `orchestrator/prompts/deliverables/competitive-analysis-report.md`
- Create: `orchestrator/prompts/deliverables/voc-diagnosis-report.md`
- Create: `orchestrator/prompts/deliverables/design-audit-report.md`
- Create: `orchestrator/prompts/deliverables/accessibility-audit-report.md`
- Create: `orchestrator/report-rubrics/competitive-analysis-report.yaml`
- Create: `orchestrator/report-rubrics/voc-diagnosis-report.yaml`
- Create: `orchestrator/report-rubrics/design-audit-report.yaml`
- Create: `orchestrator/report-rubrics/accessibility-audit-report.yaml`
- Create: `orchestrator/report-templates/competitive-analysis-report.yaml`
- Create: `orchestrator/report-templates/voc-diagnosis-report.yaml`
- Create: `orchestrator/report-templates/design-audit-report.yaml`
- Create: `orchestrator/report-templates/accessibility-audit-report.yaml`
- Modify: `orchestrator/deliverable-registry.yaml`
- Modify: `orchestrator/evidence-policy.yaml`
- Test: `tests/multi-deliverable-contract.test.ts`

**Interfaces:**
- Produces: 五个 task type 的完整 Active mapping。

- [x] **Step 1: 写契约失败测试**

每种 task type 断言 Registry、Schema、Prompt、Rubric、Template、Evidence Policy 全部存在且能加载。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/multi-deliverable-contract.test.ts`

Expected: FAIL。

- [x] **Step 3: 定义报告必需维度**

- Competitive：样本、维度矩阵、差异、影响、行动建议、截图对比。
- VOC：数据集、主题、频率、情感、代表原话、严重度、优先级。
- Design Audit：页面、问题、原则、严重度、截图标注、整改、复测。
- A11y：平台、POUR 原则、控件、A/B/C、P0–P3、读屏表现、整改、验证。

所有 Schema `additionalProperties=false`，关键数组 `minItems=1`。

- [x] **Step 4: 更新 Registry/Policy**

映射：

```text
user_research_planning → research_plan
competitive_research → competitive_analysis_report
voc_diagnosis → voc_diagnosis_report
design_audit → design_audit_report
a11y_audit → accessibility_audit_report
```

Implementation and verification fact (2026-08-17): Added all four professional payload Schemas, synthesis Prompts, seven-dimension report-review Rubrics, ordered 13-section Report Templates, unique active Registry mappings with explicit exact aliases, and exact task/deliverable Evidence Policies. The existing `research_plan` mapping and Task 20 selection/resource-validation runtime remain unchanged. Main observed the final Task 20 + Task 21 eight-file suite at 202 total / 201 pass / 1 existing provider skip / 0 fail; `pnpm typecheck`, Registry linter, and Knowledge linter all passed. Review and commit remain pending.

- [x] **Step 5: 运行测试和阶段门禁**

Run:

```bash
pnpm exec tsx --test tests/multi-deliverable-contract.test.ts tests/registry-linter.test.ts tests/research-planning-service.test.ts
pnpm quality
```

- [ ] **Step 6: 提交**

精确暂存本 Task 列出的 schema/prompt/rubric/template/registry/policy/test 文件；禁止暂存其他工作树变化。

Commit: `git commit -m "feat: add task-specific research deliverables"`

#### Phase 6 integrated cross-task correction（2026-08-17）

- Evidence Policies for VOC, design audit, and accessibility retain their specialized classes and accept the production collector's `public_source` class.
- Professional contract payloads are projected into deterministic semantic ReportDocument blocks. Competitive payload-listed original and annotation Assets are paired by exact Asset/Manifest/content-hash/Manifest-hash lineage into one payload-captioned image comparison without a duplicate standalone annotation; design comparisons retain exact annotation lineage.
- A server-owned canonicalizer runs after Requirement LLM understanding/clarification and at both requirement-planning entry points; it validates the natural-language list, uses the task type's unique active Registry mapping, and emits one canonical id without adding aliases or weakening the public strict resolver.
- Lease execution discovers the exact same-Task/Plan/Attempt verified visual inventory once before Deliverable synthesis, supplies only exportable ids to the LLM context, validates competitive/design payload references before sealing, and reuses the same verified materials after Review for composition.
- Main observed the final Phase 6 integrated suite at 127 total / 126 passed / 1 existing provider skip / 0 failed. `pnpm typecheck`, Registry linter, and Knowledge linter passed. No commit has been created; this evidence is recorded without a pre-commit GREEN or phase-complete claim.

---

## Phase 7：恢复、并行和 Gold

### Task 22: 执行 Tool Retry Policy

**用户收益：** 短暂网络错误自动恢复；安全和数据错误不会被无意义重试。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/tool-retry-policy.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/tool-retry-policy.test.ts`

**Interfaces:**
- Produces: `invokeWithRetry(input)`。

- [ ] **Step 1: 写失败测试**

覆盖 network、timeout、429、5xx 重试；schema/auth/safety/integrity 不重试；max attempts；每次 Receipt 独立；Lease 丢失立即停止。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/tool-retry-policy.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 Policy**

读取 Manifest `max_attempts/backoff_seconds`；每次 sleep 前后检查 active Lease；attempt 从 1 开始，达到上限返回最后一个结构化失败。

- [ ] **Step 4: 运行测试和提交**

Run: `pnpm exec tsx --test tests/tool-retry-policy.test.ts tests/lease-execution-engine.test.ts`

```bash
git add apps/orchestrator-runtime/src/control/tool-retry-policy.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/tool-retry-policy.test.ts
git commit -m "feat: execute tool retry policies"
```

### Task 23: Checkpoint Resume 和 Retry Lineage

**用户收益：** 重试只从失败步骤继续，已成功的检索、分析和图片资产不会全部重跑。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/checkpoint-resolver.ts`
- Modify: `database/control-plane.ts`
- Modify: `apps/orchestrator-runtime/src/control/task-workflow.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/checkpoint-resume.test.ts`

**Interfaces:**
- Produces: `retry_of`、`ReusableCheckpoint[]`。

- [ ] **Step 1: 写失败测试**

覆盖：复用成功前序、input hash 变化重跑、manifest/schema/config hash 变化重跑、tampered artifact 重跑、下游依赖重跑、retry_of lineage。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/checkpoint-resume.test.ts`

Expected: FAIL。

- [ ] **Step 3: 修改 claimExecution**

Retry command 创建新 Attempt 时写 `retry_of=previousAttemptId`，不再把 retry 仅变回 ready 且丢失 lineage。

- [ ] **Step 4: 实现 Checkpoint Resolver**

仅复用 Plan/Step/Input/Manifest/Schema/Config Hash 全部一致且 Artifact SEALED 的步骤；把 reusable outputs 注入执行上下文，从第一个失效节点开始执行。

- [ ] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/checkpoint-resume.test.ts tests/task-workflow.test.ts tests/lease-execution-engine.test.ts`

```bash
git add apps/orchestrator-runtime/src/control/checkpoint-resolver.ts \
  database/control-plane.ts \
  apps/orchestrator-runtime/src/control/task-workflow.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/checkpoint-resume.test.ts
git commit -m "feat: resume current execution from checkpoints"
```

### Task 24: Execution Recovery 和受控 DAG 并行

**用户收益：** Worker 崩溃后任务不会永远卡住；互不依赖的步骤可以安全并行，缩短报告等待时间。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/execution-recovery-service.ts`
- Create: `apps/orchestrator-runtime/src/control/execution-scheduler.ts`
- Modify: `apps/agent-api/src/control-runtime.ts`
- Modify: `apps/agent-api/src/server.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/execution-recovery.test.ts`
- Test: `tests/execution-scheduler.test.ts`

**Interfaces:**
- Produces: `recover(now)` 和 `schedule(plan, checkpoints)`。

- [ ] **Step 1: 写 Recovery 失败测试**

覆盖 expired lease→paused/worker_lost、staging quarantine、terminal invalidation、active task untouched、重复 recover 幂等。

- [ ] **Step 2: 写 Scheduler 失败测试**

覆盖拓扑顺序、无依赖并行、依赖失败阻断、Core failure 取消未开始下游、同一 Step 只执行一次。

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/execution-recovery.test.ts tests/execution-scheduler.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现 Recovery**

Server ready 前执行一次；随后使用单个进程内 timer 周期执行。Shutdown 时清理 timer；不创建外部服务。

- [ ] **Step 5: 实现 Scheduler**

每个 wave 只运行 depends_on 全部成功的步骤；使用 `Promise.allSettled`，但 Artifact seal、execution step 状态和 Lease 检查仍逐步独立。

- [ ] **Step 6: 运行测试和提交**

Run: `pnpm exec tsx --test tests/execution-recovery.test.ts tests/execution-scheduler.test.ts tests/lease-execution-engine.test.ts`

```bash
git add apps/orchestrator-runtime/src/control/execution-recovery-service.ts \
  apps/orchestrator-runtime/src/control/execution-scheduler.ts \
  apps/agent-api/src/control-runtime.ts \
  apps/agent-api/src/server.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/execution-recovery.test.ts \
  tests/execution-scheduler.test.ts
git commit -m "feat: recover and schedule current executions"
```

### Task 25: 五类语义 Gold、真实 Smoke 和最终发布门禁

**用户收益：** 系统不仅“测试通过”，还要在五类真实研究任务中持续证明理解、编排和报告质量。

**Files:**
- Create: `tests/fixtures/current-semantic-gold.json`
- Create: `tests/current-semantic-gold.test.ts`
- Modify: `scripts/current-real-smoke.ts`
- Modify: `tests/current-real-smoke.test.ts`
- Modify: `apps/orchestrator-runtime/src/gold/gold-batch-service.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: 25 个语义场景、五类真实 smoke profile、Report Package 评审门禁。

- [ ] **Step 1: 创建 25 个固定场景**

每个 task type 各五个：明确、模糊、缺输入、约束冲突、PII。每个 fixture 声明 expected task type、required clarification keys、required question themes、forbidden capabilities、required report sections。

- [ ] **Step 2: 写离线语义测试**

测试固定 planner/provider fixture 是否满足：需求字段、澄清、问题覆盖、能力约束、报告章节和 Evidence 引用。测试不通过源文本匹配实现细节，而验证公开契约和业务不变量。

- [ ] **Step 3: 扩展真实 Smoke**

Smoke receipt 增加：Requirement Version、Problem Graph counts、Capability Decisions、Report Review verdict、Chart/Visual counts、Report Package IDs；继续禁止输出 Secret/Base64/Prompt。

- [ ] **Step 4: 恢复 Current Gold**

Gold 只计入：真实 Gateway、实际模型 pin 匹配、真实 Core Tool、Report Review pass、完整 Report Package、独立认证评审。Infra failure 不占能力名额。

- [ ] **Step 5: 运行完整本地门禁**

Run:

```bash
pnpm quality
pnpm --dir apps/web build
```

Expected: 全部非真实 Provider 测试通过；真实测试仅在缺凭证时明确 skip。

- [ ] **Step 6: 运行真实门禁**

使用命令级安全注入：

```bash
ALLOW_REAL_PROVIDER=1 \
LLM_PROVIDER=gateway \
TOOL_ADAPTER=real \
CURRENT_SMOKE_PROFILE=competitive_analysis_report \
pnpm smoke:current:real
```

依次运行五个 profile；每个必须产生真实 Report Package 和无秘密 Receipt。

- [ ] **Step 7: 浏览器终验**

对五类任务各打开一份报告，验证章节、图表、Screenshot、Evidence、Print 和 Bundle；记录任务 ID 和 Report Package Artifact IDs。

- [ ] **Step 8: 最终提交**

```bash
git add tests/fixtures/current-semantic-gold.json \
  tests/current-semantic-gold.test.ts \
  scripts/current-real-smoke.ts \
  tests/current-real-smoke.test.ts \
  apps/orchestrator-runtime/src/gold/gold-batch-service.ts \
  .env.example \
  .github/workflows/ci.yml
git commit -m "test: gate trusted multimodal research reports"
```

---

## Final Completion Ledger

实施完成后必须逐项确认：

- [ ] Legacy mutation 仍全部 410，Legacy GET 可读。
- [ ] Current Planning 对五种 task type 都有有效 Evidence/Deliverable mapping。
- [ ] 澄清答案和 assumption edits 形成新的 Requirement Version。
- [ ] 每个 Success Criterion 有 Question 覆盖。
- [ ] 每个 Required Question 有 Step、Evidence 和 Summary。
- [ ] Capability Resolver 记录 selected/rejected reasons。
- [ ] Skill required Tool、input/output 和 provenance 可验证。
- [ ] Step Artifact 全部 lease-fenced。
- [ ] Skill/LLM/Reviewer 正文进入 synthesis。
- [ ] 报告完成 Draft → Review → 最多一次 Revision。
- [ ] Fact Evidence 覆盖率 100%。
- [ ] Chart 数值 Evidence 覆盖率 100%。
- [ ] Screenshot/Chart/Heatmap 绑定 SEALED Visual Asset。
- [ ] Web、Print PDF、Markdown Bundle 和 JSON 可用。
- [ ] Retry 复用有效 Checkpoint，并有 retry_of lineage。
- [ ] Worker crash 和 STAGING Artifact 能自动恢复。
- [ ] `pnpm quality` 通过。
- [ ] `pnpm --dir apps/web build` 通过。
- [ ] 五类真实 Smoke 通过，或明确记录缺少的外部凭证/服务。
- [ ] 工作树只包含预期变更；所有提交均精确暂存。

## Execution Handoff

推荐使用 Subagent-Driven Development，按 Phase 顺序执行；同一 Phase 内只有明确无依赖的 Task 才并行。每个 Task 完成后只做自检和定向测试；Migration、auth、lease、Artifact、Evidence、安全下载等高风险 Task 增加 targeted review。每个 Phase 结束统一做一次 Spec Review + Code Quality/Security Review，最终分支只做一次 whole-scope review。

当前文档只定义计划，不授权执行、提交业务代码、运行数据库迁移或调用真实 Provider。
