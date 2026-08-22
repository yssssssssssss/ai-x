# Skill 可执行化、知识调用与报告保真 TodoList

> 对应开发文档：`docs/plans/2026-08-22-skill-runtime-report-fidelity-development.md`
>
> 架构决策：`docs/adr/0003-compile-skills-into-frozen-execution-dag.md`
>
> 状态：Phase 1–5 与第二轮独立审查整改已完成；自动化质量门禁和 Web build 通过；等待独立复核结论和远端交付授权。
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

- [x] 在 `tests/lease-execution-engine.test.ts` 增加 Skill `degraded` fixture。
- [x] 断言旧实现错误地产生 `completed`，确认红灯。
- [x] 断言 degraded Skill 产生稳定 Gap key。
- [x] 断言 degraded 原因进入 Skill provenance。
- [x] 在 `tests/current-flow-state.test.ts` 增加 Skill degradation gap count。
- [x] 增加 research_plan multimodal fixture 的完整视图选择测试。
- [x] 断言历史 multimodal research_plan 仍可读取 Canonical Deliverable。
- [x] 在 `tests/report-bundle.test.ts` 断言 ZIP 包含 `deliverable.json`、`full-report.md` 和 `summary-report.md`。

## 1.2 SkillOutcomePolicy

- [x] 新增统一 Skill output status 解析函数。
- [x] `succeeded` 保持普通成功。
- [x] `degraded` 在 provenance 中记录状态、限制摘要和 Artifact ID。
- [x] `degraded` 添加 `step:<stepNo>:skill:<skillId>:degraded` Gap。
- [x] 最终任务状态改为 `completed_with_gaps`。
- [x] 更新 `currentExecutionGapCount()` 识别 Skill degradation。
- [x] Stage3 Skill节点增加 warning tone 和“降级完成”文案。
- [x] 最终报告顶部显示降级原因。

## 1.3 完整报告视图

- [x] 将 `CurrentTextReport` 提取为可接受任意 Current presentation mode 的 `ResearchPlanFullView`。
- [x] `research_plan` 默认展示完整 Deliverable。
- [x] 有 ReportDocument 时增加“完整方案 / 管理摘要”切换。
- [x] 完整方案展示全部 12 个 Payload 字段。
- [x] 历史 multimodal research_plan 不需要重新执行即可使用完整视图。
- [x] 无 ReportDocument 时只展示完整视图。
- [x] 保留 Evidence、FindingGraph、Recommendations 和 Risks 展示。

## 1.4 下载包

- [x] `report-bundle.ts` 加入 `deliverable.json`。
- [x] 生成 `full-report.md`。
- [x] 生成 `summary-report.md`。
- [x] `report.md` 与完整方案保持一致，维持兼容。
- [x] 保留 ReportDocument、Review、Evidence Manifest 和 Visual Assets。
- [x] 确认导出内容不包含未脱敏原始输入。

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

- [x] Phase 1 定向测试通过。
- [x] Typecheck 通过。
- [x] Web build 通过。
- [x] `git diff --check` 通过。
- [x] 浏览器确认历史宠物任务完整方案可见。
- [x] 独立提交 Phase 1。

# Phase 2：Requirement 最终化

## 2.1 失败测试

- [x] 增加存在未回答 `clarification_questions` 时禁止生成候选计划的测试。
- [x] 增加已回答问题不会重复出现的测试。
- [x] 增加地域范围“包含海外”进入 Requirement Version 的测试。
- [x] 增加范围变化生成新 Requirement 和新 Plan Version 的测试。
- [x] 增加 Stage2 不再提交 ResearchTaskV2 clarification questions 的测试。
- [x] 证明旧实现会忽略 confirmation gate 内容，确认红灯。

## 2.2 Requirement Service

