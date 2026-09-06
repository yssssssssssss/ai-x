import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { SkillNativeCandidate } from '../packages/api-contract/skill-native.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillNativeCatalog } from '../apps/orchestrator-runtime/src/skill-native/catalog.ts';
import { SkillPackageStore } from '../apps/orchestrator-runtime/src/skill-native/package-store.ts';
import { buildExecutionPlan } from '../apps/orchestrator-runtime/src/skill-native/plan.ts';
import { RequirementPlanner } from '../apps/orchestrator-runtime/src/skill-native/requirement-planner.ts';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-packages-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function writePackage(root: string, id: string, options: { name?: string; extraFrontmatter?: string } = {}): void {
  const packageRoot = join(root, 'skill-packages', id);
  mkdirSync(join(packageRoot, 'references', 'nested'), { recursive: true });
  mkdirSync(join(packageRoot, 'empty'), { recursive: true });
  writeFileSync(join(packageRoot, 'SKILL.md'), `---
name: ${options.name ?? id}
description: A complete test package for ${id}
status: draft
${options.extraFrontmatter ?? ''}---

# ${id}

Read references/nested/method.md before finishing.
`);
  writeFileSync(join(packageRoot, 'references', 'nested', 'method.md'), '# Method\n');
  writeFileSync(join(packageRoot, 'scripts', '..', 'run.sh'), '#!/bin/sh\nprintf test\n');
  chmodSync(join(packageRoot, 'run.sh'), 0o755);
}

class PlanningLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'mock', endpointHost: 'local', requestedModel: 'mock', mode: 'mock', eligibleAsReal: false,
  };
  readonly calls: StructuredLLMCallOptions[] = [];

  constructor(private readonly responses: unknown[]) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(structuredClone(options));
    if (this.responses.length === 0) throw new Error('missing planning response');
    return {
      data: structuredClone(this.responses.shift()) as T,
      promptHash: 'hash',
      modelName: 'mock',
      modelVersion: 'v1',
      traceId: 'trace',
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('planning must not generate text');
  }
}

function analyzed(shortlistSkillIds: string[]) {
  return {
    goal: 'Understand a market and recommend priorities',
    desiredOutputs: ['Decision-ready report'],
    scope: ['China market'],
    constraints: ['Use supplied evidence'],
    assumptions: [],
    openQuestions: ['Confirm the forecast horizon during execution'],
    needsClarification: false,
    clarifyingQuestion: '',
    shortlistSkillIds,
  };
}

test('Catalog discovers direct child packages without native_delivery and preserves unknown frontmatter', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'research-one', { extraFrontmatter: 'custom_field:\n  nested: true\n' });
  writeFileSync(join(root, 'skill-packages', 'research-one', 'references', 'nested', 'SKILL.md'), 'nested resource');

  const catalog = new SkillNativeCatalog(root).load();

  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0]!.id, 'research-one');
  assert.equal(catalog.skills[0]!.fileCount, 4);
  assert.equal(catalog.skills[0]!.frontmatter.status, 'draft');
  assert.deepEqual(catalog.skills[0]!.frontmatter.custom_field, { nested: true });
  assert.equal(catalog.unavailableSkills.length, 0);
});

test('Package snapshots preserve the full tree and never read a changed source package', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'research-one');
  const store = new SkillPackageStore({
    sourceRoot: join(root, 'skill-packages'),
    snapshotRoot: join(root, 'snapshots'),
  });
  const descriptor = store.discover().packages[0]!;
  const snapshot = store.snapshot('task-1', descriptor);

  assert.equal(snapshot.files.length, 3);
  assert.ok(snapshot.directories.includes('empty'));
  assert.equal(snapshot.files.find(({ path }) => path === 'run.sh')?.executable, true);
  assert.equal(store.read(snapshot, 'references/nested/method.md').toString(), '# Method\n');

  writeFileSync(join(root, 'skill-packages', 'research-one', 'references', 'nested', 'method.md'), '# Changed\n');
  assert.equal(store.read(snapshot, 'references/nested/method.md').toString(), '# Method\n');
  assert.throws(() => store.snapshot('task-2', descriptor), /changed after planning/u);
});

test('Package discovery isolates symlinks and duplicate names', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'first', { name: 'same-name' });
  writePackage(root, 'second', { name: 'same-name' });
  writePackage(root, 'unsafe');
  symlinkSync('/tmp', join(root, 'skill-packages', 'unsafe', 'references', 'escape'));

  const catalog = new SkillNativeCatalog(root).load();

  assert.deepEqual(catalog.skills, []);
  assert.equal(catalog.unavailableSkills.length, 3);
  assert.ok(catalog.unavailableSkills.some(({ id, reason }) => id === 'unsafe' && reason.includes('symlink')));
  assert.equal(catalog.unavailableSkills.filter(({ reason }) => reason.includes('duplicate package name')).length, 2);
});

