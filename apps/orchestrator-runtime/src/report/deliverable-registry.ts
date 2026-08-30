import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  CONTRIBUTION_TYPES,
  type ContributionType,
  type ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import {
  getConfigRoot,
  loadEvidencePolicy,
  loadReportTemplate,
  loadSkillRegistry,
  resolveSkillComposition,
  type EvidencePolicyEntry,
  type ReportTemplateConfig,
} from '../runtime/config-loader.ts';

export type DeliverableCompositionPolicy =
  | { mode: 'standalone_compat' }
  | {
      mode: 'portfolio';
      synthesizer_skill_id: string;
      accepted_contribution_types: ContributionType[];
      contribution_schema: string;
    };

export interface DeliverableRegistryEntry {
  id: string;
  status: 'active' | 'inactive';
  task_types: string[];
  envelope_version: string;
  payload_schema: string;
  read_payload_schemas?: string[];
  synthesis_mode?: 'model_synthesis' | 'reviewed_skill_assembly';
  synthesis_prompt: string;
  review_rubric: string;
  evidence_policy: string;
  report_template: string;
  aliases?: string[];
  composition?: DeliverableCompositionPolicy;
}

export interface DeliverableRegistryDiagnostic {
  target: string;
  message: string;
}

export interface DeliverableContractResources {
  entry: DeliverableRegistryEntry;
  payloadSchemaPath: string;
  payloadSchema: object;
  readablePayloadSchemas: Array<{ path: string; schema: object }>;
  synthesisMode: 'model_synthesis' | 'reviewed_skill_assembly';
  synthesisPromptPath: string;
  synthesisPrompt: string;
  reviewRubricPath: string;
  reviewRubric: object;
  evidencePolicy: EvidencePolicyEntry;
  reportTemplate: ReportTemplateConfig;
}

const REGISTRY_PATH = 'orchestrator/deliverable-registry.yaml';
const EVIDENCE_POLICY_PATH = 'orchestrator/evidence-policy.yaml';
const ENTRY_FIELDS = [
  'id',
  'status',
  'task_types',
  'envelope_version',
  'payload_schema',
  'read_payload_schemas',
  'synthesis_mode',
  'synthesis_prompt',
  'review_rubric',
  'evidence_policy',
  'report_template',
  'aliases',
  'composition',
] as const;
const RESOURCE_PATH_FIELDS = ['payload_schema', 'synthesis_prompt', 'review_rubric'] as const;
const SAFE_RESOURCE_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;
const SAFE_TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(target: string, message: string): DeliverableRegistryDiagnostic {
  return { target, message };
}

const COMPOSITION_POLICY_FIELDS = new Set([
  'mode',
  'synthesizer_skill_id',
  'accepted_contribution_types',
  'contribution_schema',
]);
const CONTRIBUTION_TYPE_SET = new Set<ContributionType>(CONTRIBUTION_TYPES);

function compositionPolicyIssues(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['composition must be an object'];
  const issues: string[] = [];
  const unknownField = Object.keys(value).find((field) => !COMPOSITION_POLICY_FIELDS.has(field));
  if (unknownField) issues.push(`composition contains unsupported field "${unknownField}"`);
  if (value.mode === 'standalone_compat') {
    const extra = Object.keys(value).find((field) => field !== 'mode');
    if (extra) issues.push(`standalone_compat composition must not declare "${extra}"`);
    return issues;
  }
  if (value.mode !== 'portfolio') {
    issues.push('composition.mode must be portfolio or standalone_compat');
    return issues;
  }
  if (
    typeof value.synthesizer_skill_id !== 'string'
    || !SAFE_RESOURCE_ID.test(value.synthesizer_skill_id)
  ) issues.push('portfolio composition requires a canonical synthesizer_skill_id');
  if (
    !Array.isArray(value.accepted_contribution_types)
    || value.accepted_contribution_types.length === 0
    || value.accepted_contribution_types.some((type) => (
      typeof type !== 'string' || !CONTRIBUTION_TYPE_SET.has(type as ContributionType)
    ))
    || new Set(value.accepted_contribution_types).size !== value.accepted_contribution_types.length
  ) issues.push('portfolio composition requires unique accepted_contribution_types');
  if (typeof value.contribution_schema !== 'string' || !value.contribution_schema.trim()) {
    issues.push('portfolio composition requires contribution_schema');
  }
  return issues;
}

