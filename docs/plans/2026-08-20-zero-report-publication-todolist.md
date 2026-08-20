# Report Package 发布到 Zero TodoList

> 对应开发文档：`docs/plans/2026-08-20-zero-report-publication-development.md`
>
> 规则：按顺序执行。每个 Gate 未通过前，不进入下一阶段。每个阶段独立提交，测试按 Phase 批量运行，不按小功能运行。
>
> 测试节奏：每个 Phase 先批量写完测试，统一跑一次红灯；随后完成整个 Phase 的实现，结束时统一跑一次绿灯门禁。实现单个函数、文件、Module 或路由后不立即跑测试。阶段门禁失败时只重跑直接失败的测试文件，`pnpm quality` 只在最终 Gate 7 和独立审查改动后运行。

## 当前已确认事实

- [x] 方案已获用户确认。
- [x] Zero MCP 已注册到 `http://127.0.0.1:27618/mcp`。
- [x] Zero 3.12.8 已登录，MCP 服务可用。
- [x] `use_design_html` 已验证可创建可编辑长页。
- [x] `use_design_script` 已验证可写入真实 IMAGE fill。
- [x] data URL 经 `use_design_html` 只生成图片占位，不作为实现路径。
- [x] Zero agent VM 不能访问调用方 localhost 临时图片服务。
- [x] 图片压缩、切片、Base64 单图脚本写入已在真实 Zero 稿件验证。
- [x] metadata、fill 和 screenshot 三层验证已跑通。
- [x] 一次完整报告发布验证未修改项目代码和原始 SEALED Artifact。

## 执行变量

实施前在独立分支或 worktree 中设置：

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_SHA="$(git rev-parse HEAD)"
FEATURE_BRANCH="feat/zero-report-publication"
ZERO_MCP_URL="http://127.0.0.1:27618/mcp"
export REPO_ROOT BASE_SHA FEATURE_BRANCH ZERO_MCP_URL
```

## Gate 0：冻结开发基线

- [x] 运行 `git status --short --branch -uall`，保存完整工作区清单。
- [x] 确认当前 Control flow、ReportDocument、Visual Asset 和 Report Package 改动已进入明确 commit。
- [x] 当前工作区存在未提交 WIP 时，不在原 checkout 开始实现。
- [x] 从包含当前报告主链的 commit 创建 `feat/zero-report-publication`。
- [x] 为实现创建独立 worktree。
- [x] 确认 worktree clean。
- [x] 记录 `BASE_SHA`、Node 和 pnpm 版本。
- [x] 运行基线 `pnpm typecheck`。
- [x] 运行基线 `pnpm --dir apps/web build`。
- [x] 运行基线相关报告测试。
- [x] 确认只有一个 writer 修改该 worktree。

### Gate 0 完成条件

```text
clean worktree
明确 BASE_SHA
基线 typecheck 通过
基线 Web build 通过
当前报告测试通过
```

## Phase 1：共享合同与数据库

- [x] 批量完成本 Phase 的合同、Migration、Repository 失败测试后，统一运行一次 Phase 1 定向命令并确认红灯；红灯后再开始生产实现。

### 1.1 先写失败测试

- [x] 创建 `tests/zero-publication-contract.test.ts`。
- [x] 断言 publication status 只允许 queued、running、completed、failed。
- [x] 断言 publication stage 使用开发文档冻结枚举。
- [x] 断言 create request 不接受 reportPackageArtifactId、planVersionId、attemptId 或任意 updateRootNodeId。
- [x] 断言更新只接受 `updatePublicationId`。
- [x] 断言 Zero node id 格式为 `数字:数字`。
- [x] 断言 progress 只能为 0 到 100 的整数。

### 1.2 实现合同

- [x] 创建 `packages/api-contract/zero-publication.ts`。
- [x] 定义 `ZeroPublicationStatus`。
- [x] 定义 `ZeroPublicationStage`。
- [x] 定义 `ZeroIntegrationStatusResponse`。
- [x] 定义 `CreateZeroPublicationRequest/Response`。
- [x] 定义 `ZeroPublicationResponse`。
- [x] 定义 `ZeroPublicationReceipt`。

### 1.3 Migration 失败测试

- [x] 创建 Migration 测试，验证 013 可从当前 schema 升级。
- [x] 验证同一 task 和 idempotency key 唯一。
- [x] 验证 status check constraint。
- [x] 验证 progress check constraint。
- [x] 验证 Migration 重跑幂等。

### 1.4 实现 Migration

- [x] 创建 `database/migrations/014_zero_publications.sql`。
- [x] 创建 `control_zero_publications`。
- [x] 增加 task、owner、plan、attempt、report package 外键。
- [x] 增加唯一约束与索引。
- [x] 更新 migration runner 测试清单。

### 1.5 Repository

- [x] 在 `database/control-plane.ts` 增加 publication 类型。
- [x] 实现 create/reserve。
- [x] 实现 claim lease/heartbeat。
- [x] 实现 update stage/progress。
- [x] 实现 record draft/final node IDs。
- [x] 实现 complete/fail。
- [x] 实现 get by owner。
- [x] 实现 list expired running publications。
- [x] 增加并发 claim、幂等 replay 和 lease lost 测试。

### Phase 1 门禁

结果：8 个定向测试通过，typecheck PASS，diff check PASS。

```bash
pnpm exec tsx --test \
  tests/zero-publication-contract.test.ts \
  tests/control-api-integration.test.ts
