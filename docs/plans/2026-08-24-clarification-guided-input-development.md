# 澄清需求轻量化与预设建议开发文档

> 日期：2026-08-24
>
> 状态：开发完成，验证通过
>
> 对应清单：`docs/plans/2026-08-24-clarification-guided-input-todolist.md`
>
> 预计工作量：2.5-3.5 个工程人日，约 19-25 小时

## 1. 目标

优化 Current 流程的“澄清需求”环节。用户只需回答真正阻塞规划的问题，可以跳过非阻塞问题，也可以通过预设选项或“采用建议”快速完成输入。

本次改动必须保持以下边界：

- 系统建议不会自动成为用户答案。
- 安全、授权、隐私和外部操作问题不能默认同意。
- 历史 `ResearchTaskV2` 继续可读。
- Clarify endpoint、Idempotency-Key 和现有数据库结构不变。
- 用户回答后仍由 Requirement Refinement 判断 blocking ambiguity 是否已经消除。

## 2. 当前行为

当前实现位于：

- `apps/web/src/components/stages/CurrentStage1Clarify.tsx`
- `apps/web/src/current-flow-state.ts`
- `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`
- `apps/agent-api/src/routes/control-tasks.ts`

现状如下：

- 所有 `clarification_questions` 都被前端视为必答。
- 问题输入框默认为空，任意一项为空时提交按钮禁用。
- assumptions 已预填，可编辑项可以直接修改，不要求用户逐项重填。
- ambiguities 只用于展示，question 与 ambiguity 没有稳定引用关系。
- API 接受 `clarificationAnswers` 对象，但没有按当前 structured task 校验必答 key、未知 key 和锁定 assumption。
- 用户提交后，LLM 会重新生成 `ResearchTaskV2`。若仍有 blocking ambiguity，流程继续停留在澄清阶段。
- 多轮澄清复用同一个 React 组件时，上一轮本地输入可能残留。

`missingBlockingAnswers()` 的名称与行为不一致。它当前检查全部问题，而不是只检查 blocking ambiguity 对应的问题。

## 3. 设计结论

### 3.1 必答状态只来自 ambiguity

不新增独立 `required` 字段。`ambiguity.blocking` 继续作为唯一真相源，question 通过 `ambiguity_id` 建立引用。

```ts
export interface ResearchTaskV2ClarificationQuestion {
  key: string;
  question: string;
  rationale: string;
  ambiguity_id?: string;
  suggestion?: string;
  options?: string[];
}
```

字段保持可选，避免破坏历史 `ResearchTaskV2`。

必答判定：

1. `ambiguity_id` 指向 `blocking: true` 的 ambiguity，问题必答。
2. `ambiguity_id` 指向 `blocking: false` 的 ambiguity，问题可选。
3. 历史 question 没有 `ambiguity_id`，按必答处理。
4. `ambiguity_id` 无效或无法解析，按必答处理并记录合同错误，不能错误放行。

### 3.2 suggestion 需要用户显式采用

`suggestion` 只显示建议，不初始化 `answers`，也不自动提交。

用户必须执行以下任一操作后，必答项才算完成：

- 点击“采用建议”。
- 点击一个预设选项。
- 自己输入非空答案。

提交数据继续使用现有 `clarificationAnswers`。当提交值等于 suggestion 时，可以从当前 structured task 和 clarification JSON 反查用户采用了建议，不新增数据库字段。

### 3.3 options 是快捷输入，不替代自定义输入

`options` 规则：

- 只能有 2-4 项。
- 每项必须是去除首尾空白后的非空字符串。
- 同一问题内不能重复。
- 不在数据中加入“其他”选项，界面始终保留自定义输入框。
- suggestion 与某个 option 相同时，界面可以标记“系统建议”，但不能默认选中。

### 3.4 assumptions 保持现有预填行为

可安全推断的信息继续写入 assumptions：

- 页面初始显示当前 assumption 值。
- editable assumption 可以修改。
- 不修改即可提交。
- locked assumption 不允许客户端覆盖。

非阻塞信息优先进入 assumptions 或 non-blocking ambiguity，不能为了展示更多表单而制造澄清问题。

## 4. 安全规则

以下问题不得提供默认 suggestion：

- question key 对应 `blocking_issues`。
- PII、敏感数据和隐私授权。
- 登录态、受限页面或内部系统访问。
- 对外发布。
- 外部写入、删除、交易和不可逆操作。
- 合规确认。

