# Step 10 无损 Canonical Deliverable 编译与内容保真开发方案

> 状态：已批准，待实施
>
> 日期：2026-08-24
>
> 实施分支：`feat/research-answer-dynamic-reports`
>
> 基线提交：`560457c7fa57e8475fae2f819032130e7d38512c`
>
> 关联文档：
> - `docs/adr/0004-separate-research-planning-from-answer-delivery.md`
> - `docs/adr/0005-model-directed-typed-report-layout.md`
> - `docs/plans/2026-08-23-model-directed-open-report-development.md`
> - `docs/plans/2026-08-23-model-directed-open-report-todolist.md`

## 1. 决策摘要

保留 Step 10，但将其从“可能重新生成整份报告的阻断式末端步骤”收敛为：

> **无损 Canonical Deliverable 编译器 + 分级真实性门禁**

目标流水线：

```text
Steps 1–7：证据、分析、答案、策略对象、行动
                    ↓
Step 8：Reviewed Semantic Content Draft
                    ↓
内容单元快照 + 确定性规范化
                    ↓
结构/引用问题可解？── 是 ──→ 直接组装
         │
         否
         ↓
一次 typed patch repair（禁止全文重写）
         ↓
内容保真校验 + Evidence/Question/Coverage 校验
         ↓
Canonical Deliverable（唯一真相源）
         ↓
最终语义 Review
         ↓
Layout Blueprint（只排序和分组）
         ↓
ReportDocument / Web / Markdown / ZIP / Zero
```

不删除 Step 10，因为它负责证据真实性、Coverage、FindingGraph、风险和 Artifact 身份，而不仅是格式。但 Step 10 不再允许为了满足结构约束而自由重写、压缩或删除已审校内容。

## 2. 已验证的当前状态

### 2.1 Step 10 当前职责

当前 Step 10 负责：

- 将 `research-strategy-content-draft-v2` 组装为 Canonical Deliverable；
- 校验 Question ID 和 Evidence ID；
- 生成全局稳定 ID；
- 生成 FindingGraph、Recommendations 和 Coverage；
- 生成 `requestedArtifactBindings`；
- 合并 Requirement、Skill、Reviewer 和 Envelope 风险；
- 验证 Evidence Manifest 与 Artifact 归属；
- 成功后写入 SEALED Deliverable。

因此它不是纯排版步骤。删除后将失去报告真实性与可追溯性的核心边界。

### 2.2 真正的排版阶段在 Step 10 之后

`ReportLayoutPlanner` 只负责章节顺序、分组、标题和 prominence。当前已有以下硬约束：

- 每个 Canonical Content Block 必须恰好被引用一次；
- 未知或重复 Block 引用被拒绝；
- requested artifact Block 不得放入 appendix；
- Layout 失败使用确定性 fallback，不阻断内容交付。

`ResearchStrategyReportProjector` 会投影：

- 所有 Direct Answers；
- 所有 Canonical Content Blocks 及其内部 items/cells/nodes/edges；
- 所有 Evidence Findings；
- 所有 Limitations、Open Questions 和 Risk Disclosures；
- Evidence Appendix。

因此，Canonical Payload 之后的布局与渲染不会主动删掉合法 Block。

### 2.3 当前真实任务的内容规模

任务 `62b7ca71-0172-486a-9bfc-e4ea3d2e58f2` 的最新 Step 8 Draft 包含：

```text
约 27,856 字符
7 个 Direct Answers
7 个 Evidence Findings
7 个 Content Blocks
约 60 个结构化节点、单元格或行动项
5 个 Limitations
6 个 Open Questions
```

在当前基线代码下，用该 Attempt 的真实 Step 3、Step 4、Step 8、ProblemGraph 和 Evidence Manifest 回放 Step 10，结果为：

```text
PASS_WITHOUT_LLM_REPAIR
Direct Answers: 7
Evidence Findings: 7
Content Blocks: 7
FindingGraph Facts: 9
FindingGraph Analyses: 14
```

说明当前确定性 ID/Evidence 修复本身没有压缩上述内容。

### 2.4 仍然存在的内容保真风险

风险存在于两个更早的模型边界：

