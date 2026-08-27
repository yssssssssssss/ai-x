# Editorial Report 后置编排能力开发文档

> 状态：Phase 1 已在 main 完成；Phase 2 工程实现已完成但尚未通过真实 Gateway、真实 corpus、人工视觉
> rubric 与全量质量门禁，因此仍处于“可测试、不可发布”状态，不能宣称第 30 节定义的完整 V1 已完成。
>
> Phase 2 开发基线：`main@49e4b7f`（2026-08-27，标签 `单skill版本-报告优化-0827`）。本轮实现只基于
> main，不切换或吸收其他分支代码。
>
> 参考样例：`/Users/heyunshen/work/PROJECT/jdc/ai-x-answer-reports/run-workspaces/current-control/tasks/055a2658-8b6c-4bd7-9078-43636feb9df7/attempts/105dbbe2-1e92-47a0-8062-0e2da78fea4e/reports/crowdfunding-editorial-report-demo.html`。
>
> 本文是 V1 的设计真相源。能力必须在 main 报告完成后独立运行；不得改变原任务、执行 Attempt、Report Package 或现有报告流程。

## 0. Phase 1 实施记录（2026-08-27）

Phase 1 当时以 `main@5465e62` 为开发起点，最终交付在 `main@49e4b7f`。该阶段完成了第 22 节 Phase 1：
对 main 已完成并封存的 `report-package-v1` 做只读解析、确定性 Material 化、组件编排、安全渲染和
sidecar 原子发布。正式入口为：

```bash
pnpm editorial:report -- --task-id <UUID>
```

Phase 1 的 `EditorialModelPort` 固定为 `{client:null, configuration:null}`，模型调用数必须为 0；输出
状态为 `degraded / deterministic_fallback` 是设计语义，不代表生成失败。自适应 LLM Blueprint、
独立 Fidelity Review、真实 Gateway 准入和 `editorial:calibrate` 在 Phase 1 交付时尚未实施；当前虽已
完成 Phase 2 工程代码，仍不能把 Phase 1 的历史验收描述成完整 LLM 编辑能力验收。

### 0.1 已落地能力

- 严格的 Material、Model Context、Blueprint、Diagnostic、Report 与 manifest 合同及 JSON Schema。
- 对 main 五类 active deliverable 的显式 Materializer；无 projector 的新类型 fail closed。
- SourceReader 只读取当前完成任务的 SEALED V1 Report Package，并在 Artifact 查询窗口前后执行
  task/binding fence，阻止 TOCTOU。
- 固定 Blueprint 与确定性 HTML Renderer；正文支持决策封面、指标卡、事实／推断／未知、卡片、
  Flow、Roadmap、风险、验证、视觉画廊和审计附件，并只按材料资格渲染非空组件。
- HTML 无脚本和外部运行时依赖，可通过 `file://` 离线打开，支持 390px、1440px 和 A4 打印。
- 屏幕端默认折叠完整审计附件，保留原生鼠标与键盘展开能力；A4 打印通过固定 CSS 强制展示全部
  审计内容，避免追溯完整性压过日常阅读主线。
- Sidecar Store 只写 `run-workspaces/editorial-reports/`；采用 owner-only 权限、request lock、staging、
  publish fence、manifest-last 原子发布与内容寻址幂等复用。
- Store 不只校验文件 hash：会从 Material 重建确定性 Blueprint，重放 Renderer，并重建 Phase 1
  Diagnostic 后逐字节比较，拒绝协同篡改 Blueprint、HTML、Diagnostic 和 manifest 的缓存。
- 失败 Diagnostic 在发布前校验完整 task/plan/attempt/package binding，并在 fence 后重读 staging。
- 共享 `VerifiedVisualAssetReader` 只暴露验证读取能力；原 `VisualAssetService.readVerified()` 委托该
  reader，main 既有调用语义不变。
- 成功 CLI 集成测试使用真实 PostgreSQL 和 Artifact Store，证明 task、attempt、artifact、整张
  `control_model_calls` 表及 `current-control` 文件在运行前后 byte-for-byte 不变。

### 0.2 实施验收

| 验收项 | 本轮结果 |
|---|---|
| Phase 1 九文件定向门禁 | 187 tests：186 pass、0 fail、1 个默认关闭的 Playwright skip |
| 独立 Chromium 合同（`PLAYWRIGHT_CONTRACT=1`） | 13/13 pass，覆盖桌面、移动端、键盘、离线请求阻断与 A4 PDF |
| `pnpm typecheck` | 在 Node 22.22.1 下通过 |
| `git diff --check` | 通过 |
| 第 23.4 节六文件主链 | 227 tests：224 pass、2 fail、1 skip；两项失败与本节记录的既有 `control-api-integration` 基线完全一致 |
| `pnpm quality` | Node 22.22.1 下 typecheck 与两项 lint 通过；1684 tests：1668 pass、3 fail、13 skip，详见下节 |

Chromium 验收产物位于 gitignore 目录：

- `run-workspaces/editorial-report-acceptance/editorial-desktop-1440x1000.png`
- `run-workspaces/editorial-report-acceptance/editorial-mobile-390x844.png`
- `run-workspaces/editorial-report-acceptance/editorial-a4.pdf`

### 0.3 真实 main V1 验收与版本边界

main 原生 V1 任务 `e16880e3-21c2-4541-9e38-fc750185ee4b` 已连续运行两次，两次返回相同
`requestKey` 与 `generationId`，证明缓存复用幂等；模型调用数为 0：

```text
requestKey:   erq_5647fe64dd338008d2514f7b3323d8f38e52f6e433257640a8549ee5441e1c63
generationId: er_458b764dc58fcafb61bea533fd07ff27086c3005cc984d76db105a2ec60700f1
report:       run-workspaces/editorial-reports/tasks/e16880e3-21c2-4541-9e38-fc750185ee4b/attempts/70bac736-5ad5-4224-b46e-fc3b5273d99e/requests/erq_5647fe64dd338008d2514f7b3323d8f38e52f6e433257640a8549ee5441e1c63/fallback/editorial-report.html
```

该真实报告最终渲染了 `decision-cover`、`metric-cards`、`truth-triad`、`narrative`、`card-grid`、
`flow`、`roadmap` 与 `audit-appendix`。它说明 Phase 1 已能把现有结果变成更多元的专业页面，但不应
与 Phase 2 的材料自适应 LLM 叙事混为一谈。

参考 Demo 对应任务 `055a2658-8b6c-4bd7-9078-43636feb9df7` 的已封存输入来自另一工作区，采用
`report-review-v2` / `report-document-v2`；固定 main 只定义 V1，因此当前入口按合同返回
`SOURCE_INTEGRITY_INVALID`，且不会为追随其他分支而放宽 main 的输入边界。参考 Demo 仍只作为
视觉和阅读节奏样板。

### 0.4 尚未解除的非 Editorial 门禁

Node 22.22.1 下，2026-08-28 的最新 `pnpm quality` 共发现 1741 tests：1725 pass、3 fail、13 skip。三项失败为：

1. `control-api-integration`：`failed clarification releases its pending command so a retry can complete`
   （期望 500，实际 422）。
2. `control-api-integration`：`post-activation clarification failure reclaims the same command without another requirement version`
   （期望 200，实际 400，unknown key `audience`）。
3. `user-research-hub-integration`：`checked-in Hub snapshot covers every physical file and registry entity exactly once`
   （ignored `.DS_Store`／tree hash 漂移）。

前两项已在干净 `main@49e4b7f` 稳定复现，属于已知基线失败。第三项来自 gitignore 范围内的本地 Hub
数据漂移，相关测试、脚本和 checked-in manifest 相对基线均无 diff。此前全套负载下偶发的
`task-workflow` 2 秒 timeout 本轮未复现。因此没有发现 Phase 2 功能代码导致的确定性失败，但这不等于
全量发布门禁通过：三项失败都必须修复
或按第 22 节取得适用的书面豁免。当前工作区不得表述为 `pnpm quality` 全绿或完整 V1 已完成。

### 0.5 Phase 2 工程实施记录（2026-08-27）

Phase 2 基于 `main@49e4b7f` 实现，未接入或修改 main 的执行主链。当前工程能力包括：

- 正式 `editorial:report` 入口默认装配 Phase 2 Gateway port；同时保留
  `createPhase1EditorialReportPipeline()`，供显式零模型、确定性 fallback 场景使用。Gateway 未配置或
  发生已声明的配置错误时，正式入口同样安全退回零调用 fallback。
- Pipeline 始终先完成 deterministic fallback 的 Schema、关系、覆盖、Renderer、HTML 安全和体积
  预检，再允许任何模型调用。Planner 最多两次，第二次是唯一一次带受控 repair hints 的修复机会。
- LLM 只返回 Blueprint Plan，不生成 HTML。存在 paraphrase 时，候选必须经过独立 Fidelity Review；
  copy Pointer、Material Unit、material hash 与 Blueprint hash 均须闭合，Store 在发布及缓存读取时会
  重新枚举 paraphrase、重建 Review 并复核绑定。
- Planner 与 Fidelity 共用 Editorial 专属 system prompt，把 `上下文:` 后的 Material、候选文案和 repair
  hints 明确定义为不可信数据并禁止遵循其中指令；该 system prompt 同时纳入 prompt hash。两条 prompt
  version 均升级为 v2，使旧缓存与修复后的调用身份严格隔离，且不改变 main 其他 Gateway 调用的默认语义。
- 每次 Planner/Fidelity 调用前均复核 source current fence 与冻结的 Gateway configuration；另有
  cache-return fence 和 publish fence。任何 binding drift 都丢弃响应且不发布。
- Gateway 调用采用固定 redirect、总 deadline、HTTP 尝试数、Retry-After、响应 bytes 与输出 token
  上限；requested/expected/actual model、provider、endpoint、prompt hash 必须一致。`receiptId` 被视为
  错误 composition 的 hard fail；越界或不一致的非可信响应元数据转为受控失败码并发布已预检 fallback。
- 只有通过全部候选门禁的结果为 `ready / llm`；模型超时、Schema/关系/Fidelity/identity 等候选失败
  均记录在 Diagnostic 后发布相同的预检结果为 `degraded / deterministic_fallback`。源完整性、绑定、
  Renderer trace 与 HTML 安全错误仍 fail closed，不允许用 fallback 掩盖。
- 默认 Phase 2 CLI 的集成测试已覆盖真实 composition root 与实际 Gateway client 调用边界，并证明
  task、attempt、Artifact、整张 `control_model_calls` 表和 `current-control` 文件均保持 byte-for-byte
  不变；新增内容只允许位于独立 `editorial-reports` sidecar 根。

Phase 2 校准入口固定为 `editorial:calibrate`。它只接受
`${RUN_WORKSPACE_ROOT:-./run-workspaces}/editorial-reports/calibration/corpus.json` 和同一 calibration root
下的直接 `run.*` 子目录；run/store 目录必须为 `0700`，输入输出文件必须为 `0600`。collect 只能在
空 Store 中运行，并生成 canonical `phase2-calibration.evidence.json`、draft、reference HTML、manifest、
两张截图、PDF 和预绑定 rubric。`evidenceHash` 同时进入 draft、rubric 与最终 result，`draftHash` 绑定
完整 draft；finalize/verify 会重读 canonical summary evidence 并与 draft 全量逐值比对，重验 fixture
中的 `caseId/expected`、唯一 reference 的 manifest/HTML/captures，再从已绑定摘要重算分布、gate 与
resultHash。V1 不保存或重放 golden 原始模型响应，也不重读非 reference 样本的 Store bundle；这属于
trusted operator 边界内的已知 P2，不能把 summary evidence 表述为可独立重放的 raw evidence。
runner 在第一条 Fidelity golden 调用前即用该 fixture 的文件 hash、`internal/v1` 分类和冻结的 Gateway
configuration 执行同一固定 egress policy；非白名单 endpoint 必须零调用并以固定错误码终止。

校准还要求工作树干净、当前 HEAD 包含固定 Phase 1 基线 `49e4b7f`，并在 collect/finalize/verify 的
持久化边界重复执行 commit fence，防止一次校准跨越实现版本。该机制面向 trusted operator 和意外／
局部篡改检测；同一操作系统 owner 若主动同步重写 evidence、draft 与 rubric，无法在没有外部签名密钥
或不可变审计服务的本地模型下被密码学阻止，不属于 V1 防篡改承诺。

工程实现完成不等于发布验收完成。当前仍缺真实 Gateway ready+Fidelity、60 条 golden 实跑、至少
10 个真实 SEALED 包的分布门禁、reference 人工 rubric，以及第 22 节要求的主链／quality 全绿或有效
豁免；在这些证据齐备前，Phase 2 必须保持“不可发布”。

| Phase 2 工程检查 | 当前结果 |
|---|---|
| Phase 2 十三个测试文件定向门禁 | 264 tests：263 pass、0 fail、1 个默认关闭的 Playwright skip |
| 其中 calibration runner 定向测试 | 12/12 pass |
| 其中 Store 定向测试 | 32/32 pass |
| 独立 Chromium 合同 | 13/13 pass，覆盖 1440px、390px、键盘、离线与 A4 |
| `pnpm typecheck` | 通过 |
| `git diff --check` | 通过 |
| `pnpm quality` | 1741 tests：1725 pass、3 fail、13 skip；失败与处理状态见第 0.4 节，当前阻塞发布 |

## 1. 决策摘要

V1 新增一个独立的 **Editorial Report（编辑化派生报告）** 后处理能力。它读取 main 已完成任务的
SEALED Report Package，将其中已经评审通过的内容确定性地整理为本地 Editorial Material；LLM 只接收
经 egress policy 许可的最小 Context 并生成受 JSON Schema 约束的 Blueprint Plan，Pipeline 再注入
绑定与审计闭包。最终 Blueprint 经过引用、证据等级、覆盖和内容保真检查后，由确定性 Renderer
生成自包含 HTML。

推荐链路：

```text
main 已完成并封存的 Report Package（只读）
  -> Editorial Material（确定性来源索引）
  -> Deterministic Fallback Preflight（先证明保底结果可发布）
  -> 最小 Model Context + Egress Gate
  -> Editorial Blueprint Plan（LLM 只做叙事与版式规划）
  -> Final Blueprint（Pipeline 注入绑定与审计附件）
  -> Schema / 引用 / 证据等级 / 内容保真校验
  -> 固定 HTML Renderer
  -> Editorial Report sidecar（独立派生文件）
```

关键决策：

- 这是报告完成后的派生展示，不是新 Skill，不是新的研究执行步骤。
- 不把它接入 `LeaseExecutionEngine`，不增加主流程状态，不改变任务的完成语义。
- 不让 LLM 输出 HTML、CSS、JavaScript 或任意组件代码。
- 原 Report Package 是唯一事实源；Editorial Report 只反向引用其 ID 与哈希，不形成第二条事实链。
- 事实、推断和未知必须分层；LLM 不能升级证据等级、创造指标或静默修正引用。
- V1 以独立 CLI 作为显式触发器，暴露可复用的 Pipeline 接口；不增加 API、Web UI、数据库实体或后台任务。
- 输出写入独立 sidecar 根目录，不写回 `current-control`，不覆盖任何 main 产物。
- 对共享视觉／Gateway 基础设施的改动仅抽取只读入口和增加 opt-in limits/redirect mode；现有调用
  签名兼容，未显式传入这些选项的 main 流程行为不变。
- LLM 数据出境由版本化、默认拒绝的 `EditorialModelEgressPolicy` 单独裁决；`sensitive`、
  `confidential`、未知敏感等级、未知脱敏策略、非真实 Gateway 或非白名单 host 均不得发送给模型。
- V1 只内联 `exportPolicy=allow` 的 PNG/JPEG/WebP。合法的 `mask` 不能证明当前 bytes 已完成遮罩，
  合法且已验证的 SVG 也不进入 HTML；它们与合法 `block` 分别按安全省略处理并记录受控 warning，
  不修改或重新生成 main 的视觉产物。未知 media type、非法 export policy 或声明／签名不一致仍是
  source-integrity hard fail，不能用“省略”掩盖损坏输入。
- 在任何 LLM 调用前，必须先构造、完整校验并实际渲染 Deterministic Blueprint；只有保底结果已证明可发布，才允许尝试 LLM。
- LLM 不可用或两次 Blueprint 校验仍失败时，直接发布已预检的确定性结果；源完整性、保底可渲染性或安全校验失败时不调用／不继续调用 LLM，也不发布派生报告，原报告始终可用。

## 2. 背景与问题陈述

main 已具备从研究需求到可追溯交付物的完整任务级闭环，但最终呈现仍以标准化报告组合为主，
其中 multimodal 路径使用固定 ReportDocument 模板。它能保证结构、证据和审计约束，却难以根据
具体问题形成接近专业咨询报告的叙事节奏和视觉表达。

参考样例展示了期望的阅读体验：

- 先给决策结论，再展开定位、人群、动机、链路与策略。
- 使用指标卡、状态卡、人群卡、路径图、策略矩阵、路线图和验证 Gate 等不同表达形式。
- 在正文中明确区分“已有来源支持”“策略推断”“当前未知”。
- 将细节证据、原始问答和引用检查放入审计附件。
- 单文件 HTML 可直接通过 `file://` 打开，并适合打印或导出 PDF。

但该样例也是一个独立手工 Demo，且曾直接检查中间材料并修正三处引用编号。生产能力不能复制这种“边排版边改事实”的行为。若源报告存在引用问题，后处理只能阻止传播或给出诊断，不能绕过 main 的评审与封存结果自行改写事实。

## 3. 对当前 main 的判断

### 3.1 main 不是严格的单 Skill 流程

普通规划会遍历所有注册 Skill 并把全部 eligible 能力交给候选计划生成，见：

- `apps/orchestrator-runtime/src/planners/capability-resolver.ts:209`
- `apps/orchestrator-runtime/src/planners/routed-planner.ts:1024`

只有 `$skill` 直呼路径固定选择一个指定 Skill，见 `apps/orchestrator-runtime/src/planners/routed-planner.ts:798`。执行计划本身是 DAG，actor 可以是 Tool、Skill、LLM 或 Reviewer，且没有“一份计划只能有一个 Skill”的不变量。

因此本文使用“任务级报告”“问题产出”描述输入，不把新能力建模为单 Skill 的附属步骤。

另需区分 `package.json:32` 的 `eval:skills`：它以单个 Skill 为评估单元，默认批量遍历 active
Skill，也可用 `--skill` 筛选；其流程是固定 case 上的 LLM 生成、独立 LLM 评分和评测结果落盘，
不经过 Planner、任务数据库或最终 Report Package 合成。可借鉴“结构化生成→独立评审”的模式，
但不能把 Skill eval 的 case／scorecard 语义直接复用为项目问题报告。本文能力接在 main 任务报告
链之后，而不是接在 `eval:skills` 之后。对应落点见 `evaluations/skills/run.ts:727`、
`evaluations/skills/evaluator.ts:174`、`evaluations/skills/evaluator.ts:301` 和
`evaluations/skills/report-writer.ts:120`。

### 3.2 当前报告主链

```text
ResearchTaskV2
  -> ProblemGraph
  -> 候选计划与用户确认
  -> DAG 执行
  -> SEALED 步骤输出与 Evidence Manifest
  -> LLM Current Deliverable
  -> Report Review
  -> 标准报告组合（multimodal 包含固定 ReportDocument）
  -> SEALED Report Package
  -> Task completed / completed_with_gaps
```

代码落点：

- Deliverable 生成与材料汇总：`apps/orchestrator-runtime/src/report/current-deliverable-service.ts:1100`
- 自动 Report Review：`apps/orchestrator-runtime/src/report/report-review-service.ts:239`
- 评审通过后在 multimodal 路径进入 ReportDocument 组合：`apps/orchestrator-runtime/src/control/lease-execution-engine.ts:2448`
- 固定 13 节模板定义：`apps/orchestrator-runtime/src/runtime/config-loader.ts:54`
- 固定模板组合：`apps/orchestrator-runtime/src/report/report-document-composer.ts:1475`
- Report Package 绑定：`apps/orchestrator-runtime/src/report/report-package-artifact.ts:9`

### 3.3 “项目中的一个问题”的 V1 映射

当前 main 没有 Project 实体，也没有独立持久化的“项目问题报告”。权威绑定是：

```text
taskId + planVersionId + attemptId + reportPackageArtifactId
```

ProblemGraph 的 question 只是任务内部覆盖单元，最终 Deliverable 要覆盖全部 required question。为避免引入一套尚不存在的 Project/Question 生命周期，V1 将“项目中的一个问题产出”映射为“一次已完成 Current Task 的权威 Report Package”。V1 不新增 `projectId`、不拆分子问题报告，也不改变当前一任务一综合报告的语义。

## 4. 目标与成功标准

### 4.1 产品目标

- 将已经评审通过的研究结果重组为决策优先、信息层次清晰的专业长报告。
- 根据材料结构选择多种表达组件，而不是把所有内容渲染成相同段落。
- 保留完整证据追溯和不确定性边界。
- 生成可离线打开、可分享、可打印为 PDF 的自包含 HTML。
- 让能力可被 CLI 或其他显式调用方复用，而不要求重新运行研究流程。

### 4.2 工程成功标准

- 输入只能是当前已完成任务的 SEALED `report-package-v1`。
- 只接受带 `verdict: pass` Review 的 `current_text` 或 `multimodal`；拒绝 `legacy_text`。
- V1 对 main 当前五个 active deliverable type 提供显式 projector：`research_plan`、
  `competitive_analysis_report`、`voc_diagnosis_report`、`design_audit_report` 和
  `accessibility_audit_report`；registry 后续新增但尚无 projector 的 type 必须明确拒绝。
- 读取期间重新验证 Report Package、Deliverable、Evidence Manifest、Review，以及存在时的
  ReportDocument 和视觉资产的 ID、hash、schema 与 task/plan/attempt 绑定。
- 调用开始冻结 `task/current Attempt/report package ID+hash`；每一次 Planner/Fidelity 出站前、返回
  ready cache 前和原子发布前都必须重验同一绑定，任何切换统一以 `SOURCE_BINDING_CHANGED` hard
  fail，不能继续出站、返回或发布旧结果。
- main 的数据库状态和 `current-control` 文件哈希在运行前后完全不变。
- 每段实质性新文案都能回链一个或多个 Material Unit。
- 任意事实卡、指标、图表和引用都不能脱离源证据。
- HTML 不含脚本、事件属性、远程样式、远程字体或运行时资源请求。
- 对已通过 fallback preflight 的输入，纯 LLM 失败必然回落到已缓存的确定性降级报告；源完整性或保底可渲染性失败时不调用 LLM、不产生可发布结果。
- 相同 `requestKey` 重复运行时优先复用已发布 ready generation；degraded 不阻止后续重试 ready，
  且任何 generation 都不原地覆盖。
- Egress policy 拒绝时仍先通过 fallback preflight，再以零次 LLM 调用发布 degraded；拒绝本身不能
  绕过源完整性、覆盖、HTML 安全或 byte-size 门禁。

### 4.3 视觉成功标准

对材料充分的报告，输出至少包含以下八类表达中的五类，并始终包含决策封面和审计附件；存在
risk/unknown Material 时还必须包含风险区：

- 指标卡（材料规模卡是固定首屏摘要，不计入八选五）
- 事实／推断／未知三分层
- 卡片组
- 流程或心智路径
- 对比／策略矩阵
- 优先级路线图
- 验证 Gate
- 视觉证据画廊

组件缺少可靠材料时必须省略，不能为了“丰富”而虚构内容。

## 5. 非目标

V1 明确不做：

- 不修改 `ResearchTaskV2`、ProblemGraph、PlanCompiler、Skill Registry 或 Tool Registry。
- 不修改 `LeaseExecutionEngine`、`TaskWorkflowService` 或现有状态机。
- 不在任务执行完成前自动启动 Editorial Report。
- 不新增 Project、Question Report 或其他领域实体。
- 不覆盖或升级现有 `report-package-v1`、Deliverable、Review、ReportDocument。
- 不重新访问网页、调用 Tool、读取未封存中间输出或重新研究事实。
- 不静默修复源报告中的证据编号、事实错误或结论缺口。
- 不允许用户提供任意提示词、HTML 模板、CSS、JavaScript 或主题代码。
- 不提供多主题、多语言、多风格版本选择；V1 固定 `zh-CN` 和一个编辑模板。
- 不增加 HTTP API、Web 按钮、异步队列、定时任务或新部署服务。
- 不新增数据库表、字段、迁移、第三方依赖、账号或凭证。

## 6. 核心术语

**Canonical Report Package**：main 已封存的权威报告包，是 Editorial Pipeline 的唯一事实源。

**Editorial Material**：从权威报告包确定性抽取、脱敏并带来源指针的最小内容单元集合。它只在本地
使用；LLM 最多看到其经过 egress policy 许可的 `EditorialModelContext` 最小投影。

**Editorial Blueprint**：Pipeline 组装并持久化的结构化编辑方案，只描述章节、允许的组件、材料引用
和受约束的改写文案；不包含任何渲染代码。

**Editorial Blueprint Plan**：LLM 实际输出的最小编辑计划，不含 task/attempt、request key、material
hash 或审计附件；Pipeline 验证后确定性组装为可落盘的 Editorial Blueprint。

**Content Fidelity Review**：独立于 Blueprint 生成的第二次结构化判断。LLM 只返回逐项 checks 的
Review Plan；Pipeline 本地绑定 Material/Blueprint hash 并 fold 最终 verdict，用于检查改写是否忠于
引用材料，是否发生数字漂移、限定条件丢失或事实等级升级。

**Deterministic Blueprint**：不改写原文、按固定规则组织 Material 的保底方案。LLM 不可用或 LLM Blueprint 不合格时使用。

**Fallback Preflight**：在任何 LLM 调用前，对 Deterministic Blueprint 执行完整确定性校验、真实渲染、HTML 安全／覆盖／体积检查并缓存不可变结果。它把“LLM 失败可降级”从补救意图变成调用前已证明的事实。

**Editorial Model Egress Policy**：生产代码内版本化、默认拒绝的数据出境矩阵。它根据源敏感等级、
脱敏策略版本以及模型 provider/mode/endpoint 决定本次最小 Model Context 是否允许发送给 LLM；它不依赖新环境变量，
也不能被 CLI 参数覆盖。

**Editorial Report**：通过全部硬校验后发布的自包含 HTML 及其 manifest。它是派生展示，不是新的事实源。

**Diagnostic**：记录每个闸门的结果、降级原因和脱敏问题码；不保存完整提示词、敏感原文或上游原始错误。

## 7. 总体架构

```text
PostgreSQL + current-control Artifact Root
          (read only)
                 |
                 v
       EditorialSourceReader
       |  verify completed task
       |  freeze Report Package id + hash
       |  reuse CurrentReportPackageReader
       v
     EditorialMaterializer
       |  deterministic + redacted
       v
    Deterministic Blueprint
       |  validate + render + safety/coverage/size gates
       v
  Preflighted Fallback Bundle (immutable, in memory) ----+
       |                                                  |
       | minimal Model Context + egress allow             | LLM skipped / failed /
       | + pre-model fence/port check before every call   |
       v                                                  | candidate rejected
  LLM structured Blueprint Plan                          |
       | -> deterministic final Blueprint assembly        |
       | -> deterministic validation                      |
       | -> independent LLM fidelity review               |
       | -> render + final trace gates                     |
       v                                                  v
  approved LLM bundle                         cached fallback bundle
                 \                                  /
                  +---------------+------------------+
                                  v
                    publish fence: source still current
                                  |
                                  v
                    EditorialReportStore
                   isolated sidecar + atomic publish
```

依赖方向是单向的：源读取层不知道 Material，Materializer 不知道 LLM，Renderer 不知道数据库，Store 不知道报告语义。没有组件回写 main，也没有循环依赖。

### 7.1 唯一公开 Module

