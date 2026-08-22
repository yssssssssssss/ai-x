import type { ResearchPlanPayload } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ReportSection } from './report-document-composer.ts';

export const RESEARCH_PLAN_REQUIRED_POINTERS = [
  '/title',
  '/researchGoal',
  '/scope',
  '/competitorSampling',
  '/researchQuestions',
  '/comparisonDimensions',
  '/sourcePlan',
  '/executionPlan',
  '/collectionTemplate',
  '/analysisMethods',
  '/deliverables',
  '/qualityChecks',
] as const;

export interface ReportProjectionCoverage {
  sourceDeliverableArtifactId: string;
  projectionMode: 'full' | 'summary';
  coveredPointers: string[];
  omittedPointers: Array<{ pointer: string; reason: string }>;
}

export interface ReportProjectionResult {
  sections: ReportSection[];
  coverage: ReportProjectionCoverage;
}

export function assertProjectionCoverage(
  requiredPointers: readonly string[],
  coverage: ReportProjectionCoverage,
): void {
  const covered = new Set(coverage.coveredPointers);
  const omitted = new Map(coverage.omittedPointers.map((item) => [item.pointer, item.reason]));
  if (covered.size !== coverage.coveredPointers.length) throw new Error('report projection has duplicate covered pointers');
  if (omitted.size !== coverage.omittedPointers.length) throw new Error('report projection has duplicate omitted pointers');
  for (const pointer of requiredPointers) {
    if (covered.has(pointer)) continue;
    if (coverage.projectionMode === 'summary' && omitted.get(pointer)?.trim()) continue;
    throw new Error(`report projection does not cover required payload pointer ${pointer}`);
  }
}

function list(id: string, items: string[], sourcePointers: string[]): ReportSection['blocks'][number] {
  if (items.length === 0) throw new Error(`report projection list ${id} must not be empty`);
  return { id, type: 'list', items, sourcePointers, summary: false };
}

export function projectResearchPlan(input: {
  payload: ResearchPlanPayload;
  deliverableArtifactId: string;
}): ReportProjectionResult {
  const { payload } = input;
  const sections: ReportSection[] = [
    {
      id: 'plan-definition',
      title: '方案定义 / Plan Definition',
      questionIds: [],
      blocks: [list('plan-definition-list', [
        `标题：${payload.title}`,
        `研究目标：${payload.researchGoal}`,
        `范围：${payload.scope.market}；${payload.scope.subjects.join('、')}；${payload.scope.timeWindow}`,
        `抽样：${payload.competitorSampling.strategy}；目标 ${payload.competitorSampling.targetCount}；准入 ${payload.competitorSampling.inclusionCriteria.join('、')}；排除 ${payload.competitorSampling.exclusionCriteria.join('、')}`,
      ], ['/title', '/researchGoal', '/scope', '/competitorSampling'])],
    },
    {
      id: 'research-questions',
      title: '研究问题 / Research Questions',
      questionIds: [],
      blocks: [list('research-question-list', payload.researchQuestions, ['/researchQuestions'])],
    },
    {
      id: 'comparison-framework',
      title: '比较框架 / Comparison Framework',
      questionIds: [],
      blocks: [list('comparison-dimension-list', payload.comparisonDimensions.map((dimension) => (
        `${dimension.name}：${dimension.purpose}；采集字段：${dimension.collectionFields.join('、')}`
      )), ['/comparisonDimensions'])],
    },
    {
      id: 'evidence-plan',
      title: '证据计划 / Evidence Plan',
      questionIds: [],
      blocks: [list('source-plan-list', payload.sourcePlan.map((source) => (
        `${source.evidenceClass}：${source.sourceTypes.join('、')}；${source.purpose}`
      )), ['/sourcePlan'])],
    },
    {
      id: 'execution-roadmap',
      title: '执行路线 / Execution Roadmap',
      questionIds: [],
      blocks: [list('execution-plan-list', payload.executionPlan.map((phase) => (
        `${phase.phase}（${phase.duration}）：${phase.activities.join('；')}；产出：${phase.outputs.join('；')}`
      )), ['/executionPlan'])],
    },
    {
      id: 'collection-template',
      title: '采集模板 / Collection Template',
      questionIds: [],
      blocks: [list('collection-template-list', payload.collectionTemplate.map((field) => (
        `${field.field}：${field.description}（${field.evidenceRequired ? '需要证据' : '无需证据'}）`
      )), ['/collectionTemplate'])],
    },
    {
      id: 'analysis-methods',
      title: '分析方法 / Analysis Methods',
      questionIds: [],
      blocks: [list('analysis-method-list', payload.analysisMethods, ['/analysisMethods'])],
    },
    {
      id: 'deliverables',
      title: '交付物 / Deliverables',
      questionIds: [],
      blocks: [list('deliverable-list', payload.deliverables, ['/deliverables'])],
    },
    {
      id: 'quality-assurance',
      title: '质量保障 / Quality Assurance',
      questionIds: [],
      blocks: [list('quality-check-list', payload.qualityChecks, ['/qualityChecks'])],
    },
  ];
  const projectedPointers = [...new Set(sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
    block.type === 'list' ? block.sourcePointers ?? [] : []
  ))))];
  const coverage: ReportProjectionCoverage = {
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full',
    coveredPointers: projectedPointers,
    omittedPointers: [],
  };
  assertProjectionCoverage(RESEARCH_PLAN_REQUIRED_POINTERS, coverage);
  return { sections, coverage };
}
