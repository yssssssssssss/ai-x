import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Ajv from 'ajv';
import YAML from 'yaml';

import { InstalledSkillCatalog } from '../apps/orchestrator-runtime/src/runtime/installed-skill-catalog.ts';
import {
  buildHubContentApply,
  checkAppliedHubContent,
  writeHubContentApply,
} from './user-research-hub-content.ts';

const LOGICAL_ROOT = 'wiki/user-research';
const SNAPSHOT_ID = 'user-research-hub-2026-08-21';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LOCAL_HOME_TRANSFORM = 'quote-local-home-frontmatter-v1';
const PROFILE_IDS = ['speed', 'depth', 'breadth', 'focused', 'mixed_method', 'decision', 'remediation'] as const;
const DIMENSIONS = ['scope', 'method', 'evidence', 'review', 'output_emphasis'] as const;
const REGISTRY_CONFIG = [
  { kind: 'case', path: '05-registry-索引/case-registry.yaml' },
  { kind: 'domain', path: '05-registry-索引/domain-registry.yaml' },
  { kind: 'knowledge', path: '05-registry-索引/knowledge-registry.yaml' },
  { kind: 'skill', path: '05-registry-索引/skill-registry.yaml' },
  { kind: 'task', path: '05-registry-索引/task-registry.yaml' },
] as const;

type RegistryKind = (typeof REGISTRY_CONFIG)[number]['kind'];
export type Disposition = 'map_existing' | 'merge_into_existing' | 'import_candidate' | 'source_only' | 'reject_runtime';
type ProfileId = (typeof PROFILE_IDS)[number];
type DifferenceDimension = (typeof DIMENSIONS)[number];

export interface ScannedFile {
  path: string;
  node_type: 'regular';
  size_bytes: number;
  sha256: string;
  executable: boolean;
  media_type: string;
  frontmatter: {
    status: 'valid' | 'absent' | 'known_invalid' | 'not_applicable';
    transform_rule_id: string | null;
  };
}

interface SourceEntity extends Record<string, unknown> {
  id: string;
  source_path: string;
  status: string;
}
interface SourceRegistry {
  kind: RegistryKind;
  path: string;
  sha256: string;
  entities: SourceEntity[];
}
export interface HubScan {
  files: ScannedFile[];
  registries: SourceRegistry[];
  upstreamManifest: Record<string, unknown> | null;
  upstreamObservations: {
    agentSkillEntryCount: number | null;
  };
}
interface ManifestTarget {
  canonical_id: string;
  path: string;
  status: 'existing' | 'candidate' | 'approved';
}
export interface ManifestGovernance {
  sensitivity: 'public' | 'internal' | 'restricted' | 'unknown';
  distribution_scope: 'internal_repository' | 'evaluation_only' | 'source_archive_only';
  owner: string;
  retention: string;
  source_rights: 'cleared_public_reuse' | 'cleared_internal_reuse' | 'restricted' | 'unknown';
  review_status: 'complete' | 'review_required' | 'blocked';
  scans: Record<'secrets' | 'pii' | 'local_paths' | 'internal_business_facts', 'clear' | 'reviewed' | 'review_required' | 'blocked'>;
  finding_refs: string[];
}
export interface ManifestEntity {
  key: string;
  registry_kind: RegistryKind;
  registry_path: string;
  id: string;
  entity_type: string;
  source_status: string;
  source_path: string;
  disposition: Disposition;
  rationale: string;
  mapping_basis: string | null;
  target?: ManifestTarget;
  merge_sections: string[];
  governance?: ManifestGovernance;
  coalescence_group_id?: string;
}
interface AttachmentGroup {
  id: string;
  owner_refs: string[];
  disposition: 'source_only' | 'reject_runtime';
  rationale: string;
}
type FileCoverage =
  | { kind: 'entity'; entity_ref: string }
  | { kind: 'attachment'; attachment_group_ref: string }
  | { kind: 'orphan'; disposition: 'source_only' | 'reject_runtime'; reason: string };
interface ManifestFile extends ScannedFile { coverage: FileCoverage }

export interface HubManifest {
  schema_version: 1;
  snapshot_id: string;
  logical_root: string;
  hash_spec: {
    algorithm: 'sha256'; leaf_input: 'raw-bytes'; tree_input: 'canonical-ndjson-v1';
    disposition_input: 'canonical-json-v1'; path_encoding: 'utf8-nfc-posix';
  };
  snapshot: {
    file_count: number; byte_count: number; tree_hash: string;
    source_sync: { path: string; file_count: number; byte_count: number; tree_hash: string };
    organized: { file_count: number; byte_count: number; tree_hash: string };
  };
  upstream_manifest: {
    path: string; sha256: string;
    declared_count_checks: Array<{
      key: string; declared: number; observed: number; status: 'match' | 'mismatch'; reason: string;
    }>;
  };
  registries: Array<{ kind: RegistryKind; path: string; sha256: string; entity_count: number }>;
  known_transforms: Array<{
    id: string; applies_to: string; source_pattern: string; affected_count: number; affected_paths_hash: string;
  }>;
  gate_1: {
    status: 'ready' | 'review_required' | 'blocked';
    facts: Array<{
      id: string;
      category: 'source_integrity' | 'governance' | 'release_boundary' | 'source_availability';
      status: 'accepted' | 'review_required' | 'blocked';
      statement: string;
      decision_required: string;
    }>;
  };
  entities: ManifestEntity[];
  attachment_groups: AttachmentGroup[];
  files: ManifestFile[];
  disposition_hash: string;
}