export function validateDeliverableCompositionPolicy<
  T extends Pick<DeliverableRegistryEntry, 'id' | 'composition'>,
>(entry: T): string[] {
  return compositionPolicyIssues(entry.composition);
}

function cloneCompositionPolicy(
  policy: DeliverableCompositionPolicy,
): DeliverableCompositionPolicy {
  return policy.mode === 'standalone_compat'
    ? { mode: 'standalone_compat' }
    : {
        ...policy,
        accepted_contribution_types: [...policy.accepted_contribution_types],
      };
}

function safeResourcePath(relativePath: string, field: string): string {
  const root = resolve(getConfigRoot());
  if (isAbsolute(relativePath)) {
    throw new Error(`${field} path is unsafe: absolute paths are not allowed`);
  }
  const absolutePath = resolve(root, relativePath);
  const lexicalRelative = relative(root, absolutePath);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error(`${field} path escapes the configured root`);
  }
  if (existsSync(absolutePath)) {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(absolutePath);
    const physicalRelative = relative(realRoot, realPath);
    if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) {
      throw new Error(`${field} path escapes the configured root through a symbolic link`);
    }
  }
  return absolutePath;
}

function parseJsonObject(path: string, field: string): object {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${field} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${field} must contain a JSON object`);
  return value;
}

function parseYamlObject(path: string, field: string): object {
  let value: unknown;
  try {
    value = parseYaml(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${field} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${field} must contain a YAML object`);
  return value;
}
function parseReviewRubric(path: string): object {
  const rubric = parseYamlObject(path, 'review_rubric') as Record<string, unknown>;
  const expectedId = basename(path).replace(/\.ya?ml$/u, '');
  if (rubric.version !== 1) throw new Error('review_rubric version must equal 1');
  if (rubric.id !== expectedId) throw new Error(`review_rubric id must equal ${expectedId}`);
  if (!Array.isArray(rubric.dimensions) || rubric.dimensions.length === 0) {
    throw new Error('review_rubric dimensions must be a non-empty array');
  }
  const ids = new Set<string>();
  for (const [index, value] of rubric.dimensions.entries()) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.required !== 'boolean') {
      throw new Error(`review_rubric dimension ${index + 1} is malformed`);
    }
    if (ids.has(value.id)) throw new Error(`review_rubric dimension id "${value.id}" is duplicated`);
    ids.add(value.id);
  }
  return rubric;
}


function validateResourcePath(
  entry: DeliverableRegistryEntry,
  field: typeof RESOURCE_PATH_FIELDS[number],
  diagnostics: DeliverableRegistryDiagnostic[],
): void {
  const target = `deliverable:${entry.id}`;
  try {
    const path = safeResourcePath(entry[field], field);
    if (!existsSync(path)) {
      diagnostics.push(diagnostic(target, `${field} resource does not exist: ${entry[field]}`));
      return;
    }
    if (field === 'payload_schema') parseJsonObject(path, field);
    if (field === 'synthesis_prompt' && !readFileSync(path, 'utf8').trim()) {
      diagnostics.push(diagnostic(target, `${field} resource must not be empty: ${entry[field]}`));
    }
    if (field === 'review_rubric') parseReviewRubric(path);
  } catch (error) {
    diagnostics.push(diagnostic(target, error instanceof Error ? error.message : String(error)));
  }
}

