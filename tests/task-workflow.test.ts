import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlPlanVersionDetail,
  type ControlTask,
} from '../database/control-plane.ts';
import type {
  NativeSkillExecutionPlanV1,
} from '../packages/api-contract/native-skill-orchestration.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type {
  CurrentExecutionPlan,
  CurrentPlanStep,
} from '../packages/api-contract/research-deliverable.ts';
import {
  TaskWorkflowAuthorizationError,
  TaskWorkflowGateError,
  TaskWorkflowService,
} from '../apps/orchestrator-runtime/src/control/task-workflow.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { DatasetInputGateStore } from '../apps/orchestrator-runtime/src/control/dataset-input-gate-store.ts';
import { VisualInputGateStore } from '../apps/orchestrator-runtime/src/control/visual-input-gate-store.ts';
import { REPORT_REVIEW_DIMENSION_IDS } from '../packages/api-contract/control-workflow.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';

type CandidatePersistenceRepository = ControlPlaneRepository & {
  createTaskWithCandidates(input: {
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    taskType: string | null;
    structuredTask: unknown;
    candidates: Array<{
      candidateId: string;
      plan: unknown;
      pendingInputs: unknown[];
    }>;
  }): Promise<{
    task: ControlTask;
    candidates: ControlPlanVersionDetail[];
  }>;
};

class ScopedWorkflowDatabase implements MigrationDatabase {
  constructor(
    private readonly database: Pool,
    private readonly schema: string,
  ) {}

  async connect(): Promise<MigrationConnection> {
    const client = await this.database.connect();
    await client.query(`SET search_path TO "${this.schema}", public`);
    return {
      async query(sql, values = []) {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows };
      },
      release() {
        client.release();
      },
    };
  }
}

class SelectionCommandFailingDatabase implements MigrationDatabase {
  constructor(private readonly database: MigrationDatabase) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      async query(sql, values = []) {
        if (/^\s*INSERT\s+INTO\s+control_commands\b/i.test(sql) && values[1] === 'selection') {
          throw new Error('simulated command persistence failure');
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
      },
    };
  }
}

class CancelCommandFailingDatabase implements MigrationDatabase {
  constructor(private readonly database: MigrationDatabase) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      async query(sql, values = []) {
        if (/INSERT\s+INTO\s+control_commands[\s\S]*'cancel'/iu.test(sql)) {
          throw new Error('simulated cancel command persistence failure');
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
      },
    };
  }
}

class ConfirmationReplayRaceRepository extends ControlPlaneRepository {
  private commandReadSeen = false;
  private taskReadReleased = false;
  private announceCommandRead!: () => void;
  private releaseTaskRead!: () => void;
  readonly initialCommandRead = new Promise<void>((resolve) => {
    this.announceCommandRead = resolve;
  });
  private readonly taskReadBarrier = new Promise<void>((resolve) => {
    this.releaseTaskRead = resolve;
  });

  release(): void {
    this.taskReadReleased = true;
    this.releaseTaskRead();
  }

  override async getCommand(taskId: string, commandType: string, idempotencyKey: string) {
    const command = await super.getCommand(taskId, commandType, idempotencyKey);
    if (!this.commandReadSeen) {
      this.commandReadSeen = true;
      this.announceCommandRead();
    }
    return command;
  }

  override async getTaskDetail(taskId: string) {
    if (this.commandReadSeen && !this.taskReadReleased) await this.taskReadBarrier;
    return super.getTaskDetail(taskId);
  }
}

class ConfirmationCommitFailingDatabase implements MigrationDatabase {
  constructor(private readonly database: MigrationDatabase) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      async query(sql, values = []) {
        if (
          /UPDATE\s+control_tasks\s+SET\s+state\s*=\s*\$3,\s*state_version\s*=\s*state_version\s*\+\s*1/iu.test(sql)
          && (values[2] === 'ready' || values[2] === 'awaiting_approval')
        ) {
          throw new Error('simulated confirmation commit failure');
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
      },
    };
  }
}

class ReclaimingConfirmationRepository extends ControlPlaneRepository {
  replacement: Awaited<ReturnType<VisualInputGateStore['publishPrepared']>> | undefined;

  constructor(
    database: MigrationDatabase,
    private readonly administrativeDatabase: MigrationDatabase,
    private readonly visualGates: VisualInputGateStore,
    private readonly replacementValue: { dataUrl: string },
  ) {
    super(database);
  }

  override async completeConfirmationCommand(
    input: Parameters<ControlPlaneRepository['completeConfirmationCommand']>[0],
  ): Promise<Awaited<ReturnType<ControlPlaneRepository['completeConfirmationCommand']>>> {
    const connection = await this.administrativeDatabase.connect();
    try {
      await connection.query(
        `UPDATE control_commands SET reservation_expires_at = now() - interval '1 second'
         WHERE task_id = $1 AND command_type = 'confirmation' AND idempotency_key = $2`,
        [input.taskId, input.idempotencyKey],
      );
    } finally {
      connection.release();
    }
    const reclaimed = await super.reserveConfirmationCommand({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
    });
    if (reclaimed.status !== 'reserved') throw new Error('test could not reclaim confirmation');
    const publicationId = await super.beginVisualPublication({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      expectedVersion: input.expectedVersion,
      reservationToken: reclaimed.reservationToken,
    });
    this.replacement = await this.visualGates.publishPrepared(await this.visualGates.prepare({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      gateKey: 'designImage',
      multiple: false,
      requiredVisual: true,
      value: this.replacementValue,
    }), publicationId);
    await super.completeConfirmationCommand({
      ...input,
      reservationToken: reclaimed.reservationToken,
      publicationId,
      gates: input.gates.map((gate) => gate.gateType === 'input'
        ? { ...gate, value: undefined, evidenceRef: this.replacement!.evidenceRef }
        : gate),
    });
    throw new Error('stale confirmation owner resumed after replacement committed');
  }
}

class ConfirmationCommitAckFailingDatabase implements MigrationDatabase {
  private confirmationCommitted = false;
  private failed = false;

  constructor(private readonly database: MigrationDatabase) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      query: async (sql, values = []) => {
        const result = await connection.query(sql, values);
        if (/UPDATE\s+control_visual_publications\s+SET\s+state\s*=\s*'COMMITTED'/iu.test(sql)) {
          this.confirmationCommitted = true;
        }
        if (/^\s*COMMIT\s*$/iu.test(sql) && this.confirmationCommitted && !this.failed) {
          this.failed = true;
          throw new Error('simulated confirmation commit acknowledgement loss');
        }
        return result;
      },
      release() {
        connection.release();
      },
    };
  }
}

