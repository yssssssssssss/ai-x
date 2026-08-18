import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ControlPlaneExecutionRecoveryStore,
  ExecutionRecoveryController,
  ExecutionRecoveryService,
} from '../apps/orchestrator-runtime/src/control/execution-recovery-service.ts';
import { ARTIFACT_QUARANTINE_PENDING_MARKER } from '../database/control-plane.ts';

type RecoveryExecution = {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  taskState: 'executing' | 'reviewing' | 'composing_report' | 'paused' | 'completed' | 'failed' | 'cancelled';
  attemptState: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  leaseExpiresAt: Date;
  failureKind?: string;
};

type RecoveryArtifact = {
  id: string;
  attemptId: string;
  kind: string;
  state: 'STAGING' | 'SEALED' | 'FAILED' | 'INVALIDATED';
  storageUri: string;
  quarantinedUri?: string;
  failureReason?: string;
};

const ATTEMPT_ARTIFACT_KINDS = [
  'tool_output',
  'skill_output',
  'llm_output',
  'review_output',
  'evidence_manifest',
  'deliverable',
  'report_review',
  'report_document',
  'report_package',
  'visual_asset',
  'visual_asset_manifest',
  'image_annotation',
  'chart_spec',
  'future_attempt_artifact',
] as const;

class MemoryRecoveryStore {
  visualRecoveryRuns = 0;
  readonly executions: RecoveryExecution[] = [
    {
      planVersionId: 'expired-plan',
      taskId: 'expired-task',
      attemptId: 'expired-attempt',
      taskState: 'executing',
      attemptState: 'active',
      leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    },
    {
      planVersionId: 'live-plan',
      taskId: 'live-task',
      attemptId: 'live-attempt',
      taskState: 'executing',
      attemptState: 'active',
      leaseExpiresAt: new Date('2026-08-18T00:00:00.000Z'),
    },
  ];

  readonly artifacts: RecoveryArtifact[] = [
    ...ATTEMPT_ARTIFACT_KINDS.map((kind) => ({
      id: `orphan-${kind}`,
      attemptId: 'expired-attempt',
      kind,
      state: 'STAGING' as const,
      storageUri: `/runs/${kind}.json`,
    })),
    { id: 'sealed-evidence', attemptId: 'expired-attempt', kind: 'evidence_manifest', state: 'SEALED', storageUri: '/runs/evidence.json' },
    { id: 'sealed-deliverable', attemptId: 'expired-attempt', kind: 'deliverable', state: 'SEALED', storageUri: '/runs/deliverable.json' },
    { id: 'sealed-review', attemptId: 'expired-attempt', kind: 'report_review', state: 'SEALED', storageUri: '/runs/review.json' },
    { id: 'sealed-document', attemptId: 'expired-attempt', kind: 'report_document', state: 'SEALED', storageUri: '/runs/document.json' },
    { id: 'sealed-package', attemptId: 'expired-attempt', kind: 'report_package', state: 'SEALED', storageUri: '/runs/package.json' },
    { id: 'sealed-visual', attemptId: 'expired-attempt', kind: 'visual_asset', state: 'SEALED', storageUri: '/runs/visual.image' },
    { id: 'sealed-visual-manifest', attemptId: 'expired-attempt', kind: 'visual_asset_manifest', state: 'SEALED', storageUri: '/runs/visual.json' },
    { id: 'sealed-annotation', attemptId: 'expired-attempt', kind: 'image_annotation', state: 'SEALED', storageUri: '/runs/annotation.json' },
    { id: 'sealed-chart', attemptId: 'expired-attempt', kind: 'chart_spec', state: 'SEALED', storageUri: '/runs/chart.json' },
    { id: 'sealed-published-step', attemptId: 'expired-attempt', kind: 'tool_output', state: 'SEALED', storageUri: '/runs/published-step.json' },
    { id: 'sealed-orphan-step', attemptId: 'expired-attempt', kind: 'skill_output', state: 'SEALED', storageUri: '/runs/orphan-step.json' },
    { id: 'live-staging', attemptId: 'live-attempt', kind: 'other', state: 'STAGING', storageUri: '/runs/live.json' },
    { id: 'sealed-other', attemptId: 'expired-attempt', kind: 'other', state: 'SEALED', storageUri: '/runs/other.json' },
  ];

