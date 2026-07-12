import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { profiles } from './services/profiles.js';
import { analyzeAesthetic } from './services/aestheticService.js';
import { saveUpload } from './services/uploadService.js';

export const buildApp = async () => {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      fileSize: env.maxUploadBytes,
      files: 4,
    },
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'aesthetic-quant-lab',
    version: '0.1.0',
  }));

  app.get('/api/profiles', async () => ({ profiles }));

  app.post('/api/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'file is required' });
    }
    if (!file.mimetype.startsWith('image/')) {
      return reply.code(400).send({ error: 'only image uploads are supported' });
    }
    const uploaded = await saveUpload(file);
    return { file: uploaded };
  });

  app.post('/api/analyze', async (request, reply) => {
    try {
      const result = await analyzeAesthetic(request.body || {});
      return result;
    } catch (error) {
      request.log.error({ error }, 'aesthetic analyze failed');
      return reply.code(500).send({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
};
