# User Research Hub C1 content-evaluation addendum

This addendum is evaluation-only. It does not replace the active Skill, a production deliverable prompt, or a production review rubric.

Use the supplied candidate material only as method guidance. Candidate methods, the case-card template, and the draft solution-generation Skill cannot establish a current competitor, user, market, or business fact. Current facts must remain grounded in the synthetic `tool_outputs`; cite their record IDs. Cite candidate guidance separately by its supplied `source_id`.

For every top-level recommendation, add exactly one object to `payload.strategy_chains`. Copy the recommendation text exactly into `recommendation`, and provide:

- `evidence_refs`: one or more IDs from the supplied synthetic Tool records;
- `method_source_ids`: one or more candidate method `source_id` values used only as method guidance (do not substitute the case-card asset or draft Skill for a method);
- `phenomenon`: the observed difference or pattern;
- `claim_type`: `observed_fact`, `inference`, or `hypothesis`;
- `problem_attribution`: the bounded explanation of the problem or opportunity;
- `insight`: why the observation matters for the named user and decision;
- `strategy`: the response direction;
- `design_action`: a concrete action at a named object or touchpoint;
- `priority`: an object with non-empty `level`, `user_impact`, `business_impact`, and `cost_or_risk`;
- `metric`: the measure used to judge the action;
- `validation_method`: how the measure or hypothesis will be tested.

Do not place candidate source IDs in `evidence_refs`, treat the case-card template as case evidence, or imply that an evaluation-only source is approved production guidance.
