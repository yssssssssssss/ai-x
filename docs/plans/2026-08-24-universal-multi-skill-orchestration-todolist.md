# 通用多 Skill 组合编排底座 TodoList

> 状态：实施中；Gate 0 已建立文档与领域基线，Multi-Skill writer 仍保持 inactive。
>
> 对应开发文档：`docs/plans/2026-08-24-universal-multi-skill-orchestration-development.md`
>
> 当前分支：`feat/research-answer-dynamic-reports`
>
> 当前基线 HEAD：`905dfa9ad8913abfedf922c9a4676a44876bed10`
>
> 规则：所有改动进入同一集成分支；每个 Gate 保持可回滚，但不要求每个文件或每个勾选项后验证。按 Phase 运行定向测试、按三个 Milestone 批量运行集成门禁、最终只运行一次完整 quality/build/真实 E2E。默认 Multi-Skill writer 只在最终 Activation 开启；未经授权不 push、merge、restart 或发布。

## 实施基线记录（2026-08-24）

```text
worktree: /Users/heyunshen/work/PROJECT/jdc/ai-x-answer-reports
branch: feat/research-answer-dynamic-reports
HEAD: 905dfa9ad8913abfedf922c9a4676a44876bed10
Node: v22.22.1
pnpm: 9.12.1
latest database migration: 014_zero_publications.sql
API source revision: 905dfa9ad8913abfedf922c9a4676a44876bed10
API build id: 0.0.1+905dfa9ad891
Web dev server: http://127.0.0.1:5173 (HTTP 200)
```

实施前已存在并受保护、不纳入本阶段改动的工作区文件：

```text
apps/web/src/current-flow-state.ts
apps/web/src/hooks/useTaskFlow.ts
apps/web/src/pages/Workbench.tsx
tests/current-flow-state.test.ts
```

Registry、Deliverable Registry、Tool Registry 和 Knowledge Index 均可读取；当前 shell/运行中 API 未暴露 Database/Gateway 配置，仅检测到 Tavily 配置，因此真实数据库/Gateway 门禁保留待办。基线之后的 Report/Web 与受保护 UI 定向回归共 40 tests 通过。

## 已确认事实

- [x] 原始架构要求 Router 生成 `selected_skills`、Skill 间 DAG 和多 Skill Result Synthesis。
- [x] 当前 `research_synthesis` 通过 `direct_skill_bypass` 硬编码到 `research-strategy-synthesis`。
- [x] 最新京东众筹 Plan 的 `classifier_call_count=0`。
- [x] 最新京东众筹 Plan 只有 1 个 Skill Invocation、10 个步骤。
- [x] Capability Resolution 为 1 eligible、23 rejected。
- [x] Persona/JTBD/Journey/Metrics/Competitive 等相关 Skill 因 `task_type_mismatch` 被拒绝。
- [x] 当前 Plan 没有 `virtual-user-lab`，尽管 Requirement 允许/要求 AI 虚拟用户调研。
- [x] 京东众筹旧 Plan 已执行完成，Task 为 `completed_with_gaps`，Attempt 为 `105dbbe2-1e92-47a0-8062-0e2da78fea4e`；后续不得改写该历史证据。
- [x] Current Plan v2 与 SkillPlanCompiler 已具备 `skill_invocations[]` 和多 Expansion 基础。
- [x] Scheduler、Lease、Artifact Store、Materializer 可复用。
- [x] 当前缺口集中在 Portfolio Routing、跨 Invocation wiring、Contribution Contract、Synthesis/Fidelity 和 UI。
- [x] 完整开发文档与 TodoList 已创建。

# 验证执行原则

