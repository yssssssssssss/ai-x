import { VerifiedAssetImage, type ReportAssetLoader } from './ImageBlock.tsx';

export interface ImageComparisonBlockProps {
  id: string;
  originalAssetId: string;
  annotationAssetId: string;
  originalSrc?: string;
  annotationSrc?: string;
  altText: string;
  caption: string;
  variant: 'original' | 'annotation';
  zoom: number;
  onVariantChange(variant: 'original' | 'annotation'): void;
  onZoom(zoom: number): void;
  loadAsset?: ReportAssetLoader;
}

export function ImageComparisonBlock({
  id,
  originalAssetId,
  annotationAssetId,
  originalSrc,
  annotationSrc,
  altText,
  caption,
  variant,
  zoom,
  onVariantChange,
  onZoom,
  loadAsset,
}: ImageComparisonBlockProps) {
  const assetId = variant === 'original' ? originalAssetId : annotationAssetId;
  const src = variant === 'original' ? originalSrc : annotationSrc;
  return (
    <figure className="report-figure report-comparison" data-block-id={id}>
      <div className="report-comparison-toolbar">
        <div className="report-segmented" aria-label="选择图像版本">
          <button type="button" aria-pressed={variant === 'original'} onClick={() => onVariantChange('original')}>原图</button>
          <button type="button" aria-pressed={variant === 'annotation'} onClick={() => onVariantChange('annotation')}>标注</button>
        </div>
        <div className="report-image-toolbar" aria-label="图像缩放">
          <button type="button" onClick={() => onZoom(Math.max(1, zoom - 0.25))} disabled={zoom <= 1} aria-label="缩小图像">−</button>
          <output aria-live="polite">{Math.round(zoom * 100)}%</output>
          <button type="button" onClick={() => onZoom(Math.min(3, zoom + 0.25))} disabled={zoom >= 3} aria-label="放大图像">＋</button>
        </div>
      </div>
      <div className="report-image-viewport">
        <VerifiedAssetImage
          assetId={assetId}
          src={src}
          alt={`${altText}（${variant === 'original' ? '原图' : '标注图'}）`}
          zoom={zoom}
          loadAsset={loadAsset}
        />
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