```ts
interface EditorialReportPipeline {
  generate(input: { taskId: string }): Promise<{
    status: 'ready' | 'degraded';
    taskId: string;
    planVersionId: string;
    attemptId: string;
    requestKey: string;
    generationId: string;
    reportPath: string;
    manifestPath: string;
  }>;
}
```

CLI 只负责参数、依赖装配、结构化输出和进程退出码。源校验、LLM 调用、降级、渲染和发布均封装在 Pipeline 内。

### 7.2 只读端口

Pipeline 对 main 的依赖必须收窄为一个已经完成全量校验的只读快照端口：

```ts
interface EditorialSourceBinding {
  taskId: string;
  taskState: 'completed' | 'completed_with_gaps';
  taskStateVersion: number;
  planVersionId: string; // 调用开始时的 activePlanVersionId
  attemptId: string; // 调用开始时的 currentAttemptId
  reportPackageArtifactId: string;
  reportPackageContentSha256: string;
}

interface FrozenEditorialSource {
  binding: EditorialSourceBinding;
  reportPackage: {
    artifact: ControlArtifact & { state: 'SEALED'; contentSha256: string };
    value: ReportPackageArtifactValue;
  };
  current: Exclude<CurrentReportPackageResponse, { presentationMode: 'legacy_text' }>;
  sourceArtifacts: SourceArtifactRef[];
  sourcePolicyMetadata: Array<{
    artifactId: string;
    contentSha256: Sha256;
    sensitivity: string;
    redactionPolicyVersion: string;
  }>;
  verifiedVisualAssets: ReadonlyArray<VerifiedVisualAsset>;
}

interface EditorialSourceVerifier {
  readCurrent(taskId: string): Promise<FrozenEditorialSource>;
  assertStillCurrent(expected: EditorialSourceBinding): Promise<void>;
}
```

`EditorialSourceReader` 只接收以下窄接口；`EditorialReportPipeline` 本身只接收
`EditorialSourceVerifier`：

```ts
type EditorialTaskReader = Pick<
  ControlPlaneRepository,
  'getTaskDetail' | 'getArtifact' | 'findSealedArtifact'
>;

type EditorialArtifactReader = Pick<
  ControlArtifactStore,
  'readVerifiedJson' | 'readVerifiedBoundJson' | 'readVerifiedBinary'
>;
```

为避免为一次视觉读取注入含写方法的 `VisualAssetService`，从现有实现中抽出
`VerifiedVisualAssetReader`。它只依赖 `readVerifiedJson | readVerifiedBinary`，复用同一组 manifest、
binary、binding 和 V2 provenance 校验；现有 `VisualAssetService.readVerified()` 委托给它，行为保持不变。
该 reader 结构上满足 `CurrentReportPackageReader` 的 `visualAssets.readVerified` 依赖。

`readCurrent()` 先读取一次 task 的 completed state/stateVersion、active plan、current Attempt 以及该 Attempt 的 SEALED Report
Package ID/hash，形成 `EditorialSourceBinding`；后续所有组件都按该精确 binding 读取，禁止在中途
重新解析“最新”。只读 adapter 再以 `readVerifiedBoundJson()` 读取 Report Package，调用
`parseReportPackageArtifactValue()`，并检查其 Artifact 的 ID、`SEALED` 状态、kind、schema、hash
及 task/plan/attempt 绑定。每次读取前先通过 `getArtifact()` 检查声明的 byte size，并在解析
Evidence Manifest 与 ReportDocument 后对其引用数量和总字节做预算预检；随后调用
`CurrentReportPackageReader.read(binding, frozenPackage)`
完成所有组件、Evidence 和视觉资产的冻结校验。该现有 Reader 当前以
`validatePayloadSchema: false` 调用报告证据校验器，因此 SourceReader 还必须从 active
Deliverable Registry 解析 `deliverableType -> payload_schema`，用 `SchemaValidator` 对 payload
再次严格校验，并确认该 type 存在第 10.1 节显式 projector；未知、inactive、schema 不合格或没有
projector 的 type 一律 hard fail，不能落入猜字段的通用路径。不得在这里实例化
`ReportPackageArtifactService`：其当前构造依赖同时包含 `writeJson`，会让只读声明名不副实；也不得
把完整 `VisualAssetService` 注入只读链路。

全部组件冻结完成后，`readCurrent()` 必须再次读取 task state/stateVersion、active plan、current
Attempt、report package ID/hash 并与
起始 binding 逐字段比较；不相等即 `SOURCE_BINDING_CHANGED`，丢弃快照且不创建 Diagnostic。该
start fence 防止一次调用混读两个 Attempt。`assertStillCurrent()` 使用同一读取和比较算法，供每次
Planner/Fidelity 出站前的 pre-model、ready cache 返回前的 cache-return，以及原子发布前的 publish
fence 复用；“current”在本文中明确表示调用开始、每次出站和结果提交／返回都指向同一个 package，
而不是“调用开始时曾经 current”。

传给 `CurrentReportPackageReader` 的 Artifact reader 必须在单次 `readCurrent()` 内按
`读取方法 + artifactId` memoize Promise。同一 Evidence Artifact 被多条 entry 引用时只读取、解析
和验 hash 一次，所有消费者把缓存值视为 immutable；请求结束即丢弃缓存。这使第 19 节按唯一
Artifact 汇总的预算与真实 I/O 一致，也避免重复引用形成放大攻击。

视觉 reader 另按 `assetId + manifestArtifactId` memoize `readVerified()` Promise，避免重复
screenshot Evidence 触发 `Buffer.from()` 副本。SourceReader 从该 cache 取得本次实际验证过的
`VerifiedVisualAsset`，对 bytes 做单份防御性拷贝后放入 `FrozenEditorialSource.verifiedVisualAssets`；
Pipeline 和 Renderer 此后不得重读任何 main 内容 bytes。唯一后续 main 访问是通过
`EditorialSourceVerifier.assertStillCurrent()` 重读 task/report-package 的最小 metadata，以执行
逐调用 pre-model、cache-return 和 publish fence；该方法不返回正文或二进制 bytes，也不暴露写能力。

现有 `ControlArtifactStore` 的构造函数要求一个同时具有读写方法的 repository，因此 CLI 的最外层
composition root 无法诚实宣称“从未持有写能力”。它可以短暂构造完整 infrastructure，但必须立即
投影为上述只读 facade；SourceReader、Pipeline、Materializer 和 Renderer 的类型中不得出现
`transitionTask`、`completeExecution`、`createStagingArtifact`、`sealArtifact`、`writeJson` 或其他
Control Artifact 写入能力。TypeScript 证明内部业务链路拿不到写端口，集成测试再以 write-method spy
证明 composition root 实际零写；两层证据缺一不可。

## 8. 端到端处理流程

1. CLI 接收 `taskId`；SourceReader 在调用开始读取并冻结 task、active plan、current Attempt 与 SEALED
   `report_package` ID/hash，任务必须处于 `completed` 或 `completed_with_gaps`。
2. 只读 adapter 只按冻结 binding 校验 Report Package 本体，并使用
   `CurrentReportPackageReader.read(binding, frozenPackage)` 校验全部组件；禁止中途切换到“最新”。
3. 完成组件读取后执行 start fence；task/current Attempt/report package ID+hash 任一变化即
   `SOURCE_BINDING_CHANGED` hard fail，防止混读。
4. 确认 presentation mode 为 `current_text` 或 `multimodal`，最终 Review 为 `pass`，并按 active
   Deliverable Registry 重新验证 payload schema 与显式 projector 支持。
5. Materializer 确定性生成 Material 与最小 `EditorialModelContext`，分别序列化为 exact bytes，并
   计算 canonical SHA-256。
6. 用固定 `EditorialModelEgressPolicy` 对全部贡献 source 的 sensitivity/redaction policy 与模型
   provider/mode/canonical endpoint/redirect policy 求出不可变 decision；根据源 hash、Material/Context、
   Pipeline 版本、egress decision 和 Gateway configuration 计算 `requestKey`。
7. 优先读取并验证 ready slot；命中时必须立即 `assertStillCurrent()`，通过才可返回。未命中则尝试
   获取 request lock；除一次可证明的 stale-lock 隔离与重试外，获锁失败立即返回
   `EDITORIAL_REQUEST_BUSY`，不等待、不读取 fallback、不调用 LLM。
8. 锁所有者再次检查 ready；命中时同样在返回前重验 current。仍为空才构造 Deterministic
   Blueprint，对 Schema、引用、组件关系、证据等级、数字、正文／附件覆盖、组件多样性和视觉策略
   做校验，再真实渲染并执行 HTML 安全、自包含、最终 render trace 与精确 byte-size 门禁。任一步
   失败即 `SOURCE_NOT_RENDERABLE` hard fail，且不得调用 LLM。
9. 将步骤 8 的 exact Blueprint/HTML bytes、hash、`exportedAssets`、最终 eligible/rendered
   composition kind
   和 checks 冻结为 in-memory fallback bundle；valid fallback slot 可以在完整复核后提供等价 bytes，
   但不能让调用提前返回 degraded。
10. 只有 fallback bundle 已就绪、egress decision 为 allow 且 Model Context 未超过 LLM 预算，才允许
    进入模型阶段。每一次 Planner/Fidelity `generateStructured()` 都必须紧邻调用前重新执行
    `assertStillCurrent()`、model-port deep comparison 和 egress check。policy deny、超预算、provider
    缺失或身份不合格保持零次调用并选择 fallback；任意一次 pre-model fence drift 都 hard fail，禁止
    本次及后续调用，已完成的较早响应丢弃。
11. 将候选 Plan 确定性组装为 final Blueprint 并运行同一校验，再对允许 `paraphrase` 的文案发起
    独立 Content Fidelity Review；初次候选不合格时，只把脱敏诊断交给 Planner 修复一次。
12. 对通过 Fidelity 的候选实际渲染并按最终可导出资产和非空 block 重算组件门禁。unsafe HTML
    或未分类 Renderer 异常 hard fail；仅候选 coverage、最终 composition 或 8 MiB 失败时拒绝候选并
    选择已预检 fallback。
13. 第二个候选仍不合格、任一 LLM 调用失败或步骤 10 跳过 LLM 时，直接选择步骤 9 的缓存 fallback；
    不得重新构造或重新渲染一个“保底”结果。
14. 根据获胜 Blueprint 与 `exportedAssets` 计算 `generationId`；Store 在 `.staging` 写完 Material、
    Blueprint、Diagnostic、HTML 与 manifest 并核对 hash。
15. 原子 rename 前立即 `assertStillCurrent()`；已切换则删除本进程 staging、释放锁并以
    `SOURCE_BINDING_CHANGED` hard fail，不发布旧结果。目标 slot 已被先到者发布时也只能在完整校验
    且 publish fence 仍通过后采用。
16. 返回任何 ready/degraded generation 前再保证本次最近的 publish/cache-return fence 已通过；CLI
    输出结果 JSON。若没有可发布报告则返回非零退出码，原报告始终是唯一事实源。

## 9. 数据契约

四个主契约均版本化、不可变、拒绝未知字段。源 Artifact 与派生文件使用不同引用类型，避免把 sidecar 文件伪装成 Control Artifact。
两个 `generateStructured()` 调用的 Registry key 固定为 `editorial-report-blueprint` 和
`editorial-report-fidelity`；前者映射不含 binding/审计附件的 `EditorialBlueprintPlan` Schema，后者
映射 Fidelity Review Plan Schema。prompt、调用记录和测试都不得另起别名；最终 `EditorialBlueprint`
与 `EditorialFidelityReview` 均由本地
contract parser 校验，不直接接受模型输出。

### 9.1 公共基础类型

```ts
type Sha256 = `sha256:${string}`;
type PromptFingerprint = `sha256:${string}`;
type EpistemicStatus = 'fact' | 'inference' | 'unknown';

interface SourceArtifactRef {
  artifactId: string;
  kind: string;
  schemaVersion: string;
  contentSha256: Sha256;
}

interface SourcePointer {
  artifactId: string;
  jsonPointer: string; // RFC 6901
}

type EditorialEvidenceEntry = Pick<
  EvidenceEntry,
  | 'id'
  | 'kind'
  | 'evidenceClass'
  | 'artifactId'
  | 'artifactContentSha256'
  | 'jsonPointer'
  | 'sensitivity'
  | 'redaction'
  | 'toolId'
  | 'toolTier'
  | 'toolProof'
  | 'sourceUrl'
>;

interface DerivedFileRef {
  relativePath: string;
  contentSha256: Sha256;
  byteSize: number;
  mediaType: 'application/json' | 'text/html';
}
```

所有 JSON 契约统一使用同一个 canonical serializer：对象 key 按 Unicode code point 排序、数组
保持语义顺序、无多余空白、UTF-8 编码，并拒绝 `undefined` 与非有限 number。有限 number 先把
`-0` 归一为 `0`，再使用 ECMAScript `JSON.stringify(number)`；CI 基准为 Node.js 22，所有
`package.json` 允许的 Node.js ≥22 运行时都必须通过同一组 golden；不得换用保留原输入 lexeme、
locale 格式化或任意精度 decimal serializer。也就是说
`1e-7`、`0.000001`、`100000000000000000000`、`1e+21` 的 canonical 文本分别固定为
`1e-7`、`0.000001`、`100000000000000000000`、`1e+21`。运行时 Node.js major 变化必须先跑 canonical
golden，若 bytes 有变化就升级 contract/store version，不能静默复用旧 hash。
`materialHash`、`blueprintHash`、Review/response hash 与落盘文件 hash 都对该 serializer 生成的
实际 bytes 计算；不得先 hash object、再用 pretty JSON 写出不同 bytes。

V1 内容规范化只有一套规则：string 先把 CRLF/CR 转为 LF，再做 Unicode NFC；不 trim、不折叠
内部空白、不改变标点或大小写。number/boolean 使用 canonical JSON 表示，`-0` 归一为 `0`，非有限
number 拒绝。Unit ID、Pointer/value 比对和 verbatim 校验全部使用该结果。单个规范化 string 叶子
最多 16,000 个 Unicode code point 且 UTF-8 不超过 64 KiB；超限返回 `SOURCE_LEAF_TOO_LARGE`，
不得切段后伪装成原 Pointer。

`Sha256` 字段在 Validator 中额外要求冒号后恰好 64 位小写 hex。`promptHash` 是例外：它逐字保存
main 现有 `LLMResult.promptHash`，当前 `hashPrompt()` 产物是 `sha256:` 加 16 位小写 hex，仅作为
调用关联 fingerprint，不承担文件完整性校验；因此单独使用 `PromptFingerprint` 并验证该现有格式。

### 9.2 Editorial Material

```ts
interface EditorialMaterialUnitBase {
  id: string;
  groupId?: string;
  value: string | number | boolean;
  unit?: string;
  metricEligible: boolean;
  sourceRefs: readonly [SourcePointer];
  basisUnitIds: string[];
  evidenceIds: string[];
  questionIds: string[];
  requiredInOutput: boolean;
  requiredInBody: boolean;
}

type EditorialMaterialUnit =
  | (EditorialMaterialUnitBase & {
      role: 'claim';
      epistemicStatus: EpistemicStatus;
    })
  | (EditorialMaterialUnitBase & {
      role: 'recommendation';
      epistemicStatus: 'inference';
    })
  | (EditorialMaterialUnitBase & {
      role: 'risk' | 'validation';
      epistemicStatus: 'unknown';
    })
  | (EditorialMaterialUnitBase & {
      role: 'context' | 'audit';
      epistemicStatus?: never;
    });

interface EditorialMaterialAsset {
  id: string;
  assetId: string;
  manifestArtifactId: string;
  visualRole: 'standalone' | 'comparison-before' | 'comparison-after';
  comparisonGroupId?: string;
  derivedFromAssetId?: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  exportPolicy: 'allow';
  captionUnitId: string;
  altTextUnitId: string;
  evidenceIds: string[];
  sourceRefs: readonly [SourcePointer, ...SourcePointer[]];
}

interface EditorialMaterial {
  version: 'editorial-material-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableType: string;
  presentationMode: 'current_text' | 'multimodal';
  sourceReportPackage: SourceArtifactRef;
  sourceArtifacts: SourceArtifactRef[];
  titleUnitId?: string;
  methodSummaryUnitId: string;
  units: EditorialMaterialUnit[];
  assets: EditorialMaterialAsset[];
  evidence: EditorialEvidenceEntry[];
}
```

Material 不变量：

- 每个 Unit 对应一个直接源叶子，`sourceRefs` 在 V1 中恰好包含一个指针；即使两个 Pointer
  的文本相同也生成两个 Unit，禁止跨 Pointer 去重。
- Unit ID 的算法固定，不留实现选择：对以下 canonical JSON tuple 的 UTF-8 bytes 计算 SHA-256，
  再拼成 `emu_` 加 64 位小写 hex：

  ```ts
  [
    'editorial-material-unit-v1',
    sourceArtifactId,
    sourceArtifactContentSha256,
    sourceJsonPointer,
    role,
    valueType, // 'string' | 'number' | 'boolean'
    normalizedValue
  ]
  ```

  `normalizedValue` 保持原 JSON scalar 类型并服从第 9.1 节规范化，不能先转成展示字符串。相同文本
  位于不同 Artifact/Pointer、类型不同或 role 不同都会得到不同 ID；相同 tuple 必须 byte-for-byte
  得到同一 ID。
- `units[].id` 在整个 Material 中必须唯一。Validator 对每个 Unit 从实际字段逐项重建上述 tuple、
  重算 ID 并比较；同 ID 重复出现时，无论其他非身份元数据相同还是不同都拒绝，不能用 Map 覆盖。
- Unit ID 的最小硬编码 golden 不只检查格式。以下 UTF-8 preimage **没有尾随换行**，恰好 167 bytes：

  ```text
  ["editorial-material-unit-v1","artifact-01","sha256:0000000000000000000000000000000000000000000000000000000000000000","/payload/metrics/0/value","claim","number",1e-7]
  ```

  其 SHA-256 必须恰好为
  `e4144ce004a7f0c52b6e2b2350b6c4c0a7c021b14540a81acd1d9c4e907ef3a0`，最终 Unit ID 必须为
  `emu_e4144ce004a7f0c52b6e2b2350b6c4c0a7c021b14540a81acd1d9c4e907ef3a0`。
- `basisUnitIds`、`evidenceIds` 与 `questionIds` 必须全部存在；basis graph 必须无环，并且边只能来自
  FindingGraph/coverage 既有关系，或第 10.1 节显式 projector 声明且外键已经验证的结构关系；
  不得从文本相似度、相同词语或碰巧相同的局部 ID 推导新边。
- 每个 `SourcePointer.artifactId` 必须存在于 `sourceArtifacts`；JSON Pointer 必须能够在该
  verified Artifact 中解析，解析出的叶子经同一规范化规则处理后必须与 Unit `value` 完全一致。
- `unit` 不是 LLM 文案。它只能由显式 payload projector 针对精确 Pointer 写入版本化固定值；
  未声明 Pointer 必须省略。V1 只允许 `/5`、`ratio`、`个`、`条` 四种固定语义，其中 `ratio`
  由 Renderer 确定性显示为百分比并在审计附件保留原始数值。
- `metricEligible` 默认且对通用 FindingGraph Unit 固定为 `false`；只有第 10.1 节白名单的数值
  Pointer 可以设为 `true`。audit、confidence、权重、样本外推值和 Materializer 自算计数不得
  进入业务 `metric-cards`；材料规模卡由 Renderer 直接从 Material 数量确定性生成。
- `titleUnitId` 若存在，必须引用现存的 `context` Unit；`methodSummaryUnitId` 必须引用现存的
  `context` Unit。不得在 Material 顶层放置没有来源的自由文本。
- `requiredInBody=true` 必须同时满足 `requiredInOutput=true`。Materializer 对每个 required question
  按 coverage canonical 顺序选择至少一个 conclusion/claim anchor，对全部 recommendation、risk、
  validation Unit、全部 payload `claim` Unit，以及第 10.1 节逐类型声明的核心 context anchor 标为
  body-required；`titleUnitId`、`methodSummaryUnitId` 与 VOC representative quote 也固定为
  body-required。其他 context/audit Unit 只要求进入审计附件。
- `sourceArtifacts` 必须覆盖 Report Package、Deliverable、Evidence Manifest、Review、可选
  ReportDocument，以及本 Material 实际引用的 Evidence／视觉 Artifact；ID 唯一且 hash 均来自冻结快照。
- `fact` 只来自 `FindingGraph` 的 `FactFinding`，且至少有一个经过当前 Evidence 校验器认可的 Evidence ID。
- inference、analysis、summary、conclusion、recommendation 一律不高于 `inference`。
- `risksAndOpenIssues`、能力缺口、显式 gap 和待确认项一律为 `unknown`。
- 组合内容不复制为新的 Unit，而是通过 `basisUnitIds` 表达；Renderer 判断组合状态时按
  `unknown > inference > fact` 取最保守等级。
- 业务 Claim 只来自 Deliverable 的 FindingGraph 或按 deliverable type 注册的显式 payload
  projector。ReportDocument 只提供章节顺序、导航标签和 verified visual 引用；其 paragraph、
  list、fact、metric 不得成为业务 Claim。若复用标题等导航文字，只能生成 `context` Unit。
- 任意 payload 字段只有显式 projector 声明了 JSON Pointer、role、状态和证据映射后才能进入
  Material；禁止按字段名猜测 persona、priority、journey 或 metric。
- Materializer 计算的数量不是业务 Unit；Renderer 可以把它显示为固定措辞的“材料规模／审计计数”，
  但不得把它解释为研究结论。
- `evidence` 的 `kind`、`evidenceClass`、`sensitivity`、`redaction`、`toolTier` 和 `toolProof`
  沿用现有 `EvidenceEntry` union，不得退化成任意 string。每条 Evidence 的 Artifact/hash/Pointer
  必须重新解析并一致，其 `artifactId` 必须存在于 `sourceArtifacts`；`blocked` 或 `sensitive`
  条目不得进入 Material。
- 每个 Unit 与 Asset 的 `evidenceIds` 必须全部存在于 `material.evidence`，且 Material evidence
  必须恰好是实际引用 ID 的 canonical 去重集合。过滤敏感 Evidence 时不得保留悬空 ID。
- Material 只纳入 `exportPolicy=allow` 且 manifest media type 与 binary magic bytes 同时证明为
  PNG/JPEG/WebP 的 Asset；声明与签名不一致 hard fail，不能仅信扩展名或 MIME string。
  `mask` 只是导出意图，现有 manifest 没有“当前 bytes 已完成不可逆遮罩”的证明字段，因此 V1 将其
  连同合法 `block`、已通过 `readVerified()` 的 SVG 整体省略，分别记录
  `VISUAL_MASK_OMITTED`、`VISUAL_BLOCKED_OMITTED`、`VISUAL_SVG_OMITTED` warning；comparison pair
  任一侧被安全省略就两侧一起省略。未知 media type、非法 export policy、manifest schema 错误或
  media/signature mismatch 一律 hard fail。不得读取后猜测、转码、清洗或覆盖 main 产物。
- Asset 的 `assetId + manifestArtifactId` 在 Material 内唯一，`sourceRefs` 至少包含一个已解析的
  ReportDocument 或显式 payload pointer，并必须对应 `verifiedVisualAssets` 中同一绑定；gallery
  不能只靠一个裸 asset ID 通过校验。
- Asset 不保存可自由改写的 caption/alt 字符串；`captionUnitId` 与 `altTextUnitId` 必须引用两个
  `context|audit` Unit，其值分别逐字来自 verified ReportDocument 的 caption/altText SourcePointer。
  Renderer 只解析并转义这两个 Unit；它们固定 `requiredInOutput=true`、默认
  `requiredInBody=false`。Materialization 阶段因 policy/media type 过滤 Asset 时，这两个专用 Unit
  也必须原子省略；渲染阶段仅因 byte budget 省略图片时 Material 已冻结，Unit 仍可在审计附件出现，
  但不得计入正文或 `visual-gallery` 覆盖。篡改文案、悬空引用或让 LLM 生成 altText 都必须拒绝。
- `comparison-before/after` 必须以同一个 `comparisonGroupId` 恰好成对出现；after 的
  `derivedFromAssetId` 必须等于 before `assetId`，并与已验证 Visual Manifest 的 annotation lineage
  完全一致。main 当前 chart 产物是 `chart_svg`，因此 V1 不把 chart 作为 Asset role，也不内联或
  转码该产物，只产生受控 warning。其他组合不得声明这些 lineage 字段。`visual-gallery` 对完整且最终可导出的 pair 使用固定对比布局，否则整对
  省略或使用普通画廊，不能只显示 before/after 的一半。
- fact 失去任一声明 Evidence，或任意 `requiredInOutput` Unit 因敏感过滤而失去支撑时，
  Materialization hard fail；可选 Unit／Asset 可以整体省略并记录非敏感 warning，不能只删 Evidence ID
  后继续暴露原文本。
- `redaction=blocked` 或敏感策略禁止输出的内容不进入 Material；`exportPolicy=mask|block` 和
  非 PNG/JPEG/WebP 资产均不进入 assets。
- 这是 Editorial sidecar 有意比 main 更窄的导出策略；main 现有 composer 对 `allow` 和 `mask` 的既有语义
  和产物完全不变，本文不重新解释或修改主链视觉行为。
- LLM 看不到图片字节、原始 Tool 输出、完整提示词和未脱敏错误。
- 全部问题结论、recommendation、risk/unknown 与证据审计项标记为 `requiredInOutput=true`；正文
  子集由上述 `requiredInBody` 规则显式给出，不能让 LLM 自行决定哪些核心上下文只留在附件。

#### 9.2.1 最小模型上下文

完整 `EditorialMaterial` 只在本地校验和渲染链路使用，不直接发送给模型。Materializer 另做一个
确定性、无自由裁量的最小投影；Planner 与 Fidelity Reviewer 必须共用同一份 exact bytes：

```ts
interface EditorialModelContext {
  version: 'editorial-model-context-v1';
  materialHash: Sha256;
  deliverableType: string;
  units: Array<{
    id: string;
    value: string | number | boolean;
    unit?: string;
    role: EditorialMaterialUnit['role'];
    epistemicStatus?: EpistemicStatus;
    metricEligible: boolean;
    groupId?: string;
    basisUnitIds: string[];
    questionIds: string[];
    requiredInOutput: boolean;
    requiredInBody: boolean;
  }>;
  assets: Array<{
    id: string; // 仅 Editorial 内部 ID，不是 main assetId
    visualRole: 'standalone' | 'comparison-before' | 'comparison-after';
    comparisonGroupId?: string;
    derivedFromEditorialAssetId?: string;
    captionUnitId: string;
    altTextUnitId: string;
  }>;
}
```

该投影严格排除作为**结构元数据**的 task/plan/attempt UUID、Artifact/Manifest ID 与 hash、
`sourceArtifacts`、`sourceRefs`、SourcePointer、Evidence 对象／ID／URL、tool provenance、图片
bytes、文件路径和数据库字段；它不承诺删除 verified Unit `value` 本身包含的 URL、UUID 或其他业务
字面量，这些值仍受固定 egress policy 与下文敏感 token verbatim 规则约束。模型不负责
构造审计附件：Pipeline 在 Planner 响应通过后，确定性写入 task/plan/attempt/requestKey/materialHash
envelope，并按第 9.3 节规则追加唯一 audit section；这样不必为了让模型回显固定 ID 而扩大出境数据。

`EditorialModelContext` 使用同一 canonical serializer，记录 `modelContextHash` 与实际 byte size；两次
Planner 和两次 Fidelity 调用都必须绑定同一 hash。Fidelity 额外只接收当前候选中 paraphrase 的
`copyPointer/text/materialUnitIds` 列表，不接收最终 HTML、Evidence 或 source metadata。投影结果超过
512 KiB 时不调用模型，使用已经预检的 fallback。

