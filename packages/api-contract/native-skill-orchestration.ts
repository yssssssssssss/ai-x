import { createHash } from 'node:crypto';
import type {
  CurrentExecutionPlan,
  CurrentExecutionPlanV3,
  CurrentPlanStep,
} from './research-deliverable.ts';

export const NATIVE_SKILL_EXECUTION_PLAN_VERSION = 'native-skill-execution-plan-v1' as const;
export const NATIVE_SKILL_RESULT_VERSION = 'native-skill-result-v1' as const;
export const NATIVE_FINAL_REPORT_VERSION = 'native-final-report-v1' as const;
export const DEFAULT_REPORT_PROMPT_VERSION = 'default-report-v1' as const;
export const DEFAULT_REPORT_PROMPT = [
  '请基于用户需求和已完成的分析材料生成一份完整的最终报告。',
  '直接回答用户问题，自主决定最合适的章节、数量和顺序；结构清晰，结论优先，表达简洁准确，避免重复。',
  '对适合比较的信息优先使用表格或矩阵；对适合表达流程、关系、层级和优先级的信息优先使用图示。',
  '只有材料中存在可靠、可验证的数据时才能生成数据图表，不得补造数字。',
  '只能使用提供的事实、分析结果、Source ID 和 URL；不得新增来源、事实、数字或提升证据等级。',
  '证据不足的判断必须标记为推断、暂定结论或待验证。',
  '只输出 Markdown，不输出 JavaScript。',
].join('\n');

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
  locator?: string;
  contentHash?: string;
}

export type NativeSkillResultStatus = 'completed' | 'completed_with_gaps' | 'needs_input';
export type CompletedNativeSkillResultStatus = Exclude<NativeSkillResultStatus, 'needs_input'>;
export type NativeOutputFormat = 'markdown' | 'html';

export interface NativeOutput {
  format: NativeOutputFormat;
  content: string;
  contentHash: string;
}

export interface NativeAttachment {
  path: string;
  mediaType: string;
  content: string;
  contentHash: string;
}

export interface NativeSkillResult {
  version: typeof NATIVE_SKILL_RESULT_VERSION;
  skillId: string;
  invocationId: string;
  title: string;
  status: NativeSkillResultStatus;
  primary: NativeOutput;
  attachments: NativeAttachment[];
  sources: SourceReference[];
  gaps: string[];
  missingInputKeys?: string[];
}

export interface NativeFinalReportSkillReference {
  skillId: string;
  invocationId: string;
  status: CompletedNativeSkillResultStatus;
  path: string;
}

export interface NativeFinalReport {
  version: typeof NATIVE_FINAL_REPORT_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  mode: 'single_skill' | 'multi_skill';
  title: string;
  primary: NativeOutput;
  attachments: NativeAttachment[];
  sources: SourceReference[];
  gaps: string[];
  skillResults: NativeFinalReportSkillReference[];
}

export interface FrozenSkillPackageFile {
  path: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
}

export interface FrozenSkillReference {
  source: 'skill_package' | 'knowledge_mount';
  sourceId: string;
  logicalPath: string;
  path: string;
  contentHash: string;
  content: string;
  selectedBy: 'explicit_reference' | 'semantic_retrieval';
}

export type NativeReportPolicy =
  | {
      kind: 'skill_defined';
      outputFormat: NativeOutputFormat;
      instructions: string;
      instructionsHash: string;
    }
  | {
      kind: 'default_llm';
      outputFormat: 'markdown';
      promptVersion: typeof DEFAULT_REPORT_PROMPT_VERSION;
      promptHash: string;
    };

export interface NativeToolBinding {
  capability: string;
  toolId: string;
  required: boolean;
  status: 'bound' | 'needs_binding';
}

export interface NativeSkillRunSpec {
  skill_id: string;
  body: string;
  body_hash: string;
  package_hash: string;
  entry_path: string;
  files: FrozenSkillPackageFile[];
  selected_references: FrozenSkillReference[];
  input_requirements: SkillInputRequirement[];
  input_requirements_hash: string;
  tool_bindings: NativeToolBinding[];
  report_policy: NativeReportPolicy;
}

