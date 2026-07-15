# methods/scenarios/ · 场景打法（= 用研业务模式）

> 把 `toolbox/` 的方法**编排**成「某条业务线该怎么打」的应用指南。
> **边界**：只放应用编排，不放方法本体——方法本体只在 toolbox 有唯一出处，这里按路径/标签**引用**，不复制。

## 三条线及其子结构

| 线 | 目录 | 子结构 | 备注 |
|---|---|---|---|
| 品类消费 | `category-consumption/` | 按**品类**分：`3c-digital` `mass-retail` `fashion` `home-living`… | 品类可扩展 |
| 产品体验 | `product-experience/` | 按**研发阶段**分：`planning`（规划）`design`（设计）`iteration`（迭代） | 阶段由 frontmatter `stage` 承载 |
| 综合业务 | `comprehensive-business/` | `business-strategy` `brand-mindset` `cross-line-topics` | **〔示意·待确认〕**，定调后替换 |

说明：因为「先场景、产品体验内部再分阶段」，「市场/品类理解」归到 `category-consumption`，不混进 `product-experience/planning`；planning 下只放「这个产品自己的」需求与机会研究。

## 打法清单

| 路径 | 场景 | domain | 何时用 | status |
|---|---|---|---|---|
| [product-experience/iteration/continuous-discovery.md](product-experience/iteration/continuous-discovery.md) | 持续发现 | 产品体验 | 持续交付团队每周与用户对话、把发现与交付并轨 | draft |
| [product-experience/iteration/iteration-evaluation-diagnosis.md](product-experience/iteration/iteration-evaluation-diagnosis.md) | 产品迭代期·效果评估与问题诊断打法 | 产品体验 | 迭代上线后编排"评估→诊断→验证"：好了多少 / 哪里为什么 / 改动有没有用 | draft |
| [category-consumption/cross-category/churn-user-research.md](category-consumption/cross-category/churn-user-research.md) | 流失用户调研打法 | 品类消费-跨品类方法 | 品类/平台流失率高、要判断真假流失并挖原因做召回 | draft |
| [category-consumption/cross-category/category-research.md](category-consumption/cross-category/category-research.md) | 品类研究打法 | 品类消费-跨品类方法 | 理解品类、做品类研究项目（系列开篇） | draft |
| [comprehensive-business/cross-line-topics/b-end-experience-measurement.md](comprehensive-business/cross-line-topics/b-end-experience-measurement.md) | B 端系统体验度量打法 | 综合业务-跨业务专题 ⚠️待对齐 | 给 B 端系统搭体验度量体系、定北极星、归因改善 | draft |

> **登记规则**：在某线/品类/阶段下新增打法时，往上表加一行。
> 新场景打法：`type: scenario-guide`，`domain` 必填且对齐目录；产品体验类加 `stage`。字段图例见根 [`README.md`](../../README.md)。
> 扩展品类：新增 domain slug 先记入根 [`README.md`](../../README.md) 的取值表，再建目录。
