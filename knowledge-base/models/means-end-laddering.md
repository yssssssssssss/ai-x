---
id: model_means_end_laddering
type: model
title: 梯子理论（手段-目的链 / Means-End Laddering）
domain:
  - 通用
tags: []
guide_stage:
  - need-discovery
summary: ""
source: xingyun_wiki
source_path: models/means-end-laddering.md
content_hash: sha256:a1ff7826566028aafa837d786841f26e106d6a12f03e604e4c7deb8527f87e41
status: draft
updated_at: 2026-07-15
---

# 梯子理论（手段-目的链 / Means-End Laddering）

> 来源：访谈技巧知识库·彭玲娇《用户访谈——我以为我会了》、《深度访谈实战指南：告别尬聊与表面信息》（均提出「梯子理论 / 阶梯式追问」并给出 A→C→V 示例链）。理论根源：Gutman 的手段-目的链（Means-End Chain）理论。
>
> 一句话：用户的具体产品偏好背后，藏着一条「**属性 → 利益/后果 → 价值观**」的意义阶梯；逐级追问，能把表层功能反应一路挖到深层动机。
> 落点：`models/`。判据——它是贯穿「提纲设计→追问执行→动机分析」的概念透镜，拆开讲不通。

## 核心概念

人之所以偏好某个产品/功能，并非因为属性本身，而是因为属性带来的**后果/利益**最终满足了某种**价值观**。三层阶梯：

- **属性（Attribute）**：产品/功能的具体特征或用户的具体行为（"这个功能能批量导出"）。
- **利益 / 后果（Consequence）**：属性给用户带来的功能性或心理性结果（"省了我很多时间"）。
- **价值观（Value）**：后果最终服务的、用户珍视的人生目标或自我认同（"我想把时间留给更重要的事 / 工作生活平衡"）。

操作上通过对同一线索反复追问「**这对您来说意味着什么？/ 为什么这一点对您重要？**」逐级向上攀爬，故称"爬梯子（laddering）"。

## 解释或预测什么

解释「用户为什么真正在乎某个属性」，把易变、表层的功能偏好，归因到稳定、深层的动机与价值观——从而预测：当属性变化时用户的取舍，以及哪些新方案能命中同一条价值链。

## 核心构念与关系

一条典型的阶梯（A→C→V）示例：

| 层级 | 内容 | 追问 |
|---|---|---|
| 属性 A | "我喜欢它的快捷记录功能" | "这个功能对你意味着什么？" |
| 后果 C1 | "能帮我节省时间" | "节省时间对你来说为什么重要？" |
| 后果 C2 | "让我有更多时间做别的事" | "更多时间你最想用来做什么？" |
| 价值观 V | "想多陪家人、平衡工作与生活" | （触达核心价值，停止） |

- 一个属性可通往多条后果，多条后果可收敛到同一价值观，构成"价值阶梯网"。
- 与 ORID（客观→反应→诠释→决定，见 `models/orid.md`）的区别：ORID 是**一次提问的四层结构**，laddering 是**对同一线索的纵向反复攀爬**，目标直指价值观；二者可叠用（用 ORID 的"诠释"层做 laddering 的起点）。

## 适用与边界

- 适用：动机洞察、需求分级、概念/卖点提炼、价值主张设计——凡需回答"用户深层为什么在乎"。
- 边界与误读：
  - 不是每个属性都能爬到价值观，遇到"就是顺手/没什么特别"应停止，强爬会诱导用户**编造**理由（与 `methods/toolbox/collection/respondent-bias.md` 的特殊动机偏误呼应）。
  - 连续追问"为什么"易让用户疲劳或防御；宜换用"这对你意味着什么""这一点为什么重要"等更柔和的爬梯话术，并配合留白（见 interviews.md「沉默 10 秒」）。
  - 价值观层带主观诠释，分析时需多案例交叉验证，避免研究者过度解读。

## 如何落到研究中

- 提纲设计：在关键属性/功能题后预埋 2–3 级 laddering 追问位（见 `methods/toolbox/collection/interview-guide-design.md`）。
- 执行：把 laddering 作为 interviews.md「系统追问技巧」的一种纵向深挖式（见 interviews.md 关键技巧）。
- 分析：把多位用户的阶梯汇总成价值阶梯网（hierarchical value map），定位高频价值锚点。

## 关联

- 采集/追问执行：`methods/toolbox/collection/interviews.md`
- 提问层级对照：`models/orid.md`
- 场景化需求挖掘：`methods/toolbox/collection/scenario-based-need-discovery.md`
- 洞察认知：`models/user-insight.md`

## 来源与参考

- 访谈技巧知识库·彭玲娇《用户访谈——我以为我会了》（提出梯子理论：属性→利益→心理利益→价值观）。
- 访谈技巧知识库·《深度访谈实战指南：告别尬聊与表面信息，挖掘用户宝藏》（阶梯式追问法 A→C→V 示例链）。
- Gutman, J. (1982). A Means-End Chain Model Based on Consumer Categorization Processes. *Journal of Marketing*.（手段-目的链理论根源；🤖 学术根源为常识性补注，原文未必直接引用。）
