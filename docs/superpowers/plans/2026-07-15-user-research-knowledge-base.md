# 用研知识库系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把外部用研 wiki(162 篇 md)萃取为本地 git-markdown 知识库,供引导 agent 按决策节点召回方法论、按 name 调用 skill。

**Architecture:** frontmatter 为唯一真相源;normalizer 忠实搬运+补元数据;indexer 派生检索索引与 skill-registry;核心库 API(search_knowledge/get_entry/list_skills/resolve_skill)供 orchestrator 直调。tags/guide_stage 对齐 decision-graph.related_tags 受控词表。

**Tech Stack:** TypeScript + Node≥20(ESM);`yaml` 解析;`node:test`+`node:assert/strict`;`node:crypto` 算 hash;现有 `config-loader.ts` 路径解析模式。

## Global Constraints

- 运行时 ESM,导入用 `.ts` 扩展名(tsconfig `allowImportingTsExtensions`)。
- 测试用 `node:test` + `node:assert/strict`,跑法 `tsx --test tests/<name>.test.ts`。
- 不引向量/embedding/MCP/知识图谱(YAGNI)。
- 正文忠实搬运,不重写;导航文件(index.md/README.md)不视为条目;`.gitkeep` 忽略。
- 知识条目 `tags`/`guide_stage` 非空项必须 ∈ `knowledge-base/taxonomy.yaml`。
- 路径解析基于仓库根,复用 `config-loader.ts` 的 `REPO_ROOT` 模式。
- 核心库放 `apps/orchestrator-runtime/src/knowledge/`;内容放 `knowledge-base/`;linter 放 `harness/linters/`。

---

### Task 1: 受控词表 taxonomy.yaml + 加载器

**Files:**
- Create: `knowledge-base/taxonomy.yaml`
- Create: `apps/orchestrator-runtime/src/knowledge/taxonomy.ts`
- Test: `tests/knowledge-taxonomy.test.ts`

**Interfaces:**
- Produces: `loadTaxonomy(): { tags: string[]; guide_stages: string[] }`;`kbPath(...segs): string`(仓库根拼路径,供后续任务复用)。

- [ ] **Step 1: 写受控词表**

`knowledge-base/taxonomy.yaml`:
```yaml
# 受控标签词表。tags 必须涵盖 decision-graph.yaml 全部 related_tags(否则"节点→条目"召回断裂)。
# guide_stage: 引导阶段枚举。normalizer 补元数据须归一到本表,linter 卡越界。
version: 1
tags:
  - research_goal
  - persona
  - audience
  - method
  - ux-audit
  - a11y
  - ui-competitive
  - business-competitive
  - digital_human
  - privacy
  - compliance
  - output
  - report
  - framework
  - qualitative
  - quantitative
guide_stages:
  - intent
  - goal-definition
  - need-discovery
  - method-selection
  - output-standard
```

- [ ] **Step 2: 写加载器**

`apps/orchestrator-runtime/src/knowledge/taxonomy.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 从 apps/orchestrator-runtime/src/knowledge/ 回到仓库根
const REPO_ROOT = resolve(__dirname, '../../../../');

export function kbPath(...segs: string[]): string {
  return join(REPO_ROOT, ...segs);
}

export interface Taxonomy {
  tags: string[];
  guide_stages: string[];
}

export function loadTaxonomy(): Taxonomy {
  const raw = readFileSync(kbPath('knowledge-base/taxonomy.yaml'), 'utf8');
  const parsed = parseYaml(raw) as { tags?: string[]; guide_stages?: string[] };
  return { tags: parsed.tags ?? [], guide_stages: parsed.guide_stages ?? [] };
}
```

- [ ] **Step 3: 写失败测试**

`tests/knowledge-taxonomy.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy } from '../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';
import { loadDecisionGraph } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

test('taxonomy 覆盖 decision-graph 全部 related_tags', () => {
  const { tags } = loadTaxonomy();
  const tagSet = new Set(tags);
  const { nodes } = loadDecisionGraph();
  const missing: string[] = [];
  for (const n of nodes) {
    for (const t of n.related_tags ?? []) {
      if (!tagSet.has(t)) missing.push(`${n.key}:${t}`);
    }
  }
  assert.deepEqual(missing, [], `taxonomy 缺 related_tags: ${missing.join(', ')}`);
});

test('guide_stages 五阶段齐全', () => {
  const { guide_stages } = loadTaxonomy();
  assert.deepEqual(
    guide_stages,
    ['intent', 'goal-definition', 'need-discovery', 'method-selection', 'output-standard'],
  );
});
```

- [ ] **Step 4: 跑测试**

Run: `npx tsx --test tests/knowledge-taxonomy.test.ts`
Expected: PASS(2 tests)。若 FAIL 提示缺 related_tags,把缺的 tag 加进 taxonomy.yaml。

- [ ] **Step 5: 提交**

```bash
git add knowledge-base/taxonomy.yaml apps/orchestrator-runtime/src/knowledge/taxonomy.ts tests/knowledge-taxonomy.test.ts
git commit -m "feat(kb): 受控词表 taxonomy.yaml + 加载器"
```

---

### Task 2: frontmatter 解析/序列化

**Files:**
- Create: `apps/orchestrator-runtime/src/knowledge/frontmatter.ts`
- Test: `tests/knowledge-frontmatter.test.ts`

**Interfaces:**
- Produces: `parseFrontmatter(md: string): { frontmatter: Record<string, unknown>; content: string }`;`serializeFrontmatter(fm: Record<string, unknown>, content: string): string`。

- [ ] **Step 1: 写失败测试**

