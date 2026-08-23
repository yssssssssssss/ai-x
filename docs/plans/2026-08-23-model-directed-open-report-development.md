# 模型编排的开放式动态报告开发方案

> 状态：Phase 1–7 源码已实现；本地全量门禁通过；六次无20分钟总限制的真实运行已逐步验证到最终语义 Review，当前已增加一次受限 Content Draft 语义修订；完整真实闭环待再次授权复跑。
>
> 日期：2026-08-23
>
> 实现提交序列：`118c13f`、`6c2d3ce`、`f8f409d` 及本状态更新提交
>
> 当前基线：`feat/research-answer-dynamic-reports@affb2cc5389ee19633684f0e4b1ded4f15398bcd`
>
> 对应执行清单：`docs/plans/2026-08-23-model-directed-open-report-todolist.md`
>
> 关联决策：`docs/adr/0004-separate-research-planning-from-answer-delivery.md`
>
> 本文只重新设计答案型 `research_strategy_report` 的内容合同、报告编排和真实验收运行方式；不改变“研究规划”和“直接研究回答”的任务语义边界。

## 1. 决策摘要

采用“**模型生成内容，模型编排版式，系统守住事实与完整性**”的方案：

```text
真实 Evidence + 已验证执行输出
              ↓
模型生成开放式 Content Draft（只写语义内容）
              ↓
系统确定性生成 ID、FindingGraph、Coverage、Risk、RequestedArtifactBindings
              ↓
Canonical Deliverable（唯一真相源）
              ↓ Review 通过
模型生成引用式 Layout Blueprint（只排顺序和分组，不写新结论）
              ↓ Blueprint 校验失败时自动使用确定性 fallback
ReportDocument v2
              ↓
Web / Markdown / ZIP / Zero
```

同时取消真实验收命令的 20 分钟**整任务总超时**。保留每次 Gateway、Tool、数据库和 Zero 调用自己的超时，以及执行 Lease 心跳，避免单个外部调用永久挂起。

本方案不采用任意 Markdown，也不允许模型自行发明 JSON Schema。模型只能选择受控的内容 Block，并自由决定章节标题、章节数量、章节顺序和 Block 组合。

## 2. 当前问题与已验证事实

### 2.1 当前答案型 Payload 仍然过度固定

当前 `schemas/deliverables/research-strategy-report.schema.json` 强制每份答案报告同时包含 17 个顶层字段，其中包括：

- `dynamicSections`
- `strategyMap`
- `mindModel`
- `designPrinciples`
- `opportunities`
- `prioritizedActions`
- `channelStrategies`
- `requestedArtifactBindings`

这意味着即使任务只需要直接答案和机会清单，模型也必须生成其余对象。相同内容还会同时出现在 `dynamicSections` 和专用字段中，产生重复表达和 ID 漂移。

### 2.2 当前 Composer 仍硬编码章节

`apps/orchestrator-runtime/src/report/dynamic-report-composer.ts` 固定构造：

1. Executive Answers
2. Priority Actions
3. 模型生成的 Dynamic Sections
4. Strategy Map
5. Mind Model
6. Design Principles
7. Opportunities
8. Channel Strategies
9. Evidence and Confidence
10. Limitations and Open Questions
11. Analysis Notes
12. Evidence Appendix

因此当前实现是“内容局部动态、整体骨架固定”，不是完整的模型编排报告。

### 2.3 同一报告被模型生成了两次

当前 compiled Skill 的 `compose-strategy-report` 阶段已经输出完整 `research_strategy_report` Payload，`self-review` 也已审校该 Payload。之后 `CurrentDeliverableService` 又调用一次 Deliverable LLM，把相同材料重新生成一遍。

真实任务 `b7d330bf-0712-4273-a87c-7b03ad579d7b` 已证明：

- Tool、Knowledge、LLM、Reviewer 和 `research-strategy-synthesis` Skill 的步骤 1–9 全部成功；
- Step 8 已生成完整直接答案、策略地图、心智模型、设计原则、机会点和优先行动；
- Step 9 已返回结构化 `pass_with_conditions`；
- 后续重复生成 Canonical Deliverable 时发生多轮校验修复；
- 第三轮生成期间，外层 20 分钟命令超时终止进程。

### 2.4 20 分钟不是产品合同

仓库没有“整个研究任务必须在 20 分钟内完成”的业务规则。本次终止来自验收命令的外层 `1200` 秒限制。进程退出后，Lease 正常过期，任务被回收为 `paused / worker_loss`。

