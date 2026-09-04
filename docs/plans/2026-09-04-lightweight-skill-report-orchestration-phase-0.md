# 轻量 Skill 报告编排 Phase 0 边界冻结记录

> 日期：2026-09-04
> 状态：Phase 0 经独立审查补充冻结；后续 Phase 1-5 已实施
> 方案：`docs/plans/2026-09-04-lightweight-skill-report-orchestration-development.md`

## 1. 开发隔离与切换边界

- 当前 Worktree：`/Users/heyunshen/work/PROJECT/jdc/ai-x-lightweight`
- 当前分支：`refactor/lightweight-skill-orchestration`
- 分支基线：`ff97f5c`
- 开发方案独立提交：`ee2e44c docs: add lightweight skill report orchestration plan`
- 原 Worktree `/Users/heyunshen/work/PROJECT/jdc/ai-x` 仅用于对照，不在本次开发中修改。
- 新路径只服务于轻量实现启用后创建或明确 Replan 的 Task。历史 Task、Plan、Artifact、HTML 和数据库记录保持原样；新路径不读取、不迁移、不回填旧报告合同，也不增加双读或兼容 Adapter。
- `single_skill` / `multi_skill` 继续由 Task 创建请求显式选择并冻结，禁止执行失败后跨模式降级。

### 新任务切换点

以“由轻量 Planner 创建并写入当前轻量 Plan 的新 Task”为唯一切换点，而不是按时间、旧 Artifact 内容或报告版本猜测：

1. 新建 Task 或用户明确触发 Replan 时，扫描并冻结当前 Skill Catalog、输入合同与报告模板；
2. 该 Plan 后续只生产本文件冻结的 `ResolvedPlanInputs`、`SkillReport` 和 `FinalReport`；
3. 不含轻量 Plan 标记的历史 Task 不进入新执行或报告读取路径；
4. 不新增迁移脚本、旧版本 Reader、双写或 fallback。

## 2. 本地环境与基线

### 2.1 工具链

| 项目 | 结果 |
|---|---|
| Node.js | `v22.22.1`，满足根 `package.json` 的 `node >=22` |
| pnpm | `9.12.1`，与 `packageManager: pnpm@9.12.1` 一致 |
| 根依赖 | `pnpm install --frozen-lockfile` 成功，复用 lockfile，安装 158 个包 |
| Web 依赖 | `pnpm --dir apps/web install --frozen-lockfile` 成功，安装 78 个包 |
| 本地环境文件 | `.env`、`.env.local` 均不存在；只有已提交的 `.env.example` |
| Git 工作区 | 方案提交后干净 |

第一次执行 `pnpm quality` 时，根依赖已安装但 `apps/web/node_modules` 尚未安装，Web TypeScript 因缺少 React JSX 类型而失败。安装 Web 自身锁定依赖后原命令通过；该问题归类为 Worktree 环境未准备完整，不修改源码或 lockfile。

### 2.2 自动化基线

| 命令 | 结果 |
|---|---|
| `pnpm quality` | 通过：root + Web typecheck、Registry lint、Knowledge lint、全量测试均成功 |
| 全量测试汇总 | `2338` tests：`2320` pass、`18` skip、`0` fail |
| `pnpm exec tsx --test tests/control-planning-service.test.ts tests/research-planning-service.test.ts tests/orchestration-mode-ui.test.ts tests/multi-skill-capability-portfolio.test.ts tests/multi-skill-plan-compiler.test.ts tests/multi-skill-execution.test.ts tests/multi-skill-report-ui.test.ts tests/current-real-smoke.test.ts` | `106` tests：`101` pass、`5` skip、`0` fail |

未运行真实 LLM / Tool smoke：`ALLOW_REAL_PROVIDER`、Gateway 配置、Multi writer 开关与 Virtual User Lab 地址均未启用；Phase 0 只冻结本地合同和诊断，符合“先冻结本地合同，再跑真实单路径与第二路径”的要求。环境中仅检测到 `TAVILY_API_KEY` 已设置，未读取或输出其值，也未发起真实调用。

## 3. 现状核对

四个目标合同当前均不存在同名实现，不能把旧合同改名后继续使用。

