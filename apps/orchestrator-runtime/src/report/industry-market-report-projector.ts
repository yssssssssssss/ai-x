import type { IndustryMarketAnalysisPayloadV1 } from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReportDocument,
  ReportProjectionListBlock,
  ReportSection,
} from './report-document-composer.ts';
import { assertProjectionCoverage } from './report-projection.ts';

const LABELS: Readonly<Record<string, string>> = {
  schemaVersion: 'Schema 版本',
  title: '标题',
  scope: '范围',
  coverageLedger: '十维覆盖',
  marketLandscape: '市场格局',
  audienceSegments: '用户分层',
  supplyLandscape: '供给结构',
  competitorAnalysis: '竞品分析',
  jdDiagnosis: '京东诊断',
  validatedFindings: '已验证发现',
  gapMatrix: 'Gap 矩阵',
  positioning: '差异化定位',
  opportunities: '机会清单',
  strategyChains: '策略纵深链',
  designLanguage: '设计语言',
  categoryAssets: '品类差异资产',
  measurementPlan: '指标与验证',
  dataGaps: '数据缺口',
};

function displayScalar(value: string | number | boolean | null): string {
  if (value === null) return '待补';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function leafLines(value: unknown, path = ''): string[] {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [`${path || '值'}：${displayScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path || '列表'}：[]`];
    return value.flatMap((item, index) => leafLines(item, `${path}[${index + 1}]`));
  }
  if (typeof value !== 'object') return [`${path || '值'}：${String(value)}`];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [`${path || '对象'}：{}`];
  return entries.flatMap(([key, child]) => leafLines(child, path ? `${path}.${key}` : key));
}

function projectionBlock(
  id: string,
  payload: IndustryMarketAnalysisPayloadV1,
  keys: readonly (keyof IndustryMarketAnalysisPayloadV1)[],
): ReportProjectionListBlock {
  const items = keys.flatMap((key) => leafLines(payload[key], LABELS[String(key)] ?? String(key)));
  return {
    id,
    type: 'projection-list',
    items: items.length > 0 ? items : ['暂无内容'],
    sourcePointers: keys.map((key) => `/${String(key)}`),
    summary: false,
  };
}

export function projectIndustryMarketReport(input: {
  payload: IndustryMarketAnalysisPayloadV1;
  deliverableArtifactId: string;
  requiredQuestionIds: readonly string[];
  requiredPointers: readonly string[];
}): { document: ReportDocument } {
  const groups: Array<{
    id: string;
    title: string;
    keys: readonly (keyof IndustryMarketAnalysisPayloadV1)[];
  }> = [
    { id: 'cover', title: '封面 / Cover', keys: ['schemaVersion', 'title'] },
    { id: 'executive-summary', title: '决策摘要 / Executive Summary', keys: ['positioning'] },
    { id: 'background', title: '范围 / Scope', keys: ['scope'] },
    { id: 'scope-method', title: '十维覆盖与资料边界 / Coverage and Inputs', keys: ['coverageLedger'] },
    { id: 'key-metrics', title: '行业与经营指标 / Market and Business Metrics', keys: ['marketLandscape'] },
    { id: 'findings', title: '用户与供给洞察 / Audience and Supply', keys: ['audienceSegments', 'supplyLandscape'] },
    { id: 'question-analysis', title: '京东体验诊断 / JD Experience Diagnosis', keys: ['jdDiagnosis', 'validatedFindings'] },
    { id: 'visual-evidence', title: '竞品与视觉证据 / Competitive Visual Evidence', keys: ['competitorAnalysis'] },
    { id: 'comparison', title: 'Gap 对照 / Gap Comparison', keys: ['gapMatrix'] },
    { id: 'conclusion', title: '机会结论 / Opportunity Conclusions', keys: ['opportunities'] },
    { id: 'recommendations', title: '策略纵深链 / Strategy Chains', keys: ['strategyChains'] },
    { id: 'risks', title: '数据缺口与风险 / Data Gaps and Risks', keys: ['dataGaps'] },
    { id: 'appendix', title: '设计资产、指标与附录 / Assets, Measurement and Appendix', keys: ['designLanguage', 'categoryAssets', 'measurementPlan'] },
  ];
  const sections: ReportSection[] = groups.map(({ id, title, keys }) => ({
    id,
    title,
    questionIds: [...input.requiredQuestionIds],
    blocks: [projectionBlock(`${id}-content`, input.payload, keys)],
  }));
  const coveredPointers = sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
    block.type === 'projection-list' ? block.sourcePointers : []
  )));
  const coverage = {
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full' as const,
    coveredPointers,
    omittedPointers: [],
  };
  assertProjectionCoverage(input.requiredPointers, coverage);
  return {
    document: {
      version: 'report-document-v2',
      title: input.payload.title,
      subtitle: '行业、用户、竞品、体验与设计策略 / Industry Market Analysis',
      executiveSummary: input.payload.positioning.statement,
      sections,
      ...coverage,
    },
  };
}
