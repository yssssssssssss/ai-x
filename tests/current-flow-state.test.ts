import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

interface ConfirmationRequirement {
  key: string;
  question?: string;
  suggestion?: unknown;
}

interface ServerExecutionStep {
  stepNo: number;
  stepName: string;
  actorType: string;
  actorId: string;
  skillProvenance: Record<string, unknown> | null;
  state: 'running' | 'succeeded' | 'skipped' | 'failed';
  failure?: Record<string, unknown> | null;
}

interface ExecLogRow {
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
  skillProvenance: Record<string, unknown> | null;
  status: 'running' | 'succeeded' | 'skipped' | 'failed';
}

interface CompletedExecution {
  attemptId: string;
  state: 'completed' | 'completed_with_gaps';
  status: 'completed' | 'completed_with_gaps';
  stateVersion: number;
}

interface DeliverableReadState {
  phase: 'executing' | 'done' | 'error';
  reportState: 'idle' | 'loading' | 'ready' | 'report-loading-error';
  execution: CompletedExecution | null;
  deliverable: unknown | null;
  executionError: string | null;
  reportError: string | null;
}

interface FlowTransition {
  state: DeliverableReadState;
  effect: 'load-deliverable' | null;
}

interface ClarificationSubmissionState {
  pending: { fingerprint: string; idempotencyKey: string } | null;
  activeRequestId: string | null;
}

interface ClarificationSubmissionRequest {
  requestId: string;
  idempotencyKey: string;
}

interface LegacyHistoryTask {
  id: string;
  original_input: string;
  task_type: string | null;
  status: string;
  created_at?: string;
}

interface CurrentHistoryTask {
  id: string;
  originalInput: string;
  taskType: string | null;
  state: string;
  createdAt: string;
  updatedAt?: string;
}

interface HistoryTask extends LegacyHistoryTask {
  kind: 'legacy' | 'current';
}

interface CurrentFlowStateModule {
  buildConfirmationAnswers(
    requirements: ConfirmationRequirement[],
    userAnswers: Record<string, unknown>,
  ): Record<string, unknown>;
  executionStepsToExecLog(steps: ServerExecutionStep[]): ExecLogRow[];
  selectAuthoritativeFailedStep(steps: readonly ServerExecutionStep[]): ServerExecutionStep | undefined;
  executionFailureAllowsAction(failure: Record<string, unknown> | null | undefined, action: string): boolean;
  finishExecution(state: DeliverableReadState, execution: CompletedExecution): FlowTransition;
  failDeliverableRead(state: DeliverableReadState, error: string): FlowTransition;
  retryDeliverable(state: DeliverableReadState): FlowTransition;
  hydrateCurrentTask(input: {
    task: {
      id: string;
      state: string;
      stateVersion: number;
      originalInput: string;
      conversationId: string;
      structuredTask: unknown;
      activePlanVersionId?: string | null;
      currentAttemptId?: string | null;
    };
    candidates?: unknown[];
    activatedNodes?: string[];
    activePlan?: unknown;
  }): {
    phase: string;
    stateVersion: number;
    originalInput: string;
    clarification: unknown | null;
    candidatesResp: unknown | null;
    selectedCandidate: unknown | null;
  };
  taskStatePresentation(state: string): {
    label: string;
    group: 'action' | 'running' | 'finished';
    tone: 'action' | 'running' | 'success' | 'warning' | 'danger' | 'muted';
  };
  createClarificationSubmissionState(): ClarificationSubmissionState;
  beginClarificationSubmission(
    state: ClarificationSubmissionState,
    payload: unknown,
    createIdentity: () => ClarificationSubmissionRequest,
  ): { state: ClarificationSubmissionState; request: ClarificationSubmissionRequest | null };
  settleClarificationSubmission(
    state: ClarificationSubmissionState,
    requestId: string,
    outcome: 'success' | 'failure',
  ): { state: ClarificationSubmissionState; accepted: boolean };
  mergeTaskHistory(
    legacyTasks: LegacyHistoryTask[],
    currentTasks: CurrentHistoryTask[],
  ): HistoryTask[];
  createRequestId(source: {
    randomUUID?: () => string;
    getRandomValues(values: Uint8Array): Uint8Array;
  }): string;
}
interface ClarificationQuestion {
  key: string;
  question: string;
  rationale: string;
}

interface ClarificationRequirement {
  clarification_questions: ClarificationQuestion[];
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
}