function validateEntry(value: unknown, index: number, diagnostics: DeliverableRegistryDiagnostic[]): DeliverableRegistryEntry | null {
  const fallbackTarget = `deliverable[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(fallbackTarget, 'registry entry must be an object'));
    return null;
  }
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
  const target = `deliverable:${id ?? `(index-${index})`}`;
  const unexpectedField = Object.keys(value).find((field) => !ENTRY_FIELDS.includes(field as typeof ENTRY_FIELDS[number]));
  if (unexpectedField) diagnostics.push(diagnostic(target, `registry entry contains unsupported field "${unexpectedField}"`));

  for (const field of ENTRY_FIELDS) {
    if (field === 'aliases' || field === 'read_payload_schemas' || field === 'synthesis_mode' || field === 'composition') continue;
    if (value[field] === undefined || value[field] === null || value[field] === '') {
      diagnostics.push(diagnostic(target, `registry entry is missing required field "${field}"`));
    }
  }
  if (!id) diagnostics.push(diagnostic(target, 'id must be a non-empty string'));
  if (id && !SAFE_RESOURCE_ID.test(id)) diagnostics.push(diagnostic(target, 'id contains unsafe characters'));
  if (value.status !== 'active' && value.status !== 'inactive') {
    diagnostics.push(diagnostic(target, 'status must be active or inactive'));
  }
  if (!Array.isArray(value.task_types)) {
    diagnostics.push(diagnostic(target, 'task_types must be a non-empty array'));
  } else if (
    value.task_types.length === 0
    || value.task_types.some((taskType) => (
      typeof taskType !== 'string' || !SAFE_RESOURCE_ID.test(taskType) || taskType !== taskType.trim()
    ))
  ) {
    diagnostics.push(diagnostic(target, 'task_types must contain safe non-empty strings'));
  } else if (new Set(value.task_types).size !== value.task_types.length) {
    diagnostics.push(diagnostic(target, 'task_types must not contain duplicates'));
  }
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases) || value.aliases.length === 0) {
      diagnostics.push(diagnostic(target, 'aliases must be a non-empty array'));
    } else if (value.aliases.some((alias) => (
      typeof alias !== 'string' || alias.length === 0 || alias !== alias.trim()
    ))) {
      diagnostics.push(diagnostic(target, 'aliases must contain trimmed, non-empty strings'));
    } else if (new Set(value.aliases).size !== value.aliases.length) {
      diagnostics.push(diagnostic(target, 'aliases must not contain duplicates'));
    }
  }
  if (value.read_payload_schemas !== undefined) {
    if (
      !Array.isArray(value.read_payload_schemas)
      || value.read_payload_schemas.length === 0
      || value.read_payload_schemas.some((path) => typeof path !== 'string' || !path.trim())
    ) {
      diagnostics.push(diagnostic(target, 'read_payload_schemas must contain non-empty paths'));
    } else if (new Set(value.read_payload_schemas).size !== value.read_payload_schemas.length) {
      diagnostics.push(diagnostic(target, 'read_payload_schemas must not contain duplicates'));
    }
  }
  if (
    value.synthesis_mode !== undefined
    && value.synthesis_mode !== 'model_synthesis'
    && value.synthesis_mode !== 'reviewed_skill_assembly'
  ) {
    diagnostics.push(diagnostic(target, 'synthesis_mode must be model_synthesis or reviewed_skill_assembly'));
  }
  const compositionIssues = compositionPolicyIssues(value.composition);
  for (const message of compositionIssues) diagnostics.push(diagnostic(target, message));

  for (const field of ['envelope_version', ...RESOURCE_PATH_FIELDS, 'evidence_policy', 'report_template'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      diagnostics.push(diagnostic(target, `${field} must be a non-empty string`));
    }
  }
  if (typeof value.evidence_policy === 'string' && !SAFE_RESOURCE_ID.test(value.evidence_policy)) {
    diagnostics.push(diagnostic(target, 'evidence_policy contains unsafe characters'));
  }
  if (typeof value.report_template === 'string' && !SAFE_TEMPLATE_ID.test(value.report_template)) {
    diagnostics.push(diagnostic(target, 'report_template contains unsafe path characters'));
  }

  const valid = id !== null
    && SAFE_RESOURCE_ID.test(id)
    && (value.status === 'active' || value.status === 'inactive')
    && Array.isArray(value.task_types)
    && value.task_types.length > 0
    && value.task_types.every((taskType) => (
      typeof taskType === 'string' && SAFE_RESOURCE_ID.test(taskType) && taskType === taskType.trim()
    ))
    && new Set(value.task_types).size === value.task_types.length
    && (value.aliases === undefined || (
      Array.isArray(value.aliases)
      && value.aliases.length > 0
      && value.aliases.every((alias) => (
        typeof alias === 'string' && alias.length > 0 && alias === alias.trim()
      ))
      && new Set(value.aliases).size === value.aliases.length
    ))
    && (value.read_payload_schemas === undefined || (
      Array.isArray(value.read_payload_schemas)
      && value.read_payload_schemas.length > 0
      && value.read_payload_schemas.every((path) => typeof path === 'string' && path.trim().length > 0)
      && new Set(value.read_payload_schemas).size === value.read_payload_schemas.length
    ))
    && (value.synthesis_mode === undefined || value.synthesis_mode === 'model_synthesis' || value.synthesis_mode === 'reviewed_skill_assembly')
    && compositionIssues.length === 0
    && typeof value.envelope_version === 'string' && value.envelope_version.trim().length > 0
    && RESOURCE_PATH_FIELDS.every((field) => typeof value[field] === 'string' && value[field].trim().length > 0)
    && typeof value.evidence_policy === 'string' && SAFE_RESOURCE_ID.test(value.evidence_policy)
    && typeof value.report_template === 'string' && SAFE_TEMPLATE_ID.test(value.report_template);
  if (!valid) return null;

  return {
    id,
    status: value.status as DeliverableRegistryEntry['status'],
    task_types: [...(value.task_types as string[])],
    envelope_version: value.envelope_version as string,
    payload_schema: value.payload_schema as string,
    ...(value.read_payload_schemas === undefined
      ? {}
      : { read_payload_schemas: [...(value.read_payload_schemas as string[])] }),
    ...(value.synthesis_mode === undefined
      ? {}
      : { synthesis_mode: value.synthesis_mode as DeliverableRegistryEntry['synthesis_mode'] }),
    synthesis_prompt: value.synthesis_prompt as string,
    review_rubric: value.review_rubric as string,
    evidence_policy: value.evidence_policy as string,
    report_template: value.report_template as string,
    ...(value.aliases === undefined ? {} : { aliases: [...(value.aliases as string[])] }),
    ...(value.composition === undefined
      ? {}
      : { composition: cloneCompositionPolicy(value.composition as DeliverableCompositionPolicy) }),
  };
}

function validateActiveResources(entry: DeliverableRegistryEntry, diagnostics: DeliverableRegistryDiagnostic[]): void {
  for (const field of RESOURCE_PATH_FIELDS) validateResourcePath(entry, field, diagnostics);
  if (entry.composition?.mode === 'portfolio') {
    const target = `deliverable:${entry.id}`;
    try {
      const path = safeResourcePath(entry.composition.contribution_schema, 'composition.contribution_schema');
      if (!existsSync(path)) {
        diagnostics.push(diagnostic(
          target,
          `composition contribution schema does not exist: ${entry.composition.contribution_schema}`,
        ));
      } else {
        parseJsonObject(path, 'composition.contribution_schema');
      }
    } catch (error) {
      diagnostics.push(diagnostic(target, error instanceof Error ? error.message : String(error)));
    }
  }
  for (const relativePath of entry.read_payload_schemas ?? [entry.payload_schema]) {
    const target = `deliverable:${entry.id}`;
    try {
      const path = safeResourcePath(relativePath, 'read_payload_schemas');
      if (!existsSync(path)) diagnostics.push(diagnostic(target, `read payload schema does not exist: ${relativePath}`));
      else parseJsonObject(path, 'read_payload_schemas');
    } catch (error) {
      diagnostics.push(diagnostic(target, error instanceof Error ? error.message : String(error)));
    }
  }
  const target = `deliverable:${entry.id}`;
  try {
    const policyPath = safeResourcePath(EVIDENCE_POLICY_PATH, 'evidence_policy');
    if (!existsSync(policyPath)) {
      diagnostics.push(diagnostic(target, `evidence_policy resource does not exist: ${EVIDENCE_POLICY_PATH}`));
    } else {
      const policies = loadEvidencePolicy().policies;
      for (const taskType of entry.task_types) {
        const selectedPolicy = policies.find((policy) => (
          policy.task_type === taskType
          && policy.deliverable_type === entry.id
          && policy.requirements.some((requirement) => requirement.id === entry.evidence_policy)
        ));
        if (!selectedPolicy) {
          diagnostics.push(diagnostic(
            target,
            `evidence_policy "${entry.evidence_policy}" is not defined for task mapping ${taskType}`,
          ));
        }
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(target, `evidence_policy resource is invalid: ${error instanceof Error ? error.message : String(error)}`));
  }

  try {
    const templatePath = safeResourcePath(
      `orchestrator/report-templates/${entry.report_template}.yaml`,
      'report_template',
    );
    if (!existsSync(templatePath)) {
      diagnostics.push(diagnostic(target, `report_template resource does not exist: ${entry.report_template}`));
    } else {
      loadReportTemplate(entry.report_template);
    }
  } catch (error) {
    diagnostics.push(diagnostic(target, `report_template resource is invalid: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function parseDeliverableRegistry(validateResources: boolean): {
  entries: DeliverableRegistryEntry[];
  diagnostics: DeliverableRegistryDiagnostic[];
} {
  const diagnostics: DeliverableRegistryDiagnostic[] = [];
  let value: unknown;
  try {
    const path = safeResourcePath(REGISTRY_PATH, 'registry');
    value = parseYaml(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      entries: [],
      diagnostics: [diagnostic('deliverable-registry', `cannot read Registry v2: ${error instanceof Error ? error.message : String(error)}`)],
    };
  }
  if (!isRecord(value)) {
    return { entries: [], diagnostics: [diagnostic('deliverable-registry', 'Registry v2 root must be an object')] };
  }
  const unsupportedRootField = Object.keys(value).find((field) => field !== 'version' && field !== 'deliverables');
  if (unsupportedRootField) {
    diagnostics.push(diagnostic('deliverable-registry', `Registry v2 contains unsupported field "${unsupportedRootField}"`));
  }
  if (value.version !== 2) diagnostics.push(diagnostic('deliverable-registry', 'Registry version must equal 2'));
  if (!Array.isArray(value.deliverables) || value.deliverables.length === 0) {
    diagnostics.push(diagnostic('deliverable-registry', 'Registry v2 deliverables must be a non-empty array'));
    return { entries: [], diagnostics };
  }

  const entries = value.deliverables.flatMap((entry, index) => {
    const parsed = validateEntry(entry, index, diagnostics);
    return parsed ? [parsed] : [];
  });
  const activeEntries = entries.filter(({ status }) => status === 'active');
  const explicitCompositionRequired = activeEntries.some(({ composition }) => composition !== undefined);
  if (explicitCompositionRequired) {
    for (const entry of activeEntries) {
      if (!entry.composition) {
        diagnostics.push(diagnostic(
          `deliverable:${entry.id}`,
          'active deliverable is missing an explicit composition policy',
        ));
      }
    }
  }
  const registeredSkills = new Map(loadSkillRegistry().skills.map((skill) => [skill.id, skill]));
  for (const entry of activeEntries) {
    if (entry.composition?.mode !== 'portfolio') continue;
    const target = `deliverable:${entry.id}`;
    const synthesizer = registeredSkills.get(entry.composition.synthesizer_skill_id);
    if (!synthesizer || synthesizer.status !== 'active') {
      diagnostics.push(diagnostic(
        target,
        `portfolio synthesizer is not an active Skill: ${entry.composition.synthesizer_skill_id}`,
      ));
      continue;
    }
    try {
      const skillComposition = resolveSkillComposition(synthesizer);
      if (!skillComposition.modes.includes('synthesizer')) {
        diagnostics.push(diagnostic(
          target,
          `portfolio owner ${synthesizer.id} is not classified as a synthesizer`,
        ));
      }
      if (!skillComposition.compatible_deliverables.includes(entry.id)) {
        diagnostics.push(diagnostic(
          target,
          `portfolio owner ${synthesizer.id} is incompatible with ${entry.id}`,
        ));
      }
      if (skillComposition.contribution_schema !== entry.composition.contribution_schema) {
        diagnostics.push(diagnostic(
          target,
          `portfolio owner ${synthesizer.id} contribution schema does not match the deliverable policy`,
        ));
      }
    } catch (error) {
      diagnostics.push(diagnostic(target, error instanceof Error ? error.message : String(error)));
    }
  }
  const ids = new Set<string>();
  const taskOwners = new Map<string, string>();
  const activeIdentifierOwners = new Map<string, string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) diagnostics.push(diagnostic(`deliverable:${entry.id}`, `duplicate deliverable id "${entry.id}"`));
    ids.add(entry.id);
    if (entry.status !== 'active') continue;
    for (const identifier of [entry.id, ...(entry.aliases ?? [])]) {
      const owner = activeIdentifierOwners.get(identifier);
      if (owner && owner !== entry.id) {
        diagnostics.push(diagnostic(
          `deliverable:${entry.id}`,
          `active alias "${identifier}" is ambiguous between ${owner} and ${entry.id}`,
        ));
      } else {
        activeIdentifierOwners.set(identifier, entry.id);
      }
    }
    for (const taskType of entry.task_types) {
      const owner = taskOwners.get(taskType);
      if (owner) {
        diagnostics.push(diagnostic(
          `deliverable:${entry.id}`,
          `duplicate active task mapping "${taskType}" is owned by ${owner} and ${entry.id}`,
        ));
      } else {
        taskOwners.set(taskType, entry.id);
      }
    }
    if (validateResources) validateActiveResources(entry, diagnostics);
  }
  return { entries, diagnostics };
}
export function inspectDeliverableRegistry(): {
  entries: DeliverableRegistryEntry[];
  diagnostics: DeliverableRegistryDiagnostic[];
} {
  return parseDeliverableRegistry(true);
}