- [ ] 不在每个文件修改或每个 checkbox 后运行验证。
- [ ] 开发内环只在需要定位问题时运行单个测试文件/`--test-name-pattern`。
- [ ] Phase 边界只运行直接受影响的定向测试。
- [ ] Phase 1–2 完成后统一运行 Milestone A。
- [ ] Phase 3–4 完成后统一运行 Milestone B。
- [ ] Phase 5–6 完成后统一运行 Milestone C。
- [ ] 全量 `pnpm test`、完整 Web build 和真实 E2E 只在最终 Activation Gate 运行。
- [ ] 最终全量失败时只复跑失败项及直接依赖；修复收敛后再做一次最终全量确认。
- [ ] Zero 未改变 payload/transport 时只跑自动化回归，不做 live Zero。

# Gate 0：基线、工作区与决策冻结

## 0.1 工作区安全

- [x] 记录实施开始时 `git rev-parse HEAD`。
- [x] 记录 `git status --short --branch -uall`。
- [x] 确认当前未提交文件的 owner；上述四个文件归属既有 UI work-in-progress，本实施不接管、不覆盖。
- [x] 确认一个 writer 修改集成 worktree；并行 writer 必须使用隔离 worktree。
- [x] 记录 Node、pnpm、数据库迁移版本、API/Web Source revision。

## 0.2 ADR 与领域术语

- [x] 新增 `docs/adr/0007-universal-multi-skill-orchestration.md`。
- [x] ADR 明确 intra-skill 与 inter-skill orchestration 区别。
- [x] ADR 明确 1..N Skill，不强制所有任务多 Skill。
- [x] ADR 明确 Contributor/Synthesizer/Reviewer/Contribution Ledger。
- [x] ADR 明确 Canonical Deliverable 仍唯一正式真相源。
- [x] ADR 明确 Plan v3，保留 v1/v2。
- [x] ADR 明确无隐藏嵌套 Agent/Skill。
- [x] 更新 `CONTEXT.md` 领域术语。

## 0.3 基线确认（不重复全量验证）

- [ ] 若实施 HEAD 仍等于最近已完成全量 green 的 HEAD，复用该记录，不重复运行 `pnpm test`/Web build。（不适用：HEAD 在上次全量 green 后包含报告可读性修复。）
- [x] 若 HEAD 已变化，只运行变化文件所属模块的现有定向测试。
- [ ] 确认 Registry、Knowledge、数据库和外部服务配置可读取。（Registry/Knowledge/Tavily 已确认；Database/Gateway 待外部验收环境。）
- [x] 文档/ADR 只做 Markdown 结构、路径和尾随空格检查。
- [x] 独立提交 Gate 0 文档/合同基线。

# Phase 1：Inactive 合同与兼容 Reader

## 1.1 Capability Demand Graph v1

- [x] 保留现有 ProblemGraph v1，不新增 ProblemGraph v2。
- [x] 新增 `schemas/capability-demand-graph-v1.schema.json`。
- [x] Capability Demand Graph 作为 Plan v3 必填规划对象。
- [x] 定义受控 `ContributionType` enum。
- [x] Required Question 缺 demand 失败。
- [x] unknown demand type 失败。
- [x] Demand 引用未知 Question/Artifact/Evidence class 失败。
- [x] virtual user Requirement 未生成 synthetic demand 失败。
- [x] 无量化数据却生成 quantitative fact demand 失败。
- [x] 保留 ProblemGraph v1 Reader。

## 1.2 CurrentExecutionPlan v3

- [x] 新增 `schemas/current-execution-plan-v3.schema.json`。
- [x] 增加 Invocation role、contribution types、question/artifact ownership。
- [x] 增加 invocation dependencies、output contract、required/failure policy。
- [x] 增加 Plan Contribution Requirements。
- [x] 增加 Shared Step metadata/fingerprint。
- [x] v3 无 skill invocations 失败。
- [x] v3 无 synthesizer 或多个 synthesizer 失败。
- [x] Required Demand 无 Owner 失败。
- [x] 更新共享 TypeScript contracts。
- [x] SystemCapabilities 暴露 v1/v2/v3。
- [x] v1/v2 schema 与 Reader 不变。

## 1.3 Contribution/Ledger Schema

