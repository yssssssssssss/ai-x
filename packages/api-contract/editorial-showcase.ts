export const EDITORIAL_SHOWCASE_COMPONENT_KINDS = [
  'editorial-hero',
  'evidence-boundary',
  'answer-chain',
  'metric-cards',
  'record-grid',
  'record-table',
  'deliverable-map',
  'dimension-table',
  'method-board',
  'matrix',
  'stage-flow',
  'relation-map',
  'priority-lanes',
  'validation-list',
  'risk-register',
  'narrative-list',
  'source-register',
  'analysis-appendix',
] as const;

export type EditorialShowcaseComponentKindV1 = typeof EDITORIAL_SHOWCASE_COMPONENT_KINDS[number];
export type EditorialShowcaseStatusV1 = 'fact' | 'inference' | 'unknown';
export type EditorialShowcaseSectionRoleV1 =
  | 'decision'
  | 'evidence'
  | 'analysis'
  | 'strategy'
  | 'execution'
  | 'validation'
  | 'risk'
  | 'appendix';

export const EDITORIAL_SHOWCASE_COMPONENT_ROLES = {
  'editorial-hero': ['decision'],
  'evidence-boundary': ['decision', 'evidence', 'risk'],
  'answer-chain': ['analysis', 'strategy'],
  'metric-cards': ['decision', 'evidence', 'analysis'],
  'record-grid': ['evidence', 'analysis', 'strategy'],
  'record-table': ['analysis', 'strategy'],
  'deliverable-map': ['strategy', 'execution'],
  'dimension-table': ['analysis', 'strategy'],
  'method-board': ['analysis', 'strategy'],
  matrix: ['analysis', 'strategy'],
  'stage-flow': ['execution'],
  'relation-map': ['analysis', 'strategy'],
  'priority-lanes': ['strategy', 'execution'],
  'validation-list': ['validation'],
  'risk-register': ['risk'],
  'narrative-list': ['decision', 'evidence', 'analysis', 'strategy', 'execution', 'validation', 'risk'],
  'source-register': ['appendix'],
  'analysis-appendix': ['appendix'],
} as const satisfies Record<EditorialShowcaseComponentKindV1, readonly EditorialShowcaseSectionRoleV1[]>;

export interface EditorialShowcaseCopyRefV1 {
  mode: 'source_fragment' | 'controlled_label';
  text: string;
  sourceUnitIds: string[];
}

export interface EditorialShowcaseIntentV1 {
  version: 'universal-editorial-showcase-intent-v1';
  profileId: 'universal-editorial-showcase-v1';
  sections: Array<{
    id: string;
    role: Exclude<EditorialShowcaseSectionRoleV1, 'appendix'>;
    title: string;
    lead?: string;
    componentIds: string[];
  }>;
}

export interface EditorialShowcaseUnitV1 {
  unitId: string;
  value: string | number | boolean;
  unit?: string;
  role: 'claim' | 'recommendation' | 'risk' | 'validation' | 'context' | 'audit';
  status?: EditorialShowcaseStatusV1;
  evidenceIds: string[];
}

export interface EditorialShowcaseEvidenceV1 {
  id: string;
  sourceUrl?: string;
}

interface EditorialPresentationComponentBaseV1 {
  id: string;
  ownedUnitIds: string[];
  sourceUnitIds: string[];
  sourceGroupIds: string[];
  sourceRelationIds: string[];
  evidenceIds: string[];
  status?: EditorialShowcaseStatusV1;
}