interface ClarificationStateModule extends CurrentFlowStateModule {
  buildClarificationSubmission(
    requirement: ClarificationRequirement,
    answers: Record<string, unknown>,
    assumptionEdits: Record<string, string>,
  ): { clarificationAnswers: Record<string, unknown>; assumptionEdits: Record<string, string> };
  missingBlockingAnswers(requirement: ClarificationRequirement, answers: Record<string, unknown>): string[];
}


const currentFlowStateModulePath: string = '../apps/web/src/current-flow-state.ts';
const currentFlowStateModuleFile = new URL(currentFlowStateModulePath, import.meta.url);

async function loadCurrentFlowStateModule(): Promise<CurrentFlowStateModule> {
  assert.equal(
    existsSync(currentFlowStateModuleFile),
    true,
    'pure Current Web flow-state module must exist',
  );
  const moduleExports = await import(currentFlowStateModulePath) as unknown as Record<string, unknown>;
  for (const exportName of [
    'buildConfirmationAnswers',
    'executionStepsToExecLog',
    'selectAuthoritativeFailedStep',
    'executionFailureAllowsAction',
    'finishExecution',
    'failDeliverableRead',
    'retryDeliverable',
    'buildClarificationSubmission',
    'missingBlockingAnswers',
    'mergeTaskHistory',
    'createRequestId',
    'taskStatePresentation',
  ]) {
    assert.equal(typeof moduleExports[exportName], 'function', `${exportName} must be exported`);
  }
  return moduleExports as unknown as CurrentFlowStateModule;
}

test('selects one authoritative failed step independent of response order', async () => {
  const {
    executionFailureAllowsAction,
    selectAuthoritativeFailedStep,
  } = await loadCurrentFlowStateModule();
  const step = (
    stepNo: number,
    kind: string,
    state: ServerExecutionStep['state'] = 'failed',
  ): ServerExecutionStep => ({
    stepNo,
    stepName: `step ${stepNo}`,
    actorType: 'system',
    actorId: kind,
    skillProvenance: null,
    state,
    failure: { kind },
  });

  assert.equal(selectAuthoritativeFailedStep([
    step(9, 'worker_loss'),
    step(4, 'artifact_invalidation'),
    step(10, 'schema'),
    step(2, 'artifact_invalidation'),
  ])?.stepNo, 2);
  assert.equal(selectAuthoritativeFailedStep([
    step(4, 'schema'),
    step(3, 'worker_loss'),
    step(8, 'artifact_invalidation', 'running'),
  ])?.stepNo, 3);
  assert.equal(selectAuthoritativeFailedStep([
    step(1, 'network'),
    step(5, 'safety'),
  ])?.stepNo, 5);
  assert.equal(executionFailureAllowsAction({ allowedActions: ['abort'] }, 'retry'), false);
  assert.equal(executionFailureAllowsAction({ allowedActions: ['abort'] }, 'abort'), true);
});
test('merges Legacy and Current history by newest creation time while preserving source kind', async () => {
  const { mergeTaskHistory } = await loadCurrentFlowStateModule();
  const history = mergeTaskHistory(
    [{
      id: 'legacy-task',
      original_input: 'Legacy history',
      task_type: 'legacy_research',
      status: 'completed',
      created_at: '2026-08-16T09:00:00.000Z',
    }],
    [{
      id: 'current-task',
      originalInput: 'Current history',
      taskType: 'design_audit',
      state: 'completed',
      createdAt: '2026-08-17T09:00:00.000Z',
    }],
  );

  assert.deepEqual(history, [
    {
      kind: 'current',
      id: 'current-task',
      original_input: 'Current history',
      task_type: 'design_audit',
      status: 'completed',
      created_at: '2026-08-17T09:00:00.000Z',
    },
    {
      kind: 'legacy',
      id: 'legacy-task',
      original_input: 'Legacy history',
      task_type: 'legacy_research',
      status: 'completed',
      created_at: '2026-08-16T09:00:00.000Z',
    },
  ]);
});

