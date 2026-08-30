import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  ControlPlaneRepository,
  type ControlArtifact,
} from '../database/control-plane.ts';
import { closePool, pool } from '../database/db.ts';
import type { PassedReportReviewArtifact } from '../packages/api-contract/control-workflow.ts';
import type {
  ReportDocumentV4,
  ReportNoticeV1,
} from '../packages/api-contract/report-document.ts';
import type {
  ReportEditorialBlueprintV1,
  ReportEditorialIntentV1,
  ReportEditorialMaterialV1,
} from '../packages/api-contract/report-editorial.ts';
import type {
  EditorialPresentationSpecV1,
  ReportEditorialIntentV2,
} from '../packages/api-contract/report-editorial-showcase.ts';
import type {
  ContributionLedgerV1,
  EvidenceEntry,
  EvidenceManifest,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  ResearchStrategyReportPayloadV2,
} from '../packages/api-contract/research-deliverable.ts';
import { collectReportDocumentV4Semantics } from '../packages/report-rendering/report-document-visitor.ts';
import { assertReportEditorialBlueprintIntegrity } from '../packages/report-rendering/report-editorial-validation.ts';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import type {
  EvidenceArtifactResolver,
  ResolvedEvidenceArtifact,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  compileReportEditorialIntent,
  createDeterministicReportEditorialIntentCompilation,
} from '../apps/orchestrator-runtime/src/report/report-editorial-intent-compiler.ts';
import {
  buildReportAuditAppendixMaterialV1,
  buildResearchPlanEditorialMaterialV1,
  buildResearchStrategyEditorialMaterialV1,
} from '../apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts';
import {
  assertReportEditorialModelPresentationsEnabled,
  buildReportEditorialPlannerInputV1,
  type ReportEditorialPlanResult,
  type ReportEditorialPlannerDataClassification,
  ReportEditorialPlanner,
  productionReportEditorialPlannerDataPolicy,
} from '../apps/orchestrator-runtime/src/report/report-editorial-planner.ts';
import {
  bindEditorialShowcaseContributions,
  bindEditorialShowcaseEvidenceManifest,
  compileEditorialShowcase,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-renderer.ts';
import { projectReportEditorialDocumentV4 } from '../apps/orchestrator-runtime/src/report/report-editorial-projector.ts';
import { assertReportCompositionInput } from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import {
  renderStandaloneReport,
} from '../apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts';
import { assertValidReportReviewArtifact } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import { resolveDeliverableContractById, selectReadablePayloadSchema } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import { parseModelRoutes } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  ModelCallRecorder,
  ModelCallRecordInput,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ReceiptLLMClient } from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const INPUT_ARTIFACTS = {
  deliverable: {
    relativePath: 'deliverables/final-r0.json',
    kind: 'deliverable',
    schemaVersion: 'research-deliverable-v1-review-gated',
  },
  review: {
    relativePath: 'reports/review-r0.json',
    kind: 'report_review',
    schemaVersion: ['report-review-v1', 'report-review-v2'],
  },
  contributionLedger: {
    relativePath: 'deliverables/contribution-ledger-r0.json',
    kind: 'contribution_ledger',
    schemaVersion: 'contribution-ledger-v1',
  },
  evidenceManifest: {
    relativePath: 'evidence/manifest.json',
    kind: 'evidence_manifest',
    schemaVersion: 'evidence-v1',
  },
} as const;

const OUTPUT_FILES = {
  selectedBlueprint: 'selected-blueprint.json',
  deterministicBlueprint: 'deterministic-blueprint.json',
  reportDocument: 'report-document.json',
  deterministicReportDocument: 'deterministic-report-document.json',
  renderManifest: 'render-manifest.json',
  html: 'report.html',
  showcaseSpec: 'editorial-presentation-spec.json',
  showcaseHtml: 'editorial-showcase.html',
  summary: 'acceptance-summary.json',
} as const;

const BLUEPRINT_SCHEMA_PATH = 'schemas/report-editorial-blueprint-v1.schema.json';
const INTENT_V1_SCHEMA_PATH = 'schemas/report-editorial-intent-v1.schema.json';
const INTENT_V2_SCHEMA_PATH = 'schemas/report-editorial-intent-v2.schema.json';

interface ArtifactBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

interface AttemptLayout extends ArtifactBinding {
  attemptDir: string;
  workspaceRoot: string;
}

interface VerifiedArtifactValue<T> {
  artifact: ControlArtifact;
  value: T;
}

interface SourceArtifactSummary {
  id: string;
  kind: string;
  schemaVersion: string;
  contentSha256: string;
  byteSize: number;
  relativePath: string;
}

export interface ReportEditorialAcceptanceDependencies {
  repository: Pick<ControlPlaneRepository, 'getTaskDetail' | 'listArtifactsByStorageUri'>;
  artifacts: Pick<ControlArtifactStore, 'readVerifiedBoundJson'>;
  planner: Pick<ReportEditorialPlanner, 'plan'>;
  validator?: Pick<
    SchemaValidator,
    'validateFile' | 'validateFileOrThrow' | 'validateOrThrow' | 'validateSchemaOrThrow'
  >;
  modelTelemetry: () => {
    structuredCallCount: number;
    receiptCount: number;
    candidateCaptured: boolean;
    lastStructuredCandidate?: unknown;
    provider: string;
    providerMode: LLMProviderIdentity['mode'];
    requestedModel: string;
    actualModel?: string;
    receipt?: {
      id: string;
      stage: string;
      status: 'succeeded' | 'failed';
      provider: string;
      requestedModel: string;
      actualModel: string;
      promptHash: string;
      contextManifestHash?: string;
      tokenUsage?: { prompt: number; completion: number; total: number };
      failureKind?: string;
    };
  };
}

export interface ReportEditorialCandidateDiagnostic {
  version: 'report-editorial-candidate-diagnostic-v1';
  code: 'model_blueprint_rejected';
  fallbackReasonCode: string;
  candidateCaptured: boolean;
  stages: Array<{
    stage: 'schema' | 'allowed_presentations' | 'integrity';
    status: 'passed' | 'failed' | 'not_run';
    issueCount: number;
    issues: string[];
  }>;
}

export class ReportEditorialAcceptanceGateError extends Error {
  constructor(readonly diagnostic: ReportEditorialCandidateDiagnostic) {
    super(`A-model acceptance rejected fallback ${diagnostic.fallbackReasonCode}`);
    this.name = 'ReportEditorialAcceptanceGateError';
  }
}

export interface ReportEditorialAcceptanceInput {
  attemptDir: string;
  outputDir: string;
  expectedModel: string;
  requireModelResult?: boolean;
  runKind?: ReportEditorialAcceptanceRunKind;
  enableEditorialShowcase?: boolean;
}

export type ReportEditorialAcceptanceRunKind = 'model_acceptance' | 'fixture_reprojection';

interface SetComparison {
  equal: boolean;
  modelCount: number;
  deterministicCount: number;
  missingFromModel: string[];
  unexpectedInModel: string[];
}

