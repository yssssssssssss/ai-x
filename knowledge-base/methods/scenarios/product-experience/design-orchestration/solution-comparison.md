---
id: solution-comparison
type: scenario-guide
title: 方案比较与风险评估
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/solution-comparison.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/04-solve-problems-解问题/03-solution-comparison-方案比较与风险评估.md
hub_source_hash: sha256:538af477a6f805545d8a3703c7020c176e5528337be5225e0cba3619ba1ca6a0
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:acba7f64544d159bde16988d0a90406375181a2c5370c3615c5a876f87e9e857
summary: 比较多个方案在用户价值、业务价值、实现成本、风险和验证难度上的差异。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: solve-problems
definition: 比较多个方案在用户价值、业务价值、实现成本、风险和验证难度上的差异。
trigger_examples:
  - 两个方案哪个好？
  - 帮我评估方案风险
  - 这个方案有什么坑
required_inputs:
  - 候选方案
  - 评估维度
  - 业务约束
optional_inputs:
  - 用户证据
  - 数据预估
  - 研发成本
  - 竞品经验
outputs:
  - 方案对比表
  - 风险清单
  - 推荐取舍
  - 验证建议
completion_criteria:
  - 评估维度明确
  - 不只比较视觉偏好
  - 说明推荐理由和风险
default_skills:
  - id: ur-skill-issue-prioritization
    status: draft
optional_skills:
  - id: ds-skill-strategy-map-generation
    status: draft
  - id: ur-skill-build-experience-metrics
    status: draft
knowledge_requirements:
  - 设计策略方法：优先路线/评审验证
  - 用户研究知识：优先级框架
  - 场域知识包：约束条件
dependencies:
  - solution-generation
fallback:
  - 缺少成本或数据时输出待确认项和条件化建议。
human_confirmation:
  - 优先级需要业务拍板
  - 成本估算需要研发确认
  - 风险影响核心交易链路
candidate_profiles:
  - speed
  - depth
  - focused
---

# 方案比较与风险评估

## 场景定义

比较多个方案在用户价值、业务价值、实现成本、风险和验证难度上的差异。

## 适用情况

- 两个方案哪个好？
- 帮我评估方案风险
- 这个方案有什么坑

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 候选方案
- 评估维度
- 业务约束

## 信息不足时如何处理

缺少成本或数据时输出待确认项和条件化建议。

## 标准输出结构

- 方案对比表
- 风险清单
- 推荐取舍
- 验证建议

## 完成标准

- 评估维度明确
- 不只比较视觉偏好
- 说明推荐理由和风险

## 默认 Skill

- `ur-skill-issue-prioritization`（draft）

## 按需 Skill

- `ds-skill-strategy-map-generation`（draft）
- `ur-skill-build-experience-metrics`（draft）

## 默认知识调用范围

- 设计策略方法：优先路线/评审验证
- 用户研究知识：优先级框架
- 场域知识包：约束条件

## 前置和后续任务

- 前置 Scenario：solution-generation
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 优先级需要业务拍板
- 成本估算需要研发确认
- 风险影响核心交易链路

## 设计业务示例

例如比较“主触点直接展示规则”和“二级说明承接规则”的用户理解收益与维护成本。
