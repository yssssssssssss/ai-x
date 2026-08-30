import type { CurrentReportPackageResponse } from '../../../packages/api-contract/control-workflow.ts';
import { parseReportPackageV3 } from '../../../packages/api-contract/report-package.ts';
import {
  isReportDocumentV4,
  type ReportDocumentV3,
  type ReportDocumentV4,
} from '../../../packages/api-contract/report-document.ts';
import type {
  ContributionLedgerV1,
  ContributionSummaryV1,
  CrossSkillReviewV1,
  VisualAssetManifest,
} from '../../../packages/api-contract/research-deliverable.ts';
import {
  assertReportDocumentV3Integrity,
  assertReportDocumentV4Integrity,
} from '../../../packages/report-rendering/report-document-visitor.ts';

export type ControlDeliverableResponse = CurrentReportPackageResponse<unknown>;

export function hasCompleteContributionSidecars<T extends {
  crossSkillReview?: unknown;
  contributionLedger?: unknown;
  contributionSummary?: unknown;
}>(value: T): value is T & {
  crossSkillReview: CrossSkillReviewV1;
  contributionLedger: ContributionLedgerV1;
  contributionSummary: ContributionSummaryV1;
} {
  return value.crossSkillReview !== undefined
    && value.contributionLedger !== undefined
    && value.contributionSummary !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

interface PackageBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MANIFEST_KEYS = [
  'version',
  'taskId',
  'planVersionId',
  'attemptId',
  'assetId',
  'contentSha256',
  'mediaType',
  'byteSize',
  'width',
  'height',
  'exportPolicy',
  'source',
  'derivedFrom',
  'derivation',
  'manifestHash',
] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function packageBinding(value: Record<string, unknown>): PackageBinding {
  const deliverable = isRecord(value.deliverable) ? value.deliverable : null;
  if (
    !deliverable
    || !isNonEmptyString(deliverable.taskId)
    || !isNonEmptyString(deliverable.planVersionId)
    || !isNonEmptyString(deliverable.attemptId)
  ) {
    throw new Error('report package Deliverable Task, Plan, and Attempt binding is invalid');
  }
  return {
    taskId: deliverable.taskId,
    planVersionId: deliverable.planVersionId,
    attemptId: deliverable.attemptId,
  };
}

function assertManifestLineage(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, [
    'assetId',
    'manifestArtifactId',
    'contentSha256',
    'manifestHash',
  ])) {
    throw new Error('visual Asset Manifest lineage is invalid');
  }
  if (
    !isNonEmptyString(value.assetId)
    || !isNonEmptyString(value.manifestArtifactId)
    || !isSha256(value.contentSha256)
    || !isSha256(value.manifestHash)
  ) {
    throw new Error('visual Asset Manifest lineage identity is invalid');
  }
}

function isCanonicalHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || Boolean(url.username || url.password)
      || Boolean(url.port && url.port !== '443')
      || Boolean(url.hash)
    ) return false;
    for (const key of url.searchParams.keys()) {
      if (/(^|[_-])(token|key|signature|authorization|password|session|credential)([_-]|$)/iu.test(key)) {
        return false;
      }
    }
    return url.toString() === value;
  } catch {
    return false;
  }
}

