---
title: Persona 构建（Cooper 法）
type: analysis
domain:
  - 通用
research_type:
  - 定性
  - 探索
tags:
  - Persona
  - 用户角色
  - Cooper
  - PERSONA七要素
  - 用户画像
  - 同理心地图
  - 人物角色卡片
status: draft
sensitivity: internal
owner: 李笑欣
updated: 2026-06-25
related:
  - models/user-personas-segmentation.md
  - methods/toolbox/collection/interviews.md
id: toolbox_analysis_persona_building
source: xingyun_wiki
source_path: methods/toolbox/analysis/persona-building.md
content_hash: sha256:4b96eb23e362c6adfd2654b183adfc316130a0a6f061e11fe2547e59529d4cca
guide_tags:
  - persona
  - audience
guide_stage:
  - method-selection
---

# Persona 构建（Cooper 法）

> 一句话：把定性研究产出，通过聚类与角色化，固化为可在产品决策中反复调用的标准化人物角色卡片（Persona）。
> 落点：`methods/toolbox/analysis/`。判据——这是一套可脱离具体项目复用的角色构建技术；概念辨析（Persona vs Profile / 画像分层分群）见 [`models/user-personas-segmentation.md`](../../../models/user-personas-segmentation.md)。

## 何时用

- 把访谈 / 行为数据沉淀成团队可共享的"典型用户"——让产品决策"为一个具体的人设计，而不是为脑中虚构的东西设计"。
- 需要在团队内建立对目标用户的统一认知时。
- **与 Profile（定量画像）区分**：Persona 用于**设计决策**（定性、3 个以内典型角色）；Profile 用于**运营圈人**（定量、全量用户）。见 [`models/user-personas-segmentation.md`](../../../models/user-personas-segmentation.md)。

## 输入数据要求

- 定性访谈记录（主）+ 行为数据 / 现有用户研究（辅）。
- ⚠️ 待补充(缺源)：原文未给最小样本量；通识上 5–8 个深访即可显现可聚类的模式。

## 分析步骤

### PERSONA 七大核心要素（Cooper）

> Cooper 提出，一个好的 Persona 需通过以下维度评估其质量。

⚠️ 待补充(缺源)：原文提到"PERSONA 原则 / 七大核心要素"，但七要素的具体名称在导出正文中缺失。

🤖 草稿待审(AI生成)：Cooper《About Face》体系中常见的七要素为 **Primary（首要的）/ Empathy（共情）/ Realistic（真实）/ Singular（唯一）/ Objectives（目标）/ Number（数量限制）/ Applicable（可应用）**——需 owner 用 Cooper 原著核验后替换。

### Persona 构建五步流程

| Step | 动作 | 说明 |
|---|---|---|
| 1 | **数据收集** | 定性访谈 + 行为数据 + 现有用户研究 |
| 2 | **发现模式（聚类）** | 在数据中找重复出现的用户类型 |
| 3 | **构建虚拟角色** | 给每个聚类一张完整人物卡片：姓名 / 照片 / 背景 / 目标 / 痛点 / 典型场景 |
| 4 | **验证迭代** | 与团队 / 真实用户校准 |
| 5 | **应用与传播** | 在产品决策时反复回到这些 Persona |

⚠️ 待补充(缺源)：每一步的具体执行细节原文未给。

## 结果解读

- 输出长什么样：2–3 张人物角色卡片，每张含姓名/照片/背景/目标/痛点/典型场景。
- 怎么用：每次产品决策时问"**我们的 Persona A 会遇到这个问题吗？**"——这是 Persona 的核心价值。
- 数量控制：**3 个以内**典型角色——过多等于没有重点。

## 局限与误用

- **把自己当用户** —— Persona 正是为对抗这一点而生（见 [`models/user-personas-segmentation.md`](../../../models/user-personas-segmentation.md) 六大误区）。
- **画像一劳永逸** —— Persona 需随产品阶段更新，不能建完束之高阁。
- **只堆人口属性** —— 缺行为特征和动机的 Persona 不真实、无法共情。
- 🤖 草稿待审(AI生成)：以上误用与 `user-personas-segmentation.md` 的六大误区一致，此处为 Persona 构建视角的提醒。

## 关联

- 理论根源（model）：
  - [`models/user-personas-segmentation.md`](../../../models/user-personas-segmentation.md) — Persona vs Profile / 画像分层分群辨析
- 常配合的采集方法：
  - [`methods/toolbox/collection/interviews.md`](../collection/interviews.md) — Persona 的主要数据来源
- 互补/可对比的分析技术：
  - [`methods/toolbox/analysis/rfm.md`](rfm.md) — RFM 是定量分群，与定性 Persona 互补

## 来源与参考

- 原始资料：[Joyspace - 用户画像细分思路](https://joyspace.jd.com/pages/TClOpOCmJKuZwZ9sDWUA)（李笑欣）§ Persona 构建
- 外部参考：Alan Cooper《About Face: 交互设计精髓》。
