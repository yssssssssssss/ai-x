---
id: ux-method-experience-diagnosis-framework
type: analysis
title: 体验问题诊断与走查框架
domain:
  - 通用
tags:
  - general-ux
  - experience-diagnosis
status: candidate
sensitivity: internal
owner: user-research-hub-maintainers
source: user-research-hub
source_path: methods/toolbox/analysis/design-strategy/ux-method-experience-diagnosis-framework.md
hub_snapshot_id: user-research-hub-2026-08-21
hub_source_path: wiki/user-research/03-knowledge-知识/方法知识/通用体验/体验问题诊断与走查框架.md
hub_source_hash: sha256:25717b7e1c2ad1c41c56c67ad93697beb1632dcc58405508f3f1cc3c3bb9bab7
distribution_scope: evaluation_only
retention: through-gate-3-or-revocation
source_rights: cleared_internal_reuse
managed_by: user-research-hub-integration-v1
content_hash: sha256:d3bf69dcf479e6adecb3fb5f4cc02c9600fd6daf75cf0bc149631bbf84ee8c26
summary: 本文件提供跨场域可复用的体验问题诊断框架，用于页面走查、链路诊断、根因拆解和方案生成。它不替代具体场域知识，也不提供京东内部业务规则。
guide_tags:
  - method
  - design-strategy
  - ux-audit
guide_stage:
  - method-selection
capability_domain:
  - user-research
  - design-strategy
business_domain:
  - general
task_types:
  - experience-walkthrough
  - root-cause-analysis
  - solution-generation
  - trend-change-identification
evidence_types:
  - user_input
  - screenshot
  - derived
---

# 体验问题诊断与走查框架

## 定位

本文件提供跨场域可复用的体验问题诊断框架，用于页面走查、链路诊断、根因拆解和方案生成。它不替代具体场域知识，也不提供京东内部业务规则。

## 诊断维度

| 维度 | 关注问题 | 常见证据 | 后续动作 |
|---|---|---|---|
| 目标匹配 | 页面或流程是否服务用户当前任务 | 用户目标、业务目标、入口语境 | 明确主任务和次任务 |
| 信息理解 | 用户是否能快速理解对象、状态、规则和下一步 | 标题、说明、状态、价格/权益/履约信息 | 降低理解成本、统一语义 |
| 操作连续 | 任务是否被中断、重复确认或来回跳转 | 流程步骤、弹层、返回路径、确认动作 | 简化链路、减少跳转 |
| 反馈明确 | 操作后系统是否给出及时、明确、可行动反馈 | 成功/失败/等待/异常态 | 补足状态反馈和错误恢复 |
| 风险可控 | 是否存在误解、误操作、信任或规则风险 | 用户反馈、投诉、异常数据、规则说明 | 转人工确认或补充验证 |
| 主次秩序 | 页面信息、组件和动作是否主次清晰 | 视觉层级、位置、密度、遮挡 | 调整层级和信息密度 |

## 使用方式

1. 先读取当前项目资料，明确页面、链路或模块边界。
2. 若有场域，读取对应场域基础知识和模块定义。
3. 用本框架扫描 6 个诊断维度。
4. 每条问题必须绑定输入材料中的证据或标注为假设。
5. 涉及价格、库存、履约、交易规则、合规和业务政策时转人工确认。

## 输出建议

```markdown
| 位置/环节 | 问题类型 | 证据 | 影响 | 置信度 | 下一步 |
|---|---|---|---|---|---|
```

## 边界

- 不能凭本框架推断具体业务规则。
- 不能替代真实用户研究、数据分析或上线验证。
- 无项目材料时，只能输出检查清单和待补输入。

## 适用条件

- 输入包含用户、触点与已有研究材料，且研究问题与本方法的目标一致。
- 若缺少必需材料，先记录缺口，不以知识库内容替代当前事实。

## 输入

- 已确认的研究目标、范围、约束和成功标准。
- 与本方法相关的可追溯用户输入、公开来源、截图、数据或既有证据。

## 执行步骤

1. 冻结研究问题、分析对象和证据边界。
2. 按本卡片正文中的维度或模型整理输入，并逐项保留来源引用。
3. 区分观察事实、分析推断和待验证假设。
4. 形成结构化输出，检查覆盖、冲突、缺口和不可照搬边界。

## 输出

- 与正文模板一致的结构化分析结果。
- 来源引用、证据缺口、风险和后续验证项。

## 常见误用

- 把方法或案例当作当前业务事实。
- 为填满模板而编造数据、用户结论或竞品能力。
- 忽略样本、时间、场景和证据适用范围。

## 证据边界

知识库只提供方法依据。当前用户、竞品和业务事实必须来自本次用户输入或可复查证据；无法核验的内容只能标为假设或缺口。

## 验证方式

- 检查每项事实是否有来源，每项推断是否引用事实，每项建议是否给出指标或验证方法。
- 使用第二来源、反例或人工复核验证关键结论；不能验证时明确降级。
