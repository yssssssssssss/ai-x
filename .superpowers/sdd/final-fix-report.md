# Final Fix Report

## 修改文件

- `evaluations/skills/report-writer.ts`：失败状态清理 `output.json`、`output.md`、`scorecard.json`；非失败状态清理旧 `error.json`，保证报告产物互斥。
- `evaluations/skills/run.ts`：增加安全单段 `runId` 校验；resume 要求 prior manifest record 存在且状态不是 `failed`/`needs_review`；拒绝空 evidence 的旧 scorecard；增加原子 `.active.lock`，活动 resume 拒绝，锁在 `finally` 释放。
- `evaluations/skills/scorecard.schema.json`：dimension `evidence.minItems = 1`。
- `evaluations/skills/evaluator.ts`：normalize 阶段拒绝空 evidence，降级为 `needs_review`/空总分 fallback。
- `evaluations/skills/case-loader.ts`：缺失 `casesDir` 按空 case 集处理并稳定报告 `missing cases: ...`。
- `tests/skill-evaluation-runner.test.ts`：成功→失败→resume 产物互斥回归、failed/needs_review prior gate、runId traversal、活动锁与 stale running resume 回归。
- `tests/skill-evaluator.test.ts`：空 evidence 行为与 schema 拒绝回归。
- `tests/skill-evaluation-case-loader.test.ts`：缺失目录错误稳定性回归。

## 测试命令与原始摘要

指定聚焦命令：

```text
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts
```

原始摘要：

```text
1..37
# tests 40
# pass 40
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

三文件联合验证：`# tests 58`, `# pass 58`, `# fail 0`。

## 提交号

- 修复提交：`4b7d7e5` (`fix skill evaluation resume and evidence guards`)
- 本报告随后单独提交；报告提交号以最终提交为准。

## 剩余风险

- `.active.lock` 依赖进程正常执行 `finally` 释放；进程被强制终止时锁可能残留，需要人工清理后 resume。
- `runId` 校验针对 `/`、`\\`、`.`、`..`、NUL 与空字符串；未额外限制业务允许字符集合，合法单段名称仍可包含空格或其他普通字符。
- 本次仅运行评测 runner/evaluator/case-loader 聚焦测试，未运行项目全量测试或 formatter/linter（按任务约束）。
