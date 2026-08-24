# 通用多 Skill 组合编排底座开发文档

> 状态：实施中；Gate 0、Phase 1 与 Phase 2 核心实现及 Milestone A 已完成，Multi-Skill writer 仍保持 inactive。
>
> 当前集成分支：`feat/research-answer-dynamic-reports`
>
> 当前基线 HEAD：`905dfa9ad8913abfedf922c9a4676a44876bed10`
>
> 配套清单：`docs/plans/2026-08-24-universal-multi-skill-orchestration-todolist.md`
>
> 上游架构：`doc/用研AI专项_AgentHarness与SkillOrchestrator底座搭建方案.md`、`doc/用研AI专项_完整开发方案.md`
>
> 既有决策：`docs/adr/0003-compile-skills-into-frozen-execution-dag.md`、`docs/adr/0004-separate-research-planning-from-answer-delivery.md`、`docs/adr/0005-model-directed-typed-report-layout.md`、`docs/adr/0006-lossless-canonical-deliverable-compilation.md`
>
> 本文是“所有任务支持 1..N 个 Skill、保留 Skill 内多 LLM 分析、形成可审计 Contributor → Synthesizer → Reviewer → Canonical 流程”的设计真相源。

## 0. 自查修订摘要

本版相对初稿完成以下收敛：

- 不新增 ProblemGraph v2，保留 v1 并新增规划层 Capability Demand Graph v1；
- 不新增固定 Contributor/Step 数量配置，复用现有 ProfileSpec、Usage Budget 和 Tool Budget；
- 增加 Deliverable Composition Policy，确定唯一 Synthesizer，不交给 LLM 临时决定；
- 所有 active Skill 只要求完成 composition 分类审计，首批兼容 Skill 才实施 Adapter/迁移；
- 验证改为开发内环按需、Phase 定向、三个 Milestone 集成、最终一次全量；
- 真实外部 E2E 只运行一个代表性京东众筹链路，其他 Task Type 使用 fixtures；
- live Zero 改为条件门禁，仅在 Zero payload/transport 发生变化时执行；
- 京东众筹旧 Task 已完成，保留为 single-skill baseline，Multi-Skill 验收使用新 Task。

## 1. 背景

原始产品架构要求：

```text
Requirement
→ Router 生成 selected_skills + selected_tools
→ 生成 Skill 间串行/并行/后置汇总 DAG
→ 每个 Skill 独立执行并保存结果
→ Result Synthesizer 合并多个 Skill 输出
→ Reviewer 校验
→ 最终报告
```

现有实现已经具备 Requirement v2、Plan/Answer 分离、Skill/Tool/Knowledge Registry、CurrentExecutionPlan v1/v2、Compiled Skill、可见 DAG、Lease/Heartbeat/取消/恢复、SEALED Artifact、Canonical Deliverable、ReportDocument v2、Step 10 lossless compiler、Web/Markdown/ZIP/Zero 等基础能力。

但生产路径对答案型任务发生了结构性收缩：

```text
research_synthesis
→ direct_skill_bypass
→ research-strategy-synthesis
→ 单个 Compiled Skill 内部九阶段
```

最新京东众筹任务已验证：

```text
Task: 055a2658-8b6c-4bd7-9078-43636feb9df7
Requirement: outcome_mode=answer, task_type=research_synthesis
Active Plan: 66c0c80c-fe1b-408e-9ee7-41acb257323f
Plan profile: depth
Skill invocations: 1
Capability eligible: 1
Capability rejected: 23
Planning method: direct_skill_bypass
Classifier calls: 0
Execution attempt: 105dbbe2-1e92-47a0-8062-0e2da78fea4e
Task state: completed_with_gaps
```

该任务同时要求市场/竞品、虚拟用户、Persona、访问动机/JTBD、UV/转化指标和最终策略综合，但计划只包含 `research-strategy-synthesis`。它加载 persona-building 和 competitor-selection Knowledge，却没有执行对应 Contributor Skill，也没有调用 `virtual-user-lab`。

## 2. 根因

1. `ResearchPlanningService` 将任何 `research_synthesis` 硬编码为 `research-strategy-synthesis`。
2. Capability Resolver 主要按 `task_types` 过滤，语义相关的 Specialist Skills 因未声明 `research_synthesis` 被拒绝。
3. Candidate Planner 只接收 eligible shortlist，并禁止使用 rejected actor。
4. Compiled Skill 解决的是一个 Skill 内部阶段真实执行，不等于多个 Skill 间组合。
5. 现有 Skill Payload 异构，缺少统一 Question/Evidence/Artifact 绑定与贡献处置合同。
6. Final Assembler 以恰好一个 `research-strategy-synthesis` Draft 为 lossless 源，没有多 Contributor Ledger。

## 3. Primary Setpoint

所有 Task Type 共用一套 Multi-Skill Foundation：

```text
每个任务支持 1..N 个 Skill Invocation；
简单任务允许一个 Skill；
复杂任务按 Required Question、Requested Artifact、Evidence Policy 和方法义务选择多个 Contributor；
每个 Contributor 独立产出 SEALED Artifact；
一个最终 Synthesizer 合并 Contributor；
一个 Global Reviewer 审核冲突、遗漏与证据边界；
Step 10 只做 lossless Canonical 编译，不重新研究或全文重写。
```

Multi-Skill 是底层能力，不是京东众筹专用分支。

## 4. 成功标准

### 4.1 路由与计划

- 任意 Task Type 可产生 1..N 个 Skill Invocation。
- 非用户显式 `$skill` 直呼时，不允许 `direct_skill_bypass`。
- 每个 Required Question 恰好一个 Primary Analysis Owner，可有最多一个 Corroborator。
- 每个 Requested Artifact 至少一个 Owner。
- 每个 Skill 的选择/拒绝理由、覆盖问题、产物和预算可审计。
- Plan 在确认前显示全部 Tool、Knowledge、LLM、Skill、Reviewer 节点。
- Depth/Speed 可改变 Contributor 数量与 Review 强度，但不能省略 Required Coverage。

