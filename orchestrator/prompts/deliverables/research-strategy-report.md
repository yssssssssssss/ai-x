Generate only a `research-strategy-content-draft-v2` payload for the `research-strategy-synthesis` Skill.

The draft is semantic research content, not the final Deliverable envelope. Do not output Task, Plan, Attempt, Artifact, capability provenance, FindingGraph, Coverage, source pointers, risk source identities, or requestedArtifactBindings. The runtime creates those fields deterministically after validation and review.

Answer every required ProblemGraph question directly. Each direct answer must contain the exact questionId, a supported/provisional/unanswered status, verified Evidence IDs when available, confidence, business implication, recommended action, and remaining validation need. A required question cannot remain unanswered and cannot be replaced by “conduct more research.”

Create `evidenceFindings` for the factual roots used by the report. Each finding must bind actual Question IDs and verified factual Evidence IDs. Do not treat Knowledge, simulation, or model output as a public fact source.

Create only useful `contentBlocks`. Choose the number, order, and combination from these typed kinds:

- narrative
- comparison_matrix
- strategy_map
- mind_model
- design_principles
- opportunity_backlog
- prioritized_actions
- channel_strategies
- action_plan

Materialize every value in `input.requirement_context.requested_artifacts` using its matching Block kind. `executive_answers` is satisfied by directAnswers; `research_report` is satisfied by substantive contentBlocks. Do not create empty or placeholder Blocks merely to imitate a fixed report template.

Every factual, strategic, opportunity, channel, principle, matrix, node, and action item must carry a `support` object. Use only Question IDs from the ProblemGraph and Evidence IDs from verifiedEvidence. A supported item requires Evidence. A provisional item requires a concrete validationNeeded statement. Keys are local labels used only inside the draft; the runtime will replace them with canonical IDs.

For `mind_model`, edges may reference only node keys in that same Block. For matrix Blocks, every cell row and column must exist in the Block's declared rows and columns. Prioritized actions must use P0, P1, or P2 and include owner type, rationale, and validation method.

Write limitations and openQuestions honestly. The runtime will append Requirement ambiguity, degraded Skill, Reviewer conditions, answer uncertainty, and envelope risks using their canonical identities.

Use only verified Evidence and sealed prior outputs. Do not invent user findings, causal effects, channel facts, percentages, Evidence IDs, or confidence. Return JSON matching the supplied schema and no prose outside it.
