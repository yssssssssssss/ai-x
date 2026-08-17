### Task 7: Clarify API、SSE 和 Web 阶段

**用户收益：** 用户能看到系统缺什么、为什么要问；提交后候选方案自动更新。

**Files:**
- Modify: `apps/agent-api/src/routes/control-planning.ts`
- Modify: `apps/agent-api/src/routes/control-tasks.ts`
- Modify: `apps/agent-api/src/server.ts`
- Modify: `apps/agent-api/src/control-runtime.ts` (runtime exposure seam; existing `controlPlanning` service)
- Modify: `apps/orchestrator-runtime/src/control/control-planning-service.ts`
- Modify: `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`
- Modify: `database/control-plane.ts`
- Create: `database/migrations/005_clarification_command_reservation.sql`
- Modify: `apps/web/src/api/client.ts`
- Modify: `packages/api-contract/control-workflow.ts`
- Modify: `packages/api-contract/http.ts`
- Create: `apps/web/src/components/stages/CurrentStage1Clarify.tsx`
- Modify: `apps/web/src/hooks/useTaskFlow.ts`
- Modify: `apps/web/src/current-flow-state.ts`
- Modify: `apps/web/src/pages/Workbench.tsx`
- Test: `tests/control-clarification.test.ts`
- Test: `tests/control-planning-service.test.ts`
- Test: `tests/control-plane.test.ts`
- Test: `tests/current-flow-state.test.ts`

**Interfaces:**
- Produces: planning union response 和 `/api/control-tasks/:id/clarify`。
- Produces: `ControlPlaneRepository.persistExistingTaskWithCandidates()`，在单事务中锁定并 CAS 更新原 `awaiting_clarification` task，写入 depth/speed plan versions。
- Produces: `ControlPlanningService.planExistingTask()`，消费 finalized `ResearchPlanningResult`，复用 candidate sanitization/evidence policy，返回原 conversation/task response。
- Consumes: `RequirementRefinementService` ready result 的 finalized planning result；ControlRuntime 通过 `controlPlanning` 暴露该 seam。
- Produces: `ControlPlaneRepository.createAndActivateRequirementVersion()`，在 task lock 与同一事务中校验双 owner、`awaiting_clarification`、state version，创建并激活完整 `ResearchTaskV2`。
- Produces: clarification command 的 durable `reserve/complete/release/wait` 协议；pending reservation 有 token fence 与 expiry/reclaim，LLM 调用不持有数据库事务。
- Produces: Current GET 返回 `originalInput` 与 active `structuredTask`，Web 刷新恢复 `clarifying` 阶段。
- [ ] **Step 1: 写 HTTP 测试**

覆盖：

- plan 返回 `clarification_required`。
- SSE 先发 conversation，再发 clarification result。
- foreign/missing task 统一 404。
- 缺答案保持 awaiting_clarification。
- clarify 成功返回 candidates。
- 重放同一 idempotency key 返回相同结果。
- 同 key/同 hash 跨并发 router 等待并重放；新 router/进程重启后从数据库重放。
- 同 key/不同 hash 冲突；失败 mutation 释放 pending；过期 reservation 可 reclaim 且旧 token 不得完成。
- 非 `awaiting_clarification` 在 route 与 repository locked update 双层拒绝。
- clarification planner 保留原始 task input/direct invoke；完整 `ResearchTaskV2` 持久化并返回。

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

### Task 7 质量 follow-up：绑定 existing-task repository 方法

- [x] 先新增 class-backed repository 回归并确认 RED：裸调用因丢失 `this` 抛出 `Cannot read properties of undefined (reading 'calls')`。
- [x] 以实例直接调用 `persistExistingTaskWithCandidates`，不做额外重构。
- [x] 运行指定 control planning/API/clarification 套件与 `pnpm typecheck`。

---

## Phase 3：问题图和能力编译

