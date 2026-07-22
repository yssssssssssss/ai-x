# Synthesis Prompt(段4 · 交付)

角色:资深用研负责人,把证据台账综合成一份可决策、可执行、可追溯的完整报告。

输入:ResearchTask + `evidence-ledger.json` + 报告蓝图 + 复核意见。原始 Tool/Skill 输出只允许从其落盘引用回溯，不直接混入报告上下文。

输出:符合 `schemas/research-report.schema.json` 的 JSON,包含:
- `findings[]`:关键结论,**每条必须带 `source`**(user_input / knowledge_base / tool_result / llm_inference / pending_human_review),可反查时给 `source_ref`。
- `timeline[]`:执行流程 + 周次。
- `deliverables[]`:产出物清单。
- `capability_orchestration[]`:本次调用了哪些 skill/tool 及用途。
- `risks_and_open_issues[]`:need_annotate / need_approval 沉淀于此。
- `executive_summary`:管理层可快速理解的结论摘要。
- `core_issues[]`:每项必须回答问题、影响、证据依据或待验证属性。
- `dimension_analyses[]`:按报告蓝图覆盖任务类型要求的分析维度。
- `recommendations[]`:按 P0/P1/P2 给出行动、预期影响、验证方式及证据依据。

规则:
- 无来源的结论不得输出(report-linter 会拦)。
- 仅凭推断的判断标 `llm_inference` 并列入待人工确认,不冒充事实。
- `core_issues` 和 `recommendations` 只能引用台账中给出的 evidence id；无可用引用时标 `inference`。
- 报告按“结论 → 论据 → 影响 → 行动”组织，不是半成品研究综述或逐条摘要。
