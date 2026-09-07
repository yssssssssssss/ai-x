import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';

import type { ControlArtifact, ControlGateRecord } from '../../../../database/control-plane.ts';
import type { PendingInput } from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ArtifactWriteInput,
  TextArtifactWriteInput,
} from './artifact-store.ts';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_VIEW_BYTES = 512 * 1024;
const RAW_KIND = 'document_input_text';
const RAW_SCHEMA = 'document-input-text-v1';
const MANIFEST_KIND = 'document_input_manifest';
const MANIFEST_SCHEMA = 'document-input-manifest-v1';
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

type DocumentMediaType = 'text/markdown; charset=utf-8' | 'text/plain; charset=utf-8';

interface DocumentInputFileV1 {
  artifactId: string;
  fileName: string;
  mediaType: DocumentMediaType;
  byteSize: number;
  contentSha256: string;
}

export interface DocumentInputManifestV1 {
  version: typeof MANIFEST_SCHEMA;
  taskId: string;
  planVersionId: string;
  ownerUserId: string;
  gateKey: string;
  multiple: boolean;
  documents: DocumentInputFileV1[];
}

interface DocumentArtifactPort {
  writeText(input: TextArtifactWriteInput): Promise<ControlArtifact>;
  writeJson(input: ArtifactWriteInput): Promise<ControlArtifact>;
  readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }>;
  readVerifiedBoundDocument(artifactId: string): Promise<{ artifact: ControlArtifact; content: string }>;
  invalidateArtifactPublication(artifactId: string, reason: string): Promise<void>;
}

export interface DocumentUploadFile {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface DocumentUploadResult {
  documentInputId: string;
  files: Array<{
    fileName: string;
    mediaType: DocumentMediaType;
    contentSha256: string;
    byteSize: number;
  }>;
}

export interface PreparedDocumentInputGate {
  gateKey: string;
  evidenceRef: string;
  artifactIds: string[];
}

export interface DocumentModelViewV1 {
  version: 'document-model-view-v1';
  artifactId: string;
  role: string;
  fileName: string;
  mediaType: DocumentMediaType;
  content: string;
  truncated: boolean;
}

export interface ResolvedDocumentInput {
  gateKey: string;
  manifestArtifact: ControlArtifact;
  documents: DocumentModelViewV1[];
}

export interface ResolvedDocumentInputGates {
  gates: ControlGateRecord[];
  documents: ResolvedDocumentInput[];
}

export class DocumentInputGateError extends Error {
  constructor(message: string, readonly code = 'document_input_invalid') {
    super(`document input gate is invalid: ${message}`);
    this.name = 'DocumentInputGateError';
  }
}

function safeFileName(value: string): string {
  const name = value.trim();
  const extension = extname(name).toLowerCase();
  if (!name || basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new DocumentInputGateError('fileName must be one local file name');
  }
  if (extension !== '.md' && extension !== '.txt') {
    throw new DocumentInputGateError('only Markdown and TXT files are supported');
  }
  return name;
}

function normalizedMediaType(fileName: string, value: string): DocumentMediaType {
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  const extension = extname(fileName).toLowerCase();
  const generic = mediaType === '' || mediaType === 'application/octet-stream' || mediaType === 'text/plain';
  if (extension === '.md' && (mediaType === 'text/markdown' || generic)) {
    return 'text/markdown; charset=utf-8';
  }
  if (extension === '.txt' && generic) return 'text/plain; charset=utf-8';
  throw new DocumentInputGateError('file extension and media type do not match');
}

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentInputGateError('document byte size must be between 1 byte and 10 MiB');
  }
  const buffer = Buffer.from(bytes);
  const content = buffer.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(buffer)) {
    throw new DocumentInputGateError('document must be valid UTF-8');
  }
  if (!content || content.includes('\0')) {
    throw new DocumentInputGateError('document is empty or contains NUL');
  }
  return content;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertArtifact(input: {
  artifact: ControlArtifact;
  taskId: string;
  planVersionId: string;
  kind: string;
  schemaVersion: string;
  mediaType?: DocumentMediaType;
}): void {
  const { artifact } = input;
  if (
    artifact.state !== 'SEALED'
    || artifact.taskId !== input.taskId
    || artifact.planVersionId !== input.planVersionId
    || artifact.attemptId !== null
    || artifact.kind !== input.kind
    || artifact.schemaVersion !== input.schemaVersion
    || !artifact.contentSha256
    || (input.mediaType !== undefined && artifact.mediaType !== input.mediaType)
  ) {
    throw new DocumentInputGateError(`${input.kind} Artifact binding is invalid`);
  }
}