function assertManifestSource(
  value: unknown,
  version: 'visual-asset-manifest-v1' | 'visual-asset-manifest-v2',
): 'browser_capture' | 'chart_render' | 'derived' | 'original' {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('visual Asset Manifest source is invalid');
  }
  if (value.kind === 'derived' && hasExactKeys(value, ['kind'])) return 'derived';
  if (
    value.kind === 'user_upload'
    && hasExactKeys(value, ['kind', 'fileName'])
    && isNonEmptyString(value.fileName)
  ) return 'original';
  if (
    value.kind === 'tool_artifact'
    && hasExactKeys(value, ['kind', 'artifactId', 'artifactContentSha256', 'jsonPointer', 'url'])
    && isNonEmptyString(value.artifactId)
    && isSha256(value.artifactContentSha256)
    && typeof value.jsonPointer === 'string'
    && value.jsonPointer.startsWith('/')
    && typeof value.url === 'string'
    && /^https?:\/\//u.test(value.url)
  ) return 'original';
  if (
    version === 'visual-asset-manifest-v2'
    && value.kind === 'browser_capture'
    && hasExactKeys(value, [
      'kind', 'artifactId', 'artifactContentSha256', 'jsonPointer', 'attachmentId',
      'sourcePageUrl', 'finalUrl', 'pageTitle', 'capturedAt', 'captureMode', 'viewport',
      ...(hasOwn(value, 'selector') ? ['selector'] : []),
    ])
    && isNonEmptyString(value.artifactId)
    && isSha256(value.artifactContentSha256)
    && typeof value.jsonPointer === 'string'
    && /^\/output\/captures\/[0-5]$/u.test(value.jsonPointer)
    && typeof value.attachmentId === 'string'
    && /^capture-[1-9][0-9]*$/u.test(value.attachmentId)
    && isCanonicalHttpsUrl(value.sourcePageUrl)
    && isCanonicalHttpsUrl(value.finalUrl)
    && typeof value.pageTitle === 'string'
    && value.pageTitle.length <= 300
    && typeof value.capturedAt === 'string'
    && Number.isFinite(Date.parse(value.capturedAt))
    && ['extracted_image', 'element_screenshot', 'full_page_screenshot'].includes(String(value.captureMode))
    && (!hasOwn(value, 'selector') || (
      typeof value.selector === 'string' && value.selector.length >= 1 && value.selector.length <= 512
    ))
    && isRecord(value.viewport)
    && hasExactKeys(value.viewport, ['width', 'height'])
    && Number.isSafeInteger(value.viewport.width)
    && Number(value.viewport.width) >= 1024
    && Number(value.viewport.width) <= 1920
    && Number.isSafeInteger(value.viewport.height)
    && Number(value.viewport.height) >= 720
    && Number(value.viewport.height) <= 1200
  ) return 'browser_capture';
  if (
    version === 'visual-asset-manifest-v2'
    && value.kind === 'chart_render'
    && hasExactKeys(value, ['kind', 'dataArtifactId', 'dataArtifactContentSha256'])
    && isNonEmptyString(value.dataArtifactId)
    && isSha256(value.dataArtifactContentSha256)
  ) return 'chart_render';
  throw new Error('visual Asset Manifest source does not match its schema');
}

function assertManifestDerivation(value: unknown): 'chart_svg' | 'derived' | 'none' {
  if (value === null) return 'none';
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('visual Asset Manifest derivation is invalid');
  }
  if (value.kind === 'heatmap' && hasExactKeys(value, ['kind'])) return 'derived';
  if (
    value.kind === 'annotation'
    && hasExactKeys(value, ['kind', 'overlayArtifactId'])
    && isNonEmptyString(value.overlayArtifactId)
  ) return 'derived';
  if (
    value.kind === 'chart_svg'
    && hasExactKeys(value, ['kind', 'chartId', 'specHash'])
    && isNonEmptyString(value.chartId)
    && isSha256(value.specHash)
  ) return 'chart_svg';
  throw new Error('visual Asset Manifest derivation does not match its schema');
}

