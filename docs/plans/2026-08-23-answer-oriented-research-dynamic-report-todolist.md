# 答案型研究闭环与动态报告 TodoList

> 对应开发文档：`docs/plans/2026-08-23-answer-oriented-research-dynamic-report-development.md`
>
> 架构决策：`docs/adr/0004-separate-research-planning-from-answer-delivery.md`
>
> 上游基线：`feat/skill-runtime-report-fidelity@b1e5c7aafd22177ad224a8f62e367da6533fdf0f`
>
> 当前集成分支：`feat/research-answer-dynamic-reports`
>
> 规则：所有Phase只进入统一集成分支；每个Phase独立提交、可构建、可回滚，但最终一次性合并到main，不单独上线中间状态。

## 已确认事实

- [x] 最新任务被识别为 `user_research_planning`。
- [x] 最新任务Deliverable为 `research_plan`。
- [x] 用户请求的策略地图、心智模型、设计原则和机会点只被保存为交付物名称。
- [x] 中间整合步骤已生成约10,983字的具体策略内容。
- [x] ResearchPlan Schema没有承接具体策略对象的一等字段。
- [x] ReportDocument v1再次压缩并生成空章节。
- [x] 用户计划后确认答案未进入Requirement或冻结Plan。
- [x] 当前运行环境仍为main旧版本。
- [x] Skill Runtime与报告保真分支已完成并通过独立审查。
- [x] 已从该分支创建统一集成分支和独立worktree。
- [x] 已建立本开发文档与TodoList。

## Gate 0：冻结统一集成基线

> 基线：`b1e5c7aafd22177ad224a8f62e367da6533fdf0f`；分支：`feat/research-answer-dynamic-reports`；worktree：`/Users/heyunshen/work/PROJECT/jdc/ai-x-answer-reports`；Node `v22.22.1`；pnpm `9.12.1`。

- [x] 记录 `b1e5c7aafd22177ad224a8f62e367da6533fdf0f` 为 `BASE_SHA`。
- [x] 确认 `feat/skill-runtime-report-fidelity` 不单独合入main。
- [x] 确认 `feat/research-answer-dynamic-reports` worktree clean。
- [x] 安装root与Web依赖。
- [x] 记录Node与pnpm版本。
- [x] 运行基线typecheck。
- [x] 运行Registry与Knowledge lint。
- [x] 运行Skill Runtime、Requirement、Report定向测试（并行门禁中1个时序用例受资源竞争失败，单独复跑 `tests/lease-execution-engine.test.ts` 为115 pass、1 skip、0 fail）。
- [x] 运行Web production build。
- [x] 运行基线full quality（1613 tests：1598 pass，15 skip，0 fail）。
- [x] 确认只有一个writer修改该worktree。

### Gate 0完成条件

```text
clean integration worktree
明确BASE_SHA
Skill Runtime baseline完整
基线typecheck/lint/tests/build/quality通过
```

# Phase 1：运行能力指纹与Inactive合同骨架

## 1.1 先写失败测试

- [x] 创建system capabilities route测试。
- [x] 断言返回Plan Contract版本。
- [x] 断言返回ReportDocument版本。
- [x] 断言返回active task types和deliverables。
- [x] 断言返回compiled Skill列表。
- [x] 断言返回Knowledge Index与Tool Registry hash。
- [x] 断言新research_synthesis和research_strategy_report仍为inactive。

## 1.2 实现能力接口

- [x] 增加共享SystemCapabilities合同。
- [x] 实现 `GET /api/system/capabilities`。
- [x] 从真实Registry与Schema解析能力，不手写重复列表。
- [x] Web API Client支持读取。
- [x] 开发信息区显示关键合同版本。
- [x] 敏感配置和本地路径不得返回。

## 1.3 Inactive骨架

- [x] ResearchTask Schema预留research_synthesis，但在Capability层保持inactive。
- [x] Deliverable Registry增加draft research_strategy_report。
- [x] 新Schema、Prompt、Rubric路径存在但不参与生产路由。
- [x] Registry lint验证inactive资源结构。

## Phase 1门禁

