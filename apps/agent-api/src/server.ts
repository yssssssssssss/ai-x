import { loadEnv } from '../../../database/db.ts';
loadEnv(); // 读 .env:DATABASE_URL / LLM 网关 / JWT_SECRET

import express from 'express';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { tasksRouter } from './routes/tasks.ts';
import { feedbackRouter } from './routes/feedback.ts';
import { skillsRouter } from './routes/skills.ts';
import { topologyRouter } from './routes/topology.ts';

const app = express();
app.use(express.json({ limit: '1mb' })); // 图片走独立二进制端点，JSON 请求不再承载 Base64。

app.get('/api/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', feedbackRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/topology', topologyRouter);

const PORT = Number(process.env.API_PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`agent-api listening on http://localhost:${PORT}`);
});
