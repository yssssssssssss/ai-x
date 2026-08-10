# Cutover Operator CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe operator CLI around the existing #36 `CutoverService` so staging and production cutover evidence can be collected, sealed, and verified without hand-writing TypeScript objects.

**Architecture:** Add a small `apps/orchestrator-runtime/src/cutover/` CLI layer that reads a JSON evidence file plus local backup file paths, derives machine-checkable fields, calls `CutoverService.prepareGoLive()` / `verifyGoLivePackage()`, and exits fail-closed. Keep real production actions outside the CLI: it validates evidence and runs safe HTTP probes, but it does not stop writers, perform database migrations, switch traffic, or run #37 Gold slots.

**Tech Stack:** TypeScript, Node.js 20, `tsx`, built-in `node:test`, existing `CutoverService`, existing `pnpm quality` gate.

## Global Constraints

- Do not run #37 Gold Batch in this plan.
- Do not execute production migrations, delete data, stop production writers, or switch traffic from the CLI.
- Default mode must be safe for staging rehearsal and local tests.
- Any operator-supplied boolean that cannot be machine-proven must be explicit in the input file and echoed into the sealed checklist.
- Backup inventory SHA-256 and bytes must be machine-derived from local files when local paths are provided.
- `cutover:prepare` must fail closed: missing required evidence, malformed SHA, failed smoke, or `NO_GO` exits non-zero and does not seal a checklist.
- `cutover:verify` must fail closed on missing checklist, invalid hash, or failed embedded evidence validation.
- Smoke/rejection probes must never count as Gold slots.
- Tests must follow RED/GREEN: write failing tests first, observe failure, implement minimal code, observe pass.

---

## File Structure

- Create `apps/orchestrator-runtime/src/cutover/cutover-cli.ts`
  - Thin CLI entrypoint.
  - Parses `prepare` and `verify` subcommands.
  - Calls the focused modules below.
- Create `apps/orchestrator-runtime/src/cutover/cutover-input.ts`
  - Defines operator JSON input shape.
  - Normalizes/validates operator evidence before service call.
  - Derives backup inventory from local paths when present.
- Create `apps/orchestrator-runtime/src/cutover/cutover-smoke.ts`
  - Runs safe HTTP probes: `healthz`, legacy mutation `410`, old route `404`.
  - Does not call real LLM or Tavily; non-gold workflow smoke remains operator-supplied until a separate workflow driver exists.
- Modify `apps/orchestrator-runtime/src/cutover/cutover-service.ts`
  - Export `CutoverManifest` if tests/CLI need typed verify output.
  - Avoid changing existing gate semantics unless a test exposes a real gap.
- Modify `package.json`
  - Add `cutover:prepare` and `cutover:verify` scripts.
- Create `tests/cutover-cli.test.ts`
  - CLI behavior tests using temp files and local HTTP server.
- Modify `helloagents/CHANGELOG.md`
  - Add Unreleased entry for operator CLI.

---

### Task 1: Operator Input Normalization

**Files:**
- Create: `apps/orchestrator-runtime/src/cutover/cutover-input.ts`
- Test: `tests/cutover-cli.test.ts`

**Interfaces:**
- Consumes: `backupInventoryFromFiles`, `CutoverEvidence`, `CutoverGateError` from `apps/orchestrator-runtime/src/cutover/cutover-service.ts`.
- Produces:
  - `export interface CutoverOperatorInput`
  - `export function loadCutoverOperatorInput(path: string): CutoverOperatorInput`
  - `export function evidenceFromOperatorInput(input: CutoverOperatorInput): CutoverEvidence`

#### Implementation Requirements

- Add tests equivalent to the plan draft:
  - local `backupFiles` derive `sha256:<64 hex>` and `bytes` from real temp files.
  - false `restoreChecked` fails closed with `CutoverGateError` mentioning `backup.audit.restoreChecked`.
  - JSON file loads from disk and preserves `release.releaseId`.
- Implement `CutoverOperatorInput` as `Omit<CutoverEvidence, 'backup'>` plus optional `backup` and optional `backupFiles`.
- Implement pure validation by exporting `validateCutoverEvidence(evidence: CutoverEvidence): void` from `cutover-service.ts` and using it in `evidenceFromOperatorInput`. Do not call `prepareGoLive()` for validation because that writes files.
- Run: `pnpm exec tsx --test tests/cutover-cli.test.ts`.
- Commit: `feat: add cutover operator input normalization`.

---

### Task 2: Safe HTTP Smoke Sensors

**Files:**
- Create: `apps/orchestrator-runtime/src/cutover/cutover-smoke.ts`
- Test: `tests/cutover-cli.test.ts`

**Interfaces:**
- Produces:
  - `export interface CutoverHttpSmokeOptions`
  - `export interface CutoverHttpSmokeResult`
  - `export async function runCutoverHttpSmoke(options: CutoverHttpSmokeOptions): Promise<CutoverHttpSmokeResult>`

#### Implementation Requirements

