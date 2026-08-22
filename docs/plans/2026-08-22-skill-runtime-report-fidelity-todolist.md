# Skill 可执行化、知识调用与报告保真 TodoList

> 对应开发文档：`docs/plans/2026-08-22-skill-runtime-report-fidelity-development.md`
>
> 架构决策：`docs/adr/0003-compile-skills-into-frozen-execution-dag.md`
>
> 状态：设计文档已建立，业务代码尚未开始实现。
>
> 规则：按 Gate 顺序执行。每个 Phase 独立提交、可构建、可回滚；当前工作区存在其他未提交改动，不在原 checkout 直接实现。

## 已确认事实

- [x] 已定位最近完成任务的真实执行记录。
- [x] 已确认选中 `depth` 方案的 8 个顶层步骤全部执行。
- [x] 已确认唯一真实 Skill 为 `generate-research-plan`。
- [x] 已确认当前 Skill Runner 是单次结构化 LLM 调用。
- [x] 已确认 Skill 输出为 `status: degraded`，但任务被记为 `completed`。
- [x] 已确认当前 Skill 无 Knowledge Resolver 或内部 Tool 调用接口。
- [x] 已确认用户确认答案没有进入执行步骤。
- [x] 已确认 Canonical Deliverable 保留 12 个 ResearchPlan 字段。
- [x] 已确认 ReportDocument 未展示其中 8 个核心字段。
- [x] 已确认无视觉资产的任务仍被标为 `multimodal`。
- [x] 已确认页面与 Markdown ZIP 都消费压缩后的 ReportDocument。
- [x] 已建立开发方案和 ADR。

## Gate 0：冻结开发基线

> 基线：`fa278736f6d5de43084c4f36b936b2c52e6b3bb1`；分支：`feat/skill-runtime-report-fidelity`；worktree：`/Users/heyunshen/work/PROJECT/jdc/ai-x-skill-runtime`；Node `v22.22.1`；pnpm `9.12.1`。

- [x] 运行 `git status --short --branch -uall`，保存完整工作区清单。
- [x] 将当前未提交改动交由用户决定提交、保留或隔离。
- [x] 从明确的 `BASE_SHA` 创建 `feat/skill-runtime-report-fidelity`。
- [x] 为实现创建独立 worktree。
- [x] 确认 worktree clean。
- [x] 确认只有一个 writer 修改该 worktree。
- [x] 记录 Node 与 pnpm 版本。
- [x] 运行基线 `pnpm typecheck`。
- [x] 运行基线 `pnpm lint:registry`。
- [x] 运行基线 `pnpm lint:knowledge`。
- [x] 运行基线报告、计划和执行测试（271 tests：270 pass，1 skip，0 fail）。
- [x] 运行基线 Web production build。

### Gate 0 完成条件

```text
clean isolated worktree
明确 BASE_SHA
基线 typecheck 通过
Registry/Knowledge lint 通过
相关测试通过
Web build 通过
```

# Phase 1：状态诚实与完整方案恢复

## 1.1 失败测试

- [ ] 在 `tests/lease-execution-engine.test.ts` 增加 Skill `degraded` fixture。
- [ ] 断言旧实现错误地产生 `completed`，确认红灯。
- [ ] 断言 degraded Skill 产生稳定 Gap key。
- [ ] 断言 degraded 原因进入 Skill provenance。
- [ ] 在 `tests/current-flow-state.test.ts` 增加 Skill degradation gap count。
- [ ] 增加 research_plan multimodal fixture 的完整视图选择测试。
- [ ] 断言历史 multimodal research_plan 仍可读取 Canonical Deliverable。
- [ ] 在 `tests/report-bundle.test.ts` 断言 ZIP 包含 `deliverable.json`、`full-report.md` 和 `summary-report.md`。

## 1.2 SkillOutcomePolicy

- [ ] 新增统一 Skill output status 解析函数。
- [ ] `succeeded` 保持普通成功。
- [ ] `degraded` 在 provenance 中记录状态、限制摘要和 Artifact ID。
- [ ] `degraded` 添加 `step:<stepNo>:skill:<skillId>:degraded` Gap。
- [ ] 最终任务状态改为 `completed_with_gaps`。
- [ ] 更新 `currentExecutionGapCount()` 识别 Skill degradation。
- [ ] Stage3 Skill节点增加 warning tone 和“降级完成”文案。
- [ ] 最终报告顶部显示降级原因。