- [x] `needsClarification()` 同时检查 blocking ambiguity 和 clarification questions。
- [x] Clarification 回答写入 task scope、constraints、target audience、success criteria 或 assumptions。
- [x] 已解决问题从下一 Requirement Version 中移除。
- [x] 相同 key 的已回答问题不得重复生成。
- [x] Requirement Version 保留答案和选择方向的 provenance。
- [x] Requirement 未最终化时 Planner 不运行。

## 2.3 Confirmation 语义

- [x] `Stage2Plan` 不再 fallback 到 `clarification_questions`。
- [x] `TaskWorkflow.confirm()` 不再把 Requirement 问题当作确认 gate。
- [x] Confirmation 只处理计划接受、审批和 pending inputs。
- [x] 范围变化走 revise Requirement + replan，不修改冻结计划。
- [x] API 对旧客户端提交的多余 confirmation answers 给出明确冲突错误。
- [x] 后端 `confirm()` 拒绝仍含未解决 clarification questions 的 ResearchTaskV2。

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

- [x] Phase 2 定向测试通过。
- [x] “覆盖海外市场”出现在新 Requirement 和新 Plan 中。
- [x] 旧计划保持不可变。
- [x] `git diff --check` 通过。
- [x] 独立提交 Phase 2。

# Phase 3：Knowledge 资源绑定

## 3.1 合同失败测试

- [x] 创建 `tests/skill-execution-contract.test.ts`。
- [x] compiled Skill 缺 execution contract 时失败。
- [x] legacy Skill 携带 execution contract 时失败。
- [x] Skill ID 与合同 ID 不一致时失败。
- [x] 合同缺 output stage 时失败。
- [x] 合同阶段依赖成环时失败。
- [x] 合同声明 Registry 外 Tool 时失败。
- [x] 合同声明未知 Knowledge ID 时失败。
- [x] 合同 resource 状态不允许时失败。

## 3.2 Registry 与 Loader

- [x] 扩展 `SkillRegistryEntry.execution_mode`。
- [x] 扩展 `SkillRegistryEntry.execution_contract`。
- [x] 更新 Registry key allowlist。
- [x] 更新 KB indexer 保留两个字段。
- [x] 更新 KB build 保留两个字段。
- [x] 更新 Registry lint。
- [x] `SkillLoader` 增加合同加载、Schema校验和Hash计算。
- [x] 未迁移Skill默认 `legacy_single_call`。

## 3.3 Knowledge Bundle 失败测试

- [x] 创建 `tests/knowledge-bundle-resolver.test.ts`。
- [x] 冻结 ID 和当前索引一致时成功。
- [x] source path 漂移时失败。
- [x] content hash 漂移时失败。
- [x] deprecated资源被拒绝。
- [x] required资源缺失时失败。
- [x] optional资源缺失时产生Gap。
- [x] Bundle与Task/Plan/Attempt绑定。
- [x] Artifact字节和数据库hash一致。
- [x] 任意绝对路径和目录逃逸被拒绝。
- [x] Execution Contract 路径逐组件拒绝 symlink，并拒绝非普通文件。

## 3.4 Knowledge Bundle 实现

- [x] 创建 `schemas/knowledge-bundle.schema.json`。
- [x] 创建 `knowledge-bundle-resolver.ts`。
- [x] 只通过 `loadRuntimeKnowledgeIndex()` 和 `getEntry()` 读取。
- [x] 验证 ID、status、source path 和 content hash。
- [x] 写 `knowledge_output / knowledge-bundle-v1` Artifact。
- [x] 生成 `knowledge_excerpt` Evidence Entry。
- [x] 将Bundle作为后续步骤输入Artifact。
- [x] draft资源状态进入Provenance和运行说明。

## 3.5 generate-research-plan 资源

- [x] 创建 `schemas/skill-execution-contract.schema.json`。
- [x] 创建 `orchestrator/skill-executions/generate-research-plan.yaml` 初版资源声明。
- [x] 固定 `standard_requirement_elicitation`。
- [x] 固定 `standard_research_project_workflow`。
- [x] 固定 `standard_sampling`。
- [x] 绑定Skill三个references模板。
- [x] 规划阶段选择最多2篇场景打法。
- [x] 规划阶段选择2–3篇采集方法。
- [x] 规划阶段选择3–5篇分析方法。
- [x] 可选选择1个理论模型。
- [x] 将资源ID和hash冻结到Plan。

