---
title: 持续发现（Continuous Discovery）
type: scenario-guide
domain:
  - 产品体验
research_type:
  - 定性
  - 探索
stage:
  - 迭代
tags:
  - 持续发现
  - Continuous Discovery
  - 产品三人组
  - OST
  - 每周访谈
  - 双轨
  - Teresa Torres
status: draft
sensitivity: internal
owner: 王仰龙
updated: 2026-06-24
related:
  - methods/toolbox/collection/interviews.md
  - methods/toolbox/analysis/issue-prioritization.md
  - methods/toolbox/analysis/longitudinal-benchmark-tracking.md
  - methods/toolbox/collection/in-product-longitudinal-tracking.md
  - methods/toolbox/analysis/experience-metrics-heart.md
  - methods/toolbox/analysis/ab-testing.md
  - assets/templates/opportunity-solution-tree.md
id: scenario_continuous_discovery
source: xingyun_wiki
source_path: methods/scenarios/product-experience/iteration/continuous-discovery.md
content_hash: sha256:6571aa6d3f0ff0e49faad1e55618670e754fca43987109a854271f897b6a5ba4
guide_tags: []
guide_stage:
  - intent
  - goal-definition
---

# 持续发现（Continuous Discovery）打法

> 来源：Joyspace《持续发现（Continuous Discovery）》 https://joyspace.jd.com/pages/LnnnXeI7dREvOyY0kB0x

> 本篇是**编排型**打法：把已有方法本体按路径编织成「迭代期该怎么持续打」的节奏指南，**不复制方法正文**。

## 场景定义 / 典型问题

持续发现不是一次性立项调研，而是让交付团队「边发版边每周与用户对话」的**研究节奏**——由产品三人组围绕一个可度量结果持续接触客户，使每个迭代周期都能回答「该探索什么、下一步改什么」，把发现（discovery）与交付（delivery）焊成并行的双轨。

它是本知识库中唯一一篇以「研究节奏」而非「单次研究动作」立身的打法——不是放进迭代里的某个工具，而是**贯穿所有迭代、把其他方法编织起来的元节奏**。正因如此它「迭代原生」：只有当团队真正处于持续交付状态时，「把小型研究做成每周例行」才成立；项目制的一次性研究无所谓「节奏」。

它与项目制研究的区别有三层：

- **频率**：从「大改版前调一次」变为「每周都在做」。
- **主体**：从专职研究员交付报告，变为产品三人组共同看访谈、共同决策。
- **目的**：从输出导向转为结果导向。

**这个场景常被问到的研究问题：**

- 团队已进入持续交付/快速迭代状态，如何获得稳定的一手用户输入来判断每轮迭代该探索什么、改什么？
- 怎样把「大型低频研究项目」拆成「小而可消化的每周接触点」，让发现喂养交付、交付反哺发现？
- 产品三人组（PM＋设计＋工程）如何共同承担发现而不拖慢决策速度？
- 每周招募总是凑不齐人——如何把招募自动化，让「每周找到受访者」不再成为放弃的借口？
- 如何把零散的用户反馈结构化为可沟通、可排序的决策载体（OST），并据此重写 OKR？
- 尚未这样工作、身处「功能工厂」的组织，如何从内部一点点渐进引入？

**适用前提与局限：** 必须真处于「持续迭代」才谈得上；依赖团队亲自参与与节奏纪律，招募断线就会半途而废；样本小不可做统计外推；若沦为「为确认而发现」则失真；组织若是功能工厂需先「meet people where they are」渐进引入。

## 推荐打法（编排）

> 持续发现由 Teresa Torres 在《Continuous Discovery Habits》中系统提出。最低标准被明确量化为：**至少每周与客户接触一次**（weekly touchpoints），且这些小型研究活动由真正构建产品的团队亲自执行，而非外包给一次性大研究或仅阅读现成报告。它要回答的是**节奏问题**：把直线（立项集中调研→交付→埋头数月）弯成闭环，**发现喂养交付、交付反哺发现**，二者并行（dual-track）。

