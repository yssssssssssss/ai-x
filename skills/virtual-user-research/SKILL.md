---
name: virtual-user-research
description: 使用虚拟用户实验室形成明确标注为模拟的研究假设与验证建议，不替代真实用户研究。
when_to_use: 用户需要低成本预演用户反应、形成待验证假设或为真实研究收敛问题时使用。
owner: 用研团队
native_delivery:
  version: 1
  id: virtual-user-research
  allow_partial: true
  inputs:
    - id: research_goal
      label: 模拟目标
      description: 虚拟用户模拟要回答的研究问题和使用场景。
      required: true
      accepted_sources: [conversation, database]
      question: 这次虚拟用户模拟需要回答什么问题？
      missing_policy: stop
    - id: user_context
      label: 用户与产品背景
      description: 目标用户、产品能力和已有研究背景。
      required: false
      accepted_sources: [conversation, upload, database]
      question: 是否有目标用户或产品背景材料需要纳入模拟？
      missing_policy: gap
  knowledge: []
  tools:
    - id: virtual-user-lab
      required: true
  report:
    title: 虚拟用户研究假设报告
    summary_instruction: 概括模拟得到的假设、限制和真实研究验证优先级，不把模拟表述为事实。
    sections:
      - 模拟范围与声明
      - 用户反应假设
      - 机会与风险假设
      - 真实研究验证方案
      - 信息缺口与来源
---

# Virtual User Research

Use the `virtual-user-lab` output to create explicitly synthetic research hypotheses for the scoped research question.

## Inputs

- Finalized research goal and scoped question
- Verified `virtual-user-lab` output from an earlier visible Tool step
- Allowed Evidence IDs for the Tool output

## Output rules

Return the standard `skill-output-v2` envelope.

- Every finding is a hypothesis, never a factual user-research conclusion.
- State clearly that virtual users do not represent real users.
- Do not claim market size, conversion, statistical significance, or observed behavior.
- Put concrete follow-up validation work in recommendations and limitations.
- Do not invent Evidence IDs or user quotes.