## 3.6 Knowledge Actor

- [x] `CurrentPlanStep.actor_type` 增加 `knowledge`。
- [x] Current plan schema增加 `knowledge`。
- [x] Engine支持Knowledge步骤。
- [x] Step artifact kind增加 `knowledge_output`。
- [x] Stage3增加Knowledge视觉标签。
- [x] Knowledge失败使用开发文档冻结语义。

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

- [x] Phase 3 定向测试通过。
- [x] 真实 `generate-research-plan` 上下文包含知识Bundle。
- [x] Skill不再错误声称无法访问Wiki。
- [x] `git diff --check` 通过。
- [x] 独立提交 Phase 3。

# Phase 4：Skill 多阶段编译

## 4.1 CurrentExecutionPlan v2 测试

- [x] Plan v1 无新字段时继续通过。
- [x] Plan v2 必须声明 `skill_invocations`。
- [x] invocation step numbers 必须存在且唯一。
- [x] step skill invocation ID 必须有效。
- [x] skill stage ID 必须属于合同。
- [x] contract hash 必须一致。
- [x] Contract依赖与Plan依赖不一致时失败。
- [x] Skill Tool不在Registry声明时失败。
- [x] 未声明步骤挂到Invocation时失败。

## 4.2 Contract 与类型

- [x] 增加 `execution_contract_version`。
- [x] 增加 `CurrentSkillInvocation`。
- [x] Step增加 `skill_invocation_id`。
- [x] Step增加 `skill_stage_id`。
- [x] Plan schema支持v1/v2兼容。
- [x] API返回v2字段。

## 4.3 SkillPlanCompiler

- [x] 创建 `skill-execution-contract.ts`。
- [x] 创建 `skill-plan-compiler.ts`。
- [x] 加载并校验合同。
- [x] 校验Requirement前置条件。
- [x] 冻结Knowledge引用。
- [x] 校验Tool eligibility。
- [x] 将stage ID映射为step number。
- [x] 转换依赖和input bindings。
- [x] 生成Skill Invocation。
- [x] 将结果交给现有PlanCompiler再次校验。
- [x] 不新增第二套调度器。

## 4.4 generate-research-plan 阶段

- [x] `load-standards` Knowledge阶段。
- [x] `external-context` Tool阶段。
- [x] `align-brief` LLM阶段。
- [x] `select-methods` LLM阶段。
- [x] `design-sampling-and-schedule` LLM阶段。
- [x] `compose-plan` Skill阶段。
- [x] `self-review` Reviewer阶段。
- [x] 冻结最终output stage和pointer。

## 4.5 Runtime 收敛

- [x] `LeaseExecutionEngine`执行编译后的普通步骤。
- [x] `SkillActorRunner`改为统一Skill Runtime Adapter或删除未使用路径。
- [x] 两套Runner不再重复Prompt、Schema和status逻辑。
- [x] Legacy SkillActorRunner 将 degraded 通过 StepArtifact 传播为 Gap 与 `completed_with_gaps`。
- [x] Retry恢复到具体stage。
- [x] Invocation/stage ID 保留在冻结 Plan；Artifact 与 Receipt 通过既有 `planVersionId + stepNo` 关联，不宣称在其 payload 中重复写入这两个 ID。
- [x] Dynamic Tool 输入仅通过冻结 binding 或合同声明的 `frozen_input_fields` 产生。
- [x] `resource_gaps` 进入 Runtime Gap、最终状态和 Web gapCount。

## 4.6 Web

