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
import type { KBAssessment } from '../evaluations/skills/kb/assessment.ts';
import type {
  GoldSourceSelection,
  KnowledgeContext,
  KnowledgeIndexItem,
  KnowledgeRetrievalResult,
  KnowledgeSnapshot,
  RetrievalRecord,
  SkillKnowledgeMapping,
} from '../evaluations/skills/kb/types.ts';

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
  const dimensionMaxScores = {
    workflow_adherence: 20,
    method_correctness: 20,
    completeness_structure: 20,
    evidence_boundaries: 15,
    actionability: 15,
    risk_boundary_handling: 10,
  } as const;
  return {
    skill_id: skillId,
    total_score: totalScore,
    verdict: totalScore >= 80 ? 'pass' : 'needs_review',
    dimensions: (() => {
      let remaining = totalScore;
      return Object.entries(dimensionMaxScores).map(([id, max_score]) => {
        const score = Math.min(max_score, Math.max(0, remaining));
        remaining -= score;
        return {
          id,
          score,
          max_score,
          evidence: [`output quote for ${id}`],
          defects: [],
        };
      });
    })(),
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

function kbMapping(skillId: string): SkillKnowledgeMapping {
  return {
    skill_id: skillId,
    kb_mode: 'required',
    required_sources: [{ path: `methods/${skillId}.md`, role: 'method' }],
    conditional_sources: [],
    optional_sources: [],
    retrieval_tags: [skillId, 'research'],
    source_status_policy: 'draft_allowed_with_warning',
    unresolved_items: [],
  };
}

function kbSnapshot(): KnowledgeSnapshot {
  return {
    snapshot_id: 'sha256:test-snapshot',
    index_path: '/fixture/knowledge.json',
    index_hash: 'sha256:test-index',
    built_at: '2026-08-05T00:00:00.000Z',
    source_files: [
      { path: 'methods/alpha.md', content_hash: 'sha256:alpha-body', status: 'reviewed' },
      { path: 'methods/beta.md', content_hash: 'sha256:beta-body', status: 'draft' },
    ],
  };
}

function kbIndex(skillIds: string[]): Map<string, KnowledgeIndexItem> {
  return new Map(
    skillIds.map((skillId) => [
      `${skillId}_source`,
      {
        id: `${skillId}_source`,
        title: `${skillId} source`,
        source_path: `methods/${skillId}.md`,
        content_hash: `sha256:${skillId}-body`,
        status: skillId === 'beta' ? 'draft' : 'reviewed',
      },
    ]),
  );
}

function kbResult(
  skillId: string,
  mode: 'gold' | 'live',
  overrides: Partial<KnowledgeRetrievalResult> = {},
): KnowledgeRetrievalResult {
  const sourceId = `${skillId}_source`;
  const context: KnowledgeContext = {
    mode,
    snapshot_id: 'sha256:test-snapshot',
    required_source_ids: [sourceId],
    selected_source_ids: [sourceId],
    items: [
      {
        source_id: sourceId,
        title: `${skillId} source`,
        source_path: `methods/${skillId}.md`,
        content_hash: `sha256:${skillId}-body`,
        status: skillId === 'beta' ? 'draft' : 'reviewed',
        role: 'required',
        content: `${skillId} KB body`,
      },
    ],
  };
  const record: RetrievalRecord = {
    mode,
    snapshot_id: 'sha256:test-snapshot',
    guide_tags: [skillId, 'research'],
    query: `${skillId} evaluation`,
    candidate_source_ids: mode === 'live' ? [`${skillId}_candidate`, sourceId] : [sourceId],
    selected_source_ids: [sourceId],
    required_source_recall: 1,
    missing_required_source_ids: [],
    unresolved_items: [],
  };
  return { context, record, warnings: [], failures: [], ...overrides };
}

function kbAssessment(skillId: string, mode: 'gold' | 'live'): KBAssessment {
  return {
    skill_id: skillId,
    mode,
    required_sources_available: true,
    required_source_ids: [`${skillId}_source`],
    selected_source_ids: [`${skillId}_source`],
    missing_required_source_ids: [],
    cited_source_ids: [`${skillId}_source`],
    uncited_selected_source_ids: [],
    invented_source_ids: [],
    draft_sources_used: [],
    retrieval_recall: 1,
    kb_grounding_verdict: 'pass',
    status_warnings: [],
    review_notes: [],
  };
}

function kbDependencies(skillIds: string[], mode: 'gold' | 'live') {
  const mappings = new Map(skillIds.map((skillId) => [skillId, kbMapping(skillId)]));
  const goldSelections = new Map(
    skillIds.map((skillId) => [
      skillId,
      {
        skill_id: skillId,
        mode: 'gold',
        selected_source_ids: [`${skillId}_source`],
        unresolved_items: [],
      } satisfies GoldSourceSelection,
    ]),
  );
  return {
    loadKnowledgeSnapshot: () => ({ snapshot: kbSnapshot(), index: kbIndex(skillIds), warnings: [] }),
    loadSkillKnowledgeMappings: () => mappings,
    loadGoldSourceSelections: () => goldSelections,
    loadGoldKnowledgeContext: (skillId: string) => kbResult(skillId, mode),
    loadLiveKnowledgeContext: (skillId: string) => kbResult(skillId, mode),
  };
}

test('kbMode none preserves Round 0 artifact shape and evaluator call signature', async () => {
  const setup = fixture(['alpha']);
  const manifest = await runEvaluationBatch(
    {
      runId: 'round0-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: false,
      kbMode: 'none',
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase, kb) => {
          assert.equal(kb, undefined);
          return successRecord(loadedCase);
        },
      },
      clock: () => new Date('2026-08-05T01:00:00.000Z'),
    },
  );

  const runDir = join(setup.outputRoot, 'round0-run');
  assert.equal('kb' in manifest, false);
  assert.equal(existsSync(join(runDir, 'alpha', 'knowledge-context.json')), false);
  assert.equal(existsSync(join(runDir, 'alpha', 'retrieval.json')), false);
  assert.equal(existsSync(join(runDir, 'alpha', 'kb-assessment.json')), false);
  assert.deepEqual(Object.keys(readJson(join(runDir, 'manifest.json'))).sort(), Object.keys(manifest).sort());
});

