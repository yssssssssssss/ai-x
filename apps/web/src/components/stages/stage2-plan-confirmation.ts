import type { PendingUpload, Upload } from '../../api/client.ts';
import { pendingImageUploads } from '../../pending-upload-values.ts';

export interface PlanConfirmationPayload {
  confirmationAnswers: Record<string, unknown>;
  inputValues: Record<string, unknown>;
  uploads: Upload[];
}

export function buildPlanConfirmationPayload(input: {
  confirmationAnswers: Readonly<Record<string, string>>;
  pending: readonly PendingUpload[];
  values: Readonly<Record<string, string>>;
  images: Readonly<Record<string, readonly string[]>>;
}): PlanConfirmationPayload {
  const inputValues: Record<string, unknown> = {};
  for (const pendingInput of input.pending) {
    if (pendingInput.kind !== 'value') continue;
    const raw = input.values[pendingInput.role] ?? '';
    inputValues[pendingInput.role] = pendingInput.multiple
      ? raw.split('\n').map((item) => item.trim()).filter(Boolean)
      : raw.trim();
  }
  return {
    confirmationAnswers: { ...input.confirmationAnswers },
    inputValues,
    uploads: pendingImageUploads(
      input.pending.filter((pendingInput) => pendingInput.kind === 'visual'),
      input.images,
    ),
  };
}
