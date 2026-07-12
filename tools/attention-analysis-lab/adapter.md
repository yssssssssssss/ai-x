# attention-analysis-lab · Adapter 说明

## 定位

消费 `external-tools/attention-analysis-lab`(视觉注意力分析,Fastify :8802)的 `POST /api/analyze`——输出注意力热力图、热点、焦点平衡/干扰风险评分及 ROI 排序。

## 调用方式(adapter_type: rest_json → RestJsonAdapter)

1. base_url 从 `ATTENTION_ANALYSIS_BASE_URL` 读(默认 `http://127.0.0.1:8802`)。
2. `POST {base_url}/api/analyze`,body = input 原样透传(见 input.schema.json)。
3. 无鉴权;返回 JSON 原样透传为 output。超时/重试由 manifest 声明。

## 配置(本机 .env,勿提交)

```
ATTENTION_ANALYSIS_BASE_URL=http://127.0.0.1:8802
```

## 前置

- attention-analysis-lab 后端(:8802)已启动。
- 图像用 `image.dataUrl`(base64)透传,或先 `/api/uploads` 拿 `path`。

## 边界

- low risk,无需审批。PII 打码、敏感业务数据阻断。结果来源标注 `tool_result`。
