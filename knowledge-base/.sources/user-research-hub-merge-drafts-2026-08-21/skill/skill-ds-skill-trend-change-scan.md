---
format: user-research-hub-merge-draft-v1
status: draft
runtime_consumed: false
review_gate: gate-2
source_entity: skill:ds-skill-trend-change-scan
source_path: wiki/user-research/02-skills-技能/设计策略/趋势变化扫描/SKILL.md
source_hash: sha256:953ac3cc8b46bdda988654f8880e767ca489202e6b26a8afee561e39f1ed07e1
canonical_target: skills/competitive-analysis/web-research/SKILL.md
canonical_hash: sha256:ce2e8219c6a2d201cd65a9deb8653fd42296a7fcba56db5ab18b8d23920ce7e4
disposition: merge_into_existing
merge_sections:
  - when_to_use
  - evidence_boundary
  - fallback
  - human_confirmation
distribution_scope: evaluation_only
managed_by: user-research-hub-integration-v1
---

# Merge draft: skill:ds-skill-trend-change-scan

> Review artifact only. The existing canonical entry remains authoritative; this draft is not loaded by Runtime or the Skill Registry.

## Structural comparison

- Source-only headings: 趋势与变化扫描 Skill | 适用 Task / Scenario | Trigger / 使用条件 | Input | 所需 Knowledge | Output | 变化信号 | 初步判断 | 待验证问题 | 推荐后续 Task | Human Confirmation 条件 | Fallback 条件 | 与其他 Skill 的边界
- Canonical-only headings: 竞品分析 · Web 搜索路径 | 何时使用 / 不使用 | 输入 | 产出 | 边界与合规 | 趋势与变化扫描补充 | 趋势与变化扫描补充
- Shared headings with changed text: 执行步骤

## Approved narrow delta

## Proposed canonical delta

### when_to_use
- Use when the user explicitly asks for trend/change scanning across a named market, audience, scenario, or time window; do not infer a trend task from a passing mention.
### evidence_boundary
- A trend claim requires dated, traceable public sources from more than one observation point. Knowledge and cases provide method only and cannot prove a current market trend.
### fallback
- If time-series or comparable dated sources are unavailable, return a bounded snapshot and record the missing longitudinal evidence instead of asserting change.
### human_confirmation
- Ask for confirmation when the requested time window, market boundary, or comparison basis materially changes the conclusion.