`tests/knowledge-frontmatter.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, serializeFrontmatter } from '../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';

test('解析带 frontmatter 的 md', () => {
  const md = '---\nid: model_jtbd\ntags: [persona]\n---\n\n# JTBD\n\n正文';
  const { frontmatter, content } = parseFrontmatter(md);
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.deepEqual(frontmatter.tags, ['persona']);
  assert.equal(content, '# JTBD\n\n正文');
});

test('无 frontmatter 的 md 返回空 frontmatter + 原文', () => {
  const md = '# 标题\n\n正文';
  const { frontmatter, content } = parseFrontmatter(md);
  assert.deepEqual(frontmatter, {});
  assert.equal(content, '# 标题\n\n正文');
});

test('round-trip: 序列化后再解析不丢字段', () => {
  const fm = { id: 'model_jtbd', type: 'model', tags: ['persona', 'framework'] };
  const content = '# JTBD\n\n正文';
  const { frontmatter } = parseFrontmatter(serializeFrontmatter(fm, content));
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.deepEqual(frontmatter.tags, ['persona', 'framework']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/knowledge-frontmatter.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

`apps/orchestrator-runtime/src/knowledge/frontmatter.ts`:
```typescript
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// frontmatter = 文件开头 ---\n...\n--- 之间的 YAML。无则视为纯正文。
const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(md: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const m = md.match(FM_RE);
  if (!m) return { frontmatter: {}, content: md.trim() };
  const frontmatter = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  const content = md.slice(m[0].length).trim();
  return { frontmatter, content };
}

export function serializeFrontmatter(
  fm: Record<string, unknown>,
  content: string,
): string {
  const yaml = stringifyYaml(fm).trimEnd();
  return `---\n${yaml}\n---\n\n${content.trim()}\n`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/knowledge-frontmatter.test.ts`
Expected: PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator-runtime/src/knowledge/frontmatter.ts tests/knowledge-frontmatter.test.ts
git commit -m "feat(kb): frontmatter 解析/序列化"
```

---

### Task 3: normalizer 机械骨架(路径推断 + hash + 幂等)

**Files:**
- Create: `apps/orchestrator-runtime/src/knowledge/normalizer.ts`
- Test: `tests/knowledge-normalizer.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`/`serializeFrontmatter`(Task 2)。
- Produces: `inferTypeDomain(relPath): { type: string; domain: string } | null`(导航文件返回 null);`contentHash(content): string`;`normalizeEntry(relPath, rawMd): { md: string; changed: boolean }`。

- [ ] **Step 1: 写失败测试**

`tests/knowledge-normalizer.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTypeDomain, contentHash, normalizeEntry } from '../apps/orchestrator-runtime/src/knowledge/normalizer.ts';
import { parseFrontmatter } from '../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';

test('路径推断 type/domain', () => {
  assert.deepEqual(inferTypeDomain('models/jtbd.md'), { type: 'model', domain: 'general' });
  assert.deepEqual(inferTypeDomain('methods/toolbox/analysis/rfm.md'), { type: 'toolbox-analysis', domain: 'general' });
  assert.deepEqual(inferTypeDomain('methods/toolbox/collection/interviews.md'), { type: 'toolbox-collection', domain: 'general' });
  assert.deepEqual(inferTypeDomain('methods/standards/sampling.md'), { type: 'standard', domain: 'general' });
  assert.equal(inferTypeDomain('models/index.md'), null, '导航文件返回 null');
  assert.equal(inferTypeDomain('README.md'), null);
});

test('skills 下只有 SKILL.md 是条目, skeleton 返回 null', () => {
  assert.deepEqual(inferTypeDomain('skills/competitive-analysis/SKILL.md'), { type: 'skill', domain: 'general' });
  assert.equal(inferTypeDomain('skills/competitive-analysis/references/competitive-analysis-skeleton.md'), null);
});

test('scenarios 从二级目录推断 domain', () => {
  assert.deepEqual(
    inferTypeDomain('methods/scenarios/category-consumption/cross-category/churn-user-research.md'),
    { type: 'scenario', domain: 'category-consumption' },
  );
});

test('normalizeEntry 补机械 frontmatter', () => {
  const { md } = normalizeEntry('models/jtbd.md', '# JTBD (Jobs To Be Done)\n\n核心概念…');
  const { frontmatter } = parseFrontmatter(md);
  assert.equal(frontmatter.type, 'model');
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.equal(frontmatter.title, 'JTBD (Jobs To Be Done)');
  assert.equal(frontmatter.source_path, 'models/jtbd.md');
  assert.match(String(frontmatter.content_hash), /^sha256:/);
  assert.equal(frontmatter.status, 'approved');
});

test('幂等: content_hash 未变则 changed=false', () => {
  const first = normalizeEntry('models/jtbd.md', '# JTBD\n\n正文');
  const second = normalizeEntry('models/jtbd.md', first.md);
  assert.equal(second.changed, false, '已归一的文档再跑不应变更');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/knowledge-normalizer.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

`apps/orchestrator-runtime/src/knowledge/normalizer.ts`:
```typescript
import { createHash } from 'node:crypto';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { seedTagsGuideStage, seedSkillTaskTypes } from './seed.ts';

const NAV_FILES = new Set(['index.md', 'readme.md']);

// 路径 → type/domain。导航文件返回 null(不视为条目)。
export function inferTypeDomain(relPath: string): { type: string; domain: string } | null {
  const parts = relPath.split('/');
  const file = parts[parts.length - 1].toLowerCase();
  if (NAV_FILES.has(file)) return null;

  if (parts[0] === 'models') return { type: 'model', domain: 'general' };
  // skills 下只有 <name>/SKILL.md 是条目;references/*.md、scripts/* 是 skill 的一部分, 不单独索引
  if (parts[0] === 'skills') {
    return file === 'skill.md' ? { type: 'skill', domain: 'general' } : null;
  }
  if (parts[0] === 'methods') {
    if (parts[1] === 'standards') return { type: 'standard', domain: 'general' };
    if (parts[1] === 'toolbox' && parts[2] === 'analysis') return { type: 'toolbox-analysis', domain: 'general' };
    if (parts[1] === 'toolbox' && parts[2] === 'collection') return { type: 'toolbox-collection', domain: 'general' };
    if (parts[1] === 'scenarios') return { type: 'scenario', domain: parts[2] ?? 'general' };
  }
  return null;
}

export function contentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content.trim(), 'utf8').digest('hex');
}

function fileStem(relPath: string): string {
  const file = relPath.split('/').pop() ?? relPath;
  return file.replace(/\.md$/i, '');
}

