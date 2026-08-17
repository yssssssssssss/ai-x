# 仓库整合 Disposition 记录

> 状态：v4 执行中；门禁 0–10 已通过，门禁 11 待执行。
>
> 对应开发文档：`docs/plans/2026-08-17-repository-consolidation-development.md`
>
> 对应 TodoList：`docs/plans/2026-08-17-repository-consolidation-todolist.md`
>
> 规则：本文件是来源处置和验证证据的唯一真相源。TodoList 勾选不能代替本文件。执行期间允许临时状态 `unreviewed`，最终门禁前必须全部替换为 `forward-ported`、`covered-by-main` 或 `archived`。

## 1. 执行元数据

| 字段 | 值 |
|---|---|
| 执行者 | Codex（主执行 Agent） |
| 独立复核人 | 未填写 |
| 开始时间 | `2026-08-17T15:50:16Z`（v4 冻结首轮采样） |
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
| bundle SHA-256 | `6de8573f8b63169bb8f37e435c530dc63642be08cc7d388b1f6b679de01ef6ed`（rescue commits 后刷新的 pre-cleanup bundle；最终清理前仍须再次刷新） |
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
| 三份 repository consolidation 计划文档 | 3 untracked | `preserve-to-rescue` | rescue `2343ff1`；integration `d3b17a3` | 独立 docs commit；路径集检查通过 |
| Skill Evaluation / KB | 13 tracked | `preserve-to-rescue` | rescue `89456c5`；integration `4bd4d50` | follow-up `917bae7`；113 tests pass、0 fail；typecheck PASS |
| Control API / Control Plane / Web Flow | 8 tracked | `preserve-to-rescue` | rescue `baccefd`；integration `6404a2e` | follow-up `682d336`；32 tests pass、0 fail；typecheck PASS |
| Real Multimodal Execution Hardening | 20 tracked + 4 untracked | `preserve-to-rescue` | rescue `3b28f0a`；integration `9a1c5d4` | follow-ups `3268a62`、`326d7ed`、`3c262f5`；171 tests、170 pass、1 skip、0 fail；typecheck PASS |
| `run-inputs/real-ai-shopping-case/*.jpg` | 4 untracked | `preserve-outside-git` | 本地保留并复制到 `$BACKUP_DIR/root-untracked/`，由本地 exclude 和 Real Multimodal `.gitignore` 隔离 | 4/4 `cmp` 逐字节一致；`sha256.txt` 从 `$BACKUP_DIR` 复核通过；未进入 Git history |

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
| `archive/repository-consolidation/cutover-progress-20260817` | Cutover 进度快照 | `archived` | 当前 Trusted Multimodal Research 进度已取代旧快照 | `git bundle verify "$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle"` PASS；`git bundle list-heads` 含精确 tag | gate10_docs_audit（独立审查 Agent） |
| `archive/repository-consolidation/local-main-wip-20260817` | `doc/项目汇报材料_M1_20260721.md` | `archived` | 历史汇报材料不进入生产主线 | `git show --no-patch` 证明精确 tag 指向 `b0ed2b5`；bundle verify/list-heads PASS | gate10_docs_audit（独立审查 Agent） |
| `archive/repository-consolidation/local-main-wip-20260817` | `docs/agent-orchestrator-replication-guide.md` | `archived` | 旧代码行号和模块边界已失效 | `git show --no-patch` 证明精确 tag 指向 `b0ed2b5`；bundle verify/list-heads PASS | gate10_docs_audit（独立审查 Agent） |
| `archive/repository-consolidation/local-main-wip-20260817` | `tests/final-release-blockers.test.ts` | `forward-ported` | recovery → `tests/execution-recovery.test.ts`；DAG waves → `tests/execution-scheduler.test.ts`；retry lineage/receipt → `tests/tool-provenance.test.ts` | commit `2338c93`；Gate 6 五文件定向命令 85 tests、84 pass、1 skip、0 fail；`pnpm typecheck` PASS | gate10_docs_audit（独立审查 Agent） |

## 4. M1 独有提交处置

本节中的 `M1 archive` 精确指 annotated tag `archive/repository-consolidation/m1-real-capabilities-20260817` 和 `$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle`；`git bundle verify` 与 `git bundle list-heads` 均已通过。混合提交按行为范围拆行，每一行只使用一个合法结论；同一 SHA 的全部行合起来才是该提交的完整处置，不能用其中一行外推整个提交。

