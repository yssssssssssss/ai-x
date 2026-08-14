# Task 15 Binary Artifact Store

Status: complete

## Implementation

- Added root `image-size` dependency only. Binary callers provide raw bytes; no MIME type, extension, dimensions, or other caller metadata is trusted.
- Added `writeBinary()` and `readVerifiedBinary()` for PNG, JPEG, and WebP. SVG, unknown signatures, malformed/truncated containers, encoded payloads over 10 MiB, and images over 20,000,000 pixels fail before STAGING creation.
- PNG chunk order/CRC and inflated scanline layout, JPEG marker/table/scan structure, and WebP RIFF plus real image-chunk signatures are checked before `image-size` derives dimensions. Exact 10 MiB and 20,000,000-pixel values remain accepted; 20,000,001 pixels fail.
- Extracted one private `writeBytes()` used by JSON and binary writes. Both retain the existing STAGING → temp write → fsync → hard-link no-clobber publish → persisted-byte hash → repository seal/failure lifecycle and the same optional active-lease fence. A rejected seal quarantines its published file so a renewed lease can retry; a committed seal with a lost response is recovered from DB without moving the trusted file.
- Binary bytes are copied before the asynchronous staging operation. Their trusted media type and `{ width, height }` are stored through Migration 004's existing `media_type` and `metadata_json`; byte size remains in the existing sealed `byte_size`. No migration was added.
- Verified binary reads require SEALED state, lexically and physically contain the stored path under its Task/Plan/Attempt workspace, compare both SHA-256 and byte size, re-inspect the media, reapply size/pixel limits, and require exact persisted metadata equality.
- `ControlArtifact` media fields are optional for in-process legacy adapters but the PostgreSQL row mapper normalizes absent legacy values to `null`. Existing JSON hash verification remains path-compatible with legacy null-Plan rows.

## TDD Evidence

- RED command: `pnpm exec tsx --test --test-concurrency=1 tests/binary-artifact-store.test.ts`.
- RED result: 10 tests total; the legacy JSON compatibility test passed and all 9 binary contract tests failed with `TypeError: store.writeBinary is not a function`.
- The first implementation run passed 8/10 and exposed that the initial WebP fixture contained four bytes beyond its declared RIFF length. The fixture was corrected to a valid deterministic 42-byte WebP; production validation remained strict.
- Review follow-up RED reproduced three additional contract failures: mismatched PNG IHDR/payload was accepted, expired-lease retry hit `EEXIST`, and legacy null-Plan JSON reads failed. Separate regressions also covered missing-root first write, workspace symlink escape, one-pixel-over dimensions, and committed-seal response loss.
- GREEN binary suite: 13/13 passed.
- GREEN exact serial suite: `pnpm exec tsx --test --test-concurrency=1 tests/binary-artifact-store.test.ts tests/control-plane.test.ts` passed 50/50.
- `pnpm typecheck`: passed.
- `tests/artifact-store.test.ts` does not exist, so it was omitted rather than invented.

## Compatibility and Security Coverage

- Deterministic PNG/JPEG/WebP happy paths use misleading filename extensions to prove byte sniffing.
- Boundary tests cover exactly 10 MiB versus one byte over, and exactly 20,000,000 versus 20,000,001 pixels using valid inflated PNG payloads.
- Negative tests cover SVG, unknown, malformed, truncated, and dimension/payload-mismatched bytes; hash, path, symlink, and persisted metadata tamper; expired/foreign leases and renewed retry; traversal; destination collision/no-clobber; Task/Plan/Attempt containment; missing-root first write; ambiguous seal response; and legacy JSON behavior.
- The real PostgreSQL ControlPlane test round-trips non-null `media_type`/`metadata_json`, verifies the binary bytes and reconstructed trusted metadata, and confirms JSON artifacts still return null media fields.
