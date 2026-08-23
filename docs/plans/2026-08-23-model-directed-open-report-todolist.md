# 模型编排的开放式动态报告 TodoList

> 对应方案：`docs/plans/2026-08-23-model-directed-open-report-development.md`
>
> 当前基线：`feat/research-answer-dynamic-reports@affb2cc5389ee19633684f0e4b1ded4f15398bcd`
>
> 状态：Phase 1–7 源码已实现并通过本地门禁；八次无20分钟总限制的真实运行已验证到最终语义 Review；最新 Planning 误将纯公开资料任务送入审批，现已确定性移除假设性隐私/授权阻断；完整真实闭环待再次授权复跑。
>
> 发布规则：所有改动进入同一集成分支；每个 Phase 独立提交、可构建、可回滚；所有源码和外部门禁通过后只合并一次；未经授权不 push。

## 已确认事实

- [x] 真实任务 `b7d330bf-0712-4273-a87c-7b03ad579d7b` 的步骤 1–9 均成功。
- [x] 真实 Tavily、Knowledge、LLM、Reviewer 和 compiled `research-strategy-synthesis` 均被实际调用。
- [x] Step 8 已产出完整策略内容，Step 9 已产出结构化 `pass_with_conditions`。
- [x] `CurrentDeliverableService` 在上述输出之后再次调用大型 Deliverable LLM 重写报告。
- [x] 当前 Payload 强制 17 个顶层字段，并同时保留动态章节和专用策略字段。
- [x] 当前 Dynamic Report Composer 仍硬编码多个业务章节及其顺序。
- [x] 当前模型还负责 `requestedArtifactBindings` 等可确定性生成的机械字段。
- [x] Requirement Gateway 空 Schema 问题已经修复并提交。
- [x] requested artifact 绑定的确定性修复已经提交。
- [x] 本次 20 分钟终止来自外层验收命令，不是仓库内的整任务业务限制。
- [x] 超时任务已由 Lease 回收为 `paused / worker_loss`，没有生成最终 Deliverable。
- [x] 当前分支 `feat/research-answer-dynamic-reports@affb2cc` 干净。
- [x] 当前全量质量门禁为 1673 tests、1658 passed、15 skipped、0 failed。
- [x] 已建立完整方案和本 TodoList。

# 当前实施证据

- [x] Content Draft v2 与 Canonical Payload v2 已分离。
- [x] `research_strategy_report` 已切换为 reviewed Skill assembly，不再调用完整 Deliverable 重写模型。
- [x] FindingGraph、Coverage、风险身份、requested artifact bindings 与稳定 ID 已由系统生成。
- [x] Layout Blueprint 只引用 Canonical Block，并支持确定性 fallback。
- [x] ReportDocument v2、Web、Markdown、ZIP 和 Zero 源码路径已支持动态 Section。
- [x] Deliverable/Layout 诊断使用脱敏 Artifact 或 ReportDocument metadata 持久化。
- [x] 真实 Smoke 已移除20分钟整任务限制并输出30秒进度。
- [x] 本地全量测试、TypeScript、Registry/Knowledge lint、Web build 与 diff check 已通过。
- [x] `1000e959-e970-4f40-aa1a-60e2026f7615` 的真实 Artifact 已离线重放通过 Assembly 与 ReportDocument 全链路校验。
- [x] `8b1956ee-4308-4974-ba0c-484a0841396b` 暴露不存在的 `E1-13` 引用；已实现一次只允许精确 Question/Evidence 白名单的 `deliverable_repair`，失败仍会阻断并留诊断。
- [x] `9e5b3a75-6989-48d9-8b89-fb2655ef5e64` 在 Requirement 持久化前暴露结构化输出校验失败；已实现一次携带脱敏反馈的 Requirement 重试。
- [x] `ee5ba760-39ea-42f0-aa1a-60e2026f7615` 已成功 SEALED Canonical Deliverable v2，并进入最终 Report Review；Reviewer 返回 `revise` 后，已实现一次受限 Content Draft 语义修订并重新执行全部确定性门禁。
- [x] `70ca280d-007d-4cdb-810f-6010060f538f` 的两次 Requirement 调用均成功返回但未落版本；已增加完整对象安全解包、未声明字段投影和安全错误类型。
- [x] `3efb0f98-6d1f-4873-9062-443bbc467fc3` 已持久化 Requirement 与候选 Plan，但纯公开资料任务因假设性隐私/授权提醒进入 `awaiting_approval`；现已只在明确 public-only、无PII且未请求私有数据时移除此类假设性阻断。
- [ ] 假设性阻断修复与受限语义修订后的完整真实 Gateway/DB 闭环尚未再次运行。
- [ ] live Zero 尚未验收。
- [ ] 尚未获得 merge/restart/push 授权。

