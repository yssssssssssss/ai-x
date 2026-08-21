---
id: feedback-issue-clustering
type: scenario-guide
title: 用户反馈问题聚类
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/feedback-issue-clustering.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/03-find-problems-找问题/02-feedback-issue-clustering-用户反馈问题聚类.md
hub_source_hash: sha256:de8c3e04e9e0fb2f535c729171704620e69fa53970fdec16ccc663e660b447f5
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:8f1ddf48c9fc0dc8bd1aaa0dbb3de67190de6b8037f53860d41a8694b3dfd23d
summary: 将用户原声、客服反馈、评价或开放题反馈聚类成问题主题，并评估影响范围。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: find-problems
definition: 将用户原声、客服反馈、评价或开放题反馈聚类成问题主题，并评估影响范围。
trigger_examples:
  - 这些反馈能归成几类？
  - 用户主要抱怨什么？
  - 帮我整理 VOC 问题
required_inputs:
  - 反馈文本
  - 来源与时间范围
  - 业务对象
optional_inputs:
  - 用户属性
  - 触点信息
  - 频次或样本量
outputs:
  - 问题主题
  - 代表原声
  - 频次/严重度
  - 后续验证建议
completion_criteria:
  - 保留原声来源
  - 主题互斥或有层级
  - 不把单条反馈放大成事实
default_skills:
  - id: ur-skill-code-open-feedback
    status: draft
optional_skills:
  - id: ur-skill-synthesize-qualitative-insights
    status: draft
  - id: ur-skill-issue-prioritization
    status: draft
knowledge_requirements:
  - 用户研究知识：VOC/文本分析/质性编码
  - 当前项目资料
  - 场域知识包：洞察知识（按需）
dependencies: []
fallback:
  - 样本少时输出初步主题，不做高频判断。
human_confirmation:
  - 反馈是否可外传
  - 敏感用户信息处理
  - 主题命名需要业务确认
candidate_profiles:
  - speed
  - depth
  - decision
---

# 用户反馈问题聚类

## 场景定义

将用户原声、客服反馈、评价或开放题反馈聚类成问题主题，并评估影响范围。

## 适用情况

- 这些反馈能归成几类？
- 用户主要抱怨什么？
- 帮我整理 VOC 问题

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 反馈文本
- 来源与时间范围
- 业务对象

## 信息不足时如何处理

样本少时输出初步主题，不做高频判断。

## 标准输出结构

- 问题主题
- 代表原声
- 频次/严重度
- 后续验证建议

## 完成标准

- 保留原声来源
- 主题互斥或有层级
- 不把单条反馈放大成事实

## 默认 Skill

- `ur-skill-code-open-feedback`（draft）

## 按需 Skill

- `ur-skill-synthesize-qualitative-insights`（draft）
- `ur-skill-issue-prioritization`（draft）

## 默认知识调用范围

- 用户研究知识：VOC/文本分析/质性编码
- 当前项目资料
- 场域知识包：洞察知识（按需）

## 前置和后续任务

- 前置 Scenario：无强制前置，可直接进入。
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 反馈是否可外传
- 敏感用户信息处理
- 主题命名需要业务确认

## 设计业务示例

例如把商详用户反馈聚成价格看不懂、优惠规则复杂、配送预期不清等问题。
