# 用户研究方法与技能库 · User Research

本库是用户研究团队的**方法与技能中枢**——只收「怎么做研究」的方法论与「吃 brief 吐交付物」的可执行技能，**不含任何研究报告 / 原始数据 / 业务背景资料**。内容抽取自内部用研知识库（Research Wiki），面向京东内部复用。

> **消费者主要是 agent**：PM / 运营 / 设计通过 LLM 提问取方法与结论，用研员通过 `skills/` 生成交付物。
>
> **检索方式：导航式，无向量召回兜底。** 目录结构、各区 `index.md`、文件头 frontmatter **三者本身就是检索引擎**。正确路径：**本 README（总路由）→ 各区 index（有什么 / 何时进）→ 叶子文件（完整内容）**，先读描述判断再决定是否打开。

---

## 四区地图：每个区是什么、何时进

| 区 | 是什么 | 何时进来找 | 入口 |
|---|---|---|---|
| `methods/` | 研究 craft：怎么做研究 | 问「某方法怎么做 / 某线该怎么打 / 有什么规范」 | [methods/index.md](methods/index.md) |
| `models/` | 理论模型：概念透镜与设计原则 | 问「ECT / Kano / JTBD 是什么、怎么用」 | [models/index.md](models/index.md) |
| `assets/` | 素材库：现成可复用的零件 | 要现成的访谈题 / 量表 / 模板 / 经验卡片 | [assets/index.md](assets/index.md) |
| `skills/` | 技能库：吃 brief 吐交付物的生成器 | 要「生成研究方案 / 访谈提纲 / 问卷 / 画像 / 旅程图……」 | [skills/index.md](skills/index.md) |

`methods/` 内部三子区：
- **`toolbox/`** 方法本体（场景无关，**唯一出处**）：`collection/` 采集 · `analysis/` 分析技术
- **`scenarios/`** 场景打法（编排 toolbox）：`category-consumption/` 品类消费 · `product-experience/` 产品体验 · `comprehensive-business/` 综合业务
- **`standards/`** 执行规范（权威规则）

---

## 内容盘点

> **129 篇**方法/模型/素材文档 + **18 个** skills；均 `status: draft`，待评审。

| 区 | 篇数 | 覆盖（简） |
|---|---|---|
| `methods/` | **83** | **采集 32**：深访 · 提纲设计 · 招募 · 受访者偏误 · 满意度问卷 · 定性问卷 · 桌面研究 · 民族志 · 眼动 · 拦访 · 巡店 · 在线焦点小组 · 可用性测试 · 启发式评估 · 人物角色 · 体验地图 · 场景洞察 · 品牌命名 · 文案测试 · 体验评测 · 共创工作坊 · 量表编制 · 在用追踪 · 转换访谈 · 任务访谈 · 投射技术 · 情绪板 · 工作坊 · 焦点小组(线下) · 问卷调研 · U&A · 无障碍走查<br>**分析 36**：KDA · HEART体验度量 · 转化漏斗 · 功能采纳 · VOC · 问题分层 · A/B · 满意度异动归因 · 跨版本基准 · PSM · 联合分析 · TURF · 购物篮 · 对偶比较 · 贝叶斯品类对比 · 亲和图 · 数据标准化 · 满意度四模型 · 竞品分析 · 文本分析 · 定性洞察框架 · 定性编码 · 行为数据 · 系统思维 · 机会点 · IAT文案 · 控件热区 · TGI · 用户旅程图 · MaxDiff · 画像构建 · 优先级四象限 · 定性分析 · RFM · 问卷统计<br>**规范 10**：抽样 · 问卷设计 · 问卷体验审核 · 无障碍适配 · 报告撰写 · 项目流程 · 需求分析 · 访谈提纲规范 · 需求发现抽样 · 研究问题定义<br>**场景打法 5**：持续发现 · 迭代期评估诊断 · 流失用户调研 · 品类研究 · B端体验度量 |
| `models/` | **21** | **需求与任务 7**：JTBD · 用户需求三层 · Job Map · 阶梯法 · 四力模型 · Kano · 5W2H<br>**用户与人群 3**：画像/分层/分群 · G7人群细分 · 用户养成<br>**认知与洞察 4**：用户洞察 · 认知偏见 · 心理物理学 · 人类学透镜<br>**满意度与可用性 2**：ECT · 尼尔森十大可用性启发式<br>**方法论与表达 5**：访谈认识论 · ORID · 设计冲刺 · 金字塔原理 · 黄金圈 |
| `assets/` | **25** | **题库 15**：访谈禁问清单 + 访谈题·问卷题各 7 主题（筛选背景 · 行为习惯 · 需求场景 · 心智认知 · 决策链路 · 体验痛点 · 概念评估）<br>**量表 1**：标准化体验量表（SUS/SEQ/NPS/CSAT…）<br>**模板 4**：OST · 流失话术 · 流失问卷 · 体验问题描述<br>**经验卡片 5**：京喜流失 · 撰写提纲Tips · 访谈感知训练 · 机会点研究三法 · 优先级框架综述 |
| `skills/` | **18** | **通用·全流程 6**：研究方案 · 访谈提纲 · 问卷 · 单场访谈小结 · 定性归纳与洞察 · VOC 反馈编码<br>**产品规划 4**：用户画像 · 体验旅程图 · 需求定义 JTBD · 竞品分析<br>**产品设计 3**：可用性测试 · 启发式评估 · 无障碍审查<br>**产品迭代 5**：满意度诊断 · 体验度量体系 · 转化漏斗分析 · 功能采纳分析 · 问题分层与优先级 |