| SHA | 处置范围 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|---|
| `869ee2c` | execution recovery、能力预筛、actor/input/视觉入参约束 | `covered-by-main` | `capability-resolver.ts`、`plan-compiler.ts`、`task-workflow.ts`、`visual-input-materializer.ts`、`lease-execution-engine.ts`、`tool-adapter.ts` | capability/plan/task workflow、Tool provenance/retry 与 Gate 9 六文件回归覆盖；Current 对未知 actor fail closed、对视觉输入先验证后落状态 | gate10_docs_audit（独立审查 Agent） |
| `869ee2c` | O2Launch/Webcli/body secret injection、旧 inline text/PDF `user_materials` 与 synthesis summary | `archived` | M1 archive；不恢复无 receipt 的 shell/browser adapter、向请求体注入密钥或 raw data URL prompt 路径 | 这些实现绕过 Current adapter 资格、Artifact 与敏感值边界；当前确认输入走受控物化/压缩，故旧实现只保留历史价值 | gate10_docs_audit（独立审查 Agent） |
| `0f78f85` | Tavily Registry、schema 与真实 adapter | `covered-by-main` | `orchestrator/tool-registry.yaml`、`tools/tavily-web-search/*`、`tool-adapter.ts` | Tavily 为 active/core，真实 adapter 资格、source proof、registry/capability tests 通过 | gate10_docs_audit（独立审查 Agent） |
| `0f78f85` | JD Product、Joyspace 与 active fake-O2 合同 | `archived` | M1 archive；不创建当前不存在且未证明的 `tools/jd-product-search` / `tools/joyspace-search`，不把 O2 fake 升为 active | Current Registry 无前两项；O2 仅 draft/optional；无真实资格和合同测试，故不能声称被 Current 覆盖 | gate10_docs_audit（独立审查 Agent） |
| `15e0b79` | 受支持能力的自检与 Tavily/competitive smoke 意图 | `covered-by-main` | `scripts/current-real-smoke.ts`、`evaluations/skills/run.ts` | Current smoke 对 Gateway/Tavily/当前 Skill 走 fail-closed 真实链；evaluator 有可恢复结果与非零失败退出 | gate10_docs_audit（独立审查 Agent） |
| `15e0b79` | JD、material/upload 与 legacy plan→select→execute→`report.json` 脚本 | `archived` | M1 archive；不恢复五个旧 Control API 一次性脚本 | 源脚本含 always-exit-0、未选 JD 仍成功、marker 失败不退出和轮询工作区文件等 hollow-green 行为；端点/报告合同已失效 | gate10_docs_audit（独立审查 Agent） |
| `302f88e` | `.env.bak` 防误提交规则 | `covered-by-main` | `.gitignore` 的 `.env.bak*` | `rg -n '\.env\.bak' .gitignore` PASS；Current 通配规则比源精确文件名更严 | gate10_docs_audit（独立审查 Agent） |
| `302f88e` | 六份时点评估、完成度与 HANDOFF 文档 | `archived` | M1 archive；不进入当前生产文档 | 报告绑定 2026-07-19/20 的模型、端点和 taskId，只作历史审计证据 | gate10_docs_audit（独立审查 Agent） |
| `f6b8ffe` | fake O2 不得冒充生产能力的安全意图 | `covered-by-main` | `orchestrator/tool-registry.yaml`、`capability-resolver.ts`、Tool preflight | Current 将 O2 保留为 draft/optional，并要求 core Tool 具备 qualified real adapter；Tavily active/core | gate10_docs_audit（独立审查 Agent） |
| `f6b8ffe` | 物理删除 O2 与全量 fixture/SKILL 重命名 | `archived` | M1 archive；不前移删除 | Current 仍保留 O2 草案用于显式 optional 能力；整目录删除和 blanket fixture 改写会抹掉可审计草案 | gate10_docs_audit（独立审查 Agent） |
| `3b43b48` | task-type 能力筛选、规划期 KB guidance 与 planning progress | `covered-by-main` | `capability-resolver.ts`、`routed-planner.ts`、Control planning SSE | Current 用 canonical `task_types`、Tool 健康/资格、pending input 做严格筛选；规划期按节点召回 KB guidance 并持久化 provenance | gate10_docs_audit（独立审查 Agent） |
| `3b43b48` | raw research-wiki index 注入生产 Skill、旧 JD/Joyspace requirements | `archived` | M1 archive；不恢复无 snapshot/source hash 的整段索引 prompt 或未登记 Tool | Current 生产 Skill context 不含 KB；KB grounding 仅在可追溯 evaluator 中。此为明确能力差异，旧注入因缺 provenance/citation gate 不兼容 | gate10_docs_audit（独立审查 Agent） |
| `d12f38f` | 嵌套外部仓库和生成物 ignore | `covered-by-main` | `.gitignore` | `external-tools/users-research-all/` 与 `apps/web/dist/` 均由 Current ignore 覆盖 | gate10_docs_audit（独立审查 Agent） |
| `d12f38f` | 外部 2C source-vs-KB drift 与 legacy User Research API E2E | `archived` | M1 archive；不恢复 `sync-2c-kb.mjs` / `test-user-research-interview.ts` | Current KB build 只构建仓内事实源；源脚本依赖外部目录、旧 API、raw KB 注入和 `report.json` 轮询，不能作为 Current gate | gate10_docs_audit（独立审查 Agent） |
| `e1a6c98` | 2C DesignWiki 方案与 2026-07-20 首验报告 | `archived` | M1 archive；仅保留历史证据 | 文档绑定旧 research-wiki 注入与一次性真实运行，不是 Current 生产合同 | gate10_docs_audit（独立审查 Agent） |
| `5eec19a` | 六 Skill 批量质量评估意图 | `covered-by-main` | `evaluations/skills/run.ts`、`evaluations/skills/cases/` | Current evaluator 支持隔离、恢复、非零失败、KB round 和结构化收据；相关 runner tests 通过 | gate10_docs_audit（独立审查 Agent） |
| `5eec19a` | legacy 六 Skill API plan→select→execute→report harness | `archived` | M1 archive；不恢复 600 秒轮询脚本 | Current evaluator 直接评估 Skill，real smoke 只覆盖当前真实能力；两者不等价于旧 Control API harness，故明确归档而非假称覆盖 | gate10_docs_audit（独立审查 Agent） |
| `c11651e` | M1-D+ 六 Skill 批次报告 | `archived` | M1 archive；当前重复执行真相源为 `evaluations/skills/` | 报告是时点 taskId/事故记录，不是可执行 gate | gate10_docs_audit（独立审查 Agent） |
| `d99fd6d` | 18 个 Skill 的主域映射语义 | `covered-by-main` | `orchestrator/skill-registry.yaml`、`capability-resolver.ts` | Current 用五种 canonical `task_types` 取代 `domain`，18 个源 Skill 的主域均保留并逐 Skill fail closed | gate10_docs_audit（独立审查 Agent） |
| `d99fd6d` | accessibility→design、usability-test→planning、journey-map→VOC 三个次级域映射 | `forward-ported` | commit `227d951`；`orchestrator/skill-registry.yaml` | 生产 Registry + resolver 回归 12/12 PASS；三项均进入 `eligible`、`rejected` 为空；registry lint/typecheck PASS | gate10_docs_audit（独立审查 Agent） |
| `d99fd6d` | `cross_cutting` 对 18 个 Skill 的全任务泛化路由 | `archived` | M1 archive；Current 不恢复 universal alias | `cross_cutting` 不属于 ResearchTaskV2 五种合法 task type；显式 task_types 避免无证据扩大候选集，回归断言生产 Registry 中不存在该值 | gate10_docs_audit（独立审查 Agent） |
| `d99fd6d` | legacy batch 轮询超时调整 | `archived` | M1 archive；不恢复 `test-skills-batch.ts` 600 秒轮询 | 对已归档 harness 的常数调整没有 Current 生产价值；evaluator 的恢复/超时合同取代它 | gate10_docs_audit（独立审查 Agent） |
| `73ee4c6` | 模型 route pool、429/5xx failover 与 actual-model receipt | `covered-by-main` | `gateway-llm-client.ts`、`receipt-llm-client.ts` | Current 使用显式 route pool、requested↔actual pin 和 receipt；gateway/model receipt tests 通过 | gate10_docs_audit（独立审查 Agent） |
| `73ee4c6` | Kimi/Gemini 双协议与一次性 switch smoke | `archived` | M1 archive；不恢复专用协议/脚本 | Current 只维护 OpenAI-compatible routes；恢复专用协议会扩大未使用分支和测试面 | gate10_docs_audit（独立审查 Agent） |
| `a02ee42` | provider payload 与非法生成 JSON 的诊断字符串健壮化 | `covered-by-main` | `gateway-llm-client.ts`、`receipt-llm-client.ts` | Source delta 仅防止对 undefined 诊断值调用 `.slice`；Current 使用固定 sanitized `capability`/`schema` 错误且不拼接 raw provider payload，gateway/model receipt tests 通过 | gate10_docs_audit（独立审查 Agent） |
| `a02ee42` | Gemini `maxOutputTokens`、debug 与 two-model smoke | `archived` | M1 archive；不恢复 Gemini 专用 tuning | Current 无 Gemini 生产 route；专用参数和脚本只保留历史价值 | gate10_docs_audit（独立审查 Agent） |
| `b9aea74` | depth≤8、speed≤4 与一次 repair 后 fail closed | `forward-ported` | commit `d203716`；`routed-planner.ts`、`current-plan-candidates.schema.json` | `tests/plan-compiler.test.ts` 31 pass；两 linter 与 typecheck PASS | gate10_docs_audit（独立审查 Agent） |
| `b9aea74` | required Tool/Skill/reviewer 排序 | `covered-by-main` | `plan-compiler.ts`、`execution-scheduler.ts` | Current 明确 DAG、拒绝 cycle/missing/late required Tool，并按 topological waves 执行；相关 compiler/scheduler tests 通过 | gate10_docs_audit（独立审查 Agent） |
| `b9aea74` | legacy report prompt、`renderReportHtml` 与 `report.html` 写入 | `archived` | M1 archive；Current 使用 Deliverable→Review→ReportDocument | 源提交甚至引用当时尚不存在的 renderer；旧 HTML 事实链不恢复为第二生产入口 | gate10_docs_audit（独立审查 Agent） |
| `8af75d7` | GPT-5.4/GPT-5 旧默认与 two-model smoke | `archived` | M1 archive；Current 使用 `.env.example` 显式 route pool/actual pin | 时点默认不是长期合同；`rg -n -e 'GPT-5.5' -e 'LLM_MODEL_ROUTES' .env.example` PASS | gate10_docs_audit（独立审查 Agent） |
| `d7010c1` | M1 业务盲评招募包 | `archived` | M1 archive；不作为当前 gate 或生产入口 | 2026-07-20 时点试用/问卷材料仅作历史证据 | gate10_docs_audit（独立审查 Agent） |
| `55bdf0e` | 非数组 `assumptions` 防御 | `covered-by-main` | Current schema + `RoutedPlanner`/`ResearchPlanningService` fail closed | commit `868d752`；`current-plan-candidate-schema.test.ts` 9/9 + `plan-compiler.test.ts` 33/33，object/string 均在返回/持久化前拒绝 | gate10_docs_audit（独立审查 Agent） |
| `8e49c6b` | 旧 HANDOFF | `archived` | M1 archive；不进入 Current 文档 | 文档绑定旧架构、旧 WIP 和旧环境，只保留历史快照 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G1：统一 envelope、六个领域 payload 与 loader/registry 校验 | `forward-ported` | `d39d29f` + `ff5fd0c` + `0fce0d5`；统一 `/payload` 合同 | Gate 8 261 tests（260 pass、1 skip）；app contract 定向 14/14、linter/typecheck PASS；`evidence_refs` 按 Current EvidenceManifest 边界移除并有负例 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G2：legacy ledger/blueprint/synthesis/renderer/replay | `archived` | M1 archive；Current 唯一链为 EvidenceManifest→FindingGraph→Deliverable→Review→ReportDocument | 旧模块会形成第二事实链；Current report/evidence 定向回归已在 Gate 8 收据中通过 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G3：media projection、JPEG/PNG/WebP 校验、受控物化与 LLM input compaction | `covered-by-main` | `artifact-store.ts`、`visual-input-data-url.ts`、`visual-input-materializer.ts`、`llm-input-compactor.ts` | Current 保留源 manifest 的 MIME 白名单，并增加 10MiB/20MP、结构、完整解码、sealed Artifact 和压缩上下文约束；Gate 9 91 pass | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G3：per-role `max_items` 与 assetId-only binary transport | `archived` | M1 archive；不恢复旧 `/media` API 或 per-manifest 数量合同 | 源 manifest 的输入均为 optional/min=0，但 attention 上限 1、vision design/reference 各上限 3；Current 改用 12MB 总请求上限和统一视觉校验，并在 `/confirm` 中保存已验证 data URL。per-role cardinality 与 transport/storage 差异明确归档；新增共享上传合同会扩大 API 边界 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G4：DAG、故障隔离、parallel waves、RestJson retry | `covered-by-main` | `plan-compiler.ts`、`execution-scheduler.ts`、`lease-execution-engine.ts`、`tool-adapter.ts` | Current 使用 frozen DAG、lease fence、分层 retry receipt；compiler/scheduler/retry/provenance tests 通过 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G5：per-call route pool/failover 与 actual model pin | `covered-by-main` | `gateway-llm-client.ts`、`receipt-llm-client.ts` | Current 429/503/transport failover 与模型身份收据有定向测试 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G5：跨调用 circuit breaker/cooldown、model/vision probes | `archived` | M1 archive；不恢复全局 model-health cache 或一次性探针 | 无当前 SLO/观测基线支持跨调用隐藏状态；per-call failover 已满足当前合同，避免增加第二控制器和陈旧健康状态 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G6：三个 external lab 的多模型/VLM failover、degraded/model/attempts 合同 | `archived` | M1 archive；current optional labs 保持单模型+显式 heuristic degradation | 旧实现复制三套 Gateway 控制器且无统一 receipt/model pin；孤儿 failover smoke 已由 `56b5978` 删除，原文件仍可从 tag/bundle 恢复 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G7：topology API、FlowChart/demo 与旧 Web/HTML presentation | `archived` | M1 archive；不恢复第二套拓扑/报告 UI | Current Web 以 Control flow 和 ReportDocument 为唯一入口；旧 topology/demo 无生产消费者 | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G8：ignore 与开发栈生命周期意图 | `covered-by-main` | `.gitignore`、`scripts/dev-stack.ts`、`package.json` | Current 覆盖 `.env.bak*`、`.pids`、Web dist/外部仓库；dev stack 有身份/readiness/清理合同，强于 `dev.sh` | gate10_docs_audit（独立审查 Agent） |
| `44a2893` | G8：DB idle-error warn、旧 supervisor wiring、report demos 与 helloagents 过程计划 | `archived` | M1 archive；不恢复 silent DB degradation 或时点 mockup/过程材料 | 源 listener 在 pool 重建后丢失且只 warn 后继续；Current 保持 crash-only 可见失败。其余为旧启动/演示/过程入口 | gate10_docs_audit（独立审查 Agent） |

