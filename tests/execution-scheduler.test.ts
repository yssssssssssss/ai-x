import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionScheduler } from '../apps/orchestrator-runtime/src/control/execution-scheduler.ts';

type Step = {
  key: string;
  dependsOn: string[];
  tier?: 'core' | 'optional';
};

type Plan = { steps: Step[] };
type ExecutionContext = { reusableOutputs: Record<string, unknown> };
type ScheduleResult = {
  waves: string[][];
  statuses: Record<string, 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'reused'>;
};

function schedulerFixture(
  execute: (step: Step, context: ExecutionContext) => Promise<unknown>,
) {
  return new ExecutionScheduler({ execute });
}

function status(result: ScheduleResult, key: string) {
  return result.statuses[key];
}

test('schedule emits topological waves and places independent steps in one wave', async () => {
  const calls: string[] = [];
  const scheduler = schedulerFixture(async (step) => {
    calls.push(step.key);
    return `${step.key}-output`;
  });
  const plan: Plan = {
    steps: [
      { key: 'research', dependsOn: [] },
      { key: 'interview', dependsOn: [] },
      { key: 'synthesis', dependsOn: ['research', 'interview'] },
      { key: 'review', dependsOn: ['synthesis'] },
    ],
  };

  const result = await scheduler.schedule(plan, {} as never) as ScheduleResult;

  assert.deepEqual(result.waves, [
    ['research', 'interview'],
    ['synthesis'],
    ['review'],
  ]);
  assert.deepEqual(new Set(calls), new Set(['research', 'interview', 'synthesis', 'review']));
});

test('schedule executes independent steps in parallel', async () => {
  let running = 0;
  let maxRunning = 0;
  const calls: string[] = [];
  const scheduler = schedulerFixture(async (step) => {
    calls.push(step.key);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await Promise.resolve();
    running -= 1;
    return step.key;
  });

  const result = await scheduler.schedule({
    steps: [
      { key: 'a', dependsOn: [] },
      { key: 'b', dependsOn: [] },
    ],
  }, {} as never) as ScheduleResult;

  assert.equal(maxRunning, 2);
  assert.deepEqual(calls.sort(), ['a', 'b']);
  assert.equal(status(result, 'a'), 'succeeded');
  assert.equal(status(result, 'b'), 'succeeded');
});

test('schedule blocks every downstream step after a dependency failure', async () => {
  const calls: string[] = [];
  const scheduler = schedulerFixture(async (step) => {
    calls.push(step.key);
    if (step.key === 'research') throw new Error('provider unavailable');
    return step.key;
  });

  const result = await scheduler.schedule({
    steps: [
      { key: 'research', dependsOn: [] },
      { key: 'analysis', dependsOn: ['research'] },
      { key: 'review', dependsOn: ['analysis'] },
    ],
  }, {} as never) as ScheduleResult;

  assert.deepEqual(calls, ['research']);
  assert.equal(status(result, 'research'), 'failed');
  assert.equal(status(result, 'analysis'), 'blocked');
  assert.equal(status(result, 'review'), 'blocked');
});

test('schedule cancels unstarted downstream work when a core step fails', async () => {
  const calls: string[] = [];
  const scheduler = schedulerFixture(async (step) => {
    calls.push(step.key);
    throw new Error(`${step.key} failed`);
  });

  const result = await scheduler.schedule({
    steps: [
      { key: 'core-search', dependsOn: [], tier: 'core' },
      { key: 'core-analysis', dependsOn: ['core-search'], tier: 'core' },
      { key: 'optional-review', dependsOn: ['core-analysis'], tier: 'optional' },
    ],
  }, {} as never) as ScheduleResult;

  assert.deepEqual(calls, ['core-search']);
  assert.equal(status(result, 'core-search'), 'failed');
  assert.equal(status(result, 'core-analysis'), 'cancelled');
  assert.equal(status(result, 'optional-review'), 'cancelled');
});

test('schedule invokes each step at most once across a diamond dependency graph', async () => {
  const calls: string[] = [];
  const scheduler = schedulerFixture(async (step) => {
    calls.push(step.key);
    return step.key;
  });

  await scheduler.schedule({
    steps: [
      { key: 'root', dependsOn: [] },
      { key: 'left', dependsOn: ['root'] },
      { key: 'right', dependsOn: ['root'] },
      { key: 'join', dependsOn: ['left', 'right'] },
    ],
  }, {} as never);

  assert.deepEqual(calls.sort(), ['join', 'left', 'right', 'root']);
  for (const key of ['root', 'left', 'right', 'join']) {
    assert.equal(calls.filter((called) => called === key).length, 1, `${key} should run once`);
  }
});

test('schedule reuses a valid checkpoint and injects its output into the next step', async () => {
  const calls: string[] = [];
  let downstreamContext: ExecutionContext | undefined;
  const scheduler = schedulerFixture(async (step, context) => {
    calls.push(step.key);
    if (step.key === 'synthesis') downstreamContext = context;
    return { generatedBy: step.key };
  });

  const result = await scheduler.schedule({
    steps: [
      { key: 'research', dependsOn: [] },
      { key: 'synthesis', dependsOn: ['research'] },
    ],
  }, {
    research: { output: { sources: ['cached-source'] }, fingerprint: 'sha256:research' },
  } as never) as ScheduleResult;

  assert.deepEqual(calls, ['synthesis']);
  assert.deepEqual(downstreamContext?.reusableOutputs, {
    research: { sources: ['cached-source'] },
  });
  assert.equal(status(result, 'research'), 'reused');
  assert.equal(status(result, 'synthesis'), 'succeeded');
});
