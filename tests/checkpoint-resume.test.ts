import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Task23 RED contract: checkpoint resume and retry lineage.
 *
 * The resolver is intentionally not present yet. This file defines the seam
 * needed by the workflow/engine integration: only a checkpoint whose plan,
 * step, input, manifest, schema, and config hashes all match and whose output
 * artifact is SEALED may be reused. Reusable outputs must be injected from the
 * first invalid node, while a retry attempt retains retry_of lineage.
 */

type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
type ArtifactState = 'STAGING' | 'SEALED' | 'FAILED';

type StepFingerprint = {
  planHash: string;
  stepHash: string;
  inputHash: string;
  manifestHash: string;
  inputSchemaHash: string;
  outputSchemaHash: string;
  configHash: string;
};

type CheckpointArtifact = {
  id: string;
  state: ArtifactState;
  contentSha256: string | null;
  byteSize: number | null;
};

type CheckpointStep = {
  key: string;
  dependsOn: string[];
  state: StepState;
  output: unknown;
  outputArtifactId: string | null;
  fingerprint: StepFingerprint;
};

type CheckpointAttempt = {
  id: string;
  taskId: string;
  planVersionId: string;
  retryOf: string | null;
  steps: CheckpointStep[];
};

type RetryAttemptInput = {
  taskId: string;
  planVersionId: string;
  retryOf: string;
  idempotencyKey: string;
};

type ReusableCheckpoint = {
  stepKey: string;
  output: unknown;
  outputArtifactId: string;
};

type CheckpointStore = {
  getAttempt(attemptId: string): Promise<CheckpointAttempt>;
  getArtifact(artifactId: string): Promise<CheckpointArtifact | null>;
  createRetryAttempt(input: RetryAttemptInput): Promise<{ id: string; retryOf: string | null }>;
  saveStep(attemptId: string, step: CheckpointStep): Promise<void>;
  getResumeResult(taskId: string, idempotencyKey: string): Promise<unknown | null>;
  saveResumeResult(taskId: string, idempotencyKey: string, result: unknown): Promise<void>;
};

type StepExecutionContext = {
  reusableOutputs: Record<string, unknown>;
};

type ResumeRequest = {
  taskId: string;
  attemptId: string;
  planVersionId: string;
  idempotencyKey: string;
  currentFingerprints: Record<string, StepFingerprint>;
};

type ResumeResult = {
  attemptId: string;
  retryOf: string | null;
  firstInvalidStepKey: string | null;
  reusableCheckpoints: ReusableCheckpoint[];
  executedStepKeys: string[];
};

type CheckpointResolverModule = {
  createCheckpointResolver(input: {
    checkpointStore: CheckpointStore;
    executeStep: (step: CheckpointStep, context: StepExecutionContext) => Promise<unknown>;
  }): {
    resume(input: ResumeRequest): Promise<ResumeResult>;
  };
};

class MemoryCheckpointStore implements CheckpointStore {
  readonly attempts = new Map<string, CheckpointAttempt>();
  readonly artifacts = new Map<string, CheckpointArtifact>();
  readonly createdRetries: RetryAttemptInput[] = [];
  readonly savedSteps: Array<{ attemptId: string; step: CheckpointStep }> = [];
  readonly resumeResults = new Map<string, unknown>();

  async getAttempt(attemptId: string): Promise<CheckpointAttempt> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`missing attempt ${attemptId}`);
    return structuredClone(attempt);
  }

  async getArtifact(artifactId: string): Promise<CheckpointArtifact | null> {
    return structuredClone(this.artifacts.get(artifactId) ?? null);
  }

  async createRetryAttempt(input: RetryAttemptInput): Promise<{ id: string; retryOf: string | null }> {
    this.createdRetries.push(input);
    return { id: `attempt-${this.createdRetries.length + 1}`, retryOf: input.retryOf };
  }

  async saveStep(attemptId: string, step: CheckpointStep): Promise<void> {
    this.savedSteps.push({ attemptId, step: structuredClone(step) });
  }

  async getResumeResult(taskId: string, idempotencyKey: string): Promise<unknown | null> {
    return this.resumeResults.get(`${taskId}:${idempotencyKey}`) ?? null;
  }

  async saveResumeResult(taskId: string, idempotencyKey: string, result: unknown): Promise<void> {
    this.resumeResults.set(`${taskId}:${idempotencyKey}`, structuredClone(result));
  }
}

