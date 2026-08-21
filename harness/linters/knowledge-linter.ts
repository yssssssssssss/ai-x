import { readdirSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadTaxonomy, kbPath } from '../../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';
import { parseFrontmatter } from '../../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { contentHash, inferTypeDomain } from '../../apps/orchestrator-runtime/src/knowledge/normalizer.ts';

export interface LintIssue {
  level: 'error';
  target: string;
  message: string;
}

const REQUIRED = ['id', 'type', 'title', 'source_path', 'content_hash'];
const CANDIDATE_REQUIRED = [
  'hub_snapshot_id',
  'hub_source_path',
  'hub_source_hash',
  'distribution_scope',
  'retention',
  'source_rights',
  'sensitivity',
  'owner',
  'managed_by',
] as const;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LOCAL_PATH_PATTERN = /\[LOCAL_HOME\]\/|(?:^|[\s'"(])\/(?:Users|home|private|var\/folders)\/|[A-Za-z]:\\Users\\/mu;

interface HubCandidateMapping {
  sourcePath: string;
  sourceHash: string;
  governance: {
    distribution_scope: string;
    retention: string;
    source_rights: string;
    sensitivity: string;
    owner: string;
  };
}
let candidateMappings: Map<string, HubCandidateMapping> | undefined;

function loadCandidateMappings(): Map<string, HubCandidateMapping> {
  if (candidateMappings) return candidateMappings;
  const manifestPath = kbPath('knowledge-base/.sources/user-research-hub-2026-08-21.yaml');
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as {
    logical_root: string;
    files: Array<{ path: string; sha256: string }>;
    entities: Array<{
      disposition: string;
      source_path: string;
      target?: { path: string; status: string };
      governance?: HubCandidateMapping['governance'];
    }>;
  };
  const sourceHashes = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  candidateMappings = new Map(manifest.entities.filter((entity) => (
    entity.disposition === 'import_candidate'
    && entity.target?.status === 'candidate'
    && entity.governance !== undefined
  )).map((entity) => [entity.target!.path, {
    sourcePath: `${manifest.logical_root}/${entity.source_path}`,
    sourceHash: sourceHashes.get(entity.source_path) ?? '',
    governance: entity.governance!,
  }]));
  return candidateMappings;
}

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(allStrings);
  return [];
}

export function lintEntry(relPath: string, rawMd: string, seenIds: Set<string>): LintIssue[] {
  const issues: LintIssue[] = [];
  const tgt = relPath;
  const { tags: vocab, guide_stages, knowledge_statuses } = loadTaxonomy();
  const tagVocab = new Set(vocab);
  const stageVocab = new Set(guide_stages);
  const statusVocab = new Set(knowledge_statuses);
  const { frontmatter: fm, content } = parseFrontmatter(rawMd);

  for (const field of REQUIRED) {
    if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
      issues.push({ level: 'error', target: tgt, message: `缺必填字段 "${field}"` });
    }
  }
  const id = fm.id as string | undefined;
  if (id) {
    if (seenIds.has(id)) issues.push({ level: 'error', target: tgt, message: `id 重复: ${id}` });
    else seenIds.add(id);
  }
  // 只校验受控 guide_tags(引导召回用);wiki 原生 tags 是自由中文词表, 不校验。
  for (const tag of (fm.guide_tags as string[] | undefined) ?? []) {
    if (!tagVocab.has(tag)) issues.push({ level: 'error', target: tgt, message: `越界 guide_tag: ${tag}` });
  }
  for (const stage of (fm.guide_stage as string[] | undefined) ?? []) {
    if (!stageVocab.has(stage)) issues.push({ level: 'error', target: tgt, message: `越界 guide_stage: ${stage}` });
  }
  if (typeof fm.status !== 'string' || !statusVocab.has(fm.status)) {
    issues.push({ level: 'error', target: tgt, message: `越界 status: ${String(fm.status)}` });
  }
  if (fm.source_path && fm.source_path !== relPath) {
    issues.push({ level: 'error', target: tgt, message: `source_path 与实际路径不一致: ${fm.source_path}` });
  }
  if (fm.content_hash && fm.content_hash !== contentHash(content)) {
    issues.push({ level: 'error', target: tgt, message: 'content_hash 与正文不匹配' });
  }

  if (fm.status === 'candidate') {
    for (const field of CANDIDATE_REQUIRED) {
      if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
        issues.push({ level: 'error', target: tgt, message: `candidate 缺治理字段 "${field}"` });
      }
    }
    const targetPath = `knowledge-base/${relPath}`;
    const mapping = loadCandidateMappings().get(targetPath);
    if (!mapping) {
      issues.push({ level: 'error', target: tgt, message: 'candidate 不在 Hub import_candidate disposition 中' });
    } else {
      const expected: Record<string, unknown> = {
        hub_source_path: mapping.sourcePath,
        hub_source_hash: mapping.sourceHash,
        distribution_scope: mapping.governance.distribution_scope,
        retention: mapping.governance.retention,
        source_rights: mapping.governance.source_rights,
        sensitivity: mapping.governance.sensitivity,
        owner: mapping.governance.owner,
      };
      for (const [field, value] of Object.entries(expected)) {
        if (fm[field] !== value) issues.push({ level: 'error', target: tgt, message: `candidate ${field} 与 disposition 不一致` });
      }
    }
    if (fm.distribution_scope !== 'evaluation_only') {
      issues.push({ level: 'error', target: tgt, message: 'candidate 只能是 evaluation_only' });
    }
    if (!HASH_PATTERN.test(String(fm.hub_source_hash ?? ''))) {
      issues.push({ level: 'error', target: tgt, message: 'candidate hub_source_hash 非法' });
    }
    const pathValues = [String(fm.source_path ?? ''), String(fm.hub_source_path ?? '')];
    if (pathValues.some((value) => isAbsolute(value) || value.includes('\\') || value.split('/').includes('..'))) {
      issues.push({ level: 'error', target: tgt, message: 'candidate 含非逻辑相对路径' });
    }
    if (allStrings(fm).some((value) => LOCAL_PATH_PATTERN.test(value)) || LOCAL_PATH_PATTERN.test(content)) {
      issues.push({ level: 'error', target: tgt, message: 'candidate 含本机绝对路径或 LOCAL_HOME' });
    }
  }
  return issues;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '.index' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

export function lintKnowledgeBase(): LintIssue[] {
  const root = kbPath('knowledge-base');
  const seen = new Set<string>();
  const issues: LintIssue[] = [];
  for (const full of walk(root)) {
    const rel = relative(root, full).split('\\').join('/');
    const raw = readFileSync(full, 'utf8');
    if (inferTypeDomain(rel) === null && parseFrontmatter(raw).frontmatter.status !== 'candidate') continue; // 导航与普通 Asset 保持既有边界
    issues.push(...lintEntry(rel, raw, seen));
  }
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintKnowledgeBase();
  if (issues.length === 0) { console.log('knowledge-linter: OK'); process.exit(0); }
  console.error(`knowledge-linter: ${issues.length} 个问题:`);
  for (const issue of issues) console.error(`  [${issue.level}] ${issue.target} — ${issue.message}`);
  process.exit(1);
}
