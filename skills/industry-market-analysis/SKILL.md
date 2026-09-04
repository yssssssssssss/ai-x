---
name: industry-market-analysis
description: 基于可追溯的公开证据、用户材料、竞品与京东截图，完成品类行业、用户、供给、竞品、体验与策略综合分析，并输出 typed Industry content draft。
when_to_use: 用户需要对一个行业或品类做市场、用户、供给、竞品、京东现状与增长策略的综合分析时使用。
status: approved
native_delivery:
  version: 1
  id: industry-market-analysis
  allow_partial: true
  inputs:
    - id: research_goal
      label: 研究目标
      description: 本次行业市场分析必须回答的核心业务问题。
      required: true
      accepted_sources: [conversation, database]
      question: 这次行业市场分析最需要回答的核心业务问题是什么？
      missing_policy: stop
    - id: industry_scope
      label: 行业范围
      description: 行业、品类、地域、时间和业务边界。
      required: true
      accepted_sources: [conversation, database]
      question: 请明确本次分析的行业或品类范围，以及地域、时间等边界。
      missing_policy: stop
    - id: competitors
      label: 对标对象
      description: 用户指定的竞品、平台或相邻业务清单。
      required: false
      multiple: true
      accepted_sources: [conversation, database, tool]
      tool_ids: [tavily-web-search]
      question: 是否有必须覆盖的竞品或相邻业务？可以逐行提供。
      missing_policy: gap
    - id: jd_screenshots
      label: 京东现状截图
      description: 与研究范围相关的京东页面截图。
      required: false
      multiple: true
      accepted_sources: [upload, database]
      question: 如需页面级诊断，请上传相关京东页面截图。
      missing_policy: gap
    - id: competitor_screenshots
      label: 竞品截图
      description: 与研究范围相关的竞品页面截图。
      required: false
      multiple: true
      accepted_sources: [upload, database]
      question: 如需页面级对比，请上传相关竞品截图。
      missing_policy: gap
    - id: user_research_dataset
      label: 用户研究数据
      description: 匿名访谈、问卷或其他用户研究资料。
      required: false
      accepted_sources: [upload, database]
      question: 如需形成数据支持的用户分层，请提供匿名用户研究资料。
      missing_policy: gap
    - id: internal_metrics_dataset
      label: 内部经营数据
      description: 权限内且与本次范围一致的经营指标数据。
      required: false
      accepted_sources: [upload, database]
      question: 如需诊断京东经营现状，请提供权限内的经营指标数据。
      missing_policy: gap
  knowledge: []
  tools:
    - id: tavily-web-search
      required: true
  report:
    title: 行业市场分析报告
    summary_instruction: 概括行业判断、核心机会、关键风险和最优先行动，不新增正文之外的事实。
    sections:
      - 执行摘要
      - 分析范围与口径
      - 市场现状与趋势
      - 用户需求与分层
      - 供给与竞争格局
      - 京东现状与问题
      - 核心发现与 Gap
      - 定位、机会与策略
      - 优先行动与衡量方式
      - 信息缺口与来源
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

只输出 `ReportResult`，不生成 Markdown 或 HTML。标题、摘要和章节必须遵循本文件 Frontmatter 中的 `native_delivery.report`；来源只引用本次输入、Knowledge 或 Tool 返回的真实来源 ID。

## 方法

1. 盘点 A–J 十个行业维度及材料缺口。
2. 区分公开事实、截图观察、Dataset 事实、分析推断、模拟假设和未知项。
3. 分析市场与供给、用户、竞品、京东现状及经营逻辑。
4. 仅从已支持或明确 provisional 的发现推导 Gap、定位、机会与优先级。
5. 将重点机会展开为可执行的策略纵深链。
6. 从平台基线、品类属性、竞品和京东现状推导品类差异资产。
7. 保留所有 Data Gap 与验证路径。
8. 若存在 Joyspace `viewedDocument`，只在内容与当前品类或方法直接相关时使用，并保留其 `JV*` Knowledge Evidence；不相关时忽略。
9. Multi Skill 模式下综合全部可用支持 Skill 的 `ReportResult`，合并重复内容并把冲突放入“核心发现与 Gap”；不得静默遗漏失败 Skill 或拼成不可追溯的新事实。

## 硬边界

- 不编造市场规模、份额、用户比例、销量、GMV、转化、复购或 AB 结果。
- 没有用户 Dataset 时，不输出 dataset-derived Persona。
- simulation 只能作为 provisional 假设。
- 没有截图或 URL 时，不声称完成相应视觉或在线事实核验。
- 不把 Source Sync 示例、Demo HTML 或模型记忆当作事实。
- Joyspace 搜索结果本身不是事实；只有已 View、封存并绑定 `JV*` Evidence 的正文才可作为内部 Knowledge，且不得提升为公开事实。
- 不调用隐藏的第二个 Skill。