export type EditorialPresentationComponentV1 =
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'editorial-hero';
      content: {
        title: EditorialShowcaseUnitV1;
        deck: EditorialShowcaseUnitV1;
        highlights: EditorialShowcaseUnitV1[];
        boundary: EditorialShowcaseUnitV1[];
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'evidence-boundary';
      content: {
        columns: Array<{ status: EditorialShowcaseStatusV1; items: EditorialShowcaseUnitV1[] }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'answer-chain';
      content: {
        question: EditorialShowcaseUnitV1;
        answer: EditorialShowcaseUnitV1;
        supporting: EditorialShowcaseUnitV1[];
        actions: EditorialShowcaseUnitV1[];
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'metric-cards';
      content: {
        items: Array<{ label: EditorialShowcaseUnitV1; value: EditorialShowcaseUnitV1 }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'record-grid' | 'record-table';
      content: {
        records: Array<{
          groupId: string;
          label?: string;
          title?: EditorialShowcaseUnitV1;
          items: EditorialShowcaseUnitV1[];
        }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'deliverable-map';
      content: { items: EditorialShowcaseUnitV1[] };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'dimension-table';
      content: {
        rows: Array<{
          groupId: string;
          name: EditorialShowcaseUnitV1;
          purpose?: EditorialShowcaseUnitV1;
          fields: EditorialShowcaseUnitV1[];
        }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'method-board';
      content: { items: EditorialShowcaseUnitV1[] };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'matrix';
      content: {
        title: EditorialShowcaseUnitV1;
        columns: EditorialShowcaseUnitV1[];
        rows: Array<{ label: EditorialShowcaseUnitV1; cells: EditorialShowcaseUnitV1[] }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'stage-flow';
      content: {
        stages: Array<{
          groupId: string;
          sequence: number;
          label: EditorialShowcaseUnitV1;
          duration?: EditorialShowcaseUnitV1;
          items: EditorialShowcaseUnitV1[];
          outputs: EditorialShowcaseUnitV1[];
        }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'relation-map';
      content: {
        nodes: Array<{
          groupId: string;
          label: EditorialShowcaseUnitV1;
          items: EditorialShowcaseUnitV1[];
        }>;
        edges: Array<{
          relationId: string;
          fromGroupId: string;
          toGroupId: string;
          kind: 'sequence' | 'supports' | 'contrasts' | 'depends_on' | 'validates' | 'contains';
        }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'priority-lanes';
      content: {
        title: EditorialShowcaseUnitV1;
        lanes: Array<{ priority: 'P0' | 'P1' | 'P2'; items: EditorialShowcaseUnitV1[] }>;
      };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'validation-list' | 'risk-register' | 'narrative-list' | 'analysis-appendix';
      content: { items: EditorialShowcaseUnitV1[] };
    })
  | (EditorialPresentationComponentBaseV1 & {
      kind: 'source-register';
      content: { evidence: EditorialShowcaseEvidenceV1[] };
    });

export interface EditorialPresentationSectionV1 {
  id: string;
  role: EditorialShowcaseSectionRoleV1;
  title: string;
  lead?: string;
  components: EditorialPresentationComponentV1[];
}

export interface EditorialPresentationSpecV1 {
  version: 'universal-editorial-presentation-spec-v1';
  binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    sourceReportPackageId: string;
    sourceReportPackageHash: string;
    materialHash: string;
    sourcePacketHash: string;
  };
  profileId: 'universal-editorial-showcase-v1';
  generationMode: 'model_intent' | 'deterministic_showcase';
  titleUnitId?: string;
  sections: EditorialPresentationSectionV1[];
  requiredBodyUnitIds: string[];
  promotedSupportingUnitIds: string[];
  requiredAuditUnitIds: string[];
  evidenceIds: string[];
  notices: string[];
}

export interface EditorialShowcaseRenderManifestV1 {
  version: 'universal-editorial-showcase-render-manifest-v1';
  profileId: 'universal-editorial-showcase-v1';
  profileHash: string;
  specHash: string;
  htmlHash: string;
  renderedComponents: Array<{
    componentId: string;
    kind: EditorialShowcaseComponentKindV1;
    ownedUnitIds: string[];
    sourceUnitIds: string[];
  }>;
}

export interface EditorialShowcaseModelCallV1 {
  stage: 'editorial_showcase_intent';
  status: 'succeeded' | 'failed';
  provider?: string;
  endpointHost?: string;
  requestedModel?: string;
  expectedModel?: string;
  actualModel?: string;
  modelVersion?: string;
  traceId?: string;
  responseHash?: string;
  failureCode?: string;
}

export interface EditorialShowcaseManifestV1 {
  version: 'universal-editorial-showcase-publication-v1';
  authority: 'derived';
  status: 'ready';
  generationMode: 'model_intent' | 'deterministic_showcase';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  publicationId: string;
  profileId: 'universal-editorial-showcase-v1';
  sourceReportPackage: {
    artifactId: string;
    kind: string;
    schemaVersion: string;
    contentSha256: string;
  };
  materialHash: string;
  sourcePacketHash: string;
  intentHash: string;
  specHash: string;
  profileHash: string;
  htmlHash: string;
  renderManifestHash: string;
  validationHash: string;
  modelCall?: EditorialShowcaseModelCallV1;
  generatedAt: string;
}
