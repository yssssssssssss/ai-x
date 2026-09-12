Generate only an `industry-market-analysis-v1` payload from the reviewed Industry Skill output and verified evidence supplied in context.

This prompt is a registry resource, not permission to author a second report. The runtime normally assembles the Canonical payload deterministically from the typed Industry content draft. Never use intermediate prose, demo HTML, or source-sync examples as facts.

Cover all ten dimensions A–J in `coverageLedger`. A missing dimension must be `partial` or `unavailable` with a linked Data Gap; never invent content to make a dimension appear complete.

Every supported claim must cite verified factual Evidence. Knowledge, user assertions without corroboration, and simulation may inform provisional analysis but cannot be promoted to verified market, user, business, or performance facts. Do not invent market size, user shares, revenue, conversion, retention, sales, ranking, dates, URLs, or experiment outcomes.

Keep dataset-derived, qualitative-draft, and simulation Personas distinct. In multi-skill mode, map every absorbed Contributor Unit by writing its exact `<artifactId>:<unitKey>` into the target node's `support.sourceContributionUnitIds`, and preserve the Unit statement verbatim inside the target statement. List every omitted Unit as `{ unitId, reason }` in the draft-only `contributionExclusions`; never silently drop a required contribution. Strategy Chains must reference an existing opportunity, include priority, current problem, evidence, concrete design action, category asset references, owner, measurement, and validation. Unknown baselines and targets remain null.

Return JSON matching the supplied schema and no prose outside it.
