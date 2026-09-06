import { useMemo } from 'react';
import type { ExecLogRow } from '../../api/client.ts';
import {
  buildExecutionFlowGraph,
  groupExecutionSteps,
  type ExecutionFlowGraph,
  type ExecutionFlowPhase,
  type ExecutionFlowStatus,
  type ExecutionFlowStepInput,
} from '../../execution-flow-graph.ts';
import { Header } from './Stage1Understand.tsx';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 90;
const CANVAS_PADDING = 24;
const LAYER_GAP = 56;
const NODE_GAP = 18;
const MIN_CANVAS_HEIGHT = 220;

interface NodePosition {
  x: number;
  y: number;
}

interface GraphLayout {
  width: number;
  height: number;
  positions: ReadonlyMap<string, NodePosition>;
}

const STATUS_LABELS: Record<ExecutionFlowStatus, string> = {
  pending: '等待',
  running: '运行中',
  succeeded: '完成',
  degraded: '降级完成',
  failed: '失败',
  skipped: '已跳过',
};

const PHASE_LABELS: Record<ExecutionFlowPhase, string> = {
  executing: '执行中',
  paused: '执行已暂停',
  reviewing: '质量复核中',
  'composing-report': '报告生成中',
  done: '运行完成',
  failed: '运行失败',
  cancelled: '运行已终止',
};

function createGraphLayout(graph: ExecutionFlowGraph): GraphLayout {
  const widestLayer = Math.max(1, ...graph.layers.map((layer) => layer.length));
  const width = (CANVAS_PADDING * 2)
    + (graph.layers.length * NODE_WIDTH)
    + (Math.max(0, graph.layers.length - 1) * LAYER_GAP);
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    (CANVAS_PADDING * 2) + (widestLayer * NODE_HEIGHT) + ((widestLayer - 1) * NODE_GAP),
  );
  const positions = new Map<string, NodePosition>();

  graph.layers.forEach((layer, layerIndex) => {
    const layerHeight = (layer.length * NODE_HEIGHT) + (Math.max(0, layer.length - 1) * NODE_GAP);
    const x = CANVAS_PADDING + layerIndex * (NODE_WIDTH + LAYER_GAP);
    const startY = (height - layerHeight) / 2;
    layer.forEach((node, nodeIndex) => {
      positions.set(node.id, {
        x,
        y: startY + nodeIndex * (NODE_HEIGHT + NODE_GAP),
      });
    });
  });

  return { width, height, positions };
}

function actorTone(actorType: string): 'llm' | 'skill' | 'tool' | 'reviewer' | 'knowledge' | 'system' {
  if (actorType === 'llm' || actorType === 'skill' || actorType === 'tool' || actorType === 'reviewer' || actorType === 'knowledge') {
    return actorType;
  }
  return 'system';
}

function actorLabel(actorType: string): string {
  switch (actorTone(actorType)) {
    case 'llm': return 'MODEL';
    case 'skill': return 'SKILL';
    case 'tool': return 'TOOL';
    case 'reviewer': return 'REVIEW';
    case 'knowledge': return 'KNOWLEDGE';
    case 'system': return 'SYSTEM';
  }
}

function edgePath(source: NodePosition, target: NodePosition, routeIndex: number): string {
  const sourceX = source.x + NODE_WIDTH;
  const sourceY = source.y + NODE_HEIGHT / 2;
  const targetX = target.x;
  const targetY = target.y + NODE_HEIGHT / 2;
  const horizontalDistance = targetX - sourceX;
  if (horizontalDistance > LAYER_GAP * 1.5) {
    const railY = Math.max(12, Math.min(source.y, target.y) - 14 - (routeIndex % 4) * 7);
    return `M ${sourceX} ${sourceY} C ${sourceX + 18} ${sourceY}, ${sourceX + 18} ${railY}, ${sourceX + 36} ${railY} L ${targetX - 36} ${railY} C ${targetX - 18} ${railY}, ${targetX - 18} ${targetY}, ${targetX} ${targetY}`;
  }
  const bend = Math.max(22, horizontalDistance * 0.48);
  return `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`;
}