pnpm typecheck
```

- [x] Phase 1 测试通过。
- [x] `git diff --check` 通过。
- [x] 提交 Phase 1，commit 只包含合同、Migration、Repository 和测试。

## Phase 2：Zero MCP Client

- [x] 批量完成本 Phase 的 MCP 协议和失败路径测试后，统一运行一次 `tests/zero-mcp-client.test.ts` 并确认红灯。

### 2.1 失败测试

- [x] 创建 `tests/zero-mcp-client.test.ts`。
- [x] fake MCP server 返回 SSE `event: message`。
- [x] 测试 initialize 与 tools/list。
- [x] 测试 stateless MCP 无 Session-Id。
- [x] 测试带 Session-Id 的兼容分支。
- [x] 测试 406 Accept 错误。
- [x] 测试 offline。
- [x] 测试 authenticated=false。
- [x] 测试缺 `use_design_html`。
- [x] 测试缺 `use_design_script`。
- [x] 测试 screenshot URL 必须与 MCP 同源且路径以 `/assets/` 开头。
- [x] 测试 screenshot 下载禁止重定向。
- [x] 测试 screenshot Content-Type 必须为 image/png。
- [x] 测试 screenshot 超过 10 MiB 被拒绝。
- [x] 测试 MCP error result。
- [x] 测试 timeout。
- [x] 测试非 loopback URL 被拒绝。

### 2.2 实现 Client

- [x] 创建 `apps/agent-api/src/integrations/zero/zero-mcp-client.ts`。
- [x] 解析 JSON 和 SSE 响应。
- [x] 校验 loopback URL。
- [x] 实现 initialize。
- [x] 实现 tools/list 和 tools/call。
- [x] 实现 `getStatus()`。
- [x] 实现 `getCurrentTarget()`。
- [x] 实现 `createHtmlDraft()`。
- [x] 实现 `writeImage()`。
- [x] 实现 `inspectNode()`。
- [x] 实现 `captureScreenshot()`。
- [x] 实现 screenshot 短期 URL 的同源、路径、Content-Type、体积和无重定向校验。
- [x] 实现 `finalizeDraft()`。
- [x] 实现 `cleanupDraft()`。
- [x] 调用 HTML 工具前读取 `use-design-html/SKILL.md`。
- [x] 调用 script 工具前读取 Skill 和 API index。
- [x] 错误输出去掉本地路径、Base64 和原始堆栈。

### Phase 2 门禁

结果：5 个 MCP Client 测试通过，typecheck PASS，diff check PASS。

```bash
pnpm exec tsx --test tests/zero-mcp-client.test.ts
pnpm typecheck
```

- [x] Phase 2 测试通过。
- [x] `git diff --check` 通过。
- [x] 提交 Phase 2，只包含 MCP Port、Client 和测试。

## Phase 3：Report Renderer

- [x] 先批量完成 Renderer 与 Transcoder 的全部失败测试，统一运行两份测试文件并确认红灯，再开始本 Phase 实现。

### 3.1 失败测试

- [x] 创建 `tests/zero-report-renderer.test.ts`。
- [x] fixture 覆盖 paragraph、list、metric、fact。
- [x] fixture 覆盖 image、image-comparison、chart。
- [x] 断言 HTML 无 script。
- [x] 断言 HTML 无事件处理器。
- [x] 断言 HTML 无接口请求、localStorage 和远程 JS。
- [x] 断言 HTML 不包含图片 data URL。
- [x] 断言每个视觉 block 有唯一 placeholder name。
- [x] 断言 block 顺序与 ReportDocument 一致。
- [x] 断言 HTML 不超过 500,000 字符。
- [x] 断言 template version 进入 publication receipt 输入。

### 3.2 实现 Renderer

- [x] 创建 `apps/agent-api/src/integrations/zero/zero-report-renderer.ts`。
- [x] 固定 `zero-report-v1` 模板。
- [x] 映射 cover 和 executive summary。
- [x] 映射 section 标题和说明。
- [x] 映射 paragraph/list/fact。
- [x] 映射 metric 和 table alternative。
- [x] 为 image 创建 placeholder。
- [x] 为 image-comparison 创建原图/标注配对 placeholder。
- [x] 为 chart 创建 placeholder 和文本表格 fallback。
- [x] 加入 evidence boundary 和 gap 展示。
- [x] 添加 `data-ai-alt` 和业务语义名称。
- [x] 返回 expected width/minimum height 和 placeholder manifest。

## Phase 3B：Image Transcoder

### 3B.1 失败测试

- [x] 创建 `tests/zero-image-transcoder.test.ts`。
- [x] JPEG 保持 JPEG。
- [x] 普通 PNG flatten 为 JPEG。
- [x] 需要透明背景的 PNG 保持 PNG。
- [x] SVG chart 转 PNG。
- [x] 超长图按垂直顺序切片。
- [x] 原图和标注图使用相同切片边界。
- [x] 每个 Base64 不超过 44,000 字符。
- [x] 最低质量仍超限时增加切片，不继续降质。
- [x] block exportPolicy 被拒绝。
- [x] allow/mask 可导出。
- [x] task/plan/attempt 绑定不一致时拒绝。
- [x] 原始 Artifact bytes 和 hash 不变化。

### 3B.2 实现 Transcoder

- [x] 创建 `apps/agent-api/src/integrations/zero/zero-image-transcoder.ts`。
- [x] 使用现有 `sharp`，不新增图像依赖。
- [x] 实现目标宽度计算。
- [x] 实现格式策略。
- [x] 实现迭代质量和宽度策略。
- [x] 实现垂直切片策略。
- [x] 实现 original/annotation 共同切片边界。
- [x] 实现 chart PNG 转换。
- [x] 实现 Base64 和脚本长度预算检查。
- [x] 返回 slice key、placeholder key、bytes、media type、尺寸和 hash。

### Phase 3 完成门禁

结果：7 个 Renderer/Transcoder 测试通过，typecheck PASS，diff check PASS。

```bash
pnpm exec tsx --test \
  tests/zero-report-renderer.test.ts \
  tests/zero-image-transcoder.test.ts