const baseFingerprint = (key: string): StepFingerprint => ({
  planHash: 'plan:1',
  stepHash: `step:${key}:1`,
  inputHash: `input:${key}:1`,
  manifestHash: `manifest:${key}:1`,
  inputSchemaHash: `input-schema:${key}:1`,
  outputSchemaHash: `output-schema:${key}:1`,
  configHash: `config:${key}:1`,
});

function checkpointStep(
  key: string,
  state: StepState,
  overrides: Partial<CheckpointStep> = {},
): CheckpointStep {
  return {
    key,
    dependsOn: key === 'collect' ? [] : key === 'normalize' ? ['collect'] : ['normalize'],
    state,
    output: state === 'succeeded' ? { value: `${key}-output` } : null,
    outputArtifactId: state === 'succeeded' ? `artifact-${key}` : null,
    fingerprint: baseFingerprint(key),
    ...overrides,
  };
}

function fixture(): {
  store: MemoryCheckpointStore;
  priorAttempt: CheckpointAttempt;
  currentFingerprints: Record<string, StepFingerprint>;
} {
  const store = new MemoryCheckpointStore();
  const priorAttempt: CheckpointAttempt = {
    id: 'attempt-1',
    taskId: 'task-23',
    planVersionId: 'plan-1',
    retryOf: null,
    steps: [
      checkpointStep('collect', 'succeeded'),
      checkpointStep('normalize', 'failed'),
      checkpointStep('report', 'pending'),
    ],
  };
  store.attempts.set(priorAttempt.id, priorAttempt);
  store.artifacts.set('artifact-collect', {
    id: 'artifact-collect',
    state: 'SEALED',
    contentSha256: 'sha256:collect',
    byteSize: 128,
  });
  return {
    store,
    priorAttempt,
    currentFingerprints: Object.fromEntries(
      priorAttempt.steps.map((step) => [step.key, step.fingerprint]),
    ),
  };
}

async function loadResolver(
  store: MemoryCheckpointStore,
  calls: Array<{ key: string; context: StepExecutionContext }>,
) {
  // RED: this module/export is the production seam introduced by Task23.
  const module = await import('../apps/orchestrator-runtime/src/control/checkpoint-resolver.ts') as unknown as CheckpointResolverModule;
  return module.createCheckpointResolver({
    checkpointStore: store,
    executeStep: async (step, context) => {
      calls.push({ key: step.key, context: structuredClone(context) });
      return { value: `${step.key}-rerun-output` };
    },
  });
}

function request(
  currentFingerprints: Record<string, StepFingerprint>,
  idempotencyKey = 'resume-1',
): ResumeRequest {
  return {
    taskId: 'task-23',
    attemptId: 'attempt-1',
    planVersionId: 'plan-1',
    idempotencyKey,
    currentFingerprints,
  };
}

test('reuses successful sealed prior steps and injects reusable outputs at the first invalid node', async () => {
  const { store, currentFingerprints } = fixture();
  const calls: Array<{ key: string; context: StepExecutionContext }> = [];
  const resolver = await loadResolver(store, calls);

  const result = await resolver.resume(request(currentFingerprints));

  assert.deepEqual(result.reusableCheckpoints, [{
    stepKey: 'collect',
    output: { value: 'collect-output' },
    outputArtifactId: 'artifact-collect',
  }]);
  assert.equal(result.firstInvalidStepKey, 'normalize');
  assert.deepEqual(calls.map((call) => call.key), ['normalize', 'report']);
  assert.deepEqual(calls[0]?.context.reusableOutputs, {
    collect: { value: 'collect-output' },
  });
  assert.deepEqual(calls[1]?.context.reusableOutputs, {
    collect: { value: 'collect-output' },
    normalize: { value: 'normalize-rerun-output' },
  });
  assert.equal(calls.filter((call) => call.key === 'collect').length, 0);
});

