import { parseFrontmatter } from './frontmatter.ts';
import type { SkillRegistryEntry } from '../runtime/config-loader.ts';

export interface KnowledgeIndexItem {
  id: string;
  type: string;
  title: string;
  domain: string[];
  tags: string[];           // wiki 原生自由中文标签(关键词检索)
  guide_tags: string[];     // 受控引导标签(decision-graph 召回)
  research_type?: string[]; // wiki 原生, 可选
  guide_stage: string[];
  summary: string;
  source_path: string;
  content_hash: string;
  status: string;
}

// status 映射:知识库用 approved/draft/deprecated,registry 用 active/draft/deprecated
function toRegistryStatus(s: unknown): SkillRegistryEntry['status'] {
  return s === 'approved' || s === 'active' ? 'active' : s === 'deprecated' ? 'deprecated' : 'draft';
}

export function buildIndex(entries: Array<{ relPath: string; md: string }>): {
  knowledge: KnowledgeIndexItem[];
  skills: SkillRegistryEntry[];
} {
  const knowledge: KnowledgeIndexItem[] = [];
  const skills: SkillRegistryEntry[] = [];

  for (const { relPath, md } of entries) {
    const { frontmatter: fm } = parseFrontmatter(md);
    if (fm.type === 'skill') {
      const folder = relPath.replace(/\/SKILL\.md$/i, '');
      skills.push({
        id: fm.name as string,
        name: fm.name as string,
        path: `knowledge-base/${folder}`,
        entry: `knowledge-base/${relPath}`,
        when_to_use: (fm.description as string) ?? '',
        owner: (fm.owner as string) ?? '用研团队',
        risk_level: (fm.risk_level as SkillRegistryEntry['risk_level']) ?? 'low',
        task_types: (fm.task_types as string[]) ?? [],
        status: toRegistryStatus(fm.status),
      });
    } else if (fm.id && fm.type !== 'asset') {
      const domain = Array.isArray(fm.domain)
        ? fm.domain.map(String)
        : fm.domain != null
          ? [String(fm.domain)]
          : [];
      knowledge.push({
        id: fm.id as string,
        type: fm.type as string,
        title: (fm.title as string) ?? '',
        domain,
        tags: (fm.tags as string[]) ?? [],
        guide_tags: (fm.guide_tags as string[]) ?? [],
        research_type: fm.research_type as string[] | undefined,
        guide_stage: (fm.guide_stage as string[]) ?? [],
        summary: (fm.summary as string) ?? '',
        source_path: fm.source_path as string,
        content_hash: fm.content_hash as string,
        status: (fm.status as string) ?? 'approved',
      });
    }
  }
  return { knowledge, skills };
}
