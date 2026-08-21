import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  compareContentEvaluationRounds,
  compareEvaluationRounds,
  loadComparisonJson,
  type ContentComparisonOutput,
  type ComparisonOutput,
} from '../evaluations/skills/kb/compare.ts';
import type {
  ContentEvaluationAssessment,
  ContentEvaluationManifestMetadata,
} from '../evaluations/skills/content-overlay.ts';
import type { KBAssessment } from '../evaluations/skills/kb/assessment.ts';
import type {
  EvaluationManifest,
  SkillEvaluationRecord,
  SkillScorecard,
} from '../evaluations/skills/types.ts';

const SKILL_IDS = Array.from({ length: 22 }, (_, index) => `skill-${String(index + 1).padStart(2, '0')}`);

function scorecard(skillId: string, totalScore: number): SkillScorecard {
  return {
    skill_id: skillId,
    total_score: totalScore,
    verdict: totalScore >= 80 ? 'pass' : 'needs_review',
    dimensions: [],
    critical_defects: [],
    review_notes: [`score note ${skillId}`],
  };
}

function kbAssessment(skillId: string, mode: 'gold' | 'live', index: number): KBAssessment {
  const native = index >= 18;
  return {
    skill_id: skillId,
    mode,
    required_sources_available: !native,
    required_source_ids: native ? [] : [`source-${index}`],
    selected_source_ids: native ? [] : [`source-${index}`],
    missing_required_source_ids: [],
    cited_source_ids: native ? [] : [`source-${index}`],
    unsupported_canonical_claims: [],
    draft_sources_used: index === 0 && mode === 'live' ? ['draft-source'] : [],
    retrieval_recall: native ? null : mode === 'gold' ? 1 : 0.75,
    kb_grounding_verdict: native ? 'not_applicable' : mode === 'gold' ? 'pass' : 'needs_review',
    status_warnings: index === 0 && mode === 'live' ? ['draft source used: draft-source'] : [],
    review_notes: index === 1 && mode === 'live' ? ['unresolved retrieval item: ghost.md'] : [],
  };
}

function record(skillId: string, index: number, round: 'round0' | 'gold' | 'live', overrides: Partial<SkillEvaluationRecord> = {}): SkillEvaluationRecord {
  const caseHash = `sha256:case-${index}`;
  const baseScore = 80 + (index % 10);
  const roundDelta = round === 'round0' ? 0 : round === 'gold' ? 1 : 2;
  return {
    skillId,
    skillHash: `sha256:skill-${index}`,
    caseHash,
    modelName: 'GPT-5.4-joybuilder',
    modelVersion: 'gateway-v1',
    elapsedMs: 10,
    status: 'succeeded',
    output: { answer: `${skillId} ${round}` },
    scorecard: scorecard(skillId, baseScore + roundDelta),
    ...(round === 'round0' ? {} : { kbAssessment: kbAssessment(skillId, round, index) }),
    ...overrides,
  };
}

