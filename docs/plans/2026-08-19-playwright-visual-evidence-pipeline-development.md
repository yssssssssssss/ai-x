# Playwright 网页视觉证据链开发文档

> 状态：方案已确认，等待实施。
>
> 日期：2026-08-19。
>
> 适用范围：Current 任务主链中的公开网页取证、视觉资产封存、竞品分析报告图片展示，以及现有评分权重图表的可信来源修复。
>
> 真相源：本文冻结本次开发的接口、边界、失败语义、文件范围、测试和发布门禁。本文不授权修改 Legacy 写路径，也不授权绕过登录、验证码或站点访问控制。

## 1. 决策摘要

本次采用以下主链：

```text
Tavily 发现公开来源 URL
  -> Playwright 在 Node Worker 中访问来源页并截图
  -> Tool JSON Artifact 与内存媒体 sidecar 配对
  -> VisualAssetService 封存图片和来源 Manifest
  -> Evidence Manifest 绑定网页来源与截图
  -> CurrentDeliverableService 选择可展示视觉证据
  -> ReportDocument 输出图片、图表和可追溯证据
  -> Web 历史任务读取同一份已封存报告包
```

不部署 SearXNG，不增加独立浏览器服务，不新建专用 Agent。Tavily 继续负责发现 URL，Playwright 只负责访问明确的 URL 和生成视觉证据，研究 Skill 负责来源判断和报告分析。App 截图继续走现有 `ai-spider-search`，两条来源最终都进入同一套 Visual Asset 与 Evidence 合同。

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

运行环境也有明确前置问题。根 `package.json` 要求 Node `>=22`，当前本机是 Node `v20.18.1`。Playwright 依赖和 Chromium 均未安装，实施和验收前必须先切换到 Node 22。

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
- 浏览器截图不参与 checkpoint 复用，重试会重新访问页面并生成新的获取时间与哈希。
- `pnpm quality`、定向测试和真实任务 Smoke 均通过。
- 不新增数据库迁移，不新增 API Key，不改变 Current HTTP 路由。

## 4. 非目标

本次不做以下工作：

- 不部署本机或远端 SearXNG。
- 不替换 Tavily，也不新增第二个通用搜索供应商。
- 不新建浏览器微服务、Docker 容器或独立 Agent。
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
- 当前工作树存在未提交修改。实施时必须先重新读取目标文件和 diff，不得用 reset、checkout 或整文件覆盖清理用户改动。

## 6. 总体架构

```text
┌──────────────────── Current Plan ────────────────────┐
│ Step 1  tavily-web-search                            │
│    output.results[]                                  │
│           │ sealed binding: /results -> /pages       │
│           v                                          │
│ Step 2  playwright-page-capture                      │
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

新增 `PlaywrightPageCaptureAdapter`，由现有 `ToolRouter` 按 `adapter_type: playwright` 分发。每次 Tool 调用启动一个 Chromium Browser，在同一 Browser 中创建隔离 Context，调用结束后在 `finally` 中关闭。首版不维护跨任务 Browser 池，不复用 Cookie、localStorage 或登录状态。

该实现增加一个 Node 依赖和一个浏览器运行包，不增加新进程管理协议、健康检查服务或网络端口。

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

`competitive-web-research.required_tools` 增加 `playwright-page-capture`。Plan Compiler 继续要求两个 Tool 都早于 Skill，同时新增一条窄规则：截图步骤必须依赖一个更早的 `tavily-web-search` 步骤，并使用上述精确绑定。Direct Skill 计划也按 Tavily、Playwright、Skill 的顺序构建，不能沿用当前所有 Tool 并行的默认行为。

### 7.3 二进制通过内存 sidecar 传递

当前 Tool Artifact 是 JSON。把截图 Base64 放进 JSON 会放大体积、重复编码，并让脱敏、哈希和日志路径都承担二进制。方案扩展 Tool 运行时返回值，字节只存在于内存：

```ts
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

export interface ToolResultGap {
  code: string;
  message: string;
  sourcePageUrl?: string;
}

