import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResearchPlanPayload } from '../../../../packages/api-contract/research-deliverable.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';
import type {
  ReportDocument,
  ReportProjectionListBlock,
  ReportSection,
} from './report-document-composer.ts';

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

export function requiredPayloadPointers(payloadSchema: unknown): string[] {
  if (payloadSchema === null || typeof payloadSchema !== 'object' || Array.isArray(payloadSchema)) {
    throw new Error('Deliverable payload schema must be an object');
  }
  const required = (payloadSchema as Record<string, unknown>).required;
  if (!Array.isArray(required) || !required.every((field: unknown) => typeof field === 'string')) {
    throw new Error('Deliverable payload schema must declare required properties');
  }
  return (required as string[]).map((field) => `/${field}`);
}

export function researchPlanRequiredPointers(): string[] {
  const schema = JSON.parse(readFileSync(
    join(getConfigRoot(), 'schemas/deliverables/research-plan.schema.json'),
    'utf8',
  )) as unknown;
  return requiredPayloadPointers(schema);
}

export function assertProjectionCoverage(
  requiredPointers: readonly string[],
  coverage: ReportProjectionCoverage,
): void {
  const covered = new Set(coverage.coveredPointers);
  const omitted = new Map(coverage.omittedPointers.map((item) => [item.pointer, item.reason]));
  if (covered.size !== coverage.coveredPointers.length) throw new Error('report projection has duplicate covered pointers');
  if (omitted.size !== coverage.omittedPointers.length) throw new Error('report projection has duplicate omitted pointers');
  const required = new Set(requiredPointers);
  for (const pointer of covered) {
    if (!required.has(pointer)) throw new Error(`report projection covers unknown payload pointer ${pointer}`);
  }
  for (const [pointer, reason] of omitted) {
    if (!required.has(pointer)) throw new Error(`report projection omits unknown payload pointer ${pointer}`);
    if (!reason.trim()) throw new Error(`report projection omission ${pointer} has no reason`);
    if (covered.has(pointer)) throw new Error(`report projection both covers and omits ${pointer}`);
  }
  for (const pointer of requiredPointers) {
    if (covered.has(pointer)) continue;
    if (coverage.projectionMode === 'summary' && omitted.get(pointer)?.trim()) continue;
    throw new Error(`report projection does not cover required payload pointer ${pointer}`);
  }
}

function pointerValue(root: unknown, pointer: string): unknown {
  let current = root;
  for (const rawSegment of pointer.slice(1).split('/')) {
    if (current === null || typeof current !== 'object') return undefined;
    const segment = rawSegment.replace(/~1/gu, '/').replace(/~0/gu, '~');
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function assertReportProjectionIntegrity(input: {
  document: ReportDocument;
  deliverableArtifactId: string;
  payload: unknown;
  requiredPointers?: readonly string[];
}): void {
  if (input.document.version !== 'report-document-v2') return;
  if (input.document.sourceDeliverableArtifactId !== input.deliverableArtifactId) {
    throw new Error('report projection source Deliverable Artifact identity mismatch');
  }
  const requiredPointers = input.requiredPointers ?? researchPlanRequiredPointers();
  const projectionPointers = input.document.sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
    block.type === 'projection-list' ? block.sourcePointers : []
  )));
  if (new Set(projectionPointers).size !== projectionPointers.length) {
    throw new Error('report projection source pointers must be uniquely owned by projection blocks');
  }
  const blockPointers = input.document.sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
    block.type === 'projection-list' || block.type === 'answer' ? block.sourcePointers : []
  )));
  const uniqueBlockPointers = [...new Set(blockPointers)];
  if (JSON.stringify(uniqueBlockPointers) !== JSON.stringify(input.document.coveredPointers ?? [])) {
    throw new Error('report projection coveredPointers do not match projection block provenance');
  }
  for (const pointer of blockPointers) {
    if (pointerValue(input.payload, pointer) === undefined) {
      throw new Error(`report projection pointer does not exist in source Deliverable: ${pointer}`);
    }
  }
  const coverage: ReportProjectionCoverage = {
    sourceDeliverableArtifactId: input.document.sourceDeliverableArtifactId,
    projectionMode: input.document.projectionMode ?? 'full',
    coveredPointers: input.document.coveredPointers ?? [],
    omittedPointers: input.document.omittedPointers ?? [],
  };
  if (coverage.projectionMode === 'full' && coverage.omittedPointers.length > 0) {
    throw new Error('full report projection must not omit required payload pointers');
  }
  assertProjectionCoverage(requiredPointers, coverage);
}

function list(id: string, items: string[], sourcePointers: string[]): ReportProjectionListBlock {
  if (items.length === 0) throw new Error(`report projection list ${id} must not be empty`);
  return { id, type: 'projection-list', items, sourcePointers, summary: false };
}

export function projectResearchPlan(input: {
  payload: ResearchPlanPayload;
  deliverableArtifactId: string;
  requiredPointers?: readonly string[];
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
    block.type === 'projection-list' ? block.sourcePointers : []
  ))))];
  const coverage: ReportProjectionCoverage = {
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full',
    coveredPointers: projectedPointers,
    omittedPointers: [],
  };
  assertProjectionCoverage(input.requiredPointers ?? researchPlanRequiredPointers(), coverage);
  return { sections, coverage };
}
