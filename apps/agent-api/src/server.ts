import { closePool, loadEnv, pool } from '../../../database/db.ts';
loadEnv(); // 读 .env:DATABASE_URL / LLM 网关 / JWT_SECRET

import express from 'express';
import { ControlPlaneRepository } from '../../../database/control-plane.ts';
import { TaskWorkflowService } from '../../orchestrator-runtime/src/control/task-workflow.ts';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { tasksRouter } from './routes/tasks.ts';
import { feedbackRouter } from './routes/feedback.ts';
import { skillsRouter } from './routes/skills.ts';
import { taskHistoryRouter } from './routes/task-history.ts';
import { systemCapabilitiesRouter } from './routes/system-capabilities.ts';
import { createControlTasksRouter } from './routes/control-tasks.ts';
import { requireJwtSecret } from './auth.ts';
import { buildControlRuntime, type ControlRuntime } from './control-runtime.ts';
import {
  createZeroIntegrationRouter,
} from './routes/zero-publications.ts';
import { createSkillNativeTasksRouter } from './routes/skill-native-tasks.ts';
import type { SkillNativeTaskService } from '../../orchestrator-runtime/src/skill-native/service.ts';
export interface AgentApiDependencies {
  controlRuntime?: ControlRuntime;
  skillNative?: SkillNativeTaskService;
}


export function createAgentApiApp(deps: AgentApiDependencies = {}) {
  requireJwtSecret();
  const app = express();
  const skillNative = deps.skillNative ?? deps.controlRuntime?.skillNative;
  if (skillNative) app.use('/api/research-tasks', createSkillNativeTasksRouter(skillNative));
  app.use(express.json());

  app.get('/api/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api/system/capabilities', systemCapabilitiesRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/tasks', feedbackRouter);
  app.use('/api/task-history', taskHistoryRouter);
  app.use('/api/skills', skillsRouter);
  const zeroPublication = deps.controlRuntime?.zeroPublication;
  app.use('/api/integrations/zero', createZeroIntegrationRouter(zeroPublication));
  if (deps.controlRuntime) {
    app.use('/api/control-tasks', createControlTasksRouter(deps.controlRuntime, { readOnly: true }));
  } else {
    const repository = new ControlPlaneRepository(pool);
    app.use('/api/control-tasks', createControlTasksRouter({
      repository,
      workflow: new TaskWorkflowService(repository),
      getDeliverable: async () => null,
    }, { readOnly: true }));
  }
  return app;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.API_PORT ?? 3001);
  const controlRuntime = buildControlRuntime();
  await controlRuntime.skillNative?.recoverInterrupted();
  const server = createAgentApiApp({ controlRuntime }).listen(PORT, () => {
    console.log(`agent-api listening on http://localhost:${PORT}`);
  });
  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