### 2.5 当前失败信息不够可审计

Deliverable 每轮校验错误只保存在进程内，并作为下一轮 `validationFeedback` 发送给模型。任务结束后无法查询每轮失败的错误码、JSON Pointer 和所处阶段，导致真实问题难以精确复盘。

## 3. 目标

### 3.1 Primary Setpoint

答案型任务只生成一次语义内容；模型可根据问题与内容自由编排报告结构；系统自动完成所有机械索引和证据完整性校验。布局错误不得导致研究任务失败，内容或证据错误仍必须 fail closed。

### 3.2 成功标准

- 不存在整任务 20 分钟总超时。
- `research-strategy-synthesis` 的最终内容不再被另一个大型 LLM 调用全文重写。
- 不再要求每份报告都生成所有策略对象。
- 只有 `requested_artifacts` 指定的产物才必须出现。
- 模型可以决定章节标题、数量、顺序和分组。
- Report Layout 只能引用 Canonical Deliverable 节点，不能写入新事实。
- `requestedArtifactBindings`、Coverage、风险身份、Source Pointer 和聚合 Evidence 均由系统生成。
- 无效或超时的 Layout Blueprint 自动降级为确定性布局，不暂停任务。
- 内容缺失、未知 Evidence、遗漏必答问题、未披露风险仍然阻断。
- 历史 Research Strategy Payload v1、ReportDocument v1/v2、Plan v1/v2 保持可读。
- Web、Markdown、ZIP 和 Zero 使用同一个 ReportDocument，顺序一致。

## 4. 非目标

本次不做：

- 任意 Markdown、HTML 或任意 JSON 输出。
- 让 Report Composer 读取未经 Review 的 Step Artifact 文本。
- 让 Layout 模型新增、改写或删减研究结论。
- 放松 Evidence、置信度、风险披露或必答问题校验。
- 修改历史 SEALED Artifact。
- 将所有旧 Deliverable 一次迁移到新合同。
- 取消单次 Gateway、Tool、Zero 或数据库调用超时。
- 自动 push、创建 PR、合并或部署。
- 把 live Zero 缺失伪装成已通过。

## 5. “开放”与“固定”的明确边界

### 5.1 模型可以决定

- 报告有几个主题章节；
- 章节标题和说明；
- 章节先后关系；
- 一个章节包含哪些 Canonical Content Block；
- 使用叙事、比较矩阵、策略地图、心智模型、原则、机会或行动计划中的哪些表达方式；
- 非必需内容是否省略。

### 5.2 系统必须固定

- 每个 Required Question 必须有 Direct Answer；
- Direct Answer 必须有状态、置信度、业务含义、建议行动和验证需求；
- supported 事实必须引用已验证 Evidence；
- provisional 必须说明验证方式；
- 每个 requested artifact 必须由对应类型的非空 Block 满足；
- Reviewer 条件、能力降级和 Envelope 风险必须披露；
- Canonical Deliverable 是内容真相源；
- ReportDocument 不得引入 Canonical Deliverable 中不存在的新内容；
- Direct Answers 必须先于解释性分析；
- Limitations/Open Questions 和 Evidence Appendix 必须可见。

### 5.3 不允许模型负责

- Artifact、Section、Block 的全局稳定 ID；
- `requestedArtifactBindings`；
- `sourceField` 或 JSON Pointer；
- 聚合 Evidence 清单；
- Coverage 汇总；
- Reviewer/Risk 来源身份；
- Artifact、Task、Plan、Attempt ID；
- Capability Provenance。

## 6. 新合同：Research Strategy Content v2

### 6.1 版本策略

保留当前固定结构为 `ResearchStrategyReportPayloadV1`。新增带显式鉴别字段的 `ResearchStrategyReportPayloadV2`：

```ts
interface ResearchStrategyReportPayloadV2 {
  schemaVersion: 'research-strategy-content-v2';
  title: string;
  decisionContext: string;
  executiveAnswer: string;
  directAnswers: ResearchStrategyDirectAnswer[];
  contentBlocks: ResearchStrategyContentBlock[];
  limitations: string[];
  openQuestions: string[];
  riskDisclosures: ResearchStrategyRiskDisclosure[];       // 系统生成
  requestedArtifactBindings: RequestedArtifactBinding[];  // 系统生成
}
```

`ResearchDeliverableEnvelope` 继续作为稳定外壳。新写入使用 v2 Payload；读取时通过 `schemaVersion` 判断 v2，没有该字段的历史对象按 v1 读取。