export interface ReportEditorialAcceptanceSummary {
  version: 'report-editorial-acceptance-summary-v1';
  runKind: ReportEditorialAcceptanceRunKind;
  modelAcceptanceEligible: boolean;
  binding: ArtifactBinding;
  sourceArtifacts: {
    deliverable: SourceArtifactSummary;
    review: SourceArtifactSummary;
    contributionLedger?: SourceArtifactSummary;
    evidenceManifest: SourceArtifactSummary;
    referencedEvidenceArtifacts: SourceArtifactSummary[];
  };
  sourceAttempt: {
    writePolicy: 'read_only';
    inputsReverifiedAfterGeneration: true;
    snapshot: {
      fileCount: number;
      manifestSha256: string;
      files: Array<{
        relativePath: string;
        contentSha256: string;
        byteSize: number;
      }>;
      unchanged: true;
    };
  };
  material: {
    presentationUnitCount: number;
    leafUnitCount: number;
    presentationCountByShape: Record<string, number>;
    auditRecordCount: number;
  };
  planner: {
    invocationCount: 1;
    resultMode: ReportEditorialPlanResult['mode'] | 'fixture_reprojection';
    selectedBlueprint: {
      fileName: 'selected-blueprint.json';
      source: 'model' | 'deterministic_fallback' | 'fixture_reprojection';
    };
    copy: {
      acceptedFragmentCount: number;
      rejectedFragmentCount: number;
      outputMode: ReportDocumentV4['copyMode'];
    };
    fallbackReasonCode?: string;
    expectedModel: string;
    structuredModelCallCount?: number;
    receiptCount?: number;
    provider?: string;
    providerMode?: LLMProviderIdentity['mode'];
    requestedModel?: string;
    actualModel?: string;
    receipt?: {
      id: string;
      stage: string;
      status: 'succeeded' | 'failed';
      provider: string;
      requestedModel: string;
      actualModel: string;
      promptHash: string;
      contextManifestHash?: string;
      tokenUsage?: { prompt: number; completion: number; total: number };
      failureKind?: string;
    };
    diagnostics: ReportEditorialPlanResult['diagnostics'];
  };
  deterministicComparison: {
    presentationUnits: SetComparison;
    leafUnits: SetComparison;
    auditRecords: SetComparison;
    traceByLeafId: {
      leafCount: number;
      modelMatchesDeterministic: true;
      modelMatchesMaterial: true;
    };
    actionPriorities: {
      actionCount: number;
      modelMatchesMaterial: true;
      deterministicMatchesMaterial: true;
    };
  };
  renderer: {
    version: string;
    semanticManifestMatchesDocument: true;
  };
  showcase?: {
    generationMode: EditorialPresentationSpecV1['generationMode'];
    profileId: EditorialPresentationSpecV1['profileId'];
    showcaseOutlineSignature: string;
    sectionCount: number;
    componentCount: number;
    rendererVersion: string;
    specFileName: 'editorial-presentation-spec.json';
    htmlFileName: 'editorial-showcase.html';
  };
  outputs: Record<string, {
    fileName: string;
    contentSha256: string;
    byteSize: number;
  }>;
}

interface CliOptions {
  attemptDir: string;
  outputDir: string;
  requestedModel: string;
  mockBlueprintPath?: string;
  enableEditorialShowcase: boolean;
}

