# Playwright 网页视觉证据链开发文档

> 状态：开发已批准，Gate 0 已完成，可进入工作包 A。
>
> 日期：2026-08-19。
>
> 执行清单：`docs/plans/2026-08-19-playwright-visual-evidence-pipeline-todolist.md`。
>
> 适用范围：Current 任务主链中的公开网页取证、视觉资产封存、竞品分析报告图片展示，以及现有评分权重图表的可信来源修复。
>
> 真相源：本文冻结本次开发的接口、边界、失败语义、文件范围、测试和发布门禁。本文不授权修改 Legacy 写路径，也不授权绕过登录、验证码或站点访问控制。

## 1. 决策摘要

本次采用以下主链：

```text
Tavily 发现公开来源 URL
  -> 计划将 Playwright 作为 optional enhancement 插入
  -> 受保护的 Node Worker 访问来源页并截图
  -> Tool JSON Artifact 与内存媒体 sidecar 配对
  -> VisualAssetService 封存图片和来源 Manifest
  -> Evidence Manifest 绑定网页来源与截图
  -> CurrentDeliverableService 选择可展示视觉证据
  -> ReportDocument 输出图片、图表和可追溯证据
  -> Web 历史任务读取同一份已封存报告包
```

不部署 SearXNG，不增加独立浏览器服务，不新建专用 Agent。Tavily 继续负责发现 URL，Playwright 只负责访问明确的 URL 和生成视觉证据，研究 Skill 负责来源判断和报告分析。App 截图继续走现有 `ai-spider-search`，两条来源最终都进入同一套 Visual Asset 与 Evidence 合同。

本方案冻结以下实现选择，不再留给开发阶段二次决定：

- `competitive-web-research.required_tools` 仍只有 `tavily-web-search`；新增 `optional_tools` 声明 `playwright-page-capture`。optional Tool 不参与 Skill 资格否决。
- 新增 optional 计划字段对历史 Current Plan 保持可选；新编译计划显式写出，旧计划缺失时按空数组读取。
- Playwright 只在 `PLAYWRIGHT_CAPTURE_ENABLED=1` 且生产 Worker 已满足非 root、Chromium sandbox 和基础设施出站隔离时注册。未注册或执行失败只形成缺口，文本研究继续。
- 浏览器路由检查是纵深防御，不宣称能够固定 Chromium 的 DNS 解析结果。阻断私网和云元数据地址的最终边界由部署环境出站策略承担；本次不实现应用内 CONNECT 代理。
- 新写入的浏览器截图和数据图表使用 `visual-asset-manifest-v2`；V1 Schema 保持不可变，新 Reader 先于 V2 Writer 发布。
- 每个 Worker 最多同时运行 2 个 Browser，等待队列最多 8 个调用，排队超过 10 秒返回可降级的 `capacity` 缺口。
- 部分页面失败只持久化在 Tool JSON `output.failures`，全部失败只进入脱敏 execution failure details；不维护第二份内存 gap 内容，发布/步骤状态确定后才进入任务缺口。

实现会涉及 8 个以上文件，预计修改运行时、计划编译、视觉资产、报告合同、Web 报告读取和测试等 30 余个文件。该范围来自现有模块边界，不通过新建总控服务隐藏复杂度。

## 2. 背景与问题

当前报告以文字为主，不是单一检索参数造成的，根因分布在四层。

| 层级 | 当前能力 | 缺口 |
|---|---|---|
| 来源发现 | `tavily-web-search` 返回标题、URL 和摘要 | 不返回可直接封存的网页截图 |
| Tool 运行时 | `ToolInvokeResult` 只承载 JSON | 无法传递 PNG、JPEG 或 WebP 字节 |
| 视觉资产 | `VisualAssetService` 可接收用户上传，或下载 Tool Artifact 中的远程图片 URL | 没有浏览器截图来源类型，也无法接收 Tool 产生的内存字节 |
| 报告合同 | ReportDocument 已支持单图、对比图和图表 Block | 竞品报告只认可用户上传的原图，`screenshotComparisons` 又强制要求原图与标注图成对，普通网页截图无法进入报告 |

现有评分权重图表还有一处来源建模错误。图表 SVG 必须伪装成第一张用户上传图片的派生资产，没有用户图片时图表不生成。评分权重来自已封存的结构化数据，图表应绑定该数据 Artifact，不应依赖一张无关图片。

运行环境也有明确前置问题。根 `package.json` 要求 Node `>=22`，当前 shell 仍是 Node `v20.18.1`，但本机已有 Node `v22.22.1`。Playwright 依赖和 Chromium 均未安装，实施和验收命令必须显式运行在 Node 22。

## 3. 目标与成功标准

### 3.1 产品目标

- 公开网页研究任务可以自动生成真实网页截图，并在报告中以内网资产地址展示，不使用外部图片热链。
- 每张图片都能反查来源页 URL、最终 URL、页面标题、获取时间、截图方式、选择器、视口、尺寸和 SHA-256。
- 竞品报告可直接展示单张网页证据，不再要求所有图片都组成原图与标注图对。
- 有已确认评分权重时，报告稳定生成一张数据图表；没有可信数值时不自动编造竞品评分图。
- Playwright 或目标站点不可用时，文字研究仍可完成，任务状态为 `completed_with_gaps`，报告明确列出缺失平台或页面。
- 已完成报告可从前台历史任务重新打开，图片、图表、证据编号和导出内容保持一致。

### 3.2 工程成功标准

- Tool JSON 中没有 Base64、Buffer 序列化结果或临时文件路径。
- 媒体字节只在当前 Worker 内存和 `ControlArtifactStore` 之间传递。
- Tool 步骤只有在 JSON Artifact、全部成功截图、Visual Asset Manifest 均封存并复核后才记为 `succeeded`。
- 任一媒体封存或一致性校验失败时，Tool JSON 和同批已生成视觉资产全部失效，步骤不得留下半发布状态。
- 任一补偿失效失败都必须冒泡为 `artifact_invalidation` 并暂停任务，禁止用 `Promise.allSettled()` 吞掉清理错误。
- Chromium 必须以 `chromiumSandbox: true` 启动，Context 必须阻断 Service Worker 和 WebSocket；无法满足时 Adapter 拒绝启动，不允许回退到无沙箱。
- Browser 数量、排队数量和调用总时限在 Worker 级有界；租约丢失与总时限到期会通过同一个 `AbortSignal` 关闭 Page、Context、Browser 并释放配额。
- 浏览器截图不参与 checkpoint 复用，重试会重新访问页面并生成新的获取时间与哈希。
- `pnpm quality`、定向测试和真实任务 Smoke 均通过。
- 不新增数据库迁移，不新增 API Key，不改变 Current HTTP 路由。

## 4. 非目标

本次不做以下工作：

- 不部署本机或远端 SearXNG。
- 不替换 Tavily，也不新增第二个通用搜索供应商。
- 不新建浏览器微服务、Docker 容器或独立 Agent。
- 不在应用内实现 HTTP CONNECT/SOCKS 出站代理；生产网络隔离由平台基础设施负责，缺失该能力时不得启用真实截图。
- 不抓取登录后页面、付费内容、个人账户数据或需要验证码的内容。
- 不使用 stealth 插件、代理轮换、验证码识别或其他反访问控制手段。
- 不让 LLM 提供或执行任意 JavaScript。
- 不把 AI 生成的竞品界面图当作事实证据。
- 不把站点图片 URL 直接写入最终报告进行热链展示。
- 不从定性文字自动生成看似精确的竞品评分、趋势或市场份额图。
- 不恢复 Legacy execute、resume 或 Legacy 新写路径。
- 不修改 ResearchDeliverable Envelope 版本，不增加数据库表。

## 5. 现有系统约束

本方案必须保持以下项目规则：

- Current 是新任务唯一写路径，Legacy 保持只读。
- 事实证据必须绑定 `SEALED` Artifact，URL 标注本身不能替代 Artifact 绑定。
- Tavily 是 `core` Tool，公开来源要求仍由它满足；Playwright 是 `optional` Tool，失败不能抹掉已有文本证据。
- Fake Tool、Mock LLM 和演示 fixture 不能作为真实任务成功证据。
- 模型、Evidence、Artifact 哈希或来源绑定发生漂移时必须 fail closed。
- 长期 Artifact 不保存完整提示词、密钥、Bearer token、未脱敏 Tool 输出或图片 Base64。
- Web 报告只读取已通过 owner 校验和 checksum 校验的 Current Report Package。
- 实施开始前必须重新确认工作树和目标文件 diff；不得用 reset、checkout 或整文件覆盖清理用户改动。

## 6. 总体架构

```text
┌──────────────────── Current Plan ────────────────────┐
│ Step 1  tavily-web-search                            │
│    output.results[]                                  │
│           │ sealed binding: /results -> /pages       │
│           v                                          │
│ Step 2  playwright-page-capture (optional)           │
│    output.captures[] + in-memory mediaAttachments[]  │
│           │                                          │
│           v                                          │
│ Step 3  competitive-web-research Skill               │
│    reads verified text and capture metadata          │
│           │                                          │
│           v                                          │
│ Step 4  reviewer, when present                       │
└───────────────────────┬──────────────────────────────┘
                        │
          ┌─────────────v─────────────┐
          │ BrowserExecutionGate      │
          │ 2 active / 8 queued       │
          │ lease + deadline abort    │
          └─────────────┬─────────────┘
                        │
          ┌─────────────v─────────────┐
          │ LeaseExecutionEngine      │
          │ seal Tool JSON first      │
          │ materialize media second  │
          │ publish step last         │
          └─────────────┬─────────────┘
                        │
       ┌────────────────v────────────────┐
       │ ControlArtifactStore            │
       │ tool_output.json                │
       │ visual_asset binary             │
       │ visual_asset_manifest.json      │
       │ evidence/manifest.json          │
       └────────────────┬────────────────┘
                        │
          ┌─────────────v─────────────┐
          │ Deliverable and Review    │
          │ visualEvidence[]          │
          │ screenshotComparisons[]   │
          │ verified charts           │
          └─────────────┬─────────────┘
                        │
          ┌─────────────v─────────────┐
          │ ReportDocument and Web    │
          │ image, comparison, chart  │
          │ history and export        │
          └───────────────────────────┘
```