function validatedEntries(): DeliverableRegistryEntry[] {
  const inspection = parseDeliverableRegistry(false);
  if (inspection.diagnostics.length > 0) {
    throw new Error(`Deliverable Registry v2 invalid: ${inspection.diagnostics.map((item) => `${item.target}: ${item.message}`).join('; ')}`);
  }
  return inspection.entries;
}

function validateSelectedResources(entry: DeliverableRegistryEntry): DeliverableRegistryEntry {
  const diagnostics: DeliverableRegistryDiagnostic[] = [];
  validateActiveResources(entry, diagnostics);
  if (diagnostics.length > 0) {
    throw new Error(`Deliverable Registry v2 invalid: ${diagnostics.map((item) => `${item.target}: ${item.message}`).join('; ')}`);
  }
  return entry;
}

function cloneEntry(entry: DeliverableRegistryEntry): DeliverableRegistryEntry {
  const clone = { ...entry, task_types: [...entry.task_types] };
  if (entry.aliases) clone.aliases = [...entry.aliases];
  if (entry.read_payload_schemas) clone.read_payload_schemas = [...entry.read_payload_schemas];
  if (entry.composition) clone.composition = cloneCompositionPolicy(entry.composition);
  return clone;
}

function assertExpectedDeliverableCompatibility(
  entry: DeliverableRegistryEntry,
  expectedDeliverables: readonly string[],
  allowMappedResearchPlanAlias = false,
): void {
  if (!Array.isArray(expectedDeliverables) || expectedDeliverables.length === 0) {
    throw new Error(`deliverable ${entry.id} is incompatible with empty expectedDeliverables`);
  }
  if (expectedDeliverables.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('expectedDeliverables must contain non-empty strings');
  }
  const compatibleIds = new Set([
    entry.id,
    ...(entry.aliases ?? []),
    ...(allowMappedResearchPlanAlias && entry.id === 'research_plan' ? ['research plan'] : []),
  ]);
  if (!expectedDeliverables.some((value) => compatibleIds.has(value))) {
    throw new Error(`deliverable ${entry.id} is incompatible with expectedDeliverables`);
  }
}