| 步骤 | 用什么方法（引用路径） | 目的 / 产出 |
|---|---|---|
| 1 锚定可度量结果 | `methods/toolbox/analysis/experience-metrics-heart.md` ｜ `methods/toolbox/collection/satisfaction-survey.md` | 先定下本阶段要推动的成果（如某留存或满意度指标），用它约束探索范围——发现服务于结果，而非为研究而研究。约束探索的「可度量结果」来自体验度量与满意度问卷。 |
| 2 组建产品三人组 | （组织动作，无方法本体） | 让 PM、设计主管、技术主管共同承担发现，确保结论能快速进入交付；先从三人起步保速度，再按需引入研究员/分析师。**「三人组可以伸缩，但你是在用包容性换速度。」** |
| 3 自动化每周招募 | （见下「可复用素材/打法说明」三法表） | 用网站拦截、客服触发或客户顾问团把「每周接触」制度化，让「每周找到受访者」不再成为放弃的借口。Torres：招募是持续访谈的最大障碍。 |
| 4 做故事型访谈 | `methods/toolbox/collection/interviews.md`  | 每周至少一次接触，用「跟我讲讲你上一次……做某事」收集真实过往行为，从具体故事中浮现机会，而非验证既有方案。话术要点见下。 |
| 5 用 OST 可视化思考 | `assets/templates/opportunity-solution-tree.md` | 把零散反馈结构化为「业务结果→用户机会→候选方案→实验」，作为团队与利益相关方沟通决策的载体。 |
| 6 拉工程师进发现 | （组织动作，见下打法说明） | 用站会「after party」展原型收反馈、在 Slack 同步与放访谈录音、季度做「Discovery Zone」专场，让无法全程参与的工程师也持续在场。 |
| 7 小实验验证并闭环 | `methods/toolbox/analysis/ab-testing.md` | 对候选方案设计小型实验，把上一轮迭代的数据反哺下一轮发现，让双轨持续并行；并据成果重写 OKR。 |
| 纵向定量基线（贯穿） | `methods/toolbox/analysis/longitudinal-benchmark-tracking.md` ｜ `methods/toolbox/collection/in-product-longitudinal-tracking.md` | 持续发现提供「每周高频的定性输入」，跨版本纵向/基准追踪提供「跨迭代的纵向定量基线」，一快一慢共同支撑迭代决策；当每周招募不足或需就具体使用场景快速取证时，用线上在用追踪在真实情境中补齐触点，其行为数据也是 OST 叶节点小实验的取证来源。 |
| 机会收敛排序（贯穿） | `methods/toolbox/analysis/issue-prioritization.md` | OST 产出的用户机会与候选方案，需经问题分层与优先级评估做归类、定级、排序，收敛成迭代待办（Snagajob 即用 Kano、机会评估辅助筛选）。 |

### 打法说明（KEEP 要点）

**每周接触节奏（weekly touchpoints）——硬标准。** 判断「是否真在做持续发现」的硬标准就是每周至少接触一次客户。与其攒三个月做一次大研究，不如每周做一点——可从每周一次起步，重在不断线。

**产品三人组（PM＋体验设计师＋工程师）。** Torres 强调发现不该是瀑布式的角色交接，而由三人共同承担；她把这接到 Marty Cagan 的「传教士」（missionaries）——为共同使命协作的人。数据分析师、研究员、产品营销可以加入，但从三人组起步能保持决策速度。团队化发现的价值不止于速度：一个人盯着一个想法容易陷入确认偏误，**「团队越多元，越可能逮住你最危险的假设」**——她把「假设检验」列为最该全员参与的环节。

**双轨：发现喂养交付。** 每周访谈是带动一切的**基石习惯（keystone habit）**：有了稳定的访谈输入，原型才有人去测、实验才有方向、决策才有据可依——访谈不是孤立动作，而是「连接器」。