- [x] 新增 `schemas/research-contribution-v1.schema.json`。
- [x] 新增 `schemas/contribution-ledger-v1.schema.json`。
- [x] Contribution Unit 缺 Question/Support 失败。
- [x] supported 无 factual Evidence 失败。
- [x] provisional 无 validationNeeded 失败。
- [x] synthetic supported 失败。
- [x] Ledger 重复/缺失 source unit 失败。
- [x] included 无 canonical target 失败。
- [x] merged/omitted/conflicted 无 Review issue 失败。

## Phase 1 定向测试

```bash
pnpm exec tsx --test \
  tests/capability-demand-graph.test.ts \
  tests/current-execution-plan-v3.test.ts \
  tests/research-contribution-contract.test.ts \
  tests/contribution-ledger.test.ts \
  tests/system-capabilities.test.ts
```

- [x] 新合同保持 inactive，默认仍写旧 Plan。
- [x] 历史 Plan/Report fixtures 定向用例通过（113 tests）。
- [x] 不在此处重复 root typecheck、Registry lint 或 Web build；统一留到 Milestone A。
- [x] 独立提交 Phase 1。

Phase 1 合同定向测试：26 tests 通过，0 失败。

# Phase 2：Registry Composition 与 Portfolio Resolver

## 2.1 Registry 扩展

- [ ] 增加 `composition.modes`。
- [ ] 增加 `supported_outcomes`。
- [ ] 增加 `compatible_deliverables`。
- [ ] 增加 `contribution_types`。
- [ ] 增加 `contribution_schema`。
- [ ] 增加 required/optional input roles。
- [ ] 无 composition 的旧 Skill 默认 standalone。
- [ ] contributor 无 schema/type lint 失败。
- [ ] synthesizer 无 deliverable/accepted schema lint 失败。
- [ ] Registry 输出顺序/hash 稳定。

## 2.2 Deliverable Composition Policy

- [ ] Deliverable Registry 增加 `composition.mode`。
- [ ] 每个 `portfolio` Deliverable 声明唯一 `synthesizer_skill_id`。
- [ ] 声明 accepted contribution types/schema。
- [ ] 旧 Deliverable 可使用 `standalone_compat` 保持原路径。
- [ ] 每个 active Deliverable 都有明确 policy；缺失时 lint 失败。
- [ ] LLM 不得覆盖 Deliverable 的 Synthesizer owner。

## 2.3 全量 Skill 分类

- [ ] 生成所有 active Skill 的 composition audit 表。
- [ ] `research-strategy-synthesis` 标记 synthesizer。
- [ ] `generate-research-plan` 标记 synthesizer。
- [ ] Competitive Skills 分类。
- [ ] Persona/JTBD/Journey 分类。
- [ ] Metrics/Funnel/Feature Adoption 分类。
- [ ] VOC/Satisfaction/Qualitative 分类。
- [ ] Design/Accessibility 分类。
- [ ] 无法适配者明确 standalone + 原因。
- [ ] 不通过简单添加 `research_synthesis` 绕过输入合同。

## 2.4 Portfolio Resolver

- [ ] 新增 `capability-portfolio-resolver.ts`。
- [ ] Hard Filter 检查 status/outcome/deliverable/input/tool/approval。
- [ ] Semantic Recall 使用 demand、when_to_use、Question、Artifact、Domain。
- [ ] Coverage Optimizer 选择最小 Skill 集。
- [ ] 每题恰好一个 Primary Owner。
- [ ] 每 demand 默认最多一个 Corroborator。
- [ ] Contributor 数量与总步骤复用 ProfileSpec/Usage/Tool Budget。
- [ ] 不新增重复的 Contributor/Step 数量配置。
- [ ] Required Demand 超预算时 fail，不静默裁剪。
- [ ] 保存每个选择/拒绝 reason code。
- [ ] 保存 Coverage Matrix 与 Budget Estimate。

## 2.5 移除隐式 Direct Bypass

