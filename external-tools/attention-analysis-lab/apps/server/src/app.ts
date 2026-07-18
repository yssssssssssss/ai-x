import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { analyzeAttention } from './services/attentionService.js';
import { saveUpload } from './services/uploadService.js';

export const buildApp = async () => {
  // bodyLimit 放大:/api/analyze 以 JSON 承载图像 dataUrl(base64),编排注入图像同理。
  const app = Fastify({ logger: true, bodyLimit: 24 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      fileSize: env.maxUploadBytes,
      files: 2,
    },
  });

  app.get('/api/health', async () => ({ ok: true, service: 'attention-analysis-lab', version: '0.1.0' }));

  app.post('/api/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'file is required' });
    if (!file.mimetype.startsWith('image/')) return reply.code(400).send({ error: 'only image uploads are supported' });
    return { file: await saveUpload(file) };
  });

  app.post('/api/analyze', async (request, reply) => {
    try {
      return await analyzeAttention(request.body || {});
    } catch (error) {
      request.log.error({ error }, 'attention analyze failed');
      return reply.code(500).send({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
};
