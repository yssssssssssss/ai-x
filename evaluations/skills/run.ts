import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillRegistryEntry } from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  buildRuntime,
  type AgentRuntime,
} from '../../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import type { SkillLoader } from '../../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { loadEvaluationCases } from './case-loader.ts';
import { SkillEvaluator } from './evaluator.ts';
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

function lockOwnerIsAlive(lockPath: string): boolean {
  let rawPid: string;
  try {
    rawPid = readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
  if (!/^\d+$/.test(rawPid)) return false;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
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

function runtimeDependencies(): Required<
  Pick<EvaluationRunDependencies, 'skillLoader' | 'evaluator'>
> {
  assertRealProvider(process.env.LLM_PROVIDER);
  const runtime = buildRuntime();
  return {
    skillLoader: runtime.deps.skillLoader,
    evaluator: new SkillEvaluator({
      llm: runtime.deps.llm,
      skillLoader: runtime.deps.skillLoader,
      validator: runtime.deps.validator,
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
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
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
      snapshotHash: snapshotResult.snapshot.snapshot_id,
      indexHash: snapshotResult.snapshot.index_hash,
      sourceMappingHash: sha256([...mappings.values()]),
    },
  };
}

function loadKbForSkill(
  prepared: PreparedKbRun,
  skillId: string,
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

function previousRecords(runDirectory: string): Map<string, SkillEvaluationRecord> {
  const parsed = readJson(join(runDirectory, 'manifest.json'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { records?: unknown }).records)
  ) {
    return new Map();
  }
  const records = (parsed as { records: SkillEvaluationRecord[] }).records;
  return new Map(
    records
      .filter((record) => record && typeof record.skillId === 'string')
      .map((record) => [record.skillId, record]),
  );
}

function resumedRecord(
  runDirectory: string,
  loadedCase: LoadedEvaluationCase,
  previous: SkillEvaluationRecord | undefined,
  kb: PreparedKbRun | undefined,
): SkillEvaluationRecord | undefined {
  const skillId = loadedCase.data.skill_id;
  const skillDirectory = join(runDirectory, skillId);
  if (previous?.status === 'failed' || previous?.status === 'needs_review') {
    return undefined;
  }
  const output = readJson(join(skillDirectory, 'output.json'));
  const scorecard = readJson(join(skillDirectory, 'scorecard.json'));
  if (!isRecord(output) || !isScorecard(scorecard, skillId)) return undefined;
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
    skillId,
    skillHash: previous?.skillHash ?? '',
    caseHash: loadedCase.caseHash,
    elapsedMs: previous?.elapsedMs ?? 0,
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

function claimRunDirectory(
  outputRoot: string,
  runDirectory: string,
  resume: boolean,
  makeDirectory: MakeDirectory,
): () => void {
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

  const lockPath = join(runDirectory, '.active.lock');
  let descriptor: number;
  while (true) {
    try {
      descriptor = openSync(lockPath, 'wx');
      writeSync(descriptor, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockOwnerIsAlive(lockPath)) {
        throw new Error(`run is already active: ${runDirectory}; use --resume later`);
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw unlinkError;
        }
      }
    }
  }
  closeSync(descriptor);

  return () => {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
  const selected = selectedSkills(activeSkills, options.skillId);
  const preparedKb = prepareKbRun(
    kbMode,
    options.kbSnapshotId,
    activeSkills,
    dependencies.kb,
  );
  const cases = loadEvaluationCases(activeSkills, options.casesDir);
  const runDirectory = join(options.outputRoot, options.runId);
  const releaseRunLock = claimRunDirectory(
    options.outputRoot,
    runDirectory,
    options.resume,
    dependencies.mkdirSync ?? mkdirSync,
  );

  try {
    const priorRecords = options.resume
      ? previousRecords(runDirectory)
      : new Map<string, SkillEvaluationRecord>();
    const recordSlots: Array<SkillEvaluationRecord | undefined> = selected.map(
      ({ id }) =>
        options.resume
          ? resumedRecord(
              runDirectory,
              cases.get(id)!,
              priorRecords.get(id),
              preparedKb,
            )
          : undefined,
    );
    const startedAt = clock().toISOString();
    const provider = dependencies.provider ?? process.env.LLM_PROVIDER ?? 'injected';

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
        activeSkillCount: selected.length,
        activeSkillIds: selected.map(({ id }) => id),
        records,
        counts: counts(records),
        ...(preparedKb ? { kb: preparedKb.metadata } : {}),
      };
    };
    const persistRunningManifest = (): void => {
      writeManifest(runDirectory, buildManifest('running'));
    };

    persistRunningManifest();
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selected.length) return;

        const skill = selected[index];
        const loadedCase = cases.get(skill.id)!;
        const skillDirectory = join(runDirectory, skill.id);
        writeInputArtifact(skillDirectory, loadedCase);

        if (recordSlots[index]?.status === 'skipped') continue;

        const evaluationStartedAt = clock().getTime();
        let record: SkillEvaluationRecord;
        let retrieval: KnowledgeRetrievalResult | undefined;
        try {
          retrieval = preparedKb
            ? loadKbForSkill(preparedKb, skill.id, dependencies.kb)
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
        if (retrieval && record.status !== 'failed') {
          writeKbArtifacts(skillDirectory, {
            knowledgeContext: retrieval.context,
            retrieval: retrieval.record,
            ...(record.kbAssessment ? { kbAssessment: record.kbAssessment } : {}),
          });
        }
        writeEvaluationArtifacts(skillDirectory, record);
        recordSlots[index] = record;
        persistRunningManifest();
      }
    };

    const workerCount = Math.min(options.concurrency, selected.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const records = currentRecords();
    const finalStatus: EvaluationManifest['status'] = records.some(
      ({ status }) => status === 'failed',
    )
      ? 'completed_with_failures'
      : 'completed';
    const manifest = buildManifest(finalStatus, clock().toISOString());
    writeSummaries(runDirectory, records);
    writeManifest(runDirectory, manifest);
    return manifest;
  } finally {
    releaseRunLock();
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
  const clock = dependencies.clock ?? (() => new Date());
  const options = parseOptions(args, clock);
  const runtime = (dependencies.buildRuntime ?? buildRuntime)();
  const evaluator = new SkillEvaluator({
    llm: runtime.deps.llm,
    skillLoader: runtime.deps.skillLoader,
    validator: runtime.deps.validator,
  });
  return runBatch(options, {
    skillLoader: runtime.deps.skillLoader,
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