- [ ] 只有显式 `$skill`/direct invoke 使用 direct path。
- [ ] 普通 `research_synthesis` 进入 Portfolio Resolver。
- [ ] 删除默认 `research_synthesis → research-strategy-synthesis` 硬编码。
- [ ] `planningProvenance.classification_method` 不再为 `direct_skill_bypass`。
- [ ] Candidate Planner 只接收 validated Portfolio，但可包含多个 Skill。
- [ ] rejected actor 仍禁止进入 Plan。

## Milestone A 验证（Phase 1–2）

```bash
pnpm exec tsx --test \
  tests/current-execution-plan-v3.test.ts \
  tests/multi-skill-deliverable-policy.test.ts \
  tests/multi-skill-capability-portfolio.test.ts \
  tests/research-strategy-planning.test.ts \
  tests/research-outcome-mode.test.ts \
  tests/planning-guidance.test.ts
pnpm typecheck
pnpm lint:registry
git diff --check
```

- [ ] 单 Skill 充分覆盖 fixture 仍选择一个。
- [ ] 京东众筹 fixture 选择多个 Contributor + 一个 Synthesizer。
- [ ] 无匹配 Skill 返回明确 capability gap。
- [ ] Phase 1–2 的合同、类型与 Registry 一次性验证通过。
- [ ] 独立提交 Phase 2。

# Phase 3：跨 Invocation 编译、共享阶段与执行

## 3.1 Compiler

- [ ] 扩展 `SkillPlanCompiler` 处理 Invocation role。
- [ ] 保留高层 Skill 对外部 Invocation 的 dependencies。
- [ ] 将 invocation dependency 映射到上游 output stage。
- [ ] 支持跨 Skill output pointer binding。
- [ ] Synthesizer 依赖全部 Required Contributor outputs。
- [ ] 编译前后 Contribution Coverage 等价。
- [ ] 检测 Invocation/Step cycle。
- [ ] 检测 dangling dependency/pointer/contract。
- [ ] Plan hash 包含 Portfolio 与共享指纹。

## 3.2 Shared Tool/Knowledge

- [ ] Execution Contract 支持 `share_scope: plan`。
- [ ] 计算 Tool share fingerprint。
- [ ] 计算 Knowledge Bundle fingerprint。
- [ ] 完全相同的 shareable stage 合并。
- [ ] Tool input、approval、policy 任一不同不得合并。
- [ ] shared step 记录所有 consumer invocation IDs。
- [ ] Evidence Artifact 只生成一次并可被多个 Contributor 引用。

## 3.3 Step Input Resolver

- [ ] 解析 Contribution Artifact binding。
- [ ] Synthesizer 接收有序 Contribution Bundle。
- [ ] Contributor 只接收 scoped Question/Evidence。
- [ ] 禁止读取非依赖 Invocation Artifact。
- [ ] 绑定 Task/Plan/Attempt/Artifact hash。

## 3.4 Scheduler/Lease

- [ ] 独立 Contributor 可并行。
- [ ] Required Contributor failure block。
- [ ] Optional Contributor failure/degraded 生成 Gap。
- [ ] Contributor 单独 retry。
- [ ] worker loss 只恢复受影响分支。
- [ ] Synthesizer failure 复用已 SEALED Contributions。
- [ ] 用户取消传播到所有分支。
- [ ] 保持 per-call timeout，无 whole-task timeout。

## Phase 3 定向测试

```bash
pnpm exec tsx --test \
  tests/multi-skill-plan-compiler.test.ts \
  tests/plan-compiler.test.ts \
  tests/step-input-resolver.test.ts \
  tests/multi-skill-execution.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/skill-execution-contract.test.ts
```

- [ ] 三 Contributor 并行 + Synthesizer fixture 通过。
- [ ] Shared Tavily 只调用一次。
- [ ] Required/Optional failure 路径通过。
- [ ] 不在此处重复 root typecheck；统一留到 Milestone B。
- [ ] 独立提交 Phase 3。

# Phase 4：Contribution Runtime 与 Skill 迁移

