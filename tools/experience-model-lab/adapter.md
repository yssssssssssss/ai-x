# experience-model-lab · Adapter 说明

## 定位

消费 `external-tools/experience-model-lab`(体验模型实验室,Fastify :8803)的 `POST /api/analyze`——按研究诉求从 HEART/GSM/JTBD/Kano/SUS/NPS/TAM 等模型中匹配最合适者,给出框架、理由与问卷模板。纯 JSON 输入,无需图像。

## 调用方式(adapter_type: rest_json → RestJsonAdapter)

1. base_url 从 `EXPERIENCE_MODEL_BASE_URL` 读(默认 `http://127.0.0.1:8803`)。
2. `POST {base_url}/api/analyze`,body = `{ query, preferredModelIds?, ... }` 原样透传。
3. 无鉴权;返回 JSON 原样透传为 output。

## 配置(本机 .env,勿提交)

```
EXPERIENCE_MODEL_BASE_URL=http://127.0.0.1:8803
```

## 前置

- experience-model-lab 后端(:8803)已启动。`data/experience-models` 缺 PDF 时仍可匹配,只是标注 missing_pdf。

## 边界

- low risk,无需审批。PII 打码、敏感业务数据阻断。结果来源标注 `tool_result`。
