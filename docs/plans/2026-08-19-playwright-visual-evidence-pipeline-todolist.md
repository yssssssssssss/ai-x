# Playwright 网页视觉证据链 TodoList

> 开发真相源：`docs/plans/2026-08-19-playwright-visual-evidence-pipeline-development.md`。
>
> 规则：本清单只记录执行状态和验证证据，不承载接口或架构决策。若清单与开发文档冲突，以开发文档为准，先修正文档再继续开发。
>
> 依赖顺序：`A -> B -> C`、`B -> D`。C 与 D 在 B 完成后可交换顺序，但必须保持独立提交、独立验证和独立回滚。
>
> 记录要求：每个勾选项在同一行末尾补充结果、命令摘要、commit SHA、构建链接或发布证据路径。不得仅写“完成”。

## 0. 开发前门禁

- [x] 读取开发文档第 1、4、5、15、18、19、21 节，确认范围、非目标、工作包、运行要求、发布顺序和完成定义未发生漂移。结果：无漂移。
- [x] 执行 `git status --short` 和 `git diff --check`，记录当前基线；不得覆盖、清理或夹带 `docs/development/` 等用户已有内容。结果：格式检查通过；用户已有迁移指南保持未跟踪且未纳入本任务提交。
- [x] 将开发文档与本清单作为独立文档变更提交；后续业务工作包不得夹带方案改写。结果：本次文档提交只包含两份计划文档，测试基线修复已独立提交为 `ccda155`。
- [x] 切换到 Node 22，记录 `node --version` 与 `pnpm --version`；Node 主版本低于 22 时停止。结果：Node `v22.22.1`，pnpm `9.12.1`。
- [x] 确认 `orchestrator/tool-registry.yaml` 中 Playwright Tool 尚未激活，当前进程未设置 `PLAYWRIGHT_CAPTURE_ENABLED=1`。结果：Tool 尚未注册，功能开关未设置。
- [x] 在业务代码改动前运行 `pnpm quality`，记录测试通过、跳过和失败数量。结果：1204 通过、11 跳过、0 失败；typecheck、Registry linter 与 Knowledge linter 均通过。
- [x] 在业务代码改动前运行 `pnpm --dir apps/web build`，记录结果。结果：通过，652 个模块完成构建。

### 门禁 0

- [x] 文档已独立提交，工作树中的无关改动已明确归属且不会进入本任务提交。结果：两份计划文档独立提交；用户迁移指南未纳入。
- [x] Node 22、基线 quality 和 Web build 均通过。结果：PASS。
- [x] Playwright 尚未注册或 Registry 保持 `draft`，功能开关保持关闭。结果：尚未注册，开关关闭。

## 1. 工作包 A：浏览器 Tool 与 sidecar 合同

文件范围以开发文档第 14.1 节为准，验收语义以第 7.1、7.3、8、9、13 节为准。

- [ ] 增加并锁定 Playwright 运行依赖和 Chromium 安装命令；运行时不得自动联网下载浏览器。
- [ ] 实现 Worker 级共享 `BrowserExecutionGate`，所有生产 Runtime 复用同一实例；测试可注入隔离实例。
- [ ] 固定并验证 2 个活跃 Browser、8 个排队调用、10 秒排队超时，所有退出路径均释放配额。
- [ ] 将同一个 `AbortSignal` 和 90 秒总 deadline 贯穿排队、重试、浏览器执行和 Artifact 发布。
- [ ] 保持 `lease_lost` 与 `deadline_exceeded` 两种终止原因可区分。
- [ ] 实现 Playwright Adapter、URL/重定向网络策略、资源上限、确定性截图策略和最外层资源清理。
- [ ] 强制非 root、`chromiumSandbox: true`、`serviceWorkers: 'block'`、WebSocket 阻断和下载禁用；不提供无沙箱回退。
- [ ] Tool JSON 只保存元数据和失败信息；确认其中没有 Buffer、Base64、Cookie、HTML、临时路径或媒体字节。
- [ ] Registry 保持 `draft`，Adapter 只在 `PLAYWRIGHT_CAPTURE_ENABLED=1` 时注册。
- [ ] CI 使用真实 Chromium 打开 `about:blank` 并通过 `page.setContent()` 注入内存 fixture，不开放 loopback 或公网。
- [ ] 运行 `pnpm exec tsx --test tests/browser-execution-gate.test.ts tests/playwright-page-capture-adapter.test.ts tests/tool-retry-policy.test.ts tests/schema.test.ts tests/registry-linter.test.ts`。
- [ ] 运行 `pnpm typecheck` 和 `pnpm lint:registry`。
- [ ] 检查工作包 A diff 并提交独立 commit，记录 SHA。

