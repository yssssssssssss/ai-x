# 模型编排类型化报告，系统确定性生成交付元数据

## 背景

ADR-0004 将研究规划与直接研究回答分离，并要求答案型报告使用固定最小骨架、动态专题和类型化 Block。首轮真实 Gateway/数据库验收进一步暴露了两个问题：

1. compiled `research-strategy-synthesis` Skill 已经生成完整策略内容并经过结构化 Reviewer 审校，Deliverable 阶段仍让另一个模型重新生成完整报告；
2. 模型同时负责内容、全局 ID、Coverage、Risk identity 和 requested artifact binding，任何机械映射漂移都会使整份内容失败。

当前 Report Composer 还会在模型章节之外固定追加策略地图、心智模型、原则、机会和行动章节，使不同任务呈现相同骨架并重复内容。

本次真实运行的整任务 20 分钟终止来自外层验收命令，不是产品合同。进程被终止后 Lease 正确回收为 worker loss，但该外层时限中断了仍在正常工作的最终生成阶段。

## 决策

### 1. 内容只生成一次

`research-strategy-synthesis` 的最终 Skill 输出成为受 Review 的语义 Content Draft。`research_strategy_report` 不再调用通用 Deliverable LLM 全文重写，而由系统组装 Canonical Deliverable。

### 2. 模型和系统字段分权

模型负责：

- Direct Answers；
- Evidence Findings；
- 类型化 Content Blocks；
- 内容置信度、业务含义、行动和验证需求。

系统负责：

- 全局 ID；
- FindingGraph；
- Recommendations 与 Coverage；
- requested artifact bindings；
- Reviewer、Gap、Requirement 和 Envelope 风险身份；
- Task、Plan、Attempt、Artifact 与 Capability Provenance。

### 3. 新写入采用开放式 Content v2

新答案任务写入带显式 `research-strategy-content-v2` 鉴别字段的 Payload。报告只要求 Direct Answers、Evidence Findings、类型化 Content Blocks 和风险表面；只有用户实际请求的 Artifact 类型才是必需项。

历史无版本字段的固定 Payload 继续按 v1 读取。写入 Schema 与历史读取 Schema 分离。

### 4. 布局蓝图只引用 Canonical 内容

最终 Report Review 通过后，模型只接收 Canonical Content Index，并返回引用 Block ID 的布局蓝图。模型可决定章节标题、数量、顺序、分组和重要级别，但不能输出正文或新结论。

### 5. 布局失败必须降级而非阻断

布局模型超时、非法 JSON、未知引用、遗漏或重复 Block 时，系统使用确定性布局。布局降级写入报告元数据和脱敏诊断，但不会将内容有效的任务置为失败。

内容缺失、未知 Evidence、请求交付物缺失、Review block 或完整性错误继续 fail closed。

### 6. 保留 ReportDocument v2

ReportDocument v2 已支持动态 Section 和类型化 Answer Block，因此不新增 v3。Web、Markdown、ZIP 和 Zero 继续共享同一 ReportDocument。

### 7. 取消整任务总时限，保留单调用边界

真实验收不再设置 20 分钟整任务 timeout。Gateway、Tool、数据库和 Zero 的单次调用超时、Lease heartbeat、worker-loss 回收和用户取消仍保留。

## 权衡

### 收益

- 删除重复的大型全文生成，减少时延和结构漂移；
- 不同任务可以形成不同章节结构；
- 机械索引错误不再污染模型内容；
- 布局不可用时仍能交付完整报告；
- 历史 v1 报告继续可读；
- 内容失败与布局降级可以分别审计。

### 成本

- 新增 Content v2、布局蓝图和读写 Schema 选择；
- Canonical Assembler 需要确定性维护 Graph、Coverage 和风险传播；
- ReportDocument/Web 需要从内容类型而不是固定 Section ID 派生视图；
- 新路径必须完成一次无整任务时限的真实闭环验收。

## 被拒绝的方案

### 任意 Markdown

无法可靠校验必答问题、Evidence、请求交付物和风险，也无法稳定支持多端渲染。

### 只修改页面章节顺序

不能消除重复内容生成和模型负责机械元数据的问题。

### 让布局模型重新总结全文

会形成第二份未经同等 Review 的事实表达，破坏 Canonical Deliverable 的真相源地位。

### 删除全部超时

会使单个外部调用永久占用资源。只取消整任务总时限，单调用边界继续保留。

## 兼容与回滚

- Research Strategy Payload v1/v2 均可读取；
- 新任务只写 v2；
- Plan v1/v2 和 ReportDocument v1/v2 保持可读；
- 不修改历史 SEALED Artifact；
- 不需要数据库 Migration；
- 回滚时可切回旧 writer/synthesis mode，但必须保留 v2 reader；
- Skill Runtime、Knowledge、Tool 和安全修复不回滚。

## 关联文档

- 开发方案：`docs/plans/2026-08-23-model-directed-open-report-development.md`
- 执行清单：`docs/plans/2026-08-23-model-directed-open-report-todolist.md`
- 上游决策：`docs/adr/0004-separate-research-planning-from-answer-delivery.md`
