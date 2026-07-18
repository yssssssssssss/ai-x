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
  role: string; label: string; multiple: boolean;
  targets: Array<{ step_no: number; tool_id: string; field: string; multiple: boolean }>;
}
export interface Upload { role: string; dataUrl: string; }
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
export interface Report {
  research_goal: string; findings: Finding[];
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
  planStream: async (
    b: { originalInput: string; conversationId?: string },
    onEvent: (type: string, data: Record<string, unknown>) => void,
  ): Promise<void> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch('/api/tasks/plan/stream', { method: 'POST', headers, body: JSON.stringify(b) });
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
  },
  selectCandidate: (taskId: string, candidateId: 'depth' | 'speed') =>
    req<SelectResponse>(`/tasks/${taskId}/select`, { method: 'POST', body: { candidateId } }),
  execute: (taskId: string, uploads?: Upload[]) =>
    req<ExecuteResponse>(`/tasks/${taskId}/execute`, { method: 'POST', body: uploads?.length ? { uploads } : {} }),
  resume: (taskId: string, action: 'skip' | 'abort') =>
    req<ExecuteResponse>(`/tasks/${taskId}/resume`, { method: 'POST', body: { action } }),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/tasks'),
  taskDetail: (id: string) =>
    req<TaskDetail>(`/tasks/${id}`),
  feedback: (id: string, b: { rating?: number; adopted?: boolean; comment?: string }) =>
    req<{ id: string }>(`/tasks/${id}/feedback`, { method: 'POST', body: b }),
  skills: () => req<{ skills: SkillItem[] }>('/skills'),
};

export interface SkillItem { id: string; name: string; description: string; domain: string[]; }
