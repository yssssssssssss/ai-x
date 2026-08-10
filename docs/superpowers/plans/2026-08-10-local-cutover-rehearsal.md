# Local Cutover Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a local-only cutover rehearsal that proves backup/restore, loopback HTTP smoke, and sealed checklist behavior without creating production-eligible evidence.

**Architecture:** Add a separate rehearsal service and manifest rather than weakening the production `CutoverService`. The service accepts injected command execution for hermetic tests, enforces loopback-only API/PostgreSQL endpoints before side effects, performs actual local backup/restore checks, then seals a `cutover-rehearsal-v1` manifest with immutable non-production invariants.

**Tech Stack:** TypeScript, Node.js 20, `node:test`, PostgreSQL CLI 18.3, bsdtar, existing Cutover HTTP smoke and SHA utilities.

## Global Constraints

- Never call `CutoverService.prepareGoLive()` from rehearsal code.
- Never run Issue #37 or Gold batch code.
- Never accept non-loopback API or PostgreSQL hosts.
- Never put bearer tokens, database passwords, or local backup source paths in the sealed manifest.
- Always seal `environment=local`, `goLiveEligible=false`, `notProductionEvidence=true`, and `notGoldSlot=true`.
- No checklist is written until all backup, restore, and HTTP checks pass.
- Temporary databases and extraction directories are cleaned in `finally`.
- Every production-code change follows RED/GREEN TDD.

---

### Task 1: Rehearsal Manifest and Loopback Guard

**Files:**
- Create: `apps/orchestrator-runtime/src/cutover/cutover-rehearsal.ts`
- Create: `tests/cutover-rehearsal.test.ts`

**Interfaces:**

```ts
export interface LocalRehearsalManifest {
  version: 'cutover-rehearsal-v1';
  releaseId: string;
  commit: string;
  environment: 'local';
  goLiveEligible: false;
  notProductionEvidence: true;
  notGoldSlot: true;
  backups: Record<'database' | 'workspace' | 'audit', { uri: string; sha256: string; bytes: number; restoreChecked: true }>;
  httpSmoke: { healthz: true; legacyMutation410: true; oldRoute404: true };
  manifestHash: string;
}

export function assertLoopbackUrl(value: string, label: string): URL;
export function verifyLocalRehearsal(directory: string): LocalRehearsalManifest;
```

- [ ] Write failing tests asserting fixed local-only fields, non-loopback rejection, and tamper rejection.
- [ ] Run `pnpm exec tsx --test tests/cutover-rehearsal.test.ts`; expect module-not-found RED.
- [ ] Implement loopback validation, stable hashing, checklist write/verify helpers.
- [ ] Run the focused test; expect GREEN.
- [ ] Commit: `feat: add local cutover rehearsal manifest`.

### Task 2: Workspace and Audit Archive Restore

**Files:**
- Modify: `apps/orchestrator-runtime/src/cutover/cutover-rehearsal.ts`
- Modify: `tests/cutover-rehearsal.test.ts`

**Interfaces:**

```ts
export interface CommandResult { status: number; stderr: string }
export type CommandRunner = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => CommandResult;
export function archiveAndRestoreDirectory(input: {
  name: 'workspace' | 'audit';
  source: string;
  backupDirectory: string;
  runner: CommandRunner;
}): { uri: string; sha256: string; bytes: number; restoreChecked: true };
```

- [ ] Write failing tests using real temp source directories and a real `tar` runner. Assert extracted file manifests equal source and missing roots fail before checklist creation.
- [ ] Run focused test; expect missing API RED.
- [ ] Implement tar creation/extraction, recursive file SHA manifest comparison, and temporary directory cleanup.
- [ ] Run focused test; expect GREEN.
- [ ] Commit: `feat: verify local workspace and audit backups`.

### Task 3: Local PostgreSQL Backup and Restore

**Files:**
- Modify: `apps/orchestrator-runtime/src/cutover/cutover-rehearsal.ts`
- Modify: `tests/cutover-rehearsal.test.ts`

**Interfaces:**

