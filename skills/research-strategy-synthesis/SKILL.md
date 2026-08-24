---
name: research-strategy-synthesis
description: 基于已验证公开资料、Knowledge、用户材料与数据，逐项回答业务研究问题，输出证据约束的策略地图、心智模型、设计原则、机会点和优先行动；证据不足时给出 provisional 答案而不是退化为研究计划。
when_to_use: 用户要求基于当前证据直接给出研究结论、策略产物和优先行动时使用。
owner: 用研团队
---

# Research Strategy Synthesis

## 目标

先回答，再解释。每个必答问题必须给出当前最佳答案、证据、置信度、业务含义、行动和待验证内容。

## 规则

- 输出 `research-strategy-content-draft-v2`，只包含语义内容；不要生成全局ID、Coverage、FindingGraph、风险来源身份、source pointer或requestedArtifactBindings，这些由运行时确定性生成。
- `input.requirement_context.requested_artifacts` 是本次必须实体化的唯一请求产物清单；只生成有内容的对应 Block，不用固定模板补齐未请求对象。
- Evidence ID 必须使用运行时的完整确定性格式：来源步骤 S 的第 N 条有效结果写为 `E{S}-{N}`（例如 `E1-1`），不得缩写为 `E1`；Knowledge 使用其完整 `K{S}-{N}` ID。
- `prior_outputs[].evidenceIds` 是运行时已经签发的可用 ID 清单；`input.evidence_inventory` 中按问题列出的完整 ID 是待运行时核验的候选绑定。即使输入中没有最终 EvidenceManifest，也不得仅因此清空所有结构化 `evidenceIds`；优先保留与陈述相关的候选 ID，最终由运行时逐项验证和受限修复。
- 每个非 unanswered 的 direct answer、evidence finding 与产物 Block support 都应绑定相关 Evidence；若 Evidence 仅提供上下文而不能直接证明推断，必须保持 provisional 并写明验证方法。
- 只能把 Evidence 绑定的陈述标为 supported。
- 证据不足但可形成方向判断时标为 provisional，并写明验证方法。
- 不得用“建议进一步研究”替代直接答案。
- 用户请求的策略地图、心智模型、设计原则、机会点和优先行动必须用对应的类型化 content block 生成；未请求的产物不需要创建空对象。
- 所有渠道、品类、人群和因果结论必须限制在 Evidence 支持范围内。
- 冲突证据和能力降级必须进入 limitations/openQuestions。
