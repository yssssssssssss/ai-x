# Task Material 进入 Planner 并强制消费的修复方案

> 状态：Implemented（定向门禁与真实 5+5 闭环通过；全量测试剩余 `.DS_Store` 环境漂移）
> 日期：2026-09-13
> 适用范围：带 Task-bound 图片的 Current 新任务、主动 Plan Revision，以及当前受影响任务
> 关联方案：`docs/plans/2026-09-12-clarification-task-material-development.md`

## 1. 问题摘要

Task Material 已能上传、封存并跨 Requirement Revision 保留，但 Verified Material Inventory 尚未在 Skill 选择前进入 Planner。结果是 Planner 可以生成完全不消费必需图片的候选，直到 Plan 确认时才由 Workflow fail closed。

真实任务：

```text
Task:       32bb0b3d-1b15-46de-8dea-c9e46ca195f7
State:      awaiting_confirmation
Active Plan:e1ce19ca-d613-4d19-84db-a99002801eff
Materials:  京东 5 张 + 竞品 5 张，全部 SEALED
```

当前 Active Plan：

```text
tavily-web-search
→ llm.generic
→ competitive-web-research
→ senior_research_reviewer

pending_inputs = []
```

因此确认时产生：

```text
workflow gates remain unresolved:
material:jdDesignImage,
material:competitorDesignImage
```

该拒绝是正确的。错误在 Planner 允许展示和选择未消费 Required Material 的候选。

## 2. 已确认的根因

1. `RequirementRefinementService` 已接收并验证 Task Material。
2. `ResearchPlanningService` 只在 Routed Planning 完成后把材料投影为 `providedMaterials`。
3. `RoutedPlanner` 的 Capability Resolution 和 Candidate Generation 看不到 Verified Material Inventory。
4. `competitive-app-analysis` 当前只声明 `competitor_screenshots`，不能表达“京东主方案组 + 竞品对照组”。
5. `ControlPlanningService` 只有 Design Audit 单图专项检查，没有通用 Required Material Coverage Gate。
6. `TaskWorkflow.confirm()` 最终发现两组材料未被任何 Pending Input 消费并正确阻断。

## 3. 修复目标

1. Verified Task Material 在 Capability Selection 前进入 Planner。
2. 京东与竞品截图对比成为可复用的双组多图输入合同。
3. 每个 Required Material Request 必须被候选 Plan 的视觉 Pending Input 消费。
4. 未消费 Required Material 的候选不得展示、选择或确认。
5. Plan 确认继续引用原 Task-bound Artifact ID 与 Hash，不复制图片字节。
6. 当前任务通过 Plan Revision 生成有效视觉计划，复用现有 10 张图片。

## 4. 非目标

本修复不做：

- 新数据库表、Migration、Task 状态或 Gate 版本；
- Material Role 别名表或通用规则引擎；
- 五实验室退役或 Native Visual Skill 迁移；
- Canonical、Review、双报告链重构；
- 历史任务批量回填；
- 放宽 Workflow 未消费材料校验；
- 修改或复制 SEALED 图片字节。

## 5. 不变量

### 5.1 Requirement Revision

Requirement Revision 可以增加，但现有 Material Request 的以下字段不可被后续 LLM 改写：

```text
id
kind
role
multiple
```

当前工作树已完成这一修复，并有 red-green 回归测试。

### 5.2 Planner Material Inventory

Planner 只接收服务端验证后的：

```text
VerifiedTaskMaterial[]
```

原始客户端 ID、未封存 Artifact 或跨 Owner／Task 材料不得进入 Planning。

### 5.3 Required Material 必须消费

对每个 `required=true` 且已提供的 Material Request：

```text
Candidate Plan
→ 必须存在同 role、同 kind、兼容 multiple 的 Pending Input
→ Pending Input 至少有一个真实 Skill／Tool Target
```

一个 Pending Input 可以绑定多个执行目标，但同一 Required Request 不能无人消费。

### 5.4 单／多 Skill 不变

```text
single_skill → CurrentExecutionPlan v2，恰好一个 Skill Invocation
multi_skill  → CurrentExecutionPlan v3，Portfolio 与唯一 Synthesizer
```

