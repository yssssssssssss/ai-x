---
id: priority-roadmap
type: scenario-guide
title: 优先级与实施路径
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/priority-roadmap.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/05-define-strategy-定策略/02-priority-roadmap-优先级与实施路径.md
hub_source_hash: sha256:5d39f9e3d0d7293ae941e33b8f33bb2cefd61fe558689e27bd7ecbc9f61b3bbe
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:7a3d10485cc5aed0e527fc3cec96157edf08989cfac087d795dd3a3b824e1889
summary: 根据用户影响、业务影响、实现成本、上线窗口和风险，形成优先级与实施路径。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: define-strategy
definition: 根据用户影响、业务影响、实现成本、上线窗口和风险，形成优先级与实施路径。
trigger_examples:
  - 优先做什么？
  - 怎么排期？
  - 哪些先做哪些后做？
required_inputs:
  - 候选策略或方案
  - 评估维度
  - 资源约束
optional_inputs:
  - 数据规模
  - 研发成本
  - 业务窗口
  - 风险等级
outputs:
  - 优先级分层
  - 实施路径
  - 依赖关系
  - 后续计划
completion_criteria:
  - 优先级有标准
  - 区分必须/应该/可后置
  - 说明依赖和风险
default_skills:
  - id: ur-skill-issue-prioritization
    status: draft
optional_skills:
  - id: ds-skill-strategy-map-generation
    status: draft
  - id: ur-skill-build-experience-metrics
    status: draft
knowledge_requirements:
  - 设计策略方法：优先路线
  - 用户研究知识：优先级框架
  - 当前项目资料
  - 场域知识包：约束条件
dependencies:
  - strategy-synthesis
  - solution-comparison
fallback:
  - 缺少成本或窗口时输出条件化路线图。
human_confirmation:
  - 排期需要业务/研发确认
  - 资源投入超出设计可决策范围
candidate_profiles:
  - speed
  - depth
  - decision
  - focused
---

# 优先级与实施路径

## 场景定义

根据用户影响、业务影响、实现成本、上线窗口和风险，形成优先级与实施路径。

## 适用情况

- 优先做什么？
- 怎么排期？
- 哪些先做哪些后做？

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 候选策略或方案
- 评估维度
- 资源约束

## 信息不足时如何处理

缺少成本或窗口时输出条件化路线图。

## 标准输出结构

- 优先级分层
- 实施路径
- 依赖关系
- 后续计划

## 完成标准

- 优先级有标准
- 区分必须/应该/可后置
- 说明依赖和风险

## 默认 Skill

- `ur-skill-issue-prioritization`（draft）

## 按需 Skill

- `ds-skill-strategy-map-generation`（draft）
- `ur-skill-build-experience-metrics`（draft）

## 默认知识调用范围

- 设计策略方法：优先路线
- 用户研究知识：优先级框架
- 当前项目资料
- 场域知识包：约束条件

## 前置和后续任务

- 前置 Scenario：strategy-synthesis, solution-comparison
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 排期需要业务/研发确认
- 资源投入超出设计可决策范围

## 设计业务示例

例如把商详首屏优化拆成主链路必须做、规则解释应该做、增强能力后置。