Registry 明确区分：

```yaml
write_payload_schema: schemas/deliverables/research-strategy-report-v2.schema.json
read_payload_schemas:
  - schemas/deliverables/research-strategy-report.schema.json
  - schemas/deliverables/research-strategy-report-v2.schema.json
synthesis_mode: reviewed_skill_assembly
```

不得让写入端继续随机生成 v1 或 v2。

### 6.2 模型输出与最终 Payload 分离

模型输出 `ResearchStrategyContentDraftV2`，只包含：

```text
title
decisionContext
executiveAnswer
directAnswers
contentBlocks
limitations
openQuestions
```

模型输出 Schema 不接受：

```text
riskDisclosures
requestedArtifactBindings
coverage
findingGraph
capabilityProvenance
Task/Plan/Attempt/Artifact IDs
sourcePointers
```

这些字段全部由 `ResearchStrategyDeliverableAssembler` 生成。

### 6.3 类型化 Content Block

允许的 Block 类型固定，但数量和组合开放：

| Block kind | 内容 | 对应 requested artifact |
|---|---|---|
| `narrative` | 一组有支持状态的论断 | `research_report` |
| `evidence_findings` | 证据事实清单 | `research_report` |
| `comparison_matrix` | 行、列、单元格 | `research_report` |
| `strategy_map` | 维度和策略单元格 | `strategy_map` |
| `mind_model` | 节点和边 | `mind_model` |
| `design_principles` | 原则清单 | `design_principles` |
| `opportunity_backlog` | 机会清单 | `opportunity_backlog` |
| `prioritized_actions` | P0/P1/P2 行动 | `prioritized_actions` |
| `channel_strategies` | 渠道角色和策略 | `channel_strategies` |
| `action_plan` | 阶段、Owner、验证方式 | `action_plan` |

每个原子内容项统一携带：

```ts
interface SupportBinding {
  questionIds: string[];
  evidenceIds: string[];
  confidence: number;
  status: 'supported' | 'provisional';
  validationNeeded: string;
}
```

规则：

- `supported` 的 `evidenceIds` 非空且全部存在于 Evidence Manifest；
- `provisional` 的 `validationNeeded` 非空；
- 事实、策略、机会和行动都不能只依赖 Block 级聚合证据；
- Mind Model 内部节点使用 Block 局部 `nodeKey`，系统再生成全局 ID；
- 模型不生成全局 ID，避免不同数组之间的 ID 漂移。

### 6.4 只要求用户真正请求的产物

映射规则唯一且确定：

```text
executive_answers    → directAnswers
research_report      → 至少一个 narrative/evidence_findings/comparison_matrix Block
strategy_map         → strategy_map Block
mind_model           → mind_model Block
design_principles    → design_principles Block
opportunity_backlog  → opportunity_backlog Block
prioritized_actions  → prioritized_actions Block
channel_strategies   → channel_strategies Block
action_plan          → action_plan Block
```

未请求的 Block 可以由模型生成，但不是完成条件。请求的 Block 缺失时属于内容失败，不能用空章节或名称字符串代替。

## 7. Canonical Deliverable Assembler

新增深 Module：

```ts
assembleResearchStrategyDeliverable(input): ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2>
```

### 7.1 输入

- 已 SEALED、hash 验证通过的 `research-strategy-synthesis` Skill 输出；
- Step 9 结构化 Reviewer 输出；
- Finalized Requirement；
- ProblemGraph；
- Evidence Manifest；
- Gap、能力降级和 Provenance；
- Task、Plan、Attempt 身份。

### 7.2 实现责任

- 验证模型 Content Draft；
- 为 Section-independent Content Blocks 和内部 items 生成稳定 ID；
- 生成 FindingGraph；
- 生成 Recommendations；
- 生成 Question/Success Criterion Coverage；
- 从 Block 类型和内容生成 `requestedArtifactBindings`；
- 将 Requirement ambiguity、Skill degraded、Reviewer conditions 和 Envelope risks 精确合并为 `riskDisclosures`；
- 把对应 statement 放入 limitations/openQuestions；
- 填充 Capability Provenance；
- 最终执行 Payload Schema、Answer Quality 和 Evidence Integrity 校验；
- 成功后才写入 SEALED Canonical Deliverable。

### 7.3 删除重复的大型模型生成

对于 `research_strategy_report`：

