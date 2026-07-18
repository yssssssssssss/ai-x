const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

export const env = {
  host: process.env.SERVER_HOST || '127.0.0.1',
  port: intFromEnv('SERVER_PORT', 8804),
  // LLM 网关(OpenAI 兼容);三者齐全才启用真实 LLM 评审,否则降级规则模拟。值同主项目。
  llm: {
    baseUrl: process.env.LLM_GATEWAY_BASE_URL || '',
    apiKey: process.env.LLM_GATEWAY_API_KEY || '',
    model: process.env.LLM_MODEL_NAME || '',
    timeoutMs: intFromEnv('LLM_GATEWAY_TIMEOUT_MS', 60000),
  },
};
