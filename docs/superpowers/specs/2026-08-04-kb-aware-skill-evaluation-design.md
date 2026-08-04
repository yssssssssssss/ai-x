# KB-aware Skill 两轮对照评测设计

## 目标

在现有 Skill-only 基线之上，评估 22 个 active Skill 在使用 `research-wiki` 正典后的能力，区分：

1. Skill 是否能正确使用已经给定的正典内容；
2. `searchKnowledge()` / `getEntry()` 是否能召回并提供正确正典；
3. 输出是否保留来源、状态和证据边界。

本设计不替换现有隔离基线。现有基线保留为 Round 0；KB-aware 新增 Round A 与 Round B。

## 已确认决策

- 使用两轮对照：Round A 固定正典上下文，Round B 实时知识检索链路。
- 两轮使用相同的 22 个合成 case、相同模型、相同 Skill 正文和相同基础评分卡。
- 首轮固定使用当前 Gateway 基线模型 GPT-5.4；GPT-5.6 另建独立运行，不与本轮混合。
- 原有 100 分评分维度和权重不变，保证 Round 0/A/B 可比较。
- KB 评估以独立 `kb_assessment` 记录，不把知识检索误差隐式混入基础 Skill 分数。
- `draft` 正典允许进入评测，但必须记录状态警告；不得把 draft 来源表述为已评审标准。
- `deprecated` 来源禁止作为 required 正典使用。
- 4 个原生 Skill 没有明确 wiki 正典映射，不强行注入知识；其 KB 状态为 `not_applicable`，仍保留 Tool/证据边界检查。

## 当前知识库事实

- 总路由和四区定义见 `knowledge-base/README.md`。
- 知识索引为 `knowledge-base/.index/knowledge.json`。
- 索引结构包含 `source_path`、`content_hash`、`status`、`guide_tags` 等字段，见 `apps/orchestrator-runtime/src/knowledge/indexer.ts`。
- `searchKnowledge()` 和 `getEntry()` 是当前知识检索接口，见 `apps/orchestrator-runtime/src/knowledge/index.ts`。
- 生产规划器已按决策节点 `related_tags` 召回 guidance，见 `apps/orchestrator-runtime/src/planners/routed-planner.ts`。
- 当前固定正典文件大多为 `status: draft`；本轮必须保留这个事实，不得改写为 reviewed/approved。
- 已核验的缺失或冲突来源必须进入 `unresolved_items`，不能猜路径：
  - `methods/competitive-research-method.md`
  - `models/aarrr.md`
  - `models/fogg-behavior-model.md`
  - `methods/toolbox/analysis/ipa-matrix.md`
  - `models/kano.md` 在仓库存在，但部分 SKILL.md 仍声明缺失，需记录为 source contradiction
  - 动态占位 `<主题>`、`<业务线>`、parent-only 裸文件名不能自动补全

## Round A：固定正典上下文

### 目的

隔离检索质量，只测 Skill 是否能正确理解、引用和应用人工核准的正典。

### 流程

```text
KB snapshot
  -> per-skill mapping
  -> 读取 required/conditional source 正文
  -> 注入固定 knowledge_context
  -> Skill 生成
  -> 基础 schema 校验
  -> KB 来源检查
  -> 独立评分
```

Round A 不调用 `searchKnowledge()`，也不依赖网络或外部 Tool。每个 Skill 使用的 source 集合由 mapping manifest 固定。

## Round B：实时知识检索链路

### 目的

评估知识索引、标签召回、正文读取、来源追踪和 Skill 使用正典的完整链路。

### 流程

```text
KB snapshot
  -> retrieval recipe
  -> searchKnowledge()
  -> candidate source list
  -> getEntry() 读取候选正文
  -> 选择 required/conditional sources
  -> 注入 knowledge_context
  -> Skill 生成
  -> retrieval/provenance 校验
  -> 独立评分
```

Round B 必须记录候选来源和最终使用来源，不能只记录最终 prompt。

## Skill-to-canon Mapping Manifest

