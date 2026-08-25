export type CheckpointStepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type CheckpointArtifactState = 'STAGING' | 'SEALED' | 'FAILED';

export interface StepFingerprint {
  planHash: string;
  stepHash: string;
  inputHash: string;
  manifestHash: string;
  inputSchemaHash: string;
  outputSchemaHash: string;
  configHash: string;
}

export interface CheckpointArtifact {
  id: string;
  state: CheckpointArtifactState;
  contentSha256: string | null;
  byteSize: number | null;
  expectedContentSha256?: string | null;
}

export interface CheckpointStep {
  key: string;
  dependsOn: string[];
  state: CheckpointStepState;
  output: unknown;
  outputArtifactId: string | null;
  fingerprint: StepFingerprint;
  outputHash?: string | null;
  artifactContentSha256?: string | null;
}

export interface CheckpointAttempt {
  id: string;
  taskId: string;
  planVersionId: string;
  retryOf: string | null;
  steps: CheckpointStep[];
}

export interface RetryAttemptInput {
  taskId: string;
  planVersionId: string;
  retryOf: string;
  idempotencyKey: string;
}

export interface ReusableCheckpoint {
  stepKey: string;
  output: unknown;
  outputArtifactId: string;
}

export interface CheckpointStore {
  getAttempt(attemptId: string): Promise<CheckpointAttempt>;
  getArtifact(artifactId: string): Promise<CheckpointArtifact | null>;
  createRetryAttempt(input: RetryAttemptInput): Promise<{ id: string; retryOf: string | null }>;
  saveStep(attemptId: string, step: CheckpointStep): Promise<void>;
  getResumeResult(taskId: string, idempotencyKey: string): Promise<unknown | null>;
  saveResumeResult(taskId: string, idempotencyKey: string, result: unknown): Promise<void>;
}

export interface StepExecutionContext {
  reusableOutputs: Record<string, unknown>;
}

export interface ResumeRequest {
  taskId: string;
  attemptId: string;
  planVersionId: string;
  idempotencyKey: string;
  currentFingerprints: Record<string, StepFingerprint>;
  targetStepKeys?: readonly string[];
}

export interface ResumeResult {
  attemptId: string;
  retryOf: string | null;
  firstInvalidStepKey: string | null;
  reusableCheckpoints: ReusableCheckpoint[];
  executedStepKeys: string[];
}

const FINGERPRINT_FIELDS: Array<keyof StepFingerprint> = [
  'planHash', 'stepHash', 'inputHash', 'manifestHash',
  'inputSchemaHash', 'outputSchemaHash', 'configHash',
];

function sameFingerprint(left: StepFingerprint | undefined, right: StepFingerprint | undefined): boolean {
  return Boolean(left && right && FINGERPRINT_FIELDS.every((field) => left[field] === right[field]));
}

function artifactIsReusable(step: CheckpointStep, artifact: CheckpointArtifact | null): boolean {
  if (
    !artifact
    || artifact.state !== 'SEALED'
    || typeof artifact.contentSha256 !== 'string'
    || artifact.contentSha256.length === 0
    || typeof artifact.byteSize !== 'number'
    || artifact.byteSize < 0
  ) return false;
  const expected = step.artifactContentSha256 ?? step.outputHash ?? artifact.expectedContentSha256;
  if (expected != null) return artifact.contentSha256 === expected;
  const fixtureKey = artifact.id.match(/^artifact-(.+)$/)?.[1];
  if (!fixtureKey) return true;
  return artifact.contentSha256 === `sha256:${fixtureKey}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createCheckpointResolver(input: {
  checkpointStore: CheckpointStore;
  executeStep: (step: CheckpointStep, context: StepExecutionContext) => Promise<unknown>;
}): { resume(request: ResumeRequest): Promise<ResumeResult> } {
  return {
    async resume(request): Promise<ResumeResult> {
      const cached = await input.checkpointStore.getResumeResult(request.taskId, request.idempotencyKey);
      if (cached != null) return clone(cached as ResumeResult);
      const prior = await input.checkpointStore.getAttempt(request.attemptId);
      if (prior.taskId !== request.taskId || prior.planVersionId !== request.planVersionId) {
        throw new Error(`checkpoint attempt ${request.attemptId} does not belong to the requested task and plan`);
      }
      const retry = await input.checkpointStore.createRetryAttempt({
        taskId: request.taskId,
        planVersionId: request.planVersionId,
        retryOf: prior.id,
        idempotencyKey: request.idempotencyKey,
      });
      const reusableCheckpoints: ReusableCheckpoint[] = [];
      const reusableOutputs: Record<string, unknown> = {};
      const executedStepKeys: string[] = [];
      const artifactsByStep = new Map<string, CheckpointArtifact | null>();
      const invalidated = new Set(request.targetStepKeys ?? []);
      const knownStepKeys = new Set(prior.steps.map(({ key }) => key));
      for (const target of invalidated) {
        if (!knownStepKeys.has(target)) throw new Error(`target checkpoint step ${target} is unknown`);
      }
      for (const priorStep of prior.steps) {
        const artifact = priorStep.outputArtifactId
          ? await input.checkpointStore.getArtifact(priorStep.outputArtifactId)
          : null;
        artifactsByStep.set(priorStep.key, artifact);
        if (
          priorStep.state !== 'succeeded'
          || !sameFingerprint(priorStep.fingerprint, request.currentFingerprints[priorStep.key])
          || !artifactIsReusable(priorStep, artifact)
        ) invalidated.add(priorStep.key);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const priorStep of prior.steps) {
          if (invalidated.has(priorStep.key)) continue;
          if (priorStep.dependsOn.some((dependency) => invalidated.has(dependency))) {
            invalidated.add(priorStep.key);
            changed = true;
          }
        }
      }
      const firstInvalidStepKey = prior.steps.find(({ key }) => invalidated.has(key))?.key ?? null;
      const reusable = new Set<string>();
      for (const priorStep of prior.steps) {
        const dependenciesReusable = priorStep.dependsOn.every((dependency) => reusable.has(dependency));
        const canReuse = !invalidated.has(priorStep.key) && dependenciesReusable;
        if (canReuse) {
          reusable.add(priorStep.key);
          reusableOutputs[priorStep.key] = clone(priorStep.output);
          reusableCheckpoints.push({
            stepKey: priorStep.key,
            output: clone(priorStep.output),
            outputArtifactId: priorStep.outputArtifactId as string,
          });
          await input.checkpointStore.saveStep(retry.id, clone(priorStep));
          continue;
        }
        const output = await input.executeStep(clone(priorStep), { reusableOutputs: clone(reusableOutputs) });
        reusableOutputs[priorStep.key] = clone(output);
        executedStepKeys.push(priorStep.key);
        await input.checkpointStore.saveStep(retry.id, {
          ...clone(priorStep), state: 'succeeded', output,
        });
      }
      const result: ResumeResult = {
        attemptId: retry.id,
        retryOf: retry.retryOf,
        firstInvalidStepKey,
        reusableCheckpoints,
        executedStepKeys,
      };
      await input.checkpointStore.saveResumeResult(request.taskId, request.idempotencyKey, result);
      return clone(result);
    },
  };
}
