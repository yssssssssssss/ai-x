# 单 Skill 与多 Skill 双引擎并行开发方案

> 状态：实现与验证完成，等待代码评审、提交、合并和部署授权
> 日期：2026-08-30
> 目标基线：`origin/main@dbe2e474e976b144756d2a7f637227634767b4b0`
> 单 Skill 基线：当前工作区 `b8b4aa9` 加未提交的 Editorial Showcase 改动
> 多 Skill 基线：PR #42，集成提交 `2e5ed40ce0d3898f47aee447957b3860e89c4bc4`
> Main CI：Run `33319556566` 已通过

## 实施结果

双引擎代码已在独立 worktree `/Users/heyunshen/work/PROJECT/jdc/ai-x-dual-orchestration` 的 `feat/dual-orchestration-mode` 分支完成，尚未提交或合并。

已完成：

- Task 级 `single_skill`／`multi_skill` 契约、持久化和不可变传递。
- 单 Skill Plan v2 与多 Skill Plan v3 的显式分派。
- Composer 模式选择、Plan 和 Report 模式展示。
- 单 Skill Showcase 独立契约、Schema、Profile、Compiler、Renderer、Validator、Store、CLI 和 Owner-only 下载路径。
- 多 Skill Contribution、Ledger 和 Report Package v1 固定根读取修复。
- 结构修复 Schema 的缺失 Artifact 约束和非事实 Evidence 保守降级。

真实验证：

- 单 Skill：Task `e16880e3-21c2-4541-9e38-fc750185ee4b` 生成 `model_intent / ready` Showcase，17 个组件、207 个 Unit、3 张表格，网络请求为 0。
- 多 Skill：Task `355d42d2-8f45-4f9d-9366-715ed9e5c7ad` 以 Plan v3 和 `multi_skill` 模式完成，真实 Tavily 与 virtual-user Tool 成功，Cross-Skill Review、Contribution Ledger、Contribution Summary、Deliverable、Review 和 Report Package 全部 SEALED。
- 前台：1440×900 下两种模式均可选择，页面无横向溢出。
- 用户已明确取消 375×812 浏览器验收，本期不再执行移动端检查。

最终门禁：

```text
总测试：2242
通过：2224
跳过：18
失败：0
TypeScript：通过
Web Production Build：通过
git diff --check：通过
```

## 1. 文档目的

本文定义单 Skill 与多 Skill 两套完整能力如何同时进入一个可部署产品，并由用户在创建任务前自主选择。

这里的“进入同一个主分支”只表示两套代码会同时出现在运行中的产品里，不表示把两套能力合并成一套实现。Git 分支不是运行时开关。要让同一个前台为不同任务选择不同能力，两套引擎必须同时存在于部署产物中。

本方案保留两套独立闭环：

```text
单 Skill：需求 → 规划 → 确认 → 执行 → Review → Canonical → 报告
多 Skill：需求 → Portfolio → 确认 → 协作执行 → Review/Ledger → Canonical → 报告
```

两套引擎共享登录、Task、数据库连接、LLM、Tool、Artifact 和 Web Shell 等平台基础设施，但不共享 Planner 决策、Plan Writer、Canonical 真相源或报告编译逻辑。

当前 Editorial Showcase 报告形式已经获得用户确认。原任务以“单 Skill 报告形式和技术纵切片验收完成”收尾。双引擎并行接入和前台模式选择作为新的开发任务实施。

## 2. Design-size checkpoint

### 2.1 不可削减范围

以下内容来自用户明确要求，不属于过度设计：

1. 单 Skill 与多 Skill 两套完整能力同时保留。
2. 两套能力可以独立规划、执行和生成报告。
3. 用户在前台创建任务前自主选择模式。
4. Task 创建后模式固定，不能在执行中途改变。
5. 一套能力失败时不能静默切换到另一套。
6. 关闭多 Skill 后，单 Skill 仍然完整可用。
7. 同一需求可以分别创建两个任务进行对比。

### 2.2 本次采用的最小实现

只增加完成上述要求所必需的内容：

