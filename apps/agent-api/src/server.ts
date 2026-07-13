import { loadEnv } from '../../../database/db.ts';
loadEnv(); // 读 .env:DATABASE_URL / LLM 网关 / JWT_SECRET

import express from 'express';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { tasksRouter } from './routes/tasks.ts';
import { feedbackRouter } from './routes/feedback.ts';

const app = express();
app.use(express.json({ limit: '12mb' })); // execute 可携带设计稿 base64(图像工具 upload 上限 10MB + base64 膨胀)

app.get('/api/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', feedbackRouter);

const PORT = Number(process.env.API_PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`agent-api listening on http://localhost:${PORT}`);
});
