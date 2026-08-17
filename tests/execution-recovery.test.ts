import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRecoveryController, ExecutionRecoveryService } from '../apps/orchestrator-runtime/src/control/execution-recovery-service.ts';

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
  kind: 'evidence_manifest' | 'deliverable' | 'report_review' | 'report_document' | 'other';
  state: 'STAGING' | 'SEALED' | 'FAILED' | 'INVALIDATED';
  storageUri: string;
  quarantinedUri?: string;
  failureReason?: string;
};

class MemoryRecoveryStore {
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
    { id: 'orphan-staging', kind: 'other', state: 'STAGING', storageUri: '/runs/orphan.json' },
    { id: 'sealed-evidence', kind: 'evidence_manifest', state: 'SEALED', storageUri: '/runs/evidence.json' },
    { id: 'sealed-deliverable', kind: 'deliverable', state: 'SEALED', storageUri: '/runs/deliverable.json' },
    { id: 'sealed-review', kind: 'report_review', state: 'SEALED', storageUri: '/runs/review.json' },
    { id: 'sealed-document', kind: 'report_document', state: 'SEALED', storageUri: '/runs/document.json' },
    { id: 'live-staging', kind: 'other', state: 'STAGING', storageUri: '/runs/live.json' },
    { id: 'sealed-other', kind: 'other', state: 'SEALED', storageUri: '/runs/other.json' },
  ];

  readonly calls = {
    pause: [] as Array<{ taskId: string; attemptId: string; reason: string }>,
    invalidate: [] as Array<{ artifactId: string; reason: string }>,
    quarantine: [] as Array<{ artifactId: string; quarantineUri: string }>,
    fail: [] as Array<{ artifactId: string; reason: string }>,
  };

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
    if (input.attemptId !== 'expired-attempt' || input.taskId !== 'expired-task' || input.planVersionId !== 'expired-plan') return [];
    return this.artifacts.filter((artifact) => artifact.id !== 'live-staging').map((artifact) => ({ ...artifact }));
  }

  async quarantineArtifact(input: { artifactId: string; quarantineUri: string }) {
    const artifact = this.artifacts.find((entry) => entry.id === input.artifactId);
    if (!artifact || artifact.state !== 'STAGING') return;
    artifact.quarantinedUri = input.quarantineUri;
    this.calls.quarantine.push(input);
  }

  async failArtifact(input: { artifactId: string; reason: string }) {
    const artifact = this.artifacts.find((entry) => entry.id === input.artifactId);
    if (!artifact || artifact.state !== 'STAGING') return;
    artifact.state = 'FAILED';
    artifact.failureReason = input.reason;
    this.calls.fail.push(input);
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
      async listExecutions() {
        calls += 1;
        if (calls === 1) throw new Error('transient recovery failure');
        return [];
      },
      async pauseExecution() {},
      async listArtifactsForAttempt() { return []; },
      async quarantineArtifact() {},
      async failArtifact() {},
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

  const orphan = store.artifacts.find((artifact) => artifact.id === 'orphan-staging');
  assert.equal(orphan?.state, 'FAILED');
  assert.match(orphan?.quarantinedUri ?? '', /orphan-staging/);
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'live-staging')?.state, 'STAGING');
  assert.equal(store.calls.quarantine.some((call) => call.artifactId === 'live-staging'), false);
  assert.equal(store.calls.quarantine.length, 1);
  assert.equal(store.calls.fail.length, 1);
  assert.equal(store.calls.quarantine[0]?.artifactId, 'orphan-staging');
  assert.equal(store.calls.fail[0]?.artifactId, 'orphan-staging');
});

test('recover invalidates sealed trusted terminal artifacts but leaves unrelated sealed artifacts alone', async () => {
  const { service, store } = recoveryFixture();

  await service.recover(new Date('2026-08-17T00:00:01.000Z'));

  for (const id of ['sealed-evidence', 'sealed-deliverable', 'sealed-review', 'sealed-document']) {
    assert.equal(store.artifacts.find((artifact) => artifact.id === id)?.state, 'INVALIDATED');
  }
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'sealed-other')?.state, 'SEALED');
  assert.deepEqual(store.calls.invalidate.map((call) => call.artifactId), [
    'sealed-evidence',
    'sealed-deliverable',
    'sealed-review',
    'sealed-document',
  ]);
});

test('recover is idempotent when invoked repeatedly for the same timestamp', async () => {
  const { service, store } = recoveryFixture();
  const now = new Date('2026-08-17T00:00:01.000Z');

  await service.recover(now);
  const first = structuredClone(store.calls);
  await service.recover(now);

  assert.deepEqual(store.calls, first);
  assert.equal(store.executions.find((entry) => entry.taskId === 'expired-task')?.failureKind, 'worker_lost');
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'orphan-staging')?.state, 'FAILED');
  assert.equal(store.artifacts.find((artifact) => artifact.id === 'sealed-deliverable')?.state, 'INVALIDATED');
});