### 4.1 `44a2893` 路径覆盖账本

以下八组按源提交的 92 个 changed paths 去重分配；路径有跨域 hunks 时按主组只出现一次，上表再按行为拆分结论。独立脚本比对结果：actual=92、grouped=92、missing=0、extra=0、duplicate=0；无 `wiki/` 路径。

| 组 | 数量 | 源路径集合 |
|---|---:|---|
| G1 contracts/registry | 15 | `runtime/{config-loader,llm-client,skill-loader}.ts`；`harness/linters/registry-linter.ts`；五个 `knowledge-base/skills/*/output.schema.json`；`orchestrator/skill-registry.yaml`；`schemas/skill-result-envelope.schema.json`；`skills/competitive-analysis/app-analysis/output.schema.json`；`tests/{schema,skill-loader-schema,unverified-skill-contracts}.test.ts` |
| G2 evidence/report/replay | 13 | `evidence-ledger.ts`、`report-{blueprint,renderer,synthesis-agent}.ts`、synthesis prompt/research-orchestrator、research-report schema、replay script，以及五个对应 evidence/report/synthesis tests |
| G3 media/context/API | 5 | `apps/agent-api/src/routes/tasks.ts`、`run-workspace.ts`、`runtime/context-builder.ts`、`tests/context-builder.test.ts`、`tests/run-workspace-media.test.ts` |
| G4 DAG/retry | 7 | `orchestrator.ts`、`runtime/tool-adapter.ts`、execution-plan schema、execute-fault-tolerance/parallel-tool-scheduling/rest-json-retry/step-ordering tests |
| G5 gateway/probes | 5 | `.env.example`、`gateway-llm-client.ts`、model/vision probe scripts、gateway-failover test |
| G6 external labs/VLM | 24 | attention lab 4 paths、virtual-user lab 3 paths、vision-brand lab 8 paths、`scripts/start-labs.mjs`、4 lab/VLM tests、attention/vision tool manifest+schema 4 paths |
| G7 topology/Web | 12 | topology route、server、Web package/lock、App/client/FlowChart/Stage2/Stage4/FlowChartDemo/Workbench/theme |
| G8 ops/docs/demos | 11 | `.gitignore`、`database/db.ts`、`dev.sh`、4 report demos、3 helloagents plan files、root `package.json` |

