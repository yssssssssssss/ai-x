# 原版 Skill 包直连与通用编排开发方案

> 状态：已实施并完成本地门禁与真实 Single/Multi 验证
> 日期：2026-09-06
> 适用范围：新建任务与用户主动 Replan；`single_skill`、`multi_skill`
> 核心约束：第三方或团队已有 Skill 包保持原样，不要求为 ai-x 修改目录、提示词、References、模板或输出说明
> 清理约束：新能力替代旧能力时，同一开发阶段必须删除被取代的代码、配置、测试、文档和功能开关，不保留长期双轨
> 历史策略：历史 Task、Plan 和 Artifact 原样保留；不迁移、不回填，也不以历史数据为由保留旧的新任务执行链

## 1. 决策摘要

当前项目不再以“人工阅读原版 Skill，再重写成平台专属 Skill”的方式接入能力，而改为：

```text
原版 Skill Package（只读、内容不变）
+
平台侧安装信息、能力绑定和安全边界
```

保留现有产品流程：

```text
用户输入
→ 任务级理解与澄清
→ 检索候选 Skill
→ 读取候选 Skill 原始说明和所需 References
→ 解析并补齐 Skill 输入
→ 生成候选 Plan
→ 用户选择和确认
→ 冻结 Skill Package、知识和 Tool Binding
→ 按 Plan 执行
→ Single 直接交付 / Multi 一次综合
```

报告规则：

```text
Skill 包定义报告样式
→ 优先遵循 Skill 自己的结构和输出形式

Skill 包未定义报告样式
→ 将分析结果交给一次 Default Report Writer
→ LLM 根据本次需求自主组织结构
```

平台始终负责：

- 文件和权限边界；
- Tool 是否真实可用；
- Package、Reference、Plan 的版本冻结；
- 来源身份和 Hash；
- Gap 与待验证项；
- HTML 安全和 Artifact 封存。

平台不再负责为每个 Skill 重写方法正文、重新设计报告章节或维护一份缩水副本。

本方案采用“替换即清理”原则：新路径完成同等能力验证后，必须在同一开发任务中移除已被取代的旧路径；不能通过长期保留旧入口、旧 Reader、旧 Schema、旧测试和切换开关来降低迁移风险。

## 2. 当前问题与改造动因

### 2.1 当前接入方式会造成能力漂移

当前常见路径是：

```text
原版 Skill
→ 人工摘取部分规则
→ 新写 Runtime SKILL.md
→ 手写 Registry
→ 手写 Execution Contract
→ 手写 Schema 和报告配置
```

这会导致：

- 原版和 Runtime 形成两个事实源；
- 原版更新后 Runtime 不会同步；
- 接入一个 Skill 需要工程开发；
- 方法、模板和边界在转写时丢失；
- 每个 Skill 都形成独立适配成本；
- 平台越扩展，Skill 维护负担越重。

### 2.2 Industry Market Analysis 是代表性证据

原版目录：

```text
/Users/heyunshen/work/PROJECT/jdc/ai-x/wiki/user-research/
00-source-sync/jd-design-system-md-v16/horizontal/user-research/
skills/industry-market-analysis/
```

包含：

```text
28 个文件
约 6,412 行
约 336 KB
```

当前 Runtime 目录：

```text
skills/industry-market-analysis/
```

只有：

```text
SKILL.md
references/industry-method.md

共 79 行，约 4.5 KB
```

这次收敛最初是有意设计。`docs/plans/2026-09-03-industry-market-analysis-deliverable-development.md` 明确规定：上游 Source Skill 是 `draft` 设计输入，V1 不直接激活、不复制全部 28 个文件，只将必要内容转换为受控 Runtime 合同。

该选择提升了可执行性和可追溯性，但也造成：

- 三档深度细则未完整迁移；
- 权威取数和双口径规则未完整迁移；
- 京东设计哲学与平台基线未完整迁移；
- 竞品选样、心智象限和模块级拆解方法未完整迁移；
- 品类差异资产的详细判断尺未完整迁移；
- 原版报告模板和 5 Tab 表达未进入新轻量路径。

### 2.3 Industry Skill 尚未完成轻量合同迁移

Industry Runtime Skill 在提交 `ff97f5c` 中按旧 typed-payload 链建立，之后项目才在 `9e0aad8` 切换到 `SkillReport / FinalReport` 轻量链。

当前存在以下不一致：

1. `skills/industry-market-analysis/SKILL.md` 要求输出 `industry-market-content-draft-v1`，不生成 Markdown 或 HTML；
2. 轻量 Runtime 实际要求 Skill 输出 `SkillReportDraft.markdown`；
3. Registry 未给 Industry 声明 `report_template`，因此当前加载的是四节通用兜底模板；
4. 轻量执行将 `payloadSchemaHash` 设为 `null`，旧 Industry typed payload 不再是最终 Skill 输出合同；
5. Industry 执行合同的 `self-review` 仍从前一步读取 `/payload`，但轻量 SkillReport 不包含 `/payload`。

