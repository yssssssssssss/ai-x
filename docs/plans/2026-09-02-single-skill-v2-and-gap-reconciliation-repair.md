# Single Skill Plan v2 与 Smoke Gap 对账修复方案

> 状态：Phase A 已完成并验证；Phase B 尚未开始
> 日期：2026-09-02
> 基线：`main@4a7a754`
> 关联提交：`6a1fe85 feat: integrate dual orchestration and report set`
> 适用范围：新建 `single_skill`／`multi_skill` Current Task、官方 `smoke:current:real`

## 1. 决策摘要

本修复解决两个相互独立、但被同一轮真实验收同时暴露的问题：

1. `current-real-smoke` 的历史 Gap 重建没有统计 degraded Skill，导致真实任务已完成且报告已封存后，Smoke 误报 `historical gapCount does not match the execution receipt`。
2. `single_skill` 选择 `legacy_single_call` Skill 时没有形成 CurrentExecutionPlan v2 和 Skill Invocation，违反 ADR-0009／ADR-0010 以及根 `CONTEXT.md` 中已经冻结的模式合同。

采用两个可独立合并的阶段：

```text
Phase A：Smoke Gap 对账
Phase B：Legacy Single Skill Plan v2
```

Phase A 不依赖 Phase B。Phase A 合并后即可消除当前两个真实任务的 Smoke 误报；Phase B 再统一所有新建 `single_skill` Task 的 Plan v2 身份。

## 2. 当前证据

### 2.1 当前代码版本

右侧 Herdr Pane 运行于：

```text
Repository：/Users/heyunshen/work/PROJECT/jdc/ai-x
Branch：main
HEAD：4a7a754518a68e095351fda8ce5538493318ea61
```

因此本问题不是旧 worktree 或旧版本造成的。双编排和双报告实现已经通过 `6a1fe85` 合入当前 `main`。

### 2.2 真实单 Skill

```text
Task：4f899fbf-3014-40a5-9a47-7d5b8e458b24
Attempt：7e5a56e7-4c05-4154-a2c8-d99056707f6b
Mode：single_skill
Task State：completed_with_gaps
Execution Receipt gapCount：1
Plan capability gap：0
Tool gapSummary：0
```

唯一执行 Gap：

```text
Step 2
actor：competitive-web-research
state：succeeded
skillProvenance.status：degraded
limitations：5
```

Plan 状态：

```text
execution_contract_version：缺失
skill_invocations：缺失
```

### 2.3 真实多 Skill

```text
Task：8d13da39-922c-4857-89d0-67e9d5145ff0
Attempt：cac2aeb8-c17f-47f8-b7d7-a8dfe9e7bae3
Mode：multi_skill
Task State：completed_with_gaps
Execution Receipt gapCount：2
Plan：current-execution-plan-v3
Plan capability gap：0
Tool gapSummary：0
```

两个执行 Gap：

```text
Step 7  competitive-web-research      degraded
Step 17 research-strategy-synthesis   degraded
```

### 2.4 共同失败

两条真实 Smoke 均在任务和报告完成后退出：

```text
historical gapCount does not match the execution receipt
```

实际差异：

| Task | Receipt | Smoke 重建 |
|---|---:|---:|
| 单 Skill | 1 | 0 |
| 多 Skill | 2 | 0 |

## 3. 根因

### 3.1 Gap 统计口径漂移

`LeaseExecutionEngine` 会把 degraded Skill 计入 Gap：

```text
apps/orchestrator-runtime/src/control/lease-execution-engine.ts:2151-2156
apps/orchestrator-runtime/src/control/lease-execution-engine.ts:2515-2520
```

稳定 Key：

```text
step:<stepNo>:skill:<actorId>:degraded
```

但 Smoke 的历史投影只读取：

```text
plan.capability_gaps
step.toolProvenance.gapSummary
skipped Tool fallback
```

对应位置：

```text
scripts/current-real-smoke.ts:114-122
scripts/current-real-smoke.ts:641-679
scripts/current-real-smoke.ts:827
scripts/current-real-smoke.ts:848-850
```

