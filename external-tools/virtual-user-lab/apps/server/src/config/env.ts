const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

export const env = {
  host: process.env.SERVER_HOST || '127.0.0.1',
  port: intFromEnv('SERVER_PORT', 8804),
};