- 在现有共享契约中增加一个模式类型，不新增独立模式 Schema。
- 在创建任务请求中增加一个模式字段。
- 在 `control_tasks` 增加一个字段，不新增模式表或配置中心。
- 在现有 Planning Service 中增加一次明确分支，不建设新的编排框架。
- 保留现有 `MULTI_SKILL_PORTFOLIO_WRITER_ENABLED`，不再增加多 Skill 配置。
- 完整迁入当前单 Skill Showcase，并使用独立命名空间避免覆盖主线实现。
- 在现有 Composer 中增加一个二选一控件，不新增设置页。
- 使用现有 System Capabilities Boolean 控制多 Skill 选项是否可用。
- 使用现有报告和下载入口，不新增第二套 HTTP 路由体系。

### 2.3 本次删除或推迟的设计

以下内容不进入本次实现：

- 不为历史 Task 推断或回填模式。
- 不增加旧客户端兼容 fallback，新前台必须显式提交模式。
- 不新增五个模式专属错误码枚举。
- 不新增模式别名表或规则引擎。
- 不增加 `SINGLE_SKILL_EDITORIAL_SHOWCASE_V1_ENABLED`。
- 不增加模式偏好数据库表或用户设置页。
- 不记住用户上一次模式选择，刷新后默认单 Skill。
- 不为模式新增一套指标平台。
- 不增加自动依赖扫描器。
- 不把两套引擎拆成两个服务或两套数据库。
- 不移动远端主线现有多 Skill 目录来追求结构对称。
- 不建设通用 `OrchestrationEngine` 插件框架。
- 不增加自动对比两种报告的评测系统。

这些项目如果后续出现真实需求，再单独评审，不提前实现。

## 3. 已确认基线

### 3.1 多 Skill 主线

多 Skill 能力已经进入远端 `main`：

- PR #42 已合并。
- `main` 合并提交为 `dbe2e474e976b144756d2a7f637227634767b4b0`。
- 集成分支最终提交为 `2e5ed40ce0d3898f47aee447957b3860e89c4bc4`。
- `多skill版-260830` 标签快照已包含在 `main` 历史中。
- Main CI Run `33319556566` 全部通过。

主线已经包含：

- Capability Demand Graph。
- Portfolio Resolver。
- CurrentExecutionPlan v3。
- Contributor、Synthesizer、Reviewer 和 Contribution Ledger。
- 多 Skill 执行与报告。
- `report-package-v2` 和 `report-package-v3`。
- Report Editorial Pipeline。
- `MultiSkillPlanSummary` 和 Skill Contribution View。

多 Skill Writer 默认仍关闭：

```env
MULTI_SKILL_PORTFOLIO_WRITER_ENABLED=false
```

该变量是服务端发布闸门，不是用户偏好。

### 3.2 单 Skill 当前工作区

当前工作区位于本地 `main@b8b4aa9`：

```text
local main:  b8b4aa9
origin/main: dbe2e47
ahead:       6
behind:      78
```

工作区包含未提交的 Editorial Showcase 改动，已经完成：

- Structured Showcase Intent。
- Deterministic Compiler。
- Deterministic Renderer。
- Static Validator。
- Immutable Showcase Store。
- task-id manual CLI。
- Model Intent 和 deterministic fallback。
- Golden Contract。
- 跨案例通用性测试。
- 1440×900 离线验证。

正式校准结果：

```text
状态：ready
生成模式：model_intent
章节：7
组件：17
Unit：207
表格：3
外部网络请求：0
横向溢出：0
```

完整质量结果：

```text
总测试：1799
通过：1786
跳过：13
失败：0
```

## 4. 目标与非目标

### 4.1 目标

- 用户在创建新任务前选择单 Skill 或多 Skill。
- 新 Task 保存用户选择。
- 单 Skill 写入 CurrentExecutionPlan v2。
- 多 Skill 写入 CurrentExecutionPlan v3。
- 两种模式各自完成执行、Review、Canonical 和报告。
- 两种模式的 Artifact、Publication 和缓存不互相覆盖。
- 前台可以查看当前任务使用的模式。
- 多 Skill 不可用时明确拒绝，不降级。

### 4.2 非目标

- 在进行中的 Task 上切换模式。
- 将单 Skill Planner、Canonical 或报告吸收到多 Skill Pipeline。
- 只保留单 Skill Showcase 的部分代码而丢失完整闭环。
- 让多 Skill 调用单 Skill 结果作为兜底。
- 让单 Skill 调用 Contributor、Ledger 或 Synthesizer。
- 两套独立部署、数据库或用户系统。
- 历史数据模式回填。
- 移动端报告、A4 报告或自动视觉评分。
- 模型决定编排模式。

## 5. 术语和模式语义

### 5.1 编排模式

共享类型定义在现有契约文件中：