`SmokeEvidenceStep` 甚至没有声明 `skillProvenance`，因此重读时必然遗漏 degraded Skill。

该漂移形成于：

```text
2026-08-20：Smoke Gap 重建加入，但只有 Capability／Tool
2026-08-23：Execution Engine 开始统计 degraded Skill
```

### 3.2 Single Skill 与 Plan v2 的合同冲突

早期 ADR-0003 允许未迁移 Skill 保持：

```text
legacy_single_call
```

后来 ADR-0009／ADR-0010 和 `CONTEXT.md` 决定：

```text
single_skill → CurrentExecutionPlan v2
multi_skill  → CurrentExecutionPlan v3
```

当前实现仍沿用早期行为：

```text
compileSkillSteps()
→ legacy_single_call 返回 invocations=[]

PlanCompiler.compile()
→ 只有 invocations.length > 0 才写 Plan v2
```

因此：

```text
single_skill + compiled Skill → Plan v2
single_skill + legacy Skill   → 未版本化 Plan
```

当前 24 个 active Skill 中只有 5 个为 compiled，19 个仍为 `legacy_single_call`，所以这不是单个 Skill 的孤立问题。

## 4. 目标

### 4.1 Smoke

- Smoke 从历史 Plan 和 Execution Step 重建所有当前可持久化的 Gap。
- degraded Skill 使用与 Engine 完全相同的稳定 Key。
- Task 可以保持 `completed_with_gaps`，但 Smoke 不误报。
- 历史重读前后仍必须 byte／identity 稳定。

### 4.2 Plan v2

- 所有新建 `single_skill` Task 都写：

```text
execution_contract_version = current-execution-plan-v2
skill_invocations.length = 1
```

- Compiled Skill 保留现有完整 Invocation。
- Legacy Skill 使用显式 `legacy_single_call` Invocation。
- 不伪造 Execution Contract、Contract Hash、Knowledge Binding 或 Stage。
- 不改变 Legacy Skill 的实际执行逻辑。
- 不回填历史 Plan。

## 5. 非目标

- 不把 19 个 Legacy Skill 一次性迁移为 compiled。
- 不为 Legacy Skill 自动生成虚假 Execution Contract。
- 不新增数据库表或 Migration。
- 不修改 Canonical、Report Package 或双报告集。
- 不把真实内容缺口从 `completed_with_gaps` 改成 `completed`。
- 不降低 Report Review、Evidence 或 Fidelity 标准。
- 不修改历史 SEALED Plan 或 Artifact。

## 6. 设计规模检查

Smoke 修复只涉及 2 个文件，是局部修复。

Plan v2 修复涉及公共 TypeScript Contract、JSON Schema、Compiler、单 Skill 候选约束、Plan 校验、Execution 读取和测试，预计涉及 9～11 个文件。它属于已确认的任务级模式合同，不是新增平台能力。

本方案采用最小通用改动：

- 扩展现有 v2 Invocation 联合类型。
- 复用 Plan v3 已验证的 `legacy_single_call` 表达方式。
- 不新增模式注册表、迁移框架或 Skill 批量转换器。

## 7. Phase A：Smoke Gap 对账

### 7.1 数据源

Smoke 只读取已经持久化且可验证的：

```text
Frozen Plan
Execution Steps
Tool Provenance
Skill Provenance
Delivered Report Package
```

不读取未封存 Step 输出，不重新运行 Skill，不重新推断 Gap。

### 7.2 `SmokeEvidenceStep`

增加：

```ts
skillProvenance?: Record<string, unknown> | null;
```

现有 `repository.listExecutionSteps()` 已返回该字段，不需要数据库变化。

### 7.3 `gapKeys()`

在现有 Capability／Tool 逻辑外增加两种已持久化 Gap。

#### Skill Resource Gap

从：

```text
plan.skill_invocations[].resource_gaps[]
```

重建：

```text
skill:<invocationId>:resource:<queryId>
```

只接受：

