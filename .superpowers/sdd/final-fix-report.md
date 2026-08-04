# Final Fix Report

## 修改文件

- `evaluations/skills/report-writer.ts`：失败状态清理 `output.json`、`output.md`、`scorecard.json`；非失败状态清理旧 `error.json`，保证报告产物互斥。
- `evaluations/skills/run.ts`：增加安全单段 `runId` 校验；resume 完整 pair 必须具备非空数字 `total_score`、恰好六个固定维度、固定 max/合法 score、每维非空 evidence、总分等于六维 score 之和，并且 persisted verdict 符合 normalize 语义（critical 或总分<60 为 fail；否则总分<80 或 incoming needs_review 为 needs_review；否则 pass）；failed/needs_review prior 仍禁止 skip，无 prior 的合法 pair 可 skip；fallback、总分不一致及 verdict 不一致 pair 均重跑；`.active.lock` 写入 PID，活动 PID resume 拒绝，死 PID/损坏锁回收后原子重试，锁在 `finally` 释放。
- `evaluations/skills/scorecard.schema.json`：dimension `evidence.minItems = 1`。
- `evaluations/skills/evaluator.ts`：normalize 阶段拒绝空 evidence，降级为 `needs_review`/空总分 fallback。
- `evaluations/skills/case-loader.ts`：缺失 `casesDir` 按空 case 集处理并稳定报告 `missing cases: ...`。
- `tests/skill-evaluation-runner.test.ts`：覆盖 artifact 互斥、prior 状态门禁、无 manifest 合法 pair、fallback/总分/三类 verdict 不一致 crash-window、合法高分 needs_review、runId traversal、PID 锁 stale/malformed 回收。
- `tests/skill-evaluator.test.ts`：空 evidence 行为与 schema 拒绝回归。
- `tests/skill-evaluation-case-loader.test.ts`：缺失目录错误稳定性回归。

## 测试命令与原始摘要

```text
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts
```

```text
1..42
# tests 45
# pass 45
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

```text
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts
```

```text
1..18
# tests 18
# pass 18
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

三文件联合最新摘要：`# tests 63`, `# pass 63`, `# fail 0`。

## 提交号

- 基础修复：`4b7d7e5`
- pair skip/PID stale lock：`5c7bf32`
- strict scorecard/malformed PID：`3c63b8f`
- total-score consistency：`75768d6`
- verdict consistency：`81a4926`
- 报告更新链：`b7d41a1`、`c76cede`；本次报告随最终报告提交更新。

## 剩余风险

- 强制终止进程时依赖 PID 存活检测回收锁；极端 PID 复用场景仍可能暂时误判活动运行。
- `runId` 拒绝空、`.`、`..`、`/`、`\\`、NUL，但未限制普通单段名称的字符集合。
- 按任务约束未运行项目全量测试、formatter 或 linter。
