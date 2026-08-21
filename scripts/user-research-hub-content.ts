import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { parseFrontmatter, serializeFrontmatter } from '../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { contentHash } from '../apps/orchestrator-runtime/src/knowledge/normalizer.ts';

const MANAGED_BY = 'user-research-hub-integration-v1';
const REPORT_PATH = 'knowledge-base/.sources/user-research-hub-content-apply-2026-08-21.json';
const MERGE_DRAFT_ROOT = 'knowledge-base/.sources/user-research-hub-merge-drafts-2026-08-21';
const LOGICAL_HUB_ROOT = 'wiki/user-research';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANDIDATE_PREFIXES = [
  'knowledge-base/methods/toolbox/analysis/design-strategy/',
  'knowledge-base/methods/scenarios/product-experience/design-orchestration/',
  'knowledge-base/assets/templates/',
  'knowledge-base/skills/',
] as const;

interface Governance {
  sensitivity: string;
  distribution_scope: string;
  owner: string;
  retention: string;
  source_rights: string;
  review_status: string;
  scans: Record<'secrets' | 'pii' | 'local_paths' | 'internal_business_facts', string>;
  finding_refs: string[];
}
interface Target { canonical_id: string; path: string; status: string }
interface Entity {
  key: string;
  registry_kind: string;
  id: string;
  entity_type: string;
  source_path: string;
  disposition: string;
  target?: Target;
  merge_sections: string[];
  governance?: Governance;
}
interface ManifestFile { path: string; sha256: string; media_type: string }
interface Manifest {
  snapshot_id: string;
  logical_root: string;
  snapshot: { tree_hash: string };
  gate_1: { status: string; facts: Array<{ id: string; status: string }> };
  entities: Entity[];
  attachment_groups: unknown[];
  files: ManifestFile[];
  disposition_hash: string;
}
interface ProfileDraft {
  scenario_profile_mappings: Array<{ source_entity_id: string; candidate_profiles: string[] }>;
}
interface ContentFindingCounts {
  secrets: number;
  pii: number;
  local_paths: number;
  internal_business_facts: number;
}
interface GovernanceFinding {
  kind: 'internal_business_fact';
  line: number;
  snippet_hash: string;
  classification: 'generic_example' | 'time_bounded_project_fact' | 'internal_rule' | 'unscoped_internal_claim' | 'boundary_statement' | 'input_category';
  source_scope: 'evaluation_only';
  source_date: string;
  disposition: 'retain_as_scoped_example' | 'exclude_from_promotion' | 'review_required';
}
interface EntityScan {
  entity_key: string;
  source_path: string;
  finding_counts: ContentFindingCounts;
  results: Governance['scans'];
  finding_refs: string[];
  findings: GovernanceFinding[];
}
interface StructuralComparison {
  entity_key: string;
  disposition: string;
  source_path: string;
  target_path: string;
  source_body_hash: string;
  target_body_hash: string;
  body_equal: boolean;
  source_only_headings: string[];
  target_only_headings: string[];
  changed_shared_headings: string[];
}
export interface HubContentApplyReport {
  format_version: 'user-research-hub-content-apply-v1';
  snapshot_id: string;
  source_tree_hash: string;
  disposition_hash: string;
  source_mutation_contract: 'read-only-hash-verified';
  gate_1_reuse_scope: 'internal-evaluation-only';
  materialized: {
    candidate_files: number;
    knowledge_methods: number;
    scenarios: number;
    assets: number;
    draft_skills: number;
  };
  merge_drafts: { files: number; skill_files: number; knowledge_files: number };
  mapped_existing: { knowledge_entries: number };
  governance: {
    scanned_entities: number;
    blocked_entities: number;
    source_finding_counts: ContentFindingCounts;
    gate_2_review_required: boolean;
  };
  runtime_boundary: {
    source_only_materialized: 0;
    reject_runtime_materialized: 0;
    opaque_materialized: 0;
    candidate_status: 'candidate';
    skill_registry_status: 'draft';
  };
  outputs: Array<{
    entity_key: string;
    kind: 'candidate' | 'merge_draft';
    path: string;
    sha256: string;
  }>;
  scans: EntityScan[];
  comparisons: StructuralComparison[];
  output_set_hash: string;
}
export interface HubContentApplyBuild<TManifest extends Manifest = Manifest> {
  manifest: TManifest;
  files: Map<string, string>;
  report: HubContentApplyReport;
}

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
function canonicalHash(value: unknown): string {
  return sha256Bytes(JSON.stringify(stableValue(value)));
}
function assertLogicalPath(path: string, field: string): void {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
    || path !== path.normalize('NFC')) {
    throw new Error(`${field} is not a normalized relative POSIX NFC path: ${path}`);
  }
}
function repositoryPath(repositoryRoot: string, logicalPath: string): string {
  assertLogicalPath(logicalPath, 'persisted path');
  const absolute = join(repositoryRoot, ...logicalPath.split('/'));
  const escaped = relative(repositoryRoot, absolute);
  if (escaped === '..' || escaped.startsWith('../') || isAbsolute(escaped)) {
    throw new Error(`persisted path escapes repository: ${logicalPath}`);
  }
  return absolute;
}
function dispositionHash(manifest: Pick<Manifest, 'entities' | 'attachment_groups' | 'files'>): string {
  return canonicalHash({
    entities: manifest.entities,
    attachment_groups: manifest.attachment_groups,
    file_coverage: manifest.files.map((file) => {
      const coverage = (file as ManifestFile & { coverage?: unknown }).coverage;
      return { path: file.path, coverage };
    }),
  });
}

