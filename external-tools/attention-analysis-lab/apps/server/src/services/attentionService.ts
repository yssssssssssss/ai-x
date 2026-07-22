import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type {
  AttentionAnalyzeRequest,
  AttentionAnalyzeResult,
  AttentionHotspot,
  AttentionMode,
  RoiAttentionResult,
  RoiInput,
  UploadedImageRef,
} from '@attention-analysis-lab/core';
import { assertInsideUploadDir } from './uploadService.js';
import { isLLMEnabled, configuredModelCount, chatVisionJSON } from './llmClient.js';

const GRID_SIZE = 32;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

const average = (values: number[]) => {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

const brightness = ([red, green, blue]: [number, number, number]) =>
  (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

const saturation = ([red, green, blue]: [number, number, number]) => {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
};

const resolveImageBuffer = async (image?: UploadedImageRef): Promise<Buffer | undefined> => {
  if (!image) return undefined;
  if (image.dataUrl) return Buffer.from(image.dataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (image.url?.startsWith('data:')) return Buffer.from(image.url.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (image.path) return readFile(assertInsideUploadDir(image.path));
  throw new Error('Only uploaded paths and data URLs are supported.');
};

const loadRaw = async (buffer: Buffer) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .resize(GRID_SIZE, GRID_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};

const pixelColor = (data: Buffer, channels: number, index: number): [number, number, number] => {
  const offset = index * channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
};

const localContrast = (brightnessValues: number[], x: number, y: number) => {
  const index = y * GRID_SIZE + x;
  const current = brightnessValues[index] || 0;
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
      neighbors.push(brightnessValues[ny * GRID_SIZE + nx] || 0);
    }
  }
  return Math.abs(current - average(neighbors));
};

const edgeStrength = (brightnessValues: number[], x: number, y: number) => {
  const current = brightnessValues[y * GRID_SIZE + x] || 0;
  const right = x + 1 < GRID_SIZE ? brightnessValues[y * GRID_SIZE + x + 1] || current : current;
  const bottom = y + 1 < GRID_SIZE ? brightnessValues[(y + 1) * GRID_SIZE + x] || current : current;
  return Math.max(Math.abs(current - right), Math.abs(current - bottom));
};

const buildHeatmap = async (buffer: Buffer, includeCenterBias: boolean) => {
  const raw = await loadRaw(buffer);
  const brightnessValues: number[] = [];
  const saturationValues: number[] = [];

  for (let index = 0; index < GRID_SIZE * GRID_SIZE; index += 1) {
    const color = pixelColor(raw.data, raw.channels, index);
    brightnessValues.push(brightness(color));
    saturationValues.push(saturation(color));
  }

  const rawScores: number[][] = [];
  let maxScore = 0;
  for (let y = 0; y < GRID_SIZE; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const index = y * GRID_SIZE + x;
      const normalizedX = x / (GRID_SIZE - 1);
      const normalizedY = y / (GRID_SIZE - 1);
      const centerBias = includeCenterBias
        ? 1 - Math.min(1, Math.hypot(normalizedX - 0.5, normalizedY - 0.5) * 1.35)
        : 0;
      const score =
        edgeStrength(brightnessValues, x, y) * 0.28
        + localContrast(brightnessValues, x, y) * 0.25
        + saturationValues[index] * 0.24
        + brightnessValues[index] * 0.13
        + centerBias * 0.1;
      row.push(score);
      maxScore = Math.max(maxScore, score);
    }
    rawScores.push(row);
  }

  return rawScores.map((row) => row.map((value) => round(clamp(value / Math.max(maxScore, 0.001)))));
};

const buildHotspots = (heatmap: number[][]): AttentionHotspot[] =>
  heatmap
    .flatMap((row, y) => row.map((score, x) => ({ x, y, score })))
    .sort((left, right) => right.score - left.score)
    .filter((item, index, all) => all.slice(0, index).every((prev) => Math.hypot(prev.x - item.x, prev.y - item.y) >= 4))
    .slice(0, 6)
    .map((item, index) => ({
      id: `hotspot_${index + 1}`,
      x: round(item.x / GRID_SIZE),
      y: round(item.y / GRID_SIZE),
      width: round(3 / GRID_SIZE),
      height: round(3 / GRID_SIZE),
      score: item.score,
      reason: item.score >= 0.8 ? '显著视觉刺激区域。' : '相对容易被第一眼捕捉的区域。',
    }));

const analyzeRois = (heatmap: number[][], rois: RoiInput[]): RoiAttentionResult[] => {
  const total = heatmap.flat().reduce((sum, value) => sum + value, 0);
  return rois
    .map((roi, index) => {
      const values = heatmap.flatMap((row, y) => row.filter((_, x) => {
        const normalizedX = x / GRID_SIZE;
        const normalizedY = y / GRID_SIZE;
        return normalizedX >= roi.x
          && normalizedX <= roi.x + roi.width
          && normalizedY >= roi.y
          && normalizedY <= roi.y + roi.height;
      }));
      return {
        id: roi.id || `roi_${index + 1}`,
        label: roi.label || `ROI ${index + 1}`,
        x: roi.x,
        y: roi.y,
        width: roi.width,
        height: roi.height,
        attentionAverage: round(average(values)),
        attentionPeak: round(Math.max(...values, 0)),
        attentionShare: round(values.reduce((sum, value) => sum + value, 0) / Math.max(total, 0.001)),
        attentionRank: 0,
      };
    })
    .sort((left, right) => right.attentionAverage - left.attentionAverage)
    .map((roi, index) => ({ ...roi, attentionRank: index + 1 }));
};

// ===== VLM 语义显著性路径(照原版 attentionSimulationService 规格移植) =====
const resolveImageDataUrl = async (image?: UploadedImageRef): Promise<string | undefined> => {
  if (!image) return undefined;
  if (image.url?.startsWith('http')) return image.url;
  const buffer = await resolveImageBuffer(image);
  if (!buffer) return undefined;
  const metadata = await sharp(buffer).metadata();
  const compressed = Math.max(metadata.width ?? 0, metadata.height ?? 0) > 1280 || buffer.length > 150_000
    ? await sharp(buffer).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
    : buffer;
  const mime = compressed === buffer
    ? (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : 'image/png')
    : 'image/jpeg';
  return `data:${mime};base64,${compressed.toString('base64')}`;
};

// 8×8(或任意)热力网格 → 放大的热力图 PNG dataUrl。
const createHeatmapDataUrl = async (grid: number[][]): Promise<string | undefined> => {
  if (!grid.length || !grid[0]?.length) return undefined;
  const h = grid.length, w = grid[0].length;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const v = clamp(grid[y][x] || 0);
    const o = (y * w + x) * 4;
    rgba[o] = Math.round(255 * Math.min(1, v * 1.15));
    rgba[o + 1] = Math.round(180 * (1 - Math.abs(v - 0.45) * 1.8));
    rgba[o + 2] = Math.round(255 * (1 - Math.min(1, v * 0.9)));
    rgba[o + 3] = Math.round(120 + 120 * v);
  }
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).resize(w * 24, h * 24, { kernel: 'nearest' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
};

const buildVLMPrompt = (rois: RoiInput[]) => [
  '你是一个"视觉注意力模拟器",任务不是审美点评,而是估计用户第一眼更可能先看哪里。',
  '请基于图片内容,从尺寸、对比、颜色跳出、文字层级、主体语义、视觉中心和留白环境出发进行模拟。',
  '坐标规则:xRatio/yRatio 是热点框左上角相对整图坐标,widthRatio/heightRatio 是相对整图比例,所有值在 0-1 之间。热点框要紧贴真实吸睛区域,不确定就给更小更保守的框。',
  '优先输出 3-4 个最关键热点。可把整图理解为 8x8 网格定位,heatmapGrid 输出 8×8 的 0-1 值(越大越吸睛)。',
  '只输出合法 JSON,不要任何额外解释。',
  rois.length ? `ROI 列表:\n${rois.map((r) => `- ${r.id} | ${r.label} | x=${r.x},y=${r.y},w=${r.width},h=${r.height}`).join('\n')}` : '当前没有 ROI。',
  `JSON schema:\n{"summary":"","hotspots":[{"label":"","xRatio":0,"yRatio":0,"widthRatio":0,"heightRatio":0,"score":0,"reason":""}],"gridSize":8,"heatmapGrid":[[0]]}`,
].join('\n\n');

interface VLMPayload {
  summary?: string;
  hotspots?: Array<{ label?: string; xRatio?: number; yRatio?: number; widthRatio?: number; heightRatio?: number; score?: number; reason?: string }>;
  heatmapGrid?: number[][];
}

const analyzeAttentionVLM = async (request: AttentionAnalyzeRequest, imageUrl: string): Promise<AttentionAnalyzeResult> => {
  const mode = request.mode || 'hybrid';
  const rois = request.rois || [];
  const prompt = buildVLMPrompt(rois);
  const messages = [
    { role: 'system', content: '你是一个严格输出 JSON 的视觉注意力模拟器。' },
    { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] },
  ];
  const result = await chatVisionJSON<VLMPayload>(messages);
  const parsed = result.data;

  const gridSize = 8;
  const heatmap = Array.isArray(parsed.heatmapGrid) && parsed.heatmapGrid.length
    ? parsed.heatmapGrid.slice(0, gridSize).map((row) => (Array.isArray(row) ? row.slice(0, gridSize).map((v) => round(clamp(Number(v) || 0))) : Array(gridSize).fill(0)))
    : [];
  const hotspots: AttentionHotspot[] = (parsed.hotspots || []).slice(0, 4).map((h, i) => ({
    id: `vlm_hotspot_${i + 1}`,
    label: h?.label || `热点 ${i + 1}`,
    x: round(clamp(h?.xRatio || 0)),
    y: round(clamp(h?.yRatio || 0)),
    width: round(clamp(h?.widthRatio || 0.1)),
    height: round(clamp(h?.heightRatio || 0.1)),
    score: round(clamp(h?.score ?? 0.5)),
    attentionShare: round(clamp((h?.score ?? 0.5) * 0.35)),
    reason: (h?.reason || '该区域在语义与对比上更易成为第一眼焦点。').slice(0, 120),
  }));
  const flat = heatmap.flat();
  const peak = Math.max(...hotspots.map((h) => h.score), ...flat, 0);
  const mean = average(flat.length ? flat : hotspots.map((h) => h.score));
  const roiAttentionRanking = heatmap.length ? analyzeRois(heatmap, rois) : [];
  const distractionRisk = clamp(mean * 0.65 + hotspots.filter((h) => h.score >= 0.82).length * 0.07);

  return {
    status: 'available',
    mode,
    engine: 'vlm',
    degraded: false,
    model: result.model,
    attempts: result.attempts,
    summary: (parsed.summary || `VLM 语义注意力:峰值 ${round(peak)},识别 ${hotspots.length} 个吸睛热点。`).slice(0, 200),
    heatmap,
    heatmapImage: heatmap.length ? await createHeatmapDataUrl(heatmap) : undefined,
    hotspots,
    peakAttentionScore: round(peak),
    focusBalanceScore: round(clamp(1 - Math.abs(peak - mean) * 0.8)),
    distractionRiskScore: round(distractionRisk),
    roiAttentionRanking,
    warnings: ['VLM 语义注意力属于语义近似,不等同真实眼动或正式 saliency 模型。'],
    boundaryNotes: [
      '结果是 AI 语义注意力模拟,不是眼动实验。',
      '仅辅助判断视觉刺激分布,不代表真实用户注意力数据。',
    ],
  };
};