架构没有环。Playwright 不调用 Tavily，VisualAssetService 不做研究判断，报告生成器不访问外网，Web 不读取临时截图。

## 7. 关键技术决策

### 7.1 Playwright 直接运行在 Node Worker

新增 `PlaywrightPageCaptureAdapter`，由现有 `ToolRouter` 按 `adapter_type: playwright` 分发。每次 Tool 调用启动一个 Chromium Browser，在同一 Browser 中创建隔离 Context，调用结束后在最外层 `finally` 中关闭。首版不维护跨任务 Browser 池，不复用 Cookie、localStorage 或登录状态。

`agent-runtime.ts` 模块惰性持有一个进程级 `BrowserExecutionGate`，所有生产 `buildRuntime()/buildToolAdapter()` 调用复用它；测试可显式注入独立 Gate，禁止每个 Runtime 实例各建一套配额。固定上限为 2 个活跃 Browser、8 个排队调用和 10 秒排队等待；队列已满或等待超时抛出 `ToolInvocationError(kind='capacity', retryable=true)`。配额从排队开始计入 90 秒 Tool 总时限；未启动 Browser 或已确认 Browser 断连时释放，断连无法确认时隔离槽位并要求 Worker 重启。

Engine 在 Tool step 开始时创建一个非持久化的 `ToolExecutionScope`，其中只有 `signal`、`deadlineAt` 和清理回调。该 Scope 一直存活到 execution step 成功持久化且 Publication Group commit，或失败补偿结束；不能在 Adapter 返回时提前销毁。`ToolAdapter.invoke()`、`ToolRouter.invoke()`、`invokeWithRetry()`、`runTool()` 和后续媒体发布使用同一 Scope。`withLeaseHeartbeat()` 在心跳失败时以稳定 reason `lease_lost` 立即 abort，90 秒 timer 以 `deadline_exceeded` abort 同一信号；取消原因不得都压成 timeout，否则租约丢失会被错误降级。两次尝试、退避、排队、页面处理、JSON 封存和媒体封存共享该 deadline，不允许每次尝试重新计时。

Browser 操作必须真正监听 `AbortSignal`。现有 Artifact Store 写入不强行增加伪取消接口：每次不可中断的写入返回后立刻复核 Scope；若已 abort，先把刚返回的 Artifact 加入 Publication Group，再走补偿，绝不把超时后的写入发布为成功。

只有 `PLAYWRIGHT_CAPTURE_ENABLED=1` 时 `buildToolAdapter()` 才注册该 Adapter。变量未设置时 Tool 仍可在 Registry 中保持 `active`，但 Capability Resolution 将其标记为 unavailable optional；计划仍可记录该增强缺口，不能拒绝文本 Skill。

该实现增加一个 Node 依赖和一个浏览器运行包，不增加新进程管理协议、常驻服务或对外网络端口。

### 7.2 Tavily 结果通过显式绑定进入截图 Tool

静态计划生成时不知道 Tavily 最终返回哪些 URL。截图步骤不得由 LLM 预填虚构 URL，也不得在 Adapter 内做语义搜索。计划使用现有 `input_bindings`：

```json
{
  "target_pointer": "/pages",
  "source_step_no": 1,
  "source_pointer": "/results"
}
```

`pages` 接收 Tavily 已验证输出数组。Adapter 只做 URL 标准化、去重、保留原顺序和数量截断。来源可信度、平台归属和报告采用判断由后续 `competitive-web-research` Skill 完成。

`competitive-web-research.required_tools` 保持为 `tavily-web-search`，新增 `optional_tools: [playwright-page-capture]`。`CapabilitySkillRegistryEntry`、Skill Registry Schema、Loader、Registry Linter 与 Capability Resolution 同步增加该字段：

- required Tool 缺失、不健康或无真实适配器时仍拒绝 Skill。
- `optional_tools` 只能引用 Registry `tier: optional` 的 Tool，且不能与同一 Skill 的 required 列表重复。
- Registry 为 `draft` 的 optional Tool 既不进入计划也不制造 gap；它尚未成为产品承诺，因此工作包 C 合入但未激活时旧任务状态不变。
- Registry 为 `active` 的 optional Tool 不健康或未注册 Adapter 时不得拒绝 Skill，Resolution 记录 `unavailable` 及原因并写入 `capability_gaps`。
- 只有 active 且 available 的 optional Tool 才进入候选计划；若规划后发生 Adapter 漂移，执行期统一转换为可降级的 `ToolInvocationError(configuration)`，不能抛出阻断整轮的 `ExecutionAuthenticityError`。

Plan Compiler 继续要求 Tavily 早于 Skill；当计划包含 Playwright 时，截图步骤必须依赖更早的 `tavily-web-search`，使用上述精确绑定，并早于 Skill。Direct Skill 计划按 Tavily、Playwright、Skill 的顺序构建；Playwright unavailable 时按 Tavily、Skill 构建，并把 unavailable 原因写入冻结计划的 `capability_gaps`，执行开始时进入任务 gap 集合。

新增计划字段采用向后兼容合同，不升级 Current Plan 版本，也不使历史冻结计划失效：

```ts
interface CurrentOptionalToolDecision {
  tool_id: string;
  status: 'available' | 'unavailable';
  reason_code?:
    | 'optional_tool_health_unknown'
    | 'optional_tool_unhealthy'
    | 'optional_tool_real_adapter_unavailable';
  message?: string;
}

interface CurrentCapabilityGap {
  capability_type: 'tool';
  capability_id: string;
  code: Exclude<CurrentOptionalToolDecision['reason_code'], undefined>;
  message: string;
}
```

- `CurrentCapabilitySkill.optional_tools`、`CurrentCapabilityDecision.optional_tool_decisions` 和 `CurrentExecutionPlan.capability_gaps` 在读取 Schema 中均为可选，历史计划缺失时统一规范化为 `[]`。
- 新 Plan Compiler 必须显式写出这三个数组；`optional_tool_decisions` 只记录 Registry 为 `active` 的 optional Tool，且 unavailable 项必须有 `reason_code` 和脱敏 `message`。
- available 决策不得带 reason；每个 unavailable 决策必须与一个同 code、同 capability ID 的 `capability_gaps` 项一一对应。draft/deprecated optional Tool 不产生 decision 或 gap。
- `capability_gaps` 只进入执行缺口集合，不伪造 execution step。历史页的 gapCount 按“冻结计划 capability gap + execution toolProvenance.gapSummary”去重计算；无 summary 的旧 skipped step 才回退计 1。

执行期不能只调用当前的 `SkillLoader.getTool()`，因为它会隐藏已经回滚为 draft 的 Tool。Loader 增加只供冻结计划校验的 `getRegisteredTool()`，返回任意 Registry 状态但不参与自动路由。Engine 从冻结计划的 `optional_tool_decisions` 建立 optional Tool 集合：已计划的 optional Tool 后来变为 draft、Adapter 未注册或环境变量取消时，仍能读取其 Manifest 并转换为 `ToolInvocationError(configuration)` 后 skipped；required Tool 或未被冻结 decision 授权的 Tool 发生同类漂移仍 fail closed。这样回滚既不污染新计划，也不会把已确认任务卡死。

### 7.3 二进制通过内存 sidecar 传递

当前 Tool Artifact 是 JSON。把截图 Base64 放进 JSON 会放大体积、重复编码，并让脱敏、哈希和日志路径都承担二进制。方案扩展 Tool 运行时返回值，字节只存在于内存：

```ts
export interface ToolInvocationContext {
  signal: AbortSignal;
  deadlineAt: number;
}

export interface ToolMediaAttachment {
  attachmentId: string;
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  contentSha256: string;
  sourcePageUrl: string;
  capturedAt: string;
  captureMode: 'extracted_image' | 'element_screenshot' | 'full_page_screenshot';
  selector?: string;
  viewport: { width: number; height: number };
  width: number;
  height: number;
}

export interface ToolInvokeResult {
  output: object;
  latencyMs: number;
  receipt: ToolInvocationReceipt;
  mediaAttachments?: ToolMediaAttachment[];
}
```

Tool JSON 只保存 `attachment_id`、`content_sha256`、获取元数据和页面失败列表。页面失败只有一个真相源：成功调用的 `output.failures`；不再另设内存 `gaps` 副本。`ToolAdapter.invoke` 接收 `ToolInvocationContext`；`invokeWithRetry`、`ToolRouter`、`StepResult` 必须原样保留最后一次成功调用的 `mediaAttachments`，不得 structured clone、JSON stringify 或遗漏该字段。失败尝试的附件引用必须在下一次尝试前释放。

`ToolMediaAttachment.sourcePageUrl` 固定等于规范化的 `captures[].requested_url`，用于绑定 Tavily 原始来源；重定向后的 `captures[].final_url` 只从已封存 Tool JSON 读取。两者不得互换，否则发生重定向时截图将无法与原始 public source Evidence 对齐。

部分页面成功时，Engine 只在 Publication Group commit 后把已封存 Tool JSON 的 `output.failures` 映射为任务 gaps。全部页面失败时 Adapter 抛出带脱敏 `details.page_failures` 的 `ToolInvocationError`，Engine 记录 optional step 为 `skipped` 并从该字段生成逐页 gaps。两条路径都不得在 Artifact 发布结果确定前修改任务 gap 集合。

为了让历史任务恢复出相同的 gapCount，execution step 的 `toolProvenance` 增加只读索引 `gapSummary={count, keys, failuresHash}`：`keys` 只含 `source_result_index:code`，`failuresHash` 必须等于成功 Tool JSON failures 或失败错误 details 的规范化哈希。它不保存 URL、message，也不是第二份失败内容；历史页只用它计数，审计或报告仍以 Tool Artifact/失败记录为真相源。无逐页明细的普通 optional skip 使用一个 step 级 key。

### 7.4 浏览器截图使用独立来源类型

`tool_artifact` 继续表示从 Tool JSON 中的远程图片 URL 下载并封存。浏览器已经产生了最终字节，不应再伪装成远程下载。`VisualAssetSourceV2` 增加 `browser_capture`：

```ts
type BrowserCaptureSource = {
  kind: 'browser_capture';
  artifactId: string;
  artifactContentSha256: string;
  jsonPointer: string;
  attachmentId: string;
  sourcePageUrl: string;
  finalUrl: string;
  pageTitle: string;
  capturedAt: string;
  captureMode: 'extracted_image' | 'element_screenshot' | 'full_page_screenshot';
  selector?: string;
  viewport: { width: number; height: number };
};
```