interface ProfileSpec {
  id: ProfileId; ordinal: number; kind: 'baseline' | 'specialty'; display_name: string; max_steps: number;
  dimensions: {
    scope: string; method: string; evidence: string; review: string; output_emphasis: string[];
  };
  required_difference_dimensions: DifferenceDimension[];
}
interface ScenarioProfileMapping {
  scenario_id: string; source_entity_id: string; source_path: string; source_sha256: string; parent_task_id: string;
  candidate_profiles: ProfileId[];
  specialty_assessments: Array<{
    profile_id: ProfileId; catalog_support: 'supported' | 'conditional' | 'gap'; reason_codes: string[];
  }>;
}
export interface ProfileDraft {
  schema_version: 'phase-a-profile-feasibility-v1'; status: 'draft'; runtime_consumed: false; review_gate: 'gate-2';
  catalog_snapshot_hash: string;
  dimension_order: DifferenceDimension[];
  profile_order: ProfileId[];
  candidate_contract: {
    min_items: 2; max_items: 4; baseline_profile_ids: ['speed', 'depth']; legacy_runtime_order: ['depth', 'speed'];
    deterministic_control: string; invariant_ids: string[];
  };
  profile_specs: ProfileSpec[];
  scenario_profile_mappings: ScenarioProfileMapping[];
}
interface DistinctnessRow {
  scenarioId: string; sourcePath: string; specialtyProfileId: ProfileId; baselineProfileId: 'speed' | 'depth';
  requiredBySpecialty: DifferenceDimension[]; requiredByBaseline: DifferenceDimension[];
  differentDimensions: DifferenceDimension[]; specialtyRequirementMet: boolean; baselineRequirementMet: boolean;
  invariantResults: {
    allRequiredQuestions: 'declared'; allRequiredEvidence: 'declared';
    allRequestedDeliverables: 'declared'; safetyPolicyUnchanged: 'declared';
  };
  specVerdict: 'pass' | 'fail'; catalogSupport: 'supported' | 'conditional' | 'gap'; reasonCodes: string[];
}
export interface DistinctnessReport {
  formatVersion: 'profile-spec-distinctness-v2'; runtimeClaim: 'static-spec-contract-only';
  inputs: { profileSpecsSha256: string; scenarioMappingsSha256: string; capabilityRegistrySha256: string };
  dimensionOrder: DifferenceDimension[]; baselineOrder: ['speed', 'depth'];
  summary: {
    scenarioCount: number; mappedScenarioCount: number; specialtyBindingCount: number;
    baselineComparisonCount: number; specPassCount: number; specFailCount: number;
    catalogSupportedCount: number; catalogConditionalCount: number; catalogGapCount: number;
  };
  rows: DistinctnessRow[];
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([key, child]) => [key, stableValue(child)]));
}
function canonicalHash(value: unknown): string { return sha256Bytes(JSON.stringify(stableValue(value))); }
function pathListHash(paths: readonly string[]): string {
  return sha256Bytes(paths.slice().sort(compareUtf8).map((path) => `${path}\n`).join(''));
}
function assertLogicalPath(path: string, field: string): void {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
    || path !== path.normalize('NFC')) {
    throw new Error(`${field} is not a normalized relative POSIX NFC path: ${path}`);
  }
}
function mediaType(path: string): string {
  const known: Record<string, string> = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
    '.ts': 'text/typescript', '.tsx': 'text/typescript', '.css': 'text/css', '.html': 'text/html',
    '.htm': 'text/html', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.command': 'text/x-shellscript', '.sh': 'text/x-shellscript', '.py': 'text/x-python', '.java': 'text/x-java-source',
  };
  return known[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
function frontmatterStatus(path: string, bytes: Buffer): ScannedFile['frontmatter'] {
  if (path.startsWith('00-source-sync/') || extname(path).toLowerCase() !== '.md') {
    return { status: 'not_applicable', transform_rule_id: null };
  }
  const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return { status: 'absent', transform_rule_id: null };
  try {
    YAML.parse(match[1]!);
    return { status: 'valid', transform_rule_id: null };
  } catch (error) {
    if (match[1]!.includes('[LOCAL_HOME]/')) {
      return { status: 'known_invalid', transform_rule_id: LOCAL_HOME_TRANSFORM };
    }
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`unknown frontmatter parse failure in ${path}: ${message}`);
  }
}
function readRegistries(root: string, files: readonly ScannedFile[]): SourceRegistry[] {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  return REGISTRY_CONFIG.flatMap(({ kind, path }) => {
    const file = fileByPath.get(path);
    if (!file) return [];
    const parsed = YAML.parse(readFileSync(join(root, ...path.split('/')), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`registry ${path} must be a YAML array`);
    const entities = parsed.map((value, index) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`registry ${path}[${index}] must be an object`);
      }
      const entity = value as SourceEntity;
      if (typeof entity.id !== 'string' || entity.id.trim() === ''
        || typeof entity.source_path !== 'string' || typeof entity.status !== 'string') {
        throw new Error(`registry ${path}[${index}] lacks id, source_path, or status`);
      }
      assertLogicalPath(entity.source_path, `${path}[${index}].source_path`);
      return entity;
    });
    return [{ kind, path, sha256: file.sha256, entities }];
  });
}

export function scanHub(sourceRoot: string): HubScan {
  if (typeof sourceRoot !== 'string' || sourceRoot.trim() === '') throw new Error('--source is required');
  const requestedRoot = resolve(sourceRoot);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
    throw new Error(`Hub source does not exist or is not a directory: ${sourceRoot}`);
  }
  const root = realpathSync(requestedRoot);
  const files: ScannedFile[] = [];
  const normalizedPaths = new Set<string>();
  const caseFoldedPaths = new Map<string, string>();
  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.includes('\\')) {
        throw new Error(`source name contains a backslash: ${entry.name}`);
      }
      const rawLogicalPath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const logicalPath = rawLogicalPath.normalize('NFC');
      assertLogicalPath(logicalPath, 'source path');
      const absolutePath = join(absoluteDirectory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error(`source symlink is not allowed: ${logicalPath}`);
      if (metadata.isDirectory()) { walk(absolutePath, logicalPath); continue; }
      if (!metadata.isFile()) throw new Error(`special source node is not allowed: ${logicalPath}`);
      const escaped = relative(root, realpathSync(absolutePath));
      if (escaped.startsWith(`..${sep}`) || escaped === '..' || isAbsolute(escaped)) {
        throw new Error(`source path escapes the configured root: ${logicalPath}`);
      }
      if (normalizedPaths.has(logicalPath)) throw new Error(`duplicate normalized path: ${logicalPath}`);
      const folded = logicalPath.toLocaleLowerCase('en-US');
      const priorFolded = caseFoldedPaths.get(folded);
      if (priorFolded && priorFolded !== logicalPath) throw new Error(`case-fold path collision: ${priorFolded} and ${logicalPath}`);
      normalizedPaths.add(logicalPath);
      caseFoldedPaths.set(folded, logicalPath);
      const bytes = readFileSync(absolutePath);
      files.push({
        path: logicalPath, node_type: 'regular', size_bytes: bytes.byteLength, sha256: sha256Bytes(bytes),
        executable: (metadata.mode & 0o111) !== 0, media_type: mediaType(logicalPath),
        frontmatter: frontmatterStatus(logicalPath, bytes),
      });
    }
  };
  walk(root, '');
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const upstreamPath = '00-source-sync/source-sync-manifest.json';
  const upstreamManifest = files.some(({ path }) => path === upstreamPath)
    ? JSON.parse(readFileSync(join(root, ...upstreamPath.split('/')), 'utf8')) as Record<string, unknown>
    : null;
  const agentSkillsDirectory = join(root, '00-source-sync/.agents/skills');
  const agentSkillEntryCount = existsSync(agentSkillsDirectory)
    ? readdirSync(agentSkillsDirectory).length
    : null;
  return {
    files,
    registries: readRegistries(root, files),
    upstreamManifest,
    upstreamObservations: { agentSkillEntryCount },
  };
}