### 门禁 A

- [ ] 并发、排队、取消、重试、超时和资源泄漏测试全部通过。
- [ ] CI fixture 不访问网络，默认配置不会启动 Chromium。
- [ ] 工作包 A 可独立回滚且不改变现有文本研究路径。

## 2. 工作包 B：原子视觉资产发布

文件范围以开发文档第 14.2、14.3、14.4 节相关条目为准，验收语义以第 7.4、7.7、10、11.1、13 节为准。

- [ ] 保持 V1 类型和 Schema 不变，先实现并部署 V2 Reader，再开放任何 V2 Writer 路径。
- [ ] 实现 `ArtifactPublicationGroup`，统一登记、提交、补偿和复核 Tool JSON、Binary、Manifest 与 Evidence。
- [ ] 实现 `browser_capture` V2 Writer，并校验 attachment ID、JSON pointer、媒体类型、尺寸和三处 SHA-256 一致。
- [ ] Tool JSON、媒体或 Manifest 任一发布失败时，使同批已写 Artifact 全部失效，步骤不得成功。
- [ ] 任一补偿失效失败必须冒泡为 `artifact_invalidation` 并暂停任务，不得吞掉错误。
- [ ] deadline 或租约在不可中断写入期间到期时，写入返回后立即登记并补偿该 Artifact。
- [ ] 生成并复核截图 Evidence，确保来源 URL、Tool Artifact、Visual Asset Manifest 和内部资产可反查。
- [ ] 将 V2 读取加入 API、Report Package、恢复与终止失效路径；不得新增数据库迁移。
- [ ] 使用注入的 Tool StepResult 与媒体 sidecar 完成 Engine 集成测试，Registry 继续保持 `draft`。
- [ ] 运行 `pnpm exec tsx --test tests/artifact-publication-group.test.ts tests/visual-asset-service.test.ts tests/lease-execution-engine.test.ts tests/execution-recovery.test.ts tests/report-package.test.ts tests/report-bundle.test.ts tests/control-api-integration.test.ts tests/auth-isolation.test.ts`。
- [ ] 运行 `pnpm typecheck` 和 `pnpm --dir apps/web build`。
- [ ] 检查工作包 B diff 并提交独立 commit，记录 SHA。

### 门禁 B

- [ ] V1 历史报告读取回归通过，混合 V1/V2 Report Package 可读取。
- [ ] 发布失败、补偿失败、租约丢失和 deadline 到期均不存在半发布资产。
- [ ] V2 Reader 已可独立保留，Writer 回滚不影响已生成历史报告。

## 3. 工作包 C：optional Planning 与网页视觉报告

文件范围以开发文档第 14.2、14.3、14.4、14.5 节相关条目为准，验收语义以第 7.2、7.5、11、13、17 节为准。

