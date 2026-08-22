# Skill 可执行化、知识调用与报告保真开发文档

> 状态：Phase 1–5 实现完成；自动化质量门禁与浏览器验收通过；等待独立审查和远端交付授权。
>
> 架构决策：`docs/adr/0003-compile-skills-into-frozen-execution-dag.md`
>
> 执行清单：`docs/plans/2026-08-22-skill-runtime-report-fidelity-todolist.md`
>
> 本文是本次改造的设计真相源。Skill 执行语义、知识资源绑定、Tool 调用、Requirement 最终化、报告保真、兼容、测试和回滚均以本文为准。

## 1. 背景

最近完成的任务 `d7e5a29e-8896-47e2-88fa-d5a5b5ac945d` 暴露出三个相互关联的问题：

1. 任务卡片中的顶层 DAG 被真实执行，但 `Skill` 节点仅对应一次结构化 LLM 调用，没有执行 `SKILL.md` 描述的内部多阶段流程。
2. Skill 运行时只拿到 Skill 正文、步骤输入和上游输出，无法读取知识库，也不能在 Skill 内任意调用 Tool。
3. 完整 Deliverable 已生成并封存，但 `research_plan` 的 ReportDocument 投影只保留少量字段；前端又优先展示该投影，导致页面和 Markdown ZIP 显著简化。

该任务的已验证事实：

- 选中 `depth` 方案，共 8 个计划步骤。
- 真实执行为 1 个 Tool、5 个 LLM、1 个 Skill、1 个 Reviewer。
- 唯一真实 Skill 为 `generate-research-plan`。
- 8/8 计划步骤完成，9 次模型调用成功。
- 13 个 Artifact 全部 SEALED，文件大小与 SHA-256 全部匹配。
- `generate-research-plan` 输出 `status: degraded`，原因是未访问 research-wiki，只使用 supplied outputs。
- 任务仍被标记为 `completed`，没有产生 Gap。
- Canonical Deliverable 包含 12 个 research plan 字段；ReportDocument 没有展示其中 8 个。
- 用户确认“需要覆盖海外市场”，最终 Deliverable 却仍限定为中国市场，说明计划后确认答案没有进入执行输入。

## 2. 目标

### 2.1 Primary Setpoint

用户确认任务卡片后，系统执行的每一个 Skill 内部阶段、知识读取和 Tool 调用都已在卡片中冻结并可见；执行记录与卡片逐项一致；最终页面默认展示完整 Canonical Deliverable，摘要投影不得静默丢失必填内容。

### 2.2 Acceptance

- Skill 可声明机器可读的多阶段执行合同。
- `generate-research-plan` 被编译成可见、可审计、可恢复的内部步骤，而不是一个黑盒 LLM 节点。
- 卡片展示的 Skill Invocation、阶段、依赖、Knowledge 和 Tool 与实际执行记录一致。
- Knowledge 只通过当前 `knowledge-base/.index/knowledge.json` 中的逻辑 ID 读取。
- 每次知识读取记录 source path、status、content hash 和 Artifact ID。
- Tool 只能通过 Registry、Schema、预算和冻结 DAG 调用。
- `degraded` 必然产生 Gap，并使最终状态至少为 `completed_with_gaps`。
- Requirement 中影响范围、方法、样本和数据源的问题必须在生成候选计划前解决。
- Canonical Deliverable 是报告真相源；页面默认可查看完整方案。
- ReportDocument 明确是摘要或完整投影，并记录字段覆盖关系。
- ResearchPlan 的 12 个必填 Payload 字段全部可见或有显式省略原因。
- 下载包同时包含 Canonical Deliverable、完整 Markdown 和摘要 Markdown。
- 历史 Plan v1、ReportDocument v1 和已有 Artifact 继续可读。
- 不新增数据库 Migration、外部服务、运行时语言或任意 Shell 能力。

## 3. 非目标

本次不包含：

- 一次性迁移全部 Skill 到 compiled 模式。
- 解析 Markdown 标题来推断可执行流程。
- 给 LLM 任意本地文件路径读取权限。
- 给 Skill 任意 Shell、网络或无限 Tool 权限。
- 执行确认后静默增加未展示的步骤。
- 第一版支持无限“搜索—判断—再搜索”循环。
- 重写历史任务的 SEALED Artifact。
- 用新的报告摘要替代 Canonical Deliverable。
- 新建另一套任务调度器或第三套 Skill Runner。

## 4. 核心决策

### 4.1 Skill 采用“编译后执行”