```text
CurrentDeliverableService
  不再调用“大型 Deliverable 重写 LLM”
  改为调用 ResearchStrategyDeliverableAssembler
```

其他 Deliverable 暂时保持原有 `model_synthesis` 路径，不做无关迁移。

这会删除真实链路中最慢、最容易发生结构漂移的重复生成阶段。

## 8. 模型编排的 Layout Blueprint

### 8.1 Blueprint 只负责排版

Canonical Deliverable Review 通过后，`ReportLayoutPlanner` 向模型提供一个压缩索引：

```text
Block ID
Block kind
标题
关联 Question IDs
requested artifact 类型
内容重要级别
```

不发送完整 Prompt、敏感原始材料或未经 Review 的 Step Artifact。

模型返回：

```ts
interface ReportLayoutBlueprintV1 {
  version: 'report-layout-blueprint-v1';
  sections: Array<{
    title: string;
    purpose: string;
    prominence: 'primary' | 'supporting' | 'appendix';
    blockRefs: string[];
  }>;
}
```

Blueprint 不包含正文、结论、Evidence 文本或自由 Markdown，只引用 Canonical Block ID。

### 8.2 布局约束

- 所有 Direct Answer 在第一组 primary Section 中出现；
- Direct Answer 顺序与 Required Question 顺序一致；
- 每个 Canonical Content Block 在 full 报告中恰好出现一次；
- 不允许未知或重复 Block Ref；
- requested artifact 对应 Block 不得进入 appendix；
- limitation/open question 与 Evidence Appendix 由系统追加；
- 空 Section 自动删除；
- 模型可自由决定其余章节标题、分组和顺序。

### 8.3 布局失败不再导致任务失败

以下情况统一使用确定性 fallback：

- Layout LLM 超时；
- 输出不是合法 JSON；
- 引用了未知 Block；
- 重复或遗漏 Block；
- 把 Direct Answer 放到分析之后；
- 产生空章节。

Fallback 顺序：

```text
直接答案
→ 按 Canonical Content Block 原始顺序生成动态章节
→ 局限与待解决问题
→ Evidence Appendix
```

Layout 错误记录为可观察的降级信息，但 Canonical Deliverable 和研究任务仍可完成。

## 9. ReportDocument 与多端渲染

### 9.1 保持 ReportDocument v2

现有 ReportDocument v2 已支持动态 `sections[]` 和类型化 `answer` Block，不新增 v3。Composer 改为：

```text
Canonical Deliverable v2 + Valid Blueprint
                     ↓
按 Blueprint 引用顺序投影 Canonical 内容
                     ↓
ReportDocument v2
```

### 9.2 Composer 不再硬编码业务章节

删除 `dynamic-report-composer.ts` 中固定插入 Priority Actions、Strategy Map、Mind Model、Principles、Opportunities、Channel Strategies 等业务章节的逻辑。

Composer 只固定：

- Direct Answers 必须在前；
- Limitations/Open Questions 必须可见；
- Evidence Appendix 必须在末尾；
- 所有文本必须来自 Canonical Deliverable；
- source pointers、Finding/Summary IDs 和 Evidence IDs 由系统投影。

### 9.3 多端一致

Web、Markdown、ZIP 和 Zero 必须逐 Section 使用 ReportDocument 顺序，不再依赖 `strategy-map`、`priority-actions` 等固定 Section ID。

UI 分类页签按 Block kind 和 `prominence` 派生，而不是按硬编码 Section ID 判断。

## 10. 内容失败与布局失败分离

### 10.1 必须阻断任务的内容错误

- Required Question 没有 Direct Answer；
- requested artifact 对应 Block 缺失或为空；
- supported 内容引用未知 Evidence；
- provisional 内容没有验证说明；
- 事实越过 Evidence 支持范围；
- Reviewer block；
- Artifact hash、Task/Plan/Attempt 绑定或安全检查失败；
- 必须披露的风险被遗漏。

### 10.2 不得阻断任务的布局错误

- 章节标题不理想；
- 章节数量过多或过少；
- Layout LLM 超时；
- Blueprint Schema 不合法；
- Block 分组或顺序违反布局规则；
- 可选章节未生成。

这些情况必须 fallback，并在 Report Package 中标记：

```text
layoutMode: fallback
layoutWarnings: [...]
```

## 11. 取消整任务 20 分钟限制

### 11.1 执行规则

真实验收命令不再设置 shell/tool 的整任务截止时间。运行持续到以下任一终态：

```text
completed
completed_with_gaps
paused
cancelled
明确的单调用 timeout/failure
```

