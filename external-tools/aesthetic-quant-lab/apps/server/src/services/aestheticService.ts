import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type {
  AestheticAnalyzeRequest,
  AestheticAnalyzeResult,
  AttentionHotspot,
  AttentionResult,
  RoiInput,
  RoiResult,
  UploadedImageRef,
  WholeImageResult,
} from '@aesthetic-quant-lab/core';
import { assertInsideUploadDir } from './uploadService.js';
import { getProfile } from './profiles.js';

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

const average = (values: number[]) => {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

const colorDistance = (left: [number, number, number], right: [number, number, number]) => {
  const distance = Math.sqrt(
    (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2,
  );
  return distance / Math.sqrt(255 ** 2 * 3);
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
  if (image.dataUrl) {
    const base64 = image.dataUrl.replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(base64, 'base64');
  }
  if (image.path) return readFile(assertInsideUploadDir(image.path));
  if (image.url?.startsWith('data:')) {
    const base64 = image.url.replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(base64, 'base64');
  }
  throw new Error('Only uploaded paths and data URLs are supported in this standalone MVP.');
};

const loadRawImage = async (buffer: Buffer, width = 96, height = 96) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};

const computeStats = async (buffer: Buffer, sampleWidth = 96, sampleHeight = 96) => {
  const raw = await loadRawImage(buffer, sampleWidth, sampleHeight);
  const pixelCount = raw.width * raw.height;
  const brightnessValues: number[] = [];
  const saturationValues: number[] = [];
  const colors: Array<[number, number, number]> = [];

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * raw.channels;
    const alpha = raw.channels >= 4 ? raw.data[offset + 3] / 255 : 1;
    if (alpha <= 0.05) continue;
    const color: [number, number, number] = [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
    colors.push(color);
    brightnessValues.push(brightness(color));
    saturationValues.push(saturation(color));
  }

  let edgeTotal = 0;
  let edgeCount = 0;
  for (let y = 0; y < raw.height - 1; y += 1) {
    for (let x = 0; x < raw.width - 1; x += 1) {
      const index = y * raw.width + x;
      const right = y * raw.width + x + 1;
      const bottom = (y + 1) * raw.width + x;
      const current = colors[index];
      const rightColor = colors[right];
      const bottomColor = colors[bottom];
      if (!current || !rightColor || !bottomColor) continue;
      edgeTotal += Math.max(colorDistance(current, rightColor), colorDistance(current, bottomColor));
      edgeCount += 1;
    }
  }

  const meanColor: [number, number, number] = [
    Math.round(average(colors.map((color) => color[0]))),
    Math.round(average(colors.map((color) => color[1]))),
    Math.round(average(colors.map((color) => color[2]))),
  ];
  const colorComplexity = average(colors.map((color) => colorDistance(color, meanColor)));
  const edgeDensity = edgeCount ? edgeTotal / edgeCount : 0;

  return {
    brightness: average(brightnessValues),
    saturation: average(saturationValues),
    edgeDensity,
    colorComplexity,
    textureComplexity: clamp(edgeDensity * 1.35 + colorComplexity * 0.35),
    dominantColor: `RGB(${meanColor[0]},${meanColor[1]},${meanColor[2]})`,
  };
};

const wholeImage = async (buffer: Buffer): Promise<WholeImageResult> => {
  const metadata = await sharp(buffer).metadata();
  const stats = await computeStats(buffer);
  const readability = 1 - Math.abs(stats.brightness - 0.58) * 1.2;
  const simplicity = 1 - clamp(stats.edgeDensity * 2.8 + stats.colorComplexity * 0.8);
  const vibrancy = 1 - Math.abs(stats.saturation - 0.42);
  const score = clamp(readability * 0.35 + simplicity * 0.4 + vibrancy * 0.25);

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    edgeDensity: round(stats.edgeDensity),
    textureComplexity: round(stats.textureComplexity),
    colorComplexity: round(stats.colorComplexity),
    dominantColor: stats.dominantColor,
    brightness: round(stats.brightness),
    saturation: round(stats.saturation),
    textRecommendation: stats.brightness >= 0.55 ? '建议使用深色文字' : '建议使用浅色文字',
    score: round(score),
  };
};

const cropByRoi = async (buffer: Buffer, roi: RoiInput) => {
  const metadata = await sharp(buffer).metadata();
  const imageWidth = metadata.width || 1;
  const imageHeight = metadata.height || 1;
  const left = Math.floor(clamp(roi.x) * imageWidth);
  const top = Math.floor(clamp(roi.y) * imageHeight);
  const width = Math.max(1, Math.floor(clamp(roi.width, 0.01, 1) * imageWidth));
  const height = Math.max(1, Math.floor(clamp(roi.height, 0.01, 1) * imageHeight));
  return sharp(buffer)
    .extract({
      left: Math.min(left, imageWidth - 1),
      top: Math.min(top, imageHeight - 1),
      width: Math.min(width, imageWidth - left),
      height: Math.min(height, imageHeight - top),
    })
    .png()
    .toBuffer();
};