```ts
export type OrchestrationModeV1 = 'single_skill' | 'multi_skill';
```

不为两个字符串新增独立 Schema 文件。

### 5.2 单 Skill 模式

单 Skill 模式使用当前已经验收的能力：

```text
Single Skill Planner
→ CurrentExecutionPlan v2
→ Single Skill Execution
→ Single Skill Review/Canonical
→ Standard Report
→ Editorial Showcase Sidecar
```

用户既可以让现有路由选择一个 Skill，也可以使用 `$skill-id` 指定 Skill。

### 5.3 多 Skill 模式

多 Skill 模式使用远端主线能力：

```text
Capability Demand Graph
→ Portfolio Resolver
→ CurrentExecutionPlan v3
→ Contributor Skills
→ Synthesizer
→ Cross-Skill Reviewer
→ Contribution Ledger
→ Canonical Deliverable
→ Multi Skill Report
```

`multi_skill` 表示使用 Portfolio 引擎，不承诺最终 Skill 数量一定大于一。实际数量由需求、输入、能力资格和预算决定。

### 5.4 独立运行

完整独立的含义是：

| 能力 | 单 Skill | 多 Skill |
|---|---|---|
| Planner | 单 Skill 路径 | Portfolio 路径 |
| Plan Writer | v2 | v3 |
| Skill 编排 | 单一 Invocation | 1～N 个 Invocation |
| 中间产物 | 单 Skill Artifact | Contribution Bundle 和 Ledger |
| Canonical | 单 Skill Deliverable | Synthesized Deliverable |
| 报告 | 当前已验收 Showcase | 主线 Multi Skill Report |
| 失败处理 | 模式内处理 | 模式内处理 |
| 测试 | 独立回归 | 独立回归 |

共享平台代码不破坏独立性。两套引擎可以共同使用 Auth、Task Store、Lease、LLM、Tool、Artifact Store 和 Web Shell，但不能直接 import 对方的内部业务模块。

## 6. 最小架构

```text
┌──────────────────────────────────────────────┐
│ Web Composer                                 │
│ [单 Skill] [多 Skill 协作]                   │
└──────────────────────┬───────────────────────┘
                       │ orchestrationMode
                       ▼
┌──────────────────────────────────────────────┐
│ Control Planning Service                     │
│ 校验一次模式和服务端可用性                   │
└──────────────┬────────────────┬──────────────┘
               │                │
               ▼                ▼
┌──────────────────────┐  ┌──────────────────────┐
│ Single Skill Path    │  │ Multi Skill Path     │
│ Plan v2              │  │ Plan v3              │
│ Single Canonical     │  │ Contribution/Ledger  │
│ Single Showcase      │  │ Multi Skill Report   │
└──────────────┬───────┘  └──────────────┬───────┘
               │                         │
               └────────────┬────────────┘
                            ▼
┌──────────────────────────────────────────────┐
│ Shared Task, Artifact, Auth and Web Shell    │
└──────────────────────────────────────────────┘
```

不新增通用引擎注册表或插件系统。现有 Planning Service 和 Report Composition Service 各增加一个清晰的模式分支即可。

依赖规则：

```text
Single Skill Path → Shared Platform
Multi Skill Path  → Shared Platform
Single Skill Path ↛ Multi Skill Path
Multi Skill Path  ↛ Single Skill Path
```

## 7. 任务模式契约

### 7.1 创建请求

扩展现有 `PlanControlTaskRequest`：

```ts
export interface PlanControlTaskRequest {
  originalInput: string;
  conversationId?: string;
  orchestrationMode: OrchestrationModeV1;
}
```

新字段为必填，不增加旧客户端 fallback。当前 Web 与 API 在同一版本发布。

### 7.2 Task 响应

新 Task 的响应增加：

```ts
orchestrationMode: OrchestrationModeV1;
```

前台恢复新 Task 时只读取服务端值，不读取当前选择器状态。

历史 Task 没有该字段时继续使用原有读取路径，本次不推断、不回填，也不在历史列表补造模式。

### 7.3 数据库存储

新增一个必要字段：

```text
control_tasks.orchestration_mode
```

迁移只增加 nullable 文本列，不回填历史数据。Repository 创建新 Task 时必须写入两个合法值之一。模式值只在 HTTP 创建任务边界校验一次，内部服务使用共享 TypeScript 类型，不再重复建立别名表或规则引擎。