const schema = `workflow_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedWorkflowDatabase(database, schema);
let ownerId = '';
let legalId = '';
let securityId = '';
let conversationId = '';
let foreignConversationId = '';

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
});

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
  });
  const connection = await scopedDatabase.connect();
  try {
    const owner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'owner', 'x', 'member') RETURNING id`,
      [`workflow-owner-${Date.now()}@test.local`],
    );
    ownerId = String(owner.rows[0]?.id);
    const legal = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'legal', 'x', 'legal') RETURNING id`,
      [`workflow-legal-${Date.now()}@test.local`],
    );
    legalId = String(legal.rows[0]?.id);
    const security = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'security', 'x', 'security') RETURNING id`,
      [`workflow-security-${Date.now()}@test.local`],
    );
    securityId = String(security.rows[0]?.id);
    const foreignOwner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'foreign', 'x', 'member') RETURNING id`,
      [`workflow-foreign-${Date.now()}@test.local`],
    );
    const foreignConversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'foreign') RETURNING id`,
      [String(foreignOwner.rows[0]?.id)],
    );
    foreignConversationId = String(foreignConversation.rows[0]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'workflow') RETURNING id`,
      [ownerId],
    );
    conversationId = String(conversation.rows[0]?.id);
    await connection.query(
      `INSERT INTO control_model_calls
         (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
          prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
       VALUES ('11111111-1111-4111-8111-111111111111', 'problem_graph', NULL, NULL, 'fixture', 'fixture.test',
               'workflow-fixture-model', 'workflow-fixture-model', '1', 'sha256:workflow-problem-graph',
               NULL, 'trace-workflow-problem-graph', 'succeeded', now(), now())`,
    );
  } finally {
    connection.release();
  }
});
const workflowEvidenceRequirement = {
  id: 'workflow-source',
  acceptedClasses: ['public_source'] as Array<'public_source'>,
  minimumCount: 1,
  required: true,
};

function currentTask(overrides: Partial<ResearchTaskV2> = {}): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'workflow fixtures',
    research_goal: 'verify the Current workflow',
    target_audience: ['research team'],
    scope: ['public sources'],
    constraints: [],
    success_criteria: [{ id: 'workflow-ready', statement: 'the workflow remains executable' }],
    expected_deliverables: ['research plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
    ...overrides,
  };
}

function currentStep(overrides: Partial<CurrentPlanStep> = {}): CurrentPlanStep {
  return {
    step_no: 1,
    step_name: 'workflow analysis',
    actor_type: 'llm',
    actor_id: 'workflow-analysis',
    question_ids: ['workflow-question'],
    depends_on: [],
    input: {},
    input_bindings: [],
    expected_outputs: [{ pointer: '/text', description: 'workflow result' }],
    acceptance_criteria: ['workflow completes'],
    requires_approval: false,
    fallback_actor_ids: [],
    ...overrides,
  };
}

function currentPlan(
  taskId: string,
  label: string,
  steps: CurrentPlanStep[] = [currentStep()],
): CurrentExecutionPlan {
  const requiredTools = [...new Set(
    steps.filter((step) => step.actor_type === 'tool').map((step) => step.actor_id),
  )];
  return {
    task_id: taskId,
    deliverable_type: 'research_plan',
    evidence_requirements: [{
      ...workflowEvidenceRequirement,
      acceptedClasses: [...workflowEvidenceRequirement.acceptedClasses],
    }],
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'workflow-question',
        statement: 'Can the Current workflow complete safely?',
        rationale: 'Covers the workflow fixture contract',
        priority: 'required',
        success_criterion_ids: ['workflow-ready'],
        evidence_requirements: [{
          ...workflowEvidenceRequirement,
          acceptedClasses: [...workflowEvidenceRequirement.acceptedClasses],
        }],
        acceptance_criteria: ['At least one public source is traceable'],
        depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'workflow-fixture-model',
      modelVersion: '1',
      promptHash: 'sha256:workflow-problem-graph',
      traceId: 'trace-workflow-problem-graph',
    },
    capability_decisions: {
      eligible: requiredTools.length === 0 ? [] : [{
        skill: {
          id: `${label}-tool-provider`,
          status: 'active',
          task_types: ['competitive_research'],
          inputs: [],
          outputs: [],
          required_tools: requiredTools,
          optional_tools: [],
        },
        reasons: [{ code: 'eligible', message: 'fixture tools are eligible' }],
        pending_inputs: [],
        required_approvals: [],
        optional_tool_decisions: [],
      }],
      rejected: [],
    },
    capability_gaps: [],
    steps,
    candidate_metadata: {
      title: label,
      rationale: `${label} rationale`,
      tradeoffs: `${label} tradeoffs`,
    },
    activated_nodes: ['D5_competitive'],
  };
}

async function createCandidateTask(
  repository: ControlPlaneRepository,
  suffix: string,
  options: {
    structuredTask?: unknown;
    candidateId?: 'depth' | 'speed';
    plan?: CurrentExecutionPlan;
    pendingInputs?: unknown[];
  } = {},
) {
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const candidateId = options.candidateId ?? 'depth';
  const alternateCandidateId = candidateId === 'depth' ? 'speed' : 'depth';
  return candidateRepository.createTaskWithCandidates({
    conversationId,
    ownerUserId: ownerId,
    originalInput: `server candidate selection ${suffix}`,
    taskType: 'competitive_research',
    structuredTask: options.structuredTask ?? currentTask(),
    candidates: [
      {
        candidateId,
        plan: options.plan ?? currentPlan('', `${candidateId} ${suffix}`),
        pendingInputs: options.pendingInputs ?? [],
      },
      {
        candidateId: alternateCandidateId,
        plan: currentPlan('', `${alternateCandidateId} ${suffix}`),
        pendingInputs: [],
      },
    ],
  });
}

test('selects an existing server candidate using only its planVersionId', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'selected');
  const selectedCandidate = created.candidates[0]!;

  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'select-server-depth-candidate',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: selectedCandidate.id,
  });

  assert.equal(selection.planVersionId, selectedCandidate.id);
  assert.equal(selection.state, 'awaiting_confirmation');
  const persistedTask = await repository.getTaskDetail(created.task.id);
  assert.equal(persistedTask?.state, 'awaiting_confirmation');
  assert.equal(persistedTask?.activePlanVersionId, selectedCandidate.id);
});

test('rolls back selection when command persistence fails and allows the same idempotency key to retry', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const created = await createCandidateTask(repository, 'atomic-selection');
  const planVersionId = created.candidates[0]!.id;
  const selectionInput = {
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'atomic-selection-command',
    actor: { userId: ownerId, role: 'owner' as const },
    planVersionId,
  };
  const failingRepository = new ControlPlaneRepository(
    new SelectionCommandFailingDatabase(scopedDatabase),
  );
  const failingWorkflow = new TaskWorkflowService(failingRepository);

  await assert.rejects(
    () => failingWorkflow.select(selectionInput),
    /simulated command persistence failure/,
  );

  const taskAfterFailure = await repository.getTaskDetail(created.task.id);
  assert.equal(taskAfterFailure?.state, 'awaiting_selection');
  assert.equal(taskAfterFailure?.activePlanVersionId, null);

  const recoveredSelection = await new TaskWorkflowService(repository).select(selectionInput);
  assert.equal(recoveredSelection.state, 'awaiting_confirmation');
  assert.equal(recoveredSelection.planVersionId, planVersionId);
});

test('rejects selecting a planVersionId that belongs to another task', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const target = await createCandidateTask(repository, 'target');
  const foreign = await createCandidateTask(repository, 'foreign');

  await assert.rejects(
    () => workflow.select({
      taskId: target.task.id,
      expectedVersion: target.task.stateVersion,
      idempotencyKey: 'reject-foreign-plan-version',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: foreign.candidates[0]!.id,
    }),
    ControlPlaneConflictError,
  );

  const persistedTarget = await repository.getTaskDetail(target.task.id);
  assert.equal(persistedTarget?.state, 'awaiting_selection');
  assert.equal(persistedTarget?.activePlanVersionId, null);
});

test('rejects a task owner when the linked conversation has another owner', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const task = await repository.createTask({
    conversationId: foreignConversationId,
    ownerUserId: ownerId,
    originalInput: 'cross-conversation attempt',
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'awaiting_selection',
  });
  const candidate = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: currentPlan(task.id, 'cross-conversation'),
    planHash: 'sha256:cross-conversation',
    pendingInputs: [],
  });
  await assert.rejects(
    () => workflow.select({
      taskId: task.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: 'cross-conversation-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: candidate.id,
    }),
    TaskWorkflowAuthorizationError,
  );
});


test('malformed persisted workflow gate fails closed during confirmation', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'malformed', {
    structuredTask: { ...currentTask(), clarification_questions: 'not-an-array' },
    candidateId: 'speed',
    plan: currentPlan('', 'malformed'),
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'malformed-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'malformed-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    }),
    TaskWorkflowGateError,
  );
});

test('native confirmation records an explicit optional-input waiver', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const invocationId = 'competitive-web-research:1';
  const step = currentStep({
    actor_type: 'skill',
    actor_id: 'competitive-web-research',
    input: { public_evidence: null },
    skill_invocation_id: invocationId,
  });
  const runSpec = new SkillLoader().loadNativeRunSpec('competitive-web-research');
  const base = currentPlan('', 'native-waiver', [step]);
  const plan: NativeSkillExecutionPlanV1 = {
    ...base,
    execution_contract_version: 'native-skill-execution-plan-v1',
    mode: 'single_skill',
    skill_invocations: [{
      invocation_id: invocationId,
      skill_id: 'competitive-web-research',
      depends_on_invocation_ids: [],
      step_nos: [1],
      required: true,
      failure_policy: 'block',
      run_spec: runSpec,
    }],
    final_report_policy: runSpec.report_policy,
    resolved_inputs: {
      resolved: [],
      pending: [{
        requirement: runSpec.input_requirements.find(({ key }) => key === 'public_evidence')!,
        targetInvocationIds: [invocationId],
      }],
      waived: [],
    },
  };
  const pendingInputs = [{
    kind: 'value' as const,
    role: 'public_evidence',
    label: '竞品公开资料',
    multiple: true,
    targets: [{
      step_no: 1,
      tool_id: 'competitive-web-research',
      field: 'public_evidence',
      multiple: true,
    }],
  }];
  const created = await createCandidateTask(repository, 'native-waiver', {
    candidateId: 'speed',
    plan: plan as unknown as CurrentExecutionPlan,
    pendingInputs,
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'native-waiver-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const confirmed = await workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'native-waiver-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
    waivedInputKeys: ['public_evidence'],
  });
  assert.equal(confirmed.state, 'ready');
  assert.deepEqual(
    (await repository.listGateRecords(created.task.id, selection.planVersionId))
      .map(({ gateKey, decision, value }) => ({ gateKey, decision, value })),
    [{
      gateKey: 'public_evidence',
      decision: 'waived',
      value: { reason: 'user_confirmed_unavailable' },
    }],
  );
});

test('rejects legacy pending inputs without an explicit kind before writing gates', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'legacy-pending-kind', {
    candidateId: 'speed',
    plan: currentPlan('', 'legacy-pending-kind', [currentStep({ input: { brief: null } })]),
    pendingInputs: [{
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'legacy-pending-kind-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
  });

  await assert.rejects(() => workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'legacy-pending-kind-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: { brief: '已提供' },
  }), TaskWorkflowGateError);
  const persisted = await repository.getTaskDetail(created.task.id);
  assert.equal(persisted?.state, 'awaiting_confirmation');
  assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
});

test('rejects malformed or ambiguous pending input contracts before writing gates', async () => {
  const malformedInputs: unknown[][] = [
    [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
    [{
      kind: 'value',
      key: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
    [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }, {
      kind: 'visual',
      role: 'brief',
      label: '重复角色',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'image', multiple: false }],
    }],
    [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      unexpected: true,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
    [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'shared', multiple: false }],
    }, {
      kind: 'value',
      role: 'note',
      label: '备注',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'shared', multiple: false }],
    }],
  ];

  for (const [index, pendingInputs] of malformedInputs.entries()) {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const workflow = new TaskWorkflowService(repository);
    const created = await createCandidateTask(repository, `malformed-pending-${index}`, {
      candidateId: 'speed',
      plan: currentPlan('', `malformed-pending-${index}`, [currentStep({
        input: { brief: null, note: null, image: null, shared: null },
      })]),
      pendingInputs,
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: `malformed-pending-select-${index}`,
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });

    await assert.rejects(() => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: `malformed-pending-confirm-${index}`,
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { brief: 'brief', note: 'note' },
    }), TaskWorkflowGateError);
    assert.equal((await repository.getTaskDetail(created.task.id))?.state, 'awaiting_confirmation');
    assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
  }
});

test('rejects extra input roles before writing gates or transitioning state', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'extra-input', {
    candidateId: 'speed',
    plan: currentPlan('', 'extra-input', [currentStep({ input: { brief: null } })]),
    pendingInputs: [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'extra-input-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
  });
  await assert.rejects(
    () => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'extra-input-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { brief: '已提供', unknown_role: '不应写入' },
    }),
    TaskWorkflowGateError,
  );
  const persisted = await repository.getTaskDetail(created.task.id);
  assert.equal(persisted?.state, 'awaiting_confirmation');
  assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
});

test('rejects invalid nested visual inputs before writing gates or transitioning state', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-invalid-visual-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(
      repository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const created = await createCandidateTask(repository, 'invalid-visual-input', {
      candidateId: 'speed',
      plan: currentPlan('', 'invalid-visual-input', [currentStep({ input: { screenshots: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'screenshots',
        label: '竞品截图',
        multiple: true,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'screenshots', multiple: true }],
      }],
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'invalid-visual-input-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const invalidDataUrls: unknown[] = [
      'data:image/gif;base64,AAAA',
      'data:image/png;base64,',
      'data:image/jpeg;base64,%%%',
      'data:image/webp;base64,Y Q==',
      'data:image/jpeg;base64,YQ==\n',
      'data:image/png;base64,AB==',
      'data:image/png;base64,YQ==',
      'data:image/png;base64,iVBORw0KGgo=',
      'data:image/jpeg;base64,/9j/',
      'data:image/webp;base64,UklGRgAAAABXRUJQ',
      null,
    ];

    for (const [index, dataUrl] of invalidDataUrls.entries()) {
      await assert.rejects(
        () => workflow.confirm({
          taskId: created.task.id,
          planVersionId: selection.planVersionId,
          expectedVersion: selection.stateVersion,
          idempotencyKey: `invalid-visual-input-confirm-${index}`,
          actor: { userId: ownerId, role: 'owner' },
          confirmationAnswers: {},
          inputValues: { screenshots: [{ dataUrl }] },
        }),
        TaskWorkflowGateError,
      );
    }

    const persisted = await repository.getTaskDetail(created.task.id);
    assert.equal(persisted?.state, 'awaiting_confirmation');
    assert.equal(persisted?.stateVersion, selection.stateVersion);
    assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
    const connection = await scopedDatabase.connect();
    try {
      const result = await connection.query(
        `SELECT count(*)::int AS count FROM control_artifacts WHERE task_id = $1 AND plan_version_id = $2`,
        [created.task.id, selection.planVersionId],
      );
      assert.equal(result.rows[0]?.count, 0);
      const commands = await connection.query(
        `SELECT count(*)::int AS count FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation'`,
        [created.task.id],
      );
      assert.equal(commands.rows[0]?.count, 0);
    } finally {
      connection.release();
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('validates every pending input before sealing any visual Artifact', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-visual-preflight-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(
      repository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const created = await createCandidateTask(repository, 'visual-preflight', {
      candidateId: 'speed',
      plan: currentPlan('', 'visual-preflight', [currentStep({
        input: { designImage: null, competitorImage: null },
      })]),
      pendingInputs: [
        {
          kind: 'visual',
          role: 'designImage',
          label: '设计稿',
          multiple: false,
          targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
        },
        {
          kind: 'visual',
          role: 'competitorImage',
          label: '竞品图',
          multiple: false,
          targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'competitorImage', multiple: false }],
        },
      ],
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'visual-preflight-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    await assert.rejects(() => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'visual-preflight-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {
        designImage: { dataUrl: `data:image/png;base64,${png.toString('base64')}` },
        competitorImage: { url: 'https://images.example.test/competitor.png' },
      },
    }), TaskWorkflowGateError);

    const persisted = await repository.getTaskDetail(created.task.id);
    assert.equal(persisted?.state, 'awaiting_confirmation');
    assert.equal(persisted?.stateVersion, selection.stateVersion);
    assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
    const connection = await scopedDatabase.connect();
    try {
      const result = await connection.query(
        `SELECT count(*)::int AS count FROM control_artifacts WHERE task_id = $1 AND plan_version_id = $2`,
        [created.task.id, selection.planVersionId],
      );
      assert.equal(result.rows[0]?.count, 0);
      const commands = await connection.query(
        `SELECT count(*)::int AS count FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation'`,
        [created.task.id],
      );
      assert.equal(commands.rows[0]?.count, 0);
    } finally {
      connection.release();
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('seals valid visual input and stores only its Artifact reference in the gate row', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-visual-input-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(
      repository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const created = await createCandidateTask(repository, 'sealed-visual-input', {
      candidateId: 'speed',
      plan: currentPlan('', 'sealed-visual-input', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'sealed-visual-input-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

    await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'sealed-visual-input-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { designImage: { dataUrl } },
    });

    const [gate] = await repository.listGateRecords(created.task.id, selection.planVersionId);
    assert.equal(gate?.value, null);
    assert.equal(typeof gate?.evidenceRef, 'string');
    const connection = await scopedDatabase.connect();
    try {
      const persisted = await connection.query(
        `SELECT value_json::text AS value_json, evidence_ref
         FROM control_gate_records
         WHERE task_id = $1 AND plan_version_id = $2 AND gate_type = 'input'`,
        [created.task.id, selection.planVersionId],
      );
      assert.equal(persisted.rows[0]?.value_json, null);
      assert.equal(persisted.rows[0]?.evidence_ref, gate?.evidenceRef);
      const publication = await connection.query(
        `SELECT publication.id, publication.state, publication.evidence_refs,
                count(artifact.id)::int AS artifact_count,
                count(DISTINCT artifact.publication_id)::int AS publication_count
         FROM control_visual_publications AS publication
         JOIN control_artifacts AS artifact ON artifact.publication_id = publication.id
         WHERE publication.task_id = $1 AND publication.plan_version_id = $2
         GROUP BY publication.id, publication.state, publication.evidence_refs`,
        [created.task.id, selection.planVersionId],
      );
      assert.equal(publication.rows[0]?.state, 'COMMITTED');
      assert.deepEqual(publication.rows[0]?.evidence_refs, [gate?.evidenceRef]);
      assert.equal(publication.rows[0]?.artifact_count, 2);
      assert.equal(publication.rows[0]?.publication_count, 1);
    } finally {
      connection.release();
    }
    const manifest = await artifacts.readVerifiedBoundJson<unknown>(gate!.evidenceRef!);
    assert.doesNotMatch(JSON.stringify(manifest.value), /data:image|base64/u);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('binds one uploaded Dataset by Artifact reference without creating a visual publication', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-dataset-input-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const datasetGates = new DatasetInputGateStore(artifacts);
    const workflow = new TaskWorkflowService(
      repository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
      datasetGates,
    );
    const created = await createCandidateTask(repository, 'sealed-dataset-input', {
      candidateId: 'speed',
      plan: currentPlan('', 'sealed-dataset-input', [currentStep({ input: { user_research_dataset: null } })]),
      pendingInputs: [{
        kind: 'dataset', role: 'user_research_dataset', label: '匿名用户研究 CSV', multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'user_research_dataset', multiple: false }],
      }],
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'sealed-dataset-input-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const uploaded = await datasetGates.upload({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      role: 'user_research_dataset',
      ownerUserId: ownerId,
      taskSensitivity: 'internal',
      fileName: 'users.csv',
      mediaType: 'text/csv',
      bytes: Buffer.from('sample_id,score\nu1,3\n'),
      metadata: {
        rowMeaning: '一行一个匿名样本', timeRange: '2026-Q3', fieldNotes: {}, units: { score: '分' },
        sampling: '访谈样本', piiConfirmedAbsent: true,
      },
    });

    await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'sealed-dataset-input-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { user_research_dataset: uploaded.datasetInputId },
    });

    const [gate] = await repository.listGateRecords(created.task.id, selection.planVersionId);
    assert.equal(gate?.value, null);
    assert.equal(gate?.evidenceRef, uploaded.datasetInputId);
    const verified = await datasetGates.resolve({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      ownerUserId: ownerId,
      gates: [gate!],
      pendingInputs: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.pendingInputs as never,
    });
    assert.equal((verified.gates[0]?.value as { version?: string }).version, 'dataset-model-view-v1');
    const connection = await scopedDatabase.connect();
    try {
      const publications = await connection.query(
        'SELECT count(*)::int AS count FROM control_visual_publications WHERE task_id = $1',
        [created.task.id],
      );
      assert.equal(publications.rows[0]?.count, 0);
    } finally {
      connection.release();
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('rolls back every gate, releases the reservation, and fails published visuals when confirmation commit fails', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-confirmation-rollback-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const created = await createCandidateTask(repository, 'confirmation-rollback', {
      candidateId: 'speed',
      plan: currentPlan('', 'confirmation-rollback', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selection = await new TaskWorkflowService(repository).select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'confirmation-rollback-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const failingRepository = new ControlPlaneRepository(
      new ConfirmationCommitFailingDatabase(scopedDatabase),
    );
    const workflow = new TaskWorkflowService(
      failingRepository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    await assert.rejects(() => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirmation-rollback-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { designImage: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } },
    }), /simulated confirmation commit failure/u);

    const persisted = await repository.getTaskDetail(created.task.id);
    assert.equal(persisted?.state, 'awaiting_confirmation');
    assert.equal(persisted?.stateVersion, selection.stateVersion);
    assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
    const connection = await scopedDatabase.connect();
    try {
      const commands = await connection.query(
        `SELECT count(*)::int AS count FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation'`,
        [created.task.id],
      );
      assert.equal(commands.rows[0]?.count, 0);
      const published = await connection.query(
        `SELECT state FROM control_artifacts
         WHERE task_id = $1 AND plan_version_id = $2
         ORDER BY created_at, id`,
        [created.task.id, selection.planVersionId],
      );
      assert.equal(published.rows.length, 2);
      assert.ok(published.rows.every(({ state }) => state === 'FAILED'));
      const publication = await connection.query(
        `SELECT state FROM control_visual_publications
         WHERE task_id = $1 AND plan_version_id = $2`,
        [created.task.id, selection.planVersionId],
      );
      assert.deepEqual(publication.rows, [{ state: 'ABANDONED' }]);
    } finally {
      connection.release();
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('keeps committed confirmation Artifacts sealed when the commit acknowledgement is lost', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-confirmation-commit-ack-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const created = await createCandidateTask(repository, 'confirmation-commit-ack', {
      candidateId: 'speed',
      plan: currentPlan('', 'confirmation-commit-ack', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selection = await new TaskWorkflowService(repository).select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'confirmation-commit-ack-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const uncertainRepository = new ControlPlaneRepository(
      new ConfirmationCommitAckFailingDatabase(scopedDatabase),
    );
    const workflow = new TaskWorkflowService(
      uncertainRepository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const confirmed = await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirmation-commit-ack-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { designImage: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } },
    });

    assert.equal(confirmed.state, 'ready');
    assert.equal((await repository.listGateRecords(created.task.id, selection.planVersionId)).length, 1);
    const connection = await scopedDatabase.connect();
    try {
      const published = await connection.query(
        `SELECT state FROM control_artifacts
         WHERE task_id = $1 AND plan_version_id = $2
         ORDER BY created_at, id`,
        [created.task.id, selection.planVersionId],
      );
      assert.equal(published.rows.length, 2);
      assert.ok(published.rows.every(({ state }) => state === 'SEALED'));
      const publication = await connection.query(
        `SELECT state FROM control_visual_publications
         WHERE task_id = $1 AND plan_version_id = $2`,
        [created.task.id, selection.planVersionId],
      );
      assert.deepEqual(publication.rows, [{ state: 'COMMITTED' }]);
    } finally {
      connection.release();
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('invalidates stale publications after an expired confirmation is reclaimed and committed', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-confirmation-reclaim-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const visualGates = new VisualInputGateStore(artifacts);
    const created = await createCandidateTask(repository, 'confirmation-reclaim', {
      candidateId: 'speed',
      plan: currentPlan('', 'confirmation-reclaim', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selection = await new TaskWorkflowService(repository).select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'confirmation-reclaim-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const value = { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    const reclaimingRepository = new ReclaimingConfirmationRepository(
      scopedDatabase,
      scopedDatabase,
      visualGates,
      value,
    );
    const workflow = new TaskWorkflowService(
      reclaimingRepository,
      undefined,
      undefined,
      undefined,
      visualGates,
    );

    const result = await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirmation-reclaim-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { designImage: value },
    });

    assert.equal(result.state, 'ready');
    const replacement = reclaimingRepository.replacement!;
    const [gate] = await repository.listGateRecords(created.task.id, selection.planVersionId);
    assert.equal(gate?.evidenceRef, replacement.evidenceRef);
    const connection = await scopedDatabase.connect();
    try {
      const published = await connection.query(
        `SELECT id, state FROM control_artifacts
         WHERE task_id = $1 AND plan_version_id = $2`,
        [created.task.id, selection.planVersionId],
      );
      const states = new Map(published.rows.map(({ id, state }) => [String(id), String(state)]));
      assert.ok(replacement.artifactIds.every((artifactId) => states.get(artifactId) === 'SEALED'));
      assert.equal([...states.values()].filter((state) => state === 'SEALED').length, 2);
      assert.equal([...states.values()].filter((state) => state === 'FAILED').length, 2);
      const publications = await connection.query(
        `SELECT state, count(*)::int AS count FROM control_visual_publications
         WHERE task_id = $1 AND plan_version_id = $2
         GROUP BY state ORDER BY state`,
        [created.task.id, selection.planVersionId],
      );
      assert.deepEqual(publications.rows, [
        { state: 'ABANDONED', count: 1 },
        { state: 'COMMITTED', count: 1 },
      ]);
    } finally {
      connection.release();
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('recovers only expired visual publications and is idempotent', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-publication-recovery-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const visualGates = new VisualInputGateStore(artifacts);
    const created = await createCandidateTask(repository, 'publication-recovery', {
      candidateId: 'speed',
      plan: currentPlan('', 'publication-recovery', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual', role: 'designImage', label: '设计稿', multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selection = await new TaskWorkflowService(repository).select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'publication-recovery-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const requestHash = 'sha256:publication-recovery';
    const reserved = await repository.reserveConfirmationCommand({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      idempotencyKey: 'publication-recovery-confirm',
      requestHash,
      expectedVersion: selection.stateVersion,
      actorUserId: ownerId,
    });
    assert.equal(reserved.status, 'reserved');
    if (reserved.status !== 'reserved') throw new Error('fixture confirmation was not reserved');
    const publicationId = await repository.beginVisualPublication({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      idempotencyKey: 'publication-recovery-confirm',
      requestHash,
      expectedVersion: selection.stateVersion,
      reservationToken: reserved.reservationToken,
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const publication = await visualGates.publishPrepared(await visualGates.prepare({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      gateKey: 'designImage',
      multiple: false,
      requiredVisual: true,
      value: { dataUrl: `data:image/png;base64,${png.toString('base64')}` },
    }), publicationId);
    const staging = await repository.createStagingArtifact({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      publicationId,
      kind: 'visual_input_image',
      storageUri: join(artifactRoot, 'unsealed-race.png'),
      schemaVersion: 'visual-input-image-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    });

    assert.equal(await repository.recoverVisualPublications(), 0, 'live reservation must not be reclaimed');
    assert.ok((await Promise.all(publication.artifactIds.map((id) => repository.getArtifact(id))))
      .every((artifact) => artifact?.state === 'SEALED'));
    const connection = await scopedDatabase.connect();
    try {
      await connection.query(
        `UPDATE control_commands SET reservation_expires_at = now() - interval '1 second'
         WHERE task_id = $1 AND command_type = 'confirmation' AND idempotency_key = $2`,
        [created.task.id, 'publication-recovery-confirm'],
      );
    } finally {
      connection.release();
    }
    assert.equal(await repository.recoverVisualPublications(), 1);
    assert.equal(await repository.recoverVisualPublications(), 0, 'terminal recovery must be idempotent');
    assert.ok((await Promise.all(publication.artifactIds.map((id) => repository.getArtifact(id))))
      .every((artifact) => artifact?.state === 'FAILED'));
    assert.equal((await repository.getArtifact(staging.id))?.state, 'FAILED');
    await assert.rejects(() => repository.sealArtifact({
      artifactId: staging.id,
      contentSha256: `sha256:${'a'.repeat(64)}`,
      byteSize: 1,
    }), /cannot be sealed/u);
    await assert.rejects(() => repository.createStagingArtifact({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      publicationId,
      kind: 'visual_input_image',
      storageUri: join(artifactRoot, 'late-race.png'),
      schemaVersion: 'visual-input-image-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    }), /is not publishing/u);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('confirmation commit and failure settlement share a deadlock-free lock order', { timeout: 2_000 }, async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-publication-lock-order-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const visualGates = new VisualInputGateStore(new ControlArtifactStore({ root: artifactRoot, registry: repository }));
    const created = await createCandidateTask(repository, 'publication-lock-order', {
      candidateId: 'speed',
      plan: currentPlan('', 'publication-lock-order', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual', role: 'designImage', label: '设计稿', multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selectedPlan = created.candidates.find((candidate) => candidate.candidateId === 'speed')!;
    const selection = await new TaskWorkflowService(repository).select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'publication-lock-order-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: selectedPlan.id,
    });
    const requestHash = 'sha256:publication-lock-order';
    const idempotencyKey = 'publication-lock-order-confirm';
    const reserved = await repository.reserveConfirmationCommand({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      idempotencyKey,
      requestHash,
      expectedVersion: selection.stateVersion,
      actorUserId: ownerId,
    });
    if (reserved.status !== 'reserved') throw new Error('fixture confirmation was not reserved');
    const publicationId = await repository.beginVisualPublication({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      idempotencyKey,
      requestHash,
      expectedVersion: selection.stateVersion,
      reservationToken: reserved.reservationToken,
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const published = await visualGates.publishPrepared(await visualGates.prepare({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      gateKey: 'designImage',
      multiple: false,
      requiredVisual: true,
      value: { dataUrl: `data:image/png;base64,${png.toString('base64')}` },
    }), publicationId);
    const common = {
      publicationId,
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      idempotencyKey,
      requestHash,
      expectedVersion: selection.stateVersion,
      reservationToken: reserved.reservationToken,
    };
    const [committed, settled] = await Promise.all([
      repository.completeConfirmationCommand({
        ...common,
        planHash: selectedPlan.planHash,
        actorUserId: ownerId,
        actorRole: 'owner',
        nextState: 'ready',
        gates: [{
          gateType: 'input', gateKey: 'designImage', requiredAuthority: 'owner',
          decision: 'provided', evidenceRef: published.evidenceRef,
          idempotencyKey: `${idempotencyKey}:input:designImage`,
        }],
      }),
      repository.settleVisualPublicationAfterFailure({
        ...common,
        releaseReservation: false,
        reason: 'concurrent failure observer',
      }),
    ]);
    assert.equal(committed.state, 'ready');
    assert.ok(settled === 'live' || settled === 'committed');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('replays a concurrent confirmation after the first request commits between command and task reads', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const firstWorkflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'confirmation-replay-race', {
    candidateId: 'speed',
  });
  const selection = await firstWorkflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'confirmation-replay-race-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
  });
  const confirmation = {
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'confirmation-replay-race-confirm',
    actor: { userId: ownerId, role: 'owner' as const },
    confirmationAnswers: {},
    inputValues: {},
  };
  const racingRepository = new ConfirmationReplayRaceRepository(scopedDatabase);
  const replayPromise = new TaskWorkflowService(racingRepository).confirm(confirmation);
  await racingRepository.initialCommandRead;

  const committed = await firstWorkflow.confirm(confirmation);
  racingRepository.release();
  const replayed = await replayPromise;

  assert.deepEqual(replayed, committed);
  assert.equal((await repository.listGateRecords(created.task.id, selection.planVersionId)).length, 0);
});

test('allows only one concurrent confirmation to seal inputs and leaves the task executable', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-concurrent-confirmation-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(
      repository,
      {
        execute: async ({ lease }) => {
          await repository.completeExecution(lease);
          return { status: 'completed', attemptId: lease.attemptId };
        },
      },
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const created = await createCandidateTask(repository, 'concurrent-confirmation', {
      candidateId: 'speed',
      plan: currentPlan('', 'concurrent-confirmation', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'concurrent-confirmation-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const base = {
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      actor: { userId: ownerId, role: 'owner' as const },
      confirmationAnswers: {},
      inputValues: { designImage: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } },
    };

    const confirmations = await Promise.allSettled([
      workflow.confirm({ ...base, idempotencyKey: 'concurrent-confirmation-a' }),
      workflow.confirm({ ...base, idempotencyKey: 'concurrent-confirmation-b' }),
    ]);
    const fulfilled = confirmations.find((result) => result.status === 'fulfilled');
    const rejected = confirmations.find((result) => result.status === 'rejected');
    assert.ok(fulfilled?.status === 'fulfilled');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof ControlPlaneConflictError);

    const gates = await repository.listGateRecords(created.task.id, selection.planVersionId);
    assert.equal(gates.length, 1);
    assert.equal(gates[0]?.gateKey, 'designImage');
    const connection = await scopedDatabase.connect();
    try {
      const result = await connection.query(
        `SELECT state, count(*)::int AS count
         FROM control_artifacts
         WHERE task_id = $1 AND plan_version_id = $2
         GROUP BY state ORDER BY state`,
        [created.task.id, selection.planVersionId],
      );
      assert.deepEqual(result.rows, [{ state: 'SEALED', count: 2 }]);
    } finally {
      connection.release();
    }

    const execution = await workflow.execute({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: fulfilled.value.stateVersion,
      idempotencyKey: 'concurrent-confirmation-execute',
      actor: { userId: ownerId, role: 'owner' },
    });
    assert.equal(execution.state, 'completed');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('rejects any pre-existing gate on the active plan and invalidates newly sealed inputs', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-orphan-gate-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(
      repository,
      undefined,
      undefined,
      undefined,
      new VisualInputGateStore(artifacts),
    );
    const created = await createCandidateTask(repository, 'orphan-gate', {
      candidateId: 'speed',
      plan: currentPlan('', 'orphan-gate', [currentStep({ input: { designImage: null } })]),
      pendingInputs: [{
        kind: 'visual',
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'designImage', multiple: false }],
      }],
    });
    const selectedPlan = created.candidates.find((candidate) => candidate.candidateId === 'speed')!;
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'orphan-gate-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: selectedPlan.id,
    });
    await repository.recordGate({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      planHash: selectedPlan.planHash,
      gateType: 'input',
      gateKey: 'legacy-orphan',
      requiredAuthority: 'owner',
      decision: 'provided',
      value: 'orphan',
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'legacy-orphan-gate',
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    await assert.rejects(() => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'orphan-gate-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {
        designImage: { dataUrl: `data:image/png;base64,${png.toString('base64')}` },
      },
    }), /already has a gate record/u);

    const persisted = await repository.getTaskDetail(created.task.id);
    assert.equal(persisted?.state, 'awaiting_confirmation');
    const gates = await repository.listGateRecords(created.task.id, selection.planVersionId);
    assert.deepEqual(gates.map(({ gateKey }) => gateKey), ['legacy-orphan']);
    const connection = await scopedDatabase.connect();
    try {
      const result = await connection.query(
        `SELECT state, count(*)::int AS count
         FROM control_artifacts
         WHERE task_id = $1 AND plan_version_id = $2
         GROUP BY state ORDER BY state`,
        [created.task.id, selection.planVersionId],
      );
      assert.deepEqual(result.rows, [{ state: 'FAILED', count: 2 }]);
    } finally {
      connection.release();
    }
    assert.equal(await repository.getCommand(
      created.task.id,
      'confirmation',
      'orphan-gate-confirm',
    ), null);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('confirmation rejects unresolved v2 clarification and post-plan answers', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const unresolved = await createCandidateTask(repository, 'unresolved-confirmation', {
    structuredTask: currentTask({
      clarification_questions: [{
        key: 'competitors',
        question: '竞品范围?',
        rationale: '确认公开研究范围',
      }],
    }),
  });
  const selected = await workflow.select({
    taskId: unresolved.task.id,
    expectedVersion: unresolved.task.stateVersion,
    idempotencyKey: 'unresolved-confirmation-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: unresolved.candidates[0]!.id,
  });
  await assert.rejects(() => workflow.confirm({
    taskId: unresolved.task.id,
    planVersionId: selected.planVersionId,
    expectedVersion: selected.stateVersion,
    idempotencyKey: 'unresolved-confirmation-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  }), (error: unknown) => error instanceof ControlPlaneConflictError
    && /planning integrity/u.test(error.message));
});

test('confirmation, required input, role matrix, and plan revision gate ready state', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository, undefined, {
    async revise({ taskId }) {
      return {
        plan: currentPlan(taskId, 'revised workflow plan'),
        pendingInputs: [],
      };
    },
  });
  const created = await createCandidateTask(repository, 'workflow-gate', {
    structuredTask: currentTask({
      clarification_questions: [],
      blocking_issues: [{ key: 'privacy', kind: 'privacy_compliance', reason: '敏感材料' }],
    }),
    plan: currentPlan('', 'workflow-gate', [currentStep({
      requires_approval: true,
      approval_role: 'security',
    })]),
    pendingInputs: [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
  });
  const task = created.task;

  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'select-1',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });

  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirm-answer-not-allowed',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: { competitors: '头部三家' },
      inputValues: { brief: '研究简报' },
    }),
    (error: unknown) => error instanceof TaskWorkflowGateError
      && error.unresolved.includes('confirmation:competitors'),
  );
  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirm-missing-input',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    }),
    TaskWorkflowGateError,
  );

  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirm-extra-answer',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: { geography: '海外市场' },
      inputValues: { brief: '研究简报' },
    }),
    (error: unknown) => error instanceof TaskWorkflowGateError
      && error.unresolved.includes('confirmation:geography'),
  );

  const confirmed = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'confirm-1',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: { brief: '研究简报' },
  });
  assert.equal(confirmed.state, 'awaiting_approval');

  await assert.rejects(
    () => workflow.approve({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: confirmed.stateVersion,
      idempotencyKey: 'owner-cannot-approve-privacy',
      actor: { userId: ownerId, role: 'owner' },
      gateKey: 'privacy',
      decision: 'approved',
    }),
    TaskWorkflowAuthorizationError,
  );

  const legalApproved = await workflow.approve({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: confirmed.stateVersion,
    idempotencyKey: 'legal-approves-privacy',
    actor: { userId: legalId, role: 'legal' },
    gateKey: 'privacy',
    decision: 'approved',
  });
  assert.equal(legalApproved.state, 'awaiting_approval');
  const securityApproved = await workflow.approve({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: legalApproved.stateVersion,
    idempotencyKey: 'security-approves-step',
    actor: { userId: securityId, role: 'security' },
    gateKey: 'step:1',
    decision: 'approved',
  });
  assert.equal(securityApproved.state, 'ready');
  const approved = securityApproved;
  const revision = await workflow.revise({
    taskId: task.id,
    expectedVersion: approved.stateVersion,
    idempotencyKey: 'revise-after-approval',
    actor: { userId: ownerId, role: 'owner' },
    revisionInstruction: 're-plan after approval',
  });
  const reconfirmed = await workflow.confirm({
    taskId: task.id,
    planVersionId: revision.planVersionId,
    expectedVersion: revision.stateVersion,
    idempotencyKey: 'confirm-revised-plan',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  assert.equal(reconfirmed.state, 'awaiting_approval');
});

test('confirmation persists own input values for execution without mutating the frozen plan', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let observedInputGates: Array<Record<string, unknown>> = [];
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      observedInputGates = (await repository.listGateRecords(lease.taskId, lease.planVersionId))
        .filter((gate) => gate.gateType === 'input')
        .map((gate) => {
          const record = gate as unknown as Record<string, unknown>;
          return {
            gateKey: gate.gateKey,
            requiredAuthority: gate.requiredAuthority,
            value: record.value,
            actorUserId: record.actorUserId,
            actorRole: record.actorRole,
            idempotencyKey: record.idempotencyKey,
          };
        })
        .sort((left, right) => String(left.gateKey).localeCompare(String(right.gateKey)));
      await repository.completeExecution(lease);
      return { status: 'completed', attemptId: lease.attemptId };
    },
  });
  const pendingInputs = [
    {
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    },
    {
      kind: 'value',
      role: 'includeArchived',
      label: '包含历史资料',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'includeArchived', multiple: false }],
    },
    {
      kind: 'value',
      role: 'reviewerNote',
      label: '审阅备注',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'reviewerNote', multiple: false }],
    },
  ];
  const created = await createCandidateTask(repository, 'input-values', {
    candidateId: 'depth',
    plan: currentPlan('', 'input-values', [currentStep({
      input: {
        brief: 'frozen placeholder',
        includeArchived: true,
        reviewerNote: 'frozen placeholder',
      },
    })]),
    pendingInputs,
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'input-values-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const selectedBeforeConfirmation = await repository.getPlanVersionDetail(selection.planVersionId);
  assert.ok(selectedBeforeConfirmation);
  const frozenPlan = structuredClone(selectedBeforeConfirmation.plan);
  const inheritedInputValues = Object.assign(
    Object.create({ brief: { competitors: ['A', 'B'] } }) as Record<string, unknown>,
    { includeArchived: false, reviewerNote: null },
  );

  await assert.rejects(
    () => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'input-values-inherited-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: inheritedInputValues,
    }),
    (error: unknown) => error instanceof TaskWorkflowGateError && error.unresolved.includes('brief'),
  );

  const ready = await workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'input-values-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {
      brief: { competitors: ['A', 'B'] },
      includeArchived: false,
      reviewerNote: null,
    },
  });
  assert.equal(ready.state, 'ready');

  const execution = await workflow.execute({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'input-values-execute',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(execution.state, 'completed');
  assert.deepEqual(observedInputGates, [
    {
      gateKey: 'brief',
      requiredAuthority: 'owner',
      value: { competitors: ['A', 'B'] },
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'input-values-confirm:input:brief',
    },
    {
      gateKey: 'includeArchived',
      requiredAuthority: 'owner',
      value: false,
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'input-values-confirm:input:includeArchived',
    },
    {
      gateKey: 'reviewerNote',
      requiredAuthority: 'owner',
      value: null,
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'input-values-confirm:input:reviewerNote',
    },
  ]);
  assert.deepEqual((await repository.getPlanVersionDetail(selection.planVersionId))?.plan, frozenPlan);
});

