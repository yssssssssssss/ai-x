import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import type { ImageAnnotationService } from './image-annotation-service.ts';
import type { VisualAssetService } from './visual-asset-service.ts';

interface InputGate {
  gateType: string;
  gateKey: string;
  value: unknown;
}

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/u;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function dataUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(dataUrls);
  const candidate = record(value)?.dataUrl;
  return typeof candidate === 'string' ? [candidate] : [];
}

function decodeImage(dataUrl: string): { bytes: Buffer; extension: string } | null {
  const match = IMAGE_DATA_URL.exec(dataUrl);
  if (!match) return null;
  const mediaType = match[1];
  const encoded = match[2];
  const extension = EXTENSIONS[mediaType];
  if (!extension) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) throw new Error('visual input has empty image bytes');
  return { bytes, extension };
}

export class VisualInputMaterializer {
  constructor(private readonly dependencies: {
    visualAssets: Pick<VisualAssetService, 'ingest'>;
    imageAnnotations: Pick<ImageAnnotationService, 'annotate'>;
  }) {}

  async materialize(input: {
    lease: ControlExecutionLease;
    gates: InputGate[];
  }): Promise<void> {
    let imageIndex = 0;
    for (const gate of input.gates) {
      if (gate.gateType !== 'input') continue;
      for (const dataUrl of dataUrls(gate.value)) {
        const image = decodeImage(dataUrl);
        if (!image) continue;
        imageIndex += 1;
        const findingId = `visual-input-${imageIndex}`;
        const original = await this.dependencies.visualAssets.ingest({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          source: {
            kind: 'user_upload',
            fileName: `${gate.gateKey}-${imageIndex}.${image.extension}`,
            bytes: image.bytes,
          },
          exportPolicy: 'allow',
        });
        await this.dependencies.imageAnnotations.annotate({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          original: {
            assetId: original.assetArtifact.id,
            manifestArtifactId: original.manifestArtifact.id,
          },
          findingIds: [findingId],
          annotations: [{
            shape: 'rectangle',
            x: 0.04,
            y: 0.14,
            width: 0.92,
            height: 0.76,
            findingId,
            label: `${gate.gateKey} 真实界面重点区域`,
            severity: 'medium',
          }],
          exportPolicy: 'allow',
        });
      }
    }
  }
}
