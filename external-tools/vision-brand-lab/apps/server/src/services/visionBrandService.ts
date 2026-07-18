import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type {
  UploadedImageRef,
  VisionBrandAnalyzeRequest,
  VisionBrandAnalyzeResult,
  VisualReviewerResult,
  ReviewerDimension,
  ReviewerIssue,
  BrandAssociationResult,
} from '@vision-brand-lab/core';
import { assertInsideUploadDir } from './uploadService.js';
import { isLLMEnabled, chatVisionJSON } from './llmClient.js';

// ===== 通用工具 =====
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const average = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);
const uniqueStrings = (arr: string[]) => [...new Set(arr.filter((s) => s && s.trim()))];

const boundaryNotes = [
  '视觉评审为 AI(VLM/启发式)分析,不替代专业设计评审。',
  '品牌联想度是风格近似分,需结合品牌规范人工复核。',
];

// ===== 图像读取 =====
const resolveImageBuffer = async (image?: UploadedImageRef): Promise<Buffer | undefined> => {
  if (!image) return undefined;
  if (image.dataUrl) return Buffer.from(image.dataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (image.url?.startsWith('data:')) return Buffer.from(image.url.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (image.path) return readFile(assertInsideUploadDir(image.path));
  throw new Error('Only uploaded paths and data URLs are supported.');
};

const bufToDataUrl = (buf: Buffer): string => {
  const b64 = buf.toString('base64');
  const mime = b64.startsWith('/9j/') ? 'image/jpeg'
    : b64.startsWith('iVBORw0') ? 'image/png'
    : b64.startsWith('R0lGOD') ? 'image/gif'
    : b64.startsWith('UklGR') ? 'image/webp'
    : 'image/png';
  return `data:${mime};base64,${b64}`;
};

// UploadedImageRef → 可直接塞进 image_url.url 的字符串(data URL 或 http 直链)。
const resolveImageDataUrl = async (image?: UploadedImageRef): Promise<string | undefined> => {
  if (!image) return undefined;
  if (image.dataUrl) return image.dataUrl;
  if (image.url && (image.url.startsWith('http') || image.url.startsWith('data:'))) return image.url;
  if (image.path) return bufToDataUrl(await readFile(assertInsideUploadDir(image.path)));
  return undefined;
};

// ===================================================================
// LLM(VLM)路径:三角色真实视觉评审 + VLM 16 轴品牌向量
// ===================================================================
const ROLES = [
  { role: 'structural', label: '视觉设计师', system: '你是优秀的视觉设计师,会根据画面的设计风格、美观度进行分析评估并给出建议。', dims: ['设计风格', '美观度', '视觉一致性', '画面质感', '整体完成度'] },
  { role: 'emotional', label: '交互体验设计师', system: '你是优秀的交互体验设计师,会根据画面重点是否突出、文字是否清晰、用户浏览动线和操作体验是否科学合理进行分析评估。', dims: ['重点突出度', '文字清晰度', '浏览动线', '操作体验', '信息层级'] },
  { role: 'behavioral', label: '创意策划师', system: '你是优秀的创意策划师,会根据画面和文案的创意性、传播性、独特性进行分析评估。', dims: ['创意性', '传播性', '独特性', '文案表达', '记忆点'] },
] as const;

const REVIEW_JSON_SHAPE = `{"dimensions":[{"name":"","score":0,"evidence":"","suggestion":""}],"issues":[{"severity":"low|medium|high","issue":"","suggestion":""}],"overallScore":0,"topSuggestion":""}`;

interface RolePayload {
  dimensions?: Array<{ name?: string; score?: number; evidence?: string; suggestion?: string }>;
  issues?: Array<{ severity?: string; issue?: string; suggestion?: string }>;
  overallScore?: number;
  topSuggestion?: string;
}

const normalizeReviewer = (role: typeof ROLES[number], raw: RolePayload): VisualReviewerResult => {
  const dimensions: ReviewerDimension[] = Array.isArray(raw.dimensions)
    ? raw.dimensions.map((d) => ({ name: String(d?.name ?? ''), score: typeof d?.score === 'number' ? d.score : undefined, evidence: d?.evidence, suggestion: d?.suggestion })).filter((d) => d.name)
    : [];
  const issues: ReviewerIssue[] = Array.isArray(raw.issues)
    ? raw.issues.map((i) => ({ severity: (['low', 'medium', 'high'].includes(String(i?.severity)) ? i!.severity : 'medium') as ReviewerIssue['severity'], issue: String(i?.issue ?? ''), suggestion: i?.suggestion })).filter((i) => i.issue)
    : [];
  const overallScore = typeof raw.overallScore === 'number' ? raw.overallScore : (average(dimensions.map((d) => d.score ?? 0)) || 6);
  const topSuggestion = raw.topSuggestion || issues[0]?.suggestion || dimensions.find((d) => d.suggestion)?.suggestion || '';
  return {
    role: role.role,
    roleLabel: role.label,
    score: round(clamp(overallScore / 10)),
    overallScore: round(overallScore, 1),
    dimensions,
    issues,
    topSuggestion,
    findings: issues.map((i) => i.issue),
    suggestions: uniqueStrings([topSuggestion, ...issues.map((i) => i.suggestion ?? '')]),
  };
};

const reviewOneRole = async (
  role: typeof ROLES[number],
  goal: string,
  focus: string[],
  imageUrls: string[],
): Promise<VisualReviewerResult> => {
  const system = `${role.system}\n当前评审角色:${role.label}。\n你只能输出 JSON,不要输出任何解释或 markdown。\n所有观察必须基于图像中的具体元素;依据不足时必须保守表达。`;
  const userText = [
    `业务目标:${goal || '未提供'}`,
    `评审维度:${role.dims.join('、')}`,
    focus.length ? `重点关注:${focus.join('、')}` : '',
    `请对提供的设计图逐维度打分(0-10)并指出问题与建议。严格按此 JSON 结构输出:`,
    REVIEW_JSON_SHAPE,
  ].filter(Boolean).join('\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: userText }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))] },
  ];
  const raw = await chatVisionJSON<RolePayload>(messages);
  return normalizeReviewer(role, raw);
};

// 品牌联想度:VLM 16 轴风格向量(降级路径,不依赖 DINOv2),余弦相似度。
const DESCRIPTOR_AXES = ['minimalism', 'premium', 'playfulness', 'technology', 'warmth', 'boldness', 'luxury', 'youthfulness', 'contrast', 'saturation', 'typographyStrength', 'photographyReliance', 'illustrationReliance', 'whitespace', 'motion', 'symmetry'];

const l2 = (v: number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const meanNormalized = (vs: number[][]): number[] => {
  const norm = vs.map(l2);
  const dim = norm[0].length;
  const mean = Array(dim).fill(0);
  for (const v of norm) for (let i = 0; i < dim; i += 1) mean[i] += v[i] / norm.length;
  return l2(mean);
};
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

const extractDescriptorVectors = async (imageUrls: string[]): Promise<number[][]> => {
  const system = '你是品牌视觉向量抽取器,把每张图片映射到固定的 16 轴视觉风格向量,每个维度输出 0 到 1 的小数。只输出 JSON,不要解释。';
  const userText = [
    `16 个维度(按此顺序):${DESCRIPTOR_AXES.join(', ')}`,
    `对每张图输出一个向量。严格按此 JSON 结构:`,
    `{"items":[{"slot":0,"vector":{${DESCRIPTOR_AXES.map((a) => `"${a}":0`).join(',')}}}]}`,
  ].join('\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: userText }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))] },
  ];
  const raw = await chatVisionJSON<{ items?: Array<{ vector?: Record<string, number> }> }>(messages);
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items.map((it) => DESCRIPTOR_AXES.map((axis) => clamp(Number(it?.vector?.[axis]) || 0)));
};

const brandAssociationVLM = async (designUrls: string[], referenceUrls: string[]): Promise<BrandAssociationResult> => {
  if (!referenceUrls.length) {
    return { status: 'insufficient_inputs', summary: '缺少品牌参考图,未执行品牌联想度。', referenceSampleCount: 0, designSampleCount: designUrls.length, warnings: ['brandReferenceImages is empty'] };
  }
  const refSample = referenceUrls.slice(0, 4);
  const [designVecs, refVecs] = await Promise.all([
    extractDescriptorVectors(designUrls.slice(0, 3)),
    extractDescriptorVectors(refSample),
  ]);
  if (!designVecs.length || !refVecs.length) {
    return { status: 'failed', summary: '向量抽取失败。', referenceSampleCount: refSample.length, designSampleCount: designUrls.length, warnings: ['descriptor vector extraction returned empty'] };
  }
  const cos = cosine(meanNormalized(designVecs), meanNormalized(refVecs));
  const score = round(clamp((cos + 1) / 2), 4);
  const band = score >= 0.75 ? '高' : score >= 0.55 ? '中' : '低';
  return {
    status: 'available',
    score,
    vectorScore: score,
    summary: `品牌联想度${band}｜总分 ${score}｜向量后端 VLM 描述子(16 轴)`,
    referenceSampleCount: refSample.length,
    designSampleCount: designUrls.length,
    warnings: ['向量由 VLM 风格描述子近似,非专业 embedding(如 DINOv2);仅供参考。'],
    vectorBackend: 'vlm_descriptor',
    vectorDimension: 16,
  };
};

const analyzeVisionBrandLLM = async (request: VisionBrandAnalyzeRequest): Promise<VisionBrandAnalyzeResult> => {
  const designUrls = (await Promise.all((request.designImages || []).map(resolveImageDataUrl))).filter((u): u is string => Boolean(u));
  if (!designUrls.length) {
    return { status: 'insufficient_inputs', engine: 'vlm', summary: '缺少设计图,无法执行视觉与品牌分析。', findings: [], recommendations: ['上传至少 1 张设计图。'], warnings: ['designImages is required'], boundaryNotes };
  }
  const referenceUrls = (await Promise.all((request.brandReferenceImages || []).map(resolveImageDataUrl))).filter((u): u is string => Boolean(u));
  const goal = request.businessGoal || '';
  const focus = request.reviewFocus || [];
  const reviewImages = designUrls.slice(0, 3);

  // 3 角色各自 VLM 评审:独立 try,失败跳过;全失败则抛错由上层回退启发式。
  const settled = await Promise.allSettled(ROLES.map((r) => reviewOneRole(r, goal, focus, reviewImages)));
  const reviewers = settled.filter((s): s is PromiseFulfilledResult<VisualReviewerResult> => s.status === 'fulfilled').map((s) => s.value);
  if (!reviewers.length) throw new Error('all VLM reviewers failed');

  let brand: BrandAssociationResult;
  try {
    brand = await brandAssociationVLM(designUrls, referenceUrls);
  } catch (err) {
    brand = { status: 'failed', summary: '品牌联想度计算失败。', referenceSampleCount: referenceUrls.length, designSampleCount: designUrls.length, warnings: [err instanceof Error ? err.message : String(err)] };
  }

  // consensus / conflicts / prioritizedActions —— 纯规则(照原版阈值)。
  const scores = reviewers.map((r) => r.overallScore ?? r.score * 10);
  const lowScoreCount = scores.filter((s) => s <= 6).length;
  const scoreSpread = scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : 0;
  const topSuggestions = uniqueStrings(reviewers.map((r) => r.topSuggestion ?? ''));
  const consensus: string[] = [];
  if (lowScoreCount >= 2) consensus.push('多角色均认为当前稿件仍有明显优化空间。');
  if (topSuggestions.length >= 2) consensus.push(`多角色建议优先处理:${topSuggestions.slice(0, 2).join(';')}`);
  if (brand.status === 'available' && (brand.score ?? 0) >= 0.75) consensus.push(`品牌联想度较高(${brand.score})。`);
  if (brand.status === 'available' && (brand.score ?? 1) < 0.55) consensus.push(`品牌联想度偏弱(${brand.score}),建议强化品牌视觉锚点。`);
  const conflicts: string[] = [];
  if (scoreSpread >= 2) conflicts.push('不同视觉角色对当前稿件质量评分存在明显分歧,建议人工复核。');
  const priorityActions = uniqueStrings([
    ...(brand.status === 'available' && (brand.score ?? 1) < 0.55 ? ['收敛主辅色、强化品牌识别锚点。'] : []),
    ...topSuggestions,
  ]).slice(0, 5);

  const status: VisionBrandAnalyzeResult['status'] = brand.status === 'available' ? 'available' : 'partial_failed';
  return {
    status,
    engine: 'vlm',
    summary: `真实 VLM 三角色评审完成(${reviewers.length}/3 角色)${brand.status === 'available' ? ' + 品牌联想度' : ',品牌联想度未执行'}。`,
    visualReview: { reviewers, consensus, conflicts, priorityActions },
    brandAssociation: brand,
    findings: reviewers.flatMap((r) => (r.issues ?? []).map((i) => `[${r.roleLabel}] ${i.issue}`)),
    recommendations: priorityActions,
    warnings: brand.warnings ?? [],
    boundaryNotes,
  };
};

// ===================================================================
// 启发式降级路径(原 sharp 实现,保留作 fallback)
// ===================================================================
interface ImageStats { brightness: number; saturation: number; edgeDensity: number; colorComplexity: number; dominant: [number, number, number]; }
const brightnessOf = ([r, g, b]: [number, number, number]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const saturationOf = ([r, g, b]: [number, number, number]) => { const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255; return mx === 0 ? 0 : (mx - mn) / mx; };
const distance = (l: [number, number, number], r: [number, number, number]) => Math.sqrt((l[0] - r[0]) ** 2 + (l[1] - r[1]) ** 2 + (l[2] - r[2]) ** 2) / Math.sqrt(255 ** 2 * 3);

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
    Math.round(average(colors.map((c) => c[0]))),
    Math.round(average(colors.map((c) => c[1]))),
    Math.round(average(colors.map((c) => c[2]))),
  ];
  let edgeTotal = 0, edgeCount = 0;
  for (let y = 0; y < info.height - 1; y += 1) for (let x = 0; x < info.width - 1; x += 1) {
    const cur = colors[y * info.width + x], rt = colors[y * info.width + x + 1], bt = colors[(y + 1) * info.width + x];
    if (!cur || !rt || !bt) continue;
    edgeTotal += Math.max(distance(cur, rt), distance(cur, bt)); edgeCount += 1;
  }
  return { brightness: round(average(colors.map(brightnessOf))), saturation: round(average(colors.map(saturationOf))), edgeDensity: round(edgeCount ? edgeTotal / edgeCount : 0), colorComplexity: round(average(colors.map((c) => distance(c, dominant)))), dominant };
};

const heuristicReviewers = (stats: ImageStats, goal?: string): VisualReviewerResult[] => {
  const clarityScore = clamp(1 - stats.edgeDensity * 2.2 + (stats.brightness > 0.35 ? 0.08 : -0.08));
  const brandScore = clamp(1 - stats.colorComplexity * 1.4 + stats.saturation * 0.2);
  const conversionScore = clamp(0.55 + stats.saturation * 0.22 - stats.edgeDensity * 0.4);
  return [
    { role: '视觉清晰度评审', score: round(clarityScore), findings: [`亮度 ${stats.brightness},边缘密度 ${stats.edgeDensity}。`], suggestions: [clarityScore < 0.65 ? '降低细碎元素密度,提升关键信息对比。' : '保持当前信息层级。'] },
    { role: '品牌一致性评审', score: round(brandScore), findings: [`主色 RGB(${stats.dominant.join(',')}),颜色复杂度 ${stats.colorComplexity}。`], suggestions: [brandScore < 0.65 ? '收敛主辅色,强化品牌识别锚点。' : '品牌视觉风格相对稳定。'] },
    { role: '转化动线评审', score: round(conversionScore), findings: [`业务目标:${goal || '未提供'}。`], suggestions: [conversionScore < 0.65 ? '突出主行动入口并减少视觉竞争。' : '可继续验证主行动入口点击表现。'] },
  ];
};

const heuristicBrand = async (designStats: ImageStats[], referenceBuffers: Buffer[]): Promise<BrandAssociationResult> => {
  if (!referenceBuffers.length) return { status: 'insufficient_inputs', summary: '缺少品牌参考图,未执行品牌联想度。', referenceSampleCount: 0, designSampleCount: designStats.length, warnings: ['brandReferenceImages is empty'] };
  const referenceStats = await Promise.all(referenceBuffers.map(statsFor));
  const d = designStats[0], r = referenceStats[0];
  const colorSim = 1 - distance(d.dominant, r.dominant);
  const structSim = 1 - Math.abs(d.edgeDensity - r.edgeDensity);
  const satSim = 1 - Math.abs(d.saturation - r.saturation);
  const score = round(clamp(colorSim * 0.5 + structSim * 0.25 + satSim * 0.25));
  return { status: 'available', score, vectorScore: score, summary: `品牌联想度近似分 ${score}。`, referenceSampleCount: referenceBuffers.length, designSampleCount: designStats.length, warnings: ['当前为本地启发式近似,不是严格 embedding 结果。'] };
};

const analyzeVisionBrandHeuristic = async (request: VisionBrandAnalyzeRequest): Promise<VisionBrandAnalyzeResult> => {
  const designBuffers = (await Promise.all((request.designImages || []).map(resolveImageBuffer))).filter((b): b is Buffer => Boolean(b));
  if (!designBuffers.length) {
    return { status: 'insufficient_inputs', engine: 'heuristic', summary: '缺少设计图,无法执行视觉与品牌分析。', findings: [], recommendations: ['上传至少 1 张设计图。'], warnings: ['designImages is required'], boundaryNotes };
  }
  const designStats = await Promise.all(designBuffers.map(statsFor));
  const reviewers = heuristicReviewers(designStats[0], request.businessGoal);
  const referenceBuffers = (await Promise.all((request.brandReferenceImages || []).map(resolveImageBuffer))).filter((b): b is Buffer => Boolean(b));
  const brand = await heuristicBrand(designStats, referenceBuffers);
  const consensus = reviewers.filter((r) => r.score >= 0.68).map((r) => `${r.role}:${r.score}`);
  const conflicts = reviewers.filter((r) => r.score < 0.55).map((r) => `${r.role} 低于阈值,建议人工复核。`);
  const priorityActions = reviewers.flatMap((r) => r.suggestions).slice(0, 3);
  return {
    status: brand.status === 'available' ? 'available' : 'partial_failed',
    engine: 'heuristic',
    summary: `已完成 ${reviewers.length} 个视觉评审角色${brand.status === 'available' ? '和品牌联想度分析' : ',品牌联想度未执行'}(启发式降级)。`,
    visualReview: { reviewers, consensus, conflicts, priorityActions },
    brandAssociation: brand,
    findings: reviewers.flatMap((r) => r.findings),
    recommendations: priorityActions,
    warnings: brand.warnings,
    boundaryNotes,
  };
};

// ===================================================================
// 入口:LLM 可用则走真实 VLM,失败或未配置回退启发式。
// ===================================================================
export const analyzeVisionBrand = async (request: VisionBrandAnalyzeRequest): Promise<VisionBrandAnalyzeResult> => {
  if (isLLMEnabled()) {
    try {
      return await analyzeVisionBrandLLM(request);
    } catch (err) {
      const fallback = await analyzeVisionBrandHeuristic(request);
      fallback.warnings = uniqueStrings([...fallback.warnings, `VLM 评审失败,已降级启发式:${err instanceof Error ? err.message : String(err)}`]);
      return fallback;
    }
  }
  return analyzeVisionBrandHeuristic(request);
};
