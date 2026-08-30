import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ControlArtifact, ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  BrowserCaptureSource,
  VisualAssetDerivation,
  VisualAssetExportPolicy,
  VisualAssetManifest,
  VisualAssetManifestV1,
  VisualAssetManifestV2,
  VisualAssetReference,
  VisualAssetSource,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ToolMediaAttachment } from '../runtime/tool-adapter.ts';
import {
  ArtifactIntegrityError,
  BinaryArtifactValidationError,
  type ControlArtifactStore,
  type TrustedBinaryMetadata,
} from '../control/artifact-store.ts';
import {
  ArtifactInvalidationError,
  ArtifactPublicationGroup,
  mergeArtifactInvalidationErrors,
} from '../control/artifact-publication-group.ts';
import { resolveJsonPointer } from '../evidence/evidence-service.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { sniffSupportedImageContentType } from './image-content-type.ts';
import {
  defaultResolveHost,
  normalizedHostname,
  parseBrowserUrl,
  parseHttpUrl,
  resolvePublicTarget,
  type ResolveHost,
} from '../runtime/public-web-access-policy.ts';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REMOTE_REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUS: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type ArtifactStorePort = Pick<
  ControlArtifactStore,
  | 'writeBinary' | 'writeJson' | 'readVerifiedBinary' | 'readVerifiedJson'
  | 'invalidateArtifactPublication'
>;

export type VerifiedVisualAssetReaderArtifacts = Pick<
  ControlArtifactStore,
  'readVerifiedBinary' | 'readVerifiedJson'
>;

type FetchPort = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface PinnedRequestInput {
  url: URL;
  validatedAddresses: string[];
  hostHeader: string;
  serverName: string | null;
  signal: AbortSignal;
}

export interface VisualAssetTransport {
  request(input: PinnedRequestInput): Promise<Response>;
}

interface AssetBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

export type VisualAssetIngestSource =
  | {
      kind: 'tool_artifact';
      artifactId: string;
      artifactContentSha256: string;
      jsonPointer: string;
    }
  | { kind: 'user_upload'; fileName: string; bytes: Uint8Array };

export interface VisualAssetIngestInput extends AssetBinding {
  activeLease?: ControlExecutionLease;
  source: VisualAssetIngestSource;
  exportPolicy: VisualAssetExportPolicy;
}

export interface VisualAssetDeriveInput extends AssetBinding {
  activeLease?: ControlExecutionLease;
  original: VisualAssetReference;
  derivation: VisualAssetDerivation;
  bytes: Uint8Array;
  exportPolicy: VisualAssetExportPolicy;
}

export interface BrowserCaptureIngestInput extends AssetBinding {
  activeLease: ControlExecutionLease;
  toolArtifactId: string;
  toolArtifactContentSha256: string;
  captureIndex: number;
  attachment: ToolMediaAttachment;
  exportPolicy: VisualAssetExportPolicy;
  ensureActive: () => void;
}

export interface ChartRenderSealInput extends AssetBinding {
  activeLease: ControlExecutionLease;
  dataArtifactId: string;
  dataArtifactContentSha256: string;
  chartId: string;
  specHash: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  exportPolicy: VisualAssetExportPolicy;
  publication: ArtifactPublicationGroup;
  ensureActive: () => Promise<void>;
}

export interface VerifiedVisualAsset {
  artifact: ControlArtifact;
  bytes: Buffer;
  metadata: TrustedBinaryMetadata;
  manifest: VisualAssetManifest;
  manifestArtifact: ControlArtifact;
}