export interface ToolInvokeResult {
  output: object;
  latencyMs: number;
  receipt: ToolInvocationReceipt;
  mediaAttachments?: ToolMediaAttachment[];
  gaps?: ToolResultGap[];
}
```

Tool JSON 只保存 `attachment_id`、`content_sha256` 和获取元数据。`invokeWithRetry`、`ToolRouter`、`StepResult` 必须原样保留成功调用的 `mediaAttachments` 和 `gaps`，不得 structured clone、JSON stringify 或遗漏这两个字段。

### 7.4 浏览器截图使用独立来源类型

`tool_artifact` 继续表示从 Tool JSON 中的远程图片 URL 下载并封存。浏览器已经产生了最终字节，不应再伪装成远程下载。`VisualAssetSource` 增加 `browser_capture`：

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

其中 `artifactId` 指向本次 Playwright Tool JSON Artifact，`jsonPointer` 指向 `/output/captures/<index>`。Manifest 顶层的 `contentSha256` 必须同时等于 Tool JSON 中的 `content_sha256`、sidecar 字节哈希和 Binary Artifact 哈希。

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

报告中的 Image Block 增加可选 `evidenceIds`，新报告必须写入。Web 在图片下方显示证据开关，Markdown 导出在图片说明后输出证据编号。

### 7.6 图表绑定结构化数据，不绑定无关图片

`VisualAssetSource` 增加 `chart_render`：

```ts
type ChartRenderSource = {
  kind: 'chart_render';
  dataArtifactId: string;
  dataArtifactContentSha256: string;
};
```

`chart_render` 的 `derivedFrom` 为 `null`，`derivation` 仍为 `chart_svg`，并保留 `chartId` 与 `specHash`。`renderAndSealChartSvg` 改为接收已封存 Chart Data Artifact，不再接收 `original: VisualAssetReference`。

本次只保证用户确认或计划冻结的评分权重图。测试任务没有指定权重时，计划候选把五个明确维度的等权方案作为可见假设，并在确认后将 `scoring_weights` 写入冻结的 Skill step input。图表标题改为“对比维度评分权重 / Comparison-dimension Weights (%)”，不再写死六维度。没有冻结权重时不生成该图。

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
  "failures": []
}
```

JSON 输出不含页面 HTML、Cookie、请求头、浏览器日志、图片字节或临时路径。`failures` 只保存 URL、稳定错误码和脱敏信息。

### 8.3 数量与资源上限

- 每次 Tool 调用最多访问 6 页。
- 每页默认生成 1 个资产。
- 单个资产最大 10 MiB。
- 单次调用的媒体 sidecar 总量最大 40 MiB。
- 整页高度最大 12,000 像素，总像素不超过 20,000,000。
- 页面并发数为 2，单页超时 20 秒，Tool 总超时 90 秒。
- 超限页面可以记录 `truncated: true`，不得静默缩减后仍声称完整整页。

## 9. 浏览器执行与安全边界

### 9.1 浏览器隔离

- 每次调用使用新的无痕 Browser Context。
- 不加载用户 Chrome Profile，不读取现有登录状态。
- 禁止下载、通知、摄像头、麦克风、地理位置和剪贴板权限。
- 禁止弹窗接管主流程，新窗口立即关闭并记录 gap。
- 不点击 Cookie 弹窗、登录按钮、购买按钮或页面内操作控件。
- Chromium sandbox 保持开启，禁止加入 `--no-sandbox`。
- 调用完成、异常或租约丢失时都必须关闭 Page、Context 和 Browser。

### 9.2 网络安全

顶层 URL 必须同时满足以下条件：

- URL 精确来自更早的、已封存的 Tavily Tool 输出。
- 协议为 HTTPS，无用户名和密码字段。
- 主机解析结果不包含 loopback、RFC 1918、link-local、CGNAT、组播或保留地址。
- 每次重定向和子资源请求都重新执行协议与地址检查。
- `file:`、`ftp:`、`data:` 顶层导航、WebSocket 和非 GET、HEAD 请求全部阻断。

实现应把 `VisualAssetService` 当前的公网地址判断提取为一个小型共享模块，浏览器路由和远程图片下载复用同一份规则。浏览器层的路由检查不能替代部署环境的出站网络策略；生产 Worker 仍应由基础设施阻断内网和云元数据地址。

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

