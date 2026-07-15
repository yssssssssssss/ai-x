---
title: 期望确认理论（ECT）
type: model
domain:
  - 通用
research_type:
  - 定性
  - 定量
  - 评估
tags:
  - ECT
  - 期望确认理论
  - ECM
  - Expectation Confirmation
  - 满意度
  - 落差
  - Gap
  - Kano
  - SERVQUAL
status: draft
sensitivity: internal
owner: 王仰龙
updated: 2026-06-24
related:
  - methods/toolbox/collection/interviews.md
  - methods/toolbox/analysis/key-driver-analysis.md
  - methods/toolbox/collection/satisfaction-survey.md
  - methods/toolbox/analysis/experience-metrics-heart.md
  - methods/toolbox/analysis/issue-prioritization.md
  - models/kano.md
id: model_ect
source: xingyun_wiki
source_path: models/ect.md
content_hash: sha256:d6916632fdde4d3363835455b218080c9192a45643a8b06990ed58b1159d297d
guide_tags: []
guide_stage:
  - need-discovery
---

# 期望确认理论（ECT）

> 来源：Joyspace《期望确认理论（ECT）》 https://joyspace.jd.com/pages/qLN1jFG2l74Dy1cxRMJM

> 一句话：用"使用前期望"与"使用后感知"的比较来解释满意度的形成，在迭代上线后逐价值点定位失望点与惊喜点。
> 落点：`models/`。判据——拆开就讲不通、贯穿全程才成立（ECT 贯穿问题定义→采集→结论）。
> 边界：models 描述「被研究的东西本身长什么样 / 好不好」；「研究怎么做对」属 `standards/`；「怎么算/出图」属 `toolbox/analysis/`。

## 核心概念

ECT 用一句话讲清：满意度由"使用前期望（E）"与"使用后实际感知（P）"的比较结果（确认 / 不确认）决定，而不是由感知绝对值单独决定。

它由四个构念及其因果链构成：

- **期望（Expectations，E）**：使用前对产品/功能将如何表现的预判，是比较的"基准线"，同时影响感知与不确认。
- **感知绩效（Perceived performance，P）**：对产品实际表现的主观感受。
- **确认 / 不确认（Confirmation / Disconfirmation）**：把实际体验与原有期望对比后的判断。
- **满意度（Satisfaction）**：直接由不确认与感知绩效决定。

核心逻辑用落差表达：

$$\text{Gap} = \text{期望（E）} - \text{感知（P）}$$

按本系列约定：

- **Gap 为正**（期望高于实际，负向不确认）→ **失望点**，拉低满意度，候选 P0。
- **Gap 为负**（实际超出期望，正向不确认）→ **惊喜点**，抬升满意度，可沉淀为卖点。
- **Gap≈0**（期望与感知一致）→ 确认 / 中性。

适用场景：新版本/新功能上线后，评估"用户认知与预期偏差""问题是否被真正解决""体验的量化收益"。输入是待评估的价值点清单、目标用户、上线前后的期望与感知测量（量表/访谈）；输出是各价值点的期望—感知落差图、失望点（P0）与惊喜点清单、满意度归因线索。

## 理论来源

- **提出者 / 出处**：Richard L. Oliver 于 1977、1980 年在消费者满意度研究中提出，论文《A Cognitive Model of the Antecedents and Consequences of Satisfaction Decisions》。后被广泛引入信息系统与产品体验领域。

## 关键构念 / 维度

ECT 的四个构念及其关系：

- **期望（Expectations）**：使用前的预判，作为比较基准；既影响感知，也影响不确认的方向与幅度。
- **感知绩效（Perceived performance）**：对实际表现的主观感受，是与期望对照的另一端。
- **确认 / 不确认（Confirmation / Disconfirmation）**：实际体验与期望对照后的判断。正向不确认（超出期望）抬升满意度，负向不确认（低于期望）拉低满意度。
- **满意度（Satisfaction）**：因变量，直接由不确认与感知绩效共同决定。

