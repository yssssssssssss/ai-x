import { closePool, loadEnv } from '../../../database/db.ts';

loadEnv();

import express from 'express';
import type { SkillNativeTaskService } from '../../orchestrator-runtime/src/skill-native/service.ts';
import { requireJwtSecret } from './auth.ts';
import { buildSkillNativeRuntime, type SkillNativeRuntime } from './skill-native-runtime.ts';
import { authRouter } from './routes/auth.ts';
import { createSkillNativeTasksRouter } from './routes/skill-native-tasks.ts';
import { createSystemCapabilitiesRouter } from './routes/system-capabilities.ts';
import { taskHistoryRouter } from './routes/task-history.ts';

export interface AgentApiDependencies {
  runtime?: SkillNativeRuntime;
  skillNative?: SkillNativeTaskService;
}

export function createAgentApiApp(dependencies: AgentApiDependencies = {}) {
  requireJwtSecret();
  const app = express();
  const skillNative = dependencies.skillNative ?? dependencies.runtime?.tasks;

  if (skillNative) app.use('/api/research-tasks', createSkillNativeTasksRouter(skillNative));
  app.use(express.json());
  app.get('/api/healthz', (_request, response) => response.json({ ok: true }));
  app.use('/api/system/capabilities', createSystemCapabilitiesRouter(skillNative));
  app.use('/api/auth', authRouter);
  app.use('/api/task-history', taskHistoryRouter);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? 3001);
  const runtime = buildSkillNativeRuntime();
  await runtime.tasks.recoverInterrupted();
  const server = createAgentApiApp({ runtime }).listen(port, () => {
    console.log(`agent-api listening on http://localhost:${port}`);
  });
  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