因此该问题不是 Industry 一个文件需要补长，而是当前“平台改写 Skill”模式与新轻量执行合同不再一致。

## 3. 目标

### 3.1 产品目标

- 用户可以安装已有 Skill 包，无需修改包内文件；
- 新 Skill 在下一次创建 Task 或 Replan 时可被发现；
- 保留当前四阶段 Web 流程；
- 保留用户显式选择并冻结 `single_skill` / `multi_skill`；
- 保留任务级澄清、候选 Plan、计划确认、执行进度和报告下载；
- 问询来自本次实际候选 Skill 的真实输入需求；
- Skill 包内知识和模板可以直接闭环使用；
- 已授权外部知识目录新增内容后，可供新任务读取；
- Single 优先保留原版 Skill 输出结构；
- Multi 保留每个 Skill 原始结果，并只做一次最终综合；
- Skill 更新不影响运行中任务。

### 3.2 工程目标

- Skill Package 是方法和输出要求的唯一内容事实源；
- 平台不再维护同一 Skill 的缩水副本；
- 平台侧只保存安装、权限、能力映射和执行快照；
- 所有外部 Tool 调用继续在用户可见 Plan 中出现；
- Knowledge 和文件读取可追溯到路径、版本和 Hash；
- 新增纯 Prompt／Reference Skill 不要求修改 Planner、Executor 或 Reporting 中央代码。

## 4. 非目标

第一版不建设：

- 任意代码插件平台；
- 自动执行 Skill 包中的 Shell、Python、Node 或二进制文件；
- 对任意绝对路径的无限制文件读取；
- 自动获取未知外部系统的认证凭据；
- 把全部 Skill 文件一次性放进模型上下文；
- 用固定关键词表完全替代 LLM 的 Skill 判断；
- 多轮报告 Reviewer 或自动全文 Repair；
- 历史 Task 和旧 Artifact 迁移；
- 第三种用户可见编排模式；
- 新旧 Skill Loader、Planner、Executor 或 Reporting 的长期双轨；
- 为已被替代的实现保留兼容开关、旧入口或兜底 Reader。

依赖平台不存在的 Tool、脚本、凭据或文件解析器时，Skill 可以安装，但状态必须显示为 `needs_binding` 或在 Plan 中形成明确 Capability Gap，不能静默模拟成功。

## 5. 核心原则

### 5.1 Skill 包不可变

安装后的原版 Skill Package 只读。平台不得：

- 改写 `SKILL.md`；
- 新增强制 `manifest.yaml`；
- 将原 References 摘抄成另一份 Runtime Reference；
- 用通用模板覆盖原报告结构；
- 在包内写平台缓存、执行日志或生成结果。

本地开发可以挂载原目录；可部署环境应将原目录按字节复制到受管安装区，并验证 Package Hash。复制用于部署，不改变内容。

### 5.2 平台合同放在包外

平台需要的运行信息由扫描器自动生成，保存在平台数据库或受管缓存中，不写入 Skill Package。

### 5.3 Plan 先于执行

Skill 中的外部 Tool、数据读取和副作用必须先转成用户可见 Plan，再执行。不得让 Skill 在运行时隐藏调用未出现在 Plan 中的 Tool。

### 5.4 运行中快照不漂移

```text
Package 更新 / 外部知识新增
→ 新 Task 或 Replan 生效
→ 已确认并运行中的 Plan 继续使用冻结版本
```

### 5.5 只在可信边界做安全控制

平台只强制：

- 路径和权限；
- Tool 和外部副作用；
- 数据敏感性；
- 来源真实性；
- 输出安全。

平台不通过固定章节、领域关键词或硬编码规则重新解释 Skill 的专业内容。

### 5.6 替换即清理

每一阶段都必须同时完成“新增目标能力”和“删除被替代实现”。完成标准不是新路径能够运行，而是仓库中只剩一个面向新任务的权威路径。

必须同步清理：

- 被原版 Package 替代的精简 Skill 副本；
- 不再读取的 Registry 字段、Schema、Prompt 和 Report Template；
- 旧 Loader、Planner、Executor、Reporter 分支；
- 仅验证旧路径的测试、Fixture 和 Smoke；
- 已失效的 Feature Flag、环境变量和 API 返回字段；
- 描述旧行为的开发文档、ADR、注释和示例命令；
- 无调用方的辅助函数、类型和导出。

清理顺序：

```text
为新路径建立等价自动化证据
→ 完成一次代表性真实闭环
→ 删除旧实现及其专属测试和配置
→ 运行引用检查、类型检查和完整测试
```

