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
RESTORE_DIR="${TMPDIR:-/tmp}/ai-x-repository-consolidation-20260817-restore-drill"
export REPO_ROOT BACKUP_DIR RESTORE_DIR
```

- [x] 确认 `REPO_ROOT` 是当前仓库根目录。结果：`$REPO_ROOT` 由 `git rev-parse --show-toplevel` 解析。
- [x] 确认 `BACKUP_DIR` 在当前 Git 仓库外，位于持久化文件系统。结果：`$BACKUP_DIR` 按上述规则构造，紧急捕获可写、可读且校验通过。
- [x] 将最终 `BACKUP_DIR` 变量化路径写入 disposition 元数据。结果：disposition 第 1 节已记录。
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

- [x] 从当前 `main` 创建 `rescue/main-consolidation-wip-20260817`。结果：分支创建于 `c599e69`。
- [x] 只暂存三份计划文档。结果：staged path-set 精确匹配。
- [x] 检查 staged diff 后提交 `docs: plan repository consolidation`，记录 commit SHA。结果：`2343ff1`。
- [x] 只暂存 13 个 Skill Evaluation / KB 文件。结果：路径集精确匹配 disposition 2.1。
- [x] 检查 staged diff，确认没有 Control、Web、archive 或 stash 内容。结果：PASS。
- [x] 提交 `feat: complete KB-aware skill evaluation follow-up`，记录 commit SHA。结果：`89456c5`。
- [x] 只暂存 8 个 Control API / Control Plane / Web Flow 文件。结果：路径集精确匹配 disposition 2.1。
- [x] 检查 staged diff，确认没有 Skill Evaluation、KB、archive 或 stash 内容。结果：PASS。
- [x] 提交 `fix: preserve current control flow recovery`，记录 commit SHA。结果：`baccefd`。
- [x] 只暂存 20 个 tracked 和 4 个未跟踪的 Real Multimodal Execution Hardening 源码/测试文件，并加入只忽略本地 `run-inputs/` 的最小 `.gitignore` 规则。结果：25-file commit，四张图片未暂存。
- [x] 检查 staged diff，确认没有 Skill Evaluation / KB、Control / Web、archive、stash 或四个二进制图片。结果：PASS。
- [x] 提交 `fix: preserve real multimodal execution hardening`，记录 commit SHA。结果：`3b28f0a`。
- [x] 确认四个 `run-inputs` 图片仍在本地且 SHA-256 与 `$BACKUP_DIR/root-untracked` 一致。结果：4/4 `cmp` 逐字节一致，checksum PASS。
- [x] 确认 rescue 分支依次包含 docs、Skill Evaluation / KB、Control / Web、Real Multimodal Execution Hardening 四个独立提交。结果：`2343ff1` → `89456c5` → `baccefd` → `3b28f0a`。
- [x] 用临时文件创建刷新后的 bundle，验证通过后原子替换初始 bundle。结果：bundle verify PASS。
- [x] 用 `git bundle list-heads` 确认刷新后的 bundle 包含四个 archive tag 和 `rescue/main-consolidation-wip-20260817`。结果：5/5 refs 可读。
- [x] 重新生成并复核 `$BACKUP_DIR/sha256.txt`。结果：从 `$BACKUP_DIR` 执行复核全部 OK；bundle SHA-256 `6de8573f8b63169bb8f37e435c530dc63642be08cc7d388b1f6b679de01ef6ed`。
- [x] 切回 `main`。结果：根 worktree 位于 `main`。
- [x] 确认 `main` 工作区 clean。结果：本地 `run-inputs/` 和用户确认不跟踪的 `wiki/` 通过 `.git/info/exclude` 隔离，`git status --short` 无输出。

### 门禁 2

- [x] 三份计划文档已进入独立 docs commit。结果：`2343ff1`。
- [x] 13 个 Skill Evaluation / KB 文件已进入独立 rescue commit。结果：`89456c5`。
- [x] 8 个 Control / Web 文件已进入另一个独立 rescue commit。结果：`baccefd`。
- [x] 24 个 Real Multimodal 源码/测试文件和最小 `.gitignore` 规则已进入第三个独立业务 rescue commit。结果：`3b28f0a`。
- [x] 四个真实输入图片未进入 Git history，仓库外副本和本地保留文件一致。结果：PASS。
- [x] 刷新后的 bundle 可以恢复 archive tag 和完整 rescue 分支。结果：bundle verify/list-heads PASS。
- [x] `main` clean，且没有未跟踪文件。结果：PASS（本地保留目录由 repository-local exclude 隔离）。

## 4. 同步远端基线

- [x] 执行 `git fetch --prune --tags origin`。结果：PASS。
- [x] 记录 `git rev-parse origin/main`。结果：`1ff951cd9dee667601009c3ccf38ef7c39df7158`。
- [x] 记录远程 branch 和 tag 清单。结果：已写入备份状态收据。
- [x] 确认 `origin/main` 仍为 `1ff951cd9dee667601009c3ccf38ef7c39df7158`。结果：PASS。
- [x] 确认远端没有与四个 archive tag 冲突的引用。结果：PASS。
- [x] 如果 `origin/main` 已移动，停止并重新计算祖先关系、patch 等价和冲突结果。结果：未触发。

### 门禁 3

- [x] 远端基线已刷新并记录。结果：PASS。
- [x] 当前分支分类仍然成立。结果：PASS。

## 5. 创建整合 worktree

- [x] 从 clean `main` 创建 `integrate/repository-consolidation`。结果：PASS。
- [x] 创建 `.worktrees/repository-consolidation`。结果：PASS。
- [x] 确认整合 worktree clean。结果：创建后 clean。
- [x] 记录 Node、pnpm 和 PostgreSQL CLI 版本。结果：Node `v22.22.1`、pnpm `9.12.1`、psql `18.3`。
- [x] 确认 Node 满足 `>=22`，pnpm 使用 `9.12.1`。结果：PASS。
- [x] 在 clean `main` 基线上运行 `pnpm quality`。结果：1023 tests、1012 pass、11 skip、0 fail。
- [x] 在 clean `main` 基线上运行 `pnpm --dir apps/web build`。结果：PASS。

### 门禁 4

- [x] 基线 quality 通过。结果：PASS。
- [x] 基线 Web build 通过。结果：PASS。
- [x] 如果基线失败，停止整合并记录失败与当前主线责任归属。结果：未触发。

## 6. 整合四个 rescue commit

- [x] cherry-pick docs plan commit。结果：`d3b17a3`。
- [x] cherry-pick Skill Evaluation / KB commit。结果：`4bd4d50`。
- [x] 运行 `pnpm exec tsx --test tests/kb-compare.test.ts tests/kb-retriever.test.ts tests/kb-snapshot.test.ts tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts`。结果：113 pass、0 fail；兼容性修正 `917bae7`。
- [x] 运行 `pnpm typecheck`，记录结果。结果：PASS。
- [x] cherry-pick Control API / Control Plane / Web Flow commit。结果：`6404a2e`。
- [x] 运行 `pnpm exec tsx --test tests/control-api-integration.test.ts tests/current-flow-state.test.ts`。结果：32 pass、0 fail；边界修正 `682d336`。
- [x] 运行 `pnpm typecheck`，记录结果。结果：PASS。
- [x] cherry-pick Real Multimodal Execution Hardening commit。结果：`9a1c5d4`。
- [x] 运行 `pnpm exec tsx --test tests/gateway-llm-receipt.test.ts tests/llm-input-compactor.test.ts tests/visual-input-materializer.test.ts tests/capability-resolver.test.ts tests/control-clarification.test.ts tests/current-deliverable-service.test.ts tests/lease-execution-engine.test.ts tests/plan-compiler.test.ts tests/report-review-service.test.ts tests/requirement-refinement-service.test.ts`。结果：171 tests、170 pass、1 skip、0 fail；对齐提交 `326d7ed`。
- [x] 运行 `pnpm typecheck`，记录结果。结果：PASS。
- [x] 运行 `pnpm quality`。结果：1077 tests、1066 pass、11 skip、0 fail；linter/typecheck PASS。
- [x] 记录测试数量、通过数量、跳过数量和失败数量到 disposition 第 7 节。结果：已记录。
- [x] 确认四个提交未夹带分支清理或 M1 内容。结果：path-set 与提交历史审计 PASS。

### 门禁 5

- [x] 四个 rescue commit 保持独立可回滚。结果：PASS；整合兼容修正均为独立 follow-up commits。
- [x] Skill Evaluation、KB、Control API、Current Flow 和 Real Multimodal 定向测试通过。结果：PASS。
- [x] full quality 通过。结果：PASS。

## 7. 迁移 archive/local 测试不变量

- [x] 对照当前测试确认 recovery 隔离断言是否已经覆盖。结果：当前测试已有更强覆盖。
- [x] 缺失时将 recovery 隔离断言迁入 `tests/execution-recovery.test.ts`；已覆盖时记录 `covered-by-main` 证据。结果：`tests/execution-recovery.test.ts` recovery controller/terminal artifact 隔离测试覆盖。
- [x] 对照当前测试确认 DAG wave 调度断言是否已经覆盖。结果：当前测试已有覆盖。
- [x] 缺失时将 DAG wave 调度断言迁入 `tests/execution-scheduler.test.ts`；已覆盖时记录 `covered-by-main` 证据。结果：topological waves 与并行执行测试覆盖。
- [x] 对照当前测试确认 retry lineage 与 receipt 断言是否已经覆盖。结果：发现非空 `retryOf` 传播缺口。
- [x] 缺失时将断言迁入当前最接近的 lease 或 tool 测试；已覆盖时记录 `covered-by-main` 证据。结果：迁入 `tests/tool-provenance.test.ts`，同时断言 adapter 输入和 receipt。
- [x] 确认测试使用当前公开接口，不复制旧实现类型。结果：仅使用 `ToolAdapter`/`ToolRouter` 当前公开接口。
- [x] 运行 `pnpm exec tsx --test tests/execution-recovery.test.ts tests/execution-scheduler.test.ts tests/lease-execution-engine.test.ts`，不存在的目标文件按最终迁移位置替换并记录完整命令。结果：实际加入 `tests/tool-provenance.test.ts tests/tool-retry-policy.test.ts`；85 tests、84 pass、1 skip、0 fail。
- [x] 运行 `pnpm typecheck`。结果：PASS。
- [x] 有代码变化时提交独立的 archive test preservation commit。结果：`2338c93`。
- [x] 更新 disposition 第 3 节的四个 archive 条目。结果：已更新，0 个 `unreviewed`。

### 门禁 6

- [x] archive/local 的四个条目都有结论和证据。结果：3 `archived` + 1 `forward-ported`。
- [x] 三个行为不变量已前移或有当前覆盖证据。结果：PASS。

## 8. 建立 M1 commit disposition

- [x] 为 `869ee2c` 记录最终结论、当前目标和验证证据。结果：recovery/预筛/输入约束 `covered-by-main`；旧 shell/browser/secret injection 与 inline material 路径 `archived`。
- [x] 为 `0f78f85` 记录最终结论、当前目标和验证证据。结果：Tavily `covered-by-main`；未证明的 JD Product/Joyspace 与 active fake-O2 合同 `archived`。
- [x] 为 `15e0b79` 记录最终结论、当前目标和验证证据。结果：受支持能力自检与 smoke 意图 `covered-by-main`；legacy API/report polling 脚本 `archived`。
- [x] 为 `302f88e` 记录最终结论、当前目标和验证证据。结果：`.env.bak*` 防误提交 `covered-by-main`；六份时点报告/HANDOFF `archived`。
- [x] 为 `f6b8ffe` 记录最终结论、当前目标和验证证据。结果：fake O2 不得冒充生产能力的意图 `covered-by-main`；物理删除 O2 与 blanket fixture 改写 `archived`。
- [x] 为 `3b43b48` 记录最终结论、当前目标和验证证据。结果：能力筛选、可追溯规划期 KB guidance 与 progress `covered-by-main`；raw index 注入和旧 Tool requirements `archived`。
- [x] 为 `d12f38f` 记录最终结论、当前目标和验证证据。结果：外部仓库/生成物 ignore `covered-by-main`；外部 2C drift 与 legacy API E2E `archived`。
- [x] 为 `e1a6c98` 记录最终结论、当前目标和验证证据。结果：`archived`；2C 方案与首验报告仅作历史证据。
- [x] 为 `5eec19a` 记录最终结论、当前目标和验证证据。结果：六 Skill 批量质量评估意图 `covered-by-main`；legacy API plan→report harness `archived`。
- [x] 为 `c11651e` 记录最终结论、当前目标和验证证据。结果：`archived`；六 Skill 批次快照可由 tag/bundle 恢复。
- [x] 为 `d99fd6d` 记录最终结论、当前目标和验证证据。结果：18 个主域 `covered-by-main`；三个合法次级域 `forward-ported` 到 `227d951`；非法 universal `cross_cutting` 与 legacy batch 超时调整 `archived`。
- [x] 为 `73ee4c6` 记录最终结论、当前目标和验证证据。结果：route pool/failover/model receipt `covered-by-main`；Kimi/Gemini 专用协议与一次性 smoke `archived`。
- [x] 为 `a02ee42` 记录最终结论、当前目标和验证证据。结果：provider/非法生成 JSON 的安全诊断字符串 `covered-by-main`；Gemini max-token tuning/debug/two-model smoke `archived`。
- [x] 为 `b9aea74` 记录最终结论、当前目标和验证证据。结果：编排上限 `forward-ported` 到 `d203716`；DAG 排序 `covered-by-main`；legacy HTML report 路径 `archived`。
- [x] 为 `8af75d7` 记录最终结论、当前目标和验证证据。结果：`archived`；不恢复 GPT-5.4/GPT-5 旧默认。
- [x] 为 `d7010c1` 记录最终结论、当前目标和验证证据。结果：`archived`；旧盲评招募包不是当前 gate。
- [x] 为 `55bdf0e` 记录最终结论、当前目标和验证证据。结果：`covered-by-main`；candidate schema 对 assumptions fail closed。
- [x] 为 `8e49c6b` 记录最终结论、当前目标和验证证据。结果：`archived`；旧 HANDOFF 仅历史快照。
- [x] 为 `44a2893` 记录最终结论、当前目标和验证证据。结果：按 G1–G8 和行为范围拆分为 1 `forward-ported`、4 `covered-by-main`、6 `archived`；92/92 paths 守恒，旧 ledger/renderer、per-role media/assetId transport、跨调用熔断、三套 lab 控制器、旧 UI/DB warn 等均明确归档。
- [x] 确认没有 `ignored` 或空白结论。结果：按行为范围共 17 `covered-by-main`、24 `archived`、3 `forward-ported`；0 `unreviewed`。

## 9. 前移 M1 Runtime 与 Tool 行为

- [x] 对照当前 Tool adapter，确认故障隔离是否已覆盖。结果：Current adapter 资格校验、core/optional 故障语义与 lease fence 更严格。
- [x] 对照当前 receipt，确认 attempt、retry 和 implementation identity 是否已覆盖。结果：attempt receipts、`retryOf` 与 implementation identity 均有测试；lineage 补强在 `2338c93`。
- [x] 对照当前 Gateway client，确认错误处理和模型漂移门禁是否已覆盖。结果：429/503 failover、错误分类、requested↔actual pin 与 receipt fail closed 已覆盖。
- [x] 对照当前 Planner，确认 assumptions 输入防御是否已覆盖。结果：candidate schema 强制数组并拒绝非法形状。
- [x] 对照当前 Planner，确认编排收敛约束是否已覆盖。结果：depth≤8、speed≤4；一次 repair 后仍超限即失败。
- [x] 检查 JD Product Search 合同，决定前移或归档并记录证据。结果：未证明且不在 Current active registry，`archived`。
- [x] 检查 Joyspace Search 合同，决定前移或归档并记录证据。结果：未证明且不在 Current active registry，`archived`。
- [x] 检查 Tavily 合同，确认当前实现是否更严格。结果：active/core、真实 adapter 资格与 source proof 更严格。
- [x] 不恢复 Kimi、Gemini 或旧模型默认配置。结果：PASS；保留当前 OpenAI-compatible route pool 与 GPT-5.5 pin。
- [x] 不删除当前仍在使用的 `o2-web-search`，除非当前 Registry 已明确移除且测试通过。结果：保留为 draft/optional；未删除。
- [x] 为所有前移行为增加或复用定向测试。结果：`tests/plan-compiler.test.ts` 补 exact-limit、repair 和 fail-closed 覆盖；`tests/capability-resolver.test.ts` 用生产 Registry 覆盖三个次级 task route；其他合同复用当前相关测试。
- [x] 在 disposition 第 7 节记录完整定向测试命令和结果。结果：记录 `d203716` 的 31-pass 命令、`868d752` 的 42-pass 命令及 `227d951` 的 12-pass 命令；删除无命令收据支持的“63 pass”描述。
- [x] 运行 `pnpm lint:registry`。结果：PASS。
- [x] 运行 `pnpm lint:knowledge`。结果：PASS。
- [x] 运行 `pnpm typecheck`。结果：PASS。
- [x] 有代码变化时提交独立的 M1 Runtime / Tool commit。结果：`d203716`；独立审计发现的三项次级路由由 follow-up `227d951` 修复。

### 门禁 7

- [x] Runtime / Tool 工作包可独立回滚。结果：独立 commits `d203716`、`227d951`。
- [x] 未引入第二套 Tool 或 Gateway 生产入口。结果：PASS。
- [x] 相关定向测试和 linter 通过。结果：planner 31 pass、resolver 12 pass、0 fail；两 linter 与 typecheck PASS。

## 10. 前移 M1 Evidence、Report 与合同

- [x] 对照 Current Evidence 检查旧 evidence ledger 行为。结果：旧 ledger 会形成第二事实源，不前移。
- [x] 对照 Current Manifest 检查旧 evidence source 和 pointer 行为。结果：Current 只从成功的真实 Tool Artifact/source proof 构建 Manifest，约束更严格。
- [x] 对照 Current Deliverable 检查旧 report blueprint 行为。结果：Current Deliverable + FindingGraph 覆盖，不恢复 blueprint 入口。
- [x] 对照 Current ReportDocument 检查旧 renderer 和 synthesis 行为。结果：Current ReportDocument/composer/materializer 为唯一生产路径；v1/v2 Skill Artifact 可读，未知版本拒绝。
- [x] 检查 `schemas/skill-result-envelope.schema.json` 的合同是否仍缺失。结果：缺失；已在 `d39d29f` 前移为 `skill-output-v2`，不含 `evidence`/`evidence_refs`/failed 状态。
- [x] 检查五个 KB skill output schema 是否仍缺失。结果：缺失；五个 payload schema 已在 `d39d29f` 前移并由 build 自动登记。
- [x] 当前实现更严格时标记为 `covered-by-main`，并引用测试。结果：旧 ledger/report/renderer 行为不前移；Current Evidence/Report 测试覆盖更严格事实链。
- [x] 缺失且兼容的合同按当前模块边界前移。结果：`d39d29f` 前移统一 envelope、五个 KB payload、`/payload` pointer、v2 artifact 与分离 provenance；`ff5fd0c` + `0fce0d5` 补齐 competitive app payload 并拒绝未绑定 evidence 引用。
- [x] 不恢复旧 report 模块为第二套生产入口。结果：PASS；Tool→EvidenceManifest→FindingGraph→Deliverable→ReportDocument 保持唯一事实链。
- [x] 在 disposition 第 7 节记录完整定向测试命令和结果。结果：`d39d29f` 的 14 文件命令 261 tests、260 pass、1 skip、0 fail；app payload 三文件命令 14/14 PASS。
- [x] 运行 `pnpm lint:registry`。结果：PASS。
- [x] 运行 `pnpm lint:knowledge`。结果：PASS。
- [x] 运行 `pnpm typecheck`。结果：PASS。
- [x] 有代码变化时提交独立的 M1 Evidence / Report commit。结果：`d39d29f`（31 paths）、`ff5fd0c` + `0fce0d5`（app payload follow-up）；均无 docs/wiki。

### 门禁 8

- [x] Evidence / Report 工作包可独立回滚。结果：独立 commits `d39d29f`、`ff5fd0c`、`0fce0d5`。
- [x] Current 仍是唯一生产交付链。结果：PASS；EvidenceManifest 显式不引用 Skill Artifact。
- [x] schema、linter 和定向测试通过。结果：Gate 8 主命令 261 tests、260 pass、1 skip、0 fail；app payload follow-up 14/14 PASS；两 linter、typecheck、双次 KB build 幂等 PASS。

## 11. 非破坏性恢复并处理 stash

- [x] 从 `archive/repository-consolidation/m1-stash-20260817^1` 创建 `rescue/m1-stash-20260817`。结果：分支创建于 `44a2893`，未修改 integration 历史。
- [x] 创建独立 stash rescue worktree。结果：`.worktrees/m1-stash-rescue`，保持未提交恢复态供审计。
- [x] 保存 apply 前的 status、index diff、tracked diff 和 untracked 清单。结果：`$BACKUP_DIR/stash-rescue/before-apply.txt`。
- [x] 运行 `git stash apply --index archive/repository-consolidation/m1-stash-20260817`。结果：PASS；非破坏性 apply。
- [x] 禁止运行 `git stash pop`。结果：未运行；原 stash 保留。
- [x] 保存 apply 后的 status、index diff、tracked diff 和 untracked 清单。结果：`$BACKUP_DIR/stash-rescue/after-apply.txt`。
- [x] 核对 14 个 tracked 文件全部恢复。结果：14/14 与 stash commit 相对第一父提交的内容逐字节一致。
- [x] 核对第三父提交中的 25 个 untracked 文件全部恢复。结果：25/25 与第三父 tree 逐字节一致。
- [x] 对 14 个 tracked 文件逐项更新 disposition 第 5 节。结果：4 `covered-by-main`、2 `forward-ported`、8 `archived`。
- [x] 对 25 个 untracked 文件逐项更新 disposition 第 6 节。结果：4 `covered-by-main`、3 `forward-ported`、18 `archived`。
- [x] 前移 execution state hardening 行为。结果：`b881feb` 在任何 gate 写入前递归校验视觉 `dataUrl` 的 canonical base64、MIME、10MiB/20MP、图片结构与完整像素解码，物化前先校验全部 gates。
- [x] 前移仍有效的 feedback、repository 和 replay 行为。结果：Repository 原子状态行为由 Current Control Plane 覆盖；feedback 无 Current consumer 且 legacy mutation 为 410；旧 replay/report 会形成第二事实链，后两者均归档。
- [x] 前移 API integration 和 execution state machine 测试。结果：completed task `/resume` HTTP 409 与视觉输入失败零 gate/零迁移断言前移；Current 并发 claim/终态执行已有覆盖。
- [x] 检查 `vision-brand-vlm-failover-smoke`，记录前移或归档证据。结果：脚本要求的 fallback/model/attempts 合同无 Current producer/consumer，属于 hollow smoke；由 `56b5978` 删除并标记 `archived`，tag/bundle 可恢复。
- [x] 将旧 wiki、HANDOFF 和 helloagents 过程材料标记为 `archived`。结果：全部仅由 stash annotated tag 和已验证 pre-cleanup bundle 保存；未前移任何 `helloagents/wiki/` 或本地 `wiki/` 内容。
- [x] 在 disposition 第 7 节记录完整定向测试命令和结果。结果：Gate 9 最终 6 文件命令 91 pass、0 fail；typecheck 与 Web build PASS。
- [x] 运行 `pnpm typecheck`。结果：PASS。
- [x] 有代码变化时提交独立的 stash forward-port commit。结果：`b881feb`（10 paths；无 consolidation docs/wiki）。
- [x] 确认原 `stash@{0}` 仍存在且 SHA 未变化。结果：stash 与 archive tag peel 均为 `945ff6c00f7d06a6d32399a9817a09a01b2b6aa2`。

### 门禁 9

- [x] stash tracked 和 untracked 内容全部有 disposition。结果：14 tracked + 25 untracked 全覆盖，0 `unreviewed`。
- [x] stash 前移提交可独立回滚。结果：独立 commit `b881feb`。
- [x] stash tag 和 bundle 可以完整恢复原内容。结果：rescue apply 14/14 + 25/25 精确恢复；annotated tag 与已验证 pre-cleanup bundle 可读。
- [x] stash 中不存在尚未处置且必须进入主线的唯一行为或文件。结果：有效不变量已前移/由 Current 覆盖；孤儿 VLM smoke 等唯一历史文件均明确 `archived`，由 tag + bundle 保留。

## 12. 固化 disposition 和离线验证

- [x] 确认 disposition 第 3 至 6 节不存在 `unreviewed`、空白结论或 `ignored`。结果：0 个非法/空结论；Markdown table audit 0 error。
- [x] 确认每个 `forward-ported` 条目都有目标 commit 和测试。结果：PASS。
- [x] 确认每个 `covered-by-main` 条目都有当前实现位置和等价证据。结果：PASS。
- [x] 确认每个 `archived` 条目都有 tag、bundle 和不前移理由。结果：PASS；bundle verify/list-heads/SHA-256 均复核。
- [x] 更新 disposition 第 7 节的工作包验证收据。结果：补齐 `868d752`、`ff5fd0c` + `0fce0d5`、`56b5978`、`227d951` 与最终 Gate 10 收据。
- [x] 运行 `git diff --check`。结果：PASS。
- [x] 运行 `pnpm quality`。结果：1094 tests、1083 pass、11 skip、0 fail；typecheck、registry linter、knowledge linter PASS。
- [x] 运行 `pnpm --dir apps/web build`。结果：PASS；647 modules transformed；仅既有 >500 kB chunk warning。
- [x] 运行 `git fsck --full`。结果：exit 0；仅报告可接受的 dangling objects。
- [x] 记录最终测试数量、通过数量、跳过数量和失败数量。结果：已写入 disposition 第 7 节。
- [x] 检查提交历史，确认每个业务工作包独立可回滚。结果：新增次级路由修复独立为 `227d951`；其余工作包边界保持不变。
- [x] 仅暂存两份 consolidation 文档并提交 `docs: record repository consolidation disposition`。结果：本 Gate 10 提交；staged path-set 精确为两份文档，无 `wiki/`。
- [x] 确认整合 worktree clean。结果：Gate 10 提交后核验 clean。

### 门禁 10

- [x] 离线 quality 通过。结果：1094 tests、1083 pass、11 skip、0 fail。
- [x] Web production build 通过。结果：647 modules transformed，PASS。
- [x] disposition 已形成独立审计提交。结果：本 Gate 10 docs-only commit；第 4 节由 gate10_docs_audit 独立逐行为签署。

## 13. 条件性真实 Smoke

- [x] 判断工作包 6 的 Real Multimodal WIP，以及工作包 9、10、11 是否修改真实 Gateway、Tavily、Tool receipt、Evidence 或 Current Report 路径。结果：已修改上述生产路径，真实 Smoke 必须触发。
- [x] 如果没有修改，记录“不触发真实 Smoke”及 diff 证据。结果：不适用；生产路径已修改，不能用“不触发”替代真实证据。
- [ ] 如果有修改，确认受控 PostgreSQL 测试库可用。结果：仅验证了隔离测试库，未形成受控真实 Smoke 数据库收据。
- [ ] 如果有修改，安全注入 `DATABASE_URL` 和 `JWT_SECRET`。
- [ ] 如果有修改，安全注入 LLM Gateway 配置和密钥。
- [ ] 如果有修改，安全注入 `TAVILY_API_KEY`。
- [ ] 如果有修改，运行 `pnpm db:migrate`。
- [ ] 如果有修改，运行 `pnpm db:seed`。
- [ ] 如果有修改，运行 `ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm smoke:current:real`。结果：`HOLD`，未运行；入口现已覆盖 5/5 profile，并有非 PR、secrets 齐全才执行的顺序 CI job，但本地和 CI 均没有真实收据。
- [ ] 确认日志和 Artifact 不包含密钥、Bearer token 或完整 prompt。结果：没有可供审计的真实运行日志或 Artifact。
- [ ] 将 task、plan、attempt、deliverable 标识和结果写入 disposition 第 7 节。结果：0 个真实 task/plan/attempt/Report Package 标识。
- [ ] 提交真实 Smoke 证据更新；未触发时提交不触发证据。结果：未满足；真实门禁已触发且没有有效收据。
- [x] 将 Semantic Gold 的 25 个场景改为由 scenario-driven mock LLM 进入真实 `RequirementRefinementService`，需要澄清的场景实际执行 `understand → clarify`，再走真实 deliverable、Evidence、capability 与 scheduler seam。结果：6/6 PASS；不把 mock 结果记为真实 Gold。
- [x] 完成五 profile Real Smoke 与 CI 代码门禁。结果：`competitive_research`、`user_research_planning`、`voc_diagnosis`、`design_audit`、`a11y_audit` 均有入口；Design 使用绝对本地 JPEG/PNG/WebP 路径；CI 缺任一必需 secret 即跳过，齐全时 migrate + seed、启动三个设计 lab 并顺序执行五 profile。
- [x] 收紧 Gold runner 的 Report Package、reviewer 与 slot 合同。结果：collect/review/decide 分阶段；infra retry 不再伪造 attempt ID；最终决定重新验证 Package，并要求每个真实 slot 恰好一条 review；`trusted_gold_enabled` 仍为 `false`。
- [x] 完成 Gate 11 离线硬化与分层回归。结果：Semantic/Smoke/Gold 定向回归通过；`pnpm quality` 1197 total、1186 pass、11 skip、0 fail；Web build 648 modules PASS；CI YAML parse 与排除 `wiki/` 的 diff-check PASS。全量回归首次发现 `plan-compiler` design fixture 未注册新增 Tavily 依赖，稳定红态后补齐 fixture，定向 1/1 与最终全量均通过。
- [x] 完成独立只读复核。结果：`gate11_diff_review` 曾报告 0 P0、7 P1；本轮已逐项收紧相应代码合同，但最新整合提交 `29bd26e` 尚未再次独立复核，且整体 Gate 11 仍因真实证据缺失保持 `HOLD`。

### 门禁 11

- [ ] 条件性真实门禁已通过或有明确不触发证据。结果：`HOLD`；代码入口已覆盖五 profile，但仍没有五 profile 真实收据，可信 Gold policy 仍关闭，也没有三次真实 attempt 与独立人工评审证据。
- [x] 固定门禁边界。结果：不得进入门禁 12，不得推送、创建 PR 或把离线测试写成真实 Smoke 证据。

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
