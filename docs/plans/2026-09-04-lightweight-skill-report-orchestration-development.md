# 轻量 Skill 报告编排开发方案

> 状态：已实施；自动化与离线纵切通过，真实 Gateway/Tool smoke 待安全环境
> 日期：2026-09-04
> 适用范围：新建任务；`single_skill` 与 `multi_skill`
> 历史策略：历史 Task、Plan、Artifact、HTML 与数据库记录原样保留；新实现不兼容、不迁移、不继续读取旧报告合同

## 1. 决策摘要

新任务保留现有产品主流程：

```text
需求输入
→ 需求澄清
→ 方案匹配
→ 子需求拆解
→ 调用对应 Skill
→ 按依赖逐步执行
→ 报告输出
```

保留两种用户可选的编排模式：

```text
single_skill
multi_skill
```

报告链路改为：

```text
single_skill
→ Skill 按自身定义的报告结构生成 SkillReport
→ 直接作为最终报告
→ Markdown 安全渲染为 HTML

multi_skill
→ 每个 Skill 按自身定义的报告结构生成 SkillReport
→ 一次最终 LLM 综合
→ FinalReport Markdown
→ Markdown 安全渲染为 HTML
```

新任务不再依赖多代 `ReportReview`、`ReportDocument`、`ReportPackage`、Deterministic Showcase、Cross-Skill Review、Contribution Ledger 或多轮语义修订。

系统只保留必要输入、真实权限、来源真实性和输出安全四类硬边界。内容质量、证据强弱和资料缺口通过报告中的 Warning、Gap、暂定结论和待验证项表达，不阻断整个任务。

## 2. 产品目标

- 保留现有 Web 主界面、四阶段任务体验、问询流程和整体视觉样式。
- Single Skill 直接尊重 Skill 自己定义的报告结构，不再由通用报告模板重写。
- Multi Skill 保留每个 Skill 的原始报告，并通过一次 LLM 生成统一的综合报告。
- 修改某个 Skill 的报告结构时，只修改该 Skill 及其测试。
- 修改 HTML 样式时，只修改 Reporting Renderer 和样式文件。
- 报告生成失败不得要求重新执行已经成功的 Tool 或 Skill。
- Multi 综合、HTML 渲染或下载失败不得改变已经完成的 Skill 执行结果。
- 新任务只有一套当前报告合同和一套当前存储格式。

## 3. 非目标

本方案不建设：

- 第三种 `simple` 编排模式；
- 不建设配置中心、运行时任意代码插件或复杂动态插件平台；热插拔仅通过受控目录合同和规划时重新扫描实现；
- 通用工作流 DSL；
- 多版本兼容 Reader；
- 历史 Task/Plan/Report 回填；
- 自动法律判断规则引擎；
- 多轮 LLM Reviewer／Repair；
- 每个 Skill 独立维护 HTML/CSS Renderer；
- 由模型直接生成含 JavaScript 的网页；
- 复杂 Contribution Ledger 或逐句处置账本。

## 4. 保留的现有 Web 体验

### 4.1 保留的页面和阶段

继续保留现有四阶段界面与交互节奏：

```text
Stage 1 需求理解与澄清
Stage 2 方案选择与计划确认
Stage 3 执行进度
Stage 4 报告查看与下载
```

对应现有组件的处理原则：

| 现有区域 | 处理方式 |
|---|---|
| `Stage1Understand` | 保留 |
| `CurrentStage1Clarify` | 保留 |
| Single/Multi 模式选择 | 保留 |
| `Stage2Candidates` | 保留 |
| `Stage2Plan` | 保留，展示新的轻量 Plan |
| 用户确认与输入上传 | 保留 |
| `Stage3Execute` | 保留，展示 Skill 执行节点 |
| 执行日志和恢复 | 保留必要部分 |
| `CurrentStage4Report` | 保留容器与交互样式，替换数据源和内部 Renderer |
| 当前 CSS、按钮、卡片、阶段导航 | 原则上保留 |

### 4.2 保留并强化 Skill 驱动的用户问询流程

问询不能弱化为少量通用问题。系统必须先根据用户目标形成候选方案，再基于方案中实际调用的全部 Skill 计算输入需求。

问询分为两层：