function quoteKnownLocalHomeScalars(markdown: string): string {
  return markdown.replace(
    /^(\s*(?:-\s*)?)(\[LOCAL_HOME\]\/[^\r\n]*)$/gmu,
    (_match, prefix: string, value: string) => `${prefix}${JSON.stringify(value)}`,
  );
}
function parseHubMarkdown(markdown: string): { frontmatter: Record<string, unknown>; content: string } {
  const normalized = quoteKnownLocalHomeScalars(markdown.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n'));
  return parseFrontmatter(normalized);
}
function removeDuplicateOpeningHeading(content: string): string {
  const lines = content.replace(/\r\n?/gu, '\n').trim().split('\n');
  const nonEmpty = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line !== '');
  if (nonEmpty.length >= 2 && /^#\s+/u.test(nonEmpty[0]!.line)
    && nonEmpty[0]!.line === nonEmpty[1]!.line) {
    lines.splice(nonEmpty[1]!.index, 1);
  }
  return lines.join('\n').trim();
}
function firstHeading(content: string, fallback: string): string {
  return /^#\s+(.+)$/mu.exec(content)?.[1]?.trim() || fallback;
}
function summary(content: string, frontmatter: Record<string, unknown>, fallback: string): string {
  if (typeof frontmatter.definition === 'string' && frontmatter.definition.trim() !== '') {
    return frontmatter.definition.trim();
  }
  const line = content.split('\n').map((value) => value.trim())
    .find((value) => value !== '' && !value.startsWith('#') && !value.startsWith('|'));
  return (line ?? fallback).replace(/^>\s*/u, '').slice(0, 240);
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((item) => item.trim() !== '');
}
function candidateType(entity: Entity): 'analysis' | 'scenario-guide' | 'asset' | 'skill' {
  if (entity.registry_kind === 'task') return 'scenario-guide';
  if (entity.registry_kind === 'skill') return 'skill';
  if (entity.entity_type === 'template') return 'asset';
  return 'analysis';
}
function guideMetadata(entity: Entity): { guide_tags: string[]; guide_stage: string[] } {
  if (entity.registry_kind === 'task') {
    return { guide_tags: ['scenario-guidance'], guide_stage: ['intent', 'method-selection'] };
  }
  if (entity.registry_kind === 'knowledge' && entity.entity_type === 'method') {
    const tags = ['method', 'design-strategy'];
    if (entity.id.includes('competitor')) tags.push('business-competitive');
    if (entity.id.includes('user')) tags.push('persona');
    if (entity.id.includes('experience')) tags.push('ux-audit');
    return { guide_tags: [...new Set(tags)], guide_stage: ['method-selection'] };
  }
  return { guide_tags: [], guide_stage: [] };
}
function methodEvidenceTypes(id: string): string[] {
  if (id.includes('competitor')) return ['public_source', 'screenshot', 'derived'];
  if (id.startsWith('ds-method-user') || id.startsWith('ux-method')) return ['user_input', 'screenshot', 'derived'];
  return ['user_input', 'knowledge', 'derived'];
}
function ensureMethodContract(entity: Entity, body: string): string {
  if (entity.registry_kind !== 'knowledge' || entity.entity_type !== 'method') return body;
  const family = entity.id.includes('competitor') ? '竞品对象与公开证据'
    : entity.id.startsWith('ds-method-user') || entity.id.startsWith('ux-method') ? '用户、触点与已有研究材料'
      : '已确认问题、约束与策略目标';
  return `${body.trim()}\n\n## 适用条件\n\n- 输入包含${family}，且研究问题与本方法的目标一致。\n- 若缺少必需材料，先记录缺口，不以知识库内容替代当前事实。\n\n## 输入\n\n- 已确认的研究目标、范围、约束和成功标准。\n- 与本方法相关的可追溯用户输入、公开来源、截图、数据或既有证据。\n\n## 执行步骤\n\n1. 冻结研究问题、分析对象和证据边界。\n2. 按本卡片正文中的维度或模型整理输入，并逐项保留来源引用。\n3. 区分观察事实、分析推断和待验证假设。\n4. 形成结构化输出，检查覆盖、冲突、缺口和不可照搬边界。\n\n## 输出\n\n- 与正文模板一致的结构化分析结果。\n- 来源引用、证据缺口、风险和后续验证项。\n\n## 常见误用\n\n- 把方法或案例当作当前业务事实。\n- 为填满模板而编造数据、用户结论或竞品能力。\n- 忽略样本、时间、场景和证据适用范围。\n\n## 证据边界\n\n知识库只提供方法依据。当前用户、竞品和业务事实必须来自本次用户输入或可复查证据；无法核验的内容只能标为假设或缺口。\n\n## 验证方式\n\n- 检查每项事实是否有来源，每项推断是否引用事实，每项建议是否给出指标或验证方法。\n- 使用第二来源、反例或人工复核验证关键结论；不能验证时明确降级。\n`;
}
function candidateFrontmatter(
  entity: Entity,
  sourceFrontmatter: Record<string, unknown>,
  body: string,
  sourceHash: string,
  profileDraft: ProfileDraft,
): Record<string, unknown> {
  if (!entity.target) throw new Error(`candidate has no target: ${entity.key}`);
  const relPath = entity.target.path.replace(/^knowledge-base\//u, '');
  const type = candidateType(entity);
  const title = typeof sourceFrontmatter.title === 'string'
    ? sourceFrontmatter.title
    : firstHeading(body, entity.target.canonical_id);
  const guide = guideMetadata(entity);
  const base: Record<string, unknown> = {
    id: type === 'skill'
      ? `skill_${entity.target.canonical_id.replace(/-/gu, '_')}`
      : entity.target.canonical_id,
    type,
    title,
    domain: type === 'scenario-guide' ? ['产品体验'] : type === 'skill' ? ['general'] : ['通用'],
    tags: stringArray(sourceFrontmatter.tags),
    status: 'candidate',
    sensitivity: entity.governance!.sensitivity,
    owner: entity.governance!.owner,
    source: 'user-research-hub',
    source_path: relPath,
    hub_snapshot_id: 'user-research-hub-2026-08-21',
    hub_source_path: `${LOGICAL_HUB_ROOT}/${entity.source_path}`,
    hub_source_hash: sourceHash,
    distribution_scope: entity.governance!.distribution_scope,
    retention: entity.governance!.retention,
    source_rights: entity.governance!.source_rights,
    managed_by: MANAGED_BY,
    content_hash: contentHash(body),
    summary: summary(body, sourceFrontmatter, title),
    ...guide,
  };
  for (const field of ['capability_domain', 'business_domain', 'task_types', 'evidence_types'] as const) {
    if (sourceFrontmatter[field] !== undefined) base[field] = sourceFrontmatter[field];
  }
  if (type === 'analysis') base.evidence_types = methodEvidenceTypes(entity.id);
  if (type === 'scenario-guide') {
    for (const field of [
      'parent_task', 'definition', 'trigger_examples', 'required_inputs', 'optional_inputs',
      'outputs', 'completion_criteria', 'default_skills', 'optional_skills',
      'knowledge_requirements', 'dependencies', 'fallback', 'human_confirmation',
    ] as const) {
      if (sourceFrontmatter[field] !== undefined) base[field] = sourceFrontmatter[field];
    }
    const mapping = profileDraft.scenario_profile_mappings.find(({ source_entity_id }) => (
      source_entity_id === entity.id
    ));
    if (!mapping) throw new Error(`Scenario candidate has no Phase-A profile mapping: ${entity.key}`);
    base.candidate_profiles = [...mapping.candidate_profiles];
  }
  if (type === 'skill') {
    base.name = entity.target.canonical_id;
    base.description = typeof sourceFrontmatter.description === 'string'
      ? sourceFrontmatter.description
      : title;
    base.inputs = Array.isArray(sourceFrontmatter.inputs) ? sourceFrontmatter.inputs : [];
    base.outputs = Array.isArray(sourceFrontmatter.outputs) ? sourceFrontmatter.outputs : [];
    base.risk_level = 'low';
  }
  return base;
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/gu,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?(?!\[|\{|<|your\b|example\b)[A-Za-z0-9_./+=-]{12,}/giu,
];
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu,
  /(?<!\d)\d{17}[\dXx](?!\d)/gu,
];
const LOCAL_PATH_PATTERNS = [
  /\[LOCAL_HOME\]\//gu,
  /(?:^|[\s'"(])\/(?:Users|home|private|var\/folders)\//gmu,
  /[A-Za-z]:\\Users\\/gu,
];
const INTERNAL_FACT_PATTERNS = [
  /京东|京喜|商详|内部业务|内部数据/gu,
];
function countMatches(value: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) count += [...value.matchAll(new RegExp(pattern.source, pattern.flags))].length;
  return count;
}
function internalBusinessFindings(raw: string, frontmatter: Record<string, unknown>): GovernanceFinding[] {
  const sourceDate = String(frontmatter.updated_at ?? frontmatter.updated ?? frontmatter.created_at ?? 'unknown');
  const findings: GovernanceFinding[] = [];
  raw.replace(/\r\n?/gu, '\n').split('\n').forEach((line, index) => {
    if (!INTERNAL_FACT_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(line))) return;
    const boundary = /不提供(?:京东)?内部业务规则|不能凭.*业务规则/u.test(line);
    const inputCategory = /^\s*-\s*内部业务变化\s*$/u.test(line);
    const numeric = /\d+(?:\.\d+)?%|\d{2,}/u.test(line);
    const generic = /示例|例如|可用于|假设|模板|占位/u.test(line);
    const rule = /必须|禁止|规则|口径|权限|流程/u.test(line);
    const classification: GovernanceFinding['classification'] = boundary ? 'boundary_statement'
      : inputCategory ? 'input_category' : generic ? 'generic_example'
        : numeric ? 'time_bounded_project_fact' : rule ? 'internal_rule' : 'unscoped_internal_claim';
    const disposition: GovernanceFinding['disposition'] = (
      classification === 'generic_example'
      || classification === 'boundary_statement'
      || classification === 'input_category'
    ) ? 'retain_as_scoped_example' : classification === 'time_bounded_project_fact'
      ? 'exclude_from_promotion' : 'review_required';
    findings.push({
      kind: 'internal_business_fact', line: index + 1, snippet_hash: sha256Bytes(line.trim()),
      classification, source_scope: 'evaluation_only', source_date: sourceDate, disposition,
    });
  });
  return findings;
}
function scanEntity(entity: Entity, raw: string, normalizedBody: string, frontmatter: Record<string, unknown>): EntityScan {
  const finding_counts: ContentFindingCounts = {
    secrets: countMatches(raw, SECRET_PATTERNS),
    pii: countMatches(raw, PII_PATTERNS),
    local_paths: countMatches(raw, LOCAL_PATH_PATTERNS),
    internal_business_facts: countMatches(raw, INTERNAL_FACT_PATTERNS),
  };
  if (finding_counts.secrets > 0 || finding_counts.pii > 0) {
    throw new Error(`governance scan blocked ${entity.key}: secret/PII finding requires human disposition`);
  }
  if (countMatches(normalizedBody, LOCAL_PATH_PATTERNS) > 0) {
    throw new Error(`governance scan blocked ${entity.key}: local path remains after normalization`);
  }
  const findings = internalBusinessFindings(raw, frontmatter);
  const unresolvedInternalFinding = findings.some(({ disposition }) => disposition === 'review_required');
  const finding_refs = ['gate-1-internal-evaluation-only'];
  if (finding_counts.local_paths > 0) finding_refs.push('known-local-path-source-reference-removed');
  if (finding_counts.internal_business_facts > 0) finding_refs.push('internal-business-facts-evaluation-only');
  return {
    entity_key: entity.key,
    source_path: entity.source_path,
    finding_counts,
    results: {
      secrets: 'clear',
      pii: 'clear',
      local_paths: finding_counts.local_paths > 0 ? 'review_required' : 'clear',
      internal_business_facts: findings.length === 0
        ? 'clear'
        : unresolvedInternalFinding ? 'review_required' : 'reviewed',
    },
    finding_refs: finding_refs.sort(compareUtf8),
    findings,
  };
}
function validateGovernance(entity: Entity): void {
  const governance = entity.governance;
  if (!governance) throw new Error(`governance is missing: ${entity.key}`);
  if (governance.sensitivity !== 'internal'
    || governance.distribution_scope !== 'evaluation_only'
    || governance.owner !== 'user-research-hub-maintainers'
    || governance.retention !== 'through-gate-3-or-revocation'
    || governance.source_rights !== 'cleared_internal_reuse'
    || (governance.review_status !== 'review_required' && governance.review_status !== 'complete')) {
    throw new Error(`candidate is outside the accepted Gate-1 internal-evaluation governance contract: ${entity.key}`);
  }
}

interface Section { key: string; heading: string; hash: string }
function sections(content: string): Section[] {
  const lines = content.trim().split('\n');
  const starts: Array<{ index: number; heading: string }> = [];
  lines.forEach((line, index) => {
    if (/^#{1,6}\s+/u.test(line)) starts.push({ index, heading: line.replace(/^#{1,6}\s+/u, '').trim() });
  });
  const occurrences = new Map<string, number>();
  return starts.map((start, index) => {
    const occurrence = (occurrences.get(start.heading) ?? 0) + 1;
    occurrences.set(start.heading, occurrence);
    const value = lines.slice(start.index, starts[index + 1]?.index ?? lines.length).join('\n').trim();
    return { key: `${start.heading}#${occurrence}`, heading: start.heading, hash: sha256Bytes(value) };
  });
}
function resolveCanonicalEntry(repositoryRoot: string, targetPath: string): { logicalPath: string; raw: string } {
  const target = repositoryPath(repositoryRoot, targetPath);
  if (!existsSync(target)) throw new Error(`canonical target does not exist: ${targetPath}`);
  const logicalPath = statSync(target).isDirectory() ? `${targetPath}/SKILL.md` : targetPath;
  const absolute = repositoryPath(repositoryRoot, logicalPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`canonical target entry does not exist: ${logicalPath}`);
  }
  return { logicalPath, raw: readFileSync(absolute, 'utf8') };
}
function compareStructural(
  entity: Entity,
  sourceBody: string,
  repositoryRoot: string,
): StructuralComparison {
  if (!entity.target) throw new Error(`comparison target is missing: ${entity.key}`);
  const target = resolveCanonicalEntry(repositoryRoot, entity.target.path);
  const targetBody = parseFrontmatter(target.raw.replace(/\r\n?/gu, '\n')).content;
  const sourceSections = sections(sourceBody);
  const targetSections = sections(targetBody);
  const sourceByKey = new Map(sourceSections.map((section) => [section.key, section]));
  const targetByKey = new Map(targetSections.map((section) => [section.key, section]));
  return {
    entity_key: entity.key,
    disposition: entity.disposition,
    source_path: entity.source_path,
    target_path: entity.target.path,
    source_body_hash: sha256Bytes(sourceBody),
    target_body_hash: sha256Bytes(targetBody),
    body_equal: sourceBody === targetBody,
    source_only_headings: sourceSections.filter(({ key }) => !targetByKey.has(key)).map(({ heading }) => heading),
    target_only_headings: targetSections.filter(({ key }) => !sourceByKey.has(key)).map(({ heading }) => heading),
    changed_shared_headings: sourceSections.filter(({ key, hash }) => {
      const targetSection = targetByKey.get(key);
      return targetSection !== undefined && targetSection.hash !== hash;
    }).map(({ heading }) => heading),
  };
}
function narrowSkillDelta(entity: Entity): string {
  if (entity.id === 'ds-skill-trend-change-scan') return [
    '## Proposed canonical delta', '',
    '### when_to_use', '- Use when the user explicitly asks for trend/change scanning across a named market, audience, scenario, or time window; do not infer a trend task from a passing mention.',
    '### evidence_boundary', '- A trend claim requires dated, traceable public sources from more than one observation point. Knowledge and cases provide method only and cannot prove a current market trend.',
    '### fallback', '- If time-series or comparable dated sources are unavailable, return a bounded snapshot and record the missing longitudinal evidence instead of asserting change.',
    '### human_confirmation', '- Ask for confirmation when the requested time window, market boundary, or comparison basis materially changes the conclusion.',
  ].join('\n');
  if (entity.id === 'ur-skill-experience-walkthrough') return [
    '## Proposed canonical delta', '',
    '### when_to_use', '- Use for a named page, flow, state, or task path with reviewable materials; do not claim observed behavior without a screenshot, URL, recording, or user-provided artifact.',
    '### scope', '- Freeze entry/exit points, device/state, target user, and included steps before the walkthrough.',
    '### evidence_location', '- Every issue must point to the exact page/state/step and distinguish observed evidence from heuristic inference.',
    '### confidence', '- Mark issues based only on heuristic inference as hypotheses and provide a concrete validation or retest method.',
    '### human_confirmation', '- Require confirmation before handling sensitive screens, authenticated flows, personal data, or any external action.',
  ].join('\n');
  throw new Error(`no approved narrow Skill delta for ${entity.key}`);
}
function mergeDraft(entity: Entity, sourceBody: string, comparison: StructuralComparison, sourceHash: string, targetHash: string): string {
  const frontmatter = {
    format: 'user-research-hub-merge-draft-v1',
    status: 'draft',
    runtime_consumed: false,
    review_gate: 'gate-2',
    source_entity: entity.key,
    source_path: `${LOGICAL_HUB_ROOT}/${entity.source_path}`,
    source_hash: sourceHash,
    canonical_target: entity.target!.path,
    canonical_hash: targetHash,
    disposition: entity.disposition,
    merge_sections: entity.merge_sections,
    distribution_scope: 'evaluation_only',
    managed_by: MANAGED_BY,
  };
  const lines = [
    `# Merge draft: ${entity.key}`,
    '',
    '> Review artifact only. The existing canonical entry remains authoritative; this draft is not loaded by Runtime or the Skill Registry.',
    '',
    '## Structural comparison',
    '',
    `- Source-only headings: ${comparison.source_only_headings.length > 0 ? comparison.source_only_headings.join(' | ') : 'none'}`,
    `- Canonical-only headings: ${comparison.target_only_headings.length > 0 ? comparison.target_only_headings.join(' | ') : 'none'}`,
    `- Shared headings with changed text: ${comparison.changed_shared_headings.length > 0 ? comparison.changed_shared_headings.join(' | ') : 'none'}`,
    '',
    '## Approved narrow delta',
    '',
    narrowSkillDelta(entity),
  ];
  return serializeFrontmatter(frontmatter, lines.join('\n'));
}
function draftPath(entity: Entity): string {
  const file = entity.key.replace(/[^a-z0-9_-]+/giu, '-').replace(/^-|-$/gu, '');
  return `${MERGE_DRAFT_ROOT}/${entity.registry_kind}/${file}.md`;
}
function assertCandidateTarget(entity: Entity): void {
  if (!entity.target || entity.target.status !== 'candidate') {
    throw new Error(`import candidate target is invalid: ${entity.key}`);
  }
  assertLogicalPath(entity.target.path, `candidate target ${entity.key}`);
  if (!CANDIDATE_PREFIXES.some((prefix) => entity.target!.path.startsWith(prefix))) {
    throw new Error(`candidate target is outside the canonical candidate tree: ${entity.key}`);
  }
}

export function buildHubContentApply<TManifest extends Manifest>(
  sourceManifest: TManifest,
  sourceRoot: string,
  repositoryRoot: string,
  profileDraft: ProfileDraft,
): HubContentApplyBuild<TManifest> {
  const manifest = structuredClone(sourceManifest);
  if (manifest.logical_root !== LOGICAL_HUB_ROOT || manifest.gate_1.status !== 'ready'
    || !manifest.gate_1.facts.some(({ id, status }) => id === 'source-rights-not-declared' && status === 'accepted')) {
    throw new Error('Hub content apply requires the accepted Gate-1 internal-evaluation decision');
  }
  const sourceFileByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const files = new Map<string, string>();
  const outputRows: HubContentApplyReport['outputs'] = [];
  const scans: EntityScan[] = [];
  const comparisons: StructuralComparison[] = [];
  const importCandidates = manifest.entities.filter(({ disposition }) => disposition === 'import_candidate')
    .sort((left, right) => compareUtf8(left.key, right.key));
  const mergeEntities = manifest.entities.filter(({ disposition }) => disposition === 'merge_into_existing')
    .sort((left, right) => compareUtf8(left.key, right.key));
  const comparisonEntities = manifest.entities.filter(({ disposition }) => (
    disposition === 'map_existing' || disposition === 'merge_into_existing'
  )).sort((left, right) => compareUtf8(left.key, right.key));
  const sourceBodies = new Map<string, { raw: string; body: string; sourceHash: string; frontmatter: Record<string, unknown> }>();

  for (const entity of [...importCandidates, ...mergeEntities]) {
    validateGovernance(entity);
    const file = sourceFileByPath.get(entity.source_path);
    if (!file || file.media_type !== 'text/markdown' || !HASH_PATTERN.test(file.sha256)) {
      throw new Error(`candidate source is not a manifest-governed Markdown file: ${entity.key}`);
    }
    const raw = readFileSync(join(sourceRoot, ...entity.source_path.split('/')));
    if (sha256Bytes(raw) !== file.sha256) throw new Error(`candidate source hash drift: ${entity.key}`);
    const parsed = parseHubMarkdown(raw.toString('utf8'));
    const body = removeDuplicateOpeningHeading(parsed.content);
    const scan = scanEntity(entity, raw.toString('utf8'), body, parsed.frontmatter);
    scans.push(scan);
    entity.governance!.scans = { ...scan.results };
    entity.governance!.finding_refs = [...scan.finding_refs];
    sourceBodies.set(entity.key, { raw: raw.toString('utf8'), body, sourceHash: file.sha256, frontmatter: parsed.frontmatter });
  }

  for (const entity of importCandidates) {
    assertCandidateTarget(entity);
    const source = sourceBodies.get(entity.key)!;
    const candidateBody = ensureMethodContract(entity, source.body);
    const frontmatter = candidateFrontmatter(entity, source.frontmatter, candidateBody, source.sourceHash, profileDraft);
    const output = serializeFrontmatter(frontmatter, candidateBody);
    if (countMatches(output, LOCAL_PATH_PATTERNS) > 0) {
      throw new Error(`candidate output contains a local path: ${entity.key}`);
    }
    files.set(entity.target!.path, output);
    outputRows.push({ entity_key: entity.key, kind: 'candidate', path: entity.target!.path, sha256: sha256Bytes(output) });
  }

  for (const entity of comparisonEntities) {
    const sourceFile = sourceFileByPath.get(entity.source_path);
    if (!sourceFile) throw new Error(`comparison source is missing: ${entity.key}`);
    const source = sourceBodies.get(entity.key) ?? (() => {
      const raw = readFileSync(join(sourceRoot, ...entity.source_path.split('/')));
      if (sha256Bytes(raw) !== sourceFile.sha256) throw new Error(`comparison source hash drift: ${entity.key}`);
      const parsed = parseHubMarkdown(raw.toString('utf8'));
      return { raw: raw.toString('utf8'), body: removeDuplicateOpeningHeading(parsed.content), sourceHash: sourceFile.sha256, frontmatter: parsed.frontmatter };
    })();
    const comparison = compareStructural(entity, source.body, repositoryRoot);
    comparisons.push(comparison);
    if (entity.disposition === 'merge_into_existing') {
      const target = resolveCanonicalEntry(repositoryRoot, entity.target!.path);
      const output = mergeDraft(entity, source.body, comparison, source.sourceHash, sha256Bytes(target.raw));
      if (countMatches(output, LOCAL_PATH_PATTERNS) > 0) throw new Error(`merge draft contains a local path: ${entity.key}`);
      const path = draftPath(entity);
      files.set(path, output);
      outputRows.push({ entity_key: entity.key, kind: 'merge_draft', path, sha256: sha256Bytes(output) });
    }
  }

  manifest.disposition_hash = dispositionHash(manifest);
  const findingTotals = scans.reduce<ContentFindingCounts>((total, scan) => ({
    secrets: total.secrets + scan.finding_counts.secrets,
    pii: total.pii + scan.finding_counts.pii,
    local_paths: total.local_paths + scan.finding_counts.local_paths,
    internal_business_facts: total.internal_business_facts + scan.finding_counts.internal_business_facts,
  }), { secrets: 0, pii: 0, local_paths: 0, internal_business_facts: 0 });
  outputRows.sort((left, right) => compareUtf8(left.path, right.path));
  scans.sort((left, right) => compareUtf8(left.entity_key, right.entity_key));
  comparisons.sort((left, right) => compareUtf8(left.entity_key, right.entity_key));
  const blockedEntities = scans.filter((scan) => Object.values(scan.results).some(
    (status) => status === 'blocked' || status === 'review_required',
  )).length;
  const report: HubContentApplyReport = {
    format_version: 'user-research-hub-content-apply-v1',
    snapshot_id: manifest.snapshot_id,
    source_tree_hash: manifest.snapshot.tree_hash,
    disposition_hash: manifest.disposition_hash,
    source_mutation_contract: 'read-only-hash-verified',
    gate_1_reuse_scope: 'internal-evaluation-only',
    materialized: {
      candidate_files: importCandidates.length,
      knowledge_methods: importCandidates.filter(({ registry_kind, entity_type }) => registry_kind === 'knowledge' && entity_type === 'method').length,
      scenarios: importCandidates.filter(({ registry_kind }) => registry_kind === 'task').length,
      assets: importCandidates.filter(({ entity_type }) => entity_type === 'template').length,
      draft_skills: importCandidates.filter(({ registry_kind }) => registry_kind === 'skill').length,
    },
    merge_drafts: {
      files: mergeEntities.length,
      skill_files: mergeEntities.filter(({ registry_kind }) => registry_kind === 'skill').length,
      knowledge_files: mergeEntities.filter(({ registry_kind }) => registry_kind === 'knowledge').length,
    },
    mapped_existing: {
      knowledge_entries: manifest.entities.filter(({ disposition, registry_kind }) => disposition === 'map_existing' && registry_kind === 'knowledge').length,
    },
    governance: {
      scanned_entities: scans.length,
      blocked_entities: blockedEntities,
      source_finding_counts: findingTotals,
      gate_2_review_required: blockedEntities > 0,
    },
    runtime_boundary: {
      source_only_materialized: 0,
      reject_runtime_materialized: 0,
      opaque_materialized: 0,
      candidate_status: 'candidate',
      skill_registry_status: 'draft',
    },
    outputs: outputRows,
    scans,
    comparisons,
    output_set_hash: canonicalHash(outputRows),
  };
  files.set(REPORT_PATH, `${JSON.stringify(stableValue(report), null, 2)}\n`);
  return { manifest, files, report };
}

function managedExisting(path: string, raw: string): boolean {
  if (path === REPORT_PATH) {
    try {
      return (JSON.parse(raw) as { format_version?: string }).format_version === 'user-research-hub-content-apply-v1';
    } catch { return false; }
  }
  try {
    const { frontmatter } = parseFrontmatter(raw);
    return (frontmatter.managed_by === MANAGED_BY && frontmatter.status === 'candidate')
      || (frontmatter.managed_by === MANAGED_BY && frontmatter.format === 'user-research-hub-merge-draft-v1');
  } catch { return false; }
}

export function writeHubContentApply(
  build: HubContentApplyBuild,
  repositoryRoot: string,
): { written: number; unchanged: number; removed: number } {
  let written = 0;
  let unchanged = 0;
  let removed = 0;
  const reportAbsolute = repositoryPath(repositoryRoot, REPORT_PATH);
  if (existsSync(reportAbsolute)) {
    const previousRaw = readFileSync(reportAbsolute, 'utf8');
    let previousOutputs: string[] = [];
    try {
      const previous = JSON.parse(previousRaw) as { format_version?: string; outputs?: Array<{ path?: unknown }> };
      if (previous.format_version === 'user-research-hub-content-apply-v1' && Array.isArray(previous.outputs)) {
        previousOutputs = previous.outputs.flatMap((output) => typeof output.path === 'string' ? [output.path] : []);
      }
    } catch { /* The overwrite guard below rejects an unmanaged report. */ }
    for (const stalePath of previousOutputs.filter((path) => !build.files.has(path)).sort(compareUtf8)) {
      const absolute = repositoryPath(repositoryRoot, stalePath);
      if (!existsSync(absolute)) continue;
      const current = readFileSync(absolute, 'utf8');
      if (!managedExisting(stalePath, current)) throw new Error(`refusing to remove an unmanaged canonical path: ${stalePath}`);
      unlinkSync(absolute);
      removed += 1;
    }
  }
  for (const [logicalPath, output] of build.files) {
    const absolute = repositoryPath(repositoryRoot, logicalPath);
    if (!existsSync(absolute)) continue;
    const current = readFileSync(absolute, 'utf8');
    if (current === output) { unchanged += 1; continue; }
    if (!managedExisting(logicalPath, current)) {
      throw new Error(`refusing to overwrite an unmanaged canonical path: ${logicalPath}`);
    }
  }
  for (const [logicalPath, output] of [...build.files.entries()].sort(([left], [right]) => compareUtf8(left, right))) {
    const absolute = repositoryPath(repositoryRoot, logicalPath);
    if (existsSync(absolute) && readFileSync(absolute, 'utf8') === output) continue;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, output, 'utf8');
    written += 1;
  }
  return { written, unchanged, removed };
}

export function checkAppliedHubContent(
  build: HubContentApplyBuild,
  repositoryRoot: string,
): string[] {
  const diagnostics: string[] = [];
  if (build.manifest.disposition_hash !== build.report.disposition_hash) diagnostics.push('content apply disposition hash drift');
  for (const [logicalPath, expected] of build.files) {
    const absolute = repositoryPath(repositoryRoot, logicalPath);
    if (!existsSync(absolute)) diagnostics.push(`content apply output is missing: ${logicalPath}`);
    else if (readFileSync(absolute, 'utf8') !== expected) diagnostics.push(`content apply output drift: ${logicalPath}`);
  }
  return diagnostics.sort(compareUtf8);
}

export const HUB_CONTENT_REPORT_PATH = REPORT_PATH;
export const HUB_MERGE_DRAFT_ROOT = MERGE_DRAFT_ROOT;
