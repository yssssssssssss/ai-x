---
id: skill_solution_generation
type: skill
title: 解决方案生成 Skill
domain:
  - general
tags:
  - design-strategy
  - solution-generation
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: skills/solution-generation/SKILL.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/02-skills-技能/设计策略/解决方案生成/SKILL.md
hub_source_hash: sha256:4f464cef5cc1c2b52a8a6ab2260d55e1994bdad5f1cee6b88742463927252afd
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:094b9811ea54a2fc682afbedbe3356d01eac525a45283ccaa996186f08197c89
summary: "- 一级 Task：`solve-problems`"
guide_tags: []
guide_stage: []
capability_domain:
  - design-strategy
business_domain: general
task_types:
  - solution-generation
evidence_types:
  - current-project-materials
  - domain-knowledge
  - case
name: solution-generation
description: 解决方案生成 Skill
inputs: []
outputs: []
risk_level: low
---

# 解决方案生成 Skill

## 适用 Task / Scenario

- 一级 Task：`solve-problems`
- 二级 Scenario：`solution-generation`

用于用户已经给出问题、卡点、风险或优化目标，希望获得可落地的解决方向、方案组合和取舍说明。

## Trigger / 使用条件

- 用户表达中出现“怎么解决”“怎么改”“优化一下”“给几个改法”“方案方向”等。
- 已有问题描述、现状材料、截图/流程描述、用户反馈、数据异常或上游问题清单之一。
- 若用户同时要求“先看问题再给方案”，应串联 `find-problems → solve-problems`，本 Skill 只处理方案生成部分。

## Input

必要输入：

- 问题或机会描述；
- 影响对象或触点；
- 当前业务 / 页面 / 场域上下文。

可选输入：

- 截图、原型、流程、数据、用户反馈、竞品观察；
- 业务目标、上线窗口、资源约束、技术约束；
- 已有方案草稿或待比较方案。

## 所需 Knowledge

必需：

- 当前项目资料；
- 策略地图 / 问题到策略方法；
- 对应场域基础知识。

按需：

- 场域经验知识；
- 场域约束条件；
- 竞品与标杆知识；
- 指标与验证知识。

不得读取：

- 无关场域知识；
- 未经确认的价格、库存、履约、交易规则作为稳定事实。

## 执行步骤

1. 复述问题边界：说明要解决的对象、场景、用户和业务目标。
2. 判断问题层级：区分认知问题、信息问题、链路问题、规则问题、能力问题和表达问题。
3. 提取约束：列出必须遵守、需要确认和暂缺的约束。
4. 生成方案方向：给出 2 到 4 个方向，每个方向说明解决逻辑、适用前提和不适用条件。
5. 组合设计动作：把方向拆成触点级动作，标注主方案、轻量方案和可后置动作。
6. 标注风险：说明用户风险、业务风险、研发/运营风险和需要人工确认的规则。
7. 给出验证口径：列出上线前评审点和上线后指标，不编造数据结果。

## Output

```markdown
## 问题边界

## 方案方向
| 方向 | 解决什么 | 关键动作 | 适用前提 | 风险 |

## 推荐组合
- 必做：
- 可选：
- 后置：

## 需要确认

## 验证口径
```

## Human Confirmation 条件

- 涉及价格、库存、履约、交易规则、合规或业务政策；
- 需要决定资源排期、研发投入或上线范围；
- 当前项目事实与场域稳定知识冲突；
- 用户要求直接拍板唯一方案。

## Fallback 条件

- 缺少截图 / 流程 / 现状材料时，输出方案假设和待补材料，不输出确定性结论。
- 缺少场域经验知识时，只给通用方案框架和需检索的案例类型。
- 规则类信息不足时，标注“需业务确认”，不凭模型常识补内部规则。

## 与其他 Skill 的边界

- 与 `ds-skill-strategy-map-generation`：本 Skill 生成方案动作；策略地图负责把多来源证据整合为策略层和路线。
- 与 `ur-skill-run-heuristic-evaluation`：启发式评估负责发现体验问题；本 Skill 接收问题后生成解决方向。
- 与 `ur-skill-issue-prioritization`：优先级 Skill 负责排序；本 Skill 只给方案候选和初步风险。
