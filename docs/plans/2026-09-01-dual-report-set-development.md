# 双报告集生成与展示开发方案

> 状态：核心实现与本地验收完成，等待最终人工代码评审和合并授权
> 日期：2026-09-01
> 目标分支：`feat/dual-orchestration-mode`
> 目标工作区：`/Users/heyunshen/work/PROJECT/jdc/ai-x-dual-orchestration`
> 适用范围：全部新建 Current Task、全部 active Deliverable、`single_skill` 与 `multi_skill`
> 默认视口验收：1440×900

## 1. 决策摘要

每个通过 Final Review 的任务必须提供两份职责不同的报告：

```text
Reviewed Canonical Deliverable
├── Editorial Summary Report，编辑摘要报告
└── Canonical Detail Report，完整研究报告
```

两份报告共享同一个 Canonical 真相源，但承担不同目标：

| 报告 | 主要目标 | 是否允许概括 | 是否要求完整内容 |
|---|---|---:|---:|
| Editorial Summary Report | 快速理解、形成判断、推动决策 | 是 | 否，但关键结论必须可追溯 |
| Canonical Detail Report | 完整交付、研究复盘、证据审计 | 否 | 是 |

V1 只作为编辑摘要的质量参考案例，不作为 HTML、CSS、章节、组件或视觉模板。

## 2. 问题背景

此前尝试让同一份报告同时满足以下目标：

```text
视觉自由、决策优先、阅读简洁
+
Canonical 全量覆盖、逐项追溯、审计完整
```

这两个目标互相冲突。

V1 允许模型进行编辑性概括，因此形成了清晰的决策叙事和内容专属视觉。V2 为保证 238 个 Canonical Unit 全部逐字可见，把内部追溯结构直接转换为阅读结构，最终形成超长底稿和重复信息，破坏了 V1 的信息层级与节奏。

双报告方案通过职责拆分解决这一矛盾：

- 编辑摘要负责理解效率和视觉叙事。
- 完整报告负责内容完整性和审计。
- 不再强迫摘要承担完整底稿职责。
- 不再强迫完整报告承担高度概括职责。

## 3. 必须覆盖的任务范围

当前 Deliverable Registry 中的 6 种 active Deliverable 全部进入双报告链路：

| Task Type | Deliverable |
|---|---|
| `user_research_planning` | `research_plan` |
| `research_synthesis` | `research_strategy_report` |
| `competitive_research` | `competitive_analysis_report` |
| `voc_diagnosis` | `voc_diagnosis_report` |
| `design_audit` | `design_audit_report` |
| `a11y_audit` | `accessibility_audit_report` |

两种编排模式全部覆盖：

```text
6 种 Deliverable × 2 种 Orchestration Mode = 12 条内容路径
```

编排模式只影响上游内容生产：

- `single_skill`：CurrentExecutionPlan v2，一个 Synthesizer Skill。
- `multi_skill`：CurrentExecutionPlan v3，Portfolio、Contribution、Ledger 和 Synthesizer。

Final Review 之后，两种模式使用同一套双报告生成规则。

## 4. 领域定义

### 4.1 Canonical Deliverable

唯一事实源。保存受 Review 约束的完整研究内容、Evidence、状态、置信度、风险和来源关系。

### 4.2 Canonical Detail Report

Canonical Deliverable 的完整可读投影。保留全部业务信息和审计细节，是研究复盘和后续分析的正式依据。

本期直接复用当前项目已有的：

- ReportDocument。
- CurrentTextReport。
- Report Package。
- Contribution Ledger。
- Cross-Skill Review。
- Markdown／JSON／HTML Bundle。

### 4.3 Editorial Summary Report

由真实 LLM 基于 Reviewed Canonical 生成的编辑摘要 HTML。它可以合并和概括内容，但不能新增事实或改变证据边界。

V1 体现的是这种报告应具备的能力：

- 先形成编辑判断。
- 根据内容建立叙事路径。
- 为当前报告选择专属视觉隐喻。
- 把证据、限制和详细底稿放在合适层级。

