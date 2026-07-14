import { useCallback, useEffect, useState } from 'react';
import { api, type User, type PlanResponse, type ExecuteResponse, type TaskSummary, type TaskDetail, type PlanStep, type Upload, ApiError } from '../api/client.ts';
import { Sidebar } from '../components/Sidebar.tsx';
import { Composer } from '../components/Composer.tsx';
import { Stage1Understand } from '../components/stages/Stage1Understand.tsx';
import { Stage2Plan } from '../components/stages/Stage2Plan.tsx';
import { Stage3Execute } from '../components/stages/Stage3Execute.tsx';
import { Stage4Report } from '../components/stages/Stage4Report.tsx';
import { Labs } from './Labs.tsx';

// 四段流的会话状态。一次任务从 plan → 确认 → execute。
type Phase = 'idle' | 'planning' | 'planned' | 'executing' | 'done' | 'error';
// 主视图:任务工作台 | 工具箱 | 历史任务详情。
type View = 'task' | 'labs' | 'history';

export function Workbench({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>('task');
  const [phase, setPhase] = useState<Phase>('idle');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<TaskSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refreshHistory = useCallback(() => {
    api.listTasks().then((r) => setHistory(r.tasks)).catch(() => {});
  }, []);
  useEffect(refreshHistory, [refreshHistory]);

  function newTask() {
    setView('task'); setPhase('idle'); setPlan(null); setExec(null); setError(''); setDetail(null);
  }

  async function openTask(id: string) {
    setView('history'); setDetail(null); setDetailLoading(true); setError('');
    try {
      setDetail(await api.taskDetail(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '打开历史任务失败');
    } finally {
      setDetailLoading(false);
    }
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

  async function confirmAndExecute(uploads: Upload[] = []) {
    if (!plan) return;
    setPhase('executing'); setError('');
    try {
      const r = await api.execute(plan.taskId, uploads);
      setExec(r); setPhase('done'); refreshHistory();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '执行失败'); setPhase('error');
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '264px 1fr', height: '100%' }}>
      <Sidebar user={user} history={history} onNewTask={newTask} onOpenLabs={() => setView('labs')} onOpenTask={openTask} onLogout={onLogout} />
      {view === 'labs' ? (
        <main style={{ height: '100%', overflow: 'hidden' }}>
          <Labs />
        </main>
      ) : view === 'history' ? (
        <main style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
            <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px' }}>
              {detailLoading && <Loading text="加载历史任务…" />}
              {error && <ErrorCard msg={error} />}
              {detail && <HistoryDetail detail={detail} />}
            </div>
          </div>
        </main>
      ) : (
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
            {phase === 'error' && <ErrorCard msg={error} onRetry={plan ? () => confirmAndExecute() : undefined} />}
          </div>
        </div>
        <Composer disabled={phase === 'planning' || phase === 'executing'} onSubmit={submitInput} />
      </main>
      )}
    </div>
  );
}

// 历史任务只读详情:复用 Stage1(理解) + Stage3(执行日志重建步骤) + Stage4(报告)。
// 计划步骤未单独持久化,用 executionLog 重建(含 step_no/name/actor/status)。
function HistoryDetail({ detail }: { detail: TaskDetail }) {
  const steps = detail.executionLog.map((l) => ({
    step_no: l.step_no, step_name: l.step_name,
    actor_type: l.actor_type as PlanStep['actor_type'], actor_id: l.actor_id,
  }));
  const activatedNodes = detail.decisionStates.map((d) => d.node_key);
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 12 }}>
        历史任务 · {detail.task.status} · <span className="mono">{detail.task.id}</span>
      </div>
      <Stage1Understand task={detail.task.structured_task} activatedNodes={activatedNodes} />
      {steps.length > 0 && <Stage3Execute steps={steps} log={detail.executionLog} />}
      <Stage4Report report={detail.report} taskId={detail.task.id} />
    </>
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