test('disabled execution claim creates no real execution work and pauses the task', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'disabled', {
    candidateId: 'speed',
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'disabled-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'disabled-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });

  const execution = await workflow.execute({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'disabled-execute',
    actor: { userId: ownerId, role: 'owner' },
  });
  const replay = await workflow.execute({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'disabled-execute',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.deepEqual(replay, execution);

  assert.equal(execution.executionDisabled, true);
  assert.equal(execution.state, 'paused');
  assert.equal((await repository.listAttempts(task.id)).length, 1);
  const resumed = await workflow.resume({
    taskId: task.id,
    expectedVersion: execution.stateVersion,
    idempotencyKey: 'disabled-resume',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(resumed.state, 'ready');
  const rerun = await workflow.execute({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: resumed.stateVersion,
    idempotencyKey: 'disabled-rerun',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(rerun.state, 'paused');
  assert.equal((await repository.listAttempts(task.id)).length, 2);
});

test('Workflow owns the lease and invokes a real execution driver once per command', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let driverCalls = 0;
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      driverCalls += 1;
      await repository.requireActiveLease(lease);
      await repository.completeExecution(lease);
      return {
        status: 'completed', attemptId: lease.attemptId,
        crossSkillReviewArtifactId: 'cross-review-1',
        contributionLedgerArtifactId: 'ledger-1',
        contributionSummaryArtifactId: 'summary-1',
      };
    },
  });
  const created = await createCandidateTask(repository, 'real', {
    candidateId: 'depth',
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'real-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'real-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const command = {
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'real-execute',
    actor: { userId: ownerId, role: 'owner' as const },
  };

  const execution = await workflow.execute(command);
  const replay = await workflow.execute(command);

  assert.equal(execution.executionDisabled, false);
  assert.equal(execution.state, 'completed');
  assert.equal(execution.crossSkillReviewArtifactId, 'cross-review-1');
  assert.equal(execution.contributionLedgerArtifactId, 'ledger-1');
  assert.equal(execution.contributionSummaryArtifactId, 'summary-1');
  assert.equal('leaseToken' in execution, false);
  assert.deepEqual(replay, execution);
  assert.equal(driverCalls, 1);
});

test('concurrent execute commands invoke the external driver only once', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let driverCalls = 0;
  let announceDriver: (() => void) | undefined;
  let releaseDriver: (() => void) | undefined;
  const driverStarted = new Promise<void>((resolve) => { announceDriver = resolve; });
  const driverRelease = new Promise<void>((resolve) => { releaseDriver = resolve; });
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      driverCalls += 1;
      announceDriver?.();
      await driverRelease;
      await repository.completeExecution(lease);
      return { status: 'completed', attemptId: lease.attemptId };
    },
  });
  const created = await createCandidateTask(repository, 'concurrent', {
    candidateId: 'depth',
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'concurrent-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'concurrent-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const base = {
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    actor: { userId: ownerId, role: 'owner' as const },
  };

  const first = workflow.execute({ ...base, idempotencyKey: 'execute-a' });
  await driverStarted;
  const second = workflow.execute({ ...base, idempotencyKey: 'execute-b' });
  releaseDriver?.();
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(driverCalls, 1);
  assert.equal((await repository.listAttempts(task.id)).length, 1);
});

