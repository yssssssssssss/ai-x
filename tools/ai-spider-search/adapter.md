# ai-spider-search · Adapter 说明

## 定位

只读消费 `ai-spider-app`(竞品分析平台)的 `POST /api/search`——向量/文本检索**已采集的竞品截图库**。
**不修改 ai-spider-app 任何内容**,不触发采集链路(requests/approve/run)。

## 调用方式(adapter_type: internal_api → HttpApiAdapter)

1. 若未持有 JWT:`POST {SPIDER_BASE_URL}/api/auth/login {username,password}` → `access_token`(缓存)。
2. `POST {SPIDER_BASE_URL}/api/search`,带 `Authorization: Bearer <token>`,body = `{query, limit, offset}`。
3. 返回 `SearchResult[]`,adapter 映射为 `output.schema.json` 结构(source_app / scenario / oss_url / design_analysis / ops_analysis / search_mode)。
4. token 过期(401)自动重登一次。

## 配置(本机 .env,勿提交)

```
SPIDER_BASE_URL=http://localhost:8000
SPIDER_USERNAME=<账号>
SPIDER_PASSWORD=<密码>
SPIDER_TIMEOUT_MS=30000
```

## 前置

- ai-spider-app 后端(:8000)已由用户方启动、PostgreSQL+pgvector 就绪。
- competitor_db 里有已采集数据,否则 search 返回空。
- 向量检索失败时 ai-spider-app 内部自动降级文本检索(adapter 无需处理)。

## 边界

- low risk,无需审批。query 里 PII 打码,敏感业务数据阻断(redaction_policy)。
- 结果在报告中来源标注为 `tool_result`,source_ref 存 oss_url,可反查。
