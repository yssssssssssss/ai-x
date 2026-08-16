import type { CurrentReportPackageResponse } from '../../../packages/api-contract/control-workflow.ts';
import type {
  ResearchPlanPayload,
  VisualAssetManifest,
} from '../../../packages/api-contract/research-deliverable.ts';

export type ControlDeliverableResponse = CurrentReportPackageResponse<ResearchPlanPayload>;

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
    || !isNonEmptyString(value.contentSha256)
    || !isNonEmptyString(value.manifestHash)
  ) {
    throw new Error('visual Asset Manifest lineage identity is invalid');
  }
}

function assertManifestSource(value: unknown): 'derived' | 'original' {
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

function assertVisualAssetManifest(value: unknown, binding: PackageBinding): asserts value is VisualAssetManifest {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    throw new Error('visual Asset Manifest must contain exactly the schema fields');
  }
  if (
    value.version !== 'visual-asset-manifest-v1'
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
  const source = assertManifestSource(value.source);
  const derivation = assertManifestDerivation(value.derivation);
  if (source === 'derived') {
    assertManifestLineage(value.derivedFrom);
    if (derivation === 'none') throw new Error('derived visual Asset Manifest requires derivation lineage');
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
  for (const key of ['reportDocument', 'visualAssetManifests', 'visualAssetManifest']) {
    if (hasOwn(value, key)) throw new Error(`${mode} report package must not contain multimodal ${key}`);
  }
}

function reportVisualReferences(document: Record<string, unknown>): Map<string, string> {
  if (document.version !== 'report-document-v1' || !Array.isArray(document.sections)) {
    throw new Error('multimodal report document is invalid');
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
    if (!references.has(candidate.assetId) || seen.has(candidate.assetId)) {
      throw new Error('multimodal visual Asset Manifest set does not match ReportDocument references');
    }
    seen.add(candidate.assetId);
  }
}

export function parseControlDeliverableResponse(value: unknown): ControlDeliverableResponse {
  if (!isRecord(value)) throw new Error('report package response must be an object');
  if (hasOwn(value, 'visualAssetManifest')) {
    throw new Error('report package uses obsolete visual Asset Manifest contract');
  }
  if (value.presentationMode === 'legacy_text') {
    assertNoMultimodalFields(value, 'legacy_text');
    return value as unknown as ControlDeliverableResponse;
  }
  if (value.presentationMode !== 'current_text' && value.presentationMode !== 'multimodal') {
    throw new Error('report package presentationMode is unsupported');
  }
  if (!isRecord(value.reportReview) || value.reportReview.verdict !== 'pass') {
    throw new Error('final report package Review verdict must be pass');
  }
  if (value.presentationMode === 'current_text') {
    assertNoMultimodalFields(value, 'current_text');
    return value as unknown as ControlDeliverableResponse;
  }
  if (!isRecord(value.reportDocument)) {
    throw new Error('multimodal report package requires a ReportDocument');
  }
  const references = reportVisualReferences(value.reportDocument);
  assertExactVisualManifests(value, references, packageBinding(value));
  return value as unknown as ControlDeliverableResponse;
}
