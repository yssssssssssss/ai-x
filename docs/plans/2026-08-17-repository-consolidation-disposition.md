# 仓库整合 Disposition 记录

> 状态：v4 执行中；门禁 0 已通过。
>
> 对应开发文档：`docs/plans/2026-08-17-repository-consolidation-development.md`
>
> 对应 TodoList：`docs/plans/2026-08-17-repository-consolidation-todolist.md`
>
> 规则：本文件是来源处置和验证证据的唯一真相源。TodoList 勾选不能代替本文件。执行期间允许临时状态 `unreviewed`，最终门禁前必须全部替换为 `forward-ported`、`covered-by-main` 或 `archived`。

## 1. 执行元数据

| 字段 | 值 |
|---|---|
| 执行者 | 未填写 |
| 独立复核人 | 未填写 |
| 开始时间 | 未填写 |
| 完成时间 | 未填写 |
| 基线 `main` | `c599e693555f9c60ca5d36e4cffd24644836e616` |
| 首次盘点 `origin/main` | `1ff951cd9dee667601009c3ccf38ef7c39df7158` |
| stash commit | `945ff6c00f7d06a6d32399a9817a09a01b2b6aa2` |
| v4 冻结快照 | `2026-08-17T15:50:16Z` / `2026-08-17T15:51:38Z`，41 tracked、11 untracked、0 staged，Git 状态和 worktree 清单一致 |
| v4 内容指纹 | `2026-08-17T15:52:00Z` / `2026-08-17T15:53:11Z`，binary diff、全部未跟踪文件和所有 worktree status 指纹一致 |
| 门禁 0 结果 | PASS；受管根 Web 预览进程经 `SIGINT` 正常退出且未重启，最终采样无仓库相关进程，4 个非根 worktree clean |
| 持久化备份绝对路径 | `/Users/heyunshen/work/PROJECT/jdc/ai-x-backups/repository-consolidation-20260817` |
| 紧急捕获路径 | `/Users/heyunshen/work/PROJECT/jdc/ai-x-backups/repository-consolidation-20260817/emergency-freeze-20260817T154231Z` |
| 紧急捕获验证 | refs bundle verify 通过；binary patch、11 个未跟踪文件和状态记录 SHA-256 复核通过 |
| bundle SHA-256 | `e87478719348fad3764df2b9f1fbb237e3122050546c8bd87f4b56a8fce0c4ea`（初始 pre-cleanup bundle；rescue commits 后刷新） |
| integration PR | 未填写 |
| integration merge SHA | 未填写 |
| completion receipt PR | 未填写 |

## 2. 结论定义

| 结论 | 定义 | 必备证据 |
|---|---|---|
| `forward-ported` | 行为或合同已按当前架构实现 | 目标 commit、当前文件路径、验证命令和通过结果 |
| `covered-by-main` | 当前 `main` 已有等价或更严格实现 | 当前文件路径、等价说明、验证命令和通过结果 |
| `archived` | 仅有历史价值，不进入生产主线 | archive tag、bundle 引用和不前移理由 |
| `unreviewed` | 尚未完成审查的临时状态 | 最终门禁前必须清零 |

不允许使用 `ignored`，不允许最终结论为空。

### 2.1 根 worktree v4 WIP 冻结清单

| 来源 | 文件数 | 处置 | 目标 | 验证证据 |
|---|---:|---|---|---|
| 三份 repository consolidation 计划文档 | 3 untracked | `preserve-to-rescue` | 独立 docs commit | 紧急捕获 SHA-256 已通过；目标 commit 待填写 |
| Skill Evaluation / KB | 13 tracked | `preserve-to-rescue` | 独立业务 commit | binary patch 已捕获；目标 commit 和定向测试待填写 |
| Control API / Control Plane / Web Flow | 8 tracked | `preserve-to-rescue` | 独立业务 commit | binary patch 已捕获；目标 commit 和定向测试待填写 |
| Real Multimodal Execution Hardening | 20 tracked + 4 untracked | `preserve-to-rescue` | 独立业务 commit | binary patch与四个源码/测试原文件已捕获；目标 commit 和定向测试待填写 |
| `run-inputs/real-ai-shopping-case/*.jpg` | 4 untracked | `preserve-outside-git` | 本地保留并复制到 `$BACKUP_DIR/root-untracked/`，由 `.gitignore` 隔离 | 紧急捕获 SHA-256 已通过；正式备份和最终存在性复核待填写 |

`preserve-to-rescue` 和 `preserve-outside-git` 只用于当前根 WIP 的保全流程，不替代第 3 至 6 节规定的 `forward-ported`、`covered-by-main`、`archived` 历史来源结论。

冻结路径集如下。后续暂存必须使用这些显式路径，不使用目录通配符。

Skill Evaluation / KB（13 tracked）：

