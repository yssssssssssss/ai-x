---
name: design-experience-review
description: 设计体验走查——对设计稿/页面做美学量化、视觉注意力、品牌一致性评估
when_to_use: 用户需要对设计稿/页面做美学、注意力、品牌视觉走查或体验评估时使用(需用户提供设计稿图像)
owner: 体验设计组
---

# 设计体验走查

## 何时使用 / 不使用

**适用:** 用户提供了设计稿/页面截图,想评估视觉美学、注意力分布、品牌一致性,或做设计走查。

**不适用:** 无图像可评的纯文本研究、竞品对标(路由到竞品分析 skill)、真实用户访谈。

## 输入

见 `input.schema.json`。核心:`designImage`(设计稿,dataUrl 或可访问 url)、可选 `brandReferenceImage`(品牌参考)、`goal`(评估目标)、`focus`(评估重点,美学/注意力/品牌任选)。

## 执行步骤

按 `focus` 选调对应 tool,每步在 `step.input` 按该 tool 的 input.schema 生成入参:

1. **美学量化**(focus 含 aesthetic):`aesthetic-quant-lab` tool,`step.input = { designImage: {url|dataUrl}, profileId?, enableAttention? }`。
2. **注意力分析**(focus 含 attention):`attention-analysis-lab` tool,`step.input = { image: {url|dataUrl}, mode? }`。
3. **品牌一致性**(focus 含 brand):`vision-brand-lab` tool,`step.input = { designImages: [{url|dataUrl}], brandReferenceImages?: [...], businessGoal? }`。
4. **综合归纳**:llm 步汇总各工具客观量化,给出设计走查结论与改进优先级。

## 默认假设

- 未给 focus → 默认三项全做。
- 未给 profileId → aesthetic 用 `balanced`。
- **无图像源** → 在计划阶段作为 assumption 标注『需用户提供设计稿(上传或给可访问 url/dataUrl)』,对应 tool 步留空图像字段,执行时工具将返回 insufficient_inputs。

## 质量门禁

- 工具产出为算法量化,是客观参考,不等于最终设计结论;综合归纳须说明这一点。
- 每条结论标注来源(tool_result / llm_inference)。

## 输出

见 `output.schema.json`。核心:`assessments`(各维度评估 + 来源)、`priority_actions`、`sources`。

## 失败降级

- 某 tool 失败或无图 → 该维度标 `data_incomplete`,不阻塞其余维度;报告说明缺口。