### 7.4 不可变规则

- 模式只在创建新 Task 时提交。
- Clarification 不接收模式字段。
- Revision 不接收模式字段。
- Retry 和 Resume 从 Task 读取模式。
- 用户想切换模式时创建新 Task。
- 同一 Task 的所有 Plan Version 使用同一模式。

### 7.5 Plan Contract 对应关系

新 Task 必须满足：

```text
single_skill → current-execution-plan-v2
multi_skill  → current-execution-plan-v3
```

Control Planning Service 在 Plan 编译完成、持久化之前检查一次对应关系。执行和报告层读取已经封存的 Task 与 Plan，不重复实现同一检查。

## 8. 服务端可用性

继续使用现有：

```env
MULTI_SKILL_PORTFOLIO_WRITER_ENABLED=false
```

规则：

| 用户选择 | Writer | 结果 |
|---|---|---|
| `single_skill` | `false` 或 `true` | 允许 |
| `multi_skill` | `true` | 允许 |
| `multi_skill` | `false` | HTTP 409，不降级 |

不新增单 Skill Writer 开关。单 Skill 是稳定基础路径。

前台继续读取现有 `multiSkillPlanWriterEnabled`。本次不扩展新的 System Capabilities 结构。

## 9. `$skill` 规则

`$skill-id` 属于单 Skill 模式内的显式选择。

- 用户在 Composer 选择 `$skill-id` 时，前台同步选中单 Skill。
- 多 Skill 模式下不打开 `$skill` 菜单。
- API 收到 `multi_skill` 和 `$skill-id` 组合时返回 HTTP 422。
- 不新增专属错误码枚举，现有错误响应返回清楚的人类可读信息。
- 不采用“某一字段优先”的隐式规则。

## 10. 规划和执行

### 10.1 单 Skill 路径

在现有 `ResearchPlanningService` 和 `RoutedPlanner` 中保留旧路径：

- 不构造 Capability Demand Graph。
- 不调用 Portfolio Resolver。
- 使用现有 Capability Resolver 选择一个 Skill。
- 使用 CurrentExecutionPlan v2 Compiler。
- 保留 speed、depth 等方案卡片。
- 保留 `$skill-id` direct path。

单 Skill 的新计划必须只有一个 Skill Invocation。

### 10.2 多 Skill 路径

保留远端主线现有路径：

- 构造 Capability Demand Graph。
- 调用 Portfolio Resolver。
- 使用 CurrentExecutionPlan v3 Compiler。
- 保留 Contributor、Synthesizer、Reviewer 和 Ledger。
- Required Demand 不得被静默裁剪。

### 10.3 分派方式

不新增新的 Mode Router 类。模式作为现有 Planning Service 的一个输入，在当前 Portfolio 分支位置决定：

```text
single_skill → 原 v2 编译路径
multi_skill  → 现有 v3 Portfolio 路径
```

`MULTI_SKILL_PORTFOLIO_WRITER_ENABLED` 只检查多 Skill 是否可用，不再替用户选择模式。

### 10.4 Clarification、Retry 和 Resume

- Task 首次进入 Clarification 前保存模式。
- Clarification 完成后使用 Task 模式继续规划。
- Retry 和 Resume 使用已封存 Plan，不重新选择模式。
- 一套模式失败时不得生成另一种 Plan。

## 11. 两套完整报告能力

### 11.1 单 Skill 报告

当前已验收路径完整保留：

```text
Reviewed report-package-v1
→ Editorial Material
→ Source Adapter
→ Structured Showcase Intent
→ Deterministic Compiler
→ Deterministic Renderer
→ Static Validator
→ Immutable Showcase Store
```

必须保留：

- 标准单 Skill 报告。
- Structured Intent 一次调用。
- deterministic fallback。
- Store 原子发布和重建校验。
- task-id manual CLI。
- Golden Contract。
- Generality 测试。
- 现有 1440×900 展示形式。

LLM Full HTML 保留为 manual 历史实验路径，不作为前台默认报告。

### 11.2 多 Skill 报告

远端主线能力保持不变：

```text
Reviewed Canonical Deliverable
→ report-package-v2/v3
→ Report Editorial Material
→ Report Editorial Planner
→ Report Editorial Compiler
→ Report Editorial Showcase Publication
```

Contribution、Ledger、Cross-Skill Review 和 Canonical Deliverable 仍是唯一正式来源。

### 11.3 命名隔离

