---
id: model_nielsen_heuristics
type: model
title: 尼尔森十大可用性启发式（Nielsen's 10 Usability Heuristics）
domain:
  - 通用
tags:
  - ux-audit
guide_stage:
  - need-discovery
summary: ""
source: xingyun_wiki
source_path: models/nielsen-heuristics.md
content_hash: sha256:f40e931422cc6073e150c62410af75ec790bef3bbb66dfca4435e5b2e8b650fc
status: draft
updated_at: 2026-07-15
---

# 尼尔森十大可用性启发式（Nielsen's 10 Usability Heuristics）

> 一句话：一套通用的交互界面"好用与否"的判断准则——10 条经验法则，作为专家检视（启发式评估 / 体验走查）时逐条比对界面的标尺。
> 落点：`models/`。判据——它是一组**贯穿评估全程的概念透镜/设计原则**，描述"被研究的界面本身好不好"，拆开任一条都仍成立，但作为一套"评什么"的标准被反复套用。
> 边界：本篇只讲**这套准则是什么、每条什么含义**（透镜本体）；**"怎么组织一次评估、几个评估员、严重度怎么打分、怎么汇总"** 属方法本体，见 `methods/toolbox/collection/heuristic-evaluation.md`；"研究怎么做对"的规则属 `standards/`。

## 核心概念

- **启发式（heuristic）= 经验法则，不是精确规范。** Nielsen 本人强调它们是 "broad rules of thumb and not specific usability guidelines"——粗粒度、广适用，而非逐像素的设计规约。正因为粗，它几十年跨 Web / App / VR / 语音 等界面始终适用。
- **用途：专家检视的标尺。** 这 10 条是**启发式评估 / 体验走查**的核心准则——由少数评估员（专家）拿这套标尺逐屏、逐流程地检视界面，找出"违反了哪一条"的可用性问题。它**不需要真实用户参与**，因此可以快、可以早、可以低成本地先扫一遍。
- **违反 ≠ 一定是问题。** 一条启发式被违反，只是"值得警惕的信号"，是否真的是问题取决于场景与替代方案的权衡（见"局限与误用"）。

## 理论来源

- 提出者：**Jakob Nielsen 与 Rolf Molich**，1990 年首次提出；1994 年 Nielsen 基于对 **249 个可用性问题的因子分析**精炼为现在这 10 条，此后**条目本身保持不变**。
- 出处：Nielsen Norman Group，《10 Usability Heuristics for User Interface Design》（1994 提出，2020 / 2024 补充了解释与示例，原则未变）。
- 配套：Nielsen《How to Conduct a Heuristic Evaluation》（评估流程）、《Severity Ratings for Usability Problems》（0–4 严重度评级，1994）。
- 本土化参考：京东《产品体验问题走查指南》——以这 10 条为基本准则，结合电商平台特性补充了大量正反例（本篇下方电商示例多取自此）。<!-- 来源：Joyspace《产品体验问题走查指南-20230328》file/HKJmLDMRHWNXJqYWj3n5 -->

## 关键构念 / 维度 —— 十大启发式

> 每条给出：**英文原名 + 释义 + 一个电商场景示例**。中文名沿用业界常见译法（括注京东走查指南/参考海报的措辞差异）。

**1. 系统状态可见性 · Visibility of system status**
设计应通过在**合理时间内的适当反馈**，让用户随时了解正在发生什么。可见的状态建立信任、帮用户决定下一步。
- 例：商详页点"加入购物车"后立即出现"添加成功"反馈；购物车提示"还差 ¥XX 免运费"。

**2. 系统与现实世界匹配 · Match between the system and the real world**
说**用户的语言**——用用户熟悉的词汇、概念，而非内部黑话；遵循现实惯例，让信息以自然、合逻辑的顺序出现。
- 例（反）：优惠券显示"已抢光 15:00 开抢"——用户早上 8 点看到既"已抢光"又"15:00 开抢"，自相矛盾、困惑；实为"上一场已抢光、下一场 15:00 开始"。

**3. 用户控制与自由 · User control and freedom**
用户常误操作，需要一个**明确标记的"紧急出口"**来撤离，而不必走一长串流程。支持撤销 / 重做、提供易发现的取消。
- 例（反）：进入下一级页面后无法返回上一级；弹窗无法关闭或关闭按钮难找；直播小窗遮挡结算按钮且挪不开。

**4. 一致性与标准化 · Consistency and standards**
同样的词、状态、操作应**意思一致**；遵循平台与行业惯例（呼应"雅各布定律"——用户把在别处养成的预期带到你这）。不一致会抬高认知负担。
- 例（反）：主图是"紫砂壶茶巾"、标题却写"紫砂壶"，图文品类不一致；同一商品在商详页与结算页展示的时效不一致。