第二次 Planner 不回传被拒绝的完整响应或自由文本错误，只在同一 Context 外增加最多 32 条
`{code,jsonPointer?,materialUnitIds?}` repair hint；code 来自固定目录，Pointer 和 Unit ID 必须已通过
长度／成员校验。Planner 初稿、Planner repair、Fidelity 三类实际 request context envelope 都按
canonical UTF-8 bytes 分别执行 512 KiB 上限；`modelContextHash/ByteSize` 始终只绑定上述共同基础
Context，call-specific envelope 仍由现有 `promptHash` 与候选 `inputBlueprintHash` 关联。

Egress policy 不仅检查 Report Package 顶层。SourceReader 必须对每个实际贡献 model context Unit／
Asset 的源 Artifact，连同 Report Package 本体，收集经过 verified metadata 的
`artifactId + contentSha256 + sensitivity + redactionPolicyVersion` tuple；先按四字段的 canonical
tuple bytes 去重，再按同一 bytes 升序排列，形成唯一 canonical set 并计算
`sourcePolicySetHash`；原始集合留在内存，不发送给模型。任一成员为 sensitive/confidential/未知等级、
非 `v1` 或 metadata 缺失，整个 context 都 deny，不能通过删除该成员的 source pointer 后继续发送。

### 9.3 Editorial Blueprint

```ts
interface EditorialCopy {
  text: string;
  mode: 'verbatim' | 'paraphrase';
  materialUnitIds: string[];
}

type EditorialSectionRole =
  | 'decision'
  | 'positioning'
  | 'audience'
  | 'motivation'
  | 'journey'
  | 'strategy'
  | 'opportunity'
  | 'roadmap'
  | 'validation'
  | 'risk'
  | 'boundary'
  | 'audit';

type EditorialBlockKind =
  | 'narrative'
  | 'decision-cover'
  | 'metric-cards'
  | 'truth-triad'
  | 'card-grid'
  | 'flow'
  | 'strategy-matrix'
  | 'roadmap'
  | 'validation-gates'
  | 'risk-register'
  | 'visual-gallery'
  | 'audit-appendix';

type EditorialCompositionKind =
  | 'metric-cards'
  | 'truth-triad'
  | 'card-grid'
  | 'flow'
  | 'strategy-matrix'
  | 'roadmap'
  | 'validation-gates'
  | 'visual-gallery';

interface EditorialBlockBase {
  id: string;
  kind: EditorialBlockKind;
}

type EditorialBlueprintBlock =
  | (EditorialBlockBase & {
      kind: 'narrative';
      paragraphs: EditorialCopy[];
    })
  | (EditorialBlockBase & {
      kind: 'decision-cover';
      summary: EditorialCopy;
      boundary?: EditorialCopy;
    })
  | (EditorialBlockBase & {
      kind: 'metric-cards';
      items: Array<
        | { label: EditorialCopy; labelKey?: never; valueUnitId: string }
        | {
            label?: never;
            labelKey: 'target-sample-count';
            valueUnitId: string;
          }
      >;
    })
  | (EditorialBlockBase & {
      kind: 'truth-triad';
      factIds: string[];
      inferenceIds: string[];
      unknownIds: string[];
    })
  | (EditorialBlockBase & {
      kind: 'card-grid';
      cards: Array<{ title: EditorialCopy; body: EditorialCopy }>;
    })
  | (EditorialBlockBase & {
      kind: 'flow';
      steps: Array<{ label: EditorialCopy; body: EditorialCopy }>;
    })
  | (EditorialBlockBase & {
      kind: 'strategy-matrix';
      columns: EditorialCopy[];
      rows: Array<{ label: EditorialCopy; cells: EditorialCopy[] }>;
    })
  | (EditorialBlockBase & {
      kind: 'roadmap';
      lanes: Array<{ label: EditorialCopy; items: EditorialCopy[] }>;
    })
  | (EditorialBlockBase & {
      kind: 'validation-gates';
      gates: Array<{
        label: EditorialCopy;
        method: EditorialCopy;
        successCriterion?: EditorialCopy;
      }>;
    })
  | (EditorialBlockBase & {
      kind: 'risk-register';
      items: Array<{
        risk: EditorialCopy;
        impact?: EditorialCopy;
        response?: EditorialCopy;
      }>;
    })
  | (EditorialBlockBase & {
      kind: 'visual-gallery';
      assetIds: string[];
    })
  | (EditorialBlockBase & {
      kind: 'audit-appendix';
      unitIds: string[];
      evidenceIds: string[];
    });

type EditorialPlannedBlock = Exclude<
  EditorialBlueprintBlock,
  { kind: 'audit-appendix' }
>;

interface EditorialBlueprintPlan {
  version: 'editorial-blueprint-plan-v1';
  locale: 'zh-CN';
  title?: EditorialCopy;
  deck: EditorialCopy;
  sections: Array<{
    id: string;
    role: Exclude<EditorialSectionRole, 'audit'>;
    questionIds: string[];
    title?: EditorialCopy;
    lead?: EditorialCopy;
    blocks: EditorialPlannedBlock[];
  }>;
}

interface EditorialBlueprint {
  version: 'editorial-blueprint-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  materialHash: Sha256;
  locale: 'zh-CN';
  title?: EditorialCopy;
  deck: EditorialCopy;
  sections: Array<{
    id: string;
    role: EditorialSectionRole;
    questionIds: string[];
    title?: EditorialCopy;
    lead?: EditorialCopy;
    blocks: EditorialBlueprintBlock[];
  }>;
}
```

`editorial-report-blueprint.schema.json` 约束模型返回的 `EditorialBlueprintPlan`，不是可直接落盘的最终
Blueprint。Pipeline 校验 Plan 后才注入冻结 binding、request key、material hash，并确定性追加唯一
`role=audit` section 与 `audit-appendix` block，得到上面的 `EditorialBlueprint`。模型不能看到或输出
这些被排除的控制标识，也不能决定审计闭包；Diagnostic 的 Planner `responseHash` 对原始 Plan
canonical bytes 计算，`blueprintHash` 对组装后的最终 Blueprint bytes 计算，两者不得混用。

最终 `EditorialBlueprintBlock` 在本地 contract parser 中按 `kind` 判别；模型 JSON Schema 只接受
`EditorialPlannedBlock`，两者都拒绝未知字段。各组件的最小数据形状如下，其中 `audit-appendix`
只由 Pipeline 确定性追加：

| kind | 必需结构 | 约束 |
|---|---|---|
| `narrative` | `paragraphs: EditorialCopy[]` | 每段有来源 |
| `decision-cover` | `summary`, `boundary?` | 状态由 Renderer 派生；固定 provenance disclaimer 始终存在 |
| `metric-cards` | `items[{label|labelKey,valueUnitId}]` | value/unit 由 Renderer 从 numeric Material Unit 读取；固定 labelKey 仅用于白名单 Pointer |
| `truth-triad` | `factIds/inferenceIds/unknownIds` | Renderer 从 Material 派生状态标签 |
| `card-grid` | `cards[{title,body}]` | 状态标签由 Renderer 从引用 Unit 派生 |
| `flow` | `steps[{label,body}]` | 排序必须能由来源支持 |
| `strategy-matrix` | `columns`, `rows[{label,cells}]` | 每行 cell 数严格等于 columns 数 |
| `roadmap` | `lanes[{label,items}]` | 不得创造来源中不存在的优先级或周期 |
| `validation-gates` | `gates[{label,method,successCriterion?}]` | 各字段必须来自同一显式 validation group |
| `risk-register` | `items[{risk,impact?,response?}]` | risk 保留 unknown；源没有影响／响应时不得补写 |
| `visual-gallery` | `assetIds` | 只能引用 Material assets；caption/alt 由 Renderer 从 Asset 的 Unit 引用取得 |
| `audit-appendix` | `unitIds`, `evidenceIds` | 覆盖所有 required unit |

表中的 `title`、`label`、`summary`、`boundary`、`body`、`method`、`successCriterion`、`impact`、
`response`、matrix column/cell 和 roadmap item 等所有非固定文案字段，类型一律是
`EditorialCopy`，不能退化成裸 string。`valueUnitId`、`unitIds`、`evidenceIds` 和 `assetIds`
是引用字段，Renderer 只从 Material 读取其值。每个 LLM candidate 的
`EditorialCopy.materialUnitIds` 最多 16 个；deterministic `verbatim` copy 固定恰好 1 个。

`labelKey` 不是自由文案。V1 唯一值 `target-sample-count` 只允许与
`/payload/competitorSampling/targetCount` 的 Unit 配对，Renderer 固定显示“目标样本数”；其他
metric item 必须使用 source-backed `EditorialCopy` label。Validator 同时校验 key、Pointer 和
`valueUnitId`，LLM 不能把该 key 套到其他数值上。

逐组件关系也是硬合同，不能因为每个 Copy 单独有来源就允许错误拼接：

| kind | deterministic relation gate |
|---|---|
| `narrative` | 普通 paragraph 的 Unit 必须共享至少一个非空 questionId，或处于同一 group/basis 连通分量；top-level deck 与 decision cover 可跨 question 汇总 |
| `decision-cover` | summary 必须包含至少一个 body-required 的 claim/recommendation/risk Unit；boundary 若存在只能引用 source-backed context/risk/validation Unit，不能用无关 audit 字段冒充适用边界 |
| `metric-cards` | source-backed label 必须与 value 同 group 或通过 basis 相连；`labelKey` 使用上文唯一精确映射 |
| `truth-triad` | 每个 ID 必须落入 Renderer 将要显示的对应 epistemic status，三个集合互斥 |
| `card-grid` | 同一卡片 title/body 必须同 group 或通过 basis 相连；不同 card 不互相借来源 |
| `flow` | 每步 label/body 必须同 group 或 basis 相连；step 顺序必须等于显式 schema 数组／projector sequence |
| `strategy-matrix` | V1 只允许 competitive dimension×sample；row label 必须引用该行 dimension Unit，column 必须引用该列 sample name Unit，每个 cell Unit 的 basis 必须同时可达二者，且矩形完整 |
| `roadmap` | lane label 必须引用源 priority/phase Unit；每个 item 所在 group 必须含值相同的该 priority，或由同一 executionPlan phase 显式绑定 |
| `validation-gates` | label/method/criterion 必须同 projector group 或由 basis 相连；不得跨 action/issue 拼接 |
| `risk-register` | risk/impact/response 必须同 group 或有显式 basis；无关系的可选 impact/response 必须省略 |
| `visual-gallery` | 只渲染声明 assetIds；每个 Asset 只能解析自身 `captionUnitId/altTextUnitId`，不能与另一 Asset 交换；comparison pair 必须保持相邻和原 before/after 顺序 |
| `audit-appendix` | Unit 必须等于 required closure 的 canonical 无重复序列，Evidence 必须等于这些 Unit 的直接 Evidence canonical 并集；basis 只能按 Material 原图展开 |

section `questionIds` 必须等于该 section 实际引用 Unit 的非空 question ID canonical 并集；不能自报
一个 question 再填入其他问题内容。上述检查统一记入 `component_relation`，在 Fidelity 前执行。

Blueprint 不变量：

- 不含 HTML、Markdown HTML、CSS、JavaScript、链接目标字段、类名、样式值或自定义组件名；
  source URL 只能来自 Material Evidence。源 Unit 中原本存在的 URL 在 `verbatim` copy 中仅按纯文本显示。
- 每段非固定 UI 文案至少引用一个 Material Unit。
- Material 有 `titleUnitId` 时 Blueprint `title` 必须存在并引用它；没有真实语义标题时 Blueprint
  必须省略 title，由 Renderer 使用固定 UI 映射，LLM 不得把 technical deliverable ID 改写成标题。
- section `title` 可省略；省略时 Renderer 按 section role 使用版本化固定标签。`decision-cover`
  boundary 可省略，但 Renderer 始终附加“本报告为已封存结果的派生呈现，不替代原报告”的固定声明。
  这些 fixed UI copy 不需要 Material 引用，也不进入 Fidelity。
- `verbatim` 只能引用一个 Unit，按第 9.1 节规范化后必须完全一致；其 `text` 上限等于合法源
  string 叶子的 16,000 code point。number/boolean 使用其 canonical JSON 文本。
- `paraphrase` 可以引用多个 Unit，`text` 最多 600 code point，但采用版本化、宁可误报的 V1 token
  scanner。只要任一引用 Unit 的规范化值或候选 `text` 命中下列任一类，Validator 就要求该 Copy 为
  单 Unit `verbatim`，否则拒绝候选：

  1. 任意 Unicode `Decimal_Number`（`\p{Nd}`）或任意中文数字字符
     `〇零一二两兩三四五六七八九十百千万萬亿億兆壹贰貳叁參肆伍陆陸柒捌玖拾佰仟廿卅卌`；V1 明确接受
     “一方面”一类 false positive，不尝试用分词器猜它是否真是数字。
  2. RFC 3339、`YYYY-MM-DD`、`YYYY/MM/DD`，以及由上述阿拉伯／中文数字与
     `年|月|日|时|分|秒|季度|周` 组成的日期时间短语。
  3. `¥|￥|$|€|£`、ASCII 大小写不敏感且以非字母为边界的
     `CNY|RMB|USD|EUR|GBP`，以及数字短语相邻的 `元|块|万元|亿元`。
  4. `%|％|百分之|千分之`，以及中文／阿拉伯数字短语紧邻的 `成|折`。
  5. 任一 Material Evidence ID 的精确子串。
  6. 从任意散文位置按固定 ASCII 大小写不敏感的 scheme 和边界提取的 `http://` 或 `https://` 候选：从 scheme 起扫描到
     空白、控制字符、`< > " ' ( ) [ ] { } （ ） 【 】` 之一，剥离末尾固定标点
     `.,;:!?，。；：！？` 后交给
     `new URL()`；仅 parser 成功且 protocol 为 `http:`/`https:` 时命中。不得要求整段文本本身是 URL。

  因此阿拉伯／中文数字、日期、货币、百分比／成数／折扣、Evidence ID 和嵌入式 URL 都不经 LLM
  改写。实际 citation link 仍完全由 Renderer 从 Material Evidence 注入。scanner 的字符集、边界、
  大小写规则、标点剥离表和 URL 解析规则随 contract version 固定，并用
  `三位用户`、`百分之三`、`三成`、`十万元`、`CNY 10`、`详见https://example.com/a?x=1。`、
  `详见HTTPS://example.com/A。`
  等正例及不含这些 token 的反例锁定；不能依赖 locale、Intl 或运行时分词器。
- `paraphrase` 中的专有名词保留、限定条件和语义上的 certainty 不是可靠的正则或“确定性算法”。
  这些语义只由独立 Fidelity Review 判断；确定性层只证明引用集合、敏感 token、显式状态字段和
  关系正确。无论文案怎么写，Renderer 的 fact/inference/unknown badge 都从 Unit 派生，绝不采信
  LLM 自述。没有 Fidelity pass 的 paraphrase 不能发布 ready。
- 数字显示只有两个非文案例外：`unit=ratio` 的 Renderer 直接解析 canonical JSON number lexeme，
  将十进制指数增加 2 后重新排小数点；禁止先转 IEEE 浮点做 `value * 100`，也禁止使用 Intl/locale
  四舍五入。输出去掉整数部分多余前导零、去掉小数末尾零和空小数点，负零归一为 `0`，不做精度
  截断，再追加 `%`。例如 `0 -> 0%`、`1 -> 100%`、`0.1 -> 10%`、`0.29 -> 29%`、
  `1e-7 -> 0.00001%`、`-0 -> 0%`。材料规模可由 Renderer 对 Material 数组确定性计数；ratio 和
  计数都由 numeric validator 重算并在审计中保留原值，LLM 不能生成或改写这些数字。
- LLM 无权输出 evidence badge、`epistemicStatus` 或真实来源 URL；Renderer 从 Material 注入。
- LLM 无权给出“可上线”“验证通过”等发布判定；Decision Cover 只表达源材料支持的用途和边界。
- section 与 block ID 在 Blueprint 内分别唯一，且必须匹配
  `^[a-z0-9][a-z0-9-]{0,63}$`；Renderer 只使用这两类已验证 ID 生成 DOM 锚点。
  row、card、step 没有 ID，按数组位置稳定渲染。
- 除 truth-triad 中确实无该状态的列可为空外，section blocks 以及 paragraph/item/card/step/row/lane/gate/
  risk/asset 等内容数组均 `minItems: 1`；空 section/block 在渲染前拒绝。唯一运行期例外是原本非空的
  visual-gallery 因最终图片预算变成零，此时 Renderer 整体省略该 block。
- 所有 Unit、Asset、Evidence 与 question 引用必须存在。
- Blueprint 必须恰好包含一个 `audit-appendix`；其 `unitIds` 必须按 Material canonical 顺序恰好
  列出全部 `requiredInOutput` Unit 一次，不得因正文已经引用而省略；`evidenceIds` 必须等于这些
  Unit 所引用 Evidence ID 的 canonical 去重并集。
- Renderer 对 audit appendix 的每个 required Unit 逐项输出规范化后的 `value` 原文、role／状态、
  `basisUnitIds`、`questionIds`、直接 Evidence ID 和 SourcePointer；basis 链必须可展开到对应 Unit，
  并显示沿无环 basis graph 可达的 Evidence ID。多 Unit paraphrase 仅列出 ID 不算内容覆盖。

### 9.4 Editorial Diagnostic

```ts
type EditorialCheckId =
  | 'source_integrity'
  | 'model_egress'
  | 'model_identity'
  | 'schema_integrity'
  | 'reference_integrity'
  | 'component_relation'
  | 'epistemic_integrity'
  | 'numeric_integrity'
  | 'content_fidelity'
  | 'content_coverage'
  | 'composition_quality'
  | 'visual_policy'
  | 'html_safety';

interface EditorialDiagnosticIssue {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  jsonPointer?: string;
  materialUnitIds?: string[];
}

interface EditorialDiagnosticCheck {
  id: EditorialCheckId;
  status: 'passed' | 'failed' | 'not_run';
  method: 'deterministic' | 'llm';
  issues: EditorialDiagnosticIssue[];
}

interface EditorialModelCallRecordBase {
  stage: 'editorial_blueprint' | 'editorial_fidelity_review';
  ordinal: 1 | 2;
  gatewayConfigurationHash: Sha256;
  modelContextHash: Sha256;
  modelContextByteSize: number;
  promptVersion: string;
  promptHash: PromptFingerprint;
}

type EditorialModelCallRecord = EditorialModelCallRecordBase & (
  | {
      status: 'succeeded';
      provider: string;
      endpointHost: string;
      requestedModel: string;
      expectedModel: string;
      actualModel: string;
      modelVersion: string;
      traceId: string;
      responseHash: Sha256;
      tokens?: { prompt: number; completion: number; total: number };
    }
  | {
      status: 'failed';
      provider?: string;
      endpointHost?: string;
      requestedModel?: string;
      expectedModel?: string;
      actualModel?: string;
      modelVersion?: string;
      traceId?: string;
      responseHash?: never;
      failureCode: string;
    }
);

type EditorialFidelityAttempt =
  | {
      fidelityCall?: never;
      fidelityReviewHash?: never;
      fidelityReview?: never;
    }
  | {
      fidelityCall: Extract<EditorialModelCallRecord, { status: 'failed' }> & {
        stage: 'editorial_fidelity_review';
        inputBlueprintHash: Sha256;
      };
      fidelityReviewHash?: never;
      fidelityReview?: never;
    }
  | {
      fidelityCall: Extract<EditorialModelCallRecord, { status: 'succeeded' }> & {
        stage: 'editorial_fidelity_review';
        inputBlueprintHash: Sha256;
      };
      fidelityReviewHash: Sha256;
      fidelityReview: EditorialFidelityReview;
    };

type EditorialCandidateAttempt = {
  ordinal: 1 | 2;
  blueprintHash?: Sha256;
  plannerCall: EditorialModelCallRecord & { stage: 'editorial_blueprint' };
  outcome: 'accepted' | 'rejected' | 'call_failed';
  issueCodes: string[];
} & EditorialFidelityAttempt;

interface EditorialDiagnosticBase {
  version: 'editorial-diagnostic-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  sourceReportPackage: SourceArtifactRef;
  gatewayConfigurationHash: Sha256 | null;
  candidateAttempts: EditorialCandidateAttempt[];
  rejectedResponseHashes: Sha256[];
  checks: EditorialDiagnosticCheck[];
  issues: EditorialDiagnosticIssue[];
}

interface EditorialPreparedDiagnosticFields {
  requestKey: string;
  materialHash: Sha256;
  modelEgress: EditorialModelEgressDecision;
  modelContextHash: Sha256;
  modelContextByteSize: number;
}

type EditorialDiagnostic =
  | (EditorialDiagnosticBase & EditorialPreparedDiagnosticFields & {
      status: 'pass';
      mode: 'llm';
      generationId: string;
      publishedBlueprintHash: Sha256;
      htmlHash: Sha256;
    })
  | (EditorialDiagnosticBase & EditorialPreparedDiagnosticFields & {
      status: 'degraded';
      mode: 'deterministic_fallback';
      generationId: string;
      publishedBlueprintHash: Sha256;
      htmlHash: Sha256;
    })
  | (EditorialDiagnosticBase & {
      status: 'fail';
      mode: 'none';
      requestKey?: never;
      generationId?: never;
      materialHash?: never;
      modelEgress?: never;
      modelContextHash?: never;
      modelContextByteSize?: never;
      publishedBlueprintHash?: never;
      htmlHash?: never;
    })
  | (EditorialDiagnosticBase & EditorialPreparedDiagnosticFields & {
      status: 'fail';
      mode: 'llm' | 'deterministic_fallback';
      generationId?: never;
      publishedBlueprintHash?: never;
      htmlHash?: never;
    });
```

Diagnostic 不变量：

- 只有完整源快照冻结成功后才创建 Editorial Diagnostic；此前的 task、binding、Report Package、
  Review 或组件完整性失败只返回脱敏错误码，不创建半真半假的 Diagnostic。
- 冻结后的每个检查项恰好出现一次；上游硬失败后的后续检查记为 `not_run`。
- `gatewayConfigurationHash` 在全部分支都存在：可用且验证完成的 Gateway 配置写其 hash，未配置或
  配置被 typed factory 拒绝时写 `null`。存在 request key／manifest／model call 时必须与其中的配置
  字段闭合；`mode=none` 没有这些后续字段，只保留该调用已知的配置裁决。零调用 fallback 也不能
  丢失配置裁决。
- Diagnostic 的唯一 `source_integrity` check 只持久化创建该 Diagnostic 时已经完成的 source
  verification，不虚构“事件列表”。四类调用级 fence 固定为 start、每次 outbound call 前的
  pre-model、ready cache 返回前的 cache-return、原子发布前的 publish；任一 drift 都立即停止后续
  模型／返回／发布。cache-return 命中的是不可变的既有 generation，publish fence 又发生在最终提交
  前，因此失败只返回 `SOURCE_BINDING_CHANGED` 并写脱敏结构化进程日志／失败结果，不改写既有已发布
  Diagnostic，也不把未通过 fence 的 staging Diagnostic 当成成功审计记录。ready cache drift 不返回
  旧 cache，也不创建任何新输出。
- `model_egress` 是 deterministic check：allow 时 passed；deny 时也以受控 warning 记为 passed，表示
  默认拒绝策略已正确执行而不是系统错误。deny 时 `candidateAttempts=[]`、model call 为 0，最终只
  能在 fallback preflight 通过后发布 degraded。policy version/hash/decision/reason 必须与 request
  key、manifest 一致。
- `pass` 不得含 error、failed 或必需检查的 `not_run`；允许记录不影响完整性的视觉省略等 warning。
- `degraded` 表示 LLM 未配置、因预算跳过、调用失败或候选被拒后，Deterministic Blueprint
  成功发布；所有适用于 fallback 的发布硬检查仍必须 passed，LLM-only 检查可以 failed/not_run。
- fallback preflight 失败时使用 `status=fail/mode=deterministic_fallback`，顶层 issue code 固定为
  `SOURCE_NOT_RENDERABLE`，并保留具体的受控子 code；此时 `candidateAttempts=[]`，证明没有调用 LLM。
- `fail` 不创建 Editorial Report manifest。
- `mode=none` 只允许用于冻结后、Material/request key 完成前发生的 hard fail；其他 hard fail
  必须带 request key 与 material hash。该分支固定 `candidateAttempts=[]`、
  `rejectedResponseHashes=[]`、`model_egress=not_run`，且没有 model context 字段；类型联合禁止非法
  status/mode 组合。
- 每次 Planner 逻辑调用都有一个 attempt。只有 `generateStructured()` 成功返回 parsed Plan 时，
  才对其 canonical JSON 计算 `responseHash`；JSON 解析前抛错时不伪造响应 hash。Plan 通过 Schema、
  被确定性组装为 final Blueprint 且通过 envelope 校验后，才对 final bytes 计算 `blueprintHash`。
  所有且仅 `outcome=rejected` 的成功 Planner
  响应 hash 必须出现在 `rejectedResponseHashes`；`call_failed` 没有可伪造的 hash。
- `outcome=call_failed` 当且仅当 planner call 为 failed；accepted/rejected 必须有 succeeded call，
  accepted 还必须有 Blueprint hash，并且最多一个 candidate accepted。只有 Fidelity、render coverage、
  最终 component trace、HTML safety 和 byte-size 全部通过的候选才可 accepted；通过 Fidelity 但候选
  coverage/composition/size 失败时是 rejected，Renderer 漏渲染非空 block 或伪造 trace 则是 hard fail。
- `publishedBlueprintHash` 必须等于 manifest 引用的 Blueprint 文件 hash；ready 时它还必须等于
  唯一 `accepted` candidate 的 `blueprintHash`。降级 Blueprint 不伪装成 LLM candidate。
- main 当前的 `LLMInvocationError` 不携带实际 route、expected model 或 trace；失败调用只记录
  调用前可证明的 `gatewayConfigurationHash` 和已暴露字段，其他字段省略，禁止拿 client 的首 route identity
  冒充本次实际路由。
- `candidateAttempts` 最多 2 项，展平后的 model call 最多 4 项，`rejectedResponseHashes` 最多 2 项；
  每个 candidate 的 `issueCodes` 按 code 排序去重且最多 64 个。两个 Fidelity Review 各最多 240 个
  check；`copyPointer` 必须等于本地枚举出的 ASCII JSON Pointer 且最多 256 bytes，每个 check 的
  `materialUnitIds` 最多 16 个。Diagnostic 中顶层 `issues` 与全部 `checks[].issues` 合计最多 128 个，
  每个 issue 的 `materialUnitIds` 最多 16 个。`code/failureCode` 最多 64 ASCII bytes，`message` 最多
  512 UTF-8 bytes且来自不含 C0 control 的脱敏消息目录，`jsonPointer` 最多 256 ASCII bytes，
  provider/model/version/trace/prompt 字段各最多 256 UTF-8 bytes，endpoint host 最多 253 ASCII bytes。
  本段所有 string byte cap 均在 canonical JSON escaping 后计量。超量问题只记录固定聚合 code 与
  count，不能截取或塞入上游原文。保守上界为
  `480*(256+16*71+256) + 128*(64+512+256+16*71+256) + 128*67 + 128 KiB`
  （最后一项覆盖 4 个 model call 与固定 envelope），小于 1.5 MiB；V1 将
  Diagnostic hard limit 固定为 2 MiB，并用全字段最大值 fixture 对最终 canonical bytes 复核。
- 所有 message 都经过脱敏；不得记录完整 Prompt、Material 正文、凭证或上游原始响应。

### 9.5 Content Fidelity Review

LLM 只输出不含本地 hash 的 Review Plan；Pipeline 校验后确定性注入当前 Material/Blueprint hash，
形成 Diagnostic 保存的最终 Review：

```ts
interface EditorialFidelityCheck {
  copyPointer: string;
  materialUnitIds: string[];
  verdict:
    | 'faithful'
    | 'narrower'
    | 'unsupported'
    | 'certainty_upgraded'
    | 'numeric_drift'
    | 'qualification_lost';
}

interface EditorialFidelityReviewPlan {
  version: 'editorial-fidelity-plan-v1';
  checks: EditorialFidelityCheck[];
}

interface EditorialFidelityReview {
  version: 'editorial-fidelity-v1';
  materialHash: Sha256;
  blueprintHash: Sha256;
  verdict: 'pass' | 'block';
  checks: EditorialFidelityCheck[];
}

```