| 目标合同 | 当前最接近实现 | 差异与结论 |
|---|---|---|
| `SkillInputRequirement` | `SkillRegistryEntry.inputs`、`composition.required_input_roles` / `optional_input_roles`、`CurrentCapabilityPendingInput` | 当前只有 role、kind、label、multiple，缺少描述、必需性、可接受来源和面向用户的问题；需要一个新的公开输入声明。 |
| `ResolvedPlanInputs` | `PendingInput`、`pending-input-contract.ts`、各类 input gate store | 当前只保存未满足输入及 Step/Tool 字段目标，已解析值分散在会话与 Gate 中；需要一个同时表达 `resolved` 与 `pending`、并绑定 Invocation 的 Plan 级结果。 |
| `SkillReport` | `skill-output-v2` envelope + 独立 Evidence Manifest / Gap | 当前输出以 summary/findings/payload 为中心，不含原始 Markdown、Invocation 身份、来源列表和 Gap；不能作为新的 `SkillReport` 读取。 |
| `FinalReport` | Research Deliverable + ReportReview v1-v3 + ReportDocument v1-v4 + ReportPackage v1-v3 | 当前报告由多层 Review、Canonical、Document、Package 派生；新 Task 直接写唯一 `final-report-v1`，不得经旧链路转换。 |

## 4. 冻结的最小合同

Phase 0 保持轻量边界，不增加多版本 Reader、错误码目录、审计账本或兼容字段。独立审查确认，新路径还必须有一个明确 Plan 判别项，否则无法与历史 v2/v3 Plan 隔离。

### 4.1 LightweightExecutionPlanV1

```ts
interface LightweightSkillSnapshot {
  skill_id: string;
  body: string;
  body_hash: string;
  input_requirements: SkillInputRequirement[];
  input_requirements_hash: string;
  output_schema_hash: string;
  report_template: string;
  report_template_hash: string;
  execution_contract_hash?: string;
}

interface LightweightSkillInvocation {
  invocation_id: string;
  skill_id: string;
  depends_on_invocation_ids: string[];
  step_nos: number[];
  required: boolean;
  failure_policy: 'block' | 'gap';
  snapshot: LightweightSkillSnapshot;
}

interface LightweightExecutionPlanV1 {
  execution_contract_version: 'lightweight-execution-plan-v1';
  task_id: string;
  mode: 'single_skill' | 'multi_skill';
  skill_invocations: LightweightSkillInvocation[];
  resolved_inputs: ResolvedPlanInputs;
  steps: CurrentPlanStep[];
}
```

- 只有该 discriminator 能进入轻量执行、恢复与报告读取路径；不得根据时间、Task mode、文件存在或旧 Artifact 内容猜测。
- Plan 直接保存冻结的 Skill 正文、输入合同和报告模板及其 hash。执行期间不得重新读取活动目录内容来替换快照。
- `single_skill` 恰好一个 Invocation；`multi_skill` 包含 1..N Contributor Invocation，不包含旧 Synthesizer Skill。最终综合由 Reporting Module 发起一次文本 LLM 调用。
- `steps` 继续复用现有 DAG、Lease、Tool、Knowledge 与 Artifact 执行能力；旧 v2/v3 Plan 不得进入该路径。

### 4.2 SkillInputRequirement

```ts
type SkillInputSource =
  | 'conversation'
  | 'upload'
  | 'database'
  | 'knowledge'
  | 'tool';

interface SkillInputRequirement {
  key: string;
  kind: 'value' | 'visual' | 'dataset';
  label: string;
  description: string;
  required: boolean;
  multiple: boolean;
  acceptedSources: SkillInputSource[];
  question: string;
}
```

### 4.3 ResolvedPlanInputs

```ts
interface ResolvedPlanInputs {
  resolved: Array<{
    key: string;
    valueRef: string;
    source: Exclude<SkillInputSource, 'knowledge' | 'tool'>;
    targetInvocationIds: string[];
  }>;
  pending: Array<{
    requirement: SkillInputRequirement;
    targetInvocationIds: string[];
  }>;
  waived: Array<{
    key: string;
    targetInvocationIds: string[];
    reason: string;
  }>;
}
```

