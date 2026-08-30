import type { ReportNoticeV1 } from './report-document.ts';

export const REPORT_PACKAGE_V2_VERSION = 'report-package-v2' as const;
export const REPORT_PACKAGE_V3_VERSION = 'report-package-v3' as const;

export const REPORT_PACKAGE_SHOWCASE_UNAVAILABLE_REASON_CODES = [
  'showcase_planner_disabled',
  'showcase_data_policy_denied',
  'showcase_material_budget_exceeded',
  'showcase_provider_failure',
  'showcase_invalid_intent',
  'showcase_invalid_binding',
  'showcase_renderer_failure',
  'showcase_validation_failure',
] as const;

export type ReportPackageShowcaseUnavailableReasonCode =
  (typeof REPORT_PACKAGE_SHOWCASE_UNAVAILABLE_REASON_CODES)[number];

export const REPORT_PACKAGE_LAYOUT_FALLBACK_REASON_CODES = [
  'planner_disabled',
  'data_policy_denied',
  'material_budget_exceeded',
  'provider_failure',
  'invalid_blueprint',
  'incompatible_presentation',
] as const;

export type LayoutFallbackReasonCode =
  (typeof REPORT_PACKAGE_LAYOUT_FALLBACK_REASON_CODES)[number];

export const REPORT_PACKAGE_HTML_UNAVAILABLE_REASON_CODES = [
  'unsupported_block',
  'unsafe_output',
  'render_manifest_mismatch',
  'size_limit_exceeded',
  'artifact_write_failed',
] as const;

export type HtmlUnavailableReasonCode =
  (typeof REPORT_PACKAGE_HTML_UNAVAILABLE_REASON_CODES)[number];

export type ReportPackageLayoutV2 =
  | { mode: 'model'; blueprintArtifactId: string }
  | {
      mode: 'fallback';
      blueprintArtifactId: string;
      reasonCode: LayoutFallbackReasonCode;
    };

export interface ReportPackageAssetV2 {
  assetId: string;
  manifestArtifactId: string;
  contentSha256: string;
  manifestHash: string;
  relativePath: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  sourceKind: 'visual_asset' | 'chart_svg';
  exportPolicy: 'allow' | 'mask';
  leafIds: string[];
}

export interface ReportPackageChartV2 {
  chartId: string;
  chartSpecArtifactId: string;
  chartSpecArtifactContentSha256: string;
  specHash: string;
  assetId: string;
  dataArtifactRef?: {
    artifactId: string;
    contentSha256: string;
    schemaVersion: string;
  };
  leafIds: string[];
}

export interface ReportPackageAssetSnapshotV2 {
  assets: ReportPackageAssetV2[];
  charts: ReportPackageChartV2[];
}

export type ReportPackageStandaloneHtmlV2 =
  | { status: 'ready'; artifactId: string; rendererVersion: string }
  | { status: 'unavailable'; reasonCode: HtmlUnavailableReasonCode };

export interface ReportPackageV2 {
  version: typeof REPORT_PACKAGE_V2_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPublicationId: string;
  presentationMode: 'multimodal';
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  reportReviewArtifactId: string;
  sourceReportDocumentArtifactId: string;
  sourceReportDocumentContentSha256: string;
  crossSkillReviewArtifactId?: string;
  contributionLedgerArtifactId?: string;
  contributionSummaryArtifactId?: string;
  layout: ReportPackageLayoutV2;
  assetSnapshot: ReportPackageAssetSnapshotV2;
  standaloneHtml: ReportPackageStandaloneHtmlV2;
  notices: ReportNoticeV1[];
}

export type ReportPackageShowcaseV3 =
  | {
      status: 'ready';
      specArtifactId: string;
      htmlArtifactId: string;
      rendererVersion: string;
      profileId: 'editorial-showcase-v1';
      generationMode: 'model' | 'fallback';
      showcaseOutlineSignature: string;
    }
  | {
      status: 'unavailable';
      reasonCode: ReportPackageShowcaseUnavailableReasonCode;
    };

