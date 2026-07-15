# assets/question-bank/ · 题库

> 现成可复用的**题**：访谈题、问卷题、筛选题。按 `method_family`（interview / survey）再按 7 主题组织，每个主题一个文件。
> **来源**：从历史项目的访谈/问卷提纲录入——去重、去项目化（占位符）、按主题聚合而来。
> **下游**：`generate-interview-guide` / `generate-survey` 组装提纲时来这里取现成题。

## 7 主题（interview / survey 同一套）

| 主题 | 中文 | 收什么 |
|---|---|---|
| `screener-demographics` | 筛选与背景 | 甄别、个人/家庭/工作/消费基础信息、暖场 |
| `behavior-habits` | 行为与习惯 | 现状行为、频率、平台使用、消费习惯、趋势 |
| `needs-scenarios` | 需求与场景 | 触发场景、动机、"什么情况下会…"、场景差异 |
| `mindset-cognition` | 心智与认知 | 概念理解、判断标准、品牌/平台认知与态度 |
| `decision-journey` | 决策与链路 | 种草→搜索→比价→关注因素→排序→下单 |
| `experience-painpoints` | 体验与痛点 | 使用/购买/售后的不满、阻碍、卡点 |
| `concept-test` | 概念与方案评估 | 功能设想评估、名称测试、脑暴、优化期待 |

主题定义与边界、占位符约定见本目录各主题文件开头的说明。

## 题组清单

### interview/（访谈题）

| 文件 | 主题 | domain | 何时用 | status |
|---|---|---|---|---|
| [interview/screener-demographics.md](interview/screener-demographics.md) | 筛选与背景 | 通用 | 甄别/暖场/背景信息 | draft |
| [interview/behavior-habits.md](interview/behavior-habits.md) | 行为与习惯 | 通用 | 摸现状行为/频率/渠道 | draft |
| [interview/needs-scenarios.md](interview/needs-scenarios.md) | 需求与场景 | 通用 | 挖触发场景与动机 | draft |
| [interview/mindset-cognition.md](interview/mindset-cognition.md) | 心智与认知 | 通用 | 探判断标准/品牌平台认知 | draft |
| [interview/decision-journey.md](interview/decision-journey.md) | 决策与链路 | 通用 | 还原购买决策全链路 | draft |
| [interview/experience-painpoints.md](interview/experience-painpoints.md) | 体验与痛点 | 通用 | 挖使用/购买痛点阻碍 | draft |
| [interview/concept-test.md](interview/concept-test.md) | 概念与方案评估 | 通用 | 测方案/功能/名称/机会点 | draft |

### survey/（问卷题）

| 文件 | 主题 | domain | 何时用 | status |
|---|---|---|---|---|
| [survey/screener-demographics.md](survey/screener-demographics.md) | 筛选与背景 | 通用 | 甄别逻辑/人口信息题 | draft |
| [survey/behavior-habits.md](survey/behavior-habits.md) | 行为与习惯 | 通用 | 平台/频率/客单价/品类偏好量化 | draft |
| [survey/needs-scenarios.md](survey/needs-scenarios.md) | 需求与场景 | 通用 | 场景枚举/触发原因量化 | draft |
| [survey/mindset-cognition.md](survey/mindset-cognition.md) | 心智与认知 | 通用 | 态度分型/品牌偏好/平台认知 | draft |
| [survey/decision-journey.md](survey/decision-journey.md) | 决策与链路 | 通用 | 关注因素/信息优先级(Kano五档)/筛选 | draft |
| [survey/experience-painpoints.md](survey/experience-painpoints.md) | 体验与痛点 | 通用 | 场景痛点/平台体验/未转化归因 | draft |
| [survey/concept-test.md](survey/concept-test.md) | 概念与方案评估 | 通用 | 专区分类/服务/举措/品质感打分 | draft |

### 通用

| 文件 | 种类 | 何时用 | status |
|---|---|---|---|
| [interview-forbidden-questions.md](interview-forbidden-questions.md) | 禁问清单 | 设计提纲/AI主持时剔除答不了的六类题、改中立问法 | draft |

> **登记规则**：新建题组后往对应表加一行；同时在 `assets/index.md` 登记。

> 评审辅助（非正典，`_` 前缀）：入库计划见 `_conversion-plan-20260701.md`（首批）、`_conversion-plan-20260708.md`（8 份访谈提纲，interview/）、`_conversion-plan-20260708-survey.md`（5 份定量问卷，survey/），记录取文/准入/去重决策，随产物写工作树、PR 评审用，不作正典提交。

> **2026Q2 批量增量已并入**（2026-07-09）：来自 2026Q2 一批 10 份访谈提纲 + 11 份定量问卷的 12 份增量合并提案（原 `_merge-proposals/`）已按各提案的「去重留痕 + PR 合入建议」并入对应 interview/survey 题组——访谈侧覆盖 决策链路(购买链路还原/种草攻略四层/京东分型追问)、心智(抽象概念投射/社交货币)、体验(流失双线/商详回溯)、概念(触达文案/设计稿验证)、需求激发、行为(会员生态)、开场破冰/招募甄别；问卷侧覆盖 多级消费甄别漏斗、平台心智五感、满意度-NPS 度量组、购买触发六分法、商品卡展示测试 等。招募类 PII 与访谈排期题按规则剔除；该批 12 份 `*-batch2026q2.md` 提案已并入并移除。增量出处见各题组文末 `## 来源` 的「2026Q2 批量补充」条目。

## 2026-07-08 批增量已并入（2026-07-09）

> 来自 2026-07-08 一批 g1-g8 访谈（特价版/商超/外卖月卡/商旅/AI改版/服务频道/店铺化/AI购物）+ s1-s5 问卷（商旅标签/店铺标签/金券/外卖月卡/AI动线）的 14 份 `*-additions.md` 合并提案，已按各提案「去重留痕 + PR 合入建议」并入对应 interview/survey 题组并移除 `_merge-proposals/`。核心增量：跨平台比价/服务类多主体决策/多触点进店与动线 · 店铺类型与标签态度二段式 battery/子品牌认知漏斗/平台印象对比 · "麻烦不爽"三连/权益使用四联 battery/AI 痛点·信任·放弃 · AI 方案验证三段式/任务式原型/权益方向验证 · 候选标签态度四档 battery/机制规则验证/权益组合偏好 · AI 购物功能认知态度/AI 态度甄别 · 差旅出行行为 · 行为甄别（活动/功能类）等；招募类 PII 与访谈排期题按规则剔除。出处见各题组文末 `## 来源` 的「2026-07-08 批量补充」条目。