## 1.3 完整报告视图

- [ ] 将 `CurrentTextReport` 提取为可接受任意 Current presentation mode 的 `ResearchPlanFullView`。
- [ ] `research_plan` 默认展示完整 Deliverable。
- [ ] 有 ReportDocument 时增加“完整方案 / 管理摘要”切换。
- [ ] 完整方案展示全部 12 个 Payload 字段。
- [ ] 历史 multimodal research_plan 不需要重新执行即可使用完整视图。
- [ ] 无 ReportDocument 时只展示完整视图。
- [ ] 保留 Evidence、FindingGraph、Recommendations 和 Risks 展示。

## 1.4 下载包

- [ ] `report-bundle.ts` 加入 `deliverable.json`。
- [ ] 生成 `full-report.md`。
- [ ] 生成 `summary-report.md`。
- [ ] `report.md` 与完整方案保持一致，维持兼容。
- [ ] 保留 ReportDocument、Review、Evidence Manifest 和 Visual Assets。
- [ ] 确认导出内容不包含未脱敏原始输入。

## Phase 1 门禁

```bash
pnpm exec tsx --test \
  tests/lease-execution-engine.test.ts \
  tests/current-flow-state.test.ts \
  tests/report-bundle.test.ts
pnpm typecheck
pnpm --dir apps/web build
pnpm exec tsx --test tests/task-history-ui.test.ts
git diff --check
```

- [ ] Phase 1 定向测试通过。
- [ ] Typecheck 通过。
- [ ] Web build 通过。
- [ ] `git diff --check` 通过。
- [ ] 浏览器确认历史宠物任务完整方案可见。
- [ ] 独立提交 Phase 1。

# Phase 2：Requirement 最终化

## 2.1 失败测试

- [ ] 增加存在未回答 `clarification_questions` 时禁止生成候选计划的测试。
- [ ] 增加已回答问题不会重复出现的测试。
- [ ] 增加地域范围“包含海外”进入 Requirement Version 的测试。
- [ ] 增加范围变化生成新 Requirement 和新 Plan Version 的测试。
- [ ] 增加 Stage2 不再提交 ResearchTaskV2 clarification questions 的测试。
- [ ] 证明旧实现会忽略 confirmation gate 内容，确认红灯。

## 2.2 Requirement Service

- [ ] `needsClarification()` 同时检查 blocking ambiguity 和 clarification questions。
- [ ] Clarification 回答写入 task scope、constraints、target audience、success criteria 或 assumptions。
- [ ] 已解决问题从下一 Requirement Version 中移除。
- [ ] 相同 key 的已回答问题不得重复生成。
- [ ] Requirement Version 保留答案和选择方向的 provenance。
- [ ] Requirement 未最终化时 Planner 不运行。

## 2.3 Confirmation 语义

- [ ] `Stage2Plan` 不再 fallback 到 `clarification_questions`。
- [ ] `TaskWorkflow.confirm()` 不再把 Requirement 问题当作确认 gate。
- [ ] Confirmation 只处理计划接受、审批和 pending inputs。
- [ ] 范围变化走 revise Requirement + replan，不修改冻结计划。
- [ ] API 对旧客户端提交的多余 confirmation answers 给出明确冲突错误。

## Phase 2 门禁

```bash
pnpm exec tsx --test \
  tests/requirement-refinement-service.test.ts \
  tests/control-clarification.test.ts \
  tests/control-api-integration.test.ts \
  tests/current-flow-state.test.ts
pnpm typecheck
git diff --check
```

- [ ] Phase 2 定向测试通过。
- [ ] “覆盖海外市场”出现在新 Requirement 和新 Plan 中。
- [ ] 旧计划保持不可变。
- [ ] `git diff --check` 通过。
- [ ] 独立提交 Phase 2。

# Phase 3：Knowledge 资源绑定

## 3.1 合同失败测试

- [ ] 创建 `tests/skill-execution-contract.test.ts`。
- [ ] compiled Skill 缺 execution contract 时失败。
- [ ] legacy Skill 携带 execution contract 时失败。
- [ ] Skill ID 与合同 ID 不一致时失败。
- [ ] 合同缺 output stage 时失败。
- [ ] 合同阶段依赖成环时失败。
- [ ] 合同声明 Registry 外 Tool 时失败。
- [ ] 合同声明未知 Knowledge ID 时失败。
- [ ] 合同 resource 状态不允许时失败。

