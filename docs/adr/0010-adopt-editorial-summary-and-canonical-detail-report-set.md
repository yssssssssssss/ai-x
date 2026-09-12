# ADR-0010：采用 Canonical Detail 与 LLM Editorial Summary 双报告集

- 状态：Accepted
- 日期：2026-09-01
- 上游决策：ADR-0008、ADR-0009
- 实施方案：`docs/plans/2026-09-01-dual-report-set-development.md`

## 背景

单 Skill 与多 Skill 已经能够在同一部署中按 Task 选择，并分别形成 CurrentExecutionPlan v2 与 v3。两条执行路径都在 Final Review 后产生 Reviewed Canonical Deliverable。

此前的确定性 Editorial Pipeline 与 Universal Showcase 试图让同一份报告同时承担编辑摘要、完整正文和审计追溯，导致摘要阅读效率与 Canonical 完整性互相牵制。后续实现已经验证，把决策摘要与完整研究报告分开，可以在不建立第二事实源的前提下保留两种目标。

同时，允许下载模型生成的内联 JavaScript 会使 Web 挂载、HTTP CSP 和独立下载文件拥有不同安全边界。生产摘要不需要模型脚本即可完成当前需求。

## 决策

1. Task 创建时必须显式选择 `single_skill` 或 `multi_skill`，并将该模式冻结到 Task。环境变量只控制多 Skill 能力是否可创建，不得替 Task 推导执行模式。
2. 两种模式继续使用各自的规划与执行合同：单 Skill 使用 CurrentExecutionPlan v2，多 Skill 使用 CurrentExecutionPlan v3、Portfolio、Contribution 与 Ledger。
3. Final Review 通过后，两种模式共享同一报告派生规则：
   - Canonical Detail Report 是 Reviewed Canonical 的完整可读投影和正式研究交付；
   - Editorial Summary Report 是面向决策阅读的派生摘要。
4. Reviewed Canonical Deliverable 是唯一事实源。Editorial Summary 可以忠实概括和合并重复信息，但不得新增事实、数字、日期、URL，改变 Evidence 状态，或提升确定性。
5. Editorial Summary 由真实 LLM 根据冻结 Source Bundle 生成内容专属的 HTML、CSS 和可选内联 SVG；不使用固定 Profile、固定组件、固定章节或案例模板。
6. 生产 Editorial Summary 禁止 JavaScript、`script` 元素、内联事件属性和运行时网络请求。查看完整依据等行为由宿主根据 `data-*` 安全标记实现。Web 阅读和下载使用同一份经过验证的无脚本 HTML。
7. Summary 生成、Fidelity 或 Store 失败时明确标记 Summary 不可用；Canonical Detail 继续可读。不得把 Detail 包装成 Summary，也不得让 Summary 代替正式交付。
8. 确定性 Universal Showcase 保留为 manual/offline 工具和人工质量参考，不再作为生产报告入口或 fallback。

## 对既有决策的影响

- ADR-0008 关于 Canonical、Evidence、ReportDocument、确定性 Detail Renderer 和不可变 Artifact 的决策继续有效。
- ADR-0008 中“模型不得输出 HTML/CSS”及确定性 Showcase 作为生产首选的条款，仅对生产 Editorial Summary 被本 ADR 取代。
- ADR-0009 关于 Task 级模式选择、冻结、Plan v2/v3 分派和禁止跨模式 fallback 的决策继续有效。
- ADR-0009 中两种模式在报告阶段保持不同生产报告路径的条款，被 Final Review 后共享双报告集的决策取代。

## 结果

### 收益

- 摘要阅读效率与 Canonical 完整性不再由同一页面同时承担。
- 单／多 Skill 的执行差异不会复制两套报告发布基础设施。
- Summary 失败不会阻断正式完整报告。
- Web 与下载文件共享同一个无脚本安全边界。

### 成本

- 需要维护 Summary Source、模型生成、Fidelity、Store 和双视图 UI。
- Summary 与 Detail 的职责必须在测试和产品文案中持续保持清楚。
- 真实发布前仍需分别验证一条单 Skill 与一条多 Skill 路径。

## 被拒绝的方案

### 继续使用确定性 Showcase 作为生产摘要

拒绝。固定组件和 Profile 无法满足当前内容专属编辑叙事，但仍保留为 manual/offline 工具。

### 让摘要承担完整 Canonical 审计

拒绝。摘要允许概括；完整内容和追溯由 Canonical Detail 承担。

### 允许模型 JavaScript 仅在下载文件中运行

拒绝。它会造成 Web、API 与下载文件安全边界不一致，并超出当前需求。

## 回滚

停止生成新的 Editorial Summary Publication，Web 默认展示 Canonical Detail，并明确提示 Summary 暂不可用。已有 Canonical、Detail、Plan、Review 和已封存 Summary 不修改、不删除，也不跨模式重跑任务。
