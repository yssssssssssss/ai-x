---
id: model_job_map
type: model
title: Job Map（任务地图，ODI 8 步框架）
domain:
  - 通用
tags:
  - framework
guide_stage:
  - need-discovery
summary: ""
source: xingyun_wiki
source_path: models/job-map.md
content_hash: sha256:68f44935ad90ad27744a1986c30318c5f17eda15016147400c97633d36789841
status: draft
updated_at: 2026-07-15
---

# Job Map（任务地图，ODI 8 步框架）

> 一句话：Ulwick ODI 体系下用于**结构化拆解任意"用户核心任务"**的 8 阶段通用框架——把抽象的 Job 还原成可被逐步深挖痛点和期待效果的流程图。
> 落点：`models/`。判据——Job Map 是 JTBD/ODI 体系的子模型，结构化看任意 Job 的方法学，是 [`methods/toolbox/collection/job-interview.md`](../methods/toolbox/collection/job-interview.md) 的依赖。
> 边界：模型本身在 models；用它做访谈见 job-interview.md。

## 核心概念

> 任意"用户要完成的核心任务"都可以被拆成 **8 个通用阶段**——按这 8 阶段提问/分析，能保证全流程不漏。

## 理论来源

- 提出者：**Anthony Ulwick**，*What Customers Want*（2005 年）。
- 配套方法论：ODI（Outcome-Driven Innovation）。
- 本条目整理自：[Joyspace - Job Interview访谈方法](https://joyspace.jd.com/pages/jC07iwubT6l2YBCoBXt4)（李笑欣）——原文中明确"Job Map 8 步框架"为 Job Interview 第 2/3/4 步的提问骨架，但**8 步具体名称在导出正文中缺失**。

## 关键构念 / 维度

⚠️ 待补充(缺源)：**Job Map 8 个阶段的具体名称**在原文导出正文中缺失（仅在文字中多次引用"Job Map 8 步框架"，但未列出 8 步本身）。需 owner 用 Ulwick 原始材料补。

🤖 草稿待审(AI生成)：根据 Ulwick *What Customers Want* / *Jobs to Be Done* 公开论述，**Job Map 通用 8 阶段**为（**待 owner 用原始资料核验**）：

1. **Define（定义）** —— 用户搞清楚要做什么、需要什么资源
2. **Locate（定位）** —— 收集需要的输入 / 找到要用的物料
3. **Prepare（准备）** —— 安排好开始任务前的环境/工具
4. **Confirm（确认）** —— 确认所有准备就绪、可以开始
5. **Execute（执行）** —— 真正完成任务的核心动作
6. **Monitor（监测）** —— 监控进度、随时调整
7. **Modify（修正）** —— 根据情况修正动作或参数
8. **Conclude（收尾）** —— 完成任务、清理收尾

> ⚠️ 上述 8 步源自外部 ODI 通识资料，**不是原 Joyspace 原文内容**——保留供 PR 评审参考，请 owner 用 Ulwick 原始文献核验后替换或保留。

## 如何作为透镜使用

### 问题定义阶段

- 把研究问题翻译成"用户要完成的某个 Job"，再用 Job Map 8 阶段评估目前研究覆盖了哪几阶段。
- 在新品类/新场景探索时，Job Map 帮助避免"只看到执行（Execute）阶段，漏掉准备/监测/修正"。

### 采集阶段

- 直接作为 [Job Interview](../methods/toolbox/collection/job-interview.md) 的访谈骨架——按 8 阶段逐一提问。
- 每个阶段都问"你怎么做？哪一步耗时/麻烦/易出错？什么算做好？"。

### 分析 / 结论阶段

- 把痛点和期待效果**按阶段填回 Job Map**——形成可视化的"任务流程缺陷地图"。
- 高频痛点集中的阶段 = 创新机会点。

## 与方法 / 分析的衔接

- 概念落到可操作分析时看：
  - [`methods/toolbox/collection/job-interview.md`](../methods/toolbox/collection/job-interview.md) — 用 Job Map 提问
  - `methods/toolbox/analysis/opportunity-algorithm.md`（待建——ODI 把痛点+期待效果做"机会分"运算）
  - `methods/toolbox/analysis/journey-map.md`（待建——用户旅程图与 Job Map 是不同视角，旅程图偏体验、Job Map 偏任务结构）

## 局限与误用

- **8 步通用模型** —— 是脚手架不是绝对真理，对于极其简单或极其复杂的任务可能要灵活合并/拆分阶段。
- **不要把产品当成步骤** —— Job Map 是**用户视角的任务流**，不是**产品视角的功能流**——这是与流程图最大的区别。
- ⚠️ 待补充(缺源)：原文未给出局限清单。

## 关联

- related:
  - [`models/jtbd.md`](jtbd.md) — JTBD 的子模型
  - [`methods/toolbox/collection/job-interview.md`](../methods/toolbox/collection/job-interview.md)

## 来源与参考

- 原始资料：[Joyspace - Job Interview访谈方法](https://joyspace.jd.com/pages/jC07iwubT6l2YBCoBXt4)（李笑欣）
- 外部参考：Anthony Ulwick, *What Customers Want* (2005), *Jobs to Be Done: Theory to Practice*.
