import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { ProblemGraph } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import { getConfigRoot, loadYaml } from '../runtime/config-loader.ts';
import { hashPrompt, type LLMClient } from '../runtime/llm-client.ts';
import { loadSchemaText, resolveSchema } from '../runtime/schema-registry.ts';
import type { CapabilityResolution } from './capability-resolver.ts';
import {
  resolvePlanningGuidance,
  type CandidateGenerationMode,
  type CandidateProfileId,
  type PlanningGuidanceCapability,
  type PlanningGuidanceResult,
  type ScenarioClassifierRequest,
  type ScenarioId,
} from './planning-guidance.ts';
export type { ResolvedProfileSpec } from './planning-guidance.ts';

const POLICY_PATH = 'orchestrator/planning-policy.yaml';
const CROSSWALK_PATH = 'orchestrator/planning-capability-crosswalk.yaml';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TASK_TYPES = new Set([
  'competitive_research',
  'user_research_planning',
  'research_synthesis',
  'voc_diagnosis',
  'design_audit',
  'a11y_audit',
  'industry_market_analysis',
  // Present only on the reviewed draft Skill; it never becomes eligible for ResearchTaskV2.
  'solution-generation',
]);
const PROFILES = new Set<CandidateProfileId>([
  'speed',
  'depth',
  'breadth',
  'focused',
  'mixed_method',
  'decision',
  'remediation',
]);
const SPECIALTY_PROFILES = new Set<Exclude<CandidateProfileId, 'speed' | 'depth'>>([
  'breadth',
  'focused',
  'mixed_method',
  'decision',
  'remediation',
]);
const CAPABILITY_ROLES = new Set<PlanningGuidanceCapability['roles'][number]>([
  'scope_expansion',
  'focused_analysis',
  'independent_method',
  'decision_support',
  'issue_identification',
  'retest',
]);
const EVIDENCE_PATHS = new Set([
  'public_web',
  'screenshot_analysis',
  'simulated_user',
  'expert_review',
  'survey_dataset',
  'knowledge_method',
  'behavioral_dataset',
  'user_material',
  'user_interview',
  'user_observation',
  'derived_decision',
]);

export interface PlanningPolicy {
  schema_version: 'planning-policy-v1';
  status: string;
  candidate_generation_mode: CandidateGenerationMode;
  activation_gate: 'gate-3' | 'gate-3-owner-waiver';
  profile_spec: { version: 'profile-spec-gate-2-candidate-v1'; sha256: string };
  scenario_catalog: { version: 'scenario-profile-mapping-gate-2-candidate-v1'; sha256: string };
  scenario_mapping: { version: 'scenario-profile-mapping-gate-2-candidate-v1'; sha256: string };
  signal_catalog: { version: 'planning-signal-gate-2-candidate-v1'; sha256: string };
  capability_crosswalk: { version: 'planning-capability-crosswalk-v1'; sha256: string };
  candidate_contract: {
    min_items: 2;
    max_items: 4;
    baseline_profile_ids: ['speed', 'depth'];
    classifier_max_calls: 1;
    high_confidence_rule_classifier_calls: 0;
  };
}

interface CapabilityCrosswalkEntry {
  id: string;
  task_types: string[];
  profile_support: Array<Exclude<CandidateProfileId, 'speed' | 'depth'>>;
  roles: PlanningGuidanceCapability['roles'];
  method_family: string;
  evidence_paths: string[];
}

interface CapabilityCrosswalk {
  schema_version: 'planning-capability-crosswalk-v1';
  status: 'gate-2-reviewed';
  capabilities: CapabilityCrosswalkEntry[];
}

export interface PlannerGuidanceAdapterInput {
  rawInput: string;
  task: ResearchTaskV2;
  selectedScenarioId?: ScenarioId;
  requireExplicitScenarioSelection?: boolean;
  requiredProfileId?: CandidateProfileId;
  problemGraph: ProblemGraph;
  capabilityResolution: CapabilityResolution;
  directSkillId?: string;
  llm: LLMClient;
  expectedActualModel?: string;
  policy?: unknown;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Planning Policy ${field}: must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`Planning Policy ${field}: fields must equal ${sortedExpected.join(', ')}`);
  }
}

function versionedHash<T extends string>(value: unknown, field: string, version: T): { version: T; sha256: string } {
  const item = record(value, field);
  exactKeys(item, ['version', 'sha256'], field);
  if (item.version !== version) throw new Error(`Planning Policy ${field}.version: must equal ${version}`);
  if (typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)) {
    throw new Error(`Planning Policy ${field}.sha256: must be a canonical sha256`);
  }
  return { version, sha256: item.sha256 };
}

