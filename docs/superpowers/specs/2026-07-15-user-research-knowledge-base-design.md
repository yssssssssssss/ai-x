# 用研知识库系统 设计文档

- 日期:2026-07-15
- 状态:待实现(spec 已评审 v2 · 场景重构)
- 归属:用研 AI 专项 · 经验记忆层(三层记忆中的第二层)

## 1. 背景与目标

用研 AI 专项本质是一个**对话式需求引导 agent**:它通过意图识别理解用户诉求,再用用户研究的**方法论、模型、规范**一步步引导用户完善需求,直到收敛出一份**完整的用户调研方案**。

这个知识库就是 agent 的"方法论大脑"——不是给报告做参照的素材库,而是 agent 每一轮引导对话时调取的**思维框架与研究规范来源**,以及需求收敛后产出方案的**可执行能力**。

内容萃取自外部优秀知识库(JD Design Wiki 的 `user-research` 目录),已下载至本地:`references/2C-DesignWiki/jd-design-system-md-v16/horizontal/user-research/`,构成:

| 分区 | 数量 | 在 agent 里的角色 | frontmatter 现状 |
|---|---|---|---|
| `skills/` | 21 个 SKILL.md | 需求收敛后产出方案/工具的能力(generate-* 为主) | 有 `name`/`description`/`license` |
| `models/` | 22 | 引导用户的思维框架(JTBD/Kano/ORID/5W2H…) | 无 |
| `methods/toolbox/` | 75 | 引导选方法的方法卡片(collection 35 + analysis 40) | 无 |
| `methods/standards/` | 11 | 判断需求完善度、引导规范化的研究规范 | 无 |
| `methods/scenarios/` | 6(+`.gitkeep` 占位) | "什么场景做什么研究"的路径引导 | 无 |

**核心目标:**
1. 建立**两层**内容:知识层(引导框架,可检索)+ 能力层(方案产出,可调用)。
2. 知识条目的 `tags` 与现有 `decision-graph.yaml` 的 `related_tags` **对齐成一套受控词表**,让"决策节点(需求缺口)→ 知识条目"的召回钩子连得上。
3. 以 **git-markdown 为唯一真相源**,人可直接读写、PR review。
4. 检索用**结构化过滤 + 关键词/BM25**,不引向量(YAGNI,触发条件见 §12)。
5. 一套**萃取流水线**处理首次全量与增量,忠实搬运原文、只补齐元数据。
6. 核心库对 agent runtime **内部直调**,接口预留未来 MCP 薄壳。

## 2. 范围

**In scope:** 目录布局、统一元数据 schema(含受控标签词表)、萃取流水线、indexer、面向引导的检索核心库 API、能力层派生、运行时引导链路集成、维护闸门(linter)、首次全量导入。

**Out of scope(明确不做):** MCP server(留薄壳口子);pgvector/embedding 语义检索(二期);LLM 重构正文;知识图谱;复杂标签本体。

## 3. Agent 应用场景与知识库角色(核心)

项目现有 `decision-graph.yaml`(决策节点池,资深用研的"完备性护栏")与 `research-task.schema.json`(含 `confirmations`/`assumptions`)已经构成引导 agent 的骨架。知识库挂在这套骨架上:

**引导链路:**
```
用户模糊诉求
  → 意图识别 → ResearchTask(task_type / business_domain / research_goal)
  → 按 task_type 激活决策节点池(core 必激活 / optional 按需, applies_to 命中)
  → 引导循环:对每个"未想清"的决策节点 D_x
       ├ 取 D_x.related_tags(如 D3_method_selection → [method])
       ├ search_knowledge(tags=related_tags, task_type, domain)
       │     召回对应 model/method/standard 作【引导框架】     ← 知识层主用途
       ├ 用召回的方法论向用户提问 / 给建议 / 解释权衡
       └ 产出 confirmation(问用户)或 assumption(替用户设默认)
  → 多轮收敛,直到全部 core 节点 + 命中的 optional 节点判为"清晰"
  → 需求完整 → resolve_skill('generate-research-plan') 等 → 产出【完整调研方案】
```

**决策节点 ↔ 知识条目的映射(靠 related_tags 受控词表):**

| 决策节点 | related_tags | 召回的知识用于引导 |
|---|---|---|
| D1 研究目标 | research_goal | 5W2H、research-question-definition |
| D2 目标用户 | persona, audience | persona、JTBD、user-needs |
| D3 方法选择 | method | methods/toolbox、methods/scenarios |
| D4 体验现状 | ux-audit, a11y | 启发式评估、体验度量、可用性测试 |
| D5 竞品参照 | ui-competitive, business-competitive | competitive-analysis 方法、竞品场景 |
| D6 敏感数据 | privacy, compliance | 抽样/合规规范 |
| D7 产出标准 | output, report | research-report-writing、金字塔原理 |

