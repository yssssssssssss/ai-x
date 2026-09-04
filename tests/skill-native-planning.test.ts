import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  SkillDefinition,
  SolutionDefinition,
} from '../packages/api-contract/skill-native.ts';
import { SkillNativeCatalog } from '../apps/orchestrator-runtime/src/skill-native/catalog.ts';
import {
  resolveSkillInputs,
  type InputMaterial,
} from '../apps/orchestrator-runtime/src/skill-native/input-resolution.ts';
import { buildSolutionPlan } from '../apps/orchestrator-runtime/src/skill-native/plan.ts';

function skill(id: string, options: { required?: boolean; missingPolicy?: 'stop' | 'gap' } = {}): SkillDefinition {
  return {
    version: 'skill-definition-v1',
    id,
    name: id,
    description: `${id} description`,
    whenToUse: `${id} use`,
    inputs: [{
      id: 'shared',
      label: '共享输入',
      description: '两个 Skill 共用',
      required: options.required ?? true,
      multiple: false,
      acceptedSources: ['conversation', 'database'],
      toolIds: [],
      question: '请提供共享输入',
      missingPolicy: options.missingPolicy ?? 'stop',
    }],
    knowledge: [],
    tools: [],
    report: { title: `${id} report`, summaryInstruction: 'summary', sections: ['结果'] },
    allowPartial: true,
    body: `# ${id}`,
    sourcePath: `skills/${id}/SKILL.md`,
    contentHash: `sha256:${id}`,
  };
}

function solution(skills: SkillDefinition[]): SolutionDefinition {
  return {
    version: 'solution-definition-v1',
    id: skills.length === 1 ? 'single' : 'multi',
    title: '方案',
    description: '方案说明',
    whenToUse: '需要时',
    mode: skills.length === 1 ? 'single_skill' : 'multi_skill',
    recommended: true,
    skills: skills.map((item, index) => ({
      skillId: item.id,
      dependsOn: index === skills.length - 1 ? skills.slice(0, index).map(({ id }) => id) : [],
      failurePolicy: index === skills.length - 1 ? 'stop' : 'gap',
    })),
    finalReportSkillId: skills.at(-1)!.id,
    sourcePath: 'orchestrator/solutions/test.yaml',
    contentHash: 'sha256:solution',
  };
}

interface CatalogInputFixture {
  id: string;
  required: boolean;
  multiple?: boolean;
  acceptedSources: Array<'conversation' | 'upload'>;
  missingPolicy: 'stop' | 'replace' | 'gap';
}

function nativeSkill(id: string, inputs: CatalogInputFixture[]): string {
  const inputYaml = inputs.map((input) => `
    - id: ${input.id}
      label: ${input.id}
      description: ${input.id} input
      required: ${input.required}
      multiple: ${input.multiple ?? false}
      accepted_sources: [${input.acceptedSources.join(', ')}]
      question: Provide ${input.id}
      missing_policy: ${input.missingPolicy}`).join('');
  return `---
name: ${id}
description: ${id} description
native_delivery:
  version: 1
  id: ${id}
  allow_partial: true
  inputs:${inputYaml || ' []'}
  knowledge: []
  tools: []
  report:
    title: ${id} report
    summary_instruction: Summarize
    sections: [Result]
---
# ${id}
`;
}

function replacementSolution(id: string, replacementSkillId: string): string {
  return `version: 1
id: ${id}
title: ${id}
description: ${id} solution
when_to_use: Test
mode: single_skill
skills:
  - skill_id: primary
    depends_on: []
    failure_policy: replace
    replacement_skill_id: ${replacementSkillId}
final_report_skill_id: primary
`;
}

