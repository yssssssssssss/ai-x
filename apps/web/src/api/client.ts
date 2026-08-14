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

async function req<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
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
  ResearchTaskV2,
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

import type {
  CurrentPlanningResponse,
} from '../../../agent-api/src/routes/control-planning.ts';

export type {
  ApprovalControlPlanRequest,
  ConfirmControlPlanRequest,
  ControlCommandResponse,
  ControlExecutionResult,
  ControlPlanCandidatesResponse,
  ControlTaskResponse,
  ControlWorkflowState as ControlTaskState,
  CurrentTaskReadResponse,
  CurrentPlanCandidate,
  ExecutionControlPlanRequest,
  PlanControlTaskRequest,
  ResumeControlPlanRequest,
  SelectControlPlanRequest,
  SelectControlPlanResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
export type {
  CapabilityProvenance,
  CurrentRecommendation,
  EvidenceEntry,
  FindingGraph,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../../../../packages/api-contract/research-deliverable.ts';
export type { ClarificationRequiredResponse, CurrentPlanningResponse } from '../../../agent-api/src/routes/control-planning.ts';

import type {
  ApprovalControlPlanRequest,
  ConfirmControlPlanRequest,
  ControlCommandResponse,
  ControlExecutionResult,
  CurrentTaskReadResponse,
  ExecutionControlPlanRequest,
  PlanControlTaskRequest,
  ResumeControlPlanRequest,
  SelectControlPlanRequest,
  SelectControlPlanResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { EvidenceManifest } from '../../../orchestrator-runtime/src/evidence/evidence-service.ts';
import type { PlanProgress } from '../../../../packages/api-contract/plan.ts';
import type { User, TaskDetail, TaskSummary, SkillItem } from '../../../../packages/api-contract/http.ts';

export interface ControlDeliverableResponse {
  deliverable: ResearchDeliverableEnvelope<ResearchPlanPayload>;
  evidenceManifest: EvidenceManifest;
}

export interface ClarifyControlTaskRequest {
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
  idempotencyKey: string;
}

export const api = {
  register: (b: { email: string; password: string; displayName: string }) =>
    req<{ token: string; user: User }>('/auth/register', { method: 'POST', body: b }),
  login: (b: { email: string; password: string }) =>
    req<{ token: string; user: User }>('/auth/login', { method: 'POST', body: b }),
  me: () => req<{ user: User }>('/auth/me'),
  // Current 规划流:SSE conversation/progress/result/error 在 client 层收口。
  planControlStream: async (
    body: PlanControlTaskRequest,
    handlers: {
      onConversation?: (conversationId: string) => void;
      onProgress?: (event: PlanProgress) => void;
    } = {},
  ): Promise<CurrentPlanningResponse> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch('/api/control-tasks/plan/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) throw new ApiError(response.status, `HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: CurrentPlanningResponse | null = null;
    const consume = (block: string): void => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) return;
      const parsed: unknown = JSON.parse(data);
      if (event === 'conversation') {
        const conversation = parsed as { conversationId?: unknown };
        if (typeof conversation.conversationId === 'string') handlers.onConversation?.(conversation.conversationId);
      } else if (event === 'progress') {
        handlers.onProgress?.(parsed as PlanProgress);
      } else if (event === 'result') {
        result = parsed as CurrentPlanningResponse;
      } else if (event === 'error') {
        const failure = parsed as { error?: unknown };
        throw new ApiError(502, typeof failure.error === 'string' ? failure.error : '规划失败');
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      buffer = `${buffer}${decoder.decode(value, { stream: !done })}`.replaceAll('\r\n', '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        consume(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!result) throw new ApiError(502, '规划未返回结果');
    return result;
  },
  clarifyControlTask: (
    taskId: string,
    body: ClarifyControlTaskRequest,
  ) => req<CurrentPlanningResponse>(`/control-tasks/${taskId}/clarify`, {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': body.idempotencyKey },
  }),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/tasks'),
  taskDetail: (id: string) =>
    req<TaskDetail>(`/tasks/${id}`),
  feedback: (id: string, b: { rating?: number; adopted?: boolean; comment?: string }) =>
    req<{ id: string }>(`/tasks/${id}/feedback`, { method: 'POST', body: b }),
  skills: () => req<{ skills: SkillItem[] }>('/skills'),
  controlTask: (taskId: string) =>
    req<CurrentTaskReadResponse>(`/control-tasks/${taskId}`),
  selectControlPlan: (taskId: string, body: SelectControlPlanRequest) =>
    req<SelectControlPlanResponse>(`/control-tasks/${taskId}/select`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  confirmControlPlan: (taskId: string, body: ConfirmControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/confirm`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  approveControlPlan: (taskId: string, body: ApprovalControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/approve`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  resumeControlPlan: (taskId: string, body: ResumeControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/resume`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  executeControlPlan: (taskId: string, body: ExecutionControlPlanRequest) =>
    req<ControlExecutionResult>(`/control-tasks/${taskId}/execute`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  controlDeliverable: (taskId: string) =>
    req<ControlDeliverableResponse>(`/control-tasks/${taskId}/deliverable`),
};
