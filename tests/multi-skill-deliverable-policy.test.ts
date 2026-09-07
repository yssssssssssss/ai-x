import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillCompositionIssues } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import {
  inspectDeliverableRegistry,
  resolveDeliverableCompositionPolicy,
  validateDeliverableCompositionPolicy,
} from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';

const contributionSchema = 'schemas/research-contribution-v1.schema.json';

test('every production active Skill has an explicit valid composition classification', () => {
  const active = new SkillLoader().listActiveSkills();
  assert.ok(active.length > 0);
  for (const skill of active) {
    assert.ok(skill.composition, `${skill.id} must be composition-classified`);
    assert.deepEqual(skillCompositionIssues(skill), [], skill.id);
  }
});

test('legacy Skills without composition remain standalone-compatible', () => {
  assert.deepEqual(skillCompositionIssues({
    id: 'legacy-skill',
    name: 'Legacy',
    path: 'skills/legacy/SKILL.md',
    when_to_use: 'Legacy only',
    owner: 'owner',
    status: 'active',
    task_types: ['competitive_research'],
    inputs: [],
    outputs: [],
    required_tools: [],
    risk_level: 'low',
  }), []);
});

test('Contributor and Synthesizer composition contracts fail closed when incomplete', () => {
  const base = {
    id: 'skill-1',
    name: 'Skill',
    path: 'skills/x/SKILL.md',
    when_to_use: 'test',
    owner: 'owner',
    status: 'active' as const,
    task_types: ['research_synthesis'],
    inputs: [],
    outputs: [],
    required_tools: [],
    risk_level: 'low' as const,
  };
  const contributor = {
    ...base,
    composition: {
      modes: ['standalone', 'contributor'] as const,
      supported_outcomes: ['answer'] as const,
      compatible_deliverables: ['research_strategy_report'],
      required_input_roles: ['research_goal'],
      optional_input_roles: [],
    },
  };
  assert.ok(skillCompositionIssues(contributor).some((issue) => /contribution_schema/u.test(issue)));
  assert.ok(skillCompositionIssues(contributor).some((issue) => /contribution_types/u.test(issue)));

  const synthesizer = {
    ...base,
    composition: {
      modes: ['synthesizer'] as const,
      supported_outcomes: ['answer'] as const,
      compatible_deliverables: [],
      contribution_schema: contributionSchema,
      required_input_roles: ['research_goal'],
      optional_input_roles: [],
    },
  };
  assert.ok(skillCompositionIssues(synthesizer).some((issue) => /compatible_deliverables/u.test(issue)));
});

test('every production active Deliverable has one explicit valid composition policy', () => {
  const inspection = inspectDeliverableRegistry();
  assert.deepEqual(inspection.diagnostics, []);
  const active = inspection.entries.filter(({ status }) => status === 'active');
  assert.ok(active.length > 0);
  for (const deliverable of active) {
    assert.ok(deliverable.composition, `${deliverable.id} must declare composition`);
    assert.deepEqual(validateDeliverableCompositionPolicy(deliverable), [], deliverable.id);
  }
});

test('portfolio policy freezes the only Synthesizer and accepted Contribution contract', () => {
  const strategy = resolveDeliverableCompositionPolicy('research_strategy_report');
  assert.deepEqual(strategy, {
    mode: 'portfolio',
    synthesizer_skill_id: 'research-strategy-synthesis',
    accepted_contribution_types: [
      'market_landscape',
      'competitive_analysis',
      'persona',
      'jobs_to_be_done',
      'journey',
      'qualitative_insight',
      'voc',
      'satisfaction',
      'metrics',
      'funnel',
      'feature_adoption',
      'design_audit',
      'accessibility',
      'research_method',
      'prioritization',
      'strategy',
      'action_plan',
      'virtual_user_hypothesis',
    ],
    contribution_schema: contributionSchema,
  });
});

test('invalid portfolio policy cannot omit or duplicate accepted contribution types', () => {
  assert.ok(validateDeliverableCompositionPolicy({
    id: 'invalid',
    status: 'active',
    task_types: ['research_synthesis'],
    envelope_version: 'research-deliverable-v1',
    payload_schema: 'schema.json',
    synthesis_prompt: 'prompt.md',
    review_rubric: 'rubric.yaml',
    evidence_policy: 'policy',
    report_template: 'template',
    composition: {
      mode: 'portfolio',
      synthesizer_skill_id: '',
      accepted_contribution_types: ['metrics', 'metrics'],
      contribution_schema: '',
    },
  }).length >= 3);
});