1. Step 8 将 Steps 3–7 的工作材料综合成 Content Draft 时，可能遗漏有价值的决策内容；
2. 当前 assembly repair 和 final semantic revision 都要求模型返回一份完整 Draft，模型可能为了修一个字段而重写、合并或删除其他内容。

当前系统能保证“进入 Canonical Payload 的 Block 不被 Layout 删除”，但尚不能机械证明“repair 前后的所有语义内容均被保留”。

## 3. 目标与成功标准

### 3.1 Primary Setpoint

Step 10 只编译、规范化和验证已审校内容；结构修复必须通过受限 Patch 完成，不能全文重写。最终报告应完整保留所有审校后的决策相关内容，同时继续拒绝伪造证据、越权内容和不可验证的 supported 结论。

### 3.2 “内容完整”的精确定义

必须保留：

- 每个 Required Question 的 Direct Answer；
- 每个 Direct Answer 的答案、业务含义、建议行动和验证需求；
- Step 8 中每个 Evidence Finding；
- 每个 Content Block；
- Block 内每个 item、cell、node 和 edge；
- 所有 Limitations 和 Open Questions；
- 每个 requested artifact 对应的实际内容；
- Reviewer conditions 和能力降级信息。

不要求逐字保留：

- Steps 3–7 的重复分析；
- 已被 Reviewer 否决或降级的旧措辞；
- 推理草稿、过程说明和重复引用；
- 未进入 Step 8 Reviewed Content Draft 的临时文本。

本方案保护的是“审校后的决策语义单元”，不是机械拼接所有中间 Token。

### 3.3 完成标准

- Step 10 的结构修复不再返回或接受整份重写 Draft；
- 修复前已存在的语义单元不能被删除；
- 结构修复不能改变正文、结论、行动或标题；
- 所有合法 ID 归一化在模型调用前完成；
- 可恢复的格式与引用问题不得阻断报告；
- 无法恢复的真实性、安全性和核心内容问题继续 fail closed；
- Layout 不得遗漏任何 Canonical Content Block；
- 每次修复前后都有可审计的内容保真结果；
- 历史 Payload v1/v2、ReportDocument v1/v2 和既有任务继续可读；
- 当前三次 Step 10 失败快照全部通过离线回放；
- 新真实任务完成 Canonical Deliverable、Review、Layout、ReportDocument 和 Package 全链路。

## 4. 非目标

本方案不做：

- 删除 Step 10；
- 直接把未经 Canonical 校验的 Step Artifact 当作正式报告；
- 将 Steps 3–7 原文全部拼接进报告；
- 放宽 supported Evidence 真实性要求；
- 将 Knowledge 自动提升为事实来源；
- 为通过校验而伪造 Evidence 或 Question 绑定；
- 允许 Layout 模型新增、改写或删除正文；
- 修改历史 SEALED Artifact；
- 修改其他 Deliverable 的生成方式；
- 新增外部 API、数据库表或迁移；
- 自动 push、合并或部署。

## 5. 失败分类与处理策略

### 5.1 可确定性恢复，不阻断

| 问题 | 处理 |
|---|---|
| `E1` 等文档化简称 | 映射到唯一 Manifest ID |
| `E2-*` 实际对应 `K2-*` | 按唯一来源步骤映射 |
| `Q6_design_principles系统` 等安全别名 | 按唯一序号和兼容语义骨架规范化 |
| provisional 绑定为空，但上游同 Question 有精确、已验证 Evidence ID | 恢复绑定，保持 provisional |
| 矩阵 rows/columns 未列出已有 cell 维度 | 从 cell 确定性补齐 |
| Layout 缺失、重复、超时或非法 | 使用 deterministic fallback |

### 5.2 允许一次 typed patch repair

- 缺少用户明确请求的 Content Block；
- 某个 required question 缺少 Direct Answer，但上游已存在该问题的审校答案；
- 某个结构化 item 缺少必要 support；
- Reviewer 明确要求弱化某个现有结论；
- Reviewer 明确要求增加 limitation/open question。

### 5.3 必须阻断

