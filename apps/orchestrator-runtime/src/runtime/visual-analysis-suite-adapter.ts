import { createHash } from 'node:crypto';
import {
  loadToolManifest,
  loadToolRegistry,
  type ToolManifest,
} from './config-loader.ts';
import {
  RestJsonAdapter,
  ToolInvocationError,
  throwIfToolInvocationAborted,
  type ToolAdapter,
  type ToolInvocationContext,
  type ToolInvocationReceipt,
  type ToolInvokeOptions,
  type ToolInvokeResult,
} from './tool-adapter.ts';

interface VisualImageInput {
  id?: string;
  dataUrl: string;
}

interface VisualAnalysisSuiteInput {
  research_goal?: string;
  designImages?: VisualImageInput[];
  jd_screenshots?: VisualImageInput[];
  competitor_screenshots?: VisualImageInput[];
}

interface VisualSampleInput {
  sampleId: string;
  role: 'primary' | 'comparison';
  sourceImageId: string;
  image: VisualImageInput;
}

interface LabCallRecord {
  toolId: string;
  sampleIds: string[];
  status: 'available' | 'failed';
  implementationId: string;
  executionMode: 'real' | 'fake' | 'unknown';
  endpointHost: string | null;
  latencyMs: number;
}

interface LabCallResult {
  output: Record<string, unknown> | null;
  record: LabCallRecord;
  warning?: string;
}

interface GroupResult {
  samples: Array<Record<string, unknown>>;
  batches: Array<Record<string, unknown>>;
  calls: LabCallRecord[];
  warnings: string[];
}

const BATCH_SIZE = 3;
const BOUNDARY_NOTES = [
  '视觉分析由 VLM 或启发式算法生成，不等同于真实用户研究或专业眼动实验。',
  '视觉评分只用于同批页面的辅助比较，不代表转化、销量或业务收益。',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sourceImageId(image: VisualImageInput): string {
  if (typeof image.id === 'string' && image.id.trim()) return image.id;
  return `sha256:${createHash('sha256').update(image.dataUrl).digest('hex')}`;
}

function normalizeImages(
  images: readonly VisualImageInput[],
  role: VisualSampleInput['role'],
  prefix: string,
): VisualSampleInput[] {
  return images.map((image, index) => ({
    sampleId: `${prefix}-${String(index + 1).padStart(3, '0')}`,
    role,
    sourceImageId: sourceImageId(image),
    image,
  }));
}

function normalizeAesthetic(output: Record<string, unknown> | null) {
  if (!output || output.status !== 'available') {
    return {
      status: 'failed' as const,
      summary: typeof output?.summary === 'string' ? output.summary : '美学量化不可用。',
      findings: unique(strings(output?.findings)),
      recommendations: unique(strings(output?.recommendations)),
      warnings: unique(['美学量化未返回可用结果。', ...strings(output?.warnings)]),
    };
  }
  return {
    status: 'available' as const,
    summary: typeof output.summary === 'string' ? output.summary : '美学量化已完成。',
    ...(finiteNumber(output.overallScore) === undefined ? {} : { overallScore: finiteNumber(output.overallScore) }),
    findings: unique(strings(output.findings)),
    recommendations: unique(strings(output.recommendations)),
    warnings: unique(strings(output.warnings)),
  };
}

function normalizeHotspots(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const x = finiteNumber(item.x);
    const y = finiteNumber(item.y);
    const width = finiteNumber(item.width);
    const height = finiteNumber(item.height);
    const score = finiteNumber(item.score);
    if (x === undefined || y === undefined || width === undefined || height === undefined || score === undefined) {
      return [];
    }
    return [{
      id: typeof item.id === 'string' && item.id.trim() ? item.id : `hotspot-${index + 1}`,
      x,
      y,
      width,
      height,
      score,
      reason: typeof item.reason === 'string' ? item.reason : '',
      ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label } : {}),
    }];
  });
}