### 4.2 执行

- 每个 Invocation 可独立完成、失败、降级、重试、取消。
- 独立 Contributor 可并行；Synthesizer 等待所有 Required Contributor。
- Optional Contributor 失败产生 Gap；Required Contributor 失败 block。
- 共享 Tool/Knowledge 不重复调用。
- 保留每个 Compiled Skill 内部多 LLM、Tool、Knowledge、Reviewer 逻辑。
- 所有调用保留 Receipt、hash、Task/Plan/Attempt lineage。

### 4.3 内容与报告

- Contributor 原生输出 `research-contribution-v1`，或通过确定性 Adapter 转换。
- 每个 Contribution Unit 必须被 `included`、`merged`、`conflicted` 或 `omitted` 恰好一次。
- `omitted`/未解决 `conflicted` 必须绑定 Reviewer issue 与理由。
- Synthesizer 不得删除、静默改写或伪造 Contributor Evidence。
- Canonical Deliverable 仍为正式报告唯一真相源。
- Step 10 不调用大型 LLM 全文重写。
- Web 可查看每个 Skill 独立结论及其最终映射。
- ReportDocument 的 Canonical semantic node exact-once 规则保持。

### 4.4 兼容与验收

- Plan v1/v2、ReportDocument v1/v2、历史 Deliverable/Payload 继续可读。
- 历史 Requirement/Plan/Artifact 不修改。
- 新任务写 `current-execution-plan-v3`。
- 默认不增加数据库 Migration。
- 每个 active Task Type 至少一个 Multi-Skill fixture。
- 代表性任务完成真实 Gateway/DB/Tool E2E 后才激活。

## 5. 非目标

- 不强制每个任务至少两个 Skill。
- 不允许 LLM 使用未注册、inactive、工具不健康或审批缺失的 Skill。
- 不引入隐藏嵌套 Agent/Skill 或第二套调度器。
- 不让每个 Skill 各自生成完整最终报告。
- 不把异构 Payload 无约束塞给全文重写模型。
- 不把虚拟用户结果冒充真实用户研究。
- 不让未经 Review 的 Contributor 原文成为正式报告。
- 不恢复 whole-task timeout。
- 不重写历史 SEALED Artifact。
- 不单独上线任一不完整中间 Phase。

## 6. 领域模型

- **Skill Portfolio**：一次任务选中的 1..N 个 Skill Invocation 集合。
- **Contributor Skill**：负责一个独立问题域并输出标准贡献。
- **Synthesizer Skill**：消费多个 Contribution，生成一个 Deliverable Content Draft；每个顶层 Deliverable 恰好一个。
- **Analysis Owner**：对 Required Question 负主要责任的 Contributor。
- **Corroborator**：对同一问题提供独立佐证/反证；v1 每题最多一个。
- **Shared Evidence Stage**：由多个 Invocation 共享且显式允许去重的 Tool/Knowledge 阶段。
- **Research Contribution**：Contributor 的 SEALED 标准语义输出，不是最终 Deliverable。
- **Contribution Ledger**：记录每个 Unit 如何进入 Canonical 或为何被合并、冲突、遗漏。
- **Multi-Skill Fidelity**：Contributor → Synthesis → Canonical → Report 的机器可验证链路。

受控 `ContributionType` 首批包括：

```text
market_landscape
competitive_analysis
persona
jobs_to_be_done
journey
qualitative_insight
voc
satisfaction
metrics
funnel
feature_adoption
design_audit
accessibility
research_method
prioritization
strategy
action_plan
virtual_user_hypothesis
```

## 7. 目标架构

```text
Finalized ResearchTaskV2
        ↓
ProblemGraph v1 + Capability Demand Graph v1
        ↓
Capability Portfolio Resolver
 hard filter → semantic score → coverage optimizer → policy validator
        ↓
CurrentExecutionPlan v3
        ├── Shared Tool / Knowledge
        ├── Contributor A ─┐
        ├── Contributor B ─┼── parallel
        └── Contributor C ─┘
        ↓
Contribution Bundle + Pre-Synthesis Ledger
        ↓
Synthesizer Skill
        ↓
Cross-Skill Reviewer
        ↓
Reviewed Synthesis Draft
        ↓
Lossless Canonical Compiler
        ├── Canonical Deliverable
        ├── Final Contribution Ledger
        ├── Report Review
        ├── ReportDocument v2
        └── Report Package
```

所有层最终展开为一个可见、冻结的 DAG；不存在隐藏子调度器。

## 8. Multi-LLM 保留策略

保留三层模型调用：

```text
Planning LLM
+ Skill 内部 LLM/Reviewer
+ Cross-Skill Synthesis/Reviewer LLM
```

| 当前单 Skill 阶段 | Multi-Skill 后归属 |
|---|---|
| 公开证据检索 | Shared Evidence Layer |
| Knowledge 加载 | Shared + Skill-specific Knowledge |
| 按问题盘点证据 | Shared Inventory + Contributor 局部 Inventory |
| 合成逐题答案 | 最终 Synthesizer |
| 反证答案边界 | Contributor Reviewer + Global Reviewer |
| 实体化策略对象 | 对应 Contributor Skill |
| 排定优先级 | Prioritization/Metrics Contributor + Synthesizer |
| 合成结构化报告 | Synthesizer Skill |
| 完整性审校 | Global Reviewer |
| Step 10 | Deterministic Compiler |

只删除重复劳动：重复检索、重复 Knowledge、重复完整分析和第二次全文报告重写。Contributor 接收 scoped Questions/Evidence；Synthesizer 接收结构化 Contribution，不接收全部 Prompt 历史。

