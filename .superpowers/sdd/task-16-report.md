# Task 16 Visual Assets RED

## RED Scenarios

- `tests/visual-asset-service.test.ts`
  - Remote sources accept only HTTP(S) URLs resolved from a verified, binding-matched SEALED Tool Artifact JSON Pointer; direct remote user URLs and non-HTTP schemes are rejected before DNS or fetch.
  - Loopback, RFC1918/private, link-local, metadata, IPv6 loopback/private/link-local addresses are rejected before fetch.
  - Every redirect target is resolved and revalidated; a public origin redirecting to a metadata address is rejected without fetching the target.
  - DNS approval and transport connection are one security decision: every redirect hop must pin the exact validated public addresses while retaining the original HTTP Host and TLS SNI, so a second transport lookup cannot rebind to private or metadata IPs.
  - MIME/signature mismatch and an actual body over 10 MiB are rejected before any Binary or Manifest Artifact is published.
  - Tool Artifact kind, content hash, Task/Plan/Attempt binding, and JSON Pointer resolution are required.
  - Verified ai-spider `oss_url` and user PNG upload happy paths seal a Binary Artifact and canonical-hash Visual Asset Manifest.
  - Annotation and heatmap outputs are distinct immutable Derived Artifacts with original Asset id/hash/Manifest lineage.
  - `readVerified` binds verified bytes to an untampered Manifest hash and exact Asset identity.
  - Manifest schema validation runs before write and again on verified read; a SEALED Manifest with recomputed self-hash and Artifact hash still fails for missing/invalid export policy, malformed source/derivation, or wrong Manifest Artifact schemaVersion.
  - Expected reviewer RED: fetch is not pinned to approved DNS addresses, and Manifest schema/schemaVersion are not enforced on write and read.
- `tests/image-annotation-service.test.ts`
  - Structured overlays accept only rectangle, dot, arrow, and numbered callout annotations.
  - All coordinates are normalized and bounded; rectangles must remain inside the image.
  - Every annotation requires a known `findingId`, non-empty label, and severity.
  - Missing, mismatched, foreign-bound, or already-derived original Asset references are rejected before overlay persistence or rendering.
  - The sealed overlay is rendered into a new Derived Artifact while the original bytes and lineage remain immutable.
  - Default production construction requires no test renderer callback and uses a controlled renderer that emits a decodable, non-no-op Derived PNG.
  - Expected reviewer RED: `ImageAnnotationService` still requires an injected test renderer and has no default controlled production renderer.
- `tests/auth-isolation.test.ts`
  - The owner Asset route returns exact bytes with Manifest-derived `Content-Type` and no storage URI disclosure.
  - Foreign owner, missing Asset, and `exportPolicy=block` all return the same generic 404 body; foreign access is rejected before Asset read.
  - Missing export policy, malformed source/derivation, and wrong Manifest Artifact schemaVersion are treated as blocked reads and return the same generic 404.
  - Expected reviewer RED: the route trusts malformed Manifest values returned by its runtime port instead of failing closed.

## Implementation Facts

- Added strict per-asset Visual Asset Manifest and Image Annotation schemas plus shared manifest, source, lineage, derivation, reference, and export-policy types.
- `VisualAssetService` now accepts remote URLs only from a verified Tool Artifact RFC 6901 pointer, requires exact Task/Plan/Attempt/kind/hash binding, permits only HTTP(S), rejects credentialed or non-public targets, manually revalidates every redirect, bounds the actual response body to 10 MiB, and rejects MIME/signature disagreement before Binary publication.
- User uploads and derived annotation/heatmap bytes are published exclusively through `ControlArtifactStore.writeBinary`; verified reads exclusively use `readVerifiedBinary` and bind the bytes, trusted media metadata, Binary identity, Manifest identity, canonical Manifest hash, and Task/Plan/Attempt lineage.
- `ImageAnnotationService` validates the four supported shapes, exact fields, normalized coordinates, rectangle bounds, known Finding references, non-empty labels, severity, root-original identity, and immutable derivation before sealing the overlay and rendering from an isolated byte copy.
- The Asset route performs owner isolation before invoking the runtime read port, returns identical generic 404 bodies for foreign/missing/blocked assets, and exposes only Manifest-derived media type and trusted bytes.
- Main-agent verification after the `ReadonlySet<string>` prototype-key correction observed: `pnpm exec tsx --test --test-concurrency=1 tests/visual-asset-service.test.ts tests/image-annotation-service.test.ts tests/auth-isolation.test.ts tests/evidence-service.test.ts` => 39/39 pass, 0 fail; `pnpm typecheck` passed.
- This worker did not run commands or commit; the verification statement above records evidence supplied and observed by the main agent.

## Reviewer Blocker Fix Facts

- The production remote-image path now creates a fresh Node 22 `http`/`https` Agent for every request hop. Its `lookup` callback can return only the already validated public address set; the request URL and Host header retain the original host, and HTTPS explicitly retains the original DNS hostname for SNI. A redirect repeats resolution, public-address validation, and Agent construction before the next request. An explicit injected transport remains available for tests, while an injected fetch is only an explicit test adapter and is never the production default.
- Visual Asset Manifest persistence preflights the complete `visual-asset-manifest` schema before Binary publication, validates the completed Manifest again before JSON publication, and revalidates schema, Manifest Artifact `schemaVersion`, canonical self-hash, verified Binary metadata, identity, binding, source, and root/derived lineage on read. The schema now requires derived source, lineage, and derivation to occur together; non-derived sources require both lineage fields to be null.
- The Asset route independently applies the Manifest schema and requires Manifest Artifact `schemaVersion=visual-asset-manifest-v1`; only explicit `allow` or `mask` policies are exportable, and every malformed/unknown/blocked value follows the existing generic 404 path.
- `ImageAnnotationService` now defaults to a controlled `sharp` renderer. It converts only the validated rectangle, dot, arrow, and numbered-callout overlay model into escaped SVG primitives, composites them over the immutable original, and emits PNG bytes for normal `VisualAssetService.derive` publication. `buildControlRuntime` constructs this production service and exposes the real `annotateVisualAsset` call path; tests may still inject a renderer.
- Per assignment, no tests, typecheck, lint, build, formatter, or other validation command was run for these reviewer fixes.
- Main-agent follow-up observed the reviewer-fix suite at 44/44 pass. The same follow-up typecheck reported exactly two typing defects: the ES2022 project library does not expose the DOM `BodyInit` name, and the UUID fixture array inferred a narrower template-literal element type than the runtime port's string Asset id. The implementation now uses `ConstructorParameters<typeof Response>[0]` for the unchanged Node 22 stream body, and the fixture explicitly declares its readable Asset ids as `readonly string[]`. This worker ran no commands and makes no post-correction typecheck claim.
- Final evidence observed by the main agent after the two type corrections: `pnpm exec tsx --test --test-concurrency=1 tests/visual-asset-service.test.ts tests/image-annotation-service.test.ts tests/auth-isolation.test.ts tests/evidence-service.test.ts` => 44/44 pass, 0 fail; `pnpm typecheck` passed. This closes the DNS pinning, full Manifest/schemaVersion/fail-closed route, and default production PNG annotation renderer reviewer blockers. This worker ran no commands and made no commit.
