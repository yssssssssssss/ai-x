import type {
  CurrentExecutionPlan,
  CurrentExecutionPlanV3,
  CurrentPlanStep,
} from './research-deliverable.ts';

export const LIGHTWEIGHT_EXECUTION_PLAN_VERSION = 'lightweight-execution-plan-v1' as const;
export const SKILL_REPORT_VERSION = 'skill-report-v1' as const;
export const FINAL_REPORT_VERSION = 'final-report-v1' as const;

export const SKILL_INPUT_SOURCES = [
  'conversation',
  'upload',
  'database',
  'knowledge',
  'tool',
] as const;

export type SkillInputSource = typeof SKILL_INPUT_SOURCES[number];
export type MaterialInputSource = Exclude<SkillInputSource, 'knowledge' | 'tool'>;
export type SkillInputKind = 'value' | 'visual' | 'dataset';

export interface SkillInputRequirement {
  key: string;
  kind: SkillInputKind;
  label: string;
  description: string;
  required: boolean;
  multiple: boolean;
  acceptedSources: SkillInputSource[];
  question: string;
}

export interface ResolvedPlanInput {
  key: string;
  valueRef: string;
  source: MaterialInputSource;
  targetInvocationIds: string[];
}

export interface PendingPlanInput {
  requirement: SkillInputRequirement;
  targetInvocationIds: string[];
}

export interface WaivedPlanInput {
  key: string;
  targetInvocationIds: string[];
  reason: string;
}

export interface ResolvedPlanInputs {
  resolved: ResolvedPlanInput[];
  pending: PendingPlanInput[];
  waived: WaivedPlanInput[];
}

export interface SourceReference {
  id: string;
  title: string;
  type: 'user_input' | 'knowledge' | 'tool_result';
  url?: string;
}

export type SkillReportStatus = 'completed' | 'completed_with_gaps' | 'needs_input';
export type CompletedSkillReportStatus = Exclude<SkillReportStatus, 'needs_input'>;

export interface SkillReport {
  version: typeof SKILL_REPORT_VERSION;
  skillId: string;
  invocationId: string;
  title: string;
  status: SkillReportStatus;
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
  missingInputKeys?: string[];
}

export interface FinalReportSkillReference {
  skillId: string;
  invocationId: string;
  status: CompletedSkillReportStatus;
  path: string;
}

export interface FinalReport {
  version: typeof FINAL_REPORT_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  mode: 'single_skill' | 'multi_skill';
  title: string;
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
  skillReports: FinalReportSkillReference[];
}

export interface LightweightSkillSnapshot {
  skill_id: string;
  body: string;
  body_hash: string;
  input_requirements: SkillInputRequirement[];
  input_requirements_hash: string;
  output_schema_hash: string;
  report_template: string;
  report_template_hash: string;
  execution_contract_hash?: string;
}

export interface LightweightSkillInvocation {
  invocation_id: string;
  skill_id: string;
  depends_on_invocation_ids: string[];
  step_nos: number[];
  required: boolean;
  failure_policy: 'block' | 'gap';
  snapshot: LightweightSkillSnapshot;
}

export interface LightweightExecutionPlanV1 extends Omit<
  CurrentExecutionPlan,
  'execution_contract_version' | 'skill_invocations'
> {
  execution_contract_version: typeof LIGHTWEIGHT_EXECUTION_PLAN_VERSION;
  mode: 'single_skill' | 'multi_skill';
  skill_invocations: LightweightSkillInvocation[];
  resolved_inputs: ResolvedPlanInputs;
}

export type ReadableExecutionPlan =
  | CurrentExecutionPlan
  | CurrentExecutionPlanV3
  | LightweightExecutionPlanV1;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const INPUT_SOURCES = new Set<string>(SKILL_INPUT_SOURCES);