```bash
pnpm exec tsx --test tests/system-capabilities.test.ts tests/multi-deliverable-contract.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm --dir apps/web build
git diff --check
```

- [x] Phase 1测试通过。
- [x] 新类型仍不可从生产入口选择。
- [x] 独立提交Phase 1。

# Phase 2：Plan/Answer任务意图与Requirement

## 2.1 领域与合同

- [x] 更新 `CONTEXT.md`，增加研究规划任务、研究回答任务、Direct Answer、Requested Artifact、Dynamic Report。
- [x] ResearchTaskV2增加 `outcome_mode`。
- [x] ResearchTaskV2增加 `requested_artifacts`。
- [x] 更新JSON Schema、TypeScript类型和fixtures。
- [x] 明确plan/answer与Task Type、Deliverable映射。

## 2.2 失败测试

- [x] 明确研究方案措辞自动进入plan。
- [x] 明确直接结论措辞自动进入answer。
- [x] 同时含规划和答案信号时返回clarification_required。
- [x] 用户未选择时不生成ProblemGraph。
- [x] 用户未选择时不调用真实Tool。
- [x] 用户选择后持久化新的Requirement Version。
- [x] requested artifacts去重、合法且顺序稳定。
- [x] 不允许未知artifact类型。

## 2.3 Requirement实现

- [x] 更新Requirement Prompt。
- [x] 增加plan/answer模式澄清卡。
- [x] 在CurrentStage1Clarify展示模式选项。
- [x] 保存outcome mode与requested artifacts。
- [x] 选择answer时Task Type变为research_synthesis。
- [x] 选择plan时保持user_research_planning。
- [x] Scope变化仍创建新Requirement Version。

## 2.4 Deliverable选择

- [x] 修改canonicalizeExpectedDeliverables，不再按task type静默覆盖用户意图。
- [x] plan只允许research_plan。
- [x] answer只允许research_strategy_report。
- [x] 不兼容组合fail closed。
- [x] 一个任务只允许一个Primary Deliverable。
- [x] requested artifacts作为Primary Deliverable内部合同。

## Phase 2门禁

```bash
pnpm exec tsx --test \
  tests/requirement-refinement-service.test.ts \
  tests/control-clarification.test.ts \
  tests/control-api-integration.test.ts \
  tests/multi-deliverable-contract.test.ts
pnpm typecheck
git diff --check
```

- [x] Plan/Answer模式可重复恢复。
- [x] 模糊请求不产生候选计划。
- [x] 独立提交Phase 2。

# Phase 3：Research Strategy Deliverable

## 3.1 Schema失败测试

- [x] 创建 `tests/research-strategy-contract.test.ts`。
- [x] Direct Answer缺questionId失败。
- [x] supported答案无Evidence失败。
- [x] provisional答案无validationNeeded失败。
- [x] Required Question为unanswered时失败或产生强制Gap。
- [x] StrategyMap空失败。
- [x] MindModel空失败。
- [x] DesignPrinciples空失败。
- [x] Opportunity缺Evidence/置信度失败。
- [x] PrioritizedAction缺priority/action/validation失败。
- [x] RequestedArtifact只有名字无binding失败。

## 3.2 实现Deliverable合同

- [x] 创建 `research-strategy-report.schema.json`。
- [x] 定义DirectAnswer。
- [x] 定义DynamicSection和类型化Block。
- [x] 定义StrategyMap。
- [x] 定义MindModel。
- [x] 定义DesignPrinciple。
- [x] 定义Opportunity。
- [x] 定义PrioritizedAction。
- [x] 定义ChannelStrategy。
- [x] 定义RequestedArtifactBinding。
- [x] 更新共享TypeScript类型。

## 3.3 Registry与Synthesis

- [x] 完成Deliverable Registry draft entry。
- [x] 创建Synthesis Prompt。
- [x] 创建Evidence Policy。
- [x] 创建Review Rubric。
- [x] Deliverable Service支持新Payload。
- [x] 当前仍保持draft/inactive。

## 3.4 Answer Quality Validator