export interface NativeSkillInvocation {
  invocation_id: string;
  skill_id: string;
  depends_on_invocation_ids: string[];
  step_nos: number[];
  required: boolean;
  failure_policy: 'block' | 'gap';
  run_spec: NativeSkillRunSpec;
}

export interface NativeSkillExecutionPlanV1 extends Omit<
  CurrentExecutionPlan,
  'execution_contract_version' | 'skill_invocations'
> {
  execution_contract_version: typeof NATIVE_SKILL_EXECUTION_PLAN_VERSION;
  mode: 'single_skill' | 'multi_skill';
  skill_invocations: NativeSkillInvocation[];
  final_report_policy: NativeReportPolicy;
  resolved_inputs: ResolvedPlanInputs;
}

export type ReadableExecutionPlan =
  | CurrentExecutionPlan
  | CurrentExecutionPlanV3
  | NativeSkillExecutionPlanV1;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const INPUT_SOURCES = new Set<string>(SKILL_INPUT_SOURCES);
const INPUT_KINDS = new Set<string>(['value', 'visual', 'dataset']);
const REPORT_SOURCE_TYPES = new Set<string>(['user_input', 'knowledge', 'tool_result']);
const NATIVE_SKILL_RESULT_STATUSES = new Set<string>(['completed', 'completed_with_gaps', 'needs_input']);
const COMPLETED_NATIVE_SKILL_RESULT_STATUSES = new Set<string>(['completed', 'completed_with_gaps']);
const MODES = new Set<string>(['single_skill', 'multi_skill']);
const SAFE_REPORT_PATH = /^skill-results\/[A-Za-z0-9][A-Za-z0-9._%+-]*\.json$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const OUTPUT_FORMATS = new Set<string>(['markdown', 'html']);

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

function contentHash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  exactKeys(item, ['id', 'title', 'type'], ['url', 'locator', 'contentHash'], contract, field);
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
    ...(item.locator === undefined ? {} : { locator: nonBlank(item.locator, contract, `${field}.locator`) }),
    ...(item.contentHash === undefined ? {} : { contentHash: hash(item.contentHash, contract, `${field}.contentHash`) }),
  };
}

function parseSourceReferences(value: unknown, contract: string, field: string): SourceReference[] {
  if (!Array.isArray(value)) fail(contract, field);
  const parsed = value.map((item, index) => parseSourceReference(item, contract, `${field}[${index}]`));
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) fail(contract, `${field}.id`);
  return parsed;
}

function safeRelativePath(value: unknown, contract: string, field: string): string {
  const parsed = nonBlank(value, contract, field);
  if (
    parsed.startsWith('/')
    || parsed.includes('\\')
    || parsed.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) fail(contract, field);
  return parsed;
}

function parseNativeOutput(value: unknown, contract: string, field: string): NativeOutput {
  const item = record(value, contract, field);
  exactKeys(item, ['format', 'content', 'contentHash'], [], contract, field);
  if (typeof item.format !== 'string' || !OUTPUT_FORMATS.has(item.format)) fail(contract, `${field}.format`);
  const content = nonBlank(item.content, contract, `${field}.content`);
  const expectedHash = hash(item.contentHash, contract, `${field}.contentHash`);
  if (contentHash(content) !== expectedHash) fail(contract, `${field}.contentHash`);
  return { format: item.format as NativeOutputFormat, content, contentHash: expectedHash };
}