test('Execution Plan contains immutable package snapshots and serial Multi dependencies', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'first');
  writePackage(root, 'second');
  const packages = new SkillPackageStore({
    sourceRoot: join(root, 'skill-packages'),
    snapshotRoot: join(root, 'snapshots'),
  });
  const descriptors = packages.discover().packages;
  const candidate: SkillNativeCandidate = {
    id: 'multi-first--second',
    title: 'Two skills',
    description: 'Run both',
    rationale: 'Both are needed',
    tradeoffs: 'Takes longer',
    mode: 'multi_skill',
    recommended: true,
    packages: descriptors,
    finalReport: { kind: 'platform_default' },
  };
  const snapshots = descriptors.map((descriptor) => packages.snapshot('task-1', descriptor));

  const plan = buildExecutionPlan({
    taskId: 'task-1',
    candidate,
    snapshots,
    requirement: {
      version: 'requirement-context-v2',
      goal: 'Compare two approaches',
      desiredOutputs: ['Comparison'],
      scope: ['Two approaches'],
      constraints: [],
      materials: [],
      assumptions: [],
      openQuestions: [],
    },
  });

  assert.equal(plan.version, 'skill-native-plan-v2');
  assert.deepEqual(plan.invocations[0]!.dependsOn, []);
  assert.deepEqual(plan.invocations[1]!.dependsOn, [plan.invocations[0]!.id]);
  assert.deepEqual(plan.finalReport, { kind: 'platform_default' });
  assert.equal(readFileSync(join(root, 'snapshots', plan.invocations[0]!.package.snapshotPath, 'SKILL.md'), 'utf8').includes('# first'), true);
});

test('the production catalog contains all 22 original packages without platform metadata', () => {
  const catalog = new SkillNativeCatalog().load();
  assert.equal(catalog.unavailableSkills.length, 0);
  assert.equal(catalog.skills.length, 22);
  assert.deepEqual(catalog.skills.map(({ id }) => id).sort(), [
    'AI-Decision-Lab',
    'accessibility-review',
    'analyze-satisfaction',
    'build-experience-metrics',
    'code-open-feedback',
    'competitive-analysis',
    'conversion-funnel-analysis',
    'feature-adoption-analysis',
    'generate-interview-guide',
    'generate-persona',
    'generate-research-plan',
    'generate-survey',
    'generate-usability-test',
    'industry-market-analysis',
    'issue-prioritization',
    'jobs-to-be-done',
    'journey-map',
    'paihangbang-darkmode',
    'research-screenshot-analyzer',
    'run-heuristic-evaluation',
    'structure-interview-transcript',
    'synthesize-qualitative-insights',
  ]);
  const skill = catalog.skills.find(({ id }) => id === 'industry-market-analysis');
  assert.ok(skill);
  assert.equal(skill.fileCount, 28);
  assert.equal(skill.frontmatter.native_delivery, undefined);
});

test('RequirementPlanner analyzes cards first, then reads shortlisted full SKILL.md for Single candidates', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'market');
  writePackage(root, 'survey');
  const packages = new SkillPackageStore({ sourceRoot: join(root, 'skill-packages') });
  const skills = packages.discover().packages;
  const llm = new PlanningLLM([
    analyzed(['market', 'survey']),
    {
      candidates: [{
        title: 'Market analysis',
        description: 'Use the market method',
        rationale: 'The full instructions cover the requested decision',
        tradeoffs: 'Does not run a survey',
        skillIds: ['market'],
        finalReportSkillId: 'market',
      }],
    },
  ]);

  const result = await new RequirementPlanner({ llm, packages }).plan({
    originalInput: 'Assess the China market',
    mode: 'single_skill',
    skills,
    materials: [],
  });

  assert.equal(result.requirement.goal, 'Understand a market and recommend priorities');
  assert.deepEqual(result.candidates[0]?.packages.map(({ id }) => id), ['market']);
  assert.deepEqual(result.candidates[0]?.finalReport, { kind: 'skill', packageId: 'market' });
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(Object.keys((llm.calls[0]!.context as { catalog: object[] }).catalog[0]!).sort(), [
    'description', 'id', 'name', 'whenToUse',
  ]);
  const inspected = (llm.calls[1]!.context as { candidates: Array<{ skillMarkdown: string }> }).candidates;
  assert.equal(inspected.length, 2);
  assert.match(inspected[0]!.skillMarkdown, /Read references\/nested\/method\.md/u);
});