# Gate 0：批准、冻结与失败基线

- [ ] 用户批准本方案。
- [ ] 记录 `affb2cc5389ee19633684f0e4b1ded4f15398bcd` 为 `BASE_SHA`。
- [ ] 确认不恢复或修改已暂停的真实任务 Artifact。
- [ ] 将任务 `b7d330bf-0712-4273-a87c-7b03ad579d7b` 的脱敏时间线保存为验收基线。
- [ ] 固化当前 Research Strategy Payload v1 fixture。
- [ ] 固化当前固定章节 ReportDocument v2 fixture。
- [ ] 断言新 writer 未激活前，当前生产路径行为不变。
- [ ] 确认只有一个 writer 修改集成 worktree。

## Gate 0 完成条件

```text
方案已批准
BASE_SHA已冻结
失败证据已脱敏固化
历史v1行为有回归保护
工作区干净
```

# Phase 1：领域决策与版本化合同

## 1.1 文档和领域语言

- [ ] 新增 `docs/adr/0005-model-directed-typed-report-layout.md`。
- [ ] ADR 明确模型负责语义内容和布局选择，系统负责身份、证据与完整性。
- [ ] ADR 明确 Layout 失败不得导致内容任务失败。
- [ ] ADR 明确禁止任意 Markdown/HTML 成为 Canonical Deliverable。
- [ ] ADR 明确保留 ADR-0004 的答案优先与 Canonical Deliverable 原则。
- [ ] 更新 `CONTEXT.md`，增加“开放式动态报告”“内容块”“布局蓝图”术语。
- [ ] 明确 v1 为历史固定 Payload，v2 为新写入开放式 Payload。

## 1.2 先写失败测试

- [ ] v2 Payload 必须包含 `schemaVersion=research-strategy-content-v2`。
- [ ] v2 Payload 允许不同 Block 数量和顺序。
- [ ] v2 Payload 不要求未请求的策略对象。
- [ ] v2 Model Draft 拒绝 machine-owned 字段。
- [ ] 未知 Block kind 被拒绝。
- [ ] 每种 Block 的必要字段缺失时被拒绝。
- [ ] supported 原子内容无 Evidence 时被拒绝。
- [ ] provisional 原子内容无 validationNeeded 时被拒绝。
- [ ] Mind Model 引用未知局部 nodeKey 时被拒绝。
- [ ] 历史无 schemaVersion 的 Payload 按 v1 读取。
- [ ] 新写入端不能生成 v1。

## 1.3 TypeScript 合同

- [ ] 将当前接口重命名为 `ResearchStrategyReportPayloadV1`。
- [ ] 增加 `ResearchStrategyReportPayloadV2`。
- [ ] 增加 `ResearchStrategyContentDraftV2`。
- [ ] 增加统一 `SupportBinding`。
- [ ] 增加 10 种 `ResearchStrategyContentBlock` 判别联合类型。
- [ ] 增加 `RequestedArtifactBinding` 类型。
- [ ] `ResearchStrategyReportPayload` 改为 v1/v2 union。
- [ ] 所有 switch 对 Block kind 穷尽检查。

## 1.4 JSON Schema

- [ ] 新增 `schemas/deliverables/research-strategy-report-v2.schema.json`。
- [ ] 为 Model Draft 建立不含 machine-owned 字段的 Schema。
- [ ] 对 supported/provisional 使用条件校验。
- [ ] 对每种 Block 使用关闭的 `oneOf` Schema。
- [ ] 所有文本字段拒绝纯空白。
- [ ] 所有数组声明唯一性和必要的 minItems。
- [ ] 保留现有 `research-strategy-report.schema.json` 作为 v1 reader。

## 1.5 Registry 版本能力

