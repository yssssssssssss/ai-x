import { createHash } from 'node:crypto';
import type {
  ControlArtifact,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import type { CurrentReportPackageResponse } from '../../../../packages/api-contract/control-workflow.ts';
import type { ReportPackageV2 } from '../../../../packages/api-contract/report-package.ts';
import type { LLMResult } from '../runtime/llm-client.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import type { EvidenceEntry } from '../evidence/evidence-service.ts';
import type { ReportPackageArtifactValue } from './report-package-artifact.ts';
import type { VerifiedVisualAsset } from './visual-asset-service.ts';

export type Sha256 = `sha256:${string}`;
export type PromptFingerprint = `sha256:${string}`;
export type EpistemicStatus = 'fact' | 'inference' | 'unknown';

export const EDITORIAL_MATERIAL_VERSION = 'editorial-material-v1' as const;
export const EDITORIAL_MODEL_CONTEXT_VERSION = 'editorial-model-context-v1' as const;
export const EDITORIAL_BLUEPRINT_PLAN_VERSION = 'editorial-blueprint-plan-v1' as const;
export const EDITORIAL_BLUEPRINT_VERSION = 'editorial-blueprint-v1' as const;
export const EDITORIAL_DIAGNOSTIC_VERSION = 'editorial-diagnostic-v1' as const;
export const EDITORIAL_REPORT_VERSION = 'editorial-report-v1' as const;
export const EDITORIAL_BLUEPRINT_PROMPT_VERSION = 'editorial-blueprint-prompt-v1' as const;
export const EDITORIAL_FIDELITY_PROMPT_VERSION = 'editorial-fidelity-prompt-v1' as const;
export const EDITORIAL_FALLBACK_VERSION = 'editorial-fallback-v1' as const;
export const EDITORIAL_RENDERER_VERSION = 'editorial-html-v1' as const;
export const EDITORIAL_STORE_VERSION = 'editorial-store-v1' as const;
export const EDITORIAL_MODEL_EGRESS_VERSION = 'editorial-model-egress-v1' as const;

export const EDITORIAL_PIPELINE_VERSIONS = Object.freeze({
  materialVersion: EDITORIAL_MATERIAL_VERSION,
  modelContextVersion: EDITORIAL_MODEL_CONTEXT_VERSION,
  blueprintPlanVersion: EDITORIAL_BLUEPRINT_PLAN_VERSION,
  blueprintVersion: EDITORIAL_BLUEPRINT_VERSION,
  blueprintPromptVersion: EDITORIAL_BLUEPRINT_PROMPT_VERSION,
  fidelityPromptVersion: EDITORIAL_FIDELITY_PROMPT_VERSION,
  fallbackVersion: EDITORIAL_FALLBACK_VERSION,
  rendererVersion: EDITORIAL_RENDERER_VERSION,
  storeVersion: EDITORIAL_STORE_VERSION,
});

export const EDITORIAL_MAX_JSON_BYTES = 8 * 1024 * 1024;
export const EDITORIAL_MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
export const EDITORIAL_MAX_MANIFEST_BYTES = 256 * 1024;
export const EDITORIAL_MAX_MODEL_CONTEXT_BYTES = 512 * 1024;
export const EDITORIAL_MAX_MATERIAL_UNITS = 1_000;
export const EDITORIAL_MAX_MATERIAL_CODE_POINTS = 500_000;
export const EDITORIAL_MAX_BLUEPRINT_SECTIONS = 12;
export const EDITORIAL_MAX_BLUEPRINT_BLOCKS = 48;
export const EDITORIAL_MAX_LLM_COPIES = 240;
export const EDITORIAL_MAX_FALLBACK_COPIES = 1_200;

export type EditorialCheckId =
  | 'source_integrity'
  | 'model_egress'
  | 'model_identity'
  | 'schema_integrity'
  | 'reference_integrity'
  | 'component_relation'
  | 'epistemic_integrity'
  | 'numeric_integrity'
  | 'content_fidelity'
  | 'content_coverage'
  | 'composition_quality'
  | 'visual_policy'
  | 'html_safety';

export class EditorialContractError extends Error {
  readonly name = 'EditorialContractError';

  constructor(
    readonly code: string,
    message: string,
    readonly checkId?: EditorialCheckId,
    readonly jsonPointer?: string,
  ) {
    super(`${code}: ${message}${jsonPointer ? ` at ${jsonPointer}` : ''}`);
  }
}

export interface SourceArtifactRef {
  artifactId: string;
  kind: string;
  schemaVersion: string;
  contentSha256: Sha256;
}

export interface SourcePointer {
  artifactId: string;
  jsonPointer: string;
}

export type EditorialEvidenceEntry = Pick<
  EvidenceEntry,
  | 'id'
  | 'kind'
  | 'evidenceClass'
  | 'artifactId'
  | 'artifactContentSha256'
  | 'jsonPointer'
  | 'sensitivity'
  | 'redaction'
  | 'toolId'
  | 'toolTier'
  | 'toolProof'
  | 'sourceUrl'
>;

export interface DerivedFileRef {
  relativePath: string;
  contentSha256: Sha256;
  byteSize: number;
  mediaType: 'application/json' | 'text/html';
}

export interface EditorialSourcePolicyMetadata {
  artifactId: string;
  contentSha256: Sha256;
  sensitivity: string;
  redactionPolicyVersion: string;
}

export interface EditorialSourceBinding {
  taskId: string;
  taskState: 'completed' | 'completed_with_gaps';
  taskStateVersion: number;
  planVersionId: string;
  attemptId: string;
  reportPackageArtifactId: string;
  reportPackageContentSha256: Sha256;
}

export interface EditorialTaskContext {
  originalRequest: string;
  researchGoal: string;
  targetAudience: string[];
  scope: string[];
  constraints: string[];
  successCriteria: string[];
  expectedDeliverables: string[];
  requestedArtifacts: unknown[];
  sensitivity: 'public' | 'internal' | 'confidential';
  piiDetected: boolean;
}

export interface FrozenEditorialSource {
  binding: EditorialSourceBinding;
  taskContext?: EditorialTaskContext;
  reportPackage: {
    artifact: ControlArtifact & { state: 'SEALED'; contentSha256: string };
    value: ReportPackageArtifactValue | ReportPackageV2;
  };
  current: Exclude<CurrentReportPackageResponse, { presentationMode: 'legacy_text' }>;
  sourceArtifacts: SourceArtifactRef[];
  sourcePolicyMetadata: EditorialSourcePolicyMetadata[];
  verifiedVisualAssets: ReadonlyArray<VerifiedVisualAsset>;
}

export interface EditorialSourceVerifier {
  readCurrent(taskId: string): Promise<FrozenEditorialSource>;
  assertStillCurrent(expected: EditorialSourceBinding): Promise<void>;
}

export type EditorialTaskReader = Pick<
  ControlPlaneRepository,
  'getTaskDetail' | 'getArtifact' | 'findSealedArtifact'
>;

export type EditorialArtifactReader = Pick<
  ControlArtifactStore,
  'readVerifiedJson' | 'readVerifiedBoundJson' | 'readVerifiedBinary'
> & Partial<Pick<ControlArtifactStore, 'readVerifiedBoundText'>>;

export interface EditorialMaterialUnitBase {
  id: string;
  groupId?: string;
  value: string | number | boolean;
  unit?: string;
  metricEligible: boolean;
  sourceRefs: readonly [SourcePointer];
  basisUnitIds: string[];
  evidenceIds: string[];
  questionIds: string[];
  requiredInOutput: boolean;
  requiredInBody: boolean;
}

export type EditorialMaterialUnit =
  | (EditorialMaterialUnitBase & { role: 'claim'; epistemicStatus: EpistemicStatus })
  | (EditorialMaterialUnitBase & { role: 'recommendation'; epistemicStatus: 'inference' })
  | (EditorialMaterialUnitBase & { role: 'risk' | 'validation'; epistemicStatus: 'unknown' })
  | (EditorialMaterialUnitBase & { role: 'context' | 'audit'; epistemicStatus?: never });

export interface EditorialMaterialAsset {
  id: string;
  assetId: string;
  manifestArtifactId: string;
  visualRole: 'standalone' | 'comparison-before' | 'comparison-after';
  comparisonGroupId?: string;
  derivedFromAssetId?: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  exportPolicy: 'allow';
  captionUnitId: string;
  altTextUnitId: string;
  evidenceIds: string[];
  sourceRefs: readonly [SourcePointer, ...SourcePointer[]];
}

export type EditorialDeliverableType =
  | 'research_plan'
  | 'research_strategy_report'
  | 'competitive_analysis_report'
  | 'voc_diagnosis_report'
  | 'design_audit_report'
  | 'accessibility_audit_report'
  | 'industry_market_analysis_report';

export const EDITORIAL_MATERIALIZATION_WARNING_CODES = [
  'VISUAL_MASK_OMITTED',
  'VISUAL_BLOCKED_OMITTED',
  'VISUAL_SVG_OMITTED',
] as const;
export type EditorialMaterializationWarningCode = typeof EDITORIAL_MATERIALIZATION_WARNING_CODES[number];
export const EDITORIAL_RENDERER_WARNING_CODES = ['VISUAL_BUDGET_OMITTED'] as const;
export type EditorialRendererWarningCode = typeof EDITORIAL_RENDERER_WARNING_CODES[number];
export type EditorialVisualWarningCode = EditorialMaterializationWarningCode | EditorialRendererWarningCode;

export interface EditorialMaterial {
  version: typeof EDITORIAL_MATERIAL_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableType: EditorialDeliverableType;
  presentationMode: 'current_text' | 'multimodal';
  sourceReportPackage: SourceArtifactRef;
  sourceArtifacts: SourceArtifactRef[];
  materializationWarningCodes: EditorialMaterializationWarningCode[];
  titleUnitId?: string;
  methodSummaryUnitId: string;
  units: EditorialMaterialUnit[];
  assets: EditorialMaterialAsset[];
  evidence: EditorialEvidenceEntry[];
}

export interface EditorialModelContext {
  version: typeof EDITORIAL_MODEL_CONTEXT_VERSION;
  materialHash: Sha256;
  deliverableType: string;
  units: Array<{
    id: string;
    value: string | number | boolean;
    unit?: string;
    role: EditorialMaterialUnit['role'];
    epistemicStatus?: EpistemicStatus;
    metricEligible: boolean;
    groupId?: string;
    basisUnitIds: string[];
    questionIds: string[];
    requiredInOutput: boolean;
    requiredInBody: boolean;
  }>;
  assets: Array<{
    id: string;
    visualRole: EditorialMaterialAsset['visualRole'];
    comparisonGroupId?: string;
    derivedFromEditorialAssetId?: string;
    captionUnitId: string;
    altTextUnitId: string;
  }>;
}

export interface EditorialCopy {
  text: string;
  mode: 'verbatim' | 'paraphrase';
  materialUnitIds: string[];
}

export type EditorialSectionRole =
  | 'decision'
  | 'positioning'
  | 'audience'
  | 'motivation'
  | 'journey'
  | 'strategy'
  | 'opportunity'
  | 'roadmap'
  | 'validation'
  | 'risk'
  | 'boundary'
  | 'audit';

export type EditorialBlockKind =
  | 'narrative'
  | 'decision-cover'
  | 'metric-cards'
  | 'truth-triad'
  | 'card-grid'
  | 'flow'
  | 'strategy-matrix'
  | 'roadmap'
  | 'validation-gates'
  | 'risk-register'
  | 'visual-gallery'
  | 'audit-appendix';

export type EditorialCompositionKind =
  | 'metric-cards'
  | 'truth-triad'
  | 'card-grid'
  | 'flow'
  | 'strategy-matrix'
  | 'roadmap'
  | 'validation-gates'
  | 'visual-gallery';

export interface EditorialBlockBase {
  id: string;
  kind: EditorialBlockKind;
}

export type EditorialBlueprintBlock =
  | (EditorialBlockBase & { kind: 'narrative'; paragraphs: EditorialCopy[] })
  | (EditorialBlockBase & { kind: 'decision-cover'; summary: EditorialCopy; boundary?: EditorialCopy })
  | (EditorialBlockBase & {
      kind: 'metric-cards';
      items: Array<
        | { label: EditorialCopy; labelKey?: never; valueUnitId: string }
        | { label?: never; labelKey: 'target-sample-count'; valueUnitId: string }
      >;
    })
  | (EditorialBlockBase & {
      kind: 'truth-triad';
      factIds: string[];
      inferenceIds: string[];
      unknownIds: string[];
    })
  | (EditorialBlockBase & { kind: 'card-grid'; cards: Array<{ title: EditorialCopy; body: EditorialCopy }> })
  | (EditorialBlockBase & { kind: 'flow'; steps: Array<{ label: EditorialCopy; body: EditorialCopy }> })
  | (EditorialBlockBase & {
      kind: 'strategy-matrix';
      columns: EditorialCopy[];
      rows: Array<{ label: EditorialCopy; cells: EditorialCopy[] }>;
    })
  | (EditorialBlockBase & { kind: 'roadmap'; lanes: Array<{ label: EditorialCopy; items: EditorialCopy[] }> })
  | (EditorialBlockBase & {
      kind: 'validation-gates';
      gates: Array<{ label: EditorialCopy; method: EditorialCopy; successCriterion?: EditorialCopy }>;
    })
  | (EditorialBlockBase & {
      kind: 'risk-register';
      items: Array<{ risk: EditorialCopy; impact?: EditorialCopy; response?: EditorialCopy }>;
    })
  | (EditorialBlockBase & { kind: 'visual-gallery'; assetIds: string[] })
  | (EditorialBlockBase & { kind: 'audit-appendix'; unitIds: string[]; evidenceIds: string[] });

export type EditorialPlannedBlock = Exclude<EditorialBlueprintBlock, { kind: 'audit-appendix' }>;

export interface EditorialBlueprintPlan {
  version: typeof EDITORIAL_BLUEPRINT_PLAN_VERSION;
  locale: 'zh-CN';
  title?: EditorialCopy;
  deck: EditorialCopy;
  sections: Array<{
    id: string;
    role: Exclude<EditorialSectionRole, 'audit'>;
    questionIds: string[];
    title?: EditorialCopy;
    lead?: EditorialCopy;
    blocks: EditorialPlannedBlock[];
  }>;
}

export interface EditorialBlueprint {
  version: typeof EDITORIAL_BLUEPRINT_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  materialHash: Sha256;
  locale: 'zh-CN';
  title?: EditorialCopy;
  deck: EditorialCopy;
  sections: Array<{
    id: string;
    role: EditorialSectionRole;
    questionIds: string[];
    title?: EditorialCopy;
    lead?: EditorialCopy;
    blocks: EditorialBlueprintBlock[];
  }>;
}

export interface EditorialDiagnosticIssue {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  jsonPointer?: string;
  materialUnitIds?: string[];
}

export interface EditorialDiagnosticCheck {
  id: EditorialCheckId;
  status: 'passed' | 'failed' | 'not_run';
  method: 'deterministic' | 'llm';
  issues: EditorialDiagnosticIssue[];
}

export interface EditorialLLMLimits {
  overallTimeoutMs: 90_000;
  maxHttpAttempts: 3;
  maxRetryAfterMs: 5_000;
  maxResponseBytes: 1_048_576;
  maxOutputTokens: 8_000;
}

export interface EditorialGatewayConfiguration {
  provider: string;
  endpointHost: string;
  endpointUrl: string;
  mode: 'mock' | 'real' | 'draft';
  eligibleAsReal: boolean;
  redirectMode: 'error';
  routes: ReadonlyArray<{
    requestedModel: string;
    expectedActualModel: string;
    expectedActualModelExplicit: true;
  }>;
  limits: EditorialLLMLimits;
  gatewayConfigurationHash: Sha256;
}

export interface EditorialStructuredModelClient {
  readonly configurationIdentity: {
    provider: string;
    endpointHost: string;
    endpointUrl: string;
    mode: 'mock' | 'real' | 'draft';
    eligibleAsReal: boolean;
    routes: ReadonlyArray<{
      requestedModel: string;
      expectedActualModel: string;
      expectedActualModelExplicit: boolean;
    }>;
  };
  generateStructured<T>(options: {
    prompt: string;
    schema: object;
    schemaName: 'editorial-report-blueprint' | 'editorial-report-fidelity';
    context: object;
    limits: EditorialLLMLimits;
    redirectMode: 'error';
  }): Promise<Omit<LLMResult<T>, 'receiptId'>>;
}

export type EditorialModelPort =
  | { client: null; configuration: null }
  | { client: EditorialStructuredModelClient; configuration: EditorialGatewayConfiguration };

export interface EditorialModelEgressPolicy {
  version: typeof EDITORIAL_MODEL_EGRESS_VERSION;
  defaultDecision: 'deny';
  allowed: readonly [
    {
      sensitivity: 'public';
      redactionPolicyVersion: 'v1';
      provider: 'gateway';
      mode: 'real';
      endpointHost: 'llm-gw.jd.local';
      endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions';
      redirectMode: 'error';
    },
    {
      sensitivity: 'internal';
      redactionPolicyVersion: 'v1';
      provider: 'gateway';
      mode: 'real';
      endpointHost: 'llm-gw.jd.local';
      endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions';
      redirectMode: 'error';
    },
  ];
  policyHash: Sha256;
}

export interface EditorialModelEgressDecision {
  policyVersion: typeof EDITORIAL_MODEL_EGRESS_VERSION;
  policyHash: Sha256;
  decision: 'allow' | 'deny';
  reasonCode:
    | 'EGRESS_ALLOWED'
    | 'EGRESS_SENSITIVITY_DENIED'
    | 'EGRESS_REDACTION_POLICY_DENIED'
    | 'EGRESS_PROVIDER_DENIED'
    | 'EGRESS_MODE_DENIED'
    | 'EGRESS_ENDPOINT_DENIED'
    | 'EGRESS_REDIRECT_POLICY_DENIED'
    | 'EGRESS_MODEL_UNCONFIGURED';
  evaluated: {
    sourcePolicySetHash: Sha256;
    contributingSourceCount: number;
    sensitivities: string[];
    redactionPolicyVersions: string[];
    provider: string | null;
    mode: 'mock' | 'real' | 'draft' | null;
    endpointHost: string | null;
    endpointUrl: string | null;
    redirectMode: 'error' | null;
  };
}

export interface EditorialModelCallRecordBase {
  stage: 'editorial_blueprint' | 'editorial_fidelity_review';
  ordinal: 1 | 2;
  gatewayConfigurationHash: Sha256;
  modelContextHash: Sha256;
  modelContextByteSize: number;
  promptVersion: string;
  promptHash: PromptFingerprint;
}

export type EditorialModelCallRecord = EditorialModelCallRecordBase & (
  | {
      status: 'succeeded';
      provider: string;
      endpointHost: string;
      requestedModel: string;
      expectedModel: string;
      actualModel: string;
      modelVersion: string;
      traceId: string;
      responseHash: Sha256;
      tokens?: { prompt: number; completion: number; total: number };
    }
  | {
      status: 'failed';
      provider?: string;
      endpointHost?: string;
      requestedModel?: string;
      expectedModel?: string;
      actualModel?: string;
      modelVersion?: string;
      traceId?: string;
      responseHash?: never;
      failureCode: string;
    }
);

export interface EditorialFidelityCheck {
  copyPointer: string;
  materialUnitIds: string[];
  verdict:
    | 'faithful'
    | 'narrower'
    | 'unsupported'
    | 'certainty_upgraded'
    | 'numeric_drift'
    | 'qualification_lost';
}

export interface EditorialFidelityReviewPlan {
  version: 'editorial-fidelity-plan-v1';
  checks: EditorialFidelityCheck[];
}

export interface EditorialFidelityReview {
  version: 'editorial-fidelity-v1';
  materialHash: Sha256;
  blueprintHash: Sha256;
  verdict: 'pass' | 'block';
  checks: EditorialFidelityCheck[];
}

export type EditorialFidelityAttempt =
  | { fidelityCall?: never; fidelityReviewHash?: never; fidelityReview?: never }
  | {
      fidelityCall: Extract<EditorialModelCallRecord, { status: 'failed' }> & {
        stage: 'editorial_fidelity_review';
        inputBlueprintHash: Sha256;
      };
      fidelityReviewHash?: never;
      fidelityReview?: never;
    }
  | {
      fidelityCall: Extract<EditorialModelCallRecord, { status: 'succeeded' }> & {
        stage: 'editorial_fidelity_review';
        inputBlueprintHash: Sha256;
      };
      fidelityReviewHash: Sha256;
      fidelityReview: EditorialFidelityReview;
    };

export type EditorialCandidateAttempt = {
  ordinal: 1 | 2;
  blueprintHash?: Sha256;
  plannerCall: EditorialModelCallRecord & { stage: 'editorial_blueprint' };
  outcome: 'accepted' | 'rejected' | 'call_failed';
  issueCodes: string[];
} & EditorialFidelityAttempt;

export interface EditorialDiagnosticBase {
  version: typeof EDITORIAL_DIAGNOSTIC_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  sourceReportPackage: SourceArtifactRef;
  gatewayConfigurationHash: Sha256 | null;
  candidateAttempts: EditorialCandidateAttempt[];
  rejectedResponseHashes: Sha256[];
  checks: EditorialDiagnosticCheck[];
  issues: EditorialDiagnosticIssue[];
}

export interface EditorialPreparedDiagnosticFields {
  requestKey: string;
  materialHash: Sha256;
  modelEgress: EditorialModelEgressDecision;
  modelContextHash: Sha256;
  modelContextByteSize: number;
}

export type EditorialDiagnostic =
  | (EditorialDiagnosticBase & EditorialPreparedDiagnosticFields & {
      status: 'pass';
      mode: 'llm';
      generationId: string;
      publishedBlueprintHash: Sha256;
      htmlHash: Sha256;
    })
  | (EditorialDiagnosticBase & EditorialPreparedDiagnosticFields & {
      status: 'degraded';
      mode: 'deterministic_fallback';
      generationId: string;
      publishedBlueprintHash: Sha256;
      htmlHash: Sha256;
    })
  | (EditorialDiagnosticBase & {
      status: 'fail';
      mode: 'none';
      requestKey?: never;
      generationId?: never;
      materialHash?: never;
      modelEgress?: never;
      modelContextHash?: never;
      modelContextByteSize?: never;
      publishedBlueprintHash?: never;
      htmlHash?: never;
    })
  | (EditorialDiagnosticBase & EditorialPreparedDiagnosticFields & {
      status: 'fail';
      mode: 'llm' | 'deterministic_fallback';
      generationId?: never;
      publishedBlueprintHash?: never;
      htmlHash?: never;
    });

export interface EditorialReport {
  version: typeof EDITORIAL_REPORT_VERSION;
  authority: 'derived';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  sensitivity: string;
  redactionPolicyVersion: string;
  requestKey: string;
  generationId: string;
  status: 'ready' | 'degraded';
  sourceReportPackage: SourceArtifactRef;
  pipeline: {
    materialVersion: typeof EDITORIAL_MATERIAL_VERSION;
    modelContextVersion: typeof EDITORIAL_MODEL_CONTEXT_VERSION;
    modelContextHash: Sha256;
    blueprintPlanVersion: typeof EDITORIAL_BLUEPRINT_PLAN_VERSION;
    blueprintVersion: typeof EDITORIAL_BLUEPRINT_VERSION;
    promptVersion: typeof EDITORIAL_BLUEPRINT_PROMPT_VERSION;
    fidelityPromptVersion: typeof EDITORIAL_FIDELITY_PROMPT_VERSION;
    fallbackVersion: typeof EDITORIAL_FALLBACK_VERSION;
    rendererVersion: typeof EDITORIAL_RENDERER_VERSION;
    storeVersion: typeof EDITORIAL_STORE_VERSION;
    modelEgress: EditorialModelEgressDecision;
    gatewayConfiguration: EditorialGatewayConfiguration | null;
  };
  modelCalls: EditorialModelCallRecord[];
  exportedAssets: Array<{ assetId: string; contentSha256: Sha256 }>;
  files: {
    material: DerivedFileRef;
    blueprint: DerivedFileRef;
    diagnostic: DerivedFileRef;
    html: DerivedFileRef & {
      mediaType: 'text/html';
      selfContained: true;
      printProfile: 'a4-portrait-v1';
    };
  };
  generatedAt: string;
}

export interface EditorialRenderTrace {
  bodyUnitIds: string[];
  appendixUnitIds: string[];
  assetIds: string[];
  renderedBlocks: Array<{ blockId: string; kind: EditorialBlockKind }>;
  renderedBlockKinds: EditorialBlockKind[];
  eligibleCompositionKinds: EditorialCompositionKind[];
  renderedCompositionKinds: EditorialCompositionKind[];
}

export interface PreflightedFallbackBundle {
  blueprint: EditorialBlueprint;
  blueprintBytes: Uint8Array;
  blueprintHash: Sha256;
  htmlBytes: Uint8Array;
  htmlHash: Sha256;
  renderTrace: EditorialRenderTrace;
  exportedAssets: Array<{ assetId: string; contentSha256: Sha256 }>;
  checks: EditorialDiagnosticCheck[];
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REQUEST_KEY_PATTERN = /^erq_[0-9a-f]{64}$/u;
const GENERATION_ID_PATTERN = /^er_[0-9a-f]{64}$/u;
const SAFE_BLUEPRINT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/u;
const ALLOWED_UNITS = new Set(['/5', 'ratio', '个', '条']);
const DELIVERABLE_TYPES = new Set<EditorialDeliverableType>([
  'research_plan',
  'research_strategy_report',
  'competitive_analysis_report',
  'voc_diagnosis_report',
  'design_audit_report',
  'accessibility_audit_report',
  'industry_market_analysis_report',
]);
const EVIDENCE_CLASSES = new Set([
  'public_source', 'screenshot', 'user_input', 'knowledge', 'dataset', 'simulation', 'derived',
]);

function fail(
  code: string,
  message: string,
  checkId?: EditorialCheckId,
  path?: string,
): never {
  throw new EditorialContractError(code, message, checkId, path);
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalEditorialJson(value: unknown): string {
  const active = new Set<object>();
  const serialize = (candidate: unknown, path: string): string => {
    if (candidate === null) return 'null';
    switch (typeof candidate) {
      case 'string': return JSON.stringify(candidate);
      case 'boolean': return candidate ? 'true' : 'false';
      case 'number': {
        if (!Number.isFinite(candidate)) fail('CANONICAL_JSON_INVALID', 'number must be finite', undefined, path);
        return JSON.stringify(Object.is(candidate, -0) ? 0 : candidate);
      }
      case 'undefined': fail('CANONICAL_JSON_INVALID', 'undefined is not allowed', undefined, path);
      case 'bigint':
      case 'function':
      case 'symbol': fail('CANONICAL_JSON_INVALID', `${typeof candidate} is not allowed`, undefined, path);
      case 'object': break;
    }
    const object = candidate as object;
    if (active.has(object)) fail('CANONICAL_JSON_INVALID', 'cyclic values are not allowed', undefined, path);
    active.add(object);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            fail('CANONICAL_JSON_INVALID', 'sparse arrays are not allowed', undefined, `${path}/${index}`);
          }
        }
        return `[${candidate.map((child, index) => serialize(child, `${path}/${index}`)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        fail('CANONICAL_JSON_INVALID', 'only plain objects are allowed', undefined, path);
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        fail('CANONICAL_JSON_INVALID', 'symbol keys are not allowed', undefined, path);
      }
      const record = candidate as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareUnicodeCodePoints);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}/${key}`)}`).join(',')}}`;
    } finally {
      active.delete(object);
    }
  };
  return serialize(value, '');
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalEditorialJson(value), 'utf8');
}