`SKILL.md` 继续承担人类可读的方法、边界和质量说明；机器执行语义放入 Skill Execution Contract。规划阶段将合同编译成 `CurrentExecutionPlan v2` 的普通步骤，现有 LeaseExecutionEngine 负责执行。

### 4.2 不允许黑盒内部编排

Skill 的 Knowledge、Tool、LLM、Reviewer 阶段全部展开为计划步骤。执行时不能新增未在冻结计划中出现的 Tool 或阶段。

### 4.3 Knowledge 使用逻辑 ID 和 Hash

规划阶段从现有知识索引选定资源，冻结 ID、source path、status 和 content hash。执行阶段重新读取并验证 hash，写入 Attempt 绑定的 Knowledge Bundle Artifact。

### 4.4 Canonical Deliverable 是真相源

ReportDocument 是面向展示、打印和发布的投影，不是最终研究内容的唯一载体。完整视图直接读取 Deliverable。

### 4.5 兼容优先

没有执行合同的 Skill 保持 `legacy_single_call`。Plan v1 和 ReportDocument v1 保持可读；只有新任务生成 v2。

## 5. 总体架构

```text
SKILL.md + Skill Execution Contract
Knowledge Index + Tool Registry
                |
                v
          SkillPlanCompiler
                |
                v
      CurrentExecutionPlan v2
        |       |        |
        |       |        `-- skill_invocations
        |       `----------- frozen Knowledge refs
        `------------------- expanded stages
                |
          Task Card / HITL
                |
                v
       LeaseExecutionEngine
        |      |      |      |
 Knowledge   Tool    LLM   Reviewer/Skill
        |      |      |      |
        `------ Artifact + Receipt + Gap
                       |
                       v
             Canonical Deliverable
                 |             |
                 |             `-- Full Deliverable View
                 v
            ReportProjection
                 |
        ReportDocument v2 + coverage
                 |
          Summary / Print / Export