- [ ] Deliverable Registry 支持 `write_payload_schema`。
- [ ] Deliverable Registry 支持 `read_payload_schemas`。
- [ ] Deliverable Registry 支持 `synthesis_mode`。
- [ ] `research_strategy_report` 初始继续使用旧 writer，v2 writer 保持 inactive。
- [ ] Registry lint 拒绝缺失 writer、重复 reader 和未知 synthesis mode。
- [ ] System Capabilities 暴露 writer schema 和可读 schema 版本，不暴露本地路径。

## Phase 1 门禁

```bash
pnpm exec tsx --test \
  tests/research-strategy-v2-contract.test.ts \
  tests/research-strategy-contract.test.ts \
  tests/deliverable-registry-v2.test.ts \
  tests/system-capabilities.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
git diff --check
```

- [ ] Phase 1 测试通过。
- [ ] v2 尚未进入生产写入路径。
- [ ] 历史 v1 读取通过。
- [ ] 独立提交 Phase 1。

# Phase 2：开放式 Content Draft

## 2.1 requested artifact 与 Block 映射

- [ ] `executive_answers` 唯一映射到 Direct Answers。
- [ ] `research_report` 映射到 narrative/evidence_findings/comparison_matrix。
- [ ] `strategy_map` 映射到 strategy_map。
- [ ] `mind_model` 映射到 mind_model。
- [ ] `design_principles` 映射到 design_principles。
- [ ] `opportunity_backlog` 映射到 opportunity_backlog。
- [ ] `prioritized_actions` 映射到 prioritized_actions。
- [ ] `channel_strategies` 映射到 channel_strategies。
- [ ] `action_plan` 映射到 action_plan。
- [ ] 映射函数为唯一真相源，Prompt、Validator、Composer 不重复定义列表。

## 2.2 Skill 输出合同

- [ ] `research-strategy-synthesis` Payload Schema 切换到 Content Draft v2。
- [ ] `compose-strategy-report` 只生成语义内容，不生成全局 ID。
- [ ] `compose-strategy-report` 不生成 requestedArtifactBindings。
- [ ] `compose-strategy-report` 不生成 Coverage。
- [ ] `compose-strategy-report` 不生成 Risk 来源身份。
- [ ] `compose-strategy-report` 不生成 Source Pointer 或 Artifact 身份。
- [ ] `self-review` 按 Direct Answer、Block、Evidence 和 requested artifact 审校。
- [ ] Reviewer 输出继续使用 `reviewer-step-output-v1`。

## 2.3 Prompt

- [ ] 修改 `orchestrator/prompts/deliverables/research-strategy-report.md`。
- [ ] 明确只生成 Model Draft 字段。
- [ ] 明确 Block 数量和组合由内容决定。
- [ ] 明确不生成空 Block 或占位章节。
- [ ] 明确未请求对象不强制生成。
- [ ] 明确 supported/provisional 的证据规则。
- [ ] 明确禁止输出 requestedArtifactBindings、Coverage、Risk ID 和 Provenance。

## 2.4 回归测试

- [ ] 只请求 Direct Answers 的任务可产生最小报告。
- [ ] 只请求 Strategy Map 的任务不需要 Mind Model。
- [ ] 同时请求多个产物时，每类至少有一个非空 Block。
- [ ] 不同任务可生成不同 Block 数量和顺序。
- [ ] 空 Block、占位文本和未知 Evidence 被拒绝。
- [ ] 旧 plan 模式和其他 Skill 不受影响。

## Phase 2 门禁

```bash
pnpm exec tsx --test \
  tests/research-strategy-v2-contract.test.ts \
  tests/research-strategy-planning.test.ts \
  tests/skill-output-contract.test.ts \
  tests/skill-execution-contract.test.ts \
  tests/plan-compiler.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
git diff --check
```

- [ ] Content Draft v2 在 compiled Skill 内可生成和验证。
- [ ] 当前生产 Deliverable writer 仍未切换。
- [ ] 独立提交 Phase 2。

# Phase 3：确定性 Canonical Deliverable Assembler

## 3.1 先写失败测试

- [ ] 拒绝未 SEALED 的 Skill Artifact。
- [ ] 拒绝 Task/Plan/Attempt 绑定不一致的 Skill Artifact。
- [ ] 拒绝 hash 不匹配的 Skill Artifact。
- [ ] 拒绝未知 Question ID。
- [ ] 拒绝未知 Evidence ID。
- [ ] 拒绝遗漏 Required Question 的 Direct Answer。
- [ ] 拒绝缺失 requested artifact Block。
- [ ] 拒绝 Reviewer block。
- [ ] pass_with_conditions 自动进入 riskDisclosures 和 limitations/openQuestions。
- [ ] Skill degraded gap 自动进入风险披露。
- [ ] Envelope risk 自动进入风险披露。
- [ ] 模型无法覆盖 machine-owned 字段。