- Artifact 未 SEALED、hash 不匹配或跨 Task/Plan/Attempt；
- supported 内容没有事实 Evidence；
- 引用了无法唯一、安全解析的未知 Question/Evidence ID；
- required question 在所有已审校来源中都没有答案；
- requested artifact 没有可恢复内容；
- Reviewer verdict 为 block；
- 敏感数据、授权或安全规则失败；
- typed patch 试图删除内容或修改未授权字段；
- 修复后内容保真校验失败。

阻断时保留完整 Reviewed Draft 作为内部 Artifact，但不得将其伪装成正式 Canonical Deliverable 或允许外部发布。

## 6. 核心设计

### 6.1 Step 10 改为纯编译边界

`ResearchStrategyDeliverableAssembler` 只允许以下操作：

- 复制 Step 8 的语义字段；
- 将局部 key 替换为全局稳定 ID；
- 规范化安全可证明的 Question/Evidence alias；
- 为 provisional 内容恢复已存在于上游 Question Evidence Index 的绑定；
- 生成机器拥有的 Graph、Coverage、Risk 和 Provenance；
- 增加必要的风险披露；
- 扩展由现有 cell 明确使用、但未列入 rows/columns 的轴值。

禁止：

- 压缩正文；
- 改写结论；
- 合并或删除内容项；
- 改写行动和理由；
- 为 unsupported 内容虚构 Evidence；
- 根据关键词自行判断两个不同语义单元“等价”。

### 6.2 Content Unit Inventory

新增内部模块：

```text
apps/orchestrator-runtime/src/report/research-strategy-content-fidelity.ts
```

为 Step 8 Draft 建立内容单元清单：

```ts
interface ContentUnitFingerprint {
  sourceKey: string;
  kind:
    | 'direct_answer'
    | 'evidence_finding'
    | 'content_block'
    | 'block_item'
    | 'matrix_cell'
    | 'mind_node'
    | 'mind_edge'
    | 'limitation'
    | 'open_question';
  semanticHash: string;
  parentKey?: string;
}
```

`semanticHash` 只覆盖模型负责的语义字段，不包含允许系统改变的字段：

```text
不计入 hash：
ID、questionIds、evidenceIds、status、confidence、validationNeeded、Coverage、Risk、Provenance

计入 hash：
question、answer、statement、title、content、businessImplication、recommendedAction、
action、rationale、ownerType、validationMethod、row、column、label、description、relationship、strategies
```

### 6.3 内容保真规则

普通 assembly 与结构 repair 后必须满足：

- 原始 Direct Answer 的 Question 集合不减少；
- 原始 Evidence Finding key 不减少；
- 原始 Content Block key 不减少；
- 原始 item/cell/node/edge key 不减少；
- 所有保留单元的 `semanticHash` 不变；
- 原始 Block 顺序不变；
- 新增内容只能用于补齐缺失 requested artifact；
- 新增 Block 必须使用新的局部 key，不能覆盖原 Block；
- Limitations/Open Questions 只能保留或追加，不能删除。

最终语义 Review 的修订允许修改正文，但必须通过显式 Patch 操作留下目标和原因，不能隐式替换整份 Draft。

## 7. Typed Patch Repair

### 7.1 新合同

新增内部 Schema：

```text
schemas/skills/research-strategy-content-patch-v1.schema.json
```

建议合同：

```ts
interface ResearchStrategyContentPatchV1 {
  version: 'research-strategy-content-patch-v1';
  mode: 'structural_repair' | 'semantic_revision';
  operations: Array<
    | ReplaceSupportOperation
    | AppendContentBlockOperation
    | AppendBlockItemOperation
    | ReplaceSemanticFieldOperation
    | AppendLimitationOperation
    | AppendOpenQuestionOperation
  >;
}
```

### 7.2 Structural Repair 白名单

允许：

- 替换 `questionIds`；
- 替换 `evidenceIds`；
- 将 `supported` 降级为 `provisional`；
- 补充或修改 `validationNeeded`；
- 补齐缺失的 requested artifact Block；
- 向缺失的 requested Block 追加必要 item。

禁止：

- 删除任何原始内容单元；
- 修改已有 answer/statement/action/rationale/title；
- 提升 `provisional → supported`；
- 引用白名单外 Question/Evidence；
- 修改机器拥有的字段；
- 重排原始 Block 或 item。

