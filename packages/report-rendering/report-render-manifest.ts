import type {
  ReportDocumentV3,
  ReportDocumentV4,
  ReportNoticeV1,
  ReportSemanticManifestV1,
  ReportSemanticManifestV2,
} from '../api-contract/report-document.ts';
import {
  collectReportDocumentV3Semantics,
  collectReportDocumentV4Semantics,
} from './report-document-visitor.ts';

export type ReportRendererV1 = 'react' | 'standalone_html' | 'markdown' | 'zero';

export interface ReportRenderManifestV1 {
  version: 'report-render-manifest-v1';
  renderer: ReportRendererV1;
  rendererVersion: string;
  sourceReportDocumentContentSha256: string;
  semantics: ReportSemanticManifestV1;
  outputNotices: ReportNoticeV1[];
}

export interface ReportRenderManifestV2 {
  version: 'report-render-manifest-v2';
  renderer: ReportRendererV1;
  rendererVersion: string;
  sourceReportDocumentContentSha256: string;
  semantics: ReportSemanticManifestV2;
  outputNotices: ReportNoticeV1[];
}

export function createReportRenderManifestV1(input: {
  renderer: ReportRendererV1;
  rendererVersion: string;
  sourceReportDocumentContentSha256: string;
  document: ReportDocumentV3;
  semantics: ReportSemanticManifestV1;
  outputNotices?: ReportNoticeV1[];
}): ReportRenderManifestV1 {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.sourceReportDocumentContentSha256)) {
    throw new Error('Render Manifest requires a valid ReportDocument content hash');
  }
  const expected = collectReportDocumentV3Semantics(input.document);
  assertEquivalentRenderSemantics(expected, input.semantics);
  return {
    version: 'report-render-manifest-v1',
    renderer: input.renderer,
    rendererVersion: input.rendererVersion,
    sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
    semantics: input.semantics,
    outputNotices: input.outputNotices ?? [],
  };
}

export function createReportRenderManifestV2(input: {
  renderer: ReportRendererV1;
  rendererVersion: string;
  sourceReportDocumentContentSha256: string;
  document: ReportDocumentV4;
  semantics: ReportSemanticManifestV2;
  outputNotices?: ReportNoticeV1[];
}): ReportRenderManifestV2 {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.sourceReportDocumentContentSha256)) {
    throw new Error('Render Manifest requires a valid ReportDocument content hash');
  }
  const expected = collectReportDocumentV4Semantics(input.document);
  assertEquivalentRenderSemanticsV2(expected, input.semantics);
  return {
    version: 'report-render-manifest-v2',
    renderer: input.renderer,
    rendererVersion: input.rendererVersion,
    sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
    semantics: input.semantics,
    outputNotices: input.outputNotices ?? [],
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

export function assertEquivalentRenderSemantics(
  expected: ReportSemanticManifestV1,
  actual: ReportSemanticManifestV1,
): void {
  for (const key of [
    'presentationUnitIds',
    'leafUnitIds',
    'assetIds',
    'auditRecordIds',
    'noticeIds',
  ] as const) {
    if (!sameSet(expected[key], actual[key])) {
      throw new Error(`Render Manifest ${key} is not semantically equivalent to the ReportDocument`);
    }
  }
}

export function assertEquivalentRenderSemanticsV2(
  expected: ReportSemanticManifestV2,
  actual: ReportSemanticManifestV2,
): void {
  for (const key of [
    'presentationUnitIds',
    'leafUnitIds',
    'assetIds',
    'auditRecordIds',
    'noticeIds',
    'copyFragmentIds',
  ] as const) {
    if (!sameSet(expected[key], actual[key])) {
      throw new Error(`Render Manifest ${key} is not semantically equivalent to the ReportDocument`);
    }
  }
}
