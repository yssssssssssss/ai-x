---
id: user-journey-insight
type: scenario-guide
title: 用户旅程与需求洞察
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/user-journey-insight.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/02-understand-users-懂用户/03-user-journey-insight-用户旅程与需求洞察.md
hub_source_hash: sha256:23d7007234e9754f59e491c33112d9a9e773ba3277b62b41aae7a15e4aa53bbf
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:3ee3295c166361e5b87dd31cb6c6ce28790a542669d393ed4bcecf7e38da7259
summary: 按用户任务链路梳理触点、行为、信息需求、情绪变化和关键洞察。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: understand-users
definition: 按用户任务链路梳理触点、行为、信息需求、情绪变化和关键洞察。
trigger_examples:
  - 帮我画用户旅程
  - 用户在这个流程里怎么想？
  - 这个场景的核心需求是什么？
required_inputs:
  - 目标用户
  - 任务场景
  - 触点或流程
optional_inputs:
  - 访谈材料
  - 行为路径
  - 页面截图
  - 业务规则
outputs:
  - 用户旅程
  - 关键触点
  - 需求洞察
  - 卡点与机会
completion_criteria:
  - 旅程按任务展开
  - 洞察能追溯证据
  - 区分需求与业务诉求
default_skills:
  - id: ur-skill-journey-map
    status: draft
optional_skills:
  - id: ur-skill-jobs-to-be-done
    status: draft
  - id: ds-skill-user-insight-synthesis
    status: draft
knowledge_requirements:
  - ds-method-user-00-module-overview
  - ds-method-user-02-user-segmentation
  - ds-method-user-03-journey-and-tasks
  - ds-method-user-04-painpoint-diagnosis
  - ds-method-user-05-insight-output
  - ur-method-models-user-personas-segmentation
  - ur-method-models-user-insight
  - ur-method-methods-toolbox-analysis-journey-map
  - 场域知识包：用户旅程（按需）
dependencies:
  - user-material-synthesis
  - user-segmentation
fallback:
  - 无法确认真实路径时输出假设旅程并标待验证。
human_confirmation:
  - 关键用户任务不明确
  - 旅程阶段需要业务确认
candidate_profiles:
  - speed
  - depth
  - focused
  - mixed_method
---

# 用户旅程与需求洞察

## 场景定义

按用户任务链路梳理触点、行为、信息需求、情绪变化和关键洞察。

## 适用情况

- 帮我画用户旅程
- 用户在这个流程里怎么想？
- 这个场景的核心需求是什么？

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 目标用户
- 任务场景
- 触点或流程

## 信息不足时如何处理

无法确认真实路径时输出假设旅程并标待验证。

## 标准输出结构

- 用户旅程
- 关键触点
- 需求洞察
- 卡点与机会

## 完成标准

- 旅程按任务展开
- 洞察能追溯证据
- 区分需求与业务诉求

## 默认 Skill

- `ur-skill-journey-map`（draft）

## 按需 Skill

- `ur-skill-jobs-to-be-done`（draft）
- `ds-skill-user-insight-synthesis`（draft）

## 默认知识调用范围

- ds-method-user-00-module-overview
- ds-method-user-02-user-segmentation
- ds-method-user-03-journey-and-tasks
- ds-method-user-04-painpoint-diagnosis
- ds-method-user-05-insight-output
- ur-method-models-user-personas-segmentation
- ur-method-models-user-insight
- ur-method-methods-toolbox-analysis-journey-map
- 场域知识包：用户旅程（按需）

## 前置和后续任务

- 前置 Scenario：user-material-synthesis, user-segmentation
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 关键用户任务不明确
- 旅程阶段需要业务确认

## 设计业务示例

例如梳理用户从进入商详、理解商品、确认规格到下单的决策旅程。