规则：

- Fidelity Review Plan 与 Blueprint Plan 是不同的 `generateStructured()` 调用，使用不同 schema name、
  prompt version 和 trace；`editorial-report-fidelity.schema.json` 只接受
  `EditorialFidelityReviewPlan`，模型不接收也不回显 `blueprintHash`。
- Validator 先枚举候选 Blueprint 中全部 `mode=paraphrase` 的 `EditorialCopy` JSON Pointer。
  Review Plan 必须对这些 Pointer 建立严格一一对应：每个 Pointer 恰好一条、不得缺失或额外增加，
  必须保持该枚举的 canonical 顺序，且 `materialUnitIds` 必须与该 Copy 的有序数组完全一致。
- Pipeline 只在上述校验通过后，用当前 `materialHash`、当前候选 canonical `blueprintHash` 和 Review
  Plan checks 组装最终 Review；最终 Review 的 `blueprintHash`、调用记录的 `inputBlueprintHash` 和当前
  候选 hash 必须三者相等。调用记录同时绑定 provider、endpoint host、请求／实际 model、prompt
  version/hash 和 trace。
- 对实际进入 Review 的候选，`fidelityCall` 必须存在；调用成功时还必须保存完整、无自由文本的
  `fidelityReview` 及其 canonical hash。成功 call 的 `responseHash` 只等于模型原始 Review Plan 的
  canonical hash；`fidelityReviewHash` 等于本地注入 hash 和 fold 后最终 Review 的 canonical hash，
  两者不得冒充相等。调用失败时不得伪造 Review。未通过前置确定性校验或没有
  paraphrase 的候选不创建 Fidelity 调用记录。
- Reviewer 只判断，不得回写或修复 Blueprint。
- 专有名词新增、替换或张冠李戴归为 `unsupported`；语义确定性升级归为 `certainty_upgraded`；限定条件
  丢失归为 `qualification_lost`。这些是 Reviewer 的语义判断，不得宣称由 deterministic token scanner
  完整证明。
- 最终 Review 的 top-level `verdict` 由 Pipeline 根据 checks 确定性 fold：只有 checks 与全部
  paraphrase 一一对应且每项均为 `faithful` 或 `narrower` 时才是 `pass`，否则为 `block`；Review Plan
  根本没有可供模型自报的 top-level verdict。
- 候选没有任何 paraphrase 时不调用 Reviewer，`content_fidelity` 由确定性检查记为 passed。
- LLM 判定不能覆盖确定性失败；任意 deterministic error 都直接 block。

### 9.6 Editorial Report manifest

```ts
interface EditorialReport {
  version: 'editorial-report-v1';
  authority: 'derived';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  sensitivity: string;
  redactionPolicyVersion: string;
  requestKey: string;
  generationId: string;
  status: 'ready' | 'degraded';
  sourceReportPackage: SourceArtifactRef;
  pipeline: {
    materialVersion: 'editorial-material-v1';
    modelContextVersion: 'editorial-model-context-v1';
    modelContextHash: Sha256;
    blueprintPlanVersion: 'editorial-blueprint-plan-v1';
    blueprintVersion: 'editorial-blueprint-v1';
    promptVersion: 'editorial-blueprint-prompt-v2';
    fidelityPromptVersion: 'editorial-fidelity-prompt-v2';
    fallbackVersion: 'editorial-fallback-v1';
    rendererVersion: 'editorial-html-v1';
    storeVersion: 'editorial-store-v1';
    modelEgress: EditorialModelEgressDecision;
    gatewayConfiguration: EditorialGatewayConfiguration | null;
  };
  modelCalls: EditorialModelCallRecord[];
  exportedAssets: Array<{ assetId: string; contentSha256: Sha256 }>;
  files: {
    material: DerivedFileRef;
    blueprint: DerivedFileRef;
    diagnostic: DerivedFileRef;
    html: DerivedFileRef & {
      mediaType: 'text/html';
      selfContained: true;
      printProfile: 'a4-portrait-v1';
    };
  };
  generatedAt: string;
}
```

`manifest.json` 是 generation 的完整性标记，并且在 staging 中最后写入；完整 staging 目录
原子 rename 到 request 的 `ready` 或 `fallback` slot 后才对外可发现。消费者必须从该 slot
读取并校验 manifest 与全部文件 hash；不能仅凭 HTML 文件存在判断成功。`printProfile` 只声明 Renderer 使用的
CSS profile，不声称运行期已经打印成功；屏幕和 PDF 结果仍须通过第 23、24 节的浏览器门禁。

Manifest 的 model call 最多 4 条、完整 route pool 最多 16 条、exported asset 最多 6 条；复用上一节
provider/host/model/trace/version 上限，asset/source logical ID 最多 256 UTF-8 bytes，四个
`DerivedFileRef.relativePath` 只能取 Material、Blueprint、Diagnostic、HTML 的固定文件名，manifest
自身文件名也固定，且不保存 Prompt 或响应正文。合法 manifest 的 canonical JSON 因而必须
小于 256 KiB；fallback preflight 使用该静态上界，Store 仍对最终实际 bytes 执行通用 8 MiB 门禁。

跨文件不变量：

- 目录名、Blueprint、Diagnostic、manifest 与 CLI stdout 的 `requestKey` 必须完全相等。
- Diagnostic、manifest 与 CLI stdout 的 `generationId` 必须完全相等。
- ready slot 当且仅当 `manifest.status=ready` 且 `diagnostic.status=pass/mode=llm`；fallback slot
  当且仅当 `manifest.status=degraded` 且 `diagnostic.status=degraded/mode=deterministic_fallback`。
- Material 文件 hash 必须同时等于 Blueprint `materialHash`、Diagnostic `materialHash` 和
  manifest `files.material.contentSha256`。
- `modelContextHash` 必须由已发布 Material 确定性重投影得到，并在 request key、Diagnostic、manifest
  与每条 model call record 中一致；fallback 没有 model call，但仍记录 context hash/byte size。
- Blueprint 文件 hash 必须同时等于 Diagnostic `publishedBlueprintHash` 与 manifest 文件引用；
  HTML 文件 hash 必须同时等于 Diagnostic `htmlHash` 与 manifest 文件引用。
- source Report Package ID/hash、task/plan/attempt binding、Pipeline 版本、model egress
  policy/decision 与 Gateway configuration 必须在所有出现位置相等；manifest `modelCalls` 必须是 Diagnostic
  candidate 中实际调用记录的 canonical 展平。
- Diagnostic 顶层 `gatewayConfigurationHash` 必须等于 manifest
  `pipeline.gatewayConfiguration?.gatewayConfigurationHash ?? null`；非 null 时还必须等于 request key
  中完整 configuration 重算值及每条 model call record 的值，null 时 model call 必须为空。
- manifest `authority` 必须固定为 `derived`；`sensitivity` 与 `redactionPolicyVersion` 必须逐字等于
  冻结的 Report Package Artifact，同样纳入已发布 slot 的复用校验。sidecar 不得自行降级敏感等级。
- manifest `exportedAssets` 必须与 generation ID 输入、Renderer 最终选择及 HTML 中的 `data:` 图片
  一一对应，按 Material asset canonical 顺序排列且 ID 唯一；省略的超限资产不得混入列表。

## 10. Materializer 规则

Materializer 只做机械转换：

- 从 Deliverable 的 finding graph 读取 fact、inference、analysis、summary 和 conclusion。
- 从 coverage 把 summary 反向关联到 question ID，再沿引用图传播到相关 Unit。
- 从 recommendations 生成 recommendation Unit，从 risks/open issues 只生成 risk/unknown Unit；
  validation 只能来自显式 projector 声明的验证字段。
- 对 V1 已登记的 deliverable-type projector 按声明的精确 JSON Pointer 提取 payload 叶子；未知、
  inactive 或无 projector 的 deliverable type 在 SourceReader 阶段 hard fail，不能静默退成低质量通用报告。
- `titleUnitId` 只在显式 projector 指向 payload 中的真实语义标题时设置；不得把 ReportDocument
  composer 的默认 title 或 `competitive_analysis_report` 等 technical ID 当作标题。
  `methodSummaryUnitId` 固定指向 Deliverable `methodSummary`。
- 从 ReportDocument 只读取章节顺序、导航标签和已经验证的 image、comparison、chart 引用；
  paragraph/list/fact/metric 不进入业务 Claim。被复用的标题类文案仅生成 `context` Unit；当前
  `chart_svg` 引用完成源完整性校验后按视觉策略告警省略，不生成 Material Asset。
- 每个源叶子生成一个 canonical Unit；相同文本位于不同 Pointer 时仍保留为不同 Unit，不做跨 Pointer 去重。
- 对 Evidence Manifest 暴露受限但可验证的索引，包括 Artifact/hash/Pointer、既有枚举字段、
  Tool provenance 和允许公开的 source URL；不暴露原始 Tool payload。
- 对 visual asset 只把已冻结的 manifest 元数据写入 Material；Renderer 按 asset ID 从
  `FrozenEditorialSource.verifiedVisualAssets` 取得已验证 bytes，不再读取 main。
- 不改变源对象，不回写任何字段，不根据自然语言猜测事实等级。

排序稳定规则：

1. question coverage 顺序；
2. finding graph 原始顺序；
3. recommendation 与 risk 原始顺序；
4. ReportDocument section/block 原始顺序；
5. ID 作为最终稳定 tie-breaker。

没有 `titleUnitId` 时，Renderer 使用版本化固定 UI copy，不创建 Material Unit、不进入 Fidelity：

| deliverableType | zh-CN 显示标题 |
|---|---|
| `research_plan` | 研究计划 |
| `competitive_analysis_report` | 竞品分析报告 |
| `voc_diagnosis_report` | VOC 诊断报告 |
| `design_audit_report` | 设计审计报告 |
| `accessibility_audit_report` | 无障碍审计报告 |

五类之外的 deliverable type 不进入 Renderer；固定标题映射使用 exhaustive switch。registry 新增
type 时必须同时补齐 payload projector、标题映射与逐类型验收，不得对 technical ID 做自由翻译。
该映射属于 `rendererVersion` 控制的 UI 文案，不是业务事实。

section role 同样有固定标签：decision=核心判断、positioning=定位、audience=人群、
motivation=动机、journey=关键链路、strategy=策略、opportunity=机会、roadmap=行动路线、
validation=验证计划、risk=风险与未知、boundary=适用边界、audit=证据与审计。Blueprint 提供
合法 source-backed title 时可以替代标签；Deterministic Blueprint 省略这些 title，只使用固定标签。

### 10.1 V1 payload projector 清单

V1 对 main 基线中五个 active deliverable type 全部使用显式 projector。main 的 `DeliverableType`
当前是开放的 `string`，不能拿它伪装穷尽检查；Editorial 模块必须定义本地 literal union，并让映射
在编译期穷尽：

```ts
type EditorialDeliverableType =
  | 'research_plan'
  | 'competitive_analysis_report'
  | 'voc_diagnosis_report'
  | 'design_audit_report'
  | 'accessibility_audit_report';

const editorialProjectors = {
  // 五个具名 projector；不得动态递归 payload。
} satisfies Record<EditorialDeliverableType, ExplicitEditorialProjector>;
```

runtime 先把开放 string 解析为该 union，失败即 `EDITORIAL_DELIVERABLE_UNSUPPORTED`。不存在通用递归
projector，也不存在“未知类型只取看起来像 title/metric/priority 的字段”这种 fallback。每个 projector
固定其 payload schema、精确 Pointer、role、状态、group、basis、Evidence 映射、unit、metric
eligibility 和组件资格规则。

统一规则：

- payload 先通过 active Deliverable Registry 指定的 JSON Schema；projector 后验证主键唯一、外键
  完整和关系 cardinality。悬空 ID、重复主键或 Evidence/Asset 绑定错误 hard fail。
- `id`、`pageId`、`themeId`、`datasetId`、`differenceId`、`issueId`、`assetId` 等控制键只用于
  join，不渲染为业务 Unit；Editorial 边界统一要求非空且 UTF-8 不超过 256 bytes，超限以
  `EDITORIAL_IDENTIFIER_TOO_LARGE` hard fail。每个内容叶子各有精确 `SourcePointer`；不得把对象
  整体序列化成 Unit。
- payload projector 永远不能产生 `fact`；V1 的 fact 唯一来自 FindingGraph `FactFinding`。方法、
  范围和证据摘录使用 `context|audit`，分析判断使用 `claim/inference`，动作使用
  `recommendation/inference`，未来检查和期望结果使用 `validation/unknown`。
- 这五个 payload schema 都没有 ProblemGraph question ID。payload Unit 的 `questionIds=[]`；不得按
  文本或碰巧相同的局部 ID 猜 question。问题覆盖继续由 FindingGraph/coverage Unit 提供。
- 只复制 schema 明示的 `evidenceIds|evidenceId`。唯一例外是 VOC frequency/sentiment：schema 通过
  `themeId` 明确关联 theme，故可复制该 theme 已验证的 Evidence ID；其他同组字段只建立 basis，
  不伪造直接 Evidence 绑定。
- 下表列出的内容叶子均生成 `requiredInOutput=true` Unit。任一 Unit 绑定 blocked/sensitive Evidence
  时按第 9.2 节 fail closed；不得删掉 Evidence ID 后继续暴露文本。
- 下表所有 `claim|recommendation|validation` Unit 同时 `requiredInBody=true`；各类型在表后另列核心
  context anchor。VOC representative quote 虽为 audit 也必须在正文呈现。其余 context/audit Unit
  留在完整附件，避免用方法细节淹没主叙事。
- 关系不完整但未违反 schema/外键时保留独立 Unit，并把需要完整矩形、pair 或 gate 的高级组件标为
  ineligible；不能为了组件数量补齐数据。

#### 10.1.1 `research_plan`

Schema：`schemas/deliverables/research-plan.schema.json`。

| 精确 Pointer pattern | Unit role / 状态 | group、basis 与固定元数据 |
|---|---|---|
| `/payload/title` | `context` | `research-plan`；设置 `titleUnitId` |
| `/payload/researchGoal` | `context` | `research-plan` |
| `/payload/scope/market`、`/payload/scope/subjects/{i}`、`/payload/scope/timeWindow` | `context` | `research-scope` |
| `/payload/competitorSampling/strategy`、`/payload/competitorSampling/inclusionCriteria/{i}`、`/payload/competitorSampling/exclusionCriteria/{i}` | `audit` | `research-sampling`；后两者 basis=strategy |
| `/payload/competitorSampling/targetCount` | `context` | `research-sampling`；basis=strategy；number，`unit=个`，`metricEligible=true`；Renderer 固定标签“目标样本数” |
| `/payload/researchQuestions/{i}` | `context` | `research-question:{i}`；不是 question ID |
| `/payload/comparisonDimensions/{i}/name`、`/payload/comparisonDimensions/{i}/purpose`、`/payload/comparisonDimensions/{i}/collectionFields/{j}` | `audit` | `research-dimension:{id}`；purpose/field basis=name |
| `/payload/sourcePlan/{i}/evidenceClass`、`/payload/sourcePlan/{i}/sourceTypes/{j}`、`/payload/sourcePlan/{i}/purpose` | `audit` | `research-source:{i}`；sourceTypes/purpose basis=evidenceClass；这里的 class 不是实际 Evidence 绑定 |
| `/payload/executionPlan/{i}/phase` | `context` | `research-phase:{i}` |
| `/payload/executionPlan/{i}/activities/{j}` | `recommendation/inference` | 同 phase group；basis=phase |
| `/payload/executionPlan/{i}/duration`、`/payload/executionPlan/{i}/outputs/{j}` | `audit` | 同 phase group；basis=phase |
| `/payload/collectionTemplate/{i}/field`、`/payload/collectionTemplate/{i}/description`、`/payload/collectionTemplate/{i}/evidenceRequired` | `context`、`audit`、`audit` | `collection-field:{i}`；后二者 basis=field；boolean 原值不得字符串化 |
| `/payload/analysisMethods/{i}` | `audit` | `research-method:{i}` |
| `/payload/deliverables/{i}` | `context` | `research-deliverable:{i}` |
| `/payload/qualityChecks/{i}` | `validation/unknown` | `research-quality:{i}` |

可启用：目标样本 `metric-cards`，scope/sampling/dimension/source/collection `card-grid`，按源数组与
phase 的 `flow|roadmap`，以及通用 truth/risk/audit。`qualityChecks` 缺少成对的 label/method，不能单独
启用 `validation-gates`。核心 context anchor 固定为 title、researchGoal、全部 scope 叶子、
targetCount、researchQuestions、executionPlan.phase 和 deliverables；这些 Unit 必须进入正文。

#### 10.1.2 `competitive_analysis_report`

Schema：`schemas/deliverables/competitive-analysis-report.schema.json`。

| 精确 Pointer pattern | Unit role / 状态 | group、basis、Evidence 与固定元数据 |
|---|---|---|
| `/payload/competitorSamples/{i}/name` | `context` | `competitive-sample:{id}` |
| `/payload/competitorSamples/{i}/rationale` | `claim/inference` | 同 sample group；使用对象 `evidenceIds` |
| `/payload/dimensionMatrix/{i}/dimension` | `context` | `competitive-dimension:{i}` |
| `/payload/dimensionMatrix/{i}/values/{j}/value` | `claim/inference` | `competitive-cell:{i}:{sampleId}`；basis 必须直接包含本行 dimension Unit 与该 `sampleId` 的 sample name Unit；使用 value `evidenceIds` |
| `/payload/dimensionMatrix/{i}/values/{j}/score` | `claim/inference` | 同 cell group；basis 必须直接包含本行 dimension Unit、该 sample name Unit 与同 cell 的 value Unit；number，`unit=/5`、`metricEligible=true`；使用 value `evidenceIds` |
| `/payload/dimensionMatrix/{i}/weight` | `audit` | 同 dimension；number，`unit=ratio`、`metricEligible=false` |
| `/payload/differences/{i}/dimension` | `context` | `competitive-difference:{id}`；schema 无 dimension ID，不与 matrix 做文本 join |
| `/payload/differences/{i}/statement` | `claim/inference` | `competitive-difference:{id}`；使用对象 `evidenceIds` |
| `/payload/impacts/{i}/audience`、`/payload/impacts/{i}/statement` | `context`、`claim/inference` | 对应 difference group；两者 basis=difference statement |
| `/payload/actionRecommendations/{i}/statement`、`/payload/actionRecommendations/{i}/priority` | `recommendation/inference` | `competitive-action:{id}`；basis=全部 `differenceIds`；保留源 P0-P3 |
| `/payload/scoringMethod/{i}` | `audit` | `competitive-scoring:{i}`；不生成指标结论 |
| `/payload/roadmap/{i}/statement`、`/payload/roadmap/{i}/priority` | `recommendation/inference` | `competitive-roadmap:{i}`；保留源 P0-P2 |
| `/payload/roadmap/{i}/metric`、`/payload/roadmap/{i}/validationMethod` | `validation/unknown` | 同 roadmap group；basis=statement |
| `/payload/instrumentationPlan/{i}`、`/payload/userTestScript/{i}` | `validation/unknown` | 分别按数组 index group；用户测试顺序只取源数组顺序 |
| `/payload/visualEvidence/{i}/dimension`、`/payload/visualEvidence/{i}/caption` | `context` | `competitive-visual:{id}`；两 Unit 使用对象 `evidenceIds`，sampleIds 必须解析，asset 必须匹配 verified ReportDocument |
| `/payload/screenshotComparisons/{i}/dimension`、`/payload/screenshotComparisons/{i}/caption` | `context` | `competitive-comparison:{id}`；sampleIds 必须解析；两个 asset 必须匹配 verified comparison 与 lineage |

`managementSummary` 不投影，避免把缺少逐项 Evidence binding 的摘要复制成第二套结论；使用
FindingGraph summary/conclusion。可启用完整 dimension×sample `strategy-matrix`、显式 priority
`roadmap`、roadmap statement+validationMethod `validation-gates`、user test `flow`、视觉画廊／对比，
以及 metric/card/truth/risk/audit。矩阵、关系和 asset 任一绑定不完整时相应组件 ineligible 或 hard fail，
不得文本匹配补链。具体地，矩阵缺少可选行列组合只会令矩阵 ineligible；任何已声明的 foreign ID、
Evidence ID 或 Asset/lineage 无法解析则 hard fail。核心 context anchor 固定为 competitor name、
matrix/difference/visual dimension、impact audience 与所有视觉 caption；这些 Unit 必须进入正文。

#### 10.1.3 `voc_diagnosis_report`

Schema：`schemas/deliverables/voc-diagnosis-report.schema.json`。dataset/theme ID 必须唯一；
`theme.datasetIds` 和所有 `themeId` 必须解析。

| 精确 Pointer pattern | Unit role / 状态 | group、basis、Evidence 与固定元数据 |
|---|---|---|
| `/payload/datasets/{i}/name`、`/payload/datasets/{i}/source` | `context`、`audit` | `voc-dataset:{id}`；source basis=name |
| `/payload/datasets/{i}/recordCount` | `context` | 同 dataset；basis=name；number，`unit=条`、`metricEligible=true` |
| `/payload/themes/{i}/label` | `claim/inference` | `voc-theme:{id}`；basis=关联 dataset name；使用 theme `evidenceIds` |
| `/payload/frequencies/{i}/count` | `claim/inference` | 对应 theme group；basis=theme；复制 theme Evidence；number，`unit=条`、`metricEligible=true` |
| `/payload/frequencies/{i}/share` | `claim/inference` | 同上；number，`unit=ratio`、`metricEligible=true` |
| `/payload/sentiments/{i}/label`、`/payload/sentiments/{i}/score` | `claim/inference` | 对应 theme group；basis=theme；复制 theme Evidence；score number、`metricEligible=true` |
| `/payload/representativeQuotes/{i}/quote` | `audit` | 对应 theme group；basis=theme；只使用该对象 `evidenceId` |
| `/payload/severities/{i}/level`、`/payload/severities/{i}/rationale` | `claim/inference` | 对应 theme group；basis=theme+同主题 frequency/sentiment；直接 Evidence 为空 |
| `/payload/priorities/{i}/level`、`/payload/priorities/{i}/rationale` | `claim/inference` | 对应 theme group；basis=theme+frequency/sentiment/severity；直接 Evidence 为空 |

可启用 record/frequency/share/sentiment `metric-cards`、theme `card-grid`；显式 P0-P3 可按 lane 使用
`roadmap`，但只能表达主题优先级，不能虚构行动。VOC schema 没有 source-backed 的矩阵列标签，
因此不启用 `strategy-matrix`；payload 本身也不启用 validation gate 或视觉组件。
核心 context anchor 固定为 dataset name 与 recordCount；theme label 已是 body-required claim。

#### 10.1.4 `design_audit_report`

Schema：`schemas/deliverables/design-audit-report.schema.json`。page/issue ID 必须唯一；所有 `pageId`
和 `issueId` 必须解析。

| 精确 Pointer pattern | Unit role / 状态 | group、basis 与资产规则 |
|---|---|---|
| `/payload/pages/{i}/name`、`/payload/pages/{i}/state` | `context` | `design-page:{id}`；state basis=name |
| `/payload/issues/{i}/statement` | `claim/inference` | `design-issue:{id}`；basis=page name/state；直接 Evidence 为空 |
| `/payload/principles/{i}/principle`、`/payload/principles/{i}/rationale` | `claim/inference` | 对应 issue group；basis=issue statement |
| `/payload/severities/{i}/level`、`/payload/severities/{i}/rationale` | `claim/inference` | 对应 issue group；basis=issue+principle |
| `/payload/annotatedScreenshots/{i}/annotation` | `claim/inference` | 对应 issue group；basis=issue；asset 必须匹配 verified comparison/annotation lineage |
| `/payload/remediations/{i}/action` | `recommendation/inference` | 对应 issue group；basis=issue+principle+severity |
| `/payload/remediations/{i}/acceptanceCriteria/{j}` | `validation/unknown` | 对应 issue group；basis=action+issue |
| `/payload/retests/{i}/method`、`/payload/retests/{i}/expectedResult` | `validation/unknown` | 对应 issue group；basis=issue+remediation/criteria |

可启用 page/issue `card-grid`；remediation+retest 启用 `validation-gates`；verified 原图/标注图通过 Material Asset
relation 使用固定对比布局。没有 priority 或 numeric 叶子，不能启用 roadmap 或 metric cards。
page/principle/severity/remediation 是同一 issue 的异构字段，不是带 source-backed column label 的矩形，
因此不启用 `strategy-matrix`。
核心 context anchor 固定为 page name/state；issue statement 已是 body-required claim。

#### 10.1.5 `accessibility_audit_report`

Schema：`schemas/deliverables/accessibility-audit-report.schema.json`。该 schema 没有 issue 主表；所有
`issueId` 的并集只作为稳定 group key，不能制造问题标题或与 FindingGraph ID 猜测关联。

| 精确 Pointer pattern | Unit role / 状态 | group 与 basis |
|---|---|---|
| `/payload/platforms/{i}/name`、`/payload/platforms/{i}/assistiveTechnology`、`/payload/platforms/{i}/browser` | `context`、`audit`、`audit` | `a11y-platform:{i}`；后两者 basis=name |
| `/payload/pourPrinciples/{i}/principle`、`/payload/pourPrinciples/{i}/rationale` | `claim/inference` | `a11y-issue:{issueId}` |
| `/payload/components/{i}/component`、`/payload/components/{i}/selector` | `context`、`audit` | 同 issue group |
| `/payload/conformanceLevels/{i}/level`、`/payload/conformanceLevels/{i}/criterion` | `claim/inference` | 同 issue group；basis=component；原样保留 schema 的 A/B/C，禁止改写成 WCAG A/AA/AAA |
| `/payload/priorities/{i}/level`、`/payload/priorities/{i}/rationale` | `claim/inference` | 同 issue group；basis=principle+conformance+observed；保留 P0-P3 |
| `/payload/screenReaderBehavior/{i}/observed` | `claim/inference` | 同 issue group；basis=同 issue component；schema 未提供 platform 外键，不建立该边 |
| `/payload/screenReaderBehavior/{i}/expected` | `validation/unknown` | 同 issue group；basis=observed |
| `/payload/remediations/{i}/action` | `recommendation/inference` | 同 issue group；basis=observed+principle+conformance |
| `/payload/verification/{i}/method`、`/payload/verification/{i}/expectedResult` | `validation/unknown` | 同 issue group；basis=remediation+observed/expected |

可启用 platform/issue `card-grid`；显式 priority+remediation 启用 `roadmap`；
remediation+verification 启用 `validation-gates`；observed→expected
可使用 `flow`，但只表达 schema 明示的现状与期望，不扩写为因果链。没有 numeric 或 asset 叶子，
payload 本身不能启用 metric cards 或 visual gallery；platform 与 issue 没有外键，不能作为矩阵列，
因此不启用 `strategy-matrix`。核心 context anchor 固定为全部 platform
name/assistiveTechnology/browser 与 component；selector 只进入附件。

## 11. LLM 的职责与禁止事项

### 11.1 可以做

- 选择决策优先的章节顺序。
- 在组件白名单中选择最合适的表达形式。
- 将相关 Material Unit 聚类为人群卡、路径、矩阵、路线图或验证 Gate。
- 为章节生成短标题、导语和受来源约束的精炼表述。
- 把详细内容下沉到审计附件，同时保证 required unit 不丢失。

### 11.2 不可以做

- 输出 HTML、CSS、JavaScript、SVG、Markdown HTML 或组件代码。
- 新增事实、指标、数字、日期、专有名词、证据 ID、URL 或视觉资产。
- 把推断或未知写成事实，把建议写成已经验证的效果。
- 修改 sourceRefs、evidenceIds、questionIds 或 epistemic status。
- 删除限定条件、风险、反例或 required unit。
- 访问网络、调用 Tool、读取文件或执行代码。
- 修复 Canonical Report Package。发现源错误时只能 block 并输出脱敏诊断。