test('gold KB mode writes KB artifacts and manifest metadata', async () => {
  const setup = fixture(['alpha']);
  const manifest = await runEvaluationBatch(
    {
      runId: 'gold-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: false,
      kbMode: 'gold',
      kbSnapshotId: 'sha256:test-snapshot',
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase, kb) => successRecord(loadedCase, { kbAssessment: kbAssessment(loadedCase.data.skill_id, kb!.knowledgeContext.mode) }),
      },
      kb: kbDependencies(['alpha'], 'gold'),
    },
  );

  const skillDir = join(setup.outputRoot, 'gold-run', 'alpha');
  assert.deepEqual(readJson<KnowledgeContext>(join(skillDir, 'knowledge-context.json')).selected_source_ids, ['alpha_source']);
  assert.deepEqual(readJson<RetrievalRecord>(join(skillDir, 'retrieval.json')).candidate_source_ids, ['alpha_source']);
  assert.equal(readJson<KBAssessment>(join(skillDir, 'kb-assessment.json')).kb_grounding_verdict, 'pass');
  assert.deepEqual(manifest.kb && { ...manifest.kb, sourceMappingHash: '<hash>' }, {
    mode: 'gold',
    snapshotId: 'sha256:test-snapshot',
    snapshotHash: 'sha256:test-snapshot',
    indexHash: 'sha256:test-index',
    sourceMappingHash: '<hash>',
  });
  assert.match(manifest.kb?.sourceMappingHash ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('live KB mode writes candidate and selected source IDs', async () => {
  const setup = fixture(['alpha']);
  await runEvaluationBatch(
    {
      runId: 'live-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: false,
      kbMode: 'live',
      kbSnapshotId: 'sha256:test-snapshot',
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase, kb) => successRecord(loadedCase, { kbAssessment: kbAssessment(loadedCase.data.skill_id, kb!.knowledgeContext.mode) }),
      },
      kb: kbDependencies(['alpha'], 'live'),
    },
  );

  const retrieval = readJson<RetrievalRecord>(join(setup.outputRoot, 'live-run', 'alpha', 'retrieval.json'));
  assert.deepEqual(retrieval.candidate_source_ids, ['alpha_candidate', 'alpha_source']);
  assert.deepEqual(retrieval.selected_source_ids, ['alpha_source']);
});

