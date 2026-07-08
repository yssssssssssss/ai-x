# o2-web-search · Adapter 说明

## 调用方式

`adapter_type: o2`。V0 阶段用 `FakeO2Adapter`(返回预置检索结果),二期切真实 o2 通道。

真实 o2 调用形态(二期实现,V0 仅声明):

```bash
o2 web-search --query "<关键词>" --limit <N>
```

业务代码**不直接** shell out o2,而是通过 `tool-adapter.ts` 的 `ToolAdapter.invoke()` 统一入口,由具体 adapter 实现决定走 fake / o2 / 其它通道。

## 输入 / 输出

- 输入:见 `input.schema.json`(query 必填,limit 可选)。
- 输出:见 `output.schema.json`(results[] = {title, url, snippet})。

## 边界

- 只检索公开可访问内容,不抓取需登录/付费页面。
- `redaction_policy`:query 里的 PII 打码,敏感业务数据阻断。
- 低风险 tool(risk_level: low),无需审批(approver_rule: none)。