V1 的具体 DOM、CSS、Hero、九章结构和配色不得进入生产模板。

### 4.4 Report Set

Report Set 是同一 Task／Plan／Attempt 下两份报告的逻辑组合，不新增独立数据库实体：

```ts
interface CurrentReportSetV1 {
  version: 'current-report-set-v1';
  preferredView: 'editorial_summary';
  detailReport: CurrentReportPackageResponse;
  summaryReport: {
    endpoint: 'editorial-summary.html';
    status: 'working' | 'ready' | 'failed';
  };
}
```

其中 Detail 继续通过 Current Deliverable Response 返回；Summary 状态由独立 HTML 请求在前台维护，避免 Summary 生成等待或失败阻塞 Detail。

## 5. 总体架构

```text
Task Execution
→ Canonical Deliverable
→ Final Review Pass
→ Canonical Detail Report
→ Frozen Summary Source Bundle
→ LLM Editorial Strategy
→ LLM Full HTML
→ Summary Fidelity Review
→ Immutable Summary Publication
→ Report Set
```

### 5.1 唯一事实源

两份报告都从 Reviewed Canonical 派生：

```text
Canonical Deliverable
├── Detail Projection
└── Summary Projection
```

禁止：

```text
Detailed Report
→ 自由扩写
→ 形成第二套事实
```

详细报告可以作为摘要模型的阅读辅助，但所有可发布事实必须能回到 Canonical 或 Evidence。

### 5.2 权威顺序

```text
Canonical Deliverable
> Canonical Detail Report
> Editorial Summary Report
```

发生冲突时，以 Canonical 为准。

## 6. 设计规模检查

本方案涉及超过 5 个文件，并新增一个 Summary 生成职责。为避免重新平台化，本期采用以下最小实现。

### 6.1 本期最小实现

- 保留现有 Detail Report 全链路。
- 将当前 Universal Showcase 的生产职责改为 Editorial Summary。
- 复用现有 Source Reader、不可变 Store、owner-bound HTML API 和缓存／锁。
- 新增一套摘要专用 LLM 生成服务。
- Web 改为“编辑摘要／完整报告”双视图。
- 不新增数据库表。
- 不新增报告类型注册框架。
- 不增加用户可配置主题、模板或视觉 Profile。

### 6.2 本期不做

- 不建立主题市场或模板系统。
- 不建立组件插件框架。
- 不做历史任务批量回填。
- 不增加用户级报告偏好表。
- 不提供多种可选视觉风格。
- 不进行移动端验收。
- 不要求 Summary 逐字覆盖所有 Canonical Unit。

## 7. 完整研究报告

### 7.1 目标

完整报告必须保留：

- 全部 Direct Answer。
- Finding、Analysis、Summary 和 Conclusion。
- 请求交付物的完整结构。
- Evidence 和来源。
- 状态、置信度和验证条件。
- Recommendation 和 Action 细节。
- Limitations、Open Questions 和 Risk Disclosure。
- 多 Skill Contribution 和 Review Sidecar。

### 7.2 实现

继续使用当前项目已有的：

```text
Reviewed Canonical
→ ReportDocument／CurrentTextReport
→ Existing Detailed Renderer
→ Report Package
```

本期不重写 Detailed Renderer，不把 V1 的样式复制到完整报告。

### 7.3 详细报告失败

详细报告是正式交付物。生成失败时不得完成 Task：

```text
Detail Report failed
→ Task paused／failed
→ 不生成可交付 Report Set
```

## 8. 编辑摘要报告

### 8.1 目标

摘要报告回答：

- 最重要的业务判断是什么？
- 为什么？
- 哪些证据已经支持？
- 哪些仍是 provisional／simulation／unknown？
- 应该先做什么？
- 去哪里查看完整依据？

摘要允许：

- 合并重复内容。
- 对长文本进行忠实概括。
- 只选择最重要的 Evidence。
- 把完整细节链接到 Detail Report。
- 自由决定页面视觉、章节顺序和由宿主实现的查看完整依据交互。

