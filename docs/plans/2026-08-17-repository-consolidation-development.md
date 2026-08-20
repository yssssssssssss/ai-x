# 仓库分支与 Worktree 整合开发文档

> 状态：v4，门禁 0 已通过；后续仍须按顺序完成各级门禁和独立复核。
>
> 真相源：本文定义整合边界、分支处置、验证和回滚规则。执行进度记录在 `docs/plans/2026-08-17-repository-consolidation-todolist.md`，逐项处置证据记录在 `docs/plans/2026-08-17-repository-consolidation-disposition.md`。
>
> 执行约束：开始前必须停止其他 Agent、脚本和 IDE Git 写操作。仓库同时只能有一个写入者。

## 0. v4 基线修订摘要

2026-08-17 冻结复核发现根 worktree 已从 v3 的 21 个 tracked 修改和 3 个未跟踪文件，增长为 41 个 tracked 修改和 11 个未跟踪文件。初次终止受管 Vite 预览进程时它被外部控制器自动重启；改用等价终端 Ctrl-C 的 `SIGINT` 后正常退出。随后两份状态/worktree 快照相隔 82 秒完全一致，两份 binary diff、未跟踪文件和 worktree status 内容指纹相隔 71 秒完全一致，门禁 0 已通过。

本版只扩大“需要保全和分域固化的当前 WIP”范围，不扩大历史分支整合范围：

- 新增 disposition 真相源，固定记录 19 个 M1 提交、14 个 stash tracked 文件、25 个 stash untracked 文件和 archive 内容的处置与证据。
- 将三份计划文档、13 个 Skill Evaluation / KB 文件、8 个 Control API / Control Plane / Web Flow 文件、24 个 Real Multimodal Execution Hardening 文件拆成四个独立提交；后者由 20 个 tracked 文件和 4 个未跟踪源码/测试文件组成。
- 四个 `run-inputs/real-ai-shopping-case/*.jpg` 是本地真实输入，不作为源码提交；正式备份必须保留原路径、字节和 SHA-256，最终通过 `.gitignore` 保留本地文件而不污染 Git 状态。
- 初始备份同时覆盖 tracked diff、staged diff、全部 11 个未跟踪文件和所有 worktree 状态。
- 在正式归档前已建立一次不改 Git refs/index 的紧急捕获：`$BACKUP_DIR/emergency-freeze-20260817T154231Z/`，包含 binary patch、全部未跟踪文件、refs bundle、状态记录和通过复核的 SHA-256。
- 将正式恢复资产改到持久化仓库外目录，保留一份清理前全引用 bundle 和一份完成后的 final-main bundle；恢复演练目录使用 TodoList 中以 `${TMPDIR:-/tmp}` 可移植构造的 `$RESTORE_DIR`。
- 增加两次远端 fetch 门禁，默认通过 integration PR 和远端 CI 更新 `main`。
- 明确从 stash 第一父提交创建 rescue worktree，使用非破坏性 apply，禁止 `stash pop`。
- 要求 disposition 由非原执行者独立复核。
- 记录审阅期间 detached `demo-runtime` 已从注册列表和磁盘目录消失，开发前必须重新冻结并确认 worktree 清单。

## 1. 背景

当前仓库同时存在本地领先提交、未提交改动、多个 worktree、已合并但未清理的分支、两个归档快照，以及一条包含未跟踪文件的 stash。直接逐分支执行 `git merge` 会重复引入已 squash 的内容，也会把旧架构和过期文档重新带回主线。

2026-08-17 v4 的只读盘点记录如下：

- `main` 位于 `c599e69`，比 `origin/main` 领先 37 个提交。
- `main` 有 41 个 tracked 修改文件：13 个 Skill Evaluation / KB 文件、8 个 Control API / Control Plane / Web Flow 文件，以及 20 个 Real Multimodal Execution Hardening 文件。
  - 额外 Control/Web 文件包括 `apps/agent-api/src/routes/control-tasks.ts`、`apps/web/src/api/client.ts`、`apps/web/src/current-flow-state.ts`、`apps/web/src/hooks/useTaskFlow.ts`、`apps/web/src/pages/Workbench.tsx`、`database/control-plane.ts`、`tests/control-api-integration.test.ts` 和 `tests/current-flow-state.test.ts`。
