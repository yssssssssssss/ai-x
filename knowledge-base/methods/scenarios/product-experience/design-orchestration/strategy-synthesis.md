---
id: strategy-synthesis
type: scenario-guide
title: 结论整合与策略提炼
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/strategy-synthesis.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/05-define-strategy-定策略/01-strategy-synthesis-结论整合与策略提炼.md
hub_source_hash: sha256:ee7dde7f1a4c2c63589cf0daf13311f13b8874af2f50139de6ab3aa7f9f9afbc
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:e21576221e78de56c34a8a4de1f85f6601538f759d40eeeb399528469a86adee
summary: 整合用户、竞品、业务、数据和方案判断，提炼可评审的设计策略。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: define-strategy
definition: 整合用户、竞品、业务、数据和方案判断，提炼可评审的设计策略。
trigger_examples:
  - 帮我整理成策略
  - 这些结论怎么讲？
  - 评审页策略怎么写
required_inputs:
  - 关键结论
  - 证据材料
  - 目标与边界
optional_inputs:
  - 方案草稿
  - 竞品启发
  - 数据指标
  - 业务规则
outputs:
  - 策略摘要
  - 问题归因
  - 策略方向
  - 设计动作与价值
completion_criteria:
  - 结论有证据
  - 策略从问题推导
  - 能落到触点或规则
default_skills:
  - id: ds-skill-strategy-map-generation
    status: draft
optional_skills:
  - id: ds-skill-user-insight-synthesis
    status: draft
  - id: ds-skill-competitor-strategy-analysis
    status: draft
knowledge_requirements:
  - ds-method-strategy-00-module-overview
  - ds-method-strategy-02-strategy-map
  - ds-method-strategy-04-priority-and-roadmap
  - ds-method-strategy-05-review-and-validation
  - ur-method-models-pyramid-principle
  - 当前项目资料
  - 场域知识包：洞察与经验知识（按需）
dependencies:
  - root-cause-analysis
  - solution-comparison
fallback:
  - 结论碎片化时先输出证据矩阵和待补缺口。
human_confirmation:
  - 策略是否代表团队共识
  - 高风险取舍是否需要评审确认
candidate_profiles:
  - speed
  - depth
  - decision
---

# 结论整合与策略提炼

## 场景定义

整合用户、竞品、业务、数据和方案判断，提炼可评审的设计策略。

## 适用情况

- 帮我整理成策略
- 这些结论怎么讲？
- 评审页策略怎么写

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 关键结论
- 证据材料
- 目标与边界

## 信息不足时如何处理

结论碎片化时先输出证据矩阵和待补缺口。

## 标准输出结构

- 策略摘要
- 问题归因
- 策略方向
- 设计动作与价值

## 完成标准

- 结论有证据
- 策略从问题推导
- 能落到触点或规则

## 默认 Skill

- `ds-skill-strategy-map-generation`（draft）

## 按需 Skill

- `ds-skill-user-insight-synthesis`（draft）
- `ds-skill-competitor-strategy-analysis`（draft）

## 默认知识调用范围

- ds-method-strategy-00-module-overview
- ds-method-strategy-02-strategy-map
- ds-method-strategy-04-priority-and-roadmap
- ds-method-strategy-05-review-and-validation
- ur-method-models-pyramid-principle
- 当前项目资料
- 场域知识包：洞察与经验知识（按需）

## 前置和后续任务

- 前置 Scenario：root-cause-analysis, solution-comparison
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 策略是否代表团队共识
- 高风险取舍是否需要评审确认

## 设计业务示例

例如把商详首屏问题归因为认知混乱、感知复杂、路径受阻，并提炼策略层。
