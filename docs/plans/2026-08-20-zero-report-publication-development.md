# Report Package 发布到 Zero 开发文档

> 状态：开发中。Gate 0、Phase 1 与 Phase 2 已完成，当前进入 Phase 3。
>
> 本文是“发送到 Zero”能力的设计真相源。实现范围、接口、状态机、图片传输、幂等、回滚和验收均以本文为准。
>
> 执行清单：`docs/plans/2026-08-20-zero-report-publication-todolist.md`

## 1. 目标

在已完成的 Current 研究任务中增加“发送到 Zero”操作。用户点击后，系统读取已验证的 Report Package，将报告结构和可导出的视觉资产转换为 Zero 可编辑长页，并返回 Zero 根节点 ID。

用户流程：

```text
打开已完成报告
  -> 点击“发送到 Zero”
  -> 检查本机 Zero MCP
  -> 确认当前 Zero 页面和发布模式
  -> 创建 Zero 草稿结构
  -> 压缩并写入图片
  -> 校验节点、IMAGE fill 和截图
  -> 保存发布回执
  -> 返回 Zero rootNodeId
```

这是一条报告完成后的显式发布链，不参与 ResearchTaskV2、ProblemGraph、Skill 选择、Execution DAG 或报告生成。

## 2. 非目标

第一版不包含：

- 报告完成后自动发布。
- 未完成、paused、failed 或 rejected 任务发布。
- 从 Zero 回写 ResearchTask、Plan、Evidence 或 Deliverable。
- 远端 Web 服务器直接访问用户电脑上的 Zero。
- Zero 多文件批量发布。
- Zero 页面内交互原型。
- 将原始 SEALED Artifact 替换为压缩图。
- 发布被 `exportPolicy=block` 的视觉资产。
- 修改 Skill Registry、Tool Registry、PlanCompiler 或 LeaseExecutionEngine。
- 修改 ReportDocument 合同。

## 3. 当前验证结论

2026-08-20 已在 Zero 3.12.8 上完成一次真实手工链路验证：

- Zero MCP 地址：`http://127.0.0.1:27618/mcp`
- Zero 登录状态：authenticated
- `use_design_html` 可创建可编辑长页。
- `replaceNodeId` 可覆盖已有节点，但会先删除旧节点。
- `use_design_html` 的 `htmlContent` 上限为 500,000 字符。
- data URL 图片通过 `use_design_html` 会生成灰色占位，不会自动形成 IMAGE fill。
- `use_design_script` 的 agent VM 无法访问调用方本机临时 HTTP 地址。
- `use_design_script` 的 `code` 上限为 50,000 字符。
- 将图片压缩、切片后，通过 `relay.base64Decode()`、`relay.createImage()` 和 IMAGE fill 可以写入真实图片。
- `get_design_metadata` 可以校验节点结构和尺寸。
- `get_screenshot` 可以生成整页和局部截图。
- 通过读取节点 fills 可以确认图片是否真正写入。

这组约束决定第一版采用“HTML 结构写入 + 图片分片脚本写入”的两阶段发布。

## 4. Primary Setpoint

用户在一个已完成的 multimodal 报告页面点击“发送到 Zero”，系统在当前 Zero 页面创建一份可编辑稿件。稿件包含报告正文、指标、图表和允许导出的视觉证据；发布结果经过 metadata、IMAGE fill 和 screenshot 三层验证，并保存可重放的发布回执。

## 5. Acceptance

- 已完成任务显示“发送到 Zero”按钮。
- Zero 离线时不创建发布记录，界面显示可操作提示。
- 服务端只读取 owner 可访问的完成任务。
- 服务端从 SEALED Report Package 读取 ReportDocument 和 visual manifests。
- `exportPolicy=block` 视觉资产不进入 Zero。
- HTML 写入后返回唯一 rootNodeId。
- 所有 chart、image 和 image-comparison 最终对应真实 IMAGE fill。
- 超长图按稳定顺序切片，原图和标注图保持一一配对。
- 整页 metadata 尺寸覆盖全部内容，没有内容超出 root frame。
- 发布完成后生成整页截图和视觉证据章节截图。
- 重复 Idempotency-Key 不创建重复稿件。
- 更新发布先创建并验证新稿，再替换旧稿。
- 发布失败不改变原 Report Package 和 SEALED Artifact。
- 发布完成后保存 task、plan、attempt、report package、Zero 文件、页面和根节点绑定。
- `pnpm typecheck`、相关测试和 Web build 通过。

