// 用固定无敏感内容验证候选模型的文本与图片输入能力。
// 默认拒绝执行，避免在日常开发或 CI 中意外消耗网关配额。
import { loadEnv } from '../database/db.ts';

loadEnv();

if (process.env.MODEL_CAPABILITY_PROBE !== '1') {
  throw new Error('请通过 npm run models:probe 显式执行能力探针。');
}

interface ProbeTarget {
  model: string;
  baseUrl: string;
  apiKey: string;
}

interface ProbeResult {
  model: string;
  text: 'available' | 'unavailable';
  vision: 'available' | 'unavailable' | 'not_configured';
  textStatus?: number;
  visionStatus?: number;
  textFailure?: 'timeout' | 'network_error';
  visionFailure?: 'timeout' | 'network_error';
  textDetail?: string;
  visionDetail?: string;
}

const unique = (models: string[]) => [...new Set(models.map((model) => model.trim()).filter(Boolean))];
const configuredTextModels = unique([process.env.LLM_MODEL_NAME || '', ...(process.env.LLM_MODEL_FALLBACKS || '').split(',')]);
const selectedModels = unique((process.env.MODEL_CAPABILITY_PROBE_MODELS || '').split(','));
const textModels = selectedModels.length > 0
  ? configuredTextModels.filter((model) => selectedModels.includes(model))
  : configuredTextModels;
const inheritTextGateway = process.env.VLM_USE_TEXT_GATEWAY?.trim().toLowerCase() === 'true';
const explicitVisionModels = unique([process.env.VLM_MODEL_NAME || '', ...(process.env.VLM_MODEL_FALLBACKS || '').split(',')]);
const visionModels = explicitVisionModels.length > 0 ? explicitVisionModels : inheritTextGateway ? textModels : [];

const textTarget = {
  baseUrl: process.env.LLM_GATEWAY_BASE_URL || '',
  apiKey: process.env.LLM_GATEWAY_API_KEY || '',
};
const visionTarget = {
  baseUrl: process.env.VLM_GATEWAY_BASE_URL || (inheritTextGateway ? textTarget.baseUrl : ''),
  apiKey: process.env.VLM_GATEWAY_API_KEY || (inheritTextGateway ? textTarget.apiKey : ''),
};

if (!textModels.length || !textTarget.baseUrl || !textTarget.apiKey) {
  throw new Error('缺少文本网关或候选模型配置，无法执行能力探针。');
}

const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlNfWQAAAAASUVORK5CYII=';
const timeoutMs = Math.max(1_000, Number(process.env.MODEL_CAPABILITY_PROBE_TIMEOUT_MS ?? 20_000));

function sanitizeErrorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
    const error = parsed.error;
    if (error) return `code=${String(error.code ?? 'unknown')} message=${String(error.message ?? '').slice(0, 240)}`;
  } catch {
    // 非 JSON 网关错误仅保留短文本，并移除可能的 data URL。
  }
  return raw.replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=]+/g, '[redacted-data-url]').slice(0, 240);
}

async function call(target: ProbeTarget, messages: object[]): Promise<{ status?: number; failure?: 'timeout' | 'network_error'; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({ model: target.model, messages, stream: false, max_tokens: 8 }),
      signal: controller.signal,
    });
    return response.ok ? { status: response.status } : { status: response.status, detail: sanitizeErrorDetail(await response.text()) };
  } catch (error) {
    return { failure: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeModel(model: string): Promise<ProbeResult> {
  const text = await call({ ...textTarget, model }, [{ role: 'user', content: '只回复 OK' }]);
  const visionModelEnabled = visionModels.includes(model) && Boolean(visionTarget.baseUrl && visionTarget.apiKey);
  if (!visionModelEnabled) {
    return {
      model,
      text: text.status && text.status >= 200 && text.status < 300 ? 'available' : 'unavailable',
      textStatus: text.status,
      textFailure: text.failure,
      textDetail: text.detail,
      vision: 'not_configured',
    };
  }
  const vision = await call(
    { ...visionTarget, model },
    [{ role: 'user', content: [{ type: 'text', text: '只回复 OK' }, { type: 'image_url', image_url: { url: onePixelPng, detail: 'low' } }] }],
  );
  return {
    model,
    text: text.status && text.status >= 200 && text.status < 300 ? 'available' : 'unavailable',
    textStatus: text.status,
    textFailure: text.failure,
    textDetail: text.detail,
    vision: vision.status && vision.status >= 200 && vision.status < 300 ? 'available' : 'unavailable',
    visionStatus: vision.status,
    visionFailure: vision.failure,
    visionDetail: vision.detail,
  };
}

const results: ProbeResult[] = [];
for (const model of textModels) {
  try {
    results.push(await probeModel(model));
  } catch {
    results.push({ model, text: 'unavailable', vision: visionModels.includes(model) ? 'unavailable' : 'not_configured' });
  }
}

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => result.text !== 'available' || (visionModels.includes(result.model) && result.vision !== 'available'))) {
  process.exitCode = 1;
}
