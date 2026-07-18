import { resolve } from 'node:path';

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

export const env = {
  host: process.env.SERVER_HOST || '127.0.0.1',
  port: intFromEnv('SERVER_PORT', 8802),
  uploadDir: resolve(process.cwd(), process.env.UPLOAD_DIR || 'tmp/uploads'),
  maxUploadBytes: intFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  // LLM 网关(OpenAI 兼容,多模态);三者齐全 + mode=semantic/hybrid 才走真实 VLM 显著性,否则降级 sharp 启发式。
  llm: {
    baseUrl: process.env.LLM_GATEWAY_BASE_URL || '',
    apiKey: process.env.LLM_GATEWAY_API_KEY || '',
    model: process.env.LLM_MODEL_NAME || '',
    timeoutMs: intFromEnv('LLM_GATEWAY_TIMEOUT_MS', 120000),
  },
};
