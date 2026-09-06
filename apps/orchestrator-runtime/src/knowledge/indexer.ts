import { parseFrontmatter } from './frontmatter.ts';

export type KnowledgeStatus = 'approved' | 'draft' | 'candidate' | 'deprecated';

export interface KnowledgeIndexItem {
  id: string;
  type: string;
  title: string;
  domain: string[];
  tags: string[];
  guide_tags: string[];
  research_type?: string[];
  guide_stage: string[];
  summary: string;
  source_path: string;
  content_hash: string;
  status: KnowledgeStatus;
}

function status(value: unknown): KnowledgeStatus {
  if (value === 'approved' || value === 'draft' || value === 'candidate' || value === 'deprecated') {
    return value;
  }
  throw new Error(`Knowledge entry has invalid or missing status: ${String(value)}`);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function buildIndex(entries: Array<{ relPath: string; md: string }>): KnowledgeIndexItem[] {
  return entries.flatMap(({ md }): KnowledgeIndexItem[] => {
    const { frontmatter } = parseFrontmatter(md);
    if (!frontmatter.id || frontmatter.type === 'asset' || frontmatter.type === 'skill') return [];
    return [{
      id: String(frontmatter.id),
      type: String(frontmatter.type),
      title: typeof frontmatter.title === 'string' ? frontmatter.title : '',
      domain: Array.isArray(frontmatter.domain)
        ? frontmatter.domain.map(String)
        : frontmatter.domain == null ? [] : [String(frontmatter.domain)],
      tags: strings(frontmatter.tags),
      guide_tags: strings(frontmatter.guide_tags),
      ...(Array.isArray(frontmatter.research_type)
        ? { research_type: frontmatter.research_type.map(String) }
        : {}),
      guide_stage: strings(frontmatter.guide_stage),
      summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : '',
      source_path: String(frontmatter.source_path),
      content_hash: String(frontmatter.content_hash),
      status: status(frontmatter.status),
    }];
  });
}
