import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();
await app.listen({ host: env.host, port: env.port });
app.log.info(`attention-analysis-lab server listening on http://${env.host}:${env.port}`);
