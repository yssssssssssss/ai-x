import type {
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
  ReportEditorialCopyFragmentV4,
} from '../api-contract/report-document.ts';
import type { ReportReviewArtifact } from '../api-contract/control-workflow.ts';
import type {
  ContributionLedgerV1,
  ContributionSummaryV1,
} from '../api-contract/research-deliverable.ts';
import {
  assertReportDocumentV3Integrity,
  assertReportDocumentV4Integrity,
} from './report-document-visitor.ts';

export function safeReportReview(review: ReportReviewArtifact): Record<string, unknown> {
  return {
    version: review.version,
    taskId: review.taskId,
    planVersionId: review.planVersionId,
    attemptId: review.attemptId,
    verdict: review.verdict,
    dimensions: review.dimensions.map((dimension) => ({
      id: dimension.id,
      passed: dimension.passed,
      issues: [...dimension.issues],
    })),
    revisionRound: review.revisionRound,
  };
}

export function safeContributionSummary(summary: ContributionSummaryV1): Record<string, unknown> {
  return {
    version: summary.version,
    taskId: summary.taskId,
    planVersionId: summary.planVersionId,
    attemptId: summary.attemptId,
    contributors: summary.contributors.map((contributor) => ({
      invocationId: contributor.invocationId,
      skillId: contributor.skillId,
      contributionTypes: [...contributor.contributionTypes],
      unitCount: contributor.unitCount,
      dispositions: contributor.dispositions.map((disposition) => ({
        sourceUnitKey: disposition.sourceUnitKey,
        disposition: disposition.disposition,
        canonicalNodeIds: [...disposition.canonicalNodeIds],
      })),
    })),
  };
}

export function safeContributionLedger(ledger: ContributionLedgerV1): Record<string, unknown> {
  return {
    version: ledger.version,
    taskId: ledger.taskId,
    planVersionId: ledger.planVersionId,
    attemptId: ledger.attemptId,
    entries: ledger.entries.map((entry) => ({
      contributionArtifactId: entry.contributionArtifactId,
      invocationId: entry.invocationId,
      sourceUnitKey: entry.sourceUnitKey,
      sourceSemanticHash: entry.sourceSemanticHash,
      disposition: entry.disposition,
      canonicalNodeIds: [...entry.canonicalNodeIds],
      reviewIssueIds: [...entry.reviewIssueIds],
    })),
  };
}

function blockBase(block: ReportBlockV3 | ReportBlockV4): Record<string, unknown> {
  return {
    id: block.id,
    ...(block.title ? { title: block.title } : {}),
    type: block.type,
    visibility: block.visibility,
    unitRefs: [...block.unitRefs],
    leafRefs: [...block.leafRefs],
  };
}

function safeBlock(block: ReportBlockV3): Record<string, unknown> {
  const base = blockBase(block);
  switch (block.type) {
    case 'paragraph':
    case 'fact':
      return { ...base, leafRef: block.leafRef, text: block.text };
    case 'metric':
      return {
        ...base,
        leafRef: block.leafRef,
        label: block.label,
        value: block.value,
        ...(block.unit ? { unit: block.unit } : {}),
      };
    case 'list':
      return {
        ...base,
        ordered: block.ordered,
        items: block.items.map((item) => ({
          id: item.id,
          leafRef: item.leafRef,
          ...(item.label ? { label: item.label } : {}),
          text: item.text,
        })),
      };
    case 'answer':
      return {
        ...base,
        kind: block.kind,
        textLeafRef: block.textLeafRef,
        text: block.text,
        items: block.items.map((item) => ({
          id: item.id,
          leafRef: item.leafRef,
          ...(item.label ? { label: item.label } : {}),
          text: item.text,
        })),
        ...(block.answerStatus ? { answerStatus: block.answerStatus } : {}),
      };
    case 'image':
      return {
        ...base,
        leafRef: block.leafRef,
        assetRef: { ...block.assetRef },
        caption: block.caption,
        altText: block.altText,
      };
    case 'image-comparison':
      return {
        ...base,
        beforeLeafRef: block.beforeLeafRef,
        afterLeafRef: block.afterLeafRef,
        beforeAssetRef: { ...block.beforeAssetRef },
        afterAssetRef: { ...block.afterAssetRef },
        caption: block.caption,
        altText: block.altText,
      };
    case 'chart':
      return {
        ...base,
        leafRef: block.leafRef,
        chartRef: { ...block.chartRef },
        specHash: block.specHash,
        spec: block.spec,
        table: block.table,
        caption: block.caption,
        altText: block.altText,
      };
    case 'record-table':
      return {
        ...base,
        columns: block.columns.map((column) => ({ ...column })),
        rows: block.rows.map((row) => ({
          id: row.id,
          ...(row.label ? { label: row.label } : {}),
          cells: row.cells.map((cell) => ({ ...cell })),
        })),
      };
    case 'graph':
      return {
        ...base,
        variant: block.variant,
        nodes: block.nodes.map((node) => ({ ...node })),
        edges: block.edges.map((edge) => ({ ...edge })),
      };
    case 'priority-board':
      return {
        ...base,
        groups: block.groups.map((group) => ({
          priority: group.priority,
          items: group.items.map((item) => ({ ...item })),
        })),
      };
  }
}