```text
第一层：任务级澄清
研究方向、Single/Multi、目标、范围、期望交付物

第二层：Plan/Skill 级补充
根据已选方案中的 Skill 输入合同，询问仍未满足的材料
```

第二层问询流程：

```text
已选 Plan
→ 汇总所有 Skill 的输入需求
→ 对相同需求去重
→ 检查当前会话中用户已提供的内容
→ 检查本任务已经上传的图片、文本和数据集
→ 检查当前用户有权限使用的数据库资料
→ 将已有资料绑定到对应 Skill
→ 只询问仍未满足的输入
→ 用户回答后重新解析，直到满足执行条件或明确选择缺口处理
```

输入解析优先级：

1. 当前消息和历史对话中用户已经明确提供的内容；
2. 当前 Task 已上传并绑定的文件、图片和数据集；
3. 当前用户／项目有权限读取的数据库资料；
4. 当前 Plan 已声明可调用的 Knowledge 或 Tool；
5. 用户补充问询。

数据库中存在资料时，必须先确认归属、权限、适用范围和可用状态，再绑定到 Plan；不得因为同名字段存在就跨用户或跨任务使用。

问询界面必须说明：

- 缺少什么；
- 哪个或哪些 Skill 需要；
- 为什么需要；
- 可以接受什么形式；
- 是否必需；
- 用户无法提供时会阻断、调整 Plan，还是形成 Gap。

多个 Skill 需要同一项资料时只问一次，再将同一份输入绑定到多个 Invocation。例如 Persona、JTBD 和 Journey Map 都需要用户访谈材料时，前台只展示一项合并后的材料请求。

继续支持：

- 研究方向确认；
- `single_skill`／`multi_skill` 选择；
- 结果类型与交付目标澄清；
- 方案候选比较；
- Skill 输入需求预览；
- 图片、数据集、文本和已有数据库资料的自动匹配；
- 未满足输入的集中问询；
- 用户修正已自动匹配的资料；
- 执行前确认；
- 任务暂停、取消和可恢复执行。

问询原则：

```text
已有信息不重复问。
多个 Skill 的相同需求合并问。
问题必须来自当前 Plan 中真实 Skill 的输入合同。
必需输入无法获得时，阻断或请求调整方案。
可选输入无法获得时，经用户确认后形成可见 Gap。
```

### 4.3 Stage 4 新交互

保留当前双视图切换的交互样式，但语义简化为：

```text
最终报告
Skill 明细
```

- `最终报告`：Single Skill 的原始报告，或 Multi Skill 的综合报告 HTML。
- `Skill 明细`：按 Skill 查看原始 Markdown、来源和 Gap。

继续支持：

- HTML 页面内阅读；
- 下载最终 Markdown；
- 下载最终 HTML；
- 查看来源；
- 查看各 Skill 原始结果；
- Multi 综合生成失败时查看 Skill 原始报告。

不再要求前端识别 ReportDocument v1/v2/v3/v4 或 ReportPackage v1/v2/v3。

## 5. 总体架构

```text
┌────────────────────────────────────────────┐
│ Web / API                                  │
│ 输入、问询、模式选择、方案确认、执行进度   │
└────────────────────┬───────────────────────┘
                     ↓
┌────────────────────────────────────────────┐
│ Requirement Module                         │
│ 用户对话 → Finalized Requirement           │
└────────────────────┬───────────────────────┘
                     ↓
┌────────────────────────────────────────────┐
│ Planning Module                            │
│ Requirement → Plan + Skill Invocations     │
│ single: 1 个 Skill                         │
│ multi: 1..N Contributor + 最终综合          │
└────────────────────┬───────────────────────┘
                     ↓
┌────────────────────────────────────────────┐
│ Input Resolution Module                    │
│ 聚合 Skill 输入 → 会话/上传/数据库解析      │
│ 仅对未满足项生成用户问询                    │
└────────────────────┬───────────────────────┘
                     ↓
┌────────────────────────────────────────────┐
│ Execution Module                           │
│ Knowledge / Tool / Skill 按 DAG 执行       │
│ 每个 Skill 输出 SkillReport                │
└────────────────────┬───────────────────────┘
                     ↓
          ┌──────────┴──────────┐
          ↓                     ↓
┌───────────────────┐  ┌────────────────────┐
│ Single Finalizer  │  │ Multi Synthesizer  │
│ SkillReport 直出  │  │ Reports → 1 次 LLM │
└─────────┬─────────┘  └──────────┬─────────┘
          └──────────┬────────────┘
                     ↓
┌────────────────────────────────────────────┐
│ Reporting Module                           │
│ Markdown + Sources + Gaps → 安全 HTML       │
└────────────────────────────────────────────┘
```

