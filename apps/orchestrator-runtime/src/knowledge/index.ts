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

// 纯函数:可注入数据测试,不碰磁盘。
export function filterKnowledge(items: KnowledgeIndexItem[], opts: SearchOpts): KnowledgeIndexItem[] {
  let out = items.filter((i) => i.status !== 'deprecated');
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

function loadKnowledgeIndex(): KnowledgeIndexItem[] {
  const p = kbPath('knowledge-base/.index/knowledge.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as KnowledgeIndexItem[];
}

export function searchKnowledge(opts: SearchOpts): KnowledgeIndexItem[] {
  return filterKnowledge(loadKnowledgeIndex(), opts);
}

export function getEntry(id: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const item = loadKnowledgeIndex().find((i) => i.id === id);
  if (!item) return null;
  const full = kbPath('knowledge-base', item.source_path);
  if (!existsSync(full)) return null;
  return parseFrontmatter(readFileSync(full, 'utf8'));
}

function loadSkills(): SkillRegistryEntry[] {
  const p = kbPath('orchestrator/skill-registry.yaml');
  const parsed = parseYaml(readFileSync(p, 'utf8')) as { skills?: SkillRegistryEntry[] };
  return parsed.skills ?? [];
}

export function listSkills(opts?: { task_type?: string; domain?: string }): SkillRegistryEntry[] {
  let out = loadSkills().filter((s) => s.status === 'active');
  if (opts?.task_type) out = out.filter((s) => (s.task_types ?? []).includes(opts.task_type!));
  return out;
}

export function resolveSkill(name: string): { path: string; frontmatter: Record<string, unknown> } | null {
  const s = loadSkills().find((x) => x.name === name);
  const entry = s?.entry ?? s?.path;
  if (!entry) return null;
  const full = kbPath(entry.endsWith('.md') ? entry : `${entry}/SKILL.md`);
  if (!existsSync(full)) return null;
  return { path: entry, frontmatter: parseFrontmatter(readFileSync(full, 'utf8')).frontmatter };
}