export function safeReportDocumentV3(document: ReportDocumentV3): Record<string, unknown> {
  assertReportDocumentV3Integrity(document);
  return {
    version: document.version,
    title: document.title,
    subtitle: document.subtitle,
    executiveSummary: document.executiveSummary,
    style: document.style,
    density: document.density,
    sections: document.sections.map((section) => ({
      id: section.id,
      title: section.title,
      view: section.view,
      prominence: section.prominence,
      blocks: section.blocks.map(safeBlock),
    })),
    sourceDeliverableArtifactId: document.sourceDeliverableArtifactId,
    sourceDeliverableContentSha256: document.sourceDeliverableContentSha256,
    projectionMode: document.projectionMode,
    layoutMode: document.layoutMode,
    traceIndex: Object.fromEntries(Object.entries(document.traceIndex).map(([leafId, trace]) => [
      leafId,
      {
        supportMode: trace.supportMode,
        origins: trace.origins.map((origin) => ({
          artifactId: origin.artifactId,
          contentSha256: origin.contentSha256,
          schemaVersion: origin.schemaVersion,
          jsonPointer: origin.jsonPointer,
          sourceNodeIds: [...origin.sourceNodeIds],
          reviewState: origin.reviewState,
        })),
        questionIds: [...trace.questionIds],
        evidenceIds: [...trace.evidenceIds],
        findingIds: [...trace.findingIds],
        summaryIds: [...trace.summaryIds],
        ...(trace.status ? { status: trace.status } : {}),
        ...(typeof trace.confidence === 'number' ? { confidence: trace.confidence } : {}),
      },
    ])),
    semanticManifest: {
      version: document.semanticManifest.version,
      presentationUnitIds: [...document.semanticManifest.presentationUnitIds],
      leafUnitIds: [...document.semanticManifest.leafUnitIds],
      assetIds: [...document.semanticManifest.assetIds],
      auditRecordIds: [...document.semanticManifest.auditRecordIds],
      noticeIds: [...document.semanticManifest.noticeIds],
    },
    ...(document.auditAppendix ? {
      auditAppendix: {
        version: document.auditAppendix.version,
        visibility: document.auditAppendix.visibility,
        sourceArtifactIds: [...document.auditAppendix.sourceArtifactIds],
        records: document.auditAppendix.records.map((record) => ({
          id: record.id,
          contributionArtifactId: record.contributionArtifactId,
          sourceUnitKey: record.sourceUnitKey,
          sourceSemanticHash: record.sourceSemanticHash,
          disposition: record.disposition,
          canonicalNodeIds: [...record.canonicalNodeIds],
          ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
          reviewIssueIds: [...record.reviewIssueIds],
        })),
      },
    } : {}),
    notices: document.notices.map((notice) => ({
      id: notice.id,
      code: notice.code,
      severity: notice.severity,
      scope: notice.scope,
      relatedUnitIds: [...notice.relatedUnitIds],
    })),
  };
}

function safeCopyFragmentV4(fragment: ReportEditorialCopyFragmentV4): Record<string, unknown> {
  return {
    id: fragment.id,
    provenance: fragment.provenance,
    text: fragment.text,
    sourceLeafIds: [...fragment.sourceLeafIds],
  };
}

