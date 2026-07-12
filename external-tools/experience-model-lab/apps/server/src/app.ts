import cors from '@fastify/cors';
import Fastify from 'fastify';
import { analyzeExperience, listModels } from './services/experienceService.js';

export const buildApp = async () => {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true, service: 'experience-model-lab', version: '0.1.0' }));
  app.get('/api/models', async () => ({ models: await listModels() }));
  app.post('/api/analyze', async (request, reply) => {
    try {
      return await analyzeExperience(request.body || {});
    } catch (error) {
      request.log.error({ error }, 'experience analyze failed');
      return reply.code(500).send({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
};
