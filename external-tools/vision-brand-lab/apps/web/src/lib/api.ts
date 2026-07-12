import type { UploadedImageRef, VisionBrandAnalyzeRequest, VisionBrandAnalyzeResult } from '@vision-brand-lab/core';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8805';

export const uploadImage = async (file: File): Promise<UploadedImageRef> => {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${API_BASE}/api/uploads`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  return payload.file;
};

export const analyze = async (request: VisionBrandAnalyzeRequest): Promise<VisionBrandAnalyzeResult> => {
  const response = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
