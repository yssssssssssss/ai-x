# Skill Capability Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run an isolated evaluator that produces one synthetic-input result and one evidence-backed scorecard for every active Skill.

**Architecture:** A registry-driven CLI loads one checked-in JSON case per active Skill, calls the production `LLMClient` with the production Skill body and optional output schema, validates schema-bearing outputs, then performs a second structured LLM call for scoring. Atomic writers persist per-Skill artifacts and a batch manifest/summary; the runner supports filtering, bounded concurrency, and resume without touching planner, database, or external Tool adapters.

**Tech Stack:** TypeScript 5.7, Node.js 20, `tsx`, `node:test`, existing `SkillLoader`, `LLMClient`, `SchemaValidator`, AJV-backed file validation.

## Global Constraints

- Discover active Skills from `orchestrator/skill-registry.yaml`; do not hard-code the runtime Skill list.
- This baseline must discover exactly 22 active Skills.
- Use standard synthetic cases only; never call external Tools or include real user/business data.
- Use a real LLM; reject `LLM_PROVIDER=mock` before generation.
- Run each Skill once and score it once.
- Automatic scores are triage aids, not final human judgments.
- Default concurrency is 3; accepted `--concurrency` range is 1–3.
- A single Skill failure must not abort the batch.
- Existing Skill files, registries, and production execution semantics remain unchanged.
- Generated results live under `skill-evaluations/<run-id>/` and are not silently committed as source fixtures.

---

## File Map

- Create `evaluations/skills/types.ts`: stable case, scorecard, run-result, and manifest contracts.
- Create `evaluations/skills/case-loader.ts`: JSON parsing, shape checks, registry/case one-to-one validation, case hashing.
- Create `evaluations/skills/scorecard.schema.json`: structured evaluator output contract.
- Create `evaluations/skills/evaluator.ts`: production-like Skill prompt, output schema validation, independent scoring, score normalization.
- Create `evaluations/skills/report-writer.ts`: atomic JSON/text writes, readable output Markdown, summary Markdown/CSV, manifest writes.
- Create `evaluations/skills/run.ts`: CLI parsing, environment guard, bounded worker pool, filtering, resume, batch status.
- Create `evaluations/skills/cases/<skill-id>.json`: 22 synthetic cases listed in Task 4.
- Create `tests/skill-evaluation-case-loader.test.ts`: case completeness and malformed-case contracts.
- Create `tests/skill-evaluator.test.ts`: generation, schema validation, scoring, scorer fallback contracts.
- Create `tests/skill-evaluation-runner.test.ts`: continuation, resume, output files, provider guard contracts.
- Modify `package.json`: add `eval:skills` command.
- Modify `.gitignore`: ignore generated `skill-evaluations/*` artifacts.

---

### Task 1: Evaluation contracts and registry-complete case loading

**Files:**
- Create: `evaluations/skills/types.ts`
- Create: `evaluations/skills/case-loader.ts`
- Test: `tests/skill-evaluation-case-loader.test.ts`

**Interfaces:**
- Consumes: `SkillRegistryEntry` from `apps/orchestrator-runtime/src/runtime/config-loader.ts`.
- Produces: `SkillEvaluationCase`, `LoadedEvaluationCase`, `SkillScorecard`, `SkillEvaluationRecord`, `EvaluationManifest`, and `loadEvaluationCases(activeSkills, casesDir)`.

- [ ] **Step 1: Write failing case-loader tests**

Create tests using `mkdtempSync(join(tmpdir(), 'skill-eval-cases-'))` and explicit fixture files. Cover these observable contracts:

```ts
const active = [
  { id: 'alpha', status: 'active' },
  { id: 'beta', status: 'active' },
] as SkillRegistryEntry[];

assert.deepEqual(
  [...loadEvaluationCases(active, casesDir).keys()],
  ['alpha', 'beta'],
);
assert.throws(
  () => loadEvaluationCases(active, missingCaseDir),
  /missing cases: beta/,
);
assert.throws(
  () => loadEvaluationCases(active, unknownCaseDir),
  /unknown cases: ghost/,
);
assert.throws(
  () => loadEvaluationCases(active, malformedDir),
  /expected_deliverables must be a non-empty string array/,
);
```