落差是这套构念的可操作表达：

$$\text{Gap} = \text{期望} - \text{感知}$$

正数为失望点（期望高于实际），负数为惊喜点（实际超出期望）。

### 扩展：IS 持续使用模型（ECM）

Bhattacherjee（2001）在 *MIS Quarterly* 提出**期望确认模型（ECM, Expectation-Confirmation Model）**，将 ECT 改造为解释"信息系统持续使用"的模型：

$$\text{确认（confirmation）} \rightarrow \text{感知有用性（perceived usefulness）} + \text{满意度（satisfaction）} \rightarrow \text{持续使用意愿（continuance intention）}$$

关键改造是用**"使用后期望"替代"使用前期望"**——持续使用阶段用户的期望已被真实体验修正，确认程度越高，越能提升感知有用性与满意度。这一点对产品迭代尤为贴切：迭代面对的是已有使用经验的存量用户。

### 同源补充框架

- **Kano 模型**：区分基本型（缺失则强烈不满，满足仅中性）、期望型（随满足程度线性升降）、兴奋型（超预期带来惊喜，缺失不致不满），正好对应"失望点"与"惊喜点"的非对称性。详见 `models/kano.md`（⚠️待补充(缺源)）。
- **SERVQUAL 的差距模型**：把质量直接量化为"期望与感知之差"（Gap 5 是唯一可直接测量的差距），为逐价值点配对测量提供了成熟范式。

## 如何作为透镜使用

ECT 属于【效果评估】类透镜，回答"问题是否被解决、认知与预期是否偏差、体验收益能否量化"。最佳时机是**新版本/新功能上线后**：对每个核心价值点分别测"期望"与"感知"，算出落差，把负向不确认最严重的点标记为 P0（优先修复），把正向不确认的点沉淀为可放大的产品卖点。

下面把源文「操作步骤」映射进研究阶段——采集阶段负责测 E、测 P 与质性归因，分析阶段负责算 Gap、定位与回流。

**问题定义阶段**

1. **拆价值点**：把迭代涉及的体验拆为可独立评价的价值点（如"加载速度""下单流程""信息找得到"），形成评测清单。
2. **四层拆解建表**：对每个价值点准备"认知 / 期待 / 实际感知 / 落差"四层，认知层判断用户是否知道该价值点存在。

**采集阶段**

3. **测期望（E）**：对有真实使用经验的用户，就该价值点的期望水平打分（推荐独立分组或使用前先测，降低偏差）。
4. **测感知（P）**：在同一量表上测实际体验感知。
5. **质性归因**：对高落差点追加开放题或访谈，弄清"为什么没达预期"。质性采集主要载体见 `methods/toolbox/collection/interviews.md`。

**分析 / 结论阶段**

6. **算落差**：$\text{Gap} = E - P$，逐点计算并排序。
7. **定位失望/惊喜点**：Gap 显著为正→失望点（候选 P0）；显著为负→惊喜点。
8. **回流下游**：失望点进迭代待办，惊喜点进卖点库，结构化数据交给满意度驱动因素分析 `methods/toolbox/analysis/key-driver-analysis.md`。

### 测量模板与降偏差测法

测量推荐"配对同尺度"，可用 5/7 级量表。逐价值点模板：

| 价值点 | 认知(是否知道) | 期望E (1–7) | 感知P (1–7) | 落差 Gap=E−P | 判定 |
| --- | --- | --- | --- | --- | --- |
| 加载速度 | 是 | 6.2 | 4.1 | +2.1 | 失望点 (P0) |
| 优惠透明度 | 否 | — | — | — | 先补认知 |
| 一键复购 | 是 | 4.5 | 6.0 | −1.5 | 惊喜点 |

降低偏差的三种测法（据 Sauro）：

1. 使用前测期望、使用后测感知；
2. **独立分组**——一组只测期望、另一组只测感知，互不影响；
3. 若仅能事后测，承认"近因效应"会让事后评分主导，并据此审慎解读。

