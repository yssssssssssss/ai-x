# Requirement 与 Deliverable 合同修复

## 问题

Requirement 模型同时生成 `task_type` 和 `expected_deliverables`，但 Prompt 与 JSON Schema 没有表达两者的一一映射。入口随后使用只适合已持久化合同的严格 Registry 校验，导致自然语言报告名称在 Planner 启动前失败，并把内部错误直接展示给用户。

## 目标

- 自然语言和模型生成内容在 Requirement 入口被确定性规范化。
- 已持久化 Requirement、Planner 和 Execution 继续严格拒绝不一致合同。
- 研究方案、专业报告和综合策略答案按用户表达确定，不由通用答案词覆盖明确专业意图。
- 无法确定时进入现有澄清流程，不启动 Planner 或真实 Tool。
- 前端不显示 Registry 字段名或内部异常。

## 决策

1. 用户的显式澄清选择优先。
2. 同时出现规划与直接答案信号时，继续询问 `outcome_mode`。
3. 明确的专业研究意图优先于“报告、结论、建议、应该怎么”等通用答案信号。
4. 无明确专业意图且只要求直接答案时，使用 `research_synthesis`。
5. Requirement 入口不信任模型生成的 `expected_deliverables`；在最终 `task_type` 确定后，由 Deliverable Registry 写入唯一 canonical ID。
6. 用户选择报告类型后，该选择同时确定直接答案模式；只解除同义的结果类型歧义，市场、时间、数据范围等独立阻断仍保留。
7. `deliverable_intent` 只用于竞品报告与综合策略报告之间的真实冲突，不把 VOC、设计或无障碍审计误导到竞品选项。
8. Planner、Execution 和报告阶段仍使用严格兼容性检查，禁止修复或猜测已经持久化的不一致合同。
9. 初始规划接口只返回稳定的中文用户错误；内部异常保留在服务端诊断边界，不通过 SSE 泄漏。

## 范围

- `requirement-refinement-service.ts`：意图优先级与入口归一化。
- `deliverable-registry.ts`：新增仅供模型入口使用的 canonicalization；保留现有严格 resolver。
- `control-planning.ts`：初始规划错误脱敏。
- 对应 Requirement、Registry、API 和前端澄清测试。

不修改 Planner、Portfolio Resolver、Plan Compiler、Skill Runtime、Contribution、报告生成、数据库 Schema 或历史 Artifact。

## 验收矩阵

| 输入 | 预期结果 |
| --- | --- |
| `我想做一个关于“宠物食品在电商应该怎么做推广的调研”` | `research_synthesis / research_strategy_report` |
| 明确比较多个品牌并要求竞品报告或建议 | `competitive_research / competitive_analysis_report` |
| 明确制定研究方案、样本或排期 | `user_research_planning / research_plan` |
| 同时要求研究方案和直接答案 | 进入 `outcome_mode` 澄清，Planner 不启动 |
| 模型使用自然语言报告标题 | 入口单次确定性归一化，不依赖第二次模型重试 |
| 已持久化合同不一致 | Planner/Execution 严格拒绝 |
| 未分类内部异常 | UI 只显示稳定中文错误，不显示内部字段名 |

## 验证与回滚

先运行 Requirement、Outcome、Registry 和 API 定向测试，再执行 TypeScript 检查，最后只用目标输入做一次真实前端验证。完整真实 smoke 不作为本修复的循环调试手段。

修复不涉及数据迁移，可通过单个提交回滚；回滚不会修改已有 Requirement、Plan 或 SEALED Artifact。
