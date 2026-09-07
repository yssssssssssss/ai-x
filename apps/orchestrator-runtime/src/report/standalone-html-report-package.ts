import { strToU8, zipSync } from 'fflate';
import { basename } from 'node:path';
import type { ControlArtifact } from '../../../../database/control-plane.ts';
import type { ReportReviewArtifact } from '../../../../packages/api-contract/control-workflow.ts';
import {
  isReportDocumentV3,
  isReportDocumentV4,
  type ReportNoticeV1,
  type ReportBlockV3,
  type ReportBlockV4,
  type ReportDocumentV3,
  type ReportDocumentV4,
} from '../../../../packages/api-contract/report-document.ts';
import {
  parseReportPackageV2,
  type ReportPackageV2,
} from '../../../../packages/api-contract/report-package.ts';
import type {
  EvidenceEntry,
  EvidenceManifest,
  IndustryMarketAnalysisPayloadV1,
  ResearchDeliverableEnvelope,
  ResearchStrategyReportPayloadV2,
} from '../../../../packages/api-contract/research-deliverable.ts';

type ExportablePayload = ResearchStrategyReportPayloadV2 | IndustryMarketAnalysisPayloadV1;
type ExportableDeliverable = ResearchDeliverableEnvelope<ExportablePayload>;
import {
  safeReportDocumentV3,
  safeReportDocumentV4,
  safeReportReview,
} from '../../../../packages/report-rendering/report-export-projection.ts';
import {
  createReportRenderManifestV1,
  createReportRenderManifestV2,
} from '../../../../packages/report-rendering/report-render-manifest.ts';
import {
  visitReportDocumentV3,
  visitReportDocumentV4,
} from '../../../../packages/report-rendering/report-document-visitor.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type ResolvedEvidenceArtifact,
} from '../evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../evidence/report-evidence-validator.ts';
import { SchemaValidator } from '../schema/validator.ts';
import type { ReportPackageV2ArtifactService } from './report-package-v2-artifact.ts';
import { assertValidReportReviewArtifact } from './report-review-service.ts';

const ZIP_TIMESTAMP = new Date('1980-01-01T00:00:00.000Z');
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9._-]+$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SIDECAR_SCHEMAS = new SchemaValidator();
const SIDECAR_EVIDENCE = new EvidenceService();
const SIDECAR_REPORTS: ReportEvidenceValidator = new ReportEvidenceValidator(
  SIDECAR_EVIDENCE,
  SIDECAR_SCHEMAS,
);

type StandaloneBundleArtifactReader = Pick<
  ControlArtifactStore,
  'readVerifiedBoundJson' | 'readVerifiedBoundText' | 'readVerifiedBinary'
>;

type ReportPackageV2Verifier = Pick<ReportPackageV2ArtifactService, 'verify'>;

export class HtmlBundleUnavailableError extends Error {
  readonly code = 'html_bundle_unavailable';

  constructor() {
    super('standalone HTML bundle is unavailable');
    this.name = 'HtmlBundleUnavailableError';
  }
}

export class HtmlBundleIntegrityError extends Error {
  readonly code = 'html_bundle_integrity_error';

  constructor(cause?: unknown) {
    super('standalone HTML bundle failed integrity verification', { cause });
    this.name = 'HtmlBundleIntegrityError';
  }
}

export interface StandaloneHtmlBundleInput {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPackageArtifactId: string;
}

function assertArtifactBinding(input: {
  artifact: ControlArtifact;
  artifactId: string;
  kind: string;
  schemaVersion?: string | readonly string[];
  binding: Pick<StandaloneHtmlBundleInput, 'taskId' | 'planVersionId' | 'attemptId'>;
}): void {
  const { artifact, binding } = input;
  if (
    artifact.id !== input.artifactId
    || artifact.state !== 'SEALED'
    || artifact.contentSha256 === null
    || artifact.byteSize === null
    || artifact.kind !== input.kind
    || (input.schemaVersion !== undefined && (
      Array.isArray(input.schemaVersion)
        ? !input.schemaVersion.includes(artifact.schemaVersion)
        : artifact.schemaVersion !== input.schemaVersion
    ))
    || artifact.taskId !== binding.taskId
    || artifact.planVersionId !== binding.planVersionId
    || artifact.attemptId !== binding.attemptId
  ) {
    throw new Error(`standalone HTML bundle ${input.kind} Artifact binding is invalid`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = 'value',
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

function nonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is invalid`);
}

function strings(value: unknown, label: string): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} is invalid`);
  }
  return true;
}

function assertValueBinding(
  value: Record<string, unknown>,
  binding: Pick<StandaloneHtmlBundleInput, 'taskId' | 'planVersionId' | 'attemptId'>,
  label: string,
): void {
  if (
    value.taskId !== binding.taskId
    || value.planVersionId !== binding.planVersionId
    || value.attemptId !== binding.attemptId
  ) throw new Error(`${label} value binding is invalid`);
}