Also assert that `caseHash` begins with `sha256:` and changes when the JSON content changes.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts
```

Expected: FAIL because `evaluations/skills/case-loader.ts` and its exported contracts do not exist.

- [ ] **Step 3: Implement exact contracts in `types.ts`**

Define these public types:

```ts
export interface SkillEvaluationCase {
  skill_id: string;
  title: string;
  research_goal: string;
  input_materials: Record<string, unknown>;
  tool_outputs: Record<string, unknown>[];
  expected_deliverables: string[];
  risk_checks: string[];
}

export interface LoadedEvaluationCase {
  data: SkillEvaluationCase;
  sourcePath: string;
  caseHash: string;
}

export type EvaluationVerdict = 'pass' | 'needs_review' | 'fail';
export type EvaluationStatus = 'succeeded' | 'needs_review' | 'failed' | 'skipped';

export interface ScoreDimension {
  id: string;
  score: number;
  max_score: number;
  evidence: string[];
  defects: string[];
}

export interface SkillScorecard {
  skill_id: string;
  total_score: number | null;
  verdict: EvaluationVerdict;
  dimensions: ScoreDimension[];
  critical_defects: string[];
  review_notes: string[];
}
```

Add result metadata fields needed by later tasks: Skill hash, case hash, prompt hashes, model fields, trace IDs, generation/scoring token usage, elapsed milliseconds, status, error stage/message, and output/scorecard payloads. Do not store API keys or request headers.

- [ ] **Step 4: Implement `loadEvaluationCases`**

Implementation requirements:

```ts
export function loadEvaluationCases(
  activeSkills: SkillRegistryEntry[],
  casesDir = join(getConfigRoot(), 'evaluations', 'skills', 'cases'),
): Map<string, LoadedEvaluationCase>
```

- Read only `*.json` files, sorted by filename.
- Parse UTF-8 JSON and validate all seven required fields.
- Require `skill_id` to equal the filename without `.json`.
- Reject duplicate IDs, missing active Skill cases, and unknown/non-active cases in one deterministic error message each.
- Hash the exact file bytes with SHA-256 and prefix with `sha256:`.
- Return insertion order matching `activeSkills`, not filesystem order.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts
```