const analyzeRois = async (buffer: Buffer, rois: RoiInput[] = []): Promise<RoiResult[]> => {
  const results: RoiResult[] = [];
  for (const [index, roi] of rois.entries()) {
    const roiBuffer = await cropByRoi(buffer, roi);
    const stats = await computeStats(roiBuffer, 48, 48);
    const score = clamp((1 - stats.edgeDensity * 2.2) * 0.35 + (1 - stats.colorComplexity) * 0.25 + stats.saturation * 0.2 + (1 - Math.abs(stats.brightness - 0.55)) * 0.2);
    results.push({
      id: roi.id || `roi_${index + 1}`,
      label: roi.label || `ROI ${index + 1}`,
      x: roi.x,
      y: roi.y,
      width: roi.width,
      height: roi.height,
      score: round(score),
      brightness: round(stats.brightness),
      saturation: round(stats.saturation),
      edgeDensity: round(stats.edgeDensity),
    });
  }
  return results;
};

const analyzeAttention = async (buffer: Buffer, roiResults: RoiResult[]): Promise<AttentionResult> => {
  const size = 24;
  const raw = await loadRawImage(buffer, size, size);
  const heatmap: number[][] = [];
  let peak = 0;
  let total = 0;

  for (let y = 0; y < size; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * raw.channels;
      const color: [number, number, number] = [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
      const centerBias = 1 - Math.min(1, Math.hypot(x / (size - 1) - 0.5, y / (size - 1) - 0.5) * 1.2);
      const value = clamp(brightness(color) * 0.25 + saturation(color) * 0.35 + centerBias * 0.4);
      row.push(round(value));
      peak = Math.max(peak, value);
      total += value;
    }
    heatmap.push(row);
  }

  const hotspots: AttentionHotspot[] = heatmap
    .flatMap((row, y) => row.map((score, x) => ({ x, y, score })))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((item, index) => ({
      id: `hotspot_${index + 1}`,
      x: round(item.x / size),
      y: round(item.y / size),
      width: round(1 / size),
      height: round(1 / size),
      score: item.score,
      reason: '高亮度、饱和度或中心位置带来较高启发式注意力。',
    }));

  const averageAttention = total / (size * size);
  for (const roi of roiResults) {
    const cells = heatmap.flatMap((row, y) => row.filter((_, x) => {
      const normalizedX = x / size;
      const normalizedY = y / size;
      return normalizedX >= roi.x && normalizedX <= roi.x + roi.width && normalizedY >= roi.y && normalizedY <= roi.y + roi.height;
    }));
    roi.attentionAverage = round(average(cells));
    roi.attentionPeak = round(Math.max(...cells, 0));
    roi.attentionShare = round(cells.reduce((sum, value) => sum + value, 0) / Math.max(total, 0.0001));
  }
  roiResults
    .slice()
    .sort((left, right) => (right.attentionAverage || 0) - (left.attentionAverage || 0))
    .forEach((roi, index) => {
      roi.attentionRank = index + 1;
    });

  return {
    heatmap,
    hotspots,
    peakAttentionScore: round(peak),
    focusBalanceScore: round(1 - Math.abs(peak - averageAttention) * 1.4),
    distractionRiskScore: round(clamp(averageAttention + Math.max(0, peak - 0.7) * 0.5)),
    summary: `启发式注意力峰值 ${round(peak)}，平均刺激 ${round(averageAttention)}。`,
  };
};

const analyzePair = async (foreground?: Buffer, background?: Buffer) => {
  if (!foreground || !background) return undefined;
  const foregroundStats = await computeStats(foreground, 48, 48);
  const backgroundStats = await computeStats(background, 48, 48);
  const brightnessDelta = Math.abs(foregroundStats.brightness - backgroundStats.brightness);
  const saturationDelta = Math.abs(foregroundStats.saturation - backgroundStats.saturation);
  const contrastRatio = (Math.max(foregroundStats.brightness, backgroundStats.brightness) + 0.05)
    / (Math.min(foregroundStats.brightness, backgroundStats.brightness) + 0.05);
  return {
    contrastRatio: round(contrastRatio, 2),
    brightnessDelta: round(brightnessDelta),
    saturationDelta: round(saturationDelta),
    harmonyTheory: brightnessDelta >= 0.35 ? '明暗分离较清晰' : '明暗关系偏接近，需关注可读性',
    score: round(clamp(brightnessDelta * 1.4 + (1 - saturationDelta) * 0.25)),
  };
};

