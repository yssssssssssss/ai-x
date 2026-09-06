import { createHash } from 'node:crypto';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { loadTaxonomy } from './taxonomy.ts';

const NAV_FILES = new Set(['index.md', 'readme.md']);

// 路径 → type/domain。导航文件返回 null(不视为条目)。
export function inferTypeDomain(relPath: string): { type: string; domain: string } | null {
  const parts = relPath.split('/');
  const file = parts[parts.length - 1].toLowerCase();
  if (NAV_FILES.has(file)) return null;

  if (parts[0] === 'models') return { type: 'model', domain: 'general' };
  if (parts[0] === 'methods') {
    if (parts[1] === 'standards') return { type: 'standard', domain: 'general' };
    if (parts[1] === 'toolbox' && parts[2] === 'analysis') return { type: 'toolbox-analysis', domain: 'general' };
    if (parts[1] === 'toolbox' && parts[2] === 'collection') return { type: 'toolbox-collection', domain: 'general' };
    if (parts[1] === 'scenarios') return { type: 'scenario', domain: parts[2] ?? 'general' };
  }
  return null;
}

const KEYWORD_TAGS: Array<[RegExp, string[]]> = [
  [/persona|画像|人群/iu, ['persona', 'audience']],
  [/interview|访谈/iu, ['qualitative', 'method']],
  [/survey|questionnaire|问卷|量表/iu, ['quantitative', 'method']],
  [/competitive|竞品|对标/iu, ['business-competitive', 'ui-competitive']],
  [/a11y|accessibility|无障碍/iu, ['a11y', 'ux-audit']],
  [/heuristic|usability|可用性|走查|启发/iu, ['ux-audit']],
  [/report|报告|pyramid|金字塔/iu, ['report', 'output']],
  [/sampling|抽样|recruit|招募|consent|授权|知情/iu, ['audience', 'method', 'privacy', 'compliance']],
  [/goal|目标|question|问题定义|5w2h/iu, ['research_goal']],
  [/privacy|隐私|compliance|合规/iu, ['privacy', 'compliance']],
  [/digital.?human|数字人/iu, ['digital_human']],
  [/jtbd|kano|model|模型|framework|框架/iu, ['framework']],
];

function seededGuidance(type: string, stem: string, title: string): {
  guideTags: string[];
  guideStages: string[];
} {
  const taxonomy = loadTaxonomy();
  const allowedTags = new Set(taxonomy.tags);
  const tags = new Set<string>();
  for (const [pattern, matches] of KEYWORD_TAGS) {
    if (pattern.test(`${stem} ${title}`)) matches.forEach((tag) => tags.add(tag));
  }
  const stages: Record<string, string[]> = {
    model: ['need-discovery'],
    standard: ['output-standard'],
    'toolbox-collection': ['method-selection'],
    'toolbox-analysis': ['method-selection'],
    scenario: ['intent', 'goal-definition'],
  };
  const allowedStages = new Set(taxonomy.guide_stages);
  return {
    guideTags: [...tags].filter((tag) => allowedTags.has(tag)),
    guideStages: (stages[type] ?? []).filter((stage) => allowedStages.has(stage)),
  };
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
  const stem = fileStem(relPath);
  const id = `${td.type.replace(/-/g, '_')}_${stem.replace(/-/g, '_')}`;
  const seed = seededGuidance(td.type, stem, title);

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
  fm.guide_stage = existing.guide_stage ?? seed.guideStages;
  // 无 frontmatter 文件兜底:补最小可索引字段
  fm.type ??= td.type;
  fm.domain ??= td.domain;
  fm.title ??= title;

  const md = serializeFrontmatter(fm, content);
  return { md, changed };
}