---

## 边界速查表：东西在手上，不知放哪 / 去哪找

| 你手上的东西 | 去 / 放进 |
|---|---|
| 某个方法怎么做（深访、问卷、可用性测试） | `methods/toolbox/collection/` |
| 一个能跨主题复用的分析手段（IPA、conjoint） | `methods/toolbox/analysis/` |
| 某条业务线 / 品类该怎么打的研究指南 | `methods/scenarios/<线>/` |
| 内部「必须遵守」的研究规矩（问卷设计规范） | `methods/standards/` |
| 贯穿全程的理论 / 设计原则（ECT、Kano、体验设计原则） | `models/` |
| 一道访谈题、一个成熟量表 | `assets/question-bank` · `assets/scales` |
| 一个可填模板 / 画布（提纲骨架、画像画布） | `assets/templates/` |
| 抽象后的经验打法卡片 | `assets/playbooks/` |
| 吃 brief 吐交付物的生成器 | `skills/<技能>/` |

几个**易混边界**：
- **toolbox/collection（怎么做）** vs **standards/questionnaire-design（必须遵守什么）**
- **standards（研究怎么做对）** vs **models（被研究对象本身长什么样 / 好不好）**：问卷设计规范→standards，体验设计原则→models
- **models（拿去想的概念）** vs **toolbox/analysis（怎么算 / 出图）**：Kano 理念→models，Kano 问卷分析步骤→analysis
- **assets（静态零件）** vs **skills（动态组装的执行器）**

---

## frontmatter 字段图例（检索命脉）

每个**内容文件**头部都带一段 YAML frontmatter——agent 顺目录找到文件后，靠它判断「是不是我要的」，也靠它做技能 cross-walk。受控字段只能取下方「取值一览」中的值，不要现造。

```yaml
---
title:          # 中文标题，一句话说清是什么
type:           # method | analysis | scenario-guide | standard | model | asset | skill
domain:         []        # 业务/场景，可多值；场景无关填 [通用] 或省略；scenario-guide 必填
research_type:  []        # [定性, 定量, 探索, 评估, 概念验证, 度量]
method_family:  []        # [访谈, 问卷, 可用性测试, ...]，采集类必填
stage:          []        # [规划, 设计, 迭代]，仅产品体验类需要
tags:           []        # 自由标签
status:         draft     # draft | reviewed | deprecated
sensitivity:    internal  # public | internal | restricted
owner:
updated:        # YYYY-MM-DD
related:        []        # [path/to/method, path/to/model]，跨层关联，手工维护
---
```

