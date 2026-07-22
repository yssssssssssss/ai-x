// 用真实本地图片验证当前 GatewayLLMClient 的多模态请求路径。
// 用法: MODEL_VISION_SMOKE=1 npx tsx scripts/vision-model-smoke.ts /absolute/path/to/image.png
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { loadEnv } from '../database/db.ts';
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';

loadEnv();

if (process.env.MODEL_VISION_SMOKE !== '1') {
  throw new Error('请设置 MODEL_VISION_SMOKE=1 后执行，避免意外发送图片到网关。');
}

const imagePath = process.argv[2];
if (!imagePath) throw new Error('缺少图片绝对路径。');
const absolutePath = resolve(imagePath);
const mimeByExtension: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const mimeType = mimeByExtension[extname(absolutePath).toLowerCase()];
if (!mimeType) throw new Error('仅支持 PNG/JPEG/WebP/GIF 图片。');
const buffer = readFileSync(absolutePath);
if (buffer.length > 5 * 1024 * 1024) throw new Error('图片超过 5MB，拒绝发送到模型网关。');
const imageDataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
const timeoutMs = Math.max(1_000, Number(process.env.MODEL_VISION_SMOKE_TIMEOUT_MS ?? 30_000));

const configuredModels = ['GPT-5.4-joybuilder', 'GPT-5.5-joybuilder', 'GPT-5-joybuilder'];
const selectedModels = [...new Set((process.env.MODEL_VISION_SMOKE_MODELS || '').split(',').map((model) => model.trim()).filter(Boolean))];
const models = selectedModels.length > 0 ? configuredModels.filter((model) => selectedModels.includes(model)) : configuredModels;
if (!models.length) throw new Error('MODEL_VISION_SMOKE_MODELS 未匹配任何受支持的模型。');
const originalPrimary = process.env.LLM_MODEL_NAME;
const originalFallbacks = process.env.LLM_MODEL_FALLBACKS;
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'detected_text'],
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 500 },
    detected_text: { type: 'string', maxLength: 1000 },
  },
};

const results: Array<Record<string, unknown>> = [];
try {
  for (const model of models) {
    process.env.LLM_MODEL_NAME = model;
    process.env.LLM_MODEL_FALLBACKS = '';
    console.log(`probing ${model}`);
    try {
      const client = new GatewayLLMClient({ timeoutMs });
      const result = await client.generateStructured<{ description: string; detected_text: string }>({
        prompt: '分析这张图片。description 用一句中文描述页面或主体；detected_text 抄录最显著的可见文字。',
        schema,
        schemaName: 'vision-smoke',
        context: { image: { dataUrl: imageDataUrl, fileName: basename(absolutePath) } },
      });
      results.push({ model, status: 'available', responseModel: result.modelName, description: result.data.description, detectedText: result.data.detected_text });
      console.log(`completed ${model}: available`);
    } catch (error) {
      results.push({ model, status: 'unavailable', error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      console.log(`completed ${model}: unavailable`);
    }
  }
} finally {
  process.env.LLM_MODEL_NAME = originalPrimary;
  process.env.LLM_MODEL_FALLBACKS = originalFallbacks;
}

console.log(JSON.stringify({ image: { fileName: basename(absolutePath), mimeType, bytes: buffer.length }, results }, null, 2));
if (results.some((result) => result.status !== 'available')) process.exitCode = 1;
