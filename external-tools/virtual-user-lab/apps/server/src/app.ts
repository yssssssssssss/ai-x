import cors from '@fastify/cors';
import Fastify from 'fastify';
import { listPersonas, simulateVirtualUsers } from './services/personaService.js';

export const buildApp = async () => {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true, service: 'virtual-user-lab', version: '0.1.0' }));
  app.get('/api/personas', async () => ({ personas: listPersonas() }));
  app.post('/api/simulate', async (request, reply) => {
    try {
      return await simulateVirtualUsers(request.body || {});
    } catch (error) {
      request.log.error({ error }, 'persona simulation failed');
      return reply.code(500).send({ status: 'failed', isSimulated: true, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
};