模块只能通过公共协议传递数据，不允许 Reporting 导入 Lease、ToolRouter、SkillLoader 或 Execution 内部实现。

## 6. Skill 报告与输入合同

### 6.1 SkillInputRequirement

每个 Skill 必须声明完成自身工作所需的输入，Plan 只能根据这些真实声明生成问询：

```ts
interface SkillInputRequirement {
  key: string;
  label: string;
  description: string;
  required: boolean;
  multiple: boolean;
  acceptedSources: Array<'conversation' | 'upload' | 'database' | 'knowledge' | 'tool'>;
  question: string;
}
```

Plan 形成后，Input Resolution Module 输出：

```ts
interface ResolvedPlanInputs {
  resolved: Array<{
    key: string;
    valueRef: string;
    source: 'conversation' | 'upload' | 'database' | 'knowledge' | 'tool';
    targetInvocationIds: string[];
  }>;
  pending: Array<{
    requirement: SkillInputRequirement;
    targetInvocationIds: string[];
  }>;
}
```

只有 `pending` 项进入前台问询。已解析项在计划确认页展示来源，并允许用户纠正，但不得重复询问。

### 6.2 SkillReport

每个被调用的 Skill 最终返回统一外壳，正文结构由 Skill 自己决定：

```ts
interface SkillReport {
  version: 'skill-report-v1';
  skillId: string;
  invocationId: string;
  title: string;
  status: 'completed' | 'completed_with_gaps' | 'needs_input';
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
}

interface SourceReference {
  id: string;
  title: string;
  type: 'user_input' | 'knowledge' | 'tool_result';
  url?: string;
}
```

### 6.3 Skill 自己定义报告结构

能够独立交付的 Skill 应包含：

```text
SKILL.md
output.schema.json
report-template.md
```

`report-template.md` 只定义语义结构，不定义 HTML/CSS。例如：

```markdown
# 竞品分析报告

## 核心结论

## 竞品分层

## 对比矩阵

## 战略意图

## 差异化建议

## 来源与限制
```

Skill 可以使用表格、列表、Mermaid 或约定的图片引用，但不得输出脚本或远程运行时代码。

### 6.4 没有专用报告模板的 Skill

使用一个通用 Markdown 骨架：

```markdown
# {{title}}

## 结论

## 分析结果

## 建议

## 限制和待验证内容
```

不建设复杂模板引擎；模板由 Skill Prompt 直接消费。

## 7. Single Skill 流程

```text
Finalized Requirement
→ 选择一个 Skill
→ 根据 SkillInputRequirement 解析会话、上传和数据库资料
→ 只询问仍未满足的输入
→ 用户确认输入绑定
→ 执行前置 Knowledge / Tool
→ 执行 Skill
→ SkillReport
→ 追加确定性来源与 Gap
→ 按 Skill 报告结构进行 Markdown 渲染
→ Final HTML
```

规则：

- Single Skill 的最终 HTML 正文严格按照该 Skill 的 `report-template.md` 生成。
- SkillReport 的标题、章节、章节顺序、表格、列表和正文层级保持不变。
- 平台只负责统一页面外壳、视觉 Token、Markdown 到 HTML、安全处理以及确定性来源／Gap 附录。
- 平台不得使用第二次 LLM 重写 Single Skill 报告。
- 平台不得用通用报告模板替换 Skill 的专用结构。
- Skill 返回 `needs_input` 时，回到该 Skill 对应的输入问询。
- 用户无法提供必需输入时阻断或调整 Plan；无法提供可选输入时，经用户确认后使用 `completed_with_gaps` 继续。

因此，Single Skill 的内容结构由 Skill 定义，HTML 外观由平台统一。Single Skill 的正式报告真相源就是该 `SkillReport`。