## 6. Guardrails

- Zero 写入只能由用户显式点击触发。
- 客户端不能提交任意 Report Package Artifact ID，服务端从 task 当前完成状态解析。
- 客户端不能提交任意本地文件路径或图片字节。
- Zero MCP URL 只允许 loopback HTTP 地址。
- Zero MCP 返回的 fileKey、pageId、nodeId 必须按 schema 校验。
- 禁止把项目 JWT、LLM Token、数据库连接或未脱敏错误发送给 Zero。
- 图片压缩副本只存在于发布工作区或内存，不覆盖原 Artifact。
- 发布操作不改变 task 状态、stateVersion、activePlanVersionId 或 currentAttemptId。
- 外部 Zero 操作失败时，不得把 publication 标记为 completed。
- 验证前创建的 Zero 节点必须带 deterministic draft name，便于恢复和清理。
- 更新旧稿时，不直接使用 `replaceNodeId` 覆盖可用稿件。

## 7. Premise Collapse

本方案假设 Agent API 与 Zero 桌面端运行在同一台电脑，Agent API 能访问 `127.0.0.1:27618`。

如果项目部署到远端服务器：

```text
远端 Agent API 的 127.0.0.1
!=
用户电脑的 Zero MCP
```

此时 `ZeroMcpClient` 必须移动到用户本机 Connector。服务端仍负责创建 publication job、准备 export package 和保存回执，本机 Connector 负责领取 job 并调用 Zero MCP。本文的 Renderer、Transcoder、状态机和回执合同保持不变。

第一版只支持同机模式，但 Adapter seam 必须允许后续替换为 Connector。

## 8. 架构

```text
CurrentStage4Report
  |
  | POST publication
  v
ZeroPublicationRoute
  |
  v
ZeroPublicationService
  |-- CurrentReportPackageReader
  |-- ZeroReportRenderer
  |-- ZeroImageTranscoder
  |-- ZeroMcpPort
  |-- ZeroPublicationRepository
  `-- ControlArtifactStore

ZeroMcpPort
  `-- LocalZeroMcpClient -> http://127.0.0.1:27618/mcp
```

### 8.1 Module 与 Interface

| Module | Interface | 负责 |
|---|---|---|
| `ZeroPublicationService` | completed task + owner + target -> publication | 发布编排、状态推进、回滚 |
| `ZeroReportRenderer` | ReportDocument + export asset descriptors -> HTML draft | 报告 block 到静态 HTML |
| `ZeroImageTranscoder` | verified image/chart bytes -> script-safe slices | 格式转换、压缩、切片、节点映射 |
| `ZeroMcpPort` | status / create draft / write image / inspect / screenshot | Zero 协议调用 |
| `ZeroPublicationRepository` | create / claim / update / complete / fail | 幂等、状态、回执、恢复 |

`ZeroPublicationService` 是对路由和测试开放的深 Module。路由不读取 Artifact、不生成 HTML、不压缩图片，也不直接调用 MCP。

## 9. 复用现有能力

直接复用：

- `CurrentReportPackageReader`
- `ControlArtifactStore.readVerifiedJson()`
- `ControlArtifactStore.readVerifiedBinary()`
- `ReportDocument`
- `VisualAssetManifest`
- `ReportDocument` 中的 `image`、`image-comparison` 和 `chart` block
- task owner 隔离
- Idempotency-Key 处理习惯
- Current Web 报告工具栏

不复用：

- 浏览器 Blob URL。Zero 无法访问浏览器对象 URL。
- `/api/control-tasks/:id/assets/:assetId` 的 JWT URL。Zero agent VM 不携带项目 JWT。
- data URL HTML 图片。真实验证显示它只生成占位节点。
- localhost 临时图片 URL。Zero agent VM 无法访问调用方本机端口。

