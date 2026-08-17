import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FsSafeError, type FsSafeErrorCode } from '@openclaw/fs-safe';
import type { SkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { AgentRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import { CheckpointStore } from '../apps/orchestrator-runtime/src/runtime/checkpoint-store.ts';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { FakeO2Adapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
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
          evidence: [skillId],
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
  const skillHashes = new Map(
    skillIds.map((skillId) => [skillId, `sha256:${skillId}`]),
  );
  return {
    root,
    casesDir,
    outputRoot,
    activeSkills,
    skillHashes,
    skillLoader: {
      listActiveSkills: () => activeSkills,
      loadSkillBody: (skillId: string) => ({
        body: `# ${skillId}\n\n${skillHashes.get(skillId)}`,
        hash: skillHashes.get(skillId)!,
        path: `skills/${skillId}/SKILL.md`,
      }),
    },
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function evaluationCaseHash(casesDir: string, skillId: string): string {
  const bytes = readFileSync(join(casesDir, `${skillId}.json`));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fsSafeFailure(...codes: FsSafeErrorCode[]) {
  return (error: unknown): boolean => error instanceof FsSafeError && codes.includes(error.code);
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
    unsupported_canonical_claims: [],
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
  const calls: Array<{ skillId: string; query?: string }> = [];
  return {
    calls,
    loadKnowledgeSnapshot: () => ({ snapshot: kbSnapshot(), index: kbIndex(skillIds), warnings: [] }),
    loadSkillKnowledgeMappings: () => mappings,
    loadGoldSourceSelections: () => goldSelections,
    loadGoldKnowledgeContext: (skillId: string) => kbResult(skillId, mode),
    loadLiveKnowledgeContext: (skillId: string, _snapshot: unknown, _index: unknown, _mapping: unknown, options?: { query?: string }) => {
      calls.push({ skillId, query: options?.query });
      return kbResult(skillId, mode, { record: { ...kbResult(skillId, mode).record, query: options?.query } });
    },
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
  assert.deepEqual(manifest.kb && { ...manifest.kb, sourceMappingHash: '<hash>', snapshotHash: '<hash>' }, {
    mode: 'gold',
    snapshotId: 'sha256:test-snapshot',
    snapshotHash: '<hash>',
    indexHash: 'sha256:test-index',
    sourceMappingHash: '<hash>',
  });
  assert.notEqual(manifest.kb?.snapshotHash, manifest.kb?.snapshotId);
  assert.match(manifest.kb?.snapshotHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.match(manifest.kb?.sourceMappingHash ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('live KB mode writes candidate and selected source IDs', async () => {
  const setup = fixture(['alpha']);
  const kb = kbDependencies(['alpha'], 'live');
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
        evaluate: async (loadedCase, kbArg) => successRecord(loadedCase, { kbAssessment: kbAssessment(loadedCase.data.skill_id, kbArg!.knowledgeContext.mode) }),
      },
      kb,
    },
  );
  assert.deepEqual(kb.calls, [{ skillId: 'alpha', query: 'Evaluate alpha' }]);

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

test('KB artifacts persist when retrieval succeeds but evaluator fails and resume reruns sanely', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'post-retrieval-failure-run',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
    kbMode: 'gold' as const,
    kbSnapshotId: 'sha256:test-snapshot',
  };
  const deps = kbDependencies(['alpha'], 'gold');
  const failed = await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async () => {
          throw new Error('synthetic schema failure after retrieval');
        },
      },
      kb: deps,
    },
  );

  const skillDir = join(setup.outputRoot, options.runId, 'alpha');
  assert.equal(failed.records[0].status, 'failed');
  assert.deepEqual(readJson<KnowledgeContext>(join(skillDir, 'knowledge-context.json')).selected_source_ids, ['alpha_source']);
  assert.deepEqual(readJson<RetrievalRecord>(join(skillDir, 'retrieval.json')).selected_source_ids, ['alpha_source']);
  const fallbackAssessment = readJson<KBAssessment>(join(skillDir, 'kb-assessment.json'));
  assert.equal(fallbackAssessment.kb_grounding_verdict, 'needs_review');
  assert.match(fallbackAssessment.review_notes.join('\n'), /evaluation failed after KB retrieval/);

  let retryCalls = 0;
  const recovered = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase, kb) => {
          retryCalls += 1;
          return successRecord(loadedCase, { kbAssessment: kbAssessment(loadedCase.data.skill_id, kb!.knowledgeContext.mode) });
        },
      },
      kb: deps,
    },
  );
  assert.equal(retryCalls, 1);
  assert.equal(recovered.records[0].status, 'succeeded');
  assert.equal(readJson<KBAssessment>(join(skillDir, 'kb-assessment.json')).kb_grounding_verdict, 'pass');

  const skipped = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          throw new Error(`should skip ${loadedCase.data.skill_id}`);
        },
      },
      kb: deps,
    },
  );
  assert.equal(skipped.records[0].status, 'skipped');
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

