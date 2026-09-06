import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { kbPath } from './taxonomy.ts';
import { buildIndex } from './indexer.ts';
import { inferTypeDomain } from './normalizer.ts';

function markdownFiles(directory: string, result: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (name === '.index' || name.startsWith('.')) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) markdownFiles(path, result);
    else if (name.endsWith('.md')) result.push(path);
  }
  return result;
}

export function build(): { knowledge: number } {
  const root = kbPath('knowledge-base');
  const entries = markdownFiles(root).flatMap((path) => {
    const relPath = relative(root, path).split('\\').join('/');
    return inferTypeDomain(relPath) === null
      ? []
      : [{ relPath, md: readFileSync(path, 'utf8') }];
  });
  const knowledge = buildIndex(entries);
  const indexDirectory = kbPath('knowledge-base/.index');
  mkdirSync(indexDirectory, { recursive: true });
  writeFileSync(join(indexDirectory, 'knowledge.json'), JSON.stringify(knowledge, null, 2), 'utf8');
  return { knowledge: knowledge.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = build();
  console.log(`kb-build: knowledge ${result.knowledge}`);
}