function parseNativeAttachments(value: unknown, contract: string, field: string): NativeAttachment[] {
  if (!Array.isArray(value)) fail(contract, field);
  const parsed = value.map((candidate, index): NativeAttachment => {
    const itemField = `${field}[${index}]`;
    const item = record(candidate, contract, itemField);
    exactKeys(item, ['path', 'mediaType', 'content', 'contentHash'], [], contract, itemField);
    const content = nonBlank(item.content, contract, `${itemField}.content`);
    const expectedHash = hash(item.contentHash, contract, `${itemField}.contentHash`);
    if (contentHash(content) !== expectedHash) fail(contract, `${itemField}.contentHash`);
    const mediaType = nonBlank(item.mediaType, contract, `${itemField}.mediaType`);
    if (mediaType !== 'text/markdown' && mediaType !== 'text/html') {
      fail(contract, `${itemField}.mediaType`);
    }
    return {
      path: safeRelativePath(item.path, contract, `${itemField}.path`),
      mediaType,
      content,
      contentHash: expectedHash,
    };
  });
  if (new Set(parsed.map(({ path }) => path)).size !== parsed.length) fail(contract, `${field}.path`);
  return parsed;
}

export function parseNativeSkillResult(value: unknown): NativeSkillResult {
  const contract = 'NativeSkillResult';
  const root = record(value, contract);
  exactKeys(
    root,
    ['version', 'skillId', 'invocationId', 'title', 'status', 'primary', 'attachments', 'sources', 'gaps'],
    ['missingInputKeys'],
    contract,
    'value',
  );
  if (root.version !== NATIVE_SKILL_RESULT_VERSION) fail(contract, 'version');
  if (typeof root.status !== 'string' || !NATIVE_SKILL_RESULT_STATUSES.has(root.status)) fail(contract, 'status');
  const status = root.status as NativeSkillResultStatus;
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
    version: NATIVE_SKILL_RESULT_VERSION,
    skillId: canonicalId(root.skillId, contract, 'skillId'),
    invocationId: canonicalId(root.invocationId, contract, 'invocationId'),
    title: nonBlank(root.title, contract, 'title'),
    status,
    primary: parseNativeOutput(root.primary, contract, 'primary'),
    attachments: parseNativeAttachments(root.attachments, contract, 'attachments'),
    sources: parseSourceReferences(root.sources, contract, 'sources'),
    gaps,
    ...(missingInputKeys === undefined ? {} : { missingInputKeys }),
  };
}

export function nativeSkillResultPath(invocationId: string): string {
  const encoded = encodeURIComponent(invocationId);
  if (!encoded || encoded.includes('/') || encoded === '.' || encoded === '..') {
    throw new Error('NativeSkillResult invocationId cannot form a safe relative path');
  }
  return `skill-results/${encoded}.json`;
}

