import { useEffect, useRef, useState } from 'react';
import {
  api,
  type ClarificationRequiredResponse,
  type ClarifyControlTaskRequest,
  type ControlDeliverableResponse,
  type ControlExecutionResult,
  type ControlPlanCandidatesResponse,
  type CurrentPlanCandidate,
  type ExecLogRow,
  type PlanProgress,
  type PlanResponse,
  type Upload,
} from '../api/client.ts';
import {
  beginClarificationSubmission,
  buildConfirmationAnswers,
  createClarificationSubmissionState,
  createRequestId,
  executionStepsToExecLog,
  hydrateCurrentTask,
  settleClarificationSubmission,
  type ConfirmationRequirement,
  type ReportState,
} from '../current-flow-state.ts';

const CURRENT_TASK_STORAGE_KEY = 'ur_current_task_id';

// Current 同页状态机；Legacy 任务只在 Workbench 历史详情中只读展示。
export type Phase =
  | 'idle'
  | 'planning'
  | 'clarifying'
  | 'picking'
  | 'selecting'
  | 'planned'
  | 'awaiting-approval'
  | 'executing'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'error';

function planView(
  response: ControlPlanCandidatesResponse,
  candidate: CurrentPlanCandidate,
): PlanResponse {
  return {
    conversationId: response.conversationId,
    taskId: response.task.id,
    task: response.structuredTask,
    activatedNodes: response.activatedNodes,
    plan: {
      steps: candidate.plan.steps,
      activated_nodes: response.activatedNodes,
      assumptions: response.structuredTask.assumptions,
    },
    pendingUploads: candidate.pendingInputs,
  };
}