历史数据库记录和 Artifact 文件可以保留，但旧数据保留不等于旧执行代码必须保留。若历史内容不再由当前产品读取，应记录为归档数据，而不是继续维护兼容 Reader。

每个实施阶段结束时必须附带删除清单和残余引用检查；若旧路径仍有新任务调用方，该阶段不得标记完成。

## 6. 最小平台合同

第一版只新增三个内部对象，并冻结新的 `native-skill-execution-plan-v1`、`native-skill-result-v1` 与 `native-final-report-v1` 合同。现有 Task、Plan、Artifact 基础设施继续复用；旧 `lightweight-*` / `skill-report-v1` / `final-report-v1` 只作为实施期间和历史记录存在，切换后不再创建。

### 6.1 InstalledSkill

由平台扫描生成，不由 Skill 作者维护：

```ts
interface InstalledSkill {
  id: string;
  packageRoot: string;
  entryPath: string;
  packageHash: string;
  description: string;
  readiness: 'ready' | 'needs_binding' | 'blocked';
  missingCapabilities: string[];
}
```

`id` 优先取 `SKILL.md` frontmatter 的 `name`，缺失时使用目录名。`description` 优先取 frontmatter；不足时允许安装阶段生成检索摘要，但摘要不写回 Skill 包。

### 6.2 SkillRunSpec

由 Planner 针对一次 Task 生成并冻结：

```ts
interface SkillRunSpec {
  skillId: string;
  packageHash: string;
  selectedReferences: FrozenFileReference[];
  requiredInputs: SkillInputRequirement[];
  toolBindings: ToolBinding[];
  steps: PlanStep[];
  reportPolicy: ReportPolicy;
}
```

### 6.3 ReportPolicy

```ts
type ReportPolicy =
  | {
      kind: 'skill_defined';
      sourcePaths: string[];
      contentHashes: string[];
      outputFormat: 'markdown' | 'html';
    }
  | {
      kind: 'skill_output';
      outputFormat: 'markdown' | 'html';
    }
  | {
      kind: 'default_llm';
      promptVersion: 'default-report-v1';
      outputFormat: 'markdown';
    };
```

不再要求 Skill 包提供平台专属 Manifest、Input Schema、Output Schema 或固定命名的 `report-template.md`。

## 7. Skill Package 发现与安装

### 7.1 最低可识别条件

目录中只需要存在：

```text
SKILL.md
```

其余文件全部可选。

### 7.2 扫描内容

每次安装、新建 Task 或显式 Replan 时，平台扫描：

- `SKILL.md` frontmatter；
- 文件目录；
- `SKILL.md` 中出现的相对路径；
- README、References、Templates 的标题索引；
- 外部路径和 Tool 名称；
- 输出文件或报告格式要求。

### 7.3 Package Snapshot

冻结：

- 文件相对路径；
- 文件类型；
- 每个文件 Hash；
- 整体 Package Hash；
- 本次选择的 References 内容；
- 平台侧 Tool Binding；
- ReportPolicy。

Plan 不只记录活动目录路径，必须能够复现当次使用的内容。

### 7.4 更新语义

- 原子安装完整目录后才对新任务可见；
- 内容变化产生新的 Package Hash；
- 新任务自动使用新版本；
- 运行中任务继续使用旧快照；
- 用户主动 Replan 才切换到新版。

第一版不需要文件 Watcher，任务创建和 Replan 时扫描即可。

## 8. Skill 包内知识读取

### 8.1 相对路径

Skill 包内相对路径默认允许只读，例如：

```text
references/workflow-overview.md
references/stages/阶段2-外部数据调研.md
references/templates/报告模板-中档.md
```

解析规则：

- 相对路径基于 Skill Package Root；
- 禁止 `..` 越界；
- 禁止符号链接逃逸；
- 文件必须属于冻结 Package Manifest；
- 使用前核对 Hash。

### 8.2 按需选择，禁止全量注入

平台先读取：

```text
SKILL.md
README（若存在）
文件树
标题索引
```

Planner 再根据本次任务返回 `selectedReferences`。平台验证路径后只加载这些文件。

例如 Industry 中档任务可选择：

```text
references/workflow-overview.md
references/foundations/三档深度对照表.md
references/foundations/反幻觉六类硬规则.md
references/foundations/权威数据取数清单.md
references/stages/阶段2-外部数据调研.md
references/stages/阶段3-京东内部诊断.md
references/stages/阶段5-机会与策略合成.md
references/stages/阶段6-设计语言推导.md
references/stages/阶段7-品类差异资产.md
references/templates/报告模板-中档.md
```

本次选择及其 Hash 冻结进 Plan。

### 8.3 引用闭环

每个被使用的包内文件生成稳定来源身份：

