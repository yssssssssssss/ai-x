# KB-aware Skill Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two reproducible KB-aware evaluation modes that compare fixed canonical-context Skill performance with live `searchKnowledge()`/`getEntry()` retrieval performance for all 22 active Skills.

**Architecture:** Keep the existing Skill-only runner as Round 0. Add a KB layer that freezes a content-addressed knowledge snapshot, validates a 22-entry Skill-to-canon mapping, and produces a `KnowledgeContext` plus provenance for either `gold` or `live` mode. Extend each evaluation record with a sidecar `KBAssessment` without changing the existing 100-point Skill score, then generate a comparison report across Round 0/A/B.

**Tech Stack:** TypeScript 5.7, Node.js 20, `tsx`, `node:test`, existing `searchKnowledge()`, `getEntry()`, `SkillLoader`, `LLMClient`, `SchemaValidator`, and AJV-backed validation.

## Global Constraints

- Preserve Round 0 Skill-only results and semantics.
- Round A uses fixed, human-approved canonical source sets and never calls `searchKnowledge()`.
- Round B uses the repository `searchKnowledge()` and `getEntry()` interfaces and records candidates plus selected sources.
- Round A and Round B use the same 22 synthetic cases, same Skill bodies, same model, same snapshot, and same base scorecard.
- Current baseline model is GPT-5.4; GPT-5.6 requires a separate run ID and must not be mixed into this comparison.
- Existing 100-point weights remain unchanged: 20/20/20/15/15/10.
- `draft` sources are allowed only with `status_warnings`; `deprecated` sources cannot satisfy required sources.
- Missing, contradictory, dynamic, or parent-only source paths are recorded in `unresolved_items`; never guess a path.
- Four native Skills have no declared wiki source mapping and must be `not_applicable` or `manual_review`, not artificially failed as KB Skills.
- No production Skill, registry, or source knowledge document is modified by the KB evaluator.
- No real user data, PII, external network, or external Tool call is introduced.
- Generated KB-aware results remain under ignored `skill-evaluations/<run-id>/` directories.

---

## File Map

- Create `evaluations/skills/kb/types.ts`: snapshot, mapping, context, retrieval, and KB assessment contracts.
- Create `evaluations/skills/kb/skill-knowledge-mapping.json`: exactly 22 mapping records.
- Create `evaluations/skills/kb/gold-source-selections.json`: fixed Round A source selection per existing case.
- Create `evaluations/skills/kb/snapshot.ts`: content-addressed snapshot builder/loader.
- Create `evaluations/skills/kb/retriever.ts`: Round A fixed context and Round B live retrieval.
- Create `evaluations/skills/kb/assessment.ts`: source usage, status warnings, retrieval recall, and `kb_grounding_verdict`.
- Create `evaluations/skills/kb/compare.ts`: Round 0/A/B comparison summary.
- Modify `evaluations/skills/types.ts`: add optional `kbAssessment` and `knowledgeContextRef` metadata without changing existing fields.
- Modify `evaluations/skills/evaluator.ts`: accept an optional `KnowledgeContext`, include it in generation/scoring context, and return KB assessment metadata.
- Modify `evaluations/skills/report-writer.ts`: write `knowledge-context.json`, `retrieval.json`, `kb-assessment.json`, and comparison summaries.
- Modify `evaluations/skills/run.ts`: add `--kb-mode none|gold|live`, `--kb-snapshot <id>`, and mapping/snapshot dependency injection.
- Modify `package.json`: add `eval:skills:kb` and `eval:skills:kb:compare` scripts.
- Create `tests/kb-snapshot.test.ts`: snapshot hashing/status/missing source behavior.
- Create `tests/kb-mapping.test.ts`: 22-entry mapping completeness and path policy.
- Create `tests/kb-retriever.test.ts`: gold/live retrieval and provenance behavior.
- Create `tests/kb-assessment.test.ts`: source citation/status/verdict behavior.
- Extend `tests/skill-evaluator.test.ts`: context propagation and KB assessment attachment.
- Extend `tests/skill-evaluation-runner.test.ts`: KB artifact writing and mode isolation.

---

### Task 1: Snapshot, mapping, and gold source corpus