export function hashBytes(bytes: Uint8Array | string): Sha256 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function canonicalSha256(value: unknown): Sha256 {
  return hashBytes(canonicalJsonBytes(value));
}

export const canonicalEditorialBytes = canonicalJsonBytes;
export const editorialCanonicalHash = canonicalSha256;

export function normalizeEditorialScalar<T extends string | number | boolean>(value: T): T {
  if (typeof value === 'string') {
    const normalized = value.replace(/\r\n?|\u000D/gu, '\n').normalize('NFC');
    if (Array.from(normalized).length > 16_000 || Buffer.byteLength(normalized, 'utf8') > 64 * 1024) {
      fail('SOURCE_LEAF_TOO_LARGE', 'normalized string leaf exceeds its hard limit');
    }
    return normalized as T;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SOURCE_SCALAR_INVALID', 'number must be finite');
    return (Object.is(value, -0) ? 0 : value) as T;
  }
  if (typeof value === 'boolean') return value;
  return fail('SOURCE_SCALAR_INVALID', 'Material value must be a string, number, or boolean');
}

export function editorialScalarText(value: string | number | boolean): string {
  const normalized = normalizeEditorialScalar(value);
  return typeof normalized === 'string' ? normalized : canonicalEditorialJson(normalized);
}

function assertSha256(value: unknown, path: string): asserts value is Sha256 {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('SCHEMA_INTEGRITY', 'expected sha256: followed by 64 lowercase hexadecimal characters', 'schema_integrity', path);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEMA_INTEGRITY', 'expected an object', 'schema_integrity', path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail('SCHEMA_INTEGRITY', `unknown field "${key}"`, 'schema_integrity', `${path}/${key}`);
    }
  }
}

function requiredKeys(value: Record<string, unknown>, required: readonly string[], path: string): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail('SCHEMA_INTEGRITY', `missing required field "${key}"`, 'schema_integrity', path);
    }
  }
}

function stringValue(value: unknown, path: string, maximumBytes = 256): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('SCHEMA_INTEGRITY', `expected a non-empty string no larger than ${maximumBytes} bytes`, 'schema_integrity', path);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('SCHEMA_INTEGRITY', 'expected a boolean', 'schema_integrity', path);
  return value;
}

function integerValue(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail('SCHEMA_INTEGRITY', `expected an integer >= ${minimum}`, 'schema_integrity', path);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail('SCHEMA_INTEGRITY', `expected one of ${allowed.join(', ')}`, 'schema_integrity', path);
  }
  return value as T;
}

function stringArray(
  value: unknown,
  path: string,
  options: { minimum?: number; maximum?: number; unique?: boolean; maximumBytes?: number } = {},
): string[] {
  if (!Array.isArray(value)) fail('SCHEMA_INTEGRITY', 'expected an array', 'schema_integrity', path);
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (value.length < minimum || value.length > maximum) {
    fail('SCHEMA_INTEGRITY', `array length must be between ${minimum} and ${maximum}`, 'schema_integrity', path);
  }
  const parsed = value.map((item, index) => stringValue(item, `${path}/${index}`, options.maximumBytes));
  if (options.unique !== false && new Set(parsed).size !== parsed.length) {
    fail('REFERENCE_INTEGRITY', 'array contains duplicate IDs', 'reference_integrity', path);
  }
  return parsed;
}

function parseSourcePointer(value: unknown, path: string): SourcePointer {
  const candidate = record(value, path);
  exactKeys(candidate, ['artifactId', 'jsonPointer'], path);
  requiredKeys(candidate, ['artifactId', 'jsonPointer'], path);
  const artifactId = stringValue(candidate.artifactId, `${path}/artifactId`);
  const jsonPointer = stringValue(candidate.jsonPointer, `${path}/jsonPointer`, 4_096);
  if (!JSON_POINTER_PATTERN.test(jsonPointer) || !jsonPointer.startsWith('/')) {
    fail('REFERENCE_INTEGRITY', 'invalid RFC 6901 JSON Pointer', 'reference_integrity', `${path}/jsonPointer`);
  }
  return { artifactId, jsonPointer };
}

export function parseEditorialSourceArtifactRef(value: unknown, path = ''): SourceArtifactRef {
  const candidate = record(value, path);
  exactKeys(candidate, ['artifactId', 'kind', 'schemaVersion', 'contentSha256'], path);
  requiredKeys(candidate, ['artifactId', 'kind', 'schemaVersion', 'contentSha256'], path);
  assertSha256(candidate.contentSha256, `${path}/contentSha256`);
  return {
    artifactId: stringValue(candidate.artifactId, `${path}/artifactId`),
    kind: stringValue(candidate.kind, `${path}/kind`),
    schemaVersion: stringValue(candidate.schemaVersion, `${path}/schemaVersion`),
    contentSha256: candidate.contentSha256,
  };
}

export interface EditorialMaterialUnitIdentityInput {
  sourceArtifactId: string;
  sourceArtifactContentSha256: Sha256;
  sourceJsonPointer: string;
  role: EditorialMaterialUnit['role'];
  value: string | number | boolean;
}

export function createEditorialMaterialUnitId(input: EditorialMaterialUnitIdentityInput): string {
  stringValue(input.sourceArtifactId, '/sourceArtifactId');
  assertSha256(input.sourceArtifactContentSha256, '/sourceArtifactContentSha256');
  if (!JSON_POINTER_PATTERN.test(input.sourceJsonPointer) || !input.sourceJsonPointer.startsWith('/')) {
    fail('REFERENCE_INTEGRITY', 'invalid RFC 6901 JSON Pointer', 'reference_integrity', '/sourceJsonPointer');
  }
  const value = normalizeEditorialScalar(input.value);
  const valueType = typeof value as 'string' | 'number' | 'boolean';
  const preimage = [
    'editorial-material-unit-v1',
    input.sourceArtifactId,
    input.sourceArtifactContentSha256,
    input.sourceJsonPointer,
    input.role,
    valueType,
    value,
  ];
  return `emu_${hashBytes(canonicalJsonBytes(preimage)).slice('sha256:'.length)}`;
}

function parseMaterialUnit(value: unknown, path: string): EditorialMaterialUnit {
  const candidate = record(value, path);
  const allowed = [
    'id', 'groupId', 'value', 'unit', 'metricEligible', 'sourceRefs', 'basisUnitIds',
    'evidenceIds', 'questionIds', 'requiredInOutput', 'requiredInBody', 'role', 'epistemicStatus',
  ];
  exactKeys(candidate, allowed, path);
  requiredKeys(candidate, [
    'id', 'value', 'metricEligible', 'sourceRefs', 'basisUnitIds', 'evidenceIds',
    'questionIds', 'requiredInOutput', 'requiredInBody', 'role',
  ], path);
  const id = stringValue(candidate.id, `${path}/id`);
  if (!/^emu_[0-9a-f]{64}$/u.test(id)) {
    fail('REFERENCE_INTEGRITY', 'Unit ID has an invalid format', 'reference_integrity', `${path}/id`);
  }
  const role = enumValue(candidate.role, ['claim', 'recommendation', 'risk', 'validation', 'context', 'audit'], `${path}/role`);
  if (
    typeof candidate.value !== 'string'
    && typeof candidate.value !== 'number'
    && typeof candidate.value !== 'boolean'
  ) {
    fail('SCHEMA_INTEGRITY', 'Unit value must be a scalar', 'schema_integrity', `${path}/value`);
  }
  const normalizedValue = normalizeEditorialScalar(candidate.value);
  if (!Object.is(normalizedValue, candidate.value) && normalizedValue !== candidate.value) {
    fail('REFERENCE_INTEGRITY', 'Unit value is not normalized', 'reference_integrity', `${path}/value`);
  }
  const refs = candidate.sourceRefs;
  if (!Array.isArray(refs) || refs.length !== 1) {
    fail('REFERENCE_INTEGRITY', 'Material Unit sourceRefs must contain exactly one SourcePointer', 'reference_integrity', `${path}/sourceRefs`);
  }
  const sourceRefs = [parseSourcePointer(refs[0], `${path}/sourceRefs/0`)] as const;
  const unitName = candidate.unit === undefined
    ? undefined
    : stringValue(candidate.unit, `${path}/unit`, 16);
  if (unitName !== undefined && !ALLOWED_UNITS.has(unitName)) {
    fail('SCHEMA_INTEGRITY', `unsupported Unit unit "${unitName}"`, 'schema_integrity', `${path}/unit`);
  }
  const metricEligible = booleanValue(candidate.metricEligible, `${path}/metricEligible`);
  if (metricEligible && typeof normalizedValue !== 'number') {
    fail('NUMERIC_INTEGRITY', 'metricEligible Unit must have a numeric value', 'numeric_integrity', path);
  }
  const epistemicStatus = candidate.epistemicStatus;
  if (role === 'claim') {
    enumValue(epistemicStatus, ['fact', 'inference', 'unknown'], `${path}/epistemicStatus`);
  } else if (role === 'recommendation') {
    if (epistemicStatus !== 'inference') {
      fail('EPISTEMIC_INTEGRITY', 'recommendation must be inference', 'epistemic_integrity', `${path}/epistemicStatus`);
    }
  } else if (role === 'risk' || role === 'validation') {
    if (epistemicStatus !== 'unknown') {
      fail('EPISTEMIC_INTEGRITY', `${role} must be unknown`, 'epistemic_integrity', `${path}/epistemicStatus`);
    }
  } else if (epistemicStatus !== undefined) {
    fail('EPISTEMIC_INTEGRITY', `${role} must not declare epistemicStatus`, 'epistemic_integrity', `${path}/epistemicStatus`);
  }
  const evidenceIds = stringArray(candidate.evidenceIds, `${path}/evidenceIds`, { maximum: 1_000 });
  if (epistemicStatus === 'fact' && evidenceIds.length === 0) {
    fail('EPISTEMIC_INTEGRITY', 'fact Unit requires Evidence', 'epistemic_integrity', `${path}/evidenceIds`);
  }
  const requiredInOutput = booleanValue(candidate.requiredInOutput, `${path}/requiredInOutput`);
  const requiredInBody = booleanValue(candidate.requiredInBody, `${path}/requiredInBody`);
  if (requiredInBody && !requiredInOutput) {
    fail('CONTENT_COVERAGE', 'requiredInBody requires requiredInOutput', 'content_coverage', path);
  }
  const parsed = {
    id,
    ...(candidate.groupId === undefined ? {} : { groupId: stringValue(candidate.groupId, `${path}/groupId`) }),
    value: normalizedValue,
    ...(unitName === undefined ? {} : { unit: unitName }),
    metricEligible,
    sourceRefs,
    basisUnitIds: stringArray(candidate.basisUnitIds, `${path}/basisUnitIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
    evidenceIds,
    questionIds: stringArray(candidate.questionIds, `${path}/questionIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
    requiredInOutput,
    requiredInBody,
    role,
    ...(epistemicStatus === undefined ? {} : { epistemicStatus }),
  };
  return parsed as EditorialMaterialUnit;
}

function parseMaterialAsset(value: unknown, path: string): EditorialMaterialAsset {
  const candidate = record(value, path);
  exactKeys(candidate, [
    'id', 'assetId', 'manifestArtifactId', 'visualRole', 'comparisonGroupId',
    'derivedFromAssetId', 'mediaType', 'byteSize', 'width', 'height', 'exportPolicy',
    'captionUnitId', 'altTextUnitId', 'evidenceIds', 'sourceRefs',
  ], path);
  requiredKeys(candidate, [
    'id', 'assetId', 'manifestArtifactId', 'visualRole', 'mediaType', 'byteSize', 'width',
    'height', 'exportPolicy', 'captionUnitId', 'altTextUnitId', 'evidenceIds', 'sourceRefs',
  ], path);
  const refs = candidate.sourceRefs;
  if (!Array.isArray(refs) || refs.length === 0) {
    fail('REFERENCE_INTEGRITY', 'Asset sourceRefs must not be empty', 'reference_integrity', `${path}/sourceRefs`);
  }
  const visualRole = enumValue(
    candidate.visualRole,
    ['standalone', 'comparison-before', 'comparison-after'],
    `${path}/visualRole`,
  );
  const comparisonGroupId = candidate.comparisonGroupId === undefined
    ? undefined
    : stringValue(candidate.comparisonGroupId, `${path}/comparisonGroupId`);
  const derivedFromAssetId = candidate.derivedFromAssetId === undefined
    ? undefined
    : stringValue(candidate.derivedFromAssetId, `${path}/derivedFromAssetId`);
  if (visualRole === 'standalone' && (comparisonGroupId !== undefined || derivedFromAssetId !== undefined)) {
    fail('REFERENCE_INTEGRITY', 'standalone Asset cannot declare comparison lineage', 'reference_integrity', path);
  }
  if (visualRole === 'comparison-before' && (comparisonGroupId === undefined || derivedFromAssetId !== undefined)) {
    fail('REFERENCE_INTEGRITY', 'comparison-before requires only comparisonGroupId', 'reference_integrity', path);
  }
  if (visualRole === 'comparison-after' && (comparisonGroupId === undefined || derivedFromAssetId === undefined)) {
    fail('REFERENCE_INTEGRITY', 'comparison-after requires group and derivation lineage', 'reference_integrity', path);
  }
  return {
    id: stringValue(candidate.id, `${path}/id`),
    assetId: stringValue(candidate.assetId, `${path}/assetId`),
    manifestArtifactId: stringValue(candidate.manifestArtifactId, `${path}/manifestArtifactId`),
    visualRole,
    ...(comparisonGroupId === undefined ? {} : { comparisonGroupId }),
    ...(derivedFromAssetId === undefined ? {} : { derivedFromAssetId }),
    mediaType: enumValue(candidate.mediaType, ['image/png', 'image/jpeg', 'image/webp'], `${path}/mediaType`),
    byteSize: integerValue(candidate.byteSize, `${path}/byteSize`, 1),
    width: integerValue(candidate.width, `${path}/width`, 1),
    height: integerValue(candidate.height, `${path}/height`, 1),
    exportPolicy: enumValue(candidate.exportPolicy, ['allow'], `${path}/exportPolicy`),
    captionUnitId: stringValue(candidate.captionUnitId, `${path}/captionUnitId`),
    altTextUnitId: stringValue(candidate.altTextUnitId, `${path}/altTextUnitId`),
    evidenceIds: stringArray(candidate.evidenceIds, `${path}/evidenceIds`, { maximum: 1_000 }),
    sourceRefs: refs.map((ref, index) => parseSourcePointer(ref, `${path}/sourceRefs/${index}`)) as [SourcePointer, ...SourcePointer[]],
  };
}

function parseEditorialEvidence(value: unknown, path: string): EditorialEvidenceEntry {
  const candidate = record(value, path);
  exactKeys(candidate, [
    'id', 'kind', 'evidenceClass', 'artifactId', 'artifactContentSha256', 'jsonPointer',
    'sensitivity', 'redaction', 'toolId', 'toolTier', 'toolProof', 'sourceUrl',
  ], path);
  requiredKeys(candidate, [
    'id', 'kind', 'evidenceClass', 'artifactId', 'artifactContentSha256', 'jsonPointer',
    'sensitivity', 'redaction',
  ], path);
  assertSha256(candidate.artifactContentSha256, `${path}/artifactContentSha256`);
  const evidenceClass = stringValue(candidate.evidenceClass, `${path}/evidenceClass`);
  if (!EVIDENCE_CLASSES.has(evidenceClass)) {
    fail('SCHEMA_INTEGRITY', 'unknown Evidence class', 'schema_integrity', `${path}/evidenceClass`);
  }
  const toolProof = candidate.toolProof === undefined ? undefined : record(candidate.toolProof, `${path}/toolProof`);
  if (toolProof) {
    exactKeys(toolProof, ['implementationId', 'executionMode', 'redactedOutputHash'], `${path}/toolProof`);
    requiredKeys(toolProof, ['implementationId', 'executionMode', 'redactedOutputHash'], `${path}/toolProof`);
    stringValue(toolProof.implementationId, `${path}/toolProof/implementationId`);
    enumValue(toolProof.executionMode, ['real'], `${path}/toolProof/executionMode`);
    stringValue(toolProof.redactedOutputHash, `${path}/toolProof/redactedOutputHash`);
  }
  const sensitivity = enumValue(candidate.sensitivity, ['public', 'internal', 'sensitive'], `${path}/sensitivity`);
  const redaction = enumValue(candidate.redaction, ['none', 'masked', 'blocked'], `${path}/redaction`);
  const toolTier = candidate.toolTier === undefined
    ? undefined
    : enumValue(candidate.toolTier, ['core', 'optional'], `${path}/toolTier`);
  if (sensitivity === 'sensitive' || redaction === 'blocked') {
    fail('REFERENCE_INTEGRITY', 'blocked or sensitive Evidence cannot enter Material', 'reference_integrity', path);
  }
  let sourceUrl: string | undefined;
  if (candidate.sourceUrl !== undefined) {
    const rawUrl = stringValue(candidate.sourceUrl, `${path}/sourceUrl`, 4_096);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      fail('REFERENCE_INTEGRITY', 'Evidence sourceUrl must be a canonical public HTTPS URL', 'reference_integrity', `${path}/sourceUrl`);
    }
    if (
      evidenceClass !== 'public_source'
      || sensitivity !== 'public'
      || parsedUrl.protocol !== 'https:'
      || parsedUrl.username !== ''
      || parsedUrl.password !== ''
      || parsedUrl.toString() !== rawUrl
    ) {
      fail('REFERENCE_INTEGRITY', 'Evidence sourceUrl must be a canonical public HTTPS URL', 'reference_integrity', `${path}/sourceUrl`);
    }
    sourceUrl = rawUrl;
  }
  return {
    id: stringValue(candidate.id, `${path}/id`),
    kind: enumValue(candidate.kind, ['tool_output', 'knowledge_excerpt', 'user_constraint', 'screenshot'], `${path}/kind`),
    evidenceClass: evidenceClass as EditorialEvidenceEntry['evidenceClass'],
    artifactId: stringValue(candidate.artifactId, `${path}/artifactId`),
    artifactContentSha256: candidate.artifactContentSha256,
    jsonPointer: parseSourcePointer({ artifactId: candidate.artifactId, jsonPointer: candidate.jsonPointer }, path).jsonPointer,
    sensitivity,
    redaction,
    ...(candidate.toolId === undefined ? {} : { toolId: stringValue(candidate.toolId, `${path}/toolId`) }),
    ...(toolTier === undefined ? {} : { toolTier }),
    ...(toolProof === undefined ? {} : {
      toolProof: {
        implementationId: toolProof.implementationId as string,
        executionMode: 'real' as const,
        redactedOutputHash: toolProof.redactedOutputHash as string,
      },
    }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

function sameSourceArtifact(left: SourceArtifactRef, right: SourceArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.kind === right.kind
    && left.schemaVersion === right.schemaVersion
    && left.contentSha256 === right.contentSha256;
}

function assertAcyclicBasis(units: EditorialMaterialUnit[]): void {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail('REFERENCE_INTEGRITY', 'basis graph contains a cycle', 'reference_integrity');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const basisId of byId.get(id)!.basisUnitIds) visit(basisId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const unit of units) visit(unit.id);
}

export function parseEditorialMaterial(value: unknown): EditorialMaterial {
  const candidate = record(value, '');
  exactKeys(candidate, [
    'version', 'taskId', 'planVersionId', 'attemptId', 'deliverableType', 'presentationMode',
    'sourceReportPackage', 'sourceArtifacts', 'materializationWarningCodes', 'titleUnitId', 'methodSummaryUnitId', 'units',
    'assets', 'evidence',
  ], '');
  requiredKeys(candidate, [
    'version', 'taskId', 'planVersionId', 'attemptId', 'deliverableType', 'presentationMode',
    'sourceReportPackage', 'sourceArtifacts', 'materializationWarningCodes', 'methodSummaryUnitId', 'units', 'assets', 'evidence',
  ], '');
  if (candidate.version !== EDITORIAL_MATERIAL_VERSION) {
    fail('SCHEMA_INTEGRITY', `version must be ${EDITORIAL_MATERIAL_VERSION}`, 'schema_integrity', '/version');
  }
  const deliverableType = stringValue(candidate.deliverableType, '/deliverableType') as EditorialDeliverableType;
  if (!DELIVERABLE_TYPES.has(deliverableType)) {
    fail('EDITORIAL_DELIVERABLE_UNSUPPORTED', `unsupported deliverable type "${deliverableType}"`, 'schema_integrity', '/deliverableType');
  }
  if (!Array.isArray(candidate.sourceArtifacts) || candidate.sourceArtifacts.length === 0 || candidate.sourceArtifacts.length > 512) {
    fail('SCHEMA_INTEGRITY', 'sourceArtifacts length is invalid', 'schema_integrity', '/sourceArtifacts');
  }
  if (!Array.isArray(candidate.units) || candidate.units.length === 0 || candidate.units.length > EDITORIAL_MAX_MATERIAL_UNITS) {
    fail('MATERIAL_HARD_LIMIT_EXCEEDED', `Material must contain 1..${EDITORIAL_MAX_MATERIAL_UNITS} Units`, 'schema_integrity', '/units');
  }
  if (!Array.isArray(candidate.assets) || candidate.assets.length > 24) {
    fail('MATERIAL_HARD_LIMIT_EXCEEDED', 'Material assets exceed their hard limit', 'schema_integrity', '/assets');
  }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length > 1_000) {
    fail('MATERIAL_HARD_LIMIT_EXCEEDED', 'Material Evidence exceeds its hard limit', 'schema_integrity', '/evidence');
  }
  if (!Array.isArray(candidate.materializationWarningCodes) || candidate.materializationWarningCodes.length > 128) {
    fail('MATERIAL_HARD_LIMIT_EXCEEDED', 'Material warning codes exceed their hard limit', 'schema_integrity', '/materializationWarningCodes');
  }
  const materializationWarningCodes = candidate.materializationWarningCodes.map((code, index) => enumValue(
    code,
    EDITORIAL_MATERIALIZATION_WARNING_CODES,
    `/materializationWarningCodes/${index}`,
  ));
  const sourceReportPackage = parseEditorialSourceArtifactRef(candidate.sourceReportPackage, '/sourceReportPackage');
  const sourceArtifacts = candidate.sourceArtifacts.map((item, index) => (
    parseEditorialSourceArtifactRef(item, `/sourceArtifacts/${index}`)
  ));
  const sourceById = new Map<string, SourceArtifactRef>();
  for (const source of sourceArtifacts) {
    if (sourceById.has(source.artifactId)) {
      fail('REFERENCE_INTEGRITY', `duplicate source Artifact "${source.artifactId}"`, 'reference_integrity', '/sourceArtifacts');
    }
    sourceById.set(source.artifactId, source);
  }
  const packageInSources = sourceById.get(sourceReportPackage.artifactId);
  if (!packageInSources || !sameSourceArtifact(packageInSources, sourceReportPackage)) {
    fail('REFERENCE_INTEGRITY', 'sourceArtifacts must contain the exact source Report Package', 'reference_integrity', '/sourceReportPackage');
  }
  const units = candidate.units.map((item, index) => parseMaterialUnit(item, `/units/${index}`));
  const unitById = new Map<string, EditorialMaterialUnit>();
  let textCodePoints = 0;
  for (const [index, unit] of units.entries()) {
    if (unitById.has(unit.id)) {
      fail('REFERENCE_INTEGRITY', `duplicate Unit ID "${unit.id}"`, 'reference_integrity', `/units/${index}/id`);
    }
    const pointer = unit.sourceRefs[0];
    const source = sourceById.get(pointer.artifactId);
    if (!source) {
      fail('REFERENCE_INTEGRITY', `Unit source Artifact "${pointer.artifactId}" is missing`, 'reference_integrity', `/units/${index}/sourceRefs/0`);
    }
    const expectedId = createEditorialMaterialUnitId({
      sourceArtifactId: source.artifactId,
      sourceArtifactContentSha256: source.contentSha256,
      sourceJsonPointer: pointer.jsonPointer,
      role: unit.role,
      value: unit.value,
    });
    if (unit.id !== expectedId) {
      fail('REFERENCE_INTEGRITY', `Unit ID does not match its canonical identity`, 'reference_integrity', `/units/${index}/id`);
    }
    if (typeof unit.value === 'string') textCodePoints += Array.from(unit.value).length;
    unitById.set(unit.id, unit);
  }
  if (textCodePoints > EDITORIAL_MAX_MATERIAL_CODE_POINTS) {
    fail('MATERIAL_HARD_LIMIT_EXCEEDED', 'Material normalized text exceeds its hard limit', 'schema_integrity', '/units');
  }
  for (const [index, unit] of units.entries()) {
    for (const basisId of unit.basisUnitIds) {
      if (!unitById.has(basisId)) {
        fail('REFERENCE_INTEGRITY', `basis Unit "${basisId}" is dangling`, 'reference_integrity', `/units/${index}/basisUnitIds`);
      }
    }
  }
  assertAcyclicBasis(units);
  const evidence = candidate.evidence.map((item, index) => parseEditorialEvidence(item, `/evidence/${index}`));
  const evidenceById = new Map<string, EditorialEvidenceEntry>();
  for (const [index, entry] of evidence.entries()) {
    if (evidenceById.has(entry.id)) {
      fail('REFERENCE_INTEGRITY', `duplicate Evidence ID "${entry.id}"`, 'reference_integrity', `/evidence/${index}/id`);
    }
    const source = sourceById.get(entry.artifactId);
    if (!source || source.contentSha256 !== entry.artifactContentSha256) {
      fail('REFERENCE_INTEGRITY', `Evidence Artifact "${entry.artifactId}" is not source-bound`, 'reference_integrity', `/evidence/${index}`);
    }
    evidenceById.set(entry.id, entry);
  }
  const assets = candidate.assets.map((item, index) => parseMaterialAsset(item, `/assets/${index}`));
  const assetIds = new Set<string>();
  const assetPairs = new Set<string>();
  for (const [index, asset] of assets.entries()) {
    const pair = `${asset.assetId}\u0000${asset.manifestArtifactId}`;
    if (assetIds.has(asset.id) || assetPairs.has(pair)) {
      fail('REFERENCE_INTEGRITY', 'duplicate Editorial Asset identity', 'reference_integrity', `/assets/${index}`);
    }
    assetIds.add(asset.id);
    assetPairs.add(pair);
    for (const ref of asset.sourceRefs) {
      if (!sourceById.has(ref.artifactId)) {
        fail('REFERENCE_INTEGRITY', `Asset source Artifact "${ref.artifactId}" is missing`, 'reference_integrity', `/assets/${index}/sourceRefs`);
      }
    }
    for (const unitId of [asset.captionUnitId, asset.altTextUnitId]) {
      const captionUnit = unitById.get(unitId);
      if (!captionUnit || (captionUnit.role !== 'context' && captionUnit.role !== 'audit') || !captionUnit.requiredInOutput) {
        fail('REFERENCE_INTEGRITY', 'Asset caption/alt Unit must be an output-required context or audit Unit', 'reference_integrity', `/assets/${index}`);
      }
    }
    if (asset.captionUnitId === asset.altTextUnitId) {
      fail('REFERENCE_INTEGRITY', 'Asset caption and alt text must use two distinct Units', 'reference_integrity', `/assets/${index}`);
    }
  }
  const comparisonGroups = new Map<string, EditorialMaterialAsset[]>();
  for (const asset of assets) {
    if (asset.comparisonGroupId) {
      const group = comparisonGroups.get(asset.comparisonGroupId) ?? [];
      group.push(asset);
      comparisonGroups.set(asset.comparisonGroupId, group);
    }
  }
  for (const [groupId, group] of comparisonGroups) {
    const before = group.filter(({ visualRole }) => visualRole === 'comparison-before');
    const after = group.filter(({ visualRole }) => visualRole === 'comparison-after');
    if (group.length !== 2 || before.length !== 1 || after.length !== 1 || after[0]!.derivedFromAssetId !== before[0]!.assetId) {
      fail('REFERENCE_INTEGRITY', `comparison group "${groupId}" is not an exact before/after pair`, 'reference_integrity', '/assets');
    }
  }
  const referencedEvidence = new Set<string>();
  for (const owner of [...units, ...assets]) {
    for (const evidenceId of owner.evidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        fail('REFERENCE_INTEGRITY', `Evidence ID "${evidenceId}" is dangling`, 'reference_integrity');
      }
      referencedEvidence.add(evidenceId);
    }
  }
  if (evidence.length !== referencedEvidence.size || evidence.some(({ id }) => !referencedEvidence.has(id))) {
    fail('REFERENCE_INTEGRITY', 'Material Evidence must equal the exact referenced Evidence set', 'reference_integrity', '/evidence');
  }
  const methodSummaryUnitId = stringValue(candidate.methodSummaryUnitId, '/methodSummaryUnitId');
  const methodUnit = unitById.get(methodSummaryUnitId);
  if (!methodUnit || methodUnit.role !== 'context' || !methodUnit.requiredInBody || !methodUnit.requiredInOutput) {
    fail('CONTENT_COVERAGE', 'methodSummaryUnitId must reference a body-required context Unit', 'content_coverage', '/methodSummaryUnitId');
  }
  const titleUnitId = candidate.titleUnitId === undefined
    ? undefined
    : stringValue(candidate.titleUnitId, '/titleUnitId');
  if (titleUnitId !== undefined) {
    const titleUnit = unitById.get(titleUnitId);
    if (!titleUnit || titleUnit.role !== 'context') {
      fail('REFERENCE_INTEGRITY', 'titleUnitId must reference a context Unit', 'reference_integrity', '/titleUnitId');
    }
  }
  const parsed: EditorialMaterial = {
    version: EDITORIAL_MATERIAL_VERSION,
    taskId: stringValue(candidate.taskId, '/taskId'),
    planVersionId: stringValue(candidate.planVersionId, '/planVersionId'),
    attemptId: stringValue(candidate.attemptId, '/attemptId'),
    deliverableType,
    presentationMode: enumValue(candidate.presentationMode, ['current_text', 'multimodal'], '/presentationMode'),
    sourceReportPackage,
    sourceArtifacts,
    materializationWarningCodes,
    ...(titleUnitId === undefined ? {} : { titleUnitId }),
    methodSummaryUnitId,
    units,
    assets,
    evidence,
  };
  if (canonicalJsonBytes(parsed).byteLength > EDITORIAL_MAX_JSON_BYTES) {
    fail('MATERIAL_HARD_LIMIT_EXCEEDED', 'Material canonical JSON exceeds 8 MiB', 'schema_integrity');
  }
  return parsed;
}

