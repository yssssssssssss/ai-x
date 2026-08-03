import { readFileSync } from 'node:fs';
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
  writeEvaluationArtifacts,
  writeInputArtifact,
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
}

interface EvaluationSkillLoader {
  listActiveSkills(): SkillRegistryEntry[];
}

interface EvaluationCaseEvaluator {
  evaluate(loadedCase: LoadedEvaluationCase): Promise<SkillEvaluationRecord>;
}

export interface EvaluationRunDependencies {
  skillLoader?: EvaluationSkillLoader;
  evaluator?: EvaluationCaseEvaluator;
  clock?: () => Date;
  provider?: string;
}

export interface EvaluationCliDependencies {
  env?: Record<string, string | undefined>;
  loadEnvFile?: (path: string) => void;
  buildRuntime?: () => AgentRuntime;
  clock?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertConcurrency(value: number): asserts value is 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error('concurrency must be an integer from 1 to 3');
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
): SkillEvaluationRecord | undefined {
  const skillId = loadedCase.data.skill_id;
  const skillDirectory = join(runDirectory, skillId);
  const output = readJson(join(skillDirectory, 'output.json'));
  const scorecard = readJson(join(skillDirectory, 'scorecard.json'));
  if (output === undefined || scorecard === undefined) return undefined;

  return {
    ...previous,
    skillId,
    skillHash: previous?.skillHash ?? '',
    caseHash: loadedCase.caseHash,
    elapsedMs: previous?.elapsedMs ?? 0,
    status: 'skipped',
    output: output as Record<string, unknown>,
    scorecard: scorecard as SkillScorecard,
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

export async function runEvaluationBatch(
  options: EvaluationRunOptions,
  dependencies: EvaluationRunDependencies = {},
): Promise<EvaluationManifest> {
  assertConcurrency(options.concurrency);
  const { skillLoader, evaluator } = resolveDependencies(dependencies);
  const clock = dependencies.clock ?? (() => new Date());
  const activeSkills = skillLoader.listActiveSkills();
  const selected = selectedSkills(activeSkills, options.skillId);
  const cases = loadEvaluationCases(activeSkills, options.casesDir);
  const runDirectory = join(options.outputRoot, options.runId);
  const priorRecords = options.resume
    ? previousRecords(runDirectory)
    : new Map<string, SkillEvaluationRecord>();
  const recordSlots: Array<SkillEvaluationRecord | undefined> = selected.map(
    () => undefined,
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

      if (options.resume) {
        const skipped = resumedRecord(
          runDirectory,
          loadedCase,
          priorRecords.get(skill.id),
        );
        if (skipped) {
          recordSlots[index] = skipped;
          persistRunningManifest();
          continue;
        }
      }

      const evaluationStartedAt = clock().getTime();
      let record: SkillEvaluationRecord;
      try {
        record = await evaluator.evaluate(loadedCase);
      } catch (error) {
        record = failedRecord(
          loadedCase,
          error,
          Math.max(0, clock().getTime() - evaluationStartedAt),
        );
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
  writeManifest(runDirectory, manifest);
  writeSummaries(runDirectory, records);
  return manifest;
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
  };
}

export async function runEvaluationCli(
  args = process.argv.slice(2),
  dependencies: EvaluationCliDependencies = {},
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
  return runEvaluationBatch(options, {
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
