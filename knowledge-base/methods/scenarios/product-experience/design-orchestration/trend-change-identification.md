---
id: trend-change-identification
type: scenario-guide
title: 趋势与变化识别
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/trend-change-identification.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/01-find-direction-找方向/01-trend-change-identification-趋势与变化识别.md
hub_source_hash: sha256:4a8ba893144e3b46a7d9be3bf9d351fdbe15a0261d00eb1b2f970da480f4a5c1
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:c622b1d40f35c90bd31aff4cadcf37c6441d9f8cc6d1decfda65507bd5ce61d2
summary: 识别市场、用户、业务、技术或体验模式中的变化信号，形成方向探索的输入。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: find-direction
definition: 识别市场、用户、业务、技术或体验模式中的变化信号，形成方向探索的输入。
trigger_examples:
  - 最近有什么变化值得关注？
  - 这个赛道趋势是什么？
  - 帮我找设计方向的变化信号
required_inputs:
  - 业务背景
  - 目标用户或场景
  - 已有材料或观察线索
optional_inputs:
  - 行业资料
  - 竞品变化
  - 数据趋势
  - 内部业务变化
outputs:
  - 变化信号摘要
  - 趋势判断
  - 影响对象
  - 机会假设
  - 待验证问题
completion_criteria:
  - 信号有来源
  - 区分事实与假设
  - 指出需要继续验证的方向
default_skills:
  - id: ds-skill-trend-change-scan
    status: draft
optional_skills:
  - id: ds-skill-competitor-strategy-analysis
    status: draft
  - id: ds-skill-user-insight-synthesis
    status: draft
knowledge_requirements:
  - ux-method-experience-diagnosis-framework
  - 当前项目资料
  - 场域知识包：基础知识（按需）
dependencies: []
fallback:
  - 材料不足时输出信号清单和待补资料，不判断确定趋势。
human_confirmation:
  - 趋势来源不明
  - 涉及业务战略取舍
  - 需要确认是否纳入项目范围
candidate_profiles:
  - speed
  - depth
  - breadth
---

# 趋势与变化识别

## 场景定义

识别市场、用户、业务、技术或体验模式中的变化信号，形成方向探索的输入。

## 适用情况

- 最近有什么变化值得关注？
- 这个赛道趋势是什么？
- 帮我找设计方向的变化信号

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 业务背景
- 目标用户或场景
- 已有材料或观察线索

## 信息不足时如何处理

材料不足时输出信号清单和待补资料，不判断确定趋势。

## 标准输出结构

- 变化信号摘要
- 趋势判断
- 影响对象
- 机会假设
- 待验证问题

## 完成标准

- 信号有来源
- 区分事实与假设
- 指出需要继续验证的方向

## 默认 Skill

- `ds-skill-trend-change-scan`（draft）

## 按需 Skill

- `ds-skill-competitor-strategy-analysis`（draft）
- `ds-skill-user-insight-synthesis`（draft）

## 默认知识调用范围

- ux-method-experience-diagnosis-framework
- 当前项目资料
- 场域知识包：基础知识（按需）

## 前置和后续任务

- 前置 Scenario：无强制前置，可直接进入。
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 趋势来源不明
- 涉及业务战略取舍
- 需要确认是否纳入项目范围

## 设计业务示例

例如商详团队发现预约、预售、补贴玩法增多，需要识别这些变化是否会影响首屏信息表达。