function firstHeading(content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fileStem(content);
}

// 补机械 frontmatter + 规则种子 tags/guide_stage。正文原样保留。
export function normalizeEntry(relPath: string, rawMd: string): { md: string; changed: boolean } {
  const td = inferTypeDomain(relPath);
  if (!td) return { md: rawMd, changed: false }; // 导航文件不处理

  const { frontmatter: existing, content } = parseFrontmatter(rawMd);
  const hash = contentHash(content);
  const title = firstHeading(content);
  const stem = fileStem(relPath);
  const id = `${td.type.replace(/-/g, '_')}_${stem.replace(/-/g, '_')}`;
  const seed = seedTagsGuideStage(td.type, stem, title);

  // 已有字段不覆盖(尤其 skills 的 name/description 与人工修正过的 tags)
  const fm: Record<string, unknown> = {
    id: existing.id ?? id,
    type: existing.type ?? td.type,
    title: existing.title ?? title,
    domain: existing.domain ?? td.domain,
    tags: existing.tags ?? seed.tags,
    guide_stage: existing.guide_stage ?? seed.guide_stage,
    summary: existing.summary ?? '',
    source: existing.source ?? 'xingyun_wiki',
    source_path: relPath,
    content_hash: hash,
    status: existing.status ?? 'approved',
    updated_at: existing.updated_at ?? new Date().toISOString().slice(0, 10),
  };

  const changed = existing.content_hash !== hash
    || existing.source_path !== relPath
    || existing.id === undefined;

  // skill 额外补路由字段(spec §6.2):wiki SKILL.md 无 task_types/inputs/outputs
  if (td.type === 'skill') {
    fm.name = existing.name ?? title;
    fm.description = existing.description ?? '';
    fm.task_types = existing.task_types ?? seedSkillTaskTypes(stem, title);
    fm.inputs = existing.inputs ?? [];
    fm.outputs = existing.outputs ?? [];
  }

  const md = serializeFrontmatter(fm, content);
  return { md, changed };
}
```

> 注:`seed.ts`(Task 4)提供 `seedTagsGuideStage`。本任务先建一个最小 stub 让测试跑通,Task 4 再充实。

- [ ] **Step 4: 建 seed.ts 最小 stub**

`apps/orchestrator-runtime/src/knowledge/seed.ts`:
```typescript
// 规则种子:type/文件名/标题 → tags + guide_stage(归一到 taxonomy)。Task 4 充实。
export function seedTagsGuideStage(
  type: string,
  _stem: string,
  _title: string,
): { tags: string[]; guide_stage: string[] } {
  const guide_stage =
    type === 'model' ? ['need-discovery']
    : type === 'standard' ? ['output-standard']
    : type.startsWith('toolbox') ? ['method-selection']
    : type === 'scenario' ? ['intent', 'goal-definition']
    : [];
  return { tags: [], guide_stage };
}

// skill → task_types 种子。Task 4 充实。
export function seedSkillTaskTypes(_stem: string, _title: string): string[] {
  return [];
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/knowledge-normalizer.test.ts`
Expected: PASS(4 tests)。

- [ ] **Step 6: 提交**

```bash
git add apps/orchestrator-runtime/src/knowledge/normalizer.ts apps/orchestrator-runtime/src/knowledge/seed.ts tests/knowledge-normalizer.test.ts
git commit -m "feat(kb): normalizer 机械骨架(路径推断/hash/幂等)"
```

---

### Task 4: 规则种子 tags/guide_stage + taxonomy 归一校验

**Files:**
- Modify: `apps/orchestrator-runtime/src/knowledge/seed.ts`
- Test: `tests/knowledge-seed.test.ts`

**Interfaces:**
- Consumes: `loadTaxonomy`(Task 1)。
- Produces: `seedTagsGuideStage(type, stem, title): { tags: string[]; guide_stage: string[] }`(输出已归一到 taxonomy,越界项丢弃)。

- [ ] **Step 1: 写失败测试**

`tests/knowledge-seed.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedTagsGuideStage, seedSkillTaskTypes } from '../apps/orchestrator-runtime/src/knowledge/seed.ts';
import { loadTaxonomy } from '../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';

test('persona 文件种出 persona tag', () => {
  const r = seedTagsGuideStage('toolbox-collection', 'persona', '用户画像');
  assert.ok(r.tags.includes('persona'), `应含 persona, 实际 ${r.tags}`);
});

test('competitive 文件种出竞品 tag', () => {
  const r = seedTagsGuideStage('toolbox-analysis', 'competitive-analysis', '竞品分析');
  assert.ok(r.tags.includes('business-competitive') || r.tags.includes('ui-competitive'));
});

test('种出的 tags 全部在 taxonomy 内(归一)', () => {
  const { tags } = loadTaxonomy();
  const tagSet = new Set(tags);
  const r = seedTagsGuideStage('model', 'jtbd', 'JTBD');
  for (const t of r.tags) assert.ok(tagSet.has(t), `越界 tag: ${t}`);
});

test('model 落 need-discovery 阶段', () => {
  assert.deepEqual(seedTagsGuideStage('model', 'jtbd', 'JTBD').guide_stage, ['need-discovery']);
});

test('skill task_types 种子: competitive → competitive_research', () => {
  assert.deepEqual(seedSkillTaskTypes('competitive-analysis', '竞品分析'), ['competitive_research']);
});