pnpm typecheck
```

- [x] Phase 3 测试通过。
- [x] `git diff --check` 通过。
- [x] 提交 Phase 3，只包含 Renderer、Transcoder 和测试。

## Phase 4：Publication Service

- [x] 批量完成 Service、外部副作用、恢复和回滚测试后，统一运行一次 Phase 4 定向测试并确认红灯。

### 4.1 失败测试

- [x] 创建 `tests/zero-publication-service.test.ts`。
- [x] 非 completed task 被拒绝。
- [x] owner 不匹配被拒绝。
- [x] Report Package 缺失被拒绝。
- [x] Report Package hash 不匹配被拒绝。
- [x] Zero offline 在创建 draft 前失败。
- [x] 新建发布 happy path。
- [x] HTML 创建后立即保存 draftRootNodeId。
- [x] placeholder 缺失失败。
- [x] IMAGE fill 写入逐项记录。
- [x] 任一 fill 为 SOLID 时失败。
- [x] metadata 高度小于内容边界时失败。
- [x] screenshot 失败时 publication 失败。
- [x] screenshot 短期 URL 下载失败时 publication 失败。
- [x] screenshot Artifact 写入失败时 publication 失败。
- [x] 相同 Idempotency-Key replay。
- [x] 不同 request hash 复用 key 时冲突。
- [x] create 模式失败时清理 draft。
- [x] update 模式拒绝其他 task 或其他 owner 的 publication。
- [x] update 模式从旧 publication 解析 rootNodeId，不接受客户端 nodeId。
- [x] update 模式失败时保留旧 root。
- [x] update 完成后再删除旧 root。
- [x] expired lease 可恢复。
- [x] 多个 deterministic draft 时 fail closed。

### 4.2 实现 Service

- [x] 创建 `apps/agent-api/src/integrations/zero/zero-publication-service.ts`。
- [x] 注入 Repository、ReportPackageReader、ArtifactStore、Renderer、Transcoder 和 ZeroMcpPort。
- [x] 实现 owner 和 task state 校验。
- [x] 服务端解析当前 Report Package。
- [x] 冻结 Zero target context。
- [x] 创建 publication 和 lease。
- [x] 渲染 HTML。
- [x] 创建 deterministic draft。
- [x] 保存 draft root。
- [x] 读取 placeholder IDs。
- [x] 转码并写入每张图片。
- [x] 记录 node/image hash map。
- [x] 验证 metadata。
- [x] 验证 fills。
- [x] 生成 screenshots。
- [x] 在短期 URL 过期前下载 screenshot bytes。
- [x] 将整页和局部 screenshot 写成 SEALED binary Artifact。
- [x] 在 receipt 中保存 screenshot Artifact IDs。
- [x] 实现 create finalize。
- [x] 实现 update two-phase swap。
- [x] 写 SEALED publication receipt。
- [x] 标记 completed。
- [x] 实现失败清理和 failure code。
- [x] 实现 heartbeat。
- [x] 实现 expired publication recovery。

### 4.3 Runtime 装配

- [x] 在 `apps/agent-api/src/control-runtime.ts` 创建 ZeroMcpClient。
- [x] 注入 ZeroPublicationService。
- [x] `ZERO_PUBLICATION_ENABLED=false` 时不创建写入能力。
- [x] 服务启动时启动 publication recovery。
- [x] 服务关闭时停止 recovery 并等待运行任务到安全点。

### Phase 4 门禁

结果：16 个 Zero Service 及依赖测试通过，typecheck PASS，diff check PASS。

```bash
pnpm exec tsx --test \
  tests/zero-publication-service.test.ts \
  tests/zero-mcp-client.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/zero-image-transcoder.test.ts
