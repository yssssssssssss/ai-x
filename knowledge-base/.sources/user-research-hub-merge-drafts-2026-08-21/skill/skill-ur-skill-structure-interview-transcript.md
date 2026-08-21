---
format: user-research-hub-merge-draft-v1
status: draft
runtime_consumed: false
review_gate: gate-2
source_entity: skill:ur-skill-structure-interview-transcript
source_path: wiki/user-research/02-skills-技能/用户研究/单场访谈小结/SKILL.md
source_hash: sha256:d38dd69147da78cb592fa489a25790f7f12a021a43ccacb25fec3d69fa35bfe3
canonical_target: knowledge-base/skills/structure-interview-transcript
canonical_hash: sha256:a28d11d17eb88d3fd4916dae68ee942c1b2935da94a999d48f1076381b8c5358
disposition: merge_into_existing
merge_sections:
  - review_required
distribution_scope: evaluation_only
managed_by: user-research-hub-integration-v1
---

# Merge draft: skill:ur-skill-structure-interview-transcript

> Review artifact only. The existing canonical entry remains authoritative; this draft is not loaded by Runtime or the Skill Registry.

## Structural comparison

- Source-only headings: 访谈小结 · 产出骨架与组装规则 | 来源重构说明 | 访谈小结 · 产出骨架与组装规则 | A. 固定头部（结构稳定，可固定） | B. 以研究内容 / 研究问题为主干的分主题发现（框架作透镜，绝不写死） | B-1 先立主干（顶层小标题） | B-2 再用框架作透镜，在每条主干内深挖 | B-3 每个发现点的写法 | C. 痛点 / 待跟进 | D. 《本次运行说明》（每次必附，放小结最末） | E. 正文内的局限声明（与运行说明呼应，写在小结正文显著处）
- Canonical-only headings: Structure Interview Transcript — 单场访谈逐字稿 → 结构化小结（降噪整理版） | 核心原则（先理解，再动手） | 工作流 | 1. 接稿 + 锁定研究目的与研究内容（决定主干骨架） | 2. 读"访谈如何被结构化记录"的正典 → 定固定头部 + 痛点/待跟进的字段来源 | 3. 选**一个**理论框架作**深化透镜**（不是骨架） | 4.（单场内）发现点多而散时，先归并主题 | 5. 产出结构化小结 | 6. 末尾附《本次运行说明》 | 敏感素材处理（本类 skill 特有，务必遵守） | 通用纪律（每次产出固定遵守） | 参考文件
- Shared headings with changed text: none

## Candidate source content

# 访谈小结 · 产出骨架与组装规则

## 来源重构说明
本 Skill 由原用研技能文件迁移，保留原执行步骤、输入输出、提示词和质量要求。

# 访谈小结 · 产出骨架与组装规则

> 本文件只放**骨架与组装规则**，是本 skill 自带的产出说明，**不是 Wiki 正典**。
> 各框架的定义、各字段的细则、选型判据——**一律运行时从 Wiki 读**（路径见 SKILL.md），不在此复制。复制正典 = 一旦 Wiki 更新就过期、就成了第二出处。

整份小结的顺序：**A 固定头部 → B 以研究内容为主干的分主题发现 → C 痛点 / 待跟进 → D 本次运行说明**；正文里就地写 **E 局限声明**。

---

## A. 固定头部（结构稳定，可固定）

两块。字段来源取自运行时读到的"访谈如何被结构化记录"的正典（`interview-guide-design.md` 的背景维度 + `affinity-diagram.md` 整理脚本的字段与匿名约定）。

1. **受访者背景 / 样本画像**
   - 用户编号或假名（如 U1 / 受访者A）——**不写真名**。
   - 基本属性、社会属性、日常生活 / 相关行为习惯、与本研究相关的使用经历。
   - 具体取哪些维度，以"本次研究内容 + 正典背景维度"为准，不是越多越好。

2. **访谈执行信息**
   - 时间、时长、形式（线下 / 远程 / 电话）、场景、访谈者 / 记录者。
   - 逐字稿未提供的项 → 标"未提及"，**不要推断**。

> 规则：固定头部只填逐字稿或研究员明确给出的信息；**缺则标"未提及 / 待补充"，不推断不编造**。

---

## B. 以研究内容 / 研究问题为主干的分主题发现（框架作透镜，绝不写死）

这是小结的主体。**主干骨架 = 本次研究目的 / 研究内容 / 研究问题**（需求方关心的重点），不是理论框架。