## 3.2 Registry 与 Loader

- [ ] 扩展 `SkillRegistryEntry.execution_mode`。
- [ ] 扩展 `SkillRegistryEntry.execution_contract`。
- [ ] 更新 Registry key allowlist。
- [ ] 更新 KB indexer 保留两个字段。
- [ ] 更新 KB build 保留两个字段。
- [ ] 更新 Registry lint。
- [ ] `SkillLoader` 增加合同加载、Schema校验和Hash计算。
- [ ] 未迁移Skill默认 `legacy_single_call`。

## 3.3 Knowledge Bundle 失败测试

- [ ] 创建 `tests/knowledge-bundle-resolver.test.ts`。
- [ ] 冻结 ID 和当前索引一致时成功。
- [ ] source path 漂移时失败。
- [ ] content hash 漂移时失败。
- [ ] deprecated资源被拒绝。
- [ ] required资源缺失时失败。
- [ ] optional资源缺失时产生Gap。
- [ ] Bundle与Task/Plan/Attempt绑定。
- [ ] Artifact字节和数据库hash一致。
- [ ] 任意绝对路径和目录逃逸被拒绝。

## 3.4 Knowledge Bundle 实现

- [ ] 创建 `schemas/knowledge-bundle.schema.json`。
- [ ] 创建 `knowledge-bundle-resolver.ts`。
- [ ] 只通过 `loadRuntimeKnowledgeIndex()` 和 `getEntry()` 读取。
- [ ] 验证 ID、status、source path 和 content hash。
- [ ] 写 `knowledge_output / knowledge-bundle-v1` Artifact。
- [ ] 生成 `knowledge_excerpt` Evidence Entry。
- [ ] 将Bundle作为后续步骤输入Artifact。
- [ ] draft资源状态进入Provenance和运行说明。

## 3.5 generate-research-plan 资源

- [ ] 创建 `schemas/skill-execution-contract.schema.json`。
- [ ] 创建 `orchestrator/skill-executions/generate-research-plan.yaml` 初版资源声明。
- [ ] 固定 `standard_requirement_elicitation`。
- [ ] 固定 `standard_research_project_workflow`。
- [ ] 固定 `standard_sampling`。
- [ ] 绑定Skill三个references模板。
- [ ] 规划阶段选择最多2篇场景打法。
- [ ] 规划阶段选择2–3篇采集方法。
- [ ] 规划阶段选择3–5篇分析方法。
- [ ] 可选选择1个理论模型。
- [ ] 将资源ID和hash冻结到Plan。

## 3.6 Knowledge Actor

- [ ] `CurrentPlanStep.actor_type` 增加 `knowledge`。
- [ ] Current plan schema增加 `knowledge`。
- [ ] Engine支持Knowledge步骤。
- [ ] Step artifact kind增加 `knowledge_output`。
- [ ] Stage3增加Knowledge视觉标签。
- [ ] Knowledge失败使用开发文档冻结语义。

## Phase 3 门禁

```bash
pnpm lint:registry
pnpm lint:knowledge
pnpm exec tsx --test \
  tests/skill-execution-contract.test.ts \
  tests/knowledge-bundle-resolver.test.ts \
  tests/plan-compiler.test.ts \
  tests/lease-execution-engine.test.ts
pnpm typecheck
git diff --check
```

- [ ] Phase 3 定向测试通过。
- [ ] 真实 `generate-research-plan` 上下文包含知识Bundle。
- [ ] Skill不再错误声称无法访问Wiki。
- [ ] `git diff --check` 通过。
- [ ] 独立提交 Phase 3。

# Phase 4：Skill 多阶段编译

## 4.1 CurrentExecutionPlan v2 测试

- [ ] Plan v1 无新字段时继续通过。
- [ ] Plan v2 必须声明 `skill_invocations`。
- [ ] invocation step numbers 必须存在且唯一。
- [ ] step skill invocation ID 必须有效。
- [ ] skill stage ID 必须属于合同。
- [ ] contract hash 必须一致。
- [ ] Contract依赖与Plan依赖不一致时失败。
- [ ] Skill Tool不在Registry声明时失败。
- [ ] 未声明步骤挂到Invocation时失败。