### 11.2 保留的安全边界

- `LLM_GATEWAY_TIMEOUT_MS`：单次 Gateway 请求上限；
- Tool manifest `timeout_seconds`：单次 Tool 请求上限；
- Zero MCP 单次调用超时；
- 数据库连接/查询错误；
- Lease heartbeat 和 worker-loss 检测；
- 用户主动取消。

取消总时限不等于允许单个外部调用无限挂起。

### 11.3 真实 Smoke 可观察性

`scripts/current-real-smoke.ts` 增加阶段化输出：

```text
任务 ID / Attempt ID
当前状态
开始和完成的 Step
Model stage / requested model / elapsed time
Deliverable 校验轮次与脱敏错误码
Report Review / Compose / Package 状态
```

不得输出 API Key、完整 Prompt、原始敏感材料或完整未审核模型响应。

## 12. 校验诊断持久化

新增 `deliverable-validation-diagnostic-v1` Artifact，使用现有 `control_artifacts`，不增加数据库表。

内容：

```ts
interface DeliverableValidationDiagnosticV1 {
  version: 'deliverable-validation-diagnostic-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  stage: 'content_schema' | 'content_semantics' | 'canonical_assembly' | 'layout_blueprint';
  round: number;
  issues: Array<{
    code: string;
    jsonPointer?: string;
    message: string; // 必须脱敏、限长
  }>;
  fallbackApplied: boolean;
}
```

规则：

- 不保存完整 Prompt；
- 不保存完整失败响应；
- 不保存凭据或原始用户材料；
- 每轮错误都有明确 stage 和 code；
- Content 失败可用于下一轮修复；
- Layout 失败只记录并 fallback。

## 13. 兼容策略

### 13.1 写入

- 新 `research_synthesis` 任务只写 Payload v2；
- 其他 Deliverable 不变；
- ReportDocument 仍写 v2；
- Report Package 增加可选的 Layout Blueprint 与 Diagnostic Artifact 引用。

### 13.2 读取

- 历史无 `schemaVersion` 的 Research Strategy Payload 按 v1；
- v1 继续使用 legacy composer；
- v2 使用 Blueprint composer；
- ReportDocument v1/v2 继续读取；
- 历史 Report Package 不要求新增字段。

### 13.3 回滚

Registry 保留 v1 reader 和 v2 reader。若新写入路径出现问题：

1. 将 `synthesis_mode` 切回 `model_synthesis`；
2. 将 `write_payload_schema` 切回 v1；
3. 保留 v2 reader，使已产生的新 Artifact 仍可读取；
4. 不修改或删除任何历史 SEALED Artifact。

不需要数据库 Migration。

## 14. Module 与 Seam

### 14.1 `ResearchStrategyDeliverableAssembler`

小 Interface：接收已验证材料和合同上下文，返回 Canonical Deliverable。内部隐藏 ID 分配、Graph、Coverage、Risk、Binding 和 Provenance 逻辑。

### 14.2 `ReportLayoutPlanner`

小 Interface：接收 Canonical Content Index，返回已验证 Blueprint 或 fallback。调用方不需要理解模型错误、引用完整性或 fallback 规则。

### 14.3 `ResearchStrategyReportProjector`

小 Interface：接收 Canonical Deliverable 和 Blueprint，返回 ReportDocument v2。不得调用 LLM，不得生成新结论。

### 14.4 不新增无意义 Seam

Web、Markdown 和 Zero 继续消费同一个 ReportDocument，不分别实现“智能排版”。布局智能只存在于 `ReportLayoutPlanner`。

## 15. 预计文件范围

### 15.1 新增

```text
docs/adr/0005-model-directed-typed-report-layout.md
schemas/deliverables/research-strategy-report-v2.schema.json
schemas/report-layout-blueprint.schema.json
apps/orchestrator-runtime/src/report/research-strategy-deliverable-assembler.ts
apps/orchestrator-runtime/src/report/report-layout-planner.ts
apps/orchestrator-runtime/src/report/research-strategy-report-projector.ts
apps/orchestrator-runtime/src/report/deliverable-validation-diagnostic.ts
orchestrator/prompts/report-layout/research-strategy.md
tests/research-strategy-v2-contract.test.ts
tests/research-strategy-deliverable-assembler.test.ts
tests/report-layout-planner.test.ts
tests/research-strategy-report-projector.test.ts
```

### 15.2 修改

