---
title:          标准化体验量表（SUS / UMUX-Lite / SEQ / NPS / CSAT / CES）
type:           asset
domain:         [通用]
research_type:  [定量]
tags:           [量表, SUS, UMUX-Lite, SEQ, NPS, CSAT, CES]
status:         draft
sensitivity:    internal
owner:          王仰龙
updated:        2026-06-24
related:        [methods/toolbox/analysis/experience-metrics-heart.md, methods/toolbox/collection/satisfaction-survey.md]
---

# 标准化体验量表（SUS / UMUX-Lite / SEQ / NPS / CSAT / CES）

> 来源：Joyspace《体验度量方法（UX Metrics：HEART 框架与体验量化）》 https://joyspace.jd.com/pages/xs4SHKkBjZXdrTOdOdyH

> 现成可直接拿来用的标准化量表。价值在于它们有公开基准可对标——用来度量 HEART 框架的"愉悦度（Happiness）"与"任务成功（Task success）"维度。

## 内容

### SUS（System Usability Scale，系统可用性量表）

- **来源**：Brooke 1986 年提出。
- **题数 / 点数**：10 题，5 点量表。
- **计分**：换算到 **0–100** 分（注意：**不是百分比**）。
- **基准**：跨 500 项研究的平均分约 **68**——高于 68 为优于平均，低于 68 为低于平均。
- **解读**：最佳方式是转成**百分位等级**（如 80.3 分约为 A，68 分约为 C），而非看绝对分。

### UMUX-Lite

- **来源**：Lewis 等人提出的精简量表。
- **题数**：**2 题**，分别测"功能满足需求（**有用性**）"与"**易用性**"。
- **特性**：与 SUS 高度相关（**r = .83**），并有**回归公式可换算成 SUS 等效分**。
- **适用**：适合塞进短问卷、又想沿用 SUS 基准的场景。

### SEQ（Single Ease Question，单题难易度）

- **题数 / 点数**：**单题**，**7 点**量表，任务做完立刻问。
- **测什么**：单个任务的主观难度。
- **基准**：平均分约 **5.5**。
- **解读**：评分**低于 5** 时追问原因，可即时拿到诊断线索。

### NPS（Net Promoter Score，净推荐值）

- **量纲**：0–10 的推荐意愿。
- **分类**：推荐者（Promoters，**9–10**）、被动者（Passives，**7–8**）、贬损者（Detractors，**0–6**）。
- **计分**：**NPS = 推荐者% − 贬损者%**。
- **基准**：消费类软件 NPS 平均约 **21%**。
- **定位**：NPS 是忠诚度的"**症状**"而非原因，宜搭配价值/质量/易用性问题做归因。

### CSAT（Customer Satisfaction）

- 测**单点满意度**（针对某次交互/某个功能/整体的满意程度）。

### CES（Customer Effort Score，费力度）

- 测**费力度**——用户为完成目标付出了多少努力。

## 使用说明

- **量表选型口诀**：
  - 要**全面**评估可用性 → 用 **SUS**。
  - 问卷要**短** → 用 **UMUX-Lite**（可换算 SUS，沿用其基准）。
  - 只评**单个任务** → 用 **SEQ**。
  - 要**忠诚度**、对外沟通 → 用 **NPS**。
- **分数要对标百分位，不要看绝对值**：
  - SUS 70 分不是"70% 好"，应转百分位等级解读；SUS/NPS 分数本身没意义，必须放进基准或百分位中看。
  - NPS 把 11 点压成 3 类会放大误差，做统计分析时宜保留原始均值。
- **样本量**：量化量表需达到最小样本量才有统计显著性，否则差异可能只是噪声。

## 来源

- 采矿自 Joyspace《体验度量方法（UX Metrics：HEART 框架与体验量化）》 https://joyspace.jd.com/pages/xs4SHKkBjZXdrTOdOdyH
- 量表原始出处（原文 References）：
  - SUS — Measuring Usability with the System Usability Scale (SUS) — Jeff Sauro / MeasuringU — [https://measuringu.com/sus/](https://measuringu.com/sus/)
  - SEQ — 10 Things To Know About The Single Ease Question (SEQ) — Jeff Sauro / MeasuringU — [https://measuringu.com/seq10/](https://measuringu.com/seq10/)
  - UMUX-Lite — Measuring Usability: From the SUS to the UMUX-Lite — Jeff Sauro & James Lewis / MeasuringU — [https://measuringu.com/umux-lite/](https://measuringu.com/umux-lite/)
  - NPS — 10 Things To Know About Net Promoter Scores (NPS) — Jeff Sauro / MeasuringU — [https://measuringu.com/nps-ux/](https://measuringu.com/nps-ux/)

## 关联

- 父方法：[体验度量方法（HEART 框架与体验量化）](../../methods/toolbox/analysis/experience-metrics-heart.md)——本量表服务于其"愉悦度/任务成功"维度的度量。
- 常配合：[满意度问卷设计与数据清洗](../../methods/toolbox/collection/satisfaction-survey.md)——量表题项随问卷采集，问卷设计与清洗质量决定量表可信度。
