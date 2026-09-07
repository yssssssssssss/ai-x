import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inspectSkillPackage,
  readSkillPackageText,
  SkillPackageDriftError,
} from '../apps/orchestrator-runtime/src/runtime/skill-package.ts';

function packageFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-package-'));
  mkdirSync(join(root, 'references', 'stages'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), [
    '---',
    'name: original-skill',
    'description: An unchanged original Skill package.',
    '---',
    '',
    '# Original Skill',
    '',
    'Read `references/workflow.md` and the files under `references/stages/`.',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'README.md'), '# Package README\n');
  writeFileSync(join(root, 'references', 'workflow.md'), '# Workflow\n');
  writeFileSync(join(root, 'references', 'stages', 'stage-1.md'), '# Stage 1\n');
  return root;
}

test('inspects an unchanged Skill package and discovers explicit relative references', () => {
  const root = packageFixture();
  try {
    const snapshot = inspectSkillPackage({ rootPath: root });
    assert.equal(snapshot.name, 'original-skill');
    assert.equal(snapshot.description, 'An unchanged original Skill package.');
    assert.equal(snapshot.entryPath, 'SKILL.md');
    assert.match(snapshot.packageHash, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(snapshot.files.map(({ path, mediaType }) => ({ path, mediaType })), [
      { path: 'README.md', mediaType: 'text/markdown' },
      { path: 'SKILL.md', mediaType: 'text/markdown' },
      { path: 'references/stages/stage-1.md', mediaType: 'text/markdown' },
      { path: 'references/workflow.md', mediaType: 'text/markdown' },
    ]);
    assert.deepEqual(snapshot.explicitReferences, [
      'references/stages/stage-1.md',
      'references/workflow.md',
    ]);
    assert.equal(readSkillPackageText(snapshot, 'references/workflow.md'), '# Workflow\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changes the package hash when an unreferenced file changes', () => {
  const root = packageFixture();
  try {
    const snapshot = inspectSkillPackage({ rootPath: root });
    writeFileSync(join(root, 'README.md'), '# Changed package README\n');
    assert.notEqual(inspectSkillPackage({ rootPath: root }).packageHash, snapshot.packageHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detects package drift after a frozen file changes', () => {
  const root = packageFixture();
  try {
    const snapshot = inspectSkillPackage({ rootPath: root });
    writeFileSync(join(root, 'references', 'workflow.md'), '# Changed workflow\n');
    assert.throws(
      () => readSkillPackageText(snapshot, 'references/workflow.md'),
      SkillPackageDriftError,
    );
    assert.notEqual(inspectSkillPackage({ rootPath: root }).packageHash, snapshot.packageHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects traversal and symbolic links inside a Skill package', () => {
  const root = packageFixture();
  const outside = join(root, '..', `${root.split('/').at(-1)}-outside.md`);
  try {
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'references', 'link.md'));
    assert.throws(
      () => inspectSkillPackage({ rootPath: root }),
      /symbolic links are not allowed/u,
    );
    rmSync(join(root, 'references', 'link.md'));
    const snapshot = inspectSkillPackage({ rootPath: root });
    assert.throws(
      () => readSkillPackageText(snapshot, '../outside.md'),
      /normalized and relative/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
