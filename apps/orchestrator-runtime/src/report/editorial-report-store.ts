import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { hostname as nodeHostname } from 'node:os';
import { join, resolve } from 'node:path';

import { root as openFsSafeRoot, type Root } from '@openclaw/fs-safe';
import {
  buildDeterministicEditorialBlueprint,
  buildPhase1PublishedDiagnostic,
  canonicalJsonBytes,
  createEditorialGenerationId,
  createEditorialRequestKey,
  EDITORIAL_MAX_DIAGNOSTIC_BYTES,
  EDITORIAL_MAX_JSON_BYTES,
  EDITORIAL_MAX_MANIFEST_BYTES,
  hashBytes,
  parseEditorialBlueprint,
  parseEditorialDiagnostic,
  parseEditorialMaterial,
  parseEditorialReport,
  projectEditorialModelContext,
  validateEditorialBlueprint,
  type EditorialDiagnostic,
  type EditorialMaterial,
  type EditorialModelCallRecord,
  type EditorialReport,
  type Sha256,
  type SourceArtifactRef,
} from './editorial-report-contract.ts';
import {
  assertEditorialHtmlSafe,
  replayEditorialReport,
} from './editorial-report-renderer.ts';

const LOCK_VERSION = 'editorial-request-lock-v1';
const LOCK_MAX_BYTES = 4 * 1024;
const LOCK_STALE_MS = 15 * 60 * 1_000;
const CLEANUP_TTL_MS = 24 * 60 * 60 * 1_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_KEY_PATTERN = /^erq_[0-9a-f]{64}$/u;
const GENERATION_ID_PATTERN = /^er_[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const FILE_NAMES = {
  material: 'editorial-material.json',
  blueprint: 'editorial-blueprint.json',
  diagnostic: 'editorial-diagnostic.json',
  html: 'editorial-report.html',
  manifest: 'manifest.json',
} as const;
const EXPECTED_SLOT_ENTRIES = Object.values(FILE_NAMES).sort();

export type EditorialReportSlot = 'ready' | 'fallback';

export interface EditorialStorePublishInput {
  slot: EditorialReportSlot;
  materialBytes: Uint8Array;
  blueprintBytes: Uint8Array;
  diagnosticBytes: Uint8Array;
  htmlBytes: Uint8Array;
  manifestBytes: Uint8Array;
  assertStillCurrent(): Promise<void>;
}

export interface EditorialStoreExpectedSource {
  planVersionId: string;
  sourceReportPackage: Pick<SourceArtifactRef, 'artifactId' | 'contentSha256'>;
  sensitivity: string;
  redactionPolicyVersion: string;
}

export interface EditorialStoredGeneration {
  slot: EditorialReportSlot;
  slotPath: string;
  reportPath: string;
  manifestPath: string;
  requestKey: string;
  generationId: string;
  manifest: EditorialReport;
  materialBytes: Buffer;
  blueprintBytes: Buffer;
  diagnosticBytes: Buffer;
  htmlBytes: Buffer;
  manifestBytes: Buffer;
}

export interface EditorialFailureDiagnostic {
  diagnosticPath: string;
}

export interface EditorialFailureDiagnosticInput {
  taskId: string;
  expected: {
    planVersionId: string;
    attemptId: string;
    sourceReportPackage: SourceArtifactRef;
  };
  diagnosticBytes: Uint8Array;
  assertStillCurrent(): Promise<void>;
}

export interface EditorialReportStoreHooks {
  beforeReapRename?(): Promise<void>;
  afterReapRename?(): Promise<void>;
  beforeManifestWrite?(): Promise<void>;
  beforePublishRename?(): Promise<void>;
}

interface StoreOptions {
  root: string;
  now?: () => Date;
  hostname?: string;
  pid?: number;
  randomBytes?: (size: number) => Buffer;
  isPidAlive?: (pid: number) => boolean;
  hooks?: EditorialReportStoreHooks;
}

interface LockRecord {
  version: typeof LOCK_VERSION;
  requestKey: string;
  pid: number;
  hostname: string;
  createdAt: string;
  ownerToken: string;
}

interface LockIdentity {
  path: string;
  record: LockRecord;
  raw: Buffer;
  dev: bigint;
  ino: bigint;
}

interface RequestCoordinates {
  taskId: string;
  attemptId: string;
  requestKey: string;
}

export class EditorialStoreError extends Error {
  readonly name = 'EditorialStoreError';

  constructor(readonly code: string, options?: { cause?: unknown }) {
    super(code, options);
  }
}

function storeError(code: string, cause?: unknown): EditorialStoreError {
  return new EditorialStoreError(code, cause === undefined ? undefined : { cause });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  return value;
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw storeError('EDITORIAL_STORE_PATH_INVALID');
}

function assertRequestKey(value: string): void {
  if (!REQUEST_KEY_PATTERN.test(value)) throw storeError('EDITORIAL_STORE_PATH_INVALID');
}

function assertGenerationId(value: string): void {
  if (!GENERATION_ID_PATTERN.test(value)) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.record.ownerToken === right.record.ownerToken
    && sameBytes(left.raw, right.raw);
}

function parseLock(raw: Buffer, requestKey: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw storeError('EDITORIAL_REQUEST_BUSY');
  }
  const candidate = record(value);
  try {
    exactKeys(candidate, ['createdAt', 'hostname', 'ownerToken', 'pid', 'requestKey', 'version']);
  } catch {
    throw storeError('EDITORIAL_REQUEST_BUSY');
  }
  if (
    candidate.version !== LOCK_VERSION
    || candidate.requestKey !== requestKey
    || typeof candidate.pid !== 'number'
    || !Number.isSafeInteger(candidate.pid)
    || candidate.pid <= 0
    || typeof candidate.hostname !== 'string'
    || candidate.hostname.length === 0
    || Buffer.byteLength(candidate.hostname, 'utf8') > 253
    || typeof candidate.createdAt !== 'string'
    || Number.isNaN(Date.parse(candidate.createdAt))
    || typeof candidate.ownerToken !== 'string'
    || !TOKEN_PATTERN.test(candidate.ownerToken)
    || !sameBytes(canonicalJsonBytes(candidate), raw)
  ) {
    throw storeError('EDITORIAL_REQUEST_BUSY');
  }
  return candidate as unknown as LockRecord;
}

