# 将 Skill 编译为冻结执行 DAG，并以 Canonical Deliverable 作为报告真相源

> 状态：Accepted；首个 compiled Skill `generate-research-plan` 已实现，Plan/Report v1 兼容保留。

## 背景

当前 Current 执行链将一个 `skill` 步骤实现为：读取 `SKILL.md` 和输出 Schema，注入上游输出，然后执行一次结构化 LLM 调用。

这种实现能够保证 Skill 名称、Prompt hash、Schema 和输出 Artifact 可追踪，但不能保证 `SKILL.md` 中描述的内部阶段真实发生。Skill 文档要求的知识读取、条件暂停、方法选择、Tool 调用和自检都只能由模型在一次调用中模拟。

最近完成的 research plan 任务验证了该差异：

- 顶层 8 步 DAG 被完整执行。
- 唯一 Skill `generate-research-plan` 返回 `status: degraded`。
- 降级原因为未访问 research-wiki，只使用 supplied outputs。
- 执行引擎仍将该步骤和任务记录为普通成功。
- 完整 Deliverable 已生成，但 ReportDocument 投影省略多个必填字段，页面只显示摘要。

如果继续把自然语言 Skill 文档直接当作执行合同，任务卡片、执行记录和用户对“Skill 已执行”的理解会持续不一致。

## 决策

### 1. Skill 使用双层定义

- `SKILL.md` 是人类可读的方法、边界和质量说明。
- Skill Execution Contract 是机器可读的执行真相源。

机器不解析 Markdown 标题或自然语言来推断阶段。

### 2. Compiled Skill 在计划确认前展开

规划阶段将 Skill Execution Contract 编译为 `CurrentExecutionPlan v2` 中的普通 DAG 步骤，包括 Knowledge、Tool、LLM、Skill 和 Reviewer 阶段。

用户在任务卡片中看到并确认的是最终冻结 DAG。执行期间不得静默增加未展示的步骤。

### 3. 复用现有执行引擎

SkillPlanCompiler 只负责编译；LeaseExecutionEngine、ExecutionScheduler、ToolRouter、ArtifactStore 和现有 lease/fencing 继续负责执行。

不新建第二套调度器，也不增加第三套 Skill Runner。现有 `SkillActorRunner` 与 `LeaseExecutionEngine.runSkill()` 必须收敛到统一 Skill Runtime Module。

### 4. Knowledge 通过逻辑 ID 和不可变 Artifact 使用

Skill Execution Contract 的路径必须通过配置根下的词法与物理 realpath containment；任何 symlink 路径组件或非普通文件都被拒绝。合同 hash、`degraded_policy` 与 Skill reference hashes 冻结进 invocation，并在每次真实 Skill 调用前再次加载比对，减少计划预检到调用之间的漂移窗口。

Skill 不获得任意文件路径权限。

规划阶段从 `knowledge-base/.index/knowledge.json` 选择资源并冻结 ID、status、source path 和 content hash；执行阶段验证并写入 Attempt 绑定的 `knowledge-bundle-v1` Artifact。

资源漂移时 fail closed，并要求重新生成计划。资源查询同时声明 `min_items`/`max_items`；低于最小数量必须按可见 `block` 或 `resource_gaps` 策略处理。Skill 自有 references 的路径与内容哈希也冻结进 invocation，并在修订与执行前复验。

### 5. Tool 使用冻结拓扑和受控动态输入

Tool ID、调用次数、依赖、input bindings、静态 input、acceptance 和 output 在计划确认前固定。Tool 参数只有合同 `frozen_input_fields` 显式列出的字段可以在规划期由候选输入覆盖；覆盖后的值仍作为 Plan 内容冻结，执行期不得变化。Skill 不能在执行中任意增加Tool或无限循环。

所有调用继续经过Tool Registry、Schema、真实Adapter、Receipt、预算和审批。每个 Tool stage 还必须属于其 Skill invocation 自身的 required/available optional Tool 集合，不能借用同一计划中其他 Skill 的授权。

