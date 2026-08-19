import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ClarificationRequiredResponse,
  type ClarifyControlTaskRequest,
  type ControlApprovalRequirement,
  type ControlDeliverableResponse,
  type ControlExecutionResult,
  type ControlPlanRecovery,
  type ControlPlanCandidatesResponse,
  type CurrentTaskReadResponse,
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
  currentExecutionGapCount,
  executionPlanStepsForTask,
  executionStepsToExecLog,
  hydrateCurrentTask,
  selectAuthoritativeFailedStep,
  settleClarificationSubmission,
  type ConfirmationRequirement,
  type ExecutionPlanStepView,
  type ReportState,
} from '../current-flow-state.ts';

const CURRENT_TASK_STORAGE_KEY = 'ur_current_task_id';

// Current 同页状态机；Legacy 任务只在 Workbench 历史详情中只读展示。
export type Phase =
  | 'idle'
  | 'loading-task'
  | 'planning'
  | 'clarifying'
  | 'picking'
  | 'selecting'
  | 'planned'
  | 'awaiting-approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing-report'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'error';

const AUTO_REFRESH_PHASES = new Set<Phase>([
  'awaiting-approval',
  'executing',
  'reviewing',
  'composing-report',
]);
const INITIAL_POLL_DELAY_MS = 2_000;
const MAX_POLL_DELAY_MS = 16_000;

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

