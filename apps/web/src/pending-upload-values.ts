import type { PendingUpload } from '../../../packages/api-contract/plan.ts';
import type { Upload } from '../../../packages/api-contract/http.ts';

export function pendingImageUploads(
  pending: readonly PendingUpload[],
  imagesByRole: Readonly<Record<string, readonly string[]>>,
): Upload[] {
  return pending.flatMap((input) => {
    const images = imagesByRole[input.role] ?? [];
    const selected = input.multiple ? images : images.slice(0, 1);
    return selected
      .filter((dataUrl) => dataUrl.length > 0)
      .map((dataUrl) => ({ role: input.role, dataUrl }));
  });
}