for (const priorKbMode of ['gold', 'live'] as const) {
  test(`resume rejects changing prior ${priorKbMode} KB mode to none`, async () => {
    const setup = fixture(['alpha']);
    const baseOptions = {
      runId: `${priorKbMode}-to-none`,
      outputRoot: setup.outputRoot,
      casesDir: setup.casesDir,
      concurrency: 1 as const,
    };
    await runEvaluationBatch(
      {
        ...baseOptions,
        resume: false,
        kbMode: priorKbMode,
        kbSnapshotId: 'sha256:test-snapshot',
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase, kb) =>
            successRecord(loadedCase, {
              kbAssessment: kbAssessment(
                loadedCase.data.skill_id,
                kb!.knowledgeContext.mode,
              ),
            }),
        },
        kb: kbDependencies(['alpha'], priorKbMode),
      },
    );

    let evaluateCalls = 0;
    await assert.rejects(
      runEvaluationBatch(
        { ...baseOptions, resume: true, kbMode: 'none' },
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
      /KB mode|kbMode|knowledge/i,
    );
    assert.equal(evaluateCalls, 0);
  });
}

test('resume rejects a provider that differs from the prior manifest', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'provider-mismatch',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
      provider: 'provider-a',
    },
  );

  let evaluateCalls = 0;
  await assert.rejects(
    runEvaluationBatch(
      { ...options, resume: true },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase) => {
            evaluateCalls += 1;
            return successRecord(loadedCase);
          },
        },
        provider: 'provider-b',
      },
    ),
    /provider/i,
  );
  assert.equal(evaluateCalls, 0);
});

test('resume rejects changing the expected actual model before artifact reuse', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'expected-model-mismatch',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  const modelADependencies = {
    skillLoader: setup.skillLoader,
    evaluator: {
      evaluate: async (loadedCase: LoadedEvaluationCase) =>
        successRecord(loadedCase, { modelName: 'model-a' }),
    },
    provider: 'same-provider',
    expectedActualModel: 'model-a',
  };
  await runEvaluationBatch({ ...options, resume: false }, modelADependencies);
  let evaluateCalls = 0;
  const modelBDependencies = {
    skillLoader: setup.skillLoader,
    evaluator: {
      evaluate: async (loadedCase: LoadedEvaluationCase) => {
        evaluateCalls += 1;
        return successRecord(loadedCase, { modelName: 'model-b' });
      },
    },
    provider: 'same-provider',
    expectedActualModel: 'model-b',
  };

  await assert.rejects(
    runEvaluationBatch({ ...options, resume: true }, modelBDependencies),
    /expected.*model|model.*mismatch/i,
  );
  assert.equal(evaluateCalls, 0);
});