export function parseNativeFinalReport(value: unknown): NativeFinalReport {
  const contract = 'NativeFinalReport';
  const root = record(value, contract);
  exactKeys(
    root,
    ['version', 'taskId', 'planVersionId', 'attemptId', 'mode', 'title', 'primary', 'attachments', 'sources', 'gaps', 'skillResults'],
    [],
    contract,
    'value',
  );
  if (root.version !== NATIVE_FINAL_REPORT_VERSION) fail(contract, 'version');
  if (typeof root.mode !== 'string' || !MODES.has(root.mode)) fail(contract, 'mode');
  if (!Array.isArray(root.skillResults) || root.skillResults.length === 0) fail(contract, 'skillResults');
  const skillResults = root.skillResults.map((candidate, index): NativeFinalReportSkillReference => {
    const field = `skillResults[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(item, ['skillId', 'invocationId', 'status', 'path'], [], contract, field);
    if (typeof item.status !== 'string' || !COMPLETED_NATIVE_SKILL_RESULT_STATUSES.has(item.status)) {
      fail(contract, `${field}.status`);
    }
    const path = nonBlank(item.path, contract, `${field}.path`);
    if (!SAFE_REPORT_PATH.test(path)) fail(contract, `${field}.path`);
    return {
      skillId: canonicalId(item.skillId, contract, `${field}.skillId`),
      invocationId: canonicalId(item.invocationId, contract, `${field}.invocationId`),
      status: item.status as CompletedNativeSkillResultStatus,
      path,
    };
  });
  if (new Set(skillResults.map(({ invocationId }) => invocationId)).size !== skillResults.length) {
    fail(contract, 'skillResults.invocationId');
  }
  if (root.mode === 'single_skill' && skillResults.length !== 1) fail(contract, 'skillResults');
  return {
    version: NATIVE_FINAL_REPORT_VERSION,
    taskId: canonicalId(root.taskId, contract, 'taskId'),
    planVersionId: canonicalId(root.planVersionId, contract, 'planVersionId'),
    attemptId: canonicalId(root.attemptId, contract, 'attemptId'),
    mode: root.mode as NativeFinalReport['mode'],
    title: nonBlank(root.title, contract, 'title'),
    primary: parseNativeOutput(root.primary, contract, 'primary'),
    attachments: parseNativeAttachments(root.attachments, contract, 'attachments'),
    sources: parseSourceReferences(root.sources, contract, 'sources'),
    gaps: optionalUniqueStrings(root.gaps, contract, 'gaps'),
    skillResults,
  };
}

function parseNativeReportPolicy(
  value: unknown,
  contract: string,
  field: string,
): NativeReportPolicy {
  const policy = record(value, contract, field);
  if (policy.kind === 'skill_defined') {
    exactKeys(policy, ['kind', 'outputFormat', 'instructions', 'instructionsHash'], [], contract, field);
    if (typeof policy.outputFormat !== 'string' || !OUTPUT_FORMATS.has(policy.outputFormat)) {
      fail(contract, `${field}.outputFormat`);
    }
    const instructions = nonBlank(policy.instructions, contract, `${field}.instructions`);
    const instructionsHash = hash(policy.instructionsHash, contract, `${field}.instructionsHash`);
    if (contentHash(instructions) !== instructionsHash) fail(contract, `${field}.instructionsHash`);
    return {
      kind: 'skill_defined',
      outputFormat: policy.outputFormat as NativeOutputFormat,
      instructions,
      instructionsHash,
    };
  }
  if (policy.kind === 'default_llm') {
    exactKeys(policy, ['kind', 'outputFormat', 'promptVersion', 'promptHash'], [], contract, field);
    if (policy.outputFormat !== 'markdown' || policy.promptVersion !== DEFAULT_REPORT_PROMPT_VERSION) {
      fail(contract, field);
    }
    const promptHash = hash(policy.promptHash, contract, `${field}.promptHash`);
    if (promptHash !== contentHash(DEFAULT_REPORT_PROMPT)) fail(contract, `${field}.promptHash`);
    return {
      kind: 'default_llm',
      outputFormat: 'markdown',
      promptVersion: DEFAULT_REPORT_PROMPT_VERSION,
      promptHash,
    };
  }
  fail(contract, `${field}.kind`);
}

function parseRunSpec(value: unknown, field: string): NativeSkillRunSpec {
  const contract = 'NativeSkillExecutionPlanV1';
  const root = record(value, contract, field);
  exactKeys(
    root,
    ['skill_id', 'body', 'body_hash', 'package_hash', 'entry_path', 'files', 'selected_references', 'input_requirements', 'input_requirements_hash', 'tool_bindings', 'report_policy'],
    [],
    contract,
    field,
  );
  const skillId = canonicalId(root.skill_id, contract, `${field}.skill_id`);
  const body = nonBlank(root.body, contract, `${field}.body`);
  const bodyHash = hash(root.body_hash, contract, `${field}.body_hash`);
  if (contentHash(body) !== bodyHash) fail(contract, `${field}.body_hash`);
  if (!Array.isArray(root.files) || root.files.length === 0) fail(contract, `${field}.files`);
  const files = root.files.map((candidate, index): FrozenSkillPackageFile => {
    const itemField = `${field}.files[${index}]`;
    const item = record(candidate, contract, itemField);
    exactKeys(item, ['path', 'mediaType', 'byteSize', 'contentHash'], [], contract, itemField);
    if (!Number.isInteger(item.byteSize) || Number(item.byteSize) < 0) fail(contract, `${itemField}.byteSize`);
    return {
      path: safeRelativePath(item.path, contract, `${itemField}.path`),
      mediaType: nonBlank(item.mediaType, contract, `${itemField}.mediaType`),
      byteSize: Number(item.byteSize),
      contentHash: hash(item.contentHash, contract, `${itemField}.contentHash`),
    };
  });
  if (new Set(files.map(({ path }) => path)).size !== files.length) fail(contract, `${field}.files.path`);
  const sortedFiles = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (JSON.stringify(files) !== JSON.stringify(sortedFiles)) fail(contract, `${field}.files.order`);
  const packageHash = hash(root.package_hash, contract, `${field}.package_hash`);
  const manifest = files.map(({ path, mediaType, byteSize, contentHash }) => (
    `${path}\0${mediaType}\0${byteSize}\0${contentHash}\n`
  )).join('');
  if (contentHash(manifest) !== packageHash) fail(contract, `${field}.package_hash`);
  const entryPath = safeRelativePath(root.entry_path, contract, `${field}.entry_path`);
  const entryFile = files.find(({ path }) => path === entryPath);
  if (!entryFile || entryFile.contentHash !== bodyHash) fail(contract, `${field}.entry_path`);
  if (!Array.isArray(root.selected_references)) fail(contract, `${field}.selected_references`);
  const selectedReferences = root.selected_references.map((candidate, index): FrozenSkillReference => {
    const itemField = `${field}.selected_references[${index}]`;
    const item = record(candidate, contract, itemField);
    exactKeys(item, ['source', 'sourceId', 'logicalPath', 'path', 'contentHash', 'content', 'selectedBy'], [], contract, itemField);
    const path = safeRelativePath(item.path, contract, `${itemField}.path`);
    const content = nonBlank(item.content, contract, `${itemField}.content`);
    const referenceHash = hash(item.contentHash, contract, `${itemField}.contentHash`);
    if (contentHash(content) !== referenceHash) fail(contract, `${itemField}.contentHash`);
    const source = item.source;
    if (source !== 'skill_package' && source !== 'knowledge_mount') fail(contract, `${itemField}.source`);
    const sourceId = canonicalId(item.sourceId, contract, `${itemField}.sourceId`);
    const file = files.find((candidateFile) => candidateFile.path === path);
    if (source === 'skill_package' && (!file || file.contentHash !== referenceHash || sourceId !== skillId)) {
      fail(contract, `${itemField}.path`);
    }
    if (item.selectedBy !== 'explicit_reference' && item.selectedBy !== 'semantic_retrieval') {
      fail(contract, `${itemField}.selectedBy`);
    }
    const logicalPath = nonBlank(item.logicalPath, contract, `${itemField}.logicalPath`);
    const expectedLogicalPath = source === 'skill_package'
      ? `skill://${skillId}/${path}`
      : `knowledge://${sourceId}/${path}`;
    if (logicalPath !== expectedLogicalPath) fail(contract, `${itemField}.logicalPath`);
    return {
      source,
      sourceId,
      logicalPath,
      path,
      contentHash: referenceHash,
      content,
      selectedBy: item.selectedBy,
    };
  });
  if (new Set(selectedReferences.map(({ sourceId, path }) => `${sourceId}\0${path}`)).size !== selectedReferences.length) {
    fail(contract, `${field}.selected_references.path`);
  }
  if (!Array.isArray(root.tool_bindings)) fail(contract, `${field}.tool_bindings`);
  const toolBindings = root.tool_bindings.map((candidate, index): NativeToolBinding => {
    const itemField = `${field}.tool_bindings[${index}]`;
    const item = record(candidate, contract, itemField);
    exactKeys(item, ['capability', 'toolId', 'required', 'status'], [], contract, itemField);
    if (typeof item.required !== 'boolean') fail(contract, `${itemField}.required`);
    if (item.status !== 'bound' && item.status !== 'needs_binding') fail(contract, `${itemField}.status`);
    return {
      capability: canonicalId(item.capability, contract, `${itemField}.capability`),
      toolId: canonicalId(item.toolId, contract, `${itemField}.toolId`),
      required: item.required,
      status: item.status,
    };
  });
  if (new Set(toolBindings.map(({ capability }) => capability)).size !== toolBindings.length) {
    fail(contract, `${field}.tool_bindings.capability`);
  }
  const reportPolicy = parseNativeReportPolicy(root.report_policy, contract, `${field}.report_policy`);
  return {
    skill_id: skillId,
    body,
    body_hash: bodyHash,
    package_hash: packageHash,
    entry_path: entryPath,
    files,
    selected_references: selectedReferences,
    input_requirements: parseSkillInputRequirements(root.input_requirements),
    input_requirements_hash: hash(root.input_requirements_hash, contract, `${field}.input_requirements_hash`),
    tool_bindings: toolBindings,
    report_policy: reportPolicy,
  };
}

