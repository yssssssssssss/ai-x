# virtual-user-lab · Adapter 说明

## 定位

消费 `external-tools/virtual-user-lab`(虚拟用户实验室,Fastify :8804)的 `POST /api/simulate`——用多个数字人格对产品/设计做模拟评审,输出各人格评分、共性痛点与改进建议。

> 注意:结果 `isSimulated: true`,是模型推演,**不能替代真实用户研究**,报告中须标注。

## 调用方式(adapter_type: rest_json → RestJsonAdapter)

1. base_url 从 `VIRTUAL_USER_BASE_URL` 读(默认 `http://127.0.0.1:8804`)。
2. `POST {base_url}/api/simulate`,body 原样透传(见 input.schema.json)。
3. 无鉴权;返回 JSON 原样透传为 output。超时 90s(模拟较慢)。

## 配置(本机 .env,勿提交)

```
VIRTUAL_USER_BASE_URL=http://127.0.0.1:8804
```

## 前置

- virtual-user-lab 后端(:8804)已启动。不传 personaProfiles 时用内置人格。

## 边界

- low risk,无需审批。PII 打码、敏感业务数据阻断。结果来源标注 `tool_result` 且须标「模拟」。