## 3.2 Assembler 实现

- [ ] 新增 `ResearchStrategyDeliverableAssembler` Module。
- [ ] 从已验证 Skill 输出读取 Content Draft v2。
- [ ] 从 Reviewer 输出读取 verdict 和 conditions。
- [ ] 按内容顺序生成稳定 Section-independent Block ID。
- [ ] 按 Block 局部路径生成稳定 item/node ID。
- [ ] 验证 Mind Model 局部节点和边。
- [ ] 根据显式 Question/Evidence 关系生成 FindingGraph。
- [ ] 根据 Direct Answers 和 Action Blocks 生成 Recommendations。
- [ ] 生成 Question Coverage。
- [ ] 生成 Success Criterion Coverage。
- [ ] 生成 requestedArtifactBindings。
- [ ] 生成并精确传播 riskDisclosures。
- [ ] 合并 limitations/openQuestions，保持来源身份。
- [ ] 生成 Capability Provenance。
- [ ] 写入前运行 Payload、Answer Quality、Evidence 和 Envelope 校验。
- [ ] 只在全部通过后写 SEALED Deliverable。

## 3.3 删除重复生成

- [ ] `CurrentDeliverableService` 按 Registry 的 `synthesis_mode` 路由。
- [ ] `research_strategy_report` 使用 `reviewed_skill_assembly`。
- [ ] 该路径不调用大型 Deliverable LLM。
- [ ] 其他 Deliverable 继续使用 `model_synthesis`。
- [ ] Model receipt 测试断言答案型任务不存在重复全文重写调用。
- [ ] 实际 Step 8 内容完整进入 Canonical Deliverable，不被再次改写。

## 3.4 Answer Quality Validator v2

- [ ] 从固定顶层数组校验迁移为按 Block kind 校验。
- [ ] Required Question 覆盖保持 fail closed。
- [ ] requested artifact 只按显式映射验证。
- [ ] Evidence 完整性按原子内容验证。
- [ ] 风险一致性保持 fail closed。
- [ ] v1 Validator 保留给历史兼容。

## Phase 3 门禁

```bash
pnpm exec tsx --test \
  tests/research-strategy-deliverable-assembler.test.ts \
  tests/research-strategy-v2-contract.test.ts \
  tests/current-deliverable-service.test.ts \
  tests/research-strategy-contract.test.ts \
  tests/report-review-service.test.ts \
  tests/synthesis-materializer.test.ts
pnpm typecheck
pnpm lint:registry
git diff --check
```

- [ ] 新路径不进行第二次全文模型生成。
- [ ] Canonical Deliverable 只包含已验证 Skill 内容和机器生成元数据。
- [ ] 其他 Deliverable 无回归。
- [ ] 独立提交 Phase 3。

# Phase 4：模型 Layout Blueprint 与确定性 fallback

## 4.1 Blueprint 合同

- [ ] 新增 `schemas/report-layout-blueprint.schema.json`。
- [ ] 新增 `ReportLayoutBlueprintV1` TypeScript 类型。
- [ ] Blueprint 只允许 section title、purpose、prominence 和 blockRefs。
- [ ] Blueprint 不允许正文、结论、Evidence 文本或自由 Markdown。
- [ ] 所有 Section 必须非空。
- [ ] 所有 Block Ref 必须唯一且存在。

## 4.2 Layout Planner

- [ ] 新增 `ReportLayoutPlanner` Module。
- [ ] 输入只包含 Review 通过的 Canonical Content Index。
- [ ] 输入不包含未经 Review 的 Step Artifact。
- [ ] 输入不包含完整 Prompt、凭据或原始敏感材料。
- [ ] 模型可决定章节标题、数量、顺序和 Block 分组。
- [ ] Direct Answers 必须位于第一个 primary 区域。
- [ ] requested artifact Block 不得进入 appendix。
- [ ] 每个 Canonical Content Block 在 full 报告中出现一次。

## 4.3 Fallback