export function assertValidEditorialMaterial(value: unknown): asserts value is EditorialMaterial {
  parseEditorialMaterial(value);
}

export interface ProjectedEditorialModelContext {
  context: EditorialModelContext;
  bytes: Buffer;
  hash: Sha256;
  byteSize: number;
}

export function projectEditorialModelContext(materialInput: EditorialMaterial): ProjectedEditorialModelContext {
  const material = parseEditorialMaterial(materialInput);
  const editorialIdBySourceAsset = new Map(material.assets.map(({ assetId, id }) => [assetId, id]));
  const context: EditorialModelContext = {
    version: EDITORIAL_MODEL_CONTEXT_VERSION,
    materialHash: canonicalSha256(material),
    deliverableType: material.deliverableType,
    units: material.units.map((unit) => ({
      id: unit.id,
      value: unit.value,
      ...(unit.unit === undefined ? {} : { unit: unit.unit }),
      role: unit.role,
      ...('epistemicStatus' in unit && unit.epistemicStatus !== undefined
        ? { epistemicStatus: unit.epistemicStatus }
        : {}),
      metricEligible: unit.metricEligible,
      ...(unit.groupId === undefined ? {} : { groupId: unit.groupId }),
      basisUnitIds: [...unit.basisUnitIds],
      questionIds: [...unit.questionIds],
      requiredInOutput: unit.requiredInOutput,
      requiredInBody: unit.requiredInBody,
    })),
    assets: material.assets.map((asset) => ({
      id: asset.id,
      visualRole: asset.visualRole,
      ...(asset.comparisonGroupId === undefined ? {} : { comparisonGroupId: asset.comparisonGroupId }),
      ...(asset.derivedFromAssetId === undefined
        ? {}
        : { derivedFromEditorialAssetId: editorialIdBySourceAsset.get(asset.derivedFromAssetId)! }),
      captionUnitId: asset.captionUnitId,
      altTextUnitId: asset.altTextUnitId,
    })),
  };
  const bytes = canonicalJsonBytes(context);
  return { context, bytes, hash: hashBytes(bytes), byteSize: bytes.byteLength };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const MODEL_EGRESS_POLICY_BODY = {
  version: EDITORIAL_MODEL_EGRESS_VERSION,
  defaultDecision: 'deny',
  allowed: [
    {
      sensitivity: 'public',
      redactionPolicyVersion: 'v1',
      provider: 'gateway',
      mode: 'real',
      endpointHost: 'llm-gw.jd.local',
      endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
      redirectMode: 'error',
    },
    {
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      provider: 'gateway',
      mode: 'real',
      endpointHost: 'llm-gw.jd.local',
      endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
      redirectMode: 'error',
    },
  ],
} as const;

export const EDITORIAL_MODEL_EGRESS_POLICY: EditorialModelEgressPolicy = deepFreeze({
  ...MODEL_EGRESS_POLICY_BODY,
  policyHash: canonicalSha256(MODEL_EGRESS_POLICY_BODY),
});

export const NO_EDITORIAL_MODEL_PORT: EditorialModelPort = deepFreeze({
  client: null,
  configuration: null,
});

export function createPhase1EditorialModelPort(): EditorialModelPort {
  return NO_EDITORIAL_MODEL_PORT;
}

function parseSourcePolicyMetadata(value: unknown, path: string): EditorialSourcePolicyMetadata {
  const candidate = record(value, path);
  exactKeys(candidate, ['artifactId', 'contentSha256', 'sensitivity', 'redactionPolicyVersion'], path);
  requiredKeys(candidate, ['artifactId', 'contentSha256', 'sensitivity', 'redactionPolicyVersion'], path);
  assertSha256(candidate.contentSha256, `${path}/contentSha256`);
  return {
    artifactId: stringValue(candidate.artifactId, `${path}/artifactId`),
    contentSha256: candidate.contentSha256,
    sensitivity: stringValue(candidate.sensitivity, `${path}/sensitivity`, 64),
    redactionPolicyVersion: stringValue(candidate.redactionPolicyVersion, `${path}/redactionPolicyVersion`, 64),
  };
}

function parseEditorialLLMLimits(value: unknown, path: string): EditorialLLMLimits {
  const candidate = record(value, path);
  exactKeys(candidate, [
    'overallTimeoutMs', 'maxHttpAttempts', 'maxRetryAfterMs', 'maxResponseBytes', 'maxOutputTokens',
  ], path);
  requiredKeys(candidate, [
    'overallTimeoutMs', 'maxHttpAttempts', 'maxRetryAfterMs', 'maxResponseBytes', 'maxOutputTokens',
  ], path);
  const limits = {
    overallTimeoutMs: integerValue(candidate.overallTimeoutMs, `${path}/overallTimeoutMs`, 1),
    maxHttpAttempts: integerValue(candidate.maxHttpAttempts, `${path}/maxHttpAttempts`, 1),
    maxRetryAfterMs: integerValue(candidate.maxRetryAfterMs, `${path}/maxRetryAfterMs`, 0),
    maxResponseBytes: integerValue(candidate.maxResponseBytes, `${path}/maxResponseBytes`, 1),
    maxOutputTokens: integerValue(candidate.maxOutputTokens, `${path}/maxOutputTokens`, 1),
  };
  if (
    limits.overallTimeoutMs !== 90_000
    || limits.maxHttpAttempts !== 3
    || limits.maxRetryAfterMs !== 5_000
    || limits.maxResponseBytes !== 1_048_576
    || limits.maxOutputTokens !== 8_000
  ) {
    fail('MODEL_IDENTITY_INVALID', 'Editorial LLM limits must equal the V1 fixed limits', 'model_identity', path);
  }
  return limits as EditorialLLMLimits;
}

export function parseEditorialGatewayConfiguration(
  value: unknown,
  path = '/gatewayConfiguration',
): EditorialGatewayConfiguration {
  const candidate = record(value, path);
  exactKeys(candidate, [
    'provider', 'endpointHost', 'endpointUrl', 'mode', 'eligibleAsReal', 'redirectMode',
    'routes', 'limits', 'gatewayConfigurationHash',
  ], path);
  requiredKeys(candidate, [
    'provider', 'endpointHost', 'endpointUrl', 'mode', 'eligibleAsReal', 'redirectMode',
    'routes', 'limits', 'gatewayConfigurationHash',
  ], path);
  if (!Array.isArray(candidate.routes) || candidate.routes.length === 0 || candidate.routes.length > 16) {
    fail('MODEL_IDENTITY_INVALID', 'Gateway routes must contain 1..16 entries', 'model_identity', `${path}/routes`);
  }
  const routes = candidate.routes.map((route, index) => {
    const routePath = `${path}/routes/${index}`;
    const parsed = record(route, routePath);
    exactKeys(parsed, ['requestedModel', 'expectedActualModel', 'expectedActualModelExplicit'], routePath);
    requiredKeys(parsed, ['requestedModel', 'expectedActualModel', 'expectedActualModelExplicit'], routePath);
    if (parsed.expectedActualModelExplicit !== true) {
      fail('MODEL_IDENTITY_INVALID', 'Gateway route requires an explicit actual-model pin', 'model_identity', routePath);
    }
    return {
      requestedModel: stringValue(parsed.requestedModel, `${routePath}/requestedModel`),
      expectedActualModel: stringValue(parsed.expectedActualModel, `${routePath}/expectedActualModel`),
      expectedActualModelExplicit: true as const,
    };
  });
  assertSha256(candidate.gatewayConfigurationHash, `${path}/gatewayConfigurationHash`);
  const parsed: EditorialGatewayConfiguration = {
    provider: stringValue(candidate.provider, `${path}/provider`),
    endpointHost: stringValue(candidate.endpointHost, `${path}/endpointHost`, 253),
    endpointUrl: stringValue(candidate.endpointUrl, `${path}/endpointUrl`, 2_048),
    mode: enumValue(candidate.mode, ['mock', 'real', 'draft'], `${path}/mode`),
    eligibleAsReal: booleanValue(candidate.eligibleAsReal, `${path}/eligibleAsReal`),
    redirectMode: enumValue(candidate.redirectMode, ['error'], `${path}/redirectMode`),
    routes,
    limits: parseEditorialLLMLimits(candidate.limits, `${path}/limits`),
    gatewayConfigurationHash: candidate.gatewayConfigurationHash,
  };
  const { gatewayConfigurationHash: _claimedHash, ...hashInput } = parsed;
  const expectedHash = canonicalSha256(hashInput);
  if (parsed.gatewayConfigurationHash !== expectedHash) {
    fail('MODEL_IDENTITY_INVALID', 'Gateway configuration hash is invalid', 'model_identity', `${path}/gatewayConfigurationHash`);
  }
  if (canonicalJsonBytes(parsed).byteLength > 16 * 1024) {
    fail('MODEL_IDENTITY_INVALID', 'Gateway configuration exceeds 16 KiB', 'model_identity', path);
  }
  return parsed;
}

function canonicalUniquePolicySet(
  input: readonly EditorialSourcePolicyMetadata[],
): EditorialSourcePolicyMetadata[] {
  const byBytes = new Map<string, EditorialSourcePolicyMetadata>();
  for (const [index, item] of input.entries()) {
    const parsed = parseSourcePolicyMetadata(item, `/sourcePolicyMetadata/${index}`);
    byBytes.set(canonicalEditorialJson([
      parsed.artifactId,
      parsed.contentSha256,
      parsed.sensitivity,
      parsed.redactionPolicyVersion,
    ]), parsed);
  }
  return [...byBytes.entries()]
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([, item]) => item);
}

export function evaluateEditorialModelEgress(input: {
  sourcePolicyMetadata: readonly EditorialSourcePolicyMetadata[];
  modelPort: EditorialModelPort;
}): EditorialModelEgressDecision {
  if (input.sourcePolicyMetadata.length === 0) {
    fail('MODEL_EGRESS_INVALID', 'source policy set must not be empty', 'model_egress');
  }
  const sources = canonicalUniquePolicySet(input.sourcePolicyMetadata);
  const sensitivities = [...new Set(sources.map(({ sensitivity }) => sensitivity))].sort(compareUnicodeCodePoints);
  const redactionPolicyVersions = [...new Set(sources.map(({ redactionPolicyVersion }) => redactionPolicyVersion))]
    .sort(compareUnicodeCodePoints);
  if (sensitivities.length > 16 || redactionPolicyVersions.length > 16) {
    fail('MODEL_EGRESS_INVALID', 'source policy dimensions exceed their bounded cardinality', 'model_egress');
  }
  const configuration = input.modelPort.configuration;
  const evaluated: EditorialModelEgressDecision['evaluated'] = {
    sourcePolicySetHash: canonicalSha256(sources.map((source) => [
      source.artifactId,
      source.contentSha256,
      source.sensitivity,
      source.redactionPolicyVersion,
    ])),
    contributingSourceCount: sources.length,
    sensitivities,
    redactionPolicyVersions,
    provider: configuration?.provider ?? null,
    mode: configuration?.mode ?? null,
    endpointHost: configuration?.endpointHost ?? null,
    endpointUrl: configuration?.endpointUrl ?? null,
    redirectMode: configuration?.redirectMode ?? null,
  };
  let reasonCode: EditorialModelEgressDecision['reasonCode'];
  if (sensitivities.some((value) => value !== 'public' && value !== 'internal')) {
    reasonCode = 'EGRESS_SENSITIVITY_DENIED';
  } else if (redactionPolicyVersions.some((value) => value !== 'v1')) {
    reasonCode = 'EGRESS_REDACTION_POLICY_DENIED';
  } else if (configuration === null) {
    reasonCode = 'EGRESS_MODEL_UNCONFIGURED';
  } else if (configuration.provider !== 'gateway') {
    reasonCode = 'EGRESS_PROVIDER_DENIED';
  } else if (configuration.mode !== 'real' || !configuration.eligibleAsReal) {
    reasonCode = 'EGRESS_MODE_DENIED';
  } else if (
    configuration.endpointHost !== 'llm-gw.jd.local'
    || configuration.endpointUrl !== 'http://llm-gw.jd.local/v1/chat/completions'
  ) {
    reasonCode = 'EGRESS_ENDPOINT_DENIED';
  } else if (configuration.redirectMode !== 'error') {
    reasonCode = 'EGRESS_REDIRECT_POLICY_DENIED';
  } else {
    reasonCode = 'EGRESS_ALLOWED';
  }
  return {
    policyVersion: EDITORIAL_MODEL_EGRESS_VERSION,
    policyHash: EDITORIAL_MODEL_EGRESS_POLICY.policyHash,
    decision: reasonCode === 'EGRESS_ALLOWED' ? 'allow' : 'deny',
    reasonCode,
    evaluated,
  };
}

export interface EditorialRequestKeyInput {
  sourceReportPackageId: string;
  sourceReportPackageHash: Sha256;
  materialHash: Sha256;
  modelContextHash: Sha256;
  modelEgress: EditorialModelEgressDecision;
  gatewayConfiguration: EditorialGatewayConfiguration | null;
}

export function createEditorialRequestKey(input: EditorialRequestKeyInput): string {
  stringValue(input.sourceReportPackageId, '/sourceReportPackageId');
  assertSha256(input.sourceReportPackageHash, '/sourceReportPackageHash');
  assertSha256(input.materialHash, '/materialHash');
  assertSha256(input.modelContextHash, '/modelContextHash');
  if (input.modelEgress.policyVersion !== EDITORIAL_MODEL_EGRESS_VERSION
    || input.modelEgress.policyHash !== EDITORIAL_MODEL_EGRESS_POLICY.policyHash) {
    fail('MODEL_EGRESS_INVALID', 'egress decision does not use the fixed V1 policy', 'model_egress');
  }
  if (input.gatewayConfiguration !== null) parseEditorialGatewayConfiguration(input.gatewayConfiguration);
  const digest = canonicalSha256({
    sourceReportPackageId: input.sourceReportPackageId,
    sourceReportPackageHash: input.sourceReportPackageHash,
    materialHash: input.materialHash,
    modelContextHash: input.modelContextHash,
    ...EDITORIAL_PIPELINE_VERSIONS,
    modelEgress: input.modelEgress,
    gatewayConfiguration: input.gatewayConfiguration,
  });
  return `erq_${digest.slice('sha256:'.length)}`;
}

export interface EditorialGenerationIdInput {
  requestKey: string;
  mode: 'llm' | 'deterministic_fallback';
  materialHash: Sha256;
  publishedBlueprintHash: Sha256;
  exportedAssetHashes: Array<{ assetId: string; contentSha256: Sha256 }>;
}