## 10. 公开接口

### 10.1 Zero 状态

```text
GET /api/integrations/zero/status
```

响应：

```ts
interface ZeroIntegrationStatusResponse {
  available: boolean;
  authenticated: boolean;
  version?: string;
  currentFileKey?: string;
  currentPageId?: string;
  currentPageName?: string;
  reason?: 'offline' | 'unauthenticated' | 'no_design_tab' | 'protocol_error';
}
```

该接口只返回状态和当前目标上下文，不返回 Zero 用户隐私信息。

### 10.2 创建发布

```text
POST /api/control-tasks/:id/publications/zero
Idempotency-Key: <uuid>
```

请求：

```ts
interface CreateZeroPublicationRequest {
  expectedTaskState: 'completed' | 'completed_with_gaps';
  target: {
    mode: 'current_page';
  };
  updatePublicationId?: string;
}
```

第一版只支持 `current_page`。服务端从 task 解析 active plan、current attempt 和 Report Package，不接受客户端提交这些 ID。更新发布只接受同一 task、同一 owner 的 completed `updatePublicationId`，服务端从旧 publication 解析 rootNodeId、fileKey 和 pageId；客户端不能指定任意 Zero nodeId。

响应状态码：

- `202`：publication 已创建或正在执行。
- `200`：相同 Idempotency-Key 已完成，返回 replay。
- `404`：任务不存在或不属于当前用户。
- `409`：任务未完成、Zero 当前页面变化或幂等冲突。
- `422`：报告不支持发布或没有可导出的内容。
- `503`：Zero 离线或未登录。

响应：

```ts
interface CreateZeroPublicationResponse {
  publicationId: string;
  status: ZeroPublicationStatus;
}
```

### 10.3 查询发布

```text
GET /api/control-tasks/:id/publications/zero/:publicationId
```

响应：

```ts
interface ZeroPublicationResponse {
  id: string;
  taskId: string;
  status: ZeroPublicationStatus;
  stage: ZeroPublicationStage;
  progress: number;
  rootNodeId?: string;
  pageId?: string;
  pageName?: string;
  fileKey?: string;
  screenshotAssetIds?: string[];
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  createdAt: string;
  updatedAt: string;
}
```

## 11. 状态机

```ts
export type ZeroPublicationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export type ZeroPublicationStage =
  | 'checking_zero'
  | 'reading_report'
  | 'rendering_html'
  | 'creating_draft'
  | 'transcoding_images'
  | 'writing_images'
  | 'verifying_metadata'
  | 'verifying_fills'
  | 'capturing_screenshots'
  | 'finalizing_receipt';
```

状态推进：

```text
queued
  -> running/checking_zero
  -> reading_report
  -> rendering_html
  -> creating_draft
  -> transcoding_images
  -> writing_images
  -> verifying_metadata
  -> verifying_fills
  -> capturing_screenshots
  -> finalizing_receipt
  -> completed
```

任一阶段失败进入 `failed`。失败记录当前 stage、错误码、是否可重试和已创建的 Zero rootNodeId。

## 12. Durable Entity

新增一张表：

```text
control_zero_publications
```

字段：

```text
id UUID PRIMARY KEY
 task_id UUID NOT NULL
 owner_user_id UUID NOT NULL
 plan_version_id UUID NOT NULL
 attempt_id UUID NOT NULL
 report_package_artifact_id UUID NOT NULL
 report_package_hash TEXT NOT NULL
 idempotency_key TEXT NOT NULL
 request_hash TEXT NOT NULL
 template_version TEXT NOT NULL
 status TEXT NOT NULL
 stage TEXT NOT NULL
 progress INTEGER NOT NULL
 zero_file_key TEXT
 zero_page_id TEXT
 zero_page_name TEXT
 draft_root_node_id TEXT
 final_root_node_id TEXT
 update_publication_id UUID REFERENCES control_zero_publications(id)
 update_root_node_id TEXT
 zero_node_map JSONB
 image_manifest JSONB
 screenshot_manifest JSONB
 failure_json JSONB
 lease_owner TEXT
 lease_expires_at TIMESTAMPTZ
 created_at TIMESTAMPTZ NOT NULL
 updated_at TIMESTAMPTZ NOT NULL
 completed_at TIMESTAMPTZ
```