```

## 6. Module 与 Interface

| Module | Interface | 责任 |
|---|---|---|
| `SkillExecutionContractLoader` | skill ID -> verified contract + hash | 加载、Schema 校验和绑定合同 |
| `SkillPlanCompiler` | selected Skill + task + capability resolution -> expanded steps | 将 Skill 阶段编译成冻结 DAG |
| `KnowledgeBundleResolver` | frozen knowledge refs + binding -> verified bundle | 读取索引、验证 hash、封存知识 Artifact |
| `SkillOutcomePolicy` | Skill output + resource state -> step outcome + gaps | 统一 succeeded/degraded/block 语义 |
| `ReportProjection` | Deliverable + evidence + materials -> document + coverage | Deliverable 专用报告投影 |
| `ProjectionCoverageValidator` | payload schema + projection coverage -> pass/fail | 确定性检查报告字段覆盖 |

这些 Module 的 Interface 同时作为生产调用面和测试面。路由、页面和调度器不得复制其内部判断。

## 7. Skill Registry 变更

`SkillRegistryEntry` 新增：

```ts
execution_mode?: 'legacy_single_call' | 'compiled';
execution_contract?: string;
```

规则：

- 缺省 `execution_mode` 视为 `legacy_single_call`。
- `compiled` 必须提供 `execution_contract`。
- `legacy_single_call` 禁止提供 `execution_contract`。
- Contract 路径必须位于配置根目录内。
- KB build 必须从 Skill frontmatter 保留这两个字段。
- `unknownSkillRegistryFields()`、Registry lint 和 Current plan schema 同步更新。

首批迁移：

```text
generate-research-plan -> compiled
其余 Skill             -> legacy_single_call
```

回滚时只需将该 Skill 改回 `legacy_single_call`；执行器仍保留 v2 读取能力，已生成计划可继续执行。

## 8. Skill Execution Contract v1

新增：

```text
schemas/skill-execution-contract.schema.json
orchestrator/skill-executions/generate-research-plan.yaml
```

合同字段：

```text
version
skill_id
required_requirement_fields
resources
stages
output_stage_id
output_pointer
degraded_policy
```

### 8.1 Requirement 前置条件

`generate-research-plan` 进入候选规划前必须满足：

- `research_goal` 非空。
- `target_audience` 非空。
- `success_criteria` 非空。
- `clarification_questions` 为空。
- blocking ambiguity 为空。

不满足时返回 `awaiting_clarification`，不生成候选计划。

### 8.2 资源声明

资源项包含：

```text
resource_id
required
accepted_statuses
purpose
failure_policy
```

固定必读资源：

- `standard_requirement_elicitation`
- `standard_research_project_workflow`
- `standard_sampling`

Skill 自身引用：

- `references/brief-skeleton.md`
- `references/plan-skeleton.md`
- `references/run-notes-template.md`

动态选择资源：

- 最多 2 篇场景打法。
- 2–3 篇采集方法。
- 3–5 篇分析方法。
- 最多 1 个理论模型。

动态选择在规划阶段完成，并将最终资源 ID 和 hash 冻结进计划；执行阶段不得重新换一批知识。

### 8.3 阶段声明

每个阶段包含：

```text
stage_id
title
actor_type
actor_id
depends_on
input
input_bindings
expected_outputs
acceptance_criteria
failure_policy
```

首版 `generate-research-plan` 展开为：

1. `load-standards`：Knowledge，加载必读规范与模板。
2. `external-context`：Tool，执行已冻结的 Tavily 检索。
3. `align-brief`：LLM，结合 Requirement 和知识 Bundle 形成 Brief。
4. `select-methods`：LLM，选择方法并说明纳入、排除理由。
5. `design-sampling-and-schedule`：LLM，形成样本、配额、成本、排期和风险。
6. `compose-plan`：Skill，按领域 Payload Schema 生成研究方案。
7. `self-review`：Reviewer，依据 Skill 验收标准审校。

阶段拓扑、Tool ID 和最大调用次数在用户确认前固定。

## 9. CurrentExecutionPlan v2

新增可选顶层字段：

```ts
execution_contract_version?: 'current-execution-plan-v2';
skill_invocations?: CurrentSkillInvocation[];
```

`CurrentSkillInvocation` 保存：

```text
invocation_id
skill_id
execution_mode
contract_version
contract_hash
step_nos
```

每个编译阶段增加：

```ts
skill_invocation_id?: string;
skill_stage_id?: string;
```

`actor_type` 增加：

```text
knowledge
```

兼容规则：

- 没有 `execution_contract_version` 的计划按 v1 处理。
- v2 中每个 `skill_invocation.step_nos` 必须唯一且存在。
- 每个关联步骤必须拥有相同 invocation ID 和合同 hash。
- Skill 合同依赖必须与最终 step `depends_on` 完全一致。
- Tool 必须来自该 Skill 的 required/optional tool 声明。
- Contract 中未声明的步骤不得挂到该 Skill Invocation 下。
- 卡片读取 `skill_invocations` 分组展示；无该字段时沿用旧视图。

不需要数据库 Migration；`control_plan_versions.plan_json` 已为 JSONB，`control_execution_steps.actor_type` 为 TEXT。

## 10. SkillPlanCompiler

新增：

```text
apps/orchestrator-runtime/src/skills/skill-execution-contract.ts
apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts
```

职责：

1. 加载并校验合同。
2. 校验 Skill Registry 与合同 Skill ID 一致。
3. 校验 Requirement 前置条件。
4. 根据当前 Task 和 ProblemGraph 选择知识资源。
5. 冻结资源 ID、状态、source path 和 content hash。
6. 校验合同 Tool 在 Capability Resolution 中 eligible。
7. 将 stage ID 解析成最终 step number。
8. 将 stage 依赖转换成 `depends_on`。
9. 为每个步骤写 `skill_invocation_id` 和 `skill_stage_id`。
10. 将合同 hash 写入 `skill_invocations`。
11. 把编译后的普通步骤交给现有 PlanCompiler 做统一 DAG、Evidence、InputBinding 和 Approval 校验。

不新建第二套调度器。SkillPlanCompiler 只负责计划编译，不参与运行时执行。

## 11. KnowledgeBundleResolver

新增：

```text
apps/orchestrator-runtime/src/knowledge/knowledge-bundle-resolver.ts
schemas/knowledge-bundle.schema.json
```

### 11.1 输入

- Task、Plan、Attempt binding。
- 计划冻结的知识引用。
- Active lease。

冻结引用包含：

```text
resource_id
source_path
status
content_hash
required
failure_policy
```

### 11.2 执行

- 通过 `loadRuntimeKnowledgeIndex()` 查找 ID。
- 通过 `getEntry()` 读取正文。
- 验证 status、source path 和 content hash。
- 拒绝 deprecated、未知 ID、索引漂移和路径漂移。
- 将内容写成 Attempt 绑定的 SEALED Artifact。

### 11.3 输出 Artifact

```text
kind: knowledge_output
schemaVersion: knowledge-bundle-v1
relativePath: steps/<stepNo>-knowledge_output.json
```

内容包括：

- 每个资源 ID、标题、status、source path、content hash。
- 正文内容。
- 计划中的合同 hash。
- Task、Plan、Attempt 和 step binding。

Evidence Manifest 中生成：

```text
kind: knowledge_excerpt
evidenceClass: knowledge
```

### 11.4 失败策略

- 必需资源缺失或 hash 漂移：暂停任务，失败类型 `required_knowledge_unavailable`，要求重生成计划或终止。
- 可选资源缺失：记录 Gap，继续执行，最终为 `completed_with_gaps`。
- draft 资源允许读取，但必须在 Skill 输出运行说明和 provenance 中记录 draft 状态。

## 12. Tool 调用

### 12.1 首版策略

采用“静态拓扑、动态输入”：

- Tool ID、调用次数和拓扑在候选计划中冻结。
- Tool 查询参数可以通过前序 LLM 输出和 `input_bindings` 动态生成。
- Tool 只能通过现有 `ToolRouter` 和真实 Adapter 调用。

### 12.2 编译校验

- Tool 必须属于 Skill 的 `required_tools` 或已判 available 的 `optional_tools`。
- Tool 输入和输出必须通过 Manifest Schema。
- Tool 步骤必须出现在依赖它的 Skill 阶段之前。
- Tool Receipt、execution mode、implementation ID 和 Artifact 必须完整。
- 未在合同中声明的 Tool 调用直接失败。

### 12.3 不支持的首版行为

首版不支持无限动态循环。需要多轮检索的 Skill 必须在合同中声明固定最大轮数，并在任务卡片中显示。超出范围必须生成新 Plan Version 并重新确认。

## 13. SkillOutcomePolicy

新增统一解析逻辑，替代两个 Runner 各自处理状态。

### 13.1 succeeded

- Execution step：`succeeded`。
- Provenance：`status=succeeded`。
- 不产生 Gap。

### 13.2 degraded

- Execution step 保持 `succeeded`，因为存在合法输出。
- Provenance：`status=degraded`，保存 limitation 摘要和输出 Artifact ID。
- 添加稳定 Gap key：`step:<stepNo>:skill:<skillId>:degraded`。
- 最终任务至少为 `completed_with_gaps`。
- Stage3 节点显示警告态，而不是普通绿色完成。
- 报告顶部展示降级原因。

### 13.3 required resource failure

- Execution step：`failed`。
- Task：`paused`。
- failure kind：`required_knowledge_unavailable`。
- allowed actions：`retry`、`abort`。
- 资源 hash 漂移时 retry 不能继续使用旧计划，必须重新生成 Plan Version。

### 13.4 Runner 收敛

- `LeaseExecutionEngine.runSkill()` 使用统一 Module。
- `SkillActorRunner` 改为同一 Module 的 Adapter，或在确认无生产调用后删除。
- 不保留两套独立的 Skill 状态、Schema 和 Prompt 逻辑。

## 14. Requirement 最终化

### 14.1 新规则

`clarification_questions` 全部属于计划前 Requirement；计划确认阶段不再收集它们。

`needsClarification()` 返回 true 的条件：

- 存在 blocking ambiguity；或
- `clarification_questions.length > 0`。

Requirement LLM 接收用户答案后必须：

- 将答案写入 scope、constraints、target_audience、success_criteria 或 assumptions。
- 删除已解决问题。
- 不得用相同 key 重复追问已明确回答的问题。

### 14.2 Stage2 Confirmation

Stage2 只允许：

- 计划接受/拒绝。
- Plan 自身声明的审批项。
- `pending_inputs` 明确绑定的文本、数据或视觉输入。

不再 fallback 到 `ResearchTaskV2.clarification_questions`。

### 14.3 范围变化

如果用户在计划生成后提出改变市场、品类、场域、样本、数据源或成功标准的内容：

1. 创建 Requirement Version N+1。
2. 将任务返回 planning。
3. 生成新候选 Plan Version。
4. 用户重新选择和确认。
5. 旧计划和旧 Artifact 不修改。

## 15. 页面与任务卡片

### 15.1 候选卡

Skill 分组展示：

```text
SKILL · generate-research-plan · 7 stages
  1 知识规范装载       KNOWLEDGE
  2 外部资料检索       TOOL
  3 Brief 对齐          MODEL
  4 方法选择            MODEL
  5 样本与排期          MODEL
  6 研究方案合成        SKILL
  7 方案自检            REVIEW
