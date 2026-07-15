---
title: 四力模型（推力 / 拉力 / 焦虑 / 惯性）
type: model
domain:
  - 通用
research_type:
  - 定性
  - 探索
tags:
  - 四力模型
  - Four Forces
  - 推力
  - 拉力
  - 焦虑
  - 惯性
  - JTBD
  - 决策驱动力
  - 切换行为
status: draft
sensitivity: internal
owner: 李笑欣
updated: 2026-06-25
related:
  - models/jtbd.md
  - methods/toolbox/collection/switch-interview.md
id: model_four_forces
source: xingyun_wiki
source_path: models/four-forces.md
content_hash: sha256:bc5e6831cedbb3127d1df017b9200957373d1c87a77394c6655a1790398246fd
guide_tags:
  - framework
guide_stage:
  - need-discovery
---

# 四力模型（推力 / 拉力 / 焦虑 / 惯性）

> 一句话：用户从旧方案切换到新方案的决策由四种力量博弈决定——**推力 + 拉力 > 焦虑 + 惯性 时切换发生，否则用户继续将就**。
> 落点：`models/`。判据——它是 JTBD 体系下用于解释"切换决策"的子模型，且与 Switch Interview 访谈方法配套使用，是独立可复用的诊断框架。
> 边界：模型本身在 models；用它做用户访谈的步骤在 [`methods/toolbox/collection/switch-interview.md`](../methods/toolbox/collection/switch-interview.md)。

## 核心概念

四种力量同时作用于用户：

| 力 | 作用方向 | 含义 |
|---|---|---|
| **推力（Push）** | 推用户离开现状 | 当前方案的痛点、不满 |
| **拉力（Pull）** | 拉用户走向新方案 | 新方案带来的吸引力、希望 |
| **焦虑（Anxiety）** | 阻止用户走向新方案 | 对新方案的不确定、担心、风险感知 |
| **惯性（Habit / Inertia）** | 把用户钉在现状 | 现有习惯、沉没成本、转换成本 |

### 决策不等式

> **推力 + 拉力 > 焦虑 + 惯性 → 切换发生**
> **推力 + 拉力 ≤ 焦虑 + 惯性 → 用户继续将就（即使不满意现状）**

## 理论来源

- 提出者 / 背景：JTBD 体系（Bob Moesta、Chris Spiek 在 Christensen 框架基础上发展的"Forces of Progress"）。
- 本条目整理自：[Joyspace - Switch Interview访谈方法](https://joyspace.jd.com/pages/A0Yu6WdTBIVfYZWgJFXB)（李笑欣）。

## 关键构念 / 维度

⚠️ 待补充(缺源)：原文未给出每种力的子构念或诊断问句清单，仅给出名称和决策不等式。需 owner 用 Bob Moesta 的原始材料补齐。

## 如何作为透镜使用

### 问题定义阶段

- 把"为什么用户流失 / 为什么用户增长慢"翻译成四力诊断问题：哪种力不够 / 哪种力过强？

### 采集阶段

- 配合 Switch Interview——见 [`methods/toolbox/collection/switch-interview.md`](../methods/toolbox/collection/switch-interview.md)。
- 时间线还原后从故事里**逐一识别四种力**。

### 分析 / 结论阶段

- 对群体的四力分布做诊断：是推力不足（用户没那么不满）？拉力不够（新方案没吸引力）？焦虑太高（用户怕风险）？惯性太大（习惯难破）？
- 不同诊断对应不同**产品/营销/销售策略**。

## 与方法 / 分析的衔接

- 概念落到可操作工具：
  - 采集：[`methods/toolbox/collection/switch-interview.md`](../methods/toolbox/collection/switch-interview.md)
  - 分析：⚠️ 待补充(缺源)——是否有标准的"四力打分模板"原文未给。

## 局限与误用

🤖 草稿待审(AI生成)：以下基于通识，**未在原文核验，PR 时 owner 可决定是否保留**：

- **四力的强弱无统一量纲**——靠访谈定性判断，不同研究员可能给同一故事打出不同四力分布。
- **不是所有不切换的用户都靠焦虑/惯性挡住**——有时用户根本没感受到推力，框架不适用。
- **针对"渐进式产品改进"用，不太适合"全新品类"**——后者用户根本没有"旧方案"。

## 关联

- related:
  - [`models/jtbd.md`](jtbd.md) — JTBD 体系下的子模型
  - [`methods/toolbox/collection/switch-interview.md`](../methods/toolbox/collection/switch-interview.md)
  - [`models/user-needs.md`](user-needs.md)

## 来源与参考

- 原始资料：[Joyspace - Switch Interview访谈方法](https://joyspace.jd.com/pages/A0Yu6WdTBIVfYZWgJFXB)（李笑欣）
- 外部参考：Bob Moesta & Chris Spiek 关于"Forces of Progress"的论述。