约束：

```text
UNIQUE(task_id, idempotency_key)
CHECK(status IN ('queued','running','completed','failed'))
CHECK(progress BETWEEN 0 AND 100)
```

增加索引：

```text
(task_id, created_at DESC)
(status, updated_at)
```

### 12.1 为什么不用 ControlArtifact 代替

Artifact 适合保存不可变产物，不适合表达长任务的 queued、running、stage、lease 和 failed 状态。publication 完成后，发布回执仍写成一个 SEALED Artifact，但 job 状态保存在独立表中。

### 12.2 发布回执 Artifact

完成后写入：

```text
kind: zero_publication_receipt
schemaVersion: zero-publication-receipt-v1
relativePath: publications/zero/<publicationId>.json
```

内容包括：

- task、plan、attempt
- Report Package Artifact 和 hash
- template version
- Zero file、page、root node
- block 到 node 映射
- image slice 到 node 和 imageHash 映射
- metadata 验证结果
- fill 验证结果
- screenshot 信息
- 发布时间

## 13. ZeroMcpPort

```ts
interface ZeroMcpPort {
  getStatus(): Promise<ZeroClientStatus>;
  getCurrentTarget(): Promise<ZeroTargetContext>;
  createHtmlDraft(input: {
    html: string;
    name: string;
    x?: number;
    y?: number;
  }): Promise<{ rootNodeId: string; x: number; y: number; width: number; height: number }>;
  writeImage(input: {
    pageName: string;
    nodeId: string;
    bytes: Uint8Array;
    description: string;
  }): Promise<{ nodeId: string; imageHash: string }>;
  inspectNode(nodeId: string): Promise<ZeroNodeInspection>;
  captureScreenshot(nodeId: string, maxDimension: number): Promise<ZeroScreenshot>;
  finalizeDraft(input: {
    draftRootNodeId: string;
    finalName: string;
    updateRootNodeId?: string;
  }): Promise<{ finalRootNodeId: string }>;
  cleanupDraft(rootNodeId: string): Promise<void>;
}
```

### 13.1 LocalZeroMcpClient

- 默认 URL：`http://127.0.0.1:27618/mcp`
- URL 必须解析为 loopback 地址。
- Accept：`application/json, text/event-stream`
- 支持无 session header 的 stateless MCP。
- 初始化后读取 tools/list，确认所需工具存在。
- 调用前确认 `get_zero_status.authenticated=true`。
- 需要工具：
  - `resources_list`
  - `resources_read`
  - `get_zero_status`
  - `get_design_metadata`
  - `get_design_context`
  - `get_screenshot`
  - `use_design_html`
  - `use_design_script`
- 调用 `use_design_html` 前加载 `file://use-design-html/SKILL.md`。
- 调用 `use_design_script` 前加载：
  - `file://use-design-script/SKILL.md`
  - `file://use-design-script/references/relay-plugin-api-index.md`
  - 涉及图片时读取 API 中的 `createImage`、`base64Decode` 和 IMAGE paint 定义。

## 14. ZeroReportRenderer

### 14.1 输入

- verified `ReportDocument`
- verified `VisualAssetManifest[]`
- image placeholder descriptors
- publication id
- template version

### 14.2 输出

```ts
interface ZeroHtmlDraft {
  html: string;
  name: string;
  expectedWidth: number;
  expectedMinimumHeight: number;
  placeholders: Array<{
    key: string;
    nodeName: string;
    blockId: string;
    role: 'image' | 'image_original' | 'image_annotation' | 'chart';
  }>;
}
```

### 14.3 Block 映射

| Report block | Zero HTML |
|---|---|
| paragraph | 文字段落 |
| list | 列表或行动清单 |
| metric | 指标卡 |
| fact | 事实结论块 |
| image | 图片占位 + caption |
| image-comparison | 原图与标注图配对 |
| chart | 图表占位 + table alternative |

### 14.4 HTML 约束