// ===== 入口:mode=semantic/hybrid 且 LLM 可用 → VLM(失败降级),否则 sharp 启发式 =====
export const analyzeAttention = async (request: AttentionAnalyzeRequest): Promise<AttentionAnalyzeResult> => {
  const wantVLM = (request.mode === 'semantic' || request.mode === 'hybrid') && isLLMEnabled();
  if (wantVLM) {
    try {
      const imageUrl = await resolveImageDataUrl(request.image);
      if (imageUrl) return await analyzeAttentionVLM(request, imageUrl);
    } catch {
      const fallback = await analyzeAttentionHeuristic(request);
      fallback.degraded = true;
      fallback.reasonCode = 'vlm_failed';
      fallback.attempts = configuredModelCount();
      fallback.warnings = [...fallback.warnings, 'VLM 语义注意力失败,已降级启发式。'];
      return fallback;
    }
  }
  const fallback = await analyzeAttentionHeuristic(request);
  if (request.mode === 'semantic' || request.mode === 'hybrid') {
    fallback.degraded = true;
    fallback.reasonCode = 'vlm_not_configured';
    fallback.attempts = 0;
  }
  return fallback;
};

const analyzeAttentionHeuristic = async (request: AttentionAnalyzeRequest): Promise<AttentionAnalyzeResult> => {
  const mode = request.mode || 'heuristic';
  const warnings: string[] = [];
  if (mode !== 'heuristic') warnings.push('未启用 VLM,已用启发式估计。');
  const boundaryNotes = [
    '当前结果是启发式注意力估计，不是眼动实验。',
    '结果只能辅助判断视觉刺激分布，不能代表真实用户注意力数据。',
  ];
  const buffer = await resolveImageBuffer(request.image);
  if (!buffer) {
    return {
      status: 'insufficient_inputs',
      mode,
      engine: 'heuristic',
      summary: '缺少图片，无法执行注意力分析。',
      heatmap: [],
      hotspots: [],
      peakAttentionScore: 0,
      focusBalanceScore: 0,
      distractionRiskScore: 0,
      roiAttentionRanking: [],
      warnings: ['image is required'],
      boundaryNotes,
    };
  }
  const heatmap = await buildHeatmap(buffer, request.includeCenterBias ?? true);
  const flat = heatmap.flat();
  const peak = Math.max(...flat, 0);
  const mean = average(flat);
  const hotspots = buildHotspots(heatmap);
  const roiAttentionRanking = analyzeRois(heatmap, request.rois || []);
  const distractionRisk = clamp(mean * 0.65 + hotspots.filter((item) => item.score >= 0.82).length * 0.07);

  return {
    status: 'available',
    mode,
    engine: 'heuristic',
    summary: `启发式注意力峰值 ${round(peak)}，分散风险 ${round(distractionRisk)}。`,
    heatmap,
    hotspots,
    peakAttentionScore: round(peak),
    focusBalanceScore: round(clamp(1 - Math.abs(peak - mean) * 0.8)),
    distractionRiskScore: round(distractionRisk),
    roiAttentionRanking,
    warnings,
    boundaryNotes,
  };
};