export function assertVisualAssetManifest(
  value: unknown,
  binding: PackageBinding,
): asserts value is VisualAssetManifest {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    throw new Error('visual Asset Manifest must contain exactly the schema fields');
  }
  if (
    (value.version !== 'visual-asset-manifest-v1' && value.version !== 'visual-asset-manifest-v2')
    || !isNonEmptyString(value.taskId)
    || !isNonEmptyString(value.planVersionId)
    || !isNonEmptyString(value.attemptId)
    || !isNonEmptyString(value.assetId)
    || !isSha256(value.contentSha256)
    || !isSha256(value.manifestHash)
    || typeof value.byteSize !== 'number'
    || !Number.isSafeInteger(value.byteSize)
    || value.byteSize < 1
    || value.byteSize > 10 * 1024 * 1024
    || typeof value.width !== 'number'
    || !Number.isSafeInteger(value.width)
    || value.width < 1
    || typeof value.height !== 'number'
    || !Number.isSafeInteger(value.height)
    || value.height < 1
    || !['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(value.mediaType as string)
    || !['allow', 'mask', 'block'].includes(value.exportPolicy as string)
  ) {
    throw new Error('visual Asset Manifest scalar fields do not match the schema');
  }
  if (
    value.taskId !== binding.taskId
    || value.planVersionId !== binding.planVersionId
    || value.attemptId !== binding.attemptId
  ) {
    throw new Error('visual Asset Manifest Task, Plan, and Attempt binding does not match the package');
  }
  const source = assertManifestSource(value.source, value.version);
  const derivation = assertManifestDerivation(value.derivation);
  if (source === 'derived') {
    assertManifestLineage(value.derivedFrom);
    if (derivation === 'none') throw new Error('derived visual Asset Manifest requires derivation lineage');
    if (value.version === 'visual-asset-manifest-v2' && derivation === 'chart_svg') {
      throw new Error('V2 derived visual Asset Manifest cannot contain chart_svg derivation');
    }
  } else if (source === 'chart_render') {
    if (value.derivedFrom !== null || derivation !== 'chart_svg') {
      throw new Error('chart_render visual Asset Manifest requires null lineage and chart_svg derivation');
    }
  } else if (value.derivedFrom !== null || derivation !== 'none') {
    throw new Error('original visual Asset Manifest cannot contain derived lineage');
  }
  if (
    (derivation === 'chart_svg' && value.mediaType !== 'image/svg+xml')
    || (derivation !== 'chart_svg' && value.mediaType === 'image/svg+xml')
  ) {
    throw new Error('visual Asset Manifest SVG media type requires chart_svg derivation');
  }
}

function assertNoMultimodalFields(value: Record<string, unknown>, mode: string): void {
  for (const key of [
    'reportDocument',
    'visualAssetManifests',
    'visualAssetManifest',
    'reportPackage',
    'editorialShowcase',
  ]) {
    if (hasOwn(value, key)) throw new Error(`${mode} report package must not contain multimodal ${key}`);
  }
}

function reportVisualReferences(document: Record<string, unknown>): Map<string, string> {
  if (
    (
      document.version !== 'report-document-v1'
      && document.version !== 'report-document-v2'
      && document.version !== 'report-document-v3'
      && document.version !== 'report-document-v4'
    )
    || !Array.isArray(document.sections)
  ) {
    throw new Error('multimodal report document is invalid');
  }
  if (document.version === 'report-document-v3') {
    assertReportDocumentV3Integrity(document as unknown as ReportDocumentV3);
  }
  if (isReportDocumentV4(document as { version?: string })) {
    assertReportDocumentV4Integrity(document as unknown as ReportDocumentV4);
  }
  const references = new Map<string, string>();
  const append = (candidate: unknown): void => {
    const reference = isRecord(candidate) ? candidate : null;
    if (!reference || typeof reference.assetId !== 'string' || typeof reference.manifestArtifactId !== 'string') {
      throw new Error('multimodal report document visual Asset reference is invalid');
    }
    const prior = references.get(reference.assetId);
    if (prior && prior !== reference.manifestArtifactId) {
      throw new Error('multimodal report document has conflicting visual Asset Manifest references');
    }
    references.set(reference.assetId, reference.manifestArtifactId);
  };
  for (const sectionValue of document.sections) {
    const section = isRecord(sectionValue) ? sectionValue : null;
    if (!section || !Array.isArray(section.blocks)) throw new Error('multimodal report document section is invalid');
    for (const blockValue of section.blocks) {
      const block = isRecord(blockValue) ? blockValue : null;
      if (!block || typeof block.type !== 'string') throw new Error('multimodal report document block is invalid');
      if (block.type === 'image') append(block.assetRef);
      if (block.type === 'image-comparison') {
        append(block.beforeAssetRef);
        append(block.afterAssetRef);
      }
      if (block.type === 'chart') append(block.chartRef);
    }
  }
  return references;
}