## 8. Multi Skill 流程

### 8.1 执行

```text
Finalized Requirement
→ 子需求拆解
→ Skill Invocations
→ 按依赖并行／顺序执行
→ SkillReport[]
```

每个 Skill 保持自己的报告格式，例如：

```text
competitive-analysis → 竞品矩阵报告
persona              → Persona 卡片报告
jobs-to-be-done      → JTBD 需求报告
journey-map          → 旅程图报告
metrics              → 指标体系报告
```

### 8.2 最终综合

所有成功或带 Gap 的 SkillReport 一次性提交给最终综合 LLM：

```ts
interface MultiSynthesisInput {
  requirement: FinalizedRequirement;
  reports: SkillReport[];
}
```

最终综合只调用一次 LLM，不追加第二 Reviewer 或自动 Repair 循环。

LLM 负责：

- 回答用户的总体问题；
- 按用户目标动态组织章节；
- 合并重复内容；
- 保留 Skill 的专业结构；
- 把跨 Skill 结论串成完整逻辑；
- 明确冲突、缺口和待验证内容；
- 形成统一的行动建议。

LLM 不负责：

- 新增事实、数字或 URL；
- 伪造来源；
- 静默消除 Skill 冲突；
- 修改原始 Source ID；
- 生成 JavaScript；
- 生成最终来源附录。

### 8.3 综合失败

最终综合 LLM 失败时，不重新运行 Skill。系统使用确定性降级报告：

```markdown
# 综合报告暂不可用

## Skill A
[原始报告]

## Skill B
[原始报告]

## Skill C
[原始报告]

## 资料缺口
[系统汇总]
```

该结果明确标注“自动综合未完成”，但所有已完成 Skill 结果仍可读取和下载。

## 9. Multi Skill 最终 HTML 形式

### 9.1 生成方式

```text
FinalReport Markdown
→ Markdown Parser
→ HTML Sanitizer
→ 当前 Web 视觉 Token / CSS
→ 自包含 HTML
```

LLM 只输出 Markdown，不直接生成 HTML/CSS。这样可以保留当前 Web 风格并减少 HTML 安全、Fidelity 和多版本报告合同。

### 9.2 页面结构

最终页面使用“固定最小骨架 + 动态主题章节”：

```text
报告标题与任务摘要
参与 Skill 与运行状态
执行摘要
直接答案
动态主题章节（由当前需求和 Skill 结果决定）
跨 Skill 综合结论
行动建议与优先级
冲突、限制和待验证内容
来源
Skill 原始报告索引
```

HTML 视觉示意：

```text
┌────────────────────────────────────────────────────┐
│ 报告标题                                           │
│ 研究目标 · Multi Skill · 参与 Skill · 完成状态     │
├────────────────────────────────────────────────────┤
│ 执行摘要                                           │
│ 3～5 条总体判断                                    │
├────────────────────────────────────────────────────┤
│ 直接答案                                           │
│ 用户问题 → 综合结论 → 依据 → 行动                  │
├────────────────────────────────────────────────────┤
│ 动态主题一：市场与竞品                             │
│ 竞品矩阵 / 关键差异 / 来源标记                     │
├────────────────────────────────────────────────────┤
│ 动态主题二：用户与需求                             │
│ Persona 卡片 / JTBD / 旅程断点                     │
├────────────────────────────────────────────────────┤
│ 动态主题三：机会与指标                             │
│ 机会点 / 优先级 / 指标体系                         │
├────────────────────────────────────────────────────┤
│ 跨 Skill 综合结论                                  │
│ 一致结论 / 互补结论 / 冲突结论                     │
├────────────────────────────────────────────────────┤
│ 行动建议                                           │
│ P0 / P1 / P2 或近期 / 中期                         │
├────────────────────────────────────────────────────┤
│ 限制与待验证                                       │
├────────────────────────────────────────────────────┤
│ 来源                                               │
└────────────────────────────────────────────────────┘
```

中间动态主题不使用固定行业模板。综合 LLM 根据用户问题和真实 SkillReport 决定章节标题、顺序和合并方式。

### 9.3 来源展示

正文使用轻量引用：

```text
[S1] [S2]
```

来源列表和 Gap 由系统确定性追加，不由综合 LLM 自由生成：

