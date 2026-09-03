import { randomUUID } from 'node:crypto';

import type { ControlArtifact, ControlGateRecord } from '../../../../database/control-plane.ts';
import type { PendingInput } from '../../../../packages/api-contract/research-deliverable.ts';
import {
  type ArtifactWriteInput,
  type BinaryArtifactWriteInput,
  type TrustedBinaryMetadata,
} from './artifact-store.ts';
import {
  parseVisualInputDataUrls,
  type VisualInputImage,
} from '../report/visual-input-data-url.ts';

const IMAGE_KIND = 'visual_input_image';
const IMAGE_SCHEMA_VERSION = 'visual-input-image-v1';
const GATE_KIND = 'visual_input_gate';
const GATE_SCHEMA_VERSION = 'visual-input-gate-v1';

type SupportedMediaType = VisualInputImage['contentType'];

interface VisualInputGateImageV1 {
  artifactId: string;
  contentSha256: string;
  mediaType: SupportedMediaType;
  byteSize: number;
}

interface VisualInputGateManifestV1 {
  version: typeof GATE_SCHEMA_VERSION;
  taskId: string;
  planVersionId: string;
  gateKey: string;
  multiple: boolean;
  images: VisualInputGateImageV1[];
}

interface VisualInputArtifactPort {
  writeBinary(input: BinaryArtifactWriteInput): Promise<ControlArtifact>;
  writeJson(input: ArtifactWriteInput): Promise<ControlArtifact>;
  readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }>;
  readVerifiedBinary(artifactId: string): Promise<{
    artifact: ControlArtifact;
    bytes: Buffer;
    metadata: TrustedBinaryMetadata;
  }>;
  invalidateArtifactPublication(artifactId: string, reason: string): Promise<void>;
}

export interface ResolvedVisualInputImage {
  artifact: ControlArtifact;
  bytes: Buffer;
  metadata: TrustedBinaryMetadata;
  dataUrl: string;
}

export interface ResolvedVisualInput {
  gateKey: string;
  multiple: boolean;
  images: ResolvedVisualInputImage[];
}

export interface ResolvedInputGates {
  gates: ControlGateRecord[];
  visuals: ResolvedVisualInput[];
}

export type PreparedVisualInputGate = {
  taskId: string;
  planVersionId: string;
  gateKey: string;
  multiple: boolean;
} & (
  | { requiredVisual: false; value: unknown }
  | { requiredVisual: true; images: VisualInputImage[] }
);

export interface PublishedVisualInputGate {
  value?: unknown;
  evidenceRef?: string;
  artifactIds: string[];
}

export class VisualInputGateError extends Error {
  constructor(message: string) {
    super(`visual input gate is invalid: ${message}`);
    this.name = 'VisualInputGateError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSingleImageValue(value: unknown): value is { dataUrl: string } {
  return isRecord(value) && hasExactKeys(value, ['dataUrl']) && typeof value.dataUrl === 'string';
}

const INLINE_IMAGE_DATA_URL = /data:image\/[a-z0-9.+-]+;base64,/iu;

function containsInlineImageData(value: unknown): boolean {
  if (typeof value === 'string') return INLINE_IMAGE_DATA_URL.test(value);
  if (Array.isArray(value)) return value.some(containsInlineImageData);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    key.toLowerCase() === 'dataurl' || containsInlineImageData(child)
  ));
}

function manifestValue(value: unknown): VisualInputGateManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'taskId', 'planVersionId', 'gateKey', 'multiple', 'images',
  ])) {
    throw new VisualInputGateError('manifest shape is malformed');
  }
  if (
    value.version !== GATE_SCHEMA_VERSION
    || typeof value.taskId !== 'string'
    || typeof value.planVersionId !== 'string'
    || typeof value.gateKey !== 'string'
    || typeof value.multiple !== 'boolean'
    || !Array.isArray(value.images)
    || value.images.length === 0
  ) {
    throw new VisualInputGateError('manifest fields are malformed');
  }
  const images = value.images.map((candidate): VisualInputGateImageV1 => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      'artifactId', 'contentSha256', 'mediaType', 'byteSize',
    ])) {
      throw new VisualInputGateError('manifest image shape is malformed');
    }
    if (
      typeof candidate.artifactId !== 'string'
      || typeof candidate.contentSha256 !== 'string'
      || (
        candidate.mediaType !== 'image/jpeg'
        && candidate.mediaType !== 'image/png'
        && candidate.mediaType !== 'image/webp'
      )
      || typeof candidate.byteSize !== 'number'
      || !Number.isSafeInteger(candidate.byteSize)
      || candidate.byteSize <= 0
    ) {
      throw new VisualInputGateError('manifest image fields are malformed');
    }
    return {
      artifactId: candidate.artifactId,
      contentSha256: candidate.contentSha256,
      mediaType: candidate.mediaType,
      byteSize: candidate.byteSize,
    };
  });
  return {
    version: GATE_SCHEMA_VERSION,
    taskId: value.taskId,
    planVersionId: value.planVersionId,
    gateKey: value.gateKey,
    multiple: value.multiple,
    images,
  };
}

