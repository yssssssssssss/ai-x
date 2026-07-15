# methods/ · 研究 craft 总枢纽

> 「怎么做研究」的总入口。三个子区分工明确，先判断你的问题属于哪一类。

## 何时进哪个子区

| 子区 | 放什么 | 何时进 | 入口 |
|---|---|---|---|
| `toolbox/` | **方法本体**（场景无关，唯一出处） | 「某个方法/分析手段本身怎么做」 | [collection](toolbox/collection/index.md) · [analysis](toolbox/analysis/index.md) |
| `scenarios/` | **场景打法**（编排 toolbox） | 「某条业务线 / 某阶段该怎么打」 | [scenarios/index.md](scenarios/index.md) |
| `standards/` | **执行规范**（权威规则） | 「我们组必须遵守什么」 | [standards/index.md](standards/index.md) |

## toolbox 粒度规则（决定一段内容放 collection / analysis / 还是 models）

判据**不是**流程阶段，而是**能否脱离其余被单独复用**：

- 「这段拿到别的研究里也成立」→ **拆进 `toolbox/analysis/`**（独立分析技术）。
  - 例：满意度测量留采集方法；满意度×重要性矩阵（IPA）拆进 analysis，因为 IPA 能用在大量属性评估。
- 「拆开就讲不通、贯穿全程才成立」→ **整篇进 `models/`**（理论透镜）。
  - 例：ECT 贯穿问题定义→采集→结论，不可按流程切碎。

## 单一出处

方法本体**只在 `toolbox/` 有唯一出处**。`scenarios/` 与 `skills/` 按路径/标签**引用**，绝不复制。规则只在 `standards/`，由 toolbox 反向链接过去。

> 贡献入口：frontmatter 字段、受控取值与边界速查见根 [`README.md`](../README.md)。