当前分支和远端主线存在同名 Schema。单 Skill 能力进入主线时使用独立命名，不能覆盖主线文件：

```text
packages/api-contract/single-skill-editorial-showcase.ts
schemas/single-skill-editorial-showcase-*.schema.json
apps/orchestrator-runtime/src/report/single-skill-showcase/
orchestrator/report-presentations/single-skill-editorial-showcase-v1.yaml
```

单 Skill 目录至少保留：

```text
source-adapter.ts
planner.ts
compiler.ts
renderer.ts
validator.ts
store.ts
pipeline.ts
profile.ts
```

主线现有 `report-editorial-*` 模块保持原样。两套报告模块不得直接引用对方内部实现。

### 11.4 报告分派

复用现有 Owner-only 报告入口。完成 ownership 校验后，根据 Task 模式读取对应报告：

```text
single_skill → Single Skill Showcase Store
multi_skill  → Main Editorial Publication Reader
```

不增加第二套公开路由。响应只需返回现有报告信息和 Task 模式。

两套报告使用各自已有的 Manifest、Store 和版本标识。Task ID、Plan Version ID 和 Attempt ID 已提供隔离，本次不增加新的模式 hash 体系。

### 11.5 单 Skill 不支持 Showcase 时

如果单 Skill Source Adapter 不支持某类交付物：

- 返回同一模式的标准报告。
- 不进入多 Skill 报告路径。
- 不根据业务关键词临时构造 Adapter。

## 12. 前台模式开关

### 12.1 位置

在现有 Composer 输入区上方增加分段单选：

```text
运行模式

[ 单 Skill ] [ 多 Skill 协作 ]
```

不新增设置页、弹窗或模式管理页面。

### 12.2 文案

单 Skill：

```text
使用一个专业能力完成任务，调用更少，适合目标明确的需求。
```

多 Skill 协作：

```text
多个专业能力分工并统一合成，适合综合研究，耗时和资源更高。
```

### 12.3 状态

- 初始默认单 Skill。
- 不使用 `localStorage` 记住选择。
- 每次新任务都从单 Skill 开始。
- 发送期间禁用控件。
- 打开已有新 Task 时显示只读模式。
- 新建任务后恢复可编辑状态。
- Multi-Skill Writer 关闭时禁用多 Skill 选项并显示原因。

### 12.4 展示范围

第一版只在三个位置显示模式：

1. Composer 创建任务前。
2. Plan 确认页。
3. Report 页。

不修改 Sidebar 和全部历史列表。历史展示增强放入后续需求。

### 12.5 可访问性

- 使用 `radiogroup` 和 `radio` 语义。
- 支持 Tab、方向键和 Space。
- 选中状态不只依赖颜色。
- 禁用状态包含文字原因。
- 1440×900 无横向溢出。
- 移动端视口不属于本期验收范围。

## 13. 安全和一致性

- 模式只来自用户请求或 Task 记录。
- LLM 不能选择或修改模式。
- 模式不由 Skill 数量反推。
- API 在创建任务入口验证一次。
- Task 创建后模式不可变。
- Owner-only 报告权限保持不变。
- 两套模式没有跨模式 fallback。
- 单 Skill Evidence 和 Unit Ownership 保持现有规则。
- 多 Skill Contribution 和 Ledger 保持 ADR-0007 规则。
- 两套 HTML 均保持无 JavaScript、无远程资源和无运行时网络请求。

## 14. 分支集成策略

### 14.1 先固化当前单 Skill 分支

当前本地 `main` 落后远端 78 个提交，且有大量未提交文件。不能在当前工作区直接 `pull` 或 merge。

实施前：

1. 将当前工作区转为单 Skill 收尾分支。
2. 保留全部未提交改动。
3. 运行现有测试和 `pnpm quality`。
4. 经授权后提交单 Skill 能力。
5. 不在该工作区同步远端主线。

### 14.2 从远端主线建立集成分支

从以下提交创建干净 worktree：

```text
origin/main@dbe2e474e976b144756d2a7f637227634767b4b0
```

集成目标是完整迁入单 Skill 行为，同时保持多 Skill 主线实现不变。

Git 层面按模块迁入，不整体 merge 当前分支。原因是两边同时修改了 Report Contract、Schema Registry、Editorial Pipeline、Web 和测试入口。按模块迁入是冲突处理方式，不是功能裁剪。

### 14.3 完整性清单

迁入完成后逐项验证：