**Files:**
- Create: `evaluations/skills/kb/types.ts`
- Create: `evaluations/skills/kb/skill-knowledge-mapping.json`
- Create: `evaluations/skills/kb/gold-source-selections.json`
- Create: `evaluations/skills/kb/snapshot.ts`
- Create: `tests/kb-snapshot.test.ts`
- Create: `tests/kb-mapping.test.ts`

**Interfaces:**

```ts
export type KBMode = 'none' | 'gold' | 'live';

export interface KnowledgeSourceRule {
  path: string;
  role: 'standard' | 'method' | 'model' | 'asset' | 'template' | 'one_of';
  trigger?: string;
  status?: string;
}

export interface SkillKnowledgeMapping {
  skill_id: string;
  kb_mode: 'required' | 'not_applicable' | 'manual_review';
  required_sources: KnowledgeSourceRule[];
  conditional_sources: KnowledgeSourceRule[];
  optional_sources: KnowledgeSourceRule[];
  retrieval_tags: string[];
  source_status_policy: 'draft_allowed_with_warning' | 'reviewed_required' | 'not_applicable';
  unresolved_items: string[];
}

export interface KnowledgeSnapshot {
  snapshot_id: string;
  index_path: string;
  index_hash: string;
  built_at: string;
  source_files: Array<{ path: string; content_hash: string; status: string }>;
}
```

- [ ] **Step 1: Write failing mapping and snapshot tests**

Test these observable behaviors:

```ts
const mappings = loadSkillKnowledgeMappings(activeSkills, mappingPath);
assert.equal(mappings.size, 22);
assert.deepEqual([...mappings.keys()], activeSkills.map((s) => s.id));
assert.equal(mappings.get('competitive-web-research')?.kb_mode, 'not_applicable');
assert.equal(mappings.get('generate-survey')?.required_sources.length > 0, true);
assert.throws(() => loadSkillKnowledgeMappings(activeSkills, mappingWithUnknownId), /unknown skill/);
assert.throws(() => loadSkillKnowledgeMappings(activeSkills, missingSkillMapping), /missing mapping/);
```

Snapshot tests must cover:

- same index and source bytes produce the same `snapshot_id`;
- changing one source byte changes the snapshot hash;
- missing source is recorded as an error, not silently replaced;
- `deprecated` required source is rejected;
- `draft` required source remains loadable and is returned with a warning.

Run:

```bash
pnpm exec tsx --test tests/kb-snapshot.test.ts tests/kb-mapping.test.ts
```

Expected: FAIL because the KB layer does not exist.

- [ ] **Step 2: Populate the exact 22-entry mapping**

Use the reviewed source mapping from the design work. The mapping must contain:

- 4 native Skill records marked `not_applicable` or `manual_review` with empty required source lists;
- 18 KB Skill records with required/conditional/optional source roles;
- dynamic `<主题>`/`<业务线>` paths only in `unresolved_items`;
- `models/aarrr.md`, `models/fogg-behavior-model.md`, `methods/toolbox/analysis/ipa-matrix.md`, and `methods/competitive-research-method.md` recorded as unresolved where referenced but absent;
- `models/kano.md` recorded as an existing source plus a contradiction warning where SKILL.md claims it is missing;
- one-of semantics for `structure-interview-transcript` lenses;
- conditional scale/sampling/recruitment sources rather than unconditional injection.

Every fixed path must be checked against the actual repository and store its observed status. Do not modify the source files to make the mapping pass.

- [ ] **Step 3: Implement `loadKnowledgeSnapshot` and `buildKnowledgeSnapshot`**

Use `knowledge-base/.index/knowledge.json` as the index input and `getEntry()`-compatible paths for source bytes. Hash the exact index bytes plus sorted source path/content hashes. Return a snapshot object and a `Map<string, KnowledgeIndexItem>`; reject missing required files and deprecated required sources with deterministic errors.

- [ ] **Step 4: Create fixed Round A selections**

`gold-source-selections.json` must map every Skill ID to selected source IDs for the existing case. Required sources are always selected; conditional sources are selected only when the current case’s input meets their documented trigger. Unresolved dynamic paths remain unselected and explicitly listed. Native Skills get an empty selection and `mode: not_applicable`.