Expected: all case-loader tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add evaluations/skills/types.ts evaluations/skills/case-loader.ts tests/skill-evaluation-case-loader.test.ts
git commit -m "feat: add skill evaluation case contracts"
```

---

### Task 2: Single-Skill generation and evidence-backed scoring

**Files:**
- Create: `evaluations/skills/scorecard.schema.json`
- Create: `evaluations/skills/evaluator.ts`
- Test: `tests/skill-evaluator.test.ts`

**Interfaces:**
- Consumes: `LLMClient`, `SkillLoader`, `SchemaValidator`, `LoadedEvaluationCase`.
- Produces: `SkillEvaluator.evaluate(loadedCase): Promise<SkillEvaluationRecord>`.

- [ ] **Step 1: Write failing evaluator tests with injected fakes**

Use a fake `LLMClient` that records calls and returns generation data on call 1 and a scorecard on call 2. Cover:

1. Generation prompt contains the Skill body and evidence-boundary instruction.
2. Generation context contains `research_goal`, `input_materials`, `tool_outputs`, `expected_deliverables`, and `risk_checks`.
3. A Skill with `output_schema` invokes `validateFileOrThrow` once with the configured schema path.
4. A KB Skill without `output_schema` skips schema validation.
5. Scoring receives the Skill body, case, and generated output.
6. Reported total is recomputed from dimensions; LLM-provided inconsistent totals are ignored.
7. Totals `<60` become `fail`, totals `60–79` become `needs_review`, totals `>=80` remain `pass` unless the scorer requested `needs_review` or listed critical defects.
8. Scorer failure returns a fallback scorecard with `total_score: null`, `verdict: 'needs_review'`, and the error in `review_notes`, while preserving the generated output.
9. Generation or schema failure returns `status: 'failed'`, records the failing stage, and never invokes scoring.

Run:

```bash
pnpm exec tsx --test tests/skill-evaluator.test.ts
```

Expected: FAIL because evaluator files do not exist.

- [ ] **Step 2: Create the scorecard JSON Schema**

The schema must require exactly:

```json
{
  "skill_id": "string",
  "total_score": "number or null",
  "verdict": "pass | needs_review | fail",
  "dimensions": "array of {id, score, max_score, evidence[], defects[]}",
  "critical_defects": "string[]",
  "review_notes": "string[]"
}
```

Set `additionalProperties: false` at the root and dimension level. Constrain scores to non-negative numbers. The runner performs cross-field total and threshold normalization after schema validation.

- [ ] **Step 3: Implement production-like generation**

`SkillEvaluator` constructor:

```ts
constructor(deps: {
  llm: LLMClient;
  skillLoader: SkillLoader;
  validator: SchemaValidator;
  scorecardSchemaPath?: string;
})
```

Generation call:

```ts
const generated = await llm.generateStructured<Record<string, unknown>>({
  prompt:
    `你是「${skill.name}」能力。严格按以下 SKILL.md 的工作流与质量门禁执行。` +
    `本次输入均为标准合成评测数据；只能基于 input_materials 与 tool_outputs 产出结果，` +
    `不得表述为真实业务事实。无数据支撑的判断必须明确标为 llm_inference 或待人工确认。\n\n${body}`,
  schema: outputSchema ?? { type: 'object', additionalProperties: true },
  schemaName: `skill:${skill.id}`,
  context: {
    research_goal: evaluationCase.research_goal,
    input_materials: evaluationCase.input_materials,
    tool_outputs: evaluationCase.tool_outputs,
    expected_deliverables: evaluationCase.expected_deliverables,
    risk_checks: evaluationCase.risk_checks,
  },
});
```

If `skill.output_schema` exists, validate generated data with `validator.validateFileOrThrow(join(getConfigRoot(), skill.output_schema), generated.data)`.

- [ ] **Step 4: Implement independent scoring**

Use a second `generateStructured<SkillScorecard>` call with schemaName `skill-evaluation-scorecard`. The prompt must state the six fixed dimensions and weights `20/20/20/15/15/10`, require concrete output quotations in `evidence`, forbid rewarding unsupported verbosity, and state that synthetic inputs must not be treated as real facts.

Context:

```ts
{
  skill_id: skill.id,
  skill_body: body,
  evaluation_case: evaluationCase,
  generated_output: generated.data,
}
```

Validate the scorecard file schema, then:

- require exactly six known dimension IDs;
- clamp no values: invalid score/max pairs are scorer failures, not silently repaired;
- recompute `total_score` as the dimension sum;
- force `fail` for total below 60 or any `critical_defects`;
- force `needs_review` for total 60–79 or incoming verdict `needs_review`;
- otherwise set `pass`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/skill-evaluator.test.ts
```

Expected: all evaluator tests PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add evaluations/skills/scorecard.schema.json evaluations/skills/evaluator.ts tests/skill-evaluator.test.ts
git commit -m "feat: evaluate and score individual skills"
```

---

### Task 3: Atomic artifacts, batch runner, resume, and summaries

**Files:**
- Create: `evaluations/skills/report-writer.ts`
- Create: `evaluations/skills/run.ts`
- Test: `tests/skill-evaluation-runner.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `loadEvaluationCases`, `SkillEvaluator`, `buildRuntime()`.
- Produces: `runEvaluationBatch(options, deps?)`, executable CLI, `skill-evaluations/<run-id>/...` artifacts.

- [ ] **Step 1: Write failing batch tests**

Use temporary output directories and an injected fake evaluator. Cover:

```ts
await runEvaluationBatch({
  runId: 'test-run',
  outputRoot,
  concurrency: 2,
  resume: false,
});
```

Assertions:

1. Two successful Skills produce `input.json`, `output.json`, `output.md`, `scorecard.json`.
2. One failed Skill produces `input.json` and `error.json`; the next Skill still executes.
3. `manifest.json` contains every selected Skill exactly once.
4. `summary.md` and `summary.csv` contain every selected Skill and the disclaimer `自动评分仅供人工评估参考`.
5. `--resume` semantics skip a Skill only when both `output.json` and `scorecard.json` parse successfully; incomplete/corrupt artifacts rerun.
6. Concurrency outside 1–3 is rejected.
7. Provider `mock` is rejected before evaluator invocation.
8. `--skill ghost` is rejected with the active Skill IDs in the error.

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts
```

Expected: FAIL because batch files do not exist.

- [ ] **Step 2: Implement atomic report writing**

`report-writer.ts` must:

- create parent directories recursively;
- write to `<name>.tmp-<pid>` and `renameSync` to the final path;
- serialize JSON with two-space indentation and trailing newline;
- write `output.md` as a readable heading plus fenced pretty JSON, preserving every raw field;
- escape CSV quotes by doubling them;
- sort summary rows by numeric score descending, with `null` scores last;
- include status, verdict, total score, elapsed time, model, critical defects, and review notes.

- [ ] **Step 3: Implement batch execution and worker pool**

Public options:

```ts
export interface EvaluationRunOptions {
  runId: string;
  outputRoot: string;
  casesDir?: string;
  skillId?: string;
  concurrency: 1 | 2 | 3;
  resume: boolean;
}
```

`runEvaluationBatch` must accept injectable `skillLoader`, `evaluator`, and clock for tests. Production CLI must:

1. attempt `process.loadEnvFile('.env')`, ignoring only `ENOENT`;
2. reject `process.env.LLM_PROVIDER === 'mock'` or missing provider;
3. call `buildRuntime()` only after that guard;
4. default `runId` to UTC `YYYYMMDD-HHmmss`;
5. default output root to `skill-evaluations`;
6. parse `--skill <id>`, `--run-id <id>`, `--output-root <path>`, `--concurrency <1|2|3>`, and `--resume`;
7. set non-zero exit code if any Skill status is `failed`, but still write summaries.

Use a shared next-index worker pool with exactly `min(concurrency, selectedSkills.length)` async workers. Preserve registry order in manifest regardless of completion order.

- [ ] **Step 4: Implement resume and manifest lifecycle**

Write manifest once with `status: 'running'`, update it atomically after each Skill, and finish with `status: 'completed'` or `completed_with_failures`. For a resumed Skill, parse existing output and scorecard, add `status: 'skipped'`, and retain its score/model metadata where available.

- [ ] **Step 5: Ignore generated result directories**

Append exactly:

```gitignore
# 本地 Skill 能力评测结果：包含 LLM 生成内容，不纳入源码
skill-evaluations/*
```

Do not ignore `evaluations/skills/cases/`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-runner.test.ts
```

Expected: all batch runner tests PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add .gitignore evaluations/skills/report-writer.ts evaluations/skills/run.ts tests/skill-evaluation-runner.test.ts
git commit -m "feat: add resumable skill evaluation runner"
```

---

### Task 4: Complete 22-case synthetic evaluation corpus

**Files:**
- Create: `evaluations/skills/cases/*.json` for every active Skill.
- Modify: `package.json`
- Modify: `tests/skill-evaluation-case-loader.test.ts`

**Interfaces:**
- Consumes: `SkillEvaluationCase` contract and current active registry.
- Produces: one complete, deterministic case for every active Skill and `pnpm eval:skills`.

- [ ] **Step 1: Add a repository-completeness test**

Extend the case-loader test to use the real `SkillLoader().listActiveSkills()` and real case directory:

```ts
const active = new SkillLoader().listActiveSkills();
const cases = loadEvaluationCases(active);
assert.equal(active.length, 22);
assert.equal(cases.size, active.length);
assert.deepEqual([...cases.keys()], active.map((skill) => skill.id));
```

Run it before adding cases. Expected: FAIL listing all missing Skill IDs.

- [ ] **Step 2: Create the 22 exact case files**

Every file must set `skill_id` to its filename and describe all supplied facts as `synthetic_evaluation_data`. Use the following case inventory; each row's deliverables and risk checks must appear verbatim or more specifically in the JSON arrays.

| Skill ID | Synthetic input materials | Fixed tool outputs | Expected deliverables | Required risk checks |
|---|---|---|---|---|
| `digital-human-competitive-analysis` | Three fictional live-commerce digital-human competitors, feature/latency/content facts | Web snippets, screenshot analyses, experience-model hits, simulated-persona reviews | comparison matrix; differentiation opportunities; source list | distinguish tool facts from inference; virtual users are simulated |
| `competitive-web-research` | Three fictional shopping assistants and a 12-month comparison question | Six dated public-source snippets with URLs | evidence table; capability/strategy comparison; gaps | no claims beyond snippets; dates and URLs retained |
| `competitive-app-analysis` | Checkout and product-detail comparison brief | Three synthetic screenshot records plus aesthetic/attention/brand results | UI comparison; strengths/weaknesses; design implications | lab scores are model outputs; screenshot provenance retained |
| `design-experience-review` | Livestream product-card page description and design goals | Synthetic aesthetic, attention, and brand lab outputs | three-dimension assessment; priority actions; sources | no direct pixel claims beyond supplied outputs |
| `accessibility-review` | Mobile checkout structure with contrast, labels, focus order, target sizes, and screen-reader transcript | Empty | issue list with WCAG/POUR mapping; A/B/C level; platform fixes; retest points | distinguish observable description from untested behavior |
| `analyze-satisfaction` | Synthetic n=600 satisfaction dataset summary with overall/attribute means, derived importance, segment and period breakdowns | Empty | driver ranking; IPA quadrants; decline attribution; priorities | no significance claim without supplied test; sample sizes retained |
| `build-experience-metrics` | Livestream shopping product, business goals, guardrails, lifecycle, available event sources | Empty | HEART/GSM tree; north-star and guardrails; definitions; collection cadence | separate experience metrics from GMV/DAU business metrics |
| `code-open-feedback` | 24 short synthetic app reviews across checkout, search, delivery, price, and stability | Empty | codebook; labeled themes; frequencies; sentiment; representative anonymized quotes | multi-label allowed; no extrapolation to population prevalence |
| `competitive-analysis` | Clear competitors, dimensions, time window, and decision question | Eight synthetic source records with URLs/dates | fact table; strategic comparison; opportunity hypotheses | fact/inference separation; opportunities marked for validation |
| `conversion-funnel-analysis` | Counts for exposure→detail→cart→checkout→pay, split by new/returning and device | Empty | conversion table; largest losses; segment diagnosis; hypotheses and validation plan | counts reconcile; causes remain hypotheses |
| `feature-adoption-analysis` | Exposure, activation, repeat use, cohort retention, frequency and segment data for a new AI summary feature | Empty | adoption funnel; breadth/depth/time-to-adopt/retention; diagnosis; actions | denominators explicit; no causal claim from correlation |
| `generate-interview-guide` | Research goal, target users, product stage, 60-minute remote interview format | Empty | warm-up; modules; main questions; probe ladder; closing; moderator notes | avoid leading/double-barreled questions; consent included |
| `generate-persona` | Eight synthetic interview summaries plus behavior metrics for livestream shoppers | Empty | clustering basis; 2–3 personas; quotes; stories; behaviors; needs; recommendations | personas are research archetypes, not population segments |
| `generate-research-plan` | Complete brief for diagnosing first-purchase checkout abandonment, constraints, timing, budget, stakeholders | Empty | objectives; questions; method rationale; sampling/quota; schedule; cost; deliverables; self-check | assumptions explicit; no invented access or sample availability |
| `generate-survey` | Brief for measuring AI shopping assistant usefulness, audience, channel, max 15 questions | Empty | cover/instructions; sections; question types/scales; skip logic; closing; compliance check | neutral wording; scale anchors; privacy and optionality |
| `generate-usability-test` | Checkout prototype, target tasks, audience, remote moderated format | Empty | scenarios; think-aloud script; observation sheet; success/SEQ/SUS plan; screener | no coaching; task success criteria explicit |
| `issue-prioritization` | Ten issues with affected users, severity evidence, business impact, confidence, and effort | Empty | P0–P3; severity; RICE/ICE; impact-effort quadrant; ordered actions; quick wins | missing factors visible; arithmetic reproducible |
| `jobs-to-be-done` | Proposed one-click reorder feature plus six synthetic switch-interview excerpts | Empty | core/related Jobs; functional/emotional/social layers; context; Job Map; four forces; alternatives; recommendation | distinguish stated request from underlying Job; hypotheses labeled |
| `journey-map` | Six synthetic interviews covering discovery→purchase→delivery for two scenario types | Empty | scenario split; stage-by-dimension maps; emotion curve; pain points; opportunities; priority | do not merge materially different journeys; evidence links retained |
| `run-heuristic-evaluation` | Mobile product-detail and checkout interface description with locations and interactions | Empty | issue list; violated heuristic; 0–4 severity; location evidence; fix; priority | no unsupported visual claim; severity rationale explicit |
| `structure-interview-transcript` | One synthetic 45-minute transcript, participant background, study goal and topics | Empty | participant/execution summary; topic findings; anonymized quotes; pain points; follow-ups | single-session only; anonymize quotes; no cross-user generalization |
| `synthesize-qualitative-insights` | Six synthetic interview summaries aligned to one research objective | Empty | hierarchical themes; frequency; evidence; D/Q markers; structured insights; analysis appendix | frequency is sample frequency; opportunities remain hypotheses |

Keep each JSON concise enough for a single LLM context: target 1–8 KB, with the transcript case allowed up to 15 KB. Do not duplicate the entire Skill body inside cases.

- [ ] **Step 3: Add the package script**

Add to `package.json` scripts:

```json
"eval:skills": "tsx evaluations/skills/run.ts"
```

Do not alter the existing `test` or `quality` commands.

- [ ] **Step 4: Run corpus and linter checks**

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts
pnpm lint:registry
pnpm lint:knowledge
```

Expected: all commands PASS; case test reports 22 active Skills and 22 cases.

- [ ] **Step 5: Commit Task 4**

```bash
git add evaluations/skills/cases package.json tests/skill-evaluation-case-loader.test.ts
git commit -m "test: add full skill evaluation corpus"
```

---

### Task 5: Real-LLM preflight, full batch, and deliverable verification

**Files:**
- Generated: `skill-evaluations/<run-id>/**`
- No source changes unless verification exposes a defect.

**Interfaces:**
- Consumes: configured `.env` with `LLM_PROVIDER=gateway`, gateway URL, key, and model.
- Produces: complete review package for all 22 active Skills.

- [ ] **Step 1: Verify the source implementation before spending LLM calls**

Run:

```bash
pnpm exec tsx --test tests/skill-evaluation-case-loader.test.ts tests/skill-evaluator.test.ts tests/skill-evaluation-runner.test.ts
pnpm quality
```

Expected: all focused tests, registry/knowledge linters, and existing tests PASS.

- [ ] **Step 2: Run one real-LLM preflight**

Choose `generate-interview-guide` because it needs no Tool outputs and has a bounded deliverable:

```bash
pnpm eval:skills -- --skill generate-interview-guide --run-id preflight --concurrency 1
```

Expected files:

```text
skill-evaluations/preflight/generate-interview-guide/input.json
skill-evaluations/preflight/generate-interview-guide/output.json
skill-evaluations/preflight/generate-interview-guide/output.md
skill-evaluations/preflight/generate-interview-guide/scorecard.json
skill-evaluations/preflight/manifest.json
skill-evaluations/preflight/summary.md
skill-evaluations/preflight/summary.csv
```

Inspect the manifest status and scorecard schema. If generation fails, fix the actual runner/prompt contract and rerun the same preflight; do not proceed to 22 calls with a broken contract.

- [ ] **Step 3: Run the complete evaluation**

Use a fixed run ID based on the current date for easy handoff:

```bash
pnpm eval:skills -- --run-id 20260802-baseline --concurrency 3
```

If interrupted after partial success:

```bash
pnpm eval:skills -- --run-id 20260802-baseline --concurrency 3 --resume
```

- [ ] **Step 4: Verify the produced artifact set**

Programmatically assert through the generated `manifest.json` and filesystem checks:

- `active_skill_count === 22`;
- 22 unique Skill records exist;
- no record remains `running`;
- each succeeded/needs-review record has parseable input, output, and scorecard files;
- each failed record has a parseable error file and stage;
- summary Markdown and CSV each contain 22 Skill IDs;
- manifest contains no API key or Authorization value.

- [ ] **Step 5: Deliver the evaluation location and observed status**

Report:

- exact result directory;
- counts by `pass`, `needs_review`, and `fail`;
- failed Skill IDs and observed failure stages;
- top and bottom score groups, explicitly labeled as automatic preliminary scores;
- verification commands actually run.

Do not claim all Skills succeeded if the manifest records failures. Preserve failed outputs for diagnosis rather than replacing them with fabricated examples.
