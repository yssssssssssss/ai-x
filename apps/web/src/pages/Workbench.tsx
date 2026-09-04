import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ControlDeliverableResponse,
  type CurrentTaskReadResponse,
  type OrchestrationMode,
  type SystemCapabilitiesResponse,
  type TaskDetail,
  type TaskHistoryPreferencePatch,
  type User,
} from '../api/client.ts';
import {
  applyTaskHistoryPreferences,
  mergeTaskHistory,
  type HistoryTaskSummary,
} from '../current-flow-state.ts';
import { Composer } from '../components/Composer.tsx';
import { Sidebar } from '../components/Sidebar.tsx';
import { SkillNativeTaskFlow } from '../components/SkillNativeTaskFlow.tsx';
import { Stage1Understand } from '../components/stages/Stage1Understand.tsx';
import { Stage3Execute } from '../components/stages/Stage3Execute.tsx';
import { Stage4Report } from '../components/stages/Stage4Report.tsx';
import { CurrentStage4Report } from '../components/stages/CurrentStage4Report.tsx';
import { useSkillNativeFlow } from '../hooks/useSkillNativeFlow.ts';
import { Labs } from './Labs.tsx';

type View = 'task' | 'labs' | 'history';

export function Workbench({
  user,
  capabilities,
  onLogout,
}: {
  user: User;
  capabilities: SystemCapabilitiesResponse | null;
  onLogout: () => void;
}) {
  const [view, setView] = useState<View>('task');
  const [history, setHistory] = useState<HistoryTaskSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [controlDetail, setControlDetail] = useState<CurrentTaskReadResponse | null>(null);
  const [controlReport, setControlReport] = useState<ControlDeliverableResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const flow = useSkillNativeFlow();

  const refreshHistory = useCallback(() => {
    void Promise.all([
      api.listTaskHistoryPreferences(),
      Promise.allSettled([api.listTasks(), api.listControlTasks(), api.listResearchTasks()]),
    ]).then(([preferences, [legacy, current, native]]) => {
      setHistory(mergeTaskHistory(
        legacy.status === 'fulfilled' ? legacy.value.tasks : [],
        current.status === 'fulfilled' ? current.value.tasks : [],
        preferences.preferences,
        native.status === 'fulfilled'
          ? native.value.tasks.map((task) => ({
              id: task.id,
              originalInput: task.originalInput,
              taskType: task.orchestrationMode,
              state: task.state,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            }))
          : [],
      ));
    }).catch(() => {});
  }, []);

  useEffect(refreshHistory, [refreshHistory]);
  useEffect(() => {
    if (flow.task) refreshHistory();
  }, [flow.task?.stateVersion, refreshHistory]);

  function newTask(): void {
    setView('task');
    setDetail(null);
    setControlDetail(null);
    setControlReport(null);
    setDetailError('');
    flow.reset();
  }

  async function openTask(task: HistoryTaskSummary): Promise<void> {
    if (task.kind === 'native') {
      setView('task');
      setDetail(null);
      setControlDetail(null);
      setControlReport(null);
      setDetailError('');
      await flow.openTask(task.id);
      return;
    }
    setView('history');
    setDetail(null);
    setControlDetail(null);
    setControlReport(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      if (task.kind === 'current') {
        const current = await api.controlTask(task.id);
        setControlDetail(current);
        if (current.task.state === 'completed' || current.task.state === 'completed_with_gaps') {
          try {
            setControlReport(await api.controlDeliverable(task.id));
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
        }
      } else {
        setDetail(await api.taskDetail(task.id));
      }
    } catch (error) {
      setDetailError(error instanceof ApiError ? error.message : '打开历史任务失败');
    } finally {
      setDetailLoading(false);
    }
  }

  async function updateHistoryTask(
    task: HistoryTaskSummary,
    patch: TaskHistoryPreferencePatch,
  ): Promise<void> {
    const { preference } = await api.updateTaskHistoryPreference(task.kind, task.id, patch);
    setHistory((current) => applyTaskHistoryPreferences(current, [preference]));
    if (patch.hidden && (
      (task.kind === 'native' && task.id === flow.task?.id)
      || (task.kind === 'current' && task.id === controlDetail?.task.id)
      || (task.kind === 'legacy' && task.id === detail?.task.id)
    )) newTask();
  }

  const composerDisabled = flow.phase === 'loading-task'
    || flow.phase === 'planning'
    || flow.phase === 'executing';

  return (
    <div className="workbench">
      <Sidebar
        user={user}
        capabilities={capabilities}
        history={history}
        activeTaskId={flow.task?.id ?? null}
        onNewTask={newTask}
        onOpenLabs={() => setView('labs')}
        onOpenTask={(task) => { void openTask(task); }}
        onUpdateTask={updateHistoryTask}
        onLogout={onLogout}
      />
      {view === 'labs' ? (
        <main className="workbench-main"><Labs /></main>
      ) : view === 'history' ? (
        <main className="workbench-main">
          <div className="workbench-scroll">
            <div className="chat-column">
              {detailLoading ? <Loading text="加载历史任务…" /> : null}
              {detailError ? <ErrorCard message={detailError} /> : null}
              {detail ? <HistoryDetail detail={detail} /> : null}
              {controlDetail ? <ControlHistoryDetail detail={controlDetail} report={controlReport} /> : null}
            </div>
          </div>
        </main>
      ) : (
        <main className="workbench-main">
          <div className="workbench-scroll">
            <div className="chat-column" aria-live="polite">
              {flow.phase === 'idle' ? (
                <Welcome onPick={flow.submitInput} />
              ) : (
                <SkillNativeTaskFlow
                  phase={flow.phase}
                  task={flow.task}
                  reportHtml={flow.reportHtml}
                  error={flow.error}
                  onSelect={flow.selectSolution}
                  onConfirm={flow.confirm}
                  onExecute={flow.execute}
                  onCancel={flow.cancel}
                  onRetry={flow.retry}
                  onReplan={flow.replan}
                  onPublishZero={flow.publishToZero}
                />
              )}
            </div>
          </div>
          <Composer
            disabled={composerDisabled}
            multiSkillEnabled
            onSubmit={(text, mode) => { void flow.submitInput(text, mode); }}
          />
        </main>
      )}
    </div>
  );
}

function ControlHistoryDetail({
  detail,
  report,
}: {
  detail: CurrentTaskReadResponse;
  report: ControlDeliverableResponse | null;
}) {
  const taskState = detail.task.state;
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 12 }}>
        旧 Control Task · 只读 · {taskState} · <span className="mono">{detail.task.id}</span>
      </div>
      <Stage1Understand task={detail.task.structuredTask} activatedNodes={detail.activatedNodes} />
      {detail.activePlan ? (
        <section className="stage-card">
          <h2>历史执行方案</h2>
          <p>{detail.activePlan.title}</p>
          <ol>{detail.activePlan.plan.steps.map((step) => (
            <li key={step.step_no}>{step.step_name} · {step.actor_id}</li>
          ))}</ol>
        </section>
      ) : null}
      {detail.executionSteps.length > 0 ? (
        <section className="stage-card">
          <h2>历史执行记录</h2>
          <ol>{detail.executionSteps.map((step) => (
            <li key={step.stepNo}>{step.stepName} · {step.state}</li>
          ))}</ol>
        </section>
      ) : null}
      {report && (taskState === 'completed' || taskState === 'completed_with_gaps') ? (
        <CurrentStage4Report
          report={report}
          taskState={taskState}
          orchestrationMode={detail.task.orchestrationMode ?? undefined}
          readOnly
        />
      ) : <Notice text="该历史任务没有可读取的正式报告。" />}
    </>
  );
}