```text
evaluations/skills/evaluator.ts
evaluations/skills/kb/compare.ts
evaluations/skills/kb/retriever.ts
evaluations/skills/kb/snapshot.ts
evaluations/skills/kb/types.ts
evaluations/skills/report-writer.ts
evaluations/skills/run.ts
evaluations/skills/types.ts
tests/kb-compare.test.ts
tests/kb-retriever.test.ts
tests/kb-snapshot.test.ts
tests/skill-evaluation-runner.test.ts
tests/skill-evaluator.test.ts
```

Control API / Control Plane / Web Flow（8 tracked）：

```text
apps/agent-api/src/routes/control-tasks.ts
apps/web/src/api/client.ts
apps/web/src/current-flow-state.ts
apps/web/src/hooks/useTaskFlow.ts
apps/web/src/pages/Workbench.tsx
database/control-plane.ts
tests/control-api-integration.test.ts
tests/current-flow-state.test.ts
```

Real Multimodal Execution Hardening（20 tracked + 4 untracked）：

```text
.env.example
apps/agent-api/src/control-runtime.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/orchestrator-runtime/src/control/requirement-refinement-service.ts
apps/orchestrator-runtime/src/planners/routed-planner.ts
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts
apps/orchestrator-runtime/src/runtime/llm-client.ts
apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts
apps/web/src/components/stages/CurrentStage1Clarify.tsx
orchestrator/skill-registry.yaml
tests/capability-resolver.test.ts
tests/control-clarification.test.ts
tests/current-deliverable-service.test.ts
tests/gateway-llm-receipt.test.ts
tests/lease-execution-engine.test.ts
tests/plan-compiler.test.ts
tests/report-review-service.test.ts
tests/requirement-refinement-service.test.ts
apps/orchestrator-runtime/src/report/visual-input-materializer.ts
apps/orchestrator-runtime/src/runtime/llm-input-compactor.ts
tests/llm-input-compactor.test.ts
tests/visual-input-materializer.test.ts
```

本地真实输入（4 untracked，仓库外保全且不提交）：

```text
run-inputs/real-ai-shopping-case/jd-ai-guide..jpg
run-inputs/real-ai-shopping-case/jd-ai-search.jpg
run-inputs/real-ai-shopping-case/jd-taobao-ai-comparison.jpg
run-inputs/real-ai-shopping-case/taobao-ai-guide.jpg
```

## 3. Archive 快照处置