### 7.3 Semantic Revision 白名单

最终 Review 要求修订时允许：

- 修改 Review 明确指向的语义字段；
- 降低结论强度；
- 增加验证条件；
- 增加 limitation/open question；
- 调整行动表述以消除未支撑承诺。

仍然禁止：

- 删除 Direct Answer；
- 删除 requested artifact Block；
- 删除未被 Review 指向的内容单元；
- 删除已有 Evidence；
- 新增无法追溯的事实；
- 改写 Task/Plan/Artifact 身份或 Coverage。

### 7.4 Patch 应用顺序

```text
验证 patch schema
→ 验证 operation 类型符合当前 mode
→ 解析稳定 target key
→ 校验 Question/Evidence 白名单
→ 在原 Draft clone 上应用 patch
→ 运行 Content Fidelity Gate
→ 运行完整 Schema/Evidence/Coverage Gate
```

不得把模型返回的完整 Draft 直接替换原 Draft。

## 8. Question Evidence Index

### 8.1 目的

解决“上游已经引用真实 Evidence，但 Step 8 的结构化 `evidenceIds` 为空”的问题，同时避免把任意来源绑定到任意结论。

### 8.2 生成规则

系统从 Step 8 之前的已 SEALED LLM 输出中提取：

```text
精确 ProblemGraph Question 标题
        ↓
该标题范围内出现的完整 Evidence ID
        ↓
只保留最终 sealed Evidence Manifest 中存在的 ID
```

生成内存中的：

```ts
Map<QuestionId, EvidenceId[]>
```

约束：

- 只识别完整 ID，不做任意文本相似度匹配；
- `E1-1` 不得错误匹配 `E1-10`；
- 只用于为空的 provisional binding；
- 不用于 supported 内容；
- 不改变正文；
- 不把 Knowledge 升级为事实；
- Question 下没有 factual Evidence 时仍然阻断事实根建立。

### 8.3 Evidence ID 签发一致性

模型可见的 `prior_outputs[].evidenceIds` 必须与最终 Manifest 使用同一筛选规则：

- 只为可寻址、通过策略检查的 HTTPS Tool result 签发 `E{step}-{index}`；
- Knowledge resource 必须具有合法 ID 和 content hash 才签发 `K{step}-{index}`；
- 被 Manifest 排除的结果不得提前向模型宣告可用 ID。

## 9. 分级结果而不是格式性全阻断

### 9.1 Canonical 完成

满足所有真实性、内容和 Coverage 约束时生成正式 Deliverable。

### 9.2 内容完整但布局失败

继续使用现有 deterministic Layout fallback，任务完成并记录：

```text
layoutMode: fallback
layoutWarnings: [...]
```

### 9.3 内容存在但真实性门禁失败

不生成正式 Deliverable，但保留：

- SEALED Step 8 Content Draft；
- Step 9 Reviewer 结果；
- r0/r1 脱敏诊断；
- Content Fidelity Diagnostic；
- UI 中只读的“未通过交付门禁”摘要。

该内容不能被标记为正式报告，也不能发布到 ZIP/Zero。这样既不丢失工作内容，也不把未验证内容伪装为完成结果。

## 10. 诊断与可观察性

现有 `deliverable-validation-diagnostic-v1` 继续使用，并要求：

- 初始 assembly 失败保存 `r0`；
- 进入 repair 时 `fallbackApplied=true`；
- repair 后失败保存 `r1`；
- 两轮诊断都必须脱敏、限长；
- 成功修复后也保留 `r0`，便于统计 repair 触发率；
- UI 展示失败类别，而不是只显示一条底层字符串。

新增内部 Content Fidelity 诊断：

```text
sourceUnitCount
canonicalUnitCount
preservedUnitCount
addedUnitCount
removedUnitKeys
changedSemanticUnitKeys
normalizationOperations
repairOperations
```

任何未经授权的 `removedUnitKeys` 或 `changedSemanticUnitKeys` 都阻断正式交付。

## 11. Current Resume 改进

连续 Step 10 失败不应反复支付 Steps 3–9 的模型成本。

