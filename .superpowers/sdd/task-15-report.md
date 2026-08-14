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
- GREEN binary suite after initial implementation: 13/13 passed.
- Initial exact serial suite passed 50/50.
- `pnpm typecheck`: passed.
- `tests/artifact-store.test.ts` does not exist, so it was omitted rather than invented.

## Compatibility and Security Coverage

- Deterministic PNG/JPEG/WebP happy paths use misleading filename extensions to prove byte sniffing.
- Boundary tests cover exactly 10 MiB versus one byte over, and exactly 20,000,000 versus 20,000,001 pixels using valid inflated PNG payloads.
- Negative tests cover SVG, unknown, malformed, truncated, and dimension/payload-mismatched bytes; hash, path, symlink, and persisted metadata tamper; expired/foreign leases and renewed retry; traversal; destination collision/no-clobber; Task/Plan/Attempt containment; missing-root first write; ambiguous seal response; and legacy JSON behavior.
- The real PostgreSQL ControlPlane test round-trips non-null `media_type`/`metadata_json`, verifies the binary bytes and reconstructed trusted metadata, and confirms JSON artifacts still return null media fields.

## Security Hardening Review Closure

- Added ten independent RED regressions for incomplete JPEG SOF/SOS/entropy, header-only VP8, indexed PNG palette overflow, pre-inflate pixel rejection, pre-copy input limits, pre-allocation stored-file limits, Task/Plan/Attempt relational mismatch, destination replacement, publication-parent symlink swap, and IDAT chunk amplification. Binary RED was 13 pass / 9 expected fail; ControlPlane RED was 37 pass / 1 expected fail.
- JPEG validation now binds DQT/DHT table definitions to exact SOF components and SOS selectors, validates frame/scan lengths, spectral parameters, entropy marker escaping, non-empty scans, and terminal EOI. The previous malformed 517-byte fixture was replaced by a deterministic 339-byte baseline JPEG generated locally and stripped to essential segments.
- WebP validation now rejects dimension-header-only data: VP8 checks key-frame tag, show/version bits, first-partition length, dimensions, and remaining payload; VP8L requires post-header compressed payload/version; VP8X/ANMF validate nested chunk lengths and actual VP8/VP8L frames.
- PNG validation caps IDAT at 1,024 chunks, rejects pixel limits before inflate, reconstructs all filter modes across normal/Adam7 rows, and checks indexed samples against PLTE entries.
- Writes reject `byteLength` before copying. The temp file, root, publication parent, and destination are opened with `O_NOFOLLOW`; fsync/fstat and `dev`/`ino`/size/link-count checks bind the DB seal to the validated input digest. Parent/destination swaps invalidate the Artifact and never seal attacker bytes.
- Verified binary reads use the relational repository binding, then `O_NOFOLLOW` open and `fstat` to enforce regular-file, sealed-size, and 10 MiB limits before allocating; the same descriptor is hashed and identity-checked after reading.
- ControlPlane validates Plan→Task and Attempt→Task/Plan during STAGING, unleased and leased seal, and verified binary lookup. Independent foreign keys can no longer form a trusted mixed tuple.
- Final exact serial suite: `pnpm exec tsx --test --test-concurrency=1 tests/binary-artifact-store.test.ts tests/control-plane.test.ts` passed 60/60. Final `pnpm typecheck` passed.

## Decoded Binary Security Correction

- The second security gate invalidated the earlier claim that `image-size` plus handwritten JPEG/WebP structure checks proved complete decodability. `image-size` remains the bounded header/dimension preflight; root `sharp@0.35.3` is now the local decode authority. This is an intentional security correction to the original image-size-only dependency expectation.
- Every accepted image is decoded to raw pixels with `sharp(bytes, { failOn: 'warning', limitInputPixels: 20_000_000, animated: false })`. Metadata must be single-page/non-animated and decoded format, width, height, channel count, and raw byte count must agree with the sniffed header. PNG keeps its additional CRC/chunk/filter/index/IDAT defenses.
- The DB seal digest is now read from the pinned published fd and compared with the caller digest before seal. Descriptor hashing performs exact-size `fstat` before and after reading. After the asynchronous seal returns, the same fd is hashed again; same-inode overwrite or append invalidates the Artifact. JSON uses the identical double-hash lifecycle.
- The configured root is opened `O_DIRECTORY|O_NOFOLLOW` and its physical path pinned before parent creation/publication. After parent/temp/destination open, and after link and seal, root/parent/temp/published identities plus physical containment are rechecked. A deterministic intermediate-ancestor swap before parent open fails before seal; a swap between parent check and temp open is detected immediately after the empty temp fd opens and before any bytes are written. Suspicious paths are not used for cleanup.
- Correction RED: JPEG decode, VP8/VP8L decode, same-inode overwrite/append, and both intermediate ancestor swap windows each failed independently before implementation. Final binary suite passed 28/28; exact binary + ControlPlane suite passed 66/66; final `pnpm typecheck` passed.
