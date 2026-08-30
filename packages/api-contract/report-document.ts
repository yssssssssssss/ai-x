import type { ChartSpec, VisualAssetReference } from './research-deliverable.ts';

export interface ReportParagraphBlockV1V2 {
  id: string;
  type: 'paragraph';
  text: string;
}

export interface ReportFactBlockV1V2 {
  id: string;
  type: 'fact';
  text: string;
  evidenceIds: string[];
}

export interface ReportMetricBlockV1V2 {
  id: string;
  type: 'metric';
  label: string;
  value: number;
  evidenceIds: string[];
}

export interface ReportListBlockV1V2 {
  id: string;
  type: 'list';
  items: string[];
}

export interface ReportProjectionListBlockV2 {
  id: string;
  type: 'projection-list';
  items: string[];
  sourcePointers: string[];
  sourceNodeIds?: string[];
  summary: boolean;
}

export type ReportAnswerKindV1V2 =
  | 'direct_answer'
  | 'evidence_finding'
  | 'strategy_map'
  | 'mind_model'
  | 'comparison_matrix'
  | 'design_principle'
  | 'opportunity'
  | 'priority_matrix'
  | 'action_plan'
  | 'risk';

export interface ReportAnswerBlockV2 {
  id: string;
  type: 'answer';
  kind: ReportAnswerKindV1V2;
  title: string;
  text: string;
  items: string[];
  questionIds: string[];
  evidenceIds: string[];
  findingIds: string[];
  summaryIds: string[];
  confidence?: number;
  answerStatus?: 'supported' | 'provisional' | 'unanswered';
  sourcePointers: string[];
  sourceNodeIds?: string[];
  summary: boolean;
}

export interface ReportImageBlockV1V2 {
  id: string;
  type: 'image';
  assetRef: VisualAssetReference;
  caption: string;
  altText: string;
  evidenceIds?: string[];
}

export interface ReportImageComparisonBlockV1V2 {
  id: string;
  type: 'image-comparison';
  beforeAssetRef: VisualAssetReference;
  afterAssetRef: VisualAssetReference;
  caption: string;
  altText: string;
  evidenceIds?: string[];
}

export interface ReportChartBlockV1V2 {
  id: string;
  type: 'chart';
  chartRef: VisualAssetReference & { chartId: string };
  specHash: string;
  spec: ChartSpec;
  table: ReportChartTableAlternativeV3;
  caption: string;
  altText: string;
}

export type ReportBlockV1V2 =
  | ReportParagraphBlockV1V2
  | ReportFactBlockV1V2
  | ReportMetricBlockV1V2
  | ReportListBlockV1V2
  | ReportProjectionListBlockV2
  | ReportAnswerBlockV2
  | ReportImageBlockV1V2
  | ReportImageComparisonBlockV1V2
  | ReportChartBlockV1V2;

export interface ReportSectionV1V2 {
  id: string;
  title: string;
  questionIds: string[];
  blocks: ReportBlockV1V2[];
  prominence?: 'primary' | 'supporting' | 'appendix';
}

export interface ReportDocumentV1V2 {
  version: 'report-document-v1' | 'report-document-v2';
  title: string;
  subtitle: string;
  executiveSummary: string;
  sections: ReportSectionV1V2[];
  sourceDeliverableArtifactId?: string;
  projectionMode?: 'full' | 'summary';
  coveredPointers?: string[];
  omittedPointers?: Array<{ pointer: string; reason: string }>;
  layoutMode?: 'model' | 'fallback';
  layoutWarnings?: string[];
}

export const REPORT_VIEW_IDS_V1 = [
  'answers',
  'topics',
  'actions',
  'evidence',
  'analysis',
] as const;

export type ReportViewIdV1 = (typeof REPORT_VIEW_IDS_V1)[number];

export type ReportVisibilityV1 = 'always' | 'collapsible';

export type ReportNoticeCodeV1 =
  | 'layout_fallback'
  | 'copy_fallback'
  | 'data_policy_fallback'
  | 'editorial_adapter_fallback'
  | 'optional_visual_omitted'
  | 'requested_artifact_unfulfilled'
  | 'visualization_linearized'
  | 'export_attachment_omitted'
  | 'renderer_compatibility_fallback'
  | 'html_unavailable'
  | 'zero_unavailable'
  | 'legacy_trace_incomplete';

export interface ReportNoticeV1 {
  id: string;
  code: ReportNoticeCodeV1;
  severity: 'info' | 'warning' | 'action_required';
  scope: 'report' | 'section' | 'block' | 'export';
  relatedUnitIds: string[];
}