材料修复不得改变 Task 冻结模式，也不得跨模式 fallback。

## 6. 目标链路

```text
Requirement Material Requests
        ↓
Task-bound SEALED Artifacts
        ↓
Verified Task Material Inventory
        ↓
Capability Resolution（知道已提供哪些视觉角色）
        ↓
Candidate Generation（Required Material 是硬约束）
        ↓
Candidate Material Coverage Gate
        ↓
Plan Selection / Confirmation
        ↓
Plan-bound visual_input_gate（只引用 Artifact ID + Hash）
        ↓
visual-analysis-suite
        ↓
competitive-app-analysis
        ↓
Reviewer / competitive_analysis_report
```

## 7. 双组视觉输入合同

`competitive_research` 的京东与竞品设计稿对比使用当前已封存的任务级角色：

```text
jdDesignImage[]
competitorDesignImage[]
```

两者均为多图。它们是 Competitive Visual Task Material 的正式角色，不修改 Industry 已有：

```text
jd_screenshots[]
competitor_screenshots[]
```

`visual-analysis-suite` 同时支持两个业务合同，但输出继续统一为：

```text
primary samples
comparison samples
comparisonFindings
toolProvenance
```

不建设 Role alias 表；每个角色在对应 Skill／Tool Manifest 中显式声明。

## 8. 最小实现

### 8.1 Planning Context

将 `VerifiedTaskMaterial[]` 从 `ResearchPlanningService` 传入 `RoutedPlanner`。

Planner 派生：

```text
providedMaterialRoles
providedMaterialCounts
requiredMaterialRoles
```

材料角色不塞入普通 `available_input_roles`，避免 Compiler 错误删除创建 Plan Gate 所需的 Pending Input。

### 8.2 Capability Resolution

`CapabilityResolveInput` 增加内部只读的 `provided_material_roles`。

对于 Skill 已声明的 visual input：

- Required visual role 继续生成 Pending Input；
- 已提供的 Optional visual role也生成 Pending Input，以便 Plan Gate 继承材料；
- 其他 Skill 不因无关材料被错误选中。

### 8.3 Competitive Visual Skill

调整 `competitive-app-analysis`：

```text
visual_inputs:
  - jdDesignImage
  - competitorDesignImage

multiple_visual_inputs:
  - jdDesignImage
  - competitorDesignImage

required input:
  - competitorDesignImage

optional input:
  - jdDesignImage

required tools:
  - tavily-web-search
  - visual-analysis-suite
```

用户提供京东组时必须消费；只有竞品组时仍可完成竞品截图分析。

### 8.4 Visual Analysis Suite

为 Suite 增加正式输入字段：

```text
jdDesignImage[]          → primary
competitorDesignImage[]  → comparison
```

现有 Industry 字段保持不变。两套字段不得在同一调用中重复表达同一组图片；发现冲突时 fail closed。

### 8.5 Candidate 生成与门禁

Candidate Prompt 接收 Verified Material Inventory，并明确：

```text
每个候选都必须选择能消费全部 Required Material role 的 Skill。
```

机器门禁在候选持久化前检查：

- Required Request 是否有同 role Pending Input；
- kind 是否为 visual；
- multiple 是否兼容；
- Pending Input 是否有真实 Target；
- Provided Material 数量是否完整。

门禁失败进入现有一次 Candidate Repair，不进入 UI。

## 9. 当前任务恢复

当前三个候选均为 Web-only，应全部视为不可用，不修改其历史内容。

修复完成后通过现有 Plan Revision：

```text
revision instruction:
使用已封存的 5 张京东截图和 5 张竞品截图完成视觉对比；
每组材料必须进入 visual-analysis-suite 和 competitive-app-analysis。
```

新 Plan 必须：

```text
包含 jdDesignImage 与 competitorDesignImage 两个 visual Pending Input
两者 multiple=true
引用现有 10 个 Task-bound Artifact
包含 visual-analysis-suite
包含 competitive-app-analysis
保持 single_skill
```

旧 Active Plan 由新 Plan Version supersede，不删除。

## 10. 验证