### 11.3 调用预算

CLI 从同一份已校验 Gateway 配置构造不可变模型策略，并与 `LLMClient` 一并注入 Pipeline；不能只用
`LLMClient.identity`，因为它只暴露首个 route。模型身份合格不等于允许数据出境，Pipeline 还必须
应用独立的固定 policy：

```ts
interface EditorialModelEgressPolicy {
  version: 'editorial-model-egress-v1';
  defaultDecision: 'deny';
  allowed: readonly [
    {
      sensitivity: 'public';
      redactionPolicyVersion: 'v1';
      provider: 'gateway';
      mode: 'real';
      endpointHost: 'llm-gw.jd.local';
      endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions';
      redirectMode: 'error';
    },
    {
      sensitivity: 'internal';
      redactionPolicyVersion: 'v1';
      provider: 'gateway';
      mode: 'real';
      endpointHost: 'llm-gw.jd.local';
      endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions';
      redirectMode: 'error';
    }
  ];
  policyHash: Sha256;
}

interface EditorialModelEgressDecision {
  policyVersion: 'editorial-model-egress-v1';
  policyHash: Sha256;
  decision: 'allow' | 'deny';
  reasonCode:
    | 'EGRESS_ALLOWED'
    | 'EGRESS_SENSITIVITY_DENIED'
    | 'EGRESS_REDACTION_POLICY_DENIED'
    | 'EGRESS_PROVIDER_DENIED'
    | 'EGRESS_MODE_DENIED'
    | 'EGRESS_ENDPOINT_DENIED'
    | 'EGRESS_REDIRECT_POLICY_DENIED'
    | 'EGRESS_MODEL_UNCONFIGURED';
  evaluated: {
    sourcePolicySetHash: Sha256;
    contributingSourceCount: number;
    sensitivities: string[];
    redactionPolicyVersions: string[];
    provider: string | null;
    mode: 'mock' | 'real' | 'draft' | null;
    endpointHost: string | null;
    endpointUrl: string | null;
    redirectMode: 'error' | null;
  };
}

interface EditorialGatewayConfiguration {
  provider: string;
  endpointHost: string;
  endpointUrl: string;
  mode: 'mock' | 'real' | 'draft';
  eligibleAsReal: boolean;
  redirectMode: 'error';
  routes: ReadonlyArray<{
    requestedModel: string;
    expectedActualModel: string;
    expectedActualModelExplicit: true;
  }>;
  limits: EditorialLLMLimits;
  gatewayConfigurationHash: Sha256;
}

interface EditorialStructuredModelClient {
  readonly configurationIdentity: {
    provider: string;
    endpointHost: string;
    endpointUrl: string;
    mode: 'mock' | 'real' | 'draft';
    eligibleAsReal: boolean;
    routes: ReadonlyArray<{
      requestedModel: string;
      expectedActualModel: string;
      expectedActualModelExplicit: boolean;
    }>;
  };
  generateStructured<T>(options: {
    prompt: string;
    schema: object;
    schemaName: 'editorial-report-blueprint' | 'editorial-report-fidelity';
    context: object;
    limits: EditorialLLMLimits;
    redirectMode: 'error';
  }): Promise<Omit<LLMResult<T>, 'receiptId'>>;
}

type EditorialModelPort =
  | { client: null; configuration: null }
  | { client: EditorialStructuredModelClient; configuration: EditorialGatewayConfiguration };

type GatewayConfigurationErrorCode =
  | 'PROVIDER_UNCONFIGURED'
  | 'GATEWAY_BASE_URL_MISSING'
  | 'GATEWAY_API_KEY_MISSING'
  | 'GATEWAY_ENDPOINT_INVALID'
  | 'GATEWAY_ROUTE_INVALID'
  | 'GATEWAY_ACTUAL_MODEL_PIN_MISSING';

export class GatewayConfigurationError extends Error {
  readonly name = 'GatewayConfigurationError';

  constructor(readonly code: GatewayConfigurationErrorCode, message: string) {
    super(message);
  }
}

interface EditorialLLMLimits {
  overallTimeoutMs: 90_000;
  maxHttpAttempts: 3;
  maxRetryAfterMs: 5_000;
  maxResponseBytes: 1_048_576;
  maxOutputTokens: 8_000;
}
```

`EditorialModelEgressPolicy` 是 production source 中的冻结常量，`policyHash` 对除自身外的完整
canonical JSON 计算；其中 endpoint 对应 main `.env.example:13` 的现有内网 Gateway，不引入第二个
服务地址。CLI 参数、环境变量和依赖注入都不能增补 allow rule。host 取
`new URL(baseUrl).host.toLowerCase()` 的精确结果。endpoint 组合算法同样固定：先用 URL parser 解析并
拒绝 username/password/query/hash；对 parser 已规范化的 pathname 只去除尾斜杠，再追加
`/chat/completions` 并序列化为无尾斜杠 canonical URL。main 的 `/v1` 因而得到
`/v1/chat/completions`，而其他可解析 path 会保留并在下述精确 egress policy 比较中 deny。禁止
`new URL('/chat/completions', baseUrl)` 这类会丢掉 `/v1` 的 root-relative 拼接。host 和 URL 都不做
后缀、子串、DNS 或重定向等价匹配。V1 的矩阵因此是：

`GatewayLLMClient` constructor 只执行一次上述算法，并把结果保存为不可变
`canonicalRequestUrl`；`configurationIdentity.endpointUrl`、`gatewayConfigurationHash`、egress 比较
和 `callOnce()` 的实际 `fetch()` target 必须读取这**同一个字符串**。`callOnce()` 禁止再使用
`` `${baseUrl}/chat/completions` `` 或任何第二套拼接逻辑，避免尾斜杠输入使已审计 URL 与真实 POST
地址不同。

| sensitivity | redactionPolicyVersion | provider / mode / endpoint | decision |
|---|---|---|---|
| `public` 或 `internal` | 精确 `v1` | `gateway` / `real` / canonical URL / `redirect=error` | allow |
| `sensitive`、`confidential` 或任意未知值 | 任意 | 任意 | deny |
| `public` 或 `internal` | 非 `v1` 或未知 | 任意 | deny |
| 任意 | 任意 | 未配置、mock、draft、非 gateway 或非精确白名单 host | deny |

矩阵逐个应用于第 9.2.1 节 canonical source policy set；只有每个成员都命中同一 allow rule 才允许
整个 context。`sensitivities` 与 `redactionPolicyVersions` 在 decision 中按 Unicode code point 排序、
去重并限制为最多 16 个短值，完整集合只以 `sourcePolicySetHash` 绑定。规则按表中从上到下的固定
reason priority 求值，默认 deny。尤其 `sensitive` 永不发送，即使 Gateway
身份完全合格；V1 不新增脱敏器来试图把它“加工成可发送”。policy version/hash、完整 decision 与
受控 reason code 必须进入 `requestKey`、Diagnostic 和 manifest。decision 为 deny 时，Pipeline
仍先完成 fallback preflight，随后保持 model call spy 为 0 并发布 degraded；不得尝试一次模型调用
来探测配置是否可用。

`gatewayConfigurationHash` 是除自身外全部字段（包括 canonical endpoint URL、完整 route pool、
limits 与 `redirectMode='error'`）的 canonical SHA-256；route
保持配置顺序且不得截断。每条 route 的 actual model pin 必须来自显式
`LLM_MODEL_ROUTES=requested=expected`，或单 route 模式下显式非空的
`LLM_EXPECTED_ACTUAL_MODEL`；当前 main 对缺失 pin 回落 requested model 的兼容行为不能用于 Editorial，
`expectedActualModelExplicit=false` 时整个 Editorial port 归一为未配置。Pipeline 验证每个成功响应的 provider、endpoint host 与 configuration 相等，
`providerIdentity.requestedModel` 属于 configuration，
并用该 route 的 `expectedActualModel` 检查实际 `modelName`。无法构造完整 configuration 的 provider
不进入 ready 路径。

该专用端口刻意不暴露 `receipt`、`generateText` 或 `ModelCallRecorder`，并要求
`configurationIdentity`；现有 `ReceiptLLMClient` 不满足结构，不能误注入 sidecar Pipeline。
Gateway 原始 client 仍需在 runtime 拒绝任何意外 `receiptId`，避免类型断言绕过边界。

为避免 CLI 重复解析环境变量，`GatewayLLMClient` 新增只读、无凭证的
`configurationIdentity` getter，只暴露 provider、mode/eligibility、endpoint host、canonical endpoint
URL、完整有序 route 及其 pin 是否显式；绝不暴露 API key。constructor 对解析结果逐层 copy/freeze，
getter 返回独立的 deep-copy/deep-freeze snapshot，不暴露内部 `cfg` 或可变 route 对象。该 snapshot
必须来自将被调用的同一个 Gateway 实例，不能重新解析一次环境变量后假设二者相同。CLI 用它构造并
deep-freeze `EditorialGatewayConfiguration`；Pipeline 紧邻**每一次** Planner/Fidelity outbound call
前重新取得 client snapshot，逐字段 deep-equal configuration 的 provider、host、URL、mode、eligibility
与有序 routes，并重算 configuration hash。任一不等以 `EDITORIAL_MODEL_PORT_MISMATCH` hard fail，
该次调用不得发出，不能退化为 fallback 掩盖错误装配。

Gateway 配置解析新增上述 `GatewayConfigurationError`，或提供返回同一 typed error 的专用 factory；
`createEditorialModelPort()` 只能按 `error.code` 把这六类缺失或无法安全 canonicalize 的配置问题归一为
`client=null/configuration=null`。禁止根据 message 正则分类，也禁止 `catch (unknown) => fallback`；
普通 `Error`、`TypeError`、programmer bug 和不在枚举内的异常必须继续抛出。该错误仍是 `Error`
子类，因此 main 既有调用的异常兼容面不变。可安全 canonicalize 但不在 allowlist 的 host/path/provider
不得伪装成“未配置”，必须保留 configuration 并由 egress policy 给出相应 deny reason。该 getter
不加入通用 `LLMClient`，其他 provider 必须
显式提供等价 adapter，否则 composition root 将 client/configuration 一并归一为 `null`，只能走
fallback；不允许“有 client、无 configuration”的半配置状态。

- Blueprint 最多两次逻辑调用：一次初稿，一次带诊断修复。
- 每个合格候选最多一次 Fidelity Review；修复后的候选再评审一次。
- Gateway configuration 必须保留 main 配置的完整有序 route pool；当前 `.env.example` 的标准 4 条
  route 必须合格，不能因 sidecar 自设三条上限而无条件降级。为限制恶意配置，完整 configuration
  最多 16 条 route
  且 canonical JSON 不超过 16 KiB；超限整体判为不合格，不截断后继续。
- `StructuredLLMCallOptions` 增加可选 limits 与 `redirectMode`，`GatewayLLMClient` 在 sidecar 提供它们时：限制整个逻辑
  调用为 90 秒和最多 3 次 HTTP 请求（跨完整 route pool 合计，不是每 route 三次）；把 Retry-After
  截至 5 秒且不得越过总 deadline；请求携带
  `max_tokens=8000`；对成功和错误响应都以流式计数方式在 1 MiB 处终止读取，禁止先无界
  `res.json()`／`res.text()`；并为 sidecar 调用固定 `fetch(..., {redirect: 'error'})`，任何 3xx 都按
  调用失败降级，禁止把携带 Material 的 POST body 自动转发。未传 limits 的既有 main 调用保持原行为。
- Pipeline 不在 Gateway 之外叠加重试；最多两次 Blueprint 与每候选一次 Fidelity 的逻辑上限
  和上述 HTTP 上限共同约束时间、内存与费用。
- Pipeline 实现 sidecar-only model receipt gate，不使用会写 `control_model_calls` 的
  `ReceiptLLMClient`。每次响应必须同时满足：响应 `providerIdentity.mode=real`、
  `eligibleAsReal=true`、`expectedModel` 非空且 `modelName === expectedModel`；否则记录脱敏的
  `MODEL_IDENTITY_INVALID` 或 `MODEL_DRIFT` 并进入确定性降级。响应出现 `receiptId` 同样以
  `EDITORIAL_RECEIPT_CLIENT_FORBIDDEN` hard fail 且不发布 sidecar；这是对错误装配的最后诊断，不能
  回滚已经发生的写入，真正的零写保证来自专用端口、官方 CLI composition root 与全表集成快照。
- Egress decision 必须在任何 `generateStructured()` 前为 allow；Planner 和 Fidelity 共用同一个冻结
  decision，不得在两次调用间重新放宽。每一次 Planner/Fidelity 请求都必须在紧邻调用前依次完成
  `assertStillCurrent()`、client/configuration deep comparison 和 egress allow 检查；前一次调用成功
  不能授权下一次调用。若 source binding 在发布前变化，已完成的模型响应全部丢弃，
  以 `SOURCE_BINDING_CHANGED` hard fail，不发布 fallback 或候选。
- Material 超过 400 个 Unit 或 120,000 个文本字符时，在 fallback preflight 通过后跳过 LLM，
  直接发布确定性降级。
- Planner 初稿的完整 `EditorialModelContext`、Planner repair 的同一 Context 加 bounded repair hints，
  以及 Fidelity 的同一 Context 加候选 copy 列表，各自 request context envelope 不超过 512 KiB；按
  实际 canonical UTF-8 bytes 计数，任一超限不调用对应 LLM 并使用 fallback。
- LLM 候选最多 12 节、48 个 block、240 个 `EditorialCopy`、60,000 个总文案 code point；
  `paraphrase` 单项最多 600，`verbatim` 单项最多 16,000 且必须精确匹配 Unit。Deterministic
  Blueprint 不受 LLM 输出预算约束，但仍最多 48 个 block、1,200 个 `EditorialCopy` 和 600,000
  个总文案 code point。narrative paragraph、card、flow step、matrix row、roadmap item、gate 和 risk
  item 每个 block 最多 24 个，matrix 最多 8 列，gallery 最多 6 个 asset；唯一 audit appendix 的
  `unitIds/evidenceIds` 与 truth-triad 的三类直接 ID 合计分别可到 Material hard limit 1,000。
  mode 分支的字符串上限和局部数组上限进入 JSON Schema；候选／fallback 的跨 block 总量由
  Validator 按运行模式计数，不能只在 Prompt 中描述。

## 12. 内容保真与证据闸门

校验顺序固定，前一项失败时不运行依赖它的后续项：

1. **Source integrity**：重验 Report Package 与其全部引用组件，并执行 start、逐调用 pre-model、
   cache-return 与 publish 四类 current-binding fence。
2. **Model egress**：按固定默认拒绝策略裁决本次最小 Model Context 是否可发送；deny 是零调用降级路径。
3. **Model identity**：每个 LLM 响应的 provider identity 合格，实际 model 与 expected model 完全一致。
4. **Schema integrity**：Blueprint Plan 与 Fidelity 两类 LLM 响应分别通过 JSON Schema，拒绝未知字段。
5. **Reference integrity**：所有 Material、Asset、Evidence 和 question 引用存在且绑定一致。
6. **Component relation**：按第 9.3 节逐 kind 验证 label/value、title/body、row/column/cell、
   lane/item、risk/response 与 asset/caption 的显式 group/basis/projector 关系。
7. **Epistemic integrity**：输出状态不得比最保守来源更强。
8. **Numeric integrity**：敏感 token 必须 verbatim，ratio 必须用 decimal-string 算法显示。
9. **Content coverage**：同时满足第 12.1 节的正文覆盖，以及唯一 audit appendix 对所有 required
   Unit 的逐项、verbatim、无重复闭包；正文与附件两部分缺一不可。
10. **Visual policy**：只允许 verified、`exportPolicy=allow` 的 PNG/JPEG/WebP；合法 mask/block/SVG
    受控省略，未知 media/policy 或完整性错误 hard fail。
11. **Content fidelity**：仅在上述 Blueprint 确定性闸门通过后，独立 LLM 才逐项判定 paraphrase。
12. **Composition quality**：渲染后按最终可导出资产与非空 block trace 重算 eligibility/used kind。
13. **HTML safety**：验证 trace、转义、CSP、无脚本、无外部资源和大小上限。

源报告已经通过 Report Review 仍不意味着后处理可以放松校验。Editorial Pipeline 改变了信息组织和部分文案，因此必须单独证明没有改变结论含义。

Fallback preflight 复用同一校验器，但 `model_identity` 与 `content_fidelity` 记为 `not_run`：它不含
LLM 文案；`model_egress` 仍必须执行并记录。其余 deterministic gate 和 HTML gate 必须全部 passed。
LLM 候选只有通过前置 gate 和 Fidelity 后才渲染；候选最终 coverage/composition／8 MiB 失败属于候选
拒绝，可回落已预检 fallback。Renderer 对非空 block 的漏渲染、伪造 trace、unsafe HTML、未分类
异常，或已预检 fallback 的任一门禁失败都属于 hard fail，不能用 fallback 掩盖 Renderer 缺陷。

### 12.1 正文覆盖与组件多样性

Validator 必须枚举 top-level `title/deck`、非 audit section 的 `title/lead`，以及每个非
`audit-appendix` block 中的全部 Unit 引用：既包括所有 `EditorialCopy.materialUnitIds`，也包括
`valueUnitId`、truth-triad 的三类 ID 和其他直接 Unit 引用。Blueprint validator 只验证
`visual-gallery.assetIds`、caption/alt 关系存在；渲染后只能对真正进入 `exportedAssets` 且出现在
`assetIds` trace 的 Asset，把对应 `captionUnitId`、`altTextUnitId` 加入 `bodyUnitIds`。被 policy、media
type 或 byte budget 省略的 Asset 不得借此计入正文覆盖。该集合不能用 section 自报的 `questionIds`
代替实际引用。

正文覆盖硬规则：

- Blueprint 必须恰好有一个 `decision-cover`，位于第一个非 audit section 的第一个 block；其
  `summary` 至少引用一个 required claim、recommendation 或 risk Unit。
- 每个 `requiredInBody=true` Unit 都必须至少在 `bodyUnitIds` 出现一次。专用 `roadmap`、
  `risk-register`、`validation-gates` 中的引用与普通 EditorialCopy 引用同等计入；`groupId` 只用于
  组合同一对象字段，不能替代各 body-required Unit 的覆盖。
- Validator 另按 questionIds 复核：每个 required question 必须至少有一个由 coverage 选出的
  body-required conclusion/claim/risk anchor 出现在正文。该检查防止错误的 Material 标记绕过问题覆盖。
- 只要 Material 存在 `role=risk` Unit，Blueprint 就必须有一个非 audit 的 `role=risk` section，
  至少包含一个 `risk-register`，并覆盖全部 `requiredInBody` risk Unit；不能把风险散落在普通 narrative
  或只放入附件来满足覆盖。
- `audit-appendix` 必须位于最后一个 `role=audit` section，继续逐项 verbatim 输出全部 required
  Unit。正文摘要不能替代附件闭包，附件闭包也不能替代正文覆盖。

组件多样性只使用 `EditorialCompositionKind` 的固定八类；固定材料规模摘要、narrative、decision cover、
risk register 和 audit appendix 均不计入八选五。Blueprint validator 可以先根据 Material 计算候选
集合，但发布判定只使用 Renderer 的最终 trace：以最终 `exportedAssets` 重算
`eligibleCompositionKinds`，以实际非空 DOM block 重算 `renderedCompositionKinds`。
`visual-gallery` 只有至少一个声明资产最终成功内联时才 eligible/used；所有资产因 policy/media/budget
被省略时，该 block 不写 DOM、不进入 `renderedBlockKinds` 或 `renderedCompositionKinds`。若最终
`eligibleCompositionKinds` 仍至少五类，ready 和
degraded 都必须实际渲染至少五种不同 eligible kind；若视觉过滤使最终 eligible 降到五类以下，
不得为凑数 hard fail，也不得制造内容。不合格 LLM 候选进入一次修复，仍不合格则使用已预检 fallback；
fallback 在最终 eligible 仍至少五类却未渲染满五类时为实现错误，以 `SOURCE_NOT_RENDERABLE` hard fail。

## 13. 确定性降级策略

Deterministic Blueprint 使用固定顺序：

```text
决策封面
  -> 材料规模
  -> 事实 / 推断 / 未知
  -> 问题覆盖
  -> 结论与建议
  -> 风险与待验证项
  -> 视觉证据（存在且可导出时）
  -> 审计附件
```

它的业务文案只使用 `verbatim`，章节标题与来源声明使用上一节定义的固定 Renderer UI copy；
不调用 Fidelity LLM，不创建 persona、优先级、时间线或因果关系。它仍使用相同 Renderer，因此
具备专业排版、自包含和打印能力。生成器先满足第 12.1 节正文覆盖，再按固定 kind 优先级使用
eligible 组件；当至少五类 eligible 时必须选满五类，不能把降级误解成“只输出长段落”。

Pipeline 在任何 LLM 调用前必须生成一次以下内部值；它不落盘、不公开，也不包含时钟或随机数：

```ts
interface PreflightedFallbackBundle {
  blueprint: EditorialBlueprint;
  blueprintBytes: Uint8Array;
  blueprintHash: Sha256;
  htmlBytes: Uint8Array;
  htmlHash: Sha256;
  renderTrace: {
    bodyUnitIds: string[];
    appendixUnitIds: string[];
    assetIds: string[];
    renderedBlocks: Array<{ blockId: string; kind: EditorialBlockKind }>;
    renderedBlockKinds: EditorialBlockKind[];
    eligibleCompositionKinds: EditorialCompositionKind[];
    renderedCompositionKinds: EditorialCompositionKind[];
  };
  exportedAssets: Array<{ assetId: string; contentSha256: Sha256 }>;
  checks: EditorialDiagnosticCheck[];
}
```

Fallback preflight 是一次真正的发布演练，不是“调用失败后再试试模板”：

1. 用 fallback mode 的 Blueprint Schema 和第 9.3、12、12.1 节全部 deterministic gate 校验。
2. 对最终 canonical Material／Blueprint bytes 执行精确 8 MiB 上限检查。
3. 调用正式 Renderer 生成最终 UTF-8 HTML bytes；比较 render trace，正文必须覆盖全部
   `requiredInBody` Unit，附件必须按 canonical 顺序恰好覆盖全部 `requiredInOutput` Unit，asset trace
   必须与 `exportedAssets` 一致。`renderedBlocks` 按 Blueprint traversal order 记录真正写出非空 wrapper
   的 block ID/kind，并与根据最终资产可机械推导的 expected non-empty blocks 严格相等；空画廊是唯一
   允许从 expected 集合移除的声明 block。`renderedBlockKinds` 按完整 block kind 枚举顺序去重且
   不得为空；`eligibleCompositionKinds` 与 `renderedCompositionKinds` 按八类 composition 枚举顺序
   去重，允许为空。`renderedCompositionKinds` 在任何输入规模下都必须是
   `eligibleCompositionKinds` 的子集；只有 eligible 数量至少 5 时，才额外要求 rendered 的不同 kind
   至少 5，再执行第 12.1 节最终五类门禁。
4. 对实际 HTML bytes 扫描 CSP、自包含、禁止元素／属性、转义残留和 `8 * 1024 * 1024` byte 上限；
   不能用字符数、预估 Base64 大小或未转义文本长度代替。
5. 以第 9.4、9.6 节的字段上限证明最坏 Diagnostic／manifest 仍分别低于 2 MiB／256 KiB；发布时
   仍对实际 bytes 复核 8 MiB 总合同。任何元数据字段在进入 bundle 前已被长度校验，不允许在 LLM
   失败后才发现无界 trace、model name 或 issue message。
6. 全部通过后冻结该 bundle。后续降级直接使用这些 exact bytes 与 hash，不重新 materialize、
   重新选择 asset 或重新渲染；这样 LLM 失败不会引入第二条可失败的内容路径。

在不存在独立的磁盘／权限／sidecar 损坏等 hard failure 的前提下，进入第一次 LLM 调用即意味着
一个可原子发布的 degraded 内容结果已经存在。该不变量是“纯 LLM 失败必有 degraded”的精确定义。

允许降级并发布的情况：

- LLM provider 未配置或不可用。
- Editorial model egress policy 拒绝本次数据出境。
- Blueprint 调用超时、限流或返回无效 Schema。
- Blueprint 引用、证据等级、数字或覆盖校验失败。
- LLM 候选自身的 render coverage 或 8 MiB 体积门禁失败。
- Fidelity Review 不通过或不可用。
- Material 超过 LLM 输入预算。

必须硬失败且不发布的情况：

- task 未完成或当前 binding 不完整。
- start、任一次 pre-model、ready cache-return 或 publish fence 发现 current binding 已变化。
- Report Package 缺失、未 SEALED、hash 不一致或组件绑定错误。
- Review 不为 pass，或输入为 `legacy_text`。
- deliverable type 不在 V1 显式 projector 清单、inactive，或 payload 未通过 registry schema。
- Materializer 自身出现悬空引用、循环引用或确定性不一致。
- Fallback preflight 的 Blueprint、关系、覆盖、组件组合、HTML 或任一精确大小门禁失败（统一
  `SOURCE_NOT_RENDERABLE`，且不得调用 LLM）。
- 任意 Renderer 输出 unsafe HTML，或发生未分类 Renderer 异常。
- sidecar 原子发布失败且无法证明已有 generation 完整一致。

源 Report Package 成功冻结后的硬失败写脱敏 failure diagnostic；任务不存在、binding 不完整或源完整性失败时不落 sidecar，只返回脱敏错误码。CLI 返回非零。任何失败都不改变原报告的可用性。

## 14. HTML Renderer 与展示系统

### 14.1 固定职责

Renderer 负责：

- 把白名单 block 映射为固定语义 HTML。
- 从 Material 注入事实状态、证据编号和来源链接。
- 对所有标题、正文、caption、alt 和 URL 做上下文相关转义。
- 内联固定设计 token、响应式 CSS 和打印 CSS。
- 将允许导出的 verified 图片编码为 `data:` URI。
- 生成目录、章节编号、页脚与来源附件。

Renderer 的公开返回值是最终 UTF-8 bytes 与受控 trace，不返回仍可能被调用方再次编码的半成品
string。`bodyUnitIds`、`appendixUnitIds`、`assetIds` 与 `renderedBlocks` 都在实际写入对应 HTML 节点
的同一分支追加；block 只有在完整、非空 wrapper bytes 已加入输出后才记录 `{blockId, kind}`。
Pipeline 按第 13 节复核，再从这些 block 生成按固定枚举顺序去重的 `renderedBlockKinds`，并只从
八类 composition block 生成允许为空的 `renderedCompositionKinds`；trace 不写入 HTML，也不进入
manifest。

Renderer 先生成不含图片 bytes 的正文 shell，再按 Material canonical 顺序尝试加入 eligible asset；
每一步用实际 Base64 与标签 UTF-8 byte size 计算单图、总图和最终 8 MiB 预算，超限即省略该资产并
记录 warning。Renderer 一并返回最终 `htmlBytes`、render trace 与 canonical `exportedAssets`；HTML
通过检查后 Pipeline 才计算 generation ID。HTML 不嵌入 generation ID，避免内容 hash／generation ID
形成循环。画廊 wrapper 只有在至少一个声明 Asset 真正进入 `exportedAssets` 后才整体提交到 shell；
comparison pair 必须两张都可导出，否则整对省略。零图片的 `visual-gallery` 不产生空标题、空容器或
trace 项。

Renderer 不解释业务、不调用 LLM、不决定事实等级。
给定 Material、Blueprint 与 `rendererVersion`，资产预算选择、trace、`exportedAssets` 和 HTML 都必须
byte-for-byte 确定；
Renderer 不读取时钟、随机数、环境主题或 generation ID。`generatedAt` 只存在于 manifest。

### 14.2 视觉原则

