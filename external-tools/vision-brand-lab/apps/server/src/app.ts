import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { isLLMEnabled } from './services/llmClient.js';
import { analyzeVisionBrand } from './services/visionBrandService.js';
import { saveUpload } from './services/uploadService.js';

export const buildApp = async () => {
  // bodyLimit 放大:/api/analyze 以 JSON 承载设计图 dataUrl(base64,可达数 MB),编排注入图像同理。
  const app = Fastify({ logger: true, bodyLimit: 24 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: env.maxUploadBytes, files: 8 } });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'vision-brand-lab',
    version: '0.1.0',
    vlm: {
      enabled: isLLMEnabled(),
      route: env.llm.inheritTextGateway ? 'shared_gateway' : 'dedicated_gateway',
      candidateModels: env.llm.models,
      timeoutMs: env.llm.timeoutMs,
    },
  }));
  app.post('/api/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'file is required' });
    if (!file.mimetype.startsWith('image/')) return reply.code(400).send({ error: 'only image uploads are supported' });
    return { file: await saveUpload(file) };
  });
  app.post('/api/analyze', async (request, reply) => {
    const startedAt = Date.now();
    try {
      const result = await analyzeVisionBrand(request.body || {});
      // 不记录提示词、图片或模型原始输出，仅记录可靠性指标。
      request.log.info({
        engine: result.engine,
        degraded: Boolean(result.degraded),
        reasonCode: result.reasonCode,
        models: result.model?.split(',').filter(Boolean) ?? [],
        attempts: result.attempts ?? 0,
        durationMs: Date.now() - startedAt,
      }, 'vision brand analysis completed');
      return result;
    } catch (error) {
      request.log.error({ error, durationMs: Date.now() - startedAt }, 'vision brand analyze failed');
      return reply.code(500).send({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
};
