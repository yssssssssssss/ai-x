import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KnowledgeMountRegistry } from '../apps/orchestrator-runtime/src/runtime/knowledge-mount.ts';
import { InstalledSkillCatalog } from '../apps/orchestrator-runtime/src/runtime/installed-skill-catalog.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { getConfigRoot, setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

test('resolves an explicitly referenced read-only Knowledge Mount with frozen content', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-mount-'));
  mkdirSync(join(root, 'methods'));
  writeFileSync(join(root, 'methods', 'research.md'), '# Research method\n');
  try {
    const registry = new KnowledgeMountRegistry([{ id: 'research-wiki', rootPath: root }]);
    const references = registry.resolveReferences('Read knowledge://research-wiki/methods/research.md');
    assert.deepEqual(references.map(({ source, sourceId, logicalPath, content }) => ({
      source, sourceId, logicalPath, content,
    })), [{
      source: 'knowledge_mount',
      sourceId: 'research-wiki',
      logicalPath: 'knowledge://research-wiki/methods/research.md',
      content: '# Research method\n',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sees newly added mount data only on the next resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-mount-'));
  writeFileSync(join(root, 'one.md'), '# One\n');
  try {
    const registry = new KnowledgeMountRegistry([{ id: 'shared', rootPath: root }]);
    const first = registry.resolveReferences('Read knowledge://shared/one.md');
    writeFileSync(join(root, 'two.md'), '# Two\n');
    const second = registry.resolveReferences('Read knowledge://shared/one.md and knowledge://shared/two.md');
    assert.deepEqual(first.map(({ path }) => path), ['one.md']);
    assert.deepEqual(second.map(({ path }) => path), ['one.md', 'two.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('freezes mounted knowledge into an unchanged Skill run spec', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'knowledge-mount-run-spec-'));
  const packagesRoot = join(root, 'packages');
  const packageRoot = join(packagesRoot, 'mounted-skill');
  const knowledgeRoot = join(root, 'knowledge');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(knowledgeRoot, { recursive: true });
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), 'version: 1\ntools: []\n');
  writeFileSync(join(knowledgeRoot, 'method.md'), '# Mounted method\n');
  writeFileSync(join(packageRoot, 'SKILL.md'), [
    '---', 'name: mounted-skill', 'description: Use mounted knowledge.', '---',
    '# Mounted Skill', `Read ${realpathSync(join(knowledgeRoot, 'method.md'))} before analysis.`, '## 输出', 'Return Markdown.',
  ].join('\n'));
  try {
    setConfigRoot(root);
    const loader = new SkillLoader(
      new InstalledSkillCatalog([packagesRoot]),
      new KnowledgeMountRegistry([{ id: 'shared', rootPath: knowledgeRoot }]),
    );
    const runSpec = loader.loadNativeRunSpec('mounted-skill');
    const mounted = runSpec.selected_references.find(({ source }) => source === 'knowledge_mount');
    assert.equal(mounted?.logicalPath, 'knowledge://shared/method.md');
    assert.equal(mounted?.content, '# Mounted method\n');
  } finally {
    setConfigRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlink escapes and malformed environment configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-mount-'));
  const outside = `${root}-outside.md`;
  writeFileSync(outside, '# Outside\n');
  symlinkSync(outside, join(root, 'link.md'));
  try {
    const registry = new KnowledgeMountRegistry([{ id: 'shared', rootPath: root }]);
    assert.throws(() => registry.resolveReferences(`Read ${root}`), /symbolic link/u);
    const previous = process.env.SKILL_KNOWLEDGE_MOUNTS;
    process.env.SKILL_KNOWLEDGE_MOUNTS = '[]';
    try {
      assert.throws(() => KnowledgeMountRegistry.fromEnvironment(), /JSON object/u);
    } finally {
      if (previous === undefined) delete process.env.SKILL_KNOWLEDGE_MOUNTS;
      else process.env.SKILL_KNOWLEDGE_MOUNTS = previous;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
