import type { ExperienceAnalyzeRequest, ExperienceAnalyzeResult, ExperienceModelProfile } from '@experience-model-lab/core';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8803';

export const listModels = async (): Promise<ExperienceModelProfile[]> => {
  const response = await fetch(`${API_BASE}/api/models`);
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  return payload.models;
};

export const analyze = async (request: ExperienceAnalyzeRequest): Promise<ExperienceAnalyzeResult> => {
  const response = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