1. Adapter 返回 JSON、媒体 sidecar、receipt 和 gaps。
2. 运行时校验 Tool JSON Schema、脱敏策略、attachment ID 唯一性、字节哈希和数量上限。
3. Engine 写入并复核 `steps/<stepNo>-tool_output.json`。
4. Engine 逐个调用 `VisualAssetService.ingestBrowserCapture()`。
5. VisualAssetService 重新读取 Tool Artifact，通过 `/output/captures/<index>` 取出元数据。
6. VisualAssetService 比较 attachment ID、URL、媒体类型、尺寸、字节数和 SHA-256。
7. VisualAssetService 写入 Binary Artifact 和 Visual Asset Manifest，并立即 `readVerified()`。
8. 全部附件完成后，Engine 记录 execution step `succeeded`。
9. Engine 把浏览器视觉资产加入本次 attempt 的截图 Evidence 清单。

### 10.2 失败补偿

Engine 在步骤发布前维护本批 Artifact ID 集合。如果第 3 至第 8 步任一步失败：

- 所有已写入的 Tool JSON、Binary Artifact 和 Visual Asset Manifest 都调用 `invalidateArtifactPublication()`。
- execution step 记录失败，不向后续 Skill 暴露该批输出。
- 任一失效操作失败时，任务暂停为 `artifact_invalidation`，由 recovery 处理，不能降级成普通截图缺口。
- `recordExecutionStep` 提交结果不明确时，沿用现有持久化复核，再决定是否失效，避免把已经发布的成功步骤误删。

`VisualAssetService` 内部已有 Binary 与 Manifest 成对失效逻辑，Engine 负责把 Tool JSON 和多个 Visual Asset 对纳入同一个发布边界。

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

`design_audit_report` 继续要求精确的原图与 finding-bound 标注图配对。只有 `competitive_analysis_report` 放宽为可直接使用单张 original，不能把该规则扩散到设计走查。

### 11.3 ReportDocument

竞品报告的 Visual Evidence 章节按以下顺序组成：

1. `visualEvidence` 生成的单图 Block。
2. 有精确 lineage 的 `screenshotComparisons` 对比 Block。
3. 已验证的 Chart Block 和可访问数据表。

每张图片显示 caption、获取时间、来源域名和证据编号。标题与目录继续使用中英文，章节开头继续输出该模块的内容与目的说明。没有已验证图片时，本章显示缺口说明，不展示占位图或 AI 生成图。

### 11.4 历史任务与导出

现有 Report Package 和资产读取 API 继续使用，不新增路由。需要扩展服务端和 Web 对 `browser_capture`、`chart_render` 的严格来源解析：

- 历史报告旧来源类型继续可读。
- 新报告图片只通过 `/api/control-tasks/:taskId/assets/:assetId` 读取。
- Markdown 和打印导出使用包内资产路径，不保留原站热链。
- Image Block 的 `evidenceIds` 进入安全导出和 Markdown。
- 任务 owner 校验、Artifact checksum 和 exportPolicy 继续生效。

## 12. 图表修复

### 12.1 数据来源

评分权重先写入 `chart_data` Artifact，再创建对应的 `user_input` Evidence。Chart Spec 每个数值仍必须引用该 Evidence，数值与已解析 Evidence 不一致时拒绝生成。

### 12.2 发布顺序

1. 封存 Chart Data Artifact。
2. 创建并校验 Chart Evidence。
3. 生成 Chart Spec 与 `specHash`。
4. 服务端 ECharts 渲染 SVG。
5. VisualAssetService 以 `chart_render` 来源封存 SVG 和 Manifest。
6. 封存 `verified-chart-v1` Chart Spec Artifact。
7. ReportCompositionService 复核 data Artifact 哈希、specHash、表格与 SVG Manifest。

Chart 任一步失败时，Chart Data、SVG、Manifest 和 Chart Spec 作为同一发布组失效。图表失败属于可恢复的报告增强缺口时，文字报告可继续；哈希或来源不一致属于完整性失败，任务暂停。

### 12.3 明确边界

本次不从 `dimensionMatrix[].score` 自动画竞品排名图。该 score 可能是研究综合判断，不是来源页中的直接测量值。只有未来存在明确评分方法、数据 Artifact 和派生 Evidence 合同时，才允许进入图表。

## 13. 失败、重试、恢复与降级

