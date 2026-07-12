import { spawn } from 'node:child_process';

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:8803';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${SERVER_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(500);
  }
  throw new Error('server did not become healthy');
};

const run = async () => {
  const server = spawn('./node_modules/.bin/tsx', ['apps/server/src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SERVER_PORT: '8803' },
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth();
    const modelsResponse = await fetch(`${SERVER_URL}/api/models`);
    if (!modelsResponse.ok) throw new Error(await modelsResponse.text());
    const modelsPayload = await modelsResponse.json();
    if (!Array.isArray(modelsPayload.models) || modelsPayload.models.length < 5) throw new Error('model catalog too small');

    const analyzeResponse = await fetch(`${SERVER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '评估电商首页内容种草区对用户参与、满意度、转化和信任的影响' }),
    });
    if (!analyzeResponse.ok) throw new Error(await analyzeResponse.text());
    const result = await analyzeResponse.json();
    if (result.status !== 'available') throw new Error(`unexpected status: ${result.status}`);
    if (!Array.isArray(result.selectedModels) || result.selectedModels.length === 0) throw new Error('selected models missing');
    if (!Array.isArray(result.questionTemplates) || result.questionTemplates.length === 0) throw new Error('question templates missing');
    console.log('\nSmoke passed:', {
      status: result.status,
      modelCount: modelsPayload.models.length,
      selected: result.selectedModels.map((item) => item.id),
    });
  } finally {
    server.kill('SIGTERM');
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