## 9. 保留 ProblemGraph v1，新增 Capability Demand Graph v1

自查后不再新增 `problem-graph-v2`。当前 ProblemGraph v1 已能表达 Required Questions、Evidence Requirements 和 Success Criteria；为多 Skill 路由另建只属于规划层的 `capability-demand-graph-v1`，避免扩大 ProblemGraph、Reviewer 和历史 fixture 的变更面。

Capability Demand Graph 作为 Plan v3 的必填字段：

```ts
interface CapabilityDemand {
  id: string;
  type: ContributionType;
  questionIds: string[];
  requestedArtifactTypes: RequestedArtifact[];
  requiredEvidenceClasses: EvidenceClass[];
  requiredInputRoles: string[];
  priority: 'required' | 'optional';
}
```

规则：

- 每个 Required Question 至少一个 required demand。
- Demand type 只能取受控 enum。
- 模型建议 demand，Validator 校验 Question/Artifact/Evidence 一致性。
- Requirement 明确虚拟用户时，必须生成 `virtual_user_hypothesis` demand。
- 无真实用户资料时 Persona/JTBD/Virtual User 默认 provisional。
- 无数据时不能生成市场规模、GMV、转化率等 quantitative fact demand，只能生成 hypothesis/measurement demand。

## 10. Skill Registry Composition Contract

现有 Registry 字段保持，新增：

```yaml
composition:
  modes: [standalone, contributor, synthesizer]
  supported_outcomes: [plan, answer]
  compatible_deliverables: [research_strategy_report]
  contribution_types: [persona, jobs_to_be_done]
  contribution_schema: schemas/research-contribution-v1.schema.json
  required_input_roles: [research_goal]
  optional_input_roles: [public_evidence, user_materials]
```

规则：

- 旧 Skill 无 `composition` 时视为 standalone。
- contributor 必须有 contribution schema 和 contribution type。
- synthesizer 必须声明 compatible deliverable 与接受的 contribution schema。
- 一个 Skill 可同时支持 standalone/contributor。
- `task_types` 保留为粗粒度边界；answer/plan 兼容由 `supported_outcomes` 表达。
- Registry Linter 校验角色、Schema、Tool、Deliverable 和输入条件。

### 10.1 Deliverable Composition Policy

Synthesizer 不能只靠语义评分决定。每个 active Deliverable 在 `orchestrator/deliverable-registry.yaml` 声明唯一组合策略：

```yaml
composition:
  mode: portfolio
  synthesizer_skill_id: research-strategy-synthesis
  accepted_contribution_types:
    - market_landscape
    - persona
    - jobs_to_be_done
    - metrics
    - strategy
  contribution_schema: schemas/research-contribution-v1.schema.json
```

规则：

- 一个 Deliverable 恰好一个 Synthesizer owner。
- `portfolio` 模式写 Plan v3；旧 Deliverable 可暂时使用 `standalone_compat` 并继续写原 Plan。
- 激活“覆盖所有任务”前，每个 active Deliverable 必须有明确 composition policy。
- Contributor 只能向声明接受其 contribution type 的 Deliverable 供稿。
- Deliverable Registry 是 Synthesizer 选择真相源，LLM 不能替换。

### 10.2 首批迁移

| Skill | 模式 | Contribution Type |
|---|---|---|
| research-strategy-synthesis | synthesizer | strategy, action_plan |
| generate-research-plan | synthesizer | research_method |
| competitive-web-research | contributor/standalone | market_landscape, competitive_analysis |
| competitive-analysis | contributor/standalone | competitive_analysis |
| generate-persona | contributor/standalone | persona |
| jobs-to-be-done | contributor/standalone | jobs_to_be_done |
| journey-map | contributor/standalone | journey |
| build-experience-metrics | contributor/standalone | metrics |
| conversion-funnel-analysis | contributor/standalone | funnel |
| feature-adoption-analysis | contributor/standalone | feature_adoption |
| code-open-feedback | contributor/standalone | voc |
| analyze-satisfaction | contributor/standalone | satisfaction |
| synthesize-qualitative-insights | contributor/standalone | qualitative_insight |
| issue-prioritization | contributor/standalone | prioritization |
| run-heuristic-evaluation | contributor/standalone | design_audit |
| accessibility-review | contributor/standalone | accessibility |

所有 active Skill 必须在实施时逐项归类；无法满足 Contribution Contract 的保持 standalone，不得伪装成 Contributor。

## 11. Capability Portfolio Resolver

### 11.1 算法

1. **Hard Filter**：status、outcome、deliverable、input、Tool health/real adapter、risk approval。
2. **Semantic Recall**：contribution type、`when_to_use`、Question、Artifact、business domain。
3. **Coverage Optimization**：覆盖全部 required demands，最小化 Skill 数量和重复 ownership。
4. **Budget Check**：复用现有 ProfileSpec 的 `max_steps`、Usage Budget 和 Tool Budget，不新增固定 Contributor 数量常量；每个 demand 默认最多一个 Primary Owner 和一个 Corroborator。
5. **Deterministic Validation**：每题 Owner、每个 Artifact Owner、恰好一个 Synthesizer、无循环、无 rejected actor、无缺失输入/审批。

```ts
interface SkillPortfolioDecision {
  invocations: SkillInvocationDecision[];
  demandCoverage: DemandCoverage[];
  rejected: CapabilityDecision[];
  sharedPrerequisites: SharedPrerequisiteDecision[];
  estimatedBudget: PortfolioBudget;
}
```

Foundation 支持 1..N，不强制多 Skill；但 Requirement 含两个以上独立 required contribution types 时，不允许无覆盖声明地退化为一个 umbrella Skill。

## 12. CurrentExecutionPlan v3

新增 `current-execution-plan-v3`；v1/v2 保持兼容。