| 来源 | 内容 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|---|
| `archive/cutover-progress-20260817` | Cutover 进度快照 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `archive/local-main-wip-20260817` | `doc/项目汇报材料_M1_20260721.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `archive/local-main-wip-20260817` | `docs/agent-orchestrator-replication-guide.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `archive/local-main-wip-20260817` | `tests/final-release-blockers.test.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |

## 4. M1 独有提交处置

| SHA | 原提交主题 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|---|
| `869ee2c` | Runtime 容错与真实 Tool 通道 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `0f78f85` | 三个真实检索 Tool 和 Registry 接线 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `15e0b79` | 能力自检与端到端真跑脚本 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `302f88e` | M1 真实评估报告与交接文档 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `f6b8ffe` | 旧 `o2-web-search` 清理 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `3b43b48` | User Research domain 预筛和 KB 注入 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `d12f38f` | User Research 端到端与 2C 源检查 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `e1a6c98` | 2C DesignWiki 方案与评估报告 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `5eec19a` | 批量 Skill 端到端验证脚本 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `c11651e` | M1-D+ 六个 Skill 评估报告 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `d99fd6d` | User Research domain 修复与脚本超时 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `73ee4c6` | Gateway 多模型热切换与双协议 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `a02ee42` | Gemini 截断与 parse 错误处理 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `b9aea74` | Planner 编排收敛约束 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `8af75d7` | 旧模型默认值调整 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `d7010c1` | M1 业务盲评招募包 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `55bdf0e` | `selectPlan.assumptions` 类型防御 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `8e49c6b` | 旧 HANDOFF 文档 | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `44a2893` | 编排和 Evidence Reporting 加固 | `unreviewed` | 未填写 | 未填写 | 未填写 |

## 5. Stash tracked 文件处置

来源：`archive/repository-consolidation/m1-stash-20260817` 相对第一父提交的 tracked diff，共 14 个文件。

| 路径 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|
| `apps/agent-api/src/routes/feedback.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/agent-api/src/routes/tasks.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/agent-api/src/server.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/orchestrator-runtime/src/orchestrator.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/orchestrator-runtime/src/runtime/checkpoint-store.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/web/src/api/client.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/web/src/components/Composer.tsx` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `apps/web/src/pages/Workbench.tsx` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `database/repository.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `external-tools/vision-brand-lab/README.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `external-tools/vision-brand-lab/apps/server/package.json` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `package.json` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `scripts/replay-report-v2.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `tests/replay-report-v2.test.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |

## 6. Stash untracked 文件处置

来源：`archive/repository-consolidation/m1-stash-20260817^3` 的完整 tree，共 25 个文件。

| 路径 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|
| `.github/workflows/ci.yml` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `CLAUDE.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `docs/agents/domain.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `docs/agents/issue-tracker.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `docs/agents/triage-labels.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `external-tools/vision-brand-lab/scripts/vision-brand-vlm-failover-smoke.mjs` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/CHANGELOG.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/plan/202607222226_execution-state-hardening/how.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/plan/202607222226_execution-state-hardening/task.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/plan/202607222226_execution-state-hardening/why.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/project.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/api.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/arch.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/data.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/modules/agent-api.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/modules/capability-configuration.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/modules/knowledge-and-reporting.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/modules/orchestration-runtime.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/modules/persistence-and-workspace.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/modules/web.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `helloagents/wiki/overview.md` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `tests/agent-api.integration.test.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `tests/execution-state-machine.test.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `tests/feedback-summary.test.ts` | `unreviewed` | 未填写 | 未填写 | 未填写 |
| `tests/fixtures/required-media-tool-manifest.yaml` | `unreviewed` | 未填写 | 未填写 | 未填写 |

## 7. 验证收据

| 工作包 | Commit/PR | 验证命令 | 结果 | Artifact |
|---|---|---|---|---|
| Docs plan | 未填写 | 未填写 | 未填写 | 未填写 |
| Skill Evaluation / KB WIP | 未填写 | 未填写 | 未填写 | 未填写 |
| Control API / Control Plane / Web Flow WIP | 未填写 | 未填写 | 未填写 | 未填写 |
| Real Multimodal Execution Hardening WIP | 未填写 | 未填写 | 未填写 | 未填写 |
| Local run-input preservation | 未填写 | `shasum -a 256` 与最终存在性检查 | 紧急捕获通过；正式收据待填写 | `$BACKUP_DIR/root-untracked/` |
| Archive test preservation | 未填写 | 未填写 | 未填写 | 未填写 |
| M1 Runtime / Tool | 未填写 | 未填写 | 未填写 | 未填写 |
| M1 Evidence / Report | 未填写 | 未填写 | 未填写 | 未填写 |
| Stash forward-port | 未填写 | 未填写 | 未填写 | 未填写 |
| Offline quality | 未填写 | `pnpm quality` | 未填写 | 未填写 |
| Web build | 未填写 | `pnpm --dir apps/web build` | 未填写 | 未填写 |
| Current real Smoke | 未填写 | 未填写 | 未填写 | 未填写 |
| Integration PR CI | 未填写 | 未填写 | 未填写 | 未填写 |

## 8. 独立复核

复核人不能是原执行者。复核可以由另一名维护者或使用独立上下文的审查 Agent 完成。

- [ ] v4 根 WIP 的 13、8、24 个源码/测试文件分别进入预定 rescue commit，没有跨包夹带。
- [ ] 四个 `run-inputs` 图片未进入 Git history，仓库外副本和本地保留文件 SHA-256 一致。
- [ ] 19 个 M1 提交全部有最终结论。
- [ ] 14 个 stash tracked 文件全部有最终结论。
- [ ] 25 个 stash untracked 文件全部有最终结论。
- [ ] 4 个 archive 条目全部有最终结论。
- [ ] 每个 `forward-ported` 条目都有目标 commit 和通过的测试。
- [ ] 每个 `covered-by-main` 条目都有当前实现位置和等价证据。
- [ ] 每个 `archived` 条目都有 archive tag、bundle 和不前移理由。
- [ ] 第 3 至 6 节的结论单元格不存在 `unreviewed`、空白值或 `ignored`。
- [ ] bundle SHA-256 与持久化备份目录中的文件一致。
- [ ] integration PR diff 与本记录中的目标 commit 一致。

复核结果：未填写。

复核人：未填写。

复核时间：未填写。

复核对应 integration commit：未填写。

## 9. 完成记录

| 字段 | 值 |
|---|---|
| integration merge SHA | 未填写 |
| completion receipt PR | 未填写 |
| archive tags 推送结果 | 未填写 |
| pre-cleanup bundle SHA-256 | 未填写 |
| integration 远程分支删除结果 | 未填写 |
| 本地 worktree 清理结果 | 未填写 |
| 本地分支清理结果 | 未填写 |
| stash 清理结果 | 未填写 |
| pre-cleanup bundle 恢复演练结果 | 未填写 |
| 残余风险 | 未填写 |

最终 completion tag、`main` SHA、final-main bundle SHA-256 和 receipt 分支删除结果记录在仓库外的 `final-repository-state.txt`，避免完成记录提交自引用。
