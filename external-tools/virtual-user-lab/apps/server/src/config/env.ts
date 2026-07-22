const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

const unique = (models: string[]) => [...new Set(models.map((model) => model.trim()).filter(Boolean))];

export const env = {
  host: process.env.SERVER_HOST || '127.0.0.1',
  port: intFromEnv('SERVER_PORT', 8804),
  // LLM 网关(OpenAI 兼容);候选顺序与主项目一致,所有候选失败才降级规则模拟。
  llm: {
    baseUrl: process.env.LLM_GATEWAY_BASE_URL || '',
    apiKey: process.env.LLM_GATEWAY_API_KEY || '',
    models: unique([process.env.LLM_MODEL_NAME || '', ...(process.env.LLM_MODEL_FALLBACKS || '').split(',')]),
    timeoutMs: intFromEnv('LLM_GATEWAY_TIMEOUT_MS', 60000),
  },
};