```markdown
## 来源

### competitive-analysis
- [S1] 竞品官网
- [S2] 公开行业报告

### generate-persona
- [S3] 用户提供的访谈材料

## 资料缺口
- 尚未提供内部转化数据
- Persona 当前只形成暂定假设
```

### 9.4 Skill 明细视图

Stage 4 的第二个视图按 Skill 展示：

```text
[竞品分析] [Persona] [JTBD] [旅程图] [指标]
```

每个 Skill 页面显示：

- 原始 Markdown 报告；
- Skill 状态；
- 使用的来源；
- Gap；
- 下载按钮。

综合报告不会覆盖或删除 Skill 原始报告。

## 10. FinalReport 合同

```ts
interface FinalReport {
  version: 'final-report-v1';
  taskId: string;
  planId: string;
  attemptId: string;
  mode: 'single_skill' | 'multi_skill';
  title: string;
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
  skillReports: Array<{
    skillId: string;
    invocationId: string;
    status: SkillReport['status'];
    path: string;
  }>;
}
```

保存文件：

```text
reports/final-report.json
reports/report.md
reports/report.html
reports/sources.json
skill-results/<invocation-id>.json
skill-results/<invocation-id>.md
```

不再创建多版本 ReportReview、ReportDocument、ReportPackage。

## 11. 轻量门禁

### 11.1 Plan/Skill 输入 Gate

问询和输入 Gate 由当前 Plan 中全部 Skill 的 `SkillInputRequirement` 驱动：

- 先解析当前会话已有信息；
- 再解析当前 Task 已上传材料；
- 再查询当前用户有权限使用的数据库资料；
- 再绑定 Plan 已声明的 Knowledge／Tool 可提供内容；
- 对相同输入需求去重；
- 只对仍未满足的项询问用户；
- 问询结果必须绑定回具体 Skill Invocation。

必需输入无法获得时，系统应要求用户补充或调整方案；不得静默跳过。可选输入无法获得时，必须由用户确认继续，再形成 Gap。

### 11.2 权限与安全 Gate

仅根据实际动作判断：

- 实际处理 PII；
- 实际读取受限数据；
- 实际调用高风险 Tool；
- 实际进行外部发布或不可逆操作。

不得根据 Requirement 或报告文字中出现“隐私、授权、内部数据、合规”等关键词自动触发审批。

### 11.3 来源 Gate

硬检查：

- Source ID 是否存在；
- URL 是否来自真实输入或 Tool；
- 是否引用不存在的来源。

证据较弱但未伪造时不阻断，改为暂定结论或 Gap。

### 11.4 输出安全 Gate

Markdown 转 HTML 时统一执行：

- 转义危险 HTML；
- 禁止 JavaScript；
- 禁止 iframe、form 和运行时网络请求；
- 外部链接只允许 HTTPS；
- 防止 PII 泄漏。

### 11.5 不再阻断的内容检查

以下内容只生成 Warning，不改变 Task 完成状态：

- 推荐质量；
- 推理质量；
- 方法完整性；
- 视觉质量；
- 证据强弱；
- 决策可用性；
- 风险披露格式；
- Reviewer 不同意见。

## 12. 模块边界

```text
requirement/
  用户对话 → FinalizedRequirement

planning/
  Requirement → Plan + SkillInvocations

input-resolution/
  Plan + 会话 + 上传 + 数据库 → ResolvedPlanInputs

execution/
  Plan + ResolvedPlanInputs → SkillReport[]

synthesis/
  Multi SkillReports → FinalReport Markdown

reporting/
  FinalReport → HTML / Download

control/
  维护 Task 状态并调用模块
```

依赖规则：

- `planning` 只能读取 Skill 的公开 Manifest/Input Contract；
- `input-resolution` 只负责发现、去重和绑定输入，不解释 Skill 业务逻辑；
- `execution` 不依赖 `reporting`；
- `reporting` 不依赖 Lease、ToolRouter、SkillLoader；
- `synthesis` 只读取 SkillReport；
- Skill 不读取其他 Skill 内部文件；
- Web 只读取 Input Resolution、执行状态和 FinalReport API；
- Control 不解析 Skill 报告正文。

## 13. Skill 与 Plan 热插拔

