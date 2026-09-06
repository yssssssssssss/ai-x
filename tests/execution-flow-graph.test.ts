import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExecutionFlowGraph } from '../apps/web/src/execution-flow-graph.ts';
import { executionPlanStepsForTask } from '../apps/web/src/current-flow-state.ts';

const steps = [
  {
    step_no: 1,
    step_name: '拆解研究问题',
    actor_type: 'llm',
    actor_id: 'research-planner',
    depends_on: [],
  },
  {
    step_no: 2,
    step_name: '检索公开资料',
    actor_type: 'tool',
    actor_id: 'web-search',
    depends_on: [1],
  },
  {
    step_no: 3,
    step_name: '分析竞品视觉',
    actor_type: 'skill',
    actor_id: 'competitive-analysis',
    depends_on: [1],
  },
  {
    step_no: 4,
    step_name: '复核研究结论',
    actor_type: 'reviewer',
    actor_id: 'research-reviewer',
    depends_on: [2, 3],
  },
] as const;

test('execution flow graph preserves the current plan DAG and runtime states', () => {
  const graph = buildExecutionFlowGraph({
    steps,
    log: [
      {
        step_no: 1,
        status: 'succeeded',
      },
      {
        step_no: 2,
        status: 'running',
      },
    ],
    phase: 'executing',
  });

  assert.deepEqual(
    graph.layers.map((layer) => layer.map((node) => node.id)),
    [
      ['system:plan'],
      ['step:1'],
      ['step:2', 'step:3'],
      ['step:4'],
      ['system:review'],
      ['system:report'],
    ],
  );
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    [
      'system:plan->step:1',
      'step:1->step:2',
      'step:1->step:3',
      'step:2->step:4',
      'step:3->step:4',
      'step:4->system:review',
      'system:review->system:report',
    ],
  );
  assert.equal(graph.nodes.find((node) => node.id === 'step:1')?.status, 'succeeded');
  assert.equal(graph.nodes.find((node) => node.id === 'step:2')?.status, 'running');
  assert.equal(graph.nodes.find((node) => node.id === 'step:3')?.status, 'pending');
  assert.deepEqual(graph.summary, {
    completed: 1,
    total: 4,
    running: 1,
    failed: 0,
    skipped: 0,
  });
});

test('terminal Current tasks keep the active plan dependency graph', () => {
  const restored = executionPlanStepsForTask({
    activePlan: { plan: { steps } },
    executionSteps: [],
  });
  const graph = buildExecutionFlowGraph({ steps: restored, log: [], phase: 'done' });

  assert.equal(graph.usedSequentialFallback, false);
  assert.deepEqual(restored.map((step) => step.depends_on), [[], [1], [1], [2, 3]]);
  assert.deepEqual(
    graph.layers.map((layer) => layer.map((node) => node.id)),
    [
      ['system:plan'],
      ['step:1'],
      ['step:2', 'step:3'],
      ['step:4'],
      ['system:review'],
      ['system:report'],
    ],
  );
});

test('execution flow graph maps review and report phases without inventing step completion', () => {
  const reviewing = buildExecutionFlowGraph({ steps, log: [], phase: 'reviewing' });
  assert.equal(reviewing.nodes.find((node) => node.id === 'system:review')?.status, 'running');
  assert.equal(reviewing.nodes.find((node) => node.id === 'system:report')?.status, 'pending');
  assert.equal(reviewing.nodes.find((node) => node.id === 'step:1')?.status, 'pending');

  const composing = buildExecutionFlowGraph({ steps, log: [], phase: 'composing-report' });
  assert.equal(composing.nodes.find((node) => node.id === 'system:review')?.status, 'succeeded');
  assert.equal(composing.nodes.find((node) => node.id === 'system:report')?.status, 'running');

  const done = buildExecutionFlowGraph({ steps, log: [], phase: 'done' });
  assert.equal(done.nodes.find((node) => node.id === 'system:review')?.status, 'succeeded');
  assert.equal(done.nodes.find((node) => node.id === 'system:report')?.status, 'succeeded');
});

test('native execution graph ends at report finalization without a Review node', () => {
  const graph = buildExecutionFlowGraph({
    steps: steps.slice(0, 3),
    log: [],
    phase: 'done',
    native: true,
  });
  assert.equal(graph.nodes.some(({ id }) => id === 'system:review'), false);
  assert.equal(graph.nodes.find(({ id }) => id === 'system:report')?.actorId, 'native-reporting');
  assert.deepEqual(
    graph.edges.filter(({ target }) => target === 'system:report').map(({ source }) => source).sort(),
    ['step:2', 'step:3'],
  );
});

test('legacy execution logs get a deterministic sequential graph', () => {
  const graph = buildExecutionFlowGraph({
    steps: steps.slice(0, 3).map(({ depends_on: _dependsOn, ...step }) => step),
    log: [],
    phase: 'done',
  });

  assert.equal(graph.usedSequentialFallback, true);
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    [
      'system:plan->step:1',
      'step:1->step:2',
      'step:2->step:3',
      'step:3->system:review',
      'system:review->system:report',
    ],
  );
});

test('invalid dependency cycles fall back to a visible sequential graph', () => {
  const graph = buildExecutionFlowGraph({
    steps: [
      { ...steps[0], depends_on: [2] },
      { ...steps[1], depends_on: [1] },
    ],
    log: [],
    phase: 'paused',
  });

  assert.equal(graph.usedSequentialFallback, true);
  assert.deepEqual(
    graph.layers.map((layer) => layer.map((node) => node.id)),
    [
      ['system:plan'],
      ['step:1'],
      ['step:2'],
      ['system:review'],
      ['system:report'],
    ],
  );
});