function resolveTaskMapping(
  entries: readonly DeliverableRegistryEntry[],
  taskType: string,
): DeliverableRegistryEntry {
  const mapped = entries.filter((entry) => entry.task_types.includes(taskType));
  const active = mapped.filter((entry) => entry.status === 'active');
  if (active.length === 0) {
    if (mapped.length > 0) throw new Error(`task type "${taskType}" is mapped only to an inactive deliverable`);
    throw new Error(`unsupported task type "${taskType}": no active deliverable is mapped`);
  }
  if (active.length > 1) throw new Error(`duplicate active task mapping for "${taskType}"`);
  return cloneEntry(active[0]!);
}

export function canonicalizeExpectedDeliverables(requirement: ResearchTaskV2): ResearchTaskV2 {
  const selected = resolveTaskMapping(validatedEntries(), requirement.task_type);
  if (!Array.isArray(requirement.expected_deliverables) || requirement.expected_deliverables.length === 0) {
    throw new Error(`deliverable ${selected.id} is incompatible with empty expectedDeliverables`);
  }
  if (requirement.expected_deliverables.some((label) => typeof label !== 'string' || !label.trim())) {
    throw new Error(`deliverable ${selected.id} is incompatible with expectedDeliverables`);
  }
  const declared = requirement.expected_deliverables.map((label) => label.trim());
  const compatible = new Set([selected.id, ...(selected.aliases ?? [])]);
  const answerOrPlanTask = requirement.task_type === 'user_research_planning'
    || requirement.task_type === 'research_synthesis';
  if (
    !declared.some((label) => compatible.has(label))
    || (answerOrPlanTask && (declared.length !== 1 || !compatible.has(declared[0]!)))
  ) {
    throw new Error(`deliverable ${selected.id} is incompatible with expectedDeliverables`);
  }
  return {
    ...requirement,
    expected_deliverables: [selected.id],
  };
}