export interface ReportPackageV3 {
  version: typeof REPORT_PACKAGE_V3_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPublicationId: string;
  canonicalPackageArtifactId: string;
  canonicalPackageContentSha256: string;
  preferredHtml: 'showcase' | 'canonical';
  showcase: ReportPackageShowcaseV3;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9._-]+$/u;
const NOTICE_CODES = new Set([
  'layout_fallback',
  'copy_fallback',
  'data_policy_fallback',
  'editorial_adapter_fallback',
  'optional_visual_omitted',
  'requested_artifact_unfulfilled',
  'visualization_linearized',
  'export_attachment_omitted',
  'renderer_compatibility_fallback',
  'html_unavailable',
  'zero_unavailable',
  'legacy_trace_incomplete',
]);
const NOTICE_SEVERITIES = new Set(['info', 'warning', 'action_required']);
const NOTICE_SCOPES = new Set(['report', 'section', 'block', 'export']);
const ASSET_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

function fail(field: string): never {
  throw new Error(`Report Package v2 ${field} is invalid`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`);
  }
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(field);
  return value;
}

function sha256(value: unknown, field: string): string {
  const parsed = nonBlank(value, field);
  if (!SHA256.test(parsed)) fail(field);
  return parsed;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) fail(field);
  return value as T;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field);
  return value;
}

function uniqueStrings(value: unknown, field: string): string[] {
  const values = array(value, field).map((item, index) => nonBlank(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) fail(field);
  return values;
}

function parseLayout(value: unknown): ReportPackageLayoutV2 {
  const candidate = record(value, 'layout');
  if (candidate.mode === 'model') {
    exactKeys(candidate, ['mode', 'blueprintArtifactId'], [], 'layout');
    return { mode: 'model', blueprintArtifactId: nonBlank(candidate.blueprintArtifactId, 'layout.blueprintArtifactId') };
  }
  if (candidate.mode === 'fallback') {
    exactKeys(candidate, ['mode', 'blueprintArtifactId', 'reasonCode'], [], 'layout');
    return {
      mode: 'fallback',
      blueprintArtifactId: nonBlank(candidate.blueprintArtifactId, 'layout.blueprintArtifactId'),
      reasonCode: enumValue(
        candidate.reasonCode,
        new Set(REPORT_PACKAGE_LAYOUT_FALLBACK_REASON_CODES),
        'layout.reasonCode',
      ),
    };
  }
  return fail('layout.mode');
}

function parseAsset(value: unknown, index: number): ReportPackageAssetV2 {
  const field = `assetSnapshot.assets[${index}]`;
  const candidate = record(value, field);
  exactKeys(candidate, [
    'assetId',
    'manifestArtifactId',
    'contentSha256',
    'manifestHash',
    'relativePath',
    'mediaType',
    'sourceKind',
    'exportPolicy',
    'leafIds',
  ], [], field);
  const mediaType = enumValue<ReportPackageAssetV2['mediaType']>(
    candidate.mediaType,
    ASSET_MEDIA_TYPES,
    `${field}.mediaType`,
  );
  const sourceKind = enumValue<ReportPackageAssetV2['sourceKind']>(
    candidate.sourceKind,
    new Set(['visual_asset', 'chart_svg']),
    `${field}.sourceKind`,
  );
  if ((mediaType === 'image/svg+xml') !== (sourceKind === 'chart_svg')) {
    fail(`${field}.sourceKind`);
  }
  const relativePath = nonBlank(candidate.relativePath, `${field}.relativePath`);
  if (!SAFE_ASSET_PATH.test(relativePath)) fail(`${field}.relativePath`);
  const leafIds = uniqueStrings(candidate.leafIds, `${field}.leafIds`);
  if (leafIds.length === 0) fail(`${field}.leafIds`);
  return {
    assetId: nonBlank(candidate.assetId, `${field}.assetId`),
    manifestArtifactId: nonBlank(candidate.manifestArtifactId, `${field}.manifestArtifactId`),
    contentSha256: sha256(candidate.contentSha256, `${field}.contentSha256`),
    manifestHash: sha256(candidate.manifestHash, `${field}.manifestHash`),
    relativePath,
    mediaType,
    sourceKind,
    exportPolicy: enumValue(
      candidate.exportPolicy,
      new Set(['allow', 'mask']),
      `${field}.exportPolicy`,
    ),
    leafIds,
  };
}

function parseChart(value: unknown, index: number): ReportPackageChartV2 {
  const field = `assetSnapshot.charts[${index}]`;
  const candidate = record(value, field);
  exactKeys(candidate, [
    'chartId',
    'chartSpecArtifactId',
    'chartSpecArtifactContentSha256',
    'specHash',
    'assetId',
    'leafIds',
  ], ['dataArtifactRef'], field);
  let dataArtifactRef: ReportPackageChartV2['dataArtifactRef'];
  if (candidate.dataArtifactRef !== undefined) {
    const data = record(candidate.dataArtifactRef, `${field}.dataArtifactRef`);
    exactKeys(data, ['artifactId', 'contentSha256', 'schemaVersion'], [], `${field}.dataArtifactRef`);
    dataArtifactRef = {
      artifactId: nonBlank(data.artifactId, `${field}.dataArtifactRef.artifactId`),
      contentSha256: sha256(data.contentSha256, `${field}.dataArtifactRef.contentSha256`),
      schemaVersion: nonBlank(data.schemaVersion, `${field}.dataArtifactRef.schemaVersion`),
    };
  }
  const leafIds = uniqueStrings(candidate.leafIds, `${field}.leafIds`);
  if (leafIds.length === 0) fail(`${field}.leafIds`);
  return {
    chartId: nonBlank(candidate.chartId, `${field}.chartId`),
    chartSpecArtifactId: nonBlank(candidate.chartSpecArtifactId, `${field}.chartSpecArtifactId`),
    chartSpecArtifactContentSha256: sha256(
      candidate.chartSpecArtifactContentSha256,
      `${field}.chartSpecArtifactContentSha256`,
    ),
    specHash: sha256(candidate.specHash, `${field}.specHash`),
    assetId: nonBlank(candidate.assetId, `${field}.assetId`),
    ...(dataArtifactRef === undefined ? {} : { dataArtifactRef }),
    leafIds,
  };
}

function parseAssetSnapshot(value: unknown): ReportPackageAssetSnapshotV2 {
  const candidate = record(value, 'assetSnapshot');
  exactKeys(candidate, ['assets', 'charts'], [], 'assetSnapshot');
  const assets = array(candidate.assets, 'assetSnapshot.assets').map(parseAsset);
  const charts = array(candidate.charts, 'assetSnapshot.charts').map(parseChart);
  for (const [field, values] of [
    ['assetSnapshot.assets.assetId', assets.map(({ assetId }) => assetId)],
    ['assetSnapshot.assets.manifestArtifactId', assets.map(({ manifestArtifactId }) => manifestArtifactId)],
    ['assetSnapshot.assets.relativePath', assets.map(({ relativePath }) => relativePath)],
    ['assetSnapshot.charts.chartId', charts.map(({ chartId }) => chartId)],
    ['assetSnapshot.charts.chartSpecArtifactId', charts.map(({ chartSpecArtifactId }) => chartSpecArtifactId)],
    ['assetSnapshot.charts.assetId', charts.map(({ assetId }) => assetId)],
  ] as const) {
    if (new Set(values).size !== values.length) fail(field);
  }
  const assetIds = new Set(assets.map(({ assetId }) => assetId));
  for (const chart of charts) {
    if (!assetIds.has(chart.assetId)) fail(`assetSnapshot.charts.${chart.chartId}.assetId`);
  }
  return { assets, charts };
}

function parseStandaloneHtml(value: unknown): ReportPackageStandaloneHtmlV2 {
  const candidate = record(value, 'standaloneHtml');
  if (candidate.status === 'ready') {
    exactKeys(candidate, ['status', 'artifactId', 'rendererVersion'], [], 'standaloneHtml');
    return {
      status: 'ready',
      artifactId: nonBlank(candidate.artifactId, 'standaloneHtml.artifactId'),
      rendererVersion: nonBlank(candidate.rendererVersion, 'standaloneHtml.rendererVersion'),
    };
  }
  if (candidate.status === 'unavailable') {
    exactKeys(candidate, ['status', 'reasonCode'], [], 'standaloneHtml');
    return {
      status: 'unavailable',
      reasonCode: enumValue(
        candidate.reasonCode,
        new Set(REPORT_PACKAGE_HTML_UNAVAILABLE_REASON_CODES),
        'standaloneHtml.reasonCode',
      ),
    };
  }
  return fail('standaloneHtml.status');
}

function parseNotice(value: unknown, index: number): ReportNoticeV1 {
  const field = `notices[${index}]`;
  const candidate = record(value, field);
  exactKeys(candidate, ['id', 'code', 'severity', 'scope', 'relatedUnitIds'], [], field);
  return {
    id: nonBlank(candidate.id, `${field}.id`),
    code: enumValue(candidate.code, NOTICE_CODES, `${field}.code`),
    severity: enumValue(candidate.severity, NOTICE_SEVERITIES, `${field}.severity`),
    scope: enumValue(candidate.scope, NOTICE_SCOPES, `${field}.scope`),
    relatedUnitIds: uniqueStrings(candidate.relatedUnitIds, `${field}.relatedUnitIds`),
  };
}

export function parseReportPackageV3(value: unknown): ReportPackageV3 {
  const candidate = record(value, 'v3 value');
  exactKeys(candidate, [
    'version',
    'taskId',
    'planVersionId',
    'attemptId',
    'reportPublicationId',
    'canonicalPackageArtifactId',
    'canonicalPackageContentSha256',
    'preferredHtml',
    'showcase',
  ], [], 'v3 value');
  if (candidate.version !== REPORT_PACKAGE_V3_VERSION) fail('v3 version');
  const preferredHtml = enumValue<'showcase' | 'canonical'>(
    candidate.preferredHtml,
    new Set(['showcase', 'canonical']),
    'v3 preferredHtml',
  );
  const showcaseValue = record(candidate.showcase, 'v3 showcase');
  let showcase: ReportPackageShowcaseV3;
  if (showcaseValue.status === 'ready') {
    exactKeys(showcaseValue, [
      'status',
      'specArtifactId',
      'htmlArtifactId',
      'rendererVersion',
      'profileId',
      'generationMode',
      'showcaseOutlineSignature',
    ], [], 'v3 showcase');
    if (showcaseValue.profileId !== 'editorial-showcase-v1') fail('v3 showcase.profileId');
    showcase = {
      status: 'ready',
      specArtifactId: nonBlank(showcaseValue.specArtifactId, 'v3 showcase.specArtifactId'),
      htmlArtifactId: nonBlank(showcaseValue.htmlArtifactId, 'v3 showcase.htmlArtifactId'),
      rendererVersion: nonBlank(showcaseValue.rendererVersion, 'v3 showcase.rendererVersion'),
      profileId: 'editorial-showcase-v1',
      generationMode: enumValue(
        showcaseValue.generationMode,
        new Set(['model', 'fallback']),
        'v3 showcase.generationMode',
      ),
      showcaseOutlineSignature: sha256(
        showcaseValue.showcaseOutlineSignature,
        'v3 showcase.showcaseOutlineSignature',
      ),
    };
  } else if (showcaseValue.status === 'unavailable') {
    exactKeys(showcaseValue, ['status', 'reasonCode'], [], 'v3 showcase');
    showcase = {
      status: 'unavailable',
      reasonCode: enumValue(
        showcaseValue.reasonCode,
        new Set(REPORT_PACKAGE_SHOWCASE_UNAVAILABLE_REASON_CODES),
        'v3 showcase.reasonCode',
      ),
    };
    if (preferredHtml !== 'canonical') fail('v3 preferredHtml');
  } else {
    return fail('v3 showcase.status');
  }
  return {
    version: REPORT_PACKAGE_V3_VERSION,
    taskId: nonBlank(candidate.taskId, 'v3 taskId'),
    planVersionId: nonBlank(candidate.planVersionId, 'v3 planVersionId'),
    attemptId: nonBlank(candidate.attemptId, 'v3 attemptId'),
    reportPublicationId: nonBlank(candidate.reportPublicationId, 'v3 reportPublicationId'),
    canonicalPackageArtifactId: nonBlank(
      candidate.canonicalPackageArtifactId,
      'v3 canonicalPackageArtifactId',
    ),
    canonicalPackageContentSha256: sha256(
      candidate.canonicalPackageContentSha256,
      'v3 canonicalPackageContentSha256',
    ),
    preferredHtml,
    showcase,
  };
}

export function parseReportPackageV2(value: unknown): ReportPackageV2 {
  const candidate = record(value, 'value');
  exactKeys(candidate, [
    'version',
    'taskId',
    'planVersionId',
    'attemptId',
    'reportPublicationId',
    'presentationMode',
    'deliverableArtifactId',
    'evidenceManifestArtifactId',
    'reportReviewArtifactId',
    'sourceReportDocumentArtifactId',
    'sourceReportDocumentContentSha256',
    'layout',
    'assetSnapshot',
    'standaloneHtml',
    'notices',
  ], [
    'crossSkillReviewArtifactId',
    'contributionLedgerArtifactId',
    'contributionSummaryArtifactId',
  ], 'value');
  if (candidate.version !== REPORT_PACKAGE_V2_VERSION) fail('version');
  if (candidate.presentationMode !== 'multimodal') fail('presentationMode');

  const optionalContributionIds = [
    candidate.crossSkillReviewArtifactId,
    candidate.contributionLedgerArtifactId,
    candidate.contributionSummaryArtifactId,
  ];
  const contributionCount = optionalContributionIds.filter((item) => item !== undefined).length;
  if (contributionCount !== 0 && contributionCount !== optionalContributionIds.length) {
    fail('contribution component set');
  }
  const notices = array(candidate.notices, 'notices').map(parseNotice);
  if (new Set(notices.map(({ id }) => id)).size !== notices.length) fail('notices.id');

  return {
    version: REPORT_PACKAGE_V2_VERSION,
    taskId: nonBlank(candidate.taskId, 'taskId'),
    planVersionId: nonBlank(candidate.planVersionId, 'planVersionId'),
    attemptId: nonBlank(candidate.attemptId, 'attemptId'),
    reportPublicationId: nonBlank(candidate.reportPublicationId, 'reportPublicationId'),
    presentationMode: 'multimodal',
    deliverableArtifactId: nonBlank(candidate.deliverableArtifactId, 'deliverableArtifactId'),
    evidenceManifestArtifactId: nonBlank(
      candidate.evidenceManifestArtifactId,
      'evidenceManifestArtifactId',
    ),
    reportReviewArtifactId: nonBlank(candidate.reportReviewArtifactId, 'reportReviewArtifactId'),
    sourceReportDocumentArtifactId: nonBlank(
      candidate.sourceReportDocumentArtifactId,
      'sourceReportDocumentArtifactId',
    ),
    sourceReportDocumentContentSha256: sha256(
      candidate.sourceReportDocumentContentSha256,
      'sourceReportDocumentContentSha256',
    ),
    ...(candidate.crossSkillReviewArtifactId === undefined
      ? {}
      : { crossSkillReviewArtifactId: nonBlank(candidate.crossSkillReviewArtifactId, 'crossSkillReviewArtifactId') }),
    ...(candidate.contributionLedgerArtifactId === undefined
      ? {}
      : { contributionLedgerArtifactId: nonBlank(candidate.contributionLedgerArtifactId, 'contributionLedgerArtifactId') }),
    ...(candidate.contributionSummaryArtifactId === undefined
      ? {}
      : { contributionSummaryArtifactId: nonBlank(candidate.contributionSummaryArtifactId, 'contributionSummaryArtifactId') }),
    layout: parseLayout(candidate.layout),
    assetSnapshot: parseAssetSnapshot(candidate.assetSnapshot),
    standaloneHtml: parseStandaloneHtml(candidate.standaloneHtml),
    notices,
  };
}
