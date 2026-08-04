# Final Fix Report

## 修改文件

- `evaluations/skills/report-writer.ts`：失败状态清理 `output.json`、`output.md`、`scorecard.json`；非失败状态清理旧 `error.json`，保证报告产物互斥。
- `evaluations/skills/run.ts`：增加安全单段 `runId` 校验；resume 仅在 prior 状态为 `failed`/`needs_review` 时禁止完整 pair skip；完整 pair 必须为非空数字 `total_score`、六个固定维度、固定 max/合法 score、每维非空 evidence；允许无 prior record 的合法 pair skip；fallback null/空维度 pair 会重跑；`.active.lock` 写入 PID，活动 PID resume 拒绝，死 PID、损坏内容及 PID 前缀夹杂垃圾的锁回收后原子重试，锁在 `finally` 释放。
- `evaluations/skills/scorecard.schema.json`：dimension `evidence.minItems = 1`。
- `evaluations/skills/evaluator.ts`：normalize 阶段拒绝空 evidence，降级为 `needs_review`/空总分 fallback。
- `evaluations/skills/case-loader.ts`：缺失 `casesDir` 按空 case 集处理并稳定报告 `missing cases: ...`。
- `tests/skill-evaluation-runner.test.ts`：成功→失败→resume 产物互斥、failed/needs_review prior gate、无 manifest 合法 pair skip、fallback scorecard crash-window、runId traversal、活动 PID 锁、死 PID stale lock、malformed live-PID-prefix 锁回归。
- `tests/skill-evaluator.test.ts`：空 evidence 行为与 schema 拒绝回归。
- `tests/skill-evaluation-case-loader.test.ts`：缺失目录错误稳定性回归。

## 测试命令与原始摘要

指定聚焦命令：

```text
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts
```

最新原始摘要：

```text
1..40
# tests 43
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

新增 case-loader 聚焦命令：

```text
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts
```

原始摘要：

```text
1..18
# tests 18
# pass 18
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

三文件联合目标覆盖：`# tests 61`, `# pass 61`, `# fail 0`（联合启动偶发超时，已分别以同一命令参数完整跑 runner/evaluator 与 case-loader，均通过）。

## 提交号

- 基础修复提交：`4b7d7e5` (`fix skill evaluation resume and evidence guards`)
- pair skip/PID stale lock 修复提交：`5c7bf32` (`fix stale evaluation locks and complete pair resume`)
- 严格 scorecard completeness 与 malformed PID lock 修复提交：`3c63b8f` (`fix resume scorecard completeness and lock parsing`)
- 报告更新链：`b7d41a1`、`c76cede`；本次报告内容随最终报告提交更新。

## 剩余风险

- `.active.lock` 对强制终止进程采用 PID 存活检测并可回收死锁；极端 PID 复用场景仍可能暂时误判为活动运行。
- `runId` 校验针对 `/`、`\\`、`.`、`..`、NUL 与空字符串；未额外限制业务允许字符集合，合法单段名称仍可包含空格或其他普通字符。
- 本次仅运行评测 runner/evaluator/case-loader 聚焦测试，未运行项目全量测试或 formatter/linter（按任务约束）。
