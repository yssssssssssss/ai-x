import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configureFsSafeNative,
  root as openFsSafeRoot,
} from '@openclaw/fs-safe';
import type { SkillRegistryEntry } from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  buildRuntime,
  type AgentRuntime,
} from '../../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import type { SkillLoader } from '../../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { loadEvaluationCases } from './case-loader.ts';
import { SkillEvaluator, validateScorecardEvidence } from './evaluator.ts';
import { assessKnowledgeUsage, type KBAssessment } from './kb/assessment.ts';
import {
  loadGoldKnowledgeContext,
  loadLiveKnowledgeContext,
} from './kb/retriever.ts';
import {
  loadGoldSourceSelections,
  loadKnowledgeSnapshot,
  loadSkillKnowledgeMappings,
} from './kb/snapshot.ts';
import type {
  GoldSourceSelection,
  KBMode,
  KnowledgeContext,
  KnowledgeIndexItem,
  KnowledgeRetrievalResult,
  KnowledgeSnapshot,
  KnowledgeSnapshotResult,
  RetrievalRecord,
  SkillKnowledgeMapping,
} from './kb/types.ts';
import {
  writeEvaluationArtifacts,
  writeInputArtifact,
  writeKbArtifacts,
  writeManifest,
  writeSummaries,
} from './report-writer.ts';
import type {
  EvaluationManifest,
  EvaluationManifestCounts,
  LoadedEvaluationCase,
  SkillEvaluationRecord,
  SkillScorecard,
} from './types.ts';

configureFsSafeNative({ mode: 'require' });

export interface EvaluationRunOptions {
  runId: string;
  outputRoot: string;
  casesDir?: string;
  skillId?: string;
  concurrency: 1 | 2 | 3;
  resume: boolean;
  kbMode?: KBMode;
  kbSnapshotId?: string;
}

interface EvaluationSkillLoader {
  listActiveSkills(): SkillRegistryEntry[];
  loadSkillBody?(skillId: string): { body: string; hash: string; path: string };
}

interface EvaluationCaseEvaluator {
  evaluate(
    loadedCase: LoadedEvaluationCase,
    kb?: { knowledgeContext: KnowledgeContext; retrieval: RetrievalRecord },
  ): Promise<SkillEvaluationRecord>;
}

type MakeDirectory = (
  path: string,
  options?: { recursive?: boolean },
) => unknown;

interface EvaluationKbDependencies {
  loadKnowledgeSnapshot?: () => KnowledgeSnapshotResult;
  loadSkillKnowledgeMappings?: (
    activeSkills: SkillRegistryEntry[],
  ) => Map<string, SkillKnowledgeMapping>;
  loadGoldSourceSelections?: (
    activeSkills: SkillRegistryEntry[],
  ) => Map<string, GoldSourceSelection>;
  loadGoldKnowledgeContext?: (
    skillId: string,
    snapshot: KnowledgeSnapshot,
    index: Map<string, KnowledgeIndexItem>,
    mapping: SkillKnowledgeMapping,
    goldSelection: GoldSourceSelection,
  ) => KnowledgeRetrievalResult;
  loadLiveKnowledgeContext?: (
    skillId: string,
    snapshot: KnowledgeSnapshot,
    index: Map<string, KnowledgeIndexItem>,
    mapping: SkillKnowledgeMapping,
  ) => KnowledgeRetrievalResult;
}

export interface EvaluationRunDependencies {
  skillLoader?: EvaluationSkillLoader;
  evaluator?: EvaluationCaseEvaluator;
  clock?: () => Date;
  provider?: string;
  expectedActualModel?: string;
  mkdirSync?: MakeDirectory;
  kb?: EvaluationKbDependencies;
}

export interface EvaluationCliDependencies {
  env?: Record<string, string | undefined>;
  loadEnvFile?: (path: string) => void;
  buildRuntime?: () => AgentRuntime;
  clock?: () => Date;
}
export type RunEvaluationBatch = (
  options: EvaluationRunOptions,
  dependencies: EvaluationRunDependencies,
) => Promise<EvaluationManifest>;


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertConcurrency(value: number): asserts value is 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error('concurrency must be an integer from 1 to 3');
  }
}

function assertRunId(value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\u0000')
  ) {
    throw new Error('runId must be a single safe path segment');
  }
}

interface RunLockOwner {
  version: 1;
  pid: number;
  token: string;
}

type LockState =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'known'; alive: boolean; owner: RunLockOwner };

