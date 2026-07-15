import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 从 apps/orchestrator-runtime/src/knowledge/ 回到仓库根
const REPO_ROOT = resolve(__dirname, '../../../../');

export function kbPath(...segs: string[]): string {
  return join(REPO_ROOT, ...segs);
}

export interface Taxonomy {
  tags: string[];
  guide_stages: string[];
}

export function loadTaxonomy(): Taxonomy {
  const raw = readFileSync(kbPath('knowledge-base/taxonomy.yaml'), 'utf8');
  const parsed = parseYaml(raw) as { tags?: string[]; guide_stages?: string[] };
  return { tags: parsed.tags ?? [], guide_stages: parsed.guide_stages ?? [] };
}