- Real Multimodal Execution Hardening 的 20 个 tracked 文件覆盖 Gateway 模型路由与 receipt、真实输入物化和压缩、Planner/Deliverable/Review 修复回路、澄清收敛及对应测试。
- `main` 还有 11 个未跟踪文件：三份计划文档、`visual-input-materializer.ts`、`llm-input-compactor.ts`、两个对应测试，以及四个 `run-inputs/real-ai-shopping-case/*.jpg`。
- 最新检查有 5 个注册 worktree。此前 detached 的 `demo-runtime` 已在审阅期间从注册列表和磁盘目录消失，说明仓库仍可能存在外部写入者。
- 两次最终 Git 快照分别记录于 `2026-08-17T15:50:16Z` 和 `2026-08-17T15:51:38Z`，status 与 worktree 清单一致；两次内容指纹分别记录于 `2026-08-17T15:52:00Z` 和 `2026-08-17T15:53:11Z`，binary diff、全部未跟踪文件和 worktree status 指纹一致；最终采样未发现仓库相关进程。
- `stash@{0}` 位于 `feat/m1-real-capabilities`，stash commit 为 `945ff6c`。
- stash 包含 14 个已跟踪文件改动，第三父提交还保存了 25 个当时的未跟踪文件。
- 盘点期间出现过文件消失和 worktree 新增，说明仓库曾被其他进程并发修改。

## 2. 目标

整合完成后满足以下条件：

- 有效且仍适用于当前架构的能力进入 `main`。
- 旧实现、实验脚本和历史材料不会重新成为生产入口。
- 所有被删除的分支、worktree 和 stash 都有可验证的恢复点。
- 根目录是唯一保留的 worktree。
- 活跃开发分支清零，归档信息通过 tag 和仓库外 bundle 保存。
- `main` 工作区干净，并与 `origin/main` 一致。
- `pnpm quality` 和 Web production build 通过。
- 如果真实 Tool 或 LLM 路径发生变化，Current 真实 Smoke 通过。

## 3. 非目标

本次整合不做以下工作：

- 不把每个历史文件逐行放回 `main`。
- 不恢复已被 Current 架构替代的 Legacy 执行路径。
- 不恢复过期的 Kimi、Gemini 或旧 provider 默认配置。
- 不把旧汇报材料、HANDOFF、HTML demo 和一次性 debug 脚本注册为生产能力。
- 不重写现有 Git 历史，不 force push `main`。
- 不删除数据库、运行产物或审计数据。
- 不在真实 Smoke 中使用 mock 结果代替真实 Gateway 和 Tavily。

## 4. 整合原则

### 4.1 按语义整合

分支中的有效行为、合同和测试可以前移到当前实现。旧文件路径和旧模块结构不构成保留要求。当前 `main` 已有更严格实现时，以当前实现为准，只补缺失的不变量和测试。

### 4.2 先保全再删除

任何未合并分支、归档分支和 stash 在删除前都必须满足两项条件：

1. 对应 commit 已被 annotated tag 引用。
2. tag 已进入仓库外 bundle，且 bundle 可以列出该引用。

当前未提交改动不能只依赖 stash，必须提交到 rescue 分支。

三份计划文档是整合元数据，必须先形成独立 docs commit。13 个 Skill Evaluation / KB 文件、8 个 Control API / Control Plane / Web Flow 文件和 24 个 Real Multimodal Execution Hardening 源码/测试文件必须分别形成三个业务提交，不能把四个责任域混入同一个提交。`run-inputs` 图片只进入仓库外备份并保留本地，不进入业务提交；用于保持 `git status` clean 的 `.gitignore` 规则随 Real Multimodal 工作包提交并单独检查。

初始备份必须同时覆盖 tracked diff、staged diff 和全部 11 个未跟踪文件。所有非根 worktree 必须逐个验证 clean；发现 dirty worktree 时立即停止，为该 worktree 单独建立 patch 和未跟踪文件归档，再更新计划。

### 4.3 单写者