| 场景 | 步骤状态 | 任务结果 | 处理 |
|---|---|---|---|
| 部分页面因登录、验证码或超时失败，至少一张成功 | `succeeded`，附 gaps | `completed_with_gaps` | 封存成功图片，报告列出失败页面 |
| 所有页面均访问失败 | optional Tool `skipped` | `completed_with_gaps` | 继续文本 Skill 与报告 |
| Chromium 未安装或启动失败 | optional Tool `skipped` | `completed_with_gaps` | 返回 configuration gap，不自动下载浏览器 |
| 网络超时、浏览器崩溃 | 先重试 | 成功或 `completed_with_gaps` | 按 manifest 最多 2 次，重试前关闭旧 Browser |
| Tool 输出 Schema 不合法 | `failed` | `paused` | 不重试，修复 Adapter 或合同 |
| sidecar 与 JSON 哈希不一致 | `failed` | `paused` | 作为完整性错误 fail closed |
| 视觉资产封存失败 | `failed` | `paused` | 失效整批 Artifact，允许任务级 retry |
| 租约丢失 | `failed` | `paused` | 关闭浏览器，不记录步骤成功 |
| Tavily core Tool 失败 | `failed` | `paused` | 沿用 core 基础设施失败语义 |
| 报告引用不存在的 Asset 或 Evidence | `failed` | `paused` | Deliverable 校验拒绝发布 |

`invokeWithRetry` 只返回最后一次成功调用的媒体 sidecar。失败尝试产生的 Page、Context、Browser 和字节引用必须在 Adapter 内释放。

截图步骤有来源绑定，现有 checkpoint 逻辑本来就不会复用含 `input_bindings` 的 Tool 步骤。Plan Compiler 新增截图绑定硬门禁，测试固定这一不变量，不增加第二套 checkpoint 配置。

Recovery 的视觉复合 Artifact 集合增加 `chart_data`，并继续包含 `visual_asset`、`visual_asset_manifest`、`image_annotation` 和 `chart_spec`。中断任务不得留下可被报告发现的孤立媒体。

## 14. 具体文件改动

### 14.1 依赖与 Tool

| 文件 | 改动 |
|---|---|
| `package.json` | 增加 Playwright 运行依赖和浏览器安装脚本，保持 Node `>=22` |
| `pnpm-lock.yaml` | 锁定 Playwright 依赖 |
| `apps/orchestrator-runtime/src/runtime/playwright-page-capture-adapter.ts` | 新增浏览器 Adapter、资源上限、固定 DOM 取图逻辑和清理逻辑 |
| `apps/orchestrator-runtime/src/runtime/public-web-access-policy.ts` | 提取公网 URL、DNS、重定向和私网阻断规则，供浏览器与远程图片下载复用 |
| `apps/orchestrator-runtime/src/runtime/tool-adapter.ts` | 扩展 media sidecar 与 gap 合同，导出共用类型 |
| `apps/orchestrator-runtime/src/runtime/agent-runtime.ts` | 注册 `playwright` Adapter |
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
| `orchestrator/skill-registry.yaml` | 为 `competitive-web-research` 增加截图 Tool 依赖 |
| `skills/competitive-analysis/web-research/SKILL.md` | 明确文本来源、截图来源、单图证据和 gap 规则 |
| `apps/orchestrator-runtime/src/planners/routed-planner.ts` | 生成 Tavily 到 Playwright 的显式绑定；修复 Direct Skill 的 Tool 顺序 |
| `apps/orchestrator-runtime/src/planners/plan-compiler.ts` | 校验截图步骤来源、依赖、Pointer 和顺序 |
| `apps/orchestrator-runtime/src/control/tool-retry-policy.ts` | 保留成功调用的媒体 sidecar 与 gaps |
| `apps/orchestrator-runtime/src/control/lease-execution-engine.ts` | 实现媒体发布组、截图 Evidence、gap 汇总、整批失效和图表来源修复 |
| `apps/orchestrator-runtime/src/control/execution-recovery-service.ts` | 将图表数据和新视觉发布纳入恢复 |
| `database/control-plane.ts` | 终止任务时使 `chart_data` 等本次发布资产失效，不改表结构 |

### 14.3 Visual Asset、Chart 与报告

