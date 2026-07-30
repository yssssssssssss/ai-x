# Tavily Web Search Tool 设计文档

- 日期: 2026-07-30
- 状态: 已批准设计，待实现
- 归属: 用研 AI 专项 · Tool 接入层

## 1. 背景与目标

当前项目已注册 `o2-web-search`，但运行时把 `adapter_type: o2` 映射到 `FakeO2Adapter`，不会真实调用公开网页检索。P0 金标场景需要真实公开网页证据，因此新增一个独立 Tool：`tavily-web-search`。

目标是接入 Tavily Search API，提供可追溯的公开网页检索结果，供竞品研究、桌面研究和 P0 金标场景使用。密钥只通过环境变量注入，不进入仓库。

## 2. 范围

**In scope:**

1. 新增 `tavily-web-search` Tool 注册项、manifest、input/output schema、adapter 说明和示例。
2. 新增 `TavilyAdapter`，通过统一 `ToolAdapter.invoke()` 调用 Tavily Search API。
3. 在运行时 `ToolRouter` 注册 `adapter_type: tavily`。
4. 增加 `.env.example` 占位配置。
5. 增加离线单元测试和默认跳过的真实集成测试。

**Out of scope:**

1. 不删除或替换 `o2-web-search`。
2. 不新增通用 provider 抽象层。
3. 不默认抓取 raw content。
4. 不把 Tavily 生成的 `answer` 当作竞品事实来源。
5. 不把 API key 写入代码、测试 fixture、manifest 或文档正文。

## 3. 架构决策

推荐方案是新增 `tavily-web-search`，而不是复用 `o2-web-search`。

理由:

- `o2-web-search` 的名字和 manifest 表示 o2 通道；底层换成 Tavily 会造成语义漂移。
- 新 Tool 可独立测试、回滚和灰度，不影响现有 mock fixture。
- 当前只接入一个真实公开 Web Search provider，通用 `web_search` provider 抽象属于过度设计。

## 4. Tool 契约

### 4.1 Registry

在 `orchestrator/tool-registry.yaml` 增加:

```yaml
- id: tavily-web-search
  name: Tavily 网页检索
  path: tools/tavily-web-search/manifest.yaml
  adapter_type: tavily
  auth_required: true
  risk_level: low
  status: active
```

### 4.2 Manifest

`tools/tavily-web-search/manifest.yaml`:

```yaml
id: tavily-web-search
name: Tavily 网页检索
adapter_type: tavily
entrypoint: /search
base_url_env: TAVILY_BASE_URL
auth_required: true
risk_level: low
approver_rule: none
timeout_seconds: 30
retry_policy:
  max_attempts: 2
  backoff_seconds: 3
input_schema: tools/tavily-web-search/input.schema.json
output_schema: tools/tavily-web-search/output.schema.json
redaction_policy:
  pii: mask
  sensitive_business_data: block
```

### 4.3 输入 Schema

输入字段:

- `query` 必填，字符串。
- `max_results` 可选，1–20，默认 5。
- `search_depth` 可选，枚举 `basic | advanced | fast | ultra-fast`，默认 `basic`。
- `topic` 可选，枚举 `general | news | finance`，默认 `general`。
- `time_range` 可选，枚举 `day | week | month | year | d | w | m | y`。
- `include_answer` 可选，`false | true | basic | advanced`，默认 `false`。

不暴露 `include_raw_content` 给计划 LLM；adapter 默认发送 `include_raw_content: false`。

### 4.4 输出 Schema

输出字段:

```json
{
  "answer": "可选，Tavily 生成的摘要，不作为事实源",
  "response_time": 1.23,
  "results": [
    {
      "title": "页面标题",
      "url": "https://example.com",
      "snippet": "摘要或内容片段",
      "score": 0.92,
      "published_date": "2026-07-30"
    }
  ]
}
```

`results[].url` 是报告事实引用的主锚点；`answer` 只能辅助阅读，不能作为竞品事实证据。