test('every Current workflow state has an explicit history label and group', async () => {
  const { taskStatePresentation } = await loadCurrentFlowStateModule();
  const expected = [
    ['awaiting_clarification', '待补充', 'action'],
    ['awaiting_selection', '待选方案', 'action'],
    ['awaiting_confirmation', '待确认', 'action'],
    ['awaiting_approval', '审批中', 'running'],
    ['ready', '待执行', 'action'],
    ['executing', '执行中', 'running'],
    ['paused', '已暂停', 'action'],
    ['reviewing', '质量复核中', 'running'],
    ['composing_report', '报告生成中', 'running'],
    ['completed', '已完成', 'finished'],
    ['completed_with_gaps', '已完成·有缺口', 'finished'],
    ['failed', '失败', 'finished'],
    ['cancelled', '已取消', 'finished'],
    ['rejected', '已驳回', 'finished'],
  ] as const;

  assert.deepEqual(
    expected.map(([state]) => {
      const presentation = taskStatePresentation(state);
      return [state, presentation.label, presentation.group];
    }),
    expected,
  );
  assert.throws(() => taskStatePresentation('unknown_state'), /unknown|unsupported|state/i);
});
test('creates request IDs with native randomUUID when available', async () => {
  const { createRequestId } = await loadCurrentFlowStateModule();
  assert.equal(createRequestId({
    randomUUID: () => 'native-request-id',
    getRandomValues: (values) => values,
  }), 'native-request-id');
});