```text
failure_policy = gap
query_id 非空
invocation_id 非空
```

#### degraded Skill Gap

当：

```text
step.actorType = skill
step.state = succeeded
step.skillProvenance.status = degraded
```

重建：

```text
step:<stepNo>:skill:<actorId>:degraded
```

这必须覆盖：

- 正常 Skill 执行。
- 复用 Skill Checkpoint。
- compiled Skill。
- legacy_single_call Skill。

Smoke 不重新解析 Skill Output 正文；`skillProvenance.status` 是持久化后的可信状态。

### 7.4 保留现有 Tool 校验

继续保留：

- `gapSummary` 字段 allowlist。
- Key 格式。
- `failuresHash` 与 Tool Artifact 真实失败源对账。
- skipped Tool fallback。

### 7.5 同类 Gap 审计

实现前逐项核对 `LeaseExecutionEngine` 的所有 `addGap()` 调用。

本阶段必须记录每类 Gap 的历史来源：

| Engine Gap | 历史重建来源 | 本阶段 |
|---|---|---|
| Capability Gap | Plan `capability_gaps` | 已有，保留 |
| Skill Resource Gap | Plan `skill_invocations.resource_gaps` | 补齐 |
| degraded Skill | Step `skillProvenance.status` | 补齐 |
| Tool Page／Step Gap | Step `toolProvenance.gapSummary` | 已有，保留 |
| skipped Legacy Tool | Step state／failure | 已有，保留 |
| Optional Invocation Failure | Step failure／Invocation policy | 加入定向测试，确认现有映射是否等价 |
| Chart／Showcase 系统 Gap | Report Package／Notice | 不在本次两个失败的修复路径；若无法从现有历史产物无损重建，单独列为后续问题，不新增 Gap Ledger |

最后一项不能为了“全量通用”临时增加数据库或新 Artifact。

### 7.6 Phase A 实施结果

已按 Red／Green 完成：

```text
Red：degraded Skill Fixture 预期 1、实际 0
Green：current-real-smoke.test.ts 38 passed、5 skipped、0 failed
```

现有真实 Attempt 只读核对：

```text
single task 4f899fbf-3014-40a5-9a47-7d5b8e458b24
Receipt Gap：1
重建 Gap：1

multi task 8d13da39-922c-4857-89d0-67e9d5145ff0
Receipt Gap：2
重建 Gap：2
```

Phase A 全量门禁：

```text
Tests：2269
Passed：2254
Skipped：15
Failed：0
Typecheck：pass
Registry lint：pass
Knowledge lint：pass
git diff --check：pass
```

## 8. Phase A 测试

测试文件：

```text
tests/current-real-smoke.test.ts
```

按 Red／Green 顺序新增：

1. 一个 succeeded + degraded Skill，预期 Gap Count 为 1。
2. 两个 succeeded + degraded Skill，预期 Gap Count 为 2。
3. succeeded Skill 且 status=succeeded，不增加 Gap。
4. degraded Skill + Tool `gapSummary`，两者同时保留。
5. 同一稳定 Key 重复出现，只计算一次。
6. compiled Skill 与 legacy Skill 使用相同 degraded Key 规则。
7. 复用 Checkpoint 的 degraded Skill 仍能由历史 `skillProvenance` 重建。
8. `skillProvenance.status` 未知时 fail closed，不静默计数。
9. 初次读取与历史重读的 Gap 集合一致。
10. Receipt Gap 与重建 Gap 不一致时仍然拒绝。

Phase A 完成后无需真实模型即可对两个现有 Attempt 做只读数据核对：

```text
single：1 = 1
multi：2 = 2
```

## 9. Phase B：Legacy Single Skill Plan v2

### 9.1 选择的合同

将现有 v2 Invocation 改为判别联合：