当且仅当以下条件全部满足时，Current resume 使用 `terminal_rebuild`：

- 前一 Attempt 的步骤 1–9 全部 succeeded；
- 失败类型为 `deliverable_validation`；
- `planVersionId` 和 Plan hash 未变化；
- 所有源 Artifact 仍为 SEALED 且 hash 校验通过；
- Task/Plan/Attempt 归属一致；
- 没有新的用户输入；
- 没有要求重新执行 Skill 的合同变更。

执行方式：

1. 创建新的 Attempt，保留 `retryOf`；
2. 将步骤 1–9 的已验证 Artifact 重新 seal 到新 Attempt，并记录 `sourceArtifactId`；
3. 重建 Evidence Manifest；
4. 仅重新执行 Canonical assembly、最终 Review、Layout 和 Package；
5. 任一复用校验失败时退回普通完整重试，不能部分信任。

不在原 Attempt 上覆盖 Artifact，保持审计不可变性。

## 12. 实施阶段

本方案预计修改 8–12 个文件，新增 1 个内部 Schema 和 1 个深 Module；不新增数据库表，不新增公共 HTTP 接口。

### Phase 1：冻结内容保真基线

文件：

```text
docs/adr/0006-lossless-canonical-deliverable-compilation.md
apps/orchestrator-runtime/src/report/research-strategy-content-fidelity.ts
tests/research-strategy-content-fidelity.test.ts
```

工作：

- 固化 Step 8 Content Unit Inventory；
- 定义语义字段和系统可修改字段；
- 建立 semantic hash；
- 断言 assembly 前后无删除、无未授权改写；
- 将当前三个真实失败形态转为脱敏 fixture。

完成门禁：

```text
同一 Draft 经正常 assembly 后：removed=0，changed=0
安全 ID 规范化不改变 semantic hash
Evidence hydration 不改变 semantic hash
```

### Phase 2：Typed Patch Structural Repair

文件：

```text
schemas/skills/research-strategy-content-patch-v1.schema.json
packages/api-contract/research-deliverable.ts
apps/orchestrator-runtime/src/report/research-strategy-content-patch.ts
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
```

工作：

- assembly repair 从完整 Draft 输出切换为 Patch 输出；
- 实现 target key 查找和 operation allowlist；
- 禁止 remove operation；
- 支持 Evidence/Question/status/validation 修复；
- 仅允许追加缺失 requested Block/item；
- 应用 Patch 后重新执行完整门禁与内容保真校验。

完成门禁：

```text
修一个 Evidence ID 不会改变任何正文
修一个 Question ID 不会改变其他 Block
补一个 requested artifact 不会删除原有 Block
非法 target、删除操作和非白名单字段全部拒绝
```

### Phase 3：Typed Patch Semantic Revision

文件：

```text
apps/orchestrator-runtime/src/report/report-review-service.ts
apps/orchestrator-runtime/src/report/current-deliverable-service.ts
schemas/report-review.schema.json（仅在需要结构化 target 时版本化）
```

工作：

- final Review revision 使用同一 Patch 合同的 `semantic_revision` 模式；
- 每个正文修改必须声明目标 key、字段和 Reviewer issue；
- 未被 Patch 指向的语义单元 hash 必须保持不变；
- Direct Answer 和 requested Block 不可删除；
- 修改后重新运行全部确定性门禁。

完成门禁：

```text
Reviewer 可弱化指定结论
Reviewer 不可静默压缩全文
未被点名的内容逐字保留
所有修改均可追溯到 review issue
```

### Phase 4：ReportDocument 内容覆盖

文件：

```text
apps/orchestrator-runtime/src/report/research-strategy-report-projector.ts
apps/orchestrator-runtime/src/report/report-projection.ts
tests/research-strategy-report-projector.test.ts
tests/report-document.test.ts
```

工作：

- 为每个 Canonical semantic unit 生成 projection binding；
- 不只校验顶层 JSON Pointer，还校验 Block/item/node/cell/edge key；
- 断言所有 Canonical 单元在 full ReportDocument 中恰好出现一次；
- Layout 只改变分组和顺序；
- Markdown、ZIP、Zero 使用相同 coverage 结果。