```

卡片页脚分别显示：

```text
总步骤 / Skill Invocation / Skill stages / Tool calls
```

不再把 eligible Skill 数量、候选方案数量和真实执行 Skill 数量混在一起。

### 15.2 执行图

- Skill 内部阶段按 `skill_invocation_id` 分组。
- Knowledge 使用独立视觉标签。
- degraded 使用 warning tone。
- Tooltip 显示 contract hash、stage ID 和 Artifact。
- 系统追加的 Deliverable、Review、Report Composer 节点明确标为系统后处理，不混入用户确认的 Skill DAG。

### 15.3 历史计划

- v1 计划继续按普通步骤显示。
- legacy Skill 节点显示“单次 Skill 生成”。
- 不伪造历史内部阶段。

## 16. Canonical Deliverable 与完整视图

### 16.1 默认行为

`research_plan` 默认展示完整方案，直接消费 API 已返回的 Canonical Deliverable。

页面提供：

- `完整方案`：默认。
- `管理摘要`：ReportDocument 存在时可切换。

Multimodal 只描述报告是否包含真实视觉资产，不再等同于“存在 ReportDocument”。

### 16.2 历史任务恢复

历史任务已经包含完整 Deliverable，因此只修改前端选择逻辑即可恢复：

- researchQuestions
- comparisonDimensions
- sourcePlan
- executionPlan
- collectionTemplate
- analysisMethods
- deliverables
- qualityChecks

无需重新执行任务或改写 Artifact。

### 16.3 下载包

ZIP 固定包含：

```text
deliverable.json
full-report.md
summary-report.md
report-document.json
report-review.json
evidence-manifest.json
visual-assets.json
assets/
```

`report.md` 保留为兼容文件，内容与 `full-report.md` 一致。

## 17. ReportProjection 与 ReportDocument v2

### 17.1 Module

新增：

```text
apps/orchestrator-runtime/src/report/report-projection.ts
apps/orchestrator-runtime/src/report/research-plan-projection.ts
```

现有 competitive、VOC、design audit 和 accessibility 的专用投影逻辑逐步迁移为 Adapter；首批必须完成 ResearchPlanProjection，其他类型行为保持不变。

### 17.2 ReportDocument v2

每个 Block 增加：

```text
sourcePointers
sourceNodeIds
summary
```

文档增加：

```text
sourceDeliverableArtifactId
projectionMode
coveredPointers
omittedPointers
```

其中：

- `projectionMode`: `full` 或 `summary`。
- `omittedPointers` 每项必须包含 pointer 和 reason。
- full 模式不允许省略 Payload Schema required 字段。

### 17.3 ResearchPlanProjection 字段映射

| Payload | Report section |
|---|---|
| title | Cover |
| researchGoal | Background |
| scope | Scope and Method |
| competitorSampling | Sampling |
| researchQuestions | Question Analysis |
| comparisonDimensions | Comparison Framework |
| sourcePlan | Evidence Plan |
| executionPlan | Execution Roadmap |
| collectionTemplate | Collection Template |
| analysisMethods | Analysis Methods |
| deliverables | Deliverables |
| qualityChecks | Quality Assurance |

FindingGraph、recommendations、risks 和 evidence index 保持单独章节。

没有视觉资产时：

- 不生成空 Visual Evidence 章节。
- 不生成空图表章节。
- Report Package 使用 `current_text`，或在有明确摘要需求时使用无视觉的 summary document，但不能标为 multimodal。

### 17.4 ProjectionCoverageValidator

读取 Deliverable Payload Schema 的 `required` 字段，验证：

- full 投影全部被 `coveredPointers` 覆盖。
- summary 投影中的未覆盖字段全部出现在 `omittedPointers`。
- source pointer 唯一且存在。
- 空章节不进入目录。
- Evidence ID、Finding ID 和 Asset reference 全部有效。

该检查在任务进入 completed 前运行。失败进入 paused，不生成 Report Package。

不增加第二个纯 LLM Presentation Review；字段完整性由确定性规则保证，语义质量继续由现有 Deliverable Review 负责。

## 18. 兼容与版本

### 18.1 Plan

- v1：无 `execution_contract_version`，旧执行方式。
- v2：有 Skill Invocation、Knowledge 和编译阶段。
- Runtime 同时读取 v1/v2。
- 新 Planner 只为 compiled Skill 生成 v2。

### 18.2 Report

- ReportDocument v1：继续读取和渲染。
- ReportDocument v2：新任务写入。
- 历史 research_plan 可直接用 Deliverable 完整视图，不依赖重新投影。

### 18.3 Artifact

新增 kind/schema 不要求 Migration：

```text
knowledge_output / knowledge-bundle-v1
report_document / report-document-v2
```

ControlArtifactStore 已支持通用 kind 和 schemaVersion。

## 19. 安全与审计

- Knowledge 只允许索引 ID，不允许任意路径。
- 路径解析必须留在配置根和 knowledge-base 内。
- Tool 只能来自 Registry 和冻结合同。
- Tool input/output 必须经过 Schema。
- LLM 不获得 Shell、数据库或文件系统句柄。
- 所有资源、合同、Prompt、Tool和输出均保存 hash。
- Knowledge、Tool 和 Skill Artifact 绑定同一 Task、Plan、Attempt。
- 敏感内容继续经过现有 redaction policy。
- 资源或合同漂移 fail closed，不静默切换版本。

## 20. 失败语义

| 情况 | 步骤 | Task | 用户操作 |
|---|---|---|---|
| 必需知识缺失 | failed | paused | 重新生成计划 / 终止 |
| 知识 hash 漂移 | failed | paused | 重新生成计划 / 终止 |
| 可选知识缺失 | succeeded + gap | completed_with_gaps | 查看缺口 |
| Skill degraded | succeeded + gap | completed_with_gaps | 查看局限 |
| Core Tool 失败 | failed | paused | retry / abort |
| Optional Tool 失败 | skipped + gap | completed_with_gaps | 查看缺口 |
| Projection 漏必填字段 | failed | paused | 修复后重试报告生成 |
| ReportDocument v2 不可读 | report-loading-error | completed | 重取报告，不重跑研究 |

## 21. 文件范围

### 新增

```text
schemas/skill-execution-contract.schema.json
schemas/knowledge-bundle.schema.json
apps/orchestrator-runtime/src/skills/skill-execution-contract.ts
apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts
apps/orchestrator-runtime/src/knowledge/knowledge-bundle-resolver.ts
apps/orchestrator-runtime/src/report/report-projection.ts
apps/orchestrator-runtime/src/report/research-plan-projection.ts
orchestrator/skill-executions/generate-research-plan.yaml
tests/skill-execution-contract.test.ts
tests/knowledge-bundle-resolver.test.ts
tests/research-plan-projection.test.ts
```

### 修改

```text
apps/orchestrator-runtime/src/runtime/config-loader.ts
apps/orchestrator-runtime/src/runtime/skill-loader.ts
apps/orchestrator-runtime/src/knowledge/indexer.ts
apps/orchestrator-runtime/src/knowledge/build.ts
apps/orchestrator-runtime/src/planners/plan-compiler.ts
apps/orchestrator-runtime/src/planners/routed-planner.ts
apps/orchestrator-runtime/src/planners/direct-planner.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/orchestrator-runtime/src/control/step-input-resolver.ts
apps/orchestrator-runtime/src/control/requirement-refinement-service.ts
apps/orchestrator-runtime/src/control/task-workflow.ts
apps/orchestrator-runtime/src/runners/skill-runner.ts
apps/orchestrator-runtime/src/report/report-document-composer.ts
apps/orchestrator-runtime/src/report/report-composition-service.ts
apps/orchestrator-runtime/src/report/current-report-package-reader.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
packages/api-contract/research-deliverable.ts
packages/api-contract/control-workflow.ts
schemas/current-execution-plan.schema.json
schemas/report-document.schema.json
apps/web/src/current-flow-state.ts
apps/web/src/hooks/useTaskFlow.ts
apps/web/src/components/stages/CurrentStage1Clarify.tsx
apps/web/src/components/stages/Stage2Candidates.tsx
apps/web/src/components/stages/Stage2Plan.tsx
apps/web/src/components/stages/Stage3Execute.tsx
apps/web/src/components/stages/CurrentStage4Report.tsx
apps/web/src/current-report-markdown.ts
apps/web/src/reporting/report-document-view-model.ts
apps/web/src/reporting/ReportDocumentView.tsx
apps/web/src/reporting/report-bundle.ts
```

以及对应既有测试。实际实现应以每个 Phase 的最小 diff 为准，不为未来 Skill 提前建立未使用的扩展点。

## 22. 实施阶段

### Phase 1：状态诚实与完整方案恢复

- 解析 Skill envelope status。
- degraded 写 provenance 和 gap。
- 更新 gap count 和执行图警告态。
- research_plan 默认展示 Canonical Deliverable。
- 增加完整/摘要切换。
- ZIP 增加完整 Deliverable 和 full-report.md。
- 历史任务无需重跑即可恢复完整展示。

独立价值：立即解决当前任务“结果简单”和“降级被隐藏”。

### Phase 2：Requirement 最终化

- 未回答 clarification questions 时不生成候选计划。
- 回答更新 Requirement Version。
- Stage2 不再收集 Requirement 问题。
- 范围变化触发重新规划。

独立价值：新任务不再忽略用户确认内容。

### Phase 3：Knowledge 资源绑定

- 增加 Registry execution metadata。
- 增加 Contract Loader 和 Resource Resolver。
- 增加 Knowledge actor 和 Artifact。
- 单次 Skill 先消费真实 Knowledge Bundle。

独立价值：即使尚未展开多阶段，Skill 已能基于真实 Wiki 工作。

### Phase 4：Skill 多阶段编译

- 增加 CurrentExecutionPlan v2。
- SkillPlanCompiler 展开阶段。
- 统一 Skill Runtime。
- 卡片和执行图按 Skill Invocation 分组。
- `generate-research-plan` 切换 compiled。

独立价值：任务卡片与 Skill 内部真实执行逐项一致。

### Phase 5：ReportDocument v2 与投影门禁

- 增加 ReportProjection Module。
- 完成 ResearchPlanProjection。
- 增加 source pointers 和 coverage。
- 移除空章节和错误 multimodal。
- 生成完整与摘要双份导出。

独立价值：摘要、打印和发布版本也具备可验证的信息保真。

每个 Phase 独立提交、独立通过 typecheck 和定向测试，后续 Phase 未完成不影响前一 Phase 使用。

## 23. 测试矩阵

| Requirement | Test |
|---|---|
| Registry compiled/legacy 互斥 | `skill-execution-contract.test.ts` |
| Contract ID/hash/Schema | `skill-execution-contract.test.ts` |
| Stage DAG 无环且依赖存在 | `skill-execution-contract.test.ts` |
| 未声明 Tool 被拒绝 | `plan-compiler.test.ts` |
| Skill阶段展开稳定 | `plan-compiler.test.ts` |
| 卡片步骤与执行步骤一致 | `control-api-integration.test.ts` |
| Knowledge ID、path、hash 一致 | `knowledge-bundle-resolver.test.ts` |
| 必需知识缺失暂停 | `lease-execution-engine.test.ts` |
| 可选知识缺失产生 Gap | `lease-execution-engine.test.ts` |
| Skill degraded 产生 Gap | `lease-execution-engine.test.ts` |
| Legacy Skill 保持单次模式 | `lease-execution-engine.test.ts` |
| 澄清问题阻止提前规划 | `requirement-refinement-service.test.ts` |
| 范围答案进入新 Plan | `control-clarification.test.ts` |
| ResearchPlan 12字段完整展示 | `research-plan-projection.test.ts` |
| 无视觉不标 multimodal | `report-document.test.ts` |
| v1/v2 Report 都可读 | `report-package-response.test.ts` |
| ZIP包含 canonical/full/summary | `report-bundle.test.ts` |
| 浏览器完整/摘要切换 | Web runtime smoke |

## 24. 测试节奏

每个 Phase：

1. 批量写该阶段失败测试。
2. 一次性运行红灯测试，确认测试确实能捕获旧行为。
3. 完成该 Phase 实现。
4. 运行定向测试、typecheck 和 diff check。
5. 独立提交。

最终执行：

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm exec tsx --test \
  tests/skill-execution-contract.test.ts \
  tests/knowledge-bundle-resolver.test.ts \
  tests/plan-compiler.test.ts \
  tests/lease-execution-engine.test.ts \
  tests/requirement-refinement-service.test.ts \
  tests/control-clarification.test.ts \
  tests/control-api-integration.test.ts \
  tests/research-plan-projection.test.ts \
  tests/report-document.test.ts \
  tests/report-bundle.test.ts \
  tests/current-flow-state.test.ts
pnpm --dir apps/web build
pnpm quality
git diff --check
```

