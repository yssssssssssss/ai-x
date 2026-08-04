# Final Fix Report

## 修改文件

- `evaluations/skills/report-writer.ts`：失败状态清理 `output.json`、`output.md`、`scorecard.json`；非失败状态清理旧 `error.json`，保证报告产物互斥。
- `evaluations/skills/run.ts`：增加安全单段 `runId` 校验；resume 仅在 prior 状态为 `failed`/`needs_review` 时禁止完整 pair skip，允许无 prior record 的完整 output/scorecard pair 恢复为 skipped；拒绝空 evidence 的旧 scorecard；增加写入 PID 的原子 `.active.lock`，活动 PID resume 拒绝，死 PID/损坏锁回收后重试，锁在 `finally` 释放。
- `evaluations/skills/scorecard.schema.json`：dimension `evidence.minItems = 1`。
- `evaluations/skills/evaluator.ts`：normalize 阶段拒绝空 evidence，降级为 `needs_review`/空总分 fallback。
- `evaluations/skills/case-loader.ts`：缺失 `casesDir` 按空 case 集处理并稳定报告 `missing cases: ...`。
- `tests/skill-evaluation-runner.test.ts`：成功→失败→resume 产物互斥回归、failed/needs_review prior gate、无 manifest record 的完整 pair skip、runId traversal、活动 PID 锁、死 PID stale lock 回收与 stale running resume 回归。
- `tests/skill-evaluator.test.ts`：空 evidence 行为与 schema 拒绝回归。
- `tests/skill-evaluation-case-loader.test.ts`：缺失目录错误稳定性回归。

## 测试命令与原始摘要

指定聚焦命令：

```text
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts
```

最新原始摘要：

```text
1..38
# tests 41
# pass 41
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

三文件联合验证最新摘要：`# tests 59`, `# pass 59`, `# fail 0`。

## 提交号

- 基础修复提交：`4b7d7e5` (`fix skill evaluation resume and evidence guards`)
- 新增 pair skip/PID stale lock 修复提交：`5c7bf32` (`fix stale evaluation locks and complete pair resume`)
- 报告提交：`b7d41a1`（本报告内容随后更新；工作树最终提交包含最新报告）。

## 剩余风险

- `.active.lock` 对强制终止进程采用 PID 存活检测并可回收死锁；极端 PID 复用场景仍可能暂时误判为活动运行。
- `runId` 校验针对 `/`、`\\`、`.`、`..`、NUL 与空字符串；未额外限制业务允许字符集合，合法单段名称仍可包含空格或其他普通字符。
- 本次仅运行评测 runner/evaluator/case-loader 聚焦测试，未运行项目全量测试或 formatter/linter（按任务约束）。