整合准备阶段只有根 worktree 可以执行归档和 rescue commit。创建 `.worktrees/repository-consolidation` 后，只有该 worktree 可以修改整合内容。其他 worktree 保持只读，完成归档后再删除。

开发前必须同时比较 `git worktree list --porcelain` 和 `.worktrees/` 实际目录，并逐个记录 status。注册但目录缺失、目录存在但未注册、或非根 worktree dirty 都会触发停止门禁。

### 4.4 小批次合入

每个工作包独立提交、独立验证。某个工作包失败时，可以回滚该提交，不影响之前已经完成的工作包。

## 5. 分支处置

### 5.1 已按祖先关系进入 main

以下分支不再合并，验证后删除：

- `feat/current-trusted-research-flow`
- `feature/skill-capability-evaluation`
- `integrate/current-trusted-research-flow`
- `integration/issues-29-36-merge`
- `refactor/plan-builder`

其中前两个分支有独立 worktree，删除分支前先删除对应 worktree。

### 5.2 已通过 squash 等价进入 main

以下分支不再合并：

- `cutover-operator-cli`
  - 分支整体 patch 与 `main` 的 `43a54bf` 相同，aggregate patch-id 为 `805bf1eef6c74ccd438915e32d98d5347146175a`。
  - 逐提交 `git cherry -v main cutover-operator-cli` 仍会显示 `+`，这是因为主线以 squash 形式吸收；不得据此重新 merge 该分支。
- `local-cutover-rehearsal`
  - 分支提交与 `main` 中的 squash 提交 patch 等价。

这些分支只能在 `main` 和归档 tag 推送成功后删除本地引用。远程引用删除必须先列出候选、记录保护依据，并取得人工确认。

### 5.3 归档分支

#### `archive/cutover-progress-20260817`

功能内容已经进入 `main`。该分支额外保存的 Cutover 进度文件已被当前 Trusted Multimodal Research 进度文件取代。保留 tag，不合并文件。

#### `archive/local-main-wip-20260817`

该分支是基于旧主线的一次实现快照。模拟合并有 19 个冲突区，不能直接 merge。

处理规则：

- `doc/项目汇报材料_M1_20260721.md` 仅归档。
- `docs/agent-orchestrator-replication-guide.md` 仅归档，旧代码行号和模块边界不进入当前文档。
- `tests/final-release-blockers.test.ts` 不整文件恢复，将三个行为断言迁入当前测试：
  - recovery 隔离断言放入 `tests/execution-recovery.test.ts`。
  - DAG wave 调度断言放入 `tests/execution-scheduler.test.ts`。
  - retry lineage 与 receipt 断言放入 `tests/lease-execution-engine.test.ts`。

### 5.4 `feat/m1-real-capabilities`

该分支比 `main` 少 168 个主线提交，包含 19 个独有提交、137 个变更文件和约 1 万行新增。模拟合并有 38 个冲突区。处理方式是行为前移，不执行整分支 merge 或批量 cherry-pick。

每个独有提交必须在整合记录中获得一个结果：

- `forward-ported`：行为或合同已基于当前架构实现。
- `covered-by-main`：当前 `main` 已有等价或更严格实现，并有测试证据。
- `archived`：历史材料、实验入口或过期实现只保留在 tag 和 bundle 中。

不允许使用 `ignored` 或空白状态。模板中的临时状态 `unreviewed` 必须在最终门禁前清零。

唯一 disposition 真相源为：

```text
docs/plans/2026-08-17-repository-consolidation-disposition.md
```

每条记录至少包含来源、SHA 或路径、最终结论、当前目标位置、验证命令、验证结果和独立复核人。TodoList 中的勾选不能代替该记录。

### 5.5 `stash@{0}`

stash commit `945ff6c` 是独立内容源。开始迁移前先创建 tag，并从 `945ff6c^1` 创建独立 rescue 分支和 worktree。使用 archive tag 执行带 index 的非破坏性 apply，禁止使用 `git stash pop`。第三父提交中的未跟踪文件必须纳入清单，不能只检查 `git stash show` 的默认输出；清单命令以 `git ls-tree -r --name-only 'archive/repository-consolidation/m1-stash-20260817^3'` 为准。

