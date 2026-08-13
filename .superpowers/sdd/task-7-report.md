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
