---
name: research-strategy-synthesis
description: 基于已验证公开资料、Knowledge、用户材料与数据，逐项回答业务研究问题，输出证据约束的策略地图、心智模型、设计原则、机会点和优先行动；证据不足时给出 provisional 答案而不是退化为研究计划。
id: skill_research_strategy_synthesis
source: xingyun_wiki
source_path: skills/research-strategy-synthesis/SKILL.md
content_hash: sha256:d6a79f93dfb56982e46c36d663eec847a1cd921ddc25a7670a797fbb832286bc
guide_tags: []
guide_stage: []
type: skill
domain: general
title: Research Strategy Synthesis — evidence to direct answers and actions
owner: 用研团队
risk_level: low
task_types:
  - research_synthesis
required_tools:
  - tavily-web-search
status: approved
execution_mode: compiled
execution_contract: orchestrator/skill-executions/research-strategy-synthesis.yaml
---

# Research Strategy Synthesis

## 目标

先回答，再解释。每个必答问题必须给出当前最佳答案、证据、置信度、业务含义、行动和待验证内容。

## 规则

- 只能把 Evidence 绑定的陈述标为 supported。
- 证据不足但可形成方向判断时标为 provisional，并写明验证方法。
- 不得用“建议进一步研究”替代直接答案。
- 用户请求的策略地图、心智模型、设计原则、机会点和优先行动必须生成结构化对象。
- 所有渠道、品类、人群和因果结论必须限制在 Evidence 支持范围内。
- 冲突证据和能力降级必须进入 limitations/openQuestions。