```text
CONTEXT.md
packages/api-contract/research-deliverable.ts
packages/api-contract/control-workflow.ts
schemas/skill-result-envelope.schema.json
schemas/report-package.schema.json
orchestrator/deliverable-registry.yaml
orchestrator/skill-registry.yaml
orchestrator/skill-executions/research-strategy-synthesis.yaml
orchestrator/prompts/deliverables/research-strategy-report.md
apps/orchestrator-runtime/src/runtime/skill-loader.ts
apps/orchestrator-runtime/src/report/deliverable-registry.ts
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
apps/orchestrator-runtime/src/report/answer-quality-validator.ts
apps/orchestrator-runtime/src/report/dynamic-report-composer.ts
apps/orchestrator-runtime/src/report/report-document-composer.ts
apps/orchestrator-runtime/src/report/report-projection.ts
apps/orchestrator-runtime/src/report/report-review-service.ts
apps/orchestrator-runtime/src/report/report-package-artifact.ts
apps/orchestrator-runtime/src/report/current-report-package-reader.ts
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
apps/agent-api/src/routes/system-capabilities.ts
apps/web/src/reporting/report-document-view-model.ts
apps/web/src/reporting/ReportDocumentView.tsx
apps/web/src/reporting/report-bundle.ts
apps/agent-api/src/integrations/zero/zero-report-renderer.ts
scripts/current-real-smoke.ts
```

预计涉及约 25–35 个源码、Schema、配置和测试文件。只在当前集成分支实施，最终仍一次性合并。

## 16. 实施阶段

### Phase 0：冻结基线与失败证据

- 以 `affb2cc5389ee19633684f0e4b1ded4f15398bcd` 为基线；
- 保存真实任务 `b7d330bf-0712-4273-a87c-7b03ad579d7b` 的脱敏阶段时间线；
- 将当前 v1 Payload 和固定 Composer 行为固化为兼容测试；
- 新能力保持 inactive，不改变现有写入路径。

### Phase 1：Content v2 合同

- 增加 v1/v2 TypeScript union；
- 增加 v2 Schema 和受控 Block union；
- 分离 Model Draft 与 Canonical Payload；
- Registry 支持 write schema 与 legacy read schemas；
- 建立 requested artifact 到 Block kind 的确定性映射。

### Phase 2：确定性 Canonical Assembler

- 从已验证 Skill 输出构造 v2 Deliverable；
- 生成稳定 ID、FindingGraph、Recommendations 和 Coverage；
- 生成 requested artifact bindings；
- 合并 Reviewer 条件和风险披露；
- `research_strategy_report` 删除重复的大型 Deliverable LLM 重写；
- 其他 Deliverable 路径保持不变。

### Phase 3：模型 Layout Blueprint 与 fallback

- 在最终 Review 通过后调用轻量 Layout Planner；
- 只发送 Canonical Content Index；
- 严格校验引用、覆盖、顺序和空章节；
- 无论超时或结构错误都使用 deterministic fallback；
- 持久化 Blueprint 或 fallback 原因。

### Phase 4：ReportDocument、多端和兼容

- Composer 按 Blueprint 顺序投影；
- 移除固定业务 Section 拼装；
- Web 页签按 Block kind/prominence 派生；
- Markdown、ZIP 和 Zero 保持相同顺序；
- v1 Payload 和历史 ReportDocument 保持原渲染。

### Phase 5：诊断与无总时限验收

- 持久化脱敏 Deliverable/Layout 校验诊断；
- Smoke 输出实时阶段进度；
- 真实验收不设置整任务总超时；
- 单次 Gateway/Tool 调用仍有明确超时；
- Layout 降级不改变任务完成状态。

### Phase 6：Activation 与一次性发布

- 新写入路径从 inactive 切为 active；
- 全量源码门禁；
- 真实 Gateway/数据库/Tavily 闭环；
- 浏览器、Markdown/ZIP 和 live Zero 验收；
- 外部门禁通过后才允许一次性合并到 `main`；
- 合并后重启 API/Web 并再次验证；
- 未经明确授权不 push。

## 17. 测试矩阵

