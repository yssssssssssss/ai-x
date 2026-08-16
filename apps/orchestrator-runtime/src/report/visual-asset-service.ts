import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ControlArtifact } from '../../../../database/control-plane.ts';
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

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REMOTE_REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUS: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type ArtifactStorePort = Pick<
  ControlArtifactStore,
  'writeBinary' | 'writeJson' | 'readVerifiedBinary' | 'readVerifiedJson'
>;

type ResolveHost = (hostname: string) => Promise<string[]>;
type FetchPort = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
  source: VisualAssetIngestSource;
  exportPolicy: VisualAssetExportPolicy;
}

export interface VisualAssetDeriveInput extends AssetBinding {
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

function parseIpv4(address: string): number[] | null {
  const octets = address.split('.');
  if (octets.length !== 4) return null;
  const parsed = octets.map((part) => Number(part));
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parsed;
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  const zoneIndex = address.indexOf('%');
  const input = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
  if (input.split('::').length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const pieces = side.split(':');
    const words: number[] = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4 || piece !== pieces.at(-1)) return null;
        words.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/iu.test(piece)) return null;
      words.push(Number.parseInt(piece, 16));
    }
    return words;
  };
  const [leftText, rightText] = input.split('::');
  const left = parseSide(leftText ?? '');
  const right = parseSide(rightText ?? '');
  if (!left || !right) return null;
  if (!input.includes('::')) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (isMappedIpv4) {
    return isPublicIpv4(`${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`);
  }
  const first = words[0]!;
  const second = words[1]!;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  return true;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function parseHttpUrl(value: string, context: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context} must resolve to a valid HTTP URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${context} uses a forbidden scheme; only HTTP(S) is allowed`);
  }
  if (url.username || url.password) throw new Error(`${context} HTTP URL must not contain credentials`);
  return url;
}

async function assertPublicTarget(url: URL, resolveHost: ResolveHost): Promise<void> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error(`HTTP target ${hostname} does not resolve exclusively to public addresses; private, loopback, link-local, and metadata addresses are forbidden`);
  }
}

function detectImageContentType(bytes: Buffer): TrustedBinaryMetadata['contentType'] {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('remote image signature is unsupported');
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
  dependencies: { resolveHost: ResolveHost; fetch: FetchPort },
): Promise<Buffer> {
  let url = parseHttpUrl(initialUrl, 'Tool Artifact pointer');
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicTarget(url, dependencies.resolveHost);
    const response = await dependencies.fetch(url, {
      redirect: 'manual',
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
    if (!response.ok) throw new Error(`remote image HTTP request failed with status ${response.status}`);
    const bytes = await readBoundedBody(response);
    const signatureType = detectImageContentType(bytes);
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

function assertManifest(manifest: VisualAssetManifest): void {
  if (!manifest || manifest.version !== 'visual-asset-manifest-v1') {
    throw new Error('visual Asset manifest version is invalid');
  }
  const { manifestHash, ...draft } = manifest;
  if (manifestHash !== hash(draft)) throw new Error('visual Asset manifest hash integrity check failed');
}

export class VisualAssetService {
  private readonly artifacts: ArtifactStorePort;
  private readonly resolveHost: ResolveHost;
  private readonly fetch: FetchPort;

  constructor(dependencies: {
    artifacts: ArtifactStorePort;
    resolveHost?: ResolveHost;
    fetch?: FetchPort;
  }) {
    this.artifacts = dependencies.artifacts;
    this.resolveHost = dependencies.resolveHost ?? defaultResolveHost;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
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
      bytes = await downloadImage(url, { resolveHost: this.resolveHost, fetch: this.fetch });
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
      this.artifacts.readVerifiedJson<VisualAssetManifest>(reference.manifestArtifactId),
    ]);
    const manifest = manifestResult.value;
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

  private async persist(input: AssetBinding & {
    bytes: Uint8Array;
    source: VisualAssetSource;
    exportPolicy: VisualAssetExportPolicy;
    derivedFrom: VisualAssetManifest['derivedFrom'];
    derivation: VisualAssetDerivation | null;
  }): Promise<VisualAssetResult> {
    const token = randomUUID();
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
    });
    assertBinding(assetArtifact, input, 'visual Asset');
    const metadata = metadataFromArtifact(assetArtifact);
    const draft = manifestDraft({ ...input, artifact: assetArtifact, metadata });
    const manifest: VisualAssetManifest = { ...draft, manifestHash: hash(draft) };
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
    });
    assertBinding(manifestArtifact, input, 'visual Asset manifest');
    return { assetArtifact, manifestArtifact, manifest };
  }
}
