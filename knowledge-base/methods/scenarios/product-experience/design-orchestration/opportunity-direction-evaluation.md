---
id: opportunity-direction-evaluation
type: scenario-guide
title: 机会方向判断
domain:
  - 产品体验
tags: []
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/scenarios/product-experience/design-orchestration/opportunity-direction-evaluation.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/01-task-任务/01-find-direction-找方向/03-opportunity-direction-evaluation-机会方向判断.md
hub_source_hash: sha256:a62d21667d82a143111686a81c64ef4779a28ffaa9fe02c4a6b9fd38ac550943
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:1dfd0d5ef883d563f9b9d0d2f36bed309fd7075d2bd2a862677c639e9aa7072a
summary: 基于趋势、用户、竞品、业务和数据线索，判断哪些方向值得优先探索。
guide_tags:
  - scenario-guidance
guide_stage:
  - intent
  - method-selection
parent_task: find-direction
definition: 基于趋势、用户、竞品、业务和数据线索，判断哪些方向值得优先探索。
trigger_examples:
  - 这些机会哪个值得做？
  - 这个方向有没有价值？
  - 帮我收敛机会点
required_inputs:
  - 候选方向
  - 目标与约束
  - 证据材料
optional_inputs:
  - 用户反馈
  - 业务目标
  - 竞品启发
  - 数据规模
outputs:
  - 机会方向清单
  - 价值判断
  - 验证假设
  - 优先探索建议
completion_criteria:
  - 每个方向有证据或假设标记
  - 说明用户价值和业务价值
  - 列出验证方式
default_skills:
  - id: ds-skill-strategy-map-generation
    status: draft
optional_skills:
  - id: ur-skill-issue-prioritization
    status: draft
  - id: planned-opportunity-evaluation-skill
    status: planned
knowledge_requirements:
  - 设计策略方法：策略推导
  - 用户研究知识：机会点研究
  - 当前项目资料
  - 场域知识包：洞察知识（按需）
dependencies:
  - trend-change-identification
  - competitor-benchmark-research
fallback:
  - 证据不足时只给机会假设和验证优先级，不给确定结论。
human_confirmation:
  - 方向涉及资源投入
  - 业务目标冲突
  - 缺少关键证据
candidate_profiles:
  - speed
  - depth
  - focused
  - decision
---

# 机会方向判断

## 场景定义

基于趋势、用户、竞品、业务和数据线索，判断哪些方向值得优先探索。

## 适用情况

- 这些机会哪个值得做？
- 这个方向有没有价值？
- 帮我收敛机会点

## 不适用情况

- 用户已经要求执行具体 Skill 的详细步骤时，应进入 Skill 层。
- 用户只需要查阅某个方法或术语时，应进入 Knowledge 层。
- 用户需要全局路由、证据降级或质量门禁时，应进入 Mechanism 层。

## 必要输入

- 候选方向
- 目标与约束
- 证据材料

## 信息不足时如何处理

证据不足时只给机会假设和验证优先级，不给确定结论。

## 标准输出结构

- 机会方向清单
- 价值判断
- 验证假设
- 优先探索建议

## 完成标准

- 每个方向有证据或假设标记
- 说明用户价值和业务价值
- 列出验证方式

## 默认 Skill

- `ds-skill-strategy-map-generation`（draft）

## 按需 Skill

- `ur-skill-issue-prioritization`（draft）
- `planned-opportunity-evaluation-skill`（planned）

## 默认知识调用范围

- 设计策略方法：策略推导
- 用户研究知识：机会点研究
- 当前项目资料
- 场域知识包：洞察知识（按需）

## 前置和后续任务

- 前置 Scenario：trend-change-identification, competitor-benchmark-research
- 常见后续：根据输出进入下一类 Task，或进入定策略进行收敛。

## 需要人工确认的情况

- 方向涉及资源投入
- 业务目标冲突
- 缺少关键证据

## 设计业务示例

例如从首屏信息弱、价格感知弱、规则理解难中判断下一轮先探索哪类机会。