## 4.2 Contract 与类型

- [ ] 增加 `execution_contract_version`。
- [ ] 增加 `CurrentSkillInvocation`。
- [ ] Step增加 `skill_invocation_id`。
- [ ] Step增加 `skill_stage_id`。
- [ ] Plan schema支持v1/v2兼容。
- [ ] API返回v2字段。

## 4.3 SkillPlanCompiler

- [ ] 创建 `skill-execution-contract.ts`。
- [ ] 创建 `skill-plan-compiler.ts`。
- [ ] 加载并校验合同。
- [ ] 校验Requirement前置条件。
- [ ] 冻结Knowledge引用。
- [ ] 校验Tool eligibility。
- [ ] 将stage ID映射为step number。
- [ ] 转换依赖和input bindings。
- [ ] 生成Skill Invocation。
- [ ] 将结果交给现有PlanCompiler再次校验。
- [ ] 不新增第二套调度器。

## 4.4 generate-research-plan 阶段

- [ ] `load-standards` Knowledge阶段。
- [ ] `external-context` Tool阶段。
- [ ] `align-brief` LLM阶段。
- [ ] `select-methods` LLM阶段。
- [ ] `design-sampling-and-schedule` LLM阶段。
- [ ] `compose-plan` Skill阶段。
- [ ] `self-review` Reviewer阶段。
- [ ] 冻结最终output stage和pointer。

## 4.5 Runtime 收敛

- [ ] `LeaseExecutionEngine`执行编译后的普通步骤。
- [ ] `SkillActorRunner`改为统一Skill Runtime Adapter或删除未使用路径。
- [ ] 两套Runner不再重复Prompt、Schema和status逻辑。
- [ ] Retry恢复到具体stage。
- [ ] Artifact和Receipt记录Skill Invocation与stage ID。
- [ ] Dynamic Tool输入仅通过冻结binding产生。

## 4.6 Web

- [ ] 候选卡按Skill Invocation分组。
- [ ] 显示总步骤、Skill数量、Skill stages和Tool calls。
- [ ] Legacy Skill显示“单次Skill生成”。
- [ ] 执行图按Invocation分组。
- [ ] Knowledge、Tool、LLM、Skill、Reviewer视觉语义明确。
- [ ] 系统后处理节点与用户确认DAG分区展示。

## Phase 4 门禁

```bash
pnpm exec tsx --test \
  tests/skill-execution-contract.test.ts \
  tests/plan-compiler.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/control-api-integration.test.ts
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

- [ ] 卡片阶段与执行记录逐项一致。
- [ ] `generate-research-plan` 按7阶段执行。
- [ ] Legacy Skill保持兼容。
- [ ] `git diff --check` 通过。
- [ ] 独立提交 Phase 4。

# Phase 5：ReportDocument v2 与投影保真

## 5.1 失败测试

- [ ] 创建 `tests/research-plan-projection.test.ts`。
- [ ] 断言12个ResearchPlan必填字段均有source pointer。
- [ ] full投影遗漏任意required字段时失败。
- [ ] summary投影遗漏字段但无reason时失败。
- [ ] 空章节不得进入目录。
- [ ] 无视觉资产不得标为multimodal。
- [ ] v1和v2 ReportDocument均可读取。
- [ ] 历史v1报告仍可渲染。
- [ ] ZIP full和summary内容明确不同且canonical完整。

## 5.2 ReportProjection Module

- [ ] 创建 `report-projection.ts`。
- [ ] 创建 `research-plan-projection.ts`。
- [ ] 定义Projection Adapter Interface。
- [ ] 将ResearchPlan 12字段映射到冻结章节。
- [ ] 保留FindingGraph、Recommendations、Risks和Evidence章节。
- [ ] 生成covered/omitted pointers。
- [ ] full模式禁止省略required字段。

## 5.3 ReportDocument v2

- [ ] 更新ReportDocument Schema支持v2。
- [ ] Block增加source pointers和source node IDs。
- [ ] Document增加sourceDeliverableArtifactId。
- [ ] 增加projectionMode。
- [ ] 增加coveredPointers。
- [ ] 增加omittedPointers及reason。
- [ ] Reader支持v1/v2。
- [ ] Web parser支持v1/v2。
- [ ] Bundle支持v1/v2。

## 5.4 Projection Coverage Gate

- [ ] 从Deliverable Payload Schema读取required字段。
- [ ] 验证full覆盖全部required字段。
- [ ] 验证summary遗漏全部有reason。
- [ ] 验证source pointer存在。
- [ ] 验证Finding、Evidence和Asset引用。
- [ ] Gate在Task completed之前运行。
- [ ] Gate失败进入paused，不封装Report Package。

## 5.5 Web 与导出

- [ ] v2章节和Block正确展示。
- [ ] 空Visual/Comparison不进入目录。
- [ ] 完整视图默认。
- [ ] 摘要明确显示“管理摘要”。
- [ ] 打印动作针对当前选择视图。
- [ ] ZIP包含完整与摘要双版本。

## Phase 5 门禁

```bash
pnpm exec tsx --test \
  tests/research-plan-projection.test.ts \
  tests/report-document.test.ts \
  tests/report-bundle.test.ts \
  tests/control-api-integration.test.ts