const LOCK_FILENAME = '.active.lock';
const LOCK_QUARANTINE_PREFIX = `${LOCK_FILENAME}.quarantine-`;

function parsedLockOwner(raw: string): RunLockOwner | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 0
      ? { version: 1, pid, token: `legacy-pid:${pid}` }
      : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
      ? { version: 1, pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function inspectLock(path: string): LockState {
  try {
    if (lstatSync(path).isSymbolicLink()) return { kind: 'unknown' };
    const owner = parsedLockOwner(readFileSync(path, 'utf8'));
    return owner
      ? { kind: 'known', alive: pidIsAlive(owner.pid), owner }
      : { kind: 'unknown' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unknown' };
  }
}

function assertRealProvider(provider: string | undefined): asserts provider is string {
  if (!provider?.trim()) {
    throw new Error('LLM_PROVIDER is required and must not be mock');
  }
  if (provider === 'mock') {
    throw new Error('LLM_PROVIDER=mock is not allowed for Skill evaluation');
  }
}

function assertExpectedActualModel(value: string | undefined): asserts value is string {
  if (!value?.trim()) {
    throw new Error('LLM_EXPECTED_ACTUAL_MODEL is required for Skill evaluation');
  }
}

function runtimeDependencies(): Required<
  Pick<EvaluationRunDependencies, 'skillLoader' | 'evaluator'>
> {
  assertRealProvider(process.env.LLM_PROVIDER);
  assertExpectedActualModel(process.env.LLM_EXPECTED_ACTUAL_MODEL);
  const runtime = buildRuntime();
  return {
    skillLoader: runtime.deps.skillLoader,
    evaluator: new SkillEvaluator({
      llm: runtime.deps.llm,
      skillLoader: runtime.deps.skillLoader,
      validator: runtime.deps.validator,
      expectedActualModel: process.env.LLM_EXPECTED_ACTUAL_MODEL,
    }),
  };
}

function resolveDependencies(
  dependencies: EvaluationRunDependencies,
): Required<Pick<EvaluationRunDependencies, 'skillLoader' | 'evaluator'>> {
  if (dependencies.skillLoader && dependencies.evaluator) {
    return {
      skillLoader: dependencies.skillLoader,
      evaluator: dependencies.evaluator,
    };
  }
  const production = runtimeDependencies();
  return {
    skillLoader: dependencies.skillLoader ?? production.skillLoader,
    evaluator: dependencies.evaluator ?? production.evaluator,
  };
}

function counts(records: SkillEvaluationRecord[]): EvaluationManifestCounts {
  const result: EvaluationManifestCounts = {
    succeeded: 0,
    needs_review: 0,
    failed: 0,
    skipped: 0,
  };
  for (const record of records) result[record.status] += 1;
  return result;
}

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function snapshotContentHash(snapshot: KnowledgeSnapshot): string {
  return sha256({
    index_hash: snapshot.index_hash,
    source_files: snapshot.source_files,
  });
}

function assertKbMode(value: KBMode | undefined): KBMode {
  const mode = value ?? 'none';
  if (mode !== 'none' && mode !== 'gold' && mode !== 'live') {
    throw new Error(`kb-mode must be one of none, gold, live: ${String(value)}`);
  }
  return mode;
}

interface PreparedKbRun {
  mode: 'gold' | 'live';
  snapshot: KnowledgeSnapshot;
  index: Map<string, KnowledgeIndexItem>;
  mappings: Map<string, SkillKnowledgeMapping>;
  goldSelections?: Map<string, GoldSourceSelection>;
  metadata: NonNullable<EvaluationManifest['kb']>;
}

function prepareKbRun(
  mode: KBMode,
  snapshotId: string | undefined,
  activeSkills: SkillRegistryEntry[],
  dependencies: EvaluationKbDependencies | undefined,
): PreparedKbRun | undefined {
  if (mode === 'none') return undefined;
  if (!snapshotId) throw new Error('--kb-snapshot is required when kb-mode is gold or live');
  const snapshotResult = (dependencies?.loadKnowledgeSnapshot ?? loadKnowledgeSnapshot)();
  if (snapshotResult.snapshot.snapshot_id !== snapshotId) {
    throw new Error(
      `kb snapshot mismatch: requested ${snapshotId}, loaded ${snapshotResult.snapshot.snapshot_id}`,
    );
  }
  const mappings = (dependencies?.loadSkillKnowledgeMappings ?? loadSkillKnowledgeMappings)(
    activeSkills,
  );
  const goldSelections =
    mode === 'gold'
      ? (dependencies?.loadGoldSourceSelections ?? loadGoldSourceSelections)(activeSkills)
      : undefined;
  return {
    mode,
    snapshot: snapshotResult.snapshot,
    index: snapshotResult.index,
    mappings,
    ...(goldSelections ? { goldSelections } : {}),
    metadata: {
      mode,
      snapshotId: snapshotResult.snapshot.snapshot_id,
      snapshotHash: snapshotContentHash(snapshotResult.snapshot),
      indexHash: snapshotResult.snapshot.index_hash,
      sourceMappingHash: sha256([...mappings.values()]),
    },
  };
}

function loadKbForSkill(
  prepared: PreparedKbRun,
  skillId: string,
  loadedCase: LoadedEvaluationCase,
  dependencies: EvaluationKbDependencies | undefined,
): KnowledgeRetrievalResult {
  const mapping = prepared.mappings.get(skillId);
  if (!mapping) throw new Error(`missing mapping: ${skillId}`);
  if (prepared.mode === 'gold') {
    const selection = prepared.goldSelections?.get(skillId);
    if (!selection) throw new Error(`missing gold selection: ${skillId}`);
    return (dependencies?.loadGoldKnowledgeContext ?? loadGoldKnowledgeContext)(
      skillId,
      prepared.snapshot,
      prepared.index,
      mapping,
      selection,
    );
  }
  return (dependencies?.loadLiveKnowledgeContext ?? loadLiveKnowledgeContext)(
    skillId,
    prepared.snapshot,
    prepared.index,
    mapping,
    { query: loadedCase.data.research_goal },
  );
}

function isKbContext(value: unknown, mode: 'gold' | 'live', snapshotId: string): value is KnowledgeContext {
  return (
    isRecord(value) &&
    value.mode === mode &&
    value.snapshot_id === snapshotId &&
    Array.isArray(value.required_source_ids) &&
    Array.isArray(value.selected_source_ids) &&
    Array.isArray(value.items)
  );
}

function isRetrievalRecord(value: unknown, mode: 'gold' | 'live', snapshotId: string): value is RetrievalRecord {
  return (
    isRecord(value) &&
    value.mode === mode &&
    value.snapshot_id === snapshotId &&
    Array.isArray(value.candidate_source_ids) &&
    Array.isArray(value.selected_source_ids) &&
    Array.isArray(value.missing_required_source_ids) &&
    Array.isArray(value.unresolved_items)
  );
}

function kbAssessmentForRecord(
  skillId: string,
  retrieval: KnowledgeRetrievalResult,
  record: SkillEvaluationRecord,
): KBAssessment {
  if (record.kbAssessment) return record.kbAssessment;
  const assessment = assessKnowledgeUsage(
    skillId,
    retrieval.context,
    retrieval.record,
    record.output,
  );
  if (record.status !== 'failed') return assessment;
  return {
    ...assessment,
    kb_grounding_verdict:
      assessment.kb_grounding_verdict === 'not_applicable'
        ? 'not_applicable'
        : 'needs_review',
    review_notes: [
      ...assessment.review_notes,
      `evaluation failed after KB retrieval: ${record.errorMessage ?? 'unknown error'}`,
    ],
  };
}

const RESUME_DIMENSION_MAX_SCORES = {
  workflow_adherence: 20,
  method_correctness: 20,
  completeness_structure: 20,
  evidence_boundaries: 15,
  actionability: 15,
  risk_boundary_handling: 10,
} as const;

function isScoreDimension(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    typeof value.max_score === 'number' &&
    Number.isFinite(value.max_score) &&
    isStringArray(value.evidence) &&
    value.evidence.length > 0 &&
    isStringArray(value.defects)
  );
}

function isScorecard(value: unknown, skillId: string): value is SkillScorecard {
  if (
    !isRecord(value) ||
    value.skill_id !== skillId ||
    typeof value.total_score !== 'number' ||
    !Number.isFinite(value.total_score) ||
    (value.verdict !== 'pass' &&
      value.verdict !== 'needs_review' &&
      value.verdict !== 'fail') ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length !== Object.keys(RESUME_DIMENSION_MAX_SCORES).length ||
    !isStringArray(value.critical_defects) ||
    !isStringArray(value.review_notes)
  ) {
    return false;
  }

  const seen = new Set<string>();
  let dimensionTotal = 0;
  for (const dimension of value.dimensions) {
    if (!isScoreDimension(dimension) || seen.has(dimension.id)) return false;
    const expectedMax =
      RESUME_DIMENSION_MAX_SCORES[
        dimension.id as keyof typeof RESUME_DIMENSION_MAX_SCORES
      ];
    if (
      expectedMax === undefined ||
      dimension.max_score !== expectedMax ||
      dimension.score < 0 ||
      dimension.score > expectedMax
    ) {
      return false;
    }
    seen.add(dimension.id);
    dimensionTotal += dimension.score;
  }
  if (dimensionTotal !== value.total_score) return false;
  const expectedVerdict =
    value.total_score < 60 || value.critical_defects.length > 0
      ? 'fail'
      : value.total_score < 80 || value.verdict === 'needs_review'
        ? 'needs_review'
        : 'pass';
  return value.verdict === expectedVerdict;
}

interface PriorManifest {
  value: Record<string, unknown>;
  records: Map<string, SkillEvaluationRecord>;
}

function priorManifest(runDirectory: string): PriorManifest | undefined {
  const value = readJson(join(runDirectory, 'manifest.json'));
  if (
    !isRecord(value) ||
    !Array.isArray(value.records) ||
    typeof value.provider !== 'string' ||
    !isStringArray(value.activeSkillIds)
  ) {
    return undefined;
  }
  const priorRecords = new Map<string, SkillEvaluationRecord>();
  for (const candidate of value.records) {
    if (isRecord(candidate) && typeof candidate.skillId === 'string') {
      priorRecords.set(candidate.skillId, candidate as unknown as SkillEvaluationRecord);
    }
  }
  return { value, records: priorRecords };
}

function assertResumeIdentity(
  prior: PriorManifest | undefined,
  provider: string,
  expectedActualModel: string | undefined,
  kbMode: KBMode,
  activeSkillIds: string[],
): void {
  if (!prior) return;
  if (typeof prior.value.provider === 'string' && prior.value.provider !== provider) {
    throw new Error(
      `resume provider mismatch: prior ${prior.value.provider}, current ${provider}`,
    );
  }
  const priorExpectedActualModel = prior.value.expectedActualModel;
  if (
    (typeof priorExpectedActualModel === 'string' || expectedActualModel !== undefined) &&
    priorExpectedActualModel !== expectedActualModel
  ) {
    throw new Error(
      `resume expected actual model mismatch: prior ${String(priorExpectedActualModel)}, current ${String(expectedActualModel)}`,
    );
  }
  if (isStringArray(prior.value.activeSkillIds)) {
    const priorIds = new Set(prior.value.activeSkillIds);
    const sameActiveSet =
      priorIds.size === activeSkillIds.length &&
      activeSkillIds.every((skillId) => priorIds.has(skillId));
    if (!sameActiveSet) {
      throw new Error(
        `resume active Skill set mismatch: prior [${prior.value.activeSkillIds.join(', ')}], current [${activeSkillIds.join(', ')}]`,
      );
    }
  }
  const priorKbMode =
    isRecord(prior.value.kb) &&
    (prior.value.kb.mode === 'gold' || prior.value.kb.mode === 'live')
      ? prior.value.kb.mode
      : 'none';
  if (priorKbMode !== kbMode) {
    throw new Error(`resume KB mode mismatch: prior ${priorKbMode}, current ${kbMode}`);
  }
}

function resumedRecord(
  runDirectory: string,
  loadedCase: LoadedEvaluationCase,
  previous: SkillEvaluationRecord | undefined,
  currentSkillHash: string | undefined,
  expectedActualModel: string | undefined,
  kb: PreparedKbRun | undefined,
): SkillEvaluationRecord | undefined {
  const skillId = loadedCase.data.skill_id;
  if (
    !previous ||
    (previous.status !== 'succeeded' && previous.status !== 'skipped') ||
    previous.caseHash !== loadedCase.caseHash ||
    !currentSkillHash ||
    previous.skillHash !== currentSkillHash ||
    (expectedActualModel !== undefined && previous.modelName !== expectedActualModel)
  ) {
    return undefined;
  }
  const skillDirectory = join(runDirectory, skillId);
  const output = readJson(join(skillDirectory, 'output.json'));
  const scorecard = readJson(join(skillDirectory, 'scorecard.json'));
  try {
    if (readFileSync(join(skillDirectory, 'output.md'), 'utf8').length === 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (
    !isRecord(output) ||
    !isScorecard(scorecard, skillId) ||
    !isRecord(previous.output) ||
    !isScorecard(previous.scorecard, skillId) ||
    stableJson(previous.output) !== stableJson(output) ||
    stableJson(previous.scorecard) !== stableJson(scorecard)
  ) {
    return undefined;
  }
  try {
    validateScorecardEvidence(scorecard, output);
  } catch {
    return undefined;
  }
  if (kb) {
    const knowledgeContext = readJson(join(skillDirectory, 'knowledge-context.json'));
    const retrieval = readJson(join(skillDirectory, 'retrieval.json'));
    const kbAssessment = readJson(join(skillDirectory, 'kb-assessment.json'));
    if (
      !isKbContext(knowledgeContext, kb.mode, kb.snapshot.snapshot_id) ||
      !isRetrievalRecord(retrieval, kb.mode, kb.snapshot.snapshot_id) ||
      !isRecord(kbAssessment)
    ) {
      return undefined;
    }
  }
  return {
    ...previous,
    status: 'skipped',
    output,
    scorecard,
  };
}

function failedRecord(
  loadedCase: LoadedEvaluationCase,
  error: unknown,
  elapsedMs: number,
): SkillEvaluationRecord {
  return {
    skillId: loadedCase.data.skill_id,
    skillHash: '',
    caseHash: loadedCase.caseHash,
    elapsedMs,
    status: 'failed',
    errorStage: 'generation',
    errorMessage: errorMessage(error),
  };
}

function selectedSkills(
  activeSkills: SkillRegistryEntry[],
  skillId: string | undefined,
): SkillRegistryEntry[] {
  if (!skillId) return activeSkills;
  const selected = activeSkills.find((skill) => skill.id === skillId);
  if (selected) return [selected];
  throw new Error(
    `unknown Skill ${skillId}; active Skill IDs: ${activeSkills.map(({ id }) => id).join(', ')}`,
  );
}

interface RunDirectoryClaim {
  canonicalRunDirectory: string;
  release(): void;
}

function assertContainedDirectory(path: string, canonicalParent: string, label: string): string {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} directory is missing: ${path}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} directory must not be a symbolic link (symlink): ${path}`);
  }
  const canonicalPath = realpathSync(path);
  if (canonicalPath !== canonicalParent && !canonicalPath.startsWith(`${canonicalParent}${sep}`)) {
    throw new Error(`${label} directory escapes its canonical root: ${path}`);
  }
  return canonicalPath;
}

function quarantinePath(runDirectory: string): string {
  return join(runDirectory, `${LOCK_QUARANTINE_PREFIX}${randomUUID()}`);
}

function quarantineLockNames(runDirectory: string): string[] {
  return readdirSync(runDirectory).filter((name) => name.startsWith(LOCK_QUARANTINE_PREFIX));
}

function unlinkUniqueLockPath(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function scanQuarantinesForAcquire(
  runDirectory: string,
  owner: RunLockOwner,
): boolean {
  let ownsQuarantine = false;
  for (const name of quarantineLockNames(runDirectory)) {
    const path = join(runDirectory, name);
    const state = inspectLock(path);
    if (state.kind === 'missing') continue;
    if (state.kind === 'unknown') {
      throw new Error(`run is already active or lock owner is unknown: ${runDirectory}; use --resume later`);
    }
    if (!state.alive) {
      unlinkUniqueLockPath(path);
      continue;
    }
    if (state.owner.token === owner.token) {
      ownsQuarantine = true;
      continue;
    }
    throw new Error(`run is already active with a foreign lock owner: ${runDirectory}; use --resume later`);
  }
  return ownsQuarantine;
}

function reclaimCanonicalLock(runDirectory: string, lockPath: string): void {
  const observed = inspectLock(lockPath);
  if (observed.kind === 'missing') return;
  if (observed.kind === 'unknown') {
    throw new Error(`run is already active or canonical lock owner is unknown: ${runDirectory}; use --resume later`);
  }
  if (observed.alive) {
    throw new Error(`run is already active: ${runDirectory}; use --resume later`);
  }

  const movedPath = quarantinePath(runDirectory);
  try {
    renameSync(lockPath, movedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = inspectLock(movedPath);
  if (moved.kind === 'known' && !moved.alive) {
    unlinkUniqueLockPath(movedPath);
    return;
  }
  throw new Error(`run is already active after stale lock recovery: ${runDirectory}; use --resume later`);
}

function publishLockOwner(runDirectory: string, lockPath: string, owner: RunLockOwner): void {
  const tempPath = join(runDirectory, `${LOCK_FILENAME}.owner-${owner.token}`);
  const bytes = Buffer.from(stableJson(owner), 'utf8');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error(`failed to publish complete run lock owner: ${runDirectory}`);
      offset += written;
    }
    closeSync(descriptor);
    descriptor = undefined;

    while (true) {
      scanQuarantinesForAcquire(runDirectory, owner);
      const canonical = inspectLock(lockPath);
      if (canonical.kind !== 'missing') {
        reclaimCanonicalLock(runDirectory, lockPath);
        continue;
      }
      try {
        linkSync(tempPath, lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    unlinkUniqueLockPath(tempPath);
  }
}

function releaseLockOwner(runDirectory: string, lockPath: string, owner: RunLockOwner): void {
  const canonical = inspectLock(lockPath);
  if (canonical.kind === 'known' && canonical.owner.token === owner.token) {
    const movedPath = quarantinePath(runDirectory);
    try {
      renameSync(lockPath, movedPath);
      const moved = inspectLock(movedPath);
      if (moved.kind === 'known' && moved.owner.token === owner.token) {
        unlinkUniqueLockPath(movedPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const name of quarantineLockNames(runDirectory)) {
    const path = join(runDirectory, name);
    const state = inspectLock(path);
    if (state.kind === 'known' && state.owner.token === owner.token) {
      unlinkUniqueLockPath(path);
    }
  }
}

function claimRunDirectory(
  outputRoot: string,
  runDirectory: string,
  resume: boolean,
  makeDirectory: MakeDirectory,
): RunDirectoryClaim {
  makeDirectory(outputRoot, { recursive: true });
  try {
    makeDirectory(runDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!resume) {
      throw new Error(
        `run directory already exists: ${runDirectory}; use --resume or choose a new run ID`,
      );
    }
  }
  const canonicalOutputRoot = realpathSync(outputRoot);
  const canonicalRunDirectory = assertContainedDirectory(
    runDirectory,
    canonicalOutputRoot,
    'run',
  );
  const lockPath = join(canonicalRunDirectory, LOCK_FILENAME);
  const owner: RunLockOwner = { version: 1, pid: process.pid, token: randomUUID() };
  publishLockOwner(canonicalRunDirectory, lockPath, owner);
  try {
    const ownsQuarantine = scanQuarantinesForAcquire(canonicalRunDirectory, owner);
    const canonical = inspectLock(lockPath);
    const ownsCanonical =
      canonical.kind === 'known' && canonical.alive && canonical.owner.token === owner.token;
    if (canonical.kind === 'unknown') {
      throw new Error(`run lock owner became unknown before evaluation: ${canonicalRunDirectory}`);
    }
    if (
      canonical.kind === 'known' &&
      canonical.alive &&
      canonical.owner.token !== owner.token
    ) {
      throw new Error(`run has a foreign active lock owner: ${canonicalRunDirectory}`);
    }
    if (!ownsCanonical && !ownsQuarantine) {
      throw new Error(`run lock ownership was lost before evaluation: ${canonicalRunDirectory}`);
    }
  } catch (error) {
    releaseLockOwner(canonicalRunDirectory, lockPath, owner);
    throw error;
  }
  return {
    canonicalRunDirectory,
    release: () => releaseLockOwner(canonicalRunDirectory, lockPath, owner),
  };
}


export async function runEvaluationBatch(
  options: EvaluationRunOptions,
  dependencies: EvaluationRunDependencies = {},
): Promise<EvaluationManifest> {
  assertRunId(options.runId);
  assertConcurrency(options.concurrency);
  const kbMode = assertKbMode(options.kbMode);
  const { skillLoader, evaluator } = resolveDependencies(dependencies);
  const clock = dependencies.clock ?? (() => new Date());
  const activeSkills = skillLoader.listActiveSkills();
  const activeSkillIds = activeSkills.map(({ id }) => id);
  const selected = selectedSkills(activeSkills, options.skillId);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const provider = dependencies.provider ?? process.env.LLM_PROVIDER ?? 'injected';
  const expectedActualModel =
    dependencies.expectedActualModel ??
    (dependencies.skillLoader && dependencies.evaluator
      ? undefined
      : process.env.LLM_EXPECTED_ACTUAL_MODEL);
  const preparedKb = prepareKbRun(
    kbMode,
    options.kbSnapshotId,
    activeSkills,
    dependencies.kb,
  );
  const cases = loadEvaluationCases(activeSkills, options.casesDir);
  const requestedRunDirectory = join(options.outputRoot, options.runId);
  const claim = claimRunDirectory(
    options.outputRoot,
    requestedRunDirectory,
    options.resume,
    dependencies.mkdirSync ?? mkdirSync,
  );
  const runDirectory = claim.canonicalRunDirectory;

  try {
    const artifactRoot = await openFsSafeRoot(runDirectory, {
      hardlinks: 'reject',
      mkdir: true,
      symlinks: 'reject',
    });
    for (const { id } of selected) await artifactRoot.mkdir(id);
    const prior = options.resume ? priorManifest(runDirectory) : undefined;
    const manifestSkillIds =
      options.resume && prior && isStringArray(prior.value.activeSkillIds)
        ? prior.value.activeSkillIds
        : selected.map(({ id }) => id);
    assertResumeIdentity(
      prior,
      provider,
      expectedActualModel,
      kbMode,
      activeSkillIds,
    );
    const currentSkillHashes = new Map<string, string | undefined>();
    const kbMetadataMatches =
      !preparedKb ||
      (prior !== undefined &&
        isRecord(prior.value.kb) &&
        stableJson(prior.value.kb) === stableJson(preparedKb.metadata));
    if (options.resume) {
      for (const skill of selected) {
        currentSkillHashes.set(skill.id, skillLoader.loadSkillBody?.(skill.id).hash);
      }
    }
    const recordSlots: Array<SkillEvaluationRecord | undefined> = manifestSkillIds.map(
      (id) => {
        const previous = prior?.records.get(id);
        if (!selectedIds.has(id)) return previous;
        if (!options.resume || !kbMetadataMatches) return undefined;
        return resumedRecord(
          runDirectory,
          cases.get(id)!,
          previous,
          currentSkillHashes.get(id),
          expectedActualModel,
          preparedKb,
        );
      },
    );
    const slotBySkillId = new Map(manifestSkillIds.map((id, index) => [id, index]));
    if (expectedActualModel) {
      for (const [index, skillId] of manifestSkillIds.entries()) {
        if (selectedIds.has(skillId)) continue;
        const preserved = recordSlots[index];
        if (preserved && preserved.modelName !== expectedActualModel) {
          throw new Error(
            `preserved Skill ${skillId} model mismatch: expected ${expectedActualModel}, received ${String(preserved.modelName)}`,
          );
        }
      }
    }
    const startedAt = clock().toISOString();

    const currentRecords = (): SkillEvaluationRecord[] =>
      recordSlots.filter(
        (record): record is SkillEvaluationRecord => record !== undefined,
      );
    const buildManifest = (
      status: EvaluationManifest['status'],
      completedAt?: string,
    ): EvaluationManifest => {
      const records = currentRecords();
      const modelRecord = records.find(({ modelName, modelVersion }) =>
        Boolean(modelName || modelVersion),
      );
      return {
        runId: options.runId,
        status,
        startedAt,
        ...(completedAt ? { completedAt } : {}),
        provider,
        ...(modelRecord?.modelName ? { modelName: modelRecord.modelName } : {}),
        ...(modelRecord?.modelVersion
          ? { modelVersion: modelRecord.modelVersion }
          : {}),
        ...(expectedActualModel ? { expectedActualModel } : {}),
        activeSkillCount: manifestSkillIds.length,
        activeSkillIds: manifestSkillIds,
        records,
        counts: counts(records),
        ...(preparedKb ? { kb: preparedKb.metadata } : {}),
      };
    };
    let manifestWriteQueue = Promise.resolve();
    const persistRunningManifest = (): Promise<void> => {
      const manifest = buildManifest('running');
      const write = manifestWriteQueue.then(() => writeManifest(artifactRoot, manifest));
      manifestWriteQueue = write.catch(() => undefined);
      return write;
    };

    await persistRunningManifest();
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selected.length) return;

        const skill = selected[index];
        const slotIndex = slotBySkillId.get(skill.id)!;
        const loadedCase = cases.get(skill.id)!;
        await writeInputArtifact(artifactRoot, skill.id, loadedCase);

        if (recordSlots[slotIndex]?.status === 'skipped') continue;

        const evaluationStartedAt = clock().getTime();
        let record: SkillEvaluationRecord;
        let retrieval: KnowledgeRetrievalResult | undefined;
        try {
          retrieval = preparedKb
            ? loadKbForSkill(preparedKb, skill.id, loadedCase, dependencies.kb)
            : undefined;
          record = await evaluator.evaluate(
            loadedCase,
            retrieval
              ? {
                  knowledgeContext: retrieval.context,
                  retrieval: retrieval.record,
                }
              : undefined,
          );
        } catch (error) {
          record = failedRecord(
            loadedCase,
            error,
            Math.max(0, clock().getTime() - evaluationStartedAt),
          );
        }
        if (retrieval) {
          await writeKbArtifacts(artifactRoot, skill.id, {
            knowledgeContext: retrieval.context,
            retrieval: retrieval.record,
            kbAssessment: kbAssessmentForRecord(skill.id, retrieval, record),
          });
        }
        await writeEvaluationArtifacts(artifactRoot, skill.id, record);
        recordSlots[slotIndex] = record;
        await persistRunningManifest();
      }
    };

    const workerCount = Math.min(options.concurrency, selected.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const missingRecordIds = manifestSkillIds.filter(
      (_skillId, index) => recordSlots[index] === undefined,
    );
    if (missingRecordIds.length > 0) {
      await persistRunningManifest();
      throw new Error(
        `incomplete evaluation manifest: missing Skill records for ${missingRecordIds.join(', ')}`,
      );
    }

    const records = currentRecords();
    const finalStatus: EvaluationManifest['status'] = records.some(
      ({ status }) => status === 'failed',
    )
      ? 'completed_with_failures'
      : 'completed';
    const manifest = buildManifest(finalStatus, clock().toISOString());
    await manifestWriteQueue;
    await writeSummaries(artifactRoot, records);
    await writeManifest(artifactRoot, manifest);
    return manifest;
  } finally {
    claim.release();
  }
}

function defaultRunId(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseOptions(args: string[], clock: () => Date): EvaluationRunOptions {
  let runId: string | undefined;
  let outputRoot = 'skill-evaluations';
  let skillId: string | undefined;
  let concurrency = 3;
  let resume = false;
  let kbMode: KBMode | undefined;
  let kbSnapshotId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--skill':
        skillId = optionValue(args, index, argument);
        index += 1;
        break;
      case '--run-id':
        runId = optionValue(args, index, argument);
        index += 1;
        break;
      case '--output-root':
        outputRoot = optionValue(args, index, argument);
        index += 1;
        break;
      case '--concurrency':
        concurrency = Number(optionValue(args, index, argument));
        index += 1;
        break;
      case '--resume':
        resume = true;
        break;
      case '--kb-mode':
        kbMode = assertKbMode(optionValue(args, index, argument) as KBMode);
        index += 1;
        break;
      case '--kb-snapshot':
        kbSnapshotId = optionValue(args, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  assertConcurrency(concurrency);
  return {
    runId: runId ?? defaultRunId(clock()),
    outputRoot,
    ...(skillId ? { skillId } : {}),
    concurrency,
    resume,
    ...(kbMode ? { kbMode } : {}),
    ...(kbSnapshotId ? { kbSnapshotId } : {}),
  };
}

export async function runEvaluationCli(
  args = process.argv.slice(2),
  dependencies: EvaluationCliDependencies = {},
  runBatch: RunEvaluationBatch = runEvaluationBatch,
): Promise<EvaluationManifest> {
  const env = dependencies.env ?? process.env;
  const loadEnvFile =
    dependencies.loadEnvFile ?? ((path: string) => process.loadEnvFile(path));
  try {
    loadEnvFile('.env');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  assertRealProvider(env.LLM_PROVIDER);
  assertExpectedActualModel(env.LLM_EXPECTED_ACTUAL_MODEL);
  const clock = dependencies.clock ?? (() => new Date());
  const options = parseOptions(args, clock);
  const runtime = (dependencies.buildRuntime ?? buildRuntime)();
  const evaluator = new SkillEvaluator({
    llm: runtime.deps.llm,
    skillLoader: runtime.deps.skillLoader,
    validator: runtime.deps.validator,
    expectedActualModel: env.LLM_EXPECTED_ACTUAL_MODEL,
  });
  return runBatch(options, {
    skillLoader: runtime.deps.skillLoader,
    expectedActualModel: env.LLM_EXPECTED_ACTUAL_MODEL,
    evaluator,
    clock,
    provider: env.LLM_PROVIDER,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runEvaluationCli()
    .then((manifest) => {
      if (manifest.status === 'completed_with_failures') process.exitCode = 1;
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
