---
id: data-behavior-diagnosis
type: scenario-guide
title: 数据与行为异常诊断
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/data-behavior-diagnosis.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/03-find-problems-找问题/03-data-behavior-diagnosis-数据与行为异常诊断.md
hub_source_hash: sha256:5c1facdbb73015d8154030fe26fd69b5115e7ab6014c079ab0b27a975b6dae4c
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:7462455cdfba27b663fed5b046df3f31079e90aaa5f0f5ef6dd6f314d4d140cf
summary: 根据转化、点击、停留、流失、功能采纳等数据异常，判断可能发生问题的阶段和触点。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: find-problems
definition: 根据转化、点击、停留、流失、功能采纳等数据异常，判断可能发生问题的阶段和触点。
trigger_examples:
  - 数据掉了可能是什么问题？
  - 这个按钮点击低说明什么？
  - 转化异常帮我诊断一下
required_inputs:
  - 指标口径
  - 异常现象
  - 时间范围
  - 业务动作
optional_inputs:
  - 漏斗数据
  - 点击热区
  - 用户反馈
  - 版本变化
outputs:
  - 异常描述
  - 可能触点
  - 原因假设
  - 验证建议
completion_criteria:
  - 口径清楚
  - 不把相关当因果
  - 给出验证路径
default_skills:
  - id: ur-skill-conversion-funnel-analysis
    status: draft
optional_skills:
  - id: ur-skill-feature-adoption-analysis
    status: draft
  - id: ur-skill-build-experience-metrics
    status: draft
  - id: ur-skill-analyze-satisfaction
    status: draft
knowledge_requirements:
  - 用户研究知识：转化漏斗/行为数据/体验度量
  - 场域知识包：指标口径
  - 当前项目资料
dependencies: []
fallback:
  - 缺数据明细时输出可疑环节和需要补充的指标。
human_confirmation:
  - 指标口径不一致
  - 是否存在活动/版本干扰
  - 是否能访问真实数据
candidate_profiles:
  - speed
  - depth
  - focused
  - mixed_method
  - decision
  - remediation
---

# 数据与行为异常诊断

## 场景定义

根据转化、点击、停留、流失、功能采纳等数据异常，判断可能发生问题的阶段和触点。

## 适用情况

- 数据掉了可能是什么问题？
- 这个按钮点击低说明什么？
- 转化异常帮我诊断一下

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 指标口径
- 异常现象
- 时间范围
- 业务动作

## 信息不足时如何处理

缺数据明细时输出可疑环节和需要补充的指标。

## 标准输出结构

- 异常描述
- 可能触点
- 原因假设
- 验证建议

## 完成标准

- 口径清楚
- 不把相关当因果
- 给出验证路径

## 默认 Skill

- `ur-skill-conversion-funnel-analysis`（draft）

## 按需 Skill

- `ur-skill-feature-adoption-analysis`（draft）
- `ur-skill-build-experience-metrics`（draft）
- `ur-skill-analyze-satisfaction`（draft）

## 默认知识调用范围

- 用户研究知识：转化漏斗/行为数据/体验度量
- 场域知识包：指标口径
- 当前项目资料

## 前置和后续任务

- 前置 Scenario：无强制前置，可直接进入。
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 指标口径不一致
- 是否存在活动/版本干扰
- 是否能访问真实数据

## 设计业务示例

例如商详加购率下降，需要判断是规格选择、价格感知还是按钮状态造成。