const INPUT_KINDS = new Set<string>(['value', 'visual', 'dataset']);
const REPORT_SOURCE_TYPES = new Set<string>(['user_input', 'knowledge', 'tool_result']);
const SKILL_REPORT_STATUSES = new Set<string>(['completed', 'completed_with_gaps', 'needs_input']);
const COMPLETED_SKILL_REPORT_STATUSES = new Set<string>(['completed', 'completed_with_gaps']);
const MODES = new Set<string>(['single_skill', 'multi_skill']);
const SAFE_REPORT_PATH = /^skill-results\/[A-Za-z0-9][A-Za-z0-9._%+-]*\.json$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function fail(contract: string, field: string): never {
  throw new Error(`${contract} ${field} is invalid`);
}

function record(value: unknown, contract: string, field = 'value'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(contract, field);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  contract: string,
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(contract, `${field}.${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(contract, `${field}.${key}`);
}

function nonBlank(value: unknown, contract: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(contract, field);
  return value;
}

function canonicalId(value: unknown, contract: string, field: string): string {
  const parsed = nonBlank(value, contract, field);
  if (!SAFE_ID.test(parsed)) fail(contract, field);
  return parsed;
}

function boolean(value: unknown, contract: string, field: string): boolean {
  if (typeof value !== 'boolean') fail(contract, field);
  return value;
}

function uniqueStrings(value: unknown, contract: string, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(contract, field);
  const parsed = value.map((item, index) => nonBlank(item, contract, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) fail(contract, field);
  return parsed;
}

function optionalUniqueStrings(value: unknown, contract: string, field: string): string[] {
  if (!Array.isArray(value)) fail(contract, field);
  const parsed = value.map((item, index) => nonBlank(item, contract, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) fail(contract, field);
  return parsed;
}

function isSameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function hash(value: unknown, contract: string, field: string): string {
  const parsed = nonBlank(value, contract, field);
  if (!SHA256.test(parsed)) fail(contract, field);
  return parsed;
}

function parseInputRequirement(
  value: unknown,
  contract = 'SkillInputRequirement',
  field = 'value',
): SkillInputRequirement {
  const item = record(value, contract, field);
  exactKeys(
    item,
    ['key', 'kind', 'label', 'description', 'required', 'multiple', 'acceptedSources', 'question'],
    [],
    contract,
    field,
  );
  const key = canonicalId(item.key, contract, `${field}.key`);
  if (typeof item.kind !== 'string' || !INPUT_KINDS.has(item.kind)) fail(contract, `${field}.kind`);
  const acceptedSources = uniqueStrings(item.acceptedSources, contract, `${field}.acceptedSources`);
  if (acceptedSources.some((source) => !INPUT_SOURCES.has(source))) {
    fail(contract, `${field}.acceptedSources`);
  }
  return {
    key,
    kind: item.kind as SkillInputKind,
    label: nonBlank(item.label, contract, `${field}.label`),
    description: nonBlank(item.description, contract, `${field}.description`),
    required: boolean(item.required, contract, `${field}.required`),
    multiple: boolean(item.multiple, contract, `${field}.multiple`),
    acceptedSources: acceptedSources as SkillInputSource[],
    question: nonBlank(item.question, contract, `${field}.question`),
  };
}

export function parseSkillInputRequirements(value: unknown): SkillInputRequirement[] {
  const contract = 'SkillInputRequirement[]';
  if (!Array.isArray(value) || value.length === 0) fail(contract, 'value');
  const parsed = value.map((item, index) => parseInputRequirement(item, contract, `[${index}]`));
  if (new Set(parsed.map(({ key }) => key)).size !== parsed.length) fail(contract, 'duplicate key');
  return parsed;
}

function parseInvocationIds(value: unknown, contract: string, field: string): string[] {
  return uniqueStrings(value, contract, field).map((id, index) => canonicalId(id, contract, `${field}[${index}]`));
}

export function parseResolvedPlanInputs(value: unknown): ResolvedPlanInputs {
  const contract = 'ResolvedPlanInputs';
  const root = record(value, contract);
  exactKeys(root, ['resolved', 'pending', 'waived'], [], contract, 'value');
  if (!Array.isArray(root.resolved) || !Array.isArray(root.pending) || !Array.isArray(root.waived)) {
    fail(contract, 'collections');
  }
  const resolved = root.resolved.map((candidate, index): ResolvedPlanInput => {
    const field = `resolved[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(item, ['key', 'valueRef', 'source', 'targetInvocationIds'], [], contract, field);
    if (item.source !== 'conversation' && item.source !== 'upload' && item.source !== 'database') {
      fail(contract, `${field}.source`);
    }
    return {
      key: canonicalId(item.key, contract, `${field}.key`),
      valueRef: nonBlank(item.valueRef, contract, `${field}.valueRef`),
      source: item.source,
      targetInvocationIds: parseInvocationIds(item.targetInvocationIds, contract, `${field}.targetInvocationIds`),
    };
  });
  const pending = root.pending.map((candidate, index): PendingPlanInput => {
    const field = `pending[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(item, ['requirement', 'targetInvocationIds'], [], contract, field);
    return {
      requirement: parseInputRequirement(item.requirement, contract, `${field}.requirement`),
      targetInvocationIds: parseInvocationIds(item.targetInvocationIds, contract, `${field}.targetInvocationIds`),
    };
  });
  const waived = root.waived.map((candidate, index): WaivedPlanInput => {
    const field = `waived[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(item, ['key', 'targetInvocationIds', 'reason'], [], contract, field);
    return {
      key: canonicalId(item.key, contract, `${field}.key`),
      targetInvocationIds: parseInvocationIds(item.targetInvocationIds, contract, `${field}.targetInvocationIds`),
      reason: nonBlank(item.reason, contract, `${field}.reason`),
    };
  });
  const keys = [...resolved.map(({ key }) => key), ...pending.map(({ requirement }) => requirement.key), ...waived.map(({ key }) => key)];
  if (new Set(keys).size !== keys.length) fail(contract, 'input key appears in multiple states');
  return { resolved, pending, waived };
}

function parseSourceReference(value: unknown, contract: string, field: string): SourceReference {
  const item = record(value, contract, field);
  exactKeys(item, ['id', 'title', 'type'], ['url'], contract, field);
  const id = canonicalId(item.id, contract, `${field}.id`);
  if (!id.startsWith('S-')) fail(contract, `${field}.id`);
  if (typeof item.type !== 'string' || !REPORT_SOURCE_TYPES.has(item.type)) fail(contract, `${field}.type`);
  let url: string | undefined;
  if (item.url !== undefined) {
    url = nonBlank(item.url, contract, `${field}.url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(contract, `${field}.url`);
    }
    if (parsed!.protocol !== 'https:') fail(contract, `${field}.url`);
  }
  return {
    id,
    title: nonBlank(item.title, contract, `${field}.title`),
    type: item.type as SourceReference['type'],
    ...(url === undefined ? {} : { url }),
  };
}

function parseSourceReferences(value: unknown, contract: string, field: string): SourceReference[] {
  if (!Array.isArray(value)) fail(contract, field);
  const parsed = value.map((item, index) => parseSourceReference(item, contract, `${field}[${index}]`));
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) fail(contract, `${field}.id`);
  return parsed;
}

export function parseSkillReport(value: unknown): SkillReport {
  const contract = 'SkillReport';
  const root = record(value, contract);
  exactKeys(
    root,
    ['version', 'skillId', 'invocationId', 'title', 'status', 'markdown', 'sources', 'gaps'],
    ['missingInputKeys'],
    contract,
    'value',
  );
  if (root.version !== SKILL_REPORT_VERSION) fail(contract, 'version');
  if (typeof root.status !== 'string' || !SKILL_REPORT_STATUSES.has(root.status)) fail(contract, 'status');
  const status = root.status as SkillReportStatus;
  const missingInputKeys = root.missingInputKeys === undefined
    ? undefined
    : optionalUniqueStrings(root.missingInputKeys, contract, 'missingInputKeys')
      .map((key, index) => canonicalId(key, contract, `missingInputKeys[${index}]`));
  if (status === 'needs_input' && (!missingInputKeys || missingInputKeys.length === 0)) {
    fail(contract, 'missingInputKeys');
  }
  if (status !== 'needs_input' && missingInputKeys !== undefined) fail(contract, 'missingInputKeys');
  const gaps = optionalUniqueStrings(root.gaps, contract, 'gaps');
  if (status === 'completed_with_gaps' && gaps.length === 0) fail(contract, 'gaps');
  if (status === 'completed' && gaps.length > 0) fail(contract, 'status');
  return {
    version: SKILL_REPORT_VERSION,
    skillId: canonicalId(root.skillId, contract, 'skillId'),
    invocationId: canonicalId(root.invocationId, contract, 'invocationId'),
    title: nonBlank(root.title, contract, 'title'),
    status,
    markdown: nonBlank(root.markdown, contract, 'markdown'),
    sources: parseSourceReferences(root.sources, contract, 'sources'),
    gaps,
    ...(missingInputKeys === undefined ? {} : { missingInputKeys }),
  };
}

export function skillReportPath(invocationId: string, extension: 'json' | 'md' = 'json'): string {
  const encoded = encodeURIComponent(invocationId);
  if (!encoded || encoded.includes('/') || encoded === '.' || encoded === '..') {
    throw new Error('SkillReport invocationId cannot form a safe relative path');
  }
  return `skill-results/${encoded}.${extension}`;
}

export function parseFinalReport(value: unknown): FinalReport {
  const contract = 'FinalReport';
  const root = record(value, contract);
  exactKeys(
    root,
    ['version', 'taskId', 'planVersionId', 'attemptId', 'mode', 'title', 'markdown', 'sources', 'gaps', 'skillReports'],
    [],
    contract,
    'value',
  );
  if (root.version !== FINAL_REPORT_VERSION) fail(contract, 'version');
  if (typeof root.mode !== 'string' || !MODES.has(root.mode)) fail(contract, 'mode');
  if (!Array.isArray(root.skillReports) || root.skillReports.length === 0) fail(contract, 'skillReports');
  const skillReports = root.skillReports.map((candidate, index): FinalReportSkillReference => {
    const field = `skillReports[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(item, ['skillId', 'invocationId', 'status', 'path'], [], contract, field);
    if (typeof item.status !== 'string' || !COMPLETED_SKILL_REPORT_STATUSES.has(item.status)) {
      fail(contract, `${field}.status`);
    }
    const path = nonBlank(item.path, contract, `${field}.path`);
    if (!SAFE_REPORT_PATH.test(path)) fail(contract, `${field}.path`);
    return {
      skillId: canonicalId(item.skillId, contract, `${field}.skillId`),
      invocationId: canonicalId(item.invocationId, contract, `${field}.invocationId`),
      status: item.status as CompletedSkillReportStatus,
      path,
    };
  });
  if (new Set(skillReports.map(({ invocationId }) => invocationId)).size !== skillReports.length) {
    fail(contract, 'skillReports.invocationId');
  }
  if (root.mode === 'single_skill' && skillReports.length !== 1) fail(contract, 'skillReports');
  return {
    version: FINAL_REPORT_VERSION,
    taskId: canonicalId(root.taskId, contract, 'taskId'),
    planVersionId: canonicalId(root.planVersionId, contract, 'planVersionId'),
    attemptId: canonicalId(root.attemptId, contract, 'attemptId'),
    mode: root.mode as FinalReport['mode'],
    title: nonBlank(root.title, contract, 'title'),
    markdown: nonBlank(root.markdown, contract, 'markdown'),
    sources: parseSourceReferences(root.sources, contract, 'sources'),
    gaps: optionalUniqueStrings(root.gaps, contract, 'gaps'),
    skillReports,
  };
}

function parseSnapshot(value: unknown, field: string): LightweightSkillSnapshot {
  const contract = 'LightweightExecutionPlanV1';
  const root = record(value, contract, field);
  exactKeys(
    root,
    ['skill_id', 'body', 'body_hash', 'input_requirements', 'input_requirements_hash', 'output_schema_hash', 'report_template', 'report_template_hash'],
    ['execution_contract_hash'],
    contract,
    field,
  );
  return {
    skill_id: canonicalId(root.skill_id, contract, `${field}.skill_id`),
    body: nonBlank(root.body, contract, `${field}.body`),
    body_hash: hash(root.body_hash, contract, `${field}.body_hash`),
    input_requirements: parseSkillInputRequirements(root.input_requirements),
    input_requirements_hash: hash(root.input_requirements_hash, contract, `${field}.input_requirements_hash`),
    output_schema_hash: hash(root.output_schema_hash, contract, `${field}.output_schema_hash`),
    report_template: nonBlank(root.report_template, contract, `${field}.report_template`),
    report_template_hash: hash(root.report_template_hash, contract, `${field}.report_template_hash`),
    ...(root.execution_contract_hash === undefined
      ? {}
      : { execution_contract_hash: hash(root.execution_contract_hash, contract, `${field}.execution_contract_hash`) }),
  };
}

export function isLightweightExecutionPlanV1(value: unknown): value is LightweightExecutionPlanV1 {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).execution_contract_version === LIGHTWEIGHT_EXECUTION_PLAN_VERSION;
}

export function parseLightweightExecutionPlanV1(value: unknown): LightweightExecutionPlanV1 {
  const contract = 'LightweightExecutionPlanV1';
  const root = record(value, contract);
  exactKeys(root, [
    'task_id',
    'execution_contract_version',
    'mode',
    'deliverable_type',
    'evidence_requirements',
    'problem_graph',
    'problem_graph_provenance',
    'capability_decisions',
    'steps',
    'candidate_metadata',
    'activated_nodes',
    'skill_invocations',
    'resolved_inputs',
  ], ['capability_gaps', 'planning_provenance'], contract, 'value');
  if (root.execution_contract_version !== LIGHTWEIGHT_EXECUTION_PLAN_VERSION) fail(contract, 'execution_contract_version');
  if (typeof root.mode !== 'string' || !MODES.has(root.mode)) fail(contract, 'mode');
  canonicalId(root.task_id, contract, 'task_id');
  nonBlank(root.deliverable_type, contract, 'deliverable_type');
  if (!Array.isArray(root.steps) || root.steps.length === 0) fail(contract, 'steps');
  if (!Array.isArray(root.skill_invocations) || root.skill_invocations.length === 0) fail(contract, 'skill_invocations');
  const invocations = root.skill_invocations.map((candidate, index): LightweightSkillInvocation => {
    const field = `skill_invocations[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(
      item,
      ['invocation_id', 'skill_id', 'depends_on_invocation_ids', 'step_nos', 'required', 'failure_policy', 'snapshot'],
      [],
      contract,
      field,
    );
    if (!Array.isArray(item.step_nos) || item.step_nos.length === 0 || !item.step_nos.every((step) => Number.isInteger(step) && Number(step) > 0)) {
      fail(contract, `${field}.step_nos`);
    }
    if (new Set(item.step_nos).size !== item.step_nos.length) fail(contract, `${field}.step_nos`);
    if (item.failure_policy !== 'block' && item.failure_policy !== 'gap') fail(contract, `${field}.failure_policy`);
    const snapshot = parseSnapshot(item.snapshot, `${field}.snapshot`);
    const skillId = canonicalId(item.skill_id, contract, `${field}.skill_id`);
    if (snapshot.skill_id !== skillId) fail(contract, `${field}.snapshot.skill_id`);
    return {
      invocation_id: canonicalId(item.invocation_id, contract, `${field}.invocation_id`),
      skill_id: skillId,
      depends_on_invocation_ids: optionalUniqueStrings(item.depends_on_invocation_ids, contract, `${field}.depends_on_invocation_ids`)
        .map((id, dependencyIndex) => canonicalId(id, contract, `${field}.depends_on_invocation_ids[${dependencyIndex}]`)),
      step_nos: item.step_nos as number[],
      required: boolean(item.required, contract, `${field}.required`),
      failure_policy: item.failure_policy,
      snapshot,
    };
  });
  const invocationIds = new Set(invocations.map(({ invocation_id }) => invocation_id));
  if (invocationIds.size !== invocations.length) fail(contract, 'skill_invocations.invocation_id');
  for (const invocation of invocations) {
    if (invocation.depends_on_invocation_ids.some((id) => !invocationIds.has(id) || id === invocation.invocation_id)) {
      fail(contract, `skill_invocations.${invocation.invocation_id}.depends_on_invocation_ids`);
    }
  }
  if (root.mode === 'single_skill' && invocations.length !== 1) fail(contract, 'skill_invocations');
  const resolvedInputs = parseResolvedPlanInputs(root.resolved_inputs);
  const steps = root.steps.map((value, index) => {
    const step = record(value, contract, `steps[${index}]`);
    if (
      !Number.isInteger(step.step_no)
      || typeof step.actor_type !== 'string'
      || typeof step.actor_id !== 'string'
    ) fail(contract, `steps[${index}]`);
    return step as unknown as CurrentPlanStep;
  });
  const stepNos = steps.map((step) => step.step_no);
  if (!stepNos.every((stepNo, index) => stepNo === index + 1)) fail(contract, 'steps.step_no');
  const knownStepNos = new Set(stepNos);
  const requirements = new Map<string, { requirement: SkillInputRequirement; targetInvocationIds: string[] }>();
  for (const invocation of invocations) {
    if (invocation.step_nos.some((stepNo) => !knownStepNos.has(stepNo))) fail(contract, 'skill_invocations.step_nos');
    if (!steps.some((step) => (
      invocation.step_nos.includes(step.step_no)
      && step.actor_type === 'skill'
      && step.actor_id === invocation.skill_id
      && step.skill_invocation_id === invocation.invocation_id
    ))) fail(contract, `skill_invocations.${invocation.invocation_id}.output_step`);
    for (const requirement of invocation.snapshot.input_requirements) {
      const existing = requirements.get(requirement.key);
      if (existing) existing.targetInvocationIds.push(invocation.invocation_id);
      else requirements.set(requirement.key, {
        requirement,
        targetInvocationIds: [invocation.invocation_id],
      });
    }
  }
  const assertTargets = (key: string, actual: readonly string[]): void => {
    const expected = requirements.get(key)?.targetInvocationIds;
    if (!expected || !isSameStringSet(expected, actual)) fail(contract, `resolved_inputs.${key}.targetInvocationIds`);
  };
  for (const item of resolvedInputs.resolved) assertTargets(item.key, item.targetInvocationIds);
  for (const item of resolvedInputs.pending) {
    assertTargets(item.requirement.key, item.targetInvocationIds);
    const declared = requirements.get(item.requirement.key)?.requirement;
    if (!declared || JSON.stringify(declared) !== JSON.stringify(item.requirement)) {
      fail(contract, `resolved_inputs.${item.requirement.key}.requirement`);
    }
  }
  for (const item of resolvedInputs.waived) {
    assertTargets(item.key, item.targetInvocationIds);
    if (requirements.get(item.key)?.requirement.required !== false) {
      fail(contract, `resolved_inputs.${item.key}.waived`);
    }
  }
  return {
    ...(structuredClone(root) as unknown as LightweightExecutionPlanV1),
    skill_invocations: invocations,
    resolved_inputs: resolvedInputs,
    steps,
  };
}
