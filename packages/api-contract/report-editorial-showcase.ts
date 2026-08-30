import type { ReportEditorialIntentV1 } from './report-editorial.ts';

export const EDITORIAL_SHOWCASE_PROFILE_V1 = 'editorial-showcase-v1' as const;

export const EDITORIAL_SHOWCASE_PURPOSES_V1 = [
  'decision',
  'evolution',
  'profiles',
  'motivation',
  'journey',
  'principles',
  'actions',
  'validation',
  'evidence',
  'analysis',
  'full_analysis_appendix',
] as const;

export type EditorialShowcasePurposeV1 = (typeof EDITORIAL_SHOWCASE_PURPOSES_V1)[number];

export const EDITORIAL_SHOWCASE_COMPONENT_KINDS_V1 = [
  'editorial-hero',
  'evidence-boundary',
  'confidence-bars',
  'timeline',
  'profile-grid',
  'matrix',
  'stage-flow',
  'tension-map',
  'principle-list',
  'priority-lanes',
  'validation-list',
  'source-register',
  'narrative-list',
] as const;

export type EditorialShowcaseComponentKindV1 =
  (typeof EDITORIAL_SHOWCASE_COMPONENT_KINDS_V1)[number];

export const EDITORIAL_SHOWCASE_VARIANTS_V1 = [
  'statement',
  'split',
  'columns',
  'asymmetric',
  'ledger',
  'horizontal',
  'stepped',
  'two-sided',
  'lanes',
  'table',
  'list',
  'register',
] as const;

export type EditorialShowcaseVariantV1 = (typeof EDITORIAL_SHOWCASE_VARIANTS_V1)[number];
export type EditorialShowcaseEmphasisV1 = 'hero' | 'primary' | 'secondary';
export type EditorialShowcaseSpanV1 = 'full' | 'wide' | 'half' | 'third';
export type EditorialShowcaseSectionLayoutV1 = 'single' | 'split' | 'columns' | 'asymmetric' | 'full';

export interface ReportEditorialShowcaseIntentComponentV1 {
  kind: EditorialShowcaseComponentKindV1;
  variant: EditorialShowcaseVariantV1;
  emphasis: EditorialShowcaseEmphasisV1;
  span: EditorialShowcaseSpanV1;
  unitRefs: string[];
  sourceLeafIds: string[];
}

export interface ReportEditorialShowcaseIntentV1 {
  profileId: typeof EDITORIAL_SHOWCASE_PROFILE_V1;
  sections: Array<{
    purpose: Exclude<EditorialShowcasePurposeV1, 'full_analysis_appendix'>;
    layout: EditorialShowcaseSectionLayoutV1;
    components: ReportEditorialShowcaseIntentComponentV1[];
  }>;
}

export interface ReportEditorialIntentV2 extends Omit<ReportEditorialIntentV1, 'version'> {
  version: 'report-editorial-intent-v2';
  showcase: ReportEditorialShowcaseIntentV1;
}

export interface EditorialShowcaseBindingV1 {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  deliverableContentSha256: string;
  reportReviewArtifactId: string;
  /** Populated before a Showcase Spec is sealed. Local unsealed projections may omit it. */
  evidenceManifestArtifactId?: string;
  /** Sealed Artifact content hash, distinct from the manifest's internal semantic hash. */
  evidenceManifestContentSha256?: string;
  evidenceManifestHash?: string;
}

export interface EditorialShowcaseComponentV1 {
  id: string;
  kind: EditorialShowcaseComponentKindV1;
  variant: EditorialShowcaseVariantV1;
  emphasis: EditorialShowcaseEmphasisV1;
  span: EditorialShowcaseSpanV1;
  ownedUnitIds: string[];
  ownedLeafIds: string[];
  sourceLeafIds: string[];
  sourceContributionUnitIds: string[];
  evidenceIds: string[];
  status?: 'supported' | 'provisional' | 'unanswered';
  confidence?: number;
  title: string;
}

export interface EditorialShowcaseSectionV1 {
  id: string;
  purpose: EditorialShowcasePurposeV1;
  layout: EditorialShowcaseSectionLayoutV1;
  prominence: 'primary' | 'supporting' | 'appendix';
  title: string;
  components: EditorialShowcaseComponentV1[];
}

export interface EditorialPresentationSpecV1 {
  version: 'editorial-presentation-spec-v1';
  binding: EditorialShowcaseBindingV1;
  profileId: typeof EDITORIAL_SHOWCASE_PROFILE_V1;
  generationMode: 'model' | 'fallback';
  showcaseOutlineSignature: string;
  sections: EditorialShowcaseSectionV1[];
  notices: Array<{
    code: string;
    severity: 'info' | 'warning';
    message: string;
  }>;
}

export interface EditorialShowcaseCompilerDiagnosticsV1 {
  sectionCount: number;
  componentCount: number;
  primaryUnitCount: number;
  supportingUnitCount: number;
  appendixUnitCount: number;
  sourceLeafCount: number;
  evidenceCount: number;
}

export interface EditorialShowcaseCompilationV1 {
  spec: EditorialPresentationSpecV1;
  diagnostics: EditorialShowcaseCompilerDiagnosticsV1;
}

export interface EditorialShowcaseRenderManifestV1 {
  version: 'editorial-showcase-render-manifest-v1';
  rendererVersion: string;
  profileId: typeof EDITORIAL_SHOWCASE_PROFILE_V1;
  showcaseOutlineSignature: string;
  componentIds: string[];
  ownedLeafIds: string[];
  sourceLeafIds: string[];
  evidenceIds: string[];
}
