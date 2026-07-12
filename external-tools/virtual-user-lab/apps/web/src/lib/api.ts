import type { PersonaProfile, VirtualUserSimulateRequest, VirtualUserSimulateResult } from '@virtual-user-lab/core';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8804';

export const listPersonas = async (): Promise<PersonaProfile[]> => {
  const response = await fetch(`${API_BASE}/api/personas`);
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  return payload.personas;
};

export const simulate = async (request: VirtualUserSimulateRequest): Promise<VirtualUserSimulateResult> => {
  const response = await fetch(`${API_BASE}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