其中 `artifactId` 指向本次 Playwright Tool JSON Artifact，`jsonPointer` 指向 `/output/captures/<index>`。该来源只允许写入 `visual-asset-manifest-v2`。Manifest 顶层的 `contentSha256` 必须同时等于 Tool JSON 中的 `content_sha256`、sidecar 字节哈希和 Binary Artifact 哈希。

### 7.5 单图证据与对比图分开建模

竞品报告新增可选字段 `visualEvidence`。字段在 JSON Schema 中保持可选以兼容旧报告，新生成的严格 V2 竞品报告由服务层强制产出该数组：

```ts
interface CompetitiveVisualEvidence {
  id: string;
  sampleIds: string[];
  dimension: string;
  assetId: string;
  evidenceIds: string[];
  caption: string;
}
```

`visualEvidence` 展示单张真实网页或 App 截图。`screenshotComparisons` 只用于确实存在原图与标注图 lineage 的场景，不再因为 Visual Asset 非空就强制生成对比图。

每个 `visualEvidence` 必须同时引用：

- 一个与 `assetId` 精确绑定的 `screenshot` Evidence。
- 一个 `sourceUrl` 与 Manifest `sourcePageUrl` 一致的 `public_source` Evidence。

服务层还必须校验 `sampleIds` 全部存在于 `competitorSamples[].id`，`dimension` 精确匹配 `dimensionMatrix[].dimension`，同一 `assetId` 在该章节最多出现一次。引用漂移直接拒绝 Deliverable，不能靠 caption 猜测修复。

CurrentDeliverableService 先按双 Evidence 和来源元数据得到 displayable inventory。该 inventory 非空时，新生成的严格竞品报告必须至少选择一张 `visualEvidence`；LLM 返回空数组触发受控重试而不是静默产出纯文本。inventory 为空时允许空数组，但 Engine 必须已有对应视觉 gap。

报告中的 Image Block 增加可选 `evidenceIds`，新报告必须写入。Web 在图片下方显示证据开关，Markdown 导出在图片说明后输出证据编号。

### 7.6 图表绑定结构化数据，不绑定无关图片

`VisualAssetSourceV2` 增加 `chart_render`：

```ts
type ChartRenderSource = {
  kind: 'chart_render';
  dataArtifactId: string;
  dataArtifactContentSha256: string;
};
```

`chart_render` 的 `derivedFrom` 为 `null`，`derivation` 仍为 `chart_svg`，并保留 `chartId` 与 `specHash`。该组合只属于 `visual-asset-manifest-v2`。`renderAndSealChartSvg` 改为接收已封存 Chart Data Artifact，不再接收 `original: VisualAssetReference`，并调用 `VisualAssetService.sealChartRender()`，不能再走 `derive()`。

本次只保证用户确认或计划冻结的评分权重图。测试任务没有指定权重时，候选计划在展示前就把五个明确维度的等权方案写入 `actor_id=competitive-web-research` Skill step 的 `input.scoring_weights`。前端从该字段只读渲染“每项 20%”的可确认假设，不再维护第二份可编辑 assumption；点击确认只冻结当前计划，确认 API 不改写权重。用户若修改权重，必须通过“重新生成计划”得到再次可见的新候选。`extractCompetitiveScoringWeights()` 只读取冻结计划中该唯一 step 的 `/input/scoring_weights`，删除对整个 Plan、Structured Task 和自然语言的递归扫描。图表标题改为“对比维度评分权重 / Comparison-dimension Weights (%)”，不再写死六维度。没有冻结权重时不生成该图。

### 7.7 Visual Asset Manifest 版本迁移

现有 `visual-asset-manifest-v1` 的 TypeScript 类型、JSON Schema 和严格解析规则保持不变。新增 `VisualAssetManifestV2` 与 `schemas/visual-asset-manifest-v2.schema.json`：

- V1 继续支持 `tool_artifact`、`user_upload` 和 `derived`，并保留“只有 derived 才能有 lineage/derivation”的原规则。
- V2 增加 `browser_capture` 和 `chart_render`；`browser_capture` 必须 `derivedFrom=null`、`derivation=null`，`chart_render` 必须 `derivedFrom=null`、`derivation.kind=chart_svg`。
- `VisualAssetManifest` 成为 V1/V2 判别联合；Artifact 的 `schemaVersion` 必须与正文 `version` 精确一致。
- `readVerified()`、Current Report Package Reader、API 与 Web 解析器同时接受 V1/V2，一个 Report Package 可以包含混合版本 Manifest。
- 发布顺序固定为 Reader-first：先发布只读 V2 能力且 Writer 仍关闭，确认旧报告可读后，再启用 V2 Writer。回滚只能关闭 Writer，不能撤回 V2 Reader。

## 8. Tool 输入与输出合同

### 8.1 输入

`tools/playwright-page-capture/input.schema.json` 接受：

```json
{
  "pages": [
    {
      "title": "来源标题",
      "url": "https://example.com/page",
      "snippet": "Tavily 摘要",
      "score": 0.91,
      "published_date": "2026-07-30"
    }
  ],
  "capture": {
    "mode": "auto",
    "selector": null,
    "max_pages": 6,
    "viewport": { "width": 1440, "height": 900 }
  }
}
```

约束如下：

- `pages` 最多接收 20 条 Tavily 结果，Adapter 最多访问前 6 个去重后的 HTTPS URL。
- `mode` 支持 `auto`、`extracted_image`、`element_screenshot`、`full_page_screenshot`。
- `element_screenshot` 必须提供 CSS selector，长度不超过 512 字符。
- `auto` 优先截取 `main`、`article` 或主内容区域，找不到时截取受高度限制的整页。
- `extracted_image` 使用 Adapter 内置的固定 DOM 评分逻辑选择可见大图。调用者不能传 JavaScript。
- 视口宽度限制为 1024 至 1920，高度限制为 720 至 1200。

### 8.2 JSON 输出

```json
{
  "captures": [
    {
      "attachment_id": "capture-1",
      "source_result_index": 0,
      "requested_url": "https://example.com/page",
      "final_url": "https://example.com/page",
      "page_title": "Example",
      "captured_at": "2026-08-19T08:00:00.000Z",
      "capture_mode": "element_screenshot",
      "selector": "main",
      "viewport": { "width": 1440, "height": 900 },
      "media_type": "image/png",
      "width": 1200,
      "height": 1800,
      "byte_size": 456789,
      "content_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "truncated": false
    }
  ],
  "failures": [
    {
      "source_result_index": 1,
      "requested_url": "https://example.com/blocked",
      "code": "captcha_required",
      "sanitized_message": "page requires human verification"
    }
  ],
  "security_profile": "browser-controls-v1"
}
```

JSON 输出不含页面 HTML、Cookie、请求头、浏览器日志、图片字节或临时路径。每个 `failures[]` 项固定包含 `source_result_index`、规范化 `requested_url`、稳定错误码和最长 300 字符的脱敏信息；不得包含响应正文或上游异常对象。因凭据型 query 被拒绝时，`requested_url` 只能保留 origin + pathname，整个 query 丢弃。`captures[].source_result_index` 与 `failures[].source_result_index` 不能重复，同一输入页只能有一个终态。`security_profile` 是固定枚举，只标记 Adapter 使用了显式 sandbox 与 Service Worker/WebSocket 阻断配置，不声称它能证明基础设施 egress policy；后者只能由发布证据证明。

### 8.3 数量与资源上限

- 每次 Tool 调用最多访问 6 页。
- 每页默认生成 1 个资产。
- 单个资产最大 10 MiB。
- 单次调用的媒体 sidecar 总量最大 40 MiB。
- 整页高度最大 12,000 像素，总像素不超过 20,000,000。
- 单个 Browser 内页面并发数为 2；整个 Worker 最多 2 个活跃 Browser、8 个排队调用。
- 每个 Browser Context 最多处理 256 个 HTTP(S) 请求；超过预算的请求在再次解析 DNS 或访问网络前阻断。
- 同一 host 只合并当前正在进行的 DNS 解析；解析完成或失败后立即移除合并项，后续请求必须重新解析，不能把首次结果当作 Context 级缓存。
- 单页超时 20 秒；Tool 总时限为 90 秒，覆盖排队、最多 2 次尝试、退避、页面处理、JSON 封存和媒体封存，不按重试重新计时。
- 排队超过 10 秒或队列已满返回 `capacity`；该错误可重试，但仍受同一 90 秒 deadline 约束。
- 超限页面可以记录 `truncated: true`，不得静默缩减后仍声称完整整页。

## 9. 浏览器执行与安全边界

### 9.1 浏览器隔离

- 每次调用使用新的无痕 Browser Context。
- `chromium.launch({ chromiumSandbox: true })` 必须显式设置；禁止依赖 Playwright 默认值，禁止失败后用无沙箱重试。
- 生产 Worker 必须以非 root 用户运行；Linux 沙箱所需 user namespace/seccomp 能力由部署前置检查验证。
- Context 固定 `serviceWorkers: 'block'`、`acceptDownloads: false`，不授予任何权限。
- 不加载用户 Chrome Profile，不读取现有登录状态。
- 禁止下载、通知、摄像头、麦克风、地理位置和剪贴板权限。
- 禁止弹窗接管主流程，新窗口立即关闭并记录 gap。
- 不点击 Cookie 弹窗、登录按钮、购买按钮或页面内操作控件。
- `browserContext.routeWebSocket('**/*', ...)` 在页面创建前注册并关闭全部 WebSocket；不能只依赖 HTTP route。
- 调用完成、异常、deadline 到期或租约丢失时都必须尝试关闭 Page、Context 和 Browser；只有确认 Browser 已断连后才释放 `BrowserExecutionGate` 租约。
- 正常清理顺序固定为 Page、Context、Browser。业务 deadline 或租约终止后允许最多 5 秒的故障清理窗口；该窗口只能关闭资源，不能继续导航、截图、重试或发布 Artifact。
- Browser 未确认断连时不得释放 Gate 租约，槽位保持隔离；迟到的 `disconnected` 事件可以释放槽位。若 Browser 永不 settle，外部 Worker supervisor 必须重启进程，当前调用只返回 `recovery: restart_worker`，不能在进程内假装清理成功。

