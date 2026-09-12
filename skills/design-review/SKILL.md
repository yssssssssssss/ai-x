---
name: design-experience-review
description: 设计体验走查，对设计稿或页面做美学量化、视觉注意力、品牌视觉评审与跨方案比较
when_to_use: 用户提供设计稿或京东与竞品页面截图，需要美学、注意力、品牌视觉走查或体验评估时使用
owner: 体验设计组
---

# 设计体验走查

## 何时使用 / 不使用

**适用：** 用户提供设计稿或页面截图，希望评估视觉美学、注意力分布、品牌视觉，或者比较主方案与竞品。

**不适用：** 无图像的纯文本研究、真实用户访谈，或者用视觉分数预测经营结果。

## 输入

Standalone 接受 `designImage`。Industry Contributor 接受 `jd_screenshots` 与 `competitor_screenshots`，两组都允许多张图片；至少提供一组。

正式执行由 `visual-analysis-suite` 统一完成批量和逐图调用：

1. Vision Brand 每批最多 3 张，输出多角色视觉评审。
2. Attention Analysis 对每张图片输出注意力结构和干扰风险。
3. Aesthetic Quant 对每张图片输出美学量化与可读性观察。
4. Skill 只汇总已验证 Tool Result，不重写工具事实或提升证据等级。

## 执行步骤

1. 对主方案与竞品截图使用相同参数和批次规则。
2. 保留每张图片的 Sample ID、角色和 Tool provenance。
3. 把工具失败写为明确 Gap，其余结果继续生成。
4. 综合归纳视觉观察和待验证的设计建议。

## 默认假设

- 默认执行美学、注意力和视觉评审三项。
- Aesthetic 使用 `balanced`，Attention 使用 `hybrid`。
- 没有品牌参考图时不输出品牌一致性结论。
- 无图像源时输出明确缺口，不用旧结果或虚构图像观察。

## 质量边界

- 工具结果是算法辅助，不等于真实眼动、用户研究或经营结果。
- 所有 Visual Contribution 保持 `provisional`。
- 每条结论保留 Tool Result 与截图 Evidence，不把美学分数当作 confidence。
- 品类含义和行动优先级由最终 Synthesizer 决定。

## 输出

见 `output.schema.json`。核心为 `assessments`、`priority_actions` 和 `sources`。

## 失败降级

- 单个实验室失败时，该维度标记为 `data_incomplete`，其余结果继续。
- 三个实验室都不可用时，输出明确 Visual Gap，不阻断其他 Industry Evidence。