```ts
interface CurrentCompiledSkillInvocationV2 {
  invocation_id: string;
  skill_id: string;
  execution_mode: 'compiled';
  contract_version: 'skill-execution-contract-v1';
  contract_hash: string;
  degraded_policy: 'block' | 'gap';
  skill_reference_hashes: Array<{ path: string; hash: string }>;
  knowledge_references: CurrentKnowledgeReference[];
  resource_gaps: CurrentSkillResourceGap[];
  step_nos: number[];
}

interface CurrentLegacySkillInvocationV2 {
  invocation_id: string;
  skill_id: string;
  execution_mode: 'legacy_single_call';
  step_nos: number[];
}

type CurrentSkillInvocation =
  | CurrentCompiledSkillInvocationV2
  | CurrentLegacySkillInvocationV2;
```

Legacy Invocation 不包含：

```text
contract_version
contract_hash
degraded_policy
skill_reference_hashes
knowledge_references
resource_gaps
```

Legacy 输出的 degraded 行为继续使用当前 Runtime 默认：

```text
degraded → gap
```

### 9.2 为什么不迁移 19 个 Skill

一次性为 19 个 Legacy Skill 编写 Execution Contract 会：

- 把本次合同修复扩大成 Skill 平台迁移。
- 改变每个 Skill 的步骤拓扑和用户确认内容。
- 引入大量独立领域验收。
- 延迟当前 Smoke 和模式合同修复。

因此不采用。

### 9.3 为什么不写空 Invocation

以下形式无效：

```json
{
  "execution_contract_version": "current-execution-plan-v2",
  "skill_invocations": []
}
```

它无法表达实际运行的 Skill，也违反现有 `assertCompiledSkillPlan()` 对非空 Invocation 的要求。

### 9.4 Compiler 行为

`compileSkillSteps()` 对每个 active Skill Step 都生成 Invocation。

#### Compiled Skill

保持现有行为：

- 展开 Contract Stage。
- 写 `skill_invocation_id` 和 `skill_stage_id`。
- 冻结 Contract、Reference、Knowledge 和 Resource Gap。

#### Legacy Skill

新增行为：

- 保留原 Skill Step，不展开阶段。
- 为该 Step 写稳定 `skill_invocation_id`。
- 不写 `skill_stage_id`。
- 创建一个 `legacy_single_call` Invocation。
- `step_nos` 只包含该 Legacy Skill Step。

`PlanCompiler.compile()` 因 Invocation 非空，统一写：

```text
execution_contract_version = current-execution-plan-v2
skill_invocations = [exactly one]
```

### 9.5 Single Skill Owner 数量

`compileSkillSteps()` 必须为候选中的每个 Skill Step 形成 compiled 或 legacy Invocation，不能为了维持数量为 1 而隐藏辅助 Legacy Skill。

编译完成后，在 `single_skill` 的持久化可信边界检查：

```text
skill_invocations.length === 1
```

如果候选中存在两个或更多 Skill Invocation：

- 不选择“最后一个 Skill”作为隐式 Owner。
- 不把其他 Skill 降级成无 Invocation 的黑盒步骤。
- 不自动切换到 `multi_skill`。
- 以受控 Planning Contract 错误拒绝该候选。

Single Skill Planner 必须重新生成只包含一个 Skill Invocation 的候选；额外工作只能由该 Skill 的 compiled stages 或 Tool／Knowledge／LLM／Reviewer Step 承担。需要多个独立专业 Skill 时，用户必须选择 `multi_skill`。

这也修正当前潜在问题：某些历史 `single_skill` Plan 中同时出现 compiled 主 Skill 和 legacy 辅助 Skill，但 `skill_invocations` 只记录 compiled Skill。历史 Plan 不回填；新 Plan 不再允许这种不完整所有权。

### 9.6 Plan 校验

保留现有函数入口，内部按 `execution_mode` 分支。

#### Compiled

继续执行当前全部检查：

- Contract Hash。
- Reference Hash。
- Knowledge Query Membership。
- Stage 集合。
- Dependency。
- Input Binding。
- Actor。
- Output。

#### Legacy

检查：

- 当前 Registry 中 Skill 为 active。
- `loadSkillExecution(skill_id) === null`。
- Invocation 只拥有一个 Skill Step。
- Step `actor_id` 与 `skill_id` 一致。
- Step 有 `skill_invocation_id`。
- Step 不得有 `skill_stage_id`。
- Invocation 不得包含 compiled-only 字段。