- 纯静态 HTML。
- 不含 script、事件处理器、远程 JS、接口请求和 localStorage。
- CSS 内联。
- 固定页面宽度 1440px。
- section、image、chart 使用稳定 `data-ai-alt`。
- 每个图片 placeholder 有唯一 node name。
- 关键文本必须为 DOM 文本。
- template version 固定为 `zero-report-v1`。
- `htmlContent` 不超过 500,000 字符。

## 15. ZeroImageTranscoder

### 15.1 输入规则

只处理 ReportDocument 实际引用的 Visual Asset：

- image.assetRef
- image-comparison.beforeAssetRef
- image-comparison.afterAssetRef
- chart.chartRef

读取时要求：

- Artifact 为 SEALED。
- task、plan、attempt 与 Report Package 一致。
- manifest hash 和 content hash 匹配。
- exportPolicy 为 allow 或 mask。
- block 直接拒绝发布该 block，并按模板输出“不可导出”说明。

### 15.2 格式策略

| 输入 | 发布格式 |
|---|---|
| JPEG | JPEG |
| PNG 普通截图 | JPEG，白底 flatten |
| PNG 需要透明背景 | PNG |
| SVG chart | 转 PNG |
| 超长截图 | 垂直切片后 JPEG |

### 15.3 尺寸和体积算法

固定参数：

```text
DEFAULT_RASTER_WIDTH = 400
DEFAULT_JPEG_QUALITY = 45
MIN_RASTER_WIDTH = 240
MIN_JPEG_QUALITY = 28
MAX_SCRIPT_CODE_CHARS = 50000
MAX_IMAGE_BASE64_CHARS = 44000
SCRIPT_OVERHEAD_BUDGET = 4000
```

算法：

1. 按目标页面列宽计算展示宽度。
2. 先以 400px、quality 45 转换。
3. 如果 Base64 超过 44,000 字符，优先垂直切成更多片段。
4. 每个片段重新转换。
5. 仍超限时逐步降低 quality，最低 28。
6. 仍超限时逐步降低宽度，最低 240。
7. 最低参数仍超限则继续切片，不再降低清晰度。
8. 所有片段按 top 坐标排序。
9. 原图和标注图使用相同切片边界。

不得通过把整张长图压到极低质量来满足代码上限。

### 15.4 图片脚本

每张图片单独调用一次 `use_design_script`：

```text
setCurrentPageAsync(targetPage)
getNodeByIdAsync(placeholderNodeId)
base64Decode(encodedBytes)
createImage(bytes)
set fills = IMAGE / FIT
return mutatedNodeIds + imageHash
```

每次脚本调用前检查最终 code 长度不超过 50,000 字符。

## 16. 两阶段发布

### 16.1 新建发布

1. 读取 Zero status、当前 file 和 page。
2. 创建 publication row，冻结 target context。
3. 读取并验证 Report Package。
4. 生成 HTML 和 placeholder manifest。
5. 调 `use_design_html` 创建 draft root。
6. draft 名称包含 publication id：

```text
[ai-x-draft:<publicationId>] <report title>
```

7. 立即保存 draftRootNodeId。
8. 从 metadata 找到 placeholder node IDs。
9. 转码并逐张写入 IMAGE fill。
10. 校验所有 fill。
11. 校验 root 尺寸和 section 边界。
12. 截取视觉证据 section 和 root。
13. 将 draft 重命名为最终标题。
14. 写 publication receipt Artifact。
15. 标记 completed。

### 16.2 更新发布

不直接覆盖旧 root：

1. 在旧稿右侧创建新 draft。
2. 完成全部图片和验证。
3. 记录旧 root 的 x、y。
4. 将新 root 移到旧 root 位置。
5. 删除旧 root。
6. 将 new root 记录为 finalRootNodeId。

如果第 1 到 4 步失败，旧 root 保持不变。如果删除旧 root 失败，保留两份稿件并将 publication 标为 failed，failure code 为 `zero_swap_incomplete`，不得删除新稿。

## 17. 验证

### 17.1 Metadata 验证

- root node 存在。
- name 与 publication 匹配。
- width 等于 renderer 目标宽度。
- height 覆盖最后一个 section 和 footer。
- section 数量与 ReportDocument 对齐。
- placeholder node name 唯一。

