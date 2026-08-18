import { useCallback, useEffect, useState } from 'react';
import { api, type User, type TaskDetail, type PlanStep, type PlanProgress, ApiError } from '../api/client.ts';
import { mergeTaskHistory, type HistoryTaskSummary } from '../current-flow-state.ts';
import { useTaskFlow } from '../hooks/useTaskFlow.ts';
import { Sidebar } from '../components/Sidebar.tsx';
import { Composer } from '../components/Composer.tsx';
import { Stage1Understand } from '../components/stages/Stage1Understand.tsx';
import { CurrentStage1Clarify } from '../components/stages/CurrentStage1Clarify.tsx';
import { Stage2Candidates } from '../components/stages/Stage2Candidates.tsx';
import { Stage2Plan } from '../components/stages/Stage2Plan.tsx';
import { Stage3Execute } from '../components/stages/Stage3Execute.tsx';
import { Stage4Report } from '../components/stages/Stage4Report.tsx';
import { CurrentStage4Report } from '../components/stages/CurrentStage4Report.tsx';
import { Labs } from './Labs.tsx';

type View = 'task' | 'labs' | 'history';

export function Workbench({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>('task');
  const [history, setHistory] = useState<HistoryTaskSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(''); // 历史打开失败(与任务流 error 分离)

  const refreshHistory = useCallback(() => {
    void Promise.allSettled([api.listTasks(), api.listControlTasks()]).then(([legacy, current]) => {
      setHistory(mergeTaskHistory(
        legacy.status === 'fulfilled' ? legacy.value.tasks : [],
        current.status === 'fulfilled' ? current.value.tasks : [],
      ));
    });
  }, []);
  useEffect(refreshHistory, [refreshHistory]);

  // 新任务和 Current 历史走同一恢复主链；Legacy 历史保持只读。
  const flow = useTaskFlow();
  const {
    phase,
    clarification,
    submitClarification,
    clarificationSubmitting,
    candidatesResp,
    selectedCandidateId,
    plan,
    originalInput,
    exec,
    executionSteps,
    deliverable,
    reportState,
    deliverableError,
    error,
    progress,
  } = flow;
  const executionPlanSteps: PlanStep[] = plan?.plan.steps ?? executionSteps.map((step) => ({
    step_no: step.step_no,
    step_name: step.step_name,
    actor_type: step.actor_type as PlanStep['actor_type'],
    actor_id: step.actor_id,
  }));

  function newTask() {
    setView('task'); setDetail(null); setDetailError('');
    flow.reset();
  }

  async function openTask(id: string) {
    const task = history.find((item) => item.id === id);
    if (task?.kind === 'current') {
      localStorage.setItem('ur_current_task_id', task.id);
      window.location.reload();
      return;
    }
    setView('history'); setDetail(null); setDetailLoading(true); setDetailError('');
    try {
      setDetail(await api.taskDetail(id));
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : '打开历史任务失败');
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="workbench" style={{ display: 'grid', gridTemplateColumns: '272px 1fr', height: '100%' }}>
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
              {detailError && <ErrorCard msg={detailError} />}
              {detail && <HistoryDetail detail={detail} />}
            </div>
          </div>
        </main>
      ) : (
      <main style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px 0' }}>
          <div className={`chat-column${deliverable?.presentationMode === 'multimodal' ? ' chat-column-report' : ''}`} aria-live="polite">
            {phase === 'idle' && <Welcome onPick={flow.submitInput} />}
            {clarification && phase === 'clarifying' && (
              <>
                {error && <ErrorCard msg={error} />}
                <CurrentStage1Clarify
                  response={clarification}
                  onSubmit={submitClarification}
                  disabled={clarificationSubmitting}
                />
              </>
            )}

            {originalInput && phase !== 'idle' && <UserBubble text={originalInput} />}

            {candidatesResp && (
              <>
                <Stage1Understand task={candidatesResp.structuredTask} activatedNodes={candidatesResp.activatedNodes} />
                {(phase === 'picking' || phase === 'selecting') && (
                  <>
                    {error && phase === 'picking' && <InlineError msg={error} />}
                    <Stage2Candidates
                      candidates={candidatesResp.candidates}
                      onSelect={flow.pickCandidate}
                      selectedId={selectedCandidateId ?? undefined}
                      loading={phase === 'selecting'}
                      readOnly={false}
                    />
                  </>
                )}
              </>
            )}

            {plan && phase !== 'picking' && phase !== 'selecting' && phase !== 'awaiting-approval' && phase !== 'error' && (
              <Stage2Plan
                plan={plan}
                locked={phase !== 'planned'}
                onConfirm={flow.confirmAndExecute}
              />
            )}

            {phase === 'planning' && <PlanProgressCard steps={progress} />}
            {phase === 'awaiting-approval' && <AwaitingApprovalNotice />}
            {phase === 'executing' && (
              <>
                {executionPlanSteps.length > 0 && (
                  <Stage3Execute steps={executionPlanSteps} log={executionSteps} phase="executing" />
                )}
                <Loading text="执行中…报告合成较慢,请稍候" />
              </>
            )}
            {phase === 'paused' && exec && (
              <>
                {executionPlanSteps.length > 0 && (
                  <Stage3Execute steps={executionPlanSteps} log={executionSteps} phase="paused" />
                )}
                <FailureActionCard
                  stepNo={exec.failedStepNo}
                  stepName={executionPlanSteps.find((step) => step.step_no === exec.failedStepNo)?.step_name}
                  failure={exec.failure}
                  onRetry={() => flow.resumeStep('retry')}
                  onAbort={() => flow.resumeStep('abort')}
                />
              </>
            )}
            {phase === 'done' && exec && (
              <>
                {executionPlanSteps.length > 0 && (
                  <Stage3Execute steps={executionPlanSteps} log={executionSteps} phase="done" />
                )}
                {error && <ErrorCard msg={error} />}
                {exec.status === 'completed_with_gaps' && (
                  <GapNotice count={exec.gapCount ?? executionSteps.filter((step) => step.status === 'skipped').length} />
                )}
                {reportState === 'loading' && <Loading text="正在读取研究报告…" />}
                {reportState === 'report-loading-error' && (
                  <ErrorCard msg={deliverableError} onRetry={flow.retryDeliverable} retryLabel="重取报告" />
                )}
                {deliverable && <CurrentStage4Report report={deliverable} />}
              </>
            )}
            {phase === 'cancelled' && <AbortedNotice />}
            {phase === 'error' && <ErrorCard msg={error} />}
            {(candidatesResp || exec || deliverable) && <CurrentHistoryNotice />}
          </div>
        </div>
        <Composer disabled={phase === 'planning' || phase === 'clarifying' || phase === 'selecting' || phase === 'executing' || phase === 'awaiting-approval'} onSubmit={flow.submitInput} />
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

function ErrorCard({
  msg,
  onRetry,
  retryLabel = '重试执行',
}: {
  msg: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>出错了</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0' }}>{msg}</div>
      {onRetry && <button className="btn-ghost" onClick={onRetry}>{retryLabel}</button>}
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


function FailureActionCard({
  stepNo,
  stepName,
  failure,
  onRetry,
  onAbort,
}: {
  stepNo?: number;
  stepName?: string;
  failure?: Record<string, unknown>;
  onRetry: () => void;
  onAbort: () => void;
}) {
  return (
    <section style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--warn)', fontWeight: 600 }}>
        第 {stepNo ?? '?'} 步失败{stepName ? `：${stepName}` : ''}
      </div>
      {failure && (
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dim)', fontSize: 12, margin: '8px 0' }}>
          {JSON.stringify(failure, null, 2)}
        </pre>
      )}
      <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0 12px' }}>
        重试会通过 Current resume 将任务恢复到 ready，再以同一 planVersionId 重新执行；终止不会生成交付物。
      </p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn-primary" onClick={onRetry}>重试失败执行</button>
        <button type="button" className="btn-ghost" onClick={onAbort}>终止任务</button>
      </div>
    </section>
  );
}

function GapNotice({ count }: { count: number }) {
  return (
    <div style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 16, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--warn)' }}>
      部分完成 · {count} 个数据缺口已在下方风险与待解决问题中标注。
    </div>
  );
}

function AwaitingApprovalNotice() {
  return (
    <section className="stage-card">
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>计划等待授权审批</h3>
      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
        确认已记录，但计划包含需要对应角色处理的阻断项；状态达到 ready 前不会执行。
      </p>
    </section>
  );
}

function CurrentHistoryNotice() {
  return (
    <aside style={{ color: 'var(--text-faint)', fontSize: 12, padding: '4px 2px 18px' }}>
      Current 任务会保留在侧栏历史中；点击即可恢复最近状态和报告。
    </aside>
  );
}

function AbortedNotice() {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>任务已终止</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 6 }}>Current 任务已取消，未生成交付物。可新建任务重试。</div>
    </div>
  );
}
