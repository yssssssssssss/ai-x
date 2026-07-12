import { resolve } from 'node:path';

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

export const env = {
  host: process.env.SERVER_HOST || '127.0.0.1',
  port: intFromEnv('SERVER_PORT', 8805),
  uploadDir: resolve(process.cwd(), process.env.UPLOAD_DIR || 'tmp/uploads'),
  maxUploadBytes: intFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
};