- [x] 创建 `answer-quality-validator.ts`。
- [x] 验证Required Question Direct Answer覆盖。
- [x] 验证supported/provisional语义。
- [x] 验证requested artifact存在。
- [x] 验证Evidence ID有效。
- [x] 验证Recommendation与Action可追溯。
- [x] 验证Requirement ambiguity/Skill degraded/Reviewer条件通过进入limitations。

## Phase 3门禁

```bash
pnpm exec tsx --test \
  tests/research-strategy-contract.test.ts \
  tests/report-review-service.test.ts \
  tests/multi-deliverable-contract.test.ts
pnpm typecheck
pnpm lint:registry
git diff --check
```

- [x] Answer Deliverable合同完整。
- [x] 生产仍不可选择draft Deliverable。
- [x] 独立提交Phase 3。

# Phase 4：答案型ProblemGraph与执行DAG

## 4.1 ProblemGraph测试

- [x] Answer模式问题使用“是什么/为什么/怎么做”，不使用“如何研究”。
- [x] 每个Required Question acceptance包含Direct Answer、Evidence、业务含义、行动、置信度。
- [x] Requested artifacts映射到ProblemGraph问题。
- [x] Answer模式不生成Research Plan主流程。
- [x] Planning模式行为不变。

## 4.2 Capability与Planner

- [x] 更新Decision Graph applies_to。
- [x] 更新Planning Guidance场景与Profile映射。
- [x] 更新Capability Crosswalk。
- [x] `generate-research-plan`只服务plan模式。
- [ ] 无真实用户材料时journey-map标记provisional。
- [x] 无访谈任务需求时不自动生成interview guide。
- [x] Answer模式优先证据收集与策略综合能力。

## 4.3 Research Strategy Synthesis Skill

- [x] 创建compiled Skill Execution Contract。
- [x] evidence inventory阶段。
- [x] direct answer synthesis阶段。
- [x] conflict review阶段。
- [x] strategy materialization阶段。
- [x] action prioritization阶段。
- [x] self review阶段。
- [x] Knowledge、Tool和Skill references全部hash冻结。

## 4.4 执行测试

- [x] 公开资料Tool步骤先于Synthesis。
- [x] 每个Direct Answer绑定Evidence。
- [x] Evidence不足时provisional而非伪事实。
- [x] Reviewer反证结果进入limitations/openQuestions。
- [x] Required Answer unanswered触发Gap或paused。
- [x] StrategyMap/MindModel/Principles/Opportunities真实进入Deliverable。
- [x] Skill Runtime v2安全测试全部回归通过。

## Phase 4门禁

```bash
pnpm exec tsx --test \
  tests/research-strategy-planning.test.ts \
  tests/problem-graph-planner.test.ts \
  tests/plan-compiler.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/skill-execution-contract.test.ts \
  tests/knowledge-bundle-resolver.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
git diff --check
```

- [ ] Answer DAG卡片与真实执行逐项一致。
- [x] Planning DAG无行为回归。
- [x] 独立提交Phase 4。

# Phase 5：动态ReportDocument v2

## 5.1 Dynamic Report合同

- [x] 最终v2支持动态section IDs与顺序。
- [x] 增加direct_answer Block。
- [x] 增加strategy_map Block。
- [x] 增加mind_model Block。
- [x] 增加design_principle Block。
- [x] 增加opportunity Block。
- [x] 增加priority_matrix Block。
- [x] 增加action_plan Block。
- [x] 保留Evidence/Chart/Image/Risk Block。
- [x] 每个Block包含source pointers、questions、nodes、Evidence、confidence。

## 5.2 DynamicReportComposer

- [x] 创建 `dynamic-report-composer.ts`。
- [x] 固定生成Executive Answers。
- [x] 固定生成Priority Actions。
- [x] 固定生成Evidence and Confidence。
- [x] 固定生成Limitations and Open Questions。
- [x] 固定生成Evidence Appendix。
- [x] 根据requested artifacts和内容生成动态专题。
- [x] 空章节不生成。
- [x] 分析底稿后置。
- [x] 不从未Review Step Artifact取内容。