function safeBlockV4(block: ReportBlockV4): Record<string, unknown> {
  if (block.type === 'card-grid') {
    return {
      ...blockBase(block),
      ...(block.digest ? { digest: safeCopyFragmentV4(block.digest) } : {}),
      cards: block.cards.map((card) => ({
        id: card.id,
        title: card.title,
        ...(card.body ? { body: card.body } : {}),
        ...(card.status ? { status: card.status } : {}),
        leafRefs: [...card.leafRefs],
      })),
    };
  }
  if (block.type === 'stage-flow') {
    return {
      ...blockBase(block),
      ...(block.digest ? { digest: safeCopyFragmentV4(block.digest) } : {}),
      stages: block.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        ...(stage.description ? { description: stage.description } : {}),
        ...(stage.timeLabel ? { timeLabel: stage.timeLabel } : {}),
        leafRefs: [...stage.leafRefs],
      })),
    };
  }
  return {
    ...safeBlock(block),
    ...(block.digest ? { digest: safeCopyFragmentV4(block.digest) } : {}),
  };
}

export function safeReportDocumentV4(document: ReportDocumentV4): Record<string, unknown> {
  assertReportDocumentV4Integrity(document);
  return {
    version: document.version,
    title: safeCopyFragmentV4(document.title),
    subtitle: document.subtitle,
    executiveSummary: safeCopyFragmentV4(document.executiveSummary),
    style: document.style,
    density: document.density,
    copyMode: document.copyMode,
    sections: document.sections.map((section) => ({
      id: section.id,
      title: safeCopyFragmentV4(section.title),
      ...(section.lead ? { lead: safeCopyFragmentV4(section.lead) } : {}),
      ...(section.transition ? { transition: safeCopyFragmentV4(section.transition) } : {}),
      view: section.view,
      prominence: section.prominence,
      blocks: section.blocks.map(safeBlockV4),
    })),
    sourceDeliverableArtifactId: document.sourceDeliverableArtifactId,
    sourceDeliverableContentSha256: document.sourceDeliverableContentSha256,
    projectionMode: document.projectionMode,
    layoutMode: document.layoutMode,
    traceIndex: Object.fromEntries(Object.entries(document.traceIndex).map(([leafId, trace]) => [
      leafId,
      {
        supportMode: trace.supportMode,
        origins: trace.origins.map((origin) => ({
          artifactId: origin.artifactId,
          contentSha256: origin.contentSha256,
          schemaVersion: origin.schemaVersion,
          jsonPointer: origin.jsonPointer,
          sourceNodeIds: [...origin.sourceNodeIds],
          reviewState: origin.reviewState,
        })),
        questionIds: [...trace.questionIds],
        evidenceIds: [...trace.evidenceIds],
        findingIds: [...trace.findingIds],
        summaryIds: [...trace.summaryIds],
        ...(trace.status ? { status: trace.status } : {}),
        ...(typeof trace.confidence === 'number' ? { confidence: trace.confidence } : {}),
      },
    ])),
    semanticManifest: {
      version: document.semanticManifest.version,
      presentationUnitIds: [...document.semanticManifest.presentationUnitIds],
      leafUnitIds: [...document.semanticManifest.leafUnitIds],
      assetIds: [...document.semanticManifest.assetIds],
      auditRecordIds: [...document.semanticManifest.auditRecordIds],
      noticeIds: [...document.semanticManifest.noticeIds],
      copyFragmentIds: [...document.semanticManifest.copyFragmentIds],
    },
    ...(document.auditAppendix ? {
      auditAppendix: {
        version: document.auditAppendix.version,
        visibility: document.auditAppendix.visibility,
        sourceArtifactIds: [...document.auditAppendix.sourceArtifactIds],
        records: document.auditAppendix.records.map((record) => ({
          id: record.id,
          contributionArtifactId: record.contributionArtifactId,
          sourceUnitKey: record.sourceUnitKey,
          sourceSemanticHash: record.sourceSemanticHash,
          disposition: record.disposition,
          canonicalNodeIds: [...record.canonicalNodeIds],
          ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
          reviewIssueIds: [...record.reviewIssueIds],
        })),
      },
    } : {}),
    notices: document.notices.map((notice) => ({
      id: notice.id,
      code: notice.code,
      severity: notice.severity,
      scope: notice.scope,
      relatedUnitIds: [...notice.relatedUnitIds],
    })),
  };
}
