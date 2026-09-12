# 用研 AI 编排项目 · 轻量化重构方案

> 基于三条链路(规划/执行/报告)+ 合规/验收/来源共六块**代码实读**(非文档转述,含 file:line 交叉验证)产出。
> 边界:守住"AI 不编造数据"这一条原则,其余严格实现可削。

## Context(为什么做)

项目流程本身清晰(需求分析→方案匹配→拆子需求→逐步执行→汇总报告),但任何改动动辄几小时,改报告结果常被"门禁/合规"冲突拦下。

实读确认:**流程主干轻量,重量全在"每步产出必须可追溯/可审计/不可篡改"的验收合同上。** 这套合同为"防 AI 编造研究结论"设计,正确但过度——它用**无损编译 + exact-once 来源绑定 + 三重校验**这套严格实现,把"防造假"和"禁改写"焊在了一起。

用户松绑边界:只需守住"AI 不编造数据"(LLM 不能把推断写成事实、不能凭空造数字/URL),不要求现在这套严格实现。

## 总纲

**一句话原则:门禁只拦"造假",不拦"改写"。**

### 绝对保留(防编造三块地基,任何 P0 不得触碰)
- `apps/orchestrator-runtime/src/evidence/evidence-service.ts:278-290` — FactFinding 必挂 factual evidence / InferenceFinding 只挂上游 finding。**这就是"事实/推断分层"本身**,323 行,精炼。
- `apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts:115` — 模型漂移 fail-closed(保证"用的确实是声明的模型")。
- `apps/orchestrator-runtime/src/runtime/redaction.ts:100` `containsBlockedSensitiveData` — 敏感数据 block(收敛到单点,但不删)。

### 可削
fidelity 第三层、contribution-ledger 全套、typed patch + review 授权墙、v1/v2 package、audit 死代码、平行家族的一半、四处敏感重复调用、五处语言 prompt。

**底线为何不受影响**:P0 砍的是下游"无损/授权/结构保真"校验;三块地基分别在**上游生成阶段(evidence 分层)、LLM client 包裹层(漂移)、出口(敏感)**,与下游校验层不重叠。

---

## 重构项清单(按优先级)

### P0 — 最高收益 / 低风险 / 先做(直接解决"改报告被拦")

#### P0-A｜Canonical 改可直接编辑
- **做什么**:去掉 typed patch + review 授权墙,改报告正文直接写 Canonical;保留"确定性快检 + 一次 LLM 评审"作为出口门禁。
- **动哪里**:`report/current-deliverable-service.ts:1503` 组装循环去掉授权分支;`report/report-document-composer.ts:488` 的 `verdict≠pass→fail` 改为"记 warning 不 throw"(仅敏感/来源缺失才 fail)。
- **收益**:改报告从"被拦→退回重跑"变直通;省结构修复 2 轮循环。
- **风险**:低(底线不在这层,evidence 分层在上游拦造假)。**工作量**:1.5 人天。
- **验证**:gold-run 冒烟 + 手动改一段正文,跑通 composing→completed。

#### P0-B｜报告校验三重→单层(下线 fidelity 第三层)
- **做什么**:删 `assertStructuralRepairFidelity`/`assertSemanticRevisionFidelity` 强制 throw,changed/removed/reordered 降为诊断日志。保留 `report-review-service.ts:518` 确定性维度(来源/敏感)+ 一次 LLM 评审。
- **动哪里**:`report/research-strategy-content-fidelity.ts:334-360`;消费点 `report/research-strategy-content-patch.ts:537-538`、`report/current-deliverable-service.ts:1718-1845`(throw 改 continue);`answer-quality-validator` 与 review 确定性维度去重合并为一次调用。
- **收益**:改正文不再触发 `changedSemanticUnitKeys throw`;砍一整层 + 结构修复循环。
- **风险**:中。**必须守住**:review 层的"来源绑定丢失→fail"和敏感维度**保留**——这是三重里唯一真防编造的一层,只砍 fidelity + answer-quality 冗余。**工作量**:2 人天。
- **验证**:CI 7-profile smoke(fidelity 相关断言同步放宽/删测,红是预期不是回归);补一条"改写正文后 evidence 分层仍拦造假"正向 smoke。

#### P0-C｜敏感 block 四处收敛单点
- **做什么**:`containsBlockedSensitiveData` 收敛到出口单点,删冗余调用。
- **动哪里**:保留 `report/synthesis-materializer.ts:234`;删/弱化 `control/lease-execution-engine.ts:2402/5212/5388`。
- **风险**:低。**注意**:确认三处非"不同数据形态"(工具原始输出 vs 合成文本);若形态不同,保留 tool 层 + 出口两点。**工作量**:0.5 人天。
- **验证**:构造含敏感词的 tool 输出,断言出口拦截。

> **最快路径:只做 P0-A + P0-B ≈ 3.5 人天,即可让"改报告不被拦"。**

---

### P1 — 高收益 / 中风险 / 第二波

#### P1-D｜contribution-ledger 整体降级
- **做什么**:下线 8 种校验(source exact-once + semanticHash,`report/contribution-ledger.ts:83-162`)。FindingGraph 分层已覆盖"事实必有证据"。
- **动哪里**:`current-deliverable-service.ts:1907` 停止 `buildReviewedContributionLedger`;**连带**清 `schema/schema-registry.ts:39`、`report/report-package-artifact.ts:279`、`report/current-report-package-reader.ts:345` 的 sidecar 契约(reader 改 optional,否则旧 package 回读因缺 sidecar 报 orphan)。
- **风险**:中(ledger 嵌 package schema 较深)。**工作量**:2.5 人天。
- **验证**:multi_skill 端到端 + 旧 package 回读。