## 5. Stash tracked 文件处置

来源：`archive/repository-consolidation/m1-stash-20260817` 相对第一父提交的 tracked diff，共 14 个文件。

恢复收据：从第一父提交创建 `rescue/m1-stash-20260817` 和 `.worktrees/m1-stash-rescue`，执行非破坏性 `git stash apply --index archive/repository-consolidation/m1-stash-20260817`。14 个 tracked diff 与 25 个第三父 untracked 文件均精确恢复；apply 前后收据位于 `$BACKUP_DIR/stash-rescue/before-apply.txt` 和 `after-apply.txt`。原 stash 与 archive tag peel 均保持 `945ff6c00f7d06a6d32399a9817a09a01b2b6aa2`。

第 5、6 节每个 `archived` 条目中的 “stash tag + verified pre-cleanup bundle” 均精确指 `archive/repository-consolidation/m1-stash-20260817` 与 `$BACKUP_DIR/ai-x-repository-consolidation-pre-cleanup-20260817.bundle`；`git bundle verify` PASS，`git bundle list-heads` 包含该精确 tag。

| 路径 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|
| `apps/agent-api/src/routes/feedback.ts` | `archived` | stash tag + verified pre-cleanup bundle；不恢复 legacy feedback summary | Current 无 feedback consumer；`tests/legacy-mutation-route.test.ts` 证明 legacy POST 为 410 且 DB/workspace 零写 | Darwin（独立审查 Agent） |
| `apps/agent-api/src/routes/tasks.ts` | `covered-by-main` | `apps/agent-api/src/routes/control-tasks.ts`、`apps/orchestrator-runtime/src/control/task-workflow.ts` | Current 422/403/409/500、owner gate、resume/execute 状态合同取代 legacy router；Gate 9 六文件命令 91 pass | Darwin（独立审查 Agent） |
| `apps/agent-api/src/server.ts` | `covered-by-main` | `apps/agent-api/src/server.ts` 的 `createAgentApiApp` + direct-start guard | 可注入 app 组装与 import 不监听由 Gate 9 六文件命令覆盖；91 pass、0 fail | Darwin（独立审查 Agent） |
| `apps/orchestrator-runtime/src/orchestrator.ts` | `forward-ported` | `apps/orchestrator-runtime/src/control/artifact-store.ts`、`apps/orchestrator-runtime/src/control/task-workflow.ts`、`apps/orchestrator-runtime/src/report/visual-input-data-url.ts`、`apps/orchestrator-runtime/src/report/visual-input-materializer.ts` | commit `b881feb`；任何 gate/状态写入前执行 canonical base64、MIME、10MiB/20MP、结构和完整像素解码；六文件命令 91 pass | Darwin / gate9_final_code_review（独立审查 Agent） |
| `apps/orchestrator-runtime/src/runtime/checkpoint-store.ts` | `covered-by-main` | `database/control-plane.ts`、`apps/orchestrator-runtime/src/control/task-workflow.ts` | Current 事务 claim/transition 取代 legacy facade；Gate 9 六文件命令 91 pass | Darwin（独立审查 Agent） |
| `apps/web/src/api/client.ts` | `archived` | stash tag + verified pre-cleanup bundle；不恢复 legacy message/code envelope | Current client 使用 HTTP status + `error`，无 legacy `code` consumer | Darwin（独立审查 Agent） |
| `apps/web/src/components/Composer.tsx` | `archived` | stash tag + verified pre-cleanup bundle | 单行 `flexShrink` 无复现缺陷或合同证据，不前移无依据 CSS | Darwin（独立审查 Agent） |
| `apps/web/src/pages/Workbench.tsx` | `archived` | stash tag + verified pre-cleanup bundle | 两处 `minHeight` 无复现缺陷；Current Workbench 已重构 | Darwin（独立审查 Agent） |
| `database/repository.ts` | `covered-by-main` | `database/control-plane.ts` 的 `claimExecution`、`transitionTask`、`cancelPausedExecution` | Current 事务、锁与幂等覆盖原子状态行为；feedback summary 不恢复；Gate 9 六文件命令 91 pass | Darwin（独立审查 Agent） |
| `external-tools/vision-brand-lab/README.md` | `archived` | stash tag + verified pre-cleanup bundle | 固定 GPT-5.4 failover 文档入口已过期，不恢复 | Darwin（独立审查 Agent） |
| `external-tools/vision-brand-lab/apps/server/package.json` | `archived` | stash tag + verified pre-cleanup bundle | 不恢复只服务旧文档面的 `smoke:vlm-failover` 命令 | Darwin（独立审查 Agent） |
| `package.json` | `forward-ported` | Current `package.json` + `.github/workflows/ci.yml` | package manager/typecheck/quality 已覆盖；commit `b881feb` 在 CI quality 后增加 Web build；不恢复 `test-concurrency=1`/npm 混用 | Darwin（独立审查 Agent） |
| `scripts/replay-report-v2.ts` | `archived` | stash tag + verified pre-cleanup bundle；Current EvidenceManifest→FindingGraph→Deliverable→ReportDocument | 旧 Report/EvidenceLedger replay 1.1 会形成第二事实链；Current 报告链回归 67/67 PASS | Darwin（独立审查 Agent） |
| `tests/replay-report-v2.test.ts` | `archived` | stash tag + verified pre-cleanup bundle；Current evidence/deliverable/report tests | 旧 replay 合同不再是生产入口；Current 报告链回归 67/67 PASS | Darwin（独立审查 Agent） |