export function hashFiles(files: readonly Pick<ScannedFile, 'path' | 'size_bytes' | 'sha256'>[]): string {
  const leaves = files.map(({ path, size_bytes, sha256 }) => {
    assertLogicalPath(path, 'hash path');
    if (!HASH_PATTERN.test(sha256)) throw new Error(`invalid leaf hash for ${path}`);
    return { path, size_bytes, sha256 };
  }).sort((left, right) => compareUtf8(left.path, right.path));
  return sha256Bytes(leaves.map((leaf) => `${JSON.stringify(leaf)}\n`).join(''));
}
function summarizeFiles(files: readonly ScannedFile[]) {
  return {
    file_count: files.length,
    byte_count: files.reduce((total, file) => total + file.size_bytes, 0),
    tree_hash: hashFiles(files),
  };
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{S}\s]/gu, '');
}
interface CanonicalKnowledge { id: string; title: string; source_path: string; status?: string }
interface CanonicalSkill { id: string; path: string; status?: string }
interface CanonicalContext { knowledge: CanonicalKnowledge[]; skills: CanonicalSkill[] }
const SOURCE_ONLY_METHOD_IDS = new Set([
  'ds-method-competitor-00-module-overview', 'ds-method-competitor-03', 'ds-method-competitor-04',
  'ds-method-strategy-00-module-overview', 'ds-method-strategy-05', 'ds-method-strategy-06',
  'ds-method-user-00-module-overview', 'ds-method-user-01', 'ds-method-user-02',
]);
const EXISTING_ASSET_TARGETS: Readonly<Record<string, string>> = {
  'ur-asset-behavior-habits': 'knowledge-base/assets/question-bank/survey/behavior-habits.md',
  'ur-asset-concept-test': 'knowledge-base/assets/question-bank/survey/concept-test.md',
  'ur-asset-decision-journey': 'knowledge-base/assets/question-bank/survey/decision-journey.md',
  'ur-asset-experience-painpoints': 'knowledge-base/assets/question-bank/survey/experience-painpoints.md',
  'ur-asset-interview-forbidden-questions': 'knowledge-base/assets/question-bank/interview-forbidden-questions.md',
  'ur-asset-mindset-cognition': 'knowledge-base/assets/question-bank/survey/mindset-cognition.md',
  'ur-asset-needs-scenarios': 'knowledge-base/assets/question-bank/survey/needs-scenarios.md',
  'ur-asset-screener-demographics': 'knowledge-base/assets/question-bank/survey/screener-demographics.md',
  'ur-asset-standardized-ux-scales': 'knowledge-base/assets/scales/standardized-ux-scales.md',
  'ur-template-churn-phone-interview-script': 'knowledge-base/assets/templates/churn-phone-interview-script.md',
  'ur-template-churn-survey-framework': 'knowledge-base/assets/templates/churn-survey-framework.md',
  'ur-template-experience-issue-description-script': 'knowledge-base/assets/templates/experience-issue-description-script.md',
  'ur-template-opportunity-solution-tree': 'knowledge-base/assets/templates/opportunity-solution-tree.md',
};
const NOOP_SKILL_IDS = new Set([
  'ur-skill-accessibility-review', 'ur-skill-analyze-satisfaction', 'ur-skill-build-experience-metrics',
  'ur-skill-code-open-feedback', 'ur-skill-competitive-analysis', 'ur-skill-conversion-funnel-analysis',
  'ur-skill-feature-adoption-analysis', 'ur-skill-generate-interview-guide', 'ur-skill-generate-persona',
  'ur-skill-generate-research-plan', 'ur-skill-generate-survey', 'ur-skill-generate-usability-test',
  'ur-skill-issue-prioritization', 'ur-skill-jobs-to-be-done', 'ur-skill-journey-map',
  'ur-skill-run-heuristic-evaluation', 'ur-skill-structure-interview-transcript',
  'ur-skill-synthesize-qualitative-insights',
]);
function loadCanonicalContext(repositoryRoot: string): CanonicalContext {
  const knowledge = JSON.parse(readFileSync(join(repositoryRoot, 'knowledge-base/.index/knowledge.json'), 'utf8')) as CanonicalKnowledge[];
  const skills = new InstalledSkillCatalog([
    join(repositoryRoot, 'skills'),
    join(repositoryRoot, 'knowledge-base/skills'),
  ]).scan().skills.map((skill) => ({
    id: skill.id,
    path: relative(repositoryRoot, skill.package.rootPath),
    status: skill.readiness === 'ready' ? 'active' : 'draft',
  }));
  return { knowledge, skills };
}
export function createCanonicalCatalog(repositoryRoot: string): ReadonlySet<string> {
  const context = loadCanonicalContext(repositoryRoot);
  return new Set([
    ...context.knowledge.filter(({ status }) => status !== 'candidate').map(({ source_path }) => `knowledge-base/${source_path}`),
    ...context.skills.filter(({ status }) => status !== 'draft').map(({ path }) => path),
    ...Object.values(EXISTING_ASSET_TARGETS),
  ]);
}
function governance(_owner: unknown): ManifestGovernance {
  return {
    sensitivity: 'internal', distribution_scope: 'evaluation_only',
    owner: 'user-research-hub-maintainers',
    retention: 'through-gate-3-or-revocation', source_rights: 'cleared_internal_reuse', review_status: 'review_required',
    scans: { secrets: 'review_required', pii: 'review_required', local_paths: 'review_required', internal_business_facts: 'review_required' },
    finding_refs: ['gate-1-internal-evaluation-only'],
  };
}
function entityType(kind: RegistryKind, source: SourceEntity): string {
  if (kind === 'task' && typeof source.level === 'string') return source.level;
  if (typeof source.type === 'string') return source.type;
  return kind;
}
function manifestEntity(registry: SourceRegistry, source: SourceEntity, context: CanonicalContext): ManifestEntity {
  const base = {
    key: `${registry.kind}:${source.id}`, registry_kind: registry.kind, registry_path: registry.path,
    id: source.id, entity_type: entityType(registry.kind, source), source_status: source.status,
    source_path: source.source_path,
  };
  if (registry.kind === 'knowledge') {
    const canonicalKnowledge = context.knowledge.filter(({ status }) => status !== 'candidate');
    const explicit = source.id === 'ur-method-methods-scenarios-product-experience-iteration-continuous-discovery'
      ? canonicalKnowledge.find(({ id }) => id === 'scenario_continuous_discovery') : undefined;
    const normalizedMatches = explicit || typeof source.title !== 'string' ? []
      : canonicalKnowledge.filter((entry) => normalizeTitle(entry.title) === normalizeTitle(source.title as string));
    const existing = explicit ?? (normalizedMatches.length === 1 ? normalizedMatches[0] : undefined);
    if (existing) return {
      ...base, disposition: 'map_existing',
      rationale: 'Current Knowledge Base already contains the canonical entry; retain this source as provenance only.',
      mapping_basis: explicit ? 'explicit_continuous_discovery' : 'normalized_title',
      target: { canonical_id: existing.id, path: `knowledge-base/${existing.source_path}`, status: 'existing' },
      merge_sections: [],
    };
    if (source.type === 'method') {
      if (SOURCE_ONLY_METHOD_IDS.has(source.id)) return {
        ...base, disposition: 'source_only',
        rationale: 'Navigation or multi-method omnibus source is retained for audit/coalescence and is not a recallable canonical method.',
        mapping_basis: 'gate_2_method_coalescence', merge_sections: [],
      };
      return {
        ...base, disposition: 'import_candidate',
        rationale: 'Reviewed single-method content remains a Phase-B candidate until Gate-3 promotion.',
        mapping_basis: 'gate_2_single_method_candidate',
        target: { canonical_id: source.id, path: `knowledge-base/methods/toolbox/analysis/design-strategy/${source.id}.md`, status: 'candidate' },
        merge_sections: [], governance: governance(source.owner),
      };
    }
    if (source.type === 'template') {
      const existingAsset = EXISTING_ASSET_TARGETS[source.id];
      if (existingAsset) return {
        ...base, disposition: 'map_existing',
        rationale: 'Gate-2 review identified an existing canonical Asset; retain the Hub row as provenance without a duplicate candidate.',
        mapping_basis: 'gate_2_existing_asset',
        target: { canonical_id: source.id.replace(/^ur-(?:asset|template)-/u, ''), path: existingAsset, status: 'existing' },
        merge_sections: [],
      };
      return {
        ...base, disposition: 'import_candidate',
        rationale: 'Unique design-strategy case-card template is retained as an evaluation-only candidate.',
        mapping_basis: 'gate_2_unique_template_candidate',
        target: { canonical_id: source.id, path: `knowledge-base/assets/templates/${source.id}.md`, status: 'candidate' },
        merge_sections: [], governance: governance(source.owner),
      };
    }
    return {
      ...base, disposition: 'source_only',
      rationale: source.type === 'domain-knowledge'
        ? 'Project-specific domain facts require date, scope, rights, and abstraction review before reuse.'
        : 'Mechanism content remains source-only until semantic comparison with current policy truth sources.',
      mapping_basis: `registry_type_${String(source.type ?? 'knowledge')}`, merge_sections: [],
    };
  }
  if (registry.kind === 'skill') {
    const slug = source.id.startsWith('ur-skill-') ? source.id.slice('ur-skill-'.length) : '';
    const exact = context.skills.find(({ id }) => id === slug);
    const semanticTargets: Record<string, string> = {
      'ds-skill-competitor-strategy-analysis': 'competitive-analysis',
      'ds-skill-user-insight-synthesis': 'synthesize-qualitative-insights',
      'ds-skill-trend-change-scan': 'competitive-web-research',
      'ur-skill-experience-walkthrough': 'run-heuristic-evaluation',
    };
    const targetId = exact?.id ?? semanticTargets[source.id];
    const target = context.skills.find(({ id }) => id === targetId);
    if (target) {
      if (NOOP_SKILL_IDS.has(source.id)) return {
        ...base, disposition: 'map_existing',
        rationale: 'Gate-2 review confirmed the Hub body already exists in the canonical Skill or its references; no merge draft is needed.',
        mapping_basis: 'gate_2_skill_noop',
        target: { canonical_id: target.id, path: target.path, status: 'existing' },
        merge_sections: [],
      };
      if (source.id === 'ds-skill-competitor-strategy-analysis' || source.id === 'ds-skill-user-insight-synthesis') return {
        ...base, disposition: 'reject_runtime',
        rationale: 'Gate-2 review rejected the generic duplicate Skill body; source remains available only in the Hub snapshot.',
        mapping_basis: 'gate_2_generic_skill_reject', merge_sections: [],
      };
      return {
        ...base, disposition: 'merge_into_existing',
        rationale: 'Gate-2 approved only a narrow trigger/evidence/fallback/confirmation delta; the canonical Skill contract remains authoritative.',
        mapping_basis: 'gate_2_narrow_skill_delta',
        target: { canonical_id: target.id, path: target.path, status: 'existing' },
        merge_sections: source.id === 'ds-skill-trend-change-scan'
          ? ['when_to_use', 'evidence_boundary', 'fallback', 'human_confirmation']
          : ['when_to_use', 'scope', 'evidence_location', 'confidence', 'human_confirmation'],
        governance: governance(source.owner),
      };
    }
    if (source.id === 'ur-skill-research-screenshot-analyzer') return {
      ...base, disposition: 'reject_runtime',
      rationale: 'The organized entry is a safety note rather than the executable DesignPeek Skill; runtime activation is rejected.',
      mapping_basis: 'plan_reject_runtime', merge_sections: [],
    };
    if (source.id === 'ds-skill-strategy-map-generation') return {
      ...base, disposition: 'reject_runtime',
      rationale: 'Gate-2 review rejected the generic strategy-map Skill candidate; its useful concepts remain in method candidates.',
      mapping_basis: 'gate_2_skill_candidate_reject', merge_sections: [],
    };
    if (source.id === 'ds-skill-solution-generation') {
      const candidateId = 'solution-generation';
      return {
        ...base, disposition: 'import_candidate',
        rationale: 'Gate-2 approved this Skill only as an evaluation-only draft; it remains non-routable with no active contract.',
        mapping_basis: 'plan_draft_skill',
        target: { canonical_id: candidateId, path: `knowledge-base/skills/${candidateId}/SKILL.md`, status: 'candidate' },
        merge_sections: [], governance: governance(source.owner),
      };
    }
    return {
      ...base, disposition: 'source_only',
      rationale: 'No approved canonical Skill target exists; retain source without runtime eligibility.',
      mapping_basis: 'no_approved_target', merge_sections: [],
    };
  }
  if (registry.kind === 'task') {
    if (source.level === 'scenario') return {
      ...base, disposition: 'import_candidate',
      rationale: 'Scenario semantics are a non-runtime Phase-B candidate; this Phase records source identity only.',
      mapping_basis: 'registry_level_scenario',
      target: { canonical_id: source.id, path: `knowledge-base/methods/scenarios/product-experience/design-orchestration/${source.id}.md`, status: 'candidate' },
      merge_sections: [], governance: governance(source.owner),
    };
    return {
      ...base, disposition: 'source_only',
      rationale: 'Top-level and legacy Task files remain navigation/source history; Scenario guides are the candidate semantic unit.',
      mapping_basis: `registry_level_${String(source.level ?? 'unknown')}`, merge_sections: [],
    };
  }
  if (registry.kind === 'domain') return {
    ...base, disposition: 'reject_runtime',
    rationale: 'Domain pack is an incomplete shell and cannot enter runtime or the canonical Knowledge index.',
    mapping_basis: 'registry_domain_pack', merge_sections: [],
  };
  return {
    ...base, disposition: 'source_only',
    rationale: 'Complete case text remains source-only pending provenance, consistency, sensitivity, and derivative-card review.',
    mapping_basis: 'registry_case', merge_sections: [],
  };
}
function attachmentGroups(): AttachmentGroup[] {
  return [
    { id: 'source-sync', owner_refs: ['hub'], disposition: 'source_only', rationale: 'Immutable raw source mirror; never a runtime input.' },
    { id: 'hub-navigation', owner_refs: ['hub'], disposition: 'source_only', rationale: 'Root and zone navigation or explanatory files.' },
    { id: 'skill-support', owner_refs: ['skill-registry'], disposition: 'source_only', rationale: 'Skill references and supporting materials require entity-level Phase-B review.' },
    { id: 'unsafe-prototypes', owner_refs: ['hub'], disposition: 'reject_runtime', rationale: 'Executable prototypes, local servers, HTML tools, archives, and command launchers are excluded.' },
    { id: 'knowledge-support', owner_refs: ['knowledge-registry', 'case-registry', 'domain-registry'], disposition: 'source_only', rationale: 'Knowledge indexes, raw case material, and source attachments.' },
    { id: 'mechanism-support', owner_refs: ['hub'], disposition: 'source_only', rationale: 'Mechanism navigation remains subordinate to current policy truth sources.' },
    { id: 'hub-registries', owner_refs: ['hub'], disposition: 'reject_runtime', rationale: 'Hub registries are inventory inputs and cannot replace the current derived Registry.' },
    { id: 'tool-placeholders', owner_refs: ['hub'], disposition: 'reject_runtime', rationale: 'Tool zone contains placeholders and no approved executable Tool.' },
    { id: 'migration-records', owner_refs: ['hub'], disposition: 'source_only', rationale: 'Migration and E2E records are historical references, not test receipts.' },
  ].sort((left, right) => compareUtf8(left.id, right.id)) as AttachmentGroup[];
}
function groupForPath(path: string): string {
  if (path.startsWith('00-source-sync/')) return 'source-sync';
  if (path.startsWith('02-skills-技能/design-strategy-source/')) return 'unsafe-prototypes';
  if (path.startsWith('02-skills-技能/')) return 'skill-support';
  if (path.startsWith('03-knowledge-知识/')) return 'knowledge-support';
  if (path.startsWith('04-mechanism-机制/')) return 'mechanism-support';
  if (path.startsWith('05-registry-索引/')) return 'hub-registries';
  if (path.startsWith('06-tools-工具/')) return 'tool-placeholders';
  if (path.startsWith('迁移记录/')) return 'migration-records';
  return 'hub-navigation';
}
function addCoalescenceGroups(entities: ManifestEntity[]): void {
  const byTarget = new Map<string, ManifestEntity[]>();
  for (const entity of entities) {
    if (!entity.target || entity.target.status !== 'existing') continue;
    const list = byTarget.get(entity.target.path) ?? [];
    list.push(entity); byTarget.set(entity.target.path, list);
  }
  for (const [path, rows] of byTarget) {
    if (rows.length < 2) continue;
    const id = `coalesce-${basename(path).replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '')}`;
    rows.forEach((row) => { row.coalescence_group_id = id; });
  }
}
function dispositionHash(manifest: Pick<HubManifest, 'entities' | 'attachment_groups' | 'files'>): string {
  return canonicalHash({
    entities: manifest.entities,
    attachment_groups: manifest.attachment_groups,
    file_coverage: manifest.files.map(({ path, coverage }) => ({ path, coverage })),
  });
}
function nestedRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== null && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : undefined;
}
function declaredHuangliuCount(upstream: Record<string, unknown>): number {
  const included = nestedRecord(upstream, ['included']);
  const trees = included?.additional_field_source_trees;
  if (!Array.isArray(trees)) return -1;
  const row = trees.find((candidate) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).hub_path === '00-source-sync/jd-design-system-md-v16/product-architecture/huangliu-design') as Record<string, unknown> | undefined;
  return typeof row?.file_count === 'number' ? row.file_count : -1;
}
function buildUpstreamChecks(scan: HubScan): HubManifest['upstream_manifest']['declared_count_checks'] {
  if (!scan.upstreamManifest) return [];
  const included = nestedRecord(scan.upstreamManifest, ['included']);
  const agent = included?.agent_skill_entries_snapshot as Record<string, unknown> | undefined;
  const declaredAgent = typeof agent?.entry_count === 'number' ? agent.entry_count : -1;
  const observedAgent = scan.upstreamObservations.agentSkillEntryCount ?? -1;
  const declaredHuangliu = declaredHuangliuCount(scan.upstreamManifest);
  const observedHuangliu = scan.files.filter(({ path }) => path.startsWith('00-source-sync/jd-design-system-md-v16/product-architecture/huangliu-design/')).length;
  return [
    {
      key: 'agent_skill_entries_snapshot.entry_count', declared: declaredAgent, observed: observedAgent,
      status: declaredAgent === observedAgent ? 'match' : 'mismatch',
      reason: 'Declared upstream symlink-or-link entries are not all present as physical nodes in the read-only snapshot; Gate 1 must accept or reacquire.',
    },
    {
      key: 'additional_field_source_trees.huangliu-design.file_count', declared: declaredHuangliu, observed: observedHuangliu,
      status: declaredHuangliu === observedHuangliu ? 'match' : 'mismatch',
      reason: 'The upstream declaration and observed physical Huangliu file count differ; Gate 1 must accept or reacquire.',
    },
  ];
}

