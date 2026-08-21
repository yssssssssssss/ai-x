# User Research Hub C1 evaluation overlay

`user-research-hub-c1.json` freezes the Gate-2-approved C1 set: 15 design-strategy method candidates, one case-card asset, the `solution-generation` draft Skill, and two narrow Skill deltas. The loader verifies each source/content/artifact hash and the unchanged production planning policy, report prompt, report rubric, and target Skill hashes before a run.

The overlay is available only through the existing Skill KB evaluator. It requires deterministic `gold` retrieval; `live` mode is rejected so candidate content is never requested through production `searchKnowledge()`.

## Dry run

```sh
pnpm eval:skills:kb --content-overlay user-research-hub-c1 --content-variant enhanced --kb-mode gold --skill competitive-analysis --dry-run
```

The dry run prints the current KB snapshot ID, the frozen source/content hashes, the fixed-policy boundary, and the exact content injected for the selected Skill. It does not require or call an LLM.

## Baseline and content-enhanced runs

Use the snapshot ID printed by the dry run for both runs. Keep the model, case, and all other flags identical.

```sh
pnpm eval:skills:kb --run-id <baseline-id> --skill competitive-analysis --kb-mode gold --kb-snapshot <snapshot-id> --content-overlay user-research-hub-c1 --content-variant baseline
pnpm eval:skills:kb --run-id <enhanced-id> --skill competitive-analysis --kb-mode gold --kb-snapshot <snapshot-id> --content-overlay user-research-hub-c1 --content-variant enhanced
pnpm eval:skills:kb:compare --baseline skill-evaluations/<baseline-id> --content-enhanced skill-evaluations/<enhanced-id> --output skill-evaluations/<comparison-id>
```

The two-run comparison checks model, case, KB snapshot, overlay, prompt, rubric, and content hashes before writing JSON, CSV, and Markdown. It reports the unchanged base score, KB grounding verdicts, deterministic C1 grounding criteria, and the complete evidence → phenomenon → problem attribution → insight → strategy → design action → priority → metric → validation chain.

`competitive-web-research` and `run-heuristic-evaluation` may also be selected to exercise their respective narrow deltas. No candidate is promoted, no draft Skill becomes active, and this overlay does not alter production report prompts or rubrics.
