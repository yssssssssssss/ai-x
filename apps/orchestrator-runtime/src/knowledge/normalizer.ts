import { createHash } from 'node:crypto';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { seedTagsGuideStage, seedSkillTaskTypes } from './seed.ts';

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

function firstHeading(content: string, relPath: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fileStem(relPath);
}

// 补机械 frontmatter + 受控 guide_tags/guide_stage 种子。
// 原则:wiki 原生 frontmatter 全量保留(尤其 research_type/owner/related/中文 tags),只增量补齐机械字段。
export function normalizeEntry(relPath: string, rawMd: string): { md: string; changed: boolean } {
  const td = inferTypeDomain(relPath);
  if (!td) return { md: rawMd, changed: false }; // 导航文件不处理

  const { frontmatter: existing, content } = parseFrontmatter(rawMd);
  const hash = contentHash(content);
  const title = firstHeading(content, relPath);
  // skill 的身份是其所在文件夹(SKILL.md 恒为同名), 用文件夹名而非文件名 stem, 否则所有 skill id 都塌成 skill_SKILL
  const stem = td.type === 'skill' ? (relPath.split('/').slice(-2)[0] ?? fileStem(relPath)) : fileStem(relPath);
  const id = `${td.type.replace(/-/g, '_')}_${stem.replace(/-/g, '_')}`;
  const seed = seedTagsGuideStage(td.type, stem, title);

  const changed = existing.content_hash !== hash
    || existing.source_path !== relPath
    || existing.id === undefined;

  // 保留 wiki 原生 frontmatter 全量, 只增量补齐机械/受控字段。
  const fm: Record<string, unknown> = { ...existing };
  fm.id ??= id;
  fm.source ??= 'xingyun_wiki';
  fm.source_path = relPath;       // 始终覆盖为实际路径
  fm.content_hash = hash;         // 始终
  fm.guide_tags = existing.guide_tags ?? seed.guideTags;   // 受控引导标签(独立于 wiki tags)
  fm.guide_stage = existing.guide_stage ?? seed.guide_stage;
  // 无 frontmatter 文件兜底:补最小可索引字段
  fm.type ??= td.type;
  fm.domain ??= td.domain;
  fm.title ??= title;

  // skill 额外补路由字段(spec §6.2):wiki SKILL.md 无 task_types/inputs/outputs/status
  if (td.type === 'skill') {
    fm.name ??= title;
    fm.description ??= '';
    fm.task_types ??= seedSkillTaskTypes(stem, title);
    fm.inputs ??= [];
    fm.outputs ??= [];
    fm.status ??= 'approved'; // registry 需要 status 映射为 active;wiki SKILL.md 缺省视为已发布
  }

  const md = serializeFrontmatter(fm, content);
  return { md, changed };
}
