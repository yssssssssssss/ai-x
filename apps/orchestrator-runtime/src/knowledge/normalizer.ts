import { createHash } from 'node:crypto';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { seedTagsGuideStage, seedSkillTaskTypes } from './seed.ts';
import { loadTaxonomy } from './taxonomy.ts';

const NAV_FILES = new Set(['index.md', 'readme.md']);

// 路径 → type/domain。导航文件返回 null(不视为条目)。
export function inferTypeDomain(relPath: string): { type: string; domain: string } | null {
  const parts = relPath.split('/');
  const file = parts[parts.length - 1].toLowerCase();
  if (NAV_FILES.has(file)) return null;

  if (parts[0] === 'models') return { type: 'model', domain: 'general' };
  // skills 下只有 <name>/SKILL.md 是条目;references/*.md、scripts/* 是 skill 的一部分, 不单独索引
  if (parts[0] === 'skills') {
    return file === 'skill.md' ? { type: 'skill', domain: 'general' } : null;
  }
  if (parts[0] === 'methods') {
    if (parts[1] === 'standards') return { type: 'standard', domain: 'general' };
    if (parts[1] === 'toolbox' && parts[2] === 'analysis') return { type: 'toolbox-analysis', domain: 'general' };
    if (parts[1] === 'toolbox' && parts[2] === 'collection') return { type: 'toolbox-collection', domain: 'general' };
    if (parts[1] === 'scenarios') return { type: 'scenario', domain: parts[2] ?? 'general' };
  }
  return null;
}

export function contentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content.trim(), 'utf8').digest('hex');
}

function fileStem(relPath: string): string {
  const file = relPath.split('/').pop() ?? relPath;
  return file.replace(/\.md$/i, '');
}

function firstHeading(content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fileStem(content);
}

// 补机械 frontmatter + 规则种子 tags/guide_stage。正文原样保留。
export function normalizeEntry(relPath: string, rawMd: string): { md: string; changed: boolean } {
  const td = inferTypeDomain(relPath);
  if (!td) return { md: rawMd, changed: false }; // 导航文件不处理

  const { frontmatter: existing, content } = parseFrontmatter(rawMd);
  const hash = contentHash(content);
  const title = firstHeading(content);
  // skill 的身份是其所在文件夹(SKILL.md 恒为同名), 用文件夹名而非文件名 stem, 否则所有 skill id 都塌成 skill_SKILL
  const stem = td.type === 'skill' ? (relPath.split('/').slice(-2)[0] ?? fileStem(relPath)) : fileStem(relPath);
  const id = `${td.type.replace(/-/g, '_')}_${stem.replace(/-/g, '_')}`;
  const seed = seedTagsGuideStage(td.type, stem, title);

  // tags 归一: wiki 原生 tags 多为受控词表之外的自定义标签(linter 会拦),
  // 保留其中在词表内的 + 并入规则种子(种子供 decision-graph 召回), 其余丢弃。
  const { tags: vocab } = loadTaxonomy();
  const tagVocab = new Set(vocab);
  const reconciledTags = existing.tags
    ? [...new Set([...(existing.tags as string[]).filter((t) => tagVocab.has(t)), ...seed.tags])]
    : seed.tags;

  // 已有字段不覆盖(尤其 skills 的 name/description 与人工修正过的字段)
  const fm: Record<string, unknown> = {
    id: existing.id ?? id,
    type: existing.type ?? td.type,
    title: existing.title ?? title,
    domain: existing.domain ?? td.domain,
    tags: reconciledTags,
    guide_stage: existing.guide_stage ?? seed.guide_stage,
    summary: existing.summary ?? '',
    source: existing.source ?? 'xingyun_wiki',
    source_path: relPath,
    content_hash: hash,
    status: existing.status ?? 'approved',
    updated_at: existing.updated_at ?? new Date().toISOString().slice(0, 10),
  };

  const changed = existing.content_hash !== hash
    || existing.source_path !== relPath
    || existing.id === undefined;

  // skill 额外补路由字段(spec §6.2):wiki SKILL.md 无 task_types/inputs/outputs
  if (td.type === 'skill') {
    fm.name = existing.name ?? title;
    fm.description = existing.description ?? '';
    fm.task_types = existing.task_types ?? seedSkillTaskTypes(stem, title);
    fm.inputs = existing.inputs ?? [];
    fm.outputs = existing.outputs ?? [];
  }

  const md = serializeFrontmatter(fm, content);
  return { md, changed };
}
