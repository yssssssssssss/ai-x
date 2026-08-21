---
title: 标准化体验量表（SUS / UMUX-Lite / SEQ / NPS / CSAT / CES）
type: asset
domain:
  - 通用
research_type:
  - 定量
tags:
  - 量表
  - SUS
  - UMUX-Lite
  - SEQ
  - NPS
  - CSAT
  - CES
status: draft
sensitivity: internal
owner: 王仰龙
updated: 2026-06-24
related:
  - methods/toolbox/analysis/experience-metrics-heart.md
  - methods/toolbox/collection/satisfaction-survey.md
content_hash: sha256:cda26c5fae5de864ec9d46e31a2acf571fce2e848d45129191cc4066a27881d5
---

# 标准化体验量表（SUS / UMUX-Lite / SEQ / NPS / CSAT / CES）

> 来源：Joyspace《体验度量方法（UX Metrics：HEART 框架与体验量化）》 https://joyspace.jd.com/pages/xs4SHKkBjZXdrTOdOdyH

> 标准量表选型与计分参考。本卡不包含可直接投放的完整授权题项；使用前必须回到原始量表、确认语言版本与授权，并按目标人群和研究时期选择可比基准。

## 内容

### SUS（System Usability Scale，系统可用性量表）

- **来源**：Brooke 1986 年提出。
- **题数 / 点数**：10 题，5 点量表。
- **计分**：换算到 **0–100** 分（注意：**不是百分比**）。
- **历史参考**：公开汇总研究常见中心值约 **68**，但不同产品、人群和年代不可直接横比；使用时记录所选基准的来源、样本与日期。
- **解读**：最佳方式是转成**百分位等级**（如 80.3 分约为 A，68 分约为 C），而非看绝对分。

### UMUX-Lite

- **来源**：Lewis 等人提出的精简量表。
- **题数**：**2 题**，分别测"功能满足需求（**有用性**）"与"**易用性**"。
- **特性**：公开研究报告与 SUS 高相关；具体相关系数和换算公式必须引用所采用版本的原始研究，不把单一历史数值当成永久常量。
- **适用**：适合塞进短问卷、又想沿用 SUS 基准的场景。

### SEQ（Single Ease Question，单题难易度）

- **题数 / 点数**：**单题**，**7 点**量表，任务做完立刻问。
- **测什么**：单个任务的主观难度。
- **历史参考**：公开研究常见中心值约 **5.5**；是否异常必须使用同任务、同人群或明确来源的基准。
- **解读**：评分**低于 5** 时追问原因，可即时拿到诊断线索。

### NPS（Net Promoter Score，净推荐值）

- **量纲**：0–10 的推荐意愿。
- **分类**：推荐者（Promoters，**9–10**）、被动者（Passives，**7–8**）、贬损者（Detractors，**0–6**）。
- **计分**：**NPS = 推荐者% − 贬损者%**。
- **基准**：不提供跨行业永久平均值；按同市场、同人群、同时间窗口建立基线。
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
- **分数要使用有来源的对标，不要看绝对值**：
  - SUS 70 分不是"70% 好"；若转百分位，必须声明所用常模版本、样本与日期。SUS/NPS 只有放在适用基准或纵向趋势中才可解释。
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