```ts
interface CurrentSkillInvocationV3 {
  invocation_id: string;
  skill_id: string;
  role: 'contributor' | 'synthesizer';
  contribution_types: ContributionType[];
  question_ids: string[];
  requested_artifact_types: RequestedArtifact[];
  depends_on_invocation_ids: string[];
  output_contract: string;
  required: boolean;
  failure_policy: 'block' | 'gap';
  execution_mode: 'compiled' | 'legacy_single_call';
  contract_version?: string;
  contract_hash?: string;
  step_nos: number[];
}
```

共享步骤：

```ts
interface SharedPlanStepMetadata {
  shared_stage_key: string;
  shared_by_invocation_ids: string[];
  share_fingerprint: string;
}
```

贡献覆盖：

```ts
interface PlanContributionRequirement {
  id: string;
  demand_type: ContributionType;
  question_ids: string[];
  requested_artifact_types: RequestedArtifact[];
  owner_invocation_id: string;
  corroborator_invocation_ids: string[];
  required: boolean;
}
```

编译门禁：

- 高层 Invocation dependency 映射到上游 output stage。
- Synthesizer 必须依赖所有 Required Contributor output stages。
- 跨 Skill binding 只指向已注册 output pointer。
- 编译后 step_no 连续、拓扑有序、无环。
- 共享步骤仅在 contract 显式 shareable 且 fingerprint 完全相同时合并。
- Skill 内部 Stage 顺序和 acceptance 不变。
- 编译前后 Coverage 等价。
- Plan hash 包含 Portfolio、roles、Contribution Requirements、共享指纹和合同 hash。

## 13. Research Contribution v1

新增：`schemas/research-contribution-v1.schema.json`。

```ts
interface ResearchContributionV1 {
  version: 'research-contribution-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  invocationId: string;
  skillId: string;
  contributionTypes: ContributionType[];
  units: ResearchContributionUnit[];
  limitations: string[];
  openQuestions: string[];
}

interface ResearchContributionUnit {
  key: string;
  kind: ContributionUnitKind;
  title: string;
  statement: string;
  businessImplication?: string;
  recommendedAction?: string;
  requestedArtifactTypes: RequestedArtifact[];
  support: {
    questionIds: string[];
    evidenceIds: string[];
    status: 'supported' | 'provisional';
    confidence: number;
    validationNeeded: string;
  };
}
```

规则：

- Model 生成稳定 key，Runtime 生成全局 ID。
- 非 unanswered Unit 必须绑定 Question。
- supported 必须绑定 factual Evidence；provisional 必须有 validationNeeded。
- Synthetic/Virtual User 内容只能 provisional，不能成为 factual root。
- Skill Envelope 顶层 summary/findings/assumptions/limitations/recommendations 必须映射到 units 或明确标为 diagnostic metadata，不能静默丢失。
- 每个 Unit 只属于一个 Contributor Artifact。

## 14. Contributor Adapter

并非所有现有 Skill 能原生输出 Contribution v1。新增受控 Adapter Registry：

```yaml
skill_id: generate-persona
adapter: persona-contribution-v1
source_schema: knowledge-base/skills/generate-persona/output.schema.json
target_schema: schemas/research-contribution-v1.schema.json
```

- Adapter 是确定性代码，不调用 LLM。
- 无法确定性映射时必须修改 Skill Payload Schema，不能猜测映射。
- Adapter 保留 source JSON pointer 和 semantic hash。
- Adapter 失败只影响所属 Invocation，按 required/gap 处理。
- Legacy Skill 无 Adapter 时只能 standalone。

## 15. Shared Evidence 与 Knowledge

### 15.1 Evidence Bundle

Plan 根据全部 Required Demands 生成一个或少量领域分片检索。Evidence Service 签发统一 Evidence IDs。Contributor 只收到与其 Questions 相关的 Evidence slice、完整 Manifest identity 和允许引用的 ID 集合。

### 15.2 Knowledge Bundle

- 公共标准可共享；
- Skill-specific method 独立加载；
- 相同 reference set + contract hash 可去重；
- 保留 source path、status、content hash；
- Knowledge 不能作为 supported factual claim 根。

### 15.3 Tool 去重

Tool share fingerprint 包含：

```text
tool id
manifest hash
input hash
approval identity
Evidence policy
execution mode
```

只有 fingerprint 相同且 contract 声明 `share_scope: plan` 才复用。

## 16. Virtual User Contributor

新增或适配 `virtual-user-research` Contributor，通过 `virtual-user-lab` 输出 synthetic cohort/response。

强制规则：

- 所有 Unit provisional；
- Evidence 标记 synthetic，不得作为 factual root；
- 报告明确“虚拟用户假设，不代表真实用户研究”；
- 不得给出真实市场规模、转化率或统计显著性；
- Requirement 未允许 synthetic research 时不得调用；
- Tool unavailable 按 required/gap policy；
- 必须附后续真实验证设计。

## 17. Execution Semantics

### 17.1 Flattened DAG

多 Skill 最终仍编译成现有 Scheduler 的普通步骤，不创建嵌套任务。Plan 卡片与真实执行一一对应。

### 17.2 并行

- Shared Evidence 完成后 fan-out；
- 无依赖 Contributor 并行；
- Synthesizer 等待所有 Required Contributor；
- Optional Contributor 失败可 gap 后继续。

### 17.3 Retry/Resume

- 保留单 Tool/LLM stage retry；
- Contributor 可单独 retry；
- Synthesizer 失败优先 terminal synthesis rebuild，不重跑已验证 Contributor；
- Contribution/contract drift 只重跑受影响 Invocation 及下游；
- 用户取消终止所有未完成分支。

### 17.4 Lease/Timeout