export function buildManifest(scan: HubScan, repositoryRoot: string): HubManifest {
  if (scan.registries.length !== REGISTRY_CONFIG.length || !scan.upstreamManifest) {
    throw new Error('Hub inventory requires all five registries and the source-sync manifest');
  }
  const context = loadCanonicalContext(repositoryRoot);
  const entities = scan.registries.flatMap((registry) => registry.entities.map((source) => manifestEntity(registry, source, context)))
    .sort((left, right) => compareUtf8(`${left.registry_kind}:${left.id}`, `${right.registry_kind}:${right.id}`));
  addCoalescenceGroups(entities);
  const entityByPath = new Map(entities.map((entity) => [entity.source_path, entity]));
  if (entityByPath.size !== entities.length) throw new Error('registry entities have duplicate source_path values');
  const groups = attachmentGroups();
  const files: ManifestFile[] = scan.files.map((file) => {
    const entity = entityByPath.get(file.path);
    const coverage: FileCoverage = entity ? { kind: 'entity', entity_ref: entity.key }
      : basename(file.path) === '.DS_Store'
        ? { kind: 'orphan', disposition: 'reject_runtime', reason: 'macOS filesystem metadata has no content ownership.' }
        : { kind: 'attachment', attachment_group_ref: groupForPath(file.path) };
    return { ...file, coverage };
  });
  const sourceSyncFiles = scan.files.filter(({ path }) => path.startsWith('00-source-sync/'));
  const organizedFiles = scan.files.filter(({ path }) => !path.startsWith('00-source-sync/'));
  const upstreamPath = '00-source-sync/source-sync-manifest.json';
  const upstreamFile = scan.files.find(({ path }) => path === upstreamPath);
  if (!upstreamFile) throw new Error(`missing ${upstreamPath}`);
  const checks = buildUpstreamChecks(scan);
  const agent = checks[0]!;
  const huangliu = checks[1]!;
  const invalidPaths = scan.files.filter(({ frontmatter }) => frontmatter.status === 'known_invalid').map(({ path }) => path);
  const draft: Omit<HubManifest, 'disposition_hash'> = {
    schema_version: 1, snapshot_id: SNAPSHOT_ID, logical_root: LOGICAL_ROOT,
    hash_spec: { algorithm: 'sha256', leaf_input: 'raw-bytes', tree_input: 'canonical-ndjson-v1', disposition_input: 'canonical-json-v1', path_encoding: 'utf8-nfc-posix' },
    snapshot: {
      ...summarizeFiles(scan.files),
      source_sync: { path: '00-source-sync', ...summarizeFiles(sourceSyncFiles) },
      organized: summarizeFiles(organizedFiles),
    },
    upstream_manifest: { path: upstreamPath, sha256: upstreamFile.sha256, declared_count_checks: checks },
    registries: scan.registries.map((registry) => ({ kind: registry.kind, path: registry.path, sha256: registry.sha256, entity_count: registry.entities.length })),
    known_transforms: [{
      id: LOCAL_HOME_TRANSFORM, applies_to: 'markdown-frontmatter', source_pattern: '[LOCAL_HOME]/',
      affected_count: invalidPaths.length, affected_paths_hash: pathListHash(invalidPaths),
    }],
    gate_1: {
      status: 'ready',
      facts: [
        { id: 'agent-skill-entry-count-mismatch', category: 'source_integrity', status: 'accepted', statement: `Upstream declares ${agent.declared} Agent Skill entries; ${agent.observed} physical entries are observed.`, decision_required: 'Accepted 2026-08-21 as a known observed-snapshot exception; no claim is made that missing upstream link targets were recovered.' },
        { id: 'huangliu-file-count-mismatch', category: 'source_integrity', status: 'accepted', statement: `Upstream declares ${huangliu.declared} Huangliu files; ${huangliu.observed} physical files are observed.`, decision_required: 'Accepted 2026-08-21 as a known observed-snapshot exception; the two absent upstream-declared files are not represented as present.' },
        { id: 'source-rights-not-declared', category: 'governance', status: 'accepted', statement: 'The Hub registries do not establish reuse rights, retention, sensitivity, or completed content scans for merge/import candidates.', decision_required: 'Accepted 2026-08-21 for internal evaluation reuse only; production promotion remains blocked until Gate 2 content scans and Gate 3 approval.' },
        { id: 'deploy-artifact-boundary-undefined', category: 'release_boundary', status: 'accepted', statement: 'This repository defines no deploy/package artifact whose file list can prove source-only and reject-runtime exclusion.', decision_required: 'Accepted 2026-08-21 as deferred: Git excludes /wiki; an actual package-boundary test becomes mandatory when a deploy artifact is defined.' },
        { id: 'hub-source-mounted-out-of-band', category: 'source_availability', status: 'accepted', statement: 'The Hub is an ignored read-only mount and is not available in a clean checkout by itself.', decision_required: 'Accepted 2026-08-21: Gate automation must provision the immutable snapshot as a read-only mount and pass --source explicitly.' },
      ].sort((left, right) => compareUtf8(left.id, right.id)) as HubManifest['gate_1']['facts'],
    },
    entities, attachment_groups: groups, files,
  };
  return { ...draft, disposition_hash: dispositionHash(draft) };
}
export function serializeManifest(manifest: HubManifest): string {
  return YAML.stringify(manifest, { lineWidth: 0 });
}

