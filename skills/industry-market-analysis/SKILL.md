---
name: industry-market-analysis
description: 基于可追溯的公开证据、用户材料、竞品与京东截图，完成品类行业、用户、供给、竞品、体验与策略综合分析，并输出 typed Industry content draft。
status: approved
---

# Industry Market Analysis

本 Skill 是 `industry_market_analysis_report` 的单 Skill 执行者，并在多 Skill 模式中作为唯一 Synthesizer。

## 输入

- 已确认的 `industry_scope` 与研究问题。
- 可用的公开 Evidence。
- 可选京东截图、竞品平台名与截图。
- 可选匿名用户研究 Dataset。
- 可选内部经营 Dataset。
- 可选的只读 Joyspace Knowledge Snapshot；仅使用 `prior_outputs` 中已绑定的 `JV*` Evidence ID。
- 多 Skill 模式下的受控 Contribution Bundle。

## 输出

只输出符合 `industry-market-content-draft-v1` 的结构化 Payload，不生成 Markdown 或 HTML。最终 Canonical、FindingGraph、Coverage、Risk、ReportDocument 和双报告由 Runtime 负责。

## 方法

1. 盘点 A–J 十个行业维度及材料缺口。
2. 区分公开事实、截图观察、Dataset 事实、分析推断、模拟假设和未知项。
3. 分析市场与供给、用户、竞品、京东现状及经营逻辑。
4. 仅从已支持或明确 provisional 的发现推导 Gap、定位、机会与优先级。
5. 将重点机会展开为可执行的策略纵深链。
6. 从平台基线、品类属性、竞品和京东现状推导品类差异资产。
7. 保留所有 Data Gap 与验证路径。
8. 若存在 Joyspace `viewedDocument`，只在内容与当前品类或方法直接相关时使用，并保留其 `JV*` Knowledge Evidence；不相关时忽略。
9. 若存在 `contribution_bundle`，将每个吸收的 Contributor Unit 的精确 `<artifactId>:<unitKey>` 写入对应节点的 `support.sourceContributionUnitIds`，并在该节点 `statement` 内逐字保留 Unit statement；未采纳的 Unit 必须在 `contributionExclusions` 写入精确 `unitId` 与 `reason`，不得静默遗漏或拼成不可追溯的新事实。

## 硬边界

- 不编造市场规模、份额、用户比例、销量、GMV、转化、复购或 AB 结果。
- 没有用户 Dataset 时，不输出 dataset-derived Persona。
- simulation 只能作为 provisional 假设。
- 没有截图或 URL 时，不声称完成相应视觉或在线事实核验。
- 不把 Source Sync 示例、Demo HTML 或模型记忆当作事实。
- Joyspace 搜索结果本身不是事实；只有已 View、封存并绑定 `JV*` Evidence 的正文才可作为内部 Knowledge，且不得提升为公开事实。
- 不调用隐藏的第二个 Skill。