function parseCanonicalJson(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (!sameBytes(canonicalJsonBytes(value), bytes)) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  return record(value);
}

function parseStoredContract<T>(bytes: Buffer, parser: (value: unknown) => T): T {
  const value = parseCanonicalJson(bytes);
  try {
    return parser(value);
  } catch (error) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT', error);
  }
}

function refMatches(leftValue: unknown, rightValue: unknown): boolean {
  const left = record(leftValue);
  const right = record(rightValue);
  return left.artifactId === right.artifactId
    && left.kind === right.kind
    && left.schemaVersion === right.schemaVersion
    && left.contentSha256 === right.contentSha256;
}

function assertFileRef(
  value: unknown,
  expectedPath: string,
  bytes: Buffer,
  mediaType: 'application/json' | 'text/html',
): void {
  const candidate = record(value);
  if (
    candidate.relativePath !== expectedPath
    || candidate.contentSha256 !== hashBytes(bytes)
    || candidate.byteSize !== bytes.byteLength
    || candidate.mediaType !== mediaType
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
}

function assertHtmlAssets(
  htmlBytes: Buffer,
  exportedValue: unknown,
  material: EditorialMaterial,
): void {
  if (!Array.isArray(exportedValue) || exportedValue.length > 6) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const html = htmlBytes.toString('utf8');
  if (Buffer.byteLength(html, 'utf8') !== htmlBytes.byteLength) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  const found: Array<{ assetId: string; contentSha256: Sha256; mediaType: string }> = [];
  for (const match of html.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    const assetId = tag.match(/\bdata-editorial-asset-id="([^"]+)"/u)?.[1];
    const source = tag.match(/\bsrc="data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})"/u);
    if (!assetId || !source) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(source[2]!, 'base64');
    } catch {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    if (bytes.toString('base64') !== source[2]) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    found.push({ assetId, contentSha256: hashBytes(bytes), mediaType: source[1]! });
  }
  const materialAssets = new Map(material.assets.map((asset) => [asset.assetId, asset]));
  const expected = exportedValue.map((value) => {
    const item = record(value);
    const assetId = string(item.assetId);
    const contentSha256 = string(item.contentSha256);
    const asset = materialAssets.get(assetId);
    if (!SHA256_PATTERN.test(contentSha256)) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    if (!asset) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    return { assetId, contentSha256, mediaType: asset.mediaType };
  });
  if (!sameBytes(canonicalJsonBytes(found), canonicalJsonBytes(expected))) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return sameBytes(canonicalJsonBytes(left), canonicalJsonBytes(right));
}

function verifyDerivedValue<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof EditorialStoreError) throw error;
    throw storeError('EDITORIAL_SIDECAR_CORRUPT', error);
  }
}

function assertExportedAssetClosure(
  material: EditorialMaterial,
  exportedAssets: EditorialReport['exportedAssets'],
): void {
  const sourceById = new Map(material.sourceArtifacts.map((source) => [source.artifactId, source]));
  const materialAssetsBySourceId = new Map<string, Array<{ index: number }>>();
  material.assets.forEach((asset, index) => {
    const source = sourceById.get(asset.assetId);
    const assetManifest = sourceById.get(asset.manifestArtifactId);
    if (
      source?.kind !== 'visual_asset'
      || source.schemaVersion !== 'visual-asset-v1'
      || assetManifest?.kind !== 'visual_asset_manifest'
      || !['visual-asset-manifest-v1', 'visual-asset-manifest-v2'].includes(assetManifest.schemaVersion)
    ) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    const matches = materialAssetsBySourceId.get(asset.assetId) ?? [];
    matches.push({ index });
    materialAssetsBySourceId.set(asset.assetId, matches);
  });
  let previousMaterialIndex = -1;
  for (const exported of exportedAssets) {
    // exportedAssets and HTML carry the frozen source Asset ID. Blueprint/render traces use
    // EditorialMaterialAsset.id, so never compare those two ID domains directly.
    const matches = materialAssetsBySourceId.get(exported.assetId) ?? [];
    if (
      matches.length !== 1
      || matches[0]!.index <= previousMaterialIndex
      || sourceById.get(exported.assetId)?.contentSha256 !== exported.contentSha256
    ) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    previousMaterialIndex = matches[0]!.index;
  }
}

function manifestCall(call: EditorialModelCallRecord & { inputBlueprintHash?: Sha256 }): EditorialModelCallRecord {
  const { inputBlueprintHash: _inputBlueprintHash, ...result } = call;
  return result;
}

function expectedModelEgressReason(
  pipeline: EditorialReport['pipeline'],
): EditorialReport['pipeline']['modelEgress']['reasonCode'] {
  const { evaluated } = pipeline.modelEgress;
  const configuration = pipeline.gatewayConfiguration;
  if (evaluated.sensitivities.some((value) => value !== 'public' && value !== 'internal')) {
    return 'EGRESS_SENSITIVITY_DENIED';
  }
  if (evaluated.redactionPolicyVersions.some((value) => value !== 'v1')) {
    return 'EGRESS_REDACTION_POLICY_DENIED';
  }
  if (configuration === null) return 'EGRESS_MODEL_UNCONFIGURED';
  if (configuration.provider !== 'gateway') return 'EGRESS_PROVIDER_DENIED';
  if (configuration.mode !== 'real' || !configuration.eligibleAsReal) return 'EGRESS_MODE_DENIED';
  if (
    configuration.endpointHost !== 'llm-gw.jd.local'
    || configuration.endpointUrl !== 'http://llm-gw.jd.local/v1/chat/completions'
  ) {
    return 'EGRESS_ENDPOINT_DENIED';
  }
  if (configuration.redirectMode !== 'error') return 'EGRESS_REDIRECT_POLICY_DENIED';
  return 'EGRESS_ALLOWED';
}