function normalizeAttention(output: Record<string, unknown> | null) {
  if (!output || output.status !== 'available') {
    return {
      status: 'failed' as const,
      summary: typeof output?.summary === 'string' ? output.summary : '注意力分析不可用。',
      hotspots: [],
      warnings: unique(['注意力分析未返回可用结果。', ...strings(output?.warnings)]),
    };
  }
  return {
    status: 'available' as const,
    ...(typeof output.mode === 'string' ? { mode: output.mode } : {}),
    ...(typeof output.engine === 'string' ? { engine: output.engine } : {}),
    summary: typeof output.summary === 'string' ? output.summary : '注意力分析已完成。',
    ...(finiteNumber(output.peakAttentionScore) === undefined ? {} : { peakAttentionScore: finiteNumber(output.peakAttentionScore) }),
    ...(finiteNumber(output.focusBalanceScore) === undefined ? {} : { focusBalanceScore: finiteNumber(output.focusBalanceScore) }),
    ...(finiteNumber(output.distractionRiskScore) === undefined ? {} : { distractionRiskScore: finiteNumber(output.distractionRiskScore) }),
    hotspots: normalizeHotspots(output.hotspots),
    warnings: unique(strings(output.warnings)),
  };
}

function normalizeReviewers(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.role !== 'string') return [];
    return [{
      role: item.role,
      ...(typeof item.roleLabel === 'string' ? { roleLabel: item.roleLabel } : {}),
      ...(finiteNumber(item.score) === undefined ? {} : { score: finiteNumber(item.score) }),
      findings: unique(strings(item.findings)),
      suggestions: unique(strings(item.suggestions)),
    }];
  });
}

function labOutputAvailable(toolId: string, output: Record<string, unknown> | null): boolean {
  if (!output) return false;
  if (toolId === 'vision-brand-lab') {
    const review = isRecord(output.visualReview) ? output.visualReview : null;
    return normalizeReviewers(review?.reviewers).length > 0;
  }
  return output.status === 'available';
}

function normalizeVisualReview(
  output: Record<string, unknown> | null,
  batchId: string,
  role: VisualSampleInput['role'],
  sampleIds: string[],
) {
  const review = isRecord(output?.visualReview) ? output.visualReview : null;
  const reviewers = normalizeReviewers(review?.reviewers);
  const available = Boolean(output && reviewers.length > 0);
  const warnings = strings(output?.warnings).filter((warning) => warning !== 'brandReferenceImages is empty');
  return {
    batchId,
    role,
    sampleIds,
    status: available ? 'available' as const : 'failed' as const,
    ...(typeof output?.engine === 'string' ? { engine: output.engine } : {}),
    summary: typeof output?.summary === 'string'
      ? output.summary
      : available ? '视觉评审已完成。' : '视觉评审不可用。',
    findings: unique([
      ...strings(output?.findings),
      ...reviewers.flatMap((reviewer) => strings(reviewer.findings)),
    ]),
    recommendations: unique([
      ...strings(output?.recommendations),
      ...(review ? strings(review.priorityActions) : []),
    ]),
    reviewers,
    warnings: available
      ? warnings
      : unique(['视觉评审未返回可用结果。', ...warnings]),
  };
}

function mean(values: Array<number | undefined>): number | undefined {
  const available = values.filter((value): value is number => value !== undefined);
  if (available.length === 0) return undefined;
  return Number((available.reduce((sum, value) => sum + value, 0) / available.length).toFixed(4));
}

