import { useEffect, useState } from 'react';

export type ReportAssetLoader = (assetId: string) => Promise<Blob>;

interface VerifiedAssetImageProps {
  assetId: string;
  src?: string;
  alt: string;
  className?: string;
  zoom?: number;
  loadAsset?: ReportAssetLoader;
}

export function VerifiedAssetImage({
  assetId,
  src,
  alt,
  className,
  zoom = 1,
  loadAsset,
}: VerifiedAssetImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState(loadAsset ? '' : (src ?? ''));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!loadAsset) {
      setResolvedSrc(src ?? '');
      return undefined;
    }
    let active = true;
    let objectUrl = '';
    setResolvedSrc('');
    void loadAsset(assetId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setResolvedSrc(objectUrl);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, loadAsset, src]);

  if (failed || !resolvedSrc) {
    return <div className="report-image-unavailable" role="img" aria-label={alt}>图像暂不可用</div>;
  }
  return (
    <img
      className={className}
      src={resolvedSrc}
      alt={alt}
      onError={() => setFailed(true)}
      style={{ transform: `scale(${zoom})` }}
    />
  );
}

export interface ImageBlockProps {
  id: string;
  assetId: string;
  src?: string;
  altText: string;
  caption: string;
  zoom: number;
  onZoom(zoom: number): void;
  loadAsset?: ReportAssetLoader;
}

export function ImageBlock({
  id,
  assetId,
  src,
  altText,
  caption,
  zoom,
  onZoom,
  loadAsset,
}: ImageBlockProps) {
  return (
    <figure className="report-figure" data-block-id={id}>
      <div className="report-image-toolbar" aria-label="图像缩放">
        <button type="button" onClick={() => onZoom(Math.max(1, zoom - 0.25))} disabled={zoom <= 1} aria-label="缩小图像">−</button>
        <output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" onClick={() => onZoom(Math.min(3, zoom + 0.25))} disabled={zoom >= 3} aria-label="放大图像">＋</button>
      </div>
      <div className="report-image-viewport">
        <VerifiedAssetImage assetId={assetId} src={src} alt={altText} zoom={zoom} loadAsset={loadAsset} />
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
