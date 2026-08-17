# 仓库分支与 Worktree 整合 TodoList

> 对应开发文档：`docs/plans/2026-08-17-repository-consolidation-development.md`
>
> Disposition 真相源：`docs/plans/2026-08-17-repository-consolidation-disposition.md`
>
> 规则：按顺序执行。带有“门禁”的项目未完成时，不得进入下一组任务。每次勾选时在同一行末尾记录 commit、命令结果、PR 或归档路径。所有处置结论和测试证据必须同时写入 disposition 文件。

## 执行变量

在仓库根目录执行并保持同一 shell 会话：

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
BACKUP_DIR="$(cd "$REPO_ROOT/.." && pwd)/ai-x-backups/repository-consolidation-20260817"
RESTORE_DIR="/private/tmp/ai-x-repository-consolidation-20260817-restore-drill"
export REPO_ROOT BACKUP_DIR RESTORE_DIR
```

- [x] 确认 `REPO_ROOT` 是当前仓库根目录。结果：`/Users/heyunshen/work/PROJECT/jdc/ai-x`。
- [x] 确认 `BACKUP_DIR` 在当前 Git 仓库外，位于持久化文件系统。结果：`/Users/heyunshen/work/PROJECT/jdc/ai-x-backups/repository-consolidation-20260817`，紧急捕获可写、可读且校验通过。
- [x] 将最终 `BACKUP_DIR` 绝对路径写入 disposition 元数据。结果：disposition 第 1 节已记录。
- [x] 确认 `RESTORE_DIR` 仅用于恢复演练，不承担长期备份责任。结果：开发文档和本清单均将正式资产固定到 `BACKUP_DIR`。

## 0. 开发前冻结门禁

- [x] 停止所有正在操作本仓库的 Agent、脚本和 IDE Git 写操作。结果：受管 Web 预览进程经 `SIGINT` 正常退出；最终两轮采样未发现仓库相关进程。
- [x] 确认根 Web 预览任务不再由外部 `omp` worker broker 自动重启。结果：`SIGINT` 后跨两个采样窗口未重启。
- [x] 确认只有一名执行者拥有写权限。证据：两轮状态快照和两轮内容指纹均稳定，无仓库相关进程。
- [x] 间隔至少 60 秒记录两次 `git status --short --branch`，确认没有外部变化。结果：`freeze-v4-snapshot-1-corrected.txt`（15:50:16Z）与 `freeze-v4-snapshot-2.txt`（15:51:38Z）除时间外无差异。
- [x] 间隔至少 60 秒记录两次 `git worktree list --porcelain`，确认没有新增或消失的 worktree。结果：同上，两次清单一致。
- [x] 对 binary diff、全部未跟踪文件和 worktree status 做两次内容指纹。结果：`freeze-v4-content-fingerprint-1.txt`（15:52:00Z）与 `freeze-v4-content-fingerprint-2.txt`（15:53:11Z）除时间外无差异。
- [x] 列出 `.worktrees/` 一级目录，并与注册 worktree 逐项比较。结果：4 个注册目录精确匹配；`.orca-worktree-trash` 为空且不作为 worktree。
- [x] 确认不存在“已注册但目录缺失”或“目录存在但未注册”的 worktree。结果：`registered_disk_diff` 无输出。
- [x] 对每个注册 worktree 执行 `git -C <worktree> status --short --branch`。证据：两份最终 snapshot。
- [x] 确认除根 worktree 外的所有 worktree clean。结果：4 个非根 worktree 均仅输出 branch header。
- [x] 确认 detached `demo-runtime` 当前不再注册且目录不存在；如果重新出现，停止并更新计划。结果：注册与磁盘清单均无此项。
- [x] 记录 `git branch --all --verbose --verbose --no-abbrev`。证据：两份最终 snapshot。
- [x] 记录 `git stash list` 和 `git reflog -20 --date=iso`。证据：两份最终 snapshot。
- [x] 确认 `main` 仍位于 `c599e693555f9c60ca5d36e4cffd24644836e616`。结果：PASS。
- [x] 确认 `stash@{0}` 仍指向 `945ff6c00f7d06a6d32399a9817a09a01b2b6aa2`。结果：PASS。
- [x] 记录 `git diff --name-only`，确认根 worktree 有 41 个 tracked 修改文件：13 个 Skill Evaluation / KB、8 个 Control / Web、20 个 Real Multimodal Execution Hardening。结果：PASS；精确路径集已写入 disposition 2.1。
- [x] 记录 `git diff --cached --name-only`，确认没有 staged 修改。结果：0。
- [x] 记录 `git ls-files --others --exclude-standard`，确认有 11 个未跟踪文件：三份计划文档、四个 Real Multimodal 源码/测试文件和四个 `run-inputs` 图片。结果：PASS；精确路径集已写入 disposition 2.1。
- [x] 如果任一 SHA、文件数量、路径或 worktree 状态变化，停止并更新三份计划文档。结果：v3 的 21/3 基线已升级为 v4 的 41/11 基线，三份文档已同步。
- [x] v3 基线失效后建立仓库外紧急捕获。结果：`$BACKUP_DIR/emergency-freeze-20260817T154231Z/`；refs bundle verify 和全文件 SHA-256 复核通过，包含 41-file binary patch 与全部 11 个未跟踪文件。
- [x] 将过期的 21/3 文件基线更新为 v4 的 41/11 文件基线。结果：development、TodoList、disposition 已同步修订；需在修订后重新执行两次冻结采样。

### 门禁 0

- [x] 仓库状态稳定，未发现并发写入者。证据：两轮状态快照 + 两轮内容指纹。
- [x] 所有非根 worktree clean。结果：PASS。
- [x] 注册 worktree 和磁盘目录一致。结果：PASS。

## 1. 建立归档引用

- [x] 确认四个目标 archive tag 当前不存在，避免覆盖既有 tag。结果：创建前逐项 `show-ref --verify` 均不存在。
- [x] 创建 annotated tag `archive/repository-consolidation/cutover-progress-20260817`，指向 `bea27b0f6a0f99e745f834cbde0a3b7ae4a1f25a`。结果：PASS。
- [x] 创建 annotated tag `archive/repository-consolidation/local-main-wip-20260817`，指向 `b0ed2b52550c388dbb0bd435f4aa91a392ecd36a`。结果：PASS。
- [x] 创建 annotated tag `archive/repository-consolidation/m1-real-capabilities-20260817`，指向 `44a289365e7a3c8ce808d33f222a323cdcd46ba2`。结果：PASS。
- [x] 创建 annotated tag `archive/repository-consolidation/m1-stash-20260817`，指向 `945ff6c00f7d06a6d32399a9817a09a01b2b6aa2`。结果：PASS。
- [x] 用 `git show --no-patch` 检查四个 tag 的对象和说明。结果：对象和注释正确。
- [x] 用 `git rev-list --parents -1 archive/repository-consolidation/m1-stash-20260817` 确认 stash tag 保留三个父提交。结果：`945ff6c` 后有 `44a2893`、`4bf508e`、`4c5e6bc` 三个父提交。
- [x] 用 `git diff --name-only 'archive/repository-consolidation/m1-stash-20260817^1' archive/repository-consolidation/m1-stash-20260817` 确认 14 个 tracked 文件。结果：14。
- [x] 用 `git ls-tree -r --name-only 'archive/repository-consolidation/m1-stash-20260817^3'` 确认 25 个 untracked 文件。结果：25。
- [x] 比较命令输出与 disposition 第 5、6 节，确认没有缺项或多项。结果：两次 `comm -3` 均无输出。

## 2. 建立初始持久化备份

- [x] 创建 `$BACKUP_DIR/plans`。结果：PASS。
- [x] 创建 `$BACKUP_DIR/root-untracked`，按仓库相对路径保存四个未跟踪源码/测试文件和四个 `run-inputs` 图片。结果：8 个文件。
- [x] 确认 `$BACKUP_DIR` 可写、可读且不在当前 Git 仓库内。结果：PASS。
- [x] 将三份未跟踪计划文档复制到 `$BACKUP_DIR/plans`。结果：3 个文件；门禁收据写入后会重复制一次。
- [x] 将其余 8 个未跟踪文件复制到 `$BACKUP_DIR/root-untracked`，逐项比较大小和 SHA-256。结果：逐项 `cmp` 通过并纳入 `sha256.txt`。
- [x] 用 `git diff --binary HEAD` 保存 `$BACKUP_DIR/main-working-tree.patch`。结果：224037 bytes。
- [x] 用 `git diff --cached --binary HEAD` 保存 `$BACKUP_DIR/main-index.patch`。结果：0 bytes，符合无 staged 修改的基线。
- [x] 将 refs、branch、stash、reflog 和根 status 保存到 `$BACKUP_DIR/repository-state.txt`。结果：PASS。
- [x] 将注册 worktree、磁盘目录和每个 worktree 的 status 保存到 `$BACKUP_DIR/worktree-status.txt`。结果：PASS。
- [x] 用 `git bundle create "$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle" --all` 创建初始 bundle。结果：31 refs。
- [x] 用 `git bundle verify "$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle"` 验证 bundle。结果：PASS。
- [x] 用 `git bundle list-heads "$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle"` 确认四个 archive tag 在 bundle 中。结果：4。
- [x] 为 `$BACKUP_DIR` 中除 `sha256.txt` 外的所有文件生成 SHA-256，写入 `$BACKUP_DIR/sha256.txt`。结果：PASS。
- [x] 用 `shasum -a 256 -c "$BACKUP_DIR/sha256.txt"` 复核。结果：全部 OK；初始 bundle SHA-256 `e87478719348fad3764df2b9f1fbb237e3122050546c8bd87f4b56a8fce0c4ea`。

### 门禁 1

- [x] 四个 archive tag 可读。结果：PASS。
- [x] tracked patch、staged patch 和全部 11 个未跟踪文件都有仓库外副本。结果：PASS。
- [x] 所有 worktree 状态均已归档。结果：PASS。
- [x] 初始 bundle 验证和 SHA-256 复核通过。结果：PASS。

## 3. 固化计划文档和根 worktree WIP

- [ ] 从当前 `main` 创建 `rescue/main-consolidation-wip-20260817`。
- [ ] 只暂存三份计划文档。
- [ ] 检查 staged diff 后提交 `docs: plan repository consolidation`，记录 commit SHA。
- [ ] 只暂存 13 个 Skill Evaluation / KB 文件。
- [ ] 检查 staged diff，确认没有 Control、Web、archive 或 stash 内容。
- [ ] 提交 `feat: complete KB-aware skill evaluation follow-up`，记录 commit SHA。
- [ ] 只暂存 8 个 Control API / Control Plane / Web Flow 文件。
- [ ] 检查 staged diff，确认没有 Skill Evaluation、KB、archive 或 stash 内容。
- [ ] 提交 `fix: preserve current control flow recovery`，记录 commit SHA。
- [ ] 只暂存 20 个 tracked 和 4 个未跟踪的 Real Multimodal Execution Hardening 源码/测试文件，并加入只忽略本地 `run-inputs/` 的最小 `.gitignore` 规则。
- [ ] 检查 staged diff，确认没有 Skill Evaluation / KB、Control / Web、archive、stash 或四个二进制图片。
- [ ] 提交 `fix: preserve real multimodal execution hardening`，记录 commit SHA。
- [ ] 确认四个 `run-inputs` 图片仍在本地且 SHA-256 与 `$BACKUP_DIR/root-untracked` 一致。
- [ ] 确认 rescue 分支依次包含 docs、Skill Evaluation / KB、Control / Web、Real Multimodal Execution Hardening 四个独立提交。
- [ ] 用临时文件创建刷新后的 bundle，验证通过后原子替换初始 bundle。
- [ ] 用 `git bundle list-heads` 确认刷新后的 bundle 包含四个 archive tag 和 `rescue/main-consolidation-wip-20260817`。
- [ ] 重新生成并复核 `$BACKUP_DIR/sha256.txt`。
- [ ] 切回 `main`。
- [ ] 确认 `main` 工作区 clean。

### 门禁 2

- [ ] 三份计划文档已进入独立 docs commit。
- [ ] 13 个 Skill Evaluation / KB 文件已进入独立 rescue commit。
- [ ] 8 个 Control / Web 文件已进入另一个独立 rescue commit。
- [ ] 24 个 Real Multimodal 源码/测试文件和最小 `.gitignore` 规则已进入第三个独立业务 rescue commit。
- [ ] 四个真实输入图片未进入 Git history，仓库外副本和本地保留文件一致。
- [ ] 刷新后的 bundle 可以恢复 archive tag 和完整 rescue 分支。
- [ ] `main` clean，且没有未跟踪文件。

## 4. 同步远端基线

- [ ] 执行 `git fetch --prune --tags origin`。
- [ ] 记录 `git rev-parse origin/main`。
- [ ] 记录远程 branch 和 tag 清单。
- [ ] 确认 `origin/main` 仍为 `1ff951cd9dee667601009c3ccf38ef7c39df7158`。
- [ ] 确认远端没有与四个 archive tag 冲突的引用。
- [ ] 如果 `origin/main` 已移动，停止并重新计算祖先关系、patch 等价和冲突结果。

### 门禁 3

- [ ] 远端基线已刷新并记录。
- [ ] 当前分支分类仍然成立。

## 5. 创建整合 worktree

- [ ] 从 clean `main` 创建 `integrate/repository-consolidation`。
- [ ] 创建 `.worktrees/repository-consolidation`。
- [ ] 确认整合 worktree clean。
- [ ] 记录 Node、pnpm 和 PostgreSQL CLI 版本。
- [ ] 确认 Node 满足 `>=22`，pnpm 使用 `9.12.1`。
- [ ] 在 clean `main` 基线上运行 `pnpm quality`。
- [ ] 在 clean `main` 基线上运行 `pnpm --dir apps/web build`。

### 门禁 4

- [ ] 基线 quality 通过。
- [ ] 基线 Web build 通过。
- [ ] 如果基线失败，停止整合并记录失败与当前主线责任归属。

## 6. 整合四个 rescue commit

- [ ] cherry-pick docs plan commit。
- [ ] cherry-pick Skill Evaluation / KB commit。
- [ ] 运行 `pnpm exec tsx --test tests/kb-compare.test.ts tests/kb-retriever.test.ts tests/kb-snapshot.test.ts tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts`。
- [ ] 运行 `pnpm typecheck`，记录结果。
- [ ] cherry-pick Control API / Control Plane / Web Flow commit。
- [ ] 运行 `pnpm exec tsx --test tests/control-api-integration.test.ts tests/current-flow-state.test.ts`。
- [ ] 运行 `pnpm typecheck`，记录结果。
- [ ] cherry-pick Real Multimodal Execution Hardening commit。
- [ ] 运行 `pnpm exec tsx --test tests/gateway-llm-receipt.test.ts tests/llm-input-compactor.test.ts tests/visual-input-materializer.test.ts tests/capability-resolver.test.ts tests/control-clarification.test.ts tests/current-deliverable-service.test.ts tests/lease-execution-engine.test.ts tests/plan-compiler.test.ts tests/report-review-service.test.ts tests/requirement-refinement-service.test.ts`。
- [ ] 运行 `pnpm typecheck`，记录结果。
- [ ] 运行 `pnpm quality`。
- [ ] 记录测试数量、通过数量、跳过数量和失败数量到 disposition 第 7 节。
- [ ] 确认四个提交未夹带分支清理或 M1 内容。

### 门禁 5

- [ ] 四个 rescue commit 保持独立可回滚。
- [ ] Skill Evaluation、KB、Control API、Current Flow 和 Real Multimodal 定向测试通过。
- [ ] full quality 通过。

## 7. 迁移 archive/local 测试不变量

- [ ] 对照当前测试确认 recovery 隔离断言是否已经覆盖。
- [ ] 缺失时将 recovery 隔离断言迁入 `tests/execution-recovery.test.ts`；已覆盖时记录 `covered-by-main` 证据。
- [ ] 对照当前测试确认 DAG wave 调度断言是否已经覆盖。
- [ ] 缺失时将 DAG wave 调度断言迁入 `tests/execution-scheduler.test.ts`；已覆盖时记录 `covered-by-main` 证据。
- [ ] 对照当前测试确认 retry lineage 与 receipt 断言是否已经覆盖。
- [ ] 缺失时将断言迁入当前最接近的 lease 或 tool 测试；已覆盖时记录 `covered-by-main` 证据。
- [ ] 确认测试使用当前公开接口，不复制旧实现类型。
- [ ] 运行 `pnpm exec tsx --test tests/execution-recovery.test.ts tests/execution-scheduler.test.ts tests/lease-execution-engine.test.ts`，不存在的目标文件按最终迁移位置替换并记录完整命令。
- [ ] 运行 `pnpm typecheck`。
- [ ] 有代码变化时提交独立的 archive test preservation commit。
- [ ] 更新 disposition 第 3 节的四个 archive 条目。

### 门禁 6

- [ ] archive/local 的四个条目都有结论和证据。
- [ ] 三个行为不变量已前移或有当前覆盖证据。

## 8. 建立 M1 commit disposition

- [ ] 为 `869ee2c` 记录最终结论、当前目标和验证证据。
- [ ] 为 `0f78f85` 记录最终结论、当前目标和验证证据。
- [ ] 为 `15e0b79` 记录最终结论、当前目标和验证证据。
- [ ] 为 `302f88e` 记录最终结论、当前目标和验证证据。
- [ ] 为 `f6b8ffe` 记录最终结论、当前目标和验证证据。
- [ ] 为 `3b43b48` 记录最终结论、当前目标和验证证据。
- [ ] 为 `d12f38f` 记录最终结论、当前目标和验证证据。
- [ ] 为 `e1a6c98` 记录最终结论、当前目标和验证证据。
- [ ] 为 `5eec19a` 记录最终结论、当前目标和验证证据。
- [ ] 为 `c11651e` 记录最终结论、当前目标和验证证据。
- [ ] 为 `d99fd6d` 记录最终结论、当前目标和验证证据。
- [ ] 为 `73ee4c6` 记录最终结论、当前目标和验证证据。
- [ ] 为 `a02ee42` 记录最终结论、当前目标和验证证据。
- [ ] 为 `b9aea74` 记录最终结论、当前目标和验证证据。
- [ ] 为 `8af75d7` 记录最终结论、当前目标和验证证据。
- [ ] 为 `d7010c1` 记录最终结论、当前目标和验证证据。
- [ ] 为 `55bdf0e` 记录最终结论、当前目标和验证证据。
- [ ] 为 `8e49c6b` 记录最终结论、当前目标和验证证据。
- [ ] 为 `44a2893` 记录最终结论、当前目标和验证证据。
- [ ] 确认没有 `ignored` 或空白结论。

## 9. 前移 M1 Runtime 与 Tool 行为

- [ ] 对照当前 Tool adapter，确认故障隔离是否已覆盖。
- [ ] 对照当前 receipt，确认 attempt、retry 和 implementation identity 是否已覆盖。
- [ ] 对照当前 Gateway client，确认错误处理和模型漂移门禁是否已覆盖。
- [ ] 对照当前 Planner，确认 assumptions 输入防御是否已覆盖。
- [ ] 对照当前 Planner，确认编排收敛约束是否已覆盖。
- [ ] 检查 JD Product Search 合同，决定前移或归档并记录证据。
- [ ] 检查 Joyspace Search 合同，决定前移或归档并记录证据。
- [ ] 检查 Tavily 合同，确认当前实现是否更严格。
- [ ] 不恢复 Kimi、Gemini 或旧模型默认配置。
- [ ] 不删除当前仍在使用的 `o2-web-search`，除非当前 Registry 已明确移除且测试通过。
- [ ] 为所有前移行为增加或复用定向测试。
- [ ] 在 disposition 第 7 节记录完整定向测试命令和结果。
- [ ] 运行 `pnpm lint:registry`。
- [ ] 运行 `pnpm lint:knowledge`。
- [ ] 运行 `pnpm typecheck`。
- [ ] 有代码变化时提交独立的 M1 Runtime / Tool commit。

### 门禁 7

- [ ] Runtime / Tool 工作包可独立回滚。
- [ ] 未引入第二套 Tool 或 Gateway 生产入口。
- [ ] 相关定向测试和 linter 通过。

## 10. 前移 M1 Evidence、Report 与合同

- [ ] 对照 Current Evidence 检查旧 evidence ledger 行为。
- [ ] 对照 Current Manifest 检查旧 evidence source 和 pointer 行为。
- [ ] 对照 Current Deliverable 检查旧 report blueprint 行为。
- [ ] 对照 Current ReportDocument 检查旧 renderer 和 synthesis 行为。
- [ ] 检查 `schemas/skill-result-envelope.schema.json` 的合同是否仍缺失。
- [ ] 检查五个 KB skill output schema 是否仍缺失。
- [ ] 当前实现更严格时标记为 `covered-by-main`，并引用测试。
- [ ] 缺失且兼容的合同按当前模块边界前移。
- [ ] 不恢复旧 report 模块为第二套生产入口。
- [ ] 在 disposition 第 7 节记录完整定向测试命令和结果。
- [ ] 运行 `pnpm lint:registry`。
- [ ] 运行 `pnpm lint:knowledge`。
- [ ] 运行 `pnpm typecheck`。
- [ ] 有代码变化时提交独立的 M1 Evidence / Report commit。

### 门禁 8

- [ ] Evidence / Report 工作包可独立回滚。
- [ ] Current 仍是唯一生产交付链。
- [ ] schema、linter 和定向测试通过。

## 11. 非破坏性恢复并处理 stash

- [ ] 从 `archive/repository-consolidation/m1-stash-20260817^1` 创建 `rescue/m1-stash-20260817`。
- [ ] 创建独立 stash rescue worktree。
- [ ] 保存 apply 前的 status、index diff、tracked diff 和 untracked 清单。
- [ ] 运行 `git stash apply --index archive/repository-consolidation/m1-stash-20260817`。
- [ ] 禁止运行 `git stash pop`。
- [ ] 保存 apply 后的 status、index diff、tracked diff 和 untracked 清单。
- [ ] 核对 14 个 tracked 文件全部恢复。
- [ ] 核对第三父提交中的 25 个 untracked 文件全部恢复。
- [ ] 对 14 个 tracked 文件逐项更新 disposition 第 5 节。
- [ ] 对 25 个 untracked 文件逐项更新 disposition 第 6 节。
- [ ] 前移 execution state hardening 行为。
- [ ] 前移仍有效的 feedback、repository 和 replay 行为。
- [ ] 前移 API integration 和 execution state machine 测试。
- [ ] 检查 `vision-brand-vlm-failover-smoke`，记录前移或归档证据。
- [ ] 将旧 wiki、HANDOFF 和 helloagents 过程材料标记为 `archived`。
- [ ] 在 disposition 第 7 节记录完整定向测试命令和结果。
- [ ] 运行 `pnpm typecheck`。
- [ ] 有代码变化时提交独立的 stash forward-port commit。
- [ ] 确认原 `stash@{0}` 仍存在且 SHA 未变化。

### 门禁 9

- [ ] stash tracked 和 untracked 内容全部有 disposition。
- [ ] stash 前移提交可独立回滚。
- [ ] stash tag 和 bundle 可以完整恢复原内容。
- [ ] stash 中不存在唯一行为或唯一文件。

## 12. 固化 disposition 和离线验证

- [ ] 确认 disposition 第 3 至 6 节不存在 `unreviewed`、空白结论或 `ignored`。
- [ ] 确认每个 `forward-ported` 条目都有目标 commit 和测试。
- [ ] 确认每个 `covered-by-main` 条目都有当前实现位置和等价证据。
- [ ] 确认每个 `archived` 条目都有 tag、bundle 和不前移理由。
- [ ] 更新 disposition 第 7 节的工作包验证收据。
- [ ] 提交 `docs: record repository consolidation disposition`。
- [ ] 运行 `git diff --check`。
- [ ] 运行 `pnpm quality`。
- [ ] 运行 `pnpm --dir apps/web build`。
- [ ] 运行 `git fsck --full`。
- [ ] 记录最终测试数量、通过数量、跳过数量和失败数量。
- [ ] 检查提交历史，确认每个业务工作包独立可回滚。
- [ ] 确认整合 worktree clean。

### 门禁 10

- [ ] 离线 quality 通过。
- [ ] Web production build 通过。
- [ ] disposition 已形成独立审计提交。

## 13. 条件性真实 Smoke

- [ ] 判断工作包 6 的 Real Multimodal WIP，以及工作包 9、10、11 是否修改真实 Gateway、Tavily、Tool receipt、Evidence 或 Current Report 路径。v4 冻结快照已包含 Gateway、Tool receipt 和 Current Report 改动，除非该工作包被明确撤回，否则真实 Smoke 必须触发。
- [ ] 如果没有修改，记录“不触发真实 Smoke”及 diff 证据。
- [ ] 如果有修改，确认受控 PostgreSQL 测试库可用。
- [ ] 如果有修改，安全注入 `DATABASE_URL` 和 `JWT_SECRET`。
- [ ] 如果有修改，安全注入 LLM Gateway 配置和密钥。
- [ ] 如果有修改，安全注入 `TAVILY_API_KEY`。
- [ ] 如果有修改，运行 `pnpm db:migrate`。
- [ ] 如果有修改，运行 `pnpm db:seed`。
- [ ] 如果有修改，运行 `ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm smoke:current:real`。
- [ ] 确认日志和 Artifact 不包含密钥、Bearer token 或完整 prompt。
- [ ] 将 task、plan、attempt、deliverable 标识和结果写入 disposition 第 7 节。
- [ ] 提交真实 Smoke 证据更新；未触发时提交不触发证据。

### 门禁 11

- [ ] 条件性真实门禁已通过或有明确不触发证据。

## 14. 第二次远端同步、PR 和独立复核

- [ ] 再次执行 `git fetch --prune --tags origin`。
- [ ] 比较当前 `origin/main` 与门禁 3 记录的 SHA。
- [ ] 如果 `origin/main` 移动，将新提交整合到 integration 分支并重跑门禁 10、11。
- [ ] 推送四个 archive tag。
- [ ] 推送 `integrate/repository-consolidation`。
- [ ] 创建以 `main` 为目标的 integration PR。
- [ ] 等待远端 CI 完成。
- [ ] 由非原执行者审查 v4 根 WIP 的 13/8/24 文件分包、4 个本地 run-input、19 个 M1 条目、14 个 stash tracked 文件、25 个 stash untracked 文件和 4 个 archive 条目。
- [ ] 独立复核人检查 PR diff、目标 commit 和测试证据的一致性。
- [ ] 将复核人、时间、结论和 PR review 链接写入 disposition 第 8 节。
- [ ] 提交 `docs: record independent consolidation review` 并推送到 integration 分支。
- [ ] 等待最终 commit 对应的远端 CI 通过。

### 门禁 12

- [ ] 远端 CI 通过。
- [ ] disposition 独立复核通过。
- [ ] PR 中不存在未解决的阻塞意见。

## 15. 通过 PR 更新 main 并冻结清理前恢复点

- [ ] 通过 integration PR 更新 `origin/main`，不 force push。
- [ ] 在根 worktree 执行 `git fetch --prune --tags origin`。
- [ ] 将本地 `main` fast-forward 到 `origin/main`。
- [ ] 确认本地 `main` 与 `origin/main` 指向相同 commit。
- [ ] 记录 integration merge SHA。
- [ ] 在本地 `main` 重跑 `pnpm quality`。
- [ ] 在本地 `main` 重跑 `pnpm --dir apps/web build`。
- [ ] 用临时文件刷新包含 integration merge、四个 archive tag 和所有待删 refs 的 pre-cleanup bundle。
- [ ] 验证临时 bundle 后，原子替换 `$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle`。
- [ ] 重新生成并复核 `$BACKUP_DIR/sha256.txt`。
- [ ] 删除旧 `$RESTORE_DIR` 后，从 pre-cleanup bundle clone 到 `$RESTORE_DIR`。
- [ ] 在恢复 clone 中确认 integration merge、四个 archive tag、所有待删分支和 stash 三父提交均可读。

### 门禁 13

- [ ] 本地 `main` 与 `origin/main` 一致。
- [ ] integration merge 后的 quality 和 Web build 通过。
- [ ] pre-cleanup bundle、SHA-256 和独立 clone 恢复演练通过。
- [ ] 从此步骤起不得覆盖 pre-cleanup bundle。

## 16. 清理 worktree

- [ ] 确认 `.worktrees/current-trusted-research-flow` clean 后删除。
- [ ] 确认 `.worktrees/cutover-operator-cli` clean 后删除。
- [ ] 确认 `.worktrees/local-cutover-rehearsal` clean 后删除。
- [ ] 确认 `.worktrees/skill-capability-evaluation` clean 后删除。
- [ ] 如果 detached `demo-runtime` 再次出现，停止并重新归档，不直接强制删除。
- [ ] 删除 stash rescue worktree。
- [ ] 删除 repository consolidation worktree。
- [ ] 删除空的 `.worktrees/.orca-worktree-trash`。
- [ ] 运行 `git worktree prune --verbose`。
- [ ] 确认 `git worktree list` 只剩根目录。

## 17. 清理分支、stash 和远程引用

- [ ] 删除 `feat/current-trusted-research-flow`。
- [ ] 删除 `feature/skill-capability-evaluation`。
- [ ] 删除 `integrate/current-trusted-research-flow`。
- [ ] 删除 `integration/issues-29-36-merge`。
- [ ] 删除 `refactor/plan-builder`。
- [ ] 删除 `cutover-operator-cli`。
- [ ] 删除 `local-cutover-rehearsal`。
- [ ] 删除 `archive/cutover-progress-20260817`。
- [ ] 删除 `archive/local-main-wip-20260817`。
- [ ] 删除 `feat/m1-real-capabilities`。
- [ ] 删除 `integrate/repository-consolidation`。
- [ ] 删除 `rescue/main-consolidation-wip-20260817`。
- [ ] 删除 `rescue/m1-stash-20260817`。
- [ ] 在 pre-cleanup bundle 恢复验证后 drop 原 M1 stash。
- [ ] 删除远程 `integrate/repository-consolidation`。
- [ ] 列出其他已进入 `main` 的远程功能分支候选。
- [ ] 对每个远程删除候选记录 archive tag、bundle 恢复方式和 owner 确认。
- [ ] 取得人工确认后删除对应远程功能分支；未确认的远程分支保留。
- [ ] 运行 `git remote prune origin`。

## 18. 完成记录与最终验收

> 第 0 至 17 节的执行结果进入 completion receipt PR。该 PR 合入后的检查只写入 `$BACKUP_DIR/final-repository-state.txt`，不得再次修改仓库内 TodoList，以免制造自引用的“最终 commit”。

- [ ] 从 clean `main` 创建 `docs/repository-consolidation-receipt`。
- [ ] 更新 TodoList 第 0 至 17 节的执行结果和 disposition 第 9 节。
- [ ] 在 disposition 中记录 integration merge SHA、pre-cleanup bundle SHA-256、清理结果和残余风险。
- [ ] 提交 `docs: record repository consolidation completion`。
- [ ] 推送 receipt 分支并创建 docs PR。
- [ ] 等待 docs PR CI 通过后合入 `main`。
- [ ] fetch 远端并将本地 `main` fast-forward 到 `origin/main`。
- [ ] 删除本地和远程 `docs/repository-consolidation-receipt`。
- [ ] 创建 annotated tag `archive/repository-consolidation/completed-20260817`，指向当前 `main`。
- [ ] 推送 completion tag。
- [ ] 运行 `git bundle create "$BACKUP_DIR/ai-x-repository-consolidation-final-main-20260817.bundle" main --tags`。
- [ ] 验证 final-main bundle，并确认 completion tag 可读。
- [ ] 将最终 `main`、tag、branch、stash 和 worktree 状态写入 `$BACKUP_DIR/final-repository-state.txt`。
- [ ] 重新生成并复核 `$BACKUP_DIR/sha256.txt`，不得修改 pre-cleanup bundle。
- [ ] 从 final-main bundle 执行第二次独立 clone 恢复演练。
- [ ] `git status --short` 无输出。
- [ ] `git worktree list` 只包含根目录。
- [ ] `git branch --no-merged main` 不包含待清理开发分支。
- [ ] `git stash list` 不包含本次整合内容。
- [ ] 本地 `main` 与 `origin/main` 指向一致。
- [ ] 四个来源 archive tag 和 completion tag 在远端可见。
- [ ] 远端 integration 和 receipt 分支均已删除。
- [ ] pre-cleanup bundle 可以恢复被删除的 refs，SHA-256 复核通过。
- [ ] final-main bundle 可以恢复最终 `main` 和 completion tag，SHA-256 复核通过。
- [ ] 两次独立 clone 恢复演练通过。
- [ ] `pnpm quality` 通过。
- [ ] Web production build 通过。
- [ ] disposition 覆盖 v4 根 WIP 分包与 run-input 保全、19 个 M1 提交、14 个 stash tracked 文件、25 个 stash untracked 文件和 4 个 archive 条目。
- [ ] disposition 已由非原执行者复核。
- [ ] 仓库外最终收据记录最终 main SHA、两份 bundle SHA-256、清理结果和残余风险。
