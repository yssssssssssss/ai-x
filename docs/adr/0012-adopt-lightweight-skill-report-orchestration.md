# ADR-0012：新 Task 采用轻量 SkillReport / FinalReport 编排

- 状态：Superseded by ADR-0013；本 ADR 对应的新任务实现已删除，仅保留决策历史
- 日期：2026-09-04
- 后续决策：`docs/adr/0013-adopt-native-skill-package-runtime.md`

## 背景

现有新 Task 报告链同时维护 CurrentExecutionPlan v2/v3、`skill-output-v2`、Research Contribution、Canonical Deliverable、Cross-Skill Review、Contribution Ledger、ReportReview、ReportDocument v1-v4、ReportPackage v1-v3 与 Editorial Summary/Showcase。该链路让 Skill 自身报告结构被通用合同重复投影，并使 Multi Skill 在 Contributor、Synthesizer、Deliverable、Reviewer 和 Renderer 之间多次改写内容。

产品仍需要用户显式选择并冻结 `single_skill` / `multi_skill`，保留现有四阶段交互、受控 Tool/Knowledge、Lease、Artifact、权限和恢复能力，但新 Task 不再需要旧报告版本兼容。

## 决策

### 1. 使用明确的新 Plan 判别项

新建或明确 Replan 的轻量 Task 写入：

```text
execution_contract_version = lightweight-execution-plan-v1
```

只有该判别项可以进入轻量执行、恢复和报告读取路径。不得按日期、Task mode、文件是否存在或旧 Artifact 内容推断。历史 CurrentExecutionPlan v2/v3 不转换、不迁移，也不得进入轻量路径。

轻量 Plan 冻结：

- Task 与编排模式；
- Contributor Invocation、依赖和 Step；
- Skill 正文、输入合同、报告模板及其 hash；
- 可选的执行合同 hash；
- `ResolvedPlanInputs`。

执行期间使用冻结快照，不用活动目录内容替换运行中 Plan。

### 2. 四个最小业务合同

新路径只使用：

- `SkillInputRequirement`；
- `ResolvedPlanInputs`；
- `SkillReport`，版本 `skill-report-v1`；
- `FinalReport`，版本 `final-report-v1`。

`SkillInputRequirement` 明确 `value | visual | dataset` 类型、必需性、可接受来源和问题。`ResolvedPlanInputs` 同时记录 resolved、pending 与经用户确认的 waived 可选输入。Knowledge/Tool 通过冻结 DAG output binding 提供，不伪装成执行前 value reference。

`SkillReport` 的 Markdown 由 Skill 按冻结报告模板直接生成。来源由平台从已验证 Artifact 确定性投影，模型不得创建 Source ID 或 URL。执行期返回 `needs_input` 时必须携带属于该 Invocation 输入合同的缺失 key，并回到输入确认；它不能进入 FinalReport。

### 3. Single 与 Multi 报告语义

```text
single_skill
→ 一个 SkillReport
→ 保持正文和章节顺序
→ 确定性追加来源 / Gap
→ FinalReport
```

Single 不进行第二次内容 LLM 调用。

```text
multi_skill
→ 1..N Contributor SkillReport
→ 一次最终文本 LLM 综合
→ 确定性追加来源 / Gap
→ FinalReport
```

Multi Plan 不包含旧 Synthesizer Skill、Research Contribution、Cross-Skill Reviewer 或 Ledger。综合失败时确定性拼接原始 Skill Markdown 并标注综合未完成；不重跑已完成 Skill。

### 4. 唯一终态 Artifact 根

轻量执行固定写入：

```text
skill-results/<invocation-id>.json
skill-results/<invocation-id>.md
reports/final-report.json
reports/report.md
reports/report.html
reports/sources.json
```

`reports/final-report.json` 的 SEALED `final_report` Artifact 是唯一终态根。执行完成、命令丢失恢复、Artifact invalidation、API 读取和下载都从该根验证 Task/PlanVersion/Attempt 绑定，不依赖旧 ReportReview、ReportDocument 或 ReportPackage。