| 单 Skill 能力 | 要求 |
|---|---|
| 自动选择一个 Skill | 保留 |
| `$skill-id` 直呼 | 保留 |
| Plan v2 | 保留 |
| 执行、重试和恢复 | 保留 |
| Review 和 Canonical | 保留 |
| 标准报告 | 保留 |
| Structured Showcase Intent | 保留 |
| deterministic Showcase | 保留 |
| Immutable Store | 保留 |
| manual CLI | 保留 |
| Golden 和 Generality 测试 | 保留 |

主线 Multi Skill Planner、Plan v3、Contribution、Ledger、Reviewer 和报告能力不因接入发生行为变化。

### 14.4 ADR

远端主线已有 ADR-0003 至 ADR-0008。当前工作区的本地 ADR 编号与主线冲突，不能原样复制。

新增一份 ADR：

```text
docs/adr/0009-adopt-task-scoped-dual-orchestration-modes.md
```

ADR 只记录四个稳定决策：

- 两套完整引擎同时存在。
- 模式按 Task 选择并冻结。
- 两套引擎不互相 fallback。
- 环境变量只控制模式可用性。

## 15. 最小修改范围

完整单 Skill 引擎本身包含多个现有文件，无法压缩为五个文件以内。新增平台设计保持最小。

### 15.1 必须修改

共享契约：

- `packages/api-contract/control-workflow.ts`

数据库：

- 新增一个 migration 文件。
- `database/control-plane.ts`

API 和规划：

- `apps/agent-api/src/routes/control-planning.ts`
- `apps/agent-api/src/control-runtime.ts`
- `apps/orchestrator-runtime/src/control/control-planning-service.ts`
- `apps/orchestrator-runtime/src/planners/plan-strategy.ts`
- `apps/orchestrator-runtime/src/planners/research-planning-service.ts`
- `apps/orchestrator-runtime/src/planners/routed-planner.ts`
- `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts`

报告：

- 单 Skill Showcase 独立目录。
- `apps/orchestrator-runtime/src/report/report-composition-service.ts`
- `apps/orchestrator-runtime/src/report/current-report-package-reader.ts`

Web：

- `apps/web/src/components/Composer.tsx`
- `apps/web/src/hooks/useTaskFlow.ts`
- `apps/web/src/components/stages/Stage2Plan.tsx`
- `apps/web/src/components/stages/CurrentStage4Report.tsx`

### 15.2 不新增

- 模式配置文件。
- 模式注册表。
- 用户偏好表。
- 新的公开报告路由。
- 新的服务或队列。
- 新的运行时插件框架。
- 新的模式错误码枚举。
- 历史数据修复脚本。

## 16. 实施阶段

每个阶段都必须可以独立合并，后续阶段不完成时，已经完成的阶段仍保持可用。

### Phase 1：固化单 Skill 基线

- 将当前工作区转为独立分支。
- 记录正式 Showcase 的 Task、Attempt、Publication 和 hash。
- 运行现有定向测试和 `pnpm quality`。
- 经授权后提交。

完成条件：单 Skill 当前能力可以从提交完整恢复。

### Phase 2：增加任务模式

- 在现有契约中增加模式类型和请求字段。
- 增加 `control_tasks.orchestration_mode` nullable 字段。
- 新 Task 必须写入模式。
- Task 响应返回模式。
- 历史 Task 保持原样，不回填。

完成条件：新 Task 的模式可持久化、读取且不可修改。

### Phase 3：双路径规划和执行

- 将模式传入现有 Planning Service。
- 单 Skill 进入 v2 路径。
- 多 Skill 进入 v3 Portfolio 路径。
- 保留现有 Multi-Skill Writer 闸门。
- Clarification、Retry 和 Resume 继承 Task 模式。

完成条件：同一输入可以分别生成 v2 和 v3 Plan，且不会跨模式降级。

### Phase 4：完整迁入单 Skill 报告能力

- 将当前单 Skill Showcase 模块放入独立命名空间。
- 保留 Planner、Compiler、Renderer、Validator、Store、Pipeline 和 Profile。
- 保留标准报告、deterministic fallback、manual CLI 和现有测试。
- 在现有报告服务中按 Task 模式选择 Reader 和 Publisher。
- 不修改多 Skill 报告内部逻辑。

完成条件：单 Skill 完整性清单全部通过，多 Skill 报告回归不变。

### Phase 5：增加前台选择

