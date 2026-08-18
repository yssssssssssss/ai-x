import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ControlArtifact, ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  VisualAssetExportPolicy,
  VisualAssetManifest,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import type { VisualAssetResult, VisualAssetService } from './visual-asset-service.ts';

export type AnnotationSeverity = 'low' | 'medium' | 'high' | 'critical';

interface AnnotationCommon {
  findingId: string;
  label: string;
  severity: AnnotationSeverity;
}

export interface RectangleAnnotation extends AnnotationCommon {
  shape: 'rectangle';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DotAnnotation extends AnnotationCommon {
  shape: 'dot';
  x: number;
  y: number;
}

export interface ArrowAnnotation extends AnnotationCommon {
  shape: 'arrow';
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface NumberedCalloutAnnotation extends AnnotationCommon {
  shape: 'numbered_callout';
  x: number;
  y: number;
  number: number;
}

export type ImageAnnotation =
  | RectangleAnnotation
  | DotAnnotation
  | ArrowAnnotation
  | NumberedCalloutAnnotation;

export interface ImageAnnotationOverlay {
  version: 'image-annotation-v1';
  original: VisualAssetReference;
  annotations: ImageAnnotation[];
}

export interface ImageAnnotationInput {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  activeLease?: ControlExecutionLease;
  original: VisualAssetReference;
  findingIds: string[];
  annotations: unknown;
  exportPolicy: VisualAssetExportPolicy;
}

export interface ImageAnnotationResult {
  overlayArtifact: ControlArtifact;
  derived: VisualAssetResult;
}

interface VerifiedOriginal {
  artifact: ControlArtifact;
  bytes: Buffer;
  manifest: VisualAssetManifest;
}

type VisualAssetPort = Pick<VisualAssetService, 'readVerified' | 'derive'>;
type JsonArtifactPort = Pick<ControlArtifactStore, 'writeJson' | 'invalidateArtifactPublication'>;
type RenderSvg = (input: {
  originalBytes: Buffer;
  overlay: ImageAnnotationOverlay;
}) => Promise<Uint8Array>;

const SEVERITIES: Record<AnnotationSeverity, true> = {
  low: true,
  medium: true,
  high: true,
  critical: true,
};

const COLOR_BY_SEVERITY: Record<AnnotationSeverity, string> = {
  low: '#2563eb',
  medium: '#d97706',
  high: '#dc2626',
  critical: '#7f1d1d',
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderPrimitive(annotation: ImageAnnotation, width: number, height: number): string {
  const color = COLOR_BY_SEVERITY[annotation.severity];
  const title = `<title>${escapeXml(annotation.label)}</title>`;
  const minimumDimension = Math.min(width, height);
  const strokeWidth = Math.max(1, minimumDimension * 0.006);
  if (annotation.shape === 'rectangle') {
    return `<g>${title}<rect x="${annotation.x * width}" y="${annotation.y * height}" width="${annotation.width * width}" height="${annotation.height * height}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="${strokeWidth}"/></g>`;
  }
  if (annotation.shape === 'dot') {
    const radius = Math.max(2, minimumDimension * 0.012);
    return `<g>${title}<circle cx="${annotation.x * width}" cy="${annotation.y * height}" r="${radius}" fill="${color}" stroke="#ffffff" stroke-width="${Math.max(1, strokeWidth / 2)}"/></g>`;
  }
  if (annotation.shape === 'arrow') {
    const startX = annotation.start.x * width;
    const startY = annotation.start.y * height;
    const endX = annotation.end.x * width;
    const endY = annotation.end.y * height;
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      return `<g>${title}<circle cx="${endX}" cy="${endY}" r="${Math.max(2, strokeWidth)}" fill="${color}"/></g>`;
    }
    const arrowSize = Math.max(5, minimumDimension * 0.025);
    const unitX = dx / length;
    const unitY = dy / length;
    const baseX = endX - unitX * arrowSize;
    const baseY = endY - unitY * arrowSize;
    const sideX = -unitY * arrowSize * 0.55;
    const sideY = unitX * arrowSize * 0.55;
    return `<g>${title}<line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/><polygon points="${endX},${endY} ${baseX + sideX},${baseY + sideY} ${baseX - sideX},${baseY - sideY}" fill="${color}"/></g>`;
  }
  const radius = Math.max(7, minimumDimension * 0.025);
  const fontSize = Math.max(9, radius * 1.15);
  return `<g>${title}<circle cx="${annotation.x * width}" cy="${annotation.y * height}" r="${radius}" fill="${color}" stroke="#ffffff" stroke-width="${Math.max(1, strokeWidth / 2)}"/><text x="${annotation.x * width}" y="${annotation.y * height}" fill="#ffffff" font-family="sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="central">${annotation.number}</text></g>`;
}

const renderControlledAnnotation: RenderSvg = async ({ originalBytes, overlay }) => {
  const image = sharp(originalBytes, {
    failOn: 'warning',
    limitInputPixels: 20_000_000,
  });
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error('original image has no decodable dimensions');
  const primitives = overlay.annotations
    .map((annotation) => renderPrimitive(annotation, width, height))
    .join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${primitives}</svg>`);
  return image.composite([{ input: svg, blend: 'over' }]).png().toBuffer();
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertCoordinate(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} coordinate must be normalized within 0 and 1 bounds`);
  }
}

