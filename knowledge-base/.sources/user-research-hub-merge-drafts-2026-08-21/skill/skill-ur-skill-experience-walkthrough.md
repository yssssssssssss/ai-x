---
format: user-research-hub-merge-draft-v1
status: draft
runtime_consumed: false
review_gate: gate-2
source_entity: skill:ur-skill-experience-walkthrough
source_path: wiki/user-research/02-skills-技能/用户研究/体验走查/SKILL.md
source_hash: sha256:99c1b0a3790963c83a2fc9a4f906a8593d8140df3a7651ceac7b1cb92dd835e4
canonical_target: knowledge-base/skills/run-heuristic-evaluation
canonical_hash: sha256:8f2b6079b6e66582709a2abfca9b6a2797b27a3fff47f22f76ea2d3e7b134395
disposition: merge_into_existing
merge_sections:
  - review_required
distribution_scope: evaluation_only
managed_by: user-research-hub-integration-v1
---

# Merge draft: skill:ur-skill-experience-walkthrough

> Review artifact only. The existing canonical entry remains authoritative; this draft is not loaded by Runtime or the Skill Registry.

## Structural comparison

- Source-only headings: 页面与链路体验走查 Skill | 适用 Task / Scenario | Trigger / 使用条件 | Input | 所需 Knowledge | 执行步骤 | Output | 走查范围 | 问题清单 | 未覆盖范围 | 需要人工确认 | Human Confirmation 条件 | Fallback 条件 | 与其他 Skill 的边界
- Canonical-only headings: Run Heuristic Evaluation — 评估对象 + 范围 → 启发式评估（编排 wiki 正典） | 北极星与边界（先理解，再动手） | 四条纪律（本 skill 必须遵守，产出据此被信任） | 第 0 步：定位 wiki 根目录 | 第 1 步：解析 brief | 第 2 步：读正典（本 skill 的核心——cross-walk） | 第 3 步 · A：直接评（默认模式 —— 有界面素材时） | 第 3 步 · B：产工具包（无界面素材时） | 第 4 步：评估自检（拿"局限与误用"回头扫一遍） | 第 5 步：组装交付 | references
- Shared headings with changed text: none

## Candidate source content

# 页面与链路体验走查 Skill

## 适用 Task / Scenario

- 一级 Task：`find-problems`
- 二级 Scenario：`experience-walkthrough`

用于基于页面、截图、流程描述或模块说明，识别体验问题、证据位置、影响范围和待验证项。

## Trigger / 使用条件

- 用户说“帮我看看”“哪里有问题”“这个模块怪怪的”“有什么体验风险”。
- 输入对象是页面、模块、链路、截图、原型或足够具体的流程描述。

## Input

必要输入：

- 走查对象：页面 / 模块 / 链路 / 截图 / 文字描述；
- 场景或用户任务；
- 当前目标或问题背景。

可选输入：

- 数据异常、用户反馈、竞品对照、业务规则、机型或端信息。

## 所需 Knowledge

必需：

- 当前项目资料；
- 对应场域基础知识；
- 可用性 / 启发式评估方法。

按需：

- 场域模块定义；
- 场域业务规则；
- 场域用户反馈与体验问题；
- 体验指标口径。

## 执行步骤

1. 定义走查范围：对象、场景、用户任务、素材形态和未覆盖部分。
2. 读取场域基础知识：明确模块职责、链路位置和术语边界。
3. 按任务链路走查：从入口、理解、决策、操作、反馈、异常态逐段检查。
4. 记录问题证据：每条问题绑定具体位置或用户输入中的证据。
5. 评估影响：区分理解成本、操作成本、信任风险、转化阻断和规则误解。
6. 输出问题清单：标注严重度、置信度、待补材料和是否需要人工确认。

## Output

```markdown
## 走查范围

## 问题清单
| 位置 | 问题 | 证据 | 影响 | 严重度 | 置信度 | 建议下一步 |

## 未覆盖范围

## 需要人工确认
```

## Human Confirmation 条件

- 涉及价格、库存、履约、交易规则、合规和业务政策；
- 走查对象描述过于模糊，无法定位页面或模块；
- 需要判断线上真实影响但缺少数据或用户证据。

## Fallback 条件

- 没有截图或明确流程时，输出走查清单和所需素材。
- 场域知识不足时，标注“场域依据不足”，只做通用体验风险提示。
- 只有单条主观描述时，不输出确定问题，只输出假设和验证方式。

## 与其他 Skill 的边界

- 与 `ur-skill-run-heuristic-evaluation`：启发式评估偏方法标尺；本 Skill 面向业务页面和链路走查，可调用启发式方法作为依据。
- 与 `ur-skill-code-open-feedback`：反馈编码处理用户文本；本 Skill 处理页面/链路对象。
- 与 `ds-skill-solution-generation`：本 Skill 输出问题和风险；方案生成 Skill 负责给解决方向。