  readonly calls = {
    pause: [] as Array<{ taskId: string; attemptId: string; reason: string }>,
    invalidate: [] as Array<{ artifactId: string; reason: string }>,
    quarantine: [] as Array<{ artifactId: string; quarantineUri: string }>,
  };

  async recoverVisualPublications() {
    this.visualRecoveryRuns += 1;
    return 0;
  }

  async listExecutions() {
    return this.executions.map((execution) => ({ ...execution }));
  }

  async pauseExecution(input: { taskId: string; attemptId: string; reason: string }) {
    const execution = this.executions.find((entry) => entry.attemptId === input.attemptId);
    if (!execution || execution.attemptState !== 'active') return;
    execution.taskState = 'paused';
    execution.attemptState = 'paused';
    execution.failureKind = input.reason;
    this.calls.pause.push(input);
  }

  async listArtifactsForAttempt(input: { taskId: string; planVersionId: string; attemptId: string }) {
    return this.artifacts
      .filter((artifact) => artifact.attemptId === input.attemptId)
      .map((artifact) => ({ ...artifact }));
  }

  async listSucceededStepArtifactIds(attemptId: string) {
    return attemptId === 'expired-attempt' ? ['sealed-published-step'] : [];
  }

  async quarantineArtifact(input: { artifactId: string }) {
    const artifact = this.artifacts.find((entry) => entry.id === input.artifactId);
    if (!artifact) return;
    if (
      artifact.state === 'FAILED'
      && artifact.failureReason?.includes(ARTIFACT_QUARANTINE_PENDING_MARKER)
    ) {
      artifact.failureReason = `orphaned staging artifact after worker loss; file quarantined at ${artifact.storageUri}`;
      this.calls.quarantine.push({ ...input, quarantineUri: artifact.storageUri });
      return;
    }
    if (artifact.state !== 'STAGING') return;
    const quarantineUri = `${artifact.storageUri}.${artifact.id}.orphan`;
    artifact.quarantinedUri = quarantineUri;
    artifact.storageUri = quarantineUri;
    artifact.state = 'FAILED';
    artifact.failureReason = `orphaned staging artifact after worker loss; file quarantined at ${quarantineUri}`;
    this.calls.quarantine.push({ ...input, quarantineUri });
  }

  async invalidateArtifact(input: { artifactId: string; reason: string }) {
    const artifact = this.artifacts.find((entry) => entry.id === input.artifactId);
    if (!artifact || artifact.state !== 'SEALED') return;
    artifact.state = 'INVALIDATED';
    artifact.failureReason = input.reason;
    this.calls.invalidate.push(input);
  }
}

function recoveryFixture() {
  const store = new MemoryRecoveryStore();
  const service = new ExecutionRecoveryService({ store });
  return { service, store };
}

test('recover pauses an expired lease as worker_lost without touching an active lease', async () => {
  const { service, store } = recoveryFixture();

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));
  assert.equal(store.visualRecoveryRuns, 1);

  const expired = store.executions.find((entry) => entry.taskId === 'expired-task');
  const live = store.executions.find((entry) => entry.taskId === 'live-task');
  assert.equal(expired?.taskState, 'paused');
  assert.equal(expired?.attemptState, 'paused');
  assert.equal(expired?.failureKind, 'worker_lost');
  assert.deepEqual(store.calls.pause, [{
    taskId: 'expired-task',
    attemptId: 'expired-attempt',
    reason: 'worker_lost',
  }]);
  assert.equal(live?.taskState, 'executing');
  assert.equal(live?.attemptState, 'active');
  assert.equal(store.calls.pause.some((call) => call.taskId === 'live-task'), false);
});
test('recover also pauses expired reviewing and composing attempts', async () => {
  const { service, store } = recoveryFixture();
  store.executions.push(
    {
      planVersionId: 'review-plan',
      taskId: 'review-task',
      attemptId: 'review-attempt',
      taskState: 'reviewing',
      attemptState: 'active',
      leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    },
    {
      planVersionId: 'compose-plan',
      taskId: 'compose-task',
      attemptId: 'compose-attempt',
      taskState: 'composing_report',
      attemptState: 'active',
      leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    },
  );

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  assert.deepEqual(
    store.calls.pause.filter((call) => call.taskId.endsWith('-task')).map((call) => call.attemptId),
    ['expired-attempt', 'review-attempt', 'compose-attempt'],
  );
});