test('KB mode preflight rejects missing snapshot or mapping before evaluator calls', async () => {
  const setup = fixture(['alpha']);
  let evaluateCalls = 0;
  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'missing-snapshot-run',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        concurrency: 1,
        resume: false,
        kbMode: 'gold',
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: { evaluate: async (loadedCase) => { evaluateCalls += 1; return successRecord(loadedCase); } },
      },
    ),
    /kb-snapshot/i,
  );
  assert.equal(evaluateCalls, 0);

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'missing-mapping-run',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        concurrency: 1,
        resume: false,
        kbMode: 'live',
        kbSnapshotId: 'sha256:test-snapshot',
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: { evaluate: async (loadedCase) => { evaluateCalls += 1; return successRecord(loadedCase); } },
        kb: { loadKnowledgeSnapshot: () => ({ snapshot: kbSnapshot(), index: kbIndex(['alpha']), warnings: [] }) },
      },
    ),
    /mapping/i,
  );
  assert.equal(evaluateCalls, 0);
});

test('one Skill KB retrieval failure records failure and continues batch', async () => {
  const setup = fixture(['alpha', 'beta']);
  const deps = kbDependencies(['alpha', 'beta'], 'gold');
  let evaluateCalls = 0;
  const manifest = await runEvaluationBatch(
    {
      runId: 'retrieval-failure-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: false,
      kbMode: 'gold',
      kbSnapshotId: 'sha256:test-snapshot',
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          evaluateCalls += 1;
          return successRecord(loadedCase);
        },
      },
      kb: {
        ...deps,
        loadGoldKnowledgeContext: (skillId: string) => {
          if (skillId === 'alpha') throw new Error('synthetic retrieval failure');
          return kbResult(skillId, 'gold');
        },
      },
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.deepEqual(manifest.records.map(({ skillId, status }) => [skillId, status]), [['alpha', 'failed'], ['beta', 'succeeded']]);
  assert.equal(readJson<SkillEvaluationRecord>(join(setup.outputRoot, 'retrieval-failure-run', 'alpha', 'error.json')).errorStage, 'generation');
});

test('resume validates KB mode and snapshot before reusing artifacts', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'kb-resume-run',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
    kbMode: 'gold' as const,
    kbSnapshotId: 'sha256:test-snapshot',
  };
  await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase, kb) => successRecord(loadedCase, { kbAssessment: kbAssessment(loadedCase.data.skill_id, kb!.knowledgeContext.mode) }) },
      kb: kbDependencies(['alpha'], 'gold'),
    },
  );

  let evaluateCalls = 0;
  const skipped = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => { evaluateCalls += 1; return successRecord(loadedCase); } },
      kb: kbDependencies(['alpha'], 'gold'),
    },
  );
  assert.equal(evaluateCalls, 0);
  assert.equal(skipped.records[0].status, 'skipped');

  const rerun = await runEvaluationBatch(
    { ...options, resume: true, kbSnapshotId: 'sha256:changed-snapshot' },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase, kb) => { evaluateCalls += 1; return successRecord(loadedCase, { kbAssessment: kbAssessment(loadedCase.data.skill_id, kb!.knowledgeContext.mode) }); } },
      kb: { ...kbDependencies(['alpha'], 'gold'), loadKnowledgeSnapshot: () => ({ snapshot: { ...kbSnapshot(), snapshot_id: 'sha256:changed-snapshot' }, index: kbIndex(['alpha']), warnings: [] }) },
    },
  );
  assert.equal(evaluateCalls, 1);
  assert.equal(rerun.records[0].status, 'succeeded');
});