### 13.1 Skill 热插拔

新 Skill 使用目录级自描述结构：

```text
skills/<skill-id>/
  manifest.yaml
  SKILL.md
  input.schema.json
  output.schema.json
  report-template.md
```

Planner 在每次创建新任务／重新规划时读取当前 Skill Catalog。符合公共合同的新目录可以被立即发现，不要求修改 Planner、Execution 或 Reporting 中央代码，也不要求重启服务。

为了避免更新过程读到半个目录，Skill 发布采用完整目录写入后原子切换。正在执行的 Task 使用 Plan 创建时冻结的 Skill 内容和 hash；Skill 更新只影响新 Task 或用户明确触发的 Replan，不得静默改变运行中的 Task。

需要新增真实 Tool Adapter 的 Skill 仍然需要发布对应代码；纯 Prompt、Schema、Knowledge 和报告模板 Skill 可以热插拔。

### 13.2 Plan 热插拔

需要区分“方案模板”和“某个 Task 已确认的 Plan”：

- 方案模板／Plan Definition 可以随时新增和更新，并在下一次规划时生效；
- 已确认 Plan 必须冻结，不能因文件更新而在执行中改变；
- 用户需要采用新版方案时，创建一个新的 Plan 并重新确认；
- Single/Multi 模式在 Task 创建后保持不变。

Plan Definition 只引用 Skill ID、依赖、角色和输入映射，不嵌入 Skill 内部实现。这样可以增加、替换或调整方案组合，而不修改 Runtime。

Plan Definition 使用同样的目录级合同，例如：

```text
plans/<plan-id>/
  plan.yaml
```

其中只声明适用条件、Skill ID、角色、依赖和输入映射，不包含 Runtime 实现代码。

### 13.3 最小加载策略

为保持实现轻量，不建设配置中心或复杂 Watcher：

```text
创建任务／Replan
→ 扫描 Skill 与 Plan 目录
→ 校验最小 Manifest/Schema
→ 形成不可变 Catalog Snapshot
→ 写入当前 Plan
```

该策略已经满足“新增或更新后对下一次规划立即生效”，同时保证运行中的任务稳定。

## 14. API 与 Web 数据边界

建议新任务只暴露：

```text
GET /control-tasks/:id
GET /control-tasks/:id/skill-reports
GET /control-tasks/:id/final-report
GET /control-tasks/:id/final-report.html
```

Web 不再读取：

- ReportDocument version；
- ReportPackage version；
- Cross-Skill Review；
- Contribution Ledger；
- Showcase Spec。

现有路由和组件可以通过一个短期内部替换直接切换到新响应；不保留旧响应兼容分支。

## 15. 历史数据策略

- 历史数据库记录不删除。
- 历史 `run-workspaces/` 文件不删除。
- 历史 HTML、Markdown、JSON 和截图不修改。
- 新 Runtime 不解析旧 Plan、ReportDocument、ReportPackage 或 Review。
- 如需查看历史结果，直接打开当时保存的文件或提供静态归档入口。
- 不建设迁移器、双读层、旧数据回填或旧版本自动转换。

## 16. 实施阶段

### 开发隔离策略

本方案不在当前 ai-x 工作目录直接开发，使用独立 Git Worktree。

准备工作已于 2026-09-04 完成：

```text
原 Worktree：/Users/heyunshen/work/PROJECT/jdc/ai-x
原分支：fix/single-skill-v2-gap-reconciliation
基线提交：ff97f5c

新 Worktree：/Users/heyunshen/work/PROJECT/jdc/ai-x-lightweight
新分支：refactor/lightweight-skill-orchestration
基线提交：ff97f5c
```

开发方案已经复制到新 Worktree，目前尚未提交；正式开发应在新 Worktree 的新 Session 中先提交本方案，再进入 Phase 0。原 ai-x Worktree 继续用于对照和维护，不在其中实施轻量架构代码。

Worktree 共享 Git 历史和对象库，但源码、依赖、环境变量和工作区互相隔离；可以随时比较差异，也不会污染原项目。当前未跟踪文件不会自动跨 Worktree 同步。

若轻量版本后续确定永久独立发布，再从该分支建立独立仓库，不需要一开始就复制整套 `.git`、`run-workspaces` 和历史产物。

