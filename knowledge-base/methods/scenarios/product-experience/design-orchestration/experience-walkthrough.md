---
id: experience-walkthrough
type: scenario-guide
title: 页面与链路体验走查
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/experience-walkthrough.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/03-find-problems-找问题/01-experience-walkthrough-页面与链路体验走查.md
hub_source_hash: sha256:bef132c56fb2c72e1f247064239a88c7b6202fde1d45ae2a505e7f3654ef9a61
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:1f47e1f671b88e0282a182062c72bba750ece27b3fd7f97dc9be12da4b4d82e7
summary: 基于页面、链路、状态和规则进行体验走查，识别可描述、可定位的问题。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: find-problems
definition: 基于页面、链路、状态和规则进行体验走查，识别可描述、可定位的问题。
trigger_examples:
  - 帮我走查这个页面
  - 这个链路哪里不顺？
  - 上线前帮我看体验问题
required_inputs:
  - 页面或流程材料
  - 目标任务
  - 用户场景
optional_inputs:
  - 设计稿
  - 截图
  - 交互说明
  - 业务规则
outputs:
  - 问题清单
  - 触点定位
  - 影响判断
  - 证据截图说明
completion_criteria:
  - 问题可定位
  - 问题表述不等同解决方案
  - 说明严重度或影响
default_skills:
  - id: ur-skill-run-heuristic-evaluation
    status: draft
optional_skills:
  - id: ur-skill-research-screenshot-analyzer
    status: draft
  - id: ur-skill-experience-walkthrough
    status: draft
knowledge_requirements:
  - 用户研究知识：启发式评估/可用性
  - 场域知识包：基础知识
  - 当前项目资料
dependencies: []
fallback:
  - 材料不完整时按已有页面走查，并列出无法判断的状态。
human_confirmation:
  - 规则是否真实上线
  - 严重问题是否需要设计/产品确认
candidate_profiles:
  - speed
  - depth
  - remediation
  - focused
  - breadth
---

# 页面与链路体验走查

## 场景定义

基于页面、链路、状态和规则进行体验走查，识别可描述、可定位的问题。

## 适用情况

- 帮我走查这个页面
- 这个链路哪里不顺？
- 上线前帮我看体验问题

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 页面或流程材料
- 目标任务
- 用户场景

## 信息不足时如何处理

材料不完整时按已有页面走查，并列出无法判断的状态。

## 标准输出结构

- 问题清单
- 触点定位
- 影响判断
- 证据截图说明

## 完成标准

- 问题可定位
- 问题表述不等同解决方案
- 说明严重度或影响

## 默认 Skill

- `ur-skill-run-heuristic-evaluation`（draft）

## 按需 Skill

- `ur-skill-research-screenshot-analyzer`（draft）
- `ur-skill-experience-walkthrough`（draft）

## 默认知识调用范围

- 用户研究知识：启发式评估/可用性
- 场域知识包：基础知识
- 当前项目资料

## 前置和后续任务

- 前置 Scenario：无强制前置，可直接进入。
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 规则是否真实上线
- 严重问题是否需要设计/产品确认

## 设计业务示例

例如走查商详首屏价格、标题、规格、履约、底部按钮的理解和操作问题。