摘要不要求：

- 238 个内部 Unit 逐字出现。
- 每个 Finding 单独占一个组件。
- 每项 Audit metadata 进入正文。
- 与详细报告拥有相同篇幅。

### 8.2 Summary Source Bundle

摘要模型读取一个冻结的、面向编辑的 Source Bundle：

```ts
interface EditorialSummarySourceV1 {
  version: 'editorial-summary-source-v1';
  binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    reportPackageArtifactId: string;
    reportPackageHash: string;
  };
  originalRequest: string;
  canonical: {
    title: string;
    directAnswers: unknown[];
    findings: unknown[];
    requestedArtifacts: unknown[];
    recommendations: unknown[];
    limitations: string[];
    openQuestions: string[];
    risks: unknown[];
  };
  evidence: unknown[];
  simulationMaterial: unknown[];
  detailAnchors: unknown[];
}
```

Source Bundle 不包含：

- 完整 Prompt。
- Credential。
- 敏感原始输入。
- Base64 资产。
- 未审校 Step 输出。

### 8.3 第一阶段：Editorial Strategy

真实 LLM 根据当前 Source Bundle 生成每份报告专属的编辑方案：

```ts
interface EditorialSummaryPlanV1 {
  version: 'editorial-summary-plan-v1';
  title: string;
  editorialThesis: string;
  decisionFrame: string[];
  storyArc: Array<{
    id: string;
    title: string;
    purpose: string;
    sourceIds: string[];
    suggestedVisualForm: string;
  }>;
  visualDirection: {
    thesis: string;
    typography: string;
    colorLogic: string;
    layoutLogic: string;
    interactionLogic: string;
  };
}
```

该 Plan 不限制：

- Hero 类型。
- 章节数量。
- 章节顺序。
- 组件种类。
- 配色。
- 字体。
- CSS 网格。
- SVG 图形。
- 交互提示形式；实际行为由宿主根据 `data-open-detail` 等安全标记实现，不由模型脚本实现。

它只能引用 Source Bundle 中已有的 source ID。

### 8.4 第二阶段：LLM Full HTML

LLM 读取 Source Bundle 和 Editorial Strategy，直接生成：

```text
完整 HTML
内联 CSS
可选内联 SVG
无 JavaScript、无内联事件属性、无运行时网络请求
打印样式
```

禁止在 Prompt 中出现：

- V1 的 HTML。
- V1 的 CSS。
- V1 的章节清单。
- 固定 Hero 指令。
- 固定组件 ID。
- 固定 DOM 树。
- “Matrix 必须位于第几章”等位置规则。

可以保留的仅是软性质量原则：

- 首屏或前段应快速建立核心判断。
- 不把所有内容做成同款卡片。
- 视觉形式应匹配比较、顺序、关系、优先级或证据边界。
- 页面应有一个明确视觉观点。
- 摘要必须能回到 Detail Report。

## 9. 摘要内容合同

### 9.1 不杜撰

摘要不得新增 Source Bundle 中不存在的：

- 事实。
- 数字和比例。
- 日期。
- 用户行为。
- 市场规模。
- 转化结果。
- 来源 URL。
- 确定性因果关系。

### 9.2 不提升证据等级

```text
supported → 可保持 supported
provisional → 必须保持 provisional 或更弱
simulation → 必须保持 simulation
unknown → 必须保持 unknown
```

### 9.3 摘要覆盖

摘要不做逐 Unit 原文覆盖，而检查以下最小语义覆盖：

- 每个 required question 至少出现一个直接答案。
- 每种 requested artifact 至少进入一个摘要章节或 Detail 链接。
- 每个摘要核心判断绑定 Canonical／Evidence source ID。
- 所有 P0 行动进入摘要。
- 关键 Risk 和 Simulation Disclaimer 必须出现。
- 未进入摘要的内容仍可通过 Detail Report 访问。

### 9.4 Coverage Manifest