function assertModelClosure(input: {
  material: EditorialMaterial;
  diagnostic: Extract<EditorialDiagnostic, { status: 'pass' | 'degraded' }>;
  manifest: EditorialReport;
  modelContextHash: Sha256;
  modelContextByteSize: number;
  blueprintHash: Sha256;
}): void {
  const { diagnostic, manifest } = input;
  const { pipeline } = manifest;
  if (
    diagnostic.modelContextHash !== input.modelContextHash
    || diagnostic.modelContextByteSize !== input.modelContextByteSize
    || pipeline.modelContextHash !== input.modelContextHash
    || !sameCanonicalValue(diagnostic.modelEgress, pipeline.modelEgress)
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }

  const configuration = pipeline.gatewayConfiguration;
  const configurationHash = configuration?.gatewayConfigurationHash ?? null;
  if (diagnostic.gatewayConfigurationHash !== configurationHash) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const evaluated = pipeline.modelEgress.evaluated;
  if (
    evaluated.contributingSourceCount !== input.material.sourceArtifacts.length
    || evaluated.sensitivities.length === 0
    || evaluated.redactionPolicyVersions.length === 0
    || !evaluated.sensitivities.includes(manifest.sensitivity)
    || !evaluated.redactionPolicyVersions.includes(manifest.redactionPolicyVersion)
    || evaluated.provider !== (configuration?.provider ?? null)
    || evaluated.mode !== (configuration?.mode ?? null)
    || evaluated.endpointHost !== (configuration?.endpointHost ?? null)
    || evaluated.endpointUrl !== (configuration?.endpointUrl ?? null)
    || evaluated.redirectMode !== (configuration?.redirectMode ?? null)
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (pipeline.modelEgress.reasonCode !== expectedModelEgressReason(pipeline)) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }

  const calls = diagnostic.candidateAttempts.flatMap((attempt) => [
    manifestCall(attempt.plannerCall),
    ...('fidelityCall' in attempt && attempt.fidelityCall !== undefined
      ? [manifestCall(attempt.fidelityCall)]
      : []),
  ]);
  if (!sameCanonicalValue(calls, manifest.modelCalls)) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (pipeline.modelEgress.decision === 'deny' && (calls.length !== 0 || diagnostic.candidateAttempts.length !== 0)) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (manifest.status === 'ready') {
    const accepted = diagnostic.candidateAttempts.filter(({ outcome }) => outcome === 'accepted');
    if (
      pipeline.modelEgress.decision !== 'allow'
      || accepted.length !== 1
      || accepted[0]!.blueprintHash !== input.blueprintHash
    ) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
  } else if (diagnostic.candidateAttempts.some(({ outcome }) => outcome === 'accepted')) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const rejectedResponseHashes = diagnostic.candidateAttempts.flatMap((attempt) => (
    attempt.outcome === 'rejected' && attempt.plannerCall.status === 'succeeded'
      ? [attempt.plannerCall.responseHash]
      : []
  ));
  if (!sameCanonicalValue(rejectedResponseHashes, diagnostic.rejectedResponseHashes)) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  for (const call of calls) {
    const expectedPromptVersion = call.stage === 'editorial_blueprint'
      ? pipeline.promptVersion
      : pipeline.fidelityPromptVersion;
    if (
      configurationHash === null
      || call.gatewayConfigurationHash !== configurationHash
      || call.modelContextHash !== input.modelContextHash
      || call.modelContextByteSize !== input.modelContextByteSize
      || call.promptVersion !== expectedPromptVersion
    ) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    const route = configuration?.routes.find(({ requestedModel }) => requestedModel === call.requestedModel);
    if (
      call.provider !== undefined && call.provider !== configuration?.provider
      || call.endpointHost !== undefined && call.endpointHost !== configuration?.endpointHost
      || call.requestedModel !== undefined && !route
      || call.expectedModel !== undefined && call.expectedModel !== route?.expectedActualModel
      || call.status === 'succeeded' && call.actualModel !== call.expectedModel
    ) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
  }
}

