import { spawn } from 'node:child_process';

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:8805';

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

const svg = (primary, secondary) => `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <rect width="640" height="420" fill="${primary}"/>
  <rect x="52" y="52" width="320" height="150" rx="28" fill="${secondary}"/>
  <circle cx="500" cy="150" r="64" fill="#ffffff" opacity="0.85"/>
  <rect x="72" y="258" width="220" height="54" rx="27" fill="#111827"/>
  <rect x="72" y="336" width="420" height="22" rx="11" fill="#94a3b8"/>
</svg>`;

const run = async () => {
  const server = spawn('./node_modules/.bin/tsx', ['apps/server/src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SERVER_PORT: '8805' },
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth();
    const designDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg('#e0f2fe', '#0f172a')).toString('base64')}`;
    const brandDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg('#dbeafe', '#111827')).toString('base64')}`;
    const response = await fetch(`${SERVER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        designImages: [{ dataUrl: designDataUrl }],
        brandReferenceImages: [{ dataUrl: brandDataUrl }],
        businessGoal: '评估设计清晰度、转化动线与品牌一致性',
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (result.status !== 'available') throw new Error(`unexpected status: ${result.status}`);
    if (!result.visualReview?.reviewers?.length) throw new Error('reviewers missing');
    if (result.brandAssociation?.status !== 'available') throw new Error('brand association missing');
    console.log('\nSmoke passed:', {
      status: result.status,
      reviewerCount: result.visualReview.reviewers.length,
      brandScore: result.brandAssociation.score,
    });
  } finally {
    server.kill('SIGTERM');
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