摘要 HTML 的核心内容块携带：

```html
<section
  data-summary-section-id="decision-frame"
  data-source-ids="answer-q1 finding-001 recommendation-001"
  data-detail-section-ids="answers findings actions"
>
```

允许多个来源映射到一个摘要表达：

```text
Finding A
Analysis B
Summary C
Conclusion D
→ 一个完整摘要判断
```

这是语义合并，不是内容丢失。

## 10. Summary Fidelity Review

生成 HTML 后只做与摘要职责相关的检查。

### 10.1 必须检查

- 是否新增源外事实、数字或 URL。
- 是否改变 Evidence 状态。
- 是否遗漏 required question。
- 是否遗漏 requested artifact 的摘要入口。
- 是否遗漏 P0 行动。
- Simulation 是否有明确免责声明。
- Summary source ID 是否存在。

### 10.2 不检查

- 是否使用固定组件。
- 是否使用固定章节顺序。
- 是否使用固定 Hero。
- CSS 是否与 V1 相同。
- 是否逐字重复完整 Canonical。
- 是否满足某个案例的 DOM hash。

### 10.3 修订方式

发现遗漏时，只让 LLM 重写受影响章节：

```text
发现缺少 Risk
→ 定位负责决策边界的章节
→ 重写该章节
```

禁止：

```text
发现遗漏
→ 把所有未覆盖 Unit 追加到超长附件
```

最多允许一次定向修订。修订后仍不通过则 Summary 标记失败，不生成固定模板替代品。

## 11. 不模板化原则

### 11.1 V1 的正确使用方式

允许：

- 作为人工质量参考。
- 用于说明“决策优先、内容专属视觉、证据分层”的质量目标。
- 作为跨案例人工评审样本之一。

禁止：

- 把 V1 HTML 放入 Prompt。
- 从 V1 提取固定章节。
- 从 V1 提取固定 Hero。
- 把 V1 CSS 变成默认 Profile。
- 要求其他报告使用五阶段河流、Persona Matrix 或信任层级。
- 使用 V1 DOM hash 作为其他主题的验收标准。

### 11.2 固定内容与自由内容

| 固定 | 自由 |
|---|---|
| Canonical 事实 | 章节数量和顺序 |
| Evidence ID 与 URL | 页面骨架 |
| 状态和置信度 | Hero 或无 Hero |
| 数字和日期 | 字体、色彩和留白 |
| Report Set API 结构 | HTML 和 CSS |
| Summary／Detail 职责 | SVG 和宿主交互提示 |
| owner 鉴权 | 内容专属视觉隐喻 |

## 12. 生成时序

推荐时序：

```text
1. Canonical Deliverable SEALED
2. Final Review PASS
3. Detail Report ready
4. Task 完成
5. 发起 Editorial Summary 生成
6. Summary Store 原子封存
7. Report Set 返回 summary + detail 状态
```

Summary 可以采用 eager attempt + lazy recovery：

- Task 完成后立即尝试生成一次。
- 用户首次打开报告时，如果 Summary 尚未生成，则调用同一幂等生成服务。
- Request Key 相同只允许一个 Publication。
- Summary 失败不重新执行研究任务。

## 13. 失败策略

| 失败点 | 行为 |
|---|---|
| Canonical 或 Final Review 失败 | Task 暂停，不生成两份报告 |
| Detail Report 失败 | Task 暂停或失败 |
| Summary Editorial Plan 失败 | Summary failed，Detail ready |
| Summary HTML 失败 | Summary failed，Detail ready |
| Summary Fidelity 失败 | 定向修订一次，仍失败则 Summary failed |
| Summary Store 完整性失败 | 拒绝展示，允许独立重试 |

禁止跨报告 fallback：

- Summary 失败时不得把 Detail 包装成 Summary。
- Detail 失败时不得用 Summary 代替正式交付。
- 不得用固定 Showcase 模板伪装成 LLM Summary。

## 14. 前台交互

Report 页面使用两个一级视图：

```text
[编辑摘要] [完整报告]
```