```ts
interface FrozenFileReference {
  logicalPath: string;       // skill://<id>/<relative-path>
  contentHash: string;
  packageHash: string;
  selectedBy: 'explicit_reference' | 'semantic_retrieval';
}
```

报告可以引用这些 Source ID，最终来源附录由平台确定性生成。

## 9. 外部知识路径

### 9.1 Knowledge Mount

Skill 指向包外目录时，平台不开放任意文件系统，而是在平台侧配置只读 Mount：

```yaml
id: research-wiki
source: /approved/path/to/research-wiki
mode: read_only
allowed:
  - "**/*.md"
  - "**/*.json"
```

这是平台配置，不修改 Skill 包。

### 9.2 路径解析

Skill 中的外部路径由安装记录绑定到逻辑路径：

```text
knowledge://research-wiki/...
```

只有以下路径可读取：

- Skill 包内部路径；
- 已授权 Knowledge Mount；
- 当前 Task 已上传 Artifact；
- 当前用户有权限的数据库资料。

### 9.3 新数据生效

```text
向已授权目录新增或更新文件
→ 下一次 Task / Replan 重新扫描
→ 生成新内容 Hash
→ 新 Plan 使用新内容
```

正在运行的 Plan 不读取新增文件。

### 9.4 外部系统不等于文件路径

Skill 若要求实时访问 Joyspace、数据库、O2 或其他 API，仅添加本地文件不能代表实时能力已经接通。

- 本地导出可以作为带时间戳的 Snapshot；
- 实时访问仍需要 Tool Adapter、认证和权限；
- Snapshot 不得冒充实时结果；
- Tool 不可用时形成 Capability Gap。

## 10. 文件类型边界

| 类型 | V1 处理方式 |
|---|---|
| Markdown / TXT | 直接读取，按预算选择内容 |
| 小型 JSON | 解析后读取 |
| CSV | 继续经过 Dataset Gate、PII 和有界 Model View |
| 图片 | 继续作为 Visual Artifact 处理 |
| HTML 输入 | 提取文本和结构；不得执行其中脚本 |
| HTML 输出 | 保留结构并做安全清理 |
| PDF / DOCX / XLSX | 需要已有解析器；无解析器时显示缺失能力 |
| 可执行脚本 | V1 不自动执行 |

Knowledge 文件按不可信数据处理，不能借其中的文本修改 Tool 权限、Plan 或系统指令。

## 11. 保留需求分析与计划生成

### 11.1 两层澄清

继续保留：

```text
第一层：任务级澄清
目标、范围、Single/Multi、交付物和关键边界

第二层：Skill 级澄清
根据候选 Skill 的原始说明，解析完成任务所需输入
```

第二层流程：

```text
候选 Skill
→ 读取原始 SKILL.md 和相关 References
→ 生成本次 SkillInputRequirement
→ 检查会话
→ 检查 Task 上传
→ 检查授权数据库资料
→ 检查 Knowledge / Tool 能否提供
→ 合并相同需求
→ 只询问仍未满足的输入
```

`SkillInputRequirement` 存入本次 Plan，不写回 Skill 包。

### 11.2 Skill 匹配

保留三种入口：

1. 用户显式指定 `$skill-id`；
2. 名称或描述明确匹配；
3. Planner 根据需求和 Skill 原始说明进行语义匹配。

当前 `task_type` 和 Deliverable 继续用于理解任务与限定交付，但不再要求每个外部 Skill 必须先人工加入封闭枚举才能被发现。

匹配顺序：

```text
Catalog 粗召回
→ 读取少量候选 SKILL.md
→ 结合 ProblemGraph 判断覆盖
→ 检查输入和 Tool 可用性
→ 形成 Single 或 Multi 候选方案
```

### 11.3 Plan 生成

Plan 必须记录：

- 使用哪些 Skill Package；
- 每个 Skill 负责哪些问题；
- 选择哪些 References；
- 需要哪些输入；
- 使用哪些 Tool；
- Tool Binding；
- 输出形式和 ReportPolicy；
- Package、Reference、Prompt 与 Tool 版本 Hash；
- 缺失能力和降级方式。

LLM 可以提出步骤，平台只校验真实边界：文件存在、路径被授权、Tool 存在、依赖无环、必需输入已满足、输出策略有效。

不通过硬编码领域规则重新判断 Skill 的专业方法。

## 12. Tool Binding

### 12.1 同名或同能力 Tool

原版 Skill 使用的 Tool 若与平台已有 Tool 对应，可以在平台侧绑定：

```text
WebSearch → tavily-web-search
Joyspace search/view → joyspace-read
```

Binding 存在安装记录或 Plan 中，不修改 Skill。

### 12.2 缺失 Tool

```text
Skill 已安装
+ Tool 不存在或不可用
→ readiness = needs_binding
→ Plan 展示缺失能力
```

