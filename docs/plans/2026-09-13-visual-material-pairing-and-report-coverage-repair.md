# Visual Material Pairing and Dynamic Report Coverage Repair

Status: Implemented
Date: 2026-09-13

## Problem

A competitive task can seal and analyze every uploaded image while the final Canonical selects only a model-chosen subset for `screenshotComparisons`. The ReportDocument then faithfully renders only that subset. The current visual inventory also loses the structured Task Material role and pair identity before synthesis, so a screenshot can be labeled as the wrong side.

## Decision

1. Uploaded image counts are always dynamic. No code or schema may assume 5+5 or equal group sizes.
2. Grouped comparison is the default. It displays every verified uploaded original, grouped by Material Request role.
3. Paired comparison is explicit. A user-confirmed pairing binds one primary Material Artifact and one comparison Material Artifact. Upload order and file names are never authoritative.
4. Pairing is stored with the existing clarification and Plan-bound visual gate data. No new database table, task state, Plan version, or Gate version is introduced.
5. Execution preserves structured provenance from Task Material Artifact to Visual Asset: input Artifact id, role, per-role index, and optional pair metadata.
6. Competitive Canonical visual-input presentation is deterministic. The LLM may write interpretation, but may not choose which uploaded images are omitted.
7. Coverage is exact-set based, not count-only:

   ```text
   displayed source Material Artifact IDs
   ==
   verified Plan-bound visual input Artifact IDs
   ```

8. When pair metadata is absent, the report must not infer pairs from names or ordering.

## User flow

The existing Stage 1 Material area offers:

- Grouped comparison: upload any `N + M` images; all are shown in role galleries.
- Paired comparison: choose one uploaded image from each side for every row, give the row a scene label, and explicitly submit the relation.

Paired mode requires every selected image to appear exactly once and each pair to contain exactly one image per side. When the counts differ, the user must use grouped mode or adjust the selected materials.

File-name conventions may be added later as pairing suggestions only. They never create authoritative relations.

## Runtime representation

Clarification stores an optional comparison specification:

```ts
{
  mode: 'grouped' | 'paired';
  primaryRequestId: string;
  comparisonRequestId: string;
  pairs: Array<{
    label: string;
    primaryMaterialId: string;
    comparisonMaterialId: string;
  }>;
}
```

At Plan confirmation the server generates stable `PAIR-001` style identifiers and seals pair metadata into the existing visual gate manifests. Visual Asset manifests preserve the source input identity and pair metadata.

## Canonical and report

Competitive Canonical receives a deterministic visual-input presentation containing all uploaded originals, their exact annotations when available, role grouping, evidence binding, and optional pair relations.

- Grouped mode renders every source image under its role.
- Paired mode renders each confirmed primary/comparison pair, followed by annotation views when available.
- A missing annotation does not hide the original; it is reported as a gap.

Legacy browser-capture `visualEvidence` remains separate.

## Verification

- TypeScript: `pnpm typecheck`
- Registry lint: `pnpm lint:registry`
- Web production build: `pnpm --dir apps/web build`
- Isolated focused contract suite: 464 tests passed, 0 failed
- Full development-checkout suite was exercised separately; only the known parallel Gold CLI timeout and Hub `.DS_Store` snapshot drift remained, and the Gold test passed when rerun alone.
- Covered dynamic grouped counts, explicit pair validation, Requirement persistence, Plan-gate sealing, Visual Asset provenance, Canonical exact-set projection, detail-report rendering, and editorial material handling.
- Real grouped regression:

  ```text
  Task:       6349dc3b-493b-4ce8-aed4-bd893744d419
  Plan:       944ef4c4-572f-4ef1-bd17-e38e5822b882
  Attempt:    d120ba8e-3a71-4e1b-956b-48bc6cbf30ad
  State:      completed
  Groups:     5 + 5
  Image blocks: 10
  ```

## Acceptance

- Dynamic examples `1+1`, `5+5`, and `3+7` render all supplied originals.
- Grouped mode accepts unequal counts and never invents pairings.
- Paired mode rejects missing sides, duplicate use, wrong-request materials, and incomplete coverage.
- Every displayed visual resolves to a SEALED Task Material and exact Visual Asset lineage.
- No model-selected subset can pass when structured user-upload provenance exists.
- A new or revisable task preserves Task-bound uploads across Plan revisions; an already completed report remains immutable and is validated through a fresh task when regeneration is required.