- [x] 候选卡按Skill Invocation分组。
- [x] 显示总步骤、Skill数量、Skill stages和Tool calls。
- [x] Legacy Skill显示“单次Skill生成”。
- [x] 执行图按Invocation分组。
- [x] Knowledge、Tool、LLM、Skill、Reviewer视觉语义明确。
- [x] 系统后处理节点与用户确认DAG分区展示。

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

- [x] 卡片阶段与执行记录逐项一致。
- [x] `generate-research-plan` 按7阶段执行。
- [x] Legacy Skill保持兼容。
- [x] `git diff --check` 通过。
- [x] 独立提交 Phase 4。

# Phase 5：ReportDocument v2 与投影保真

## 5.1 失败测试

- [x] 创建 `tests/research-plan-projection.test.ts`。
- [x] 断言12个ResearchPlan必填字段均有source pointer。
- [x] full投影遗漏任意required字段时失败。
- [x] summary投影遗漏字段但无reason时失败。
- [x] 空章节不得进入目录。
- [x] 无视觉资产不得标为multimodal。
- [x] v1和v2 ReportDocument均可读取。
- [x] 历史v1报告仍可渲染。
- [x] ZIP full和summary内容明确不同且canonical完整。

## 5.2 ReportProjection Module

- [x] 创建 `report-projection.ts`。
- [x] ResearchPlanProjection 集中实现于 `report-projection.ts`（未另建重复模块）。
- [x] 定义Projection Adapter Interface。
- [x] 将ResearchPlan 12字段映射到冻结章节。
- [x] 保留FindingGraph、Recommendations、Risks和Evidence章节。
- [x] 生成covered/omitted pointers。
- [x] full模式禁止省略required字段。

## 5.3 ReportDocument v2

- [x] 更新ReportDocument Schema支持v2。
- [x] Block增加source pointers和source node IDs。
- [x] Document增加sourceDeliverableArtifactId。
- [x] 增加projectionMode。
- [x] 增加coveredPointers。
- [x] 增加omittedPointers及reason。
- [x] Reader支持v1/v2。
- [x] Web parser支持v1/v2。
- [x] Bundle支持v1/v2。

## 5.4 Projection Coverage Gate

- [x] 从Deliverable Payload Schema读取required字段。
- [x] 验证full覆盖全部required字段。
- [x] 验证summary遗漏全部有reason。
- [x] 验证source pointer存在。
- [x] 验证Finding、Evidence和Asset引用。
- [x] Gate在Task completed之前运行。
- [x] Gate失败进入paused，不封装Report Package。

## 5.5 Web 与导出

- [x] v2章节和Block正确展示。
- [x] 空Visual/Comparison不进入目录。
- [x] 完整视图默认。
- [x] 摘要明确显示“管理摘要”。
- [x] 打印动作针对当前选择视图。
- [x] ZIP包含完整与摘要双版本。

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

- [x] ResearchPlan 12字段全部通过覆盖门禁。
- [x] 无空章节。
- [x] v1/v2兼容通过。
- [x] `git diff --check` 通过。
- [x] 独立提交 Phase 5。

# Gate 6：真实端到端验收

- [ ] 使用真实Gateway和真实Tavily创建研究规划任务。
- [ ] 在该真实新建任务中验证 Requirement 不完整时停在澄清。
- [ ] 在该真实新建任务中输入海外市场并验证 Requirement 与 Plan。
- [ ] 在该真实新建任务中查看 compiled Skill 卡片及 7 个内部阶段。
- [ ] 在该真实新建任务中选择并确认计划。
- [ ] 在该真实新建任务中执行完成。
- [ ] 在该真实新建任务中对比 Plan 步骤和 Execution 步骤一一对应。
- [ ] 在该真实新建任务中验证 Knowledge Bundle Artifact 及 hash。
- [ ] 在该真实新建任务中验证 Tool Receipt。
- [ ] 在该真实新建任务中验证 Skill stage provenance。
- [x] 使用生产构建 + 已封存生产报告 Artifact + mock API 验证完整方案默认可见。
- [x] 使用生产构建 + 已封存生产报告 Artifact + mock API 验证管理摘要可切换。
- [x] 使用自动化测试验证下载包完整。
- [x] 使用自动化测试模拟 optional knowledge 缺失并验证 `completed_with_gaps`。
- [x] 使用自动化测试模拟 required knowledge 缺失并验证 `paused`。
- [x] 使用自动化测试验证没有敏感路径、Token 或原始 Prompt 泄露。