function parseManifest(value: unknown): DocumentInputManifestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentInputGateError('manifest must be an object');
  }
  const manifest = value as DocumentInputManifestV1;
  if (
    manifest.version !== MANIFEST_SCHEMA
    || typeof manifest.taskId !== 'string'
    || typeof manifest.planVersionId !== 'string'
    || typeof manifest.ownerUserId !== 'string'
    || typeof manifest.gateKey !== 'string'
    || typeof manifest.multiple !== 'boolean'
    || !Array.isArray(manifest.documents)
    || manifest.documents.length === 0
    || (!manifest.multiple && manifest.documents.length !== 1)
  ) {
    throw new DocumentInputGateError('manifest fields are malformed');
  }
  for (const document of manifest.documents) {
    if (
      !document
      || typeof document.artifactId !== 'string'
      || typeof document.fileName !== 'string'
      || (document.mediaType !== 'text/markdown; charset=utf-8' && document.mediaType !== 'text/plain; charset=utf-8')
      || !Number.isSafeInteger(document.byteSize)
      || document.byteSize <= 0
      || !SHA256.test(document.contentSha256)
    ) {
      throw new DocumentInputGateError('manifest document fields are malformed');
    }
  }
  return manifest;
}

function boundedUtf8(content: string, maxBytes: number): { content: string; truncated: boolean; usedBytes: number } {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength <= maxBytes) return { content, truncated: false, usedBytes: bytes.byteLength };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const bounded = bytes.subarray(0, end).toString('utf8');
  return { content: bounded, truncated: true, usedBytes: end };
}

export class DocumentInputGateStore {
  constructor(private readonly artifacts: DocumentArtifactPort) {}