Knowledge 与 Tool 输入由冻结 DAG output binding 满足，不伪造为执行前已经存在的 `valueRef`。

### 4.4 SkillReport

```ts
interface SourceReference {
  id: string;
  title: string;
  type: 'user_input' | 'knowledge' | 'tool_result';
  url?: string;
}

interface SkillReport {
  version: 'skill-report-v1';
  skillId: string;
  invocationId: string;
  title: string;
  status: 'completed' | 'completed_with_gaps' | 'needs_input';
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
  missingInputKeys?: string[];
}
```

`SourceReference` 不是模型自由输出，而是平台从已验证输入、Knowledge 与 Tool Artifact 确定性投影。`needs_input` 时 `missingInputKeys` 必须非空且属于当前 Invocation 的冻结输入合同；其他状态不得携带该字段。

### 4.5 FinalReport

```ts
interface FinalReport {
  version: 'final-report-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  mode: 'single_skill' | 'multi_skill';
  title: string;
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
  skillReports: Array<{
    skillId: string;
    invocationId: string;
    status: Exclude<SkillReport['status'], 'needs_input'>;
    path: string;
  }>;
}
```

### 4.6 最小语义约束

- `SkillInputRequirement.key` 是跨 Skill 去重键；只有语义相同且 `kind` 一致的输入使用同一个 key。
- `valueRef` 只保存受控存储引用，不内联原始敏感内容。`multiple: true` 时，该引用指向一个已绑定的集合 Artifact，不再增加单值/多值联合类型。
- `resolved`、`pending` 与 `waived` 对同一个 key 互斥；`targetInvocationIds` 必须属于当前冻结 Plan。
- 必需输入不能进入 `waived`；可选输入只有在用户明确确认继续后才能进入 `waived`，并确定性形成 Gap。
- 会话、上传和有权限数据库资料在报告来源中统一归为 `user_input`；获取渠道仍保留在输入绑定记录中。数据库归属、权限、适用范围与可用状态只在 Input Resolution 信任边界校验一次。
- `SourceReference.id` 必须由系统投影到已存在的输入、Knowledge 或 Tool 来源记录；模型不得创建 SourceReference。Markdown 只允许 `[S-id]` 引用，所有外部链接必须与已验证来源 URL 完全一致。
- Single 的 `FinalReport.markdown` 保持 Skill 正文与章节顺序不变，只允许系统在正文后确定性追加来源和 Gap。
- Multi 只允许一次综合 LLM 生成正文；来源和 Gap 由系统确定性合并、追加。综合失败时拼接各 Skill 原始 Markdown，不重跑 Skill。
- `FinalReport.skillReports[].path` 只能是当前 Task 工作区内的相对 JSON 路径，且状态不得为 `needs_input`。
- 合同只在受信边界校验一次；不在 Loader、Planner、Execution、Reporting 重复实现同一套校验。

### 4.7 终态 Artifact 与固定路径

轻量执行以唯一 SEALED `final_report` Artifact 为终态根：

| Artifact kind | 固定相对路径 | Schema / media type |
|---|---|---|
| `skill_report` | `skill-results/<invocation-id>.json` | `skill-report-v1` |
| `skill_report_markdown` | `skill-results/<invocation-id>.md` | `text/markdown; charset=utf-8` |
| `final_report` | `reports/final-report.json` | `final-report-v1` |
| `final_report_markdown` | `reports/report.md` | `text/markdown; charset=utf-8` |
| `final_report_html` | `reports/report.html` | `text/html; charset=utf-8` |
| `report_sources` | `reports/sources.json` | `source-reference-list-v1` |

完成、命令丢失恢复、Artifact invalidation 与读取都从 `reports/final-report.json` 的 SEALED 身份开始，不从旧 ReportReview、ReportDocument 或 ReportPackage 重建。

## 5. 纵切选择

### 5.1 Single Skill

选择 `competitive-web-research`（竞品分析的 Web 纵切实现）：

- Registry 状态为 active，支持 `standalone` 和 answer；
- 已有 `references/competitive-analysis-skeleton.md`，可以直接作为报告语义结构，不需要发明通用模板；
- 同一个 Skill 也进入 Multi Fixture，可用最小能力集合同时证明“Single 原样直出”与“Multi 保留原始报告后综合”；
- 输入可覆盖 `research_goal`、`public_evidence`、`user_materials`，适合验证会话、Tool/Knowledge 与用户材料来源。