这类问题可以提供中立选项，比如“允许”与“不允许”，但界面不能预选，后端也不能把 suggestion 补成用户答案。

Requirement Refinement 只把 `clarificationAnswers` 中真实存在的值当作用户回答。structured task 内未被采用的 suggestion 不能作为已确认事实。

## 5. 数据与接口合同

### 5.1 ResearchTaskV2

修改：

- `packages/api-contract/plan.ts`
- `schemas/research-task-v2.schema.json`

新增可选字段：

- `ambiguity_id`
- `suggestion`
- `options`

Schema 约束：

- `ambiguity_id`、`suggestion` 为非空字符串。
- `options` 为 2-4 个唯一非空字符串。
- question 继续拒绝额外未知字段。

### 5.2 Clarify 请求

请求体不变：

```ts
{
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
}
```

服务端在调用 LLM 前增加校验：

- answer key 必须属于当前 `clarification_questions`。
- blocking question 必须有非空答案。
- optional question 可以缺失。
- assumption edit key 必须属于 editable assumption。
- locked 或未知 assumption edit 被拒绝。

缺失必答项返回 HTTP 422：

```json
{
  "error": "required clarification answers are missing",
  "unresolved": ["audience", "scope"]
}
```

未知 answer 或 assumption key 返回 HTTP 400。

### 5.3 持久化

不增加 Migration。新字段继续保存在现有 `structured_task_json`，回答继续保存在现有 clarification JSON。

## 6. Runtime 实现

### 6.1 Requirement Prompt

更新 `REQUIREMENT_PROMPT`：

- 可安全推断的信息写入 assumptions。
- 每个新 clarification question 必须引用一个 ambiguity ID。
- blocking ambiguity 必须有对应问题。
- non-blocking ambiguity 可以没有问题。
- suggestion 只能是可安全采用的工作默认值。
- 安全、授权和合规问题不得生成 suggestion。
- 未被用户提交的 suggestion 不能视为已确认输入。

### 6.2 语义归一化

在 Requirement Refinement 内增加一个纯函数，负责：

- 清理空 suggestion。
- 清理、去重并限制 options。
- 删除安全问题的 suggestion。
- 校验 question 引用的 ambiguity。
- 新生成数据出现未知 ambiguity ID 时 fail closed。
- 历史数据缺失新字段时保持兼容。

该函数只处理澄清元数据，不修改用户原始目标、约束、成功标准或 deliverable。

### 6.3 必答校验 helper

在共享合同层提供纯函数，供 Web 和 Agent API 共用：

```ts
isClarificationQuestionRequired(requirement, question)
requiredClarificationQuestionKeys(requirement)
missingRequiredClarificationAnswers(requirement, answers)
```

避免前后端分别实现 blocking 判定。

## 7. Web 交互

### 7.1 问题卡片

每个问题显示：

- 必答或可选标签。
- 问题正文。
- 提问原因。
- suggestion 区域。
- options 快捷按钮。
- 自定义输入框。

suggestion 文案固定为“系统建议，不会自动提交”。点击“采用建议”后才更新本地 answer。

### 7.2 提交条件

提交按钮只统计 blocking question：

- 仍缺必答项：`请完成必答信息（还缺 N 项）`
- 必答项完成：`提交澄清并更新候选方案`
- optional 为空不阻止提交

### 7.3 多轮澄清

当 `response.task.stateVersion` 变化时：

- 清空上一轮 answers。
- 使用新 structured task 重建 assumption edits。
- 不把已消失的问题继续提交。
- 不复用上一轮 suggestion 的选择状态。

### 7.4 可访问性与窄屏

- options 和 suggestion 使用真实 `button`。
- 选中状态使用 `aria-pressed`。
- 必答输入使用 `aria-required`。
- 不只依赖颜色表达必答、可选或已选择。
- 375px 宽度下允许按钮换行，不产生横向滚动。
- 复用现有 `.clarification-field` 深色输入体系。

## 8. 不在本次范围

- 不新增数据库表或 Migration。
- 不新增 endpoint。
- 不改变 Idempotency-Key 和 command reservation。
- 不自动接受 suggestion。
- 不新增分析埋点系统。
- 不运行真实 Gold、Zero、Tavily 或 Playwright 验收。
- 不改候选方案、执行 DAG 和报告生成合同。
- 不为每个小函数增加独立测试轮次。

## 9. 验收标准