- Composer 增加单选控件。
- 创建请求提交模式。
- `$skill` 与单 Skill 状态联动。
- Plan 和 Report 页面显示模式。
- 多 Skill 不可用时禁用选项。

完成条件：用户可以创建两种新任务，任务创建后不能改变模式。

### Phase 6：真实验收和启用

- 使用同一真实需求分别运行两种模式。
- 使用真实 Gateway、真实 Tavily 和正式 Artifact Store。
- 验证报告查看和下载。
- 运行完整质量门禁和 Web Production Build。
- 经授权后启用 Multi-Skill Writer。

完成条件：两套引擎分别完成真实闭环，关闭任一模式不会破坏另一模式。

## 17. 测试矩阵

### 17.1 核心自动化测试

新增三个聚合测试文件：

```text
tests/dual-orchestration-mode.test.ts
tests/single-skill-showcase-integration.test.ts
tests/orchestration-mode-ui.test.ts
```

不为每条不变量建立一个新测试文件。

### 17.2 关键场景

| 场景 | 预期 |
|---|---|
| 单 Skill 创建 | Plan v2，一个 Skill Invocation |
| 多 Skill 创建 | Plan v3，Portfolio 合同完整 |
| 多 Skill Writer 关闭 | HTTP 409，不生成单 Skill Plan |
| 单 Skill 加 `$skill-id` | 指定 Skill 正常运行 |
| 多 Skill 加 `$skill-id` | HTTP 422 |
| Clarification | 保持创建时模式 |
| Retry/Resume | 使用原 Task 模式 |
| 单 Skill 报告 | 当前 Showcase 形式和完整内容 |
| 多 Skill 报告 | Contribution 和 Ledger 保真 |
| 单 Skill Showcase Intent 失败 | deterministic Showcase，不切换模式 |
| 打开历史 Task | 原读取路径不变，不补造模式 |
| 所有权错误 | 两种报告都拒绝访问 |
| 1440×900 | 无横向溢出 |

### 17.3 独立性验证

- Single Skill 模块不引用 Portfolio、Contribution 或 Ledger 内部模块。
- Multi Skill 模块不引用 Single Skill Showcase 内部模块。
- 关闭 Multi-Skill Writer 后，单 Skill 真实任务仍成功。
- 人为让单 Skill Showcase 失败时，多 Skill 任务不受影响。
- 人为让 Multi Skill Contributor 失败时，单 Skill 任务不受影响。

依赖关系先通过代码评审和少量静态断言验证，不新增通用依赖规则引擎。

### 17.4 回归测试

继续运行现有：

```text
tests/editorial-showcase-*.test.ts
tests/multi-skill-*.test.ts
tests/control-planning*.test.ts
tests/task-workflow.test.ts
tests/report-editorial-*.test.ts
tests/report-package*.test.ts
```

### 17.5 最终验证

```bash
pnpm quality
pnpm --filter web build
git diff --check
```

真实验收至少创建两个新 Task：

```text
同一研究需求 + single_skill
同一研究需求 + multi_skill
```

两次运行都必须使用真实 LLM 和所需真实 Tool，不使用 fixture 代替真实闭环。

## 18. 发布与回滚

### 18.1 发布顺序

1. 发布数据库 nullable 字段和后端模式读取。
2. 发布双路径规划和报告分派，Multi-Skill Writer 仍关闭。
3. 发布前台模式控件，多 Skill 显示不可用。
4. 在受控环境命令级开启 Multi-Skill Writer。
5. 完成双模式真实 E2E。
6. 经授权后在目标环境开启 Multi-Skill Writer。
7. 核对 Source Revision、Build ID 和 System Capabilities。

### 18.2 多 Skill 回滚

```env
MULTI_SKILL_PORTFOLIO_WRITER_ENABLED=false
```

只停止创建新的多 Skill Task。单 Skill 不受影响，已经创建的 Plan v3 仍按现有 Reader 和 Executor 处理。

### 18.3 前台回滚

前台控件出现问题时，隐藏控件并恢复显式提交 `single_skill`。数据库字段和两套引擎保留，不回滚任务数据。

## 19. 风险