test('recovery controller logs a failed cycle and continues with the next cycle', async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const service = new ExecutionRecoveryService({
    store: {
      async recoverVisualPublications() { return 0; },
      async listExecutions() {
        calls += 1;
        if (calls === 1) throw new Error('transient recovery failure');
        return [];
      },
      async pauseExecution() {},
      async listArtifactsForAttempt() { return []; },
      async listSucceededStepArtifactIds() { return []; },
      async quarantineArtifact() {},
      async invalidateArtifact() {},
    },
  });
  const controller = new ExecutionRecoveryController(service, 5, () => new Date(), (error) => errors.push(error));
  await controller.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.stop();

  assert.equal(calls >= 2, true);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /transient recovery failure/);
});

test('recover quarantines STAGING artifacts before failing their registry records', async () => {
  const { service, store } = recoveryFixture();

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  for (const kind of ATTEMPT_ARTIFACT_KINDS) {
    const orphan = store.artifacts.find((artifact) => artifact.id === `orphan-${kind}`);
    assert.equal(orphan?.state, 'FAILED');
    assert.match(orphan?.quarantinedUri ?? '', new RegExp(`orphan-${kind}`));
  }
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'live-staging')?.state, 'STAGING');
  assert.equal(store.calls.quarantine.some((call) => call.artifactId === 'live-staging'), false);
  assert.deepEqual(
    store.calls.quarantine.map(({ artifactId }) => artifactId),
    ATTEMPT_ARTIFACT_KINDS.map((kind) => `orphan-${kind}`),
  );
});

test('recover invalidates sealed terminal and unpublished step Artifacts but preserves referenced outputs', async () => {
  const { service, store } = recoveryFixture();

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  for (const id of [
    'sealed-evidence',
    'sealed-deliverable',
    'sealed-review',
    'sealed-document',
    'sealed-package',
    'sealed-visual',
    'sealed-visual-manifest',
    'sealed-annotation',
    'sealed-chart',
  ]) {
    assert.equal(store.artifacts.find((artifact) => artifact.id === id)?.state, 'INVALIDATED');
  }
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'sealed-orphan-step')?.state, 'INVALIDATED');
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'sealed-published-step')?.state, 'SEALED');
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'sealed-other')?.state, 'SEALED');
  assert.deepEqual(store.calls.invalidate.map((call) => call.artifactId), [
    'sealed-evidence',
    'sealed-deliverable',
    'sealed-review',
    'sealed-document',
    'sealed-package',
    'sealed-visual',
    'sealed-visual-manifest',
    'sealed-annotation',
    'sealed-chart',
    'sealed-orphan-step',
  ]);
});

test('recover retries an unpublished sealed step Artifact after immediate invalidation failed', async () => {
  const { service, store } = recoveryFixture();
  store.executions.push({
    planVersionId: 'ambiguous-plan',
    taskId: 'ambiguous-task',
    attemptId: 'ambiguous-attempt',
    taskState: 'paused',
    attemptState: 'paused',
    leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    failureKind: 'artifact_invalidation',
  });
  store.artifacts.push({
    id: 'ambiguous-orphan-step',
    attemptId: 'ambiguous-attempt',
    kind: 'llm_output',
    state: 'SEALED',
    storageUri: '/runs/ambiguous-orphan-step.json',
  });

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  assert.equal(store.artifacts.find(({ id }) => id === 'ambiguous-orphan-step')?.state, 'INVALIDATED');
  assert.equal(store.calls.pause.some(({ attemptId }) => attemptId === 'ambiguous-attempt'), false);
});

test('recover is idempotent when invoked repeatedly for the same timestamp', async () => {
  const { service, store } = recoveryFixture();
  const now = new Date('2026-08-17T00:00:01.000Z');

  await service.recover(now);
  const first = structuredClone(store.calls);
  await service.recover(now);

  assert.deepEqual(store.calls, first);
  assert.equal(store.executions.find((entry) => entry.taskId === 'expired-task')?.failureKind, 'worker_lost');
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'orphan-tool_output')?.state, 'FAILED');
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'sealed-deliverable')?.state, 'INVALIDATED');
});

