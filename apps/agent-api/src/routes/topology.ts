import { Router } from 'express';
import {
  loadSkillRegistry,
  loadToolRegistry,
  loadDecisionGraph,
  type SkillRegistryEntry,
  type ToolRegistryEntry,
  type DecisionNode,
} from '../../../orchestrator-runtime/src/runtime/config-loader.ts';

// 架构拓扑 API:从 registry YAML + 运行时模块真实读取,自动生成项目架构图。
// 前端 FlowChart 完全由此接口驱动,不再有硬编码节点。

export const topologyRouter = Router();

// ---- 拓扑节点/边类型 ----
export interface TopoNode {
  id: string;
  type: 'gateway' | 'runtime' | 'tool' | 'skill' | 'knowledge' | 'decision' | 'group';
  label: string;
  sub?: string;
  group?: string;   // 所属分组 ID
  meta?: Record<string, unknown>;
}

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: 'data' | 'control' | 'dependency';
}

export interface TopologyResponse {
  nodes: TopoNode[];
  edges: TopoEdge[];
  groups: Array<{ id: string; label: string; description?: string }>;
}

// ---- 从真实 registry 构建拓扑 ----
function buildTopology(): TopologyResponse {
  const skills = loadSkillRegistry().skills.filter((s) => s.status === 'active');
  const tools = loadToolRegistry().tools.filter((t) => t.status === 'active');
  const decisions = loadDecisionGraph().nodes;

  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];

  // 分组定义
  const groups = [
    { id: 'harness', label: '编排引擎', description: '四段流请求生命周期' },
    { id: 'tools', label: '工具层', description: '外部工具 & 实验室' },
    { id: 'skills', label: '能力层', description: 'Skill 编排单元' },
    { id: 'knowledge', label: '知识底座', description: '决策图 · 语义索引 · 方法论' },
    { id: 'ops', label: '持续优化', description: 'Trace · Eval · Quality Gate' },
  ];

  // ---- 核心运行时节点(固定的系统组件,来自代码模块) ----
  nodes.push(
    { id: 'gateway', type: 'gateway', label: 'Gateway', sub: 'HTTP API · SSE', group: 'harness' },
    { id: 'working-memory', type: 'runtime', label: 'Working Memory', sub: '上下文组装 · 每轮临时', group: 'harness' },
    { id: 'llm-agent', type: 'runtime', label: 'LLM Agent', sub: 'gateway-llm-client', group: 'harness' },
    { id: 'skill-loader', type: 'runtime', label: 'Skill Loader', sub: '三层渐进加载', group: 'harness' },
    { id: 'tool-router', type: 'runtime', label: 'Tool Router', sub: 'ToolAdapter 分发', group: 'harness' },
    { id: 'reply', type: 'runtime', label: 'Reply', sub: '→ 返回用户', group: 'harness' },
    { id: 'checkpoint', type: 'runtime', label: 'Checkpoint Store', sub: 'DB 落库 · 断点恢复', group: 'harness' },
    { id: 'validator', type: 'runtime', label: 'Schema Validator', sub: 'AJV · 数据质门', group: 'harness' },
  );

  // OPS 区
  nodes.push(
    { id: 'trace', type: 'runtime', label: 'Trace', sub: 'execution_log', group: 'ops' },
    { id: 'eval', type: 'runtime', label: 'Eval', sub: 'schema 校验', group: 'ops' },
    { id: 'quality-gate', type: 'runtime', label: 'Quality Gate', sub: '数据质门拦截', group: 'ops' },
    { id: 'report-synth', type: 'runtime', label: 'Report Synth', sub: '报告合成', group: 'ops' },
  );

  // ---- 知识底座节点(动态:从 decision-graph 读) ----
  nodes.push(
    { id: 'decision-graph', type: 'knowledge', label: '决策图', sub: `${decisions.length} 决策节点`, group: 'knowledge' },
    { id: 'knowledge-search', type: 'knowledge', label: '知识检索', sub: 'FTS5 · 语义索引', group: 'knowledge' },
    { id: 'methodology', type: 'knowledge', label: '方法论库', sub: 'YAML · Markdown', group: 'knowledge' },
  );

  // ---- Tool 节点(完全动态:从 tool-registry.yaml 读) ----
  for (const t of tools) {
    nodes.push({
      id: `tool:${t.id}`,
      type: 'tool',
      label: t.name,
      sub: t.adapter_type,
      group: 'tools',
      meta: { adapter_type: t.adapter_type, auth_required: t.auth_required, risk_level: t.risk_level },
    });
    // tool → tool-router 边
    edges.push({ id: `e-router-${t.id}`, source: 'tool-router', target: `tool:${t.id}`, label: t.adapter_type, type: 'control' });
  }

  // ---- Skill 节点(完全动态:从 skill-registry.yaml 读) ----
  for (const s of skills) {
    nodes.push({
      id: `skill:${s.id}`,
      type: 'skill',
      label: s.name,
      sub: (s.domain ?? []).join(' · ') || undefined,
      group: 'skills',
      meta: { task_types: s.task_types, intent_tags: s.intent_tags, risk_level: s.risk_level, required_tools: s.required_tools },
    });
    // skill → skill-loader 边
    edges.push({ id: `e-loader-${s.id}`, source: 'skill-loader', target: `skill:${s.id}`, label: '', type: 'control' });
    // skill → required_tools 依赖边
    for (const toolId of s.required_tools ?? []) {
      if (tools.some((t) => t.id === toolId)) {
        edges.push({ id: `e-dep-${s.id}-${toolId}`, source: `skill:${s.id}`, target: `tool:${toolId}`, label: 'uses', type: 'dependency' });
      }
    }
  }

  // ---- 核心数据流边(系统固定流向) ----
  edges.push(
    { id: 'e-gw-wm', source: 'gateway', target: 'working-memory', label: 'request', type: 'data' },
    { id: 'e-wm-llm', source: 'working-memory', target: 'llm-agent', label: 'context', type: 'data' },
    { id: 'e-llm-skill', source: 'llm-agent', target: 'skill-loader', label: 'route skill', type: 'control' },
    { id: 'e-llm-tool', source: 'llm-agent', target: 'tool-router', label: 'invoke tool', type: 'control' },
    { id: 'e-llm-reply', source: 'llm-agent', target: 'reply', label: 'reply', type: 'data' },
    // Knowledge ↔ Working Memory
    { id: 'e-wm-dg', source: 'working-memory', target: 'decision-graph', label: 'activate nodes', type: 'control' },
    { id: 'e-wm-ks', source: 'working-memory', target: 'knowledge-search', label: 'retrieve', type: 'data' },
    { id: 'e-ks-meth', source: 'knowledge-search', target: 'methodology', label: 'full-text', type: 'data' },
    // Checkpoint & Validator
    { id: 'e-llm-cp', source: 'llm-agent', target: 'checkpoint', label: 'persist', type: 'data' },
    { id: 'e-llm-val', source: 'llm-agent', target: 'validator', label: 'validate', type: 'control' },
    // OPS chain
    { id: 'e-cp-trace', source: 'checkpoint', target: 'trace', label: 'log', type: 'data' },
    { id: 'e-trace-eval', source: 'trace', target: 'eval', label: '', type: 'data' },
    { id: 'e-eval-qg', source: 'eval', target: 'quality-gate', label: '', type: 'data' },
    { id: 'e-qg-report', source: 'quality-gate', target: 'report-synth', label: '', type: 'data' },
    { id: 'e-report-reply', source: 'report-synth', target: 'reply', label: 'final report', type: 'data' },
  );

  return { nodes, edges, groups };
}

topologyRouter.get('/', (_req, res) => {
  try {
    const topo = buildTopology();
    res.json(topo);
  } catch (err) {
    res.status(500).json({ error: `拓扑构建失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});
