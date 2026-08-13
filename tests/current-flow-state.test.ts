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
  state: 'running' | 'succeeded' | 'skipped' | 'failed';
}

interface ExecLogRow {
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
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

interface CurrentFlowStateModule {
  buildConfirmationAnswers(
    requirements: ConfirmationRequirement[],
    userAnswers: Record<string, unknown>,
  ): Record<string, unknown>;
  executionStepsToExecLog(steps: ServerExecutionStep[]): ExecLogRow[];
  finishExecution(state: DeliverableReadState, execution: CompletedExecution): FlowTransition;
  failDeliverableRead(state: DeliverableReadState, error: string): FlowTransition;
  retryDeliverable(state: DeliverableReadState): FlowTransition;
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
    'finishExecution',
    'failDeliverableRead',
    'retryDeliverable',
    'buildClarificationSubmission',
    'missingBlockingAnswers',
  ]) {
    assert.equal(typeof moduleExports[exportName], 'function', `${exportName} must be exported`);
  }
  return moduleExports as unknown as CurrentFlowStateModule;
}

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

test('executionStepsToExecLog preserves each server execution state without synthesizing plan success', async () => {
  const { executionStepsToExecLog } = await loadCurrentFlowStateModule();
  const serverSteps: ServerExecutionStep[] = [
    { stepNo: 1, stepName: '检索中', actorType: 'tool', actorId: 'tavily-web-search', state: 'running' },
    { stepNo: 2, stepName: '竞品研究', actorType: 'skill', actorId: 'competitive-web-research', state: 'succeeded' },
    { stepNo: 3, stepName: '可选增强', actorType: 'tool', actorId: 'optional-lab', state: 'skipped' },
    { stepNo: 4, stepName: '质量复核', actorType: 'reviewer', actorId: 'research-plan-reviewer', state: 'failed' },
  ];

  assert.deepEqual(executionStepsToExecLog(serverSteps), [
    { step_no: 1, step_name: '检索中', actor_type: 'tool', actor_id: 'tavily-web-search', status: 'running' },
    { step_no: 2, step_name: '竞品研究', actor_type: 'skill', actor_id: 'competitive-web-research', status: 'succeeded' },
    { step_no: 3, step_name: '可选增强', actor_type: 'tool', actor_id: 'optional-lab', status: 'skipped' },
    { step_no: 4, step_name: '质量复核', actor_type: 'reviewer', actor_id: 'research-plan-reviewer', status: 'failed' },
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