- [ ] 新增确定性 Layout fallback。
- [ ] Gateway 超时触发 fallback。
- [ ] 非法 JSON 触发 fallback。
- [ ] 未知或重复 Block Ref 触发 fallback。
- [ ] 遗漏 Block 触发 fallback。
- [ ] 错误顺序或空 Section 触发 fallback。
- [ ] fallback 不调用另一个模型。
- [ ] fallback 不改变 Canonical Deliverable。
- [ ] fallback 不把任务置为 paused。
- [ ] Report Package 标记 `layoutMode=fallback` 和脱敏 warning。

## 4.4 Layout 测试

- [ ] 两个合法但不同的 Blueprint 均通过。
- [ ] Blueprint 的模型章节顺序被完整保留。
- [ ] Blueprint 不能写新内容。
- [ ] Blueprint 不能丢失 Canonical Block。
- [ ] Blueprint 不能把 Direct Answers 后置。
- [ ] 任意 Layout 失败都产生可用 ReportDocument。

## Phase 4 门禁

```bash
pnpm exec tsx --test \
  tests/report-layout-planner.test.ts \
  tests/research-strategy-report-projector.test.ts \
  tests/dynamic-report-composer.test.ts \
  tests/report-document.test.ts
pnpm typecheck
git diff --check
```

- [ ] Layout 模型只排版，不写内容。
- [ ] Layout 失败不会导致任务失败。
- [ ] 独立提交 Phase 4。

# Phase 5：ReportDocument、多端和历史兼容

## 5.1 Composer

- [ ] 新增 `ResearchStrategyReportProjector` Module。
- [ ] 按 Blueprint 顺序投影 Canonical Block。
- [ ] 删除固定插入所有业务章节的逻辑。
- [ ] Direct Answers 保持答案优先。
- [ ] Limitations/Open Questions 保持可见。
- [ ] Evidence Appendix 保持末尾。
- [ ] Source Pointer、Finding/Summary ID 和 Evidence ID 由系统生成。
- [ ] full projection 覆盖每个 Canonical Content Block。
- [ ] ReportDocument v2 Schema 无需升级。

## 5.2 Web

- [ ] 页面导航按实际 `sections[]` 渲染。
- [ ] 不依赖固定 `strategy-map`、`priority-actions` 等 Section ID。
- [ ] 页签分类按 Block kind/prominence 派生。
- [ ] 默认视图首先展示 Direct Answers。
- [ ] 未请求的产物不显示空卡片。
- [ ] Evidence Disclosure 保持可用。
- [ ] 打印/PDF 保持 Blueprint 顺序。

## 5.3 Markdown 与 ZIP

- [ ] `full-report.md` 按 Blueprint 顺序输出。
- [ ] `direct-answers.md` 保持稳定。
- [ ] `analysis-notes.md` 只包含 Canonical 内容。
- [ ] ZIP 包含 Layout Blueprint 或 fallback 元数据。
- [ ] 不输出未经 Review 的原始 Step 文本。

## 5.4 Zero

- [ ] Zero renderer 按 ReportDocument 顺序渲染。
- [ ] Zero 不依赖固定 Section ID。
- [ ] 每种 Block kind 有稳定降级显示。
- [ ] 不生成空 Section。
- [ ] Evidence、图片和 Chart 安全规则保持不变。

## 5.5 兼容

- [ ] v1 Strategy Payload 使用 legacy composer。
- [ ] v2 Strategy Payload 使用 Blueprint projector。
- [ ] ReportDocument v1/v2 均可读取。
- [ ] 历史 Report Package 不要求 Layout 字段。
- [ ] 历史 SEALED Artifact 不被重写。

## Phase 5 门禁

