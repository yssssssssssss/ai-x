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
export interface PlanResponse {
  conversationId: string; taskId: string;
  task: ResearchTask; activatedNodes: string[];
  plan: { steps: PlanStep[]; activated_nodes: string[]; assumptions: Assumption[] };
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
  taskId: string; reportArtifactId: string; executionLog: ExecLogRow[]; report: Report | null;
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
    req<PlanResponse>('/tasks/plan', { method: 'POST', body: b }),
  execute: (taskId: string) =>
    req<ExecuteResponse>(`/tasks/${taskId}/execute`, { method: 'POST' }),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/tasks'),
  taskDetail: (id: string) =>
    req<{ task: unknown; decisionStates: unknown[]; executionLog: ExecLogRow[]; report: Report | null }>(`/tasks/${id}`),
  feedback: (id: string, b: { rating?: number; adopted?: boolean; comment?: string }) =>
    req<{ id: string }>(`/tasks/${id}/feedback`, { method: 'POST', body: b }),
};