开放题模板："你原本以为这里会怎样？实际体验和你想的差在哪？"

## 与方法 / 分析的衔接

概念落到可操作的采集与分析时看：

- **用户深度访谈**（`methods/toolbox/collection/interviews.md`）：作为 ECT 的主要采集载体，补充"为什么落差"的质性证据。
- **满意度驱动因素分析**（`methods/toolbox/analysis/key-driver-analysis.md`）：ECT 产出的逐价值点满意/落差数据，是其识别关键驱动因子的直接输入。
- **满意度问卷设计与数据清洗**（`methods/toolbox/collection/satisfaction-survey.md`）：期望与感知的配对量表需经规范问卷设计与清洗才可用。
- **体验度量方法**（`methods/toolbox/analysis/experience-metrics-heart.md`）：可把 Gap 沉淀为可追踪的体验指标，跨版本对比收益。
- **问题分层与优先级评估**（`methods/toolbox/analysis/issue-prioritization.md`）：失望点（P0）/惊喜点按落差大小与影响面进入优先级排序。

## 局限与误用

- **回忆/一致性偏差**：事后追问期望时，用户会为保持前后一致而"修改记忆"，或受结果反推（后见之明）。优先前测或独立分组。
- **意愿≠行为**：满意或"愿意继续用"不等于真实留存，需与行为数据交叉验证。
- **对无经验用户测感知**：未真实使用就打分（Nielsen 强调"只看截图打分完全无效"），结论失真。
- **只测总体满意度**：不拆价值点就无法定位"哪里"出问题，丧失诊断力。
- **混淆基本型与兴奋型**：把"补足基本型"当成"制造惊喜"——基本型做到位只换来中性，不会带来额外满意（Kano）。

## 关联

- related（同源 / 上下游）：
  - `methods/toolbox/collection/interviews.md`  — 质性归因主要采集载体
  - `methods/toolbox/analysis/key-driver-analysis.md` — 落差数据下游
  - `methods/toolbox/collection/satisfaction-survey.md` — 配对量表的问卷设计与清洗
  - `methods/toolbox/analysis/experience-metrics-heart.md` — 把 Gap 沉淀为可追踪体验指标
  - `methods/toolbox/analysis/issue-prioritization.md` — 失望点/惊喜点优先级排序
- related（相关模型）：
  - `models/kano.md` ⚠️待补充(缺源) — 基本型/期望型/兴奋型对应失望点与惊喜点的非对称性
  - SERVQUAL 差距模型（暂无独立条目）— 把质量量化为"期望与感知之差"的成熟范式

### 来源与参考

1. Expectation confirmation theory — Wikipedia — 文章 — [https://en.wikipedia.org/wiki/Expectation_confirmation_theory](https://en.wikipedia.org/wiki/Expectation_confirmation_theory)
2. Understanding Information Systems Continuance: An Expectation-Confirmation Model — Anol Bhattacherjee, MIS Quarterly 25(3):351–370 (2001) — 学术论文 — [https://www.jstor.org/stable/3250921](https://www.jstor.org/stable/3250921)
3. Satisfaction vs. Performance Metrics — Jakob Nielsen, Nielsen Norman Group — 文章 — [https://www.nngroup.com/articles/satisfaction-vs-performance-metrics/](https://www.nngroup.com/articles/satisfaction-vs-performance-metrics/)
4. Measuring & Modeling Customer Expectations — Jeff Sauro, MeasuringU — 文章 — [https://measuringu.com/measuring-expectations/](https://measuringu.com/measuring-expectations/)
5. Kano model — Wikipedia — 文章 — [https://en.wikipedia.org/wiki/Kano_model](https://en.wikipedia.org/wiki/Kano_model)
6. SERVQUAL（服务质量差距模型） — Wikipedia — 文章 — [https://en.wikipedia.org/wiki/SERVQUAL](https://en.wikipedia.org/wiki/SERVQUAL)