**为学习而非确认而发现。** 心态内核是**「为学习而发现，而非为确认而发现」**——不要拿访谈给已想好的方案背书。

**自动化招募三法（Torres：招募是持续访谈的最大障碍）：**

| 渠道 | 做法 | 适用 |
| --- | --- | --- |
| 网站拦截 | 直接从来访用户中招募受访者 | 有稳定网站流量的产品 |
| 客服触发 | 约定触发条件，让客服等一线团队帮忙招募 | 企业级/客户分散、需一线协助触达 |
| 客户顾问团 | 为难触达人群建常设面板，持续供给访谈对象 | 高门槛/小众人群（如投行、影业等） |

**故事型访谈话术（锚定过往真实行为，避免引导）——方法本体见 `methods/toolbox/collection/interviews.md`：**

| 类型 | 示例话术 |
| --- | --- |
| 故事开场 | "跟我讲讲你上一次<做某事>的情形。" |
| 还原细节 | "当时具体发生了什么？你先做了什么、后做了什么？" |
| 探询动机 | "那一步为什么这么做？当时是怎么想的？" |
| 规避失真 | 不以"什么/怎么/何时"开头问理想化行为，更不问"你会喜欢这个新功能吗"。 |

> 要点：以「什么/怎么/何时」开头的揣测式提问，应转化为对一个具体过往实例的追问——故事仍能回答这些问题，但因锚在真实发生过的事上，反馈可信得多。

**把工程师拉进发现。** 标准做法是站会上的「after party」（设计师展原型、工程师「贡献点子和草图」），Slack 同步进展与放访谈录音、带工程师下现场，以及季度两小时的「Discovery Zone」专场配早午餐讲发现所得——即便技术主管无法全程参与，也用这些低门槛触点保持其在场。

### Snagajob 案例（一手团队落地复盘）

Torres 公开的案例复盘里，一个满编小队由 2 名 API 工程师、2 名 UI 工程师、1 名 QA、设计师 Jenn 和 PM Amy 组成。

- **转型前**：工作由「直觉和领导指令」驱动，季度重组频繁，留下「一堆臃肿和未完成的产品」；Jenn 做过「耗时 8 小时却没人会看」的研究报告。
- **挂钩每周接触**：教练把他们「挂上了每周至少接触一名客户的钩子」——起初手忙脚乱，却逼着他们「变得机灵」、找到更好的触达方式。如今每周接触，一旦中断就「开始发痒、忍不住从 NPS 名单里随便打电话」。
- **实验顺着访谈节奏长出来**：手动实验「每月数次到每周数次」，代码级的假门测试「每季度几次」。
- **OST 用得有疏有密**（「有时每天、有时每月」），核心价值是**把决策思路可视化**，让利益相关方不再「往冲刺里扔变化球」。Jenn 自称「Teresa Torres 大使」，跨办公室开 1 小时工作坊（30 分钟观察研究 ＋ 30 分钟 OST）做组织推广。
- **训练期刻意拉长**：刻意用三个月训练——更短就会「假装在做」而养不成持久习惯。
- **Amy 的心得**：起初很怀疑，觉得重度发现是「咨询顾问让你定一个永远够不着的目标」；一年多后她的时间分配终于贴近「理想图」，用掉了「2.5 本笔记本」——她说这是在用「砍倒的树」衡量影响力。
- **成果**：他们「第一次真正同时做发现与交付」，把 MVP 持续增量打磨而非弃用，做出三个「用户无需引导浮层也会用」的功能，并把 OKR「围绕发现出的机会与成果」重写。

### 该场景特有注意点（常见坑与误用）