Single 验收路径：

```text
competitive-analysis
→ SkillReport
→ 原正文不改写
→ 确定性来源 / Gap 附录
→ FinalReport
```

### 5.2 Multi Skill

选择 3 个 Contributor：

1. `competitive-web-research`：市场与竞品判断；
2. `generate-persona`：Persona 与用户分型；
3. `jobs-to-be-done`：核心 Job、需求层次与机会点。

选择理由：

- 三者均为 active，当前 Registry 均声明 contributor 能力并兼容 `research_strategy_report`；
- 三者已有独立输出骨架，能够验证 Skill 自己控制报告章节；
- `research_goal` 可一次解析后绑定三个 Invocation；
- `user_materials` 可一次上传后绑定 Persona 与 JTBD，必要时也供竞品分析使用，能够验证跨 Skill 去重；
- 组合覆盖市场、用户类型和深层需求，足以验证一次综合，不引入 Metrics、Journey、Virtual User 或额外 Tool/Lab。

Multi 验收路径：

```text
competitive-web-research ─┐
generate-persona ─────┼→ SkillReport[] → 一次综合 LLM → FinalReport
jobs-to-be-done ──────┘
```

首个 Fixture 复用现有京东众筹研究主题，但把当前 5 Contributor + Synthesizer 链缩到上述 3 个 Skill；Fixture 只验证合同、输入绑定、原始 SkillReport 保留、一次综合和失败降级，不在普通测试中调用真实 Provider。

## 6. ADR 冲突记录

轻量方案对新 Task 明确取代下列既有决策中的报告或编排部分：

- ADR-0003：Canonical Deliverable / ReportDocument 真相源与旧版本兼容；
- ADR-0005、0006：类型化报告布局、Step 10 Canonical 编译与 Patch；
- ADR-0007：Contribution、Ledger、Cross-Skill Reviewer；
- ADR-0008、0010：ReportDocument / ReportPackage / Editorial Summary 双报告集；
- ADR-0011：Single Skill Plan v2 的 Legacy Invocation 兼容。

ADR-0004 的 plan/answer 任务语义、ADR-0009 的用户显式选择并冻结 Single/Multi 模式、ADR-0001/0002 的真实调用安全边界仍可保留。ADR-0012 作为本次 Phase 0 补充冻结的一部分，与本文件一起先于业务代码提交。它明确上述“仅对新 Task 被取代”的范围；不修改历史 ADR 来伪造历史决策。

## 7. 最小实施范围（写代码前检查点）

第一条可运行纵切最多新增 5 个文件：

1. `docs/adr/0012-adopt-lightweight-skill-report-orchestration.md`：记录新 Task 的取代关系与切换边界；
2. `packages/api-contract/lightweight-orchestration.ts`：Plan discriminator、四个合同、`SourceReference` 与唯一的边界解析；
3. `apps/orchestrator-runtime/src/input-resolution/resolved-plan-inputs.ts`：输入聚合、去重和 Invocation 绑定；
4. `apps/orchestrator-runtime/src/report/lightweight-reporting.ts`：Single 直出、Multi 一次综合、来源/Gap 附录和失败拼接；
5. `tests/lightweight-skill-report-orchestration.test.ts`：一个 Single Fixture 与一个三 Skill Multi Fixture。

只修改现有接线文件，不新增更多抽象或配置系统：

- 在现有 `orchestrator/skill-registry.yaml` 为三个 Skill 声明输入合同，并直接引用已有 `references/*-skeleton.md` 作为报告模板；不复制三份新模板。
- 在现有 Loader / Planner / Execution 接线点调用上述两个模块。
- 首条纵切不改 Web、不做真实 LLM 校准、不迁移数据库、不读取旧报告、不增加 feature flag、Reviewer、Repair、Ledger 或第三种编排模式。

进入后续 Web 和安全 HTML 阶段前，再单独给出该阶段的最小范围；不得借首条纵切提前建设平台化能力。
