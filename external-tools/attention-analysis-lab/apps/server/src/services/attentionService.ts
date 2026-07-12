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

const buildSemanticPlaceholder = (mode: AttentionMode, warnings: string[]) => {
  if (mode === 'heuristic') return;
  warnings.push('semantic/hybrid 模式当前 MVP 未接入 VLM，已回退为 heuristic 结果。');
};

export const analyzeAttention = async (request: AttentionAnalyzeRequest): Promise<AttentionAnalyzeResult> => {
  const mode = request.mode || 'heuristic';
  const warnings: string[] = [];
  const boundaryNotes = [
    '当前结果是启发式注意力估计，不是眼动实验。',
    '结果只能辅助判断视觉刺激分布，不能代表真实用户注意力数据。',
  ];
  const buffer = await resolveImageBuffer(request.image);
  if (!buffer) {
    return {
      status: 'insufficient_inputs',
      mode,
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
  buildSemanticPlaceholder(mode, warnings);
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
