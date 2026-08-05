import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  compareEvaluationRounds,
  loadComparisonJson,
  type ComparisonOutput,
} from '../evaluations/skills/kb/compare.ts';
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
    if (round !== 'round0') {
      writeJson(join(skillDir, 'kb-assessment.json'), kbAssessment(skillId, round, index));
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
    'roundA_base_score',
    'roundA_kb_grounding_verdict',
    'roundB_base_score',
    'roundB_kb_grounding_verdict',
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