function parseEvidenceManifest(
  value: unknown,
  binding: Pick<StandaloneHtmlBundleInput, 'taskId' | 'planVersionId' | 'attemptId'>,
): EvidenceManifest {
  const manifest = object(value, 'Evidence Manifest');
  assertExactKeys(manifest, [
    'version', 'taskId', 'planVersionId', 'attemptId', 'collectedAt', 'manifestHash', 'entries',
  ], [], 'Evidence Manifest');
  if (manifest.version !== 'evidence-v1') throw new Error('Evidence Manifest version is invalid');
  assertValueBinding(manifest, binding, 'Evidence Manifest');
  nonBlank(manifest.collectedAt, 'Evidence Manifest collectedAt');
  if (Number.isNaN(Date.parse(manifest.collectedAt))) {
    throw new Error('Evidence Manifest collectedAt is invalid');
  }
  if (typeof manifest.manifestHash !== 'string' || !SHA256.test(manifest.manifestHash)) {
    throw new Error('Evidence Manifest manifestHash is invalid');
  }
  if (!Array.isArray(manifest.entries)) throw new Error('Evidence Manifest entries are invalid');
  for (const [index, entryValue] of manifest.entries.entries()) {
    const label = `Evidence Manifest entry ${index}`;
    const entry = object(entryValue, label);
    assertExactKeys(entry, [
      'id', 'kind', 'evidenceClass', 'artifactId', 'artifactContentSha256', 'jsonPointer',
      'sensitivity', 'redaction',
    ], ['toolId', 'toolTier', 'sourceUrl', 'stepNo', 'toolProof'], label);
    nonBlank(entry.id, `${label}.id`);
    nonBlank(entry.artifactId, `${label}.artifactId`);
    if (
      typeof entry.artifactContentSha256 !== 'string'
      || !SHA256.test(entry.artifactContentSha256)
    ) throw new Error(`${label}.artifactContentSha256 is invalid`);
    if (typeof entry.jsonPointer !== 'string' || !entry.jsonPointer.startsWith('/')) {
      throw new Error(`${label}.jsonPointer is invalid`);
    }
    if (!['tool_output', 'knowledge_excerpt', 'user_constraint', 'screenshot'].includes(String(entry.kind))) {
      throw new Error(`${label}.kind is invalid`);
    }
    if (![
      'public_source', 'screenshot', 'user_input', 'knowledge', 'dataset', 'simulation', 'derived',
    ].includes(String(entry.evidenceClass))) throw new Error(`${label}.evidenceClass is invalid`);
    if (!['public', 'internal', 'sensitive'].includes(String(entry.sensitivity))) {
      throw new Error(`${label}.sensitivity is invalid`);
    }
    if (!['none', 'masked', 'blocked'].includes(String(entry.redaction))) {
      throw new Error(`${label}.redaction is invalid`);
    }
    if (entry.toolId !== undefined) nonBlank(entry.toolId, `${label}.toolId`);
    if (entry.toolTier !== undefined && entry.toolTier !== 'core' && entry.toolTier !== 'optional') {
      throw new Error(`${label}.toolTier is invalid`);
    }
    if (entry.sourceUrl !== undefined) nonBlank(entry.sourceUrl, `${label}.sourceUrl`);
    if (entry.stepNo !== undefined && (!Number.isSafeInteger(entry.stepNo) || Number(entry.stepNo) < 1)) {
      throw new Error(`${label}.stepNo is invalid`);
    }
    if (entry.toolProof !== undefined) {
      const proof = object(entry.toolProof, `${label}.toolProof`);
      assertExactKeys(
        proof,
        ['implementationId', 'executionMode', 'redactedOutputHash'],
        [],
        `${label}.toolProof`,
      );
      nonBlank(proof.implementationId, `${label}.toolProof.implementationId`);
      if (proof.executionMode !== 'real') throw new Error(`${label}.toolProof.executionMode is invalid`);
      if (typeof proof.redactedOutputHash !== 'string' || !SHA256.test(proof.redactedOutputHash)) {
        throw new Error(`${label}.toolProof.redactedOutputHash is invalid`);
      }
    }
  }
  return manifest as unknown as EvidenceManifest;
}

