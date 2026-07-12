# aesthetic-quant-lab · Adapter 说明

## 定位

消费 `external-tools/aesthetic-quant-lab`(美学量化实验室,Fastify :8801)的 `POST /api/analyze`——对设计稿做色彩/构图/对比度等美学维度量化打分,可选注意力热区。

## 调用方式(adapter_type: rest_json → RestJsonAdapter)

1. base_url 从环境变量 `AESTHETIC_QUANT_BASE_URL` 读(默认 `http://127.0.0.1:8801`)。
2. `POST {base_url}/api/analyze`,`Content-Type: application/json`,body = input **原样透传**(见 input.schema.json)。
3. 无鉴权。返回 JSON **原样透传**为 output(不做结果映射)。
4. 超时/重试由 manifest 声明(60s / 2 次)。

## 配置(本机 .env,勿提交)

```
AESTHETIC_QUANT_BASE_URL=http://127.0.0.1:8801
```

## 前置

- aesthetic-quant-lab 后端(:8801)已启动(`npm run labs:dev` 或工具目录内 `npm run dev:server`)。
- 图像通过 `designImage.dataUrl`(base64)透传,或先经该服务 `/api/uploads` 拿到 `path` 再传。

## 边界

- low risk,无需审批。query/图像里 PII 打码,敏感业务数据阻断(redaction_policy)。
- 结果在报告中来源标注为 `tool_result`。