- **退化为一次性研究**：嘴上说持续，实际只在大改版前调一次——没有每周节奏就不是持续发现。
- **招募不自动化**：把招募当一次性项目去做，导致每周凑不齐受访者、节奏断裂；Torres 说这是持续访谈的头号障碍，必须自动化。
- **为确认而发现**：拿访谈给已定方案背书、只听想听的，违背「为学习而发现」的内核。
- **泛泛而问、问未来与假设**：问「你一般怎么做」「你会用这个新功能吗」，得到的是理想化志向与客套，而非真实行为。
- **研究与交付脱节**：仍由专职研究员单独做、交付报告，团队不亲自接触，洞察到决策的链路被拉长（正是 Snagajob 转型前「8 小时报告没人看」的状态）。
- **不锚定成果**：发现没有可度量结果约束，机会清单越堆越长却无从排序。
- **训练期偷工**：把养习惯当速成。Snagajob 刻意用三个月训练——更短就会「假装在做」而养不成持久习惯。
- **回潮后藏着干**：被外部压力逼回老路时把工作藏起来，只会招来更多微观管理；正解是「亮出你的工作」，但呈现的是综述结论（一页纸、学习卡、OST），不是原始录音和乱笔记。

## 套用的理论透镜

- `models/kano.md` ⚠️待补充(缺源)：Snagajob 用 Kano 辅助机会/方案筛选与定级。
- 双轨发现-交付（dual-track）、基石习惯（keystone habit）、传教士团队（missionaries，承自 Marty Cagan）：均见上文打法说明，为本打法的核心组织/认知透镜。

## 可复用素材

- 机会-解决方案树画布（OST）：`assets/templates/opportunity-solution-tree.md`
- 故事型访谈话术、自动化招募三法：见上「打法说明」（其访谈方法本体待补 `methods/toolbox/collection/interviews.md`）。

## 交付物

- 每周访谈快照。
- 机会-解决方案树（业务结果→用户机会→候选方案→实验），随迭代滚动更新。
- 滚动更新的机会清单与实验结论。
- 围绕机会与成果重写的 OKR。
- 对外呈现物：一页纸综述、学习卡、OST（而非原始录音和乱笔记）。

## 参考报告（在报告库，不在本库）

- 关联报告见用研报告库（按权限可见，不在本方法库）。

## 来源与参考

**related 路径：**
- `methods/toolbox/collection/interviews.md` 
- `methods/toolbox/analysis/issue-prioritization.md`
- `methods/toolbox/analysis/longitudinal-benchmark-tracking.md`
- `methods/toolbox/collection/in-product-longitudinal-tracking.md`
- `methods/toolbox/analysis/experience-metrics-heart.md`
- `methods/toolbox/analysis/ab-testing.md`
- `assets/templates/opportunity-solution-tree.md`

**原文 References：**
1. What a Good Continuous Discovery Team Looks Like [Case Study] — Teresa Torres, Product Talk — 一手案例·对谈复盘 — [https://www.producttalk.org/continuous-discovery-case-study/](https://www.producttalk.org/continuous-discovery-case-study/)
2. Continuous Interviewing: The Key to Successful Product Teams — Teresa Torres, Medium — 研究者长文 — [https://medium.com/@ttorres/continuous-interviewing-the-key-to-successful-product-teams-6bf63bfc1936](https://medium.com/@ttorres/continuous-interviewing-the-key-to-successful-product-teams-6bf63bfc1936)
3. Getting to a team-based approach to continuous discovery — Mind the Product(Torres) — 会议演讲·实操 — [https://www.mindtheproduct.com/getting-to-a-team-based-approach-to-continuous-discovery-by-teresa-torres/](https://www.mindtheproduct.com/getting-to-a-team-based-approach-to-continuous-discovery-by-teresa-torres/)
4. Even You Can Do Continuous Discovery — Product at Heart(Torres) — 会议演讲·组织落地 — [https://productatheart.com/blog/teresa-torres-even-you-can-do-continuous-discovery-bringing-the-discovery-habits-to-every-organization](https://productatheart.com/blog/teresa-torres-even-you-can-do-continuous-discovery-bringing-the-discovery-habits-to-every-organization)
