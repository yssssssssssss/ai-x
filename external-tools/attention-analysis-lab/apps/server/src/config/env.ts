import { resolve } from 'node:path';

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

const boolFromEnv = (source: NodeJS.ProcessEnv, name: string): boolean => source[name]?.trim().toLowerCase() === 'true';

const unique = (models: string[]) => [...new Set(models.map((model) => model.trim()).filter(Boolean))];

export function resolveVisionLlm(source: NodeJS.ProcessEnv = process.env) {
  const inheritTextGateway = boolFromEnv(source, 'VLM_USE_TEXT_GATEWAY');
  const explicitModels = unique([source.VLM_MODEL_NAME || '', ...(source.VLM_MODEL_FALLBACKS || '').split(',')]);
  const inheritedModels = unique([source.LLM_MODEL_NAME || '', ...(source.LLM_MODEL_FALLBACKS || '').split(',')]);
  return {
    baseUrl: source.VLM_GATEWAY_BASE_URL || (inheritTextGateway ? source.LLM_GATEWAY_BASE_URL || '' : ''),
    apiKey: source.VLM_GATEWAY_API_KEY || (inheritTextGateway ? source.LLM_GATEWAY_API_KEY || '' : ''),
    models: explicitModels.length > 0 ? explicitModels : inheritTextGateway ? inheritedModels : [],
    timeoutMs: intFromEnv('VLM_GATEWAY_TIMEOUT_MS', 120000),
    inheritTextGateway,
  };
}

export const env = {
  host: process.env.SERVER_HOST || '127.0.0.1',
  port: intFromEnv('SERVER_PORT', 8802),
  uploadDir: resolve(process.cwd(), process.env.UPLOAD_DIR || 'tmp/uploads'),
  maxUploadBytes: intFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  // 默认独立配置；仅在显式开关开启且图片能力探针通过后才继承文本模型链路。
  llm: resolveVisionLlm(),
};
