# Multi-Skill Composition Audit

> 日期：2026-08-25
> Registry：`orchestrator/skill-registry.yaml`
> 标准 Contribution：`schemas/research-contribution-v1.schema.json`

本表记录所有 active Skill 的组合分类。`contributor` 表示 Registry 合同允许其覆盖对应 Capability Demand；并不表示 Adapter 已完成。首批 Adapter/原生输出迁移仍由 Phase 4 验收，在此之前 Multi-Skill writer 保持 inactive。

| Skill | Composition | Outcome | Compatible Deliverable | Contribution Type | Phase 2 disposition |
|---|---|---|---|---|---|
| `digital-human-competitive-analysis` | standalone | plan, answer | competitive analysis, research plan | — | 复合 Tool/Payload 无确定性 Unit 映射 |
| `competitive-web-research` | standalone, contributor | answer | competitive analysis, strategy report | market landscape, competitive analysis | 首批 Adapter 候选 |
| `competitive-app-analysis` | standalone | answer | competitive analysis | — | 视觉 Payload 尚无确定性映射 |
| `design-experience-review` | standalone | plan, answer | research plan, design audit | — | 多 Lab 视觉 Payload 尚无稳定 Unit |
| `accessibility-review` | standalone, contributor, synthesizer | answer | accessibility/design audit | accessibility | `accessibility_audit_report` 唯一 Synthesizer；亦可作为 design Contributor |
| `analyze-satisfaction` | standalone, contributor | answer | VOC, strategy report | satisfaction | 有数据输入时可组合 |
| `build-experience-metrics` | standalone, contributor | plan, answer | research plan, strategy report | metrics | 首批 Adapter 候选 |
| `code-open-feedback` | standalone, contributor | answer | VOC, strategy report | VOC | 有用户材料时可组合 |
| `competitive-analysis` | standalone, contributor, synthesizer | answer | competitive analysis, strategy report | competitive analysis | `competitive_analysis_report` 唯一 Synthesizer；亦可供策略报告供稿 |
| `conversion-funnel-analysis` | standalone, contributor | plan, answer | research plan, strategy report | funnel | 有数据时分析；无数据只允许测量方案 |
| `feature-adoption-analysis` | standalone, contributor | plan, answer | research plan, strategy report | feature adoption | 有数据时分析；无数据只允许测量方案 |
| `generate-interview-guide` | standalone | plan | research plan | — | 访谈提纲 Payload 尚未映射到 planning Contribution |
| `generate-persona` | standalone, contributor | answer | strategy report | persona | 首批 Adapter 候选；无真实材料时 provisional |
| `generate-research-plan` | standalone, synthesizer | plan | research plan | research method | `research_plan` 唯一 Synthesizer |
| `virtual-user-research` | standalone, contributor | answer | strategy report | virtual user hypothesis | 强制 provisional；依赖真实 `virtual-user-lab` Tool receipt |
| `research-strategy-synthesis` | standalone, synthesizer | answer | strategy report | qualitative insight, VOC, satisfaction, design audit, accessibility, research method, prioritization, strategy, action plan | `research_strategy_report` 唯一 Synthesizer；无可用 Specialist 输入时仅以显式 provisional/gap 方式兜底 |
| `generate-survey` | standalone | plan | research plan | — | 问卷 Payload 尚未映射到 planning Contribution |
| `generate-usability-test` | standalone | plan, answer | research plan, design audit | — | 测试执行包尚非标准 Contribution |
| `issue-prioritization` | standalone, contributor | answer | strategy/VOC/design audit | prioritization | 有问题清单时可组合 |
| `jobs-to-be-done` | standalone, contributor | answer | strategy report | jobs to be done | 首批 Adapter 候选；无真实材料时 provisional |
| `journey-map` | standalone, contributor | answer | strategy/VOC report | journey | 有研究材料时可组合 |
| `run-heuristic-evaluation` | standalone, contributor, synthesizer | answer | design audit | design audit | `design_audit_report` 唯一 Synthesizer |
| `structure-interview-transcript` | standalone | answer | research plan | — | 单场整理属于诊断输入，暂不直接供稿 |
| `synthesize-qualitative-insights` | standalone, contributor, synthesizer | answer | strategy/VOC report | qualitative insight | `voc_diagnosis_report` 唯一 Synthesizer；亦可供策略报告供稿 |

## Deliverable policy

| Deliverable | Mode | Synthesizer |
|---|---|---|
| `research_plan` | portfolio | `generate-research-plan` |
| `research_strategy_report` | portfolio | `research-strategy-synthesis` |
| `competitive_analysis_report` | portfolio | `competitive-analysis` |
| `voc_diagnosis_report` | portfolio | `synthesize-qualitative-insights` |
| `design_audit_report` | portfolio | `run-heuristic-evaluation` |
| `accessibility_audit_report` | portfolio | `accessibility-review` |

所有 active Deliverable 均已有唯一组合策略。Multi-Skill writer 在最终 Activation 前仍保持关闭；未满足输入或 Adapter 条件的 Contributor 会返回显式 capability gap。