## 4.1 Runtime

- [ ] 新增 `research-contribution.ts`。
- [ ] 新增 Adapter Registry。
- [ ] Adapter 不调用 LLM。
- [ ] Adapter 保留 source pointer/hash。
- [ ] Skill Envelope metadata 显式映射或标为 diagnostic。
- [ ] Contribution Artifact SEALED 后才能给 Synthesizer。
- [ ] Contribution status/gap 传播。

## 4.2 首批 Contributor

- [ ] Market/Competitive Contributor。
- [ ] Virtual User Contributor。
- [ ] Persona Contributor。
- [ ] JTBD/Motivation Contributor。
- [ ] Metrics Contributor。
- [ ] 根据输入条件决定 native schema 修改或 deterministic adapter。
- [ ] 无输入时 fail/gap，不编造。

## 4.3 Virtual User

- [ ] 新增/适配 `virtual-user-research` Skill。
- [ ] 冻结 `virtual-user-lab` Tool stage。
- [ ] synthetic Evidence class/metadata。
- [ ] 所有结论强制 provisional。
- [ ] 报告强制免责声明。
- [ ] Tool unavailable 的 required/gap 行为。
- [ ] 后续真实验证计划必填。

## 4.4 Synthesizer

- [ ] `research-strategy-synthesis` 接收 Contribution Bundle。
- [ ] 不重复执行 Contributor 已负责分析。
- [ ] 输出 source contribution unit IDs。
- [ ] 保留当前 direct answer、typed blocks、risk 规则。
- [ ] `generate-research-plan` 支持 planning Contribution Bundle。
- [ ] 其他 Deliverable Synthesizer 建立明确 owner。

## Milestone B 验证（Phase 3–4）

```bash
pnpm exec tsx --test \
  tests/multi-skill-execution.test.ts \
  tests/research-contribution-contract.test.ts \
  tests/contribution-adapter-registry.test.ts \
  tests/virtual-user-contributor.test.ts \
  tests/skill-runtime.test.ts \
  tests/research-strategy-planning.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
git diff --check
```

- [ ] 所有 active Skill 完成 composition 分类审计。
- [ ] 首批可组合 Contributor 完成适配；其余明确 standalone。
- [ ] 首批 Contributor 无空/伪造 Evidence。
- [ ] Compiler/Runtime/Registry/Knowledge 一次性集成验证通过。
- [ ] 独立提交 Phase 4。

# Phase 5：Cross-Skill Review、Ledger 与 Fidelity

## 5.1 Conflict Review

- [ ] 定义 Conflict Set。
- [ ] Reviewer 输出 source unit IDs/target IDs/disposition。
- [ ] supported/provisional 冲突不自动升级。
- [ ] synthetic/public fact 冲突显式披露。
- [ ] 未解决冲突进入 openQuestions。
- [ ] 无授权不得 omitted/semantic rewrite。

## 5.2 Contribution Ledger

- [ ] 生成 pre-synthesis Ledger。
- [ ] 生成 final Ledger。
- [ ] included/merged/conflicted/omitted exact-one。
- [ ] Required Owner unit 不得 omitted。
- [ ] 每个 canonical node 反查 source contribution IDs。
- [ ] Ledger 在 Deliverable 前 SEALED。
- [ ] Ledger Artifact 身份进入 Report Package。

## 5.3 Fidelity

- [ ] Contributor source inventory/fingerprint。
- [ ] Contributor → Synthesis mapping completeness。
- [ ] unauthorized deletion/rewrite/reorder fail。
- [ ] Synthesis → Canonical 继续 lossless。
- [ ] Canonical → Report exact-once。
- [ ] typed patch 绑定 Cross-Skill Review issue。
- [ ] malformed repair 保存 diagnostics/preview。

## 5.4 Risk/Provenance

- [ ] capabilityProvenance 包含 Knowledge 与所有 Contributor Skill。
- [ ] Skill degraded/Contributor failure/Requirement ambiguity 全部传播。
- [ ] Evidence class 与 factual root 继续严格。
- [ ] Contribution omissions 在 owner trace 可见。