/**
 * Model output is an untrusted draft. Once its task type has been reconciled
 * with the user's request, the Registry is the sole authority for the
 * persisted deliverable ID. Strict compatibility checks remain in
 * canonicalizeExpectedDeliverables()/resolveDeliverable() for stored and
 * execution-time contracts.
 */
export function canonicalizeGeneratedExpectedDeliverables(requirement: ResearchTaskV2): ResearchTaskV2 {
  const selected = resolveTaskMapping(validatedEntries(), requirement.task_type);
  if (!Array.isArray(requirement.expected_deliverables) || requirement.expected_deliverables.length === 0) {
    throw new Error(`deliverable ${selected.id} is incompatible with empty expectedDeliverables`);
  }
  if (requirement.expected_deliverables.some((label) => typeof label !== 'string' || !label.trim())) {
    throw new Error(`deliverable ${selected.id} is incompatible with expectedDeliverables`);
  }
  return {
    ...requirement,
    expected_deliverables: [selected.id],
  };
}

function resolveActiveDeliverableId(
  entries: readonly DeliverableRegistryEntry[],
  deliverableId: string,
): DeliverableRegistryEntry {
  const matching = entries.filter((entry) => (
    entry.id === deliverableId || entry.aliases?.includes(deliverableId)
  ));
  const active = matching.filter((entry) => entry.status === 'active');
  if (active.length === 0) {
    if (matching.length > 0) throw new Error(`deliverable "${deliverableId}" is inactive`);
    throw new Error(`unsupported deliverable "${deliverableId}"`);
  }
  if (active.length > 1) throw new Error(`ambiguous active deliverable id or alias "${deliverableId}"`);
  return cloneEntry(active[0]!);
}