- 保持无 whole-task timeout；
- 保持 per-call timeout、Lease heartbeat、worker-loss、取消；
- Portfolio budget 只阻止未来调用，不破坏已封存 Contributor；
- 不增加第二套 Lease。

## 18. Cross-Skill Synthesis

Synthesizer 输入：

```text
Finalized Requirement
ProblemGraph v1
Capability Demand Graph v1
Evidence Manifest
ResearchContributionV1[]
Contributor Reviews
Gap/Risk/Provenance
```

不输入 Contributor 的完整 Prompt 历史。

合并规则：

- 同 Question 且语义等价可 merged，保留全部 source unit IDs。
- 同 Question 且冲突进入 Conflict Set。
- Evidence 强弱不同不得仅凭模型提高 confidence。
- 新综合结论必须列出 source contribution unit IDs。
- provisional 不得无 factual Evidence 升级为 supported。
- 不允许无来源追加新事实。

Cross-Skill Reviewer issue 类型：

```text
coverage
conflict
unsupported_claim
duplicate
method_mismatch
synthetic_overclaim
missing_artifact
priority_without_basis
```

每个 issue 包含 source unit IDs、target node IDs、message 和 disposition。

## 19. Contribution Ledger 与 Multi-Skill Fidelity

新增：

```text
schemas/contribution-ledger-v1.schema.json
apps/orchestrator-runtime/src/report/contribution-ledger.ts
apps/orchestrator-runtime/src/report/multi-skill-content-fidelity.ts
```

```ts
interface ContributionLedgerEntry {
  contributionArtifactId: string;
  invocationId: string;
  sourceUnitKey: string;
  sourceSemanticHash: string;
  disposition: 'included' | 'merged' | 'conflicted' | 'omitted';
  canonicalNodeIds: string[];
  reason?: string;
  reviewIssueIds: string[];
}
```

门禁：

- 每个 source unit 恰好一个 Entry。
- included 至少一个 canonicalNodeId 且 semantic hash 相同。
- merged 必须列出全部 source、目标节点和 Reviewer 授权。
- conflicted 必须进入 limitations/openQuestions 和 owner trace。
- omitted 必须有 Reviewer issue 和原因；Required Question 唯一 Owner unit 不得 omitted。
- Canonical 不得引用未知 contribution unit。
- Ledger 在 Deliverable sealing 前 SEALED。
- Canonical → ReportDocument exact-once 规则继续执行。

## 20. Canonical Deliverable、报告与导出

### 20.1 Canonical

正式报告只消费 Reviewed Canonical。Contributor Artifact 不能绕过 Review。Step 10 接收 Reviewed Synthesis Draft + Contribution Ledger，只做 ID、FindingGraph、Coverage、risk、provenance、artifact binding 和完整性验证。

### 20.2 Report Package

新 Plan v3 报告包必须引用：

```text
contributionLedgerArtifactId
contributionSummaryArtifactId
```

Reader 对旧包保持兼容。

### 20.3 Owner Contribution View

显示：

- Skill Portfolio 和角色；
- Invocation status；
- 独立贡献、Evidence、confidence、limitations；
- Final mapping；
- merged/conflicted/omitted 原因；
- source Artifact identity。

该视图不是 Canonical 报告，不导出未 Review 或敏感原文。

### 20.4 正式报告

保持 answer-first、typed blocks、layout fallback、Markdown/ZIP/Zero、Reviewed Draft Preview、lossless Step 10。可增加“贡献与方法”附录，但只显示 Review 通过的安全摘要和映射。

## 21. Web 任务卡片

按 Invocation 分组：

```text
Shared Evidence
Contributor: Market
Contributor: Virtual User
Contributor: Persona/JTBD
Contributor: Metrics
Synthesizer
Global Review
Report Compiler
```

每组可折叠内部 Tool/Knowledge/LLM/Reviewer stages。卡片显示：Skill 名称/角色、Question/Artifact 覆盖、选择原因、Required/Optional、状态、Gap/Failure、Artifact、Provenance、最终映射。

计划确认页必须显示 Skill 数量、分工、Tool、synthetic 提示、预计步骤/预算、未覆盖需求和 Depth/Speed 真实差异。

## 22. 全 Task Type 覆盖

Foundation 覆盖当前 active Task Types：

```text
user_research_planning
research_synthesis
competitive_research
design_audit
a11y_audit
voc_diagnosis
```

| Task Type | Contributor 示例 | Synthesizer/Deliverable |
|---|---|---|
| user_research_planning | interview/survey/usability/metrics methods | generate-research-plan → research_plan |
| research_synthesis | market/persona/JTBD/metrics/virtual-user | research-strategy-synthesis → research_strategy_report |
| competitive_research | web/app/strategy competitor | competitive report synthesizer |
| design_audit | heuristic/visual/accessibility | design audit synthesizer |
| a11y_audit | accessibility/page evidence | accessibility audit synthesizer |
| voc_diagnosis | feedback coding/satisfaction/qualitative | VOC diagnosis synthesizer |

简单任务可只有一个 Skill；复杂任务由 Demand Coverage 强制多 Skill。

## 23. 京东众筹首个真实验收 Portfolio

沿用 Requirement v3，新 Plan 至少包含：

```text
Shared Tavily Evidence
Market/Competitive Contributor
Virtual User Contributor
Persona Contributor
JTBD/Motivation Contributor
Metrics Contributor
Research Strategy Synthesizer
Cross-Skill Reviewer
Lossless Compiler
```

验收：

- `virtual-user-lab` 有真实 Tool receipt；
- synthetic findings 全部 provisional；
- Persona、JTBD、Market、Metrics 各有独立 Contribution Artifact；
- 每个 Required Question 有 Primary Owner；
- 报告覆盖用户分层、动机、市场、MVP、UV/转化和验证路径；
- Ledger 可逐项对比 Contributor 与 Final；
- 旧 Plan/Attempt 已完成并保持 immutable evidence；
- Multi-Skill 验收创建新的京东众筹 Task，复用同等 Requirement 语义，不修改历史 Task/Plan。

