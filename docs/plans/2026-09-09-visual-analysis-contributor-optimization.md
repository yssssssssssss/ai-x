# Visual Analysis Contributor 优化开发方案

> 日期：2026-09-09
> 状态：最小版本已实现并完成定向验证
> 目标：把现有视觉实验室能力接入正式 Industry 主链，同时保留当前 Task、Evidence、Canonical 和双报告合同。

## 1. 背景

近期完成了一次京东与淘宝真皮电动沙发商品详情页分析：

```text
京东连续截图 5 张
淘宝连续截图 5 张
Vision Brand Lab 三角色评审
Attention Analysis 逐图分析
Aesthetic Quant 逐图分析
Experience Model Lab 方法选择
人工汇总为独立 HTML 与 Evidence JSON
```

该案例证明，项目已有足够的视觉分析能力，可以完成：

- 多张长截图分批处理。
- 京东与竞品使用相同口径对照。
- 视觉层级、注意力竞争和遮挡诊断。
- 价格权益、评价信任和家具决策链分析。
- 从问题到设计动作、品类资产和衡量方法的推导。

但这套能力目前依赖操作者手工启动工具、组织批次和汇总结果，没有进入正式 Task 执行链。

当前正式 Industry 流程能够接收：

```text
jd_screenshots
competitor_screenshots
competitor_platform_names
```

但 `orchestrator/skill-executions/industry-market-analysis.yaml` 中没有稳定的视觉 Tool Stage。截图主要在最终 Industry Draft 阶段被消费，没有先形成标准化 Visual Contribution。

同时，`design-experience-review` 已声明依赖：

```text
aesthetic-quant-lab
attention-analysis-lab
vision-brand-lab
```

但 Registry 仍限制为：

```text
modes: [standalone]
```

原因也已写明：

```text
Multi-lab visual review payload is not yet mapped to stable Contribution units.
```

本方案只解决这个连接点。

## 2. 结论

将多实验室视觉分析建设为一个可复用的领域基础能力：

```text
Visual Analysis Suite Tool
→ design-experience-review Skill
→ research-contribution-v1
→ Industry Synthesizer
→ 现有 Industry Canonical
```

基础能力只负责提取和归一化视觉观察，不包含家具、图书、美妆等品类规则。

品类语义继续由：

```text
Task Requirement
Industry Knowledge
Industry Synthesizer
```

共同决定。

## 3. 范围

### 3.1 本次建设

- 支持京东与竞品多张截图批量分析。
- 统一调用 Vision Brand、Attention、Aesthetic 三套现有工具。
- 输出稳定、可验证的 Visual Analysis Tool Result。
- 把 Visual Result 确定性转换为 `research-contribution-v1`。
- 让 `design-experience-review` 支持 Contributor 模式。
- 让 Multi Skill Industry 在有截图时选择该 Contributor。
- 没有截图时不选择，不生成空分析。
- 单个实验室失败时保留显式 Gap，其余结果继续可用。
- 所有视觉判断保持 provisional，不提升为市场、用户或经营事实。

### 3.2 不建设

本次明确不增加：

- 新 Task Type。
- 新 Deliverable。
- 新数据库表。
- 新外部服务。
- 新报告审核层。
- 新规则引擎。
- 沙发专属 Schema。
- 家具专属字段。
- 报告模板重写。
- 旧数据迁移或兼容分支。
- 自动替代真实眼动或用户研究的结论。

下列内容继续由具体任务决定，不写入基础能力：

- 尺寸、座深、靠墙距离。
- 皮质、填充和电机。
- 入户、安装与售后。
- 图书内容心智。
- 美妆试色和功效证明。
- 具体 P0 策略。
- 报告使用几个 Tab。

## 4. 设计原则

### 4.1 一个深 Module

新增一个深 Module：

```text
VisualAnalysisSuiteAdapter
```

Interface：

```text
输入
- primaryImages
- comparisonImages
- researchGoal
- questionIds

输出
- normalizedSamples
- comparisonFindings
- warnings
- boundaryNotes
- toolProvenance
```

调用者不需要知道：

- 每套实验室的请求格式。
- 图片如何分批。
- Vision Brand 每批最多处理几张。
- Attention 和 Aesthetic 如何逐图调用。
- 工具结果如何对齐到截图 ID。
- 单个实验室失败后如何降级。

### 4.2 复用现有合同

Visual Analysis 不新增独立 Canonical。

输出继续使用：

```text
research-contribution-v1
contribution_type = design_audit
```

Industry Synthesizer 继续映射到：

```text
jdDiagnosis
competitorAnalysis
gapMatrix
opportunities
strategyChains
categoryAssets
measurementPlan
```

### 4.3 视觉结果不是业务事实