### 9.7 Execution Engine

当前 Engine 已识别：

```text
execution_mode = legacy_single_call
```

并保持旧单步执行，不需要新增执行分支。

本阶段只增加回归测试，确认：

- Legacy v2 Invocation 能通过 Plan 读取。
- 不进入 `frozenSkillExecutions`。
- Skill 仍执行一次。
- degraded 默认转为 Gap。
- Retry／Resume 不改变 Invocation ID 和 Step 绑定。

若测试证明 Engine 仍有 compiled-only 假设，只在对应分支做最小修正。

## 10. Phase B 测试

### 10.1 Contract／Schema

```text
compiled Invocation → 通过
legacy Invocation → 通过
空 skill_invocations → 拒绝
legacy 带 contract_hash → 拒绝
compiled 缺 contract_hash → 拒绝
未知 execution_mode → 拒绝
```

### 10.2 Compiler

```text
single_skill + research-strategy-synthesis
→ Plan v2
→ 1 compiled Invocation

single_skill + competitive-web-research
→ Plan v2
→ 1 legacy_single_call Invocation

single_skill + $competitive-web-research
→ Plan v2
→ 1 legacy_single_call Invocation

无 Skill Step
→ 不伪造 Skill Invocation
```

最后一项仅保护异常／非 Skill 计划；正式 `single_skill` Planner 必须选择一个 Skill，否则在持久化边界拒绝。

### 10.3 Single Skill Owner 数量

```text
一个 compiled Skill → 1 个 Invocation
一个 legacy Skill → 1 个 Invocation
compiled + legacy 两个 Skill Step → single_skill 持久化拒绝
两个 legacy Skill Step → single_skill 持久化拒绝
同样的多个 Skill 在 multi_skill → 继续由 Plan v3 表达
```

### 10.4 Engine

```text
legacy Invocation 正常执行
legacy degraded → gap
compiled Invocation 行为不变
v3 compiled／legacy 行为不变
Plan／Invocation／Step ID 漂移 → fail closed
```

### 10.5 Mode 分派

```text
single_skill → v2 + exactly one Invocation
multi_skill → v3
multi_skill + $skill-id → 422
模式冻结、Retry、Resume、Revision 不变
```

## 11. 涉及文件

### Phase A

```text
scripts/current-real-smoke.ts
tests/current-real-smoke.test.ts
```

### Phase B

```text
packages/api-contract/research-deliverable.ts
schemas/current-execution-plan.schema.json
apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts
apps/orchestrator-runtime/src/planners/plan-compiler.ts
apps/orchestrator-runtime/src/planners/routed-planner.ts
apps/orchestrator-runtime/src/control/control-planning-service.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
tests/contributor-skill-execution-contract.test.ts
tests/plan-compiler.test.ts
tests/lease-execution-engine.test.ts
tests/control-planning.test.ts
```

### 决策文档

实施 Phase B 时新增：

```text
docs/adr/0011-support-legacy-invocations-in-single-skill-plan-v2.md
```

该 ADR 只澄清：

- 新建 `single_skill` 一律写 Plan v2。
- v2 Invocation 可以是 `compiled` 或 `legacy_single_call`。
- ADR-0003 的历史未版本化 Plan 继续只读，不回填。
- ADR-0009／0010 的 Task 模式合同保持有效。

## 12. 不采用的方案

### 12.1 只删除 Receipt Gap 比较

拒绝。这样会隐藏历史重读与执行事实不一致，降低 Smoke 价值。

### 12.2 将 degraded Skill 当作 succeeded

拒绝。内容缺口是真实状态，必须保留 `completed_with_gaps`。

### 12.3 给 Plan v2 写空 Invocation

拒绝。无法表达真实 Skill，也会让 v2 名义化。

### 12.4 为 Legacy Skill 伪造 compiled Contract

拒绝。会产生不存在的 Contract Hash、Stage 和 Knowledge 绑定。