- [ ] **Step 5: Run focused tests**

```bash
pnpm exec tsx --test tests/kb-snapshot.test.ts tests/kb-mapping.test.ts
```

Expected: all tests PASS; mapping count is 22 and all fixed source paths/statuses are deterministic.

- [ ] **Step 6: Commit Task 1**

```bash
git add evaluations/skills/kb/types.ts evaluations/skills/kb/skill-knowledge-mapping.json evaluations/skills/kb/gold-source-selections.json evaluations/skills/kb/snapshot.ts tests/kb-snapshot.test.ts tests/kb-mapping.test.ts
git commit -m "feat: add KB snapshot and Skill source mappings"
```

---

### Task 2: Knowledge context and retrieval modes

**Files:**
- Create: `evaluations/skills/kb/retriever.ts`
- Create: `tests/kb-retriever.test.ts`

**Interfaces:**

```ts
export interface KnowledgeContextItem {
  source_id: string;
  title: string;
  source_path: string;
  content_hash: string;
  status: string;
  role: 'required' | 'conditional' | 'optional' | 'candidate';
  content: string;
}

export interface KnowledgeContext {
  mode: 'gold' | 'live';
  snapshot_id: string;
  required_source_ids: string[];
  selected_source_ids: string[];
  items: KnowledgeContextItem[];
}

export interface RetrievalRecord {
  mode: 'gold' | 'live';
  snapshot_id: string;
  guide_tags: string[];
  query?: string;
  candidate_source_ids: string[];
  selected_source_ids: string[];
  required_source_recall: number | null;
  missing_required_source_ids: string[];
  unresolved_items: string[];
}
```

- [ ] **Step 1: Write failing retrieval tests**

Cover:

1. Gold mode loads exactly the selected fixed source files and never calls `searchKnowledge`.
2. Live mode calls `searchKnowledge` with mapping tags/query and then `getEntry` for candidates.
3. Candidate and selected source IDs are distinct and ordered deterministically.
4. Missing source body yields a retrieval error record, not an invented source.
5. Deprecated source cannot satisfy a required source.
6. Draft source is returned with `status: 'draft'` and a warning.
7. `required_source_recall` is computed as selected required sources divided by available required sources, or `null` when no required sources apply.
8. Native `not_applicable` mapping returns empty context and no KB failure.

Run:

```bash
pnpm exec tsx --test tests/kb-retriever.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 2: Implement gold retrieval**

`loadGoldKnowledgeContext(skillId, snapshot, mapping, goldSelections)` must read only the selected source files, attach exact path/hash/status, and return `KnowledgeContext` plus `RetrievalRecord`. It must never call `searchKnowledge`.

- [ ] **Step 3: Implement live retrieval**

`loadLiveKnowledgeContext(skillId, snapshot, mapping, search = searchKnowledge, get = getEntry)` must:

- use explicit mapping paths where `guide_tags` are empty;
- use `guide_tags` plus case/task query where tags exist;
- filter deprecated candidates;
- read candidate bodies with `getEntry`;
- select required/conditional sources according to mapping;
- preserve candidate and selected IDs for provenance;
- return unresolved/missing source details without fabricating content.

- [ ] **Step 4: Run focused retrieval tests**

```bash
pnpm exec tsx --test tests/kb-retriever.test.ts
```

Expected: all retrieval tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add evaluations/skills/kb/retriever.ts tests/kb-retriever.test.ts
git commit -m "feat: add gold and live KB retrieval modes"
```

---

### Task 3: KB assessment and evaluator integration

**Files:**
- Create: `evaluations/skills/kb/assessment.ts`
- Create: `tests/kb-assessment.test.ts`
- Modify: `evaluations/skills/types.ts`
- Modify: `evaluations/skills/evaluator.ts`
- Modify: `tests/skill-evaluator.test.ts`

**Interfaces:**

```ts
export interface KBAssessment {
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

export function assessKnowledgeUsage(
  skillId: string,
  context: KnowledgeContext,
  retrieval: RetrievalRecord,
  generatedOutput: unknown,
): KBAssessment;
```

- [ ] **Step 1: Write failing KB assessment tests**

Cover:

- all required sources selected and cited → `kb_grounding_verdict: 'pass'`;
- draft source used → pass may remain, but `draft_sources_used` and `status_warnings` are non-empty;
- missing required source → `fail`;
- unresolved mapping or incomplete citation → `needs_review`;
- source ID not present in context but cited by output → `fail`;
- native `not_applicable` Skill → `not_applicable`;
- output with no source citations when sources are required → `needs_review`;
- base score is not changed by KB assessment.

Run:

```bash
pnpm exec tsx --test tests/kb-assessment.test.ts tests/skill-evaluator.test.ts
```

Expected: FAIL before integration.

- [ ] **Step 2: Implement source extraction and KB verdict**

Use explicit source ID/path markers from generated output where available. Do not infer source usage solely from semantic similarity. If a Skill output cannot expose source IDs, mark citation coverage as incomplete and return `needs_review` rather than `pass`.

- [ ] **Step 3: Extend evaluator context without breaking Round 0**

保留现有入口并增加可选参数：

```ts
evaluate(
  loadedCase: LoadedEvaluationCase,
  kb?: { knowledgeContext: KnowledgeContext; retrieval: RetrievalRecord },
): Promise<SkillEvaluationRecord>
```

`kb` 未提供时，生成和评分 context 必须与 Round 0 完全一致；`gold`/`live` 模式才注入 `knowledge_context`。生成 prompt 必须声明 source status 和 citation 规则；评分 context 必须包含 generated output、同一份 KB context 和 retrieval metadata。现有 100-point normalization 保持不变。Runner 的 `EvaluationCaseEvaluator` 接口同步增加可选第二参数，所有旧测试继续通过。

- [ ] **Step 4: Preserve failure behavior**

If KB retrieval fails, preserve the input case and retrieval error, do not fabricate `knowledge_context`, and let the Skill record be `needs_review` or `failed` according to whether generation ran. If scoring fails, preserve generated output and write a KB assessment with the observed failure.

- [ ] **Step 5: Run focused tests**

```bash
pnpm exec tsx --test tests/kb-assessment.test.ts tests/skill-evaluator.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add evaluations/skills/kb/assessment.ts evaluations/skills/types.ts evaluations/skills/evaluator.ts tests/kb-assessment.test.ts tests/skill-evaluator.test.ts
git commit -m "feat: assess KB grounding in Skill evaluation"
```

---

### Task 4: Runner modes and KB artifacts

**Files:**
- Modify: `evaluations/skills/report-writer.ts`
- Modify: `evaluations/skills/run.ts`
- Modify: `tests/skill-evaluation-runner.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface EvaluationRunOptions {
  runId: string;
  outputRoot: string;
  casesDir?: string;
  skillId?: string;
  concurrency: 1 | 2 | 3;
  resume: boolean;
  kbMode?: 'none' | 'gold' | 'live';
  kbSnapshotId?: string;
}
```

- [ ] **Step 1: Write failing runner tests**

Cover:

1. `kbMode: 'none'` produces the existing Round 0 artifact shape unchanged.
2. `kbMode: 'gold'` writes `knowledge-context.json`, `retrieval.json`, and `kb-assessment.json`.
3. `kbMode: 'live'` writes candidate and selected source IDs.
4. Manifest records `kbMode`, snapshot ID/hash, and source mapping hash.
5. A missing snapshot or mapping fails before LLM generation.
6. One Skill KB retrieval failure does not abort the batch.
7. Resume validates KB artifacts and does not reuse artifacts from a different snapshot or mode.
8. run IDs and lock behavior from the existing runner remain unchanged.

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts
```

Expected: FAIL because KB options/artifacts are not implemented.

- [ ] **Step 2: Implement CLI mode parsing**

Add:

```text
--kb-mode none|gold|live
--kb-snapshot <snapshot-id>
```

Defaults:

- no flag → `none`;
- `gold`/`live` require a valid snapshot and mapping manifest;
- invalid mode or missing snapshot exits before any LLM call.

- [ ] **Step 3: Implement artifact writing**

Write the KB files atomically beside existing Skill artifacts. Add KB fields to `manifest.json` without breaking Round 0 consumers. Keep `summary.md` and `summary.csv` base-score columns unchanged, then add KB columns in a separate KB summary or comparison report.

- [ ] **Step 4: Add package scripts**

Add exactly:

```json
"eval:skills:kb": "tsx evaluations/skills/run.ts",
"eval:skills:kb:compare": "tsx evaluations/skills/kb/compare.ts"
```

The first script uses flags for mode; the second consumes three completed run directories.

- [ ] **Step 5: Run focused runner tests**

```bash
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts
```

Expected: all runner tests PASS and existing Round 0 tests remain green.

- [ ] **Step 6: Commit Task 4**

```bash
git add evaluations/skills/report-writer.ts evaluations/skills/run.ts tests/skill-evaluation-runner.test.ts package.json
 git commit -m "feat: add KB-aware runner modes and artifacts"
