---
id: solution-generation
type: scenario-guide
title: 解决方案生成
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/solution-generation.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/04-solve-problems-解问题/02-solution-generation-解决方案生成.md
hub_source_hash: sha256:008fe0c13431aca9d757886fcfd2447f2cc52b2addb21ab3ccc923365e366256
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:eed9dda3598a1aad26413bfb7e7a69bff66e66bf31c532b3a4315aa957579f0e
summary: 基于根因和约束生成可落到触点、流程、文案、状态或规则的解决方向。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: solve-problems
definition: 基于根因和约束生成可落到触点、流程、文案、状态或规则的解决方向。
trigger_examples:
  - 有哪些解法？
  - 这个问题怎么改？
  - 帮我生成几个方案
required_inputs:
  - 问题根因
  - 目标与约束
  - 可改范围
optional_inputs:
  - 竞品模式
  - 组件规范
  - 技术限制
  - 运营规则
outputs:
  - 解决方向
  - 设计动作
  - 适用条件
  - 依赖与风险
completion_criteria:
  - 方案对应根因
  - 动作具体到触点或规则
  - 不输出空泛建议
default_skills:
  - id: ds-skill-strategy-map-generation
    status: draft
optional_skills:
  - id: ds-skill-competitor-strategy-analysis
    status: draft
  - id: ds-skill-solution-generation
    status: draft
knowledge_requirements:
  - 设计策略方法：策略地图
  - 场域知识包：经验知识
  - 当前项目资料
dependencies:
  - root-cause-analysis
fallback:
  - 可改范围不清时按低/中/高成本给方向草案。
human_confirmation:
  - 方案涉及规则变更
  - 方案依赖研发能力
  - 需要确认品牌或合规边界
candidate_profiles:
  - speed
  - depth
  - breadth
---

# 解决方案生成

## 场景定义

基于根因和约束生成可落到触点、流程、文案、状态或规则的解决方向。

## 适用情况

- 有哪些解法？
- 这个问题怎么改？
- 帮我生成几个方案

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 问题根因
- 目标与约束
- 可改范围

## 信息不足时如何处理

可改范围不清时按低/中/高成本给方向草案。

## 标准输出结构

- 解决方向
- 设计动作
- 适用条件
- 依赖与风险

## 完成标准

- 方案对应根因
- 动作具体到触点或规则
- 不输出空泛建议

## 默认 Skill

- `ds-skill-strategy-map-generation`（draft）

## 按需 Skill

- `ds-skill-competitor-strategy-analysis`（draft）
- `ds-skill-solution-generation`（draft）

## 默认知识调用范围

- 设计策略方法：策略地图
- 场域知识包：经验知识
- 当前项目资料

## 前置和后续任务

- 前置 Scenario：root-cause-analysis
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 方案涉及规则变更
- 方案依赖研发能力
- 需要确认品牌或合规边界

## 设计业务示例

例如针对商详预约规则复杂，生成主触点表达、二级说明、状态合并等方案方向。