### 17.2 Fill 验证

对每个图片节点读取：

```text
fills.length = 1
fills[0].type = IMAGE
fills[0].imageHash = transcode result imageHash
fills[0].scaleMode = FIT
```

任一图片仍为 SOLID 或灰色占位，publication 失败。

### 17.3 Screenshot 验证

固定生成：

- root screenshot，maxDimension 4096。
- 每个 visual evidence section screenshot，maxDimension 4096。
- 每个 chart section screenshot，maxDimension 3000。

Agent API 在短期 URL 有效时下载截图字节。下载地址必须与 `ZERO_MCP_URL` 同源、路径以 `/assets/` 开头、禁止重定向，并限制为 10 MiB 的 PNG。下载后通过 `ControlArtifactStore.writeBinary()` 保存：

```text
kind: zero_publication_screenshot
schemaVersion: zero-publication-screenshot-v1
relativePath: publications/zero/<publicationId>/<nodeId>.png
sensitivity: internal
```

截图 Artifact 绑定原 task、plan 和 attempt。发布回执保存 screenshot Artifact ID、目标 nodeId、尺寸和校验时间，不保存短期 URL。截图下载或 Artifact 写入失败时，publication 失败。

## 18. 幂等与并发

### 18.1 Request hash

request hash 包含：

- task id
- owner id
- report package artifact id
- report package hash
- target fileKey
- target pageId
- update publication 和旧 root node
- template version

相同 Idempotency-Key：

- request hash 相同且 completed：返回原结果。
- request hash 相同且 queued/running：返回当前 publication。
- request hash 不同：409。

### 18.2 Publication lease

同一 publication 只有一个 worker：

```text
lease_owner
lease_expires_at
```

heartbeat 间隔 15 秒，lease 60 秒过期。进程重启后，Recovery Worker 可以接管 expired running publication。

### 18.3 外部状态恢复

恢复时按顺序：

1. 查询 publication 是否已有 draftRootNodeId。
2. 如果没有，根据 deterministic draft name 搜索当前 target page。
3. 找到唯一 draft 时补写 rootNodeId。
4. 找到多个 draft 时停止并标记 `zero_ambiguous_draft`。
5. 检查已写 IMAGE fill，跳过已完成节点。
6. 从第一个未完成 stage 继续。

## 19. 失败码

```text
zero_offline
zero_unauthenticated
zero_missing_tools
zero_no_design_tab
zero_target_changed
report_not_completed
report_package_missing
report_package_invalid
visual_asset_blocked
visual_asset_invalid
html_too_large
html_write_failed
placeholder_missing
image_transcode_failed
image_script_too_large
image_write_failed
image_fill_missing
metadata_mismatch
screenshot_failed
zero_ambiguous_draft
zero_swap_incomplete
publication_lease_lost
```

错误返回前必须脱敏，不包含本地路径、JWT、MCP 原始堆栈和完整 Base64。

## 20. Web 交互

### 20.1 按钮位置

在 `CurrentStage4Report` 的报告操作区，与“打印 / PDF”“下载 Markdown ZIP”并列：

```text
打印 / PDF
下载 Markdown ZIP
发送到 Zero
```

### 20.2 可用条件

- presentationMode 为 multimodal。
- task 为 completed 或 completed_with_gaps。
- Zero status available 且 authenticated。

Zero 离线时按钮保留但 disabled，旁边显示“打开 Zero 桌面端并启用 MCP”。

### 20.3 确认面板

点击后显示：

- 报告标题。
- 当前 Zero file 和 page。
- 发布类型：新建或更新。
- 更新时显示旧 rootNodeId。
- 视觉资产数量和预计切片数。
- 明确说明会写入当前 Zero 页面。

用户确认后才创建 publication。

### 20.4 进度

```text
正在检查 Zero
正在准备报告
正在创建页面结构
正在压缩视觉资产
正在写入图片 3 / 7
正在验证稿件
正在生成验收截图
已发送到 Zero
```

完成后显示 rootNodeId。失败时保留重试按钮，相同请求复用原 publication。

## 21. 配置

