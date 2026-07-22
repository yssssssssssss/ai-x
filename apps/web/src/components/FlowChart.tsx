import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Position,
  Handle,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type TopoNode, type TopologyResponse } from '../api/client.ts';

// ============================================================
// 动态架构拓扑图
// 节点/边完全从 /api/topology 读取(源自 registry YAML),
// 高亮由外部传入的 activeNodeIds 驱动(来自 SSE 运行时事件)。
// ============================================================

export type Phase = 'idle' | 'planning' | 'picking' | 'selecting' | 'planned' | 'executing' | 'paused' | 'done' | 'error';

export interface FlowChartProps {
  phase: Phase;
  /** 当前活跃的组件 ID 列表(来自 SSE step_started 事件) */
  activeNodeIds?: string[];
  /** 已失败的组件 ID */
  failedNodeId?: string;
  /** 已完成的组件 ID 列表 */
  completedNodeIds?: string[];
  onNodeClick?: (nodeId: string) => void;
}

// ---- 高亮状态 ----
type Glow = 'idle' | 'active' | 'success' | 'error';

const GLOW_STYLES: Record<Glow, { border: string; bg: string; shadow: string }> = {
  idle: {
    border: 'rgba(255,255,255,0.08)',
    bg: '#1c2233',
    shadow: '0 1px 3px rgba(0,0,0,0.4)',
  },
  active: {
    border: '#7c7cf0',
    bg: '#1a1f35',
    shadow: '0 0 12px rgba(124,124,240,0.4), inset 0 0 8px rgba(124,124,240,0.1)',
  },
  success: {
    border: '#34d399',
    bg: '#121f1a',
    shadow: '0 0 10px rgba(52,211,153,0.35)',
  },
  error: {
    border: '#f87171',
    bg: '#1f1215',
    shadow: '0 0 10px rgba(248,113,113,0.4)',
  },
};

// ---- 节点类型颜色(静态标识) ----
const TYPE_ACCENT: Record<TopoNode['type'], string> = {
  gateway: '#60a5fa',
  runtime: '#a78bfa',
  tool: '#fbbf24',
  skill: '#34d399',
  knowledge: '#f472b6',
  decision: '#fb923c',
  group: 'transparent',
};

// ============================================================
// 自定义节点组件
// ============================================================

const BaseNode = memo(({ data }: NodeProps) => {
  const glow = (data.glow ?? 'idle') as Glow;
  const nodeType = (data.nodeType ?? 'runtime') as TopoNode['type'];
  const style = GLOW_STYLES[glow];
  const accentColor = glow !== 'idle' ? style.border : TYPE_ACCENT[nodeType];

  return (
    <div
      style={{
        background: style.bg,
        border: `1.5px solid ${style.border}`,
        borderRadius: 8,
        padding: '8px 12px',
        boxShadow: style.shadow,
        transition: 'all 0.3s ease',
        minWidth: 100,
        borderLeft: `3px solid ${accentColor}`,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} id="top" style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ opacity: 0 }} />
      <div style={{ fontSize: 12, fontWeight: 600, color: '#e6e9f0', whiteSpace: 'nowrap' }}>
        {String(data.label)}
      </div>
      {data.sub ? (
        <div style={{ fontSize: 9, color: '#6b7488', marginTop: 2, whiteSpace: 'nowrap' }}>
          {String(data.sub)}
        </div>
      ) : null}
    </div>
  );
});
BaseNode.displayName = 'BaseNode';

