---
id: user-material-synthesis
type: scenario-guide
title: 已有用户资料归纳
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/user-material-synthesis.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/02-understand-users-懂用户/01-user-material-synthesis-已有用户资料归纳.md
hub_source_hash: sha256:014d084680664f371ca13cd25bfb41b31b147170d94ab4d1f16a952e5988f599
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:9c050180133901729daf4ee322c7b7213744457a94327f95c507247fb45c8225
summary: 把访谈、问卷、反馈、研究报告等已有用户资料归纳成可用于设计判断的主题和证据。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: understand-users
definition: 把访谈、问卷、反馈、研究报告等已有用户资料归纳成可用于设计判断的主题和证据。
trigger_examples:
  - 帮我整理这些用户资料
  - 这些访谈说明了什么？
  - 已有研究能支持什么判断
required_inputs:
  - 用户资料
  - 项目问题
  - 资料来源
optional_inputs:
  - 截图
  - 客服反馈
  - 问卷数据
  - 历史报告
outputs:
  - 资料摘要
  - 主题归纳
  - 证据强弱
  - 待补信息
completion_criteria:
  - 不混淆原声与判断
  - 保留来源
  - 标注证据成熟度
default_skills:
  - id: ur-skill-synthesize-qualitative-insights
    status: draft
optional_skills:
  - id: ur-skill-code-open-feedback
    status: draft
  - id: ds-skill-user-insight-synthesis
    status: draft
knowledge_requirements:
  - 用户研究知识：定性归纳、文本分析
  - 当前项目资料
  - 场域知识包：洞察知识（按需）
dependencies: []
fallback:
  - 材料分散时先建立证据目录和主题草稿。
human_confirmation:
  - 样本代表性不足
  - 资料权限或来源不清
candidate_profiles:
  - speed
  - depth
  - focused
---

# 已有用户资料归纳

## 场景定义

把访谈、问卷、反馈、研究报告等已有用户资料归纳成可用于设计判断的主题和证据。

## 适用情况

- 帮我整理这些用户资料
- 这些访谈说明了什么？
- 已有研究能支持什么判断

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 用户资料
- 项目问题
- 资料来源

## 信息不足时如何处理

材料分散时先建立证据目录和主题草稿。

## 标准输出结构

- 资料摘要
- 主题归纳
- 证据强弱
- 待补信息

## 完成标准

- 不混淆原声与判断
- 保留来源
- 标注证据成熟度

## 默认 Skill

- `ur-skill-synthesize-qualitative-insights`（draft）

## 按需 Skill

- `ur-skill-code-open-feedback`（draft）
- `ds-skill-user-insight-synthesis`（draft）

## 默认知识调用范围

- 用户研究知识：定性归纳、文本分析
- 当前项目资料
- 场域知识包：洞察知识（按需）

## 前置和后续任务

- 前置 Scenario：无强制前置，可直接进入。
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 样本代表性不足
- 资料权限或来源不清

## 设计业务示例

例如把商详访谈和客服反馈归纳成价格理解、规格选择、履约预期三类主题。