test('reconstructs final artifact IDs after driver state commit but before command persistence', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-command-loss-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    let driverCalls = 0;
    let expectedArtifactIds: {
      deliverableArtifactId: string;
      evidenceManifestArtifactId: string;
      reportReviewArtifactId: string;
    } | undefined;
    const workflow = new TaskWorkflowService(repository, {
      execute: async ({ lease }) => {
        driverCalls += 1;
        const evidenceManifest = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: {
            version: 'evidence-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
          },
        });
        const deliverable = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'deliverable',
          relativePath: 'deliverables/final-r1.json',
          schemaVersion: 'research-deliverable-v1-review-gated',
          activeLease: lease,
          value: {
            version: 'research-deliverable-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            evidenceManifestArtifactId: evidenceManifest.id,
          },
        });
        const reportReview = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'report_review',
          relativePath: 'reports/review-r1.json',
          schemaVersion: 'report-review-v1',
          activeLease: lease,
          value: {
            version: 'report-review-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            deliverableArtifactId: deliverable.id,
            verdict: 'pass',
            dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
            revisionRound: 1,
          },
        });
        await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/later-manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: {
            version: 'evidence-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
          },
        });
        expectedArtifactIds = {
          deliverableArtifactId: deliverable.id,
          evidenceManifestArtifactId: evidenceManifest.id,
          reportReviewArtifactId: reportReview.id,
        };
        await repository.completeExecution(lease);
        throw new Error('simulated process crash after state commit');
      },
    }, undefined, artifacts);
    const created = await createCandidateTask(repository, 'crash', {
      candidateId: 'depth',
    });
    const task = created.task;
    const selection = await workflow.select({
      taskId: task.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: 'crash-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates[0]!.id,
    });
    const ready = await workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'crash-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    });
    const command = {
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: ready.stateVersion,
      idempotencyKey: 'crash-execute',
      actor: { userId: ownerId, role: 'owner' as const },
    };

    await assert.rejects(() => workflow.execute(command), /simulated process crash/);
    const replay = await workflow.execute(command);

    assert.ok(expectedArtifactIds);
    assert.equal(replay.executionDisabled, false);
    assert.equal(replay.state, 'completed');
    assert.equal('status' in replay && replay.status, 'completed');
    assert.equal('deliverableArtifactId' in replay && replay.deliverableArtifactId, expectedArtifactIds.deliverableArtifactId);
    assert.equal('evidenceManifestArtifactId' in replay && replay.evidenceManifestArtifactId, expectedArtifactIds.evidenceManifestArtifactId);
    assert.equal('reportReviewArtifactId' in replay && replay.reportReviewArtifactId, expectedArtifactIds.reportReviewArtifactId);
    assert.equal('reviewStatus' in replay && replay.reviewStatus, 'completed');
    assert.equal(driverCalls, 1);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('replays a sealed pass Review as completed when post-review failure leaves the task paused', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-paused-review-replay-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    let driverCalls = 0;
    let expectedArtifactIds: {
      deliverableArtifactId: string;
      evidenceManifestArtifactId: string;
      reportReviewArtifactId: string;
    } | undefined;
    const workflow = new TaskWorkflowService(repository, {
      execute: async ({ lease }) => {
        driverCalls += 1;
        const evidenceManifest = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: {
            version: 'evidence-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
          },
        });
        const deliverable = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'deliverable',
          relativePath: 'deliverables/final-r1.json',
          schemaVersion: 'research-deliverable-v1-review-gated',
          activeLease: lease,
          value: {
            version: 'research-deliverable-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            evidenceManifestArtifactId: evidenceManifest.id,
          },
        });
        const reportReview = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'report_review',
          relativePath: 'reports/review-r1.json',
          schemaVersion: 'report-review-v1',
          activeLease: lease,
          value: {
            version: 'report-review-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            deliverableArtifactId: deliverable.id,
            verdict: 'pass',
            dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
            revisionRound: 1,
          },
        });
        expectedArtifactIds = {
          deliverableArtifactId: deliverable.id,
          evidenceManifestArtifactId: evidenceManifest.id,
          reportReviewArtifactId: reportReview.id,
        };
        await repository.recordExecutionStep({
          ...lease,
          stepNo: 99,
          stepName: 'post-review packaging',
          actorType: 'system',
          actorId: 'report-package',
          state: 'failed',
          failure: { kind: 'post_review', allowedActions: ['retry', 'abort'] },
        });
        const executingTask = await repository.getTaskDetail(lease.taskId);
        assert.ok(executingTask);
        await repository.pauseExecution({
          taskId: lease.taskId,
          attemptId: lease.attemptId,
          expectedVersion: executingTask.stateVersion,
          reason: 'post_review',
        });
        throw new Error('simulated process crash after post-review pause');
      },
    }, undefined, artifacts);
    const created = await createCandidateTask(repository, 'paused-review-replay', {
      candidateId: 'depth',
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'paused-review-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates[0]!.id,
    });
    const ready = await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'paused-review-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    });
    const command = {
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: ready.stateVersion,
      idempotencyKey: 'paused-review-execute',
      actor: { userId: ownerId, role: 'owner' as const },
    };

    await assert.rejects(() => workflow.execute(command), /simulated process crash/);
    const replay = await workflow.execute(command);

    assert.ok(expectedArtifactIds);
    assert.equal(replay.state, 'paused');
    assert.equal('status' in replay && replay.status, 'paused');
    assert.equal('deliverableArtifactId' in replay && replay.deliverableArtifactId, expectedArtifactIds.deliverableArtifactId);
    assert.equal('evidenceManifestArtifactId' in replay && replay.evidenceManifestArtifactId, expectedArtifactIds.evidenceManifestArtifactId);
    assert.equal('reportReviewArtifactId' in replay && replay.reportReviewArtifactId, expectedArtifactIds.reportReviewArtifactId);
    assert.equal('reviewStatus' in replay && replay.reviewStatus, 'completed');
    assert.equal(driverCalls, 1);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('rejects a sealed hash-valid Review with an unknown verdict during paused replay', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-unknown-review-replay-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(repository, {
      execute: async ({ lease }) => {
        const evidenceManifest = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: { version: 'evidence-v1', taskId: lease.taskId, planVersionId: lease.planVersionId, attemptId: lease.attemptId },
        });
        const deliverable = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'deliverable',
          relativePath: 'deliverables/final-r0.json',
          schemaVersion: 'research-deliverable-v1-review-gated',
          activeLease: lease,
          value: {
            version: 'research-deliverable-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            evidenceManifestArtifactId: evidenceManifest.id,
          },
        });
        await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'report_review',
          relativePath: 'reports/review-r0.json',
          schemaVersion: 'report-review-v1',
          activeLease: lease,
          value: {
            version: 'report-review-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            deliverableArtifactId: deliverable.id,
            verdict: 'unknown',
            dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
            revisionRound: 0,
          },
        });
        const executingTask = await repository.getTaskDetail(lease.taskId);
        assert.ok(executingTask);
        await repository.pauseExecution({
          taskId: lease.taskId,
          attemptId: lease.attemptId,
          expectedVersion: executingTask.stateVersion,
          reason: 'post_review',
        });
        throw new Error('simulated process crash after unknown Review');
      },
    }, undefined, artifacts);
    const created = await createCandidateTask(repository, 'unknown-review-replay', { candidateId: 'depth' });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'unknown-review-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates[0]!.id,
    });
    const ready = await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'unknown-review-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    });
    const command = {
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: ready.stateVersion,
      idempotencyKey: 'unknown-review-execute',
      actor: { userId: ownerId, role: 'owner' as const },
    };

    await assert.rejects(() => workflow.execute(command), /simulated process crash/);
    await assert.rejects(() => workflow.execute(command), ControlPlaneConflictError);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('owner can cancel an active execution and revoke its lease', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'cancel active execution',
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: currentPlan(task.id, 'cancel-active', [
      currentStep({ actor_type: 'tool', actor_id: 'tavily-web-search' }),
    ]),
    planHash: 'sha256:cancel-active-plan',
    pendingInputs: [],
  });
  const leaseToken = randomUUID();
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'cancel-active-claim',
    requestHash: 'sha256:cancel-active-claim',
    leaseOwner: 'cancel-test',
    leaseTokenHash: `sha256:${createHash('sha256').update(leaseToken).digest('hex')}`,
  });

  const cancelCommand = {
    taskId: task.id,
    expectedVersion: claim.stateVersion,
    idempotencyKey: 'cancel-active-command',
    actor: { userId: ownerId, role: 'owner' as const },
  };
  const failingWorkflow = new TaskWorkflowService(new ControlPlaneRepository(
    new CancelCommandFailingDatabase(scopedDatabase),
  ));
  await assert.rejects(
    () => failingWorkflow.cancel(cancelCommand),
    /simulated cancel command persistence failure/u,
  );
  assert.equal((await repository.getTaskDetail(task.id))?.state, 'executing');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'active');

  const cancelled = await workflow.cancel(cancelCommand);

  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(await workflow.cancel(cancelCommand), cancelled);
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'cancelled');
  await assert.rejects(
    () => repository.requireActiveLease({
      taskId: task.id,
      planVersionId: plan.id,
      attemptId: claim.attemptId,
      leaseOwner: 'cancel-test',
      leaseToken,
    }),
    ControlPlaneConflictError,
  );
});

