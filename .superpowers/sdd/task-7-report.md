# Task 7 报告：Clarify API、SSE 和 Web 阶段

## 范围修正

原报告将 Task 7 错误限定为 API/Web 文件，遗漏 ready-path 必需的 control-planning、database 与 runtime seams。本次修正纳入 `database/control-plane.ts`、`apps/orchestrator-runtime/src/control/control-planning-service.ts`、`apps/orchestrator-runtime/src/control/requirement-refinement-service.ts` 以及 server/runtime 接口 wiring。

## TDD

- RED：首次运行 `pnpm exec tsx --test tests/control-clarification.test.ts tests/current-flow-state.test.ts` 时，澄清 route 返回 404，且 `buildClarificationSubmission` / `missingBlockingAnswers` 未导出；失败原因对应缺失功能。
- GREEN：新增/通过以下场景：planning `clarification_required` union、SSE conversation 在 clarification result 前、foreign/missing task 统一 404、缺答案保持 clarification 状态、完整 clarify 返回 candidates、拒绝客户端 plan/planHash/structuredTask、同一 idempotency key replay 返回同一响应，以及显式答案/假设编辑过滤和缺答判定。

## 实现

- planning route/client 支持 `clarification_required` 与 current candidates union；保留原有 progress/conversation/result SSE 顺序。
- `/api/control-tasks/:id/clarify` 做 owner 404、输入白名单、显式答案/assumption edits、idempotency replay；server wiring 调用 Task 6 RequirementRefinementService。
- Web 新增 `CurrentStage1Clarify`：展示当前理解、ambiguities、问题 rationale、assumptions；建议值不会自动成为答案；blocking 未答时提交按钮禁用。
- Current flow 增加 `clarifying` 状态与提交动作，澄清成功后回到候选展示。

## 验证

- RED：按 brief 运行，确认缺失 route/helper 的预期失败。
- GREEN：`pnpm exec tsx --test tests/control-clarification.test.ts tests/current-flow-state.test.ts` —— 12 passed / 0 failed。
- TypeScript：`pnpm typecheck` —— passed。
- Web：`pnpm --dir apps/web build` —— passed（Vite production build）。
- Browser：BLOCKED。当前 worktree 没有可用 API/Web 服务；`hub ps` 显示 `current-browser-api` 与 `current-browser-web` 均已退出（exit 143），因此未伪造浏览器证据。可由 Phase gate 启动共享 dev stack 后验收澄清页、回答后 depth/speed candidates 与刷新恢复。

## 根因与修正

- 根因：`apps/agent-api/src/server.ts:92-97` 在 clarification ready 后调用 `controlPlanning.plan()`，该路径通过 `createTaskWithCandidates()` 新建 task，丢失澄清 requirement 版本与原 task 的关联。
- 修正：ready 的 refinement/clarification ports 读取澄清后 task 的当前 `stateVersion`，调用 `ControlPlanningService.planExistingTask()`；该服务复用候选清洗与 evidence policy，数据库在一个事务中锁定原 task、校验双 owner/state/version/结构化 task/task_type，写入严格 depth/speed 两个 canonical plan versions，再 CAS 到 `awaiting_selection`。

## 本次 TDD 验证

- RED：新增 service 回归先失败 `service.planExistingTask is not a function`；新增 database 回归先失败 `persistExistingTaskWithCandidates is not a function`。
- GREEN：`pnpm exec tsx --test --test-concurrency=1 tests/control-clarification.test.ts tests/control-planning-service.test.ts tests/control-planning.test.ts tests/control-plane.test.ts` —— 31 passed / 0 failed。
- Database seam：`control-plane.test.ts` —— 17 passed / 0 failed；成功场景断言原 task ID 不变、版本 1/2 的 `taskId` 均为原 ID、state 为 `awaiting_selection`、stateVersion +1，且 control_tasks 总数不增加；missing/foreign/stale 均 fail closed。
- TypeScript：`pnpm typecheck` —— passed。
- Web：`pnpm --dir apps/web build` —— passed（Vite production build）。

## 文件

`database/control-plane.ts`; `apps/orchestrator-runtime/src/control/control-planning-service.ts`; `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`; `apps/agent-api/src/control-runtime.ts`; `apps/agent-api/src/server.ts`; `tests/control-plane.test.ts`; `tests/control-planning-service.test.ts`; Task7 brief/approved plan/report。

## Commit

已提交：`fix: persist clarification plans on original task`。
## Phase 2 quality follow-up：existing-task repository 方法绑定

- 根因：`ControlPlanningService.planExistingTask()` 将 `this.dependencies.repository.persistExistingTaskWithCandidates` 提取到局部变量后裸调用；真实 `ControlPlaneRepository` 的实现依赖实例 `this.transaction`，因此生产 ready-path 会抛出 `Cannot read properties of undefined (reading 'transaction')`，而对象字面量 mock 未暴露该问题。
- RED：新增 class-backed repository regression 首次运行 `pnpm exec tsx --test --test-concurrency=1 tests/control-planning-service.test.ts`，6 passed / 1 failed；失败为 `Cannot read properties of undefined (reading 'calls')`，栈定位到裸调用。
- GREEN：改为 `this.dependencies.repository.persistExistingTaskWithCandidates(...)` 直接调用；指定套件 `pnpm exec tsx --test --test-concurrency=1 tests/control-planning-service.test.ts tests/control-api-integration.test.ts tests/control-clarification.test.ts` —— 14 passed / 0 failed。
- TypeScript：`pnpm typecheck` —— passed。


