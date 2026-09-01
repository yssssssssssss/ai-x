import { isDeepStrictEqual } from 'node:util';
import type { ControlArtifact } from '../../../../database/control-plane.ts';
import type { VisualAssetReference } from '../../../../packages/api-contract/research-deliverable.ts';
import {
  parseReportPackageV2,
  REPORT_PACKAGE_V2_VERSION,
  type ReportPackageV2,
} from '../../../../packages/api-contract/report-package.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { CurrentReportPackageReader } from './current-report-package-reader.ts';
import {
  type EditorialArtifactReader,
  type EditorialDeliverableType,
  type EditorialSourceBinding,
  type EditorialSourceVerifier,
  type EditorialTaskContext,
  type EditorialTaskReader,
  type FrozenEditorialSource,
  type Sha256,
  type SourceArtifactRef,
} from './editorial-report-contract.ts';
import { resolveDeliverableContractById } from './deliverable-registry.ts';
import {
  parseReportPackageArtifactValue,
  REPORT_PACKAGE_SCHEMA_VERSION,
} from './report-package-artifact.ts';
import {
  type VerifiedVisualAsset,
  VerifiedVisualAssetReader,
} from './visual-asset-service.ts';

const MAX_REPORT_PACKAGE_BYTES = 256 * 1024;
const MAX_JSON_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_ENTRIES = 1_000;
const MAX_EVIDENCE_ARTIFACTS = 400;
const MAX_VISUAL_PAIRS = 24;
const MAX_VISUAL_SOURCE_BYTES = 60 * 1024 * 1024;

const EDITORIAL_DELIVERABLE_TYPES = new Set<EditorialDeliverableType>([
  'research_plan',
  'research_strategy_report',
  'competitive_analysis_report',
  'voc_diagnosis_report',
  'design_audit_report',
  'accessibility_audit_report',
]);

type VerifiedJson<T = unknown> = { artifact: ControlArtifact; value: T };
type VerifiedText = { artifact: ControlArtifact; content: string };

interface EvidenceBudgetEntry {
  artifactId: string;
  kind: string;
}

export class EditorialSourceError extends Error {
  readonly name = 'EditorialSourceError';

  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new EditorialSourceError(code);
}

function isSha256(value: string | null): value is Sha256 {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function artifactRef(artifact: ControlArtifact): SourceArtifactRef {
  if (!isSha256(artifact.contentSha256)) fail('SOURCE_INTEGRITY_INVALID');
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    contentSha256: artifact.contentSha256,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function artifactMetadataMatches(left: ControlArtifact, right: ControlArtifact): boolean {
  return left.id === right.id
    && left.taskId === right.taskId
    && left.planVersionId === right.planVersionId
    && left.attemptId === right.attemptId
    && left.kind === right.kind
    && left.state === right.state
    && left.storageUri === right.storageUri
    && left.contentSha256 === right.contentSha256
    && left.byteSize === right.byteSize
    && left.schemaVersion === right.schemaVersion
    && left.sensitivity === right.sensitivity
    && left.redactionPolicyVersion === right.redactionPolicyVersion
    && left.failureReason === right.failureReason
    && (left.publicationId ?? null) === (right.publicationId ?? null)
    && (left.mediaType ?? null) === (right.mediaType ?? null)
    && isDeepStrictEqual(left.metadata ?? null, right.metadata ?? null);
}

function requireByteSize(artifact: ControlArtifact, maximum: number): number {
  if (
    artifact.byteSize === null
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 0
    || artifact.byteSize > maximum
  ) {
    fail('SOURCE_BUDGET_EXCEEDED');
  }
  return artifact.byteSize;
}

function parseDeliverableType(value: string): EditorialDeliverableType {
  if (!EDITORIAL_DELIVERABLE_TYPES.has(value as EditorialDeliverableType)) {
    fail('EDITORIAL_DELIVERABLE_UNSUPPORTED');
  }
  return value as EditorialDeliverableType;
}

function reportDocumentVisualReferences(value: unknown): VisualAssetReference[] {
  const document = record(value);
  if (!document || !Array.isArray(document.sections)) return [];
  const references: VisualAssetReference[] = [];
  const append = (candidate: unknown): void => {
    const reference = record(candidate);
    if (
      reference
      && typeof reference.assetId === 'string'
      && typeof reference.manifestArtifactId === 'string'
    ) {
      references.push({
        assetId: reference.assetId,
        manifestArtifactId: reference.manifestArtifactId,
      });
    }
  };
  for (const candidate of document.sections) {
    const section = record(candidate);
    if (!section || !Array.isArray(section.blocks)) continue;
    for (const blockCandidate of section.blocks) {
      const block = record(blockCandidate);
      if (!block) continue;
      if (block.type === 'image') append(block.assetRef);
      else if (block.type === 'image-comparison') {
        append(block.beforeAssetRef);
        append(block.afterAssetRef);
      } else if (block.type === 'chart') append(block.chartRef);
    }
  }
  return references;
}

function visualProvenanceArtifactIds(manifestValues: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const value of manifestValues) {
    const manifest = record(value);
    const source = record(manifest?.source);
    if (manifest?.version !== 'visual-asset-manifest-v2' || !source) continue;
    if (source.kind === 'browser_capture' && typeof source.artifactId === 'string') {
      ids.add(source.artifactId);
    } else if (source.kind === 'chart_render' && typeof source.dataArtifactId === 'string') {
      ids.add(source.dataArtifactId);
    }
  }
  return [...ids];
}

function visualReferenceKey(reference: VisualAssetReference): string {
  return `${reference.assetId}\u0000${reference.manifestArtifactId}`;
}

function uniqueVisualReferences(references: readonly VisualAssetReference[]): VisualAssetReference[] {
  const unique = new Map<string, VisualAssetReference>();
  for (const reference of references) {
    const key = visualReferenceKey(reference);
    if (!unique.has(key)) unique.set(key, reference);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, reference]) => reference);
}

