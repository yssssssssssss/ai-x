export interface User {
  id: string;
  email: string;
  display_name: string;
  role?: string;
}

export type TaskHistoryKind = 'native';

export interface TaskHistoryPreference {
  taskId: string;
  taskKind: TaskHistoryKind;
  displayName: string | null;
  pinnedAt: string | null;
  hiddenAt: string | null;
  updatedAt: string;
}

export interface TaskHistoryPreferencePatch {
  displayName?: string | null;
  pinned?: boolean;
  hidden?: boolean;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  task_types: string[];
}
