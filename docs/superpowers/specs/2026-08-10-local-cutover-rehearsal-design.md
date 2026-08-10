# Local Cutover Rehearsal Design

## Goal

Add a local-only rehearsal path that exercises backup, restore, HTTP smoke, sealing, and verification without producing evidence eligible for staging, production go-live, or Issue #37 Gold slots.

## Decision

Add a separate `cutover:rehearse` command and a separate `cutover-rehearsal-v1` manifest. Do not add a mode flag to the existing production `cutover:prepare` command: separate commands and schemas make accidental evidence promotion harder.

## Safety Boundary

The rehearsal command must fail unless all runtime endpoints are local:

- API hostname is `localhost`, `127.0.0.1`, or `::1`.
- PostgreSQL hostname is `localhost`, `127.0.0.1`, or `::1`.
- Output, workspace, and audit paths are local filesystem paths.
- The command never invokes production migrations, traffic switching, writer shutdown, real Gold batch code, or `CutoverService.prepareGoLive()`.
- The sealed manifest always contains:
  - `environment: "local"`
  - `goLiveEligible: false`
  - `notProductionEvidence: true`
  - `notGoldSlot: true`

## Components

### `cutover-rehearsal.ts`

Owns local rehearsal orchestration and manifest verification.

Inputs:

- release ID and deployed commit label
- loopback API base URL and bearer token
- smoke task ID
- loopback PostgreSQL URL
- workspace root, audit root, and output root

Actions:

1. Create `<outputRoot>/<releaseId>/backups`.
2. Run `pg_dump --format=custom` into `database.dump`.
3. Create a uniquely named temporary database on the same local PostgreSQL server.
4. Restore the dump into the temporary database with `pg_restore`.
5. Drop the temporary database in `finally`, including restore failures.
6. Create `workspace.tar.gz` and `audit.tar.gz` with `tar`.
7. Extract each archive into temporary directories and compare recursive file SHA-256 manifests with its source.
8. Run existing `runCutoverHttpSmoke()` against the loopback API.
9. Write `rehearsal-checklist.json` with backup hashes, restore results, HTTP results, fixed local-only invariants, and a manifest hash.
10. Remove temporary restore directories.

### CLI

Extend `cutover-cli.ts`:

```text
pnpm cutover:rehearse -- \
  --release-id local-rehearsal-<timestamp> \
  --commit <git-sha> \
  --base-url http://127.0.0.1:3001 \
  --smoke-task-id <uuid> \
  --database-url-env DATABASE_URL \
  --smoke-token-env CUTOVER_SMOKE_TOKEN \
  --workspace-root ./run-workspaces \
  --audit-root ./audit \
  --output-root ./audit/local-rehearsals
```

Secrets are read from named environment variables, not passed directly on the command line.

Add verification:

```text
pnpm cutover:verify-rehearsal -- --directory <rehearsal-directory>
```

### Command execution seam

Use an injected command runner for unit tests and a Node `spawnSync` adapter in production. Reject non-zero exit codes with the command name and sanitized stderr. Never include database passwords or bearer tokens in manifests or error output.

## Failure Handling

- Missing source directory: fail before creating a checklist.
- Non-loopback URL: fail before any external command or HTTP request.
- Backup command failure: fail with no checklist.
- Restore mismatch: fail with no checklist.
- HTTP smoke failure: fail with no checklist.
- Checklist tampering: verification fails.
- Temporary DB and extraction directories are cleaned in `finally`.
- Backup artifacts may remain for diagnosis; they are explicitly local rehearsal artifacts.

## Testing

- RED/GREEN tests for fixed manifest invariants.
- Reject non-loopback API and PostgreSQL URLs before side effects.
- Fake command runner verifies dump/create/restore/drop order and cleanup on failure.
- Real temp directories verify tar archive extraction and recursive SHA comparison.
- Existing local Express server verifies HTTP smoke.
- CLI test verifies `rehearse` writes a local-only checklist and `verify-rehearsal` detects tampering.
- Final smoke uses the actual local PostgreSQL and local API only after all hermetic tests pass.

## Out of Scope

- Deploying staging or production.
- Running production migrations.
- Stopping writers or switching traffic.
- Running real LLM/Tavily workflow smoke.
- Unlocking or executing Issue #37.