## Phase 5 定向测试

```bash
pnpm exec tsx --test \
  tests/contribution-ledger.test.ts \
  tests/multi-skill-fidelity.test.ts \
  tests/research-strategy-content-fidelity.test.ts \
  tests/research-strategy-content-patch.test.ts \
  tests/report-review-service.test.ts \
  tests/research-strategy-report-projector.test.ts
```

- [ ] 多来源遗漏/重复/冲突测试通过。
- [ ] 旧单 Skill Fidelity 定向回归通过。
- [ ] 不在此处重复 typecheck；统一留到 Milestone C。
- [ ] 独立提交 Phase 5。

# Phase 6：Web、API、Markdown、ZIP、Zero

## 6.1 API

- [ ] Plan API 返回 Portfolio、Coverage、Budget、Reasons。
- [ ] Task API 返回 Skill Group 状态。
- [ ] Owner API 返回 Contribution Ledger/summary。
- [ ] 非 owner 不可读取 Contributor Artifact。
- [ ] SystemCapabilities 返回 Plan v3/Contribution versions。

## 6.2 Plan UI

- [ ] 显示 Contributor 数量和 Synthesizer。
- [ ] 显示每个 Skill 覆盖问题/产物。
- [ ] 显示选择理由与 rejected/gap。
- [ ] 显示 Tool 和 synthetic 提示。
- [ ] 显示 Speed/Depth 真实差异。
- [ ] Required Demand 未覆盖时不能确认。

## 6.3 Execution UI

- [ ] Shared Evidence Group。
- [ ] 每个 Invocation Group。
- [ ] 内部 stages 可折叠。
- [ ] 并行/依赖关系可读。
- [ ] Required/Optional/Gap/Failure 状态明确。
- [ ] Retry 只作用目标 Invocation/下游。

## 6.4 Contribution View

- [ ] 显示独立结论、Evidence、confidence、限制。
- [ ] 显示 Final mapping。
- [ ] 显示 merged/conflicted/omitted 理由。
- [ ] 明确 owner-only、non-canonical。
- [ ] 不泄露 blocked/sensitive 内容。

## 6.5 Export

- [ ] Markdown full report 保持 Canonical。
- [ ] ZIP 增加安全 Contribution Summary 与 Ledger JSON。
- [ ] Zero 只接收 Review 通过的 Canonical/安全摘要。
- [ ] Print 展开必要内容。
- [ ] 历史 bundle/package 保持可读。

## Milestone C 验证（Phase 5–6）