export function isNativeSkillExecutionPlanV1(value: unknown): value is NativeSkillExecutionPlanV1 {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).execution_contract_version === NATIVE_SKILL_EXECUTION_PLAN_VERSION;
}

export function parseNativeSkillExecutionPlanV1(value: unknown): NativeSkillExecutionPlanV1 {
  const contract = 'NativeSkillExecutionPlanV1';
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
    'final_report_policy',
    'resolved_inputs',
  ], ['capability_gaps', 'planning_provenance'], contract, 'value');
  if (root.execution_contract_version !== NATIVE_SKILL_EXECUTION_PLAN_VERSION) fail(contract, 'execution_contract_version');
  if (typeof root.mode !== 'string' || !MODES.has(root.mode)) fail(contract, 'mode');
  canonicalId(root.task_id, contract, 'task_id');
  nonBlank(root.deliverable_type, contract, 'deliverable_type');
  if (!Array.isArray(root.steps) || root.steps.length === 0) fail(contract, 'steps');
  if (!Array.isArray(root.skill_invocations) || root.skill_invocations.length === 0) fail(contract, 'skill_invocations');
  const invocations = root.skill_invocations.map((candidate, index): NativeSkillInvocation => {
    const field = `skill_invocations[${index}]`;
    const item = record(candidate, contract, field);
    exactKeys(
      item,
      ['invocation_id', 'skill_id', 'depends_on_invocation_ids', 'step_nos', 'required', 'failure_policy', 'run_spec'],
      [],
      contract,
      field,
    );
    if (!Array.isArray(item.step_nos) || item.step_nos.length === 0 || !item.step_nos.every((step) => Number.isInteger(step) && Number(step) > 0)) {
      fail(contract, `${field}.step_nos`);
    }
    if (new Set(item.step_nos).size !== item.step_nos.length) fail(contract, `${field}.step_nos`);
    if (item.failure_policy !== 'block' && item.failure_policy !== 'gap') fail(contract, `${field}.failure_policy`);
    const runSpec = parseRunSpec(item.run_spec, `${field}.run_spec`);
    const skillId = canonicalId(item.skill_id, contract, `${field}.skill_id`);
    if (runSpec.skill_id !== skillId) fail(contract, `${field}.run_spec.skill_id`);
    return {
      invocation_id: canonicalId(item.invocation_id, contract, `${field}.invocation_id`),
      skill_id: skillId,
      depends_on_invocation_ids: optionalUniqueStrings(item.depends_on_invocation_ids, contract, `${field}.depends_on_invocation_ids`)
        .map((id, dependencyIndex) => canonicalId(id, contract, `${field}.depends_on_invocation_ids[${dependencyIndex}]`)),
      step_nos: item.step_nos as number[],
      required: boolean(item.required, contract, `${field}.required`),
      failure_policy: item.failure_policy,
      run_spec: runSpec,
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
    for (const requirement of invocation.run_spec.input_requirements) {
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
  const finalReportPolicy = parseNativeReportPolicy(
    root.final_report_policy,
    contract,
    'final_report_policy',
  );
  return {
    ...(structuredClone(root) as unknown as NativeSkillExecutionPlanV1),
    skill_invocations: invocations,
    final_report_policy: finalReportPolicy,
    resolved_inputs: resolvedInputs,
    steps,
  };
}