处理方式只能是：

- 增加真实 Tool Adapter；
- 用户调整 Plan；
- 原 Skill 明确允许时形成 Gap；
- 阻断必需能力。

不得通过模型模拟 Tool 结果。

### 12.3 副作用

写入外部系统、发布、付费、修改设计稿或执行脚本，必须继续使用平台审批和权限边界。Skill 文本不能自行授予权限。

## 13. 执行模型

V1 继续使用现有可见 Plan 和 DAG，不引入隐藏 Agent Tool Loop。

```text
SkillRunSpec
→ 显式 Tool / Knowledge 步骤
→ 显式 LLM 分析步骤（必要时）
→ 原版 Skill 执行步骤
→ 原始输出 Artifact
```

原则：

- Tool 调用必须出现在 Plan；
- Skill 包和 Knowledge Mount 只读；
- 生成文件只能写入本 Task Workspace；
- Skill 可读取本包冻结 References；
- Skill 不得读取其他 Skill 的内部文件；
- Multi 中不同 Skill 通过显式 Artifact 传递结果；
- 不允许 Skill 在运行时偷偷调用第二个 Skill。

如果未来确实需要动态 Agent Loop，应作为后续独立能力，不纳入 V1。

## 14. 报告生成策略

### 14.1 报告样式发现优先级

平台按以下顺序判断 Skill 是否定义报告样式：

1. `SKILL.md` 明确写出的输出结构；
2. `SKILL.md` 明确引用的模板文件；
3. Workflow/Stage 文件明确指定的模板；
4. `references/templates/` 中被当前流程实际引用的模板；
5. 都不存在时使用 Default Report Writer。

不能仅凭文件名猜测。`framework.html`、示例报告或 Demo 只有被 Skill 明确声明为输出模板时才能作为模板；否则只作为参考资料。

多个模板可根据已经确认的档位、输出目的或用户选择确定。无法确定时，在 Plan 确认前询问一次。

### 14.2 有 Skill 原生样式

```text
分析材料
+ 原版 Skill 指令
+ 冻结报告模板
+ 已验证 Source Catalog
→ LLM 按 Skill 样式生成报告
```

要求：

- 保持章节和顺序；
- 保留专业表格、矩阵和附录；
- 不用通用模板重写；
- Single 不再调用第二个报告 LLM；
- 平台只追加来源、Gap 和安全外壳。

### 14.3 无报告样式

不再套用当前固定四节模板：

```markdown
# 标题
## 结论
## 分析结果
## 建议
## 限制和待验证内容
```

改为一次 Default Report Writer：

```text
用户需求
+ ProblemGraph
+ 已完成分析材料
+ 请求交付物
+ 已验证 Source Catalog
+ Gap
→ 一次 LLM 动态生成最终 Markdown
```

Default Prompt：

```text
请基于用户需求和已完成的分析材料生成一份完整的最终报告。

直接回答用户问题，自主决定最合适的章节、数量和顺序；结构清晰，结论优先，表达简洁准确，避免重复。
对适合比较的信息优先使用表格或矩阵；对适合表达流程、关系、层级和优先级的信息优先使用图示。
只有材料中存在可靠、可验证的数据时才能生成数据图表，不得补造数字。
只能使用提供的事实、分析结果、Source ID 和 URL；不得新增来源、事实、数字或提升证据等级。
证据不足的判断必须标记为推断、暂定结论或待验证。
只输出 Markdown，不输出 JavaScript。
```

该 Prompt 只有质量和证据约束，不定义固定报告章节。

这会修改 ADR-0012 中“Single 一律不进行第二次内容 LLM”的规则：

```text
有原生报告结构
→ 不做第二次 LLM

无原生报告结构且 Skill 输出仍是分析素材
→ 允许一次 Default Report Writer
```

不得增加后续 Reviewer 或全文 Repair 循环。

### 14.4 图表和图形

“多用图表图形”是表达偏好，不是数量门槛。

LLM 可以生成或建议：

- Markdown 表格；
- 对比矩阵；
- 时间线；
- 流程图；
- 层级图；
- 用户旅程；
- 策略地图。

柱状图、折线图、饼图、漏斗和评分图只能使用已验证数据。推荐流程：

```text
已验证数字
→ Chart Data / Spec
→ 平台确定性 Renderer
→ SVG / HTML
```

不得为满足“图表丰富”而编造比例、规模、趋势或评分。

### 14.5 HTML

- 默认报告 LLM 输出 Markdown；
- 平台统一渲染安全 HTML；
- Skill 明确要求 HTML 时，可以保留其安全结构和 CSS；
- 必须移除 JavaScript、事件属性、iframe、form 和运行时网络请求；
- 原始 HTML 可以作为审计 Artifact 保存，用户展示使用安全版本。

## 15. Single Skill