## 25. 手工验收

1. 新建“宠物心智设计表达策略”研究规划任务。
2. 验证核心 Requirement 未补齐时不能生成候选方案。
3. 回答地域包含海外，确认 Requirement 和候选计划均保留该范围。
4. 查看候选卡中的 `generate-research-plan` 及 7 个内部阶段。
5. 确认卡片显示 Knowledge、Tool、LLM、Skill、Reviewer 的准确数量。
6. 选择并执行 compiled 方案。
7. 验证执行图中的 Skill stage 与卡片一一对应。
8. 验证 Knowledge Artifact 含固定资源 ID 和 hash。
9. 验证 Tavily Receipt 和 Skill provenance。
10. 模拟可选知识缺失，确认任务为 completed_with_gaps。
11. 模拟必需知识缺失，确认任务 paused。
12. 打开完成报告，默认进入完整方案。
13. 检查 12 个 ResearchPlan Payload 字段全部可见。
14. 切换管理摘要，确认明确标识为摘要。
15. 确认无视觉资产时没有空 Visual Evidence/Comparison 章节。
16. 下载 ZIP，检查 deliverable.json、full-report.md 和 summary-report.md。
17. 打开历史任务，确认仍可读取并显示完整 Deliverable。

## 26. 发布与回滚

### 发布顺序

