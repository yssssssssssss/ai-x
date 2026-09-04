---
name: competitive-web-research
description: 基于 web 搜索的竞品分析——通过搜索 API 检索网络公开资料,做能力/体验/商业化对标
when_to_use: 用户要做竞品分析且以【网络公开资料】为主要信息源(官网/发布会/评测/应用商店/新闻/用户评价);没有竞品 app 截图、或诉求是"查资料看竞品在做什么/战略意图/市场动态"时用本 skill。若用户要的是对竞品 app 界面做截图级设计/注意力/品牌分析,走 competitive-app-analysis。
owner: 竞品分析组
status: approved
native_delivery:
  version: 1
  id: competitive-web-research
  allow_partial: true
  inputs:
    - id: research_goal
      label: 研究目标
      description: 竞品研究需要回答的核心问题。
      required: true
      accepted_sources: [conversation, database]
      question: 这次竞品研究最需要回答什么问题？
      missing_policy: stop
    - id: competitors
      label: 对标对象
      description: 必须覆盖的竞品或相邻业务；未指定时可以基于公开资料形成候选范围。
      required: false
      multiple: true
      accepted_sources: [conversation, database, tool]
      tool_ids: [tavily-web-search]
      question: 是否有必须覆盖的竞品或相邻业务？可以逐行提供。
      missing_policy: gap
    - id: dimensions
      label: 对比维度
      description: 需要重点比较的能力、体验、生态、商业化或差异化维度。
      required: false
      multiple: true
      accepted_sources: [conversation, database]
      question: 是否有必须覆盖的竞品对比维度？可以逐行提供。
      missing_policy: gap
  knowledge: []
  tools:
    - id: tavily-web-search
      required: true
  report:
    title: 竞品公开资料研究
    summary_instruction: 概括有公开来源支持的主要差异、机会和风险，不提升证据确定性。
    sections:
      - 竞品范围与方法
      - 竞品对比矩阵
      - 关键发现
      - 差异化机会
      - 信息缺口与来源
---

# 竞品分析 · Web 搜索路径

## 何时使用 / 不使用

**适用:** 以网络公开资料为主的竞品对标——查竞品能力边界、功能更新、商业化/运营策略、市场口碑、战略意图。信息源是"搜得到的公开内容"。

**不适用:** 需要对竞品 app 界面做截图级视觉/注意力/品牌分析 → `competitive-app-analysis`;纯用户访谈/无竞品对标 → 对应用研 skill。

## 输入

- `research_goal`(必填):这次竞品分析要回答的核心问题。
- `competitors`(可选):对标清单;为空则由 LLM 按 business_domain 取头部 3-5 家。
- `dimensions`(可选):对比维度;缺省用【功能能力 / 交互体验 / 内容生态 / 商业化 / 差异化特色】。

## 执行步骤

1. **明确对比目标与竞品范围**:锁定核心问题与 3-5 个竞品;缺省维度见上。
2. **网络资料检索**:对每个竞品 + 每个维度,用 `tavily-web-search` tool 检索公开资料(`step.input = { query: <竞品+维度关键词> }`)。只用公开信息,不抓取需登录/付费内容。
3. **可选网页视觉取证**:仅当冻结计划包含 `playwright-page-capture` 时,消费由 Tavily `/results` 显式绑定到 `/pages` 的公开来源;不得手写 URL、绕过登录/验证码/付费墙,也不得把截图当作新的事实来源。截图不可用时保留文本主链并披露对应视觉缺口。
4. **整理对比矩阵**:竞品 × 维度,每格整合为"表现描述 + 证据来源(url/出处)"。无证据的判断标 `llm_inference`,不得冒充事实。
5. **差异化机会归纳**:基于矩阵,归纳我方可切入的差异化点与风险。

## 产出

- 竞品对比矩阵(竞品 × 维度,带来源)
- 已验证网页截图可作为单图证据展示;每张图必须同时绑定 screenshot Evidence 与同一来源 URL 的 public-source Evidence,不强制生成标注图
- 差异化机会清单
- 关键结论(结论先行),每条标注来源:web 检索 / llm_inference

## 边界与合规

- 只消费公开可检索内容;涉及爬取评论/交易/用户数据 → 走 need_approval,勿自行采集。
- 检索结果为外部信息,引用须带 url;无来源的推断显式标注。
- 不使用外部图片热链、Base64 或生成图替代缺失证据;Playwright/页面失败应形成脱敏 gap,不得阻断已有公开文本证据。

## 趋势与变化扫描补充

- 仅当用户明确要求对指定市场、人群、场景或时间范围做趋势/变化扫描时启用，不因正文偶然提到“趋势”而扩大任务。
- 趋势结论必须由至少两个可追溯、带日期的公开观察点支撑；Knowledge 和案例只能提供方法，不能证明当前市场事实。
- 缺少时间序列或可比来源时，降级为当前截面和待补纵向证据，不断言已经形成趋势。
- 时间范围、市场边界或比较口径会实质改变结论时，先请求人工确认。

## 趋势与变化扫描补充

- 仅当用户明确要求对指定市场、人群、场景或时间范围做趋势/变化扫描时启用，不因正文偶然提到“趋势”而扩大任务。
- 趋势结论必须由至少两个可追溯、带日期的公开观察点支撑；Knowledge 和案例只能提供方法，不能证明当前市场事实。
- 缺少时间序列或可比来源时，降级为当前截面和待补纵向证据，不断言已经形成趋势。
- 时间范围、市场边界或比较口径会实质改变结论时，先请求人工确认。