| 场景 | 预期 |
|---|---|
| 只请求 executive answers | 不强制生成策略地图等可选 Block |
| 请求 strategy map | 至少一个非空 `strategy_map` Block |
| 同类任务产生不同章节标题/顺序 | 均可通过且按 Blueprint 展示 |
| supported 内容无 Evidence | Content Gate 阻断 |
| provisional 内容无 validationNeeded | Content Gate 阻断 |
| Blueprint 引用未知 Block | fallback，任务不失败 |
| Blueprint 遗漏 Block | fallback，任务不失败 |
| Layout Gateway 超时 | fallback，任务不失败 |
| Reviewer 有条件通过 | 条件自动进入风险和局限/待解决问题 |
| Skill degraded | 报告明确披露，不静默完成 |
| 历史 v1 Strategy Payload | 原样读取和展示 |
| ReportDocument v1/v2 | 均保持可读 |
| Web/Markdown/Zero | Section 顺序与内容一致 |
| 真实运行超过20分钟 | 不因总时长被终止，Lease 持续心跳 |
| 单次 Gateway 超时 | 结构化失败或 fallback，不永久挂起 |
| 未知/伪造 Evidence ID | fail closed |

## 18. 发布门禁

### 18.1 本地源码门禁

```bash
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm exec tsx --test \
  tests/research-strategy-v2-contract.test.ts \
  tests/research-strategy-deliverable-assembler.test.ts \
  tests/report-layout-planner.test.ts \
  tests/research-strategy-report-projector.test.ts \
  tests/research-strategy-contract.test.ts \
  tests/current-deliverable-service.test.ts \
  tests/report-review-service.test.ts \
  tests/report-document.test.ts \
  tests/report-package.test.ts \
  tests/report-bundle.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/current-real-smoke.test.ts
pnpm --dir apps/web build
pnpm quality
git diff --check
```

### 18.2 真实环境门禁

同一 pet-mindshare 场景必须验证：

- Requirement v2 和 ProblemGraph 持久化；
- Current Plan v2 包含 compiled Skill invocation；
- 真实 Tavily 和 Knowledge Artifact 存在；
- 所有计划步骤成功或以可解释 gap 结束；
- 只生成一次完整研究内容；
- Canonical Deliverable v2 SEALED；
- Direct Answers 覆盖 Required Questions；
- requested artifacts 全部由真实 Content Block 满足；
- requested artifact bindings 由系统生成且与内容一致；
- Layout Blueprint 有效，或明确使用 fallback；
- ReportDocument v2、Report Review 和 Report Package SEALED；
- Web 默认答案视图可读；
- Markdown/ZIP 内容完整；
- live Zero 可用时完成发布；不可用时必须记录外部门禁例外，不能写成通过；
- 整个运行不设置总时限。

### 18.3 合并与部署门禁

- 所有源码门禁通过；
- 真实 Gateway/数据库/Tavily 闭环通过；
- live Zero 通过或取得明确例外授权；
- 工作区干净；
- 得到明确 merge/restart 授权；
- 一次性合并，不单独合并中间分支；
- 重启后 `/api/system/capabilities` 显示新 writer schema、legacy readers 和 layout blueprint 版本；
- 未经明确授权不 push。

## 19. 风险与应对

### 19.1 模型布局质量波动

应对：Blueprint 只引用内容；严格校验；失败自动 fallback；布局永不成为内容完成阻断条件。

### 19.2 Block 类型过多导致 Schema 再次复杂

应对：共用 `SupportBinding`；每个 Block 只保留其真实数据结构；机械聚合字段全部由系统生成；首版只支持上述 10 种类型。

### 19.3 确定性 Graph 推导丢失语义

应对：原子内容项必须声明 Question 和 Evidence 关系；Assembler 只转换显式关系，不使用关键词猜测。

### 19.4 v1/v2 读取漂移

应对：读取和写入 Schema 分离；固定历史 fixtures；新写入只能为 v2；回滚只切 writer，不删除 v2 reader。

### 19.5 无总时限导致永久等待

应对：只取消整任务 deadline；保留每个外部调用 timeout、Lease heartbeat、用户取消和 worker-loss 回收。

### 19.6 外部依赖不可用

应对：Gateway/Tavily 按现有失败分类处理；Layout Gateway 不可用时 fallback；内容 Gateway 或核心 Tool 不可用时保持基础设施失败，不伪造结果。

## 20. 被拒绝的方案

### 20.1 完全自由 Markdown

拒绝。无法可靠校验证据、必答问题和请求产物，也无法稳定支持 Web、ZIP 和 Zero。

### 20.2 继续保留固定 Payload，只修改页面顺序

拒绝。只能改善外观，不能消除重复内容、模型生成机械索引和最终 Deliverable 重写失败。

### 20.3 让 Layout 模型重新总结正文

