---
format: user-research-hub-merge-draft-v1
status: draft
runtime_consumed: false
review_gate: gate-2
source_entity: skill:ur-skill-experience-walkthrough
source_path: wiki/user-research/02-skills-技能/用户研究/体验走查/SKILL.md
source_hash: sha256:99c1b0a3790963c83a2fc9a4f906a8593d8140df3a7651ceac7b1cb92dd835e4
canonical_target: knowledge-base/skills/run-heuristic-evaluation
canonical_hash: sha256:add36330c6fd519d3f332e3df219cc053cfcb703eca5fa67530bf2843a5ae3c4
disposition: merge_into_existing
merge_sections:
  - when_to_use
  - scope
  - evidence_location
  - confidence
  - human_confirmation
distribution_scope: evaluation_only
managed_by: user-research-hub-integration-v1
---

# Merge draft: skill:ur-skill-experience-walkthrough

> Review artifact only. The existing canonical entry remains authoritative; this draft is not loaded by Runtime or the Skill Registry.

## Structural comparison

- Source-only headings: 页面与链路体验走查 Skill | 适用 Task / Scenario | Trigger / 使用条件 | Input | 所需 Knowledge | 执行步骤 | Output | 走查范围 | 问题清单 | 未覆盖范围 | 需要人工确认 | Human Confirmation 条件 | Fallback 条件 | 与其他 Skill 的边界
- Canonical-only headings: Run Heuristic Evaluation — 评估对象 + 范围 → 启发式评估（编排 wiki 正典） | 北极星与边界（先理解，再动手） | 四条纪律（本 skill 必须遵守，产出据此被信任） | 第 0 步：定位 wiki 根目录 | 第 1 步：解析 brief | 第 2 步：读正典（本 skill 的核心——cross-walk） | 第 3 步 · A：直接评（默认模式 —— 有界面素材时） | 第 3 步 · B：产工具包（无界面素材时） | 第 4 步：评估自检（拿"局限与误用"回头扫一遍） | 第 5 步：组装交付 | 页面与链路走查补充 | references
- Shared headings with changed text: none

## Approved narrow delta

## Proposed canonical delta

### when_to_use
- Use for a named page, flow, state, or task path with reviewable materials; do not claim observed behavior without a screenshot, URL, recording, or user-provided artifact.
### scope
- Freeze entry/exit points, device/state, target user, and included steps before the walkthrough.
### evidence_location
- Every issue must point to the exact page/state/step and distinguish observed evidence from heuristic inference.
### confidence
- Mark issues based only on heuristic inference as hypotheses and provide a concrete validation or retest method.
### human_confirmation
- Require confirmation before handling sensitive screens, authenticated flows, personal data, or any external action.