test('skill task_types 兜底: generate-research-plan → user_research_planning', () => {
  assert.deepEqual(seedSkillTaskTypes('generate-research-plan', '生成研究方案'), ['user_research_planning']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/knowledge-seed.test.ts`
Expected: FAIL(persona tag 断言失败,stub 返回空 tags)。

- [ ] **Step 3: 写实现**

覆盖 `apps/orchestrator-runtime/src/knowledge/seed.ts`:
```typescript
import { loadTaxonomy } from './taxonomy.ts';

// 关键词 → tag 种子表(覆盖 decision-graph related_tags 的可召回性)。
const KEYWORD_TAG: Array<[RegExp, string[]]> = [
  [/persona|画像|人群/i, ['persona', 'audience']],
  [/interview|访谈/i, ['qualitative', 'method']],
  [/survey|questionnaire|问卷|量表/i, ['quantitative', 'method']],
  [/competitive|竞品|对标/i, ['business-competitive', 'ui-competitive']],
  [/a11y|accessibility|无障碍/i, ['a11y', 'ux-audit']],
  [/heuristic|usability|可用性|走查|启发/i, ['ux-audit']],
  [/report|报告|pyramid|金字塔/i, ['report', 'output']],
  [/sampling|抽样|recruit|招募/i, ['audience', 'method']],
  [/goal|目标|question|问题定义|5w2h/i, ['research_goal']],
  [/privacy|隐私|compliance|合规/i, ['privacy', 'compliance']],
  [/digital.?human|数字人/i, ['digital_human']],
  [/jtbd|kano|model|模型|framework|框架/i, ['framework']],
];

const TYPE_GUIDE_STAGE: Record<string, string[]> = {
  model: ['need-discovery'],
  standard: ['output-standard'],
  'toolbox-collection': ['method-selection'],
  'toolbox-analysis': ['method-selection'],
  scenario: ['intent', 'goal-definition'],
  skill: [],
};

export function seedTagsGuideStage(
  type: string,
  stem: string,
  title: string,
): { tags: string[]; guide_stage: string[] } {
  const { tags: vocab, guide_stages } = loadTaxonomy();
  const tagVocab = new Set(vocab);
  const stageVocab = new Set(guide_stages);
  const hay = `${stem} ${title}`;

  const tags = new Set<string>();
  for (const [re, ts] of KEYWORD_TAG) {
    if (re.test(hay)) ts.forEach((t) => tags.add(t));
  }
  // 归一:丢弃 taxonomy 之外的
  const normTags = [...tags].filter((t) => tagVocab.has(t));
  const normStage = (TYPE_GUIDE_STAGE[type] ?? []).filter((s) => stageVocab.has(s));
  return { tags: normTags, guide_stage: normStage };
}

// skill 文件名/标题 → ResearchTask.task_type 种子(供 router 精准路由)。
const SKILL_TASK_TYPE: Array<[RegExp, string[]]> = [
  [/competitive|竞品/i, ['competitive_research']],
  [/satisfaction|voc|feedback|满意度|反馈/i, ['voc_diagnosis']],
  [/accessibility|a11y|无障碍/i, ['a11y_audit']],
  [/heuristic|usability|走查|启发|可用性/i, ['design_audit']],
];

export function seedSkillTaskTypes(stem: string, title: string): string[] {
  const hay = `${stem} ${title}`;
  for (const [re, tt] of SKILL_TASK_TYPE) {
    if (re.test(hay)) return tt;
  }
  // 兜底:generate-*、plan、interview、survey、persona、journey… 归 用研规划
  return ['user_research_planning'];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/knowledge-seed.test.ts && npx tsx --test tests/knowledge-normalizer.test.ts`
Expected: PASS(seed 4 tests + normalizer 4 tests)。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator-runtime/src/knowledge/seed.ts tests/knowledge-seed.test.ts
git commit -m "feat(kb): 规则种子 tags/guide_stage + taxonomy 归一"
```

---

### Task 5: knowledge-linter(frontmatter 校验闸门)

**Files:**
- Create: `harness/linters/knowledge-linter.ts`
- Test: `tests/knowledge-linter.test.ts`

**Interfaces:**
- Consumes: `loadTaxonomy`(Task 1)、`parseFrontmatter`(Task 2)、`contentHash`(Task 3)。
- Produces: `lintEntry(relPath, rawMd, seenIds: Set<string>): LintIssue[]`;`lintKnowledgeBase(): LintIssue[]`(遍历 knowledge-base)。

- [ ] **Step 1: 写失败测试**

`tests/knowledge-linter.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintEntry } from '../harness/linters/knowledge-linter.ts';

const GOOD = [
  '---',
  'id: model_jtbd',
  'type: model',
  'title: JTBD',
  'domain: general',
  'tags: [persona]',
  'guide_stage: [need-discovery]',
  'source: xingyun_wiki',
  'source_path: models/jtbd.md',
  'content_hash: PLACEHOLDER',
  'status: approved',
  'updated_at: 2026-07-15',
  '---',
  '',
  '# JTBD',
  '',
  '正文',
].join('\n');

test('合法条目无 issue', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.deepEqual(issues, []);
});

test('越界 tag 报错', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('tags: [persona]', 'tags: [not_a_real_tag]')
                 .replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.ok(issues.some((i) => i.message.includes('tag')), '应报越界 tag');
});

test('id 重复报错', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const seen = new Set(['model_jtbd']);
  const issues = lintEntry('models/jtbd.md', md, seen);
  assert.ok(issues.some((i) => i.message.includes('id')), '应报 id 重复');
});

test('hash 不匹配报错', () => {
  const md = GOOD.replace('PLACEHOLDER', 'sha256:deadbeef');
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.ok(issues.some((i) => i.message.includes('hash')), '应报 hash 不匹配');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/knowledge-linter.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

`harness/linters/knowledge-linter.ts`:
```typescript
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadTaxonomy, kbPath } from '../../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';
import { parseFrontmatter } from '../../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { contentHash, inferTypeDomain } from '../../apps/orchestrator-runtime/src/knowledge/normalizer.ts';

export interface LintIssue {
  level: 'error';
  target: string;
  message: string;
}

const REQUIRED = ['id', 'type', 'title', 'source_path', 'content_hash', 'status'];

export function lintEntry(relPath: string, rawMd: string, seenIds: Set<string>): LintIssue[] {
  const issues: LintIssue[] = [];
  const tgt = relPath;
  const { tags: vocab, guide_stages } = loadTaxonomy();
  const tagVocab = new Set(vocab);
  const stageVocab = new Set(guide_stages);
  const { frontmatter: fm, content } = parseFrontmatter(rawMd);

  for (const f of REQUIRED) {
    if (fm[f] === undefined || fm[f] === null || fm[f] === '') {
      issues.push({ level: 'error', target: tgt, message: `缺必填字段 "${f}"` });
    }
  }
  const id = fm.id as string | undefined;
  if (id) {
    if (seenIds.has(id)) issues.push({ level: 'error', target: tgt, message: `id 重复: ${id}` });
    else seenIds.add(id);
  }
  for (const t of (fm.tags as string[] | undefined) ?? []) {
    if (!tagVocab.has(t)) issues.push({ level: 'error', target: tgt, message: `越界 tag: ${t}` });
  }
  for (const s of (fm.guide_stage as string[] | undefined) ?? []) {
    if (!stageVocab.has(s)) issues.push({ level: 'error', target: tgt, message: `越界 guide_stage: ${s}` });
  }
  if (fm.source_path && fm.source_path !== relPath) {
    issues.push({ level: 'error', target: tgt, message: `source_path 与实际路径不一致: ${fm.source_path}` });
  }
  if (fm.content_hash && fm.content_hash !== contentHash(content)) {
    issues.push({ level: 'error', target: tgt, message: `content_hash 与正文不匹配` });
  }
  return issues;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '.index' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

export function lintKnowledgeBase(): LintIssue[] {
  const root = kbPath('knowledge-base');
  const seen = new Set<string>();
  const issues: LintIssue[] = [];
  for (const full of walk(root)) {
    const rel = relative(root, full).split('\\').join('/');
    if (inferTypeDomain(rel) === null) continue; // 导航文件跳过
    issues.push(...lintEntry(rel, readFileSync(full, 'utf8'), seen));
  }
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintKnowledgeBase();
  if (issues.length === 0) { console.log('knowledge-linter: OK'); process.exit(0); }
  console.error(`knowledge-linter: ${issues.length} 个问题:`);
  for (const it of issues) console.error(`  [${it.level}] ${it.target} — ${it.message}`);
  process.exit(1);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/knowledge-linter.test.ts`
Expected: PASS(4 tests)。

- [ ] **Step 5: 加 package.json script + 提交**

在 `package.json` 的 `scripts` 加一行:`"lint:knowledge": "tsx harness/linters/knowledge-linter.ts",`

```bash
git add harness/linters/knowledge-linter.ts tests/knowledge-linter.test.ts package.json
git commit -m "feat(kb): frontmatter linter 校验闸门"
```

---

### Task 6: 放宽 config-loader + registry-linter 契约

**Files:**
- Modify: `apps/orchestrator-runtime/src/runtime/config-loader.ts`(SkillRegistryEntry)
- Modify: `harness/linters/registry-linter.ts`(KB skill 不强制 JSON schema)
- Test: `tests/registry-linter.test.ts`(补用例)

**Interfaces:**
- Produces: `SkillRegistryEntry` 新增可选 `entry?: string`;`input_schema?`/`output_schema?` 转可选。

- [ ] **Step 1: 改 SkillRegistryEntry**

`apps/orchestrator-runtime/src/runtime/config-loader.ts` 的接口,把两字段转可选并加 `entry`:
```typescript
export interface SkillRegistryEntry {
  id: string;
  name: string;
  path: string;
  when_to_use: string;
  owner: string;
  input_schema?: string;   // KB skill 为 markdown 过程式, 无 JSON schema
  output_schema?: string;
  entry?: string;          // SKILL.md 文件夹路径(KB 派生)
  risk_level: 'low' | 'medium' | 'high';
  required_tools?: string[];
  domain?: string[];
  task_types?: string[];
  status: 'active' | 'draft' | 'deprecated';
}
```

- [ ] **Step 2: 改 registry-linter 的 active 必填集**

`harness/linters/registry-linter.ts`:把 `SKILL_ACTIVE_REQUIRED` 去掉 `input_schema`/`output_schema`,并把这两个 schema 文件存在性检查改为"仅当字段存在时检查":
```typescript
const SKILL_ACTIVE_REQUIRED: (keyof SkillRegistryEntry)[] = [
  'id', 'name', 'path', 'when_to_use', 'owner', 'risk_level',
];
```
在 `lintSkills` 里,把原无条件的 input_schema/output_schema 检查改成:
```typescript
    if (s.input_schema && !fileExists(s.input_schema)) {
      issues.push({ level: 'error', target: tgt, message: `input_schema 不存在: ${s.input_schema}` });
    }
    if (s.output_schema && !fileExists(s.output_schema)) {
      issues.push({ level: 'error', target: tgt, message: `output_schema 不存在: ${s.output_schema}` });
    }
```
(注:这两段代码本就是这样带 `if (s.xxx && ...)` 守卫的,确认保留;关键改动是从必填集移除。)`s.path` 检查改为接受 `entry` 兜底:
```typescript
    const skillPath = s.path ?? s.entry;
    if (skillPath && !fileExists(skillPath)) {
      issues.push({ level: 'error', target: tgt, message: `path/entry 不存在: ${skillPath}` });
    }
```

- [ ] **Step 3: 补测试**

在 `tests/registry-linter.test.ts` 追加(先读该文件确认现有 import 与风格,再追加):
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

test('KB skill(无 JSON schema)满足 active 契约类型', () => {
  const kbSkill: SkillRegistryEntry = {
    id: 'generate-research-plan',
    name: 'generate-research-plan',
    path: 'knowledge-base/skills/generate-research-plan',
    entry: 'knowledge-base/skills/generate-research-plan/SKILL.md',
    when_to_use: '生成完整调研方案',
    owner: '用研团队',
    risk_level: 'low',
    task_types: ['user_research_planning'],
    status: 'active',
  };
  // 无 input_schema/output_schema 也应类型合法(可选)
  assert.equal(kbSkill.input_schema, undefined);
  assert.equal(kbSkill.status, 'active');
});
```

- [ ] **Step 4: 跑测试**

Run: `npx tsx --test tests/registry-linter.test.ts`
Expected: PASS(现有用例 + 新用例)。若现有用例因类型变动失败,按上面接口修正。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator-runtime/src/runtime/config-loader.ts harness/linters/registry-linter.ts tests/registry-linter.test.ts
git commit -m "refactor(orchestrator): 放宽 SkillRegistryEntry 契约以容纳 KB skill"
```

---

### Task 7: indexer(派生 .index/knowledge.json + skill-registry.yaml)

**Files:**
- Create: `apps/orchestrator-runtime/src/knowledge/indexer.ts`
- Test: `tests/knowledge-indexer.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`(T2)、`inferTypeDomain`(T3)、`kbPath`(T1)。
- Produces: `buildIndex(entries: Array<{relPath:string; md:string}>): { knowledge: KnowledgeIndexItem[]; skills: SkillRegistryEntry[] }`;`KnowledgeIndexItem` 类型。

- [ ] **Step 1: 写失败测试**

`tests/knowledge-indexer.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';

const modelMd = [
  '---', 'id: model_jtbd', 'type: model', 'title: JTBD', 'domain: general',
  'tags: [framework]', 'guide_stage: [need-discovery]', 'summary: 需求框架',
  'source: xingyun_wiki', 'source_path: models/jtbd.md',
  'content_hash: sha256:x', 'status: approved', 'updated_at: 2026-07-15', '---', '', '# JTBD',
].join('\n');

const skillMd = [
  '---', 'name: generate-research-plan', 'description: 生成完整调研方案',
  'type: skill', 'domain: general', 'tags: [method, output]',
  'task_types: [user_research_planning]', 'inputs: [research_goal]', 'outputs: [research_plan]',
  'content_hash: sha256:y', 'status: approved', '---', '', '# 生成研究方案',
].join('\n');

test('知识条目进 knowledge 索引,skill 进 skills', () => {
  const { knowledge, skills } = buildIndex([
    { relPath: 'models/jtbd.md', md: modelMd },
    { relPath: 'skills/generate-research-plan/SKILL.md', md: skillMd },
  ]);
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].id, 'model_jtbd');
  assert.deepEqual(knowledge[0].guide_stage, ['need-discovery']);

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'generate-research-plan');
  assert.equal(skills[0].when_to_use, '生成完整调研方案', 'when_to_use ← description');
  assert.equal(skills[0].entry, 'knowledge-base/skills/generate-research-plan/SKILL.md');
  assert.deepEqual(skills[0].task_types, ['user_research_planning']);
  assert.equal(skills[0].status, 'active', 'approved → active');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/knowledge-indexer.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

`apps/orchestrator-runtime/src/knowledge/indexer.ts`:
```typescript
import { parseFrontmatter } from './frontmatter.ts';
import type { SkillRegistryEntry } from '../runtime/config-loader.ts';

export interface KnowledgeIndexItem {
  id: string;
  type: string;
  title: string;
  domain: string;
  tags: string[];
  guide_stage: string[];
  summary: string;
  source_path: string;
  content_hash: string;
  status: string;
}

// status 映射:知识库用 approved/draft/deprecated,registry 用 active/draft/deprecated
function toRegistryStatus(s: unknown): SkillRegistryEntry['status'] {
  return s === 'approved' || s === 'active' ? 'active' : s === 'deprecated' ? 'deprecated' : 'draft';
}

export function buildIndex(entries: Array<{ relPath: string; md: string }>): {
  knowledge: KnowledgeIndexItem[];
  skills: SkillRegistryEntry[];
} {
  const knowledge: KnowledgeIndexItem[] = [];
  const skills: SkillRegistryEntry[] = [];

  for (const { relPath, md } of entries) {
    const { frontmatter: fm } = parseFrontmatter(md);
    if (fm.type === 'skill') {
      const folder = relPath.replace(/\/SKILL\.md$/i, '');
      skills.push({
        id: (fm.name as string),
        name: (fm.name as string),
        path: `knowledge-base/${folder}`,
        entry: `knowledge-base/${relPath}`,
        when_to_use: (fm.description as string) ?? '',
        owner: (fm.owner as string) ?? '用研团队',
        risk_level: (fm.risk_level as SkillRegistryEntry['risk_level']) ?? 'low',
        domain: fm.domain ? [String(fm.domain)] : undefined,
        task_types: (fm.task_types as string[]) ?? [],
        status: toRegistryStatus(fm.status),
      });
    } else if (fm.id) {
      knowledge.push({
        id: fm.id as string,
        type: fm.type as string,
        title: (fm.title as string) ?? '',
        domain: (fm.domain as string) ?? 'general',
        tags: (fm.tags as string[]) ?? [],
        guide_stage: (fm.guide_stage as string[]) ?? [],
        summary: (fm.summary as string) ?? '',
        source_path: fm.source_path as string,
        content_hash: fm.content_hash as string,
        status: (fm.status as string) ?? 'approved',
      });
    }
  }
  return { knowledge, skills };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/knowledge-indexer.test.ts`
Expected: PASS(1 test)。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator-runtime/src/knowledge/indexer.ts tests/knowledge-indexer.test.ts
git commit -m "feat(kb): indexer 派生 knowledge 索引 + skill-registry"
```

---

### Task 8: 核心库 API(search_knowledge / get_entry / list_skills / resolve_skill)

**Files:**
- Create: `apps/orchestrator-runtime/src/knowledge/index.ts`
- Test: `tests/knowledge-api.test.ts`

**Interfaces:**
- Consumes: `KnowledgeIndexItem`(T7)、`kbPath`(T1)、`parseFrontmatter`(T2)。
- Produces: `searchKnowledge(opts): KnowledgeIndexItem[]`;`getEntry(id): {frontmatter;content}|null`;`listSkills(opts?): SkillRegistryEntry[]`;`resolveSkill(name): {path;frontmatter}|null`。签名以 `.index/knowledge.json` 与 `skill-registry.yaml` 为数据源。

- [ ] **Step 1: 写失败测试(纯函数版,注入数据)**

`tests/knowledge-api.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterKnowledge } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import type { KnowledgeIndexItem } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';

const items: KnowledgeIndexItem[] = [
  { id: 'model_jtbd', type: 'model', title: 'JTBD', domain: 'general', tags: ['persona', 'framework'], guide_stage: ['need-discovery'], summary: '需求框架', source_path: 'models/jtbd.md', content_hash: 'sha256:x', status: 'approved' },
  { id: 'std_report', type: 'standard', title: '报告规范', domain: 'general', tags: ['report', 'output'], guide_stage: ['output-standard'], summary: '', source_path: 'methods/standards/research-report-writing.md', content_hash: 'sha256:y', status: 'approved' },
  { id: 'dep_x', type: 'model', title: '弃用', domain: 'general', tags: ['persona'], guide_stage: [], summary: '', source_path: 'models/x.md', content_hash: 'sha256:z', status: 'deprecated' },
];

test('按 tags 召回(决策节点 related_tags)', () => {
  const r = filterKnowledge(items, { tags: ['persona'] });
  const ids = r.map((i) => i.id);
  assert.ok(ids.includes('model_jtbd'));
  assert.ok(!ids.includes('dep_x'), 'deprecated 不召回');
});

test('按 guide_stage 召回', () => {
  const r = filterKnowledge(items, { guide_stage: ['output-standard'] });
  assert.deepEqual(r.map((i) => i.id), ['std_report']);
});

test('关键词命中 title/summary', () => {
  const r = filterKnowledge(items, { query: '框架' });
  assert.deepEqual(r.map((i) => i.id), ['model_jtbd']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/knowledge-api.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

`apps/orchestrator-runtime/src/knowledge/index.ts`:
```typescript
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { kbPath } from './taxonomy.ts';
import { parseFrontmatter } from './frontmatter.ts';
import type { KnowledgeIndexItem } from './indexer.ts';
import type { SkillRegistryEntry } from '../runtime/config-loader.ts';

export interface SearchOpts {
  tags?: string[];
  guide_stage?: string[];
  task_type?: string;
  domain?: string;
  query?: string;
  limit?: number;
}

// 纯函数:可注入数据测试,不碰磁盘。
export function filterKnowledge(items: KnowledgeIndexItem[], opts: SearchOpts): KnowledgeIndexItem[] {
  let out = items.filter((i) => i.status !== 'deprecated');
  if (opts.domain) out = out.filter((i) => i.domain === opts.domain);
  if (opts.tags?.length) out = out.filter((i) => i.tags.some((t) => opts.tags!.includes(t)));
  if (opts.guide_stage?.length) out = out.filter((i) => i.guide_stage.some((s) => opts.guide_stage!.includes(s)));
  if (opts.query) {
    const q = opts.query.toLowerCase();
    out = out.filter((i) => `${i.title} ${i.summary} ${i.tags.join(' ')}`.toLowerCase().includes(q));
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function loadKnowledgeIndex(): KnowledgeIndexItem[] {
  const p = kbPath('knowledge-base/.index/knowledge.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as KnowledgeIndexItem[];
}

export function searchKnowledge(opts: SearchOpts): KnowledgeIndexItem[] {
  return filterKnowledge(loadKnowledgeIndex(), opts);
}

export function getEntry(id: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const item = loadKnowledgeIndex().find((i) => i.id === id);
  if (!item) return null;
  const full = kbPath('knowledge-base', item.source_path);
  if (!existsSync(full)) return null;
  return parseFrontmatter(readFileSync(full, 'utf8'));
}

function loadSkills(): SkillRegistryEntry[] {
  const p = kbPath('orchestrator/skill-registry.yaml');
  const parsed = parseYaml(readFileSync(p, 'utf8')) as { skills?: SkillRegistryEntry[] };
  return parsed.skills ?? [];
}

export function listSkills(opts?: { task_type?: string; domain?: string }): SkillRegistryEntry[] {
  let out = loadSkills().filter((s) => s.status === 'active');
  if (opts?.task_type) out = out.filter((s) => (s.task_types ?? []).includes(opts.task_type!));
  return out;
}

export function resolveSkill(name: string): { path: string; frontmatter: Record<string, unknown> } | null {
  const s = loadSkills().find((x) => x.name === name);
  const entry = s?.entry ?? s?.path;
  if (!entry) return null;
  const full = kbPath(entry.endsWith('.md') ? entry : `${entry}/SKILL.md`);
  if (!existsSync(full)) return null;
  return { path: entry, frontmatter: parseFrontmatter(readFileSync(full, 'utf8')).frontmatter };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/knowledge-api.test.ts`
Expected: PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator-runtime/src/knowledge/index.ts tests/knowledge-api.test.ts
git commit -m "feat(kb): 核心库 API search/get/list/resolve"
```

---

### Task 9: 首次全量导入脚本 + 端到端验收

**Files:**
- Create: `scripts/kb-import.ts`(遍历 wiki 副本 → normalizer → 写 knowledge-base)
- Create: `apps/orchestrator-runtime/src/knowledge/build.ts`(遍历 knowledge-base → indexer → 写 .index + registry)
- Test: `tests/knowledge-e2e.test.ts`

**Interfaces:**
- Consumes: `normalizeEntry`(T3)、`buildIndex`(T7)、`inferTypeDomain`(T3)、`searchKnowledge`(T8)、`loadDecisionGraph`(现有)。

- [ ] **Step 1: 写导入脚本**

`scripts/kb-import.ts`(用 tsx 跑,可 import `.ts`):
```typescript
// 首次全量导入:整棵 wiki 副本拷进 knowledge-base/;.md 条目就地补 frontmatter,
// 其余文件(skeleton.md/scripts/*.py/images/*.png)忠实拷贝——它们是 skill 的组成部分。
// 用法: npm run kb:import
import { readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { normalizeEntry } from '../apps/orchestrator-runtime/src/knowledge/normalizer.ts';

const SRC = 'references/2C-DesignWiki/jd-design-system-md-v16/horizontal/user-research';
const DST = 'knowledge-base';

function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '.DS_Store') continue;
    const full = join(dir, n);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

let normalized = 0, copied = 0;
for (const full of walk(SRC)) {
  const rel = relative(SRC, full).split('\\').join('/');
  const dst = join(DST, rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (full.endsWith('.md')) {
    // 条目→归一补 frontmatter;非条目(导航/skeleton)→normalizeEntry 原样返回, 即忠实拷贝
    const { md } = normalizeEntry(rel, readFileSync(full, 'utf8'));
    writeFileSync(dst, md, 'utf8');
    normalized++;
  } else {
    copyFileSync(full, dst); // .py / .png 等二进制忠实拷贝
    copied++;
  }
}
console.log(`kb-import: 处理 md ${normalized}, 拷贝其它文件 ${copied}`);
```

> `normalizeEntry` 对导航/skeleton(inferTypeDomain=null)返回原文,故这些 .md 被忠实写回;条目 .md 被补 frontmatter。

- [ ] **Step 2: 写 build 脚本(生成 .index + registry)**

`apps/orchestrator-runtime/src/knowledge/build.ts`:
```typescript
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { kbPath } from './taxonomy.ts';
import { buildIndex } from './indexer.ts';
import { inferTypeDomain } from './normalizer.ts';

function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '.index' || n.startsWith('.')) continue;
    const full = join(dir, n);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (n.endsWith('.md')) acc.push(full);
  }
  return acc;
}

export function build(): { knowledge: number; skills: number } {
  const root = kbPath('knowledge-base');
  const entries: Array<{ relPath: string; md: string }> = [];
  for (const full of walk(root)) {
    const rel = relative(root, full).split('\\').join('/');
    const isSkill = /\/SKILL\.md$/i.test(rel);
    if (!isSkill && inferTypeDomain(rel) === null) continue; // 导航跳过
    entries.push({ relPath: rel, md: readFileSync(full, 'utf8') });
  }
  const { knowledge, skills } = buildIndex(entries);

  const idxDir = kbPath('knowledge-base/.index');
  mkdirSync(idxDir, { recursive: true });
  writeFileSync(join(idxDir, 'knowledge.json'), JSON.stringify(knowledge, null, 2), 'utf8');
  writeFileSync(
    kbPath('orchestrator/skill-registry.yaml'),
    '# 由 indexer 派生, 勿手改。源: knowledge-base/skills/*/SKILL.md\n' +
      stringifyYaml({ version: 1, skills }),
    'utf8',
  );
  return { knowledge: knowledge.length, skills: skills.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = build();
  console.log(`kb-build: knowledge ${r.knowledge}, skills ${r.skills}`);
}
```

- [ ] **Step 3: 加 package.json scripts**

在 `scripts` 追加:
```json
"kb:import": "tsx scripts/kb-import.ts",
"kb:build": "tsx apps/orchestrator-runtime/src/knowledge/build.ts",
```

- [ ] **Step 4: 跑导入 + 构建 + linter**

```bash
npm run kb:import
npm run kb:build
npm run lint:knowledge
```
Expected:import 报"处理 md ~162, 拷贝其它文件 ~28"(md 含导航/skeleton,其它含 .png/.py);build 报"knowledge ~114, skills 21";lint:knowledge 输出 `OK`(若报越界 tag/缺字段,人工修正对应 md 后重跑)。

- [ ] **Step 5: 写端到端验收测试**

`tests/knowledge-e2e.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKnowledge, resolveSkill, listSkills } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import { loadDecisionGraph } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

// 前置:已跑 npm run kb:import && npm run kb:build
test('每个决策节点的 related_tags 都能召回到条目', () => {
  const { nodes } = loadDecisionGraph();
  const empty: string[] = [];
  for (const n of nodes) {
    const tags = n.related_tags ?? [];
    if (tags.length === 0) continue;
    if (searchKnowledge({ tags }).length === 0) empty.push(n.key);
  }
  assert.deepEqual(empty, [], `这些节点召回为空(需补种子 tag 或知识条目): ${empty.join(', ')}`);
});

test('resolveSkill 能定位 generate-research-plan', () => {
  const r = resolveSkill('generate-research-plan');
  assert.ok(r, 'generate-research-plan 应可定位');
  assert.match(r!.path, /generate-research-plan/);
});

test('listSkills 至少 21 个 active', () => {
  assert.ok(listSkills().length >= 21, `实际 ${listSkills().length}`);
});

test('每个 active skill 的 task_types 非空(router 可路由)', () => {
  const bad = listSkills().filter((s) => !(s.task_types ?? []).length).map((s) => s.name);
  assert.deepEqual(bad, [], `这些 skill task_types 为空: ${bad.join(', ')}`);
});
```

- [ ] **Step 6: 跑验收**

Run: `npx tsx --test tests/knowledge-e2e.test.ts`
Expected: PASS(4 tests)。**最可能失败的是 D6_data_sensitivity(privacy/compliance)**——wiki 多为研究方法、少合规文档,若该节点召回空:在 `seed.ts` 的 `KEYWORD_TAG` 给抽样/招募类补 `privacy`/`compliance`(如 `[/consent|授权|知情|sampling|招募/i, ['privacy']]`),或人工给 `methods/standards/` 下相关条目 frontmatter 补该 tag,重跑 `npm run kb:build`。其余节点由 5w2h/persona/competitive/heuristic 等条目天然覆盖。

- [ ] **Step 7: 提交**

```bash
git add scripts/kb-import.ts apps/orchestrator-runtime/src/knowledge/build.ts package.json tests/knowledge-e2e.test.ts knowledge-base/ orchestrator/skill-registry.yaml
git commit -m "feat(kb): 首次全量导入 + build + 端到端验收"
```

---

## 验收标准回归(对齐 spec §15)

- [ ] 知识/能力条目全部导入 knowledge-base,frontmatter 合法,`lint:knowledge` 全绿(Task 5/9)。
- [ ] taxonomy 覆盖 decision-graph 全部 related_tags(Task 1);每个节点 related_tags 可召回(Task 9 e2e)。
- [ ] `.index/knowledge.json` + 派生 `skill-registry.yaml` 由 indexer 生成(Task 7/9)。
- [ ] search_knowledge 按 tags/guide_stage/query 召回,带 source_path+hash(Task 8)。
- [ ] resolveSkill/listSkills 定位并列出 21 skills(Task 9)。
- [ ] normalizer 幂等(Task 3);linter 拦截缺字段/id 重复/tag 越界/hash 不匹配(Task 5)。