test('CLI parses KB flags before building runtime', async () => {
  let captured: unknown;
  await runEvaluationCli(['--kb-mode', 'gold', '--kb-snapshot', 'sha256:test-snapshot'], {
    env: { LLM_PROVIDER: 'real-provider' },
    loadEnvFile: () => undefined,
    buildRuntime: () => ({
      deps: {
        skillLoader: { listActiveSkills: () => [] },
        llm: {},
        validator: {},
      },
    } as AgentRuntime),
    clock: () => new Date('2026-08-05T04:00:00.000Z'),
  }, async (options) => {
    captured = options;
    return { runId: options.runId, status: 'completed', startedAt: '', provider: '', activeSkillCount: 0, activeSkillIds: [], records: [], counts: { succeeded: 0, needs_review: 0, failed: 0, skipped: 0 } };
  });
  assert.deepEqual(captured, {
    runId: '20260805-040000',
    outputRoot: 'skill-evaluations',
    concurrency: 3,
    resume: false,
    kbMode: 'gold',
    kbSnapshotId: 'sha256:test-snapshot',
  });
  await assert.rejects(
    runEvaluationCli(['--kb-mode', 'bogus'], {
      env: { LLM_PROVIDER: 'real-provider' },
      loadEnvFile: () => undefined,
      buildRuntime: () => { throw new Error('runtime should not build'); },
    }),
    /kb-mode/i,
  );
});

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
test('cleans mutually exclusive artifacts across success failure and resume retry', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'transition-run',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };

  await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
    },
  );
  const skillDir = join(setup.outputRoot, options.runId, 'alpha');
  writeFileSync(join(skillDir, 'scorecard.json'), '{');

  const failed = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async () => {
          throw new Error('retry failed');
        },
      },
    },
  );
  assert.equal(failed.records[0].status, 'failed');
  assert.equal(existsSync(join(skillDir, 'error.json')), true);
  for (const filename of ['output.json', 'output.md', 'scorecard.json']) {
    assert.equal(existsSync(join(skillDir, filename)), false, filename);
  }

  writeFileSync(join(skillDir, 'output.json'), JSON.stringify({ answer: 'stale' }));
  writeFileSync(join(skillDir, 'scorecard.json'), JSON.stringify(scorecard('alpha')));
  let retryCalls = 0;
  const resumed = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          retryCalls += 1;
          return successRecord(loadedCase);
        },
      },
    },
  );
  assert.equal(retryCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
  assert.equal(existsSync(join(skillDir, 'error.json')), false);
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

test('resume skips a complete pair even when the prior manifest record is missing', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'pair-without-record');
  const skillDir = join(runDir, 'alpha');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'output.json'), JSON.stringify({ answer: 'existing' }));
  writeFileSync(join(skillDir, 'scorecard.json'), JSON.stringify(scorecard('alpha', 88)));
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    {
      runId: 'pair-without-record',
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
    },
  );

  assert.equal(evaluateCalls, 0);
  assert.equal(resumed.records[0].status, 'skipped');
  assert.equal(resumed.records[0].scorecard?.total_score, 88);
});

test('resume reruns output paired with a fallback scorecard and no prior record', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'fallback-pair');
  const skillDir = join(runDir, 'alpha');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'output.json'), JSON.stringify({ answer: 'generated' }));
  writeFileSync(
    join(skillDir, 'scorecard.json'),
    JSON.stringify({
      ...scorecard('alpha'),
      total_score: null,
      dimensions: [],
      verdict: 'needs_review',
    }),
  );
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    {
      runId: 'fallback-pair',
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
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
});