export function Stage3Execute({
  steps,
  log = [],
  phase = 'done',
  native = false,
}: {
  steps: readonly ExecutionFlowStepInput[];
  log?: readonly ExecLogRow[];
  phase?: ExecutionFlowPhase;
  native?: boolean;
}) {
  const graph = useMemo(
    () => buildExecutionFlowGraph({ steps, log, phase, native }),
    [steps, log, phase, native],
  );
  const layout = useMemo(() => createGraphLayout(graph), [graph]);
  const invocationGroups = useMemo(() => groupExecutionSteps(steps), [steps]);
  const ended = graph.summary.completed + graph.summary.skipped;
  const statusDetail = graph.summary.failed > 0
    ? `${graph.summary.failed} 个节点失败`
    : graph.summary.running > 0
      ? `${graph.summary.running} 个节点正在运行`
      : `${ended}/${graph.summary.total} 个执行节点已结束`;

  return (
    <section className="stage-card execution-flow-card">
      <Header n="3" title="运行流程" note="实时状态来自 Control task" />

      <div className={`execution-flow-summary status-${phase}`} aria-live="polite">
        <span className="execution-flow-summary-state">
          {phase === 'executing' || phase === 'reviewing' || phase === 'composing-report'
            ? <span className="spinner execution-flow-summary-spinner" />
            : <StatusMark status={phase === 'done' ? 'succeeded' : phase === 'cancelled' ? 'skipped' : 'failed'} />}
          <strong>{PHASE_LABELS[phase]}</strong>
        </span>
        <span>{statusDetail}</span>
        {graph.usedSequentialFallback ? <span className="execution-flow-mode">线性回放</span> : null}
      </div>

      {invocationGroups.some(({ id }) => id !== 'ungrouped') ? (
        <div className="execution-invocation-groups" aria-label="Skill Invocation 分组" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {invocationGroups.map((group) => (
            <span key={group.id} className="badge" title={group.consumerInvocationIds.join('、')}>
              {group.label} · {group.stepNos.length} steps
            </span>
          ))}
        </div>
      ) : null}

      <div
        className="execution-flow-viewport"
        role="img"
        aria-label={`模型运行流程，当前${PHASE_LABELS[phase]}，${statusDetail}`}
        tabIndex={0}
      >
        <div
          className="execution-flow-canvas"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            className="execution-flow-edges"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              {(['pending', 'running', 'succeeded', 'degraded', 'failed', 'skipped'] as const).map((status) => (
                <marker
                  key={status}
                  id={`execution-flow-arrow-${status}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path className={`execution-flow-arrow status-${status}`} d="M 0 0 L 8 4 L 0 8 z" />
                </marker>
              ))}
            </defs>
            {graph.edges.map((edge, edgeIndex) => {
              const source = layout.positions.get(edge.source);
              const target = layout.positions.get(edge.target);
              if (!source || !target) return null;
              return (
                <path
                  key={edge.id}
                  className={`execution-flow-edge status-${edge.status}`}
                  d={edgePath(source, target, edgeIndex)}
                  markerEnd={`url(#execution-flow-arrow-${edge.status})`}
                />
              );
            })}
          </svg>

          {graph.nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (!position) return null;
            return (
              <div
                key={node.id}
                className={`execution-flow-node actor-${actorTone(node.actorType)} status-${node.status}`}
                style={{
                  left: position.x,
                  top: position.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
                title={node.dependencies.length > 0
                  ? `${node.label}，依赖步骤 ${node.dependencies.join('、')}`
                  : node.label}
              >
                <div className="execution-flow-node-head">
                  <span className="execution-flow-node-state">
                    <StatusMark status={node.status} />
                    {STATUS_LABELS[node.status]}
                  </span>
                  {node.stepNo !== undefined
                    ? <span className="execution-flow-step-no">#{node.stepNo}</span>
                    : null}
                </div>
                <strong className="execution-flow-node-title">{node.label}</strong>
                <div className="execution-flow-node-meta">
                  <span className={`execution-flow-actor actor-${actorTone(node.actorType)}`}>
                    {actorLabel(node.actorType)}
                  </span>
                  <code>{node.actorId}</code>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ol className="sr-only">
        {graph.nodes.map((node) => (
          <li key={node.id}>
            {node.stepNo !== undefined ? `步骤 ${node.stepNo}，` : ''}
            {node.label}，{actorLabel(node.actorType)} {node.actorId}，状态{STATUS_LABELS[node.status]}
          </li>
        ))}
      </ol>

      <div className="execution-flow-legend" aria-hidden="true">
        {(['running', 'succeeded', 'degraded', 'failed', 'skipped', 'pending'] as const).map((status) => (
          <span key={status}><StatusMark status={status} />{STATUS_LABELS[status]}</span>
        ))}
      </div>
    </section>
  );
}

function StatusMark({ status }: { status: ExecutionFlowStatus }) {
  if (status === 'running') return <span className="spinner execution-flow-node-spinner" />;
  if (status === 'succeeded') return <span className="execution-flow-status-mark status-succeeded">✓</span>;
  if (status === 'degraded') return <span className="execution-flow-status-mark status-degraded">!</span>;
  if (status === 'failed') return <span className="execution-flow-status-mark status-failed">×</span>;
  if (status === 'skipped') return <span className="execution-flow-status-mark status-skipped">↷</span>;
  return <span className="execution-flow-status-mark status-pending">○</span>;
}