### 9.2 网络安全

顶层 URL 必须同时满足以下条件：

- URL 精确来自更早的、已封存的 Tavily Tool 输出。
- 协议为 HTTPS、端口为 443 或省略，无用户名和密码字段。
- 顶层 URL 或重定向 URL 带 fragment 时直接拒绝并记录页面 gap，不得静默移除后导航到另一资源；查询参数名按 `(^|[_-])(token|key|signature|authorization|password|session|credential)([_-]|$)`（大小写不敏感）命中时拒绝，避免把临时访问凭据写入长期 Manifest。
- 主机解析结果不包含 loopback、RFC 1918、link-local、CGNAT、组播或保留地址。
- 每次重定向和每个 HTTP(S) 子资源请求都重新执行协议、端口与地址检查；任何非 HTTPS 网络请求均阻断。
- `file:`、`ftp:`、`data:` 顶层导航、WebSocket 和非 GET、HEAD 请求全部阻断。

实现把 `VisualAssetService` 当前的公网地址判断提取为小型共享模块，浏览器路由和远程图片下载复用同一份地址分类规则。远程图片下载继续使用现有 DNS/IP pinning；Playwright route 只能在放行前检查 DNS，不能保证 Chromium 最终连接到同一 IP，因此不得把 route 描述为 SSRF 最终边界。

生产启用的硬条件如下：

1. 平台基础设施通过 Worker namespace、VPC/security group 或等价 egress policy 阻断 IPv4/IPv6 私网、loopback、link-local、CGNAT、保留地址和云元数据地址。
2. Worker 以非 root 用户运行，Chromium `chromiumSandbox: true` 启动检查通过。
3. 部署配置才设置 `PLAYWRIGHT_CAPTURE_ENABLED=1`。开发机、普通 GitHub-hosted runner 和未知网络环境保持未设置，不能执行真实公网截图。
4. 平台负责人在发布记录中附出站策略与运行用户证据；缺任一证据时 Tool 保持 `draft`，真实任务只走文本路径。

CI 的 Adapter 网络策略测试使用注入的 Browser/route/DNS，不发真实请求。真实 Chromium contract 只启动 sandbox Browser，以 `about:blank` + `page.setContent()` 渲染内存 fixture 并调用同一截图 primitive；禁止为测试放开 loopback。真实视觉 Smoke 只能在满足上述四项的生产 Worker 或等价受保护 Runner 上运行。本次明确拒绝“仅靠 route DNS 检查”以及“在应用内自建 CONNECT 代理”两种方案。

### 9.3 访问控制与内容边界

遇到以下页面时不绕过，记录稳定失败码：

- `login_required`
- `captcha_required`
- `paywall`
- `robots_or_terms_blocked`
- `navigation_timeout`
- `no_capture_target`
- `unsupported_content`

公开页面可能包含动态广告或地区差异。截图只证明获取时刻看到的页面状态，报告不能把一次截图扩写为长期稳定事实。

## 10. 媒体封存事务

本次使用补偿式发布事务，不声称文件系统与数据库之间存在分布式 ACID 事务。

### 10.1 成功时序

1. Adapter 返回 JSON、媒体 sidecar 和 receipt；部分页面失败只存在于 JSON `failures`。
2. 运行时校验 Tool JSON Schema、脱敏策略、attachment ID 唯一性、字节哈希和数量上限。
3. Engine 创建 `ArtifactPublicationGroup`，写入并复核 `steps/<stepNo>-tool_output.json`，立即登记 Tool Artifact ID。
4. Engine 逐个调用 `VisualAssetService.ingestBrowserCapture()`；Service 重新读取 Tool Artifact，通过 `/output/captures/<index>` 取出元数据。
5. VisualAssetService 比较 attachment ID、URL、媒体类型、尺寸、字节数和 SHA-256，写入 Binary Artifact 与 `visual-asset-manifest-v2`，并立即 `readVerified()`。
6. 每个成功返回的 Binary/Manifest ID 立即加入同一 Publication Group；任何附件失败都停止后续封存。
7. 全部附件完成后，Engine 记录 execution step `succeeded`。只有持久化复核确认成功，Publication Group 才 `commit()`。
8. commit 后 Engine 才把步骤输出加入下游 `outputs`，把视觉资产加入截图 Evidence inventory，并把已封存的 `output.failures` 转换为任务 gaps。
9. Engine 清空 sidecar 字节引用；长期状态只保留已封存 Artifact 和 JSON 元数据。

### 10.2 失败补偿

`ArtifactPublicationGroup` 维护去重且有序的 Artifact ID 集合，并提供 `track()`、`commit()` 和 `compensate()`。它不是数据库事务，也不创建新表。如果第 3 至第 7 步任一步失败：

- 所有已写入的 Tool JSON、Binary Artifact 和 Visual Asset Manifest 都调用 `invalidateArtifactPublication()`。
- execution step 记录失败，不向后续 Skill 暴露该批输出。
- `compensate()` 可以并行尝试全部失效，但必须检查每个结果；任一失败都抛出包含失败 Artifact ID 的 `ArtifactInvalidationError`，任务暂停为 `artifact_invalidation`，由 recovery 处理，不能降级成普通截图缺口。
- `recordExecutionStep` 提交结果不明确时，沿用现有持久化复核，再决定是否失效，避免把已经发布的成功步骤误删。

`VisualAssetService.invalidate()`、`persist()` 的 catch 路径和 `chart-renderer` 不得继续用未检查的 `Promise.allSettled()` 吞掉失效错误。Service 负责 Binary 与 Manifest 对内的补偿并冒泡失败；Engine 的 Publication Group 负责 Tool JSON 和多个已完成 Visual Asset 对的外层发布边界。

### 10.3 取消与恢复边界

- deadline 或租约信号在 Adapter 运行期间触发时，先关闭 Page/Context/Browser，再释放 Browser 配额；未产生 Tool Artifact，不需要补偿。
- Tool JSON 已封存后触发取消时，Publication Group 补偿全部已登记 Artifact；补偿失败转 `artifact_invalidation`。
- Artifact Store 写入本身不可中断时，返回的 Artifact 必须先登记再复核 signal；已经 abort 的 Scope 只能补偿，不能继续发布。
- execution step 已确认 `succeeded` 后触发的迟到取消不能回滚该步骤，由后续 attempt/terminal recovery 按现有租约合同处理。
- Recovery 扫描中断 attempt 时继续失效全部视觉复合 Artifact；`chart_data` 加入该集合。所有带 `input_bindings` 的截图步骤仍禁止 checkpoint 复用。

## 11. Evidence 与报告生成

### 11.1 截图 Evidence

每张已验证浏览器截图新增一条 Evidence：

```ts
{
  id: `BC${stepNo}-${captureIndex}`,
  kind: 'screenshot',
  evidenceClass: 'screenshot',
  toolId: 'playwright-page-capture',
  toolTier: 'optional',
  artifactId: manifestArtifact.id,
  artifactContentSha256: manifestArtifact.contentSha256,
  jsonPointer: '/assetId',
  sourceUrl: manifest.source.sourcePageUrl,
  stepNo,
  sensitivity: 'public',
  redaction: 'none'
}
```

截图 Evidence 不替代 Tavily `public_source` Evidence。事实结论仍需引用公开来源；截图用于证明页面呈现和案例状态。required evidence 仍由 `core` Tool 满足。

### 11.2 视觉资产角色

竞品报告将以下无派生 lineage 的来源识别为 `original`：

- `user_upload`
- `tool_artifact`
- `browser_capture`

`derived + annotation` 仍识别为 `annotation`。`chart_render + chart_svg` 进入 chart inventory，不进入原图与标注图角色判断。

`original` 只是视觉 lineage 角色，不等于可以进入单图证据。`visualEvidence` 仍必须满足 7.5 的 screenshot + public_source 双 Evidence；普通用户上传若没有公开来源绑定，只能用于现有输入溯源/对比合同，不能伪装成竞品事实图片。

`design_audit_report` 继续要求精确的原图与 finding-bound 标注图配对。只有 `competitive_analysis_report` 放宽为可直接使用单张 original，不能把该规则扩散到设计走查。

### 11.3 ReportDocument

竞品报告的 Visual Evidence 章节按以下顺序组成：

1. 解释本章内容和用途的 paragraph Block。
2. `visualEvidence` 生成的单图 Block。
3. 有精确 lineage 的 `screenshotComparisons` 对比 Block。
4. 已验证的 Chart Block 和可访问数据表。

每张图片显示 caption、获取时间、来源域名和证据编号。标题与目录继续使用中英文，章节开头继续输出该模块的内容与目的说明。没有已验证图片时，本章显示缺口说明，不展示占位图或 AI 生成图。

上述版式不是交给 LLM 自由发挥：`ReportDocumentComposer` 为竞品报告输出固定的“中文 / English”章节标题，目录复用同一标题；每章第一个 Block 必须是说明该章内容与决策用途的 paragraph。Dimension Matrix 按维度合并各平台值、证据和综合差异，每个维度只生成一个整合 Block，另生成一个跨维度总结，禁止把每个单元格拆成零散段落。

交给报告 LLM 的视觉 inventory 只包含已验证字段：`assetId`、来源类型、`sourcePageUrl`、`finalUrl`、`pageTitle`、`capturedAt`、`captureMode`、尺寸和匹配的 Evidence IDs，不传图片 Base64。首版只依据 Tavily 文本与这些来源元数据选择图片和写 caption，不声称模型已理解截图像素；图片内容是否真正支持相邻结论由第 17 节人工验收复核。若元数据不足以安全归类，图片不进入报告并形成视觉缺口。

### 11.4 历史任务与导出

现有 Report Package 和资产读取 API 继续使用，不新增路由。需要扩展服务端和 Web 对 V2 `browser_capture`、`chart_render` 的严格来源解析：

- V1 历史报告继续按原 Schema 读取；V2 Reader 同时接受混合 V1/V2 Manifest 集合。
- 新报告图片只通过 `/api/control-tasks/:taskId/assets/:assetId` 读取。
- Markdown 和打印导出使用包内资产路径，不保留原站热链。
- Image Block 的 `evidenceIds` 进入安全导出和 Markdown。
- 任务 owner 校验、Artifact checksum 和 exportPolicy 继续生效。

