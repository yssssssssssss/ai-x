import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillCapability } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { loadEvaluationCases } from '../evaluations/skills/case-loader.ts';
import type { SkillEvaluationCase } from '../evaluations/skills/types.ts';

const active = [
  { id: 'alpha', status: 'active' },
  { id: 'beta', status: 'active' },
] as SkillCapability[];

function validCase(skillId: string): SkillEvaluationCase {
  return {
    skill_id: skillId,
    title: `${skillId} evaluation`,
    research_goal: `Evaluate ${skillId}`,
    input_materials: { brief: `${skillId} input` },
    tool_outputs: [{ source: `${skillId} fixture` }],
    expected_deliverables: ['A grounded answer'],
    risk_checks: ['Do not invent evidence'],
  };
}

function makeCasesDir(): string {
  return mkdtempSync(join(tmpdir(), 'skill-eval-cases-'));
}

function writeCase(casesDir: string, filename: string, value: unknown): string {
  const sourcePath = join(casesDir, filename);
  writeFileSync(sourcePath, JSON.stringify(value, null, 2), 'utf8');
  return sourcePath;
}

test('loads cases in active Skill order and hashes exact file bytes', () => {
  const casesDir = makeCasesDir();
  const betaPath = writeCase(casesDir, 'beta.json', validCase('beta'));
  const alphaPath = writeCase(casesDir, 'alpha.json', validCase('alpha'));
  writeFileSync(join(casesDir, 'README.txt'), '{ not JSON }', 'utf8');

  const loaded = loadEvaluationCases(active, casesDir);

  assert.deepEqual([...loaded.keys()], ['alpha', 'beta']);
  assert.equal(loaded.get('alpha')?.sourcePath, alphaPath);
  assert.equal(loaded.get('beta')?.sourcePath, betaPath);
  const exactBytes = JSON.stringify(validCase('alpha'), null, 2);
  assert.equal(
    loaded.get('alpha')?.caseHash,
    `sha256:${createHash('sha256').update(exactBytes).digest('hex')}`,
  );
  assert.match(loaded.get('alpha')?.caseHash ?? '', /^sha256:[a-f0-9]{64}$/);
});

test('ignores directories whose names end in .json', () => {
  const casesDir = makeCasesDir();
  writeCase(casesDir, 'alpha.json', validCase('alpha'));
  mkdirSync(join(casesDir, 'archive.json'));

  const loaded = loadEvaluationCases([active[0]], casesDir);

  assert.deepEqual([...loaded.keys()], ['alpha']);
});

test('changes caseHash when the JSON file content changes', () => {
  const casesDir = makeCasesDir();
  const alphaPath = writeCase(casesDir, 'alpha.json', validCase('alpha'));
  writeCase(casesDir, 'beta.json', validCase('beta'));
  const before = loadEvaluationCases(active, casesDir).get('alpha')?.caseHash;

  writeFileSync(alphaPath, `${JSON.stringify(validCase('alpha'), null, 2)}\n`, 'utf8');
  const after = loadEvaluationCases(active, casesDir).get('alpha')?.caseHash;

  assert.notEqual(after, before);
});

test('reports every missing active Skill case deterministically', () => {
  const casesDir = makeCasesDir();
  writeCase(casesDir, 'alpha.json', validCase('alpha'));

  assert.throws(
    () => loadEvaluationCases(active, casesDir),
    new Error('missing cases: beta'),
  );
});

test('reports missing cases deterministically when casesDir does not exist', () => {
  const casesDir = join(makeCasesDir(), 'missing');

  assert.throws(
    () => loadEvaluationCases(active, casesDir),
    new Error('missing cases: alpha, beta'),
  );
});

test('reports every unknown case deterministically', () => {
  const casesDir = makeCasesDir();
  writeCase(casesDir, 'alpha.json', validCase('alpha'));
  writeCase(casesDir, 'beta.json', validCase('beta'));
  writeCase(casesDir, 'zeta.json', validCase('zeta'));
  writeCase(casesDir, 'ghost.json', validCase('ghost'));

  assert.throws(
    () => loadEvaluationCases(active, casesDir),
    new Error('unknown cases: ghost, zeta'),
  );
});

const malformedFields: Array<{
  field: keyof SkillEvaluationCase;
  value: unknown;
  message: string;
}> = [
  { field: 'skill_id', value: '', message: 'skill_id must be a non-empty string' },
  { field: 'title', value: '', message: 'title must be a non-empty string' },
  {
    field: 'research_goal',
    value: null,
    message: 'research_goal must be a non-empty string',
  },
  {
    field: 'input_materials',
    value: [],
    message: 'input_materials must be an object',
  },
  {
    field: 'tool_outputs',
    value: [null],
    message: 'tool_outputs must be an array of objects',
  },
  {
    field: 'expected_deliverables',
    value: [],
    message: 'expected_deliverables must be a non-empty string array',
  },
  {
    field: 'risk_checks',
    value: [1],
    message: 'risk_checks must be a string array',
  },
];

for (const { field, value, message } of malformedFields) {
  test(`rejects malformed ${field}`, () => {
    const casesDir = makeCasesDir();
    writeCase(casesDir, 'alpha.json', { ...validCase('alpha'), [field]: value });

    assert.throws(
      () => loadEvaluationCases([active[0]], casesDir),
      new Error(`invalid case alpha.json: ${message}`),
    );
  });
}

test('rejects invalid JSON with a stable filename-scoped error', () => {
  const casesDir = makeCasesDir();
  writeFileSync(join(casesDir, 'alpha.json'), '{', 'utf8');

  assert.throws(
    () => loadEvaluationCases([active[0]], casesDir),
    new Error('invalid case alpha.json: invalid JSON'),
  );
});

test('requires skill_id to match the JSON filename', () => {
  const casesDir = makeCasesDir();
  writeCase(casesDir, 'alpha.json', validCase('beta'));

  assert.throws(
    () => loadEvaluationCases([active[0]], casesDir),
    new Error('invalid case alpha.json: skill_id must match filename: alpha'),
  );
});

test('rejects duplicate skill IDs deterministically', () => {
  const casesDir = makeCasesDir();
  writeCase(casesDir, 'alpha.json', validCase('alpha'));
  writeCase(casesDir, '0.json', validCase('alpha'));

  assert.throws(
    () => loadEvaluationCases([active[0]], casesDir),
    new Error('duplicate case ids: alpha'),
  );
});

test('source paths identify the sorted JSON fixture filenames', () => {
  const casesDir = makeCasesDir();
  writeCase(casesDir, 'beta.json', validCase('beta'));
  writeCase(casesDir, 'alpha.json', validCase('alpha'));

  assert.deepEqual(
    [...loadEvaluationCases(active, casesDir).values()].map(({ sourcePath }) =>
      basename(sourcePath),
    ),
    ['alpha.json', 'beta.json'],
  );
});

test('real evaluation corpus covers every active Skill in registry order', () => {
  const activeSkills = new SkillLoader().listActiveSkills();
  const cases = loadEvaluationCases(activeSkills);

  assert.equal(activeSkills.length, 25);
  assert.equal(cases.size, activeSkills.length);
  assert.deepEqual(
    [...cases.keys()],
    activeSkills.map((skill) => skill.id),
  );
});