export function validateManifestSchema(manifest: unknown, repositoryRoot: string): string[] {
  const schema = JSON.parse(readFileSync(join(repositoryRoot, 'schemas/user-research-hub-disposition.schema.json'), 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return validate(manifest) ? [] : (validate.errors ?? []).map((error) => (
    `schema ${error.instancePath || '(root)'} ${error.message ?? 'invalid'}`
  )).sort(compareUtf8);
}
function targetPathValid(path: string): boolean {
  try {
    assertLogicalPath(path, 'target path');
    return path.startsWith('knowledge-base/') || path.startsWith('skills/');
  } catch { return false; }
}
export function checkManifest(manifest: HubManifest, scan: HubScan, canonicalCatalog: ReadonlySet<string>): string[] {
  const diagnostics: string[] = [];
  const add = (message: string): void => { diagnostics.push(message); };
  if (manifest.logical_root !== LOGICAL_ROOT) add(`logical_root must be ${LOGICAL_ROOT}`);
  const scannedByPath = new Map(scan.files.map((file) => [file.path, file]));
  const manifestByPath = new Map<string, ManifestFile>();
  for (const file of manifest.files) {
    if (manifestByPath.has(file.path)) add(`duplicate manifest file path ${file.path}`);
    manifestByPath.set(file.path, file);
    const scanned = scannedByPath.get(file.path);
    if (!scanned) add(`manifest file is absent from source: ${file.path}`);
    else {
      for (const field of ['node_type', 'size_bytes', 'sha256', 'executable', 'media_type'] as const) {
        if (file[field] !== scanned[field]) add(`file fact drift ${file.path} ${field}`);
      }
      if (JSON.stringify(file.frontmatter) !== JSON.stringify(scanned.frontmatter)) add(`frontmatter status drift ${file.path}`);
    }
  }
  for (const file of scan.files) if (!manifestByPath.has(file.path)) add(`source file is uncovered: ${file.path}`);
  const sourceSync = scan.files.filter(({ path }) => path.startsWith('00-source-sync/'));
  const organized = scan.files.filter(({ path }) => !path.startsWith('00-source-sync/'));
  const expectedSnapshot = summarizeFiles(scan.files);
  for (const field of ['file_count', 'byte_count', 'tree_hash'] as const) {
    if (manifest.snapshot[field] !== expectedSnapshot[field]) add(`snapshot ${field} drift`);
  }
  for (const [name, actual, expected] of [
    ['source_sync', manifest.snapshot.source_sync, summarizeFiles(sourceSync)],
    ['organized', manifest.snapshot.organized, summarizeFiles(organized)],
  ] as const) {
    for (const field of ['file_count', 'byte_count', 'tree_hash'] as const) {
      if (actual[field] !== expected[field]) add(`snapshot ${name}.${field} drift`);
    }
  }
  const scannedRegistries = new Map(scan.registries.map((registry) => [registry.kind, registry]));
  const manifestRegistries = new Map<string, HubManifest['registries'][number]>();
  for (const registry of manifest.registries) {
    if (manifestRegistries.has(registry.kind)) add(`duplicate registry kind ${registry.kind}`);
    manifestRegistries.set(registry.kind, registry);
    const scanned = scannedRegistries.get(registry.kind);
    if (!scanned) add(`registry is absent from source: ${registry.kind}`);
    else if (registry.path !== scanned.path || registry.sha256 !== scanned.sha256 || registry.entity_count !== scanned.entities.length) {
      add(`registry fact drift ${registry.kind}`);
    }
  }
  for (const { kind } of REGISTRY_CONFIG) if (!manifestRegistries.has(kind)) add(`manifest is missing registry ${kind}`);
  const sourceEntities = new Map<string, { registry: SourceRegistry; entity: SourceEntity }>();
  for (const registry of scan.registries) for (const entity of registry.entities) {
    const key = `${registry.kind}:${entity.id}`;
    if (sourceEntities.has(key)) add(`duplicate source entity key ${key}`);
    sourceEntities.set(key, { registry, entity });
  }
  const entities = new Map<string, ManifestEntity>();
  for (const entity of manifest.entities) {
    if (entities.has(entity.key)) add(`duplicate manifest entity key ${entity.key}`);
    entities.set(entity.key, entity);
    const source = sourceEntities.get(entity.key);
    if (!source) add(`manifest entity is absent from registries: ${entity.key}`);
    else if (entity.registry_path !== source.registry.path || entity.source_path !== source.entity.source_path || entity.source_status !== source.entity.status) {
      add(`entity source fact drift ${entity.key}`);
    }
    if (!entity.rationale.trim()) add(`entity rationale is empty ${entity.key}`);
    if ((entity.disposition === 'source_only' || entity.disposition === 'reject_runtime') && entity.target) add(`${entity.disposition} entity has a target ${entity.key}`);
    if (entity.disposition === 'map_existing' || entity.disposition === 'merge_into_existing') {
      if (!entity.target || entity.target.status !== 'existing') add(`existing mapping has no existing target ${entity.key}`);
      else if (!canonicalCatalog.has(entity.target.path)) add(`existing target does not exist ${entity.key}: ${entity.target.path}`);
    }
    if (entity.disposition === 'import_candidate') {
      if (!entity.target || (entity.target.status !== 'candidate' && entity.target.status !== 'approved')) {
        add(`import candidate has no candidate/approved target ${entity.key}`);
      } else {
        if (!targetPathValid(entity.target.path)) add(`invalid candidate target ${entity.key}: ${entity.target.path}`);
        const exists = canonicalCatalog.has(entity.target.path);
        if (entity.target.status === 'candidate' && exists) add(`candidate target already exists ${entity.key}: ${entity.target.path}`);
      }
    }
    if (entity.target && !targetPathValid(entity.target.path)) add(`invalid target path ${entity.key}: ${entity.target.path}`);
    if (entity.disposition === 'merge_into_existing' || entity.disposition === 'import_candidate') {
      if (!entity.governance) add(`governance is missing ${entity.key}`);
      else {
        const acknowledged = entity.governance.review_status === 'review_required'
          && entity.governance.finding_refs.includes('source-rights-not-declared')
          && manifest.gate_1.facts.some(({ id, status }) => id === 'source-rights-not-declared' && status === 'review_required');
        if (entity.governance.source_rights === 'unknown' && !acknowledged) add(`unknown source rights are not acknowledged ${entity.key}`);
        if (entity.governance.review_status === 'blocked') add(`blocked governance candidate ${entity.key}`);
      }
    }
  }
  for (const key of sourceEntities.keys()) if (!entities.has(key)) add(`registry entity is undispositioned: ${key}`);
  const groups = new Map<string, AttachmentGroup>();
  for (const group of manifest.attachment_groups) {
    if (groups.has(group.id)) add(`duplicate attachment group ${group.id}`);
    groups.set(group.id, group);
  }
  for (const file of manifest.files) {
    if (file.coverage.kind === 'entity') {
      const entity = entities.get(file.coverage.entity_ref);
      if (!entity) add(`file references unknown entity ${file.path}: ${file.coverage.entity_ref}`);
      else if (entity.source_path !== file.path) add(`entity coverage path mismatch ${file.path}: ${entity.key}`);
    } else if (file.coverage.kind === 'attachment') {
      if (!groups.has(file.coverage.attachment_group_ref)) add(`file references unknown attachment group ${file.path}: ${file.coverage.attachment_group_ref}`);
    } else if (!file.coverage.reason.trim()) add(`orphan reason is empty ${file.path}`);
  }
  for (const entity of manifest.entities) {
    const file = manifestByPath.get(entity.source_path);
    if (!file || file.coverage.kind !== 'entity' || file.coverage.entity_ref !== entity.key) add(`entity source file is not covered by its entity ${entity.key}`);
  }
  const targetRows = new Map<string, ManifestEntity[]>();
  for (const entity of manifest.entities) {
    if (!entity.target) continue;
    const rows = targetRows.get(entity.target.path) ?? [];
    rows.push(entity); targetRows.set(entity.target.path, rows);
  }
  for (const [path, rows] of targetRows) {
    if (rows.length < 2) continue;
    const groupIds = new Set(rows.map(({ coalescence_group_id }) => coalescence_group_id));
    if (groupIds.size !== 1 || groupIds.has(undefined)) add(`duplicate canonical target without one coalescence group: ${path}`);
  }
  const invalidPaths = scan.files.filter(({ frontmatter }) => frontmatter.status === 'known_invalid').map(({ path }) => path);
  const transform = manifest.known_transforms.find(({ id }) => id === LOCAL_HOME_TRANSFORM);
  if (!transform) add(`missing known transform ${LOCAL_HOME_TRANSFORM}`);
  else if (transform.affected_count !== invalidPaths.length || transform.affected_paths_hash !== pathListHash(invalidPaths)) add(`known transform set drift ${LOCAL_HOME_TRANSFORM}`);
  const expectedUpstream = buildUpstreamChecks(scan);
  if (JSON.stringify(manifest.upstream_manifest.declared_count_checks) !== JSON.stringify(expectedUpstream)) add('upstream declared count checks drift');
  const upstreamFile = scannedByPath.get(manifest.upstream_manifest.path);
  if (!upstreamFile || upstreamFile.sha256 !== manifest.upstream_manifest.sha256) add('upstream manifest hash drift');
  if (manifest.disposition_hash !== dispositionHash(manifest)) add('disposition_hash drift');
  return [...new Set(diagnostics)].sort(compareUtf8);
}

function validateProfileDraft(draft: ProfileDraft): void {
  if (draft.status !== 'draft' || draft.runtime_consumed !== false || draft.review_gate !== 'gate-2') {
    throw new Error('Profile draft must remain draft, non-runtime, and Gate-2 reviewed');
  }
  if (JSON.stringify(draft.dimension_order) !== JSON.stringify(DIMENSIONS)) throw new Error('Profile draft dimension order is invalid');
  if (JSON.stringify(draft.profile_order) !== JSON.stringify(PROFILE_IDS)) throw new Error('Profile draft profile order is invalid');
  if (draft.profile_specs.length !== PROFILE_IDS.length) throw new Error('Profile draft must define seven ProfileSpecs');
  const specIds = new Set(draft.profile_specs.map(({ id }) => id));
  if (specIds.size !== PROFILE_IDS.length || PROFILE_IDS.some((id) => !specIds.has(id))) throw new Error('Profile draft ProfileSpec IDs are incomplete or duplicated');
  draft.profile_specs.forEach((spec, index) => {
    if (spec.ordinal !== index || spec.id !== PROFILE_IDS[index]) throw new Error(`ProfileSpec order drift at ${spec.id}`);
    if (spec.required_difference_dimensions.length === 0) throw new Error(`ProfileSpec ${spec.id} has no required difference dimensions`);
  });
  if (draft.scenario_profile_mappings.length !== 15) throw new Error('Profile draft must map exactly 15 Scenarios');
  const scenarioIds = new Set<string>();
  for (const mapping of draft.scenario_profile_mappings) {
    if (scenarioIds.has(mapping.scenario_id)) throw new Error(`duplicate Scenario mapping ${mapping.scenario_id}`);
    scenarioIds.add(mapping.scenario_id);
    assertLogicalPath(mapping.source_path, `Scenario ${mapping.scenario_id} source_path`);
    if (!/^[a-f0-9]{64}$/u.test(mapping.source_sha256)) throw new Error(`invalid Scenario source hash ${mapping.scenario_id}`);
    if (mapping.candidate_profiles[0] !== 'speed' || mapping.candidate_profiles[1] !== 'depth') throw new Error(`Scenario ${mapping.scenario_id} must begin with speed/depth`);
    if (new Set(mapping.candidate_profiles).size !== mapping.candidate_profiles.length) throw new Error(`Scenario ${mapping.scenario_id} has duplicate profiles`);
    const specialty = mapping.candidate_profiles.slice(2);
    if (specialty.length === 0 || specialty.length > 4) throw new Error(`Scenario ${mapping.scenario_id} specialty count is invalid`);
    if (mapping.specialty_assessments.length !== specialty.length
      || mapping.specialty_assessments.some(({ profile_id }) => !specialty.includes(profile_id))) {
      throw new Error(`Scenario ${mapping.scenario_id} specialty assessments drift`);
    }
  }
}
function profileFingerprint(spec: ProfileSpec, dimension: DifferenceDimension): string {
  return dimension === 'output_emphasis'
    ? JSON.stringify([...new Set(spec.dimensions.output_emphasis)].sort(compareUtf8))
    : spec.dimensions[dimension];
}
export function buildDistinctnessReport(draft: ProfileDraft): DistinctnessReport {
  validateProfileDraft(draft);
  const specById = new Map(draft.profile_specs.map((spec) => [spec.id, spec]));
  const rows: DistinctnessRow[] = [];
  const mappings = draft.scenario_profile_mappings.slice().sort((left, right) => compareUtf8(left.source_path, right.source_path));
  for (const mapping of mappings) for (const specialtyId of mapping.candidate_profiles.slice(2)) {
    const specialty = specById.get(specialtyId)!;
    const assessment = mapping.specialty_assessments.find(({ profile_id }) => profile_id === specialtyId)!;
    for (const baselineId of ['speed', 'depth'] as const) {
      const baseline = specById.get(baselineId)!;
      const differentDimensions = DIMENSIONS.filter((dimension) => profileFingerprint(specialty, dimension) !== profileFingerprint(baseline, dimension));
      const specialtyRequirementMet = specialty.required_difference_dimensions.some((dimension) => differentDimensions.includes(dimension));
      const baselineRequirementMet = baseline.required_difference_dimensions.some((dimension) => differentDimensions.includes(dimension));
      rows.push({
        scenarioId: mapping.scenario_id, sourcePath: mapping.source_path, specialtyProfileId: specialtyId,
        baselineProfileId: baselineId, requiredBySpecialty: specialty.required_difference_dimensions,
        requiredByBaseline: baseline.required_difference_dimensions, differentDimensions,
        specialtyRequirementMet, baselineRequirementMet,
        invariantResults: {
          allRequiredQuestions: 'declared', allRequiredEvidence: 'declared',
          allRequestedDeliverables: 'declared', safetyPolicyUnchanged: 'declared',
        },
        specVerdict: specialtyRequirementMet && baselineRequirementMet ? 'pass' : 'fail',
        catalogSupport: assessment.catalog_support,
        reasonCodes: [...new Set(assessment.reason_codes)].sort(compareUtf8),
      });
    }
  }
  const assessments = mappings.flatMap(({ specialty_assessments }) => specialty_assessments);
  const specPassCount = rows.filter(({ specVerdict }) => specVerdict === 'pass').length;
  return {
    formatVersion: 'profile-spec-distinctness-v2', runtimeClaim: 'static-spec-contract-only',
    inputs: {
      profileSpecsSha256: canonicalHash(draft.profile_specs),
      scenarioMappingsSha256: canonicalHash(draft.scenario_profile_mappings),
      capabilityRegistrySha256: draft.catalog_snapshot_hash,
    },
    dimensionOrder: [...DIMENSIONS], baselineOrder: ['speed', 'depth'],
    summary: {
      scenarioCount: mappings.length, mappedScenarioCount: mappings.filter(({ candidate_profiles }) => candidate_profiles.length > 2).length,
      specialtyBindingCount: assessments.length, baselineComparisonCount: rows.length,
      specPassCount, specFailCount: rows.length - specPassCount,
      catalogSupportedCount: assessments.filter(({ catalog_support }) => catalog_support === 'supported').length,
      catalogConditionalCount: assessments.filter(({ catalog_support }) => catalog_support === 'conditional').length,
      catalogGapCount: assessments.filter(({ catalog_support }) => catalog_support === 'gap').length,
    },
    rows,
  };
}
export function serializeDistinctnessReport(report: DistinctnessReport): string {
  return `${JSON.stringify(stableValue(report), null, 2)}\n`;
}

interface CliOptions { command: 'inventory' | 'check' | 'apply'; source: string; output?: string; manifest?: string }
function parseCli(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (command !== 'inventory' && command !== 'check' && command !== 'apply') {
    throw new Error('usage: hub:integration <inventory|check|apply> --source <hub-root> [--output <file>|--manifest <file>]');
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid ${command} arguments`);
    }
    if (flags.has(flag)) throw new Error(`duplicate flag ${flag}`);
    flags.set(flag, value);
  }
  const allowed = command === 'inventory' ? new Set(['--source', '--output']) : new Set(['--source', '--manifest']);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unknown ${command} flag ${flag}`);
  const source = flags.get('--source');
  if (!source) throw new Error('--source is required');
  if (command === 'check' || command === 'apply') {
    const manifest = flags.get('--manifest');
    if (!manifest) throw new Error('--manifest is required');
    return { command, source, manifest };
  }
  return { command, source, ...(flags.get('--output') ? { output: flags.get('--output') } : {}) };
}
function profileArtifacts(manifestPath: string, scan: HubScan): string[] {
  const diagnostics: string[] = [];
  const directory = dirname(manifestPath);
  const draftPath = join(directory, 'user-research-hub-profile-draft-2026-08-21.yaml');
  const reportPath = join(directory, 'user-research-hub-profile-distinctness-2026-08-21.json');
  if (!existsSync(draftPath)) return [`profile draft is missing: ${basename(draftPath)}`];
  if (!existsSync(reportPath)) return [`profile distinctness report is missing: ${basename(reportPath)}`];
  try {
    const draft = YAML.parse(readFileSync(draftPath, 'utf8')) as ProfileDraft;
    const report = buildDistinctnessReport(draft);
    const expected = serializeDistinctnessReport(report);
    if (readFileSync(reportPath, 'utf8') !== expected) diagnostics.push('profile distinctness report drift');
    const byPath = new Map(scan.files.map((file) => [file.path, file]));
    for (const mapping of draft.scenario_profile_mappings) {
      const file = byPath.get(mapping.source_path);
      if (!file || file.sha256 !== `sha256:${mapping.source_sha256}`) {
        diagnostics.push(`Profile draft Scenario source drift ${mapping.scenario_id}`);
      }
    }
    const bindingsPath = join(REPOSITORY_ROOT, 'orchestrator/skill-bindings.yaml');
    const registryHash = sha256Bytes(readFileSync(bindingsPath));
    if (draft.catalog_snapshot_hash !== registryHash) {
      const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) as HubManifest;
      const expectedDraftIds = manifest.entities.filter(({ disposition, registry_kind }) => (
        disposition === 'import_candidate' && registry_kind === 'skill'
      )).map(({ target }) => target!.canonical_id).sort(compareUtf8);
      const registry = YAML.parse(readFileSync(bindingsPath, 'utf8')) as {
        skills?: Array<{ id: string; enabled: boolean }>;
      };
      const actualDraftIds = (registry.skills ?? []).filter(({ enabled }) => !enabled)
        .map(({ id }) => id).sort(compareUtf8);
      if (JSON.stringify(actualDraftIds) !== JSON.stringify(expectedDraftIds)) {
        diagnostics.push('Profile draft capability Registry hash drift beyond the governed candidate Skill drafts');
      }
    }
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  return diagnostics.sort(compareUtf8);
}
async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const scan = scanHub(options.source);
  if (options.command === 'inventory') {
    const serialized = serializeManifest(buildManifest(scan, REPOSITORY_ROOT));
    if (options.output) {
      const output = resolve(options.output);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, serialized);
    } else process.stdout.write(serialized);
    return;
  }
  const manifestPath = resolve(options.manifest!);
  const manifestRelative = relative(REPOSITORY_ROOT, manifestPath);
  if (manifestRelative === '..' || manifestRelative.startsWith(`..${sep}`) || isAbsolute(manifestRelative)) {
    throw new Error('--manifest must be a logical path inside the managed repository');
  }
  const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) as HubManifest;
  const profileDraftPath = join(dirname(manifestPath), 'user-research-hub-profile-draft-2026-08-21.yaml');
  const profileDraft = YAML.parse(readFileSync(profileDraftPath, 'utf8')) as ProfileDraft;
  const baseDiagnostics = [
    ...validateManifestSchema(manifest, REPOSITORY_ROOT),
    ...checkManifest(manifest, scan, createCanonicalCatalog(REPOSITORY_ROOT)),
    ...profileArtifacts(manifestPath, scan),
  ].sort(compareUtf8);
  if (baseDiagnostics.length > 0) {
    throw new Error(`Hub manifest check failed:\n${baseDiagnostics.map((value) => `- ${value}`).join('\n')}`);
  }

  const contentBuild = buildHubContentApply(manifest, options.source, REPOSITORY_ROOT, profileDraft);
  if (options.command === 'apply') {
    const writeResult = writeHubContentApply(contentBuild, REPOSITORY_ROOT);
    const serializedManifest = serializeManifest(contentBuild.manifest);
    if (readFileSync(manifestPath, 'utf8') !== serializedManifest) writeFileSync(manifestPath, serializedManifest, 'utf8');
    const afterScan = scanHub(options.source);
    if (hashFiles(afterScan.files) !== hashFiles(scan.files) || afterScan.files.length !== scan.files.length) {
      throw new Error('Hub source mutation detected during apply');
    }
    const appliedDiagnostics = checkAppliedHubContent(contentBuild, REPOSITORY_ROOT);
    if (appliedDiagnostics.length > 0) {
      throw new Error(`Hub content apply failed:\n${appliedDiagnostics.map((value) => `- ${value}`).join('\n')}`);
    }
    console.log(JSON.stringify({
      status: 'applied',
      snapshotId: manifest.snapshot_id,
      sourceMutationCheck: 'unchanged',
      ...contentBuild.report.materialized,
      mergeDrafts: contentBuild.report.merge_drafts.files,
      mappedKnowledge: contentBuild.report.mapped_existing.knowledge_entries,
      governedEntities: contentBuild.report.governance.scanned_entities,
      writtenFiles: writeResult.written,
      unchangedFiles: writeResult.unchanged,
      removedFiles: writeResult.removed,
      outputSetHash: contentBuild.report.output_set_hash,
    }));
    return;
  }

  const contentDiagnostics = [
    ...(serializeManifest(contentBuild.manifest) === serializeManifest(manifest)
      ? []
      : ['content apply governance manifest drift']),
    ...checkAppliedHubContent(contentBuild, REPOSITORY_ROOT),
  ].sort(compareUtf8);
  if (contentDiagnostics.length > 0) {
    throw new Error(`Hub content check failed:\n${contentDiagnostics.map((value) => `- ${value}`).join('\n')}`);
  }
  console.log(JSON.stringify({
    status: 'ok', snapshotId: manifest.snapshot_id, fileCount: manifest.snapshot.file_count,
    entityCount: manifest.entities.length, treeHash: manifest.snapshot.tree_hash,
    dispositionHash: manifest.disposition_hash,
    profileDistinctness: buildDistinctnessReport(profileDraft).summary,
    content: {
      ...contentBuild.report.materialized,
      mergeDrafts: contentBuild.report.merge_drafts.files,
      governedEntities: contentBuild.report.governance.scanned_entities,
      outputSetHash: contentBuild.report.output_set_hash,
    },
    gate1Status: manifest.gate_1.status,
  }));
}
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