- [ ] 为 Skill Registry、Loader、Linter、Capability Resolution 和 Current Plan 增加向后兼容的 `optional_tools` 合同。
- [ ] required Tavily 不可用时继续拒绝；draft/deprecated Playwright 不产生 gap；active unavailable Playwright 只产生可降级 capability gap。
- [ ] 旧 Current Plan 缺少新增 optional 字段时规范化为空数组，新计划显式写出这些字段。
- [ ] 生成 Tavily `/results` 到 Playwright `/pages` 的精确绑定，并强制执行顺序为 Tavily、Playwright、Skill。
- [ ] Registry 回滚后，新计划不产生 Playwright step/gap；已冻结的 optional step 按 configuration gap 跳过。
- [ ] 只从 Tool JSON `failures` 或全失败 execution details 生成页面失败；`gapSummary` 只保存脱敏计数索引。
- [ ] 增加并严格校验 `visualEvidence`，同时绑定 screenshot Evidence 与相同 URL 的 public source Evidence。
- [ ] ReportDocument、Web、Markdown 和打印导出支持单图证据、证据编号和内部资产地址，不使用外部热链或 Base64。
- [ ] 报告大标题中英文并列，每章首 Block 解释模块目的，Dimension Matrix 每个维度只有一个整合 Block 并包含跨维度总结。
- [ ] 历史任务刷新后复用同一 Report Package，图片、证据编号和 gapCount 不漂移。
- [ ] Smoke 使用 `competitive-ai-shopping-assistant` 精确场景，不再隐式选择 profile 第一条场景。
- [ ] 运行 `pnpm exec tsx --test tests/capability-resolver.test.ts tests/skill-loader-schema.test.ts tests/registry-linter.test.ts tests/plan-compiler.test.ts tests/current-plan-candidate-schema.test.ts tests/direct-invoke-plan.test.ts tests/current-step-bindings.test.ts tests/checkpoint-resume.test.ts tests/control-planning.test.ts tests/current-deliverable-service.test.ts tests/report-document.test.ts tests/report-bundle.test.ts tests/current-flow-state.test.ts tests/current-real-smoke.test.ts`。
- [ ] 运行 `pnpm typecheck`、`pnpm lint:registry` 和 `pnpm --dir apps/web build`。
- [ ] 检查工作包 C diff 并提交独立 commit，记录 SHA。

### 门禁 C

- [ ] Playwright 失败只使任务进入 `completed_with_gaps`，Tavily required evidence 失败仍不得完成。
- [ ] 报告单图、双 Evidence、双语标题、模块目的、整合矩阵和历史重读测试全部通过。
- [ ] Registry 仍为 `draft` 时，旧任务和文本任务行为不变。

## 4. 工作包 D：数据驱动图表 lineage

文件范围以开发文档第 14.2、14.3、14.4 节相关条目为准，验收语义以第 7.6、10、12、13、17 节为准。

- [ ] 删除图表对第一张用户上传图片的依赖，使用已封存 Chart Data Artifact 作为唯一数据来源。
- [ ] 实现 V2 `chart_render`，校验数据 Artifact 哈希、Chart Spec、表格数据、SVG 和 specHash 一致。
- [ ] 只读取唯一冻结 `competitive-web-research` Skill step 的 `/input/scoring_weights`，删除递归权重发现。
- [ ] 计划页直接只读展示同一字段；确认请求不得携带或改写第二份权重状态。
- [ ] 没有冻结权重时不生成空图、竞品评分、趋势或市场份额图。
- [ ] 图表发布纳入 Publication Group、恢复和终止失效范围。
- [ ] 运行 `pnpm exec tsx --test tests/artifact-publication-group.test.ts tests/competitive-weight-chart.test.ts tests/chart-renderer.test.ts tests/lease-execution-engine.test.ts tests/execution-recovery.test.ts tests/control-plane.test.ts tests/report-document.test.ts tests/report-package.test.ts tests/candidate-layout.test.ts`。
- [ ] 运行 `pnpm typecheck` 和 `pnpm --dir apps/web build`。
- [ ] 检查工作包 D diff 并提交独立 commit，记录 SHA。

### 门禁 D

- [ ] 无用户上传图片时，已冻结权重仍能生成可追溯 SVG。
- [ ] 图表数值、标签、数据 Artifact 和 Manifest 任一漂移均 fail closed。
- [ ] 工作包 D 可独立回滚，V2 Reader 必须保留。

## 5. 合并前验证