### 10.1 自动验证

1. 非 Design Audit 的 Material Request 跨 Requirement v1/v2/v3 保持不变。
2. Capability Resolution 能看到已验证视觉角色，但仍生成 Plan Gate Pending Input。
3. Candidate 缺任一 Required Material consumer 时被拒绝并进入一次修复。
4. `competitive-app-analysis` 生成双组多图 Pending Input。
5. Suite 将京东组标为 primary、竞品组标为 comparison。
6. Workflow 确认后生成两个 Plan-bound Visual Gate，引用原 Artifact，不复制图片。
7. 单 Skill Plan 仍恰好一个 Skill Invocation。

命令：

```bash
pnpm typecheck
pnpm lint:registry
pnpm exec tsx --test tests/requirement-refinement-service.test.ts
pnpm exec tsx --test tests/capability-resolver.test.ts
pnpm exec tsx --test tests/multi-skill-routed-planning.test.ts tests/plan-compiler.test.ts
pnpm exec tsx --test tests/control-planning-service.test.ts tests/task-workflow.test.ts
pnpm exec tsx --test tests/tool-adapter.test.ts tests/visual-input-gate-store.test.ts
pnpm build:web
git diff --check
```

### 10.2 当前任务验收

```text
Task 保留同一 ID
新 Plan Version 被选中
10 个 Task Material 全部解析
确认 Gate 不再出现 material:* unresolved
Execution 的 Visual Suite samples = 10
primary = 5
comparison = 5
报告明确区分截图观察、工具分析、设计推断和数据缺口
```

若视觉实验室未全部在线，允许 Suite 返回 `partial` 并形成显式 Gap；不得伪造缺失维度。

## 11. 失败与回滚

- 候选无法覆盖 Required Material：停在 Planning，不展示候选。
- Plan Revision 失败：保留当前 Task、旧 Plan 和 10 个 Artifact，不修改外部状态。
- Tool 不可用：按现有 optional／gap 语义处理，不改变编排模式。
- 代码回滚：回退本修复提交；新增 Plan Version 和历史 Artifact 保持只读。

## 13. 实施结果

已完成：

- Material Request 的 `id/kind/role/multiple` 在所有 Task Type 的后续 Requirement Revision 中保持冻结；
- Verified Task Material role 在 Capability Selection 前进入 Planner；
- 已提供的可选视觉角色仍保留为 Plan-bound Pending Input，不会因“已存在”而被误删；
- Candidate 缺少任一已提供材料的消费 Skill 时进入现有一次修复，持续不满足则 fail closed；
- Planner 在模型漏写图片占位字段时确定性补齐 Skill／Tool 输入槽；
- `competitive-app-analysis` 统一通过 `visual-analysis-suite` 消费 `jdDesignImage[]` 与 `competitorDesignImage[]`；
- 缺材料由 Input Gate 负责，不再被误转成 Owner Approval；
- Workflow 未消费材料检查保持严格，未放宽。

当前任务真实结果：

```text
Task:       32bb0b3d-1b15-46de-8dea-c9e46ca195f7
Plan:       c873a8f7-1864-4e8c-8339-ba17283f79f2
Attempt:    2d967208-3b2a-4fe2-af24-f1037dcbd862
State:      completed
Gap Count:  0
Samples:    10（primary 5 / comparison 5）
```

真实 Tool provenance：

```text
aesthetic-quant-lab     real / available
attention-analysis-lab  real / available
vision-brand-lab        real / available
```

两个 Plan-bound Visual Gate 均引用原 Task Material：

```text
jdDesignImage          5 个 Artifact
competitorDesignImage  5 个 Artifact
```

验证结果：

```text
Requirement Refinement                         38/38 pass
Planner / Compiler / Material / Workflow 定向   192/192 pass
TypeScript                                      pass
Registry lint                                   pass
Web build                                       pass
Git diff check                                  pass
```

全量测试运行 2364 项，2347 pass、15 skip、2 fail。`gold CLI` 单独复跑通过；剩余失败来自 Knowledge source tree 中已有 `.DS_Store` 导致 snapshot hash/file-count 漂移，与本修复路径无关。