- 决策优先：首屏给出用途、边界、核心判断与关键计数。
- 阅读节奏：长段落必须被卡片、路径、表格或留白分隔。
- 状态一致：fact、inference、unknown 具有固定颜色、文字标签和非颜色标识。
- 数据诚实：无可靠数值时不画比例图、趋势图或伪精确置信度。
- 正文简洁：完整追溯放入可折叠审计附件。
- 响应式：桌面双栏／网格，窄屏单栏；390px 下无水平溢出。
- 可访问：语义标题层级、可读对比度、表格 header/scope、图片 alt、键盘可达。
- 桌面使用纯 CSS sticky 目录，移动端使用普通锚点导航；首屏和正文开头持续展示
  fact/inference/unknown 的文字图例，不能只靠颜色。
- 设计 token 固定在 Renderer 版本中，至少覆盖 paper/surface/ink/muted/accent、三种证据状态、
  spacing、radius、shadow、正文宽度和打印覆盖；不从 Blueprint 接收视觉 token。
- confidence 只能显示为源文本或审计字段，禁止把无校准的置信度渲染成概率条、仪表盘或百分比。

V1 `editorial-html-v1` 的视觉基线固定，不留给 LLM 或实现者临场选主题：

| token / layout | 固定值 |
|---|---|
| paper / surface / ink / muted | `#f3f0e9` / `#fffdf9` / `#191817` / `#716b66` |
| accent / hero / line | `#e1251b` / `#273038` / `#ded8ce` |
| fact | foreground `#247357`，background `#e4f2ec`，文字标签“已有来源支持” |
| inference | foreground `#a96506`，background `#fff1d6`，文字标签“分析推断” |
| unknown | foreground `#a91610`，background `#fde9e6`，文字标签“未知／待验证” |
| audit | foreground `#315f82`，background `#e7f0f6`，文字标签“来源审计” |
| typography | system sans stack；正文 `16px/1.68`；正文段落最大 `72ch`；H1 `clamp(40px,5.7vw,78px)`、H2 `30px`、H3 `18px` |
| spacing / shape | spacing scale `4,8,12,18,24,34,48,62px`；radius `18px`；shadow `0 18px 54px rgba(48,38,30,.08)` |
| desktop shell | 最大宽 `1500px`，`226px` sticky rail + 流式正文，gap `34px` |
| breakpoints | `<=1080px` 收窄网格，`<=680px` 单栏并取消 sticky；验收仍以 390px viewport 为底线 |

这些值借鉴参考 Demo 的阅读气质，但移除了其 JavaScript 交互并把状态语义收紧为本文契约。任何视觉
调整必须提升 `rendererVersion` 并重跑截图、打印、对比度和黑白状态辨识门禁。

组件资格由 Validator 根据 Material 确定，LLM 只能在 eligible 集合中选择：

| 组件 | 最小资格 |
|---|---|
| `metric-cards` | 至少一个 `metricEligible=true` 的 numeric Unit；value 来自源叶子，unit 来自显式 projector 固定语义 |
| `truth-triad` | 至少两种 epistemic status，且每列只接收对应状态 Unit |
| `card-grid` | 至少两个有稳定 groupId 的同类 Unit group |
| `flow` | 源 schema 或 basis edge 明确给出顺序；不得从散文猜步骤 |
| `strategy-matrix` | 仅 `competitive_analysis_report`：完整 dimension×sample 矩形，且每个 cell 的 basis 同时绑定 row dimension 与 column sample name |
| `roadmap` | 源中存在显式 priority/roadmap 字段，不从建议顺序推导 |
| `validation-gates` | 同一显式 projector group 同时提供 label 与 method，success criterion 有源时才显示 |
| `risk-register` | 存在 risk Unit |
| `visual-gallery` | 最终至少有一个 `allow` 的 verified PNG/JPEG/WebP 通过单图、总图与 HTML byte budget |
| `audit-appendix` | 始终 eligible 且必须恰好一个 |

“八类表达中至少五类”按第 12.1 节成为 Blueprint 的确定性发布门禁，而不只是人工验收目标；
eligibility 不足的普通报告只使用真实 eligible 组件，不为凑数量制造结构或内容。

参考 Demo 的进度条、滚动 active nav、reveal animation 和 JavaScript 打印按钮不进入 V1。V1 保留
其信息层级、卡片／矩阵／路径节奏和专业排版，但坚持零 JavaScript；打印由浏览器原生命令完成。

### 14.3 自包含与安全

- `<!doctype html>`、`lang="zh-CN"`、UTF-8 和 viewport 必须存在。
- 固定 CSP：`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`。
- 不包含 `<script>`、`on*` 事件属性、iframe、form、object、embed、远程字体或远程图片。
- Citation 只允许经过解析和重新序列化的 `https:` 链接，带 `rel="noopener noreferrer"`；链接不是页面加载依赖。
- CSS 由 `rendererVersion` 固定，LLM 不能传入 class、颜色、尺寸或 style。
- V1 不内联任何 SVG，即使它已通过 `VerifiedVisualAssetReader.readVerified()`；也不做 sanitizer、
  rasterization 或 `<img src="data:image/svg+xml">`。`exportPolicy=mask|block` 同样永不读取进 HTML。
- 唯一允许的图片 data URI media type 是 `image/png`、`image/jpeg`、`image/webp`；静态扫描拒绝
  `data:image/svg+xml`、其他 `data:` MIME、SVG 元素、XML processing instruction 与外部引用。
- 单图原始字节上限 1.5 MiB，最多 6 张，总内联原始字节上限 5 MiB；超限资产省略并记录 warning。
- 任一可发布 HTML 上限为 8 MiB，不截断正文或审计内容；fallback 超限导致
  `SOURCE_NOT_RENDERABLE` hard fail，LLM 候选超限则拒绝候选并使用已预检 fallback。
- 屏幕阅读时审计 `<details>` 默认折叠，避免完整追溯材料压过正文；用户可通过原生键盘交互展开，
  不引入 JavaScript。

### 14.4 打印要求

- 提供 A4 portrait 的 `@page` 与 `@media print`。
- 隐藏导航和交互提示，但不得隐藏正文、证据标签或风险。
- 打印时展开所有审计 `<details>` 内容。
- 标题、卡片、表格行和图片 caption 避免不合理跨页。
- 黑白打印时仍能通过边框、图标和文字识别 fact/inference/unknown。
- 浏览器打印到 PDF 后不得裁切正文、出现横向滚动或丢失来源链接文本。

## 15. Sidecar 目录与生命周期

### 15.1 根目录

```text
${RUN_WORKSPACE_ROOT:-./run-workspaces}/editorial-reports/
  tasks/{taskId}/
    failures/{failureId}/
      editorial-diagnostic.json
    attempts/{attemptId}/
      .staging/{requestKey}-{randomSuffix}/
      locks/{requestKey}.lock
      locks/{requestKey}.reap
      locks/.reaped/{requestKey}-{randomSuffix}.lock
      requests/{requestKey}/
        ready/
          editorial-material.json
          editorial-blueprint.json
          editorial-diagnostic.json
          editorial-report.html
          manifest.json
        fallback/
          editorial-material.json
          editorial-blueprint.json
          editorial-diagnostic.json
          editorial-report.html
          manifest.json
```

该目录与 main 使用的 `run-workspaces/current-control/` 是 sibling，不共享写路径。`run-workspaces/*` 已由 `.gitignore:26` 排除。

### 15.2 Request Key、Generation ID 与幂等

`requestKey` 在调用 LLM 前生成，用于同一请求的复用与进程间 single-flight。它是 `erq_`
加以下 canonical JSON 的 64 位小写十六进制 SHA-256 摘要：

```ts
{
  sourceReportPackageId,
  sourceReportPackageHash,
  materialHash,
  modelContextHash,
  materialVersion,
  modelContextVersion,
  blueprintPlanVersion,
  blueprintVersion,
  blueprintPromptVersion,
  fidelityPromptVersion,
  fallbackVersion,
  rendererVersion,
  storeVersion,
  modelEgress: {
    policyVersion,
    policyHash,
    decision,
    reasonCode,
    evaluated: {
      sourcePolicySetHash,
      contributingSourceCount,
      sensitivities,
      redactionPolicyVersions,
      provider,
      mode,
      endpointHost,
      endpointUrl,
      redirectMode
    }
  },
  gatewayConfiguration: {
    provider,
    endpointHost,
    endpointUrl,
    mode,
    eligibleAsReal,
    redirectMode,
    routes: [{ requestedModel, expectedActualModel, expectedActualModelExplicit: true }],
    limits,
    gatewayConfigurationHash
  } | null
}
```

`gatewayConfiguration=null` 表示没有可用 provider。egress policy version/hash、输入和裁决、
`modelContextHash` 全部参与 key；`gatewayConfigurationHash` 来自 canonical endpoint URL、redirect、
limits 与完整有序、无凭证的模型路由配置（含 requested 与
expected actual model），因此策略、出境目标或模型路由变化不会错误复用旧 ready 结果。

同一个 `requestKey` 有相互独立的 `ready` 与 `fallback` result slot。新调用只把 ready
目录视为完成缓存；已有 fallback 目录不会阻止它重新尝试 LLM。锁所有者可以在 LLM 前完整验证
已有 fallback slot，并把其中的 exact Blueprint/HTML bytes 作为 preflight bundle；这只是证明保底
可用，不会提前返回 degraded。只有本次 LLM 尝试失败后，
锁所有者才允许复用同 key 的 deterministic fallback。未获锁调用立即 busy，不读取 ready/fallback，
也不推断 owner 的最终结果；owner 结束后的新调用重新从 ready fast-path 开始。

`generationId` 在 Blueprint 获胜后生成，是 `er_` 加以下 canonical JSON 的 64 位小写
十六进制 SHA-256 摘要：

```ts
{
  requestKey,
  mode: 'llm' | 'deterministic_fallback',
  materialHash,
  publishedBlueprintHash,
  rendererVersion,
  exportedAssetHashes
}
```

`exportedAssetHashes` 就是 manifest `exportedAssets`：它只包含 Renderer 实际内联的唯一
`{assetId, contentSha256}`，严格按 Material `assets` 的 canonical 顺序生成；不得依赖 Map、文件系统
遍历或异步完成顺序。Pipeline 用该列表重算 generation ID，Store 复用时再从 manifest 与 HTML
实际 data URI 逐项核对。

规则：

- 相同 `requestKey` 在 ready、fallback 两个 namespace 中各自最多一个获胜结果；ready 一旦存在
  即为该请求的长期结果，fallback 只在本次 ready 尝试失败后使用。每个 slot 都是一个完整、
  不可变的 generation；读取时须验证 manifest 和全部文件 hash。内容寻址只能证明 slot 完整，不能
  证明它仍绑定 task current；返回前仍必须执行 cache-return fence。
- CLI 先读取并验证 ready slot；不存在时以原子 `open(..., 'wx')` 获取该 ready request 的锁，
  获锁后再次检查 ready slot，防止 check-then-act 竞态。
- 第二次 ready 检查仍为空时，锁所有者必须先完成 fallback preflight 或加载并复核 valid fallback
  slot，之后才可调用 LLM；preflight 失败释放锁并 hard fail，调用计数必须为 0。
- `open(..., 'wx')` 因既有锁失败时，只允许执行一次第 15.4 节 stale-lock 证明与隔离；不能证明 stale、
  不能取得独占 reap guard，或隔离后一次重试仍失败，就立即返回 `EDITORIAL_REQUEST_BUSY`。该路径不
  sleep、不轮询、不等待 owner、不再次读取 slot、model call 为 0，也不发布第二个候选。
- 锁所有者若 LLM 路径失败，只能发布／复用 preflight 已证明可用的同 key fallback slot 并返回 degraded。
  只有该 owner 可以把本轮失败分类为 degradable。之后启动的新调用仍先查 ready；没有 ready 才重新
  竞争锁，并在获锁后把 valid fallback 仅作为 preflight bundle，继续尝试生成 ready。
- 复用既有 fallback 时不得改写其 manifest/Diagnostic；本次失败调用只进入一条 canonical JSON
  进程日志事件 `fallback_reused_after_llm_failure`，包含既有 generation ID、本轮脱敏 model-call records
  与 issue codes，不包含 Prompt、Material/HTML 正文或上游错误文本；CLI stdout 明确返回既有
  generation ID。正式 CLI composition 必须装配该日志 sink，写入失败则本次调用失败，不能静默丢失审计。
- 锁文件以 `0600` 创建，记录 PID、hostname、request key、创建时间，以及 CSPRNG 生成的 32-byte
  owner token（64 位小写 hex）。读取锁时使用 no-follow、4 KiB 上限和 schema 校验；malformed、
  symlink、request key 不符或未知 hostname 一律不能当作 stale。owner token 只用于本地 compare-and-
  delete：不得进入 stdout/stderr、Diagnostic、manifest、结构化日志或遥测字段，测试必须对这些出口做
  泄漏断言。
- stale 回收必须由固定 `locks/{requestKey}.reap` 串行化，不能靠“复读后直接 rename”假装原子 CAS：
  reclaimer 先用 `open(..., 'wx', 0o600)` 获取 reap guard，并在 guard 内重新 no-follow 读取主锁；只有
  同 hostname、PID 已不存在、锁龄严格超过 15 分钟，且紧邻 rename 前的 inode/content/owner token
  仍与 guard 内首次观察完全相同，才把该主锁原子 rename 到本次唯一的 `.reaped/` 路径。所有
  reclaimer 都必须持有同一 guard，禁止绕过。
- 隔离完成后 reclaimer 只重试一次主锁 `wx`。若一个普通新 owner 在 rename 后抢先成功，reclaimer
  立即返回 `EDITORIAL_REQUEST_BUSY`，不得再次读取或 rename 新锁；双 reclaimer 中只有 guard 获胜者
  有资格执行一次隔离。reap guard 的释放也必须以自身 inode/token 复核，不能删除后来者 guard。
  V1 不自动回收崩溃遗留的 reap guard，遇到它一律 fail closed 为 busy，并要求操作者在 no-follow
  验证同 hostname/PID 已死亡后按精确路径处理；不再递归发明第二层 stale-lock 协议。
- `generationId` 包含获胜 Blueprint hash，因此不同合法 LLM 输出不会映射到同一目录。
- 若目标 slot 已存在，必须验证其 request key、status/mode、generation ID、manifest 和全部文件
  hash，并执行 cache-return fence。验证通过才采用该 slot 并丢弃本次 staging；验证失败
  视为 sidecar corruption 并 hard fail。
- V1 不提供覆盖、删除或“重新随机生成”参数。源报告或 Pipeline 版本变化自然产生新 generation。
- `generatedAt` 不参与 generation ID，第一次成功发布的时间被保留。

### 15.3 原子发布

1. 获得 request lock，并在同一父目录的 `.staging` 建立随机临时目录。
2. 以 `mode 0600` 写入内容文件，逐一重新读取并校验 hash 与 byte size。
3. 最后写入并校验 `manifest.json`。
4. 立即调用 `assertStillCurrent()`；通过后不再执行模型、渲染或其他可延迟操作，使用同文件系统原子 rename 将完整目录直接移动到
   `requests/{requestKey}/{ready|fallback}`；这一次 rename 同时提交 generation 与其可发现性，
   不存在“generation 已发布但 pointer 未写”的第二个 crash window。
5. 目标 slot 已存在时验证并返回先到的完整赢家，不比较本进程 staging 的 Diagnostic、trace 或
   `generatedAt` 是否逐字节相同。
6. 成功后将目录和文件权限保持为 owner-only；CLI 只打印绝对路径，不复制内容。
7. `finally` 以 no-follow 重新读取 lock，只有 schema、request key、owner token 和预期 inode 全部
   匹配才 unlink；旧 owner 的 finally 永不删除新 owner lock。捕获失败时只删除本进程创建且仍位于
   `.staging` 的目录；进程崩溃遗留的 staging 不被读取为结果。

路径组件只接受数据库返回的 UUID 和由程序生成的 hex ID。Store 不接受调用方提供的相对路径，拒绝绝对路径、`..`、符号链接和硬链接逃逸。

### 15.4 生命周期

- Canonical Artifact 生命周期完全不变。
- Published slot 永不原地修改；输入或版本变化产生新 request key 和新目录。
- `manifest.json` 缺失、hash 不符、源 Report Package 失效或 cache-return fence 不通过时，该 slot 不可消费。
- failure diagnostic 仅用于本地排障，不是成功报告。
- 获锁后清理同 request、超过 24 小时且不属于活跃 owner 的 staging；其他进程的 staging 不碰。
- 15 分钟 stale-lock 和 24 小时 staging TTL 是 V1 Store 常量，纳入 Store version，不新增环境变量；
  测试使用 fake clock 覆盖边界。`.reaped/` 中属于本 request、超过 24 小时的已隔离锁可按 no-follow
  固定路径清理；reap guard 不适用该自动清理。V1 没有 wait timeout、poll interval 或 owner outcome
  状态机。
- V1 不自动删除已发布 slot；每个 request 最多一个 ready 和一个 fallback，单个 HTML 受 8 MiB 上限约束。

## 16. CLI 接口

新增命令：

```bash
pnpm editorial:report -- --task-id "$EDITORIAL_TASK_ID"
```

参数合同：

- `--task-id` 必填，只接受 UUID。
- 不接受 `attemptId`、Report Package ID、本地输入路径、Prompt、HTML、模板或样式参数。
- CLI 总是解析该 task 当前已完成 Attempt 的权威 Report Package。
- `LLM_PROVIDER=gateway` 时使用现有 `LLM_GATEWAY_*` 与 `LLM_MODEL_*` 配置。
- composition root 只把第 11.3 节 `GatewayConfigurationError.code` 明确列出的 provider 未配置／Gateway
  配置缺失或不合格归一为 `client=null/configuration=null` 并走零调用 fallback；不得用 message 正则或
  宽泛 catch 分类，程序错误、类型错误和未知异常不得吞掉后伪装成降级。`ALLOW_REAL_PROVIDER` 只属于
  现有 real-smoke 工作流，不是 main 通用 Gateway 或本 CLI 的授权开关，Editorial 不新增也不读取它
  作为 egress override。
- 只有请求前 identity 合格，且每个响应都通过第 11.3 节的 sidecar model receipt gate，才能发布 ready；mock、未配置、不可用、unknown 或漂移 provider 一律走确定性降级，不请求新凭证。
- CLI 不调用 `buildControlRuntime()`，避免装配 `LeaseExecutionEngine` 和主流程写能力。
- CLI 不使用 `ReceiptLLMClient`，避免向源 Attempt 追加 model call；LLM provenance 只写入 sidecar manifest。

成功 stdout 是第 7.1 节返回结构的单行 JSON；`requestKey` 固定为 `erq_`、`generationId`
固定为 `er_` 加 64 位小写十六进制摘要，两个 path 均为本次已校验 generation 内的绝对路径。
CLI 在成功、降级和异常路径都必须于 `finally` 释放 request lock 并关闭数据库连接池。

`degraded` 仍返回退出码 0，并在 stdout 明确标记；没有发布任何报告时返回退出码 1，stderr 只输出脱敏错误码，并在成功写出 failure diagnostic 时附带其路径。自动化调用方若不接受降级，必须检查 `status`，不能只检查退出码。

## 17. 失败矩阵

| 场景 | 结果 | 原报告 | 派生输出 |
|---|---|---|---|
| task 不存在或 binding 不完整 | hard fail | 不变 | 无 sidecar，仅脱敏 stderr |
| task 未完成 | hard fail | 不变、继续可读 | 无 sidecar，仅脱敏 stderr |
| Report Package/组件/hash 无效或源预算超限 | hard fail | 不变；提示先修复主链 | 无 sidecar，仅脱敏 stderr |
| start 或第一次 outbound 前的 pre-model fence 发现 task/current Attempt/package ID/hash 已切换 | `SOURCE_BINDING_CHANGED` hard fail；LLM 调用数为 0 | 不变 | 无 manifest，不返回旧 cache |
| 较早 model call 后、下一次 pre-model fence 发现 binding 已切换 | `SOURCE_BINDING_CHANGED` hard fail；不发下一次调用，丢弃既有响应 | 不变 | 无 manifest，不发布 fallback |
| ready cache-return fence 发现 binding 已切换 | `SOURCE_BINDING_CHANGED` hard fail；不返回旧 cache、不创建新输出 | 不变 | 既有 slot 不改写 |
| Review 非 pass 或 legacy | hard fail | 不变 | 无 sidecar，仅脱敏 stderr |
| deliverable type 无 projector 或 payload schema 不合格 | hard fail | 不变 | 无 sidecar，仅脱敏 stderr |
| Material 单叶子／Unit／文本超过发布 hard limit | hard fail | 不变 | 仅 failure diagnostic，不发布 manifest |
| Fallback Material／Blueprint、关系、覆盖、组合或实际渲染超过对应 byte 门禁 | `SOURCE_NOT_RENDERABLE` hard fail；LLM 调用数为 0 | 不变 | 仅 failure diagnostic，不发布 manifest |
| Fallback 或 LLM 候选出现 unsafe HTML／未分类 Renderer 异常 | hard fail | 不变 | 不发布；不得用 fallback 掩盖 Renderer 信任边界故障 |
| LLM 超时、限流、配置缺失 | deterministic fallback | 不变 | 发布 `degraded` |
| 非 typed Gateway 配置异常或 client/configuration snapshot 不一致 | hard fail；不发该次及后续调用 | 不变 | 不发布；不得用 fallback 掩盖错误装配 |
| egress policy 因 sensitivity/redaction/provider/mode/endpoint 拒绝 | fallback preflight 后零次 LLM 降级 | 不变 | 发布 `degraded`，记录 policy version/hash/reason |
| 错误注入 Receipt client／响应出现 receiptId | hard fail + 集成门禁失败 | 零写合同已被破坏，需修复装配 | 不发布 |
| Blueprint Schema/引用失败两次 | deterministic fallback | 不变 | 发布 `degraded` |
| Fidelity Review block 或不可用 | deterministic fallback | 不变 | 发布 `degraded` |
| 已通过 Fidelity 的候选仅 final coverage/composition 失败或超过 8 MiB | deterministic fallback | 不变 | 丢弃候选，发布预检缓存的 `degraded` |
| Renderer 漏掉非空 block、伪造 block trace 或输出 unsafe HTML | hard fail | 不变 | 不发布；不得用 fallback 掩盖 Renderer 信任边界故障 |
| publish fence 发现 current binding 已切换 | `SOURCE_BINDING_CHANGED` hard fail；丢弃已完成候选/staging | 不变 | 不发布旧 ready/fallback |
| 合法视觉资产为 `mask`、`block` 或 verified SVG | 按各自受控 warning 省略 | 不变 | 可发布；不得转码或清洗后内联 |
| 未知 media type、非法 export policy、视觉资产损坏／签名不符或绑定不符 | hard fail | 不变 | 不发布 |
| 单图或总图像超预算 | 省略超限资产并警告 | 不变 | 可发布 |
| 并发生成同一 request | 一个 owner 继续；其他调用在一次 stale check 后立即 `EDITORIAL_REQUEST_BUSY`，零等待、零 LLM | 不变 | owner 可发布 ready/fallback；loser 不读取任何 slot |
| sidecar 写入或 rename 失败 | hard fail | 不变 | 无 final slot；可能遗留不可消费 staging |

## 18. 安全、隐私与可信边界

- SourceReader 必须通过现有 Artifact 校验读取，禁止直接 `readFile` main 的 Artifact path。
- Material 复用现有脱敏结果，并再次排除 blocked/sensitive 输出。
- `EditorialModelEgressPolicy` 在生产代码中固定且默认拒绝；只允许 `public|internal`、`v1`、real
  Gateway 与精确 canonical endpoint 的固定组合。policy deny 不能被环境变量、CLI 或测试 adapter
  在生产装配中覆盖。
- LLM context 只包含第 9.2.1 节的最小 `EditorialModelContext`、第二次 Planner 的 bounded repair hints，
  以及 Fidelity 必需的候选 copy 列表，
  不含完整 Material、图片字节、数据库行、作为结构元数据的 UUID、Artifact/Manifest 元数据、
  Evidence 对象／ID／URL、JWT、环境变量、完整 Prompt 或原始错误；verified Unit `value` 自身的业务
  字面量不在此排除声明内，仍由 egress 与 verbatim 门禁保护。
- Material 中的网页文字视为不可信数据；Editorial 专属 System prompt 明确禁止 Planner 与 Fidelity
  遵循 Material、候选文案、元数据或 repair hints 中的指令，其完整文本纳入 prompt hash。
- Gateway 返回只按 JSON 数据解析，不执行任何字符串。
- Sidecar 的 Gateway 请求固定 `redirect: 'error'`；endpoint URL、host 和 route identity 纳入
  Gateway configuration hash，固定 allow target 则纳入 egress policy hash，
  防止同 host 异 path 或 307/308 把包含 Material 的 POST 转发到未授权目标。
- Diagnostic 与日志只保存结构化 code、路径和计数，不复制敏感正文。
- HTML 中所有动态内容必须转义；URL 使用 `new URL()` 解析并限制 `https:`。
- HTML 只允许 `data:image/png|jpeg|webp`；mask、SVG、XML 与其他 data URI 不进入输出，即使 main
  已经验证该 Artifact 的完整性。
- sidecar 文件默认 `0600`，目录默认 `0700`。
- 派生报告的 sensitivity 继承源 Report Package；V1 不将文件上传、公开托管或自动发送给第三方。

## 19. 资源上限与 10 倍规模攻击

资源保护必须从 SourceReader 开始，不能等 Material 生成后才限流。V1 不引入分块编排或多 Agent 合并：

- 在读取 bytes 前检查 Artifact metadata：Report Package 不超过 256 KiB；任一 JSON 组件不超过
  8 MiB；本次将读取的 JSON Artifact 声明总量不超过 64 MiB。
- Evidence Manifest 最多 1,000 条 entry、最多引用 400 个唯一 Evidence Artifact；读取这些
  Artifact 前先汇总 `byteSize`，超过 64 MiB 即以 `SOURCE_BUDGET_EXCEEDED` hard fail。
- Evidence 中的 screenshot、ReportDocument 视觉引用及 V2 provenance 涉及的全部 Artifact 都要
  汇入同一去重集合；最多 24 个唯一 `assetId + manifestArtifactId` pair。读取二进制／provenance
  JSON 前先汇总 metadata，单个二进制沿用现有 10 MiB verified-read 上限，全部唯一视觉
  Artifact 的声明总量不得超过 60 MiB，并按 pair memoize 验证结果。
- metadata 缺失、为负数、超过上限或读取后实际尺寸不一致均 fail closed；预算判断不得直接信任文件路径。
- Materialization 后的绝对发布上限为 1,000 个 Unit、500,000 个规范化文本 code point，且单叶子
  服从第 9.1 节 16,000 code point/64 KiB 上限；超过任一项以 `MATERIAL_HARD_LIMIT_EXCEEDED`
  hard fail，不尝试生成无法完整覆盖的 fallback。
- Material 在 400 Unit、120,000 字符以内，且第 11.3 节实际 Model Context byte gate 通过时才进入 LLM。
- 任一 LLM 输入预算超限都在 fallback preflight 通过后直接使用确定性 Blueprint，并在 Diagnostic 中记录
  `MATERIAL_BUDGET_EXCEEDED`。
- Renderer 必须流式或分段拼接字符串，不对图片做重复 Base64 副本。
- fallback HTML 超过 8 MiB 时以 `SOURCE_NOT_RENDERABLE` hard fail 且不调用 LLM；已通过 Fidelity 的
  LLM 候选仅因 coverage 或 8 MiB 超限时拒绝候选并发布已预检 fallback。任意 unsafe HTML 始终 hard fail。
- Material、Blueprint、Diagnostic 和 manifest 每个 canonical JSON 文件也不得超过 8 MiB；Store
  在写 staging 前后各校验一次。fallback preflight 对 Material／Blueprint 使用 exact bytes，并按
  Diagnostic／manifest 的有界字段证明 2 MiB／256 KiB 上界；最终发布仍检查实际 bytes。