- 先发布兼容 Reader 和前端完整视图。
- 再发布状态诚实与 Requirement 最终化。
- 再发布 Knowledge Bundle。
- 最后为单个 Skill 开启 compiled 模式。
- ReportDocument v2 在 Reader 支持部署后再开始写入。

### 回滚

- 将 `generate-research-plan.execution_mode` 切回 `legacy_single_call`，停止生成新的 compiled 计划。
- Runtime 保留 v2 Reader，已生成 v2 计划继续执行。
- 页面始终可回退到 Canonical Deliverable 完整视图。
- ReportDocument v2 写入关闭后，旧 v1 继续读取。
- 不删除 Plan、Artifact、Receipt 或历史报告。
- 无数据库 Migration，无数据库回滚步骤。

## 27. Premise Collapse

本方案假设 Skill 作者愿意维护机器可读执行合同，并将 `SKILL.md` 作为人类说明、Execution Contract 作为机器真相源。

如果 Skill 仍被定义为纯提示词文档，则 Phase 4 不成立；系统最多只能交付：

- Wiki预加载；
- 单次结构化生成；
- 真实Tool前置；
- 诚实的degraded状态；
- 完整Deliverable展示。

这种情况下不得再向用户宣称“完整执行了Skill内部工作流”。

## 28. Entity Delta

