# 澄清需求轻量化与预设建议 TodoList

> 对应开发文档：`docs/plans/2026-08-24-clarification-guided-input-development.md`
>
> 执行方式：作为一个独立开发批次完成。不要在每个函数或文件修改后运行测试，代码与测试写完后统一执行一次定向门禁。
>
> 全量 `pnpm quality` 不属于本清单的日常门禁，只在后续统一发布检查或用户明确要求时运行。

## 已确认基线

- [x] 当前页面只要求 `clarification_questions` 填写，assumptions 已预填。
- [x] 当前 `missingBlockingAnswers()` 实际把所有 question 当作必答。
- [x] 当前 question 与 ambiguity 没有稳定引用关系。
- [x] 当前 suggestion 不会自动进入提交 payload。
- [x] Clarify endpoint、Idempotency-Key 和数据库 JSON 持久化可以继续复用。
- [x] 本功能不需要数据库 Migration、环境变量或新 endpoint。

## 1. 开发准备

- [x] 在独立功能分支或 worktree 开始开发。
- [x] 记录 `BASE_SHA` 和当前 `git status --short --branch -uall`。
- [x] 确认只有一个 writer 修改该 worktree。
- [x] 确认本批次不混入 User Research Hub、Zero、Playwright 或其他 WIP。

## 2. 共享合同

### 2.1 TypeScript 类型

- [x] 更新 `packages/api-contract/plan.ts`。
- [x] 为 `ResearchTaskV2ClarificationQuestion` 增加可选 `ambiguity_id`。
- [x] 增加可选 `suggestion`。
- [x] 增加可选 `options`。
- [x] 不新增重复的 `required` 字段。

### 2.2 JSON Schema

- [x] 更新 `schemas/research-task-v2.schema.json`。
- [x] `ambiguity_id` 只接受非空字符串。
- [x] `suggestion` 只接受非空字符串。
- [x] `options` 限制为 2-4 个唯一非空字符串。
- [x] 保持新字段可选，旧 `ResearchTaskV2` 继续合法。
- [x] 保持 `additionalProperties: false`。

### 2.3 共享判定 helper

- [x] 实现 `isClarificationQuestionRequired(requirement, question)`。
- [x] 实现 `requiredClarificationQuestionKeys(requirement)`。
- [x] 实现 `missingRequiredClarificationAnswers(requirement, answers)`。
- [x] question 缺少 `ambiguity_id` 时默认必答。
- [x] `ambiguity_id` 无效时 fail closed，默认必答。
- [x] blocking 状态只读取 `ambiguity.blocking`。

## 3. Requirement Refinement

- [x] 更新 `REQUIREMENT_PROMPT`。
- [x] 要求新 question 引用 ambiguity ID。
- [x] blocking ambiguity 必须有对应 question。
- [x] non-blocking ambiguity 可以不生成 question。
- [x] 可安全推断的信息继续写入 assumptions。
- [x] 未被用户提交的 suggestion 不得视为已确认事实。
- [x] 安全、授权和合规问题不得生成 suggestion。

### 3.1 元数据归一化

- [x] 清理空 suggestion。
- [x] 清理 options 首尾空白。
- [x] 去除重复 option。
- [x] 拒绝少于 2 项或超过 4 项的 options。
- [x] 校验 question 引用的 ambiguity。
- [x] 删除对应 `blocking_issues` 问题的 suggestion。
- [x] 保持历史 question 兼容。
- [x] 归一化不得修改用户目标、范围、约束、成功标准或 deliverable。

## 4. Agent API 校验

修改 `apps/agent-api/src/routes/control-tasks.ts`：

- [x] 在调用 LLM 和创建 command reservation 前读取当前 structured task。
- [x] 拒绝未知 clarification answer key。
- [x] 拒绝缺失的 blocking question answer。
- [x] 允许缺失 optional answer。
- [x] 拒绝未知 assumption edit key。
- [x] 拒绝修改 locked assumption。
- [x] 缺少必答项返回 HTTP 422。
- [x] 422 响应包含稳定 `unresolved` key 数组。
- [x] 未改变 Idempotency-Key、request hash 和 replay 行为。

## 5. Web 状态逻辑

修改 `apps/web/src/current-flow-state.ts`：

- [x] `missingBlockingAnswers()` 改为使用共享 blocking helper，或删除该重复实现。
- [x] optional question 为空时不进入 missing 列表。
- [x] suggestion 不自动进入 `clarificationAnswers`。
- [x] option 或 suggestion 只有经用户点击后才进入答案。
- [x] `buildClarificationSubmission()` 继续过滤未知 key 和空值。
- [x] assumption edits 只包含 editable 且非空字段。

