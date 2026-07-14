# 用研知识库系统 设计文档

- 日期:2026-07-15
- 状态:待实现(spec 已评审)
- 归属:用研 AI 专项 · 经验记忆层(三层记忆中的第二层)

## 1. 背景与目标

用研 AI 专项需要一个**大模型可调用**的用户研究知识库,把外部优秀知识库(JD Design Wiki 的 `user-research` 目录,162 个 md)中的方法论、模型、规范、可执行技能萃取为本地可持续维护、可检索的系统。

参考源已下载至本地:`references/2C-DesignWiki/jd-design-system-md-v16/horizontal/user-research/`,构成为:

| 分区 | 数量 | 性质 | frontmatter 现状 |
|---|---|---|---|
| `skills/` | 21 个 SKILL.md | 可执行技能(SKILL.md + references/skeleton,journey-map 带 python 脚本) | 有 `name`/`description`/`license` |
| `models/` | 22 | 理论模型(JTBD/Kano/ORID…) | 无 |
| `methods/toolbox/` | 75 | 方法卡片(collection 35 + analysis 40) | 无 |
| `methods/standards/` | 11 | 研究规范(抽样/访谈/问卷/报告…) | 无 |
| `methods/scenarios/` | 6(+若干 `.gitkeep` 占位) | 场景化研究路径 | 无 |

**核心目标:**
1. 建立**两层**内容体系:知识层(可检索)+ 能力层(可调用)。
2. 以 **git-markdown 为唯一真相源**,人可直接读写、可做 PR review。
3. 检索用**结构化过滤 + 关键词/BM25**,不引向量(YAGNI,留触发条件)。
4. 一套**萃取流水线**处理首次全量导入与后续增量,忠实搬运原文、只补齐元数据。
5. 核心库对本项目 orchestrator **内部直调**,接口形态预留未来 MCP 薄壳。

## 2. 范围

**In scope:**
- 目录布局、统一元数据 schema、萃取流水线、indexer、检索核心库 API、能力层派生、维护闸门(linter)。
- 首次全量导入 162 篇。

**Out of scope(明确不做):**
- MCP server(留薄壳口子,本期不实现)。
- pgvector / embedding 语义检索(二期,触发条件见 §11)。
- LLM 重构正文(仅忠实搬运 + 元数据补齐)。
- 知识图谱、复杂标签本体。

## 3. 总体架构

```
知识层(可检索)                 能力层(可调用)
models/ methods/ *.md      →     skills/*/SKILL.md
        │                              │
        │   frontmatter = 唯一元数据真相源      │
        ▼                              ▼
        indexer(构建期扫描 frontmatter → 派生索引)
        │                              │
        ▼                              ▼
   .index/knowledge.json        skill-registry.yaml(派生,非手写)
        │                              │
        └──────────── 核心库 API ───────┘
       search_knowledge / get_entry / list_skills / resolve_skill
                        │
                orchestrator 直调(MCP 薄壳 = 后话)
```

**关键原则:frontmatter 是唯一真相源。** `skill-registry.yaml` 与检索索引均由 indexer 从 frontmatter 派生,人不手写 registry,消除"两处不同步"隐患(现有手写 `orchestrator/skill-registry.yaml` 的问题)。

## 4. 目录布局

在现有 `knowledge-base/` 下按 wiki 成熟分类法重组,现有 2 篇(`methods/competitive-research-method.md`、`cases/live_competitive_001.md`)并入对应分区:

```
knowledge-base/
├── models/                     # 理论模型
├── methods/
│   ├── scenarios/              # 场景化研究路径
│   ├── standards/              # 研究规范
│   └── toolbox/
│       ├── collection/         # 数据收集方法
│       └── analysis/           # 数据分析方法
├── skills/                     # 21 个 SKILL.md 文件夹(能力层源,含 references/ 与 scripts/)
└── .index/                     # indexer 产出(纳入 git,见 §8)
```

图片等资源随文档就近存放(沿用 wiki 的 `images/` 惯例)。

## 5. 统一元数据 Schema

合并 wiki 的简洁风格与本项目治理字段。以 frontmatter 承载,是 indexer 与检索的唯一输入。

### 5.1 知识条目(models / methods)

```yaml
id: model_jtbd                 # 稳定主键,全库唯一
type: model                    # model | standard | toolbox-collection | toolbox-analysis | scenario
title: JTBD (Jobs To Be Done)
domain: general                # 由路径推断,可手动覆盖
tags: [need-analysis, framework]   # 规则 + 轻量 LLM 补
summary: 从"用户雇佣产品完成任务"视角理解需求的框架   # 一句话,LLM 生成,供检索
source: xingyun_wiki           # 来源渠道
source_path: models/jtbd.md    # 相对 knowledge-base/ 的原始路径
content_hash: sha256:…         # 正文 hash,溯源 + 变更检测(context linter 硬要求)
status: approved               # draft | approved | deprecated
updated_at: 2026-07-15
```

### 5.2 能力条目(skills)

保留 wiki 原有字段,补路由字段:

```yaml
name: competitive-analysis     # 保留 wiki 约定,作为调用标识
description: 竞品分析技能。当用户需要系统对比竞品能力…   # 保留,供路由 LLM 理解边界
domain: general                # 补
tags: [competitive, analysis]  # 补
type: skill
content_hash: sha256:…         # 补,含 SKILL.md 与 references/
status: approved
updated_at: 2026-07-15
```