function assertExactDeliverableShape(deliverable: Record<string, unknown>): void {
  assertExactKeys(deliverable, [
    'version', 'taskId', 'planVersionId', 'attemptId', 'deliverableType',
    'evidenceManifestArtifactId', 'methodSummary', 'findingGraph', 'payload',
    'recommendations', 'coverage', 'risksAndOpenIssues', 'capabilityProvenance',
  ], [], 'Deliverable');
  const graph = object(deliverable.findingGraph, 'Deliverable findingGraph');
  assertExactKeys(
    graph,
    ['findings', 'analyses', 'subQuestionSummaries', 'overallConclusions'],
    [],
    'Deliverable findingGraph',
  );
  if (!Array.isArray(graph.findings)) throw new Error('Deliverable findings are invalid');
  for (const [index, value] of graph.findings.entries()) {
    const finding = object(value, `Deliverable finding ${index}`);
    if (finding.kind === 'fact') {
      assertExactKeys(finding, ['id', 'kind', 'evidenceIds', 'statement'], [], `Deliverable finding ${index}`);
    } else if (finding.kind === 'inference') {
      assertExactKeys(finding, ['id', 'kind', 'findingIds', 'statement'], [], `Deliverable finding ${index}`);
    } else {
      throw new Error(`Deliverable finding ${index}.kind is invalid`);
    }
  }
  for (const [field, keys] of [
    ['analyses', ['id', 'findingIds', 'statement']],
    ['subQuestionSummaries', ['id', 'findingIds', 'analysisIds', 'summary']],
    ['overallConclusions', ['id', 'summaryIds', 'statement']],
  ] as const) {
    const values = graph[field];
    if (!Array.isArray(values)) throw new Error(`Deliverable ${field} is invalid`);
    values.forEach((value, index) => assertExactKeys(
      object(value, `Deliverable ${field} ${index}`),
      keys,
      [],
      `Deliverable ${field} ${index}`,
    ));
  }
  if (!Array.isArray(deliverable.recommendations)) throw new Error('Deliverable recommendations are invalid');
  deliverable.recommendations.forEach((value, index) => assertExactKeys(
    object(value, `Deliverable recommendation ${index}`),
    ['id', 'summaryIds', 'statement'],
    [],
    `Deliverable recommendation ${index}`,
  ));
  const coverage = object(deliverable.coverage, 'Deliverable coverage');
  assertExactKeys(coverage, ['questionBindings', 'successCriterionBindings'], [], 'Deliverable coverage');
  if (!Array.isArray(coverage.questionBindings) || !Array.isArray(coverage.successCriterionBindings)) {
    throw new Error('Deliverable coverage bindings are invalid');
  }
  coverage.questionBindings.forEach((value, index) => assertExactKeys(
    object(value, `Deliverable question binding ${index}`),
    ['questionId', 'summaryIds'],
    [],
    `Deliverable question binding ${index}`,
  ));
  coverage.successCriterionBindings.forEach((value, index) => assertExactKeys(
    object(value, `Deliverable success criterion binding ${index}`),
    ['successCriterionId', 'conclusionIds', 'recommendationIds'],
    [],
    `Deliverable success criterion binding ${index}`,
  ));
  if (!Array.isArray(deliverable.capabilityProvenance)) {
    throw new Error('Deliverable capabilityProvenance is invalid');
  }
  deliverable.capabilityProvenance.forEach((value, index) => assertExactKeys(
    object(value, `Deliverable capability provenance ${index}`),
    ['id', 'type'],
    [],
    `Deliverable capability provenance ${index}`,
  ));
  strings(deliverable.risksAndOpenIssues, 'Deliverable risksAndOpenIssues');
}

function parseExportableDeliverable(
  value: unknown,
  binding: Pick<StandaloneHtmlBundleInput, 'taskId' | 'planVersionId' | 'attemptId'>,
  evidenceManifestArtifactId: string,
): ExportableDeliverable {
  const deliverable = object(value, 'Deliverable');
  assertExactDeliverableShape(deliverable);
  assertValueBinding(deliverable, binding, 'Deliverable');
  if (
    deliverable.version !== 'research-deliverable-v1'
    || deliverable.evidenceManifestArtifactId !== evidenceManifestArtifactId
  ) throw new Error('Deliverable is not a supported reviewed envelope');
  const payload = object(deliverable.payload, 'Deliverable payload');
  if (
    deliverable.deliverableType === 'research_strategy_report'
    && payload.schemaVersion === 'research-strategy-content-v2'
  ) {
    SIDECAR_SCHEMAS.validateFileOrThrow(
      'schemas/deliverables/research-strategy-report-v2.schema.json',
      deliverable.payload,
    );
  } else if (
    deliverable.deliverableType === 'industry_market_analysis_report'
    && payload.schemaVersion === 'industry-market-analysis-v1'
  ) {
    SIDECAR_SCHEMAS.validateFileOrThrow(
      'schemas/deliverables/industry-market-analysis-report.schema.json',
      deliverable.payload,
    );
  } else {
    throw new Error('Deliverable payload is not a supported reviewed report payload');
  }
  return deliverable as unknown as ExportableDeliverable;
}

