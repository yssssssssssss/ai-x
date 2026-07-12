import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { UploadedImageRef, VisionBrandAnalyzeRequest, VisionBrandAnalyzeResult, VisualReviewerResult } from '@vision-brand-lab/core';
import { assertInsideUploadDir } from './uploadService.js';

interface ImageStats {
  brightness: number;
  saturation: number;
  edgeDensity: number;
  colorComplexity: number;
  dominant: [number, number, number];
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const brightness = ([red, green, blue]: [number, number, number]) => (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
const saturation = ([red, green, blue]: [number, number, number]) => {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  return max === 0 ? 0 : (max - min) / max;
};
const distance = (left: [number, number, number], right: [number, number, number]) => Math.sqrt((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2) / Math.sqrt(255 ** 2 * 3);

const resolveImageBuffer = async (image?: UploadedImageRef): Promise<Buffer | undefined> => {
  if (!image) return undefined;
  if (image.dataUrl) return Buffer.from(image.dataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (image.url?.startsWith('data:')) return Buffer.from(image.url.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (image.path) return readFile(assertInsideUploadDir(image.path));
  throw new Error('Only uploaded paths and data URLs are supported.');
};

const statsFor = async (buffer: Buffer): Promise<ImageStats> => {
  const { data, info } = await sharp(buffer).ensureAlpha().resize(72, 72, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const colors: Array<[number, number, number]> = [];
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * info.channels;
    const alpha = info.channels >= 4 ? data[offset + 3] / 255 : 1;
    if (alpha <= 0.05) continue;
    colors.push([data[offset], data[offset + 1], data[offset + 2]]);
  }
  const dominant: [number, number, number] = [
    Math.round(average(colors.map((color) => color[0]))),
    Math.round(average(colors.map((color) => color[1]))),
    Math.round(average(colors.map((color) => color[2]))),
  ];
  let edgeTotal = 0;
  let edgeCount = 0;
  for (let y = 0; y < info.height - 1; y += 1) {
    for (let x = 0; x < info.width - 1; x += 1) {
      const current = colors[y * info.width + x];
      const right = colors[y * info.width + x + 1];
      const bottom = colors[(y + 1) * info.width + x];
      if (!current || !right || !bottom) continue;
      edgeTotal += Math.max(distance(current, right), distance(current, bottom));
      edgeCount += 1;
    }
  }
  return {
    brightness: round(average(colors.map(brightness))),
    saturation: round(average(colors.map(saturation))),
    edgeDensity: round(edgeCount ? edgeTotal / edgeCount : 0),
    colorComplexity: round(average(colors.map((color) => distance(color, dominant)))),
    dominant,
  };
};

const reviewerResults = (stats: ImageStats, goal?: string): VisualReviewerResult[] => {
  const clarityScore = clamp(1 - stats.edgeDensity * 2.2 + (stats.brightness > 0.35 ? 0.08 : -0.08));
  const brandScore = clamp(1 - stats.colorComplexity * 1.4 + stats.saturation * 0.2);
  const conversionScore = clamp(0.55 + stats.saturation * 0.22 - stats.edgeDensity * 0.4);
  return [
    { role: '视觉清晰度评审', score: round(clarityScore), findings: [`亮度 ${stats.brightness}，边缘密度 ${stats.edgeDensity}。`], suggestions: [clarityScore < 0.65 ? '降低细碎元素密度，提升关键信息对比。' : '保持当前信息层级。'] },
    { role: '品牌一致性评审', score: round(brandScore), findings: [`主色 RGB(${stats.dominant.join(',')})，颜色复杂度 ${stats.colorComplexity}。`], suggestions: [brandScore < 0.65 ? '收敛主辅色，强化品牌识别锚点。' : '品牌视觉风格相对稳定。'] },
    { role: '转化动线评审', score: round(conversionScore), findings: [`业务目标：${goal || '未提供'}。`], suggestions: [conversionScore < 0.65 ? '突出主行动入口并减少视觉竞争。' : '可继续验证主行动入口点击表现。'] },
  ];
};

const brandAssociation = async (designStats: ImageStats[], referenceBuffers: Buffer[]) => {
  if (!referenceBuffers.length) {
    return { status: 'insufficient_inputs' as const, summary: '缺少品牌参考图，未执行品牌联想度。', referenceSampleCount: 0, designSampleCount: designStats.length, warnings: ['brandReferenceImages is empty'] };
  }
  const referenceStats = await Promise.all(referenceBuffers.map(statsFor));
  const designAverage = designStats[0];
  const referenceAverage = referenceStats[0];
  const colorSimilarity = 1 - distance(designAverage.dominant, referenceAverage.dominant);
  const structureSimilarity = 1 - Math.abs(designAverage.edgeDensity - referenceAverage.edgeDensity);
  const saturationSimilarity = 1 - Math.abs(designAverage.saturation - referenceAverage.saturation);
  const score = round(clamp(colorSimilarity * 0.5 + structureSimilarity * 0.25 + saturationSimilarity * 0.25));
  return { status: 'available' as const, score, vectorScore: score, summary: `品牌联想度近似分 ${score}。`, referenceSampleCount: referenceBuffers.length, designSampleCount: designStats.length, warnings: ['当前为本地启发式近似，不是严格 embedding 结果。'] };
};

export const analyzeVisionBrand = async (request: VisionBrandAnalyzeRequest): Promise<VisionBrandAnalyzeResult> => {
  const designBuffers = (await Promise.all((request.designImages || []).map(resolveImageBuffer))).filter((item): item is Buffer => Boolean(item));
  const boundaryNotes = ['视觉评审来自启发式规则，不替代专业设计评审。', '品牌联想度是风格近似分，需要结合品牌规范人工复核。'];
  if (!designBuffers.length) {
    return { status: 'insufficient_inputs', summary: '缺少设计图，无法执行视觉与品牌分析。', findings: [], recommendations: ['上传至少 1 张设计图。'], warnings: ['designImages is required'], boundaryNotes };
  }
  const designStats = await Promise.all(designBuffers.map(statsFor));
  const reviewers = reviewerResults(designStats[0], request.businessGoal);
  const referenceBuffers = (await Promise.all((request.brandReferenceImages || []).map(resolveImageBuffer))).filter((item): item is Buffer => Boolean(item));
  const brandResult = await brandAssociation(designStats, referenceBuffers);
  const consensus = reviewers.filter((item) => item.score >= 0.68).map((item) => `${item.role}：${item.score}`);
  const conflicts = reviewers.filter((item) => item.score < 0.55).map((item) => `${item.role} 低于阈值，建议人工复核。`);
  const priorityActions = reviewers.flatMap((item) => item.suggestions).slice(0, 3);
  return {
    status: brandResult.status === 'available' ? 'available' : 'partial_failed',
    summary: `已完成 ${reviewers.length} 个视觉评审角色${brandResult.status === 'available' ? '和品牌联想度分析' : '，品牌联想度未执行'}。`,
    visualReview: { reviewers, consensus, conflicts, priorityActions },
    brandAssociation: brandResult,
    findings: reviewers.flatMap((item) => item.findings),
    recommendations: priorityActions,
    warnings: brandResult.warnings,
    boundaryNotes,
  };
};
