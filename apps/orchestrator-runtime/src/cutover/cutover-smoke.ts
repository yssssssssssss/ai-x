export interface CutoverHttpSmokeOptions {
  baseUrl: string;
  bearerToken: string;
  taskId: string;
}

export interface CutoverHttpSmokeResult {
  healthz: true;
  legacyMutation410: true;
  oldRoute404: true;
}

function baseUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function postHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function expectStatus(url: string, expected: number, label: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (response.status !== expected) throw new Error(`${label} expected ${expected}, got ${response.status}`);
}

export async function runCutoverHttpSmoke(options: CutoverHttpSmokeOptions): Promise<CutoverHttpSmokeResult> {
  const root = baseUrl(options.baseUrl);
  const taskId = encodeURIComponent(options.taskId);
  await expectStatus(`${root}/api/healthz`, 200, 'healthz');
  await expectStatus(`${root}/api/tasks/${taskId}/execute`, 410, 'legacy mutation', {
    method: 'POST',
    headers: postHeaders(options.bearerToken),
    body: '{}',
  });
  await expectStatus(`${root}/api/legacy/tasks/${taskId}/execute`, 404, 'old route', {
    method: 'POST',
    headers: postHeaders(options.bearerToken),
    body: '{}',
  });
  return { healthz: true, legacyMutation410: true, oldRoute404: true };
}
