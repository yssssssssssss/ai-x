// API client:fetch 封装 + JWT header + 错误处理。
// 与 agent-api 契约对齐(见 apps/agent-api/src/routes/*)。

const TOKEN_KEY = 'ur_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

async function postStream(
  path: string,
  body: unknown,
  onEvent: (type: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok || !res.body) throw new ApiError(res.status, `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// ---- 类型(与后端返回对齐)----
export interface User { id: string; email: string; display_name: string; role?: string; }
export interface Assumption { key: string; value: string; editable: boolean; }
export interface PlanStep {
  step_no: number; step_name: string;
  actor_type: 'skill' | 'tool' | 'llm' | 'reviewer'; actor_id: string;
  purpose?: string; requires_approval?: boolean;
}
export interface ResearchTask {
  task_type: string; business_domain: string; research_goal: string;
  assumptions: Assumption[]; confirmations: unknown[]; blocking_issues: unknown[];
  sensitivity: string; pii_detected: boolean;
}
export interface PendingUpload {
  role: string; label: string; multiple: boolean; required: boolean;
  minItems: number; maxItems: number; acceptedMimeTypes: string[];
  targets: Array<{ step_no: number; tool_id: string; field: string; multiple: boolean }>;
}
export interface MediaAssetRef {
  id: string; role: string; mimeType: string; bytes: number; sha256: string; fileName?: string; createdAt: string;
}
export interface Upload { role: string; assetId: string; }
export interface PlanCandidate {
  id: 'depth' | 'speed';
  title: string;
  rationale: string;
  tradeoffs: string;
  steps: PlanStep[];
  assumptions: Assumption[];
  activated_nodes: string[];
}
export interface PlanCandidatesResponse {
  conversationId: string; taskId: string;
  task: ResearchTask; activatedNodes: string[];
  candidates: PlanCandidate[];
}
export interface PlanProgress {
  phase: 'understand' | 'activate' | 'guidance' | 'states' | 'candidates' | 'persist';
  status: 'start' | 'done';
  label: string;
  detail?: string;
}
export interface ExecuteProgress {
  type: 'step_started' | 'step_succeeded' | 'step_failed' | 'step_skipped' | 'synthesis_started' | 'completed' | 'paused' | 'failed';
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'completed' | 'completed_with_gaps' | 'paused';
  stepNo?: number;
  stepName?: string;
  actorType?: PlanStep['actor_type'];
  actorId?: string;
  detail?: string;
}
export interface PlanResponse {
  conversationId: string; taskId: string;
  task: ResearchTask; activatedNodes: string[];
  plan: { steps: PlanStep[]; activated_nodes: string[]; assumptions: Assumption[] };
  pendingUploads: PendingUpload[];
}
export interface SelectResponse {
  taskId: string; candidateId: 'depth' | 'speed';
  plan: { steps: PlanStep[]; activated_nodes: string[]; assumptions: Assumption[] };
  pendingUploads: PendingUpload[];
}
export interface Finding { statement: string; source: string; source_ref?: string; }
export interface CoreIssue {
  title: string;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  impact?: string;
  evidence_source?: string;
  evidence_basis?: 'evidence' | 'inference';
  evidence_refs?: string[];
  recommendation?: string;
}
export interface DimensionAnalysis { dimension: string; status: 'complete' | 'partial' | 'data_incomplete'; summary: string; metrics?: Record<string, number>; data_source?: string; image_ref?: string; }
export interface Recommendation {
  priority: 'P0' | 'P1' | 'P2';
  action: string;
  expected_impact: string;
  validation: string;
  evidence_basis: 'evidence' | 'inference';
  evidence_refs?: string[];
}
export interface ReportMetadata {
  version: '2.0';
  task_type: string;
  blueprint_id: string;
  generation_mode: 'production' | 'mock_demo';
  evidence_ledger_ref: string;
}
export interface EvidenceSummary {
  ledger_entry_count: number;
  source_count: number;
  cited_evidence_count: number;
  limitations: string[];
}
export interface Report {
  research_goal: string; findings: Finding[];
  executive_summary?: string;
  core_issues?: CoreIssue[];
  dimension_analyses?: DimensionAnalysis[];
  recommendations?: Recommendation[];
  report_metadata?: ReportMetadata;
  evidence_summary?: EvidenceSummary;
  timeline: Array<{ phase: string; activity: string }>;
  deliverables: string[];
  capability_orchestration: Array<{ capability_id: string; capability_type: string; purpose: string }>;
  risks_and_open_issues?: string[];
}
export interface ExecLogRow {
  step_no: number; step_name: string; actor_type: string; actor_id: string; status: string;
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
  task: { id: string; original_input: string; task_type: string | null; structured_task: ResearchTask; status: string };
  decisionStates: Array<{ node_key: string }>;
  executionLog: ExecLogRow[];
  report: Report | null;
}
export interface TaskSummary {
  id: string; original_input: string; task_type: string | null; status: string; created_at?: string;
}

// ---- API ----
export const api = {
  register: (b: { email: string; password: string; displayName: string }) =>
    req<{ token: string; user: User }>('/auth/register', { method: 'POST', body: b }),
  login: (b: { email: string; password: string }) =>
    req<{ token: string; user: User }>('/auth/login', { method: 'POST', body: b }),
  me: () => req<{ user: User }>('/auth/me'),

  plan: (b: { originalInput: string; conversationId?: string }) =>
    req<PlanCandidatesResponse>('/tasks/plan', { method: 'POST', body: b }),
  // 流式规划:SSE 逐阶段回调 onEvent(type, data);type ∈ conversation|progress|result|error。
  planStream: (b: { originalInput: string; conversationId?: string }, onEvent: (type: string, data: Record<string, unknown>) => void) =>
    postStream('/tasks/plan/stream', b, onEvent),
  selectCandidate: (taskId: string, candidateId: 'depth' | 'speed') =>
    req<SelectResponse>(`/tasks/${taskId}/select`, { method: 'POST', body: { candidateId } }),
  uploadMedia: async (taskId: string, role: string, file: File): Promise<MediaAssetRef> => {
    const headers: Record<string, string> = {
      'Content-Type': file.type,
      'X-Media-Role': role,
      'X-File-Name': encodeURIComponent(file.name),
    };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api/tasks/${taskId}/media`, { method: 'POST', headers, body: file });
    const data = await res.json().catch(() => ({})) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as MediaAssetRef;
  },
  execute: (taskId: string, uploads?: Upload[]) =>
    req<ExecuteResponse>(`/tasks/${taskId}/execute`, { method: 'POST', body: uploads?.length ? { uploads } : {} }),
  executeStream: (taskId: string, uploads: Upload[] | undefined, onEvent: (type: string, data: Record<string, unknown>) => void) =>
    postStream(`/tasks/${taskId}/execute/stream`, uploads?.length ? { uploads } : {}, onEvent),
  resume: (taskId: string, action: 'skip' | 'abort') =>
    req<ExecuteResponse>(`/tasks/${taskId}/resume`, { method: 'POST', body: { action } }),
  resumeStream: (taskId: string, action: 'skip' | 'abort', onEvent: (type: string, data: Record<string, unknown>) => void) =>
    postStream(`/tasks/${taskId}/resume/stream`, { action }, onEvent),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/tasks'),
  taskDetail: (id: string) =>
    req<TaskDetail>(`/tasks/${id}`),
  feedback: (id: string, b: { rating?: number; adopted?: boolean; comment?: string }) =>
    req<{ id: string }>(`/tasks/${id}/feedback`, { method: 'POST', body: b }),
  skills: () => req<{ skills: SkillItem[] }>('/skills'),
  topology: () => req<TopologyResponse>('/topology'),
  reportHtmlUrl: (taskId: string) => `/api/tasks/${taskId}/report.html`,
};

export interface SkillItem { id: string; name: string; description: string; domain: string[]; }

// ---- 架构拓扑类型(与后端 topology.ts 对齐) ----
export interface TopoNode {
  id: string;
  type: 'gateway' | 'runtime' | 'tool' | 'skill' | 'knowledge' | 'decision' | 'group';
  label: string;
  sub?: string;
  group?: string;
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
