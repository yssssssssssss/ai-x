import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type OrchestrationMode,
  type SystemCapabilitiesResponse,
  type TaskHistoryPreferencePatch,
  type User,
} from '../api/client.ts';
import { Composer } from '../components/Composer.tsx';
import { Sidebar } from '../components/Sidebar.tsx';
import { SkillNativeTaskFlow } from '../components/SkillNativeTaskFlow.tsx';
import { useSkillNativeFlow } from '../hooks/useSkillNativeFlow.ts';
import {
  applyTaskHistoryPreferences,
  type HistoryTaskSummary,
} from '../task-history.ts';
import { Labs } from './Labs.tsx';

type View = 'task' | 'labs';

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
  const flow = useSkillNativeFlow();

  const refreshHistory = useCallback(() => {
    void Promise.all([
      api.listTaskHistoryPreferences(),
      api.listResearchTasks(),
    ]).then(([preferences, tasks]) => {
      setHistory(applyTaskHistoryPreferences(tasks.tasks, preferences.preferences));
    }).catch(() => undefined);
  }, []);

  useEffect(refreshHistory, [refreshHistory]);
  useEffect(() => {
    if (flow.task) refreshHistory();
  }, [flow.task?.stateVersion, refreshHistory]);

  function newTask(): void {
    setView('task');
    flow.reset();
  }

  async function openTask(task: HistoryTaskSummary): Promise<void> {
    setView('task');
    await flow.openTask(task.id);
  }

  async function updateHistoryTask(
    task: HistoryTaskSummary,
    patch: TaskHistoryPreferencePatch,
  ): Promise<void> {
    const { preference } = await api.updateTaskHistoryPreference('native', task.id, patch);
    setHistory((current) => applyTaskHistoryPreferences(current, [preference]));
    if (patch.hidden && task.id === flow.task?.id) newTask();
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
                  zeroPublicationEnabled={capabilities?.zeroPublicationEnabled === true}
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
      <p>平台会分析需求、匹配完整 Skill 包，并在确认后按原版说明执行。</p>
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
