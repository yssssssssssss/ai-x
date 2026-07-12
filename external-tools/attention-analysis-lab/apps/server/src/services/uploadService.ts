import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { env } from '../config/env.js';

const safeName = (value: string) => basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');

export const saveUpload = async (file: MultipartFile) => {
  await mkdir(env.uploadDir, { recursive: true });
  const fileName = `${Date.now()}-${safeName(file.filename || 'upload.bin')}`;
  const path = join(env.uploadDir, fileName);
  await pipeline(file.file, createWriteStream(path));
  return {
    id: fileName,
    fileName: file.filename,
    path,
    mimeType: file.mimetype,
  };
};

export const assertInsideUploadDir = (path: string): string => {
  const resolved = resolve(path);
  const uploadRoot = resolve(env.uploadDir);
  if (!resolved.startsWith(uploadRoot)) {
    throw new Error('file path must be inside upload directory');
  }
  return resolved;
};