```text
需求
→ 匹配一个原版 Skill Package
→ 解析输入和 References
→ 生成并确认 Plan
→ 执行 Skill
→ 应用 Skill 原生 ReportPolicy 或 Default Report Writer
→ 追加来源和 Gap
→ FinalReport
```

规则：

- Skill 有完整报告结构时，其结果就是正式正文；
- 不重新排列 Skill 章节；
- 无结构时才调用一次默认报告 LLM；
- Skill 原始输出始终作为独立 Artifact 保留；
- 报告生成失败不重新执行成功的 Tool 或分析步骤。

## 16. Multi Skill

```text
需求
→ 子问题拆解
→ 每个子问题匹配原版 Skill Package
→ 每个 Skill 独立执行
→ 保留每个原始结果
→ 一次最终综合 LLM
→ FinalReport
```

### 16.1 Skill 角色

原版 Skill 不需要在包内声明 `contributor` 或 `synthesizer`。这些角色由当前 Plan 分配，不写回 Skill 包。

### 16.2 各 Skill 报告

- 有原生样式：按原生样式生成；
- 无样式：可以保留分析材料，不强制为每个 Contributor 再生成一份包装报告；
- 所有原始结果在“Skill 明细”中保留。

### 16.3 最终综合报告

- Plan 明确指定报告 Owner 且其包提供顶层模板时，优先使用该模板；
- 多个 Contributor 模板不能机械拼成一个顶层模板；
- 没有明确 Owner 模板时，使用 Default Report Writer；
- 最终只允许一次综合调用；
- 综合失败时展示各 Skill 原始结果并形成 Gap，不重跑 Skill。

## 17. 输出合同调整

为保留原版 Skill 的输出形式，新路径冻结 `native-skill-result-v1`，从“只有 Markdown”调整为“一个主输出 + 附件”：

```ts
interface NativeSkillResult {
  version: 'native-skill-result-v1';
  skillId: string;
  invocationId: string;
  status: 'completed' | 'completed_with_gaps' | 'needs_input';

  primary: {
    format: 'markdown' | 'html';
    contentRef: string;
  };

  attachments: Array<{
    path: string;
    mediaType: string;
    contentHash: string;
  }>;

  sources: SourceReference[];
  gaps: string[];
}
```

平台 Adapter 负责把原版 Skill 的最终消息或生成文件包装为该合同，不要求 Skill 自己输出平台 JSON。最终报告使用 `native-final-report-v1`，Plan 使用 `native-skill-execution-plan-v1`。

历史 `lightweight-execution-plan-v1`、`skill-report-v1` 和 `final-report-v1` 不迁移。新入口切换后不再创建这些旧版本，旧 Task 保留原样且不保留面向新任务的兼容分支。

## 18. Industry Market Analysis 的迁移方式

Industry 只作为首个大型验收样本，不做专属代码。

### 18.1 安装

将原版目录按字节原样安装到受管 Skill Root，或开发环境只读挂载：

```text
industry-market-analysis/
├── SKILL.md
├── README.md
└── references/**
```

记录完整 Package Hash，不改动包内文件。

### 18.2 规划

根据原 Skill：

- 询问品类、子类、排除范围、档位、主次聚焦和材料；
- 根据档位选择对应 Stage 和报告模板；
- 将 Web、Joyspace、Dataset、截图需求映射到现有平台能力；
- 不支持的 O2 数据源形成明确 Capability Gap。

### 18.3 报告

- 轻档使用原轻档模板；
- 中档使用原中档模板；
- 重档使用原重档模板；
- 一次摸底使用三档合一模板；
- 用户明确要求 HTML 时，按原 Skill 语义生成并进行平台安全处理；
- `framework.html` 继续只作为展示参考，除非原 Skill 明确选择它作为输出模板。

### 18.4 移除当前重复实现

只有在原版包完成自动化和真实验收后，才删除或停用：

```text
skills/industry-market-analysis/SKILL.md
skills/industry-market-analysis/references/industry-method.md
```

同时移除旧 typed `/payload` 与轻量 SkillReport 的双重合同，不保留兼容分支。

## 19. 实施阶段

### 实施总则：每阶段都包含清理

每个 Phase 都必须列出并完成：

```text
新增或替换了什么
删除了哪些旧实现
保留了哪些内容以及保留理由
通过什么证据证明没有新旧双轨
```

不得把删除旧代码统一推迟到一个没有明确边界的未来阶段。若某项旧实现仍被下一阶段短暂依赖，必须在当前 Phase 的交付记录中列出唯一调用方和确定删除点。

### Phase 0：冻结合同和失败样本