function assertCommon(
  annotation: Record<string, unknown>,
  findingIds: ReadonlySet<string>,
): asserts annotation is Record<string, unknown> & AnnotationCommon {
  if (typeof annotation.findingId !== 'string' || !findingIds.has(annotation.findingId)) {
    throw new Error('annotation findingId must reference a known Finding');
  }
  if (typeof annotation.label !== 'string' || !annotation.label.trim()) {
    throw new Error('annotation label is required');
  }
  if (
    typeof annotation.severity !== 'string'
    || SEVERITIES[annotation.severity as AnnotationSeverity] !== true
  ) {
    throw new Error('annotation severity must be low, medium, high, or critical');
  }
}

function assertExactKeys(annotation: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(annotation).sort();
  const allowed = [...expected, 'findingId', 'label', 'severity'].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error('annotation shape contains unsupported fields');
  }
}

function validateAnnotation(value: unknown, findingIds: ReadonlySet<string>): ImageAnnotation {
  const annotation = record(value);
  if (!annotation || typeof annotation.shape !== 'string') {
    throw new Error('annotation shape must be rectangle, dot, arrow, or numbered callout');
  }
  assertCommon(annotation, findingIds);
  if (annotation.shape === 'rectangle') {
    assertExactKeys(annotation, ['shape', 'x', 'y', 'width', 'height']);
    assertCoordinate(annotation.x, 'rectangle x');
    assertCoordinate(annotation.y, 'rectangle y');
    if (typeof annotation.width !== 'number' || !Number.isFinite(annotation.width) || annotation.width <= 0) {
      throw new Error('rectangle width coordinate must be normalized within 0 and 1 bounds');
    }
    if (typeof annotation.height !== 'number' || !Number.isFinite(annotation.height) || annotation.height <= 0) {
      throw new Error('rectangle height coordinate must be normalized within 0 and 1 bounds');
    }
    if (annotation.x + annotation.width > 1 || annotation.y + annotation.height > 1) {
      throw new Error('rectangle coordinates leave normalized image bounds 0 to 1');
    }
    return structuredClone(annotation) as unknown as RectangleAnnotation;
  }
  if (annotation.shape === 'dot') {
    assertExactKeys(annotation, ['shape', 'x', 'y']);
    assertCoordinate(annotation.x, 'dot x');
    assertCoordinate(annotation.y, 'dot y');
    return structuredClone(annotation) as unknown as DotAnnotation;
  }
  if (annotation.shape === 'arrow') {
    assertExactKeys(annotation, ['shape', 'start', 'end']);
    const start = record(annotation.start);
    const end = record(annotation.end);
    if (!start || Object.keys(start).sort().join(',') !== 'x,y') {
      throw new Error('arrow start coordinate must contain normalized x and y');
    }
    if (!end || Object.keys(end).sort().join(',') !== 'x,y') {
      throw new Error('arrow end coordinate must contain normalized x and y');
    }
    assertCoordinate(start.x, 'arrow start x');
    assertCoordinate(start.y, 'arrow start y');
    assertCoordinate(end.x, 'arrow end x');
    assertCoordinate(end.y, 'arrow end y');
    return structuredClone(annotation) as unknown as ArrowAnnotation;
  }
  if (annotation.shape === 'numbered_callout') {
    assertExactKeys(annotation, ['shape', 'x', 'y', 'number']);
    assertCoordinate(annotation.x, 'numbered callout x');
    assertCoordinate(annotation.y, 'numbered callout y');
    if (typeof annotation.number !== 'number' || !Number.isInteger(annotation.number) || annotation.number < 1) {
      throw new Error('numbered callout number must be a positive integer');
    }
    return structuredClone(annotation) as unknown as NumberedCalloutAnnotation;
  }
  throw new Error('annotation shape must be rectangle, dot, arrow, or numbered callout');
}