- [ ] 确认 A、B、C、D 均为独立 commit，依赖顺序正确且没有后续工作包补前序测试。
- [ ] 运行 `pnpm quality`，记录测试通过、跳过和失败数量。
- [ ] 运行 `pnpm --dir apps/web build`。
- [ ] 运行 `git diff --check`，确认没有格式错误、占位符或意外生成物。
- [ ] 回归旧 Current Plan、V1 Report Package、纯文本研究任务和没有 Playwright Adapter 的降级路径。
- [ ] 确认 Tool JSON、日志、数据库和 Smoke receipt 中没有媒体 Base64、Cookie、Bearer token、完整 HTML 或未脱敏错误正文。
- [ ] 确认 Registry 仍为 `draft` 且 `PLAYWRIGHT_CAPTURE_ENABLED` 未设置；代码合并不得自动激活公网截图。

### 门禁 5

- [ ] 全量 quality、Web build、兼容性、安全、恢复和降级测试通过。
- [ ] 默认部署仍只提供 Tavily + Skill 文本研究路径。
- [ ] 代码合并和生产 Tool 激活保持两个独立动作。

## 6. 生产激活门禁

- [ ] 平台负责人提供 Worker 非 root 运行证据。
- [ ] 平台负责人提供 Chromium sandbox 实际生效证据。
- [ ] 平台负责人提供阻断 IPv4/IPv6 私网、loopback、link-local、CGNAT、保留地址和云元数据地址的 egress policy 证据。
- [ ] 在受保护 canary 配置中将 Registry 切换为 `active`，并在进程启动前设置 `PLAYWRIGHT_CAPTURE_ENABLED=1`。
- [ ] 重启所有加载 Registry 或构造 ToolRouter 的 canary runtime 进程。
- [ ] 确认 Capability Resolution 将 Playwright 判定为 available，且 required Tool 仍只有 Tavily。
- [ ] 执行 `PLAYWRIGHT_CAPTURE_ENABLED=1 CURRENT_SMOKE_PROFILE=competitive_research CURRENT_SMOKE_SCENARIO=competitive-ai-shopping-assistant CURRENT_REQUIRE_BROWSER_EVIDENCE=1 ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm smoke:current:real`。
- [ ] 记录 taskId、planVersionId、attemptId、Tool Artifact、Visual Asset、Evidence Manifest、Deliverable、Report Package ID 和各项计数。
- [ ] 人工打开全部视觉来源，确认至少 3 个可访问平台各有 1 张有效截图；不可访问平台逐项形成 gap。
- [ ] 人工确认报告五个维度、双语标题、模块目的、整合矩阵、评分权重图、关键来源和历史任务重读均满足开发文档第 17 节。
- [ ] 由独立研究员确认图片支持相邻结论、图表口径诚实、缺口完整披露。

### 门禁 6

- [ ] 三项平台安全证据齐备，真实视觉 Smoke 与人工评审均通过。
- [ ] 未使用普通 GitHub-hosted runner 或未验证开发机访问真实目标站点。
- [ ] 扩大部署前已准备并复核第 7 节回滚配置。

## 7. 回滚演练

- [ ] 将 Registry 恢复为 `draft`，取消 `PLAYWRIGHT_CAPTURE_ENABLED`，重启相同 runtime 进程。
- [ ] 确认新计划不再生成 Playwright step 或 Playwright gap。
- [ ] 确认回滚前已冻结的 optional Playwright step 按 configuration gap 跳过，不阻断文本报告。
- [ ] 确认已生成的 V2 浏览器截图和图表历史报告仍可读取。
- [ ] 确认回滚不删除 Artifact、任务或长期审计记录。
- [ ] 记录回滚和恢复 canary 配置的命令、结果与负责人。

### 门禁 7

- [ ] Writer 与 Tool 激活可关闭，V2 Reader 保持可用。
- [ ] 回滚后文本研究恢复，历史视觉报告无损。
- [ ] 未执行破坏性数据清理。

## 8. 完成确认

- [ ] 开发文档第 21 节全部完成条件均有对应测试、构建、运行或人工证据。
- [ ] A、B、C、D 的 commit、测试收据和回滚边界完整可审计。
- [ ] 真实验收任务的来源、截图、图表、状态、gap、历史重读和导出均通过。
- [ ] 生产启用范围、平台安全证据、Smoke 结果、独立研究员结论和回滚结果均已归档。
- [ ] 最终执行 `git status --short`，确认没有遗漏文件或意外生成物。