export function createEditorialGenerationId(input: EditorialGenerationIdInput): string {
  if (!REQUEST_KEY_PATTERN.test(input.requestKey)) {
    fail('REFERENCE_INTEGRITY', 'requestKey is invalid', 'reference_integrity', '/requestKey');
  }
  assertSha256(input.materialHash, '/materialHash');
  assertSha256(input.publishedBlueprintHash, '/publishedBlueprintHash');
  if (input.exportedAssetHashes.length > 6) {
    fail('VISUAL_POLICY', 'exportedAssets exceeds six entries', 'visual_policy', '/exportedAssetHashes');
  }
  const seen = new Set<string>();
  for (const [index, asset] of input.exportedAssetHashes.entries()) {
    const candidate = record(asset, `/exportedAssetHashes/${index}`);
    exactKeys(candidate, ['assetId', 'contentSha256'], `/exportedAssetHashes/${index}`);
    stringValue(candidate.assetId, `/exportedAssetHashes/${index}/assetId`);
    assertSha256(candidate.contentSha256, `/exportedAssetHashes/${index}/contentSha256`);
    if (seen.has(candidate.assetId as string)) {
      fail('REFERENCE_INTEGRITY', 'exportedAssets contains duplicate asset IDs', 'reference_integrity');
    }
    seen.add(candidate.assetId as string);
  }
  const digest = canonicalSha256({
    requestKey: input.requestKey,
    mode: input.mode,
    materialHash: input.materialHash,
    publishedBlueprintHash: input.publishedBlueprintHash,
    rendererVersion: EDITORIAL_RENDERER_VERSION,
    exportedAssetHashes: input.exportedAssetHashes,
  });
  return `er_${digest.slice('sha256:'.length)}`;
}

const CHINESE_NUMBER_PATTERN = /[〇零一二两兩三四五六七八九十百千万萬亿億兆壹贰貳叁參肆伍陆陸柒捌玖拾佰仟廿卅卌]/u;
const DECIMAL_NUMBER_PATTERN = /\p{Nd}/u;
const MONEY_OR_RATIO_PATTERN = /[¥￥$€£%％]|百分之|千分之|[成折]|(?:^|[^A-Za-z])(?:CNY|RMB|USD|EUR|GBP)(?=$|[^A-Za-z])/iu;
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s\u0000-\u001f<>"'()[\]{}（）【】]+/giu;
const TRAILING_URL_PUNCTUATION = /[.,;:!?，。；：！？]+$/u;

export function hasEditorialSensitiveToken(text: string, evidenceIds: readonly string[] = []): boolean {
  if (DECIMAL_NUMBER_PATTERN.test(text) || CHINESE_NUMBER_PATTERN.test(text) || MONEY_OR_RATIO_PATTERN.test(text)) {
    return true;
  }
  if (evidenceIds.some((evidenceId) => evidenceId.length > 0 && text.includes(evidenceId))) return true;
  URL_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_CANDIDATE_PATTERN)) {
    const candidate = match[0].replace(TRAILING_URL_PUNCTUATION, '');
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
    } catch {
      // A malformed candidate is ordinary prose for this scanner.
    }
  }
  return false;
}

export function formatEditorialRatio(value: number): string {
  if (!Number.isFinite(value)) fail('NUMERIC_INTEGRITY', 'ratio must be finite', 'numeric_integrity');
  const lexeme = canonicalEditorialJson(value);
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [mantissa, exponentText] = unsigned.toLowerCase().split('e');
  const exponent = (exponentText === undefined ? 0 : Number(exponentText)) + 2;
  const [integerPart, fractionPart = ''] = mantissa!.split('.');
  const digits = `${integerPart}${fractionPart}`;
  const decimalPosition = integerPart!.length + exponent;
  let rendered: string;
  if (decimalPosition <= 0) {
    rendered = `0.${'0'.repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    rendered = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  } else {
    rendered = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  let [renderedInteger, renderedFraction] = rendered.split('.');
  renderedInteger = renderedInteger!.replace(/^0+(?=\d)/u, '') || '0';
  if (renderedFraction !== undefined) renderedFraction = renderedFraction.replace(/0+$/u, '');
  const normalized = renderedFraction ? `${renderedInteger}.${renderedFraction}` : renderedInteger;
  const signed = negative && normalized !== '0' ? `-${normalized}` : normalized;
  return `${signed}%`;
}

function parseCopy(value: unknown, path: string): EditorialCopy {
  const candidate = record(value, path);
  exactKeys(candidate, ['text', 'mode', 'materialUnitIds'], path);
  requiredKeys(candidate, ['text', 'mode', 'materialUnitIds'], path);
  const mode = enumValue(candidate.mode, ['verbatim', 'paraphrase'], `${path}/mode`);
  const text = stringValue(candidate.text, `${path}/text`, 64 * 1024);
  const maximumCodePoints = mode === 'verbatim' ? 16_000 : 600;
  if (Array.from(text).length > maximumCodePoints) {
    fail('SCHEMA_INTEGRITY', `${mode} copy exceeds ${maximumCodePoints} code points`, 'schema_integrity', `${path}/text`);
  }
  const materialUnitIds = stringArray(candidate.materialUnitIds, `${path}/materialUnitIds`, {
    minimum: 1,
    maximum: 16,
  });
  return { text, mode, materialUnitIds };
}

interface BlueprintParseBudget {
  blocks: number;
  copies: number;
  copyCodePoints: number;
}

function budgetCopy(copy: EditorialCopy, budget: BlueprintParseBudget): EditorialCopy {
  budget.copies += 1;
  budget.copyCodePoints += Array.from(copy.text).length;
  return copy;
}

function parseBudgetedCopy(value: unknown, path: string, budget: BlueprintParseBudget): EditorialCopy {
  return budgetCopy(parseCopy(value, path), budget);
}

function nonEmptyArray(value: unknown, path: string, maximum = 24): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    fail('SCHEMA_INTEGRITY', `array length must be between 1 and ${maximum}`, 'schema_integrity', path);
  }
  return value;
}

function parseBlueprintBlock(
  value: unknown,
  path: string,
  budget: BlueprintParseBudget,
  allowAudit: boolean,
): EditorialBlueprintBlock {
  const candidate = record(value, path);
  requiredKeys(candidate, ['id', 'kind'], path);
  const id = stringValue(candidate.id, `${path}/id`, 64);
  if (!SAFE_BLUEPRINT_ID.test(id)) {
    fail('SCHEMA_INTEGRITY', 'block ID must be a safe lowercase slug', 'schema_integrity', `${path}/id`);
  }
  const kind = enumValue(candidate.kind, [
    'narrative', 'decision-cover', 'metric-cards', 'truth-triad', 'card-grid', 'flow',
    'strategy-matrix', 'roadmap', 'validation-gates', 'risk-register', 'visual-gallery',
    'audit-appendix',
  ], `${path}/kind`);
  if (!allowAudit && kind === 'audit-appendix') {
    fail('SCHEMA_INTEGRITY', 'Blueprint Plan cannot contain audit-appendix', 'schema_integrity', path);
  }
  budget.blocks += 1;
  switch (kind) {
    case 'narrative': {
      exactKeys(candidate, ['id', 'kind', 'paragraphs'], path);
      requiredKeys(candidate, ['paragraphs'], path);
      const paragraphs = nonEmptyArray(candidate.paragraphs, `${path}/paragraphs`)
        .map((copy, index) => parseBudgetedCopy(copy, `${path}/paragraphs/${index}`, budget));
      return { id, kind, paragraphs };
    }
    case 'decision-cover': {
      exactKeys(candidate, ['id', 'kind', 'summary', 'boundary'], path);
      requiredKeys(candidate, ['summary'], path);
      return {
        id,
        kind,
        summary: parseBudgetedCopy(candidate.summary, `${path}/summary`, budget),
        ...(candidate.boundary === undefined
          ? {}
          : { boundary: parseBudgetedCopy(candidate.boundary, `${path}/boundary`, budget) }),
      };
    }
    case 'metric-cards': {
      exactKeys(candidate, ['id', 'kind', 'items'], path);
      requiredKeys(candidate, ['items'], path);
      const items = nonEmptyArray(candidate.items, `${path}/items`).map((item, index) => {
        const itemPath = `${path}/items/${index}`;
        const parsed = record(item, itemPath);
        exactKeys(parsed, ['label', 'labelKey', 'valueUnitId'], itemPath);
        requiredKeys(parsed, ['valueUnitId'], itemPath);
        const hasLabel = parsed.label !== undefined;
        const hasLabelKey = parsed.labelKey !== undefined;
        if (hasLabel === hasLabelKey) {
          fail('SCHEMA_INTEGRITY', 'metric item requires exactly one label or labelKey', 'schema_integrity', itemPath);
        }
        const valueUnitId = stringValue(parsed.valueUnitId, `${itemPath}/valueUnitId`);
        return hasLabel
          ? { label: parseBudgetedCopy(parsed.label, `${itemPath}/label`, budget), valueUnitId }
          : {
              labelKey: enumValue(parsed.labelKey, ['target-sample-count'], `${itemPath}/labelKey`),
              valueUnitId,
            };
      });
      return { id, kind, items } as EditorialBlueprintBlock;
    }
    case 'truth-triad': {
      exactKeys(candidate, ['id', 'kind', 'factIds', 'inferenceIds', 'unknownIds'], path);
      requiredKeys(candidate, ['factIds', 'inferenceIds', 'unknownIds'], path);
      const factIds = stringArray(candidate.factIds, `${path}/factIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS });
      const inferenceIds = stringArray(candidate.inferenceIds, `${path}/inferenceIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS });
      const unknownIds = stringArray(candidate.unknownIds, `${path}/unknownIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS });
      if (factIds.length + inferenceIds.length + unknownIds.length === 0) {
        fail('SCHEMA_INTEGRITY', 'truth-triad cannot be empty', 'schema_integrity', path);
      }
      return { id, kind, factIds, inferenceIds, unknownIds };
    }
    case 'card-grid': {
      exactKeys(candidate, ['id', 'kind', 'cards'], path);
      requiredKeys(candidate, ['cards'], path);
      const cards = nonEmptyArray(candidate.cards, `${path}/cards`).map((card, index) => {
        const cardPath = `${path}/cards/${index}`;
        const parsed = record(card, cardPath);
        exactKeys(parsed, ['title', 'body'], cardPath);
        requiredKeys(parsed, ['title', 'body'], cardPath);
        return {
          title: parseBudgetedCopy(parsed.title, `${cardPath}/title`, budget),
          body: parseBudgetedCopy(parsed.body, `${cardPath}/body`, budget),
        };
      });
      return { id, kind, cards };
    }
    case 'flow': {
      exactKeys(candidate, ['id', 'kind', 'steps'], path);
      requiredKeys(candidate, ['steps'], path);
      const steps = nonEmptyArray(candidate.steps, `${path}/steps`).map((step, index) => {
        const stepPath = `${path}/steps/${index}`;
        const parsed = record(step, stepPath);
        exactKeys(parsed, ['label', 'body'], stepPath);
        requiredKeys(parsed, ['label', 'body'], stepPath);
        return {
          label: parseBudgetedCopy(parsed.label, `${stepPath}/label`, budget),
          body: parseBudgetedCopy(parsed.body, `${stepPath}/body`, budget),
        };
      });
      return { id, kind, steps };
    }
    case 'strategy-matrix': {
      exactKeys(candidate, ['id', 'kind', 'columns', 'rows'], path);
      requiredKeys(candidate, ['columns', 'rows'], path);
      const columns = nonEmptyArray(candidate.columns, `${path}/columns`, 8)
        .map((copy, index) => parseBudgetedCopy(copy, `${path}/columns/${index}`, budget));
      const rows = nonEmptyArray(candidate.rows, `${path}/rows`).map((row, index) => {
        const rowPath = `${path}/rows/${index}`;
        const parsed = record(row, rowPath);
        exactKeys(parsed, ['label', 'cells'], rowPath);
        requiredKeys(parsed, ['label', 'cells'], rowPath);
        if (!Array.isArray(parsed.cells) || parsed.cells.length !== columns.length) {
          fail('COMPONENT_RELATION', 'matrix row cell count must equal its column count', 'component_relation', `${rowPath}/cells`);
        }
        return {
          label: parseBudgetedCopy(parsed.label, `${rowPath}/label`, budget),
          cells: parsed.cells.map((copy, cellIndex) => (
            parseBudgetedCopy(copy, `${rowPath}/cells/${cellIndex}`, budget)
          )),
        };
      });
      return { id, kind, columns, rows };
    }
    case 'roadmap': {
      exactKeys(candidate, ['id', 'kind', 'lanes'], path);
      requiredKeys(candidate, ['lanes'], path);
      const lanes = nonEmptyArray(candidate.lanes, `${path}/lanes`).map((lane, index) => {
        const lanePath = `${path}/lanes/${index}`;
        const parsed = record(lane, lanePath);
        exactKeys(parsed, ['label', 'items'], lanePath);
        requiredKeys(parsed, ['label', 'items'], lanePath);
        return {
          label: parseBudgetedCopy(parsed.label, `${lanePath}/label`, budget),
          items: nonEmptyArray(parsed.items, `${lanePath}/items`).map((copy, itemIndex) => (
            parseBudgetedCopy(copy, `${lanePath}/items/${itemIndex}`, budget)
          )),
        };
      });
      return { id, kind, lanes };
    }
    case 'validation-gates': {
      exactKeys(candidate, ['id', 'kind', 'gates'], path);
      requiredKeys(candidate, ['gates'], path);
      const gates = nonEmptyArray(candidate.gates, `${path}/gates`).map((gate, index) => {
        const gatePath = `${path}/gates/${index}`;
        const parsed = record(gate, gatePath);
        exactKeys(parsed, ['label', 'method', 'successCriterion'], gatePath);
        requiredKeys(parsed, ['label', 'method'], gatePath);
        return {
          label: parseBudgetedCopy(parsed.label, `${gatePath}/label`, budget),
          method: parseBudgetedCopy(parsed.method, `${gatePath}/method`, budget),
          ...(parsed.successCriterion === undefined
            ? {}
            : { successCriterion: parseBudgetedCopy(parsed.successCriterion, `${gatePath}/successCriterion`, budget) }),
        };
      });
      return { id, kind, gates };
    }
    case 'risk-register': {
      exactKeys(candidate, ['id', 'kind', 'items'], path);
      requiredKeys(candidate, ['items'], path);
      const items = nonEmptyArray(candidate.items, `${path}/items`).map((item, index) => {
        const itemPath = `${path}/items/${index}`;
        const parsed = record(item, itemPath);
        exactKeys(parsed, ['risk', 'impact', 'response'], itemPath);
        requiredKeys(parsed, ['risk'], itemPath);
        return {
          risk: parseBudgetedCopy(parsed.risk, `${itemPath}/risk`, budget),
          ...(parsed.impact === undefined ? {} : { impact: parseBudgetedCopy(parsed.impact, `${itemPath}/impact`, budget) }),
          ...(parsed.response === undefined ? {} : { response: parseBudgetedCopy(parsed.response, `${itemPath}/response`, budget) }),
        };
      });
      return { id, kind, items };
    }
    case 'visual-gallery': {
      exactKeys(candidate, ['id', 'kind', 'assetIds'], path);
      requiredKeys(candidate, ['assetIds'], path);
      return { id, kind, assetIds: stringArray(candidate.assetIds, `${path}/assetIds`, { minimum: 1, maximum: 6 }) };
    }
    case 'audit-appendix': {
      exactKeys(candidate, ['id', 'kind', 'unitIds', 'evidenceIds'], path);
      requiredKeys(candidate, ['unitIds', 'evidenceIds'], path);
      return {
        id,
        kind,
        unitIds: stringArray(candidate.unitIds, `${path}/unitIds`, { minimum: 1, maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
        evidenceIds: stringArray(candidate.evidenceIds, `${path}/evidenceIds`, { maximum: 1_000 }),
      };
    }
  }
}

