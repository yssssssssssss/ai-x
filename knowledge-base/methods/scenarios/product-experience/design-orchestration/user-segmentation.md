---
id: user-segmentation
type: scenario-guide
title: 用户分层与重点人群识别
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/user-segmentation.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/02-understand-users-懂用户/02-user-segmentation-用户分层与重点人群识别.md
hub_source_hash: sha256:0950e81b5bef7359acd06f3a3297d6835a5ccd2cbe94ca836c05984f0f605f5e
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:52652cc0421650ccc44a6dc050169a9c9eb206b67d22ae87c16a3f2f836fc8a3
summary: 根据行为、价值、任务、心智或风险差异识别用户分层和当前应优先关注的人群。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: understand-users
definition: 根据行为、价值、任务、心智或风险差异识别用户分层和当前应优先关注的人群。
trigger_examples:
  - 用户可以分成几类？
  - 我们重点看哪类用户？
  - 哪些人群最受影响？
required_inputs:
  - 用户资料
  - 业务目标
  - 分层依据
optional_inputs:
  - 行为数据
  - 购买阶段
  - 人群标签
  - 访谈样本
outputs:
  - 用户分层
  - 重点人群
  - 人群差异
  - 设计关注点
completion_criteria:
  - 分层维度明确
  - 重点人群选择有理由
  - 不把标签当洞察
default_skills:
  - id: ur-skill-generate-persona
    status: draft
optional_skills:
  - id: ds-skill-user-insight-synthesis
    status: draft
  - id: planned-segmentation-analysis-skill
    status: planned
knowledge_requirements:
  - 用户研究知识：用户画像/分层/分群
  - 设计策略方法：用户分析
  - 当前项目资料
dependencies:
  - user-material-synthesis
fallback:
  - 资料不足时输出可能分层维度和需要补充的数据。
human_confirmation:
  - 涉及商业目标取舍
  - 分层口径影响后续策略
candidate_profiles:
  - speed
  - depth
  - focused
  - breadth
  - mixed_method
---

# 用户分层与重点人群识别

## 场景定义

根据行为、价值、任务、心智或风险差异识别用户分层和当前应优先关注的人群。

## 适用情况

- 用户可以分成几类？
- 我们重点看哪类用户？
- 哪些人群最受影响？

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 用户资料
- 业务目标
- 分层依据

## 信息不足时如何处理

资料不足时输出可能分层维度和需要补充的数据。

## 标准输出结构

- 用户分层
- 重点人群
- 人群差异
- 设计关注点

## 完成标准

- 分层维度明确
- 重点人群选择有理由
- 不把标签当洞察

## 默认 Skill

- `ur-skill-generate-persona`（draft）

## 按需 Skill

- `ds-skill-user-insight-synthesis`（draft）
- `planned-segmentation-analysis-skill`（planned）

## 默认知识调用范围

- 用户研究知识：用户画像/分层/分群
- 设计策略方法：用户分析
- 当前项目资料

## 前置和后续任务

- 前置 Scenario：user-material-synthesis
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 涉及商业目标取舍
- 分层口径影响后续策略

## 设计业务示例

例如识别新客、价格敏感用户、强规则敏感用户在商详首屏中的信息需求差异。
