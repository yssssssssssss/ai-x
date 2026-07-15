---
id: toolbox_analysis_survey_statistics
type: analysis
title: 问卷数据统计分析（差异性与关联性）
domain:
  - 通用
tags:
  - quantitative
  - method
guide_stage:
  - method-selection
summary: ""
source: xingyun_wiki
source_path: methods/toolbox/analysis/survey-statistics.md
content_hash: sha256:23ef4ef4eb60b4c5d3ea54bde237a2be2e06d856136fd9f1ef2202155db5095f
status: draft
updated_at: 2026-07-15
---

# 问卷数据统计分析（差异性与关联性）

> 一句话：把问卷/量表收集的定量数据，通过差异性检验（不同群体是否不同）和关联性分析（变量是否相关）得出有统计支撑的结论。
> 落点：`methods/toolbox/analysis/`。判据——这套统计手段能脱离任一具体研究主题被单独复用（任何定量数据集都可能用到）。
> 边界：本文讲**怎么算**；问卷怎么设计见 [`methods/toolbox/collection/surveys.md`](../collection/surveys.md)。

## 何时用

### 三种常见分析目的

⚠️ 待补充(缺源)：原文"三种常见分析目的"完整表述缺失。从下文推断为 **描述性 / 差异性 / 关联性** 三类。

本文聚焦后两类：**差异性分析**和**关联性分析**。

## 输入数据要求

- 问卷/量表的结构化定量数据。
- 需要明确每个变量的数据类型（分类变量 / 连续变量）——决定选哪种统计方法。

## 分析步骤

### 1. 差异性分析：不同群体之间是否有差异

| 场景 | 统计方法 |
|---|---|
| **两个群体的差异检验** | ⚠️ 待补充(缺源)（通识：T 检验 / 卡方检验） |
| **多个群体的差异检验** | ⚠️ 待补充(缺源)（通识：方差分析 ANOVA） |

**SPSS 操作步骤（以 T 检验为例）**：⚠️ 待补充(缺源)：具体步骤缺失。

**结论写法示例**（原文可读）：

> t=-2.871，P<0.05
> → 不同性别的大学生在移动互联网感知有用性上存在显著差异，女生得分显著高于男生。

### 2. 关联性分析：变量之间是否相关

| 场景 | 统计方法 |
|---|---|
| **双变量关联分析**（按数据类型选择） | ⚠️ 待补充(缺源)（通识：Pearson 相关 / Spearman 相关 / 卡方） |
| **多变量关联分析** | ⚠️ 待补充(缺源)（通识：多元回归 / 因子分析） |

**关联分析结论写法示例（Pearson 相关）**（原文可读）：

> 将五项认知因素与移动互联网使用意愿进行 Pearson 相关分析：
> - 感知娱乐性与行为意向相关性最高（r=0.566**）
> - 感知有用性次之（r=0.564**）
> - 感知成本相关性最低（r=0.274**）
>
> （** 表示在 0.01 显著水平上双尾显著相关）

## 结果解读

- **看显著性（P 值）**：P<0.05 才说"存在显著差异/相关"，否则不能下结论。
- **看效应量/相关系数（r）**：显著 ≠ 强相关——r 的绝对值大小才说明关系强弱。
- **方向**：相关系数正负代表正相关/负相关。
- 结论写法套路：`统计量 + 显著性 + 业务化解读`（见上方两个示例）。

## 可视化 / 出图

- 差异性：分组柱状图 + 误差棒。
- 关联性：散点图、相关系数热力图。
- ⚠️ 待补充(缺源)：原文未给具体模板。

## 工具 / 实现

- **SPSS**（原文以 SPSS 为例）。
- 其他：R、Python（pandas/scipy/statsmodels）、Jamovi。

## 局限与误用

- **相关 ≠ 因果** —— Pearson 相关高不代表一个变量导致另一个。
- **显著 ≠ 重要** —— 大样本下微小差异也可能显著，要看效应量。
- **数据类型选错方法** —— 分类变量用了连续变量的检验会得出错误结论。
- **多重比较问题** —— 一次跑很多检验会抬高假阳性率。
- ⚠️ 待补充(缺源)：原文未集中给出局限清单。

## 关联

- 理论根源：统计学方法（非本库 model）。
- 常配合的采集方法：
  - [`methods/toolbox/collection/surveys.md`](../collection/surveys.md) — 主要数据来源
  - [`methods/toolbox/collection/usage-attitude-research.md`](../collection/usage-attitude-research.md)
- 互补/可对比的分析技术：
  - [`methods/toolbox/analysis/rfm.md`](rfm.md)、[`maxdiff.md`](maxdiff.md)
  - `methods/toolbox/analysis/factor-analysis.md`（因子分析）（待建）

## 来源与参考

- 原始资料：[Joyspace - 如何进行高质量的问卷调研](https://joyspace.jd.com/pages/SP0hvf8TkwZNWwN1LjeI) §五（李笑欣整理）——差异性与关联性分析部分。
- ⚠️ 具体统计方法的选择表在原文中是图/表，导出正文缺失，建议 PR 时对照原文补全。
