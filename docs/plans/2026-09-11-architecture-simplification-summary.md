# AI-X 架构轻量化优化方案总结

> 状态：待决策
> 日期：2026-09-11
> 依据：2026-09-05 代码只读审计、`CONTEXT.md`、ADR-0001 至 ADR-0011，以及两份 2026-09-04 轻量化草案
> 范围：规划、执行、报告、门禁和 CI；不包含本轮代码修改

## 结论

当前复杂度主要来自多代架构长期并存。Plan v2/v3、legacy invocation、ReportDocument v1 至 v4、ReportPackage v1 至 v3、Editorial Summary、Showcase 和多组 Feature Flag 同时存在。每次演进都增加新的 Writer、Reader、Schema、校验和回退路径，旧路径却没有退出生产链。

推荐采用破坏性收敛：新任务只保留一个 Plan Interface、一条执行链、一个最终报告事实源和一次发布校验。`single_skill` 与 `multi_skill` 只表达 Skill 数量差异。Single Skill 直接采用 Skill 结果，Multi Skill 最多进行一次综合，最终由确定性 Renderer 生成 HTML。旧合同随入口切换同步删除，不建设双写、兼容层或长期 Feature Flag。

## 审计快照

以下数据来自 2026-09-05 的审计快照，仅用于说明复杂度规模。

| 指标 | 快照结果 |
|---|---:|
| TypeScript 生产代码 | 约 97,292 行 |
| `report/` | 70 个文件、36,698 行，约占 38% |
| 测试代码 | 约 100,055 行、2,338 项测试 |
| Schema | 62 个 |
| Active Skill | 25 个，其中 6 个 compiled |
| 最大文件 | `control-plane.ts` 5,628 行；`lease-execution-engine.ts` 5,552 行 |

主要结构问题包括：

- [LeaseExecutionEngine](../../apps/orchestrator-runtime/src/control/lease-execution-engine.ts) 同时承担调度、Lease、Skill 执行、Deliverable、Review、ReportDocument、HTML、Package 和补偿。
- [ControlRuntime](../../apps/agent-api/src/control-runtime.ts) 同时处理依赖装配、版本路由、报告构造、Feature Flag 和历史回退。
- [CurrentReportPackageReader](../../apps/orchestrator-runtime/src/report/current-report-package-reader.ts)、Package verifier 和 Web 各自解释并校验同一批 Artifact。
- [ControlPlaneRepository](../../database/control-plane.ts) 反向导入 Plan Compiler，形成持久化与规划之间的依赖循环。
- 报告 Composer 和多个 Projector 互相引用，合同类型也在 Implementation 内重复定义。
- Legacy Orchestrator 的真实 LLM 和 Tool 已被封禁，写入口返回 410，旧 Runner、spike 和测试仍然保留。
- CI 在普通 push 上串行运行多条真实模型路径，研究质量验收和代码回归检查混在一起。

## 目标架构

```text
Web / HTTP
    ↓
Requirement Module
    ↓
Plan Module：统一 Plan，包含 1..N 个 Skill Invocation
    ↓
Input Resolution Module
    ↓
Execution Module：Lease / Retry / Actor / Artifact
    ↓
SkillResult[]
    ↓
Finalization Module
    ├─ Single：直接采用 Skill 结果
    └─ Multi：最多一次最终综合
    ↓
唯一发布硬门禁
    ↓
ReportResult
    ↓
确定性 HTML Renderer
    ↓
可选 Publication Adapter
```

Module 应提供小而稳定的 Interface，把复杂 Implementation 留在内部。只有存在两个真实 Adapter 时才建立 Seam。架构收敛优先提升 Depth、Leverage 和 Locality，不以新增抽象层为目标。

## 优化项

### P0：统一决策和 Plan

新增一份 superseding ADR，明确一个当前 Plan Interface。`single_skill` 与 `multi_skill` 只限制 Skill 数量，不再选择不同 Plan 版本和执行引擎。compiled 与单次 Skill 调用属于 Plan Module 的内部 Implementation，不继续向调用者暴露两套语义。

Plan 在冻结时完成结构、权限和输入绑定校验。执行前只检查冻结内容、Skill Contract 和 hash 是否漂移，避免重复解释完整 Plan。Repository 只保存已经验证的数据，不导入 Planner。

这项决策需要重开 [ADR-0009](../adr/0009-adopt-task-scoped-dual-orchestration-modes.md)、[ADR-0010](../adr/0010-adopt-editorial-summary-and-canonical-detail-report-set.md) 和 [ADR-0011](../adr/0011-support-legacy-invocations-in-single-skill-plan-v2.md)，并同步修改 [CONTEXT.md](../../CONTEXT.md)。

### P0：统一最终报告

新任务只产生一个当前 ReportResult。Single Skill 直接采用其最终结果，Multi Skill 把全部 Skill 结果交给一次最终综合。Skill 原始结果保留为内部诊断和来源材料，不作为第二份正式事实源。

ReportResult 保存正文、真实来源、Gap 和完成状态。Renderer 只负责展示、转义、打印和下载，不总结、不改写，也不补充事实。停止新写入 ReportDocument v1 至 v4、ReportPackage v1 至 v3、Showcase、Contribution Ledger、Cross-Skill Review 和多轮 Fidelity Repair。