test('creates RFC 4122 request IDs from getRandomValues when randomUUID is unavailable', async () => {
  const { createRequestId } = await loadCurrentFlowStateModule();
  const requestId = createRequestId({
    getRandomValues(values) {
      values.set(Array.from({ length: 16 }, (_, index) => index));
      return values;
    },
  });
  assert.equal(requestId, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});


test('hydrates an awaiting clarification task with its questions and raw input', async () => {
  const { hydrateCurrentTask } = await loadCurrentFlowStateModule() as CurrentFlowStateModule;
  const structuredTask = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    research_goal: '原始目标',
    target_audience: ['产品团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [],
    expected_deliverables: [],
    assumptions: [],
    ambiguities: [{ id: 'a', statement: '缺少受众', blocking: true }],
    clarification_questions: [{ key: 'audience', question: '受众是谁？', rationale: '影响方法' }],
    blocking_issues: [],
    business_domain: '产品',
    sensitivity: 'public',
    pii_detected: false,
  };
  const hydrated = hydrateCurrentTask({
    task: {
      id: 'task-refresh',
      state: 'awaiting_clarification',
      stateVersion: 4,
      originalInput: '$competitive-research 原始调用',
      conversationId: 'conversation-refresh',
      structuredTask,
    },
  });
  assert.equal(hydrated.phase, 'clarifying');
  assert.equal(hydrated.stateVersion, 4);
  assert.equal(hydrated.originalInput, '$competitive-research 原始调用');
  assert.deepEqual(hydrated.clarification, {
    kind: 'current',
    status: 'clarification_required',
    conversationId: 'conversation-refresh',
    task: {
      id: 'task-refresh',
      state: 'awaiting_clarification',
      stateVersion: 4,
      activePlanVersionId: null,
      currentAttemptId: null,
    },
    structuredTask,
    activatedNodes: [],
    candidates: [],
  });
});

test('fails closed when awaiting clarification refresh lacks a valid requirement', async () => {
  const { hydrateCurrentTask } = await loadCurrentFlowStateModule();
  assert.throws(() => hydrateCurrentTask({
    task: {
      id: 'task-malformed-clarification-refresh',
      state: 'awaiting_clarification',
      stateVersion: 0,
      originalInput: 'cannot recover clarification',
      conversationId: 'conversation-malformed-clarification-refresh',
      structuredTask: {},
    },
  }), /clarification|澄清|requirement/i);
});

test('hydrates an awaiting selection task with the server-validated candidate payload', async () => {
  const { hydrateCurrentTask } = await loadCurrentFlowStateModule();
  const structuredTask = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '宠物辅食',
    research_goal: '恢复候选',
    target_audience: ['产品团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [],
    expected_deliverables: ['研究计划'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
  const task = {
    id: 'task-selection-refresh',
    state: 'awaiting_selection',
    stateVersion: 5,
    originalInput: '$competitive-analysis 恢复候选',
    conversationId: 'conversation-selection-refresh',
    structuredTask,
    activePlanVersionId: null,
    currentAttemptId: null,
  };
  const candidates = [
    {
      planVersionId: 'plan-depth',
      candidateId: 'depth',
      title: '深度方案',
      rationale: '增加复核',
      tradeoffs: '较慢',
      planHash: `sha256:${'a'.repeat(64)}`,
      plan: { task_id: task.id, deliverable_type: 'research_plan', evidence_requirements: [], steps: [] },
      pendingInputs: [],
    },
    {
      planVersionId: 'plan-speed',
      candidateId: 'speed',
      title: '快速方案',
      rationale: '立即执行',
      tradeoffs: '少复核',
      planHash: `sha256:${'b'.repeat(64)}`,
      plan: { task_id: task.id, deliverable_type: 'research_plan', evidence_requirements: [], steps: [] },
      pendingInputs: [],
    },
  ];
  const hydrated = hydrateCurrentTask({ task, candidates, activatedNodes: ['D5_competitive'] });

  assert.equal(hydrated.phase, 'picking');
  assert.equal(hydrated.stateVersion, 5);
  assert.equal(hydrated.originalInput, task.originalInput);
  assert.deepEqual(hydrated.candidatesResp, {
    kind: 'current',
    conversationId: task.conversationId,
    task: {
      id: task.id,
      state: task.state,
      stateVersion: task.stateVersion,
      activePlanVersionId: null,
      currentAttemptId: null,
    },
    structuredTask,
    activatedNodes: ['D5_competitive'],
    candidates,
  });
});

test('fails closed when awaiting selection refresh lacks validated candidates', async () => {
  const { hydrateCurrentTask } = await loadCurrentFlowStateModule();
  assert.throws(() => hydrateCurrentTask({
    task: {
      id: 'task-malformed-refresh',
      state: 'awaiting_selection',
      stateVersion: 2,
      originalInput: 'cannot recover',
      conversationId: 'conversation-malformed-refresh',
      structuredTask: {},
    },
  }), /candidate|候选|awaiting_selection/i);
});

test('hydrates every post-selection Current state without silently returning idle', async () => {
  const { hydrateCurrentTask } = await loadCurrentFlowStateModule();
  const taskId = 'task-history-state';
  const structuredTask = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '电商',
    research_goal: '恢复历史任务',
    target_audience: ['产品团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [],
    expected_deliverables: ['研究报告'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  const activePlan = {
    planVersionId: 'plan-history-state',
    candidateId: 'depth',
    title: '深度方案',
    rationale: '完整恢复',
    tradeoffs: '耗时较长',
    planHash: `sha256:${'a'.repeat(64)}`,
    plan: {
      task_id: taskId,
      deliverable_type: 'research_plan',
      evidence_requirements: [],
      activated_nodes: ['D5_competitive'],
      steps: [],
    },
    pendingInputs: [],
  };
  const activeStates = [
    ['awaiting_confirmation', 'planned'],
    ['awaiting_approval', 'awaiting-approval'],
    ['ready', 'ready'],
    ['executing', 'executing'],
    ['paused', 'paused'],
    ['reviewing', 'reviewing'],
    ['composing_report', 'composing-report'],
  ] as const;
  for (const [state, phase] of activeStates) {
    const hydrated = hydrateCurrentTask({
      task: {
        id: taskId,
        state,
        stateVersion: 7,
        originalInput: '恢复历史任务',
        conversationId: 'conversation-history-state',
        structuredTask,
        activePlanVersionId: activePlan.planVersionId,
        currentAttemptId: state === 'executing' || state === 'paused' || state === 'reviewing' || state === 'composing_report'
          ? 'attempt-history-state'
          : null,
      },
      activePlan,
    });
    assert.equal(hydrated.phase, phase, state);
    assert.deepEqual(hydrated.selectedCandidate, activePlan, state);
  }

  for (const [state, phase] of [
    ['completed', 'done'],
    ['completed_with_gaps', 'done'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['rejected', 'rejected'],
  ] as const) {
    const hydrated = hydrateCurrentTask({
      task: {
        id: taskId,
        state,
        stateVersion: 8,
        originalInput: '恢复终态任务',
        conversationId: 'conversation-history-state',
        structuredTask,
        currentAttemptId: state.startsWith('completed') ? 'attempt-history-state' : null,
      },
    });
    assert.equal(hydrated.phase, phase, state);
  }

  assert.throws(() => hydrateCurrentTask({
    task: {
      id: taskId,
      state: 'unknown_state',
      stateVersion: 9,
      originalInput: '未知状态',
      conversationId: 'conversation-history-state',
      structuredTask,
    },
  }), /unknown|unsupported|state/i);
});

test('clarification submission contains only explicit answers and editable assumption changes', async () => {
  const { buildClarificationSubmission } = await loadCurrentFlowStateModule() as ClarificationStateModule;
  assert.deepEqual(buildClarificationSubmission({
    clarification_questions: [{ key: 'audience', question: 'Who?', rationale: 'Changes method' }],
    assumptions: [{ key: 'scope', value: 'web', editable: true }],
  }, { audience: 'new users', ignored: 'nope' }, { scope: 'mobile', unknown: 'nope' }), {
    clarificationAnswers: { audience: 'new users' },
    assumptionEdits: { scope: 'mobile' },
  });
});

test('missing blocking clarification answers remain unresolved despite suggestions', async () => {
  const { missingBlockingAnswers } = await loadCurrentFlowStateModule() as ClarificationStateModule;
  assert.deepEqual(missingBlockingAnswers({
    clarification_questions: [
      { key: 'audience', question: 'Who?', rationale: 'Changes method' },
      { key: 'scope', question: 'What?', rationale: 'Bounds work' },
    ],
    assumptions: [],
  }, { audience: 'new users' }), ['scope']);
});

test('one logical clarification payload uses one key and only one request while in flight', async () => {
  const {
    createClarificationSubmissionState,
    beginClarificationSubmission,
    settleClarificationSubmission,
  } = await loadCurrentFlowStateModule();
  const payload = {
    expectedVersion: 4,
    clarificationAnswers: { audience: 'new users' },
    assumptionEdits: { scope: 'mobile' },
  };
  let identities = 0;
  const createIdentity = () => {
    identities += 1;
    return { requestId: `request-${identities}`, idempotencyKey: `key-${identities}` };
  };

  const first = beginClarificationSubmission(
    createClarificationSubmissionState(),
    payload,
    createIdentity,
  );
  const duplicate = beginClarificationSubmission(first.state, {
    assumptionEdits: { scope: 'mobile' },
    clarificationAnswers: { audience: 'new users' },
    expectedVersion: 4,
  }, createIdentity);

  assert.deepEqual(first.request, { requestId: 'request-1', idempotencyKey: 'key-1' });
  assert.equal(duplicate.request, null);
  assert.equal(identities, 1);

  const failed = settleClarificationSubmission(first.state, 'request-1', 'failure');
  assert.equal(failed.accepted, true);
  const retried = beginClarificationSubmission(failed.state, payload, createIdentity);
  assert.equal(retried.request?.idempotencyKey, 'key-1');
  assert.equal(identities, 2, 'retry needs a new request identity but must reuse the logical key');
});

test('changed clarification payload gets a new key and stale failure cannot overwrite later success', async () => {
  const {
    createClarificationSubmissionState,
    beginClarificationSubmission,
    settleClarificationSubmission,
  } = await loadCurrentFlowStateModule();
  let identity = 0;
  const createIdentity = () => {
    identity += 1;
    return { requestId: `request-${identity}`, idempotencyKey: `key-${identity}` };
  };
  const first = beginClarificationSubmission(createClarificationSubmissionState(), {
    clarificationAnswers: { audience: 'new users' },
  }, createIdentity);
  assert.ok(first.request);
  const changed = beginClarificationSubmission(first.state, {
    clarificationAnswers: { audience: 'buyers' },
  }, createIdentity);
  assert.deepEqual(changed.request, { requestId: 'request-2', idempotencyKey: 'key-2' });

  const succeeded = settleClarificationSubmission(changed.state, 'request-2', 'success');
  assert.equal(succeeded.accepted, true);
  assert.equal(succeeded.state.pending, null, 'success clears the logical submission identity');
  assert.equal(succeeded.state.activeRequestId, null);

  const staleFailure = settleClarificationSubmission(succeeded.state, 'request-1', 'failure');
  assert.equal(staleFailure.accepted, false);
  assert.deepEqual(staleFailure.state, succeeded.state);
});

test('buildConfirmationAnswers returns only explicit user answers, including false', async () => {
  const { buildConfirmationAnswers } = await loadCurrentFlowStateModule();
  const requirements: ConfirmationRequirement[] = [
    {
      key: 'competitor_list',
      question: '是否指定对标竞品？',
      suggestion: '默认头部 3 家',
    },
    {
      key: 'include_marketplaces',
      question: '是否纳入电商平台？',
      suggestion: true,
    },
  ];

  assert.deepEqual(
    buildConfirmationAnswers(requirements, {
      competitor_list: '用户明确指定甲、乙、丙三家',
      include_marketplaces: false,
      unrelated: 'must not be submitted',
    }),
    {
      competitor_list: '用户明确指定甲、乙、丙三家',
      include_marketplaces: false,
    },
  );
});

test('buildConfirmationAnswers leaves no missing requirement auto-filled from suggestion or true', async (t) => {
  const { buildConfirmationAnswers } = await loadCurrentFlowStateModule();
  const requirements: ConfirmationRequirement[] = [
    { key: 'competitor_list', suggestion: '默认头部 3 家' },
    { key: 'include_marketplaces', suggestion: true },
  ];

  for (const userAnswers of [
    {},
    { competitor_list: '用户明确指定甲、乙、丙三家' },
  ]) {
    await t.test(Object.keys(userAnswers).join(',') || 'no answers', () => {
      assert.throws(
        () => buildConfirmationAnswers(requirements, userAnswers),
        /unresolved|include_marketplaces|competitor_list/i,
      );
    });
  }
});

test('executionStepsToExecLog preserves server state and Skill provenance without synthesizing plan success', async () => {
  const { executionStepsToExecLog } = await loadCurrentFlowStateModule();
  const succeededProvenance = {
    skillBodyHash: 'sha256:succeeded-body',
    modelReceiptId: '11111111-1111-4111-8111-111111111111',
    status: 'succeeded',
  };
  const failedProvenance = {
    skillBodyHash: 'sha256:failed-body',
    modelReceiptId: '22222222-2222-4222-8222-222222222222',
    status: 'failed',
  };
  const serverSteps: ServerExecutionStep[] = [
    { stepNo: 1, stepName: '检索中', actorType: 'tool', actorId: 'tavily-web-search', state: 'running', skillProvenance: null },
    { stepNo: 2, stepName: '竞品研究', actorType: 'skill', actorId: 'competitive-web-research', state: 'succeeded', skillProvenance: succeededProvenance },
    { stepNo: 3, stepName: '可选增强', actorType: 'tool', actorId: 'optional-lab', state: 'skipped', skillProvenance: null },
    { stepNo: 4, stepName: '质量复核', actorType: 'skill', actorId: 'research-plan-reviewer', state: 'failed', skillProvenance: failedProvenance },
  ];

  assert.deepEqual(executionStepsToExecLog(serverSteps), [
    { step_no: 1, step_name: '检索中', actor_type: 'tool', actor_id: 'tavily-web-search', status: 'running', skillProvenance: null },
    { step_no: 2, step_name: '竞品研究', actor_type: 'skill', actor_id: 'competitive-web-research', status: 'succeeded', skillProvenance: succeededProvenance },
    { step_no: 3, step_name: '可选增强', actor_type: 'tool', actor_id: 'optional-lab', status: 'skipped', skillProvenance: null },
    { step_no: 4, step_name: '质量复核', actor_type: 'skill', actor_id: 'research-plan-reviewer', status: 'failed', skillProvenance: failedProvenance },
  ]);
});

test('deliverable read failure preserves completed execution and retry requests only the deliverable', async () => {
  const {
    finishExecution,
    failDeliverableRead,
    retryDeliverable,
  } = await loadCurrentFlowStateModule();
  const initial: DeliverableReadState = {
    phase: 'executing',
    reportState: 'idle',
    execution: null,
    deliverable: null,
    executionError: null,
    reportError: null,
  };
  const execution: CompletedExecution = {
    attemptId: 'attempt-1',
    state: 'completed',
    status: 'completed',
    stateVersion: 7,
  };

  const completed = finishExecution(initial, execution);
  assert.equal(completed.effect, 'load-deliverable');
  assert.equal(completed.state.phase, 'done');
  assert.equal(completed.state.reportState, 'loading');
  assert.deepEqual(completed.state.execution, execution);

  const failed = failDeliverableRead(completed.state, 'temporary GET failure');
  assert.equal(failed.effect, null);
  assert.equal(failed.state.phase, 'done');
  assert.equal(failed.state.reportState, 'report-loading-error');
  assert.deepEqual(failed.state.execution, execution);
  assert.equal(failed.state.executionError, null);
  assert.equal(failed.state.reportError, 'temporary GET failure');

  const retried = retryDeliverable(failed.state);
  assert.equal(retried.effect, 'load-deliverable');
  assert.equal(retried.state.phase, 'done');
  assert.equal(retried.state.reportState, 'loading');
  assert.deepEqual(retried.state.execution, execution);
  assert.equal(retried.state.executionError, null);
  assert.equal(retried.state.reportError, null);
});