完成门禁：

```text
Canonical Unit Count = Projected Unit Count
omittedUnits = []
duplicateUnits = []
不同 Blueprint 不改变内容集合
```

### Phase 5：失败可见但不伪装完成

文件：

```text
schemas/deliverable-validation-diagnostic.schema.json
apps/orchestrator-runtime/src/report/deliverable-validation-diagnostic.ts
apps/web/src/components/stages/CurrentStage4Report.tsx
```

工作：

- 保存 r0 和 r1；
- 显示 deterministic normalization、patch 和 fidelity 结果；
- 硬失败时允许用户查看已 SEALED、已 Reviewer 检查的 Draft 摘要；
- 明确标记“非 Canonical、不可导出”；
- 不把失败 Draft 注入正式 ReportDocument。

完成门禁：

```text
用户可看到已有内容与失败原因
失败内容不会被误标为正式报告
诊断不包含完整 Prompt、凭据、PII 或未脱敏原始材料
```

### Phase 6：Step 10 定点重建

文件：

```text
apps/orchestrator-runtime/src/control/lease-execution-engine.ts
database/control-plane.ts
apps/agent-api/src/routes/control-planning.ts
apps/web/src/hooks/useTaskFlow.ts
```

工作：

- Current resume 在符合条件时选择 `terminal_rebuild`；
- 复用并重新 seal 步骤 1–9 的已验证 Artifact；
- 只重跑 Step 10 之后的编译、Review、Layout 和 Package；
- 保留原 Attempt，不覆盖历史；
- 任一完整性检查失败时自动退回完整重试。

完成门禁：

```text
Step 10 失败后的 retry 不产生新的 Steps 1–9 Gateway 调用
复用 Artifact 全部具有 sourceArtifactId
Plan 或输入变化时禁止 terminal_rebuild
旧 resume 调用方式保持兼容
```

### Phase 7：真实回放与发布门禁

- 离线回放当前三种真实失败形态；
- 运行新的真实 Gateway/数据库/Tavily 任务；
- 验证 Step 8 内容单元数量与 Canonical/ReportDocument 内容单元数量；
- 验证一次结构 repair 和一次 semantic revision；
- 验证 model layout 与 fallback layout 内容集合完全一致；
- 验证 Markdown、ZIP 和 Zero 内容集合一致；
- 完成后再请求 merge/restart 授权。

## 13. 测试矩阵

| 场景 | 预期 |
|---|---|
| 正常 Draft | 不调用 repair，semantic hash 全部保持 |
| 空 provisional Evidence，存在同 Question verified hint | 确定性恢复，状态仍为 provisional |
| 空 supported Evidence | 不自动补证据，进入 repair 或阻断 |
| 未知 Evidence | 不猜测；Patch 删除/替换后再验证 |
| Knowledge-only finding | 保持 provisional；只有存在事实上下文时才能进入 FindingGraph |
| 安全 Question alias | 确定性规范化 |
| 同序号但语义不同的 Question ID | 拒绝 |
| repair 试图删除 Block | Patch Gate 拒绝 |
| repair 试图改无关正文 | Fidelity Gate 拒绝 |
| repair 新增缺失 requested Block | 允许，记录 added unit |
| final Review 弱化指定结论 | 允许，记录 target 和 issue |
| final Review 删除未指定内容 | 拒绝 |
| Blueprint 遗漏 Block | fallback，内容不丢失 |
| Markdown/Web/Zero | 单元集合一致 |
| Step 10 retry 且 1–9 Artifact 完整 | terminal rebuild，不重跑模型步骤 |
| Artifact hash 或归属异常 | 禁止复用并 fail closed |

## 14. 验证命令

```bash
pnpm exec tsx --test \
  tests/research-strategy-content-fidelity.test.ts \
  tests/research-strategy-v2-contract.test.ts \
  tests/current-deliverable-service.test.ts \
  tests/report-review-service.test.ts \
  tests/research-strategy-report-projector.test.ts \
  tests/report-document.test.ts \
  tests/report-bundle.test.ts \
  tests/report-package.test.ts \
  tests/zero-report-renderer.test.ts \
  tests/lease-execution-engine.test.ts
pnpm typecheck
pnpm lint:registry
pnpm lint:knowledge
pnpm --dir apps/web build
pnpm quality
git diff --check
```