export interface VisualAssetResult {
  assetArtifact: ControlArtifact;
  manifestArtifact: ControlArtifact;
  manifest: VisualAssetManifest;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function assertBinding(artifact: ControlArtifact, binding: AssetBinding, label: string): void {
  if (
    artifact.taskId !== binding.taskId
    || artifact.planVersionId !== binding.planVersionId
    || artifact.attemptId !== binding.attemptId
  ) {
    throw new Error(`${label} binding does not match Task, Plan, and Attempt`);
  }
}

function artifactIntegrityError(
  artifactId: string,
  context: string,
  error?: unknown,
): ArtifactIntegrityError {
  if (error instanceof ArtifactIntegrityError) return error;
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new ArtifactIntegrityError(artifactId, `${context}${detail}`);
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

async function nodePinnedRequest(input: PinnedRequestInput): Promise<Response> {
  const pinnedAddress = input.validatedAddresses[0];
  if (!pinnedAddress) throw new Error('HTTP target has no validated address');
  const pinnedFamily = isIP(pinnedAddress);
  const lookupPinnedAddress: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, input.validatedAddresses.map((address) => ({
        address,
        family: isIP(address),
      })));
      return;
    }
    callback(null, pinnedAddress, pinnedFamily);
  };
  const headers = {
    accept: 'image/png, image/jpeg, image/webp',
    host: input.hostHeader,
  };
  const agent = input.url.protocol === 'https:'
    ? new HttpsAgent({ keepAlive: false, lookup: lookupPinnedAddress })
    : new HttpAgent({ keepAlive: false, lookup: lookupPinnedAddress });
  const outgoing = input.url.protocol === 'https:'
    ? httpsRequest(input.url, {
        agent: agent as HttpsAgent,
        headers,
        servername: input.serverName ?? undefined,
        signal: input.signal,
      })
    : httpRequest(input.url, {
        agent: agent as HttpAgent,
        headers,
        signal: input.signal,
      });
  outgoing.once('close', () => agent.destroy());
  const response = once(outgoing, 'response', { signal: input.signal });
  outgoing.end();
  const [incoming] = await response as [IncomingMessage];
  const status = incoming.statusCode ?? 500;
  const hasNoBody = status === 204 || status === 205 || status === 304;
  const body = hasNoBody ? null : Readable.toWeb(incoming);
  return new Response(body as ConstructorParameters<typeof Response>[0], {
    status,
    statusText: incoming.statusMessage,
    headers: responseHeaders(incoming),
  });
}

const NODE_PINNED_TRANSPORT: VisualAssetTransport = { request: nodePinnedRequest };
function transportFromFetch(fetch: FetchPort): VisualAssetTransport {
  return {
    request: ({ url, signal }) => fetch(url, { redirect: 'manual', signal }),
  };
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null) {
    const parsedLength = Number(statedLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error('remote image Content-Length is invalid');
    }
    if (parsedLength > MAX_IMAGE_BYTES) throw new Error('remote image size exceeds 10 MiB');
  }
  if (!response.body) throw new Error('remote image response has no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > MAX_IMAGE_BYTES) {
        await reader.cancel('remote image size exceeds 10 MiB');
        throw new Error('remote image size exceeds 10 MiB');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (byteSize === 0) throw new Error('remote image response is empty');
  return Buffer.concat(chunks, byteSize);
}

async function downloadImage(
  initialUrl: string,
  dependencies: { resolveHost: ResolveHost; transport: VisualAssetTransport },
): Promise<Buffer> {
  let url = parseHttpUrl(initialUrl, 'Tool Artifact pointer');
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const validatedAddresses = await resolvePublicTarget(url, dependencies.resolveHost);
    const hostname = normalizedHostname(url);
    const response = await dependencies.transport.request({
      url,
      validatedAddresses,
      hostHeader: url.host,
      serverName: url.protocol === 'https:' && isIP(hostname) === 0 ? hostname : null,
      signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS),
    });
    if (REDIRECT_STATUS[response.status] === true) {
      await response.body?.cancel();
      if (redirects === MAX_REDIRECTS) throw new Error('remote image redirect limit exceeded');
      const location = response.headers.get('location');
      if (!location) throw new Error('remote image redirect has no Location');
      url = parseHttpUrl(new URL(location, url).toString(), 'redirect target');
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`remote image HTTP request failed with status ${response.status}`);
    }
    const bytes = await readBoundedBody(response);
    const signatureType = sniffSupportedImageContentType(bytes);
    if (signatureType === null) throw new Error('remote image signature is unsupported');
    const headerType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (headerType !== signatureType) {
      throw new Error(`remote image MIME Content-Type ${headerType ?? '(missing)'} disagrees with its signature ${signatureType}`);
    }
    return bytes;
  }
  throw new Error('remote image redirect limit exceeded');
}

function validatePointer(pointer: string): void {
  if (!pointer.startsWith('/')) throw new Error('Tool Artifact JSON pointer must start with /');
  const segments = pointer.slice(1).split('/');
  if (segments.some((segment) => /~(?!0|1)/u.test(segment))) {
    throw new Error('Tool Artifact JSON pointer has an invalid escape');
  }
  const decoded = segments.map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (decoded.some((segment) => PROTOTYPE_KEYS.has(segment))) {
    throw new Error('Tool Artifact JSON pointer contains an unsafe key');
  }
}

function metadataFromArtifact(artifact: ControlArtifact): TrustedBinaryMetadata {
  const metadata = artifact.metadata;
  if (
    artifact.mediaType !== 'image/png'
    && artifact.mediaType !== 'image/jpeg'
    && artifact.mediaType !== 'image/webp'
    && artifact.mediaType !== 'image/svg+xml'
  ) {
    throw new Error('visual Asset has no trusted image media type');
  }
  if (
    artifact.byteSize === null
    || !metadata
    || typeof metadata.width !== 'number'
    || typeof metadata.height !== 'number'
  ) {
    throw new Error('visual Asset has no trusted dimensions or byte size');
  }
  return {
    contentType: artifact.mediaType,
    byteSize: artifact.byteSize,
    width: metadata.width,
    height: metadata.height,
  };
}