- 历史 question 缺少新字段时继续显示，并默认必答。
- blocking question 未回答时，前端禁用提交，API 直接返回 422。
- non-blocking question 未回答时可以提交。
- suggestion 不会自动进入 payload。
- 点击“采用建议”后，答案才进入 payload。
- option 点击后可继续编辑。
- 未知 answer key、未知 assumption key 和 locked assumption edit 被拒绝。
- 敏感、授权和合规问题没有 suggestion。
- 多轮澄清不会保留上一轮本地输入。
- blocking ambiguity 清除后进入候选方案。
- 无数据库迁移，旧任务继续可读。

## 10. 开发顺序

本功能作为一个独立开发批次完成，不为局部函数设置人工 Gate。

1. 更新共享类型、Schema 和 blocking helper。
2. 更新 Requirement Prompt 与澄清元数据归一化。
3. 增加 Agent API 必答项和 assumption 校验。
4. 更新澄清页面、快捷选项、suggestion 和多轮状态重置。
5. 批量补齐受影响测试。
6. 集中运行一次定向测试和构建门禁。
7. 形成单一功能提交，合并前检查 diff。

## 11. 精简验证策略

开发过程中不在每个文件或函数完成后运行测试。代码和测试按完整批次写完后，只运行一次受影响测试：

```bash
pnpm exec tsx --test \
  tests/schema.test.ts \
  tests/requirement-refinement-service.test.ts \
  tests/control-clarification.test.ts \
  tests/current-flow-state.test.ts
```

随后运行：

```bash
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

只做一轮手工界面检查：

- 一个桌面宽度。
- 一个 375px 宽度。
- 必答缺失、可选跳过、采用建议、敏感问题无建议四个状态。

不运行与本功能无关的 Gold、Zero、Playwright、报告和真实 Tool 测试。定向门禁失败后，只重跑失败文件。`pnpm quality` 不作为日常开发步骤，只在后续统一发布门禁或用户明确要求时运行。

## 12. 工作量

| 工作项 | 预计时间 |
|---|---:|
| 共享类型、Schema、blocking helper | 3-4 小时 |
| Prompt、归一化和安全约束 | 4-5 小时 |
| API 校验 | 2-3 小时 |
| Web 交互与多轮状态 | 5-6 小时 |
| 测试与一次集中门禁 | 4-5 小时 |
| 手工界面检查和文档回写 | 1-2 小时 |
| 合计 | 19-25 小时 |

预计 2.5-3.5 个工程人日。

## 13. 实际结果

2026-08-24 已按本文完成实现：

- question 新增可选 `ambiguity_id`、`suggestion` 和 `options`，没有新增重复的 `required` 字段。
- Web 和 Agent API 通过共享 helper 从 `ambiguity.blocking` 推导必答项。
- 历史 question 缺少 `ambiguity_id` 时继续按必答处理。
- suggestion 和 options 只有在用户点击后才进入答案。
- 对应 `blocking_issues`、PII 或 confidential requirement 的 suggestion 会被移除。
- API 在调用 LLM 和创建 command reservation 前拒绝缺失必答项、未知 answer key、未知 assumption key 和 locked assumption edit。
- 多轮澄清按 task stateVersion 清空旧答案并重建 assumptions。
- 未新增 endpoint、环境变量或数据库 Migration。

验证按精简策略执行：

- Schema、Requirement Refinement、Clarify API 和 Current Flow 定向测试最终通过，共覆盖 71 个测试用例。
- TypeScript typecheck 通过。
- Web production build 通过。
- 桌面宽度与 375px 各检查一次，无横向溢出。
- 必答缺失、可选跳过、显式采用建议和敏感问题无默认建议均通过界面检查。
- 未运行无关的 Gold、Zero、Tavily、Playwright、报告链路和全量 `pnpm quality`。

## 14. 风险与降级

最脆弱的假设是 LLM 能稳定把 question 绑定到正确 ambiguity。处理方式：

- 历史或无法解析的 question 一律按必答处理。
- 新生成数据引用未知 ambiguity 时 fail closed。
- 不能因为映射失败把 blocking question 变成 optional。

如果 suggestion 质量不稳定，可以只隐藏 suggestion 和 options，保留 ambiguity 映射与必答逻辑。该降级不需要回滚数据。

## 15. 回滚

本功能不涉及 Migration 和不可逆写入。回滚实现提交后：

- 新字段仍是可选字段，旧代码会忽略。
- clarification answer payload 没有变化。
- 历史 task 不需要迁移。
- 页面恢复为所有 question 必答的旧行为。