## 6. 澄清页面

修改 `apps/web/src/components/stages/CurrentStage1Clarify.tsx`：

- [x] 显示“必答”与“可选”标签。
- [x] suggestion 显示“系统建议，不会自动提交”。
- [x] 增加“采用建议”按钮。
- [x] options 使用可换行的快捷按钮。
- [x] 点击 option 后仍允许用户编辑文本。
- [x] 必答输入增加 `aria-required`。
- [x] option 使用 `aria-pressed`。
- [x] 提交按钮只统计缺失的 blocking question。
- [x] optional 为空时允许提交。
- [x] `task.stateVersion` 变化时清空旧 answers。
- [x] `task.stateVersion` 变化时按新 structured task 重建 assumption edits。
- [x] 复用 `.clarification-field` 深色输入样式。
- [x] 在 `apps/web/src/theme.css` 增加必要的标签、建议和 option 样式，不新建第二套颜色体系。

## 7. 测试

测试在生产代码和测试文件全部写完后集中运行，不逐文件运行。

### 7.1 Schema 与共享逻辑

- [x] 历史 question 没有新字段时仍通过 Schema。
- [x] 新字段合法时通过 Schema。
- [x] options 数量、重复、空值和额外字段被拒绝。
- [x] blocking question 被判为必答。
- [x] non-blocking question 被判为可选。
- [x] 缺失或未知 ambiguity ID 默认必答。
- [x] suggestion 不会自动进入 payload。

### 7.2 Requirement Refinement

- [x] 新 question 引用已存在 ambiguity。
- [x] blocking ambiguity 不会缺少 question。
- [x] 安全问题 suggestion 被移除。
- [x] optional question 未回答时仍可进入 ready-to-plan。
- [x] required question 回答不足时继续 clarification。

### 7.3 API

- [x] 缺少必答项返回 422 和 unresolved keys。
- [x] optional 缺失时请求成功。
- [x] 未知 answer key 返回 400。
- [x] 未知或 locked assumption edit 返回 400。
- [x] 相同 Idempotency-Key 保持 replay。
- [x] 同 key 不同 payload 保持 409。

### 7.4 Web

- [x] 点击 suggestion 后才产生答案。
- [x] 点击 option 后产生答案并允许编辑。
- [x] optional 不阻止提交。
- [x] required 缺失时阻止提交。
- [x] 新一轮 stateVersion 清空上一轮本地状态。

## 8. 集中门禁

### 8.1 定向测试

只运行一次：

```bash
pnpm exec tsx --test \
  tests/schema.test.ts \
  tests/requirement-refinement-service.test.ts \
  tests/control-clarification.test.ts \
  tests/current-flow-state.test.ts
```

- [x] 定向测试全部通过。

失败后只修复并重跑直接失败的测试文件，不扩大到全仓库。

### 8.2 静态与构建检查

```bash
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

- [x] TypeScript typecheck 通过。
- [x] Web production build 通过。
- [x] `git diff --check` 通过。

### 8.3 一次手工界面检查

- [x] 桌面宽度检查一次。
- [x] 375px 宽度检查一次。
- [x] 必答缺失状态正确。
- [x] optional 跳过状态正确。
- [x] 采用 suggestion 后状态正确。
- [x] 敏感问题不显示 suggestion。
- [x] 无横向滚动，键盘可操作。

## 9. 明确不运行的验证

- [x] 不运行真实 Gold。
- [x] 不运行真实 LLM Gateway。
- [x] 不运行 Tavily、Playwright 或 Zero 实链路。
- [x] 不运行数据库 Migration 测试，因为没有 Migration。
- [x] 不运行报告、Artifact 或 Execution Engine 测试。
- [x] 不在每个小改动后运行 `pnpm quality`。

`pnpm quality` 只在后续统一发布门禁或用户明确要求时运行。

## 10. 提交与交付

- [x] `git status` 只包含本功能文件。
- [x] 检查 diff 中没有 suggestion 自动写入 answers 的路径。
- [x] 检查安全问题没有默认 suggestion。
- [x] 检查没有新增环境变量、endpoint 或 Migration。
- [x] 更新开发文档中的实际结果和验证结果。
- [x] 形成一个独立功能提交。
- [x] 未经用户授权不 push。

## 完成条件

```text
blocking question 必答
optional question 可跳过
suggestion 需要显式采用
assumptions 保持预填
API 与 Web 使用同一必答判定
历史 ResearchTaskV2 兼容
无 Migration、无新 endpoint
定向测试、typecheck、Web build、diff check 通过
```
