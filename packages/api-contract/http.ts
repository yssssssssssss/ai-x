// 前后端共享契约 —— HTTP 响应壳(agent-api route 层的返回形状)。
// 窄类型:只描述前端真正消费的字段,不引用 database 层的 row 类型。
// route 的 res.json(dbRow) 靠 TS 结构化子类型兼容这些窄壳(多余字段允许),
// 从而 route 与前端共享同一份响应契约,漂移在编译期就炸。

import type {
  ResearchTaskData,
  ResearchTaskV2,
  PlanStep,
  PlanCandidate,
  Assumption,
  PendingUpload,
} from './plan.ts';

export interface User {
  id: string;
  email: string;
  display_name: string;
  role?: string;
}

export interface Upload {
  role: string;
  dataUrl: string;
}

export interface Finding {
  id: string;
  statement: string;
  source: string;
  source_ref?: string;
}

export interface Analysis {
  statement: string;
  based_on: string[];
}

export interface SubQuestion {
  question: string;
  finding_ids: string[];
  analysis: Analysis[];
  summary: string;
}

export interface Report {
  research_goal: string;
  method_summary: string;
  findings: Finding[];
  sub_questions: SubQuestion[];
  overall_conclusion: string[];
  timeline: Array<{ phase: string; activity: string }>;
  deliverables: string[];
  capability_orchestration: Array<{ capability_id: string; capability_type: string; purpose: string }>;
  risks_and_open_issues?: string[];
}

export interface ExecLogRow {
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
  status: string;
  skillProvenance: Record<string, unknown> | null;
  failure?: Record<string, unknown>;
}

// 已 finalize 的计划:steps + 激活节点 + 假设(select/execute 前的形态)。
export interface FinalizedPlan {
  steps: PlanStep[];
  activated_nodes: string[];
  assumptions: Assumption[];
}

export interface PlanCandidatesResponse {
  conversationId: string;
  taskId: string;
  task: ResearchTaskData;
  activatedNodes: string[];
  candidates: PlanCandidate[];
}

export interface SelectResponse {
  taskId: string;
  candidateId: 'depth' | 'speed';
  plan: FinalizedPlan;
  pendingUploads: PendingUpload[];
}

// finalize 后的完整计划视图(候选选定 → 确认执行之间的形态,Stage2Plan 消费)。
export interface PlanResponse {
  conversationId: string;
  taskId: string;
  task: ResearchTaskData | ResearchTaskV2;
  activatedNodes: string[];
  plan: FinalizedPlan;
  pendingUploads: PendingUpload[];
}

export interface ExecuteResponse {
  taskId: string;
  status?: 'completed' | 'completed_with_gaps' | 'paused' | 'failed';
  reportArtifactId: string | null;
  failedStepNo?: number | null;
  failedStepName?: string | null;
  gapCount?: number;
  executionLog: ExecLogRow[];
  report: Report | null;
}

export interface TaskDetail {
  task: { id: string; original_input: string; task_type: string | null; structured_task: ResearchTaskData; status: string };
  decisionStates: Array<{ node_key: string }>;
  executionLog: ExecLogRow[];
  report: Report | null;
}

export interface TaskSummary {
  id: string;
  original_input: string;
  task_type: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  task_types: string[];
}