| 文件 | 改动 |
|---|---|
| `packages/api-contract/research-deliverable.ts` | 增加 `browser_capture`、`chart_render` 和报告视觉引用类型 |
| `schemas/visual-asset-manifest.schema.json` | 增加两种来源及其 lineage 约束 |
| `apps/orchestrator-runtime/src/report/visual-asset-service.ts` | 增加 `ingestBrowserCapture()` 和数据驱动图表封存 |
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

### 14.5 测试

新增 `tests/playwright-page-capture-adapter.test.ts`，并扩展：

- `tests/tool-retry-policy.test.ts`
- `tests/plan-compiler.test.ts`
- `tests/direct-invoke-plan.test.ts`
- `tests/visual-asset-service.test.ts`
- `tests/chart-renderer.test.ts`
- `tests/lease-execution-engine.test.ts`
- `tests/report-document.test.ts`
- `tests/report-package.test.ts`
- `tests/report-bundle.test.ts`
- `tests/control-planning.test.ts`
- `tests/execution-recovery.test.ts`

## 15. 独立可合并工作包

### 工作包 A：浏览器 Tool 与 sidecar 合同

完成 Playwright 依赖、Adapter、Tool Schema、ToolRouter 注册、重试字段保留和公网访问策略。Tool Registry 先保持 `draft`，现有产品流程不调用它。完成后 Adapter 可通过注入的测试 Browser 独立运行，当前任务行为不变。

验证：

```bash
pnpm exec tsx --test tests/playwright-page-capture-adapter.test.ts tests/tool-retry-policy.test.ts
pnpm typecheck
pnpm lint:registry
```

### 工作包 B：原子视觉资产发布

完成 `browser_capture` Manifest、VisualAssetService、Engine 媒体发布组、截图 Evidence、恢复和失败补偿。Registry 仍保持 `draft`，可用手工冻结计划做集成测试，不影响普通任务。

验证：

```bash
pnpm exec tsx --test tests/visual-asset-service.test.ts tests/lease-execution-engine.test.ts tests/execution-recovery.test.ts
pnpm typecheck
```

### 工作包 C：报告与 Planning 激活

完成 `visualEvidence`、ReportDocument、Web 证据展示、Markdown 导出、Skill 规则和 Tavily 到 Playwright 绑定。定向测试通过后将 Tool Registry 改为 `active`。该工作包完成后，即使图表工作包不合入，真实任务也能产出可追溯网页图片。

验证：

```bash
pnpm exec tsx --test tests/plan-compiler.test.ts tests/direct-invoke-plan.test.ts tests/report-document.test.ts tests/report-package.test.ts tests/report-bundle.test.ts
pnpm typecheck
pnpm lint:registry
```

### 工作包 D：数据驱动图表 lineage

删除图表对第一张上传图片的依赖，增加 `chart_render`，修正终止与恢复范围。该工作包本身修复现有图表建模，能单独合入。

验证：

```bash
pnpm exec tsx --test tests/competitive-weight-chart.test.ts tests/chart-renderer.test.ts tests/report-document.test.ts tests/report-package.test.ts
pnpm typecheck
```

### 工作包 E：真实任务门禁与发布

在 A 至 D 全部合入后运行完整质量门禁和真实任务。该工作包只补 Smoke 断言、运行记录和发布配置，不改变前述合同。

验证：

```bash
pnpm quality
ALLOW_REAL_PROVIDER=1 TOOL_ADAPTER=real pnpm smoke:current:real
```

## 16. 测试矩阵

### 16.1 Adapter 单元测试

- Tavily rows 保持原顺序、去重并截断为 6 页。
- 非 HTTPS、内网 IP、重定向到内网、带账号密码 URL 被拒绝。
- `auto`、大图提取、元素截图、整页截图返回正确元数据。
- 选择器为空、过长或不匹配时返回稳定失败码。
- 页面超时、Browser crash 和 Context close 均释放资源。
- 单图 10 MiB、总量 40 MiB、像素和高度上限生效。
- 输出 JSON 不含 bytes、Base64、Cookie、HTML 或临时路径。
- sidecar 与 JSON 的 attachment ID、SHA-256、媒体类型和尺寸一一对应。
- 部分成功返回 captures 与 gaps；全部失败抛出结构化 ToolInvocationError。

### 16.2 执行与 Artifact 测试