- 外部 LLM 故障不会阻断 main，也不会导致无界重试。

Source 预算在完整快照冻结前执行，因此超限只返回脱敏错误码、不创建 sidecar Diagnostic。
这保持了 V1 的 KISS 边界。若真实任务持续超过预算，应先改进上游数据体积和 ReportDocument
的信息压缩，而不是在派生层增加第二套综合流程。

## 20. 可观测性

不向 main 数据库追加 model call 或任务事件。所有派生观测信息写入 manifest、Diagnostic 和结构化进程日志：

- `taskId`、`planVersionId`、`attemptId`、`requestKey`、`generationId`
- source Report Package ID/hash
- Pipeline、prompt、schema、renderer 版本
- model egress policy version/hash、decision/reason 与 canonical endpoint（不含凭证）
- 每阶段开始/结束时间与 duration
- Material unit/asset/evidence 数量
- Model Context hash/byte size、final eligible/rendered composition kinds 与 exported asset 数量
- LLM model、promptHash、traceId、token usage
- Blueprint 逻辑尝试次数
- pass/degraded/fail 与脱敏 issue code
- 输出文件 hash 与 byte size

禁止记录 Material 全文、HTML 全文、Gateway 原始响应、API key、request/reap owner token 或完整上游错误。
复用不可变 fallback 后，本轮 LLM 失败无法回写旧 Diagnostic，因此正式 CLI 额外向 stderr 输出
`editorial-process-audit-v1 / fallback_reused_after_llm_failure` 单行 canonical JSON；该事件只保留调用前
已知身份、hash、计数、成功调用的受限 receipt 元数据与固定错误码。

## 21. 精确文件影响范围

预计影响 **26 个文件**，明确超过 8 个；通过两个独立可合并阶段控制审查面。没有数据库迁移、部署服务、第三方依赖、Skill 或新凭证。

### 21.1 新增生产文件

| 文件 | 职责 |
|---|---|
| `apps/orchestrator-runtime/src/report/editorial-report-contract.ts` | 主／内部契约、固定 egress policy、解析、canonical hash 与跨引用校验 |
| `apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts` | 预算预检、Report Package 与组件的只读冻结校验 |
| `apps/orchestrator-runtime/src/report/editorial-report-materializer.ts` | verified package 到确定性 Material |
| `apps/orchestrator-runtime/src/report/editorial-report-pipeline.ts` | 唯一深 Module，编排读取、LLM、校验、降级、渲染和发布 |
| `apps/orchestrator-runtime/src/report/editorial-report-renderer.ts` | 白名单组件到固定 HTML/CSS 的纯 Renderer |
| `apps/orchestrator-runtime/src/report/editorial-report-store.ts` | 隔离根、路径校验、hash、幂等和原子目录发布 |
| `apps/orchestrator-runtime/src/editorial-report.ts` | CLI 参数解析与最小依赖装配 |
| `schemas/editorial-report-blueprint.schema.json` | Blueprint Plan LLM 输出 Schema |
| `schemas/editorial-report-fidelity.schema.json` | Fidelity Review Plan LLM 输出 Schema；hash/verdict 由 Pipeline 注入 |
| `scripts/editorial-report-phase2-calibration.ts` | 唯一 Phase 2 校准入口；运行 golden、真实 SEALED corpus、参考样本与准入汇总 |

### 21.2 修改生产文件

| 文件 | 改动 |
|---|---|
| `apps/orchestrator-runtime/src/runtime/schema-registry.ts` | 注册两个新 schema name，供 Gateway 提示使用 |
| `apps/orchestrator-runtime/src/runtime/llm-client.ts` | 为结构化调用增加可选资源 limits 与 redirectMode；既有调用默认行为不变 |
| `apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts` | typed 配置错误、由 identity/hash/fetch 共用的单一 canonical request URL、无凭证 deep-frozen route identity 与显式 actual-model pin；opt-in 执行 redirect=error、总 deadline、HTTP 尝试数、Retry-After、输出 token 和响应 byte 上限 |
| `apps/orchestrator-runtime/src/report/visual-asset-service.ts` | 抽出只读 `VerifiedVisualAssetReader`，原读取入口委托且行为不变 |
| `package.json` | 增加 `editorial:report`、`editorial:calibrate` scripts；不增加 dependency |

### 21.3 新增／修改测试文件

| 文件 | 覆盖 |
|---|---|
| `tests/editorial-report-contract.test.ts` | Plan/final Schema、Unit ID、敏感 token、ratio、引用、等级、覆盖与拒绝未知字段 |
| `tests/editorial-report-source-reader.test.ts` | 只读端口、start/current fence、source policy metadata、Artifact 预算与 Evidence/视觉绑定 |
| `tests/editorial-report-materializer.test.ts` | 五类 projector、Model Context 最小投影、确定性、脱敏、三类状态、question 传播、视觉策略 |
| `tests/editorial-report-pipeline.test.ts` | egress/current fence、调用上限、Plan 组装、Fidelity、修复、降级、hard fail 与只读保证 |
| `tests/editorial-report-renderer.test.ts` | XSS、raster-only、自包含、CSP、最终 block trace、组件、响应式和打印结构 |
| `tests/editorial-report-store.test.ts` | 路径逃逸、symlink、token lock、原子发布、busy、stale、幂等和 hash |
| `tests/editorial-report-cli.test.ts` | 生成／校准 CLI 参数、provider fallback、stdout/stderr、退出码、连接释放和 main 零写 |
| `tests/editorial-report-phase2-calibration.test.ts` | corpus/evidence/draft/rubric-generation 绑定、空 Store/旧 cache 隔离、本轮 outbound、阈值边界、匿名化、0600、三层 hash、commit fence、verify 与非零退出 |
| `tests/schema-registry.test.ts` | 增加两个 schema 映射断言 |
| `tests/gateway-llm-receipt.test.ts` | canonical endpoint、redirect=error、4-route identity、可选 limits、总 deadline 与既有默认行为 |
| `tests/fixtures/editorial-fidelity-golden.json` | 60 条固定 Fidelity 校准样本；不包含真实任务 UUID、URL 或敏感正文 |

### 21.4 明确不得修改

```text
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/orchestrator-runtime/src/control/task-workflow.ts
apps/orchestrator-runtime/src/report/report-package-artifact.ts
apps/orchestrator-runtime/src/report/report-document-composer.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
apps/agent-api/src/control-runtime.ts
apps/agent-api/src/routes/control-tasks.ts
apps/agent-api/src/server.ts
apps/web/**
database/control-plane.ts
database/migrations/**
orchestrator/skill-registry.yaml
knowledge-base/skills/**
```

若实现发现必须修改上述文件才能工作，应停止实现并重新评审边界，不得以“顺手接入”为由扩大主链。

## 22. 分阶段实施计划

### Phase 1：确定性、安全、可独立使用的后处理

交付：

- 契约与 Materializer。
- 确定性 `EditorialModelContext` 投影、固定 egress policy，以及 Phase 1 强制
  `{client:null, configuration:null}` 的 `EditorialModelPort`；据此生成完整 request key、Diagnostic 和
  manifest，`gatewayConfigurationHash=null`、model call 为 0。
- `editorial-report-blueprint.schema.json`、Deterministic Blueprint 及 fallback mode 校验器。
- LLM 调用前的 fallback preflight、受控 render trace 与不可变 bundle。
- 固定 HTML Renderer。
- sidecar Store 与 manifest。
- CLI 与 `package.json` 命令。
- source-reader/contract/materializer/renderer/store/pipeline/CLI 测试。

Phase 1 完成后，即使 Phase 2 永不实施，用户仍可从 main 已完成报告生成更清晰、自包含、
可打印、可追溯的编辑版 HTML。该阶段不依赖 LLM；除把既有视觉校验拆出只读 reader 的
行为保持型重构外，不改变 main 主流程、状态、产物或对外接口。Phase 1 已实现最终 V1 contract 中
Model Context、egress decision 和 nullable Gateway configuration 的零调用分支，不允许先写缺字段的
临时 manifest 再等待 Phase 2 迁移。

阶段门禁：

```bash
pnpm exec tsx --test \
  tests/editorial-report-contract.test.ts \
  tests/editorial-report-source-reader.test.ts \
  tests/editorial-report-materializer.test.ts \
  tests/editorial-report-pipeline.test.ts \
  tests/editorial-report-renderer.test.ts \
  tests/editorial-report-store.test.ts \
  tests/editorial-report-cli.test.ts \
  tests/report-package.test.ts \
  tests/visual-asset-service.test.ts
pnpm typecheck
git diff --check
```

### Phase 2：受控 LLM 编排与独立保真评审

> 实施状态（2026-08-27）：下列工程交付已在 `main@49e4b7f` 基础上完成开发与定向测试；真实发布
> 准入证据尚未采集，且全量 quality 仍有第 0.4 节所列三项失败，因此本阶段尚未完成发布验收。

交付：

- `editorial-report-fidelity.schema.json`（Review Plan），并把 Phase 1 Blueprint Plan Schema 与 Fidelity
  Review Plan Schema 注册到 Registry。
- `GatewayConfigurationError`、同实例 canonical request URL/configuration identity、真实
  `EditorialModelPort` factory、Blueprint Planner 与一次修复机制；复用 Phase 1 已落地的最小 Context
  与固定 egress policy。
- 独立 Fidelity Review。
- 仅在 Phase 1 fallback bundle 已通过且 egress allow 后调用 LLM；只有可降级的候选失败才发布缓存
  bundle，binding drift、Renderer trace/HTML safety 或 receipt 装配错误仍须 hard fail。
- 对参考类任务启用多元组件选择。

Phase 2 完成后，报告具有材料自适应的叙事和组件组合；Phase 1 的确定性结果继续作为可靠 fallback。
`LLMClient` limits/redirectMode 是可选字段，现有 main 调用不传该字段，必须由既有 Gateway 回归证明行为不变。

Phase 2 进入发布前必须同时提供以下证据，任何一项缺失都不能把该阶段标记为完成：

1. **真实 Gateway 身份闭环**：用生产相同 composition root 完成至少一次 ready；调用前冻结的
   `configurationIdentity.provider/endpointUrl/requestedModel`、route 的 `expectedActualModel`、响应
   `providerIdentity` 和 `modelName` 必须逐项一致，且 manifest/Diagnostic 中的
   `gatewayConfigurationHash` 可重算。这一 ready 必须来自本次 calibration collect 的独立空 Store，
   `cacheHit=false`，并由 model client boundary 观测到本次至少 2 个真实 outbound/response（Planner
   与其 Fidelity）；它还必须至少包含
   一个 paraphrase，并有成功且绑定同一 Blueprint 的 Fidelity Review，证明不是复用旧 ready 或
   “只调用了 Gateway 但仍全量 fallback”。另用 egress-deny
   集成 fixture 证明零次 model call 仍发布 degraded。mock、draft 或手写 fake 不能替代 ready 证据。
2. **Fidelity golden 校准**：冻结 60 条 fixture，六类 verdict 各 10 条，覆盖 `faithful`、`narrower`、
   `unsupported`、`certainty_upgraded`、`numeric_drift`、`qualification_lost`。后四类 40 条的错误放行数
   必须为 0；前两类 20 条合计最多允许 1 条误 block。fixture、prompt version、实际 model、逐条结果
   和汇总计数一并留档；失败时不能靠删除难例过门禁。
3. **真实 SEALED 包预算校准**：至少选择 10 个通过 source/fallback 门禁的真实包，覆盖五种 active
   deliverable type（每类至少 1 个），且至少 2 个 multimodal、1 个含最终可导出 raster asset。
   对 Unit 数、规范化文本 code point、`EditorialModelContext` bytes、最终 HTML bytes 和 exported
   asset 数记录 min/p50/p95/max。至少 5 个样本必须为 egress allow，所有真实样本 hard-fail 数必须为
   0；allow 样本的 ready 数必须不少于 `ceil(0.80 * N_allow)`，并分别统计 Blueprint、Fidelity、identity、
   budget 等 degraded 原因，不能只约束其中一种。因 Material/context budget 被迫 degraded 的比例还
   不得超过 20%（允许数为 `floor(0.20 * N_allow)`）。任一阈值失败即暂停 Phase 2 发布并重新评审。
   其中至少一个标记为 reference case 的样本必须 ready、含成功 paraphrase/Fidelity、最终至少五类
   `renderedCompositionKinds`、独立 risk section/risk-register，并通过第 24.3 节视觉 rubric；这样
   “丰富、多元、专业”不是由 fallback 数量替代。可导出 raster 只要求 corpus 中至少一个样本具备，
   不错误绑定到本身没有图片的参考案例。
4. **main 回归无伪绿**：第 23.4 节六文件命令与 `pnpm quality` 原则上必须通过。当前三项失败均阻塞
   发布：两条 `control-api-integration` 已在干净 `main@49e4b7f` 稳定复现；Hub snapshot 失败来自
   gitignore 范围内的本地 `.DS_Store` 哈希漂移。若无法在本范围修复，唯一替代是取得书面豁免，至少写明 owner、原因、与本
   改动无关的证据、适用 commit、到期日和跟踪 issue。存在豁免时发布记录必须明确写“带豁免”，不得
   声称“全部门禁通过”。

上述 #1～#3 只允许由同一个 runner 采集，不能分别手抄结果拼接。真实 corpus manifest 固定位于
`${RUN_WORKSPACE_ROOT:-./run-workspaces}/editorial-reports/calibration/corpus.json`，属于 gitignore
目录，格式固定为 `{version:'editorial-calibration-corpus-v1', samples:[{taskId, referenceCase}]}`，且
`referenceCase=true` 必须恰好一项；0 项或多项都拒绝。runner 从数据库重验实际 deliverable type、
状态和 binding，不信任 manifest 自报。

`--collect` 必须在 owner-only 的全新空目录内构造独立 Editorial sidecar Store，禁止读取默认 Store 或
调用前已有的 ready/fallback；model client boundary 直接计数本轮 outbound，不能从旧 manifest
反推。它把本轮 golden、corpus 和 reference 机器观测固化为 canonical
`phase2-calibration.evidence.json`，并以 `evidenceHash` 绑定 draft、rubric 和最终 result；draft 另由
`draftHash` 绑定到 rubric。它同时为唯一 reference generation 生成 1440×1000、390×844 截图和 A4
PDF，保存 bytes/hash，再生成已预填 `evidenceHash + draftHash + sampleKey + generationId + htmlHash +
三个 capture hash` 的 `reference-rubric.json`。人工只填写第 24.3 节的布尔 rubric、reviewer 与
reviewedAt，不能修改绑定字段。

`--finalize` 与 `--verify` 都必须重读 canonical summary evidence、提交内 golden fixture，以及唯一
reference 的本轮 ready manifest/HTML/capture bytes；它们把 evidence 与 draft 中的 golden/corpus/
reference 摘要全量逐值比对，重验 fixture 的 `caseId/expected` 和 reference 文件绑定，再从这些已绑定
摘要计算分布、gate 与最终 result。V1 不保存或重放 golden 原始模型响应，也不重读非 reference 样本的
Store bundle；旧 generation、旧 HTML、旧截图/PDF、另一个 task 的 rubric，或只同步修改 draft/rubric
的尝试一律拒绝。只有固定 calibration root、实时 clean-HEAD/commit fence 均由正式 CLI 执行的结果才是
发布准入证据；直接调用测试用 finalize/verify 导出 API 不构成发布证明。corpus、evidence、rubric、
captures、draft 与 result 文件均为 `0600`，run/store 目录均为
`0700`，不提交真实 UUID、正文或截图。该本地机制假定 trusted operator；没有外部签名密钥时，不承诺
抵御同一 OS owner 主动同步重写 evidence、draft 与 rubric。

真实校准必须从干净工作树启动；当前 HEAD 必须包含固定 Phase 1 基线 `49e4b7f`。collect、finalize、
verify 在关键持久化边界重复检查 HEAD，发现工作树 dirty、基线不是 ancestor 或运行中 commit 漂移均
非零退出。

唯一准入入口采用以下 collect → 人工评审 → finalize/verify 流程：

```bash
CALIBRATION_ROOT="${RUN_WORKSPACE_ROOT:-./run-workspaces}/editorial-reports/calibration"
mkdir -p "$CALIBRATION_ROOT"
chmod 700 "$CALIBRATION_ROOT"
test -f "$CALIBRATION_ROOT/corpus.json"
CALIBRATION_RUN_DIR="$(mktemp -d "$CALIBRATION_ROOT/run.XXXXXX")"
chmod 700 "$CALIBRATION_RUN_DIR"
LLM_PROVIDER=gateway pnpm editorial:calibrate -- --collect \
  --corpus "$CALIBRATION_ROOT/corpus.json" \
  --run-dir "$CALIBRATION_RUN_DIR"
# 人工检查本轮 HTML、desktop.png、mobile.png 与 report.pdf，只填写生成的 reference-rubric.json 评审字段。
pnpm editorial:calibrate -- --finalize \
  --draft "$CALIBRATION_RUN_DIR/phase2-calibration.draft.json" \
  --reference-rubric "$CALIBRATION_RUN_DIR/reference-rubric.json" \
  --output "$CALIBRATION_RUN_DIR/phase2-calibration.json"
pnpm editorial:calibrate -- --verify "$CALIBRATION_RUN_DIR/phase2-calibration.json"
```

输出采用 `editorial-phase2-calibration-v1`：记录 `baseMainCommit=49e4b7f…`、当前
`implementationCommit`、`evidenceHash`、Pipeline/prompt/fixture hash、
`gatewayConfigurationHash`、60 条逐例预期/实际 verdict 与混淆计数、真实样本的匿名
`sha256(taskId)` key、验证得到的 deliverable/multimodal/raster 属性、egress/status/cache-hit/本轮 outbound/
paraphrase/Fidelity/degraded reason、五项资源分布、reference trace/risk/rubric，以及
`gate={passed,failedCodes}`。文件末尾 `resultHash` 对排除自身后的 canonical JSON 计算。runner 发现
阈值不满足必须非零退出；其 `--verify` 模式还必须重算 result hash、要求记录的
`implementationCommit` 等于当前 `HEAD`，重读同一 run 目录的 evidence、draft、reference ready
manifest/HTML、rubric 与三个 capture 并复核全部 hash 和阈值，禁止只编辑汇总结果或复用旧结果后
过门禁。

```ts
interface EditorialReferenceRubric {
  version: 'editorial-reference-rubric-v1';
  evidenceHash: Sha256;
  draftHash: Sha256;
  sampleKey: Sha256;
  generationId: string;
  htmlHash: Sha256;
  captures: {
    desktopPngHash: Sha256;
    mobilePngHash: Sha256;
    a4PdfHash: Sha256;
  };
  reviewer: string;
  reviewedAt: string;
  items: {
    desktopHierarchyAndSpacing: true;
    mobileNoOverflowOrOcclusion: true;
    a4NoClippingAndReadableStates: true;
    offlineContentComplete: true;
    keyboardHeadingsAndAltUsable: true;
    professionalDiverseAndEvidenceBound: true;
  };
}

interface EditorialPhase2CalibrationResult {
  version: 'editorial-phase2-calibration-v1';
  evidenceHash: Sha256;
  baseMainCommit: string;
  implementationCommit: string;
  pipelineVersion: string;
  blueprintPromptVersion: string;
  fidelityPromptVersion: string;
  fixtureHash: Sha256;
  gatewayConfigurationHash: Sha256;
  runId: string;
  golden: {
    total: 60;
    cases: Array<{
      caseId: string;
      expected: EditorialFidelityCheck['verdict'];
      actual: EditorialFidelityCheck['verdict'] | 'call_failed' | 'schema_invalid';
      requestedModel: string;
      actualModel?: string;
    }>;
    falseAllows: number;
    falseBlocks: number;
  };
  corpus: {
    total: number;
    allowCount: number;
    readyCount: number;
    hardFailCount: number;
    budgetDegradedCount: number;
    degradedByReason: Record<string, number>;
    distributions: Record<
      'unitCount' | 'normalizedTextCodePoints' | 'modelContextBytes' | 'htmlBytes' | 'exportedAssetCount',
      { min: number; p50: number; p95: number; max: number }
    >;
    samples: Array<{
      sampleKey: Sha256; // sha256(taskId)，不得写原 UUID
      deliverableType: string;
      presentationMode: 'current_text' | 'multimodal';
      hasExportableRaster: boolean;
      egressDecision: 'allow' | 'deny';
      status: 'ready' | 'degraded' | 'fail';
      cacheHit: false;
      actualOutboundCallCount: number;
      modelIdentities: Array<{ requestedModel: string; expectedModel: string; actualModel: string }>;
      paraphraseCount: number;
      fidelityPassed: boolean;
      reasonCodes?: string[]; // 非 ready 的全部规范化原因；去重并按字典序排列
      generationId?: string;
      htmlHash?: Sha256;
      renderedCompositionKinds: EditorialCompositionKind[];
      hasRiskSection: boolean;
      hasRiskRegister: boolean;
    }>;
  };
  reference: {
    sampleKey: Sha256;
    generationId: string;
    htmlHash: Sha256;
    captures: {
      desktopPngHash: Sha256;
      mobilePngHash: Sha256;
      a4PdfHash: Sha256;
    };
    rubricHash: Sha256;
    allRubricItemsPassed: boolean;
  };
  gate: { passed: boolean; failedCodes: string[] };
  resultHash: Sha256;
}
```

阶段门禁：

```bash
pnpm exec tsx --test \
  tests/editorial-report-contract.test.ts \
  tests/editorial-report-source-reader.test.ts \
  tests/editorial-report-materializer.test.ts \
  tests/editorial-report-pipeline.test.ts \
  tests/editorial-report-renderer.test.ts \
  tests/editorial-report-store.test.ts \
  tests/editorial-report-cli.test.ts \
  tests/editorial-report-phase2-calibration.test.ts \
  tests/schema-registry.test.ts \
  tests/gateway-llm-receipt.test.ts \
  tests/report-package.test.ts \
  tests/model-receipt.test.ts \
  tests/visual-asset-service.test.ts
pnpm typecheck
git diff --check
test -n "$CALIBRATION_RUN_DIR"
pnpm editorial:calibrate -- --verify "$CALIBRATION_RUN_DIR/phase2-calibration.json"
```

不存在依赖后一阶段才能工作的空壳阶段，也不设置“先调查再决定”的 Phase 0。

## 23. 测试矩阵

### 23.1 Contract 与 Material

| 场景 | 预期 |
|---|---|
| 相同 source 多次 materialize | byte-for-byte 相同 |
| Unit ID exact golden tuple | 第 9.2 节 167-byte preimage 得到固定 digest/ID；Artifact ID/hash、Pointer、role、value type/value 任一变化都改变 ID |
| 两个 Unit 声明同一 ID | 无论其余元数据相同或不同都拒绝；逐项重算 ID，禁止 Map 覆盖 |
| canonical number 为 `-0/1e-7/1e-6/1e20/1e21` | exact text 为 `0/1e-7/0.000001/100000000000000000000/1e+21`；Node major 升级仍须同 golden |
| string `"1"` 与 number `1`，或同 hash 不同 Artifact ID | Unit ID 不同；NFC/换行等价输入仍稳定 |
| source pointer 或 basis unit 悬空 | 拒绝 |
| 相同文本来自不同 JSON Pointer | 保留两个 ID 不同的 Unit，不跨 Pointer 去重 |
| source Artifact/hash/Pointer/value 任一不一致 | 拒绝 |
| NFC/换行等价与内部空白差异 | 前者按固定规范一致，后者保持差异；ID/verbatim 结果稳定 |
| copy 的来源或输出含阿拉伯／中文数字、日期、CNY/RMB/USD、金额、百分之/成/折、Evidence ID 或散文内 URL | 只允许单 Unit verbatim；`三位用户`、`百分之三`、`三成`、`十万元`、`CNY 10`、`详见https://example.com/a?x=1。` 和 mixed-case `HTTPS://example.com/A` 均拒绝 paraphrase |
| ratio 为 `0/1/0.1/0.29/1e-7/-0` 且重复渲染 | 精确为 `0%/100%/10%/29%/0.00001%/0%`，byte-for-byte 稳定且未调用浮点乘法/Intl |
| 单叶子或 Material 超过 hard limit | hard fail，不切段、不发布不完整 fallback |
| 五个 active deliverable 的合法 payload | 逐类生成约定 Unit/group/basis/eligibility |
| competitive matrix cell value/score | basis 同时绑定本行 dimension 与该列 sample name；score 另绑定同 cell value |
| VOC、design audit、accessibility payload 完整 | `strategy-matrix` 仍为 ineligible，不把异构字段或无外键 platform 拼成列 |
| payload 含未知字段、字段类型错误或 registry type 无 projector | 读取阶段拒绝 |
| projector 主键重复或显式外键悬空 | 拒绝，不做文本补链 |
| research plan `evidenceRequired` | 保持 boolean 原值与精确 Pointer |
| 非白名单 numeric/audit/confidence | `metricEligible=false`，不能进入 metric cards |
| projector 注入未声明 unit 或 Blueprint ID 非安全 slug | 拒绝 |
| fact 无 Evidence | 拒绝 Material，不能猜测降级后的语义 |
| inference 被 Blueprint 标为 fact | 拒绝 |
| unknown 在正文与审计附件均遗漏 | 拒绝 |
| required claim/risk 未满足逐 question 正文覆盖 | 拒绝，即使附件已包含 |
| required recommendation/risk/validation 只在附件出现 | 拒绝 |
| 存在 risk Unit 但无独立 risk section/risk-register，或漏 body-required risk | 拒绝 |
| payload 核心 context 的 `requiredInBody` 只在附件出现 | 拒绝 |
| gallery 已采用 Asset 未传递覆盖其 caption/alt Unit | 拒绝 |
| audit appendix 缺失、重复或漏掉 required unit | 拒绝 |
| audit appendix 漏掉 basis/question 关联，或 basis 展开不闭合 | 拒绝 |
| 至少五类组件 eligible、候选只使用 narrative/card-grid | 拒绝 composition quality |
| Diagnostic `mode=none` 与 prepared 分支交叉变异 | none 分支无 material/egress/context 字段；prepared 分支全部必填；非法组合被类型与 runtime schema 同时拒绝 |
| 任一 model call 缺 modelContext hash/byte size | Schema 拒绝；成功/失败调用都必须绑定同一 Context |
| blocked evidence/asset | 不进入 Material |
| `EditorialModelContext` golden projection | 只含允许字段；不含作为结构元数据的 UUID、Artifact/Manifest ID/hash、Pointer、Evidence/URL、路径或图片 bytes；Unit 原始值中的业务字面 token 不被误删，hash/bytes 稳定 |
| design/competitive before-after Asset lineage 不匹配 | hard fail，不能伪造 pair 关系 |
| 输入对象在 materialize 后比较 | 完全未变 |

每个 block kind 都必须有一组独立的关系变异测试；失败统一进入 `component_relation`，不能只靠
Schema 或“所有 ID 都存在”测试代替：

| kind | 必须拒绝的变异 |
|---|---|
| `narrative` | 一个 paragraph 拼接无共同 question、group 或 basis 的 Unit |
| `decision-cover` | summary 只有无关 audit context，或 boundary 引用无关业务结论 |
| `metric-cards` | label 与 value 来自不同 group 且没有 basis |
| `truth-triad` | Unit 被放入错误状态列，或同一 Unit 跨列重复 |
| `card-grid` | title 与 body 来自两个无关 group |
| `flow` | label/body 跨 group，或 step 顺序与 projector sequence 不同 |
| `strategy-matrix` | cell 换到错误 row/column，或其 basis 缺 row dimension／column sample 任一端 |
| `roadmap` | item 放入来源 priority/phase 不同的 lane |
| `validation-gates` | label、method、criterion 跨 action/issue group |
| `risk-register` | risk 拼接无 basis 的 impact/response |
| `visual-gallery` | Asset 交换了另一 Asset 的 caption/alt，或 comparison 顺序反转 |
| `audit-appendix` | Unit/Evidence 不等于 required canonical closure，或加入不存在的 basis 边 |

