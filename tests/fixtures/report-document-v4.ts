import type { ReportDocumentV4 } from '../../packages/api-contract/report-document.ts';
import { reportDocumentV3Fixture } from './report-document-v3.ts';

export const REPORT_DOCUMENT_V4_FIXTURE_SHA = `sha256:${'b'.repeat(64)}`;

export function reportDocumentV4Fixture(): ReportDocumentV4 {
  const base = reportDocumentV3Fixture();
  const table = base.sections[0]!.blocks[0]!;
  const graph = base.sections[1]!.blocks[0]!;
  const actions = base.sections[2]!.blocks[0]!;
  if (table.type !== 'record-table' || graph.type !== 'graph' || actions.type !== 'priority-board') {
    throw new Error('ReportDocument v3 fixture shape changed');
  }
  return {
    version: 'report-document-v4',
    title: {
      id: 'copy-report-title',
      provenance: 'model',
      text: '从兴趣到信任：京东众筹增长策略',
      sourceLeafIds: ['matrix-c1', 'matrix-c2'],
    },
    subtitle: base.subtitle,
    executiveSummary: {
      id: 'copy-executive-summary',
      provenance: 'model',
      text: '先用可信项目档案降低决策成本，再验证频道入口。',
      sourceLeafIds: ['matrix-c2', 'action-1', 'action-2'],
    },
    style: base.style,
    density: base.density,
    copyMode: 'mixed',
    sourceDeliverableArtifactId: base.sourceDeliverableArtifactId,
    sourceDeliverableContentSha256: base.sourceDeliverableContentSha256,
    projectionMode: 'full',
    layoutMode: 'model',
    sections: [
      {
        id: 'section-answers-001',
        title: {
          id: 'copy-section-answer-title',
          provenance: 'model',
          text: '先明确用户面对的决策障碍',
          sourceLeafIds: ['matrix-c1', 'matrix-c2'],
        },
        lead: {
          id: 'copy-section-answer-lead',
          provenance: 'model',
          text: '场景与核心问题共同界定后续策略边界。',
          sourceLeafIds: ['matrix-c1', 'matrix-c2'],
        },
        transition: {
          id: 'copy-section-answer-transition',
          provenance: 'model',
          text: '明确问题后，进入用户从触发到行动的阶段链路。',
          sourceLeafIds: ['matrix-c2', 'graph-n1'],
        },
        view: 'answers',
        prominence: 'primary',
        blocks: [{
          ...table,
          digest: {
            id: 'copy-block-table-digest',
            provenance: 'model',
            text: '硬件新品的关键是降低信任成本。',
            sourceLeafIds: ['matrix-c1', 'matrix-c2'],
          },
        }],
      },
      {
        id: 'section-topics-001',
        title: {
          id: 'copy-section-stage-title',
          provenance: 'system',
          text: '策略框架',
          sourceLeafIds: [],
        },
        view: 'topics',
        prominence: 'supporting',
        blocks: [{
          id: graph.id,
          type: 'stage-flow',
          title: graph.title,
          visibility: graph.visibility,
          unitRefs: graph.unitRefs,
          leafRefs: graph.leafRefs,
          stages: [
            {
              id: 'stage-trigger',
              label: '触发兴趣',
              description: '用户注意到新品。',
              timeLabel: '阶段 1',
              leafRefs: ['graph-n1'],
            },
            {
              id: 'stage-trust',
              label: '建立信任',
              description: '验证信息后采取行动。',
              timeLabel: '阶段 2',
              leafRefs: ['graph-n2', 'graph-e1'],
            },
          ],
        }],
      },
      {
        id: 'section-actions-001',
        title: {
          id: 'copy-section-actions-title',
          provenance: 'canonical',
          text: '机会与行动',
          sourceLeafIds: ['action-1', 'action-2'],
        },
        view: 'actions',
        prominence: 'appendix',
        blocks: [{
          id: actions.id,
          type: 'card-grid',
          title: actions.title,
          visibility: actions.visibility,
          unitRefs: actions.unitRefs,
          leafRefs: actions.leafRefs,
          cards: [
            {
              id: 'card-profile',
              title: '建立可信项目档案',
              status: 'P0',
              leafRefs: ['action-1'],
            },
            {
              id: 'card-entry',
              title: '验证频道入口',
              body: '使用 A/B 测试验证。',
              status: 'P1',
              leafRefs: ['action-2'],
            },
          ],
        }],
      },
    ],
    traceIndex: base.traceIndex,
    auditAppendix: base.auditAppendix,
    notices: base.notices,
    semanticManifest: {
      version: 'report-semantic-manifest-v2',
      presentationUnitIds: ['matrix-1', 'mind-model-1', 'actions-1'],
      leafUnitIds: base.semanticManifest.leafUnitIds,
      assetIds: [],
      auditRecordIds: ['audit-1'],
      noticeIds: ['notice-layout'],
      copyFragmentIds: [
        'copy-report-title',
        'copy-executive-summary',
        'copy-section-answer-title',
        'copy-section-answer-lead',
        'copy-section-answer-transition',
        'copy-block-table-digest',
        'copy-section-stage-title',
        'copy-section-actions-title',
      ],
    },
  };
}