function validateGeneration(input: {
  slot: EditorialReportSlot;
  coordinates: RequestCoordinates;
  expected?: EditorialStoreExpectedSource;
  materialBytes: Buffer;
  blueprintBytes: Buffer;
  diagnosticBytes: Buffer;
  htmlBytes: Buffer;
  manifestBytes: Buffer;
}): EditorialReport {
  const { coordinates } = input;
  for (const bytes of [input.materialBytes, input.blueprintBytes, input.htmlBytes]) {
    if (bytes.byteLength > EDITORIAL_MAX_JSON_BYTES) throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (input.diagnosticBytes.byteLength > EDITORIAL_MAX_DIAGNOSTIC_BYTES) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (input.manifestBytes.byteLength > EDITORIAL_MAX_MANIFEST_BYTES) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const material = parseStoredContract(input.materialBytes, parseEditorialMaterial);
  const blueprint = parseStoredContract(input.blueprintBytes, parseEditorialBlueprint);
  const diagnostic = parseStoredContract(input.diagnosticBytes, parseEditorialDiagnostic);
  const manifest = parseStoredContract(input.manifestBytes, parseEditorialReport);
  if (
    manifest.version !== 'editorial-report-v1'
    || manifest.authority !== 'derived'
    || manifest.taskId !== coordinates.taskId
    || manifest.attemptId !== coordinates.attemptId
    || manifest.requestKey !== coordinates.requestKey
    || typeof manifest.generationId !== 'string'
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  assertGenerationId(manifest.generationId);
  const expectedStatus = input.slot === 'ready' ? 'ready' : 'degraded';
  const expectedDiagnosticStatus = input.slot === 'ready' ? 'pass' : 'degraded';
  const expectedMode = input.slot === 'ready' ? 'llm' : 'deterministic_fallback';
  if (
    manifest.status !== expectedStatus
    || diagnostic.status !== expectedDiagnosticStatus
    || diagnostic.mode !== expectedMode
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const bindingValues = [material, blueprint, diagnostic, manifest];
  if (bindingValues.some((value) => (
    value.taskId !== coordinates.taskId
    || value.attemptId !== coordinates.attemptId
    || value.planVersionId !== manifest.planVersionId
  ))) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (
    blueprint.requestKey !== coordinates.requestKey
    || diagnostic.requestKey !== coordinates.requestKey
    || diagnostic.generationId !== manifest.generationId
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const materialHash = hashBytes(input.materialBytes);
  const blueprintHash = hashBytes(input.blueprintBytes);
  const htmlHash = hashBytes(input.htmlBytes);
  if (
    blueprint.materialHash !== materialHash
    || diagnostic.materialHash !== materialHash
    || diagnostic.publishedBlueprintHash !== blueprintHash
    || diagnostic.htmlHash !== htmlHash
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (
    !refMatches(material.sourceReportPackage, manifest.sourceReportPackage)
    || !refMatches(diagnostic.sourceReportPackage, manifest.sourceReportPackage)
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  verifyDerivedValue(() => validateEditorialBlueprint({ blueprint, material, mode: expectedMode }));
  if (expectedMode === 'deterministic_fallback') {
    const expectedBlueprint = verifyDerivedValue(() => buildDeterministicEditorialBlueprint({
      material,
      requestKey: coordinates.requestKey,
    }));
    if (!sameBytes(canonicalJsonBytes(expectedBlueprint), input.blueprintBytes)) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
  }
  const modelContext = verifyDerivedValue(() => projectEditorialModelContext(material));
  assertModelClosure({
    material,
    diagnostic: diagnostic as Extract<EditorialDiagnostic, { status: 'pass' | 'degraded' }>,
    manifest,
    modelContextHash: modelContext.hash,
    modelContextByteSize: modelContext.byteSize,
    blueprintHash,
  });
  const requestKey = verifyDerivedValue(() => createEditorialRequestKey({
    sourceReportPackageId: material.sourceReportPackage.artifactId,
    sourceReportPackageHash: material.sourceReportPackage.contentSha256,
    materialHash,
    modelContextHash: modelContext.hash,
    modelEgress: manifest.pipeline.modelEgress,
    gatewayConfiguration: manifest.pipeline.gatewayConfiguration,
  }));
  if (requestKey !== coordinates.requestKey) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  assertExportedAssetClosure(material, manifest.exportedAssets);
  const generationId = verifyDerivedValue(() => createEditorialGenerationId({
    requestKey,
    mode: expectedMode,
    materialHash,
    publishedBlueprintHash: blueprintHash,
    exportedAssetHashes: manifest.exportedAssets,
  }));
  if (manifest.generationId !== generationId || diagnostic.generationId !== generationId) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  const files = record(manifest.files);
  assertFileRef(files.material, FILE_NAMES.material, input.materialBytes, 'application/json');
  assertFileRef(files.blueprint, FILE_NAMES.blueprint, input.blueprintBytes, 'application/json');
  assertFileRef(files.diagnostic, FILE_NAMES.diagnostic, input.diagnosticBytes, 'application/json');
  assertFileRef(files.html, FILE_NAMES.html, input.htmlBytes, 'text/html');
  const htmlRef = record(files.html);
  if (htmlRef.selfContained !== true || htmlRef.printProfile !== 'a4-portrait-v1') {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  verifyDerivedValue(() => assertEditorialHtmlSafe(input.htmlBytes));
  assertHtmlAssets(input.htmlBytes, manifest.exportedAssets, material);
  const replayed = verifyDerivedValue(() => replayEditorialReport({
    material,
    blueprint,
    htmlBytes: input.htmlBytes,
  }));
  if (
    !sameBytes(replayed.htmlBytes, input.htmlBytes)
    || !sameCanonicalValue(replayed.exportedAssets, manifest.exportedAssets)
  ) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  if (expectedMode === 'deterministic_fallback') {
    const expectedDiagnostic = verifyDerivedValue(() => buildPhase1PublishedDiagnostic({
      material,
      requestKey,
      materialHash,
      modelEgress: manifest.pipeline.modelEgress,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      generationId,
      publishedBlueprintHash: blueprintHash,
      htmlHash,
      rendererWarningCodes: replayed.warnings.map(({ code }) => code),
    }));
    if (!sameBytes(canonicalJsonBytes(expectedDiagnostic), input.diagnosticBytes)) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
  }
  if (input.expected && (
    manifest.planVersionId !== input.expected.planVersionId
    || manifest.sensitivity !== input.expected.sensitivity
    || manifest.redactionPolicyVersion !== input.expected.redactionPolicyVersion
    || record(manifest.sourceReportPackage).artifactId !== input.expected.sourceReportPackage.artifactId
    || record(manifest.sourceReportPackage).contentSha256 !== input.expected.sourceReportPackage.contentSha256
  )) {
    throw storeError('EDITORIAL_SIDECAR_CORRUPT');
  }
  return manifest;
}

async function readPinned(path: string, maximumBytes: number, failureCode: string): Promise<{
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
}> {
  let before;
  let handle: FileHandle | undefined;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
      throw storeError(failureCode);
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw storeError(failureCode);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead > maximumBytes
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || BigInt(bytesRead) !== before.size
    ) {
      throw storeError(failureCode);
    }
    return { bytes: buffer.subarray(0, bytesRead), dev: before.dev, ino: before.ino };
  } catch (error) {
    if (error instanceof EditorialStoreError) throw error;
    throw storeError(failureCode, error);
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<{
  dev: bigint;
  ino: bigint;
}> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.byteLength)) {
      throw storeError('EDITORIAL_STORE_WRITE_FAILED');
    }
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    await handle?.close();
  }
}

export class EditorialRequestLease {
  #released = false;

  constructor(
    private readonly owner: EditorialReportStore,
    readonly taskId: string,
    readonly attemptId: string,
    readonly requestKey: string,
    private readonly identity: LockIdentity,
  ) {}

  readSlot(slot: EditorialReportSlot, expected?: EditorialStoreExpectedSource): Promise<EditorialStoredGeneration | null> {
    return this.owner.readSlot({
      taskId: this.taskId,
      attemptId: this.attemptId,
      requestKey: this.requestKey,
      slot,
      expected,
    });
  }

  publish(input: EditorialStorePublishInput): Promise<EditorialStoredGeneration> {
    if (this.#released) throw storeError('EDITORIAL_LOCK_NOT_OWNED');
    return this.owner.publish(this, this.identity, input);
  }

  async release(): Promise<boolean> {
    if (this.#released) return false;
    const released = await this.owner.release(this.identity, {
      taskId: this.taskId,
      attemptId: this.attemptId,
      requestKey: this.requestKey,
    });
    if (released) this.#released = true;
    return released;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

export class EditorialReportStore {
  private readonly rootPath: string;
  private readonly now: () => Date;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly hooks: EditorialReportStoreHooks;

  constructor(options: StoreOptions) {
    if (!options.root || !resolve(options.root)) throw storeError('EDITORIAL_STORE_PATH_INVALID');
    this.rootPath = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.hostname = options.hostname ?? nodeHostname();
    this.pid = options.pid ?? process.pid;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.isPidAlive = options.isPidAlive ?? defaultPidAlive;
    this.hooks = options.hooks ?? {};
    if (!Number.isSafeInteger(this.pid) || this.pid <= 0 || !this.hostname || Buffer.byteLength(this.hostname) > 253) {
      throw storeError('EDITORIAL_STORE_PATH_INVALID');
    }
  }

  private validateCoordinates(input: RequestCoordinates): void {
    assertUuid(input.taskId);
    assertUuid(input.attemptId);
    assertRequestKey(input.requestKey);
  }

  private attemptRelative(input: RequestCoordinates): string {
    return `tasks/${input.taskId}/attempts/${input.attemptId}`;
  }

  private lockRelative(input: RequestCoordinates): string {
    return `${this.attemptRelative(input)}/locks/${input.requestKey}.lock`;
  }

  private guardRelative(input: RequestCoordinates): string {
    return `${this.attemptRelative(input)}/locks/${input.requestKey}.reap`;
  }

  private slotRelative(input: RequestCoordinates, slot: EditorialReportSlot): string {
    return `${this.attemptRelative(input)}/requests/${input.requestKey}/${slot}`;
  }

  private failureRelative(taskId: string, failureId: string): string {
    return `tasks/${taskId}/failures/${failureId}`;
  }

  private absolute(relativePath: string, rootPath = this.rootPath): string {
    const path = join(rootPath, ...relativePath.split('/'));
    if (path !== rootPath && !path.startsWith(`${rootPath}/`)) {
      throw storeError('EDITORIAL_STORE_PATH_INVALID');
    }
    return path;
  }

  private async ensureRootDirectory(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: DIRECTORY_MODE });
    const stat = await lstat(this.rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storeError('EDITORIAL_STORE_PATH_INVALID');
    await chmod(this.rootPath, DIRECTORY_MODE);
  }

  private async ensureChildDirectory(root: Root, relativePath: string): Promise<void> {
    await root.mkdir(relativePath);
    const stat = await root.stat(relativePath);
    if (!stat.isDirectory || stat.isSymbolicLink) throw storeError('EDITORIAL_STORE_PATH_INVALID');
    await chmod(this.absolute(relativePath, root.rootReal), DIRECTORY_MODE);
  }

  private async fileRoot(): Promise<Root> {
    await this.ensureRootDirectory();
    return openFsSafeRoot(this.rootPath, {
      hardlinks: 'reject',
      maxBytes: EDITORIAL_MAX_JSON_BYTES,
      mkdir: false,
      mode: FILE_MODE,
      nonBlockingRead: true,
      symlinks: 'reject',
    });
  }

  private async ensureAttemptLayout(input: RequestCoordinates): Promise<Root> {
    const root = await this.fileRoot();
    const directories = [
      'tasks',
      `tasks/${input.taskId}`,
      `${this.attemptRelative(input)}`,
      `${this.attemptRelative(input)}/.staging`,
      `${this.attemptRelative(input)}/locks`,
      `${this.attemptRelative(input)}/locks/.reaped`,
      `${this.attemptRelative(input)}/requests`,
      `${this.attemptRelative(input)}/requests/${input.requestKey}`,
    ];
    for (const directory of directories) await this.ensureChildDirectory(root, directory);
    return root;
  }

  private newLockRecord(requestKey: string): LockRecord {
    const token = this.randomBytes(32);
    if (token.byteLength !== 32) throw storeError('EDITORIAL_STORE_RANDOM_FAILED');
    const now = this.now();
    if (Number.isNaN(now.getTime())) throw storeError('EDITORIAL_STORE_CLOCK_FAILED');
    return {
      version: LOCK_VERSION,
      requestKey,
      pid: this.pid,
      hostname: this.hostname,
      createdAt: now.toISOString(),
      ownerToken: token.toString('hex'),
    };
  }

  private async createLock(path: string, requestKey: string): Promise<LockIdentity> {
    const record = this.newLockRecord(requestKey);
    const raw = canonicalJsonBytes(record);
    if (raw.byteLength > LOCK_MAX_BYTES) throw storeError('EDITORIAL_STORE_WRITE_FAILED');
    try {
      const identity = await writeExclusive(path, raw);
      return { path, record, raw, ...identity };
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) throw storeError('EDITORIAL_REQUEST_BUSY');
      if (error instanceof EditorialStoreError) throw error;
      throw storeError('EDITORIAL_STORE_WRITE_FAILED', error);
    }
  }

  private async readLock(path: string, requestKey: string): Promise<LockIdentity> {
    const pinned = await readPinned(path, LOCK_MAX_BYTES, 'EDITORIAL_REQUEST_BUSY');
    return { path, raw: pinned.bytes, record: parseLock(pinned.bytes, requestKey), dev: pinned.dev, ino: pinned.ino };
  }

  private async releaseExact(identity: LockIdentity): Promise<boolean> {
    let current: LockIdentity;
    try {
      current = await this.readLock(identity.path, identity.record.requestKey);
    } catch {
      return false;
    }
    if (!sameIdentity(identity, current)) return false;
    try {
      await unlink(identity.path);
      return true;
    } catch {
      return false;
    }
  }

  private async tryCreateGuard(root: Root, input: RequestCoordinates): Promise<LockIdentity | null> {
    try {
      return await this.createLock(this.absolute(this.guardRelative(input), root.rootReal), input.requestKey);
    } catch (error) {
      if (error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY') return null;
      throw error;
    }
  }

  private isStale(lock: LockIdentity): boolean {
    if (lock.record.hostname !== this.hostname) return false;
    const age = this.now().getTime() - Date.parse(lock.record.createdAt);
    return age > LOCK_STALE_MS && !this.isPidAlive(lock.record.pid);
  }

  private async tryReap(root: Root, input: RequestCoordinates, observed: LockIdentity): Promise<boolean> {
    if (!this.isStale(observed)) return false;
    const guard = await this.tryCreateGuard(root, input);
    if (!guard) return false;
    try {
      let current = await this.readLock(observed.path, input.requestKey);
      if (!sameIdentity(observed, current) || !this.isStale(current)) return false;
      await this.hooks.beforeReapRename?.();
      current = await this.readLock(observed.path, input.requestKey);
      if (!sameIdentity(observed, current) || !this.isStale(current)) return false;
      const suffix = this.randomBytes(16).toString('hex');
      const reaped = this.absolute(
        `${this.attemptRelative(input)}/locks/.reaped/${input.requestKey}-${suffix}.lock`,
        root.rootReal,
      );
      await rename(observed.path, reaped);
      await chmod(reaped, FILE_MODE);
      await this.hooks.afterReapRename?.();
      return true;
    } catch (error) {
      if (error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY') return false;
      throw error;
    } finally {
      await this.releaseExact(guard);
    }
  }

  private async cleanup(root: Root, input: RequestCoordinates): Promise<void> {
    const cutoff = this.now().getTime() - CLEANUP_TTL_MS;
    const candidates = [
      {
        directory: `${this.attemptRelative(input)}/.staging`,
        accepts: (name: string) => name.startsWith(`${input.requestKey}-`),
      },
      {
        directory: `${this.attemptRelative(input)}/locks/.reaped`,
        accepts: (name: string) => name.startsWith(`${input.requestKey}-`) && name.endsWith('.lock'),
      },
    ];
    for (const candidate of candidates) {
      const directory = this.absolute(candidate.directory, root.rootReal);
      for (const name of await readdir(directory)) {
        if (!candidate.accepts(name) || name.includes('/') || name.includes('..')) continue;
        const path = join(directory, name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
        await rm(path, { recursive: stat.isDirectory(), force: false });
      }
    }
  }

  async acquire(input: RequestCoordinates): Promise<EditorialRequestLease> {
    this.validateCoordinates(input);
    const root = await this.ensureAttemptLayout(input);
    const path = this.absolute(this.lockRelative(input), root.rootReal);
    let identity: LockIdentity;
    try {
      identity = await this.createLock(path, input.requestKey);
    } catch (error) {
      if (!(error instanceof EditorialStoreError) || error.code !== 'EDITORIAL_REQUEST_BUSY') throw error;
      let observed: LockIdentity;
      try {
        observed = await this.readLock(path, input.requestKey);
      } catch {
        throw storeError('EDITORIAL_REQUEST_BUSY');
      }
      if (!await this.tryReap(root, input, observed)) throw storeError('EDITORIAL_REQUEST_BUSY');
      try {
        identity = await this.createLock(path, input.requestKey);
      } catch {
        throw storeError('EDITORIAL_REQUEST_BUSY');
      }
    }
    try {
      await this.cleanup(root, input);
    } catch (error) {
      await this.release(identity, input);
      throw storeError('EDITORIAL_STORE_CLEANUP_FAILED', error);
    }
    return new EditorialRequestLease(this, input.taskId, input.attemptId, input.requestKey, identity);
  }

  async release(identity: LockIdentity, input: RequestCoordinates): Promise<boolean> {
    try {
      this.validateCoordinates(input);
    } catch {
      return false;
    }
    const root = await this.fileRoot();
    if (
      input.requestKey !== identity.record.requestKey
      || identity.path !== this.absolute(this.lockRelative(input), root.rootReal)
    ) return false;
    const guard = await this.tryCreateGuard(root, input);
    if (!guard) return false;
    try {
      return await this.releaseExact(identity);
    } finally {
      await this.releaseExact(guard);
    }
  }

  async readSlot(input: RequestCoordinates & {
    slot: EditorialReportSlot;
    expected?: EditorialStoreExpectedSource;
  }): Promise<EditorialStoredGeneration | null> {
    this.validateCoordinates(input);
    const relative = this.slotRelative(input, input.slot);
    const root = await this.fileRoot();
    let directory;
    try {
      directory = await root.stat(relative);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'not-found') return null;
      if (isNodeError(error, 'ENOENT')) return null;
      throw storeError('EDITORIAL_SIDECAR_CORRUPT', error);
    }
    if (!directory.isDirectory || directory.isSymbolicLink || (directory.mode & 0o777) !== DIRECTORY_MODE) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    let names: string[];
    try {
      names = await root.list(relative);
    } catch (error) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT', error);
    }
    if (!sameBytes(canonicalJsonBytes(names.sort()), canonicalJsonBytes(EXPECTED_SLOT_ENTRIES))) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    const read = async (name: string, maximum: number): Promise<Buffer> => {
      const path = `${relative}/${name}`;
      try {
        const stat = await root.stat(path);
        if (!stat.isFile || stat.isSymbolicLink || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) {
          throw storeError('EDITORIAL_SIDECAR_CORRUPT');
        }
        return await root.readBytes(path, { hardlinks: 'reject', maxBytes: maximum, symlinks: 'reject' });
      } catch (error) {
        if (error instanceof EditorialStoreError) throw error;
        throw storeError('EDITORIAL_SIDECAR_CORRUPT', error);
      }
    };
    const [materialBytes, blueprintBytes, diagnosticBytes, htmlBytes, manifestBytes] = await Promise.all([
      read(FILE_NAMES.material, EDITORIAL_MAX_JSON_BYTES),
      read(FILE_NAMES.blueprint, EDITORIAL_MAX_JSON_BYTES),
      read(FILE_NAMES.diagnostic, EDITORIAL_MAX_JSON_BYTES),
      read(FILE_NAMES.html, EDITORIAL_MAX_JSON_BYTES),
      read(FILE_NAMES.manifest, EDITORIAL_MAX_MANIFEST_BYTES),
    ]);
    const manifest = validateGeneration({
      slot: input.slot,
      coordinates: input,
      expected: input.expected,
      materialBytes,
      blueprintBytes,
      diagnosticBytes,
      htmlBytes,
      manifestBytes,
    });
    const slotPath = this.absolute(relative, root.rootReal);
    return {
      slot: input.slot,
      slotPath,
      reportPath: join(slotPath, FILE_NAMES.html),
      manifestPath: join(slotPath, FILE_NAMES.manifest),
      requestKey: input.requestKey,
      generationId: manifest.generationId,
      manifest,
      materialBytes,
      blueprintBytes,
      diagnosticBytes,
      htmlBytes,
      manifestBytes,
    };
  }

  async writeFailureDiagnostic(input: EditorialFailureDiagnosticInput): Promise<EditorialFailureDiagnostic> {
    assertUuid(input.taskId);
    const diagnosticBytes = Buffer.from(input.diagnosticBytes);
    if (diagnosticBytes.byteLength > EDITORIAL_MAX_DIAGNOSTIC_BYTES) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }
    const diagnostic = parseStoredContract(diagnosticBytes, parseEditorialDiagnostic);
    if (
      diagnostic.status !== 'fail'
      || diagnostic.taskId !== input.taskId
      || diagnostic.planVersionId !== input.expected.planVersionId
      || diagnostic.attemptId !== input.expected.attemptId
      || !refMatches(diagnostic.sourceReportPackage, input.expected.sourceReportPackage)
    ) {
      throw storeError('EDITORIAL_SIDECAR_CORRUPT');
    }

    const root = await this.fileRoot();
    for (const directory of ['tasks', `tasks/${input.taskId}`, `tasks/${input.taskId}/failures`]) {
      await this.ensureChildDirectory(root, directory);
    }
    const token = this.randomBytes(16);
    if (token.byteLength !== 16) throw storeError('EDITORIAL_STORE_RANDOM_FAILED');
    const failureId = token.toString('hex');
    const failureRelative = this.failureRelative(input.taskId, failureId);
    const stagingRelative = `tasks/${input.taskId}/failures/.staging-${failureId}`;
    const stagingPath = this.absolute(stagingRelative, root.rootReal);
    const failurePath = this.absolute(failureRelative, root.rootReal);
    const stagedDiagnosticRelative = `${stagingRelative}/${FILE_NAMES.diagnostic}`;
    const diagnosticRelative = `${failureRelative}/${FILE_NAMES.diagnostic}`;
    let published = false;
    try {
      try {
        await this.ensureChildDirectory(root, stagingRelative);
        await root.create(stagedDiagnosticRelative, diagnosticBytes, { mkdir: false, mode: FILE_MODE });
        const stored = await root.readBytes(stagedDiagnosticRelative, {
          hardlinks: 'reject',
          maxBytes: EDITORIAL_MAX_DIAGNOSTIC_BYTES,
          symlinks: 'reject',
        });
        const stat = await root.stat(stagedDiagnosticRelative);
        if (
          !sameBytes(stored, diagnosticBytes)
          || !stat.isFile
          || stat.isSymbolicLink
          || stat.nlink !== 1
          || (stat.mode & 0o777) !== FILE_MODE
        ) {
          throw storeError('EDITORIAL_STORE_WRITE_FAILED');
        }
      } catch (error) {
        if (error instanceof EditorialStoreError) throw error;
        throw storeError('EDITORIAL_STORE_WRITE_FAILED', error);
      }

      await input.assertStillCurrent();
      try {
        const directory = await root.stat(stagingRelative);
        const names = await root.list(stagingRelative);
        const stored = await root.readBytes(stagedDiagnosticRelative, {
          hardlinks: 'reject',
          maxBytes: EDITORIAL_MAX_DIAGNOSTIC_BYTES,
          symlinks: 'reject',
        });
        const stat = await root.stat(stagedDiagnosticRelative);
        if (
          !directory.isDirectory
          || directory.isSymbolicLink
          || (directory.mode & 0o777) !== DIRECTORY_MODE
          || !sameBytes(canonicalJsonBytes(names.sort()), canonicalJsonBytes([FILE_NAMES.diagnostic]))
          || !sameBytes(stored, diagnosticBytes)
          || !stat.isFile
          || stat.isSymbolicLink
          || stat.nlink !== 1
          || (stat.mode & 0o777) !== FILE_MODE
        ) {
          throw storeError('EDITORIAL_STORE_WRITE_FAILED');
        }
        await rename(stagingPath, failurePath);
        published = true;
      } catch (error) {
        if (error instanceof EditorialStoreError) throw error;
        throw storeError('EDITORIAL_STORE_WRITE_FAILED', error);
      }
      return { diagnosticPath: this.absolute(diagnosticRelative, root.rootReal) };
    } finally {
      if (!published) {
        const stat = await lstat(stagingPath).catch(() => null);
        if (stat && stat.isDirectory() && !stat.isSymbolicLink()) {
          await rm(stagingPath, { recursive: true, force: false }).catch(() => undefined);
        }
      }
    }
  }

  async publish(
    lease: EditorialRequestLease,
    identity: LockIdentity,
    input: EditorialStorePublishInput,
  ): Promise<EditorialStoredGeneration> {
    const coordinates = {
      taskId: lease.taskId,
      attemptId: lease.attemptId,
      requestKey: lease.requestKey,
    };
    const assertLockOwned = async (): Promise<void> => {
      const currentLock = await this.readLock(identity.path, coordinates.requestKey);
      if (!sameIdentity(identity, currentLock)) throw storeError('EDITORIAL_LOCK_NOT_OWNED');
    };
    await assertLockOwned();
    const bytes = {
      materialBytes: Buffer.from(input.materialBytes),
      blueprintBytes: Buffer.from(input.blueprintBytes),
      diagnosticBytes: Buffer.from(input.diagnosticBytes),
      htmlBytes: Buffer.from(input.htmlBytes),
      manifestBytes: Buffer.from(input.manifestBytes),
    };
    validateGeneration({ slot: input.slot, coordinates, ...bytes });
    const existing = await this.readSlot({ ...coordinates, slot: input.slot });
    if (existing) {
      await input.assertStillCurrent();
      return existing;
    }
    const suffix = this.randomBytes(16).toString('hex');
    if (!/^[0-9a-f]{32}$/u.test(suffix)) throw storeError('EDITORIAL_STORE_RANDOM_FAILED');
    const stagingRelative = `${this.attemptRelative(coordinates)}/.staging/${coordinates.requestKey}-${suffix}`;
    const root = await this.fileRoot();
    const stagingPath = this.absolute(stagingRelative, root.rootReal);
    await this.ensureChildDirectory(root, stagingRelative);
    let published = false;
    try {
      const readWritten = async (name: string, maximumBytes: number, contents: Buffer): Promise<Buffer> => {
        const verified = await root.readBytes(`${stagingRelative}/${name}`, {
          hardlinks: 'reject', maxBytes: maximumBytes, symlinks: 'reject',
        });
        const stat = await root.stat(`${stagingRelative}/${name}`);
        if (
          !sameBytes(verified, contents)
          || hashBytes(verified) !== hashBytes(contents)
          || !stat.isFile
          || stat.isSymbolicLink
          || stat.nlink !== 1
          || (stat.mode & 0o777) !== FILE_MODE
        ) {
          throw storeError('EDITORIAL_STORE_WRITE_FAILED');
        }
        return verified;
      };
      const write = async (name: string, contents: Buffer, maximumBytes: number): Promise<void> => {
        await root.create(`${stagingRelative}/${name}`, contents, { mode: FILE_MODE, mkdir: false });
        await readWritten(name, maximumBytes, contents);
      };
      await write(FILE_NAMES.material, bytes.materialBytes, EDITORIAL_MAX_JSON_BYTES);
      await write(FILE_NAMES.blueprint, bytes.blueprintBytes, EDITORIAL_MAX_JSON_BYTES);
      await write(FILE_NAMES.diagnostic, bytes.diagnosticBytes, EDITORIAL_MAX_DIAGNOSTIC_BYTES);
      await write(FILE_NAMES.html, bytes.htmlBytes, EDITORIAL_MAX_JSON_BYTES);
      await this.hooks.beforeManifestWrite?.();
      await write(FILE_NAMES.manifest, bytes.manifestBytes, EDITORIAL_MAX_MANIFEST_BYTES);
      const targetRelative = this.slotRelative(coordinates, input.slot);
      const targetPath = this.absolute(targetRelative, root.rootReal);
      const winnerBeforeRename = await this.readSlot({ ...coordinates, slot: input.slot });
      if (winnerBeforeRename) {
        await input.assertStillCurrent();
        return winnerBeforeRename;
      }
      await this.hooks.beforePublishRename?.();
      const publishGuard = await this.tryCreateGuard(root, coordinates);
      if (!publishGuard) throw storeError('EDITORIAL_LOCK_NOT_OWNED');
      try {
        // release() and stale reaping use the same guard. Holding it closes the lock-loss
        // window while the binding fence is in flight; the fence remains the final awaited
        // predicate before the atomic publish rename.
        await assertLockOwned();
        await input.assertStillCurrent();
        try {
          const directory = await root.stat(stagingRelative);
          const names = await root.list(stagingRelative);
          if (
            !directory.isDirectory
            || directory.isSymbolicLink
            || (directory.mode & 0o777) !== DIRECTORY_MODE
            || !sameBytes(canonicalJsonBytes(names.sort()), canonicalJsonBytes(EXPECTED_SLOT_ENTRIES))
          ) {
            throw storeError('EDITORIAL_STORE_WRITE_FAILED');
          }
          const stagedBytes = {
            materialBytes: await readWritten(FILE_NAMES.material, EDITORIAL_MAX_JSON_BYTES, bytes.materialBytes),
            blueprintBytes: await readWritten(FILE_NAMES.blueprint, EDITORIAL_MAX_JSON_BYTES, bytes.blueprintBytes),
            diagnosticBytes: await readWritten(
              FILE_NAMES.diagnostic,
              EDITORIAL_MAX_DIAGNOSTIC_BYTES,
              bytes.diagnosticBytes,
            ),
            htmlBytes: await readWritten(FILE_NAMES.html, EDITORIAL_MAX_JSON_BYTES, bytes.htmlBytes),
            manifestBytes: await readWritten(
              FILE_NAMES.manifest,
              EDITORIAL_MAX_MANIFEST_BYTES,
              bytes.manifestBytes,
            ),
          };
          const stagedManifest = validateGeneration({ slot: input.slot, coordinates, ...stagedBytes });
          await rename(stagingPath, targetPath);
          published = true;
          const result = await this.readSlot({ ...coordinates, slot: input.slot });
          if (!result || result.manifest.generationId !== stagedManifest.generationId) {
            throw storeError('EDITORIAL_STORE_PUBLISH_FAILED');
          }
          return result;
        } catch (error) {
          if (published) throw error;
          const winner = await this.readSlot({ ...coordinates, slot: input.slot });
          if (!winner) throw storeError('EDITORIAL_STORE_PUBLISH_FAILED', error);
          await input.assertStillCurrent();
          return winner;
        }
      } finally {
        await this.releaseExact(publishGuard);
      }
    } finally {
      if (!published) {
        const stat = await lstat(stagingPath).catch(() => null);
        if (stat && stat.isDirectory() && !stat.isSymbolicLink()) {
          await rm(stagingPath, { recursive: true, force: false }).catch(() => undefined);
        }
      }
    }
  }
}