test('recover resumes artifact cleanup for an already-paused worker-loss attempt', async () => {
  const { service, store } = recoveryFixture();
  store.executions.push({
    planVersionId: 'interrupted-plan',
    taskId: 'interrupted-task',
    attemptId: 'interrupted-attempt',
    taskState: 'paused',
    attemptState: 'paused',
    leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    failureKind: 'worker_loss',
  });
  store.artifacts.push({
    id: 'interrupted-staging',
    attemptId: 'interrupted-attempt',
    kind: 'tool_output',
    state: 'STAGING',
    storageUri: '/runs/interrupted.json',
  });
  store.artifacts.push({
    id: 'interrupted-late-writer',
    attemptId: 'interrupted-attempt',
    kind: 'skill_output',
    state: 'FAILED',
    storageUri: '/runs/late-writer.json.interrupted-late-writer.orphan',
    failureReason: `orphaned staging artifact after worker loss${ARTIFACT_QUARANTINE_PENDING_MARKER}/runs/late-writer.json`,
  });

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  assert.equal(store.calls.pause.some(({ attemptId }) => attemptId === 'interrupted-attempt'), false);
  assert.equal(store.artifacts.find(({ id }) => id === 'interrupted-staging')?.state, 'FAILED');
  assert.match(
    store.artifacts.find(({ id }) => id === 'interrupted-late-writer')?.failureReason ?? '',
    /file quarantined/,
  );
});

test('recover cleans a historical worker-loss attempt after a retry becomes current', async () => {
  const { service, store } = recoveryFixture();
  store.executions.push({
    planVersionId: 'historical-plan',
    taskId: 'retried-task',
    attemptId: 'historical-attempt',
    taskState: 'executing',
    attemptState: 'paused',
    leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    failureKind: 'worker_loss',
  });
  store.artifacts.push({
    id: 'historical-staging',
    attemptId: 'historical-attempt',
    kind: 'tool_output',
    state: 'STAGING',
    storageUri: '/runs/historical.json',
  });

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  assert.equal(store.calls.pause.some(({ attemptId }) => attemptId === 'historical-attempt'), false);
  assert.equal(store.artifacts.find(({ id }) => id === 'historical-staging')?.state, 'FAILED');
});

test('recover cleans a worker-loss attempt after the user aborts it', async () => {
  const { service, store } = recoveryFixture();
  store.executions.push({
    planVersionId: 'aborted-plan',
    taskId: 'aborted-task',
    attemptId: 'aborted-attempt',
    taskState: 'cancelled',
    attemptState: 'cancelled',
    leaseExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
    failureKind: 'worker_loss',
  });
  store.artifacts.push({
    id: 'aborted-staging',
    attemptId: 'aborted-attempt',
    kind: 'tool_output',
    state: 'STAGING',
    storageUri: '/runs/aborted.json',
  });

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  assert.equal(store.artifacts.find(({ id }) => id === 'aborted-staging')?.state, 'FAILED');
});

test('recover continues after one Artifact fails and reports the aggregated cycle error', async () => {
  const { service, store } = recoveryFixture();
  const originalQuarantineArtifact = store.quarantineArtifact.bind(store);
  store.quarantineArtifact = async (input) => {
    if (input.artifactId === 'orphan-tool_output') throw new Error('permanent quarantine failure');
    await originalQuarantineArtifact(input);
  };

  await assert.rejects(
    () => service.recover(new Date('2026-08-17T00:00:01.000Z')),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((item) => String(item).includes('orphan-tool_output')),
  );

  assert.equal(store.artifacts.find(({ id }) => id === 'orphan-tool_output')?.state, 'STAGING');
  assert.equal(store.artifacts.find(({ id }) => id === 'orphan-skill_output')?.state, 'FAILED');
  assert.equal(store.artifacts.find(({ id }) => id === 'sealed-document')?.state, 'INVALIDATED');
});

test('production recovery store queries every attempt artifact without a kind allowlist', async () => {
  const calls: unknown[] = [];
  const store = new ControlPlaneExecutionRecoveryStore({
    async listArtifactsForAttempt(input: unknown) {
      calls.push(input);
      return [];
    },
  } as never, {
    async quarantineStagingArtifact() { return null; },
  });
  const input = { taskId: 'task', planVersionId: 'plan', attemptId: 'attempt' };

  assert.deepEqual(await store.listArtifactsForAttempt(input), []);
  assert.deepEqual(calls, [input]);
});
