---
format: user-research-hub-merge-draft-v1
status: draft
runtime_consumed: false
review_gate: gate-2
source_entity: skill:ds-skill-trend-change-scan
source_path: wiki/user-research/02-skills-技能/设计策略/趋势变化扫描/SKILL.md
source_hash: sha256:953ac3cc8b46bdda988654f8880e767ca489202e6b26a8afee561e39f1ed07e1
canonical_target: skills/competitive-analysis/web-research/SKILL.md
canonical_hash: sha256:9eacba95cc36931d6da736efa8ce74a0e8f90fb6b187c2d8debf9c35c69b7d59
disposition: merge_into_existing
merge_sections:
  - review_required
distribution_scope: evaluation_only
managed_by: user-research-hub-integration-v1
---

# Merge draft: skill:ds-skill-trend-change-scan

> Review artifact only. The existing canonical entry remains authoritative; this draft is not loaded by Runtime or the Skill Registry.

## Structural comparison

- Source-only headings: 趋势与变化扫描 Skill | 适用 Task / Scenario | Trigger / 使用条件 | Input | 所需 Knowledge | Output | 变化信号 | 初步判断 | 待验证问题 | 推荐后续 Task | Human Confirmation 条件 | Fallback 条件 | 与其他 Skill 的边界
- Canonical-only headings: 竞品分析 · Web 搜索路径 | 何时使用 / 不使用 | 输入 | 产出 | 边界与合规
- Shared headings with changed text: 执行步骤

## Candidate source content

# 趋势与变化扫描 Skill

## 适用 Task / Scenario

- 一级 Task：`find-direction`
- 二级 Scenario：`trend-change-identification`

用于从用户输入、当前项目资料、场域基础知识和外部参照中识别变化信号，形成方向探索输入。

## Trigger / 使用条件

- 用户问“最近有什么变化”“有什么新玩法”“趋势是什么”“有没有方向值得看”。
- 用户没有要求完整竞品分析，而是先要变化信号和机会假设。

## Input

必要输入：

- 业务或场域范围；
- 目标页面 / 模块 / 人群 / 任务之一；
- 已有观察、材料或待扫描对象。

可选输入：

- 竞品截图、行业资料、用户反馈、数据变化、内部项目背景。

## 所需 Knowledge

必需：

- 当前项目资料；
- 对应场域基础知识；
- 竞品模式 / 机会风险方法。

按需：

- 场域洞察知识；
- 场域经验知识；
- 通用体验知识。

## 执行步骤

1. 定义扫描范围：场域、模块、人群、周期和材料边界。
2. 提取变化信号：从用户、竞品、业务、数据、技术、体验表达六类中归纳。
3. 标注证据强度：区分事实、观察、推断和待验证假设。
4. 判断影响对象：说明变化影响用户理解、任务效率、决策心智、转化或运营效率中的哪一类。
5. 形成机会假设：每条假设说明为什么值得看、适合谁、还缺什么证据。
6. 输出下一步验证建议：说明需要补充的材料或可进入的后续 Task。

## Output

```markdown
## 变化信号
| 信号 | 来源 | 影响对象 | 证据强度 | 机会假设 |

## 初步判断

## 待验证问题

## 推荐后续 Task
```

## Human Confirmation 条件

- 涉及价格、履约、库存、交易规则或业务政策变化；
- 用户要求把趋势直接作为决策依据；
- 信号来源只有推断且影响高。

## Fallback 条件

- 没有外部材料时，只输出扫描框架和待补资料清单。
- 缺少场域知识时，不做场域事实判断，只输出通用变化维度。
- 趋势证据不足时标注低置信度，不写成确定趋势。

## 与其他 Skill 的边界

- 与 `ds-skill-competitor-strategy-analysis`：本 Skill 先找变化信号；竞品策略分析做系统竞品拆解。
- 与 `ds-skill-strategy-map-generation`：本 Skill 输出机会假设；策略地图负责整合为策略。