export function useTaskFlow(actorRole?: string) {
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
  const [executionPlanSteps, setExecutionPlanSteps] = useState<ExecutionPlanStepView[]>([]);
  const [deliverable, setDeliverable] = useState<ControlDeliverableResponse | null>(null);
  const [reportState, setReportState] = useState<ReportState>('idle');
  const [deliverableError, setDeliverableError] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<PlanProgress[]>([]);
  const [approvalRequirements, setApprovalRequirements] = useState<ControlApprovalRequirement[]>([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [planRecovery, setPlanRecovery] = useState<ControlPlanRecovery | null>(null);
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const clarificationSubmission = useRef(createClarificationSubmissionState());
  const restoreGeneration = useRef(0);
  const [clarificationSubmitting, setClarificationSubmitting] = useState(false);

  async function refreshExecutionSteps(taskId: string): Promise<void> {
    const current = await api.controlTask(taskId);
    setStateVersion(current.task.stateVersion);
    setExecutionSteps(executionStepsToExecLog(current.executionSteps));
    setExecutionPlanSteps(executionPlanStepsForTask(current));
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

  const applyCurrentTask = useCallback(async (
    current: CurrentTaskReadResponse,
    generation: number,
  ): Promise<void> => {
    const hydrated = hydrateCurrentTask(current);
    if (generation !== restoreGeneration.current) return;

    const restoredSteps = executionStepsToExecLog(current.executionSteps);
    const selected = hydrated.selectedCandidate;
    setOriginalInput(hydrated.originalInput);
    setStateVersion(hydrated.stateVersion);
    setClarification(hydrated.clarification as ClarificationRequiredResponse | null);
    setCandidatesResp(hydrated.candidatesResp);
    setSelectedCandidate(selected);
    setPlan(selected && hydrated.candidatesResp ? planView(hydrated.candidatesResp, selected) : null);
    setExecutionSteps(restoredSteps);
    setExecutionPlanSteps(executionPlanStepsForTask(current));
    setDeliverable(null);
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    setApprovalRequirements(current.approvalRequirements ?? []);
    setPlanRecovery(current.planRecovery ?? null);

    const { state, stateVersion: restoredStateVersion, currentAttemptId } = current.task;
    if (hydrated.phase === 'paused') {
      const failedStep = selectAuthoritativeFailedStep(current.executionSteps);
      setExec({
        attemptId: currentAttemptId!,
        state,
        stateVersion: restoredStateVersion,
        status: 'paused',
        executionDisabled: false,
        failedStepNo: failedStep?.stepNo,
        failure: failedStep?.failure ?? undefined,
      });
    } else if (hydrated.phase === 'done') {
      setExec({
        attemptId: currentAttemptId!,
        state,
        stateVersion: restoredStateVersion,
        status: state as 'completed' | 'completed_with_gaps',
        executionDisabled: false,
        gapCount: currentExecutionGapCount({
          plan: current.activePlan?.plan,
          executionSteps: current.executionSteps,
        }),
      });
    } else {
      setExec(null);
    }
    setPhase(hydrated.phase);

    if (hydrated.phase !== 'done') return;
    setReportState('loading');
    try {
      const restoredDeliverable = await api.controlDeliverable(current.task.id);
      if (generation !== restoreGeneration.current) return;
      setDeliverable(restoredDeliverable);
      setOriginalInput(restoredDeliverable.deliverable.payload.researchGoal);
      setReportState('ready');
    } catch (cause) {
      if (generation !== restoreGeneration.current) return;
      setDeliverableError(message(cause, '报告加载失败'));
      setReportState('report-loading-error');
    }
  }, []);

  const restoreTask = useCallback(async (
    taskId: string,
    options: { loading?: boolean; silent?: boolean } = {},
  ): Promise<boolean> => {
    const generation = ++restoreGeneration.current;
    localStorage.setItem(CURRENT_TASK_STORAGE_KEY, taskId);
    setCurrentTaskId(taskId);
    if (options.loading !== false) {
      setPhase('loading-task');
      setError('');
    }
    try {
      const current = await api.controlTask(taskId);
      if (generation !== restoreGeneration.current) return false;
      await applyCurrentTask(current, generation);
      return generation === restoreGeneration.current;
    } catch (cause) {
      if (generation !== restoreGeneration.current) return false;
      setError(message(cause, 'Current 任务恢复失败'));
      if (!options.silent) setPhase('error');
      return false;
    }
  }, [applyCurrentTask]);

  useEffect(() => {
    const taskId = localStorage.getItem(CURRENT_TASK_STORAGE_KEY);
    if (taskId) void restoreTask(taskId);
  }, [restoreTask]);

  useEffect(() => {
    if (!currentTaskId || !AUTO_REFRESH_PHASES.has(phase)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = INITIAL_POLL_DELAY_MS;
    const poll = async (): Promise<void> => {
      const refreshed = await restoreTask(currentTaskId, { loading: false, silent: true });
      if (cancelled) return;
      delay = refreshed ? INITIAL_POLL_DELAY_MS : Math.min(delay * 2, MAX_POLL_DELAY_MS);
      timer = setTimeout(() => { void poll(); }, delay);
    };
    timer = setTimeout(() => { void poll(); }, delay);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentTaskId, phase, restoreTask]);

  async function openTask(taskId: string): Promise<void> {
    await restoreTask(taskId);
  }

  function reset() {
    restoreGeneration.current += 1;
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
    setExecutionPlanSteps([]);
    setDeliverable(null);
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    setApprovalRequirements([]);
    setPlanRecovery(null);
    setRevisionSubmitting(false);
  }

  async function submitInput(text: string) {
    restoreGeneration.current += 1;
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
    setExecutionPlanSteps([]);
    setDeliverable(null);
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    setApprovalRequirements([]);
    setPlanRecovery(null);
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
      setExecutionPlanSteps(candidate.plan.steps);
      setPlanRecovery(null);
      setPhase('planned');
    } catch (cause) {
      setError(message(cause, '候选选择失败'));
      setSelectedCandidate(null);
      setPlan(null);
      setExecutionPlanSteps([]);
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

  async function startExecution() {
    if (stateVersion == null) return;
    setPhase('executing');
    setError('');
    try {
      await execute(stateVersion);
    } catch (cause) {
      setError(message(cause, '执行失败'));
      setPhase('error');
    }
  }

  async function confirmPlan(
    userAnswers: Record<string, unknown>,
    pendingValues: Record<string, unknown> = {},
    uploads: Upload[] = [],
  ) {
    if (!candidatesResp || !selectedCandidate || stateVersion == null) return;
    if (planRecovery) {
      setError('当前计划需要重新生成，不能直接确认');
      setPhase('error');
      return;
    }
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
      for (const [role, value] of Object.entries(pendingValues)) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === role);
        if (pendingInput?.kind === 'value') inputValues[role] = value;
      }
      for (const [role, values] of uploadsByRole) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === role);
        if (pendingInput?.kind !== 'visual') continue;
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
        setPhase('ready');
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

  async function revisePlan(revisionInstruction = '按当前输入契约重新生成计划，保持原研究目标和当前候选方向不变。'): Promise<void> {
    if (!currentTaskId || !selectedCandidate || stateVersion == null || revisionSubmitting) return;
    setRevisionSubmitting(true);
    setError('');
    try {
      await api.reviseControlPlan(currentTaskId, {
        expectedVersion: stateVersion,
        revisionInstruction,
        idempotencyKey: createRequestId(),
      });
      await restoreTask(currentTaskId);
    } catch (cause) {
      setError(message(cause, '计划重新生成失败'));
      setPhase('error');
    } finally {
      setRevisionSubmitting(false);
    }
  }

  async function approveTask(gateKey: string): Promise<void> {
    if (!currentTaskId || !selectedCandidate || stateVersion == null) return;
    const requirement = approvalRequirements.find((item) => item.gateKey === gateKey);
    if (
      !requirement
      || requirement.decision !== 'pending'
      || !requirement.canApprove
      || (actorRole !== undefined && requirement.requiredAuthority !== actorRole)
    ) return;

    setApprovalSubmitting(true);
    setError('');
    try {
      await api.approveControlPlan(currentTaskId, {
        expectedVersion: stateVersion,
        planVersionId: selectedCandidate.planVersionId,
        gateKey,
        decision: 'approved',
        idempotencyKey: createRequestId(),
      });
      await restoreTask(currentTaskId, { loading: false });
    } catch (cause) {
      setError(message(cause, '审批提交失败'));
    } finally {
      setApprovalSubmitting(false);
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
    executionPlanSteps,
    deliverable,
    reportState,
    deliverableError,
    error,
    progress,
    currentTaskId,
    approvalRequirements,
    approvalSubmitting,
    planRecovery,
    revisionSubmitting,
    reset,
    openTask,
    submitInput,
    pickCandidate,
    confirmPlan,
    revisePlan,
    approveTask,
    startExecution,
    resumeStep,
    retryDeliverable,
  };
}
