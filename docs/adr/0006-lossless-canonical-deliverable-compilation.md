# ADR-0006：Step 10 采用无损 Canonical 编译与 Typed Patch 修复

- 状态：Accepted
- 日期：2026-08-24
- 上游决策：ADR-0004、ADR-0005

## 背景

答案型研究任务的 Steps 3–9 已产生并审校语义内容。Step 10 负责把 Step 8 Content Draft 编译为 Canonical Deliverable，并生成 Evidence、FindingGraph、Coverage、Risk 与 Requested Artifact 绑定。

真实运行暴露出：完整 Draft repair 为修复一个 Question/Evidence 绑定时可能重写其他正文，导致内容压缩、ID 漂移或新的事实根错误。严格合同本身不是问题；问题是结构修复仍拥有全文改写权。

## 决策

1. 保留 Step 10，定位为无损 Canonical 编译器和真实性门禁，不是报告作者。
2. 为 Step 8 Draft 建立语义内容单元清单和 hash；Question/Evidence/support 等系统可修字段不进入语义 hash。
3. 结构修复只接受 `research-strategy-content-patch-v1`：允许修 support、追加缺失请求内容和追加风险，不允许修改、删除或重排已有语义内容。
4. 最终语义修订同样使用显式 Patch；每个正文修改必须声明稳定目标，未被指向的内容保持不变。
5. Canonical → ReportDocument 除顶层 Pointer Coverage 外，还校验每个 Direct Answer、Finding 和 Block leaf 的投影覆盖。
6. Layout 继续只改变分组和顺序；遗漏、重复或非法 Blueprint 使用 deterministic fallback。
7. 硬失败时保留非 Canonical、不可导出的 Reviewed Draft Preview，不能伪装为正式报告。
8. `deliverable_validation` 重试在 Plan 和 Artifact lineage 全部一致时使用 terminal rebuild，复用已 SEALED 的计划输出；不满足条件时回退完整执行。

## 硬失败边界

以下错误继续 fail closed：

- Artifact 完整性、归属或安全失败；
- supported 事实没有已验证 Evidence；
- 未知且无法唯一规范化的 Question/Evidence；
- Required Question 或 requested artifact 确实缺少内容；
- Reviewer block；
- Patch 删除内容、越权修改语义或引用白名单外来源。

格式、布局、安全可判定的 ID 漂移和可从同 Question 已验证来源恢复的 provisional binding 不阻断交付。

## 结果

### 收益

- 结构修复不能再压缩全文；
- 每个内容改动有稳定目标和审计记录；
- Canonical 与最终 ReportDocument 的内容集合可机器校验；
- Step 10 重试不再默认重复消耗 Steps 1–9；
- 失败时用户仍能看到已审校内容摘要，但不能误发布。

### 成本

- 新增内容指纹、Patch Schema、Patch Applier 和 fidelity diagnostic；
- terminal rebuild 需要严格复用 lineage；
- Semantic Review 需要输出显式修改操作，不再能返回整份 Draft。

## 被拒绝的方案

### 删除 Step 10

拒绝。会失去 Evidence Manifest 约束、Coverage、FindingGraph、风险传播和 Canonical Artifact 边界。

### 保留全文 repair，只靠 Prompt 要求“不要删内容”

拒绝。Prompt 不能形成可机器验证的删除和改写权限边界。

### 直接拼接 Steps 3–7 原文

拒绝。中间产物含重复、冲突和未经最终审校的内容，会破坏 Canonical Deliverable 的真相源地位。

## 兼容与回滚

- Payload v1/v2、ReportDocument v1/v2 reader 不变；
- Patch Schema 仅为内部模型合同；
- 不修改历史 SEALED Artifact；
- 不需要数据库 Migration；
- 可分别回滚 fidelity gate、typed patch、semantic projection coverage 和 terminal rebuild；
- 回滚不得删除已经写入的诊断 Artifact。

## 关联方案

- `docs/plans/2026-08-24-step10-lossless-canonical-compilation-development.md`