const GroupNode = memo(({ data }: NodeProps) => {
  const glow = (data.glow ?? 'idle') as Glow;
  const style = GLOW_STYLES[glow];
  return (
    <div
      style={{
        width: data.width as number ?? 300,
        height: data.height as number ?? 200,
        border: glow === 'idle' ? 'none' : `1px dashed ${style.border}`,
        borderRadius: 12,
        background: glow === 'idle' ? 'transparent' : `${style.bg}44`,
        padding: 10,
        transition: 'all 0.4s ease',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7488', textTransform: 'uppercase', letterSpacing: 1 }}>
        {String(data.label)}
      </div>
      {data.sub ? (
        <div style={{ fontSize: 8, color: '#4a5168', marginTop: 2 }}>{String(data.sub)}</div>
      ) : null}
    </div>
  );
});
GroupNode.displayName = 'GroupNode';

const nodeTypes = { base: BaseNode, group: GroupNode };

// ============================================================
// 自动布局:按 group 分区,层次排列
// ============================================================

interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

function autoLayout(topo: TopologyResponse, activeIds: Set<string>, failedId?: string, completedIds?: Set<string>): LayoutResult {
  // 分组布局参数
  const GROUP_POSITIONS: Record<string, { x: number; y: number; w: number; h: number }> = {
    harness: { x: 20, y: 30, w: 680, h: 220 },
    tools: { x: 20, y: 290, w: 680, h: 180 },
    skills: { x: 20, y: 510, w: 680, h: 180 },
    knowledge: { x: 720, y: 30, w: 250, h: 220 },
    ops: { x: 720, y: 290, w: 250, h: 400 },
  };

  const nodes: Node[] = [];

  // 按 group 分桶
  const grouped = new Map<string, TopoNode[]>();
  for (const n of topo.nodes) {
    const g = n.group ?? '__ungrouped';
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(n);
  }

  // 渲染 group 容器节点
  for (const g of topo.groups) {
    const pos = GROUP_POSITIONS[g.id];
    if (!pos) continue;
    // group 是否有活跃子节点
    const children = grouped.get(g.id) ?? [];
    const hasActive = children.some((c) => activeIds.has(c.id));
    const hasCompleted = children.some((c) => completedIds?.has(c.id));
    const glow: Glow = hasActive ? 'active' : hasCompleted ? 'success' : 'idle';

    nodes.push({
      id: `group:${g.id}`,
      type: 'group',
      position: { x: pos.x, y: pos.y },
      data: { label: g.label, sub: g.description, glow, width: pos.w, height: pos.h },
      draggable: false,
      connectable: false,
      selectable: false,
      zIndex: -1,
    });
  }

  // 渲染数据节点(自动在 group 内排列)
  const groupCounters = new Map<string, number>();
  for (const n of topo.nodes) {
    const g = n.group ?? '__ungrouped';
    const pos = GROUP_POSITIONS[g];
    const idx = groupCounters.get(g) ?? 0;
    groupCounters.set(g, idx + 1);

    // 计算节点 glow
    let glow: Glow = 'idle';
    if (failedId === n.id) glow = 'error';
    else if (activeIds.has(n.id)) glow = 'active';
    else if (completedIds?.has(n.id)) glow = 'success';

    // 简单网格布局(每 group 内按列排)
    const cols = g === 'ops' || g === 'knowledge' ? 1 : 4;
    const cellW = pos ? pos.w / cols : 180;
    const cellH = 60;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = (pos?.x ?? 0) + 20 + col * cellW;
    const y = (pos?.y ?? 0) + 40 + row * cellH;

    nodes.push({
      id: n.id,
      type: 'base',
      position: { x, y },
      data: { label: n.label, sub: n.sub, glow, nodeType: n.type },
      draggable: false,
      connectable: false,
      selectable: false,
    });
  }

  // 边
  const edges: Edge[] = topo.edges.map((e) => {
    const isActive = activeIds.has(e.source) || activeIds.has(e.target);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label || undefined,
      animated: isActive,
      type: e.type === 'dependency' ? 'smoothstep' : 'default',
      style: {
        stroke: isActive ? '#7c7cf0' : e.type === 'dependency' ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.15)',
        strokeWidth: isActive ? 2 : 1,
        strokeDasharray: e.type === 'dependency' ? '4 3' : e.type === 'control' ? '6 3' : undefined,
      },
      labelStyle: { fontSize: 8, fill: '#4a5168' },
    };
  });

  return { nodes, edges };
}

// ============================================================
// 从 phase + SSE 事件推导默认活跃节点(无 SSE 时的降级)
// ============================================================
function phaseToDefaultActive(phase: Phase): string[] {
  switch (phase) {
    case 'planning': return ['gateway', 'working-memory', 'llm-agent', 'skill-loader', 'decision-graph', 'knowledge-search'];
    case 'picking':
    case 'selecting': return ['llm-agent', 'reply'];
    case 'planned': return ['reply', 'validator'];
    case 'executing': return ['gateway', 'working-memory', 'llm-agent', 'tool-router', 'skill-loader'];
    case 'paused': return ['tool-router'];
    case 'done': return ['reply', 'trace', 'eval', 'quality-gate', 'report-synth'];
    case 'error': return ['llm-agent'];
    default: return [];
  }
}

// ============================================================
// 主组件
// ============================================================

export function FlowChart({ phase, activeNodeIds, failedNodeId, completedNodeIds, onNodeClick }: FlowChartProps) {
  const [topology, setTopology] = useState<TopologyResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // 从 API 加载拓扑
  useEffect(() => {
    let cancelled = false;
    api.topology()
      .then((topo) => { if (!cancelled) { setTopology(topo); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 计算活跃集合
  const activeSet = useMemo(() => {
    const ids = activeNodeIds?.length ? activeNodeIds : phaseToDefaultActive(phase);
    return new Set(ids);
  }, [activeNodeIds, phase]);

  const completedSet = useMemo(() => new Set(completedNodeIds ?? []), [completedNodeIds]);

  // 布局
  const { nodes, edges } = useMemo(() => {
    if (!topology) return { nodes: [], edges: [] };
    return autoLayout(topology, activeSet, failedNodeId, completedSet);
  }, [topology, activeSet, failedNodeId, completedSet]);

  const onInit = useCallback((instance: ReactFlowInstance) => {
    setTimeout(() => instance.fitView({ padding: 0.08 }), 80);
  }, []);

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type !== 'group' && onNodeClick) {
      onNodeClick(node.id);
    }
  }, [onNodeClick]);

  if (loading) {
    return (
      <section className="stage-card arch-chart" style={{ height: 580, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#6b7488', fontSize: 13 }}>加载架构拓扑...</span>
      </section>
    );
  }

  if (!topology) {
    return (
      <section className="stage-card arch-chart" style={{ height: 580, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#f87171', fontSize: 13 }}>拓扑加载失败</span>
      </section>
    );
  }

  return (
    <section className="stage-card arch-chart" style={{ height: 580, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexShrink: 0 }}>
        <b style={{ fontSize: 13, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#a5adbf' }}>
          Architecture
        </b>
        <span style={{ fontSize: 10, color: '#4a5168' }}>
          — {topology.nodes.length} nodes · {topology.edges.length} edges · live from registry
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, width: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.08, minZoom: 0.3, maxZoom: 1.4 }}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={true}
          zoomOnScroll={true}
          onInit={onInit}
          onNodeClick={handleNodeClick}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={0.8} color="rgba(255,255,255,0.03)" />
        </ReactFlow>
      </div>
    </section>
  );
}
