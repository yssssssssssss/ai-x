import { closePool, loadEnv, pool } from '../../../database/db.ts';
loadEnv(); // 读 .env:DATABASE_URL / LLM 网关 / JWT_SECRET

import express from 'express';
import { ControlPlaneRepository, type ControlTaskDetail } from '../../../database/control-plane.ts';
import { TaskWorkflowService } from '../../orchestrator-runtime/src/control/task-workflow.ts';
import {
  ControlPlaneExecutionRecoveryStore,
  ExecutionRecoveryController,
  ExecutionRecoveryService,
} from '../../orchestrator-runtime/src/control/execution-recovery-service.ts';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { tasksRouter } from './routes/tasks.ts';
import { feedbackRouter } from './routes/feedback.ts';
import { skillsRouter } from './routes/skills.ts';
import { taskHistoryRouter } from './routes/task-history.ts';
import { createControlTasksRouter, type ControlClarificationPort } from './routes/control-tasks.ts';
import {
  createControlPlanningRouter,
  type ClarificationRequiredResponse,
  type ControlPlanningPort,
  type CurrentPlanningResponse,
} from './routes/control-planning.ts';
import { requireJwtSecret } from './auth.ts';
import { buildControlRuntime, type ControlRuntime } from './control-runtime.ts';
export interface AgentApiDependencies {
  controlRuntime?: ControlRuntime;
  controlPlanning?: ControlPlanningPort;
}

function refinementResponse(
  result: { status: 'clarification_required'; taskId: string; requirement: ClarificationRequiredResponse['structuredTask'] },
  task: ControlTaskDetail | null,
): ClarificationRequiredResponse {
  if (!task) throw new Error(`task ${result.taskId} disappeared after refinement`);
  return {
    kind: 'current',
    status: 'clarification_required',
    conversationId: task.conversationId,
    task: {
      id: task.id,
      state: task.state,
      stateVersion: task.stateVersion,
      activePlanVersionId: task.activePlanVersionId,
      currentAttemptId: task.currentAttemptId,
    },
    structuredTask: result.requirement,
    activatedNodes: [],
    candidates: [],
  };
}

async function failIncompletePlanningTask(runtime: ControlRuntime, taskId: string): Promise<void> {
  try {
    const task = await runtime.repository.getTaskDetail(taskId);
    if (task?.state !== 'awaiting_clarification') return;
    await runtime.repository.transitionTask({
      taskId,
      expectedVersion: task.stateVersion,
      from: 'awaiting_clarification',
      to: 'failed',
    });
  } catch {
    // Preserve the planning error. A concurrent state change makes this cleanup unnecessary.
  }
}

function refinementPlanningPort(runtime: ControlRuntime): ControlPlanningPort {
  return {
    async plan(input, onProgress, onConversation): Promise<CurrentPlanningResponse> {
      const conversation = input.conversationId
        ? await runtime.conversations.requireOwned({
            conversationId: input.conversationId,
            ownerUserId: input.ownerUserId,
          })
        : await runtime.conversations.create({
            ownerUserId: input.ownerUserId,
            title: input.originalInput.slice(0, 40),
          });
      onConversation?.(conversation.id);
      const created = await runtime.repository.createTask({
        conversationId: conversation.id,
        ownerUserId: input.ownerUserId,
        originalInput: input.originalInput,
        taskType: null,
        structuredTask: {},
        state: 'awaiting_clarification',
      });
      try {
        const result = await runtime.requirementRefinement.understand({
          taskId: created.id,
          conversationId: conversation.id,
          ownerUserId: input.ownerUserId,
          originalInput: input.originalInput,
          expectedVersion: created.stateVersion,
        }, onProgress);
        if (result.status === 'clarification_required') {
          return refinementResponse(result, await runtime.repository.getTaskDetail(created.id));
        }
        const readyTask = await runtime.repository.getTaskDetail(created.id);
        if (!readyTask) throw new Error(`task ${created.id} disappeared after refinement`);
        if (!result.planningResult) throw new Error('refinement ready result has no finalized planning result');
        return await runtime.controlPlanning.planExistingTask({
          taskId: readyTask.id,
          conversationId: conversation.id,
          ownerUserId: input.ownerUserId,
          expectedStateVersion: readyTask.stateVersion,
          originalInput: input.originalInput,
        }, result.planningResult);
      } catch (error) {
        await failIncompletePlanningTask(runtime, created.id);
        throw error;
      }
    },
  };
}

function refinementClarificationPort(runtime: ControlRuntime): ControlClarificationPort {
  return {
    async clarify(input, onProgress) {
      const result = await runtime.requirementRefinement.clarify({
        taskId: input.taskId,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        answers: { ...input.answers, assumption_edits: input.assumptionEdits },
        expectedVersion: input.expectedVersion,
      }, onProgress);
      if (result.status === 'clarification_required') {
        return refinementResponse(result, await runtime.repository.getTaskDetail(input.taskId));
      }
      const clarifiedTask = await runtime.repository.getTaskDetail(input.taskId);
      if (!clarifiedTask) throw new Error(`task ${input.taskId} disappeared after clarification`);
      if (!result.planningResult) throw new Error('clarification ready result has no finalized planning result');
      return runtime.controlPlanning.planExistingTask({
        taskId: clarifiedTask.id,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        expectedStateVersion: clarifiedTask.stateVersion,
        originalInput: clarifiedTask.originalInput,
        commandReservation: input.commandReservation,
        clarificationRecovery: result.clarificationRecovery,
      }, result.planningResult);
    },
  };
}


export function createAgentApiApp(deps: AgentApiDependencies = {}) {
  requireJwtSecret();
  const app = express();
  app.use(express.json({ limit: '12mb' })); // execute 可携带设计稿 base64(图像工具 upload 上限 10MB + base64 膨胀)

  app.get('/api/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/tasks', feedbackRouter);
  app.use('/api/task-history', taskHistoryRouter);
  app.use('/api/skills', skillsRouter);
  if (deps.controlRuntime) {
    const planning = refinementPlanningPort(deps.controlRuntime);
    app.use('/api/control-tasks', createControlPlanningRouter(planning));
    app.use('/api/control-tasks', createControlTasksRouter({
      ...deps.controlRuntime,
      clarification: refinementClarificationPort(deps.controlRuntime),
    }));
  } else {
    if (deps.controlPlanning) {
      app.use('/api/control-tasks', createControlPlanningRouter(deps.controlPlanning));
    }
    const repository = new ControlPlaneRepository(pool);
    app.use('/api/control-tasks', createControlTasksRouter({
      repository,
      workflow: new TaskWorkflowService(repository),
      getDeliverable: async () => null,
    }));
  }
  return app;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.API_PORT ?? 3001);
  const controlRuntime = buildControlRuntime();
  const recovery = new ExecutionRecoveryController(
    new ExecutionRecoveryService({
      store: new ControlPlaneExecutionRecoveryStore(
        controlRuntime.repository,
        controlRuntime.artifacts,
      ),
    }),
  );
  await recovery.start();
  const server = createAgentApiApp({ controlRuntime }).listen(PORT, () => {
    console.log(`agent-api listening on http://localhost:${PORT}`);
  });
  const shutdown = async () => {
    await recovery.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
