import type { ChartSpec } from './research-deliverable.ts';
import type {
  ReportChartTableAlternativeV3,
  ReportViewIdV1,
} from './report-document.ts';

export const REPORT_PRESENTATIONS_V1 = [
  'answer',
  'paragraph',
  'fact',
  'list',
  'record-table',
  'graph',
  'priority-board',
  'card-grid',
  'stage-flow',
  'image',
  'image-comparison',
  'chart',
] as const;

export type ReportPresentationV1 = (typeof REPORT_PRESENTATIONS_V1)[number];

export type ReportEditorialSemanticKindV1 =
  | 'direct_answer'
  | 'narrative'
  | 'comparison_matrix'
  | 'strategy_map'
  | 'mind_model'
  | 'design_principle'
  | 'opportunity'
  | 'prioritized_action'
  | 'action_plan'
  | 'channel_strategy'
  | 'research_plan_overview'
  | 'research_plan_questions'
  | 'research_plan_methods'
  | 'research_plan_execution'
  | 'research_plan_deliverables'
  | 'research_plan_quality'
  | 'evidence_finding'
  | 'limitation'
  | 'open_question'
  | 'risk'
  | 'requested_artifact_binding'
  | 'visual_asset'
  | 'visual_comparison'
  | 'verified_chart';

export type EditorialScalar = string | number | boolean | null;

export interface EditorialLeafTrace {
  supportMode: 'direct' | 'inherited' | 'none' | 'system_derived';
  origins: Array<{
    artifactId: string;
    contentSha256: string;
    schemaVersion: string;
    jsonPointer: string;
    sourceNodeIds: string[];
    reviewState: 'passed' | 'passed_with_conditions';
  }>;
  support: {
    questionIds: string[];
    evidenceIds: string[];
    findingIds: string[];
    summaryIds: string[];
    status?: 'supported' | 'provisional' | 'unanswered';
    confidence?: number;
  };
}

export interface EditorialAssetReference {
  assetId: string;
  manifestArtifactId: string;
  contentSha256: string;
  manifestHash: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  exportPolicy: 'allow' | 'mask';
}

export type EditorialAssetSourceSummary =
  | { kind: 'browser_capture'; pageTitle: string; domain: string; capturedAt: string }
  | { kind: 'user_upload'; fileName: string; role: string }
  | { kind: 'tool_artifact' | 'derived'; role: string };

export interface EditorialPresentationUnitBaseV1 {
  id: string;
  semanticKind: ReportEditorialSemanticKindV1;
  title?: string;
  leafIds: string[];
}

export type ReportEditorialPresentationUnitV1 =
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'text';
      leafId: string;
      text: string;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'record';
      leafId: string;
      fields: Array<{ key: string; label: string; value: EditorialScalar }>;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'matrix';
      rows: string[];
      columns: string[];
      cells: Array<{
        leafId: string;
        row: string;
        column: string;
        value: EditorialScalar;
      }>;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'graph';
      nodes: Array<{
        id: string;
        leafId: string;
        label: string;
        description: string;
      }>;
      edges: Array<{
        id: string;
        leafId: string;
        from: string;
        to: string;
        label: string;
      }>;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'actions';
      actions: Array<{
        leafId: string;
        priority?: 'P0' | 'P1' | 'P2';
        action: string;
        owner?: string;
        rationale?: string;
        validationMethod?: string;
      }>;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'records';
      records: Array<{
        id: string;
        leafId: string;
        title: string;
        body?: string;
        status?: string;
        fields: Array<{ key: string; label: string; value: EditorialScalar }>;
      }>;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'stages';
      stages: Array<{
        id: string;
        leafId: string;
        label: string;
        description?: string;
        activities: string[];
        timeLabel?: string;
        outputs: string[];
      }>;
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'asset';
      leafId: string;
      assetRef: EditorialAssetReference;
      sourceSummary: EditorialAssetSourceSummary;
      canonicalBindingIds: string[];
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'asset_pair';
      original: {
        leafId: string;
        assetRef: EditorialAssetReference;
        sourceSummary: EditorialAssetSourceSummary;
      };
      annotation: {
        leafId: string;
        assetRef: EditorialAssetReference;
        overlayArtifactId: string;
      };
      findingIds: string[];
      canonicalBindingIds: string[];
    })
  | (EditorialPresentationUnitBaseV1 & {
      shape: 'chart';
      leafId: string;
      chartRef: {
        chartId: string;
        chartSpecArtifactId: string;
        chartSpecArtifactContentSha256: string;
        assetId: string;
        manifestArtifactId: string;
      };
      specHash: string;
      spec: ChartSpec;
      table: ReportChartTableAlternativeV3;
      dataArtifactRef?: {
        artifactId: string;
        contentSha256: string;
        schemaVersion: string;
      };
      evidenceIds: string[];
      canonicalBindingIds: string[];
    });