```bash
pnpm exec tsx --test \
  tests/research-strategy-report-projector.test.ts \
  tests/report-document.test.ts \
  tests/current-report-markdown.test.ts \
  tests/report-bundle.test.ts \
  tests/report-package.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/current-flow-state.test.ts
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

- [ ] Web、Markdown、ZIP、Zero 顺序一致。
- [ ] v1/v2 历史读取无回归。
- [ ] 独立提交 Phase 5。

# Phase 6：诊断、进度和无整任务时限

## 6.1 校验诊断

- [ ] 新增 `deliverable-validation-diagnostic-v1` 类型。
- [ ] 使用现有 Artifact Store 保存诊断，不新增数据库表。
- [ ] 记录 stage、round、code、jsonPointer、脱敏限长 message。
- [ ] 不保存完整 Prompt。
- [ ] 不保存完整失败响应。
- [ ] 不保存凭据、PII 或原始用户材料。
- [ ] Content 错误可反馈给受限修复流程。
- [ ] Layout 错误只记录并 fallback。

## 6.2 Smoke 进度

- [ ] `scripts/current-real-smoke.ts` 输出 Task ID。
- [ ] 输出 Plan Version 和 Attempt ID。
- [ ] 输出每个 Step 的开始、完成和耗时。
- [ ] 输出 Model stage 和 requested/actual model。
- [ ] 输出 Content/Assembler/Layout/Review/Compose/Package 阶段。
- [ ] 输出脱敏校验错误码，不输出原始模型正文。
- [ ] 支持从另一个终端只读查询任务进度。

## 6.3 时间规则

- [ ] 删除真实验收操作手册中的 20 分钟整任务限制。
- [ ] 实际运行命令不设置整任务 shell/tool timeout。
- [ ] 保留 `LLM_GATEWAY_TIMEOUT_MS` 单调用限制。
- [ ] 保留 Tool manifest 单调用限制。
- [ ] 保留数据库错误和 Lease heartbeat。
- [ ] 保留用户主动取消能力。
- [ ] 测试证明总运行超过20分钟时不会被系统主动终止。
- [ ] 测试证明单个 Gateway 永久无响应时仍会超时并留下结构化失败。

## Phase 6 门禁

```bash
pnpm exec tsx --test \
  tests/current-real-smoke.test.ts \
  tests/gateway-llm-receipt.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/execution-recovery.test.ts \
  tests/current-deliverable-service.test.ts
pnpm typecheck
git diff --check
```

- [ ] 无整任务 20 分钟限制。
- [ ] 单调用故障仍有界。
- [ ] 每次内容校验失败可复盘。
- [ ] 独立提交 Phase 6。

# Phase 7：Activation

- [ ] 将 `research_strategy_report` writer 切换为 v2。
- [ ] 将 synthesis mode 切换为 `reviewed_skill_assembly`。
- [ ] 激活 Layout Blueprint Planner。
- [ ] System Capabilities 显示 v2 writer、v1/v2 readers 和 Blueprint v1。
- [ ] 保留一键切回 v1 writer 的 Registry 配置路径。
- [ ] 不修改其他 Deliverable writer。
- [ ] 更新开发方案、TodoList 和 ADR 的实施状态。

## Phase 7 门禁

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm --dir apps/web build
pnpm quality
git diff --check
```

- [ ] 全量测试通过。
- [ ] Worktree 干净。
- [ ] 新写入只产生 v2 Payload。
- [ ] 历史 v1 仍可读取。
- [ ] 独立提交 Activation。

# Gate 8：源码独立审查

- [ ] 审查模型与系统字段所有权。
- [ ] 审查 Canonical Deliverable 真相源边界。
- [ ] 审查 Evidence 和 Question 绑定。
- [ ] 审查 requested artifact 覆盖。
- [ ] 审查 Reviewer 条件与风险传播。
- [ ] 审查 Layout 不可新增事实。
- [ ] 审查 fallback 不会隐藏 Content 失败。
- [ ] 审查 v1/v2 兼容。
- [ ] 审查 Web/Markdown/Zero 一致性。
- [ ] 审查敏感信息和诊断 Artifact。
- [ ] 审查其他 Deliverable 无回归。
- [ ] Blocker/High/Medium 全部关闭后给出 READY。

# Gate 9：真实环境验收

## 9.1 启动前

- [ ] 使用原项目 `.env`，不复制、不打印、不提交密钥。
- [ ] `ALLOW_REAL_PROVIDER=1`。
- [ ] `LLM_PROVIDER=gateway`。
- [ ] `TOOL_ADAPTER=real`。
- [ ] 验证开发 Seed User 存在且 active。
- [ ] 验证 Gateway 和数据库可达。
- [ ] 验证真实 Tavily 可达。
- [ ] 确认运行命令没有整任务 timeout。
- [ ] 确认只有一个真实任务在运行。

## 9.2 真实任务