**两层角色小结:**
- **知识层(models/methods/standards)= 引导用的方法论军火库**,按决策节点召回,喂给 LLM 作提问框架与判断依据,**不被执行**。
- **能力层(skills,尤其 generate-*)= 需求收敛后产出方案/工具的能力**,被 `resolve_skill` 定位后由 agent 加载执行,产出物是**调研方案**(及访谈提纲/问卷等子产物)。

## 4. 总体架构

```
知识层(引导框架, 可检索)          能力层(方案产出, 可调用)
models/ methods/ *.md          →   skills/*/SKILL.md
        │                              │
        │   frontmatter = 唯一元数据真相源      │
        │   (tags 归一到受控词表)               │
        ▼                              ▼
        indexer(构建期扫描 frontmatter → 派生索引)
        │                              │
        ▼                              ▼
   .index/knowledge.json        skill-registry.yaml(派生, 非手写)
        │                              │
        └──────────── 核心库 API ───────┘
   search_knowledge / get_entry / list_skills / resolve_skill
                        │
        agent runtime 直调(引导循环 + 方案产出)
```

**原则:frontmatter 是唯一真相源**,`skill-registry.yaml` 与检索索引均由 indexer 派生,人不手写 registry。

## 5. 目录布局

在现有 `knowledge-base/` 下按 wiki 分类法重组,现有 2 篇并入:
```
knowledge-base/
├── models/
├── methods/
│   ├── scenarios/
│   ├── standards/
│   └── toolbox/{collection,analysis}/
├── skills/                     # 21 个 SKILL.md 文件夹(含 references/、scripts/)
├── taxonomy.yaml               # 受控标签词表(见 §6.3),与 decision-graph 对齐
└── .index/                     # indexer 产出(纳入 git)
```

## 6. 统一元数据 Schema

### 6.1 知识条目(models / methods)

**真相源 = wiki 自带 frontmatter,全量保留、不 strip 不 rewrite。** wiki 147/178 文件本就有成熟 frontmatter(`title/type/domain/research_type/tags/status/sensitivity/owner/updated/related`),这些**原样保留**。normalizer 只做**增量补齐**:

```yaml
# —— wiki 原生字段, 保留不动 ——
title:          RFM 模型用户分群
type:           analysis          # wiki 自有词表: analysis/method/model/standard/scenario-guide/asset
domain:         [通用]
research_type:  [定量, 度量, 评估]
tags:           [RFM, 用户分群, 客户价值, ...]   # wiki 精编中文标签, 自由词表, 不归一不校验
status:         draft
owner:          李笑欣
related:        [models/user-personas-segmentation.md]
# —— normalizer 增量补齐(缺则加, 不覆盖原生)——
id:             analysis_rfm       # 缺失才生成
source:         xingyun_wiki
source_path:    methods/toolbox/analysis/rfm.md   # 始终设为实际路径
content_hash:   sha256:…           # 始终计算
guide_tags:     [method]           # 新增: 受控词表, 对齐 decision-graph related_tags, 供引导召回
guide_stage:    [method-selection] # 新增: 受控引导阶段
```

**关键:`tags`(wiki 原生,自由中文)与 `guide_tags`(受控,对齐 decision-graph)是两个不同字段。** 前者保留 wiki 的检索价值(关键词/BM25 召回更强),后者做"决策节点→条目"的引导召回钩子。互不覆盖。

### 6.2 能力条目(skills)
```yaml
name: generate-research-plan
description: 生成完整用户调研方案(研究目标/方法选择/执行计划)。
type: skill
domain: general
tags: [method, output]         # 受控词表
task_types: [user_research_planning]   # 对齐 ResearchTask.task_type,供 router 精准路由
inputs: [research_goal, target_users, constraints]
outputs: [research_plan]
content_hash: sha256:…
status: approved
updated_at: 2026-07-15
```
> **相比 v1 的关键补充:** skills 必须补 `task_types`/`inputs`/`outputs`——现有 `router` 靠 `task_types` 精准路由,wiki 原始 SKILL.md 无此字段,需在萃取阶段用轻量 LLM 从正文抽取 + 人工校对。

