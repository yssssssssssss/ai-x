import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import {
  loadPlanningPolicy,
  mapCapabilityResolutionToPlanningGuidance,
  resolvePlannerGuidance,
  validatePlanningPolicy,
} from '../apps/orchestrator-runtime/src/planners/planning-guidance-adapter.ts';
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
  capability_crosswalk: { version: string; sha256: string };
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

test('production planning policy enables dynamic candidates under the documented owner waiver', () => {
  const value = policy();
  assert.equal(value.schema_version, 'planning-policy-v1');
  assert.equal(value.status, 'production-owner-waiver-2026-08-21');
  assert.equal(value.candidate_generation_mode, 'dynamic');
  assert.equal(value.activation_gate, 'gate-3-owner-waiver');
  assert.equal(value.capability_crosswalk.version, 'planning-capability-crosswalk-v1');
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

test('validated dynamic policy maps real CapabilityResolution semantics through the reviewed crosswalk', async () => {
  const dynamicPolicy = validatePlanningPolicy({
    ...loadPlanningPolicy(),
    candidate_generation_mode: 'dynamic',
  });
  const capabilityResolution = {
    eligible: [{
      skill: {
        id: 'competitive-web-research',
        name: '竞品分析·Web搜索',
        path: 'skills/competitive-analysis/web-research/SKILL.md',
        when_to_use: '公开资料竞品研究',
        owner: '竞品分析组',
        status: 'active' as const,
        task_types: ['competitive_research'],
        inputs: ['research_goal'],
        outputs: ['competitive_analysis'],
        required_tools: ['tavily-web-search'],
        optional_tools: [],
        risk_level: 'low' as const,
      },
      required_approvals: [],
      reasons: [{ code: 'eligible' as const, message: 'eligible' }],
      pending_inputs: [],
      optional_tool_decisions: [],
    }],
    rejected: [],
  };
  const mapped = mapCapabilityResolutionToPlanningGuidance(capabilityResolution, dynamicPolicy);
  assert.deepEqual(mapped, [{
    id: 'competitive-web-research',
    lifecycle_status: 'active',
    resolution_status: 'eligible',
    profile_support: ['breadth', 'decision'],
    roles: ['scope_expansion', 'decision_support'],
    method_family: 'desk_research',
    evidence_paths: ['public_web'],
  }]);

  let classifierCalls = 0;
  const resolved = await resolvePlannerGuidance({
    rawInput: '开展竞品研究并覆盖多个竞品',
    task: {
      ...task(),
      research_goal: '开展竞品研究并覆盖多个竞品',
      scope: ['多个竞品'],
    },
    problemGraph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'q1',
        statement: '竞品差异是什么？',
        rationale: '支撑研究目标',
        priority: 'required',
        success_criterion_ids: ['criterion-1'],
        evidence_requirements: [{
          id: 'public-source',
          acceptedClasses: ['public_source'],
          minimumCount: 1,
          required: true,
        }],
        acceptance_criteria: ['结论可追溯'],
        depends_on: [],
      }],
    },
    capabilityResolution,
    llm: {
      identity: {
        provider: 'no-call',
        endpointHost: 'fixture.test',
        requestedModel: 'fixture',
        mode: 'mock',
        eligibleAsReal: false,
      },
      async generateStructured() {
        classifierCalls += 1;
        throw new Error('unique rule path must not classify');
      },
      async generateText() {
        throw new Error('not used');
      },
    },
    policy: dynamicPolicy,
  });
  assert.deepEqual(resolved.profiles.map(({ id }) => id), ['speed', 'depth', 'breadth', 'decision']);
  assert.equal(classifierCalls, 0);
  assert.equal(resolved.profiles.find(({ recommended }) => recommended)?.id, 'breadth');
  assert.deepEqual(
    resolved.planning_provenance.selected_profile_ids,
    ['speed', 'depth', 'breadth', 'decision'],
  );
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
      evidence_paths: ['knowledge_method'],
    }],
  });

  assert.deepEqual(result.profiles.map(({ id }) => id), ['speed', 'depth']);
  assert.deepEqual(result.planning_provenance.degradations, [{ code: 'dynamic_generation_disabled' }]);
});