## Phase 2 offline Current 集成夹具 follow-up

- RED：在已包含 production repository binding 修复的 `7568396` 上，以提交态旧夹具运行 `pnpm exec tsx --test --test-concurrency=1 --test-name-pattern="production control runtime completes" tests/control-api-integration.test.ts`，目标用例稳定返回 planning `502`（期望 `200`），0 passed / 1 failed / 2 skipped。
- 根因：Task 6 clean cutover 后，离线 Current 集成夹具仍让 `research-task-v2` schema 返回 `{ ok: true }`，且本地 `ConversationAdapter` 仍只有 create/require，缺少 refinement 必需的 owner-scoped `listMessages` 与 `appendMessage`。有效 V2 fixture 补入后，诊断响应依次暴露 `requirement refinement requires conversation append support`；conversation ports 补齐后才到达此前未绑定的 repository transaction 路径。因此根因是 structured LLM response 与 conversation ports 两组夹具同时陈旧，不能将首个失败单独归因于 LLM fixture；它们共同阻断并遮蔽 production binding 路径。
- 夹具修正：为 `research-task-v2` 返回符合契约、无 blocking ambiguity 的 snake_case ResearchTaskV2；以真实测试数据库实现 owner-scoped message history 与 append；planning 失败断言附带响应 body，并断言相同 `originalInput` 只持久化 1 个 control task 和严格 2 个 plan versions，继续保留 execute 与 owner-only deliverable 断言。
- GREEN：目标单例 `pnpm exec tsx --test --test-concurrency=1 --test-name-pattern="production control runtime completes" tests/control-api-integration.test.ts` —— 1 passed / 2 name-filter skipped；指定三文件串行套件 `pnpm exec tsx --test --test-concurrency=1 tests/control-clarification.test.ts tests/control-api-integration.test.ts tests/control-planning-service.test.ts` —— 14 passed / 0 failed；`pnpm typecheck` —— passed。

## Phase 2 clarification integrity follow-up

- 根因：requirement create/activate 曾被拆成两次事务，clarification route 以进程内 `Map` 作为幂等真源；Current response/Web 仍把结构化任务收窄为 legacy，clarification ready path 还会把 requirement JSON 冒充原始输入。中断的 partial edit 同时破坏了 `database/control-plane.ts` 方法边界。
- 语法恢复：完整重建 `createRequirementVersion()` 与 `createAndActivateRequirementVersion()` 两个 sibling methods，保留既有 RED tests 与有效 V2/hydration partial hunks。
- 原子性：`createAndActivateRequirementVersion()` 在单事务 `FOR UPDATE` task lock 下校验 task/conversation 双 owner、`awaiting_clarification` 与 expected state version，再生成下一版本、更新 active FK/`structured_task` 并 CAS `state_version`；wrong-state、stale、foreign actor、conversation owner mismatch 均无 orphan row。
- Durable idempotency：Migration 005 为 `control_commands` 添加 pending/completed、nullable response、reservation token 与 expiry；repository 提供 token-fenced reserve/complete/release/wait 与 expired reclaim。route 删除 replay Map，跨 router 等待/replay，失败释放 pending，DB transaction 不跨 LLM。
- V2/input/hydration：`ResearchPlanningResult.structuredTask` 原样持久化和返回；legacy 只留在 planner/UI 内部投影。clarification planner 与 existing-task planning 都使用持久 task 的 `originalInput`。Current GET 暴露 original input/active structured task，Web refresh 恢复 `clarifying`。
- RED：初始指定 focused suite 44 tests / 42 pass / 2 fail（测试夹具漏 `plannerCalls`、activation RETURNING 漏 `original_input`）；durable reservation integration 7 tests / 3 pass / 4 fail，分别命中重复 LLM、无 DB replay、无 token fence、无 route state gate。
- GREEN：requirement/refinement/planning/hydration 子集 26/26；durable reservation integration 7/7；clarification route 4/4；atomic/V2/Current GET 验收子集 21/21；`pnpm typecheck` 通过。
- Migration compatibility：真实 PostgreSQL 以 legacy `control_commands` completed row 直接执行 005，旧 response 保留并默认 `completed`；随后可插入合法 pending reservation。目标用例 1 pass / 7 name-filter skip。
- Final focused gate：用户指定 7 文件串行命令 —— 51 tests / 51 pass / 0 fail / 0 skip。
- Final TypeScript gate：`pnpm typecheck` —— passed。
- Final Web gate：`pnpm --dir apps/web build` —— passed；Vite 44 modules transformed，production assets emitted。