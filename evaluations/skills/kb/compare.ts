import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SkillLoader } from '../../../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { writeAtomic, writeJsonAtomic } from '../report-writer.ts';
import type {
  ContentEvaluationAssessment,
  ContentEvaluationManifestMetadata,
} from '../content-overlay.ts';
import type { KBAssessment } from './assessment.ts';
import type { RetrievalRecord } from './types.ts';
import type { EvaluationManifest, EvaluationVerdict, SkillEvaluationRecord } from '../types.ts';

export interface CompareOptions {
  round0: string;
  roundA: string;
  roundB: string;
  output: string;
}

export interface ContentCompareOptions {
  baseline: string;
  contentEnhanced: string;
  output: string;
}

export interface ContentComparisonRow {
  skill_id: string;
  baseline_score: number | null;
  content_enhanced_score: number | null;
  score_delta: number | null;
  baseline_kb_grounding_verdict: KBAssessment['kb_grounding_verdict'] | null;
  content_enhanced_kb_grounding_verdict: KBAssessment['kb_grounding_verdict'] | null;
  baseline_content_grounding_verdict: ContentEvaluationAssessment['grounding_verdict'] | null;
  content_enhanced_grounding_verdict: ContentEvaluationAssessment['grounding_verdict'] | null;
  baseline_strategy_chain_verdict: ContentEvaluationAssessment['strategy_chain_verdict'] | null;
  content_enhanced_strategy_chain_verdict: ContentEvaluationAssessment['strategy_chain_verdict'] | null;
  baseline_failed_criteria: string[];
  content_enhanced_failed_criteria: string[];
  cited_candidate_source_ids: string[];
}

export interface ContentComparisonOutput {
  metadata: {
    generatedAt: string;
    baseline: RoundMetadata;
    contentEnhanced: RoundMetadata;
    overlayId: string;
    manifestHash: string;
    contentSetHash: string;
    promptHash: string;
    rubricHash: string;
    criteria: ContentEvaluationManifestMetadata['criteria'];
    productionSearchUsed: false;
    candidateGenerationMode: 'fixed';
    sourceContentHashes: ContentEvaluationManifestMetadata['entries'];
    promotionSet: ContentEvaluationManifestMetadata['promotionSet'];
    injectedSourceIds: string[];
    appliedSkillDeltaIds: string[];
    activeSkillCount: number;
    activeSkillIds: string[];
  };
  rows: ContentComparisonRow[];
}

export interface ComparisonRow {
  skill_id: string;
  round0_base_score: number | null;
  roundA_base_score: number | null;
  roundB_base_score: number | null;
  round0_base_verdict: EvaluationVerdict | null;
  roundA_base_verdict: EvaluationVerdict | null;
  roundB_base_verdict: EvaluationVerdict | null;
  roundA_kb_grounding_verdict: KBAssessment['kb_grounding_verdict'] | null;
  roundB_kb_grounding_verdict: KBAssessment['kb_grounding_verdict'] | null;
  retrieval_recall: number | null;
  draft_warning_count: number;
  unresolved_source_count: number;
  review_notes: string[];
}

export interface ComparisonWarning {
  skill_id: string;
  round: 'roundA' | 'roundB';
  kind: 'status_warning' | 'unresolved_source' | 'missing_artifact';
  message: string;
}

export interface ComparisonOutput {
  metadata: {
    generatedAt: string;
    round0: RoundMetadata;
    roundA: RoundMetadata;
    roundB: RoundMetadata;
    activeSkillCount: number;
    activeSkillIds: string[];
  };
  rows: ComparisonRow[];
  warnings: ComparisonWarning[];
}

