### Task 15: Binary Artifact Store

**用户收益：** 报告图片以本地不可覆盖 Artifact 持久化，并在读取时像 JSON Evidence 一样重新校验 sealed hash；调用方只获得由文件字节推导出的可信媒体元数据。

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/orchestrator-runtime/src/control/artifact-store.ts`
- Modify: `database/control-plane.ts`
- Create: `tests/binary-artifact-store.test.ts`
- Create: `.superpowers/sdd/task-15-report.md`
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/superpowers/plans/2026-08-14-trusted-multimodal-research-system.md`

**Interfaces:**
- `ControlArtifactStore.writeBinary(input)` accepts raw bytes plus Task/Plan/Attempt identity and a versioned-workspace relative path. It never accepts or trusts caller MIME/dimensions.
- `ControlArtifactStore.readVerifiedBinary(artifactId)` returns `{ artifact, bytes, metadata }`, where metadata contains only sealed `contentType`, `byteSize`, `width`, and `height` derived from the bytes.
- Supported formats are PNG, JPEG, and WebP only. SVG and all unknown, invalid, or truncated files fail closed.
- Maximum encoded size is exactly 10 MiB inclusive; maximum decoded dimensions are exactly 20,000,000 pixels inclusive.
- Existing `control_artifacts.media_type` and `metadata_json` columns persist trusted metadata; legacy rows remain readable and existing JSON behavior is unchanged.

- [x] **Step 1: dependency**

Add root `image-size` and its lockfile entry only.

- [x] **Step 2: RED tests**

Cover deterministic PNG, JPEG, and WebP write/read happy paths; exact 10 MiB acceptance and one-byte-over rejection; exact 20 MP acceptance and one-pixel-over rejection; SVG, unknown, malformed, and truncated image rejection; sealed file hash tamper; sealed record path tamper; expired and foreign active lease rejection; traversal; immutable destination/no-clobber; Task/Plan/Attempt versioned containment; and legacy JSON round trip/database-null compatibility.

- [x] **Step 3: confirm RED**

Run `pnpm exec tsx --test --test-concurrency=1 tests/binary-artifact-store.test.ts` and record the exact missing-contract failures.

- [x] **Step 4: GREEN implementation**

Extract one private `writeBytes()` that owns STAGING creation, directory creation, temp write, fsync, hard-link no-clobber publish, reread/hash, and DB seal/failure. Route both `writeJson()` and `writeBinary()` through it. Sniff media and dimensions from bytes before staging. Bind trusted media metadata at staging creation and preserve the existing lease fence by passing the same `activeLease` to `sealArtifact()`.

Verified binary reads first require SEALED, re-check path containment and content hash, re-sniff the bytes, enforce byte/pixel limits again, and require exact equality with persisted trusted metadata. JSON reads retain their existing verified-hash behavior and tolerate null media fields.

- [x] **Step 5: exact verification**

```bash
pnpm exec tsx --test --test-concurrency=1 tests/binary-artifact-store.test.ts tests/control-plane.test.ts
pnpm typecheck
```

`tests/artifact-store.test.ts` does not exist and must not be invented.

- [x] **Step 6: docs and commit**

Record RED/GREEN evidence in Task15 report, set progress Next task to Phase 5 / Task 16, append the plan execution note, exact-add Task15 files, and commit `feat: seal binary current artifacts`.
