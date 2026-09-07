# ADR-0013：原版 Skill Package 成为新任务能力真相源

- 状态：Accepted，已实施
- 日期：2026-09-06
- 开发方案：`docs/plans/2026-09-06-native-skill-package-orchestration-development.md`
- 取代范围：ADR-0012 中要求 Skill 作者提供平台专属输入合同、报告模板以及 Single 永不调用默认报告模型的部分

## 背景

ADR-0012 已将新任务报告链收敛为 SkillReport / FinalReport，但当前实现仍要求将已有 Skill 人工改写进中央 Registry，并为平台补写输入要求、执行合同和报告模板。该方式会形成原版与 Runtime 两份内容真相源。

`industry-market-analysis` 已证明这种漂移：上游原版有 28 个文件和完整方法、阶段与模板，Runtime 只保留两份精简文档；其旧 typed `/payload` 合同又与后续轻量 Markdown 输出发生冲突。

产品目标调整为：已有 Skill 包不经内容改写即可安装、规划和执行，同时保留现有需求理解、用户澄清、候选 Plan、Single/Multi 选择、受控 Tool、Artifact 和来源能力。

## 决策

### 1. 使用新的明确合同版本

原版包路径使用以下新合同，不扩展或猜测既有 v1：

```text
native-skill-execution-plan-v1
native-skill-result-v1
native-final-report-v1
```

旧 `lightweight-execution-plan-v1`、`skill-report-v1` 和 `final-report-v1` 只代表既有实现。新入口完成后，不再用于创建新任务；历史记录原样保留，不回填、不迁移。

### 2. Skill Package 不可变

一个可安装包最低只要求：

```text
<skill-root>/SKILL.md
```

平台不得要求作者在包内增加 `manifest.yaml`、平台专属 Schema、Tool ID 或报告模板。包内其他文件保持原路径和内容。

安装时生成平台侧 `InstalledSkill`，规划时生成并冻结 Package Manifest、Package Hash、被选择的 Reference 内容及 Hash。运行中任务不读取活动目录的新版本。

### 3. 平台侧运行绑定

平台侧而非 Skill 包负责：

- 安装启用状态；
- 文件和外部目录权限；
- Tool Capability Binding；
- 输入来源解析；
- 用户确认和审批；
- 输出安全；
- Artifact 和引用身份。

纯 Prompt／Reference 且只依赖已有能力的 Skill 可以直接进入规划。需要未知 Tool、凭据、解析器、脚本或外部副作用的 Skill 标记为 `needs_binding`，不得由模型模拟执行。

### 4. 保留现有规划流程

```text
用户输入
→ 任务级澄清
→ Skill Catalog 召回
→ 读取候选原版 SKILL.md 与目录索引
→ 生成本次输入、Reference、Tool 和步骤要求
→ 解析已有资料并询问缺失项
→ 生成候选 Plan
→ 用户选择和确认
→ 冻结并执行
```

`task_type` 和 Deliverable 继续描述任务与交付，但不再作为外部 Skill 必须人工加入封闭枚举的前置条件。用户显式 `$skill-id` 调用继续支持。

### 5. 包内与外部知识

包内相对路径默认在 Package Root 内只读解析。平台拒绝路径穿越、符号链接逃逸和运行时文件漂移。

包外知识必须通过平台批准的只读 Knowledge Mount 访问。新增或更新文件只影响新 Task 或 Replan。实时 API、数据库和 Joyspace 仍须真实 Tool Adapter 与权限；本地快照不得冒充实时结果。

Planner 只选择本次需要的 Reference，不把完整大型目录无条件注入模型。

### 6. 报告策略

Plan 冻结以下二选一策略：

```text
skill_defined
→ 按原版 Skill 明确指定的结构或模板生成

default_llm
→ 将分析结果交给一次默认报告模型，自主组织 Markdown
```

原生模板判断优先读取 Skill 明确说明和其引用的文件，不仅依赖固定文件名。多个模板根据已确认的档位或输出目的选择；无法确定时在 Plan 确认前询问。

默认报告模型不使用固定章节，只约束：直接回答、结构清晰、表达简洁、来源真实、Gap 可见。表格和图示按内容需要使用；数据图只能使用已验证数字。

Single 有原生完整报告时不进行第二次内容调用；无报告结构且输出仍是分析素材时，允许一次 Default Report Writer。Multi 最多进行一次最终综合。

### 7. 原始输出优先

新 `native-skill-result-v1` 使用一个主输出和附件，而不是强制所有 Skill 自己返回平台 JSON：

```text
primary: markdown | html | text | json
attachments: zero or more files
sources
gaps
```

平台 Adapter 包装原版 Skill 的最终消息或生成文件。默认 LLM 输出 Markdown；Skill 明确要求 HTML 时保留安全结构和 CSS，但展示前移除脚本、事件属性、表单、iframe 和运行时网络请求。

### 8. 显式 Plan，不引入隐藏执行

V1 继续使用当前可见 DAG。外部 Tool、Knowledge 和副作用必须出现在 Plan 中；原版 Skill 不得在运行时隐藏调用第二个 Skill或未批准 Tool。

第一版不实现任意代码插件或动态 Agent Tool Loop。

### 9. 替换即清理

新入口通过自动化和真实闭环后，必须在同一开发任务中删除被取代的：

- 精简 Skill 副本；
- 中央 Registry 内容元数据；
- 旧新任务 Loader、Planner、Executor 和 Reporter 分支；
- 旧 typed-payload、Canonical 和报告链调用方；
- 对应 Feature Flag、环境变量、API 字段、测试、Fixture 和旧文档说明。

历史数据保留不构成保留旧新任务执行代码的理由。最终仓库只能有一个面向新任务的权威路径。

## 实施结果

新任务入口已统一到 Native 合同；自动 Catalog、不可变 Package/Reference 快照、只读 Knowledge Mount、Tool Binding、Native Result/FinalReport、API/Web 展示与恢复链均已接通。中央 `orchestrator/skill-registry.yaml`、旧 Lightweight 合同与 Reporter、旧 Industry 精简包及平台执行 YAML 已删除。真实 Single 与 Multi 闭环分别验证了零额外 Single 综合和恰好一次 Multi 综合。

## 结果

### 收益

- Skill 作者无需学习或修改 ai-x 专属包格式；
- 原版方法、References 和模板不再因人工转写而丢失；
- 当前需求理解与候选 Plan 体验继续保留；
- Package 和外部知识可热更新，同时保证运行中任务可复现；
- Single 保留 Skill 原生表达，Multi 保留原始结果并只综合一次。

### 成本

- 需要 Package Reader、Snapshot、Reference Selection 和平台侧 Tool Binding；
- 现有 Markdown-only 报告合同需要一次破坏性替换；
- 现有 25 个 active Skill 需要确认原版来源或平台自产身份；
- 原版依赖未知 Tool 时不能保证零配置执行。

## 不变量

- 原版 Skill Package 内容零修改；
- Skill、Reference 和 Tool 版本在 Plan 中冻结；
- 用户选择的 Single/Multi 模式不在运行中改变；
- 来源、权限和外部副作用不由 Skill 文本自行授权；
- 缺失能力显式阻断或形成允许的 Gap；
- 新路径完成时同步删除旧路径，不长期双轨。

## 回滚

切换新任务入口前可整体回滚本开发分支。切换后若停止创建新任务，只保留已封存 Plan 和 Artifact，不把它们转换到旧合同，也不重新启用旧的新任务入口。