## 12. 图表修复

### 12.1 数据来源

评分权重只从冻结计划中 `actor_id=competitive-web-research` 的唯一 Skill step `/input/scoring_weights` 读取。若没有该 step、存在多个同 actor step、字段不是对象、维度少于 2、数值非正数或总和不等于 1/100，则不生成图表并记录明确原因；禁止退回 Structured Task、自然语言或任意 `*_weights` 字段。

通过校验的权重先写入 `chart_data` Artifact，再创建对应的 `user_input` Evidence。Chart Spec 每个数值仍必须引用该 Evidence，数值与已解析 Evidence 不一致时拒绝生成。图表生成不再要求任何用户上传图片或网页截图存在。

### 12.2 发布顺序

1. 创建独立 `ArtifactPublicationGroup`，封存并登记 Chart Data Artifact。
2. 创建并校验 Chart Evidence。
3. 生成 Chart Spec 与 `specHash`。
4. 服务端 ECharts 渲染 SVG。
5. VisualAssetService 通过 `sealChartRender()` 以 V2 `chart_render` 来源封存 SVG 和 Manifest，并把两个 ID 登记到 Group。
6. 封存并登记 `verified-chart-v1` Chart Spec Artifact。
7. ReportCompositionService 复核 data Artifact 哈希、specHash、表格与 SVG Manifest；成功后 commit Group。

Chart 任一步失败时，Chart Data、SVG、Manifest 和 Chart Spec 作为同一发布组失效。渲染器不可用、无冻结权重等预期增强失败形成 gap，文字报告继续；哈希、Evidence、来源或补偿不一致属于完整性失败，任务暂停。补偿失败始终转 `artifact_invalidation`，不能降级成图表 gap。

### 12.3 明确边界

本次不从 `dimensionMatrix[].score` 自动画竞品排名图。该 score 可能是研究综合判断，不是来源页中的直接测量值。只有未来存在明确评分方法、数据 Artifact 和派生 Evidence 合同时，才允许进入图表。历史 V1 `derived + chart_svg` 继续可读，但所有新图表只写 V2 `chart_render`。

## 13. 失败、重试、恢复与降级

| 场景 | 步骤状态 | 任务结果 | 处理 |
|---|---|---|---|
| Registry 为 active 的 Playwright optional capability 在规划时 unavailable | 不生成截图 step，写 `capability_gaps` | `completed_with_gaps` | 继续 Tavily、Skill 与文本报告；draft/deprecated 不制造 gap |
| Browser 队列已满或等待超过 10 秒 | optional Tool 重试后 `skipped` | `completed_with_gaps` | 返回 capacity gap，不突破并发上限 |
| 部分页面因登录、验证码或超时失败，至少一张成功 | `succeeded`，Tool JSON 附 failures | `completed_with_gaps` | 封存成功图片，报告列出失败页面 |
| 所有页面均访问失败 | optional Tool `skipped` | `completed_with_gaps` | 继续文本 Skill 与报告 |
| Chromium 未安装、sandbox 启动失败或 Adapter 漂移 | optional Tool `skipped` | `completed_with_gaps` | 返回 configuration gap，不自动下载浏览器、不关闭 sandbox |
| 网络超时、浏览器崩溃 | 先重试 | 成功或 `completed_with_gaps` | 在同一 90 秒总 deadline 内最多 2 次，重试前关闭旧 Browser |
| Tool 输出 Schema 不合法 | `failed` | `paused` | 不重试，修复 Adapter 或合同 |
| sidecar 与 JSON 哈希不一致 | `failed` | `paused` | 作为完整性错误 fail closed |
| 视觉资产封存失败 | `failed` | `paused` | 失效整批 Artifact，允许任务级 retry |
| 任一 Artifact 补偿失效失败 | `failed` | `paused` | failure kind 固定为 `artifact_invalidation`，交 recovery |
| 租约丢失或总 deadline 到期 | `failed` 或 optional `skipped` | `paused` 或 `completed_with_gaps` | AbortSignal 触发浏览器清理；断连未确认则隔离 Gate 并要求 Worker 重启；租约丢失不可降级，普通 timeout 可降级 |
| 计划明确要求权重图但冻结权重缺失，或 Chart renderer 不可用 | system enhancement gap | `completed_with_gaps` | 不生成图表，文字报告继续；未要求图表时不制造 gap |
| Tavily core Tool 失败 | `failed` | `paused` | 沿用 core 基础设施失败语义 |
| 报告引用不存在的 Asset 或 Evidence | `failed` | `paused` | Deliverable 校验拒绝发布 |

`invokeWithRetry` 只返回最后一次成功调用的媒体 sidecar，并共享 Tool step 级 deadline。失败尝试产生的 Page、Context、Browser、队列租约和字节引用必须在下一次尝试前释放；若 Browser 断连无法确认，则以 safety 失败终止重试并隔离 Gate 槽位。

Engine 初始化任务 gap 集合时先加入冻结计划的 `capability_gaps`。部分成功 Tool 的 `output.failures` 只有在 Publication Group commit 后才加入；全部失败 Tool 的 `details.page_failures` 只有在 skipped execution step 持久化后才加入。发布失败的调用不得留下误报 gap。任务 gaps 按 `capability_id/code` 或 `stepNo/source_result_index/code` 去重，最终状态仍由统一的 `gaps.length > 0` 决定，因此“部分截图成功”必须稳定得到 `completed_with_gaps`。前端历史恢复用相同 key 合并计划 `capability_gaps` 和 execution `toolProvenance.gapSummary`，不得再以 skipped step 数近似 gapCount。

截图步骤有来源绑定，现有 checkpoint 逻辑本来就不会复用含 `input_bindings` 的 Tool 步骤。Plan Compiler 新增截图绑定硬门禁，测试固定这一不变量，不增加第二套 checkpoint 配置。

Recovery 的视觉复合 Artifact 集合增加 `chart_data`，并继续包含 V1/V2 `visual_asset`、`visual_asset_manifest`、`image_annotation` 和 `chart_spec`。`invalidateTerminalArtifacts()` 同步包含 `chart_data`。中断任务不得留下可被报告发现的孤立媒体。

## 14. 具体文件改动

### 14.1 依赖与 Tool

| 文件 | 改动 |
|---|---|
| `package.json` | 增加 Playwright 运行依赖和浏览器安装脚本，保持 Node `>=22` |
| `pnpm-lock.yaml` | 锁定 Playwright 依赖 |
| `.env.example` | 记录默认关闭的 `PLAYWRIGHT_CAPTURE_ENABLED`，不修改本地 `.env` |
| `apps/orchestrator-runtime/src/runtime/browser-execution-gate.ts` | 新增进程级 2 active / 8 queued / 10 秒等待门禁与可取消租约 |
| `apps/orchestrator-runtime/src/runtime/playwright-page-capture-adapter.ts` | 新增浏览器 Adapter、资源上限、固定 DOM 取图逻辑和清理逻辑 |
| `apps/orchestrator-runtime/src/runtime/public-web-access-policy.ts` | 提取公网 URL、DNS、重定向和私网阻断规则，供浏览器与远程图片下载复用 |
| `apps/orchestrator-runtime/src/runtime/tool-adapter.ts` | 扩展 AbortSignal、deadline、media sidecar 和 `capacity` 失败合同；不增加第二份 gap 状态 |
| `apps/orchestrator-runtime/src/runtime/agent-runtime.ts` | 仅在显式启用时注册带单例 Gate 的 `playwright` Adapter |
| `apps/orchestrator-runtime/src/runtime/config-loader.ts` | 增加 `playwright` adapter_type |
| `schemas/tool-manifest.schema.json` | 将运行时已有的 `rest_json`、`tavily` 与新增 `playwright` 一并写入枚举，消除当前 schema 漂移 |
| `orchestrator/tool-registry.yaml` | 注册 `playwright-page-capture`，`tier: optional`、`risk_level: medium` |
| `tools/playwright-page-capture/manifest.yaml` | 定义入口、90 秒超时、2 次重试、输入输出 Schema 和脱敏策略 |
| `tools/playwright-page-capture/input.schema.json` | 定义 Tavily pages 与截图策略 |
| `tools/playwright-page-capture/output.schema.json` | 定义 captures、failures 和哈希元数据 |
| `tools/playwright-page-capture/adapter.md` | 记录安装、边界和运行方式 |
| `tools/playwright-page-capture/examples/example-01.json` | 提供无图片字节的合同示例 |

### 14.2 Planning 与执行

| 文件 | 改动 |
|---|---|
| `orchestrator/skill-registry.yaml` | 为 `competitive-web-research` 增加 `optional_tools: [playwright-page-capture]`，required 仍只有 Tavily |
| `schemas/skill-manifest.schema.json` | 增加可选且去重的 `optional_tools` 字段 |
| `schemas/current-execution-plan.schema.json` | 增加向后兼容的 optional Tool decisions 与 `capability_gaps`；旧计划缺失字段仍合法 |
| `packages/api-contract/research-deliverable.ts` | 增加可选的 Current capability decision/gap 类型；保留 V1 类型并新增 V2 视觉判别联合与报告视觉引用 |
| `packages/api-contract/plan.ts`、`schemas/research-task-v2.schema.json` | 增加可选且保序的 `comparison_dimensions`，未明确维度时保持缺失，不创建默认值 |
| `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts` | 要求 Requirement Refinement 忠实提取明确比较维度，禁止自行补造 |
| `apps/orchestrator-runtime/src/runtime/skill-loader.ts` | 加载并规范化 `optional_tools`；增加不参与路由的 `getRegisteredTool()` 供冻结计划回滚校验 |
| `harness/linters/registry-linter.ts` | 校验 optional 引用存在、tier 必须为 optional、不得和 required 重复 |
| `apps/orchestrator-runtime/src/planners/capability-resolver.ts` | optional Tool 不否决 Skill，输出 available/unavailable 原因 |
| `skills/competitive-analysis/web-research/SKILL.md` | 明确文本来源、截图来源、单图证据和 gap 规则 |
| `orchestrator/prompts/router.md` | 说明 required 与 optional Tool 的计划语义 |
| `orchestrator/prompts/planner.md` | 约束 optional 截图步骤及 capability gap，不允许伪造 URL |
| `apps/orchestrator-runtime/src/planners/plan-strategy.ts`、`apps/orchestrator-runtime/src/planners/research-planning-service.ts` | 将当前用户修订指令送入 Current 候选上下文，避免重新生成时退回旧研究目标 |
| `apps/orchestrator-runtime/src/planners/routed-planner.ts` | 生成 Tavily 到 Playwright 的显式绑定、冻结评分权重；修复 Direct Skill 的 Tool 顺序 |
| `apps/orchestrator-runtime/src/planners/plan-compiler.ts` | 校验截图步骤来源/依赖/顺序、optional decisions 和可见权重合同 |
| `apps/orchestrator-runtime/src/control/control-planning-service.ts`、`apps/agent-api/src/control-runtime.ts` | 对 Current 候选启用同一冻结权重编译门禁 |
| `apps/orchestrator-runtime/src/control/tool-retry-policy.ts` | 传播统一 deadline/AbortSignal，只保留最后成功 sidecar，并重试 capacity |
| `apps/orchestrator-runtime/src/control/artifact-publication-group.ts` | 新增可跟踪、提交、补偿并冒泡失效错误的发布组 |
| `apps/orchestrator-runtime/src/control/lease-execution-engine.ts` | 实现取消传播、媒体发布组、截图 Evidence、capability/tool gap 汇总、gapSummary 索引与整批失效 |
| `apps/orchestrator-runtime/src/control/execution-recovery-service.ts` | 将图表数据和新视觉发布纳入恢复 |
| `database/control-plane.ts` | 终止任务时使 `chart_data` 等本次发布资产失效，不改表结构 |