### 14.1 编辑摘要

- 默认选中。
- 展示 LLM Full HTML。
- 提供下载 HTML 和打印。
- 核心判断提供“查看完整依据”入口。
- Summary 失败时显示明确错误和独立重试按钮。

### 14.2 完整报告

- 展示当前 ReportDocument／CurrentTextReport。
- 保留现有 Strategy Tabs、Evidence、Contribution 和审计信息。
- 保留 Markdown ZIP、离线 HTML 和结构化数据下载。

### 14.3 HTML 挂载

Web 读取同一份已验证 HTML，并通过隔离 Shadow DOM 挂载 Style 和 Body 节点：

- 不使用 iframe。
- 不构建第二套 React Summary Renderer。
- 下载和 Web 阅读使用相同 HTML 字节。
- Summary 中的 source link 可以切换到 Detail View。
- Web 挂载时继续移除 `script` 和内联事件属性作为防御性处理，但生成与 Store 校验已经拒绝这些内容。
- 下载和 Web 阅读使用同一份无脚本 HTML；Validator 禁止 `script`、内联事件、远程请求、远程资源、表单和危险 URL。

## 15. API

保留并语义化现有入口：

```text
GET /api/control-tasks/:taskId/reports/:attemptId/editorial-summary.html
```

详细报告继续使用：

```text
GET /api/control-tasks/:taskId/deliverable
GET /api/control-tasks/:taskId/reports/:attemptId/html-bundle
```

Current Deliverable Response 保持不变，确保完整报告可以立即读取。Summary 请求使用以下 HTTP 状态形成前台 Report Set：

```text
200：Summary ready
404：Task／Attempt 不存在或不属于当前 owner
409 editorial_summary_unavailable：模型或源数据不允许生成
409 editorial_summary_generation_failed：生成或 Fidelity 失败，可重试
409 editorial_summary_integrity：Sidecar 完整性失败
```

前台在请求期间显示 `working`，成功后显示 `ready`，失败后显示 `failed + retry`；不为 Summary 状态新增数据库行。所有报告入口继续要求 Task owner 鉴权。

## 16. Store 与幂等性

复用当前不可变 Editorial Store 的能力：

- Request Key 绑定 Task、Plan、Attempt、Canonical Package hash、Prompt 版本和模型配置。
- 请求级锁。
- 暂存目录原子重命名。
- `0700／0600` 权限。
- 读取时重新检查 Manifest 和所有文件 hash。
- 同一 Request Key 不产生第二份 Publication。

Summary Store 建议目录：

```text
run-workspaces/editorial-summary-reports/
  tasks/<taskId>/
    attempts/<attemptId>/
      summary-requests/<requestKey>/
        summary-ready/
          source-bundle.json
          editorial-plan.json
          report.html
          coverage.json
          fidelity.json
          manifest.json
```

## 17. 语言规则

Summary 和 Detail 均继承研究目标语言：

- 中文研究目标使用简体中文。
- 英文研究目标使用英文。
- 专有名词、缩写、Evidence ID 和来源原文可以保留原语言。
- 不在浏览器或 Renderer 中翻译内容。

## 18. 实施阶段

### Phase 1：Report Set 语义与前台命名

- 把当前“新版报告／结构化审计”改为“编辑摘要／完整报告”。
- Detail 继续使用当前报告。
- Summary 继续使用 owner-bound 独立 HTML。

完成条件：两个入口职责清楚，不互相替代。

### Phase 2：Summary Source Bundle

- 从 Reviewed Canonical、Evidence、Review 和 Detail Anchors 构造冻结 Source Bundle。
- 移除当前为完整展示服务的逐 Unit 页面投影要求。
- 保留 Claim、Evidence 和状态绑定。

完成条件：6 种 Deliverable 均可生成合法 Source Bundle。

### Phase 3：LLM Editorial Strategy

- 模型根据每份内容产生独立 Story Arc 和 Visual Direction。
- Prompt 中不包含 V1 HTML／CSS／章节。
- 记录真实模型身份和调用回执。