下列结果只能作为视觉观察或设计推断：

```text
注意力热点
美学分数
视觉复杂度
VLM 问题判断
品牌联想度
```

不得据此声称：

```text
转化提升
用户一定关注
市场偏好
真实眼动结果
AB 收益
```

所有 Visual Contribution Unit 默认：

```text
status = provisional
validationNeeded = 真实用户任务测试、行为数据或人工设计评审
```

## 5. 目标流程

```text
用户声明可提供截图
        │
        ▼
Stage 2 上传图片
        │
        ▼
Visual Input Gate
- Owner Binding
- Task Binding
- Plan Binding
- 文件 Hash
- Visual Asset
        │
        ▼
Visual Analysis Suite
- Vision Brand 批量评审
- Attention 逐图分析
- Aesthetic 逐图分析
        │
        ▼
Normalized Visual Result
- 每张图稳定 Sample ID
- 京东 / 竞品角色
- 页面阶段
- Issues
- Scores
- Warnings
        │
        ▼
design-experience-review
        │
        ▼
Research Contribution
- source screenshot Evidence
- provisional findings
- questionIds
- validationNeeded
        │
        ▼
Industry Synthesizer
        │
        ▼
现有 Canonical / Review / Detail / Summary
```

## 6. Tool Interface

### 6.1 Input

新增 Tool：

```text
visual-analysis-suite
```

建议输入：

```json
{
  "researchGoal": "分析商品详情页并形成改版建议",
  "primaryImages": [
    {
      "sampleId": "JD-1",
      "assetId": "visual-asset-id",
      "dataUrl": "data:image/jpeg;base64,..."
    }
  ],
  "comparisonImages": [
    {
      "sampleId": "TB-1",
      "assetId": "visual-asset-id",
      "dataUrl": "data:image/jpeg;base64,..."
    }
  ]
}
```

约束：

- 每组最多 10 张。
- 只接受 Visual Input Gate 验证后的图片。
- `sampleId` 在请求内唯一。
- 不接受远程任意 URL。
- 不持久化原始 Base64 到日志或错误信息。

### 6.2 Output

```json
{
  "version": "visual-analysis-suite-v1",
  "status": "available",
  "samples": [
    {
      "sampleId": "JD-1",
      "role": "primary",
      "assetId": "visual-asset-id",
      "aesthetic": {
        "status": "available",
        "overallScore": 0.67
      },
      "attention": {
        "status": "available",
        "focusBalanceScore": 0.68,
        "distractionRiskScore": 0.55,
        "hotspots": []
      },
      "visualReview": {
        "status": "available",
        "issues": []
      }
    }
  ],
  "comparisonFindings": [],
  "warnings": [],
  "boundaryNotes": [
    "注意力结果不是眼动实验",
    "视觉分数不是转化结果"
  ]
}
```

Output 只做一次 Schema 校验，不在 Tool、Skill 和 Synthesizer 三处重复校验同一字段。

## 7. 批量与失败策略

### 7.1 图片分批

复用沙发案例已验证的最小策略：

```text
Vision Brand
- 每批最多 3 张
- 同角色图片保持原顺序

Attention
- 每张图一次

Aesthetic
- 每张图一次
```

Tool Result 按原始 `sampleId` 重排，不依赖请求完成顺序。

### 7.2 部分失败

```text
三套工具都成功
→ status = available

至少一套成功
→ status = partial
→ 写明缺失工具和对应 Sample

三套工具都失败
→ status = unavailable
→ 形成一个 Visual Analysis Gap
→ Industry 仍可使用截图本身与其他 Evidence
```

不执行：

- 静默使用旧 Cache。
- 把启发式结果冒充 VLM。
- 因品牌参考图缺失而阻断视觉诊断。
- 自动重试整个 Industry Task。

## 8. Contribution Mapping

在现有 `ContributionAdapterRegistry` 增加一个确定性 Adapter：

```text
visual-analysis-contribution-v1
```

映射规则：

```text
每个 Sample Issue
→ 一个 Contribution Unit

每个 Cross-platform Finding
→ 一个 Contribution Unit

Tool Warning / Boundary
→ Contribution limitation
```

每个 Unit 保留：

```text
sourceArtifactId
sourceJsonPointer
sourceSemanticHash
screenshot Evidence ID
questionIds
status = provisional
validationNeeded
```

Adapter 不做：

- 改写 Issue 文案。
- 合并不同 Sample 的问题。
- 根据分数自动判断 P0 / P1。
- 把 Aesthetic Score 当作 confidence。
- 生成家具、图书或美妆专属策略。

优先级和品类语义继续由 Industry Synthesizer 处理。

## 9. Skill 与 Registry 调整

