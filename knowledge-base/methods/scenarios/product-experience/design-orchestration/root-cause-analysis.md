---
id: root-cause-analysis
type: scenario-guide
title: 问题根因拆解
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/root-cause-analysis.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/04-solve-problems-解问题/01-root-cause-analysis-问题根因拆解.md
hub_source_hash: sha256:49954209aa22190d0bf61edf7b7cb824b1fb23780ba59e334b9583819eff332b
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:1f31261afdae4a069b6c0a7f8738e74a13b127b5d175fb8e88a0336810532857
summary: 将已识别问题拆解到心智、信息、链路、能力、规则或业务约束等根因层。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: solve-problems
definition: 将已识别问题拆解到心智、信息、链路、能力、规则或业务约束等根因层。
trigger_examples:
  - 这个问题根因是什么？
  - 为什么用户会卡住？
  - 帮我拆一下原因
required_inputs:
  - 问题清单
  - 证据材料
  - 业务规则
optional_inputs:
  - 用户旅程
  - 数据异常
  - 竞品参照
  - 历史案例
outputs:
  - 根因假设
  - 证据链
  - 影响机制
  - 待验证问题
completion_criteria:
  - 根因与现象分开
  - 每个根因有证据或待验证标记
  - 说明影响对象
default_skills:
  - id: ds-skill-user-insight-synthesis
    status: draft
optional_skills:
  - id: ds-skill-strategy-map-generation
    status: draft
  - id: ur-skill-jobs-to-be-done
    status: draft
knowledge_requirements:
  - 设计策略方法：问题定义/痛点诊断
  - 用户研究知识：用户需求/JTBD
  - 场域知识包：基础与洞察知识
dependencies:
  - experience-walkthrough
  - feedback-issue-clustering
  - data-behavior-diagnosis
fallback:
  - 证据不足时输出根因假设树并标注验证方式。
human_confirmation:
  - 根因涉及业务规则归属
  - 需要产品或研发确认能力限制
candidate_profiles:
  - speed
  - depth
  - focused
  - mixed_method
  - remediation
---

# 问题根因拆解

## 场景定义

将已识别问题拆解到心智、信息、链路、能力、规则或业务约束等根因层。

## 适用情况

- 这个问题根因是什么？
- 为什么用户会卡住？
- 帮我拆一下原因

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 问题清单
- 证据材料
- 业务规则

## 信息不足时如何处理

证据不足时输出根因假设树并标注验证方式。

## 标准输出结构

- 根因假设
- 证据链
- 影响机制
- 待验证问题

## 完成标准

- 根因与现象分开
- 每个根因有证据或待验证标记
- 说明影响对象

## 默认 Skill

- `ds-skill-user-insight-synthesis`（draft）

## 按需 Skill

- `ds-skill-strategy-map-generation`（draft）
- `ur-skill-jobs-to-be-done`（draft）

## 默认知识调用范围

- 设计策略方法：问题定义/痛点诊断
- 用户研究知识：用户需求/JTBD
- 场域知识包：基础与洞察知识

## 前置和后续任务

- 前置 Scenario：experience-walkthrough, feedback-issue-clustering, data-behavior-diagnosis
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 根因涉及业务规则归属
- 需要产品或研发确认能力限制

## 设计业务示例

例如把“用户看不懂价格”拆成价格心智、优惠规则、展示位置和状态反馈问题。