### 14.3 Visual Asset、Chart 与报告

| 文件 | 改动 |
|---|---|
| `schemas/visual-asset-manifest.schema.json` | 保持 V1 Schema 不变 |
| `schemas/visual-asset-manifest-v2.schema.json` | 新增两种来源及精确 lineage/derivation 约束 |
| `apps/orchestrator-runtime/src/report/visual-asset-service.ts` | 增加 V1/V2 读取、`ingestBrowserCapture()`、`sealChartRender()` 和可观察补偿 |
| `apps/orchestrator-runtime/src/report/competitive-weight-chart.ts` | 删除递归权重发现，只读取冻结 Skill step 精确路径 |
| `apps/orchestrator-runtime/src/report/chart-renderer.ts` | 图表改为绑定 Chart Data Artifact |
| `apps/orchestrator-runtime/src/report/report-composition-service.ts` | 发现并复核浏览器图片和新图表来源 |
| `schemas/deliverables/competitive-analysis-report.schema.json` | 增加向后兼容的 `visualEvidence` |
| `apps/orchestrator-runtime/src/report/current-deliverable-service.ts` | 放宽竞品单图角色、校验图片与 Evidence 绑定、更新 LLM context |
| `apps/orchestrator-runtime/src/report/report-document-composer.ts` | 把 `visualEvidence` 组合为 Image Block，保留对比图严格 lineage |
| `schemas/report-document.schema.json` | Image Block 和 Comparison Block 接受可追溯 evidenceIds |
| `apps/orchestrator-runtime/src/report/current-report-package-reader.ts` | 读取时复核新来源类型和图表数据绑定 |

### 14.4 Web 与导出

| 文件 | 改动 |
|---|---|
| `apps/web/src/report-package-response.ts` | 严格解析 `browser_capture` 和 `chart_render` Manifest |
| `apps/web/src/reporting/report-document-view-model.ts` | 把图片证据编号送入 View Model |
| `apps/web/src/reporting/ReportDocumentView.tsx` | 在图片和对比图下展示证据开关 |
| `apps/web/src/reporting/report-bundle.ts` | 安全导出图片 evidenceIds 和本地资产路径 |
| `apps/web/src/components/stages/Stage2Plan.tsx` | 从冻结 Skill step input 只读展示评分权重，禁止维护会漂移的第二份表单值 |
| `apps/web/src/components/stages/stage2-plan-confirmation.ts` | 集中生成确认 payload，只提交已声明 PendingInput，禁止回传第二份权重副本 |
| `apps/web/src/current-flow-state.ts` | 增加历史 gapCount 纯函数：capability gaps 与 toolProvenance gapSummary 去重，旧 skipped step 仅作兼容回退 |
| `apps/web/src/hooks/useTaskFlow.ts` | 历史任务恢复时使用统一 gapCount，不再只数 skipped steps |
| `apps/agent-api/src/routes/control-tasks.ts` | 资产读取路由接受精确匹配的 V1/V2 Artifact schemaVersion |

### 14.5 CI、Smoke 与部署记录

| 文件 | 改动 |
|---|---|
| `.github/workflows/ci.yml` | 新增零网络 Playwright contract job：Node 22、安装 Chromium/deps、sandbox 启动与 page.setContent 内存 fixture 测试 |
| `tests/fixtures/current-semantic-gold.json` | 增加 `competitive-ai-shopping-assistant` 场景，原始输入与第 17 节逐字一致 |
| `scripts/current-real-smoke.ts` | 增加 `CURRENT_SMOKE_SCENARIO` 精确选择、browser capture、screenshot Evidence、chart render、gap、历史重读断言及脱敏 receipt |
| `tests/current-real-smoke.test.ts` | 固定视觉 Smoke 断言和未启用时的文本降级合同 |
| 发布记录 | 由平台负责人附非 root、sandbox 与 egress policy 证据；该记录不写密钥或网络拓扑细节 |

### 14.6 测试

新增：

- `tests/browser-execution-gate.test.ts`
- `tests/playwright-page-capture-adapter.test.ts`
- `tests/artifact-publication-group.test.ts`
- `tests/stage2-plan.test.ts`

并扩展：

- `tests/tool-retry-policy.test.ts`
- `tests/schema.test.ts`
- `tests/capability-resolver.test.ts`
- `tests/skill-loader-schema.test.ts`
- `tests/registry-linter.test.ts`
- `tests/plan-compiler.test.ts`
- `tests/current-plan-candidate-schema.test.ts`
- `tests/direct-invoke-plan.test.ts`
- `tests/current-step-bindings.test.ts`
- `tests/checkpoint-resume.test.ts`
- `tests/visual-asset-service.test.ts`
- `tests/competitive-weight-chart.test.ts`
- `tests/chart-renderer.test.ts`
- `tests/lease-execution-engine.test.ts`
- `tests/control-plane.test.ts`
- `tests/current-deliverable-service.test.ts`
- `tests/report-document.test.ts`
- `tests/report-package.test.ts`
- `tests/report-bundle.test.ts`
- `tests/candidate-layout.test.ts`
- `tests/current-flow-state.test.ts`
- `tests/control-planning.test.ts`
- `tests/current-revision-integrity.test.ts`
- `tests/execution-control.test.ts`
- `tests/execution-recovery.test.ts`
- `tests/requirement-refinement-service.test.ts`
- `tests/control-api-integration.test.ts`
- `tests/auth-isolation.test.ts`

## 15. 独立可合并工作包

依赖关系固定为 `A -> B -> C` 和 `B -> D`；C、D 在 B 后可互换顺序。这里的“独立可合并”指每个工作包在其前置包已合入后都保持主干可用、默认配置安全且验证完整，不依赖后续工作包补测试或修复半成品。

### 工作包 A：浏览器 Tool 与 sidecar 合同

完成 Playwright 依赖、`BrowserExecutionGate`、AbortSignal/deadline 传播、Adapter、Tool Schema、ToolRouter 条件注册、公网访问策略和零网络 CI contract job。Tool Registry 保持 `draft`，现有产品流程不调用它。该包合入后网络策略可通过注入 Browser/route/DNS 验收，截图 primitive 可通过真实 Chromium 的内存页面验收，默认环境仍不会启动 Chromium。

验证：

```bash
pnpm exec tsx --test tests/browser-execution-gate.test.ts tests/playwright-page-capture-adapter.test.ts tests/tool-retry-policy.test.ts tests/tool-provenance.test.ts tests/schema.test.ts tests/registry-linter.test.ts tests/visual-asset-service.test.ts tests/lease-execution-engine.test.ts
pnpm typecheck
pnpm lint:registry
```

### 工作包 B：原子视觉资产发布

完成不可变 V1 + 新 V2 Reader、`ArtifactPublicationGroup`、`browser_capture` Writer、VisualAssetService、Engine 媒体发布、截图 Evidence、API 读取、恢复和失败补偿。Registry 仍保持 `draft`，通过注入的 Tool StepResult + media attachments fixture 做 Engine 集成测试，不要求真实规划生成 Playwright step。该包先把 V2 Reader 部署到所有读取端，但没有普通任务会写 V2 浏览器资产。

验证：

```bash
pnpm exec tsx --test tests/artifact-publication-group.test.ts tests/visual-asset-service.test.ts tests/lease-execution-engine.test.ts tests/execution-recovery.test.ts tests/report-package.test.ts tests/report-bundle.test.ts tests/control-api-integration.test.ts tests/auth-isolation.test.ts
pnpm typecheck
pnpm --dir apps/web build
```

### 工作包 C：optional Planning 与网页视觉报告

完成 `optional_tools` 全链合同、`capability_gaps`、`visualEvidence`、ReportDocument、Web 证据展示、Markdown 导出、Skill 规则、Tavily 到 Playwright 绑定和视觉 Smoke 断言。Registry 在代码合并与首次部署时仍保持 `draft`；因此该包可安全独立合入，旧任务和文本任务行为不变。平台前置条件通过后，仅需执行第 19 节的配置激活即可产出可追溯网页图片，不依赖工作包 D。

验证：

```bash
pnpm exec tsx --test tests/capability-resolver.test.ts tests/skill-loader-schema.test.ts tests/registry-linter.test.ts tests/plan-compiler.test.ts tests/current-plan-candidate-schema.test.ts tests/direct-invoke-plan.test.ts tests/current-step-bindings.test.ts tests/checkpoint-resume.test.ts tests/control-planning.test.ts tests/current-deliverable-service.test.ts tests/report-document.test.ts tests/report-bundle.test.ts tests/current-flow-state.test.ts tests/current-real-smoke.test.ts
pnpm typecheck
pnpm lint:registry
pnpm --dir apps/web build
```