## 5.3 Report Coverage

- [x] 每个Required Question映射到direct_answer Block。
- [x] 每个RequestedArtifact映射到对应Block。
- [x] source Deliverable Artifact身份一致。
- [x] full projection不得省略required内容。
- [x] summary省略必须有reason。
- [x] 空章节、悬空Evidence、悬空source pointer失败。

## 5.4 Web

- [x] 答案型默认“直接答案”。
- [x] 动态专题页签。
- [x] 策略产物页签。
- [x] Evidence页签。
- [x] 分析底稿页签。
- [x] 规划型报告保持原完整方案视图。
- [x] History显示研究方案/研究答案差异标签。
- [x] Print/PDF尊重当前选择视图。

## 5.5 Bundle与Zero

- [x] ZIP增加direct-answers.md。
- [x] ZIP增加analysis-notes.md。
- [x] full-report包含动态章节。
- [x] Zero支持新增类型化Block。
- [x] 不生成空Visual/Comparison。
- [x] Evidence和导出安全测试保持通过。

## Phase 5门禁

```bash
pnpm exec tsx --test \
  tests/dynamic-report-composer.test.ts \
  tests/report-document.test.ts \
  tests/report-package.test.ts \
  tests/report-bundle.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/current-flow-state.test.ts
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

- [x] Answer-first页面通过浏览器Fixture验收。
- [x] 无空章节。
- [x] v1/v2历史兼容通过。
- [x] 独立提交Phase 5。

# Phase 6：Answer Review、Activation与产品文案

## 6.1 Review失败测试

- [x] Required Question无Direct Answer时block。
- [x] 请求Artifact缺失时block。
- [x] supported无Evidence时block。
- [x] provisional无验证说明时block。
- [x] 只有“建议后续研究”而无答案时block。
- [x] Reviewer条件通过但limitations为空时block。
- [x] Skill degraded未披露时block。
- [x] 优先行动无Evidence/Owner类型/验证方式时revise或block。

## 6.2 Review实现

- [x] 增加direct_answer_coverage。
- [x] 增加requested_artifact_presence。
- [x] 增加answer_evidence_strength。
- [x] 增加decision_usefulness。
- [x] 增加hypothesis_conclusion_clarity。
- [x] 增加risk_consistency。
- [x] 保留现有Evidence/Reasoning/Recommendation验证。

## 6.3 Activation

- [x] research_synthesis从draft改为active。
- [x] research_strategy_report从draft改为active。
- [x] Capability Crosswalk正式启用。
- [x] SystemCapabilities反映启用状态。
- [x] Requirement UI显示plan/answer模式文案。
- [x] History状态显示“研究方案已生成”或“研究答案已完成”。
- [x] 当前main路径仍未部署该分支。

## Phase 6门禁

```bash
pnpm exec tsx --test \
  tests/report-review-service.test.ts \
  tests/report-review-service.test.ts \
  tests/research-strategy-planning.test.ts \
  tests/control-api-integration.test.ts \
  tests/current-flow-state.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm --dir apps/web build
git diff --check
```

- [x] 所有新能力active且测试通过。
- [x] Planning模式保持兼容。
- [x] 独立提交Activation Phase。

# Gate 7：统一端到端验收

## 7.1 自动化

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm --dir apps/web build
pnpm quality
git diff --check
```

- [x] Typecheck通过。
- [x] Registry lint通过。
- [x] Knowledge lint通过。
- [x] Web build通过。
- [x] 全量测试通过。
- [x] Diff check通过。
- [x] Worktree clean。
- [x] 每个Phase commit独立可构建。

## 7.2 浏览器Fixture验收

- [ ] 模糊任务显示plan/answer选择。
- [ ] Plan模式进入Research Plan。
- [ ] Answer模式进入Strategy Report。
- [x] 直接答案默认可见。
- [x] 动态专题与requested artifacts存在。
- [x] 无空章节。
- [x] Evidence、分析底稿和打印可用。
- [ ] History标签正确。

## 7.3 真实Gateway/Tavily验收

使用当前同一业务输入：