async function createPausedTask(input: {
  repository: ControlPlaneRepository;
  suffix: string;
  failedStepNo: number;
  steps: CurrentPlanStep[];
  allowedActions: string[];
  pendingInputs?: unknown[];
  failureKind?: string;
  planFactory?: (taskId: string, steps: CurrentPlanStep[]) => CurrentExecutionPlan;
}) {
  const task = await input.repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: `${input.suffix} resume`,
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'ready',
  });
  const plan = await input.repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: input.planFactory?.(task.id, input.steps) ?? currentPlan(task.id, input.suffix, input.steps),
    planHash: `sha256:${input.suffix}-resume-plan`,
    pendingInputs: input.pendingInputs ?? [],
  });
  const leaseOwner = 'resume-test';
  const leaseToken = randomUUID();
  const claim = await input.repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: `${input.suffix}-claim`,
    requestHash: `sha256:${input.suffix}-claim`,
    leaseOwner,
    leaseTokenHash: `sha256:${createHash('sha256').update(leaseToken).digest('hex')}`,
  });
  const failedStep = input.steps.find((step) => step.step_no === input.failedStepNo);
  assert.ok(failedStep && failedStep.actor_type === 'tool');
  await input.repository.recordExecutionStep({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    leaseOwner,
    leaseToken,
    stepNo: failedStep.step_no,
    stepName: failedStep.step_name,
    actorType: failedStep.actor_type,
    actorId: failedStep.actor_id,
    state: 'failed',
    failure: {
      kind: input.failureKind ?? 'network',
      toolTier: input.allowedActions.includes('skip') ? 'optional' : 'core',
      allowedActions: input.allowedActions,
    },
  });
  const paused = await input.repository.pauseExecution({
    taskId: task.id,
    attemptId: claim.attemptId,
    expectedVersion: claim.stateVersion,
    reason: input.failureKind ?? 'network',
  });
  return { task, plan, paused };
}