## 24. 兼容与版本策略

### 24.1 Plan

- v1/v2 Reader 保留；
- v3 Reader/Writer 新增；
- v3 才允许 first-class Multi-Skill Portfolio；
- v2 已有多个 invocation 数据仍按冻结语义执行，不自动升级。

### 24.2 Skill

- `legacy_single_call`、compiled contract v1 保留；
- Contributor 通过 composition metadata + Contribution Adapter opt-in；
- 未 opt-in Skill 不受影响。

### 24.3 Deliverable/Report

- Research Deliverable v1、Payload v1/v2、ReportDocument v1/v2 保留；
- Contribution Ledger 为独立 Artifact，避免破坏 Canonical Schema；
- Report Package Reader 同时支持有/无 Ledger。

### 24.4 Database

现有表使用 JSONB 与字符串 kind，可保存 Plan v3 和新 Artifact kind，默认不新增 Migration。若实现发现数据库约束阻断，必须先更新本文并单独评审。

## 25. 安全与真实性

- Capability hard filter、high-risk 审批继续生效。
- Skill 不能调用未冻结 Tool。
- Tool/Skill contract drift fail closed。
- Adapter 不读取任意文件、不调用模型。
- Synthetic Evidence 不得成为 factual root。
- 未 Review Contributor 不进入正式报告。
- 执行步骤在确认前全部可见。
- Fixture/offline replay 不等于真实外部执行。
- 现有 Skill Runtime 路径、Schema、redaction、Artifact integrity 不得弱化。

## 26. 性能与预算

Portfolio 需估算 Tool/Model/Reviewer 调用、Token 和并发分支。

默认限制：

- Contributor 数量和总步骤复用现有 ProfileSpec `max_steps`、Usage Budget 与 Tool Budget；
- 每 Demand 默认最多 1 Corroborator；
- Required Coverage 超出 Profile 预算时选择能覆盖多个 Demand 的 Skill，或请求用户缩小 Scope；
- 不新增 `maxContributorSkills`、`maxVisibleSteps` 等重复配置；
- 不得为了预算静默裁剪 Required Demand。

上下文规则：Contributor 只接收 scoped manifest；Synthesizer 只接收 Contribution Bundle、Evidence Index 和 Requirement；大型 raw Tool output 通过 Evidence pointer 使用。

预估复杂任务相对当前单 Skill：

| 指标 | 变化估计 |
|---|---|
| Skill Invocation | 1 → 3–6 |
| 可见步骤 | 9–10 → 15–25 |
| Model/Reviewer 调用 | 约 8 → 约 10–18 |
| Artifact | 约 2–3 倍 |
| Token 成本 | +50%～150% |
| 墙钟时间 | 并行后 +30%～70% |

以上是设计估算，不作为验收数据；实现后必须实测。

## 27. 可观测性

新增：

```text
portfolio_candidate_count
portfolio_selected_skill_count
portfolio_required_coverage
portfolio_optional_coverage
shared_stage_dedup_count
contributor_duration_ms
contributor_status
contribution_unit_count
contribution_included_count
contribution_merged_count
contribution_conflicted_count
contribution_omitted_count
synthesis_duration_ms
```

每个 Plan 持久化 Capability Demand Graph、eligible/rejected decisions、Portfolio score、Coverage Matrix、预算估算及 Plan/Contract/Registry hashes。

## 28. 文件范围

### 28.1 新增

```text
docs/adr/0007-universal-multi-skill-orchestration.md
schemas/capability-demand-graph-v1.schema.json
schemas/current-execution-plan-v3.schema.json
schemas/research-contribution-v1.schema.json
schemas/contribution-ledger-v1.schema.json
apps/orchestrator-runtime/src/planners/capability-demand-graph.ts
apps/orchestrator-runtime/src/planners/capability-portfolio-resolver.ts
apps/orchestrator-runtime/src/skills/research-contribution.ts
apps/orchestrator-runtime/src/skills/contribution-adapter-registry.ts
apps/orchestrator-runtime/src/report/contribution-ledger.ts
apps/orchestrator-runtime/src/report/multi-skill-content-fidelity.ts
apps/web/src/components/MultiSkillPlanSummary.tsx
apps/web/src/components/SkillContributionView.tsx
tests/capability-demand-graph.test.ts
tests/multi-skill-deliverable-policy.test.ts
tests/multi-skill-capability-portfolio.test.ts
tests/multi-skill-plan-compiler.test.ts
tests/multi-skill-execution.test.ts
tests/research-contribution-contract.test.ts
tests/contribution-ledger.test.ts
tests/multi-skill-fidelity.test.ts
tests/multi-skill-report-ui.test.ts
```

### 28.2 主要修改

```text
CONTEXT.md
orchestrator/skill-registry.yaml
orchestrator/deliverable-registry.yaml
packages/api-contract/plan.ts
packages/api-contract/control-workflow.ts
packages/api-contract/research-deliverable.ts
packages/api-contract/system-capabilities.ts
apps/orchestrator-runtime/src/control/requirement-refinement-service.ts
apps/orchestrator-runtime/src/planners/research-planning-service.ts
apps/orchestrator-runtime/src/planners/capability-resolver.ts
apps/orchestrator-runtime/src/planners/routed-planner.ts
apps/orchestrator-runtime/src/planners/plan-compiler.ts
apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts
apps/orchestrator-runtime/src/skills/skill-execution-contract.ts
apps/orchestrator-runtime/src/runners/skill-runner.ts
apps/orchestrator-runtime/src/control/step-input-resolver.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/orchestrator-runtime/src/report/synthesis-materializer.ts
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
apps/orchestrator-runtime/src/report/research-strategy-deliverable-assembler.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
apps/orchestrator-runtime/src/report/report-document-composer.ts
apps/orchestrator-runtime/src/report/report-package-artifact.ts
apps/orchestrator-runtime/src/report/current-report-package-reader.ts
apps/agent-api/src/routes/control-planning.ts
apps/agent-api/src/routes/control-tasks.ts
apps/agent-api/src/routes/system-capabilities.ts
apps/web/src/api/client.ts
apps/web/src/components/PlanningProgressCard.tsx
apps/web/src/components/stages/CurrentStage4Report.tsx
apps/web/src/pages/Workbench.tsx
apps/web/src/reporting/ReportDocumentView.tsx
```

