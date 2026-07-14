import type { User, TaskSummary } from '../api/client.ts';

// 左侧栏:新建任务 + 历史任务 + 工具箱入口 + 用户/登出。
export function Sidebar({
  user, history, onNewTask, onOpenLabs, onOpenTask, onLogout,
}: {
  user: User; history: TaskSummary[]; onNewTask: () => void; onOpenLabs: () => void; onOpenTask: (id: string) => void; onLogout: () => void;
}) {
  return (
    <aside style={{ background: 'var(--bg-elev)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 16 }}>
        <button className="btn-primary" style={{ width: '100%' }} onClick={onNewTask}>+ 新建任务</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
        <SectionLabel>历史任务</SectionLabel>
        {history.length === 0 && <Empty>暂无历史</Empty>}
        {history.map((t) => (
          <div
            key={t.id}
            onClick={() => onOpenTask(t.id)}
            style={{ padding: '8px 10px', borderRadius: 8, marginBottom: 4, fontSize: 13, color: 'var(--text-dim)', cursor: 'pointer' }}
            title={t.original_input}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.original_input}</div>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{t.task_type ?? '-'} · {t.status}</span>
          </div>
        ))}

        <SectionLabel>资源库</SectionLabel>
        <button className="btn-ghost" style={{ width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 13 }} onClick={onOpenLabs}>
          🧰 工具箱 · Labs
        </button>
        <Entry>案例库</Entry>
      </div>

      <div style={{ padding: 12, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-dim)' }}>
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
