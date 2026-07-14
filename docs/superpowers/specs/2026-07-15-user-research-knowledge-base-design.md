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
```yaml
id: model_jtbd
type: model                    # model | standard | toolbox-collection | toolbox-analysis | scenario
title: JTBD (Jobs To Be Done)
domain: general
tags: [persona, audience]      # 必须取自 taxonomy.yaml 受控词表
guide_stage: [need-discovery]  # 该条目适合的引导阶段(见 §6.3),供按需求缺口召回
summary: 从"用户雇佣产品完成任务"视角理解需求的框架
source: xingyun_wiki
source_path: models/jtbd.md
content_hash: sha256:…
status: approved               # draft | approved | deprecated
updated_at: 2026-07-15
```

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

### 6.3 受控标签词表 `taxonomy.yaml`(新增,关键)
- 定义全库合法 `tags` 与 `guide_stage` 取值,`tags` **必须涵盖 `decision-graph.yaml` 现有全部 `related_tags`**(research_goal/persona/audience/method/ux-audit/a11y/ui-competitive/business-competitive/digital_human/privacy/compliance/output/report),可再扩展。
- `guide_stage` 枚举(引导阶段):`intent`(意图澄清)、`goal-definition`(目标定义)、`need-discovery`(需求挖掘)、`method-selection`(方法选择)、`output-standard`(产出规范)。
- 作用:决策节点与知识条目共用这套词表,是"节点→条目"召回钩子的契约;萃取补 tag 时 LLM 产出必须**归一到词表**,越界报错。

### 6.4 字段生成规则
| 字段 | 来源 |
|---|---|
| type/domain | 路径推断 |
| id | type + 文件名,冲突报错 |
| content_hash | 正文(去 frontmatter)sha256 |
| title | 正文首个 `#` |
| tags/guide_stage | LLM 生成后**归一到 taxonomy.yaml**,越界项人工修正 |
| task_types/inputs/outputs(skills) | LLM 从 SKILL.md 正文抽取 + 人工校对 |
| status | 默认 approved |

## 7. 萃取流水线(normalizer)

首次全量与增量同一套逻辑:
1. 遍历文档(首次=本地 wiki 副本;后续=新增/更新 md)。
2. **正文原样保留**,不重写。
3. 路径推断 type/domain;取首 `#` 作 title;正文算 content_hash。
4. LLM 补 `tags`/`guide_stage`/`summary`,**归一到 taxonomy.yaml**;skills 另补 `task_types`/`inputs`/`outputs`。
5. 已有 frontmatter 的只补缺失字段,不覆盖 `name`/`description`。
6. 写回带 frontmatter 的 md 到对应分区。

**导航文件例外:** `index.md`/`README.md` 保留原样作导航,不视为条目、不强制 frontmatter、不进索引;`.gitkeep` 忽略。
**幂等:** content_hash 未变则跳过 LLM 与写回。

## 8. 检索设计(面向引导)

- `indexer` 扫全部 frontmatter → `.index/knowledge.json`(id/type/domain/tags/guide_stage/summary/source_path/content_hash/status;skills 另含 task_types/inputs/outputs)。正文不入索引。
- `search_knowledge` 支持按 **`tags`(决策节点 related_tags)+ `guide_stage`(需求缺口所处阶段)+ `task_type`/`domain`** 结构化过滤,再对 title/tags/summary 关键词/BM25 排序;`deprecated` 剔除。
- 返回条目**带 source_path + content_hash**,agent 引用方法论时可溯源。
- 主调用姿势:引导循环里 `search_knowledge(tags=D_x.related_tags, guide_stage=…, task_type=…)`。

## 9. 能力层:skills → registry

- `indexer` 把 `skills/*/SKILL.md` 的 frontmatter(含补齐的 task_types/inputs/outputs)派生进 `skill-registry.yaml`;router 只读派生结果,精准路由。
- registry 从此**只读派生**,不手写(消除现有手写 registry 与 SKILL.md 不同步的隐患)。
- `resolve_skill(name)` 定位 SKILL.md 文件夹,交 agent 现有三层渐进加载执行(SKILL.md→references→scripts)。
- generate-* 类是主力:需求收敛后产出调研方案与子产物。

## 10. 运行时集成:引导链路 API 消费点

| 链路节点 | 调用 | 用途 |
|---|---|---|
| 意图识别 | (可选) list_skills / domain 语义 | 辅助判定 task_type/domain |
| 引导循环·每个决策节点 | **search_knowledge(related_tags, guide_stage)** | 召回引导框架,驱动提问/建议 |
| 能力路由 | router 读派生 skill-registry | 按 task_types 激活 generate-* 等 |
| 方案产出 | **resolve_skill(name)** → 加载执行 | 生成完整调研方案 |
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

## 14. 已定默认(评审确认,可推翻)

1. **全量导入** 162 篇(约 114 知识条目 + 21 skills),靠 status 后续筛。
2. **镜像 wiki 目录**并入 knowledge-base。
3. **registry 改为 indexer 派生**。
4. **新增 taxonomy.yaml 受控词表**,tags/guide_stage 强约束并对齐 decision-graph.related_tags。
5. **skills 补 task_types/inputs/outputs**(靠 LLM 抽取 + 人工校对)。

## 15. 验收标准

1. 知识/能力条目(约 114 + 21)全部导入,带合法 frontmatter,`tags`/`guide_stage` 均在 taxonomy.yaml 内,linter 全绿;导航文件保留不强制 frontmatter。
2. `taxonomy.yaml` 覆盖 decision-graph 全部 related_tags;每个决策节点的 related_tags 都能 `search_knowledge` 召回到相关条目。
3. `.index/knowledge.json` 与派生 `skill-registry.yaml` 由 indexer 生成,与 frontmatter 一致;registry 条目含 task_types/inputs/outputs。
4. 引导循环可用:给定某决策节点的 related_tags + guide_stage,`search_knowledge` 返回可用于引导的 model/method 并带来源。
5. `resolve_skill('generate-research-plan')` 能定位并加载,产出调研方案。
6. normalizer 幂等;frontmatter linter 能拦截缺字段/id 重复/tag 越界/hash 不匹配。
