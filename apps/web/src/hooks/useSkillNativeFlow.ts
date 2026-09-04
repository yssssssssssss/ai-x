import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ConfirmSkillNativeTaskRequest,
  type OrchestrationMode,
  type SkillNativeTaskView,
  type SkillNativeZeroPublication,
} from '../api/client.ts';

const STORAGE_KEY = 'ur_skill_native_task_id';

export type SkillNativePhase =
  | 'idle'
  | 'loading-task'
  | 'planning'
  | 'picking'
  | 'planned'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'error';

function phaseOf(task: SkillNativeTaskView): SkillNativePhase {
  if (task.state === 'awaiting_selection') return 'picking';
  if (task.state === 'awaiting_confirmation') return 'planned';
  if (task.state === 'ready') return 'ready';
  if (task.state === 'executing') return 'executing';
  if (task.state === 'paused') return 'paused';
  if (task.state === 'completed' || task.state === 'completed_with_gaps') return 'done';
  if (task.state === 'failed') return 'failed';
  return 'cancelled';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useSkillNativeFlow() {
  const [phase, setPhase] = useState<SkillNativePhase>('idle');
  const [task, setTask] = useState<SkillNativeTaskView | null>(null);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const applyTask = useCallback(async (next: SkillNativeTaskView, expectedGeneration: number): Promise<void> => {
    if (expectedGeneration !== generation.current) return;
    setTask(next);
    setPhase(phaseOf(next));
    setError('');
    if (next.state !== 'completed' && next.state !== 'completed_with_gaps') {
      setReportHtml(null);
      return;
    }
    try {
      const html = await api.researchReportHtml(next.id);
      if (expectedGeneration === generation.current) setReportHtml(html);
    } catch (cause) {
      if (expectedGeneration === generation.current) setError(errorMessage(cause, '报告加载失败'));
    }
  }, []);

  const loadTask = useCallback(async (
    taskId: string,
    currentGeneration: number,
    showLoading: boolean,
  ): Promise<void> => {
    if (showLoading) setPhase('loading-task');
    try {
      const loaded = await api.researchTask(taskId);
      if (currentGeneration === generation.current) localStorage.setItem(STORAGE_KEY, taskId);
      await applyTask(loaded, currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      setError(errorMessage(cause, '任务读取失败'));
      setPhase('error');
    }
  }, [applyTask]);

  const openTask = useCallback(async (taskId: string, showLoading = true): Promise<void> => {
    const currentGeneration = ++generation.current;
    await loadTask(taskId, currentGeneration, showLoading);
  }, [loadTask]);

  useEffect(() => {
    const taskId = localStorage.getItem(STORAGE_KEY);
    if (taskId) void openTask(taskId);
  }, [openTask]);

  useEffect(() => {
    if (!task || phase !== 'executing') return;
    const currentGeneration = generation.current;
    const timer = window.setInterval(() => { void loadTask(task.id, currentGeneration, false); }, 1_000);
    return () => window.clearInterval(timer);
  }, [loadTask, phase, task]);

  function reset(): void {
    generation.current += 1;
    localStorage.removeItem(STORAGE_KEY);
    setTask(null);
    setReportHtml(null);
    setError('');
    setPhase('idle');
  }

  async function submitInput(text: string, orchestrationMode: OrchestrationMode = 'single_skill'): Promise<void> {
    const currentGeneration = ++generation.current;
    setPhase('planning');
    setTask(null);
    setReportHtml(null);
    setError('');
    try {
      const created = await api.createResearchTask({ originalInput: text, orchestrationMode });
      if (currentGeneration !== generation.current) return;
      localStorage.setItem(STORAGE_KEY, created.id);
      await applyTask(created, currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      setError(errorMessage(cause, '规划失败'));
      setPhase('error');
    }
  }

  async function selectSolution(solutionId: string): Promise<void> {
    if (!task) return;
    const currentTask = task;
    const currentGeneration = generation.current;
    setPhase('planning');
    try {
      await applyTask(await api.selectResearchSolution(currentTask.id, {
        expectedVersion: currentTask.stateVersion,
        solutionId,
      }), currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      const message = errorMessage(cause, '方案选择失败');
      await loadTask(currentTask.id, currentGeneration, false);
      if (currentGeneration === generation.current) setError(message);
    }
  }

  async function confirm(answers: ConfirmSkillNativeTaskRequest['answers']): Promise<void> {
    if (!task) return;
    const currentTask = task;
    const currentGeneration = generation.current;
    setPhase('planning');
    try {
      await applyTask(await api.confirmResearchTask(currentTask.id, {
        expectedVersion: currentTask.stateVersion,
        answers,
      }), currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      const message = errorMessage(cause, '输入确认失败');
      await loadTask(currentTask.id, currentGeneration, false);
      if (currentGeneration === generation.current) setError(message);
    }
  }

  async function execute(version = task?.stateVersion): Promise<void> {
    if (!task || version === undefined) return;
    const currentTask = task;
    const currentGeneration = generation.current;
    setPhase('executing');
    setError('');
    try {
      await applyTask(await api.executeResearchTask(currentTask.id, version), currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      setError(errorMessage(cause, '执行失败'));
      await loadTask(currentTask.id, currentGeneration, false);
    }
  }

  async function cancel(): Promise<void> {
    if (!task) return;
    const currentTask = task;
    const currentGeneration = generation.current;
    try {
      await applyTask(await api.cancelResearchTask(currentTask.id, currentTask.stateVersion), currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      setError(errorMessage(cause, '取消失败'));
    }
  }

  async function retry(): Promise<void> {
    if (!task) return;
    const currentTask = task;
    const currentGeneration = generation.current;
    try {
      const ready = await api.resumeResearchTask(currentTask.id, currentTask.stateVersion);
      if (currentGeneration !== generation.current) return;
      setTask(ready);
      setPhase('executing');
      await applyTask(
        await api.executeResearchTask(ready.id, ready.stateVersion),
        currentGeneration,
      );
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      setError(errorMessage(cause, '恢复失败'));
    }
  }

  async function replan(): Promise<void> {
    if (!task) return;
    const currentTask = task;
    const currentGeneration = generation.current;
    setPhase('planning');
    try {
      await applyTask(await api.replanResearchTask(currentTask.id, currentTask.stateVersion), currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      const message = errorMessage(cause, '重新规划失败');
      await loadTask(currentTask.id, currentGeneration, false);
      if (currentGeneration === generation.current) setError(message);
    }
  }

  async function publishToZero(): Promise<SkillNativeZeroPublication | null> {
    if (!task) return null;
    const currentTask = task;
    const currentGeneration = generation.current;
    setError('');
    try {
      const publication = await api.publishResearchTaskToZero(currentTask.id, {
        expectedVersion: currentTask.stateVersion,
        target: { mode: 'current_page' },
      });
      return currentGeneration === generation.current ? publication : null;
    } catch (cause) {
      if (currentGeneration !== generation.current) return null;
      setError(errorMessage(cause, 'Zero 发布失败'));
      return null;
    }
  }

  return {
    phase,
    task,
    reportHtml,
    error,
    reset,
    openTask,
    submitInput,
    selectSolution,
    confirm,
    execute,
    cancel,
    retry,
    replan,
    publishToZero,
  };
}