### Phase 0：冻结当前边界

- 完成或隔离当前未提交工作。
- 确定新任务切换点。
- 冻结 `SkillReportV1` 和 `FinalReportV1`。
- 选定一个 Single 和一个 Multi Fixture。

### Phase 1：Skill 输入与 SkillReport

- 为每个目标 Skill 声明 `SkillInputRequirement`。
- 实现会话、上传和有权限数据库资料的 Input Resolver。
- 实现跨 Skill 输入去重和 Invocation 绑定。
- 前台只展示未满足输入，并显示使用该输入的 Skill。
- 为可独立交付的 Skill 增加或确认 `report-template.md`。
- 统一 Skill 输出为 `SkillReportV1`。
- 保留各 Skill 原始 Markdown。
- 实现来源和 Gap 的最小检查。
- 实现 Skill/Plan 目录按规划请求重新扫描和 Snapshot 冻结。

### Phase 2：Single Skill

- Single Skill 直接形成 FinalReport。
- 实现 Markdown → HTML Renderer。
- 实现 Markdown、HTML 和来源下载。
- 不接入旧 Report Review/Document/Package。

### Phase 3：Multi Skill

- 汇总 SkillReport[]。
- 实现一次最终 LLM 综合。
- 系统确定性追加来源和 Gap。
- 实现综合失败时的 Skill 分组降级报告。

### Phase 4：Web 接线

- 保留 Stage 1～3 交互与样式。
- Stage 2 适配轻量 Plan。
- Stage 3 展示 Skill 执行状态。
- Stage 4 切换为“最终报告 / Skill 明细”。
- 移除旧报告版本判断和 Showcase UI。

### Phase 5：删除旧新任务链路

- 停止新写 ReportReview v1/v2/v3。
- 停止新写 ReportDocument v1/v2/v3/v4。
- 停止新写 ReportPackage v1/v2/v3。
- 移除 Deterministic Showcase 和旧 Summary/Detail 组合代码。
- 移除新任务路径中的 Legacy Skill 分支。
- 旧文件与数据库记录保留但不再由新代码读取。

### 2026-09-04 实施状态

- 新 Task 统一写 `lightweight-execution-plan-v1`；生产执行入口拒绝旧 v2/v3 Plan。
- Skill 正文、输入合同、报告模板和 hash 随 Plan 冻结；未声明专用模板的 Skill 使用最小通用 Markdown 骨架。
- `ResolvedPlanInputs` 支持 resolved、pending 和用户明确 waived 的可选输入；会话字段、上传图片/数据集与受控 Gate 已接线。
- Skill 直接生成并封存 `skill-report-v1` JSON/Markdown；Single 不再调用报告 LLM。
- Multi 移除执行 Plan 中的旧 Synthesizer Skill，直接消费 `SkillReport[]`，只调用一次最终综合；失败使用确定性分组报告。
- 唯一终态根为 `reports/final-report.json`；Markdown、无脚本 HTML、来源和 Skill 明细均独立封存，报告失败重试复用成功 Tool/Skill。
- 新 API 与 Web Stage 2-4 已接线：输入来源/目标 Skill、执行 DAG、`最终报告 / Skill 明细`、Markdown/HTML 下载。
- 新任务路径不写 Deliverable、ReportReview、ReportDocument、ReportPackage、Contribution Ledger 或 Showcase Artifact；旧数据文件和数据库行未修改。
- `pnpm quality` 与 `pnpm --dir apps/web build` 已通过；真实 Single/Multi smoke harness 已切换到 FinalReport/SkillReport 收据。
- 当前 Worktree 没有 Gateway 凭据和 `ALLOW_REAL_PROVIDER=1` 命令级授权，因此尚未执行真实 smoke；不得通过修改 `.env` 绕过该门禁。

## 17. 测试与 CI

PR 必须验证：

- SkillReport Schema；
- Single Skill 直接报告；
- Multi Skill 一次综合；
- 来源不可伪造；
- Gap 可见；
- Markdown/HTML 安全；
- Stage 1～4 Web Fixture；
- 一个 Single Fixture；
- 一个 Multi Fixture。

普通 PR 不运行真实 LLM。