### 工作包 D：数据驱动图表 lineage

基于工作包 B 已发布的 V2 Reader，删除图表对第一张上传图片的依赖，增加 V2 `chart_render`、精确冻结权重路径、计划页只读权重展示、图表 Publication Group，并修正终止与恢复范围。该包本身修复现有图表建模；即使 C 永不激活，已冻结权重的文本竞品报告仍能生成可信图表。

验证：

```bash
pnpm exec tsx --test tests/artifact-publication-group.test.ts tests/competitive-weight-chart.test.ts tests/chart-renderer.test.ts tests/lease-execution-engine.test.ts tests/execution-recovery.test.ts tests/control-plane.test.ts tests/report-document.test.ts tests/report-package.test.ts tests/candidate-layout.test.ts tests/plan-compiler.test.ts tests/stage2-plan.test.ts tests/requirement-refinement-service.test.ts tests/schema.test.ts tests/execution-control.test.ts tests/control-planning.test.ts tests/current-revision-integrity.test.ts
pnpm typecheck
pnpm --dir apps/web build
```

### 发布门禁：不作为工作包

Smoke 断言、CI 配置和测试必须随 A/C/D 对应工作包合入，禁止留到最后补。A 至 D 全部完成后，本节只执行验证与 Registry 配置切换，不再修改代码或 Schema。

只有平台负责人提供非 root、sandbox 与 egress policy 证据后，才允许进入 canary 激活。Registry 仍为 `draft` 时先运行：

```bash
pnpm quality
pnpm --dir apps/web build
```

上述检查通过后，构建一份 canary 配置：Registry 为 `active`，且同一受保护运行环境在进程启动前设置 `PLAYWRIGHT_CAPTURE_ENABLED=1`。重启所有会加载 Registry 或构造 ToolRouter 的 canary runtime 进程，确认 Adapter resolution 为 available 后再运行：

```bash
PLAYWRIGHT_CAPTURE_ENABLED=1 CURRENT_SMOKE_PROFILE=competitive_research CURRENT_SMOKE_SCENARIO=competitive-ai-shopping-assistant CURRENT_REQUIRE_BROWSER_EVIDENCE=1 ALLOW_REAL_PROVIDER=1 LLM_PROVIDER=gateway TOOL_ADAPTER=real pnpm smoke:current:real
```

真实视觉 Smoke 不得在普通 GitHub-hosted runner 或未验证的开发机执行。Smoke 未满足第 17 节全部断言时立即部署 Registry `draft` + 环境变量取消的回滚配置并重启相同 runtime 进程；文本研究无需回滚。

## 16. 测试矩阵

### 16.1 Adapter 单元测试

- Tavily rows 保持原顺序、去重并截断为 6 页。
- 非 HTTPS、内网 IP、重定向到内网、带账号密码、凭据型 query 或 fragment 的 URL 被拒绝；fragment 不进入导航记录或 Manifest，也不会被静默改写后导航。
- Adapter 固定传入 `chromiumSandbox: true`、`serviceWorkers: 'block'`、`acceptDownloads: false`，缺任一项测试失败。
- Service Worker 请求路径和 WebSocket 均被阻断；新窗口立即关闭。
- `auto`、大图提取、元素截图、整页截图返回正确元数据。
- 选择器为空、过长或不匹配时返回稳定失败码。
- 页面超时、Browser crash、AbortSignal 和 Context close 均释放资源。
- Context 的第 257 个请求在网络访问前被阻断；同 host 只合并并发 DNS，前一次解析 settle 后的请求会重新解析。
- deadline 或租约终止后的故障清理最多使用 5 秒；Browser 未确认断连时 Gate 槽位保持隔离，迟到断连释放槽位，永久 pending 则返回 `recovery: restart_worker`。
- `deadline_exceeded` 映射 timeout，`lease_lost` 保持不可降级的租约失败；两者不得因共用 signal 混淆。
- 10 个并发调用时最多 2 个 Browser 活跃、8 个排队；第 11 个立即 capacity，等待超过 10 秒 capacity，取消后无配额泄漏。
- 两次尝试、退避和排队共享 90 秒总 deadline，第二次尝试不能重置时钟。
- 单图 10 MiB、总量 40 MiB、像素和高度上限生效。
- 输出 JSON 不含 bytes、Base64、Cookie、HTML 或临时路径。
- 成功输出固定包含 `security_profile=browser-controls-v1`。
- sidecar 与 JSON 的 attachment ID、SHA-256、媒体类型和尺寸一一对应。
- `captures` 与 `failures` 的 source_result_index 不重复；失败信息超过 300 字符、含响应正文或异常对象时 Schema/脱敏测试失败。
- 部分成功返回 captures 与 failures；全部失败抛出带脱敏 `details.page_failures` 的结构化 ToolInvocationError。

### 16.2 执行与 Artifact 测试

- retry 第一轮失败、第二轮成功时只保留第二轮 sidecar。
- 旧 Current Plan 缺少三个新增 optional 字段时仍可读取并规范化为空数组；新编译计划必须显式写出字段。
- draft/deprecated optional Tool 不产生 decision 或 gap；active unavailable 不拒绝 Skill且 decision/gap 一一对应；required Tavily unavailable 仍拒绝。
- 已冻结为 available 的 Playwright step 在 Registry 回滚为 draft 后按 configuration skipped；同样漂移发生在 required Tool 或无冻结 optional decision 的 step 时仍暂停。
- Tool JSON 封存失败时不写视觉资产。
- 第 N 张图封存失败时，Tool JSON 和前 N-1 张图全部失效。
- Manifest 封存失败时对应 Binary Artifact 失效。
- 任一失效调用失败时必须暂停为 `artifact_invalidation`，测试不得只断言主错误。
- execution step 持久化失败时整批发布按提交复核结果处理。
- 租约在浏览器排队、运行、JSON 封存和媒体封存四个时点丢失均不能记录成功，排队/浏览器配额归还。
- deadline 在 Adapter 返回后、Artifact 写入返回后到期时，刚写入 Artifact 被登记并补偿，步骤不得成功。
- 截图步骤不能通过 checkpoint 复用 JSON 而丢失图片。
- 成功截图产生 `screenshot` Evidence，且 Manifest、Tool Artifact 和来源 URL 可反查。
- Playwright optional 失败进入 gap，Tavily core 失败仍暂停。
- 部分截图成功并带 failures 时步骤 succeeded、任务 `completed_with_gaps`；发布失败不会残留 gap。
- `toolProvenance.gapSummary` 的 count/keys/failuresHash 必须与已验证 failures 或失败 details 一致，不泄露 URL/message。
- 历史任务的 gapCount 等于去重后的 capability gaps 加 gapSummary；旧 skipped step 无 summary 时回退计 1，Deliverable、历史页和任务状态显示一致。

### 16.3 报告合同测试

- `browser_capture`、`tool_artifact` 和 `user_upload` 可作为竞品 original。
- `visualEvidence` 只能引用已验证 original。
- 图片必须引用匹配 Asset 的 screenshot Evidence 和同 URL public source Evidence。
- `visualEvidence.sampleIds`、dimension 和 assetId 必须分别命中 competitorSamples、dimensionMatrix 且不重复。
- displayable inventory 非空而 `visualEvidence` 为空时触发受控重试；inventory 为空且无视觉 gap 时拒绝完成。
- `screenshotComparisons` 仍只接受精确原图与标注图对。
- 竞品报告有单图、无标注图时可以通过。
- 设计走查没有 finding-bound 标注图时仍失败。
- 竞品 ReportDocument 的目录与章节标题中英文一致，每章首 Block 是模块目的说明，Dimension Matrix 每维只有一个整合 Block 并有跨维度总结。
- Image Block 证据编号在 Web、Markdown 和安全导出中一致。
- 报告 LLM 的视觉 inventory 只含验证后的来源元数据和 Evidence IDs，不含 Base64；元数据不足时拒绝自动归类。
- V1 保持原规则且旧 ReportDocument 可读取；V2 浏览器/图表与混合 V1/V2 Report Package 可读取。
- V1 中写入 `browser_capture`/`chart_render`、V2 version 与 Artifact schemaVersion 不一致时拒绝读取。
- 被阻断 exportPolicy 的图片不会进入页面或导出。

### 16.4 图表测试

- 没有用户上传图片时，已冻结权重仍生成 SVG。
- 计划页展示值直接来自唯一 Skill step 的 `input.scoring_weights`；确认请求不携带或改写第二份权重状态。
- `sampling_weights`、Structured Task 文本和其他 step 的 `scoring_weights` 不得被提取；只接受唯一冻结 Skill step 的精确字段。
- Chart Manifest 精确绑定 Chart Data Artifact 哈希和 specHash。
- Chart Spec 数值与 Evidence 不一致时拒绝发布。
- Chart Table 与 Chart Spec 不一致时拒绝读取。
- SVG 不含脚本、远程资源或不安全标签。
- 权重不存在时不生成空图或伪造图。

### 16.5 浏览器与真实任务测试

单元和集成网络测试使用注入的 Browser/route/DNS，不依赖公网或 loopback。CI contract job 使用真实 Chromium，但只打开 `about:blank` 并通过 `page.setContent()` 注入内存 fixture，验证 sandbox、渲染、截图和清理，不把 GitHub runner 当出站隔离证据。真实 Smoke 用 `CURRENT_SMOKE_SCENARIO=competitive-ai-shopping-assistant` 精确选择第 17 节输入，禁止继续使用 profile 下“第一条 clear 场景”的隐式选择；只在受保护环境访问公网，并保留 taskId、planVersionId、attemptId、Tool Artifact、Visual Asset、Evidence Manifest、Deliverable、Report Package ID、gapCount、browserCaptureCount、screenshotEvidenceCount 和 chartRenderCount。

Smoke 单测必须覆盖 scenario ID 不存在、scenario 与 profile 不匹配、浏览器证据为零、历史重读计数漂移，以及 `gapSummary` 泄露 requested URL/message 等失败路径。Smoke receipt 仍可按现有长期审计合同保存公开来源 URL。

## 17. 真实验收任务

使用以下原始输入，不改写问题：

