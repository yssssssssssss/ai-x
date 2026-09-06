import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { kbPath } from './taxonomy.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { contentHash } from './normalizer.ts';
import type { KnowledgeIndexItem } from './indexer.ts';
import type { SkillCapability } from '../runtime/config-loader.ts';
import { SkillLoader } from '../runtime/skill-loader.ts';

export interface SearchOpts {
  guide_tags?: string[];
  guide_stage?: string[];
  task_type?: string;
  domain?: string;
  query?: string;
  limit?: number;
}

function applySearchFilters(items: KnowledgeIndexItem[], opts: SearchOpts): KnowledgeIndexItem[] {
  let out = items;
  if (opts.domain) out = out.filter((i) => i.domain.includes(opts.domain!));
  // 结构化过滤走受控 guide_tags(对齐 decision-graph related_tags)
  if (opts.guide_tags?.length) out = out.filter((i) => i.guide_tags.some((t) => opts.guide_tags!.includes(t)));
  if (opts.guide_stage?.length) out = out.filter((i) => i.guide_stage.some((s) => opts.guide_stage!.includes(s)));
  if (opts.query) {
    const q = opts.query.toLowerCase();
    // 关键词匹配含 wiki 原生 tags(丰富中文标签, 召回更强)
    out = out.filter((i) => `${i.title} ${i.summary} ${i.tags.join(' ')}`.toLowerCase().includes(q));
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

// 生产过滤没有 visibility 开关：candidate 与 deprecated 在接口边界被物理移除。
export function filterKnowledge(items: KnowledgeIndexItem[], opts: SearchOpts): KnowledgeIndexItem[] {
  return applySearchFilters(items.filter((item) => item.status === 'approved' || item.status === 'draft'), opts);
}

// Evaluation 是独立接口；显式保留 candidate，但仍排除 deprecated。
export function filterEvaluationKnowledge(items: KnowledgeIndexItem[], opts: SearchOpts): KnowledgeIndexItem[] {
  return applySearchFilters(items.filter((item) => item.status === 'approved' || item.status === 'draft' || item.status === 'candidate'), opts);
}

const RUNTIME_KNOWLEDGE_STATUSES = new Set(['approved', 'draft']);
const EVALUATION_KNOWLEDGE_STATUSES = new Set(['approved', 'draft', 'candidate']);
function assertIndexedKnowledge(items: unknown): KnowledgeIndexItem[] {
  if (!Array.isArray(items)) throw new Error('Knowledge index must be an array');
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Knowledge index entry is malformed');
    const status = (item as { status?: unknown }).status;
    if (status !== 'approved' && status !== 'draft' && status !== 'candidate' && status !== 'deprecated') {
      throw new Error(`Knowledge index entry has invalid or missing status: ${String(status)}`);
    }
  }
  return items as KnowledgeIndexItem[];
}

function loadKnowledgeIndexFile(): KnowledgeIndexItem[] {
  const path = kbPath('knowledge-base/.index/knowledge.json');
  if (!existsSync(path)) return [];
  return assertIndexedKnowledge(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadRuntimeKnowledgeIndex(): KnowledgeIndexItem[] {
  return loadKnowledgeIndexFile().filter((item) => RUNTIME_KNOWLEDGE_STATUSES.has(item.status));
}

export function loadEvaluationKnowledgeIndex(): KnowledgeIndexItem[] {
  return loadKnowledgeIndexFile().filter((item) => EVALUATION_KNOWLEDGE_STATUSES.has(item.status));
}

export function searchKnowledge(opts: SearchOpts): KnowledgeIndexItem[] {
  return applySearchFilters(loadRuntimeKnowledgeIndex(), opts);
}

export function searchEvaluationKnowledge(opts: SearchOpts): KnowledgeIndexItem[] {
  return applySearchFilters(loadEvaluationKnowledgeIndex(), opts);
}

export class KnowledgeSourceAccessError extends Error {
  constructor(
    readonly code: 'missing' | 'path_drift',
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeSourceAccessError';
  }
}

export function resolveKnowledgeSourcePath(
  sourcePath: string,
  knowledgeRoot = kbPath('knowledge-base'),
): string {
  if (
    !sourcePath
    || isAbsolute(sourcePath)
    || sourcePath.includes('\\')
    || sourcePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new KnowledgeSourceAccessError('path_drift', `Knowledge source path is not a normalized relative path: ${sourcePath}`);
  }
  const root = resolve(knowledgeRoot);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new KnowledgeSourceAccessError('missing', 'Knowledge root is unavailable');
  }
  const full = resolve(root, sourcePath);
  const lexicalRelative = relative(root, full);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`)) {
    throw new KnowledgeSourceAccessError('path_drift', `Knowledge source path escapes the Knowledge root: ${sourcePath}`);
  }
  let cursor = root;
  for (const segment of sourcePath.split('/')) {
    cursor = resolve(cursor, segment);
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch {
      throw new KnowledgeSourceAccessError('missing', `Knowledge source is missing: ${sourcePath}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new KnowledgeSourceAccessError('path_drift', `Knowledge source path contains a symlink: ${sourcePath}`);
    }
  }
  const fullReal = realpathSync(full);
  const physicalRelative = relative(rootReal, fullReal);
  if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`)) {
    throw new KnowledgeSourceAccessError('path_drift', `Knowledge source path physically escapes the Knowledge root: ${sourcePath}`);
  }
  if (!statSync(fullReal).isFile()) {
    throw new KnowledgeSourceAccessError('path_drift', `Knowledge source is not a regular file: ${sourcePath}`);
  }
  return fullReal;
}

function readVerifiedKnowledgeEntry(item: KnowledgeIndexItem): { frontmatter: Record<string, unknown>; content: string } {
  const full = resolveKnowledgeSourcePath(item.source_path);
  const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
  if (parsed.frontmatter.id !== item.id) throw new Error(`Knowledge source/index path identity drift for ${item.id}`);
  if (parsed.frontmatter.status !== item.status) throw new Error(`Knowledge source/index status drift for ${item.id}`);
  if (parsed.frontmatter.source_path !== item.source_path) throw new Error(`Knowledge source/index path drift for ${item.id}`);
  if (parsed.frontmatter.content_hash !== item.content_hash || contentHash(parsed.content) !== item.content_hash) {
    throw new Error(`Knowledge source/index content hash drift for ${item.id}`);
  }
  return parsed;
}

export function getEntry(id: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const item = loadRuntimeKnowledgeIndex().find((candidate) => candidate.id === id);
  if (!item) return null;
  return readVerifiedKnowledgeEntry(item);
}

export function getEvaluationEntry(id: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const item = loadEvaluationKnowledgeIndex().find((candidate) => candidate.id === id);
  if (!item) return null;
  return readVerifiedKnowledgeEntry(item);
}

function loadSkills(): SkillCapability[] {
  return new SkillLoader().listActiveSkills();
}

export function listSkills(opts?: { task_type?: string; domain?: string }): SkillCapability[] {
  let out = loadSkills().filter((skill) => skill.status === 'active');
  if (opts?.task_type) out = out.filter((skill) => (skill.task_types ?? []).includes(opts.task_type!));
  return out;
}

export function resolveSkill(name: string): { path: string; frontmatter: Record<string, unknown> } | null {
  const skill = loadSkills().find((candidate) => (
    (candidate.id === name || candidate.name === name) && candidate.status === 'active'
  ));
  const entry = skill?.entry ?? skill?.path;
  if (!entry) return null;
  const full = isAbsolute(entry)
    ? (entry.endsWith('.md') ? entry : `${entry}/SKILL.md`)
    : kbPath(entry.endsWith('.md') ? entry : `${entry}/SKILL.md`);
  if (!existsSync(full)) return null;
  return { path: entry, frontmatter: parseFrontmatter(readFileSync(full, 'utf8')).frontmatter };
}
