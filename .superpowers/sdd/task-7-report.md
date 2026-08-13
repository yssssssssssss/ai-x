# Task 7 报告：Clarify API、SSE 和 Web 阶段

## 范围

仅修改 Task 7 brief 指定的 API route/server、Web client/state/stage/hook/page 与两份测试；未修改 planner、database 或 control-runtime internals。

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

## 风险/注意

- server adapter 在 ready clarification 后复用现有 Current planning port 生成候选；planner/database 文件保持不变。Phase gate 应使用真实服务验证端到端任务版本与刷新恢复。