export function validatePlanningPolicy(value: unknown): PlanningPolicy {
  const root = record(value, 'root');
  exactKeys(root, [
    'schema_version',
    'status',
    'candidate_generation_mode',
    'activation_gate',
    'profile_spec',
    'scenario_catalog',
    'scenario_mapping',
    'signal_catalog',
    'capability_crosswalk',
    'candidate_contract',
  ], 'root');
  if (root.schema_version !== 'planning-policy-v1') {
    throw new Error('Planning Policy schema_version: must equal planning-policy-v1');
  }
  if (typeof root.status !== 'string' || !root.status.trim()) {
    throw new Error('Planning Policy status: must be a non-empty string');
  }
  if (root.candidate_generation_mode !== 'fixed' && root.candidate_generation_mode !== 'dynamic') {
    throw new Error('Planning Policy candidate_generation_mode: must be fixed or dynamic');
  }
  if (root.activation_gate !== 'gate-3' && root.activation_gate !== 'gate-3-owner-waiver') {
    throw new Error('Planning Policy activation_gate: must equal gate-3 or gate-3-owner-waiver');
  }
  if (root.activation_gate === 'gate-3-owner-waiver' && root.status !== 'production-owner-waiver-2026-08-21') {
    throw new Error('Planning Policy owner waiver: status must record the production owner waiver');
  }
  const candidateContract = record(root.candidate_contract, 'candidate_contract');
  exactKeys(candidateContract, [
    'min_items',
    'max_items',
    'baseline_profile_ids',
    'classifier_max_calls',
    'high_confidence_rule_classifier_calls',
  ], 'candidate_contract');
  if (
    candidateContract.min_items !== 2
    || candidateContract.max_items !== 4
    || !Array.isArray(candidateContract.baseline_profile_ids)
    || candidateContract.baseline_profile_ids.length !== 2
    || candidateContract.baseline_profile_ids[0] !== 'speed'
    || candidateContract.baseline_profile_ids[1] !== 'depth'
    || candidateContract.classifier_max_calls !== 1
    || candidateContract.high_confidence_rule_classifier_calls !== 0
  ) {
    throw new Error('Planning Policy candidate_contract: frozen candidate boundary mismatch');
  }
  return {
    schema_version: 'planning-policy-v1',
    status: root.status,
    candidate_generation_mode: root.candidate_generation_mode,
    activation_gate: root.activation_gate,
    profile_spec: versionedHash(root.profile_spec, 'profile_spec', 'profile-spec-gate-2-candidate-v1'),
    scenario_catalog: versionedHash(root.scenario_catalog, 'scenario_catalog', 'scenario-profile-mapping-gate-2-candidate-v1'),
    scenario_mapping: versionedHash(root.scenario_mapping, 'scenario_mapping', 'scenario-profile-mapping-gate-2-candidate-v1'),
    signal_catalog: versionedHash(root.signal_catalog, 'signal_catalog', 'planning-signal-gate-2-candidate-v1'),
    capability_crosswalk: versionedHash(root.capability_crosswalk, 'capability_crosswalk', 'planning-capability-crosswalk-v1'),
    candidate_contract: {
      min_items: 2,
      max_items: 4,
      baseline_profile_ids: ['speed', 'depth'],
      classifier_max_calls: 1,
      high_confidence_rule_classifier_calls: 0,
    },
  };
}

export function loadPlanningPolicy(): PlanningPolicy {
  return validatePlanningPolicy(loadYaml<unknown>(join(getConfigRoot(), POLICY_PATH)));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonicalValue(child)]));
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')}`;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim() !== item)
    || new Set(value).size !== value.length
  ) throw new Error(`Planning capability crosswalk ${field}: must be unique non-empty strings`);
  return [...value] as string[];
}