test('resume reruns a scorecard whose total does not equal dimension sum', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'inconsistent-total');
  const skillDir = join(runDir, 'alpha');
  mkdirSync(skillDir, { recursive: true });
  const inconsistent = scorecard('alpha', 100, {
    dimensions: scorecard('alpha').dimensions.map((dimension) => ({
      ...dimension,
      score: 0,
    })),
  });
  writeFileSync(join(skillDir, 'output.json'), JSON.stringify({ answer: 'generated' }));
  writeFileSync(join(skillDir, 'scorecard.json'), JSON.stringify(inconsistent));
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    {
      runId: 'inconsistent-total',
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
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
});

test('resume reruns scorecards whose persisted verdict conflicts with normalization', async () => {
  const invalidScorecards = [
    scorecard('alpha', 100, { critical_defects: ['critical'], verdict: 'pass' }),
    scorecard('alpha', 50, { verdict: 'pass' }),
    scorecard('alpha', 80, { verdict: 'fail' }),
  ];
  for (const [index, invalid] of invalidScorecards.entries()) {
    const setup = fixture(['alpha']);
    const runId = `inconsistent-verdict-${index}`;
    const skillDir = join(setup.outputRoot, runId, 'alpha');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'output.json'), JSON.stringify({ answer: 'generated' }));
    writeFileSync(join(skillDir, 'scorecard.json'), JSON.stringify(invalid));
    let evaluateCalls = 0;

    await runEvaluationBatch(
      {
        runId,
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
      },
    );
    assert.equal(evaluateCalls, 1, `invalid verdict case ${index}`);
  }

  const validSetup = fixture(['alpha']);
  const validRunId = 'high-score-needs-review';
  const validSkillDir = join(validSetup.outputRoot, validRunId, 'alpha');
  mkdirSync(validSkillDir, { recursive: true });
  writeFileSync(join(validSkillDir, 'output.json'), JSON.stringify({ answer: 'generated' }));
  writeFileSync(
    join(validSkillDir, 'scorecard.json'),
    JSON.stringify(scorecard('alpha', 100, { verdict: 'needs_review' })),
  );
  let validEvaluateCalls = 0;
  const resumed = await runEvaluationBatch(
    {
      runId: validRunId,
      outputRoot: validSetup.outputRoot,
      casesDir: validSetup.casesDir,
      concurrency: 1,
      resume: true,
    },
    {
      skillLoader: validSetup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          validEvaluateCalls += 1;
          return successRecord(loadedCase);
        },
      },
    },
  );
  assert.equal(validEvaluateCalls, 0);
  assert.equal(resumed.records[0].status, 'skipped');
});

