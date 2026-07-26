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

// ---- 类型 ----
// 契约类型集中在 packages/api-contract(前后端共享同一份,漂移编译期即炸)。
// 这里 re-export,让前端各组件的 import 路径('./api/client.ts')保持不变。
export type {
  Assumption,
  PlanStep,
  ResearchTaskData,
  PendingUpload,
  PlanCandidate,
  PlanPhaseKey,
  PlanProgress,
} from '../../../../packages/api-contract/plan.ts';
export type {
  User,
  Upload,
  Finding,
  Report,
  ExecLogRow,
  FinalizedPlan,
  PlanCandidatesResponse,
  SelectResponse,
  PlanResponse,
  ExecuteResponse,
  TaskDetail,
  TaskSummary,
  SkillItem,
} from '../../../../packages/api-contract/http.ts';

// api 方法体实际引用的类型(export type 只做 re-export、不引入本地绑定,故这里单独 import)。
import type {
  User,
  Upload,
  PlanCandidatesResponse,
  SelectResponse,
  ExecuteResponse,
  TaskDetail,
  TaskSummary,
  SkillItem,
} from '../../../../packages/api-contract/http.ts';

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