```text
新增公共配置字段       +2
新增机器执行合同       +1
新增 Plan contract 版本 +1
新增 actor type         +1
新增 ReportDocument版本 +1
新增服务               +0
新增环境变量           +0
数据库 Migration       +0
```

每个新增实体都有当前明确使用方；不为未迁移 Skill 预建额外运行时能力。

## 29. 实施结果（2026-08-22）

- `generate-research-plan` 已切换为 compiled execution contract。
- PlanCompiler 将其展开为 7 个可见阶段，并冻结 Skill Invocation、知识资源和合同 hash。
- Knowledge Runner 通过现有索引解析资源，写入 SEALED `knowledge-bundle-v1` Artifact，并生成 `knowledge_excerpt` Evidence。
- Skill references 通过受限相对路径加载并记录 hash；不开放任意文件系统访问。
- Skill `degraded` 会产生 Gap 和 `completed_with_gaps`。
- 未完成 clarification questions 不再进入候选计划；计划后未绑定 confirmation answer 会被拒绝。
- `research_plan` 无视觉资产时返回 `current_text`，有视觉资产时使用 ReportDocument v2。
- ReportDocument v2 为 12 个 ResearchPlan 必填字段提供确定性 coverage，并移除空章节。
- 页面默认展示完整方案，可切换管理摘要；ZIP 同时包含完整 Deliverable、完整 Markdown 和摘要 Markdown。
- Plan v1、ReportDocument v1 和 legacy single-call Skill 保持兼容。
- 全量 `pnpm quality` 通过：1579 pass、15 skip、0 fail。
- Web production build 和浏览器验收通过。

## 30. 完成定义

```text
truthful skill status             done
requirement finalized before plan done
knowledge resources frozen         done
knowledge artifacts traceable      done
skill contract compiled            done
card/execution parity               done
controlled tool calls               done
canonical deliverable default view done
report projection coverage          done
full/summary export                 done
legacy plan/report compatibility    done
targeted tests                      done
full quality gate                   done
browser acceptance                  done
docs/todolist/ADR synchronized      done
remote delivery explicitly handled done
```