- retry 第一轮失败、第二轮成功时只保留第二轮 sidecar。
- Tool JSON 封存失败时不写视觉资产。
- 第 N 张图封存失败时，Tool JSON 和前 N-1 张图全部失效。
- Manifest 封存失败时对应 Binary Artifact 失效。
- execution step 持久化失败时整批发布按提交复核结果处理。
- 租约在浏览器运行、JSON 封存和媒体封存三个时点丢失均不能记录成功。
- 截图步骤不能通过 checkpoint 复用 JSON 而丢失图片。
- 成功截图产生 `screenshot` Evidence，且 Manifest、Tool Artifact 和来源 URL 可反查。
- Playwright optional 失败进入 gap，Tavily core 失败仍暂停。

### 16.3 报告合同测试

- `browser_capture`、`tool_artifact` 和 `user_upload` 可作为竞品 original。
- `visualEvidence` 只能引用已验证 original。
- 图片必须引用匹配 Asset 的 screenshot Evidence 和同 URL public source Evidence。
- `screenshotComparisons` 仍只接受精确原图与标注图对。
- 竞品报告有单图、无标注图时可以通过。
- 设计走查没有 finding-bound 标注图时仍失败。
- Image Block 证据编号在 Web、Markdown 和安全导出中一致。
- 旧的 `visual-asset-manifest-v1` 和旧 ReportDocument 仍可读取。
- 被阻断 exportPolicy 的图片不会进入页面或导出。

### 16.4 图表测试

- 没有用户上传图片时，已冻结权重仍生成 SVG。
- Chart Manifest 精确绑定 Chart Data Artifact 哈希和 specHash。
- Chart Spec 数值与 Evidence 不一致时拒绝发布。
- Chart Table 与 Chart Spec 不一致时拒绝读取。
- SVG 不含脚本、远程资源或不安全标签。
- 权重不存在时不生成空图或伪造图。

### 16.5 浏览器与真实任务测试

单元和集成测试使用注入的 Browser 与本地固定页面，不依赖公网。真实 Smoke 才访问公网，并保留 taskId、planVersionId、attemptId、Tool Artifact、Visual Asset、Evidence Manifest、Deliverable 和 Report Package ID。

## 17. 真实验收任务

使用以下原始输入，不改写问题：

> 请对比中国主流电商平台的 AI 购物助手在消费者决策支持体验上的差异，重点比较需求理解、推荐可解释性、商品参数与价格对比、内容可信度、购买转化闭环，并给出京东下一季度产品优先级建议。仅使用 2025 至 2026 年公开可访问资料，所有关键结论必须附可追溯来源。

### 17.1 计划验收

- 候选计划至少包含 Tavily、Playwright 和 `competitive-web-research`。
- Playwright 步骤晚于 Tavily，早于 Skill。
- Playwright 的 `/pages` 只绑定 Tavily `/results`，没有手写 URL。
- 五个对比维度全部进入 ResearchTask、ProblemGraph 和 Skill 输入。
- 若采用等权评分，计划页面明确显示每项 20% 的可确认假设。
- 所有步骤 `requires_approval=false`，因为任务只读公开信息且无登录操作。

### 17.2 运行验收

- Tavily receipt 为 real，来源时间范围符合 2025 至 2026 年要求。
- Playwright receipt 为 real，`implementationId=playwright-page-capture-v1`。
- 至少 3 个可访问平台各有 1 张有效视觉证据；其余平台若受访问控制限制，必须逐项形成 gap。
- 每张图有内部资产 URL、来源页 URL、获取时间、页面标题、方式、尺寸和哈希。
- 报告至少包含 1 张已验证评分权重图；图表明确表示研究权重，不表示市场表现。
- 需求理解、推荐可解释性、参数与价格对比、内容可信度、转化闭环五个模块均有整合结论。
- 每个大标题中英文并列，标题下有模块目的说明。
- 关键事实引用可从报告打开到 2025 至 2026 年公开来源。
- 页面刷新后可在历史任务重新打开同一报告，图片和图表不丢失。
- Markdown 或打印导出不包含原站图片热链和 Base64。

### 17.3 状态验收

- 全部 required evidence 满足且无页面缺口时为 `completed`。
- 文本证据满足，但存在截图访问失败时为 `completed_with_gaps`。
- Tavily required evidence 不满足、Artifact 完整性失败或来源绑定失败时不得完成。

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

