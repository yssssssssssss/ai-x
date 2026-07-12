import { spawn } from 'node:child_process';

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:8804';

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
    env: { ...process.env, SERVER_PORT: '8804' },
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth();
    const personasResponse = await fetch(`${SERVER_URL}/api/personas`);
    if (!personasResponse.ok) throw new Error(await personasResponse.text());
    const personasPayload = await personasResponse.json();
    if (!Array.isArray(personasPayload.personas) || personasPayload.personas.length < 3) throw new Error('persona catalog too small');

    const simulateResponse = await fetch(`${SERVER_URL}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '评估电商首页内容种草区对用户参与、信任、价格判断和转化意愿的影响' }),
    });
    if (!simulateResponse.ok) throw new Error(await simulateResponse.text());
    const result = await simulateResponse.json();
    if (result.status !== 'available') throw new Error(`unexpected status: ${result.status}`);
    if (result.isSimulated !== true) throw new Error('isSimulated missing');
    if (!Array.isArray(result.reviews) || result.reviews.length < 3) throw new Error('reviews missing');
    if (!result.reviews.every((review) => review.isSimulated === true)) throw new Error('review simulation marker missing');
    console.log('\nSmoke passed:', {
      status: result.status,
      personaCount: personasPayload.personas.length,
      reviewCount: result.reviews.length,
    });
  } finally {
    server.kill('SIGTERM');
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