### 9.1 design-experience-review

从：

```text
modes: [standalone]
```

调整为：

```text
modes: [standalone, contributor]
compatible_deliverables:
- design_audit_report
- industry_market_analysis_report
contribution_types:
- design_audit
contribution_adapter: visual-analysis-contribution-v1
```

输入复用当前标准角色：

```text
jd_screenshots
competitor_screenshots
research_goal
```

不新增 `sofa_screenshots`、`book_screenshots` 等品类角色。

### 9.2 Industry Portfolio

选择条件：

```text
available_material_roles 包含 jd_screenshots
或 competitor_screenshots
```

没有截图时：

```text
不选择 design-experience-review
不创建空 Visual Contribution
不改变 Task 模式
```

有截图时：

```text
Visual Analysis Suite
→ design-experience-review Contributor
→ Industry Synthesizer
```

## 10. Single 与 Multi

### 10.1 本次最小版本

本次优先完成 Multi Skill Industry：

```text
Visual Contributor
→ Contribution Ledger
→ Industry Synthesizer
```

原因：当前最明确的缺口就是多实验室结果无法进入 Portfolio Contribution。

Single Skill Industry 保持现有截图分析能力，不在本次复制一套 Tool Stage。

### 10.2 后续可选扩展

只有 Multi 路径稳定后，再评估让 Single Skill 复用同一 `visual-analysis-suite` Tool。

扩展时仍必须保持：

```text
CurrentExecutionPlan v2
skill_invocations.length = 1
skill_id = industry-market-analysis
```

Single 内部可以调用 Tool，但不能隐藏第二个 Skill。

该扩展不属于本次交付，不提前添加 mode 分支或兼容代码。

## 11. Canonical 与报告

不修改 Industry Payload Schema。

Visual Contribution 继续进入现有字段：

```text
京东视觉问题
→ jdDiagnosis

竞品视觉差异
→ competitorAnalysis

跨平台 Gap
→ gapMatrix

设计机会
→ opportunities

可复用视觉语言
→ categoryAssets

修改动作
→ strategyChains
```

Detail 和 Editorial Summary 继续消费唯一 Canonical。

本次不把参考 HTML 作为 Runtime 模板，也不增加固定 6 Tab 合同。参考报告只用于人工判断信息层级和内容职责。

## 12. 文件改动

### 12.1 新增文件

控制在 5 个：

```text
apps/orchestrator-runtime/src/runtime/visual-analysis-suite-adapter.ts
tools/visual-analysis-suite/manifest.yaml
tools/visual-analysis-suite/input.schema.json
tools/visual-analysis-suite/output.schema.json
orchestrator/skill-executions/design-experience-review.yaml
```

### 12.2 修改文件

```text
apps/agent-api/src/control-runtime.ts
apps/orchestrator-runtime/src/runtime/tool-adapter.ts
apps/orchestrator-runtime/src/skills/contribution-adapter-registry.ts
orchestrator/tool-registry.yaml
orchestrator/skill-registry.yaml
orchestrator/deliverable-registry.yaml
orchestrator/planning-capability-crosswalk.yaml
```

测试只修改现有测试文件，不新增测试框架或测试目录。

该改动超过 5 个文件，但没有新增服务、数据库或交付物。复杂度集中在一个 Adapter 和一个 Contribution Mapping 中，没有再增加一层编排系统。

## 13. 实施步骤

### 阶段 1：Visual Analysis Suite

- 定义 Tool Input / Output Schema。
- 实现批量调用和稳定 Sample 对齐。
- 接入现有三个实验室 URL。
- 输出 partial / unavailable 和边界说明。
- 在 Tool Registry 注册为 optional Tool。

阶段 1 完成后，Tool 可以独立接收图片并输出稳定结果。

### 阶段 2：Visual Contributor

- 为 `design-experience-review` 增加 compiled Execution Contract。
- Tool Stage 调用 Visual Analysis Suite。
- Skill Output Stage 只负责形成标准 Skill Envelope。
- Contribution Adapter 确定性映射 Visual Result。
- 增加 Industry compatibility。

阶段 2 完成后，Design Audit 和 Multi Industry 都能消费同一 Visual Contribution。

### 阶段 3：Industry 接线

- 有截图时生成 `design_audit` Demand。
- Planner 选择 `design-experience-review`。
- 同一截图只上传一次并绑定 Visual Contributor 和 Synthesizer。
- Industry Canonical 继续使用现有 Mapping。
- 无截图时保持当前行为。

阶段 3 完成后，正式 Multi Industry 可以复现沙发案例的视觉分析深度。

## 14. 最小验证

只保留四项与本功能直接相关的验证。

### 14.1 Tool Adapter

一个测试覆盖：