test('resume rejects an active Skill set that differs from the prior manifest', async () => {
  const setup = fixture(['alpha', 'beta']);
  const options = {
    runId: 'active-skill-mismatch',
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
  const resumeCasesDir = join(setup.root, 'resume-cases');
  mkdirSync(resumeCasesDir);
  writeFileSync(
    join(resumeCasesDir, 'alpha.json'),
    readFileSync(join(setup.casesDir, 'alpha.json')),
  );

  let evaluateCalls = 0;
  const alphaOnlyLoader = {
    ...setup.skillLoader,
    listActiveSkills: () => [activeSkill('alpha')],
  };
  await assert.rejects(
    runEvaluationBatch(
      { ...options, casesDir: resumeCasesDir, resume: true },
      {
        skillLoader: alphaOnlyLoader,
        evaluator: {
          evaluate: async (loadedCase) => {
            evaluateCalls += 1;
            return successRecord(loadedCase);
          },
        },
      },
    ),
    /active Skill/i,
  );
  assert.equal(evaluateCalls, 0);
});

test('CLI parses KB flags before building runtime', async () => {
  let captured: unknown;
  await runEvaluationCli(['--kb-mode', 'gold', '--kb-snapshot', 'sha256:test-snapshot'], {
    env: {
      LLM_PROVIDER: 'real-provider',
      LLM_EXPECTED_ACTUAL_MODEL: 'test-model',
    },
    loadEnvFile: () => undefined,
    buildRuntime: () => {
      const skillLoader = new SkillLoader();
      skillLoader.listActiveSkills = () => [];
      return new AgentRuntime({
        llm: new MockLLMClient(),
        toolAdapter: new FakeO2Adapter(),
        skillLoader,
        checkpointStore: new CheckpointStore(),
        validator: new SchemaValidator(),
      });
    },
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
      env: {
        LLM_PROVIDER: 'real-provider',
        LLM_EXPECTED_ACTUAL_MODEL: 'test-model',
      },
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


test('resume skips only an exact provenance match and retains score and model metadata', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'resume-run',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) =>
          successRecord(loadedCase, {
            modelName: 'resume-model',
            modelVersion: 'resume-v2',
            elapsedMs: 44,
            scorecard: scorecard('alpha', 88),
          }),
      },
    },
  );
  let evaluateCalls = 0;

  const manifest = await runEvaluationBatch(
    { ...options, resume: true },
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

test('resume reruns a provenance-matched pair whose evidence quotes are fabricated', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'fabricated-resume-evidence',
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
  const runDirectory = join(setup.outputRoot, options.runId);
  const fabricatedScorecard = scorecard('alpha', 90, {
    dimensions: scorecard('alpha', 90).dimensions.map((dimension) => ({
      ...dimension,
      evidence: ['fabricated quote absent from generated output'],
    })),
  });
  const priorManifest = readJson<EvaluationManifest>(
    join(runDirectory, 'manifest.json'),
  );
  priorManifest.records[0] = {
    ...priorManifest.records[0],
    scorecard: fabricatedScorecard,
  };
  writeFileSync(
    join(runDirectory, 'manifest.json'),
    JSON.stringify(priorManifest),
  );
  writeFileSync(
    join(runDirectory, 'alpha', 'scorecard.json'),
    JSON.stringify(fabricatedScorecard),
  );
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    { ...options, resume: true },
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

  assert.equal(fabricatedScorecard.dimensions.length, 6);
  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
  assert.equal(resumed.counts.skipped, 0);
});

test('resume reruns a complete output and score pair without prior provenance', async () => {
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

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
  assert.deepEqual(resumed.records[0].output, successRecord({
    data: evaluationCase('alpha'),
    sourcePath: '',
    caseHash: evaluationCaseHash(setup.casesDir, 'alpha'),
  }).output);
});

test('partial Skill resume preserves the full prior manifest and updates only the selected Skill', async () => {
  const setup = fixture(['alpha', 'beta']);
  const options = {
    runId: 'partial-resume',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  const initial = await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
    },
  );
  const priorBeta = initial.records.find(({ skillId }) => skillId === 'beta')!;
  writeFileSync(
    join(setup.outputRoot, options.runId, 'alpha', 'scorecard.json'),
    '{',
  );
  const evaluated: string[] = [];

  const resumed = await runEvaluationBatch(
    { ...options, resume: true, skillId: 'alpha' },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          evaluated.push(loadedCase.data.skill_id);
          return successRecord(loadedCase, {
            output: { answer: 'alpha refreshed' },
          });
        },
      },
    },
  );

  assert.deepEqual(evaluated, ['alpha']);
  assert.deepEqual(resumed.activeSkillIds, ['alpha', 'beta']);
  assert.equal(resumed.activeSkillCount, 2);
  assert.deepEqual(
    resumed.records.map(({ skillId }) => skillId),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    resumed.records.find(({ skillId }) => skillId === 'alpha')?.output,
    { answer: 'alpha refreshed' },
  );
  assert.deepEqual(
    resumed.records.find(({ skillId }) => skillId === 'beta'),
    priorBeta,
  );
  assert.deepEqual(
    readJson<EvaluationManifest>(
      join(setup.outputRoot, options.runId, 'manifest.json'),
    ),
    resumed,
  );
});