export interface ReportTraceOriginV1 {
  artifactId: string;
  contentSha256: string;
  schemaVersion: string;
  jsonPointer: string;
  sourceNodeIds: string[];
  reviewState: 'passed' | 'passed_with_conditions';
}

export interface ReportTraceV1 {
  supportMode: 'direct' | 'inherited' | 'none' | 'system_derived';
  origins: ReportTraceOriginV1[];
  questionIds: string[];
  evidenceIds: string[];
  findingIds: string[];
  summaryIds: string[];
  status?: 'supported' | 'provisional' | 'unanswered';
  confidence?: number;
}

export interface ReportSemanticManifestV1 {
  version: 'report-semantic-manifest-v1';
  presentationUnitIds: string[];
  leafUnitIds: string[];
  assetIds: string[];
  auditRecordIds: string[];
  noticeIds: string[];
}

export interface ReportAuditAppendixV1 {
  version: 'report-audit-appendix-v1';
  visibility: 'collapsible';
  sourceArtifactIds: string[];
  records: Array<{
    id: string;
    contributionArtifactId: string;
    sourceUnitKey: string;
    sourceSemanticHash: string;
    disposition: 'included' | 'merged' | 'conflicted' | 'omitted';
    canonicalNodeIds: string[];
    reasonCode?: string;
    reviewIssueIds: string[];
  }>;
}

export interface ReportBlockBaseV3 {
  id: string;
  title?: string;
  visibility: ReportVisibilityV1;
  unitRefs: string[];
  leafRefs: string[];
}

export interface ReportListItemV3 {
  id: string;
  leafRef: string;
  label?: string;
  text: string;
}

export interface ReportChartTableAlternativeV3 {
  caption: string;
  columns: string[];
  rows: Array<{
    key: string;
    label: string;
    cells: Array<number | null>;
    evidenceIds: string[][];
  }>;
}

export type ReportAnswerKindV3 =
  | 'direct_answer'
  | 'evidence_finding'
  | 'strategy_map'
  | 'mind_model'
  | 'comparison_matrix'
  | 'design_principle'
  | 'opportunity'
  | 'priority_matrix'
  | 'action_plan'
  | 'channel_strategy'
  | 'limitation'
  | 'open_question'
  | 'risk';

export interface ReportAssetReferenceV3 {
  assetId: string;
  manifestArtifactId: string;
}

export type ReportLegacyShapeBlockV3 =
  | (ReportBlockBaseV3 & {
      type: 'paragraph';
      leafRef: string;
      text: string;
    })
  | (ReportBlockBaseV3 & {
      type: 'fact';
      leafRef: string;
      text: string;
    })
  | (ReportBlockBaseV3 & {
      type: 'metric';
      leafRef: string;
      label: string;
      value: number;
      unit?: string;
    })
  | (ReportBlockBaseV3 & {
      type: 'list';
      ordered: boolean;
      items: ReportListItemV3[];
    })
  | (ReportBlockBaseV3 & {
      type: 'answer';
      kind: ReportAnswerKindV3;
      textLeafRef: string;
      text: string;
      items: ReportListItemV3[];
      answerStatus?: 'supported' | 'provisional' | 'unanswered';
    })
  | (ReportBlockBaseV3 & {
      type: 'image';
      leafRef: string;
      assetRef: ReportAssetReferenceV3;
      caption: string;
      altText: string;
    })
  | (ReportBlockBaseV3 & {
      type: 'image-comparison';
      beforeLeafRef: string;
      afterLeafRef: string;
      beforeAssetRef: ReportAssetReferenceV3;
      afterAssetRef: ReportAssetReferenceV3;
      caption: string;
      altText: string;
    })
  | (ReportBlockBaseV3 & {
      type: 'chart';
      leafRef: string;
      chartRef: ReportAssetReferenceV3 & { chartId: string };
      specHash: string;
      spec: ChartSpec;
      table: ReportChartTableAlternativeV3;
      caption: string;
      altText: string;
    });

export interface ReportRecordTableBlockV3 extends ReportBlockBaseV3 {
  type: 'record-table';
  columns: Array<{ key: string; label: string }>;
  rows: Array<{
    id: string;
    label?: string;
    cells: Array<{
      leafRef: string;
      columnKey: string;
      value: string | number | boolean | null;
    }>;
  }>;
}