pnpm typecheck
```

- [x] Phase 4 测试通过。
- [x] `git diff --check` 通过。
- [x] 提交 Phase 4，只包含 Service、runtime 装配、恢复和测试。

## Phase 5：HTTP

- [x] 先批量完成 HTTP 和 Web dispatch 测试，统一运行一次 Phase 5 定向测试并确认红灯，再实现 Route 和 UI。

### 5.1 失败测试

- [x] 创建 `tests/zero-publication-api.test.ts`。
- [x] Zero status endpoint 未认证拒绝。
- [x] 非 owner 创建返回 404。
- [x] 未完成任务返回 409。
- [x] 客户端提交 reportPackageArtifactId 返回 400。
- [x] 缺 Idempotency-Key 返回 400。
- [x] Zero offline 返回 503。
- [x] create 返回 202。
- [x] completed replay 返回 200。
- [x] get publication owner 隔离。
- [x] request hash 冲突返回 409。

### 5.2 实现 Route

- [x] 创建 `apps/agent-api/src/routes/zero-publications.ts`。
- [x] 实现 `GET /api/integrations/zero/status`。
- [x] 实现 `POST /api/control-tasks/:id/publications/zero`。
- [x] 实现 `GET /api/control-tasks/:id/publications/zero/:publicationId`。
- [x] 复用 requireAuth 和 owner 404 语义。
- [x] 限制 body 字段。
- [x] 统一错误码映射。
- [x] 在 `server.ts` 装配 route。

## Phase 5B：Web

### 5B.1 前端合同

- [x] 在 `apps/web/src/api/client.ts` 增加 Zero status。
- [x] 增加 create publication。
- [x] 增加 get publication。
- [x] 不在前端读取本地图片或调用 MCP。

### 5B.2 UI

- [x] 在 `CurrentStage4Report` 操作区增加“发送到 Zero”。
- [x] 报告非 multimodal 时不显示。
- [x] Zero 离线时 disabled，并显示启动提示。
- [x] 点击打开确认面板。
- [x] 显示当前 Zero file/page。
- [x] 显示视觉资产数量和预计切片数。
- [x] 支持新建。
- [x] 已有 publication 时支持更新。
- [x] 显示 stage 和 progress。
- [x] completed 显示 rootNodeId。
- [x] failed 显示脱敏错误和重试。
- [x] 所有按钮有 disabled、focus 和 busy 状态。
- [x] 375px 和桌面宽度布局无溢出。

### 5B.3 前端验证

- [x] 增加 source-level dispatch 测试。
- [x] 浏览器检查完成报告按钮。
- [x] 浏览器检查 Zero 离线状态。
- [x] 浏览器检查发布进度和完成状态。

### Phase 5 完成门禁

```bash
pnpm typecheck
pnpm exec tsx --test tests/zero-publication-api.test.ts
pnpm --dir apps/web build
```

- [x] Phase 5 测试和构建通过。
- [x] `git diff --check` 通过。
- [x] 提交 Phase 5，只包含 API、Web 和测试。

## Phase 6：真实 Zero 验收

实际结果（2026-08-20）：

- 成功 publication：`9065255f-b7b4-4eaf-b068-191ea36e0ab9`。
- Zero root：`7:667`，尺寸 `1440 × 18007`。
- receipt Artifact：`38028f47-4151-4004-bb6a-93124a6fc98b`，状态 `SEALED`。
- 图片：9 个真实 `IMAGE / FIT` fill，全部 imageHash 匹配。
- 截图：10 个 `zero-publication-screenshot-v1` Artifact，全部 `SEALED`。
- 恢复：finalize 后本地 completion 失败的 publication 成功从 receipt checkpoint 恢复。
- 幂等：重复 Idempotency-Key replay 同一 completed publication。
- 不可变性：原 Report Package 和 Visual Artifact 共 10 个文件哈希未变化。
- 真机验收发现并修复了 post-execution Artifact lease 绑定和已选节点遮蔽 current-page 探测两个问题。

### 6.1 环境

- [x] 启动 Zero 桌面端。
- [x] 确认 Zero authenticated（3.12.11）。
- [x] 确认 27618 端口监听。
- [x] 打开测试文件和空白页面（file `2090282862455574529`，page `0:2`）。
- [x] 设置 `ZERO_PUBLICATION_ENABLED=true`。
- [x] 设置 `ZERO_MCP_URL=http://127.0.0.1:27618/mcp`。
- [ ] 启动 Agent API 和 Web。