test('input resolution follows source priority, rejects cross-scope database data, and asks once', () => {
  const skills = [skill('support'), skill('final')];
  skills[1]!.inputs.push({
    id: 'optional',
    label: '可选资料',
    description: '可降级',
    required: false,
    multiple: false,
    acceptedSources: ['upload', 'database'],
    toolIds: [],
    question: '是否提供可选资料？',
    missingPolicy: 'gap',
  });
  const materials: InputMaterial[] = [
    {
      id: 'foreign', inputId: 'shared', source: 'database', value: '不应读取',
      ownerUserId: 'other', projectId: 'project-a', validUntil: '2099-01-01T00:00:00Z',
    },
    { id: 'upload', inputId: 'shared', source: 'upload', value: '上传值' },
    { id: 'conversation', inputId: 'shared', source: 'conversation', value: '对话值' },
  ];
  const resolved = resolveSkillInputs({
    skills,
    materials,
    scope: { ownerUserId: 'owner', projectId: 'project-a', now: new Date('2026-09-04T00:00:00Z') },
  });

  assert.equal(resolved.inputs.length, 1);
  assert.equal(resolved.inputs[0]?.value, '对话值');
  assert.deepEqual(resolved.inputs[0]?.skillIds, ['support', 'final']);
  assert.deepEqual(resolved.questions.map(({ inputId }) => inputId), ['optional']);
  assert.equal(resolved.warnings.length, 1);

  const confirmed = resolveSkillInputs({
    skills,
    materials,
    unavailableInputIds: ['optional'],
    scope: { ownerUserId: 'owner', projectId: 'project-a', now: new Date('2026-09-04T00:00:00Z') },
  });
  assert.deepEqual(confirmed.blockedInputIds, []);
  assert.deepEqual(confirmed.gaps.map(({ id }) => id), ['input:optional']);

  const wrongCardinality = resolveSkillInputs({
    skills: [skill('single-value')],
    materials: [{ id: 'many', inputId: 'shared', source: 'conversation', value: ['one', 'two'] }],
    scope: { ownerUserId: 'owner', projectId: 'project-a' },
  });
  assert.deepEqual(wrongCardinality.inputs, []);
  assert.deepEqual(wrongCardinality.questions.map(({ inputId }) => inputId), ['shared']);
});

test('required unavailable inputs stop plan creation', () => {
  const required = skill('required');
  const resolution = resolveSkillInputs({
    skills: [required],
    materials: [],
    unavailableInputIds: ['shared'],
    scope: { ownerUserId: 'owner', projectId: 'project' },
  });
  assert.deepEqual(resolution.blockedInputIds, ['shared']);
  assert.throws(() => buildSolutionPlan({
    taskId: 'task',
    solution: solution([required]),
    catalog: { skills: [required] },
    requirement: { version: 'requirement-context-v1', goal: 'goal', scope: [], assumptions: [] },
    resolution,
  }), /required inputs are unavailable/u);
});

