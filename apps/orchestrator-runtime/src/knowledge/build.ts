import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { kbPath } from './taxonomy.ts';
import { buildIndex } from './indexer.ts';
import { inferTypeDomain } from './normalizer.ts';

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '.index' || name.startsWith('.')) continue;
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) walk(fullPath, acc);
    else if (name.endsWith('.md')) acc.push(fullPath);
  }
  return acc;
}

export function build(): { knowledge: number; skills: number } {
  const root = kbPath('knowledge-base');
  const entries: Array<{ relPath: string; md: string }> = [];
  for (const fullPath of walk(root)) {
    const relPath = relative(root, fullPath).split('\\').join('/');
    const isSkill = /\/SKILL\.md$/iu.test(relPath);
    if (!isSkill && inferTypeDomain(relPath) === null) continue;
    entries.push({ relPath, md: readFileSync(fullPath, 'utf8') });
  }
  const { knowledge, skills } = buildIndex(entries);
  const indexDirectory = kbPath('knowledge-base/.index');
  mkdirSync(indexDirectory, { recursive: true });
  writeFileSync(join(indexDirectory, 'knowledge.json'), JSON.stringify(knowledge, null, 2), 'utf8');
  return { knowledge: knowledge.length, skills: skills.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = build();
  console.log(`kb-build: knowledge ${result.knowledge}, discovered Skill packages ${result.skills}`);
}
