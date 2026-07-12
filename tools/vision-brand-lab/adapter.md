# vision-brand-lab · Adapter 说明

## 定位

消费 `external-tools/vision-brand-lab`(视觉品牌实验室,Fastify :8805)的 `POST /api/analyze`——对设计稿做多角色视觉评审 + 与品牌参考图的品牌联想一致性打分。

## 调用方式(adapter_type: rest_json → RestJsonAdapter)

1. base_url 从 `VISION_BRAND_BASE_URL` 读(默认 `http://127.0.0.1:8805`)。
2. `POST {base_url}/api/analyze`,body 原样透传(见 input.schema.json)。
3. 无鉴权;返回 JSON 原样透传为 output。

## 配置(本机 .env,勿提交)

```
VISION_BRAND_BASE_URL=http://127.0.0.1:8805
```

## 前置

- vision-brand-lab 后端(:8805)已启动。
- 图像用 `designImages[].dataUrl`(base64)透传,或先 `/api/uploads` 拿 `path`。品牌联想需同时提供 brandReferenceImages。

## 边界

- low risk,无需审批。PII 打码、敏感业务数据阻断。结果来源标注 `tool_result`。
