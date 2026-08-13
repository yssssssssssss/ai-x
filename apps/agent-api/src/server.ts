import { loadEnv, pool } from '../../../database/db.ts';
loadEnv(); // 读 .env:DATABASE_URL / LLM 网关 / JWT_SECRET

import express from 'express';
import { ControlPlaneRepository } from '../../../database/control-plane.ts';
import { TaskWorkflowService } from '../../orchestrator-runtime/src/control/task-workflow.ts';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { tasksRouter } from './routes/tasks.ts';
import { feedbackRouter } from './routes/feedback.ts';
import { skillsRouter } from './routes/skills.ts';
import { createControlTasksRouter } from './routes/control-tasks.ts';
import {
  createControlPlanningRouter,
  type ControlPlanningPort,
} from './routes/control-planning.ts';
import { requireJwtSecret } from './auth.ts';
import { buildControlRuntime, type ControlRuntime } from './control-runtime.ts';
export interface AgentApiDependencies {
  controlRuntime?: ControlRuntime;
  controlPlanning?: ControlPlanningPort;
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
  app.use('/api/skills', skillsRouter);
  if (deps.controlRuntime) {
    app.use('/api/control-tasks', createControlPlanningRouter(deps.controlRuntime.controlPlanning));
    app.use('/api/control-tasks', createControlTasksRouter(deps.controlRuntime));
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
  createAgentApiApp({ controlRuntime }).listen(PORT, () => {
    console.log(`agent-api listening on http://localhost:${PORT}`);
  });
}
