# tavily-web-search · Adapter 说明

## 定位

调用 Tavily Search API 做公开网页检索，返回可追溯 URL、标题和摘要，供竞品研究和桌面研究使用。

## 调用方式(adapter_type: tavily → TavilyAdapter)

1. 从 `TAVILY_API_KEY` 读取密钥。
2. 从 `TAVILY_BASE_URL` 读取 base URL，默认 `https://api.tavily.com`。
3. `POST {base_url}/search`，body = `{ query, max_results, search_depth, topic, time_range, include_answer, include_raw_content:false }`。
4. 返回映射为 `output.schema.json` 结构：`answer / response_time / results[]`。

## 配置(本机 .env,勿提交)

```env
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_TIMEOUT_MS=30000
```

## 边界

- 不默认请求 raw content。
- `answer` 只作摘要，不能作为竞品事实证据。
- 报告事实引用必须落到 `results[].url`。
- API key 不进入日志、manifest、示例或测试输出。