interface AttemptFileSnapshot {
  fileCount: number;
  manifestSha256: string;
  files: Array<{
    relativePath: string;
    contentSha256: string;
    byteSize: number;
  }>;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonBlank(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
  return value;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function snapshotAttemptDirectory(attemptDir: string): Promise<AttemptFileSnapshot> {
  const files: AttemptFileSnapshot['files'] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`historical Attempt snapshot refuses symbolic link ${relative(attemptDir, path)}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`historical Attempt snapshot refuses non-regular file ${relative(attemptDir, path)}`);
      }
      const bytes = await readFile(path);
      files.push({
        relativePath: relative(attemptDir, path).split(sep).join('/'),
        contentSha256: sha256(bytes),
        byteSize: bytes.byteLength,
      });
    }
  };
  await visit(attemptDir);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return {
    fileCount: files.length,
    manifestSha256: sha256(JSON.stringify(files)),
    files,
  };
}

function assertAttemptSnapshotUnchanged(
  before: AttemptFileSnapshot,
  after: AttemptFileSnapshot,
): void {
  if (
    before.fileCount !== after.fileCount
    || before.manifestSha256 !== after.manifestSha256
    || JSON.stringify(before.files) !== JSON.stringify(after.files)
  ) {
    throw new Error('historical Attempt changed while the editorial acceptance run was executing');
  }
}

async function resolveAttemptLayout(attemptDir: string): Promise<AttemptLayout> {
  if (!isAbsolute(attemptDir)) throw new Error('--attempt-dir must be an absolute path');
  const resolvedAttemptDir = await realpath(attemptDir);
  if (!(await stat(resolvedAttemptDir)).isDirectory()) throw new Error('--attempt-dir must be a directory');
  const attemptId = basename(resolvedAttemptDir);
  const attemptsDir = dirname(resolvedAttemptDir);
  const taskDir = dirname(attemptsDir);
  const tasksDir = dirname(taskDir);
  if (basename(attemptsDir) !== 'attempts' || basename(tasksDir) !== 'tasks') {
    throw new Error('--attempt-dir must match <workspace-root>/tasks/<task-id>/attempts/<attempt-id>');
  }
  return {
    attemptDir: resolvedAttemptDir,
    workspaceRoot: dirname(tasksDir),
    taskId: assertNonBlank(basename(taskDir), 'Task id'),
    planVersionId: '',
    attemptId: assertNonBlank(attemptId, 'Attempt id'),
  };
}

async function resolveOutputTarget(attemptDir: string, outputDir: string): Promise<string> {
  if (!isAbsolute(outputDir)) throw new Error('--output-dir must be an absolute path');
  const target = resolve(outputDir);
  try {
    await lstat(target);
    throw new Error('--output-dir must not already exist');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parent = await realpath(dirname(target));
  const resolvedTarget = join(parent, basename(target));
  if (isWithin(attemptDir, resolvedTarget) || isWithin(resolvedTarget, attemptDir)) {
    throw new Error('--output-dir must be independent from the historical Attempt directory');
  }
  return resolvedTarget;
}

function assertArtifactMetadata(
  artifact: ControlArtifact,
  binding: ArtifactBinding,
  expectedPath: string,
  expected: { kind: string; schemaVersion: string | readonly string[] },
): asserts artifact is ControlArtifact & { contentSha256: string; byteSize: number } {
  const allowedSchemaVersions = Array.isArray(expected.schemaVersion)
    ? expected.schemaVersion
    : [expected.schemaVersion];
  if (
    artifact.state !== 'SEALED'
    || artifact.taskId !== binding.taskId
    || artifact.planVersionId !== binding.planVersionId
    || artifact.attemptId !== binding.attemptId
    || artifact.kind !== expected.kind
    || !allowedSchemaVersions.includes(artifact.schemaVersion)
    || resolve(artifact.storageUri) !== expectedPath
    || !/^sha256:[a-f0-9]{64}$/u.test(artifact.contentSha256 ?? '')
    || artifact.byteSize === null
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 0
  ) {
    throw new Error(`${expectedPath} is not one SEALED Artifact with the expected Task, Plan, Attempt, kind, schema, hash, and byte size`);
  }
}

function evidenceArtifactKind(kind: EvidenceEntry['kind']): string {
  switch (kind) {
    case 'tool_output': return 'tool_output';
    case 'knowledge_excerpt': return 'knowledge_output';
    case 'screenshot': return 'visual_asset_manifest';
    case 'user_constraint': return 'chart_data';
  }
}

function assertEvidenceManifest(value: unknown): asserts value is EvidenceManifest {
  if (
    !isRecord(value)
    || value.version !== 'evidence-v1'
    || typeof value.taskId !== 'string'
    || typeof value.planVersionId !== 'string'
    || typeof value.attemptId !== 'string'
    || !Array.isArray(value.entries)
  ) {
    throw new Error('evidence/manifest.json must be an evidence-v1 Manifest');
  }
}

function assertReferencedEvidenceArtifact(
  verified: VerifiedArtifactValue<unknown>,
  entry: EvidenceEntry,
  layout: AttemptLayout,
): void {
  const { artifact } = verified;
  if (
    artifact.id !== entry.artifactId
    || artifact.state !== 'SEALED'
    || artifact.taskId !== layout.taskId
    || artifact.planVersionId !== layout.planVersionId
    || artifact.attemptId !== layout.attemptId
    || artifact.kind !== evidenceArtifactKind(entry.kind)
    || artifact.contentSha256 !== entry.artifactContentSha256
    || artifact.byteSize === null
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 0
    || !isWithin(layout.attemptDir, resolve(artifact.storageUri))
  ) {
    throw new Error(`Evidence ${entry.id} Artifact ${entry.artifactId} has an invalid binding, kind, hash, size, or storage path`);
  }
}

async function readReferencedEvidenceArtifacts(input: {
  layout: AttemptLayout;
  manifest: EvidenceManifest;
  artifacts: ReportEditorialAcceptanceDependencies['artifacts'];
}): Promise<Map<string, VerifiedArtifactValue<unknown>>> {
  const resolved = new Map<string, VerifiedArtifactValue<unknown>>();
  for (const entry of input.manifest.entries) {
    let verified = resolved.get(entry.artifactId);
    if (!verified) {
      verified = await input.artifacts.readVerifiedBoundJson<unknown>(entry.artifactId);
      resolved.set(entry.artifactId, verified);
    }
    assertReferencedEvidenceArtifact(verified, entry, input.layout);
  }
  return resolved;
}

function evidenceResolver(
  artifacts: ReadonlyMap<string, VerifiedArtifactValue<unknown>>,
): EvidenceArtifactResolver {
  return {
    resolveArtifact(artifactId): ResolvedEvidenceArtifact | null {
      const resolved = artifacts.get(artifactId);
      if (!resolved?.artifact.contentSha256) return null;
      return {
        artifact: {
          id: resolved.artifact.id,
          contentSha256: resolved.artifact.contentSha256,
        },
        value: resolved.value,
      };
    },
  };
}

async function resolveDataClassification(input: {
  repository: ReportEditorialAcceptanceDependencies['repository'];
  taskId: string;
  manifest: EvidenceManifest;
}): Promise<ReportEditorialPlannerDataClassification> {
  const task = await input.repository.getTaskDetail(input.taskId);
  const structured = task?.structuredTask;
  if (!task || !isRecord(structured) || structured.version !== 'research-task-v2') {
    throw new Error(`Task ${input.taskId} has no structured data classification`);
  }
  const sensitivity = structured.sensitivity;
  if (
    sensitivity !== 'public'
    && sensitivity !== 'internal'
    && sensitivity !== 'confidential'
  ) {
    throw new Error(`Task ${input.taskId} has an invalid sensitivity classification`);
  }
  if (typeof structured.pii_detected !== 'boolean') {
    throw new Error(`Task ${input.taskId} has no PII classification`);
  }
  return {
    taskSensitivity: sensitivity,
    piiDetected: structured.pii_detected,
    hasSensitiveOrBlockedEvidence: input.manifest.entries.some(
      (entry) => entry.sensitivity === 'sensitive' || entry.redaction === 'blocked',
    ),
  };
}

async function readInputArtifact<T>(input: {
  layout: AttemptLayout;
  relativePath: string;
  kind: string;
  schemaVersion: string | readonly string[];
  repository: ReportEditorialAcceptanceDependencies['repository'];
  artifacts: ReportEditorialAcceptanceDependencies['artifacts'];
}): Promise<VerifiedArtifactValue<T>> {
  const expectedPath = join(input.layout.attemptDir, input.relativePath);
  const rows = await input.repository.listArtifactsByStorageUri(expectedPath);
  const sealed = rows.filter(({ state }) => state === 'SEALED');
  if (sealed.length !== 1) {
    throw new Error(`${input.relativePath} must resolve to exactly one SEALED Artifact, received ${sealed.length}`);
  }
  const selected = sealed[0]!;
  if (!input.layout.planVersionId) {
    input.layout.planVersionId = assertNonBlank(
      selected.planVersionId ?? '',
      'Deliverable Artifact plan version id',
    );
  }
  assertArtifactMetadata(selected, input.layout, expectedPath, input);
  const verified = await input.artifacts.readVerifiedBoundJson<T>(selected.id);
  if (verified.artifact.id !== selected.id) {
    throw new Error(`${input.relativePath} verification returned a different Artifact`);
  }
  assertArtifactMetadata(verified.artifact, input.layout, expectedPath, input);
  return verified;
}

async function readOptionalInputArtifact<T>(input: {
  layout: AttemptLayout;
  relativePath: string;
  kind: string;
  schemaVersion: string | readonly string[];
  repository: ReportEditorialAcceptanceDependencies['repository'];
  artifacts: ReportEditorialAcceptanceDependencies['artifacts'];
}): Promise<VerifiedArtifactValue<T> | undefined> {
  const expectedPath = join(input.layout.attemptDir, input.relativePath);
  const rows = await input.repository.listArtifactsByStorageUri(expectedPath);
  const sealed = rows.filter(({ state }) => state === 'SEALED');
  if (sealed.length === 0 && rows.length === 0) return undefined;
  if (sealed.length !== 1) {
    throw new Error(`${input.relativePath} must resolve to zero or one SEALED Artifact, received ${sealed.length}`);
  }
  const selected = sealed[0]!;
  assertArtifactMetadata(selected, input.layout, expectedPath, input);
  const verified = await input.artifacts.readVerifiedBoundJson<T>(selected.id);
  if (verified.artifact.id !== selected.id) {
    throw new Error(`${input.relativePath} verification returned a different Artifact`);
  }
  assertArtifactMetadata(verified.artifact, input.layout, expectedPath, input);
  return verified;
}

type SupportedEditorialDeliverable =
  | ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2>
  | ResearchDeliverableEnvelope<ResearchPlanPayload>;

function assertSupportedEditorialDeliverable(
  value: unknown,
  validator: ReportEditorialAcceptanceDependencies['validator'],
): asserts value is SupportedEditorialDeliverable {
  if (
    !isRecord(value)
    || value.version !== 'research-deliverable-v1'
    || (value.deliverableType !== 'research_strategy_report' && value.deliverableType !== 'research_plan')
    || !isRecord(value.payload)
    || !isRecord(value.coverage)
    || !Array.isArray(value.coverage.questionBindings)
  ) {
    throw new Error('final-r0.json must be a supported reviewed Deliverable with coverage');
  }
  if (
    value.deliverableType === 'research_strategy_report'
    && value.payload.schemaVersion !== 'research-strategy-content-v2'
  ) {
    throw new Error('research_strategy_report acceptance requires Content v2');
  }
  const contract = resolveDeliverableContractById(value.deliverableType);
  const payloadSchema = selectReadablePayloadSchema(contract, value.payload);
  validator?.validateSchemaOrThrow(
    payloadSchema.schema,
    value.payload,
    `${value.deliverableType} payload`,
  );
}

function requiredQuestionIds(
  deliverable: SupportedEditorialDeliverable,
): string[] {
  const ids = deliverable.coverage.questionBindings.map(({ questionId }) => questionId);
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length || ids.length === 0) {
    throw new Error('Deliverable coverage must contain unique non-empty required question ids');
  }
  return ids;
}

function fallbackNotices(plan: ReportEditorialPlanResult): ReportNoticeV1[] {
  if (plan.mode !== 'fallback') return [];
  return [{
    id: plan.reasonCode === 'data_policy_denied'
      ? 'notice-data-policy-fallback'
      : 'notice-layout-fallback',
    code: plan.reasonCode === 'data_policy_denied'
      ? 'data_policy_fallback'
      : 'layout_fallback',
    severity: 'info',
    scope: 'report',
    relatedUnitIds: [],
  }];
}

function compareSets(model: readonly string[], deterministic: readonly string[]): SetComparison {
  const modelSet = new Set(model);
  const deterministicSet = new Set(deterministic);
  const missingFromModel = [...deterministicSet].filter((id) => !modelSet.has(id)).sort();
  const unexpectedInModel = [...modelSet].filter((id) => !deterministicSet.has(id)).sort();
  return {
    equal: missingFromModel.length === 0 && unexpectedInModel.length === 0,
    modelCount: modelSet.size,
    deterministicCount: deterministicSet.size,
    missingFromModel,
    unexpectedInModel,
  };
}

function assertSemanticComparison(
  comparison: Pick<
    ReportEditorialAcceptanceSummary['deterministicComparison'],
    'presentationUnits' | 'leafUnits' | 'auditRecords'
  >,
): void {
  if (!comparison.presentationUnits.equal || !comparison.leafUnits.equal || !comparison.auditRecords.equal) {
    throw new Error('model and deterministic projections do not preserve the same presentation, leaf, and audit sets');
  }
}

function expectedTraceIndex(material: ReportEditorialMaterialV1): ReportDocumentV4['traceIndex'] {
  return Object.fromEntries(material.constraints.requiredLeafUnitIds.map((leafId) => {
    const trace = material.leafTraceIndex[leafId];
    if (!trace) throw new Error(`Material leaf ${leafId} has no trace`);
    return [leafId, {
      supportMode: trace.supportMode,
      origins: trace.origins.map((origin) => ({
        ...origin,
        sourceNodeIds: [...origin.sourceNodeIds],
      })),
      questionIds: [...trace.support.questionIds],
      evidenceIds: [...trace.support.evidenceIds],
      findingIds: [...trace.support.findingIds],
      summaryIds: [...trace.support.summaryIds],
      ...(trace.support.status === undefined ? {} : { status: trace.support.status }),
      ...(trace.support.confidence === undefined ? {} : { confidence: trace.support.confidence }),
    }];
  }));
}

type ActionPriority = 'P0' | 'P1' | 'P2' | null;

function materialActionPriorities(material: ReportEditorialMaterialV1): Map<string, ActionPriority> {
  return new Map(material.presentationUnits.flatMap((unit) => unit.shape === 'actions'
    ? unit.actions.map(({ leafId, priority }) => [leafId, priority ?? null] as const)
    : []));
}

function reportActionPriorities(
  document: ReportDocumentV4,
  expectedLeafIds: ReadonlySet<string>,
): Map<string, ActionPriority> {
  const priorities = new Map<string, ActionPriority>();
  const add = (leafId: string, priority: unknown): void => {
    if (!expectedLeafIds.has(leafId)) return;
    if (priority !== null && priority !== undefined && priority !== 'P0' && priority !== 'P1' && priority !== 'P2') {
      throw new Error(`Report action ${leafId} has invalid priority`);
    }
    const normalized = priority ?? null;
    if (priorities.has(leafId) && priorities.get(leafId) !== normalized) {
      throw new Error(`Report action ${leafId} has conflicting priorities`);
    }
    priorities.set(leafId, normalized);
  };
  for (const block of document.sections.flatMap(({ blocks }) => blocks)) {
    if (block.type === 'priority-board') {
      for (const group of block.groups) {
        for (const item of group.items) add(item.leafRef, group.priority);
      }
    } else if (block.type === 'record-table') {
      for (const row of block.rows) {
        const actionCell = row.cells.find(({ leafRef }) => expectedLeafIds.has(leafRef));
        const priorityCell = row.cells.find(({ columnKey }) => columnKey === 'priority');
        if (actionCell) add(actionCell.leafRef, priorityCell?.value);
      }
    } else if (block.type === 'list' || block.type === 'answer') {
      for (const item of block.items) add(item.leafRef, item.label);
    }
  }
  return priorities;
}

function mapEntries(map: ReadonlyMap<string, ActionPriority>): Array<[string, ActionPriority]> {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
}

function assertFidelity(input: {
  material: ReportEditorialMaterialV1;
  modelDocument: ReportDocumentV4;
  deterministicDocument: ReportDocumentV4;
}): Pick<ReportEditorialAcceptanceSummary['deterministicComparison'], 'traceByLeafId' | 'actionPriorities'> {
  const expectedTrace = expectedTraceIndex(input.material);
  if (!isDeepStrictEqual(input.modelDocument.traceIndex, input.deterministicDocument.traceIndex)) {
    throw new Error('model and deterministic projections have different leaf trace indexes');
  }
  if (!isDeepStrictEqual(input.modelDocument.traceIndex, expectedTrace)) {
    throw new Error('projected leaf trace index does not preserve Material support and provenance');
  }
  const sourcePriorities = materialActionPriorities(input.material);
  const expectedLeaves = new Set(sourcePriorities.keys());
  const modelPriorities = reportActionPriorities(input.modelDocument, expectedLeaves);
  const deterministicPriorities = reportActionPriorities(input.deterministicDocument, expectedLeaves);
  if (!isDeepStrictEqual(mapEntries(modelPriorities), mapEntries(sourcePriorities))) {
    throw new Error('model projection changed or omitted a source action priority');
  }
  if (!isDeepStrictEqual(mapEntries(deterministicPriorities), mapEntries(sourcePriorities))) {
    throw new Error('deterministic projection changed or omitted a source action priority');
  }
  return {
    traceByLeafId: {
      leafCount: Object.keys(expectedTrace).length,
      modelMatchesDeterministic: true,
      modelMatchesMaterial: true,
    },
    actionPriorities: {
      actionCount: sourcePriorities.size,
      modelMatchesMaterial: true,
      deterministicMatchesMaterial: true,
    },
  };
}

function candidateDiagnostic(input: {
  material: ReportEditorialMaterialV1;
  candidateCaptured: boolean;
  candidate: unknown;
  fallbackReasonCode: string;
  validator: Pick<SchemaValidator, 'validateFile'>;
  enableEditorialShowcase?: boolean;
}): ReportEditorialCandidateDiagnostic {
  const stages: ReportEditorialCandidateDiagnostic['stages'] = [];
  const notRun = (stage: 'schema' | 'allowed_presentations' | 'integrity'): void => {
    stages.push({ stage, status: 'not_run', issueCount: 0, issues: [] });
  };
  if (!input.candidateCaptured) {
    notRun('schema');
    notRun('allowed_presentations');
    notRun('integrity');
    return {
      version: 'report-editorial-candidate-diagnostic-v1',
      code: 'model_blueprint_rejected',
      fallbackReasonCode: input.fallbackReasonCode,
      candidateCaptured: false,
      stages,
    };
  }

  const schemaErrors = input.validator.validateFile(
    input.enableEditorialShowcase ? INTENT_V2_SCHEMA_PATH : INTENT_V1_SCHEMA_PATH,
    input.candidate,
  );
  if (schemaErrors.length > 0) {
    stages.push({
      stage: 'schema',
      status: 'failed',
      issueCount: schemaErrors.length,
      issues: schemaErrors.slice(0, 20).map((issue) => issue.slice(0, 240)),
    });
    notRun('allowed_presentations');
    notRun('integrity');
  } else {
    stages.push({ stage: 'schema', status: 'passed', issueCount: 0, issues: [] });
    try {
      const candidate = input.candidate as ReportEditorialIntentV1 | ReportEditorialIntentV2;
      const reportIntent: ReportEditorialIntentV1 = candidate.version === 'report-editorial-intent-v2'
        ? {
            version: 'report-editorial-intent-v1',
            style: candidate.style,
            density: candidate.density,
            mainSections: candidate.mainSections,
            copyFragments: candidate.copyFragments,
          }
        : candidate;
      const compiled = compileReportEditorialIntent(input.material, reportIntent);
      assertReportEditorialModelPresentationsEnabled(
        buildReportEditorialPlannerInputV1(input.material),
        compiled.blueprint,
      );
      if (input.enableEditorialShowcase && candidate.version === 'report-editorial-intent-v2') {
        compileEditorialShowcase(input.material, candidate.showcase, 'model');
      }
      stages.push({
        stage: 'allowed_presentations',
        status: 'passed',
        issueCount: 0,
        issues: [],
      });
      assertReportEditorialBlueprintIntegrity(input.material, compiled.blueprint);
      stages.push({ stage: 'integrity', status: 'passed', issueCount: 0, issues: [] });
    } catch {
      stages.push({
        stage: 'allowed_presentations',
        status: 'not_run',
        issueCount: 0,
        issues: [],
      });
      stages.push({
        stage: 'integrity',
        status: 'failed',
        issueCount: 1,
        issues: ['candidate_failed_intent_compilation'],
      });
    }
  }
  return {
    version: 'report-editorial-candidate-diagnostic-v1',
    code: 'model_blueprint_rejected',
    fallbackReasonCode: input.fallbackReasonCode,
    candidateCaptured: true,
    stages,
  };
}

function artifactSummary(
  verified: VerifiedArtifactValue<unknown>,
  relativePath: string,
): SourceArtifactSummary {
  const { artifact } = verified;
  if (!artifact.contentSha256 || artifact.byteSize === null) {
    throw new Error(`Artifact ${artifact.id} lost its sealed hash or byte size`);
  }
  return {
    id: artifact.id,
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    contentSha256: artifact.contentSha256,
    byteSize: artifact.byteSize,
    relativePath,
  };
}

async function writeOutputDirectory(
  outputDir: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const parent = dirname(outputDir);
  const staging = await mkdtemp(join(parent, `.${basename(outputDir)}-tmp-`));
  try {
    for (const [name, content] of files) {
      await writeFile(join(staging, name), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    await rename(staging, outputDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function runReportEditorialAcceptance(
  input: ReportEditorialAcceptanceInput,
  dependencies: ReportEditorialAcceptanceDependencies,
): Promise<ReportEditorialAcceptanceSummary> {
  const runKind = input.runKind ?? 'model_acceptance';
  const layout = await resolveAttemptLayout(input.attemptDir);
  const outputDir = await resolveOutputTarget(layout.attemptDir, input.outputDir);
  const attemptBefore = await snapshotAttemptDirectory(layout.attemptDir);
  const validator = dependencies.validator ?? new SchemaValidator();

  const deliverableUnknown = await readInputArtifact<unknown>({
    layout,
    ...INPUT_ARTIFACTS.deliverable,
    repository: dependencies.repository,
    artifacts: dependencies.artifacts,
  });
  assertSupportedEditorialDeliverable(deliverableUnknown.value, validator);
  const deliverable = deliverableUnknown as VerifiedArtifactValue<SupportedEditorialDeliverable>;
  assertArtifactMetadata(
    deliverable.artifact,
    layout,
    join(layout.attemptDir, INPUT_ARTIFACTS.deliverable.relativePath),
    INPUT_ARTIFACTS.deliverable,
  );

  const [reviewUnknown, contributionLedgerUnknown, evidenceManifestUnknown] = await Promise.all([
    readInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.review,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    }),
    readOptionalInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.contributionLedger,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    }),
    readInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.evidenceManifest,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    }),
  ]);
  assertValidReportReviewArtifact(reviewUnknown.value, validator);
  if (reviewUnknown.value.verdict !== 'pass') throw new Error('review-r0.json verdict must be pass');
  if (contributionLedgerUnknown) {
    validator.validateOrThrow('contribution-ledger-v1', contributionLedgerUnknown.value);
  }
  const review = reviewUnknown as VerifiedArtifactValue<PassedReportReviewArtifact>;
  const contributionLedger = contributionLedgerUnknown as VerifiedArtifactValue<ContributionLedgerV1> | undefined;
  assertEvidenceManifest(evidenceManifestUnknown.value);
  const evidenceManifest = evidenceManifestUnknown as VerifiedArtifactValue<EvidenceManifest>;
  const evidenceManifestContentSha256 = evidenceManifest.artifact.contentSha256;
  if (!evidenceManifestContentSha256) {
    throw new Error('Evidence Manifest Artifact must have a sealed content hash');
  }
  const referencedEvidenceArtifacts = await readReferencedEvidenceArtifacts({
    layout,
    manifest: evidenceManifest.value,
    artifacts: dependencies.artifacts,
  });
  const resolver = evidenceResolver(referencedEvidenceArtifacts);
  const questionIds = requiredQuestionIds(deliverable.value);
  const deliverableContract = resolveDeliverableContractById(deliverable.value.deliverableType);
  assertReportCompositionInput({
    templateId: deliverableContract.entry.report_template,
    requiredQuestionIds: questionIds,
    deliverable,
    evidenceManifest,
    evidenceArtifactResolver: resolver,
    review,
    visualAssets: [],
    charts: [],
  });
  const dataClassification = await resolveDataClassification({
    repository: dependencies.repository,
    taskId: layout.taskId,
    manifest: evidenceManifest.value,
  });

  const material = deliverable.value.deliverableType === 'research_plan'
    ? buildResearchPlanEditorialMaterialV1({
        ...layout,
        requiredQuestionIds: questionIds,
        deliverable: deliverable as VerifiedArtifactValue<ResearchDeliverableEnvelope<ResearchPlanPayload>>,
        review,
      })
    : buildResearchStrategyEditorialMaterialV1({
        ...layout,
        requiredQuestionIds: questionIds,
        deliverable: deliverable as VerifiedArtifactValue<ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2>>,
        review,
      });
  validator.validateFileOrThrow('schemas/report-editorial-material-v1.schema.json', material);
  const auditAppendix = contributionLedger
    ? buildReportAuditAppendixMaterialV1({ material, contributionLedger })
    : undefined;

  let plannerInvocationCount = 0;
  plannerInvocationCount += 1;
  const plan = await dependencies.planner.plan({
    material,
    attemptId: layout.attemptId,
    stepNo: 13,
    expectedModel: assertNonBlank(input.expectedModel, 'expectedModel'),
    dataClassification,
    enableEditorialCopy: true,
    enableEditorialShowcase: input.enableEditorialShowcase === true,
  });
  if (plannerInvocationCount !== 1) throw new Error('ReportEditorialPlanner must be invoked exactly once');
  const telemetry = dependencies.modelTelemetry();
  if (telemetry.structuredCallCount !== 1) {
    throw new Error(`ReportEditorialPlanner must make exactly one structured model call, received ${telemetry.structuredCallCount}`);
  }
  if (telemetry.receiptCount !== 1) {
    throw new Error(`ReportEditorialPlanner must record exactly one model receipt, received ${telemetry.receiptCount}`);
  }
  if (input.requireModelResult && plan.mode !== 'model') {
    throw new ReportEditorialAcceptanceGateError(candidateDiagnostic({
      material,
      candidateCaptured: telemetry.candidateCaptured,
      candidate: telemetry.lastStructuredCandidate,
      fallbackReasonCode: plan.reasonCode,
      validator,
      enableEditorialShowcase: input.enableEditorialShowcase,
    }));
  }
  if (!telemetry.receipt || telemetry.receipt.id !== plan.diagnostics.receiptId) {
    throw new Error('ReportEditorialPlanner receipt does not match its diagnostics');
  }
  validator.validateFileOrThrow(BLUEPRINT_SCHEMA_PATH, plan.blueprint);
  if (input.enableEditorialShowcase && !plan.showcaseSpec) {
    throw new Error('Showcase-enabled acceptance requires a compiled Editorial Presentation Spec');
  }

  const deterministicBlueprint = createDeterministicReportEditorialIntentCompilation(material).blueprint;
  const modelDocument = projectReportEditorialDocumentV4({
    material,
    blueprint: plan.blueprint,
    editorialCopy: plan.editorialCopy,
    layoutMode: plan.mode,
    auditAppendix,
    ...(plan.mode === 'fallback' ? { notices: fallbackNotices(plan) } : {}),
  });
  const deterministicDocument = projectReportEditorialDocumentV4({
    material,
    blueprint: deterministicBlueprint,
    layoutMode: 'fallback',
    auditAppendix,
  });
  validator.validateOrThrow('report-document', modelDocument);
  validator.validateOrThrow('report-document', deterministicDocument);

  const modelSemantics = collectReportDocumentV4Semantics(modelDocument);
  const deterministicSemantics = collectReportDocumentV4Semantics(deterministicDocument);
  const comparison = {
    presentationUnits: compareSets(
      modelSemantics.presentationUnitIds,
      deterministicSemantics.presentationUnitIds,
    ),
    leafUnits: compareSets(modelSemantics.leafUnitIds, deterministicSemantics.leafUnitIds),
    auditRecords: compareSets(modelSemantics.auditRecordIds, deterministicSemantics.auditRecordIds),
  };
  assertSemanticComparison(comparison);
  const fidelity = assertFidelity({ material, modelDocument, deterministicDocument });

  const reportDocumentJson = json(modelDocument);
  const reportDocumentHash = sha256(reportDocumentJson);
  const rendered = renderStandaloneReport({
    document: modelDocument,
    sourceReportDocumentContentSha256: reportDocumentHash,
  });
  if (!isDeepStrictEqual(rendered.renderManifest.semantics, modelSemantics)) {
    throw new Error('Standalone HTML Render Manifest does not match the projected ReportDocument');
  }
  const contributionBoundShowcaseSpec = plan.showcaseSpec
    ? bindEditorialShowcaseContributions(plan.showcaseSpec, material, auditAppendix)
    : undefined;
  const showcaseSpec = contributionBoundShowcaseSpec
    ? bindEditorialShowcaseEvidenceManifest(contributionBoundShowcaseSpec, {
        artifactId: evidenceManifest.artifact.id,
        contentSha256: evidenceManifestContentSha256,
        manifestHash: evidenceManifest.value.manifestHash,
      })
    : undefined;
  const showcaseSpecJson = showcaseSpec ? json(showcaseSpec) : undefined;
  const showcaseRendered = showcaseSpec && showcaseSpecJson
    ? renderEditorialShowcase({
        material,
        evidenceManifest: evidenceManifest.value,
        evidenceManifestArtifact: {
          id: evidenceManifest.artifact.id,
          contentSha256: evidenceManifestContentSha256,
        },
        spec: showcaseSpec,
        sourceSpecContentSha256: sha256(showcaseSpecJson),
      })
    : undefined;

  await Promise.all([
    readInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.deliverable,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    }),
    readInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.review,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    }),
    ...(contributionLedger ? [readInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.contributionLedger,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    })] : []),
    readInputArtifact<unknown>({
      layout,
      ...INPUT_ARTIFACTS.evidenceManifest,
      repository: dependencies.repository,
      artifacts: dependencies.artifacts,
    }),
  ]);
  await readReferencedEvidenceArtifacts({
    layout,
    manifest: evidenceManifest.value,
    artifacts: dependencies.artifacts,
  });
  const attemptAfter = await snapshotAttemptDirectory(layout.attemptDir);
  assertAttemptSnapshotUnchanged(attemptBefore, attemptAfter);

  const outputContents = new Map<string, string>([
    [OUTPUT_FILES.selectedBlueprint, json(plan.blueprint)],
    [OUTPUT_FILES.deterministicBlueprint, json(deterministicBlueprint)],
    [OUTPUT_FILES.reportDocument, reportDocumentJson],
    [OUTPUT_FILES.deterministicReportDocument, json(deterministicDocument)],
    [OUTPUT_FILES.renderManifest, json(rendered.renderManifest)],
    [OUTPUT_FILES.html, rendered.html],
    ...(showcaseSpecJson && showcaseRendered
      ? [
          [OUTPUT_FILES.showcaseSpec, showcaseSpecJson],
          [OUTPUT_FILES.showcaseHtml, showcaseRendered.html],
        ] as Array<[string, string]>
      : []),
  ]);
  const shapeCounts: Record<string, number> = {};
  for (const unit of material.presentationUnits) {
    shapeCounts[unit.shape] = (shapeCounts[unit.shape] ?? 0) + 1;
  }
  const summary: ReportEditorialAcceptanceSummary = {
    version: 'report-editorial-acceptance-summary-v1',
    runKind,
    modelAcceptanceEligible: runKind === 'model_acceptance'
      && plan.mode === 'model'
      && telemetry.providerMode === 'real'
      && telemetry.receipt?.status === 'succeeded'
      && (!input.enableEditorialShowcase || showcaseSpec?.generationMode === 'model'),
    binding: {
      taskId: layout.taskId,
      planVersionId: layout.planVersionId,
      attemptId: layout.attemptId,
    },
    sourceArtifacts: {
      deliverable: artifactSummary(deliverable, INPUT_ARTIFACTS.deliverable.relativePath),
      review: artifactSummary(review, INPUT_ARTIFACTS.review.relativePath),
      ...(contributionLedger ? {
        contributionLedger: artifactSummary(
          contributionLedger,
          INPUT_ARTIFACTS.contributionLedger.relativePath,
        ),
      } : {}),
      evidenceManifest: artifactSummary(
        evidenceManifest,
        INPUT_ARTIFACTS.evidenceManifest.relativePath,
      ),
      referencedEvidenceArtifacts: [...referencedEvidenceArtifacts.values()]
        .sort((left, right) => left.artifact.id.localeCompare(right.artifact.id, 'en'))
        .map((verified) => artifactSummary(
          verified,
          relative(layout.attemptDir, resolve(verified.artifact.storageUri)).split(sep).join('/'),
        )),
    },
    sourceAttempt: {
      writePolicy: 'read_only',
      inputsReverifiedAfterGeneration: true,
      snapshot: {
        ...attemptAfter,
        unchanged: true,
      },
    },
    material: {
      presentationUnitCount: material.presentationUnits.length,
      leafUnitCount: Object.keys(material.leafTraceIndex).length,
      presentationCountByShape: shapeCounts,
      auditRecordCount: auditAppendix?.records.length ?? 0,
    },
    planner: {
      invocationCount: 1,
      resultMode: plan.mode === 'fallback' ? 'fallback' : runKind === 'fixture_reprojection'
        ? 'fixture_reprojection'
        : 'model',
      selectedBlueprint: {
        fileName: OUTPUT_FILES.selectedBlueprint,
        source: plan.mode === 'fallback' ? 'deterministic_fallback' : runKind === 'fixture_reprojection'
          ? 'fixture_reprojection'
          : 'model',
      },
      copy: {
        acceptedFragmentCount: plan.editorialCopy?.fragments.length ?? 0,
        rejectedFragmentCount: plan.editorialCopy?.rejectedFragments.length ?? 0,
        outputMode: modelDocument.copyMode,
      },
      ...(plan.mode === 'fallback' ? { fallbackReasonCode: plan.reasonCode } : {}),
      expectedModel: input.expectedModel,
      structuredModelCallCount: telemetry.structuredCallCount,
      receiptCount: telemetry.receiptCount,
      provider: telemetry.provider,
      providerMode: telemetry.providerMode,
      requestedModel: telemetry.requestedModel,
      ...(telemetry.actualModel ? { actualModel: telemetry.actualModel } : {}),
      receipt: telemetry.receipt,
      diagnostics: plan.diagnostics,
    },
    deterministicComparison: {
      ...comparison,
      ...fidelity,
    },
    renderer: {
      version: rendered.renderManifest.rendererVersion,
      semanticManifestMatchesDocument: true,
    },
    ...(showcaseSpec && showcaseRendered ? {
      showcase: {
        generationMode: showcaseSpec.generationMode,
        profileId: showcaseSpec.profileId,
        showcaseOutlineSignature: showcaseSpec.showcaseOutlineSignature,
        sectionCount: showcaseSpec.sections.length,
        componentCount: showcaseSpec.sections.reduce((count, section) => count + section.components.length, 0),
        rendererVersion: showcaseRendered.renderManifest.rendererVersion,
        specFileName: OUTPUT_FILES.showcaseSpec,
        htmlFileName: OUTPUT_FILES.showcaseHtml,
      },
    } : {}),
    outputs: Object.fromEntries([...outputContents].map(([fileName, content]) => [fileName, {
      fileName,
      contentSha256: sha256(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
    }])),
  };
  outputContents.set(OUTPUT_FILES.summary, json(summary));
  await writeOutputDirectory(outputDir, outputContents);
  return summary;
}

class TrackedStructuredLlm implements LLMClient {
  structuredCallCount = 0;
  actualModel: string | undefined;
  candidateCaptured = false;
  lastStructuredCandidate: unknown;

  constructor(private readonly delegate: LLMClient) {}

  get identity(): LLMProviderIdentity {
    return this.delegate.identity;
  }

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.structuredCallCount += 1;
    if (this.structuredCallCount > 1) throw new Error('acceptance LLM may be called at most once');
    const result = await this.delegate.generateStructured<T>(options);
    this.actualModel = result.modelName;
    this.candidateCaptured = true;
    this.lastStructuredCandidate = result.data;
    return result;
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    return this.delegate.generateText(options);
  }

  telemetry() {
    return {
      structuredCallCount: this.structuredCallCount,
      candidateCaptured: this.candidateCaptured,
      provider: this.identity.provider,
      providerMode: this.identity.mode,
      requestedModel: this.identity.requestedModel,
      ...(this.actualModel ? { actualModel: this.actualModel } : {}),
      ...(this.candidateCaptured
        ? { lastStructuredCandidate: this.lastStructuredCandidate }
        : {}),
    };
  }
}

class InMemoryModelRecorder implements ModelCallRecorder {
  readonly calls: Array<{ id: string; input: ModelCallRecordInput }> = [];

  async recordModelCall(input: ModelCallRecordInput): Promise<string> {
    const id = `acceptance-receipt-${String(this.calls.length + 1).padStart(3, '0')}`;
    this.calls.push({ id, input });
    return id;
  }

  summary(): ReportEditorialAcceptanceSummary['planner']['receipt'] | undefined {
    const recorded = this.calls[0];
    if (!recorded) return undefined;
    const failureKind = recorded.input.failure
      && typeof recorded.input.failure.kind === 'string'
      ? recorded.input.failure.kind
      : undefined;
    return {
      id: recorded.id,
      stage: recorded.input.stage,
      status: recorded.input.status,
      provider: recorded.input.provider,
      requestedModel: recorded.input.requestedModel,
      actualModel: recorded.input.actualModel,
      promptHash: recorded.input.promptHash,
      ...(recorded.input.contextManifestHash
        ? { contextManifestHash: recorded.input.contextManifestHash }
        : {}),
      ...(recorded.input.tokens ? { tokenUsage: structuredClone(recorded.input.tokens) } : {}),
      ...(failureKind ? { failureKind } : {}),
    };
  }
}

class BlueprintFixtureLlm implements LLMClient {
  readonly identity: LLMProviderIdentity;

  constructor(
    private readonly blueprint: ReportEditorialBlueprintV1,
    requestedModel: string,
  ) {
    this.identity = {
      provider: 'acceptance_fixture',
      endpointHost: 'local',
      requestedModel,
      mode: 'mock',
      eligibleAsReal: false,
    };
  }

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const data: ReportEditorialBlueprintV1 | ReportEditorialIntentV1 = options.schemaName === 'report-editorial-intent-v1'
      ? {
          version: 'report-editorial-intent-v1',
          style: this.blueprint.style,
          density: this.blueprint.density,
          mainSections: this.blueprint.sections.flatMap((section) => (
            section.prominence === 'appendix' ? [] : [{
              headingMode: section.headingMode,
              view: section.view,
              prominence: section.prominence,
              blocks: section.blocks.map((block) => ({
                ...block,
                unitRefs: [...block.unitRefs],
              })),
            }]
          )),
          copyFragments: [],
        }
      : this.blueprint;
    return {
      data: structuredClone(data) as T,
      promptHash: sha256('report-editorial-acceptance-fixture'),
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-v1',
      traceId: 'report-editorial-acceptance-fixture',
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('Blueprint fixture does not support text generation');
  }
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm exec tsx scripts/report-editorial-acceptance.ts \\',
    '    --attempt-dir <absolute-attempt-directory> \\',
    '    --output-dir <new-absolute-output-directory> \\',
    '    --model <requested-model> [--showcase <true|false>] [--mock-blueprint <json-file>]',
  ].join('\n');
}

export function parseReportEditorialAcceptanceArgs(argv: readonly string[]): CliOptions {
  if (argv.includes('--help')) throw new Error(usage());
  const values = new Map<string, string>();
  const allowed = new Set(['--attempt-dir', '--output-dir', '--model', '--mock-blueprint', '--showcase']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid arguments.\n${usage()}`);
    }
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}`);
    values.set(flag, value);
  }
  const attemptDir = values.get('--attempt-dir');
  const outputDir = values.get('--output-dir');
  const requestedModel = values.get('--model') ?? process.env.LLM_MODEL_NAME;
  if (!attemptDir || !outputDir || !requestedModel) throw new Error(usage());
  const mockBlueprintPath = values.get('--mock-blueprint');
  const showcaseValue = values.get('--showcase') ?? 'false';
  if (showcaseValue !== 'true' && showcaseValue !== 'false') {
    throw new Error('--showcase must be true or false');
  }
  const enableEditorialShowcase = showcaseValue === 'true';
  if (enableEditorialShowcase && mockBlueprintPath) {
    throw new Error('--showcase true cannot be combined with --mock-blueprint');
  }
  return {
    attemptDir,
    outputDir,
    requestedModel,
    enableEditorialShowcase,
    ...(mockBlueprintPath ? { mockBlueprintPath } : {}),
  };
}

async function loadBlueprintFixture(path: string): Promise<ReportEditorialBlueprintV1> {
  const value = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  new SchemaValidator().validateFileOrThrow('schemas/report-editorial-blueprint-v1.schema.json', value);
  return value as ReportEditorialBlueprintV1;
}

async function main(): Promise<void> {
  const options = parseReportEditorialAcceptanceArgs(process.argv.slice(2));
  const layout = await resolveAttemptLayout(options.attemptDir);
  const repository = new ControlPlaneRepository(pool);
  const artifacts = new ControlArtifactStore({ root: layout.workspaceRoot, registry: repository });
  const routes = options.mockBlueprintPath
    ? [{ requestedModel: options.requestedModel, expectedActualModel: options.requestedModel }]
    : parseModelRoutes(
        process.env.LLM_MODEL_ROUTES,
        process.env.LLM_MODEL_NAME,
        process.env.LLM_EXPECTED_ACTUAL_MODEL,
      );
  const selectedRoute = routes[0]!;
  const baseLlm = options.mockBlueprintPath
    ? new BlueprintFixtureLlm(
        await loadBlueprintFixture(options.mockBlueprintPath),
        options.requestedModel,
      )
    : new GatewayLLMClient();
  if (baseLlm.identity.requestedModel !== options.requestedModel) {
    throw new Error(`--model must match the configured Gateway requested model (${baseLlm.identity.requestedModel})`);
  }
  const trackedLlm = new TrackedStructuredLlm(baseLlm);
  const receiptRecorder = new InMemoryModelRecorder();
  const receiptLlm = new ReceiptLLMClient(trackedLlm, receiptRecorder);
  const summary = await runReportEditorialAcceptance({
    attemptDir: options.attemptDir,
    outputDir: options.outputDir,
    expectedModel: selectedRoute.expectedActualModel,
    requireModelResult: true,
    runKind: options.mockBlueprintPath ? 'fixture_reprojection' : 'model_acceptance',
    enableEditorialShowcase: options.enableEditorialShowcase,
  }, {
    repository,
    artifacts,
    planner: new ReportEditorialPlanner({
      llm: receiptLlm,
      ...(options.mockBlueprintPath
        ? {}
        : { dataPolicy: productionReportEditorialPlannerDataPolicy }),
    }),
    modelTelemetry: () => {
      const receipt = receiptRecorder.summary();
      return {
        ...trackedLlm.telemetry(),
        receiptCount: receiptRecorder.calls.length,
        ...(receipt ? { receipt } : {}),
      };
    },
  });
  console.log(JSON.stringify(reportEditorialAcceptanceCliResult(summary, options.outputDir)));
}

export function reportEditorialAcceptanceCliResult(
  summary: ReportEditorialAcceptanceSummary,
  outputDir: string,
): Record<string, unknown> {
  return {
    status: 'ok',
    runKind: summary.runKind,
    modelAcceptanceEligible: summary.modelAcceptanceEligible,
    outputDir: resolve(outputDir),
    plannerMode: summary.planner.resultMode,
    ...(summary.showcase ? {
      showcaseEnabled: true,
      showcaseGenerationMode: summary.showcase.generationMode,
      showcaseOutlineSignature: summary.showcase.showcaseOutlineSignature,
    } : {}),
    presentationUnitsEqual: summary.deterministicComparison.presentationUnits.equal,
    leafUnitsEqual: summary.deterministicComparison.leafUnits.equal,
  };
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void main()
    .catch((error) => {
      console.error(error instanceof ReportEditorialAcceptanceGateError
        ? JSON.stringify(error.diagnostic)
        : error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(closePool);
}