function assertPlanBoundArtifact(input: {
  artifact: ControlArtifact;
  taskId: string;
  planVersionId: string;
  kind: string;
  schemaVersion: string;
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
  ) {
    throw new VisualInputGateError(`${input.kind} Artifact binding is invalid`);
  }
}

function targetValue(value: unknown, sourceMultiple: boolean, targetMultiple: boolean): unknown {
  if (sourceMultiple === targetMultiple) return structuredClone(value);
  if (!sourceMultiple && targetMultiple) return [structuredClone(value)];
  if (!Array.isArray(value) || value.length === 0) {
    throw new VisualInputGateError('multiple input cannot populate a singular target');
  }
  return structuredClone(value[0]);
}

export function valueForPendingInputTarget(input: {
  value: unknown;
  pendingMultiple: boolean;
  targetMultiple: boolean;
}): unknown {
  return targetValue(input.value, input.pendingMultiple, input.targetMultiple);
}

export class VisualInputGateStore {
  constructor(private readonly artifacts: VisualInputArtifactPort) {}

  async prepare(input: {
    taskId: string;
    planVersionId: string;
    gateKey: string;
    multiple: boolean;
    requiredVisual: boolean;
    value: unknown;
  }): Promise<PreparedVisualInputGate> {
    if (!input.requiredVisual) {
      if (containsInlineImageData(input.value)) {
        throw new VisualInputGateError('non-visual input contains a dataUrl');
      }
      return { ...input, requiredVisual: false, value: input.value };
    }
    if (input.multiple && Array.isArray(input.value) && input.value.length === 0) {
      throw new VisualInputGateError('multiple input must not be empty');
    }
    const supplied = input.multiple
      ? Array.isArray(input.value) && input.value.length > 0 && input.value.every(isSingleImageValue)
      : isSingleImageValue(input.value);
    if (!supplied) {
      throw new VisualInputGateError(
        input.multiple
          ? 'multiple image input must be a non-empty array of {dataUrl}'
          : 'single image input must be exactly {dataUrl}',
      );
    }
    const images = await parseVisualInputDataUrls(input.value);
    if ((!input.multiple && images.length !== 1) || images.length === 0) {
      throw new VisualInputGateError('visual input did not resolve to the required image count');
    }
    return {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      gateKey: input.gateKey,
      multiple: input.multiple,
      requiredVisual: true,
      images,
    };
  }