pnpm typecheck
pnpm --dir apps/web build
git diff --check
```

- [ ] ResearchPlan 12字段全部通过覆盖门禁。
- [ ] 无空章节。
- [ ] v1/v2兼容通过。
- [ ] `git diff --check` 通过。
- [ ] 独立提交 Phase 5。

# Gate 6：真实端到端验收

- [ ] 使用真实Gateway和真实Tavily创建研究规划任务。
- [ ] Requirement不完整时停在澄清。
- [ ] 输入海外市场并验证Requirement与Plan。
- [ ] 查看compiled Skill卡片及7个内部阶段。
- [ ] 选择并确认计划。
- [ ] 执行完成。
- [ ] 对比Plan步骤和Execution步骤一一对应。
- [ ] 验证Knowledge Bundle Artifact及hash。
- [ ] 验证Tool Receipt。
- [ ] 验证Skill stage provenance。
- [ ] 验证完整方案默认可见。
- [ ] 验证管理摘要可切换。
- [ ] 验证下载包完整。
- [ ] 模拟optional knowledge缺失并验证completed_with_gaps。
- [ ] 模拟required knowledge缺失并验证paused。
- [ ] 验证没有敏感路径、Token或原始Prompt泄露。

# Gate 7：全量验证

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm --dir apps/web build
pnpm quality
git diff --check
```

- [ ] Typecheck通过。
- [ ] Registry lint通过。
- [ ] Knowledge lint通过。
- [ ] Web build通过。
- [ ] 全量测试通过。
- [ ] `git diff --check`通过。
- [ ] 没有生成文件或敏感数据误入diff。
- [ ] 每个Phase commit独立可构建。

# Gate 8：独立审查

- [ ] 审查Skill合同与SKILL.md漂移风险。
- [ ] 审查Knowledge路径与目录逃逸。
- [ ] 审查Tool白名单、预算和审批。
- [ ] 审查Plan/Card/Execution一致性。
- [ ] 审查degraded与gap语义。
- [ ] 审查Requirement答案传播。
- [ ] 审查Report字段覆盖。
- [ ] 审查v1/v2兼容。
- [ ] 审查Artifact不可变性。
- [ ] 审查日志、错误和下载包脱敏。
- [ ] 审查改动后补跑一次最终Gate。

# Gate 9：交付

- [ ] 更新开发文档中的实际文件范围和最终合同。
- [ ] 更新TodoList完成状态。
- [ ] 更新ADR实施结果和兼容边界。
- [ ] 生成最终diff summary。
- [ ] 明确未处理的Legacy Skill清单。
- [ ] 明确远端提交、push和PR是否获授权。
- [ ] 未获授权时不push、不创建PR。

# 完成账本

```text
truthful skill status             pending
requirement finalized before plan pending
knowledge contract                pending
knowledge resolver                pending
knowledge artifact provenance     pending
skill execution contract          pending
skill plan compiler               pending
current execution plan v2         pending
compiled generate-research-plan   pending
card/execution parity             pending
canonical deliverable full view   pending
full/summary export               pending
report document v2                pending
projection coverage gate          pending
legacy compatibility              pending
targeted tests                    pending
full quality gate                 pending
real runtime acceptance           pending
independent review                pending
docs synchronized                 pending
remote delivery authorization     pending
```