## 5. Tavily API 调用

官方 Search endpoint:

- `POST https://api.tavily.com/search`
- Body 包含 `query`、`search_depth`、`max_results`、`topic`、`time_range`、`include_answer` 等。
- `search_depth` 默认 `basic`；`max_results` 默认 5，最大 20。

运行时配置:

```env
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_TIMEOUT_MS=30000
```

`TavilyAdapter` 读取环境变量。缺 `TAVILY_API_KEY` 时抛错，不降级到 fake。API key 通过请求头发送；实现时用官方当前支持的认证头，并用集成测试验证真实响应。

## 6. 数据流

```text
用户研究诉求
  → Orchestrator 生成候选计划
  → 计划包含 actor_type=tool, actor_id=tavily-web-search
  → ToolActorRunner 清洗并校验 step.input
  → TavilyAdapter POST /search
  → Tavily 响应映射为 output.schema.json
  → RunWorkspace 写 tool_outputs/step-N.json
  → execution_log 记录 manifest hash、outputRef、状态
  → 报告合成引用 results[].url 作为 tool_result 来源
```

## 7. 错误处理

- 缺 `TAVILY_API_KEY`: 抛 `ToolInvocationError`，执行进入现有 paused/resume 机制。
- HTTP 非 2xx: 抛 `ToolInvocationError`，错误消息包含状态码和截断后的响应文本，不记录密钥。
- 超时: 使用 `AbortController`，按 `TAVILY_TIMEOUT_MS` 或 manifest timeout 终止请求。
- 响应结构异常: 映射为空数组或抛 schema 校验错误；schema 错误走现有执行失败路径。
- Tavily 返回 `answer` 但无 `results`: 允许通过 output schema，但 P0 评审不能把 answer 当作事实证据。

## 8. 安全与留痕

- API key 只存在 `.env` 或运行环境变量，不进入 git。
- `.env.example` 只写空占位。
- 不记录完整请求头。
- 不默认请求 raw content，降低隐私、成本和延迟面。
- 报告中的事实引用必须指向 `results[].url`，不能指向 Tavily `answer`。

## 9. 测试计划

### 9.1 离线单元测试

新增 `tests/tavily-adapter.test.ts`，使用可注入 fetch 或临时替换 `globalThis.fetch`:

1. 缺 `TAVILY_API_KEY` 时失败。
2. 正常请求发送正确 URL、header 和 body。
3. Tavily 响应映射为项目 output schema。
4. HTTP 非 2xx 抛 `ToolInvocationError`。
5. `include_raw_content` 不由用户输入开启。

### 9.2 真实集成测试

新增 `tests/tavily-integration.test.ts`，默认 skip。显式运行:

```bash
TAVILY_TEST=1 npx tsx --test tests/tavily-integration.test.ts
```

集成测试输入:

```json
{ "query": "直播 数字人 竞品", "max_results": 3 }
```

验收:

- 返回通过 `tools/tavily-web-search/output.schema.json`。
- `results` 可以为空但必须结构合法；若为空，测试输出提示检查 Tavily 配额或查询。
- 不打印 API key。

### 9.3 项目质量门

`pnpm test` 不依赖真实 Tavily。真实环境能力由 `TAVILY_TEST=1` 单独验证。

## 10. P0 使用策略

P0 金标场景中，公开网页证据优先使用 `tavily-web-search`。`ai-spider-search` 用作竞品截图或内部截图库增强。`o2-web-search` 保留但不作为真实公开网页证据源，直到真实 o2 adapter 落地。

## 11. 回滚策略

Tavily 接入是可逆改动。若真实调用不稳定:

1. 将 `orchestrator/tool-registry.yaml` 中 `tavily-web-search.status` 改为 `draft` 或 `deprecated`。
2. 保留代码与测试，避免破坏历史审计。
3. P0 退回 `ai-spider-search` 作为真实 Tool，但公开网页证据能力标记为未完成。