  async publishPrepared(
    input: PreparedVisualInputGate,
    publicationId?: string,
  ): Promise<PublishedVisualInputGate> {
    if (!input.requiredVisual) return { value: input.value, artifactIds: [] };

    const references: VisualInputGateImageV1[] = [];
    const artifactIds: string[] = [];
    try {
      for (const image of input.images) {
        const artifact = await this.artifacts.writeBinary({
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          ...(publicationId === undefined ? {} : { publicationId }),
          kind: IMAGE_KIND,
          relativePath: `inputs/${randomUUID()}.${image.extension}`,
          bytes: image.bytes,
          schemaVersion: IMAGE_SCHEMA_VERSION,
          sensitivity: 'internal',
          redactionPolicyVersion: 'v1',
        });
        artifactIds.push(artifact.id);
        assertPlanBoundArtifact({
          artifact,
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          kind: IMAGE_KIND,
          schemaVersion: IMAGE_SCHEMA_VERSION,
        });
        if (
          artifact.mediaType !== image.contentType
          || artifact.byteSize !== image.bytes.byteLength
        ) {
          throw new VisualInputGateError('sealed image metadata does not match its input');
        }
        references.push({
          artifactId: artifact.id,
          contentSha256: artifact.contentSha256!,
          mediaType: image.contentType,
          byteSize: image.bytes.byteLength,
        });
      }

      const manifest: VisualInputGateManifestV1 = {
        version: GATE_SCHEMA_VERSION,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        gateKey: input.gateKey,
        multiple: input.multiple,
        images: references,
      };
      const artifact = await this.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        ...(publicationId === undefined ? {} : { publicationId }),
        kind: GATE_KIND,
        relativePath: `inputs/${randomUUID()}-gate.json`,
        value: manifest,
        schemaVersion: GATE_SCHEMA_VERSION,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
      });
      artifactIds.push(artifact.id);
      assertPlanBoundArtifact({
        artifact,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: GATE_KIND,
        schemaVersion: GATE_SCHEMA_VERSION,
      });
      return { evidenceRef: artifact.id, artifactIds };
    } catch (error) {
      await Promise.allSettled(artifactIds.map((artifactId) => (
        this.artifacts.invalidateArtifactPublication(artifactId, 'visual input publication did not complete')
      )));
      throw error;
    }
  }

  async publish(input: {
    taskId: string;
    planVersionId: string;
    gateKey: string;
    multiple: boolean;
    requiredVisual: boolean;
    value: unknown;
  }): Promise<PublishedVisualInputGate> {
    return this.publishPrepared(await this.prepare(input));
  }

  async invalidate(publication: PublishedVisualInputGate, reason: string): Promise<void> {
    await Promise.all(publication.artifactIds.map((artifactId) => (
      this.artifacts.invalidateArtifactPublication(artifactId, reason)
    )));
  }

  async resolve(input: {
    taskId: string;
    planVersionId: string;
    gates: ControlGateRecord[];
    pendingInputs: readonly PendingInput[];
  }): Promise<ResolvedInputGates> {
    const pendingByRole = new Map(input.pendingInputs.map((pending) => [pending.role, pending]));
    const artifactIds = new Set<string>();
    const gates: ControlGateRecord[] = [];
    const visuals: ResolvedVisualInput[] = [];

    for (const gate of input.gates) {
      if (gate.gateType !== 'input') {
        gates.push(gate);
        continue;
      }
      const pending = pendingByRole.get(gate.gateKey);
      if (!pending) throw new VisualInputGateError(`gate ${gate.gateKey} has no pending input`);
      if (pending.kind === 'dataset') {
        gates.push(gate);
        continue;
      }
      if (gate.evidenceRef && gate.value !== null) {
        throw new VisualInputGateError(`gate ${gate.gateKey} has both a value and evidence reference`);
      }
      if (!gate.evidenceRef && containsInlineImageData(gate.value)) {
        throw new VisualInputGateError(`gate ${gate.gateKey} contains an unsealed dataUrl`);
      }
      if (pending.kind === 'visual' && !gate.evidenceRef) {
        throw new VisualInputGateError(`visual gate ${gate.gateKey} has no sealed evidence reference`);
      }
      if (pending.kind !== 'visual' && gate.evidenceRef) {
        throw new VisualInputGateError(`non-visual gate ${gate.gateKey} has an evidence reference`);
      }
      if (!gate.evidenceRef) {
        gates.push(gate);
        continue;
      }
      const stored = await this.artifacts.readVerifiedBoundJson<unknown>(gate.evidenceRef);
      assertPlanBoundArtifact({
        artifact: stored.artifact,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: GATE_KIND,
        schemaVersion: GATE_SCHEMA_VERSION,
      });
      const manifest = manifestValue(stored.value);
      if (
        manifest.taskId !== input.taskId
        || manifest.planVersionId !== input.planVersionId
        || manifest.gateKey !== gate.gateKey
        || manifest.multiple !== pending.multiple
        || (!manifest.multiple && manifest.images.length !== 1)
      ) {
        throw new VisualInputGateError(`gate ${gate.gateKey} manifest does not match the active plan`);
      }
      const resolvedImages: ResolvedVisualInputImage[] = [];
      for (const reference of manifest.images) {
        if (artifactIds.has(reference.artifactId)) {
          throw new VisualInputGateError(`image Artifact ${reference.artifactId} is duplicated`);
        }
        artifactIds.add(reference.artifactId);
        const verified = await this.artifacts.readVerifiedBinary(reference.artifactId);
        assertPlanBoundArtifact({
          artifact: verified.artifact,
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          kind: IMAGE_KIND,
          schemaVersion: IMAGE_SCHEMA_VERSION,
        });
        if (
          verified.artifact.contentSha256 !== reference.contentSha256
          || verified.artifact.mediaType !== reference.mediaType
          || verified.artifact.byteSize !== reference.byteSize
          || verified.metadata.contentType !== reference.mediaType
          || verified.metadata.byteSize !== reference.byteSize
        ) {
          throw new VisualInputGateError(`image Artifact ${reference.artifactId} does not match its manifest`);
        }
        resolvedImages.push({
          ...verified,
          dataUrl: `data:${verified.metadata.contentType};base64,${verified.bytes.toString('base64')}`,
        });
      }
      const value = manifest.multiple
        ? resolvedImages.map(({ dataUrl }) => ({ dataUrl }))
        : { dataUrl: resolvedImages[0]!.dataUrl };
      gates.push({ ...gate, value });
      visuals.push({ gateKey: gate.gateKey, multiple: manifest.multiple, images: resolvedImages });
    }
    return { gates, visuals };
  }
}