function parseSection(
  value: unknown,
  path: string,
  budget: BlueprintParseBudget,
  allowAudit: boolean,
): EditorialBlueprint['sections'][number] {
  const candidate = record(value, path);
  exactKeys(candidate, ['id', 'role', 'questionIds', 'title', 'lead', 'blocks'], path);
  requiredKeys(candidate, ['id', 'role', 'questionIds', 'blocks'], path);
  const id = stringValue(candidate.id, `${path}/id`, 64);
  if (!SAFE_BLUEPRINT_ID.test(id)) {
    fail('SCHEMA_INTEGRITY', 'section ID must be a safe lowercase slug', 'schema_integrity', `${path}/id`);
  }
  const role = enumValue(candidate.role, [
    'decision', 'positioning', 'audience', 'motivation', 'journey', 'strategy', 'opportunity',
    'roadmap', 'validation', 'risk', 'boundary', 'audit',
  ], `${path}/role`);
  if (!allowAudit && role === 'audit') {
    fail('SCHEMA_INTEGRITY', 'Blueprint Plan cannot contain an audit section', 'schema_integrity', path);
  }
  const blocks = nonEmptyArray(candidate.blocks, `${path}/blocks`, EDITORIAL_MAX_BLUEPRINT_BLOCKS)
    .map((block, index) => parseBlueprintBlock(block, `${path}/blocks/${index}`, budget, allowAudit));
  return {
    id,
    role,
    questionIds: stringArray(candidate.questionIds, `${path}/questionIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
    ...(candidate.title === undefined ? {} : { title: parseBudgetedCopy(candidate.title, `${path}/title`, budget) }),
    ...(candidate.lead === undefined ? {} : { lead: parseBudgetedCopy(candidate.lead, `${path}/lead`, budget) }),
    blocks,
  };
}

function assertUniqueBlueprintIds(sections: EditorialBlueprint['sections']): void {
  const sectionIds = new Set<string>();
  const blockIds = new Set<string>();
  for (const section of sections) {
    if (sectionIds.has(section.id)) {
      fail('SCHEMA_INTEGRITY', `duplicate section ID "${section.id}"`, 'schema_integrity');
    }
    sectionIds.add(section.id);
    for (const block of section.blocks) {
      if (blockIds.has(block.id)) {
        fail('SCHEMA_INTEGRITY', `duplicate block ID "${block.id}"`, 'schema_integrity');
      }
      blockIds.add(block.id);
    }
  }
}

function assertBlueprintBudget(budget: BlueprintParseBudget, mode: 'llm' | 'fallback'): void {
  const copyLimit = mode === 'llm' ? EDITORIAL_MAX_LLM_COPIES : EDITORIAL_MAX_FALLBACK_COPIES;
  const textLimit = mode === 'llm' ? 60_000 : 600_000;
  if (budget.blocks > EDITORIAL_MAX_BLUEPRINT_BLOCKS) {
    fail('SCHEMA_INTEGRITY', `Blueprint exceeds ${EDITORIAL_MAX_BLUEPRINT_BLOCKS} blocks`, 'schema_integrity');
  }
  if (budget.copies > copyLimit) {
    fail('SCHEMA_INTEGRITY', `Blueprint exceeds ${copyLimit} EditorialCopy values`, 'schema_integrity');
  }
  if (budget.copyCodePoints > textLimit) {
    fail('SCHEMA_INTEGRITY', `Blueprint copy exceeds ${textLimit} code points`, 'schema_integrity');
  }
}

export function parseEditorialBlueprintPlan(value: unknown): EditorialBlueprintPlan {
  const candidate = record(value, '');
  exactKeys(candidate, ['version', 'locale', 'title', 'deck', 'sections'], '');
  requiredKeys(candidate, ['version', 'locale', 'deck', 'sections'], '');
  if (candidate.version !== EDITORIAL_BLUEPRINT_PLAN_VERSION) {
    fail('SCHEMA_INTEGRITY', `version must be ${EDITORIAL_BLUEPRINT_PLAN_VERSION}`, 'schema_integrity', '/version');
  }
  if (candidate.locale !== 'zh-CN') fail('SCHEMA_INTEGRITY', 'locale must be zh-CN', 'schema_integrity', '/locale');
  if (!Array.isArray(candidate.sections) || candidate.sections.length === 0 || candidate.sections.length > EDITORIAL_MAX_BLUEPRINT_SECTIONS) {
    fail('SCHEMA_INTEGRITY', `sections must contain 1..${EDITORIAL_MAX_BLUEPRINT_SECTIONS} entries`, 'schema_integrity', '/sections');
  }
  const budget: BlueprintParseBudget = { blocks: 0, copies: 0, copyCodePoints: 0 };
  const parsed: EditorialBlueprintPlan = {
    version: EDITORIAL_BLUEPRINT_PLAN_VERSION,
    locale: 'zh-CN',
    ...(candidate.title === undefined ? {} : { title: parseBudgetedCopy(candidate.title, '/title', budget) }),
    deck: parseBudgetedCopy(candidate.deck, '/deck', budget),
    sections: candidate.sections.map((section, index) => (
      parseSection(section, `/sections/${index}`, budget, false) as EditorialBlueprintPlan['sections'][number]
    )),
  };
  assertUniqueBlueprintIds(parsed.sections);
  assertBlueprintBudget(budget, 'llm');
  return parsed;
}

export function parseEditorialBlueprint(value: unknown): EditorialBlueprint {
  const candidate = record(value, '');
  exactKeys(candidate, [
    'version', 'taskId', 'planVersionId', 'attemptId', 'requestKey', 'materialHash', 'locale',
    'title', 'deck', 'sections',
  ], '');
  requiredKeys(candidate, [
    'version', 'taskId', 'planVersionId', 'attemptId', 'requestKey', 'materialHash', 'locale',
    'deck', 'sections',
  ], '');
  if (candidate.version !== EDITORIAL_BLUEPRINT_VERSION) {
    fail('SCHEMA_INTEGRITY', `version must be ${EDITORIAL_BLUEPRINT_VERSION}`, 'schema_integrity', '/version');
  }
  if (candidate.locale !== 'zh-CN') fail('SCHEMA_INTEGRITY', 'locale must be zh-CN', 'schema_integrity', '/locale');
  if (typeof candidate.requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(candidate.requestKey)) {
    fail('SCHEMA_INTEGRITY', 'requestKey is invalid', 'schema_integrity', '/requestKey');
  }
  assertSha256(candidate.materialHash, '/materialHash');
  if (!Array.isArray(candidate.sections) || candidate.sections.length === 0 || candidate.sections.length > EDITORIAL_MAX_BLUEPRINT_SECTIONS) {
    fail('SCHEMA_INTEGRITY', `sections must contain 1..${EDITORIAL_MAX_BLUEPRINT_SECTIONS} entries`, 'schema_integrity', '/sections');
  }
  const budget: BlueprintParseBudget = { blocks: 0, copies: 0, copyCodePoints: 0 };
  const parsed: EditorialBlueprint = {
    version: EDITORIAL_BLUEPRINT_VERSION,
    taskId: stringValue(candidate.taskId, '/taskId'),
    planVersionId: stringValue(candidate.planVersionId, '/planVersionId'),
    attemptId: stringValue(candidate.attemptId, '/attemptId'),
    requestKey: candidate.requestKey,
    materialHash: candidate.materialHash,
    locale: 'zh-CN',
    ...(candidate.title === undefined ? {} : { title: parseBudgetedCopy(candidate.title, '/title', budget) }),
    deck: parseBudgetedCopy(candidate.deck, '/deck', budget),
    sections: candidate.sections.map((section, index) => parseSection(section, `/sections/${index}`, budget, true)),
  };
  assertUniqueBlueprintIds(parsed.sections);
  assertBlueprintBudget(budget, 'fallback');
  if (canonicalJsonBytes(parsed).byteLength > EDITORIAL_MAX_JSON_BYTES) {
    fail('SCHEMA_INTEGRITY', 'Blueprint canonical JSON exceeds 8 MiB', 'schema_integrity');
  }
  return parsed;
}

function blockCopies(block: EditorialBlueprintBlock): EditorialCopy[] {
  switch (block.kind) {
    case 'narrative': return block.paragraphs;
    case 'decision-cover': return [block.summary, ...(block.boundary ? [block.boundary] : [])];
    case 'metric-cards': return block.items.flatMap((item) => ('label' in item && item.label ? [item.label] : []));
    case 'truth-triad':
    case 'visual-gallery':
    case 'audit-appendix': return [];
    case 'card-grid': return block.cards.flatMap(({ title, body }) => [title, body]);
    case 'flow': return block.steps.flatMap(({ label, body }) => [label, body]);
    case 'strategy-matrix': return [
      ...block.columns,
      ...block.rows.flatMap(({ label, cells }) => [label, ...cells]),
    ];
    case 'roadmap': return block.lanes.flatMap(({ label, items }) => [label, ...items]);
    case 'validation-gates': return block.gates.flatMap(({ label, method, successCriterion }) => (
      [label, method, ...(successCriterion ? [successCriterion] : [])]
    ));
    case 'risk-register': return block.items.flatMap(({ risk, impact, response }) => (
      [risk, ...(impact ? [impact] : []), ...(response ? [response] : [])]
    ));
  }
}

function blockDirectUnitIds(block: EditorialBlueprintBlock): string[] {
  switch (block.kind) {
    case 'metric-cards': return block.items.map(({ valueUnitId }) => valueUnitId);
    case 'truth-triad': return [...block.factIds, ...block.inferenceIds, ...block.unknownIds];
    case 'audit-appendix': return block.unitIds;
    default: return [];
  }
}

function sectionUnitIds(section: EditorialBlueprint['sections'][number]): string[] {
  return [
    ...(section.title?.materialUnitIds ?? []),
    ...(section.lead?.materialUnitIds ?? []),
    ...section.blocks.flatMap((block) => [
      ...blockCopies(block).flatMap(({ materialUnitIds }) => materialUnitIds),
      ...blockDirectUnitIds(block),
    ]),
  ];
}

function canonicalIdUnion(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

function statusOf(unit: EditorialMaterialUnit): EpistemicStatus | null {
  return 'epistemicStatus' in unit && unit.epistemicStatus !== undefined ? unit.epistemicStatus : null;
}

function buildBasisAdjacency(units: EditorialMaterialUnit[]): Map<string, Set<string>> {
  const adjacency = new Map(units.map(({ id }) => [id, new Set<string>()]));
  for (const unit of units) {
    for (const basisId of unit.basisUnitIds) {
      adjacency.get(unit.id)!.add(basisId);
      adjacency.get(basisId)!.add(unit.id);
    }
  }
  return adjacency;
}

function basisConnected(left: string, right: string, adjacency: Map<string, Set<string>>): boolean {
  if (left === right) return true;
  const pending = [left];
  const visited = new Set<string>(pending);
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (next === right) return true;
      if (!visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

function unitsRelated(
  ids: readonly string[],
  byId: Map<string, EditorialMaterialUnit>,
  adjacency: Map<string, Set<string>>,
  allowQuestion = false,
): boolean {
  if (ids.length <= 1) return true;
  const first = byId.get(ids[0]!)!;
  return ids.slice(1).every((id) => {
    const other = byId.get(id)!;
    const sameGroup = first.groupId !== undefined && first.groupId === other.groupId;
    const sharedQuestion = allowQuestion && first.questionIds.some((questionId) => other.questionIds.includes(questionId));
    return sameGroup || sharedQuestion || basisConnected(first.id, other.id, adjacency);
  });
}

function validateCopy(
  copy: EditorialCopy,
  byId: Map<string, EditorialMaterialUnit>,
  evidenceIds: readonly string[],
  mode: 'llm' | 'deterministic_fallback',
  path: string,
): void {
  const units = copy.materialUnitIds.map((unitId) => {
    const unit = byId.get(unitId);
    if (!unit) fail('REFERENCE_INTEGRITY', `Copy references unknown Unit "${unitId}"`, 'reference_integrity', path);
    return unit;
  });
  if (copy.mode === 'verbatim') {
    if (units.length !== 1 || copy.text !== editorialScalarText(units[0]!.value)) {
      fail('CONTENT_FIDELITY', 'verbatim Copy must exactly equal one normalized Unit', 'content_fidelity', path);
    }
    return;
  }
  if (mode === 'deterministic_fallback') {
    fail('CONTENT_FIDELITY', 'deterministic fallback permits verbatim Copy only', 'content_fidelity', path);
  }
  if (
    hasEditorialSensitiveToken(copy.text, evidenceIds)
    || units.some((unit) => hasEditorialSensitiveToken(editorialScalarText(unit.value), evidenceIds))
  ) {
    fail('NUMERIC_INTEGRITY', 'sensitive token requires a single Unit verbatim Copy', 'numeric_integrity', path);
  }
}

function assertRelated(
  ids: readonly string[],
  byId: Map<string, EditorialMaterialUnit>,
  adjacency: Map<string, Set<string>>,
  path: string,
  allowQuestion = false,
): void {
  if (!unitsRelated(ids, byId, adjacency, allowQuestion)) {
    fail('COMPONENT_RELATION', 'component fields do not share a group, basis, or permitted question', 'component_relation', path);
  }
}

function validateBlockRelations(
  block: EditorialBlueprintBlock,
  byId: Map<string, EditorialMaterialUnit>,
  assetById: Map<string, EditorialMaterialAsset>,
  adjacency: Map<string, Set<string>>,
  compositionCandidates: EditorialCompositionCandidates,
  path: string,
): void {
  switch (block.kind) {
    case 'narrative':
      block.paragraphs.forEach((paragraph, index) => (
        assertRelated(paragraph.materialUnitIds, byId, adjacency, `${path}/paragraphs/${index}`, true)
      ));
      return;
    case 'decision-cover': {
      if (!block.summary.materialUnitIds.some((id) => {
        const unit = byId.get(id)!;
        return unit.requiredInBody && (unit.role === 'claim' || unit.role === 'recommendation' || unit.role === 'risk');
      })) {
        fail('COMPONENT_RELATION', 'decision-cover summary requires a body-required claim, recommendation, or risk', 'component_relation', path);
      }
      if (block.boundary && block.boundary.materialUnitIds.some((id) => !['context', 'risk', 'validation'].includes(byId.get(id)!.role))) {
        fail('COMPONENT_RELATION', 'decision boundary references an unsupported Unit role', 'component_relation', `${path}/boundary`);
      }
      return;
    }
    case 'metric-cards':
      block.items.forEach((item, index) => {
        const value = byId.get(item.valueUnitId);
        if (!value || typeof value.value !== 'number' || !value.metricEligible) {
          fail('NUMERIC_INTEGRITY', 'metric card value must reference an eligible numeric Unit', 'numeric_integrity', `${path}/items/${index}`);
        }
        if ('labelKey' in item) {
          if (value.sourceRefs[0].jsonPointer !== '/payload/competitorSampling/targetCount') {
            fail('COMPONENT_RELATION', 'target-sample-count must reference its exact payload Pointer', 'component_relation', `${path}/items/${index}`);
          }
        } else {
          assertRelated([...item.label.materialUnitIds, item.valueUnitId], byId, adjacency, `${path}/items/${index}`);
        }
      });
      return;
    case 'truth-triad': {
      const seen = new Set<string>();
      for (const [status, ids] of [
        ['fact', block.factIds],
        ['inference', block.inferenceIds],
        ['unknown', block.unknownIds],
      ] as const) {
        for (const id of ids) {
          const unit = byId.get(id);
          if (!unit) fail('REFERENCE_INTEGRITY', `truth-triad references unknown Unit "${id}"`, 'reference_integrity', path);
          if (seen.has(id)) fail('EPISTEMIC_INTEGRITY', 'truth-triad columns must be disjoint', 'epistemic_integrity', path);
          seen.add(id);
          if (statusOf(unit) !== status) {
            fail('EPISTEMIC_INTEGRITY', `Unit "${id}" is in the wrong epistemic status column`, 'epistemic_integrity', path);
          }
        }
      }
      return;
    }
    case 'card-grid':
      block.cards.forEach(({ title, body }, index) => (
        assertRelated([...title.materialUnitIds, ...body.materialUnitIds], byId, adjacency, `${path}/cards/${index}`)
      ));
      return;
    case 'flow': {
      const expected = compositionCandidates.flow;
      if (
        expected === undefined
        || block.steps.length !== expected.steps.length
        || block.steps.some((step, index) => {
          const expectedStep = expected.steps[index]!;
          return (
            !step.label.materialUnitIds.includes(expectedStep.label.materialUnitIds[0]!)
            || !step.body.materialUnitIds.includes(expectedStep.body.materialUnitIds[0]!)
          );
        })
      ) {
        fail('COMPONENT_RELATION', 'flow steps must exactly map the source sequence', 'component_relation', `${path}/steps`);
      }
      block.steps.forEach(({ label, body }, index) => (
        assertRelated([...label.materialUnitIds, ...body.materialUnitIds], byId, adjacency, `${path}/steps/${index}`)
      ));
      return;
    }
    case 'strategy-matrix': {
      const columns = block.columns.map((column, columnIndex) => {
        const id = column.materialUnitIds.length === 1 ? column.materialUnitIds[0] : undefined;
        const unit = id === undefined ? undefined : byId.get(id);
        if (!unit || !/^\/payload\/competitorSamples\/\d+\/name$/u.test(unitPointer(unit))) {
          fail('COMPONENT_RELATION', 'matrix column must reference exactly one competitor sample name Unit', 'component_relation', `${path}/columns/${columnIndex}`);
        }
        return unit;
      });
      const expectedColumnIds = [...byId.values()]
        .filter((unit) => /^\/payload\/competitorSamples\/\d+\/name$/u.test(unitPointer(unit)))
        .map(({ id }) => id);
      if (
        columns.length !== expectedColumnIds.length
        || columns.some(({ id }, index) => id !== expectedColumnIds[index])
      ) {
        fail('COMPONENT_RELATION', 'matrix columns must exactly cover competitor sample name Units in source order', 'component_relation', `${path}/columns`);
      }
      const rows = block.rows.map((row, rowIndex) => {
        const rowId = row.label.materialUnitIds.length === 1 ? row.label.materialUnitIds[0] : undefined;
        const rowUnit = rowId === undefined ? undefined : byId.get(rowId);
        if (!rowUnit || !/^\/payload\/dimensionMatrix\/\d+\/dimension$/u.test(unitPointer(rowUnit))) {
          fail('COMPONENT_RELATION', 'matrix row must reference exactly one dimension Unit', 'component_relation', `${path}/rows/${rowIndex}/label`);
        }
        row.cells.forEach((cell, columnIndex) => {
          const columnUnit = columns[columnIndex]!;
          const cellUnits = cell.materialUnitIds.map((id) => byId.get(id)!);
          if (
            cellUnits.length === 0
            || cellUnits.some((unit) => (
              !unit.basisUnitIds.includes(rowUnit.id)
              || !unit.basisUnitIds.includes(columnUnit.id)
            ))
          ) {
            fail('COMPONENT_RELATION', 'matrix cell must directly bind its row and column Units', 'component_relation', `${path}/rows/${rowIndex}/cells/${columnIndex}`);
          }
          assertRelated([
            rowUnit.id,
            columnUnit.id,
            ...cell.materialUnitIds,
          ], byId, adjacency, `${path}/rows/${rowIndex}/cells/${columnIndex}`);
        });
        return rowUnit;
      });
      const expectedRowIds = [...byId.values()]
        .filter((unit) => /^\/payload\/dimensionMatrix\/\d+\/dimension$/u.test(unitPointer(unit)))
        .map(({ id }) => id);
      if (
        rows.length !== expectedRowIds.length
        || rows.some(({ id }, index) => id !== expectedRowIds[index])
      ) {
        fail('COMPONENT_RELATION', 'matrix rows must exactly cover dimension Units in source order', 'component_relation', `${path}/rows`);
      }
      return;
    }
    case 'roadmap': {
      const expected = compositionCandidates.roadmap;
      const usedLaneLabels = new Set<string>();
      if (expected === undefined) {
        fail('COMPONENT_RELATION', 'roadmap lanes must use source-backed label and item semantics', 'component_relation', `${path}/lanes`);
      }
      block.lanes.forEach((lane, laneIndex) => {
        const matchingLanes = expected.lanes.filter(({ label }) => (
          lane.label.materialUnitIds.includes(label.materialUnitIds[0]!)
        ));
        if (matchingLanes.length !== 1) {
          fail('COMPONENT_RELATION', 'roadmap lanes must use source-backed label and item semantics', 'component_relation', `${path}/lanes/${laneIndex}/label`);
        }
        const labelId = matchingLanes[0]!.label.materialUnitIds[0]!;
        if (usedLaneLabels.has(labelId)) {
          fail('COMPONENT_RELATION', 'roadmap lanes must use source-backed label and item semantics', 'component_relation', `${path}/lanes/${laneIndex}/label`);
        }
        usedLaneLabels.add(labelId);
        const expectedItems = matchingLanes[0]!.items.map(({ materialUnitIds }) => materialUnitIds[0]!);
        const usedItems = new Set<string>();
        lane.items.forEach((item, itemIndex) => {
          const matchingItems = expectedItems.filter((id) => item.materialUnitIds.includes(id));
          if (matchingItems.length !== 1 || usedItems.has(matchingItems[0]!)) {
            fail('COMPONENT_RELATION', 'roadmap lanes must use source-backed label and item semantics', 'component_relation', `${path}/lanes/${laneIndex}/items/${itemIndex}`);
          }
          usedItems.add(matchingItems[0]!);
          assertRelated(
            [...lane.label.materialUnitIds, ...item.materialUnitIds],
            byId,
            adjacency,
            `${path}/lanes/${laneIndex}/items/${itemIndex}`,
          );
        });
      });
      return;
    }
    case 'validation-gates':
      block.gates.forEach((gate, index) => (
        assertRelated([
          ...gate.label.materialUnitIds,
          ...gate.method.materialUnitIds,
          ...(gate.successCriterion?.materialUnitIds ?? []),
        ], byId, adjacency, `${path}/gates/${index}`)
      ));
      return;
    case 'risk-register':
      block.items.forEach((item, index) => {
        if (item.impact !== undefined || item.response !== undefined) {
          fail(
            'COMPONENT_RELATION',
            'V1 risk register does not support impact or response fields',
            'component_relation',
            `${path}/items/${index}`,
          );
        }
        if (item.risk.materialUnitIds.some((id) => byId.get(id)!.role !== 'risk')) {
          fail('EPISTEMIC_INTEGRITY', 'risk field must reference risk Units', 'epistemic_integrity', `${path}/items/${index}/risk`);
        }
        assertRelated(item.risk.materialUnitIds, byId, adjacency, `${path}/items/${index}`);
      });
      return;
    case 'visual-gallery': {
      const assets = block.assetIds.map((id) => {
        const asset = assetById.get(id);
        if (!asset) fail('REFERENCE_INTEGRITY', `gallery references unknown Asset "${id}"`, 'reference_integrity', path);
        return asset;
      });
      for (let index = 0; index < assets.length; index += 1) {
        const asset = assets[index]!;
        if (asset.visualRole === 'comparison-before') {
          const after = assets[index + 1];
          if (!after || after.visualRole !== 'comparison-after' || after.comparisonGroupId !== asset.comparisonGroupId) {
            fail('COMPONENT_RELATION', 'comparison Assets must remain adjacent in before/after order', 'component_relation', path);
          }
          index += 1;
        } else if (asset.visualRole === 'comparison-after') {
          fail('COMPONENT_RELATION', 'comparison-after cannot appear without its preceding before Asset', 'component_relation', path);
        }
      }
      return;
    }
    case 'audit-appendix': return;
  }
}

export function validateEditorialBlueprint(input: {
  blueprint: EditorialBlueprint;
  material: EditorialMaterial;
  mode: 'llm' | 'deterministic_fallback';
}): EditorialBlueprint {
  const material = parseEditorialMaterial(input.material);
  const blueprint = parseEditorialBlueprint(input.blueprint);
  if (
    blueprint.taskId !== material.taskId
    || blueprint.planVersionId !== material.planVersionId
    || blueprint.attemptId !== material.attemptId
  ) {
    fail('REFERENCE_INTEGRITY', 'Blueprint binding does not match Material', 'reference_integrity');
  }
  if (blueprint.materialHash !== canonicalSha256(material)) {
    fail('REFERENCE_INTEGRITY', 'Blueprint materialHash is invalid', 'reference_integrity', '/materialHash');
  }
  const byId = new Map(material.units.map((unit) => [unit.id, unit]));
  const assetById = new Map(material.assets.map((asset) => [asset.id, asset]));
  const evidenceIds = material.evidence.map(({ id }) => id);
  const adjacency = buildBasisAdjacency(material.units);
  const eligibleCompositionKinds = new Set(computeEligibleCompositionKinds(material));
  const compositionCandidates = deriveCompositionCandidates(material);
  for (const block of blueprint.sections.flatMap(({ blocks }) => blocks)) {
    if (
      COMPOSITION_KINDS.has(block.kind)
      && !eligibleCompositionKinds.has(block.kind as EditorialCompositionKind)
    ) {
      fail(
        'COMPOSITION_QUALITY',
        `Blueprint uses ineligible composition kind "${block.kind}"`,
        'composition_quality',
      );
    }
  }
  const allCopies: Array<{ copy: EditorialCopy; path: string }> = [
    ...(blueprint.title ? [{ copy: blueprint.title, path: '/title' }] : []),
    { copy: blueprint.deck, path: '/deck' },
  ];
  blueprint.sections.forEach((section, sectionIndex) => {
    if (section.title) allCopies.push({ copy: section.title, path: `/sections/${sectionIndex}/title` });
    if (section.lead) allCopies.push({ copy: section.lead, path: `/sections/${sectionIndex}/lead` });
    section.blocks.forEach((block, blockIndex) => {
      blockCopies(block).forEach((copy, copyIndex) => allCopies.push({
        copy,
        path: `/sections/${sectionIndex}/blocks/${blockIndex}/copy/${copyIndex}`,
      }));
    });
  });
  allCopies.forEach(({ copy, path }) => validateCopy(copy, byId, evidenceIds, input.mode, path));
  const budget = {
    blocks: blueprint.sections.reduce((count, section) => count + section.blocks.length, 0),
    copies: allCopies.length,
    copyCodePoints: allCopies.reduce((count, { copy }) => count + Array.from(copy.text).length, 0),
  };
  assertBlueprintBudget(budget, input.mode === 'llm' ? 'llm' : 'fallback');
  if (material.titleUnitId !== undefined) {
    if (!blueprint.title || !blueprint.title.materialUnitIds.includes(material.titleUnitId)) {
      fail('CONTENT_COVERAGE', 'Blueprint title must cover titleUnitId', 'content_coverage', '/title');
    }
  } else if (blueprint.title !== undefined) {
    fail('CONTENT_COVERAGE', 'Blueprint title must be omitted without titleUnitId', 'content_coverage', '/title');
  }
  const coverLocations = blueprint.sections.flatMap((section, sectionIndex) => section.blocks.flatMap((block, blockIndex) => (
    block.kind === 'decision-cover' ? [{ sectionIndex, blockIndex, block }] : []
  )));
  if (
    coverLocations.length !== 1
    || coverLocations[0]!.sectionIndex !== blueprint.sections.findIndex(({ role }) => role !== 'audit')
    || coverLocations[0]!.blockIndex !== 0
  ) {
    fail('CONTENT_COVERAGE', 'Blueprint must place exactly one decision-cover first', 'content_coverage');
  }
  const auditSections = blueprint.sections.filter(({ role }) => role === 'audit');
  const appendices = blueprint.sections.flatMap(({ blocks }) => blocks.filter(({ kind }) => kind === 'audit-appendix'));
  if (
    auditSections.length !== 1
    || blueprint.sections.at(-1) !== auditSections[0]
    || auditSections[0]!.blocks.length !== 1
    || appendices.length !== 1
    || auditSections[0]!.blocks[0] !== appendices[0]
  ) {
    fail('CONTENT_COVERAGE', 'Blueprint requires one final audit section containing one audit-appendix', 'content_coverage');
  }
  const appendix = appendices[0]!;
  if (appendix.kind !== 'audit-appendix') throw new Error('unreachable');
  const requiredUnitIds = material.units.filter(({ requiredInOutput }) => requiredInOutput).map(({ id }) => id);
  const requiredEvidence = new Set(
    material.units.filter(({ requiredInOutput }) => requiredInOutput).flatMap(({ evidenceIds: ids }) => ids),
  );
  const expectedEvidenceIds = material.evidence.filter(({ id }) => requiredEvidence.has(id)).map(({ id }) => id);
  if (
    canonicalEditorialJson(appendix.unitIds) !== canonicalEditorialJson(requiredUnitIds)
    || canonicalEditorialJson(appendix.evidenceIds) !== canonicalEditorialJson(expectedEvidenceIds)
  ) {
    fail('CONTENT_COVERAGE', 'audit appendix does not equal the requiredInOutput canonical closure', 'content_coverage');
  }
  const bodyIds = new Set<string>([
    ...(blueprint.title?.materialUnitIds ?? []),
    ...blueprint.deck.materialUnitIds,
    ...blueprint.sections.filter(({ role }) => role !== 'audit').flatMap(sectionUnitIds),
  ]);
  const missingBody = material.units.filter(({ id, requiredInBody }) => requiredInBody && !bodyIds.has(id));
  if (missingBody.length > 0) {
    fail('CONTENT_COVERAGE', `requiredInBody Units are missing: ${missingBody.map(({ id }) => id).join(', ')}`, 'content_coverage');
  }
  const requiredQuestionIds = canonicalIdUnion(
    material.units.filter(({ requiredInBody }) => requiredInBody).flatMap(({ questionIds }) => questionIds),
  );
  for (const questionId of requiredQuestionIds) {
    if (!material.units.some((unit) => (
      bodyIds.has(unit.id)
      && unit.requiredInBody
      && unit.questionIds.includes(questionId)
      && (unit.role === 'claim' || unit.role === 'risk')
    ))) {
      fail('CONTENT_COVERAGE', `required question "${questionId}" has no body claim/risk anchor`, 'content_coverage');
    }
  }
  for (const [sectionIndex, section] of blueprint.sections.entries()) {
    const referenced = sectionUnitIds(section);
    for (const id of referenced) {
      if (!byId.has(id)) fail('REFERENCE_INTEGRITY', `section references unknown Unit "${id}"`, 'reference_integrity');
    }
    const expectedQuestions = canonicalIdUnion(referenced.flatMap((id) => byId.get(id)!.questionIds));
    if (canonicalEditorialJson(section.questionIds) !== canonicalEditorialJson(expectedQuestions)) {
      fail('CONTENT_COVERAGE', 'section questionIds do not equal its referenced Unit closure', 'content_coverage', `/sections/${sectionIndex}/questionIds`);
    }
    section.blocks.forEach((block, blockIndex) => {
      for (const id of blockDirectUnitIds(block)) {
        if (!byId.has(id)) fail('REFERENCE_INTEGRITY', `block references unknown Unit "${id}"`, 'reference_integrity');
      }
      validateBlockRelations(
        block,
        byId,
        assetById,
        adjacency,
        compositionCandidates,
        `/sections/${sectionIndex}/blocks/${blockIndex}`,
      );
    });
  }
  const requiredRisks = material.units.filter(({ role, requiredInBody }) => role === 'risk' && requiredInBody);
  if (requiredRisks.length > 0) {
    const riskSections = blueprint.sections.filter(({ role }) => role === 'risk');
    const riskBlocks = riskSections.flatMap(({ blocks }) => blocks.filter(({ kind }) => kind === 'risk-register'));
    const coveredRiskIds = new Set(riskBlocks.flatMap((block) => (
      block.kind === 'risk-register' ? block.items.flatMap(({ risk }) => risk.materialUnitIds) : []
    )));
    if (riskSections.length === 0 || riskBlocks.length === 0 || requiredRisks.some(({ id }) => !coveredRiskIds.has(id))) {
      fail('CONTENT_COVERAGE', 'required risk Units require an independent risk section and risk-register', 'content_coverage');
    }
  }
  return blueprint;
}

export function assertValidEditorialBlueprint(input: {
  blueprint: unknown;
  material: EditorialMaterial;
  mode: 'llm' | 'deterministic_fallback';
}): asserts input is { blueprint: EditorialBlueprint; material: EditorialMaterial; mode: 'llm' | 'deterministic_fallback' } {
  validateEditorialBlueprint({
    blueprint: parseEditorialBlueprint(input.blueprint),
    material: input.material,
    mode: input.mode,
  });
}

function verbatimCopy(unit: EditorialMaterialUnit): EditorialCopy {
  return { text: editorialScalarText(unit.value), mode: 'verbatim', materialUnitIds: [unit.id] };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function questionIdsForBlocks(
  blocks: EditorialBlueprintBlock[],
  byId: Map<string, EditorialMaterialUnit>,
): string[] {
  return canonicalIdUnion(blocks.flatMap((block) => [
    ...blockCopies(block).flatMap(({ materialUnitIds }) => materialUnitIds),
    ...blockDirectUnitIds(block),
  ]).flatMap((id) => byId.get(id)?.questionIds ?? []));
}

export function buildDeterministicEditorialBlueprint(input: {
  material: EditorialMaterial;
  requestKey: string;
}): EditorialBlueprint {
  const material = parseEditorialMaterial(input.material);
  if (!REQUEST_KEY_PATTERN.test(input.requestKey)) {
    fail('SCHEMA_INTEGRITY', 'requestKey is invalid', 'schema_integrity', '/requestKey');
  }
  const byId = new Map(material.units.map((unit) => [unit.id, unit]));
  const decisionAnchor = material.units.find((unit) => (
    unit.requiredInBody && (unit.role === 'claim' || unit.role === 'recommendation' || unit.role === 'risk')
  ));
  if (!decisionAnchor) {
    fail('SOURCE_NOT_RENDERABLE', 'Material has no body-required decision anchor', 'content_coverage');
  }
  const composition = deriveCompositionCandidates(material);
  const sections: EditorialBlueprint['sections'] = [];
  const decisionBlocks: EditorialBlueprintBlock[] = [{
    id: 'decision-cover',
    kind: 'decision-cover',
    summary: verbatimCopy(decisionAnchor),
  }];
  if (composition['metric-cards']) decisionBlocks.push(composition['metric-cards']);
  if (composition['truth-triad']) decisionBlocks.push(composition['truth-triad']);
  sections.push({
    id: 'decision',
    role: 'decision',
    questionIds: questionIdsForBlocks(decisionBlocks, byId),
    blocks: decisionBlocks,
  });

  const bodyRisks = material.units.filter((unit) => unit.role === 'risk' && unit.requiredInBody);
  const riskBlocks: EditorialBlueprintBlock[] = chunks(bodyRisks, 24).map((group, index) => ({
    id: `risk-register-${index + 1}`,
    kind: 'risk-register',
    items: group.map((risk) => ({ risk: verbatimCopy(risk) })),
  }));
  const compositionBlocks = Object.values(composition).filter(
    (block): block is EditorialBlueprintBlock => block !== undefined,
  );
  const alreadyCovered = new Set([
    material.methodSummaryUnitId,
    ...(material.titleUnitId === undefined ? [] : [material.titleUnitId]),
    ...[...decisionBlocks, ...compositionBlocks, ...riskBlocks].flatMap((block) => [
      ...blockCopies(block).flatMap(({ materialUnitIds }) => materialUnitIds),
      ...blockDirectUnitIds(block),
    ]),
  ]);
  const bodyContextUnits = material.units.filter((unit) => (
    unit.requiredInBody && !alreadyCovered.has(unit.id)
  ));
  if (bodyContextUnits.length > 0) {
    const blocks: EditorialBlueprintBlock[] = chunks(bodyContextUnits, 24).map((group, index) => ({
      id: `context-${index + 1}`,
      kind: 'narrative',
      paragraphs: group.map(verbatimCopy),
    }));
    sections.push({
      id: 'context',
      role: 'positioning',
      questionIds: questionIdsForBlocks(blocks, byId),
      blocks,
    });
  }

  const appendCompositionSection = (
    id: string,
    role: Exclude<EditorialSectionRole, 'audit'>,
    block: EditorialBlueprintBlock | undefined,
  ): void => {
    if (!block) return;
    sections.push({
      id,
      role,
      questionIds: questionIdsForBlocks([block], byId),
      blocks: [block],
    });
  };
  appendCompositionSection('cards', 'positioning', composition['card-grid']);
  appendCompositionSection('flow', 'journey', composition.flow);
  appendCompositionSection('matrix', 'strategy', composition['strategy-matrix']);
  appendCompositionSection('roadmap', 'roadmap', composition.roadmap);
  appendCompositionSection('validation', 'validation', composition['validation-gates']);

  if (bodyRisks.length > 0) {
    sections.push({
      id: 'risk',
      role: 'risk',
      questionIds: questionIdsForBlocks(riskBlocks, byId),
      blocks: riskBlocks,
    });
  }

  if (composition['visual-gallery']) {
    const blocks: EditorialBlueprintBlock[] = [composition['visual-gallery']];
    sections.push({
      id: 'visual-evidence',
      role: 'opportunity',
      questionIds: questionIdsForBlocks(blocks, byId),
      blocks,
    });
  }

  const requiredUnits = material.units.filter(({ requiredInOutput }) => requiredInOutput);
  const requiredEvidence = new Set(requiredUnits.flatMap(({ evidenceIds }) => evidenceIds));
  const auditBlock: EditorialBlueprintBlock = {
    id: 'audit-appendix',
    kind: 'audit-appendix',
    unitIds: requiredUnits.map(({ id }) => id),
    evidenceIds: material.evidence.filter(({ id }) => requiredEvidence.has(id)).map(({ id }) => id),
  };
  sections.push({
    id: 'audit',
    role: 'audit',
    questionIds: questionIdsForBlocks([auditBlock], byId),
    blocks: [auditBlock],
  });
  const blueprint: EditorialBlueprint = {
    version: EDITORIAL_BLUEPRINT_VERSION,
    taskId: material.taskId,
    planVersionId: material.planVersionId,
    attemptId: material.attemptId,
    requestKey: input.requestKey,
    materialHash: canonicalSha256(material),
    locale: 'zh-CN',
    ...(material.titleUnitId === undefined ? {} : { title: verbatimCopy(byId.get(material.titleUnitId)!) }),
    deck: verbatimCopy(byId.get(material.methodSummaryUnitId)!),
    sections,
  };
  if (sections.reduce((count, section) => count + section.blocks.length, 0) > EDITORIAL_MAX_BLUEPRINT_BLOCKS) {
    fail('SOURCE_NOT_RENDERABLE', 'deterministic Blueprint cannot fit within 48 blocks', 'composition_quality');
  }
  return validateEditorialBlueprint({ blueprint, material, mode: 'deterministic_fallback' });
}

const BLOCK_KIND_ORDER: readonly EditorialBlockKind[] = [
  'narrative',
  'decision-cover',
  'metric-cards',
  'truth-triad',
  'card-grid',
  'flow',
  'strategy-matrix',
  'roadmap',
  'validation-gates',
  'risk-register',
  'visual-gallery',
  'audit-appendix',
];
const COMPOSITION_KIND_ORDER: readonly EditorialCompositionKind[] = [
  'metric-cards',
  'truth-triad',
  'card-grid',
  'flow',
  'strategy-matrix',
  'roadmap',
  'validation-gates',
  'visual-gallery',
];
const COMPOSITION_KINDS = new Set<EditorialBlockKind>(COMPOSITION_KIND_ORDER);

type CompositionBlock<K extends EditorialCompositionKind> = Extract<EditorialBlueprintBlock, { kind: K }>;

interface EditorialCompositionCandidates {
  'metric-cards'?: CompositionBlock<'metric-cards'>;
  'truth-triad'?: CompositionBlock<'truth-triad'>;
  'card-grid'?: CompositionBlock<'card-grid'>;
  flow?: CompositionBlock<'flow'>;
  'strategy-matrix'?: CompositionBlock<'strategy-matrix'>;
  roadmap?: CompositionBlock<'roadmap'>;
  'validation-gates'?: CompositionBlock<'validation-gates'>;
  'visual-gallery'?: CompositionBlock<'visual-gallery'>;
}

function unitPointer(unit: EditorialMaterialUnit): string {
  return unit.sourceRefs[0].jsonPointer;
}

function unitsByGroup(material: EditorialMaterial): Map<string, EditorialMaterialUnit[]> {
  const groups = new Map<string, EditorialMaterialUnit[]>();
  for (const unit of material.units) {
    if (unit.groupId === undefined) continue;
    const group = groups.get(unit.groupId) ?? [];
    group.push(unit);
    groups.set(unit.groupId, group);
  }
  return groups;
}

function findMetricLabel(
  metric: EditorialMaterialUnit,
  material: EditorialMaterial,
  byId: ReadonlyMap<string, EditorialMaterialUnit>,
): EditorialMaterialUnit | null {
  const pointer = unitPointer(metric);
  const siblingPointer = pointer.endsWith('/score')
    ? `${pointer.slice(0, -'/score'.length)}/${pointer.includes('/sentiments/') ? 'label' : 'value'}`
    : pointer.endsWith('/recordCount')
      ? `${pointer.slice(0, -'/recordCount'.length)}/name`
      : null;
  if (siblingPointer !== null) {
    const sibling = material.units.find((unit) => unitPointer(unit) === siblingPointer);
    if (sibling) return sibling;
  }
  const directBasis = metric.basisUnitIds
    .map((id) => byId.get(id))
    .find((unit): unit is EditorialMaterialUnit => unit !== undefined && typeof unit.value === 'string');
  if (directBasis) return directBasis;
  return material.units.find((unit) => (
    unit.id !== metric.id
    && unit.groupId !== undefined
    && unit.groupId === metric.groupId
    && typeof unit.value === 'string'
  )) ?? null;
}

function isProjectorMetricUnit(
  deliverableType: EditorialDeliverableType,
  unit: EditorialMaterialUnit,
): boolean {
  const pointer = unitPointer(unit);
  switch (deliverableType) {
    case 'research_plan':
      return pointer === '/payload/competitorSampling/targetCount' && unit.unit === '个';
    case 'competitive_analysis_report':
      return /^\/payload\/dimensionMatrix\/\d+\/values\/\d+\/score$/u.test(pointer) && unit.unit === '/5';
    case 'voc_diagnosis_report':
      return (
        (/^\/payload\/datasets\/\d+\/recordCount$/u.test(pointer) && unit.unit === '条')
        || (/^\/payload\/frequencies\/\d+\/count$/u.test(pointer) && unit.unit === '条')
        || (/^\/payload\/frequencies\/\d+\/share$/u.test(pointer) && unit.unit === 'ratio')
        || (/^\/payload\/sentiments\/\d+\/score$/u.test(pointer) && unit.unit === undefined)
      );
    case 'research_strategy_report':
    case 'design_audit_report':
    case 'accessibility_audit_report':
    case 'industry_market_analysis_report':
      return false;
  }
}

function metricCardsCandidate(
  material: EditorialMaterial,
  byId: ReadonlyMap<string, EditorialMaterialUnit>,
): CompositionBlock<'metric-cards'> | undefined {
  const items: CompositionBlock<'metric-cards'>['items'] = [];
  for (const metric of material.units) {
    const pointer = unitPointer(metric);
    if (
      !metric.metricEligible
      || typeof metric.value !== 'number'
      || !isProjectorMetricUnit(material.deliverableType, metric)
    ) continue;
    if (pointer === '/payload/competitorSampling/targetCount') {
      items.push({ labelKey: 'target-sample-count', valueUnitId: metric.id });
    } else {
      const label = findMetricLabel(metric, material, byId);
      if (label === null) continue;
      items.push({ label: verbatimCopy(label), valueUnitId: metric.id });
    }
    if (items.length === 24) break;
  }
  return items.length === 0 ? undefined : { id: 'metric-cards', kind: 'metric-cards', items };
}

function truthTriadCandidate(material: EditorialMaterial): CompositionBlock<'truth-triad'> | undefined {
  const statuses = new Set(material.units.map(statusOf).filter((status) => status !== null));
  if (statuses.size < 2) return undefined;
  return {
    id: 'truth-triad',
    kind: 'truth-triad',
    factIds: material.units.filter((unit) => statusOf(unit) === 'fact').map(({ id }) => id),
    inferenceIds: material.units.filter((unit) => statusOf(unit) === 'inference').map(({ id }) => id),
    unknownIds: material.units.filter((unit) => statusOf(unit) === 'unknown').map(({ id }) => id),
  };
}

function cardGridCandidate(
  material: EditorialMaterial,
  groups: ReadonlyMap<string, EditorialMaterialUnit[]>,
): CompositionBlock<'card-grid'> | undefined {
  const stableGroup = /^(?:research-plan|research-scope|research-sampling|research-dimension:.+|research-source:\d+|collection-field:\d+|competitive-sample:.+|competitive-difference:.+|voc-dataset:.+|voc-theme:.+|design-page:.+|design-issue:.+|a11y-platform:\d+|a11y-issue:.+)$/u;
  const eligibleGroups = [...groups]
    .filter(([groupId, units]) => stableGroup.test(groupId) && units.length >= 2)
    .map(([, units]) => units);
  if (eligibleGroups.length < 2) return undefined;
  return {
    id: 'card-grid',
    kind: 'card-grid',
    cards: eligibleGroups.slice(0, 24).map((units) => ({
      title: verbatimCopy(units[0]!),
      body: verbatimCopy(units[1]!),
    })),
  };
}

function flowCandidate(
  material: EditorialMaterial,
  groups: ReadonlyMap<string, EditorialMaterialUnit[]>,
): CompositionBlock<'flow'> | undefined {
  const steps: CompositionBlock<'flow'>['steps'] = [];
  if (material.deliverableType === 'research_plan') {
    for (const [groupId, units] of groups) {
      if (!/^research-phase:\d+$/u.test(groupId)) continue;
      const label = units.find((unit) => /^\/payload\/executionPlan\/\d+\/phase$/u.test(unitPointer(unit)));
      const body = units.find((unit) => /^\/payload\/executionPlan\/\d+\/activities\/\d+$/u.test(unitPointer(unit)));
      if (label && body) steps.push({ label: verbatimCopy(label), body: verbatimCopy(body) });
      if (steps.length === 24) break;
    }
  } else if (material.deliverableType === 'competitive_analysis_report') {
    for (const unit of material.units) {
      if (!/^\/payload\/userTestScript\/\d+$/u.test(unitPointer(unit))) continue;
      steps.push({ label: verbatimCopy(unit), body: verbatimCopy(unit) });
      if (steps.length === 24) break;
    }
  } else if (material.deliverableType === 'accessibility_audit_report') {
    for (const [groupId, units] of groups) {
      if (!groupId.startsWith('a11y-issue:')) continue;
      const label = units.find((unit) => /^\/payload\/screenReaderBehavior\/\d+\/observed$/u.test(unitPointer(unit)));
      const body = units.find((unit) => /^\/payload\/screenReaderBehavior\/\d+\/expected$/u.test(unitPointer(unit)));
      if (label && body) steps.push({ label: verbatimCopy(label), body: verbatimCopy(body) });
      if (steps.length === 24) break;
    }
  }
  return steps.length === 0 ? undefined : { id: 'flow', kind: 'flow', steps };
}

function strategyMatrixCandidate(
  material: EditorialMaterial,
): CompositionBlock<'strategy-matrix'> | undefined {
  if (material.deliverableType !== 'competitive_analysis_report') return undefined;
  const columns = material.units.filter((unit) => /^\/payload\/competitorSamples\/\d+\/name$/u.test(unitPointer(unit)));
  const rowLabels = material.units.filter((unit) => /^\/payload\/dimensionMatrix\/\d+\/dimension$/u.test(unitPointer(unit)));
  const cellUnits = material.units.filter((unit) => /^\/payload\/dimensionMatrix\/\d+\/values\/\d+\/value$/u.test(unitPointer(unit)));
  if (columns.length === 0 || columns.length > 8 || rowLabels.length === 0 || rowLabels.length > 24) return undefined;
  const usedCells = new Set<string>();
  const rows: CompositionBlock<'strategy-matrix'>['rows'] = [];
  for (const rowLabel of rowLabels) {
    const rowIndex = /^\/payload\/dimensionMatrix\/(\d+)\/dimension$/u.exec(unitPointer(rowLabel))?.[1];
    if (rowIndex === undefined) return undefined;
    const cells: EditorialCopy[] = [];
    for (const column of columns) {
      const matches = cellUnits.filter((unit) => (
        unitPointer(unit).startsWith(`/payload/dimensionMatrix/${rowIndex}/values/`)
        && unit.basisUnitIds.includes(rowLabel.id)
        && unit.basisUnitIds.includes(column.id)
      ));
      if (matches.length !== 1) return undefined;
      usedCells.add(matches[0]!.id);
      cells.push(verbatimCopy(matches[0]!));
    }
    rows.push({ label: verbatimCopy(rowLabel), cells });
  }
  if (usedCells.size !== cellUnits.length) return undefined;
  return {
    id: 'strategy-matrix',
    kind: 'strategy-matrix',
    columns: columns.map(verbatimCopy),
    rows,
  };
}

function roadmapCandidate(
  material: EditorialMaterial,
  groups: ReadonlyMap<string, EditorialMaterialUnit[]>,
): CompositionBlock<'roadmap'> | undefined {
  const lanes: CompositionBlock<'roadmap'>['lanes'] = [];
  for (const [groupId, units] of groups) {
    let label: EditorialMaterialUnit | undefined;
    let items: EditorialMaterialUnit[] = [];
    if (material.deliverableType === 'research_plan' && /^research-phase:\d+$/u.test(groupId)) {
      label = units.find((unit) => /^\/payload\/executionPlan\/\d+\/phase$/u.test(unitPointer(unit)));
      items = units.filter((unit) => /^\/payload\/executionPlan\/\d+\/activities\/\d+$/u.test(unitPointer(unit)));
    } else if (material.deliverableType === 'competitive_analysis_report' && /^competitive-roadmap:\d+$/u.test(groupId)) {
      label = units.find((unit) => /^\/payload\/roadmap\/\d+\/priority$/u.test(unitPointer(unit)));
      items = units.filter((unit) => /^\/payload\/roadmap\/\d+\/statement$/u.test(unitPointer(unit)));
    } else if (material.deliverableType === 'voc_diagnosis_report' && groupId.startsWith('voc-theme:')) {
      label = units.find((unit) => /^\/payload\/priorities\/\d+\/level$/u.test(unitPointer(unit)));
      items = units.filter((unit) => /^\/payload\/themes\/\d+\/label$/u.test(unitPointer(unit)));
    } else if (material.deliverableType === 'accessibility_audit_report' && groupId.startsWith('a11y-issue:')) {
      label = units.find((unit) => /^\/payload\/priorities\/\d+\/level$/u.test(unitPointer(unit)));
      items = units.filter((unit) => /^\/payload\/remediations\/\d+\/action$/u.test(unitPointer(unit)));
    }
    if (label && items.length > 0 && items.length <= 24) {
      lanes.push({ label: verbatimCopy(label), items: items.map(verbatimCopy) });
    }
    if (lanes.length === 24) break;
  }
  return lanes.length === 0 ? undefined : { id: 'roadmap', kind: 'roadmap', lanes };
}

function validationGatesCandidate(
  material: EditorialMaterial,
  groups: ReadonlyMap<string, EditorialMaterialUnit[]>,
): CompositionBlock<'validation-gates'> | undefined {
  const gates: CompositionBlock<'validation-gates'>['gates'] = [];
  for (const [groupId, units] of groups) {
    let label: EditorialMaterialUnit | undefined;
    let method: EditorialMaterialUnit | undefined;
    let criterion: EditorialMaterialUnit | undefined;
    if (material.deliverableType === 'competitive_analysis_report' && /^competitive-roadmap:\d+$/u.test(groupId)) {
      label = units.find((unit) => /^\/payload\/roadmap\/\d+\/statement$/u.test(unitPointer(unit)));
      method = units.find((unit) => /^\/payload\/roadmap\/\d+\/validationMethod$/u.test(unitPointer(unit)));
      criterion = units.find((unit) => /^\/payload\/roadmap\/\d+\/metric$/u.test(unitPointer(unit)));
    } else if (material.deliverableType === 'design_audit_report' && groupId.startsWith('design-issue:')) {
      label = units.find((unit) => /^\/payload\/remediations\/\d+\/action$/u.test(unitPointer(unit)));
      method = units.find((unit) => /^\/payload\/retests\/\d+\/method$/u.test(unitPointer(unit)));
      criterion = units.find((unit) => /^\/payload\/retests\/\d+\/expectedResult$/u.test(unitPointer(unit)));
    } else if (material.deliverableType === 'accessibility_audit_report' && groupId.startsWith('a11y-issue:')) {
      label = units.find((unit) => /^\/payload\/remediations\/\d+\/action$/u.test(unitPointer(unit)));
      method = units.find((unit) => /^\/payload\/verification\/\d+\/method$/u.test(unitPointer(unit)));
      criterion = units.find((unit) => /^\/payload\/verification\/\d+\/expectedResult$/u.test(unitPointer(unit)));
    }
    if (label && method) {
      gates.push({
        label: verbatimCopy(label),
        method: verbatimCopy(method),
        ...(criterion === undefined ? {} : { successCriterion: verbatimCopy(criterion) }),
      });
    }
    if (gates.length === 24) break;
  }
  return gates.length === 0 ? undefined : { id: 'validation-gates', kind: 'validation-gates', gates };
}

function galleryAssetIds(material: EditorialMaterial, exportedAssetIds?: readonly string[]): string[] {
  const byId = new Map(material.assets.map((asset) => [asset.id, asset]));
  const selected = exportedAssetIds === undefined
    ? new Set(material.assets.map(({ id }) => id))
    : new Set(exportedAssetIds);
  if (exportedAssetIds !== undefined && (
    selected.size !== exportedAssetIds.length || exportedAssetIds.some((id) => !byId.has(id))
  )) {
    fail('VISUAL_POLICY', 'exported Asset IDs must be unique Material Asset IDs', 'visual_policy');
  }
  const result: string[] = [];
  const visitedGroups = new Set<string>();
  for (const asset of material.assets) {
    if (!selected.has(asset.id)) continue;
    if (asset.visualRole === 'standalone') {
      if (result.length < 6) result.push(asset.id);
      continue;
    }
    const groupId = asset.comparisonGroupId!;
    if (visitedGroups.has(groupId)) continue;
    visitedGroups.add(groupId);
    const pair = material.assets.filter((candidate) => candidate.comparisonGroupId === groupId);
    const before = pair.find(({ visualRole }) => visualRole === 'comparison-before');
    const after = pair.find(({ visualRole }) => visualRole === 'comparison-after');
    if (
      before
      && after
      && selected.has(before.id)
      && selected.has(after.id)
      && result.length <= 4
    ) result.push(before.id, after.id);
  }
  return result;
}

function deriveCompositionCandidates(
  material: EditorialMaterial,
  exportedAssetIds?: readonly string[],
): EditorialCompositionCandidates {
  const byId = new Map(material.units.map((unit) => [unit.id, unit]));
  const groups = unitsByGroup(material);
  const candidates: EditorialCompositionCandidates = {};
  const metricCards = metricCardsCandidate(material, byId);
  const truthTriad = truthTriadCandidate(material);
  const cardGrid = cardGridCandidate(material, groups);
  const flow = flowCandidate(material, groups);
  const strategyMatrix = strategyMatrixCandidate(material);
  const roadmap = roadmapCandidate(material, groups);
  const validationGates = validationGatesCandidate(material, groups);
  const galleryIds = galleryAssetIds(material, exportedAssetIds);
  if (metricCards) candidates['metric-cards'] = metricCards;
  if (truthTriad) candidates['truth-triad'] = truthTriad;
  if (cardGrid) candidates['card-grid'] = cardGrid;
  if (flow) candidates.flow = flow;
  if (strategyMatrix) candidates['strategy-matrix'] = strategyMatrix;
  if (roadmap) candidates.roadmap = roadmap;
  if (validationGates) candidates['validation-gates'] = validationGates;
  if (galleryIds.length > 0) {
    candidates['visual-gallery'] = {
      id: 'visual-gallery',
      kind: 'visual-gallery',
      assetIds: galleryIds,
    };
  }
  return candidates;
}

export function computeEligibleCompositionKinds(
  materialInput: EditorialMaterial,
  exportedAssetIds?: readonly string[],
): EditorialCompositionKind[] {
  const material = parseEditorialMaterial(materialInput);
  const candidates = deriveCompositionCandidates(material, exportedAssetIds);
  return COMPOSITION_KIND_ORDER.filter((kind) => candidates[kind] !== undefined);
}

export const editorialEligibleCompositionKinds = computeEligibleCompositionKinds;

export const EDITORIAL_CHECK_IDS: readonly EditorialCheckId[] = Object.freeze([
  'source_integrity',
  'model_egress',
  'model_identity',
  'schema_integrity',
  'reference_integrity',
  'component_relation',
  'epistemic_integrity',
  'numeric_integrity',
  'content_fidelity',
  'content_coverage',
  'composition_quality',
  'visual_policy',
  'html_safety',
]);

const EDITORIAL_VISUAL_WARNING_MESSAGES: Readonly<Record<EditorialVisualWarningCode, string>> = Object.freeze({
  VISUAL_MASK_OMITTED: 'A masked visual Asset was omitted because V1 cannot prove irreversible masking.',
  VISUAL_BLOCKED_OMITTED: 'A blocked visual Asset was omitted.',
  VISUAL_SVG_OMITTED: 'An SVG visual Asset was omitted by the raster-only policy.',
  VISUAL_BUDGET_OMITTED: 'A visual Asset group was omitted to keep the self-contained HTML within 8 MiB.',
});

export function createEditorialVisualWarning<TCode extends EditorialVisualWarningCode>(
  code: TCode,
): EditorialDiagnosticIssue & { code: TCode } {
  return { code, severity: 'warning', message: EDITORIAL_VISUAL_WARNING_MESSAGES[code] };
}

function createPhase1EgressWarning(reasonCode: string): EditorialDiagnosticIssue {
  const messages: Readonly<Record<string, string>> = Object.freeze({
    EGRESS_MODEL_UNCONFIGURED: 'The Phase 1 model port is intentionally unconfigured; the deterministic report was used.',
    EGRESS_SENSITIVITY_DENIED: 'Source sensitivity is not eligible for model egress; the deterministic report was used.',
    EGRESS_REDACTION_POLICY_DENIED: 'Source redaction policy is not eligible for model egress; the deterministic report was used.',
  });
  return {
    code: reasonCode,
    severity: 'warning',
    message: messages[reasonCode] ?? 'Model egress was denied by the fixed policy; the deterministic report was used.',
  };
}

function phase1DiagnosticCheck(
  id: EditorialCheckId,
  status: EditorialDiagnosticCheck['status'],
  issues: EditorialDiagnosticIssue[] = [],
): EditorialDiagnosticCheck {
  return { id, status, method: id === 'content_fidelity' ? 'llm' : 'deterministic', issues };
}

export function buildPhase1PublishedDiagnostic(input: {
  material: EditorialMaterial;
  requestKey: string;
  materialHash: Sha256;
  modelEgress: EditorialModelEgressDecision;
  modelContextHash: Sha256;
  modelContextByteSize: number;
  generationId: string;
  publishedBlueprintHash: Sha256;
  htmlHash: Sha256;
  rendererWarningCodes: readonly string[];
}): Extract<EditorialDiagnostic, { status: 'degraded' }> {
  const material = parseEditorialMaterial(input.material);
  if (input.materialHash !== hashBytes(canonicalJsonBytes(material)) || input.modelEgress.decision !== 'deny') {
    fail('SCHEMA_INTEGRITY', 'Phase 1 Diagnostic inputs are inconsistent', 'schema_integrity');
  }
  if (
    input.rendererWarningCodes.length > 128
    || input.rendererWarningCodes.some((code) => !EDITORIAL_RENDERER_WARNING_CODES.includes(
      code as EditorialRendererWarningCode,
    ))
  ) {
    fail('SCHEMA_INTEGRITY', 'Renderer warning codes are invalid', 'schema_integrity');
  }
  const egressIssue = createPhase1EgressWarning(input.modelEgress.reasonCode);
  const visualWarnings = [
    ...material.materializationWarningCodes.map(createEditorialVisualWarning),
    ...input.rendererWarningCodes.map((code) => createEditorialVisualWarning(code as EditorialRendererWarningCode)),
  ];
  const checks = new Map<EditorialCheckId, EditorialDiagnosticCheck>([
    ['source_integrity', phase1DiagnosticCheck('source_integrity', 'passed')],
    ['model_egress', phase1DiagnosticCheck('model_egress', 'passed', [egressIssue])],
    ['model_identity', phase1DiagnosticCheck('model_identity', 'not_run')],
    ['schema_integrity', phase1DiagnosticCheck('schema_integrity', 'passed')],
    ['reference_integrity', phase1DiagnosticCheck('reference_integrity', 'passed')],
    ['component_relation', phase1DiagnosticCheck('component_relation', 'passed')],
    ['epistemic_integrity', phase1DiagnosticCheck('epistemic_integrity', 'passed')],
    ['numeric_integrity', phase1DiagnosticCheck('numeric_integrity', 'passed')],
    ['content_fidelity', phase1DiagnosticCheck('content_fidelity', 'not_run')],
    ['content_coverage', phase1DiagnosticCheck('content_coverage', 'passed')],
    ['composition_quality', phase1DiagnosticCheck('composition_quality', 'passed')],
    ['visual_policy', phase1DiagnosticCheck('visual_policy', 'passed', visualWarnings)],
    ['html_safety', phase1DiagnosticCheck('html_safety', 'passed')],
  ]);
  return parseEditorialDiagnostic({
    version: EDITORIAL_DIAGNOSTIC_VERSION,
    taskId: material.taskId,
    planVersionId: material.planVersionId,
    attemptId: material.attemptId,
    sourceReportPackage: material.sourceReportPackage,
    gatewayConfigurationHash: null,
    candidateAttempts: [],
    rejectedResponseHashes: [],
    checks: EDITORIAL_CHECK_IDS.map((id) => checks.get(id)!),
    issues: [egressIssue, ...visualWarnings],
    status: 'degraded',
    mode: 'deterministic_fallback',
    requestKey: input.requestKey,
    materialHash: input.materialHash,
    modelEgress: input.modelEgress,
    modelContextHash: input.modelContextHash,
    modelContextByteSize: input.modelContextByteSize,
    generationId: input.generationId,
    publishedBlueprintHash: input.publishedBlueprintHash,
    htmlHash: input.htmlHash,
  }) as Extract<EditorialDiagnostic, { status: 'degraded' }>;
}

function orderedKinds<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  const present = new Set(values);
  return order.filter((value) => present.has(value));
}

function parseRenderTrace(value: unknown): EditorialRenderTrace {
  const candidate = record(value, '/renderTrace');
  exactKeys(candidate, [
    'bodyUnitIds', 'appendixUnitIds', 'assetIds', 'renderedBlocks', 'renderedBlockKinds',
    'eligibleCompositionKinds', 'renderedCompositionKinds',
  ], '/renderTrace');
  requiredKeys(candidate, [
    'bodyUnitIds', 'appendixUnitIds', 'assetIds', 'renderedBlocks', 'renderedBlockKinds',
    'eligibleCompositionKinds', 'renderedCompositionKinds',
  ], '/renderTrace');
  if (!Array.isArray(candidate.renderedBlocks) || candidate.renderedBlocks.length > EDITORIAL_MAX_BLUEPRINT_BLOCKS) {
    fail('HTML_SAFETY', 'renderedBlocks has an invalid length', 'html_safety', '/renderTrace/renderedBlocks');
  }
  const renderedBlocks = candidate.renderedBlocks.map((item, index) => {
    const path = `/renderTrace/renderedBlocks/${index}`;
    const parsed = record(item, path);
    exactKeys(parsed, ['blockId', 'kind'], path);
    requiredKeys(parsed, ['blockId', 'kind'], path);
    return {
      blockId: stringValue(parsed.blockId, `${path}/blockId`, 64),
      kind: enumValue(parsed.kind, BLOCK_KIND_ORDER, `${path}/kind`),
    };
  });
  const parseKinds = <T extends string>(input: unknown, allowed: readonly T[], path: string): T[] => {
    if (!Array.isArray(input)) fail('HTML_SAFETY', 'expected a kind array', 'html_safety', path);
    const values = input.map((item, index) => enumValue(item, allowed, `${path}/${index}`));
    if (canonicalEditorialJson(values) !== canonicalEditorialJson(orderedKinds(values, allowed))) {
      fail('HTML_SAFETY', 'kind trace must be unique and in canonical enum order', 'html_safety', path);
    }
    return values;
  };
  return {
    bodyUnitIds: stringArray(candidate.bodyUnitIds, '/renderTrace/bodyUnitIds', { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
    appendixUnitIds: stringArray(candidate.appendixUnitIds, '/renderTrace/appendixUnitIds', { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
    assetIds: stringArray(candidate.assetIds, '/renderTrace/assetIds', { maximum: 6 }),
    renderedBlocks,
    renderedBlockKinds: parseKinds(candidate.renderedBlockKinds, BLOCK_KIND_ORDER, '/renderTrace/renderedBlockKinds'),
    eligibleCompositionKinds: parseKinds(candidate.eligibleCompositionKinds, COMPOSITION_KIND_ORDER, '/renderTrace/eligibleCompositionKinds'),
    renderedCompositionKinds: parseKinds(candidate.renderedCompositionKinds, COMPOSITION_KIND_ORDER, '/renderTrace/renderedCompositionKinds'),
  };
}

export function validateEditorialRenderTrace(input: {
  blueprint: EditorialBlueprint;
  material: EditorialMaterial;
  trace: EditorialRenderTrace;
  exportedAssets: Array<{ assetId: string; contentSha256: Sha256 }>;
}): EditorialRenderTrace {
  const material = parseEditorialMaterial(input.material);
  const blueprint = parseEditorialBlueprint(input.blueprint);
  const trace = parseRenderTrace(input.trace);
  const materialUnits = new Set(material.units.map(({ id }) => id));
  if (trace.bodyUnitIds.some((id) => !materialUnits.has(id)) || trace.appendixUnitIds.some((id) => !materialUnits.has(id))) {
    fail('HTML_SAFETY', 'render trace contains an unknown Unit', 'html_safety');
  }
  for (const unit of material.units) {
    if (unit.requiredInBody && !trace.bodyUnitIds.includes(unit.id)) {
      fail('CONTENT_COVERAGE', `render trace omits required body Unit "${unit.id}"`, 'content_coverage');
    }
  }
  const requiredOutput = material.units.filter(({ requiredInOutput }) => requiredInOutput).map(({ id }) => id);
  if (canonicalEditorialJson(trace.appendixUnitIds) !== canonicalEditorialJson(requiredOutput)) {
    fail('CONTENT_COVERAGE', 'render trace appendix does not equal required output closure', 'content_coverage');
  }
  if (input.exportedAssets.length > 6) fail('VISUAL_POLICY', 'exportedAssets exceeds six entries', 'visual_policy');
  const materialAssetsBySourceId = new Map<string, Array<{ asset: EditorialMaterialAsset; index: number }>>();
  material.assets.forEach((asset, index) => {
    const matches = materialAssetsBySourceId.get(asset.assetId) ?? [];
    matches.push({ asset, index });
    materialAssetsBySourceId.set(asset.assetId, matches);
  });
  const sourceHashById = new Map(material.sourceArtifacts.map(({ artifactId, contentSha256 }) => (
    [artifactId, contentSha256]
  )));
  let priorIndex = -1;
  const exportedEditorialAssetIds: string[] = [];
  for (const [index, value] of input.exportedAssets.entries()) {
    const asset = record(value, `/exportedAssets/${index}`);
    exactKeys(asset, ['assetId', 'contentSha256'], `/exportedAssets/${index}`);
    const assetId = stringValue(asset.assetId, `/exportedAssets/${index}/assetId`);
    assertSha256(asset.contentSha256, `/exportedAssets/${index}/contentSha256`);
    const matches = materialAssetsBySourceId.get(assetId) ?? [];
    if (matches.length !== 1 || matches[0]!.index <= priorIndex) {
      fail('VISUAL_POLICY', 'exportedAssets must be unique and preserve Material asset order', 'visual_policy');
    }
    if (sourceHashById.get(assetId) !== asset.contentSha256) {
      fail('VISUAL_POLICY', 'exported Asset hash does not match its frozen source Artifact', 'visual_policy');
    }
    priorIndex = matches[0]!.index;
    exportedEditorialAssetIds.push(matches[0]!.asset.id);
  }
  if (canonicalEditorialJson(trace.assetIds) !== canonicalEditorialJson(exportedEditorialAssetIds)) {
    fail('VISUAL_POLICY', 'render trace assets do not match exportedAssets', 'visual_policy');
  }
  const expectedEligibility = computeEligibleCompositionKinds(material, exportedEditorialAssetIds);
  if (canonicalEditorialJson(trace.eligibleCompositionKinds) !== canonicalEditorialJson(expectedEligibility)) {
    fail('COMPOSITION_QUALITY', 'eligible composition trace does not match Material eligibility', 'composition_quality');
  }
  const exported = new Set(exportedEditorialAssetIds);
  const expectedBlocks = blueprint.sections.flatMap(({ blocks }) => blocks.flatMap((block) => {
    if (block.kind === 'visual-gallery' && !block.assetIds.some((assetId) => exported.has(assetId))) return [];
    return [{ blockId: block.id, kind: block.kind }];
  }));
  if (canonicalEditorialJson(trace.renderedBlocks) !== canonicalEditorialJson(expectedBlocks)) {
    fail('HTML_SAFETY', 'rendered block trace does not match non-empty Blueprint blocks', 'html_safety');
  }
  const expectedBlockKinds = orderedKinds(expectedBlocks.map(({ kind }) => kind), BLOCK_KIND_ORDER);
  if (canonicalEditorialJson(trace.renderedBlockKinds) !== canonicalEditorialJson(expectedBlockKinds)) {
    fail('HTML_SAFETY', 'rendered block kind trace is invalid', 'html_safety');
  }
  const expectedCompositions = orderedKinds(
    expectedBlocks.map(({ kind }) => kind).filter((kind): kind is EditorialCompositionKind => COMPOSITION_KINDS.has(kind)),
    COMPOSITION_KIND_ORDER,
  );
  if (trace.renderedCompositionKinds.some((kind) => !trace.eligibleCompositionKinds.includes(kind))) {
    fail('COMPOSITION_QUALITY', 'rendered composition kinds must be a subset of eligible kinds', 'composition_quality');
  }
  if (canonicalEditorialJson(trace.renderedCompositionKinds) !== canonicalEditorialJson(expectedCompositions)) {
    fail('COMPOSITION_QUALITY', 'rendered composition trace does not match rendered blocks', 'composition_quality');
  }
  if (trace.eligibleCompositionKinds.length >= 5 && trace.renderedCompositionKinds.length < 5) {
    fail('COMPOSITION_QUALITY', 'at least five eligible composition kinds must be rendered', 'composition_quality');
  }
  return trace;
}

export const createMaterialUnitId = createEditorialMaterialUnitId;

export function assertEditorialMaterial(value: unknown): asserts value is EditorialMaterial {
  assertValidEditorialMaterial(value);
}

export function assertEditorialBlueprint(input: {
  blueprint: unknown;
  material: EditorialMaterial;
  mode: 'llm' | 'deterministic_fallback';
}): asserts input is { blueprint: EditorialBlueprint; material: EditorialMaterial; mode: 'llm' | 'deterministic_fallback' } {
  assertValidEditorialBlueprint(input);
}

export function parseEditorialModelContext(value: unknown): EditorialModelContext {
  const candidate = record(value, '');
  exactKeys(candidate, ['version', 'materialHash', 'deliverableType', 'units', 'assets'], '');
  requiredKeys(candidate, ['version', 'materialHash', 'deliverableType', 'units', 'assets'], '');
  if (candidate.version !== EDITORIAL_MODEL_CONTEXT_VERSION) {
    fail('SCHEMA_INTEGRITY', `version must be ${EDITORIAL_MODEL_CONTEXT_VERSION}`, 'schema_integrity', '/version');
  }
  assertSha256(candidate.materialHash, '/materialHash');
  if (!Array.isArray(candidate.units) || candidate.units.length > EDITORIAL_MAX_MATERIAL_UNITS) {
    fail('SCHEMA_INTEGRITY', 'Model Context units have an invalid length', 'schema_integrity', '/units');
  }
  const units = candidate.units.map((item, index) => {
    const path = `/units/${index}`;
    const parsed = record(item, path);
    exactKeys(parsed, [
      'id', 'value', 'unit', 'role', 'epistemicStatus', 'metricEligible', 'groupId', 'basisUnitIds',
      'questionIds', 'requiredInOutput', 'requiredInBody',
    ], path);
    requiredKeys(parsed, [
      'id', 'value', 'role', 'metricEligible', 'basisUnitIds', 'questionIds', 'requiredInOutput', 'requiredInBody',
    ], path);
    if (typeof parsed.value !== 'string' && typeof parsed.value !== 'number' && typeof parsed.value !== 'boolean') {
      fail('SCHEMA_INTEGRITY', 'Model Context Unit value must be scalar', 'schema_integrity', `${path}/value`);
    }
    const role = enumValue(parsed.role, ['claim', 'recommendation', 'risk', 'validation', 'context', 'audit'], `${path}/role`);
    const epistemicStatus = parsed.epistemicStatus === undefined
      ? undefined
      : enumValue(parsed.epistemicStatus, ['fact', 'inference', 'unknown'], `${path}/epistemicStatus`);
    if ((role === 'context' || role === 'audit') !== (epistemicStatus === undefined)) {
      fail('EPISTEMIC_INTEGRITY', 'Model Context Unit status does not match its role', 'epistemic_integrity', path);
    }
    return {
      id: stringValue(parsed.id, `${path}/id`),
      value: normalizeEditorialScalar(parsed.value),
      ...(parsed.unit === undefined ? {} : { unit: enumValue(parsed.unit, ['/5', 'ratio', '个', '条'], `${path}/unit`) }),
      role,
      ...(epistemicStatus === undefined ? {} : { epistemicStatus }),
      metricEligible: booleanValue(parsed.metricEligible, `${path}/metricEligible`),
      ...(parsed.groupId === undefined ? {} : { groupId: stringValue(parsed.groupId, `${path}/groupId`) }),
      basisUnitIds: stringArray(parsed.basisUnitIds, `${path}/basisUnitIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
      questionIds: stringArray(parsed.questionIds, `${path}/questionIds`, { maximum: EDITORIAL_MAX_MATERIAL_UNITS }),
      requiredInOutput: booleanValue(parsed.requiredInOutput, `${path}/requiredInOutput`),
      requiredInBody: booleanValue(parsed.requiredInBody, `${path}/requiredInBody`),
    };
  });
  if (!Array.isArray(candidate.assets) || candidate.assets.length > 24) {
    fail('SCHEMA_INTEGRITY', 'Model Context assets have an invalid length', 'schema_integrity', '/assets');
  }
  const assets = candidate.assets.map((item, index) => {
    const path = `/assets/${index}`;
    const parsed = record(item, path);
    exactKeys(parsed, [
      'id', 'visualRole', 'comparisonGroupId', 'derivedFromEditorialAssetId', 'captionUnitId', 'altTextUnitId',
    ], path);
    requiredKeys(parsed, ['id', 'visualRole', 'captionUnitId', 'altTextUnitId'], path);
    return {
      id: stringValue(parsed.id, `${path}/id`),
      visualRole: enumValue(parsed.visualRole, ['standalone', 'comparison-before', 'comparison-after'], `${path}/visualRole`),
      ...(parsed.comparisonGroupId === undefined ? {} : { comparisonGroupId: stringValue(parsed.comparisonGroupId, `${path}/comparisonGroupId`) }),
      ...(parsed.derivedFromEditorialAssetId === undefined ? {} : {
        derivedFromEditorialAssetId: stringValue(parsed.derivedFromEditorialAssetId, `${path}/derivedFromEditorialAssetId`),
      }),
      captionUnitId: stringValue(parsed.captionUnitId, `${path}/captionUnitId`),
      altTextUnitId: stringValue(parsed.altTextUnitId, `${path}/altTextUnitId`),
    };
  });
  return {
    version: EDITORIAL_MODEL_CONTEXT_VERSION,
    materialHash: candidate.materialHash,
    deliverableType: stringValue(candidate.deliverableType, '/deliverableType'),
    units,
    assets,
  };
}