test('catalog reloads new definitions while an existing plan keeps its Skill snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-catalog-'));
  try {
    await mkdir(join(root, 'skills', 'example'), { recursive: true });
    await mkdir(join(root, 'skills', 'legacy'), { recursive: true });
    await mkdir(join(root, 'orchestrator', 'solutions'), { recursive: true });
    const definition = (description: string) => `---
name: example
description: ${description}
when_to_use: example use
native_delivery:
  version: 1
  id: example
  allow_partial: true
  inputs:
    - id: shared
      label: Shared
      description: Shared value
      required: true
      accepted_sources: [conversation]
      question: Provide it
      missing_policy: stop
  knowledge: []
  tools: []
  report:
    title: Example report
    summary_instruction: Summarize
    sections: [Result]
---
# Example
${description}
`;
    const skillPath = join(root, 'skills', 'example', 'SKILL.md');
    await writeFile(skillPath, definition('first'));
    await writeFile(join(root, 'skills', 'legacy', 'SKILL.md'), '---\nname: legacy\ndescription: old\n---\n# Legacy\n');
    await writeFile(join(root, 'orchestrator', 'solutions', 'single.yaml'), `version: 1
id: single
title: Single
description: Single solution
when_to_use: Example
mode: single_skill
skills:
  - skill_id: example
    depends_on: []
    failure_policy: stop
final_report_skill_id: example
`);

    const catalog = new SkillNativeCatalog(root);
    const first = catalog.load();
    assert.equal(first.skills.length, 1);
    assert.equal(first.unavailableSkills[0]?.id, 'legacy');
    const resolution = resolveSkillInputs({
      skills: first.skills,
      materials: [{ id: 'conversation', inputId: 'shared', source: 'conversation', value: 'value' }],
      scope: { ownerUserId: 'owner', projectId: 'project' },
    });
    const plan = buildSolutionPlan({
      taskId: 'task',
      solution: first.solutions[0]!,
      catalog: first,
      requirement: { version: 'requirement-context-v1', goal: 'goal', scope: [], assumptions: [] },
      resolution,
    });

    await writeFile(skillPath, definition('second'));
    const second = catalog.load();
    assert.notEqual(second.skills[0]?.contentHash, plan.invocations[0]?.skill.contentHash);
    assert.match(plan.invocations[0]!.skill.body, /first/u);
    assert.match(second.skills[0]!.body, /second/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog isolates malformed Skill frontmatter instead of failing the whole reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-malformed-'));
  try {
    await mkdir(join(root, 'skills', 'valid'), { recursive: true });
    await mkdir(join(root, 'skills', 'broken'), { recursive: true });
    await writeFile(join(root, 'skills', 'valid', 'SKILL.md'), `---
name: valid
description: valid description
native_delivery:
  version: 1
  id: valid
  allow_partial: true
  inputs: []
  knowledge: []
  tools: []
  report:
    title: Valid report
    summary_instruction: Summarize
    sections: [Result]
---
# Valid
`);
    await writeFile(join(root, 'skills', 'broken', 'SKILL.md'), '---\nname: [broken\n---\n# Broken\n');

    const catalog = new SkillNativeCatalog(root).load();
    assert.deepEqual(catalog.skills.map(({ id }) => id), ['valid']);
    assert.equal(catalog.unavailableSkills.length, 1);
    assert.equal(catalog.unavailableSkills[0]?.id, 'broken');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog keeps a Skill when only an optional Tool is inactive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-optional-tool-'));
  const withTool = (id: string, required: boolean) => nativeSkill(id, []).replace(
    'tools: []',
    `tools:\n    - id: missing-tool\n      required: ${required}`,
  );
  try {
    await mkdir(join(root, 'skills', 'optional'), { recursive: true });
    await mkdir(join(root, 'skills', 'required'), { recursive: true });
    await writeFile(join(root, 'skills', 'optional', 'SKILL.md'), withTool('optional', false));
    await writeFile(join(root, 'skills', 'required', 'SKILL.md'), withTool('required', true));

    const catalog = new SkillNativeCatalog(root).load();
    assert.deepEqual(catalog.skills.map(({ id }) => id), ['optional']);
    assert.deepEqual(catalog.unavailableSkills.map(({ id }) => id), ['required']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog isolates a solution whose shared input has no common source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-incompatible-input-'));
  const definition = (id: string, source: 'conversation' | 'upload') => `---
name: ${id}
description: ${id} description
native_delivery:
  version: 1
  id: ${id}
  allow_partial: true
  inputs:
    - id: shared
      label: Shared
      description: Shared value
      required: true
      accepted_sources: [${source}]
      question: Provide it
      missing_policy: stop
  knowledge: []
  tools: []
  report:
    title: ${id} report
    summary_instruction: Summarize
    sections: [Result]
---
# ${id}
`;
  try {
    await mkdir(join(root, 'skills', 'one'), { recursive: true });
    await mkdir(join(root, 'skills', 'two'), { recursive: true });
    await mkdir(join(root, 'orchestrator', 'solutions'), { recursive: true });
    await writeFile(join(root, 'skills', 'one', 'SKILL.md'), definition('one', 'conversation'));
    await writeFile(join(root, 'skills', 'two', 'SKILL.md'), definition('two', 'upload'));
    await writeFile(join(root, 'orchestrator', 'solutions', 'multi.yaml'), `version: 1
id: incompatible
title: Incompatible
description: Incompatible shared input
when_to_use: Never
mode: multi_skill
skills:
  - skill_id: one
    depends_on: []
    failure_policy: gap
  - skill_id: two
    depends_on: [one]
    failure_policy: stop
final_report_skill_id: two
`);

    const catalog = new SkillNativeCatalog(root).load();
    assert.equal(catalog.solutions.length, 0);
    assert.match(catalog.invalidSolutions[0]?.reason ?? '', /shared input shared/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog rejects missing, chained, and stricter replacement contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-replacements-'));
  const goal: CatalogInputFixture = {
    id: 'goal', required: true, acceptedSources: ['conversation'], missingPolicy: 'stop',
  };
  const context: CatalogInputFixture = {
    id: 'context', required: false, acceptedSources: ['conversation', 'upload'], missingPolicy: 'gap',
  };
  try {
    const definitions: Record<string, CatalogInputFixture[]> = {
      primary: [goal, {
        id: 'screenshot', required: true, acceptedSources: ['upload'], missingPolicy: 'replace',
      }, context],
      chained: [goal, {
        id: 'fallback_input', required: false, acceptedSources: ['conversation'], missingPolicy: 'replace',
      }],
      cardinality: [goal, { ...context, multiple: true }],
      required: [goal, { ...context, required: true }],
      stopped: [goal, { ...context, missingPolicy: 'stop' }],
    };
    for (const [id, inputs] of Object.entries(definitions)) {
      await mkdir(join(root, 'skills', id), { recursive: true });
      await writeFile(join(root, 'skills', id, 'SKILL.md'), nativeSkill(id, inputs));
    }
    await mkdir(join(root, 'orchestrator', 'solutions'), { recursive: true });
    const replacements = {
      missing: 'not-installed',
      chained: 'chained',
      cardinality: 'cardinality',
      required: 'required',
      stopped: 'stopped',
    };
    for (const [id, replacementSkillId] of Object.entries(replacements)) {
      await writeFile(
        join(root, 'orchestrator', 'solutions', `${id}.yaml`),
        replacementSolution(id, replacementSkillId),
      );
    }

    const catalog = new SkillNativeCatalog(root).load();
    assert.equal(catalog.solutions.length, 0);
    const reason = (id: string) => catalog.invalidSolutions
      .find(({ sourcePath }) => sourcePath.endsWith(`/${id}.yaml`))?.reason ?? '';
    assert.match(reason('missing'), /replacement skill not-installed is unavailable/u);
    assert.match(reason('chained'), /cannot require another replacement/u);
    assert.match(reason('cardinality'), /context has inconsistent cardinality/u);
    assert.match(reason('required'), /context is stricter than the primary input/u);
    assert.match(reason('stopped'), /context is stricter than the primary input/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog rejects replacement-only shared inputs that conflict with another active Skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-replacement-shared-input-'));
  const goal: CatalogInputFixture = {
    id: 'goal', required: true, acceptedSources: ['conversation'], missingPolicy: 'stop',
  };
  try {
    const definitions: Record<string, CatalogInputFixture[]> = {
      primary: [goal, {
        id: 'screenshot', required: true, acceptedSources: ['upload'], missingPolicy: 'replace',
      }],
      replacement: [goal, {
        id: 'shared_context', required: false, multiple: true,
        acceptedSources: ['conversation'], missingPolicy: 'gap',
      }],
      final: [goal, {
        id: 'shared_context', required: false, multiple: false,
        acceptedSources: ['conversation'], missingPolicy: 'gap',
      }],
    };
    for (const [id, inputs] of Object.entries(definitions)) {
      await mkdir(join(root, 'skills', id), { recursive: true });
      await writeFile(join(root, 'skills', id, 'SKILL.md'), nativeSkill(id, inputs));
    }
    await mkdir(join(root, 'orchestrator', 'solutions'), { recursive: true });
    await writeFile(join(root, 'orchestrator', 'solutions', 'multi.yaml'), `version: 1
id: replacement-shared-input
title: Replacement shared input
description: Replacement shared input
when_to_use: Test
mode: multi_skill
skills:
  - skill_id: primary
    depends_on: []
    failure_policy: replace
    replacement_skill_id: replacement
  - skill_id: final
    depends_on: [primary]
    failure_policy: stop
final_report_skill_id: final
`);

    const catalog = new SkillNativeCatalog(root).load();
    assert.equal(catalog.solutions.length, 0);
    assert.match(catalog.invalidSolutions[0]?.reason ?? '', /shared input shared_context has inconsistent cardinality/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog rejects a Multi solution whose final Skill cannot reach every support Skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-native-disconnected-'));
  try {
    for (const id of ['support', 'orphan', 'final']) {
      await mkdir(join(root, 'skills', id), { recursive: true });
      await writeFile(join(root, 'skills', id, 'SKILL.md'), nativeSkill(id, []));
    }
    await mkdir(join(root, 'orchestrator', 'solutions'), { recursive: true });
    await writeFile(join(root, 'orchestrator', 'solutions', 'disconnected.yaml'), `version: 1
id: disconnected
title: Disconnected
description: Disconnected support
when_to_use: Never
mode: multi_skill
skills:
  - skill_id: support
    depends_on: []
    failure_policy: gap
  - skill_id: orphan
    depends_on: []
    failure_policy: gap
  - skill_id: final
    depends_on: [support]
    failure_policy: stop
final_report_skill_id: final
`);

    const catalog = new SkillNativeCatalog(root).load();
    assert.equal(catalog.solutions.length, 0);
    assert.match(catalog.invalidSolutions[0]?.reason ?? '', /final report skill does not depend on orphan/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production catalog exposes every active Skill and keeps the draft Skill unavailable', () => {
  const catalog = new SkillNativeCatalog().load();
  assert.equal(catalog.skills.length, 25);
  assert.deepEqual(catalog.unavailableSkills.map(({ id }) => id), ['solution-generation']);
  assert.equal(catalog.invalidSolutions.length, 0);
});
