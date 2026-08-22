export type ExecutionFlowPhase =
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing-report'
  | 'done'
  | 'failed'
  | 'cancelled';

export type ExecutionFlowStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'degraded'
  | 'failed'
  | 'skipped';

export interface ExecutionFlowStepInput {
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
  depends_on?: readonly number[];
}

export interface ExecutionFlowLogInput {
  step_no: number;
  status: string;
  skillProvenance?: Record<string, unknown> | null;
}

export interface ExecutionFlowNode {
  id: string;
  kind: 'system' | 'execution';
  label: string;
  actorType: string;
  actorId: string;
  status: ExecutionFlowStatus;
  layer: number;
  stepNo?: number;
  dependencies: number[];
}

export interface ExecutionFlowEdge {
  id: string;
  source: string;
  target: string;
  status: ExecutionFlowStatus;
}

export interface ExecutionFlowGraph {
  nodes: ExecutionFlowNode[];
  edges: ExecutionFlowEdge[];
  layers: ExecutionFlowNode[][];
  summary: {
    completed: number;
    total: number;
    running: number;
    failed: number;
    skipped: number;
  };
  usedSequentialFallback: boolean;
}

function normalizeStatus(status: string | undefined): ExecutionFlowStatus {
  switch (status) {
    case 'running':
    case 'executing':
      return 'running';
    case 'succeeded':
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

function systemStatuses(phase: ExecutionFlowPhase): {
  review: ExecutionFlowStatus;
  report: ExecutionFlowStatus;
} {
  switch (phase) {
    case 'reviewing':
      return { review: 'running', report: 'pending' };
    case 'composing-report':
      return { review: 'succeeded', report: 'running' };
    case 'done':
      return { review: 'succeeded', report: 'succeeded' };
    default:
      return { review: 'pending', report: 'pending' };
  }
}

function sequentialDependencies(steps: readonly ExecutionFlowStepInput[]): Map<number, number[]> {
  const dependencies = new Map<number, number[]>();
  steps.forEach((step, index) => {
    dependencies.set(step.step_no, index === 0 ? [] : [steps[index - 1].step_no]);
  });
  return dependencies;
}

function currentDependencies(steps: readonly ExecutionFlowStepInput[]): Map<number, number[]> | null {
  const stepNumbers = new Set(steps.map((step) => step.step_no));
  if (stepNumbers.size !== steps.length) return null;

  const dependencies = new Map<number, number[]>();
  for (const step of steps) {
    const values = [...new Set(step.depends_on ?? [])].sort((left, right) => left - right);
    if (values.some((dependency) => dependency === step.step_no || !stepNumbers.has(dependency))) {
      return null;
    }
    dependencies.set(step.step_no, values);
  }

  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const depthOf = (stepNo: number): number => {
    const cached = memo.get(stepNo);
    if (cached !== undefined) return cached;
    if (visiting.has(stepNo)) throw new Error('cyclic execution plan');
    visiting.add(stepNo);
    const values = dependencies.get(stepNo) ?? [];
    const depth = values.length === 0
      ? 0
      : Math.max(...values.map((dependency) => depthOf(dependency))) + 1;
    visiting.delete(stepNo);
    memo.set(stepNo, depth);
    return depth;
  };

  try {
    for (const step of steps) depthOf(step.step_no);
  } catch {
    return null;
  }
  return dependencies;
}

function dependencyDepths(
  steps: readonly ExecutionFlowStepInput[],
  dependencies: ReadonlyMap<number, readonly number[]>,
): Map<number, number> {
  const depths = new Map<number, number>();
  const depthOf = (stepNo: number): number => {
    const cached = depths.get(stepNo);
    if (cached !== undefined) return cached;
    const values = dependencies.get(stepNo) ?? [];
    const depth = values.length === 0
      ? 0
      : Math.max(...values.map((dependency) => depthOf(dependency))) + 1;
    depths.set(stepNo, depth);
    return depth;
  };
  for (const step of steps) depthOf(step.step_no);
  return depths;
}

function edgeStatus(target: ExecutionFlowNode): ExecutionFlowStatus {
  return target.status;
}

export function buildExecutionFlowGraph(input: {
  steps: readonly ExecutionFlowStepInput[];
  log?: readonly ExecutionFlowLogInput[];
  phase: ExecutionFlowPhase;
}): ExecutionFlowGraph {
  const steps = [...input.steps].sort((left, right) => left.step_no - right.step_no);
  const hasCurrentDependencies = steps.some((step) => Array.isArray(step.depends_on));
  const validatedDependencies = hasCurrentDependencies ? currentDependencies(steps) : null;
  const usedSequentialFallback = !hasCurrentDependencies || validatedDependencies === null;
  const dependencies = validatedDependencies ?? sequentialDependencies(steps);
  const depths = dependencyDepths(steps, dependencies);
  const statusByStep = new Map((input.log ?? []).map((row) => [
    row.step_no,
    row.skillProvenance?.status === 'degraded' ? 'degraded' as const : normalizeStatus(row.status),
  ]));
  const maxExecutionDepth = steps.length === 0
    ? -1
    : Math.max(...steps.map((step) => depths.get(step.step_no) ?? 0));
  const reviewLayer = maxExecutionDepth + 2;
  const reportLayer = reviewLayer + 1;
  const system = systemStatuses(input.phase);

  const planNode: ExecutionFlowNode = {
    id: 'system:plan',
    kind: 'system',
    label: '计划已确认',
    actorType: 'system',
    actorId: 'control-plan',
    status: 'succeeded',
    layer: 0,
    dependencies: [],
  };
  const executionNodes: ExecutionFlowNode[] = steps.map((step) => ({
    id: `step:${step.step_no}`,
    kind: 'execution',
    label: step.step_name,
    actorType: step.actor_type,
    actorId: step.actor_id,
    status: statusByStep.get(step.step_no) ?? 'pending',
    layer: (depths.get(step.step_no) ?? 0) + 1,
    stepNo: step.step_no,
    dependencies: [...(dependencies.get(step.step_no) ?? [])],
  }));
  const reviewNode: ExecutionFlowNode = {
    id: 'system:review',
    kind: 'system',
    label: '质量复核',
    actorType: 'system',
    actorId: 'report-review',
    status: system.review,
    layer: reviewLayer,
    dependencies: [],
  };
  const reportNode: ExecutionFlowNode = {
    id: 'system:report',
    kind: 'system',
    label: '报告生成',
    actorType: 'system',
    actorId: 'report-composer',
    status: system.report,
    layer: reportLayer,
    dependencies: [],
  };
  const nodes = [planNode, ...executionNodes, reviewNode, reportNode];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const roots = executionNodes.filter((node) => node.dependencies.length === 0);
  const dependedOn = new Set(executionNodes.flatMap((node) => node.dependencies));
  const leaves = executionNodes.filter((node) => node.stepNo !== undefined && !dependedOn.has(node.stepNo));
  const edges: ExecutionFlowEdge[] = [];
  const addEdge = (source: string, target: string): void => {
    const targetNode = nodeById.get(target);
    if (!targetNode) return;
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      status: edgeStatus(targetNode),
    });
  };

  if (roots.length === 0) addEdge(planNode.id, reviewNode.id);
  else roots.forEach((root) => addEdge(planNode.id, root.id));
  for (const node of executionNodes) {
    node.dependencies.forEach((dependency) => addEdge(`step:${dependency}`, node.id));
  }
  leaves.forEach((leaf) => addEdge(leaf.id, reviewNode.id));
  addEdge(reviewNode.id, reportNode.id);

  const layers = Array.from({ length: reportLayer + 1 }, () => [] as ExecutionFlowNode[]);
  for (const node of nodes) layers[node.layer].push(node);
  for (const layer of layers) {
    layer.sort((left, right) => (left.stepNo ?? 0) - (right.stepNo ?? 0));
  }

  const summary = executionNodes.reduce<ExecutionFlowGraph['summary']>((current, node) => {
    if (node.status === 'succeeded' || node.status === 'degraded') current.completed += 1;
    else if (node.status === 'running') current.running += 1;
    else if (node.status === 'failed') current.failed += 1;
    else if (node.status === 'skipped') current.skipped += 1;
    return current;
  }, {
    completed: 0,
    total: executionNodes.length,
    running: 0,
    failed: 0,
    skipped: 0,
  });

  return { nodes, edges, layers, summary, usedSequentialFallback };
}