export const analyzeAesthetic = async (request: AestheticAnalyzeRequest): Promise<AestheticAnalyzeResult> => {
  const profile = getProfile(request.profileId);
  const depth = request.depth || profile.defaultDepth;
  const warnings: string[] = [];
  const boundaryNotes = [
    '美学量化结果来自本地图像统计和启发式规则，不替代专业设计评审。',
    '注意力结果不是眼动实验，不代表真实用户注意力数据。',
  ];
  const designBuffer = await resolveImageBuffer(request.designImage);
  if (!designBuffer) {
    return {
      status: 'insufficient_inputs',
      summary: '缺少设计图，无法执行美学量化分析。',
      profileId: profile.id,
      depth,
      dimensionScores: { overallColorScore: 0, temperatureScore: 0, colorfulnessScore: 0, harmonyScore: 0 },
      roiResults: [],
      findings: [],
      recommendations: ['上传至少 1 张设计图。'],
      warnings: ['designImage is required'],
      boundaryNotes,
      confidence: { level: 'low', score: 0, notes: ['输入不足。'] },
    };
  }

  const whole = await wholeImage(designBuffer);
  const roiResults = await analyzeRois(designBuffer, request.rois || []);
  const attentionEnabled = request.enableAttention ?? profile.defaults.enableAttention;
  const attentionResult = attentionEnabled ? await analyzeAttention(designBuffer, roiResults) : undefined;
  const foreground = await resolveImageBuffer(request.foregroundImage);
  const background = await resolveImageBuffer(request.backgroundImage);
  const pairResult = await analyzePair(foreground, background);
  if (!pairResult && (request.foregroundImage || request.backgroundImage)) warnings.push('前景/背景图不完整，已跳过配色关系分析。');

  const roiScore = roiResults.length ? average(roiResults.map((roi) => roi.score)) : whole.score;
  const pairScore = pairResult?.score ?? whole.score;
  const attentionScore = attentionResult ? 1 - attentionResult.distractionRiskScore * 0.45 : undefined;
  const includeAttention = request.includeAttentionInOverallScore ?? profile.defaults.includeAttentionInOverallScore;
  let overallScore = whole.score * 0.48 + roiScore * 0.32 + pairScore * 0.2;
  if (includeAttention && attentionScore !== undefined) overallScore = overallScore * 0.9 + attentionScore * 0.1;
  overallScore = round(clamp(overallScore));

  const findings = [
    `整图主色为 ${whole.dominantColor}，亮度 ${whole.brightness}，复杂度 ${whole.colorComplexity}。`,
    roiResults.length ? `已分析 ${roiResults.length} 个 ROI，最低 ROI 分数为 ${Math.min(...roiResults.map((roi) => roi.score))}。` : '未提供 ROI，当前只输出整图层分析。',
    pairResult ? `前景/背景对比度 ${pairResult.contrastRatio}，${pairResult.harmonyTheory}。` : '未提供完整前景/背景图，跳过配色关系分析。',
  ];
  const recommendations = [
    whole.edgeDensity > 0.18 ? '整图边缘密度偏高，建议减少细碎装饰。' : undefined,
    whole.colorComplexity > 0.28 ? '颜色复杂度偏高，建议收敛主辅色数量。' : undefined,
    whole.brightness < 0.35 ? '整体亮度偏低，建议提升中间调和文本对比。' : undefined,
    attentionResult && attentionResult.distractionRiskScore > 0.65 ? '注意力分布偏散，建议将视觉锚点控制在 1–2 个。' : undefined,
    pairResult && pairResult.contrastRatio < 2.5 ? '前景与背景对比度偏弱，建议增强前景轮廓或压低背景干扰。' : undefined,
  ].filter((item): item is string => Boolean(item));

  return {
    status: 'available',
    summary: `美学量化综合分 ${overallScore}，profile=${profile.id}，depth=${depth}。`,
    profileId: profile.id,
    depth,
    overallScore,
    dimensionScores: {
      overallColorScore: round(1 - whole.colorComplexity),
      temperatureScore: round(1 - Math.abs(whole.brightness - 0.55)),
      colorfulnessScore: whole.saturation,
      harmonyScore: round(pairResult?.score ?? (1 - whole.edgeDensity)),
      ...(attentionScore !== undefined ? { attentionFocusScore: round(attentionScore) } : {}),
    },
    wholeImage: whole,
    roiResults,
    pairResult,
    attentionResult,
    findings,
    recommendations: recommendations.length ? recommendations : ['当前未发现高风险视觉问题，可继续结合人工评审确认。'],
    warnings,
    boundaryNotes,
    confidence: {
      level: pairResult && roiResults.length ? 'high' : roiResults.length ? 'medium' : 'low',
      score: pairResult && roiResults.length ? 0.82 : roiResults.length ? 0.68 : 0.52,
      notes: [
        pairResult ? '包含前景/背景配色分析。' : '缺少前景/背景配对输入。',
        roiResults.length ? '包含 ROI 局部分析。' : '缺少 ROI，局部稳定性判断有限。',
      ],
    },
  };
};
