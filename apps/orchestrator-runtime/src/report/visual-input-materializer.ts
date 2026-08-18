import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import type { ResolvedVisualInput } from '../control/visual-input-gate-store.ts';
import type { ImageAnnotationService } from './image-annotation-service.ts';
import type { VisualAssetService } from './visual-asset-service.ts';

export class VisualInputMaterializer {
  constructor(private readonly dependencies: {
    visualAssets: Pick<VisualAssetService, 'ingest'>;
    imageAnnotations: Pick<ImageAnnotationService, 'annotate'>;
  }) {}

  async materialize(input: {
    lease: ControlExecutionLease;
    visuals: ResolvedVisualInput[];
    annotationPurpose?: 'input_provenance' | 'design_audit';
  }): Promise<void> {
    if (input.annotationPurpose === 'design_audit') {
      throw new Error(
        'design audit annotations require verified finding-bound analysis; pre-analysis annotation synthesis is forbidden',
      );
    }
    let imageIndex = 0;
    for (const visual of input.visuals) {
      for (const image of visual.images) {
        imageIndex += 1;
        const extension = image.metadata.contentType === 'image/jpeg'
          ? 'jpg'
          : image.metadata.contentType === 'image/png' ? 'png' : 'webp';
        const original = await this.dependencies.visualAssets.ingest({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          activeLease: input.lease,
          source: {
            kind: 'user_upload',
            fileName: `${visual.gateKey}-${imageIndex}.${extension}`,
            bytes: image.bytes,
          },
          exportPolicy: 'allow',
        });
        if (!input.annotationPurpose) continue;
        const findingId = `input-provenance-${imageIndex}`;
        await this.dependencies.imageAnnotations.annotate({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          activeLease: input.lease,
          original: {
            assetId: original.assetArtifact.id,
            manifestArtifactId: original.manifestArtifact.id,
          },
          findingIds: [findingId],
          annotations: [{
            shape: 'rectangle',
            x: 0.01,
            y: 0.01,
            width: 0.98,
            height: 0.98,
            findingId,
            label: `${visual.gateKey} 用户输入图像边界（仅用于来源溯源，不代表研究发现）`,
            severity: 'low',
          }],
          exportPolicy: 'allow',
        });
      }
    }
  }
}