test('resume reruns complete artifacts from a prior needs_review record', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'needs-review-run');
  const skillDir = join(runDir, 'alpha');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'output.json'), JSON.stringify({ answer: 'stale' }));
  writeFileSync(join(skillDir, 'scorecard.json'), JSON.stringify(scorecard('alpha')));
  const previousRecord = successRecord(
    { data: evaluationCase('alpha'), sourcePath: '', caseHash: 'sha256:case' },
    { status: 'needs_review' },
  );
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ records: [previousRecord] }));
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    {
      runId: 'needs-review-run',
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
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
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

test('resume reruns parseable artifacts with invalid output or scorecard shapes', async () => {
  const skillIds = [
    'bad-output',
    'bad-scorecard',
    'wrong-skill',
    'bad-dimensions',
    'bad-defects',
    'bad-notes',
    'bad-total',
    'bad-verdict',
    'bad-dimension-item',
  ];
  const setup = fixture(skillIds);
  const runDir = join(setup.outputRoot, 'shape-run');
  const valid = (skillId: string) => scorecard(skillId);
  const artifacts: Record<string, { output: unknown; scorecard: unknown }> = {
    'bad-output': { output: [], scorecard: valid('bad-output') },
    'bad-scorecard': { output: { answer: 'old' }, scorecard: [] },
    'wrong-skill': {
      output: { answer: 'old' },
      scorecard: { ...valid('wrong-skill'), skill_id: 'other' },
    },
    'bad-dimensions': {
      output: { answer: 'old' },
      scorecard: { ...valid('bad-dimensions'), dimensions: {} },
    },
    'bad-defects': {
      output: { answer: 'old' },
      scorecard: { ...valid('bad-defects'), critical_defects: {} },
    },
    'bad-notes': {
      output: { answer: 'old' },
      scorecard: { ...valid('bad-notes'), review_notes: {} },
    },
    'bad-total': {
      output: { answer: 'old' },
      scorecard: { ...valid('bad-total'), total_score: '90' },
    },
    'bad-verdict': {
      output: { answer: 'old' },
      scorecard: { ...valid('bad-verdict'), verdict: 'excellent' },
    },
    'bad-dimension-item': {
      output: { answer: 'old' },
      scorecard: {
        ...valid('bad-dimension-item'),
        dimensions: [{ id: 'workflow_adherence' }],
      },
    },
  };
  for (const skillId of skillIds) {
    const skillDir = join(runDir, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'output.json'),
      JSON.stringify(artifacts[skillId].output),
    );
    writeFileSync(
      join(skillDir, 'scorecard.json'),
      JSON.stringify(artifacts[skillId].scorecard),
    );
  }
  const evaluated: string[] = [];

  const manifest = await runEvaluationBatch(
    {
      runId: 'shape-run',
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

  assert.deepEqual(evaluated.sort(), [...skillIds].sort());
  assert.equal(manifest.counts.succeeded, skillIds.length);
  assert.equal(manifest.counts.skipped, 0);
});

test('resume preloads valid prior records before workers can be interrupted', async () => {
  const setup = fixture(['beta', 'alpha']);
  const runDir = join(setup.outputRoot, 'interrupted-resume');
  const alphaDir = join(runDir, 'alpha');
  mkdirSync(alphaDir, { recursive: true });
  writeFileSync(join(alphaDir, 'output.json'), JSON.stringify({ answer: 'existing' }));
  writeFileSync(join(alphaDir, 'scorecard.json'), JSON.stringify(scorecard('alpha', 87)));
  const previousRecord: SkillEvaluationRecord = {
    skillId: 'alpha',
    skillHash: 'sha256:preserved-skill',
    caseHash: 'sha256:preserved-case',
    modelName: 'preserved-model',
    modelVersion: 'preserved-v1',
    elapsedMs: 91,
    status: 'succeeded',
    output: { answer: 'existing' },
    scorecard: scorecard('alpha', 87),
  };
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({ records: [previousRecord] }),
  );
  let releaseBeta!: () => void;
  const betaBlocked = new Promise<void>((resolve) => {
    releaseBeta = resolve;
  });
  let signalBetaStarted!: () => void;
  const betaStarted = new Promise<void>((resolve) => {
    signalBetaStarted = resolve;
  });

  const running = runEvaluationBatch(
    {
      runId: 'interrupted-resume',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1,
      resume: true,
    },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          signalBetaStarted();
          await betaBlocked;
          return successRecord(loadedCase);
        },
      },
    },
  );
  await betaStarted;

  const interrupted = readJson<EvaluationManifest>(join(runDir, 'manifest.json'));
  releaseBeta();
  await running;

  assert.equal(interrupted.status, 'running');
  assert.deepEqual(
    interrupted.records.map(({ skillId, status }) => [skillId, status]),
    [['alpha', 'skipped']],
  );
  assert.equal(interrupted.records[0].skillHash, 'sha256:preserved-skill');
  assert.equal(interrupted.records[0].modelName, 'preserved-model');
  assert.equal(interrupted.records[0].elapsedMs, 91);
});