```ts
export function backupAndRestoreLocalDatabase(input: {
  databaseUrl: string;
  backupDirectory: string;
  runner: CommandRunner;
  temporaryDatabaseName?: string;
}): { uri: string; sha256: string; bytes: number; restoreChecked: true };
```

- [ ] Write failing tests with an injected runner asserting command order: `pg_dump`, `createdb`, `pg_restore`, `dropdb`.
- [ ] Add failure test asserting `dropdb` still runs after `pg_restore` fails.
- [ ] Add non-loopback database test asserting zero runner calls.
- [ ] Run focused test; expect missing API RED.
- [ ] Implement URL parsing, password-to-`PGPASSWORD` environment handling, sanitized args, custom-format dump, temporary DB restore, and `finally` cleanup.
- [ ] Run focused test; expect GREEN.
- [ ] Commit: `feat: verify local database backup restore`.

### Task 4: Rehearse and Verify CLI

**Files:**
- Modify: `apps/orchestrator-runtime/src/cutover/cutover-rehearsal.ts`
- Modify: `apps/orchestrator-runtime/src/cutover/cutover-cli.ts`
- Modify: `package.json`
- Modify: `tests/cutover-rehearsal.test.ts`

**Interfaces:**

```ts
export async function runLocalRehearsal(input: {
  releaseId: string;
  commit: string;
  baseUrl: string;
  bearerToken: string;
  smokeTaskId: string;
  databaseUrl: string;
  workspaceRoot: string;
  auditRoot: string;
  outputRoot: string;
  runner?: CommandRunner;
}): Promise<{ directory: string; manifest: LocalRehearsalManifest }>;
```

CLI commands:

```text
pnpm cutover:rehearse -- --release-id <id> --commit <sha> --base-url <loopback-url> --smoke-task-id <id> --database-url-env DATABASE_URL --smoke-token-env CUTOVER_SMOKE_TOKEN --workspace-root <path> --audit-root <path> --output-root <path>
pnpm cutover:verify-rehearsal -- --directory <path>
```

- [ ] Write failing CLI tests with local Express smoke server, temp directories, and injected/fake PostgreSQL command runner at service level.
- [ ] Assert stdout contains `verified=true`, `environment=local`, `goLiveEligible=false`, `notGoldSlot=true`.
- [ ] Assert missing env variables and non-loopback URLs exit non-zero before files are written.
- [ ] Run focused test; expect command-not-supported RED.
- [ ] Implement service orchestration, CLI subcommands, and package scripts.
- [ ] Run focused tests; expect GREEN.
- [ ] Commit: `feat: add local cutover rehearsal CLI`.

### Task 5: Real Local Rehearsal and Full Verification

**Files:**
- Modify: `helloagents/CHANGELOG.md`
- Generated but untracked/ignored evidence: `audit/local-rehearsals/<releaseId>/`

- [ ] Start the local API with the existing dev-stack command or supervised `pnpm api:dev`.
- [ ] Generate a local low-privilege bearer token through existing auth utilities and inject it only as `CUTOVER_SMOKE_TOKEN`.
- [ ] Confirm `DATABASE_URL` is loopback and points to the local development database.
- [ ] Run `pnpm db:migrate` against the local database.
- [ ] Run `pnpm cutover:rehearse` with local workspace/audit roots.
- [ ] Run `pnpm cutover:verify-rehearsal` on the produced directory.
- [ ] Inspect output for the four fixed non-production invariants.
- [ ] Run focused tests: `pnpm exec tsx --test tests/cutover-rehearsal.test.ts tests/cutover-cli.test.ts tests/cutover-service.test.ts tests/cutover-sensors.test.ts`.
- [ ] Run `pnpm quality`, web build, migration dry-run, and `git diff --check`.
- [ ] Add a changelog entry explaining that local rehearsal evidence is never production or Gold evidence.
- [ ] Commit: `chore: document local cutover rehearsal`.

## Self-Review

- Production cutover semantics stay unchanged.
- Rehearsal evidence has a distinct version and directory.
- Loopback checks happen before side effects.
- Secrets remain in environment variables and process environment only.
- Backup and restore are actually executed locally; booleans are not operator-fabricated.
- The plan has no staging or production deployment step and cannot unlock Issue #37.