| 风险 | 最小应对 |
|---|---|
| 当前分支落后远端主线且工作区未提交 | 先固化单 Skill 分支，再从远端主线建立干净 worktree |
| Git 冲突误删单 Skill 功能 | 用完整性清单和基线测试逐项核对 |
| 同名 Schema 覆盖主线 | 单 Skill Schema 和模块使用独立命名 |
| 两套引擎产生内部依赖 | 只允许共同依赖 Shared Platform，代码评审检查 import |
| 模式与 Plan 不一致 | 在 Plan 持久化前检查一次 |
| 多 Skill 关闭时静默降级 | 返回 HTTP 409 |
| 用户中途切换模式 | Task 创建后前台只读，服务端不接受修改 |
| 单 Skill 报告不支持某种 Deliverable | 返回同模式标准报告，不切换多 Skill |
| 多 Skill 调用成本高 | Plan 确认页继续展示步骤、Skill 和 gap |

## 20. 预计工期

Checkpoint 后不再实施历史回填、模式注册表、额外配置、错误码体系和指标平台。保留两套完整引擎的预计工期为：

| 阶段 | 预计时间 |
|---|---:|
| 固化单 Skill 基线 | 0.5 至 1 天 |
| 模式契约和持久化 | 0.5 至 1 天 |
| 双路径规划和执行 | 1.5 至 2 天 |
| 完整单 Skill 报告迁入 | 2.5 至 3.5 天 |
| 前台模式选择 | 1 至 1.5 天 |
| 回归、真实 E2E 和启用 | 2 至 3 天 |
| 合计 | 8 至 12 个工作日 |

真实 Gateway、Tavily、Virtual User Tool 或评审环境不可用造成的等待时间不计入开发工时。

## 21. 最脆弱前提

当前单 Skill Showcase 依赖的 Material、Source Packet 和 Report Package 接口与远端主线已经发生变化。

如果无法直接编译，不允许改用多 Skill 内部模块代替。只在单 Skill 入口增加最小 Adapter，使当前已验收行为能够在新主线上运行。Adapter 不改变 Canonical、Evidence、Unit Ownership 或报告内容。

## 22. Definition of Done

### 22.1 双引擎

- 单 Skill 和多 Skill 都存在于同一部署版本。
- 两套引擎分别完成规划、执行、Review、Canonical 和报告闭环。
- 单 Skill 使用 Plan v2。
- 多 Skill 使用 Plan v3。
- 两套引擎不直接引用对方内部模块。
- 两套引擎没有跨模式 fallback。

### 22.2 任务模式

- 用户在 Composer 创建任务前选择模式。
- 新 Task 持久化显式模式。
- 模式在 Task 生命周期内不可修改。
- Multi-Skill Writer 关闭时明确拒绝多 Skill 新任务。
- `$skill-id` 只在单 Skill 模式工作。

### 22.3 单 Skill 完整性

- 当前 Planner 和执行行为保留。
- 标准报告保留。
- 当前已批准 Showcase 形式保留。
- Structured Intent 和 deterministic fallback 保留。
- Immutable Store 和 manual CLI 保留。
- Golden、Generality 和安全测试保留。

### 22.4 多 Skill 完整性

- Portfolio Resolver 行为不变。
- Contributor、Synthesizer 和 Reviewer 行为不变。
- Contribution Ledger 和 Fidelity 门禁不变。
- 主线 Report Package 和 Report Editorial Pipeline 行为不变。

### 22.5 前台

- 单 Skill 和多 Skill 选择清楚可见。
- 模式选择支持键盘操作。
- 创建后显示只读模式。
- Plan 和 Report 页面显示实际模式。
- 1440×900 无横向溢出。
- 移动端视口不属于本期验收范围。

### 22.6 验证

- 两种模式各完成一条真实端到端任务。
- 真实 Gateway 和 Tool Receipt 可核验。
- 关闭 Multi-Skill Writer 后单 Skill 仍通过。
- 所有新增和既有定向测试通过。
- `pnpm quality` 通过。
- Web Production Build 通过。
- `git diff --check` 通过。
- 无未授权 commit、merge、push、restart 或发布。

## 23. 推荐执行顺序

1. 关闭当前 Editorial Showcase v1 任务。
2. 固化当前单 Skill 分支。
3. 从最新 `origin/main` 建立干净集成分支。
4. 新增最小 ADR，记录双引擎和任务级模式。
5. 增加 Task 模式字段。
6. 接通单 Skill v2 和多 Skill v3 两条路径。
7. 完整迁入单 Skill Showcase。
8. 接入报告分派。
9. 增加 Composer 模式开关。
10. 运行两种模式的真实 E2E。
11. 通过质量门禁后，经授权 merge 和启用。