## 6. Stash untracked 文件处置

来源：`archive/repository-consolidation/m1-stash-20260817^3` 的完整 tree，共 25 个文件。

| 路径 | 结论 | 当前目标 | 验证证据 | 复核人 |
|---|---|---|---|---|
| `.github/workflows/ci.yml` | `forward-ported` | `.github/workflows/ci.yml` | commit `b881feb` 保留 Node 22/pnpm/Web install/migrate/quality，并在 quality 后显式运行 `pnpm --dir apps/web build`；本地 build PASS | Darwin（独立审查 Agent） |
| `CLAUDE.md` | `covered-by-main` | 当前同路径 | `test "$(git rev-parse 'archive/repository-consolidation/m1-stash-20260817^3:CLAUDE.md')" = "$(git hash-object CLAUDE.md)"` PASS | Darwin（独立审查 Agent） |
| `docs/agents/domain.md` | `covered-by-main` | 当前同路径 | 同一 `rev-parse <tag^3:path>` vs `hash-object <path>` 命令对本路径 PASS | Darwin（独立审查 Agent） |
| `docs/agents/issue-tracker.md` | `covered-by-main` | 当前同路径 | 同一 `rev-parse <tag^3:path>` vs `hash-object <path>` 命令对本路径 PASS | Darwin（独立审查 Agent） |
| `docs/agents/triage-labels.md` | `covered-by-main` | 当前同路径 | 同一 `rev-parse <tag^3:path>` vs `hash-object <path>` 命令对本路径 PASS | Darwin（独立审查 Agent） |
| `external-tools/vision-brand-lab/scripts/vision-brand-vlm-failover-smoke.mjs` | `archived` | stash tag + verified pre-cleanup bundle；Current 孤儿副本由 `56b5978` 删除 | 脚本注入 `VLM_MODEL_NAME/FALLBACKS` 并断言 model/attempts/degraded，但 Current lab service 不消费或产出这些合同；代码/package 无调用面，保留会制造 hollow smoke | gate10_docs_audit（独立审查 Agent） |
| `helloagents/CHANGELOG.md` | `archived` | stash tag + verified pre-cleanup bundle | 时点过程材料不是 Current 合同；不前移（后续历史副本已有追加） | Darwin（独立审查 Agent） |
| `helloagents/plan/202607222226_execution-state-hardening/how.md` | `archived` | stash tag + verified pre-cleanup bundle | 过程计划不是 Current 合同；行为结论已由 `b881feb` 与 Current tests 固化 | Darwin（独立审查 Agent） |
| `helloagents/plan/202607222226_execution-state-hardening/task.md` | `archived` | stash tag + verified pre-cleanup bundle | 过程任务不是 Current 合同；行为结论已由 `b881feb` 与 Current tests 固化 | Darwin（独立审查 Agent） |
| `helloagents/plan/202607222226_execution-state-hardening/why.md` | `archived` | stash tag + verified pre-cleanup bundle | 过程说明不是 Current 合同；行为结论已由 `b881feb` 与 Current tests 固化 | Darwin（独立审查 Agent） |
| `helloagents/project.md` | `archived` | stash tag + verified pre-cleanup bundle | 权威域文档为 `CONTEXT.md` + `docs/adr/`，不恢复并行项目真相源 | Darwin（独立审查 Agent） |
| `helloagents/wiki/api.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/arch.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/data.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/modules/agent-api.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/modules/capability-configuration.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/modules/knowledge-and-reporting.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/modules/orchestration-runtime.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/modules/persistence-and-workspace.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/modules/web.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `helloagents/wiki/overview.md` | `archived` | stash tag + verified pre-cleanup bundle | 旧 wiki 不是 Current 合同；不前移任何 wiki 内容 | Darwin（独立审查 Agent） |
| `tests/agent-api.integration.test.ts` | `forward-ported` | `tests/control-api-integration.test.ts` | commit `b881feb` 前移 completed/non-paused `/resume` HTTP 409；legacy feedback harness 不恢复；Gate 9 六文件命令 91 pass | Darwin / gate9_final_code_review（独立审查 Agent） |
| `tests/execution-state-machine.test.ts` | `forward-ported` | `tests/task-workflow.test.ts`、`tests/visual-input-materializer.test.ts` | commit `b881feb` 前移截断/MIME 伪报输入的零 gate/零迁移/零 ingest；并发 claim/终态 execute 已覆盖；91 pass | Darwin / gate9_final_code_review（独立审查 Agent） |
| `tests/feedback-summary.test.ts` | `archived` | stash tag + verified pre-cleanup bundle | Current 无 feedback consumer；legacy mutation 410 且零写 | Darwin（独立审查 Agent） |
| `tests/fixtures/required-media-tool-manifest.yaml` | `archived` | stash tag + verified pre-cleanup bundle | legacy SkillLoader fixture 不适用于 Current confirmation `inputValues` 合同；Current tests 直接覆盖递归 data URL | Darwin（独立审查 Agent） |

## 7. 验证收据

| 工作包 | Commit/PR | 验证命令 | 结果 | Artifact |
|---|---|---|---|---|
| Docs plan | `d3b17a3`（rescue `2343ff1`） | staged path-set 与 commit 内容检查 | PASS；仅三份计划文档 | Git commit |
| Skill Evaluation / KB WIP | `4bd4d50` + `917bae7` | `pnpm exec tsx --test tests/kb-compare.test.ts tests/kb-retriever.test.ts tests/kb-snapshot.test.ts tests/skill-evaluation-runner.test.ts tests/skill-evaluator.test.ts`; `pnpm typecheck` | 113 pass、0 fail；typecheck PASS | TAP output |
| Control API / Control Plane / Web Flow WIP | `6404a2e` + `682d336` | `pnpm exec tsx --test tests/control-api-integration.test.ts tests/current-flow-state.test.ts`; `pnpm typecheck` | 32 pass、0 fail；typecheck PASS | TAP output |
| Real Multimodal Execution Hardening WIP | `9a1c5d4` + `3268a62` + `326d7ed` + `3c262f5` | TodoList Gate 5 的 10 文件定向命令；`pnpm typecheck` | 171 tests、170 pass、1 skip、0 fail；typecheck PASS | TAP output |
| Local run-input preservation | `3b28f0a` / `9a1c5d4`（ignore rule） | 4 个源文件逐项 `cmp` `$BACKUP_DIR/root-untracked/...`; 从 `$BACKUP_DIR` 执行 `shasum -a 256 -c sha256.txt` | 4/4 byte-identical；checksum PASS | `$BACKUP_DIR/root-untracked/` |
| Archive test preservation | `2338c93` | `pnpm exec tsx --test tests/execution-recovery.test.ts tests/execution-scheduler.test.ts tests/lease-execution-engine.test.ts tests/tool-provenance.test.ts tests/tool-retry-policy.test.ts`; `pnpm typecheck` | 85 tests、84 pass、1 skip、0 fail；typecheck PASS | TAP output |
| M1 Runtime / Tool | `d203716` | `pnpm exec tsx --test tests/plan-compiler.test.ts`; `pnpm lint:registry`; `pnpm lint:knowledge`; `pnpm typecheck` | 31 pass、0 fail；两 linter 与 typecheck PASS | TAP/linter output |
| Plan assumptions defense | `868d752` | `pnpm exec tsx --test tests/current-plan-candidate-schema.test.ts tests/plan-compiler.test.ts` | 42 pass、0 fail；共享 schema 与 Current `planCurrent` 生产路径均拒绝 object/string assumptions | TAP output |
| Cross-profile Skill routing | `227d951` | `pnpm exec tsx --test tests/capability-resolver.test.ts`; `pnpm lint:registry`; `pnpm typecheck` | 12 pass、0 fail；三项生产 Registry + resolver 路由恢复；linter/typecheck PASS | TAP/linter output |
| M1 Evidence / Report | `d39d29f` | `pnpm exec tsx --test tests/plan-compiler.test.ts tests/skill-loader-schema.test.ts tests/skill-output-contract.test.ts tests/registry-linter.test.ts tests/runner-unit.test.ts tests/skill-evaluator.test.ts tests/synthesis-materializer.test.ts tests/lease-execution-engine.test.ts tests/control-api-integration.test.ts tests/task-workflow.test.ts tests/evidence-service.test.ts tests/report-evidence-validator.test.ts tests/current-deliverable-service.test.ts tests/report-document.test.ts`; `pnpm lint:registry`; `pnpm lint:knowledge`; `pnpm typecheck`; `pnpm kb:build` ×2 | 261 tests、260 pass、1 skip、0 fail；两 linter/typecheck PASS；registry 与 KB index 两次构建 SHA-256 不变 | TAP/linter/hash output |
| Competitive app payload contract | `ff5fd0c` + `0fce0d5` | `pnpm exec tsx --test tests/registry-linter.test.ts tests/skill-loader-schema.test.ts tests/skill-output-contract.test.ts`; `pnpm lint:registry`; `pnpm typecheck` | 14 pass、0 fail；linter/typecheck PASS；payload 拒绝未绑定 `evidence_refs` | TAP/linter output |
| Stash forward-port | `b881feb` | `pnpm exec tsx --test tests/task-workflow.test.ts tests/visual-input-materializer.test.ts tests/control-api-integration.test.ts tests/legacy-mutation-route.test.ts tests/visual-asset-service.test.ts tests/binary-artifact-store.test.ts`; `pnpm typecheck`; `pnpm --dir apps/web build`; `git diff --check` | 91 pass、0 fail；typecheck、Web build、diff-check PASS；stash/tag 仍为 `945ff6c` | TAP/build/Git output；`$BACKUP_DIR/stash-rescue/` |
| Orphaned VLM smoke removal | `56b5978` | `rg -n 'vision-brand-vlm-failover-smoke|smoke:vlm-failover|VLM_MODEL_FALLBACKS' --glob '!docs/plans/2026-08-17-repository-consolidation-*.md' --glob '!wiki/**' .`; file absence check | 0 references；孤儿脚本已删除，stash tag/bundle 保留恢复点 | Git/rg output |
| Offline quality | through `227d951`（Gate 10） | `pnpm quality` | 1094 tests、1083 pass、11 skip、0 fail；typecheck、registry linter、knowledge linter PASS | TAP/linter output |
| Web build | `227d951`（Gate 10） | `pnpm --dir apps/web build` | PASS；647 modules transformed；既有 >500 kB chunk warning 非阻塞 | Vite build output |
| Git/recovery integrity | `227d951`（Gate 10） | `git fsck --full`; bundle verify/SHA-256/list-heads；stash 14/25 path-set 比对；Markdown table audit；`git diff --check` | PASS；fsck 仅报告可接受 dangling objects；bundle SHA-256=`6de8573…6ed`；stash 路径差集 0；表格空字段/列数错误 0 | Git/Node audit output |
| Gate 10 disposition | 本提交 | staged path-set、cached diff-check、commit 内容检查 | PASS；仅两份 consolidation 文档，无 `wiki/` | Git commit |
| Current real Smoke | 未填写 | 未填写 | 未填写 | 未填写 |
| Integration PR CI | 未填写 | 未填写 | 未填写 | 未填写 |

Gate 8 残余风险：成功路径和 output-schema-failure 路径会在 provider 调用前冻结 input/envelope/payload schema hash；若 provider 在返回结果前直接抛出 server/network 错误，失败 provenance 仍可能因随后重读配置而只保留已落库 receipt 与 `captureFailure`。这不改变 Current 事实链或本门禁合同，后续可让 `SkillLoader` 从同一份字节同时返回 schema 与 hash 以彻底消除配置文件级 TOCTOU。

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
