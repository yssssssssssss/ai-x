---
id: scenario_iteration_evaluation_diagnosis
type: scenario-guide
title: 产品迭代期·效果评估与问题诊断打法
domain:
  - 产品体验
tags: []
guide_stage:
  - intent
  - goal-definition
summary: ""
source: xingyun_wiki
source_path: methods/scenarios/product-experience/iteration/iteration-evaluation-diagnosis.md
content_hash: sha256:99f46804825e27d609fdf6fcb80e4012696d4f06e11574d019602d0c36358d35
status: draft
updated_at: 2026-07-15
---

# 产品迭代期·效果评估与问题诊断打法

> 把迭代期常用的 toolbox 方法编排成「这个阶段该怎么打」的应用指南。**只按路径引用方法本体，绝不复制方法正文。**
> 落点：`methods/scenarios/product-experience/`（stage=迭代）。
> 说明：本篇是**编排篇**，把本系列各篇方法的「在产品迭代期的定位」与互链汇成一条主线；方法怎么做、公式与坑都在各自的 toolbox 文档里，这里只负责"用哪些、什么顺序、回答什么问题"。

## 场景定义 / 典型问题

新版本 / 新功能**上线后**，研究要回答四类问题，对应三个动作环节：

| 业务问题 | 本质要测 | 主用方法（按路径引用） | 环节 |
|---|---|---|---|
| 问题真被解决了吗？认知与预期对齐吗？ | 期望-感知落差、采纳 | `models/ect.md`、`methods/toolbox/analysis/feature-adoption.md` | 效果评估 |
| 体验到底变好还是变差、好/差多少？ | 体验量化、满意度 | `methods/toolbox/analysis/experience-metrics-heart.md`、`methods/toolbox/collection/satisfaction-survey.md`、`methods/toolbox/analysis/longitudinal-benchmark-tracking.md` | 效果评估 |
| 哪里出了问题、用户在哪流失/卡住？ | 流失环节、采纳断点 | `methods/toolbox/analysis/conversion-funnel.md`、`methods/toolbox/analysis/feature-adoption.md` | 诊断归因 |
| 为什么不满 / 为什么低分？ | 根因、驱动因子、原声 | `methods/toolbox/analysis/satisfaction-drop-attribution.md`、`methods/toolbox/analysis/key-driver-analysis.md`、`methods/toolbox/analysis/voc-analysis.md`、`methods/toolbox/collection/interviews.md` | 诊断归因 |
| 这么多问题先修哪个？ | 严重度×影响×成本 | `methods/toolbox/analysis/issue-prioritization.md` | 诊断归因·收口 |
| 这个改动到底有没有用、收益多大？ | 因果效应 | `methods/toolbox/analysis/ab-testing.md` | 效果验证 |

## 推荐打法（编排）

三个环节按需取用、可循环；研究节奏与在用追踪贯穿全程。

### A. 效果评估 —— "变好了吗 / 好了多少"

| 步骤 | 方法（引用路径） | 目的 / 产出 |
|---|---|---|
| A1 立项即设北极星与护栏、持续度量体验 | `methods/toolbox/analysis/experience-metrics-heart.md` | HEART/GSM 体验度量看板（核心+护栏指标） |
| A2 量满意度与各维度得分 | `methods/toolbox/collection/satisfaction-survey.md`（量表见 `assets/scales/standardized-ux-scales.md`） | 干净可比的满意度/NPS/各维度分 |
| A3 用 ECT 透镜逐价值点定位失望/惊喜 | `models/ect.md` | 失望点(P0)/惊喜点清单、满意度归因线索 |
| A4 跨版本看长期成效、剥离变化厌恶 | `methods/toolbox/analysis/longitudinal-benchmark-tracking.md` | 跨版本趋势线、体验量化收益/回归结论 |

### B. 诊断归因 —— "哪里 / 为什么"

| 步骤 | 方法（引用路径） | 目的 / 产出 |
|---|---|---|
| B1 定位转化路径上的流失环节 | `methods/toolbox/analysis/conversion-funnel.md` | 最大流失环节 + 分群异常段 |
| B2 拆新功能"知晓→试用→持续用"链路 | `methods/toolbox/analysis/feature-adoption.md` | 采纳漏斗各段流失诊断 |
| B3 满意度/NSS 掉了——异动归因 | `methods/toolbox/analysis/satisfaction-drop-attribution.md` | 显著性判断 + 谁在哪里为什么不满 |
| B4 找最撬动满意度的关键属性 | `methods/toolbox/analysis/key-driver-analysis.md` | 派生重要性 × 表现的优先级矩阵 |
| B5 用户原声主题/情感 | `methods/toolbox/analysis/voc-analysis.md` | 高频高负面问题清单 + 代表原声 |
| B6 定性补"为什么" | `methods/toolbox/collection/interviews.md`  | 可解释的归因证据 |
| B7 **收口**：问题分层定优先级 | `methods/toolbox/analysis/issue-prioritization.md` | P0–P3 + RICE/ICE 的修复待办 |

### C. 效果验证 —— "改动到底有没有用"

| 步骤 | 方法（引用路径） | 目的 / 产出 |
|---|---|---|
| C1 高优先级改动上线前用随机对照实验验收益 | `methods/toolbox/analysis/ab-testing.md` | 因果效应 + 上线/回滚/迭代结论 |

### 贯穿全程：研究节奏与在用追踪

| 贯穿动作 | 方法（引用路径） | 作用 |
|---|---|---|
| 每周与用户对话、发现与交付并轨 | `methods/scenarios/product-experience/iteration/continuous-discovery.md` | 提供持续的一手输入与节奏（姊妹打法） |
| 真实在用情境的纵向追踪 + 迭代式研究设计 | `methods/toolbox/collection/in-product-longitudinal-tracking.md` | 上线前后对比、常规使用真相、qual↔quant 放大 |

## 套用的理论透镜

- `models/ect.md` —— 期望确认理论，效果评估环节的内核（满意 = 期望 vs 感知的确认/不确认）。
- `models/kano.md` ⚠️待补充(缺源) —— 基本型/期望型/兴奋型，配合驱动分析避免砍掉基本盘。
- `models/fogg-behavior-model.md` ⚠️待补充(缺源) —— B=MAP，把转化漏斗的流失根因结构化。

## 可复用素材

- `assets/scales/standardized-ux-scales.md` —— SUS/UMUX-Lite/SEQ/NPS/CSAT/CES 计分与基准。
- `assets/templates/opportunity-solution-tree.md` —— 机会-解决方案树，承接持续发现的结构化。

## 交付物

- 体验度量看板（北极星 + 护栏 + 跨版本趋势）。
- 满意度/落差报告、关键驱动因子与优先级矩阵。
- 诊断结论（哪个群体在哪个模块为什么）+ 分优先级的修复待办。
- A/B 验证结论（上线 / 回滚 / 继续迭代）。

## 参考报告（在报告库，不在本库）

- 关联的迭代研究报告见用研报告库（按权限可见，不在本方法库）。

## 来源与参考

- **本篇为编排打法（无单一原文）**：编排主线综合自本系列各方法文档的「在产品迭代期的定位」段与相互引用（源自 Joyspace 团队空间「产品迭代期用研方法论」系列）。各方法的操作细节、公式与外部文献，见其各自 toolbox / models 文档的「来源与参考」。
