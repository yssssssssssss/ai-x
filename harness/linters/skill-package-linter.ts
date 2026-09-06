import { resolve } from 'node:path';
import { SkillPackageStore } from '../../apps/orchestrator-runtime/src/skill-native/package-store.ts';

export interface SkillPackageLintIssue {
  level: 'error';
  target: string;
  message: string;
}

export function lintSkillPackages(root = process.cwd()): SkillPackageLintIssue[] {
  const store = new SkillPackageStore({ sourceRoot: resolve(root, 'skill-packages') });
  const discovered = store.discover();
  const issues = discovered.unavailablePackages.map((item) => ({
    level: 'error' as const,
    target: `skill-package:${item.id}`,
    message: item.reason,
  }));
  if (discovered.packages.length === 0) {
    issues.push({ level: 'error', target: 'skill-packages', message: '没有可用的 Skill 包' });
  }
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintSkillPackages();
  if (issues.length === 0) {
    console.log('skill-package-linter: OK');
    process.exit(0);
  }
  console.error(`skill-package-linter: ${issues.length} error(s)`);
  for (const issue of issues) console.error(`  [${issue.level}] ${issue.target} — ${issue.message}`);
  process.exit(1);
}