test('RequirementPlanner collapses duplicate candidate Skill sequences', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'market');
  const packages = new SkillPackageStore({ sourceRoot: join(root, 'skill-packages') });
  const skills = packages.discover().packages;
  const llm = new PlanningLLM([
    analyzed(['market']),
    {
      candidates: [
        {
          title: 'Primary plan', description: 'Use the market method',
          rationale: 'Matches the requested decision', tradeoffs: 'Uses one Skill',
          skillIds: ['market'], finalReportSkillId: 'market',
        },
        {
          title: 'Duplicate plan', description: 'The same Skill sequence',
          rationale: 'No additional capability', tradeoffs: 'Duplicates the first plan',
          skillIds: ['market'], finalReportSkillId: 'market',
        },
      ],
    },
  ]);

  const result = await new RequirementPlanner({ llm, packages }).plan({
    originalInput: 'Assess the market',
    mode: 'single_skill',
    skills,
    materials: [],
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.title, 'Primary plan');
});

test('RequirementPlanner produces ordered serial Multi plans without fixed Solution YAML', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'market');
  writePackage(root, 'survey');
  writePackage(root, 'prioritize');
  const packages = new SkillPackageStore({ sourceRoot: join(root, 'skill-packages') });
  const skills = packages.discover().packages;
  const llm = new PlanningLLM([
    analyzed(['market', 'survey', 'prioritize']),
    {
      candidates: [
        {
          title: 'Research then prioritize', description: 'Two-stage plan',
          rationale: 'Combines evidence and prioritization', tradeoffs: 'More execution time',
          skillIds: ['survey', 'prioritize'], finalReportSkillId: null,
        },
        {
          title: 'Full market path', description: 'Three-stage plan',
          rationale: 'Adds market context', tradeoffs: 'Highest material demand',
          skillIds: ['market', 'survey', 'prioritize'], finalReportSkillId: 'prioritize',
        },
      ],
    },
  ]);

  const result = await new RequirementPlanner({ llm, packages }).plan({
    originalInput: 'Research the market and prioritize opportunities',
    mode: 'multi_skill',
    skills,
    materials: [],
  });

  assert.deepEqual(result.candidates[0]?.packages.map(({ id }) => id), ['survey', 'prioritize']);
  assert.deepEqual(result.candidates[0]?.finalReport, { kind: 'platform_default' });
  assert.deepEqual(result.candidates[1]?.finalReport, { kind: 'skill', packageId: 'prioritize' });
  assert.equal(result.candidates.filter(({ recommended }) => recommended).length, 1);
});

test('RequirementPlanner rejects a final report Skill that runs before downstream Skills', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'market');
  writePackage(root, 'survey');
  const packages = new SkillPackageStore({ sourceRoot: join(root, 'skill-packages') });
  const skills = packages.discover().packages;
  const llm = new PlanningLLM([
    analyzed(['market', 'survey']),
    {
      candidates: [{
        title: 'Invalid report order',
        description: 'Runs more work after the report',
        rationale: 'Invalid fixture',
        tradeoffs: 'The report cannot see downstream Artifacts',
        skillIds: ['market', 'survey'],
        finalReportSkillId: 'market',
      }],
    },
  ]);

  await assert.rejects(
    new RequirementPlanner({ llm, packages }).plan({
      originalInput: 'Research the market and survey users',
      mode: 'multi_skill',
      skills,
      materials: [],
    }),
    /最终报告 Skill 必须是候选方案的最后一个 Skill/u,
  );
});

test('RequirementPlanner sends explicit $skill requests directly to the package without an LLM call', async () => {
  const root = await temporaryRoot();
  writePackage(root, 'market');
  const packages = new SkillPackageStore({ sourceRoot: join(root, 'skill-packages') });
  const skills = packages.discover().packages;
  const llm = new PlanningLLM([]);

  const result = await new RequirementPlanner({ llm, packages }).plan({
    originalInput: 'Compare pet retail',
    mode: 'single_skill',
    skills,
    materials: [],
    requestedSkillId: 'MARKET',
  });

  assert.equal(result.requirement.goal, 'Compare pet retail');
  assert.equal(result.candidates[0]?.packages[0]?.id, 'market');
  assert.equal(llm.calls.length, 0);
});