test('non-resume rejects an existing run before stale success artifacts can be reused', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'same-run',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
    resume: false,
  };
  await runEvaluationBatch(options, {
    skillLoader: setup.skillLoader,
    evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
  });
  let secondRunCalls = 0;

  await assert.rejects(
    runEvaluationBatch(options, {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async () => {
          secondRunCalls += 1;
          throw new Error('second run failed');
        },
      },
    }),
    /run directory already exists.*--resume/,
  );
  assert.equal(secondRunCalls, 0);

  let resumeCalls = 0;
  const resumed = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          resumeCalls += 1;
          return successRecord(loadedCase);
        },
      },
    },
  );
  assert.equal(resumeCalls, 0);
  assert.equal(resumed.records[0].status, 'skipped');
});
test('rejects traversal run IDs before writing outside the output root', async () => {
  const setup = fixture(['alpha']);
  const outsideManifest = join(setup.outputRoot, '..', 'outside', 'manifest.json');

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: '../outside',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        concurrency: 1,
        resume: false,
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase) => successRecord(loadedCase),
        },
      },
    ),
    /runId must be a single safe path segment/,
  );
  assert.equal(existsSync(outsideManifest), false);
});


test('resume atomically creates a missing run directory and evaluates every Skill', async () => {
  const setup = fixture(['alpha', 'beta']);
  const evaluated: string[] = [];

  const manifest = await runEvaluationBatch(
    {
      runId: 'missing-run',
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 2,
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

  assert.deepEqual(evaluated.sort(), ['alpha', 'beta']);
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.counts.succeeded, 2);
  assert.equal(existsSync(join(setup.outputRoot, 'missing-run')), true);
});

test('maps an exclusive claim EEXIST race without entering the evaluator', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'contended-run');
  const mkdirCalls: Array<{ path: string; recursive: boolean }> = [];
  let evaluateCalls = 0;
  assert.equal(existsSync(runDir), false);

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'contended-run',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
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
        mkdirSync: (
          path: string,
          options?: { recursive?: boolean },
        ): void => {
          mkdirCalls.push({ path, recursive: options?.recursive === true });
          if (!options?.recursive) {
            throw Object.assign(new Error('simulated competing claimant'), {
              code: 'EEXIST',
            });
          }
        },
      },
    ),
    /run directory already exists.*--resume/,
  );

  assert.deepEqual(mkdirCalls, [
    { path: setup.outputRoot, recursive: true },
    { path: runDir, recursive: false },
  ]);
  assert.equal(evaluateCalls, 0);
  assert.equal(existsSync(runDir), false);
});

test('rejects resume of an active running manifest without overwriting it', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'active-run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '.active.lock'), String(process.pid));
  const manifestBytes = JSON.stringify({ status: 'running', records: [] });
  writeFileSync(join(runDir, 'manifest.json'), manifestBytes);
  let evaluateCalls = 0;

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'active-run',
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
      },
    ),
    /run is already active.*--resume later/,
  );
  assert.equal(evaluateCalls, 0);
  assert.equal(readFileSync(join(runDir, 'manifest.json'), 'utf8'), manifestBytes);
});

test('resumes a stale running manifest when the lock PID is gone', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'stale-running');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ status: 'running', records: [] }));
  writeFileSync(join(runDir, '.active.lock'), '99999999');
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    {
      runId: 'stale-running',
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
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.status, 'completed');
  assert.equal(existsSync(join(runDir, '.active.lock')), false);
});

test('reclaims a lock with a live PID prefix but malformed suffix', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'malformed-lock');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ status: 'running', records: [] }));
  writeFileSync(join(runDir, '.active.lock'), `${process.pid}garbage`);
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    {
      runId: 'malformed-lock',
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
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.status, 'completed');
});

test('keeps manifest running when summary publication fails', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'summary-failure');
  mkdirSync(join(runDir, `summary.md.tmp-${process.pid}`), { recursive: true });

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'summary-failure',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        concurrency: 1,
        resume: true,
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
      },
    ),
    /EISDIR/,
  );

  const manifest = readJson<EvaluationManifest>(join(runDir, 'manifest.json'));
  assert.equal(manifest.status, 'running');
  assert.equal(existsSync(join(runDir, 'summary.csv')), false);
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