apply 前后分别保存 status、index diff、tracked diff 和 untracked 清单。只有 14 个 tracked 文件和 25 个 untracked 文件都进入 disposition，且恢复演练通过后，才允许 drop 原 stash。

stash 中以下内容进入行为审查：

- execution state hardening。
- feedback 和 repository 改动。
- `replay-report-v2`。
- API integration 与 execution state machine 测试。
- `vision-brand-vlm-failover-smoke`。

旧 wiki、HANDOFF 和 helloagents 过程材料只归档，除非其中的合同已通过当前测试证明仍然有效。

## 6. 开发工作包

### 工作包 A：冻结与恢复点

1. 停止其他写入者。
2. 确认受管 Vite/pnpm 预览进程不再自动重启；如果仍由外部控制器拉起，停止并由 owner 关闭该任务，不把它降级为“已知噪声”。
3. 比较注册 worktree 和 `.worktrees/` 实际目录，逐个记录 status，确认除根 worktree 外全部 clean。
4. 记录当前 refs、branch、stash、reflog、tracked diff、staged diff 和 untracked 清单。
5. 复核 `$BACKUP_DIR/emergency-freeze-20260817T154231Z/` 的 bundle 和 SHA-256；该捕获只作为 v3 基线失效后的保险，不替代正式备份。
6. 为两个 archive 分支、M1 分支和 stash commit 创建 annotated tag。
7. 创建并验证持久化仓库外备份目录。
8. 保存根 worktree 的 tracked patch、staged patch、三份计划文档、四个未跟踪源码/测试文件和四个真实输入图片。
9. 将三份计划文档提交为独立 docs commit。
10. 将 13 个 Skill Evaluation / KB 文件提交为独立 rescue commit。
11. 将 8 个 Control API / Control Plane / Web Flow 文件提交为另一个独立 rescue commit。
12. 将 20 个 tracked 和 4 个未跟踪的 Real Multimodal Execution Hardening 源码/测试文件提交为第三个业务 rescue commit；同时加入最小 `.gitignore` 规则保留本地 `run-inputs/`。
13. 逐项核对三个业务提交的路径集合，禁止跨工作包夹带。
14. 生成仓库外 Git bundle，确认包含四个 archive tag 和完整 rescue 分支。
15. 确认 `main` 回到 clean 状态，同时四个本地真实输入图片仍存在且 SHA-256 与备份一致。

建议 tag：

```text
archive/repository-consolidation/cutover-progress-20260817
archive/repository-consolidation/local-main-wip-20260817
archive/repository-consolidation/m1-real-capabilities-20260817
archive/repository-consolidation/m1-stash-20260817
```

默认持久化仓库外备份目录：

```text
../ai-x-backups/repository-consolidation-20260817/
```

执行时必须将其解析为绝对路径并写入 disposition 元数据。目录内固定内容：

```text
ai-x-repository-consolidation-pre-cleanup-20260817.bundle
ai-x-repository-consolidation-final-main-20260817.bundle
main-working-tree.patch
main-index.patch
plans/
root-untracked/
repository-state.txt
worktree-status.txt
sha256.txt
```

`pre-cleanup` bundle 在删除分支和 stash 前最后刷新，必须保留全部待删除 refs；清理后不得覆盖它。完成记录 PR 合入后另建 `final-main` bundle，并创建 `archive/repository-consolidation/completed-20260817` 指向最终 `main`。`$RESTORE_DIR/` 只能用于 bundle 恢复演练，不能作为唯一备份。

### 工作包 B：同步远端并建立整合工作区

本地恢复点完成后执行 `git fetch --prune --tags origin`，记录 `origin/main`、远程功能分支和远程 tag。第一次 fetch 后，如果 `origin/main` 不再是已盘点的 `1ff951c`，停止并更新分支关系、冲突模拟和本文基线。

从 clean `main` 创建：

```text
branch: integrate/repository-consolidation
worktree: .worktrees/repository-consolidation
```

