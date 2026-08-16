import type { CurrentReportPackageResponse } from '../../../packages/api-contract/control-workflow.ts';
import type { ResearchPlanPayload } from '../../../packages/api-contract/research-deliverable.ts';

export type ControlDeliverableResponse = CurrentReportPackageResponse<ResearchPlanPayload>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function assertExactVisualManifests(value: Record<string, unknown>, references: Map<string, string>): void {
  if (!Array.isArray(value.visualAssetManifests)) {
    throw new Error('multimodal report package requires visual Asset Manifests');
  }
  if (value.visualAssetManifests.length !== references.size) {
    throw new Error('multimodal visual Asset Manifest set does not match ReportDocument references');
  }
  const seen = new Set<string>();
  for (const candidate of value.visualAssetManifests) {
    const manifest = isRecord(candidate) ? candidate : null;
    if (
      !manifest
      || manifest.version !== 'visual-asset-manifest-v1'
      || typeof manifest.assetId !== 'string'
      || !references.has(manifest.assetId)
      || seen.has(manifest.assetId)
    ) {
      throw new Error('multimodal visual Asset Manifest set does not match ReportDocument references');
    }
    seen.add(manifest.assetId);
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
  assertExactVisualManifests(value, references);
  return value as unknown as ControlDeliverableResponse;
}