### 5. 输入与权限边界

输入解析顺序为会话、当前 Task 上传、当前用户/项目有权限的数据库资料，再到冻结 Knowledge/Tool binding。相同 key 只询问一次并绑定所有目标 Invocation。

- 必需输入缺失：阻断并要求补充或 Replan；
- 可选输入缺失：只有用户明确确认后才进入 waived，并形成 Gap；
- 数据库资料只在 Input Resolution 信任边界检查归属、权限、适用范围和状态；
- 同一检查不在 Planner、Execution 和 Reporting 重复实现。

### 6. 输出安全

LLM 只生成 Markdown。平台统一解析、清理并输出无脚本、自包含 HTML：禁止 JavaScript、事件属性、iframe、form 与运行时网络请求；外部链接必须是已验证来源中的 HTTPS URL。

### 7. Catalog 与热更新

新建 Task / Replan 时扫描受控 Skill 目录并形成不可变快照。完整目录发布后，新内容只影响下一次规划；运行中 Task 不漂移。当前实现不建设配置中心、Watcher、任意代码插件或工作流 DSL。

### 8. Web 与 API

保留 Stage 1-3 主交互。Stage 4 只展示：

```text
最终报告
Skill 明细
```

新报告 API 为：

```text
GET /control-tasks/:id/skill-reports
GET /control-tasks/:id/final-report
GET /control-tasks/:id/final-report.html
```

新 Web 路径不识别 ReportDocument 或 ReportPackage 版本。

## 对既有 ADR 的影响

对轻量新 Task：

- 取代 ADR-0003 中 Canonical Deliverable / ReportDocument 真相源和兼容写入；
- 取代 ADR-0005、0006 的类型化布局、Step 10 Canonical 编译与 Patch；
- 取代 ADR-0007 的 Contribution、Ledger 与 Cross-Skill Reviewer；
- 取代 ADR-0008、0010 的生产 ReportDocument / ReportPackage / Editorial Summary 双报告集；
- 取代 ADR-0011 的 Legacy Invocation 兼容路径；
- 取代 ADR-0009 的 Plan v2/v3 分派，但保留用户显式选择并冻结 Single/Multi、禁止跨模式 fallback。

ADR-0001/0002 的真实调用安全边界，以及 ADR-0004 的 plan/answer 任务语义继续有效。

历史 ADR、数据库记录和文件不修改。本 ADR 不授权历史 Reader、迁移或回填。

## 结果

### 收益

- Skill 报告结构成为 Single 的内容真相源；
- Multi 只增加一次综合调用；
- 报告失败不重跑 Skill/Tool；
- 新 Task 只有一套报告合同和终态根；
- Skill、输入解析、执行、综合和 Renderer 边界明确。

### 成本

- Planner、执行尾部、恢复、API 和 Stage 2-4 需要一次性切换；
- 代表性 Skill 必须声明输入合同和报告模板；
- 发布前需分别完成 Single 与 Multi 自动化及真实 smoke。

## 被拒绝的方案

- 继续增加 ReportDocument / ReportPackage 新版本；
- 把 `skill-output-v2` 转换成 SkillReport；
- 保留 Plan v2/v3 双读或按旧 Artifact 猜测路径；
- Multi 保留旧 Synthesizer Skill 后再追加最终综合；
- 用规则 Reviewer、Repair 循环或复杂模板引擎补偿内容质量；
- 直接让模型生成 HTML/JavaScript；
- 为历史 Task 建迁移器、回填或兼容 Adapter。

## 回滚

轻量路径未发布前直接回滚本分支提交。发布后若停止创建轻量新 Task，应停止入口并保留已经封存的轻量 Plan 与 Artifact；不得把它们转换为旧合同，也不得自动切回 v2/v3 执行。