function validateOriginal(original: VerifiedOriginal, input: ImageAnnotationInput): void {
  const { artifact, manifest } = original;
  if (
    artifact.id !== input.original.assetId
    || artifact.taskId !== input.taskId
    || artifact.planVersionId !== input.planVersionId
    || artifact.attemptId !== input.attemptId
    || manifest.assetId !== input.original.assetId
    || manifest.taskId !== input.taskId
    || manifest.planVersionId !== input.planVersionId
    || manifest.attemptId !== input.attemptId
  ) {
    throw new Error('original visual Asset reference, manifest, or binding does not match');
  }
  if (!artifact.contentSha256 || manifest.contentSha256 !== artifact.contentSha256) {
    throw new Error('original visual Asset content hash does not match its manifest');
  }
  if (manifest.derivedFrom !== null || manifest.derivation !== null) {
    throw new Error('original visual Asset must not already be derived');
  }
}

export class ImageAnnotationService {
  private readonly renderSvg: RenderSvg;

  constructor(private readonly dependencies: {
    assets: VisualAssetPort;
    artifacts: JsonArtifactPort;
    renderSvg?: RenderSvg;
  }) {
    this.renderSvg = dependencies.renderSvg ?? renderControlledAnnotation;
  }

  async annotate(input: ImageAnnotationInput): Promise<ImageAnnotationResult> {
    if (!Array.isArray(input.annotations) || input.annotations.length === 0) {
      throw new Error('annotations must contain at least one supported shape');
    }
    const findingIds = new Set(input.findingIds);
    if (findingIds.size !== input.findingIds.length || findingIds.has('')) {
      throw new Error('Finding ids must be unique and non-empty');
    }
    const annotations = input.annotations.map((annotation) => validateAnnotation(annotation, findingIds));
    let original: Awaited<ReturnType<VisualAssetPort['readVerified']>>;
    try {
      original = await this.dependencies.assets.readVerified(input.original);
    } catch (error) {
      throw new Error(`original Asset does not resolve: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateOriginal(original, input);
    const overlay: ImageAnnotationOverlay = {
      version: 'image-annotation-v1',
      original: structuredClone(input.original),
      annotations,
    };
    let overlayArtifact: ControlArtifact | undefined;
    try {
      overlayArtifact = await this.dependencies.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'image_annotation',
        relativePath: `visual-assets/${randomUUID()}.annotation.json`,
        value: overlay,
        schemaVersion: 'image-annotation-v1',
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        ...(input.activeLease ? { activeLease: input.activeLease } : {}),
      });
      if (
        overlayArtifact.taskId !== input.taskId
        || overlayArtifact.planVersionId !== input.planVersionId
        || overlayArtifact.attemptId !== input.attemptId
        || overlayArtifact.kind !== 'image_annotation'
        || overlayArtifact.state !== 'SEALED'
      ) {
        throw new Error('sealed image annotation Artifact binding does not match');
      }
      const renderedBytes = await this.renderSvg({
        originalBytes: Buffer.from(original.bytes),
        overlay: structuredClone(overlay),
      });
      const derived = await this.dependencies.assets.derive({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        original: structuredClone(input.original),
        derivation: { kind: 'annotation', overlayArtifactId: overlayArtifact.id },
        bytes: Buffer.from(renderedBytes),
        exportPolicy: input.exportPolicy,
        ...(input.activeLease ? { activeLease: input.activeLease } : {}),
      });
      return { overlayArtifact, derived };
    } catch (error) {
      if (overlayArtifact) {
        await Promise.allSettled([
          this.dependencies.artifacts.invalidateArtifactPublication(
            overlayArtifact.id,
            'image annotation publication did not complete',
          ),
        ]);
      }
      throw error;
    }
  }
}
