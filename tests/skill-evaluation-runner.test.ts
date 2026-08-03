import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import type { AgentRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import {
  runEvaluationBatch,
  runEvaluationCli,
} from '../evaluations/skills/run.ts';
import type {
  EvaluationManifest,
  LoadedEvaluationCase,
  SkillEvaluationRecord,
  SkillScorecard,
} from '../evaluations/skills/types.ts';

function activeSkill(id: string): SkillRegistryEntry {
  return {
    id,
    name: id.toUpperCase(),
    path: `skills/${id}/SKILL.md`,
    when_to_use: 'test',
    owner: 'test',
    status: 'active',
    risk_level: 'low',
  };
}

function evaluationCase(skillId: string) {
  return {
    skill_id: skillId,
    title: `${skillId} evaluation`,
    research_goal: `Evaluate ${skillId}`,
    input_materials: { prompt: `${skillId} input` },
    tool_outputs: [{ source: `${skillId} fixture` }],
    expected_deliverables: ['Grounded output'],
    risk_checks: ['No invented evidence'],
  };
}

function scorecard(
  skillId: string,
  totalScore = 90,
  overrides: Partial<SkillScorecard> = {},
): SkillScorecard {
  return {
    skill_id: skillId,
    total_score: totalScore,
    verdict: totalScore >= 80 ? 'pass' : 'needs_review',
    dimensions: [],
    critical_defects: [],
    review_notes: [],
    ...overrides,
  };
}

function successRecord(
  loadedCase: LoadedEvaluationCase,
  overrides: Partial<SkillEvaluationRecord> = {},
): SkillEvaluationRecord {
  const skillId = loadedCase.data.skill_id;
  return {
    skillId,
    skillHash: `sha256:${skillId}`,
    caseHash: loadedCase.caseHash,
    modelName: 'test-model',
    modelVersion: 'v1',
    elapsedMs: 12,
    status: 'succeeded',
    output: {
      answer: `${skillId} answer`,
      nested: { raw: ['preserved', skillId] },
    },
    scorecard: scorecard(skillId),
    ...overrides,
  };
}

function fixture(skillIds: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'skill-evaluation-runner-'));
  const casesDir = join(root, 'cases');
  const outputRoot = join(root, 'output');
  mkdirSync(casesDir);
  for (const skillId of skillIds) {
    writeFileSync(
      join(casesDir, `${skillId}.json`),
      `${JSON.stringify(evaluationCase(skillId), null, 2)}\n`,
      'utf8',
    );
  }
  const activeSkills = skillIds.map(activeSkill);
  return {
    root,
    casesDir,
    outputRoot,
    activeSkills,
    skillLoader: {
      listActiveSkills: () => activeSkills,
    },
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('writes complete atomic artifacts and summaries while preserving registry order', async () => {
  const setup = fixture(['alpha', 'beta']);
  const evaluated: string[] = [];
  const manifest = await runEvaluationBatch(
    {
      runId: 'test-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 2,
      resume: false,
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          const skillId = loadedCase.data.skill_id;
          evaluated.push(skillId);
          if (skillId === 'alpha') await delay(20);
          return successRecord(loadedCase, {
            scorecard: scorecard(skillId, skillId === 'alpha' ? 75 : 95, {
              review_notes: skillId === 'alpha' ? ['Ask "manual" reviewer'] : [],
            }),
          });
        },
      },
      provider: 'test-provider',
      clock: () => new Date('2026-08-04T01:02:03.000Z'),
    },
  );

  assert.deepEqual(evaluated.sort(), ['alpha', 'beta']);
  assert.equal(manifest.status, 'completed');
  assert.deepEqual(
    manifest.records.map(({ skillId }) => skillId),
    ['alpha', 'beta'],
  );
  assert.deepEqual(manifest.counts, {
    succeeded: 2,
    needs_review: 0,
    failed: 0,
    skipped: 0,
  });

  const runDir = join(setup.outputRoot, 'test-run');
  for (const skillId of ['alpha', 'beta']) {
    const skillDir = join(runDir, skillId);
    for (const filename of [
      'input.json',
      'output.json',
      'output.md',
      'scorecard.json',
    ]) {
      assert.equal(existsSync(join(skillDir, filename)), true, `${skillId}/${filename}`);
    }
    assert.equal(
      readdirSync(skillDir).some((filename) => filename.includes('.tmp-')),
      false,
    );
    const output = readJson<Record<string, unknown>>(join(skillDir, 'output.json'));
    assert.deepEqual(output, successRecord({
      data: evaluationCase(skillId),
      sourcePath: '',
      caseHash: '',
    }).output);
    const markdown = readFileSync(join(skillDir, 'output.md'), 'utf8');
    assert.match(markdown, new RegExp(`^# ${skillId} evaluation output`, 'm'));
    assert.match(markdown, /```json/);
    assert.match(markdown, /"raw": \[/);
  }

  const persistedManifest = readJson<EvaluationManifest>(join(runDir, 'manifest.json'));
  assert.deepEqual(persistedManifest, manifest);
  const summaryMarkdown = readFileSync(join(runDir, 'summary.md'), 'utf8');
  const summaryCsv = readFileSync(join(runDir, 'summary.csv'), 'utf8');
  for (const skillId of ['alpha', 'beta']) {
    assert.match(summaryMarkdown, new RegExp(skillId));
    assert.match(summaryCsv, new RegExp(skillId));
  }
  assert.match(summaryMarkdown, /自动评分仅供人工评估参考/);
  assert.match(summaryCsv, /自动评分仅供人工评估参考/);
  assert.ok(summaryMarkdown.indexOf('beta') < summaryMarkdown.indexOf('alpha'));
  assert.match(summaryCsv, /"Ask ""manual"" reviewer"/);
});

test('records one failure, continues later Skills, and completes with failures', async () => {
  const setup = fixture(['alpha', 'beta', 'gamma']);
  const evaluated: string[] = [];
  const manifest = await runEvaluationBatch(
    {
      runId: 'failure-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: false,
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          const skillId = loadedCase.data.skill_id;
          evaluated.push(skillId);
          if (skillId === 'beta') throw new Error('synthetic evaluator failure');
          return successRecord(loadedCase);
        },
      },
      clock: () => new Date('2026-08-04T02:00:00.000Z'),
    },
  );

  assert.deepEqual(evaluated, ['alpha', 'beta', 'gamma']);
  assert.equal(manifest.status, 'completed_with_failures');
  assert.deepEqual(
    manifest.records.map(({ skillId, status }) => [skillId, status]),
    [
      ['alpha', 'succeeded'],
      ['beta', 'failed'],
      ['gamma', 'succeeded'],
    ],
  );
  assert.deepEqual(manifest.counts, {
    succeeded: 2,
    needs_review: 0,
    failed: 1,
    skipped: 0,
  });

  const runDir = join(setup.outputRoot, 'failure-run');
  const failedDir = join(runDir, 'beta');
  assert.equal(existsSync(join(failedDir, 'input.json')), true);
  assert.equal(existsSync(join(failedDir, 'error.json')), true);
  assert.equal(existsSync(join(failedDir, 'output.json')), false);
  assert.match(
    readFileSync(join(failedDir, 'error.json'), 'utf8'),
    /synthetic evaluator failure/,
  );
  assert.equal(existsSync(join(runDir, 'gamma', 'output.json')), true);
  assert.match(readFileSync(join(runDir, 'summary.md'), 'utf8'), /beta/);
});

test('resume skips only a complete parseable result and retains score and model metadata', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'resume-run');
  const skillDir = join(runDir, 'alpha');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'output.json'), '{"answer":"existing"}\n');
  writeFileSync(
    join(skillDir, 'scorecard.json'),
    `${JSON.stringify(scorecard('alpha', 88))}\n`,
  );
  const previousRecord: SkillEvaluationRecord = {
    skillId: 'alpha',
    skillHash: 'sha256:previous-skill',
    caseHash: 'sha256:previous-case',
    modelName: 'resume-model',
    modelVersion: 'resume-v2',
    elapsedMs: 44,
    status: 'succeeded',
    output: { answer: 'existing' },
    scorecard: scorecard('alpha', 88),
  };
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({ records: [previousRecord] }),
  );
  let evaluateCalls = 0;

  const manifest = await runEvaluationBatch(
    {
      runId: 'resume-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: true,
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          evaluateCalls += 1;
          return successRecord(loadedCase);
        },
      },
      clock: () => new Date('2026-08-04T03:00:00.000Z'),
    },
  );

  assert.equal(evaluateCalls, 0);
  assert.equal(manifest.records[0].status, 'skipped');
  assert.equal(manifest.records[0].scorecard?.total_score, 88);
  assert.equal(manifest.records[0].modelName, 'resume-model');
  assert.equal(manifest.records[0].modelVersion, 'resume-v2');
  assert.equal(manifest.counts.skipped, 1);
});

test('resume reruns incomplete and corrupt result pairs', async () => {
  const setup = fixture(['alpha', 'beta', 'gamma']);
  const runDir = join(setup.outputRoot, 'repair-run');
  for (const skillId of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(runDir, skillId), { recursive: true });
  }
  writeFileSync(join(runDir, 'alpha', 'output.json'), '{"answer":"old"}\n');
  writeFileSync(join(runDir, 'alpha', 'scorecard.json'), '{');
  writeFileSync(join(runDir, 'beta', 'output.json'), '{"answer":"old"}\n');
  writeFileSync(join(runDir, 'gamma', 'output.json'), '{');
  writeFileSync(
    join(runDir, 'gamma', 'scorecard.json'),
    JSON.stringify(scorecard('gamma')),
  );
  const evaluated: string[] = [];

  const manifest = await runEvaluationBatch(
    {
      runId: 'repair-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 3,
      resume: true,
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          evaluated.push(loadedCase.data.skill_id);
          return successRecord(loadedCase);
        },
      },
    },
  );

  assert.deepEqual(evaluated.sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(manifest.counts.succeeded, 3);
  for (const skillId of ['alpha', 'beta', 'gamma']) {
    assert.doesNotThrow(() =>
      readJson(join(runDir, skillId, 'output.json')),
    );
    assert.doesNotThrow(() =>
      readJson(join(runDir, skillId, 'scorecard.json')),
    );
  }
});

test('rejects concurrency outside the inclusive 1-3 range', async () => {
  const setup = fixture(['alpha']);
  for (const concurrency of [0, 4, 1.5]) {
    await assert.rejects(
      runEvaluationBatch(
        {
          runId: 'invalid-concurrency',
          outputRoot: setup.outputRoot,
          casesDir: setup.casesDir,
          concurrency: concurrency as 1,
          resume: false,
        },
        {
          skillLoader: setup.skillLoader,
          evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
        },
      ),
      /concurrency must be an integer from 1 to 3/,
    );
  }
});

test('uses a bounded shared-index worker pool', async () => {
  const setup = fixture(['alpha', 'beta', 'gamma']);
  let active = 0;
  let peak = 0;

  await runEvaluationBatch(
    {
      runId: 'concurrency-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 2,
      resume: false,
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(15);
          active -= 1;
          return successRecord(loadedCase);
        },
      },
    },
  );

  assert.equal(peak, 2);
});

for (const provider of [undefined, 'mock'] as const) {
  test(`CLI rejects ${provider ?? 'missing'} provider before building runtime`, async () => {
    let runtimeBuilds = 0;
    await assert.rejects(
      runEvaluationCli([], {
        env: provider === undefined ? {} : { LLM_PROVIDER: provider },
        loadEnvFile: () => undefined,
        buildRuntime: () => {
          runtimeBuilds += 1;
          return {} as AgentRuntime;
        },
      }),
      /LLM_PROVIDER.*(?:required|mock)/,
    );
    assert.equal(runtimeBuilds, 0);
  });
}

test('rejects an unknown selected Skill and lists active Skill IDs', async () => {
  const setup = fixture(['alpha', 'beta']);
  let evaluateCalls = 0;

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'unknown-run',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        skillId: 'ghost',
        concurrency: 1,
        resume: false,
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase) => {
            evaluateCalls += 1;
            return successRecord(loadedCase);
          },
        },
      },
    ),
    /unknown Skill ghost.*alpha, beta/,
  );
  assert.equal(evaluateCalls, 0);
});