#### P1-E｜平行家族合并(research-strategy / industry-market)
- **做什么**:两套 assembler/projector/content-patch/fidelity 抽公共基类 + family config;竞品视觉证据校验(`current-deliverable-service.ts:1113` 与 `report-document-composer.ts:830` 各 ~400 行)合并为单一 validator。
- **收益**:report 目录 30-40% 重复中回收大头(数千行)。
- **风险**:中高(抽象错会两家族一起坏)。**顺序**:先合视觉证据校验(纯重复低风险),assembler/projector 抽象放最后。**工作量**:4-5 人天。
- **验证**:两家族各跑一份报告对比 diff。

#### P1-F｜audit 死代码下线
- **做什么**:删 `audit/audit-package.ts:58 buildReviewForm`、`audit/batch-summary.ts:50 buildBatchSummary`、`audit/audit-package-service.ts:104 AuditPackageService`——**已证实生产零引用**(仅自身 + 测试);哈希/stable 序列化三处(gold-run / gold-batch-service / audit-package-service)抽公共 util。
- **风险**:极低。**工作量**:1 人天。**验证**:删后 build + gold-run 通过。

---

### P2 — 结构性 / 高风险 / 压轴

#### P2-G｜双路径 v2/v3 收敛
- **做什么**:v2 降为兼容只读,新执行只走 v3;去 `parse`/`preflight`/`skip-remap` 分叉;`control-runtime.ts` package 回退链砍到 v3(+v2 只读)。
- **风险**:高(横穿 planner/engine/report 三层,最大耦合面)。**放最后。工作量**:5-8 人天。**验证**:全 profile smoke。

#### P2-H｜超级方法拆分
- **做什么**:`planners/routed-planner.ts:730-1481 planCurrent` 拆 single/multi/direct 三策略;`control/lease-execution-engine.ts:1029-1380 parseExecutionPlan` 按 v2/v3 拆解析器(依赖 P2-G 先做,可少拆一半)。
- **风险**:中(纯结构重构,行为不变)。**工作量**:3 人天。

#### P2-I｜prompt 内契约收敛单一 schema 源
- **做什么**:`planners/routed-planner.ts:1288-1311` 硬编码 step 契约改为从 schema 生成/引用,消除"prompt+schema+校验三处同步"漂移。
- **风险**:中。**工作量**:2 人天。

#### P2-J｜语言 prompt 收敛
- **做什么**:5 处语言一致性 prompt(`current-deliverable-service.ts:97` 等)抽单一常量(无强制力纯重复)。**工作量**:0.5 人天。

---

## 执行顺序

- **第一波(独立并行,最快让"改报告"变轻)**:P0-A / P0-B / P0-C 互不依赖,并行做完即解决核心痛点。P1-F / P2-J 可穿插(纯删除零风险)。
- **第二波(有依赖)**:P1-D(需 A/B 先落,否则 ledger 与 fidelity 交叉断言难拆)→ P1-E(视觉证据校验先合、assembler 后合)。
- **第三波(压轴)**:P2-G(v2/v3)→ P2-H(吃 G 红利)→ P2-I。

## 风险与回滚

- **回滚策略**:每项独立 commit;fidelity / ledger 用 **feature flag 而非直接删**——先关观察一轮 gold-run 再删代码。
- **CI 覆盖**:现有 7-profile real smoke + gold-run + GoldPins 哈希锁定**能覆盖** P0-A/B/C 行为回归(报告能生成、来源/敏感仍拦)。
- **盲区**:fidelity/ledger 下线后原本断言"无损"的测试会红——**这是预期,需同步删/放宽,而非当回归修**。P0-B / P1-D 各补一条"改写正文后 evidence 分层仍拦造假"的正向 smoke,确保砍的是冗余不是底线。

## 总量粗估

| 范围 | 工作量 |
|---|---|
| 只做 P0 三项(解决"改报告被拦"核心痛点) | ~4 人天 |
| 只做 P0-A + P0-B(最快路径) | ~3.5 人天 |
| 全部 P0+P1+P2 | ~28-33 人天 |

---

## 附:实读依据(file:line 索引)

| 结论 | 位置 |
|---|---|
| 生产执行入口(非死锁旧引擎) | `control-runtime.ts:928` → `task-workflow.ts:1181` |
| 事实/推断分层地基 | `evidence-service.ts:278-290` |
| 模型漂移 fail-closed | `receipt-llm-client.ts:115` |
| 敏感 block(四处重复) | `redaction.ts:100`,调用于 `lease-execution-engine.ts:2402/5212/5388`、`synthesis-materializer.ts:234` |
| 无损编译强制 throw | `research-strategy-content-fidelity.ts:334-360` |
| 报告 verdict≠pass→fail | `report-document-composer.ts:488` |
| ledger exact-once/semanticHash | `contribution-ledger.ts:83-162` |
| v2/v3 规划分叉 | `routed-planner.ts:822` |
| planCurrent 超级方法 | `routed-planner.ts:730-1481` |
| parseExecutionPlan 超级方法 | `lease-execution-engine.ts:1029-1380` |
| audit 死代码(生产零引用) | `audit-package.ts:58`、`batch-summary.ts:50`、`audit-package-service.ts:104` |
