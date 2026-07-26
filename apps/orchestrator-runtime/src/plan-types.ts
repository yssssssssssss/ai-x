// Public plan/execute 类型 —— orchestrator 对外契约。
// 拆出的目的:让 ActorRunner 接口与外部消费方(spike 脚本/tests)引用同一份类型,
// 而不用回过头 import orchestrator.ts(它内部会依赖 runner)。

export interface GuidanceRef {
  node: string;
  id: string;
  title: string;
  summary: string;
  source_path: string;
  content_hash: string;
}

export interface ResearchTaskData {
  task_type: string;
  business_domain: string;
  research_goal: string;
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
  confirmations: unknown[];
  blocking_issues: unknown[];
  sensitivity: string;
  pii_detected: boolean;
}

export interface PendingUpload {
  role: string;
  label: string;
  multiple: boolean;
  targets: Array<{ step_no: number; tool_id: string; field: string; multiple: boolean }>;
}

export interface PlanStep {
  step_no: number;
  step_name: string;
  actor_type: 'skill' | 'tool' | 'llm' | 'reviewer';
  actor_id: string;
  purpose?: string;
  input?: Record<string, unknown>;
  requires_approval?: boolean;
}

export interface PlanCandidate {
  id: 'depth' | 'speed';
  title: string;
  rationale: string;
  tradeoffs: string;
  steps: PlanStep[];
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
  activated_nodes: string[];
}

export interface PlanResult {
  taskId: string;
  task: ResearchTaskData;
  activatedNodes: string[];
  candidates: PlanCandidate[];
  workspaceUri: string;
}

export type PlanPhaseKey = 'understand' | 'activate' | 'guidance' | 'states' | 'candidates' | 'persist';
export interface PlanProgress {
  phase: PlanPhaseKey;
  status: 'start' | 'done';
  label: string;
  detail?: string;
}

export interface SelectResult {
  taskId: string;
  candidateId: PlanCandidate['id'];
  plan: unknown;
  pendingUploads: PendingUpload[];
}

// executePhase / resumePhase 的返回:paused=停在失败步待用户决策;completed_with_gaps=有缺口但已合成。
export interface ExecuteResult {
  status: 'completed' | 'completed_with_gaps' | 'paused' | 'failed';
  reportArtifactId?: string;
  failedStepNo?: number;
  failedStepName?: string;
  gapCount?: number;
}