新增环境变量：

```text
ZERO_MCP_URL=http://127.0.0.1:27618/mcp
ZERO_PUBLICATION_ENABLED=true
```

规则：

- `ZERO_MCP_URL` 只接受 `http://127.0.0.1:<port>`、`http://localhost:<port>` 或 IPv6 loopback。客户端不跟随重定向，URL 不能来自请求参数。
- 生产远端部署默认 `ZERO_PUBLICATION_ENABLED=false`，直到本机 Connector 可用。
- 图片尺寸、质量和代码长度使用代码常量，不暴露为环境变量。

## 22. 文件范围

预计新增：

```text
packages/api-contract/zero-publication.ts
apps/agent-api/src/integrations/zero/zero-mcp-client.ts
apps/agent-api/src/integrations/zero/zero-report-renderer.ts
apps/agent-api/src/integrations/zero/zero-image-transcoder.ts
apps/agent-api/src/integrations/zero/zero-publication-service.ts
apps/agent-api/src/routes/zero-publications.ts
database/migrations/014_zero_publications.sql
tests/zero-mcp-client.test.ts
tests/zero-report-renderer.test.ts
tests/zero-image-transcoder.test.ts
tests/zero-publication-service.test.ts
tests/zero-publication-api.test.ts
```

预计修改：

```text
apps/agent-api/src/control-runtime.ts
apps/agent-api/src/server.ts
apps/web/src/api/client.ts
apps/web/src/components/stages/CurrentStage4Report.tsx
apps/web/src/theme.css
database/control-plane.ts
```

总范围超过 8 个文件，并新增一个 durable entity。实现必须分阶段提交，每阶段独立可构建。

## 23. 测试矩阵

| Requirement | Test |
|---|---|
| 只接受 loopback URL | `zero-mcp-client.test.ts` |
| 解析 SSE MCP 响应 | `zero-mcp-client.test.ts` |
| 缺工具 fail closed | `zero-mcp-client.test.ts` |
| screenshot URL 同源、无重定向和体积限制 | `zero-mcp-client.test.ts` |
| HTML 无 script 和远程 JS | `zero-report-renderer.test.ts` |
| block 与节点命名稳定 | `zero-report-renderer.test.ts` |
| data URL 不进入 HTML | `zero-report-renderer.test.ts` |
| 长图按同边界切片 | `zero-image-transcoder.test.ts` |
| 单脚本不超过 50KB | `zero-image-transcoder.test.ts` |
| SVG chart 转 PNG | `zero-image-transcoder.test.ts` |
| 原 Artifact 不变 | `zero-image-transcoder.test.ts` |
| 非 owner 404 | `zero-publication-api.test.ts` |
| 未完成任务 409 | `zero-publication-api.test.ts` |
| Zero 离线 503 | `zero-publication-api.test.ts` |
| Idempotency replay | `zero-publication-service.test.ts` |
| 新建发布成功 | `zero-publication-service.test.ts` |
| 图片填充失败清理 draft | `zero-publication-service.test.ts` |
| 更新失败保留旧稿 | `zero-publication-service.test.ts` |
| metadata 越界失败 | `zero-publication-service.test.ts` |
| screenshot 下载并保存 SEALED Artifact | `zero-publication-service.test.ts` |
| SOLID 占位失败 | `zero-publication-service.test.ts` |
| Recovery 接管 expired lease | `zero-publication-service.test.ts` |
| Web 按钮状态 | 前端 source test + Web build |
| 真实 Zero 写入 | 手工验收 |

## 24. 测试执行策略

测试按 Phase 批量执行，不按函数、文件或小功能执行。

- Gate 0 只运行一次基线 typecheck、报告相关测试和 Web build。
- 每个 Phase 先一次性写完该阶段的测试，再统一运行一次红灯检查。
- 红灯确认后完成该 Phase 的全部实现，中间不因完成单个 Module、函数或路由重复跑测试。
- Phase 结束时只运行该阶段定向测试、一次 typecheck 和一次 `git diff --check`。
- 阶段门禁失败时，只重跑直接失败的测试文件；修复完成后再运行一次阶段门禁。
- `pnpm quality` 只在最终 Gate 7 运行。独立审查产生代码修改时，再补跑一次。
- Web build 只在 Gate 0、包含 Web 改动的 Phase 5 和最终 Gate 7 运行。
- 真实 Zero MCP 验收只在 Phase 6 运行，不在日常小改动后重复发布。