test('paused Knowledge drift can replan and clears the obsolete execution attempt', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const paused = await createPausedTask({
    repository,
    suffix: 'knowledge-drift-replan',
    failedStepNo: 1,
    steps: [currentStep({ actor_type: 'tool', actor_id: 'tavily-web-search' })],
    allowedActions: ['replan', 'abort'],
    failureKind: 'knowledge_configuration_drift',
  });
  const workflow = new TaskWorkflowService(repository, undefined, {
    revise: async ({ activePlanVersionId }) => {
      const active = await repository.getPlanVersionDetail(activePlanVersionId);
      if (!active) throw new Error('active plan missing');
      return {
        plan: active.plan,
        pendingInputs: Array.isArray(active.pendingInputs) ? active.pendingInputs : [],
      };
    },
  });

  const replanned = await workflow.revise({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'knowledge-drift-replan-command',
    actor: { userId: ownerId, role: 'owner' },
    revisionInstruction: 'Refresh frozen Knowledge resources',
  });
  assert.equal(replanned.state, 'awaiting_confirmation');
  const task = await repository.getTaskDetail(paused.task.id);
  assert.equal(task?.currentAttemptId, null);
  assert.notEqual(task?.activePlanVersionId, paused.plan.id);
});

test('worker-loss retry without failedStepNo validates recovery before accepting recovered state', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const paused = await createPausedTask({
    repository,
    suffix: 'retry-recovered-state',
    failedStepNo: 1,
    steps: [currentStep({ actor_type: 'tool', actor_id: 'tavily-web-search' })],
    allowedActions: ['retry', 'abort'],
    failureKind: 'worker_loss',
  });

  const resumed = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'retry-recovered-state-first',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(resumed.state, 'ready');
  const recovered = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'retry-recovered-state-legitimate',
    actor: { userId: ownerId, role: 'owner' },
    action: 'retry',
    failedStepNo: 1,
  });
  assert.deepEqual(recovered, resumed);
  await assert.rejects(
    () => workflow.resume({
      taskId: paused.task.id,
      expectedVersion: paused.paused.stateVersion,
      idempotencyKey: 'retry-recovered-state-wrong-step',
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo: 99,
    }),
    TaskWorkflowGateError,
  );
  await assert.rejects(
    () => workflow.resume({
      taskId: paused.task.id,
      expectedVersion: paused.paused.stateVersion,
      idempotencyKey: 'retry-recovered-state-wrong-action',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 1,
    }),
    TaskWorkflowGateError,
  );
});

test('worker-loss sentinel permits abort and exposes the failure on execution replay', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let driverCalls = 0;
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      driverCalls += 1;
      const connection = await scopedDatabase.connect();
      try {
        await connection.query(
          `UPDATE control_execution_attempts
           SET lease_expires_at = now() - interval '1 second'
           WHERE id = $1`,
          [lease.attemptId],
        );
      } finally {
        connection.release();
      }
      await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
      throw new Error('simulated worker death after external lease recovery');
    },
  });
  const created = await createCandidateTask(repository, 'worker-loss-sentinel', {
    candidateId: 'depth',
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'worker-loss-sentinel-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'worker-loss-sentinel-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const command = {
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'worker-loss-sentinel-execute',
    actor: { userId: ownerId, role: 'owner' as const },
  };

  await assert.rejects(
    () => workflow.execute(command),
    /simulated worker death after external lease recovery/u,
  );
  const replay = await workflow.execute(command);
  assert.equal(replay.executionDisabled, false);
  assert.equal(replay.state, 'paused');
  assert.equal('failedStepNo' in replay && replay.failedStepNo, 1);
  assert.equal('failure' in replay && replay.failure?.kind, 'worker_loss');
  assert.equal(driverCalls, 1);

  const aborted = await workflow.resume({
    taskId: created.task.id,
    expectedVersion: replay.stateVersion,
    idempotencyKey: 'worker-loss-sentinel-abort',
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
  });
  assert.equal(aborted.state, 'cancelled');
});

