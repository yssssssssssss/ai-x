import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import type { ImageAnnotationService } from './image-annotation-service.ts';
import type { VisualAssetService } from './visual-asset-service.ts';
import { parseVisualInputDataUrls } from './visual-input-data-url.ts';

interface InputGate {
  gateType: string;
  gateKey: string;
  value: unknown;
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
    const visualInputs: Array<{
      gateKey: string;
      image: Awaited<ReturnType<typeof parseVisualInputDataUrls>>[number];
    }> = [];
    for (const gate of input.gates) {
      if (gate.gateType !== 'input') continue;
      const images = await parseVisualInputDataUrls(gate.value);
      visualInputs.push(...images.map((image) => ({ gateKey: gate.gateKey, image })));
    }
    let imageIndex = 0;
    for (const { gateKey, image } of visualInputs) {
      imageIndex += 1;
      const findingId = `visual-input-${imageIndex}`;
      const original = await this.dependencies.visualAssets.ingest({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        attemptId: input.lease.attemptId,
        source: {
          kind: 'user_upload',
          fileName: `${gateKey}-${imageIndex}.${image.extension}`,
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
          label: `${gateKey} 真实界面重点区域`,
          severity: 'medium',
        }],
        exportPolicy: 'allow',
      });
    }
  }
}