export interface ReportGraphBlockV3 extends ReportBlockBaseV3 {
  type: 'graph';
  variant: 'linear' | 'hub_spoke' | 'two_sided';
  nodes: Array<{
    id: string;
    leafRef: string;
    label: string;
    description?: string;
  }>;
  edges: Array<{
    id: string;
    leafRef: string;
    from: string;
    to: string;
    label?: string;
  }>;
}

export interface ReportPriorityBoardBlockV3 extends ReportBlockBaseV3 {
  type: 'priority-board';
  groups: Array<{
    priority: 'P0' | 'P1' | 'P2';
    items: Array<{
      id: string;
      leafRef: string;
      action: string;
      owner?: string;
      rationale?: string;
      validationMethod?: string;
    }>;
  }>;
}

export type ReportBlockV3 =
  | ReportLegacyShapeBlockV3
  | ReportRecordTableBlockV3
  | ReportGraphBlockV3
  | ReportPriorityBoardBlockV3;

export interface ReportSectionV3 {
  id: string;
  title: string;
  view: ReportViewIdV1;
  prominence: 'primary' | 'supporting' | 'appendix';
  blocks: ReportBlockV3[];
}

export interface ReportDocumentV3 {
  version: 'report-document-v3';
  title: string;
  subtitle: string;
  executiveSummary: string;
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  sections: ReportSectionV3[];
  sourceDeliverableArtifactId: string;
  sourceDeliverableContentSha256: string;
  projectionMode: 'full';
  layoutMode: 'model' | 'fallback';
  traceIndex: Record<string, ReportTraceV1>;
  semanticManifest: ReportSemanticManifestV1;
  auditAppendix?: ReportAuditAppendixV1;
  notices: ReportNoticeV1[];
}

export interface ReportEditorialCopyFragmentV4 {
  id: string;
  provenance: 'model' | 'canonical' | 'system';
  text: string;
  sourceLeafIds: string[];
}

export interface ReportCardGridBlockV4 extends ReportBlockBaseV3 {
  type: 'card-grid';
  digest?: ReportEditorialCopyFragmentV4;
  cards: Array<{
    id: string;
    title: string;
    body?: string;
    status?: string;
    leafRefs: string[];
  }>;
}

export interface ReportStageFlowBlockV4 extends ReportBlockBaseV3 {
  type: 'stage-flow';
  digest?: ReportEditorialCopyFragmentV4;
  stages: Array<{
    id: string;
    label: string;
    description?: string;
    timeLabel?: string;
    leafRefs: string[];
  }>;
}

export type ReportBlockV4 =
  | (ReportBlockV3 & { digest?: ReportEditorialCopyFragmentV4 })
  | ReportCardGridBlockV4
  | ReportStageFlowBlockV4;

export interface ReportSectionV4 {
  id: string;
  title: ReportEditorialCopyFragmentV4;
  lead?: ReportEditorialCopyFragmentV4;
  transition?: ReportEditorialCopyFragmentV4;
  view: ReportViewIdV1;
  prominence: 'primary' | 'supporting' | 'appendix';
  blocks: ReportBlockV4[];
}

export interface ReportSemanticManifestV2 extends Omit<ReportSemanticManifestV1, 'version'> {
  version: 'report-semantic-manifest-v2';
  copyFragmentIds: string[];
}

export interface ReportDocumentV4 {
  version: 'report-document-v4';
  title: ReportEditorialCopyFragmentV4;
  subtitle: string;
  executiveSummary: ReportEditorialCopyFragmentV4;
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  copyMode: 'model' | 'mixed' | 'fallback';
  sections: ReportSectionV4[];
  sourceDeliverableArtifactId: string;
  sourceDeliverableContentSha256: string;
  projectionMode: 'full';
  layoutMode: 'model' | 'fallback';
  traceIndex: Record<string, ReportTraceV1>;
  semanticManifest: ReportSemanticManifestV2;
  auditAppendix?: ReportAuditAppendixV1;
  notices: ReportNoticeV1[];
}

export type ReadableReportDocument = ReportDocumentV1V2 | ReportDocumentV3 | ReportDocumentV4;

export type RenderableReportDocument = ReadableReportDocument;

export function isReportDocumentV3(value: RenderableReportDocument | { version?: string }): value is ReportDocumentV3 {
  return value.version === 'report-document-v3';
}

export function isReportDocumentV4(value: RenderableReportDocument | { version?: string }): value is ReportDocumentV4 {
  return value.version === 'report-document-v4';
}