function confirmationRequirements(confirmations: unknown[]): ConfirmationRequirement[] {
  return confirmations.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as { key?: unknown; question?: unknown; suggestion?: unknown };
    if (typeof candidate.key !== 'string' || candidate.key.trim() === '') return [];
    return [{
      key: candidate.key,
      question: typeof candidate.question === 'string' ? candidate.question : undefined,
      suggestion: candidate.suggestion,
    }];
  });
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useTaskFlow() {
  const [clarification, setClarification] = useState<ClarificationRequiredResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidatesResp, setCandidatesResp] = useState<ControlPlanCandidatesResponse | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<CurrentPlanCandidate | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [stateVersion, setStateVersion] = useState<number | null>(null);
  const [originalInput, setOriginalInput] = useState('');
  const [exec, setExec] = useState<ControlExecutionResult | null>(null);
  const [executionSteps, setExecutionSteps] = useState<ExecLogRow[]>([]);
  const [deliverable, setDeliverable] = useState<ControlDeliverableResponse | null>(null);
  const [reportState, setReportState] = useState<ReportState>('idle');
  const [deliverableError, setDeliverableError] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<PlanProgress[]>([]);
  const clarificationSubmission = useRef(createClarificationSubmissionState());
  const [clarificationSubmitting, setClarificationSubmitting] = useState(false);

  async function refreshExecutionSteps(taskId: string): Promise<void> {
    const current = await api.controlTask(taskId);
    setStateVersion(current.task.stateVersion);
    setExecutionSteps(executionStepsToExecLog(current.executionSteps));
  }

  async function loadDeliverable(taskId: string): Promise<void> {
    setReportState('loading');
    setDeliverableError('');
    try {
      const response = await api.controlDeliverable(taskId);
      setDeliverable(response);
      setOriginalInput((previous) => previous || response.deliverable.payload.researchGoal);
      setReportState('ready');
    } catch (cause) {
      setDeliverableError(message(cause, '报告加载失败'));
      setReportState('report-loading-error');
    }
  }

  useEffect(() => {
    const taskId = localStorage.getItem(CURRENT_TASK_STORAGE_KEY);
    if (!taskId) return;
    let cancelled = false;
    setCurrentTaskId(taskId);
    void (async () => {
      try {
        const current = await api.controlTask(taskId);
        const hydrated = hydrateCurrentTask(current);
        if (cancelled) return;
        setOriginalInput(hydrated.originalInput);
        setStateVersion(hydrated.stateVersion);
        if (hydrated.phase === 'clarifying') {
          setClarification(hydrated.clarification as ClarificationRequiredResponse);
          setPhase('clarifying');
          setError('');
          return;
        }
        if (hydrated.phase === 'picking') {
          setCandidatesResp(hydrated.candidatesResp);
          setPhase('picking');
          setError('');
          return;
        }
        const { state, stateVersion: restoredStateVersion, currentAttemptId } = current.task;
        if (state !== 'completed' && state !== 'completed_with_gaps') return;
        if (!currentAttemptId) throw new Error('completed Current task has no attempt');
        if (cancelled) return;
        setExec({
          attemptId: currentAttemptId,
          state,
          stateVersion: restoredStateVersion,
          status: state,
          executionDisabled: false,
        });
        setExecutionSteps(executionStepsToExecLog(current.executionSteps));
        setStateVersion(restoredStateVersion);
        setError('');
        setPhase('done');
        setReportState('loading');
        try {
          const restoredDeliverable = await api.controlDeliverable(taskId);
          if (cancelled) return;
          setDeliverable(restoredDeliverable);
          setOriginalInput(restoredDeliverable.deliverable.payload.researchGoal);
          setReportState('ready');
        } catch (cause) {
          if (cancelled) return;
          setDeliverableError(message(cause, '报告加载失败'));
          setReportState('report-loading-error');
        }
      } catch (cause) {
        if (cancelled) return;
        setError(message(cause, 'Current 任务恢复失败'));
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function reset() {
    clarificationSubmission.current = createClarificationSubmissionState();
    setClarificationSubmitting(false);
    localStorage.removeItem(CURRENT_TASK_STORAGE_KEY);
    setPhase('idle');
    setClarification(null);
    setCandidatesResp(null);
    setSelectedCandidate(null);
    setPlan(null);
    setCurrentTaskId(null);
    setStateVersion(null);
    setOriginalInput('');
    setExec(null);
    setExecutionSteps([]);
    setDeliverable(null);
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
  }

  async function submitInput(text: string) {
    clarificationSubmission.current = createClarificationSubmissionState();
    setClarificationSubmitting(false);
    localStorage.removeItem(CURRENT_TASK_STORAGE_KEY);
    setPhase('planning');
    setClarification(null);
    setCandidatesResp(null);
    setSelectedCandidate(null);
    setPlan(null);
    setCurrentTaskId(null);
    setStateVersion(null);
    setOriginalInput(text);
    setExec(null);
    setExecutionSteps([]);
    setDeliverable(null);
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    try {
      const response = await api.planControlStream(
        { originalInput: text },
        {
          onProgress: (event) => {
            setProgress((previous) => {
              const index = previous.findIndex((item) => item.phase === event.phase);
              if (index < 0) return [...previous, event];
              const next = [...previous];
              next[index] = event;
              return next;
            });
          },
        },
      );
      localStorage.setItem(CURRENT_TASK_STORAGE_KEY, response.task.id);
      setCurrentTaskId(response.task.id);
      setStateVersion(response.task.stateVersion);
      if (response.status === 'clarification_required') {
        setClarification(response);
        setCandidatesResp(null);
        setPhase('clarifying');
      } else {
        setCandidatesResp(response);
        setPhase('picking');
      }
    } catch (cause) {
      setError(message(cause, '规划失败'));
      setPhase('error');
    }
  }

  async function submitClarification(input: Omit<ClarifyControlTaskRequest, 'idempotencyKey'>) {
    if (!clarification) return;
    const started = beginClarificationSubmission(
      clarificationSubmission.current,
      { taskId: clarification.task.id, ...input },
      () => ({ requestId: createRequestId(), idempotencyKey: createRequestId() }),
    );
    clarificationSubmission.current = started.state;
    if (!started.request) return;
    const { requestId, idempotencyKey } = started.request;
    setClarificationSubmitting(true);
    setPhase('clarifying');
    setError('');
    try {
      const response = await api.clarifyControlTask(clarification.task.id, {
        ...input,
        idempotencyKey,
      });
      const settled = settleClarificationSubmission(
        clarificationSubmission.current,
        requestId,
        'success',
      );
      clarificationSubmission.current = settled.state;
      if (!settled.accepted) return;
      setClarificationSubmitting(false);
      setStateVersion(response.task.stateVersion);
      if (response.status === 'clarification_required') {
        setClarification(response);
        setPhase('clarifying');
      } else {
        setClarification(null);
        setCandidatesResp(response);
        setPhase('picking');
      }
    } catch (cause) {
      const settled = settleClarificationSubmission(
        clarificationSubmission.current,
        requestId,
        'failure',
      );
      clarificationSubmission.current = settled.state;
      if (!settled.accepted) return;
      setClarificationSubmitting(false);
      setError(message(cause, '澄清提交失败'));
      setPhase('clarifying');
    }
  }

  async function pickCandidate(planVersionId: CurrentPlanCandidate['planVersionId']) {
    if (!candidatesResp || stateVersion == null) return;
    const candidate = candidatesResp.candidates.find((item) => item.planVersionId === planVersionId);
    if (!candidate) return;
    setSelectedCandidate(candidate);
    setPhase('selecting');
    setError('');
    try {
      const selected = await api.selectControlPlan(candidatesResp.task.id, {
        expectedVersion: stateVersion,
        planVersionId,
        idempotencyKey: createRequestId(),
      });
      setStateVersion(selected.stateVersion);
      setPlan(planView(candidatesResp, candidate));
      setPhase('planned');
    } catch (cause) {
      setError(message(cause, '候选选择失败'));
      setSelectedCandidate(null);
      setPlan(null);
      setPhase('picking');
    }
  }

  async function finishExecution(result: ControlExecutionResult) {
    const taskId = currentTaskId ?? candidatesResp?.task.id;
    if (!taskId) return;
    setExec(result);
    setStateVersion(result.stateVersion);
    if (result.state === 'paused' || result.status === 'paused') {
      setPhase('paused');
      try {
        await refreshExecutionSteps(taskId);
      } catch (cause) {
        setError(message(cause, '执行步骤加载失败'));
      }
      return;
    }

    setPhase('done');
    setReportState('loading');
    setDeliverableError('');
    try {
      await refreshExecutionSteps(taskId);
    } catch (cause) {
      setError(message(cause, '执行步骤加载失败'));
    }
    await loadDeliverable(taskId);
  }

  async function execute(version: number) {
    if (!candidatesResp || !selectedCandidate) return;
    const result = await api.executeControlPlan(candidatesResp.task.id, {
      expectedVersion: version,
      planVersionId: selectedCandidate.planVersionId,
      idempotencyKey: createRequestId(),
    });
    await finishExecution(result);
  }

  async function confirmAndExecute(
    userAnswers: Record<string, unknown>,
    uploads: Upload[] = [],
  ) {
    if (!candidatesResp || !selectedCandidate || stateVersion == null) return;
    setPhase('executing');
    setError('');
    try {
      const answers = buildConfirmationAnswers(
        confirmationRequirements('confirmations' in candidatesResp.structuredTask
          ? candidatesResp.structuredTask.confirmations
          : candidatesResp.structuredTask.clarification_questions),
        userAnswers,
      );
      const uploadsByRole = new Map<string, Array<{ dataUrl: string }>>();
      for (const upload of uploads) {
        const value = { dataUrl: upload.dataUrl };
        const values = uploadsByRole.get(upload.role);
        if (values) values.push(value);
        else uploadsByRole.set(upload.role, [value]);
      }
      const inputValues: Record<string, unknown> = Object.create(null);
      for (const [role, values] of uploadsByRole) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === role);
        if (!pendingInput) continue;
        inputValues[role] = pendingInput.multiple ? values : values[0];
      }
      const confirmed = await api.confirmControlPlan(candidatesResp.task.id, {
        expectedVersion: stateVersion,
        planVersionId: selectedCandidate.planVersionId,
        confirmationAnswers: answers,
        inputValues,
        idempotencyKey: createRequestId(),
      });
      setStateVersion(confirmed.stateVersion);
      if (confirmed.state === 'ready') {
        await execute(confirmed.stateVersion);
      } else if (confirmed.state === 'awaiting_approval') {
        setPhase('awaiting-approval');
      } else {
        setError(`确认后任务进入未预期状态：${confirmed.state}`);
        setPhase('error');
      }
    } catch (cause) {
      setError(message(cause, '确认或执行失败'));
      setPhase('error');
    }
  }

  async function resumeStep(action: 'retry' | 'abort') {
    if (!candidatesResp || stateVersion == null) return;
    setPhase('executing');
    setError('');
    try {
      const resumed = await api.resumeControlPlan(candidatesResp.task.id, {
        expectedVersion: stateVersion,
        action,
        failedStepNo: exec?.failedStepNo,
        idempotencyKey: createRequestId(),
      });
      setStateVersion(resumed.stateVersion);
      try {
        await refreshExecutionSteps(candidatesResp.task.id);
      } catch (cause) {
        setError(message(cause, '执行步骤加载失败'));
      }
      if (resumed.state === 'cancelled') {
        setPhase('cancelled');
      } else if (resumed.state === 'ready') {
        await execute(resumed.stateVersion);
      } else if (resumed.state === 'paused') {
        setPhase('paused');
      } else {
        setError(`恢复后任务进入未预期状态：${resumed.state}`);
        setPhase('error');
      }
    } catch (cause) {
      setError(message(cause, '恢复失败'));
      setPhase('error');
    }
  }

  function retryDeliverable() {
    if (currentTaskId) void loadDeliverable(currentTaskId);
  }

  return {
    phase,
    clarification,
    submitClarification,
    clarificationSubmitting,
    candidatesResp,
    selectedCandidate,
    selectedCandidateId: selectedCandidate?.planVersionId ?? null,
    plan,
    stateVersion,
    planVersionId: selectedCandidate?.planVersionId ?? null,
    originalInput,
    exec,
    executionSteps,
    deliverable,
    reportState,
    deliverableError,
    error,
    progress,
    reset,
    submitInput,
    pickCandidate,
    confirmAndExecute,
    resumeStep,
    retryDeliverable,
  };
}
