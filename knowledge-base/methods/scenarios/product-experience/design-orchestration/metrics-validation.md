---
id: metrics-validation
type: scenario-guide
title: 指标与验证计划
domain:
  - 产品体验
tags: []
status: approved
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/metrics-validation.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/05-define-strategy-定策略/03-metrics-validation-指标与验证计划.md
hub_source_hash: sha256:8005b7c43ea286ff946ad792c8d7883fad62c7dc4ec50b8c4f6f479389a46472
distribution_scope: internal_repository
retention: repository-lifetime-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:eff18347fa8bc3e55557f892aabde29f0eaf65003cf04a7f264dc05223f3600b
summary: 为策略或方案设计上线前验证、灰度观察和上线后指标口径。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: define-strategy
definition: 为策略或方案设计上线前验证、灰度观察和上线后指标口径。
trigger_examples:
  - 怎么验证这个方案？
  - 上线后看什么指标？
  - 需要哪些实验？
required_inputs:
  - 策略或方案
  - 目标变化
  - 可观测指标
optional_inputs:
  - 历史数据
  - 埋点口径
  - 实验条件
  - 用户反馈渠道
outputs:
  - 指标树
  - 验证计划
  - 观察窗口
  - 风险预警
completion_criteria:
  - 指标能对应策略目标
  - 区分过程指标和结果指标
  - 说明数据限制
default_skills:
  - id: ur-skill-build-experience-metrics
    status: draft
optional_skills:
  - id: ur-skill-conversion-funnel-analysis
    status: draft
  - id: ur-skill-feature-adoption-analysis
    status: draft
  - id: ur-skill-analyze-satisfaction
    status: draft
knowledge_requirements:
  - 用户研究知识：体验度量/漏斗/功能采纳
  - 场域知识包：指标口径
  - 当前项目资料
dependencies:
  - strategy-synthesis
  - priority-roadmap
fallback:
  - 无埋点时输出代理指标和补埋点建议。
human_confirmation:
  - 指标口径需要数据方确认
  - 实验方案影响线上交易
  - 样本量不足
candidate_profiles:
  - speed
  - depth
  - mixed_method
  - decision
  - focused
---

# 指标与验证计划

## 场景定义

为策略或方案设计上线前验证、灰度观察和上线后指标口径。

## 适用情况

- 怎么验证这个方案？
- 上线后看什么指标？
- 需要哪些实验？

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 策略或方案
- 目标变化
- 可观测指标

## 信息不足时如何处理

无埋点时输出代理指标和补埋点建议。

## 标准输出结构

- 指标树
- 验证计划
- 观察窗口
- 风险预警

## 完成标准

- 指标能对应策略目标
- 区分过程指标和结果指标
- 说明数据限制

## 默认 Skill

- `ur-skill-build-experience-metrics`（draft）

## 按需 Skill

- `ur-skill-conversion-funnel-analysis`（draft）
- `ur-skill-feature-adoption-analysis`（draft）
- `ur-skill-analyze-satisfaction`（draft）

## 默认知识调用范围

- 用户研究知识：体验度量/漏斗/功能采纳
- 场域知识包：指标口径
- 当前项目资料

## 前置和后续任务

- 前置 Scenario：strategy-synthesis, priority-roadmap
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 指标口径需要数据方确认
- 实验方案影响线上交易
- 样本量不足

## 设计业务示例

例如为商详首屏策略设定规则咨询量、加购率、规格弹层打开率和转化率观察。