export function parseEditorialModelEgressDecision(
  value: unknown,
  path = '/modelEgress',
): EditorialModelEgressDecision {
  const candidate = record(value, path);
  exactKeys(candidate, ['policyVersion', 'policyHash', 'decision', 'reasonCode', 'evaluated'], path);
  requiredKeys(candidate, ['policyVersion', 'policyHash', 'decision', 'reasonCode', 'evaluated'], path);
  if (candidate.policyVersion !== EDITORIAL_MODEL_EGRESS_VERSION) {
    fail('MODEL_EGRESS_INVALID', 'egress policy version is invalid', 'model_egress', `${path}/policyVersion`);
  }
  if (candidate.policyHash !== EDITORIAL_MODEL_EGRESS_POLICY.policyHash) {
    fail('MODEL_EGRESS_INVALID', 'egress policy hash is invalid', 'model_egress', `${path}/policyHash`);
  }
  const decision = enumValue(candidate.decision, ['allow', 'deny'], `${path}/decision`);
  const reasonCode = enumValue(candidate.reasonCode, [
    'EGRESS_ALLOWED', 'EGRESS_SENSITIVITY_DENIED', 'EGRESS_REDACTION_POLICY_DENIED',
    'EGRESS_PROVIDER_DENIED', 'EGRESS_MODE_DENIED', 'EGRESS_ENDPOINT_DENIED',
    'EGRESS_REDIRECT_POLICY_DENIED', 'EGRESS_MODEL_UNCONFIGURED',
  ], `${path}/reasonCode`);
  if ((decision === 'allow') !== (reasonCode === 'EGRESS_ALLOWED')) {
    fail('MODEL_EGRESS_INVALID', 'egress decision and reasonCode disagree', 'model_egress', path);
  }
  const evaluated = record(candidate.evaluated, `${path}/evaluated`);
  exactKeys(evaluated, [
    'sourcePolicySetHash', 'contributingSourceCount', 'sensitivities', 'redactionPolicyVersions',
    'provider', 'mode', 'endpointHost', 'endpointUrl', 'redirectMode',
  ], `${path}/evaluated`);
  requiredKeys(evaluated, [
    'sourcePolicySetHash', 'contributingSourceCount', 'sensitivities', 'redactionPolicyVersions',
    'provider', 'mode', 'endpointHost', 'endpointUrl', 'redirectMode',
  ], `${path}/evaluated`);
  assertSha256(evaluated.sourcePolicySetHash, `${path}/evaluated/sourcePolicySetHash`);
  const sensitivities = stringArray(evaluated.sensitivities, `${path}/evaluated/sensitivities`, { maximum: 16, maximumBytes: 64 });
  const redactionPolicyVersions = stringArray(evaluated.redactionPolicyVersions, `${path}/evaluated/redactionPolicyVersions`, { maximum: 16, maximumBytes: 64 });
  if (
    canonicalEditorialJson(sensitivities) !== canonicalEditorialJson([...sensitivities].sort(compareUnicodeCodePoints))
    || canonicalEditorialJson(redactionPolicyVersions) !== canonicalEditorialJson([...redactionPolicyVersions].sort(compareUnicodeCodePoints))
  ) {
    fail('MODEL_EGRESS_INVALID', 'egress policy dimensions must use canonical ordering', 'model_egress', `${path}/evaluated`);
  }
  const nullableString = (input: unknown, inputPath: string, max = 256): string | null => (
    input === null ? null : stringValue(input, inputPath, max)
  );
  return {
    policyVersion: EDITORIAL_MODEL_EGRESS_VERSION,
    policyHash: EDITORIAL_MODEL_EGRESS_POLICY.policyHash,
    decision,
    reasonCode,
    evaluated: {
      sourcePolicySetHash: evaluated.sourcePolicySetHash,
      contributingSourceCount: integerValue(evaluated.contributingSourceCount, `${path}/evaluated/contributingSourceCount`, 1),
      sensitivities,
      redactionPolicyVersions,
      provider: nullableString(evaluated.provider, `${path}/evaluated/provider`),
      mode: evaluated.mode === null
        ? null
        : enumValue<'mock' | 'real' | 'draft'>(evaluated.mode, ['mock', 'real', 'draft'], `${path}/evaluated/mode`),
      endpointHost: nullableString(evaluated.endpointHost, `${path}/evaluated/endpointHost`, 253),
      endpointUrl: nullableString(evaluated.endpointUrl, `${path}/evaluated/endpointUrl`, 2_048),
      redirectMode: evaluated.redirectMode === null
        ? null
        : enumValue<'error'>(evaluated.redirectMode, ['error'], `${path}/evaluated/redirectMode`),
    },
  };
}