function taskContext(input: {
  originalInput: string;
  structuredTask: unknown;
}): EditorialTaskContext | undefined {
  const task = record(input.structuredTask);
  if (
    !task
    || task.version !== 'research-task-v2'
    || typeof task.research_goal !== 'string'
    || !Array.isArray(task.target_audience)
    || !task.target_audience.every((item) => typeof item === 'string')
    || !Array.isArray(task.scope)
    || !task.scope.every((item) => typeof item === 'string')
    || !Array.isArray(task.constraints)
    || !Array.isArray(task.success_criteria)
    || !Array.isArray(task.expected_deliverables)
    || !task.expected_deliverables.every((item) => typeof item === 'string')
    || (task.requested_artifacts !== undefined && !Array.isArray(task.requested_artifacts))
    || (task.sensitivity !== 'public' && task.sensitivity !== 'internal' && task.sensitivity !== 'confidential')
    || typeof task.pii_detected !== 'boolean'
  ) return undefined;
  const statements = (values: unknown[]): string[] | undefined => {
    const result: string[] = [];
    for (const value of values) {
      const item = record(value);
      if (!item || typeof item.statement !== 'string') return undefined;
      result.push(item.statement);
    }
    return result;
  };
  const constraints = statements(task.constraints);
  const successCriteria = statements(task.success_criteria);
  if (!constraints || !successCriteria) return undefined;
  return {
    originalRequest: input.originalInput,
    researchGoal: task.research_goal,
    targetAudience: [...task.target_audience] as string[],
    scope: [...task.scope] as string[],
    constraints,
    successCriteria,
    expectedDeliverables: [...task.expected_deliverables] as string[],
    requestedArtifacts: structuredClone(task.requested_artifacts ?? []),
    sensitivity: task.sensitivity,
    piiDetected: task.pii_detected,
  };
}

function assertReportPackageArtifact(
  artifact: ControlArtifact | null,
  binding: { taskId: string; planVersionId: string; attemptId: string },
  code = 'SOURCE_BINDING_INCOMPLETE',
): asserts artifact is ControlArtifact & { state: 'SEALED'; contentSha256: Sha256 } {
  if (
    !artifact
    || artifact.state !== 'SEALED'
    || artifact.kind !== 'report_package'
    || ![REPORT_PACKAGE_SCHEMA_VERSION, REPORT_PACKAGE_V2_VERSION].includes(artifact.schemaVersion)
    || artifact.taskId !== binding.taskId
    || artifact.planVersionId !== binding.planVersionId
    || artifact.attemptId !== binding.attemptId
    || !isSha256(artifact.contentSha256)
  ) {
    fail(code);
  }
}