function safeDeliverable(
  deliverable: ExportableDeliverable,
): Record<string, unknown> {
  return {
    version: deliverable.version,
    taskId: deliverable.taskId,
    planVersionId: deliverable.planVersionId,
    attemptId: deliverable.attemptId,
    deliverableType: deliverable.deliverableType,
    evidenceManifestArtifactId: deliverable.evidenceManifestArtifactId,
    methodSummary: deliverable.methodSummary,
    findingGraph: {
      findings: deliverable.findingGraph.findings.map((finding) => finding.kind === 'fact'
        ? { id: finding.id, kind: finding.kind, evidenceIds: finding.evidenceIds, statement: finding.statement }
        : { id: finding.id, kind: finding.kind, findingIds: finding.findingIds, statement: finding.statement }),
      analyses: deliverable.findingGraph.analyses.map((analysis) => ({
        id: analysis.id,
        findingIds: analysis.findingIds,
        statement: analysis.statement,
      })),
      subQuestionSummaries: deliverable.findingGraph.subQuestionSummaries.map((summary) => ({
        id: summary.id,
        findingIds: summary.findingIds,
        analysisIds: summary.analysisIds,
        summary: summary.summary,
      })),
      overallConclusions: deliverable.findingGraph.overallConclusions.map((conclusion) => ({
        id: conclusion.id,
        summaryIds: conclusion.summaryIds,
        statement: conclusion.statement,
      })),
    },
    payload: deliverable.payload,
    recommendations: deliverable.recommendations.map((recommendation) => ({
      id: recommendation.id,
      summaryIds: recommendation.summaryIds,
      statement: recommendation.statement,
    })),
    coverage: {
      questionBindings: deliverable.coverage.questionBindings.map((binding) => ({
        questionId: binding.questionId,
        summaryIds: binding.summaryIds,
      })),
      successCriterionBindings: deliverable.coverage.successCriterionBindings.map((binding) => ({
        successCriterionId: binding.successCriterionId,
        conclusionIds: binding.conclusionIds,
        recommendationIds: binding.recommendationIds,
      })),
    },
    risksAndOpenIssues: deliverable.risksAndOpenIssues,
    capabilityProvenance: deliverable.capabilityProvenance.map((provenance) => ({
      id: provenance.id,
      type: provenance.type,
    })),
  };
}

function safeEvidenceManifest(manifest: EvidenceManifest): Record<string, unknown> {
  return {
    version: manifest.version,
    taskId: manifest.taskId,
    planVersionId: manifest.planVersionId,
    attemptId: manifest.attemptId,
    collectedAt: manifest.collectedAt,
    entries: manifest.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      evidenceClass: entry.evidenceClass,
      sensitivity: entry.sensitivity,
      redaction: entry.redaction,
    })),
  };
}

function parseFinalReportReview(
  value: unknown,
  binding: Pick<StandaloneHtmlBundleInput, 'taskId' | 'planVersionId' | 'attemptId'>,
  deliverableArtifactId: string,
): ReportReviewArtifact & { version: 'report-review-v2' | 'report-review-v3'; verdict: 'pass' } {
  assertValidReportReviewArtifact(value, SIDECAR_SCHEMAS);
  const review = value as ReportReviewArtifact;
  assertValueBinding(review as unknown as Record<string, unknown>, binding, 'Report Review');
  if (
    (review.version !== 'report-review-v2' && review.version !== 'report-review-v3')
    || review.verdict !== 'pass'
    || review.deliverableArtifactId !== deliverableArtifactId
  ) throw new Error('Report Review is not a final passing v2 or v3 Review');
  return review as ReportReviewArtifact & { version: 'report-review-v2' | 'report-review-v3'; verdict: 'pass' };
}

function evidenceArtifactKind(entry: EvidenceEntry): string {
  switch (entry.kind) {
    case 'tool_output': return 'tool_output';
    case 'knowledge_excerpt': return entry.toolId === 'joyspace-read'
      ? 'knowledge_snapshot'
      : 'knowledge_output';
    case 'screenshot': return 'visual_asset_manifest';
    case 'user_constraint': return 'chart_data';
    case 'dataset': return 'dataset_input_profile';
  }
}

async function readValidatedEvidenceSidecar(input: {
  artifacts: StandaloneBundleArtifactReader;
  reportPackage: ReportPackageV2;
  binding: StandaloneHtmlBundleInput;
}): Promise<{ manifest: EvidenceManifest; resolver: EvidenceArtifactResolver }> {
  const result = await input.artifacts.readVerifiedBoundJson<unknown>(
    input.reportPackage.evidenceManifestArtifactId,
  );
  assertArtifactBinding({
    artifact: result.artifact,
    artifactId: input.reportPackage.evidenceManifestArtifactId,
    kind: 'evidence_manifest',
    schemaVersion: 'evidence-v1',
    binding: input.binding,
  });
  const manifest = parseEvidenceManifest(result.value, input.binding);
  const resolved = new Map<string, ResolvedEvidenceArtifact>();
  for (const entry of manifest.entries) {
    const evidence = await input.artifacts.readVerifiedBoundJson<unknown>(entry.artifactId);
    assertArtifactBinding({
      artifact: evidence.artifact,
      artifactId: entry.artifactId,
      kind: evidenceArtifactKind(entry),
      binding: input.binding,
    });
    if (evidence.artifact.contentSha256 !== entry.artifactContentSha256) {
      throw new Error(`Evidence ${entry.id} Artifact hash is invalid`);
    }
    resolved.set(entry.artifactId, {
      artifact: {
        id: evidence.artifact.id,
        contentSha256: evidence.artifact.contentSha256,
      },
      value: evidence.value,
    });
  }
  const resolver: EvidenceArtifactResolver = {
    resolveArtifact: (artifactId) => resolved.get(artifactId) ?? null,
  };
  SIDECAR_EVIDENCE.validateManifest(manifest, resolver);
  return { manifest, resolver };
}

