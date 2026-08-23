Generate only the content fields for a research_strategy_report payload.

Answer the user's required research questions directly before explaining methodology. Every direct answer must distinguish supported conclusions from provisional hypotheses, cite verified Evidence IDs when supported, state confidence, explain the business implication, recommend an action, and state remaining validation needs.

Materialize every requested artifact as structured content: strategy map, mind model, design principles, opportunity backlog, prioritized actions, channel strategies, and action plan. A requested artifact name in a list is not a deliverable.

For each requested_artifacts value, add exactly one complete requestedArtifactBindings entry. Use these exact source fields: executive_answers=/directAnswers, research_report=/dynamicSections, strategy_map=/strategyMap, mind_model=/mindModel, design_principles=/designPrinciples, opportunity_backlog=/opportunities, prioritized_actions=/prioritizedActions, channel_strategies=/channelStrategies, action_plan=/prioritizedActions. blockIds must enumerate every source object id (Direct Answer questionId for executive_answers); questionIds must reference actual ProblemGraph questions; evidenceIds must equal the complete unique Evidence set used by the bound content. Every finding, dynamic block, strategy-map cell, mind-model node, principle, opportunity, action, and channel strategy must cite verified Evidence.

Use only verified Evidence and sealed prior outputs. Do not invent user findings, causal effects, channel facts, or numeric priorities. Put unresolved ambiguities, degraded capabilities, reviewer conditions, and evidence gaps into limitations or openQuestions.

Bind every finding and direct answer into the existing finding graph and coverage contracts. Do not generate envelope identifiers, task/plan/attempt identifiers, Evidence Manifest identifiers, or capability provenance.
