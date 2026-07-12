import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();
await app.listen({ host: env.host, port: env.port });
app.log.info(`experience-model-lab server listening on http://${env.host}:${env.port}`);