function HistoryDetail({ detail }: { detail: TaskDetail }) {
  const steps = detail.executionLog.map((log) => ({
    step_no: log.step_no,
    step_name: log.step_name,
    actor_type: log.actor_type,
    actor_id: log.actor_id,
  }));
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 12 }}>
        历史任务 · {detail.task.status} · <span className="mono">{detail.task.id}</span>
      </div>
      <Stage1Understand
        task={detail.task.structured_task}
        activatedNodes={detail.decisionStates.map(({ node_key }) => node_key)}
      />
      {steps.length > 0 ? <Stage3Execute steps={steps} log={detail.executionLog} /> : null}
      <Stage4Report report={detail.report} taskId={detail.task.id} />
    </>
  );
}

function Welcome({
  onPick,
}: {
  onPick: (text: string, mode?: OrchestrationMode) => Promise<void>;
}) {
  const suggestions = [
    '研究京东众筹频道的用户与增长策略',
    '基于公开资料分析行业趋势与主要竞品',
    '为新品类制定市场、用户与供给策略',
  ];
  return (
    <div className="welcome">
      <h1>你想研究什么?</h1>
      <p>选择单 Skill 或多 Skill 方案，补齐真实输入后直接生成一份研究报告。</p>
      <div className="welcome-suggests">
        {suggestions.map((suggestion) => (
          <button key={suggestion} className="welcome-chip" onClick={() => { void onPick(suggestion); }}>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return <div style={{ padding: 16, color: 'var(--text-dim)' }}><span className="spinner" /> {text}</div>;
}

function Notice({ text }: { text: string }) {
  return <div style={{ padding: 16, color: 'var(--text-dim)' }}>{text}</div>;
}

function ErrorCard({ message }: { message: string }) {
  return <div role="alert" style={{ color: 'var(--danger)', padding: 16 }}>{message}</div>;
}