**5. 预防错误 · Error prevention**
好的报错很重要，但**最好的设计是从源头阻止错误发生**——要么消除易错情形，要么在用户提交前做检查并给确认。错误分"失误（slips）"与"错误（mistakes）"两类。
- 例：清空聊天记录前弹二次确认，避免误删。
- 例（反）：商详页不按最大库存限制可加车数量，直到结算才提示库存不足。

**6. 识别而非回忆 · Recognition rather than recall**
让元素、操作、选项**可见**，最小化用户记忆负担；用户不应被迫记住从界面一处到另一处的信息。
- 例：登录验证码短信支持"一键复制"，用户无需记忆；频道分类栏下滑时吸顶常驻。

**7. 灵活性与使用效率 · Flexibility and efficiency of use**
为专家用户提供**对新手隐藏的加速器（快捷方式）**，让设计同时服务生手与熟手；允许用户自定义高频操作。
- 例（反）：批量浇水做不到，每次只能浇一点且强制等动画，高频用户操作极繁琐。

**8. 美观与简约设计 · Aesthetic and minimalist design**
界面不应包含**无关或极少用到的信息**——每多一分信息都在与关键信息争夺注意力、削弱其相对可见度。（不等于"扁平/性冷淡风"，而是聚焦本质。）
- 例（反）：商详页核心诉求是看商品介绍，但服务/评价/测评/推荐占位过多，用户要下滑 3 屏才看到介绍。

**9. 帮助用户识别、诊断并从错误中恢复 · Help users recognize, diagnose, and recover from errors**
错误信息用**通俗语言**（不甩错误码），精确指出问题，并建设性地给出解决方案；用醒目的视觉（如红色粗体）呈现。
- 例（反）：填好用户名密码后"登录"按钮仍灰着、无任何提示，用户卡死不知为何、如何继续。

**10. 帮助与文档 · Help and documentation**
最理想是系统无需额外解释即可用；但必要时应提供文档——**可检索、聚焦任务、简洁、列出具体步骤**。
- 例：上新功能时给新手指引，说明"是什么、怎么用"。

## 如何作为透镜使用

- **问题定义阶段**：把"我们要评什么"锚定到这 10 条上——即便不做正式评估，写需求/评审设计稿时也可拿它当 checklist 快速自查。
- **采集 / 走查阶段**：作为**启发式评估**的评分标尺。评估员对界面做两遍检视（先熟悉、再逐条比对违反了哪几条），按京东走查的节奏"整体浏览 → 模拟使用 → 查漏补缺"逐屏排查。详见方法本体 `heuristic-evaluation.md`。
- **分析 / 结论阶段**：把发现的问题**按违反的启发式归类**，再叠加**严重度（0–4）**排序，形成"改什么、先改什么"的优先级清单（接 `analysis/issue-prioritization.md`）。

## 与方法 / 分析的衔接

- 概念落到"怎么组织一次评估"：见 `methods/toolbox/collection/heuristic-evaluation.md`（评估员人数、独立评估+两遍法、严重度评级、汇总）。
- 把问题排优先级出图：见 `methods/toolbox/analysis/issue-prioritization.md`。
- 与"真人任务测试"的关系：见 `methods/toolbox/collection/usability-testing.md`——启发式评估是**补充而非替代**用户研究。

## 局限与误用

- **违反一条 ≠ 一定有问题，要看场景。** Nielsen 原话 "it depends"：如汉堡菜单违反"识别而非回忆"，但在移动端可能是合理取舍。**但也别赌自己恰好是那个例外**——"you should not bet that your design is one of the few exceptions"。
- **替代不了用户研究。** 启发式评估擅长找出"明显的"问题、低成本扫雷，但 UX 高度依赖情境，仍须用真实用户验证（启发式评估常用作正式可用性测试前的预扫）。
- **单人不可靠，需要多名评估员。** 任一评估员（再资深）都会漏掉一部分问题；Nielsen 建议 **3–5 名独立评估员**合并结果，单人严重度评分也"too unreliable"，需多人独立打分取均值。
- **是经验法则、非精确规范。** 它告诉你"往哪看"，不告诉你"具体该多大/什么色"——精确规约需另查设计规范。

## 关联

- related：`methods/toolbox/collection/heuristic-evaluation.md`（评估方法本体）· `methods/toolbox/collection/usability-testing.md`（互补的真人任务测试）· `methods/toolbox/analysis/issue-prioritization.md`（问题优先级）
- 被技能调用：`skills/run-heuristic-evaluation/`（以本篇为评分标尺执行/编排一次启发式评估）