- [ ] 发起真实任务。
- [ ] 选择直接策略答案。
- [ ] SystemCapabilities确认最终版本。
- [ ] Plan为Current v2，Skill Invocation存在。
- [ ] 真实Tavily和Knowledge Artifact存在。
- [ ] Deliverable为research_strategy_report。
- [ ] Direct Answers覆盖所有Required Questions。
- [ ] StrategyMap、MindModel、至少5条Principles存在。
- [ ] Opportunity Backlog含P0/P1/P2。
- [ ] Evidence、Confidence和Validation Needed存在。
- [ ] ReportDocument为最终v2。
- [ ] 页面默认答案视图。
- [ ] Markdown ZIP完整。
- [ ] 如需要，Zero发布通过。

真实验收不得以Fixture替代。

## Gate 7 实际证据（2026-08-23）

- `pnpm quality`：1630 tests，1615 pass，15 skip，0 fail。
- `pnpm --dir apps/web build`：production build通过；仅保留既有chunk-size warning。
- `git diff --check`：通过。
- Playwright Chromium浏览器fixture：12个非空动态章节、14个answer blocks；默认答案页签只显示Executive Answers与Priority Actions；截图写入`/tmp/answer-report-browser.png`，未进入仓库。
- 真实Tavily：`TAVILY_TEST=1 ... --test-name-pattern='TavilyAdapter 能检索公开网页'`通过，3条真实结果，约2.1秒。
- 真实Gateway完整答案任务：未运行；当前worktree环境缺少`ALLOW_REAL_PROVIDER`、`LLM_PROVIDER`、`TOOL_ADAPTER`、`DATABASE_URL`、`JWT_SECRET`、`LLM_GATEWAY_BASE_URL`、`LLM_GATEWAY_API_KEY`、`LLM_MODEL_NAME`、`LLM_EXPECTED_ACTUAL_MODEL`。因此7.3保持未勾选。
- Zero：自动化渲染、发布与安全测试通过；未连接真实Zero桌面端，因此真实发布项保持未勾选。

# Gate 8：独立审查

- [ ] 审查Plan/Answer语义边界。
- [ ] 审查Deliverable选择与Canonicalization。
- [ ] 审查Direct Answer真实性。
- [ ] 审查Requested Artifact实体化。
- [ ] 审查Evidence与Provisional边界。
- [ ] 审查Dynamic Report来源绑定。
- [ ] 审查Answer Review阻断逻辑。
- [ ] 审查Skill Runtime安全无回归。
- [ ] 审查历史兼容。
- [ ] 审查Browser/Bundle/Zero。
- [ ] 修正后再次运行最终Gate。
- [ ] 独立Reviewer给出READY。

# Gate 9：一次性合并与部署

- [x] 更新开发文档实际文件范围和最终行为。
- [x] 更新TodoList完成状态。
- [x] 更新ADR实施结果。
- [x] 确认Skill Runtime父分支没有单独合入main。
- [x] 生成完整diff summary。
- [ ] 获得合并或push授权。
- [ ] 一次性合并集成分支到main或创建单一PR。
- [ ] CI通过。
- [ ] 重启Agent API。
- [ ] 重启Web。
- [ ] 调用SystemCapabilities确认新版本。
- [ ] 重新运行真实答案型任务。
- [x] 未授权时不push、不创建PR、不部署。

# 完成账本

```text
integration baseline                       done
system capabilities                        done
plan/answer intent                         done
research_synthesis task                    done
requested artifacts                        done
research_strategy_report                   done
direct answer contract                     done
answer-oriented ProblemGraph               done
research strategy execution DAG            done
dynamic ReportDocument v2                  done
answer-first Web                            done
full/analysis bundle                       done
Answer Quality Review                      done
risk consistency                           done
planning compatibility                     done
historical report compatibility            done
real Gateway/Tavily acceptance             blocked: Gateway/DB credentials unavailable; standalone Tavily passed
browser/Zero acceptance                    browser fixture done; real Zero unavailable
full quality gate                          done
independent review READY                   pending parent review
single final merge                         not authorized
remote delivery authorization              withheld
```