### 6.3 受控词表 `taxonomy.yaml`(约束 guide_tags,不约束 wiki tags)
- 定义合法 **`guide_tags`** 与 `guide_stage` 取值。`guide_tags` **必须涵盖 `decision-graph.yaml` 全部 `related_tags`**(research_goal/persona/audience/method/ux-audit/a11y/ui-competitive/business-competitive/digital_human/privacy/compliance/output/report),可再扩展。
- `guide_stage` 枚举:`intent`/`goal-definition`/`need-discovery`/`method-selection`/`output-standard`。
- 作用:决策节点与条目的 `guide_tags` 共用这套词表,是"节点→条目"召回钩子的契约。**wiki 原生 `tags` 不受此约束**(自由中文,只用于关键词检索,linter 不校验)。

### 6.4 字段生成规则(增量补齐,不覆盖 wiki 原生)
| 字段 | 来源 |
|---|---|
| title/type/domain/research_type/tags/status/owner/related | **wiki 原生,保留不动**;缺失时 type/domain 由路径推断兜底 |
| id | 缺失才生成(type + 文件夹/文件名);冲突报错 |
| source_path | 始终设为实际相对路径 |
| content_hash | 始终对正文(去 frontmatter)算 sha256 |
| guide_tags/guide_stage | 规则种子(关键词/type 映射)→ 归一到 taxonomy.yaml;LLM 增强可选 |
| task_types/inputs/outputs(skills) | 规则种子 + 可选 LLM + 人工校对 |

## 7. 萃取流水线(normalizer)

首次全量与增量同一套逻辑:
1. 遍历文档(首次=本地 wiki 副本;后续=新增/更新 md)。
2. **正文与 wiki 原生 frontmatter 全量保留**,不重写、不 strip。
3. **增量补齐**:缺 id 则生成;始终设 source_path、算 content_hash;补受控 `guide_tags`/`guide_stage`(规则种子→归一 taxonomy);skills 另补 `task_types`/`inputs`/`outputs`。无 frontmatter 的文件用路径推断兜 type/domain。
4. 已有字段一律不覆盖(尤其 wiki 的 tags/research_type/owner/related 与 skills 的 name/description)。
5. 写回。

**导航文件例外:** `index.md`/`README.md` 保留原样作导航,不视为条目、不进索引;`.gitkeep` 忽略;`type: asset`(25 个媒体素材)不进知识索引。
**幂等:** content_hash 未变则不改写。

## 8. 检索设计(面向引导)

- `indexer` 扫全部 frontmatter → `.index/knowledge.json`(含 id/type/domain/**tags(wiki)**/**guide_tags(受控)**/guide_stage/title/summary/research_type/source_path/content_hash/status)。正文不入索引。
- `search_knowledge` 结构化过滤:**`guide_tags`(决策节点 related_tags)** + `guide_stage` + `type`/`domain`,再对 title/**tags(wiki 精编中文标签,关键词召回强)**/summary 做关键词/BM25;`deprecated` 剔除。
- 返回条目**带 source_path + content_hash** 溯源。
- 主调用姿势:引导循环 `search_knowledge(guide_tags=D_x.related_tags, guide_stage=…)`。

## 9. 能力层:skills → registry(双入口,共用底座)

- `indexer` 把 `skills/*/SKILL.md` 的 frontmatter(含补齐的 task_types/inputs/outputs)派生进 `skill-registry.yaml`;router 只读派生结果,精准路由。
- registry 从此**只读派生**,不手写(消除现有手写 registry 与 SKILL.md 不同步的隐患)。
- `resolve_skill(name)` 定位 SKILL.md 文件夹,交 agent 现有三层渐进加载执行(SKILL.md→references→scripts)。
- generate-* 类是主力:需求收敛后产出调研方案与子产物。

**registry 派生的契约调整(计划阶段确认):** 现有 `config-loader.ts` 的 `SkillRegistryEntry` 把 `input_schema`/`output_schema` 列为必填 string,而 KB skill 是 markdown 过程式(references/skeleton),无 JSON schema。故**放宽契约**:这两字段转可选、新增 `entry`(SKILL.md 文件夹路径),`registry-linter` 对 KB 来源 skill 不强制 JSON schema。indexer 派生映射:`id`←name、`path`/`entry`←SKILL.md 路径、`when_to_use`←description、`owner`←默认"用研团队"、`risk_level`←默认 low、`task_types/inputs/outputs`←萃取补齐。现有 2 条手写 registry 被派生结果取代,消除现存不一致。

**两条触发路径,同一出口:** skill 既可被编排器路由激活,也可被用户直呼,二者**最终都落到 `resolve_skill(name)` → 加载执行**,不是两套系统。

| 路径 | 谁指定 name | 触发 | 引导循环 | 本期 |
|---|---|---|---|---|
| ① 编排器路由(隐式) | router(LLM 按 task_type) | 自然语言诉求 | 走(D1~D7 引导→收敛) | ✅ 实现 |
| ② 用户直呼(显式 `$name`) | 用户点名 | `$competitive-analysis` | 跳过 | ⏳ 二期,**仅预留接口** |