  async upload(input: {
    taskId: string;
    planVersionId: string;
    role: string;
    ownerUserId: string;
    taskSensitivity: 'public' | 'internal' | 'confidential';
    multiple: boolean;
    files: DocumentUploadFile[];
  }): Promise<DocumentUploadResult> {
    if (input.files.length === 0 || (!input.multiple && input.files.length !== 1)) {
      throw new DocumentInputGateError(input.multiple
        ? 'at least one document is required'
        : 'exactly one document is required');
    }
    const artifactIds: string[] = [];
    try {
      const documents: DocumentInputFileV1[] = [];
      for (const file of input.files) {
        const fileName = safeFileName(file.fileName);
        const mediaType = normalizedMediaType(fileName, file.mediaType);
        const content = decodeUtf8(file.bytes);
        const contentSha256 = sha256(file.bytes);
        const extension = extname(fileName).toLowerCase();
        const artifact = await this.artifacts.writeText({
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          kind: RAW_KIND,
          relativePath: `inputs/documents/${randomUUID()}${extension}`,
          schemaVersion: RAW_SCHEMA,
          sensitivity: input.taskSensitivity,
          redactionPolicyVersion: 'v1',
          content,
          mediaType,
          maxByteSize: MAX_DOCUMENT_BYTES,
          metadata: { role: input.role, fileName, ownerUserId: input.ownerUserId },
        });
        artifactIds.push(artifact.id);
        assertArtifact({
          artifact,
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          kind: RAW_KIND,
          schemaVersion: RAW_SCHEMA,
          mediaType,
        });
        if (artifact.contentSha256 !== contentSha256 || artifact.byteSize !== file.bytes.byteLength) {
          throw new DocumentInputGateError('sealed document metadata does not match its input');
        }
        documents.push({
          artifactId: artifact.id,
          fileName,
          mediaType,
          byteSize: file.bytes.byteLength,
          contentSha256,
        });
      }
      const manifest: DocumentInputManifestV1 = {
        version: MANIFEST_SCHEMA,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        ownerUserId: input.ownerUserId,
        gateKey: input.role,
        multiple: input.multiple,
        documents,
      };
      const manifestArtifact = await this.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: MANIFEST_KIND,
        relativePath: `inputs/documents/${randomUUID()}-manifest.json`,
        schemaVersion: MANIFEST_SCHEMA,
        sensitivity: input.taskSensitivity,
        redactionPolicyVersion: 'v1',
        value: manifest,
        metadata: { role: input.role, ownerUserId: input.ownerUserId },
      });
      artifactIds.push(manifestArtifact.id);
      assertArtifact({
        artifact: manifestArtifact,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: MANIFEST_KIND,
        schemaVersion: MANIFEST_SCHEMA,
      });
      return {
        documentInputId: manifestArtifact.id,
        files: documents.map(({ fileName, mediaType, contentSha256, byteSize }) => ({
          fileName,
          mediaType,
          contentSha256,
          byteSize,
        })),
      };
    } catch (error) {
      await Promise.allSettled(artifactIds.map((artifactId) => (
        this.artifacts.invalidateArtifactPublication(artifactId, 'document input publication did not complete')
      )));
      throw error;
    }
  }

  private async readBound(input: {
    taskId: string;
    planVersionId: string;
    gateKey: string;
    ownerUserId: string;
    documentInputId: string;
  }): Promise<{
    manifestArtifact: ControlArtifact;
    manifest: DocumentInputManifestV1;
    documents: Array<{ reference: DocumentInputFileV1; content: string }>;
  }> {
    const stored = await this.artifacts.readVerifiedBoundJson<unknown>(input.documentInputId);
    assertArtifact({
      artifact: stored.artifact,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: MANIFEST_KIND,
      schemaVersion: MANIFEST_SCHEMA,
    });
    const manifest = parseManifest(stored.value);
    if (
      manifest.taskId !== input.taskId
      || manifest.planVersionId !== input.planVersionId
      || manifest.ownerUserId !== input.ownerUserId
      || manifest.gateKey !== input.gateKey
    ) {
      throw new DocumentInputGateError(`document ${input.gateKey} manifest binding is invalid`);
    }
    const documents = await Promise.all(manifest.documents.map(async (reference) => {
      const verified = await this.artifacts.readVerifiedBoundDocument(reference.artifactId);
      assertArtifact({
        artifact: verified.artifact,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: RAW_KIND,
        schemaVersion: RAW_SCHEMA,
        mediaType: reference.mediaType,
      });
      if (
        verified.artifact.contentSha256 !== reference.contentSha256
        || verified.artifact.byteSize !== reference.byteSize
      ) {
        throw new DocumentInputGateError(`document ${reference.fileName} does not match its manifest`);
      }
      return { reference, content: verified.content };
    }));
    return { manifestArtifact: stored.artifact, manifest, documents };
  }

  async prepareBinding(input: {
    taskId: string;
    planVersionId: string;
    gateKey: string;
    ownerUserId: string;
    documentInputId: string;
    multiple: boolean;
  }): Promise<PreparedDocumentInputGate> {
    const resolved = await this.readBound(input);
    if (resolved.manifest.multiple !== input.multiple) {
      throw new DocumentInputGateError(`document ${input.gateKey} multiplicity is invalid`);
    }
    return {
      gateKey: input.gateKey,
      evidenceRef: resolved.manifestArtifact.id,
      artifactIds: [
        ...resolved.manifest.documents.map(({ artifactId }) => artifactId),
        resolved.manifestArtifact.id,
      ],
    };
  }

  async invalidate(input: PreparedDocumentInputGate, reason: string): Promise<void> {
    await Promise.all(input.artifactIds.map((artifactId) => (
      this.artifacts.invalidateArtifactPublication(artifactId, reason)
    )));
  }

  async resolve(input: {
    taskId: string;
    planVersionId: string;
    ownerUserId: string;
    gates: readonly ControlGateRecord[];
    pendingInputs: readonly PendingInput[];
  }): Promise<ResolvedDocumentInputGates> {
    const pendingByRole = new Map(
      input.pendingInputs.filter(({ kind }) => kind === 'document').map((pending) => [pending.role, pending]),
    );
    const documents: ResolvedDocumentInput[] = [];
    const gates = await Promise.all(input.gates.map(async (gate) => {
      const pending = pendingByRole.get(gate.gateKey);
      if (!pending || gate.decision === 'waived') return structuredClone(gate);
      if (gate.value !== null && gate.value !== undefined) {
        throw new DocumentInputGateError(`document gate ${gate.gateKey} must not contain an inline value`);
      }
      if (!gate.evidenceRef) {
        throw new DocumentInputGateError(`document gate ${gate.gateKey} has no evidence reference`);
      }
      const resolved = await this.readBound({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        gateKey: gate.gateKey,
        ownerUserId: input.ownerUserId,
        documentInputId: gate.evidenceRef,
      });
      if (resolved.manifest.multiple !== pending.multiple) {
        throw new DocumentInputGateError(`document gate ${gate.gateKey} multiplicity is invalid`);
      }
      let remaining = MAX_MODEL_VIEW_BYTES;
      const modelViews = resolved.documents.map(({ reference, content }): DocumentModelViewV1 => {
        const bounded = boundedUtf8(content, remaining);
        remaining = Math.max(0, remaining - bounded.usedBytes);
        return {
          version: 'document-model-view-v1',
          artifactId: reference.artifactId,
          role: gate.gateKey,
          fileName: reference.fileName,
          mediaType: reference.mediaType,
          content: bounded.content,
          truncated: bounded.truncated,
        };
      });
      documents.push({
        gateKey: gate.gateKey,
        manifestArtifact: resolved.manifestArtifact,
        documents: modelViews,
      });
      return {
        ...structuredClone(gate),
        value: pending.multiple ? modelViews : modelViews[0],
      };
    }));
    return { gates, documents };
  }
}