完成条件：跨 Deliverable 的章节和视觉方案存在实质差异。

### Phase 4：LLM Full HTML

- 模型直接输出 HTML、CSS 和可选 SVG；查看完整依据等行为由宿主根据安全标记实现。
- 生产摘要禁止 JavaScript、内联事件属性和运行时网络请求。
- 保存原始响应与最终 HTML hash。
- 不经过固定组件 Compiler 或固定视觉 Profile。

完成条件：报告可离线打开，且不同内容不会产生同构页面。

### Phase 5：Summary Fidelity

- 校验杜撰、Evidence 状态、required question、requested artifact、P0 和 Simulation Disclaimer。
- 只允许一次定向章节修订。
- 禁止把遗漏内容统一追加到大型附件。

完成条件：摘要通过 Fidelity，且 Detail 内容始终可访问。

### Phase 6：Report Set UI

- 默认展示编辑摘要。
- 完整报告可一键切换。
- Summary source link 可以定位 Detail。
- 两份报告分别下载。

完成条件：1440×900 下无页面级横向溢出，阅读路径清晰。

### Phase 7：12 路径验证

运行：

```text
6 Deliverable × 2 Orchestration Mode
```

至少执行：

- 一条真实中文单 Skill 任务。
- 一条真实中文多 Skill 任务。
- 其余使用冻结、已审校的真实 Fixture。

## 19. 测试要求

### 19.1 Detail Report

- Canonical 完整性。
- Evidence 完整性。
- 全部 requested artifact。
- Contribution Sidecar。
- 历史读取。

### 19.2 Summary Report

- 不同主题产生不同章节签名。
- 不同内容关系产生不同视觉形式。
- 不得固定 Hero。
- 不得固定章节顺序。
- 不得出现 V1 案例关键词规则。
- 不得新增源外数字和 URL。
- required question 全部有摘要入口。
- P0 行动全部出现。
- simulation 内容有持续免责声明。
- Summary HTML 不包含 `script`、内联事件属性或运行时网络请求。
- 下载与 Web 阅读使用同一份无脚本字节。

### 19.3 UI

- 编辑摘要默认选中。
- 完整报告可切换。
- Summary failed 不影响 Detail。
- Shadow DOM 无样式泄漏。
- 下载 HTML 与 Web 使用同一 hash。
- 1440×900 无横向溢出。

### 19.4 回归

- Plan v2／v3 不变化。
- Canonical 和 Review 合同不变化。
- Report Package 继续可读。
- Markdown ZIP 不变化。
- 历史 Task 不自动回填。

## 20. 验收标准

### 20.1 功能

- 每个新 Task 都能看到“编辑摘要／完整报告”。
- 6 种 Deliverable 全部支持两份报告。
- 两种编排模式使用同一双报告规则。
- Summary 失败时 Detail 仍然可用。

### 20.2 内容

- Detail 完整保留 Canonical。
- Summary 不杜撰数据。
- Summary 不改变 Evidence 状态。
- Summary 的关键判断可以定位 Detail。
- Summary 允许概括，不要求逐 Unit 复述。

### 20.3 视觉

跨案例至少满足：

- 首屏形式不是固定的。
- 章节数量和顺序不是固定的。
- 同类内容不强制使用同一视觉组件。
- 视觉方向与当前报告内容有关。
- 不出现统一卡片墙。
- 不复制 V1 DOM 或 CSS。

### 20.4 工程

- `pnpm quality` 通过。
- Web Production Build 通过。
- 中文标点检查通过。
- `git diff --check` 通过。
- 单／多 Skill 真实任务各通过一条。

## 21. 回滚策略

Summary Pipeline 出现问题时：

- 停止生成新的 Summary Publication。
- 保留 Canonical 和 Detail Report。
- Web 默认切换到完整报告并显示 Summary 暂不可用。
- 不删除已封存 Summary。
- 不修改历史 Task。
- 不回滚数据库。

## 22. Definition of Done