### 6.2 文本报告验收

- [ ] 选择已完成文本报告。
- [ ] 点击“发送到 Zero”。
- [ ] 验证 HTML 结构和正文。
- [ ] 验证 receipt。
- [ ] 验证重复点击 replay。

### 6.3 Multimodal 报告验收

使用任务：

```text
91e7bed3-4725-41a7-ba28-742424f4911c
```

- [x] 发布 AI 导购截图竞品分析。
- [x] 验证 root width 1440（height 18007）。
- [x] 验证评分图为 IMAGE fill。
- [x] 验证原始拼接图按稳定切片顺序展示。
- [x] 验证标注图按相同边界展示。
- [x] 验证 9 个图片 node 均为 IMAGE / FIT 且 imageHash 匹配。
- [x] 验证报告正文、矩阵、行动建议和局限章节存在。
- [x] 生成视觉证据节点截图。
- [x] 生成整页截图。
- [x] 检查 footer 模板标识和 root bounds。
- [x] 保存 publicationId、rootNodeId 和 receipt Artifact ID。

### 6.4 失败验收

- [ ] 关闭 Zero 后点击，确认 503 和 UI 提示。
- [ ] 模拟图片脚本失败，确认 draft 被清理。
- [ ] update 模式模拟中途失败，确认旧稿仍存在。
- [x] 重复 Idempotency-Key，确认 replay 同一 publication。
- [ ] 将一个 manifest 设为 block fixture，确认图片不发送。
- [ ] 模拟 metadata 高度不足，确认 publication 失败。