function comparisonFindings(samples: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const primary = samples.filter((sample) => sample.role === 'primary');
  const comparison = samples.filter((sample) => sample.role === 'comparison');
  if (primary.length === 0 || comparison.length === 0) return [];
  const metrics: Array<{
    id: string;
    label: string;
    read(sample: Record<string, unknown>): number | undefined;
  }> = [
    {
      id: 'aesthetic-overall',
      label: '美学综合分',
      read: (sample) => isRecord(sample.aesthetic) ? finiteNumber(sample.aesthetic.overallScore) : undefined,
    },
    {
      id: 'attention-focus-balance',
      label: '注意力聚焦平衡分',
      read: (sample) => isRecord(sample.attention) ? finiteNumber(sample.attention.focusBalanceScore) : undefined,
    },
    {
      id: 'attention-distraction-risk',
      label: '注意力干扰风险分',
      read: (sample) => isRecord(sample.attention) ? finiteNumber(sample.attention.distractionRiskScore) : undefined,
    },
  ];
  return metrics.flatMap((metric) => {
    const primaryValue = mean(primary.map(metric.read));
    const comparisonValue = mean(comparison.map(metric.read));
    if (primaryValue === undefined || comparisonValue === undefined) return [];
    return [{
      id: `comparison:${metric.id}`,
      dimension: metric.id,
      statement: `主方案${metric.label}均值为 ${primaryValue}，对照方案为 ${comparisonValue}。该差异只用于视觉比较，不代表业务效果。`,
      primaryValue,
      comparisonValue,
      interpretation: 'descriptive_only',
    }];
  });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export class VisualAnalysisSuiteAdapter implements ToolAdapter {
  readonly adapterType = 'visual_suite' as const;
  readonly implementationId = 'visual-analysis-suite-v1';
  readonly executionMode = 'real' as const;

  constructor(private readonly labAdapter: ToolAdapter = new RestJsonAdapter()) {}

  endpointHost(): null {
    return null;
  }

  private async callLab(input: {
    toolId: string;
    body: object;
    sampleIds: string[];
    context: ToolInvocationContext;
    attemptId?: string;
    retryOf?: string | null;
  }): Promise<LabCallResult> {
    throwIfToolInvocationAborted(input.toolId, input.context);
    const entry = loadToolRegistry().tools.find(({ id }) => id === input.toolId);
    if (!entry) throw new Error(`Visual Analysis Suite dependency ${input.toolId} is not registered`);
    const manifest = loadToolManifest(entry.path);
    try {
      const result = await this.labAdapter.invoke({
        toolId: input.toolId,
        input: input.body,
        manifest,
        context: input.context,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
      });
      const output = isRecord(result.output) ? result.output : null;
      const available = labOutputAvailable(input.toolId, output);
      return {
        output,
        ...(!available
          ? { warning: `${input.toolId}: 未返回可用分析结果` }
          : {}),
        record: {
          toolId: input.toolId,
          sampleIds: [...input.sampleIds],
          status: available ? 'available' : 'failed',
          implementationId: result.receipt.implementationId,
          executionMode: result.receipt.executionMode,
          endpointHost: result.receipt.endpointHost,
          latencyMs: result.latencyMs,
        },
      };
    } catch (error) {
      throwIfToolInvocationAborted(input.toolId, input.context);
      const warning = error instanceof ToolInvocationError
        ? `${input.toolId}: ${error.sanitizedMessage}`
        : `${input.toolId}: 调用失败`;
      return {
        output: null,
        warning,
        record: {
          toolId: input.toolId,
          sampleIds: [...input.sampleIds],
          status: 'failed',
          implementationId: error instanceof ToolInvocationError
            ? error.receipt?.implementationId ?? 'unknown'
            : 'unknown',
          executionMode: error instanceof ToolInvocationError
            ? error.receipt?.executionMode ?? 'unknown'
            : 'unknown',
          endpointHost: error instanceof ToolInvocationError
            ? error.receipt?.endpointHost ?? null
            : null,
          latencyMs: error instanceof ToolInvocationError
            ? error.receipt?.latencyMs ?? 0
            : 0,
        },
      };
    }
  }

  private async analyzeGroup(input: {
    samples: VisualSampleInput[];
    researchGoal: string;
    context: ToolInvocationContext;
    attemptId?: string;
    retryOf?: string | null;
  }): Promise<GroupResult> {
    const samples: Array<Record<string, unknown>> = [];
    const batches: Array<Record<string, unknown>> = [];
    const calls: LabCallRecord[] = [];
    const warnings: string[] = [];
    for (const [batchIndex, batch] of chunks(input.samples, BATCH_SIZE).entries()) {
      throwIfToolInvocationAborted('visual-analysis-suite', input.context);
      const visionPromise = this.callLab({
        toolId: 'vision-brand-lab',
        body: {
          designImages: batch.map(({ image }) => ({ dataUrl: image.dataUrl })),
          businessGoal: input.researchGoal,
          reviewFocus: ['视觉层级', '文字清晰度', '浏览动线', '操作体验'],
          enabledModules: { visualReview: true, brandAssociation: false },
        },
        sampleIds: batch.map(({ sampleId }) => sampleId),
        context: input.context,
        attemptId: input.attemptId,
        retryOf: input.retryOf,
      });
      const samplePromises = batch.map(async (sample) => {
        const [aesthetic, attention] = await Promise.all([
          this.callLab({
            toolId: 'aesthetic-quant-lab',
            body: {
              designImage: { dataUrl: sample.image.dataUrl },
              profileId: 'balanced',
              depth: 'standard',
              enableAttention: false,
              includeAttentionInOverallScore: false,
            },
            sampleIds: [sample.sampleId],
            context: input.context,
            attemptId: input.attemptId,
            retryOf: input.retryOf,
          }),
          this.callLab({
            toolId: 'attention-analysis-lab',
            body: {
              image: { dataUrl: sample.image.dataUrl },
              mode: 'hybrid',
              includeCenterBias: true,
            },
            sampleIds: [sample.sampleId],
            context: input.context,
            attemptId: input.attemptId,
            retryOf: input.retryOf,
          }),
        ]);
        return { sample, aesthetic, attention };
      });
      const [vision, analyzedSamples] = await Promise.all([
        visionPromise,
        Promise.all(samplePromises),
      ]);
      const batchId = `${batch[0]!.role}-batch-${String(batchIndex + 1).padStart(3, '0')}`;
      const review = normalizeVisualReview(
        vision.output,
        batchId,
        batch[0]!.role,
        batch.map(({ sampleId }) => sampleId),
      );
      batches.push(review);
      calls.push(vision.record);
      if (vision.warning) warnings.push(vision.warning);
      warnings.push(...strings(review.warnings));
      for (const analyzed of analyzedSamples) {
        const aesthetic = normalizeAesthetic(analyzed.aesthetic.output);
        const attention = normalizeAttention(analyzed.attention.output);
        samples.push({
          sampleId: analyzed.sample.sampleId,
          role: analyzed.sample.role,
          sourceImageId: analyzed.sample.sourceImageId,
          visualReviewBatchId: batchId,
          aesthetic,
          attention,
        });
        calls.push(analyzed.aesthetic.record, analyzed.attention.record);
        if (analyzed.aesthetic.warning) warnings.push(analyzed.aesthetic.warning);
        if (analyzed.attention.warning) warnings.push(analyzed.attention.warning);
        warnings.push(...strings(aesthetic.warnings), ...strings(attention.warnings));
      }
    }
    return { samples, batches, calls, warnings: unique(warnings) };
  }

  async invoke(options: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const startedAt = performance.now();
    throwIfToolInvocationAborted(options.toolId, options.context);
    if (options.toolId !== 'visual-analysis-suite' || options.manifest.adapter_type !== 'visual_suite') {
      throw new ToolInvocationError(options.toolId, {
        kind: 'capability',
        retryable: false,
        sanitizedMessage: 'adapter only supports visual-analysis-suite',
      });
    }
    const input = options.input as VisualAnalysisSuiteInput;
    const design = Array.isArray(input.designImages) ? input.designImages : [];
    const jd = Array.isArray(input.jd_screenshots) ? input.jd_screenshots : [];
    const competitor = Array.isArray(input.competitor_screenshots) ? input.competitor_screenshots : [];
    const primary = jd.length > 0
      ? normalizeImages(jd, 'primary', 'JD')
      : normalizeImages(design, 'primary', 'DESIGN');
    const comparison = normalizeImages(competitor, 'comparison', 'COMP');
    const researchGoal = typeof input.research_goal === 'string' ? input.research_goal : '';

    const groups = await Promise.all([
      this.analyzeGroup({
        samples: primary,
        researchGoal,
        context: options.context,
        attemptId: options.attemptId,
        retryOf: options.retryOf,
      }),
      this.analyzeGroup({
        samples: comparison,
        researchGoal,
        context: options.context,
        attemptId: options.attemptId,
        retryOf: options.retryOf,
      }),
    ]);
    const samples = groups.flatMap(({ samples: values }) => values);
    const visualReviewBatches = groups.flatMap(({ batches }) => batches);
    const calls = groups.flatMap(({ calls: values }) => values);
    const successfulCalls = calls.filter(({ status }) => status === 'available').length;
    const status = successfulCalls === 0
      ? 'unavailable' as const
      : successfulCalls === calls.length
        ? 'available' as const
        : 'partial' as const;
    const warnings = unique(groups.flatMap(({ warnings: values }) => values));
    if (samples.length === 0) warnings.push('没有可分析的视觉输入。');
    const latencyMs = Math.round(performance.now() - startedAt);
    const receipt: ToolInvocationReceipt = {
      declaredAdapterType: options.manifest.adapter_type,
      resolvedAdapterType: this.adapterType,
      implementationId: this.implementationId,
      executionMode: this.executionMode,
      endpointHost: null,
      status: 'ok',
      latencyMs,
      runtimeVersions: {
        'aesthetic-quant-lab': 'output-v1',
        'attention-analysis-lab': 'output-v1',
        'vision-brand-lab': 'output-v1',
      },
    };
    return {
      output: {
        version: 'visual-analysis-suite-v1',
        status,
        samples,
        visualReviewBatches,
        comparisonFindings: comparisonFindings(samples),
        warnings,
        boundaryNotes: [...BOUNDARY_NOTES],
        toolProvenance: calls,
      },
      latencyMs,
      receipt,
    };
  }
}