function manifestDraft(input: AssetBinding & {
  artifact: ControlArtifact;
  metadata: TrustedBinaryMetadata;
  source: VisualAssetSource;
  exportPolicy: VisualAssetExportPolicy;
  derivedFrom: VisualAssetManifestV1['derivedFrom'];
  derivation: VisualAssetDerivation | null;
}): Omit<VisualAssetManifestV1, 'manifestHash'> {
  if (!input.artifact.contentSha256) throw new Error('visual Asset is not SEALED with a content hash');
  return {
    version: 'visual-asset-manifest-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    assetId: input.artifact.id,
    contentSha256: input.artifact.contentSha256,
    mediaType: input.metadata.contentType,
    byteSize: input.metadata.byteSize,
    width: input.metadata.width,
    height: input.metadata.height,
    exportPolicy: input.exportPolicy,
    source: input.source,
    derivedFrom: input.derivedFrom,
    derivation: input.derivation,
  };
}

const MANIFEST_VALIDATOR = new SchemaValidator();

export function assertVisualAssetManifestSchema(value: unknown): asserts value is VisualAssetManifest {
  if (!isRecord(value)) throw new Error('visual Asset manifest must be an object');
  if (value.version === 'visual-asset-manifest-v1') {
    MANIFEST_VALIDATOR.validateOrThrow('visual-asset-manifest', value);
    return;
  }
  if (value.version === 'visual-asset-manifest-v2') {
    MANIFEST_VALIDATOR.validateOrThrow('visual-asset-manifest-v2', value);
    return;
  }
  throw new Error('visual Asset manifest version is unsupported');
}

function assertManifest(manifest: unknown): asserts manifest is VisualAssetManifest {
  assertVisualAssetManifestSchema(manifest);
  const { manifestHash, ...draft } = manifest;
  if (manifestHash !== hash(draft)) throw new Error('visual Asset manifest hash integrity check failed');
}

function assertPersistenceManifestInput(input: AssetBinding & {
  source: VisualAssetSource;
  exportPolicy: VisualAssetExportPolicy;
  derivedFrom: VisualAssetManifestV1['derivedFrom'];
  derivation: VisualAssetDerivation | null;
}): void {
  const draft: Omit<VisualAssetManifestV1, 'manifestHash'> = {
    version: 'visual-asset-manifest-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    assetId: 'pending-visual-asset',
    contentSha256: `sha256:${'0'.repeat(64)}`,
    mediaType: input.derivation?.kind === 'chart_svg' ? 'image/svg+xml' : 'image/png',
    byteSize: 1,
    width: 1,
    height: 1,
    exportPolicy: input.exportPolicy,
    source: input.source,
    derivedFrom: input.derivedFrom,
    derivation: input.derivation,
  };
  assertVisualAssetManifestSchema({ ...draft, manifestHash: hash(draft) });
}

function requireHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an HTTPS URL`);
  const parsed = parseBrowserUrl(value, label);
  if (parsed.toString() !== value) throw new Error(`${label} must use its canonical HTTPS form`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function browserCaptureSource(
  metadata: unknown,
  input: BrowserCaptureIngestInput,
  artifact: ControlArtifact,
): BrowserCaptureSource {
  if (!isRecord(metadata)) throw new Error('browser capture JSON pointer does not resolve to capture metadata');
  const attachment = input.attachment;
  const jsonPointer = `/output/captures/${input.captureIndex}`;
  const attachmentId = metadata.attachment_id;
  const requestedUrl = requireHttpsUrl(metadata.requested_url, 'browser capture requested_url');
  const finalUrl = requireHttpsUrl(metadata.final_url, 'browser capture final_url');
  const pageTitle = metadata.page_title;
  const capturedAt = metadata.captured_at;
  const captureMode = metadata.capture_mode;
  const selector = metadata.selector;
  const viewport = metadata.viewport;
  const width = requireSafeInteger(metadata.width, 'browser capture width');
  const height = requireSafeInteger(metadata.height, 'browser capture height');
  const byteSize = requireSafeInteger(metadata.byte_size, 'browser capture byte_size');
  const computedHash = contentHash(attachment.bytes);
  if (
    typeof attachmentId !== 'string'
    || attachmentId !== attachment.attachmentId
    || metadata.media_type !== 'image/png'
    || attachment.mediaType !== 'image/png'
    || metadata.media_type !== attachment.mediaType
    || metadata.content_sha256 !== attachment.contentSha256
    || attachment.contentSha256 !== computedHash
    || requestedUrl !== attachment.sourcePageUrl
    || capturedAt !== attachment.capturedAt
    || captureMode !== attachment.captureMode
    || width !== attachment.width
    || height !== attachment.height
    || byteSize !== attachment.bytes.byteLength
  ) {
    throw new Error('browser capture attachment does not match sealed Tool metadata');
  }
  if (
    typeof pageTitle !== 'string'
    || pageTitle.length > 300
    || typeof capturedAt !== 'string'
    || !Number.isFinite(Date.parse(capturedAt))
    || !['extracted_image', 'element_screenshot', 'full_page_screenshot'].includes(String(captureMode))
    || (selector !== undefined && (typeof selector !== 'string' || !selector || selector.length > 512))
    || selector !== attachment.selector
    || !isRecord(viewport)
    || viewport.width !== attachment.viewport.width
    || viewport.height !== attachment.viewport.height
    || !Number.isSafeInteger(viewport.width)
    || !Number.isSafeInteger(viewport.height)
    || Number(viewport.width) < 1024
    || Number(viewport.width) > 1920
    || Number(viewport.height) < 720
    || Number(viewport.height) > 1200
    || metadata.truncated !== false && metadata.truncated !== true
  ) {
    throw new Error('browser capture metadata is malformed or disagrees with its attachment');
  }
  if (!artifact.contentSha256) throw new Error('browser capture Tool Artifact has no sealed hash');
  return {
    kind: 'browser_capture',
    artifactId: artifact.id,
    artifactContentSha256: artifact.contentSha256,
    jsonPointer,
    attachmentId,
    sourcePageUrl: requestedUrl,
    finalUrl,
    pageTitle,
    capturedAt,
    captureMode: captureMode as BrowserCaptureSource['captureMode'],
    ...(typeof selector === 'string' ? { selector } : {}),
    viewport: {
      width: Number(viewport.width),
      height: Number(viewport.height),
    },
  };
}

function browserManifestDraft(input: AssetBinding & {
  artifact: ControlArtifact;
  metadata: TrustedBinaryMetadata;
  source: BrowserCaptureSource;
  exportPolicy: VisualAssetExportPolicy;
}): Omit<VisualAssetManifestV2, 'manifestHash'> {
  if (!input.artifact.contentSha256) throw new Error('visual Asset is not SEALED with a content hash');
  return {
    version: 'visual-asset-manifest-v2',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    assetId: input.artifact.id,
    contentSha256: input.artifact.contentSha256,
    mediaType: input.metadata.contentType,
    byteSize: input.metadata.byteSize,
    width: input.metadata.width,
    height: input.metadata.height,
    exportPolicy: input.exportPolicy,
    source: input.source,
    derivedFrom: null,
    derivation: null,
  };
}

function chartManifestDraft(input: ChartRenderSealInput & {
  artifact: ControlArtifact;
  metadata: TrustedBinaryMetadata;
}): Omit<VisualAssetManifestV2, 'manifestHash'> {
  if (!input.artifact.contentSha256) throw new Error('visual Asset is not SEALED with a content hash');
  return {
    version: 'visual-asset-manifest-v2',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    assetId: input.artifact.id,
    contentSha256: input.artifact.contentSha256,
    mediaType: input.metadata.contentType,
    byteSize: input.metadata.byteSize,
    width: input.metadata.width,
    height: input.metadata.height,
    exportPolicy: input.exportPolicy,
    source: {
      kind: 'chart_render',
      dataArtifactId: input.dataArtifactId,
      dataArtifactContentSha256: input.dataArtifactContentSha256,
    },
    derivedFrom: null,
    derivation: {
      kind: 'chart_svg',
      chartId: input.chartId,
      specHash: input.specHash,
    },
  };
}

export class VerifiedVisualAssetReader {
  constructor(private readonly artifacts: VerifiedVisualAssetReaderArtifacts) {}

  async readVerified(reference: VisualAssetReference): Promise<VerifiedVisualAsset> {
    const [binary, manifestResult] = await Promise.all([
      this.artifacts.readVerifiedBinary(reference.assetId),
      this.artifacts.readVerifiedJson<unknown>(reference.manifestArtifactId),
    ]);
    const manifest = manifestResult.value;
    assertManifest(manifest);
    if (manifestResult.artifact.schemaVersion !== manifest.version) {
      throw new Error('visual Asset manifest Artifact schemaVersion does not match its body version');
    }
    if (
      binary.artifact.id !== reference.assetId
      || manifestResult.artifact.id !== reference.manifestArtifactId
      || binary.artifact.kind !== 'visual_asset'
      || manifestResult.artifact.kind !== 'visual_asset_manifest'
      || manifest.assetId !== binary.artifact.id
      || manifest.contentSha256 !== binary.artifact.contentSha256
      || manifest.mediaType !== binary.metadata.contentType
      || manifest.byteSize !== binary.metadata.byteSize
      || manifest.width !== binary.metadata.width
      || manifest.height !== binary.metadata.height
    ) {
      throw new Error('visual Asset identity or manifest integrity does not match verified bytes');
    }
    const binding = {
      taskId: manifest.taskId,
      planVersionId: manifest.planVersionId,
      attemptId: manifest.attemptId,
    };
    assertBinding(binary.artifact, binding, 'visual Asset');
    assertBinding(manifestResult.artifact, binding, 'visual Asset manifest');
    if (manifest.version === 'visual-asset-manifest-v2') {
      await this.assertV2Provenance(manifest, binary.artifact);
    }
    return {
      artifact: binary.artifact,
      bytes: Buffer.from(binary.bytes),
      metadata: binary.metadata,
      manifest: structuredClone(manifest),
      manifestArtifact: manifestResult.artifact,
    };
  }

  private async assertV2Provenance(
    manifest: VisualAssetManifestV2,
    binaryArtifact: ControlArtifact,
  ): Promise<void> {
    if (binaryArtifact.schemaVersion !== 'visual-asset-v1') {
      throw new Error('V2 visual Asset Binary Artifact schemaVersion is invalid');
    }
    const source = manifest.source;
    if (source.kind === 'browser_capture') {
      const tool = await this.artifacts.readVerifiedJson<unknown>(source.artifactId);
      if (
        tool.artifact.id !== source.artifactId
        || tool.artifact.kind !== 'tool_output'
        || tool.artifact.state !== 'SEALED'
        || tool.artifact.schemaVersion !== 'tool-output-v1'
        || tool.artifact.contentSha256 !== source.artifactContentSha256
      ) {
        throw new Error('browser capture Manifest Tool Artifact provenance is invalid');
      }
      assertBinding(tool.artifact, manifest, 'browser capture Manifest Tool Artifact');
      const metadata = resolveJsonPointer(tool.value, source.jsonPointer);
      if (!isRecord(metadata) || !isRecord(metadata.viewport)) {
        throw new Error('browser capture Manifest pointer does not resolve to capture metadata');
      }
      const requestedUrl = requireHttpsUrl(metadata.requested_url, 'browser capture requested_url');
      const finalUrl = requireHttpsUrl(metadata.final_url, 'browser capture final_url');
      if (
        metadata.attachment_id !== source.attachmentId
        || requestedUrl !== source.sourcePageUrl
        || finalUrl !== source.finalUrl
        || metadata.page_title !== source.pageTitle
        || metadata.captured_at !== source.capturedAt
        || metadata.capture_mode !== source.captureMode
        || metadata.selector !== source.selector
        || metadata.viewport.width !== source.viewport.width
        || metadata.viewport.height !== source.viewport.height
        || metadata.media_type !== manifest.mediaType
        || metadata.width !== manifest.width
        || metadata.height !== manifest.height
        || metadata.byte_size !== manifest.byteSize
        || metadata.content_sha256 !== manifest.contentSha256
      ) {
        throw new Error('browser capture Manifest provenance does not match its Tool metadata');
      }
      return;
    }
    if (source.kind === 'chart_render') {
      const data = await this.artifacts.readVerifiedJson<unknown>(source.dataArtifactId);
      if (
        data.artifact.id !== source.dataArtifactId
        || data.artifact.kind !== 'chart_data'
        || data.artifact.state !== 'SEALED'
        || data.artifact.contentSha256 !== source.dataArtifactContentSha256
      ) {
        throw new Error('chart render Manifest data Artifact provenance is invalid');
      }
      assertBinding(data.artifact, manifest, 'chart render Manifest data Artifact');
    }
  }
}

export class VisualAssetService {
  private readonly artifacts: ArtifactStorePort;
  private readonly resolveHost: ResolveHost;
  private readonly transport: VisualAssetTransport;
  private readonly verifiedReader: VerifiedVisualAssetReader;

  constructor(dependencies: {
    artifacts: ArtifactStorePort;
    resolveHost?: ResolveHost;
    transport?: VisualAssetTransport;
    fetch?: FetchPort;
  }) {
    this.artifacts = dependencies.artifacts;
    this.verifiedReader = new VerifiedVisualAssetReader(dependencies.artifacts);
    this.resolveHost = dependencies.resolveHost ?? defaultResolveHost;
    this.transport = dependencies.transport
      ?? (dependencies.fetch ? transportFromFetch(dependencies.fetch) : NODE_PINNED_TRANSPORT);
  }

  async ingest(input: VisualAssetIngestInput): Promise<VisualAssetResult> {
    requireNonEmpty(input.taskId, 'taskId');
    requireNonEmpty(input.planVersionId, 'planVersionId');
    requireNonEmpty(input.attemptId, 'attemptId');
    let bytes: Uint8Array;
    let source: VisualAssetSource;
    if (input.source.kind === 'user_upload') {
      requireNonEmpty(input.source.fileName, 'user upload fileName');
      bytes = Buffer.from(input.source.bytes);
      source = { kind: 'user_upload', fileName: input.source.fileName };
    } else if (input.source.kind === 'tool_artifact') {
      validatePointer(input.source.jsonPointer);
      const resolved = await this.artifacts.readVerifiedJson<unknown>(input.source.artifactId);
      if (
        resolved.artifact.kind !== 'tool_output'
        || resolved.artifact.state !== 'SEALED'
        || resolved.artifact.contentSha256 !== input.source.artifactContentSha256
      ) {
        throw new Error('Tool Artifact kind, state, or content hash does not match');
      }
      assertBinding(resolved.artifact, input, 'Tool Artifact');
      const pointed = resolveJsonPointer(resolved.value, input.source.jsonPointer);
      if (typeof pointed !== 'string' || !pointed.trim()) {
        throw new Error('Tool Artifact JSON pointer does not resolve to a remote URL');
      }
      const url = parseHttpUrl(pointed, 'Tool Artifact pointer').toString();
      bytes = await downloadImage(url, { resolveHost: this.resolveHost, transport: this.transport });
      source = {
        kind: 'tool_artifact',
        artifactId: resolved.artifact.id,
        artifactContentSha256: input.source.artifactContentSha256,
        jsonPointer: input.source.jsonPointer,
        url,
      };
    } else {
      throw new Error('remote URL input requires a verified Tool Artifact JSON pointer');
    }
    return this.persist({ ...input, bytes, source, derivedFrom: null, derivation: null });
  }

  async ingestBrowserCapture(input: BrowserCaptureIngestInput): Promise<VisualAssetResult> {
    requireNonEmpty(input.taskId, 'taskId');
    requireNonEmpty(input.planVersionId, 'planVersionId');
    requireNonEmpty(input.attemptId, 'attemptId');
    requireNonEmpty(input.toolArtifactId, 'browser capture Tool Artifact id');
    if (!Number.isSafeInteger(input.captureIndex) || input.captureIndex < 0 || input.captureIndex > 5) {
      throw new Error('browser capture index must be an integer from 0 through 5');
    }
    input.ensureActive();
    const tool = await this.artifacts.readVerifiedJson<unknown>(input.toolArtifactId);
    input.ensureActive();
    if (
      tool.artifact.kind !== 'tool_output'
      || tool.artifact.state !== 'SEALED'
      || tool.artifact.schemaVersion !== 'tool-output-v1'
      || tool.artifact.contentSha256 !== input.toolArtifactContentSha256
    ) {
      throw new Error('browser capture Tool Artifact kind, state, schema, or content hash does not match');
    }
    assertBinding(tool.artifact, input, 'browser capture Tool Artifact');
    const jsonPointer = `/output/captures/${input.captureIndex}`;
    const source = browserCaptureSource(
      resolveJsonPointer(tool.value, jsonPointer),
      input,
      tool.artifact,
    );
    return this.persistBrowserCapture({ ...input, source });
  }

  async sealChartRender(input: ChartRenderSealInput): Promise<VisualAssetResult> {
    requireNonEmpty(input.taskId, 'taskId');
    requireNonEmpty(input.planVersionId, 'planVersionId');
    requireNonEmpty(input.attemptId, 'attemptId');
    requireNonEmpty(input.dataArtifactId, 'chart data Artifact id');
    if (!input.publication.artifactIds.includes(input.dataArtifactId)) {
      throw new Error('Caller publication must already own the chart data Artifact');
    }
    input.publication.track(input.dataArtifactId);
    try {
      await input.ensureActive();
      let data: { artifact: ControlArtifact; value: unknown };
      try {
        data = await this.artifacts.readVerifiedJson<unknown>(input.dataArtifactId);
      } catch (error) {
        throw artifactIntegrityError(
          input.dataArtifactId,
          'chart render data Artifact readback failed integrity verification',
          error,
        );
      }
      await input.ensureActive();
      if (
        data.artifact.id !== input.dataArtifactId
        || data.artifact.kind !== 'chart_data'
        || data.artifact.state !== 'SEALED'
        || data.artifact.contentSha256 !== input.dataArtifactContentSha256
      ) {
        throw new ArtifactIntegrityError(
          input.dataArtifactId,
          'chart render data Artifact kind, state, or content hash does not match',
        );
      }
      try {
        assertBinding(data.artifact, input, 'chart render data Artifact');
      } catch (error) {
        throw artifactIntegrityError(data.artifact.id, 'chart render data Artifact binding is invalid', error);
      }
      return await this.persistChartRender(input);
    } catch (error) {
      try {
        await input.publication.compensate('Chart publication did not complete');
      } catch (invalidationError) {
        if (invalidationError === error) throw error;
        if (
          error instanceof ArtifactInvalidationError
          && invalidationError instanceof ArtifactInvalidationError
        ) {
          throw mergeArtifactInvalidationErrors(error, invalidationError);
        }
        throw invalidationError;
      }
      if (error instanceof BinaryArtifactValidationError) {
        throw artifactIntegrityError(
          input.dataArtifactId,
          'chart render SVG failed binary integrity validation',
          error,
        );
      }
      throw error;
    }
  }

  async derive(input: VisualAssetDeriveInput): Promise<VisualAssetResult> {
    const original = await this.readVerified(input.original);
    assertBinding(original.artifact, input, 'original visual Asset');
    return this.persist({
      ...input,
      bytes: Buffer.from(input.bytes),
      source: { kind: 'derived' },
      derivedFrom: {
        assetId: original.artifact.id,
        manifestArtifactId: original.manifestArtifact.id,
        contentSha256: original.artifact.contentSha256!,
        manifestHash: original.manifest.manifestHash,
      },
      derivation: structuredClone(input.derivation),
    });
  }

  async readVerified(reference: VisualAssetReference): Promise<VerifiedVisualAsset> {
    return this.verifiedReader.readVerified(reference);
  }

  async invalidate(result: VisualAssetResult, reason: string): Promise<void> {
    const group = new ArtifactPublicationGroup(this.artifacts);
    group.track(result.assetArtifact.id).track(result.manifestArtifact.id);
    await group.compensate(reason);
  }

  private async persistBrowserCapture(
    input: BrowserCaptureIngestInput & { source: BrowserCaptureSource },
  ): Promise<VisualAssetResult> {
    const token = randomUUID();
    const group = new ArtifactPublicationGroup(this.artifacts);
    try {
      const assetArtifact = await this.artifacts.writeBinary({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'visual_asset',
        relativePath: `visual-assets/${token}.image`,
        bytes: Buffer.from(input.attachment.bytes),
        schemaVersion: 'visual-asset-v1',
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
      });
      group.track(assetArtifact.id);
      input.ensureActive();
      assertBinding(assetArtifact, input, 'browser capture visual Asset');
      const binary = await this.artifacts.readVerifiedBinary(assetArtifact.id);
      input.ensureActive();
      assertBinding(binary.artifact, input, 'verified browser capture visual Asset');
      const metadata = metadataFromArtifact(binary.artifact);
      if (
        binary.artifact.id !== assetArtifact.id
        || binary.artifact.contentSha256 !== input.attachment.contentSha256
        || contentHash(binary.bytes) !== input.attachment.contentSha256
        || metadata.contentType !== input.attachment.mediaType
        || metadata.byteSize !== input.attachment.bytes.byteLength
        || metadata.width !== input.attachment.width
        || metadata.height !== input.attachment.height
      ) {
        throw new Error('sealed browser capture Binary Artifact does not match its attachment');
      }
      const draft = browserManifestDraft({ ...input, artifact: binary.artifact, metadata });
      const manifest: VisualAssetManifestV2 = { ...draft, manifestHash: hash(draft) };
      assertVisualAssetManifestSchema(manifest);
      const manifestArtifact = await this.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'visual_asset_manifest',
        relativePath: `visual-assets/${token}.manifest.json`,
        value: manifest,
        schemaVersion: manifest.version,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
      });
      group.track(manifestArtifact.id);
      input.ensureActive();
      assertBinding(manifestArtifact, input, 'browser capture visual Asset manifest');
      const verified = await this.readVerified({
        assetId: assetArtifact.id,
        manifestArtifactId: manifestArtifact.id,
      });
      input.ensureActive();
      group.commit();
      return {
        assetArtifact: verified.artifact,
        manifestArtifact: verified.manifestArtifact,
        manifest: verified.manifest,
      };
    } catch (error) {
      try {
        await group.compensate('browser capture visual Asset publication did not complete');
      } catch (invalidationError) {
        throw invalidationError;
      }
      throw error;
    }
  }

  private async persistChartRender(input: ChartRenderSealInput): Promise<VisualAssetResult> {
    const token = randomUUID();
    const expectedContentSha256 = contentHash(input.bytes);
    const publication = input.publication;
    const assetArtifact = await this.artifacts.writeBinary({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: 'visual_asset',
      relativePath: `visual-assets/${token}.svg`,
      bytes: Buffer.from(input.bytes),
      schemaVersion: 'visual-asset-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
      trustedMediaType: 'image/svg+xml',
    });
    publication.track(assetArtifact.id);
    await input.ensureActive();
    try {
      assertBinding(assetArtifact, input, 'chart render visual Asset');
    } catch (error) {
      throw artifactIntegrityError(assetArtifact.id, 'chart render visual Asset binding is invalid', error);
    }
    const binary = await this.artifacts.readVerifiedBinary(assetArtifact.id);
    await input.ensureActive();
    try {
      assertBinding(binary.artifact, input, 'verified chart render visual Asset');
    } catch (error) {
      throw artifactIntegrityError(binary.artifact.id, 'verified chart render visual Asset binding is invalid', error);
    }
    const metadata = metadataFromArtifact(binary.artifact);
    if (
      binary.artifact.id !== assetArtifact.id
      || binary.artifact.contentSha256 !== expectedContentSha256
      || contentHash(binary.bytes) !== expectedContentSha256
      || metadata.contentType !== 'image/svg+xml'
      || metadata.contentType !== binary.metadata.contentType
      || metadata.byteSize !== input.bytes.byteLength
      || metadata.byteSize !== binary.metadata.byteSize
      || metadata.width !== input.width
      || metadata.width !== binary.metadata.width
      || metadata.height !== input.height
      || metadata.height !== binary.metadata.height
    ) {
      throw new ArtifactIntegrityError(
        assetArtifact.id,
        'sealed chart render Binary Artifact does not match its SVG input',
      );
    }
    const draft = chartManifestDraft({ ...input, artifact: binary.artifact, metadata });
    const manifest: VisualAssetManifestV2 = { ...draft, manifestHash: hash(draft) };
    assertVisualAssetManifestSchema(manifest);
    const manifestArtifact = await this.artifacts.writeJson({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: 'visual_asset_manifest',
      relativePath: `visual-assets/${token}.manifest.json`,
      value: manifest,
      schemaVersion: manifest.version,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
    });
    publication.track(manifestArtifact.id);
    await input.ensureActive();
    try {
      assertBinding(manifestArtifact, input, 'chart render visual Asset manifest');
    } catch (error) {
      throw artifactIntegrityError(
        manifestArtifact.id,
        'chart render visual Asset manifest binding is invalid',
        error,
      );
    }
    let verified: VerifiedVisualAsset;
    try {
      verified = await this.readVerified({
        assetId: assetArtifact.id,
        manifestArtifactId: manifestArtifact.id,
      });
    } catch (error) {
      throw artifactIntegrityError(
        manifestArtifact.id,
        'chart render visual Asset readback failed integrity verification',
        error,
      );
    }
    await input.ensureActive();
    return {
      assetArtifact: verified.artifact,
      manifestArtifact: verified.manifestArtifact,
      manifest: verified.manifest,
    };
  }

  private async persist(input: AssetBinding & {
    bytes: Uint8Array;
    source: VisualAssetSource;
    exportPolicy: VisualAssetExportPolicy;
    derivedFrom: VisualAssetManifestV1['derivedFrom'];
    derivation: VisualAssetDerivation | null;
    activeLease?: ControlExecutionLease;
  }): Promise<VisualAssetResult> {
    assertPersistenceManifestInput(input);
    const token = randomUUID();
    const group = new ArtifactPublicationGroup(this.artifacts);
    try {
      const assetArtifact = await this.artifacts.writeBinary({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'visual_asset',
        relativePath: `visual-assets/${token}.image`,
        bytes: Buffer.from(input.bytes),
        schemaVersion: 'visual-asset-v1',
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        ...(input.activeLease ? { activeLease: input.activeLease } : {}),
        ...(input.derivation?.kind === 'chart_svg'
          ? { trustedMediaType: 'image/svg+xml' as const }
          : {}),
      });
      group.track(assetArtifact.id);
      assertBinding(assetArtifact, input, 'visual Asset');
      const metadata = metadataFromArtifact(assetArtifact);
      const draft = manifestDraft({ ...input, artifact: assetArtifact, metadata });
      const manifest: VisualAssetManifestV1 = { ...draft, manifestHash: hash(draft) };
      assertVisualAssetManifestSchema(manifest);
      const manifestArtifact = await this.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'visual_asset_manifest',
        relativePath: `visual-assets/${token}.manifest.json`,
        value: manifest,
        schemaVersion: 'visual-asset-manifest-v1',
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        ...(input.activeLease ? { activeLease: input.activeLease } : {}),
      });
      group.track(manifestArtifact.id);
      assertBinding(manifestArtifact, input, 'visual Asset manifest');
      if (manifestArtifact.schemaVersion !== 'visual-asset-manifest-v1') {
        throw new Error('visual Asset manifest Artifact schemaVersion is invalid');
      }
      group.commit();
      return { assetArtifact, manifestArtifact, manifest };
    } catch (error) {
      try {
        await group.compensate('visual Asset publication did not complete');
      } catch (invalidationError) {
        throw invalidationError;
      }
      throw error;
    }
  }
}