> 浏览器验收使用生产构建、真实已封存报告 Artifact 与本地 mock API；未把它记作“新建真实 Gateway/Tavily 任务”的替代证据，以避免外部配额消耗。

# Gate 7：全量验证

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
- [x] `git diff --check`通过。
- [x] 没有生成文件或敏感数据误入diff。
- [x] 每个Phase commit独立可构建。

# Gate 8：独立审查

- [x] 审查Skill合同与SKILL.md漂移风险。
- [x] 审查Knowledge路径与目录逃逸。
- [x] 审查Tool白名单、预算和审批。
- [x] 审查Plan/Card/Execution一致性。
- [x] 审查degraded与gap语义。
- [x] 审查Requirement答案传播。
- [x] 审查Report字段覆盖。
- [x] 审查v1/v2兼容。
- [x] 审查Artifact不可变性。
- [x] 审查日志、错误和下载包脱敏。
- [x] 审查改动后补跑一次最终Gate。
- [ ] 由独立 reviewer 确认第二轮整改并关闭 Gate 8。

### 第二轮审查整改

- [x] Execution Contract 路径执行词法/realpath/lstat containment，并拒绝 symlink 与非普通文件。
- [x] 编译阶段严格复验 input、input bindings、acceptance、Knowledge query membership；Tool 动态输入仅限合同声明字段。
- [x] `resource_gaps` 进入 Runtime Gap、Web gapCount 与 `completed_with_gaps`。
- [x] v2 Requirement 带未解决 clarification 时禁止确认；无 Plan confirmation contract 时拒绝任意 confirmation answers。
- [x] Legacy SkillActorRunner 的 degraded 状态通过 StepArtifact 传播到 Orchestrator Gap 和最终状态。
- [x] `researchPlanRequiredPointers()` 使用配置根，而非进程 cwd。
- [x] 修正 Artifact/Receipt 不直接保存 invocation/stage ID 的文档表述。

> 第一轮审查的 3 个 Blocker、3 个 High 和 3 个 Medium 已整改；第二轮复审的 2 个 High 和 3 个 Medium 已完成代码整改。复审定向命令：389 tests，388 pass，1 skip，0 fail；最终 `pnpm quality`：1613 tests，1598 pass，15 skip，0 fail；Web production build 通过（仅保留既有大 chunk 警告）；浏览器回归确认仅存在冻结 `resource_gaps` 时页面显示“部分完成 · 1 个数据缺口”。在新的独立复核给出通过结论前，Gate 8 保持未关闭。

# Gate 9：交付

- [x] 更新开发文档中的实际文件范围和最终合同。
- [x] 更新TodoList完成状态。
- [x] 更新ADR实施结果和兼容边界。
- [x] 生成最终diff summary。
- [x] 明确未处理的Legacy Skill清单。
- [ ] 明确远端提交、push和PR是否获授权。
- [x] 未获授权时不push、不创建PR。

# 完成账本

```text
truthful skill status             done
requirement finalized before plan done
knowledge contract                done
knowledge resolver                done
knowledge artifact provenance     done
skill execution contract          done
skill plan compiler               done
current execution plan v2         done
compiled generate-research-plan   done
card/execution parity             done
canonical deliverable full view   done
full/summary export               done
report document v2                done
projection coverage gate          done
legacy compatibility              done
targeted tests                    done
full quality gate                 done (1613 tests; 1598 pass, 15 skip)
real runtime acceptance           not rerun (external quota); browser + sealed artifacts passed
independent review                pending acceptance after second review corrections
docs synchronized                 done
remote delivery authorization     not authorized
```