function parseCrosswalk(value: unknown, expectedHash: string): CapabilityCrosswalk {
  if (canonicalHash(value) !== expectedHash) {
    throw new Error('Planning capability crosswalk hash does not match Planning Policy');
  }
  const root = record(value, 'capability_crosswalk');
  exactKeys(root, ['schema_version', 'status', 'capabilities'], 'capability_crosswalk');
  if (root.schema_version !== 'planning-capability-crosswalk-v1' || root.status !== 'gate-2-reviewed') {
    throw new Error('Planning capability crosswalk version/status is not reviewed');
  }
  if (!Array.isArray(root.capabilities) || root.capabilities.length === 0) {
    throw new Error('Planning capability crosswalk capabilities must be non-empty');
  }
  const ids = new Set<string>();
  const capabilities = root.capabilities.map((value, index): CapabilityCrosswalkEntry => {
    const item = record(value, `capability_crosswalk.capabilities[${index}]`);
    exactKeys(item, [
      'id',
      'task_types',
      'profile_support',
      'roles',
      'method_family',
      'evidence_paths',
    ], `capability_crosswalk.capabilities[${index}]`);
    if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) {
      throw new Error(`Planning capability crosswalk capabilities[${index}].id is invalid or duplicate`);
    }
    ids.add(item.id);
    const taskTypes = uniqueStrings(item.task_types, `${item.id}.task_types`);
    if (taskTypes.some((taskType) => !TASK_TYPES.has(taskType))) {
      throw new Error(`Planning capability crosswalk ${item.id}.task_types contains an unknown task type`);
    }
    const profileSupport = uniqueStrings(item.profile_support, `${item.id}.profile_support`);
    const roles = uniqueStrings(item.roles, `${item.id}.roles`);
    const evidencePaths = uniqueStrings(item.evidence_paths, `${item.id}.evidence_paths`);
    if (profileSupport.some((profile) => !PROFILES.has(profile as CandidateProfileId) || !SPECIALTY_PROFILES.has(profile as never))) {
      throw new Error(`Planning capability crosswalk ${item.id}.profile_support contains a non-specialty profile`);
    }
    if (roles.some((role) => !CAPABILITY_ROLES.has(role as PlanningGuidanceCapability['roles'][number]))) {
      throw new Error(`Planning capability crosswalk ${item.id}.roles contains an unknown role`);
    }
    if (evidencePaths.some((path) => !EVIDENCE_PATHS.has(path))) {
      throw new Error(`Planning capability crosswalk ${item.id}.evidence_paths contains an unknown path`);
    }
    if (typeof item.method_family !== 'string' || !item.method_family.trim()) {
      throw new Error(`Planning capability crosswalk ${item.id}.method_family is invalid`);
    }
    return {
      id: item.id,
      task_types: taskTypes,
      profile_support: profileSupport as CapabilityCrosswalkEntry['profile_support'],
      roles: roles as PlanningGuidanceCapability['roles'],
      method_family: item.method_family,
      evidence_paths: evidencePaths,
    };
  });
  return {
    schema_version: 'planning-capability-crosswalk-v1',
    status: 'gate-2-reviewed',
    capabilities,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function mapCapabilityResolutionToPlanningGuidance(
  resolution: CapabilityResolution,
  policy: PlanningPolicy,
): PlanningGuidanceCapability[] {
  const crosswalk = parseCrosswalk(
    loadYaml<unknown>(join(getConfigRoot(), CROSSWALK_PATH)),
    policy.capability_crosswalk.sha256,
  );
  const byId = new Map(crosswalk.capabilities.map((entry) => [entry.id, entry]));
  const decisions = [
    ...resolution.eligible.map((decision) => ({ decision, resolution_status: 'eligible' as const })),
    ...resolution.rejected.map((decision) => ({ decision, resolution_status: 'rejected' as const })),
  ];
  const seen = new Set<string>();
  return decisions.map(({ decision, resolution_status }) => {
    const id = decision.skill.id;
    if (!id || seen.has(id)) throw new Error(`CapabilityResolution contains missing or duplicate skill id ${id ?? '(missing)'}`);
    seen.add(id);
    const mapping = byId.get(id);
    if (!mapping) throw new Error(`CapabilityResolution skill ${id} has no reviewed planning crosswalk`);
    const declaredTaskTypes = decision.skill.task_types ?? [];
    if (!sameStringSet(mapping.task_types, declaredTaskTypes)) {
      throw new Error(`Planning capability crosswalk task_types drifted for ${id}`);
    }
    return {
      id,
      lifecycle_status: decision.skill.status,
      resolution_status,
      profile_support: [...mapping.profile_support],
      roles: [...mapping.roles],
      method_family: mapping.method_family,
      evidence_paths: [...mapping.evidence_paths],
    };
  });
}

function availableMaterialRoles(task: ResearchTaskV2): string[] {
  const roles = ['research_goal', 'business_domain'];
  if (task.target_audience.length > 0) roles.push('target_audience');
  if (task.scope.length > 0) roles.push('scope');
  if (task.constraints.length > 0) roles.push('constraints');
  if (task.success_criteria.length > 0) roles.push('success_criteria');
  if (task.expected_deliverables.length > 0) roles.push('expected_deliverables');
  roles.push(...(task.available_material_roles ?? []));
  return [...new Set(roles)];
}

function problemGraphSignals(graph: ProblemGraph): Array<'independent_evidence_paths_required'> {
  const requiredRequirements = new Map<string, string>();
  for (const question of graph.questions) {
    if (question.priority !== 'required') continue;
    for (const requirement of question.evidence_requirements) {
      if (!requirement.required) continue;
      requiredRequirements.set(
        requirement.id,
        [...requirement.acceptedClasses].sort().join('|'),
      );
    }
  }
  return new Set(requiredRequirements.values()).size >= 2
    ? ['independent_evidence_paths_required']
    : [];
}

function classifier(llm: LLMClient, expectedActualModel?: string) {
  return async (request: ScenarioClassifierRequest): Promise<unknown> => {
    const schemaText = loadSchemaText(resolveSchema('scenario-guidance'));
    if (!schemaText) throw new Error('scenario-guidance schema is not registered');
    const schema = JSON.parse(schemaText) as object;
    const generated = await llm.generateStructured<unknown>({
      prompt: 'Select only from the supplied Scenario whitelist. Cite only observed controlled signals. Do not infer intent from available capabilities.',
      schema,
      schemaName: 'scenario-guidance',
      context: request,
      receipt: {
        stage: 'planning_guidance',
        contextManifestHash: hashPrompt('', request, 'scenario-guidance'),
        expectedModel: expectedActualModel ?? llm.identity.requestedModel,
      },
    });
    return generated.data;
  };
}

function assertPolicyContract(policy: PlanningPolicy, result: PlanningGuidanceResult): void {
  const provenance = result.planning_provenance;
  for (const [field, expected, actual] of [
    ['profile_spec', policy.profile_spec.sha256, provenance.profile_spec_hash],
    ['scenario_catalog', policy.scenario_catalog.sha256, provenance.scenario_catalog_hash],
    ['scenario_mapping', policy.scenario_mapping.sha256, provenance.scenario_mapping_hash],
    ['signal_catalog', policy.signal_catalog.sha256, provenance.signal_catalog_hash],
  ] as const) {
    if (actual !== expected) throw new Error(`Planning Policy ${field} hash does not match Planning Guidance`);
  }
  if (
    (result.status === 'resolved' || result.status === 'bypassed')
    && (
      result.profiles.length < policy.candidate_contract.min_items
      || result.profiles.length > policy.candidate_contract.max_items
      || new Set(result.profiles.map(({ id }) => id)).size !== result.profiles.length
      || result.profiles.filter(({ recommended }) => recommended).length !== 1
    )
  ) {
    throw new Error('Planning Guidance result violates the validated Planning Policy candidate contract');
  }
}

export async function resolvePlannerDirectionGate(
  input: Pick<PlannerGuidanceAdapterInput, 'rawInput' | 'task' | 'policy'>,
): Promise<PlanningGuidanceResult> {
  const policy = input.policy === undefined ? loadPlanningPolicy() : validatePlanningPolicy(input.policy);
  const result = await resolvePlanningGuidance({
    raw_input: input.rawInput,
    task: input.task,
    available_material_roles: availableMaterialRoles(input.task),
    baseline_readiness: { speed: true, depth: true },
    capabilities: [],
  }, {
    policy: {
      candidate_generation_mode: policy.candidate_generation_mode,
      gate_3_activation_required: true,
    },
    requireExplicitScenarioSelection: true,
    preserve_legacy_fixed_mode: true,
  });
  assertPolicyContract(policy, result);
  return result;
}

export async function resolvePlannerGuidance(
  input: PlannerGuidanceAdapterInput,
): Promise<PlanningGuidanceResult> {
  const policy = input.policy === undefined ? loadPlanningPolicy() : validatePlanningPolicy(input.policy);
  const capabilities = mapCapabilityResolutionToPlanningGuidance(input.capabilityResolution, policy);
  const result = await resolvePlanningGuidance({
    raw_input: input.rawInput,
    task: input.task,
    ...(input.selectedScenarioId ? { selected_scenario_id: input.selectedScenarioId } : {}),
    available_material_roles: availableMaterialRoles(input.task),
    problem_graph_signal_ids: problemGraphSignals(input.problemGraph),
    ...(input.directSkillId ? { direct_skill_id: input.directSkillId } : {}),
    ...(input.requiredProfileId ? { required_profile_id: input.requiredProfileId } : {}),
    baseline_readiness: { speed: true, depth: true },
    capabilities,
  }, {
    policy: {
      candidate_generation_mode: policy.candidate_generation_mode,
      gate_3_activation_required: true,
    },
    classifier: classifier(input.llm, input.expectedActualModel),
    requireExplicitScenarioSelection: input.requireExplicitScenarioSelection,
    preserve_legacy_fixed_mode: true,
  });
  assertPolicyContract(policy, result);
  return result;
}
