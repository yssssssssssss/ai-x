import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { kbPath } from './taxonomy.ts';
import { parseFrontmatter } from './frontmatter.ts';
import type { KnowledgeIndexItem } from './indexer.ts';
import type { SkillRegistryEntry } from '../runtime/config-loader.ts';

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

export function getEntry(id: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const item = loadRuntimeKnowledgeIndex().find((candidate) => candidate.id === id);
  if (!item) return null;
  const full = kbPath('knowledge-base', item.source_path);
  if (!existsSync(full)) return null;
  const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
  if (parsed.frontmatter.status !== item.status) throw new Error(`Knowledge source/index status drift for ${id}`);
  return parsed;
}

export function getEvaluationEntry(id: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const item = loadEvaluationKnowledgeIndex().find((candidate) => candidate.id === id);
  if (!item) return null;
  const full = kbPath('knowledge-base', item.source_path);
  if (!existsSync(full)) return null;
  const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
  if (parsed.frontmatter.status !== item.status) throw new Error(`Knowledge source/index status drift for ${id}`);
  return parsed;
}

function loadSkills(): SkillRegistryEntry[] {
  const path = kbPath('orchestrator/skill-registry.yaml');
  const parsed = parseYaml(readFileSync(path, 'utf8')) as { skills?: SkillRegistryEntry[] };
  return parsed.skills ?? [];
}

export function listSkills(opts?: { task_type?: string; domain?: string }): SkillRegistryEntry[] {
  let out = loadSkills().filter((skill) => skill.status === 'active');
  if (opts?.task_type) out = out.filter((skill) => (skill.task_types ?? []).includes(opts.task_type!));
  return out;
}

export function resolveSkill(name: string): { path: string; frontmatter: Record<string, unknown> } | null {
  const skill = loadSkills().find((candidate) => candidate.name === name && candidate.status === 'active');
  const entry = skill?.entry ?? skill?.path;
  if (!entry) return null;
  const full = kbPath(entry.endsWith('.md') ? entry : `${entry}/SKILL.md`);
  if (!existsSync(full)) return null;
  return { path: entry, frontmatter: parseFrontmatter(readFileSync(full, 'utf8')).frontmatter };
}