export interface ReportEditorialBindingV1 {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  deliverableContentSha256: string;
  reportReviewArtifactId: string;
}

export interface ReportEditorialMaterialV1 {
  version: 'report-editorial-material-v1';
  binding: ReportEditorialBindingV1;
  document: {
    title: string;
    decisionContext?: string;
    executiveAnswer?: string;
    deliverableType: string;
    requestedArtifactTypes: string[];
  };
  presentationUnits: ReportEditorialPresentationUnitV1[];
  leafTraceIndex: Record<string, EditorialLeafTrace>;
  constraints: {
    requiredQuestionIds: string[];
    requiredPresentationUnitIds: string[];
    requiredLeafUnitIds: string[];
    allowedViews: ReportViewIdV1[];
    projectionProfilesByUnitId: Record<string, ReportPresentationV1[]>;
  };
}

export interface ReportAuditAppendixMaterialV1 {
  version: 'report-audit-appendix-material-v1';
  binding: ReportEditorialBindingV1;
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

export interface ReportEditorialBlueprintBlockV1 {
  presentation: ReportPresentationV1;
  unitRefs: string[];
  visibility: 'always' | 'collapsible';
  variant?: 'linear' | 'hub_spoke' | 'two_sided';
}

export interface ReportEditorialBlueprintV1 {
  version: 'report-editorial-blueprint-v1';
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  sections: Array<{
    headingMode: 'view_label' | 'first_source_title';
    view: ReportViewIdV1;
    prominence: 'primary' | 'supporting' | 'appendix';
    blocks: ReportEditorialBlueprintBlockV1[];
  }>;
}

/**
 * Optional publication copy produced alongside a v1 Blueprint. Targets use
 * ordinals because the Blueprint is not allowed to carry generated IDs.
 */
export type ReportEditorialCopyTargetV2 =
  | { kind: 'report_title' }
  | { kind: 'executive_summary' }
  | { kind: 'section_title'; sectionIndex: number }
  | { kind: 'section_lead'; sectionIndex: number }
  | { kind: 'section_transition'; sectionIndex: number }
  | { kind: 'block_digest'; sectionIndex: number; blockIndex: number };

export interface ReportEditorialCopyFragmentV2 {
  target: ReportEditorialCopyTargetV2;
  text: string;
  sourceLeafIds: string[];
}

/** One model response carries both layout and optional editorial copy. */
export interface ReportEditorialPlannerOutputV2 {
  version: 'report-editorial-plan-v2';
  blueprint: ReportEditorialBlueprintV1;
  copyFragments: ReportEditorialCopyFragmentV2[];
}

/**
 * Partial editorial selection produced by the LLM. The Intent Compiler
 * deterministically completes all unselected units into supporting or appendix
 * sections to produce a strict ReportEditorialBlueprintV1.
 *
 * Intentionally reuses the same block and copy types as the full Blueprint;
 * only the section prominence is narrowed (no appendix allowed in Intent).
 */
export interface ReportEditorialIntentV1 {
  version: 'report-editorial-intent-v1';
  style: 'editorial' | 'analytical' | 'operational';
  density: 'comfortable' | 'compact';
  mainSections: Array<{
    headingMode: 'view_label' | 'first_source_title';
    view: ReportViewIdV1;
    prominence: 'primary' | 'supporting';
    blocks: ReportEditorialBlueprintBlockV1[];
  }>;
  copyFragments: ReportEditorialCopyFragmentV2[];
}

/** Deterministic placement policy derived from Material, not from the model. */
export interface EditorialPlacementPolicy {
  mandatoryBodyUnitIds: string[];
  mainCoverageGroups: Array<{
    label: string;
    unitIds: string[];
  }>;
  systemSupportingUnitIds: string[];
  fallbackPrimaryUnitId?: string;
}

export type ReportEditorialCopyRejectionReasonV2 =
  | 'target_out_of_range'
  | 'duplicate_target'
  | 'empty_text'
  | 'not_plain_text'
  | 'length_limit'
  | 'empty_source_leaf_ids'
  | 'duplicate_source_leaf_id'
  | 'unknown_source_leaf_id'
  | 'source_scope_mismatch'
  | 'unsupported_protected_token';

export interface ReportEditorialCopyRejectionV2 {
  fragmentIndex: number;
  target: ReportEditorialCopyTargetV2;
  reasonCodes: ReportEditorialCopyRejectionReasonV2[];
}

export interface ReportEditorialCopySelectionV2 {
  fragments: ReportEditorialCopyFragmentV2[];
  rejectedFragments: ReportEditorialCopyRejectionV2[];
}

/**
 * The deliberately smaller, model-visible projection of ReportEditorialMaterialV1.
 * It keeps reviewed Canonical prose and structure, but cannot represent Artifact
 * locations, trace origins, binary Assets, complete Chart specs, or table fallbacks.
 */
export type ReportEditorialPlannerPresentationUnitV1 =
  | {
      id: string;
      semanticKind: ReportEditorialSemanticKindV1;
      title?: string;
      shape: 'text';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      text: string;
    }
  | {
      id: string;
      semanticKind: ReportEditorialSemanticKindV1;
      title?: string;
      shape: 'record';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      fields: Array<{ key: string; label: string; value: EditorialScalar }>;
    }
  | {
      id: string;
      semanticKind: ReportEditorialSemanticKindV1;
      title?: string;
      shape: 'matrix';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      rows: string[];
      columns: string[];
      cells: Array<{
        leafId: string;
        row: string;
        column: string;
        value: EditorialScalar;
      }>;
    }
  | {
      id: string;
      semanticKind: ReportEditorialSemanticKindV1;
      title?: string;
      shape: 'graph';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      nodes: Array<{ id: string; leafId: string; label: string; description: string }>;
      edges: Array<{ id: string; leafId: string; from: string; to: string; label: string }>;
    }
  | {
      id: string;
      semanticKind: ReportEditorialSemanticKindV1;
      title?: string;
      shape: 'actions';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      actions: Array<{
        leafId: string;
        priority?: 'P0' | 'P1' | 'P2';
        action: string;
        owner?: string;
        rationale?: string;
        validationMethod?: string;
      }>;
    }
  | {
      id: string;
      semanticKind: ReportEditorialSemanticKindV1;
      title?: string;
      shape: 'records';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      records: Array<{
        id: string;
        leafId: string;
        title: string;
        body?: string;
        status?: string;
        fields: Array<{ key: string; label: string; value: EditorialScalar }>;
      }>;
    }
  | {
      id: string;
      semanticKind: 'research_plan_execution';
      title?: string;
      shape: 'stages';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      stages: Array<{
        id: string;
        leafId: string;
        label: string;
        description?: string;
        activities: string[];
        timeLabel?: string;
        outputs: string[];
      }>;
    }
  | {
      id: string;
      semanticKind: 'visual_asset';
      title?: string;
      shape: 'asset';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      sourceSummary: EditorialAssetSourceSummary;
      canonicalBindingIds: string[];
    }
  | {
      id: string;
      semanticKind: 'visual_comparison';
      title?: string;
      shape: 'asset_pair';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      originalSourceSummary: EditorialAssetSourceSummary;
      annotationRole: 'annotation';
      findingIds: string[];
      canonicalBindingIds: string[];
    }
  | {
      id: string;
      semanticKind: 'verified_chart';
      title?: string;
      shape: 'chart';
      leafIds: string[];
      requiredView: ReportViewIdV1;
      requiredVisibility: 'always' | 'collapsible';
      allowedPresentations: ReportPresentationV1[];
      chart: {
        title: string;
        type: ChartSpec['type'];
        categoryCount: number;
        seriesCount: number;
        pointCount: number;
        evidenceIds: string[];
        canonicalBindingIds: string[];
      };
    };

export interface ReportEditorialPlannerInputV1 {
  version: 'report-editorial-planner-input-v1';
  document: ReportEditorialMaterialV1['document'];
  presentationUnits: ReportEditorialPlannerPresentationUnitV1[];
  leafSupportIndex: Record<string, {
    supportMode: EditorialLeafTrace['supportMode'];
    support: EditorialLeafTrace['support'];
  }>;
  constraints: {
    requiredQuestionIds: string[];
    requiredPresentationUnitIds: string[];
    allowedViews: ReportViewIdV1[];
  };
  placementPolicy: EditorialPlacementPolicy;
}