- Add tests using local Express server:
  - success records `healthz: true`, `legacyMutation410: true`, `oldRoute404: true`.
  - legacy mutation status 200 rejects with message containing `legacy mutation expected 410`.
- Implement probes:
  - `GET /api/healthz` must be 200.
  - `POST /api/tasks/:taskId/execute` must be 410.
  - `POST /api/legacy/tasks/:taskId/execute` must be 404.
- Include bearer token and `content-type: application/json` headers on POST requests.
- Run: `pnpm exec tsx --test tests/cutover-cli.test.ts`.
- Commit: `feat: add cutover HTTP smoke probes`.

---

### Task 3: Prepare CLI Command

**Files:**
- Create: `apps/orchestrator-runtime/src/cutover/cutover-cli.ts`
- Modify: `package.json`
- Test: `tests/cutover-cli.test.ts`

**Interfaces:**
- Consumes:
  - `loadCutoverOperatorInput(path)`
  - `evidenceFromOperatorInput(input)`
  - `CutoverService.prepareGoLive(evidence)`
  - `runCutoverHttpSmoke(options)`
- Produces:
  - CLI command: `pnpm cutover:prepare -- --input <input.json> --audit-root <dir>`
  - Optional smoke flags: `--smoke-base-url <url> --smoke-token <token> --smoke-task-id <id>`

#### Implementation Requirements

- Add CLI prepare tests:
  - seals checklist from operator input and prints `decision=GO`.
  - exits non-zero on `operator.goNoGo = 'NO_GO'` and does not seal checklist.
- Implement `cutover-cli.ts prepare` with minimal flag parser.
- If smoke flags are present, run `runCutoverHttpSmoke()` and set `input.readOnlySmoke.legacyMutation410` and `input.readOnlySmoke.oldRoutesAbsent` from smoke results.
- Add package script: `"cutover:prepare": "tsx apps/orchestrator-runtime/src/cutover/cutover-cli.ts prepare"`.
- Run: `pnpm exec tsx --test tests/cutover-cli.test.ts`.
- Commit: `feat: add cutover prepare CLI`.

---

### Task 4: Verify CLI Command

**Files:**
- Modify: `apps/orchestrator-runtime/src/cutover/cutover-cli.ts`
- Modify: `package.json`
- Test: `tests/cutover-cli.test.ts`

**Interfaces:**
- Consumes: `CutoverService.verifyGoLivePackage(directory)`
- Produces:
  - CLI command: `pnpm cutover:verify -- --directory <auditRoot>/cutovers/<releaseId>`

#### Implementation Requirements

- Add CLI verify test:
  - prepare a checklist.
  - verify accepts sealed checklist and prints `verified=true`.
  - tampering with `cutover-checklist.json` makes verify exit non-zero and mention `cutover checklist hash`.
- Implement `verify` subcommand.
- Add package script: `"cutover:verify": "tsx apps/orchestrator-runtime/src/cutover/cutover-cli.ts verify"`.
- Run: `pnpm exec tsx --test tests/cutover-cli.test.ts`.
- Commit: `feat: add cutover verify CLI`.

---

### Task 5: Documentation, Changelog, and Full Verification

**Files:**
- Modify: `helloagents/CHANGELOG.md`
- Optional create: `docs/cutover-operator-cli.md` if the repository already accepts operator docs in `docs/`; otherwise keep operational instructions in the issue comment only.
- Test: no new test file; run full project gates.

#### Implementation Requirements

- Add changelog entry under `## [Unreleased]` / `### 新增`:
  - `新增 Cutover operator CLI：pnpm cutover:prepare ... pnpm cutover:verify ...`
- Prepare final issue/PR comment usage text with examples for:
  - `pnpm cutover:prepare -- --input cutover-input.json --audit-root audit`
  - `pnpm cutover:prepare -- --input cutover-input.json --audit-root audit --smoke-base-url https://staging.example.com --smoke-token "$STAGING_TOKEN" --smoke-task-id smoke-task-id`
  - `pnpm cutover:verify -- --directory audit/cutovers/<releaseId>`
- Boundary text must say CLI does not stop writers, run production migrations, switch traffic, or run #37 Gold slots.
- Run focused tests:
  - `pnpm exec tsx --test tests/cutover-cli.test.ts tests/cutover-service.test.ts tests/cutover-sensors.test.ts`
- Run full quality:
  - `pnpm quality`
- Run web build:
  - `cd apps/web && pnpm install --no-lockfile && pnpm build`
- Run migration dry-run:
  - `pnpm db:migrate -- --dry-run`
- Run diff check:
  - `git diff --check`
- Commit: `chore: document cutover operator CLI`.

---

## Self-Review

**Spec coverage:** Operator CLI, backup inventory, restore check, HTTP smoke, sealed prepare/verify, staging-first usage, and production boundary are covered.

**No production side effects:** The CLI validates evidence and safe HTTP probes only. It does not stop writers, migrate production DBs, switch traffic, or run #37.

**Type consistency:** Public interfaces are introduced before use and script names match subcommands.