### 6. Canonical Deliverable 是报告真相源

ReportDocument 是展示投影，不是研究内容的唯一载体。

- 完整方案直接由Canonical Deliverable渲染。
- ReportDocument用于摘要、打印和发布。
- 页面默认展示完整方案。
- ReportDocument v2 仅允许 `projection-list` Block 声明 payload `sourcePointers`；覆盖门禁只信任该受限 Block，且在合成和读取时校验来源 Deliverable Artifact ID、Schema required 字段、指针存在性及文档级 coveredPointers 的逐项一致。其他展示 Block 不得冒充 payload 投影来源。
- 下载包必须包含Canonical Deliverable和完整Markdown。

### 7. 降级状态必须诚实传播

`skill-output-v2.status=degraded` 按合同 `degraded_policy` 统一处理：`gap` 在 Current 与 legacy 编排路径都产生 Execution Gap，最终状态至少为 `completed_with_gaps`；`block` 阻断步骤。必需 Knowledge 临时缺失可重试，status/path/hash 漂移必须重新规划。

## 接口影响

新增公共配置字段：

```text
SkillRegistryEntry.execution_mode
SkillRegistryEntry.execution_contract
```

新增合同：

```text
skill-execution-contract-v1
current-execution-plan-v2
knowledge-bundle-v1
report-document-v2
```

新增执行 actor：

```text
knowledge
```

旧 Plan v1、ReportDocument v1 和 legacy Skill 保持可读。

## 权衡

### 收益

- 卡片与执行记录一致。
- Skill内部阶段可审计、可恢复、可重试。
- Knowledge和Tool使用可复现。
- 降级不再被隐藏。
- 完整研究内容不再被展示层静默丢失。
- 新能力复用现有DAG、Lease、Artifact和Tool基础设施。

### 成本

- 每个需要真实多阶段执行的Skill必须维护Execution Contract。
- Plan、ReportDocument和前端需要双版本兼容。
- Knowledge hash漂移会要求重新规划，而不是自动使用最新内容。
- 任务卡片会展示更多步骤，需要分组避免信息过载。
- 首批改造范围超过8个文件，必须分阶段提交。

## 被拒绝的方案

### 继续使用单次 LLM Skill

保留现状最简单，但无法证明Skill内部流程发生，也无法满足Wiki、动态Tool和阶段恢复要求。

### 直接解析 SKILL.md

Markdown是面向人类的说明，标题、措辞和顺序会变化。将其当作状态机合同会产生脆弱、不可验证的隐式协议。

### 给 LLM 任意文件和 Tool 权限

这会破坏路径隔离、Tool审批、调用预算、Plan冻结、Receipt完整性和可复现性，不予采用。

### 在 Skill 节点内运行隐藏的嵌套 Agent

隐藏嵌套执行会再次造成任务卡片与真实步骤不一致，并引入第二套调度、恢复和并发语义，不予采用。

### 只修前端报告

可以暂时恢复内容展示，但不能解决Skill内部流程、Knowledge、Tool和降级状态问题，只作为第一阶段兼容修复。

## 兼容与回滚

- 未声明Execution Contract的Skill继续使用 `legacy_single_call`。
- 首批只有 `generate-research-plan` 使用compiled模式。
- 将其execution mode切回legacy即可停止生成新v2计划。
- Runtime继续读取已生成的v2计划，避免中断进行中任务。
- 历史Artifact不修改、不迁移。
- ReportDocument v1/v2双读。
- 不需要数据库Migration。

## Premise Collapse

本决策假设Skill作者愿意同时维护人类说明和机器执行合同。

如果Skill只能继续作为纯自然语言提示词，系统最多只能提供Wiki预加载、受控Tool前置、单次生成、诚实降级和完整Deliverable展示；不得再声称完整执行了Skill内部工作流。

## 关联文档

- 开发方案：`docs/plans/2026-08-22-skill-runtime-report-fidelity-development.md`
- 执行清单：`docs/plans/2026-08-22-skill-runtime-report-fidelity-todolist.md`