test('worker-loss replay prefers the recovered running step over a higher peer failure', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      await repository.recordExecutionStep({
        ...lease,
        stepNo: 1,
        stepName: 'slow parallel peer',
        actorType: 'tool',
        actorId: 'tavily-web-search',
        state: 'running',
      });
      await repository.recordExecutionStep({
        ...lease,
        stepNo: 2,
        stepName: 'failed parallel peer',
        actorType: 'skill',
        actorId: 'generate-competitive-analysis',
        state: 'failed',
        failure: { kind: 'schema', allowedActions: ['abort'] },
      });
      const connection = await scopedDatabase.connect();
      try {
        await connection.query(
          `UPDATE control_execution_attempts
           SET lease_expires_at = now() - interval '1 second'
           WHERE id = $1`,
          [lease.attemptId],
        );
      } finally {
        connection.release();
      }
      await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
      throw new Error('simulated mixed-wave worker death');
    },
  });
  const created = await createCandidateTask(repository, 'worker-loss-mixed-wave', {
    candidateId: 'depth',
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'worker-loss-mixed-wave-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'worker-loss-mixed-wave-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const command = {
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'worker-loss-mixed-wave-execute',
    actor: { userId: ownerId, role: 'owner' as const },
  };

  await assert.rejects(
    () => workflow.execute(command),
    /simulated mixed-wave worker death/u,
  );
  const replay = await workflow.execute(command);
  assert.equal(replay.executionDisabled, false);
  assert.equal(replay.state, 'paused');
  assert.equal('failedStepNo' in replay && replay.failedStepNo, 1);
  assert.deepEqual(
    'failure' in replay && replay.failure,
    { kind: 'worker_loss', retryable: true, allowedActions: ['retry', 'abort'] },
  );
  assert.deepEqual(
    (await repository.listExecutionSteps(replay.attemptId)).map((step) => ({
      stepNo: step.stepNo,
      kind: step.failure?.kind,
    })),
    [
      { stepNo: 1, kind: 'worker_loss' },
      { stepNo: 2, kind: 'schema' },
    ],
  );
});

test('artifact invalidation remains authoritative over a later worker-loss sentinel', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      await repository.recordExecutionStep({
        ...lease,
        stepNo: 1,
        stepName: 'browser publication',
        actorType: 'tool',
        actorId: 'playwright-page-capture',
        state: 'failed',
        failure: {
          kind: 'artifact_invalidation',
          retryable: false,
          allowedActions: ['abort'],
        },
      });
      await repository.recordExecutionStep({
        ...lease,
        stepNo: 2,
        stepName: 'worker lease expired',
        actorType: 'system',
        actorId: 'worker-loss',
        state: 'failed',
        failure: {
          kind: 'worker_loss',
          retryable: true,
          allowedActions: ['retry', 'abort'],
        },
      });
      await repository.pauseExecution({
        taskId: lease.taskId,
        attemptId: lease.attemptId,
        expectedVersion: (await repository.requireActiveLease(lease)).stateVersion,
        reason: 'worker_loss',
      });
      throw new Error('simulated response loss after conflicting terminal failures');
    },
  });
  const created = await createCandidateTask(repository, 'artifact-invalidation-authority', {
    candidateId: 'depth',
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'artifact-invalidation-authority-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'artifact-invalidation-authority-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const command = {
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'artifact-invalidation-authority-execute',
    actor: { userId: ownerId, role: 'owner' as const },
  };

  await assert.rejects(
    () => workflow.execute(command),
    /simulated response loss after conflicting terminal failures/u,
  );
  const replay = await workflow.execute(command);
  assert.equal(replay.state, 'paused');
  assert.equal('failedStepNo' in replay && replay.failedStepNo, 1);
  assert.deepEqual(
    'failure' in replay && replay.failure,
    { kind: 'artifact_invalidation', retryable: false, allowedActions: ['abort'] },
  );
  await assert.rejects(
    () => workflow.resume({
      taskId: created.task.id,
      expectedVersion: replay.stateVersion,
      idempotencyKey: 'artifact-invalidation-authority-default-retry',
      actor: { userId: ownerId, role: 'owner' },
    }),
    TaskWorkflowGateError,
  );
  await assert.rejects(
    () => workflow.resume({
      taskId: created.task.id,
      expectedVersion: replay.stateVersion,
      idempotencyKey: 'artifact-invalidation-authority-sentinel-retry',
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo: 2,
    }),
    TaskWorkflowGateError,
  );
  const aborted = await workflow.resume({
    taskId: created.task.id,
    expectedVersion: replay.stateVersion,
    idempotencyKey: 'artifact-invalidation-authority-abort',
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
  });
  assert.equal(aborted.state, 'cancelled');
});