先运行 clean `main` 基线门禁，再依次 cherry-pick docs、Skill Evaluation / KB、Control API / Control Plane / Web Flow、Real Multimodal Execution Hardening 四个 rescue commit。每个业务提交运行自己的定向测试，最后运行 `pnpm quality`。Real Multimodal 工作包至少覆盖 Gateway receipt、LLM input compaction、Visual Input materialization、Planner、Deliverable、Review、Requirement Refinement、Lease Execution 和 Capability Registry 的定向测试。以上提交不得夹带分支清理或 M1 迁移。

### 工作包 C：恢复归档测试不变量

将 `tests/final-release-blockers.test.ts` 的三个行为断言迁入当前测试文件。测试必须使用当前公开接口，不恢复旧 fixture 或旧模块结构。

完成条件：

- 三个定向测试文件通过。
- `pnpm typecheck` 通过。
- archive/local 快照不再包含未处置的生产行为。

### 工作包 D：M1 Runtime 与 Tool 行为前移

审查并前移仍缺失的行为：

- Tool 调用故障隔离和 receipt。
- Gateway 调用错误处理与模型漂移门禁。
- 编排收敛和 assumptions 输入防御。
- 当前 Registry 中仍然有效的真实检索 Tool 合同。
- 对应的 fault、retry、schema 和 registry 测试。

禁止事项：

- 不恢复旧 provider 默认值。
- 不恢复 Current 已替代的 Tool adapter。
- 不把内部 Tool 注册为 core，除非当前 Registry 和运行环境都能证明其常在性。
- 不删除当前仍在使用的 Tool，只因为旧分支曾删除它。

### 工作包 E：M1 Evidence、Report 与合同前移

对照当前 Current Evidence、Manifest、Deliverable 和 ReportDocument，处理以下旧内容：

- evidence ledger。
- report blueprint、renderer 和 synthesis。
- skill result envelope。
- KB skill output schemas。
- report、evidence、schema 相关测试。

当前实现已覆盖的内容标记为 `covered-by-main`。只有缺失且与当前合同兼容的行为才能前移。旧 report 模块不能与 Current 交付链并行成为第二套生产入口。

### 工作包 F：stash 状态机与 replay 前移

从 `archive/repository-consolidation/m1-stash-20260817^1` 创建 `rescue/m1-stash-20260817` 和独立 worktree。使用 `git stash apply --index archive/repository-consolidation/m1-stash-20260817` 非破坏性恢复，禁止 `git stash pop`。逐项处理 tracked、index 和 untracked 内容，生产改动按当前 API、Repository 和 Control Plane 合同重新适配。

完成条件：

- apply 前后的 status、index diff、tracked diff 和 untracked 清单已保存。
- 14 个 tracked 文件和 25 个 untracked 文件全部进入 disposition。
- execution state 和 replay 测试有明确去向。
- stash 不再保存唯一内容。
- tag、bundle 和恢复演练验证通过后才能 drop stash。

### 工作包 G：发布、分支与 worktree 清理

内容整合完成后执行：

1. 再次执行 `git fetch --prune --tags origin`。如果 `origin/main` 移动，将新远端提交整合到 integration 分支并重跑全部门禁。
2. 推送 archive tags 和 `integrate/repository-consolidation`。
3. 创建 integration PR，等待远端 CI 和独立 disposition 复核通过。
4. 通过 PR 更新 `main`，随后将本地 `main` fast-forward 到 `origin/main`。
5. 删除 clean worktree。
6. 删除已合并或已归档的本地分支。
7. 删除远端 integration 分支。
8. 列出其他远程功能分支候选，取得人工确认后再删除远程引用。
9. 删除空的 `.worktrees/.orca-worktree-trash`。
10. 执行 worktree 和 remote prune。
11. 删除临时 rescue 分支。
12. 从 clean `main` 创建 completion receipt 分支，将 TodoList、disposition 和清理结果通过独立 docs PR 合入。
13. 为完成记录后的 `main` 创建 completion tag 和 final-main bundle。

不得对 dirty worktree 使用强制删除。不得在 tag、bundle 和恢复演练验证前使用 `git branch -D` 或 `git stash drop`。不得在未确认远程分支 owner 和恢复路径前执行 `git push origin --delete ...`。

## 7. 验证

### 7.1 每个工作包

至少执行：

```bash
git diff --check
pnpm typecheck
```