**本期只保证接口不堵死:** `resolve_skill(name)` 以 `name` 为稳定调用契约,直呼二期只需在入口层加"`$<name>` 解析 → 直连 resolve_skill",核心逻辑不改。直呼落地时须补:`inputs` 缺参的最小澄清/assumption 兜底、`list_skills` 做补全清单、**直呼仍过 D6 敏感数据/合规闸门(不绕过)**。符号 `$`/`/` 是产品约定,架构层只认"按 name 直呼"。

## 10. 运行时集成:调用链路 API 消费点

| 链路节点 | 调用 | 用途 |
|---|---|---|
| 意图识别 | (可选) list_skills / domain 语义 | 辅助判定 task_type/domain |
| 引导循环·每个决策节点 | **search_knowledge(related_tags, guide_stage)** | 召回引导框架,驱动提问/建议 |
| 能力路由(路径①) | router 读派生 skill-registry | 按 task_types 激活 generate-* 等 |
| 方案产出 | **resolve_skill(name)** → 加载执行 | 生成完整调研方案 |
| 用户直呼(路径②,二期) | 入口解析 `$name` → **resolve_skill(name)** | 用户跳过引导直调某能力 |
| 溯源 | 条目携带 source_path+hash | 方案中标注方法论来源 |

## 11. 可持续维护:git PR + linter 双闸

- 新增 **frontmatter linter**(沿用 `harness/linters/registry-linter.ts` 模式):校验必填字段、id 唯一、type 合法、`tags`/`guide_stage` 属于 taxonomy.yaml、content_hash 匹配、source_path 一致;skills 校验 task_types 合法。
- 流程:作者写/改 md → PR → linter 卡门 → 合并触发 normalizer(补新文档)+ indexer(重建索引与 registry)。
- 生命周期:status + updated_at 管理,deprecated 不召回。

## 12. 核心库 API 契约

```
search_knowledge(tags?, guide_stage?, task_type?, domain?, query?, limit?) -> Entry[]  # 带 source_path+hash
get_entry(id) -> { frontmatter, content }
list_skills(task_type?, domain?, tags?) -> SkillMeta[]
resolve_skill(name) -> { path, frontmatter }
```
MCP 薄壳(后话):四个函数一一映射为 MCP tool,核心逻辑不改。

## 13. 二期 / YAGNI 边界

pgvector 语义检索触发条件(满足其一):知识条目 > 200 且结构化+关键词召回不准;或出现跨条目语义关联召回的真实需求。其余不做:MCP、LLM 正文重构、知识图谱、embedding。

**二期(仅预留接口,本期不实现):** 用户 `$<name>` 直呼 skill——入口层 `$` 解析 + inputs 缺参澄清 + list_skills 补全清单;底座 `resolve_skill(name)` 本期已就绪,直呼不改核心逻辑(见 §9)。

## 14. 已定默认(评审确认,可推翻)

1. **全量导入** 162 篇(约 114 知识条目 + 21 skills),靠 status 后续筛。
2. **镜像 wiki 目录**并入 knowledge-base。
3. **registry 改为 indexer 派生**。
4. **新增 taxonomy.yaml 受控词表**,tags/guide_stage 强约束并对齐 decision-graph.related_tags。
5. **skills 补 task_types/inputs/outputs**(规则种子 + 可选 LLM + 人工校对)。
6. **放宽 loader 契约**:`SkillRegistryEntry.input_schema/output_schema` 转可选、加 `entry`,linter 对 KB skill 不强制 JSON schema(改 config-loader.ts + registry-linter.ts)。

## 15. 验收标准

1. 知识/能力条目(约 114 + 21)全部导入,带合法 frontmatter,`tags`/`guide_stage` 均在 taxonomy.yaml 内,linter 全绿;导航文件保留不强制 frontmatter。
2. `taxonomy.yaml` 覆盖 decision-graph 全部 related_tags;每个决策节点的 related_tags 都能 `search_knowledge` 召回到相关条目。
3. `.index/knowledge.json` 与派生 `skill-registry.yaml` 由 indexer 生成,与 frontmatter 一致;registry 条目含 task_types/inputs/outputs。
4. 引导循环可用:给定某决策节点的 related_tags + guide_stage,`search_knowledge` 返回可用于引导的 model/method 并带来源。
5. `resolve_skill('generate-research-plan')` 能定位并加载,产出调研方案。
6. normalizer 幂等;frontmatter linter 能拦截缺字段/id 重复/tag 越界/hash 不匹配。
