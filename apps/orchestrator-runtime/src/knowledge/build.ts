import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { kbPath } from './taxonomy.ts';
import { buildIndex } from './indexer.ts';
import { inferTypeDomain } from './normalizer.ts';
import type { SkillRegistryEntry } from '../runtime/config-loader.ts';

export function mergeDerivedSkillRegistryEntries(
  generated: readonly SkillRegistryEntry[],
  existing: readonly SkillRegistryEntry[],
): SkillRegistryEntry[] {
  const overlays = new Map(existing
    .filter(({ path }) => String(path ?? '').startsWith('knowledge-base/'))
    .map((skill) => [skill.id, skill]));
  return generated.map((skill) => ({
    ...overlays.get(skill.id),
    ...skill,
  }));
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '.index' || n.startsWith('.')) continue;
    const full = join(dir, n);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (n.endsWith('.md')) acc.push(full);
  }
  return acc;
}

export function build(): { knowledge: number; skills: number } {
  const root = kbPath('knowledge-base');
  const entries: Array<{ relPath: string; md: string }> = [];
  for (const full of walk(root)) {
    const rel = relative(root, full).split('\\').join('/');
    const isSkill = /\/SKILL\.md$/i.test(rel);
    if (!isSkill && inferTypeDomain(rel) === null) continue; // 导航跳过
    entries.push({ relPath: rel, md: readFileSync(full, 'utf8') });
  }
  const { knowledge, skills } = buildIndex(entries);

  // registry 承载两类能力:KB 派生的 wiki skill(path 在 knowledge-base/ 下)
  // 与编排器原生 skill(手工登记, 带 JSON schema, path 在 skills/ 下, 执行引擎需要)。
  // 只重建 KB 派生部分, 保留原生条目——否则会抹掉编排器可执行的原生能力(破坏既有链路)。
  const registryPath = kbPath('orchestrator/skill-registry.yaml');
  const existing: SkillRegistryEntry[] = existsSync(registryPath)
    ? ((parseYaml(readFileSync(registryPath, 'utf8')) as { skills?: SkillRegistryEntry[] }).skills ?? [])
    : [];
  const native = existing.filter((s) => !String(s.path ?? '').startsWith('knowledge-base/'));
  const derived = mergeDerivedSkillRegistryEntries(skills, existing).map((skill) => {
    const payloadSchema = `${skill.path}/output.schema.json`;
    if (existsSync(kbPath(payloadSchema))) return { ...skill, payload_schema: payloadSchema };
    const withoutStalePayloadSchema = { ...skill };
    delete withoutStalePayloadSchema.payload_schema;
    return withoutStalePayloadSchema;
  });
  const mergedSkills = [...native, ...derived];

  const idxDir = kbPath('knowledge-base/.index');
  mkdirSync(idxDir, { recursive: true });
  writeFileSync(join(idxDir, 'knowledge.json'), JSON.stringify(knowledge, null, 2), 'utf8');
  writeFileSync(
    registryPath,
    '# KB 派生部分由 indexer 生成(源: knowledge-base/skills/*/SKILL.md), 编排器原生 skill(path 在 skills/ 下)保留。\n' +
      stringifyYaml({ version: 1, skills: mergedSkills }),
    'utf8',
  );
  return { knowledge: knowledge.length, skills: mergedSkills.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = build();
  console.log(`kb-build: knowledge ${r.knowledge}, skills ${r.skills}`);
}
