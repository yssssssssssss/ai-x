import type { PlanStep, ExecLogRow } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

// 段3 · 执行:每步一行状态机。running=转圈"调用中",done=按 execution_log 显示 ✓/✗。
export function Stage3Execute({
  steps, log, running,
}: {
  steps: PlanStep[]; log?: ExecLogRow[]; running?: boolean;
}) {
  const statusOf = (stepNo: number): string => {
    if (running) return 'running';
    const row = log?.find((l) => l.step_no === stepNo);
    return row?.status ?? 'pending';
  };

  return (
    <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18, marginBottom: 16 }}>
      <Header n="3" title="执行进度" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.map((s) => {
          const st = statusOf(s.step_no);
          return (
            <div key={s.step_no} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 12px', background: 'var(--bg)', borderRadius: 8, fontSize: 13 }}>
              <StatusIcon status={st} />
              <span style={{ flex: 1 }}>{s.step_name}</span>
              <span className={`badge badge-${s.actor_type === 'llm' ? 'llm' : s.actor_type === 'reviewer' ? 'reviewer' : s.actor_type}`}>
                {s.actor_type.toUpperCase()}
              </span>
              <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{s.actor_id}</code>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'running') return <span className="spinner" />;
  if (status === 'succeeded') return <span style={{ color: 'var(--ok)' }}>✓</span>;
  if (status === 'failed') return <span style={{ color: 'var(--danger)' }}>✗</span>;
  if (status === 'skipped') return <span style={{ color: 'var(--muted)' }}>⤼</span>;
  return <span style={{ color: 'var(--text-faint)' }}>○</span>;
}
