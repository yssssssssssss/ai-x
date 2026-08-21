import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { resolvePlanningGuidance } from '../apps/orchestrator-runtime/src/planners/planning-guidance.ts';

interface PlanningPolicy {
  schema_version: string;
  status: string;
  candidate_generation_mode: 'fixed' | 'dynamic';
  activation_gate: string;
  profile_spec: { version: string; sha256: string };
  scenario_catalog: { version: string; sha256: string };
  scenario_mapping: { version: string; sha256: string };
  signal_catalog: { version: string; sha256: string };
  candidate_contract: {
    min_items: number;
    max_items: number;
    baseline_profile_ids: string[];
    classifier_max_calls: number;
    high_confidence_rule_classifier_calls: number;
  };
}

const POLICY_PATH = join(process.cwd(), 'orchestrator/planning-policy.yaml');

function policy(): PlanningPolicy {
  return YAML.parse(readFileSync(POLICY_PATH, 'utf8')) as PlanningPolicy;
}

function task(): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'policy-test',
    research_goal: '开展竞品研究',
    target_audience: ['消费者'],
    scope: ['购物助手'],
    constraints: [],
    success_criteria: [{ id: 'criterion-1', statement: '完成竞品结论' }],
    expected_deliverables: ['竞品分析'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
}

test('Phase-B planning policy is fixed, Gate-3 guarded, and preserves the frozen candidate boundary', () => {
  const value = policy();
  assert.equal(value.schema_version, 'planning-policy-v1');
  assert.equal(value.status, 'gate-2-candidate');
  assert.equal(value.candidate_generation_mode, 'fixed');
  assert.equal(value.activation_gate, 'gate-3');
  assert.deepEqual(value.candidate_contract, {
    min_items: 2,
    max_items: 4,
    baseline_profile_ids: ['speed', 'depth'],
    classifier_max_calls: 1,
    high_confidence_rule_classifier_calls: 0,
  });
});

test('policy catalog hashes match the normalized deep-module contract without importing hidden source metadata', async () => {
  const value = policy();
  const result = await resolvePlanningGuidance({
    raw_input: 'direct policy hash inspection',
    task: task(),
    available_material_roles: [],
    direct_skill_id: 'policy-test-skill',
    baseline_readiness: { speed: true, depth: true },
    capabilities: [],
  });

  assert.equal(value.profile_spec.sha256, result.planning_provenance.profile_spec_hash);
  assert.equal(value.scenario_catalog.sha256, result.planning_provenance.scenario_catalog_hash);
  assert.equal(value.scenario_mapping.sha256, result.planning_provenance.scenario_mapping_hash);
  assert.equal(value.signal_catalog.sha256, result.planning_provenance.signal_catalog_hash);
  assert.equal(value.profile_spec.version, 'profile-spec-gate-2-candidate-v1');
  assert.equal(value.scenario_mapping.version, 'scenario-profile-mapping-gate-2-candidate-v1');
  assert.equal(value.signal_catalog.version, 'planning-signal-gate-2-candidate-v1');

  const moduleSource = readFileSync(
    join(process.cwd(), 'apps/orchestrator-runtime/src/planners/planning-guidance.ts'),
    'utf8',
  );
  assert.equal(moduleSource.includes('knowledge-base/.sources/'), false);
  assert.equal(moduleSource.includes('user-research-hub-profile-draft'), false);
});

test('omitting a mode remains fixed even if specialty signals and active capabilities are present', async () => {
  const result = await resolvePlanningGuidance({
    raw_input: '竞品研究，要求广度优先并覆盖多个竞品',
    task: {
      ...task(),
      research_goal: '竞品研究，要求广度优先并覆盖多个竞品',
      scope: ['多个竞品'],
      expected_deliverables: ['覆盖矩阵'],
    },
    available_material_roles: [],
    baseline_readiness: { speed: true, depth: true },
    capabilities: [{
      id: 'coverage-scan',
      lifecycle_status: 'active',
      resolution_status: 'eligible',
      profile_support: ['breadth'],
      roles: ['scope_expansion'],
    }],
  });

  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth']);
  assert.deepEqual(result.planning_provenance.degradations, [{ code: 'dynamic_generation_disabled' }]);
});