test('reruns a successful step when its input hash changes', async () => {
  const { store, currentFingerprints } = fixture();
  currentFingerprints.collect = { ...currentFingerprints.collect, inputHash: 'input:collect:changed' };
  const calls: Array<{ key: string; context: StepExecutionContext }> = [];
  const resolver = await loadResolver(store, calls);

  await resolver.resume(request(currentFingerprints));

  assert.equal(calls[0]?.key, 'collect');
});

for (const [label, field] of [
  ['manifest', 'manifestHash'],
  ['input schema', 'inputSchemaHash'],
  ['output schema', 'outputSchemaHash'],
  ['config', 'configHash'],
] as const) {
  test(`reruns a successful step when its ${label} hash changes`, async () => {
    const { store, currentFingerprints } = fixture();
    currentFingerprints.collect = {
      ...currentFingerprints.collect,
      [field]: `${field}:collect:changed`,
    };
    const calls: Array<{ key: string; context: StepExecutionContext }> = [];
    const resolver = await loadResolver(store, calls);

    await resolver.resume(request(currentFingerprints));

    assert.equal(calls[0]?.key, 'collect');
  });
}

for (const [label, artifact] of [
  ['tampered', {
    id: 'artifact-collect',
    state: 'SEALED' as const,
    contentSha256: 'sha256:not-the-record',
    byteSize: 128,
  }],
  ['unsealed', {
    id: 'artifact-collect',
    state: 'STAGING' as const,
    contentSha256: null,
    byteSize: null,
  }],
] as const) {
  test(`reruns a successful step when its ${label} artifact is not reusable`, async () => {
    const { store, currentFingerprints } = fixture();
    store.artifacts.set('artifact-collect', artifact);
    const calls: Array<{ key: string; context: StepExecutionContext }> = [];
    const resolver = await loadResolver(store, calls);

    await resolver.resume(request(currentFingerprints));

    assert.equal(calls[0]?.key, 'collect');
  });
}

test('reruns downstream dependants when a previously reusable dependency changes', async () => {
  const { store, priorAttempt, currentFingerprints } = fixture();
  priorAttempt.steps[0] = checkpointStep('collect', 'succeeded', {
    fingerprint: { ...baseFingerprint('collect'), configHash: 'config:collect:old' },
  });
  priorAttempt.steps[1] = checkpointStep('normalize', 'succeeded');
  priorAttempt.steps[2] = checkpointStep('report', 'succeeded');
  store.attempts.set(priorAttempt.id, priorAttempt);
  currentFingerprints.collect = { ...baseFingerprint('collect'), configHash: 'config:collect:new' };
  const calls: Array<{ key: string; context: StepExecutionContext }> = [];
  const resolver = await loadResolver(store, calls);

  await resolver.resume(request(currentFingerprints));

  assert.deepEqual(calls.map((call) => call.key), ['collect', 'normalize', 'report']);
});

test('persists retry_of lineage on the new attempt', async () => {
  const { store, currentFingerprints } = fixture();
  const calls: Array<{ key: string; context: StepExecutionContext }> = [];
  const resolver = await loadResolver(store, calls);

  const result = await resolver.resume(request(currentFingerprints));

  assert.deepEqual(store.createdRetries, [{
    taskId: 'task-23',
    planVersionId: 'plan-1',
    retryOf: 'attempt-1',
    idempotencyKey: 'resume-1',
  }]);
  assert.equal(result.retryOf, 'attempt-1');
  assert.equal(result.attemptId, 'attempt-2');
});

test('replays the same resume request without duplicate execution or a second attempt', async () => {
  const { store, currentFingerprints } = fixture();
  const calls: Array<{ key: string; context: StepExecutionContext }> = [];
  const resolver = await loadResolver(store, calls);

  const first = await resolver.resume(request(currentFingerprints, 'same-resume'));
  const second = await resolver.resume(request(currentFingerprints, 'same-resume'));

  assert.deepEqual(second, first);
  assert.equal(store.createdRetries.length, 1);
  assert.deepEqual(calls.map((call) => call.key), ['normalize', 'report']);
});
