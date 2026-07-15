import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadTaxonomy, kbPath } from '../../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';
import { parseFrontmatter } from '../../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { contentHash, inferTypeDomain } from '../../apps/orchestrator-runtime/src/knowledge/normalizer.ts';

export interface LintIssue {
  level: 'error';
  target: string;
  message: string;
}

const REQUIRED = ['id', 'type', 'title', 'source_path', 'content_hash'];

export function lintEntry(relPath: string, rawMd: string, seenIds: Set<string>): LintIssue[] {
  const issues: LintIssue[] = [];
  const tgt = relPath;
  const { tags: vocab, guide_stages } = loadTaxonomy();
  const tagVocab = new Set(vocab);
  const stageVocab = new Set(guide_stages);
  const { frontmatter: fm, content } = parseFrontmatter(rawMd);

  for (const f of REQUIRED) {
    if (fm[f] === undefined || fm[f] === null || fm[f] === '') {
      issues.push({ level: 'error', target: tgt, message: `缺必填字段 "${f}"` });
    }
  }
  const id = fm.id as string | undefined;
  if (id) {
    if (seenIds.has(id)) issues.push({ level: 'error', target: tgt, message: `id 重复: ${id}` });
    else seenIds.add(id);
  }
  // 只校验受控 guide_tags(引导召回用);wiki 原生 tags 是自由中文词表, 不校验。
  for (const t of (fm.guide_tags as string[] | undefined) ?? []) {
    if (!tagVocab.has(t)) issues.push({ level: 'error', target: tgt, message: `越界 guide_tag: ${t}` });
  }
  for (const s of (fm.guide_stage as string[] | undefined) ?? []) {
    if (!stageVocab.has(s)) issues.push({ level: 'error', target: tgt, message: `越界 guide_stage: ${s}` });
  }
  if (fm.source_path && fm.source_path !== relPath) {
    issues.push({ level: 'error', target: tgt, message: `source_path 与实际路径不一致: ${fm.source_path}` });
  }
  if (fm.content_hash && fm.content_hash !== contentHash(content)) {
    issues.push({ level: 'error', target: tgt, message: `content_hash 与正文不匹配` });
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
    if (inferTypeDomain(rel) === null) continue; // 导航文件跳过
    issues.push(...lintEntry(rel, readFileSync(full, 'utf8'), seen));
  }
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintKnowledgeBase();
  if (issues.length === 0) { console.log('knowledge-linter: OK'); process.exit(0); }
  console.error(`knowledge-linter: ${issues.length} 个问题:`);
  for (const it of issues) console.error(`  [${it.level}] ${it.target} — ${it.message}`);
  process.exit(1);
}