测试目标是守住阶段接口和外部副作用，不追求每个私有辅助函数都有独立测试。优先覆盖 Module Interface、失败回滚、幂等、图片传输和真实 Zero 边界。

## 25. 实施阶段

### Phase 1：合同、Migration 和失败测试

交付：共享类型、表结构、Repository Interface、全部失败测试骨架。无 UI，无 Zero 写入。

### Phase 2：MCP Client

交付：status、resource 读取、HTML 写入、脚本写入、metadata、screenshot。使用 fake MCP server 覆盖协议。

### Phase 3：Renderer 与 Transcoder

交付：ReportDocument 到 HTML，以及图片切片、压缩和 script payload。纯 Module，无网络副作用。

### Phase 4：Publication Service

交付：新建发布、图片写入、验证、回执、失败清理、恢复。

### Phase 5：HTTP 与 Web

交付：状态接口、发布接口、查询接口、“发送到 Zero”按钮和进度。

### Phase 6：真实 Zero 验收

交付：至少一份 multimodal 报告发布成功，图片真实可见，metadata/fill/screenshot 验证通过。

每个 Phase 独立提交，后续 Phase 未完成时，前一 Phase 仍保持 typecheck 和测试通过。

## 26. 验证命令

```bash
pnpm typecheck
pnpm exec tsx --test \
  tests/zero-mcp-client.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/zero-image-transcoder.test.ts \
  tests/zero-publication-service.test.ts \
  tests/zero-publication-api.test.ts
pnpm --dir apps/web build
pnpm quality
```

真实验收前检查：

```bash
curl -sS http://127.0.0.1:27618/mcp \
  -H 'Accept: application/json, text/event-stream'
```

## 27. 手工验收

1. 启动 Zero 桌面端并登录。
2. 打开目标设计文件和测试页面。
3. 打开一个已完成的 multimodal 报告。
4. 点击“发送到 Zero”。
5. 确认 file、page、视觉资产数量和发布模式。
6. 等待状态变为 completed。
7. 在 Zero 找到返回的 rootNodeId。
8. 检查标题、摘要、指标、结论、建议和风险。
9. 检查所有 chart 和 image 节点均显示真实图片。
10. 用 MCP 读回 fills，确认全部为 IMAGE。
11. 检查长图切片顺序和原图/标注图配对。
12. 检查整页高度覆盖 footer。
13. 检查整页和视觉证据截图。
14. 使用相同 Idempotency-Key 重试，确认不创建重复稿件。
15. 模拟图片写入失败，确认旧稿未被删除。
16. 关闭 Zero 后点击按钮，确认报告仍可阅读且提示明确。

## 28. Rollback

代码回滚：

- 关闭 `ZERO_PUBLICATION_ENABLED`。
- 保留 publication rows 和 receipt Artifacts 供审计。
- Web 隐藏或禁用按钮。
- 不删除已生成的 Zero 稿件。

单次发布回滚：

- completed publication 不自动删除 Zero 稿件，由用户显式删除。
- failed publication 如果只有 draft，服务端尝试清理 draftRootNodeId。
- 清理失败时保存 rootNodeId，提示用户手工处理。
- 更新失败时旧 root 保持不变。

数据库回滚：

- Migration 014 只新增独立表和索引，不修改现有 Control 表语义。
- 应用回滚后新表可保留，不影响任务和报告主链。

## 29. 完成定义

以下条件全部满足后，功能才算完成：

- 合同、Migration、Repository、MCP Client、Renderer、Transcoder、Service、Route 和 Web 均已实现。
- 自动化测试全部通过。
- 真实 Zero multimodal 发布通过。
- 图片不是占位色块。
- 发布回执可从 task 反查到 Zero rootNodeId。
- Zero 离线和失败场景不影响报告主链。
- 文档、TodoList 和最终 commit 状态一致。