- [ ] 使用 `tests/fixtures/research-synthesis-real-smoke.json`。
- [ ] 创建新的 answer 模式任务，不复用已暂停 Artifact。
- [ ] Requirement v2 持久化。
- [ ] `task_type=research_synthesis`。
- [ ] `deliverableType=research_strategy_report`。
- [ ] Current Plan v2 和 compiled Skill invocation 存在。
- [ ] 真实 Tavily Tool receipt 有效。
- [ ] Knowledge Artifact 有效。
- [ ] compiled Skill 输出 Content Draft v2。
- [ ] Step Reviewer 输出结构化 verdict/conditions。
- [ ] 不存在第二次大型全文 Deliverable 生成调用。
- [ ] Canonical Deliverable v2 SEALED。
- [ ] Required Questions 全部有 Direct Answer。
- [ ] requested artifacts 全部由类型化 Block 满足。
- [ ] FindingGraph、Coverage、Risk 和 Bindings 均为系统生成。
- [ ] Report Review 通过或按明确质量规则暂停。
- [ ] Layout Blueprint 有效，或明确 fallback。
- [ ] ReportDocument v2 SEALED。
- [ ] Report Package SEALED。
- [ ] 任务达到 completed 或 completed_with_gaps。

## 9.3 多端验收

- [ ] 浏览器默认显示 Direct Answers。
- [ ] 章节标题、数量和顺序来自 Blueprint。
- [ ] 不显示未请求产物的空章节。
- [ ] Strategy Map、Mind Model、Principles、Opportunities 和 Actions 可读。
- [ ] Evidence 和 Confidence 可追溯。
- [ ] Markdown/ZIP 内容与 Web 一致。
- [ ] 打印/PDF 顺序一致。
- [ ] live Zero 可用时完成真实发布。
- [ ] live Zero 不可用时记录明确外部门禁例外，不标记通过。

## Gate 9 完成条件

```text
真实Gateway成功
真实数据库持久化成功
真实Tavily成功
Canonical Deliverable v2成功
动态或fallback ReportDocument成功
Report Review与Package成功
无整任务超时
真实多端验收完成
```

# Gate 10：一次性合并与重启

- [ ] 确认所有 Phase 均在统一集成分支。
- [ ] 确认 Skill Runtime 父分支未单独合并。
- [ ] 确认 main 的独立修改已保护且不会被覆盖。
- [ ] 获取明确 merge/restart 授权。
- [ ] 一次性合并到 `main`。
- [ ] 不执行未经授权的 push。
- [ ] 重启 Agent API。
- [ ] 重启 Web。
- [ ] 调用 `/api/system/capabilities` 验证实际运行版本。
- [ ] 验证 writer v2、legacy readers 和 Layout Blueprint v1。
- [ ] 在更新后的 `main` 创建一条 answer 模式任务。
- [ ] 验证完成页和历史页均显示新报告。
- [ ] 记录最终 commit、运行 Task ID、Attempt ID 和 Artifact ID。

# 回滚清单

- [ ] 保留 v2 reader。
- [ ] Registry writer 切回 v1。
- [ ] synthesis mode 切回 `model_synthesis`。
- [ ] Layout Planner 关闭后使用 legacy/fallback composer。
- [ ] 不修改历史 SEALED Artifact。
- [ ] 不回滚 Requirement Schema 传递修复。
- [ ] 不回滚 Skill Runtime、Knowledge、Tool 和安全修复。
- [ ] 回滚后运行 v1/v2 历史读取测试和全量质量门禁。

# 完成账本

```text
plan approved                                      done
baseline frozen                                    done
ADR and domain terms                               done
content v2 schema                                  done
model draft / machine metadata split               done
requested artifact to block mapping                done
reviewed Skill assembly                            done
duplicate full-report LLM removed                  done
canonical IDs/FindingGraph/Coverage/Risk derived   done
layout blueprint                                   done
layout fallback                                    done
hard-coded business sections removed for v2        done
ReportDocument v2 retained                         done
Web/Markdown/ZIP/Zero source paths aligned          done
legacy v1/v2 compatibility                         done
sanitized diagnostics                              done
20-minute whole-run timeout removed                done
per-call safety timeout retained                   done
full quality gate                                  done
independent source review                          pending
real Gateway/DB/Tavily acceptance                  pending final rerun
live Zero acceptance or explicit exception         pending
single merge/restart authorization                 withheld
push authorization                                 withheld
```
