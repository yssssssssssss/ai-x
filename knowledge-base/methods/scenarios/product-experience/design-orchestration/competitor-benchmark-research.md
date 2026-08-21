---
id: competitor-benchmark-research
type: scenario-guide
title: 竞品与标杆研究
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/competitor-benchmark-research.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/01-find-direction-找方向/02-competitor-benchmark-research-竞品与标杆研究.md
hub_source_hash: sha256:531debd9853f262ab80a3c2b4b09fd657a14b8d4c6f8054115ceb855e685b4f5
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:c890458da3a7897b6c76faa8809a7ee98c4e36523a21fd137edd3c0e4e35cff8
summary: 围绕同类任务或体验问题选择竞品和标杆，抽取可借鉴模式与不可照搬条件。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: find-direction
definition: 围绕同类任务或体验问题选择竞品和标杆，抽取可借鉴模式与不可照搬条件。
trigger_examples:
  - 帮我看看竞品怎么做
  - 找几个标杆案例
  - 这个功能行业里有什么成熟做法
required_inputs:
  - 本品场景
  - 要比较的问题
  - 竞品或标杆范围
optional_inputs:
  - 竞品截图
  - 流程录屏
  - 规则说明
  - 用户任务
outputs:
  - 竞品选择逻辑
  - 模式对比
  - 标杆启发
  - 风险与限制
completion_criteria:
  - 竞品选择合理
  - 输出模式而非截图堆叠
  - 说明不可照搬条件
default_skills:
  - id: ds-skill-competitor-strategy-analysis
    status: draft
optional_skills:
  - id: ur-skill-competitive-analysis
    status: draft
knowledge_requirements:
  - ds-method-competitor-00-module-overview
  - ds-method-competitor-01-competitor-selection
  - ds-method-competitor-02-comparison-dimensions
  - ds-method-competitor-03-pattern-analysis
  - ds-method-competitor-04-opportunity-and-risk
  - ds-method-competitor-05-insight-output
  - ur-method-methods-toolbox-analysis-competitive-analysis
  - 场域知识包：经验知识（按需）
dependencies: []
fallback:
  - 竞品资料不足时先输出比较维度和采集清单。
human_confirmation:
  - 竞品是否可公开引用
  - 标杆做法是否符合本品规则
candidate_profiles:
  - speed
  - depth
  - breadth
  - decision
---

# 竞品与标杆研究

## 场景定义

围绕同类任务或体验问题选择竞品和标杆，抽取可借鉴模式与不可照搬条件。

## 适用情况

- 帮我看看竞品怎么做
- 找几个标杆案例
- 这个功能行业里有什么成熟做法

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 本品场景
- 要比较的问题
- 竞品或标杆范围

## 信息不足时如何处理

竞品资料不足时先输出比较维度和采集清单。

## 标准输出结构

- 竞品选择逻辑
- 模式对比
- 标杆启发
- 风险与限制

## 完成标准

- 竞品选择合理
- 输出模式而非截图堆叠
- 说明不可照搬条件

## 默认 Skill

- `ds-skill-competitor-strategy-analysis`（draft）

## 按需 Skill

- `ur-skill-competitive-analysis`（draft）

## 默认知识调用范围

- ds-method-competitor-00-module-overview
- ds-method-competitor-01-competitor-selection
- ds-method-competitor-02-comparison-dimensions
- ds-method-competitor-03-pattern-analysis
- ds-method-competitor-04-opportunity-and-risk
- ds-method-competitor-05-insight-output
- ur-method-methods-toolbox-analysis-competitive-analysis
- 场域知识包：经验知识（按需）

## 前置和后续任务

- 前置 Scenario：无强制前置，可直接进入。
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 竞品是否可公开引用
- 标杆做法是否符合本品规则

## 设计业务示例

例如对比不同电商商详页中预约预售阶段信息、按钮状态和规则说明位置。