Playwright 作为根项目运行依赖写入 lockfile。浏览器安装是部署步骤，运行时不得发现缺失后自动联网下载。

### 18.2 CI 与部署

- Linux 构建机使用 `pnpm exec playwright install --with-deps chromium`，macOS 开发机使用 `pnpm exec playwright install chromium`。
- 浏览器缓存键包含 lockfile 中的 Playwright 版本。
- Worker 需要可写的临时目录，但截图不得依赖临时文件持久化。
- 部署环境必须提供阻断内网和云元数据地址的出站规则。
- 现有 `TAVILY_API_KEY` 继续使用，没有新密钥或第三方账户。
- 不需要 SearXNG、Docker、Chrome 用户 Profile 或 ai-spider 之外的新服务。

## 19. 发布与回滚

### 19.1 发布顺序

1. 升级开发与 CI Node 到 22，安装 Chromium。
2. 合入工作包 A、B，Registry 保持 `draft`。
3. 运行 Artifact、重试、安全与恢复测试。
4. 合入工作包 C、D，定向测试通过后将 Tool 改为 `active`。
5. 运行 `pnpm quality`。
6. 运行真实验收任务并人工打开每个视觉来源。
7. 由独立研究员检查图片是否支持相邻结论、图表口径是否诚实、缺口是否完整披露。
8. 通过后部署生产 Worker 和 Web。

### 19.2 回滚

执行层回滚不删除数据：

1. 将 `playwright-page-capture` 状态改为 `draft`。
2. 从 `competitive-web-research.required_tools` 移除该 Tool。
3. 部署后新任务恢复文本研究路径。
4. 保留 `browser_capture`、`chart_render` 的类型、Schema 和读取逻辑，使已生成历史报告继续可读。

只有确认环境中没有新来源类型 Artifact 时，才允许整体回退对应读取合同。已封存 Artifact 和审计记录不做破坏性清理。

## 20. 风险与前提

| 风险 | 控制 |
|---|---|
| 公开站点反爬、验证码或地区差异 | 不绕过，按页面记录 gap，文本路径继续 |
| 浏览器内存和执行时间增长 | 页面、并发、字节、像素和总超时硬上限 |
| 恶意页面访问内网 | 来源必须来自 Tavily，浏览器路由执行公网地址检查，部署环境再做出站阻断 |
| sidecar 与 JSON 脱节 | attachment ID、指针、尺寸和三重 SHA-256 校验 |
| 半发布 Artifact 被历史报告发现 | 步骤发布前整批封存，失败补偿和 recovery 失效 |
| LLM 编造 Asset ID 或来源 | 只向 LLM 提供已验证 inventory，服务层再校验精确引用 |
| 图表制造虚假精确度 | 只画冻结权重等结构化数据，不从定性文字推算数值 |
| 依赖升级影响构建 | 根 lockfile 锁定 Playwright，Node 22 和 Chromium 安装进入 CI 门禁 |

本方案最脆弱的前提是 Tavily 能返回无需登录、可由浏览器访问的真实来源页。如果该前提不成立，Playwright 不会产生图片，任务会以 `completed_with_gaps` 完成文本报告，并逐项披露视觉证据缺口，不会改用生成图或不可追溯热链填补。

## 21. 完成定义

以下条件全部满足才算完成：

- 代码、Schema、Registry、Skill 和文档合同一致。
- Node 22、Playwright 与 Chromium 在本机和 CI 可重复安装。
- 媒体 sidecar 不进入 JSON、日志或数据库字段。
- 浏览器截图通过 VisualAssetService 和 Evidence Manifest 封存。
- 竞品报告支持单图证据，并保留原图与标注图的严格比较合同。
- 权重图表不再依赖用户上传图片。
- Web 历史任务、图片查看、证据展开、Markdown 和打印导出均通过。
- 所有定向测试和 `pnpm quality` 通过。
- 真实验收任务完成，来源、图片、图表、状态和 gap 经人工复核。
- 回滚演练确认禁用新 Tool 后，已有历史报告仍可读取。

本方案没有阻塞实施的未决产品选择。公开站点可访问性属于运行时外部条件，已经通过 gap 语义处理，不需要在编码阶段重新决定架构。
