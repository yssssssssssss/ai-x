import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  getConfigRoot,
  loadEvidencePolicy,
  loadReportTemplate,
  type EvidencePolicyEntry,
  type ReportTemplateConfig,
} from '../runtime/config-loader.ts';

export interface DeliverableRegistryEntry {
  id: string;
  status: 'active' | 'inactive';
  task_types: string[];
  envelope_version: string;
  payload_schema: string;
  synthesis_prompt: string;
  review_rubric: string;
  evidence_policy: string;
  report_template: string;
}

export interface DeliverableRegistryDiagnostic {
  target: string;
  message: string;
}

export interface DeliverableContractResources {
  entry: DeliverableRegistryEntry;
  payloadSchemaPath: string;
  payloadSchema: object;
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
  'synthesis_prompt',
  'review_rubric',
  'evidence_policy',
  'report_template',
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
    synthesis_prompt: value.synthesis_prompt as string,
    review_rubric: value.review_rubric as string,
    evidence_policy: value.evidence_policy as string,
    report_template: value.report_template as string,
  };
}

function validateActiveResources(entry: DeliverableRegistryEntry, diagnostics: DeliverableRegistryDiagnostic[]): void {
  for (const field of RESOURCE_PATH_FIELDS) validateResourcePath(entry, field, diagnostics);
  const target = `deliverable:${entry.id}`;
  try {
    const policyPath = safeResourcePath(EVIDENCE_POLICY_PATH, 'evidence_policy');
    if (!existsSync(policyPath)) {
      diagnostics.push(diagnostic(target, `evidence_policy resource does not exist: ${EVIDENCE_POLICY_PATH}`));
    } else {
      const policies = loadEvidencePolicy().policies;
      const matchingPolicies = policies.filter((policy) => (
        policy.deliverable_type === entry.id && entry.task_types.includes(policy.task_type)
      ));
      const selectedPolicy = matchingPolicies.find((policy) => (
        policy.requirements.some((requirement) => requirement.id === entry.evidence_policy)
      ));
      if (!selectedPolicy) {
        diagnostics.push(diagnostic(
          target,
          `evidence_policy "${entry.evidence_policy}" is not defined for active task mapping`,
        ));
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

export function inspectDeliverableRegistry(): {
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
  const ids = new Set<string>();
  const taskOwners = new Map<string, string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) diagnostics.push(diagnostic(`deliverable:${entry.id}`, `duplicate deliverable id "${entry.id}"`));
    ids.add(entry.id);
    if (entry.status !== 'active') continue;
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
    validateActiveResources(entry, diagnostics);
  }
  return { entries, diagnostics };
}

function validatedEntries(): DeliverableRegistryEntry[] {
  const inspection = inspectDeliverableRegistry();
  if (inspection.diagnostics.length > 0) {
    throw new Error(`Deliverable Registry v2 invalid: ${inspection.diagnostics.map((item) => `${item.target}: ${item.message}`).join('; ')}`);
  }
  return inspection.entries;
}

function normalizedExpectedDeliverable(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function assertExpectedDeliverableCompatibility(
  entry: DeliverableRegistryEntry,
  expectedDeliverables: readonly string[],
): void {
  if (!Array.isArray(expectedDeliverables) || expectedDeliverables.length === 0) {
    throw new Error(`deliverable ${entry.id} is incompatible with empty expectedDeliverables`);
  }
  if (expectedDeliverables.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('expectedDeliverables must contain non-empty strings');
  }
  const expectedId = normalizedExpectedDeliverable(entry.id);
  const comparableLabels = expectedDeliverables.map(normalizedExpectedDeliverable).filter(Boolean);
  const hasLocalizedLabel = expectedDeliverables.some((value) => (
    normalizedExpectedDeliverable(value) === '' && /[\p{L}\p{N}]/u.test(value)
  ));
  if (
    !hasLocalizedLabel
    && !comparableLabels.some((label) => label === expectedId || label.includes(expectedId) || expectedId.includes(label))
  ) {
    throw new Error(`deliverable ${entry.id} is incompatible with expectedDeliverables`);
  }
}

function resolveTaskMapping(
  entries: readonly DeliverableRegistryEntry[],
  taskType: string,
  expectedDeliverables: readonly string[],
): DeliverableRegistryEntry {
  const mapped = entries.filter((entry) => entry.task_types.includes(taskType));
  const active = mapped.filter((entry) => entry.status === 'active');
  if (active.length === 0) {
    if (mapped.length > 0) throw new Error(`task type "${taskType}" is mapped only to an inactive deliverable`);
    throw new Error(`unsupported task type "${taskType}": no active deliverable is mapped`);
  }
  if (active.length > 1) throw new Error(`duplicate active task mapping for "${taskType}"`);
  const selected = active[0]!;
  assertExpectedDeliverableCompatibility(selected, expectedDeliverables);
  return { ...selected, task_types: [...selected.task_types] };
}

function resolveActiveDeliverableId(
  entries: readonly DeliverableRegistryEntry[],
  deliverableId: string,
  expectedDeliverables?: readonly string[],
): DeliverableRegistryEntry {
  const matching = entries.filter((entry) => entry.id === deliverableId);
  const active = matching.filter((entry) => entry.status === 'active');
  if (active.length === 0) {
    if (matching.length > 0) throw new Error(`deliverable "${deliverableId}" is inactive`);
    throw new Error(`unsupported deliverable "${deliverableId}"`);
  }
  if (active.length > 1) throw new Error(`duplicate active deliverable id "${deliverableId}"`);
  const selected = active[0]!;
  if (expectedDeliverables) assertExpectedDeliverableCompatibility(selected, expectedDeliverables);
  return { ...selected, task_types: [...selected.task_types] };
}

export function resolveDeliverable(
  taskType: string,
  expectedDeliverables: readonly string[],
): DeliverableRegistryEntry {
  if (typeof taskType !== 'string' || !taskType.trim()) throw new Error('task type must be a non-empty string');
  return resolveTaskMapping(validatedEntries(), taskType, expectedDeliverables);
}

export function resolveExecutionDeliverable(
  taskType: string,
  expectedDeliverables: readonly string[],
  declaredDeliverableId: string,
): DeliverableRegistryEntry {
  if (typeof taskType !== 'string' || !taskType.trim()) throw new Error('task type must be a non-empty string');
  const entries = validatedEntries();
  if (entries.some((entry) => entry.task_types.includes(taskType))) {
    return resolveTaskMapping(entries, taskType, expectedDeliverables);
  }
  return resolveActiveDeliverableId(entries, declaredDeliverableId, expectedDeliverables);
}

function contractResources(entry: DeliverableRegistryEntry): DeliverableContractResources {
  const payloadSchemaPath = safeResourcePath(entry.payload_schema, 'payload_schema');
  const synthesisPromptPath = safeResourcePath(entry.synthesis_prompt, 'synthesis_prompt');
  const reviewRubricPath = safeResourcePath(entry.review_rubric, 'review_rubric');
  const evidencePolicy = loadEvidencePolicy().policies.find((policy) => (
    policy.deliverable_type === entry.id
    && entry.task_types.includes(policy.task_type)
    && policy.requirements.some((requirement) => requirement.id === entry.evidence_policy)
  ));
  if (!evidencePolicy) throw new Error(`evidence_policy "${entry.evidence_policy}" is unavailable for ${entry.id}`);
  return {
    entry,
    payloadSchemaPath,
    payloadSchema: parseJsonObject(payloadSchemaPath, 'payload_schema'),
    synthesisPromptPath,
    synthesisPrompt: readFileSync(synthesisPromptPath, 'utf8'),
    reviewRubricPath,
    reviewRubric: parseReviewRubric(reviewRubricPath),
    evidencePolicy,
    reportTemplate: loadReportTemplate(entry.report_template),
  };
}

export function resolveDeliverableContract(
  taskType: string,
  expectedDeliverables: readonly string[],
): DeliverableContractResources {
  return contractResources(resolveDeliverable(taskType, expectedDeliverables));
}
export function resolveExecutionDeliverableContract(
  taskType: string,
  expectedDeliverables: readonly string[],
  declaredDeliverableId: string,
): DeliverableContractResources {
  return contractResources(resolveExecutionDeliverable(
    taskType,
    expectedDeliverables,
    declaredDeliverableId,
  ));
}


export function resolveDeliverableContractById(deliverableId: string): DeliverableContractResources {
  return contractResources(resolveActiveDeliverableId(validatedEntries(), deliverableId));
}
