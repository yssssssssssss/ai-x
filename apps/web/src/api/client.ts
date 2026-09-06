const TOKEN_KEY = 'ur_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function authorizationHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders() },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return body as T;
}

async function requestFile(path: string): Promise<Response> {
  const response = await fetch(`/api${path}`, { headers: authorizationHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    throw new ApiError(
      response.status,
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return response;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export type {
  SkillItem,
  TaskHistoryKind,
  TaskHistoryPreference,
  TaskHistoryPreferencePatch,
  User,
} from '../../../../packages/api-contract/http.ts';
export type { SystemCapabilitiesResponse } from '../../../../packages/api-contract/system-capabilities.ts';
export type {
  ConfirmSkillNativeTaskRequest,
  CreateSkillNativeTaskRequest,
  OrchestrationMode,
  PublishSkillNativeReportRequest,
  ResumeSkillNativeTaskRequest,
  SkillNativeCandidateView,
  SkillNativeCatalogResponse,
  SkillNativeInputAnswer,
  SkillNativePlanView,
  SkillNativeTaskState,
  SkillNativeTaskSummary,
  SkillNativeTaskView,
  SkillNativeZeroPublication,
} from '../../../../packages/api-contract/skill-native.ts';

import type {
  TaskHistoryKind,
  TaskHistoryPreference,
  TaskHistoryPreferencePatch,
  User,
} from '../../../../packages/api-contract/http.ts';
import type { SystemCapabilitiesResponse } from '../../../../packages/api-contract/system-capabilities.ts';
import type {
  ConfirmSkillNativeTaskRequest,
  CreateSkillNativeTaskRequest,
  PublishSkillNativeReportRequest,
  ResumeSkillNativeTaskRequest,
  SkillNativeCatalogResponse,
  SkillNativeTaskSummary,
  SkillNativeTaskView,
  SkillNativeZeroPublication,
} from '../../../../packages/api-contract/skill-native.ts';

export const api = {
  systemCapabilities: () => requestJson<SystemCapabilitiesResponse>('/system/capabilities'),
  authMethods: () => requestJson<{ quickLogin: boolean }>('/auth/methods'),
  quickLogin: () => requestJson<{ token: string; user: User }>('/auth/quick-login', { method: 'POST' }),
  register: (body: { email: string; password: string; displayName: string }) => (
    requestJson<{ token: string; user: User }>('/auth/register', { method: 'POST', body })
  ),
  login: (body: { email: string; password: string }) => (
    requestJson<{ token: string; user: User }>('/auth/login', { method: 'POST', body })
  ),
  me: () => requestJson<{ user: User }>('/auth/me'),

  createResearchTask: (body: CreateSkillNativeTaskRequest) => (
    requestJson<SkillNativeTaskView>('/research-tasks', { method: 'POST', body })
  ),
  listResearchTasks: () => requestJson<{ tasks: SkillNativeTaskSummary[] }>('/research-tasks'),
  researchCatalog: () => requestJson<SkillNativeCatalogResponse>('/research-tasks/catalog'),
  researchTask: (taskId: string) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}`)
  ),
  selectResearchSolution: (taskId: string, body: { expectedVersion: number; candidateId: string }) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}/select`, { method: 'POST', body })
  ),
  confirmResearchTask: (taskId: string, body: ConfirmSkillNativeTaskRequest) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}/confirm`, { method: 'POST', body })
  ),
  executeResearchTask: (taskId: string, expectedVersion: number) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}/execute`, {
      method: 'POST', body: { expectedVersion },
    })
  ),
  cancelResearchTask: (taskId: string, expectedVersion: number) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST', body: { expectedVersion },
    })
  ),
  resumeResearchTask: (taskId: string, body: ResumeSkillNativeTaskRequest) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST', body })
  ),
  replanResearchTask: (taskId: string, expectedVersion: number) => (
    requestJson<SkillNativeTaskView>(`/research-tasks/${encodeURIComponent(taskId)}/replan`, {
      method: 'POST', body: { expectedVersion },
    })
  ),
  publishResearchTaskToZero: (taskId: string, body: PublishSkillNativeReportRequest) => (
    requestJson<SkillNativeZeroPublication>(`/research-tasks/${encodeURIComponent(taskId)}/publications/zero`, {
      method: 'POST', body,
    })
  ),
  researchReportHtml: async (taskId: string) => (
    requestFile(`/research-tasks/${encodeURIComponent(taskId)}/report.html`).then((response) => response.text())
  ),
  researchReportMarkdown: async (taskId: string) => (
    requestFile(`/research-tasks/${encodeURIComponent(taskId)}/report.md`).then((response) => response.blob())
  ),

  listTaskHistoryPreferences: () => (
    requestJson<{ preferences: TaskHistoryPreference[] }>('/task-history')
  ),
  updateTaskHistoryPreference: (
    kind: TaskHistoryKind,
    taskId: string,
    body: TaskHistoryPreferencePatch,
  ) => requestJson<{ preference: TaskHistoryPreference }>(
    `/task-history/${kind}/${encodeURIComponent(taskId)}`,
    { method: 'PATCH', body },
  ),
};