test('partial resume cannot publish a completed manifest with a missing prior Skill record', async () => {
  const setup = fixture(['alpha', 'beta']);
  const options = {
    runId: 'incomplete-running-partial-resume',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  const completed = await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
    },
  );
  const runDirectory = join(setup.outputRoot, options.runId);
  const { completedAt: _completedAt, ...prior } = completed;
  writeFileSync(
    join(runDirectory, 'manifest.json'),
    JSON.stringify({
      ...prior,
      status: 'running',
      records: prior.records.filter(({ skillId }) => skillId === 'alpha'),
      counts: {
        succeeded: 1,
        needs_review: 0,
        failed: 0,
        skipped: 0,
      },
    }),
  );

  const outcome: { manifest: EvaluationManifest } | { error: unknown } = await runEvaluationBatch(
    { ...options, resume: true, skillId: 'alpha' },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
    },
  ).then(
    (manifest) => ({ manifest }),
    (error: unknown) => ({ error }),
  );

  if ('manifest' in outcome) {
    assert.notEqual(outcome.manifest.status, 'completed');
  }
  const persisted = readJson<EvaluationManifest>(
    join(runDirectory, 'manifest.json'),
  );
  assert.notEqual(persisted.status, 'completed');
});

test('resume reruns when the evaluation case hash changes', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'changed-case-hash',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  const initial = await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
    },
  );
  writeFileSync(
    join(setup.casesDir, 'alpha.json'),
    `${JSON.stringify({
      ...evaluationCase('alpha'),
      research_goal: 'Evaluate alpha after the case changed',
    }, null, 2)}\n`,
  );
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    { ...options, resume: true },
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
  assert.notEqual(resumed.records[0].caseHash, initial.records[0].caseHash);
  assert.equal(resumed.records[0].status, 'succeeded');
});

test('resume reruns when the active Skill body hash changes', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'changed-skill-hash',
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
  setup.skillHashes.set('alpha', 'sha256:alpha-updated-body');
  let evaluateCalls = 0;

  const resumed = await runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          evaluateCalls += 1;
          return successRecord(loadedCase, {
            skillHash: setup.skillHashes.get('alpha')!,
          });
        },
      },
    },
  );

  assert.equal(evaluateCalls, 1);
  assert.equal(resumed.records[0].skillHash, 'sha256:alpha-updated-body');
  assert.equal(resumed.records[0].status, 'succeeded');
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
  assert.equal(validEvaluateCalls, 1);
  assert.equal(resumed.records[0].status, 'succeeded');
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
  const options = {
    runId: 'interrupted-resume',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) =>
          loadedCase.data.skill_id === 'alpha'
            ? successRecord(loadedCase, {
                modelName: 'preserved-model',
                modelVersion: 'preserved-v1',
                elapsedMs: 91,
                scorecard: scorecard('alpha', 87),
              })
            : successRecord(loadedCase),
      },
    },
  );
  const runDir = join(setup.outputRoot, options.runId);
  writeFileSync(join(runDir, 'beta', 'scorecard.json'), '{');
  let releaseBeta!: () => void;
  const betaBlocked = new Promise<void>((resolve) => {
    releaseBeta = resolve;
  });
  let signalBetaStarted!: () => void;
  const betaStarted = new Promise<void>((resolve) => {
    signalBetaStarted = resolve;
  });

  const running = runEvaluationBatch(
    { ...options, resume: true },
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
  assert.equal(interrupted.records[0].skillHash, 'sha256:alpha');
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

test('rejects a symlink run directory without writing through to its target', async () => {
  const setup = fixture(['alpha']);
  const externalTarget = join(setup.root, 'external-run-target');
  mkdirSync(setup.outputRoot);
  mkdirSync(externalTarget);
  symlinkSync(externalTarget, join(setup.outputRoot, 'linked-run'), 'dir');

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'linked-run',
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
    /symbolic link|symlink/i,
  );
  assert.deepEqual(readdirSync(externalTarget), []);
});