拒绝。会产生第二份未经同等 Review 的事实表达，破坏 Canonical Deliverable 的真相源地位。

### 20.4 删除所有超时

拒绝。取消的是整任务 20 分钟限制；单调用超时仍是必要的资源和故障隔离机制。

## 21. Premise Collapse

本方案假设 `research-strategy-synthesis` 最终 Skill 阶段能够稳定生成一个比当前固定 Payload 更小的类型化 Content Draft。

如果该假设不成立，Content Gate 仍会失败，但失败会被精确记录，且不会再混入 Layout 错误。此时应改为让现有多个分析步骤分别输出统一 Content Node，再由 Assembler 汇总；不得退回“大模型一次性重写完整报告”的旧方案。

## 22. 实施结果（2026-08-23）

已实现：

- 新增严格分离的 Skill Content Draft v2 与 Canonical Payload v2 Schema；
- Deliverable Registry 分离当前 writer 与历史 reader，并以 Payload 版本选择读取 Schema；
- `research_strategy_report` 使用 reviewed Skill assembly，不再进行第二次完整 Deliverable LLM 重写；
- Assembler 确定性生成全局 ID、FindingGraph、Recommendations、Coverage、风险身份和 requested artifact bindings；
- 对模型的 Evidence 简写、来源步骤前缀和矩阵轴漂移做确定性规范化；Knowledge-only 结论自动降为 provisional；
- 新增引用式 Layout Blueprint、严格引用校验和 deterministic fallback；
- ReportDocument v2、Web、Markdown、ZIP 与 Zero 使用动态 Section 顺序；
- Blueprint 和布局诊断进入 Report Package 的绑定 Artifact 集；
- 真实 Smoke 取消20分钟整任务限制，并每30秒输出脱敏阶段进度；
- 历史 Strategy Payload v1、ReportDocument v1/v2 和其他 Deliverable 路径保持兼容。

真实环境记录：

- `38762147-f639-4043-ad3d-4b5ae45af19a`：首次无总时限运行在组装阶段发现 `E1` Evidence 简写，已修复；
- `e9e596c2-d772-471c-96f2-788d2efe101e`：发现 provisional finding 缺少事实根，已改为由真实公开 Evidence 生成来源锚点；
- `1000e959-e970-4f40-aa1a-60e2026f7615`：发现 `E2-3/E2-5` 与 Knowledge `K2-3/K2-5` 的来源前缀漂移，已确定性映射并将 Knowledge-only finding 降为 provisional；该任务的真实 Artifact 已离线重放通过 Canonical Assembly、ReportDocument Schema、Projection Integrity 和引用校验；
- `8b1956ee-4308-4974-ba0c-484a0841396b`：模型引用不存在的 `E1-13`；该引用不能被安全猜测，已新增一次受限 `deliverable_repair`，只允许从精确 Question/Evidence 白名单修正 Content Draft，仍不恢复完整报告重写；
- `9e5b3a75-6989-48d9-8b89-fb2655ef5e64`：Requirement 模型调用成功但输出未通过后续结构/语义校验，未写 Requirement Version，也未进入 Tool；Requirement 现允许一次携带脱敏校验反馈的受限重试；
- `ee5ba760-39ea-42f0-aa1a-60e2026f7615`：Canonical Deliverable v2 已成功 SEALED，证明重复全文生成已经移除且组装门禁通过；最终 `report-review-v2` 返回 `revise`，指出部分 provisional 策略措辞仍偏强；现已实现一次只修改 Content Draft、并重新执行确定性组装与最终 Review 的受限语义修订；
- 最新本地门禁为 1671 tests、1656 pass、15 skip、0 fail；
- 按真实配额约束，受限语义修订后的完整真实闭环尚未再次运行。

## 23. 完成定义

```text
20-minute whole-run timeout removed                 done
per-call safety timeout retained                    done
research strategy content v2 contract               done
model/machine-owned fields separated                done
reviewed Skill output assembled without rewrite     done
mechanical IDs/graph/coverage/risk/bindings derived done
model-directed layout blueprint                     done
invalid layout deterministic fallback               done
hard-coded business sections removed for v2         done
ReportDocument v2 retained                           done
Web/Markdown/ZIP/Zero source paths aligned           done
v1/v2 historical compatibility                      done
sanitized validation diagnostics                    done
full source quality gate                             done
real Gateway/DB/Tavily no-total-timeout gate         pending final rerun
live Zero gate or explicit exception                 pending
single merge/restart authorization                   withheld
push authorization                                   withheld
```