### 28.3 首批 Skill/Tool

```text
skills/research-strategy-synthesis/
skills/competitive-analysis/web-research/
knowledge-base/skills/generate-persona/
knowledge-base/skills/jobs-to-be-done/
knowledge-base/skills/build-experience-metrics/
tools/virtual-user-lab/
```

实际预计 30–50 个源码、配置和测试文件。超过 8 文件，按 Gate 独立提交，但只在最终 Gate 后一次性合并/发布。

## 29. 实施阶段

### Phase 0：基线与 ADR

冻结 HEAD/未提交工作/外部门禁；新增 ADR 0007；固化术语、Plan v3、Contribution/Ledger 合同；新写入路径保持 inactive。

### Phase 1：合同与 Reader

实现 Capability Demand Graph v1、Plan v3、Contribution v1、Ledger v1、API/SystemCapabilities；ProblemGraph v1 与旧 Reader 回归。

### Phase 2：Portfolio Resolver

移除非显式 direct invoke hardcode；实现 Hard Filter、Semantic Recall、Coverage Optimizer、Profile Budget 和全 Task Type Matrix；Planner 只消费 validated Portfolio。

### Phase 3：跨 Invocation 编译与执行

实现 Invocation roles、跨 Invocation dependencies/bindings、Shared Stage dedup、Contributor parallel、Required/Optional failure、retry/resume/terminal synthesis rebuild。

### Phase 4：Contribution 与首批 Skill 迁移

实现 Contribution Runtime/Adapter；迁移 Market、Virtual User、Persona、JTBD、Metrics；所有 active Skill 完成 composition 分类审计，首批可组合 Skill 完成适配；Synthesizer 消费 Contribution Bundle。

### Phase 5：Synthesis、Review、Fidelity

实现 Conflict Set、Cross-Skill Reviewer、Contribution Ledger、Multi-Skill Fidelity、Step 10/Report Package 集成。

### Phase 6：Web 与导出

实现 Portfolio 确认、Skill Group 流程图、Contribution View、Markdown/ZIP/Zero 安全摘要、历史 UI 回归。

### Phase 7：全 Task Type 验收与 Activation

完成每个 Task Type fixture、代表性真实 Gateway/DB/Tool 任务、京东众筹真实 Multi-Skill run、浏览器/导出/Zero、独立审查、Activation commit；合并/重启仍需用户授权。

每个 Phase 必须保持旧默认路径可运行；开发内环不要求每次文件修改后验证，按第 31 节的变更感知策略在 Phase/Milestone 边界批量验证。Multi-Skill 默认写入只在最终 Activation 开启。

## 30. 测试矩阵

### 30.1 Requirement/ProblemGraph

- plan/answer 语义保持；
- capability demands 完整；
- virtual user 生成 synthetic demand；
- 无数据 quantitative demand 降级；
- ProblemGraph v1/v2 compatibility。

### 30.2 Resolver

- 单 Skill 足够覆盖；
- Multi-Skill 最小覆盖；
- overlap 去重；
- required demand 无覆盖 fail；
- optional gap；
- outcome/deliverable/tool/input/risk hard filter；
- speed/depth budget；
- rejected actor 不进入 Plan。

### 30.3 Compiler

- 多 Invocation 展开；
- 跨 Invocation dependency/binding；
- shared Tool/Knowledge dedup；
- fingerprint 不同不合并；
- cycle/dangling pointer/unknown contract 拒绝；
- Plan hash 稳定；
- v1/v2 unchanged。

### 30.4 Execution

- 并行 Contributor；
- Required failure block；
- Optional failure gap；
- 单 Contributor retry；
- worker loss/lease/cancel；
- Synthesizer-only terminal rebuild；
- contract/artifact drift fallback to affected rerun。

### 30.5 Contribution/Fidelity

- Unit identity/hash；
- supported factual root；
- synthetic provisional；
- included/merged/conflicted/omitted；
- unauthorized omission/rewrite/reorder reject；
- Contributor → Canonical mapping complete；
- Canonical → Report exact once。

### 30.6 Report/UI

- Portfolio confirmation；
- Grouped DAG；
- independent contribution view；
- final mapping；
- owner-only/non-canonical boundaries；
- Print/Markdown/ZIP/Zero；
- Plan v1/v2 and historical tasks。

### 30.7 Task Type Matrix

每类至少验证 simple 1-Skill 与 complex Multi-Skill（适用时）：

```text
user_research_planning
research_synthesis
competitive_research
design_audit
a11y_audit
voc_diagnosis
```

## 31. 高效验证策略

目标是在批次边界发现问题，而不是每修改一个文件就重复运行 typecheck、lint、全量测试和 Web build。

### 31.1 四级验证

1. **开发内环**：同一逻辑批次连续修改，不设强制命令；定位问题时只运行单个测试文件或单个 `--test-name-pattern`。
2. **Phase 边界**：只运行该 Phase 直接受影响的定向测试，不默认运行全量 typecheck/lint/build。
3. **三个集成 Milestone**：批量运行跨模块测试及对应 typecheck/lint/build。
4. **最终 Gate**：实现完成、准备 Activation 时运行一次完整 quality、一次 Web build、一次真实 E2E 和一次独立审查。

