---
name: competitive-app-analysis
description: 基于用户上传或受控来源的主方案与竞品截图，执行多实验室视觉对比分析
when_to_use: 用户要对竞品 app 的【界面本身】做分析——截图级的视觉设计、注意力分布、品牌一致性、信息架构;或诉求提到"看竞品页面/界面/截图/设计怎么做的"。若用户只要查竞品做了什么/战略动态(网络资料),走 competitive-web-research。
owner: 竞品分析组
---

# 竞品分析 · App 截图分析路径

## 何时使用 / 不使用

**适用:** 对竞品 app 界面做截图级量化分析——视觉美学、注意力热区、品牌视觉一致性、页面信息架构。信息源是"竞品 app 的界面截图"。

**不适用:** 以网络公开资料为主的竞品对标 → `competitive-web-research`;对我方自有产品搭体验度量体系 → `build-experience-metrics`。

## 输入

- `research_goal`（必填）：要回答的界面级问题。
- `competitorDesignImage[]`（必填）：一张或多张竞品页面截图。
- `jdDesignImage[]`（可选）：需要比较京东／主方案与竞品时提供；一旦用户提供，Plan 必须完整消费。
- `competitors` / `scenes`（可选）：目标竞品与页面场景。

## 执行步骤

1. **收集公开证据**：使用 `tavily-web-search` 补充可追溯的竞品背景；当前视觉对比只消费用户已上传并封存的截图，缺少时继续走 Material Request。
2. **双组视觉分析**：通过 `visual-analysis-suite` 将 `jdDesignImage` 作为 primary、`competitorDesignImage` 作为 comparison，逐图保留 Sample ID、截图来源和 Tool provenance。
3. **横向对比与归因**：按视觉层级、美学、注意力和品牌表达形成差异矩阵；算法结果只作辅助观察。
4. **差异化建议**：基于截图观察与明确标注的设计推断，给出我方界面可执行改进点。

## 产出

- 竞品界面量化对比(截图 + 美学/注意力/品牌分,带截图来源 oss_url)
- 界面级差异化建议
- 关键结论(结论先行),每条标注来源:tool 结果(哪个 lab)/ llm_inference

## 边界与合规

- 截图来自内部已采集的竞品截图库(ai-spider);来源可反查(oss_url)。
- lab 分析为量化辅助,主观设计判断标 `llm_inference`;涉密业务数据按 redaction_policy 处理。