```text
2 张京东图
2 张竞品图
Vision Brand 批量
Attention / Aesthetic 逐图
一个实验室失败后 status = partial
Sample 顺序与 Artifact Binding 不变
```

### 14.2 Contribution Adapter

一个测试覆盖：

```text
每个 Visual Issue 恰好映射一个 Unit
Screenshot Evidence 保留
status 固定 provisional
Tool Warning 进入 limitations
不产生家具专属字段
```

### 14.3 Planning

一个测试覆盖：

```text
有截图
→ 选择 design-experience-review

无截图
→ 不选择 design-experience-review

Industry Synthesizer 仍恰好一个
```

### 14.4 真实验收

只运行一次受控案例：

```text
京东截图 2 张
淘宝截图 2 张
Multi Skill Industry
Visual Contribution SEALED
Contribution Ledger 有映射
Canonical 中出现对应 jdDiagnosis / competitorAnalysis
```

不要求：

- 重跑 5 个品类。
- 10 份报告 corpus。
- 全量视觉回归。
- 新增 Final Reviewer。
- 为每个 Tool 分别增加 E2E。
- 重复 Single 和 Multi 真实 Smoke。

## 15. 验收标准

```text
1. design-experience-review 可以作为 Industry Contributor。
2. 京东与竞品截图采用相同视觉分析口径。
3. 每张图都有稳定 Sample ID 和 Screenshot Evidence。
4. 三实验室结果被封装为一个 Tool Result。
5. Visual Contribution 全部保持 provisional。
6. Industry Canonical 可以追溯到 Visual Contribution 和截图。
7. 没有截图时不增加步骤和 Gap 噪音。
8. Tool 不可用时 Industry 仍可 completed_with_gaps。
9. 不增加新 Task Type、Deliverable、数据库表和审核层。
10. 只通过四项定向验证完成验收。
```

## 16. 风险与回滚

### 16.1 外部实验室不可用

行为：

```text
Visual Analysis Suite = unavailable
记录 Visual Gap
Industry 使用截图本身、公开证据和其他 Contributor 继续
```

### 16.2 图片数量或体积过大

行为：

```text
在 Tool Input 边界拒绝
不启动任何实验室调用
不部分写入 Tool Artifact
```

继续复用当前 Visual Input Gate 的文件限制，不新增第二套上传限制。

### 16.3 结果不稳定

行为：

```text
所有结论保持 provisional
保留工具身份和执行时间
最终策略仍由 Industry Review 判断
```

不增加多数投票或额外 Reviewer。

### 16.4 回滚

回滚只需要：

```text
将 visual-analysis-suite 标记为 draft
将 design-experience-review 移除 Industry compatibility
```

不涉及数据迁移，也不改变历史 Artifact 的可读性。

## 17. 最脆弱假设

本方案假设三个视觉实验室在部署 Runtime 中可稳定访问，并接受受控 Data URL 输入。

如果该假设不成立：

- Visual Analysis Suite 输出 unavailable。
- Industry 保持现有截图分析路径。
- Task 形成显式 Visual Gap。
- 不阻断其他 Evidence 和报告生成。

因此该假设失败只影响视觉分析深度，不影响 Industry 基础可用性。

## 18. 后续明确不做

在本方案完成前，不开展：

- Visual Tool 的平台化工作流编辑器。
- 任意数量图片的动态 DAG。
- 自动生成高保真 UI 稿。
- 自动发布设计规范。
- 用视觉分数预测转化率。
- 视觉结果跨 Task Cache。
- 品牌 Embedding 平台。
- 报告模板市场。

这些能力只有出现独立用户需求后再评估。

## 19. 实施结果

已完成：

- `visual-analysis-suite` Tool 与批量 Adapter。
- `design-experience-review` Compiled Skill Contract。
- `visual-analysis-contribution-v1` 确定性 Contribution Adapter。
- Multi Skill Industry 截图条件路由。
- Screenshot Evidence 在 Contribution 生成阶段的绑定。
- Tool 不可用时的 partial / unavailable 显式降级。

定向验证：

```text
TypeScript：通过
相关合同、规划与视觉测试：通过
真实 Tool 2+2 截图：4 张均完成 Aesthetic 与 Attention，2 个 Vision Review Batch 可用
真实结果：3 个对照指标，10 次底层 Tool 调用，25 个 provisional Contribution Unit
```

真实验收中的 Vision 与 Attention 明确返回 `engine = heuristic`。该结果只证明真实服务调用、批量归一化和 Contribution 映射可用，不冒充真实 VLM、真实用户或眼动研究。

按本方案的最小验证约束，没有追加完整 Industry LLM Smoke、Corpus、Canary 或新审核流程。
