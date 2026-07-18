import { useCallback, useEffect, useState } from 'react';
import { api, type User, type PlanCandidatesResponse, type PlanCandidate, type PlanResponse, type ExecuteResponse, type TaskSummary, type TaskDetail, type PlanStep, type Upload, type PlanProgress, ApiError } from '../api/client.ts';
import { Sidebar } from '../components/Sidebar.tsx';
import { Composer } from '../components/Composer.tsx';
import { Stage1Understand } from '../components/stages/Stage1Understand.tsx';
import { Stage2Candidates } from '../components/stages/Stage2Candidates.tsx';
import { Stage2Plan } from '../components/stages/Stage2Plan.tsx';
import { Stage3Execute } from '../components/stages/Stage3Execute.tsx';
import { Stage4Report } from '../components/stages/Stage4Report.tsx';
import { Labs } from './Labs.tsx';

// 状态机:idle → planning → picking(选候选)→ selecting(POST select) → planned(确认闸门) → executing → (paused 失败步待决策) → done。
type Phase = 'idle' | 'planning' | 'picking' | 'selecting' | 'planned' | 'executing' | 'paused' | 'done' | 'error';
type View = 'task' | 'labs' | 'history';

export function Workbench({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>('task');
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidatesResp, setCandidatesResp] = useState<PlanCandidatesResponse | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<PlanCandidate['id'] | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);   // finalize 后
  const [originalInput, setOriginalInput] = useState('');
  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<TaskSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [progress, setProgress] = useState<PlanProgress[]>([]);   // 规划阶段流式进度

  const refreshHistory = useCallback(() => {
    api.listTasks().then((r) => setHistory(r.tasks)).catch(() => {});
  }, []);
  useEffect(refreshHistory, [refreshHistory]);

  function newTask() {
    setView('task'); setPhase('idle');
    setCandidatesResp(null); setSelectedCandidateId(null); setPlan(null); setExec(null);
    setOriginalInput(''); setError(''); setDetail(null); setProgress([]);
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
    setPhase('planning'); setCandidatesResp(null); setPlan(null); setExec(null); setError('');
    setSelectedCandidateId(null); setOriginalInput(text); setProgress([]);
    try {
      await api.planStream({ originalInput: text }, (type, data) => {
        if (type === 'progress') {
          const ev = data as unknown as PlanProgress;
          // start 追加占位;done 更新同 phase 的最后一条为完成态
          setProgress((prev) => {
            const i = prev.findIndex((p) => p.phase === ev.phase);
            if (i >= 0) { const next = [...prev]; next[i] = ev; return next; }
            return [...prev, ev];
          });
        } else if (type === 'result') {
          setCandidatesResp(data as unknown as PlanCandidatesResponse);
          setPhase('picking');
        } else if (type === 'error') {
          setError(String(data.error ?? '规划失败')); setPhase('error');
        }
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '规划失败'); setPhase('error');
    }
  }

  async function pickCandidate(candidateId: PlanCandidate['id']) {
    if (!candidatesResp) return;
    setSelectedCandidateId(candidateId); setPhase('selecting'); setError('');
    try {
      const r = await api.selectCandidate(candidatesResp.taskId, candidateId);
      // 拼成 Stage2Plan 期望的 PlanResponse 形状(复用现成组件)。
      setPlan({
        conversationId: candidatesResp.conversationId,
        taskId: candidatesResp.taskId,
        task: candidatesResp.task,
        activatedNodes: candidatesResp.activatedNodes,
        plan: r.plan,
        pendingUploads: r.pendingUploads,
      });
      setPhase('planned');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '候选选择失败');
      setSelectedCandidateId(null); setPhase('picking'); // 回到选择态,让用户重选
    }
  }

  async function confirmAndExecute(uploads: Upload[] = []) {
    if (!plan) return;
    setPhase('executing'); setError('');
    try {
      const r = await api.execute(plan.taskId, uploads);
      setExec(r); refreshHistory();
      setPhase(r.status === 'paused' ? 'paused' : 'done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '执行失败'); setPhase('error');
    }
  }

  // 失败步恢复:skip=跳过该步续跑,abort=终止任务。
  async function resumeStep(action: 'skip' | 'abort') {
    if (!plan) return;
    setPhase('executing'); setError('');
    try {
      const r = await api.resume(plan.taskId, action);
      setExec(r); refreshHistory();
      setPhase(r.status === 'paused' ? 'paused' : 'done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '恢复失败'); setPhase('error');
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '272px 1fr', height: '100%' }}>
      <Sidebar user={user} history={history} onNewTask={newTask} onOpenLabs={() => setView('labs')} onOpenTask={openTask} onLogout={onLogout} />
      {view === 'labs' ? (
        <main style={{ height: '100%', overflow: 'hidden' }}>
          <Labs />
        </main>
      ) : view === 'history' ? (
        <main style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '32px 0' }}>
            <div className="chat-column">
              {detailLoading && <Loading text="加载历史任务…" />}
              {error && <ErrorCard msg={error} />}
              {detail && <HistoryDetail detail={detail} />}
            </div>
          </div>
        </main>
      ) : (
      <main style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px 0' }}>
          <div className="chat-column" aria-live="polite">
            {phase === 'idle' && <Welcome onPick={submitInput} />}

            {originalInput && phase !== 'idle' && <UserBubble text={originalInput} />}

            {candidatesResp && (
              <>
                <Stage1Understand task={candidatesResp.task} activatedNodes={candidatesResp.activatedNodes} />
                {(phase === 'picking' || phase === 'selecting') && (
                  <>
                    {error && phase === 'picking' && <InlineError msg={error} />}
                    <Stage2Candidates
                      candidates={candidatesResp.candidates}
                      onSelect={pickCandidate}
                      selectedId={selectedCandidateId ?? undefined}
                      loading={phase === 'selecting'}
                    />
                  </>
                )}
              </>
            )}

            {plan && phase !== 'picking' && phase !== 'selecting' && (
              <Stage2Plan
                plan={plan}
                locked={phase !== 'planned'}
                onConfirm={confirmAndExecute}
              />
            )}

            {phase === 'planning' && <PlanProgressCard steps={progress} />}
            {phase === 'executing' && (
              <>
                {plan && <Stage3Execute steps={plan.plan.steps} running />}
                <Loading text="执行中…报告合成较慢,请稍候" />
              </>
            )}
            {phase === 'paused' && exec && plan && (
              <>
                <Stage3Execute steps={plan.plan.steps} log={exec.executionLog} />
                <FailureActionCard
                  stepNo={exec.failedStepNo ?? undefined}
                  stepName={exec.failedStepName ?? undefined}
                  onSkip={() => resumeStep('skip')}
                  onAbort={() => resumeStep('abort')}
                />
              </>
            )}
            {phase === 'done' && exec && plan && (
              <>
                <Stage3Execute steps={plan.plan.steps} log={exec.executionLog} />
                {exec.status === 'completed_with_gaps' && <GapNotice count={exec.gapCount ?? 0} />}
                {exec.status === 'failed'
                  ? <AbortedNotice />
                  : <Stage4Report report={exec.report} taskId={exec.taskId} />}
              </>
            )}
            {phase === 'error' && <ErrorCard msg={error} onRetry={plan ? () => confirmAndExecute() : undefined} />}
          </div>
        </div>
        <Composer disabled={phase === 'planning' || phase === 'selecting' || phase === 'executing'} onSubmit={submitInput} />
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
    <div className="welcome">
      <h1>你想研究什么?</h1>
      <p>输入一句话,我会给出两份可比较的方案 · 「深度优先 / 速度优先」由你挑一份。</p>
      <div className="welcome-suggests">
        {suggestions.map((s) => (
          <button key={s} className="welcome-chip" onClick={() => onPick(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="user-row">
      <div className="user-bubble">{text}</div>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-dim)', padding: '16px 4px' }}>
      <span className="spinner" /> {text}
    </div>
  );
}

function ErrorCard({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>出错了</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0' }}>{msg}</div>
      {onRetry && <button className="btn-ghost" onClick={onRetry}>重试执行</button>}
    </div>
  );
}

// 规划阶段流式进度卡:逐条阶段出现,完成打勾、进行中转圈,detail 灰字。
function PlanProgressCard({ steps }: { steps: PlanProgress[] }) {
  const ALL: Array<{ phase: PlanProgress['phase']; label: string }> = [
    { phase: 'understand', label: '理解任务需求' },
    { phase: 'activate', label: '激活决策节点' },
    { phase: 'guidance', label: '召回方法论知识' },
    { phase: 'states', label: '判定节点状态' },
    { phase: 'candidates', label: '生成候选方案' },
    { phase: 'persist', label: '归档计划' },
  ];
  const byPhase = new Map(steps.map((s) => [s.phase, s]));
  // 直呼支路只有 understand/candidates/persist;已出现的阶段才展示,避免误显示不会发生的阶段
  const seen = ALL.filter((a) => byPhase.has(a.phase) || a.phase === 'understand');
  // 最后一条是否 done:决定当前"进行中"的阶段
  const lastDoneIdx = seen.reduce((acc, a, i) => (byPhase.get(a.phase)?.status === 'done' ? i : acc), -1);

  return (
    <section className="stage-card" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span className="spinner" />
        <b style={{ fontSize: 15 }}>AI 规划中</b>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>· 正在分步处理,请稍候</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {seen.map((a, i) => {
          const ev = byPhase.get(a.phase);
          const done = ev?.status === 'done';
          const active = !done && i === lastDoneIdx + 1;
          return (
            <div key={a.phase} style={{ display: 'flex', gap: 10, alignItems: 'baseline', opacity: done || active ? 1 : 0.4 }}>
              <span style={{ width: 16, flexShrink: 0, textAlign: 'center' }}>
                {done ? <span style={{ color: 'var(--ok)' }}>✓</span> : active ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <span style={{ color: 'var(--text-faint)' }}>○</span>}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: done || active ? 'var(--text)' : 'var(--text-dim)' }}>{ev?.label ?? a.label}</span>
                {ev?.detail && <span style={{ fontSize: 12, color: 'var(--text-faint)', marginLeft: 8 }}>{ev.detail}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// 候选选择失败的内联错误条(保留候选卡,让用户看到原因并重选,不静默吞错)。
function InlineError({ msg }: { msg: string }) {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 12, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: 'var(--danger)' }}>
      {msg} · 请重新选择一份方案
    </div>
  );
}

// 失败步操作卡(paused 态):停在失败步,给「跳过续跑 / 终止」。
function FailureActionCard({ stepNo, stepName, onSkip, onAbort }: { stepNo?: number; stepName?: string; onSkip: () => void; onAbort: () => void }) {
  return (
    <div style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--warn)', fontWeight: 600 }}>
        第 {stepNo ?? '?'} 步失败{stepName ? `:${stepName}` : ''}
      </div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0 12px' }}>
        跳过该步会从下一步继续,缺失的数据会在报告中如实标注;终止则结束任务、不生成报告。
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn-primary" onClick={onSkip}>跳过该步,继续</button>
        <button className="btn-ghost" onClick={onAbort}>终止任务</button>
      </div>
    </div>
  );
}

// 部分完成提示(completed_with_gaps):报告已出但有维度缺口。
function GapNotice({ count }: { count: number }) {
  return (
    <div style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 16, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--warn)' }}>
      ⚠ 部分完成 · {count} 步失败或跳过,相关维度的数据缺口已在下方「风险与待确认」中标注。
    </div>
  );
}

// 任务终止提示(abort)。
function AbortedNotice() {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>任务已终止</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 6 }}>你选择了终止,未生成报告。可新建任务重试。</div>
    </div>
  );
}