async function readValidatedDeliverableSidecar(input: {
  artifacts: StandaloneBundleArtifactReader;
  reportPackage: ReportPackageV2;
  binding: StandaloneHtmlBundleInput;
  evidence: { manifest: EvidenceManifest; resolver: EvidenceArtifactResolver };
}): Promise<ExportableDeliverable> {
  const result = await input.artifacts.readVerifiedBoundJson<unknown>(
    input.reportPackage.deliverableArtifactId,
  );
  assertArtifactBinding({
    artifact: result.artifact,
    artifactId: input.reportPackage.deliverableArtifactId,
    kind: 'deliverable',
    schemaVersion: 'research-deliverable-v1-review-gated',
    binding: input.binding,
  });
  const deliverable = parseExportableDeliverable(
    result.value,
    input.binding,
    input.reportPackage.evidenceManifestArtifactId,
  );
  SIDECAR_REPORTS.validate({
    manifest: input.evidence.manifest,
    report: deliverable,
    resolver: input.evidence.resolver,
    requireCoverage: true,
    validatePayloadSchema: true,
  });
  return deliverable;
}

async function readValidatedReviewSidecar(input: {
  artifacts: StandaloneBundleArtifactReader;
  reportPackage: ReportPackageV2;
  binding: StandaloneHtmlBundleInput;
}): Promise<ReportReviewArtifact & { version: 'report-review-v2' | 'report-review-v3'; verdict: 'pass' }> {
  const result = await input.artifacts.readVerifiedBoundJson<unknown>(
    input.reportPackage.reportReviewArtifactId,
  );
  const review = parseFinalReportReview(
    result.value,
    input.binding,
    input.reportPackage.deliverableArtifactId,
  );
  assertArtifactBinding({
    artifact: result.artifact,
    artifactId: input.reportPackage.reportReviewArtifactId,
    kind: 'report_review',
    schemaVersion: review.version,
    binding: input.binding,
  });
  if (basename(result.artifact.storageUri) !== `review-r${review.revisionRound}.json`) {
    throw new Error('Report Review does not use its final revision path');
  }
  return review;
}

function markdownText(value: string | number | boolean | null): string {
  return String(value ?? '—')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/gu, '\\$1')
    .replace(/\r?\n/gu, '  \n');
}

function markdownCell(value: string | number | boolean | null): string {
  return markdownText(value).replaceAll('  \n', ' ');
}

function markdownAssetPath(assetId: string, assetPaths: ReadonlyMap<string, string>): string {
  const path = assetPaths.get(assetId);
  if (!path || !SAFE_ASSET_PATH.test(path)) {
    throw new Error(`standalone Markdown Asset ${assetId} has no safe snapshot path`);
  }
  return path;
}