export function resolveDeliverable(
  taskType: string,
  expectedDeliverables: readonly string[],
): DeliverableRegistryEntry {
  if (typeof taskType !== 'string' || !taskType.trim()) throw new Error('task type must be a non-empty string');
  const selected = validateSelectedResources(resolveTaskMapping(validatedEntries(), taskType));
  assertExpectedDeliverableCompatibility(selected, expectedDeliverables, true);
  return selected;
}

export function resolveExecutionDeliverable(
  taskType: string,
  expectedDeliverables: readonly string[],
  declaredDeliverableId: string,
): DeliverableRegistryEntry {
  if (typeof taskType !== 'string' || !taskType.trim()) throw new Error('task type must be a non-empty string');
  const entries = validatedEntries();
  const mapped = entries.some((entry) => entry.task_types.includes(taskType));
  const declared = resolveActiveDeliverableId(entries, declaredDeliverableId);
  const declaredIsExpected = [
    declared.id,
    ...(declared.aliases ?? []),
    ...(declared.id === 'research_plan' ? ['research plan'] : []),
  ].some((value) => expectedDeliverables.includes(value));
  const selected = declaredIsExpected
    ? declared
    : mapped
      ? resolveTaskMapping(entries, taskType)
      : declared;
  const validated = validateSelectedResources(selected);
  assertExpectedDeliverableCompatibility(validated, expectedDeliverables, mapped && validated.id === 'research_plan');
  return validated;
}

