# assets/ · 素材库（现成可复用的零件）

> 可以**直接拿来用**的原子件。何时进：要现成的题 / 量表 / 模板 / 经验卡片。
> **边界**：assets 是静态零件；`skills/` 是吃 brief 动态组装零件的执行器；`models/` 是「拿去想」的概念，这里的 `templates/` 是「拿去填」的操作物。
> **来源**：很大一部分从历史研究报告逐步「采矿」沉淀，不必一次建满。

## 四个子库

| 子库 | 放什么 | 对应 tags |
|---|---|---|
| `question-bank/` | 访谈题 / 问卷题 / 筛选题 | `[访谈题]` `[问卷题]` `[筛选题]` |
| `scales/` | 成熟量表（SUS / UEQ / NPS…） | `[量表]` |
| `templates/` | 可填模板 / 画布（提纲骨架、问卷模板、报告骨架、画像画布、旅程图） | `[模板]` `[画布]` |
| `playbooks/` | 经验卡片（抽象后的打法，区别于原始报告） | `[经验卡片]` |

## 零件清单

| 路径 | 零件 | 种类 | 何时用 | status |
|---|---|---|---|---|
| [scales/standardized-ux-scales.md](scales/standardized-ux-scales.md) | 标准化体验量表（SUS/UMUX-Lite/SEQ/NPS/CSAT/CES） | 量表 | 需现成的体验量表与计分/基准口径 | draft |
| [templates/opportunity-solution-tree.md](templates/opportunity-solution-tree.md) | 机会-解决方案树（OST） | 画布 | 把访谈发现结构化为"结果→机会→方案→实验" | draft |
| [templates/churn-phone-interview-script.md](templates/churn-phone-interview-script.md) | 流失用户电话回访话术框架 | 模板/访谈题 | 流失用户冷启动电话回访 | draft |
| [templates/churn-survey-framework.md](templates/churn-survey-framework.md) | 流失用户定量问卷框架 | 模板/问卷题 | 流失原因的定量验证问卷 | draft |
| [playbooks/growth-platform-low-stickiness-churn.md](playbooks/growth-platform-low-stickiness-churn.md) | 成长期平台低粘性流失调研打法 | 经验卡片 | 成长期平台、低粘性首购流失、缺生命周期模型时 | draft |
| [templates/experience-issue-description-script.md](templates/experience-issue-description-script.md) | 体验问题描述话术模板 | 模板 | 规范描述体验问题（场景/复现/影响/证据） | draft |
| [question-bank/interview-forbidden-questions.md](question-bank/interview-forbidden-questions.md) | 访谈禁问清单与中立替代话术 | 访谈题 | 设计提纲/AI主持时剔除用户答不了的六类问题、改中立问法 | draft |
| [question-bank/index.md](question-bank/index.md) | 题库总索引（7 主题 × interview/survey） | 索引 | 找现成访谈/问卷题的入口 | draft |
| [question-bank/interview/screener-demographics.md](question-bank/interview/screener-demographics.md) | 访谈题库·筛选与背景 | 访谈题/筛选题 | 甄别/暖场/背景信息 | draft |
| [question-bank/interview/behavior-habits.md](question-bank/interview/behavior-habits.md) | 访谈题库·行为与习惯 | 访谈题 | 摸现状行为/频率/渠道 | draft |
| [question-bank/interview/needs-scenarios.md](question-bank/interview/needs-scenarios.md) | 访谈题库·需求与场景 | 访谈题 | 挖触发场景与动机 | draft |
| [question-bank/interview/mindset-cognition.md](question-bank/interview/mindset-cognition.md) | 访谈题库·心智与认知 | 访谈题 | 探判断标准/品牌平台认知 | draft |
| [question-bank/interview/decision-journey.md](question-bank/interview/decision-journey.md) | 访谈题库·决策与链路 | 访谈题 | 还原购买决策全链路 | draft |
| [question-bank/interview/experience-painpoints.md](question-bank/interview/experience-painpoints.md) | 访谈题库·体验与痛点 | 访谈题 | 挖使用/购买痛点阻碍 | draft |
| [question-bank/interview/concept-test.md](question-bank/interview/concept-test.md) | 访谈题库·概念与方案评估 | 访谈题 | 测方案/功能/名称/机会点 | draft |
| [question-bank/survey/screener-demographics.md](question-bank/survey/screener-demographics.md) | 问卷题库·筛选与背景 | 问卷题/筛选题 | 甄别逻辑/人口信息题 | draft |
| [question-bank/survey/behavior-habits.md](question-bank/survey/behavior-habits.md) | 问卷题库·行为与习惯 | 问卷题 | 平台/频率/客单价/品类偏好量化 | draft |
| [question-bank/survey/needs-scenarios.md](question-bank/survey/needs-scenarios.md) | 问卷题库·需求与场景 | 问卷题 | 场景枚举/触发原因量化 | draft |
| [question-bank/survey/mindset-cognition.md](question-bank/survey/mindset-cognition.md) | 问卷题库·心智与认知 | 问卷题 | 态度分型/品牌偏好/平台认知 | draft |
| [question-bank/survey/decision-journey.md](question-bank/survey/decision-journey.md) | 问卷题库·决策与链路 | 问卷题 | 关注因素/信息优先级(Kano)/筛选 | draft |
| [question-bank/survey/experience-painpoints.md](question-bank/survey/experience-painpoints.md) | 问卷题库·体验与痛点 | 问卷题 | 场景痛点/平台体验/未转化归因 | draft |
| [question-bank/survey/concept-test.md](question-bank/survey/concept-test.md) | 问卷题库·概念与方案评估 | 问卷题 | 专区分类/服务/举措/品质感打分 | draft |
| [playbooks/interview-guide-writing-tips.md](playbooks/interview-guide-writing-tips.md) | 撰写访谈提纲的 6 大 Tips | 经验卡片 | 写深访/焦点小组提纲前；评审他人提纲时的检查清单 | draft |
| [playbooks/interview-perception-skills.md](playbooks/interview-perception-skills.md) | 访谈感知与洞察力训练 | 经验卡片 | 已能跑访谈但拿不出深度洞察时；新研究员上手前训练 | draft |
| [playbooks/opportunity-research-three-methods.md](playbooks/opportunity-research-three-methods.md) | 机会点研究三法 | 经验卡片 | 业务方已知大致答案、需要增量价值时；做"诊断+增长"双轮研究 | draft |
| [playbooks/priority-frameworks-overview.md](playbooks/priority-frameworks-overview.md) | 优先级排序框架综述（6 种） | 经验卡片 | 知道要排优先级但不知道用哪种框架；MoSCoW/KANO/RICE/CD3/四象限/执行收益矩阵选型指南 | draft |

> **登记规则**：每新增一个零件，往上表加一行；`type: asset`，`tags` 必填标明种类。字段见根 [`README.md`](../README.md)。
