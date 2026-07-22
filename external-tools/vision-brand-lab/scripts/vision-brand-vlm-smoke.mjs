const serverUrl = (process.env.VISION_BRAND_SERVER_URL || 'http://127.0.0.1:8805').replace(/\/$/, '');
const requiredModels = ['GPT-5.4-joybuilder', 'GPT-5.5-joybuilder', 'GPT-5-joybuilder'];
const timeoutMs = Math.max(1_000, Number(process.env.VISION_BRAND_VLM_SMOKE_TIMEOUT_MS || 300_000));

if (process.env.VLM_E2E_SMOKE !== '1') {
  console.log('Skipped: set VLM_E2E_SMOKE=1 to send a real image request to the configured VLM gateway.');
  process.exit(0);
}

const fetchJson = async (path, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl}${path}`, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
};

const health = await fetchJson('/api/health');
if (!health.vlm?.enabled) throw new Error('VLM is disabled. Check VLM gateway credentials and model configuration.');
if (health.vlm.route !== 'shared_gateway') throw new Error(`Expected shared_gateway route, received ${health.vlm.route ?? 'unknown'}.`);
if (JSON.stringify(health.vlm.candidateModels) !== JSON.stringify(requiredModels)) {
  throw new Error(`Unexpected VLM candidate order: ${JSON.stringify(health.vlm.candidateModels)}.`);
}

// A self-contained PNG keeps the smoke test free of local upload and file-path dependencies.
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGElEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAI4GHEAAAXq5OywAAAAASUVORK5CYII=';
const analysis = await fetchJson('/api/analyze', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    designImages: [{ fileName: 'vlm-smoke.png', dataUrl: image }],
    brandReferenceImages: [{ fileName: 'vlm-reference.png', dataUrl: image }],
    businessGoal: '验证 VLM 图片输入和 JSON 输出链路',
    reviewFocus: ['图像内容识别'],
  }),
});

if (analysis.engine !== 'vlm' || analysis.degraded) {
  throw new Error(`Expected a non-degraded VLM result, received engine=${analysis.engine}, degraded=${analysis.degraded}, reason=${analysis.reasonCode ?? ''}.`);
}
if (!analysis.model || !analysis.attempts) throw new Error('VLM result is missing model attribution or attempt count.');

console.log(JSON.stringify({
  ok: true,
  engine: analysis.engine,
  model: analysis.model,
  attempts: analysis.attempts,
  reviewerCount: analysis.visualReview?.reviewers?.length ?? 0,
  brandStatus: analysis.brandAssociation?.status,
}));
