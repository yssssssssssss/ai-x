import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentPlanStep } from '../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { compileSkillSteps } from '../apps/orchestrator-runtime/src/skills/skill-plan-compiler.ts';

const task: ResearchTaskV2 = {
  version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer', requested_artifacts: ['strategy_map', 'mind_model', 'design_principles', 'opportunity_backlog', 'prioritized_actions'], business_domain: 'pet food', research_goal: 'directly answer pet mind strategy', target_audience: ['pet owners'], scope: ['purchase journey'], constraints: [], success_criteria: [{ id: 'SC1', statement: 'direct answers and actions' }], expected_deliverables: ['research_strategy_report'], assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
};
const tool: CurrentPlanStep = { step_no: 1, step_name: 'search', actor_type: 'tool', actor_id: 'tavily-web-search', question_ids: ['Q1'], depends_on: [], input: { query: 'pet strategy', topic: 'general', max_results: 12, search_depth: 'advanced', include_answer: 'advanced' }, input_bindings: [], expected_outputs: [{ pointer: '/results', description: 'evidence' }], acceptance_criteria: ['traceable evidence'], requires_approval: false, fallback_actor_ids: [] };
const skill: CurrentPlanStep = { step_no: 2, step_name: 'answer', actor_type: 'skill', actor_id: 'research-strategy-synthesis', question_ids: ['Q1'], depends_on: [1], input: {}, input_bindings: [], expected_outputs: [{ pointer: '/payload', description: 'answers' }], acceptance_criteria: ['direct answer'], requires_approval: false, fallback_actor_ids: [] };
const reviewer: CurrentPlanStep = { step_no: 3, step_name: 'review', actor_type: 'reviewer', actor_id: 'reviewer.research-lead', question_ids: ['Q1'], depends_on: [2], input: { report: null }, input_bindings: [{ target_pointer: '/report', source_step_no: 2, source_pointer: '/payload' }], expected_outputs: [{ pointer: '/review', description: 'review' }], acceptance_criteria: ['review answer'], requires_approval: false, fallback_actor_ids: [] };

test('research strategy Skill compiles into one frozen answer-oriented DAG without reusing one reviewer for two stages', () => {
  const compiled = compileSkillSteps([tool, skill, reviewer], task);
  assert.equal(compiled.invocations.length, 1);
  assert.equal(compiled.invocations[0]?.skill_id, 'research-strategy-synthesis');
  assert.deepEqual(compiled.steps.map(({ actor_type }) => actor_type), ['tool', 'knowledge', 'llm', 'llm', 'reviewer', 'llm', 'llm', 'skill', 'reviewer']);
  assert.deepEqual(compiled.steps.map(({ skill_stage_id }) => skill_stage_id), [
    'collect-public-evidence',
    'load-evidence-standards',
    'inventory-evidence',
    'synthesize-direct-answers',
    'challenge-answer-claims',
    'materialize-strategy',
    'prioritize-actions',
    'compose-strategy-report',
    'self-review',
  ]);
});