### Phase 6 门禁

- [ ] 真实文本报告通过。
- [x] 真实 multimodal 报告通过。
- [x] loopback 离线边界与自动化失败回滚路径通过。
- [x] 原始 Report Package 和 Visual Artifact 共 10 个文件 hash 未变化。

## Gate 7：全量验证

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm exec tsx --test \
  tests/zero-publication-contract.test.ts \
  tests/zero-mcp-client.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/zero-image-transcoder.test.ts \
  tests/zero-publication-service.test.ts \
  tests/zero-publication-api.test.ts
pnpm --dir apps/web build
pnpm quality
```

- [ ] 所有 Zero 定向测试通过。
- [ ] `pnpm quality` 通过。
- [ ] Web build 通过。
- [ ] `git diff --check` 通过。
- [ ] 无 staged 外文件。
- [ ] 无敏感信息进入日志、fixture 或 Artifact。
- [ ] 对新增表执行 migration rollback review。

## Gate 8：独立审查

- [ ] 审查 Zero MCP URL 校验和 SSRF 风险。
- [ ] 审查 owner 隔离。
- [ ] 审查外部副作用和用户确认。
- [ ] 审查幂等和并发。
- [ ] 审查 update two-phase swap。
- [ ] 审查图片 exportPolicy。
- [ ] 审查 Base64、错误信息和日志脱敏。
- [ ] 审查 Artifact 不可变性。
- [ ] 审查 publication recovery。
- [ ] 审查 Web 可访问性和窄屏。
- [ ] 处理所有 HIGH/CRITICAL finding。
- [ ] 只有审查导致代码变更时才重新运行 Gate 7；纯审查不重复跑全量测试。

## Gate 9：交付

- [ ] 更新开发文档中的最终文件路径和实际常量。
- [ ] 更新 TodoList 的每个执行结果。
- [ ] 记录真实 Zero 验收的 publicationId、rootNodeId 和 receipt Artifact ID。
- [ ] 确认所有 Phase commit 独立可构建。
- [ ] 生成最终 diff summary。
- [ ] 用户授权后再 push。
- [ ] 需要 PR 时创建 PR 并等待 CI。
- [ ] 不在未授权情况下发布到远端 `main`。

## 完成账本

功能完成时必须同时满足：

```text
contracts          done
migration          done
repository         done
MCP client         done
renderer           done
transcoder         done
publication service done
recovery           done
HTTP               done
Web                done
automated tests    done
real Zero smoke    done
security review    done
docs               done
remote delivery    explicitly done or explicitly not authorized
```