> 请对比中国主流电商平台的 AI 购物助手在消费者决策支持体验上的差异，重点比较需求理解、推荐可解释性、商品参数与价格对比、内容可信度、购买转化闭环，并给出京东下一季度产品优先级建议。仅使用 2025—2026 年公开可访问资料，所有关键结论必须附可追溯来源。

### 17.1 计划验收

- Capability Resolution 中 `competitive-web-research.required_tools` 精确为 Tavily，`optional_tools` 精确为 Playwright；受保护验收环境中 Playwright 为 available。
- 候选计划至少包含 Tavily、Playwright 和 `competitive-web-research`，且没有 Playwright capability gap。
- Playwright 步骤晚于 Tavily，早于 Skill。
- Playwright 的 `/pages` 只绑定 Tavily `/results`，没有手写 URL。
- 五个对比维度全部进入 ResearchTask、ProblemGraph 和 Skill 输入。
- 若采用等权评分，计划页面直接从 Skill step 的 `input.scoring_weights` 显示每项 20% 的可确认假设，不存在可漂移的第二份权重值。
- 所有步骤 `requires_approval=false`，因为任务只读公开信息且无登录操作。

### 17.2 运行验收

- Tavily receipt 为 real，来源时间范围符合 2025 至 2026 年要求。
- Playwright receipt 为 real，`implementationId=playwright-page-capture-v1`，Tool 输出 `security_profile=browser-controls-v1`。
- 至少 3 个可访问平台各有 1 张有效视觉证据；其余平台若受访问控制限制，必须逐项形成 gap。
- 每张图使用 `visual-asset-manifest-v2`，有内部资产 URL、来源页 URL、获取时间、页面标题、方式、尺寸和哈希。
- 报告至少包含 1 张已验证评分权重图；图表明确表示研究权重，不表示市场表现。
- 需求理解、推荐可解释性、参数与价格对比、内容可信度、转化闭环五个模块均有整合结论。
- 每个大标题中英文并列，标题下有模块目的说明。
- 关键事实引用可从报告打开到 2025 至 2026 年公开来源。
- 页面刷新后可在历史任务重新打开同一报告，图片和图表不丢失。
- Markdown 或打印导出不包含原站图片热链和 Base64。

### 17.3 状态验收

- 全部 required evidence 满足且无页面缺口时为 `completed`。
- 文本证据满足，但存在 optional capability、capacity、截图访问或计划要求的图表缺口时为 `completed_with_gaps`。
- Tavily required evidence 不满足、Artifact 完整性失败、来源绑定失败或补偿失败时不得完成；补偿失败必须以 `artifact_invalidation` 暂停。

## 18. 依赖与运行要求

### 18.1 本机

实施前确认 Node 主版本不低于 22：

```bash
node --version
pnpm --version
```

使用本机已有版本管理器切换 Node 22 后执行：

```bash
pnpm install
pnpm exec playwright install chromium
pnpm quality
```

本机默认不设置 `PLAYWRIGHT_CAPTURE_ENABLED`，因此上述安装只用于实现、注入式网络策略测试和 `page.setContent()` 内存 fixture 验证，不授权访问真实公网目标。Playwright 作为根项目运行依赖写入 lockfile。浏览器安装是部署步骤，运行时不得发现缺失后自动联网下载。

### 18.2 CI 与部署

- 现有 GitHub CI 已使用 Node 22，不再把“升级 CI Node”列为工作；新增 Playwright contract job 使用 `pnpm exec playwright install --with-deps chromium`。
- macOS 开发机使用 `pnpm exec playwright install chromium`，只运行内存 fixture。
- 浏览器缓存键包含 lockfile 中的 Playwright 版本。
- Worker 需要可写的临时目录，但截图不得依赖临时文件持久化；Browser 进程必须由非 root Worker 启动。
- 部署环境必须提供阻断 IPv4/IPv6 私网、loopback、link-local、CGNAT、保留地址和云元数据地址的出站规则，并提供发布证据。
- 普通 CI real smoke 保持 `PLAYWRIGHT_CAPTURE_ENABLED` 未设置；需要公网截图的 Smoke 只能进入受保护环境。
- 现有 `TAVILY_API_KEY` 继续使用，没有新密钥或第三方账户。
- 不需要 SearXNG、Docker、Chrome 用户 Profile 或 ai-spider 之外的新服务。

## 19. 发布与回滚

### 19.1 发布顺序

1. 开发 shell 切换 Node 22，合入工作包 A；Registry 保持 `draft`，CI 只跑注入式策略测试和内存 fixture。
2. 合入并部署工作包 B 的 V2 Reader/Publication Group；Writer 仍不可由普通任务触发，回归读取现有 V1 报告。
3. 合入工作包 C、D 与全部 Smoke 断言；部署 Worker、API 和 Web，但 Registry 仍为 `draft`、`PLAYWRIGHT_CAPTURE_ENABLED` 仍未设置。
4. 运行 `pnpm quality`、Web build、V1/V2 Reader、Artifact、重试、安全、恢复和降级测试。
5. 平台负责人提交非 root、sandbox 和 egress policy 发布证据；生成仅面向受保护 canary 的 Registry `active` + `PLAYWRIGHT_CAPTURE_ENABLED=1` 启动配置。
6. 部署该 canary 配置并重启所有加载 Registry/ToolRouter 的 runtime 进程；确认 Playwright capability 为 available 后，运行第 17 节真实验收任务并人工打开每个视觉来源。
7. 由独立研究员检查图片是否支持相邻结论、图表口径是否诚实、缺口是否完整披露。
8. Smoke 与人工评审均通过后扩大部署；任一失败立即执行 19.2 回滚。

### 19.2 回滚

执行层回滚不删除数据：

1. 生成 Registry `draft` 且取消 `PLAYWRIGHT_CAPTURE_ENABLED` 的回滚配置；`optional_tools` 声明可以保留，因为 draft Tool 不会阻断 Skill。
2. 部署回滚配置并重启所有加载 Registry/ToolRouter 的 runtime 进程，复核 Capability Resolution 不再生成 Playwright step 或 gap。
3. 新任务恢复 Tavily + Skill 文本研究路径；回滚前已经冻结 Playwright step 的未执行任务按 configuration gap 跳过该 step，不删除任务或 Artifact。
4. 保留 V2 类型、Schema 和所有 Reader，使已生成 `browser_capture`、`chart_render` 历史报告继续可读。
5. 若只回滚工作包 D，回退 Chart Writer/Engine 逻辑但保留工作包 B 的 V2 Reader；已写 V2 图表继续可读。

只有确认环境中没有新来源类型 Artifact 时，才允许整体回退对应读取合同。已封存 Artifact 和审计记录不做破坏性清理。

## 20. 风险与前提

| 风险 | 控制 |
|---|---|
| 公开站点反爬、验证码或地区差异 | 不绕过，按页面记录 gap，文本路径继续 |
| 浏览器内存和执行时间增长 | 2 active / 8 queued Gate、每 Context 256 请求、页面/字节/像素上限和包含重试的 90 秒总 deadline |
| Chromium 清理永久 pending | 业务 deadline 后最多 5 秒故障清理；未确认断连时隔离 Gate 槽位并要求外部 Worker supervisor 重启 |
| 恶意页面访问内网或 DNS rebinding | route 做纵深检查，Service Worker/WebSocket 阻断；生产最终依赖基础设施 egress policy，缺失时 Tool 不激活 |
| sidecar 与 JSON 脱节 | attachment ID、指针、尺寸和三重 SHA-256 校验 |
| 半发布 Artifact 或清理失败 | Publication Group、可观察补偿、`artifact_invalidation` 暂停和 recovery 失效 |
| LLM 编造 Asset ID 或来源 | 只向 LLM 提供已验证 inventory，服务层再校验精确引用 |
| 图表制造虚假精确度 | 只画唯一冻结 Skill step 的结构化权重，不递归猜测数值 |
| V1/V2 读取漂移 | V1 Schema 不变、V2 判别联合、Reader-first、Writer 回滚不撤 Reader |
| optional 能力拖垮文本主链 | `optional_tools` 不参与 Skill 否决，规划/执行失败进入 capability/tool gap |
| 依赖升级影响构建 | 根 lockfile 锁定 Playwright，Node 22 和 Chromium 安装进入 CI 门禁 |

本方案最脆弱的前提有两个。第一，平台必须能提供真实的出站隔离；若不成立，Tool 永久保持 `draft`，系统仍可交付文本报告，但不能宣称具备安全公网截图能力。第二，Tavily 必须返回无需登录、可由浏览器访问的真实来源页；若不成立，任务以 `completed_with_gaps` 完成文本报告并逐项披露视觉证据缺口，不会改用生成图或不可追溯热链填补。

## 21. 完成定义

以下条件全部满足才算完成：

- 代码、Schema、Registry、Skill 和文档合同一致。
- Node 22、Playwright 与 Chromium 在本机和 CI 可重复安装。
- 2 active / 8 queued Gate、统一 deadline 和租约 AbortSignal 经压力与泄漏测试通过。
- 非 root、`chromiumSandbox: true`、Service Worker/WebSocket 阻断和生产 egress policy 均有机器或发布证据。
- 媒体 sidecar 不进入 JSON、日志或数据库字段。
- V1 保持不可变，V2 Reader-first 发布；浏览器截图通过 V2 VisualAssetService 和 Evidence Manifest 封存。
- 任一发布补偿失败都会暂停为 `artifact_invalidation`，不存在被吞掉的失效错误。
- 竞品报告支持单图证据，并保留原图与标注图的严格比较合同。
- 权重图表不再依赖用户上传图片，只读取冻结 Skill step 的精确权重路径。
- Web 历史任务、图片查看、证据展开、Markdown 和打印导出均通过。
- 所有定向测试和 `pnpm quality` 通过。
- 真实验收任务完成，来源、图片、图表、状态和 gap 经人工复核。
- 回滚演练确认禁用新 Tool 后，已有历史报告仍可读取。

## 22. 开发准入结论

本方案的产品与代码架构已经决策完备，工作包 A 至 D 可在批准后进入开发，不需要实现者重新选择 optional 语义、Manifest 版本、安全方案或事务边界。生产 Tool 激活仍有一个外部硬门禁：平台负责人必须提供受保护 Worker 的非 root、sandbox 与 egress policy 证据；该门禁不阻塞 A 至 D 编码，但阻塞 Registry 从 `draft` 切换为 `active`。