test('rejects a symlink Skill directory without writing through to its target', async () => {
  const setup = fixture(['alpha']);
  const runDirectory = join(setup.outputRoot, 'linked-skill-run');
  const externalTarget = join(setup.root, 'external-skill-target');
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(externalTarget);
  symlinkSync(externalTarget, join(runDirectory, 'alpha'), 'dir');

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'linked-skill-run',
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
    fsSafeFailure('symlink', 'path-alias'),
  );
  assert.deepEqual(readdirSync(externalTarget), []);
});

test('rejects a Skill directory swapped to an external symlink while awaiting evaluator', async () => {
  const setup = fixture(['alpha']);
  const runDirectory = join(setup.outputRoot, 'await-symlink-swap');
  const displacedDirectory = join(runDirectory, 'alpha-before-swap');
  const externalTarget = join(setup.root, 'await-symlink-external');
  mkdirSync(externalTarget);

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'await-symlink-swap',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        concurrency: 1,
        resume: false,
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase) => {
            const skillDirectory = join(runDirectory, 'alpha');
            renameSync(skillDirectory, displacedDirectory);
            symlinkSync(externalTarget, skillDirectory, 'dir');
            return successRecord(loadedCase);
          },
        },
      },
    ),
    fsSafeFailure('symlink', 'path-alias'),
  );

  assert.equal(existsSync(join(displacedDirectory, 'input.json')), true);
  assert.deepEqual(readdirSync(externalTarget), []);
});

test('rejects a run directory swapped to an external symlink while awaiting evaluator', async () => {
  const setup = fixture(['alpha']);
  const runDirectory = join(setup.outputRoot, 'await-run-symlink-swap');
  const displacedDirectory = join(setup.root, 'await-run-displaced');
  const externalTarget = join(setup.root, 'await-run-symlink-external');
  mkdirSync(externalTarget);

  await assert.rejects(
    runEvaluationBatch(
      {
        runId: 'await-run-symlink-swap',
        outputRoot: setup.outputRoot,
        casesDir: setup.casesDir,
        concurrency: 1,
        resume: false,
      },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase) => {
            renameSync(runDirectory, displacedDirectory);
            symlinkSync(externalTarget, runDirectory, 'dir');
            return successRecord(loadedCase);
          },
        },
      },
    ),
    fsSafeFailure('symlink', 'path-alias', 'path-mismatch'),
  );

  assert.equal(
    existsSync(join(displacedDirectory, 'alpha', 'input.json')),
    true,
  );
  assert.equal(existsSync(join(displacedDirectory, '.active.lock')), true);
  assert.deepEqual(readdirSync(externalTarget), []);
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

