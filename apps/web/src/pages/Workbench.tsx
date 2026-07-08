import { useCallback, useEffect, useState } from 'react';
import { api, type User, type PlanResponse, type ExecuteResponse, type TaskSummary, ApiError } from '../api/client.ts';
import { Sidebar } from '../components/Sidebar.tsx';
import { Composer } from '../components/Composer.tsx';
import { Stage1Understand } from '../components/stages/Stage1Understand.tsx';
import { Stage2Plan } from '../components/stages/Stage2Plan.tsx';
import { Stage3Execute } from '../components/stages/Stage3Execute.tsx';
import { Stage4Report } from '../components/stages/Stage4Report.tsx';

// 四段流的会话状态。一次任务从 plan → 确认 → execute。
type Phase = 'idle' | 'planning' | 'planned' | 'executing' | 'done' | 'error';

export function Workbench({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<TaskSummary[]>([]);

  const refreshHistory = useCallback(() => {
    api.listTasks().then((r) => setHistory(r.tasks)).catch(() => {});
  }, []);
  useEffect(refreshHistory, [refreshHistory]);

  function newTask() {
    setPhase('idle'); setPlan(null); setExec(null); setError('');
  }

  async function submitInput(text: string) {
    setPhase('planning'); setPlan(null); setExec(null); setError('');
    try {
      const r = await api.plan({ originalInput: text });
      setPlan(r); setPhase('planned');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '规划失败'); setPhase('error');
    }
  }

  async function confirmAndExecute() {
    if (!plan) return;
    setPhase('executing'); setError('');
    try {
      const r = await api.execute(plan.taskId);
      setExec(r); setPhase('done'); refreshHistory();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '执行失败'); setPhase('error');
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '264px 1fr', height: '100%' }}>
      <Sidebar user={user} history={history} onNewTask={newTask} onLogout={onLogout} />
      <main style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
          <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px' }} aria-live="polite">
            {phase === 'idle' && <Welcome onPick={submitInput} />}

            {plan && (
              <>
                <UserBubble text={plan.task.research_goal ? `(需求已提交)` : ''} />
                <Stage1Understand task={plan.task} activatedNodes={plan.activatedNodes} />
                <Stage2Plan
                  plan={plan}
                  locked={phase !== 'planned'}
                  onConfirm={confirmAndExecute}
                />
              </>
            )}

            {phase === 'planning' && <Loading text="AI 规划中…(真实 GPT-5.5,约 10-30s)" />}
            {phase === 'executing' && (
              <>
                {plan && <Stage3Execute steps={plan.plan.steps} running />}
                <Loading text="执行中…报告合成较慢,请稍候" />
              </>
            )}
            {phase === 'done' && exec && (
              <>
                <Stage3Execute steps={plan!.plan.steps} log={exec.executionLog} />
                <Stage4Report report={exec.report} taskId={exec.taskId} />
              </>
            )}
            {phase === 'error' && <ErrorCard msg={error} onRetry={plan ? confirmAndExecute : undefined} />}
          </div>
        </div>
        <Composer disabled={phase === 'planning' || phase === 'executing'} onSubmit={submitInput} />
      </main>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (t: string) => void }) {
  const suggestions = [
    '我要为直播场域做一次数字人竞品研究',
    '帮我规划一次直播带货的用户体验研究',
    '分析虚拟主播赛道的主要竞品差异',
  ];
  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <h1 style={{ fontSize: 24 }}>你想研究什么?</h1>
      <p style={{ color: 'var(--text-dim)' }}>输入一句话,我来给出「找谁 + 用什么方法 + 参考什么」的可落地方案。</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520, margin: '24px auto 0' }}>
        {suggestions.map((s) => (
          <button key={s} className="btn-ghost" style={{ textAlign: 'left' }} onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div style={{ textAlign: 'right', margin: '8px 0 20px' }}>
      <span style={{ display: 'inline-block', background: 'var(--primary)', color: '#fff', padding: '8px 14px', borderRadius: 12 }}>
        {text}
      </span>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-dim)', padding: '16px 0' }}>
      <span className="spinner" /> {text}
    </div>
  );
}

function ErrorCard({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', padding: 16, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>出错了</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0' }}>{msg}</div>
      {onRetry && <button className="btn-ghost" onClick={onRetry}>重试执行</button>}
    </div>
  );
}