test('report review failure rejects retry and permits only abort recovery', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'non-retryable report review recovery',
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'ready',
  });
  const planSteps = [currentStep({ actor_type: 'tool', actor_id: 'tavily-web-search' })];
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: currentPlan(task.id, 'report-review-recovery', planSteps),
    planHash: `sha256:${randomUUID()}`,
  });
  const leaseOwner = 'review-recovery-test';
  const leaseToken = randomUUID();
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: `review-claim-${randomUUID()}`,
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner,
    leaseTokenHash: `sha256:${createHash('sha256').update(leaseToken).digest('hex')}`,
  });
  const failedStepNo = planSteps.length + 2;
  await repository.recordExecutionStep({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    leaseOwner,
    leaseToken,
    stepNo: failedStepNo,
    stepName: 'report review',
    actorType: 'reviewer',
    actorId: 'report-review',
    state: 'failed',
    failure: {
      kind: 'report_review',
      retryable: false,
      allowedActions: ['abort'],
      verdict: 'block',
    },
  });
  const paused = await repository.pauseExecution({
    taskId: task.id,
    attemptId: claim.attemptId,
    expectedVersion: claim.stateVersion,
    reason: 'report_review',
  });

  await assert.rejects(
    () => workflow.resume({
      taskId: task.id,
      expectedVersion: paused.stateVersion,
      idempotencyKey: `review-forged-retry-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo: failedStepNo + 100,
    }),
    TaskWorkflowGateError,
  );
  assert.equal((await repository.getTaskDetail(task.id))?.state, 'paused');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'paused');

  await assert.rejects(
    () => workflow.resume({
      taskId: task.id,
      expectedVersion: paused.stateVersion,
      idempotencyKey: `review-retry-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo,
    }),
    TaskWorkflowGateError,
  );
  assert.equal((await repository.getTaskDetail(task.id))?.state, 'paused');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'paused');

  const aborted = await workflow.resume({
    taskId: task.id,
    expectedVersion: paused.stateVersion,
    idempotencyKey: `review-abort-${randomUUID()}`,
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
    failedStepNo,
  });
  assert.equal(aborted.state, 'cancelled');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'cancelled');
  const recoveredAbort = await workflow.resume({
    taskId: task.id,
    expectedVersion: paused.stateVersion,
    idempotencyKey: `review-abort-recovered-${randomUUID()}`,
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
    failedStepNo,
  });
  assert.deepEqual(recoveredAbort, aborted);
  await assert.rejects(
    () => workflow.resume({
      taskId: task.id,
      expectedVersion: paused.stateVersion,
      idempotencyKey: `review-abort-wrong-step-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
      action: 'abort',
      failedStepNo: failedStepNo + 1,
    }),
    TaskWorkflowGateError,
  );
});

test('resume rejects core skip and safely renumbers a strict Current plan after optional skip', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const core = await createPausedTask({
    repository,
    suffix: 'core-resume',
    failedStepNo: 1,
    steps: [
      currentStep({
        step_name: 'failed core tool',
        actor_type: 'tool',
        actor_id: 'tavily-web-search',
        expected_outputs: [{ pointer: '/results', description: 'core results' }],
      }),
      currentStep({ step_no: 2, step_name: 'analysis', actor_id: 'analysis' }),
    ],
    allowedActions: ['retry', 'abort'],
  });
  await assert.rejects(
    () => workflow.resume({
      taskId: core.task.id,
      expectedVersion: core.paused.stateVersion,
      idempotencyKey: 'core-skip',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 1,
    }),
    TaskWorkflowGateError,
  );
  const aborted = await workflow.resume({
    taskId: core.task.id,
    expectedVersion: core.paused.stateVersion,
    idempotencyKey: 'core-abort',
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
    failedStepNo: 1,
  });
  assert.equal(aborted.state, 'cancelled');
  assert.equal((await repository.listAttempts(core.task.id))[0]?.state, 'cancelled');

  const originalOptionalSteps = [
    currentStep({
      step_name: 'core search',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      expected_outputs: [{ pointer: '/results', description: 'core results' }],
    }),
    currentStep({
      step_no: 2,
      step_name: 'failed optional search',
      actor_type: 'tool',
      actor_id: 'ai-spider-search',
      expected_outputs: [{ pointer: '/results', description: 'optional results' }],
    }),
    currentStep({
      step_no: 3,
      step_name: 'analysis',
      actor_id: 'analysis',
      depends_on: [1],
      input: { sources: null },
      input_bindings: [{ target_pointer: '/sources', source_step_no: 1, source_pointer: '/results' }],
      expected_outputs: [{ pointer: '/text', description: 'analysis result' }],
    }),
    currentStep({
      step_no: 4,
      step_name: 'review',
      actor_type: 'reviewer',
      actor_id: 'reviewer',
      depends_on: [3],
      input: { analysis: null },
      input_bindings: [{ target_pointer: '/analysis', source_step_no: 3, source_pointer: '/text' }],
      expected_outputs: [{ pointer: '/review', description: 'review result' }],
    }),
  ];
  const optional = await createPausedTask({
    repository,
    suffix: 'optional-resume',
    failedStepNo: 2,
    steps: originalOptionalSteps,
    allowedActions: ['retry', 'skip', 'abort'],
  });
  const skipped = await workflow.resume({
    taskId: optional.task.id,
    expectedVersion: optional.paused.stateVersion,
    idempotencyKey: 'optional-skip',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 2,
  });
  assert.equal(skipped.state, 'awaiting_confirmation');
  const recoveredSkip = await workflow.resume({
    taskId: optional.task.id,
    expectedVersion: optional.paused.stateVersion,
    idempotencyKey: 'optional-skip-recovered',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 2,
  });
  assert.deepEqual(recoveredSkip, skipped);
  await assert.rejects(
    () => workflow.resume({
      taskId: optional.task.id,
      expectedVersion: optional.paused.stateVersion,
      idempotencyKey: 'optional-skip-wrong-step',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 99,
    }),
    TaskWorkflowGateError,
  );
  const revisedTask = await repository.getTaskDetail(optional.task.id);
  assert.notEqual(revisedTask?.activePlanVersionId, optional.plan.id);
  const revisedPlan = await repository.getPlanVersionDetail(revisedTask?.activePlanVersionId ?? '');
  assert.equal(revisedPlan?.candidateId, 'speed');
  const expectedSteps = [
    originalOptionalSteps[0]!,
    { ...originalOptionalSteps[2]!, step_no: 2 },
    {
      ...originalOptionalSteps[3]!,
      step_no: 3,
      depends_on: [2],
      input_bindings: [{ target_pointer: '/analysis', source_step_no: 2, source_pointer: '/text' }],
    },
  ];
  assert.deepEqual(revisedPlan?.plan, {
    ...currentPlan(optional.task.id, 'optional-resume', originalOptionalSteps),
    steps: expectedSteps,
  });
});

test('resume skip preserves a legacy v2 Invocation id while remapping its owned step', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const invocationId = 'competitive-analysis:2';
  const steps = [
    currentStep({
      step_name: 'failed optional search',
      actor_type: 'tool',
      actor_id: 'ai-spider-search',
      expected_outputs: [{ pointer: '/results', description: 'optional results' }],
    }),
    currentStep({
      step_no: 2,
      step_name: 'competitive analysis',
      actor_type: 'skill',
      actor_id: 'competitive-analysis',
      input: { research_goal: 'compare competitors' },
      expected_outputs: [{ pointer: '/payload', description: 'analysis result' }],
      skill_invocation_id: invocationId,
    }),
  ];
  const paused = await createPausedTask({
    repository,
    suffix: 'legacy-v2-invocation-remap',
    failedStepNo: 1,
    steps,
    allowedActions: ['retry', 'skip', 'abort'],
    planFactory(taskId, planSteps) {
      const plan = currentPlan(taskId, 'legacy-v2-invocation-remap', planSteps);
      const skill = new SkillLoader().listCapabilitySkills()
        .find(({ id }) => id === 'competitive-analysis');
      assert.ok(skill?.status === 'active');
      plan.capability_decisions.eligible.push({
        skill,
        reasons: [{ code: 'eligible', message: 'fixture Skill is eligible' }],
        pending_inputs: [],
        required_approvals: [],
        optional_tool_decisions: [],
      });
      plan.execution_contract_version = 'current-execution-plan-v2';
      plan.skill_invocations = [{
        invocation_id: invocationId,
        skill_id: 'competitive-analysis',
        execution_mode: 'legacy_single_call',
        step_nos: [2],
      }];
      return plan;
    },
  });

  const skipped = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'legacy-v2-invocation-remap',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 1,
  });
  assert.equal(skipped.state, 'awaiting_confirmation');

  const task = await repository.getTaskDetail(paused.task.id);
  const revised = await repository.getPlanVersionDetail(task?.activePlanVersionId ?? '');
  const revisedPlan = revised?.plan as CurrentExecutionPlan | undefined;
  assert.equal(revisedPlan?.execution_contract_version, 'current-execution-plan-v2');
  assert.deepEqual(revisedPlan?.skill_invocations, [{
    invocation_id: invocationId,
    skill_id: 'competitive-analysis',
    execution_mode: 'legacy_single_call',
    step_nos: [1],
  }]);
  assert.equal(revisedPlan?.steps[0]?.skill_invocation_id, invocationId);
  assert.equal(revisedPlan?.steps[0]?.step_no, 1);
});

test('resume skip remaps every remaining PendingInput target with the step map', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const steps = [
    currentStep({
      step_name: 'core search',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      expected_outputs: [{ pointer: '/results', description: 'core results' }],
    }),
    currentStep({
      step_no: 2,
      step_name: 'failed optional search',
      actor_type: 'tool',
      actor_id: 'ai-spider-search',
      expected_outputs: [{ pointer: '/results', description: 'optional results' }],
    }),
    currentStep({
      step_no: 3,
      step_name: 'analysis skill',
      actor_type: 'skill',
      actor_id: 'analysis-skill',
      depends_on: [1],
      input: { brief: null, sources: null },
      input_bindings: [{ target_pointer: '/sources', source_step_no: 1, source_pointer: '/results' }],
      expected_outputs: [{ pointer: '/payload/analysis', description: 'analysis result' }],
    }),
    currentStep({
      step_no: 4,
      step_name: 'review skill',
      actor_type: 'skill',
      actor_id: 'review-skill',
      depends_on: [3],
      input: { brief: null, analysis: null },
      input_bindings: [{ target_pointer: '/analysis', source_step_no: 3, source_pointer: '/payload/analysis' }],
      expected_outputs: [{ pointer: '/payload/review', description: 'review result' }],
    }),
  ];
  const pendingInputs = [{
    kind: 'value',
    role: 'brief',
    label: '研究简报',
    multiple: true,
    targets: [
      { step_no: 3, tool_id: 'analysis-skill', field: 'brief', multiple: true },
      { step_no: 4, tool_id: 'review-skill', field: 'brief', multiple: true },
    ],
  }];
  const paused = await createPausedTask({
    repository,
    suffix: 'pending-target-remap',
    failedStepNo: 2,
    steps,
    allowedActions: ['retry', 'skip', 'abort'],
    pendingInputs,
    planFactory(taskId, planSteps) {
      const plan = currentPlan(taskId, 'pending-target-remap', planSteps);
      plan.capability_decisions.eligible.push(
        {
          skill: {
            id: 'analysis-skill',
            status: 'active',
            task_types: ['competitive_research'],
            inputs: ['brief'],
            outputs: ['analysis'],
            required_tools: [],
          },
          reasons: [
            { code: 'pending_input_required', message: 'analysis requires a brief' },
            { code: 'eligible', message: 'analysis skill is eligible' },
          ],
          pending_inputs: [{
            kind: 'value',
            role: 'brief',
            label: '研究简报',
            multiple: true,
            capability_id: 'analysis-skill',
          }],
          required_approvals: [],
        },
        {
          skill: {
            id: 'review-skill',
            status: 'active',
            task_types: ['competitive_research'],
            inputs: ['brief'],
            outputs: ['review'],
            required_tools: [],
          },
          reasons: [
            { code: 'pending_input_required', message: 'review requires a brief' },
            { code: 'eligible', message: 'review skill is eligible' },
          ],
          pending_inputs: [{
            kind: 'value',
            role: 'brief',
            label: '研究简报',
            multiple: true,
            capability_id: 'review-skill',
          }],
          required_approvals: [],
        },
      );
      return plan;
    },
  });

  const resumed = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'pending-target-remap-skip',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 2,
  });
  assert.equal(resumed.state, 'awaiting_confirmation');
  const revisedTask = await repository.getTaskDetail(paused.task.id);
  const revisedPlan = await repository.getPlanVersionDetail(revisedTask?.activePlanVersionId ?? '');
  assert.deepEqual(revisedPlan?.pendingInputs, [{
    kind: 'value',
    role: 'brief',
    label: '研究简报',
    multiple: true,
    targets: [
      { step_no: 2, tool_id: 'analysis-skill', field: 'brief', multiple: true },
      { step_no: 3, tool_id: 'review-skill', field: 'brief', multiple: true },
    ],
  }]);
});

test('resume skip rejects a PendingInput target that points at the removed step', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const paused = await createPausedTask({
    repository,
    suffix: 'removed-pending-target',
    failedStepNo: 1,
    steps: [
      currentStep({
        step_name: 'failed optional search',
        actor_type: 'tool',
        actor_id: 'ai-spider-search',
        input: { brief: null },
        expected_outputs: [{ pointer: '/results', description: 'optional results' }],
      }),
      currentStep({ step_no: 2, step_name: 'remaining analysis' }),
    ],
    allowedActions: ['retry', 'skip', 'abort'],
    pendingInputs: [{
      kind: 'value',
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'ai-spider-search', field: 'brief', multiple: false }],
    }],
  });

  await assert.rejects(
    () => workflow.resume({
      taskId: paused.task.id,
      expectedVersion: paused.paused.stateVersion,
      idempotencyKey: 'removed-pending-target-skip',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 1,
    }),
    TaskWorkflowGateError,
  );
  const unchanged = await repository.getTaskDetail(paused.task.id);
  assert.equal(unchanged?.state, 'paused');
  assert.equal(unchanged?.activePlanVersionId, paused.plan.id);
});

test('resume rejects skipping an optional step referenced by a remaining dependency or input binding', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const references = [
    {
      kind: 'dependency',
      step: currentStep({ step_no: 2, depends_on: [1] }),
    },
    {
      kind: 'binding',
      step: currentStep({
        step_no: 2,
        input: { source: null },
        input_bindings: [{ target_pointer: '/source', source_step_no: 1, source_pointer: '/results' }],
      }),
    },
  ] as const;

  for (const reference of references) {
    const paused = await createPausedTask({
      repository,
      suffix: `referenced-${reference.kind}`,
      failedStepNo: 1,
      steps: [
        currentStep({
          step_name: 'failed optional search',
          actor_type: 'tool',
          actor_id: 'ai-spider-search',
          expected_outputs: [{ pointer: '/results', description: 'optional results' }],
        }),
        reference.step,
      ],
      allowedActions: ['retry', 'skip', 'abort'],
    });
    await assert.rejects(
      () => workflow.resume({
        taskId: paused.task.id,
        expectedVersion: paused.paused.stateVersion,
        idempotencyKey: `referenced-${reference.kind}-skip`,
        actor: { userId: ownerId, role: 'owner' },
        action: 'skip',
        failedStepNo: 1,
      }),
      TaskWorkflowGateError,
    );
    const unchanged = await repository.getTaskDetail(paused.task.id);
    assert.equal(unchanged?.state, 'paused');
    assert.equal(unchanged?.activePlanVersionId, paused.plan.id);
  }
});

test('resume rejects non-contiguous or out-of-order Current step numbers before skip remapping', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const malformedPlans = [
    {
      kind: 'gapped',
      failedStepNo: 1,
      steps: [
        currentStep({
          step_name: 'failed optional search',
          actor_type: 'tool',
          actor_id: 'ai-spider-search',
          expected_outputs: [{ pointer: '/results', description: 'optional results' }],
        }),
        currentStep({ step_no: 3 }),
      ],
    },
    {
      kind: 'out-of-order',
      failedStepNo: 2,
      steps: [
        currentStep({
          step_no: 2,
          step_name: 'failed optional search',
          actor_type: 'tool',
          actor_id: 'ai-spider-search',
          expected_outputs: [{ pointer: '/results', description: 'optional results' }],
        }),
        currentStep(),
      ],
    },
  ] as const;

  for (const malformed of malformedPlans) {
    const paused = await createPausedTask({
      repository,
      suffix: `malformed-${malformed.kind}`,
      failedStepNo: malformed.failedStepNo,
      steps: [...malformed.steps],
      allowedActions: ['retry', 'skip', 'abort'],
    });
    await assert.rejects(
      () => workflow.resume({
        taskId: paused.task.id,
        expectedVersion: paused.paused.stateVersion,
        idempotencyKey: `malformed-${malformed.kind}-skip`,
        actor: { userId: ownerId, role: 'owner' },
        action: 'skip',
        failedStepNo: malformed.failedStepNo,
      }),
      TaskWorkflowGateError,
    );
    const unchanged = await repository.getTaskDetail(paused.task.id);
    assert.equal(unchanged?.state, 'paused');
    assert.equal(unchanged?.activePlanVersionId, paused.plan.id);
  }
});