```bash
pnpm exec tsx --test \
  tests/multi-skill-fidelity.test.ts \
  tests/research-strategy-report-projector.test.ts \
  tests/control-api-integration.test.ts \
  tests/system-capabilities.test.ts \
  tests/multi-skill-report-ui.test.ts \
  tests/report-bundle.test.ts \
  tests/report-package.test.ts \
  tests/task-history-ui.test.ts \
  tests/zero-publication-ui.test.ts
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

- [ ] 375px/desktop 浏览器目标矩阵执行一次并通过。
- [ ] Plan v1/v2、Report v1/v2 UI 回归通过。
- [ ] Report/API/UI/Export 一次性集成验证通过。
- [ ] 独立提交 Phase 6。

# Phase 7：全任务覆盖、真实验收与 Activation

## 7.1 Fixture Matrix

- [ ] `user_research_planning` simple + multi。
- [ ] `research_synthesis` simple + multi。
- [ ] `competitive_research` simple + multi。
- [ ] `design_audit` simple + multi。
- [ ] `a11y_audit` simple/适用组合。
- [ ] `voc_diagnosis` simple + multi。
- [ ] 每个 fixture 只验证 Portfolio Coverage、Plan 编译和关键合同；不为每类任务重复完整浏览器/外部 E2E。

## 7.2 京东众筹计划

- [ ] 保留已完成旧 Task/Plan/Attempt 作为 single-skill baseline，不修改。
- [ ] 创建新的京东众筹 Task，复用同等 Requirement 语义。
- [ ] 新 Task 生成 Plan v3。
- [ ] 包含 Shared Tavily。
- [ ] 包含 Market/Competitive Contributor。
- [ ] 包含 Virtual User Contributor。
- [ ] 包含 Persona Contributor。
- [ ] 包含 JTBD/Motivation Contributor。
- [ ] 包含 Metrics Contributor。
- [ ] 包含 Research Strategy Synthesizer。
- [ ] 包含 Cross-Skill Reviewer。
- [ ] 用户确认新 Plan 后执行。

## 7.3 真实执行

- [ ] 真实 Gateway receipts。
- [ ] 真实 Tavily receipt。
- [ ] `virtual-user-lab` 真实 receipt；不可用时该 Required Demand 明确阻断，不以 fixture 冒充。
- [ ] 每个 Required Contributor SEALED Artifact。
- [ ] Contribution Ledger SEALED。
- [ ] Synthesizer/Reviewer/Canonical SEALED。
- [ ] ReportDocument/Package SEALED。
- [ ] Owner Deliverable API 200。
- [ ] Web 可查看每个 Skill 与 Final mapping。
- [ ] Markdown/ZIP 完整。
- [ ] Zero 自动化回归通过；只有 payload/transport 改变时才运行一次 live Zero。

## 7.4 性能测量

- [ ] 记录单 Skill baseline 的步骤/时间/Token/Artifact。
- [ ] 记录 Multi-Skill 实际值。
- [ ] Shared Tool/Knowledge dedup 计数有效。
- [ ] 并行 Contributor 墙钟时间可解释。
- [ ] Budget/上限没有静默裁剪 Required Demand。

## 7.5 最终门禁

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm test
pnpm --dir apps/web build
git diff --check
```

- [ ] 全量测试 0 fail。
- [ ] Web production build 通过。
- [ ] 独立架构/安全/真实性审查通过。
- [ ] 当前工作树只包含计划范围文件。
- [ ] Activation commit 开启新任务 Plan v3 writer。
- [ ] 旧 Reader/Executor 保留。
- [ ] 更新开发文档实施结果与账本。
- [ ] 获得明确 merge/restart 授权。
- [ ] 一次性合并到 main。
- [ ] 从 main 重启并做 source revision/health 验收。
- [ ] 未获 push 授权前不 push。

# 回滚清单

- [ ] Activation 回滚只停止新 Plan v3 写入。
- [ ] Plan v3 Reader/Executor 保留。
- [ ] 已 SEALED Contribution/Ledger 不删除。
- [ ] 历史 Plan v1/v2 不修改。
- [ ] 京东众筹旧 Task/Plan/Attempt 保留为 immutable baseline。
- [ ] Multi-Skill 验收使用新 Task，不覆盖历史记录。
- [ ] 不需数据库回滚。
- [ ] Tool/Skill Registry 回滚不破坏已冻结 Invocation hash。

# 完成账本

```text
architecture ADR                                  pending
Capability Demand Graph v1                       pending
CurrentExecutionPlan v3                          pending
Registry composition metadata                    pending
all active Skills classified                     pending
Portfolio Resolver                               pending
implicit direct_skill_bypass removed             pending
cross-invocation DAG                             pending
shared Tool/Knowledge dedup                      pending
research-contribution-v1                         pending
virtual-user contributor                         pending
contribution-ledger-v1                           pending
cross-skill reviewer                             pending
multi-skill fidelity                             pending
Canonical/Report integration                     pending
Portfolio/Contribution UI                        pending
all task type fixtures                           pending
JD crowdfunding new Plan                         pending
JD crowdfunding real run                         pending
targeted milestones + final quality              pending
independent review                               pending
Zero automated regression                       pending
single authorized merge/restart                  pending authorization
push                                             withheld until authorized
```