新增一份机器可读映射，22 个 active Skill 一条且仅一条：

```ts
interface SkillKnowledgeMapping {
  skill_id: string;
  kb_mode: 'required' | 'not_applicable' | 'manual_review';
  required_sources: KnowledgeSourceRule[];
  conditional_sources: KnowledgeSourceRule[];
  optional_sources: KnowledgeSourceRule[];
  retrieval_tags: string[];
  source_status_policy: 'draft_allowed_with_warning' | 'reviewed_required' | 'not_applicable';
  unresolved_items: string[];
}

interface KnowledgeSourceRule {
  path: string;
  role: 'standard' | 'method' | 'model' | 'asset' | 'template' | 'one_of';
  trigger?: string;
  status?: string;
}
```

### 映射规则

1. `required_sources` 只收 SKILL.md 明确写为必读、硬门禁或唯一出处的文件。
2. 条件来源放进 `conditional_sources`，并记录触发条件；不得无条件注入所有可选材料。
3. `<主题>`、`<业务线>` 等动态路径不写成伪固定文件，放进 `unresolved_items`。
4. parent-only 裸文件名必须人工核准目录后才能升级为 required path。
5. `references/*.md`、Skill 自带 skeleton、渲染器脚本不是 research-wiki 正典，不列入 required source。
6. `structure-interview-transcript` 的 ORID 与 qualitative-insight-frameworks 是 `one_of` 条件来源，不能两者强制同时读取。
7. 4 个原生 Skill：
   - `digital-human-competitive-analysis`
   - `competitive-web-research`
   - `competitive-app-analysis`
   - `design-experience-review`

   当前没有明确 wiki required source，标记 `not_applicable` 或 `manual_review`，不为它们猜测方法来源。
8. 18 个 KB Skill 必须有映射；其中 `guide_tags` 为空的 Skill 依赖显式 path mapping，不能只靠标签检索。

## KB Snapshot

每轮运行前生成并冻结 snapshot：

```ts
interface KnowledgeSnapshot {
  snapshot_id: string;
  index_path: string;
  index_hash: string;
  built_at: string;
  source_files: Array<{
    path: string;
    content_hash: string;
    status: string;
  }>;
}
```

要求：

- Round A/B 使用相同 snapshot；
- snapshot hash 写入总 manifest；
- source 内容变化必须产生新的 snapshot；
- `deprecated` source 不得满足 required source；
- `draft` source 可用于本轮，但必须在 `status_warnings` 中记录；
- 缺失 required source 不得静默降级为通用经验。

## Knowledge Context 注入契约

```ts
interface KnowledgeContextItem {
  source_id: string;
  title: string;
  source_path: string;
  content_hash: string;
  status: string;
  role: 'required' | 'conditional' | 'optional' | 'candidate';
  content: string;
}

interface KnowledgeContext {
  mode: 'gold' | 'live';
  snapshot_id: string;
  required_source_ids: string[];
  selected_source_ids: string[];
  items: KnowledgeContextItem[];
}
```

生成 prompt 必须明确：

- `knowledge_context` 是本次可用的正典上下文；
- source status 为 draft 时不得称为已评审标准；
- 未出现在 context 的来源不得伪造引用；
- 无正典支撑的判断必须标 `llm_inference` 或 `pending_human_review`。

## Per-Skill 产物

每个 Skill 目录新增：

```text
<skill-id>/
├── input.json
├── knowledge-context.json
├── retrieval.json       # Round B 必有，Round A 记录 gold mapping
├── output.json
├── output.md
├── scorecard.json
├── kb-assessment.json
└── error.json            # 失败时存在
```

`retrieval.json` 至少记录：

- mode
- query / guide_tags
- candidate source IDs
- selected source IDs
- required source recall
- source hash
- missing/unresolved source

## KB Assessment

基础 `scorecard.json` 保持现有 100 分规则不变。新增独立文件：