### 23.2 LLM 与 Pipeline

| 场景 | 预期 |
|---|---|
| 合格 Blueprint + fidelity pass | ready |
| 合格 `EditorialBlueprintPlan` | Pipeline 确定性注入 binding/request/material envelope 和唯一 audit appendix；模型响应中不得出现这些控制字段 |
| fallback preflight 完成与首次 model call 的事件序列 | 所有 deterministic/HTML/byte gate 先 passed，随后才能调用 model |
| fallback preflight 任一关系／覆盖／组合／8 MiB 门禁失败 | `SOURCE_NOT_RENDERABLE` hard fail，model call spy 为 0，无 manifest |
| fallback preflight 通过后强制 LLM 失败 | 直接发布相同 blueprint/html hash 的缓存 bundle；Renderer spy 证明 fallback 只渲染一次 |
| 首次 Schema 失败、修复成功 | ready，尝试数为 2 |
| 两次 Schema 失败 | deterministic fallback，degraded |
| dangling Material ID | deterministic fallback，degraded |
| 数字、日期或证据编号漂移 | deterministic fallback，degraded |
| certainty upgrade | deterministic fallback，degraded |
| 首次候选为任一 block relation 错配、第二次修复正确 | 第一次 rejected 且 issue=`component_relation`，第二次 ready |
| 两次候选为任一 block relation 错配 | 发布已预检 fallback，degraded |
| 最终 `eligibleCompositionKinds` ≥5、两次候选的 `renderedCompositionKinds` 均不足 5 | 已预检 fallback 必须在最终 trace 选满 5 类，degraded |
| 原先恰好 5 类含 gallery，全部图片被预算过滤且最终 eligible <5 | 空 gallery 不渲染、不计数；不为凑五类 hard fail |
| gallery 过滤后最终仍有 ≥5 个非视觉 eligible kind，但实际只渲染 4 类 | LLM 候选拒绝；fallback 同样情形为 `SOURCE_NOT_RENDERABLE` |
| 最终 eligible composition 少于 5，但 trace 注入任一 ineligible kind | 仍拒绝；subset 不变量不受五类阈值条件控制 |
| Fidelity 缺少／重复／额外 copy Pointer 或 Unit 列表不一致 | deterministic fallback，degraded |
| Fidelity Plan 试图输出 materialHash/blueprintHash 或 top-level verdict | Schema 拒绝；Pipeline 只对合格 checks 注入当前 hash 并确定性 fold verdict |
| Gateway 返回 unknown 或非 expected model | `MODEL_IDENTITY_INVALID`／`MODEL_DRIFT`，degraded |
| Material 或候选 paraphrase 包含 prompt injection 文本 | Planner/Fidelity 请求均携带 Editorial 专属 system prompt；system prompt 变化必须改变 prompt hash/version |
| egress matrix 的 allow 行 | fallback preflight 后才调用；policy/configuration/context hash 在 request/Diagnostic/manifest 一致 |
| 零调用 deny/unconfigured fallback | Diagnostic 顶层 configuration hash 与 request/manifest 一致或同为 null，modelCalls 为空 |
| provider 未配置或 typed Gateway config error | Diagnostic `gatewayConfigurationHash=null`、零调用 fallback；普通 Error/TypeError 必须继续抛出 |
| 单 route 缺显式 expected-actual pin | port 归一为未配置、零调用；不得把 requested model 暗当 actual pin |
| client configuration snapshot 在任一调用前与注入 configuration 不同 | `EDITORIAL_MODEL_PORT_MISMATCH` hard fail，该次及后续调用均不发出 |
| 任一贡献 source 为 sensitive/confidential/unknown/non-v1 | model call spy 为 0，发布 preflighted degraded |
| provider/mode/host/path/query/credential/redirect 任一不合格 | model call spy 为 0；不得把 POST body 发往该目标 |
| Gateway base URL 为 `/v1` 与 `/v1/` | snapshot `endpointUrl` 与捕获到的实际 fetch URL 均逐字等于唯一 `/v1/chat/completions`，不得出现双斜杠 |
| 标准 4-route Gateway 配置 | 完整保留且可 eligible；单逻辑调用跨 routes 的实际 HTTP 请求仍最多 3 次 |
| 307/308 响应 | `redirect=error`，不跟随；可降级为 fallback |
| Gateway 返回现有 16-hex prompt fingerprint | 原样记录为 PromptFingerprint，不冒充 64-hex 文件 hash |
| 伪装 client 返回 receiptId | hard fail、不发布；官方 CLI 类型装配测试禁止 ReceiptLLMClient |
| fidelity timeout/block | deterministic fallback，degraded |
| Material 超预算 | 不调用 LLM，degraded |
| 400 Unit 边界、全部 body-required 且强制 LLM 失败 | fallback 在 48 block/1,200 copy 上限内完整覆盖；不得因 240-copy LLM 限制失败 |
| 普通元数据的 Material 1,000 Unit/500,000 code point 边界与各自 +1 | 边界值仍须通过 exact-byte fallback preflight；Material 任一 +1 在 preflight 前 hard fail |
| Source metadata、Evidence 数量或总字节超预算 | 读取大对象前 hard fail，无 sidecar |
| 1,000 条 Evidence entry 重复引用同一 Artifact | 该 Artifact 只读取和解析一次，预算按唯一 ID 计 |
| 重复 screenshot Evidence 引用同一 asset/manifest pair | 视觉验证和 bytes 拷贝各一次 |
| 未完成 task/legacy/non-pass Review | hard fail，无 manifest |
| start fence 或第一次 pre-model fence 前切换 current Attempt/package | `SOURCE_BINDING_CHANGED`，model call spy 为 0，无 manifest |
| 参数化地在第 1～3 次 outbound call 后、下一次 Fidelity／repair pre-model fence 前切换 current | 不发下一次 outbound call，`SOURCE_BINDING_CHANGED`，丢弃已有响应且不发布 |
| model 完成后、publish fence 前切换 current | `SOURCE_BINDING_CHANGED`，丢弃 staging，不发布 ready/fallback |
| valid ready cache 命中但 cache-return fence 已切换 current | 不返回旧 cache、不创建新输出、不改写既有 Diagnostic，`SOURCE_BINDING_CHANGED` |
| 复用既有 fallback 时在异步审计写入期间切换 current | 审计写入后再次执行 cache-return fence；不返回旧 generation，`SOURCE_BINDING_CHANGED` |
| 同 request 并发竞争锁 | 一个 owner 继续；loser 一次 stale check 后立即 `EDITORIAL_REQUEST_BUSY`、零等待、零 LLM |
| owner 发布 ready 后启动的新调用 | ready fast-path 完整校验并通过 cache-return fence 后复用同一 generation |
| owner 发布 degraded 或 unsafe hard fail | 并发 loser 结果仍为 busy；后续新调用无 ready 时重新竞争，旧 fallback 不掩盖 hard fail |
| Pipeline dependencies 类型检查 | 不具备 main 写接口 |
| 校准 `N_allow=5` 且 ready=4／3 | 4 通过 80% 下限，3 非零退出；budget degraded 同时按 `floor(0.20*N_allow)` 独立判定 |
| Fidelity golden 配置为非白名单 endpoint | 首条 golden 前固定 egress deny，model call/fetch spy 为 0，runner 非零退出 |
| 校准 corpus 少于 10、五类覆盖不全、reference 为 0/2 项、hard-fail>0 或 reference 非 ready | 各自固定 failedCode，runner 非零退出 |
| calibration evidence/draft/result 被改写、evidenceHash/draftHash/resultHash 错误或 implementationCommit 非当前 HEAD | `--finalize`／`--verify` 非零退出 |
| calibration 输入／输出权限或匿名化检查 | 非 0600 拒绝；结果不含 task UUID、源正文、URL、owner token 或截图 bytes |
| 默认 Store 预置同 request 的旧 ready 后执行 collect | 使用新建空 run Store，`cacheHit=false`，ready 证据必须观测到本轮真实 outbound/response |
| rubric 来自同 task 的旧 generation/HTML，或任一 desktop/mobile/PDF hash 不同 | finalize 非零退出，不生成可通过 verify 的 result |

### 23.3 Renderer 与 Store

| 场景 | 预期 |
|---|---|
| 文案包含 `<script>`、引号和实体 | 作为文本显示，不执行 |
| 大量 `&<>'\"`、控制字符和四字节 Unicode | 对实际 UTF-8 escaped HTML 计数；不会按源字符数低估体积 |
| fallback HTML 恰为 8,388,608 bytes／增加 1 byte | 边界通过；+1 为 `SOURCE_NOT_RENDERABLE`，且不调用 LLM |
| LLM 候选 HTML 恰为 8,388,608 bytes／增加 1 byte | 边界可 ready；+1 拒绝候选并发布已预检 fallback |
| 候选或 fallback 静态扫描发现 unsafe HTML | hard fail，不发布本次生成结果；不能降级掩盖安全错误 |
| Diagnostic／manifest 使用全部最大长度 metadata | canonical bytes 分别不超过 2 MiB／256 KiB；fixture 覆盖 480 Fidelity checks、128 issues、128 candidate issue codes 和 4 calls，任一字段 +1 在装配时拒绝 |
| Asset caption/alt Unit 悬空、Pointer/value 被篡改 | 拒绝渲染 |
| URL 为 `javascript:`、`data:text/html` 或非 HTTPS | 不生成链接 |
| HTML 扫描 | 无 script、事件属性、外部资源 |
| `exportPolicy=allow` + verified PNG/JPEG/WebP | 预算内可内联，data URI MIME 与 bytes 一致 |
| 合法 `exportPolicy=mask|block` | 永不内联；分别记录 `VISUAL_MASK_OMITTED`／`VISUAL_BLOCKED_OMITTED` warning |
| comparison pair 任一侧为 mask/block/SVG 或超预算 | 两侧一起省略，不输出误导性的半组 before/after |
| verified SVG，或伪装成 PNG MIME 的恶意 SVG/XML bytes | 前者 warning 省略；后者 media/signature mismatch hard fail；HTML 均无 SVG/XML/`data:image/svg+xml` |
| 未知 media type、非法 export policy 或 manifest schema | source-integrity hard fail；不得降级成省略 warning |
| 单图／总图像超限 | 省略并 warning |
| 省略部分资产后重算 generation | manifest exportedAssets、generationId 与 HTML data URI 集合严格一致 |
| Blueprint 声明 gallery 但最终零图片 | 不生成空 gallery DOM，trace 不含该 block/kind |
| Blueprint 声明五类但 Renderer 漏一非空 block、漏同 kind 的第二个 block或伪造 blockId | trace 对比失败并 hard fail，不用 fallback 掩盖 Renderer bug |
| 390px viewport | 无横向溢出 |
| 1440px viewport | 信息层级、网格和目录正常 |
| A4 PDF | 无正文裁切，附件展开，状态可辨 |
| Store 遇到 `..`、绝对路径或 symlink | 拒绝 |
| manifest 完成前失败 | 无 final slot，仅可有 staging |
| final directory rename 后立即崩溃 | slot 已完整发布，下次校验后直接复用 |
| manifest/file hash 被篡改 | 拒绝读取或复用 |
| manifest authority/sensitivity/redaction policy 与冻结源不一致 | 拒绝读取或复用 |
| 活锁存在且不满足 stale 条件 | 立即 busy；fake timer/poll spy 证明没有等待、sleep 或轮询 |
| fake clock 跨过 15m/24h 边界 | 分别触发有 token/inode 复核的 stale-lock 隔离与 staging 清理 |
| 两个 reclaimer 与一个新 owner 交错竞争 | 只有持有 `.reap` guard 者可隔离一次旧锁；新 owner 抢先后 reclaimer 返回 busy，绝不 rename/unlink 新锁 |
| reclaimer 崩溃遗留 `.reap` guard | 后续 stale 回收 fail closed 为 busy，不自动递归回收 guard |
| 旧 owner finally 遇到新 owner lock | token/inode 不匹配，不 unlink 新锁 |
| lock malformed、symlink、token/request 不匹配 | fail closed，不隔离、不删除 |
| owner/reap token 泄漏扫描 | stdout、stderr、Diagnostic、manifest 和结构化日志均不含 token |
| CLI 成功、降级和 hard fail | stdout/stderr、退出码与连接释放均符合合同 |

Renderer 测试固定一份经 Validator 判定至少五类组件 eligible 的 Material/Blueprint fixture，使用
仓库已有 Playwright 生成 1440×1000、390×844 截图和 A4 PDF。自动断言 sticky/anchor 目录、
状态图例、首屏标题与决策区存在、无水平溢出、打印附件展开；截图保存到被 gitignore 的验收目录。
V1 不做脆弱的跨平台像素 diff，人工 rubric 必须逐项通过标题层级、正文行宽、卡片间距、信息密度、
状态辨识和黑白打印，不能只凭“页面能打开”验收。

### 23.4 主链回归

```bash
pnpm exec tsx --test \
  tests/report-package.test.ts \
  tests/model-receipt.test.ts \
  tests/visual-asset-service.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/control-api-integration.test.ts
pnpm quality
```

另加一条 Editorial CLI 集成回归：分别运行显式 Phase 1 零调用 factory，以及默认 Phase 2 composition
root 的实际 Gateway client 调用路径；运行前后分别快照 task、attempt、artifact、整张
`control_model_calls` 表（含 `attempt_id IS NULL` 的行）以及 `run-workspaces/current-control/tasks/{taskId}` 的文件 hash；断言所有
快照 byte-for-byte 不变，且唯一新增路径位于 `run-workspaces/editorial-reports/`。这条测试才是
“不影响 main”的自动化证据，不能用单纯重跑既有测试替代。

Phase 1 文档终审时，上述前三个现有 seam 回归曾在其开发起点 `main@5465e62` 运行，结果为
91/91 通过；该数字只保留为历史记录，不能替代当前 `main@49e4b7f` 上的 Phase 2 实现验收。

当前 `main@49e4b7f` 工作树同时运行本节六文件完整命令时，结果为 227 tests：224 pass、2 fail、1 skip；两条失败
均来自 `tests/control-api-integration.test.ts`，分别是
`failed clarification releases its pending command so a retry can complete`（期望 500，实际 422）和
`post-activation clarification failure reclaims the same command without another requirement version`
（期望 200，实际 400，unknown key `audience`）。两项均已在干净 `main@49e4b7f` 单独复现，且对应
路由、测试与持久化代码不在 Phase 2 diff 中。实施者必须在独立基线修复或得到明确的既有失败豁免后
再使用“全部门禁通过”作为合并结论，不能把这两项误归因于 Editorial 代码，也不能静默忽略。
豁免必须满足第 22 节的 owner/commit/issue/到期日合同；没有这份书面记录时，两条既有失败仍是发布
阻断项，而不是“已知所以忽略”。

## 24. 真实验收

### 24.1 输入选择

从 main 当前数据库选择一个同时满足以下条件的任务：

- state 为 `completed` 或 `completed_with_gaps`；
- 当前 Attempt 存在 SEALED `report-package-v1`；
- Report Review verdict 为 pass；
- 至少包含 fact、inference、risk/unknown、recommendation；
- 优先选择含 verified visual assets 的 multimodal 报告。

验收人员把选中的真实 UUID 注入 `EDITORIAL_TASK_ID` 后运行；变量为空时命令必须在访问数据库前失败：

```bash
test -n "$EDITORIAL_TASK_ID"
LLM_PROVIDER=gateway pnpm editorial:report -- --task-id "$EDITORIAL_TASK_ID"
```

这里的 UUID 由验收人员从当前数据库选择，不是代码默认值，也不得写入仓库。

### 24.2 功能验收

- Phase 1 验收允许 CLI 返回明确的 degraded；Phase 2 发布验收的 reference case 必须返回 ready，
  其他真实样本按第 22 节 ready-rate 门禁统计，不能用“明确 degraded”替代模型能力成功。
- 输出可通过 `file://` 直接打开。
- 报告先呈现决策、边界和材料规模，再进入详细分析。
- fact、inference、unknown 在正文和打印版均清晰可辨。
- 在材料支持时出现不少于五类不同内容组件。
- 五类门禁以最终 `eligibleCompositionKinds`/`renderedCompositionKinds` 为准；空画廊和被省略图片不计数。最终 eligible 少于五类时，
  验收记录真实集合，不为了数字要求伪造组件。
- 每个问题的核心结论，以及所有建议、风险和验证项均在正文出现；附件另行完整逐项覆盖全部
  required Unit，不能用折叠附件掩盖空洞正文。
- 存在 risk Material 时有独立风险区和 `risk-register`，而不是把风险混入普通段落。
- 每个引用能回到 Material Unit，再回到源 Artifact JSON Pointer 和 Evidence ID。
- 参考 Demo 中“决策→定位→人群→动机→链路→策略→机会→行动→验证→边界→审计”的阅读节奏可以作为质量样板，但不要求复制章节或文案。
- 不复制参考 Demo 对三处 Evidence ID 的手工修正；若 Canonical 输入仍有问题，报告必须保留原绑定或停止发布。

### 24.3 视觉与打印验收

- 在 1440×1000 和 390×844 viewport 截图，无横向溢出、遮挡或不可读文本。
- Chrome/Chromium 打印预览选择 A4 portrait，正文、表格、卡片和附件无裁切。
- PDF 中链接文本、Evidence ID、fact/inference/unknown 标签与页脚可见。
- 关闭网络后重新打开 HTML，除点击外部 citation 外，页面内容和视觉不缺失。
- 页面只含 PNG/JPEG/WebP data URI；无 SVG/XML，mask/block 资产不出现。
- 用键盘访问目录、链接和 `<details>`；标题层级连续，图片 alt 有意义。

### 24.4 不影响 main 的验收

运行前后比较并确认：

- task state、stateVersion、activePlanVersionId、currentAttemptId 不变；
- manifest/CLI 返回的 report package ID/hash 与调用开始及返回／发布 fence 读取的 current binding 一致；
- `control_execution_attempts` 不新增、不更新；
- `control_artifacts` 不新增、不更新、不失效；
- `control_model_calls` 全表行数和内容均不变，包括 `attempt_id IS NULL` 的记录；
- `run-workspaces/current-control/tasks/{taskId}` 下全部文件 hash 不变；
- 唯一新增内容位于 `run-workspaces/editorial-reports/`。

## 25. 风险与应对

| 风险 | 应对 |
|---|---|
| LLM 为追求表达效果创造新结论 | source-ref 强制、数字检查、证据等级检查、独立 fidelity、确定性 fallback |
| 参考 Demo 的手工证据修正被误当成能力 | 明确禁止读取原始 Tool 输出和修复 Canonical 引用 |
| 报告样式丰富但信息失真 | 内容与表现分离；Renderer 从 Material 注入状态和证据 |
| 同一内容被多次生成并覆盖 | generation 内容寻址、原子目录发布、禁止覆盖 |
| 图片使单文件过大 | 单图、数量、总字节和 HTML 四层上限；超限省略图片而非正文 |
| mask/block/SVG 被误当成安全可内联资产 | Editorial 仅允许 allow+raster；合法 mask/block/SVG 分码告警省略，未知类型或损坏输入 hard fail，不改变 main 既有语义 |
| 敏感或未知脱敏版本被发送给模型 | 固定默认拒绝 egress policy 检查全部贡献 source；最小 model context；deny 时零调用 fallback |
| Gateway 同 host 重定向或异 path 外传 | 精确 canonical endpoint 进入 hash，sidecar 固定 redirect=error |
| 生成期间 task current 已切换 | start/每次 pre-model/cache-return/publish 四类 fence；变化即 `SOURCE_BINDING_CHANGED`，不继续出站、不发布/返回旧结果 |
| LLM 或 Gateway 中断 | LLM 前先通过 fallback preflight；bounded retry 后直接发布缓存 bundle，main 不受影响 |
| opt-in Gateway limits/redirectMode 意外改变既有调用 | 两者保持可选；默认路径回归测试必须 byte/行为兼容 |
| 大报告超出上下文 | 超预算不分块、不截断；fallback preflight 通过才发布 deterministic fallback，否则 fail closed |
| sidecar 被误认为权威报告 | manifest 显式标记 derived，并固定反向引用 source package ID/hash |
| 未来调用方绕过 owner 校验 | V1 仅本地运维 CLI；若新增 HTTP 必须独立设计 owner 隔离与授权测试 |

## 26. Premise Collapse

本方案最脆弱的前提是：**main 的 sealed Deliverable、Evidence Manifest，以及存在时的
ReportDocument 已经包含足够完整、结构化且正确绑定的内容，后处理只需重组就能达到专业报告质量。**

如果该前提不成立：

- Editorial Pipeline 只能产出更清晰但内容仍稀疏的报告；
- 它不能安全生成缺失的人群、链路、指标或策略；
- 它也不能像参考 Demo 那样越过 Canonical 结果修正原证据。

正确处理是回到 main 的研究、综合或 Report Review 修复内容与证据，再重新封存 Report Package。不得通过放宽 Editorial 校验、读取未评审中间产物或让 LLM 自由补全来掩盖上游缺口。

## 27. 被拒绝的方案

### 27.1 让 LLM 直接生成完整 HTML

拒绝。它把事实改写、结构、样式和可执行内容混为一次不可控输出，难以做引用闭包、XSS 防护、稳定打印和视觉回归。

### 27.2 将 Editorial 阶段插入 LeaseExecutionEngine

拒绝。任务可能因纯展示失败而无法完成，重试和恢复还会扩大主链状态机。后处理失败不应改变研究完成事实。

### 27.3 把能力包装成新 Skill

拒绝。Skill 负责研究能力与产出，不应承担对最终报告的通用展示变换；否则每个 Skill 都会重复同一套编辑逻辑。

### 27.4 新建 Project/Question Report 数据模型

拒绝。main 当前没有 Project 实体，V1 的价值可由现有 task/plan/attempt/report package binding 完整承载；新实体没有独立生命周期需求。

### 27.5 在完成后的 Attempt 下继续写 Control Artifact

拒绝。`database/control-plane.ts:2080` 要求 attempt-bound Artifact 必须持有 active lease，且任务处于 executing/reviewing/composing_report。放宽该约束会破坏主链安全边界。

### 27.6 只做固定模板、不使用 LLM

这是最小可行方案，也是 V1 的 Deterministic Blueprint fallback；但它无法根据内容形成参考样例那样的叙事和组件组合，因此不作为最终推荐形态。

### 27.7 将派生结果登记为 plan-bound Control Artifact

拒绝。虽然现有表允许无 Attempt 的 plan-bound Artifact，但这仍会写入 main 的 Artifact Registry，并需要额外的发现、失效和源 Attempt 绑定规则。V1 使用独立 sidecar，可以直接证明数据库零写入，边界更清楚。

## 28. 发布与回滚

### 28.1 发布

- Phase 1 与 Phase 2 分别合并，均要求定向测试、typecheck 和 `git diff --check` 通过。
- Phase 2 完成后执行 `pnpm quality`，并完整满足第 22 节四组准入证据；“一次能调用 Gateway”不能
  替代 identity、golden、真实包分布与主链回归门禁。identity、golden、真实包分布等发布阈值不允许
  豁免；仅第 0.4、22 节已记录的三项非 Editorial 失败可按第 22 节的完整书面豁免合同继续，且发布结论必须
  明确标注“带豁免”。
- 首次发布不自动调用；由操作者显式运行 CLI。
- 真实验收记录 manifest 路径、generation ID、源 Report Package hash、egress/configuration hash、
  最终 render trace 摘要、状态和 PDF 截图，不提交包含真实内容的生成物。

### 28.2 回滚

- 回滚 `editorial:report`/`editorial:calibrate` scripts、新增模块，以及共享视觉 reader／Gateway
  identity/typed config/opt-in limits 的小型
  兼容改动即可停止新生成；不涉及数据回滚。
- main 没有 Schema、状态或数据迁移需要回滚。
- 已生成 sidecar 保留用于审计，但任何 main reader 都不会读取它。
- 若必须清理，由操作者按 CLI 返回的绝对 ready/fallback slot 逐个处理；实现不提供递归批量删除命令。

## 29. 依赖清单

复用已有依赖：

- PostgreSQL 与 `ControlPlaneRepository`：只读任务与 Artifact 元数据。
- `ControlArtifactStore` 的只读方法、`CurrentReportPackageReader` 和抽出的
  `VerifiedVisualAssetReader`：验证源内容；不实例化 `ReportPackageArtifactService` 或完整
  `VisualAssetService`。
- `LLMClient` / `GatewayLLMClient`：结构化 Blueprint 和 Fidelity Review。
- `SchemaValidator` / AJV：Schema 校验。
- Node.js `crypto`、`fs`、`path` 与现有 `@openclaw/fs-safe`：hash 和安全文件发布。

不新增 npm package、外部 API、MCP server、部署进程、环境变量或账号。真实 LLM 路径只使用 main 已有的 `LLM_GATEWAY_*`、`LLM_MODEL_*`。

## 30. 完成定义

满足以下全部条件才算完成：

- 两个 Phase 的代码和测试均已合并。
- CLI 只能消费当前完成任务的 verified SEALED Report Package。
- start、每次 pre-model、cache-return、publish 四类 current fence 全部生效；绑定变化不会继续模型
  调用、返回 cache 或发布旧 generation。
- Material、最小 Model Context、Blueprint Plan/final Blueprint、Diagnostic、HTML 和 manifest 均符合本文契约。
- LLM 从未生成或控制 HTML/CSS/JavaScript。
- 只有固定 egress policy allow 的最小 Context 可发送；所有 deny 路径模型调用数为 0。
- 所有实质文案、数字、状态、视觉和引用均可追溯。
- 任何 LLM 调用前 fallback 已通过完整发布预检；纯 LLM 失败直接发布缓存结果，源完整性、
  fallback renderability 或 HTML safety 失败能够 fail closed。
- HTML 自包含、可离线阅读、适配窄屏并可打印为 A4 PDF。
- 最终非空 render trace 满足组件多样性；risk 有独立风险区；mask/block/SVG 不进入 HTML。
- 参考任务达到约定的信息层次与组件多样性，但未复制其手工证据修正。
- Phase 2 的真实 Gateway ready+Fidelity、60 条 Fidelity golden、至少 10 个真实 SEALED 包、allow
  ready-rate、全原因降级分布、预算阈值和 reference rubric 均由同一校准结果证明达标。
- 主链回归、typecheck、`pnpm quality` 与真实验收全部通过；唯一例外是第 0.4/22 节已记录的三项
  非 Editorial 失败取得完整书面豁免，此时完成状态和发布记录必须明确标注“带豁免”，不得写“全部通过”。
- main 的数据库状态、Control Artifact、运行目录和原报告在生成前后完全不变。

## 31. 开发准入结论

该能力值得实现，但必须被定位为 **canonical report 之后的只读、显式、可失败、可回退的派生展示层**。Durable domain entity delta 为 `+0 / -0`；公开工具表面新增 1 个生成 CLI 和 1 个仅用于发布准入的校准 CLI，文件接口新增 4 个版本化主契约，以及 Model Context、Blueprint Plan、Fidelity Review Plan 三个模型边界契约；最终 Fidelity Review 是 Pipeline 本地注入 hash 并 fold verdict 的审计子契约。它们不改变 main 的业务真相源。

本设计的最小安全边界是：

```text
LLM 只接收最小 Context 并规划 Blueprint Plan
+ 固定 egress policy 默认拒绝
+ 所有内容必须引用 Material
+ Fidelity 独立校验
+ LLM 前先证明 fallback 可发布
+ Renderer 确定性生成 HTML
+ current binding 在每次出站、返回／发布前重验
+ Sidecar 与 main 物理隔离
+ 任意失败回到原 Report Package
```

任何要求让 LLM 直接输出 HTML、读取未评审中间产物、改写源证据或阻塞 main 完成状态的实现，都不符合本文方案。