function renderBlockMarkdown(block: ReportBlockV3, assetPaths: ReadonlyMap<string, string>): string[] {
  const heading = block.title ? [`### ${markdownText(block.title)}`, ''] : [];
  switch (block.type) {
    case 'paragraph':
    case 'fact':
      return [...heading, markdownText(block.text), ''];
    case 'metric':
      return [...heading, `**${markdownText(block.label)}: ${markdownText(block.value)}${block.unit ? ` ${markdownText(block.unit)}` : ''}**`, ''];
    case 'list':
      return [
        ...heading,
        ...block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${item.label ? `**${markdownText(item.label)}：** ` : ''}${markdownText(item.text)}`),
        '',
      ];
    case 'answer':
      return [
        ...heading,
        markdownText(block.text),
        '',
        ...block.items.map((item) => `- ${item.label ? `**${markdownText(item.label)}：** ` : ''}${markdownText(item.text)}`),
        ...(block.items.length > 0 ? [''] : []),
        ...(block.answerStatus ? [`Status: ${block.answerStatus}`, ''] : []),
      ];
    case 'image':
      return [
        ...heading,
        `![${markdownText(block.altText)}](${markdownAssetPath(block.assetRef.assetId, assetPaths)})`,
        '',
        `*${markdownText(block.caption)}*`,
        '',
      ];
    case 'image-comparison':
      return [
        ...heading,
        `![${markdownText(`${block.altText} — 原图`)}](${markdownAssetPath(block.beforeAssetRef.assetId, assetPaths)})`,
        '',
        `![${markdownText(`${block.altText} — 标注图`)}](${markdownAssetPath(block.afterAssetRef.assetId, assetPaths)})`,
        '',
        `*${markdownText(block.caption)}*`,
        '',
      ];
    case 'chart':
      return [
        ...heading,
        `![${markdownText(block.altText)}](${markdownAssetPath(block.chartRef.assetId, assetPaths)})`,
        '',
        `*${markdownText(block.table.caption)}*`,
        '',
        `| ${block.table.columns.map(markdownCell).join(' | ')} |`,
        `| ${block.table.columns.map(() => '---').join(' | ')} |`,
        ...block.table.rows.map((row) => `| ${[row.label, ...row.cells].map(markdownCell).join(' | ')} |`),
        '',
      ];
    case 'record-table': {
      const includeRowLabel = block.rows.some(({ label }) => label);
      const headers = [
        ...(includeRowLabel ? ['项目'] : []),
        ...block.columns.map(({ label }) => label),
      ];
      return [
        ...heading,
        `| ${headers.map(markdownCell).join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...block.rows.map((row) => {
          const cells = new Map(row.cells.map((cell) => [cell.columnKey, cell.value]));
          return `| ${[
            ...(includeRowLabel ? [row.label ?? '—'] : []),
            ...block.columns.map(({ key }) => cells.get(key) ?? null),
          ].map(markdownCell).join(' | ')} |`;
        }),
        '',
      ];
    }
    case 'graph': {
      const labels = new Map(block.nodes.map((node) => [node.id, node.label]));
      return [
        ...heading,
        ...block.nodes.map((node) => `- **${markdownText(node.label)}**${node.description ? `：${markdownText(node.description)}` : ''}`),
        ...(block.edges.length > 0 ? ['', '**关系**', ''] : []),
        ...block.edges.map((edge) => `- ${markdownText(labels.get(edge.from) ?? '')} → ${markdownText(labels.get(edge.to) ?? '')}${edge.label ? `：${markdownText(edge.label)}` : ''}`),
        '',
      ];
    }
    case 'priority-board':
      return [
        ...heading,
        ...block.groups.flatMap((group) => [
          `#### ${group.priority}`,
          '',
          ...group.items.map((item) => `- **${markdownText(item.action)}**${item.owner ? ` · 负责人：${markdownText(item.owner)}` : ''}${item.rationale ? ` · ${markdownText(item.rationale)}` : ''}${item.validationMethod ? ` · 验证：${markdownText(item.validationMethod)}` : ''}`),
          '',
        ]),
      ];
  }
}

function renderBlockMarkdownV4(block: ReportBlockV4, assetPaths: ReadonlyMap<string, string>): string[] {
  const digest = block.digest ? [`> ${markdownText(block.digest.text)}`, ''] : [];
  if (block.type === 'card-grid') {
    return [
      ...(block.title ? [`### ${markdownText(block.title)}`, ''] : []),
      ...digest,
      ...block.cards.flatMap((card) => [
        `#### ${markdownText(card.title)}${card.status ? ` · ${markdownText(card.status)}` : ''}`,
        '',
        ...(card.body ? [markdownText(card.body), ''] : []),
      ]),
    ];
  }
  if (block.type === 'stage-flow') {
    return [
      ...(block.title ? [`### ${markdownText(block.title)}`, ''] : []),
      ...digest,
      ...block.stages.map((stage, index) => `${index + 1}. **${markdownText(stage.label)}**${stage.timeLabel ? ` · ${markdownText(stage.timeLabel)}` : ''}${stage.description ? `：${markdownText(stage.description)}` : ''}`),
      '',
    ];
  }
  return [...digest, ...renderBlockMarkdown(block, assetPaths)];
}