真实 Gateway/Tool 验收只在手动或 Release 阶段运行：

```text
1 条 Single Skill
1 条 Multi Skill
```

不再默认顺序执行全部 Skill Profile 的真实 Smoke。

## 18. 验收标准

### 产品验收

- 当前 Web 四阶段流程可继续使用。
- 当前问询、候选方案、确认、上传和执行进度交互保留。
- 问询项全部来自当前 Plan 中实际 Skill 的输入合同。
- 用户已在会话、上传材料或有权限数据库中提供的信息不重复询问。
- 多个 Skill 的相同输入需求只询问一次，并正确绑定到全部目标 Invocation。
- Skill 和方案模板更新后对下一次创建任务／Replan 生效，运行中 Plan 不发生漂移。
- Single Skill 最终报告严格保留 Skill 自己定义的章节结构。
- Multi Skill 最终报告能够综合全部成功 Skill 的核心结果。
- Multi Skill 页面可以查看每个 Skill 原始报告。
- 综合失败时仍能看到全部 Skill 原始结果。
- 资料不足显示为 Gap，不错误触发 Legal/Security Approval。

### 架构验收

- 修改 Skill 报告结构不修改 Execution Runtime。
- 修改 HTML 样式不修改 Skill 或 Planner。
- 新增 Skill 不修改最终综合器核心逻辑。
- Reporting 不依赖 LeaseExecutionEngine。
- 每类新 Artifact 只有一个当前版本。
- 新任务代码不包含历史 Reader/Writer 分支。
- 报告失败不重新执行 Tool 或 Skill。

### 输出验收

Single Skill：

```text
SkillReport → report.md → report.html
```

Multi Skill：

```text
SkillReport[] → 一次 LLM → report.md → report.html
```

最终 HTML 必须：

- 使用当前 Web 视觉语言；
- 无 JavaScript；
- 无运行时网络依赖；
- 来源可点击或可定位；
- Gap 和待验证项可见；
- 可下载；
- 不丢失 Skill 原始报告。

## 19. 工期评估

本方案是中大型重构，但因为明确不兼容历史合同、复用现有 Web、数据库、Tool 和 Skill 内容，规模显著小于在当前架构上继续叠加新版本。

以下按一名熟悉代码库的开发者配合 AI、优先迁移 3～5 个代表性 Skill 估算：

| 阶段 | 预计时间 |
|---|---:|
| 新 Worktree、合同和目录骨架 | 0.5～1 天 |
| Skill 输入合同、会话/上传/数据库 Input Resolver、问询去重 | 2～3 天 |
| SkillReport 与 Single Skill 直出 | 2～3 天 |
| Multi Skill 一次综合、来源合并和失败降级 | 2～3 天 |
| Web Stage 2～4 接线并保留现有样式 | 2～3 天 |
| Skill/Plan 热插拔与 Snapshot | 1～2 天 |
| Fixture、集成测试和真实 Single/Multi 验收 | 2～3 天 |

可交互的技术纵切版本预计 5～7 个工作日；覆盖 3～5 个代表性 Skill、具备完整 Single/Multi/Web/问询链路的可用版本预计 10～15 个工作日。

如果一次性迁移当前全部 active Skill，为每个 Skill 明确输入需求和报告模板，并删除旧新任务链路，预计 15～25 个工作日。主要变量不是 Runtime 代码，而是每个 Skill 的输入合同、报告结构和真实输出校准质量。

建议先完成代表性纵切：

```text
Single：一个自带明确报告模板的 Skill
Multi：竞品分析 + Persona/JTBD + 一个综合报告
```

纵切通过后再批量迁移其余 Skill，避免先改 25 个 Skill 再发现公共合同需要调整。

## 20. 最终目标

将项目从：

```text
多版本执行合同
+ 多轮审核
+ 多代 ReportDocument
+ 多代 ReportPackage
+ Showcase / Summary / Detail 多路径
```

收敛为：

```text
需求
→ 方案
→ Skill 执行
→ SkillReport
→ Single 直出 / Multi 一次综合
→ Markdown
→ HTML
```

在不改变产品基础逻辑、当前 Web 主流程和 Single/Multi 两种模式的前提下，使 Skill、执行、综合和展示成为边界清楚、可独立修改的模块。
