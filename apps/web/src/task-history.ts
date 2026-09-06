import type {
  SkillNativeTaskState,
  SkillNativeTaskSummary,
} from '../../../packages/api-contract/skill-native.ts';
import type { TaskHistoryPreference } from '../../../packages/api-contract/http.ts';

export interface HistoryTaskSummary extends SkillNativeTaskSummary {
  kind: 'native';
  displayName?: string | null;
  pinnedAt?: string | null;
}

export type TaskHistoryGroup = 'pending' | 'running' | 'completed' | 'failed';
export type TaskStateTone = 'action' | 'running' | 'success' | 'warning' | 'danger' | 'muted';

export interface TaskStatePresentation {
  label: string;
  group: TaskHistoryGroup;
  tone: TaskStateTone;
}

const PRESENTATIONS: Record<SkillNativeTaskState, TaskStatePresentation> = {
  awaiting_selection: { label: '待选方案', group: 'pending', tone: 'action' },
  awaiting_confirmation: { label: '待确认', group: 'pending', tone: 'action' },
  ready: { label: '待执行', group: 'pending', tone: 'action' },
  executing: { label: '执行中', group: 'running', tone: 'running' },
  waiting_for_user: { label: '待补充', group: 'pending', tone: 'action' },
  paused: { label: '已暂停', group: 'pending', tone: 'warning' },
  completed: { label: '已完成', group: 'completed', tone: 'success' },
  completed_with_gaps: { label: '已完成·有缺口', group: 'completed', tone: 'warning' },
  failed: { label: '失败', group: 'failed', tone: 'danger' },
  cancelled: { label: '已取消', group: 'failed', tone: 'muted' },
};

export function historyTaskPresentation(task: HistoryTaskSummary): TaskStatePresentation {
  return PRESENTATIONS[task.state];
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function applyTaskHistoryPreferences(
  tasks: SkillNativeTaskSummary[],
  preferences: TaskHistoryPreference[],
): HistoryTaskSummary[] {
  const byTaskId = new Map(
    preferences
      .filter(({ taskKind }) => taskKind === 'native')
      .map((preference) => [preference.taskId, preference]),
  );
  return tasks.flatMap((task): HistoryTaskSummary[] => {
    const preference = byTaskId.get(task.id);
    if (preference?.hiddenAt) return [];
    return [{
      ...task,
      kind: 'native',
      ...(preference ? {
        displayName: preference.displayName,
        pinnedAt: preference.pinnedAt,
      } : {}),
    }];
  }).sort((left, right) => {
    if (left.pinnedAt && !right.pinnedAt) return -1;
    if (!left.pinnedAt && right.pinnedAt) return 1;
    if (left.pinnedAt && right.pinnedAt) {
      const order = timestamp(right.pinnedAt) - timestamp(left.pinnedAt);
      if (order !== 0) return order;
    }
    return timestamp(right.updatedAt) - timestamp(left.updatedAt);
  });
}
