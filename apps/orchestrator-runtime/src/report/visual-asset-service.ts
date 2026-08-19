import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ControlArtifact, ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  VisualAssetDerivation,
  VisualAssetExportPolicy,
  VisualAssetManifest,
  VisualAssetReference,
  VisualAssetSource,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ControlArtifactStore,
  TrustedBinaryMetadata,
} from '../control/artifact-store.ts';
import { resolveJsonPointer } from '../evidence/evidence-service.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { sniffSupportedImageContentType } from './image-content-type.ts';
import {
  defaultResolveHost,
  normalizedHostname,
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
  derivedFrom: VisualAssetManifest['derivedFrom'];
  derivation: VisualAssetDerivation | null;
}): Omit<VisualAssetManifest, 'manifestHash'> {
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
  MANIFEST_VALIDATOR.validateOrThrow('visual-asset-manifest', value);
}

function assertManifest(manifest: unknown): asserts manifest is VisualAssetManifest {
  assertVisualAssetManifestSchema(manifest);
  const { manifestHash, ...draft } = manifest;
  if (manifestHash !== hash(draft)) throw new Error('visual Asset manifest hash integrity check failed');
}

function assertPersistenceManifestInput(input: AssetBinding & {
  source: VisualAssetSource;
  exportPolicy: VisualAssetExportPolicy;
  derivedFrom: VisualAssetManifest['derivedFrom'];
  derivation: VisualAssetDerivation | null;
}): void {
  const draft: Omit<VisualAssetManifest, 'manifestHash'> = {
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

export class VisualAssetService {
  private readonly artifacts: ArtifactStorePort;
  private readonly resolveHost: ResolveHost;
  private readonly transport: VisualAssetTransport;

  constructor(dependencies: {
    artifacts: ArtifactStorePort;
    resolveHost?: ResolveHost;
    transport?: VisualAssetTransport;
    fetch?: FetchPort;
  }) {
    this.artifacts = dependencies.artifacts;
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
    const [binary, manifestResult] = await Promise.all([
      this.artifacts.readVerifiedBinary(reference.assetId),
      this.artifacts.readVerifiedJson<unknown>(reference.manifestArtifactId),
    ]);
    const manifest = manifestResult.value;
    if (manifestResult.artifact.schemaVersion !== 'visual-asset-manifest-v1') {
      throw new Error('visual Asset manifest Artifact schemaVersion is invalid');
    }
    assertManifest(manifest);
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
    return {
      artifact: binary.artifact,
      bytes: Buffer.from(binary.bytes),
      metadata: binary.metadata,
      manifest: structuredClone(manifest),
      manifestArtifact: manifestResult.artifact,
    };
  }

  async invalidate(result: VisualAssetResult, reason: string): Promise<void> {
    await Promise.allSettled([
      this.artifacts.invalidateArtifactPublication(result.assetArtifact.id, reason),
      this.artifacts.invalidateArtifactPublication(result.manifestArtifact.id, reason),
    ]);
  }

  private async persist(input: AssetBinding & {
    bytes: Uint8Array;
    source: VisualAssetSource;
    exportPolicy: VisualAssetExportPolicy;
    derivedFrom: VisualAssetManifest['derivedFrom'];
    derivation: VisualAssetDerivation | null;
    activeLease?: ControlExecutionLease;
  }): Promise<VisualAssetResult> {
    assertPersistenceManifestInput(input);
    const token = randomUUID();
    let assetArtifact: ControlArtifact | undefined;
    let manifestArtifact: ControlArtifact | undefined;
    try {
      assetArtifact = await this.artifacts.writeBinary({
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
      assertBinding(assetArtifact, input, 'visual Asset');
      const metadata = metadataFromArtifact(assetArtifact);
      const draft = manifestDraft({ ...input, artifact: assetArtifact, metadata });
      const manifest: VisualAssetManifest = { ...draft, manifestHash: hash(draft) };
      assertVisualAssetManifestSchema(manifest);
      manifestArtifact = await this.artifacts.writeJson({
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
      assertBinding(manifestArtifact, input, 'visual Asset manifest');
      if (manifestArtifact.schemaVersion !== 'visual-asset-manifest-v1') {
        throw new Error('visual Asset manifest Artifact schemaVersion is invalid');
      }
      return { assetArtifact, manifestArtifact, manifest };
    } catch (error) {
      await Promise.allSettled(
        [assetArtifact?.id, manifestArtifact?.id]
          .filter((artifactId): artifactId is string => artifactId !== undefined)
          .map((artifactId) => this.artifacts.invalidateArtifactPublication(
            artifactId,
            'visual Asset publication did not complete',
          )),
      );
      throw error;
    }
  }
}