function contractResources(
  entry: DeliverableRegistryEntry,
  selectedTaskType?: string,
): DeliverableContractResources {
  const payloadSchemaPath = safeResourcePath(entry.payload_schema, 'payload_schema');
  const readablePayloadSchemas = (entry.read_payload_schemas ?? [entry.payload_schema]).map((relativePath) => {
    const path = safeResourcePath(relativePath, 'read_payload_schemas');
    return { path, schema: parseJsonObject(path, 'read_payload_schemas') };
  });
  const synthesisPromptPath = safeResourcePath(entry.synthesis_prompt, 'synthesis_prompt');
  const reviewRubricPath = safeResourcePath(entry.review_rubric, 'review_rubric');
  const matchingPolicies = loadEvidencePolicy().policies.filter((policy) => (
    policy.deliverable_type === entry.id
    && (selectedTaskType === undefined
      ? entry.task_types.includes(policy.task_type)
      : policy.task_type === selectedTaskType)
  ));
  if (matchingPolicies.length !== 1) {
    throw new Error(`evidence_policy for ${entry.id} and task ${selectedTaskType ?? '(mapped task)'} must resolve exactly once`);
  }
  const evidencePolicy = matchingPolicies[0]!;
  if (
    (selectedTaskType === undefined || entry.task_types.includes(selectedTaskType))
    && !evidencePolicy.requirements.some((requirement) => requirement.id === entry.evidence_policy)
  ) {
    throw new Error(`evidence_policy "${entry.evidence_policy}" must select an exact requirement in ${entry.id}`);
  }
  return {
    entry,
    payloadSchemaPath,
    payloadSchema: parseJsonObject(payloadSchemaPath, 'payload_schema'),
    readablePayloadSchemas,
    synthesisMode: entry.synthesis_mode ?? 'model_synthesis',
    synthesisPromptPath,
    synthesisPrompt: readFileSync(synthesisPromptPath, 'utf8'),
    reviewRubricPath,
    reviewRubric: parseReviewRubric(reviewRubricPath),
    evidencePolicy,
    reportTemplate: loadReportTemplate(entry.report_template),
  };
}

function declaredPayloadSchemaVersion(schema: object): string | null {
  const properties = isRecord(schema) ? schema.properties : undefined;
  const schemaVersion = isRecord(properties) ? properties.schemaVersion : undefined;
  const version = isRecord(schemaVersion) ? schemaVersion.const : undefined;
  return typeof version === 'string' && version.trim() ? version : null;
}

export function selectReadablePayloadSchema(
  contract: DeliverableContractResources,
  payload: unknown,
): { path: string; schema: object } {
  const declaredVersion = isRecord(payload) && typeof payload.schemaVersion === 'string'
    ? payload.schemaVersion
    : null;
  const matching = contract.readablePayloadSchemas.filter(({ schema }) => (
    declaredPayloadSchemaVersion(schema) === declaredVersion
  ));
  if (matching.length === 1) return matching[0]!;
  if (declaredVersion === null && contract.readablePayloadSchemas.length === 1) {
    return contract.readablePayloadSchemas[0]!;
  }
  throw new Error(
    declaredVersion === null
      ? `deliverable ${contract.entry.id} has no unique legacy payload schema`
      : `deliverable ${contract.entry.id} does not support payload schema version ${declaredVersion}`,
  );
}

export function resolveDeliverableContract(
  taskType: string,
  expectedDeliverables: readonly string[],
): DeliverableContractResources {
  return contractResources(resolveDeliverable(taskType, expectedDeliverables), taskType);
}
export function resolveExecutionDeliverableContract(
  taskType: string,
  expectedDeliverables: readonly string[],
  declaredDeliverableId: string,
): DeliverableContractResources {
  const entry = resolveExecutionDeliverable(taskType, expectedDeliverables, declaredDeliverableId);
  return contractResources(entry, taskType);
}

export function resolveDeliverableCompositionPolicy(
  deliverableId: string,
): DeliverableCompositionPolicy {
  const entry = resolveActiveDeliverableId(validatedEntries(), deliverableId);
  return entry.composition
    ? cloneCompositionPolicy(entry.composition)
    : { mode: 'standalone_compat' };
}

export function resolveDeliverableContractById(deliverableId: string): DeliverableContractResources {
  const entry = resolveActiveDeliverableId(validatedEntries(), deliverableId);
  return contractResources(validateSelectedResources(entry));
}