### 5.3 字段生成规则

| 字段 | 来源 |
|---|---|
| `type` / `domain` | 路径推断(`toolbox/analysis/rfm.md` → type=toolbox-analysis) |
| `id` | 由 type + 文件名生成(如 `model_jtbd`),冲突时报错 |
| `content_hash` | 对正文(去 frontmatter)算 sha256 |
| `title` | 取正文首个 `#` 标题 |
| `tags` / `summary` | 轻量 LLM 生成,可人工修正 |
| `status` | 默认 `approved`(导入自成熟 wiki),后续人工调整 |

## 6. 萃取流水线(normalizer)

一个可复用脚本,首次全量与后续增量**同一套逻辑**:

1. 遍历目标文档(首次 = 本地 wiki 副本;后续 = 新增/更新的 md)。
2. **正文原样保留**,不重写、不摘要正文。
3. 路径推断 `type` / `domain`。
4. 取首个 `#` 作 `title`,对正文算 `content_hash`。
5. 轻量 LLM 只补 `tags` + 一句 `summary`(失败可留空,不阻断)。
6. 已有 frontmatter 的(skills)只补缺失字段,不覆盖 `name`/`description`。
7. 写回带 frontmatter 的 md 到 `knowledge-base/` 对应分区。

**导航文件例外:** `index.md`、`README.md` 等目录/导读文件保留原样作导航,**不视为知识条目、不强制 frontmatter、不进检索索引**;`.gitkeep` 占位忽略。

**幂等:** `content_hash` 未变的文档跳过 LLM 与写回。

## 7. 检索设计(核心库)

- `indexer` 扫描全部 frontmatter,产出 `.index/knowledge.json`:数组,每项含 `id/type/domain/tags/summary/source_path/content_hash/status`。正文不入索引(按需读文件)。
- `search_knowledge`:先按 `task_type→type` / `domain` / `tags` **结构化过滤**,再对 `title`/`tags`/`summary` 做**关键词/BM25** 兜底排序;`status=deprecated` 降权/剔除。
- 返回条目**带 `source_path` + `content_hash`**,供报告标注来源(呼应 context linter 来源要求)。
- 命中后按需读原文进 context;条目少时可全量摘要进 context。

## 8. 能力层:skills → registry

- `skills/*/SKILL.md` 的 frontmatter 经 indexer 派生为 `orchestrator/skill-registry.yaml` 条目(name/description/domain/tags/path/hash/status)。
- registry 从此**只读派生**,不手写。
- `resolve_skill(name)` 定位 SKILL.md 文件夹路径,交由 orchestrator 现有加载机制执行(三层渐进加载:registry → SKILL.md → references/scripts)。
- `.index/` 与派生的 registry **纳入 git**(可 diff、可追溯构建产物),但由 indexer 生成,不手改。

## 9. 可持续维护:git PR + linter 双闸

- 新增一个 **frontmatter linter**,沿用 `harness/linters/registry-linter.ts` 模式,校验:必填字段齐全、`id` 全库唯一、`type` 合法、`content_hash` 与正文匹配、`source_path` 与实际路径一致。
- 流程:作者写/改 md → PR → linter 卡门 → 合并触发 `normalizer`(补新增文档元数据)+ `indexer`(重建索引与 registry)。
- 生命周期:`status`(draft/approved/deprecated)+ `updated_at` 管理;deprecated 条目不召回。

## 10. 核心库 API 契约

```
search_knowledge(query?, task_type?, domain?, tags?, limit?) -> Entry[]   # 带 source_path+hash
get_entry(id) -> { frontmatter, content }                                  # 按需读原文
list_skills(domain?, tags?) -> SkillMeta[]
resolve_skill(name) -> { path, frontmatter }                               # 供 orchestrator 加载执行
```

MCP 薄壳(后话):把以上四个函数一一映射为 MCP tool 即可,核心逻辑不改。

## 11. 二期 / YAGNI 边界

升级到 **pgvector 语义检索**的触发条件(满足其一再做):
- 知识条目 > 200 且结构化过滤 + 关键词召回准确率不足;
- 出现跨条目语义关联检索的真实需求。

其余不做:MCP、LLM 正文重构、知识图谱、embedding、复杂标签本体。

## 12. 已定默认(评审时确认,可推翻)

1. **全量导入** 162 篇,靠 `status` 后续筛,而非先人工挑子集。
2. **镜像 wiki 目录**,而非塞进现有 `methods/cases` 两层。
3. **registry 改为 indexer 派生**,动了现有手写 `skill-registry.yaml` 的约定。

## 13. 验收标准

1. 全部**知识/能力条目**(约 114 篇 models/methods + 21 skills)导入 `knowledge-base/` 对应分区,均带合法 frontmatter,linter 全绿;导航文件(index.md/README)保留但不强制 frontmatter。
2. `.index/knowledge.json` 与派生 `skill-registry.yaml` 由 indexer 生成,与 frontmatter 一致。
3. `search_knowledge` 能按 domain/tags/关键词召回相关条目并带 source_path+hash。
4. `list_skills` / `resolve_skill` 能列出并定位 21 个技能。
5. normalizer 幂等:重复跑对未变文档不改写。
6. frontmatter linter 能拦截缺字段 / id 重复 / hash 不匹配。
