import { spawn } from 'node:child_process';

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:8802';

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
  <rect width="640" height="420" fill="#e0f2fe"/>
  <rect x="42" y="42" width="350" height="150" rx="28" fill="#0f172a"/>
  <circle cx="500" cy="112" r="54" fill="#f97316"/>
  <rect x="88" y="242" width="196" height="96" rx="24" fill="#38bdf8"/>
  <rect x="352" y="254" width="196" height="58" rx="29" fill="#1d4ed8"/>
  <rect x="92" y="354" width="420" height="18" rx="9" fill="#94a3b8"/>
</svg>`;

const run = async () => {
  const server = spawn('./node_modules/.bin/tsx', ['apps/server/src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SERVER_PORT: '8802' },
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
        image: { dataUrl },
        mode: 'heuristic',
        rois: [
          { id: 'hero', label: 'Hero', x: 0.06, y: 0.1, width: 0.55, height: 0.36 },
          { id: 'cta', label: 'CTA', x: 0.55, y: 0.6, width: 0.32, height: 0.16 },
        ],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (result.status !== 'available') throw new Error(`unexpected status: ${result.status}`);
    if (!Array.isArray(result.heatmap) || result.heatmap.length !== 32) throw new Error('heatmap missing');
    if (!Array.isArray(result.hotspots) || result.hotspots.length === 0) throw new Error('hotspots missing');
    if (!Array.isArray(result.roiAttentionRanking) || result.roiAttentionRanking.length !== 2) throw new Error('roi ranking missing');
    console.log('\nSmoke passed:', {
      status: result.status,
      peakAttentionScore: result.peakAttentionScore,
      hotspotCount: result.hotspots.length,
      roiCount: result.roiAttentionRanking.length,
    });
  } finally {
    server.kill('SIGTERM');
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
