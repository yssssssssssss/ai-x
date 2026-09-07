import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const USER_FLOW_FILES = [
  'apps/web/src/components/Composer.tsx',
  'apps/web/src/components/MultiSkillPlanSummary.tsx',
  'apps/web/src/components/stages/CurrentStage1Clarify.tsx',
  'apps/web/src/components/stages/Stage1Understand.tsx',
  'apps/web/src/components/stages/Stage2Plan.tsx',
  'apps/web/src/components/stages/Stage3Execute.tsx',
  'apps/web/src/components/stages/NativeStage4Report.tsx',
  'apps/web/src/pages/Workbench.tsx',
] as const;

test('current user flow avoids internal orchestration terms in visible copy', () => {
  const source = USER_FLOW_FILES.map((path) => readFileSync(join(process.cwd(), path), 'utf8')).join('\n');
  for (const forbidden of [
    'Tool Binding',
    'Skill 明细',
    '多 Skill 协作',
    '单 Skill',
    'Required Coverage',
    '>Contributor<',
    '>Synthesizer<',
    '可见 Gap',
    'Current 任务',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