export function renderStandaloneReportMarkdown(
  document: ReportDocumentV3 | ReportDocumentV4,
  assetPaths: ReadonlyMap<string, string>,
): string {
  if (document.version === 'report-document-v4') {
    const traversal = visitReportDocumentV4(document, {
      visitBlock(block) {
        return renderBlockMarkdownV4(block, assetPaths);
      },
      visitSection(section, blocks) {
        return [
          `## ${markdownText(section.title.text)}`,
          '',
          ...(section.lead ? [markdownText(section.lead.text), ''] : []),
          ...blocks.flat(),
          ...(section.transition ? [`> ${markdownText(section.transition.text)}`, ''] : []),
        ];
      },
      visitNotice({ code }) {
        return `- ${markdownText(code)}`;
      },
      visitAuditRecord(record) {
        return `| ${markdownCell(record.sourceUnitKey)} | ${record.disposition} | ${markdownCell(record.canonicalNodeIds.join('、') || '—')} | ${markdownCell(record.reasonCode ?? '—')} |`;
      },
    });
    const lines = [
      `# ${markdownText(document.title.text)}`,
      '',
      markdownText(document.subtitle),
      '',
      '## 执行摘要 / Executive Summary',
      '',
      markdownText(document.executiveSummary.text),
      '',
      ...(traversal.notices.length > 0 ? [
        '## 生成说明',
        '',
        ...traversal.notices,
        '',
      ] : []),
      ...traversal.sections.flat(),
      ...(traversal.auditRecords.length > 0 ? [
        '## 分析审计附录',
        '',
        '| 来源单元 | 处理结果 | Canonical 映射 | 说明 |',
        '| --- | --- | --- | --- |',
        ...traversal.auditRecords,
        '',
      ] : []),
    ];
    return `${lines.join('\n').trim()}\n`;
  }
  const traversal = visitReportDocumentV3(document, {
    visitBlock(block) {
      return renderBlockMarkdown(block, assetPaths);
    },
    visitSection(section, blocks) {
      return [`## ${markdownText(section.title)}`, '', ...blocks.flat()];
    },
    visitNotice({ code }) {
      return `- ${markdownText(code)}`;
    },
    visitAuditRecord(record) {
      return `| ${markdownCell(record.sourceUnitKey)} | ${record.disposition} | ${markdownCell(record.canonicalNodeIds.join('、') || '—')} | ${markdownCell(record.reasonCode ?? '—')} |`;
    },
  });
  const lines = [
    `# ${markdownText(document.title)}`,
    '',
    markdownText(document.subtitle),
    '',
    '## 执行摘要 / Executive Summary',
    '',
    markdownText(document.executiveSummary),
    '',
    ...(traversal.notices.length > 0 ? [
      '## 生成说明',
      '',
      ...traversal.notices,
      '',
    ] : []),
    ...traversal.sections.flat(),
    ...(traversal.auditRecords.length > 0 ? [
      '## 分析审计附录',
      '',
      '| 来源单元 | 处理结果 | Canonical 映射 | 说明 |',
      '| --- | --- | --- | --- |',
      ...traversal.auditRecords,
      '',
    ] : []),
  ];
  return `${lines.join('\n').trim()}\n`;
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

export class StandaloneHtmlReportPackageService {
  constructor(private readonly options: {
    artifacts: StandaloneBundleArtifactReader;
    reportPackages: ReportPackageV2Verifier;
  }) {}

  async create(input: StandaloneHtmlBundleInput): Promise<Uint8Array> {
    let packageValue: ReportPackageV2;
    try {
      const candidate = await this.options.artifacts.readVerifiedBoundJson<unknown>(
        input.reportPackageArtifactId,
      );
      packageValue = parseReportPackageV2(candidate.value);
      assertArtifactBinding({
        artifact: candidate.artifact,
        artifactId: input.reportPackageArtifactId,
        kind: 'report_package',
        schemaVersion: 'report-package-v2',
        binding: input,
      });
      if (
        packageValue.taskId !== input.taskId
        || packageValue.planVersionId !== input.planVersionId
        || packageValue.attemptId !== input.attemptId
      ) {
        throw new Error('standalone HTML bundle Package value binding is invalid');
      }
    } catch (error) {
      throw new HtmlBundleIntegrityError(error);
    }

    if (packageValue.standaloneHtml.status === 'unavailable') {
      throw new HtmlBundleUnavailableError();
    }

    try {
      const verified = await this.options.reportPackages.verify({
        artifactId: input.reportPackageArtifactId,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        reportPublicationId: packageValue.reportPublicationId,
      });
      packageValue = verified.value;
      if (packageValue.standaloneHtml.status !== 'ready') throw new HtmlBundleUnavailableError();

      const documentResult = await this.options.artifacts.readVerifiedBoundJson<unknown>(
        packageValue.sourceReportDocumentArtifactId,
      );
      assertArtifactBinding({
        artifact: documentResult.artifact,
        artifactId: packageValue.sourceReportDocumentArtifactId,
        kind: 'report_document',
        schemaVersion: ['report-document-v3', 'report-document-v4'],
        binding: input,
      });
      const documentCandidate = documentResult.value as { version?: string };
      if (
        documentResult.artifact.contentSha256 !== packageValue.sourceReportDocumentContentSha256
        || !documentResult.value
        || typeof documentResult.value !== 'object'
        || Array.isArray(documentResult.value)
        || (!isReportDocumentV3(documentCandidate) && !isReportDocumentV4(documentCandidate))
      ) {
        throw new Error('standalone HTML bundle ReportDocument identity is invalid');
      }
      const document = documentCandidate;
      const assetPaths = new Map(
        packageValue.assetSnapshot.assets.map((asset) => [asset.assetId, asset.relativePath]),
      );

      const htmlResult = await this.options.artifacts.readVerifiedBoundText(
        packageValue.standaloneHtml.artifactId,
      );
      assertArtifactBinding({
        artifact: htmlResult.artifact,
        artifactId: packageValue.standaloneHtml.artifactId,
        kind: 'standalone_html_report',
        schemaVersion: 'standalone-html-report-v1',
        binding: input,
      });
      if (
        htmlResult.artifact.mediaType !== 'text/html; charset=utf-8'
        || htmlResult.content.length === 0
      ) {
        throw new Error('standalone HTML bundle sealed HTML identity is invalid');
      }

      const assets = await Promise.all(packageValue.assetSnapshot.assets.map(async (asset) => {
        const result = await this.options.artifacts.readVerifiedBinary(asset.assetId);
        assertArtifactBinding({
          artifact: result.artifact,
          artifactId: asset.assetId,
          kind: 'visual_asset',
          schemaVersion: 'visual-asset-v1',
          binding: input,
        });
        if (
          result.artifact.contentSha256 !== asset.contentSha256
          || result.metadata.contentType !== asset.mediaType
          || result.metadata.byteSize !== result.bytes.byteLength
        ) {
          throw new Error(`standalone HTML bundle Asset ${asset.assetId} does not match its snapshot`);
        }
        return [asset.relativePath, result.bytes] as const;
      }));

      const entries = new Map<string, Uint8Array>([
        ['report.html', strToU8(htmlResult.content)],
        ['report-document.json', jsonBytes(document.version === 'report-document-v4'
          ? safeReportDocumentV4(document)
          : safeReportDocumentV3(document))],
        ['full-report.md', strToU8(renderStandaloneReportMarkdown(document, assetPaths))],
        ...assets,
      ]);
      let omittedSidecar = false;
      let evidenceSidecar: {
        manifest: EvidenceManifest;
        resolver: EvidenceArtifactResolver;
      } | undefined;
      let deliverableSidecar: ExportableDeliverable | undefined;
      try {
        evidenceSidecar = await readValidatedEvidenceSidecar({
          artifacts: this.options.artifacts,
          reportPackage: packageValue,
          binding: input,
        });
        entries.set('evidence-manifest.json', jsonBytes(safeEvidenceManifest(evidenceSidecar.manifest)));
      } catch {
        omittedSidecar = true;
      }
      try {
        if (!evidenceSidecar) throw new Error('Deliverable export requires a valid Evidence Manifest');
        deliverableSidecar = await readValidatedDeliverableSidecar({
          artifacts: this.options.artifacts,
          reportPackage: packageValue,
          binding: input,
          evidence: evidenceSidecar,
        });
        entries.set('deliverable.json', jsonBytes(safeDeliverable(deliverableSidecar)));
      } catch {
        omittedSidecar = true;
      }
      try {
        const review = await readValidatedReviewSidecar({
          artifacts: this.options.artifacts,
          reportPackage: packageValue,
          binding: input,
        });
        entries.set('report-review.json', jsonBytes(safeReportReview(review)));
      } catch {
        omittedSidecar = true;
      }
      const outputNotices: ReportNoticeV1[] = omittedSidecar
        ? [{
            id: 'standalone-html-export-attachment-omitted',
            code: 'export_attachment_omitted',
            severity: 'warning',
            scope: 'export',
            relatedUnitIds: [],
          }]
        : [];
      if (document.version === 'report-document-v4') {
        const traversal = visitReportDocumentV4(document, {
          visitBlock(block) { return block.id; },
          visitSection(section, blocks) { return `${section.id}:${blocks.join(',')}`; },
          visitNotice(notice) { return notice.id; },
          visitAuditRecord(record) { return record.id; },
        });
        entries.set('render-manifest.json', jsonBytes(createReportRenderManifestV2({
          renderer: 'standalone_html',
          rendererVersion: packageValue.standaloneHtml.rendererVersion,
          sourceReportDocumentContentSha256: packageValue.sourceReportDocumentContentSha256,
          document,
          semantics: traversal.semantics,
          outputNotices,
        })));
      } else {
        const traversal = visitReportDocumentV3(document, {
          visitBlock(block) { return block.id; },
          visitSection(section, blocks) { return `${section.id}:${blocks.join(',')}`; },
          visitNotice(notice) { return notice.id; },
          visitAuditRecord(record) { return record.id; },
        });
        entries.set('render-manifest.json', jsonBytes(createReportRenderManifestV1({
          renderer: 'standalone_html',
          rendererVersion: packageValue.standaloneHtml.rendererVersion,
          sourceReportDocumentContentSha256: packageValue.sourceReportDocumentContentSha256,
          document,
          semantics: traversal.semantics,
          outputNotices,
        })));
      }
      return zipSync(
        Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right))),
        { level: 9, mtime: ZIP_TIMESTAMP },
      );
    } catch (error) {
      if (error instanceof HtmlBundleUnavailableError) throw error;
      throw new HtmlBundleIntegrityError(error);
    }
  }
}
