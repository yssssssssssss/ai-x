---
name: digital-human-competitive-analysis
description: 数字人竞品分析——分析数字人/虚拟主播/直播竞品的能力、体验与差异
when_to_use: 用户需要分析数字人、虚拟主播、直播竞品时使用
owner: 竞品分析组
---

# 数字人竞品分析

## 何时使用 / 不使用

**适用:** 用户要对标数字人、虚拟主播、AI 直播、直播场域竞品,想了解各家能力边界、体验差异、差异化机会。

**不适用:** 纯用户访谈类研究、无竞品对标诉求的体验走查、非直播/数字人领域的通用竞品(应路由到对应领域 skill)。

## 输入

见 `input.schema.json`。核心:`business_domain`(如 live_commerce)、`competitors`(对标清单,可为空则用默认头部清单)、`dimensions`(对比维度,可选)。

## 执行步骤

1. **确定对比维度**:若输入未给 dimensions,默认取【功能能力 / 交互体验 / 内容质量 / 商业化路径 / 技术形态】五维。
2. **竞品信息采集**:对每个竞品,通过 `tavily-web-search` tool 检索公开资料(官网、发布会、评测、应用商店)。只用公开信息,不抓取需登录/付费内容。
3. **逐维打分与举证**:每个维度给出竞品表现描述 + 证据来源。无证据的判断标注为 `llm_inference`,不得冒充事实。
4. **差异化机会归纳**:基于对比,归纳我方可切入的差异化点。

### 可选支撑步骤(按需)

- **选评估模型**:若需系统评估竞品体验,用 `experience-model-lab` tool(`step.input = { query: <评估诉求>, preferredModelIds?: [...] }`)推荐 HEART/SUS 等模型与问卷模板。
- **虚拟用户预评审**:低成本预判竞品体验时,用 `virtual-user-lab` tool(`step.input = { scenario, productDescription, reviewDimensions? }`)做数字人格模拟评审。结果为模拟推演(`isSimulated`),须在报告标注,不替代真实用研。

## 默认假设

- 竞品清单为空 → 取该业务域头部 3 家(在计划阶段作为 assumption 呈现,用户可改)。
- 时间窗口 → 近 12 个月公开资料优先。
- 报告格式 → 竞品对比矩阵 + 差异化建议。

## 质量门禁

- 每条结论必须带来源标注(user_input / knowledge_base / tool_result / llm_inference / pending_human_review)。
- 竞品能力描述若仅来自推断,必须标 `llm_inference` 并列入待人工确认。
- 不使用需授权/付费/登录才能获取的竞品内部数据。

## 输出

见 `output.schema.json`。核心:`comparison_matrix`(竞品 × 维度)、`differentiation_opportunities`、`sources`。

## 失败降级

- tool 检索失败 → 该竞品标记为 `data_incomplete`,不阻塞其余竞品;报告中说明缺口。
- 竞品清单无法确定 → 降级为 need_clarify,请用户提供对标对象。

## 参考

- 方法论:`knowledge-base/methods/competitive-research-method.md`
- 案例:`knowledge-base/cases/live_competitive_001.md`