### P0：校验一次，GET 保持纯读

Artifact 的 hash、Schema、任务绑定和来源关系只在可信读取 Seam 验证一次，验证结果作为聚合值传递给后续 Module。Web 不再重复解释版本、Manifest 和 binding。

Editorial Summary 当前可能由 GET 请求触发模型调用和文件写入。入口切换后，所有 GET 只读取已封存结果。若保留摘要，它只能作为显式生成的派生 Publication，失败不得影响正式报告。

### P1：收缩 Execution Module

LeaseExecutionEngine 只负责调度、Lease、Retry、Actor 执行、状态提交和失败恢复。Deliverable、Review、报告组合、HTML 和发布从其 Implementation 中移出。ControlRuntime 只装配真实 Adapter，不处理业务版本分支。

### P1：修复依赖方向并删除退休路径

统一 Plan 解码后，移除 Repository 到 Planner 的反向依赖。报告合同统一引用 `packages/api-contract`，Projector 不再依赖 Composer Implementation。解除 Artifact Store 与 Artifact Publication Group 的类型循环，但保留后者，因为它集中处理补偿，具备实际 Leverage。

按 deletion test 删除 Legacy Orchestrator、旧 Runner、spike 命令、旧 Editorial CLI、无生产引用的 audit Module，以及对应的旧 Flag、Schema 和测试。历史数据如需保留，应放入独立的只读归档 Adapter，不进入当前热路径。

### P2：收敛 CI 和真实模型验收

PR 保留类型检查、lint、Fixture、关键集成测试和 HTML 安全检查。真实 Single、Multi smoke 放到 nightly、手动或 release 流程。Gold 批次与独立研究员评审继续作为离线质量验收，不参与普通代码提交的状态机。

## 门禁分层

| 门禁 | 级别 | 归属与处理 |
|---|---|---|
| 用户归属、资料权限 | 硬门禁 | Input Resolution Seam 校验一次 |
| 外部写入、付费、不可逆动作 | 硬门禁 | Tool Adapter 执行前确认 |
| Plan 完整性和冻结内容漂移 | 硬门禁 | 冻结时完整校验，执行前只检查漂移 |
| Lease、Fencing、Artifact 原子性和 hash | 硬门禁 | Execution 与 Artifact Module |
| 事实 Claim 到 Source 的完整性 | 硬门禁 | 正式发布前统一校验 |
| 敏感数据 | 硬门禁 | 可信输出 Seam 统一拦截 |
| HTML 脚本、事件属性和远程请求 | 硬门禁 | Renderer |
| 内容质量、措辞、视觉和方法覆盖 | Warning | 不暂停执行 |
| 证据较弱、可选资料缺失和 Skill 冲突 | Gap | 报告中明确展示 |
| Gold、真实模型质量和研究员可用性 | 离线验收 | nightly、release 或人工评审 |

事实 Claim 引用未知 Source 时，不得只删除引用后继续发布。正确处理方式是阻止正式发布，或先把该 Claim 降级为明确的待验证假设。这条规则用于守住 [CONTEXT.md](../../CONTEXT.md) 定义的可追溯报告和来源伪造底线。

## 实施顺序

1. **冻结决策**：编写 superseding ADR，确定一个 Plan、一个当前报告、唯一事实源和门禁归属。
2. **固定基线**：保留一个 Single 和一个 Multi Fixture，记录来源、Gap、任务状态和最终 HTML。
3. **实现纵向切片**：打通统一 Plan、SkillResult、ReportResult、发布门禁和 Renderer，不双写旧合同。
4. **切换入口**：Web 和 HTTP 入口只读取新结果，GET 全部改为纯读。
5. **同步删除旧链**：删除旧 Writer、Reader、Flag、Schema、Review、Ledger、Showcase 和对应测试，不保留兼容层。
6. **深化剩余 Module**：收缩 LeaseExecutionEngine，解除 Repository 和报告投影循环。
7. **调整 CI**：确定性检查进入 PR，真实模型检查进入 nightly、手动和 release。

实施时不要先拆分即将删除的大文件。完成入口切换和旧路径删除后，再处理剩余的真实复杂度。

## 完成标准

- 只有一个生产执行引擎。
- 只有一个当前 Plan Interface，并且只解码一次。
- 只有一个当前报告 Writer、Reader 和验证过程。
- 生产链中没有 Showcase 入口。
- GET 不调用模型，也不写文件。
- 报告投影和 Repository 依赖循环清零。
- 未知事实来源仍然阻止正式发布。
- Single 和 Multi Fixture 均通过，真实 smoke 各保留一条。
- 旧 Schema、Feature Flag、版本分支和实现型测试同步删除。
- 变更后的文件数、Schema 数和代码行数净减少。

## 实施约束

- 不建设第三种编排模式、通用工作流 DSL、配置中心或热加载平台。
- 不为全部 Skill 批量新增模板和 Execution Contract，只处理当前纵向切片需要的能力。
- 不使用长期 Feature Flag 维持新旧路径并存。
- 不迁移或回填历史 Task、Plan 和 Artifact。
- 不让 Skill 原始结果形成第二个正式事实源。
- 不把内容质量判断机械化为新的规则引擎或封闭错误码集合。