### 12.5 一次性迁移全部 Legacy Skill

本轮拒绝。规模过大，并会把合同修复扩大成 19 个 Skill 的独立业务迁移。

### 12.6 修改 ADR，允许 Single Skill 继续写旧计划

默认拒绝。这会推翻已经确认的 `single_skill → Plan v2` 产品合同。只有用户明确改变该决策时才考虑。

## 13. 实施顺序

### Phase A：Smoke 修复

1. 为 degraded Skill 写失败测试。
2. 确认当前测试 Red，错误为 Receipt 与历史 Gap 不一致。
3. 扩展 `SmokeEvidenceStep`。
4. 补 Skill Resource Gap 和 degraded Skill Key。
5. 运行 `tests/current-real-smoke.test.ts`。
6. 用现有数据库记录只读核对 1／2 Gap。
7. 独立提交 Phase A。

### Phase B：Plan v2

1. 为 Legacy Invocation Schema 写失败测试。
2. 为 `competitive-web-research` 编译结果写失败测试。
3. 扩展 v2 TypeScript Contract 和 JSON Schema。
4. 修改 `compileSkillSteps()` 输出 Legacy Invocation。
5. 在 `single_skill` 持久化边界拒绝 Invocation 数量不为 1 的候选。
6. 调整 Single Skill Planner，确保候选只包含一个 Skill Invocation。
7. 修改 v2 Plan 校验分支。
8. 验证 Engine 对 Legacy Invocation 保持单步执行。
9. 验证 `$skill-id` 路径。
10. 更新 ADR。
11. 独立提交 Phase B。

### Phase C：真实重跑

1. 运行完整自动化质量门禁。
2. 启动 Virtual User Lab。
3. 重跑单 Skill Smoke。
4. 重跑多 Skill Smoke。
5. 检查 Task、Plan、Attempt、Gap、Report 和 Summary。
6. 停止 Virtual User Lab。
7. 保存裁剪后的真实验收记录。

## 14. 精确验证命令

### 14.1 自动化

```bash
pnpm exec tsx --test \
  tests/current-real-smoke.test.ts \
  tests/contributor-skill-execution-contract.test.ts \
  tests/plan-compiler.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/control-planning.test.ts

pnpm quality
pnpm --dir apps/web build
git diff --check
```

### 14.2 单 Skill 真实 Smoke

```bash
ALLOW_REAL_PROVIDER=1 \
MULTI_SKILL_PORTFOLIO_WRITER_ENABLED=false \
CURRENT_REQUIRE_BROWSER_EVIDENCE=0 \
CURRENT_REAL_SMOKE_FIXTURE=tests/fixtures/current-semantic-gold.json \
CURRENT_SMOKE_PROFILE=competitive_research \
CURRENT_SMOKE_SCENARIO=competitive-pet-food \
pnpm smoke:current:real
```

预期：

```text
Plan：current-execution-plan-v2
Invocation：1 个 legacy_single_call
Task：completed_with_gaps
Receipt Gap：1
Smoke Gap：1
Smoke Exit：0
```

### 14.3 多 Skill 真实 Smoke

先启动 Virtual User Lab：

```bash
cd external-tools/virtual-user-lab

env \
  SERVER_HOST=127.0.0.1 \
  SERVER_PORT=8804 \
  LLM_GATEWAY_BASE_URL= \
  LLM_GATEWAY_API_KEY= \
  LLM_MODEL_NAME= \
  ./node_modules/.bin/tsx apps/server/src/index.ts
```

然后在项目根运行：

```bash
ALLOW_REAL_PROVIDER=1 \
MULTI_SKILL_PORTFOLIO_WRITER_ENABLED=true \
CURRENT_REQUIRE_BROWSER_EVIDENCE=0 \
CURRENT_REAL_SMOKE_FIXTURE=tests/fixtures/jd-crowdfunding-multi-skill-real-smoke.json \
CURRENT_SMOKE_PROFILE=research_synthesis \
CURRENT_SMOKE_SCENARIO=jd-crowdfunding-multi-skill-answer \
pnpm smoke:current:real
```

