import type { ReportDocumentV3, ReportTraceV1 } from '../../packages/api-contract/report-document.ts';

export const REPORT_DOCUMENT_V3_FIXTURE_SHA = `sha256:${'a'.repeat(64)}`;

export function reportDocumentV3Trace(pointer: string): ReportTraceV1 {
  return {
    supportMode: 'direct',
    origins: [{
      artifactId: 'deliverable-1',
      contentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
      schemaVersion: 'research-strategy-content-v2',
      jsonPointer: pointer,
      sourceNodeIds: [pointer.split('/').at(-1) ?? 'root'],
      reviewState: 'passed',
    }],
    questionIds: ['q1'],
    evidenceIds: ['E1'],
    findingIds: ['F1'],
    summaryIds: ['S1'],
    status: 'supported',
    confidence: 0.9,
  };
}

export function reportDocumentV3Fixture(): ReportDocumentV3 {
  const leafIds = [
    'matrix-c1',
    'matrix-c2',
    'graph-n1',
    'graph-n2',
    'graph-e1',
    'action-1',
    'action-2',
  ];
  return {
    version: 'report-document-v3',
    title: '京东众筹频道策略报告',
    subtitle: '证据约束版',
    executiveSummary: '围绕目标用户、访问动机和关键行动组织受审结果。',
    style: 'editorial',
    density: 'comfortable',
    sourceDeliverableArtifactId: 'deliverable-1',
    sourceDeliverableContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    projectionMode: 'full',
    layoutMode: 'fallback',
    sections: [
      {
        id: 'section-answers-001',
        title: '答案概览',
        view: 'answers',
        prominence: 'primary',
        blocks: [{
          id: 'block-table-001',
          type: 'record-table',
          title: '场景与用户问题',
          visibility: 'always',
          unitRefs: ['matrix-1'],
          leafRefs: ['matrix-c1', 'matrix-c2'],
          columns: [
            { key: 'scene', label: '场景' },
            { key: 'problem', label: '核心问题' },
          ],
          rows: [{
            id: 'row-1',
            cells: [
              { leafRef: 'matrix-c1', columnKey: 'scene', value: '硬件' },
              { leafRef: 'matrix-c2', columnKey: 'problem', value: '降低新品信任成本' },
            ],
          }],
        }],
      },
      {
        id: 'section-topics-001',
        title: '访问动机链路',
        view: 'topics',
        prominence: 'supporting',
        blocks: [{
          id: 'block-graph-001',
          type: 'graph',
          variant: 'linear',
          visibility: 'always',
          unitRefs: ['mind-model-1'],
          leafRefs: ['graph-n1', 'graph-n2', 'graph-e1'],
          nodes: [
            { id: 'node-1', leafRef: 'graph-n1', label: '触发', description: '新品兴趣' },
            { id: 'node-2', leafRef: 'graph-n2', label: '支持', description: '信任后行动' },
          ],
          edges: [{ id: 'edge-1', leafRef: 'graph-e1', from: 'node-1', to: 'node-2', label: '验证' }],
        }],
      },
      {
        id: 'section-actions-001',
        title: '机会与行动',
        view: 'actions',
        prominence: 'primary',
        blocks: [{
          id: 'block-priority-001',
          type: 'priority-board',
          visibility: 'always',
          unitRefs: ['actions-1'],
          leafRefs: ['action-1', 'action-2'],
          groups: [
            {
              priority: 'P0',
              items: [{ id: 'item-1', leafRef: 'action-1', action: '建立可信项目档案', owner: '产品' }],
            },
            {
              priority: 'P1',
              items: [{ id: 'item-2', leafRef: 'action-2', action: '验证频道入口', validationMethod: 'A/B 测试' }],
            },
          ],
        }],
      },
    ],
    traceIndex: Object.fromEntries(leafIds.map((id) => [id, reportDocumentV3Trace(`/payload/contentBlocks/${id}`)])),
    auditAppendix: {
      version: 'report-audit-appendix-v1',
      visibility: 'collapsible',
      sourceArtifactIds: ['contribution-1'],
      records: [{
        id: 'audit-1',
        contributionArtifactId: 'contribution-1',
        sourceUnitKey: 'unit-1',
        sourceSemanticHash: REPORT_DOCUMENT_V3_FIXTURE_SHA,
        disposition: 'included',
        canonicalNodeIds: ['matrix-1'],
        reviewIssueIds: [],
      }],
    },
    notices: [{
      id: 'notice-layout',
      code: 'layout_fallback',
      severity: 'info',
      scope: 'report',
      relatedUnitIds: [],
    }],
    semanticManifest: {
      version: 'report-semantic-manifest-v1',
      presentationUnitIds: ['matrix-1', 'mind-model-1', 'actions-1'],
      leafUnitIds: leafIds,
      assetIds: [],
      auditRecordIds: ['audit-1'],
      noticeIds: ['notice-layout'],
    },
  };
}