class MemoizedEditorialArtifacts implements EditorialArtifactReader {
  private readonly json = new Map<string, Promise<VerifiedJson>>();
  private readonly boundJson = new Map<string, Promise<VerifiedJson>>();
  private readonly boundText = new Map<string, Promise<VerifiedText>>();
  private readonly binary = new Map<string, ReturnType<EditorialArtifactReader['readVerifiedBinary']>>();
  private readonly metadata = new Map<string, Promise<ControlArtifact>>();
  private readonly verified = new Map<string, ControlArtifact>();
  private readonly jsonBudgetIds = new Set<string>();
  private readonly visualBudgetIds = new Set<string>();
  private jsonBytes = 0;
  private visualBytes = 0;

  constructor(
    private readonly repository: EditorialTaskReader,
    private readonly delegate: EditorialArtifactReader,
  ) {}

  seedMetadata(artifact: ControlArtifact): void {
    this.metadata.set(artifact.id, Promise.resolve(artifact));
  }

  private metadataFor(artifactId: string): Promise<ControlArtifact> {
    const cached = this.metadata.get(artifactId);
    if (cached) return cached;
    const pending = this.repository.getArtifact(artifactId).then((artifact) => {
      if (
        !artifact
        || artifact.id !== artifactId
        || artifact.state !== 'SEALED'
        || !isSha256(artifact.contentSha256)
      ) {
        fail('SOURCE_INTEGRITY_INVALID');
      }
      return artifact;
    });
    this.metadata.set(artifactId, pending);
    return pending;
  }

  async preflightJson(
    artifactIds: readonly string[],
    maximum = MAX_JSON_ARTIFACT_BYTES,
  ): Promise<void> {
    const uniqueIds = [...new Set(artifactIds)];
    const metadata = await Promise.all(uniqueIds.map((artifactId) => this.metadataFor(artifactId)));
    let additionalBytes = 0;
    for (const artifact of metadata) {
      const size = requireByteSize(artifact, maximum);
      if (!this.jsonBudgetIds.has(artifact.id)) additionalBytes += size;
    }
    if (this.jsonBytes + additionalBytes > MAX_JSON_SOURCE_BYTES) fail('SOURCE_BUDGET_EXCEEDED');
    for (const artifact of metadata) this.jsonBudgetIds.add(artifact.id);
    this.jsonBytes += additionalBytes;
  }

