import type { User } from '../api/client.ts';
import {
  taskStatePresentation,
  type HistoryTaskSummary,
  type TaskHistoryGroup,
  type TaskStatePresentation,
} from '../current-flow-state.ts';

const HISTORY_GROUPS: Array<{ id: TaskHistoryGroup; label: string }> = [
  { id: 'action', label: '需要你处理' },
  { id: 'running', label: '进行中' },
  { id: 'finished', label: '已结束' },
];

function historyPresentation(task: HistoryTaskSummary): TaskStatePresentation {
  if (task.kind === 'current') {
    try {
      return taskStatePresentation(task.status);
    } catch {
      return { label: '状态异常', group: 'finished', tone: 'danger' };
    }
  }
  if (task.status === 'completed') return { label: '历史·已完成', group: 'finished', tone: 'success' };
  if (task.status === 'failed') return { label: '历史·失败', group: 'finished', tone: 'danger' };
  return { label: `历史·${task.status}`, group: 'finished', tone: 'muted' };
}

// 左侧栏:新建任务 + 历史任务 + 工具箱入口 + 用户/登出。
export function Sidebar({
  user, history, activeTaskId, onNewTask, onOpenLabs, onOpenTask, onLogout,
}: {
  user: User;
  history: HistoryTaskSummary[];
  activeTaskId: string | null;
  onNewTask: () => void;
  onOpenLabs: () => void;
  onOpenTask: (id: string) => void;
  onLogout: () => void;
}) {
  return (
    <aside style={{ background: 'var(--bg-elev)', borderRight: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 16 }}>
        <button className="btn-primary" style={{ width: '100%' }} onClick={onNewTask}>+ 新建任务</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
        <SectionLabel>任务记录</SectionLabel>
        {history.length === 0 && <Empty>暂无历史</Empty>}
        {HISTORY_GROUPS.map((group) => {
          const tasks = history.filter((task) => historyPresentation(task).group === group.id);
          if (tasks.length === 0) return null;
          return (
            <section key={group.id} className="history-task-group" aria-label={group.label}>
              <div className="history-task-group-label">
                <span>{group.label}</span>
                <span className="history-task-count">{tasks.length}</span>
              </div>
              {tasks.map((task) => {
                const presentation = historyPresentation(task);
                const active = task.kind === 'current' && task.id === activeTaskId;
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={`history-task${active ? ' is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onOpenTask(task.id)}
                    title={task.original_input}
                  >
                    <span className="history-task-title">{task.original_input}</span>
                    <span className="history-task-meta">
                      <span className={`history-status-dot tone-${presentation.tone}`} aria-hidden="true" />
                      <span>{presentation.label}</span>
                      <span aria-hidden="true">·</span>
                      <span>{task.task_type ?? '未分类'}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}

        <SectionLabel>资源库</SectionLabel>
        <button className="btn-ghost" style={{ width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 13 }} onClick={onOpenLabs}>
          🧰 工具箱 · Labs
        </button>
        <Entry>案例库</Entry>
      </div>

      <div style={{ padding: 12, borderTop: '1px solid var(--border-soft)', fontSize: 12, color: 'var(--text-dim)' }}>
        <div style={{ marginBottom: 6 }}>{user.display_name}</div>
        <button className="btn-ghost" style={{ width: '100%', fontSize: 12, padding: '6px' }} onClick={onLogout}>登出</button>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', margin: '14px 10px 6px', letterSpacing: 0.5 }}>{children}</div>;
}
function Entry({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '8px 10px', borderRadius: 8, fontSize: 13, color: 'var(--text-dim)' }}>{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--text-faint)' }}>{children}</div>;
}
