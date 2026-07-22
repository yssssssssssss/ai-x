import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const loadProjectEnv = () => {
  let directory = process.cwd();
  while (true) {
    const path = resolve(directory, '.env');
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]] !== undefined) continue;
        const rawValue = match[2];
        const value = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;
        process.env[match[1]] = value;
      }
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
};

loadProjectEnv();

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
  port: intFromEnv('SERVER_PORT', 8805),
  uploadDir: resolve(process.cwd(), process.env.UPLOAD_DIR || 'tmp/uploads'),
  maxUploadBytes: intFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  // 默认独立配置；仅在显式开关开启且图片能力探针通过后才继承文本模型链路。
  llm: resolveVisionLlm(),
};