  async preflightVisual(artifactIds: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(artifactIds)];
    const metadata = await Promise.all(uniqueIds.map((artifactId) => this.metadataFor(artifactId)));
    let additionalBytes = 0;
    for (const artifact of metadata) {
      const size = requireByteSize(artifact, MAX_VISUAL_SOURCE_BYTES);
      if (!this.visualBudgetIds.has(artifact.id)) additionalBytes += size;
    }
    if (this.visualBytes + additionalBytes > MAX_VISUAL_SOURCE_BYTES) fail('SOURCE_BUDGET_EXCEEDED');
    for (const artifact of metadata) this.visualBudgetIds.add(artifact.id);
    this.visualBytes += additionalBytes;
  }

  async preflightBinary(artifactIds: readonly string[]): Promise<void> {
    await this.preflightVisual(artifactIds);
    const metadata = await Promise.all(
      [...new Set(artifactIds)].map((artifactId) => this.metadataFor(artifactId)),
    );
    for (const artifact of metadata) requireByteSize(artifact, 10 * 1024 * 1024);
  }

  private async record(artifactId: string, result: VerifiedJson): Promise<VerifiedJson> {
    const metadata = await this.metadataFor(artifactId);
    if (!artifactMetadataMatches(metadata, result.artifact)) fail('SOURCE_INTEGRITY_INVALID');
    this.verified.set(result.artifact.id, result.artifact);
    return result;
  }

  readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    let pending = this.json.get(artifactId);
    if (!pending) {
      pending = this.preflightJson([artifactId])
        .then(() => this.delegate.readVerifiedJson<unknown>(artifactId))
        .then((result) => this.record(artifactId, result));
      this.json.set(artifactId, pending);
    }
    return pending as Promise<{ artifact: ControlArtifact; value: T }>;
  }

  readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    let pending = this.boundJson.get(artifactId);
    if (!pending) {
      pending = this.preflightJson([artifactId])
        .then(() => this.delegate.readVerifiedBoundJson<unknown>(artifactId))
        .then((result) => this.record(artifactId, result));
      this.boundJson.set(artifactId, pending);
    }
    return pending as Promise<{ artifact: ControlArtifact; value: T }>;
  }

  readVerifiedBoundText(artifactId: string): Promise<VerifiedText> {
    let pending = this.boundText.get(artifactId);
    if (!pending) {
      pending = this.preflightJson([artifactId])
        .then(async () => {
          const delegate = this.delegate as EditorialArtifactReader & {
            readVerifiedBoundText?: (id: string) => Promise<VerifiedText>;
          };
          if (!delegate.readVerifiedBoundText) fail('SOURCE_INTEGRITY_INVALID');
          const result = await delegate.readVerifiedBoundText(artifactId);
          const metadata = await this.metadataFor(artifactId);
          if (!artifactMetadataMatches(metadata, result.artifact)) fail('SOURCE_INTEGRITY_INVALID');
          this.verified.set(result.artifact.id, result.artifact);
          return result;
        });
      this.boundText.set(artifactId, pending);
    }
    return pending;
  }

  readVerifiedBinary(artifactId: string): ReturnType<EditorialArtifactReader['readVerifiedBinary']> {
    let pending = this.binary.get(artifactId);
    if (!pending) {
      pending = this.preflightBinary([artifactId])
        .then(() => this.delegate.readVerifiedBinary(artifactId))
        .then(async (result) => {
          const metadata = await this.metadataFor(artifactId);
          if (
            !artifactMetadataMatches(metadata, result.artifact)
            || result.bytes.byteLength !== metadata.byteSize
            || result.metadata.byteSize !== metadata.byteSize
          ) {
            fail('SOURCE_INTEGRITY_INVALID');
          }
          this.verified.set(artifactId, result.artifact);
          return result;
        });
      this.binary.set(artifactId, pending);
    }
    return pending;
  }

  sourceArtifacts(): SourceArtifactRef[] {
    return [...this.verified.values()]
      .map(artifactRef)
      .sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0);
  }

  sourcePolicyMetadata(): FrozenEditorialSource['sourcePolicyMetadata'] {
    return [...this.verified.values()]
      .map((artifact) => {
        if (!isSha256(artifact.contentSha256)) fail('SOURCE_INTEGRITY_INVALID');
        return {
          artifactId: artifact.id,
          contentSha256: artifact.contentSha256,
          sensitivity: artifact.sensitivity,
          redactionPolicyVersion: artifact.redactionPolicyVersion,
        };
      })
      .sort((left, right) => {
        const a = `${left.artifactId}\u0000${left.contentSha256}\u0000${left.sensitivity}\u0000${left.redactionPolicyVersion}`;
        const b = `${right.artifactId}\u0000${right.contentSha256}\u0000${right.sensitivity}\u0000${right.redactionPolicyVersion}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
  }
}

export class EditorialSourceReader implements EditorialSourceVerifier {
  private readonly schemaValidator: SchemaValidator;
  private readonly repository: EditorialTaskReader;
  private readonly artifacts: EditorialArtifactReader;

  constructor(dependencies: {
    repository?: EditorialTaskReader;
    tasks?: EditorialTaskReader;
    artifacts: EditorialArtifactReader;
    schemaValidator?: SchemaValidator;
  }) {
    const repository = dependencies.repository ?? dependencies.tasks;
    if (!repository) throw new TypeError('EditorialSourceReader requires a task reader');
    this.repository = repository;
    this.artifacts = dependencies.artifacts;
    this.schemaValidator = dependencies.schemaValidator ?? new SchemaValidator();
  }

  private async currentBinding(taskId: string): Promise<{
    binding: EditorialSourceBinding;
    taskContext?: EditorialTaskContext;
    reportPackageArtifact: ControlArtifact & { state: 'SEALED'; contentSha256: Sha256 };
  }> {
    const initialTask = await this.repository.getTaskDetail(taskId);
    if (!initialTask) fail('EDITORIAL_TASK_NOT_FOUND');
    if (initialTask.state !== 'completed' && initialTask.state !== 'completed_with_gaps') {
      fail('SOURCE_NOT_COMPLETED');
    }
    if (
      !Number.isSafeInteger(initialTask.stateVersion)
      || initialTask.stateVersion < 0
      || !initialTask.activePlanVersionId
      || !initialTask.currentAttemptId
    ) {
      fail('SOURCE_BINDING_INCOMPLETE');
    }
    const selectedPackage = await this.repository.findSealedArtifact({
      taskId,
      attemptId: initialTask.currentAttemptId,
      kind: 'report_package',
    });
    const packageBinding = {
      taskId,
      planVersionId: initialTask.activePlanVersionId,
      attemptId: initialTask.currentAttemptId,
    };
    assertReportPackageArtifact(selectedPackage, packageBinding);
    const reportPackageArtifact = await this.repository.getArtifact(selectedPackage.id);
    assertReportPackageArtifact(reportPackageArtifact, packageBinding);
    if (!artifactMetadataMatches(selectedPackage, reportPackageArtifact)) {
      fail('SOURCE_BINDING_INCOMPLETE');
    }
    requireByteSize(reportPackageArtifact, MAX_REPORT_PACKAGE_BYTES);
    const finalTask = await this.repository.getTaskDetail(taskId);
    if (
      !finalTask
      || finalTask.state !== initialTask.state
      || finalTask.stateVersion !== initialTask.stateVersion
      || finalTask.activePlanVersionId !== initialTask.activePlanVersionId
      || finalTask.currentAttemptId !== initialTask.currentAttemptId
    ) {
      fail('SOURCE_BINDING_CHANGED');
    }
    const frozenTaskContext = taskContext({
      originalInput: initialTask.originalInput,
      structuredTask: initialTask.structuredTask,
    });
    return {
      binding: {
        taskId,
        taskState: initialTask.state,
        taskStateVersion: initialTask.stateVersion,
        planVersionId: initialTask.activePlanVersionId,
        attemptId: initialTask.currentAttemptId,
        reportPackageArtifactId: reportPackageArtifact.id,
        reportPackageContentSha256: reportPackageArtifact.contentSha256,
      },
      ...(frozenTaskContext === undefined ? {} : { taskContext: frozenTaskContext }),
      reportPackageArtifact,
    };
  }

  async assertStillCurrent(expected: EditorialSourceBinding): Promise<void> {
    let binding: EditorialSourceBinding;
    try {
      ({ binding } = await this.currentBinding(expected.taskId));
    } catch {
      fail('SOURCE_BINDING_CHANGED');
    }
    if (
      binding.taskState !== expected.taskState
      || binding.taskStateVersion !== expected.taskStateVersion
      || binding.planVersionId !== expected.planVersionId
      || binding.attemptId !== expected.attemptId
      || binding.reportPackageArtifactId !== expected.reportPackageArtifactId
      || binding.reportPackageContentSha256 !== expected.reportPackageContentSha256
    ) {
      fail('SOURCE_BINDING_CHANGED');
    }
  }

  async readCurrent(taskId: string): Promise<FrozenEditorialSource> {
    const { binding, taskContext: frozenTaskContext, reportPackageArtifact } = await this.currentBinding(taskId);
    const artifacts = new MemoizedEditorialArtifacts(
      this.repository,
      this.artifacts,
    );
    artifacts.seedMetadata(reportPackageArtifact);
    await artifacts.preflightJson([binding.reportPackageArtifactId], MAX_REPORT_PACKAGE_BYTES);
    const frozenPackage = await artifacts.readVerifiedBoundJson<unknown>(binding.reportPackageArtifactId);
    assertReportPackageArtifact(frozenPackage.artifact, binding, 'SOURCE_INTEGRITY_INVALID');
    if (!artifactMetadataMatches(reportPackageArtifact, frozenPackage.artifact)) {
      fail('SOURCE_INTEGRITY_INVALID');
    }
    let reportPackage: ReturnType<typeof parseReportPackageArtifactValue> | ReportPackageV2;
    try {
      reportPackage = frozenPackage.artifact.schemaVersion === REPORT_PACKAGE_V2_VERSION
        ? parseReportPackageV2(frozenPackage.value)
        : parseReportPackageArtifactValue(frozenPackage.value);
    } catch {
      fail('SOURCE_INTEGRITY_INVALID');
    }
    if (
      reportPackage.taskId !== binding.taskId
      || reportPackage.planVersionId !== binding.planVersionId
      || reportPackage.attemptId !== binding.attemptId
      || reportPackage.presentationMode === 'legacy_text'
      || reportPackage.reportReviewArtifactId === undefined
    ) {
      fail(reportPackage.presentationMode === 'legacy_text' ? 'EDITORIAL_LEGACY_REPORT_UNSUPPORTED' : 'SOURCE_INTEGRITY_INVALID');
    }

    const reportDocumentArtifactId = reportPackage.version === REPORT_PACKAGE_V2_VERSION
      ? reportPackage.sourceReportDocumentArtifactId
      : reportPackage.reportDocumentArtifactId;
    const componentIds = [
      reportPackage.deliverableArtifactId,
      reportPackage.evidenceManifestArtifactId,
      reportPackage.reportReviewArtifactId,
      ...(reportDocumentArtifactId ? [reportDocumentArtifactId] : []),
    ];
    await artifacts.preflightJson(componentIds);
    const componentResults = new Map<string, VerifiedJson>();
    await Promise.all(componentIds.map(async (artifactId) => {
      componentResults.set(artifactId, await artifacts.readVerifiedJson(artifactId));
    }));
    const manifest = componentResults.get(reportPackage.evidenceManifestArtifactId);
    if (!manifest) fail('SOURCE_INTEGRITY_INVALID');
    const manifestRecord = record(manifest.value);
    if (!manifestRecord || !Array.isArray(manifestRecord.entries)) fail('SOURCE_INTEGRITY_INVALID');
    if (manifestRecord.entries.length > MAX_EVIDENCE_ENTRIES) fail('SOURCE_BUDGET_EXCEEDED');
    const evidenceEntries: EvidenceBudgetEntry[] = manifestRecord.entries.map((candidate) => {
      const entry = record(candidate);
      if (!entry || typeof entry.artifactId !== 'string' || entry.artifactId.length === 0) {
        fail('SOURCE_INTEGRITY_INVALID');
      }
      return {
        artifactId: entry.artifactId,
        kind: typeof entry.kind === 'string' ? entry.kind : '',
      };
    });
    const evidenceArtifactIds = [...new Set(evidenceEntries.map(({ artifactId }) => artifactId))];
    if (evidenceArtifactIds.length > MAX_EVIDENCE_ARTIFACTS) fail('SOURCE_BUDGET_EXCEEDED');
    await artifacts.preflightJson(evidenceArtifactIds);
    const evidenceResults = new Map<string, VerifiedJson>();
    await Promise.all(evidenceArtifactIds.map(async (artifactId) => {
      evidenceResults.set(artifactId, await artifacts.readVerifiedJson(artifactId));
    }));

    const rawVisualReferences = reportDocumentArtifactId
      ? reportDocumentVisualReferences(componentResults.get(reportDocumentArtifactId)?.value)
      : [];
    for (const entry of evidenceEntries) {
      if (entry.kind !== 'screenshot') continue;
      const screenshotManifest = record(evidenceResults.get(entry.artifactId)?.value);
      if (typeof screenshotManifest?.assetId === 'string') {
        rawVisualReferences.push({
          assetId: screenshotManifest.assetId,
          manifestArtifactId: entry.artifactId,
        });
      }
    }
    const visualReferences = uniqueVisualReferences(rawVisualReferences);
    if (visualReferences.length > MAX_VISUAL_PAIRS) fail('SOURCE_BUDGET_EXCEEDED');
    const visualAssetIds = visualReferences.map(({ assetId }) => assetId);
    const visualManifestIds = visualReferences.map(({ manifestArtifactId }) => manifestArtifactId);
    await artifacts.preflightVisual([...visualAssetIds, ...visualManifestIds]);
    await artifacts.preflightBinary(visualAssetIds);
    await artifacts.preflightJson(visualManifestIds);
    const visualManifestValues = await Promise.all(
      visualManifestIds.map(async (artifactId) => (await artifacts.readVerifiedJson(artifactId)).value),
    );
    const visualProvenanceIds = visualProvenanceArtifactIds(visualManifestValues);
    await artifacts.preflightJson(visualProvenanceIds);
    await artifacts.preflightVisual(visualProvenanceIds);

    const allowedVisualReferences = new Set(visualReferences.map(visualReferenceKey));
    const verifiedVisualAssets = new Map<string, Promise<VerifiedVisualAsset>>();
    const visualReader = new VerifiedVisualAssetReader(artifacts);
    const capturingVisualReader = {
      readVerified: (reference: VisualAssetReference): Promise<VerifiedVisualAsset> => {
        const key = visualReferenceKey(reference);
        if (!allowedVisualReferences.has(key)) fail('SOURCE_INTEGRITY_INVALID');
        let pending = verifiedVisualAssets.get(key);
        if (!pending) {
          pending = visualReader.readVerified(reference);
          verifiedVisualAssets.set(key, pending);
        }
        return pending;
      },
    };
    let current: Awaited<ReturnType<CurrentReportPackageReader['read']>>;
    try {
      current = await new CurrentReportPackageReader({
        artifacts,
        repository: this.repository,
        visualAssets: capturingVisualReader,
        schemaValidator: this.schemaValidator,
      }).read(
        binding,
        reportPackage.version === REPORT_PACKAGE_V2_VERSION
          ? {
              artifactId: frozenPackage.artifact.id,
              contentSha256: frozenPackage.artifact.contentSha256,
            }
          : reportPackage,
      );
    } catch (error) {
      if (error instanceof EditorialSourceError) throw error;
      fail('SOURCE_INTEGRITY_INVALID');
    }
    if (
      !current
      || current.presentationMode === 'legacy_text'
      || current.presentationMode !== reportPackage.presentationMode
      || current.reportReview.verdict !== 'pass'
    ) {
      fail('SOURCE_INTEGRITY_INVALID');
    }

    const deliverableType = parseDeliverableType(current.deliverable.deliverableType);
    let contract: ReturnType<typeof resolveDeliverableContractById>;
    try {
      contract = resolveDeliverableContractById(deliverableType);
    } catch {
      fail('EDITORIAL_DELIVERABLE_UNSUPPORTED');
    }
    try {
      this.schemaValidator.validateFileOrThrow(
        contract.payloadSchemaPath,
        current.deliverable.payload,
      );
    } catch {
      fail('SOURCE_PAYLOAD_INVALID');
    }
    const resolvedVisualAssets = await Promise.all(
      [...verifiedVisualAssets.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, pending]) => pending),
    );
    const sourceArtifacts = artifacts.sourceArtifacts();
    const sourcePolicyMetadata = artifacts.sourcePolicyMetadata();
    await this.assertStillCurrent(binding);
    return {
      binding,
      ...(frozenTaskContext === undefined ? {} : { taskContext: frozenTaskContext }),
      reportPackage: {
        artifact: structuredClone(frozenPackage.artifact) as ControlArtifact & {
          state: 'SEALED';
          contentSha256: string;
        },
        value: structuredClone(reportPackage),
      },
      current: structuredClone(current),
      sourceArtifacts,
      sourcePolicyMetadata,
      verifiedVisualAssets: resolvedVisualAssets.map((asset) => ({
        artifact: structuredClone(asset.artifact),
        bytes: Buffer.from(asset.bytes),
        metadata: structuredClone(asset.metadata),
        manifest: structuredClone(asset.manifest),
        manifestArtifact: structuredClone(asset.manifestArtifact),
      })),
    };
  }
}

// Keep the public name used by the development document while retaining the shorter internal name.
export { EditorialSourceReader as EditorialReportSourceReader };