function parseDiagnosticIssue(value: unknown, path: string): EditorialDiagnosticIssue {
  const candidate = record(value, path);
  exactKeys(candidate, ['code', 'severity', 'message', 'jsonPointer', 'materialUnitIds'], path);
  requiredKeys(candidate, ['code', 'severity', 'message'], path);
  const code = stringValue(candidate.code, `${path}/code`, 64);
  if (!/^[\x21-\x7e]+$/u.test(code)) fail('SCHEMA_INTEGRITY', 'issue code must be ASCII', 'schema_integrity', `${path}/code`);
  const message = stringValue(candidate.message, `${path}/message`, 512);
  if (/[\u0000-\u001f]/u.test(message)) fail('SCHEMA_INTEGRITY', 'issue message contains a control character', 'schema_integrity', `${path}/message`);
  const jsonPointer = candidate.jsonPointer === undefined
    ? undefined
    : stringValue(candidate.jsonPointer, `${path}/jsonPointer`, 256);
  if (jsonPointer !== undefined && (!JSON_POINTER_PATTERN.test(jsonPointer) || !/^[\x20-\x7e]*$/u.test(jsonPointer))) {
    fail('SCHEMA_INTEGRITY', 'issue jsonPointer must be bounded ASCII RFC 6901', 'schema_integrity', `${path}/jsonPointer`);
  }
  return {
    code,
    severity: enumValue(candidate.severity, ['warning', 'error'], `${path}/severity`),
    message,
    ...(jsonPointer === undefined ? {} : { jsonPointer }),
    ...(candidate.materialUnitIds === undefined ? {} : {
      materialUnitIds: stringArray(candidate.materialUnitIds, `${path}/materialUnitIds`, { maximum: 16 }),
    }),
  };
}