| 字段 | 必填 | 受控 | 说明 |
|---|---|---|---|
| `title` | ✅ | — | 中文标题 |
| `type` | ✅ | ✅ | 内容类型，决定落在哪个区（见下表） |
| `domain` | 视情况 | ✅ | 业务/场景；方法/模型/规范多为 `通用`；scenario-guide 必填 |
| `research_type` | 推荐 | ✅ | 研究类型/目的 |
| `method_family` | 采集类必填 | ✅ | 方法族 |
| `stage` | 产品体验类必填 | ✅ | 产研阶段 |
| `status` | ✅ | ✅ | 时效/质量 |
| `sensitivity` | ✅ | ✅ | 敏感级 |
| `tags`/`owner`/`updated`/`related` | 可选/推荐 | ❌ | 自由字段 |

### 受控取值一览

- **`type`**（单值，与目录一一对应）：`method`（`methods/toolbox/collection/`）· `analysis`（`methods/toolbox/analysis/`）· `scenario-guide`（`methods/scenarios/<线>/`）· `standard`（`methods/standards/`）· `model`（`models/`）· `asset`（`assets/**`）· `skill`（`skills/<技能>/`）
- **`research_type`**：`定性` · `定量` · `探索` · `评估` · `概念验证` · `度量`
- **`method_family`**（采集类）：`访谈` · `问卷` · `可用性测试` · `焦点小组` · `日记研究` · `现场观察` · `日志/行为数据分析` · `桌面研究` · `抽样` · `视觉风格研究` · `工作坊`（分析技术不靠此归类，用 `type: analysis` + `tags`）
- **`stage`**（仅产品体验）：`规划`（需求探索/机会与概念定义）· `设计`（概念验证/可用性/信息架构）· `迭代`（体验度量/问题诊断/效果验证）
- **`status`**：`draft`（草稿未评审）· `reviewed`（已评审可信赖）· `deprecated`（已废弃勿用）
- **`sensitivity`**：`public`（全员）· `internal`（内部员工）· `restricted`（受限）
- **`domain`**（多值，与 `methods/scenarios/` 目录对齐，格式 `线-子类`）：`通用`（场景无关）；`品类消费-<品类>`（`category-consumption/<slug>`：3C数码/商超/时尚/家电家居/个护/酒类/母婴/宠物/文具/新零售/跨品类方法）；`产品体验`（`product-experience`，阶段由 `stage` 承载）；`综合业务-<子类>`（`comprehensive-business/<slug>`：商业战略/品牌心智/跨业务专题/外卖/到家/到店/酒旅/特价版/会员权益）；`人群研究-<人群>`（`audience-research/<slug>`）。扩展新 slug 先在本表登记，再建目录。

---

## 如何贡献

1. 用**边界速查表**定位目标目录，参考同目录既有文件的写法。
2. 填合规 frontmatter——受控字段（`type/domain/research_type/method_family/stage/status/sensitivity`）**只能取上方「受控取值一览」的现有值**，要加新值先在本 README 登记。
3. 在所属区 `index.md` 登记一行。
4. 牢记：**方法本体只在 `toolbox/` 有唯一出处；scenarios / skills 引用而非复制。**
5. 新增 skill：建 `skills/<kebab-name>/SKILL.md`（+ `references/`，需要时 `scripts/`），`SKILL.md` 头部 `name`/`description` 决定安装器识别，**文件用 LF 换行**。

> 路径用英文 kebab-case；中文写在 index / frontmatter / 注释里。

---

## 说明

- 本库为京东内部方法库，正文保留京东业务实例（如京喜流失、京东 App 模块词库等）作为方法落地示范。
- 研究报告、原始数据、业务背景资料**不在本库**——它们留在内部用研知识库，按权限访问。文中如提到「见报告库 / 业务术语库」，均指本库之外的对应库。
