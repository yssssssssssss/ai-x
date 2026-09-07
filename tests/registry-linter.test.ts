import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lintRegistries } from '../harness/linters/registry-linter.ts';
import { getConfigRoot, setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

const realRoot = getConfigRoot();
afterEach(() => setConfigRoot(realRoot));

function fixture(input: {
  bindings?: string;
  decisionGraph?: string;
  toolRegistry?: string;
  packages?: string[];
  toolManifests?: Record<string, string>;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'binding-lint-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), input.bindings ?? 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), input.toolRegistry ?? 'version: 1\ntools: []\n');
  writeFileSync(join(root, 'orchestrator', 'decision-graph.yaml'), input.decisionGraph ?? [
    'version: 1', 'nodes:', '  - key: D1', '    question: q',
    '    applies_to: [competitive_research]', '    tier: core', '',
  ].join('\n'));
  for (const id of input.packages ?? []) {
    const directory = join(root, 'skills', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: Test Skill\n---\n# ${id}\n`);
  }
  for (const [path, content] of Object.entries(input.toolManifests ?? {})) {
    const fullPath = join(root, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

function run(root: string) {
  setConfigRoot(root);
  try {
    return lintRegistries();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('production Skill bindings and installed packages pass the registry gate', () => {
  assert.deepEqual(lintRegistries(), []);
});

test('Skill binding must point to an installed unchanged package', () => {
  const issues = run(fixture({
    bindings: 'version: 1\nskills:\n  - id: missing-skill\n    enabled: true\n    risk_level: low\n',
  }));
  assert.ok(issues.some(({ message }) => message.includes('未找到已安装原版 Skill 包')));
});

test('malformed active Tool binding is rejected', () => {
  const issues = run(fixture({
    packages: ['bound-skill'],
    bindings: [
      'version: 1', 'skills:', '  - id: bound-skill', '    enabled: true',
      '    task_types: [competitive_research]', '    inputs: [research_goal]',
      '    required_tools: [missing-tool]', '    risk_level: low', '',
    ].join('\n'),
  }));
  assert.ok(issues.some(({ message }) => message.includes('未登记的 tool')));
});

test('high-risk Tool without an approver rule is rejected', () => {
  const issues = run(fixture({
    toolRegistry: [
      'version: 1', 'tools:', '  - id: danger', '    name: Danger',
      '    path: tools/danger/tool.yaml', '    status: active', '    tier: core',
      '    adapter_type: test', '    auth_required: false', '    risk_level: high', '',
    ].join('\n'),
    toolManifests: {
      'tools/danger/tool.yaml': 'id: danger\nname: Danger\napprover_rule: none\n',
    },
  }));
  assert.ok(issues.some(({ message }) => message.includes('approver_rule')));
});

test('decision node without a tier is rejected', () => {
  const issues = run(fixture({
    decisionGraph: 'version: 1\nnodes:\n  - key: D1\n    question: q\n    applies_to: [competitive_research]\n',
  }));
  assert.ok(issues.some(({ message }) => message.includes('tier')));
});