```ts
interface KBAssessment {
  skill_id: string;
  mode: 'gold' | 'live';
  required_sources_available: boolean;
  required_source_ids: string[];
  selected_source_ids: string[];
  missing_required_source_ids: string[];
  cited_source_ids: string[];
  unsupported_canonical_claims: string[];
  draft_sources_used: string[];
  retrieval_recall: number | null;
  kb_grounding_verdict: 'pass' | 'needs_review' | 'fail' | 'not_applicable';
  status_warnings: string[];
  review_notes: string[];
}
```

### KB 判定

- `pass`：required source 可用、被正确使用并被引用，无 unsupported canonical claim；draft 不改变 grounding verdict，仅增加 `status_warnings`。
- `needs_review`：缺少部分引用、存在 unresolved mapping、retrieval 不完整，或需要人工核准 source mapping。
- `fail`：required source 缺失，或 Skill 将不在 context 的内容伪装成正典结论。
- `not_applicable`：当前没有明确 wiki source mapping 的原生 Skill。

### 基础分数仍按原规则

- workflow adherence：20
- method correctness：20
- completeness structure：20
- evidence boundaries：15
- actionability：15
- risk boundary handling：10

KB 结果不覆盖基础分数，而是和基础分数并列展示：

```text
base_score: 84
base_verdict: pass
kb_grounding_verdict: needs_review
```

## 失败和边界场景

必须测试：

1. index 不存在；
2. snapshot source 文件不存在；
3. required source 为 deprecated；
4. required source 为 draft；
5. 实时召回为空；
6. 召回错误 source；
7. source 正文读取失败；
8. Skill 未引用任何 required source；
9. Skill 引用了不存在 source；
10. 将 draft source 写成正式标准；
11. 无 source 依据却生成 canonical claim；
12. KB context 超出模型上下文；
13. Round A/B 使用不同 snapshot；
14. 原生 Skill 无 mapping 时不应被伪造为 KB fail；
15. 评分模型失败时保留原始输出和 KB retrieval 记录。

## 验收标准

### Mapping

- 22 个 active Skill 恰好 22 条 mapping；
- 18 个 KB Skill 有 required/conditional source mapping；
- 4 个原生 Skill 显式标记 `not_applicable` 或 `manual_review`；
- 所有固定 source path 可核验；动态/缺失/冲突路径进入 unresolved；
- source status 与实际 frontmatter 一致。

### Round A

- 22 个 Skill 都生成 knowledge-context；
- required source 选择完全由 mapping 决定；
- 每个 source 有 path、hash、status；
- 每个 KB Skill 都生成 `kb-assessment.json`；
- source 使用缺陷能被测试识别。

### Round B

- 22 个 Skill 都有 retrieval.json；
- candidate/selected source 可追踪；
- index/source hash 写入 manifest；
- retrieval 空、错召回、正文失败都能单项降级，不中断批次；
- Round A/B 使用相同 model、case 和 snapshot。

### 对照报告

新增总览字段：

- Round A/B 的 base score；
- Round A/B 的 base verdict；
- Round A/B 的 kb_grounding_verdict；
- required source recall；
- draft warning 数；
- missing/unresolved source 数；
- 结果差异及人工复核项。

## 不做的事情

- 不把 draft source 自动改成 reviewed；
- 不把缺失路径用通用常识补齐；
- 不把原生 Skill 强行绑定到未声明的 wiki 文档；
- 不把 Round A/B 分数合并成一个不可解释的总分；
- 不在本阶段接入真实用户材料、生产 PII 或外部网络；
- 不把 retrieval recall 当作 Skill 内容质量分数。

## 主要风险

- 当前 canonical source 大多为 draft，KB verdict 可能普遍为 needs_review；这是知识库成熟度信号，不应误判为 Skill 生成失败。
- 18 个 KB Skill 的部分映射包含动态业务线、主题或 parent-only 路径，必须保留 unresolved，不可自动猜测。
- Round B 的实时召回会将检索误差和模型误差同时带入；Round A 是必要对照。
- 当前独立 Eval Runner 与生产 Skill 执行路径不是同一链路；KB-aware 结果应明确标注评测模式。