interface RoundMetadata {
  runId: string;
  path: string;
  status: EvaluationManifest['status'];
  provider: string;
  modelName: string | null;
  modelVersion: string | null;
  kbMode: string | null;
  kbSnapshotId: string | null;
  kbSnapshotHash: string | null;
  caseHashes: Record<string, string>;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read JSON ${path}: ${message}`);
  }
}

function manifestPath(roundDirectory: string): string {
  return join(roundDirectory, 'manifest.json');
}

function loadManifest(roundDirectory: string): EvaluationManifest {
  const manifest = readJson<EvaluationManifest>(manifestPath(roundDirectory));
  if (!Array.isArray(manifest.activeSkillIds) || !Array.isArray(manifest.records)) {
    throw new Error(`invalid manifest: ${manifestPath(roundDirectory)}`);
  }
  return manifest;
}

function bySkill(records: SkillEvaluationRecord[]): Map<string, SkillEvaluationRecord> {
  const indexed = new Map<string, SkillEvaluationRecord>();
  for (const record of records) {
    if (indexed.has(record.skillId)) throw new Error(`duplicate record for Skill ${record.skillId}`);
    indexed.set(record.skillId, record);
  }
  return indexed;
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function modelKey(manifest: EvaluationManifest): string {
  return `${manifest.provider}\0${manifest.modelName ?? ''}\0${manifest.modelVersion ?? ''}`;
}

function caseHashMap(manifest: EvaluationManifest): Map<string, string> {
  return new Map(manifest.records.map((record) => [record.skillId, record.caseHash]));
}

function assertSameSkillIds(round0: EvaluationManifest, roundA: EvaluationManifest, roundB: EvaluationManifest): void {
  if (round0.activeSkillCount !== 22 || roundA.activeSkillCount !== 22 || roundB.activeSkillCount !== 22) {
    throw new Error(`comparison requires 22 active Skills per round; got ${round0.activeSkillCount}/${roundA.activeSkillCount}/${roundB.activeSkillCount}`);
  }
  if (!sameSet(round0.activeSkillIds, roundA.activeSkillIds) || !sameSet(round0.activeSkillIds, roundB.activeSkillIds)) {
    throw new Error('round active Skill ID sets differ');
  }
}

function assertSameModel(round0: EvaluationManifest, roundA: EvaluationManifest, roundB: EvaluationManifest): void {
  const expected = modelKey(round0);
  if (modelKey(roundA) !== expected || modelKey(roundB) !== expected) {
    throw new Error('round model metadata differs');
  }
}

function assertSameCaseHashes(round0: EvaluationManifest, roundA: EvaluationManifest, roundB: EvaluationManifest): void {
  const base = caseHashMap(round0);
  for (const manifest of [roundA, roundB]) {
    const current = caseHashMap(manifest);
    for (const [skillId, hash] of base) {
      if (current.get(skillId) !== hash) {
        throw new Error(`round case hash differs for ${skillId}`);
      }
    }
  }
}

function assertSameSnapshot(roundA: EvaluationManifest, roundB: EvaluationManifest): void {
  if (!roundA.kb || !roundB.kb) throw new Error('KB comparison requires KB metadata for Round A and Round B');
  if (roundA.kb.snapshotId !== roundB.kb.snapshotId || roundA.kb.snapshotHash !== roundB.kb.snapshotHash) {
    throw new Error('KB snapshot metadata differs');
  }
  if (roundA.kb.indexHash !== roundB.kb.indexHash || roundA.kb.sourceMappingHash !== roundB.kb.sourceMappingHash) {
    throw new Error('KB index or source mapping hash differs');
  }
}
function assertRoundRoles(
  round0: EvaluationManifest,
  roundA: EvaluationManifest,
  roundB: EvaluationManifest,
): void {
  if (round0.kb) throw new Error('round0 must not include KB metadata');
  if (roundA.kb?.mode !== 'gold') throw new Error('roundA KB mode must be gold');
  if (roundB.kb?.mode !== 'live') throw new Error('roundB KB mode must be live');
}


function assertCompleteRound(
  label: 'round0' | 'roundA' | 'roundB',
  roundDirectory: string,
  manifest: EvaluationManifest,
): void {
  if (manifest.status !== 'completed') {
    throw new Error(`${label} is incomplete: manifest status is ${manifest.status}`);
  }
  const records = bySkill(manifest.records);
  for (const skillId of manifest.activeSkillIds) {
    const record = records.get(skillId);
    if (!record) throw new Error(`${label} is incomplete: missing record for ${skillId}`);
    if (record.status !== 'succeeded' && record.status !== 'skipped') {
      throw new Error(`${label} is incomplete: ${skillId} status is ${record.status}`);
    }
    if (typeof record.scorecard?.total_score !== 'number') throw new Error(`${label} is incomplete: missing scorecard for ${skillId}`);
    if (!record.output) throw new Error(`${label} is incomplete: missing output for ${skillId}`);
    for (const file of ['output.json', 'scorecard.json']) {
      readJson(join(roundDirectory, skillId, file));
    }
    if (label !== 'round0') {
      for (const file of ['knowledge-context.json', 'retrieval.json', 'kb-assessment.json']) {
        readJson(join(roundDirectory, skillId, file));
      }
    }
  }
}

function activeCatalogOrder(skillIds: string[]): string[] {
  const registryIds = new SkillLoader().listActiveSkills().map((skill) => skill.id);
  const registrySet = new Set(registryIds);
  const ordered = registryIds.filter((skillId) => skillIds.includes(skillId));
  const unknown = skillIds.filter((skillId) => !registrySet.has(skillId)).sort();
  if (unknown.length > 0) throw new Error(`comparison Skills missing from active catalog: ${unknown.join(', ')}`);
  return ordered;
}

function score(record: SkillEvaluationRecord | undefined): number | null {
  return record?.scorecard?.total_score ?? null;
}


function assessmentFrom(roundDirectory: string, record: SkillEvaluationRecord | undefined): KBAssessment | undefined {
  if (!record) return undefined;
  if (record.kbAssessment) return record.kbAssessment;
  try {
    return readJson<KBAssessment>(join(roundDirectory, record.skillId, 'kb-assessment.json'));
  } catch {
    return undefined;
  }
}

function retrievalFrom(roundDirectory: string, record: SkillEvaluationRecord | undefined): RetrievalRecord | undefined {
  if (!record) return undefined;
  try {
    return readJson<RetrievalRecord>(join(roundDirectory, record.skillId, 'retrieval.json'));
  } catch {
    return undefined;
  }
}

function collectWarnings(
  skillId: string,
  round: 'roundA' | 'roundB',
  assessment: KBAssessment | undefined,
  retrieval: RetrievalRecord | undefined,
): ComparisonWarning[] {
  if (!assessment) {
    return [{ skill_id: skillId, round, kind: 'missing_artifact', message: 'missing kb-assessment.json' }];
  }
  const warnings: ComparisonWarning[] = assessment.status_warnings.map((message) => ({
    skill_id: skillId,
    round,
    kind: 'status_warning',
    message,
  }));
  const unresolvedMessages = new Set(retrieval?.unresolved_items ?? []);
  for (const note of assessment.review_notes.filter((item) => /unresolved/i.test(item))) {
    if (![...unresolvedMessages].some((item) => note.includes(item))) unresolvedMessages.add(note);
  }
  for (const message of unresolvedMessages) {
    warnings.push({ skill_id: skillId, round, kind: 'unresolved_source', message });
  }
  return warnings;
}

function roundMetadata(roundDirectory: string, manifest: EvaluationManifest): RoundMetadata {
  return {
    runId: manifest.runId,
    path: roundDirectory,
    status: manifest.status,
    provider: manifest.provider,
    modelName: manifest.modelName ?? null,
    modelVersion: manifest.modelVersion ?? null,
    kbMode: manifest.kb?.mode ?? null,
    kbSnapshotId: manifest.kb?.snapshotId ?? null,
    kbSnapshotHash: manifest.kb?.snapshotHash ?? null,
    caseHashes: Object.fromEntries([...caseHashMap(manifest)].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function renderMarkdown(output: ComparisonOutput): string {
  const headers = [
    'skill_id',
    'round0_base_score',
    'roundA_base_score',
    'roundB_base_score',
    'round0_base_verdict',
    'roundA_base_verdict',
    'roundB_base_verdict',
    'roundA_kb_grounding_verdict',
    'roundB_kb_grounding_verdict',
    'retrieval_recall',
    'draft_warning_count',
    'unresolved_source_count',
    'review_notes',
  ];
  const rows = output.rows.map((row) => `| ${headers.map((header) => markdownCell(row[header as keyof ComparisonRow])).join(' | ')} |`);
  const warningRows = output.warnings.length === 0
    ? ['No unresolved mapping/source status warnings.']
    : output.warnings.map((warning) => `- ${warning.skill_id} ${warning.round} ${warning.kind}: ${warning.message}`);
  return [
    '# KB-aware Skill Evaluation Comparison',
    '',
    `Generated at: ${output.metadata.generatedAt}`,
    '',
    `Round 0: ${output.metadata.round0.runId}`,
    `Round A: ${output.metadata.roundA.runId} (${output.metadata.roundA.kbMode}, ${output.metadata.roundA.kbSnapshotId})`,
    `Round B: ${output.metadata.roundB.runId} (${output.metadata.roundB.kbMode}, ${output.metadata.roundB.kbSnapshotId})`,
    '',
    '## Scores and KB grounding',
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
    '## Unresolved mapping/source status warnings',
    '',
    ...warningRows,
    '',
  ].join('\n');
}

function markdownCell(value: unknown): string {
  if (Array.isArray(value)) return value.join('; ').replaceAll('|', '\\|');
  return String(value ?? '').replaceAll('|', '\\|');
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function renderCsv(rows: ComparisonRow[]): string {
  const headers = [
    'skill_id',
    'round0_base_score',
    'roundA_base_score',
    'roundB_base_score',
    'round0_base_verdict',
    'roundA_base_verdict',
    'roundB_base_verdict',
    'roundA_kb_grounding_verdict',
    'roundB_kb_grounding_verdict',
    'retrieval_recall',
    'draft_warning_count',
    'unresolved_source_count',
    'review_notes',
  ];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof ComparisonRow])).join(',')),
    '',
  ].join('\n');
}

export function compareEvaluationRounds(options: CompareOptions): ComparisonOutput {
  const round0Directory = resolve(options.round0);
  const roundADirectory = resolve(options.roundA);
  const roundBDirectory = resolve(options.roundB);
  const outputDirectory = resolve(options.output);
  const round0 = loadManifest(round0Directory);
  const roundA = loadManifest(roundADirectory);
  const roundB = loadManifest(roundBDirectory);

  assertSameSkillIds(round0, roundA, roundB);
  assertSameModel(round0, roundA, roundB);
  assertSameCaseHashes(round0, roundA, roundB);
  assertRoundRoles(round0, roundA, roundB);
  assertSameSnapshot(roundA, roundB);
  assertCompleteRound('round0', round0Directory, round0);
  assertCompleteRound('roundA', roundADirectory, roundA);
  assertCompleteRound('roundB', roundBDirectory, roundB);

  const order = activeCatalogOrder(round0.activeSkillIds);
  const round0Records = bySkill(round0.records);
  const roundARecords = bySkill(roundA.records);
  const roundBRecords = bySkill(roundB.records);
  const warnings: ComparisonWarning[] = [];

  const rows = order.map((skillId) => {
    const roundARecord = roundARecords.get(skillId);
    const roundBRecord = roundBRecords.get(skillId);
    const roundAAssessment = assessmentFrom(roundADirectory, roundARecord);
    const roundBAssessment = assessmentFrom(roundBDirectory, roundBRecord);
    const roundARetrieval = retrievalFrom(roundADirectory, roundARecord);
    const roundBRetrieval = retrievalFrom(roundBDirectory, roundBRecord);
    warnings.push(...collectWarnings(skillId, 'roundA', roundAAssessment, roundARetrieval));
    warnings.push(...collectWarnings(skillId, 'roundB', roundBAssessment, roundBRetrieval));
    const roundWarnings = warnings.filter((warning) => warning.skill_id === skillId);
    const reviewNotes = [
      ...(roundAAssessment?.review_notes ?? []),
      ...(roundBAssessment?.review_notes ?? []),
    ];
    return {
      skill_id: skillId,
      round0_base_score: score(round0Records.get(skillId)),
      roundA_base_score: score(roundARecord),
      roundB_base_score: score(roundBRecord),
      round0_base_verdict: round0Records.get(skillId)?.scorecard?.verdict ?? null,
      roundA_base_verdict: roundARecord?.scorecard?.verdict ?? null,
      roundB_base_verdict: roundBRecord?.scorecard?.verdict ?? null,
      roundA_kb_grounding_verdict: roundAAssessment?.kb_grounding_verdict ?? null,
      roundB_kb_grounding_verdict: roundBAssessment?.kb_grounding_verdict ?? null,
      retrieval_recall: roundBAssessment?.retrieval_recall ?? roundBRetrieval?.required_source_recall ?? roundAAssessment?.retrieval_recall ?? null,
      draft_warning_count: roundWarnings.filter((warning) => warning.kind === 'status_warning').length,
      unresolved_source_count: roundWarnings.filter((warning) => warning.kind === 'unresolved_source').length,
      review_notes: reviewNotes,
    } satisfies ComparisonRow;
  });

  const output: ComparisonOutput = {
    metadata: {
      generatedAt: new Date().toISOString(),
      round0: roundMetadata(round0Directory, round0),
      roundA: roundMetadata(roundADirectory, roundA),
      roundB: roundMetadata(roundBDirectory, roundB),
      activeSkillCount: order.length,
      activeSkillIds: order,
    },
    rows,
    warnings,
  };

  mkdirSync(outputDirectory, { recursive: true });
  writeJsonAtomic(join(outputDirectory, 'kb-comparison.json'), output);
  writeAtomic(join(outputDirectory, 'kb-comparison.csv'), renderCsv(rows));
  writeAtomic(join(outputDirectory, 'kb-comparison.md'), renderMarkdown(output));
  return output;
}

function contentAssessmentFrom(
  roundDirectory: string,
  record: SkillEvaluationRecord | undefined,
): ContentEvaluationAssessment | undefined {
  if (!record) return undefined;
  if (record.contentAssessment) return record.contentAssessment;
  try {
    return readJson<ContentEvaluationAssessment>(join(roundDirectory, record.skillId, 'content-assessment.json'));
  } catch {
    return undefined;
  }
}

function failedCriteria(assessment: ContentEvaluationAssessment | undefined): string[] {
  if (!assessment) return ['missing_content_assessment'];
  return [...assessment.grounding_criteria, ...assessment.strategy_chain_criteria]
    .filter(({ status }) => status === 'fail')
    .map(({ id }) => id);
}

function contentMetadata(manifest: EvaluationManifest, label: string): ContentEvaluationManifestMetadata {
  if (!manifest.contentEvaluation) throw new Error(`${label} is missing content evaluation metadata`);
  return manifest.contentEvaluation;
}

function assertContentComparisonIdentity(
  baseline: EvaluationManifest,
  enhanced: EvaluationManifest,
): { baseline: ContentEvaluationManifestMetadata; enhanced: ContentEvaluationManifestMetadata } {
  if (!sameSet(baseline.activeSkillIds, enhanced.activeSkillIds)) throw new Error('content comparison active Skill ID sets differ');
  if (modelKey(baseline) !== modelKey(enhanced)) throw new Error('content comparison model metadata differs');
  assertSameCaseHashes(baseline, enhanced, enhanced);
  if (!baseline.kb || !enhanced.kb || baseline.kb.mode !== 'gold' || enhanced.kb.mode !== 'gold') {
    throw new Error('content comparison requires deterministic gold KB mode for both rounds');
  }
  if (baseline.kb.snapshotId !== enhanced.kb.snapshotId
    || baseline.kb.snapshotHash !== enhanced.kb.snapshotHash
    || baseline.kb.indexHash !== enhanced.kb.indexHash
    || baseline.kb.sourceMappingHash !== enhanced.kb.sourceMappingHash) {
    throw new Error('content comparison KB snapshot metadata differs');
  }
  const baselineMetadata = contentMetadata(baseline, 'baseline');
  const enhancedMetadata = contentMetadata(enhanced, 'content-enhanced round');
  if (baselineMetadata.variant !== 'baseline' || enhancedMetadata.variant !== 'enhanced') {
    throw new Error('content comparison requires baseline and enhanced variants');
  }
  for (const key of ['overlayId', 'overlayVersion', 'scope', 'gate', 'manifestHash', 'contentSetHash', 'promptHash', 'rubricHash', 'fixedTaskSkillId', 'fixedTaskCaseHash', 'candidateGenerationMode'] as const) {
    if (baselineMetadata[key] !== enhancedMetadata[key]) throw new Error(`content comparison overlay ${key} differs`);
  }
  if (JSON.stringify(baselineMetadata.criteria) !== JSON.stringify(enhancedMetadata.criteria)) {
    throw new Error('content comparison criteria differ');
  }
  if (baselineMetadata.productionSearchUsed !== false || enhancedMetadata.productionSearchUsed !== false) {
    throw new Error('content comparison cannot use production search');
  }
  if (JSON.stringify(baselineMetadata.entries) !== JSON.stringify(enhancedMetadata.entries)
    || JSON.stringify(baselineMetadata.promotionSet) !== JSON.stringify(enhancedMetadata.promotionSet)
    || JSON.stringify(baselineMetadata.productionBaseline) !== JSON.stringify(enhancedMetadata.productionBaseline)) {
    throw new Error('content comparison source/content hashes differ');
  }
  if (baselineMetadata.injectedSourceIds.length !== 0 || baselineMetadata.appliedSkillDeltaIds.length !== 0) {
    throw new Error('baseline content comparison round must not inject overlay content');
  }
  if (!baseline.activeSkillIds.includes(enhancedMetadata.fixedTaskSkillId)) {
    throw new Error(`content comparison must include fixed task ${enhancedMetadata.fixedTaskSkillId}`);
  }
  const fixedRecord = baseline.records.find(({ skillId }) => skillId === enhancedMetadata.fixedTaskSkillId);
  if (fixedRecord?.caseHash !== enhancedMetadata.fixedTaskCaseHash) {
    throw new Error('content comparison fixed task case hash differs from the frozen overlay case');
  }
  if (enhancedMetadata.injectedSourceIds.length === 0) {
    throw new Error('content-enhanced round did not inject overlay sources');
  }
  return { baseline: baselineMetadata, enhanced: enhancedMetadata };
}

function renderContentMarkdown(output: ContentComparisonOutput): string {
  const headers = [
    'skill_id',
    'baseline_score',
    'content_enhanced_score',
    'score_delta',
    'baseline_kb_grounding_verdict',
    'content_enhanced_kb_grounding_verdict',
    'baseline_content_grounding_verdict',
    'content_enhanced_grounding_verdict',
    'baseline_strategy_chain_verdict',
    'content_enhanced_strategy_chain_verdict',
    'baseline_failed_criteria',
    'content_enhanced_failed_criteria',
    'cited_candidate_source_ids',
  ];
  return [
    '# User Research Hub C1 content evaluation comparison',
    '',
    `Generated at: ${output.metadata.generatedAt}`,
    `Baseline: ${output.metadata.baseline.runId}`,
    `Content enhanced: ${output.metadata.contentEnhanced.runId}`,
    `Overlay: ${output.metadata.overlayId} (${output.metadata.manifestHash})`,
    `Content set: ${output.metadata.contentSetHash}`,
    `Evaluation prompt: ${output.metadata.promptHash}`,
    `Evaluation rubric: ${output.metadata.rubricHash}`,
    `Production search used: ${String(output.metadata.productionSearchUsed)}`,
    `Candidate generation mode: ${output.metadata.candidateGenerationMode}`,
    `Promotion set: ${output.metadata.promotionSet.knowledgeCandidateIds.length} methods; ${output.metadata.promotionSet.assetCandidateIds.length} asset; ${output.metadata.promotionSet.draftSkillIds.length} draft Skill; ${output.metadata.promotionSet.skillDeltaIds.length} Skill deltas`,
    `Injected sources: ${output.metadata.injectedSourceIds.join(', ')}`,
    `Applied Skill deltas: ${output.metadata.appliedSkillDeltaIds.join(', ') || 'none for selected Skill set'}`,
    '',
    '## Grounding and strategy-chain criteria',
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...output.rows.map((row) => `| ${headers.map((header) => markdownCell(row[header as keyof ContentComparisonRow])).join(' | ')} |`),
    '',
    '### Grounding criteria',
    ...output.metadata.criteria.grounding.map(({ id, criterion }) => `- ${id}: ${criterion}`),
    '',
    '### Strategy-chain criteria',
    ...output.metadata.criteria.strategyChain.map(({ id, criterion: description, field }) => `- ${id}: ${description ?? `non-empty ${field}`}`),
    '',
    '## Frozen source and content hashes',
    '',
    '| id | kind | candidate_status | registry_status | runtime_consumed | source_hash | content_hash | artifact_hash | path |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...output.metadata.sourceContentHashes.map((entry) => (
      `| ${entry.id} | ${entry.kind} | ${entry.status} | ${entry.registryStatus ?? ''} | ${String(entry.runtimeConsumed ?? '')} | ${entry.sourceHash} | ${entry.contentHash} | ${entry.artifactHash} | ${entry.path} |`
    )),
    '',
  ].join('\n');
}

function renderContentCsv(rows: ContentComparisonRow[]): string {
  const headers = [
    'skill_id', 'baseline_score', 'content_enhanced_score', 'score_delta',
    'baseline_kb_grounding_verdict', 'content_enhanced_kb_grounding_verdict',
    'baseline_content_grounding_verdict', 'content_enhanced_grounding_verdict',
    'baseline_strategy_chain_verdict', 'content_enhanced_strategy_chain_verdict',
    'baseline_failed_criteria', 'content_enhanced_failed_criteria', 'cited_candidate_source_ids',
  ];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof ContentComparisonRow])).join(',')),
    '',
  ].join('\n');
}

export function compareContentEvaluationRounds(options: ContentCompareOptions): ContentComparisonOutput {
  const baselineDirectory = resolve(options.baseline);
  const enhancedDirectory = resolve(options.contentEnhanced);
  const outputDirectory = resolve(options.output);
  const baseline = loadManifest(baselineDirectory);
  const enhanced = loadManifest(enhancedDirectory);
  const metadata = assertContentComparisonIdentity(baseline, enhanced);
  assertCompleteRound('round0', baselineDirectory, baseline);
  assertCompleteRound('roundA', enhancedDirectory, enhanced);

  const order = activeCatalogOrder(baseline.activeSkillIds);
  const baselineRecords = bySkill(baseline.records);
  const enhancedRecords = bySkill(enhanced.records);
  const rows = order.map((skillId): ContentComparisonRow => {
    const baselineRecord = baselineRecords.get(skillId);
    const enhancedRecord = enhancedRecords.get(skillId);
    const baselineAssessment = contentAssessmentFrom(baselineDirectory, baselineRecord);
    const enhancedAssessment = contentAssessmentFrom(enhancedDirectory, enhancedRecord);
    const baselineScore = score(baselineRecord);
    const enhancedScore = score(enhancedRecord);
    return {
      skill_id: skillId,
      baseline_score: baselineScore,
      content_enhanced_score: enhancedScore,
      score_delta: baselineScore === null || enhancedScore === null ? null : enhancedScore - baselineScore,
      baseline_kb_grounding_verdict: assessmentFrom(baselineDirectory, baselineRecord)?.kb_grounding_verdict ?? null,
      content_enhanced_kb_grounding_verdict: assessmentFrom(enhancedDirectory, enhancedRecord)?.kb_grounding_verdict ?? null,
      baseline_content_grounding_verdict: baselineAssessment?.grounding_verdict ?? null,
      content_enhanced_grounding_verdict: enhancedAssessment?.grounding_verdict ?? null,
      baseline_strategy_chain_verdict: baselineAssessment?.strategy_chain_verdict ?? null,
      content_enhanced_strategy_chain_verdict: enhancedAssessment?.strategy_chain_verdict ?? null,
      baseline_failed_criteria: failedCriteria(baselineAssessment),
      content_enhanced_failed_criteria: failedCriteria(enhancedAssessment),
      cited_candidate_source_ids: enhancedAssessment?.cited_candidate_source_ids ?? [],
    };
  });
  const output: ContentComparisonOutput = {
    metadata: {
      generatedAt: new Date().toISOString(),
      baseline: roundMetadata(baselineDirectory, baseline),
      contentEnhanced: roundMetadata(enhancedDirectory, enhanced),
      overlayId: metadata.enhanced.overlayId,
      manifestHash: metadata.enhanced.manifestHash,
      contentSetHash: metadata.enhanced.contentSetHash,
      promptHash: metadata.enhanced.promptHash,
      rubricHash: metadata.enhanced.rubricHash,
      criteria: metadata.enhanced.criteria,
      productionSearchUsed: false,
      candidateGenerationMode: 'fixed',
      sourceContentHashes: metadata.enhanced.entries,
      promotionSet: metadata.enhanced.promotionSet,
      injectedSourceIds: metadata.enhanced.injectedSourceIds,
      appliedSkillDeltaIds: metadata.enhanced.appliedSkillDeltaIds,
      activeSkillCount: order.length,
      activeSkillIds: order,
    },
    rows,
  };
  mkdirSync(outputDirectory, { recursive: true });
  writeJsonAtomic(join(outputDirectory, 'content-comparison.json'), output);
  writeAtomic(join(outputDirectory, 'content-comparison.csv'), renderContentCsv(rows));
  writeAtomic(join(outputDirectory, 'content-comparison.md'), renderContentMarkdown(output));
  return output;
}

export function loadComparisonJson(path: string): unknown {
  return readJson<unknown>(path);
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseCli(args: string[]): CompareOptions | ContentCompareOptions {
  let round0: string | undefined;
  let roundA: string | undefined;
  let roundB: string | undefined;
  let baseline: string | undefined;
  let contentEnhanced: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--round0') {
      round0 = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--roundA') {
      roundA = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--roundB') {
      roundB = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--baseline') {
      baseline = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--content-enhanced') {
      contentEnhanced = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--output') {
      output = optionValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  const contentMode = baseline !== undefined || contentEnhanced !== undefined;
  const legacyMode = round0 !== undefined || roundA !== undefined || roundB !== undefined;
  if (contentMode && legacyMode) throw new Error('content comparison and three-round KB comparison options cannot be mixed');
  if (contentMode) {
    if (!baseline || !contentEnhanced || !output) {
      throw new Error('usage: tsx evaluations/skills/kb/compare.ts --baseline <dir> --content-enhanced <dir> --output <dir>');
    }
    return { baseline, contentEnhanced, output };
  }
  if (!round0 || !roundA || !roundB || !output) {
    throw new Error('usage: tsx evaluations/skills/kb/compare.ts --round0 <dir> --roundA <dir> --roundB <dir> --output <dir>');
  }
  return { round0, roundA, roundB, output };
}

export function runCompareCli(args = process.argv.slice(2)): void {
  const options = parseCli(args);
  if ('baseline' in options) {
    const result = compareContentEvaluationRounds(options);
    console.log(`Wrote C1 content comparison for ${result.rows.length} Skills to ${resolve(options.output)}`);
    return;
  }
  const result = compareEvaluationRounds(options);
  console.log(`Wrote KB comparison for ${result.rows.length} Skills to ${resolve(options.output)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCompareCli();
}
