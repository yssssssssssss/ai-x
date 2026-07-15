# models/ · 理论模型库

> 研究时套用的**概念透镜与设计原则**：ECT、Kano、JTBD、Fogg 行为模型、Nielsen 可用性启发式、体验设计规范/原则…
> 何时进：「X 模型是什么、怎么作为透镜用」。

## 两条关键边界

- **vs `standards/`**：standards 管「研究怎么做对」；models 描述「被研究的东西本身长什么样 / 好不好」。问卷设计规范→standards，体验设计规范→**models**。
- **vs `toolbox/analysis/`**：models 是概念知识（是什么/为什么）；analysis 是可操作手段（怎么算/出图）。Kano 理念→models，Kano 问卷分析步骤→analysis。

## 模型清单

| 文件 | 模型 | 一句话透镜 | status |
|---|---|---|---|
| [ect.md](ect.md) | 期望确认理论（ECT） | 满意 = 使用后感知 vs 使用前期望的确认/不确认；逐价值点定位失望/惊喜点（含 ECM 扩展） | draft |
| [g7-brand-segmentation.md](g7-brand-segmentation.md) | G7 品牌人群细分模型 | 按品牌认知/购买/考虑/首选把人群分 7 类、品牌态度 A 值 | draft |
| [golden-circle.md](golden-circle.md) | 黄金圈模型 | WHY-HOW-WHAT 解构品牌沟通逻辑 | draft |
| [user-cultivation-growth.md](user-cultivation-growth.md) | 用户养成运营模型 | 按养成阶段经营用户、驱动增长 | draft |
| [design-sprint.md](design-sprint.md) | 设计冲刺（Design Sprint） | 5 天结构化冲刺解决棘手难题 | draft |
| [orid.md](orid.md) | ORID 焦点式呈现法 | 客观→感受→理解→决定 四层提问框架 | draft |
| [cognitive-biases.md](cognitive-biases.md) | 认知偏见与用户决策 | 诱饵/锚定/鸟笼/禀赋等偏见如何影响决策 | draft |
| [user-insight.md](user-insight.md) | 用户洞察（认知与误区） | 洞察≠调研；结果→结论→洞察三层递进 | draft |
| [psychophysics.md](psychophysics.md) | 心理物理学（阈限与信号检测） | 感觉阈限/JND 与信号检测论 d'/ROC | draft |
| [interview-epistemology.md](interview-epistemology.md) | 访谈认识论（知识建构观） | 访谈是知识建构而非单向挖掘；矿工vs旅行者、知识七特征、三大社会学视角 | draft |
| [means-end-laddering.md](means-end-laddering.md) | 梯子理论（手段-目的链 / Means-End） | 属性→利益/后果→价值观，逐级追问把功能偏好挖到深层动机 | draft |
| [anthropological-lens.md](anthropological-lens.md) | 人类学视角（厚数据与文化透镜） | 把用户当有文化脉络的人；厚数据 vs 大数据、文化相对论、去熟悉化、反身性 | draft |
| [5w2h.md](5w2h.md) | 5W2H 模型 | 7 维度（Who/What/When/Where/Why/How/How much）情境化还原用户行为 | draft |
| [jtbd.md](jtbd.md) | Jobs To Be Done | 用户雇佣产品完成某个 Job；同 Job 跨品类竞争 | draft |
| [four-forces.md](four-forces.md) | 四力模型（推/拉/焦虑/惯性） | 切换决策的力学：推+拉 > 焦虑+惯性 时切换发生 | draft |
| [job-map.md](job-map.md) | Job Map（ODI 8 步框架） | 任意核心任务的通用 8 阶段拆解骨架 | draft |
| [kano.md](kano.md) | KANO 模型 | 5 类质量特性（基本/期望/魅力/无差异/反向）做需求分类与优先级 | draft |
| [user-needs.md](user-needs.md) | 用户需求的本质（三层模型） | 表层显性诉求 / 中层任务场景 / 深层目标动机 | draft |
| [user-personas-segmentation.md](user-personas-segmentation.md) | 用户画像/分层/分群（三概念辨析） | 画像=谁、分层=什么阶段、分群=同阶段行为差异 | draft |
| [pyramid-principle.md](pyramid-principle.md) | 金字塔原理 | 结论先行、以上统下；研究输出物的思考与表达骨架 | draft |
| [nielsen-heuristics.md](nielsen-heuristics.md) | 尼尔森十大可用性启发式 | 10 条经验法则当标尺，专家逐条检视界面找可用性问题（启发式评估/走查的评分准则） | draft |

<!-- 示例行：
| ect.md | 期望确认理论 | 满意 = 实际表现 vs 事前期望的确认/不确认 | reviewed |
| kano.md | Kano 模型 | 把需求分基本/期望/兴奋型 | reviewed |
| jtbd.md | Jobs To Be Done | 用户「雇用」产品完成某个 job | draft |
-->

> **登记规则**：每新增一个模型，往上表加一行；`type: model`。字段见根 [`README.md`](../README.md)。
