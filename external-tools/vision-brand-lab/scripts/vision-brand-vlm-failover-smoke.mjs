import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(scriptDir, '..');
const projectDir = resolve(labDir, '..', '..');
const forcedModel = '__forced_vlm_failure__';
const fallbackModel = 'GPT-5.4-joybuilder';
const timeoutMs = Math.max(1_000, Number(process.env.VISION_BRAND_VLM_FAILOVER_SMOKE_TIMEOUT_MS || 300_000));

if (process.env.VLM_FAILOVER_E2E_SMOKE !== '1') {
  console.log('Skipped: set VLM_FAILOVER_E2E_SMOKE=1 to verify real VLM failover through a local fault-injection proxy.');
  process.exit(0);
}

const readEnvValue = (name) => {
  const envPath = resolve(projectDir, '.env');
  if (!existsSync(envPath)) return '';
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== name) continue;
    const raw = match[2];
    return (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  }
  return '';
};

const gatewayBaseUrl = process.env.LLM_GATEWAY_BASE_URL || readEnvValue('LLM_GATEWAY_BASE_URL');
if (!gatewayBaseUrl) throw new Error('LLM_GATEWAY_BASE_URL is required for the real VLM failover smoke test.');

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const listenLocal = (server, port) => new Promise((resolvePromise, reject) => {
  const onError = (error) => {
    server.off('error', onError);
    reject(error);
  };
  server.once('error', onError);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onError);
    resolvePromise();
  });
});

const getFreePort = async () => {
  const probe = createServer();
  await listenLocal(probe, 0);
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate a local port');
  await new Promise((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
};

const closeServer = async (server) => {
  if (!server.listening) return;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
};

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

const waitForHealth = async (serverUrl) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${serverUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // The isolated server is still starting.
    }
    await sleep(250);
  }
  throw new Error('isolated vision-brand server did not become healthy');
};

const fetchJson = async (url, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`analysis request returned HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
};

const targetGateway = new URL(gatewayBaseUrl);
const targetBasePath = targetGateway.pathname.replace(/\/$/, '');
const forwardedHeaders = (request) => ({
  ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
  ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}),
});

let forcedRequests = 0;
let forwardedRequests = 0;
const proxy = createServer(async (request, response) => {
  const chunks = [];
  try {
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const payload = JSON.parse(body.toString('utf8'));
    if (payload.model === forcedModel) {
      forcedRequests += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"forced temporary VLM failure"}}');
      return;
    }
    if (payload.model !== fallbackModel) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"unexpected model"}}');
      return;
    }

    forwardedRequests += 1;
    const incoming = new URL(request.url || '/', 'http://127.0.0.1');
    const suffix = incoming.pathname.replace(/^\/v1(?=\/|$)/, '');
    const upstreamUrl = new URL(`${targetBasePath}${suffix || '/'}${incoming.search}`, targetGateway.origin);
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardedHeaders(request),
      body: body.length ? body : undefined,
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    response.end(upstreamBody);
  } catch {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"local VLM fault-injection proxy failed"}}');
  }
});

const run = async () => {
  const [proxyPort, serverPort] = await Promise.all([getFreePort(), getFreePort()]);
  const proxyUrl = `http://127.0.0.1:${proxyPort}/v1`;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  let child;

  try {
    await listenLocal(proxy, proxyPort);
    child = spawn('./node_modules/.bin/tsx', ['apps/server/src/index.ts'], {
      cwd: labDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        SERVER_PORT: String(serverPort),
        VLM_GATEWAY_BASE_URL: proxyUrl,
        VLM_MODEL_NAME: forcedModel,
        VLM_MODEL_FALLBACKS: fallbackModel,
        VLM_USE_TEXT_GATEWAY: 'true',
        VLM_GATEWAY_TIMEOUT_MS: '30000',
      },
    });

    const health = await waitForHealth(serverUrl);
    if (!health.vlm?.enabled || JSON.stringify(health.vlm.candidateModels) !== JSON.stringify([forcedModel, fallbackModel])) {
      throw new Error('isolated server did not use the injected VLM candidate chain');
    }

    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGElEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAI4GHEAAAXq5OywAAAAASUVORK5CYII=';
    const analysis = await fetchJson(`${serverUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        designImages: [{ fileName: 'vlm-failover-smoke.png', dataUrl: image }],
        brandReferenceImages: [{ fileName: 'vlm-failover-reference.png', dataUrl: image }],
        businessGoal: '验证 VLM 主模型故障后的真实备用模型切换',
        reviewFocus: ['图像内容识别'],
      }),
    });
    const models = String(analysis.model || '').split(',').filter(Boolean);
    if (analysis.engine !== 'vlm' || analysis.degraded || !models.includes(forcedModel) || !models.includes(fallbackModel)) {
      throw new Error('analysis did not return a non-degraded VLM result with both attempted models');
    }
    if (!(analysis.attempts > 1) || !(analysis.visualReview?.reviewers?.length > 0) || forcedRequests < 1 || forwardedRequests < 1) {
      throw new Error('the proxy did not observe both the forced failure and the real fallback request');
    }

    console.log(JSON.stringify({
      ok: true,
      engine: analysis.engine,
      models,
      attempts: analysis.attempts,
      reviewerCount: analysis.visualReview.reviewers.length,
      forcedRequests,
      forwardedRequests,
    }));
  } finally {
    if (child) await stopChild(child);
    await closeServer(proxy);
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