### B-1 先立主干（顶层小标题）
- **主干小标题 = 研究内容 / 研究问题逐条**。来源优先级：① skill 使用者提供的研究方案 / 研究内容 / 研究问题；② 访谈提纲的维度；③ 都没有时，据研究目的 + 逐字稿覆盖话题**推断 3–6 条主干，并在该处标注"据目的 / 逐字稿推断，待需求方确认"**。
- 每条主干直接对应"需求方想知道的一件事"，让提出人能按图索骥找到自己关心问题的结论。
- 不要用 O/R/I/D、旅程阶段、Say/Do/Think/Feel 等**框架层级**充当顶层小标题——那会把小结铺成框架教学、陷进细节。

### B-2 再用框架作透镜，在每条主干内深挖
- 在每个研究问题主题**内部**，用第 3 步选定的框架作透镜，把发现从"现象"推进到"动机 / 情绪 / 矛盾 / 机会"。例如：
  - 透镜 = ORID → 在某主题内沿"客观行为 → 感受 → 动机(场景>行为>动机) → 切身需求"把这条问题挖深；
  - 透镜 = 旅程地图 → 在某主题内标该环节的情绪高低与机会点；
  - 透镜 = 同理心 / 价值主张 / ABC → 同理，作为深挖手段。
  - **框架只在主题内部用于"挖深"，不决定顶层结构。** 框架的实际层级与含义运行时从 Wiki 读，不凭记忆预填。

### B-3 每个发现点的写法
- **一句话发现 + 1–N 条关键原话**（匿名、保留口语与情绪、去除无关 PII）。
- 原话是降噪整理的**证据**：发现必须由原话支撑，没有原话支撑的"发现"要么标为推断、要么删掉。
- 建议格式：
  > **发现：** 一句话说清这个发现（必要时点明它来自哪个框架透镜的视角）。
  > - 原话（U1）："……"
- **区分事实区 / 观点区**（见 `qualitative-insight-frameworks.md` 采集小技巧）：用户的"你应该加个按钮"是**观点**，记录其背后的**事实 / 动机**，不要把方案当发现；方案另入 C 节「待跟进 · 设计想法」。

> 提醒：只整理"这一场对每个研究问题说了什么、暴露了什么"，**不跨场归纳、不在此拔总洞察**——那是 `synthesize-qualitative-insights` 的事。

---

## C. 痛点 / 待跟进

承接 `affinity-diagram.md` 的便签标记约定（无标记 = 痛点体验、Q = 待研究问题、D = 设计想法）：

- **痛点**：本场暴露的体验障碍 / 未被满足的需求（对应"无标记"）。每条尽量配原话或场景，并可回指它属于哪条研究问题。
- **待跟进**：
  - 需后续研究澄清的问题（对应 **Q**）；
  - 用户主动提出的设计想法 / 方案（对应 **D**）单列，注明"用户观点，待验证"，不要当成结论。

> 这两节都是"本场内"的，**不跨场归纳**。

---

## D. 《本次运行说明》（每次必附，放小结最末）

固定列出以下各项（缺项也要写明"无 / 未发生"）：

1. **调用的正典**（路径 + `status`），例：
   - `methods/toolbox/analysis/qualitative-insight-frameworks.md`（status: draft）
   - `models/orid.md`（status: draft）
   - `methods/toolbox/collection/interview-guide-design.md`（status: draft）
   - `methods/toolbox/analysis/affinity-diagram.md`（status: draft）
2. **本次主题骨架来源 + 所选深化透镜**：
   - 主干来源 = 研究方案 / 研究内容 / 访谈提纲 / 还是"据目的+逐字稿推断（待需求方确认）"；
   - 选了哪个框架作**深化透镜**、为什么（结合研究目的，例："研究目的是探索弃用动机，故在各研究问题内用 ORID 作透镜，从客观行为推进到动机与需求"）。
3. **该调用但未找到的内容**（如某路径读不到）。
4. **走空的链接**（引用到的 Wiki 路径不存在 / 为空 stub）。
5. **哪些部分基于 `draft` 正典、哪些是未找到正典而用通用方法兜底**。
6. **反馈入口**：`[http://xingyun.jd.com/codingRoot/JD_Research_Wiki/Research_Wiki/settings/issues]`

---

## E. 正文内的局限声明（与运行说明呼应，写在小结正文显著处）

一句话即可，例：

> 说明：本小结**以本次研究内容 / 研究问题为主干**组织，理论框架仅作主题内深挖的透镜；主干结构与字段依据来自 `status: draft` 的 Wiki 文档（尚未评审），凡未找到正典而采用通用方法兜底、或据推断生成的主干（待需求方确认）之处，已在文中就地标注。受访者信息与原话已做匿名化处理。