function assertExactVisualManifests(
  value: Record<string, unknown>,
  references: Map<string, string>,
  binding: PackageBinding,
): void {
  if (!Array.isArray(value.visualAssetManifests)) {
    throw new Error('multimodal report package requires visual Asset Manifests');
  }
  if (value.visualAssetManifests.length !== references.size) {
    throw new Error('multimodal visual Asset Manifest set does not match ReportDocument references');
  }
  const seen = new Set<string>();
  for (const candidate of value.visualAssetManifests) {
    assertVisualAssetManifest(candidate, binding);
    if (candidate.exportPolicy === 'block') {
      throw new Error(`visual Asset ${candidate.assetId} is blocked by its export policy`);
    }
    if (!references.has(candidate.assetId) || seen.has(candidate.assetId)) {
      throw new Error('multimodal visual Asset Manifest set does not match ReportDocument references');
    }
    seen.add(candidate.assetId);
  }
}

function assertContributionSidecars(
  value: Record<string, unknown>,
  binding: PackageBinding,
): void {
  const sidecars = [value.crossSkillReview, value.contributionLedger, value.contributionSummary];
  const count = sidecars.filter((item) => item !== undefined).length;
  if (count !== 0 && count !== 3) throw new Error('report package contribution sidecars are incomplete');
  for (const [index, candidate] of sidecars.entries()) {
    if (candidate === undefined) continue;
    if (!isRecord(candidate)) throw new Error('report package contribution sidecar is invalid');
    const expectedVersion = [
      'cross-skill-review-v1',
      'contribution-ledger-v1',
      'contribution-summary-v1',
    ][index];
    if (
      candidate.version !== expectedVersion
      || candidate.taskId !== binding.taskId
      || candidate.planVersionId !== binding.planVersionId
      || candidate.attemptId !== binding.attemptId
    ) throw new Error('report package contribution sidecar binding is invalid');
  }
}

export function parseControlDeliverableResponse(value: unknown): ControlDeliverableResponse {
  if (!isRecord(value)) throw new Error('report package response must be an object');
  if (hasOwn(value, 'visualAssetManifest')) {
    throw new Error('report package uses obsolete visual Asset Manifest contract');
  }
  if (value.presentationMode === 'legacy_text') {
    assertNoMultimodalFields(value, 'legacy_text');
    assertContributionSidecars(value, packageBinding(value));
    if (value.contributionLedger !== undefined) {
      throw new Error('legacy report package must not expose contribution sidecars');
    }
    return value as unknown as ControlDeliverableResponse;
  }
  if (value.presentationMode !== 'current_text' && value.presentationMode !== 'multimodal') {
    throw new Error('report package presentationMode is unsupported');
  }
  if (!isRecord(value.reportReview) || value.reportReview.verdict !== 'pass') {
    throw new Error('final report package Review verdict must be pass');
  }
  assertContributionSidecars(value, packageBinding(value));
  if (value.presentationMode === 'current_text') {
    assertNoMultimodalFields(value, 'current_text');
    return value as unknown as ControlDeliverableResponse;
  }
  if (!isRecord(value.reportDocument)) {
    throw new Error('multimodal report package requires a ReportDocument');
  }
  if (!isSha256(value.reportDocumentContentSha256)) {
    throw new Error('multimodal report package requires a valid ReportDocument content hash');
  }
  const references = reportVisualReferences(value.reportDocument);
  assertExactVisualManifests(value, references, packageBinding(value));
  if (value.editorialShowcase !== undefined) {
    const showcase = parseReportPackageV3(value.editorialShowcase);
    const binding = packageBinding(value);
    if (
      showcase.taskId !== binding.taskId
      || showcase.planVersionId !== binding.planVersionId
      || showcase.attemptId !== binding.attemptId
      || (
        isRecord(value.reportPackage)
        && typeof value.reportPackage.reportPublicationId === 'string'
        && showcase.reportPublicationId !== value.reportPackage.reportPublicationId
      )
    ) {
      throw new Error('Editorial Showcase package binding is invalid');
    }
  }
  return value as unknown as ControlDeliverableResponse;
}