涉及测试行为时执行对应的 `pnpm exec tsx --test` 定向测试。

### 7.2 最终离线门禁

```bash
pnpm quality
pnpm --dir apps/web build
git diff --check
git fsck --full
git status --short --branch
git worktree list --porcelain
git branch --merged main
git branch --no-merged main
```

### 7.3 远端发布门禁

```bash
git fetch --prune --tags origin
git rev-parse origin/main
git log --left-right --graph --oneline origin/main...integrate/repository-consolidation
git push origin integrate/repository-consolidation
gh pr checks integrate/repository-consolidation --watch
```

第二次 fetch 后 `origin/main` 如果移动，必须将新提交整合到 integration 分支并重跑 `pnpm quality`、Web build 和条件性真实 Smoke。远端 CI 和独立 disposition 复核通过前，不得更新 `main`。

### 7.4 条件性真实门禁

如果工作包 B 中的 Real Multimodal WIP，或工作包 D、E、F 修改真实 Gateway、Tavily、Tool receipt、Evidence 或 Current Report 路径，执行：

```bash
pnpm db:migrate
pnpm db:seed
ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm smoke:current:real
```

需要的安全注入变量：

- `DATABASE_URL`
- `JWT_SECRET`
- `LLM_GATEWAY_BASE_URL`
- `LLM_GATEWAY_API_KEY`
- `LLM_MODEL_NAME`
- `LLM_EXPECTED_ACTUAL_MODEL`
- `TAVILY_API_KEY`

密钥不得写入计划、提交、日志归档或长期 Artifact。

## 8. 回滚

### 8.1 内容回滚

每个工作包独立提交。发现回归时 revert 对应提交，不重置已经完成的其他工作包。

### 8.2 分支恢复

从对应 archive tag 重新创建分支：

```bash
git switch -c <restored-branch> <archive-tag>
```

### 8.3 stash 恢复

`archive/repository-consolidation/m1-stash-20260817` 指向原 stash merge commit，可以恢复 tracked、index 和第三父提交中的 untracked 内容。stash drop 前必须在临时 worktree 做一次恢复验证。

### 8.4 bundle 恢复

本地 refs、tag 或 object 丢失时，从仓库外 bundle fetch 到新 clone，不在受损工作区直接修复。

## 9. 完成定义

以下条件全部满足后，本次整合完成：

- TodoList 第 0 至 17 节的执行结果已进入 completion receipt PR；第 18 节的 post-merge 结果已写入仓库外最终收据。
- 每个 M1 独有提交和 stash 文件都在 disposition 文件中有结论和证据。
- disposition 第 3 至 6 节的结论单元格不存在 `unreviewed`、空白值或 `ignored`。
- disposition 已由非原执行者独立复核并签名。
- `pnpm quality` 通过。
- Web production build 通过。
- 条件性真实 Smoke 已通过，或确认本次没有触及真实能力路径。
- `main` 已通过 integration PR 更新，且本地 `main` 与 `origin/main` 指向一致。
- 远端 integration 分支已删除。
- 根目录是唯一 worktree。
- `git status --short` 无输出。
- `git branch --no-merged main` 不包含待清理开发分支。
- stash 中没有本次整合相关内容。
- archive tags 和 completion tag 已推送，两份持久化仓库外 bundle 均可读取，SHA-256 与仓库外最终收据一致。
- pre-cleanup bundle 可以恢复被删除的 refs，final-main bundle 可以恢复最终 `main` 和 completion tag。
- 两份 bundle 都已在 `$RESTORE_DIR` 的独立 clone 中完成恢复演练。

## 10. 变更控制

以下情况必须停止开发并重新确认方案：

- 出现新的未登记 worktree、branch 或 stash。
- 注册 worktree 和 `.worktrees/` 实际目录不一致，或任一非根 worktree dirty。
- 其他进程继续修改当前仓库。
- 任一次 fetch 发现 `origin/main` 超出已验证基线。
- 发现 M1 分支包含生产正在使用、但 `main` 完全缺失的数据迁移。
- 需要 force push `main`。
- 需要删除数据库或审计数据。
- 需要降低 ADR 中的全真 Smoke、HITL 或 Evidence 门禁。