- [x] Report 页面提供“编辑摘要／完整报告”。
- [x] Summary 使用真实 LLM 自由生成 HTML。
- [x] Summary 不依赖固定 Profile、组件和章节模板。
- [x] Detail 继续完整呈现当前 Canonical 内容。
- [x] Summary 与 Detail 共享同一个事实源。
- [x] Summary Claim 可以定位 Detail 和 Evidence。
- [x] Summary Fidelity 只约束杜撰、状态和关键覆盖。
- [x] Summary 失败可独立重试，不影响 Detail。
- [x] 6 种 Deliverable 自动化通过。
- [x] 单／多 Skill 两种模式自动化通过。
- [x] 至少一条真实单 Skill 和一条真实多 Skill 通过。
- [x] 1440×900 验收通过。
- [x] 最终质量门禁通过。
- [x] 未经授权未 stage、commit、merge、push 或部署。

## 23. 实施参考

V1 质量参考：

```text
run-workspaces/direct-llm-html-reports/tasks/
  035aac9f-f375-4392-bf49-13ceb6d45765/
  attempts/9f040934-3e3d-4ace-b4d5-64f513813bd7/
  direct-html-v1/report.html
```

参考它的：

- 决策优先。
- 内容专属叙事。
- 不同内容使用不同视觉形式。
- 证据状态参与视觉编码。
- 摘要与详细依据分层。

不得参考它的：

- 具体章节名称。
- 页面顺序。
- CSS。
- Hero。
- Persona Matrix。
- 五阶段河流。
- 京东众筹案例文案。

## 24. 本地实施与验收记录

### 24.1 当前实现

- 新增 `EditorialSummarySource`，从 Reviewed Canonical、Final Review 和冻结 Requirement 投影生成无模板语义源。
- 新增 `EditorialSummaryGenerator`，执行 Editorial Plan、Full HTML、Fidelity Review 和最多一次定向修订。
- 新增不可变 `EditorialSummaryStore`，包含请求锁、孤儿锁回收、原子发布、owner-only 权限、hash 复核和读取时 HTML 重验。
- 正式 API 改为 owner-bound `editorial-summary.html`，原 `editorial-showcase.html` 不再提供生产入口。
- Stage 4 默认展示“编辑摘要”，保留“完整报告”；摘要失败不会覆盖或隐藏完整报告。
- Web 通过 Shadow DOM 展示同一份无脚本 HTML，并保留移除脚本和内联事件属性的防御性处理；下载使用同一 HTML 字节。

### 24.2 真实单 Skill

```text
Task：035aac9f-f375-4392-bf49-13ceb6d45765
Attempt：9f040934-3e3d-4ace-b4d5-64f513813bd7
Publication：esrp_933a3ca5b29b4b7a92a2b4dd2e0d463e976e786bd1d4d52a59129e6ec4f61d17
HTML：sha256:ca80ce9e686a5596c2703fcb4c117ff2eb9ec441e25d3a8cd68fbab589dbfa18
Fidelity：pass
Required Questions：5／5
Requested Artifact Groups：6／6
P0 Groups：2／2
1440px Scroll Width：1440
```

### 24.3 真实多 Skill

```text
Task：355d42d2-8f45-4f9d-9366-715ed9e5c7ad
Attempt：c5b3aa25-2857-436b-a812-31f174977e2c
Publication：esrp_40030555ae557b437d17a246f63961749af46cd2b345c279fde0d95bec295e50
HTML：sha256:4c36f457709ddaa4a9a1c0a88a65b8b5236ac1e3aa3c5318e766067765684311
Fidelity：pass
Required Questions：4／4
Requested Artifact Groups：10／10
P0 Groups：2／2
1440px Scroll Width：1440
```

### 24.4 工程门禁

```text
Tests：2262
Passed：2244
Skipped：18
Failed：0
Typecheck：pass
Registry lint：pass
Knowledge lint：pass
Web Production Build：pass
中文标点：pass
git diff --check：pass
Staged files：0
```