function manifest(runId: string, records: SkillEvaluationRecord[], kb?: EvaluationManifest['kb']): EvaluationManifest {
  return {
    runId,
    status: 'completed',
    startedAt: '2026-08-05T00:00:00.000Z',
    completedAt: '2026-08-05T00:01:00.000Z',
    provider: 'gateway',
    modelName: 'GPT-5.4-joybuilder',
    modelVersion: 'gateway-v1',
    activeSkillCount: records.length,
    activeSkillIds: records.map((entry) => entry.skillId),
    records,
    counts: { succeeded: records.length, needs_review: 0, failed: 0, skipped: 0 },
    ...(kb ? { kb } : {}),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeRound(root: string, runId: string, round: 'round0' | 'gold' | 'live', ids = SKILL_IDS): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const records = ids.map((skillId, index) => record(skillId, index, round));
  const kb = round === 'round0' ? undefined : {
    mode: round,
    snapshotId: 'sha256:snapshot-id',
    snapshotHash: 'sha256:snapshot-hash',
    indexHash: 'sha256:index-hash',
    sourceMappingHash: 'sha256:mapping-hash',
  } satisfies EvaluationManifest['kb'];
  writeJson(dir + '/manifest.json', manifest(runId, records, kb));
  for (const [index, skillId] of ids.entries()) {
    const skillDir = join(dir, skillId);
    mkdirSync(skillDir, { recursive: true });
    const currentRecord = records[index]!;
    writeJson(join(skillDir, 'output.json'), currentRecord.output ?? {});
    writeJson(join(skillDir, 'scorecard.json'), currentRecord.scorecard ?? {});
    if (round !== 'round0') {
      writeJson(join(skillDir, 'kb-assessment.json'), kbAssessment(skillId, round, index));
      writeJson(join(skillDir, 'knowledge-context.json'), {
        mode: round,
        snapshot_id: 'sha256:snapshot-id',
        required_source_ids: index >= 18 ? [] : [`source-${index}`],
        selected_source_ids: index >= 18 ? [] : [`source-${index}`],
        items: [],
      });
      writeJson(join(skillDir, 'retrieval.json'), {
        mode: round,
        snapshot_id: 'sha256:snapshot-id',
        guide_tags: [],
        candidate_source_ids: index >= 18 ? [] : [`source-${index}`],
        selected_source_ids: index >= 18 ? [] : [`source-${index}`],
        required_source_recall: index >= 18 ? null : round === 'gold' ? 1 : 0.75,
        missing_required_source_ids: [],
        unresolved_items: index === 1 && round === 'live' ? ['ghost.md'] : [],
      });
    }
  }
  return dir;
}

function writeRegistry(root: string, ids = SKILL_IDS): void {
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const skills = ids.map((id) => `  - id: ${id}\n    name: ${id}\n    path: skills/${id}/SKILL.md\n    when_to_use: test\n    owner: test\n    status: active\n    risk_level: low`).join('\n');
  writeFileSync(join(root, 'orchestrator/skill-registry.yaml'), `version: 1\nskills:\n${skills}\n`, 'utf8');
}

function fixture(): { root: string; output: string; round0: string; roundA: string; roundB: string; compare: string } {
  const root = mkdtempSync(join(tmpdir(), 'kb-compare-'));
  writeRegistry(root, [...SKILL_IDS].reverse());
  setConfigRoot(root);
  const output = join(root, 'skill-evaluations');
  return {
    root,
    output,
    round0: writeRound(output, 'round0', 'round0'),
    roundA: writeRound(output, 'roundA', 'gold'),
    roundB: writeRound(output, 'roundB', 'live'),
    compare: join(output, 'compare'),
  };
}

function rewriteStatuses(
  roundDirectory: string,
  statusFor: (index: number) => SkillEvaluationRecord['status'],
): void {
  const manifestPath = join(roundDirectory, 'manifest.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvaluationManifest;
  const records = original.records.map((entry, index) => ({ ...entry, status: statusFor(index) }));
  writeJson(manifestPath, {
    ...original,
    records,
    counts: {
      succeeded: records.filter((entry) => entry.status === 'succeeded').length,
      needs_review: records.filter((entry) => entry.status === 'needs_review').length,
      failed: records.filter((entry) => entry.status === 'failed').length,
      skipped: records.filter((entry) => entry.status === 'skipped').length,
    },
  });
}

function writeFailingPerfectScore(roundDirectory: string, skillId: string): void {
  const manifestPath = join(roundDirectory, 'manifest.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvaluationManifest;
  const records = original.records.map((entry) => entry.skillId === skillId ? {
    ...entry,
    scorecard: { ...entry.scorecard!, total_score: 100, verdict: 'fail' as const },
  } : entry);
  const changed = records.find((entry) => entry.skillId === skillId)!;
  writeJson(manifestPath, { ...original, records });
  writeJson(join(roundDirectory, skillId, 'scorecard.json'), changed.scorecard);
}

test('accepts completed rounds when all or some intact records are skipped', () => {
  for (const [scenario, shouldSkip] of [
    ['all', (_index: number) => true],
    ['some', (index: number) => index % 2 === 0],
  ] as const) {
    const setup = fixture();
    for (const roundDirectory of [setup.round0, setup.roundA, setup.roundB]) {
      rewriteStatuses(roundDirectory, (index) => shouldSkip(index) ? 'skipped' : 'succeeded');
    }

    const result = compareEvaluationRounds({
      round0: setup.round0,
      roundA: setup.roundA,
      roundB: setup.roundB,
      output: setup.compare,
    });

    assert.equal(result.rows.length, 22, `${scenario} skipped records must remain comparable`);
  }
});

test('rejects completed rounds containing intact needs_review or failed records', () => {
  for (const status of ['needs_review', 'failed'] as const) {
    const setup = fixture();
    rewriteStatuses(setup.roundA, (index) => index === 0 ? status : 'succeeded');

    assert.throws(
      () => compareEvaluationRounds({ round0: setup.round0, roundA: setup.roundA, roundB: setup.roundB, output: setup.compare }),
      new RegExp(status),
    );
  }
});

test('preserves each round base verdict in JSON, CSV, and Markdown when perfect scores still fail', () => {
  const setup = fixture();
  const skillId = SKILL_IDS[0]!;
  for (const roundDirectory of [setup.round0, setup.roundA, setup.roundB]) {
    writeFailingPerfectScore(roundDirectory, skillId);
  }

  compareEvaluationRounds({
    round0: setup.round0,
    roundA: setup.roundA,
    roundB: setup.roundB,
    output: setup.compare,
  });

  const json = loadComparisonJson(join(setup.compare, 'kb-comparison.json')) as ComparisonOutput;
  const jsonRow = json.rows.find((row) => row.skill_id === skillId) as ComparisonOutput['rows'][number] & Record<string, unknown>;

  const csvLines = readFileSync(join(setup.compare, 'kb-comparison.csv'), 'utf8').trim().split('\n');
  const csvHeaders = csvLines[0]!.split(',');
  const csvValues = csvLines.find((line) => line.startsWith(`"${skillId}"`))!
    .split(',')
    .map((value) => value.slice(1, -1));
  const csvRow = Object.fromEntries(csvHeaders.map((header, index) => [header, csvValues[index]]));

  const markdownLines = readFileSync(join(setup.compare, 'kb-comparison.md'), 'utf8').split('\n');
  const markdownHeaders = markdownLines.find((line) => line.startsWith('| skill_id |'))!
    .split('|')
    .slice(1, -1)
    .map((value) => value.trim());
  const markdownValues = markdownLines.find((line) => line.startsWith(`| ${skillId} |`))!
    .split('|')
    .slice(1, -1)
    .map((value) => value.trim());
  const markdownRow = Object.fromEntries(markdownHeaders.map((header, index) => [header, markdownValues[index]]));

  const verdicts = {
    json: {
      round0: jsonRow.round0_base_verdict,
      roundA: jsonRow.roundA_base_verdict,
      roundB: jsonRow.roundB_base_verdict,
    },
    csv: {
      round0: csvRow.round0_base_verdict,
      roundA: csvRow.roundA_base_verdict,
      roundB: csvRow.roundB_base_verdict,
    },
    markdown: {
      round0: markdownRow.round0_base_verdict,
      roundA: markdownRow.roundA_base_verdict,
      roundB: markdownRow.roundB_base_verdict,
    },
  };
  assert.deepEqual(verdicts, {
    json: { round0: 'fail', roundA: 'fail', roundB: 'fail' },
    csv: { round0: 'fail', roundA: 'fail', roundB: 'fail' },
    markdown: { round0: 'fail', roundA: 'fail', roundB: 'fail' },
  });
});

test('compares the same 22 Skills with base scores and KB verdicts sorted by active registry order', () => {
  const setup = fixture();
  const result = compareEvaluationRounds({
    round0: setup.round0,
    roundA: setup.roundA,
    roundB: setup.roundB,
    output: setup.compare,
  });

  assert.equal(result.rows.length, 22);
  assert.deepEqual(result.rows.map((row) => row.skill_id), [...SKILL_IDS].reverse());
  assert.deepEqual(Object.keys(result.rows[0]).sort(), [
    'draft_warning_count',
    'retrieval_recall',
    'review_notes',
    'round0_base_score',
    'round0_base_verdict',
    'roundA_base_score',
    'roundA_kb_grounding_verdict',
    'roundA_base_verdict',
    'roundB_base_score',
    'roundB_kb_grounding_verdict',
    'roundB_base_verdict',
    'skill_id',
    'unresolved_source_count',
  ].sort());
  assert.equal(result.rows.find((row) => row.skill_id === 'skill-01')?.round0_base_score, 80);
  assert.equal(result.rows.find((row) => row.skill_id === 'skill-01')?.roundA_kb_grounding_verdict, 'pass');
  assert.equal(result.rows.find((row) => row.skill_id === 'skill-01')?.roundB_kb_grounding_verdict, 'needs_review');
  assert.equal(result.rows.find((row) => row.skill_id === 'skill-01')?.draft_warning_count, 1);
  assert.equal(result.rows.find((row) => row.skill_id === 'skill-02')?.unresolved_source_count, 1);
});

test('writes parseable Markdown, CSV, and JSON comparison artifacts with warning sections', () => {
  const setup = fixture();
  compareEvaluationRounds({
    round0: setup.round0,
    roundA: setup.roundA,
    roundB: setup.roundB,
    output: setup.compare,
  });

  const jsonPath = join(setup.compare, 'kb-comparison.json');
  const md = readFileSync(join(setup.compare, 'kb-comparison.md'), 'utf8');
  const csv = readFileSync(join(setup.compare, 'kb-comparison.csv'), 'utf8');
  const json = loadComparisonJson(jsonPath) as ComparisonOutput;

  assert.equal(existsSync(jsonPath), true);
  assert.match(md, /## Unresolved mapping\/source status warnings/);
  assert.match(md, /draft source used: draft-source/);
  assert.match(md, /unresolved retrieval item: ghost\.md/);
  assert.match(csv.split('\n')[0], /round0_base_score,roundA_base_score,roundB_base_score/);
  assert.equal(json.metadata.round0.runId, 'round0');
  assert.equal(json.metadata.roundA.kbSnapshotId, 'sha256:snapshot-id');
  assert.equal(json.rows.length, 22);
});

test('rejects incomplete completed_with_failures rounds before writing comparison artifacts', () => {
  const setup = fixture();
  const manifestPath = join(setup.roundA, 'manifest.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvaluationManifest;
  const failedSkill = original.activeSkillIds[0]!;
  writeJson(manifestPath, {
    ...original,
    status: 'completed_with_failures',
    records: original.records.map((entry, index) => index === 0 ? {
      skillId: entry.skillId,
      skillHash: entry.skillHash,
      caseHash: entry.caseHash,
      modelName: entry.modelName,
      modelVersion: entry.modelVersion,
      elapsedMs: entry.elapsedMs,
      status: 'failed',
      errorStage: 'generation',
      errorMessage: 'gateway 429',
    } : entry),
  });
  unlinkSync(join(setup.roundA, failedSkill, 'output.json'));
  unlinkSync(join(setup.roundA, failedSkill, 'scorecard.json'));

  assert.throws(
    () => compareEvaluationRounds({ round0: setup.round0, roundA: setup.roundA, roundB: setup.roundB, output: setup.compare }),
    /incomplete|completed/i,
  );
  assert.equal(existsSync(join(setup.compare, 'kb-comparison.json')), false);
});

test('rejects RoundA when its KB mode is not gold before writing comparison artifacts', () => {
  const setup = fixture();
  const manifestPath = join(setup.roundA, 'manifest.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvaluationManifest;
  writeJson(manifestPath, { ...original, kb: { ...original.kb!, mode: 'live' } });

  assert.throws(
    () => compareEvaluationRounds({ round0: setup.round0, roundA: setup.roundA, roundB: setup.roundB, output: setup.compare }),
    /roundA.*mode|mode.*roundA/i,
  );
  assert.equal(existsSync(join(setup.compare, 'kb-comparison.json')), false);
});

test('rejects comparisons when model, case hashes, or KB snapshot IDs differ', () => {
  const setup = fixture();
  const manifestPath = join(setup.roundB, 'manifest.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvaluationManifest;

  writeJson(manifestPath, { ...original, modelName: 'other-model' });
  assert.throws(() => compareEvaluationRounds({ round0: setup.round0, roundA: setup.roundA, roundB: setup.roundB, output: setup.compare }), /model/i);

  writeJson(manifestPath, {
    ...original,
    records: original.records.map((entry, index) => index === 0 ? { ...entry, caseHash: 'sha256:changed-case' } : entry),
  });
  assert.throws(() => compareEvaluationRounds({ round0: setup.round0, roundA: setup.roundA, roundB: setup.roundB, output: setup.compare }), /case hash/i);

  writeJson(manifestPath, { ...original, kb: { ...original.kb!, snapshotId: 'sha256:other-snapshot' } });
  assert.throws(() => compareEvaluationRounds({ round0: setup.round0, roundA: setup.roundA, roundB: setup.roundB, output: setup.compare }), /snapshot/i);
});


test('compares baseline and content-enhanced rounds with frozen hashes and explicit criteria', () => {
  const setup = fixture();
  const entry = {
    id: 'candidate-method',
    kind: 'method' as const,
    path: 'knowledge-base/methods/candidate.md',
    status: 'candidate' as const,
    sourceHash: 'sha256:source',
    contentHash: 'sha256:content',
    artifactHash: 'sha256:artifact',
  };
  function metadata(variant: 'baseline' | 'enhanced'): ContentEvaluationManifestMetadata {
    return {
      overlayId: 'user-research-hub-c1',
      overlayVersion: 1,
      variant,
      scope: 'evaluation_only',
      gate: 'gate-3-pending',
      manifestHash: 'sha256:manifest',
      contentSetHash: 'sha256:set',
      promptHash: 'sha256:prompt',
      rubricHash: 'sha256:rubric',
      criteria: {
        grounding: [{ id: 'external_evidence_bound', criterion: 'grounding' }],
        strategyChain: [{ id: 'recommendation_coverage', criterion: 'coverage' }],
      },
      fixedTaskSkillId: SKILL_IDS[0]!,
      fixedTaskCaseHash: 'sha256:case-0',
      productionSearchUsed: false,
      candidateGenerationMode: 'fixed',
      entries: [entry],
      promotionSet: {
        knowledgeCandidateIds: [entry.id],
        assetCandidateIds: [],
        draftSkillIds: [],
        skillDeltaIds: [],
      },
      injectedSourceIds: variant === 'enhanced' ? [entry.id] : [],
      appliedSkillDeltaIds: [],
      productionBaseline: {
        planningPolicyHash: 'sha256:policy',
        promptHash: 'sha256:production-prompt',
        rubricHash: 'sha256:production-rubric',
      },
    };
  }
  function assessment(variant: 'baseline' | 'enhanced'): ContentEvaluationAssessment {
    const pass = variant === 'enhanced';
    return {
      overlay_id: 'user-research-hub-c1',
      variant,
      grounding_verdict: 'pass',
      strategy_chain_verdict: pass ? 'pass' : 'fail',
      grounding_criteria: [{ id: 'external_evidence_bound', status: 'pass', evidence: ['C1'] }],
      strategy_chain_criteria: [{ id: 'recommendation_coverage', status: pass ? 'pass' : 'fail', evidence: [] }],
      chain_count: pass ? 1 : 0,
      candidate_source_ids: [entry.id],
      cited_candidate_source_ids: pass ? [entry.id] : [],
      tool_evidence_ids: ['C1'],
      review_notes: pass ? [] : ['strategy-chain criterion failed: recommendation_coverage'],
    };
  }
  for (const [directory, variant] of [[setup.roundA, 'baseline'], [setup.roundB, 'enhanced']] as const) {
    const path = join(directory, 'manifest.json');
    const original = JSON.parse(readFileSync(path, 'utf8')) as EvaluationManifest;
    const records = original.records.map((current) => ({ ...current, contentAssessment: assessment(variant) }));
    writeJson(path, {
      ...original,
      kb: { ...original.kb!, mode: 'gold' },
      contentEvaluation: metadata(variant),
      records,
    });
    for (const record of records) writeJson(join(directory, record.skillId, 'content-assessment.json'), record.contentAssessment);
  }

  const result = compareContentEvaluationRounds({
    baseline: setup.roundA,
    contentEnhanced: setup.roundB,
    output: setup.compare,
  });

  assert.equal(result.rows.length, 22);
  assert.equal(result.rows[0]?.baseline_strategy_chain_verdict, 'fail');
  assert.equal(result.rows[0]?.content_enhanced_strategy_chain_verdict, 'pass');
  assert.equal(result.metadata.productionSearchUsed, false);
  assert.equal(result.metadata.candidateGenerationMode, 'fixed');
  assert.deepEqual(result.metadata.sourceContentHashes, [entry]);
  assert.deepEqual(result.metadata.promotionSet.knowledgeCandidateIds, [entry.id]);
  const json = loadComparisonJson(join(setup.compare, 'content-comparison.json')) as ContentComparisonOutput;
  assert.equal(json.metadata.contentSetHash, 'sha256:set');
  assert.match(readFileSync(join(setup.compare, 'content-comparison.md'), 'utf8'), /Frozen source and content hashes/);
  assert.match(readFileSync(join(setup.compare, 'content-comparison.csv'), 'utf8'), /content_enhanced_strategy_chain_verdict/);
});