```

---

### Task 5: Round comparison, validation corpus, and execution

**Files:**
- Create: `evaluations/skills/kb/compare.ts`
- Create: `tests/kb-compare.test.ts`
- Modify: `package.json` only if Task 4 did not add the compare script.
- Generated: `skill-evaluations/<run-id>/**`

- [ ] **Step 1: Write failing comparison tests**

Given three manifests with the same 22 Skill IDs, assert that comparison output contains for every Skill:

```ts
{
  skill_id,
  round0_base_score,
  roundA_base_score,
  roundB_base_score,
  roundA_kb_grounding_verdict,
  roundB_kb_grounding_verdict,
  retrieval_recall,
  draft_warning_count,
  unresolved_source_count,
  review_notes
}
```

Reject comparisons when model, case hash set, or KB snapshot IDs differ.

Run:

```bash
pnpm exec tsx --test tests/kb-compare.test.ts
```

Expected: FAIL before comparison implementation.

- [ ] **Step 2: Implement comparison output**

Write:

```text
<compare-run>/kb-comparison.md
<compare-run>/kb-comparison.csv
<compare-run>/kb-comparison.json
```

Keep base score and KB verdict separate. Sort by Skill registry order, not score, and include a section for unresolved mapping/source status warnings.

- [ ] **Step 3: Run source and code quality gates**

From the isolated worktree:

```bash
pnpm kb:build
pnpm lint:registry
pnpm lint:knowledge
pnpm test
```

Expected: index rebuild succeeds; all linters pass; existing and new tests pass.

- [ ] **Step 4: Run Round A with the fixed model**

```bash
pnpm eval:skills:kb --run-id 20260804-kb-gold --kb-mode gold --kb-snapshot <snapshot-id> --concurrency 3
```

Expected: 22 records, 22 `knowledge-context.json`, 22 `kb-assessment.json`, no missing required source left unrecorded.

- [ ] **Step 5: Run Round B with the same snapshot/model/cases**

```bash
pnpm eval:skills:kb --run-id 20260804-kb-live --kb-mode live --kb-snapshot <snapshot-id> --concurrency 3
```

Expected: 22 `retrieval.json` files with candidates, selected IDs, hashes, recall, and unresolved items.

- [ ] **Step 6: Generate the comparison report**

```bash
pnpm eval:skills:kb:compare --round0 skill-evaluations/20260804-baseline --roundA skill-evaluations/20260804-kb-gold --roundB skill-evaluations/20260804-kb-live --output skill-evaluations/20260804-kb-compare
```

Expected: comparison rejects mismatched model/case/snapshot and otherwise writes Markdown, CSV, and JSON.

- [ ] **Step 7: Verify final acceptance**

Programmatically assert:

- 22 active Skills in every round;
- same case hashes and model names in Round A/B;
- same KB snapshot ID/hash in Round A/B;
- 18 KB mappings and 4 native `not_applicable/manual_review` mappings;
- no missing or deprecated required source is silently accepted;
- all source claims are traceable to `knowledge-context.json`/`retrieval.json`;
- Round 0 base scores remain unchanged;
- KB verdict and source status warnings are present independently;
- all outputs and assessment files parse;
- no API key, Authorization header, or raw secret appears in artifacts.

- [ ] **Step 8: Commit comparison implementation and tests**

```bash
git add evaluations/skills/kb/compare.ts tests/kb-compare.test.ts package.json
git commit -m "feat: compare KB-aware Skill evaluation rounds"
```
