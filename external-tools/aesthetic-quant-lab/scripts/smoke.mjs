import { spawn } from 'node:child_process';

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:8801';

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

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <rect width="640" height="420" fill="#f6efe5"/>
  <rect x="56" y="52" width="310" height="150" rx="28" fill="#1f2937"/>
  <rect x="392" y="62" width="176" height="54" rx="27" fill="#f97316"/>
  <circle cx="470" cy="245" r="82" fill="#fdba74"/>
  <rect x="74" y="248" width="248" height="26" rx="13" fill="#9ca3af"/>
  <rect x="74" y="292" width="342" height="22" rx="11" fill="#d1d5db"/>
  <rect x="74" y="334" width="190" height="54" rx="27" fill="#111827"/>
</svg>`;

const run = async () => {
  const server = spawn('./node_modules/.bin/tsx', ['apps/server/src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SERVER_PORT: '8801' },
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const response = await fetch(`${SERVER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        designImage: { dataUrl },
        rois: [
          { id: 'hero', label: 'Hero', x: 0.08, y: 0.1, width: 0.5, height: 0.36 },
          { id: 'cta', label: 'CTA', x: 0.1, y: 0.78, width: 0.3, height: 0.13 },
        ],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (result.status !== 'available') throw new Error(`unexpected status: ${result.status}`);
    if (typeof result.overallScore !== 'number') throw new Error('overallScore missing');
    if (!Array.isArray(result.roiResults) || result.roiResults.length !== 2) throw new Error('roi results missing');
    console.log('\nSmoke passed:', {
      status: result.status,
      overallScore: result.overallScore,
      roiCount: result.roiResults.length,
    });
  } finally {
    server.kill('SIGTERM');
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