function parseModelCall(value: unknown, path: string): EditorialModelCallRecord {
  const candidate = record(value, path);
  const common = [
    'stage', 'ordinal', 'gatewayConfigurationHash', 'modelContextHash', 'modelContextByteSize',
    'promptVersion', 'promptHash', 'status',
  ];
  const success = [
    ...common, 'provider', 'endpointHost', 'requestedModel', 'expectedModel', 'actualModel',
    'modelVersion', 'traceId', 'responseHash', 'tokens',
  ];
  const failed = [
    ...common, 'provider', 'endpointHost', 'requestedModel', 'expectedModel', 'actualModel',
    'modelVersion', 'traceId', 'failureCode',
  ];
  const status = enumValue(candidate.status, ['succeeded', 'failed'], `${path}/status`);
  exactKeys(candidate, status === 'succeeded' ? success : failed, path);
  requiredKeys(candidate, [...common, ...(status === 'succeeded'
    ? ['provider', 'endpointHost', 'requestedModel', 'expectedModel', 'actualModel', 'modelVersion', 'traceId', 'responseHash']
    : ['failureCode'])], path);
  assertSha256(candidate.gatewayConfigurationHash, `${path}/gatewayConfigurationHash`);
  assertSha256(candidate.modelContextHash, `${path}/modelContextHash`);
  const promptHash = stringValue(candidate.promptHash, `${path}/promptHash`);
  if (!/^sha256:[0-9a-f]{16}$/u.test(promptHash)) {
    fail('SCHEMA_INTEGRITY', 'promptHash must be the existing 16-hex fingerprint', 'schema_integrity', `${path}/promptHash`);
  }
  if (candidate.ordinal !== 1 && candidate.ordinal !== 2) {
    fail('SCHEMA_INTEGRITY', 'model call ordinal must be 1 or 2', 'schema_integrity', `${path}/ordinal`);
  }
  const base: EditorialModelCallRecordBase = {
    stage: enumValue(candidate.stage, ['editorial_blueprint', 'editorial_fidelity_review'], `${path}/stage`),
    ordinal: candidate.ordinal,
    gatewayConfigurationHash: candidate.gatewayConfigurationHash,
    modelContextHash: candidate.modelContextHash,
    modelContextByteSize: integerValue(candidate.modelContextByteSize, `${path}/modelContextByteSize`),
    promptVersion: stringValue(candidate.promptVersion, `${path}/promptVersion`),
    promptHash: promptHash as PromptFingerprint,
  };
  if (status === 'failed') {
    const optionalString = (key: string, maximum = 256): string | undefined => (
      candidate[key] === undefined ? undefined : stringValue(candidate[key], `${path}/${key}`, maximum)
    );
    return {
      ...base,
      status,
      ...(optionalString('provider') === undefined ? {} : { provider: optionalString('provider') }),
      ...(optionalString('endpointHost', 253) === undefined ? {} : { endpointHost: optionalString('endpointHost', 253) }),
      ...(optionalString('requestedModel') === undefined ? {} : { requestedModel: optionalString('requestedModel') }),
      ...(optionalString('expectedModel') === undefined ? {} : { expectedModel: optionalString('expectedModel') }),
      ...(optionalString('actualModel') === undefined ? {} : { actualModel: optionalString('actualModel') }),
      ...(optionalString('modelVersion') === undefined ? {} : { modelVersion: optionalString('modelVersion') }),
      ...(optionalString('traceId') === undefined ? {} : { traceId: optionalString('traceId') }),
      failureCode: stringValue(candidate.failureCode, `${path}/failureCode`, 64),
    };
  }
  assertSha256(candidate.responseHash, `${path}/responseHash`);
  let tokens: { prompt: number; completion: number; total: number } | undefined;
  if (candidate.tokens !== undefined) {
    const tokenRecord = record(candidate.tokens, `${path}/tokens`);
    exactKeys(tokenRecord, ['prompt', 'completion', 'total'], `${path}/tokens`);
    requiredKeys(tokenRecord, ['prompt', 'completion', 'total'], `${path}/tokens`);
    tokens = {
      prompt: integerValue(tokenRecord.prompt, `${path}/tokens/prompt`),
      completion: integerValue(tokenRecord.completion, `${path}/tokens/completion`),
      total: integerValue(tokenRecord.total, `${path}/tokens/total`),
    };
    if (tokens.total !== tokens.prompt + tokens.completion) {
      fail('SCHEMA_INTEGRITY', 'token total is inconsistent', 'schema_integrity', `${path}/tokens/total`);
    }
  }
  return {
    ...base,
    status,
    provider: stringValue(candidate.provider, `${path}/provider`),
    endpointHost: stringValue(candidate.endpointHost, `${path}/endpointHost`, 253),
    requestedModel: stringValue(candidate.requestedModel, `${path}/requestedModel`),
    expectedModel: stringValue(candidate.expectedModel, `${path}/expectedModel`),
    actualModel: stringValue(candidate.actualModel, `${path}/actualModel`),
    modelVersion: stringValue(candidate.modelVersion, `${path}/modelVersion`),
    traceId: stringValue(candidate.traceId, `${path}/traceId`),
    responseHash: candidate.responseHash,
    ...(tokens === undefined ? {} : { tokens }),
  };
}

function parseDiagnosticCheck(value: unknown, path: string): EditorialDiagnosticCheck {
  const candidate = record(value, path);
  exactKeys(candidate, ['id', 'status', 'method', 'issues'], path);
  requiredKeys(candidate, ['id', 'status', 'method', 'issues'], path);
  if (!Array.isArray(candidate.issues) || candidate.issues.length > 128) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic check issues exceed their limit', 'schema_integrity', `${path}/issues`);
  }
  return {
    id: enumValue(candidate.id, EDITORIAL_CHECK_IDS, `${path}/id`),
    status: enumValue(candidate.status, ['passed', 'failed', 'not_run'], `${path}/status`),
    method: enumValue(candidate.method, ['deterministic', 'llm'], `${path}/method`),
    issues: candidate.issues.map((issue, index) => parseDiagnosticIssue(issue, `${path}/issues/${index}`)),
  };
}

export function parseEditorialDiagnostic(value: unknown): EditorialDiagnostic {
  const candidate = record(value, '');
  const baseKeys = [
    'version', 'taskId', 'planVersionId', 'attemptId', 'sourceReportPackage',
    'gatewayConfigurationHash', 'candidateAttempts', 'rejectedResponseHashes', 'checks', 'issues',
  ];
  const preparedKeys = ['requestKey', 'materialHash', 'modelEgress', 'modelContextHash', 'modelContextByteSize'];
  const publishedKeys = ['generationId', 'publishedBlueprintHash', 'htmlHash'];
  const status = enumValue(candidate.status, ['pass', 'degraded', 'fail'], '/status');
  const mode = enumValue(candidate.mode, ['llm', 'deterministic_fallback', 'none'], '/mode');
  const prepared = mode !== 'none';
  const published = status === 'pass' || status === 'degraded';
  exactKeys(candidate, [...baseKeys, 'status', 'mode', ...(prepared ? preparedKeys : []), ...(published ? publishedKeys : [])], '');
  requiredKeys(candidate, [...baseKeys, 'status', 'mode', ...(prepared ? preparedKeys : []), ...(published ? publishedKeys : [])], '');
  if (candidate.version !== EDITORIAL_DIAGNOSTIC_VERSION) {
    fail('SCHEMA_INTEGRITY', `version must be ${EDITORIAL_DIAGNOSTIC_VERSION}`, 'schema_integrity', '/version');
  }
  if (
    (status === 'pass' && mode !== 'llm')
    || (status === 'degraded' && mode !== 'deterministic_fallback')
    || (status === 'fail' && !['none', 'llm', 'deterministic_fallback'].includes(mode))
  ) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic status/mode combination is invalid', 'schema_integrity');
  }
  if (candidate.gatewayConfigurationHash !== null) assertSha256(candidate.gatewayConfigurationHash, '/gatewayConfigurationHash');
  if (!Array.isArray(candidate.candidateAttempts) || candidate.candidateAttempts.length > 2) {
    fail('SCHEMA_INTEGRITY', 'candidateAttempts exceeds two entries', 'schema_integrity', '/candidateAttempts');
  }
  if (candidate.candidateAttempts.length > 0) {
    // Phase 2 owns the candidate parser. Reject opaque content in Phase 1 instead of accepting it unchecked.
    fail('SCHEMA_INTEGRITY', 'candidateAttempts are not supported by the Phase 1 contract parser', 'schema_integrity', '/candidateAttempts');
  }
  const rejectedResponseHashes = stringArray(candidate.rejectedResponseHashes, '/rejectedResponseHashes', { maximum: 2 }) as Sha256[];
  rejectedResponseHashes.forEach((hash, index) => assertSha256(hash, `/rejectedResponseHashes/${index}`));
  if (!Array.isArray(candidate.checks) || candidate.checks.length !== EDITORIAL_CHECK_IDS.length) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic must contain every check exactly once', 'schema_integrity', '/checks');
  }
  const checks = candidate.checks.map((check, index) => parseDiagnosticCheck(check, `/checks/${index}`));
  if (canonicalEditorialJson(checks.map(({ id }) => id)) !== canonicalEditorialJson(EDITORIAL_CHECK_IDS)) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic checks must be unique and in canonical order', 'schema_integrity', '/checks');
  }
  if (!Array.isArray(candidate.issues) || candidate.issues.length > 128) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic issues exceed their limit', 'schema_integrity', '/issues');
  }
  const issues = candidate.issues.map((issue, index) => parseDiagnosticIssue(issue, `/issues/${index}`));
  if (issues.length + checks.reduce((count, check) => count + check.issues.length, 0) > 128) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic total issue count exceeds 128', 'schema_integrity');
  }
  const base: EditorialDiagnosticBase = {
    version: EDITORIAL_DIAGNOSTIC_VERSION,
    taskId: stringValue(candidate.taskId, '/taskId'),
    planVersionId: stringValue(candidate.planVersionId, '/planVersionId'),
    attemptId: stringValue(candidate.attemptId, '/attemptId'),
    sourceReportPackage: parseEditorialSourceArtifactRef(candidate.sourceReportPackage, '/sourceReportPackage'),
    gatewayConfigurationHash: candidate.gatewayConfigurationHash as Sha256 | null,
    candidateAttempts: [],
    rejectedResponseHashes,
    checks,
    issues,
  };
  if (!prepared) {
    const parsed: EditorialDiagnostic = { ...base, status: 'fail', mode: 'none' };
    if (canonicalJsonBytes(parsed).byteLength > EDITORIAL_MAX_DIAGNOSTIC_BYTES) {
      fail('SCHEMA_INTEGRITY', 'Diagnostic exceeds 2 MiB', 'schema_integrity');
    }
    return parsed;
  }
  if (typeof candidate.requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(candidate.requestKey)) {
    fail('SCHEMA_INTEGRITY', 'requestKey is invalid', 'schema_integrity', '/requestKey');
  }
  assertSha256(candidate.materialHash, '/materialHash');
  assertSha256(candidate.modelContextHash, '/modelContextHash');
  const preparedFields: EditorialPreparedDiagnosticFields = {
    requestKey: candidate.requestKey,
    materialHash: candidate.materialHash,
    modelEgress: parseEditorialModelEgressDecision(candidate.modelEgress),
    modelContextHash: candidate.modelContextHash,
    modelContextByteSize: integerValue(candidate.modelContextByteSize, '/modelContextByteSize'),
  };
  let parsed: EditorialDiagnostic;
  if (published) {
    if (typeof candidate.generationId !== 'string' || !GENERATION_ID_PATTERN.test(candidate.generationId)) {
      fail('SCHEMA_INTEGRITY', 'generationId is invalid', 'schema_integrity', '/generationId');
    }
    assertSha256(candidate.publishedBlueprintHash, '/publishedBlueprintHash');
    assertSha256(candidate.htmlHash, '/htmlHash');
    parsed = {
      ...base,
      ...preparedFields,
      status: status as 'pass' | 'degraded',
      mode: mode as 'llm' | 'deterministic_fallback',
      generationId: candidate.generationId,
      publishedBlueprintHash: candidate.publishedBlueprintHash,
      htmlHash: candidate.htmlHash,
    } as EditorialDiagnostic;
  } else {
    parsed = {
      ...base,
      ...preparedFields,
      status: 'fail',
      mode: mode as 'llm' | 'deterministic_fallback',
    };
  }
  if (parsed.status === 'pass' && (
    parsed.issues.some(({ severity }) => severity === 'error')
    || parsed.checks.some(({ status: checkStatus }) => checkStatus !== 'passed')
  )) {
    fail('SCHEMA_INTEGRITY', 'passing Diagnostic contains an incomplete or failed check', 'schema_integrity');
  }
  if (parsed.mode !== 'none' && parsed.gatewayConfigurationHash === null && (
    parsed.modelEgress.evaluated.provider !== null
    || parsed.modelEgress.evaluated.mode !== null
    || parsed.modelEgress.evaluated.endpointHost !== null
    || parsed.modelEgress.evaluated.endpointUrl !== null
    || parsed.modelEgress.evaluated.redirectMode !== null
  )) {
    fail('MODEL_EGRESS_INVALID', 'null Gateway hash requires a null egress route identity', 'model_egress');
  }
  if (canonicalJsonBytes(parsed).byteLength > EDITORIAL_MAX_DIAGNOSTIC_BYTES) {
    fail('SCHEMA_INTEGRITY', 'Diagnostic exceeds 2 MiB', 'schema_integrity');
  }
  return parsed;
}

function parseDerivedFileRef<TMediaType extends DerivedFileRef['mediaType']>(
  value: unknown,
  path: string,
  expectedPath: string,
  expectedMediaType: TMediaType,
): DerivedFileRef & { mediaType: TMediaType } {
  const candidate = record(value, path);
  exactKeys(candidate, ['relativePath', 'contentSha256', 'byteSize', 'mediaType'], path);
  requiredKeys(candidate, ['relativePath', 'contentSha256', 'byteSize', 'mediaType'], path);
  if (candidate.relativePath !== expectedPath || candidate.mediaType !== expectedMediaType) {
    fail('SCHEMA_INTEGRITY', 'derived file path or media type is invalid', 'schema_integrity', path);
  }
  assertSha256(candidate.contentSha256, `${path}/contentSha256`);
  return {
    relativePath: expectedPath,
    contentSha256: candidate.contentSha256,
    byteSize: integerValue(candidate.byteSize, `${path}/byteSize`),
    mediaType: expectedMediaType,
  };
}

export function parseEditorialReport(value: unknown): EditorialReport {
  const candidate = record(value, '');
  exactKeys(candidate, [
    'version', 'authority', 'taskId', 'planVersionId', 'attemptId', 'sensitivity',
    'redactionPolicyVersion', 'requestKey', 'generationId', 'status', 'sourceReportPackage',
    'pipeline', 'modelCalls', 'exportedAssets', 'files', 'generatedAt',
  ], '');
  requiredKeys(candidate, [
    'version', 'authority', 'taskId', 'planVersionId', 'attemptId', 'sensitivity',
    'redactionPolicyVersion', 'requestKey', 'generationId', 'status', 'sourceReportPackage',
    'pipeline', 'modelCalls', 'exportedAssets', 'files', 'generatedAt',
  ], '');
  if (candidate.version !== EDITORIAL_REPORT_VERSION || candidate.authority !== 'derived') {
    fail('SCHEMA_INTEGRITY', 'Editorial Report version or authority is invalid', 'schema_integrity');
  }
  if (typeof candidate.requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(candidate.requestKey)) {
    fail('SCHEMA_INTEGRITY', 'requestKey is invalid', 'schema_integrity', '/requestKey');
  }
  if (typeof candidate.generationId !== 'string' || !GENERATION_ID_PATTERN.test(candidate.generationId)) {
    fail('SCHEMA_INTEGRITY', 'generationId is invalid', 'schema_integrity', '/generationId');
  }
  const status = enumValue(candidate.status, ['ready', 'degraded'], '/status');
  const pipeline = record(candidate.pipeline, '/pipeline');
  exactKeys(pipeline, [
    'materialVersion', 'modelContextVersion', 'modelContextHash', 'blueprintPlanVersion',
    'blueprintVersion', 'promptVersion', 'fidelityPromptVersion', 'fallbackVersion',
    'rendererVersion', 'storeVersion', 'modelEgress', 'gatewayConfiguration',
  ], '/pipeline');
  requiredKeys(pipeline, [
    'materialVersion', 'modelContextVersion', 'modelContextHash', 'blueprintPlanVersion',
    'blueprintVersion', 'promptVersion', 'fidelityPromptVersion', 'fallbackVersion',
    'rendererVersion', 'storeVersion', 'modelEgress', 'gatewayConfiguration',
  ], '/pipeline');
  const expectedVersions: Record<string, string> = {
    materialVersion: EDITORIAL_MATERIAL_VERSION,
    modelContextVersion: EDITORIAL_MODEL_CONTEXT_VERSION,
    blueprintPlanVersion: EDITORIAL_BLUEPRINT_PLAN_VERSION,
    blueprintVersion: EDITORIAL_BLUEPRINT_VERSION,
    promptVersion: EDITORIAL_BLUEPRINT_PROMPT_VERSION,
    fidelityPromptVersion: EDITORIAL_FIDELITY_PROMPT_VERSION,
    fallbackVersion: EDITORIAL_FALLBACK_VERSION,
    rendererVersion: EDITORIAL_RENDERER_VERSION,
    storeVersion: EDITORIAL_STORE_VERSION,
  };
  for (const [key, expected] of Object.entries(expectedVersions)) {
    if (pipeline[key] !== expected) fail('SCHEMA_INTEGRITY', `${key} is invalid`, 'schema_integrity', `/pipeline/${key}`);
  }
  assertSha256(pipeline.modelContextHash, '/pipeline/modelContextHash');
  const gatewayConfiguration = pipeline.gatewayConfiguration === null
    ? null
    : parseEditorialGatewayConfiguration(pipeline.gatewayConfiguration);
  if (!Array.isArray(candidate.modelCalls) || candidate.modelCalls.length > 4) {
    fail('SCHEMA_INTEGRITY', 'modelCalls exceeds four entries', 'schema_integrity', '/modelCalls');
  }
  const modelCalls = candidate.modelCalls.map((call, index) => parseModelCall(call, `/modelCalls/${index}`));
  if (status === 'ready' && (gatewayConfiguration === null || modelCalls.length === 0)) {
    fail('SCHEMA_INTEGRITY', 'ready status requires a Gateway configuration and modelCalls', 'schema_integrity', '/status');
  }
  if (gatewayConfiguration === null && modelCalls.length > 0) {
    fail('SCHEMA_INTEGRITY', 'modelCalls require a Gateway configuration', 'schema_integrity', '/modelCalls');
  }
  if (!Array.isArray(candidate.exportedAssets) || candidate.exportedAssets.length > 6) {
    fail('SCHEMA_INTEGRITY', 'exportedAssets exceeds six entries', 'schema_integrity', '/exportedAssets');
  }
  const seenAssets = new Set<string>();
  const exportedAssets = candidate.exportedAssets.map((item, index) => {
    const path = `/exportedAssets/${index}`;
    const parsed = record(item, path);
    exactKeys(parsed, ['assetId', 'contentSha256'], path);
    requiredKeys(parsed, ['assetId', 'contentSha256'], path);
    const assetId = stringValue(parsed.assetId, `${path}/assetId`);
    assertSha256(parsed.contentSha256, `${path}/contentSha256`);
    if (seenAssets.has(assetId)) fail('REFERENCE_INTEGRITY', 'duplicate exported Asset', 'reference_integrity', path);
    seenAssets.add(assetId);
    return { assetId, contentSha256: parsed.contentSha256 };
  });
  const files = record(candidate.files, '/files');
  exactKeys(files, ['material', 'blueprint', 'diagnostic', 'html'], '/files');
  requiredKeys(files, ['material', 'blueprint', 'diagnostic', 'html'], '/files');
  const html = record(files.html, '/files/html');
  exactKeys(html, ['relativePath', 'contentSha256', 'byteSize', 'mediaType', 'selfContained', 'printProfile'], '/files/html');
  requiredKeys(html, ['relativePath', 'contentSha256', 'byteSize', 'mediaType', 'selfContained', 'printProfile'], '/files/html');
  const htmlRef = parseDerivedFileRef({
    relativePath: html.relativePath,
    contentSha256: html.contentSha256,
    byteSize: html.byteSize,
    mediaType: html.mediaType,
  }, '/files/html', 'editorial-report.html', 'text/html');
  if (html.selfContained !== true || html.printProfile !== 'a4-portrait-v1') {
    fail('HTML_SAFETY', 'HTML manifest flags are invalid', 'html_safety', '/files/html');
  }
  const generatedAt = stringValue(candidate.generatedAt, '/generatedAt');
  if (!Number.isFinite(Date.parse(generatedAt))) {
    fail('SCHEMA_INTEGRITY', 'generatedAt must be an ISO timestamp', 'schema_integrity', '/generatedAt');
  }
  const parsed: EditorialReport = {
    version: EDITORIAL_REPORT_VERSION,
    authority: 'derived',
    taskId: stringValue(candidate.taskId, '/taskId'),
    planVersionId: stringValue(candidate.planVersionId, '/planVersionId'),
    attemptId: stringValue(candidate.attemptId, '/attemptId'),
    sensitivity: stringValue(candidate.sensitivity, '/sensitivity', 64),
    redactionPolicyVersion: stringValue(candidate.redactionPolicyVersion, '/redactionPolicyVersion', 64),
    requestKey: candidate.requestKey,
    generationId: candidate.generationId,
    status,
    sourceReportPackage: parseEditorialSourceArtifactRef(candidate.sourceReportPackage, '/sourceReportPackage'),
    pipeline: {
      materialVersion: EDITORIAL_MATERIAL_VERSION,
      modelContextVersion: EDITORIAL_MODEL_CONTEXT_VERSION,
      modelContextHash: pipeline.modelContextHash,
      blueprintPlanVersion: EDITORIAL_BLUEPRINT_PLAN_VERSION,
      blueprintVersion: EDITORIAL_BLUEPRINT_VERSION,
      promptVersion: EDITORIAL_BLUEPRINT_PROMPT_VERSION,
      fidelityPromptVersion: EDITORIAL_FIDELITY_PROMPT_VERSION,
      fallbackVersion: EDITORIAL_FALLBACK_VERSION,
      rendererVersion: EDITORIAL_RENDERER_VERSION,
      storeVersion: EDITORIAL_STORE_VERSION,
      modelEgress: parseEditorialModelEgressDecision(pipeline.modelEgress, '/pipeline/modelEgress'),
      gatewayConfiguration,
    },
    modelCalls,
    exportedAssets,
    files: {
      material: parseDerivedFileRef(files.material, '/files/material', 'editorial-material.json', 'application/json'),
      blueprint: parseDerivedFileRef(files.blueprint, '/files/blueprint', 'editorial-blueprint.json', 'application/json'),
      diagnostic: parseDerivedFileRef(files.diagnostic, '/files/diagnostic', 'editorial-diagnostic.json', 'application/json'),
      html: { ...htmlRef, selfContained: true, printProfile: 'a4-portrait-v1' },
    },
    generatedAt,
  };
  if (canonicalJsonBytes(parsed).byteLength > EDITORIAL_MAX_MANIFEST_BYTES) {
    fail('SCHEMA_INTEGRITY', 'manifest exceeds 256 KiB', 'schema_integrity');
  }
  return parsed;
}