- 保存当前 Industry 轻量转换中的 `/payload` 不兼容证据；
- 冻结 `native-skill-execution-plan-v1`、`native-skill-result-v1` 和 `native-final-report-v1`；
- 选择三个测试包：大型多 Reference、有原生模板、无报告模板；
- 冻结 Package、Knowledge、ReportPolicy 和 Tool Binding 最小合同；
- 更新 ADR-0012 中与本方案冲突的规定。

### Phase 1：Package Reader 与 Snapshot

- 扫描未修改的 Skill Package；
- 解析 frontmatter、文件树和相对引用；
- 生成 Package Hash；
- 实现只读包内文件访问；
- 新 Task / Replan 重新扫描。

第一阶段控制在约 4 个新增实现文件以内，不建设 Watcher 或插件市场。

### Phase 2：Planner 与输入解析

- Catalog 基于原版 name、description 和 SKILL.md 召回；
- 为候选 Skill 生成 SkillRunSpec；
- 选择本次 References；
- 提取输入需求并复用现有会话、上传、数据库解析；
- 生成可见 Plan；
- 冻结 Package 和 Knowledge Binding。

### Phase 3：Native Skill Runner 与报告策略

- 执行冻结的原版 Skill；
- 绑定已有 Tool；
- 捕获原始输出和附件；
- 支持 `skill_defined` 与 `default_llm` 报告策略；
- Single 直出，Multi 一次综合；
- 修复 Industry `/payload` 与 SkillReport 冲突。

### Phase 4：迁移与删除重复副本

- 将现有 active Skill 改为原版包安装；
- 不逐个重写内容；
- 原版不存在或确为平台自产的 Skill 保持原目录；
- 删除已被原版包替代的精简副本；
- 删除不再使用的中央 Registry 内容元数据，仅保留安装、权限与 Tool Binding；
- 删除旧 v2/v3 新任务规划和执行分支；
- 删除旧 typed-payload、Canonical、ReportReview、ReportDocument、ReportPackage 和双报告链中已无新任务调用方的代码；
- 删除对应 Feature Flag、环境变量、API 字段、测试、Fixture、Smoke、文档和注释；
- 使用静态引用搜索确认无生产调用方；
- 不增加兼容层，不保留“暂时双跑”作为完成状态。

Phase 4 不是可选的后续整理。只有清理和验证同时完成，整个开发任务才算完成。

## 20. 验收标准

### 20.1 Package 完整性

- 安装前后所有原版文件 Hash 一致；
- 平台没有写入或修改 Skill Package；
- 相对引用能正确解析；
- 路径越界和符号链接逃逸被拒绝。

### 20.2 知识闭环

- Skill 包内明确引用的文件可被读取；
- 只加载本次选择的 References；
- 报告可追溯到文件路径和 Hash；
- 外部 Mount 新增内容只影响新 Task/Replan；
- 未授权目录不可读取。

### 20.3 需求与 Plan

- 保留任务级澄清；
- 自动匹配原版 Skill；
- Skill 级输入问询来自原始 Skill 内容；
- 已有会话、上传和授权数据库资料不重复询问；
- 所有 Tool 调用在 Plan 中可见；
- 用户选择和确认后才执行。

### 20.4 报告

- 有模板 Skill 的章节和顺序符合原模板；
- 无模板 Skill 不套固定四节结构；
- 默认报告能够直接回答用户问题；
- 图表不得使用未验证数字；
- 来源和 Gap 确定性追加；
- Single 有模板时没有额外报告 LLM；
- Single 无模板时最多一次 Default Report Writer；
- Multi 最多一次最终综合；
- HTML 无脚本、事件属性和运行时网络请求。

### 20.5 代表性闭环

至少验证：

1. 一个简单、包内无 References 的 Skill；
2. 一个包含多级 References 和多套模板的 Skill；
3. 一个没有报告模板、使用 Default Report Writer 的 Skill；
4. 一个依赖已有 Tool 的 Skill；
5. 一个引用已授权外部 Knowledge Mount 的 Skill；
6. 一个缺少 Tool、正确显示 `needs_binding` 的 Skill；
7. 一个 Single 真实 Smoke；
8. 一个 Multi 真实 Smoke。

真实模型校准前，先按照 `docs/agents/real-llm-development-workflow.md` 冻结本地合同和诊断。

### 20.6 清理与复杂度

- 新任务只有一个 Skill 发现入口、一个 Package Loader、一个 Planner 输出合同和一个报告终态根；
- 不存在通过 Feature Flag 维持的新旧执行双轨；
- 被替代的精简 Skill、旧报告链及其专属测试已删除；
- Registry、环境变量、API、文档和测试中没有残留旧字段或旧路径说明；
- 全仓引用搜索没有发现已删除能力的生产调用方；
- `git diff --check`、类型检查、Registry/Knowledge Lint、测试和 Web Build 全部通过；
- 交付说明包含删除清单、保留项理由和仍存在的真实风险。

## 21. 完成定义