### 31.2 变更感知矩阵

| 变更类型 | Phase 边界验证 |
|---|---|
| Markdown/ADR/Todo | Markdown 结构、路径、尾随空格；不跑代码测试 |
| JSON Schema/API type | 对应 schema/contract tests + root typecheck |
| Registry/Knowledge | 对应 linter + resolver tests；不跑 Web build |
| Planner/Compiler | planner/compiler 定向测试 |
| Runtime/Lease/Artifact | execution 定向测试 + root typecheck |
| Report/Fidelity | contribution/report 定向测试 |
| Web/UI | Web typecheck/build + 一次目标浏览器矩阵 |
| Zero-only | Zero 定向测试；只有 payload/transport 改变才做 live Zero |

### 31.3 集成 Milestone

- **Milestone A（Phase 1–2）**：Contracts + Portfolio Resolver；contract/resolver tests、root typecheck、Registry lint。
- **Milestone B（Phase 3–4）**：Compiler + Execution + Contributor；planner/runtime/skill tests、root typecheck、Registry/Knowledge lint。
- **Milestone C（Phase 5–6）**：Fidelity + Report + Web；report/API/UI tests、root+Web typecheck、Web build、一次浏览器矩阵。

### 31.4 最终命令

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm test
pnpm --dir apps/web build
git diff --check
```

完整测试只在最终 Gate 运行一次。若失败，只复跑失败测试及其直接依赖；修复收敛后再做一次最终全量确认。禁止在每个小修改后重复全量 suite。

## 32. 外部验收

Activation 前只要求一次代表性真实链路：

- 京东众筹真实 Gateway + DB + Tavily Multi-Skill task；
- `virtual-user-lab` 仅在该 Contributor 进入 Plan 且真实 Adapter 可用时要求真实 receipt；不可用则 Required Demand 明确阻断，不以 fixture 冒充；
- 每个 Required Contributor 有 SEALED Artifact/Receipt；
- Contribution Ledger/Final Report 对比；
- Web 计划确认、运行恢复、最终报告；
- Markdown/ZIP；
- Zero 只做自动化回归；只有本实现改变 Zero payload/transport 时才要求 live Zero；
- 实现完成后执行一次独立源码与 Artifact 审查。

其他 Task Type 使用 deterministic fixtures 覆盖，不要求每类都运行昂贵的真实外部任务。

## 33. 回滚

- Activation 前不改变默认 writer。
- Activation commit 回滚后停止生成 Plan v3，新任务回到现有路径。
- Plan v3 Reader/Executor 保留，已确认任务可继续或明确暂停。
- 不删除 v3 Artifact/Contribution Ledger。
- 当前京东众筹旧 Task、Plan、Attempt 保留为 immutable baseline；Multi-Skill 验收使用新 Task，不覆盖。
- 不需数据库回滚。

## 34. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Skill 数量爆炸 | Coverage 最小集 + 现有 Profile/Usage Budget |
| Tool/Knowledge 重复 | 显式 shareable + fingerprint 去重 |
| Prompt/Context 爆炸 | scoped Contributor context + structured bundle |
| 结论冲突 | Conflict Set + Global Reviewer |
| 综合时丢内容 | Contribution Ledger + Multi-Skill Fidelity |
| Synthetic 冒充事实 | 强制 provisional + non-factual evidence class |
| Specialist 输入不足 | required input gate；无输入则 gap/plan，不编造 |
| 老任务回归 | Plan v1/v2、Report v1/v2 双读 |
| 成本不可控 | Portfolio Budget、并行上限、可见估算 |
| 当前 UI 过密 | Skill Group 折叠，内部 Stage 按需展开 |

## 35. Premise Collapse

本方案最脆弱的前提是：现有 Specialist Skills 能被可靠适配为标准 Contributor，并且它们的独立输出比一个 umbrella Skill 的重复推断更有价值。

如果某个 Skill 无法确定性映射 Question/Evidence/Confidence：

1. 不允许以猜测 Adapter 上线；
2. 修改该 Skill 输出合同或新建 answer-mode Contributor；
3. 在完成前保持 standalone；
4. Portfolio 对相关 Demand 返回明确 capability gap；
5. 不退回“把所有逻辑塞进 research-strategy-synthesis”。

## 36. 被拒绝方案

### 36.1 只删除 hardcode 并给所有 Skill 增加 research_synthesis

拒绝：输入/Schema/证据条件不兼容，最终无法安全合并。

### 36.2 继续扩充一个超级 Skill

拒绝：无法证明各专业能力独立执行，违背原始 multi-skill 需求。

### 36.3 让模型自由调用任意 Skill/Tool

拒绝：破坏 Registry、Plan 冻结、审批、预算和真实性。

### 36.4 每个 Skill 各写一份最终报告

拒绝：多真相源、重复、冲突、无法稳定 Review。

### 36.5 隐藏嵌套 Agent

拒绝：任务卡片与真实执行再次不一致。

## 37. 完成定义

```text
original multi-skill architecture restored            done
all active task types portfolio-capable               done
non-explicit direct_skill_bypass removed               done
Capability Demand Graph v1                         done
CurrentExecutionPlan v3                               done
multi-invocation dependencies and bindings            done
shared Tool/Knowledge dedup                           done
research-contribution-v1                              done
contribution-ledger-v1                                done
contributor → canonical fidelity                      done
canonical → report exact-once                         done
multi-LLM behavior preserved                          done
all active Skills composition-classified              done
JD crowdfunding multi-skill plan                      done
JD crowdfunding real execution                        done
all task type fixtures                                done
targeted milestones + final quality                  done
independent review                                    done
Zero automated regression                            done
single authorized merge/restart                       pending authorization
push                                                   withheld until authorized
```