真实验收必须记录：

```text
Step 8 sourceUnitCount
Canonical preserved/added/removed/changed counts
repair mode 与 operations
ReportDocument projectedUnitCount
每阶段 Artifact ID 和 hash
Gateway/Tool 真实 receipt
最终 Report Review verdict
Report Package 状态
```

## 15. 兼容与迁移

- 不修改历史 SEALED Artifact；
- Payload v1/v2 reader 保持不变；
- ReportDocument v1/v2 reader 保持不变；
- 新 Patch Schema 只用于内部模型调用，不成为公开 API；
- Current resume 请求格式保持兼容；
- 不需要数据库 Migration；
- 旧任务若不满足 terminal rebuild 条件，继续走完整 retry；
- 其他 Deliverable 继续使用原有路径。

## 16. 回滚

每个 Phase 独立提交并可单独回滚：

1. Fidelity Gate 可关闭为只记录、不阻断；
2. Patch repair 可回滚到现有完整 Draft repair；
3. Projection unit coverage 可回滚到现有 pointer coverage；
4. terminal rebuild 可回滚到现有 full retry；
5. 必须保留历史 reader 和已生成 Artifact；
6. 回滚不得删除审计诊断。

## 17. 风险与应对

### 17.1 过度追求逐字保留导致报告臃肿

应对：保留审校后的语义单元，不保留重复中间文本；Layout 仍可分组和调整顺序。

### 17.2 Patch 无法修复真正缺失的大段内容

应对：允许追加缺失 requested Block，但不允许覆盖已有内容；无法补齐时明确阻断并保留 Draft Preview。

### 17.3 Evidence 自动恢复造成错误关联

应对：只处理 provisional、只使用精确 Question 分段中的完整 ID、只接受 sealed Manifest 中存在的 ID；supported 内容不自动恢复。

### 17.4 terminal rebuild 复用过期内容

应对：校验 Plan hash、Artifact hash、Task/Plan/Attempt lineage、用户输入和合同版本；任一变化即退回完整执行。

### 17.5 Content Fidelity Gate 阻止合理语义修订

应对：结构修复和语义修订使用不同 mode；语义修改必须由显式 Patch 和 Review issue 授权。

## 18. 最脆弱假设

本方案假设 Step 8 是“经过 Step 9 审校的完整语义交付草稿”。

如果 Step 8 在首次综合时已经遗漏 Steps 3–7 中的重要决策内容，Step 10 无法在不重新解释原始材料的情况下安全恢复这些语义。此时应进一步把 Direct Answers、Strategy Objects 和 Actions 的中间输出改为类型化 Artifact，由 Step 8 只做引用与组合；不能通过把所有中间文本直接拼进报告来规避问题。

## 19. 实施顺序与提交边界

```text
Commit 1：Content Unit Inventory + Fidelity Gate
Commit 2：typed patch structural repair
Commit 3：typed patch semantic revision
Commit 4：ReportDocument semantic-unit coverage
Commit 5：diagnostic UI + reviewed Draft preview
Commit 6：terminal rebuild retry
Commit 7：真实回放证据与文档状态更新
```

每个提交必须独立通过类型检查和相关测试。全部源码与真实环境门禁完成后，仍只进行一次合并；未经明确授权不 push、不合并、不部署。

## 20. 完成定义

```text
Step 10 retained as Canonical compiler                    required
structural full-Draft rewrite removed                     required
typed patch allowlist enforced                            required
pre/post semantic unit fidelity verified                  required
all reviewed Step 8 units preserved                       required
all Canonical units projected exactly once                required
safe deterministic normalization remains                  required
unsupported factual claims still fail closed              required
recoverable formatting/layout defects do not block        required
r0/r1/fidelity diagnostics persisted                      required
Step 10 retry can reuse sealed Steps 1–9                  required
three historical failures replay successfully             required
fresh real Gateway/DB/Tavily run completes                required
live Zero passes or receives explicit exception           required
main merge/restart requires explicit authorization        required
push requires explicit authorization                      required
```