只有同时满足以下条件，才能称为“原版 Skill 可直接使用”：

- 将一个现有 Skill 目录原样安装，包内文件零修改；
- 新任务能够自动发现并匹配它；
- Planner 能读取其真实说明和必要 References；
- 用户输入和缺失材料问询正确；
- Plan 展示真实 Tool 和步骤；
- 运行期间使用冻结 Package；
- 包内和外部知识形成可追溯引用；
- 有报告样式时保持原样；
- 无报告样式时由一次默认 LLM 动态生成；
- Single/Multi 流程均不要求 Skill 作者学习 ai-x 专属 Schema；
- 未支持能力明确失败或形成 Gap，不被模型模拟；
- 原版更新后，新任务可使用新版，运行中任务不漂移；
- 被新路径替代的旧代码、配置、测试、文档和开关已在同一开发任务中删除；
- 仓库中不存在面向新任务的新旧双轨或无调用方残留实现。

## 21.1 实施结果与证据（2026-09-06）

已完成：

- `InstalledSkillCatalog` 自动扫描 `skills/`、`knowledge-base/skills/` 与可选 `SKILL_PACKAGE_ROOTS`，不再由中央 Skill Registry 提供名称、说明、路径或正文；
- `SkillPackageSnapshot` 冻结完整文件清单、入口正文、Package Hash，并拒绝路径穿越和符号链接；
- `orchestrator/skill-bindings.yaml` 仅保留启停、输入种类、Tool/权限和组合角色等平台绑定；
- `SKILL_KNOWLEDGE_MOUNTS` 提供包外只读知识授权，选中内容及 Hash 进入 Plan；
- 新 Task 和 Replan 只持久化 `native-skill-execution-plan-v1`；确认、执行、恢复、API 与 Web 均以该判别项为准；
- Skill 结果与最终报告分别使用 `native-skill-result-v1`、`native-final-report-v1`，支持 Markdown、HTML、文本、JSON 主输出和附件；
- Single 在 `skill_defined` 时零额外报告调用，在 `default_llm` 时恰好一次；Multi 恰好一次最终综合；
- 包内/挂载知识来源以逻辑路径和内容 Hash 进入结果来源；未验证 URL 被确定性移除并形成 Gap；
- 删除旧 Lightweight 合同、Reporter、Stage 4、中央 Skill Registry、Industry 精简副本、平台 Execution YAML、旧专属测试与已被接替的实施文档。

真实闭环证据：

- Single：Task `f6a54024-3e6c-42f4-9961-5cb00e40e283`，Plan `fe89b168-48b9-4548-913e-e0b758a869e0`，Attempt `0875f578-8be5-46d3-bdfe-802fa1b995c6`；真实 Gateway + Tavily；`native-final-report-v1` Artifact `a51b5167-7b92-4c24-8089-c49f1fdac642` 已 SEALED；`synthesisCallCount=0`。
- Multi：从已冻结 Native Plan 恢复执行，Task `3e6d7c7c-8a5a-4132-b289-5ae19dd8eb15`，Plan `af3c2f56-21de-4349-a061-b20afe1344d1`，Attempt `05ea92f0-f52e-45a7-8e49-62c01884da6`；3 个 `NativeSkillResult`，最终 `native-final-report-v1` Artifact `b81df88c-eaa1-45ae-897f-e2e9edb50438` 已 SEALED；`synthesisCalls=1`；未产生旧报告 Artifact。

最终本地门禁：

- `pnpm test`：2321 tests，2303 passed，0 failed，18 skipped；
- `pnpm typecheck`：通过；
- `pnpm lint:registry`：通过；
- `pnpm lint:knowledge`：通过；
- `pnpm --dir apps/web build`：通过；
- `git diff --check`：通过；
- 独立只读复审：通过，无剩余发布阻断项；
- Industry 原版目录与上游 28 个文件逐字节比较：无差异。

保留项：旧 Current v2/v3 类型与 ReportPackage 组件仍服务于仓库内独立的历史/发布功能，但新 Task 的确认门禁只接受 Native Plan，Native 执行在 FinalReport 封存后立即结束，不会进入旧报告链。

## 22. 最终目标

将当前模式：

```text
原版 Skill
→ 人工重写平台版
→ 手工维护 Registry / Contract / Schema / Template
→ 内容逐渐漂移
```

改为：

```text
原版 Skill Package
→ 平台自动发现和只读安装
→ Planner 生成本次 SkillRunSpec
→ 用户确认可见 Plan
→ 平台绑定 Tool、Knowledge 和权限
→ 原版 Skill 执行
→ 原生报告优先 / 无模板时动态生成
→ FinalReport
```

平台负责“如何安全、可追溯地运行 Skill”，Skill 负责“如何完成专业工作以及结果应该如何表达”。