预期：

```text
Plan：current-execution-plan-v3
Task：completed_with_gaps
Receipt Gap：与历史 Smoke 重建一致
Contribution／Ledger／Review：SEALED
Smoke Exit：0
```

## 15. 验收标准

### 15.1 Smoke

- 单 Skill Receipt Gap 和历史 Gap 都为 1。
- 多 Skill Receipt Gap 和历史 Gap 都为实际 degraded Skill 数量。
- 初次读取与历史重读完全一致。
- Task 的 `completed_with_gaps` 不被改写。
- 内容 Gap 不被降级为 Warning 或忽略。

### 15.2 Plan v2

- 所有新建 `single_skill` Task 写 v2。
- 所有新建 `single_skill` Task 恰好一个 Invocation。
- 新建 `single_skill` 候选不得含未被 Invocation 所有的 Skill Step。
- Compiled 和 Legacy 使用明确判别字段。
- Legacy 不出现 compiled-only 字段。
- `competitive-web-research` 自动选择和 `$skill-id` 路径都满足 v2。
- `multi_skill` v3 不回归。

### 15.3 回归

- Canonical、Evidence、Review 和 Report Package 不变化。
- 双报告集不变化。
- 历史未版本化 Plan 继续只读。
- 不进行历史回填。
- 不增加跨模式 fallback。
- 全量 Quality 通过。

## 16. 风险与控制

### 风险 1：v2 联合类型影响 compiled-only 属性访问

控制：TypeScript 收窄统一使用 `execution_mode`；禁止通过可选链掩盖错误分支。

### 风险 2：Legacy Invocation 与 Step 绑定不完整

控制：Schema 要求非空唯一 `step_nos`；Plan 校验要求唯一 Skill Step、actor ID 一致且无 `skill_stage_id`。

### 风险 3：Smoke 再次落后于 Engine Gap 类型

控制：本次对所有 `addGap()` 位置做清单审计，并在测试中加入 degraded Skill 和 Skill Resource Gap。当前不可重建的 System Gap 单独记录，不在本次引入新 Ledger。

### 风险 4：真实重跑产生诚实的质量 Gap

控制：允许 `completed_with_gaps`；验收目标是 Receipt 与历史重读一致，不是强制 Gap 为 0。

### 风险 5：真实 Provider 失败

控制：429、网络和 Gateway 5xx 按基础设施失败处理；保留记录后重试，不修改业务合同制造通过。

## 17. 回滚

### Phase A

回滚只恢复 Smoke 统计代码和对应测试，不触碰任务数据。

### Phase B

停止为新 Legacy Single Skill 写 v2 Invocation；已有新 Plan 按已发布 Schema 继续读取。由于本期不修改数据库、不回填历史记录，无数据库回滚。

## 18. 完成定义

- [x] degraded Skill Smoke 测试完成 Red／Green。
- [x] Skill Resource Gap Smoke 测试通过。
- [x] 单 Skill 历史 Gap 由 0 修正为 1。
- [x] 多 Skill 历史 Gap 由 0 修正为 2。
- [ ] Legacy Invocation v2 Schema 通过。
- [ ] `competitive-web-research` 新任务生成 Plan v2。
- [ ] compiled 单 Skill Plan v2 不回归。
- [ ] 多 Skill Plan v3 不回归。
- [ ] 单 Skill 官方真实 Smoke Exit 0。
- [ ] 多 Skill 官方真实 Smoke Exit 0。
- [ ] Task 保留真实 `completed_with_gaps`。
- [ ] 全量 `pnpm quality` 通过。
- [ ] Web Production Build 通过。
- [ ] `git diff --check` 通过。
- [ ] 未经授权未 push 或部署。

## 19. 后续顺序

本修复通过后，恢复原验收计划：

```text
人工代码评审
→ 其余 5 种 Deliverable 真实运行
→ 10 份 corpus 校准
→ 用户视觉确认
→ commit／push／部署
```
