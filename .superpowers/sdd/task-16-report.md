# Task 16 Visual Assets RED

## RED Scenarios

- `tests/visual-asset-service.test.ts`
  - Remote sources accept only HTTP(S) URLs resolved from a verified, binding-matched SEALED Tool Artifact JSON Pointer; direct remote user URLs and non-HTTP schemes are rejected before DNS or fetch.
  - Loopback, RFC1918/private, link-local, metadata, IPv6 loopback/private/link-local addresses are rejected before fetch.
  - Every redirect target is resolved and revalidated; a public origin redirecting to a metadata address is rejected without fetching the target.
  - MIME/signature mismatch and an actual body over 10 MiB are rejected before any Binary or Manifest Artifact is published.
  - Tool Artifact kind, content hash, Task/Plan/Attempt binding, and JSON Pointer resolution are required.
  - Verified ai-spider `oss_url` and user PNG upload happy paths seal a Binary Artifact and canonical-hash Visual Asset Manifest.
  - Annotation and heatmap outputs are distinct immutable Derived Artifacts with original Asset id/hash/Manifest lineage.
  - `readVerified` binds verified bytes to an untampered Manifest hash and exact Asset identity.
  - Expected RED: `VisualAssetService` and its ingest/derive/readVerified contract do not exist yet.
- `tests/image-annotation-service.test.ts`
  - Structured overlays accept only rectangle, dot, arrow, and numbered callout annotations.
  - All coordinates are normalized and bounded; rectangles must remain inside the image.
  - Every annotation requires a known `findingId`, non-empty label, and severity.
  - Missing, mismatched, foreign-bound, or already-derived original Asset references are rejected before overlay persistence or rendering.
  - The sealed overlay is rendered into a new Derived Artifact while the original bytes and lineage remain immutable.
  - Expected RED: `ImageAnnotationService` and its structured overlay/renderer contract do not exist yet.
- `tests/auth-isolation.test.ts`
  - The owner Asset route returns exact bytes with Manifest-derived `Content-Type` and no storage URI disclosure.
  - Foreign owner, missing Asset, and `exportPolicy=block` all return the same generic 404 body; foreign access is rejected before Asset read.
  - Expected RED: `/api/control-tasks/:id/assets/:assetId` and the `readVisualAsset` runtime port do not exist yet.

## Implementation Facts

- Added strict per-asset Visual Asset Manifest and Image Annotation schemas plus shared manifest, source, lineage, derivation, reference, and export-policy types.
- `VisualAssetService` now accepts remote URLs only from a verified Tool Artifact RFC 6901 pointer, requires exact Task/Plan/Attempt/kind/hash binding, permits only HTTP(S), rejects credentialed or non-public targets, manually revalidates every redirect, bounds the actual response body to 10 MiB, and rejects MIME/signature disagreement before Binary publication.
- User uploads and derived annotation/heatmap bytes are published exclusively through `ControlArtifactStore.writeBinary`; verified reads exclusively use `readVerifiedBinary` and bind the bytes, trusted media metadata, Binary identity, Manifest identity, canonical Manifest hash, and Task/Plan/Attempt lineage.
- `ImageAnnotationService` validates the four supported shapes, exact fields, normalized coordinates, rectangle bounds, known Finding references, non-empty labels, severity, root-original identity, and immutable derivation before sealing the overlay and rendering from an isolated byte copy.
- The Asset route performs owner isolation before invoking the runtime read port, returns identical generic 404 bodies for foreign/missing/blocked assets, and exposes only Manifest-derived media type and trusted bytes.
- Main-agent verification after the `ReadonlySet<string>` prototype-key correction observed: `pnpm exec tsx --test --test-concurrency=1 tests/visual-asset-service.test.ts tests/image-annotation-service.test.ts tests/auth-isolation.test.ts tests/evidence-service.test.ts` => 39/39 pass, 0 fail; `pnpm typecheck` passed.
- This worker did not run commands or commit; the verification statement above records evidence supplied and observed by the main agent.