test('rejects a malformed lock without deleting an unknown owner', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'malformed-lock');
  const lockPath = join(runDir, '.active.lock');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ status: 'running', records: [] }));
  writeFileSync(lockPath, `${process.pid}garbage`);
  let evaluateCalls = 0;

  await assert.rejects(
    runEvaluationBatch(
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
    ),
    /lock owner is unknown|already active/i,
  );

  assert.equal(evaluateCalls, 0);
  assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}garbage`);
});

test('each run lock acquisition has a distinct owner token', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'distinct-lock-owner',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  const captureOwner = async (resume: boolean): Promise<string> => {
    let releaseEvaluator!: () => void;
    const evaluatorBlocked = new Promise<void>((resolve) => {
      releaseEvaluator = resolve;
    });
    let signalStarted!: () => void;
    const evaluatorStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const running = runEvaluationBatch(
      { ...options, resume },
      {
        skillLoader: setup.skillLoader,
        evaluator: {
          evaluate: async (loadedCase) => {
            signalStarted();
            await evaluatorBlocked;
            return successRecord(loadedCase);
          },
        },
      },
    );
    await evaluatorStarted;
    const owner = readFileSync(
      join(setup.outputRoot, options.runId, '.active.lock'),
      'utf8',
    );
    releaseEvaluator();
    await running;
    return owner;
  };

  const firstOwner = await captureOwner(false);
  writeFileSync(
    join(setup.outputRoot, options.runId, 'alpha', 'scorecard.json'),
    '{',
  );
  const secondOwner = await captureOwner(true);

  assert.notEqual(firstOwner, secondOwner);
});

test('stale recovery old release does not delete a replacement lock owner', async () => {
  const setup = fixture(['alpha']);
  const options = {
    runId: 'stale-owner-replacement',
    outputRoot: setup.outputRoot,
    casesDir: setup.casesDir,
    concurrency: 1 as const,
  };
  const completed = await runEvaluationBatch(
    { ...options, resume: false },
    {
      skillLoader: setup.skillLoader,
      evaluator: { evaluate: async (loadedCase) => successRecord(loadedCase) },
    },
  );
  const runDirectory = join(setup.outputRoot, options.runId);
  const lockPath = join(runDirectory, '.active.lock');
  const { completedAt: _completedAt, ...runningManifest } = completed;
  writeFileSync(
    join(runDirectory, 'manifest.json'),
    JSON.stringify({ ...runningManifest, status: 'running' }),
  );
  writeFileSync(join(runDirectory, 'alpha', 'scorecard.json'), '{');
  writeFileSync(lockPath, '99999999');
  let releaseEvaluator!: () => void;
  const evaluatorBlocked = new Promise<void>((resolve) => {
    releaseEvaluator = resolve;
  });
  let signalStarted!: () => void;
  const evaluatorStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  const running = runEvaluationBatch(
    { ...options, resume: true },
    {
      skillLoader: setup.skillLoader,
      evaluator: {
        evaluate: async (loadedCase) => {
          signalStarted();
          await evaluatorBlocked;
          return successRecord(loadedCase);
        },
      },
    },
  );
  await evaluatorStarted;
  const recoveredOwner = readFileSync(lockPath, 'utf8');
  const replacementOwner = `${recoveredOwner}:replacement-owner`;
  writeFileSync(lockPath, replacementOwner);
  releaseEvaluator();
  await running;

  assert.equal(existsSync(lockPath), true);
  assert.equal(readFileSync(lockPath, 'utf8'), replacementOwner);
});

test('keeps manifest running when summary publication fails', async () => {
  const setup = fixture(['alpha']);
  const runDir = join(setup.outputRoot, 'summary-failure');
  mkdirSync(join(runDir, 'summary.md'), { recursive: true });

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
    fsSafeFailure('not-file'),
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

test('CLI requires LLM_EXPECTED_ACTUAL_MODEL before building runtime', async () => {
  let runtimeBuilds = 0;
  const error = await runEvaluationCli([], {
    env: { LLM_PROVIDER: 'real-provider' },
    loadEnvFile: () => undefined,
    buildRuntime: () => {
      runtimeBuilds += 1;
      throw new Error('runtime must not build before model pin validation');
    },
  }).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  assert.equal(runtimeBuilds, 0);
  assert.match(String(error), /LLM_EXPECTED_ACTUAL_MODEL.*required/i);
});

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
